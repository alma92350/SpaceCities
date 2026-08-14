/* ============================================================
   The Odyssey galaxy — the open-world meta-layer over the per-planet sim. A
   galaxy holds one engine game state per planet (each a normal createGameState);
   one is "active" (rendered + controlled by the player) and ticks at full rate,
   while the worlds you've left keep evolving in the background on a coarser
   schedule (stepGalaxy). The player has a single, relocatable Command Center:
   their capital seat travels with them via a Spaceport (jumpCapital), and a world
   they leave stays a colony that keeps producing and sends home passive income.

   This module owns everything meta: the world roster, universal credits, the
   active planet, the per-frame advance (stepGalaxy), background-colony upkeep +
   notifications (sweepColonies), a status snapshot for the starmap (galaxyStatus),
   and the jump. The per-planet engine is untouched — a planet is just a normal
   createGameState flagged `endless` (no victory, no clock — see engine/victory.js).

   Determinism: the start world and every planet's map are derived from the galaxy
   seed, and the background schedule is keyed to the integer `galaxy.tick`, so the
   same seed replays the same galaxy — the same guarantee as the skirmish sim.
   ============================================================ */

"use strict";

import { createGameState, makeUnit, peekEntityId, restoreEntityId } from "./state.js";
import { mulberry32 } from "./rng.js";
import { updateFog } from "./fog.js";
import { tick } from "./sim.js";
import { createMarket } from "./market.js";
import { createDiplomacy, aiDevelopment, PEACE_THRESHOLD, ALLIED_THRESHOLD,
         FACTION_ECHO_PENALTY, FACTION_ECHO_DURATION } from "./diplomacy.js";
import { UNITS, BUILDINGS, freightUsed, freightRoom } from "./entities.js";
import { hasColonyShip } from "./colony.js";
import { PLANET_ARCHETYPE, ODYSSEY_EXTRA_ARCHETYPE, archetypeFor } from "./aiArchetypes.js";
import { DIFFICULTY_OPTIONS } from "./aiDifficulty.js";
import { STRATEGIES } from "./aiStrategy.js";
import { runColonyPolicies } from "./colonyPolicy.js";
import { PLANETS, COM } from "../data.js";

// The worlds an Odyssey can settle: the skirmish nine PLUS the Odyssey-only extras
// (a research capital, an agri world) — appended AFTER the nine so the skirmish
// worlds keep their roster index, which keeps the background-tick schedule (keyed
// on worlds.indexOf) and every same-seed replay stable.
export const ODYSSEY_WORLDS = [...Object.keys(PLANET_ARCHETYPE), ...Object.keys(ODYSSEY_EXTRA_ARCHETYPE)];

// A stable per-planet seed derived from the galaxy seed + the world id, so every
// world generates its own deterministic map and two galaxies with the same seed
// are byte-identical.
function planetSeed(seed, planetId) {
  let h = seed >>> 0;
  for (let i = 0; i < planetId.length; i++) h = (Math.imul(h ^ planetId.charCodeAt(i), 0x01000193)) >>> 0;
  return h >>> 0;
}

// LIVING GALAXY, BOUNDED. The galaxy is alive before you ever visit it — but not ALL of it at
// once: only this many of the OTHER worlds actually exist and simulate from turn one. The whole
// roster stays on the starmap and stays jumpable; an undrawn world is simply DORMANT until the
// player arrives, at which point jumpCapital instantiates it exactly as it always did for a
// never-visited destination. Bounding the live set keeps the per-frame background scheduler's
// work (and a save's size) proportional to a handful of worlds instead of the whole roster,
// while the galaxy still develops, spreads factions and races its Gate behind your back.
export const BACKGROUND_WORLDS = 3;

// WHICH worlds those are: a seeded, pseudo-random draw from the roster minus the start seat, so
// two runs from the same seed bring up the same neighbours (the determinism guarantee in this
// file's header) while two different seeds explore different pockets of the galaxy — the live set
// is part of what a seed means, not a fixed prefix of ODYSSEY_WORLDS.
//
// Drawn from its OWN distinctly-keyed stream (planetSeed with a ":backgroundWorlds" suffix, the
// same idiom neighbourAiProfile uses below) rather than createGalaxy's `pick`, so adding or
// changing this draw can never shift the start-world roll or any other seeded stream.
//
// Returned in fixed ROSTER order, not draw order: the background scheduler (stepGalaxy) keys on
// each world's roster index and every galaxy-wide scan walks `galaxy.worlds`, so keeping the
// creation order roster-ordered leaves those paths reading exactly as they did when every world
// was instantiated.
export function backgroundWorldIds(seed, startId, count = BACKGROUND_WORLDS) {
  const pool = ODYSSEY_WORLDS.filter(id => id !== startId);
  const n = Math.max(0, Math.min(count | 0, pool.length));
  const pick = mulberry32(planetSeed(seed >>> 0, ":backgroundWorlds"));
  // Partial Fisher-Yates: draw n distinct worlds without the retry loop a naive
  // "roll until it's new" pick would need (and without its unbounded worst case).
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(pick() * (pool.length - i));
    const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
  }
  const drawn = new Set(pool.slice(0, n));
  return ODYSSEY_WORLDS.filter(id => drawn.has(id));
}

// VARIED NEIGHBOURS: every world but the player's start seat carries its OWN difficulty and AI
// Strategy (personality) — a distribution across the galaxy, some easier, some harder — instead
// of mirroring the player's own splash-screen pick everywhere. Pure function of the galaxy seed +
// planetId (a distinctly-keyed planetSeed, so this draws an independent stream from map
// generation's own rng), so the same galaxy seed always assigns the same profile to the same
// world: exploring is how you learn a neighbour's temperament, not a settings screen.
// aiApm/aiMicro are read off the SAME resolved difficulty entry, never left mismatched with a
// different world's dials (addPlanet threads all four through together).
export function neighbourAiProfile(seed, planetId) {
  const pick = mulberry32(planetSeed(seed, planetId + ":neighbourProfile"));
  const diffOpt = DIFFICULTY_OPTIONS[Math.floor(pick() * DIFFICULTY_OPTIONS.length)];
  const strategyKeys = Object.keys(STRATEGIES);
  const aiStrategy = strategyKeys[Math.floor(pick() * strategyKeys.length)];
  return { difficulty: diffOpt.mult, aiApm: diffOpt.aiApm, aiMicro: diffOpt.aiMicro, aiStrategy };
}

// Create an Odyssey galaxy. Phase 1: a single active planet (the player's
// randomly-chosen — or explicitly PICKED — starting world) plus the meta-fields
// (credits, activeId, the world roster) the later phases grow into.
export function createGalaxy({ seed = 1, difficulty = "medium", sizeMult = 1,
  resourceMult = 1, playerFaction = "frontier", aiApm, aiMicro, aiStrategy, startId: startIdOpt, popCap = null } = {}) {
  seed = seed >>> 0;
  const pick = mulberry32(seed);
  // Always draw, even when the caller supplies an explicit startId: consuming this draw keeps
  // every OTHER seed-derived RNG stream byte-identical whether the player picked a world or left
  // it to chance (CONTRIBUTING.md's determinism guarantee) — skipping the draw on the "explicit
  // pick" path would silently shift whatever a later change might draw from this same `pick`.
  const drawnId = ODYSSEY_WORLDS[Math.floor(pick() * ODYSSEY_WORLDS.length)];
  const startId = (startIdOpt != null && ODYSSEY_WORLDS.includes(startIdOpt)) ? startIdOpt : drawnId;

  const galaxy = {
    seed,
    credits: 500,               // universal credits — galaxy-wide, transportable; fund jumps + trade
    activeId: startId,          // the world the player is currently on
    worlds: ODYSSEY_WORLDS.slice(),
    planets: new Map(),         // planetId -> engine game state
    // `startId` records which world was actually landed on (the player's pick, or the seed's own
    // draw) — informational, not read back to reconstruct anything (activeId already IS that
    // world, and persists on its own); rides along for free since `settings` is saved whole.
    settings: { difficulty, sizeMult, resourceMult, playerFaction, aiApm, aiMicro, aiStrategy, startId, popCap },
    tick: 0,                    // integer galaxy-tick counter (drives the background-world schedule)
    time: 0,                    // galaxy-wide sim clock (seconds) — monotonic across jumps; keys the relief cooldown
    entitySeq: 0,               // fresh-id counter for entities relocated across worlds by a jump
    colonyNotes: new Map(),     // per-planet UI notification bookkeeping (galaxy-side, not sim state)
    pacified: new Set(),        // worlds where you've razed the neighbour's Command Center (a conquest milestone)
    pacifyNotes: [],            // freshly-pacified world ids awaiting a UI toast + firework (transient, drained by boot.js)
    reached: new Set(),         // progress milestones already celebrated (see checkGalaxyProgress) — persisted so a reload doesn't re-fire them
    milestones: [],             // freshly-reached milestones awaiting a UI firework (transient, drained by boot.js)
    wonBy: null,                // legacy: no Odyssey win any more (play-forever) — kept null for save/skirmish compat
    discovered: new Set([startId]),   // LIVING GALAXY: worlds the player has actually reached (starmap "explored" + free return-jump). Every world SIMULATES from the start, but the player only SEES a world once they've been there.
    claims: new Map(),          // faction spread: worldId → controlling faction (checkExpansion), shown on the starmap
    expansionNotes: [],         // freshly-claimed/expanded worlds awaiting a UI toast (transient, drained by boot.js)
    lanes: [],                  // Freight Lanes (runLanes below): standing shipping routes between held worlds
    laneSeq: 0,                 // fresh lane-id counter (createLane)
  };
  addPlanet(galaxy, startId);
  // LIVING GALAXY: a seeded handful of the other worlds (backgroundWorldIds, above) already exist and
  // simulate in the background from turn one — each with its own AI faction founding a base and
  // developing (engine/ai.js aiIndustry), its economy growing and its diplomacy drifting — so the
  // galaxy is alive before you ever visit, and (checkExpansion) factions spread across it over time.
  // Added `unsettled` (no player presence until you jump in). The rest of the roster stays DORMANT
  // and is built in on arrival (jumpCapital), so every world remains a destination. The BG scheduler
  // (stepGalaxy) spreads the live ones' ticks round-robin. Deterministic: the draw and each world's
  // map both come from the galaxy seed, so two same-seed galaxies are byte-identical.
  for (const id of backgroundWorldIds(seed, startId)) addPlanet(galaxy, id, { unsettled: true });
  return galaxy;
}

