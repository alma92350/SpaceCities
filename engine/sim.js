/* ============================================================
   Per-tick orchestrator: advances every unit and building by one fixed
   timestep, runs the AI's think cycle, and checks for a winner. This is
   the only thing engine/loop.js's `update` callback calls.
   ============================================================ */

"use strict";

import { stepToward, keepEscortStation, keepFormationStation, keepFollowingLeader, orderedSpeed } from "./movement.js";
import { buildUnitGrid } from "./grid.js";
import { updateGather } from "./gather.js";
import { updateHaul, assignHaul, updateService, assignService, updateFerry, assignFerry, assignShuttle, updateFreighterShuttle, countLogistics, payAIUpkeep, FREIGHTER_AI_TECH } from "./haul.js";
import { updateScoutMode } from "./scout.js";
import { updateRepair, updateBulwarkRegen, pickRepairTarget, assignRepair, updateRepairJob, countRepairJobs, HEALED } from "./repair.js";
import { updateCombat, updateBuildingCombat, updateWorkerCombat } from "./combat.js";
import { updateBombFuse, updateCraters } from "./bomb.js";
import { updateWreckage } from "./wreckage.js";
import { updateBuildingConstruction, updateProductionQueue, BUILD_REACH } from "./production.js";
import { updateUnitRecycle, updateBuildingRecycle } from "./recycle.js";
import { updateProduction, updateCombustors } from "./industry.js";
import { updatePlasmaRig } from "./rig.js";
import { updateResearch } from "./techtree.js";
import { updateWonder } from "./wonder.js";
import { applySeparation } from "./separation.js";
import { updateFog } from "./fog.js";
import { UNITS, BUILDINGS, canLogisticsType } from "./entities.js";
import { getEntity } from "./state.js";
import { checkWinCondition, checkEndlessLoss, checkEndlessWin } from "./victory.js";
import { runAI } from "./ai.js";
import { isHumanControlled } from "./aiCommon.js";
import { updateScenario } from "./scenarios.js";
import { updateMarket } from "./market.js";
import { updateDiplomacy } from "./diplomacy.js";

