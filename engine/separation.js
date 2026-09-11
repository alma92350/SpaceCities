// @ts-check
/* ============================================================
   General collision separation: any two same-owner units — any type,
   however they got where they are (a shared rally point, a group order,
   two workers converging on one node, whatever) — get gently pushed
   apart the instant their bodies overlap. This runs every tick as a
   correction pass, independent of movement/orders, so it catches
   stacking from any source instead of needing a fix at each place an
   order gets assigned.

   Deliberately skips different-owner pairs: opposing units are meant to
   close to weapon range and stand there, not get shoved off it.
   ============================================================ */

"use strict";

import { UNITS } from "./entities.js";
import { queryNeighbors, REJECT_SLACK } from "./grid.js";
import { hashStr } from "./rng.js";
import { MAX_UNIT_RADIUS } from "./movement.js";

const PUSH_SPEED = 60;   // units/sec of separation at full overlap
// A gap beyond bare hull-to-hull contact: idle/converging same-owner units used to rest exactly
// at their combined radii (zero padding), sitting shoulder to shoulder. A standalone multiplier
// on minDist below — not a change to entities.js's own radius fields — so it stays independent of
// formation.js's own COARSENESS spacing multiplier, which reads that same radius field for a
// units-in-formation's target slots; the two widen idle rest-spacing and in-formation spacing by
// their own, separately-tunable amounts instead of one feeding into (and compounding with) the
// other.
const SEPARATION_PAD_MULT = 1.2;
const SEP_RADIUS = 2 * MAX_UNIT_RADIUS * SEPARATION_PAD_MULT;   // two largest hulls at the padded distance — the widest possible minDist; derived, never stale

// A background world left to idle can pile up a same-owner army numbering in the
// hundreds, all crammed onto roughly the same rally point (nothing consumes an idle
// standing army). queryNeighbors' candidate list for a query planted inside that pile
// scales with local density, not with army size — ordinary battles never come close to
// this many bodies in one broad-phase cell, so bounding it here changes nothing for them,
// but it keeps a genuinely pathological pile from turning one applySeparation call into
// a near-O(pile^2) pass. MAX_SEPARATION_NEIGHBORS is well above any realistic legitimate
// local cluster (verified by the full test/balance/determinism suites staying green).
export const MAX_SEPARATION_NEIGHBORS = 40;

// This module's own broad-phase result buffer (see engine/grid.js) — one per
// call site so no two can alias each other's candidates.
const _sepBuf = [];

// The [start, take) window into a length-`n` candidate list that unit `gi` scans this
// call. Identity ([0, n)) under the cap — byte-identical to the old plain for-of. Past
// the cap it takes a fixed-size slice that starts at (gi + tick) % n: offset by gi so a
// huge pile isn't split into an "always resolved" low-_gi group and a "never resolved"
// high-_gi remainder within a single tick, and slid forward by the simulation's own tick
// counter so a pile sitting at a stable local density doesn't get stuck scanning the same
// window forever — every pair comes into some unit's window at least once every n ticks.
// state.tick is a plain deterministic counter (engine/state.js), so this stays exactly as
// reproducible as everything else in a seeded replay. Pure arithmetic, no allocation —
// safe to call once per unit on the hot path.
/** @param {number} n @param {number} gi @param {number} tick @returns {[number, number]} */
export function separationWindow(n, gi, tick) {
  if (n <= MAX_SEPARATION_NEIGHBORS) return [0, n];
  return [(gi + tick) % n, MAX_SEPARATION_NEIGHBORS];
}

