// @ts-check
/* ============================================================
   Playable factions. A faction is a small bundle of PASSIVE trait
   multipliers — nothing more — so it changes how a side plays without
   touching the shared roster, the rock-paper-scissors triangle, the tech
   tree, or the AI's build logic. Every trait key is one the engine already
   reads through map.js's sideMod (speedMult, sightMult, gatherMult,
   buildTimeMult) plus one combat hook (damageDealtMult), so a faction's
   edge is applied exactly where a world's own modifier is — they stack
   multiplicatively and go through the identical code path.

   Design: three distinct identities on one axis each, balanced against a
   clear opportunity cost, so the pick is a real strategic fork rather than a
   power creep —
     • Frontier  — mobility & vision: strikes first, controls the map.
     • Miners    — industry: richer hauls and faster production; out-scales.
     • Syndicate — firepower on a lean economy: win the fight, and win it fast.
   `neutral` (no traits) is the default for a bare createGameState and every
   engine test, so the whole faction layer is opt-in — a match only gets an
   identity when the setup screen picks one, exactly like aiApm / aiMicro.
   ============================================================ */

"use strict";

export const FACTIONS = {
  frontier: {
    id: "frontier", name: "Frontier Coalition", short: "Frontier",
    blurb: "Fast, far-seeing militia — controls the map and strikes first.",
    // Mobility & vision. Modest numbers: an edge in tempo and scouting, not a
    // stat check — its units still die to the same counters.
    traits: { speedMult: 1.08, sightMult: 1.06 },
  },
  miners: {
    id: "miners", name: "Miners' Union", short: "Miners",
    blurb: "Industrial powerhouse — richer hauls and quicker production.",
    // Economy & tempo: more resources per haul and faster build/train, so it
    // fields a bigger army over time. Its edge is the long game.
    traits: { gatherMult: 1.15, buildTimeMult: 0.90 },
  },
  syndicate: {
    id: "syndicate", name: "Vanguard Syndicate", short: "Syndicate",
    blurb: "Elite firepower on a lean economy — win the fight, fast.",
    // Firepower with a real cost: every unit hits ~10% harder, but its hauls
    // are ~8% leaner, so it must convert that edge into a win before a Miners
    // out-produces it or a Frontier kites it.
    traits: { damageDealtMult: 1.10, gatherMult: 0.92 },
  },
  neutral: {
    id: "neutral", name: "Unaligned", short: "Unaligned",
    blurb: "No factional bonuses.",
    traits: {},
  },
};

// Player-pickable factions, in setup-screen order (neutral is internal only).
export const PLAYABLE_FACTIONS = ["frontier", "miners", "syndicate"];

// The multiplier a side's faction applies to `key`, or 1 when it has no such
// trait / no faction / no players on the state (map-less test stubs). Pure and
// state-reading; folded into sideMod so every existing modifier consumer picks
// it up automatically.
/**
 * @param {State} state
 * @param {string} owner
 * @param {string} key the trait to read off this owner's faction
 * @returns {number}
 */
export function factionTrait(state, owner, key) {
  const fid = state && state.players && state.players[owner] && state.players[owner].faction;
  const traits = fid && FACTIONS[fid] && FACTIONS[fid].traits;
  return traits && traits[key] != null ? traits[key] : 1;
}
