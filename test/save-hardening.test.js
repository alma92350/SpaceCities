/* ============================================================
   Load-path hardening (Tier 1 review fixes). sanitizeSave() proves a payload is plain,
   bounded JSON; these tests prove the NEXT layer — that a version-valid but hostile or
   merely corrupt save can't wedge or silently poison the sim. A hand-edited file (or a
   storage-corrupted autosave) can carry an unknown entity type, a string/NaN/out-of-range
   number, a low id counter, or a bogus world roster; each used to slip past load and only
   detonate on the first tick (inside the rAF loop, after load's try/catch returned), or
   inject markup into the starmap. The deserializers now defend the boundary.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeUnit, makeBuilding, peekEntityId, createAiController } from "../engine/state.js";
import { UNITS, UPGRADES } from "../engine/entities.js";
import { TECHS } from "../engine/techtree.js";
import { mulberry32 } from "../engine/rng.js";
import { tick } from "../engine/sim.js";
import { updateProductionQueue } from "../engine/production.js";
import { serializeGame, deserializeGame, serializeGalaxy, deserializeGalaxy, GALAXY_SAVE_VERSION } from "../engine/persist.js";
import { updateService } from "../engine/haul.js";
import { createGalaxy, activeState, stepGalaxy, checkGalaxyRescue, ODYSSEY_WORLDS } from "../engine/galaxy.js";
import { deployColonyShip } from "../engine/colony.js";
import { COM } from "../data.js";

// A short, real skirmish save to tamper with. Run FIRST and fully (the id counter is
// module-global) before any assertion mints ids, so the counter reflects this state.
function freshSkirmishSave(seed = 1) {
  const a = createGameState({ planetId: "ferros", seed, rng: mulberry32(seed), aiMicro: true });
  for (let i = 0; i < 120; i++) tick(a, 0.1);
  return serializeGame(a);
}
const maxNumericId = state => {
  let m = 0;
  for (const id of [...state.units.keys(), ...state.buildings.keys()]) {
    const s = /^[ub](\d+)$/.exec(id); if (s && +s[1] > m) m = +s[1];
  }
  return m;
};

test("an unknown entity type is dropped on load instead of crashing the first tick", () => {
  const save = freshSkirmishSave(11);
  const goodUnitId = save.units[0].id;
  save.units.push({ id: "u999999", type: "notarealunit", owner: "player", x: 100, y: 100, hp: 50, maxHp: 50, order: null, orderQueue: [] });
  save.buildings.push({ id: "b999999", type: "notarealbuilding", owner: "player", x: 120, y: 120, hp: 50, maxHp: 50, queue: [], constructing: false, buildProgress: 1 });

  const st = deserializeGame(save);
  assert.ok(!st.units.has("u999999"), "unknown unit type is not loaded (UNITS[type] would be undefined and throw)");
  assert.ok(!st.buildings.has("b999999"), "unknown building type is not loaded");
  assert.ok(st.units.has(goodUnitId), "a real entity beside it still loads");
  assert.doesNotThrow(() => { for (let i = 0; i < 5; i++) tick(st, 0.1); }, "the sim ticks cleanly — no undefined-def throw");
});

test("a corrupt production queue is sanitised on load and never bricks the game (B2)", () => {
  const save = freshSkirmishSave(13);
  const cc = save.buildings.find(b => b.type === "command" && b.owner === "player");
  // A real job, a bogus-unitType job (would deref undefined.buildTime and throw on EVERY tick →
  // bricked autosave), and an out-of-range progress.
  cc.queue = [{ unitType: "worker", progress: 0.5 }, { unitType: "☠notaunit", progress: 999 }];
  // A producer building whose queue isn't even an array must load as an empty queue, not blow up.
  save.buildings.push({ id: "b888888", type: "barracks", owner: "player", x: 240, y: 240,
    hp: 500, maxHp: 500, constructing: false, buildProgress: 1, queue: "haxx",
    attackTimer: 0, targetId: null, rally: { x: 240, y: 240 } });

  const st = deserializeGame(save);
  const cc2 = [...st.buildings.values()].find(b => b.owner === "player" && b.type === "command");
  assert.ok(cc2.queue.every(j => UNITS[j.unitType]), "no bogus unitType survived the load");
  assert.ok(cc2.queue.every(j => j.progress >= 0 && j.progress <= 1), "progress clamped to [0,1]");
  assert.ok(cc2.queue.some(j => j.unitType === "worker"), "the real job was kept");
  assert.deepEqual(st.buildings.get("b888888").queue, [], "a non-array queue became an empty array");
  assert.doesNotThrow(() => { for (let i = 0; i < 30; i++) tick(st, 0.1); }, "the loaded game ticks cleanly — no undefined-def brick");
});

test("updateProductionQueue drops an unknown-unitType job instead of crashing (B2 runtime guard)", () => {
  const s = createGameState({ planetId: "ferros", seed: 3, rng: mulberry32(3) });
  const cc = [...s.buildings.values()].find(b => b.owner === "player" && b.type === "command");
  cc.queue = [{ unitType: "notaunit", progress: 0 }, { unitType: "worker", progress: 0 }];
  assert.doesNotThrow(() => updateProductionQueue(s, cc, 0.1));
  assert.equal(cc.queue[0]?.unitType, "worker", "the bogus job was shifted off; the real one advances");
});

test("string / non-finite / out-of-range numeric fields are coerced, not propagated", () => {
  const save = freshSkirmishSave(12);
  save.time = "100";                                   // a string where a number belongs
  const u = save.units[0];
  u.x = 1e12;                                          // far past the map — must clamp
  u.y = "NaN";                                         // non-numeric string → 0
  u.hp = -5;                                           // negative → clamped to 0

  const st = deserializeGame(save);
  assert.equal(typeof st.time, "number");
  assert.equal(st.time, 100, "time is a number, so state.time += dt adds instead of concatenating");
  const cu = st.units.get(u.id);
  assert.ok(Number.isFinite(cu.x) && cu.x >= 0 && cu.x <= st.map.width, "x clamped into the map, never NaN/huge");
  assert.ok(Number.isFinite(cu.y), "y coerced to a finite number (no NaN,NaN spatial-hash bucket)");
  assert.equal(cu.hp, 0, "hp clamped to >= 0");

  // Time keeps advancing as a number (the concrete bug: "100"+0.1 = "1000.1", then unbounded).
  const before = st.time;
  tick(st, 0.1);
  assert.ok(st.time > before && Number.isFinite(st.time), "time advances numerically after load");
});

test("a low or missing nextEntityId can't mint an id that collides with a loaded entity", () => {
  const save = freshSkirmishSave(13);
  const highest = maxNumericId(deserializeGame(freshSkirmishSave(13)));  // what the live state actually holds
  assert.ok(highest > 0, "the save has real u#/b# ids");

  save.nextEntityId = 1;                               // sabotage: counter far below live ids
  const st = deserializeGame(save);
  assert.ok(peekEntityId() > maxNumericId(st), "the restored counter mints beyond every loaded id");
  const minted = makeUnit("skiff", "player", 50, 50);
  assert.ok(!st.units.has(minted.id), "a freshly minted id doesn't collide with a restored entity");

  const save2 = freshSkirmishSave(13);
  delete save2.nextEntityId;                           // missing entirely
  const st2 = deserializeGame(save2);
  assert.ok(peekEntityId() > maxNumericId(st2), "a missing counter is recomputed from the loaded ids");
});

test("aiWaveCount round-trips (continue-identically for the economy-raid cadence)", () => {
  const a = createGameState({ planetId: "ferros", seed: 9, rng: mulberry32(9), aiMicro: true });
  for (let i = 0; i < 50; i++) tick(a, 0.1);
  a.ai.waveCount = 7;
  const st = deserializeGame(serializeGame(a));
  assert.equal(st.ai.waveCount, 7, "the committed-wave counter survives a save/reload");

  const save = serializeGame(a);
  delete save.controllers.ai.waveCount;                // an old save predating the field
  assert.equal(deserializeGame(save).ai.waveCount, 0, "an old save loads with the counter defaulted to 0");
});

/* ---------- galaxy structural + roster guards ---------- */

