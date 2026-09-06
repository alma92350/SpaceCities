// @ts-check
/* ============================================================
   AI INTEL — what the AI BELIEVES about its opponent (docs/ai-adaptive-opponent.md)

   Every other reactive read in the AI answers a question about right now: are there enemies at my
   base (visibleThreatsNearHome), how many can I see (visibleEnemyForceCount), what do they field
   most (counterToPlayerArmy). Each drives one hardcoded reaction, and none of them survives losing
   sight of the enemy — entity sighting goes through the LIVE fog layer (isVisibleAt), so the
   instant a scout dies the AI's picture of its opponent is empty and it has no way to know it.

   This module holds the other kind of knowledge: a BELIEF about what sort of game the opponent is
   playing, which persists between sightings and decays when it goes unrefreshed. It is the first
   piece of AI state that can be WRONG — every other read is a fact about the current frame — and
   that is the point. An opponent model you can deceive is what makes scouting worth its cost and
   what makes killing the scout a real counter-play.

   THREE THINGS IT REPORTS, and why they are three and not one:

     mil / eco    Ore-value of the enemy's military and economic assets, as far as `owner` has seen.
     posture      mil / (mil + eco) — 0 is a pure economy game, 1 is a pure war game. THE read.
     confidence   How much has been seen, and how recently.

   Confidence is separate from posture on purpose. "I have seen nothing" and "I have seen an empty
   base" are completely different situations, and a single number cannot tell them apart —
   collapsing them is exactly how an AI ends up confidently raiding into an army it never scouted.
   Low confidence means hedge and go look, not "the enemy is weak".

   THE BELIEF IS A FADING HIGH-WATER MARK, not an average of sightings. Seeing two units near my
   base tells me the enemy has AT LEAST that much; it says nothing about the army parked at home.
   So a sighting can only ever raise the estimate, and time is the only thing that lowers it. That
   also makes the read stable under the thing that would otherwise wreck it — an army walking in and
   out of vision — while still letting a genuinely disbanded force fade away.

   PURE AND FOG-LIMITED. No clock beyond state.time, no randomness, no reach into the other side's
   fog: every read resolves from `owner`'s own state.fogs[owner] and otherOwner(owner), so it drives
   either seat in self-play (see engine/ai.js's runAI header). The engine-purity and determinism
   guards cover this file like any other.
   ============================================================ */

"use strict";

import { UNITS, BUILDINGS } from "./entities.js";
import { isVisibleAt } from "./fog.js";
import { opponentsOf, controllerFor } from "./aiCommon.js";
// aiStrategy.js is the pure, import-free leaf its own header describes, so this is a downward
// edge with no cycle — the same one aiWorkers/aiMilitary/aiEconomy already have.
import { strategyFor } from "./aiStrategy.js";

// How long an unrefreshed belief takes to fade to nothing, in sim seconds. Four minutes: long
// enough that an army stepping out of vision for a fight doesn't erase itself, short enough that
// an AI still acting on five-minute-old intel is making a mistake the player earned by hiding.
export const INTEL_FADE = 240;

// Total ore-value of enemy assets at which the AI considers itself fully informed. Deliberately
// modest — this is "have I seen enough to have an opinion", not "have I seen everything", and an
// AI that refuses to act until it has scouted a whole base never acts at all.
export const INTEL_FULL = 900;

const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * How much of a belief set `age` sim-seconds ago is still worth — 1 fresh, 0 past the window,
 * straight-line in between. Subtraction and division only, no pow()/exp(): a curved fade would
 * put an engine-approximated math call on a path that feeds every AI decision, and this project's
 * same-seed-same-game promise (CONTRIBUTING §1) does not want that.
 * @param {number} age @returns {number}
 */
function fadeKeep(age) {
  return age >= INTEL_FADE ? 0 : 1 - age / INTEL_FADE;
}

/**
 * One channel's belief RIGHT NOW: the stored peak, faded by how long since that peak was set.
 *
 * THE FADE IS COMPUTED, NEVER ACCUMULATED. This used to fade the stored number and write the faded
 * number back, then re-fade THAT from the same timestamp on the next think cycle — so the decay
 * compounded once per cycle and its real rate depended on how often the AI happened to think. At
 * engine/ai.js's 1.5s cadence the documented four-minute fade emptied in about sixty seconds, which
 * quietly made the whole belief model inert the moment the enemy left vision. Keeping the peak
 * immutable and deriving the current value from elapsed time makes the fade exactly the straight
 * line the header describes, at any cadence.
 *
 * `atKey` falls back to the shared `intelAt` so a save written before the per-channel stamps
 * existed loads as "both channels last refreshed when anything was last seen" — the closest true
 * statement that old data supports.
 * @param {Object} controller @param {number} now @param {string} valKey @param {string} atKey
 * @returns {number}
 */
