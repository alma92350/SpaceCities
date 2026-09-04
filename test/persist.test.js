import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeUnit } from "../engine/state.js";
import { mulberry32 } from "../engine/rng.js";
import { tick } from "../engine/sim.js";
import { issuePatrol } from "../engine/commands.js";
import { serializeGame, deserializeGame, serializeGalaxy, deserializeGalaxy, SAVE_VERSION, GALAXY_SAVE_VERSION } from "../engine/persist.js";
import { createGalaxy, stepGalaxy } from "../engine/galaxy.js";
import { sideMod, PLANET_MODIFIERS } from "../engine/map.js";

// The sim-owned facts, sorted by id so Map order can't matter — plus node
// amounts (mining) and fog memory, the dynamic bits a save has to preserve.
function snapshot(state) {
  const units = [...state.units.values()]
    .map(u => `${u.id}|${u.type}|${u.owner}|${u.x}|${u.y}|${u.hp}|${u.order ? u.order.type : "-"}`).sort();
  const builds = [...state.buildings.values()]
    .map(b => `${b.id}|${b.type}|${b.owner}|${b.hp}|${b.buildProgress}|${b.queue.length}`).sort();
  const res = JSON.stringify(state.players.player.resources) + JSON.stringify(state.players.ai.resources);
  const fog = state.fog.explored.reduce((a, v) => a + v, 0);
  const nodes = state.map.nodes.map(n => `${n.id}:${n.amount}`).sort().join(",");
  return JSON.stringify({ units, builds, res, fog, nodes,
    tick: state.tick, time: state.time, over: state.over, winner: state.winner });
}

test("a saved game round-trips through JSON to an identical state", () => {
  const a = createGameState({ planetId: "ferros", seed: 4242, rng: mulberry32(4242), aiMicro: true });
  for (let i = 0; i < 800; i++) tick(a, 0.1);   // build, fight, reveal fog, deplete nodes

  const b = deserializeGame(JSON.parse(JSON.stringify(serializeGame(a))));

  assert.equal(snapshot(b), snapshot(a), "the loaded state matches the saved one entity-for-entity");
});

test("a loaded game continues identically to the original — determinism survives the round-trip", () => {
  // Run the original fully FIRST (the id counter is module-global, so the two
  // states must not be ticked interleaved), capturing a save partway through.
  const a = createGameState({ planetId: "glacius", seed: 77, rng: mulberry32(77) });
  for (let i = 0; i < 500; i++) tick(a, 0.1);
  const save = serializeGame(a);
  for (let i = 0; i < 400; i++) tick(a, 0.1);   // original runs on to 900
  const original = snapshot(a);

  // Now reload from the mid-game save and run the SAME 400 ticks.
  const b = deserializeGame(save);               // restores the id counter to the save point
  for (let i = 0; i < 400; i++) tick(b, 0.1);

  assert.equal(snapshot(b), original, "the reloaded game replays the continuation exactly");
});

// T-034a — a human occupying seat "ai" (see test/ownerScaffold.test.js's own T-034a tests) must
// stay human-controlled across a save/reload, never silently regain a built-in computer AI.
test("aiEnabled:false round-trips as state.ai === null (T-034a)", () => {
  const a = createGameState({ planetId: "ferros", seed: 5, aiEnabled: false });
  const b = deserializeGame(JSON.parse(JSON.stringify(serializeGame(a))));
  assert.equal(b.ai, null, "reload must not silently regain a built-in AI for a seat a human is actually playing");
});

test("a save payload with no controllers.ai entry at all (predates T-034a) still restores a populated state.ai, not null (T-034a)", () => {
  const a = createGameState({ planetId: "ferros", seed: 6 });
  const save = serializeGame(a);
  delete save.controllers.ai;   // simulate a save file written before this field could ever be null
  const b = deserializeGame(save);
  assert.ok(b.ai, "an absent controllers.ai entry must default to a populated controller, not to null");
});

