/* ============================================================
   The queued, TIMED research loop — shared by the Odyssey tech tree (TECHS, below;
   researched at a Datacenter) and the Refinery's doctrine upgrades (UPGRADES,
   engine/entities.js; researched in every mode, skirmish included). updateResearch
   resolves WHICH node table applies purely from building.type, so both run the
   SAME dt-driven development loop instead of two near-duplicate ones — see
   RESEARCH_TABLE_BY_BUILDING below. Either way, a node is PAID IN GATHERED
   COMMODITIES (the game's law — the resources you gather are the resources you
   spend, no separate research currency) and DEVELOPED OVER TIME, scaled by the
   world's tech rating so a Syndicate hub out-researches a frontier rock — which,
   for a doctrine upgrade, now makes a SKIRMISH world's own tech rating matter too.
   A completed node lands as an id in player.upgrades — the SAME bag either table
   reads back from — so it gates buildings/recipes through the existing prereqsMet
   primitive with zero new gating machinery. committedDoctrine/upgradeMult
   (entities.js) both guard on UPGRADES membership specifically, so a TECHS id
   parked in upgrades is invisible to the doctrine system; the passive-effect TECHS
   nodes are read here via techMult instead.

   The TECHS half stays Odyssey-only and inert-by-construction: the Datacenter is
   `odysseyOnly` and the skirmish AI never builds one, so the skirmish sim/AI path
   is untouched there (a TECHS id is never in a skirmish player.upgrades). The
   Refinery half is available — and now timed, where it used to be instant-on-
   payment — in BOTH modes; see production.js's researchUpgrade for its enqueue
   side. Deterministic and DOM-free either way: accrual is dt-driven float math
   with no wall-clock and no unseeded randomness.
   ============================================================ */

"use strict";

import { PLANETS } from "../data.js";
import { canAfford, payCost, prereqsMet, UPGRADES, negate } from "./entities.js";
import { difficultyFor } from "./aiDifficulty.js";

