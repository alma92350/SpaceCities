// @ts-check
/* ============================================================
   Save / load. Because the sim is deterministic and seed-driven (see
   engine/rng.js), a save doesn't need the whole world — the map (terrain,
   node positions) regenerates from the seed, so we persist only the seed +
   the DYNAMIC state: entities, economies, fog memory, and the AI's bookkeeping.
   The per-planet payload (serPlanet / rehydratePlanet) is shared by two savers:
   a single skirmish (serializeGame) and a whole Odyssey galaxy of N planets
   (serializeGalaxy), which additionally carries each world's market pressure,
   diplomacy stance, and colony flag, plus the galaxy meta (credits, active
   world, schedule counter). Round-trip and continue-identically are covered by
   test/persist.test.js and test/odyssey.test.js.
   ============================================================ */

"use strict";

import { generateMap } from "./map.js";
import { mulberry32 } from "./rng.js";
import { createFog, updateFog } from "./fog.js";
import { archetypeFor } from "./aiArchetypes.js";
import { CRATER_NODE_AMOUNT } from "./bomb.js";
import { WRECK_SPAWN_DELAY } from "./wreckage.js";
import { LOGI_PRIORITIES } from "./haul.js";   // the enum a building's logiPriority (below) is coerced against
// peekEntityId/restoreEntityId (called at ~4 sites below: gamePayload, deserializeGame,
// galaxyPayload, deserializeGalaxy) read and overwrite `nextEntityId` in engine/state.js — a
// SINGLE module-global counter, not per-state. Reading it (peek, on save) is safe any time, but
// writing it (restore, on load) stomps whatever value newId()/createGameState was mid-using, so a
// restoreEntityId() must never race or interleave with another id-minting call (newId, or another
// save/load) — e.g. don't deserialize a save while a tick that mints ids is in flight, and don't
// load two saves concurrently. Single-threaded JS makes this safe as long as callers don't
// interleave async id-minting work around these calls; see the "module-global" note on
// nextEntityId in engine/state.js and test/save-hardening.test.js's freshSkirmishSave helper.
import { peekEntityId, restoreEntityId } from "./state.js";
import { createMarket, PRESSURE_FLOOR, PRESSURE_CEIL, GLUT_CEIL } from "./market.js";
import { createDiplomacy } from "./diplomacy.js";
import { STRATEGIES } from "./aiStrategy.js";
import { DIFFICULTY_OPTIONS } from "./aiDifficulty.js";
import { UNITS, BUILDINGS, UPGRADES, storeCapOf, inputCapOf } from "./entities.js";
import { TECHS } from "./techtree.js";   // known research nodes — to sanitise a Datacenter's untrusted researchQueue on load
import { COM } from "../data.js";
import { ODYSSEY_WORLDS, isMilestoneId } from "./galaxy.js";
import { sanitizePolicy } from "./colonyPolicy.js";

export const SAVE_VERSION = 1;
export const GALAXY_SAVE_VERSION = 1;

// --- load-time sanitization -------------------------------------------------
// A save loaded from a file or localStorage is UNTRUSTED input (a user can hand-edit a file, and
// localStorage is reachable by any script/devtools). The sim never eval()s save data, so there's
// no classic code-injection vector — but a hostile or corrupt payload could still (a) smuggle a
// prototype-polluting key (__proto__/constructor/prototype — JSON.parse makes these OWN props that
// can poison later object ops) or (b) be a node/string/depth "bomb" that hangs the load. So before
// a parsed save reaches the deserializer we walk it and reject anything that isn't plain, bounded
// JSON data. Correctness (version, shape) is still the deserializer's job; this is purely the
// safety gate. Throws with a clear reason; returns the input so it can be chained.
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_SAVE_NODES = 600000;   // total values — a whole galaxy is well under this; a bomb isn't
const MAX_SAVE_DEPTH = 200;
const MAX_STRING_LEN = 4096;

/** Structural gate over untrusted save data. @param {*} input @returns {Object} */
export function sanitizeSave(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new Error("save is not a valid object");
  let nodes = 0;
  const walk = (v, depth) => {
    if (depth > MAX_SAVE_DEPTH) throw new Error("save is too deeply nested");
    if (++nodes > MAX_SAVE_NODES) throw new Error("save is too large");
    if (v === null || typeof v === "number" || typeof v === "boolean") return;
    if (typeof v === "string") { if (v.length > MAX_STRING_LEN) throw new Error("save has an oversized string"); return; }
    if (Array.isArray(v)) { for (const el of v) walk(el, depth + 1); return; }
    if (typeof v === "object") {
      for (const k of Object.getOwnPropertyNames(v)) {   // getOwnPropertyNames also catches a non-enumerable __proto__
        if (FORBIDDEN_KEYS.has(k)) throw new Error(`save contains a forbidden key: ${k}`);
        walk(v[k], depth + 1);
      }
      return;
    }
    throw new Error("save contains an unsupported value");   // functions/symbols can't come from JSON, but be explicit
  };
  walk(input, 0);
  return input;
}

// --- load-time value validation --------------------------------------------
// sanitizeSave() guarantees the payload is plain, bounded JSON — but NOT that its
// values make sim sense. A version-valid save (hand-edited, or merely corrupted in
// storage) can still carry a string where a number belongs, a NaN coordinate, or an
// entity `type` that isn't a real unit/building. Those don't throw at load — they slip
// in and detonate on the FIRST tick, inside the rAF loop, AFTER load's try/catch has
// already returned success: the game boots, then silently freezes (updateUnit reads
// UNITS[type].role on an undefined def) or drifts (state.time += "100" concatenates).
// So we coerce/clamp the known numeric fields and drop entities of unknown type here,
// on the way in. Deterministic and DOM-free: a VALID save's fields are already finite
// numbers of real types, so every coercion below is the identity on them and the
// byte-identical replay guarantee (test/determinism.test.js) is untouched.
function num(v, fallback = 0) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }

// A saved price book is untrusted like everything else here. Overlay ONLY real commodity keys, and
// only inside the band applySlippage keeps them in at runtime — the load path used to Object.assign
// the saved object straight over the fresh one, so a hand-edited (or bit-rotted) pressure of 1e6 was
// a 5,000,005-credit sale, a negative one made selling lose credits, and a string turned
// galaxy.credits permanently NaN. Identity for a valid save: real pressures are already in band.
function coerceBand(dst, src, lo, hi) {
  if (!src || typeof src !== "object") return;
  for (const com in dst) {
    if (!(com in src)) continue;
    dst[com] = Math.max(lo, Math.min(num(src[com], 0), hi));
  }
}

// The per-world diplomacy block used to be restored as `{ ...createDiplomacy(), ...P.diplomacy }` —
// the untrusted object winning every key, including ones no field list mentions. The damage isn't
// hypothetical: engine/diplomacy.js's clamp() is the identity on a non-number, so the drift line
// string-CONCATENATES a non-numeric stance ~3 chars per diplomacy tick. Within ~160 sim-seconds it
// exceeds sanitizeSave's own MAX_STRING_LEN, and since autosave rotates BOTH generations, the game's
// own saves become permanently unloadable and the campaign is gone. Whitelist + coerce instead, the
// same shape cleanPlayer already uses. `request` keeps its existing deeper validation at the call site.
// The galaxy's own settings are untrusted too, and they are the one block that flows into WORLD
// GENERATION: addPlanet passes sizeMult/resourceMult straight to createGameState, so a NaN or a
// string there builds a NaN-sized map on the next jump — which then defeats every coordinate clamp
// cleanEntity performs, since those clamp against map.width/height. A missing block used to throw
// mid-jump on s.difficulty. Same shape rehydratePlanet already uses for its own multipliers.
function cleanGalaxySettings(src) {
  const s = (src && typeof src === "object") ? src : {};
  const difficulty = DIFFICULTY_OPTIONS.some(o => o.mult === s.difficulty) ? s.difficulty : "medium";
  const strategy = KNOWN_STRATEGIES.has(s.aiStrategy) ? s.aiStrategy : undefined;
  return {
    difficulty,
    sizeMult: Math.max(0.1, num(s.sizeMult, 1)),
    resourceMult: Math.max(0.1, num(s.resourceMult, 1)),
    playerFaction: typeof s.playerFaction === "string" ? s.playerFaction : "frontier",
    aiApm: s.aiApm == null ? undefined : num(s.aiApm, 0),
    aiMicro: s.aiMicro == null ? undefined : !!s.aiMicro,
    aiStrategy: strategy,
    startId: ODYSSEY_WORLDS.includes(s.startId) ? s.startId : undefined,
    popCap: s.popCap == null ? null : Math.max(0, num(s.popCap, 0)),
  };
}

