// @ts-check
/* ============================================================
   Recycling: the player can scrap an OWNED, completed building or a unit to
   reclaim part of what it cost. Not instant — like construction, it runs a
   timer in place (engine/commands.js issueRecycle starts it, updateUnitRecycle/
   updateBuildingRecycle below tick it down from sim.js) so scrapping something
   under fire is a real risk, not a free undo button: the target stays fully
   itself and fully targetable the whole time, it just can't act (a unit) or
   ever be re-recycled (either) until the timer completes or the player cancels
   it (engine/commands.js issueCancelRecycle) — cancelling is free, since nothing
   was ever paid or disabled beyond that.

   The refund fraction is 40% for ordinary stock, or 50% for pricier
   industrial/capital assets — the "depends on type" half of the ask — then
   boosted by research up to an 80% cap: the SAME upgrade id ("recycling") in
   both the skirmish doctrine tree (engine/entities.js UPGRADES, Logistics tier
   3, researched at a Refinery) and the Odyssey tech tree (engine/techtree.js
   TECHS, researched at a Datacenter) — whichever mode you're in stamps the same
   flag in player.upgrades, so recycleFrac only ever needs to check the one id,
   the same way FREIGHTER_AI_TECH is read directly rather than through a
   generic multiplier (engine/haul.js).

   That fraction applies to the build COST only. Whatever inventory the entity is
   physically holding when it finishes recycling — a factory's input larder and
   output backlog, a freighter's freight hold, a worker's carried cargo — is
   recovered in FULL (recycleValue below), separately: that stock was already
   gathered/produced, not spent constructing the thing, so scrapping it shouldn't
   also erase whatever it happened to be carrying.
   ============================================================ */

"use strict";

import { UNITS, BUILDINGS } from "./entities.js";
import { removeEntity } from "./state.js";

export const RECYCLE_TECH = "recycling";

const BASE_FRAC = 0.4;
const ADVANCED_FRAC = 0.5;
const TECH_BONUS = 0.3;
const FRAC_CAP = 0.8;

// A little more than half the entity's own build time to scrap it — quicker to tear down than
// put up, same call most demolition mechanics make — floored so even the cheapest worker isn't a
// free instant cash-out.
const MIN_RECYCLE_TIME = 3;
const RECYCLE_TIME_FRAC = 0.5;

// A building counts as "advanced" by the exact same signal isElectrifiable already uses to mark
// it as real industrial/strategic infrastructure rather than a basic shell: it runs a recipe,
// grants Power, digs a rig, is the endgame wonder, or burns fuel (Combustion Generator).
function isAdvancedBuilding(def) {
  return !!(def.recipe || def.energyGrants || def.rig || def.wonder || def.combust);
}

// A unit counts as "advanced" if it's a big capital asset — a cargo freighter or a support
// Mender — rather than disposable line troops or plain labour.
function isAdvancedUnit(def) {
  return def.role === "freighter" || def.role === "support";
}

function defOf(entity) {
  return entity.kind === "building" ? BUILDINGS[entity.type] : UNITS[entity.type];
}

/** The fraction (0.4-0.8) of `entity`'s cost recycling it refunds right now, for its owner.
 * @param {State} state @param {string} owner @param {Unit|Building} entity @returns {number} */
export function recycleFrac(state, owner, entity) {
  const def = defOf(entity);
  if (!def) return 0;
  const advanced = entity.kind === "building" ? isAdvancedBuilding(def) : isAdvancedUnit(def);
  const base = advanced ? ADVANCED_FRAC : BASE_FRAC;
  const researched = !!state.players[owner]?.upgrades[RECYCLE_TECH];
  return Math.min(FRAC_CAP, researched ? base + TECH_BONUS : base);
}

// A Command Center can't be recycled — scrapping your only (or, mid-Odyssey, any) base for parts
// is a footgun with no play value, unlike everything else, which is a real, rebuildable choice.
/** @param {Unit|Building} entity @returns {boolean} */
export function canRecycle(entity) {
  const def = defOf(entity);
  if (!def || entity.recycling) return false;
  if (entity.kind === "building") return !entity.constructing && !def.isCommandCenter;
  return true;
}

