/* ============================================================
   net/commandCodec.js — the ONLY bridge between a resolved WireCommand
   (net/commandEnvelope.js has already checked the envelope's SHAPE) and
   engine/commands.js. This file resolves ids to the live objects the engine
   wants, proves the submitting owner actually owns them, and delegates. It
   deliberately re-implements NO game rule: affordability, prereqs,
   placement, doctrine locks and role filters all stay in engine/, which the
   server calls exactly as the single-player client always has (ADR-0006 D1
   — wrap, don't rewrite; docs/analysis/02-command-wire-protocol.md §4).

   INVARIANT: no other module under net/ or server/ may import
   engine/commands.js. See test/netBoundary.test.js.

   Covers net/commandShapes.js's CURRENT union — unit orders plus the
   skirmish-core production/research commands already in that file's scope
   (its own header: "core skirmish mechanics, not Odyssey extras"). The
   remaining Odyssey-adjacent economy surface (market, diplomacy, colony,
   galaxy/lanes, colonyPolicy — dossier 02 §1.6/§3.6) is T-022's job, appended
   to this same SCHEMA table, not a new file.
   ============================================================ */

"use strict";

import * as cmd from "../engine/commands.js";
import { queueProduction, cancelProduction, researchUpgrade, productionRefusalReason, researchUpgradeRefusalReason } from "../engine/production.js";
import { researchTech, cancelResearch, researchTechRefusalReason } from "../engine/techtree.js";
import { hintFor } from "./refusalHints.js";
import { lightFuse } from "../engine/bomb.js";
import { BUILDINGS, UNITS } from "../engine/entities.js";
import { FORMATION_SHAPES, LEADER_POSITIONS } from "../engine/formation.js";
import { LOGI_PRIORITIES } from "../engine/haul.js";
import { isVisibleAt, isExploredAt, isNodeDiscovered } from "../engine/fog.js";

export const LIMITS = Object.freeze({
  ids: 400,          // per-command selection cap
  patrolPoints: 32,  // engine/commands.js's issuePatrol pushes |ids| x |pts| orders — must be bounded
});

export const REJECT = Object.freeze({
  MALFORMED:    "malformed",
  UNKNOWN_TYPE: "unknown-type",
  NOT_OWNER:    "not-owner",       // a LIE — the submitter does not own this entity
  NO_TARGET:    "no-target",       // the object of the command does not exist
  NOT_VISIBLE:  "not-visible",     // fog gate (a rule the engine does not have)
  EMPTY:        "empty-selection", // every id resolved to nothing (a legitimate race)
  TOO_MANY:     "too-many",
  OUT_OF_BOUNDS:"out-of-bounds",
  REFUSED:      "refused",         // the ENGINE said no (afford / prereq / placement)
});

/* ---------- primitives ---------- */

const isId  = v => typeof v === "string" && v.length > 0 && v.length <= 32;
const isNum = v => typeof v === "number" && Number.isFinite(v);
const bool  = v => v === undefined || typeof v === "boolean";

const ok  = (result = null) => ({ ok: true, result });
const err = code => ({ ok: false, code });

function inBounds(state, x, y) {
  return isNum(x) && isNum(y) && x >= 0 && y >= 0 && x <= state.map.width && y <= state.map.height;
}

/* ---------- resolvers: id -> live object, scoped to `owner` ----------

   Two failure modes, deliberately different:
     - the entity is GONE            -> drop that id (a real race between issue and apply)
     - the entity is SOMEONE ELSE'S  -> reject the whole command (a lie)
   Rejecting on "gone" would make the protocol fail under ordinary latency;
   dropping on "not yours" would let an attacker probe the world for free.

   ORDER IS PRESERVED — never sort. ids[0] is the formation leader
   (engine/commands.js's dispatchFormation) and issueEscort derives ring
   slots from array index. */

function resolveOwn(state, owner, ids, pick) {
  if (!Array.isArray(ids) || ids.length === 0) return err(REJECT.EMPTY);
  if (ids.length > LIMITS.ids) return err(REJECT.TOO_MANY);
  const seen = new Set();
  const out = [];
  for (const id of ids) {
    if (!isId(id)) return err(REJECT.MALFORMED);
    if (seen.has(id)) continue;                 // dedupe, first occurrence wins
    seen.add(id);
    const e = pick(state, id);
    if (!e) continue;                            // died in flight — drop
    if (e.owner !== owner) return err(REJECT.NOT_OWNER);
    out.push(e);
  }
  return out.length ? ok(out) : err(REJECT.EMPTY);
}

