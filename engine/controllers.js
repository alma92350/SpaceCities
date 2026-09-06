// @ts-check
/* ============================================================
   T-042 (ADR-0008): the real, N-capable AI controller registry — engine/state.js's own
   state.controllers{}, keyed by owner id, replacing the 2-slot state.ai/state.playerAi as the
   thing every AI decision function actually resolves against.

   A true LEAF, zero imports of its own — deliberately, so engine/aiCommon.js AND the pure phase
   modules that explicitly avoid importing aiCommon.js (aiIntel.js, aiDifficulty.js, aiStrategy.js,
   aiIndustry.js — each says so in its own header: "deliberately NOT an import of
   engine/aiCommon.js's controllerFor, so this file stays the pure, import-free leaf") can all
   depend on THIS instead, without creating the cycle that importing aiCommon.js itself would
   (test/static-integrity.test.js's own SCC check holds the whole engine to zero cycles). This file
   existing at all is docs/analysis/01-engine-nplayer-seams.md's own §7.1 "Option (iii)" —the
   audit's own recommended fix for the "hand-rolled seven more times" duplication that predates it.

   attachControllerAliases(state) is the OTHER half: state.ai/state.playerAi stay real, LIVE,
   read-write properties (not a one-time snapshot) so both directions keep working — the ~39
   existing test files and 4 tools files that still read/write them directly (docs/analysis/
   01-engine-nplayer-seams.md's own §7.2 count), AND T-036's own AI-takeover/reclaim pattern
   (`match.state.ai = createAiController(...)`, `match.state[aiSlotFor(seat)] = null`), which
   REASSIGNS them — a one-time sync at construction would silently stop tracking that. Called from
   BOTH engine/state.js's createGameState AND engine/persist.js's deserializeGame — a LOADED game
   needs its own state.controllers too, or controllerFor would see nothing at all for a restored
   match, even though state.ai/state.playerAi themselves restore correctly.
   ============================================================ */

"use strict";

/**
 * Which controller object is driving `owner` this match, or null if none (a human seat, or an
 * owner nothing ever populated). @param {State} state @param {string} owner @returns {AiState|null}
 */
export function controllerFor(state, owner) {
  return (state.controllers && state.controllers[owner]) ?? null;
}

/**
 * T-043 (ADR-0008): every OTHER owner in this match — `owner`'s full set of opponents under FFA
 * (this engine has no alliance/team mechanic, so "every other seat" and "every enemy" are the same
 * set). Replaces engine/aiCommon.js's old otherOwner(owner)'s "there is exactly one enemy" axiom in
 * every AI DECISION call site (engine/aiIntel.js's sightEnemy, engine/aiMilitary.js's
 * visibleEnemyCombatUnits/raidTarget/chooseAttackTarget/counterToPlayerArmy, engine/ai.js's
 * aiContext) — otherOwner() itself is NOT removed, since hud.js/overlays.js still use it for their
 * own genuinely 2-party "you vs. the foe" scoreboard line, a separate UI concern this task does not
 * touch. For the shipped 2-seat case this always returns a single-element array, so a caller
 * widening `e.owner === enemyOwner` to `opponents.includes(e.owner)` is byte-identical — it's only
 * the CANDIDATE POOL that grows for N>2, and the existing nearest/most-common/highest-value pick
 * among that pool already generalizes with no new policy needed. Falls back to the original
 * ["player","ai"] pair when state.owners is unset (a minimal hand-built test fixture), exactly the
 * defensive style controllerFor above already uses. @param {State} state @param {string} owner
 * @returns {string[]}
 */
export function opponentsOf(state, owner) {
  return (state.owners || ["player", "ai"]).filter(o => o !== owner);
}

/**
 * Installs state.ai / state.playerAi as live accessor properties over state.controllers.ai /
 * state.controllers.player — enumerable and configurable (indistinguishable from an ordinary data
 * property to Object.keys/JSON.stringify/spread/for-in), so nothing that reads or writes them the
 * old way needs to change. Call once, right after state.controllers itself has real entries.
 * @param {State} state @returns {void}
 */
export function attachControllerAliases(state) {
  Object.defineProperty(state, "ai", {
    get() { return state.controllers.ai; },
    set(v) { state.controllers.ai = v; },
    enumerable: true, configurable: true,
  });
  Object.defineProperty(state, "playerAi", {
    get() { return state.controllers.player; },
    set(v) { state.controllers.player = v; },
    enumerable: true, configurable: true,
  });
}