test("deserializeGame rejects an unknown save version", () => {
  assert.throws(() => deserializeGame({ v: 999 }), /unsupported save version/);
});

// Pick your side of the Oort/Nimbus asymmetric matchups (docs/improvement-proposals.md): an
// additive per-state field next to sizeMult/resourceMult (engine/state.js, engine/persist.js) —
// default false, no SAVE_VERSION bump. Proves the flag round-trips AND that the RELOADED map
// (rehydratePlanet re-runs generateMap from the seed) still carries the swapped assignment, not
// just a bare boolean disconnected from the map it's supposed to describe.
test("swapAsym round-trips through save/load with its swapped map modifiers intact", () => {
  const a = createGameState({ planetId: "oort", seed: 55, rng: mulberry32(55), swapAsym: true });
  assert.equal(sideMod(a, "player", "buildTimeMult"), PLANET_MODIFIERS.oort.asym.ai.buildTimeMult,
    "sanity: swapAsym really did exchange the asym halves on the fresh state");

  const b = deserializeGame(JSON.parse(JSON.stringify(serializeGame(a))));
  assert.equal(b.swapAsym, true, "the flag itself round-trips");
  assert.equal(sideMod(b, "player", "buildTimeMult"), PLANET_MODIFIERS.oort.asym.ai.buildTimeMult,
    "the reloaded map was regenerated WITH the swap honored, not the unswapped default");
});

test("swapAsym defaults to false, and a save from before this field existed loads as unswapped", () => {
  const a = createGameState({ planetId: "oort", seed: 56, rng: mulberry32(56) });
  assert.equal(a.swapAsym, false, "swapAsym defaults false when not requested");
  const save = serializeGame(a);
  delete save.swapAsym;   // simulate a pre-this-feature save
  const b = deserializeGame(save);
  assert.equal(b.swapAsym, false, "an old save without the field loads as unswapped, not throwing/undefined");
});

// Make the clock endgame visible, honest, and configurable (docs/improvement-proposals.md):
// setup.js's Match length row plumbs an explicit opts.matchTimeLimit through createGameState, and
// engine/victory.js's finish() records WHY a match ended. Both are additive fields next to
// winner/swapAsym — default null, no SAVE_VERSION bump.
test("matchTimeLimit round-trips through save/load, and an unrequested override still saves/loads as null (not the 40-minute default)", () => {
  const a = createGameState({ planetId: "ferros", seed: 57, rng: mulberry32(57), matchTimeLimit: 1200 });
  assert.equal(a.matchTimeLimit, 1200);
  const b = deserializeGame(JSON.parse(JSON.stringify(serializeGame(a))));
  assert.equal(b.matchTimeLimit, 1200, "the explicit override round-trips exactly");

  const c = createGameState({ planetId: "ferros", seed: 58, rng: mulberry32(58) });
  assert.equal(c.matchTimeLimit, null);
  const d = deserializeGame(JSON.parse(JSON.stringify(serializeGame(c))));
  assert.equal(d.matchTimeLimit, null, "no override requested ⇒ still null after a round-trip, not the resolved default");
});

test("matchTimeLimit is sanitized on load — a corrupt, zero, or negative value falls back to null rather than an instant/broken timeout", () => {
  const a = createGameState({ planetId: "ferros", seed: 59, rng: mulberry32(59) });
  for (const bogus of [0, -100, NaN, "not-a-number"]) {
    const save = serializeGame(a);
    save.matchTimeLimit = bogus;
    const loaded = deserializeGame(save);
    assert.equal(loaded.matchTimeLimit, null, `matchTimeLimit=${bogus} must sanitize to null, not a value that ends every match instantly`);
  }
});

