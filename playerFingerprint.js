// @ts-check
/* ============================================================
   PLAYER FINGERPRINT — measure a human, and fit an AI to them

   The point of the genome (docs/ai-evolution-design.md) was never only to let a search breed
   opponents. It was so a PLAYER could own one: edit a strategy into existence, or have their own
   play captured into an AI and then face it. This module is the second half of that — the bridge
   from "how this person actually played" to a runnable genome.

   Root-level, not under engine/, for exactly the reason elo.js gives for living here: a fingerprint
   is not simulation state. It is an observation ABOUT a match that the caller already ran, it
   changes nothing, and the sim neither produces nor consumes it. Pure: no clock, no randomness, no
   DOM — the same discipline that lets pairing.js and elo.js run in a Worker.

   NOT FOG-LIMITED, AND THAT IS THE POINT. engine/aiIntel.js reads an opponent through fog because
   an AI acting on what it has not scouted is cheating. This measures the player from ground truth,
   because it is not a gameplay decision at all — it is analysis of a finished game, the same way a
   replay is. Confusing the two would either cripple the fit or smuggle omniscience into the AI.

   WHAT IT CAN AND CANNOT SEE. A fingerprint is taken from a STATE, so it sees standing composition
   and investment: how much of their ore went into army versus economy, how many workers they kept,
   whether they walled, and what they actually built. That is most of "what kind of game are you
   playing". It cannot see TEMPO from a single snapshot — when they attacked, how often, whether
   they traded — because the sim keeps no player-side history to read. So the fit sets stance and
   investment honestly and leaves timing at its archetype default rather than inventing it; a
   sampled fingerprint over a whole match is the obvious upgrade and is noted in the design doc.
   ============================================================ */

"use strict";

import { UNITS, BUILDINGS } from "./engine/entities.js";
import { isMilitaryBuilding } from "./engine/aiIntel.js";
import { ARCHETYPES } from "./engine/aiArchetypes.js";
import { GENOME_SCHEMA, genomeFrom, geneKeys, toCandidate, MIX_ALPHABET } from "./tools/genome.js";

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** @param {Object} [cost] @returns {number} */
function costValue(cost) {
  if (!cost) return 0;
  let v = 0;
  for (const com of Object.keys(cost)) v += cost[com] || 0;
  return v;
}

/**
 * Measure how `owner` played, from ground truth.
 *
 * T-030: `owner` defaults to "player" deliberately, not `game.localOwner` — this module stays
 * pure and session-free (this file's own header: workable from a Worker, no DOM/session to read),
 * so a caller that wants the LOCAL viewer's own fingerprint (overlays.js's "Save an AI that plays
 * like you") passes `game.localOwner` in explicitly, same as any other caller measuring a
 * specific, known side.
 * @param {State} state @param {string} [owner]
 * @returns {{ posture: number|null, mil: number, eco: number, workers: number, army: number,
 *   turrets: number, barracks: number, bases: number, mix: string[], total: number }}
 */
export function fingerprintPlayer(state, owner = "player") {
  let mil = 0, eco = 0, workers = 0, army = 0, turrets = 0, barracks = 0, bases = 0;
  /** @type {Object.<string, number>} */
  const counts = {};
  for (const u of state.units.values()) {
    if (u.owner !== owner) continue;
    const def = UNITS[u.type];
    if (!def) continue;
    if (def.role === "combat") {
      mil += costValue(def.cost);
      army++;
      // Only alphabet types can become a mix gene — the rest (menders, colony ships) are support,
      // not a production cycle, and a mix entry the AI cannot cycle on would be dead weight.
      if (MIX_ALPHABET.includes(u.type)) counts[u.type] = (counts[u.type] || 0) + 1;
    } else {
      eco += costValue(def.cost);
      if (def.role === "worker") workers++;
    }
  }
  for (const b of state.buildings.values()) {
    if (b.owner !== owner) continue;
    const def = BUILDINGS[b.type];
    if (!def) continue;
    if (isMilitaryBuilding(def)) mil += costValue(def.cost); else eco += costValue(def.cost);
    if (def.attack > 0) turrets++;
    if (b.type === "barracks") barracks++;
    if (def.isCommandCenter) bases++;
  }
  const total = mil + eco;
  return {
    posture: total > 0 ? mil / total : null,
    mil, eco, workers, army, turrets, barracks, bases, total,
    // The mix in DESCENDING count order, so the type they leaned on hardest opens the cycle — which
    // for a production cycle is not cosmetic: it decides what gets built first (tools/genome.js's
    // rotate operator exists because of that). Ties break by name so the fit is deterministic.
    mix: Object.keys(counts).sort((a, b) => counts[b] - counts[a] || (a < b ? -1 : 1)),
  };
}

