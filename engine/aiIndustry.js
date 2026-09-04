/* ============================================================
   AI — the Odyssey industrial build order: power the base and electrify it,
   then (a patient developer only) climb the factory chain, work the Datacenter
   tech tree, and reach the capital path (Star Dock → Leviathan) and a Plasma
   Rig. Skirmish is a no-op (the endless gate), so the byte-identical short game
   is untouched. Depends on aiCommon (budget + affordability + builder pick) and
   aiWorkers (wantsDeepIndustry — moved there so its own plannedMix, the unit-mix
   half of "does this AI climb the deep chain", reads the exact same test this
   file's factory climb and industry reserve do).
   ============================================================ */

"use strict";

import { queueProduction } from "./production.js";
import { BUILDINGS, UNITS, canAfford, prereqsMet, isElectrifiable } from "./entities.js";
import { powerCap, powerDraw } from "./industry.js";
import { researchTech } from "./techtree.js";
import { supplyUsed, supplyCap } from "./supply.js";
import { canAct, spend, canAffordKeeping, tryBuild, controllerFor } from "./aiCommon.js";
import { wantsDeepIndustry } from "./aiWorkers.js";
import { difficultyFor } from "./aiDifficulty.js";
import { strategyFor } from "./aiStrategy.js";

// The industrial build order the AI climbs (Odyssey), lowest tier first. prereqsMet gates each on
// its `requires` (an earlier factory + a research node), so the AI can only raise the next one once
// the chain and the tech beneath it are in place — a Smelter and a Datacenter open the tree, then
// each research node unlocks its factory. Deterministic first-buildable pick each think cycle.
//
// 'chemplant'/'fabricator' (docs/improvement-proposals.md "Promote the legacy consumer-goods
// recipes into a trade-industry branch") are folded into this SAME flat, world-independent
// priority order — same as every other entry here (a Reactor is always raised regardless of local
// deposits too) — so a developer AI CAN walk the new branch, not just the existing military/Gate
// spine. chemplant sits right after 'datacenter' (it needs no Smelter/metallurgy at all — see its
// own `requires` in entities.js — so prereqsMet alone decides whether it's actually reachable
// yet); fabricator sits right after 'assembler' (its own recipe needs alloys, so it can only ever
// win this priority race once the metallurgy branch has already supplied one). This does NOT bias
// the AI toward biomass-rich worlds specifically — a per-world "lean into this branch when biomass
// is abundant" heuristic is a reasonable follow-up, left out here since every other entry in this
// array is equally world-blind.
const INDUSTRY_CHAIN = ["smelter", "datacenter", "chemplant", "assembler", "fabricator", "chipfab",
                        "machineworks", "antimatterforge", "aifoundry", "torpedoworks"];

// The tech path the AI's Datacenter works through, lowest tier first: the passives that lift its
// industry (Fusion Containment power, Factory Automation rate, Heavy Alloys yield) interleaved with
// the unlock nodes that open the next factory (Metallurgy→Assembler, Microelectronics→Chip Fab,
// Precision Machining→Machine Works, Antimatter Containment→Forge, Machine Minds→AI Foundry).
//
// 'chemistry'/'consumerfab' slot in right after 'metallurgy': a genuinely separate branch (per
// engine/techtree.js, chemistry has no requires of its own) that a developer AI now researches
// early rather than only after the whole existing spine — mirroring INDUSTRY_CHAIN's placement
// of chemplant/fabricator just above.
const RESEARCH_ORDER = ["metallurgy", "chemistry", "consumerfab", "reactors", "electronics",
                        "automation", "heavyalloys", "machining", "antimatter", "aicores"];