// Units staged within this radius of a Spaceport ride along with the capital on
// a jump — you assemble your expedition at the pad, then launch.
export const JUMP_LOAD_RADIUS = 150;

// Credits a jump costs (fuel). Funded by trading at the market, so exploration
// draws on your economy rather than being free.
export const JUMP_COST = 400;

// A held background colony sends home this many credits per second per surviving
// income-earning player building — passive income, so the worlds you leave keep working
// for you (and a razed colony, down to no buildings, quietly stops paying).
export const COLONY_INCOME_PER_BUILDING = 0.3;
// …but only up to this many buildings per world. Without a cap, spamming the cheapest
// building (a 75-ore Habitat, a turret) on a pacified world — where the razed neighbour
// can never strike back — was an unbounded credit annuity that made the counter a
// meaningless up-only number. The cap bounds a colony's yield to a real economy's worth.
export const COLONY_INCOME_CAP = 6;

// DOMINATION WITH TEETH, optional occupation dividend (docs/improvement-proposals.md 663): a
// pacified world pays a small flat credits/sec just for being held down — no player building
// required, since the point is that razing the neighbour's capital and keeping it razed is worth
// something on its own, distinct from (and additive with) whatever a colony you've also founded
// there separately earns above. Same universal-credits currency as COLONY_INCOME_PER_BUILDING and
// a small fraction of what a single well-built colony can pay at its cap (COLONY_INCOME_PER_BUILDING
// * COLONY_INCOME_CAP = 1.8/s), so conquest is a genuine but modest reward, not a better economy
// than actually building one.
export const PACIFIED_INCOME = 0.1;   // credits/sec per pacified world (~6/min)

const playerBuildingCount = state => {
  let n = 0;
  for (const b of state.buildings.values()) if (b.owner === "player") n++;
  return n;
};

// Buildings that count toward passive income: everything except the pure-defensive
// turret (a turret wall isn't an economy), capped per world (see COLONY_INCOME_CAP).
const incomeBuildingCount = state => {
  let n = 0;
  for (const b of state.buildings.values()) if (b.owner === "player" && b.type !== "turret") n++;
  return Math.min(COLONY_INCOME_CAP, n);
};

// Build (or rebuild) a planet's engine state into the galaxy. Reuses the exact
// skirmish scaffold — economy, both players' bases, fog — but flagged `endless`
// so it never resolves by conquest or clock (see engine/victory.js).
//
// `unsettled` strips the auto-seeded player presence: a jump DESTINATION you
// haven't settled yet has only its neighbour — your capital + forces arrive via
// the jump, not from map generation.
//
// AI dials: the player's OWN splash-screen difficulty/strategy pick (galaxy.settings) applies
// only to the start seat (planetId === galaxy.activeId, true for every world at the point
// createGalaxy calls this). Every other world resolves its own varied profile instead
// (neighbourAiProfile, above) — a distribution across the galaxy, not one setting everywhere.
export function addPlanet(galaxy, planetId, { unsettled = false } = {}) {
  const state = buildPlanetState(galaxy, planetId, unsettled);
  galaxy.planets.set(planetId, state);
  bumpEntityCounterPastGalaxy(galaxy);         // keep future live-built ids galaxy-unique (see below)
  return state;
}

// A DORMANT world's state, built to LOOK at without waking it. The landing picker
// (landingPicker.js) has to draw the destination's map before the player commits to the jump, and
// only a seeded handful of worlds are alive from turn one (BACKGROUND_WORLDS) — so merely opening
// that modal, or backing out of it, must not add a world to the live set. Built from the same
// (galaxy seed, planetId) inputs addPlanet uses and never ticked, so the state the jump really
// creates on arrival is identical to the one previewed. A world that's already up IS its own
// preview and is returned as-is.
export function previewPlanet(galaxy, planetId) {
  const live = galaxy.planets.get(planetId);
  if (live) return live;
  const state = buildPlanetState(galaxy, planetId, true);
  // Even a throwaway world moves the GLOBAL entity-id counter (createGameState re-seeds it from 1
  // per world — see bumpEntityCounterPastGalaxy below), so the same bump the registering path does
  // is mandatory here too: without it the next thing built anywhere could reuse a live id.
  bumpEntityCounterPastGalaxy(galaxy);
  return state;
}

// The shared core of both: a planet's engine state, built but not registered.
function buildPlanetState(galaxy, planetId, unsettled) {
  const s = galaxy.settings;
  const seed = planetSeed(galaxy.seed, planetId);
  // A DORMANT world (one the background draw didn't bring up) can be CLAIMED by a spreading faction
  // before it ever exists — checkExpansion's sweep walks the whole roster, and the starmap flies the
  // claim on it. So a world built in later takes the claimed colours over its own archetype's, exactly
  // as checkExpansion flips an already-instantiated world's AI faction on the spot: the flag the
  // player has been looking at is the one they meet on landing.
  const claimed = galaxy.claims && galaxy.claims.get(planetId);
  const aiFaction = claimed || archetypeFor(planetId).faction || "neutral";
  const profile = planetId === galaxy.activeId
    ? { difficulty: s.difficulty, aiApm: s.aiApm, aiMicro: s.aiMicro, aiStrategy: s.aiStrategy }
    : neighbourAiProfile(galaxy.seed, planetId);
  const state = createGameState({
    planetId, seed, rng: mulberry32(seed),
    aiApm: profile.aiApm, aiMicro: profile.aiMicro, aiStrategy: profile.aiStrategy, difficulty: profile.difficulty,
    sizeMult: s.sizeMult, resourceMult: s.resourceMult, popCap: s.popCap,
    playerFaction: s.playerFaction, aiFaction, endless: true,
  });
  if (unsettled) {
    for (const [id, u] of [...state.units]) if (u.owner === "player") state.units.delete(id);
    for (const [id, b] of [...state.buildings]) if (b.owner === "player") state.buildings.delete(id);
    state.background = true;   // not the active seat until you land here
    updateFog(state, state.fog, "player");
  }
  state.market = createMarket(state);         // every world has its own price book
  state.diplomacy = createDiplomacy();        // and its own neighbour's stance toward you
  state.inGalaxy = true;                       // part of a galaxy → the per-world defeat check is off (engine/victory.js);
                                               // the galaxy never loses (checkGalaxyRescue), it only ends by surrender
  return state;
}

// createGameState (engine/state.js) resets the GLOBAL entity-id counter to 1 for each world's
// deterministic seeding — which, once a galaxy holds more than one world, would leave the counter
// BELOW ids already live on other worlds. The next thing the player then built or produced could
// reuse an id and silently overwrite an existing entity (e.g. return to a built-up world after
// visiting a new one and lay down a Spaceport → it clobbers a building that shared the id). So
// after each world is (re)built in, bump the counter past every b/u id anywhere in the galaxy, so
// live mints stay unique galaxy-wide. Deterministic — reads only entity ids (no clock/RNG); the
// seeded ids themselves are untouched, so per-world determinism is preserved.
function idNum(id) {
  const n = parseInt(String(id).replace(/^\D+/, ""), 10);   // "b12" | "u7" | "g3" → 12 | 7 | 3
  return Number.isFinite(n) ? n : 0;
}
function bumpEntityCounterPastGalaxy(galaxy) {
  let max = peekEntityId() - 1;                              // whatever this world's own seeding reached
  for (const state of galaxy.planets.values()) {
    for (const id of state.units.keys()) max = Math.max(max, idNum(id));
    for (const id of state.buildings.keys()) max = Math.max(max, idNum(id));
  }
  restoreEntityId(max + 1);
}

// Run the background colonies each tick: bank their passive income, watch for
// trouble, and return notifications for the UI. Also the single place their sim
// events are drained — a colony isn't rendered or heard, so nothing else consumes
// them (left alone they would grow without bound). Reports a colony coming under
// attack (a player asset destroyed there) and a colony being lost (its last
// player building razed), each at most once per state transition. The "already
// notified" flags live on the galaxy (colonyNotes), not on the deterministic
// engine state — they're transient UI bookkeeping, re-derived harmlessly on load.
export function sweepColonies(galaxy, dt = 0) {
  const out = [];
  for (const [id, state] of galaxy.planets) {
    if (!state.background) continue;
    const buildings = playerBuildingCount(state);
    galaxy.credits += incomeBuildingCount(state) * COLONY_INCOME_PER_BUILDING * dt;   // capped, turret-excluded passive income
    if (galaxy.pacified && galaxy.pacified.has(id)) galaxy.credits += PACIFIED_INCOME * dt;   // occupation dividend, additive
    const rec = galaxy.colonyNotes.get(id) || { hadColony: false, colonyLost: false };
    // A standing colony resets the lost latch, so retaking and rebuilding a world re-arms
    // its alerts — without this, a world lost once was muted forever (a second razing never
    // re-announced, and the rebuilt colony's under-attack pings stayed suppressed).
    if (buildings > 0) { rec.hadColony = true; rec.colonyLost = false; }
    if (rec.hadColony && buildings === 0 && !rec.colonyLost) {
      rec.colonyLost = true;
      out.push({ type: "lost", planetId: id });
    } else if (rec.hadColony && !rec.colonyLost) {
      // Only worlds the player actually colonised raise hostile/attacked alerts — the living galaxy
      // now background-simulates every world (its AI can drift to war on its own), but a neighbour
      // turning on a world you've never set foot on isn't your problem and mustn't ping you.
      // A background world's diplomacy keeps drifting (diplomacy.js CREEP_RATE), so a
      // neighbour eventually declares war — but its neighbourHostile event has no other
      // consumer here and used to be silently drained, so the FIRST warning was the colony
      // already dying. Surface the declaration (once — diplomacy latches warAnnounced), else
      // the ongoing raid (fresh player losses this tick).
      if (state.events.some(e => e.type === "neighbourHostile")) out.push({ type: "hostile", planetId: id });
      else if (state.events.some(e => e.type === "entityKilled" && e.owner === "player")) out.push({ type: "attacked", planetId: id });
    }
    galaxy.colonyNotes.set(id, rec);
    state.events.length = 0;   // drain: a background colony's events have no other consumer
  }
  return out;
}

// The game state the player is currently on — what boot.js renders and drives.
export function activeState(galaxy) {
  return galaxy.planets.get(galaxy.activeId);
}

