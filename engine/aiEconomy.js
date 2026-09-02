/* ============================================================
   AI — the economic build order: (re)seat a base from a colony ship, expand to
   fresh ore, raise workers/supply/Barracks and the Foundry+Arsenal tech gates,
   run the shared unit-production cycle with Turrets and the Refinery, and
   research the doctrine. Depends on aiCommon (budget + affordability), aiWorkers
   (affordableOnSurface / aiDoctrine / maxSupplyDemand / plannedMix) and aiMilitary
   (pickNextUnitType); nothing depends back on this module, so the import graph
   stays acyclic.
   ============================================================ */

"use strict";

import { queueProduction, researchUpgrade } from "./production.js";
import { issueMove } from "./commands.js";
import { findPlacement } from "./colliders.js";
import { BUILDINGS, UNITS, UPGRADES, canAfford, prereqsMet } from "./entities.js";
import { recipeOf } from "./industry.js";
import { supplyUsed, supplyCap, buildingSupplyCap } from "./supply.js";
import { isNodeDiscovered } from "./fog.js";
import { playerUnits } from "./state.js";
import { deployColonyShip } from "./colony.js";
import { canAct, spend, canAffordKeeping, tryBuild, tryBuildAt } from "./aiCommon.js";
import { affordableOnSurface, aiDoctrine, maxSupplyDemand, plannedMix } from "./aiWorkers.js";
import { pickNextUnitType, visibleEnemyForceCount } from "./aiMilitary.js";
import { difficultyFor } from "./aiDifficulty.js";
import { adaptDefenceMult } from "./aiIntel.js";
import { aiBarter } from "./market.js";

const HOME_RADIUS = 420;          // nodes this close to an AI CC count as "home" economy
const CLAIM_RADIUS = 260;         // a cluster with any CC this close is already claimed
const CLUSTER_RADIUS = 160;       // nodes within this of an anchor sum into its cluster score
const EXPANSION_STANDOFF = 70;    // CC-to-anchor-node placement distance (26 CC radius + 16 node radius + clearance)
const BARRACKS_BUFFER = 150;      // bank kept when adding a barracks so the mix doesn't starve
const COLONY_ARRIVE = 40;         // Odyssey: an in-flight colony ship this close to its target deploys (ai.js expansion)
const HABITAT_SEARCH_RADIUS = 360;   // wider than the default placement search — a built-out Odyssey base is crowded
// SURPLUS SINK (Odyssey — see aiProduceAndFortify): banked ore per extra Barracks, and the cap on
// how many the escalation can add on top of the archetype's own maxBarracks.
const SURPLUS_STEP = 2000;
const SURPLUS_MAX_BARRACKS = 4;
const SURPLUS_EXPAND_ORE = 2500;   // …and the bank at which it settles a fresh cluster regardless of depletion
// SUPPLY RUSH (Odyssey and skirmish alike — see aiBaseAndTech): the bank at which a supply-blocked
// AI starts raising Habitats in PARALLEL, and how many it will ever have in flight at once.
const SUPPLY_RUSH_ORE = 800;
const MAX_PENDING_HABITATS = 3;

// Odyssey found/survive: no Command Center but a colony ship in hand -> deploy in place. Budget-exempt so even a 1-APM neighbour always seats a base (else it mis-reads as pacified). Skirmish: colonyShip is null -> no-op.
/** @param {State} state @param {AiContext} ctx */
export function aiFoundOrSurvive(state, ctx) {
  const { cc, colonyShip, controller } = ctx;
  // ODYSSEY — FOUND / SURVIVE: no Command Center but a colony ship in hand → deploy in
  // place to (re)found the base. Covers the opening AND being razed to a lone ship. It's
  // EXEMPT from the APM budget (like the attack commit) so even a 1-APM neighbour always
  // seats a base and the world progresses (otherwise a base-less AI mis-reads as pacified,
  // engine/galaxy.js). Runs first, at top priority. Skirmish: colonyShip is null → no-op.
  if (state.endless && !cc && colonyShip) {
    if (deployColonyShip(state, colonyShip.id)) {
      controller.colonyTarget = null;   // re-seating cancels any stale expansion intent
    } else {
      const spot = findPlacement(state, "command", colonyShip.x, colonyShip.y);   // slide off bad ground, then retry next think
      if (spot && (spot.x !== colonyShip.x || spot.y !== colonyShip.y)) issueMove([colonyShip], spot.x, spot.y);
    }
  }
}