function channelValue(controller, now, valKey, atKey) {
  const peak = controller[valKey] || 0;
  if (peak <= 0) return 0;
  const at = controller[atKey] != null ? controller[atKey] : controller.intelAt;
  if (at == null) return 0;
  return peak * fadeKeep(Math.max(0, now - at));
}

/**
 * Fold one channel's live sighting into its stored peak. Only a sighting that beats what the AI
 * already believes moves anything; anything less leaves the peak AND its stamp untouched, so the
 * existing fade carries on from where it was rather than restarting.
 * @param {Object} controller @param {number} now @param {string} valKey @param {string} atKey
 * @param {number} live @returns {void}
 */
function refreshChannel(controller, now, valKey, atKey, live) {
  if (live > channelValue(controller, now, valKey, atKey)) {
    controller[valKey] = live;
    controller[atKey] = now;
  }
}

/** Sum of a cost object's commodities — the same flat ore-value engine/victory.js's own
 * costValue uses, kept local so this file stays a leaf of entities/fog/aiCommon only.
 * @param {Object} [cost] @returns {number} */
function costValue(cost) {
  if (!cost) return 0;
  let v = 0;
  for (const com of Object.keys(cost)) v += cost[com] || 0;
  return v;
}

/**
 * Is this building a MILITARY investment? Derived from the definition itself rather than a
 * hardcoded id list, so a building added later classifies itself: anything that shoots (turret,
 * bastille, torpedobattery), projects a defensive aura (aegisbastion), or produces a combat unit
 * (barracks, stardock) is military; everything else — refineries, habitats, the whole industry
 * chain — is economy. A Command Center produces only workers and support, so it reads as economy,
 * which is right: it is the thing a greedy player is protecting, not the thing they are threatening
 * you with.
 * @param {Object} def   a BUILDINGS entry
 * @returns {boolean}
 */
export function isMilitaryBuilding(def) {
  if (!def) return false;
  if (def.attack > 0 || def.guardAura) return true;
  return (def.produces || []).some(t => UNITS[t] && UNITS[t].role === "combat");
}

/**
 * What `owner` can SEE of its enemies this instant, valued in ore — every OTHER seat combined
 * (T-043: opponentsOf, not one hardcoded rival), so the belief this feeds is "how much opposition
 * have I seen", not "how much has this one particular rival got". The live half of the belief —
 * updateIntel folds this into the persistent estimate below.
 * @param {State} state @param {string} [owner]
 * @returns {{ mil: number, eco: number }}
 */
export function sightEnemy(state, owner = "ai") {
  const enemies = opponentsOf(state, owner);
  const fog = state.fogs[owner];
  let mil = 0, eco = 0;
  for (const u of state.units.values()) {
    if (!enemies.includes(u.owner) || !isVisibleAt(fog, u.x, u.y)) continue;
    const def = UNITS[u.type];
    if (!def) continue;
    if (def.role === "combat") mil += costValue(def.cost); else eco += costValue(def.cost);
  }
  for (const b of state.buildings.values()) {
    if (!enemies.includes(b.owner) || !isVisibleAt(fog, b.x, b.y)) continue;
    const def = BUILDINGS[b.type];
    if (!def) continue;
    if (isMilitaryBuilding(def)) mil += costValue(def.cost); else eco += costValue(def.cost);
  }
  return { mil, eco };
}

/**
 * Fold this cycle's sighting into `owner`'s persistent belief. Called once per think cycle from
 * engine/ai.js's aiContext, before any phase reads it, so every phase in a cycle sees the same
 * picture.
 *
 * The update is `max(live, faded peak)` per channel — see the high-water-mark note in this file's
 * header. Only a sighting raises it; only time lowers it.
 *
 * THE TWO CHANNELS FADE ON SEPARATE CLOCKS, which is why there are two stamps and not one. A
 * worker line parked in view is a real refresh of what the AI knows about the ECONOMY and says
 * nothing at all about the army that walked off half a minute ago. Under one shared stamp that
 * worker kept re-dating the military belief too, so a single visible drone held the estimate of an
 * army that no longer existed up indefinitely — the mirror image of the compounding bug, and just
 * as wrong. `intelAt` is still stamped whenever ANYTHING enemy is in sight: it answers a different
 * question ("when did I last look at them at all"), which is what readEnemy's confidence needs.
 *
 * @param {State} state @param {string} [owner] @returns {void}
 */