// Background worlds tick once every BG_STEP galaxy-ticks, each time by BG_STEP× the
// step, so a colony advances the same amount of sim time as the active world over
// any span — just in coarser, cheaper increments.
export const BG_STEP = 4;

// id -> roster-index lookup for `galaxy.worlds`, cached by the ARRAY's own identity rather than
// on the galaxy object: `worlds` is built in two places (createGalaxy above, and
// deserializeGalaxy in engine/persist.js), and both set it exactly once and never mutate it in
// place afterwards (append-only roster growth on load rebuilds the array — see persist.js —
// it doesn't push/splice the live `galaxy.worlds` reference), so a WeakMap keyed on that
// reference is a safe, self-invalidating O(1) replacement for the old per-frame
// `galaxy.worlds.indexOf(id)` scan (stepGalaxy runs this once per background world every
// frame, and per its header comment the whole scheduler is meant to stay well under 1ms/frame).
const worldIndexCache = new WeakMap();
function worldIndexMap(worlds) {
  let idx = worldIndexCache.get(worlds);
  if (!idx) { idx = new Map(worlds.map((id, i) => [id, i])); worldIndexCache.set(worlds, idx); }
  return idx;
}

// Advance the whole galaxy by one frame. The active world ticks every frame at
// full cadence (it's rendered and controlled). Every background colony ticks on a
// coarser fixed step, spread round-robin across BG_STEP frames by its fixed roster
// index, so per-frame background work is ~ceil(N/BG_STEP) worlds instead of N.
// Deterministic by construction: the schedule is pure integer arithmetic on the
// galaxy tick and the world's roster position (no wall-clock, no Map-order
// dependence), and each background tick uses the exact constant dtBg so total sim
// time is conserved regardless of cadence.
export function stepGalaxy(galaxy, dt) {
  const t = (galaxy.tick = (galaxy.tick | 0) + 1);
  galaxy.time = (galaxy.time || 0) + dt;             // galaxy-wide clock (deterministic: dt is the fixed step)
  tick(activeState(galaxy), dt);                     // active world: full rate
  const dtBg = dt * BG_STEP;
  const worldIndex = worldIndexMap(galaxy.worlds);
  for (const [id, state] of galaxy.planets) {
    if (id === galaxy.activeId || !state.background) continue;
    if (t % BG_STEP === worldIndex.get(id) % BG_STEP) tick(state, dtBg);
  }
  // Freight Lanes: a standing shipping drip, on its own integer-tick schedule (LANE_PERIOD) —
  // independent of the ~1/sec scan below (lanes move real cargo, so they're worth their own,
  // coarser cadence rather than piggybacking on a scan meant for cheap galaxy-wide bookkeeping).
  if (t % LANE_PERIOD === 0) runLanes(galaxy);
  // These galaxy-wide scans (conquest progress, milestones, no-foothold relief) all change on a
  // minutes timescale, so running them every frame (20 Hz) is wasted work that grows with the
  // colony count. Throttle to ~1/sec on the same deterministic integer schedule the BG round-
  // robin uses — a milestone/pacification/rescue firing up to a second later is imperceptible,
  // and RELIEF_COOLDOWN (20 s) dwarfs it. Runs on tick 1 too, so a freshly-stepped galaxy is
  // checked immediately. Pure integer arithmetic on galaxy.tick — no wall-clock, deterministic.
  if (t === 1 || t % PROGRESS_CHECK_EVERY === 0) {
    checkDomination(galaxy);      // conquest progress: pacified worlds (per-world toast) + a milestone at the target
    checkExpansion(galaxy);       // faction spread: developed AI worlds claim + colonise across the starmap
    updateFactionWarmth(galaxy);  // faction memory (allied direction): refresh each world's Allied-faction-mate count
    checkGalaxyProgress(galaxy);  // milestones: colonies founded, the Antimatter Gate coming online — fireworks, not wins
    checkRivalGate(galaxy);       // the rival Gate: track the galaxy's own charging threat, ascend it on completion
    checkGalaxyRescue(galaxy);    // NEVER auto-defeat: a total wipeout sends a relief colony ship so life goes on
    runColonyPolicies(galaxy);    // colony standing orders (engine/colonyPolicy.js): auto-sell + sustain workers, background worlds only
  }
}
const PROGRESS_CHECK_EVERY = 20;   // galaxy-wide scans run ~once per second (20 Hz sim), not every frame

// The Odyssey NEVER ends in defeat — as long as you haven't surrendered, life goes on
// (surrenderGalaxy is the only terminal state). So there's no galaxy-wide loss; instead, if you
// ever hold NO foothold anywhere (every Command Center razed and no colony ship left), a RELIEF
// colony ship is dispatched to your active world's landing zone so you can re-found and fight on.
// A short cooldown bounds the churn if relief keeps getting farmed, and its arrival is flagged for
// a UI toast. Once you hold the ship you have a foothold again, so it won't re-send. The per-world
// checkEndlessLoss is suppressed for galaxy states (state.inGalaxy, engine/victory.js), so this is
// the sole authority. The cooldown is keyed on the GALAXY-WIDE clock (galaxy.time), not any one
// world's local time — a jump swaps the active world, and each world's clock advances on its own,
// so comparing lastReliefTime (set on world A) to world B's time could read as "cooldown elapsed"
// (B younger than A ⇒ negative delta) or "never elapses", either of which breaks the anti-farm
// bound and could dead-end the no-defeat guarantee. galaxy.time is monotonic across the whole run.
// Pure + deterministic (galaxy.time accumulates the fixed dt in stepGalaxy).
export const RELIEF_COOLDOWN = 20;   // sim seconds between relief drops (anti-farm)
export function checkGalaxyRescue(galaxy) {
  const active = activeState(galaxy);
  if (active.over) return;                                         // a surrender already ended it
  for (const state of galaxy.planets.values()) {
    for (const b of state.buildings.values())
      if (b.owner === "player" && b.type === "command") return;   // a base somewhere → still going
    if (hasColonyShip(state, "player")) return;                   // …or a colony ship to re-found from
  }
  const now = galaxy.time || 0;
  if (now - (galaxy.lastReliefTime ?? -Infinity) < RELIEF_COOLDOWN) return;   // still on cooldown
  galaxy.lastReliefTime = now;
  const lz = active.map.bases.player;
  const ship = makeUnit("colonyship", "player", lz.x, lz.y);
  ship.id = "g" + (galaxy.entitySeq = (galaxy.entitySeq || 0) + 1);   // galaxy id scheme (as in jumpCapital)
  active.units.set(ship.id, ship);
  galaxy.reliefNote = true;                                        // drained by boot.js for a toast
}

// The one terminal state: the player voluntarily gives up. Ends the run on the active seat (the
// boot.js over-poll then shows the game-over screen with the surrender copy). A wipeout alone
// never triggers this — only an explicit surrender does.
export function surrenderGalaxy(galaxy) {
  const active = activeState(galaxy);
  if (active.over) return;
  active.over = true; active.winner = "ai";
  galaxy.surrendered = true;
}

// Record a one-time progress milestone — a firework, drained UI-side by boot.js. Idempotent
// per id, and `reached` persists (engine/persist.js) so a reload never replays a milestone
// you've already celebrated.
// The complete milestone vocabulary — the ONLY ids reachMilestone ever mints. Exported so the load
// path can filter a saved `reached` set against it (engine/persist.js): an unfiltered set let a
// hand-edited save inject junk, and — more importantly — filtering against the WORLD roster instead
// would silently drop every real milestone and replay its fireworks on the next load.
export const MILESTONE_IDS = ["capital", "gate", "domination", "domination:all", "rival-gate"];
/** True for any id reachMilestone can produce, including the per-world `world:N` family. */
export function isMilestoneId(id) {
  return typeof id === "string" && (MILESTONE_IDS.includes(id) || /^world:\d+$/.test(id));
}

function reachMilestone(galaxy, id) {
  if (galaxy.reached.has(id)) return;
  galaxy.reached.add(id);
  galaxy.milestones.push(id);
}

// Progress milestones for the play-forever sandbox — the fireworks that mark how far you've
// come, in place of a victory that would end the run. Swept galaxy-wide each tick, each fired
// once (reachMilestone): founding your first base and each further WORLD you settle
// ("world:N"), fortifying your first Capital ("capital"), and bringing an Antimatter Gate
// online anywhere ("gate" — the former economic victory, now a triumph you keep playing past).
// Conquest milestones live in checkDomination. Pure — reads only entity state; the firework
// itself is fired UI-side (boot.js), keeping the engine DOM-free.
export function checkGalaxyProgress(galaxy) {
  let settledWorlds = 0, hasCapital = false, gateOnline = false;
  for (const state of galaxy.planets.values()) {
    let heldHere = false;
    for (const b of state.buildings.values()) {
      if (b.owner !== "player") continue;
      if (b.type === "command" && !b.constructing) { heldHere = true; if (b.capital) hasCapital = true; }
      if (BUILDINGS[b.type]?.wonder && (b.charge || 0) >= 1) gateOnline = true;
    }
    if (heldHere) settledWorlds++;
  }
  for (let n = 1; n <= settledWorlds; n++) reachMilestone(galaxy, "world:" + n);
  if (hasCapital) reachMilestone(galaxy, "capital");
  if (gateOnline) reachMilestone(galaxy, "gate");
}

// Worlds to pacify (raze the neighbour's Command Center on) for the grand CONQUEST
// milestone — the military, multi-world firework. No longer a win: the galaxy keeps
// running past it (play-forever).
export const DOMINATION_TARGET = 4;

// The AI's foothold on a world — a Command Center OR an undeployed colony ship. The
// colony-ship clause is what stops checkDomination false-pacifying every world at
// tick 0 (both sides now START with a CC-less colony ship), and keeps "pacified"
// meaning "you actually drove them off" — a neighbour reduced to a lone ship can still
// re-found, so it isn't conquered yet. hasColonyShip is false in a skirmish.
const hasAiCommand = state => {
  for (const b of state.buildings.values()) if (b.owner === "ai" && b.type === "command" && !b.constructing) return true;
  return hasColonyShip(state, "ai");
};

