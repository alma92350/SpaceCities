/* ============================================================
   AI — worker assignment and the unit-mix filters. Idle-worker logistics +
   gather steering (assignAiLogistics / assignIdleWorkers), and the map-aware
   mix helpers the production phases read: which unit types this world can
   actually sustain (effectiveMix / affordableOnSurface), whether a developing
   AI's PLANNED mix should extend past its archetype's own tiers (plannedMix /
   wantsDeepIndustry — the shared signal aiEconomy's Foundry/Arsenal gates and
   aiIndustry's factory climb both key off), and which upgrade doctrine its
   economy favours (aiDoctrine). A leaf module for the other AI PHASE modules
   (aiMilitary/aiEconomy/aiIndustry import from it freely, never the reverse)
   — it only reaches sideways into two pure-data tables of its own,
   aiStrategy.js and aiDifficulty.js, neither of which imports anything back.
   ============================================================ */

"use strict";

import { BUILDINGS, UNITS, prereqsMet, SPENDABLE } from "./entities.js";
import { assignService, assignHaul, countLogistics } from "./haul.js";
import { assignRepair, countRepairJobs } from "./repair.js";
import { isNodeDiscovered } from "./fog.js";
import { strategyFor } from "./aiStrategy.js";
import { difficultyFor } from "./aiDifficulty.js";

const SATURATION_STEER = 250;     // distance-equivalent penalty per worker a node is over the soft cap

// SPENDABLE (entities.js): every commodity that anything the AI builds actually costs.
// assignIdleWorkers prefers nodes of these types so a poor-economy world's AI
// (Glacius: ice/gas it can never spend) doesn't mine dead-end commodities.

// Give a BOUNDED share of the AI's idle workers real logistics jobs — servicing factories (carry
// inputs in, outputs out), hauling pure producers (the Plasma Rig) to a Command Center, and
// repairing a damaged own building — reusing the exact owner-generic, zone-first machinery the
// player's workers use (engine/haul.js, engine/repair.js). Capped at HALF the worker pool so
// gathering never starves: a factory with no raws mined is no better off than one with no servers,
// so the AI must keep miners on the field too. Deterministic — countLogistics/countRepairJobs
// freeze the committed slots first, then assignService/assignHaul/assignRepair claim the nearest
// free slot in the AI's own Command Center zone first (ties by id). Odyssey-only (industry is
// odysseyOnly); the player's own auto-haul path (engine/sim.js) is untouched.
export function assignAiLogistics(state, workers) {
  if (!workers.length) return;
  countLogistics(state);     // fresh committed haul/service tallies before we claim any new slots this cycle
  countRepairJobs(state);    // …and repair tallies too
  let budget = Math.floor(workers.length / 2)
    - workers.filter(w => w.order && (w.order.type === "service" || w.order.type === "haul" || w.order.type === "repair")).length;
  if (budget <= 0) return;
  for (const w of workers) {
    if (budget <= 0) break;
    if (w.order) continue;
    assignService(state, w);              // sets w.order to a factory service round-trip if one needs it
    if (!w.order) assignHaul(state, w);   // …else haul a backed-up pure producer (the rig)
    if (!w.order) assignRepair(state, w); // …else patch a damaged own building
    if (w.order) budget--;
  }
}

