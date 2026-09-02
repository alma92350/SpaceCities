import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeBuilding, makeUnit } from "../engine/state.js";
import { tick } from "../engine/sim.js";
import { recycleFrac, recycleValue, canRecycle, beginRecycle, cancelRecycle, updateBuildingRecycle, updateUnitRecycle, RECYCLE_TECH } from "../engine/recycle.js";
import { issueRecycle, issueCancelRecycle, issueStop, issueMove } from "../engine/commands.js";
import { UNITS, BUILDINGS } from "../engine/entities.js";
import { serializeGame, deserializeGame } from "../engine/persist.js";

const near = (a, b, eps = 1e-3) => Math.abs(a - b) < eps;

test("recycleFrac: 40% for ordinary stock, 50% for advanced buildings/units, unresearched", () => {
  const state = createGameState({ planetId: "ferros" });
  const worker = makeUnit("worker", "player", 500, 500);
  const freighter = makeUnit("hauler", "player", 500, 500);
  const barracks = makeBuilding("barracks", "player", 500, 500);
  const smelter = makeBuilding("smelter", "player", 500, 500);   // recipe: "smelt" — an advanced/industrial building

  assert.equal(recycleFrac(state, "player", worker), 0.4, "a plain worker is ordinary stock");
  assert.equal(recycleFrac(state, "player", freighter), 0.5, "a freighter is an advanced capital asset");
  assert.equal(recycleFrac(state, "player", barracks), 0.4, "a basic building");
  assert.equal(recycleFrac(state, "player", smelter), 0.5, "a recipe-running factory is advanced");
});

test("recycleFrac: the 'recycling' research adds +30%, capped at 80%, in EITHER tech tree", () => {
  const state = createGameState({ planetId: "ferros" });
  const worker = makeUnit("worker", "player", 500, 500);
  const freighter = makeUnit("hauler", "player", 500, 500);
  assert.equal(RECYCLE_TECH, "recycling");

  state.players.player.upgrades[RECYCLE_TECH] = true;   // same id whether it came from the skirmish
                                                          // doctrine tree or the Odyssey tech tree
  assert.ok(near(recycleFrac(state, "player", worker), 0.7), "40% + 30% = 70%");
  assert.ok(near(recycleFrac(state, "player", freighter), 0.8), "50% + 30% would be 80% — right at the cap");
});

test("canRecycle: a Command Center never qualifies; a constructing or already-recycling entity doesn't either", () => {
  const cc = makeBuilding("command", "player", 500, 500);
  const rig = makeBuilding("plasmarig", "player", 600, 500);
  const constructingRig = makeBuilding("plasmarig", "player", 700, 500, { constructing: true });
  const worker = makeUnit("worker", "player", 500, 500);

  assert.equal(canRecycle(cc), false, "the Command Center is exempt");
  assert.equal(canRecycle(rig), true, "an ordinary completed building qualifies");
  assert.equal(canRecycle(constructingRig), false, "still going up, not eligible to come back down");
  assert.equal(canRecycle(worker), true);

  beginRecycle(rig);
  assert.equal(canRecycle(rig), false, "already recycling — can't be started twice");
});

test("issueRecycle + updateBuildingRecycle: a building stays standing until its timer completes, then is removed and refunded", () => {
  const state = createGameState({ planetId: "ferros" });
  const rig = makeBuilding("plasmarig", "player", 500, 500);
  state.buildings.set(rig.id, rig);
  const before = state.players.player.resources.ore;

  issueRecycle([rig]);
  assert.ok(rig.recycling, "started");
  assert.equal(state.buildings.has(rig.id), true, "still standing — fully functional until the timer completes");

  // Drive the timer to completion directly (isolates the mechanic from the rest of the tick).
  const time = rig.recycling.time;
  updateBuildingRecycle(state, rig, time - 0.001);
  assert.equal(state.buildings.has(rig.id), true, "not quite done yet");
  updateBuildingRecycle(state, rig, 0.01);

  assert.equal(state.buildings.has(rig.id), false, "removed once the timer completes");
  assert.ok(state.players.player.resources.ore > before, "and its owner got some ore back");
});