// The faction a world answers to for cross-world faction-memory purposes (the grievance echo
// below, and updateFactionWarmth's Allied lift): its DYNAMIC controlling faction (checkExpansion's
// claims, once spread) when it has one, else its own neighbour's faction (state.players.ai.faction)
// — the same claim-first, AI-faction-fallback resolution checkExpansion's own self-claim step
// effectively establishes. Null for a state with no AI player at all.
function worldFaction(galaxy, id, state) {
  const claimed = galaxy.claims && galaxy.claims.get(id);
  if (claimed) return claimed;
  return (state && state.players.ai && state.players.ai.faction) || null;
}

// Conquest progress. A world is "pacified" the moment its neighbour has no standing
// Command Center — you razed it (only two sides fight, and every world is seeded with an
// AI capital). Pacification is STICKY (recorded on the galaxy, so a neighbour rebuilding
// can't un-pacify it); each freshly-pacified world is queued for a UI toast + firework
// (pacifyNotes), and reaching DOMINATION_TARGET fires the grand "domination" milestone —
// a firework, NOT a win, so the sandbox plays on. Deterministic — reads only entity state.
//
// DOMINATION WITH TEETH (docs/improvement-proposals.md 657-665): also stamp the diplomacy-side
// floor flag (state.diplomacy.pacified) on the razed world itself — checkDomination already holds
// that state in this loop. engine/diplomacy.js's updateDiplomacy reads the flag to floor the
// world's drift target at Neutral permanently, so a conquered neighbour rebuilds and defends
// itself but never re-initiates.
//
// FACTION MEMORY (docs/improvement-proposals.md 519-527), tuned as ONE system with the floor
// above: once every fresh pacification THIS TICK is recorded (so two faction-mates pacified in
// the same tick correctly exclude each other below, regardless of which one Map iteration visits
// first — see the second loop), echo a bounded, ONE-TIME stance penalty onto each pacified world's
// remaining UNPACIFIED faction-mates (matched by claim or AI faction — worldFaction, above), plus a
// starmap toast queued the same way checkExpansion already queues its own (expansionNotes). An
// already-pacified faction-mate is excluded — its own floor (this same function, an earlier tick)
// already holds it at Neutral-or-better, so a further hit would only fight that floor for no
// visible effect; a domination spree instead snowballs resistance across whichever of the
// faction's worlds AREN'T yet conquered.
export function checkDomination(galaxy) {
  const active = activeState(galaxy);
  if (active.over) return;
  const freshlyPacified = [];
  for (const [id, state] of galaxy.planets) {
    if (galaxy.pacified.has(id) || hasAiCommand(state)) continue;
    galaxy.pacified.add(id);
    galaxy.pacifyNotes.push(id);
    state.diplomacy.pacified = true;
    freshlyPacified.push({ id, state });
  }
  for (const { id, state } of freshlyPacified) {
    const faction = worldFaction(galaxy, id, state);
    if (!faction || faction === "neutral") continue;
    for (const [mateId, mateState] of galaxy.planets) {
      if (mateId === id || galaxy.pacified.has(mateId)) continue;
      if (worldFaction(galaxy, mateId, mateState) !== faction) continue;
      const dip = mateState.diplomacy;
      if (!dip) continue;
      dip.stance = Math.max(-1, Math.min(1, dip.stance - FACTION_ECHO_PENALTY));
      dip.factionEchoUntil = mateState.time + FACTION_ECHO_DURATION;
    }
    galaxy.expansionNotes.push({ type: "factionEcho", planetId: id, faction });
  }
  if (galaxy.pacified.size >= DOMINATION_TARGET) reachMilestone(galaxy, "domination");
  // The maximal achievement in a play-forever sandbox — pacifying EVERY world — gets its
  // own grander milestone, so the conquest-minded player who pushes hours past the 4-world
  // target isn't met with silence (and a per-conquest toast reading "Conquered 11/4").
  if (galaxy.pacified.size >= galaxy.worlds.length) reachMilestone(galaxy, "domination:all");
}

// FACTION SPREAD across the galaxy. The living galaxy fills up with developing AI factions
// (engine/ai.js aiIndustry); this is how their influence spreads between planets over a long game:
//  • SELF-CLAIM — a world whose AI has developed past CLAIM_DEV flies its own faction's flag.
//  • EXPAND — the single most-developed claimed world (past EXPAND_DEV) colonises the NEAREST still-
//    unclaimed world, claiming it and flipping that world's AI to its colours — so a thriving faction
//    absorbs the fringe and its territory grows across the starmap.
// One cross-planet claim per scan keeps the spread gradual; it's paced by how fast worlds develop
// (minutes), and converges once every world is claimed. Deterministic: development is an entity count,
// distance is fixed planet-x, order is the fixed roster, ties break by world id — no clock, no RNG.
// Reads/writes only galaxy.claims (persisted) + the AI's faction (persisted), so it's save/load-safe.
export const CLAIM_DEV = 3;    // industrial development at which a world's AI faction claims its homeworld
export const EXPAND_DEV = 6;   // ...and at which a thriving world reaches out to colonise a neighbour

export function checkExpansion(galaxy) {
  const claims = galaxy.claims || (galaxy.claims = new Map());
  const notes = galaxy.expansionNotes || (galaxy.expansionNotes = []);
  // SELF-CLAIM: every developed homeworld with a standing base flies its faction's flag (roster order).
  for (const id of galaxy.worlds) {
    if (claims.has(id)) continue;
    const s = galaxy.planets.get(id);
    if (!s || !hasAiCommand(s) || aiDevelopment(s) < CLAIM_DEV) continue;
    const faction = s.players.ai ? s.players.ai.faction : "neutral";
    claims.set(id, faction);
    notes.push({ type: "claim", planetId: id, faction });
  }
  // EXPAND: the single most-developed claimed world past EXPAND_DEV (tie by id) colonises the nearest
  // still-unclaimed world (tie by id). One per scan → gradual spread.
  let exp = null, expDev = EXPAND_DEV - 1e-9;
  for (const id of galaxy.worlds) {
    if (!claims.has(id)) continue;
    const s = galaxy.planets.get(id);
    if (!s) continue;
    const dev = aiDevelopment(s);
    if (dev > expDev || (dev === expDev && exp !== null && id < exp)) { expDev = dev; exp = id; }
  }
  if (exp === null) return;
  let best = null, bestD = Infinity;
  for (const other of galaxy.worlds) {
    if (claims.has(other)) continue;
    // Never colonise the world the player is on, or one they hold a base on. Expansion flips the
    // target world's AI faction (below), and faction feeds LIVE combat/economy multipliers
    // (factions.js → sideMod, read on every hit and haul) — so flipping a world the player is
    // actively fighting on would silently change the enemy's damage/sight/speed/gather mid-battle,
    // with only a starmap toast to show for it. Spread only reaches the unclaimed, unheld fringe.
    if (other === galaxy.activeId || playerFoothold(galaxy.planets.get(other))) continue;
    const d = Math.abs(planetX(other) - planetX(exp));
    if (d < bestD || (d === bestD && best !== null && other < best)) { bestD = d; best = other; }
  }
  if (best === null) return;
  const faction = claims.get(exp);
  claims.set(best, faction);
  const bs = galaxy.planets.get(best);
  if (bs && bs.players.ai) bs.players.ai.faction = faction;   // the colonised world flies the expander's colours
  notes.push({ type: "expand", from: exp, planetId: best, faction });
}

// FACTION MEMORY, allied direction (docs/improvement-proposals.md 519-527) — the mirror of
// checkDomination's grievance echo above: holding an Allied stance on one world lifts the drift
// TARGET of its faction-mates a little (engine/diplomacy.js updateDiplomacy), so befriending a
// bloc pays across its whole territory. Unlike the grievance echo this isn't a one-time event —
// it's a continuously-held CONDITION — so it's recomputed here on the same throttled ~1/sec scan
// stepGalaxy already runs checkDomination/checkExpansion on, rather than latched by an event: a
// world that drifts back down out of Allied stops granting the lift again within about a second.
//
// Stores a RAW COUNT per world (dip.factionWarmth: how many of ITS OTHER faction-mates are
// currently Allied), mirroring aiDevelopment's own raw-count shape — updateDiplomacy applies the
// per-unit weight and cap at the point of use, exactly like aiDevelopment's own
// DEV_SOFT_PER/DEV_SOFT_CAP. Pure (reads only persisted galaxy/diplomacy state) and deterministic
// (fixed roster order, no RNG, no wall clock).
export function updateFactionWarmth(galaxy) {
  const alliedByFaction = new Map();   // faction -> how many of its worlds are currently Allied
  for (const id of galaxy.worlds) {
    const state = galaxy.planets.get(id);
    const dip = state && state.diplomacy;
    if (!dip || dip.stance < ALLIED_THRESHOLD) continue;
    const faction = worldFaction(galaxy, id, state);
    if (!faction || faction === "neutral") continue;
    alliedByFaction.set(faction, (alliedByFaction.get(faction) || 0) + 1);
  }
  for (const id of galaxy.worlds) {
    const state = galaxy.planets.get(id);
    const dip = state && state.diplomacy;
    if (!dip) continue;
    const faction = worldFaction(galaxy, id, state);
    let count = (faction && alliedByFaction.get(faction)) || 0;
    if (dip.stance >= ALLIED_THRESHOLD) count--;   // a world's own Allied stance doesn't lift itself
    dip.factionWarmth = Math.max(0, count);
  }
}

/* ---------- THE RIVAL GATE (docs/improvement-proposals.md "the galaxy's strongest faction races
   its own wonder" + "a fully-teched neighbour races its own Antimatter Gate", merged per the
   Phase 7 plan — two independently-written proposals describing the same feature, reconciled
   into one mechanism here).

   The TRIGGER (whether a world raises and charges its own Gate at all) lives entirely in
   engine/aiIndustry.js's rivalGateEligible/RIVAL_GATE_BUFFER — every qualifying world builds its
   own Gate independently, self-contained, on its own think cycle, exactly like every other
   aiIndustry.js building decision. This module's job is narrower: pick which ONE currently-
   charging world is surfaced to the player as THE Rival Gate (checkExpansion's own most-
   developed, tie-by-id idiom, just above — deterministic, no clock/RNG), track its live charge
   for the starmap, and apply the 'ascension' consequence to EVERY world whose Gate completes —
   not only the tracked one, so two simultaneously-eligible worlds (a rare but real possibility on
   a Hard-heavy galaxy) can't let a second Gate complete unnoticed just because this scan happened
   to be watching a different one.

   THE ASCENSION CONSEQUENCE deliberately COMBINES both twins' proposals rather than picking one:
   the claimed-neighbours burst (Defense twin) AND the hardEdge upgrade + a permanent stance
   ceiling (AI twin) are not mutually exclusive, and the trigger is already double-gated (the
   Strategic tier banked AND Hard/wantsDeepIndustry) — a genuinely rare, hard-earned event, so
   escalating hard on it reads as "the galaxy changed under you" (the Defense twin's own framing)
   rather than as pile-on. Never a defeat: state.over is never touched by any of this. */

