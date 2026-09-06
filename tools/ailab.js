/* ============================================================
   AI LAB — a headless bench for the Odyssey opponent, so "is this AI any good?"
   becomes a measurement instead of an opinion.

   The engine test suite already guards INVARIANTS (determinism, purity, "a skirmish
   resolves to a winner"). Nothing measures QUALITY: whether the neighbour on an
   Odyssey world develops, spends what it earns, and applies pressure in proportion to
   how hostile it has become. Those are curves over 30–60 minutes of sim, not
   assertions, and they're exactly what breaks silently when an archetype number moves.

   This tool runs the sim headlessly (it's already pure and deterministic — that's the
   whole reason this is cheap), samples an AI-quality metric set on a fixed cadence, and
   prints a scoreboard. Because the AI's whole behaviour space is three plain-data
   tables — ARCHETYPES × STRATEGIES × DIFFICULTY_OPTIONS, all read through defensive
   `|| 1` accessors — a candidate strategy is a JSON object, not a code change: pass
   --overrides and the lab writes new rows into those tables before it runs. So
   searching for a better AI needs no engine edit at all.

   Usage
     node tools/ailab.js probe   [--world ferros] [--strategy default] [--difficulty medium]
                                 [--opponent passive] [--minutes 40] [--sample 5]
     node tools/ailab.js sweep   [--worlds a,b] [--strategies a,b] [--difficulties a,b]
                                 [--seeds 3] [--minutes 40] [--json out.json] [--csv out.csv] [--full]
     node tools/ailab.js compare --baseline base.json --candidate cand.json
     node tools/ailab.js search  --strategy aggressive --dials 'attackTimeoutMult=0.3:1,garrisonMult=0:1'
                                 [--steps 4] [--worlds a,b] [--difficulties a,b]
                                 [--tournament-against baseline.json]
                                 # default objective: solo score() against the --opponent sparring
                                 # bot, same as always. --tournament-against swaps ONLY the
                                 # objective a candidate dial-value is scored by, onto Tier 2/3's
                                 # fair, side-swapped, difficulty-bracketed self-play duel
                                 # (runDuelBrackets) against the named baseline candidate JSON
                                 # ({ name, strategy, overrides }) — the coordinate-scan mechanics
                                 # (the per-dial, per-step loop, "keep an improvement") are
                                 # unchanged and don't know which objective is active.
     node tools/ailab.js check   [--worlds a,b] [--minutes 60] [--exit-code]   # the named-defect list
     node tools/ailab.js duel    --a candA.json --b candB.json [--worlds a,b] [--seeds 2]
                                 [--difficulties easy,hard] [--seed 1] [--minutes 40] [--json out.json]
                                 # Tier 3: side-swapped (both candidates play BOTH owner slots, by
                                 # DEFAULT, not an opt-in) and difficulty-bracketed (each --difficulties
                                 # entry reported on its own, never blended) — see the DUEL header
                                 # comment below.

   Opponents (--opponent) decide what the AI is measured AGAINST, and the answer differs
   completely between them: none (no player at all) · passive (seats a base, never acts — the
   only bot that never draws blood) · turtle (economy behind turrets, never attacks) · skirmisher
   (a turtle that also attacks with whatever it has mustered) · tech (a turtle that ALSO climbs
   Foundry -> Arsenal and attacks with a Lancer/Breacher/Dreadnought guard instead of a Skiff blob
   — the counter-pick/composition yardstick: does the AI react to and survive an actual army, not
   just a blob). skirmisher and tech are the two that provoke.

   Common flags
     --overrides f.json   inject rows into the AI tables before running, e.g.
                          { "strategies": { "swarm": { "armyAttackSizeMult": 0.5 } },
                            "archetypes": { "rusher": { "odyssey": { "workerTarget": 9 } } },
                            "difficulties": { "hard": { "workerTargetMult": 1.4 } } }
     --seed N             base seed (default 1) — every run is reproducible from it
     --apm real|none      default 'real': the AI runs at its OWN difficulty row's aiApm cap
                          (engine/aiDifficulty.js) — the single biggest difficulty dial, and until
                          now exercised by zero bench measurements. 'none' keeps a run unthrottled,
                          for comparison against the bench's pre-APM measurement history.

   Deterministic by construction: every world seeds from mulberry32, every sparring
   opponent is scripted off the sim clock, and no wall-clock or Math.random is read. Two
   runs of the same command produce byte-identical numbers.

   Lives in tools/ (a dev bench, like tools/serve.js) — NOT in engine/, which stays the
   pure shipped simulation. It only ever READS the engine's public API.
   ============================================================ */

"use strict";

import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createGameState } from "../engine/state.js";
import { tick } from "../engine/sim.js";
import { createDiplomacy, hostility, aiDevelopment, provoked } from "../engine/diplomacy.js";
import { strategyFor } from "../engine/aiStrategy.js";
import { issueAttackMove } from "../engine/commands.js";
import { createMarket } from "../engine/market.js";
import { deployColonyShip } from "../engine/colony.js";
import { findPlacement } from "../engine/colliders.js";
import { issueBuild } from "../engine/commands.js";
import { queueProduction } from "../engine/production.js";
import { supplyUsed, supplyCap } from "../engine/supply.js";
import { BUILDINGS, UNITS, canAfford } from "../engine/entities.js";
import { pickNextUnitType } from "../engine/aiMilitary.js";
import { ARCHETYPES, archetypeFor, PLANET_ARCHETYPE, ODYSSEY_EXTRA_ARCHETYPE } from "../engine/aiArchetypes.js";
import { STRATEGIES } from "../engine/aiStrategy.js";
import { DIFFICULTY_OPTIONS } from "../engine/aiDifficulty.js";
import { mulberry32, hashStr } from "../engine/rng.js";
// The fairness-critical "run one duel match" primitive lives in tools/duelCore.js now
// (docs/competitions-and-elo.md Phase 1) so a browser Worker can import it without this file's
// ~1600 lines of CLI/printing/argv code. Re-imported under the SAME local names this file has
// always used (duelRun is duelCore's runDuelMatch, renamed there since it's no longer nested
// among duel-specific names) so every call site below — runDuel, runRoundRobinSwapped,
// runSwissBracket, and everything built on them — keeps working unmodified; pinnedDuelDials is
// re-exported at the bottom of this file exactly as it was when declared here directly.
import { pinnedDuelDials, duelSeed, runDuelMatch as duelRun } from "./duelCore.js";
import { INITIAL_RATING, applySeries } from "../elo.js";
// The pairing/scheduling logic (Swiss matching + byes + standings order, and round-robin's own
// every-unordered-pair loop) lives in the root-level pairing.js now, for the same reason
// tools/duelCore.js exists: the in-game competition screen needs it in a browser Worker without
// this file's CLI half (docs/competitions-and-elo.md Phase 3). Imported under the SAME names this
// file has always used, and re-exported below exactly as before — see the TIER 5 header comment.
import { rankStandings, pairRound, buildSwissBracket, roundRobinPairs, swissRoundCount } from "../pairing.js";
// The genome — the AI as a schema'd, mutable, crossable data structure (docs/ai-evolution-design.md).
// A leaf module like duelCore/pairing: it imports the three AI tables and mulberry32 and nothing
// else, so `evolve` below is the only thing in this file that knows evolution exists.
import { geneKeys, genomeFrom, randomGenome, mutate, cross, cloneGenome, toCandidate, rngFor, diffGenes,
         applyOverrides, snapshotTables, restoreTables }
  from "./genome.js";
// Re-exported under their original names: they used to be DEFINED here and every existing caller
// (test/ailab.test.js among them) imports them from this file. They now live in ./genome.js so a
// browser Worker can run a player-authored genome without pulling in this file's node:fs half.
export { applyOverrides };

const WORLDS = [...Object.keys(PLANET_ARCHETYPE), ...Object.keys(ODYSSEY_EXTRA_ARCHETYPE)];
const DT = 0.1;                  // the sim's fixed step, same as the game loop
const THINK = 1.5;               // sparring-bot decision cadence, matching the AI's own think interval

/* ============================================================
   THE LAB WORLD
   ============================================================ */

// One Odyssey world, built exactly the way engine/galaxy.js addPlanet builds a neighbour:
// endless, with its own market and diplomacy, the archetype's faction, and the AI dials under
// test. The `opponent` decides what the player side is, which is what the AI is actually being
// measured against — see the sparring bots below. `apm` === "real" runs the AI at its OWN
// difficulty row's aiApm (the CLI's own default, via baseConfig below); anything else — including
// simply omitting it — keeps a direct labWorld/run() call unthrottled exactly like before, so
// every existing programmatic caller (this file's own test suite included) is untouched.
// `archetype` is an optional STRING KEY into ARCHETYPES, forwarded exactly as tools/duelCore.js's
// runDuelMatch already forwards its own (docs/competitions-and-elo.md D3) — absent on every caller
// that predates the archive below, and createGameState falls back to archetypeFor(planetId) when
// it's absent or names an unknown key, so an omitted archetype is byte-identical to before this
// option existed. Without it the solo bench could not describe a genome carrying an archetype
// chromosome: it would silently measure the world's own temperament instead.
function labWorld({ world, strategy, difficulty, opponent, seed, apm, archetype }) {
  const diffOpt = DIFFICULTY_OPTIONS.find(o => o.mult === difficulty);
  const s = createGameState({
    planetId: world, seed, rng: mulberry32(seed), endless: true,
    aiStrategy: strategy, difficulty, aiArchetype: archetype,
    aiApm: apm === "real" ? (diffOpt?.aiApm ?? null) : null, aiMicro: !!diffOpt?.aiMicro,
    aiFaction: archetypeFor(world).faction,
  });
  s.diplomacy = createDiplomacy();
  s.market = createMarket(s);
  s.inGalaxy = true;             // galaxy states never resolve per-world (engine/victory.js)
  const bot = OPPONENTS[opponent];
  if (!bot) throw new Error(`unknown opponent "${opponent}" — one of: ${Object.keys(OPPONENTS).join(", ")}`);
  bot.setup(s);
  return { state: s, bot };
}

/* ============================================================
   SPARRING OPPONENTS — what the AI is measured against

   An Odyssey neighbour with nobody to react to is playing solitaire, so a metric taken
   with no opponent only measures its build order. Each bot below drives the "player"
   side through the engine's PUBLIC command API (the same calls input.js makes), off the
   sim clock, with no randomness — so a measurement is repeatable and the difference
   between two AI configs is the only thing that moves.

   These are deliberately dumb and legible. A sparring partner you can't describe in a
   sentence makes a scoreboard you can't interpret.
   ============================================================ */

const playerUnitsOf = (s, type) => [...s.units.values()].filter(u => u.owner === "player" && u.type === type);
const playerBuildingsOf = (s, type) =>
  [...s.buildings.values()].filter(b => b.owner === "player" && (!type || b.type === type));

// Deploy the opening colony ship into a real Command Center — every bot but `none` starts here,
// because an undeployed ship is a foothold the AI's wave logic reads but can't meaningfully fight.
function seatBase(s) {
  const ship = playerUnitsOf(s, "colonyship")[0];
  if (ship) deployColonyShip(s, ship.id);
}

// Keep idle player workers mining, using the PLAYER's own fog for discovery (the AI's
// assignIdleWorkers reads state.fogAI, so it can't be reused here without handing the bot
// the AI's intel). Nearest live discovered node, ore first — deliberately simpler than the
// AI's saturation-aware steering, since the bot is a yardstick, not a contender.
function botGather(s) {
  const live = s.map.nodes.filter(n => n.amount > 0 && !n.hidden);
  if (!live.length) return;
  const ore = live.filter(n => n.com === "ore");
  for (const w of playerUnitsOf(s, "worker")) {
    if (w.order) continue;
    const pool = ore.length ? ore : live;
    let best = null, bestD = Infinity;
    for (const n of pool) {
      const d = Math.hypot(n.x - w.x, n.y - w.y);
      if (d < bestD) { bestD = d; best = n; }
    }
    if (best) w.order = { type: "gather", nodeId: best.id };
  }
}

// Put `type` down near the player's CC, sliding off collisions the same way the AI does.
function botBuild(s, type, dx, dy) {
  const cc = playerBuildingsOf(s, "command").find(b => !b.constructing);
  const worker = playerUnitsOf(s, "worker").find(w => !w.order || w.order.type === "gather");
  if (!cc || !worker || !canAfford(s.players.player.resources, BUILDINGS[type].cost)) return false;
  const spot = findPlacement(s, type, cc.x + dx, cc.y + dy);
  return !!spot && issueBuild(s, worker.id, type, spot.x, spot.y);
}

// Shared by every bot with a real economy (today: `turtle` and `tech`): grow the workforce to a
// target, keep supply ahead of the cap, and — once there's a Barracks — hold a wall of turrets.
// Returns false when the tick's one action already went to an economy/defence step (or there's no
// Command Center yet, so nothing else can happen), true once the caller is free to decide what its
// Barracks builds — the same one-action-per-think discipline every bot here already follows.
function botEconomy(s) {
  botGather(s);
  const cc = playerBuildingsOf(s, "command").find(b => !b.constructing);
  if (!cc) return false;
  const res = s.players.player.resources;
  const workers = playerUnitsOf(s, "worker").length;
  if (workers < 12 && cc.queue.length === 0) { queueProduction(s, cc.id, "worker"); return false; }
  if (supplyUsed(s, "player") >= supplyCap(s, "player") - 4
      && !playerBuildingsOf(s, "habitat").some(b => b.constructing)) { botBuild(s, "habitat", 0, 90); return false; }
  if (!playerBuildingsOf(s, "barracks").length) { botBuild(s, "barracks", 90, -90); return false; }
  if (playerBuildingsOf(s, "turret").length < 4 && canAfford(res, BUILDINGS.turret.cost)) {
    const i = playerBuildingsOf(s, "turret").length;
    if (botBuild(s, "turret", 120 - 60 * (i % 2), 120 * (i < 2 ? 1 : -1))) return false;
  }
  return true;
}

// tech's composition guard: Tier-2 (Foundry) then Tier-3 (Arsenal), never a Skiff — the whole
// point of this bot is a mixed army the counter-pick/turret-wall-reading changes actually have
// something to answer, not another single-unit blob (engine/entities.js `requires`: Lancer and
// Breacher need a completed Foundry, Dreadnought a completed Arsenal). Listed cost-ascending so
// trying it in order doubles as "cheapest-affordable-first": queueProduction already rejects a
// locked or unaffordable entry on its own, so this never wedges waiting on a Dreadnought it can't
// yet pay for while it's sitting on Lancer money.
const TECH_COMP = ["lancer", "breacher", "dreadnought"];

// turtle's economy, plus the tech ladder past the Barracks. Foundry first (Lancer/Breacher's
// prereq), then Arsenal (Dreadnought's) once the Foundry is actually done — not just laid down —
// and only then does an idle Barracks start cycling TECH_COMP.
function techBuild(s) {
  if (!botEconomy(s)) return;
  if (!playerBuildingsOf(s, "foundry").length) { botBuild(s, "foundry", -90, -90); return; }
  const foundryDone = playerBuildingsOf(s, "foundry").some(b => !b.constructing);
  if (foundryDone && !playerBuildingsOf(s, "arsenal").length) { botBuild(s, "arsenal", -90, 90); return; }
  const idle = playerBuildingsOf(s, "barracks").filter(b => !b.constructing).find(b => b.queue.length === 0);
  if (idle) for (const t of TECH_COMP) if (queueProduction(s, idle.id, t)) break;
}