// EASY STRATEGIC CEILING (engine/aiDifficulty.js strategicCeiling; docs/improvement-proposals.md
// "An Easy strategic ceiling"): sliced ONCE off the same two flat lists everyone else climbs —
// everything up to and including Machine Works/Precision Machining stays open (the full T2/T3
// factory economy), but antimatterforge/'antimatter' Containment onward never appear as a
// candidate. That transitively withholds the Star Dock, the Leviathan, the Helium Bomb, the
// Plasma Rig (it needs the AI Foundry, itself past the cut) and — Phase 7 — a rival Antimatter
// Gate, since every one of those sits downstream of this same chain. Medium/Hard read the
// untouched arrays back by identity (no strategicCeiling flag ⇒ no slice), so they're byte-
// identical to before this feature. Fixed array indices, no clock/RNG — deterministic.
const EASY_INDUSTRY_CHAIN = INDUSTRY_CHAIN.slice(0, INDUSTRY_CHAIN.indexOf("antimatterforge"));
const EASY_RESEARCH_ORDER = RESEARCH_ORDER.slice(0, RESEARCH_ORDER.indexOf("antimatter"));
const industryChainFor = (state, owner = "ai") => difficultyFor(state, owner).strategicCeiling ? EASY_INDUSTRY_CHAIN : INDUSTRY_CHAIN;
const researchOrderFor = (state, owner = "ai") => difficultyFor(state, owner).strategicCeiling ? EASY_RESEARCH_ORDER : RESEARCH_ORDER;

// THE RIVAL GATE (docs/improvement-proposals.md "the galaxy's strongest faction races its own
// wonder" + "a fully-teched neighbour races its own Antimatter Gate", merged per the Phase 7
// plan). RECONCILED TRIGGER — both twins' conditions, combined with AND: the concrete,
// testable half from the AI twin (the Strategic tier standing — antimatter_gate's own
// `requires`, exactly what prereqsMet already checks — plus a genuine strategic-goods
// investment banked, not just the tier existing for an instant) AND the pacing gate both
// twins agree on in different words (the Defense twin's "once its strategic chain stands" is
// already only ever true for a wantsDeepIndustry world by construction — the deep-industry
// block above returns before this is ever reached otherwise — while the AI twin spells out
// the SAME idea explicitly plus a Hard-difficulty alternative, "so it stays an event, not a
// default"). Exported so engine/galaxy.js's rival-gate scan (selection/tracking) and this
// file's own tests can evaluate the trigger standalone, without needing "already inside the
// deep-industry block" to hold — a correct, self-contained predicate in ANY calling context.
//
// The Easy strategicCeiling flag (engine/aiDifficulty.js) is checked here explicitly too, not
// just relied on transitively: an Easy neighbour's own INDUSTRY_CHAIN slice already can never
// reach antimatterforge/aifoundry/torpedoworks in the first place, so prereqsMet below would
// already fail for it — but the explicit check makes the invariant hold BY CONSTRUCTION of
// this function, not merely by the accident of an upstream gate never having been bypassed.
export const RIVAL_GATE_BUFFER = 30;   // ai + antimatter + plasmatorp combined, in stock (~1/3 of a full 150s charge)

/** @param {State} state @param {string} [owner] defaults to "ai" — every pre-existing call site
 *  (engine/galaxy.js's background-colony scan, this file's own aiIndustry, and the whole
 *  test/rivalgate.test.js suite) reads exactly as before; a self-play "player" controller in a
 *  hypothetical Odyssey run would pass its own owner instead. */
export function rivalGateEligible(state, owner = "ai") {
  if (!state.endless) return false;
  const df = difficultyFor(state, owner);
  if (df.strategicCeiling) return false;
  if (!prereqsMet(state, owner, BUILDINGS.antimatter_gate)) return false;
  const res = state.players[owner].resources;
  let banked = 0;
  for (const com in BUILDINGS.antimatter_gate.feed) banked += res[com] || 0;
  if (banked < RIVAL_GATE_BUFFER) return false;
  const controller = controllerFor(state, owner);   // T-042
  return df.mult === "hard" || wantsDeepIndustry(state, controller.archetype, strategyFor(state, owner), owner);
}