// The AI twin's proposal literally says "a permanent stance floor" for the ascension; taken
// literally that would HELP the player (the same shape as diplomacy.js's own APPEASE_FLOOR truce
// line), which contradicts its own framing as a "penalty toward the player" — so this reads it as
// a permanent CEILING instead: the ascended world's stance can never rise back past Wary, no
// matter how the scarcity/development pull on it evolves. Reapplied every scan (below), not a
// one-time snap — updateDiplomacy's own drift would otherwise claw it back up, and the AI twin's
// own "Where" note explicitly keeps this out of engine/diplomacy.js ("needs no change").
//
// EXCEPT once the player has personally pacified that same world (Domination with teeth,
// checkDomination/dip.pacified below): conquest is the more direct, more recent player action, so
// it wins over a stale ascension from before the capital fell. Without this guard the ceiling and
// the pacified floor fight forever — the ceiling reasserts every scan and always wins the raw
// stance value between updateDiplomacy's slower drift ticks, so razing an ascended neighbour's
// Command Center would have no visible effect on its stance, which reads as broken in play.
export const RIVAL_ASCENSION_STANCE_CEILING = PEACE_THRESHOLD;

// The currently-charging AI-owned wonder building on `state`, or null — the same predicate
// aiIndustry.js's own `hasGate` check uses, just read from the outside.
function aiWonderOn(state) {
  for (const b of state.buildings.values())
    if (b.owner === "ai" && BUILDINGS[b.type]?.wonder) return b;
  return null;
}

// Apply the ascension consequence to `worldId` exactly once. Combines both twins' proposals (see
// the header comment above): hardEdge + a permanent stance ceiling, AND an all-at-once claims
// burst — every still-unclaimed world the player hasn't founded/settled on and isn't currently
// standing on (the exact same safety exclusion checkExpansion's own EXPAND step already applies,
// for the exact same reason: flipping a world's faction out from under live combat/economy
// multipliers). Deliberately ALL AT ONCE rather than checkExpansion's own one-per-scan trickle —
// an ascension is a single dramatic event, not a gradual spread.
function applyRivalAscension(galaxy, worldId, state) {
  if (state.players.ai) state.players.ai.upgrades.hardEdge = true;
  (galaxy.rivalAscended || (galaxy.rivalAscended = new Set())).add(worldId);
  if (state.diplomacy && !state.diplomacy.pacified)
    state.diplomacy.stance = Math.min(state.diplomacy.stance, RIVAL_ASCENSION_STANCE_CEILING);

  const claims = galaxy.claims || (galaxy.claims = new Map());
  const notes = galaxy.expansionNotes || (galaxy.expansionNotes = []);
  const faction = state.players.ai ? state.players.ai.faction : "neutral";
  claims.set(worldId, faction);
  for (const other of galaxy.worlds) {
    if (other === worldId || claims.has(other)) continue;
    if (other === galaxy.activeId || playerFoothold(galaxy.planets.get(other))) continue;
    claims.set(other, faction);
    const os = galaxy.planets.get(other);
    if (os && os.players.ai) os.players.ai.faction = faction;
    notes.push({ type: "expand", from: worldId, planetId: other, faction });
  }
}

// The rival-gate scan, run at PROGRESS_CHECK_EVERY cadence from stepGalaxy — the same throttled
// schedule checkDomination/checkExpansion/checkGalaxyProgress already share. Three jobs, in order:
//  1. Ascension sweep — any AI-owned wonder anywhere at full charge ascends exactly once
//     (galaxy.rivalAscended is the idempotency latch), regardless of whether it was the tracked
//     world. Fires the singular "rival-gate" milestone the first time this happens anywhere.
//  2. Reapply the stance ceiling for every already-ascended world — "permanent" in the same sense
//     DOMINATION_TARGET's pacify flag is permanent: reasserted every scan, not a single mutation.
//  3. Selection — if nothing is currently tracked, pick the single most-developed world with a
//     live (charging, not yet ascended) Gate to surface as THE Rival Gate (galaxyStatus below).
// Iterates `galaxy.worlds` (the fixed roster order), never the Map, so neither insertion order nor
// Map iteration can affect the outcome — only aiDevelopment values and the id tie-break can.
export function checkRivalGate(galaxy) {
  const ascended = galaxy.rivalAscended || (galaxy.rivalAscended = new Set());
  const notes = galaxy.rivalGateNotes || (galaxy.rivalGateNotes = []);

  // 1) ASCENSION SWEEP.
  for (const worldId of galaxy.worlds) {
    if (ascended.has(worldId)) continue;
    const state = galaxy.planets.get(worldId);
    if (!state) continue;
    const b = aiWonderOn(state);
    if (!b || (b.charge || 0) < 1) continue;
    applyRivalAscension(galaxy, worldId, state);
    notes.push({ type: "ascended", planetId: worldId });
    reachMilestone(galaxy, "rival-gate");
    if (galaxy.rivalGate && galaxy.rivalGate.worldId === worldId) galaxy.rivalGate = null;
  }

  // 2) REAPPLY the permanent stance ceiling on every ascended world — see the header comment on
  // why this lives here rather than in engine/diplomacy.js's own drift. Skips a world the player
  // has since personally pacified (see the header comment on RIVAL_ASCENSION_STANCE_CEILING) —
  // conquest overrides a stale ascension, not the other way around.
  for (const worldId of ascended) {
    const state = galaxy.planets.get(worldId);
    if (state && state.diplomacy && !state.diplomacy.pacified)
      state.diplomacy.stance = Math.min(state.diplomacy.stance, RIVAL_ASCENSION_STANCE_CEILING);
  }

  // 3) SELECTION — only when nothing is currently tracked. Clear a stale tracked reference first
  // (its building razed out from under it without ascending).
  if (galaxy.rivalGate) {
    const state = galaxy.planets.get(galaxy.rivalGate.worldId);
    const b = state && state.buildings.get(galaxy.rivalGate.buildingId);
    if (!b || b.owner !== "ai" || !BUILDINGS[b.type]?.wonder || (b.charge || 0) >= 1) {
      galaxy.rivalGate = null;
    }
  }
  if (!galaxy.rivalGate) {
    let best = null, bestDev = -Infinity, bestBuilding = null;
    for (const worldId of galaxy.worlds) {
      if (ascended.has(worldId)) continue;
      const state = galaxy.planets.get(worldId);
      if (!state) continue;
      const b = aiWonderOn(state);
      if (!b || (b.charge || 0) >= 1) continue;
      const dev = aiDevelopment(state);
      if (dev > bestDev || (dev === bestDev && best !== null && worldId < best)) { bestDev = dev; best = worldId; bestBuilding = b; }
    }
    if (best !== null) {
      galaxy.rivalGate = { worldId: best, buildingId: bestBuilding.id };
      notes.push({ type: "spotted", planetId: best });
    }
  }
}

// The tracked Rival Gate's live status for the starmap — { worldId, charge } or null. Reads the
// CURRENT charge straight off the building (not a stale snapshot), so a caller polling this every
// frame always sees the live number.
function rivalGateStatus(galaxy) {
  if (!galaxy.rivalGate) return null;
  const state = galaxy.planets.get(galaxy.rivalGate.worldId);
  const b = state && state.buildings.get(galaxy.rivalGate.buildingId);
  if (!b) return null;
  return { worldId: galaxy.rivalGate.worldId, charge: b.charge || 0 };
}

// A pure snapshot of the galaxy for the starmap: per-world status (your active
// seat / a colony you hold / unexplored) and, for worlds you've been to, the
// neighbour's stance. Plus the visited count and credits.
export function galaxyStatus(galaxy) {
  // Every world simulates, but the player only SEES one they've REACHED (`discovered`). An
  // undiscovered world reads "unexplored" and hides its neighbour's stance, exactly as before the
  // living galaxy — the difference is now invisible until you visit. Old saves default to the
  // instantiated set (which for them was precisely the visited worlds).
  const discovered = galaxy.discovered || new Set(galaxy.planets.keys());
  return {
    credits: galaxy.credits,
    activeId: galaxy.activeId,
    visited: discovered.size,
    total: galaxy.worlds.length,
    pacified: galaxy.pacified ? galaxy.pacified.size : 0,   // Domination progress: worlds conquered
    dominationTarget: DOMINATION_TARGET,
    rivalGate: rivalGateStatus(galaxy),   // the tracked Rival Gate's { worldId, charge }, or null — starmap alert
    worlds: galaxy.worlds.map(id => {
      const seen = discovered.has(id);
      const s = seen ? galaxy.planets.get(id) : null;
      let status = "unexplored", income = 0;
      const pacified = !!(galaxy.pacified && galaxy.pacified.has(id));
      if (id === galaxy.activeId) status = "seat";
      else if (pacified) status = "pacified";   // conquered — its neighbour's capital is razed
      else if (s) {
        const buildings = playerBuildingCount(s);
        // A world you've been to is a "colony" only while you still hold a
        // building there; once razed it's "contested" — visited but no longer
        // yours (so the map doesn't keep calling a lost world your colony).
        status = buildings > 0 ? "colony" : "contested";
        income = Math.round(incomeBuildingCount(s) * COLONY_INCOME_PER_BUILDING * 60);   // credits/min (capped, turret-excluded)
      }
      // Industry/Tech ratings (data.js) drive factory speed + research speed and
      // finished-good prices — surfaced so "where to settle/jump" is an informed call.
      const p = PLANETS.find(pl => pl.id === id);
      // `faction` is the world's fixed cultural origin (data.js PLANETS); `controlledBy` is the DYNAMIC
      // faction that has claimed it via expansion (checkExpansion) — the spreading galactic politics
      // shown on the starmap. Visible galaxy-wide (it's sphere-of-influence news, not tactical intel).
      return { id, status, income, pacified, stance: seen && s && s.diplomacy ? s.diplomacy.stance : null,
        industry: p ? p.industry : 5, tech: p ? p.tech : 5, faction: p ? p.faction : null,
        controlledBy: (galaxy.claims && galaxy.claims.get(id)) || null };
    }),
  };
}