function settledGalaxy(seed = 3) {
  const g = createGalaxy({ seed });
  for (const u of [...activeState(g).units.values()]) if (u.type === "colonyship") deployColonyShip(activeState(g), u.id);
  return g;
}

test("deserializeGalaxy throws on structural nonsense BEFORE the caller tears down the live game", () => {
  assert.throws(() => deserializeGalaxy({ v: GALAXY_SAVE_VERSION, worlds: [], planets: [{ planetId: "ferros" }] }), /no worlds/);
  assert.throws(() => deserializeGalaxy({ v: GALAXY_SAVE_VERSION, worlds: ["ferros"], planets: [] }), /no planets/);

  const save = JSON.parse(JSON.stringify(serializeGalaxy(settledGalaxy(3))));
  // The living galaxy instantiates every world, so manufacture an orphan: drop one world's payload,
  // then point activeId at it — a real world id with no planet payload.
  const orphanWorld = save.planets[save.planets.length - 1].planetId;
  save.planets = save.planets.filter(p => p.planetId !== orphanWorld);
  save.activeId = orphanWorld;
  assert.throws(() => deserializeGalaxy(save), /no active planet/,
    "an activeId with no planet fails at load, not after boot has torn the session down");
});

test("the world roster is filtered to real worlds — an injected id never survives load", () => {
  const save = JSON.parse(JSON.stringify(serializeGalaxy(settledGalaxy(4))));
  save.worlds.push("<img src=x onerror=alert(1)>");     // XSS payload smuggled into the roster
  save.worlds.push("totally-made-up-world");
  const g = deserializeGalaxy(save);
  assert.ok(!g.worlds.includes("<img src=x onerror=alert(1)>"), "the markup id is dropped");
  assert.ok(g.worlds.every(w => ODYSSEY_WORLDS.includes(w)), "every surviving world id is a known world (nothing reaches the starmap)");
});

test("the galaxy clock and last-relief time round-trip", () => {
  const g = settledGalaxy(5);
  g.time = 55.5;
  g.lastReliefTime = 40;
  const g2 = deserializeGalaxy(JSON.parse(JSON.stringify(serializeGalaxy(g))));
  assert.equal(g2.time, 55.5, "galaxy.time persists (the relief cooldown keys on it)");
  assert.equal(g2.lastReliefTime, 40, "lastReliefTime persists so the cooldown survives a reload");
});

/* ---------- Tier 4b hardening: a favor request (engine/diplomacy.js) carries a commodity id and
   three numbers straight off untrusted save data — the same "commodity id used as a dynamic key"
   shape cargo/resources already get validated for elsewhere in this file. ---------- */

test("a well-formed favor request round-trips exactly; one naming a bogus commodity is dropped entirely", () => {
  const save = JSON.parse(JSON.stringify(serializeGalaxy(settledGalaxy(6))));
  const planet = save.planets.find(p => p.planetId === save.activeId);
  planet.diplomacy.request = { com: "ore", qty: 50, until: 999, reward: 321 };
  const g = deserializeGalaxy(save);
  assert.deepEqual(activeState(g).diplomacy.request, { com: "ore", qty: 50, until: 999, reward: 321 },
    "a legitimately-saved request is left exactly as-is (identity)");

  const save2 = JSON.parse(JSON.stringify(serializeGalaxy(settledGalaxy(6))));
  const planet2 = save2.planets.find(p => p.planetId === save2.activeId);
  planet2.diplomacy.request = { com: "☠notacommodity", qty: 50, until: 999, reward: 321 };
  const g2 = deserializeGalaxy(save2);
  assert.equal(activeState(g2).diplomacy.request, null, "a request naming an unknown commodity is dropped, not trusted verbatim");
});

test("a favor request with a nonsense quantity or reward is dropped on load rather than trusted verbatim", () => {
  const save = JSON.parse(JSON.stringify(serializeGalaxy(settledGalaxy(6))));
  const planet = save.planets.find(p => p.planetId === save.activeId);
  planet.diplomacy.request = { com: "ore", qty: -50, until: 999, reward: 321 };   // negative qty
  const g = deserializeGalaxy(save);
  assert.equal(activeState(g).diplomacy.request, null, "a non-positive qty is dropped");

  const save2 = JSON.parse(JSON.stringify(serializeGalaxy(settledGalaxy(6))));
  const planet2 = save2.planets.find(p => p.planetId === save2.activeId);
  planet2.diplomacy.request = { com: "ore", qty: 50, until: 999, reward: "not a number" };
  const g2 = deserializeGalaxy(save2);
  assert.equal(activeState(g2).diplomacy.request, null, "a non-numeric reward is dropped");
});

/* ---------- Tier-1b hardening: wonder charge, order/cargo, g-id counter, research queue, transient strip ---------- */

test("a wonder's charge is clamped into [0,1] on load — a hand-edited charge can't slip in (B3)", () => {
  const save = freshSkirmishSave(21);
  // Smuggle a completed Antimatter Gate (the wonder) with an over-range charge — a hand-edit that,
  // left unchecked, reads as "already fully charged" (engine/victory.js checkEndlessWin fires at
  // charge >= 1). Alongside it, a Gate at a VALID mid-charge that must round-trip untouched (identity).
  save.buildings.push({ id: "b777777", kind: "building", type: "antimatter_gate", owner: "player",
    x: 300, y: 300, hp: 1200, maxHp: 1200, constructing: false, buildProgress: 1, queue: [], charge: 5 });
  save.buildings.push({ id: "b777778", kind: "building", type: "antimatter_gate", owner: "player",
    x: 360, y: 360, hp: 1200, maxHp: 1200, constructing: false, buildProgress: 1, queue: [], charge: 0.4 });

  const st = deserializeGame(save);
  assert.equal(st.buildings.get("b777777").charge, 1, "an over-range charge (5) clamps to the [0,1] ceiling");
  assert.equal(st.buildings.get("b777778").charge, 0.4, "a legitimately-saved charge is left exactly as-is (identity)");

  // A negative and a non-numeric charge are coerced too.
  const save2 = freshSkirmishSave(22);
  save2.buildings.push({ id: "b777779", kind: "building", type: "antimatter_gate", owner: "player",
    x: 300, y: 300, hp: 1200, maxHp: 1200, constructing: false, buildProgress: 1, queue: [], charge: -3 });
  save2.buildings.push({ id: "b777780", kind: "building", type: "antimatter_gate", owner: "player",
    x: 340, y: 340, hp: 1200, maxHp: 1200, constructing: false, buildProgress: 1, queue: [], charge: "9" });
  const st2 = deserializeGame(save2);
  assert.equal(st2.buildings.get("b777779").charge, 0, "a negative charge clamps to 0");
  assert.equal(st2.buildings.get("b777780").charge, 1, "a non-numeric string charge coerces then clamps to 1");
});

