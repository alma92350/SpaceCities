// @ts-check
/* ============================================================
   Autonomous scout mode for the Ranger (order type "scout"): range the
   map on its own, always heading for the nearest unexplored ground, so
   one click sends a scout off to chart the map instead of the player
   hand-walking it waypoint by waypoint.

   It heads for the nearest never-explored cell (its own owner's fog). Its
   long sight reveals that ground as it approaches, so the target flips to
   explored and it re-picks the next-nearest dark cell — the effect is a
   frontier that expands outward from home until the map is charted. Once
   nothing is left unexplored it patrols a fixed circuit of the map's
   quadrants, keeping vision fresh rather than freezing in place.

   Persistent: the "scout" order is never cleared by arrival (there's no
   single destination), so it keeps exploring until the player re-orders the
   unit (a move/attack/stop replaces it). Deterministic throughout — the
   target comes from a row-major fog scan, no rng — so it's safe in the sim.

   A Ranger LEADING a formation (engine/commands.js issueScout) picks the same frontier targets
   but travels at the group's pace (order.speedCap) rather than its own full speed, so its
   escorts — still on their ordinary follow-leader order — can keep up: a protective scout
   leading the pack into the fog, not a lone unit racing off alone.
   ============================================================ */

"use strict";

import { stepToward, orderedSpeed } from "./movement.js";
import { UNITS } from "./entities.js";
import { nearestUnexploredPoint, isExploredAt } from "./fog.js";

const REACH = 6;   // close enough to a scout waypoint to count as arrived and re-pick

// A coarse patrol circuit for when the whole map is already charted: the four
// quadrant centres, walked in a loop so the scout keeps sweeping for fresh
// intel (enemy movements) instead of parking. Fractions of the map dims.
const PATROL = [[0.25, 0.25], [0.75, 0.25], [0.75, 0.75], [0.25, 0.75]];

/** @param {State} state @param {Unit} unit @param {number} dt @returns {void} */
export function updateScoutMode(state, unit, dt) {
  const def = UNITS[unit.type];
  const fog = state.fogs[unit.owner];
  const order = unit.order;

  // Re-pick a target when we have none, we've reached it, or our own sight has
  // since revealed it (so we always chase ground that's still dark).
  const need = order.tx == null
    || Math.hypot(order.tx - unit.x, order.ty - unit.y) <= REACH
    || (fog && order.explore && isExploredAt(fog, order.tx, order.ty));
  if (need) {
    const spot = fog ? nearestUnexploredPoint(fog, unit.x, unit.y) : null;
    if (spot) {
      order.tx = spot.x; order.ty = spot.y; order.explore = true;
    } else {
      // Nothing left to discover — walk a patrol circuit to keep vision fresh.
      // `patrolLeg`, NOT `patrol`: engine/commands.js issuePatrol stamps `patrol: true` as a boolean
      // "requeue me" flag that engine/sim.js reads off orderQueue, so storing a circuit INDEX under
      // the same name is a shape-dependent collision — leg 0 is falsy (no requeue), legs 1-3 are
      // truthy (infinite requeue of the same order object). Latent only because issueScout writes
      // u.order directly and clears orderQueue; both commands are gated to role === "scout", so the
      // Ranger is the one unit that can hold either kind of order.
      order.patrolLeg = ((order.patrolLeg ?? -1) + 1) % PATROL.length;
      const [fx, fy] = PATROL[order.patrolLeg];
      order.tx = (state.map?.width || 0) * fx;
      order.ty = (state.map?.height || 0) * fy;
      order.explore = false;
    }
  }
  stepToward(state, unit, order.tx, order.ty, orderedSpeed(def.speed, order), dt);
}