// The fortified Capital: an upgraded Command Center with double HP. Like every deployed
// base it is permanent — it never travels (interplanetary jumps carry a colony ship, not
// a base; jumpVessel/jumpCapital) — so the Capital is your hardened anchor world. One
// per owner; the flag also drives its gold ring on the map (render.js).
export const CAPITAL_UPGRADE_COST = { ore: 400 };
export const CAPITAL_HP_MULT = 2;

// Improve a Command Center into your Capital: pay the cost, mark it, and scale its HP
// (and current HP, preserving any battle damage as a fraction) by CAPITAL_HP_MULT.
// Odyssey-only, one Capital per owner, not on a still-constructing CC. Deterministic —
// pure state mutation, no clock/RNG. Returns whether the upgrade happened.
export function upgradeToCapital(state, building) {
  if (!building || building.type !== "command" || building.constructing || building.capital) return false;
  const owner = building.owner;
  for (const b of state.buildings.values())
    if (b.owner === owner && b.capital) return false;             // only one Capital
  const res = state.players[owner].resources;
  for (const com in CAPITAL_UPGRADE_COST) if ((res[com] || 0) < CAPITAL_UPGRADE_COST[com]) return false;
  for (const com in CAPITAL_UPGRADE_COST) res[com] -= CAPITAL_UPGRADE_COST[com];
  building.capital = true;
  building.maxHp = Math.round(building.maxHp * CAPITAL_HP_MULT);
  building.hp = Math.round(building.hp * CAPITAL_HP_MULT);        // keeps the damage fraction
  return true;
}

// The Spaceport comes in THREE tiers. Its jump capacity — how much fleet it can launch
// at once, measured in ship POPULATION (supply cost), not head-count — scales with the
// tier, so a very large army has to cross in several jumps through a small pad, or you
// upgrade to a bigger one. Capacity is indexed by tier (1..3); index 0 is unused.
export const SPACEPORT_MAX_TIER = 3;
export const SPACEPORT_CAPACITY = [0, 12, 24, 40];              // supply carried per jump, by tier
export const SPACEPORT_UPGRADE_COST = { 2: { ore: 250 }, 3: { ore: 500 } };   // ore to reach a tier (escalating)

// A Spaceport's tier (defaults to 1 for a fresh pad or a pre-tier save) and the per-jump
// capacity it grants.
export const spaceportTier = b => Math.min(SPACEPORT_MAX_TIER, Math.max(1, b.tier || 1));
export const jumpCapacity = b => SPACEPORT_CAPACITY[spaceportTier(b)];

// Upgrade a Spaceport one tier (max 3): pay the ore, bump the tier, raising its per-jump
// capacity. Odyssey-only, deterministic (pure state mutation — no clock/RNG), like the
// Capital fortification. Returns whether it happened (refused when already max, still
// under construction, or unaffordable).
export function upgradeSpaceport(state, building) {
  if (!building || building.type !== "spaceport" || building.constructing) return false;
  const tier = spaceportTier(building);
  if (tier >= SPACEPORT_MAX_TIER) return false;
  const cost = SPACEPORT_UPGRADE_COST[tier + 1];
  const res = state.players[building.owner].resources;
  for (const com in cost) if ((res[com] || 0) < cost[com]) return false;
  for (const com in cost) res[com] -= cost[com];
  building.tier = tier + 1;
  return true;
}

const unitSupply = u => UNITS[u.type]?.supplyCost || 0;

// What counts as a launch-ready pad: the player's own, finished Spaceport. Defined once so
// jumpVessel/canJump/jumpCapital can't drift on the predicate (owner + type + built).
const isPlayerSpaceport = b => b.owner === "player" && b.type === "spaceport" && !b.constructing;
// EVERY launch-ready pad the player holds on this world, not just one — a world can carry
// more than one completed Spaceport (a second pad built for extra jump throughput, or while
// upgrading the first). Sorted by id for a stable, deterministic iteration order (matches the
// codebase's usual entity tie-break), so which pad "goes first" below can never depend on Map
// insertion order.
export const playerSpaceports = state => [...state.buildings.values()].filter(isPlayerSpaceport).sort((a, b) => (a.id < b.id ? -1 : 1));

// The colony ship that would carry an interplanetary jump: a player colony ship staged within
// JUMP_LOAD_RADIUS of ANY completed Spaceport (not just one — see playerSpaceports). A jump
// relocates the SHIP (and the rest of the staged expedition) — NOT a deployed base. Deployed
// Command Centers are permanent: the world you leave keeps them and becomes a background
// colony. Deploy the ship at the destination to found your new base there. Null when no ship
// is on any pad.
export function jumpVessel(state) {
  const spaceports = playerSpaceports(state);
  if (!spaceports.length) return null;
  for (const u of state.units.values())
    if (u.owner === "player" && u.type === "colonyship"
        && spaceports.some(sp => Math.hypot(u.x - sp.x, u.y - sp.y) <= JUMP_LOAD_RADIUS)) return u;
  return null;
}

// Can the player launch a jump from this world? — just a completed Spaceport. No colony
// ship is required: a jump can carry one (to settle a new world), or an army (to reinforce
// a colony), or nothing (to hop back and control a world you already hold). jumpVessel
// stays as an informational helper (is a ship loaded?) for the HUD, not a gate.
export function canJump(state) {
  return playerSpaceports(state).length > 0;
}

// A world where the player still has a foothold — a Command Center or an undeployed colony ship
// (the same notion as the galaxy defeat/relief check). It's a world a stranded force can fall
// back to and actually operate from: build, re-arm, or fetch a colony ship.
const playerFoothold = state => !!state && ([...state.buildings.values()]
  .some(b => b.owner === "player" && b.type === "command") || hasColonyShip(state, "player"));

// Can the player jump to `destId` right now? A Spaceport on the CURRENT world lets you jump
// anywhere (expand to a new world or hop to a held one). WITHOUT a Spaceport here you can still
// FALL BACK to any world where you have a foothold — so a force stranded on a portless world
// (e.g. you hopped an army over and forgot the colony ship) is never trapped: it can always
// retreat to a base it holds and bring the ship back. Only opening a NEW frontier needs a
// Spaceport here.
export function canJumpTo(galaxy, destId) {
  if (destId === galaxy.activeId) return false;
  return canJump(activeState(galaxy)) || playerFoothold(galaxy.planets.get(destId));
}

const planetX = id => PLANETS.find(p => p.id === id)?.x ?? 0;

// The Spaceport's tier doesn't just lift more fleet per jump (SPACEPORT_CAPACITY) — a bigger
// pad also burns new-world fuel more efficiently. Indexed by tier (1..3) like SPACEPORT_CAPACITY;
// index 0 (no completed pad at all) is the same x1.0 as a fresh Tier-1 pad, so building the FIRST
// Spaceport is a pure capability unlock and never itself a hidden fuel bump.
export const FUEL_DISCOUNT_BY_TIER = [1, 1, 0.85, 0.7];

// The fuel a jump to `destId` costs: FREE to a world you already hold (any world you've
// visited — a colony you're returning to, reinforcing, or re-settling), so bouncing between
// your own worlds to defend or ferry a colony ship stays friction-free. Reaching a NEW world
// costs fuel that SCALES WITH DISTANCE across the frontier (data.js planet x, 0..~18): a near
// hop is close to the base fee, settling a distant world is a real, growing credit sink and a
// strategic choice — so exploration spend isn't the old flat, quickly-capped ~4,000 lifetime.
// The origin's best COMPLETED Spaceport tier (playerSpaceports(from), not the jump's actual
// destination pad — this is about YOUR launch infrastructure) cuts that distance-scaled fuel by
// FUEL_DISCOUNT_BY_TIER, so upgrading the pad is a real economic choice, not just a capacity knob.
export function jumpCost(galaxy, destId) {
  // Free to a world you've already REACHED (a colony you're returning to, reinforcing, or
  // re-settling). Since the living galaxy instantiates every world up front, "reached" is the
  // player-facing `discovered` set, NOT merely "the state object exists" — else every jump would be
  // free. Old saves (no discovered set) fall back to planets.has, which for them meant the same thing.
  const known = galaxy.discovered ? galaxy.discovered.has(destId) : galaxy.planets.has(destId);
  if (known || playerFoothold(galaxy.planets.get(destId))) return 0;   // reached before, or a base you still hold → free
  const dist = Math.abs(planetX(destId) - planetX(galaxy.activeId));
  const tier = playerSpaceports(activeState(galaxy)).reduce((max, sp) => Math.max(max, spaceportTier(sp)), 0);
  const discount = FUEL_DISCOUNT_BY_TIER[tier] ?? 1;
  return Math.round(JUMP_COST * discount * (0.8 + dist / 18));   // ~340 next-door … ~720 across the map, before the pad discount
}

// The player units staged near a Spaceport — the expedition that rides along on a
// jump. One definition, so the HUD's preview count and the jump's actual move can
// never disagree about what leaves.
export function stagedRiders(state, spaceport) {
  const out = [];
  for (const u of state.units.values())
    // A ship assigned to a Freight Lane (u.laneId, see runLanes below) is physically parked here
    // as a STANDING investment, not a free ride — excluded so it never gets swept off-world on the
    // next jump out from under its lane.
    if (u.owner === "player" && !u.laneId && Math.hypot(u.x - spaceport.x, u.y - spaceport.y) <= JUMP_LOAD_RADIUS) out.push(u);
  return out;
}

// What actually LAUNCHES on one jump, capped by the pad's tier capacity. From the units
// staged near the Spaceport, fill the hold closest-to-the-pad first by ship population
// (supply) until the next unit wouldn't fit — a skip-not-break fill, so a heavy unit that
// doesn't fit is passed over for lighter ones behind it rather than blocking them (workers
// are supply 1, so a fleet always makes progress and nothing softlocks). The overflow
// waits at the pad for the next jump. Pure + deterministic: closest-first, ties broken by
// entity id. One definition, so the HUD preview and the jump's actual move always agree.
export function jumpManifest(state, spaceport) {
  const capacity = jumpCapacity(spaceport);
  const staged = stagedRiders(state, spaceport)
    .map(u => ({ u, d: Math.hypot(u.x - spaceport.x, u.y - spaceport.y) }))
    .sort((a, b) => a.d - b.d || (a.u.id < b.u.id ? -1 : 1));
  const riders = [];
  let used = 0;
  for (const { u } of staged) {
    const s = unitSupply(u);
    if (used + s <= capacity) { riders.push(u); used += s; }
  }
  const stagedSupply = staged.reduce((t, { u }) => t + unitSupply(u), 0);
  return { riders, capacity, used, stagedSupply, staged: staged.length, leftBehind: staged.length - riders.length };
}