export function tick(state, dt) {
  if (state.over) return;

  // Scenario mode drives the convoy/piracy/objective itself; the skirmish
  // economy AI only runs in a normal match (see engine/scenarios.js).
  if (state.scenario) updateScenario(state, dt);
  else runAI(state, dt);

  // Broad-phase spatial index for this tick, shared by movement avoidance,
  // combat acquisition, and the separation pass below (see engine/grid.js).
  state.unitGrid = buildUnitGrid(state);
  // Per-node miner count for this tick, read by gather.js's saturation falloff.
  // Frozen before any worker mines so every miner on a node sees the same count
  // regardless of Map iteration order (determinism).
  countMiners(state);
  // Per-drop hauler lists for this tick, frozen alongside the miner counts above and for
  // the same reason: every worker banking at one drop must see the same crew list.
  countDockers(state);
  // Per-building hauler/supplier counts for this tick, frozen before any idle worker is
  // assigned a logistics job below — so the "≤2 per building" caps read the same regardless
  // of Map iteration order (determinism). A no-op in skirmish: nothing there has a buffer.
  countLogistics(state);
  // Settle the fuel-burning Generators' Power BEFORE any consumer reads powerCap this tick,
  // so the grid a factory/rig sees is stable. A no-op without a Combustion Generator.
  updateCombustors(state, dt);
  // Per-building count of auto-repair Menders already committed to it, frozen before any Mender
  // re-targets below — so they SPREAD OUT (one per building) instead of all piling on the worst one.
  countMenderTargets(state);
  // Per-building count of workers already assigned to REPAIR it this tick, frozen before any idle
  // worker claims a fresh repair job below — the ≤MAX_REPAIRERS cap (engine/repair.js), same shape
  // as countLogistics above. A no-op wherever nothing is damaged.
  countRepairJobs(state);
  // Aura projectors (Aegis) for this tick, read by combat.js attackDamage. Collected
  // once here (a tiny list — the units are Tier-3 and rare) so a landed hit costs O(anvils)
  // not O(units); positions are frozen at tick start like the grid above (deterministic).
  collectAnvils(state);

  for (const unit of state.units.values()) updateUnit(state, unit, dt);
  applySeparation(state, dt);
  // T-018/ADR-0008: this used to be two hardcoded calls (player/ai) — a 3rd owner spliced into
  // state.owners would silently never get its fog updated, a desync landmine no error would catch.
  // Iterating state.owners is what engine/state.js's own createGameState already does at creation.
  for (const owner of state.owners) updateFog(state, state.fogs[owner], owner);   // each side sees only what its own units/buildings reveal
  for (const building of state.buildings.values()) {
    updateBuildingConstruction(state, building, dt);
    updateProductionQueue(state, building, dt);
    updateProduction(state, building, dt);   // Odyssey factories refine raw hauls into goods (no-op without a recipe)
    updatePlasmaRig(state, building, dt);    // Odyssey Plasma Rig digs raw materials from the core (no-op without a rig def)
    updateResearch(state, building, dt);     // Odyssey Datacenter develops the tech tree (no-op for any other building)
    updateWonder(state, building, dt);       // Odyssey Antimatter Gate charges toward the galaxy win (no-op off a wonder)
    if (state.endless && !state.background) updateDecay(building, dt);   // Odyssey structures wear out if not mended
    updateBuildingCombat(state, building, dt);
    updateBuildingRecycle(state, building, dt);   // last: may remove the building this tick (engine/commands.js issueRecycle)
  }

  // Healing runs last, once every combatant and building has taken its damage
  // for the tick, so a Mender patches the freshest wounds (see repair.js).
  updateRepair(state, dt);
  // Bulwark doctrine regen (engine/repair.js) — same "after this tick's combat" timing as the
  // Mender pass above, so a unit hit THIS tick (lastHitAt just stamped to the still-current
  // state.time, below) never regens on that same tick. A no-op for any player without the
  // doctrine researched, so games without it stay byte-identical.
  updateBulwarkRegen(state, dt);

  // Scenario mode settles its own win/lose inside updateScenario; Odyssey
  // (endless) only ends on losing the player's Command Center; a normal match
  // uses the CC/score victory check.
  if (state.scenario) { /* updateScenario already set state.over if finished */ }
  // checkEndlessWin runs on EVERY endless world, background included — a rival Gate (Phase 7)
  // usually completes on a colony the player has left, not the active seat, and its AI-owned
  // branch only ever pushes a galaxy event (never finish()), so running it in the background is
  // harmless there. checkEndlessLoss stays active-world-only as before: it already no-ops for
  // every galaxy world via state.inGalaxy, so this scoping only ever matters to a standalone
  // endless test fixture, and a colony (background) is never "over" regardless.
  else if (state.endless) { checkEndlessWin(state); if (!state.background) checkEndlessLoss(state); }
  else checkWinCondition(state);

  if (state.market) updateMarket(state, dt);       // Odyssey: relax trade pressure back toward equilibrium
  if (state.diplomacy) updateDiplomacy(state, dt);  // Odyssey: drift the neighbour's stance with scarcity
  state.time += dt;
  state.tick++;
  // A Helium Bomb crater (engine/bomb.js) matures on its own schedule, independent of any
  // unit/building — checked once per tick against the just-advanced state.time.
  updateCraters(state);
  // Battle wreckage (engine/wreckage.js) matures the same way, on its own schedule.
  updateWreckage(state);
}

// Collect this tick's aura projectors — units with a guardAura (the Aegis) AND buildings with one
// (the Aegis Bastion, entities.js) — into a flat list on the state, so combat.js can look up "is
// this target inside a friendly aura" against a handful of entries instead of scanning every unit
// per hit. Transient (never serialized), rebuilt each tick from live positions — deterministic.
// Exported so combat-only test harnesses (which drive updateCombat directly, bypassing tick) can
// build the same list before a fight.
export function collectAnvils(state) {
  const out = [];
  for (const u of state.units.values()) {
    const g = UNITS[u.type]?.guardAura;
    if (g && u.hp > 0) out.push({ id: u.id, owner: u.owner, x: u.x, y: u.y, range: g.range, mult: g.damageTakenMult });
  }
  // The static guard-aura projector: same {id,owner,x,y,range,mult} shape as the units pass
  // above, so combat.js's anvilAura (already target-kind-agnostic — it reads target.owner/id,
  // never target.kind) needs zero changes to pick these up too. Skips a still-constructing one
  // (no aura until it's actually finished standing).
  for (const b of state.buildings.values()) {
    const g = BUILDINGS[b.type]?.guardAura;
    if (g && b.hp > 0 && !b.constructing) out.push({ id: b.id, owner: b.owner, x: b.x, y: b.y, range: g.range, mult: g.damageTakenMult });
  }
  state.anvils = out;
}