function cleanDiplomacy(src) {
  const dip = createDiplomacy();
  if (!src || typeof src !== "object") return dip;
  dip.stance = Math.max(-1, Math.min(num(src.stance, dip.stance), 1));
  dip.depletion = Math.max(0, Math.min(num(src.depletion, 0), 1));
  dip.tributes = Math.max(0, Math.floor(num(src.tributes, 0)));
  dip.goodwill = num(src.goodwill, 0);
  dip.lastFavorBucket = Math.floor(num(src.lastFavorBucket, -1));
  dip.provokedAt = src.provokedAt == null ? null : num(src.provokedAt, 0);
  dip.request = (src.request && typeof src.request === "object") ? src.request : null;
  if (src.lastAiUnits !== undefined) dip.lastAiUnits = Math.max(0, num(src.lastAiUnits, 0));
  if (src.appeaseUntil !== undefined) dip.appeaseUntil = num(src.appeaseUntil, 0);
  if (src.factionEchoUntil !== undefined) dip.factionEchoUntil = num(src.factionEchoUntil, 0);
  if (src.factionWarmth !== undefined) dip.factionWarmth = Math.max(0, num(src.factionWarmth, 0));
  // Only ADOPT a flag the save actually carries. Unconditionally stamping `pacified: false` would
  // add a key to the payload that wasn't there before, which the NET round-trip tests correctly
  // reject: a hardening pass must be the identity on a valid save, byte for byte.
  if (src.pacified !== undefined) dip.pacified = !!src.pacified;
  if (src.warAnnounced !== undefined) dip.warAnnounced = !!src.warAnnounced;
  return dip;
}

// Both AI controllers (state.ai, state.playerAi) restore through this ONE function, so the promise
// two comments below — that the two blocks can never structurally drift — is enforced by
// construction rather than by hand-typing fifteen fields twice. Every value is coerced: the block
// used to be copied verbatim, and `nextAttackAt: "later"` makes `state.time >= nextAttackAt` false
// forever, permanently disabling the AI's attack timeout with no crash and no test.
const KNOWN_STRATEGIES = new Set(Object.keys(STRATEGIES));
const KNOWN_DIFFICULTIES = new Set(DIFFICULTY_OPTIONS.map(o => o.mult));
function cleanController(src, prefix, planetId) {
  const g = key => src ? src[prefix + key] : undefined;
  const strategy = g("Strategy");
  const difficulty = g("Difficulty");
  const target = g("ColonyTarget");
  return {
    think: num(g("Think"), 0),
    scoutId: typeof g("ScoutId") === "string" ? g("ScoutId") : null,
    colonyTarget: (target && typeof target === "object" && Number.isFinite(Number(target.x)) && Number.isFinite(Number(target.y)))
      ? { x: num(target.x, 0), y: num(target.y, 0) } : null,
    apm: g("Apm") == null ? null : num(g("Apm"), 0),
    micro: !!g("Micro"),
    strategy: KNOWN_STRATEGIES.has(strategy) ? strategy : "default",
    difficulty: KNOWN_DIFFICULTIES.has(difficulty) ? difficulty : "medium",
    lastThreatAt: g("LastThreatAt") == null ? null : num(g("LastThreatAt"), 0),
    actionBudget: num(g("ActionBudget"), 0),
    attackForce: Math.max(0, num(g("AttackForce"), 0)),
    attackDesperate: !!g("AttackDesperate"),
    nextAttackAt: g("NextAttackAt") == null ? null : num(g("NextAttackAt"), 0),
    unitsBuilt: Math.max(0, Math.floor(num(g("UnitsBuilt"), 0))),
    waveCount: Math.max(0, Math.floor(num(g("WaveCount"), 0))),
    nextWaveAt: g("NextWaveAt") == null ? undefined : num(g("NextWaveAt"), 0),
    // Opponent belief (engine/aiIntel.js). Additive and defaulted the same conservative way
    // LastThreatAt is: an old save without these loads as "never seen anything", so a reloaded AI
    // starts honestly blind and goes scouting rather than acting on intel it cannot justify.
    // Clamped at 0 because a negative asset value is meaningless and would invert posture.
    // intelMil/intelEco are PEAKS; each carries its own stamp. A save written before the
    // per-channel stamps existed has neither, and loads with both null — aiIntel.js's channelValue
    // falls back to the shared IntelAt in exactly that case, which is the closest true statement
    // the old data supports. Still purely additive, so no SAVE_VERSION bump (CONTRIBUTING §3).
    intelMil: Math.max(0, num(g("IntelMil"), 0)),
    intelMilAt: g("IntelMilAt") == null ? null : num(g("IntelMilAt"), 0),
    intelEco: Math.max(0, num(g("IntelEco"), 0)),
    intelEcoAt: g("IntelEcoAt") == null ? null : num(g("IntelEcoAt"), 0),
    intelAt: g("IntelAt") == null ? null : num(g("IntelAt"), 0),
    // Clamped to the 0..1 the stance is defined on, so a corrupt save cannot push the AI into a
    // defence multiplier outside its designed swing.
    adaptMode: g("AdaptMode") == null ? null : Math.min(1, Math.max(0, num(g("AdaptMode"), 0.5))),
    archetype: archetypeFor(planetId),
  };
}