const pickUnit     = (s, id) => s.units.get(id) || null;
const pickBuilding = (s, id) => s.buildings.get(id) || null;
const pickEntity   = (s, id) => s.units.get(id) || s.buildings.get(id) || null;

const ownUnits    = (s, o, ids) => resolveOwn(s, o, ids, pickUnit);
const ownEntities = (s, o, ids) => resolveOwn(s, o, ids, pickEntity);   // recycle takes both

function ownBuilding(state, owner, id) {
  if (!isId(id)) return err(REJECT.MALFORMED);
  const b = pickBuilding(state, id);
  if (!b) return err(REJECT.NO_TARGET);
  if (b.owner !== owner) return err(REJECT.NOT_OWNER);
  return ok(b);
}

function ownUnit(state, owner, id) {
  if (!isId(id)) return err(REJECT.MALFORMED);
  const u = pickUnit(state, id);
  if (!u) return err(REJECT.NO_TARGET);
  if (u.owner !== owner) return err(REJECT.NOT_OWNER);
  return ok(u);
}

/* Any entity as the OBJECT of a command. Own entities need no fog check; a
   foreign unit must be currently visible, a foreign building merely explored
   (remembered structures stay targetable — standard RTS, and it is what the
   renderer already draws). This rule does not exist in the engine at all —
   inputCommands.js enforces it client-side only, so a client that ignores
   its own renderer is a maphack today; this closes that at the boundary. */
function targetEntity(state, owner, id) {
  if (!isId(id)) return err(REJECT.MALFORMED);
  const e = pickEntity(state, id);
  if (!e) return err(REJECT.NO_TARGET);
  if (e.owner === owner) return ok(e);
  const fog = state.fogs[owner];
  const seen = e.kind === "building" ? isExploredAt(fog, e.x, e.y) : isVisibleAt(fog, e.x, e.y);
  return seen ? ok(e) : err(REJECT.NOT_VISIBLE);
}

function targetNode(state, owner, id) {
  if (!isId(id)) return err(REJECT.MALFORMED);
  const n = state.map.nodes.find(n => n.id === id);
  if (!n) return err(REJECT.NO_TARGET);
  return isNodeDiscovered(state.fogs[owner], n) ? ok(n) : err(REJECT.NOT_VISIBLE);
}

/* ---------- formation ---------- */

function decodeFormation(f) {
  if (f === undefined) return undefined;                 // engine default: flat grid spread
  if (f === null || typeof f !== "object") return null;   // null/non-object => malformed
  const { s = "grid", l = "front", hx, hy } = f;
  if (!FORMATION_SHAPES.includes(s)) return null;
  if (!LEADER_POSITIONS.includes(l)) return null;
  if (hx !== undefined && !isNum(hx)) return null;
  if (hy !== undefined && !isNum(hy)) return null;
  const out = { shape: s, leaderPos: l };
  if (hx !== undefined) out.headingX = hx;
  if (hy !== undefined) out.headingY = hy;
  return out;
}

/* ---------- shared shapes ---------- */

function unitsOnly(state, owner, c, fn) {
  const r = ownUnits(state, owner, c.ids); if (!r.ok) return r;
  fn(r.result); return ok();
}
function entitiesOnly(state, owner, c, fn) {
  const r = ownEntities(state, owner, c.ids); if (!r.ok) return r;
  fn(r.result); return ok();
}
function targeted(state, owner, c, fn) {
  if (!bool(c.q)) return err(REJECT.MALFORMED);
  const t = targetEntity(state, owner, c.target); if (!t.ok) return t;
  const r = ownUnits(state, owner, c.ids);        if (!r.ok) return r;
  fn(r.result, t.result.id, !!c.q); return ok();
}

/* ---------- the schema table ----------
   One entry per wire type. `run` receives the raw, already-shape-checked
   command (net/commandEnvelope.js) plus the caller-supplied owner, resolves
   and owns everything the engine needs, and does nothing but call
   engine/commands.js. Everything that could reject has already rejected by
   the time `cmd.*` is called. */