test("a tampered order coord and a bad cargo are coerced; the loaded game ticks with no NaN positions (B5)", () => {
  const save = freshSkirmishSave(23);
  const workers = save.units.filter(u => u.type === "worker" && u.owner === "player");
  assert.ok(workers.length >= 2, "the fixture has player workers to tamper with");
  const w1 = workers[0], w2 = workers[1];
  // A move order aimed far off the map, plus a queued waypoint at NaN — both must clamp to a finite
  // in-map coord so stepToward can't drive the unit's position to NaN and poison the spatial hash.
  w1.order = { type: "move", x: 1e12, y: -500 };
  w1.orderQueue = [{ type: "move", x: NaN, y: 9e9 }];
  w1.cargo = { com: "ore", qty: NaN };                  // a NaN haul → coerced to a finite >= 0
  w2.cargo = { com: "☠notacommodity", qty: 5 };    // a bogus commodity → the whole cargo is dropped

  const st = deserializeGame(save);
  const cu1 = st.units.get(w1.id), cu2 = st.units.get(w2.id);
  assert.ok(Number.isFinite(cu1.order.x) && cu1.order.x >= 0 && cu1.order.x <= st.map.width, "order.x clamped into the map");
  assert.ok(Number.isFinite(cu1.order.y) && cu1.order.y >= 0 && cu1.order.y <= st.map.height, "order.y clamped into the map");
  assert.ok(Number.isFinite(cu1.orderQueue[0].x) && Number.isFinite(cu1.orderQueue[0].y), "a queued waypoint's coords are clamped too");
  assert.ok(Number.isFinite(cu1.cargo.qty) && cu1.cargo.qty >= 0, "cargo qty coerced to a finite >= 0");
  assert.equal(cu2.cargo, null, "a cargo naming a commodity that doesn't exist is dropped entirely");

  // The loaded game ticks cleanly, and no unit position ever becomes NaN (the concrete failure a NaN
  // order coord causes: stepToward drives x/y to NaN, wedging the sim on the first frame).
  assert.doesNotThrow(() => { for (let i = 0; i < 40; i++) tick(st, 0.1); }, "the loaded game ticks with no throw");
  for (const u of st.units.values()) assert.ok(Number.isFinite(u.x) && Number.isFinite(u.y), `unit ${u.id} has finite coords after ticking`);
});

test("a galaxy save with a low/missing entitySeq but a live 'g' entity mints no colliding id (B4)", () => {
  const g = createGalaxy({ seed: 31 });
  const save = JSON.parse(JSON.stringify(serializeGalaxy(g)));
  // Simulate an in-flight g-scheme entity already live in the save (a prior jump's rider, or a relief
  // ship), with a g-id ABOVE the saved entitySeq — the exact shape a hand-edited or pre-fix save carries.
  const activePayload = save.planets.find(p => p.planetId === save.activeId);
  activePayload.units.push({ id: "g1", kind: "unit", type: "skiff", owner: "ai",
    x: 300, y: 300, hp: 80, maxHp: 80, order: null, orderQueue: [], cargo: null });
  delete save.entitySeq;   // missing entirely — the pre-fix path restored it to 0, so the NEXT mint was "g1"

  const g2 = deserializeGalaxy(save);
  const active = activeState(g2);
  assert.ok(active.units.has("g1"), "the live g-entity survived the load");
  const ghost = active.units.get("g1");

  // Strip every player foothold so checkGalaxyRescue dispatches a fresh relief colony ship, minted as
  // 'g'+(++entitySeq). With entitySeq recomputed past g1 it lands on "g2" — never overwriting "g1".
  for (const st of g2.planets.values()) {
    for (const [id, u] of [...st.units]) if (u.owner === "player") st.units.delete(id);
    for (const [id, b] of [...st.buildings]) if (b.owner === "player") st.buildings.delete(id);
  }
  g2.lastReliefTime = null;   // clear any cooldown so relief fires now
  checkGalaxyRescue(g2);

  assert.strictEqual(active.units.get("g1"), ghost, "the existing g-entity was NOT clobbered by the mint");
  const relief = [...active.units.values()].find(u => u.owner === "player" && u.type === "colonyship");
  assert.ok(relief, "a relief colony ship really was dispatched");
  assert.notEqual(relief.id, "g1", "…under a fresh, non-colliding g-id");
});

test("a non-array researchQueue coerces to [] and a bogus techId job is dropped on load (#4)", () => {
  // researchQueue:5 → updateResearch does .length/.shift on a number and bricks the game on load.
  const g = createGalaxy({ seed: 41 });
  const dc = makeBuilding("datacenter", "player", 600, 500);
  activeState(g).buildings.set(dc.id, dc);
  const save = JSON.parse(JSON.stringify(serializeGalaxy(g)));
  save.planets.find(p => p.planetId === save.activeId).buildings.find(b => b.id === dc.id).researchQueue = 5;
  const restored = deserializeGalaxy(save);
  const rdc = [...activeState(restored).buildings.values()].find(b => b.id === dc.id);
  assert.deepEqual(rdc.researchQueue, [], "researchQueue:5 became an empty array, not a first-tick crash");
  assert.doesNotThrow(() => { for (let i = 0; i < 20; i++) stepGalaxy(restored, 0.1); }, "the loaded galaxy ticks — updateResearch doesn't deref a number");

  // A real array carrying a bogus-techId job (and out-of-range progress) drops the bad job, keeps the good.
  const g2 = createGalaxy({ seed: 42 });
  const dc2 = makeBuilding("datacenter", "player", 600, 500);
  dc2.researchQueue = [{ techId: "metallurgy", progress: 0.5 }, { techId: "notatech", progress: 999 }];
  activeState(g2).buildings.set(dc2.id, dc2);
  const restored2 = deserializeGalaxy(JSON.parse(JSON.stringify(serializeGalaxy(g2))));
  const rdc2 = [...activeState(restored2).buildings.values()].find(b => b.id === dc2.id);
  assert.ok(rdc2.researchQueue.every(j => TECHS[j.techId]), "no bogus techId survived the load");
  assert.ok(rdc2.researchQueue.some(j => j.techId === "metallurgy"), "the real research job was kept");
  assert.ok(rdc2.researchQueue.every(j => j.progress >= 0 && j.progress <= 1), "progress clamped to [0,1]");
});

