/* ============================================================
   Scripted AI opponent: keep workers on the nearest spendable node, keep
   population growing, put up a Barracks once it can afford one, then cycle
   through its archetype's unit mix (Skiff/Bastion/Lancer/Breacher — see
   entities.js for the rock-paper-scissors relationship) across every
   Barracks it owns, and throw its home army at the enemy base in
   repeated waves, once each wave is big enough (or the game's dragged on
   long enough that it should commit anyway). Along the way it fortifies
   with Sentinel Turrets on the approach vector, expands to a second
   Command Center when its home ore runs thin, puts up a Refinery, and
   researches both upgrades — so its opponent isn't the only side that gets
   to use crystals/radioactives, expansions, or defenses.

   The AI plays under its own fog of war (state.fogs[owner], never a
   hardcoded state.fogAI) — it is NOT omniscient. It keeps one unit out
   scouting (updateScout), and its intel-dependent moves are gated by what
   it has actually seen: every few units it breaks from the mix to counter
   whatever the enemy fields most, but only counting enemy units currently
   in its vision (counterToPlayerArmy); and it only mines or expands to
   nodes it has discovered — charted surface deposits always, hidden caches
   once scouted. The rest of the cycle follows the archetype's own flavor,
   so a Rusher doesn't turn into a pure reactive counter-picker.

   How aggressively vs. how patiently it plays — worker/army targets, attack
   timing, unit mix, how many turrets and barracks, when to expand — all comes
   from its controller's `archetype` (see engine/aiArchetypes.js), which is
   picked by which planet the match is on. This file just executes whatever
   profile it's handed; every Tier 4 field is read with a use-site default so
   a legacy profile that predates them still runs.

   Layered on top of the archetype is the controller's `strategy` (engine/
   aiStrategy.js) — a player-picked overlay (setup.js "AI Strategy"), orthogonal
   to which planet/archetype it's facing: Aggressive presses the attack earlier
   and forces the issue in Odyssey; Economic keeps a minimal standing army until
   it's actually attacked, then surges; Force Parity continuously matches
   whatever it's seen of the enemy's army. "default" (unset) reproduces today's
   pure archetype-driven play byte-for-byte — every multiplier defaults to 1 and
   every flag to falsy.

   TIER 1 SELF-PLAY (tools/selfplay.js — a headless bench, never the shipped
   game): runAI(state, dt, owner) drives EITHER side. owner defaults to "ai",
   so every pre-existing call site (engine/sim.js's per-tick runAI(state, dt),
   every one of the ~26 test files that touch state.ai) gets exactly today's
   behavior, unchanged. Passing owner="player" instead drives a SECOND,
   independently-configured controller for the human seat — state.playerAi,
   null unless a caller has populated it — with its own archetype/strategy/
   difficulty/APM/action budget, reading state.fogs.player (never state.fogAI)
   everywhere it looks at the world. state.ai and its exact meaning for owner
   "ai" are completely untouched by any of this. See aiCommon.js's
   controllerFor/otherOwner for how a phase resolves "my controller" and "my
   opponent" from `owner` alone.

   This file is the ORCHESTRATOR: runAI runs the think-cycle and threads one
   world snapshot (aiContext) through the decision phases, which live in cohesive
   sibling modules so no single file is a 1000-line god object —
     • aiCommon.js     — owner resolution + the APM action budget + reserve-aware affordability + builder pick
     • aiStrategy.js   — the player-picked strategy table (Aggressive/Economic/Force Parity)
     • aiWorkers.js    — idle-worker logistics/gather steering + the unit-mix filters
     • aiMilitary.js   — defend/attack waves, focus-fire, the scout, target/mix picks
     • aiEconomy.js    — base build-out, expansion, tech gates, production, research, market barter
     • aiIndustry.js   — the Odyssey factory chain / power / capital path / rig
     • aiSuperweapon.js — arms/delivers a built Helium Bomb
   The phase order in runAI is load-bearing (shared action budget + ore reserves),
   so it stays here where the whole sequence reads top-to-bottom.
   ============================================================ */

"use strict";