// Coerce one entity's numeric fields to finite values, defaulting hp/maxHp from its
// def and clamping coordinates into the map so a bad value can never poison the spatial
// hash (NaN,NaN buckets) or the hp accounting (an un-killable NaN-hp ghost).
function cleanEntity(e, def, map) {
  const maxHp = num(e.maxHp, def.hp);
  e.maxHp = maxHp > 0 ? maxHp : def.hp;
  e.hp = Math.max(0, Math.min(num(e.hp, e.maxHp), e.maxHp));
  e.x = Math.max(0, Math.min(num(e.x, 0), map.width));
  e.y = Math.max(0, Math.min(num(e.y, 0), map.height));
  // An order (and each queued waypoint) can carry target x/y coords that a tampered save could set to
  // NaN/huge/non-numeric garbage — which then flow straight into stepToward as the move destination
  // and NaN the unit's position (engine/sim.js, engine/combat.js), permanently poisoning the spatial
  // hash. Clamp any x/y an order carries the SAME way as the unit's own x/y; orders without coords
  // (gather/build/scout/attack-by-id) and a null/absent order are left untouched — identity for valid.
  const clampOrderCoords = o => {
    if (!o || typeof o !== "object") return;
    if (o.x !== undefined) o.x = Math.max(0, Math.min(num(o.x, 0), map.width));
    if (o.y !== undefined) o.y = Math.max(0, Math.min(num(o.y, 0), map.height));
  };
  clampOrderCoords(e.order);
  if (Array.isArray(e.orderQueue)) for (const o of e.orderQueue) clampOrderCoords(o);
  // A building's `rally` is the one coordinate pair this function used to skip, and it flows to
  // exactly the same place the order coords do: engine/production.js spawns every produced unit with
  // `order = { type:"move", x: rally.x, y: rally.y }`. movement.js rejects NaN but not a large FINITE
  // value, so a tampered 1e9 rally sent every unit the building made walking off the map forever,
  // outside every fog and grid bound. Same clamp, plus dropping a non-string nodeId before it reaches
  // the rally-to-resource node lookup.
  if (e.rally && typeof e.rally === "object") {
    clampOrderCoords(e.rally);
    if (e.rally.nodeId !== undefined && typeof e.rally.nodeId !== "string") e.rally.nodeId = null;
  }
  // A worker's `cargo` hold ({com, qty}) is untrusted too: coerce its qty to a finite value >= 0 (a
  // NaN/negative haul would poison the gather/haul/bank math on the first tick), and DROP the whole
  // cargo (→ null) when it isn't an object or names a bogus commodity — a `com` outside COM would
  // become a phantom treasury key the moment it's banked. An EMPTY hold (com:null) is the valid
  // resting state of every worker, so it's kept; a non-worker's cargo is already null and is left as
  // is. Identity for valid data.
  if (e.cargo !== undefined && e.cargo !== null) {
    if (typeof e.cargo !== "object" || (e.cargo.com != null && !COM[e.cargo.com])) e.cargo = null;
    else e.cargo.qty = Math.max(0, num(e.cargo.qty, 0));
  }
  // A freighter's `freight` hold is untrusted save data (a hand-edited file could smuggle in a
  // negative, NaN, or over-capacity haul, or a bogus commodity): keep only real commodities with a
  // positive finite qty, and clamp the total to the ship's cargoHold. A non-freighter can't carry
  // freight at all, so strip any that a tampered save bolted on.
  if (def.cargoHold) {
    const clean = {};
    let used = 0;
    if (e.freight && typeof e.freight === "object") {
      for (const com of Object.keys(e.freight)) {
        if (!COM[com] || used >= def.cargoHold) continue;
        const q = num(e.freight[com], 0);
        if (q > 0) { const take = Math.min(q, def.cargoHold - used); clean[com] = take; used += take; }
      }
    }
    e.freight = clean;
  } else if (e.freight !== undefined) {
    delete e.freight;
  }
  // A collection-point freighter's `anchor` ({x,y}, engine/commands.js issueSetCollectPoint) is
  // untrusted the same way — a NaN/huge value would flow straight into stepToward on the shuttle
  // run's return leg and poison the unit's position. Clamp it like the entity's own x/y, or drop it
  // entirely if it isn't a real {x,y} pair (a shuttle run just re-anchors on its own next tick, see
  // assignShuttle's fallback).
  if (e.anchor !== undefined) {
    if (!e.anchor || typeof e.anchor !== "object") delete e.anchor;
    else {
      e.anchor.x = Math.max(0, Math.min(num(e.anchor.x, 0), map.width));
      e.anchor.y = Math.max(0, Math.min(num(e.anchor.y, 0), map.height));
    }
  }
  // A building's per-building logistics priority (engine/commands.js issueSetLogiPriority,
  // engine/haul.js LOGI_PRIORITIES/priorityWeight) is untrusted too: keep it only if it's a real
  // enum value ("high"/"normal"/"low"), else drop the field entirely — the same "reads as the
  // default" treatment `anchor` above gets, since priorityWeight already falls back to weight 1
  // (normal) for a missing field. Additive: an old save simply predates the field.
  if (e.logiPriority !== undefined && !LOGI_PRIORITIES.includes(e.logiPriority)) delete e.logiPriority;
  // A Plasma Rig's dig state is untrusted too: clamp digProgress into a sane band (a tampered huge
  // value would otherwise drive the dig loop to mint resources) and floor the dig counter.
  if (def.rig) {
    e.digProgress = Math.max(0, Math.min(num(e.digProgress, 0), 2));
    e.digCount = Math.max(0, Math.floor(num(e.digCount, 0)));
  }
  // A recycling entity's `recycling` ({progress, time}, engine/recycle.js) is untrusted too — a
  // tampered save could set progress negative/huge/NaN (skipping or stalling the countdown) or
  // time to zero/negative (dividing by it goes non-finite the moment the next tick advances it).
  // Clamp progress into [0,1] and time to a sane positive floor; drop the field entirely if it
  // isn't a real object, so a bad value just reads as "not recycling" — the identity for valid data.
  if (e.recycling !== undefined) {
    if (!e.recycling || typeof e.recycling !== "object") delete e.recycling;
    else {
      e.recycling.time = Math.max(1, num(e.recycling.time, 1));
      e.recycling.progress = Math.max(0, Math.min(num(e.recycling.progress, 0), 1));
    }
  }
  // A wonder's `charge` (a 0..1 float, engine/wonder.js) is untrusted: a hand-edited save could set it
  // huge, negative, NaN, or non-numeric — and an out-of-band charge trips an instant standalone-endless
  // win (engine/victory.js checkEndlessWin fires at charge >= 1) or corrupts the charge/HUD math. Clamp
  // it into [0,1] on load. Only touch a wonder that actually carries the field (an uncharged Gate has
  // none yet), and a legitimately-saved charge is already in [0,1] — so this is the identity.
  if (def.wonder && e.charge !== undefined) e.charge = Math.max(0, Math.min(num(e.charge, 0), 1));
  // A Helium Bomb's `armed` flag is untrusted too — coerce to a real boolean so a tampered
  // save can't smuggle in a truthy non-boolean that reads oddly elsewhere. Only a role:"bomb"
  // unit carries the field at all; harmless to any other def, but only worth writing there.
  if (def.role === "bomb") e.armed = !!e.armed;
  // A Helium Bomb's `fuseUntil` (the state.time its lit fuse detonates at, engine/bomb.js) is
  // untrusted too: a tampered save could set it to a non-numeric or non-finite value, which
  // would then poison the `state.time >= bomb.fuseUntil` comparison in updateBombFuse (NaN
  // compares false forever, so it'd sit fused but never actually go off). Drop the field
  // entirely when it isn't a finite number, so a bad value reads as "no fuse lit" — a real
  // saved fuse is already a plain finite number, so this is the identity for valid data.
  if (e.fuseUntil !== undefined) { const f = num(e.fuseUntil, NaN); if (Number.isFinite(f)) e.fuseUntil = f; else delete e.fuseUntil; }
  // A Spaceport's `lastLanding` (the galaxy-time it last received a jump — engine/galaxy.js's
  // landingZone) is untrusted too: clamp to a finite, non-negative number so a tampered huge/NaN
  // value can't win the "most recently used pad" tie-break it's only ever compared with. Only
  // present once a jump has actually landed there, so this only fires when the field exists.
  if (e.type === "spaceport" && e.lastLanding !== undefined) e.lastLanding = Math.max(0, num(e.lastLanding, 0));
  // A unit's player-set `facing` (engine/commands.js applyFacing) is untrusted too — a bogus
  // non-numeric value would flow straight into Math.cos/sin (renderShared.js) as NaN, silently
  // mis-drawing (never crashing) the sprite. Coerce it to a finite number, or drop the field
  // entirely so the unit just falls back to its normal movement-inferred facing.
  if (e.facing !== undefined) { const f = num(e.facing, NaN); if (Number.isFinite(f)) e.facing = f; else delete e.facing; }
  // A unit's `lastHitAt` (the state.time it last took damage — engine/combat.js performAttack/
  // applySplash, read by the Bulwark doctrine's out-of-combat regen, engine/repair.js
  // updateBulwarkRegen) is untrusted too: a non-numeric/non-finite value would flow straight into
  // `state.time - unit.lastHitAt` there as NaN, which always compares false — so a bad value
  // would just silently disable that unit's regen forever rather than crash, but drop it entirely
  // so it reads as "never hit" instead (the same graceful-default treatment fuseUntil/facing get
  // above, not a value worth preserving). A real saved value is already a finite number, so this
  // is the identity for valid data.
  if (e.lastHitAt !== undefined) { const t = num(e.lastHitAt, NaN); if (Number.isFinite(t)) e.lastHitAt = t; else delete e.lastHitAt; }
  // A unit's `kills` (engine/combat.js performAttack's target-died branch, entities.js
  // rankMults) is untrusted too: a tampered save could set it negative/fractional/non-numeric,
  // which would still compare fine against rankMults' `kills >= threshold` checks (worst case a
  // free/missing rank) but isn't a value a real game ever produces. Clamp to a non-negative
  // integer rather than drop it entirely — 0 is itself a valid, common value (a fresh unit), so
  // "missing" and "explicitly zero" should read the same way, unlike lastHitAt's drop-if-bad
  // treatment above (where "never hit" and "hit at time 0" are genuinely different states).
  if (e.kills !== undefined) e.kills = Math.max(0, Math.floor(num(e.kills, 0)));
  // A producer's output buffer (building.store) and a factory's input buffer (building.input) are
  // untrusted save data — a hand-edited file could smuggle in a bogus commodity, a negative/NaN qty,
  // or an over-capacity buffer. Keep only real commodities with a positive qty, clamped to capacity —
  // `store` as one shared pooled total (storeCapOf), `input` per-commodity independently (inputCapOf
  // is now a per-commodity slice, coerceInputBuffer clamps each on its own, see its doc comment); a
  // building with no such buffer can't hold one, so strip any a tampered save bolted on.
  e.store = coerceBuffer(e.store, storeCapOf(e.type));
  e.input = coerceInputBuffer(e.input, inputCapOf(e.type));
  if (storeCapOf(e.type) <= 0) delete e.store;
  if (inputCapOf(e.type) <= 0) delete e.input;
  // A building's production queue is untrusted: a bogus/unknown unitType would deref undefined and
  // brick the game on the first tick (see engine/production.js). For buildings only (units carry no
  // queue), rebuild it from known-good jobs — real UNIT types, progress clamped to [0,1], the
  // paid-with-alt flag preserved, everything else dropped — and empty it for a building that can't
  // produce or whose queue isn't even an array. For a valid save this is the identity, so the
  // byte-identical round-trip is untouched.
  if (BUILDINGS[e.type]) {
    e.queue = (BUILDINGS[e.type].produces && Array.isArray(e.queue))
      ? e.queue.filter(j => j && UNITS[j.unitType]).map(j => ({
          unitType: j.unitType,
          progress: Math.max(0, Math.min(num(j.progress, 0), 1)),
          ...(j.alt ? { alt: true } : {}),
        }))
      : [];
    // A Datacenter's OR Refinery's research queue is untrusted exactly like the production queue
    // above: a non-array `researchQueue` (e.g. the number 5) throws .length/.shift and bricks the
    // game on the first research tick (engine/techtree.js updateResearch, which now resolves EITHER
    // TECHS or UPGRADES by building.type — doctrine research develops over time too, not just the
    // Datacenter's tech tree), and a bogus techId derefs an undefined def either way. When the field
    // is present, rebuild it from known-good jobs — a real TECHS OR UPGRADES id (whichever table
    // this building's own type actually resolves — the two id spaces only ever overlap on the
    // deliberately-shared "recycling" id, entities.js, which is harmless here since updateResearch
    // itself always resolves that id against the one table this building's type maps to), progress
    // clamped to [0,1] — or [] for a non-array. A building WITHOUT the field (any building that
    // never queued research) is left untouched, so it's the identity for a valid save.
    if (e.researchQueue !== undefined) {
      e.researchQueue = Array.isArray(e.researchQueue)
        ? e.researchQueue.filter(j => j && (TECHS[j.techId] || UPGRADES[j.techId])).map(j => ({
            techId: j.techId,
            progress: Math.max(0, Math.min(num(j.progress, 0), 1)),
          }))
        : [];
    }
  }
  return e;
}

