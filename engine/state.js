// @ts-check
/* ============================================================
   Game state: the mutable simulation world. No rendering, no input,
   no DOM — engine/sim.js mutates this each fixed tick, render.js only
   reads it. Core shapes (State/Unit/Building/…) are defined in
   engine/types.js; this file is `// @ts-check`ed against them.
   ============================================================ */

"use strict";

import { generateMap } from "./map.js";
import { BUILDINGS, UNITS } from "./entities.js";
import { createFog, updateFog } from "./fog.js";
import { archetypeFor, ARCHETYPES } from "./aiArchetypes.js";
import { difficultyFor } from "./aiDifficulty.js";
import { attachControllerAliases } from "./controllers.js";

// Entity-id counter (ADR-0011, TASKS.md T-016 — "Fix B1"). Each state carries its OWN counter,
// state.nextEntityId, reset to 1 by createGameState (below): a fresh game is a pure function of
// its seed, so two same-seed runs mint the same ids, and since ids feed the deterministic
// tie-breaks in movement/separation/gather, the whole sim replays identically. Being PER-STATE
// (not a single shared global) is what makes that true even when a second, unrelated match's
// state is alive in the same process at the same time — the B1 defect this used to have: a single
// module-global counter meant two live matches interleaving their id-minting (or one match's
// createGameState resetting it mid-stream under another) could mint colliding ids, corrupting
// both. See docs/analysis/02-command-wire-protocol.md §8 B1 for the fuller audit.
//
// `nextEntityId` below still exists, but demoted to a LEGACY watermark for the one case a
// per-state counter can't reach: a caller with no live State to hand in at all — almost entirely
// this repo's own test fixtures (every REAL minting path — seedPlayer, issueBuild, production,
// colony deploy/pack, the galaxy relief spawn — is threaded; see each call site). createGameState
// still resets it to 1_000_000 (not 1), same as it always reset the old shared counter to 1: a
// fresh game is still a pure function of its seed, only now offset into a range no real match's
// own state.nextEntityId ever reaches.
//
// That huge offset is the fix for a real bug an earlier version of this design had: nudging the
// watermark forward to merely "stay at or above" a state's own counter still let the two draw
// from the SAME numbers. A test building a fixture unit right after createGameState (watermark
// and state.nextEntityId freshly equal, having both just advanced through seedPlayer together)
// would mint the watermark's NEXT number — and the state's own NEXT threaded mint, unaware
// anything had been drawn from underneath it, would mint that identical number right back,
// silently overwriting the fixture in state.units/buildings. A million-wide gap between the two
// ranges makes that impossible by construction instead of by careful bookkeeping: neither range
// can ever reach into the other's, so a bare mint on one side can never collide with a threaded
// mint on the other, regardless of interleaving order — the exact property "nudge forward" was
// trying, and failing, to guarantee. This makes overlap categorically unreachable for anything
// this repo will ever actually simulate, not merely made unlikely.
let nextEntityId = 1000000;
/**
 * @param {string} prefix
 * @param {State} [state] - when given, mints from THIS state's own counter; omitted, mints from
 *   the legacy watermark's disjoint range instead (see the header comment above for why that's
 *   safe to mix with threaded mints on the very same state).
 */
function newId(prefix, state) {
  if (state) return `${prefix}${state.nextEntityId++}`;
  return `${prefix}${nextEntityId++}`;
}

// Save/load (engine/persist.js) needs to snapshot and restore the LEGACY watermark so a loaded
// game's untracked/fallback mints (and engine/galaxy.js's own cross-planet bump) keep landing
// beyond every id already on disk. A loaded state's own nextEntityId is restored directly by
// engine/persist.js's rehydratePlanet (maxOwnEntityId), not through this pair.
/** @returns {number} */
export function peekEntityId() { return nextEntityId; }
/** @param {number} n */
export function restoreEntityId(n) { nextEntityId = n; }