// EVERY player Spaceport's staged riders, combined into one launch. With a single completed
// pad this is byte-identical to jumpManifest(state, thatPad) — every candidate unit's nearest
// pad is trivially the one pad, so the same closest-first fill runs unchanged. With more than
// one pad, each staged unit boards through its NEAREST pad (ties broken by pad id, matching
// the unit tie-break below), and each pad fills its own capacity independently — a unit that
// doesn't fit at its nearest pad is left behind rather than spilling over to another pad's
// spare capacity (a simple, deterministic policy, not a globally-optimal pack across pads).
// jumpCapital is the only caller: this is what actually determines who jumps, so it has to
// count every completed pad, not just one — a second Spaceport's staged units used to be
// silently ignored on every jump, because only the first Spaceport found (Map iteration
// order) was ever consulted.
export function jumpManifestAll(state) {
  const spaceports = playerSpaceports(state);
  if (!spaceports.length) return { riders: [], capacity: 0, used: 0, stagedSupply: 0, staged: 0, leftBehind: 0 };

  // Every player unit within range of at least one pad, tagged with its NEAREST pad so it can
  // never be double-counted across two overlapping catchment radii.
  const byNearestPad = new Map(spaceports.map(sp => [sp.id, []]));
  for (const u of state.units.values()) {
    // A Freight Lane's assigned ship is busy standing infrastructure, not a jump rider — see
    // stagedRiders' identical exclusion above; jumpManifestAll can't just call stagedRiders (it
    // needs the nearest-pad tagging below), so the check is repeated here.
    if (u.owner !== "player" || u.laneId) continue;
    let nearest = null, nearestD = Infinity;
    for (const sp of spaceports) {
      const d = Math.hypot(u.x - sp.x, u.y - sp.y);
      if (d > JUMP_LOAD_RADIUS) continue;
      if (d < nearestD || (d === nearestD && sp.id < nearest.id)) { nearest = sp; nearestD = d; }
    }
    if (nearest) byNearestPad.get(nearest.id).push({ u, d: nearestD });
  }

  const riders = [];
  let capacity = 0, used = 0, stagedSupply = 0, staged = 0;
  for (const sp of spaceports) {
    const cap = jumpCapacity(sp);
    capacity += cap;
    const candidates = byNearestPad.get(sp.id).sort((a, b) => a.d - b.d || (a.u.id < b.u.id ? -1 : 1));
    let padUsed = 0;
    for (const { u } of candidates) {
      const s = unitSupply(u);
      if (padUsed + s <= cap) { riders.push(u); padUsed += s; }
    }
    used += padUsed;
    staged += candidates.length;
    stagedSupply += candidates.reduce((t, { u }) => t + unitSupply(u), 0);
  }
  return { riders, capacity, used, stagedSupply, staged, leftBehind: staged - riders.length };
}

// A jump carries a CARGO HOLD of manufactured goods to the destination, so a run of production on
// one world can be sold on another — the make-here/sell-there loop (produced goods price
// differently per world, engine/market.js). The hold's SIZE is the combined cargoHold of the cargo
// ships (engine/entities.js: hauler/heavyhauler/bulkfreighter) staged for the jump — no cargo ship
// means no freight. Loaded most-valuable-first (data.js COM.base: machinery 250 > electronics 95 >
// alloys 80 > spice 34 > metals 22). spice is here so Verdani's agri surplus can be exported and
// sold dear on an industrial world (it's cheap where it's mined, precious where it isn't); cheaper
// raws aren't worth a cargo slot and strategic goods stay put.
// Exported so runLanes' commodity-filter fallback (below) and any future caller can share the
// exact same default ordering cargoManifest already uses — one most-valuable-first list, not two
// that could drift.
export const CARGO_GOODS = ["machinery", "electronics", "alloys", "spice", "metals"];

// The freight capacity a set of riders provides — the summed cargoHold of the cargo ships among
// them (anything without a cargoHold carries nothing). Pure.
export function freightCapacity(riders) {
  let cap = 0;
  for (const u of riders) cap += UNITS[u.type]?.cargoHold || 0;
  return cap;
}

// What `capacity` units of hold would haul from `from`, as { good: qty } — most-valuable-first, for
// the HUD preview and the jump itself (so the shown manifest and the moved goods can never
// disagree). capacity 0 (no cargo ship staged) → an empty hold. `goods` lets a caller restrict the
// pick to a subset (runLanes' commodity filter, below) while walking CARGO_GOODS' own
// most-valuable-first order; omitted, it's the exact same list every existing caller already got.
export function cargoManifest(from, capacity = 0, goods = CARGO_GOODS) {
  let room = Math.max(0, capacity | 0);
  const src = from.players.player.resources;
  const manifest = {};
  for (const com of goods) {
    if (room <= 0) break;
    const move = Math.min(Math.floor(src[com] || 0), room);
    if (move > 0) { manifest[com] = move; room -= move; }
  }
  return manifest;
}

/* ---------- Freight Lanes: standing shipping between held worlds ---------- */

// How often (in galaxy ticks) an active lane moves cargo — an integer schedule keyed on
// galaxy.tick, exactly like BG_STEP/PROGRESS_CHECK_EVERY above, so it's deterministic and
// independent of frame dt. A lane is a slow drip (real sim minutes, at the 20Hz cadence the rest
// of this scheduler assumes), not an instant transfer — it's standing infrastructure, not a
// one-off haul.
export const LANE_PERIOD = 200;   // ~10 sim-seconds at 20Hz

// Create a standing lane from `from` to `to`, filtered to `commodities` (empty/omitted = every
// CARGO_GOODS commodity, most-valuable-first — see runLanes). Refused for a same-world "lane" or
// an unrecognised world on either end. Returns the new lane (also pushed onto galaxy.lanes), or
// null on refusal.
export function createLane(galaxy, from, to, commodities = []) {
  if (from === to || !galaxy.planets.has(from) || !galaxy.planets.has(to)) return null;
  const lanes = galaxy.lanes || (galaxy.lanes = []);
  const lane = { id: "lane" + (galaxy.laneSeq = (galaxy.laneSeq || 0) + 1), from, to, commodities: [...commodities], shipIds: [] };
  lanes.push(lane);
  return lane;
}

// Disband a lane and free every ship it held busy (clears their laneId flag). Returns whether a
// lane with that id existed.
export function deleteLane(galaxy, laneId) {
  const lanes = galaxy.lanes;
  if (!lanes) return false;
  const idx = lanes.findIndex(l => l.id === laneId);
  if (idx < 0) return false;
  const lane = lanes[idx];
  const from = galaxy.planets.get(lane.from);
  if (from) for (const id of lane.shipIds) { const u = from.units.get(id); if (u) delete u.laneId; }
  lanes.splice(idx, 1);
  return true;
}

// Assign a player freighter parked on the lane's SOURCE world to it — it must be a real cargo
// ship (UNITS[type].cargoHold) and currently standing within JUMP_LOAD_RADIUS of one of that
// world's own completed Spaceports (reusing the exact same catchment jumpVessel/stagedRiders use
// — this is deliberately the same "at the pad" test, not a new one). A ship already on another
// lane is moved over rather than double-booked. Returns whether the assignment happened.
export function assignShipToLane(galaxy, laneId, unitId) {
  const lane = (galaxy.lanes || []).find(l => l.id === laneId);
  if (!lane) return false;
  const from = galaxy.planets.get(lane.from);
  const u = from && from.units.get(unitId);
  if (!u || u.owner !== "player" || !UNITS[u.type]?.cargoHold) return false;
  const pads = playerSpaceports(from);
  if (!pads.length || !pads.some(p => Math.hypot(u.x - p.x, u.y - p.y) <= JUMP_LOAD_RADIUS)) return false;
  if (u.laneId && u.laneId !== laneId) unassignShipFromLane(galaxy, u.laneId, unitId);
  if (!lane.shipIds.includes(unitId)) lane.shipIds.push(unitId);
  u.laneId = laneId;
  return true;
}

// Pull a ship off a lane, freeing it for jumps/other orders again. Returns whether it was found.
export function unassignShipFromLane(galaxy, laneId, unitId) {
  const lane = (galaxy.lanes || []).find(l => l.id === laneId);
  if (!lane) return false;
  const idx = lane.shipIds.indexOf(unitId);
  if (idx < 0) return false;
  lane.shipIds.splice(idx, 1);
  const from = galaxy.planets.get(lane.from);
  const u = from && from.units.get(unitId);
  if (u && u.laneId === laneId) delete u.laneId;
  return true;
}

// Run every standing lane one delivery cycle: revalidate its assigned ships (still alive, still a
// player freighter, still parked near one of the source world's own Spaceports — exactly
// assignShipToLane's own test, run again every cycle so a ship that wandered off, died, or was
// reassigned quietly drops out rather than silently keep "shipping" from wherever it ended up),
// then move min(the survivors' combined cargoHold, the filtered stock on hand) straight from the
// source world's treasury to the destination's — a lane never touches a ship's own .freight hold,
// it's a capacity NUMBER standing in for "how much this route can carry today", not a physical
// load/unload cycle. Called from stepGalaxy on the LANE_PERIOD schedule. Deterministic: galaxy.lanes
// and each lane's shipIds are plain arrays in insertion order, and cargoManifest's own commodity
// walk is a fixed list — nothing here reads a clock, RNG, or Map/Set iteration order.
export function runLanes(galaxy) {
  const lanes = galaxy.lanes;
  if (!lanes || !lanes.length) return;
  for (const lane of lanes) {
    const from = galaxy.planets.get(lane.from);
    const to = galaxy.planets.get(lane.to);
    if (!from || !to) continue;
    const pads = playerSpaceports(from);
    const kept = [];
    for (const id of lane.shipIds) {
      const u = from.units.get(id);
      const valid = u && u.owner === "player" && UNITS[u.type]?.cargoHold
        && pads.some(p => Math.hypot(u.x - p.x, u.y - p.y) <= JUMP_LOAD_RADIUS);
      if (valid) { u.laneId = lane.id; kept.push(id); }
      else if (u) delete u.laneId;
    }
    lane.shipIds = kept;
    if (!kept.length) continue;
    const capacity = kept.reduce((sum, id) => sum + (UNITS[from.units.get(id).type]?.cargoHold || 0), 0);
    if (capacity <= 0) continue;
    const goods = lane.commodities && lane.commodities.length ? lane.commodities : CARGO_GOODS;
    const manifest = cargoManifest(from, capacity, goods);
    const src = from.players.player.resources, dst = to.players.player.resources;
    for (const com in manifest) {
      src[com] -= manifest[com];
      dst[com] = (dst[com] || 0) + manifest[com];
    }
  }
}