// Tally how many workers (both sides) are assigned to gather each node this
// tick — the single source of truth for gather.js's saturation efficiency.
// Counts every worker on a `gather` order, not just those physically at the
// rock, so the "~3 workers per node" rule reads by intent rather than by who
// happens to be mid-haul. Recomputed from scratch each tick — never accumulates.
function countMiners(state) {
  for (const n of state.map.nodes) { n.miners = 0; n.minerIds = null; }
  for (const u of state.units.values()) {
    const o = u.order;
    if (o && o.type === "gather") {
      const n = state.map.nodesById ? state.map.nodesById.get(o.nodeId) : null;
      if (n) { n.miners++; (n.minerIds || (n.minerIds = [])).push(u.id); }
    }
  }
  // Sorted so a node's crew list — and with it every worker's ring slot in
  // gather.js — reads the same regardless of state.units' Map order. Plain string
  // order: it only has to be STABLE, not meaningful.
  for (const n of state.map.nodes) if (n.minerIds) n.minerIds.sort();
}

// Tally which haulers are inbound to each drop-off this tick, the drop-side twin of
// countMiners above: gather.js hands out evenly spaced docking spots around a drop from
// this list, so a crowd banking at one Command Center rings it instead of converging on
// its exact centre. Reads order.dropId, which gather.js's own toDrop branch stamps when
// it picks the nearest drop — so a worker's first tick in toDrop has no slot yet and
// takes crewSlot's lone-worker fallback, which is correct: it isn't there yet.
function countDockers(state) {
  for (const b of state.buildings.values()) b.dockerIds = null;
  for (const u of state.units.values()) { if (u.dockerIds) u.dockerIds = null; }
  for (const u of state.units.values()) {
    const o = u.order;
    if (!o || o.type !== "gather" || o.phase !== "toDrop" || !o.dropId) continue;
    const drop = state.buildings.get(o.dropId) || state.units.get(o.dropId);
    if (drop) (drop.dockerIds || (drop.dockerIds = [])).push(u.id);
  }
  for (const b of state.buildings.values()) if (b.dockerIds) b.dockerIds.sort();
  for (const u of state.units.values()) if (u.dockerIds) u.dockerIds.sort();
}