const OPPONENTS = {
  // A living-galaxy BACKGROUND world: no player at all. This is what 10 of the 11 worlds
  // actually are for most of an Odyssey, so it's the honest setting for measuring the
  // development curve — and the one where a frozen build order shows up bare.
  none: {
    desc: "no player at all (a living-galaxy background world)",
    setup(s) {
      for (const [id, u] of [...s.units]) if (u.owner === "player") s.units.delete(id);
      for (const [id, b] of [...s.buildings]) if (b.owner === "player") s.buildings.delete(id);
      s.background = true;
    },
    think() {},
  },

  // Seats a base and then does NOTHING — the "player who wandered off". Measures whether
  // pressure ever actually arrives: an AI that can't beat this one will never threaten anyone.
  passive: {
    desc: "seats a Command Center, then never acts again",
    setup: seatBase,
    think() {},
  },

  // A real economy that never attacks: workers to target, Habitats ahead of the cap, a
  // Barracks, defenders, and turrets. The yardstick for "can the AI crack a defended base",
  // which is the question that actually matters for an Odyssey neighbour.
  turtle: {
    // NB it can still provoke: its turrets kill the AI's scouts, which counts as the player
    // destroying the neighbour's ships (engine/diplomacy.js). `passive` is the only bot that never
    // draws blood at all.
    desc: "economy + static defence, never attacks (the base-cracking yardstick)",
    setup: seatBase,
    think(s) {
      if (!botEconomy(s)) return;
      // A standing guard, cheapest-first so the bot's composition never depends on tech it
      // hasn't built. Units hold at the rally point; the bot never issues an attack order.
      const res = s.players.player.resources;
      const idle = playerBuildingsOf(s, "barracks").filter(b => !b.constructing).find(b => b.queue.length === 0);
      if (idle && canAfford(res, UNITS.skiff.cost)) queueProduction(s, idle.id, "skiff");
    },
  },

  // PROVOKES: commits its army once it's mustered one. A `neverInitiates` neighbour is entitled to
  // answer a player who has drawn blood (engine/diplomacy.js provoked()), so measuring whether
  // Economic / Force Parity ever push back needs an opponent that actually fights — `none`/
  // `passive` never do, and against them those strategies are SUPPOSED to stay quiet (`turtle` can
  // still incidentally provoke — its turrets kill the AI's scouts — but never deliberately
  // attacks). Deterministic: it commits whenever six idle combat units have accumulated, off the
  // sim clock, with no randomness. `tech` below is the other bot that provokes, same trigger.
  skirmisher: {
    desc: "turtle economy that throws a Skiff blob at the AI whenever it musters one",
    setup: seatBase,
    think(s) {
      OPPONENTS.turtle.think(s);
      const idle = [...s.units.values()].filter(u =>
        u.owner === "player" && UNITS[u.type].role === "combat" && (!u.order || u.order.type === "move"));
      if (idle.length >= 6) issueAttackMove(idle, s.map.bases.ai.x, s.map.bases.ai.y);
    },
  },

  // The composition yardstick: everything skirmisher is, plus it actually teches — so it answers
  // "does the AI react to and survive a composition, not a blob" instead of re-asking "does the AI
  // beat a Skiff blob". Same six-idle wave-commit trigger as skirmisher, so it provokes too.
  tech: {
    desc: "turtle economy that also teches Foundry/Arsenal and throws a Lancer/Breacher/Dreadnought guard at the AI",
    setup: seatBase,
    think(s) {
      techBuild(s);
      const idle = [...s.units.values()].filter(u =>
        u.owner === "player" && UNITS[u.type].role === "combat" && (!u.order || u.order.type === "move"));
      if (idle.length >= 6) issueAttackMove(idle, s.map.bases.ai.x, s.map.bases.ai.y);
    },
  },
};

/* ============================================================
   METRICS

   Everything here is read off sim state, never off the AI's own bookkeeping where a
   cheaper read exists — the point is to measure what the AI DID, not what it intended.
   ============================================================ */

const oreValue = cost => (cost.ore || 0) + 2 * (cost.crystals || 0) + 2 * (cost.radioactives || 0);

function sample(s) {
  const ai = [...s.units.values()].filter(u => u.owner === "ai");
  const army = ai.filter(u => UNITS[u.type].role === "combat");
  const done = [...s.buildings.values()].filter(b => b.owner === "ai" && !b.constructing);
  const rax = done.filter(b => b.type === "barracks");
  const res = s.players.ai.resources;
  const banked = oreValue(res);
  const next = rax.length ? pickNextUnitType(s, s.ai.archetype) : null;
  return {
    t: Math.round(s.time),
    workers: ai.filter(u => u.type === "worker").length,
    army: army.length,
    armyValue: army.reduce((v, u) => v + oreValue(UNITS[u.type].cost), 0),
    dev: aiDevelopment(s),
    buildings: done.length,
    banked: Math.round(banked),
    stance: +s.diplomacy.stance.toFixed(3),
    hostility: +hostility(s).toFixed(3),
    waves: s.ai.waveCount || 0,
    // IDLE PRODUCTION: a completed Barracks with an empty queue while the AI is sitting on
    // real money. Not "it's between jobs" — it's the signature of an AI that has run out of
    // things it knows how to buy, which in a play-forever mode is the failure that matters.
    idleRax: rax.filter(b => b.queue.length === 0).length,
    rax: rax.length,
    // Is the next mix entry unaffordable in SUPPLY specifically? The mix cycle retries the same
    // entry until it succeeds, so a unit that doesn't fit under the cap wedges production —
    // and the Habitat trigger only fires within 2 supply of the cap, which doesn't cover the
    // 4- and 8-supply Odyssey units. That combination is a hard deadlock, so it's measured.
    supplyBlocked: !!next && supplyUsed(s, "ai") + (UNITS[next].supplyCost || 0) > supplyCap(s, "ai"),
    // …and is it doing anything about it? A healthy AI at full tilt runs close to its cap and is
    // momentarily blocked all the time — that's supply PRESSURE, not deadlock. Being blocked with
    // no Habitat on the way is the first half of the deadlock signature; the second half is that
    // the ceiling never moved afterwards, which lives in summarise's supplyCapGrowthTail.
    habitatPending: [...s.buildings.values()].some(b => b.owner === "ai" && b.type === "habitat" && b.constructing),
    supplyFree: +(supplyCap(s, "ai") - supplyUsed(s, "ai")).toFixed(1),
    // SCALE-FREE MONEY GATES. Both deadlock/stall detectors need "…and it had the money, so being
    // broke isn't the explanation". That used to be an absolute ore figure (400 and 1000), which
    // is a threshold calibrated against one particular size of AI: on a neighbour earning several
    // times what it used to, 1,000 banked is change in transit rather than a war chest, and the
    // detector drifts toward firing on anything busy. Ask the question that has no scale in it
    // instead — could it pay for the exact purchase that would have resolved the state? — so the
    // gate means the same thing on a 13-worker opening and a four-base capital.
    canAffordUnblock: canAfford(res, BUILDINGS.habitat.cost),                  // the Habitat that lifts a supply block
    canAffordNext: !!next && canAfford(res, UNITS[next].cost),                 // the unit an idle Barracks would have queued
    // The cap ITSELF, not just the free room above it (supplyFree), because "did this ever
    // resolve?" is a question about the ceiling moving — see summarise's supplyCapGrowthTail.
    supplyCapNow: +supplyCap(s, "ai").toFixed(1),
    playerBuildings: playerBuildingsOf(s).length,
    aiAlive: done.some(b => b.type === "command"),
    // ENTITLED to attack right now? Odyssey draws a line between a strategy that goes looking for
    // a fight and one that only answers being provoked (engine/aiStrategy.js neverInitiates +
    // engine/diplomacy.js provoked()). "Hostile and idle" is only a defect on the near side of
    // that line — a neighbour leaving an unprovoked player alone is the contract working, and
    // scoring it as a failure would push the tuning loop toward breaking it.
    entitled: !strategyFor(s).neverInitiates || provoked(s),
    // Is this strategy DELIBERATELY holding its army down (Economic's fixed cap, Force Parity's
    // mirror)? Idle Barracks are the intended output of a standing-army cap, so the stall detector
    // has to exclude them — the same principle as `entitled` above: a detector that fires on
    // behaviour the design asks for teaches the tuning loop to break the design.
    armyCapped: strategyFor(s).standingArmyCap != null || !!strategyFor(s).matchEnemyForce,
    provokedAi: provoked(s),   // has the player drawn blood / started a Gate? (diagnostic + the `entitled` input)
  };
}

// Run one configuration and fold its samples into a result row. `minutes` is SIM time; a
// 40-minute world costs a few seconds of wall clock, which is what makes a sweep practical.
function run(cfg) {
  const { state, bot } = labWorld(cfg);
  const stepsPerSample = Math.round(cfg.sample * 60 / DT);
  const total = Math.round(cfg.minutes * 60 / DT);
  const curve = [];
  let sinceThink = 0;
  for (let i = 0; i < total; i++) {
    tick(state, DT);
    sinceThink += DT;
    if (sinceThink >= THINK) { sinceThink = 0; bot.think(state); }
    if (i % stepsPerSample === 0) curve.push(sample(state));
  }
  curve.push(sample(state));
  return { ...cfg, curve, ...summarise(curve) };
}

// Collapse a curve into the handful of numbers a scoreboard can rank. Deliberately few: a
// metric nobody can act on is noise.
function summarise(curve) {
  const last = curve[curve.length - 1];
  const peak = key => curve.reduce((m, c) => Math.max(m, c[key]), 0);
  // The tail is the last third of the run — the play-forever regime, where an AI whose plan
  // has run out looks identical to one that's still going unless you look at the derivative.
  const tail = curve.slice(Math.floor(curve.length * 2 / 3));
  const devGrowthTail = tail.length > 1 ? tail[tail.length - 1].dev - tail[0].dev : 0;
  const armyGrowthTail = tail.length > 1 ? tail[tail.length - 1].army - tail[0].army : 0;
  // Did the SUPPLY CEILING move in the tail? This is the resolution half of the deadlock
  // question. A wedged AI's cap is frozen — that's what being wedged means — while an AI merely
  // living at its ceiling raises it continuously (measured: 280 -> 579 -> 807 -> 1,048 -> 1,248
  // across one 60-minute run that the pre-2026-08-05 detector called deadlocked).
  const supplyCapGrowthTail = tail.length > 1
    ? (tail[tail.length - 1].supplyCapNow || 0) - (tail[0].supplyCapNow || 0) : 0;
  const firstWave = curve.find(c => c.waves > 0);
  // Only samples where the AI was BOTH hostile and entitled to act on it (see sample().entitled).
  const hostileSamples = curve.filter(c => c.hostility >= 0.5 && c.playerBuildings > 0 && c.entitled);
  return {
    devFinal: last.dev,
    devGrowthTail,
    armyFinal: last.army,
    armyValueFinal: last.armyValue,
    armyGrowthTail,
    workersFinal: last.workers,
    buildingsFinal: last.buildings,
    bankedFinal: last.banked,
    bankedPeak: peak("banked"),
    waves: last.waves,
    firstWaveAt: firstWave ? firstWave.t : null,
    // Fraction of the run spent hostile-but-idle: the neighbour reads "Hostile" in the HUD
    // while never committing a wave. The single most player-visible AI failure in Odyssey.
    hostileIdleFrac: hostileSamples.length
      ? +(hostileSamples.filter(c => c.waves === 0).length / hostileSamples.length).toFixed(2) : 0,
    // How much of the run the AI actually had standing to attack. Zero means the question
    // "did it apply pressure?" was never asked of it — scored the same way an opponent-less run is.
    entitledSamples: hostileSamples.length,
    // Fraction of samples where EVERY Barracks stood idle while the AI could afford the very unit
    // it would have queued next — i.e. it had nothing left it knew how to buy. Two hard-won
    // qualifiers: "every", not "any" (once surplus opens extra Barracks, one of six between jobs is
    // ordinary churn — an "any" test fired on 42 of 44 healthy runs), and affordability of the NEXT
    // PURCHASE rather than an absolute bank (a fixed ore threshold is a statement about one size of
    // economy). This is the symptom half only; production-stall pairs it with armyGrowthTail.
    idleRichFrac: +(curve.filter(c => !c.armyCapped && c.rax > 0 && c.idleRax === c.rax && c.canAffordNext)
      .length / curve.length).toFixed(2),
    supplyDeadlockFrac: +(curve.filter(c => c.supplyBlocked && !c.habitatPending && c.canAffordUnblock)
      .length / curve.length).toFixed(2),
    supplyCapGrowthTail,
    stanceFinal: last.stance,
    playerBuildingsFinal: last.playerBuildings,
    aiAlive: last.aiAlive,
  };
}

/* ============================================================
   SCORING — one number to rank candidates, and the components that explain it

   A scalar is what a search loop needs; the components are what a HUMAN needs to accept
   or reject the result. Both are printed, always. Weights are here in the open so an
   argument about what "better AI" means is an argument about these six lines, not about
   the harness.
   ============================================================ */

const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;

export const WEIGHTS = {
  develop: 0.25,     // climbs the industry/tech chain rather than flatlining on a 2-building base
  keepGrowing: 0.2,  // and is STILL growing in the last third — the play-forever requirement
  pressure: 0.25,    // commits waves when it has actually turned hostile
  thrift: 0.15,      // spends what it earns instead of banking an unusable pile
  liveness: 0.1,     // production never wedges (idle Barracks on real money)
  survive: 0.05,     // still holds a Command Center at the end
};

export function score(r) {
  const parts = {
    develop: clamp01(r.devFinal / 20),                      // ~20 = the full chain + most of the tree
    keepGrowing: clamp01((r.devGrowthTail + Math.max(0, r.armyGrowthTail) / 5) / 4),
    pressure: r.hostileIdleFrac > 0 ? clamp01(1 - r.hostileIdleFrac) : clamp01(r.waves / 6),
    // What it ENDED holding, not what it ever touched: a working economy peaks high and spends it
    // straight back down, so a peak-based measure scored a healthy AI the same as a stalled one.
    thrift: clamp01(1 - r.bankedFinal / 8000),
    liveness: clamp01(1 - Math.max(r.idleRichFrac, r.supplyDeadlockFrac)),
    survive: r.aiAlive ? 1 : 0,
  };
  // "Did it apply pressure?" is only a fair question when it was ever ASKED — there was somebody
  // to attack (not the `none` opponent) and the AI had standing to attack them (an initiating
  // strategy, or a provoked one). Otherwise drop the component and renormalise the remaining
  // weights, rather than quietly scoring an unanswerable question as a failure and pushing the
  // tuning loop toward an AI that attacks players who have done nothing to it.
  const askable = r.opponent !== "none" && r.entitledSamples > 0;
  const applicable = Object.keys(WEIGHTS).filter(k => !(k === "pressure" && !askable));
  const wsum = applicable.reduce((a, k) => a + WEIGHTS[k], 0);
  const total = applicable.reduce((sum, k) => sum + (WEIGHTS[k] / wsum) * parts[k], 0);
  if (!askable) delete parts.pressure;
  return { total: +total.toFixed(3), parts };
}

/* ============================================================
   OVERRIDES — a candidate AI is DATA, not a patch

   ARCHETYPES / STRATEGIES / DIFFICULTY_OPTIONS are plain exported objects read through
   `|| 1`-style accessors, so writing a row into them before a run is the whole mechanism
   for trying a new AI. That's why searching this space needs no engine change: the search
   space is already a JSON document.
   ============================================================ */


// Deep-clone the three live tables so a candidate's overrides can be reverted EXACTLY once its
// runs are done, leaving the next candidate a clean baseline. Plain data (the whole reason
// applyOverrides can work at all), so a JSON round-trip clones it safely. Used by runLeaderboard
// below — two candidates that both patch e.g. "aggressive" must never see each other's edits.

/* ============================================================
   LEADERBOARD — Tier 0 of "which strategy is actually better": rank candidates against a
   FIXED, non-adaptive sparring bot with every other dial held equal, no engine change needed.

   This is NOT head-to-head play. Nothing here makes two candidates fight each other — that
   needs runAI to drive two independently-configured owners in the same match, which it can't
   do yet (docs/odyssey-ai-review.md §2.8, "There is no AI-vs-AI, but there nearly is"). What
   this CAN do today: hold difficulty, opponent, world roster, seed count and minutes IDENTICAL
   across every candidate — so no candidate gets an APM/micro edge another one doesn't — and rank
   them by the same score() this bench already uses for solo tuning. "Candidate A beats candidate
   B" here means "A scored higher against the same yardstick B faced", which is real signal but a
   PROXY for competitive self-play, not a substitute for it — say so wherever this is reported.

   A candidate is { name, strategy, overrides }: `strategy` (default "default") is which
   STRATEGIES key this candidate actually runs as; `overrides` (optional) is exactly the
   --overrides shape, scoped to this one candidate's runs via snapshotTables/restoreTables above.
   ============================================================ */

export function runLeaderboard(candidates, { worlds, difficulty = "medium", opponent = "tech", seeds = 2, ...rest } = {}) {
  const results = [];
  for (const cand of candidates) {
    if (!cand.name) throw new Error('a candidate needs a "name"');
    const snap = snapshotTables();
    try {
      if (cand.overrides) applyOverrides(cand.overrides);
      const strategy = cand.strategy || "default";
      if (!STRATEGIES[strategy])
        throw new Error(`candidate "${cand.name}": unknown strategy "${strategy}" — define it under overrides.strategies`);
      const rows = runMatrix({ ...rest, opponent }, { worlds, strategies: [strategy], difficulties: [difficulty], seeds });
      const scored = rows.map(score);
      const mean = scored.reduce((a, s) => a + s.total, 0) / scored.length;
      const partsMean = {};
      for (const k of Object.keys(WEIGHTS)) {
        const vals = scored.filter(s => k in s.parts).map(s => s.parts[k]);
        if (vals.length) partsMean[k] = +(vals.reduce((a, v) => a + v, 0) / vals.length).toFixed(3);
      }
      let worstIdx = 0;
      scored.forEach((s, i) => { if (s.total < scored[worstIdx].total) worstIdx = i; });
      results.push({ name: cand.name, strategy, mean: +mean.toFixed(3), partsMean, worst: rows[worstIdx], n: rows.length });
    } finally {
      restoreTables(snap);   // never let one candidate's patch leak into the next, even on error
    }
  }
  return results.sort((a, b) => b.mean - a.mean);
}

