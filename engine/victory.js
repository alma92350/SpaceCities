// @ts-check
"use strict";

import { UNITS, BUILDINGS } from "./entities.js";
import { hasColonyShip } from "./colony.js";

// The world's side ids, in canonical order. createGameState / rehydratePlanet set
// state.owners; a few narrow unit-test states are hand-built without it, so fall
// back to the classic pair. Ordering matters — it's the tie-break precedence in
// scoreLeader (first side listed wins an exact score tie: the defender's edge).
function ownersOf(state) { return state.owners || ["player", "ai"]; }

// A stalemate breaker: if neither side has lost its last Command Center after
// this many seconds, the match is decided on score instead of running forever.
// It sits far beyond a normal game (which resolves in a few minutes), so it
// only ever fires on a genuine turtle-vs-turtle deadlock — the point is that
// there IS a terminal state, so a defensive stall can't stretch to infinity.
// state.matchTimeLimit can override it (e.g. a future "quick match" option).
export const DEFAULT_MATCH_TIME_LIMIT = 2400;   // 40 minutes of sim time

// Skirmish ends the moment only one side still holds a Command Center — that side wins. A mutual
// loss on the same tick (no side left standing), or the time limit with several still standing,
// is settled by score. Last-side-standing over state.owners: for the classic player-vs-ai pair
// this is exactly the old three-branch check (player-only alive ⇒ player wins, ai-only ⇒ ai,
// neither ⇒ score), byte-identical, and it already reads for N sides (FR-6's own "generalized to
// N seats as last-seat-standing" — true before T-046 touched this file at all).
//
// T-046: a seat dropping out mid-match (3+ seats, one loses its last Command Center) must not
// end the match the way it does at N=2 — state.eliminated tracks every owner no longer standing,
// and the loop below fires a ONE-TIME "eliminated" event for each newly-CC-less owner (checked
// against state.eliminated so it can never re-fire) before `standing` is computed, so the match
// simply continues among whoever's left. Skirmish has no way to found a NEW Command Center once
// your last one is gone (that's Odyssey's own colony-ship mechanic — checkEndlessLoss/
// checkGalaxyRescue below, not this function), so "no longer standing" is a one-way transition,
// exactly what the 2-seat game already assumed when it ended outright on the first loss.
/** @param {State} state @returns {void} */
export function checkWinCondition(state) {
  if (state.over) return;
  if (!state.eliminated) state.eliminated = [];
  if (!state.surrendered) state.surrendered = [];
  const owners = ownersOf(state);
  for (const o of owners) {
    if (!state.eliminated.includes(o) && !hasCommandCenter(state, o)) {
      state.eliminated.push(o);
      state.events.push({ type: "eliminated", owner: o, reason: "defeat" });
    }
  }
  const standing = owners.filter(o => !state.eliminated.includes(o));

  if (standing.length === 0) {
    // Mutual wipe: score among whoever didn't already forfeit the tiebreak by surrendering. For
    // the classic 2-seat case (surrendered is always empty there) this is every owner — the exact
    // scoreLeader(state) call this replaced, byte-identical.
    finish(state, scoreLeader(state, owners.filter(o => !state.surrendered.includes(o))), "mutual-wipe-score");
    return;
  }
  if (standing.length === 1) { finish(state, standing[0], "elimination"); return; }   // last side standing wins

  const limit = state.matchTimeLimit ?? DEFAULT_MATCH_TIME_LIMIT;
  if (state.time >= limit) finish(state, scoreLeader(state, standing), "timeout-score");
}