/**
 * @param {string} type   a key of UNITS (engine/entities.js)
 * @param {string} owner  "player" | "ai"
 * @param {number} x
 * @param {number} y
 * @param {State} [state] - thread the live match through so its id lands in ITS OWN counter,
 *   not the legacy cross-process watermark (see newId's own header comment, T-016)
 * @returns {Unit}
 */
export function makeUnit(type, owner, x, y, state) {
  const def = UNITS[type];
  /** @type {Unit} */
  const u = {
    kind: "unit", id: newId("u", state), type, owner,
    x, y, hp: def.hp, maxHp: def.hp,
    order: null,          // { type: 'move'|'gather'|'attack'|'attack-move'|'build', ... } — the active order
    orderQueue: [],       // queued waypoints (Ctrl+command); sim.js pulls the next in whenever `order` clears
    cargo: def.role === "worker" ? { com: null, qty: 0 } : null,
    attackTimer: 0,
    autoTarget: null,     // sticky auto-acquired target id (combat.js) — commit to a foe, don't re-dogpile the nearest each tick
  };
  // A freighter (Odyssey cargo ship) carries `freight` — a player-managed, multi-commodity hold,
  // filled and emptied by hand at a world (engine/galaxy.js load/unloadFreighter) and shipped on a
  // jump. Named `freight`, not `hold`, to stay clear of the combat hold-stance flag (unit.hold).
  if (def.cargoHold) u.freight = {};
  return u;
}

/**
 * @param {string} type   a key of BUILDINGS (engine/entities.js)
 * @param {string} owner  "player" | "ai"
 * @param {number} x
 * @param {number} y
 * @param {{ hp?: number, constructing?: boolean }} [opts]
 * @param {State} [state] - see makeUnit's own param doc (T-016)
 * @returns {Building}
 */
export function makeBuilding(type, owner, x, y, opts = {}, state) {
  const def = BUILDINGS[type];
  return {
    kind: "building", id: newId("b", state), type, owner,
    x, y, radius: def.radius, hp: opts.hp ?? def.hp, maxHp: def.hp,
    constructing: !!opts.constructing, buildProgress: opts.constructing ? 0 : 1,
    queue: [],             // [{ unitType, progress }]
    attackTimer: 0,        // combat.js decrements this for buildings with an attack stat (turret)
    targetId: null,        // current auto-acquired target; render.js reads it to aim the turret barrel
    rally: { x: x + 60, y: y + 60 },
  };
}

/**
 * Build a fresh AI controller's runtime bookkeeping — the exact shape shared by state.ai (owner
 * "ai", always present) and state.playerAi (owner "player", present only when self-play is active
 * — see tools/selfplay.js). Kept as one factory so the two controllers can never structurally
 * drift apart; engine/ai.js's runAI(state, dt, owner) and engine/aiCommon.js's controllerFor read
 * either one the same way. Every field here matches state.ai's own inline literal below field for
 * field, in the same order, so createGameState's construction of state.ai stays byte-identical.
 * @param {string} planetId
 * @param {{ apm?: number, micro?: boolean, strategy?: string, difficulty?: string, archetype?: string }} [opts]
 */