import { UNITS } from "./entities.js";
import { playerBuildings, playerUnits } from "./state.js";
import { accrueActionBudget, controllerFor, opponentsOf } from "./aiCommon.js";
import { assignIdleWorkers } from "./aiWorkers.js";
import { updateScout, aiMilitary, applyFocusFire, visibleThreatsNearHome } from "./aiMilitary.js";
import { aiFoundOrSurvive, aiExpand, aiBaseAndTech, aiProduceAndFortify, aiResearch, aiMarketBarter } from "./aiEconomy.js";
import { aiIndustry, aiIndustryReserve } from "./aiIndustry.js";
import { aiSuperweapon } from "./aiSuperweapon.js";
import { strategyFor } from "./aiStrategy.js";
import { updateIntel, readEnemy, updateAdaptMode } from "./aiIntel.js";
import { adaptivityFor } from "./aiDifficulty.js";

// Sim seconds between one controller's think cycles. EXPORTED so a test can drive an AI function
// at the cadence the game really uses instead of hardcoding its own guess — the gap that let
// aiIntel.js's fade ship a decay two hundred times too steep: its tests jumped state.time in one
// hop, which is correct for a single call and says nothing about the dozens runAI actually makes
// between two sightings. test/_helpers.js's advanceThinkCycles is built on this constant so the
// two can never drift apart.
export const THINK_INTERVAL = 1.5;

/**
 * @param {State} state
 * @param {number} dt
 * @param {string} [owner]   which side to drive — "ai" (default, today's only configuration) or
 *   "player" (Tier 1 self-play only, and only once state.playerAi has been populated — see
 *   tools/selfplay.js). A "player" call with no state.playerAi is a safe, silent no-op.
 */
export function runAI(state, dt, owner = "ai") {
  accrueActionBudget(state, dt, owner);   // every tick, so credits build up between think cycles
  const controller = controllerFor(state, owner);
  if (!controller) return;   // self-play inert: owner "player" with no state.playerAi configured yet
  controller.think = (controller.think || 0) - dt;
  if (controller.think > 0) return;
  controller.think = THINK_INTERVAL;

  // One snapshot of this controller's world, threaded through every decision phase below. Order is
  // load-bearing: each phase can spend from a shared per-cycle action budget (canAct/spend),
  // and an earlier phase can bank ore (ctx.*Reserve) that a later one must leave alone.
  const ctx = aiContext(state, owner);

  // Scout + worker assignment run first — a worker turned scout mustn't then be re-tasked to gather.
  updateScout(state, ctx, ctx.threats.length > 0);
  assignIdleWorkers(state, ctx.workers, ctx.fog);

  aiFoundOrSurvive(state, ctx);    // Odyssey: (re)seat a razed / opening base from a colony ship
  aiExpand(state, ctx);            // scout Ranger + found a second base once home ore thins (sets ctx.oreReserve)
  aiBaseAndTech(state, ctx);       // workers, supply, Barracks, the Foundry/Arsenal tech gates, the Mender
  aiIndustryReserve(state, ctx);   // Odyssey: bank the grid + bootstrap chain BEFORE production can spend it (sets ctx.industryReserve)
  aiProduceAndFortify(state, ctx); // the shared unit-production cycle, Turrets, a 2nd Barracks, Refineries
  aiResearch(state, ctx);          // one doctrine upgrade per think cycle
  aiMarketBarter(state, ctx.owner); // Odyssey, Medium+/Hard only: convert a surplus into this cycle's bottleneck (owner "ai" only — Odyssey/market is out of Tier 1's scope)
  aiIndustry(state, ctx);          // Odyssey: power the base + electrify it (deeper phases: the factory chain)
  aiMilitary(state, ctx);          // defend a pressed base, else muster and commit the next wave
  aiSuperweapon(state, ctx);       // Odyssey: arm/deliver a built Helium Bomb (engine/aiSuperweapon.js)

  // TACTICAL micro (opt-in via aiMicro): concentrate the army's fire on one target so kills land
  // faster and incoming damage drops sooner — layered on top of the wave logic above without
  // touching it. A no-op unless real enemy combat is in sight, so the resolve guarantee holds.
  if (controller.micro) applyFocusFire(state, ctx);
}