/* ============================================================
   DUEL — Tier 2: true head-to-head, not a proxy. Two independently-configured
   candidates fight each other for real, via Tier 1's self-play (tools/selfplay.js):
   BOTH sides driven by the real scripted AI (engine/ai.js runAI), never a scripted
   sparring bot (contrast the LEADERBOARD above, which is exactly that proxy). Skirmish
   only — createSelfPlayState's default (non-endless) shape — resolved purely by engine/
   victory.js's own checkWinCondition (elimination, or its score-at-clock timeout),
   exactly as any other skirmish resolves. No new win condition is invented here.

   FAIRNESS, the one property this command cannot be trusted without: difficulty — and
   therefore APM and micro, both DERIVED from the difficulty row (engine/aiDifficulty.js
   DIFFICULTY_OPTIONS: aiApm/aiMicro) — is pinned IDENTICAL for both sides. That isn't a
   convention the caller has to remember: pinnedDuelDials() (tools/duelCore.js) reads the
   difficulty ONCE into a single `dials` object, and duelRun() (tools/duelCore.js's
   runDuelMatch, imported below under this file's own long-standing local name) spreads
   that SAME object into both createSelfPlayState `ai` and `playerAi` configs. There is
   only one variable in the whole call graph that could ever hold "this side's
   apm/micro/difficulty" — so there is no second code path left that could read a
   different value for either side, even by mistake. Only `strategy` (and whatever
   --overrides row it names) differs between the two candidates — that is the entire
   point of the comparison.

   Candidate A always plays owner "player", candidate B always plays owner "ai" — a fixed,
   documented mapping. That is NOT enough on its own: some worlds (oort, nimbus — both
   reachable via --worlds) carry engine/map.js's `asym: { player, ai }` modifier block, a
   genuinely asymmetric per-owner stat tweak baked into the map, independent of which
   candidate is playing which owner. A fixed candidate->owner mapping would hand that
   map-side advantage to the same candidate on every single match — measured empirically at
   ~6/0 (oort) and ~5/6-inverted (nimbus) for two IDENTICAL candidates, i.e. the map side
   deciding the match, not candidate quality. So runDuel alternates the engine's own escape
   hatch for this (`swapAsym`, the same flag the skirmish game exposes so a human can choose
   which half to play) by replicate parity — even reps (0, 2, …) play the map as generated,
   odd reps play it with the asym halves exchanged — so across any run of seeds >= 2 on an
   asym world, each candidate spends half its matches on each side of the map's own
   asymmetry and neither one's map-side is fixed for the whole run. `swapAsym` is a no-op on
   every world without an asym block, so this changes nothing for the default roster
   (korrath/ferros/vesper/kybernet). Each row records the `swapAsym` it actually ran with.

   SCORING: winner/loser/draw comes straight from engine/victory.js's own state.winner/
   state.over — elimination or its score-at-clock tiebreak, never reinterpreted here (a
   "draw" here means only that the run hit its safety-net cutoff still undecided, which
   the tiebreak means should not happen in practice). The "score margin" reported
   alongside it is exactly the score that tiebreak itself uses — engine/victory.js
   playerScore/scoreBreakdown (bank + army + structures) — NOT this file's own score()/
   WEIGHTS system above. That system scores an ODYSSEY play-forever curve: `develop` and
   `keepGrowing` key off aiDevelopment(state), which engine/diplomacy.js's own header
   comment says plainly is hardcoded to owner "ai" and that "the whole skirmish path...
   never calls this"; `pressure`/`hostileIdleFrac` key off hostility()/provoked(), which
   need state.diplomacy — absent from every skirmish state, self-play included. Forcing
   that curve-shaped, Odyssey-specific metric onto a skirmish fight it was never built to
   describe would produce numbers that LOOK like this file's score() but don't mean the
   same thing. Reusing playerScore instead keeps "score" meaning exactly what it already
   means everywhere self-play/skirmish resolution is concerned: the real number the match
   itself would settle a tie with.
   ============================================================ */

// pinnedDuelDials, duelSeed, and duelRun (tools/duelCore.js's runDuelMatch, imported above under
// this file's own pre-existing local name) used to be defined here directly. They now live in
// tools/duelCore.js — pulled out so a browser Worker can import just the match-runner in a later
// stage without this file's CLI/printing/search/leaderboard code (docs/competitions-and-elo.md
// Phase 1) — and are re-imported unchanged: every call site below reads exactly as it always has.
// See tools/duelCore.js for their implementations and doc comments (dial-pinning, seed derivation,
// the row shape), and the FAIRNESS paragraph above for WHY pinnedDuelDials/duelRun are shaped the
// way they are.

// Head-to-head: candidate A vs candidate B across `worlds` x `seeds`, difficulty pinned
// identical for both (pinnedDuelDials — see the FAIRNESS paragraph above). `worlds`/
// `difficulty`/`seeds`/`seedBase`/`minutes` mirror runMatrix's own options; each candidate is
// `{ name, strategy, overrides }`, exactly runLeaderboard's own candidate shape. Overrides
// from BOTH candidates are applied together, once, before any match runs (they share one
// live fight, unlike leaderboard's candidates which never meet) — snapshot/restored around
// the whole call exactly like runLeaderboard does around each candidate, via the same
// snapshotTables/restoreTables this file already uses.
//
// A and B must have DIFFERENT names, same reasoning as assertUniqueCandidateNames below (which
// covers 3+ candidate round-robins/Swiss but never runs for a plain --a/--b pair): elo.js's
// RatingsTable is keyed by name, and eloForMatches near the bottom of this file folds every duel's
// rows through it, so a same-name pair would silently collide both candidates' Elo into one entry
// (elo.js's own applyResult throws on exactly this, as a backstop — this check just gives the CLI
// user a clear, immediate reason instead of a duel that runs to completion and THEN throws).
// `archetype` (docs/competitions-and-elo.md D3) is a per-candidate field tools/duelCore.js's
// runDuelMatch has always accepted and competitionWorker.js has always passed, but which this
// function never forwarded — so a CLI duel had both seats playing whatever temperament the WORLD
// hands out, and a candidate carrying its own archetype was silently ignored here while working
// in-game. Forwarded now (absent/undefined on every hand-written candidate file, and runDuelMatch
// treats absent as byte-identical to omitting it — test/duelCore.test.js pins that), which is what
// lets an evolved genome carry a macro/tempo/composition chromosome and not just a strategy row.
//
// `seedKey`, likewise, is forwarded straight to duelSeed — see its comment in tools/duelCore.js
// for why an evolutionary caller needs to pin a generation's maps and why nothing else should.
export function runDuel(a, b, {
  worlds = ["korrath", "ferros", "vesper", "kybernet"], difficulty = "medium",
  seeds = 2, seedBase = 1, minutes, seedKey,
} = {}) {
  if (!a || !a.name) throw new Error('candidate A needs a "name"');
  if (!b || !b.name) throw new Error('candidate B needs a "name"');
  if (a.name === b.name) throw new Error(`candidate A and candidate B need different names (both were "${a.name}")`);
  const dials = pinnedDuelDials(difficulty);   // read ONCE — see the FAIRNESS paragraph above
  assertNoOverrideCollision(a, b);
  const snap = snapshotTables();
  try {
    if (a.overrides) applyOverrides(a.overrides);
    if (b.overrides) applyOverrides(b.overrides);
    const aStrategy = a.strategy || "default", bStrategy = b.strategy || "default";
    if (!STRATEGIES[aStrategy])
      throw new Error(`candidate "${a.name}": unknown strategy "${aStrategy}" — define it under overrides.strategies`);
    if (!STRATEGIES[bStrategy])
      throw new Error(`candidate "${b.name}": unknown strategy "${bStrategy}" — define it under overrides.strategies`);
    const rows = [];
    for (const world of worlds)
      for (let rep = 0; rep < seeds; rep++)
        rows.push(duelRun({
          world, seed: duelSeed(seedBase, world, difficulty, a.name, b.name, rep, seedKey),
          dials, aName: a.name, aStrategy, bName: b.name, bStrategy, minutes,
          aArchetype: a.archetype || null, bArchetype: b.archetype || null,
          // Alternate the map's own asym halves by replicate parity — see the FAIRNESS
          // paragraph above. A no-op on every world without an `asym` block.
          swapAsym: rep % 2 === 1,
        }));
    const aWins = rows.filter(r => r.winner === "a").length;
    const bWins = rows.filter(r => r.winner === "b").length;
    const draws = rows.filter(r => r.winner === "draw").length;
    const avgMargin = +(rows.reduce((s, r) => s + r.margin, 0) / rows.length).toFixed(1);
    // dials.difficulty, NOT the raw `difficulty` param — pinnedDuelDials already normalizes an
    // unknown/typo'd difficulty to "medium" for apm/micro, and every row already reports
    // dials.difficulty for the same reason (see pinnedDuelDials' own comment); the aggregate has
    // to agree with its own rows instead of echoing back whatever garbage string was passed in.
    return { aName: a.name, bName: b.name, aStrategy, bStrategy, difficulty: dials.difficulty, n: rows.length, aWins, bWins, draws, avgMargin, rows };
  } finally {
    restoreTables(snap);   // never let this duel's overrides leak into whatever runs next
  }
}

// Shared by both round-robin flavours below: the standings Map is keyed by name, so two
// candidates sharing a name would silently collapse into one entry — an A-vs-A pairing would
// then read/write the SAME standings object for both sides of that match, corrupting it with a
// phantom self-match. Guard up front, the same discipline runDuel already applies to a missing
// name.
// Two candidates in ONE duel share a single live table (unlike leaderboard's, which never meet and
// are snapshot/restored per candidate), and applyOverrides MERGES rather than replaces. So if both
// patch the same key, the second's fields land on top of the first's and BOTH seats play a row
// belonging to neither — a mirror match that still reports a winner, from seat/seed noise alone.
// That is the natural A/B workflow (two values of one dial under one strategy name), so refuse it
// loudly rather than silently measuring nothing.
function assertNoOverrideCollision(a, b) {
  for (const table of ["strategies", "archetypes", "difficulties"]) {
    const aKeys = Object.keys((a.overrides && a.overrides[table]) || {});
    const bSet = new Set(Object.keys((b.overrides && b.overrides[table]) || {}));
    const shared = aKeys.filter(k => bSet.has(k));
    if (shared.length)
      throw new Error(`both candidates override ${table} "${shared.join('", "')}" — they share one live ` +
        `table for the duel, so the patches would merge and both sides would play the same row. ` +
        `Give each candidate its own key (e.g. "${shared[0]}A"/"${shared[0]}B").`);
  }
}

function assertUniqueCandidateNames(candidates) {
  const seen = new Set();
  for (const c of candidates) {
    if (!c || !c.name) throw new Error('every round-robin candidate needs a "name"');
    if (seen.has(c.name)) throw new Error(`duplicate candidate name "${c.name}" — round-robin standings are keyed by name`);
    seen.add(c.name);
  }
  // Every pairing this field will produce goes through runDuel, so catch a collision here rather
  // than partway through a long tournament.
  for (let i = 0; i < candidates.length; i++)
    for (let j = i + 1; j < candidates.length; j++)
      assertNoOverrideCollision(candidates[i], candidates[j]);
}

// Round-robin over N > 2 candidates: every unordered pair, run through runDuel exactly as a
// single --a/--b duel would be. A nice-to-have that falls straight out of runDuel already
// being pair-shaped — deliberately NOT a new tournament engine (no swiss pairing, no bracket):
// just every pair, once, tallied. Exported so a test can exercise it without going via argv.
// The pair list itself comes from pairing.js's roundRobinPairs, which IS the nested i/j loop this
// function used to write inline — same pairs, same order, now shared with the in-game round-robin
// format so there is one round-robin schedule rather than two.
export function runRoundRobin(candidates, opts = {}) {
  assertUniqueCandidateNames(candidates);
  const pairs = roundRobinPairs(candidates).map(([a, b]) => runDuel(a, b, opts));
  const standings = new Map(candidates.map(c => [c.name, { name: c.name, wins: 0, losses: 0, draws: 0 }]));
  for (const res of pairs) {
    const A = standings.get(res.aName), B = standings.get(res.bName);
    A.wins += res.aWins; A.losses += res.bWins; A.draws += res.draws;
    B.wins += res.bWins; B.losses += res.aWins; B.draws += res.draws;
  }
  return { pairs, standings: [...standings.values()].sort((x, y) => y.wins - x.wins) };
}

/* ============================================================
   TIER 3 — a candidate compared against remembered numbers is a candidate compared against
   nothing (docs/odyssey-ai-review.md §3, the ai-lab skill's standing lesson). runDuel above is
   already a fair SINGLE match-up: one map-side assignment (A="player", B="ai"), one difficulty.
   Tier 3 wraps it with the two things a noisy objective needs before a verdict means anything:

   1. SIDE-SWAP, on by DEFAULT (not a flag to remember). runDuel's own header comment already
      names why: "the two owner slots are not perfectly symmetric, different starting corner,
      different fog seed stream" — map-side asym (oort/nimbus) is the mechanical example
      runDuel already documents and corrects for WITHIN one direction (swapAsym by replicate
      parity), but that only balances the map; it says nothing about whether the "ai" owner
      slot itself is a structurally easier seat to play (a different think-cadence phase
      offset, a different fog stream, in principle even an unnoticed engine asymmetry between
      the two owner code paths). The only way to rule that out is to literally run the pairing
      both ways — A as "ai"/B as "player", THEN B as "ai"/A as "player" — and look at both
      halves, not just their sum. runSwappedDuel below returns `aAsAi` and `bAsAi` as two full,
      independently-inspectable sub-results (not just labelled rows folded into one number) for
      exactly that reason: a side-symmetry bug would show up as those two disagreeing, and
      collapsing them into a single aggregate is precisely what would hide it.
   2. DIFFICULTY as a swept, NEVER-BLENDED axis. runDuelBrackets below takes a LIST of
      difficulties and runs the full side-swapped pairing separately at each one, returning one
      result per difficulty — never a mean across them. Averaging across difficulty brackets
      would let a strategy's edge at one difficulty's APM/micro cap paper over a deficit at
      another's, which is exactly the APM confound the whole duel mechanism exists to rule out
      (see the FAIRNESS paragraph on runDuel above) — just reintroduced one level up, between
      brackets instead of between sides. So each bracket is reported standalone, on purpose.
   ============================================================ */

// Relabel a runDuel() result (and every one of its rows) from B's perspective to A's — i.e.
// turn "the result of runDuel(b, a, opts)" into "what A did, reported as if A were the first
// argument". Only swaps WHICH name/strategy/score a value is filed under; the underlying match
// numbers (winReason, time, world, seed, swapAsym) are untouched. This is how runSwappedDuel
// below lets both directions read with the same aName/bName regardless of which candidate
// runDuel itself treated as owner "player" for that call.
function flipDuelResult(res) {
  const flipRow = r => ({
    ...r,
    aName: r.bName, bName: r.aName,
    aStrategy: r.bStrategy, bStrategy: r.aStrategy,
    aDifficulty: r.bDifficulty, bDifficulty: r.aDifficulty,
    aApm: r.bApm, bApm: r.aApm, aMicro: r.bMicro, bMicro: r.aMicro,
    winner: r.winner === "a" ? "b" : r.winner === "b" ? "a" : "draw",
    aScore: r.bScore, bScore: r.aScore, margin: -r.margin,
  });
  return {
    aName: res.bName, bName: res.aName, aStrategy: res.bStrategy, bStrategy: res.aStrategy,
    difficulty: res.difficulty, n: res.n,
    aWins: res.bWins, bWins: res.aWins, draws: res.draws, avgMargin: -res.avgMargin,
    rows: res.rows.map(flipRow),
  };
}

// Candidate A vs candidate B, BOTH ways, aggregated — the side-swap default described above.
// `bAsAi` is runDuel(a, b, opts) as-is (B plays owner "ai", A plays "player" — runDuel's own
// fixed mapping). `aAsAi` is runDuel(b, a, opts) relabelled to A's perspective (A plays owner
// "ai", B plays "player"): same mechanism, opposite assignment. Both are returned in full,
// alongside the combined tallies, so a caller (or a test) can inspect either direction on its
// own — see the TIER 3 header comment above for why collapsing them would hide exactly the bug
// this exists to catch.
export function runSwappedDuel(a, b, opts = {}) {
  if (!a || !a.name) throw new Error('candidate A needs a "name"');
  if (!b || !b.name) throw new Error('candidate B needs a "name"');
  const bAsAi = runDuel(a, b, opts);
  const aAsAi = flipDuelResult(runDuel(b, a, opts));
  const n = bAsAi.n + aAsAi.n;
  const aWins = bAsAi.aWins + aAsAi.aWins;
  const bWins = bAsAi.bWins + aAsAi.bWins;
  const draws = bAsAi.draws + aAsAi.draws;
  const avgMargin = +(((bAsAi.avgMargin * bAsAi.n) + (aAsAi.avgMargin * aAsAi.n)) / n).toFixed(1);
  return {
    aName: a.name, bName: b.name, aStrategy: bAsAi.aStrategy, bStrategy: bAsAi.bStrategy,
    difficulty: bAsAi.difficulty, n, aWins, bWins, draws, avgMargin,
    bAsAi, aAsAi,   // the two independently-inspectable directions — see header comment
  };
}