const geneOf = key => GENOME_SCHEMA.find(g => g.key === key);
const fit = (key, v) => {
  const g = geneOf(key);
  return +clamp(v, g.min, g.max).toFixed(3);
};

/**
 * Fit a genome to a fingerprint — an AI that plays the way this player did.
 *
 * Every dial is set as a RATIO against the archetype's own baseline, never as an absolute, because
 * that is how the engine composes them (archetype × strategy × difficulty): a player who ran 18
 * workers is not "workerTargetMult 18", they are "1.5× what this temperament would have run". The
 * same fit therefore transfers across archetypes and worlds instead of only describing the one it
 * was measured on.
 *
 * Every value is clamped to its own gene's schema bounds, so a fingerprint from an extreme game
 * produces a legal, runnable AI rather than a broken one — the same guarantee mutation has.
 *
 * @param {Object} fp   a fingerprintPlayer result
 * @param {{ archetype?: string, genes?: Object[] }} [opts]
 * @returns {Object} a genome (tools/genome.js shape)
 */
export function genomeFromFingerprint(fp, { archetype = "balanced", genes } = {}) {
  const geneSet = genes || geneKeys({ layers: ["strategy", "archetype"] });
  const base = ARCHETYPES[archetype] || ARCHETYPES.balanced;
  const genome = genomeFrom({ archetype, genes: geneSet });

  // ECONOMY — how much labour they kept, relative to what this temperament would have.
  if (fp.workers > 0 && base.workerTarget)
    genome.strategy.workerTargetMult = fit("workerTargetMult", fp.workers / base.workerTarget);

  // STATIC DEFENCE — did they wall? Against a baseline archetype that wants none (a Rusher's
  // turretCount is 0), fall back to a flat count so "they built four turrets" is still expressible.
  if (base.turretCount > 0) genome.strategy.turretCountMult = fit("turretCountMult", fp.turrets / base.turretCount);
  else if (fp.turrets > 0) genome.archetype.turretCount = fit("turretCount", fp.turrets);

  // STANCE — the headline. A player whose ore went overwhelmingly into economy is one who does not
  // start fights, and the AI that plays like them should not either. Deliberately a HIGH bar
  // (posture below 0.2, i.e. four fifths economy): "never initiates" is a strong claim about
  // someone, and a merely economy-leaning player who did fight should not be turned into a turtle.
  if (fp.posture != null) {
    genome.strategy.neverInitiates = fp.posture < 0.2;
    // …and how hard they committed when they did. A war-heavy player attacks with more, and sooner.
    genome.strategy.armyAttackSizeMult = fit("armyAttackSizeMult", 0.5 + fp.posture * 1.5);
    genome.strategy.attackTimeoutMult = fit("attackTimeoutMult", 1.4 - fp.posture);
    // A visibly aggressive player punishes greed readily; a builder rarely goes looking.
    genome.strategy.punishPosture = fit("punishPosture", 0.15 + fp.posture * 0.5);
  }

  // COMPOSITION — the most directly observable gene there is: what they ACTUALLY built. No fitting
  // or inference, just their own army read back as a production cycle.
  if (fp.mix.length >= 2) genome.archetype.unitMix = [...fp.mix];

  // EXPANSION — more than one base means someone who takes ground.
  if (fp.bases > 1) genome.archetype.expandWhenNodesBelow = fit("expandWhenNodesBelow", 0.45);

  // PRODUCTION CAPACITY they actually used.
  if (fp.barracks > 0) genome.archetype.maxBarracks = fit("maxBarracks", fp.barracks);
  return genome;
}

/**
 * The whole path in one call: measure a player and hand back a runnable candidate that plays like
 * them, in exactly the `{ name, strategy, overrides, archetype }` shape the competition roster,
 * tools/duelCore.js and tools/ailab.js all already take.
 *
 * @param {State} state
 * @param {{ owner?: string, name?: string, archetype?: string }} [opts]
 * @returns {{ candidate: Object, fingerprint: Object, genome: Object }}
 */
export function mirrorOfPlayer(state, { owner = "player", name = "Your Mirror", archetype = "balanced" } = {}) {
  const fingerprint = fingerprintPlayer(state, owner);
  const genes = geneKeys({ layers: ["strategy", "archetype"] });
  const genome = genomeFromFingerprint(fingerprint, { archetype, genes });
  return { candidate: toCandidate(genome, name, { genes }), fingerprint, genome };
}