test("a save from before matchTimeLimit/winReason existed loads with both null, not throwing/undefined", () => {
  const a = createGameState({ planetId: "ferros", seed: 60, rng: mulberry32(60) });
  const save = serializeGame(a);
  delete save.matchTimeLimit;
  delete save.winReason;
  const b = deserializeGame(save);
  assert.equal(b.matchTimeLimit, null);
  assert.equal(b.winReason, null);
});

test("winReason round-trips through save/load once a match actually ends", () => {
  const a = createGameState({ planetId: "ferros", seed: 61, rng: mulberry32(61) });
  a.over = true; a.winner = "player"; a.winReason = "elimination";
  const b = deserializeGame(JSON.parse(JSON.stringify(serializeGame(a))));
  assert.equal(b.over, true);
  assert.equal(b.winner, "player");
  assert.equal(b.winReason, "elimination", "the reason the match ended survives a save/load, not just the winner");
});

// Patrol (docs/improvement-proposals.md "Patrol: looping attack-move waypoints"): the order's
// `patrol` flag is a purely additive field on the existing order/orderQueue shapes persist.js
// already serializes (serPlanet's `...u` rest-spread keeps whatever an order object carries —
// see engine/persist.js), so this needs no dedicated persist.js code and no SAVE_VERSION bump,
// per CONTRIBUTING's additive-field rule — this test is the empirical proof of that claim.
// Doctrine depth redesign (docs/improvement-proposals.md, merged): unit.lastHitAt (engine/
// combat.js performAttack/applySplash) is the gate Bulwark's out-of-combat regen (engine/repair.js
// updateBulwarkRegen) reads. Additive numeric state — CONTRIBUTING.md says this shouldn't need a
// SAVE_VERSION bump, verified empirically (not assumed) with a real round trip, plus the
// corruption-hardening half every other untrusted numeric field (facing, fuseUntil, lastLanding)
// already gets in cleanEntity.
test("a unit's lastHitAt round-trips through save/load exactly", () => {
  const state = createGameState({ planetId: "ferros", seed: 71, rng: mulberry32(71) });
  const skiff = makeUnit("skiff", "player", 500, 500);
  skiff.lastHitAt = 42.5;
  state.units.set(skiff.id, skiff);

  const loaded = deserializeGame(JSON.parse(JSON.stringify(serializeGame(state))));
  const reloaded = loaded.units.get(skiff.id);

  assert.ok(reloaded, "the unit itself survived the round-trip");
  assert.equal(reloaded.lastHitAt, 42.5, "lastHitAt survives exactly — an additive field, no SAVE_VERSION bump needed");
});

test("a tampered lastHitAt is dropped on load rather than propagated as NaN-poisoning garbage", () => {
  const state = createGameState({ planetId: "ferros", seed: 72, rng: mulberry32(72) });
  const skiff = makeUnit("skiff", "player", 500, 500);
  skiff.lastHitAt = 10;
  state.units.set(skiff.id, skiff);

  const save = serializeGame(state);
  const savedSkiff = save.units.find(u => u.id === skiff.id);
  savedSkiff.lastHitAt = "a while ago";   // a hand-edited save smuggling in garbage

  const loaded = deserializeGame(save);
  assert.equal(loaded.units.get(skiff.id).lastHitAt, undefined,
    "dropped, not left as a string that would NaN-poison state.time - lastHitAt in the Bulwark regen pass");
});

// Veterancy ranks (docs/improvement-proposals.md): unit.kills (engine/combat.js performAttack)
// is an additive numeric field — same CONTRIBUTING.md "no SAVE_VERSION bump needed" rule as
// lastHitAt above, verified empirically rather than assumed, plus the same corruption-hardening
// treatment (a tampered save clamped to a sane non-negative integer, not propagated as garbage
// into rankMults' kills comparisons).
test("a unit's kills round-trips through save/load exactly", () => {
  const state = createGameState({ planetId: "ferros", seed: 73, rng: mulberry32(73) });
  const skiff = makeUnit("skiff", "player", 500, 500);
  skiff.kills = 5;
  state.units.set(skiff.id, skiff);

  const loaded = deserializeGame(JSON.parse(JSON.stringify(serializeGame(state))));
  const reloaded = loaded.units.get(skiff.id);

  assert.ok(reloaded, "the unit itself survived the round-trip");
  assert.equal(reloaded.kills, 5, "kills survives exactly — an additive field, no SAVE_VERSION bump needed");
});