// The side-swapped pairing, run separately at every difficulty in `opts.difficulties` (falls
// back to a single-element list built from `opts.difficulty`, default "medium" — the same
// default runDuel itself has always used, so an existing single-difficulty caller sees no
// change). Returns one runSwappedDuel result PER difficulty, each carrying its own `difficulty`
// field — deliberately an array, never averaged into one row. See the TIER 3 header comment
// above for why blending brackets would reintroduce the APM confound.
export function runDuelBrackets(a, b, opts = {}) {
  const { difficulties, difficulty, ...rest } = opts;
  const list = difficulties && difficulties.length ? difficulties : [difficulty || "medium"];
  return list.map(diff => runSwappedDuel(a, b, { ...rest, difficulty: diff }));
}

// Round-robin, side-swapped, difficulty-bracketed: every unordered pair of `candidates`,
// duelled via runSwappedDuel, separately at every difficulty in `opts.difficulties` (same
// fallback as runDuelBrackets). Returns one { difficulty, pairs, standings } per difficulty —
// never one standings table blended across brackets, for the same reason runDuelBrackets keeps
// its results separate.
export function runRoundRobinSwapped(candidates, opts = {}) {
  assertUniqueCandidateNames(candidates);
  const { difficulties, difficulty, ...rest } = opts;
  const list = difficulties && difficulties.length ? difficulties : [difficulty || "medium"];
  return list.map(diff => {
    // Same shared every-unordered-pair schedule runRoundRobin uses — see its comment above.
    const pairs = roundRobinPairs(candidates).map(([a, b]) => runSwappedDuel(a, b, { ...rest, difficulty: diff }));
    const standings = new Map(candidates.map(c => [c.name, { name: c.name, wins: 0, losses: 0, draws: 0 }]));
    for (const res of pairs) {
      const A = standings.get(res.aName), B = standings.get(res.bName);
      A.wins += res.aWins; A.losses += res.bWins; A.draws += res.draws;
      B.wins += res.bWins; B.losses += res.aWins; B.draws += res.draws;
    }
    return {
      difficulty: pinnedDuelDials(diff).difficulty,   // normalized — see pinnedDuelDials' own comment
      pairs, standings: [...standings.values()].sort((x, y) => y.wins - x.wins),
    };
  });
}

/* ============================================================
   TIER 5 — SWISS PAIRING: a schedule that scales in ROUNDS, not in candidates squared, for
   candidate pools too large for runRoundRobinSwapped's full round-robin to stay cheap.

   Every pairing above (leaderboard, duel, round-robin) is trustworthy because it's built on
   runSwappedDuel — side-swapped, difficulty-bracketed, APM/micro pinned identical for both
   sides. Round-robin's only weakness is its SCHEDULE: C(n,2) pairings, so a pool of 20
   candidates is already 190 pairings, each `worlds x seeds x 2 sides` matches — the quadratic
   cost the Tier 5 stretch goal in the roadmap named directly. Swiss pairing is the standard
   answer (chess/Magic tournament scheduling): each round pairs candidates with the CLOSEST
   current standing instead of every candidate meeting every other one, so after
   `rounds` = O(log2 n) rounds the ranking has converged without ever running the full
   quadratic schedule. This file changes NOTHING about what a "fair fight" means — every
   pairing below is still exactly one runSwappedDuel call, same fairness guarantees, same
   opts shape as runDuel/runRoundRobinSwapped. Tier 5 is a new SCHEDULE on top of a trusted
   primitive, not a new way of deciding who won a match.

   THE PAIRING RULE ITSELF NOW LIVES IN ../pairing.js — moved there whole, comments included
   (docs/competitions-and-elo.md Phase 3), so the in-game competition screen schedules a tournament
   through this exact code instead of a second copy of it. Its header carries the two paragraphs
   that used to sit here: PAIRING RULE (why findMatching backtracks rather than walking greedily —
   independent review measured avoidable repeats in a quarter to half of realistic tournaments with
   the greedy version) and BYES (why a bye adds to nobody's wins/losses, which the first cut got
   wrong). Read them there before changing any of it. rankStandings/pairRound/buildSwissBracket are
   re-exported below under their original names, so every caller here — and every test — is
   unchanged.

   ROUNDS: default `Math.max(3, Math.ceil(Math.log2(candidates.length)))` — the textbook rule
   of thumb for how many Swiss rounds separate a field of that size — override with `--rounds`.
   Like runDuelBrackets/runRoundRobinSwapped, `--difficulties` (plural) runs the WHOLE Swiss
   schedule again per difficulty, each one its own independent tournament (own pairings, own
   standings) — never blended, for the identical reason those two keep brackets separate.
   ============================================================ */

// pairKey, MATCH_ATTEMPT_CAP, findMatching, greedyMatching, rankStandings, pairRound and
// buildSwissBracket were all declared right here until Phase 3 moved them — whole, comments
// included — into the root-level ../pairing.js (see the header comment above for why). The three
// this file has always exported are re-exported from there under the same names, so
// `import { pairRound, rankStandings, buildSwissBracket } from "../tools/ailab.js"` keeps
// resolving exactly as before; the other four were internal to the matcher and stay internal,
// now to pairing.js.
export { rankStandings, pairRound, buildSwissBracket };

function runSwissBracket(candidates, numRounds, opts) {
  return {
    difficulty: pinnedDuelDials(opts.difficulty).difficulty,   // normalized — see pinnedDuelDials' own comment
    ...buildSwissBracket(candidates, numRounds, opts, runSwappedDuel),
  };
}

// Swiss-paired tournament over `candidates`: `Math.max(3, Math.ceil(Math.log2(n)))` rounds by
// default (override with `opts.rounds`), each round pairing candidates by CLOSEST current
// standing rather than running the full C(n,2) round-robin — see the TIER 5 header comment
// above for why and for exactly what stays identical to round-robin (the pairing primitive,
// runSwappedDuel, and its fairness guarantees) versus what's new (the schedule). Same
// `--difficulties` plural/never-blended convention as runDuelBrackets/runRoundRobinSwapped:
// returns one independent { difficulty, rounds, roundsLog, standings } tournament per bracket.
export function runSwissTournament(candidates, opts = {}) {
  assertUniqueCandidateNames(candidates);
  if (candidates.length < 2) throw new Error("a Swiss tournament needs at least 2 candidates");
  const { difficulties, difficulty, rounds, ...rest } = opts;
  const list = difficulties && difficulties.length ? difficulties : [difficulty || "medium"];
  // pairing.js's swissRoundCount IS this formula — shared rather than kept as a second copy, so the
  // in-game tournament screen (which shows the default it will use before starting) and this CLI
  // can never disagree about how many rounds "default" means.
  const numRounds = rounds || swissRoundCount(candidates.length);
  return list.map(diff => runSwissBracket(candidates, numRounds, { ...rest, difficulty: diff }));
}

/* ============================================================
   EVOLUTION — a population of genomes, selected by real self-play (docs/ai-evolution-design.md)

   `search` above is a coordinate scan: it moves ONE dial at a time and greedily keeps whatever
   improved. That is the cheapest thing that works, and it has a structural blind spot — it cannot
   cross a valley where two dials must move TOGETHER. This codebase has the worked example already
   written down: engine/aiStrategy.js records that Aggressive finished last of four in self-play,
   that a coordinate scan over its own offense dials could not fix it, and that what fixed it was
   an ECONOMY dial (workerTargetMult) borrowed from another strategy. A scan structurally cannot
   find that; a population with mutation and crossover finds it by construction.

   So this is the same "candidate vs a yardstick" shape the rest of the file has, with three
   differences: candidates are generated rather than hand-written (tools/genome.js), there are many
   of them at once, and the yardstick includes each other.

   WHAT MAKES THE FITNESS TRUSTWORTHY, since that is the only part that decides whether any of this
   is real:

     • It is DUEL Elo, not score(). score()'s six weights are a hand-written definition of "better
       AI", and a population is a machine for exploiting hand-written definitions — `thrift` pays
       for ending poor (a genome that dumps ore into junk turrets farms it), `pressure` counts
       waves (a genome that trickles one unit at a time farms it). A win cannot be farmed except by
       winning. score() stays available as a DIAGNOSTIC via `sweep`, never as the objective here.
     • It is SWISS-scheduled, so a generation costs O(n log n) pairings instead of round-robin's
       C(n,2) — the difference between a generation taking minutes and taking an hour, which is
       the difference between running this and not.
     • The four shipped baselines ride along as a HALL OF FAME. A population evolving only against
       itself can drift in a cycle forever (rusher beats greedy beats turtle beats rusher) with no
       absolute progress — the Red Queen. Elo measured partly against a fixed anchor is absolute.
       tools/candidates/baseline-*.json already exist and are exactly that anchor.
     • Every bracket in `--difficulties` is rated SEPARATELY and then aggregated by the WORST of
       them by default (`--agg min`). engine/aiStrategy.js has the cautionary row for this too: a
       workerTargetMult of 1.4 wins Medium harder and LOSES Hard, because Hard's own row already
       carries 1.25 and the layers compose multiplicatively. A genome scored on one difficulty is
       not scored.
     • Every pairing in the whole run shares ONE seedKey (tools/duelCore.js duelSeed), so every
       genome ever evaluated in round R faced the identical maps. Without it, each generation's
       generated names hash to their own map set and "the child beat its parent's number" is partly
       a statement about map luck. The cost of pinning is that the run can overfit that map set,
       which is what `--holdout-worlds` is for: validate the champion on worlds it never trained on
       and report both numbers.
   ============================================================ */

const EVO_SEED_KEY = "evolve";        // see the seedKey paragraph above — one pinned map set per run
const ARCHIVE_SEED_KEY = "archive";   // the solo-bench twin of it — see runSeed's own comment

/**
 * Rate one generation's field and return fitness per candidate name. One INDEPENDENT rating table
 * per difficulty bracket (elo.js D2: brackets are never blended), aggregated by `agg`.
 * @returns {{ fitness: Map<string, number>, perBracket: Object[] }}
 */
function rateGeneration(candidates, { difficulties, agg, ...opts }) {
  const brackets = runSwissTournament(candidates, { ...opts, difficulties });
  const ratings = brackets.map(b => eloForMatches(b.roundsLog.flatMap(r => r.matches)));
  const fitness = new Map();
  for (const c of candidates) {
    const vals = ratings.map(t => (t[c.name] ? t[c.name].rating : INITIAL_RATING));
    fitness.set(c.name, agg === "mean" ? vals.reduce((a, v) => a + v, 0) / vals.length : Math.min(...vals));
  }
  return { fitness, perBracket: brackets.map((b, i) => ({ difficulty: b.difficulty, standings: b.standings, ratings: ratings[i] })) };
}

/**
 * Disqualify a genome that trips one of the named CHECKS — a genome that wins duels while
 * deadlocking its own supply is a bug the search found, not a strategy.
 *
 * OPT-IN, and that is a deliberate calibration argument rather than a cost one. Every detector in
 * CHECKS is written for a 40-60 sim-minute ODYSSEY run and several carry an explicit
 * "…and it never resolved in the last third" term keyed to that length. Run them over a duel-length
 * skirmish and they fire on healthy genomes — which is the exact failure this file's own CHECKS
 * header calls out ("a metric that fires on correct behaviour is worse than no metric", three
 * rewrites). So the screen runs at its OWN length on its OWN Odyssey worlds, and only when asked.
 */
function screenGenome(cand, { worlds, minutes, opponent, seedBase }) {
  const snap = snapshotTables();
  try {
    if (cand.overrides) applyOverrides(cand.overrides);
    const tripped = new Set();
    for (const world of worlds) {
      const r = run({ minutes, sample: 5, opponent, apm: "real", seedBase, world,
                      strategy: cand.strategy, difficulty: "medium",
                      seed: runSeed(seedBase, world, cand.strategy, "medium", 0) });
      for (const c of CHECKS) if (c.hit(r)) tripped.add(c.id);
    }
    return [...tripped];
  } finally {
    restoreTables(snap);
  }
}

/**
 * Run the whole thing. Returns a plain result object (never console output) so the CLI and a test
 * can both read it — the same shape discipline runSearch already follows. `best` is the champion
 * lowered back into a runnable candidate; `bestEdge` (not `bestFitness`) is the cross-generation
 * comparable number — see the anchoring comment in the loop below.
 * @param {Object} opts
 * @returns {{ genes: Object[], layers: string[], odyssey: boolean, agg: string,
 *   generations: number, population: number, bestName: string, bestGenome: Object,
 *   bestFitness: number, bestEdge: number, bestGen: number, best: Object, log: Object[] }}
 */
export function runEvolution({
  population = 12, generations = 5, seed = 1, elites = 2,
  worlds = ["korrath", "ferros", "vesper"], difficulties = ["medium"], seeds = 1, minutes = 40,
  rounds, agg = "min", layers = ["strategy"], odyssey = false,
  hallOfFame = [], seedStrategies = Object.keys(STRATEGIES),
  screen = null, onGeneration = null,
} = {}) {
  const genes = geneKeys({ layers, odyssey });
  if (!genes.length) throw new Error(`no genes selected — layers "${layers.join(",")}" matched nothing in GENOME_SCHEMA`);
  const rng = rngFor(hashStr(`${seed}:evolve`));

  // SEED THE POPULATION from the shipped strategies first. They are the best starting points
  // anyone has — four rows with real human search already spent on them — and a run that discards
  // them starts from behind. The remainder is split between mutated copies of those (local search
  // around known-good) and uniformly random genomes (so the run can reach regions no shipped row
  // is near).
  let pop = [];
  for (const key of seedStrategies) {
    if (pop.length >= population) break;
    pop.push(genomeFrom({ strategy: key, genes }));
  }
  const seeded = pop.length;
  // Alternate mutant/random, and cycle the mutant's PARENT across all the seeded rows rather than
  // deriving from pop.length (which, at an even population, only ever lands on the even-indexed
  // seeds — half the shipped strategies would get no local search around them at all).
  for (let fill = 0; pop.length < population; fill++) {
    pop.push(fill % 2 === 0 && seeded
      ? mutate(pop[Math.floor(fill / 2) % seeded], rng, { genes })
      : randomGenome(rng, genes));
  }

  const log = [];
  let best = null;
  for (let gen = 1; gen <= generations; gen++) {
    const named = pop.map((genome, i) => {
      const name = `g${gen}i${i}`;
      return { genome, name, cand: toCandidate(genome, name, { genes }) };
    });
    const field = [...named.map(n => n.cand), ...hallOfFame];
    const { fitness, perBracket } = rateGeneration(field, {
      worlds, difficulties, seeds, seedBase: seed, minutes, rounds, agg, seedKey: EVO_SEED_KEY,
    });

    // Screening runs AFTER rating (so the log records what a disqualified genome would have
    // scored) and only over the individuals that could actually be selected.
    const ranked = named.map(n => ({ ...n, fitness: fitness.get(n.name), tripped: [] }))
      .sort((x, y) => y.fitness - x.fitness);
    if (screen) {
      for (const r of ranked.slice(0, Math.max(elites, Math.ceil(ranked.length / 2)))) {
        r.tripped = screenGenome(r.cand, { ...screen, seedBase: seed });
        if (r.tripped.length) r.fitness = -Infinity;
      }
      ranked.sort((x, y) => y.fitness - x.fitness);
    }

    const anchors = hallOfFame.map(h => ({ name: h.name, elo: fitness.get(h.name) }));
    const champion = ranked[0];
    // ANCHOR THE SCALE. Elo is folded from a FRESH 1200 baseline over each generation's own
    // matches (eloForMatches — no persistence across runs, elo.js D7), so a raw rating is only
    // comparable WITHIN a generation: the field changes every generation and the mean is pinned at
    // 1200 whatever the field's absolute strength. Comparing generation 5's champion to generation
    // 1's on raw Elo would therefore measure nothing at all — the exact Red Queen failure the hall
    // of fame exists to prevent, reintroduced in the arithmetic.
    //   `edge` is the rating ABOVE the hall of fame's own mean in the same tournament. The anchors
    // are fixed genomes, so their mean is a fixed point of skill, and an edge IS comparable across
    // generations. Within a generation it is a constant offset, so it changes no ranking.
    //   With no hall of fame there is nothing to anchor to, and edge degenerates to "rating above
    // the 1200 origin" — still the honest number, just not an absolute one; the CLI says so.
    const anchorMean = anchors.length
      ? anchors.reduce((a, x) => a + x.elo, 0) / anchors.length : INITIAL_RATING;
    for (const r of ranked) r.edge = r.fitness === -Infinity ? -Infinity : r.fitness - anchorMean;
    if (!best || champion.edge > best.edge) best = { ...champion, gen };
    log.push({
      gen, anchorMean: +anchorMean.toFixed(1),
      ranked: ranked.map(r => ({ name: r.name, elo: +r.fitness.toFixed(1), edge: +r.edge.toFixed(1),
                                 sigma: +r.genome.sigma.toFixed(3), tripped: r.tripped })),
      anchors: anchors.map(a => ({ name: a.name, elo: +a.elo.toFixed(1) })),
      perBracket: perBracket.map(b => ({ difficulty: b.difficulty, standings: b.standings })),
      champion: { name: champion.name, elo: +champion.fitness.toFixed(1), edge: +champion.edge.toFixed(1) },
    });
    if (onGeneration) onGeneration(log[log.length - 1], ranked, anchors);
    if (gen === generations) break;

    // BREED. Elites carried through UNCHANGED — a generation that can lose its best individual to
    // an unlucky mutation is not monotonic, and with a noisy objective it will do that regularly.
    const next = ranked.slice(0, elites).map(r => cloneGenome(r.genome));
    // Tournament selection: three at random, fittest breeds. Cheap, needs no normalised fitness
    // (Elo is an interval scale with an arbitrary origin — proportional selection on it would be
    // meaningless), and its selection pressure is tunable by the tournament size alone.
    const draft = () => {
      let bestOf = null;
      for (let k = 0; k < 3; k++) {
        const c = ranked[Math.floor(rng() * ranked.length)];
        if (!bestOf || c.fitness > bestOf.fitness) bestOf = c;
      }
      return bestOf.genome;
    };
    while (next.length < population) {
      const p1 = draft(), p2 = draft();
      next.push(mutate(cross(p1, p2, rng, { genes }), rng, { genes }));
    }
    pop = next;
  }

  return {
    genes, layers, odyssey, agg, generations, population,
    bestName: best.name, bestGenome: best.genome, bestFitness: best.fitness, bestEdge: best.edge,
    bestGen: best.gen, best: toCandidate(best.genome, "evolved", { genes }),
    log,
  };
}