// A voluntary concession — `owner` is eliminated immediately, whatever they still hold on the
// board (no Command Center loss required). Idempotent: surrendering an already-eliminated owner
// is a no-op, so a doubled/late-arriving surrender command can never re-fire the event or
// duplicate the record. The match itself only ends once checkWinCondition next runs and finds
// one seat (or none) still standing — the same one-tick latency every other elimination already
// has, since surrender and the per-tick Command Center check are deliberately the same mechanism
// (state.eliminated) rather than two separate paths to "is this seat still in it".
/** @param {State} state @param {string} owner @returns {void} */
export function surrender(state, owner) {
  if (state.over) return;
  if (!state.eliminated) state.eliminated = [];
  if (!state.surrendered) state.surrendered = [];
  if (state.eliminated.includes(owner)) return;
  state.eliminated.push(owner);
  state.surrendered.push(owner);
  state.events.push({ type: "eliminated", owner, reason: "surrender" });
}

// Odyssey (open-world) terminal check: there is no victory by conquest and no
// time limit — the sandbox only ends when the player loses their single
// Command Center (their capital seat). Razing a neighbour's CC never ends the
// game; that world simply keeps evolving. Used in place of checkWinCondition
// for an endless state (see sim.js).
/** @param {State} state @returns {void} */
export function checkEndlessLoss(state) {
  if (state.over) return;
  // In a galaxy there is NO defeat at all — the Odyssey plays forever unless you surrender, and a
  // total wipeout sends a relief colony ship instead (engine/galaxy.js checkGalaxyRescue). So the
  // per-world check must NOT fire here; it still governs a standalone endless state (tests). A
  // foothold is a Command Center OR an undeployed colony ship, so the CC-less Odyssey start isn't
  // a tick-1 defeat and a lone ship can still re-found.
  if (state.inGalaxy) return;
  if (!hasCommandCenter(state, "player") && !hasColonyShip(state, "player")) finish(state, "ai");
}

// Standalone-endless WIN check — an Antimatter Gate finishing at full charge, PLUS (in an actual
// Odyssey GALAXY) the signal for a completed AI-owned rival Gate (docs/improvement-proposals.md
// "the rival Gate", merged Defense+AI twins). Both branches read the same wonder-charge scan:
//
//   • PLAYER-owned, OUTSIDE a galaxy: an outright win (finish()) — the twin of checkEndlessLoss,
//     a standalone-endless test fixture's own terminal state.
//   • PLAYER-owned, INSIDE a galaxy: no win at all — a completed Gate is a milestone firework
//     (engine/galaxy.js checkGalaxyProgress), not a victory. The play-forever sandbox.
//   • AI-owned, INSIDE a galaxy: an 'ascension', NEVER a defeat — the play-forever invariant
//     holds even at the galaxy's OWN endgame bid. Pushes a one-time event (latched on the
//     building via `rivalAscended` so this scan, which runs every tick, can't re-fire it) for
//     engine/galaxy.js's throttled rival-gate scan to consume into the actual consequence
//     (claims burst, hardEdge, a permanent stance ceiling, the "rival-gate" milestone) —
//     victory.js only ever signals here, it never resolves the galaxy-side effect itself, so the
//     engine stays exactly as DOM-free/galaxy-agnostic as it already was.
//   • AI-owned, OUTSIDE a galaxy: never happens (a skirmish AI never builds a wonder at all, and
//     a bare standalone-endless test fixture has no galaxy to signal into), so this branch is
//     simply never reached there — nothing to suppress.
/** @param {State} state @returns {void} */
export function checkEndlessWin(state) {
  if (state.over) return;
  for (const b of state.buildings.values()) {
    if (!BUILDINGS[b.type]?.wonder || (b.charge || 0) < 1) continue;
    if (b.owner === "player") {
      if (state.inGalaxy) continue;   // a galaxy Gate online is a milestone, never a win — play forever
      finish(state, "player");
      return;
    }
    if (state.inGalaxy && !b.rivalAscended) {
      b.rivalAscended = true;
      state.events.push({ type: "rivalGateComplete", owner: "ai", buildingId: b.id, x: b.x, y: b.y });
    }
  }
}

// `reason` is only ever supplied by checkWinCondition's three branches above — the skirmish clock
// this feature makes honest (docs/improvement-proposals.md "Make the clock endgame visible,
// honest, and configurable"). checkEndlessLoss/checkEndlessWin below call finish() with no reason
// (winReason stays null): the Odyssey sandbox has no clock and no score tiebreak to explain, so
// there's nothing for a HUD to disambiguate there the way showGameOver now must for a skirmish.
function finish(state, winner, reason = null) {
  state.over = true;
  state.winner = winner;
  state.winReason = reason;
}