test("a tampered kills value is clamped to a sane non-negative integer on load, not propagated as garbage", () => {
  const state = createGameState({ planetId: "ferros", seed: 74, rng: mulberry32(74) });
  const skiff = makeUnit("skiff", "player", 500, 500);
  state.units.set(skiff.id, skiff);

  const save = serializeGame(state);
  const savedSkiff = save.units.find(u => u.id === skiff.id);
  savedSkiff.kills = -7.4;   // a hand-edited save smuggling in garbage

  const loaded = deserializeGame(save);
  assert.equal(loaded.units.get(skiff.id).kills, 0, "clamped to a sane floor, not left negative/fractional");
});

test("a patrol order's flag round-trips through save/load with no dedicated persist.js code", () => {
  const state = createGameState({ planetId: "ferros", seed: 99, rng: mulberry32(99) });
  const skiff = makeUnit("skiff", "player", 700, 500);
  state.units.set(skiff.id, skiff);
  issuePatrol([skiff], [{ x: 750, y: 500 }, { x: 750, y: 400 }]);

  const loaded = deserializeGame(JSON.parse(JSON.stringify(serializeGame(state))));
  const reloaded = loaded.units.get(skiff.id);

  assert.ok(reloaded, "the patrolling unit itself survived the round-trip");
  assert.equal(reloaded.order.patrol, true, "the active leg's patrol flag survives — persist.js's order serialization is a generic rest-spread, not a field allowlist");
  assert.equal(reloaded.orderQueue.length, skiff.orderQueue.length,
    "the whole queue length (including the trailing copy of the active leg — see test/commands.test.js) is preserved");
  assert.ok(reloaded.orderQueue.every(o => o.patrol === true), "every queued leg's patrol flag survives too");
});

test("every AI-controller bookkeeping field survives a save/load round trip (C9)", () => {
  // Dropping aiColonyTarget, aiLastThreatAt, or the ENTIRE playerAi block from persist.js used to
  // survive the full suite. (aiWaveCount and a wonder's charge were both killed by it, so the
  // per-field round-trip pattern existed — it just stopped short.) Each carries a comment in
  // persist.js explaining why losing it is a bug: aiColonyTarget is "the committed deploy spot of an
  // in-flight ship. Persisted so a reload doesn't recompute a different target". The failure mode is
  // "the AI behaves differently after reload" — the hardest class of bug to report.
  const st0 = createGameState({ planetId: "ferros", seed: 77, rng: mulberry32(77) });
  Object.assign(st0.ai, {
    think: 0.9, scoutId: null, colonyTarget: { x: 321, y: 210 }, apm: 90, micro: true,
    strategy: "aggressive", difficulty: "hard", lastThreatAt: 12.5, actionBudget: 3,
    attackForce: 5, attackDesperate: true, nextAttackAt: 44, unitsBuilt: 7, waveCount: 2,
  });
  const st = deserializeGame(serializeGame(st0));
  for (const f of ["think", "colonyTarget", "apm", "micro", "strategy", "difficulty", "lastThreatAt",
                   "actionBudget", "attackForce", "attackDesperate", "nextAttackAt", "unitsBuilt", "waveCount"])
    assert.deepEqual(st.ai[f], st0.ai[f], `state.ai.${f} must round-trip`);
});

/* ---- T2: the round-trip tests are structurally blind to a FORGOTTEN field --------------------
   The two NET tests compare serialize→load→serialize. A field serPlanet never writes is absent from
   both sides, so the comparison passes — which is exactly how galaxy.rivalAscended shipped
   unpersisted. A denylist over the live shape can express "forgotten"; a round-trip cannot. */