// The tree. `cost` is gathered commodities (paid on start); `time` is seconds to
// develop at a tech-5 world (scaled by researchTimeScale). `requires` are prereq
// tokens resolved by prereqsMet (a building type or another node). A node either
// UNLOCKS content (its id gates a building/recipe via `requires` elsewhere) or is
// a PASSIVE that multiplies industry (powerMult / rateMult / yieldMult, read by
// techMult). The three unlock nodes form the buildable spine; the three passives
// branch off it so "research next building" vs "boost what I have" is a real fork.
// `ico` reuses the data.js commodity icons where a node maps to a good (metals ⛓️, electronics
// 🖥️, antimatter 🌀, AI cores 🧠), or a thematic emoji for the pure boosts — so the research
// buttons carry the same iconography as the rest of the game (hud.js).
export const TECHS = {
  metallurgy: { id: "metallurgy", name: "Metallurgy", ico: "⛓️", cost: { crystals: 80 }, time: 20,
    desc: "Unlock the Assembly Plant — refine metals into alloys." },
  reactors: { id: "reactors", name: "Fusion Containment", ico: "⚡", cost: { crystals: 70 }, time: 18,
    powerMult: 1.5, desc: "+50% Power from every Reactor." },
  // appliesTo scopes the passive to exactly the building types its own tooltip names — without
  // it, techMult would apply yieldMult to EVERY recipe building (Chip Fab, Antimatter Forge, …),
  // silently over-boosting strategic-good throughput far past this cheap early node's advertised
  // role. Nodes with no appliesTo field (reactors/automation above) stay global, unchanged.
  heavyalloys: { id: "heavyalloys", name: "Heavy Alloys", ico: "🔩", cost: { crystals: 110 }, time: 24, requires: ["metallurgy"],
    yieldMult: 1.4, appliesTo: ["smelter", "assembler"], desc: "+40% output from the Smelter and Assembly Plant." },
  electronics: { id: "electronics", name: "Microelectronics", ico: "🖥️", cost: { crystals: 120 }, time: 28, requires: ["metallurgy"],
    desc: "Unlock the Chip Fab — make electronics from crystals and metals." },
  automation: { id: "automation", name: "Factory Automation", ico: "🤖", cost: { crystals: 130, radioactives: 40 }, time: 30, requires: ["electronics"],
    rateMult: 1.25, desc: "+25% production speed at every factory." },
  machining: { id: "machining", name: "Precision Machining", ico: "🛠️", cost: { crystals: 150, radioactives: 60 }, time: 36, requires: ["electronics"],
    desc: "Unlock the Machine Works — build machinery from alloys and electronics." },
  // The strategic capstone (Phase 3): unlocks the Antimatter Forge, and with it the
  // Antimatter Gate — Odyssey's endgame. The deepest, priciest node on the tree.
  antimatter: { id: "antimatter", name: "Antimatter Containment", ico: "🌀", cost: { crystals: 220, radioactives: 100 }, time: 44, requires: ["machining"],
    desc: "Unlock the Antimatter Forge — the top of the chain, and the key to the Antimatter Gate." },
  // The full Strategic tier: the two remaining strategic goods, which fuel the
  // Antimatter Gate and the Leviathan capital ship.
  aicores: { id: "aicores", name: "Machine Minds", ico: "🧠", cost: { crystals: 260, radioactives: 130 }, time: 48, requires: ["antimatter"],
    desc: "Unlock the AI Foundry and Torpedo Works — cultivate AI Cores and Plasma Torpedoes." },
  // engine/haul.js FREIGHTER_AI_TECH — the string id here MUST match that constant. An unlock node
  // like metallurgy/electronics/machining above (no multiplier field: it gates a CAPABILITY, read
  // directly off player.upgrades by id in sim.js/commands.js/hudSelection.js, not through techMult).
  // Priced partly in the very good it lets a freighter burn to run itself (engine/haul.js
  // payAIUpkeep) — cultivating the Cores to spend on automation IS the cost of automating.
  freighterai: { id: "freighterai", name: "Autonomous Freight AI", ico: "🧠", cost: { ai: 60, electronics: 90 }, time: 40, requires: ["aicores"],
    desc: "Freighters can be toggled into the local logistics chain like a worker — far greater capacity per trip — while burning AI Cores to run themselves." },
  // engine/recycle.js RECYCLE_TECH — the string id here MUST match that constant, and matches the
  // skirmish doctrine tree's OWN "recycling" node (engine/entities.js UPGRADES) too: only one of
  // the two trees is ever active in a given match, so sharing the id is safe, and it's what lets
  // recycleFrac check a single player.upgrades flag regardless of mode. No multiplier field —
  // gates recycleFrac's research bonus directly by id, same as freighterai above.
  recycling: { id: "recycling", name: "Reclamation Engineering", ico: "♻️", cost: { crystals: 140, radioactives: 40 }, time: 30, requires: ["automation"],
    desc: "+30% of a recycled unit/building's cost reclaimed (up to an 80% cap)." },
  // Promote the legacy consumer-goods recipes into a trade-industry branch (docs/improvement-
  // proposals.md lines 443-451): data.js RECIPES already carries 'chem' (biomass+power ->
  // chemicals) and 'consumer' (alloys+chemicals+power -> goods) as documented legacy — "no
  // producer". These two nodes are the exact "tech + wiring" promotion path its own LIVE-vs-LEGACY
  // comment reserves. `chemistry` is deliberately a ROOT node — no `requires` at all, the same
  // shape as `metallurgy` above — so it opens a genuinely SEPARATE branch off the Datacenter
  // (biomass/spice worlds get an industrial identity of their own) rather than a leaf hanging off
  // the existing ore->metals->alloys spine. `consumerfab` is gated on `chemistry` alone (its own
  // branch's root, not metallurgy) — see engine/entities.js BUILDINGS.chemplant/fabricator for
  // where the two branches actually MEET (the Fabricator building itself needs an Assembly Plant
  // for alloys), and note this against data.js's LIVE-vs-LEGACY comment.
  chemistry: { id: "chemistry", name: "Industrial Chemistry", ico: "⚗️", cost: { crystals: 80 }, time: 20,
    desc: "Unlock the Chemical Plant — refine biomass into chemicals." },
  consumerfab: { id: "consumerfab", name: "Consumer Fabrication", ico: "📦", cost: { crystals: 150, radioactives: 60 }, time: 36, requires: ["chemistry"],
    desc: "Unlock the Fabricator — combine alloys and chemicals into consumer goods." },
};

// Research develops faster on a high-tech world (data.js PLANETS.tech, 1..10) and
// slower on a frontier rock — clamped so no world is punishing. Pure data lookup;
// the sole reason WHERE you research is a strategic choice. Deterministic.
export function researchTimeScale(state) {
  const t = PLANETS.find(p => p.id === state.planetId)?.tech ?? 5;
  const s = 5 / t;                       // tech 5 → 1.0×, tech 10 → 0.5×, tech 1 → 5× (clamped)
  return s < 0.5 ? 0.5 : s > 2 ? 2 : s;
}