export function createAiController(planetId, opts = {}) {
  return {
    think: 0,               // countdown to this controller's next decision pass (engine/ai.js THINK_INTERVAL)
    scoutId: null,           // the unit currently out scouting for this controller, if any
    colonyTarget: null,      // Odyssey: the committed {x,y} deploy spot of this controller's in-flight colony ship (ai.js)
    apm: opts.apm ?? null,      // actions-per-minute cap; null = unthrottled (default/tests)
    micro: opts.micro ?? false, // Tactical AI: unit-level micro (focus-fire, kiting). Off by default (and in tests).
    strategy: opts.strategy || "default",   // player-picked AI strategy (engine/aiStrategy.js) — "default" ⇒ byte-identical to today
    difficulty: opts.difficulty || "medium",  // splash-screen Easy/Medium/Hard pick (engine/aiDifficulty.js) — read via difficultyFor(state, owner)
    lastThreatAt: null,     // sim-time of the last seen threat near home — drives the Economic strategy's war-footing window (engine/ai.js)
    actionBudget: 0,         // accumulated action credits (see engine/aiCommon.js's accrueActionBudget)
    attackForce: 0,           // size of the current committed attack at its peak — drives the retreat check (ai.js)
    attackDesperate: false,   // whether the current attack is a fight-to-death timeout commit (never retreats)
    nextAttackAt: null,      // scheduled time of the next attack commit; null ⇒ use the archetype timeout
    unitsBuilt: 0,            // total combat units this controller has produced (drives its build cadence)
    waveCount: 0,             // committed-wave counter — drives the economy-raid cadence (waveCount % RAID_EVERY)
    nextWaveAt: null,        // Odyssey: scheduled time of the next offensive wave; null ⇒ wave-ready
    // OPPONENT BELIEF (engine/aiIntel.js) — ore-value of the enemy's military/economic assets as
    // far as this controller has SEEN, plus when it last saw anything. A fading high-water mark,
    // not a live read, and the first AI state that can be wrong: it is what the AI thinks, not what
    // is true, which is what makes scouting worth its cost and killing the scout a real counter.
    // Null/0 until something is actually sighted — "I have seen nothing" must stay distinguishable
    // from "I have seen an empty base" (see aiIntel's header).
    // intelMil/intelEco are PEAKS, each with its own stamp saying when it was set — the current
    // belief is that peak faded by its own elapsed time, computed at read (aiIntel.js
    // channelValue), never accumulated. Separate clocks because a worker still in view refreshes
    // what the AI knows about the economy and nothing about the army that left.
    intelMil: 0, intelMilAt: null, intelEco: 0, intelEcoAt: null,
    // …and intelAt answers the different question confidence needs: when did it last see the
    // enemy at all. Null until something is actually sighted.
    intelAt: null,
    // The damped STANCE derived from that belief (engine/aiIntel.js updateAdaptMode): 0 = the
    // enemy is playing economy, 1 = they are massing, 0.5 = no opinion. Null until a first think
    // cycle sets it, and pinned at neutral forever on Easy (adaptivity 0).
    adaptMode: null,
    // This world's opponent temperament (engine/aiArchetypes.js) — UNLESS opts.archetype names a
    // real ARCHETYPES key, in which case that per-entrant pick wins instead (docs/
    // competitions-and-elo.md D3: a competition entrant carries its own doctrine, so "Rusher vs
    // Turtle" is a real matchup rather than both seats sharing whatever temperament the world
    // hands out). opts.archetype is a STRING KEY, never an archetype object — the caller names a
    // doctrine, this resolves it, mirroring archetypeFor's own ARCHETYPES[key] lookup. Absent, or
    // naming a key that isn't in ARCHETYPES, falls back to archetypeFor(planetId) exactly as
    // before this option existed — byte-identical for every call site today, none of which pass
    // opts.archetype yet. Object.hasOwn, not a truthy `ARCHETYPES[opts.archetype]` bracket-access:
    // a plain object's inherited keys (e.g. "constructor") or the specially-handled "__proto__"
    // accessor would otherwise resolve to something that isn't a real archetype at all — this
    // module has no user-facing input today (the only two callers, competitionLedger.js's roster
    // guard and the Archetype picker, already restrict to real keys), but this is an exported,
    // reusable function and should refuse a hostile/reserved key on its own rather than depend on
    // every future caller re-deriving that guard.
    archetype: (typeof opts.archetype === "string" && Object.hasOwn(ARCHETYPES, opts.archetype))
      ? ARCHETYPES[opts.archetype] : archetypeFor(planetId),
  };
}