// Sanitize an untrusted commodity→qty buffer: real commodities only, positive finite qty,
// TOTAL (summed across every commodity) clamped to `cap` — a genuinely shared pool, which is
// what a producer's output buffer (building.store) actually is. Returns {} for a zero/undefined cap.
function coerceBuffer(buf, cap) {
  const clean = {};
  if (cap <= 0 || !buf || typeof buf !== "object") return clean;
  let used = 0;
  for (const com of Object.keys(buf)) {
    if (!COM[com] || used >= cap) continue;
    const q = num(buf[com], 0);
    if (q > 0) { const take = Math.min(q, cap - used); clean[com] = take; used += take; }
  }
  return clean;
}

// Same sanitizing as coerceBuffer, but for a factory's INPUT larder (building.input), where `cap`
// (entities.js inputCapOf) is now a PER-COMMODITY slice, not one shared pool (see its own doc
// comment: an oversupplied input must never crowd out room for another the recipe still needs) —
// so each commodity is clamped to `cap` INDEPENDENTLY, not against a shared running total.
function coerceInputBuffer(buf, cap) {
  const clean = {};
  if (cap <= 0 || !buf || typeof buf !== "object") return clean;
  for (const com of Object.keys(buf)) {
    if (!COM[com]) continue;
    const q = num(buf[com], 0);
    if (q > 0) clean[com] = Math.min(q, cap);
  }
  return clean;
}

// Sanitize an untrusted commodity->qty bag with no shared cap to clamp against — a pending
// wreck site's `goods` (engine/wreckage.js) isn't bounded by a building's storeCap the way
// coerceBuffer's inputs are, so this just keeps real commodities with a positive finite qty.
function sanitizeGoods(g) {
  const clean = {};
  if (!g || typeof g !== "object") return clean;
  for (const com of Object.keys(g)) {
    if (!COM[com]) continue;
    const q = num(g[com], 0);
    if (q > 0) clean[com] = q;
  }
  return clean;
}

// A player's economy is untrusted save data exactly like an entity's buffers above: `resources`
// (commodity→qty) and `upgrades` (tech/upgrade id→true) both flow straight into gameplay math the
// moment the game starts ticking — a bogus commodity key would mint a phantom treasury entry the
// first time it's spent/produced, a string/NaN/negative qty would poison the market and production
// math, and a bogus tech/upgrade id sitting in `upgrades` is a landmine for the multiplier scans in
// techtree.js/entities.js (`for (const id in upgrades) if (upgrades[id] && TECHS[id]/UPGRADES[id]...`)
// the moment a real id with that name is ever added. Keep only real COM keys with a finite qty >= 0
// (identity for a valid save — its quantities are already finite and non-negative, no cap to clamp
// against since a player's bank is unbounded, unlike a building's buffer). For `upgrades`, keep only
// keys that are a real TECHS or UPGRADES id AND already truthy, normalised to the boolean `true`
// every grant in the codebase uses (techtree.js: `player.upgrades[job.techId] = true`) — upgrades are
// a pure presence-flag, so an explicit `false` (or any other falsy value) on a tampered save is
// dropped rather than preserved, matching how a valid save represents "not researched" (the key is
// simply absent, never `false`). Mutates and returns `p` so it drops straight into rehydratePlanet.
function cleanPlayer(p) {
  const resources = {};
  if (p.resources && typeof p.resources === "object") {
    for (const com of Object.keys(p.resources)) {
      if (!COM[com]) continue;
      const q = num(p.resources[com], NaN);
      if (Number.isFinite(q) && q >= 0) resources[com] = q;
    }
  }
  p.resources = resources;
  const upgrades = {};
  if (p.upgrades && typeof p.upgrades === "object") {
    for (const id of Object.keys(p.upgrades))
      if (p.upgrades[id] && (TECHS[id] || UPGRADES[id])) upgrades[id] = true;
  }
  p.upgrades = upgrades;
  return p;
}

// Largest numeric suffix among the state's OWN-minted ids ("u12"/"b7" — the ids newId
// mints from the global counter; "g"-scheme galaxy ids come from a separate counter and
// are ignored here). Used to guarantee the restored counter can never mint an id that
// collides with a loaded entity, even if the save's nextEntityId is missing/low/garbage.
function maxOwnEntityId(state) {
  let m = 0;
  const scan = id => { const s = /^[ub](\d+)$/.exec(String(id)); if (s) { const n = +s[1]; if (n > m) m = n; } };
  for (const id of state.units.keys()) scan(id);
  for (const id of state.buildings.keys()) scan(id);
  return m;
}

function serPlayer(p) {
  return { id: p.id, faction: p.faction, isAI: p.isAI, color: p.color,
    resources: { ...p.resources }, upgrades: { ...p.upgrades } };
}