// The node-picking half of idle-gather assignment, generalised over OWNER (the AI's own fog,
// state.fogAI, vs the player's, state.fog) — see assignIdleWorkers (AI) and assignIdlePlayerGather
// (a background colony's worker-sustain policy, engine/colonyPolicy.js) below, the two thin
// owner-specific wrappers. Kept as one function so the node-picking logic (soft-cap spreading,
// the secondary-commodity trickle cap) can never drift between the two callers.
function idleGatherAssign(state, fog, workers) {
  // Only nodes this owner actually knows about: charted surface deposits (always) plus any
  // hidden cache they've scouted.
  const live = state.map.nodes.filter(n => n.amount > 0 && isNodeDiscovered(fog, n));
  if (!live.length) return;
  const oreLive = live.filter(n => n.com === "ore");
  const otherLive = live.filter(n => n.com !== "ore" && SPENDABLE.has(n.com));
  const nodeById = state.map.nodesById || new Map(state.map.nodes.map(n => [n.id, n]));
  let secondaryMiners = 0;
  for (const w of workers) {
    const n = w.order && w.order.type === "gather" ? nodeById.get(w.order.nodeId) : null;
    if (n && n.com !== "ore" && SPENDABLE.has(n.com)) secondaryMiners++;
  }
  // Crystals/radioactives buy only optional extras (a couple of turrets, the
  // one-time upgrades, the occasional Breacher), so a small trickle funds them
  // — everyone else stays on ore, the currency the whole army and every
  // building actually run on. A flat "half on ore" split would over-divert on
  // an ore-rich world and under-fund ore on an ore-poor one; capping the
  // secondary crew keeps ore primary everywhere while still reaching the
  // extras. On a crystal-heavy map (Helix) this is what stops workers piling
  // onto crystals and starving the ore the army needs.
  const secondaryCap = Math.min(2, Math.floor(workers.length / 3));

  // Projected miner tally per node, so the assignment fills a node to the soft cap and
  // then hops to the next-nearest instead of piling everyone on one seam (which
  // saturation would drop to ~0.7 efficiency, slowing the tuned economy). Seeds
  // from workers already on a gather order, and counts each assignment made in
  // this same pass so consecutive idle workers spread across nodes.
  const softCap = UNITS.worker.minerSoftCap ?? Infinity;
  const projected = new Map();
  for (const w of workers) {
    if (w.order && w.order.type === "gather") projected.set(w.order.nodeId, (projected.get(w.order.nodeId) || 0) + 1);
  }

  workers.forEach(w => {
    if (w.order) return;
    let pool;
    if (otherLive.length && oreLive.length && secondaryMiners < secondaryCap) {
      pool = otherLive; secondaryMiners++;   // fund the extras with a small crew...
    } else if (oreLive.length) {
      pool = oreLive;                         // ...but keep the bulk of workers on ore
    } else {
      pool = otherLive.length ? otherLive : live;   // ore's gone — take spendable, else any live node
    }
    let best = null, bestScore = Infinity;
    for (const n of pool) {
      const m = projected.get(n.id) || 0;
      const over = Math.max(0, m + 1 - softCap);   // penalty kicks in once the node is already at the cap
      const score = Math.hypot(n.x - w.x, n.y - w.y) + over * SATURATION_STEER;
      if (score < bestScore) { bestScore = score; best = n; }
    }
    if (best) {
      w.order = { type: "gather", nodeId: best.id };
      projected.set(best.id, (projected.get(best.id) || 0) + 1);
    }
  });
}

// `fog` is required (T-018/ADR-0008: no hardcoded-owner default) — its one caller (engine/ai.js)
// already passes ctx.fog, its own controller's own discovered nodes, never a specific owner's fog
// on another's behalf — see the fog-fairness discipline this whole module's header comment
// already documents.
export function assignIdleWorkers(state, workers, fog) {
  // ODYSSEY: the AI runs REAL logistics like the player — dedicate a bounded share of workers to
  // feeding/clearing its factories and rig (finite buffers, stalls and all) before the gather pass, so
  // its industry pays the same labour cost the player's does. Skirmish has no factories → no-op there.
  if (state.endless) assignAiLogistics(state, workers);
  idleGatherAssign(state, fog, workers);
}

// The PLAYER-side twin of assignIdleWorkers' gather half — reused by a background colony's
// worker-sustain standing order (engine/colonyPolicy.js), which re-tasks idle player workers on a
// world nobody's driving. Reads the PLAYER's own fog (state.fog), not the AI's, and deliberately
// skips assignAiLogistics (haul/service/repair): sustaining workers just means putting idle hands
// back on a node, not opting a colony into the AI's own factory-servicing behaviour.
export function assignIdlePlayerGather(state, workers) {
  idleGatherAssign(state, state.fog, workers);
}

// Tier 4 (engine/aiDifficulty.js rusherGraduates, Hard only): how long into an Odyssey world a
// non-developing archetype's opening rush has clearly either succeeded or become a non-factor —
// past this, on Hard, it graduates into a patient developer rather than staying a permanent
// flatline for the rest of what can be an hours-long session. Pure time, no wave-outcome
// tracking needed: if the game is still running this far in, "wait for the rush to resolve, then
// judge it" and "just check the clock" converge on the same answer.
const RUSHER_GRADUATE_TIME = 1200;   // 20 minutes