/** @param {State} state @param {number} dt */
export function applySeparation(state, dt) {
  const grid = state.unitGrid;
  if (!grid) {
    // No broad-phase index (a direct unit test, not a full tick): exact original
    // all-pairs pass, so those tests stay byte-for-byte unchanged.
    const units = [...state.units.values()];
    for (let i = 0; i < units.length; i++) {
      for (let j = i + 1; j < units.length; j++) separatePair(units[i], units[j], dt);
    }
    return;
  }
  // Grid broad phase: for each unit, only test the handful of units in nearby
  // cells, and only the higher-indexed one of each pair so every pair resolves
  // exactly once (matching the i<j semantics above) — bounded by separationWindow
  // so a pathologically dense cell can't blow up a single tick's cost.
  for (const a of state.units.values()) {
    const near = queryNeighbors(grid, a.x, a.y, SEP_RADIUS, undefined, _sepBuf);
    const n = near.length;
    const [start, take] = separationWindow(n, a._gi, state.tick);
    for (let k = 0; k < take; k++) {
      const b = near[(start + k) % n];
      if (b._gi > a._gi && b.hp > 0) separatePair(a, b, dt);
    }
  }
}

// Whether `u` is in "combat mode": an explicit attack or attack-move order (engine/combat.js
// engages either the instant an enemy comes into range, so an army still CLOSING the distance
// counts too — not just a unit that's already found a target), or one of combat.js's two other
// live-target registers (unit.autoTarget's sticky auto-acquire, unit.focusId's AI tactical
// focus-fire). Deliberately NOT combat mode for a plain 'move' order, 'gather'/'build', a formation
// move, or no order at all (idle) — exactly the "idle or in formation" cases SEPARATION_PAD_MULT is
// meant to widen. Excluding the whole approach, not just the moment contact is made, matters: two
// still-converging attackers held further apart from EACH OTHER during the approach arrive
// staggered rather than together, so an already-borderline matchup (a swarm's mass-fire timing vs.
// a slow, heavy single target) can quietly tip — the exact class of regression
// test/balance.test.js's auto-battle harness exists to catch. A stale autoTarget/focusId (its
// target just died this same tick, not yet cleared) reads as still-combat-mode for one tick too
// long — harmless: it only means a unit keeps its tighter just-fought spacing a beat longer before
// relaxing outward, never the other way round.
function isCombatMode(u) {
  return (u.order && (u.order.type === "attack" || u.order.type === "attack-move")) || u.autoTarget != null || u.focusId != null;
}

function separatePair(a, b, dt) {
  if (a.owner !== b.owner) return;
  // Combat packing is a balance-tuned invariant (test/balance.test.js's whole auto-battle
  // regression harness) — SEPARATION_PAD_MULT must never loosen how tightly a squad can mass fire
  // on one target (or close the distance to do so), only how far apart units rest when neither
  // side of the pair is in combat mode at all. See isCombatMode just above.
  const pad = (isCombatMode(a) || isCombatMode(b)) ? 1 : SEPARATION_PAD_MULT;
  const minDist = (UNITS[a.type].radius + UNITS[b.type].radius) * pad;

  let dx = b.x - a.x, dy = b.y - a.y;
  // Squared-distance pre-reject before paying for a Math.hypot — see
  // REJECT_SLACK in engine/grid.js. Most candidate pairs in a broad-phase cell
  // are not actually overlapping, so most return here without a square root.
  if (dx * dx + dy * dy >= minDist * minDist * REJECT_SLACK) return;
  let dist = Math.hypot(dx, dy);
  if (dist >= minDist) return;

  if (dist < 1e-4) {
    const angle = hashAngle(a.id, b.id);
    dx = Math.cos(angle); dy = Math.sin(angle); dist = 1;
  }

  const overlap = minDist - dist;
  const nx = dx / dist, ny = dy / dist;
  const push = Math.min(overlap, PUSH_SPEED * dt) / 2;
  a.x -= nx * push; a.y -= ny * push;
  b.x += nx * push; b.y += ny * push;
}

// Deterministic per-pair direction for the (rare) exactly-coincident case,
// so two units spawned on the same point don't jitter frame to frame.
function hashAngle(idA, idB) {
  return (hashStr(idA + idB) % 360) * (Math.PI / 180);
}