function hasCommandCenter(state, owner) {
  for (const b of state.buildings.values()) {
    if (b.owner === owner && b.type === "command") return true;
  }
  return false;
}

// A side's "strength" for the tiebreak, weighted toward what's ON THE BOARD
// rather than what's hoarded in the bank. Committed value — the built cost of
// every unit and building — counts at full; unspent resources count at only
// BANK_WEIGHT, so a turtle that reaches the time limit sitting on a huge
// stockpile can't out-score an opponent who actually spent it on army and
// expansion. Combat units count a little extra (COMBAT_BONUS) so the side that
// pressed the fight edges out one that merely out-massed on workers and static
// defense. Still simple and symmetric. Exported so a HUD could show the score.
const BANK_WEIGHT = 0.25;      // idle resources are worth far less than committed ones
const COMBAT_BONUS = 1.35;     // an army in the field beats an equal-cost economy at the tiebreak

// The three components playerScore sums, broken out instead of collapsed into one total — so a
// HUD/game-over screen can show WHY the tiebreak came out the way it did (docs/improvement-
// proposals.md "Make the clock endgame visible, honest, and configurable"). `structures` folds in
// every NON-combat unit (workers, freighters, Menders, …) at raw cost alongside buildings — the
// same "else" bucket playerScore's own loop already puts them in — so bank+army+structures always
// equals playerScore's own total by construction (playerScore is defined in terms of this below,
// not the other way around, so the two can never drift apart).
/** @param {State} state @param {string} owner @returns {Object.<string, number>} */
export function scoreBreakdown(state, owner) {
  let bank = 0, army = 0, structures = 0;
  const res = state.players[owner].resources;
  for (const com of Object.keys(res)) bank += (res[com] || 0) * BANK_WEIGHT;
  for (const u of state.units.values()) {
    if (u.owner !== owner) continue;
    const def = UNITS[u.type];
    const v = costValue(def?.cost);
    if (def?.role === "combat") army += v * COMBAT_BONUS; else structures += v;
  }
  for (const b of state.buildings.values()) {
    if (b.owner === owner) structures += costValue(BUILDINGS[b.type]?.cost);
  }
  return { bank, army, structures, total: bank + army + structures };
}

// Exported so a HUD could show the score (and now does — hud.js's endgame score bar, and
// showGameOver's breakdown). Thin wrapper over scoreBreakdown so the two can never disagree.
/** @param {State} state @param {string} owner @returns {number} */
export function playerScore(state, owner) {
  return scoreBreakdown(state, owner).total;
}

function costValue(cost) {
  if (!cost) return 0;
  let v = 0;
  for (const com of Object.keys(cost)) v += cost[com];
  return v;
}

// Highest score wins among `candidates`; an exact tie goes to the FIRST one listed (a defender
// edge — the human "player" is always first in state.owners, so state.winner still resolves to
// "player" on a dead heat, as the rest of the game expects). A strict `>` keeps the first-seen
// leader on a tie, so for the player-vs-ai pair with nobody eliminated this is exactly
// `ai > player ? "ai" : "player"` — byte-identical. T-046: takes an explicit candidate list
// (rather than reading ownersOf(state) itself) so checkWinCondition's two callers can each
// exclude a different set — a surrendered seat is disqualified from ANY score tiebreak, but a
// seat that merely lost its last Command Center still counts toward a genuine same-tick mutual
// wipe, exactly the 2-seat game's own existing behavior.
/** @param {State} state @param {string[]} candidates @returns {string|null} */
function scoreLeader(state, candidates) {
  let best = null, bestScore = -Infinity;
  for (const o of candidates) {
    const s = playerScore(state, o);
    if (s > bestScore) { bestScore = s; best = o; }
  }
  return best;
}