// Does this AI climb past power+electrify into the deep chain (engine/aiIndustry.js) — and, by the
// same signal, extend its PLANNED unit mix past its archetype's own tiers (plannedMix, below)? The
// patient-developer signal (archetype.wantsRefinery), the Economic strategy's override, or Hard's
// rusher graduation. Lives here (moved from aiIndustry.js) rather than there, so this file's own
// plannedMix — the unit-mix half of "does this AI climb the deep chain" — and aiIndustry's factory
// climb + industry reserve read the exact same test; aiIndustry now imports this instead of
// defining it (see its own header comment). Leaf-safe: aiStrategy.js and aiDifficulty.js are both
// pure data tables with no imports of their own, so reaching into them here creates no cycle.
export function wantsDeepIndustry(state, archetype, strategy, owner = "ai") {
  // `owner` matters: difficultyFor defaults to the "ai" controller, so in self-play the asking
  // controller's graduation used to be decided by the OTHER side's difficulty. Defaulting to "ai"
  // keeps every single-owner caller byte-identical.
  const graduated = !!difficultyFor(state, owner).rusherGraduates && state.time > RUSHER_GRADUATE_TIME;
  return !!(archetype.wantsRefinery || strategy.wantsIndustryAlways || graduated);
}

// GRADUATE EXTENSION (docs/improvement-proposals.md "Graduation reaches the army"): a developing AI
// (wantsDeepIndustry) climbs aiIndustry's Foundry/Arsenal chain, but a pure Tier-1 mix — today, only
// the Rusher's — never mentions a single gated unit, so aiEconomy's wantsFoundry/wantsArsenal
// (computed off the mix) stayed false even for a graduated Hard Rusher: it could reach a Star Dock
// and field Leviathans while its Barracks cycled Skiff/Bastion forever. Appended ONCE — and only
// when the base mix has no Foundry-gated entry of its own — so an Economist/Balanced mix (which
// already carries a Lancer or Breacher) is a genuine no-op here; only a pure Tier-1 profile picks
// this up.
const GRADUATE_EXTENSION = ["lancer", "lancer", "dreadnought"];

// The archetype's PLANNED unit mix — its base unitMix, extended with GRADUATE_EXTENSION for a
// developing/graduated AI (see above) — BEFORE effectiveMix's prereq/afford filtering, which runs
// on top of this unchanged. That keeps the extension deadlock-free: a planned Lancer only ever
// enters the AI's ACTUAL cycle once the Foundry it now motivates aiEconomy to build has completed
// (prereqsMet), exactly like every other gated entry already works. Skirmish is untouched: the
// state.endless gate means a skirmish's planned mix is always exactly archetype.unitMix, whatever
// the difficulty or elapsed time — the short game stays byte-identical.
export function plannedMix(state, archetype, owner = "ai") {
  const base = archetype.unitMix || [];
  if (!state.endless) return base;
  if (!wantsDeepIndustry(state, archetype, strategyFor(state, owner), owner)) return base;
  if (base.some(t => (UNITS[t]?.requires || []).includes("foundry"))) return base;   // already reaches the Foundry on its own
  return [...base, ...GRADUATE_EXTENSION];
}

// The AI's planned unit mix (plannedMix, above) with entries this map can never pay for dropped —
// a cost commodity no SURFACE deposit produces (Vesper's surface has no
// radioactives, so its Breacher entry is skipped, leaving today's exact
// three-unit cycle). Hidden caches are deliberately excluded: they can hold a
// commodity the surface lacks, but they're far, contested, and may never be
// mined, so planning the whole cycle around one would just re-stall the mix on
// a unit the AI has no steady income for. Surface EXISTENCE, not remaining
// amount, is checked, so the surviving cycle is constant for the whole match
// (nodes drain, they never vanish) and the sequence stays deterministic. Falls
// back to plain Skiffs if the filter empties the mix entirely.
// Also drops any unit whose TECH prereqs aren't met yet (Lancer/Breacher before
// the Foundry is up), so the cycle runs Skiff/Bastion only until then and never
// stalls on a locked entry — pickNextUnitType can only ever return an unlocked,
// affordable unit. This makes the mix change ONCE, deterministically, the tick
// the Foundry completes; both the base cycle and the counter-pick (which only
// adopts a counter that mix.includes) are prereq-safe through this one filter.
// A graduated Rusher's Lancer/Dreadnought graduate entries are no exception — they're filtered by
// this exact same prereqsMet check, so they enter the cycle only once their own gate is built.
// `owner` defaults to "ai" so every pre-existing call site (this file's own maxSupplyDemand, every
// test, tools/ailab.js) reads exactly as before. A self-play "player" controller passes its own
// ctx.owner instead — prereqsMet must check THAT owner's own completed buildings (its own Foundry/
// Arsenal), never the "ai" owner's: without this, the second controller's mix would silently gate
// on the FIRST controller's tech, either locking it out of units it can actually build or (worse)
// "unlocking" ones it can't, a correctness bug on top of the fairness one.
export function effectiveMix(state, archetype, owner = "ai") {
  const mix = plannedMix(state, archetype, owner).filter(t =>
    UNITS[t]
    && BUILDINGS.barracks.produces?.includes(t)
    && prereqsMet(state, owner, UNITS[t])
    && affordableOnSurface(state, t));
  return mix.length ? mix : ["skiff"];
}