function updateUnit(state, unit, dt) {
  // Whenever the active order finishes (arrival, target killed, node drained),
  // pull in the next queued waypoint before anything else runs this tick
  // — so a completed step flows straight into the next, and a combat unit only
  // falls back to auto-acquiring once its whole chain is exhausted.
  if (!unit.order && unit.orderQueue && unit.orderQueue.length) {
    unit.order = unit.orderQueue.shift();
    // A patrol leg (engine/commands.js issuePatrol) loops forever: the instant it's pulled off
    // the queue and made active, requeue it at the tail too, so once THIS leg completes and the
    // next one is pulled, this one is already waiting to come back around. The very FIRST leg of
    // a fresh patrol never passes through here at all (issuePatrol places it directly into
    // `order`, same as any other plain command) — issuePatrol gives it the equivalent trailing
    // copy by hand for exactly that reason, so every leg ends up with one "next occurrence"
    // queued behind it and the whole chain cycles instead of draining to idle.
    if (unit.order.patrol) unit.orderQueue.push(unit.order);
  }

  const def = UNITS[unit.type];
  // Belt-and-suspenders: persist.js's cleanEntity already strips any unit with an
  // unknown type before it reaches state.units on load (test/save-hardening.test.js),
  // so def is always populated today. This just guards a future entity source that
  // might bypass that path, matching the same "if (!def) skip" style repair.js uses
  // for mender defs above.
  if (!def) return;
  // A unit the player is Recycling (engine/commands.js issueRecycle) is on its own countdown,
  // checked before anything else this tick — same "takes no further orders" precedent as the bomb
  // fuse right below, and before the role dispatch so EVERY role (worker, combat, support, a
  // freighter, …) is covered by the one check rather than needing it threaded into each branch.
  if (updateUnitRecycle(state, unit, dt)) return;
  if (def.role === "combat") { updateCombat(state, unit, dt); return; }
  if (def.role === "support") { updateSupport(state, unit, def, dt); return; }
  // An ARMED Helium Bomb lights its fuse the instant a live enemy comes within
  // range (or the player triggers it directly) and detonates BOMB_FUSE_DELAY
  // sim-seconds later — checked before anything else this tick. Once fused it
  // takes no further orders; once it actually goes off, there's nothing left
  // to update (it's no longer in state.units).
  if (def.role === "bomb" && updateBombFuse(state, unit)) return;

  // A COLLECTION-POINT freighter (`unit.collectPoint`, HUD toggle — no research needed) that's
  // idle and full offers itself a SHUTTLE run: drive to the Command Center, bank the whole hold,
  // drive back to its anchor (engine/haul.js assignShuttle/updateFreighterShuttle). Checked before
  // the AI-logistics offer below so a full collection-point freighter always empties itself first.
  if (!unit.order && def.role === "freighter" && isHumanControlled(state, unit.owner) && unit.collectPoint) {
    assignShuttle(state, unit);
  }
  // Toggling collection-point mode off mid-run stands the freighter down immediately, same as
  // AI-logistics below — whatever's in its hold just sits there until reassigned.
  if (unit.order && unit.order.type === "shuttle" && !unit.collectPoint) { unit.order = null; }

  // An idle Odyssey worker with nothing queued offers itself for logistics: FIRST it offers to
  // ferry a nearby COLLECTION-POINT freighter (`assignFerry`) — checked ahead of haul/service
  // because ferry and haul share the SAME per-producer ≤MAX_HAULERS cap (engine/haul.js
  // countLogistics). If plain CC-bound haulers got first refusal, a busy rig's two slots would
  // always go to them as workers cycle through, and a collection-point freighter parked right next
  // to it would never actually get fed — exactly the "workers don't see it" gap this priority
  // avoids. THEN it clears a pure producer's backed-up output to a Command Center (haul — the Rig,
  // the drop-offs), else it runs a factory a round-trip service (carry inputs in, output back).
  // Human-controlled seats only (T-017/ADR-0008 — isHumanControlled, never a hardcoded owner
  // literal): the scripted AI builds no producers/factories and runs its own dedicated economy
  // logic elsewhere, so it never needs this idle-worker self-assignment convenience, but ANY
  // seat a human is actually driving gets it, not just literally "player".
  //
  // A freighter the player has toggled into AI-logistics mode (`aiLogistics`, HUD button — requires
  // the FREIGHTER_AI_TECH research) offers itself the haul/service way too (never ferry — a
  // freighter doesn't ferry another freighter), at its own far larger cargo capacity (engine/
  // haul.js tripCapacity) — the order it lands is stamped `aiJob` so the upkeep check below knows
  // to bill it. Regular freighters (aiLogistics off) are untouched — fully player-controlled, same
  // as before. Claiming a NEW job also requires at least SOME AI Cores in stock: a freighter that
  // can't afford to move shouldn't still reserve one of a producer's scarce ≤MAX_HAULERS slots
  // doing nothing — an already-running job is a separate case, handled by the upkeep check below,
  // which pauses it in place rather than dropping it the instant the treasury dips dry.
  const aiFreighter = def.role === "freighter" && isHumanControlled(state, unit.owner) && unit.aiLogistics
    && !!state.players[unit.owner].upgrades[FREIGHTER_AI_TECH]
    && (state.players[unit.owner].resources.ai || 0) > 0;
  if (!unit.order && canLogisticsType(unit.type) && isHumanControlled(state, unit.owner)) {
    assignFerry(state, unit);
  }
  if (!unit.order && (canLogisticsType(unit.type) || aiFreighter) && isHumanControlled(state, unit.owner)) {
    assignHaul(state, unit);
    if (!unit.order) assignService(state, unit);
    if (unit.order && aiFreighter) unit.order.aiJob = true;
  }
  // Still nothing to do: a worker (not a freighter — patching a hull isn't a cargo run) offers
  // itself to REPAIR the own damaged building most in need, zone-first like haul/service (engine/
  // repair.js assignRepair). Checked last so an economy job always outranks a repair, matching the
  // ferry > haul > service priority above — a stalled factory needs labour more urgently than a
  // building that's merely below full HP. Fixed by T-017 (ADR-0008): this used to be gated on
  // unit.owner === "player", so a human driving the OTHER seat never got auto-repair at all — a
  // material economic edge in a skirmish where base damage is routine.
  if (!unit.order && canLogisticsType(unit.type) && isHumanControlled(state, unit.owner)) {
    assignRepair(state, unit);
  }

  if (!unit.order) return;

  // An autonomous freighter's job burns AI Cores from the treasury every tick it's active
  // (engine/haul.js payAIUpkeep). Toggling AI-logistics off mid-job stands it down immediately (its
  // cargo, if any, just sits aboard until reassigned); running dry of AI Cores pauses it in place
  // for the tick — nothing lost, it resumes the moment the treasury can cover it again. A plain
  // worker's order never carries `aiJob`, so this is a no-op for the whole worker roster.
  if (unit.order.aiJob) {
    if (!unit.aiLogistics || !state.players[unit.owner].upgrades[FREIGHTER_AI_TECH]) { unit.order = null; return; }
    if (!payAIUpkeep(state, unit, dt)) return;
  }

  switch (unit.order.type) {
    case "move":
    // A non-combat/non-support role (today: only "scout", the Ranger) reaches an "attack-move"
    // order here rather than through combat.js's updateCombat (role "combat" only) — the patrol
    // order (engine/commands.js issuePatrol) is gated to combat/scout roles alike, and a scout
    // never auto-acquires regardless of order type (that's entirely role-gated, in updateCombat),
    // so for it "attack-move" just means "get there", identically to a plain move.
    case "attack-move": {
      const arrived = stepToward(state, unit, unit.order.x, unit.order.y, orderedSpeed(def.speed, unit.order), dt);
      if (arrived) unit.order = null;
      break;
    }
    case "gather":
      updateGather(state, unit, dt);
      break;
    case "haul":
      updateHaul(state, unit, dt);
      break;
    case "service":
      updateService(state, unit, dt);
      break;
    case "ferry":
      updateFerry(state, unit, dt);
      break;
    case "repair":
      updateRepairJob(state, unit, dt);
      break;
    case "shuttle":
      updateFreighterShuttle(state, unit, dt);
      break;
    case "escort":
      // A non-combat escort (worker) just keeps station on the ring around the guarded ship.
      keepEscortStation(state, unit, def.speed, dt);
      break;
    case "hold-formation":
      // A non-combat formation LEADER (worker, freighter) holds its own fixed anchor.
      keepFormationStation(state, unit, def.speed, dt);
      break;
    case "follow-leader":
      // A non-combat formation FOLLOWER just keeps its slot relative to the leader.
      keepFollowingLeader(state, unit, def.speed, dt);
      break;
    case "scout":
      updateScoutMode(state, unit, dt);
      break;
    case "attack":
      // Workers only reach here on an explicit attack order (combat units are
      // handled by updateCombat above); they close in and fight weakly.
      updateWorkerCombat(state, unit, def, dt);
      break;
    case "build": {
      const b = state.buildings.get(unit.order.buildingId);
      if (!b) { unit.order = null; break; }
      const dist = Math.hypot(b.x - unit.x, b.y - unit.y);
      if (dist > BUILD_REACH) stepToward(state, unit, b.x, b.y, def.speed, dt);
      else if (!b.constructing) unit.order = null;
      break;
    }
    // Any order type this non-combat/non-support unit can't act on (e.g. a "gather"
    // order that reached a freighter) is dropped rather than left to stick forever
    // and wedge the unit's whole order queue. No valid caller hits this today.
    default:
      unit.order = null;
  }
}