/* ============================================================
   ARCHIVE — MAP-Elites: breed a CAST of distinct opponents, not one optimum

   `evolve` above searches for a single best genome, and its first real run showed exactly why
   that is the wrong target for this game. The champion it found beat all four shipped strategies
   on held-out worlds — and won by never attacking, because engine/victory.js's score-at-clock
   tiebreak pays 1.35x for combat units and 0.25x for banked ore, so an army that never fights and
   never takes attrition is the most valuable thing you can own when the clock runs out. A better
   number, a worse opponent. (docs/ai-evolution-design.md §9, and the 2026-08-06 ledger rows.)

   Odyssey has no win condition. What the game actually wants from this search is what ARCHETYPES
   is trying to be by hand with four entries: a CAST of distinct, legible opponents. So this
   command optimises for a filled grid rather than a maximum.

   HOW IT DIFFERS FROM `evolve`, in the three places that matter:

     1. THE ARCHIVE REPLACES THE POPULATION. Every genome is binned by how it BEHAVES (see
        ARCHIVE_DIMS) and only ever competes against the current occupant of its own cell. A
        genome that wins by refusing to fight can therefore only ever win the "never attacks"
        cell — it cannot crowd out the rest of the cast, which is the structural answer to the
        Goodhart failure above rather than a hand-written penalty for it.
     2. FITNESS IS AGAINST A FIXED PANEL, not a tournament of peers. Every genome plays the SAME
        four shipped baselines, so its score is absolute and comparable across the whole run —
        which dissolves the anchoring problem `evolve` had to correct for (eloForMatches restarts
        from a fresh 1200 each generation, so ratings there are only comparable within one).
     3. THE HEALTH SCREEN IS FREE, AND SELF-CALIBRATING. Describing a genome means running it solo
        on the Odyssey bench, which is exactly what CHECKS needs. So `evolve`'s opt-in `--screen`
        is ON by default here at no extra cost.
          But it screens RELATIVE TO THE SHIPPED STRATEGIES, not against the raw detector list, and
        that is not a nicety — the first real run of this command refused 39 of its first 41
        genomes INCLUDING all four shipped strategies, which is proof the screen was wrong rather
        than the genomes. The cause: CHECKS was calibrated against the `passive` sparring bot, and
        the descriptor run deliberately uses a PROVOKING one (see below), where an AI spends on
        army and takes losses so `devFinal` never clears dev-flatline's threshold. A detector that
        fires on correct behaviour is worse than no detector — this file's own CHECKS header
        records three rewrites of exactly that mistake, and choosing a different opponent
        reintroduced it a fourth time.
          So: the seed strategies are evaluated first and always seated, the union of what THEY
        trip becomes the tolerated set, and a genome is refused only for a defect the shipped AI
        does not also exhibit under identical conditions. That is the question the screen was
        always trying to ask, and it now re-answers it for whatever opponent and match length the
        caller picks instead of assuming one.

   The descriptor run uses the `turtle` sparring bot by default: a real economy behind turrets that
   never attacks, but whose turrets kill scouts and so DO provoke. That makes the aggression axis
   measure something real — "does this neighbour come at a defended base?" — rather than just
   echoing the neverInitiates flag back, since in Odyssey a provoked never-initiator may still
   answer (engine/diplomacy.js provoked()).
   ============================================================ */

// The behaviour space the cast is spread across. Two dimensions on purpose: a 2-D grid prints as a
// grid, fills at a rate a few hours of bench time can actually reach, and reads as a cast list.
//
// These two axes are the ones a PLAYER can feel from the other side of the map — does it come at
// me, and how much of it arrives — rather than the ones easiest to measure. Their corners are the
// four opponents anyone can name (never/token = a placid neighbour; never/swarm = the doomstack
// turtle `evolve` found; waves/token = a rusher trickling probes; waves/swarm = the one that
// should scare you), and the interior is everything between.
//
// `edges` are the bin boundaries: a value < edges[0] lands in bin 0, and so on. Exported so a test
// can assert the bins are total and ordered rather than trusting the literal.
export const ARCHIVE_DIMS = [
  { key: "waves", label: "aggression", edges: [1, 3, 7], names: ["never", "probes", "raids", "waves"] },
  { key: "armyFinal", label: "army", edges: [6, 16, 31], names: ["token", "small", "large", "swarm"] },
];

/** Which bin `v` falls in. @param {number} v @param {number[]} edges @returns {number} */
export function binOf(v, edges) {
  let i = 0;
  while (i < edges.length && v >= edges[i]) i++;
  return i;
}

/** The archive key for one descriptor vector, e.g. "never/swarm". @returns {string} */
const cellKey = desc => ARCHIVE_DIMS.map(d => d.names[binOf(desc[d.key], d.edges)]).join("/");

/**
 * Describe a candidate: run it solo on the Odyssey bench and read back BOTH its behaviour
 * descriptors and whether it trips any named defect. One pass, two answers — see point 3 in the
 * header above.
 * @returns {{ desc: Object, tripped: string[], rows: Object[] }}
 */
function describeCandidate(cand, { worlds, minutes, opponent, difficulty, seedBase, seeds = 1 }) {
  const snap = snapshotTables();
  try {
    if (cand.overrides) applyOverrides(cand.overrides);
    const rows = [];
    for (const world of worlds)
      for (let rep = 0; rep < seeds; rep++)
        rows.push(run({
          minutes, sample: 5, opponent, apm: "real", seedBase, world,
          strategy: cand.strategy, difficulty, archetype: cand.archetype || undefined,
          // ARCHIVE_SEED_KEY, not the candidate's name — every genome in a run is described on the
          // IDENTICAL maps, and a saved cell re-reads on those same maps later. See runSeed.
          seed: runSeed(seedBase, world, cand.strategy, difficulty, rep, ARCHIVE_SEED_KEY),
        }));
    // MEDIAN across worlds and replicates — not the mean, and that is a measured decision rather
    // than a preference.
    //
    // The first real run of this command filed two genomes three bins apart on the army axis (8 vs
    // 113) that differ in ONE active gene; re-measured, they swapped ends of the axis. Probing why,
    // with one genome held fixed on pinned maps over 4 replicates per world, gave: korrath
    // 26/23/22/27 (perfectly stable), vesper 1/0/8/0, and ferros 36/3/1/296. The distribution is
    // HEAVY-TAILED — an Odyssey economy that gets going compounds, so one run in twelve returns an
    // order of magnitude more army than the rest.
    //
    // Averaging cannot fix a heavy tail; it inherits it. The same 12 runs give a mean of 21.0 / 14.8
    // / 36.9 at 1 / 2 / 4 replicates — diverging, because whichever sample happens to contain the
    // 296 decides the answer. The median over the identical samples gives 26 / 13 / 15, which
    // converges. So the axis is stabilised by a robust statistic at unchanged cost, and `seeds`
    // then buys real precision on top instead of buying lottery tickets.
    const median = xs => {
      const s = [...xs].sort((a, b) => a - b);
      const m = s.length >> 1;
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    };
    const desc = {};
    for (const d of ARCHIVE_DIMS) desc[d.key] = median(rows.map(r => r[d.key] || 0));
    const tripped = [...new Set(rows.flatMap(r => CHECKS.filter(c => c.hit(r)).map(c => c.id)))];
    return { desc, tripped, rows };
  } finally {
    restoreTables(snap);
  }
}

/**
 * Strength against the FIXED panel — every genome faces the identical opponents, so the number is
 * absolute rather than relative to whoever else happens to be in the run. Returns a win rate in
 * [0, 1] over every panel member x world x seed x both owner slots.
 */
function panelStrength(cand, panel, { worlds, seeds, minutes, difficulty, seedBase }) {
  let wins = 0, n = 0;
  for (const opponent of panel) {
    const res = runSwappedDuel(cand, opponent, { worlds, seeds, minutes, difficulty, seedBase, seedKey: EVO_SEED_KEY });
    wins += res.aWins;
    n += res.n;
  }
  return n ? wins / n : 0;
}

/**
 * MAP-Elites over the AI genome. Returns the archive as a plain array of cells — never console
 * output, same shape discipline as runSearch/runEvolution.
 * @param {Object} opts
 * @returns {{ cells: Object[], dims: Object[], evaluated: number, rejected: number,
 *   coverage: number, genes: Object[], log: Object[] }}
 */
export function runArchive({
  iterations = 60, seed = 1, layers = ["strategy"], odyssey = false,
  descriptorWorlds = ["korrath", "ferros", "vesper"], descriptorMinutes = 40, descriptorSeeds = 2,
  descriptorOpponent = "turtle", difficulty = "medium",
  duelWorlds = ["korrath", "ferros"], duelSeeds = 1, duelMinutes = 40,
  panel = [], screen = true, seedStrategies = Object.keys(STRATEGIES), onCell = null,
} = {}) {
  const genes = geneKeys({ layers, odyssey });
  const rng = rngFor(hashStr(`${seed}:archive`));
  const archive = new Map();
  const log = [];
  let evaluated = 0, rejected = 0;

  const descOpts = { worlds: descriptorWorlds, minutes: descriptorMinutes, opponent: descriptorOpponent,
                     difficulty, seedBase: seed, seeds: descriptorSeeds };
  const duelOpts = { worlds: duelWorlds, seeds: duelSeeds, minutes: duelMinutes, difficulty, seedBase: seed };

  // The defects the SHIPPED strategies themselves exhibit under this run's own opponent and match
  // length. Null until the seeds have been measured, which is what disables the screen for them —
  // see point 3 in the header for why screening against the raw detector list was wrong.
  let tolerated = null;

  // Evaluate one genome and try to seat it. A genome only ever displaces the CURRENT OCCUPANT of
  // its own cell, which is the whole mechanism: local competition, global diversity.
  const consider = (genome, origin) => {
    const name = `arch${evaluated}`;
    const cand = toCandidate(genome, name, { genes });
    const { desc, tripped } = describeCandidate(cand, descOpts);
    evaluated++;
    // Only defects the shipped AI does NOT also show here count against a genome.
    const novel = tolerated ? tripped.filter(t => !tolerated.has(t)) : [];
    if (screen && novel.length) {
      rejected++;
      log.push({ name, origin, cell: cellKey(desc), desc, tripped, novel, seated: false, reason: "screen" });
      // Report the refusal too, not just the seatings. A screen that is rejecting EVERYTHING looks
      // identical to a search that is finding nothing unless each refusal is visible — and there is
      // a specific, easy way to land in that state: CHECKS is calibrated for 40-60 sim-minute runs
      // (several detectors carry an "…and it never resolved in the last third" term keyed to that
      // length), so a short --descriptor-minutes makes every healthy genome trip dev-flatline.
      if (onCell) onCell(log[log.length - 1], archive);
      return { tripped, seated: false };
    }
    const key = cellKey(desc);
    const fitness = panelStrength(cand, panel, duelOpts);
    const incumbent = archive.get(key);
    const seated = !incumbent || fitness > incumbent.fitness;
    if (seated) archive.set(key, { key, genome, desc, fitness, name, origin, evaluatedAt: evaluated });
    log.push({ name, origin, cell: key, desc, tripped, novel, fitness: +fitness.toFixed(3), seated,
               beat: incumbent ? +incumbent.fitness.toFixed(3) : null });
    if (onCell) onCell(log[log.length - 1], archive);
    return { tripped, seated };
  };

  // SEED from the shipped strategies. Four hand-written rows with real search already spent on
  // them, and — the point here — four rows that already sit in different parts of the behaviour
  // space, so the archive starts spread rather than clustered.
  //
  // They also CALIBRATE the screen: whatever they trip under this run's own opponent and match
  // length is what the detectors are saying about the configuration rather than about a genome, so
  // it becomes the tolerated set and the seeds themselves are never refused. `tolerated` stays null
  // until this loop finishes, which is what exempts them.
  const seedTrips = new Set();
  for (const key of seedStrategies)
    for (const t of consider(genomeFrom({ strategy: key, genes }), `seed:${key}`).tripped) seedTrips.add(t);
  tolerated = seedTrips;

  while (evaluated < iterations) {
    const elites = [...archive.values()];
    let genome, origin;
    if (elites.length === 0) { genome = randomGenome(rng, genes); origin = "random"; }
    else if (elites.length >= 2 && rng() < 0.4) {
      // CROSS two elites from DIFFERENT cells — the operator earns its keep here in a way it
      // cannot in a converged population: the parents are known to play differently, so a
      // module-wise cut between them is a real recombination of two strategies rather than two
      // near-copies. This is the mechanism that fills interior cells the seeds don't reach.
      const a = elites[Math.floor(rng() * elites.length)];
      const b = elites[Math.floor(rng() * elites.length)];
      genome = mutate(cross(a.fitness >= b.fitness ? a.genome : b.genome,
                            a.fitness >= b.fitness ? b.genome : a.genome, rng, { genes }), rng, { genes });
      origin = `cross:${a.key}+${b.key}`;
    } else {
      const parent = elites[Math.floor(rng() * elites.length)];
      genome = mutate(parent.genome, rng, { genes });
      origin = `mutate:${parent.key}`;
    }
    consider(genome, origin);
  }

  const total = ARCHIVE_DIMS.reduce((a, d) => a * (d.edges.length + 1), 1);
  return {
    cells: [...archive.values()].sort((x, y) => x.key < y.key ? -1 : 1),
    dims: ARCHIVE_DIMS, evaluated, rejected, coverage: archive.size / total, genes, log,
    tolerated: [...tolerated],   // what the SHIPPED strategies trip here — report it, never hide it
  };
}

/* ============================================================
   HEALTH CHECKS — the findings this bench already turned up, encoded

   Each is a named, reproducible defect rather than a paragraph in a review doc: run the
   check, get the list of worlds it fires on. Fix the AI and the list shrinks. These are
   REPORTED, not asserted — the tool's job is to measure, and today several of them fire.

   THE DESIGN RULE, learned the expensive way (three rewrites across 2026-07-30 and
   2026-08-05, docs/odyssey-ai-review.md §2.12). Sort these five by the SHAPE of the
   predicate and the whole history explains itself:

     • carries a "…and it never resolved" term  — dev-flatline (devGrowthTail), hoarding
       (armyGrowthTail). Both survived two separate scale-ups of the AI untouched.
     • pure instantaneous fraction               — supply-deadlock, production-stall. Both
       became false positives the moment the AI got bigger, because "is this true right
       now, often enough?" is a question whose answer drifts with scale.

   So every detector here must now be BOTH halves: a symptom (a fraction of samples) AND a
   non-resolution term proving the symptom never cleared. A busy AI is momentarily blocked,
   momentarily idle, and momentarily rich all the time; only a stuck one is still in that
   state with nothing having moved. The absolute ore thresholds went the same way — a gate
   of "banked > 1000" is a statement about one particular size of economy, so both are now
   asked as "could it afford the exact purchase that would have resolved this?" (sample()'s
   canAffordUnblock / canAffordNext), which has no scale in it at all.

   test/ailab.test.js pins this as a property rather than a set of cases: a synthetic
   HEALTHY curve, scaled from 1x to 100x, must fire nothing. That is the guard that stops a fourth
   round of this.
   ============================================================ */