const SCHEMA = {

  /* ----- movement -----
     `state` rides as the trailing arg to issueMove/issueAttackMove/
     issueHoldFormation (T-017/ADR-0008) so formation dispatch judges
     "human-controlled" from the real match, not the single-player-only
     leader.owner==="player" default every other (non-codec) caller gets. */
  move: { run(state, owner, c) {
    if (!inBounds(state, c.x, c.y)) return err(REJECT.OUT_OF_BOUNDS);
    if (!bool(c.q)) return err(REJECT.MALFORMED);
    const f = decodeFormation(c.f); if (f === null) return err(REJECT.MALFORMED);
    const r = ownUnits(state, owner, c.ids); if (!r.ok) return r;
    cmd.issueMove(r.result, c.x, c.y, !!c.q, f, state);
    return ok();
  }},

  attackMove: { run(state, owner, c) {
    if (!inBounds(state, c.x, c.y)) return err(REJECT.OUT_OF_BOUNDS);
    if (!bool(c.q)) return err(REJECT.MALFORMED);
    const f = decodeFormation(c.f); if (f === null) return err(REJECT.MALFORMED);
    const r = ownUnits(state, owner, c.ids); if (!r.ok) return r;
    cmd.issueAttackMove(r.result, c.x, c.y, !!c.q, f, state);
    return ok();
  }},

  holdFormation: { run(state, owner, c) {
    const s = c.s ?? "grid", l = c.l ?? "front";
    if (!FORMATION_SHAPES.includes(s) || !LEADER_POSITIONS.includes(l)) return err(REJECT.MALFORMED);
    const r = ownUnits(state, owner, c.ids); if (!r.ok) return r;
    cmd.issueHoldFormation(r.result, s, l, state);
    return ok();
  }},

  patrol: { run(state, owner, c) {
    if (!Array.isArray(c.pts) || !c.pts.length) return err(REJECT.MALFORMED);
    if (c.pts.length > LIMITS.patrolPoints) return err(REJECT.TOO_MANY);
    for (const p of c.pts) if (!p || !inBounds(state, p.x, p.y)) return err(REJECT.OUT_OF_BOUNDS);
    const r = ownUnits(state, owner, c.ids); if (!r.ok) return r;
    cmd.issuePatrol(r.result, c.pts.map(p => ({ x: p.x, y: p.y })));   // strip any extra keys
    return ok();
  }},

  stop:  { run: (s, o, c) => unitsOnly(s, o, c, us => cmd.issueStop(us)) },
  hold:  { run: (s, o, c) => unitsOnly(s, o, c, us => cmd.issueHold(us)) },
  scout: { run: (s, o, c) => unitsOnly(s, o, c, us => cmd.issueScout(us)) },

  /* ----- targeted -----
     attack's friendly-fire case is ALSO stopped inside the engine now
     (T-019/FR-10, combat.js) — this codec-level check exists for a cleaner,
     specific reject reason (NOT_OWNER) rather than a silent engine no-op,
     defense in depth, not the only layer. */
  attack: { run(state, owner, c) {
    if (!bool(c.q)) return err(REJECT.MALFORMED);
    const t = targetEntity(state, owner, c.target); if (!t.ok) return t;
    if (t.result.owner === owner) return err(REJECT.NOT_OWNER);   // no ordering your own side to attack itself
    const r = ownUnits(state, owner, c.ids);        if (!r.ok) return r;
    cmd.issueAttack(r.result, t.result.id, !!c.q);
    return ok();
  }},

  escort: { run(state, owner, c) {
    if (!bool(c.q)) return err(REJECT.MALFORMED);
    const t = targetEntity(state, owner, c.target); if (!t.ok) return t;
    const r = ownUnits(state, owner, c.ids);        if (!r.ok) return r;
    // inputCommands.js filters the target out of its own escort ring client-side; do the same
    // here so the engine can never be handed a unit escorting itself.
    const units = r.result.filter(u => u.id !== t.result.id);
    if (!units.length) return err(REJECT.EMPTY);
    cmd.issueEscort(units, t.result.id, !!c.q);
    return ok();
  }},

  repair:  { run: (s, o, c) => targeted(s, o, c, (us, id, q) => cmd.issueRepair(us, id, q)) },
  service: { run: (s, o, c) => targeted(s, o, c, (us, id, q) => cmd.issueServiceBuilding(us, id, q)) },

  ferry: { run(state, owner, c) {
    if (!bool(c.q)) return err(REJECT.MALFORMED);
    const t = ownUnit(state, owner, c.target); if (!t.ok) return t;   // your OWN freighter only
    const r = ownUnits(state, owner, c.ids);   if (!r.ok) return r;
    cmd.issueFerryFreighter(r.result, t.result.id, !!c.q);
    return ok();
  }},

  // T-019a: target may be null (clear the home base) — the one place this schema table's
  // resolve-an-owned-building pattern doesn't apply, since there is nothing to resolve.
  setHomeBase: { run(state, owner, c) {
    const r = ownUnits(state, owner, c.ids); if (!r.ok) return r;
    if (c.target === null) { cmd.issueSetHomeBase(r.result, null); return ok(); }
    const t = ownBuilding(state, owner, c.target); if (!t.ok) return t;
    if (t.result.type !== "command") return err(REJECT.MALFORMED);   // the engine never validates this itself
    cmd.issueSetHomeBase(r.result, t.result.id);
    return ok();
  }},

  assistBuild: { run(state, owner, c) {
    if (!bool(c.q)) return err(REJECT.MALFORMED);
    const t = ownBuilding(state, owner, c.target); if (!t.ok) return t;
    if (!t.result.constructing) return err(REJECT.NO_TARGET);
    const r = ownUnits(state, owner, c.ids); if (!r.ok) return r;
    // buildingType comes from the RESOLVED SITE, never the wire — it's the only thing gating
    // unit eligibility (engine/commands.js), and a lying client would otherwise walk a combat
    // unit onto a site the engine would have refused.
    cmd.issueAssistBuild(r.result, t.result.id, t.result.type, !!c.q);
    return ok();
  }},

  gather: { run(state, owner, c) {
    if (!bool(c.q)) return err(REJECT.MALFORMED);
    const n = targetNode(state, owner, c.node); if (!n.ok) return n;
    const r = ownUnits(state, owner, c.ids);    if (!r.ok) return r;
    cmd.issueGather(r.result, n.result.id, !!c.q);
    return ok();
  }},

  /* ----- construction ----- */
  build: { run(state, owner, c) {
    if (typeof c.b !== "string" || !BUILDINGS[c.b]) return err(REJECT.MALFORMED);
    if (!inBounds(state, c.x, c.y)) return err(REJECT.OUT_OF_BOUNDS);
    const w = ownUnit(state, owner, c.worker); if (!w.ok) return w;
    // Everything else — canBuildCategory, canAfford, prereqsMet, canPlaceBuilding, payCost — is
    // re-run by the engine against authoritative state at THIS tick. Re-implementing none of it
    // is the payoff of ADR-0006 D1.
    const id = cmd.issueBuild(state, w.result.id, c.b, c.x, c.y);
    if (id) return ok({ buildingId: id });
    // Which of those engine-side checks actually said no — see engine/commands.js's own
    // buildRefusalReason for why the discriminator lives there rather than being re-derived here.
    return { ok: false, code: REJECT.REFUSED, reason: cmd.buildRefusalReason(state, w.result.id, c.b, c.x, c.y) };
  }},

  // T-019: issueRecycle's own optional owner param is passed too — redundant with this codec's
  // own resolveOwn filtering (entitiesOnly already hard-rejects a foreign id before this runs),
  // but cheap, and it means the engine-level guard is live even if a future codec change ever
  // forgot to filter first.
  recycle:       { run: (s, o, c) => entitiesOnly(s, o, c, es => cmd.issueRecycle(es, o)) },
  cancelRecycle: { run: (s, o, c) => entitiesOnly(s, o, c, es => cmd.issueCancelRecycle(es)) },

  /* ----- toggles ----- */
  setAILogistics: { run(state, owner, c) {
    if (typeof c.on !== "boolean") return err(REJECT.MALFORMED);
    const r = ownUnits(state, owner, c.ids); if (!r.ok) return r;
    cmd.issueSetAILogistics(r.result, c.on, state);
    return ok();
  }},

  setCollectPoint: { run(state, owner, c) {
    if (typeof c.on !== "boolean") return err(REJECT.MALFORMED);
    const r = ownUnits(state, owner, c.ids); if (!r.ok) return r;
    cmd.issueSetCollectPoint(r.result, c.on);
    return ok();
  }},

  // T-019a: new command, same optional-owner pattern as issueRecycle.
  setElectrified: { run(state, owner, c) {
    if (typeof c.on !== "boolean") return err(REJECT.MALFORMED);
    const r = ownEntities(state, owner, c.ids); if (!r.ok) return r;
    cmd.issueSetElectrified(r.result, c.on, owner);
    return ok();
  }},

  setLogiPriority: { run(state, owner, c) {
    if (!LOGI_PRIORITIES.includes(c.p)) return err(REJECT.MALFORMED);
    const b = ownBuilding(state, owner, c.building); if (!b.ok) return b;
    cmd.issueSetLogiPriority(state, b.result.id, c.p);   // engine has no owner check of its own
    return ok();
  }},

  // T-021/D2: issueSetRally is id-based now (state, buildingId, ...) — the one engine signature
  // ADR-0006 sanctioned changing, so the codec never has to hand a raw object across this boundary.
  setRally: { run(state, owner, c) {
    if (!inBounds(state, c.x, c.y)) return err(REJECT.OUT_OF_BOUNDS);
    const b = ownBuilding(state, owner, c.building); if (!b.ok) return b;
    let nodeId = null;
    if (c.node !== undefined && c.node !== null) {
      const n = targetNode(state, owner, c.node); if (!n.ok) return n;
      nodeId = n.result.id;
    }
    cmd.issueSetRally(state, b.result.id, c.x, c.y, nodeId);
    return ok();
  }},

  /* ----- production / research (already in net/commandShapes.js's skirmish-core scope) -----
     queueProduction/cancelProduction/researchUpgrade/researchTech/cancelResearch all derive the
     paying player from building.owner internally (engine/production.js, engine/techtree.js) —
     same exposure class as issueBuild (dossier 02 §2.2) until this resolver scopes the building
     to the submitting owner FIRST. */
  /* A queued job's own receipt (agent-observability). This used to `return ok()` unconditionally —
     including when engine/production.js's queueProduction had refused — so a caller got the exact
     same empty success for "queued" and for "declined", and the ore isn't debited until the job
     actually starts, leaving nothing observable to tell them apart either. An agent reading that
     as a silent no-op re-sends the same order several times, which is the failure this shape ends:
     a refusal now reports WHY (productionRefusalReason, the same checks the engine itself just
     ran), and a success reports the queue slot it landed in and how long the whole queue takes to
     drain, so the caller can wait rather than re-order. `etaSeconds` is nominal build time only —
     the raw def.buildTime sum, deliberately not the modifier/electrification-adjusted rate
     updateProductionQueue actually advances at (that varies tick to tick with the power grid and
     with buildings being razed), so it reads as the estimate its name says it is. */
  queueProduction: { run(state, owner, c) {
    if (typeof c.u !== "string" || !bool(c.alt)) return err(REJECT.MALFORMED);
    const b = ownBuilding(state, owner, c.building); if (!b.ok) return b;
    const building = b.result;
    if (!queueProduction(state, building.id, c.u, !!c.alt)) {
      return { ok: false, code: REJECT.REFUSED, reason: productionRefusalReason(state, building.id, c.u, !!c.alt) };
    }
    const queue = building.queue;
    const etaSeconds = queue.reduce((sum, job, i) => {
      const bt = UNITS[job.unitType]?.buildTime || 0;
      return sum + (i === 0 ? bt * (1 - (job.progress || 0)) : bt);
    }, 0);
    return ok({ building: building.id, unit: c.u, queueIndex: queue.length - 1, queueLength: queue.length, etaSeconds });
  }},

  cancelProduction: { run(state, owner, c) {
    if (!Number.isInteger(c.i) || c.i < 0) return err(REJECT.MALFORMED);
    const b = ownBuilding(state, owner, c.building); if (!b.ok) return b;
    // Same agent-observability shape as queueProduction: a cancel that hit an index the queue
    // doesn't have used to report success, so a caller couldn't tell "cancelled and refunded"
    // from "your index was stale" — and re-sent it.
    if (!cancelProduction(state, b.result.id, c.i)) return { ok: false, code: REJECT.REFUSED, reason: "no-such-job" };
    return ok();
  }},

  researchUpgrade: { run(state, owner, c) {
    if (typeof c.up !== "string") return err(REJECT.MALFORMED);
    const b = ownBuilding(state, owner, c.building); if (!b.ok) return b;
    // Research used to report success unconditionally — a doctrine-locked, unaffordable or
    // already-queued upgrade looked exactly like a queued one. Report WHY instead (the same
    // checks engine/production.js just ran), so a caller can fix the order rather than repeat it.
    if (!researchUpgrade(state, b.result.id, c.up)) {
      return { ok: false, code: REJECT.REFUSED, reason: researchUpgradeRefusalReason(state, b.result.id, c.up) };
    }
    return ok();
  }},

  researchTech: { run(state, owner, c) {
    if (typeof c.tech !== "string") return err(REJECT.MALFORMED);
    const b = ownBuilding(state, owner, c.building); if (!b.ok) return b;
    if (!researchTech(state, b.result.id, c.tech)) {   // same shape/rationale as researchUpgrade above
      return { ok: false, code: REJECT.REFUSED, reason: researchTechRefusalReason(state, b.result.id, c.tech) };
    }
    return ok();
  }},

  cancelResearch: { run(state, owner, c) {
    if (!Number.isInteger(c.i) || c.i < 0) return err(REJECT.MALFORMED);
    const b = ownBuilding(state, owner, c.building); if (!b.ok) return b;
    if (!cancelResearch(state, b.result.id, c.i)) return { ok: false, code: REJECT.REFUSED, reason: "no-such-job" };
    return ok();
  }},

  lightFuse: { run(state, owner, c) {
    const u = ownUnit(state, owner, c.unit); if (!u.ok) return u;
    // Only a BOMB has a fuse. engine/bomb.js's lightFuse takes the bomb it is given on trust
    // (every in-game caller already holds one), so without this gate a mistyped id quietly
    // stamped `fuseUntil` onto an ordinary unit and answered "ok" — the worst kind of silent
    // failure for a caller driving the match over the wire.
    const bomb = u.result;
    if (UNITS[bomb.type]?.role !== "bomb")  return { ok: false, code: REJECT.REFUSED, reason: "not-a-bomb" };
    if (!bomb.armed)                        return { ok: false, code: REJECT.REFUSED, reason: "bomb-not-armed" };
    if (bomb.fuseUntil != null)             return { ok: false, code: REJECT.REFUSED, reason: "fuse-already-lit" };
    lightFuse(state, bomb);
    return ok();
  }},
};