// Odyssey structures WEAR OUT: a completed building sheds a small fraction of its max HP per second,
// down to a floor (neglect weakens it but never razes it — combat still can). A Mender's passive
// repair (repair.js) out-heals this easily, so keeping a mender on the base is real upkeep. Gentle
// and deterministic; only in Odyssey (a skirmish is short and its byte-identical replay is untouched).
const DECAY_FRAC = 0.0006;  // HP shed per second as a share of maxHp — a gentle, long-game wear (~18 min to the floor)
const DECAY_FLOOR = 0.35;   // …never below this share from wear alone
function updateDecay(building, dt) {
  if (building.constructing) return;
  const floor = building.maxHp * DECAY_FLOOR;
  if (building.hp <= floor) return;
  building.hp = Math.max(floor, building.hp - building.maxHp * DECAY_FRAC * dt);
}

// Support-role units (the Mender) carry no weapon — the actual healing is the
// global updateRepair pass in repair.js. All this does is MOVE them, so the
// player can position the drone: a plain move/attack-move goes to the point;
// an 'attack' order (should one ever be issued — input.js won't, since a Mender
// has no attack stat) is reinterpreted as "go to that foe" so the drone can be
// pushed toward a fight to mend the units in it, and it never deals damage.
function updateSupport(state, unit, def, dt) {
  const o = unit.order;
  // Idle + AUTO-REPAIR on: roam to the nearest damaged friendly so the drone actively maintains
  // the base/army instead of sitting still (the passive repair pass heals it once in reach).
  if (!o) { if (unit.autoRepair) autoRepairRoam(state, unit, def, dt); return; }
  // A support escort (Mender) trails the guarded ship in formation, mending whatever's near it
  // via the global repair pass — a medic keeping station on the fleet it's protecting.
  if (o.type === "escort") {
    keepEscortStation(state, unit, def.speed, dt);
    return;
  }
  // Holding a defensive formation: same idea, station-keeping at its own fixed anchor instead
  // of a moving target — the drone mends whatever's near it (the repair pass) right where it stands.
  if (o.type === "hold-formation") {
    keepFormationStation(state, unit, def.speed, dt);
    return;
  }
  // Following a formation leader: keeps its slot relative to the leader's LIVE position.
  if (o.type === "follow-leader") {
    keepFollowingLeader(state, unit, def.speed, dt);
    return;
  }
  let tx, ty, follow = false, speed = def.speed;
  if (o.type === "attack") {
    const t = getEntity(state, o.targetId);
    if (!t || t.hp <= 0) { unit.order = null; return; }
    tx = t.x; ty = t.y; follow = true;   // keep chasing a moving foe rather than stopping on arrival
  } else if (o.type === "move" || o.type === "attack-move") {
    tx = o.x; ty = o.y; speed = orderedSpeed(def.speed, o);
  } else {
    unit.order = null; return;   // gather / scout / build are meaningless for a drone
  }
  const arrived = stepToward(state, unit, tx, ty, speed, dt);
  if (arrived && !follow) unit.order = null;
}