export function updateIntel(state, owner = "ai") {
  const controller = controllerFor(state, owner);
  if (!controller) return;
  const live = sightEnemy(state, owner);
  refreshChannel(controller, state.time, "intelMil", "intelMilAt", live.mil);
  refreshChannel(controller, state.time, "intelEco", "intelEcoAt", live.eco);
  if (live.mil > 0 || live.eco > 0) controller.intelAt = state.time;
}

/**
 * `owner`'s current read of its enemy. `posture` is null when nothing has ever been seen — the
 * caller must handle "I do not know" separately from "they are peaceful", which is the whole reason
 * confidence exists (see the header).
 *
 * @param {State} state @param {string} [owner]
 * @returns {{ posture: number|null, confidence: number, mil: number, eco: number, age: number|null }}
 */
export function readEnemy(state, owner = "ai") {
  const controller = controllerFor(state, owner);
  if (!controller) return { posture: null, confidence: 0, mil: 0, eco: 0, age: null };
  // Each channel's stored PEAK, faded by its own elapsed time — the fade lives here, at the read,
  // and is never written back (see channelValue).
  const mil = channelValue(controller, state.time, "intelMil", "intelMilAt");
  const eco = channelValue(controller, state.time, "intelEco", "intelEcoAt");
  const total = mil + eco;
  const age = controller.intelAt == null ? null : Math.max(0, state.time - controller.intelAt);
  // NOT a second fade on top of the one already in `mil`/`eco` above — this one answers "how long
  // since I last laid eyes on them at all", which is a different question from how much of any one
  // channel's estimate still stands, and it is the half that separates "I have seen nothing" from
  // "I have seen an empty base".
  const freshness = age == null ? 0 : fadeKeep(age);
  return {
    posture: total > 0 ? mil / total : null,
    // Both halves must hold: a stale look at a whole base is as uninformative as a fresh glimpse
    // of one worker, and multiplying is what makes either one alone insufficient.
    confidence: clamp01(total / INTEL_FULL) * freshness,
    mil, eco, age,
  };
}

/**
 * Is the enemy GREEDY and worth punishing — visibly investing in economy over defence, with enough
 * seen to justify acting on it? The question Phase 2's raid trigger asks (docs/ai-adaptive-opponent.md).
 * Deliberately a named predicate rather than two inequalities at the call site: "when do we punish
 * greed" is a design decision that should be readable in one place and testable on its own.
 *
 * @param {State} state @param {string} [owner]
 * @param {{ maxPosture?: number, minConfidence?: number }} [opts]
 * @returns {boolean}
 */
export function enemyIsGreedy(state, owner = "ai", opts = {}) {
  const r = readEnemy(state, owner);
  if (r.posture == null) return false;   // never seen them — hedge and scout, never assume weakness
  // THE ADAPTATION POLICY IS EVOLVABLE (docs/ai-evolution-design.md Phase 4). Both thresholds read
  // off the strategy row through the same `?? default` seam every other dial in this engine uses,
  // so an absent value is exactly today's behaviour and tools/genome.js can search them without an
  // engine change — the property that made a candidate AI JSON in the first place. An explicit
  // opts value still wins, which is what lets aiMilitary scale the bar by difficulty.
  const strategy = strategyFor(state, owner);
  const maxPosture = opts.maxPosture ?? strategy.punishPosture ?? 0.35;
  const minConfidence = opts.minConfidence ?? strategy.punishConfidence ?? 0.25;
  return r.posture <= maxPosture && r.confidence >= minConfidence;
}