// Scout Ranger (Tactical) + EXPANSION: once home ore runs thin, found a base on the richest unclaimed cluster (Odyssey by colony ship, skirmish by a worker). Banks toward it via ctx.oreReserve, pausing only lower-priority infrastructure spends.
/** @param {State} state @param {AiContext} ctx */
export function aiExpand(state, ctx) {
  const { ai, cc, workers, rangers, buildings, colonyShip, arch, owner, controller, fog } = ctx;
  // TACTICAL: build one cheap Ranger up front to scout with — far sight,
  // all-terrain, and it doesn't bleed a fighter out of the army the way lending a
  // combat unit does (updateScout prefers it). Standard AI keeps lending a unit,
  // so its economy/opening is untouched. Ore-only and tiny (45), reserve-aware.
  if (controller.micro && cc && workers.length > 0 && rangers.length === 0
      && !cc.queue.some(j => j.unitType === "ranger")
      && canAffordKeeping(ai.resources, UNITS.ranger.cost, ctx.oreReserve) && canAct(state, owner)) {
    if (queueProduction(state, cc.id, "ranger")) spend(state, owner);
  }

  // EXPANSION: once home ore runs thin, found a base on the richest unclaimed cluster.
  // Runs before every ore-spending block so it can reserve the cost (ctx.oreReserve) to
  // bank toward it — pausing only the lower-priority infrastructure spends, never unit
  // production, so the army keeps flowing while the AI saves. At most one in flight.
  const threshold = arch("expandWhenNodesBelow") || 0;   // Odyssey overlay can turn a never-expand Rusher into one that does
  const myCCs = buildings.filter(b => b.type === "command" && !b.constructing);

  if (state.endless) {
    // ODYSSEY: expand by COLONY SHIP — produce one, move it to a fresh cluster, deploy
    // on arrival (no more worker-builds-a-CC). A committed target (controller.colonyTarget)
    // keeps the ship homing on a fixed point rather than chasing a shifting cluster.
    const colonyCost = UNITS.colonyship.cost.ore;
    if (controller.colonyTarget && !colonyShip) controller.colonyTarget = null;   // ship deployed or died → reset the machine

    if (colonyShip && cc) {                                    // an EXPANSION ship is in flight (a start ship has no cc yet — handled above)
      if (!controller.colonyTarget) {                           // LAUNCH: commit a target and send it
        const anchor = bestExpansionCluster(state, myCCs, fog);
        if (anchor) {
          const toward = Math.atan2(cc.y - anchor.y, cc.x - anchor.x);   // aim for the home side of the cluster
          const spot = findPlacement(state, "command",
            anchor.x + Math.cos(toward) * EXPANSION_STANDOFF, anchor.y + Math.sin(toward) * EXPANSION_STANDOFF);
          if (spot && canAct(state, owner)) { controller.colonyTarget = { x: spot.x, y: spot.y }; issueMove([colonyShip], spot.x, spot.y); spend(state, owner); }
        }
      } else {                                                 // HOME IN → DEPLOY on arrival
        const t = controller.colonyTarget;
        if (Math.hypot(colonyShip.x - t.x, colonyShip.y - t.y) <= COLONY_ARRIVE && canAct(state, owner)) {
          if (deployColonyShip(state, colonyShip.id)) { controller.colonyTarget = null; spend(state, owner); }
          else {   // exact spot went invalid → re-aim to nearby valid ground and keep moving
            const spot = findPlacement(state, "command", colonyShip.x, colonyShip.y);
            if (spot) { controller.colonyTarget = { x: spot.x, y: spot.y }; issueMove([colonyShip], spot.x, spot.y); spend(state, owner); }
          }
        } else if (!colonyShip.order && !(colonyShip.orderQueue && colonyShip.orderQueue.length) && canAct(state, owner)) {
          issueMove([colonyShip], t.x, t.y); spend(state, owner);     // fell idle short of target (blocked) → nudge back on course
        }
      }
    } else if (!colonyShip && cc && workers.length > 0
               && !buildings.some(b => b.type === "command" && b.constructing)
               && !cc.queue.some(j => j.unitType === "colonyship")) {
      // No ship in flight → bank for and PRODUCE one once home ore runs thin and there's somewhere
      // to settle — OR once the AI is simply sitting on money it has nothing else to spend on.
      //
      // That second trigger is the surplus sink for a strategy that CAPS its standing army
      // (Economic, Force Parity): extra Barracks are no use to them, so the escalation in
      // aiProduceAndFortify can't drain the pile, and theirs were the four biggest banks in the
      // roster soak — 36,207 ore and no purchase left (docs/odyssey-ai-review.md §2.3). Growth is
      // the in-character answer: a rich neighbour settles another cluster instead of waiting for
      // its home seam to thin. Bounded for free — bestExpansionCluster returns null once the map
      // is claimed, and only one ship is ever in flight.
      const surplus = ai.resources.ore >= SURPLUS_EXPAND_ORE;
      if (((threshold > 0 && homeOreFraction(state, myCCs) < threshold) || surplus)
          && bestExpansionCluster(state, myCCs, fog)) {
        ctx.oreReserve = colonyCost;                               // pause infrastructure while banking (units keep flowing)
        if (ai.resources.ore >= colonyCost && canAct(state, owner) && queueProduction(state, cc.id, "colonyship")) { spend(state, owner); ctx.oreReserve = 0; }
      }
    }
  } else {
    // SKIRMISH — byte-for-byte as before: a worker builds an expansion Command Center.
    const ccCost = BUILDINGS.command.cost.ore;
    if (threshold > 0 && cc && workers.length > 0
        && !buildings.some(b => b.type === "command" && b.constructing)) {
      if (homeOreFraction(state, myCCs) < threshold) {
        const anchor = bestExpansionCluster(state, myCCs, fog);
        if (anchor) {
          ctx.oreReserve = ccCost;   // bank toward the CC by pausing infrastructure spend
          if (ai.resources.ore >= ccCost) {
            const toward = Math.atan2(cc.y - anchor.y, cc.x - anchor.x);   // place on the home side of the cluster
            if (tryBuild(state, owner, workers, "command",
                anchor.x + Math.cos(toward) * EXPANSION_STANDOFF,
                anchor.y + Math.sin(toward) * EXPANSION_STANDOFF)) {
              ctx.oreReserve = 0;
            }
          }
        }
      }
    }
  }
}