test("a Plasma Rig (advanced) refunds 50%; a Barracks (ordinary) refunds 40%", () => {
  const state = createGameState({ planetId: "ferros" });
  const rig = makeBuilding("plasmarig", "player", 500, 500);
  const barracks = makeBuilding("barracks", "player", 600, 500);
  state.buildings.set(rig.id, rig);
  state.buildings.set(barracks.id, barracks);
  const before = state.players.player.resources.ore;

  issueRecycle([rig, barracks]);
  updateBuildingRecycle(state, rig, rig.recycling.time);
  const afterRig = state.players.player.resources.ore;
  updateBuildingRecycle(state, barracks, barracks.recycling.time);
  const afterBarracks = state.players.player.resources.ore;

  assert.ok(near(afterRig - before, BUILDINGS.plasmarig.cost.ore * 0.5), "Plasma Rig: 50%");
  assert.ok(near(afterBarracks - afterRig, BUILDINGS.barracks.cost.ore * 0.4), "Barracks: 40%");
});

test("recycling a building banks ALL of its current output backlog and input larder, in full — not just the cost-based fraction", () => {
  const state = createGameState({ planetId: "ferros" });
  const rig = makeBuilding("plasmarig", "player", 500, 500);
  rig.store = { ore: 44 };   // a raw backlog sitting uncollected in the rig
  state.buildings.set(rig.id, rig);
  const smelter = makeBuilding("smelter", "player", 600, 500);
  smelter.input = { ore: 12 };     // an input larder mid-fill
  smelter.store = { metals: 8 };   // and an output backlog too
  state.buildings.set(smelter.id, smelter);
  const oreBefore = state.players.player.resources.ore;
  const metalsBefore = state.players.player.resources.metals || 0;

  issueRecycle([rig, smelter]);
  updateBuildingRecycle(state, rig, rig.recycling.time);
  updateBuildingRecycle(state, smelter, smelter.recycling.time);

  const oreGain = (state.players.player.resources.ore || 0) - oreBefore;
  const metalsGain = (state.players.player.resources.metals || 0) - metalsBefore;
  // The Smelter has a recipe, so it's an "advanced" building (0.5 frac) like the Plasma Rig, not
  // "ordinary" (0.4) — see the recycleFrac tests above.
  assert.ok(near(oreGain, BUILDINGS.plasmarig.cost.ore * 0.5 + 44 + BUILDINGS.smelter.cost.ore * 0.5 + 12, 1e-6),
    "both buildings' cost-fraction ore AND their full ore inventory (rig backlog + smelter larder) all landed");
  assert.ok(near(metalsGain, 8, 1e-6), "the smelter's output backlog (a commodity not even in its build cost) came back in full too");
});

test("recycling a freighter banks its whole freight hold; recycling a worker banks whatever it's carrying — both in full", () => {
  const state = createGameState({ planetId: "ferros" });
  const freighter = makeUnit("hauler", "player", 500, 500);
  freighter.freight = { crystals: 30, radioactives: 15 };
  state.units.set(freighter.id, freighter);
  const worker = makeUnit("worker", "player", 600, 500);
  worker.cargo = { com: "ore", qty: 7 };
  state.units.set(worker.id, worker);
  const before = { ...state.players.player.resources };

  issueRecycle([freighter, worker]);
  updateUnitRecycle(state, freighter, freighter.recycling.time);
  updateUnitRecycle(state, worker, worker.recycling.time);

  const res = state.players.player.resources;
  assert.ok(near((res.crystals || 0) - (before.crystals || 0), 30, 1e-6), "the freighter's crystals came back in full");
  assert.ok(near((res.radioactives || 0) - (before.radioactives || 0), 15, 1e-6), "…and its radioactives too");
  // Both the Hauler's own cost-fraction refund (a freighter is "advanced": 0.5) AND the Worker's
  // (ordinary: 0.4) land in ore — both units cost ore — plus the 7 ore the worker was carrying.
  assert.ok(near((res.ore || 0) - (before.ore || 0), UNITS.hauler.cost.ore * 0.5 + UNITS.worker.cost.ore * 0.4 + 7, 1e-6),
    "the hauler's + worker's cost refunds (both paid in ore) PLUS the 7 ore the worker was carrying");
});