const TRANSIENT_STATE = new Set([
  "map",        // regenerated from the seed — that's the whole point of a seed-driven save
  "owners",     // derived from the world's own roster
  "fogs",       // per-owner alias block; the two fogs themselves ARE persisted, under "fogs" itself
  // T-045: fog/fogAI and ai/playerAi are ALIASES (engine/state.js's own convention) into fogs.*/
  // controllers.* — "fogs"/"controllers" ARE the real persisted N-keyed containers (both now
  // reach the wire under their own name, unlike the pre-T-045 ai:/playerAi:/fog:/fogAI: pair),
  // so only the alias NAMES need declaring transient, not the containers themselves.
  "fog", "fogAI", "ai", "playerAi",
  "selection",  // a UI concern, deliberately not restored
  "events",     // per-tick outbox, drained by the view
  "unitGrid",   // broad-phase index, rebuilt every tick (engine/grid.js)
  "anvils",     // per-tick Aegis index (engine/sim.js collectAnvils)
]);

test("every field on a live State is either persisted or on the documented transient denylist (T2)", () => {
  const st = createGameState({ planetId: "ferros", seed: 61, rng: mulberry32(61) });
  for (let i = 0; i < 300; i++) tick(st, 0.1);       // let the lazily-attached fields appear
  const payload = serializeGame(st);
  const missing = Object.keys(st).filter(k => !(k in payload) && !TRANSIENT_STATE.has(k));
  assert.deepEqual(missing, [],
    "State field(s) neither saved nor declared transient — add them to the payload, or to " +
    "TRANSIENT_STATE above with a one-line reason:\n" + missing.join("\n"));
});

const TRANSIENT_GALAXY = new Set([
  "planets",          // serialized separately, per world
  "colonyNotes", "pacifyNotes", "milestones", "expansionNotes", "rivalGateNotes",   // transient UI queues
  "rivalGate",        // the world currently being TRACKED; re-derived by checkRivalGate on the next scan
  "surrendered",      // set only at the moment a run is abandoned
]);

test("every field on a live Galaxy is either persisted or on the documented transient denylist (T2)", () => {
  // This is the general net that would have caught rivalAscended. Verified: removing it from
  // galaxyPayload makes this fail by name.
  const g = createGalaxy({ seed: 62 });
  for (let i = 0; i < 200; i++) stepGalaxy(g, 0.1);
  // A couple of fields ship under a different WIRE key than their live name, so the payload is
  // checked through that alias rather than by pretending they're transient.
  const WIRE_ALIAS = { tick: "galaxyTick", time: "galaxyTime" };
  const payload = serializeGalaxy(g);
  const missing = Object.keys(g)
    .filter(k => !((WIRE_ALIAS[k] || k) in payload) && !TRANSIENT_GALAXY.has(k));
  assert.deepEqual(missing, [],
    "Galaxy field(s) neither saved nor declared transient:\n" + missing.join("\n"));
});

/* ---- T3: the two save versions gate ONE shared per-planet shape ------------------------------
   gamePayload stamps `v: SAVE_VERSION`, galaxyPayload stamps `v: GALAXY_SAVE_VERSION`, and the
   galaxy embeds `...serPlanet(state)` per planet with NO per-planet `v`. So an incompatible change
   to the SHARED shape needs both numbers bumped, and nothing said so: bump only SAVE_VERSION and an
   Odyssey save passes its own version gate and then feeds stale-shaped planet payloads into
   rehydratePlanet — the precise failure the exact-match gate exists to prevent (CONTRIBUTING §3).
   These two guards make that coupling executable. Delete the second one only when the galaxy
   payload starts stamping its own per-planet version. */

