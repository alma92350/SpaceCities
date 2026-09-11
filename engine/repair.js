/* ============================================================
   Support-role healing. Once per tick (after all this tick's combat has
   resolved), every Mender mends the friendly units and buildings around it.

   A single global pass — not a per-unit order — because the Mender's healing
   is passive and area-based: wherever it stands, it patches whatever friendly
   damage is in reach, no target-picking or micro required. Keeping it out of
   the order pipeline means a Mender can be moving, holding, or idle and still
   heal, exactly like a real support drone.

   Determinism: the amount each Mender adds is a fixed repairRate*dt, and every
   target is clamped to its own maxHp after each contribution. min(maxHp, ...)
   makes overlapping heals order-independent (two Menders on one unit reach the
   same capped hp regardless of Map iteration order), so this pass is safe for
   the same-seed replay guarantee.
   ============================================================ */

"use strict";

import { UNITS, UPGRADES } from "./entities.js";
import { queryNeighbors } from "./grid.js";
import { onPowerGrid } from "./industry.js";
import { stepToward } from "./movement.js";
import { zoneFirst } from "./gather.js";
import { getEntity } from "./state.js";

const OFFGRID_HEAL = 0.3;   // an Odyssey Mender off the powered grid limps on reserves at this fraction

// This module's own broad-phase result buffer (see engine/grid.js) — one per
// call site so no two can alias each other's candidates.
const _menderBuf = [];

// Shared "does this need repair" thresholds — hysteresis for whoever's roaming to fix things
// (the auto-repair Mender, engine/sim.js; the worker repair job below): only get ATTRACTED to a
// friendly once it's worn past NEEDS_REPAIR, and once committed, keep servicing it until it's back
// above HEALED — so a full building nicked by a hair of wear can't yank a repairer back and forth.
export const NEEDS_REPAIR = 0.85;   // only chase a friendly once it's dropped below this share of max HP
export const HEALED = 0.985;        // …and keep servicing it until it's back above this — the release point

/**
 * Pick the friendly most in need of repair for a repairer standing at (x,y) — preferring one in
 * the REPAIRER's OWN Command Center zone first (engine/gather.js zoneFirst), and only widening to
 * the whole empire once its own zone has nothing eligible. Within a pass, priority is most-worn-
 * first (lowest hp fraction), distance breaks ties — shared shape for the auto-repair Mender and
 * the worker repair job below (both can now target either a building or a wounded mobile unit).
 * `isClaimed` lets each caller enforce its OWN per-target cap (Mender: one auto-repair drone per
 * building; a worker: MAX_REPAIRERS) without this needing to know which kind of caller it is;
 * `exclude` keeps a repairer from ever picking itself. `homeId`, when given, is a player-assigned
 * home-base override (engine/commands.js issueSetHomeBase) that wins over the usual nearest-CC
 * guess — see engine/gather.js zoneFirst.
 * @param {State} state @param {string} owner @param {number} x @param {number} y
 * @param {{includeUnits?: boolean, isClaimed?: (e:*) => boolean, exclude?: *, threshold?: number, homeId?: string}} [opts]
 * @returns {Building|Unit|null}
 */
export function pickRepairTarget(state, owner, x, y, opts = {}) {
  const { includeUnits = true, isClaimed = () => false, exclude = null, threshold = NEEDS_REPAIR, homeId } = opts;
  const scanFor = (inZone) => {
    let best = null, bestFrac = threshold, bestD = Infinity;
    const consider = (e) => {
      if (!e || e === exclude || e.owner !== owner) return;
      if (e.hp <= 0 || e.hp >= e.maxHp || e.constructing) return;
      if (isClaimed(e)) return;
      const frac = e.hp / e.maxHp;
      if (frac >= threshold) return;
      if (inZone && !inZone(e.x, e.y)) return;
      const d = Math.hypot(e.x - x, e.y - y);
      if (frac < bestFrac - 1e-9 || (Math.abs(frac - bestFrac) <= 1e-9 && d < bestD)) { bestFrac = frac; bestD = d; best = e; }
    };
    for (const b of state.buildings.values()) consider(b);
    if (includeUnits) for (const u of state.units.values()) consider(u);
    return best;
  };
  return zoneFirst(state, owner, x, y, scanFor, homeId);
}

// ---- Worker REPAIR job: a generalist worker patching its own base's structures AND wounded mobile
// units, discovered/dispatched the SAME zone-first way as a haul/service job (engine/haul.js), so it
// competes for the same idle labour pool and stays loyal to its own base first. Free, like a
// Mender's heal — a worker spends time, not resources.
const MAX_REPAIRERS = 2;        // workers auto-assigned to repair the same target, so labour spreads
const REPAIR_REACH = 24;        // matches production.js's BUILD_REACH — a worker patches on-site, like construction
const WORKER_REPAIR_RATE = 4;   // hp/sec a lone worker patches at — gentler than a Mender's dedicated 6