// Snapshot `owner`'s world once per think cycle: the archetype (+ an `arch` reader that lets its
// Odyssey overlay win), this controller's own units bucketed by role, its buildings and the key
// ones by type, and the enemy combat pressing home — all read off `owner`'s OWN fog
// (state.fogs[owner]), never a hardcoded side. The three *Reserve fields start at 0 and are the
// running ore holdbacks the phases pass forward. See the AiContext typedef in engine/types.js.
/** @param {State} state @param {string} owner @returns {AiContext} */
function aiContext(state, owner = "ai") {
  const controller = controllerFor(state, owner);
  // T-043: ctx.enemyOwner stays SINGULAR — its only two readers (aiOffense's Odyssey-only
  // playerHasPresence check, updateScout's sweep-bias waypoint) are both low-stakes, pre-existing
  // consumers that never needed N-awareness; every genuine "which target(s)" decision (aiIntel.js's
  // sightEnemy, the aiMilitary.js targeting functions) resolves its own opponentsOf(state, owner)
  // directly rather than reading it off ctx. Kept as "the primary opponent" (first in state.owners
  // order) rather than plumbing an unused ctx.enemyOwners array through for nothing yet reads.
  const enemyOwner = opponentsOf(state, owner)[0] ?? null;
  const fog = state.fogs[owner];
  const archetype = controller.archetype;
  const arch = field => (state.diplomacy && archetype.odyssey && archetype.odyssey[field] != null)
    ? archetype.odyssey[field] : archetype[field];
  const strategy = strategyFor(state, owner);
  const buildings = playerBuildings(state, owner);
  const threats = visibleThreatsNearHome(state, owner);
  // WAR FOOTING (engine/aiStrategy.js Economic strategy): the instant this controller can SEE
  // combat units pressing its base, timestamp it — then for warFootingTime seconds
  // afterward, aiEconomy's standing-army throttle treats it as "recently attacked"
  // and lifts its cap, so being attacked is what turns a minimal economy into a real
  // production push. Updated here (not left to a later phase) so it's consistent for
  // every phase reading ctx.warFooting this same cycle. A strategy without
  // warFootingTime (every strategy but Economic) reads warFooting as permanently false.
  if (threats.length > 0) controller.lastThreatAt = state.time;
  const warFooting = !!strategy.warFootingTime
    && controller.lastThreatAt != null
    && (state.time - controller.lastThreatAt) < strategy.warFootingTime;
  // OPPONENT BELIEF (engine/aiIntel.js): fold this cycle's sighting into the persistent read BEFORE
  // any phase consults it, exactly like warFooting above — so every phase in one cycle reasons
  // about the same picture of the enemy rather than each re-deriving it at a different moment.
  updateIntel(state, owner);
  // …then step the damped STANCE off that belief (aiIntel.js updateAdaptMode). Order matters: the
  // stance must be derived from THIS cycle's sighting, not last cycle's. adaptivity 0 (Easy) pins
  // it at neutral, which makes every consumer below byte-identical to having no stance at all.
  updateAdaptMode(state, owner, adaptivityFor(state, owner));
  return {
    owner, enemyOwner, fog, controller,
    archetype, arch, strategy, warFooting,
    // The read itself, snapshotted once per cycle. `posture` is null until something has actually
    // been seen — a consumer must treat that as "I don't know", never as "they are peaceful".
    enemy: readEnemy(state, owner),
    ai: state.players[owner],
    workers: playerUnits(state, owner).filter(u => u.type === "worker"),
    army: playerUnits(state, owner).filter(u => UNITS[u.type].role === "combat"),
    rangers: playerUnits(state, owner).filter(u => u.type === "ranger"),
    bombs: playerUnits(state, owner).filter(u => u.type === "heliumbomb"),
    buildings,
    cc: buildings.find(b => b.type === "command" && !b.constructing),
    colonyShip: state.endless ? (playerUnits(state, owner).find(u => u.type === "colonyship") || null) : null,
    barracks: buildings.find(b => b.type === "barracks"),
    refinery: buildings.find(b => b.type === "refinery"),
    allBarracks: buildings.filter(b => b.type === "barracks"),
    threats,
    oreReserve: 0, foundryReserve: 0, refineryReserve: 0, industryReserve: 0,
  };
}