test("the galaxy's per-planet payload has the same shape as a skirmish save's (T3)", () => {
  const st = createGameState({ planetId: "ferros", seed: 88, rng: mulberry32(88) });
  const g = createGalaxy({ seed: 88 });
  const skirmish = serializeGame(st);
  const planet = serializeGalaxy(g).planets[0];

  // The skirmish payload adds the two whole-save fields; the galaxy planet adds its own per-world
  // layers. Everything else is serPlanet's shared output and must match key-for-key.
  const SKIRMISH_ONLY = new Set(["v", "nextEntityId"]);
  const GALAXY_ONLY = new Set(["background", "market", "diplomacy"]);
  const a = Object.keys(skirmish).filter(k => !SKIRMISH_ONLY.has(k)).sort();
  const b = Object.keys(planet).filter(k => !GALAXY_ONLY.has(k)).sort();
  assert.deepEqual(b, a,
    "the shared per-planet payload drifted between the two savers — serPlanet feeds both, so a " +
    "field added to one path and not the other means one of them silently stops round-tripping");
});

test("GALAXY_SAVE_VERSION must be bumped alongside SAVE_VERSION while serPlanet is shared (T3)", () => {
  assert.equal(GALAXY_SAVE_VERSION, SAVE_VERSION,
    "these two gate the SAME per-planet shape (galaxyPayload embeds serPlanet with no per-planet " +
    "`v`), so bumping one without the other lets an Odyssey save pass its version check and then " +
    "feed stale-shaped planets into rehydratePlanet. Delete this assertion only when the galaxy " +
    "payload stamps its own per-planet version.");
});

/* ---------------------------------------------------------------------------------------------
   PAYLOAD-LEVEL ROUND TRIP — the guard that covers the fields nobody has thought of yet.

   Every field-specific round-trip test above (swapAsym, matchTimeLimit, popCap, winReason,
   lastHitAt, …) exists because someone remembered to write it when they added the field. That is
   coverage by recollection: it says nothing about the NEXT field, and the failure mode it guards
   against — serPlanet writes a field, rehydratePlanet never reads it, so the value silently
   resets on load — is invisible to `snapshot()` above, which compares a hand-listed subset.

   This compares the whole payload instead: save, load, save again, and require the two payloads
   to be identical. Any field that is written but not read shows up as a diff, automatically, the
   first time someone adds one. docs/code-improvement-tiers.md proposed a declarative {key, ser,
   clean} field table for the same reason; this delivers the property that table was for, without
   a rewrite of code where every field's sanitizer is deliberately different (popCap and
   matchTimeLimit must NOT go through num(), sizeMult must, swapAsym is a bare coercion) and the
   comments explaining why are the most valuable thing in the file.
   --------------------------------------------------------------------------------------------- */

