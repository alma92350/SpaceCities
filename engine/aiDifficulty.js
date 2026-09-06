// @ts-check
/* ============================================================
   AI DIFFICULTY — the Easy/Medium/Hard pick from the splash screen, orthogonal to
   both the archetype (engine/aiArchetypes.js — which planet/temperament) and the
   player-picked strategy (engine/aiStrategy.js — whether/when it voluntarily
   attacks). Bundles the two original dials — how FAST the opponent acts (aiApm)
   and whether it MICROS its army (aiMicro) — plus the picker's own label/note.
   This is the ONE list of valid difficulty keys: it drives the Easy/Medium/Hard
   buttons in setup.js AND (via boot.js's difficultyDials, which looks a key up in
   this same array) the AI dials a match actually runs with — so a key can never
   exist in one place and not the other, which used to let a mismatched difficulty
   silently downgrade to Medium instead of erroring.

   Economic dials land here as more fields on an entry, read through
   difficultyFor(state) the same defensive way engine/aiStrategy.js's
   strategyFor(state) already reads STRATEGIES — a multiplier field with `|| 1`
   at its use site, a flag read falsy — so an absent field or a legacy/unknown key
   composes as a no-op. Medium carries none of them at all (byte-identical to
   unset), same as STRATEGIES.default — it's the baseline every dial is relative to.

   Tier 1 dials (worker target, war patience, economic edge) compose
   MULTIPLICATIVELY on top of whatever the archetype and player-picked strategy
   already contribute — the same relationship Aggressive/Economic/Force Parity
   already have with the archetype's own Odyssey overlay (aiArchetypes.js) — so
   this is one more layer, not a replacement:
     • workerTargetMult   — aiEconomy.js's workerTarget formula.
     • graceMult/grievanceMult — diplomacy.js's updateDiplomacy war-onset composition.
     • economicEdge       — seeds the synthetic `hardEdge` UPGRADES entry
       (entities.js) onto the AI's own upgrades at creation (engine/state.js), which
       gather.js/production.js already pick up via the existing generic upgradeMult
       — no plumbing changes needed there at all.

   Tier 2 adds researchPaceMult — techtree.js's updateResearch applies it to the AI's OWN
   research only, never the player's, even on the same tech-rated world. That now reaches
   BOTH node tables it resolves: the Odyssey Datacenter tech tree AND the Refinery's
   doctrine upgrades (production.js's researchUpgrade queues and times them the same way,
   engine/entities.js UPGRADES) — so Hard's AI also develops its doctrine pick faster, and
   Easy's slower, than Medium's.

   Tier 3 adds marketAccess — unlocks market.js's aiBarter (called from
   aiEconomy.js's aiMarketBarter, gated through the AI's own APM budget like every
   other decision). Medium and Hard both get it; Easy doesn't, so a new player
   isn't shown an AI that "trades" in a way they can't yet see or counter. No
   separate throttle needed: Hard's higher APM already means more frequent
   barters for free, the same way it already means more frequent everything else.

   Tier 4 adds rusherGraduates (Hard only — the one identity-level change, not just
   a number): past aiIndustry.js's RUSHER_GRADUATE_TIME into an Odyssey world, a
   non-developing archetype (today, only a Rusher) picks up the deep factory chain
   a patient developer would, the same third condition strategy.wantsIndustryAlways
   already is on that gate. Skirmish is untouched by construction (aiIndustry.js
   returns on !state.endless before this is ever read).

   Tier 5 adds counterEvery — aiMilitary.js's pickNextUnitType reads it directly
   (not a multiplier: a cadence override, `?? COUNTER_EVERY` at the read site, so
   an absent value composes as today's fixed-3 cadence). Easy is 0 — it never
   counter-picks, so its army stays exactly its learnable, exploitable archetype
   mix; Hard is 2 — it reacts to the player's composition half again as fast as
   Medium's unchanged 3. Same "Medium carries none of it" baseline as every other
   tier.

   Tier 6 adds strategicCeiling (Easy only — the second identity-level dial,
   exactly the precedent Tier 4's header sets for rusherGraduates). aiIndustry.js's
   INDUSTRY_CHAIN climb and its RESEARCH_ORDER research both stop short of the
   Strategic tier (antimatterforge / 'antimatter' Containment onward) when this is
   set — which transitively withholds the Star Dock, the Leviathan, the Helium
   Bomb, the Plasma Rig, and (Phase 7) a rival Antimatter Gate, since every one of
   those sits downstream of that same chain. This is the identical argument this
   file's own Tier 3 already makes for withholding marketAccess from Easy ("a new
   player isn't shown an AI that trades in a way they can't yet see or counter")
   applied harder to the Strategic tier: a long enough Odyssey session would
   otherwise let even a placid Easy Economist climb to a 900-hp Leviathan and a
   doomsday bomb, exactly the escalation Easy exists to spare a new player from.
   Medium and Hard are untouched — a patient or graduated neighbour on either can
   still walk the whole chain, same as today.
   ============================================================ */

