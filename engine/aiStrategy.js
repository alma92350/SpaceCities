// @ts-check
/* ============================================================
   AI STRATEGY — a player-picked overlay, orthogonal to the archetype
   (engine/aiArchetypes.js). The archetype comes from the world/opponent and
   sets FLAVOR: faction, unit mix, which doctrine it researches. Strategy sets
   AGGRESSION: whether and when the AI voluntarily attacks, how big a standing
   army it bothers to keep, and how it reacts to being attacked. Picked once at
   setup (setup.js "AI Strategy" row) alongside difficulty, and applies in BOTH
   skirmish and Odyssey — see engine/ai.js (aiContext.strategy), engine/
   aiMilitary.js (offense timing), engine/aiEconomy.js (standing-army throttle),
   engine/aiIndustry.js (Helium Bomb) and engine/diplomacy.js (Odyssey grace).

   "default" carries no overrides at all, so a match that never picks a
   strategy — every save/test predating this feature, and the legacy call
   sites that still don't pass one — plays exactly as before: every field
   below is read with a `|| 1` (multipliers) or falsy-default (flags), so an
   absent strategy or an absent field is always a no-op.

   Multipliers COMPOSE with the archetype's own numbers rather than replacing
   them, the same way the archetype's own Odyssey overlay composes with its
   skirmish base (aiArchetypes.js) — so "an Aggressive Rusher" is even more
   aggressive than either alone, and "an Economic Economist" out-turtles a
   default one, instead of every archetype flattening into one strategy's
   numbers.
   ============================================================ */

"use strict";

import { controllerFor } from "./controllers.js";