export const CHECKS = [
  { id: "supply-deadlock",
    why: "the mix cycle is stuck on a unit that won't fit under the supply cap, with no Habitat on "
       + "the way to raise it and the money to buy one — AND the cap never moved in the last third, "
       + "so it genuinely never resolved (being blocked while the ceiling climbs is ordinary supply "
       + "pressure on an AI outgrowing its housing, not a deadlock)",
    hit: r => r.supplyDeadlockFrac > 0.1 && r.supplyCapGrowthTail <= 0 },
  { id: "hoarding",
    why: "it finished sitting on a large bank AND its army hadn't grown — money it has no way to "
       + "spend, rather than a working balance in transit",
    hit: r => r.bankedFinal > 5000 && r.armyGrowthTail <= 0 },
  { id: "dev-flatline",
    why: "the industry/tech climb stopped: no development gained in the last third of the run",
    hit: r => r.devGrowthTail === 0 && r.devFinal < 12 },
  { id: "hostile-but-idle",
    why: "the HUD reads Hostile, the neighbour is entitled to act on it, and it never commits a wave "
       + "(samples where a never-initiating strategy was left unprovoked don't count — that's the contract)",
    hit: r => r.entitledSamples > 0 && r.hostileIdleFrac > 0.5 },
  { id: "production-stall",
    why: "every Barracks stood idle while the AI could afford the very unit it would have queued, "
       + "on a strategy that isn't deliberately capping its army — AND the army never grew in the "
       + "last third, so the line really had stopped rather than being between jobs",
    hit: r => r.idleRichFrac > 0.25 && r.armyGrowthTail <= 0 },
];

/* ============================================================
   CLI
   ============================================================ */

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) out[a.slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith("--")) ? argv[++i] : "true";
    else out._.push(a);
  }
  return out;
}

const list = (v, fallback) => (v ? String(v).split(",").map(x => x.trim()).filter(Boolean) : fallback);
const num = (v, d) => (v === undefined ? d : Number(v));

// Just the dials under search, so a search log shows what moved rather than the whole row.
const pickDials = (row, dials) => Object.fromEntries(dials.map(d => [d.k, row[d.k]]));

// Every run's seed is derived from (base seed, world, strategy, difficulty, replicate) so a
// row reproduces on its own — you can re-probe exactly one line of a sweep.
// `key` overrides the STRATEGY NAME in the hash, and exists for the same reason duelSeed's own
// seedKey does (tools/duelCore.js, docs/ai-evolution-design.md §8.1) — this is that trap's twin in
// the solo path, and it bites harder here because it defeats VERIFICATION. Re-measuring a saved
// candidate under a new name draws a different map set, so "I ran the archive's own cell again and
// got a different answer" conflates a genome changing with its maps changing. Measured: the
// archive's never/small and never/swarm cells re-read as army 93 and 2 under new names, against 8
// and 113 under their original ones. Pass one fixed key and every genome is described on identical
// ground. Omitted, this is byte-for-byte the derivation every existing caller has always used.
const runSeed = (base, world, strategy, difficulty, rep, key) =>
  hashStr(`${base}:${world}:${key ?? strategy}:${difficulty}:${rep}`);

function baseConfig(args) {
  return {
    minutes: num(args.minutes, 40),
    sample: num(args.sample, 5),
    opponent: args.opponent || "passive",
    seedBase: num(args.seed, 1),
    // 'real' (the default) is the whole point of this flag: exercise the AI's own difficulty-row
    // aiApm cap, the one dial every CLI run used to skip entirely. 'none' opts back into the old
    // always-unthrottled runs, for a baseline comparison against the bench's pre-APM history.
    apm: args.apm === "none" ? "none" : "real",
  };
}

function runMatrix(args, { worlds, strategies, difficulties, seeds }) {
  const base = baseConfig(args);
  const rows = [];
  for (const world of worlds)
    for (const strategy of strategies)
      for (const difficulty of difficulties)
        for (let rep = 0; rep < seeds; rep++)
          rows.push(run({ ...base, world, strategy, difficulty,
                          seed: runSeed(base.seedBase, world, strategy, difficulty, rep) }));
  return rows;
}

const pad = (v, w) => String(v).padEnd(w);
const padL = (v, w) => String(v).padStart(w);

function printTable(rows) {
  const cols = [
    ["world", 10, r => r.world], ["strategy", 11, r => r.strategy], ["diff", 7, r => r.difficulty],
    ["score", 6, r => score(r).total], ["dev", 4, r => r.devFinal], ["+dev", 5, r => r.devGrowthTail],
    ["army", 5, r => r.armyFinal], ["wrk", 4, r => r.workersFinal], ["bank", 7, r => r.bankedPeak],
    ["waves", 6, r => r.waves], ["idle%", 6, r => r.idleRichFrac], ["hostIdle", 9, r => r.hostileIdleFrac],
  ];
  console.log(cols.map(([h, w]) => pad(h, w)).join(""));
  console.log(cols.map(([, w]) => "-".repeat(w - 1) + " ").join(""));
  for (const r of rows) console.log(cols.map(([, w, f]) => pad(f(r), w)).join(""));
}

// One single-direction duel's rows plus its aggregate — reuses pad() exactly like printTable()
// above. Used both standalone (whichever direction is being shown) and by printSwappedDuel
// below, once per direction.
function printDuelRows(res) {
  console.log(pad("world", 10) + pad("seed", 13) + pad("swap", 6) + pad("winner", 8) + pad("reason", 16)
    + pad("time(s)", 9) + pad("aScore", 9) + pad("bScore", 9) + "margin");
  for (const r of res.rows)
    console.log(pad(r.world, 10) + pad(r.seed, 13) + pad(r.swapAsym, 6) + pad(r.winner, 8) + pad(r.winReason || "-", 16)
      + pad(r.time, 9) + pad(r.aScore, 9) + pad(r.bScore, 9) + r.margin);
  console.log(`\n${res.aName}: ${res.aWins}W  ${res.bName}: ${res.bWins}W  draws: ${res.draws}  `
    + `avg score margin (${res.aName} - ${res.bName}): ${res.avgMargin}`);
}

// A Tier 3 side-swapped, single-difficulty-bracket result (one entry of runDuelBrackets' array):
// prints BOTH directions (aAsAi/bAsAi) as their own labelled table, per the TIER 3 header
// comment — never collapsed into one set of rows — then the combined tally.
function printSwappedDuel(res) {
  console.log(`DUEL -- ${res.aName} (${res.aStrategy}) vs ${res.bName} (${res.bStrategy}) -- `
    + `difficulty "${res.difficulty}" pinned identical for both sides, ${res.n} matches total -- `
    + `side-swapped (both directions below), map-side asym (oort/nimbus) alternated by replicate `
    + `within each direction, a no-op elsewhere`);
  console.log(`\n  -- ${res.bName} as "ai", ${res.aName} as "player" (${res.bAsAi.n} matches) --`);
  printDuelRows(res.bAsAi);
  console.log(`\n  -- ${res.aName} as "ai", ${res.bName} as "player" (${res.aAsAi.n} matches) --`);
  printDuelRows(res.aAsAi);
  console.log(`\nCOMBINED (${res.difficulty}): ${res.aName}: ${res.aWins}W  ${res.bName}: ${res.bWins}W  `
    + `draws: ${res.draws}  avg score margin (${res.aName} - ${res.bName}): ${res.avgMargin}`);
}

// ELO — one shared implementation (elo.js, D1: the CLI and the in-game competition screen must
// mean the same thing by "rating," so this file imports elo.js rather than reimplementing any of
// its math). Computed FRESH per table printed below: Phase 1 has no persistent ledger yet (that's
// Phase 2's competitionLedger, docs/competitions-and-elo.md D8), so every CLI invocation starts
// every entrant at INITIAL_RATING and folds in only the matches THIS run just played. `matches` is
// a flat array of runSwappedDuel results (one per pairing); each is unpacked into its two
// directions (bAsAi rows, then aAsAi rows — the order runSwappedDuel itself actually ran them in)
// and fed through applySeries IN THE ORDER `matches` LISTS THEM — pairing order for a plain duel or
// round-robin, round-then-pairing-within-round for Swiss — so D6's canonical order (round, then
// pairing index, then side) falls straight out of how each command already schedules its matches,
// never reimposed here. Never blended across brackets/difficulties (D2): called once per bracket,
// below, never across two calls.
const eloRowOf = r => ({ aName: r.aName, bName: r.bName, score: r.winner === "a" ? 1 : r.winner === "draw" ? 0.5 : 0 });
const eloForMatches = matches => applySeries({}, matches.flatMap(res => [...res.bAsAi.rows, ...res.aAsAi.rows].map(eloRowOf)));
// D7: an entrant under 10 games in THIS table is still provisional — rendered with a trailing "?"
// rather than a number that reads as more settled than it is.
const formatElo = entry => !entry ? `${INITIAL_RATING}?`
  : entry.games < 10 ? `${Math.round(entry.rating)}?` : String(Math.round(entry.rating));

function printFindings(rows) {
  console.log("\nHealth checks (a row here is a reproducible defect, not a style note):");
  let any = false;
  for (const c of CHECKS) {
    const hits = rows.filter(c.hit);
    if (!hits.length) { console.log(`  ok    ${pad(c.id, 20)} —`); continue; }
    any = true;
    console.log(`  FIRES ${pad(c.id, 20)} ${hits.length}/${rows.length} runs`);
    console.log(`        ${c.why}`);
    console.log(`        ${hits.slice(0, 6).map(r => `${r.world}/${r.strategy}/${r.difficulty}`).join("  ")}`
      + (hits.length > 6 ? `  …+${hits.length - 6}` : ""));
  }
  if (!any) console.log("  (clean)");
}

/* ============================================================
   SEARCH — a deterministic coordinate scan over a strategy's numeric dials, keeping an
   improvement. Deliberately the simplest thing that works; the interesting judgement is which
   dials to open, and that stays the caller's.

   Two OBJECTIVES an evaluate() step can score a candidate dial-value by, selected once up front
   and never mixed mid-run:
     - default: solo score() against the --opponent scripted sparring bot (unchanged from before
       this file grew a second mode — same runMatrix/score call, same seed derivation).
     - --tournament-against baseline.json: Tier 2/3's fair, side-swapped, difficulty-bracketed
       self-play duel (runDuelBrackets) against a FIXED baseline candidate, standing measured as
       win differential (aWins - bWins) / n across every bracket combined. This is the same
       "candidate vs a fixed yardstick" shape score()-mode already has — just the yardstick is a
       real opponent playing the real AI, not a scripted bot's solitaire curve.

   The coordinate-scan mechanics below (the per-dial, per-step loop, "keep an improvement if it
   beats the current best") are IDENTICAL in both modes and don't know which objective is active
   — only evaluate()'s own body differs. Returns a plain result object (not console output) so
   both the CLI and a test can read it directly.
   ============================================================ */

export function runSearch(args) {
  const name = args.strategy || "default";
  const dials = list(args.dials, []).map(d => {
    const [k, range] = d.split("=");
    const [lo, hi] = String(range).split(":").map(Number);
    return { k, lo, hi };
  });
  if (!dials.length) return null;   // caller prints the --dials usage line
  const worlds = list(args.worlds, ["korrath", "ferros", "vesper"]);
  const difficulties = list(args.difficulties, ["medium"]);
  const steps = num(args.steps, 4);
  const base = { ...(STRATEGIES[name] || {}) };

  const baselinePath = args["tournament-against"];
  const baseline = baselinePath ? JSON.parse(readFileSync(baselinePath, "utf8")) : null;
  if (baseline && !baseline.name) throw new Error('--tournament-against candidate needs a "name"');

  // Solo score() against the scripted sparring bot — untouched from before this file had a
  // second mode: same runMatrix call, same score() reduction.
  const scoreEvaluate = row => {
    applyOverrides({ strategies: { [`${name}__lab`]: row } });
    const rows = runMatrix(args, { worlds, strategies: [`${name}__lab`], difficulties, seeds: num(args.seeds, 1) });
    return { mean: rows.reduce((a, r) => a + score(r).total, 0) / rows.length, rows };
  };
  // Tier 2/3 side-swapped, difficulty-bracketed self-play duel standing against the fixed
  // baseline candidate — runDuelBrackets is the exact function `duel --difficulties` runs; this
  // just folds its per-bracket tallies into the single scalar the coordinate scan needs to
  // compare "better than the current best" against, the same job score()'s .total already does
  // for the default objective.
  const tournamentEvaluate = row => {
    applyOverrides({ strategies: { [`${name}__lab`]: row } });
    const candidate = { name: `${name}__lab`, strategy: `${name}__lab` };
    const brackets = runDuelBrackets(candidate, baseline, {
      worlds, difficulties,
      seeds: num(args.seeds, 1), seedBase: num(args.seed, 1), minutes: num(args.minutes, 40),
    });
    const n = brackets.reduce((a, b) => a + b.n, 0);
    const aWins = brackets.reduce((a, b) => a + b.aWins, 0);
    const bWins = brackets.reduce((a, b) => a + b.bWins, 0);
    const draws = brackets.reduce((a, b) => a + b.draws, 0);
    return { mean: n ? (aWins - bWins) / n : 0, brackets, aWins, bWins, draws, n };
  };
  const evaluate = baseline ? tournamentEvaluate : scoreEvaluate;

  const log = [];
  let best = { ...base }, bestEval = evaluate(best), bestScore = bestEval.mean;
  log.push({ kind: "start", name, mean: bestScore, dials: pickDials(best, dials) });
  for (const d of dials) {
    for (let i = 0; i <= steps; i++) {
      const v = +(d.lo + (d.hi - d.lo) * (i / steps)).toFixed(3);
      const cand = { ...best, [d.k]: v };
      const evald = evaluate(cand);
      const better = evald.mean > bestScore + 1e-9;
      log.push({ kind: "step", k: d.k, v, mean: evald.mean, better, detail: evald });
      if (better) { best = cand; bestScore = evald.mean; bestEval = evald; }
    }
  }
  log.push({ kind: "best", mean: bestScore, dials: pickDials(best, dials) });
  return {
    name, dials, worlds, difficulties, steps,
    mode: baseline ? "tournament" : "score",
    baseline, best, bestScore, bestEval, log,
  };
}