// Core base build-out + the tech gates: more workers, a Habitat before the supply cap bites, the first Barracks, the Foundry (Tier-2 gate) and Arsenal (Tier-3 gate), and one Mender (Tactical). Sets ctx.foundryReserve / ctx.refineryReserve for the production phase.
/** @param {State} state @param {AiContext} ctx */
export function aiBaseAndTech(state, ctx) {
  const { cc, workers, ai, buildings, barracks, refinery, allBarracks, archetype, arch, strategy, owner, controller } = ctx;
  // The worker target GROWS with the AI's industry: every factory and Plasma Rig it runs needs workers
  // to supply and clear it (engine/haul.js assignAiLogistics), on top of the base gather crew — so the
  // AI builds the LABOUR its economy needs, the same investment the player makes. Odyssey only (the
  // industry that drives it is odysseyOnly); a skirmish keeps the archetype's flat workerTarget.
  // strategy.workerTargetMult (engine/aiStrategy.js Economic) leans further into economy still; 1 (a
  // no-op) for every other strategy, so this is unchanged until a match opts into one. Layered again by
  // difficultyFor(state).workerTargetMult (engine/aiDifficulty.js) — Easy trims it, Hard grows it — 1 at
  // Medium (a no-op), the same multiplicative composition as the strategy layer right above it.
  const industryCount = state.endless
    ? buildings.filter(b => !b.constructing && (recipeOf(b) || BUILDINGS[b.type].rig)).length : 0;
  const workerTarget = arch("workerTarget") * (strategy.workerTargetMult || 1) * (difficultyFor(state, owner).workerTargetMult || 1)
    + industryCount * 2;   // ~MAX_SERVERS worth of haulers per factory/rig
  if (cc && workers.length < workerTarget && cc.queue.length === 0 && canAct(state, owner)) {
    if (queueProduction(state, cc.id, "worker")) spend(state, owner);
  }

  // Near the cap (or over it after losing a Habitat) with none already going up: put down a
  // Habitat by the CC, or production stalls forever. The margin is the biggest supply cost the
  // AI could actually try to pay next (maxSupplyDemand — engine/aiWorkers.js), NOT a flat 2:
  // the mix cycle retries the same entry until it succeeds, so a gap too narrow for a 4-supply
  // Dreadnought but too wide to trip a `cap - 2` trigger deadlocked production permanently
  // (docs/odyssey-ai-review.md §2.2). The same condition covers the destroyed-Habitat over-cap
  // case. A world whose mix tops out at 2 supply is unchanged — maxSupplyDemand floors at 2.
  //
  // Supply already ON THE WAY counts, rather than a flat "never a second while one is going up":
  // a Habitat takes 10s to grant its 8, and a surplus-scaled production line (below) consumes
  // more than that, so the old guard throttled the AI into a permanent shortfall. Crediting
  // pending Habitats at their supplyGrants is the same rule expressed arithmetically — with none
  // in flight it reduces to exactly the condition above.
  //
  // …and when SUPPLY, not ore, is what's throttling the army, it raises them in PARALLEL. One
  // Habitat at a time is 8 supply per 10 seconds, and production hard-blocked at the cap can never
  // run far enough OVER it to trip the shortfall test — so a low-Barracks archetype was pinned to
  // that rate for the whole game while its income piled up (measured: 40 sim-minutes to reach 37
  // units, 3,900 ore banked, Barracks idle two samples in three). Ore it has nothing else to spend
  // on buys headroom instead. Bounded by MAX_PENDING_HABITATS so a rich AI scales its supply, not
  // its footprint.
  const used = supplyUsed(state, owner), cap = supplyCap(state, owner);
  const pendingCount = buildings.filter(b => b.type === "habitat" && b.constructing).length;
  const pending = pendingCount * (BUILDINGS.habitat.supplyGrants || 0);
  const margin = maxSupplyDemand(state, archetype, owner);
  const blocked = used >= cap - margin;                       // can't fit the unit it's about to build
  const covered = used < cap + pending - margin;              // …but supply already on the way covers it
  const rushSupply = ai.resources.ore >= SUPPLY_RUSH_ORE && pendingCount < MAX_PENDING_HABITATS;
  // A configured hard population cap (state.popCap, setup.js's Population cap row) can sit BELOW
  // what the AI's own buildings would otherwise grant. Once the raw, unclamped total (this
  // Habitat's own pending siblings included) already reaches it, one more changes nothing —
  // supplyCap's own clamp (engine/supply.js) already caps the EFFECTIVE total — so stop raising
  // them rather than spending ore forever chasing a ceiling already reached (an infinite,
  // pointless Habitat-spam loop otherwise, since `blocked` alone has no awareness of this ceiling).
  const rawCapHeadroom = state.popCap == null || buildingSupplyCap(state, owner) + pending < state.popCap;
  if (cc && workers.length > 0 && blocked && rawCapHeadroom && (!covered || rushSupply)
      && canAfford(ai.resources, BUILDINGS.habitat.cost)) {
    // Try EVERY Command Center, with a wide search at each: a late-Odyssey capital packs 70+
    // buildings around it, and measured, every candidate spot near the home CC was taken while the
    // AI's own expansions had room to spare — so it silently stopped raising Habitats at all and
    // re-froze production, the same permanent stall the margin above just fixed.
    const anchors = buildings.filter(b => b.type === "command" && !b.constructing);
    let spot = null;
    for (const c of anchors) {
      spot = findPlacement(state, "habitat", c.x, c.y + 90, HABITAT_SEARCH_RADIUS);
      if (spot) break;
    }
    tryBuildAt(state, owner, [workers[0]], "habitat", spot);   // [workers[0]], not workers: this site has always founded with the first worker, not the nearest free one
  }

  // First Barracks. Build spots are fixed offsets from the CC; tryBuild's placement
  // search is what keeps that safe (see its comment in aiCommon.js).
  if (!barracks && cc && workers.length > 0 && canAfford(ai.resources, BUILDINGS.barracks.cost)) {
    tryBuild(state, owner, [workers[0]], "barracks", cc.x + 90, cc.y - 90);   // [workers[0]]: founded by the first worker, not the nearest free one
  }

  // FOUNDRY — the military tech gate for the Tier-2 units (Lancer/Breacher).
  // Built only if this archetype's mix actually wants a gated unit, so a
  // rush/legacy profile never wastes the build. Placed BEFORE the unit cycle so
  // the one-time tech investment isn't perpetually starved by the ungated unit
  // stream (which would otherwise eat every spare bit of ore); it's still
  // expansion-reserve-aware. Units keep flowing while it constructs, and
  // effectiveMix keeps the Tier-2 units out of the cycle until it completes —
  // so this reliably teches a patient AI up without ever stalling. Ore-only, so
  // it's affordable on every world.
  // Reads plannedMix (engine/aiWorkers.js), not the raw archetype.unitMix — so a graduated/
  // developing Rusher (Tier 4 rusherGraduates, or an Economic-strategy wantsIndustryAlways
  // override) that now PLANS to field a Lancer also builds the Foundry that unlocks it, not just
  // the factory chain aiIndustry.js separately climbs (docs/improvement-proposals.md "Graduation
  // reaches the army"). A no-op for every archetype whose own mix already reaches the Foundry.
  const wantsFoundry = plannedMix(state, archetype, owner).some(t => (UNITS[t]?.requires || []).includes("foundry") && affordableOnSurface(state, t));
  let hasFoundry = buildings.some(b => b.type === "foundry");   // built or still constructing
  if (wantsFoundry && !hasFoundry && barracks && !barracks.constructing && cc && workers.length > 0
      && canAffordKeeping(ai.resources, BUILDINGS.foundry.cost, ctx.oreReserve)) {
    if (tryBuild(state, owner, workers, "foundry", cc.x - 90, cc.y + 90)) hasFoundry = true;
  }
  // While teching, reserve the Foundry's ore from unit production so the AI
  // actually banks its cost instead of spending every spare 100 on another
  // Skiff and never reaching it. Cleared the instant it's founded (constructing
  // counts), so the pause is only the brief banking window — then units resume
  // at full flow while it builds. Zero for a rusher/legacy profile that doesn't
  // want a Foundry, so their army is never gated.
  ctx.foundryReserve = wantsFoundry && !hasFoundry ? BUILDINGS.foundry.cost.ore : 0;
  const foundryHandled = !wantsFoundry || hasFoundry;

  // ARSENAL — the Tier-3 gate, one step past the Foundry (unlocks the
  // Dreadnought). Built OPPORTUNISTICALLY from genuine surplus (no reserve
  // pausing the army for it), so it stays the Economist's late out-scaling
  // flourish without slowing its core timing — the deep Tier-3 path is primarily
  // a strategic option for the human player. Only archetypes whose PLANNED mix
  // (plannedMix — same graduate-extension source as wantsFoundry above) wants a
  // Tier-3 unit build it, so a graduated Rusher's Dreadnought entry reaches this
  // gate too, not just the Foundry.
  const wantsArsenal = plannedMix(state, archetype, owner).some(t => (UNITS[t]?.requires || []).includes("arsenal") && affordableOnSurface(state, t));
  const hasArsenal = buildings.some(b => b.type === "arsenal");
  if (wantsArsenal && !hasArsenal && foundryHandled && barracks && !barracks.constructing && cc && workers.length > 0
      && canAffordKeeping(ai.resources, BUILDINGS.arsenal.cost, ctx.oreReserve + BARRACKS_BUFFER)) {
    tryBuild(state, owner, workers, "arsenal", cc.x - 90, cc.y - 30);
  }
  // Refinery reserve, sequenced after the Foundry (Arsenal is unreserved above).
  ctx.refineryReserve = archetype.wantsRefinery && !refinery && foundryHandled && ctx.oreReserve === 0
    ? BUILDINGS.refinery.cost.ore : 0;

  // TACTICAL: keep exactly one Mender at home for army-sustain — it repairs
  // battle-damaged units between waves and patches wounded buildings (see
  // repair.js). Built at a Barracks (Foundry-gated, like the Tier-2 units) and
  // claimed BEFORE the mix cycle below fills every idle Barracks. Standard AI
  // never builds one, so its economy and opening are untouched; it's capped at
  // one, crystal-gated (canAfford only passes with a real crystal income), spends
  // only surplus ore (a mix buffer stays back), and it never attacks or defends —
  // so the resolves-to-a-winner guarantee holds even in the aiMicro resolve variant.
  const foundryDone = buildings.some(b => b.type === "foundry" && !b.constructing);
  if (controller.micro && foundryDone) {
    const haveMender = playerUnits(state, owner).some(u => u.type === "mender")
      || allBarracks.some(b => b.queue.some(j => j.unitType === "mender"));
    const idleRax = allBarracks.find(b => !b.constructing && b.queue.length === 0);
    if (!haveMender && idleRax
        && canAffordKeeping(ai.resources, UNITS.mender.cost, ctx.oreReserve + BARRACKS_BUFFER)
        && canAct(state, owner)) {
      if (queueProduction(state, idleRax.id, "mender")) spend(state, owner);
    }
  }
}