test("recycleValue previews exactly what recycling will actually bank — cost fraction plus full current inventory", () => {
  const state = createGameState({ planetId: "ferros" });
  const rig = makeBuilding("plasmarig", "player", 500, 500);
  rig.store = { ore: 20 };
  state.buildings.set(rig.id, rig);

  const preview = recycleValue(state, rig);
  assert.ok(near(preview.ore, BUILDINGS.plasmarig.cost.ore * 0.5 + 20, 1e-6));

  const before = state.players.player.resources.ore;
  issueRecycle([rig]);
  updateBuildingRecycle(state, rig, rig.recycling.time);
  assert.ok(near((state.players.player.resources.ore || 0) - before, preview.ore, 1e-6),
    "the preview matches exactly what actually landed in the treasury");
});

test("issueRecycle + updateUnitRecycle: a unit refunds its fraction and is removed once its timer completes", () => {
  const state = createGameState({ planetId: "ferros" });
  const worker = makeUnit("worker", "player", 500, 500);
  state.units.set(worker.id, worker);
  const before = state.players.player.resources.ore;

  issueRecycle([worker]);
  assert.deepEqual(worker.order, { type: "recycle" });

  updateUnitRecycle(state, worker, worker.recycling.time);

  assert.equal(state.units.has(worker.id), false, "removed");
  assert.ok(near(state.players.player.resources.ore - before, UNITS.worker.cost.ore * 0.4));
});

test("a unit mid-recycle is inert: sim.js's tick loop skips it entirely (no movement, no auto-haul reassignment)", () => {
  const state = createGameState({ planetId: "ferros" });
  const worker = makeUnit("worker", "player", 500, 500);
  state.units.set(worker.id, worker);
  issueRecycle([worker]);
  const x0 = worker.x, y0 = worker.y;

  for (let i = 0; i < 20; i++) tick(state, 0.1);

  assert.equal(worker.x, x0, "never moved");
  assert.equal(worker.y, y0, "never moved");
  assert.equal(worker.order.type, "recycle", "never got reassigned to a haul/service job");
  assert.ok(worker.recycling.progress > 0, "but the recycle timer itself did advance");
});

test("issueCancelRecycle: free, no refund, and the entity resumes normal life", () => {
  const state = createGameState({ planetId: "ferros" });
  const rig = makeBuilding("plasmarig", "player", 500, 500);
  const worker = makeUnit("worker", "player", 500, 500);
  state.buildings.set(rig.id, rig);
  state.units.set(worker.id, worker);
  const before = state.players.player.resources.ore;

  issueRecycle([rig, worker]);
  issueCancelRecycle([rig, worker]);

  assert.equal(rig.recycling, null);
  assert.equal(worker.recycling, null);
  assert.equal(worker.order, null, "freed for a fresh order");
  assert.equal(state.players.player.resources.ore, before, "nothing was refunded — nothing was ever spent");
  assert.equal(canRecycle(rig), true, "can be recycled again");
});

test("issueStop also stands a unit's recycle down, so Stop is never a dead end", () => {
  const state = createGameState({ planetId: "ferros" });
  const worker = makeUnit("worker", "player", 500, 500);
  state.units.set(worker.id, worker);
  issueRecycle([worker]);

  issueStop([worker]);

  assert.equal(worker.recycling, null);
  assert.equal(worker.order, null);
  for (let i = 0; i < 5; i++) tick(state, 0.1);
  assert.equal(state.units.has(worker.id), true, "still around — Stop cancelled the recycle, it didn't just hide the order");
});

test("issueRecycle silently skips ineligible entries in a mixed selection", () => {
  const state = createGameState({ planetId: "ferros" });
  const cc = [...state.buildings.values()].find(b => b.type === "command");
  const rig = makeBuilding("plasmarig", "player", 600, 500);
  state.buildings.set(rig.id, rig);

  issueRecycle([cc, rig]);

  assert.equal(cc.recycling, undefined, "the Command Center was skipped");
  assert.ok(rig.recycling, "the rig still started");
});