/**
 * Build a fresh simulation world. A pure function of its inputs (seed + options): the map
 * regenerates deterministically from the seed, so two same-option runs are identical.
 * @param {{ planetId?: string, rng?: () => number, seed?: number, sizeMult?: number,
 *   resourceMult?: number, swapAsym?: boolean, matchTimeLimit?: number, popCap?: number, endless?: boolean,
 *   aiApm?: number, aiMicro?: boolean, aiEnabled?: boolean,
 *   aiStrategy?: string, difficulty?: string, aiArchetype?: string, playerFaction?: string, aiFaction?: string,
 *   ownerDefs?: {id: string, faction: string, isAI: boolean, color: string, aiOpts?: Object}[],
 *   basePositions?: Object.<string, {x: number, y: number}> }} [opts]
 *   ownerDefs (T-041): a caller-supplied N-entry side list, replacing the default ["player","ai"]
 *   pair wholesale — omitted (every caller today), byte-identical to before. Each entry's own
 *   `aiOpts` (T-042, default {}) is forwarded to createAiController for that owner when isAI is
 *   true — the createGameState-level shortcuts (aiApm/aiMicro/aiStrategy/difficulty/aiArchetype)
 *   only ever apply to the DEFAULT pair, exactly like playerFaction/aiFaction already do.
 *   basePositions: a per-owner start-position override, consulted before map.bases. T-044's own
 *   generateRadialMap now gives every owner (2 or N) a real position, so this is no longer a
 *   stopgap for a gap in the generator — it stays as a genuine override seam (a caller placing a
 *   seat somewhere the generator wouldn't, e.g. a hand-built test fixture).
 * @returns {State}
 */