/* ============================================================
   MODE — the smoothed stance the AI actually acts on

   `posture` is the raw read and is far too jumpy to drive investment decisions directly: it moves
   every time a wave walks past. `adaptMode` is the damped version — the same 0..1 scale, but it
   only moves when the read has genuinely shifted, and then only slowly.

   BOTH damping terms are load-bearing, and for different reasons:

     dead band   Two adaptive AIs facing each other form a feedback loop — A goes economy, B raids,
                 A goes military, B turtles, A goes economy — and an undamped controller oscillates
                 in it forever instead of settling. The band means small reads change nothing.
     rate limit  Even a real shift is absorbed over many think cycles rather than in one, so the
                 opponent stays LEGIBLE. A player has to be able to notice "it's turtling now" and
                 respond; an AI that reconfigures itself instantly is not a harder opponent, it is
                 an unreadable one. This is the same argument engine/aiDifficulty.js makes for
                 Easy's counterEvery: 0, applied to stance instead of composition.

   Confidence gates the whole thing: an unscouted enemy cannot move the mode at all, so the AI
   hedges at neutral and goes looking rather than committing to a stance it cannot justify.
   ============================================================ */

export const ADAPT_NEUTRAL = 0.5;    // no opinion — hedge, build for both
export const ADAPT_DEAD_BAND = 0.15; // the read must differ from the current mode by this to move it
export const ADAPT_RATE = 0.04;      // …and then moves at most this far per think cycle

/**
 * Step `owner`'s stance toward what it currently believes, and return the new value. Called once
 * per think cycle from engine/ai.js, right after updateIntel, so every phase in a cycle acts on one
 * stance. `adaptivity` (engine/aiDifficulty.js) scales the rate: 0 pins the mode at neutral forever,
 * which is how Easy stays a fixed, learnable opponent.
 * @param {State} state @param {string} [owner] @param {number} [adaptivity] @returns {number}
 */
export function updateAdaptMode(state, owner = "ai", adaptivity = 1) {
  const controller = controllerFor(state, owner);
  if (!controller) return ADAPT_NEUTRAL;
  const cur = controller.adaptMode == null ? ADAPT_NEUTRAL : controller.adaptMode;
  if (adaptivity <= 0) { controller.adaptMode = ADAPT_NEUTRAL; return ADAPT_NEUTRAL; }
  const r = readEnemy(state, owner);
  // An unknown or barely-scouted enemy pulls toward neutral, never toward a stance: "I have not
  // looked" must not read as "they are peaceful" here either.
  const target = r.posture == null ? ADAPT_NEUTRAL
    : ADAPT_NEUTRAL + (r.posture - ADAPT_NEUTRAL) * r.confidence;
  const gap = target - cur;
  // Both damping terms are evolvable multipliers on the shipped constants — a genome can breed a
  // twitchy reactor or a stubborn one — and both default to 1, i.e. exactly today's behaviour.
  const strategy = strategyFor(state, owner);
  const band = ADAPT_DEAD_BAND * (strategy.adaptBandMult ?? 1);
  const rate = ADAPT_RATE * (strategy.adaptRateMult ?? 1);
  if (Math.abs(gap) <= band) { controller.adaptMode = cur; return cur; }
  const step = Math.min(Math.abs(gap), rate * adaptivity) * (gap < 0 ? -1 : 1);
  const next = Math.min(1, Math.max(0, cur + step));
  controller.adaptMode = next;
  return next;
}

// How far the mode is allowed to swing static defence. 0.6x against a visibly greedy opponent
// (turrets are ore not spent on punishing them) up to 1.6x against one that is massing (wall up).
// Bounded deliberately: adaptation changes TEMPO AND INVESTMENT, never identity — a Rusher that
// adapts into a turtle is not a Rusher, and the archetype has to stay recognisable.
const DEFENCE_SWING = 0.6;

/**
 * The multiplier the adapted stance applies to static defence, composed onto the archetype's own
 * turretCount and the strategy's turretCountMult exactly like every other layer in this engine.
 * 1 at neutral, so an AI with no opinion — and every Easy AI, pinned at neutral — is byte-identical
 * to one that never had a mode at all.
 * @param {State} state @param {string} [owner] @returns {number}
 */
export function adaptDefenceMult(state, owner = "ai") {
  const controller = controllerFor(state, owner);
  const mode = controller && controller.adaptMode != null ? controller.adaptMode : ADAPT_NEUTRAL;
  const strategy = strategyFor(state, owner);
  const swing = DEFENCE_SWING * (strategy.defenceSwingMult ?? 1);
  return 1 + (mode - ADAPT_NEUTRAL) * 2 * swing;
}