// SURPLUS SINK #3 (Odyssey only), on top of the Barracks/expansion sinks above: a strategy that
// caps its standing army (Economic, Force Parity) still has nowhere to put ongoing income once
// Barracks are at their surplus cap and there's nowhere left to expand — measured on a matured
// background neighbour (kybernet/matching, an Odyssey save): a full tech tree, three Command
// Centers, every Barracks slot filled, and 30,000+ ore still piling up behind a 3-unit garrison,
// because more barracks/CCs don't help when the cap gating THIS cycle's production never moved
// (docs/odyssey-ai-review.md §2.3's own ledger already found this — "extra Barracks alone will
// drain the hoard — no effect... a standing-army cap means extra capacity sits idle"). Same
// escalation shape as SURPLUS_STEP so it reads as one family of dial, not a new mechanism: every
// SURPLUS_STEP of banked ore lifts the cap by one, letting a fully-developed neighbour keep
// converting overflow into a bigger garrison instead of banking it forever. Self-bounding —
// production spends the ore straight back down, and the garrison itself is still bounded by
// supply (aiBaseAndTech only raises Habitats up to state.popCap) — so this cannot run away into
// an unbounded army the way an uncapped income stream would otherwise threaten to.
export function armySurplusBonus(state, ai) {
  return state.endless ? Math.floor(ai.resources.ore / SURPLUS_STEP) : 0;
}

