// @ts-check
/* ============================================================
   AI — shared primitives used by every decision phase (engine/ai.js and the
   aiEconomy / aiMilitary / aiIndustry phase modules): owner resolution
   (controllerFor/opponentsOf/otherOwner), the APM action budget (the configurable AI
   speed), the reserve-aware affordability check, the "which idle worker founds
   this building" pick, and the found-a-building protocol those picks feed.

   Imports only DOWNWARD, into commands/colliders — never back into an AI phase
   module — so the phase modules can all share it without a cycle. That is the
   invariant, not "no engine imports": commands.js and colliders.js have no
   route back to the AI layer, and test/static-integrity.test.js's SCC check
   holds the whole engine to it.
   ============================================================ */

"use strict";

import { issueBuild } from "./commands.js";
import { findPlacement } from "./colliders.js";
import { controllerFor, opponentsOf } from "./controllers.js";

const APM_BURST_FRAC = 1 / 15;   // a busy AI can bank at most ~4 seconds' worth of unspent actions

/* ---------- owner resolution (Tier 1 self-play) ---------- */

// Which controller object is driving `owner` this match — state.controllers[owner] (T-042), a real
// N-capable registry; "ai" is always present (every match ever created), "player" only when
// self-play (tools/selfplay.js) has populated it, null otherwise. Every AI phase module threads its
// ctx.owner through this instead of ever reaching for state.ai/state.controllers directly, so each
// controller's action budget, scout id, wave timer etc. can never collide or leak into another's —
// see the header comment on engine/ai.js's runAI(state, dt, owner) for why that matters.
// Re-exported (not just called) from engine/controllers.js — the real, import-free leaf T-042
// introduced (docs/analysis/01-engine-nplayer-seams.md's own §7.1 "Option (iii)") — so every
// existing `import { controllerFor } from "./aiCommon.js"` call site across the AI layer keeps
// working completely unchanged.
export { controllerFor };

// T-017/ADR-0008: the fairness gates (formation dispatch, idle-worker auto-assignment) want "is a
// human actually driving this seat", not a hardcoded owner literal — a seat is human-controlled
// exactly when it has no AI controller. `state.ai` is populated for every match that exists today
// (there is no seat-configuration path yet that leaves it null), so this is presently true only
// for "player"; it becomes meaningful the moment a real match can put a human on either seat.
/** @param {State} state @param {string} owner @returns {boolean} */
export function isHumanControlled(state, owner) { return controllerFor(state, owner) === null; }

// The other side in a two-owner skirmish/self-play match — pinned to exactly "ai"/"player" on
// purpose. T-043 gave every AI DECISION call site (sightEnemy, the aiMilitary.js targeting
// functions, aiContext) the real N-capable opponentsOf(state, owner) below instead — but this
// stays, unchanged, for hud.js/overlays.js's own genuinely 2-party "you vs. the foe" scoreboard
// line, which is a separate, later UI concern (an N-player scoreboard needs its own design, not a
// mechanical swap) and was never in docs/analysis/01-engine-nplayer-seams.md's own engine/-only
// audit to begin with.
/** @param {string} owner @returns {string} */
export function otherOwner(owner) {
  return owner === "ai" ? "player" : "ai";
}

// T-043 (ADR-0008): every OTHER owner this match actually has — the real, N-capable replacement for
// otherOwner()'s axiom in the AI DECISION layer (see engine/controllers.js's own header for the
// full design note). Re-exported from there for the same reason controllerFor is: every existing
// named import from this module in the AI layer can just add it to that same line.
export { opponentsOf };

/* ---------- action budget (the configurable AI speed / APM) ---------- */

// This controller's "speed" is an actions-per-minute allowance, set from the splash screen
// (state.ai.apm — or, for a self-play "player" controller, state.playerAi.apm). Every command it
// issues — produce, build, expand, research, send the scout — costs one action; the attack commit
// is the one exemption, so a slow AI still throws whatever it has at you and the game always
// resolves. Credits accrue continuously and cap at a few seconds' worth, so a busy AI can't hoard a
// giant burst. When apm is null (the default, and every headless test) the AI is unthrottled —
// behaviour is exactly as before. `owner` defaults to "ai" so every pre-existing call site
// (accrueActionBudget(state, dt), canAct(state), spend(state)) keeps reading/writing state.ai
// exactly as before; a self-play caller passes ctx.owner explicitly so the "player" controller
// spends from ITS OWN budget, never state.ai's — see engine/ai.js/aiMilitary.js/aiEconomy.js.
//
// A BACKGROUND colony (state.background, engine/galaxy.js — a world that isn't the player's
// current seat) accrues at HALF its configured apm: nobody's actively watching it, so it manages
// its economy at half pace rather than as briskly as the seat you're actually on. This halves only
// the accrual rate (and, since the burst cap below is derived from the same value, its burst
// reserve too) — never the controller's apm itself, which stays exactly what difficulty picked for
// every other reader (display, save/load, the neighbour-profile tests) — and never the attack/
// defense commit exemption (canAct/spend below), so a background world under attack still always
// throws whatever it has and the game still always resolves.
/** @param {State} state @param {number} dt @param {string} [owner] @returns {void} */
export function accrueActionBudget(state, dt, owner = "ai") {
  const controller = controllerFor(state, owner);
  if (!controller || controller.apm == null) return;
  const apm = state.background ? controller.apm / 2 : controller.apm;
  const cap = Math.max(2, apm * APM_BURST_FRAC);
  controller.actionBudget = Math.min((controller.actionBudget || 0) + (apm / 60) * dt, cap);
}