"use strict";

import { controllerFor } from "./controllers.js";

export const DIFFICULTY_OPTIONS = [
  { label: "Easy", mult: "easy", note: "slow · no micro · predictable", aiApm: 20, aiMicro: false,
    workerTargetMult: 0.8, graceMult: 1.15, grievanceMult: 0.85, researchPaceMult: 1.3,
    forgiveness: 1.25, counterEvery: 0, strategicCeiling: true, adaptivity: 0 },
  { label: "Medium", mult: "medium", note: "a fair fight", aiApm: 65, aiMicro: false, marketAccess: true },
  { label: "Hard", mult: "hard", note: "fast · focus-fire · kite", aiApm: 140, aiMicro: true,
    workerTargetMult: 1.25, graceMult: 0.9, grievanceMult: 1.15, economicEdge: true, researchPaceMult: 0.75,
    marketAccess: true, rusherGraduates: true, forgiveness: 0.8, counterEvery: 2, adaptivity: 1.5 },
];

/* Tier 7 adds `adaptivity` — how strongly this difficulty lets the AI act on its READ of the
   opponent (engine/aiIntel.js, docs/ai-adaptive-opponent.md). Easy is 0: it never adapts, so its
   play stays exactly its learnable, exploitable archetype line. That is the identical argument
   Tier 5 makes for `counterEvery: 0` — a new player has to be able to form a model of the
   opponent and beat it, and an AI that answers everything they try is unreadable rather than
   hard. Medium carries none of it (the 1 default, i.e. it does adapt, at ordinary strength);
   Hard is 1.5, reacting harder and on thinner evidence.

   Read through adaptivityFor(state, owner) below with a `?? 1` at the source, so — as with every
   other dial in this file — an absent value composes as the ordinary behaviour and a legacy or
   unknown difficulty key is a no-op rather than an accidental opt-out. */

/** How strongly `owner` acts on its opponent read: 0 disables adaptation entirely, 1 is ordinary,
 * >1 reacts harder and on thinner evidence. @param {State} state @param {string} [owner] @returns {number} */
export function adaptivityFor(state, owner = "ai") {
  const v = difficultyFor(state, owner).adaptivity;
  return v == null ? 1 : v;
}

/** The active difficulty entry for `owner` (default "ai", so every existing save/test/call site
 * that predates self-play reads state.ai.difficulty exactly as before) — DIFFICULTY_OPTIONS'
 * medium entry when unset or naming a key that isn't in the list, the same fallback boot.js's
 * difficultyDials already applies before a match even starts. Tier 1 self-play (tools/selfplay.js)
 * passes owner="player" to read state.playerAi.difficulty instead, its own independently-picked
 * dial. T-042: controllerFor now comes from engine/controllers.js, a true zero-import leaf — NOT
 * engine/aiCommon.js, so this file stays exactly the pure, import-free-of-the-AI-LAYER leaf its
 * header describes (test/static-integrity.test.js's own cycle check has nothing to catch here). */
/** @param {State} state @param {string} [owner] @returns {Object} */
export function difficultyFor(state, owner = "ai") {
  const controller = controllerFor(state, owner);
  return DIFFICULTY_OPTIONS.find(o => o.mult === (controller && controller.difficulty))
      || DIFFICULTY_OPTIONS.find(o => o.mult === "medium");
}