// The standing-army production cap for this think cycle — Infinity (no cap, today's behavior)
// unless the strategy defines one (engine/aiStrategy.js). Economic keeps a small fixed cap that
// lifts sharply for a while after the AI is actually attacked (ctx.warFooting, engine/ai.js);
// Force Parity instead tracks whatever the AI has actually SEEN of the enemy's combat strength
// (fog-limited, like every other reactive AI read — engine/aiMilitary.js visibleEnemyForceCount),
// aiming a bit above parity with a floor for a not-yet-scouted enemy. Read once per cycle against
// ctx.army.length, a fixed snapshot — an acceptable per-cycle approximation, same spirit as the
// rest of this AI's think-cycle decisions.

// Exported for direct unit testing. engine/ai.js has ONE export (runAI) and aiContext is private,
// so every phase test had to stage a whole match — which is the direct cause of two gaps this
// review found: commit ac44339's army-cap feature shipped with no test at all, and garrisonSlots'
// corrective branch had never executed under npm test. These helpers are pure arithmetic over
// plain arguments; exporting them (rather than moving them to a testability-only leaf module,
// which would need imports back into the phase that owns them) is the smallest change that makes
// that arithmetic reachable without a staged game.
export function standingArmyCap(state, ctx) {
  const { strategy, ai, owner } = ctx;
  if (strategy.matchEnemyForce) {
    const enemy = visibleEnemyForceCount(state, owner);
    return Math.max(strategy.matchFloor || 0, Math.round(enemy * (strategy.matchBuffer || 1))) + armySurplusBonus(state, ai);
  }
  if (strategy.standingArmyCap != null) {
    const base = ctx.warFooting ? strategy.standingArmyCap * (strategy.warFootingMult || 1) : strategy.standingArmyCap;
    return base + armySurplusBonus(state, ai);
  }
  return Infinity;
}