// How many auto-repair Menders are already committed to each BUILDING this tick — frozen before any
// re-targets, so the "one Mender per building" cap reads the same regardless of Map order. Only
// buildings are capped (the pile-up the player hit); a wounded unit can still draw several menders.
// Transient (stripped on serialize). A no-op when no Mender is in auto-repair mode.
function countMenderTargets(state) {
  for (const b of state.buildings.values()) b.menderClaims = 0;
  for (const u of state.units.values()) {
    if (!u.autoRepair || !u.repairTargetId) continue;
    const t = state.buildings.get(u.repairTargetId);
    if (t) t.menderClaims = (t.menderClaims || 0) + 1;
  }
}

// An auto-repair Mender roams to the friendly that needs it MOST. Hysteresis kills the ping-pong:
// it only gets ATTRACTED to something worn past NEEDS_REPAIR, and once it commits it STAYS on that
// target until it's topped past HEALED — so a full building nicked by a hair of wear can't yank the
// drone back and forth. Picking a NEW target (engine/repair.js pickRepairTarget) is zone-first (a
// damaged building/unit in the Mender's own Command Center zone wins over a nearer one belonging
// to another base — engine/gather.js zoneFirst) and, within a zone, most-worn-first, distance
// breaking ties. A BUILDING already claimed by another auto-repair Mender is skipped, so the drones
// spread out one per building instead of dogpiling the worst one. Deterministic; drone parks when
// nothing qualifies.
function autoRepairRoam(state, mender, def, dt) {
  const range = def.repairRange || 100;
  const ownFriendly = e => e && e.owner === mender.owner && e.hp > 0 && !e.constructing;

  // Keep the current target while it still needs work (hysteresis) — don't drop it for a
  // marginally-worse one, and don't re-grab a just-topped-up one on its first hair of decay.
  let target = mender.repairTargetId
    ? (state.buildings.get(mender.repairTargetId) || state.units.get(mender.repairTargetId))
    : null;
  if (!(ownFriendly(target) && target !== mender && target.hp < target.maxHp * HEALED)) target = null;

  if (!target) {   // pick the MOST worn eligible friendly below the attract threshold, own zone first
    target = pickRepairTarget(state, mender.owner, mender.x, mender.y, {
      exclude: mender,
      isClaimed: e => e.kind === "building" && (e.menderClaims || 0) >= 1,   // one Mender per building
      homeId: mender.homeCC,
    });
    if (target && target.kind === "building") target.menderClaims = (target.menderClaims || 0) + 1;   // claim it for the rest of this tick
  }

  mender.repairTargetId = target ? target.id : null;
  if (target && Math.hypot(target.x - mender.x, target.y - mender.y) > range * 0.7)
    stepToward(state, mender, target.x, target.y, def.speed, dt);
}
