/* ============================================================
   ADR-0009 M3 (T-028b): delta-encode a projectFor(state, seat) snapshot against the previous one
   sent to the same connection, instead of re-sending everything every tick. T-015 measured that a
   full snapshot every tick misses NFR-3's 32 KB/s budget by ~50x at every measured army size, with
   the snapshot RATE (20 Hz), not army size, as the actual cause — most of any given tick's units
   and buildings are IDENTICAL to the tick before (an idle economy, a unit mid-straight-line-move
   whose position already changed last tick too), so re-sending their full data every 50ms is pure
   waste. This file is purely the encode/decode pair; net/wsServerTransport.js decides WHEN to use
   it (a fresh connection's first push, or one after its own baseline was cleared, still gets a full
   projectFor payload — see that file's own header for why "acknowledged" needs no separate ack
   protocol over this project's WebSocket transport).

   Operates ONLY on plain JSON-shaped projectFor output — no engine State, no live entity objects,
   no networking — so it needs no map, no fog, nothing beyond the two snapshots being compared.

   quantizeForWire (T-028c) rounds units/buildings/nodes to 2 decimal places before anything else
   in this file ever sees them. Measured, not assumed: a real match's x/y accumulates full
   floating-point noise from repeated velocity*dt integration (`831.2830042896674`, where nothing
   past the decimal point is visually or gameplay meaningful for a pixel-rendered 2D game), and hp
   drifts the same way under repeated subtraction. In one real stress-scenario delta, 41.7% of the
   payload's own bytes were spent on that noise alone. 2 decimal places, not a whole integer:
   coarse enough to erase the noise, fine enough that a genuinely fractional field — buildProgress,
   a 0..1 ratio — still reads as a smooth progression rather than jumping straight from 0 to 1.
   Applying this BEFORE computeDelta matters twice over: it shrinks each changed field's own bytes,
   AND it can make sub-noise position jitter round away to "no change at all", so an entity that
   only moved by float dust doesn't cost a changed-entry at all. The caller (net/wsServerTransport.js)
   quantizes every projectFor(...) result before it's ever used for a full send OR stored as a
   future delta's baseline — quantizing only one side of a comparison would make every tick look
   "changed" against its own now-differently-rounded predecessor, defeating the whole point.

   PER-FIELD patches for `changed`, not whole-object resend — measured, not assumed
   (tools/bench.js's own benchProjection.deltaBytes): a first cut that resent a changed entity's
   FULL data on any change barely beat a full snapshot during active combat, where most units have
   SOMETHING changing (x/y moving, hp dropping) nearly every tick, even though MOST of a unit's
   other fields (type, owner, maxHp, cargo, …) never do. A `changed` entry is `{id, ...onlyTheFields
   ThatDiffer}`; applyEntityDiff MERGES it onto the existing entity rather than replacing it, so
   fields the patch never mentions simply survive untouched — the same "only send what changed"
   principle applied one level deeper than entity-level added/removed/changed alone reaches.
   ============================================================ */

"use strict";

// units/buildings/nodes are the only fields worth diffing: they're the only ones whose SIZE scales
// with army/map size (players is ~2 small records; events is already "this tick's new events only",
// inherently minimal; tick/time/over/winner/winReason/owners are a handful of scalars). Each is a
// small array of objects keyed by a unique `id` — diffed the same way, generically.
const ENTITY_FIELDS = ["units", "buildings", "nodes"];

const QUANTIZE_DP = 2;
const QUANTIZE_FACTOR = 10 ** QUANTIZE_DP;

// Recursively rounds every number found (any depth, through arrays and plain objects alike) — a
// unit's order/cargo/orderQueue, a building's rally point, all covered generically rather than by
// naming each field, so a future field carrying its own float noise is covered automatically
// rather than silently missed. Rounding an already-clean integer (id counters, hp on a unit that
// hasn't taken fractional damage, …) is a no-op: Math.round(5 * 100) / 100 is exactly 5 again.
function roundNumbers(value) {
  if (typeof value === "number") return Math.round(value * QUANTIZE_FACTOR) / QUANTIZE_FACTOR;
  if (Array.isArray(value)) return value.map(roundNumbers);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = roundNumbers(v);
    return out;
  }
  return value;   // strings, booleans, null, undefined — untouched
}

/**
 * @param {Object} proj - a projectFor(...) output
 * @returns {Object} the same shape, with every number under units/buildings/nodes rounded to
 *   QUANTIZE_DP decimal places. players/events/tick/etc. are left exactly as they were — tiny
 *   regardless, and always sent in full, so there is nothing to gain by rounding them.
 */
export function quantizeForWire(proj) {
  const out = { ...proj };
  for (const field of ENTITY_FIELDS) out[field] = proj[field].map(roundNumbers);
  return out;
}

// A per-field patch for one changed entity: always {id}, plus whichever OTHER top-level keys
// differ from prev — nested objects (order, orderQueue, cargo, …) compared and resent as a whole
// when they differ at all, not diffed one level deeper again (order changes together as a unit in
// practice — a new move target replaces x AND y AND type together — so splitting it further would
// add complexity for little further saving). JSON.stringify equality is exact and cheap here: both
// sides are always produced by the same deterministic serialization (sanitizeUnitForExternal etc.),
// so two equal values always stringify identically — this is not a general-purpose deep-equal.
// Returns null when nothing actually differs (the entity is byte-identical, filtered out entirely).
function fieldPatch(prev, curr) {
  let patch = null;
  for (const key of Object.keys(curr)) {
    if (key === "id") continue;
    if (JSON.stringify(prev[key]) !== JSON.stringify(curr[key])) {
      if (!patch) patch = { id: curr.id };
      patch[key] = curr[key];
    }
  }
  return patch;
}

function diffEntities(prevArr, currArr) {
  const prevById = new Map(prevArr.map(e => [e.id, e]));
  const added = [], removed = [], changed = [];
  const seen = new Set();
  for (const e of currArr) {
    seen.add(e.id);
    const p = prevById.get(e.id);
    if (!p) { added.push(e); continue; }
    const patch = fieldPatch(p, e);
    if (patch) changed.push(patch);
  }
  for (const id of prevById.keys()) if (!seen.has(id)) removed.push(id);
  return { added, removed, changed };
}

function applyEntityDiff(prevArr, diff) {
  const byId = new Map(prevArr.map(e => [e.id, e]));
  for (const id of diff.removed) byId.delete(id);
  for (const patch of diff.changed) {
    const existing = byId.get(patch.id);
    byId.set(patch.id, existing ? { ...existing, ...patch } : patch);
  }
  for (const e of diff.added) byId.set(e.id, e);
  return [...byId.values()];
}

/**
 * @param {Object} prev - a previous projectFor(...) output for this seat
 * @param {Object} curr - the current one
 * @returns {Object} a delta: added/removed/changed for units/buildings/nodes, everything else
 *   (players, events, tick, time, over, winner, winReason, owners) carried in full
 */
export function computeDelta(prev, curr) {
  const delta = { ...curr };
  for (const field of ENTITY_FIELDS) delta[field] = diffEntities(prev[field], curr[field]);
  return delta;
}

/**
 * @param {Object} prev - the same snapshot computeDelta was given as `prev`
 * @param {Object} delta - computeDelta(prev, curr)'s own output
 * @returns {Object} curr, exactly — applyDelta(prev, computeDelta(prev, curr)) always reproduces curr
 */
export function applyDelta(prev, delta) {
  const curr = { ...delta };
  for (const field of ENTITY_FIELDS) curr[field] = applyEntityDiff(prev[field], delta[field]);
  return curr;
}