test("T-019: without an owner argument, issueRecycle is unchanged — every pre-existing caller stays byte-identical", () => {
  const state = createGameState({ planetId: "ferros" });
  const enemyRig = makeBuilding("plasmarig", "ai", 600, 500);
  state.buildings.set(enemyRig.id, enemyRig);

  issueRecycle([enemyRig]);   // no owner passed — the legacy call shape

  assert.ok(enemyRig.recycling, "unchanged from before this fix: no owner argument means no filtering at all");
});

test("T-019: with an owner argument, issueRecycle skips any entity that owner doesn't own", () => {
  const state = createGameState({ planetId: "ferros" });
  const ownRig = makeBuilding("plasmarig", "player", 600, 500);
  const enemyRig = makeBuilding("plasmarig", "ai", 700, 500);
  state.buildings.set(ownRig.id, ownRig);
  state.buildings.set(enemyRig.id, enemyRig);

  issueRecycle([ownRig, enemyRig], "player");

  assert.ok(ownRig.recycling, "the player's own rig starts recycling");
  assert.equal(enemyRig.recycling, undefined, "the enemy's rig must be rejected, not silently recycled on the player's say-so");
});

test("save/load round-trip preserves an in-progress recycle's exact timer", () => {
  const state = createGameState({ planetId: "ferros" });
  const rig = makeBuilding("plasmarig", "player", 500, 500);
  state.buildings.set(rig.id, rig);
  issueRecycle([rig]);
  updateBuildingRecycle(state, rig, rig.recycling.time * 0.3);
  const progress = rig.recycling.progress;

  const loaded = deserializeGame(serializeGame(state));
  const loadedRig = [...loaded.units.values(), ...loaded.buildings.values()].find(e => e.id === rig.id);

  assert.ok(loadedRig.recycling, "survived the round trip");
  assert.ok(near(loadedRig.recycling.progress, progress));
  updateBuildingRecycle(loaded, loadedRig, loadedRig.recycling.time * 0.71);
  assert.equal(loaded.buildings.has(rig.id), false, "picks the countdown back up from where it was saved");
});

test("save hardening: a tampered recycling block is clamped instead of corrupting the timer", () => {
  const state = createGameState({ planetId: "ferros" });
  const rig = makeBuilding("plasmarig", "player", 500, 500);
  state.buildings.set(rig.id, rig);
  issueRecycle([rig]);
  rig.recycling.progress = -999;
  rig.recycling.time = -5;

  const loaded = deserializeGame(serializeGame(state));
  const loadedRig = loaded.buildings.get(rig.id);

  assert.ok(loadedRig.recycling.progress >= 0 && loadedRig.recycling.progress <= 1);
  assert.ok(loadedRig.recycling.time >= 1, "a non-positive time would otherwise divide-toward-nonsense next tick");
});

test("recycling a formation leader releases its followers instead of stranding them (A1)", () => {
  // The twin of the colony-ship case: updateUnitRecycle also removes a unit at full hp, so an
  // hp-only liveness check in keepFollowingLeader leaves the squad chasing a ghost.
  const st = createGameState({ planetId: "ferros", seed: 8 });
  const leader = makeUnit("skiff", "player", 700, 500);
  const a = makeUnit("skiff", "player", 720, 500);
  const b = makeUnit("skiff", "player", 680, 500);
  for (const u of [leader, a, b]) st.units.set(u.id, u);

  issueMove([leader, a, b], 900, 500, false, { shape: "wedge" });
  assert.equal(a.order.type, "follow-leader", "fixture sanity: the squad is following");

  issueRecycle([leader]);
  for (let i = 0; i < 400 && st.units.has(leader.id); i++) tick(st, 0.1);
  assert.ok(!st.units.has(leader.id), "fixture sanity: the leader finished recycling and was removed");
  assert.ok(leader.hp > 0, "fixture sanity: and it was removed ALIVE");

  tick(st, 0.1);
  assert.equal(a.order, null, "a follower must be released when its leader is recycled away");
  assert.equal(b.order, null);
});