export function createGameState(opts = {}) {
  // Reset the LEGACY watermark too, not just state.nextEntityId below — countless test fixtures
  // mint a bare, untracked entity right after createGameState and expect that to be exactly as
  // reproducible across two same-seed runs as everything else. That stays true here: nothing in
  // THIS state's own construction reads the watermark for its own ids (seedPlayer is fully
  // state-threaded below), so resetting it can't perturb state.nextEntityId's sequence — and the
  // watermark's own million-wide offset (see its declaration above) means it can never collide
  // with that sequence either, in any interleaving, reset or not.
  nextEntityId = 1000000;
  const planetId = opts.planetId || "ferros";

  // The sides in this world. Today almost always exactly the human "player" and the AI
  // opponent, but the SCAFFOLD is owner-generic: state.owners is the canonical
  // side list, and the player map, per-owner fog, seeding, persistence and the
  // victory check are all driven by ITERATING it — not by two hardcoded names.
  // So a future N-faction world is a change to this list, not a sweep across the
  // engine. (state.fog / state.fogAI stay as aliases into state.fogs so the many
  // existing fog consumers keep working unchanged.)
  //
  // T-041 (FR-1): opts.ownerDefs lets a caller supply its own N-entry list — omitted (every
  // existing caller), this is byte-identical to the literal 2-entry pair it always was, so
  // playerFaction/aiFaction keep meaning exactly what they always did. Once a caller passes its
  // own ownerDefs, those two shortcut opts are simply never consulted (the caller's own entries
  // already carry `faction` per owner) — the more detailed config wins, not both at once.
  //
  // Computed BEFORE generateMap (T-044) so the map generator itself can see the real owner
  // roster — 2 ids dispatches to its own byte-identical mirrored path (just keyed by whatever
  // those 2 ids are), 3+ to the new radial generator (engine/map.js's own generateRadialMap).
  const ownerDefs = opts.ownerDefs || [
    // Faction is a passive-trait bundle (engine/factions.js). It defaults to
    // "neutral" (no traits) so a bare createGameState — every engine test —
    // behaves exactly as before; the setup screen (main.js) passes the real
    // pick for the player and the archetype's faction for the AI.
    { id: "player", faction: opts.playerFaction || "neutral", isAI: false, color: "#4fd1ff" },
    { id: "ai", faction: opts.aiFaction || "neutral", isAI: true, color: "#f87171" },
  ];
  const owners = ownerDefs.map(d => d.id);

  // The one sanctioned fallback: an UNSEEDED caller (a direct test, or a call
  // that predates seeding) uses the platform PRNG for map generation only.
  // Production always passes a seeded rng (see main.js), so this branch never
  // runs in a real match — the engine-purity guard whitelists the marked line.
  const map = generateMap(planetId, opts.rng || Math.random, {   // deterministic-exempt: unseeded default rng
    sizeMult: opts.sizeMult || 1,
    resourceMult: opts.resourceMult || 1,
    swapAsym: !!opts.swapAsym,
    owners,
  });

  /** @type {Object.<string, Player>} */
  const players = {};
  for (const d of ownerDefs)
    players[d.id] = { id: d.id, faction: d.faction, isAI: d.isAI, resources: startingResources(), color: d.color, upgrades: {} };
  /** @type {Object.<string, Fog>} */
  const fogs = {};
  for (const id of owners) fogs[id] = createFog(map);   // one fog grid per side — the AI scouts for its own intel too (engine/ai.js)

  // T-042 (ADR-0008): state.controllers{} — the real, N-capable registry engine/controllers.js's
  // controllerFor reads by owner id. The DEFAULT ownerDefs (every existing caller) builds it with
  // the EXACT SAME two expressions this always used, so it's byte-identical to before; a caller's
  // OWN ownerDefs (T-041) is, like playerFaction/aiFaction themselves, a more detailed config that
  // wins outright — aiEnabled/aiApm/aiMicro/aiStrategy/difficulty/aiArchetype are then simply never
  // consulted, and each entry's own optional `aiOpts` (default {}) decides that owner's controller.
  /** @type {Object.<string, AiState|null>} */
  const controllers = {};
  if (opts.ownerDefs) {
    for (const d of ownerDefs) controllers[d.id] = d.isAI ? createAiController(planetId, d.aiOpts || {}) : null;
  } else {
    controllers.player = null;
    // opts.aiEnabled (default true): false is the T-034a seam — the moment a real match can put a
    // human on seat "ai" (a lobby join, not self-play's separate playerAi slot), the "ai" controller
    // must be able to stay null so isHumanControlled(state,"ai") is true and engine/sim.js's tick()
    // stops calling runAI for "ai" — exactly the null a fresh "player" controller already models.
    // Every existing caller leaves this unset, so this stays exactly as populated as before.
    controllers.ai = opts.aiEnabled === false ? null : createAiController(planetId, {
      apm: opts.aiApm, micro: opts.aiMicro, strategy: opts.aiStrategy, difficulty: opts.difficulty,
      // docs/competitions-and-elo.md D3, one layer up from createAiController's own opts.archetype
      // (which this just forwards verbatim, including its own null/unknown-key fallback to
      // archetypeFor(planetId)) — absent on every call site before this stage, so byte-identical
      // until a caller actually passes it (Quick Duel's own per-entrant archetype pick, via
      // tools/duelCore.js's runDuelMatch -> tools/selfplay.js's createSelfPlayState -> here).
      archetype: opts.aiArchetype,
    });
  }

  const state = {
    time: 0,
    tick: 0,
    nextEntityId: 1,   // this match's OWN counter (T-016) — see newId's header comment
    over: false,
    winner: null,
    winReason: null,   // set by engine/victory.js finish() — why the match ended, once it does
    seed: opts.seed ?? null,   // the match seed, if one was supplied — reproduces this whole game
    // The generation inputs, kept so a save can regenerate the (deterministic)
    // map from the seed instead of serialising the whole terrain/node table.
    planetId,
    sizeMult: opts.sizeMult || 1,
    resourceMult: opts.resourceMult || 1,
    // Pick your side of an asymmetric matchup (Oort, Nimbus, engine/map.js): additive, next to
    // sizeMult/resourceMult — a generation input kept so a save can regenerate the map with the
    // same swap honored, not just replay the bare boolean. Defaults false (unswapped, today's
    // long-standing assignment).
    swapAsym: !!opts.swapAsym,
    // setup.js's Match length row (Quick 20 / Standard 40 / Marathon 60 — never "unlimited"):
    // an explicit override of engine/victory.js's DEFAULT_MATCH_TIME_LIMIT, in seconds. Defaults
    // to null (not DEFAULT_MATCH_TIME_LIMIT's own 2400) so checkWinCondition's own `??` fallback
    // stays the single source of truth for "no override requested" — this field only ever carries
    // a REAL, deliberately-chosen override, never a copy of the default it would fall back to
    // anyway.
    matchTimeLimit: opts.matchTimeLimit ?? null,
    // setup.js's Population cap row (200 / 250 / 300 / Max): a hard ceiling supplyCap
    // (engine/supply.js) clamps the building-derived total to, shared by both owners alike (it's
    // a match rule, not a per-side or AI-temperament dial like difficulty/aiStrategy — see
    // engine/state.js's `ai:` block below for that distinction). Defaults to null — Max, i.e.
    // today's always-uncapped-by-anything-but-buildings behaviour, byte-identical to before this
    // setting existed.
    popCap: opts.popCap ?? null,
    // Odyssey (open-world) mode: no skirmish victory — the match never ends by
    // razing the enemy, only when the player loses their single Command Center
    // (see engine/victory.js checkEndlessLoss + engine/galaxy.js).
    endless: !!opts.endless,
    map,
    owners,                 // the world's side ids, in canonical iteration order (["player","ai"])
    players,
    units: new Map(),
    buildings: new Map(),
    selection: [],          // unit/building ids currently selected by the human player
    fogs,                   // per-owner fog of war, keyed by owner id — see engine/fog.js
    fog: fogs.player,       // alias: the human player's fog (=== state.fogs.player)
    fogAI: fogs.ai,         // alias: the AI's own fog, no longer omniscient (=== state.fogs.ai)
    // T-042: the real, N-capable registry (built above) — state.ai/state.playerAi become live
    // accessor aliases into controllers.ai/controllers.player right after this object literal
    // closes (attachControllerAliases below), so every existing reader/writer of the old two names
    // keeps working completely unchanged.
    controllers,
    events: [],              // sim events this tick (unitSpawned/attackHit/entityKilled/buildingComplete) — pushed by
                              // production.js/combat.js, drained and turned into sound by main.js each render frame
    craters: [],              // pending Helium Bomb craters awaiting maturity into a real node (engine/bomb.js)
    wrecks: [],                // pending battle-wreckage sites awaiting maturity into real nodes (engine/wreckage.js)
  };
  attachControllerAliases(state);

  // Seed each side's opening (a colony ship in Odyssey, a Command Center + workers in
  // skirmish) and prime its vision before the first render — both by iterating owners,
  // so the id-minting order and fog state are byte-identical to the old player-then-ai
  // pair. map.bases is keyed by owner id (engine/map.js).
  //
  // T-041: opts.basePositions is an explicit per-owner override, consulted FIRST — the map
  // generator itself still only ever produces "player"/"ai" (a real N-position generator is
  // T-044's own, later job); this is a deliberate stopgap so a caller with its own ownerDefs can
  // supply where the extra owners start, without this file needing any map-generation logic of
  // its own. Every existing caller leaves it unset, so map.bases[id] alone decides, exactly as
  // before this option existed.
  for (const id of owners) seedPlayer(state, id, (opts.basePositions && opts.basePositions[id]) || map.bases[id]);
  for (const id of owners) updateFog(state, state.fogs[id], id);

  // Hard difficulty's economic edge (engine/aiDifficulty.js): seed the synthetic hardEdge
  // upgrade (entities.js) straight onto the AI's own upgrades, once, at creation — never
  // researched, so it needs no Refinery/Datacenter and survives save/load via the ordinary
  // player.upgrades round-trip (engine/persist.js) with no special-casing. state.playerAi is
  // always null at this point (Tier 1 self-play populates it AFTER createGameState returns — see
  // tools/selfplay.js), so seedDifficultyEdge(state, "player") only ever fires there, once
  // self-play has actually configured a difficulty for it — see that call site.
  seedDifficultyEdge(state, "ai");

  return state;
}