test("a Refinery's researchQueue accepts UPGRADES ids too, not just TECHS — doctrine research is now queued/timed the same way (#4b)", () => {
  // Doctrine research develops over time now (engine/techtree.js updateResearch resolves a
  // Refinery's queue against UPGRADES) — its researchQueue entries carry an UPGRADES id, not a
  // TECHS one, so cleanEntity's sanitizer has to recognize both tables, not just TECHS.
  const state = createGameState({ planetId: "ferros", seed: 44, rng: mulberry32(44) });
  const refinery = makeBuilding("refinery", "player", 600, 500);
  refinery.researchQueue = [{ techId: "reinforcedPlating", progress: 0.5 }, { techId: "not-a-real-upgrade", progress: 999 }];
  state.buildings.set(refinery.id, refinery);

  const restored = deserializeGame(JSON.parse(JSON.stringify(serializeGame(state))));
  const rref = [...restored.buildings.values()].find(b => b.id === refinery.id);
  assert.ok(rref.researchQueue.every(j => UPGRADES[j.techId]), "no bogus upgrade id survived the load");
  assert.ok(rref.researchQueue.some(j => j.techId === "reinforcedPlating"), "the real doctrine research job was kept — UPGRADES ids are accepted, not just TECHS");
  assert.ok(rref.researchQueue.every(j => j.progress >= 0 && j.progress <= 1), "progress clamped to [0,1]");
  assert.doesNotThrow(() => { for (let i = 0; i < 20; i++) tick(restored, 0.1); },
    "the loaded game ticks cleanly — updateResearch resolves the Refinery's queue against UPGRADES without throwing");
});

test("a serialized building strips the rig's transient lastYield/lastTier but keeps real dig state (#5)", () => {
  const g = createGalaxy({ seed: 51 });
  const rig = makeBuilding("plasmarig", "player", 600, 500);
  rig.lastYield = 42; rig.lastTier = "overwhelming";   // transient HUD readout, stamped by the last dig
  rig.digProgress = 0.5; rig.digCount = 7;             // REAL persisted dig state
  activeState(g).buildings.set(rig.id, rig);

  const save = serializeGalaxy(g);
  const rigPayload = save.planets.find(p => p.planetId === save.activeId).buildings.find(b => b.id === rig.id);
  assert.ok(!("lastYield" in rigPayload), "lastYield is stripped from the save (transient)");
  assert.ok(!("lastTier" in rigPayload), "lastTier is stripped from the save (transient)");
  assert.equal(rigPayload.digProgress, 0.5, "digProgress is the rig's real dig state — persisted");
  assert.equal(rigPayload.digCount, 7, "…and so is digCount");
});

test("NET: a whole game state survives serialize→deserialize→serialize byte-for-byte", () => {
  // The catch-all round-trip net: any field that silently fails to persist (a forgotten strip, a
  // forgotten restore, a reshape that isn't the identity for valid data) makes the two serializations
  // diverge here — even one this suite doesn't yet name. Build a rich, real state first.
  const state = createGameState({ planetId: "ferros", seed: 7777, rng: mulberry32(7777), aiMicro: true });
  for (let i = 0; i < 300; i++) tick(state, 0.1);       // build, gather, fight, deplete nodes, reveal fog
  const once = serializeGame(state);                     // detached snapshot #1
  const twice = serializeGame(deserializeGame(once));    // load it back, then re-serialize
  assert.deepEqual(twice, once, "every persisted field round-trips — a forgotten strip/persist would diverge here");
});

test("NET (galaxy): a whole galaxy survives serialize→deserialize→serialize byte-for-byte", () => {
  const g = settledGalaxy(61);
  for (let i = 0; i < 40; i++) stepGalaxy(g, 0.1);       // let the background worlds and markets evolve
  const once = serializeGalaxy(g);
  const twice = serializeGalaxy(deserializeGalaxy(once));
  assert.deepEqual(twice, once, "the whole galaxy payload round-trips — any non-round-tripping field diverges here");
});

/* ---------- Tier-2 hardening: map size/resource multipliers, player economy ---------- */

test("a tampered sizeMult/resourceMult never produces a NaN-sized map (Gap A)", () => {
  // A string, NaN, zero, and a negative value on each field — none of these are guarded by
  // generateMap's own `opts.sizeMult || 1` (only FALSY values are caught; NaN and a numeric
  // string are truthy and sail straight through into the Math.min/Math.max sizing math).
  const cases = [
    { sizeMult: "haxx", resourceMult: "haxx" },
    { sizeMult: NaN, resourceMult: NaN },
    { sizeMult: 0, resourceMult: 0 },
    { sizeMult: -5, resourceMult: -5 },
  ];
  for (const c of cases) {
    const save = freshSkirmishSave(31);
    save.sizeMult = c.sizeMult;
    save.resourceMult = c.resourceMult;
    const st = deserializeGame(save);
    assert.ok(Number.isFinite(st.sizeMult) && st.sizeMult > 0, `sizeMult (${c.sizeMult}) coerces to a finite positive number`);
    assert.ok(Number.isFinite(st.resourceMult) && st.resourceMult > 0, `resourceMult (${c.resourceMult}) coerces to a finite positive number`);
    assert.ok(Number.isFinite(st.map.width) && st.map.width > 0, `map.width is finite for sizeMult=${c.sizeMult}`);
    assert.ok(Number.isFinite(st.map.height) && st.map.height > 0, `map.height is finite for sizeMult=${c.sizeMult}`);
    assert.doesNotThrow(() => { for (let i = 0; i < 10; i++) tick(st, 0.1); }, `the loaded game ticks cleanly for sizeMult=${c.sizeMult}`);
  }
});

test("a valid sizeMult/resourceMult round-trips exactly (identity, no clamp for real values)", () => {
  const a = createGameState({ planetId: "ferros", seed: 32, rng: mulberry32(32), sizeMult: 1.5, resourceMult: 0.8 });
  for (let i = 0; i < 20; i++) tick(a, 0.1);
  const st = deserializeGame(serializeGame(a));
  assert.equal(st.sizeMult, 1.5, "a legitimately-saved sizeMult is left exactly as-is");
  assert.equal(st.resourceMult, 0.8, "a legitimately-saved resourceMult is left exactly as-is");
});