// The DYNAMIC per-planet payload — everything the seed can't regenerate. Shared by
// the skirmish save and every planet of a galaxy save. visible fog is NOT stored
// (recomputed on load); only `explored` (permanent scouted memory) persists. The
// global entity-id counter is NOT here — it's saved once by the caller.
function serPlanet(state) {
  return {
    seed: state.seed, planetId: state.planetId,
    sizeMult: state.sizeMult, resourceMult: state.resourceMult,
    swapAsym: !!state.swapAsym,   // additive: which side plays which half of an asym world's matchup (engine/map.js) — default false, no version bump
    // setup.js's Match length row override (engine/victory.js DEFAULT_MATCH_TIME_LIMIT) — additive,
    // defaults null (no override, same as every pre-existing save) so no SAVE_VERSION bump per
    // CONTRIBUTING's additive-field rule.
    matchTimeLimit: state.matchTimeLimit ?? null,
    // setup.js's Population cap row (engine/supply.js's popCap clamp) — additive, defaults null
    // (Max — uncapped, same as every pre-existing save) so no SAVE_VERSION bump either.
    popCap: state.popCap ?? null,
    endless: !!state.endless,
    time: state.time, tick: state.tick, over: state.over, winner: state.winner,
    // additive: why the match ended (engine/victory.js finish) — default null, same as an
    // in-progress or pre-this-feature save; no SAVE_VERSION bump per CONTRIBUTING.
    winReason: state.winReason ?? null,
    // One entry per side, in state.owners order — for the player-vs-ai pair this
    // serialises as { player, ai }, byte-identical to the old literal. The save
    // shape stays two-keyed (fog/fogAI below likewise): a save FORMAT built for N
    // sides is separate, deferred work.
    players: Object.fromEntries((state.owners || Object.keys(state.players)).map(id => [id, serPlayer(state.players[id])])),
    // `_gi` is the grid broad-phase index — a transient stamped fresh onto every unit each tick
    // by buildUnitGrid, meaningless once saved. Strip it so it doesn't bloat the payload with a
    // per-unit integer that the next tick overwrites anyway. Shallow copy, only at save time.
    // `squadLeader`/`squadFollowers` (engine/commands.js) are live UNIT OBJECT REFERENCES, not
    // ids — session-only, transient bookkeeping like the rest of this denylist, but they ALSO
    // can't survive JSON.stringify at all: a follower points at its leader, the leader's own
    // squadFollowers list points right back, and JSON.stringify throws on a circular structure
    // rather than silently truncating it — a live squad would crash every save. Strip both
    // fields, and null out a live `follow-leader` order too (it embeds the same leader
    // reference) — a reload simply drops squad membership, the same "recomputed/reset, never
    // persisted" treatment repairTargetId already gets.
    // `ferriers` (a freighter's per-tick ferry-worker tally, engine/haul.js countLogistics) and
    // `repairers` (a unit can now be a worker repair-job TARGET too, engine/repair.js
    // countRepairJobs) are transient too, same reasoning as `haulers`/`servers` below — stripped
    // here since they can live on a UNIT, not just a building. `homeCC` (a player-assigned home
    // base, engine/commands.js issueSetHomeBase) is real persisted intent, kept as-is — a stale
    // reference to a destroyed CC is harmless, zoneFirst just falls back to the nearest-CC guess.
    units: [...state.units.values()].map(({ _gi, repairTargetId, squadLeader, squadFollowers, ferriers, repairers, ...u }) =>
      u.order && u.order.type === "follow-leader" ? { ...u, order: null } : u),
    // `haulers`/`servers` (logistics tallies, engine/haul.js), `repairers` (worker repair-job
    // tally, engine/repair.js countRepairJobs), `powered`/`fuel` (Generator fuel state, engine/
    // industry.js), `menderClaims` (auto-repair Mender tally, engine/sim.js) and `lastYield`/
    // `lastTier` (a Plasma Rig's last-strike HUD readout, engine/rig.js — regenerated on the next
    // dig) are all transient — stamped fresh each tick like a unit's `_gi` grid index — so strip
    // them from saves. (digProgress/digCount are the rig's REAL persisted dig state, kept.)
    buildings: [...state.buildings.values()].map(({ haulers, servers, repairers, powered, fuel, menderClaims, lastYield, lastTier, ...b }) => b),
    // A map-generated node is regenerated fresh from the seed on load (generateMap), so only
    // its `amount` (the one thing that changes) needs saving. A crater node (engine/bomb.js)
    // or a wreck node (engine/wreckage.js) does NOT exist in that regeneration at all — it
    // needs its whole shape saved, and rehydratePlanet below re-adds it after the seed
    // regenerates everything else.
    nodes: state.map.nodes.map(n => (n.crater || n.wreck)
      ? { id: n.id, com: n.com, amount: n.amount, max: n.max, x: n.x, y: n.y, ...(n.crater ? { crater: true } : { wreck: true }) }
      : { id: n.id, amount: n.amount }),
    // Pending Helium Bomb craters not yet matured — lost without this (a save/load right
    // after a detonation would silently cancel the future deposit).
    craters: (state.craters || []).map(c => ({ id: c.id, x: c.x, y: c.y, owner: c.owner, spawnAt: c.spawnAt })),
    // Pending battle-wreckage sites (engine/wreckage.js) not yet matured — same reasoning
    // as craters above. No `owner`: wreckage is neutral, unlike a crater. `value` is the
    // running battle-intensity total (engine/wreckage.js applyBattleBonus) — lost without
    // this, a save/load mid-battle would silently reset a site's bonus-material progress.
    // `createdAt` anchors how far spawnAt can be extended by a later contribution
    // (mergeIntoWreckSite) — lost without it, a reloaded raging battle could re-extend
    // past WRECK_MAX_DELAY.
    wrecks: (state.wrecks || []).map(w => ({
      id: w.id, x: w.x, y: w.y, n: w.n, value: w.value, createdAt: w.createdAt,
      goods: { ...w.goods }, spawnAt: w.spawnAt,
    })),
    fog: [...state.fog.explored],
    fogAI: [...state.fogAI.explored],
    ai: {
      aiThink: state.ai.think ?? 0, aiScoutId: state.ai.scoutId ?? null,
      aiApm: state.ai.apm ?? null, aiMicro: !!state.ai.micro,
      // The player-picked AI strategy (engine/aiStrategy.js) — persisted the same redundant-per-planet
      // way aiApm/aiMicro already are (not re-derived like the archetype, since it's not a function of
      // planetId), so an old save without the field defaults to "default" (byte-identical to today).
      aiStrategy: state.ai.strategy || "default",
      // The splash-screen Easy/Medium/Hard pick (engine/aiDifficulty.js) — persisted the same
      // redundant-per-planet way aiApm/aiMicro/aiStrategy already are, so an old save without the
      // field defaults to "medium" (the same fallback difficultyFor(state) itself applies).
      aiDifficulty: state.ai.difficulty || "medium",
      // Sim-time of the last seen threat near home (drives Economic's war-footing window,
      // engine/ai.js). Additive + nullish-defaulted, so an old save without it loads as "no recent
      // threat" — the safe, conservative default (a freshly reloaded game reads as being at peace).
      aiLastThreatAt: state.ai.lastThreatAt ?? null,
      aiActionBudget: state.ai.actionBudget ?? 0,
      aiAttackForce: state.ai.attackForce ?? 0, aiAttackDesperate: !!state.ai.attackDesperate,
      aiNextAttackAt: state.ai.nextAttackAt ?? null, aiUnitsBuilt: state.ai.unitsBuilt ?? 0,
      // Committed-wave counter (engine/ai.js): drives the economy-raid cadence
      // (aiWaveCount % RAID_EVERY). Omitting it reset the counter to 0 on every reload,
      // shifting all subsequent raid-vs-base decisions — the same continue-identically
      // break the aiNextWaveAt note below warns about. Additive + `|| 0`-defaulted in
      // ai.js, so old saves without it load fine.
      aiWaveCount: state.ai.waveCount ?? 0,
      // Odyssey offense cadence (engine/ai.js) — a scheduled future time. Must be
      // persisted or a reloaded hostile world fires its next probe a full cadence
      // early (undefined ?? 0 ⇒ immediately wave-ready), breaking continue-identically.
      aiNextWaveAt: state.ai.nextWaveAt ?? null,
      // Opponent belief (engine/aiIntel.js): a fading high-water mark of what this controller has
      // SEEN of the enemy. Persisted for the same continue-identically reason aiWaveCount is —
      // dropping it would make a reloaded AI forget the army it scouted and re-derive its whole
      // posture read from an empty picture, changing every downstream decision.
      aiIntelMil: state.ai.intelMil ?? 0, aiIntelEco: state.ai.intelEco ?? 0,
      aiIntelMilAt: state.ai.intelMilAt ?? null, aiIntelEcoAt: state.ai.intelEcoAt ?? null,
      aiIntelAt: state.ai.intelAt ?? null,
      aiAdaptMode: state.ai.adaptMode ?? null,
      // Odyssey colony-ship expansion target (engine/ai.js) — the committed deploy spot
      // of an in-flight ship. Persisted so a reload doesn't recompute a different target.
      aiColonyTarget: state.ai.colonyTarget ?? null,
    },
    // Tier 1 self-play's SECOND, parallel AI controller (owner "player" — see engine/state.js's
    // createAiController, engine/ai.js's runAI(state, dt, owner)). Purely additive: every save
    // that predates this feature (and every non-self-play save made after it) has state.playerAi
    // === null, so this serializes to `null` and rehydratePlanet's `P.playerAi ? … : null` below
    // reads that back as null too — a byte-identical round trip with NO SAVE_VERSION bump. Field
    // names mirror the `ai` block above one-for-one (pa-prefixed instead of ai-prefixed) so the
    // two controllers can never structurally drift.
    playerAi: state.playerAi ? {
      paThink: state.playerAi.think ?? 0, paScoutId: state.playerAi.scoutId ?? null,
      paApm: state.playerAi.apm ?? null, paMicro: !!state.playerAi.micro,
      paStrategy: state.playerAi.strategy || "default",
      paDifficulty: state.playerAi.difficulty || "medium",
      paLastThreatAt: state.playerAi.lastThreatAt ?? null,
      paActionBudget: state.playerAi.actionBudget ?? 0,
      paAttackForce: state.playerAi.attackForce ?? 0, paAttackDesperate: !!state.playerAi.attackDesperate,
      paNextAttackAt: state.playerAi.nextAttackAt ?? null, paUnitsBuilt: state.playerAi.unitsBuilt ?? 0,
      paWaveCount: state.playerAi.waveCount ?? 0,
      paNextWaveAt: state.playerAi.nextWaveAt ?? null,
      // Opponent belief (engine/aiIntel.js): a fading high-water mark of what this controller has
      // SEEN of the enemy. Persisted for the same continue-identically reason aiWaveCount is —
      // dropping it would make a reloaded AI forget the army it scouted and re-derive its whole
      // posture read from an empty picture, changing every downstream decision.
      paIntelMil: state.playerAi.intelMil ?? 0, paIntelEco: state.playerAi.intelEco ?? 0,
      paIntelMilAt: state.playerAi.intelMilAt ?? null, paIntelEcoAt: state.playerAi.intelEcoAt ?? null,
      paIntelAt: state.playerAi.intelAt ?? null,
      paAdaptMode: state.playerAi.adaptMode ?? null,
      paColonyTarget: state.playerAi.colonyTarget ?? null,
    } : null,
  };
}