const CMDS = {
  probe(args) {
    const base = baseConfig(args);
    const cfg = {
      ...base,
      world: args.world || "ferros",
      strategy: args.strategy || "default",
      difficulty: args.difficulty || "medium",
    };
    const r = run({ ...cfg, seed: runSeed(base.seedBase, cfg.world, cfg.strategy, cfg.difficulty, 0) });
    console.log(`${cfg.world} · ${cfg.strategy} · ${cfg.difficulty} · vs ${OPPONENTS[cfg.opponent].desc}`);
    console.log("\ntime  wrk army  dev bldg   banked  waves stance  supplyFree  idleRax");
    for (const c of r.curve)
      console.log(`${padL(Math.round(c.t / 60) + "m", 4)} ${padL(c.workers, 4)} ${padL(c.army, 3)} `
        + `${padL(c.dev, 4)} ${padL(c.buildings, 4)} ${padL(c.banked, 8)} ${padL(c.waves, 6)} `
        + `${padL(c.stance, 6)} ${padL(c.supplyFree, 11)} ${padL(c.idleRax, 8)}`);
    const sc = score(r);
    console.log(`\nscore ${sc.total}  ` + Object.entries(sc.parts).map(([k, v]) => `${k} ${v.toFixed(2)}`).join("  "));
    printFindings([r]);
  },

  sweep(args) {
    const rows = runMatrix(args, {
      worlds: list(args.worlds, ["korrath", "ferros", "vesper", "kybernet"]),
      strategies: list(args.strategies, Object.keys(STRATEGIES)),
      difficulties: list(args.difficulties, ["medium"]),
      seeds: num(args.seeds, 1),
    });
    printTable(rows);
    const mean = rows.reduce((a, r) => a + score(r).total, 0) / rows.length;
    console.log(`\nmean score ${mean.toFixed(3)} over ${rows.length} runs`);
    printFindings(rows);
    if (args.json) {
      // Summary rows only unless --full: a saved sweep is meant to be read (by you or by
      // Claude) and diffed against the next one, and the per-sample curve buries the
      // handful of numbers a decision actually turns on.
      const out = rows.map(({ curve, ...r }) => ({ ...r, score: score(r), ...(args.full === "true" ? { curve } : {}) }));
      writeFileSync(args.json, JSON.stringify(out, null, 1));
      console.log(`\nwrote ${args.json}`);
    }
    if (args.csv) {
      const keys = Object.keys(summarise(rows[0].curve));
      const head = ["world", "strategy", "difficulty", "seed", "score", ...keys];
      const body = rows.map(r => [r.world, r.strategy, r.difficulty, r.seed, score(r).total, ...keys.map(k => r[k])].join(","));
      writeFileSync(args.csv, [head.join(","), ...body].join("\n") + "\n");
      console.log(`wrote ${args.csv}`);
    }
  },

  // A/B two saved sweeps (or a sweep against an overrides file run inline). Prints the
  // per-configuration delta, because a mean that moved could be one world moving a lot.
  compare(args) {
    const load = p => JSON.parse(readFileSync(p, "utf8"));
    const a = load(args.baseline), b = load(args.candidate);
    const key = r => `${r.world}/${r.strategy}/${r.difficulty}/${r.seed}`;
    const bm = new Map(b.map(r => [key(r), r]));
    console.log(pad("configuration", 34) + pad("base", 8) + pad("cand", 8) + "delta");
    let sa = 0, sb = 0, n = 0;
    for (const r of a) {
      const o = bm.get(key(r));
      if (!o) continue;
      const x = r.score.total, y = o.score.total;
      sa += x; sb += y; n++;
      const d = +(y - x).toFixed(3);
      console.log(pad(key(r), 34) + pad(x.toFixed(3), 8) + pad(y.toFixed(3), 8) + (d > 0 ? "+" : "") + d);
    }
    if (!n) { console.log("no matching configurations — the two sweeps must cover the same matrix"); return; }
    console.log(`\nmean ${(sa / n).toFixed(3)} -> ${(sb / n).toFixed(3)}  `
      + `(${sb > sa ? "+" : ""}${((sb - sa) / n).toFixed(3)} per configuration, n=${n})`);
  },

  search(args) {
    const result = runSearch(args);
    if (!result) { console.log("--dials 'attackTimeoutMult=0.3:1,garrisonMult=0:1'"); return; }
    for (const entry of result.log) {
      if (entry.kind === "start") {
        console.log(`start ${entry.name} -> ${entry.mean.toFixed(3)}  ${JSON.stringify(entry.dials)}`);
      } else if (entry.kind === "step") {
        const tourn = result.mode === "tournament"
          ? `  (${entry.detail.aWins}W-${entry.detail.bWins}L-${entry.detail.draws}D vs ${result.baseline.name})`
          : "";
        console.log(`  ${pad(entry.k + "=" + entry.v, 32)} ${entry.mean.toFixed(3)}${entry.better ? "  *" : ""}${tourn}`);
      } else if (entry.kind === "best") {
        console.log(`\nbest ${entry.mean.toFixed(3)}  ${JSON.stringify(entry.dials, null, 1)}`);
      }
    }
    if (result.mode === "tournament") {
      console.log(`\nTOURNAMENT MODE: each dial value was scored by Tier 2/3 side-swapped, `
        + `difficulty-bracketed self-play duel standing (win% differential, aWins-bWins over n) `
        + `against baseline candidate "${result.baseline.name}", NOT solo score() against a `
        + `scripted sparring bot.`);
    }
    console.log("\nThis is a LOCAL search on a noisy objective — re-run the winner through "
      + "`sweep --seeds 3` on the full roster before believing it, then `duel`/`compare` against "
      + "the baseline, `npm test`, and `ailab check` before promoting anything into engine/.");
  },

  check(args) {
    const rows = runMatrix(args, {
      worlds: list(args.worlds, WORLDS),
      strategies: list(args.strategies, Object.keys(STRATEGIES)),
      difficulties: list(args.difficulties, ["medium"]),
      seeds: 1,
    });
    printTable(rows);
    const mean = rows.reduce((a, r) => a + score(r).total, 0) / rows.length;
    console.log(`\nmean score ${mean.toFixed(3)} over ${rows.length} runs`);
    printFindings(rows);
    if (args["exit-code"] === "true" && CHECKS.some(c => rows.some(c.hit))) process.exitCode = 1;
  },

  leaderboard(args) {
    const paths = list(args.candidates, []);
    if (!paths.length) { console.log("--candidates a.json,b.json,... (each: { name, strategy, overrides })"); return; }
    const candidates = paths.map(p => JSON.parse(readFileSync(p, "utf8")));
    const worlds = list(args.worlds, ["korrath", "ferros", "vesper", "kybernet"]);
    const difficulty = args.difficulty || "medium";
    const opponent = args.opponent || "tech";
    const seeds = num(args.seeds, 2);
    const results = runLeaderboard(candidates, {
      worlds, difficulty, opponent, seeds,
      minutes: args.minutes, sample: args.sample, apm: args.apm, seed: args.seed,
    });

    console.log("PROXY LEADERBOARD -- ranks candidates by score against a FIXED, non-adaptive sparring");
    console.log(`bot (${OPPONENTS[opponent].desc}), difficulty "${difficulty}" held identical for every`);
    console.log("candidate so none gets an APM/micro edge. NOT head-to-head play -- see the LEADERBOARD");
    console.log("header comment in this file for exactly what that does and doesn't prove.\n");
    console.log(pad("#", 4) + pad("candidate", 28) + pad("strategy", 13) + pad("score", 8) + "components");
    results.forEach((r, i) => {
      const parts = Object.entries(r.partsMean).map(([k, v]) => `${k} ${v.toFixed(2)}`).join("  ");
      console.log(pad(String(i + 1), 4) + pad(r.name, 28) + pad(r.strategy, 13) + pad(r.mean.toFixed(3), 8) + parts);
    });
    console.log("\nweakest matchup per candidate (lowest single score in its own run set):");
    for (const r of results)
      console.log(`  ${pad(r.name, 28)} ${r.worst.world}/${r.worst.difficulty}/seed=${r.worst.seed}  `
        + `${score(r.worst).total.toFixed(3)}`);
    if (args.json) {
      writeFileSync(args.json, JSON.stringify(results.map(({ worst, ...r }) => r), null, 1));
      console.log(`\nwrote ${args.json}`);
    }
  },

  // Tier 3: real head-to-head via Tier 1 self-play (tools/selfplay.js), side-swapped by DEFAULT
  // and difficulty-bracketed — see the TIER 3 and DUEL header comments above for exactly what's
  // fair here and why. --a/--b run one pair; --candidates a.json,b.json,c.json (3+) runs every
  // pair round-robin instead (a nice-to-have — see runRoundRobinSwapped above) and neither flag
  // combination requires the other to exist. --difficulties (plural, comma list) sweeps several
  // brackets, each reported on its own; --difficulty (singular) still works as a one-bracket
  // shorthand, default "medium", unchanged from Tier 2.
  duel(args) {
    const duelOpts = {
      worlds: list(args.worlds, ["korrath", "ferros", "vesper", "kybernet"]),
      seeds: num(args.seeds, 2),
      seedBase: num(args.seed, 1),
      minutes: args.minutes !== undefined ? Number(args.minutes) : undefined,
    };
    const difficulties = list(args.difficulties, [args.difficulty || "medium"]);
    const paths = list(args.candidates, []);
    if (!args.a && !args.b && paths.length < 2) {
      console.log('--a candA.json --b candB.json   (or --candidates a.json,b.json,c.json for round-robin)');
      console.log('[--worlds a,b] [--difficulties medium,hard] [--seeds 2] [--seed 1] [--minutes 40] [--json out.json]');
      console.log('Every pairing runs side-swapped by default (each candidate plays BOTH owner slots) and');
      console.log('each --difficulties entry is reported as its own bracket, never blended together.');
      return;
    }
    if (args.a || args.b) {
      if (!args.a || !args.b) { console.log("duel needs BOTH --a and --b"); return; }
      const a = JSON.parse(readFileSync(args.a, "utf8"));
      const b = JSON.parse(readFileSync(args.b, "utf8"));
      const brackets = runDuelBrackets(a, b, { ...duelOpts, difficulties });
      for (const res of brackets) {
        printSwappedDuel(res);
        const ratings = eloForMatches([res]);
        console.log(`elo (${res.difficulty}, this run only, from a fresh ${INITIAL_RATING}): `
          + `${res.aName} ${formatElo(ratings[res.aName])}   ${res.bName} ${formatElo(ratings[res.bName])}`);
        console.log();
      }
      if (args.json) { writeFileSync(args.json, JSON.stringify(brackets, null, 1)); console.log(`\nwrote ${args.json}`); }
      return;
    }
    const candidates = paths.map(p => JSON.parse(readFileSync(p, "utf8")));
    const roundRobinBrackets = runRoundRobinSwapped(candidates, { ...duelOpts, difficulties });
    for (const { difficulty, pairs, standings } of roundRobinBrackets) {
      console.log(`\n=== difficulty: ${difficulty} ===`);
      for (const res of pairs) { printSwappedDuel(res); console.log(); }
      const ratings = eloForMatches(pairs);
      console.log(`ROUND-ROBIN STANDINGS (${difficulty})`);
      console.log(pad("#", 4) + pad("candidate", 28) + pad("W", 5) + pad("L", 5) + pad("D", 5) + "elo");
      standings.forEach((s, i) => console.log(pad(String(i + 1), 4) + pad(s.name, 28) + pad(s.wins, 5) + pad(s.losses, 5)
        + pad(s.draws, 5) + formatElo(ratings[s.name])));
    }
    if (args.json) {
      writeFileSync(args.json, JSON.stringify(roundRobinBrackets, null, 1));
      console.log(`\nwrote ${args.json}`);
    }
  },

  // Tier 5: same runSwappedDuel pairing as `duel --candidates`, a Swiss SCHEDULE instead of full
  // round-robin — see the TIER 5 header comment above for why and for exactly what stays fair.
  // Meant for pools too large for round-robin's C(n,2) pairings to stay cheap.
  swiss(args) {
    const paths = list(args.candidates, []);
    if (paths.length < 2) {
      console.log("--candidates a.json,b.json,c.json,...   (2+ candidates; Swiss pays off once there are many)");
      console.log("[--rounds N] [--worlds a,b] [--difficulties medium,hard] [--seeds 2] [--seed 1] [--minutes 40] [--json out.json]");
      console.log("Default rounds: max(3, ceil(log2(candidates))). Each pairing is side-swapped and difficulty-bracketed");
      console.log("exactly like `duel`; each --difficulties entry runs its own independent Swiss tournament, never blended.");
      return;
    }
    const candidates = paths.map(p => JSON.parse(readFileSync(p, "utf8")));
    const swissOpts = {
      worlds: list(args.worlds, ["korrath", "ferros", "vesper", "kybernet"]),
      seeds: num(args.seeds, 2),
      seedBase: num(args.seed, 1),
      minutes: args.minutes !== undefined ? Number(args.minutes) : undefined,
      difficulties: list(args.difficulties, [args.difficulty || "medium"]),
      rounds: args.rounds !== undefined ? Number(args.rounds) : undefined,
    };
    const brackets = runSwissTournament(candidates, swissOpts);
    for (const { difficulty, rounds, roundsLog, standings } of brackets) {
      console.log(`\n=== SWISS -- difficulty: ${difficulty} -- ${rounds} round(s), ${candidates.length} candidates ===`);
      for (const { round, byeName, matches } of roundsLog) {
        console.log(`\n-- round ${round} --`);
        if (byeName) console.log(`  bye: ${byeName} (not paired this round -- no win/loss credit either way)`);
        for (const res of matches) { printSwappedDuel(res); console.log(); }
      }
      const ratings = eloForMatches(roundsLog.flatMap(r => r.matches));
      console.log(`SWISS STANDINGS (${difficulty})`);
      console.log(pad("#", 4) + pad("candidate", 28) + pad("W", 5) + pad("L", 5) + pad("D", 5) + pad("byes", 6) + "elo");
      standings.forEach((s, i) =>
        console.log(pad(String(i + 1), 4) + pad(s.name, 28) + pad(s.wins, 5) + pad(s.losses, 5)
          + pad(s.draws, 5) + pad(s.byes, 6) + formatElo(ratings[s.name])));
    }
    if (args.json) {
      writeFileSync(args.json, JSON.stringify(brackets, null, 1));
      console.log(`\nwrote ${args.json}`);
    }
  },

  // A population of genomes, bred and selected by the same side-swapped, difficulty-bracketed
  // self-play `duel`/`swiss` already run — see the EVOLUTION header comment above for why the
  // fitness is duel Elo rather than score(), why the shipped baselines ride along, and why the
  // whole run shares one pinned map set.
  evolve(args) {
    const layers = list(args.genes, ["strategy"]);
    const hallOfFame = list(args.baselines, [
      "tools/candidates/baseline-adaptive.json", "tools/candidates/baseline-aggressive.json",
      "tools/candidates/baseline-economic.json", "tools/candidates/baseline-force-parity.json",
    ]).map(p => JSON.parse(readFileSync(p, "utf8")));
    const worlds = list(args.worlds, ["korrath", "ferros", "vesper"]);
    const difficulties = list(args.difficulties, [args.difficulty || "medium"]);
    const screen = args.screen && args.screen !== "false"
      ? { worlds: list(args["screen-worlds"], ["ferros", "korrath"]),
          minutes: num(args["screen-minutes"], 40), opponent: args.opponent || "tech" }
      : null;
    const opts = {
      population: num(args.population, 12), generations: num(args.generations, 5),
      seed: num(args.seed, 1), elites: num(args.elites, 2),
      worlds, difficulties, seeds: num(args.seeds, 1),
      minutes: args.minutes !== undefined ? Number(args.minutes) : 40,
      rounds: args.rounds !== undefined ? Number(args.rounds) : undefined,
      agg: args.agg === "mean" ? "mean" : "min",
      layers, odyssey: args.odyssey === "true", hallOfFame, screen,
    };
    console.log(`EVOLVE — population ${opts.population} x ${opts.generations} generations`);
    console.log(`  genes:        ${geneKeys({ layers, odyssey: opts.odyssey }).map(g => g.key).join(", ")}`);
    console.log(`  worlds:       ${worlds.join(", ")}   seeds ${opts.seeds}   minutes ${opts.minutes}`);
    console.log(`  brackets:     ${difficulties.join(", ")}   aggregated by ${opts.agg}`);
    console.log(`  hall of fame: ${hallOfFame.map(h => h.name).join(", ") || "(none)"}`);
    console.log(`  screen:       ${screen ? `${screen.worlds.join("/")} @ ${screen.minutes}m vs ${screen.opponent}` : "off"}`);
    if (!opts.odyssey)
      console.log(`  note:         Odyssey-only genes are EXCLUDED — a duel is a skirmish, so diplomacy\n`
        + `                and industry genes are read by nothing there. --odyssey true to include them\n`
        + `                anyway (they will drift freely; the objective cannot see them).`);
    console.log();

    const baseline = genomeFrom({ strategy: "default", genes: geneKeys({ layers, odyssey: opts.odyssey }) });
    // CHECKPOINT AFTER EVERY GENERATION, not just at the end. A real run is long — and it gets
    // LONGER as it succeeds, because a population converging on `neverInitiates` stops resolving
    // matches by elimination and starts running every one of them to the full clock. Writing only
    // on completion means an interrupted run yields nothing at all, which is the difference between
    // "the search is still going" and "the search has to start over". Purely an output side effect:
    // it consumes no rng and changes no decision, so a checkpointed run and an unwatched one breed
    // the identical champion.
    const out = args.out || "evolved.json";
    const partial = [];
    const writeCheckpoint = (genome, gen, edge) => {
      writeFileSync(out, JSON.stringify({ ...toCandidate(genome, "evolved", { genes: genesFor(opts) }), _hypothesis:
        `Evolved: population ${opts.population} x ${opts.generations} generations, fitness = duel Elo `
        + `(${difficulties.join("/")}, agg ${opts.agg}) on ${worlds.join("/")}, seed ${opts.seed}.`
        + ` Champion of generation ${gen}, edge ${edge >= 0 ? "+" : ""}${edge.toFixed(0)} vs the hall of fame.` }, null, 2));
      if (args.json) writeFileSync(args.json, JSON.stringify(partial, null, 1));
    };
    let bestSoFar = null;
    const res = runEvolution({
      ...opts,
      onGeneration: (entry, ranked) => {
        partial.push(entry);
        if (!bestSoFar || ranked[0].edge > bestSoFar.edge) bestSoFar = { genome: ranked[0].genome, gen: entry.gen, edge: ranked[0].edge };
        writeCheckpoint(bestSoFar.genome, bestSoFar.gen, bestSoFar.edge);
        console.log(`-- generation ${entry.gen} --`);
        console.log(pad("#", 4) + pad("genome", 9) + padL("elo", 6) + padL("edge", 7) + padL("sigma", 7)
          + "  genes vs. Adaptive");
        ranked.slice(0, 5).forEach((r, i) => console.log(
          pad(String(i + 1), 4) + pad(r.name, 9)
          + padL(r.fitness === -Infinity ? "DQ" : r.fitness.toFixed(0), 6)
          + padL(r.edge === -Infinity ? "-" : (r.edge >= 0 ? "+" : "") + r.edge.toFixed(0), 7)
          + padL(r.genome.sigma.toFixed(3), 7) + "  "
          + (r.tripped.length ? `[${r.tripped.join(",")}] ` : "")
          + diffGenes(r.genome, baseline, { genes: genesFor(opts) }).slice(0, 92)));
        console.log(`    anchors (mean ${entry.anchorMean.toFixed(0)}): `
          + entry.anchors.map(a => `${a.name} ${a.elo.toFixed(0)}`).join("   "));
        console.log();
      },
    });

    console.log(`BEST: ${res.bestName} from generation ${res.bestGen}, elo ${res.bestFitness.toFixed(0)} `
      + `(${res.bestEdge >= 0 ? "+" : ""}${res.bestEdge.toFixed(0)} vs the hall of fame's own mean`
      + `${hallOfFame.length ? "" : " — NO baselines given, so this is only vs the 1200 origin"})`);
    console.log(`  ${diffGenes(res.bestGenome, baseline, { genes: res.genes })}`);
    // The final write goes through the same checkpoint path, so an interrupted run and a completed
    // one leave a file of exactly the same shape — no "the real output only exists if it finished".
    writeCheckpoint(res.bestGenome, res.bestGen, res.bestEdge);
    console.log(`\nwrote ${out} — a runnable candidate: duel it against a baseline, then sweep it.`);
    if (args.json) console.log(`wrote ${args.json}`);
  },

  // MAP-Elites: a CAST of distinct opponents rather than one optimum — see the ARCHIVE header
  // comment for why that is the right target for a mode with no win condition, and for the three
  // ways it differs from `evolve`.
  archive(args) {
    const layers = list(args.genes, ["strategy"]);
    const panel = list(args.panel, [
      "tools/candidates/baseline-adaptive.json", "tools/candidates/baseline-aggressive.json",
      "tools/candidates/baseline-economic.json", "tools/candidates/baseline-force-parity.json",
    ]).map(p => JSON.parse(readFileSync(p, "utf8")));
    const opts = {
      iterations: num(args.iterations, 60), seed: num(args.seed, 1),
      layers, odyssey: args.odyssey === "true",
      descriptorWorlds: list(args["descriptor-worlds"], ["korrath", "ferros", "vesper"]),
      descriptorMinutes: num(args["descriptor-minutes"], 40),
      descriptorSeeds: num(args["descriptor-seeds"], 2),
      descriptorOpponent: args.opponent || "turtle",
      difficulty: args.difficulty || "medium",
      duelWorlds: list(args["duel-worlds"], ["korrath", "ferros"]),
      duelSeeds: num(args["duel-seeds"], 1),
      duelMinutes: num(args["duel-minutes"], 40),
      panel, screen: args.screen !== "false",
    };
    const outDir = args["out-dir"] || "tools/candidates/cast";
    console.log(`ARCHIVE (MAP-Elites) — ${opts.iterations} evaluations`);
    console.log(`  axes:        ${ARCHIVE_DIMS.map(d => `${d.label} [${d.names.join("|")}]`).join("   x   ")}`);
    console.log(`  describe on: ${opts.descriptorWorlds.join(", ")} x ${opts.descriptorSeeds} seed(s) @ ${opts.descriptorMinutes}m vs ${opts.descriptorOpponent}`);
    console.log(`  strength vs: ${panel.map(p => p.name).join(", ")} on ${opts.duelWorlds.join(", ")} @ ${opts.duelMinutes}m`);
    console.log(`  screen:      ${opts.screen ? "on — relative to what the SHIPPED strategies trip here" : "OFF"}`);
    console.log();

    const res = runArchive({
      ...opts,
      onCell: (entry, archive) => console.log(
        pad(entry.name, 9) + pad(entry.cell, 15)
        + padL(entry.fitness != null ? (entry.fitness * 100).toFixed(0) + "%" : "-", 6)
        // Keyed on `reason`, NOT on `tripped.length`: with --screen false a genome can trip a check
        // and still be seated or simply lose its cell contest, and printing that as "refused" would
        // report a screen that isn't running.
        + "  " + (entry.seated ? (entry.beat != null ? `seated (beat ${(entry.beat * 100).toFixed(0)}%)` : "SEATED — new cell")
                // Name the NOVEL defect, not everything it tripped: the tolerated ones are what the
                // shipped strategies do here too, so listing them would blame a genome for the
                // configuration.
                : entry.reason === "screen" ? `refused [${entry.novel.join(",")}]`
                : `no (holder ${(entry.beat * 100).toFixed(0)}%)`)
        + `   ${archive.size} cells`),
    });

    // The cast, as a grid. Rows are the second axis, columns the first, so it reads the way the
    // header describes it: how aggressive across, how big down.
    const [xDim, yDim] = ARCHIVE_DIMS;
    const at = (x, y) => res.cells.find(c => c.key === `${xDim.names[x]}/${yDim.names[y]}`);
    console.log(`\nTHE CAST — ${res.cells.length}/${xDim.names.length * yDim.names.length} cells filled `
      + `(${(res.coverage * 100).toFixed(0)}% coverage), ${res.evaluated} evaluated, ${res.rejected} refused by the health screen`);
    // Never hide the calibration. If the shipped strategies trip everything here, the screen is a
    // no-op and the reader has to be able to see that rather than infer it from a suspiciously
    // clean run.
    console.log(`  screen tolerated (what the SHIPPED strategies trip under these settings): `
      + `${res.tolerated.length ? res.tolerated.join(", ") : "nothing — the full detector list was enforced"}\n`);
    console.log(pad("", 9) + xDim.names.map(n => pad(n, 16)).join("") + `   <- ${xDim.label}`);
    for (let y = 0; y < yDim.names.length; y++) {
      console.log(pad(yDim.names[y], 9) + xDim.names.map((_, x) => {
        const c = at(x, y);
        return pad(c ? `${(c.fitness * 100).toFixed(0)}% ${c.name}` : "—", 16);
      }).join(""));
    }
    console.log(`   ^ ${yDim.label}`);

    const baseline = genomeFrom({ strategy: "default", genes: res.genes });
    console.log(`\nWHAT EACH ONE IS (genes vs. Adaptive):`);
    for (const c of res.cells)
      console.log(`  ${pad(c.key, 15)} ${padL((c.fitness * 100).toFixed(0) + "%", 5)}  `
        + `waves ${c.desc.waves.toFixed(1)} army ${c.desc.armyFinal.toFixed(0)}  `
        + diffGenes(c.genome, baseline, { genes: res.genes }).slice(0, 88));

    mkdirSync(outDir, { recursive: true });
    for (const c of res.cells) {
      const slug = c.key.replace(/\//g, "-");
      writeFileSync(`${outDir}/${slug}.json`, JSON.stringify({
        ...toCandidate(c.genome, `cast-${slug}`, { genes: res.genes }),
        _hypothesis: `MAP-Elites cell "${c.key}" (${xDim.label} ${c.desc.waves.toFixed(1)} waves, `
          + `${yDim.label} ${c.desc.armyFinal.toFixed(0)}): ${(c.fitness * 100).toFixed(0)}% vs the fixed panel `
          + `(${panel.map(p => p.name).join(", ")}), seed ${opts.seed}. Health-screened clean.`,
      }, null, 2));
    }
    console.log(`\nwrote ${res.cells.length} candidates to ${outDir}/ — each one a distinct, runnable opponent.`);
    // An archive that came back (nearly) empty has one overwhelmingly likely cause, and it is not
    // "no good AI exists". Say so, rather than leaving a blank grid to be read as a result.
    if (res.rejected > res.evaluated * 0.8)
      console.log(`\n!! ${res.rejected} of ${res.evaluated} genomes were REFUSED by the health screen,`
        + `\n   for defects the shipped strategies do NOT show here. That is a lot, and worth reading`
        + `\n   before trusting: --descriptor-minutes is ${opts.descriptorMinutes} against '${opts.descriptorOpponent}'.`
        + `\n   Pass --screen false to seat genomes unscreened (and lose the defect filter).`);
    if (args.json) { writeFileSync(args.json, JSON.stringify(res.log, null, 1)); console.log(`wrote ${args.json}`); }
  },
};

// The gene set a given `evolve` invocation is varying — recomputed for the progress printer rather
// than threaded through, since runEvolution's own result only becomes available after it returns.
const genesFor = opts => geneKeys({ layers: opts.layers, odyssey: opts.odyssey });

const USAGE = `AI LAB — a headless bench for the Odyssey opponent.

  node tools/ailab.js probe   [--world ferros] [--strategy default] [--difficulty medium]
                              [--opponent passive] [--minutes 40] [--sample 5]
  node tools/ailab.js sweep   [--worlds a,b] [--strategies a,b] [--difficulties a,b]
                              [--seeds 3] [--minutes 40] [--json out.json] [--csv out.csv] [--full]
  node tools/ailab.js compare --baseline base.json --candidate cand.json
  node tools/ailab.js search  --strategy aggressive --dials 'attackTimeoutMult=0.3:1,garrisonMult=0:1'
                              [--steps 4] [--worlds a,b] [--difficulties a,b]
                              [--tournament-against baseline.json]
                              -- default objective: solo score() against --opponent, unchanged.
                              --tournament-against swaps ONLY the objective onto a Tier 2/3
                              side-swapped, difficulty-bracketed self-play duel (runDuelBrackets)
                              against the named baseline candidate { name, strategy, overrides },
                              scored by win differential (aWins - bWins) / n. The coordinate-scan
                              loop itself is unchanged either way.
  node tools/ailab.js check   [--worlds a,b] [--minutes 60] [--exit-code]
  node tools/ailab.js leaderboard --candidates a.json,b.json,c.json
                              [--worlds a,b] [--difficulty medium] [--opponent tech] [--seeds 2]
                              [--json out.json]
                              -- ranks candidates against the SAME fixed opponent, all other dials
                              held equal (a proxy for competitive self-play, not a substitute for
                              it — see the LEADERBOARD header comment). Each candidate file is
                              { "name": "...", "strategy": "aggressive", "overrides": {...} }.
  node tools/ailab.js duel   --a candA.json --b candB.json
                              [--worlds a,b] [--difficulties medium,hard] [--seeds 2] [--seed 1]
                              [--minutes 40] [--json out.json]
                              -- TRUE head-to-head: candA and candB fight via Tier 1 self-play
                              (tools/selfplay.js), both sides the real AI, difficulty pinned
                              identical for both — see the DUEL header comment for the fairness
                              guarantee. Resolves via engine/victory.js exactly like any skirmish
                              (elimination or the score-at-clock tiebreak). --candidates
                              a.json,b.json,c.json instead runs every pair round-robin.
                              Tier 3, on by default: every pairing is SIDE-SWAPPED (each candidate
                              plays both the "ai" and "player" owner slot, both halves reported),
                              and --difficulties (plural) sweeps several brackets, each reported
                              standalone -- never averaged across difficulty -- see the TIER 3
                              header comment. Also prints an elo column/line (elo.js, D1) --
                              a fresh 1200-baseline rating folded through just THIS run's own
                              matches, in the order they actually completed; under 10 games shows
                              a trailing "?" (D7). No persistence across runs yet (Phase 2).
  node tools/ailab.js swiss  --candidates a.json,b.json,c.json,...
                              [--rounds N] [--worlds a,b] [--difficulties medium,hard]
                              [--seeds 2] [--seed 1] [--minutes 40] [--json out.json]
                              -- Tier 5: the SAME side-swapped, difficulty-bracketed runSwappedDuel
                              pairing 'duel --candidates' uses, scheduled as SWISS rounds instead
                              of full round-robin, for candidate pools too large for C(n,2)
                              pairings to stay cheap. Default rounds: max(3, ceil(log2(n))). Each
                              round pairs candidates by closest current standing, backtracking to
                              find a zero-repeat pairing whenever one exists rather than a repeat
                              a greedy walk could've avoided -- see the TIER 5 header comment for
                              the pairing/bye rules. SWISS STANDINGS carries the same elo column as
                              'duel', folded through the whole bracket in round/pairing order.
  node tools/ailab.js evolve [--population 12] [--generations 5] [--elites 2] [--seed 1]
                              [--genes strategy|strategy,archetype] [--odyssey true]
                              [--worlds a,b] [--difficulties medium,hard] [--agg min|mean]
                              [--seeds 1] [--minutes 40] [--rounds N] [--baselines a.json,b.json]
                              [--screen] [--screen-worlds a,b] [--screen-minutes 40]
                              [--out evolved.json] [--json log.json]
                              -- a POPULATION of genomes (tools/genome.js), mutated and crossed,
                              selected by the same side-swapped, difficulty-bracketed self-play
                              'swiss' already runs. Fitness is duel ELO, never score(): a weighted
                              metric is a hand-written definition of "better" and a population is a
                              machine for exploiting one. The four shipped baselines ride along as
                              a HALL OF FAME so the rating is anchored to something fixed rather
                              than drifting in a Red Queen cycle, and every difficulty bracket is
                              rated separately then aggregated by the WORST of them (--agg min) --
                              see the EVOLUTION header comment for both arguments. Writes the
                              champion as a runnable candidate file, so it goes straight back into
                              duel/sweep/leaderboard. Odyssey-gated genes (diplomacy, industry) are
                              EXCLUDED by default: a duel is a skirmish, so nothing there reads
                              them and evolving them would be scoring pure drift.
  node tools/ailab.js archive [--iterations 60] [--seed 1] [--genes strategy] [--difficulty medium]
                              [--descriptor-worlds a,b] [--descriptor-minutes 40] [--opponent turtle]
                              [--duel-worlds a,b] [--duel-seeds 1] [--duel-minutes 40]
                              [--panel a.json,b.json] [--screen false]
                              [--out-dir tools/candidates/cast] [--json log.json]
                              -- MAP-ELITES: breeds a CAST of distinct opponents instead of one
                              optimum, which is the right target for a mode with no win condition.
                              Every genome is binned by how it BEHAVES (aggression x army size,
                              measured on the solo Odyssey bench) and competes ONLY against the
                              current occupant of its own cell -- so a genome that wins by refusing
                              to fight can win the "never attacks" cell and nothing else, which is a
                              structural answer to the Goodhart failure 'evolve' hit rather than a
                              hand-written penalty for it. Strength is measured against a FIXED
                              panel, so it is absolute and comparable across the whole run. The
                              health screen is ON by default, free (describing a genome IS running
                              it solo), and calibrated RELATIVE to the shipped strategies: a genome
                              is refused only for a defect they do not also show under the same
                              opponent and match length, because CHECKS is calibrated against the
                              'passive' bot and this runs against a provoking one.
                              Writes one runnable candidate per filled cell.

Common flags
  --overrides f.json   inject candidate rows into the AI tables before running:
                       { "strategies":   { "swarm":  { "armyAttackSizeMult": 0.5 } },
                         "archetypes":   { "rusher": { "odyssey": { "workerTarget": 9 } } },
                         "difficulties": { "hard":   { "workerTargetMult": 1.4 } } }
  --seed N             base seed (default 1) — every row is reproducible from it
  --apm real|none      default 'real': the AI runs at its own difficulty row's aiApm cap;
                       'none' runs unthrottled (the old default), for baseline comparability`;

function main(argv) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  if (!cmd || !CMDS[cmd]) {
    console.log(USAGE);
    console.log(`\nworlds: ${WORLDS.join(", ")}`);
    console.log(`strategies: ${Object.keys(STRATEGIES).join(", ")}`);
    console.log(`opponents: ${Object.entries(OPPONENTS).map(([k, v]) => `${k} (${v.desc})`).join("\n            ")}`);
    return;
  }
  if (args.overrides) applyOverrides(JSON.parse(readFileSync(args.overrides, "utf8")));
  const t0 = process.hrtime.bigint();   // deterministic-exempt: wall clock is for the operator's benefit only, never read by the sim
  CMDS[cmd](args);
  console.log(`\n(${Number(process.hrtime.bigint() - t0) / 1e9 | 0}s)`);
}

// Only run the CLI when invoked directly, so a test can import run/score/CHECKS.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));

// pinnedDuelDials used to be declared `export function` right here in this file; now it's
// implemented in tools/duelCore.js and imported above, so it's re-exported here instead — same
// public name, same behaviour, test/ailab.test.js's own `import { pinnedDuelDials } from
// "../tools/ailab.js"` keeps resolving unmodified.
export { run, labWorld, sample, summarise, OPPONENTS, WORLDS, snapshotTables, restoreTables, pinnedDuelDials };