/**
 * Per-target (building OR unit) tally of workers already assigned to repair it THIS TICK — frozen
 * before any new assignment (same "count first, then assign" shape as engine/haul.js
 * countLogistics) so the ≤MAX_REPAIRERS cap reads the same regardless of Map iteration order.
 * Transient (stripped on serialize, engine/persist.js).
 * @param {State} state
 */
export function countRepairJobs(state) {
  for (const b of state.buildings.values()) b.repairers = 0;
  for (const u of state.units.values()) u.repairers = 0;
  for (const u of state.units.values()) {
    const o = u.order;
    if (o && o.type === "repair" && o.targetId) {
      const t = getEntity(state, o.targetId);
      if (t) t.repairers = (t.repairers || 0) + 1;
    }
  }
}

/**
 * Give an idle worker a REPAIR job on the own building or wounded mobile unit most in need
 * (zone-first, honoring a player-assigned home base — unit.homeCC). Claims a slot for the tick.
 * @param {State} state @param {Unit} unit
 */
export function assignRepair(state, unit) {
  const best = pickRepairTarget(state, unit.owner, unit.x, unit.y, {
    exclude: unit,   // a worker doesn't repair itself
    isClaimed: (e) => (e.repairers || 0) >= MAX_REPAIRERS,
    homeId: unit.homeCC,
  });
  if (!best) return;
  best.repairers = (best.repairers || 0) + 1;
  unit.order = { type: "repair", targetId: best.id, phase: "toSite" };
}

/**
 * Advance a REPAIR job: walk to the damaged building or wounded unit and patch it at
 * WORKER_REPAIR_RATE hp/sec once in reach — a mobile target just keeps getting chased, the same
 * "walk toward its live position" idiom the auto-repair Mender's roam already uses. An
 * auto-assigned worker frees up the instant it's topped off; a manually-assigned one (`order.manual`,
 * engine/commands.js issueRepair) stays parked there instead, ready the moment it takes damage
 * again — same auto-vs-manual split haul/service already use. Salvages gracefully if the target is
 * gone/dead or (a building) still under construction (nothing to mend yet).
 * @param {State} state @param {Unit} unit @param {number} dt
 */
export function updateRepairJob(state, unit, dt) {
  const def = UNITS[unit.type];
  const order = unit.order;
  const target = order.targetId ? getEntity(state, order.targetId) : null;
  if (!target || target.hp <= 0 || target.constructing) { unit.order = null; return; }
  if (Math.hypot(target.x - unit.x, target.y - unit.y) > REPAIR_REACH) {
    stepToward(state, unit, target.x, target.y, def.speed, dt);
    return;
  }
  target.hp = Math.min(target.maxHp, target.hp + WORKER_REPAIR_RATE * dt);
  if (target.hp >= target.maxHp && !order.manual) unit.order = null;
}

// A Mender recharges from power stations: on an Odyssey world it heals at full rate only while it's
// on the powered grid (near an active Reactor/Generator — engine/industry.js), and drops to reserves
// off-grid. A skirmish has no power economy, so its Menders always heal at full rate (unchanged).
function menderHealScale(state, mender) {
  if (!state.endless) return 1;
  return onPowerGrid(state, mender.owner, mender.x, mender.y) ? 1 : OFFGRID_HEAL;
}

export function updateRepair(state, dt) {
  for (const mender of state.units.values()) {
    const def = UNITS[mender.type];
    if (!def || def.role !== "support") continue;
    const heal = def.repairRate * dt * menderHealScale(state, mender);
    const range = def.repairRange;

    // Friendly damaged UNITS in range. Units go through the broad-phase grid
    // (there can be hundreds); a straight scan is the fallback for the many
    // tests that drive repair without building a per-tick grid.
    const cands = state.unitGrid
      ? queryNeighbors(state.unitGrid, mender.x, mender.y, range, undefined, _menderBuf)
      : state.units.values();
    for (const u of cands) {
      if (u === mender) continue;               // a Mender never heals itself — it's meant to be a fragile, escorted asset
      if (u.owner !== mender.owner) continue;   // friendlies only
      if (u.hp <= 0 || u.hp >= u.maxHp) continue;
      if (Math.hypot(u.x - mender.x, u.y - mender.y) > range) continue;
      u.hp = Math.min(u.maxHp, u.hp + heal);
    }

    // Friendly damaged BUILDINGS in range. Buildings aren't in the unit grid,
    // but there are only ever a handful, so a direct scan is cheap. A building
    // still under construction is skipped — a half-built shell has no battle
    // damage to mend, and the builder owns that progress.
    for (const b of state.buildings.values()) {
      if (b.owner !== mender.owner || b.constructing) continue;
      if (b.hp <= 0 || b.hp >= b.maxHp) continue;
      if (Math.hypot(b.x - mender.x, b.y - mender.y) > range) continue;
      b.hp = Math.min(b.maxHp, b.hp + heal);
    }
  }
}