// Rebuild a single engine state from a per-planet payload: regenerate the
// deterministic map from the seed, overlay saved node amounts by id, restore
// entities/economies/AI bookkeeping, and recompute current visibility. Does NOT
// touch the global entity-id counter (the caller restores it once, last).
function rehydratePlanet(P) {
  // `sizeMult`/`resourceMult` are untrusted save data that feed straight into generateMap's
  // Math.min/Math.max sizing math (engine/map.js), which only guards FALSY values (`opts.sizeMult ||
  // 1`) — a NaN, a string, or a non-finite number propagates through unguarded and produces a
  // NaN-sized map, which then defeats every coordinate clamp cleanEntity performs below (they clamp
  // against map.width/map.height, themselves NaN). Sanitize to a finite, positive number, defaulting
  // to 1 (the game's own default — see engine/state.js's `opts.sizeMult || 1` and setup.js) on
  // anything else, and floor it at 0.1 so a legitimate-but-tiny value can't zero out the map. Compute
  // ONCE and reuse for both the map generation below AND the state.sizeMult/resourceMult assignment
  // further down, so the map's real dimensions and the state's reported multiplier can never disagree.
  const sizeMult = Math.max(0.1, num(P.sizeMult, 1));
  const resourceMult = Math.max(0.1, num(P.resourceMult, 1));
  // Additive, coerced to a real boolean like every other untrusted save flag: a save from before
  // this field existed (or a tampered non-boolean) reads as unswapped, not throwing/undefined.
  const swapAsym = !!P.swapAsym;
  // setup.js's Match length override (engine/victory.js DEFAULT_MATCH_TIME_LIMIT): additive and
  // untrusted like every other save field. `null`/missing means "no override" (the common case —
  // must NOT sanitize through num()'s Number(null)===0 coercion, which would silently turn "no
  // override" into "end the match at time 0"). A non-null value is only trusted if it coerces to a
  // genuinely POSITIVE finite number; anything else (0, negative, NaN, a string) falls back to the
  // same safe "no override" null rather than a broken instant/never timeout.
  const matchTimeLimit = P.matchTimeLimit == null ? null
    : (Number.isFinite(Number(P.matchTimeLimit)) && Number(P.matchTimeLimit) > 0 ? Number(P.matchTimeLimit) : null);
  // setup.js's Population cap row (engine/supply.js's popCap clamp): additive and untrusted like
  // matchTimeLimit just above, same reasoning/shape. null/missing means Max (no ceiling, the
  // common case, and every pre-existing save); a non-null value is only trusted if it coerces to
  // a genuinely POSITIVE finite number, else falls back to the same safe "no ceiling" null.
  const popCap = P.popCap == null ? null
    : (Number.isFinite(Number(P.popCap)) && Number(P.popCap) > 0 ? Number(P.popCap) : null);
  const map = generateMap(P.planetId, mulberry32((P.seed ?? 0) >>> 0),
    { sizeMult, resourceMult, swapAsym });
  const amounts = new Map(P.nodes.map(n => [n.id, n.amount]));
  for (const n of map.nodes) if (amounts.has(n.id)) n.amount = amounts.get(n.id);
  // A crater node (engine/bomb.js) never comes back from the seed regeneration above — it
  // isn't part of the deterministic map at all — so re-add it here from its own saved shape,
  // sanitized the same way a tampered entity field would be: a real commodity, finite
  // amount/max clamped sane, position clamped onto the map. Only entries actually marked
  // `crater: true` are considered, so this can't be used to smuggle an arbitrary extra node
  // onto a map-generated id.
  for (const n of P.nodes) {
    if (!n || !n.crater || map.nodesById.has(n.id) || !COM[n.com]) continue;
    const max = Math.max(1, num(n.max, CRATER_NODE_AMOUNT));
    const node = {
      id: String(n.id), com: n.com, crater: true,
      max, amount: Math.max(0, Math.min(num(n.amount, max), max)),
      x: Math.max(0, Math.min(num(n.x, 0), map.width)),
      y: Math.max(0, Math.min(num(n.y, 0), map.height)),
    };
    map.nodes.push(node);
    map.nodesById.set(node.id, node);
  }
  // A wreck node (engine/wreckage.js) never comes back from the seed regeneration either —
  // same reasoning and same sanitization as the crater block above, just keyed off `wreck:
  // true` instead, and with no fixed default amount to fall back to (a wreck's size always
  // comes from what died there, so 1 is just a safe floor for a corrupt/missing value).
  for (const n of P.nodes) {
    if (!n || !n.wreck || map.nodesById.has(n.id) || !COM[n.com]) continue;
    const max = Math.max(1, num(n.max, 1));
    const node = {
      id: String(n.id), com: n.com, wreck: true,
      max, amount: Math.max(0, Math.min(num(n.amount, max), max)),
      x: Math.max(0, Math.min(num(n.x, 0), map.width)),
      y: Math.max(0, Math.min(num(n.y, 0), map.height)),
    };
    map.nodes.push(node);
    map.nodesById.set(node.id, node);
  }

  const fog = createFog(map); fog.explored = Uint8Array.from(P.fog);
  const fogAI = createFog(map); fogAI.explored = Uint8Array.from(P.fogAI);

  // Keep only entities of a REAL type, coercing their numeric fields — an unknown
  // `type` makes UNITS[type]/BUILDINGS[type] undefined and throws on the first tick;
  // a NaN coord/hp silently corrupts the sim. Drop the former, clean the latter.
  const units = new Map();
  for (const u of P.units) { const def = UNITS[u.type]; if (def) units.set(u.id, cleanEntity(u, def, map)); }
  const buildings = new Map();
  for (const b of P.buildings) { const def = BUILDINGS[b.type]; if (def) buildings.set(b.id, cleanEntity(b, def, map)); }

  // Rebuild the owner-generic scaffold from the (two-keyed) save: state.owners is
  // the side list, state.fogs maps each to its fog, and state.fog/state.fogAI stay
  // as aliases so the many fog consumers keep working. This mirrors createGameState.
  // Each player's resources/upgrades are untrusted save data too — sanitized by cleanPlayer
  // (see its comment) before they reach live gameplay math.
  const players = { player: cleanPlayer(P.players.player), ai: cleanPlayer(P.players.ai) };
  const owners = Object.keys(players);
  const fogs = { player: fog, ai: fogAI };

  // Pending Helium Bomb craters (engine/bomb.js) not yet matured — additive, so an older
  // save without the field just has none. A bogus/missing owner (not a real side) or a
  // malformed entry is dropped rather than coerced to a guess: a crater with the wrong
  // owner is a lost gameplay attribution, not a value worth defaulting.
  const craters = Array.isArray(P.craters) ? P.craters
    .filter(c => c && typeof c.id === "string" && owners.includes(c.owner))
    .map(c => ({
      id: c.id, owner: c.owner, spawnAt: num(c.spawnAt, 0),
      x: Math.max(0, Math.min(num(c.x, 0), map.width)),
      y: Math.max(0, Math.min(num(c.y, 0), map.height)),
    })) : [];

  // Pending battle-wreckage sites (engine/wreckage.js) not yet matured — additive, so an
  // older save without the field just has none. No owner to validate (wreckage is neutral);
  // a malformed entry, or one left with no valid commodities after sanitizing, is dropped
  // rather than kept as empty garbage that would mature into nothing.
  const wrecks = (Array.isArray(P.wrecks) ? P.wrecks
    .filter(w => w && typeof w.id === "string")
    .map(w => {
      const spawnAt = num(w.spawnAt, 0);
      return {
        id: w.id, spawnAt, n: Math.max(1, Math.floor(num(w.n, 1))),
        value: Math.max(0, num(w.value, 0)),
        // A save from before Phase 4 (or any tampered entry) predates `createdAt` — fall
        // back to "one base delay before its current spawnAt", the same reconstruction a
        // site that had never yet been extended would already satisfy, so an old save
        // resumes with a full, correct extension budget rather than none at all. Clamped
        // to at most `spawnAt` either way — createdAt can never sanely be later than its
        // own site's spawn time, so a tampered future value can't grant runaway extension.
        createdAt: Math.max(0, Math.min(Number.isFinite(w.createdAt) ? num(w.createdAt, 0) : spawnAt - WRECK_SPAWN_DELAY, spawnAt)),
        x: Math.max(0, Math.min(num(w.x, 0), map.width)),
        y: Math.max(0, Math.min(num(w.y, 0), map.height)),
        goods: sanitizeGoods(w.goods),
      };
    }) : []).filter(w => Object.keys(w.goods).length > 0);

  const state = {
    time: num(P.time, 0), tick: num(P.tick, 0), over: P.over, winner: P.winner,
    winReason: P.winReason ?? null,   // additive — why the match ended (engine/victory.js finish); null before/absent
    seed: P.seed, planetId: P.planetId, sizeMult, resourceMult, swapAsym, matchTimeLimit, popCap,
    endless: !!P.endless,
    map,
    owners,
    players,
    units,
    buildings,
    selection: [],
    fogs, fog, fogAI,
    // Restore the AI controller's bookkeeping into the grouped `state.ai` (see engine/state.js).
    // Wire keys stay `aiThink`/`aiScoutId`/… under the save's `ai:` object for backward compat;
    // only the live shape is nested. The archetype is re-derived from the planet id, not persisted.
    ai: cleanController(P.ai, "ai", P.planetId),
    // Restore Tier 1 self-play's second controller (see the matching comment in serPlanet above)
    // — null for every save that predates it or never activated self-play, exactly like state.ai
    // itself would be if createGameState were ever called without seeding it (it never is; this
    // is playerAi's only construction path outside tools/selfplay.js's own direct assignment).
    playerAi: P.playerAi ? cleanController(P.playerAi, "pa", P.planetId) : null,
    events: [],
    craters,
    wrecks,
  };
  for (const id of owners) updateFog(state, state.fogs[id], id);
  return state;
}