export const COMMAND_TYPES = Object.freeze(Object.keys(SCHEMA));

/**
 * Apply ONE already-shape-validated WireCommand (net/commandEnvelope.js's decode()
 * has already run) against live state, as `owner`. Runs at the scheduled tick,
 * immediately before tick(state, dt) (T-023).
 * @param {Object} state @param {string} owner @param {WireCommand} command
 * @returns {CommandResult}
 */
export function apply(state, owner, command) {
  const r = run(state, owner, command);
  // Every rejection — from this file's own shape/ownership/fog gates AND from the engine's
  // refusal reasons — carries one action-oriented sentence saying what to do about it
  // (net/refusalHints.js). Purely additive: `code` and `reason` are untouched and remain the
  // fields to branch on; `hint` is for whoever reads the result, human or agent.
  if (r.ok || r.hint) return r;   // a batch member's rejection already carries its OWN hint
  return { ...r, hint: hintFor(state, owner, command, r) };
}

/** @param {Object} state @param {string} owner @param {WireCommand} command @returns {CommandResult} */
function run(state, owner, command) {
  if (!command || typeof command !== "object" || typeof command.t !== "string") return err(REJECT.MALFORMED);
  if (command.t === "batch") {
    if (!Array.isArray(command.c) || !command.c.length) return err(REJECT.MALFORMED);
    if (command.c.length > 16) return err(REJECT.TOO_MANY);
    // Atomic on validation: a batch is one client gesture resolved against one observed state
    // (a right-click fanning into e.g. an attackMove for combatants and a move for everyone
    // else). If any member is invalid the client's disambiguation was wrong, so none apply.
    // NOT rolled back once a member has mutated state — see this file's own header on why that
    // is acceptable for the only batch shape actually generated today.
    const results = [];
    for (const sub of command.c) {
      if (!sub || sub.t === "batch") return err(REJECT.MALFORMED);
      const entry = SCHEMA[sub.t];
      if (!entry) return err(REJECT.UNKNOWN_TYPE);
      const r = entry.run(state, owner, sub);
      // The hint is built from the MEMBER that actually failed, not the batch wrapper — the
      // wrapper has no `b`/`u`/coords to explain the refusal with.
      if (!r.ok) return { ...r, hint: hintFor(state, owner, sub, r) };
      results.push(r.result);
    }
    return ok(results);
  }
  const entry = SCHEMA[command.t];
  if (!entry) return err(REJECT.UNKNOWN_TYPE);
  return entry.run(state, owner, command);
}