// Start recycling `entity` in place. Pure state mutation — engine/commands.js's issueRecycle
// checks canRecycle and handles the unit-order-dispatch side (squad release, clearing Hold)
// before calling this. Ownership is issueRecycle's own job (T-019/FR-10: it used to claim that
// here without actually doing it — canRecycle never checked owner at all).
/** @param {Unit|Building} entity @returns {void} */
export function beginRecycle(entity) {
  const def = defOf(entity);
  const time = Math.max(MIN_RECYCLE_TIME, (def.buildTime || 0) * RECYCLE_TIME_FRAC);
  entity.recycling = { progress: 0, time };
  if (entity.kind === "unit") { entity.order = { type: "recycle" }; entity.orderQueue = []; }
}

// Cancel an in-progress recycle — free: the target was never disabled beyond refusing new orders
// (a building) or acting at all (a unit), so this just drops the timer, no partial refund.
/** @param {Unit|Building} entity @returns {void} */
export function cancelRecycle(entity) {
  entity.recycling = null;
  if (entity.kind === "unit" && entity.order?.type === "recycle") entity.order = null;
}

// Every commodity a recycle would return RIGHT NOW, merged into one commodity→qty map: the
// type/research-scaled fraction of its build cost (recycleFrac), PLUS every bit of its own
// current inventory at full (1:1) value — a factory's input larder and output backlog
// (engine/haul.js), a freighter's freight hold, a worker's carried cargo. That inventory is stock
// the player already gathered or produced, sitting in the thing being scrapped rather than spent
// on building it, so recycling recovers all of it rather than letting it vanish with the
// structure. The single source of truth for both the actual bank (below) and the HUD's refund
// preview (hudSelection.js), so the two can never drift apart.
/** @param {State} state @param {Unit|Building} entity @returns {Resources} */
export function recycleValue(state, entity) {
  const def = defOf(entity);
  const out = /** @type {Resources} */ ({});
  const add = (com, qty) => { if (com && qty > 0) out[com] = (out[com] || 0) + qty; };
  if (def?.cost) {
    const frac = recycleFrac(state, entity.owner, entity);
    for (const [com, qty] of Object.entries(def.cost)) add(com, qty * frac);
  }
  const addBuffer = buf => { if (buf) for (const com in buf) add(com, buf[com] || 0); };
  // Probe all four inventory buffers off ONE widened reference rather than narrowing by
  // entity.kind: a Building carries store/input, a Unit carries freight/cargo, and addBuffer
  // ignores whichever are absent. Keeping it a single unconditional pass means a future entity
  // type that carries both still refunds both — narrowing by kind would silently skip one.
  const inv = /** @type {{store?: Resources, input?: Resources, freight?: Resources, cargo?: Cargo}} */ (entity);
  addBuffer(inv.store);
  addBuffer(inv.input);
  addBuffer(inv.freight);
  if (inv.cargo) add(inv.cargo.com, inv.cargo.qty || 0);
  return out;
}

function grantRecycleValue(state, entity) {
  const res = state.players[entity.owner].resources;
  for (const [com, qty] of Object.entries(recycleValue(state, entity))) res[com] = (res[com] || 0) + qty;
}

/** Advance a recycling BUILDING by dt — called from sim.js's per-building loop. A no-op unless
 * it's actually recycling; removes + refunds it once the timer completes.
 * @param {State} state @param {Building} building @param {number} dt @returns {void} */
export function updateBuildingRecycle(state, building, dt) {
  if (!building.recycling) return;
  building.recycling.progress += dt / building.recycling.time;
  if (building.recycling.progress >= 1) {
    grantRecycleValue(state, building);
    removeEntity(state, building.id);
    state.events.push({ type: "recycled", x: building.x, y: building.y, owner: building.owner });
  }
}

/** Advance a recycling UNIT by dt. Called early from sim.js's updateUnit, same convention as
 * updateBombFuse: returns true whenever the unit is mid-recycle (so the caller skips every other
 * per-tick behaviour — movement, combat, gather, haul — for it this tick), false otherwise.
 * @param {State} state @param {Unit} unit @param {number} dt @returns {boolean} */
export function updateUnitRecycle(state, unit, dt) {
  if (!unit.recycling) return false;
  unit.recycling.progress += dt / unit.recycling.time;
  if (unit.recycling.progress >= 1) {
    grantRecycleValue(state, unit);
    removeEntity(state, unit.id);
    state.events.push({ type: "recycled", x: unit.x, y: unit.y, owner: unit.owner });
  }
  return true;
}