// Deep, key-order-independent difference between two payloads, as a list of dotted paths. Key
// ORDER is deliberately ignored: it is a property of the object literals, not of what a save
// preserves, and locking it would fail on a harmless reordering while missing every real bug.
function diffPaths(a, b, path = "", out = []) {
  if (a === b) return out;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    if (a !== b) out.push(`${path || "<root>"}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
    return out;
  }
  if (Array.isArray(a) !== Array.isArray(b)) { out.push(`${path}: array/object mismatch`); return out; }
  if (Array.isArray(a) && a.length !== b.length) { out.push(`${path}.length: ${a.length} -> ${b.length}`); return out; }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffPaths(a[k], b[k], path ? `${path}.${k}` : k, out);
  return out;
}

test("a save survives a full round trip field-for-field, not just in the fields someone listed", () => {
  // A deliberately BUSY state: 800 ticks of a micro-AI match builds and loses buildings, moves
  // and kills units, mines nodes down, reveals fog, fills queues and banks resources — so the
  // payload actually carries most of what it can carry, rather than a pristine opening position
  // where half the fields are still at their defaults and would round-trip by accident.
  const a = createGameState({ planetId: "ferros", seed: 5150, rng: mulberry32(5150), aiMicro: true });
  a.matchTimeLimit = 1500;   // the two additive null-by-default overrides, explicitly set, so
  a.popCap = 90;             // "preserved" is distinguishable from "defaulted back to null"
  for (let i = 0; i < 800; i++) tick(a, 0.1);

  const first = serializeGame(a);
  const second = serializeGame(deserializeGame(JSON.parse(JSON.stringify(first))));

  // A diff-based test passes trivially against an empty payload, so pin that the fixture really
  // is busy before trusting the comparison — same failure mode the panel golden's own fixture
  // guard exists for.
  assert.ok(first.units.length >= 4, `expected a populated save, got ${first.units.length} units`);
  assert.ok(first.buildings.length >= 2, `expected several buildings, got ${first.buildings.length}`);
  assert.equal(first.popCap, 90, "and the explicitly-set overrides really reached the payload");
  assert.equal(first.matchTimeLimit, 1500);

  assert.deepEqual(diffPaths(first, second), [],
    "a field written by serPlanet but never read back by rehydratePlanet resets silently on load");
});

test("the same holds for a galaxy save", () => {
  // Same reasoning one level up: galaxyPayload/deserializeGalaxy have their own additive fields
  // (lanes, rivalAscended, colony policies, the per-world settings), added the same way and with
  // the same "written but never read" failure available to each.
  const g = createGalaxy({ seed: 909, rng: mulberry32(909) });
  for (let i = 0; i < 60; i++) stepGalaxy(g, 1);

  const first = serializeGalaxy(g);
  const second = serializeGalaxy(deserializeGalaxy(JSON.parse(JSON.stringify(first))));

  assert.ok(first.worlds.length >= 2, `expected a real galaxy, got ${first.worlds?.length} worlds`);

  assert.deepEqual(diffPaths(first, second), [],
    "a galaxy field written but never read back resets silently on load");
});

/* ============================================================
   T-045 (ADR-0008): N-fog / N-controller save shape; SAVE_VERSION -> 2.

   The wire format itself was the one deliberately deferred piece of every earlier Phase 5 task
   — state.js/persist.js's own comments each name this task by number. Replaces the fixed
   fog:/fogAI: pair with a single N-keyed fogs: {ownerId: [...]}, and the fixed ai:/playerAi:
   pair (with their aiXxx/paXxx-prefixed field names, needed only to keep two flat sibling keys
   from colliding) with a single N-keyed controllers: {ownerId: {...}|null}, whose per-owner
   field names no longer need a prefix at all — each is already nested under its own key. This
   is the one INTENTIONALLY BREAKING wire change in this whole port (every other Phase 5 task
   was purely additive to the live state, never the save shape) — ADR-0008 and TASKS.md's own
   Phase 5 preamble both call it out by name in advance. A v1 save is REJECTED, not migrated:
   deserializeGame's existing `save.v !== SAVE_VERSION` check already throws on ANY mismatch, so
   bumping SAVE_VERSION to 2 makes that the version gate for free — rehydratePlanet never needs
   to understand the old shape at all, since the check runs before it's ever called.
   ============================================================ */

function ownerDefsN(n) {
  const ids = ["player", "ai", "rebels", "raiders", "outcasts", "syndicate"];
  const colors = ["#4fd1ff", "#f87171", "#fbbf24", "#a78bfa", "#34d399", "#fb7185"];
  return ids.slice(0, n).map((id, i) => ({ id, faction: "neutral", isAI: id !== "player", color: colors[i] }));
}

test("T-045: SAVE_VERSION is 2", () => {
  assert.equal(SAVE_VERSION, 2);
});

test("T-045: a v1-shaped save is rejected cleanly, not migrated or silently misread", () => {
  const v1Save = { v: 1, seed: 1, planetId: "ferros", time: 0, tick: 0, over: false, winner: null,
    players: { player: {}, ai: {} }, units: [], buildings: [], nodes: [],
    fog: [], fogAI: [], ai: null, playerAi: null };
  assert.throws(() => deserializeGame(v1Save), /unsupported save version/,
    "a well-formed OLD-shape save must be refused outright, exactly like any other unknown version");
});

test("T-045: the wire payload is N-keyed — fogs: and controllers:, not the old fixed fog:/fogAI:/ai:/playerAi: pair", () => {
  const state = createGameState({ planetId: "ferros", seed: 1, ownerDefs: ownerDefsN(4) });
  const save = serializeGame(state);
  assert.deepEqual(Object.keys(save.fogs).sort(), ["ai", "player", "raiders", "rebels"]);
  assert.deepEqual(Object.keys(save.controllers).sort(), ["ai", "player", "raiders", "rebels"]);
  assert.equal("fog" in save, false, "the old singular fog: key must not survive onto the wire");
  assert.equal("fogAI" in save, false, "the old fogAI: key must not survive onto the wire");
  assert.equal("ai" in save, false, "the old top-level ai: key must not survive onto the wire");
  assert.equal("playerAi" in save, false, "the old top-level playerAi: key must not survive onto the wire");
});

test("T-045: a real 4-owner match round-trips completely — units, buildings, resources, fog, and every controller", () => {
  const state = createGameState({ planetId: "ferros", seed: 12, rng: mulberry32(12), ownerDefs: ownerDefsN(4) });
  for (let i = 0; i < 40; i++) tick(state, 0.1);
  // Give every AI-controlled owner some real bookkeeping to lose if the round-trip is wrong.
  for (const id of state.owners) {
    if (state.controllers[id]) Object.assign(state.controllers[id], { think: 0.4, waveCount: 3, actionBudget: 2 });
  }
  const loaded = deserializeGame(serializeGame(state));

  assert.deepEqual(loaded.owners, state.owners, "the owner roster and its order must survive exactly");
  for (const id of state.owners) {
    assert.deepEqual(loaded.players[id].resources, state.players[id].resources, `${id}: resources must round-trip`);
    assert.equal(loaded.fogs[id].explored.reduce((a, v) => a + v, 0), state.fogs[id].explored.reduce((a, v) => a + v, 0),
      `${id}: explored fog cell count must round-trip`);
    if (state.controllers[id]) {
      assert.ok(loaded.controllers[id], `${id}: an AI-driven seat's controller must survive at all`);
      for (const f of ["think", "waveCount", "actionBudget"])
        assert.equal(loaded.controllers[id][f], state.controllers[id][f], `${id}: controller.${f} must round-trip`);
    } else {
      assert.equal(loaded.controllers[id], null, `${id}: a human-driven seat must stay null, never regain a synthetic AI`);
    }
  }
  const unitsBy = s => [...s.units.values()].map(u => `${u.id}|${u.owner}|${u.type}`).sort();
  assert.deepEqual(unitsBy(loaded), unitsBy(state), "every owner's units must survive, not just the original pair's");
});

test("T-045: state.ai / state.playerAi (the live T-042 aliases) still resolve correctly for the default 2-owner case after the wire change", () => {
  const state = createGameState({ planetId: "ferros", seed: 13 });
  state.playerAi = { apm: 90, micro: true, strategy: "aggressive", difficulty: "hard",
    think: 0, scoutId: null, colonyTarget: null, lastThreatAt: null, actionBudget: 0,
    attackForce: 0, attackDesperate: false, nextAttackAt: null, unitsBuilt: 0, waveCount: 0,
    nextWaveAt: null, intelMil: 0, intelEco: 0, intelMilAt: null, intelEcoAt: null, intelAt: null, adaptMode: null };
  const loaded = deserializeGame(serializeGame(state));
  assert.ok(loaded.ai, "state.ai must still resolve through the live alias into controllers.ai");
  assert.ok(loaded.playerAi, "state.playerAi must still resolve through the live alias into controllers.player");
  assert.equal(loaded.playerAi.strategy, "aggressive");
});