// The biggest SUPPLY cost the AI could actually try to pay next: the largest entry in this
// world's effective mix, plus anything a completed Star Dock can build (Odyssey's 8-supply
// Leviathan). aiEconomy's Habitat trigger is sized from this rather than from a flat 2, because
// pickNextUnitType retries the SAME mix entry until it succeeds — so a free-supply gap that's
// wide enough to skip the old `cap - 2` trigger but too narrow for a 4- or 8-supply unit is a
// hard deadlock: production can't queue, and the Habitat that would unblock it never fires.
// (Measured on a 50-minute Odyssey world — docs/odyssey-ai-review.md §2.2.) Floored at 2, so a
// world whose mix is all 1- and 2-supply units keeps exactly its old timing.
export function maxSupplyDemand(state, archetype, owner = "ai") {
  let max = 2;
  for (const t of effectiveMix(state, archetype, owner)) max = Math.max(max, UNITS[t].supplyCost || 0);
  // A Star Dock's capital ships are queued by aiIndustry, which SKIPS rather than retrying when
  // they don't fit — no deadlock there, but the headroom still has to arrive eventually or the
  // deep-industry payoff is unreachable. Only counted once the Star Dock actually stands.
  for (const b of state.buildings.values()) {
    if (b.owner !== owner || b.type !== "stardock" || b.constructing) continue;
    for (const t of BUILDINGS.stardock.produces || []) max = Math.max(max, UNITS[t]?.supplyCost || 0);
    break;
  }
  return max;
}

// Can the AI pay for `unitType` from this world's STEADY income — i.e. does every
// cost commodity have a non-hidden (surface) deposit somewhere on the map? Shared
// by effectiveMix (which unit types actually cycle) and the Foundry/Arsenal
// "wants" gates below. Deliberately NOT prereq-aware: the gates use it to decide
// whether teching up would ever pay off, so folding in the building prereq would
// deadlock (you'd never build the Arsenal a gas-Wraith needs because the Wraith
// is prereq-locked until the Arsenal exists). ore/crystals/radioactives are
// seeded near every base (map.js MIN_GUARANTEE), so only the specialty commodities
// (gas/ice/relics) actually gate anything here.
export function affordableOnSurface(state, unitType) {
  const def = UNITS[unitType];
  return !!def && Object.keys(def.cost).every(com => state.map.nodes.some(n => n.com === com && !n.hidden));
}

// Which upgrade doctrine the AI commits to. It prefers its archetype's flavour
// (rusher/balanced Assault, economist Bulwark), but follows the world's economy
// when that world is clearly richer in the OTHER doctrine's commodity — Assault
// runs on radioactives, Bulwark on crystals — so it doesn't build a Refinery it
// can't actually research on a world short of its preferred commodity. Surface
// deposits only (mirrors effectiveMix): steady income, not a contested cache.
export function aiDoctrine(state, archetype) {
  const surfaceTotal = com => state.map.nodes
    .filter(n => n.com === com && !n.hidden).reduce((s, n) => s + n.max, 0);
  const rad = surfaceTotal("radioactives"), cry = surfaceTotal("crystals");
  const pref = archetype.doctrine || "assault";
  if (pref === "assault") return rad >= cry * 0.6 ? "assault" : "bulwark";
  return cry >= rad * 0.6 ? "bulwark" : "assault";
}