// How many chain buildings get a BANKING reserve before the AI is expected to fund the rest from
// genuine surplus (aiIndustryReserve, below). Two — the Smelter and the Datacenter — is the set
// that opens the tree; past them the AI has industrial income and a longer reserve would just
// freeze its army for the whole climb.
const INDUSTRY_BOOTSTRAP = 2;

// The ore the AI must BANK this cycle to get its industry off the ground. runAI calls this between
// aiBaseAndTech and aiProduceAndFortify, because the phase order is production-first,
// industry-last with no holdback between them — so an archetype whose units are cheap relative to
// its income spent its ore down below a Reactor's 120 every think cycle and never developed at
// all. Measured: a Rusher world still on one industrial building after 60 sim-minutes, and Hard's
// rusherGraduates landing ~30 minutes past its own 20-minute trigger
// (docs/odyssey-ai-review.md §2.4).
//
// This mirrors ctx.foundryReserve exactly, including that it is BOUNDED: the power grid (every
// archetype needs one) plus the first INDUSTRY_BOOTSTRAP chain buildings. Past that the reserve
// is zero and the deep climb is bought from surplus, as before — the army is never frozen for the
// length of an eight-building chain. Skirmish is a no-op, same endless gate as aiIndustry itself.
/** @param {State} state @param {AiContext} ctx */
export function aiIndustryReserve(state, ctx) {
  ctx.industryReserve = 0;
  if (!state.endless) return;
  const { cc, barracks, buildings, archetype, strategy, owner } = ctx;
  if (!cc || !barracks || barracks.constructing) return;   // same preconditions aiIndustry itself waits on
  const reactors = buildings.filter(b => b.type === "reactor");
  if (!reactors.length) { ctx.industryReserve = BUILDINGS.reactor.cost.ore; return; }
  if (reactors.some(b => b.constructing)) return;          // one already on the way — aiIndustry won't start a second
  if (!wantsDeepIndustry(state, archetype, strategy, owner)) return;
  const chain = industryChainFor(state, owner);
  if (buildings.filter(b => chain.includes(b.type)).length >= INDUSTRY_BOOTSTRAP) return;
  const next = chain.find(t => !buildings.some(b => b.type === t) && prereqsMet(state, owner, BUILDINGS[t]));
  if (next) ctx.industryReserve = BUILDINGS[next].cost.ore;
}

