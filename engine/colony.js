// @ts-check
/* ============================================================
   COLONY SHIP (Odyssey) — the mobile seed of a base. In the open world both sides
   START with a colony ship instead of a placed Command Center, and found every new
   base by building a ship, moving it to the site, and DEPLOYING it in place. Deploy
   is an instant, pure state mutation (like engine/galaxy.js upgradeToCapital): it
   validates the footprint, consumes the ship, and mints a COMPLETED Command Center
   plus the colonists that ride in — so ship→CC is atomic (no "foothold gap" for the
   loss/domination checks, engine/victory.js + engine/galaxy.js).

   Odyssey-only by construction: the colonyship unit is `odysseyOnly` and never
   instantiated in a skirmish, so this module is inert there. Deterministic and
   DOM-free — no wall-clock, no unseeded randomness.
   ============================================================ */

"use strict";

import { makeBuilding, makeUnit, removeEntity } from "./state.js";
import { canPlaceBuilding } from "./colliders.js";
import { canAfford, payCost } from "./entities.js";
import { cancelProduction } from "./production.js";

// Colonists that disembark when a colony ship deploys — matches the classic opening
// crew, and gives every founded base an immediate starter economy. A balance knob.
export const COLONY_SHIP_WORKERS = 3;

// Deploy a colony ship into a COMPLETED Command Center at its current position:
// validate the footprint (strictly — the CC lands exactly where the ship is parked,
// so move to clear ground and retry rather than sliding), consume the ship, spawn the
// finished CC (fresh id) and its disembarking workers. Instant + pure — no clock/RNG,
// so it replays identically. Returns the new CC's id, or null if it couldn't deploy.
/**
 * @param {State} state
 * @param {string} shipId
 * @returns {string|null} the new Command Center's id, or null if nothing was deployed
 */
export function deployColonyShip(state, shipId) {
  const ship = state.units.get(shipId);
  if (!ship || ship.type !== "colonyship") return null;
  const { owner, x, y } = ship;
  // canPlaceBuilding ignores units, so the parked ship never blocks its own footprint.
  if (!canPlaceBuilding(state, "command", x, y)) {
    state.events.push({ type: "deployBlocked", x, y, owner });
    return null;
  }
  removeEntity(state, shipId);                        // consume the ship (also drops it from selection)
  const cc = makeBuilding("command", owner, x, y, {}, state);    // no { constructing } ⇒ spawns COMPLETE
  state.buildings.set(cc.id, cc);
  for (let i = 0; i < COLONY_SHIP_WORKERS; i++) {     // colonists disembark — no cost, they rode in
    const w = makeUnit("worker", owner, x + 40 + i * 14, y + 40, state);   // same offsets as state.js seedPlayer
    state.units.set(w.id, w);
  }
  state.events.push({ type: "buildingComplete", x, y, owner });   // reuse the CC-finished sound/vfx
  return cc.id;
}

// Does this owner still hold a colony ship? The single source of truth for the
// "a side with only an undeployed colony ship still has a foothold" rule shared by
// checkEndlessLoss (engine/victory.js) and checkDomination (engine/galaxy.js).
/**
 * @param {State} state
 * @param {string} owner
 * @returns {boolean}
 */
export function hasColonyShip(state, owner) {
  for (const u of state.units.values())
    if (u.owner === owner && u.type === "colonyship") return true;
  return false;
}

// The reverse of deployColonyShip: pack a plain (non-Capital) Command Center back into a
// mobile Colony Ship, so it can walk to a new site and redeploy there — relocating a base on
// the SAME world (distinct from the Spaceport's interplanetary jump, engine/galaxy.js, which
// never moves a building at all). Cheaper than a fresh ship (COLONY_SHIP cost) since it's
// recycling existing infrastructure, but a real cost, not free. Also atomic/instant, for the
// same reason deploy is (see the file header): a player left holding just the resulting ship
// is exactly the "undeployed colony ship still counts as a foothold" case hasColonyShip/
// checkEndlessLoss already cover, so there's no transient "0 CC" loss-condition gap to guard.
export const PACK_COST = { ore: 200 };

/**
 * @param {State} state
 * @param {string} buildingId
 * @returns {string|null} the new colony ship's id, or null if nothing was packed
 */
export function packCommandCenter(state, buildingId) {
  // Odyssey-only, the same hard guarantee issueBuild makes for every odysseyOnly building/unit
  // (engine/commands.js): colonyship is odysseyOnly and skirmish's checkWinCondition has no
  // hasColonyShip grace the way checkEndlessLoss does, so packing a skirmish CC would strip a
  // player's only base with no foothold and no way to ever redeploy it (no deploy UI outside
  // Odyssey either). Checked at the engine level, not just the HUD button's own gating.
  if (!state.endless) return null;
  const cc = state.buildings.get(buildingId);
  // A Capital is permanent by design (engine/galaxy.js upgradeToCapital) — "only a smaller CC
  // relocates." Still-constructing is refused too: nothing to pack up yet.
  if (!cc || cc.type !== "command" || cc.constructing || cc.capital) return null;
  const player = state.players[cc.owner];
  if (!canAfford(player.resources, PACK_COST)) return null;
  // Refund any queued production first — packing shouldn't silently eat resources already
  // paid into a job that'll now never finish (cancelProduction always fully refunds).
  while (cc.queue && cc.queue.length) cancelProduction(state, cc.id, 0);
  payCost(player.resources, PACK_COST);
  const { owner, x, y } = cc;
  removeEntity(state, cc.id);
  const ship = makeUnit("colonyship", owner, x, y, state);
  state.units.set(ship.id, ship);
  state.events.push({ type: "unitSpawned", x, y, owner });   // reuse the normal spawn sound/vfx
  return ship.id;
}