test("a tampered player resources/upgrades map is sanitized on load (Gap B)", () => {
  const save = freshSkirmishSave(33);
  const p = save.players.player;
  p.resources["☠notacommodity"] = 500;   // bogus commodity key
  p.resources.crystals = "500";          // string quantity
  p.resources.radioactives = -50;        // negative quantity
  p.upgrades["☠notarealupgrade"] = true; // bogus id
  p.upgrades.metallurgy = "yes";         // real TECHS id, non-boolean truthy value
  p.upgrades.overchargedWeapons = true;  // real UPGRADES id, valid
  p.upgrades.reactors = false;           // real TECHS id, explicit false — must be dropped, not kept as false

  const st = deserializeGame(save);
  const player = st.players.player;

  assert.ok(!("☠notacommodity" in player.resources), "a bogus commodity key is dropped from resources");
  assert.ok(Number.isFinite(player.resources.crystals) && player.resources.crystals >= 0, "a string quantity is coerced to a finite number");
  assert.ok(!("radioactives" in player.resources), "a negative quantity is dropped rather than kept negative");
  for (const com of Object.keys(player.resources)) {
    assert.ok(COM[com], `every surviving resource key (${com}) is a real commodity`);
    assert.ok(Number.isFinite(player.resources[com]) && player.resources[com] >= 0, `resources.${com} is a finite non-negative number`);
  }

  assert.ok(!("☠notarealupgrade" in player.upgrades), "a bogus upgrade id is dropped");
  assert.ok(!("reactors" in player.upgrades), "an explicit false on a real id is dropped, not kept as false");
  assert.equal(player.upgrades.metallurgy, true, "a real id with a non-boolean truthy value normalises to true");
  assert.equal(player.upgrades.overchargedWeapons, true, "a real, validly-set upgrade survives as true");
  for (const id of Object.keys(player.upgrades)) assert.equal(player.upgrades[id], true, "every surviving upgrade value is exactly true");

  assert.doesNotThrow(() => { for (let i = 0; i < 20; i++) tick(st, 0.1); }, "the loaded game ticks cleanly with a sanitized player economy");
});

test("a valid player economy round-trips exactly (identity, no change for real values)", () => {
  const a = createGameState({ planetId: "ferros", seed: 34, rng: mulberry32(34), aiMicro: true });
  a.players.player.resources.crystals = 42;
  a.players.player.upgrades.metallurgy = true;
  for (let i = 0; i < 20; i++) tick(a, 0.1);
  const st = deserializeGame(serializeGame(a));
  assert.equal(st.players.player.resources.crystals, 42, "a legitimately-saved resource quantity round-trips exactly");
  assert.equal(st.players.player.upgrades.metallurgy, true, "a legitimately-saved upgrade round-trips exactly");
});

// A multi-input factory's `input` larder (engine/entities.js inputCapOf) gives each real input
// commodity its OWN independent slice — a Chip Fab (crystals + metals) gets 40/40, not one
// shared 80 pool — so an oversupplied commodity can never crowd out room for the other one the
// recipe still needs. persist.js's load-time clamp must honour that same per-commodity slice
// (coerceInputBuffer), not sum-clamp the whole buffer to one shared total the way `store` does.
test("a tampered factory input larder is clamped PER COMMODITY, not as one shared pool (Chip Fab: crystals + metals)", () => {
  const a = createGameState({ planetId: "ferros", seed: 40, rng: mulberry32(40) });
  const cc = [...a.buildings.values()].find(b => b.type === "command");
  const fab = makeBuilding("chipfab", "player", cc.x + 60, cc.y);
  fab.input = { metals: 999, crystals: 5 };   // metals wildly over its own 40-unit slice
  a.buildings.set(fab.id, fab);

  const st = deserializeGame(serializeGame(a));
  const loaded = st.buildings.get(fab.id);

  assert.ok(loaded.input.metals <= 40 + 1e-9, "metals is clamped to its OWN 40-unit slice");
  assert.equal(loaded.input.crystals, 5, "crystals is untouched — an oversupplied metals never eats into its room");
});

test("a legitimately-saved multi-commodity input larder round-trips exactly (identity, no change for real values)", () => {
  const a = createGameState({ planetId: "ferros", seed: 41, rng: mulberry32(41) });
  const cc = [...a.buildings.values()].find(b => b.type === "command");
  const fab = makeBuilding("chipfab", "player", cc.x + 60, cc.y);
  fab.input = { metals: 30, crystals: 12 };   // both well within their own 40-unit slice
  a.buildings.set(fab.id, fab);

  const st = deserializeGame(serializeGame(a));
  const loaded = st.buildings.get(fab.id);

  assert.equal(loaded.input.metals, 30);
  assert.equal(loaded.input.crystals, 12);
});

/* ---------- P1 review gap-closers: facing coercion, unrecognised save.planets id, skirmish-path sanitizeSave ---------- */

test("a non-finite facing is deleted on load (never coerced to a fallback number); a numeric-but-stringy one is coerced", () => {
  const save = freshSkirmishSave(71);
  const units = save.units.filter(u => u.owner === "player");
  assert.ok(units.length >= 2, "the fixture has at least two player units to tamper with");
  const [u1, u2] = units;
  // A literal JS NaN/Infinity can't survive deserializeGame's OWN internal round-trip
  // (`JSON.parse(JSON.stringify(input))`, engine/persist.js) unscathed: JSON.stringify turns any
  // non-finite number into the JSON literal `null` (JSON syntax has no NaN/Infinity token at all),
  // so by the time cleanEntity sees it, e.facing is `null` — and num(null, NaN) is 0, not NaN
  // (Number(null) === 0 is a genuine JS quirk, and 0 IS finite) — so it's COERCED to 0, not
  // deleted. Verified this empirically against the real code before asserting anything here (a
  // raw-NaN-through-deserializeGame test would silently assert the wrong thing). The shape a real
  // hand-edited save FILE actually takes — since JSON syntax has no NaN/Infinity literal either —
  // is a STRING that isn't a real number, which is what genuinely hits the delete branch below.
  u1.facing = "not-a-number";
  u2.facing = "NaN";                                    // spelled out as text — JSON has no NaN token either

  const st = deserializeGame(save);
  const cu1 = st.units.get(u1.id), cu2 = st.units.get(u2.id);
  assert.ok(!("facing" in cu1), "a non-numeric-string facing is deleted entirely, not coerced to some fallback number");
  assert.ok(!("facing" in cu2), "...same for the text 'NaN'");

  // A valid-but-stringy facing (the realistic "went through one too many JSON.stringify passes"
  // corruption) IS coerced to the real number, not dropped.
  const save2 = freshSkirmishSave(72);
  const u3 = save2.units.find(u => u.owner === "player");
  u3.facing = "1.57";
  const st2 = deserializeGame(save2);
  const cu3 = st2.units.get(u3.id);
  assert.equal(typeof cu3.facing, "number", "a numeric-but-stringy facing is coerced to a real number");
  assert.ok(Math.abs(cu3.facing - 1.57) < 1e-9, "...to the correct value");
  assert.ok(Number.isFinite(Math.cos(cu3.facing)) && Number.isFinite(Math.sin(cu3.facing)),
    "the coerced facing feeds Math.cos/Math.sin (renderShared.js's orientation math) without going NaN");

  // Nothing in engine/sim.js's tick() reads `facing` at all (confirmed by reading the engine — it's
  // a pure render-side hint, renderShared.js's updateFacing, itself already guarded by
  // Number.isFinite), so there's no facing-derived NaN a tick could smoke out; the direct field
  // assertions above ARE the check. Still confirm the loaded games just tick cleanly, the same
  // baseline every other hardening test in this file asserts after a hostile-field load.
  assert.doesNotThrow(() => { for (let i = 0; i < 10; i++) tick(st, 0.1); }, "the loaded game (deleted facing) ticks cleanly");
  assert.doesNotThrow(() => { for (let i = 0; i < 10; i++) tick(st2, 0.1); }, "the loaded game (coerced facing) ticks cleanly");
  assert.ok(!("facing" in st.units.get(u1.id)), "facing is still absent after ticking — nothing re-adds or NaNs it in");
});