// The shared unit-production cycle across every idle Barracks (Foundry/Refinery reserves held back), Sentinel Turrets along the approach lane, a second Barracks, and the research Refinery.
/** @param {State} state @param {AiContext} ctx */
export function aiProduceAndFortify(state, ctx) {
  const { allBarracks, ai, archetype, strategy, cc, barracks, workers, buildings, army, owner, controller } = ctx;
  // One shared production cycle across every completed Barracks: consecutive
  // barracks pick up consecutive mix entries, so two of them drain the same
  // sequence twice as fast rather than each running its own. Map insertion
  // order keeps the pick deterministic. pickNextUnitType layers the
  // counter-pick on top of the archetype mix. Unit production is deliberately
  // NOT gated by the expansion reserve — the army keeps growing while the AI
  // banks for a CC out of its infrastructure budget, never freezing on a poor
  // world.
  //
  // Gated by the strategy's standing-army cap (standingArmyCap above) — Infinity for every
  // archetype-driven match today, so this `if` is a no-op until a match opts into Economic or
  // Force Parity. At/above the cap, the ore that would have bought another combat unit is left
  // for the economy/industry phases instead — the whole point of a "minimal defense" strategy.
  if (army.length < standingArmyCap(state, ctx)) {
    for (const b of allBarracks) {
      if (b.constructing || b.queue.length > 0) continue;
      if (!canAct(state, owner)) break;   // out of action budget this cycle — no more units for now
      const nextType = pickNextUnitType(state, archetype, owner);
      if (!canAffordKeeping(ai.resources, UNITS[nextType].cost,
                            ctx.foundryReserve + ctx.refineryReserve + ctx.industryReserve)) continue;   // hold back ore while banking the Foundry / Refinery / industry bootstrap
      if (queueProduction(state, b.id, nextType)) {
        spend(state, owner);
        controller.unitsBuilt = (controller.unitsBuilt || 0) + 1;
      }
    }
  }

  // Sentinel Turrets (and, past the first slot, Bastilles — docs/improvement-proposals.md's
  // static-defense ladder) straddling the approach lane between the CC and mid-map, alternating
  // sides and stepping outward as they multiply. Crystals-funded, so it's outside the ore
  // expansion reserve; inert on crystal-less worlds (canAfford simply never passes there —
  // accepted flavor). turretCountMult (Economic — aiStrategy.js) trims even this passive defense
  // to match "minimal"; 1 (a no-op) for every other strategy.
  if (cc && barracks && workers.length > 0) {
    // Both static-defense types fill the SAME fortification slot in the archetype's turretCount
    // budget — a Bastille isn't an extra structure, it's a tougher pick for a slot past the
    // first, once the Foundry has actually unlocked it (prereqsMet below). Every archetype today
    // caps at 2 (aiArchetypes.js), so in practice this reaches at most one Bastille per game.
    const defenses = buildings.filter(b => b.type === "turret" || b.type === "bastille");
    // …and a FOURTH layer on top of archetype x strategy: the adapted stance (engine/aiIntel.js).
    // An opponent visibly massing an army is worth walling against; one visibly playing economy is
    // not, and ore spent on turrets there is ore not spent punishing them. 1 at neutral — and Easy
    // is pinned at neutral — so this composes as a no-op wherever the AI has no opinion.
    const turretCap = Math.round((archetype.turretCount || 0) * (strategy.turretCountMult || 1)
                                 * adaptDefenceMult(state, owner));
    if (defenses.length < turretCap) {
      const i = defenses.length;
      // The first fortification slot stays a plain Sentinel Turret (cheap, always reachable —
      // it has no `requires`); slots past that upgrade to the tankier Bastille once a completed
      // Foundry actually unlocks it. Falls back to more turrets on a Foundry-less (or
      // still-building) world, so fortifying never stalls waiting on a tech gate an archetype's
      // own build order hasn't reached yet.
      const type = (i >= 1 && prereqsMet(state, owner, BUILDINGS.bastille)) ? "bastille" : "turret";
      if (canAfford(ai.resources, BUILDINGS[type].cost)) {
        const mx = state.map.width / 2, my = state.map.height / 2;
        const len = Math.hypot(mx - cc.x, my - cc.y) || 1;
        const dx = (mx - cc.x) / len, dy = (my - cc.y) / len;   // the approach vector
        const side = i % 2 === 0 ? 1 : -1;
        tryBuild(state, owner, workers, type,
          cc.x + dx * (140 + 80 * i) - dy * 30 * side,
          cc.y + dy * (140 + 80 * i) + dx * 30 * side);
      }
    }
  }

  // A second Barracks once the first is up and the mix has a comfortable
  // buffer on top of any expansion reserve (allBarracks counts constructing
  // ones, so it never founds a third while the second is still going up).
  //
  // SURPLUS SINK (Odyssey only). Everything else the AI can buy is FINITE — a fixed factory
  // chain, a fixed research order, one Star Dock, one Plasma Rig, and this very cap — so a
  // developed neighbour in a mode with no end eventually runs out of purchases and simply banks
  // its income: measured at 30,000+ ore with an army that hadn't grown in 20 sim-minutes
  // (docs/odyssey-ai-review.md §2.3). A play-forever AI needs a terminal LOOP, not a terminal
  // list, and more Barracks is the one purchase that keeps converting ore into army indefinitely.
  // Bounded by SURPLUS_MAX_BARRACKS so a rich AI scales up instead of sprawling across the map,
  // and gated on state.endless: a 40-minute skirmish never banks this much, and its exact
  // barracks counts are part of the archetype contract the skirmish suite pins.
  const surplusBarracks = state.endless
    ? Math.min(SURPLUS_MAX_BARRACKS, Math.floor(ai.resources.ore / SURPLUS_STEP)) : 0;
  if (barracks && !barracks.constructing && cc && workers.length > 0
      && allBarracks.length < (archetype.maxBarracks || 1) + surplusBarracks
      && canAffordKeeping(ai.resources, BUILDINGS.barracks.cost, ctx.oreReserve + BARRACKS_BUFFER)) {
    tryBuild(state, owner, workers, "barracks", cc.x + 90, cc.y + 90);
  }

  // REFINERY. Hosts the AI's doctrine research, so it builds exactly one, near
  // home (reserve-aware, kept safe behind the base). cc-guarded: cc is the
  // completed-only find, so a home CC lost mid-expansion leaves it undefined.
  const refineries = buildings.filter(b => b.type === "refinery");
  const buildResearchRefinery = refineries.length === 0;   // ungated by archetype, as before
  if (buildResearchRefinery && barracks && !barracks.constructing && cc && workers.length > 0
      && canAffordKeeping(ai.resources, BUILDINGS.refinery.cost, ctx.oreReserve)) {
    tryBuild(state, owner, workers, "refinery", cc.x - 90, cc.y - 90);
  }
}