// Product of a passive node's multiplier field across a player's researched techs
// (1 when none apply) — the tech-tree twin of entities.js upgradeMult, reading
// TECHS instead of UPGRADES. Inert in skirmish (no TECH id is ever in a skirmish
// player.upgrades).
//
// `buildingType` is optional and scopes a node whose def carries an `appliesTo` list (e.g.
// heavyalloys -> ["smelter","assembler"]) to only the types it names — a node with no appliesTo
// field stays global regardless. Passing NO buildingType (the plain 2-arg form) skips the
// appliesTo check entirely and returns the un-scoped product, so every pre-existing call site
// keeps its old behavior untouched; only a caller that names the asking building (industry.js
// updateProduction's yieldMult site, hudSelection.js's mirrored rate preview) gets the scoping.
export function techMult(upgrades, field, buildingType) {
  let m = 1;
  if (!upgrades) return m;
  for (const id in upgrades) {
    if (!upgrades[id]) continue;
    const def = TECHS[id];
    if (!def || !def[field]) continue;
    if (def.appliesTo && buildingType !== undefined && !def.appliesTo.includes(buildingType)) continue;
    m *= def[field];
  }
  return m;
}

// Difficulty's research-pace dial (engine/aiDifficulty.js), applied to an AI CONTROLLER's own
// Datacenter/Refinery research only — never a human player's, even on the same tech-rated world.
// researchTimeScale above is deliberately per-WORLD (a Syndicate hub is fast for whoever researches
// there); this is the one further, per-OWNER layer on top of it. owner "ai" always reads its own
// difficulty (state.ai.difficulty) — unchanged. owner "player" reads state.playerAi's difficulty
// ONLY when Tier 1 self-play (tools/selfplay.js) has actually populated it — a human-driven
// "player" owner (every match that exists outside self-play) has no controller there, so this
// still resolves to 1 (a no-op), exactly as before. Without this owner-aware read, a self-play
// "player" controller's own chosen difficulty would silently never apply its research-pace dial —
// the same class of fairness bug fog-omniscience is, just for a timing dial instead of vision.
function aiResearchPaceMult(state, owner) {
  if (owner !== "ai" && (owner !== "player" || !state.playerAi)) return 1;
  return difficultyFor(state, owner).researchPaceMult || 1;
}

// Which building type researches from which node table — the one thing that
// differs between the Datacenter's tech tree and the Refinery's doctrine
// upgrades; everything else in updateResearch below is shared verbatim. Any
// other building type (or one whose researchQueue was mis-set by a tampered
// save) simply isn't a research building at all.
const RESEARCH_TABLE_BY_BUILDING = { datacenter: TECHS, refinery: UPGRADES };

// Advance a research building's QUEUE by dt — a no-op for anything that isn't a
// completed Datacenter or Refinery with a queued job (RESEARCH_TABLE_BY_BUILDING
// resolves which node table this building's ids belong to). Develops the head of
// the queue; on completion the node lands in player.upgrades (where
// prereqsMet/techMult/upgradeMult read it), the job is dropped, and the next
// queued node begins. Same dt-driven float pattern as buildProgress —
// deterministic, engine-pure.
export function updateResearch(state, building, dt) {
  const table = RESEARCH_TABLE_BY_BUILDING[building.type];
  if (!table || building.constructing) return;
  const queue = building.researchQueue;
  if (!queue || queue.length === 0) return;
  const job = queue[0];
  const def = table[job.techId];
  if (!def) { queue.shift(); return; }
  job.progress += dt / (def.time * researchTimeScale(state) * aiResearchPaceMult(state, building.owner));
  if (job.progress >= 1) {
    state.players[building.owner].upgrades[job.techId] = true;
    queue.shift();
    state.events.push({ type: "researchComplete", techId: def.id, x: building.x, y: building.y, owner: building.owner });
  }
}

// Queue a node for research at a Datacenter: needs a completed Datacenter, the node
// not already owned or queued, its prereqs met OR already queued AHEAD of it (so a
// whole path can be lined up at once and stop being babysat one node at a time),
// and affordability — then pay (gathered commodities, on enqueue like the
// production queue) and append it. Mirrors production.js researchUpgrade — both are
// timed and queued now — except a Datacenter's OWN queued-ahead node counts as a
// met prereq here; a Refinery's Tier-2 doctrine upgrade deliberately does NOT get
// that same relaxation (it needs its Tier-1 actually complete, not just queued —
// see researchUpgrade), since a queued Tier-1 is also what commits the doctrine
// lock (entities.js committedDoctrine), and letting an unfinished Tier-1 unlock its
// own Tier-2 would let a player queue an entire doctrine's cost before the first
// upgrade even proves out.
/**
 * Why researchTech(state, buildingId, techId) would refuse — the SAME checks in the same order, as
 * a machine-readable reason instead of a bare `false`. Mirrors engine/production.js's
 * productionRefusalReason/researchUpgradeRefusalReason exactly, and for the same reason: a silent
 * no-op is unreadable to a caller driving the match over the wire, which then just re-sends the
 * order. net/commandCodec.js fills the reject's `reason` in from this. Read-only.
 * @param {State} state @param {string} buildingId @param {string} techId
 * @returns {string|null} null when the research would actually queue
 */