/**
 * Seed Hard difficulty's synthetic `hardEdge` economic-edge upgrade (engine/aiDifficulty.js
 * economicEdge — +10% gather yield, -10% production time) onto `owner`'s own upgrades, once, if
 * that owner's OWN configured difficulty (difficultyFor(state, owner)) grants it. Exported so a
 * caller can apply the exact same rule to a second controller after the fact — Tier 1 self-play
 * (tools/selfplay.js's createSelfPlayState) populates state.playerAi only AFTER createGameState
 * has already returned, so owner "player" can never be seeded inline above; without this, a
 * self-play "player" controller configured with Hard difficulty would fight at a permanent,
 * un-researchable economic disadvantage against a Hard "ai" — the fairness guarantee (independent
 * fog, independent action budgets, no double-spend) this whole tier otherwise holds to. A no-op
 * for any owner whose difficulty doesn't grant the edge (Easy/Medium, or no controller at all yet
 * — difficultyFor falls back to Medium's defaults either way).
 * @param {State} state
 * @param {string} owner
 */
export function seedDifficultyEdge(state, owner) {
  if (difficultyFor(state, owner).economicEdge) state.players[owner].upgrades.hardEdge = true;
}

/** @returns {Resources} */
function startingResources() {
  return { ore: 300, crystals: 0, radioactives: 0 };
}