// Research along this archetype's chosen doctrine only, lowest tier first, one purchase per think cycle.
/** @param {State} state @param {AiContext} ctx */
export function aiResearch(state, ctx) {
  const { refinery, ai, archetype, owner } = ctx;
  // Research along this archetype's chosen doctrine only (rusher/balanced go
  // Assault, economist Bulwark), lowest tier first — so it commits to one path
  // and deepens it (T1 then T2) instead of dabbling in both. The doctrine lock
  // in researchUpgrade backs this up. One purchase per think cycle is plenty.
  if (refinery && !refinery.constructing && canAct(state, owner)) {
    // Doctrine research now DEVELOPS OVER TIME (engine/techtree.js updateResearch) instead of
    // landing instantly, so a job can sit queued for many think cycles before it completes.
    // Re-entry guard: bail out early while the Refinery already has something in flight, rather
    // than re-scanning the whole doctrine path and re-failing the same dupe/prereq checks every
    // single think cycle for no purchase.
    if (refinery.researchQueue && refinery.researchQueue.length) return;
    const doctrine = aiDoctrine(state, archetype);
    const path = Object.values(UPGRADES).filter(u => u.doctrine === doctrine).sort((a, b) => a.tier - b.tier);
    for (const u of path) {
      if (ai.upgrades[u.id]) continue;
      if (researchUpgrade(state, refinery.id, u.id)) { spend(state, owner); break; }
    }
  }
}