/* ---------- single skirmish ---------- */

// The plain, JSON-safe save payload (serPlanet already returns detached plain data). The two
// public paths differ only in the last step: serializeGame() returns a DETACHED OBJECT (a
// stringify/parse copy, so ticking the live game on after a save can't mutate it under a caller
// that keeps it — tests, importSave's shape sniff); serializeGameString() returns the JSON
// STRING directly. autoSave (the 12 s hot path) uses the string, so it stringifies ONCE instead
// of stringify→parse→stringify — the fog arrays are large, and the two extra passes were waste.
function gamePayload(state) { return { v: SAVE_VERSION, nextEntityId: peekEntityId(), ...serPlanet(state) }; }
/** @param {State} state @returns {Object} */
export function serializeGame(state) { return JSON.parse(JSON.stringify(gamePayload(state))); }
/** @param {State} state @returns {string} */
export function serializeGameString(state) { return JSON.stringify(gamePayload(state)); }

/** @param {*} input @returns {State} */
export function deserializeGame(input) {
  sanitizeSave(input);                              // reject unsafe/oversized payloads before anything else
  const save = JSON.parse(JSON.stringify(input));   // detach + normalise
  if (save.v !== SAVE_VERSION) throw new Error(`unsupported save version ${save.v}`);
  const state = rehydratePlanet(save);
  // Never trust the saved counter as ground truth: mint from beyond BOTH the saved value
  // AND every loaded id, so a missing/low/garbage nextEntityId can't produce an id that
  // overwrites a live entity. For a valid save this is exactly save.nextEntityId (peeked
  // after all mints, so already > every suffix) — identity, determinism preserved.
  restoreEntityId(Math.max(num(save.nextEntityId, 0), maxOwnEntityId(state) + 1));
  return state;
}

/* ---------- whole Odyssey galaxy ---------- */

function galaxyPayload(galaxy) {
  return {
    v: GALAXY_SAVE_VERSION,
    seed: galaxy.seed, credits: galaxy.credits, activeId: galaxy.activeId, worlds: galaxy.worlds,
    settings: galaxy.settings,
    entitySeq: galaxy.entitySeq ?? 0, galaxyTick: galaxy.tick ?? 0,
    galaxyTime: galaxy.time ?? 0,                    // galaxy-wide clock — keys the relief cooldown (engine/galaxy.js)
    lastReliefTime: galaxy.lastReliefTime ?? null,   // when the last relief ship dropped, on that same clock
    pacified: [...(galaxy.pacified || [])], wonBy: galaxy.wonBy ?? null,   // conquest progress (additive; old saves default to none)
    reached: [...(galaxy.reached || [])],                                  // progress milestones already celebrated — so a reload doesn't replay their fireworks
    // THE RIVAL GATE's idempotency latch (engine/galaxy.js checkRivalGate). Additive, so no
    // GALAXY_SAVE_VERSION bump: an older save simply loads with none, which is today's behaviour.
    // Without it a reload silently undid an ascension — the "permanent" stance ceiling could never
    // be re-applied once the Gate was razed (checkRivalGate can only re-latch by FINDING a completed
    // Gate), and while it still stood the ascension event re-fired on every single Continue.
    rivalAscended: [...(galaxy.rivalAscended || [])],
    discovered: [...(galaxy.discovered || [])],                            // living galaxy: worlds the player has REACHED (starmap "explored" + free return-jump)
    claims: [...(galaxy.claims || [])],                                     // faction spread: [worldId, faction] pairs (checkExpansion) — the galactic politics on the starmap
    // Colony standing orders (engine/colonyPolicy.js): [worldId, {autoSell, workerTarget}] pairs —
    // additive (a save that predates this feature simply has none, and every colony defaults off).
    colonyPolicies: [...(galaxy.colonyPolicies || [])],
    // Freight Lanes (engine/galaxy.js runLanes): standing shipping routes between held worlds —
    // additive (default []).
    lanes: (galaxy.lanes || []).map(l => ({ id: l.id, from: l.from, to: l.to, commodities: [...l.commodities], shipIds: [...l.shipIds] })),
    laneSeq: galaxy.laneSeq ?? 0,
    nextEntityId: peekEntityId(),                 // the ONE global entity counter, saved once
    planets: [...galaxy.planets.values()].map(state => ({
      ...serPlanet(state),
      background: !!state.background,
      market: { pressure: { ...state.market.pressure }, glut: { ...(state.market.glut || {}) } },
      diplomacy: { ...state.diplomacy },          // stance, depletion, lastAiUnits
    })),
  };
}
// Detached object (serializeGalaxy) vs the JSON string (serializeGalaxyString) — see the
// serializeGame note; autoSave uses the string to stringify the fog-heavy galaxy just once.
/** @param {Galaxy} galaxy @returns {Object} */
export function serializeGalaxy(galaxy) { return JSON.parse(JSON.stringify(galaxyPayload(galaxy))); }
/** @param {Galaxy} galaxy @returns {string} */
export function serializeGalaxyString(galaxy) { return JSON.stringify(galaxyPayload(galaxy)); }