/* ============================================================
   Bulwark doctrine regen (engine/entities.js UPGRADES.reinforcedBulwark / selfSealingPlating) —
   a SEPARATE pass from the Mender's updateRepair above: doctrine-gated (not every player has it),
   army-only (role:"combat" units, not buildings — this is the army's own attrition tool, not a
   base-repair one), and reads unit.lastHitAt (engine/combat.js performAttack/applySplash) rather
   than proximity to a healer.

   THE RECONCILIATION: docs/improvement-proposals.md's "Give the doctrine Tier-2s a verb" and
   "Tier-3 doctrine capstones" proposals were written independently and BOTH landed on "out-of-
   combat hp regen" as Bulwark's identity — one for reinforcedBulwark (Tier 2), one for a Tier-3
   capstone. Rather than ship two separately-tracked regen fields (a silent double-heal for a
   player who owns both, or a Tier-3 pick that just restates what Tier 2 already grants), this is
   ONE mechanic with two knobs, and selfSealingPlating (the capstone) is a genuine DEEPENING of
   it, not a repeat:
     - reinforcedBulwark (Tier 2) grants the verb itself: `regenRate` hp/s of passive hull regen,
       for role:"combat" units only, once `regenDelay` seconds have passed since the unit's last
       hit — "win attrition wars by cycling out of fights" (the proposal's own framing).
     - selfSealingPlating (Tier 3, requires reinforcedBulwark + arsenal) does not add a second
       regen source on top of the first — it replaces Tier 2's numbers with strictly better ones
       (3x the rate, well under half the delay — see entities.js), so a fully-committed Bulwark
       army both starts healing sooner after disengaging AND heals faster once it does. A
       Tier-2-only army must fully sit out a fight for 8s before it heals at all; a Tier-2+3 army
       peels a wounded unit out for a much shorter breather and patches it up quicker too — a
       measurable, tested difference (test/repair.test.js), not just a relabeled Tier-2.
   Both tiers read `regenRate`/`regenDelay` straight off whichever UPGRADES entry applies — not
   through the generic upgradeMult() product (entities.js): a rate and a delay aren't multipliers
   to stack, they're the two knobs of one mechanic, the same "read directly" idiom recycling's own
   capability flag already uses. bulwarkRegen() below picks the capstone's numbers over Tier-2's
   whenever both are present, so a save can never double-apply both tiers at once.

   Both tiers share the exact same gate — state.time - (unit.lastHitAt||0) > delay — so a unit
   under CONTINUOUS fire never crosses even the shortened Tier-3 delay: regen stays strictly
   out-of-combat at every tier, which is what keeps test/balance.test.js's auto-battle duels
   (continuous fire, no gaps) unaffected. See test/repair.test.js for the tier-vs-tier proof.
   ============================================================ */

// The regen grant in effect for `upgrades` — the capstone's numbers when researched, else
// Tier-2's, else null (no Bulwark regen at all). Never both: this is what stops a Tier-2+3 player
// from double-healing.
function bulwarkRegen(upgrades) {
  if (!upgrades) return null;
  if (upgrades.selfSealingPlating) return UPGRADES.selfSealingPlating;
  if (upgrades.reinforcedBulwark) return UPGRADES.reinforcedBulwark;
  return null;
}

/**
 * Passive Bulwark hull regen for role:"combat" units whose owner has researched reinforcedBulwark
 * or selfSealingPlating. Called once per tick from sim.js, right after updateRepair — same "after
 * this tick's combat has resolved" timing that pass already documents, so a unit hit THIS tick
 * (lastHitAt just stamped to the still-current state.time) never regens on that same tick.
 * A no-op entirely for a player without either upgrade, so games without this doctrine tier are
 * byte-identical to before it existed.
 * @param {State} state @param {number} dt
 */
export function updateBulwarkRegen(state, dt) {
  for (const unit of state.units.values()) {
    if (unit.hp <= 0 || unit.hp >= unit.maxHp) continue;
    const def = UNITS[unit.type];
    if (!def || def.role !== "combat") continue;   // the army verb — workers/support/freighters sit this out
    const grant = bulwarkRegen(state.players[unit.owner]?.upgrades);
    if (!grant) continue;
    if (state.time - (unit.lastHitAt || 0) <= grant.regenDelay) continue;   // still in (or too recently out of) a fight
    unit.hp = Math.min(unit.maxHp, unit.hp + grant.regenRate * dt);
  }
}