// freightUsed/freightRoom (how full a freighter's hold is, and its remaining room) now live in
// entities.js — engine/haul.js needs them for the worker↔freighter physical loading path and can't
// import this module (galaxy.js -> sim.js -> haul.js would cycle back here). Re-exported (imported
// above) so every existing caller of these two from "./galaxy.js" is unaffected.
export { freightUsed, freightRoom };

// Load up to `qty` of commodity `com` from the CURRENT world's player stockpile into a freighter's
// hold, clamped to the hold's room and what's actually in stock. Returns the amount loaded (0 if
// it's not a player freighter, the commodity is unknown, or nothing could move). The goods leave
// the stockpile immediately — they're aboard the ship now, to ride the next jump.
export function loadFreighter(state, unitId, com, qty) {
  const u = state.units.get(unitId);
  if (!u || u.owner !== "player" || !u.freight || !COM[com] || !(UNITS[u.type]?.cargoHold)) return 0;
  const res = state.players.player.resources;
  const move = Math.min(Math.floor(qty) || 0, freightRoom(u), Math.floor(res[com] || 0));
  if (move <= 0) return 0;
  res[com] -= move;
  u.freight[com] = (u.freight[com] || 0) + move;
  return move;
}

// Unload up to `qty` of `com` from a freighter's hold back onto the CURRENT world's player
// stockpile. Returns the amount unloaded. Works wherever the ship is — the origin (to undo a
// load) or a world it jumped to (to bank the haul and sell it at that market).
export function unloadFreighter(state, unitId, com, qty) {
  const u = state.units.get(unitId);
  if (!u || u.owner !== "player" || !u.freight) return 0;
  const move = Math.min(Math.floor(qty) || 0, u.freight[com] || 0);
  if (move <= 0) return 0;
  u.freight[com] -= move;
  if (u.freight[com] <= 0) delete u.freight[com];
  const res = state.players.player.resources;
  res[com] = (res[com] || 0) + move;
  return move;
}

// A jump delivers every staged freighter's HOLD to the destination colony's stockpile — exactly
// what the player hand-loaded (loadFreighter/unloadFreighter), nothing more. A freighter left
// empty carries nothing across; it does NOT auto-fill from the origin stockpile any more (the
// previous "empty hold → most-valuable-first" default made a round trip actively work against a
// player who wanted to haul on the way back only: land empty at a destination, jump home before
// reloading, and the empty ship would eagerly scoop up local goods and carry them right back,
// silently undoing a delivery the player had just made — see the reported case in git history).
// Manual control now means exactly that: load what you want shipped, or it stays put. Returns the
// combined delivered manifest (for the arrival toast). `riders` are the units that lifted off;
// non-freighters (no hold) are skipped.
function loadCargo(from, dest, riders) {
  const dst = dest.players.player.resources;
  const delivered = {};
  for (const u of riders) {
    if (!u.freight || !(UNITS[u.type]?.cargoHold)) continue;
    for (const com in u.freight) {                               // deliver the hold to the destination colony
      dst[com] = (dst[com] || 0) + u.freight[com];
      delivered[com] = (delivered[com] || 0) + u.freight[com];
    }
    u.freight = {};
  }
  return delivered;
}

// A minimap pick is necessarily coarse — that's the whole point of it (a blind landing on a
// world with no beacon should feel like one, not a precise coordinate entry). Rounds the raw
// clicked point onto a fixed grid, THEN clamps it away from the map edge — in that order, so
// the clamp is the last word and the final point can never drift back outside the margin the
// rounding might otherwise have pushed it past. The margin comfortably exceeds the widest
// rider-spawn ring jumpCapital uses below (46 + 2*18 = 82), so a picked corner can never spawn
// a unit off the map.
export const LANDING_PICK_GRID = 160;
const LANDING_PICK_MARGIN = 100;
export function snapLandingPoint(map, x, y) {
  const snap = (v, span) => Math.min(Math.max(Math.round(v / LANDING_PICK_GRID) * LANDING_PICK_GRID, LANDING_PICK_MARGIN), span - LANDING_PICK_MARGIN);
  return { x: snap(num(x), map.width), y: snap(num(y), map.height) };
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

// Where a jump's riders actually touch down on `dest`. In priority order:
//   1. The player's own Spaceport most recently used to LAND here (`lastLanding`, a galaxy.time
//      stamp — see below) — a return trip comes in at your own infrastructure, not the world's
//      fixed generation-time anchor, which could by now be nowhere near where you actually
//      built. Ties (never-landed-at pads) fall to the lowest id, same as every other tie-break
//      in this file.
//   2. No Spaceport stands on `dest` at all (never settled, or one stood here and was since
//      razed): there's no beacon to home in on, so the player chose an approximate spot
//      themselves (the landingPicker.js "blind minimap" screen) — `landingPoint`, already
//      fuzzed by snapLandingPoint above before it ever reaches here.
//   3. Neither — an old save, or a caller that skipped the picker: the planet's fixed
//      generation-time anchor, exactly today's (pre-this-feature) behaviour.
function landingZone(dest, landingPoint) {
  const pads = playerSpaceports(dest);
  if (pads.length) {
    let best = pads[0];
    for (const p of pads) if ((p.lastLanding || 0) > (best.lastLanding || 0)) best = p;
    return { x: best.x, y: best.y, pad: best };
  }
  if (landingPoint && Number.isFinite(landingPoint.x) && Number.isFinite(landingPoint.y)) {
    const p = snapLandingPoint(dest.map, landingPoint.x, landingPoint.y);
    return { x: p.x, y: p.y, pad: null };
  }
  return { x: dest.map.bases.player.x, y: dest.map.bases.player.y, pad: null };
}

// Launch an interplanetary jump to `destId`: player units move to the destination's landing
// zone along with the cargo hold. NO deployed base moves — the origin keeps ALL its buildings
// and becomes a background colony. Costs fuel only for a NEW world (jumpCost); returning to a
// held world is free.
//
// Two modes:
//   • With a Spaceport HERE — the normal launch: the capacity-capped expedition staged near the
//     pad (a colony ship to settle, an army to reinforce, or nothing) rides along.
//   • WITHOUT a Spaceport, falling back to a world you ALREADY HOLD — a pure CONTROL SWITCH that
//     moves NO units: with no launch pad there's no way to load a fleet, so the force you left on
//     this world STAYS PUT. This is the catch-22 escape (hop back to a base to fetch a colony
//     ship) WITHOUT dragging a garrison home — you bring the ship to the stranded force, not the
//     force back. To actually ferry units off a world, build a Spaceport there. See canJumpTo.
//
// `opts.landingPoint` (world coords) is consulted ONLY when `dest` has no player Spaceport of
// its own — see landingZone above. Ignored (harmlessly) whenever a pad is standing, and never
// required: every other case falls back cleanly on its own.
//
// Returns a summary, or null if the jump can't run (no way to reach the destination, same world,
// or too poor to fuel a new-world jump).
export function jumpCapital(galaxy, destId, opts = {}) {
  const from = activeState(galaxy);
  if (destId === galaxy.activeId) return null;
  const hasSpaceport = playerSpaceports(from).length > 0;
  const canFallBack = playerFoothold(galaxy.planets.get(destId));   // a world you hold a base on
  if (!hasSpaceport && !canFallBack) return null;                   // no port here and nowhere to fall back → can't jump
  const cost = jumpCost(galaxy, destId);
  if (galaxy.credits < cost) return null;

  // A Spaceport (or several — every completed pad's staged units ride, not just one) → the
  // combined capacity-capped expedition. No Spaceport (a fallback) → nothing rides: a control
  // switch that leaves every unit on this world where it is.
  let riders = [], leftBehind = 0;
  if (hasSpaceport) ({ riders, leftBehind } = jumpManifestAll(from));
  galaxy.credits -= cost;   // fuel — free to a world you already hold

  const dest = galaxy.planets.get(destId) || addPlanet(galaxy, destId, { unsettled: true });
  const { x: lzx, y: lzy, pad } = landingZone(dest, opts.landingPoint);
  const nextId = () => "g" + (galaxy.entitySeq = (galaxy.entitySeq || 0) + 1);   // fresh ids: no cross-state collision

  riders.forEach((u, i) => {
    from.units.delete(u.id);
    const a = (i / Math.max(1, riders.length)) * Math.PI * 2, ring = 46 + (i % 3) * 18;
    u.id = nextId(); u.x = lzx + Math.cos(a) * ring; u.y = lzy + Math.sin(a) * ring;
    u.order = null; u.orderQueue = [];
    dest.units.set(u.id, u);
  });
  // Remember this pad for the NEXT return trip (landingZone above prefers whichever pad has
  // the highest `lastLanding`). Only worth stamping when riders actually landed — an empty
  // control-switch hop (see the file header comment) doesn't touch anything here.
  if (pad && riders.length) pad.lastLanding = galaxy.time || 0;

  const cargo = loadCargo(from, dest, riders);   // deliver each staged freighter's hold — hand-loaded only

  from.selection = []; dest.selection = [];
  from.background = true;    // the world you left keeps evolving on its own
  dest.background = false;   // the destination is now your active seat
  galaxy.activeId = destId;
  (galaxy.discovered || (galaxy.discovered = new Set())).add(destId);   // now REACHED — a free return-jump, and it shows on the starmap
  updateFog(dest, dest.fog, "player");
  updateFog(dest, dest.fogAI, "ai");
  updateFog(from, from.fog, "player");
  return { destId, riders: riders.length, leftBehind, cargo };   // leftBehind: staged units the pad couldn't fit this trip
}