test("a building's logiPriority (engine/commands.js issueSetLogiPriority) is coerced on load — a real enum value round-trips, a bogus one is dropped", () => {
  // Two separate fixtures (same idiom as the facing test above) rather than requiring two
  // pre-existing player buildings in one save — a fresh skirmish only seeds a single Command
  // Center (see freshSkirmishSave's own doc comment on this file's other tests).
  const save = freshSkirmishSave(73);
  const cc = save.buildings.find(b => b.owner === "player");
  cc.logiPriority = "high";   // a real enum value must round-trip untouched

  const st = deserializeGame(save);
  const loadedCC = st.buildings.get(cc.id);
  assert.equal(loadedCC.logiPriority, "high", "a real enum value survives load unchanged");

  const save2 = freshSkirmishSave(74);
  const cc2 = save2.buildings.find(b => b.owner === "player");
  cc2.logiPriority = "not-a-real-value";   // a bogus one must be dropped, not silently kept or crash-coerced
  const st2 = deserializeGame(save2);
  const loadedCC2 = st2.buildings.get(cc2.id);
  assert.ok(!("logiPriority" in loadedCC2), "an unrecognised value is dropped entirely, reading as the default 'normal' via engine/haul.js priorityWeight");

  assert.doesNotThrow(() => { for (let i = 0; i < 10; i++) tick(st, 0.1); }, "the loaded game ticks cleanly either way");
  assert.doesNotThrow(() => { for (let i = 0; i < 10; i++) tick(st2, 0.1); });
});

test("an unrecognised planetId inside save.planets is skipped cleanly on galaxy load — never added, no other planet affected", () => {
  const g = createGalaxy({ seed: 81 });
  const save = JSON.parse(JSON.stringify(serializeGalaxy(g)));
  // Corrupt a NON-active planet's payload — corrupting the active one instead would legitimately
  // trip the separate "no active planet" guard already covered above (a different code path: the
  // planet is simply missing from the save, not present-but-misnamed the way it is here).
  const victim = save.planets.find(p => p.planetId !== save.activeId);
  const orphanedRealId = victim.planetId;
  const otherRealIds = save.planets.map(p => p.planetId).filter(id => id !== orphanedRealId);
  victim.planetId = "<script>alert(1)</script>";        // garbage/hostile id — same spirit as the worlds-roster XSS test above

  const g2 = deserializeGalaxy(save);

  assert.ok(!g2.planets.has("<script>alert(1)</script>"), "the garbage planetId itself never becomes a planets key");
  assert.ok(!g2.planets.has(orphanedRealId), "the real world whose payload was clobbered is skipped too — nothing in the save names it correctly any more");
  assert.equal(g2.planets.size, save.planets.length - 1, "exactly the one corrupted entry was skipped — no collateral damage");
  for (const id of otherRealIds) {
    const st = g2.planets.get(id);
    assert.ok(st, `every OTHER legitimate planet (${id}) still deserialized`);
    assert.equal(st.planetId, id, "...rehydrated under its correct planetId");
    assert.ok(st.map && Number.isFinite(st.map.width) && st.map.width > 0, "...with a real generated map");
  }
  assert.ok(g2.planets.has(g2.activeId), "the active planet — untouched by the corruption — still loads");
  assert.doesNotThrow(() => { for (let i = 0; i < 10; i++) stepGalaxy(g2, 0.1); }, "the loaded galaxy ticks cleanly with one world silently dropped");
});