export const STRATEGIES = {
  default: {
    name: "Adaptive",
    desc: "Plays true to its archetype — no extra aggression or restraint.",
  },
  aggressive: {
    name: "Aggressive",
    desc: "Attacks earlier and with less, and in Odyssey forces the issue instead of waiting out diplomacy.",
    // OFFENSE (both modes): commits sooner (attackTimeoutMult), with a smaller
    // muster (armyAttackSizeMult), and holds less back at home (garrisonMult) —
    // see engine/aiMilitary.js aiOffense, which multiplies these onto the
    // archetype's own attackTimeout/armyAttackSize/garrison.
    attackTimeoutMult: 0.55,
    armyAttackSizeMult: 0.6,
    garrisonMult: 0.4,
    // ODYSSEY DIPLOMACY: composes with the archetype's own odyssey overlay
    // (aiArchetypes.js graceMult/grievanceMult) — see engine/diplomacy.js.
    // Shrinks the opening grace window hard and sours faster on losses, so an
    // Aggressive neighbour turns hostile — and presses first — well before a
    // default one would, on ANY world, not just a Rusher's.
    graceMult: 0.2,
    grievanceMult: 1.6,
    // …and it lets go slowly: a grudge outlasts the fight that caused it (diplomacy.js forgiveness).
    forgiveness: 0.6,
    // ECONOMY TO PAY FOR THE AGGRESSION (2026-08-04). Aggressive was the WORST of the four in
    // head-to-head self-play — `ailab duel --candidates` over the shipped roster, 6 worlds x 2
    // seeds x both owner slots: 25W-47L (35%) at Medium, last place, against Economic's 51W-21L.
    // A coordinate scan over its own offense dials could not fix that (armyAttackSizeMult and
    // garrisonMult moved 2W-6L to at best 3W-5L) — because attacking sooner with less was never
    // the problem. What the tournament winner had that this strategy lacked was an economy to
    // FOLLOW UP with: Economic's own workerTargetMult 1.25. Given the same one, Aggressive goes
    // 25W-47L -> 38W-34L (53%) at Medium and 37W-35L -> 39W-33L (54%) at Hard.
    //   The value is 1.25 and not higher for a reason worth keeping: at 1.4 this wins Medium
    // harder (54%) but LOSES Hard (51% -> 44%), because engine/aiDifficulty.js's Hard row already
    // carries workerTargetMult 1.25 and the layers compose multiplicatively — 1.4 there is really
    // 1.75x. A dial tuned on one difficulty is not tuned.
    workerTargetMult: 1.25,
    // SUPERWEAPON (engine/aiSuperweapon.js): once a Helium Bomb is built, walk
    // it to the current attack target and trigger it there, rather than
    // leaving it as a purely defensive home trap (every strategy gets that
    // much for free — see aiSuperweapon.js).
    useBombOffensively: true,
  },
  economic: {
    name: "Economic",
    desc: "Keeps a minimal standing defense while it builds its economy — but rearms fast the instant it's attacked.",
    // STANDING ARMY (engine/aiEconomy.js aiProduceAndFortify): stop feeding the
    // unit-mix cycle once the home-army headcount reaches this — a token guard,
    // not a real force — freeing that ore for economy/industry instead.
    standingArmyCap: 3,
    // WAR FOOTING: the instant the AI can SEE enemy combat units pressing its
    // base (the same signal aiMilitary's recall already reacts to), the cap
    // above is lifted by this multiplier for warFootingTime seconds — so being
    // attacked is what turns "minimal defense" into a real production push,
    // exactly the brief. Decays back to the minimal cap once the threat's been
    // gone this long.
    warFootingMult: 5,
    warFootingTime: 75,
    // OFFENSE: never volunteers into a fight on its own — neverInitiates
    // (engine/aiMilitary.js aiOffense) blocks every voluntary commit, including
    // the skirmish desperation timeout: a strategy whose whole point is "doesn't
    // attack unprovoked" has to mean that literally, or a genuinely passive
    // player eventually eats an unexplained all-in wave purely because enough
    // time passed. A mutual-turtle skirmish still resolves — victory.js's
    // score-based DEFAULT_MATCH_TIME_LIMIT (40 minutes) settles it without
    // requiring combat from either side.
    //   ODYSSEY reads it as "doesn't START fights" rather than "never fights":
    // there's no clock and no score there, so a neighbour dragged all the way to
    // Hostile that could never answer just read as decoration. It commits only
    // once the PLAYER has provoked it — destroyed its ships, or started charging
    // a Gate (engine/diplomacy.js provoked()) — never on elapsed time, which is
    // the bug above. Unprovoked, it still only ever fights defensively.
    neverInitiates: true,
    // A lighter static defense to match "minimal" (still real — cheap and
    // passive, unlike the standing army above).
    turretCountMult: 0.6,
    // …and it de-escalates readily: fighting is a cost centre, so it cools off fastest of the four
    // once you stop shooting (engine/diplomacy.js forgiveness).
    forgiveness: 1.4,
    // Leans further into economy than its archetype might on its own.
    workerTargetMult: 1.25,
    // INDUSTRY (engine/aiIndustry.js): always climbs the deep factory chain —
    // Plasma Rig included — once teched for it, even paired with a Rusher/
    // Balanced archetype that wouldn't normally bother (archetype.wantsRefinery
    // false). Pure economy means using every economic capability in the game.
    wantsIndustryAlways: true,
  },
  matching: {
    name: "Force Parity",
    desc: "Sizes its army to mirror whatever it's seen of the enemy's, so no attack catches it outmatched.",
    // STANDING ARMY: instead of a fixed cap, the target continuously tracks
    // the enemy combat units the AI can actually SEE right now (its own fog —
    // engine/aiMilitary.js visibleEnemyForceCount), with a buffer above parity
    // and a floor so a yet-unscouted enemy still gets a minimal home guard.
    matchEnemyForce: true,
    matchBuffer: 1.15,
    matchFloor: 3,
    // Deterrence, not vengeance: it stands down a little faster than a default neighbour once the
    // force it was mirroring stops appearing (engine/diplomacy.js forgiveness).
    forgiveness: 1.2,
    // OFFENSE: purely reactive, like Economic — parity is a deterrent/defense
    // plan, not a wind-up to attack, and neverInitiates means that literally,
    // with no timeout escape hatch (see the Economic entry above, including how
    // Odyssey's provocation path narrows it to "doesn't start fights").
    neverInitiates: true,
  },
};

/** The active strategy for `owner` (default "ai", so every existing save/test/call site that
 * predates self-play — the overwhelming majority — reads state.ai.strategy exactly as before) —
 * STRATEGIES.default if unset/unknown. Tier 1 self-play (tools/selfplay.js) passes owner="player"
 * to read state.playerAi.strategy instead, its own independently-picked overlay. T-042:
 * controllerFor now comes from engine/controllers.js, a true zero-import leaf — NOT
 * engine/aiCommon.js, so this file stays exactly the pure, import-free-of-the-AI-LAYER leaf its
 * header describes (test/static-integrity.test.js's own cycle check has nothing to catch here). */
/** @param {State} state @param {string} [owner] @returns {Strategy} */
export function strategyFor(state, owner = "ai") {
  const controller = controllerFor(state, owner);
  return (controller && STRATEGIES[controller.strategy]) || STRATEGIES.default;
}