// MARKET BARTER (Tier 3, engine/aiDifficulty.js marketAccess — Medium and Hard): convert a
// commodity the AI is sitting on well past anything it could spend into whichever spendable
// commodity it's shortest on, at this world's live market rate (engine/market.js aiBarter) —
// never touching galaxy.credits, since there's no AI-side credit account to spend from. Odyssey-
// only (state.market is an Odyssey concept, set once per world in engine/galaxy.js addPlanet) and
// gated by the AI's own APM budget like every other decision, so this needs no separate pacing
// dial of its own — Hard's higher APM already means more frequent barters for free.
//
// `owner` defaults to "ai" and, unlike every other phase in this file, is NOT threaded further:
// engine/market.js's aiBarter is hardcoded to state.players.ai (Odyssey's market/diplomacy model
// is explicitly out of Tier 1 self-play's scope — see engine/ai.js's header). The `owner !== "ai"`
// guard exists purely so a hypothetical future self-play run in Odyssey mode (state.endless with a
// market) can never have a "player"-owner think cycle silently barter FROM state.players.ai's
// resources — Tier 1's own scope (skirmish only, no market ever present) never reaches this guard
// either way, so it's a no-op safety net, not a behavior change for anything shipped today.
/** @param {State} state @param {string} [owner] */
export function aiMarketBarter(state, owner = "ai") {
  if (owner !== "ai" || !state.endless || !state.market || !difficultyFor(state, owner).marketAccess) return;
  if (canAct(state, owner) && aiBarter(state)) spend(state, owner);
}

// Fraction of home ore still in the ground: remaining/max summed over every
// ore node within HOME_RADIUS of one of this AI's Command Centers. No home ore
// at all reads as fully depleted — which is exactly what should trigger the
// first expansion the moment the starting seam runs dry. Not fog-gated itself
// (it sums real node state, not what's been scouted) — bestExpansionCluster
// right below is the one that actually needs a look at the map.
export function homeOreFraction(state, ccs) {
  let amt = 0, max = 0;
  for (const n of state.map.nodes) {
    if (n.com !== "ore") continue;
    if (!ccs.some(c => Math.hypot(c.x - n.x, c.y - n.y) <= HOME_RADIUS)) continue;
    amt += n.amount; max += n.max;
  }
  return max > 0 ? amt / max : 0;
}

// The ore node worth expanding to: richest surrounding cluster of live nodes, lightly penalized by
// distance from home so this controller grabs its own side first and only reaches across the map
// once the near ore is claimed or dry. Only nodes `fog` has discovered count (surface ore always,
// hidden ore caches once scouted) — so on a map where the near ore is spent, this controller has to
// send its own scout out to find somewhere to expand, just like its opponent does with ITS OWN
// fog. `fog` is required (T-018/ADR-0008: no hardcoded-owner default) — every call site already
// passes its own ctx.fog (state.fogs[owner]), never a specific owner's fog on another's behalf,
// which would let a controller "discover" nodes it has never actually scouted. Skips anchors
// inside CLAIM_RADIUS of any CC (either owner, incl. constructing). Returns null when nothing
// known is available — which keeps the reserve from ever engaging in a no-room deadlock.
function bestExpansionCluster(state, myCCs, fog) {
  const allCCs = [...state.buildings.values()].filter(b => b.type === "command");
  let best = null, bestScore = -Infinity;
  for (const n of state.map.nodes) {
    if (n.com !== "ore" || n.amount <= 0) continue;                                 // anchor on live ore
    if (!isNodeDiscovered(fog, n)) continue;                                        // ...that this controller actually knows about
    if (allCCs.some(c => Math.hypot(c.x - n.x, c.y - n.y) <= CLAIM_RADIUS)) continue;
    let cluster = 0;
    for (const m of state.map.nodes)
      if (m.amount > 0 && isNodeDiscovered(fog, m) && Math.hypot(m.x - n.x, m.y - n.y) <= CLUSTER_RADIUS) cluster += m.amount;
    const dHome = Math.min(...myCCs.map(c => Math.hypot(c.x - n.x, c.y - n.y)));
    const score = cluster - 0.2 * dHome;   // richness first; keeps it on its own side unless dry
    if (score > bestScore) { bestScore = score; best = n; }
  }
  return best;
}