export function researchTechRefusalReason(state, buildingId, techId) {
  const building = state.buildings.get(buildingId);
  if (!building) return "no-such-building";
  if (building.type !== "datacenter") return "wrong-building-for-research";
  if (building.constructing) return "building-under-construction";
  const player = state.players[building.owner];
  const def = TECHS[techId];
  if (!def) return "unknown-tech";
  if (player.upgrades[techId]) return "already-researched";
  const queue = building.researchQueue || [];
  if (queue.some(j => j.techId === techId)) return "already-queued";
  const queuedAhead = new Set(queue.map(j => j.techId));
  const remaining = (def.requires || []).filter(r => !queuedAhead.has(r));
  if (!prereqsMet(state, building.owner, { requires: remaining })) return "prereq-not-met";
  if (!canAfford(player.resources, def.cost)) return "cannot-afford";
  return null;
}

export function researchTech(state, buildingId, techId) {
  const building = state.buildings.get(buildingId);
  if (!building || building.type !== "datacenter" || building.constructing) return false;
  const player = state.players[building.owner];
  if (player.upgrades[techId]) return false;                     // already researched
  const queue = building.researchQueue || (building.researchQueue = []);
  if (queue.some(j => j.techId === techId)) return false;        // already queued
  const def = TECHS[techId];
  if (!def) return false;
  // A prereq counts as met if it's researched, a completed building, OR queued
  // ahead on this same Datacenter (it'll finish first). prereqsMet covers the first
  // two; filter out the queued-ahead tokens before delegating to it.
  const queuedAhead = new Set(queue.map(j => j.techId));
  const remaining = (def.requires || []).filter(r => !queuedAhead.has(r));
  if (!prereqsMet(state, building.owner, { requires: remaining })) return false;
  if (!canAfford(player.resources, def.cost)) return false;
  payCost(player.resources, def.cost);
  queue.push({ techId, progress: 0 });
  return true;
}

// Negate a cost map so payCost can be used to REFUND it — the 2-line helper production.js's own
// cancelProduction uses, duplicated locally rather than imported: techtree.js already sits
// upstream of production.js in the import graph (production.js -> industry.js -> techtree.js for
// techMult), so importing back the other way would open a cycle.

// Cancel a queued research job (in progress or still waiting, either one — mirrors
// production.js's cancelProduction: the simplest, most player-friendly convention, and consistent
// with nothing but the commodity cost having been spent on it yet) and fully refund it. If any
// OTHER queued job on the SAME building named the cancelled techId in its own `requires`, cancel
// and refund that too, cascading (a chain of 3+ nodes cascades all the way through) — researchTech
// only ever lets a dependent queue AHEAD of an unmet prereq by way of the prereq ALREADY sitting in
// the queue, so a job can only ever depend on something queued before it, never after; the queue
// can then never be left holding a job whose prereq just vanished out from under it.
export function cancelResearch(state, buildingId, index) {
  const building = state.buildings.get(buildingId);
  if (!building) return false;
  const table = RESEARCH_TABLE_BY_BUILDING[building.type];
  const queue = building.researchQueue;
  if (!table || !queue || !queue[index]) return false;
  const player = state.players[building.owner];

  // Cancel one job by queue index: refund its cost (nothing to refund for a stale/unresolvable
  // techId — updateResearch would have silently dropped it anyway, so nothing was ever banked
  // against it here) and splice it out. Returns the cancelled techId so the caller can track it.
  const cancelOne = i => {
    const job = queue[i];
    const def = table[job.techId];
    queue.splice(i, 1);
    if (def) payCost(player.resources, negate(def.cost));
    return job.techId;
  };

  const cancelledIds = new Set([cancelOne(index)]);
  let again = true;
  while (again) {
    again = false;
    for (let i = 0; i < queue.length; i++) {
      const def = table[queue[i].techId];
      if (def && (def.requires || []).some(r => cancelledIds.has(r))) {
        cancelledIds.add(cancelOne(i));
        again = true;
        break;   // the queue just shrank under us — restart the scan from the top
      }
    }
  }
  return true;
}