test("a prototype-pollution payload is rejected on the SKIRMISH load path too, not just deserializeGalaxy", () => {
  const save = freshSkirmishSave(91);
  // JSON.parse (unlike a normal object literal or property assignment) turns a `"__proto__"` key
  // into a REAL own data property instead of tripping the special accessor that would otherwise
  // just repoint the object's actual prototype — see sanitizeSave's own comment in
  // engine/persist.js. Graft it onto an otherwise-real, already-valid save (JSON text, then
  // reparsed) the same way a hand-edited save FILE would actually carry it, rather than testing
  // with a bespoke minimal object the way test/sanitize.test.js's unit-level tests do.
  const hostileText = JSON.stringify(save).replace(/^\{/, '{"__proto__":{"polluted":true},');
  const evil = JSON.parse(hostileText);
  assert.ok(Object.prototype.hasOwnProperty.call(evil, "__proto__"), "the splice really created an own '__proto__' property, not a live prototype rewrite");

  assert.throws(() => deserializeGame(evil), /forbidden key/, "the skirmish path rejects it exactly like deserializeGalaxy already does (test/sanitize.test.js)");
  assert.equal(({}).polluted, undefined, "Object.prototype was never actually polluted");

  // Same class of attack, nested deep inside a real entity field instead of at the save root —
  // confirms sanitizeSave's walk isn't only checking the top level on this path either.
  const save2 = freshSkirmishSave(92);
  save2.units[0].evilNest = { a: { constructor: { x: 1 } } };
  assert.throws(() => deserializeGame(save2), /forbidden key/, "a nested constructor key is rejected too, wherever it hides in the payload");
});

/* ---- Tier-1 save-safety batch (docs/code-improvement-tiers.md B1-B6) ------------------------
   cleanEntity hardens ENTITIES well. That discipline stopped at the entity boundary: three whole
   sub-objects reachable from an Odyssey save — the per-world market, the diplomacy block and the
   AI controller — were written into live state verbatim, and several galaxy meta collections were
   unfiltered while their siblings three lines away were filtered. */

// A galaxy save to tamper with, with a second world loaded so the per-world blocks are exercised.
function freshGalaxySave(seed = 5) {
  const g = createGalaxy({ seed });
  for (let i = 0; i < 20; i++) stepGalaxy(g, 0.1);
  return serializeGalaxy(g);
}
const planetOf = (save, id) => save.planets.find(p => p.planetId === id) || save.planets[0];

test("a tampered market pressure/glut is clamped into its runtime band on load (B2)", () => {
  const save = freshGalaxySave(21);
  const P = planetOf(save);
  P.market.pressure = { ore: 1e6, metals: -1e6, gas: "abc", "☠notacommodity": 1 };
  P.market.glut = { alloys: 5, ore: -3 };

  const g = deserializeGalaxy(save);
  const m = g.planets.get(P.planetId).market;
  for (const [com, v] of Object.entries(m.pressure)) {
    assert.ok(Number.isFinite(v), `pressure.${com} must be finite, got ${v}`);
    assert.ok(v >= -0.6 && v <= 0.6, `pressure.${com} must sit in the runtime band, got ${v}`);
  }
  for (const [com, v] of Object.entries(m.glut || {})) {
    assert.ok(Number.isFinite(v) && v >= 0 && v <= 0.85, `glut.${com} must sit in the runtime band, got ${v}`);
  }
  assert.ok(!("☠notacommodity" in m.pressure), "a bogus commodity key must not be injected into the price book");
});

test("selling into a tampered market never makes galaxy.credits non-finite (B2)", () => {
  const save = freshGalaxySave(22);
  const P = planetOf(save);
  P.market.pressure = { ore: "abc" };
  const g = deserializeGalaxy(save);
  const st = g.planets.get(g.activeId);
  st.players.player.resources.ore = 500;
  for (let i = 0; i < 40; i++) stepGalaxy(g, 0.1);
  assert.ok(Number.isFinite(g.credits), `galaxy.credits went non-finite: ${g.credits}`);
});

test("a legitimately-saved market pressure round-trips exactly (B2 regression fence)", () => {
  const g0 = createGalaxy({ seed: 23 });
  const st0 = g0.planets.get(g0.activeId);
  st0.market.pressure.ore = 0.25;
  st0.market.glut = { ...(st0.market.glut || {}), alloys: 0.4 };
  const g = deserializeGalaxy(serializeGalaxy(g0));
  const m = g.planets.get(g0.activeId).market;
  assert.equal(m.pressure.ore, 0.25, "a real in-band pressure must survive the clamp unchanged");
  assert.equal(m.glut.alloys, 0.4, "and so must a real glut");
});

test("a tampered diplomacy stance is coerced to a finite number in [-1,1] on load (B1)", () => {
  for (const bad of ["friendly", NaN, 9e9, -9e9, null]) {
    const save = freshGalaxySave(24);
    const P = planetOf(save);
    P.diplomacy = { ...P.diplomacy, stance: bad };
    const g = deserializeGalaxy(save);
    const dip = g.planets.get(P.planetId).diplomacy;
    assert.ok(Number.isFinite(dip.stance), `stance must be finite for input ${String(bad)}, got ${dip.stance}`);
    assert.ok(Math.abs(dip.stance) <= 1, `stance must stay in [-1,1], got ${dip.stance}`);
  }
});

test("a non-numeric stance can never grow into an oversized string that bricks the next save (B1)", () => {
  // The real failure chain: clamp() is the identity on a non-number, so the drift line
  // string-CONCATENATES ~3 chars per diplomacy tick. Within ~160 sim-seconds the stance is past
  // sanitizeSave's own MAX_STRING_LEN, so the autosave the game itself writes can no longer be
  // loaded — and autosave rotates both generations, so Continue offers nothing.
  const save = freshGalaxySave(25);
  planetOf(save).diplomacy = { ...planetOf(save).diplomacy, stance: "x" };
  const g = deserializeGalaxy(save);
  for (let i = 0; i < 1600; i++) stepGalaxy(g, 0.1);
  assert.doesNotThrow(() => deserializeGalaxy(serializeGalaxy(g)),
    "the game's own autosave must stay loadable after a corrupt stance has been ticked");
});

test("an arbitrary key on a saved diplomacy block is dropped (B1)", () => {
  const save = freshGalaxySave(26);
  planetOf(save).diplomacy = { ...planetOf(save).diplomacy, notARealField: "haxx" };
  const g = deserializeGalaxy(save);
  assert.ok(!("notARealField" in g.planets.get(planetOf(save).planetId).diplomacy),
    "the load path must not let a save inject arbitrary keys onto state.diplomacy");
});

test("a tampered AI controller block is coerced on load — the attack timeout still works (B3)", () => {
  const save = freshSkirmishSave(27);
  Object.assign(save.controllers.ai, {
    think: "abc", actionBudget: "5", attackForce: -1e9, nextAttackAt: "later",
    unitsBuilt: null, apm: "fast", micro: "yes", strategy: "<script>", difficulty: "impossible",
  });
  const st = deserializeGame(save);
  for (const f of ["think", "actionBudget", "attackForce", "unitsBuilt"])
    assert.ok(Number.isFinite(st.ai[f]), `ai.${f} must be a finite number, got ${st.ai[f]}`);
  assert.ok(st.ai.nextAttackAt === null || Number.isFinite(st.ai.nextAttackAt),
    `ai.nextAttackAt must be null or finite — a string makes 'state.time >= nextAttackAt' false forever, ` +
    `permanently disabling the AI's attack timeout with no crash (got ${st.ai.nextAttackAt})`);
  assert.equal(typeof st.ai.micro, "boolean", "ai.micro must be a real boolean");
  assert.ok(st.ai.apm === null || Number.isFinite(st.ai.apm), "ai.apm must be null or finite");
  assert.equal(st.ai.strategy, "default", "an unknown strategy must fall back to the default, not survive verbatim");
  assert.equal(st.ai.difficulty, "medium", "an unknown difficulty must fall back to medium");
});

test("a populated playerAi controller round-trips field-for-field (B3)", () => {
  const st0 = createGameState({ planetId: "ferros", seed: 28, rng: mulberry32(28) });
  st0.playerAi = createAiController("ferros", { apm: 90, micro: true, strategy: "aggressive", difficulty: "hard" });
  Object.assign(st0.playerAi, { think: 0.7, actionBudget: 3, attackForce: 5, unitsBuilt: 4, waveCount: 2, lastThreatAt: 12.5 });
  const st = deserializeGame(serializeGame(st0));
  assert.ok(st.playerAi, "the second self-play controller must survive a save/load at all");
  for (const f of ["think", "actionBudget", "attackForce", "unitsBuilt", "waveCount", "lastThreatAt", "apm", "micro", "strategy", "difficulty"])
    assert.deepEqual(st.playerAi[f], st0.playerAi[f], `playerAi.${f} must round-trip`);
});

test("state.ai and state.playerAi persist the identical field set (B3)", () => {
  // persist.js promises in a comment that every controller's wire shape "can never structurally
  // drift" from any other's — T-045's N-keyed controllers: made that a literal identity (every
  // entry goes through the same serController), where it used to be two independently
  // hand-written, differently-prefixed object literals nothing enforced stayed in sync.
  const st0 = createGameState({ planetId: "ferros", seed: 29, rng: mulberry32(29) });
  st0.playerAi = createAiController("ferros");
  const save = serializeGame(st0);
  assert.ok(save.controllers.player, "a populated playerAi must reach the wire at all");
  assert.deepEqual(Object.keys(save.controllers.player).sort(), Object.keys(save.controllers.ai).sort(),
    "every controller's wire field set must match one-for-one — persist.js promises they 'can never structurally drift'");
});

test("a duplicated shipId on a saved lane is de-duplicated on load (B5)", () => {
  const g0 = createGalaxy({ seed: 30 });
  const home = g0.planets.get(g0.activeId);
  const hauler = makeUnit("hauler", "player", home.map.bases.player.x + 30, home.map.bases.player.y);
  home.units.set(hauler.id, hauler);
  const save = serializeGalaxy(g0);
  const other = save.worlds.find(w => w !== g0.activeId);
  save.lanes = [{ id: "lane1", from: g0.activeId, to: other, commodities: ["ore"], shipIds: [hauler.id, hauler.id, hauler.id] }];
  save.laneSeq = 1;
  const g = deserializeGalaxy(save);
  assert.equal(g.lanes.length, 1, "fixture sanity: the lane survived load");
  assert.deepEqual(g.lanes[0].shipIds, [hauler.id],
    "a lane's capacity is summed over shipIds without deduping, so a repeated id multiplies throughput");
});

test("two saved lanes sharing an id are reduced to one, and laneSeq lifts past every id (B5)", () => {
  const save = freshGalaxySave(31);
  const from = save.planets[0].planetId;
  const other = save.worlds.find(w => w !== from);
  save.lanes = [
    { id: "lane1", from, to: other, commodities: ["ore"], shipIds: [] },
    { id: "lane1", from, to: other, commodities: ["metals"], shipIds: [] },
    { id: "lane7", from, to: other, commodities: ["gas"], shipIds: [] },
  ];
  save.laneSeq = 0;
  const g = deserializeGalaxy(save);
  assert.equal(g.lanes.filter(l => l.id === "lane1").length, 1,
    "a duplicate lane id makes one lane permanently unreachable from the UI (find/findIndex by id)");
  assert.ok(g.laneSeq >= 7,
    `laneSeq must be lifted past every lane id the save carries (like maxOwnEntityId/maxGId are), got ${g.laneSeq}`);
});

test("a tampered rally point is clamped onto the map — produced units never walk off the world (B6)", () => {
  const save = freshSkirmishSave(32);
  const cc = save.buildings.find(b => b.type === "command" && b.owner === "player");
  cc.rally = { x: 1e9, y: 1e9, nodeId: 123 };
  const st = deserializeGame(save);
  const loaded = st.buildings.get(cc.id);
  assert.ok(loaded.rally.x >= 0 && loaded.rally.x <= st.map.width, `rally.x must be on the map, got ${loaded.rally.x}`);
  assert.ok(loaded.rally.y >= 0 && loaded.rally.y <= st.map.height, `rally.y must be on the map, got ${loaded.rally.y}`);
  assert.ok(loaded.rally.nodeId === null || typeof loaded.rally.nodeId === "string",
    "a non-string rally nodeId must be dropped, not fed to the node lookup");
});

test("a real rally point survives the clamp unchanged (B6 regression fence)", () => {
  const save = freshSkirmishSave(33);
  const cc = save.buildings.find(b => b.type === "command" && b.owner === "player");
  cc.rally = { x: 321, y: 210, nodeId: null };
  const loaded = deserializeGame(save).buildings.get(cc.id);
  assert.deepEqual({ x: loaded.rally.x, y: loaded.rally.y }, { x: 321, y: 210 });
});

test("an AI-logistics freighter whose cargo slot was nulled by load coercion never crashes the tick (B4)", () => {
  // The cross-module invariant: engine/state.js's makeUnit only gives `cargo` to role==="worker",
  // and the ONLY thing that mints one for an autonomous freighter is issueSetAILogistics. But
  // cleanEntity nulls a cargo naming a bogus commodity while leaving aiLogistics:true intact, so a
  // corrupt save loads "clean" and then throws — inside the rAF loop, past load's try/catch — with
  // no way back into the game. Verbatim the failure production.js already guards against for its
  // queue. Driven at updateService directly: the crash needs the ship parked at the Command Center
  // mid-fetch, which a short whole-sim run doesn't reliably reach.
  const st = createGameState({ planetId: "ferros", seed: 41, rng: mulberry32(41) });
  const cc = [...st.buildings.values()].find(b => b.owner === "player" && b.type === "command");
  const smelter = makeBuilding("smelter", "player", cc.x + 60, cc.y);
  smelter.constructing = false;
  smelter.buildProgress = 1;
  st.buildings.set(smelter.id, smelter);
  st.players.player.resources.ore = 500;

  const f = makeUnit("hauler", "player", cc.x, cc.y);
  f.aiLogistics = true;
  f.cargo = null;                       // exactly what cleanEntity leaves behind
  st.units.set(f.id, f);
  f.order = { type: "service", buildingId: smelter.id, phase: "toCC", com: "ore", aiJob: true };

  assert.doesNotThrow(() => updateService(st, f, 0.1),
    "a service leg must mint the cargo slot it needs rather than dereferencing null");
  assert.ok(f.cargo && f.cargo.com === "ore" && f.cargo.qty > 0,
    "and it must actually load the input it went to fetch");
});

test("pacified/reached/discovered/wonBy are filtered to real ids on load (T2)", () => {
  // These sat unfiltered while their siblings three lines away — claims, colonyPolicies, worlds —
  // were carefully filtered against the known roster. galaxy.pacified.size is a RAW size check
  // against DOMINATION_TARGET and feeds PACIFIED_INCOME, and galaxyStatus surfaces both
  // pacified.size and discovered.size to the starmap, so junk ids bought free conquest progress and
  // an inflated "worlds visited" readout.
  const save = freshGalaxySave(50);
  save.pacified = ["not-a-world", "also-fake", "third", "fourth", "fifth"];
  save.discovered = ["<img src=x onerror=alert(1)>"];
  save.reached = ["capital", "world:2", "☠not-a-milestone"];
  save.wonBy = { not: "a string" };

  const g = deserializeGalaxy(save);
  assert.equal(g.pacified.size, 0, "no junk world id may count toward domination");
  assert.equal(g.discovered.size, 0, "nor toward the explored count the starmap shows");
  assert.ok(g.wonBy === null || typeof g.wonBy === "string", `wonBy must be a string or null, got ${typeof g.wonBy}`);
  assert.deepEqual([...g.reached].sort(), ["capital", "world:2"],
    "real milestones survive; a bogus id does not — filtering these against the WORLD roster " +
    "instead would drop every genuine milestone and replay its fireworks on the next load");
});

test("a tampered galaxy settings block can't build a NaN-sized world on a later jump (T2)", () => {
  // The galaxy twin of the skirmish hardening already in this file: settings flows into addPlanet,
  // which passes sizeMult/resourceMult straight to createGameState. A NaN-sized map then defeats
  // every coordinate clamp cleanEntity performs, since those clamp against map.width/height.
  const save = freshGalaxySave(51);
  save.settings = { sizeMult: "haxx", resourceMult: null, difficulty: "nope", popCap: -5 };
  const g = deserializeGalaxy(save);
  const s = g.settings;
  assert.ok(Number.isFinite(s.sizeMult) && s.sizeMult > 0, `sizeMult must be a positive number, got ${s.sizeMult}`);
  assert.ok(Number.isFinite(s.resourceMult) && s.resourceMult > 0, `resourceMult must be positive, got ${s.resourceMult}`);
  const st = [...g.planets.values()][0];
  assert.ok(Number.isFinite(st.map.width) && st.map.width > 0, "and a world built from it has a real map");
});

test("a missing settings object loads with defaults rather than throwing later (T2)", () => {
  const save = freshGalaxySave(52);
  delete save.settings;
  const g = deserializeGalaxy(save);
  assert.ok(g.settings && typeof g.settings === "object", "settings must always exist after load");
  assert.ok(Number.isFinite(g.settings.sizeMult), "with usable numbers in it");
});
