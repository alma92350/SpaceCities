// @ts-check
/* ============================================================
   The Antimatter Gate — Odyssey's endgame wonder (Phase 3). A `wonder:true`
   building that CHARGES by consuming strategic goods over time; at full charge the
   player wins the galaxy (engine/victory.js checkEndlessWin). This gives the
   endless Odyssey sandbox its first WIN condition — until now it could only be
   lost (checkEndlessLoss).

   Charging draws Power while it runs (industry.js powerDraw), so it TAXES the grid
   — your factories throttle down while the Gate charges, a real "charging costs you
   production" tension that more Reactors / Fusion Containment relieve. The charge
   itself isn't power-gated, though: it proceeds even if a Reactor is sniped (so a
   colony Gate can't be trivially stalled by killing one building). It IS clamped to
   the strategic goods in stock — a starved Gate waits rather than charging on
   nothing, and the stockpile never goes negative. Goods are spent as they're fed,
   so a Gate razed mid-charge costs the whole investment — a fat, defendable
   objective, not a fire-and-forget.

   Odyssey-only and inert-by-construction: the Gate is `odysseyOnly`, the skirmish
   AI never builds it, and updateWonder is a no-op for any building without the
   `wonder` flag — so the byte-identical skirmish path is untouched. Deterministic
   and DOM-free: dt-driven float math, no wall-clock, no unseeded randomness.
   ============================================================ */

"use strict";

import { BUILDINGS } from "./entities.js";

// Advance a charging wonder by dt — a no-op for any building that isn't a completed
// wonder. `charge` is a 0..1 float on the building (persists for free — serPlanet
// serializes whole building objects), so a save mid-charge round-trips and
// continues identically. Reads only building/player state — deterministic.
/**
 * @param {State} state
 * @param {Building} building
 * @param {number} dt seconds of sim time
 * @returns {void}
 */
export function updateWonder(state, building, dt) {
  if (building.constructing) return;
  const def = BUILDINGS[building.type];
  if (!def || !def.wonder) return;
  const feed = def.feed || {};
  const res = state.players[building.owner].resources;

  // Charge fraction this tick — full rate (the Gate's own draw taxes the factories
  // via powerDraw, but the charge itself isn't power-gated, so a sniped Reactor
  // can't stall it), clamped by the scarcest fed good in stock (measured in "full
  // charges' worth", so we never overspend).
  // A FINISHED Gate consumes nothing. Nothing used to stop it: the charge clamped to 1 but the
  // spend didn't, and while a standalone endless game is masked by checkEndlessWin ending the
  // match, a galaxy Gate is explicitly "a milestone, never a win — play forever"
  // (engine/victory.js) with sim.js calling this every tick. So a completed Gate went on burning
  // its feed per sim-second forever, in the three scarcest goods in the game, on the winning line
  // of play — and the Leviathan competes for exactly those three.
  const charge = building.charge || 0;
  if (charge >= 1) return;

  // Cap the step at the charge actually REMAINING, so the final partial tick pays for what it
  // banks rather than for a whole step it only partly used.
  let p = Math.min(dt / def.chargeTime, 1 - charge);
  for (const com in feed) {
    const perCharge = feed[com] * def.chargeTime;
    if (perCharge > 0) p = Math.min(p, (res[com] || 0) / perCharge);
  }
  if (!(p > 0)) return;

  for (const com in feed) res[com] = (res[com] || 0) - p * feed[com] * def.chargeTime;
  building.charge = Math.min(1, charge + p);
  state.events.push({ type: "wonderCharging", charge: building.charge, x: building.x, y: building.y, owner: building.owner });
}

// `owner`'s charging wonder on this world, or null — a completed wonder-flagged building
// partway to full charge. Generalized (Phase 7 "the rival Gate") from what used to be a
// player-only scan, since updateWonder above was ALREADY owner-generic (it reads
// building.owner's own resources) — only the detector was hardcoded to "player". Odyssey-only
// by construction — the Gate is `odysseyOnly` and a skirmish never builds one, so this returns
// null in every skirmish regardless of owner. Pure scan of state.buildings, id-tiebroken (there
// is only ever one wonder per owner, in practice). NOT fog-gated: a charging antimatter Gate is
// a galaxy-wide event, sensed regardless of line-of-sight; a caller that needs visibility (the
// AI targeting the player's Gate, the player targeting a rival's) applies its OWN fog check at
// the seam that actually acts on it.
/**
 * @param {State} state
 * @param {string} owner
 * @returns {Building | null}
 */
export function chargingWonderOf(state, owner) {
  let best = null;
  for (const b of state.buildings.values()) {
    if (b.owner !== owner || b.constructing) continue;
    if (!BUILDINGS[b.type]?.wonder) continue;
    const c = b.charge || 0;
    if (c > 0 && c < 1 && (!best || b.id < best.id)) best = b;
  }
  return best;
}

// The player's charging wonder — the Tier-4 finale hooks' one shared definition (the AI's
// siege-target bias in engine/ai.js, and the diplomacy war-push in engine/diplomacy.js).
// Byte-identical to the pre-generalization function: a thin delegate, so neither caller
// changes at all.
/**
 * @param {State} state
 * @returns {Building | null}
 */
export function chargingPlayerWonder(state) {
  return chargingWonderOf(state, "player");
}