/** @param {State} state @param {string} [owner] @returns {boolean} */
export function canAct(state, owner = "ai") {
  const controller = controllerFor(state, owner);
  return !controller || controller.apm == null || (controller.actionBudget || 0) >= 1;
}

/** @param {State} state @param {string} [owner] @returns {void} */
export function spend(state, owner = "ai") {
  const controller = controllerFor(state, owner);
  if (controller && controller.apm != null) controller.actionBudget -= 1;
}

// canAfford, but treating `oreReserve` ore as untouchable — used to bank for
// an expansion Command Center without letting the unit mix or a second
// barracks spend the ore out from under it.
/** @param {Resources} resources @param {Resources} cost @param {number} oreReserve @returns {boolean} */
export function canAffordKeeping(resources, cost, oreReserve) {
  return Object.entries(cost).every(([com, qty]) =>
    (resources[com] || 0) - (com === "ore" ? oreReserve : 0) >= qty);
}

// Nearest free worker to (x, y) to found a building, skipping any already mid-build (so an in-progress
// site keeps its founder) AND any on a logistics run (service/haul) — pulling a worker off feeding a
// factory to lay a foundation would thrash the industry it's trying to grow. Prefers a gatherer/idle
// worker; falls back to workers[0] only if every worker is busy building or hauling — buildings
// self-construct at rate 1 even with nobody on-site, so a slightly-worse pick is never a stall.
/** @param {Unit[]} workers @param {number} x @param {number} y @returns {Unit|null} */
export function pickBuilder(workers, x, y) {
  let best = null, bestD = Infinity;
  for (const w of workers) {
    if (w.order && (w.order.type === "build" || w.order.type === "service" || w.order.type === "haul")) continue;
    const d = Math.hypot(w.x - x, w.y - y);
    if (d < bestD) { bestD = d; best = w; }
  }
  return best || workers[0];
}

/* ---------- founding a building ---------- */

// The AI's found-a-building protocol, in one place: slide the request to valid ground,
// check the action budget, issue the order, and charge the budget for it. Thirteen sites
// across aiEconomy.js and aiIndustry.js hand-rolled these four steps, and two of the four
// fail SILENTLY when dropped — omit `spend` and the AI founds buildings for free (its APM
// dial quietly stops throttling it), omit `canAct` and it ignores the budget outright.
// Neither shows up as a crash, and neither shows up in a determinism fingerprint on the
// default archetype, because the default AI has `apm == null` and both calls are then
// no-ops. Only the APM-limited difficulties and self-play can see the difference.
//
// findPlacement is what makes the fixed build offsets safe: a node or an earlier building
// squatting on the nominal spot would make issueBuild reject the identical coordinates
// every think cycle and stall the order forever, so the search slides it to the nearest
// valid ground instead.
//
// `workers` is a candidate list, not a single unit, because the builder is chosen by
// distance to the spot that placement actually settled on — which isn't known until after
// the search. Two sites (the Habitat and the first Barracks) historically founded with
// workers[0] rather than the nearest free worker; they pass [workers[0]] so the pick is
// forced to that same unit, since pickBuilder returns a lone candidate either way. Widening
// them to the full list would change which unit walks to the site, and with it the
// determinism fingerprint — a behaviour change, not a refactor.
/** @param {State} state @param {string} owner @param {Unit[]} workers @param {string} type @param {number} x @param {number} y @param {number} [maxRadius] @returns {boolean} */
export function tryBuild(state, owner, workers, type, x, y, maxRadius) {
  return tryBuildAt(state, owner, workers, type, findPlacement(state, type, x, y, maxRadius));
}

// tryBuild for a caller that already searched for its own spot (the Habitat scans every
// completed Command Center and takes the first that yields one). `spot` may be null —
// "nowhere to put it" is an ordinary outcome, not an error.
/** @param {State} state @param {string} owner @param {Unit[]} workers @param {string} type @param {{x:number,y:number}|null} spot @returns {boolean} */
export function tryBuildAt(state, owner, workers, type, spot) {
  if (!spot || !workers.length || !canAct(state, owner)) return false;
  const builder = pickBuilder(workers, spot.x, spot.y);
  if (!builder || !issueBuild(state, builder.id, type, spot.x, spot.y)) return false;
  spend(state, owner);
  return true;
}