/**
 * @param {State} state
 * @param {string} ownerId
 * @param {{ x: number, y: number }} basePos
 */
function seedPlayer(state, ownerId, basePos) {
  if (state.endless) {
    // Odyssey: both sides START with a mobile colony ship instead of a built base —
    // deploy it (engine/colony.js) to found the first Command Center; the colonists
    // (opening workers) disembark then. Seeding workers now would strand them: with
    // no drop-off yet they can't bank ore (engine/gather.js).
    const ship = makeUnit("colonyship", ownerId, basePos.x, basePos.y, state);
    state.units.set(ship.id, ship);
    return;
  }
  // Skirmish — BYTE-IDENTICAL to before: a finished Command Center + 3 workers.
  const cc = makeBuilding("command", ownerId, basePos.x, basePos.y, {}, state);
  state.buildings.set(cc.id, cc);
  for (let i = 0; i < 3; i++) {
    const w = makeUnit("worker", ownerId, basePos.x + 40 + i * 14, basePos.y + 40, state);
    state.units.set(w.id, w);
  }
}

/**
 * @param {State} state
 * @param {string} id
 * @returns {Unit|Building|undefined}
 */
export function getEntity(state, id) {
  return state.units.get(id) || state.buildings.get(id);
}

/**
 * @param {State} state
 * @param {string} id
 */
export function removeEntity(state, id) {
  state.units.delete(id) || state.buildings.delete(id);
  state.selection = state.selection.filter(sid => sid !== id);
}

/**
 * @param {State} state
 * @param {string} owner
 * @returns {Building[]}
 */
export function playerBuildings(state, owner) {
  return [...state.buildings.values()].filter(b => b.owner === owner);
}

/**
 * @param {State} state
 * @param {string} owner
 * @returns {Unit[]}
 */
export function playerUnits(state, owner) {
  return [...state.units.values()].filter(u => u.owner === owner);
}