// Odyssey INDUSTRY: power the base and electrify it, then (a patient developer only) climb the
// factory chain and research the tech tree — the AI using the new economy. Skirmish is a no-op (the
// endless gate), so the byte-identical short game is untouched. Everything is APM-budgeted and
// reserve-aware, and runs after unit production so it's built from surplus — the army never freezes
// while the AI develops.
/** @param {State} state @param {AiContext} ctx */
export function aiIndustry(state, ctx) {
  if (!state.endless) return;   // Odyssey only — a skirmish never builds industry
  const { cc, barracks, workers, ai, buildings, archetype, strategy, army, bombs, owner } = ctx;
  if (!cc || !barracks || barracks.constructing || workers.length === 0) return;

  const reactors = buildings.filter(b => b.type === "reactor");
  const hasReactor = reactors.some(b => !b.constructing);
  const cap = powerCap(state, owner), draw = powerDraw(state, owner);

  // POWER: raise a Reactor when there's none yet (electrification and the factories need a grid) or
  // the grid is running tight (draw crowding cap), so Power scales with the industry the AI adds.
  // ONE AT A TIME — a Reactor takes 16s to finish and powerCap counts only completed ones, so without
  // the in-flight guard the AI keeps re-triggering "grid tight" every think cycle and over-builds a
  // dozen at once. Wait for the pending one to land, then re-evaluate. Reserve-aware, placed by the CC.
  const reactorPending = reactors.some(b => b.constructing);
  const wantMorePower = !reactors.length || (cap > 0 && draw > cap * 0.85);
  if (wantMorePower && !reactorPending && canAffordKeeping(ai.resources, BUILDINGS.reactor.cost, ctx.oreReserve) && canAct(state, owner)) {
    tryBuild(state, owner, workers, "reactor", cc.x - 60, cc.y + 60);
  }

  // ELECTRIFY: once the grid is live, wire the base's non-power buildings in — 30% faster unit
  // production (Barracks/Command Center) and +30% supply (Habitat). One per think cycle, APM-paced.
  // A pure win for the core army economy; if Power later runs short the boost just tapers (industry.js).
  if (hasReactor) {
    const target = buildings.find(b => !b.constructing && isElectrifiable(b.type) && !b.electrified);
    if (target && canAct(state, owner)) { target.electrified = true; spend(state, owner); }
  }

  // Deeper industry (factory chain + research) is a PATIENT developer's game — the same signal as
  // the Refinery (Economist/Balanced build it; a Rusher does not). A Rusher stops at power+electrify —
  // UNLESS the player-picked strategy overrides it: Economic (aiStrategy.js wantsIndustryAlways) climbs
  // the deep chain regardless of archetype, since pure economy means using every economic capability
  // in the game, even paired with a Rusher/Balanced world that wouldn't normally bother. OR unless
  // it's graduated (Tier 4, engine/aiDifficulty.js rusherGraduates — Hard only): a non-developing
  // archetype whose opening rush is long since resolved one way or the other picks up the same deep
  // chain a patient developer would, rather than sitting on a permanent 2-upgrade ceiling for the rest
  // of what can be an hours-long Odyssey session. Skirmish is untouched regardless — this whole
  // function already returned above on !state.endless, and a skirmish never runs this long anyway.
  // The chain needs the grid, so wait for the Reactor before starting it either way.
  if (!wantsDeepIndustry(state, archetype, strategy, owner) || !hasReactor) return;

  // FACTORY CHAIN: raise the next chain building whose prereqs (its earlier factory + its research
  // node) are met and that the AI doesn't already have, one per think cycle, reserve-aware. Spread
  // in a spiral around the CC so its efficiency grid stays tight (findPlacement slides off collisions).
  const chain = industryChainFor(state, owner);
  const industryCount = buildings.filter(b => chain.includes(b.type) || b.type === "reactor").length;
  const nextFactory = chain.find(t => !buildings.some(b => b.type === t) && prereqsMet(state, owner, BUILDINGS[t]));
  if (nextFactory && canAffordKeeping(ai.resources, BUILDINGS[nextFactory].cost, ctx.oreReserve) && canAct(state, owner)) {
    const ang = industryCount * 2.4, rad = 120 + 18 * industryCount;
    tryBuild(state, owner, workers, nextFactory, cc.x + Math.cos(ang) * rad, cc.y + Math.sin(ang) * rad);
  }

  // RESEARCH: at a completed Datacenter, queue the next unowned node whose prereqs are met (lowest
  // tier first). researchTech already gates prereqs/affordability/dupes, so try each in order and
  // stop at the first that takes — one purchase per think cycle, paid in gathered crystals/radioactives.
  const datacenter = buildings.find(b => b.type === "datacenter" && !b.constructing);
  if (datacenter && canAct(state, owner)) {
    for (const techId of researchOrderFor(state, owner)) {
      if (ai.upgrades[techId]) continue;
      if (researchTech(state, datacenter.id, techId)) { spend(state, owner); break; }
    }
  }

  // CAPITAL PATH: once the whole Strategic tree stands (a Star Dock proves the AI Foundry + Torpedo
  // Works are up), the AI can field LEVIATHANS — a real capital ship (role "combat", so aiMilitary
  // folds it into the waves), the payoff for the deep climb and the sink for its strategic goods.
  // One Star Dock, reserve-aware.
  const hasStardock = buildings.some(b => b.type === "stardock");
  if (!hasStardock && prereqsMet(state, owner, BUILDINGS.stardock)
      && canAffordKeeping(ai.resources, BUILDINGS.stardock.cost, ctx.oreReserve) && canAct(state, owner)) {
    tryBuild(state, owner, workers, "stardock", cc.x + 120, cc.y - 90);
  }
  // Train a Leviathan at a completed, idle Star Dock when the manufactured strategic goods (AI Cores
  // + Plasma Torpedoes) are on hand and there's supply for the 8-supply capital ship. queueProduction
  // re-checks cost/supply/prereqs, so this only ever fires when it truly can.
  const stardock = buildings.find(b => b.type === "stardock" && !b.constructing);
  if (stardock && stardock.queue.length === 0 && canAct(state, owner)
      && supplyUsed(state, owner) + (UNITS.leviathan.supplyCost || 0) <= supplyCap(state, owner)
      && canAfford(ai.resources, UNITS.leviathan.cost)) {
    if (queueProduction(state, stardock.id, "leviathan")) spend(state, owner);
  }

  // HELIUM BOMB: the doomsday device beside the Leviathan at the same Star Dock (entities.js
  // stardock.produces) — at most one, and only once a Leviathan is already up or training, so it
  // never crowds out the capital-ship investment above. Every strategy gets a use for it (see
  // engine/aiSuperweapon.js: a built bomb becomes a home-defense trap the instant the AI is
  // attacked); Aggressive strategy also walks it into the enemy's lines. Reserve-aware like every
  // other Star Dock spend; gas is the one NEW cost commodity it needs beyond what a Leviathan-
  // capable base already produces, so it simply never completes on a gas-less world (accepted,
  // same graceful degradation as every other specialty-commodity unit on the roster).
  const hasLeviathan = army.some(u => u.type === "leviathan") || (stardock && stardock.queue.some(j => j.unitType === "leviathan"));
  if (stardock && stardock.queue.length === 0 && bombs.length === 0 && hasLeviathan && canAct(state, owner)
      && supplyUsed(state, owner) + (UNITS.heliumbomb.supplyCost || 0) <= supplyCap(state, owner)
      && canAfford(ai.resources, UNITS.heliumbomb.cost)) {
    if (queueProduction(state, stardock.id, "heliumbomb")) spend(state, owner);
  }

  // PLASMA RIG: an unlimited ore source for the late game, once the AI has the AI Foundry (its pilot)
  // and a Reactor (its plasma grid). Expensive and high-tech — ore + manufactured machinery/
  // electronics/AI Cores — so it's a genuine late investment; one only, from surplus.
  const hasRig = buildings.some(b => b.type === "plasmarig");
  if (!hasRig && prereqsMet(state, owner, BUILDINGS.plasmarig)
      && canAffordKeeping(ai.resources, BUILDINGS.plasmarig.cost, ctx.oreReserve) && canAct(state, owner)) {
    tryBuild(state, owner, workers, "plasmarig", cc.x - 120, cc.y - 90);
  }

  // THE RIVAL GATE: once rivalGateEligible (above) — the Strategic tier standing, a real
  // strategic-goods buffer banked, and Hard difficulty or a wantsDeepIndustry temperament — the
  // AI races its OWN Antimatter Gate, the merged Defense+AI twin proposal (docs/improvement-
  // proposals.md lines 667-675, 689-697). One Gate, reserve-aware, from surplus, spaced away from
  // the rest of the base like every other factory here. engine/wonder.js's updateWonder is
  // already owner-generic (it reads building.owner's own resources), so charging it afterward
  // needs no code here at all — this is the only place the AI's own Gate gets founded.
  const hasGate = buildings.some(b => b.type === "antimatter_gate");
  if (!hasGate && rivalGateEligible(state, owner)
      && canAffordKeeping(ai.resources, BUILDINGS.antimatter_gate.cost, ctx.oreReserve) && canAct(state, owner)) {
    tryBuild(state, owner, workers, "antimatter_gate", cc.x - 150, cc.y + 150);
  }
}