/** @param {*} input @returns {Galaxy} */
export function deserializeGalaxy(input) {
  sanitizeSave(input);                              // reject unsafe/oversized payloads before anything else
  const save = JSON.parse(JSON.stringify(input));
  if (save.v !== GALAXY_SAVE_VERSION) throw new Error(`unsupported galaxy save version ${save.v}`);
  // Reject structural nonsense HERE, while the running session is still intact and the
  // caller's try/catch can keep the current game. Without these, a save whose activeId
  // has no matching planet (or that carries no planets at all) parses "successfully",
  // the caller tears down the live game, and boot crashes reading a non-existent active
  // world — losing the running game to a bad file.
  if (!Array.isArray(save.worlds) || !save.worlds.length) throw new Error("galaxy save has no worlds");
  if (!Array.isArray(save.planets) || !save.planets.length) throw new Error("galaxy save has no planets");

  // The world roster and active id are save-derived strings that flow into the starmap
  // UI (planetName → node text). Constrain them to REAL world ids so a hand-crafted save
  // can never smuggle an arbitrary string through the roster (defence-in-depth behind the
  // starmap's own escaping); an unknown activeId then fails the has-planet check below.
  const known = new Set(ODYSSEY_WORLDS);
  const worlds = save.worlds.filter(id => known.has(id));
  if (!worlds.length) throw new Error("galaxy save has no recognised worlds");
  // Append any roster worlds the save predates (the roster is append-only, so this is
  // index-stable): a pre-Phase-4 save froze `worlds` at nine, permanently hiding the newer
  // worlds from the starmap AND — because the BG scheduler keys on worlds.indexOf(id) — any
  // planet missing from the roster would get index -1 and never tick again.
  for (const id of ODYSSEY_WORLDS) if (!worlds.includes(id)) worlds.push(id);

  const galaxy = {
    seed: save.seed, credits: num(save.credits, 0), activeId: save.activeId, worlds,
    planets: new Map(), settings: cleanGalaxySettings(save.settings),
    tick: num(save.galaxyTick, 0), time: num(save.galaxyTime, 0), entitySeq: num(save.entitySeq, 0),
    lastReliefTime: Number.isFinite(save.lastReliefTime) ? save.lastReliefTime : undefined,
    colonyNotes: new Map(),   // transient UI bookkeeping — re-derived, never persisted
    // Filtered like `claims` and `worlds` three lines below, which were already careful. Unfiltered,
    // a junk id counted toward DOMINATION_TARGET (a raw `.size` check) and PACIFIED_INCOME, and
    // inflated the "worlds visited" readout galaxyStatus puts on the starmap.
    pacified: new Set((Array.isArray(save.pacified) ? save.pacified : []).filter(id => ODYSSEY_WORLDS.includes(id))),
    pacifyNotes: [],
    wonBy: typeof save.wonBy === "string" ? save.wonBy : null,
    // `reached` holds MILESTONE ids, not world ids — filtering it against the world roster would
    // silently drop every genuine milestone and replay its fireworks on the next load.
    reached: new Set((Array.isArray(save.reached) ? save.reached : []).filter(isMilestoneId)),
    rivalAscended: new Set((Array.isArray(save.rivalAscended) ? save.rivalAscended : []).filter(id => ODYSSEY_WORLDS.includes(id))), milestones: [],   // celebrated milestones persist; the firework queue is transient
    // Worlds the player has reached. An OLD save predates the field AND the living galaxy, so it only
    // instantiated worlds the player had actually visited — recover `discovered` as exactly that set
    // (the planet ids present in the save), plus the active world. A NEW save carries the real set.
    discovered: new Set((Array.isArray(save.discovered) ? save.discovered
      : [save.activeId, ...save.planets.map(P => P.planetId)]).filter(id => ODYSSEY_WORLDS.includes(id))),
    // Faction spread (checkExpansion). Restored as a Map of [worldId, faction]; keep only real world
    // ids (defence-in-depth behind the roster filter). Old saves predate it → empty (no claims yet).
    claims: new Map((Array.isArray(save.claims) ? save.claims : [])
      .filter(e => Array.isArray(e) && ODYSSEY_WORLDS.includes(e[0]) && typeof e[1] === "string")),
    expansionNotes: [],   // transient UI queue — re-derived, never persisted
    // Colony standing orders (engine/colonyPolicy.js). Additive — an old save simply has none, and
    // every colony reads back as the fully-off default (sanitizePolicy(null)) via getColonyPolicy.
    // Every stored policy is run through the SAME sanitizePolicy a live edit uses, so a hand-edited
    // or corrupt entry (an unknown commodity, a negative floor, a garbage workerTarget) can't slip
    // untrusted values into the sim.
    colonyPolicies: new Map((Array.isArray(save.colonyPolicies) ? save.colonyPolicies : [])
      .filter(e => Array.isArray(e) && known.has(e[0]))
      .map(([id, p]) => [id, sanitizePolicy(p)])),
    laneSeq: num(save.laneSeq, 0),
    // Declared here, next to laneSeq, so this literal has the same shape createGalaxy's does.
    // It's REFILLED further down (lanes reference units, so they can only be rebuilt once every
    // planet is loaded) — but starting from the literal means a Galaxy is never momentarily
    // missing a field its own typedef requires.
    lanes: [],
  };
  let maxId = 0;
  for (const P of save.planets) {
    if (!known.has(P.planetId)) continue;                    // skip a planet payload with an unrecognised id
    const state = rehydratePlanet(P);
    // ...base recomputed from the SEED-generated nodes. `rehydratePlanet` above has already
    // re-added this world's wreck/crater nodes, which did NOT exist when the live book was
    // built at creation — createMarket skips exactly those (see its own comment), so this
    // reproduces the creation-time book rather than deriving a drifted one from a bigger
    // node set. That is why `base` needs no save slot of its own.
    state.market = createMarket(state);
    coerceBand(state.market.pressure, P.market.pressure, PRESSURE_FLOOR, PRESSURE_CEIL);   // ...then overlay the saved running pressure...
    if (P.market.glut) coerceBand(state.market.glut, P.market.glut, 0, GLUT_CEIL);          // ...and the slow produced-goods glut
    state.diplomacy = cleanDiplomacy(P.diplomacy);
    // DOMINATION WITH TEETH (engine/galaxy.js checkDomination): an old save's `galaxy.pacified`
    // (rebuilt above) can already list this world from before the diplomacy-side floor flag
    // existed. Re-stamp it here so updateDiplomacy's floor applies to every already-conquered
    // world on load, not just ones conquered after this feature shipped. Additive; no
    // GALAXY_SAVE_VERSION bump — a save that already carries the flag (P.diplomacy.pacified) is
    // unaffected, this only fills the gap for one that predates it.
    if (galaxy.pacified.has(P.planetId)) state.diplomacy.pacified = true;
    // dip.request (engine/diplomacy.js) carries a commodity id and three numbers straight off
    // untrusted save data — validate the shape (the same rule cargo/resources get elsewhere in
    // this file: `if (!COM[com]) …`) rather than trust it verbatim. An invalid/corrupt request is
    // simply dropped, same as a malformed cargo entry is nulled above — the world just rolls a
    // fresh one on its own schedule rather than the game trusting a hand-edited favor forever.
    const req = state.diplomacy.request;
    if (req && (typeof req !== "object" || !COM[req.com] || !(req.qty > 0) || !Number.isFinite(req.qty)
        || !(req.reward >= 0) || !Number.isFinite(req.reward) || !Number.isFinite(req.until)))
      state.diplomacy.request = null;
    state.background = !!P.background;
    state.inGalaxy = true;                                    // galaxy member → galaxy-wide defeat (engine/galaxy.js)
    galaxy.planets.set(P.planetId, state);
    maxId = Math.max(maxId, maxOwnEntityId(state));
  }
  if (!galaxy.planets.has(galaxy.activeId)) throw new Error("galaxy save has no active planet");
  const active = galaxy.planets.get(galaxy.activeId);
  active.background = false;                                // the seat is never a background world

  // Freight Lanes (engine/galaxy.js runLanes). Reconstructed AFTER every planet is loaded (a
  // lane's shipIds reference units on its `from` world) — kept only when the lane's worlds are
  // both real AND recognised, its commodity filter is real commodities, and each shipId is still
  // a live player freighter physically on the source world. Anything else (a hand-edited save, a
  // ship that got dropped by load-time entity coercion) is silently trimmed, exactly like
  // runLanes' own per-cycle validation does at runtime — this is just that same check run once at
  // load instead of waiting for the next scheduled lane tick.
  galaxy.lanes.length = 0;
  const takenLaneIds = new Set();
  let maxLaneNum = 0;
  for (const rl of (Array.isArray(save.lanes) ? save.lanes : [])) {
    if (!rl || typeof rl !== "object" || !known.has(rl.from) || !known.has(rl.to)) continue;
    const from = galaxy.planets.get(rl.from);
    if (!from) continue;
    const commodities = Array.isArray(rl.commodities) ? rl.commodities.filter(c => COM[c]) : [];
    // De-duplicate. assignShipToLane guards this at runtime (`if (!lane.shipIds.includes(unitId))`)
    // and runLanes sums capacity over shipIds WITHOUT deduping, so a repeated id multiplied the
    // lane's throughput — measured, one 250-hold hauler listed three times moved 750 ore per cycle.
    const seenShips = new Set();
    const shipIds = Array.isArray(rl.shipIds) ? rl.shipIds.filter(id => {
      if (seenShips.has(id)) return false;
      const u = from.units.get(id);
      if (!u || u.owner !== "player" || !(UNITS[u.type] && UNITS[u.type].cargoHold)) return false;
      seenShips.add(id);
      return true;
    }) : [];
    // A lane id must be unique: deleteLane/assignShipToLane/unassignShipFromLane all resolve by
    // find/findIndex on the id, so a second lane sharing one is permanently unreachable from the UI.
    let id = typeof rl.id === "string" && !takenLaneIds.has(rl.id) ? rl.id : "lane" + (++galaxy.laneSeq);
    while (takenLaneIds.has(id)) id = "lane" + (++galaxy.laneSeq);
    takenLaneIds.add(id);
    const idNum = /^lane(\d+)$/.exec(id);
    if (idNum) maxLaneNum = Math.max(maxLaneNum, +idNum[1]);
    const lane = { id, from: rl.from, to: rl.to, commodities, shipIds };
    for (const id2 of shipIds) from.units.get(id2).laneId = lane.id;
    galaxy.lanes.push(lane);
  }
  // Lift the counter past every id actually in use, exactly like maxOwnEntityId and maxGId above do
  // for their counters. Without it a save carrying "lane1" with laneSeq:0 minted "lane1" again on
  // the very next createLane, colliding with a live lane.
  galaxy.laneSeq = Math.max(galaxy.laneSeq, maxLaneNum);
  // The galaxy `entitySeq` is the SEPARATE "g"-id counter — ids minted as "g"+entitySeq in
  // engine/galaxy.js for entities that cross worlds (jump riders, relief + colony ships). Unlike the
  // u/b counter (hardened above via maxOwnEntityId), it was restored as num(save.entitySeq,0) with NO
  // recompute — so a save with a low/missing entitySeq but a LIVE "g" entity (an in-flight colony
  // ship / freighter / relief ship) would later mint a COLLIDING "g"-id and clobber it. Scan every
  // unit/building id across ALL worlds for the g-scheme and lift entitySeq past the highest, mirroring
  // how maxOwnEntityId hardens the u/b counter. Identity for a valid save — its entitySeq already
  // exceeds every g-id, so the max is a no-op. The next mint pre-increments (galaxy.js), so we lift to
  // the max itself (not +1): entitySeq === g5 ⇒ next id is "g6".
  let maxGId = 0;
  const scanG = id => { const s = /^g(\d+)$/.exec(String(id)); if (s) { const n = +s[1]; if (n > maxGId) maxGId = n; } };
  for (const state of galaxy.planets.values()) {
    for (const id of state.units.keys()) scanG(id);
    for (const id of state.buildings.keys()) scanG(id);
  }
  galaxy.entitySeq = Math.max(num(save.entitySeq, 0), maxGId);
  // Mint beyond both the saved counter and every loaded id across ALL worlds (see the
  // skirmish note) — identity for a valid save, collision-proof for a corrupt one.
  restoreEntityId(Math.max(num(save.nextEntityId, 0), maxId + 1));
  return galaxy;
}
