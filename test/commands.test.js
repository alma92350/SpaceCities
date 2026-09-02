import { test } from "node:test";
import assert from "node:assert/strict";
import { issueMove, issueAttackMove, issueAttack, issueGather, issueBuild, issueAssistBuild, issueSetRally, issueStop, issueHold, issueHoldFormation, issueServiceBuilding, issueRepair, issueSetHomeBase, issuePatrol } from "../engine/commands.js";
import { createGameState, makeBuilding, makeUnit } from "../engine/state.js";
import { BUILDINGS } from "../engine/entities.js";
import { formationSlots } from "../engine/formation.js";

// Selectable units carry a real `type` — issueAttack now validates it (a weaponless
// type is filtered out so it can't NaN-poison a target), so a faithful stand-in needs
// one. "skiff" is an armed combat unit; the cargo field is just along for the ride —
// gather/build eligibility is capability-gated by real UNITS[type] flags now (canGatherType/
// canBuildCategory), not by cargo presence, so a gather/build test needs a real capable
// type — see capableDummyUnits below.
function dummyUnits(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `u${i}`, type: "skiff", order: null, cargo: { com: null, qty: 0 } }));
}

// A worker-typed stand-in: real UNITS.worker capability (canGather, every buildCategories
// entry), for the gather/assist-build eligibility tests below.
function capableDummyUnits(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `u${i}`, type: "worker", order: null, cargo: { com: null, qty: 0 } }));
}

function playerWorker(state) {
  return [...state.units.values()].find(u => u.owner === "player" && u.type === "worker");
}

test("issueMove spreads a group across distinct destinations instead of one shared point", () => {
  const units = dummyUnits(6);
  issueMove(units, 900, 700);

  const dests = units.map(u => `${u.order.x},${u.order.y}`);
  assert.equal(new Set(dests).size, 6, "every unit should get its own destination");
});

test("issueMove leaves a lone unit's destination exactly on the clicked point", () => {
  const [unit] = dummyUnits(1);
  issueMove([unit], 500, 400);
  assert.deepEqual(unit.order, { type: "move", x: 500, y: 400 });
});

test("issueAttackMove centers the formation on the target point", () => {
  const units = dummyUnits(4);
  issueAttackMove(units, 900, 700);

  const avgX = units.reduce((s, u) => s + u.order.x, 0) / units.length;
  const avgY = units.reduce((s, u) => s + u.order.y, 0) / units.length;
  assert.equal(avgX, 900);
  assert.equal(avgY, 700);
  units.forEach(u => assert.equal(u.order.type, "attack-move"));
});

test("issueMove's optional formation shape changes how the group spreads (line vs the default grid)", () => {
  const grid = dummyUnits(4);
  grid.forEach(u => { u.x = 0; u.y = 0; });
  issueMove(grid, 1000, 0);
  const line = dummyUnits(4);
  line.forEach(u => { u.x = 0; u.y = 0; });
  issueMove(line, 1000, 0, false, { shape: "line", leaderPos: "front" });
  const gridSpread = new Set(grid.map(u => u.order.y.toFixed(1))).size;
  const lineSpread = new Set(line.map(u => u.order.y.toFixed(1))).size;
  assert.ok(gridSpread >= 2 && lineSpread >= 2, "both shapes spread the group across distinct lateral positions");
  assert.notDeepEqual(grid.map(u => u.order), line.map(u => u.order), "a chosen shape actually changes the destinations");
});

test("issueAttackMove passes its formation option through the same way as issueMove", () => {
  const units = dummyUnits(3);
  units.forEach(u => { u.x = 0; u.y = 0; });
  issueAttackMove(units, 1000, 0, false, { shape: "circle" });
  units.forEach(u => assert.equal(u.order.type, "attack-move"));
  const avgX = units.reduce((s, u) => s + u.order.x, 0) / units.length;
  assert.ok(Math.abs(avgX - 1000) < 1, "still centers on the target point");
});

/* ---------------------------------------------------------------------------------------------
   Range-layered formation ranks (docs/improvement-proposals.md): a shaped (non-grid) formation's
   dispatchFormation re-pairs followers with slots by weapon range instead of raw selection-array
   order — see test/formation.test.js for the bulk of this coverage (issueMove/issueHoldFormation,
   both shapes and the degenerate hold-in-place heading). These two round out the picture: the
   same reorder also applies via issueAttackMove (not just issueMove), and the legacy grid path
   stays byte-identical for a real PLAYER squad specifically — every dummyUnits() fixture above is
   deliberately owner-less, so it only ever exercises the AI/no-squad branch of dispatchFormation,
   never the player leader/follower path the reorder actually lives in.
   --------------------------------------------------------------------------------------------- */

// A player-owned, typed stand-in — a real `type` so UNITS[type].range resolves, and
// `owner:"player"` so dispatchFormation takes the leader/follower squad path (the range-layered
// reorder only ever runs there — see the file header comment above).
function playerUnit(id, type, x = 0, y = 0) {
  return { id, type, x, y, owner: "player", order: null };
}

test("issueAttackMove also range-ranks a shaped formation's followers, the same as issueMove", () => {
  const leader = playerUnit("L", "skiff");
  const r1 = playerUnit("R1", "breacher");   // range 150
  const b1 = playerUnit("B1", "bastion");    // range 44
  const r2 = playerUnit("R2", "breacher");
  const b2 = playerUnit("B2", "bastion");
  const units = [leader, r1, b1, r2, b2];

  issueAttackMove(units, 1000, 0, false, { shape: "wedge", leaderPos: "front" });

  const bastionFwd = [b1, b2].map(u => u.order.offsetX);
  const breacherFwd = [r1, r2].map(u => u.order.offsetX);
  assert.ok(Math.min(...bastionFwd) > Math.max(...breacherFwd),
    "issueAttackMove's shaped formation screens Bastions ahead of Breachers too");
});

test("a grid-shaped formation never range-reorders a real PLAYER squad — the legacy path stays byte-identical", () => {
  const leader = playerUnit("L", "skiff");
  const r1 = playerUnit("R1", "breacher");   // long range, listed first among followers
  const b1 = playerUnit("B1", "bastion");    // short range, listed second
  const units = [leader, r1, b1];

  // formationSlots' own raw grid spread — dispatchFormation must pass this straight through with
  // no range-based re-pairing when shape is "grid".
  const rawSpots = formationSlots(units, 1000, 0, { shape: "grid" });

  issueMove(units, 1000, 0, false, { shape: "grid" });

  assert.deepEqual({ x: r1.order.offsetX, y: r1.order.offsetY },
    { x: rawSpots[1].x - rawSpots[0].x, y: rawSpots[1].y - rawSpots[0].y },
    "the breacher (listed first among followers) keeps formationSlots' own raw slot 1, not reassigned by range");
  assert.deepEqual({ x: b1.order.offsetX, y: b1.order.offsetY },
    { x: rawSpots[2].x - rawSpots[0].x, y: rawSpots[2].y - rawSpots[0].y },
    "the bastion keeps formationSlots' own raw slot 2");
});

test("T-017: with state passed, a human-controlled \"ai\" squad gets the real leader/follower formation, not the flat AI spread", () => {
  const state = createGameState({ planetId: "ferros" });
  state.ai = null;   // simulate a human actually driving the "ai" seat — no AI controller

  const leader = { id: "L", type: "skiff", x: 0, y: 0, owner: "ai", order: null };
  const r1 = { id: "R1", type: "breacher", x: 0, y: 0, owner: "ai", order: null };
  const b1 = { id: "B1", type: "bastion", x: 0, y: 0, owner: "ai", order: null };
  const units = [leader, r1, b1];

  const rawSpots = formationSlots(units, 1000, 0, { shape: "grid" });
  issueMove(units, 1000, 0, false, { shape: "grid" }, state);

  assert.deepEqual({ x: r1.order.offsetX, y: r1.order.offsetY },
    { x: rawSpots[1].x - rawSpots[0].x, y: rawSpots[1].y - rawSpots[0].y },
    "a human-controlled \"ai\" leader must get the same range-ranked formation slot a player squad gets");
  assert.deepEqual({ x: b1.order.offsetX, y: b1.order.offsetY },
    { x: rawSpots[2].x - rawSpots[0].x, y: rawSpots[2].y - rawSpots[0].y });
});

test("T-017: without state, an \"ai\" squad still gets the flat AI spread — legacy callers unchanged", () => {
  const units = [
    { id: "L", type: "skiff", x: 0, y: 0, owner: "ai", order: null },
    { id: "F1", type: "breacher", x: 0, y: 0, owner: "ai", order: null },
  ];
  issueMove(units, 1000, 0, false, { shape: "grid" });   // no state argument — every pre-existing caller
  // The flat spread's order never carries offsetX/offsetY — only the leader/follower mechanic sets
  // those — so their absence is exactly what distinguishes "unchanged" from "now gets formation".
  assert.equal(units[0].order.offsetX, undefined, "no leader/follower formation without state — byte-identical to before this fix");
});

test("issueAttack sends every unit at the same explicit target id (focus fire, no spreading)", () => {
  const units = dummyUnits(3);
  issueAttack(units, "target-1");
  units.forEach(u => assert.deepEqual(u.order, { type: "attack", targetId: "target-1" }));
});

test("issueAttack ignores weaponless units so they can't NaN-poison a target", () => {
  const colonyship = { id: "u1", type: "colonyship", order: null };   // no attack stat
  const freighter = { id: "u2", type: "hauler", order: null };        // no attack stat
  const skiff = { id: "u3", type: "skiff", order: null };             // armed
  const mender = { id: "u4", type: "mender", order: null };           // support: order reinterpreted as advance-and-mend
  issueAttack([colonyship, freighter, skiff, mender], "enemy-1");
  assert.equal(colonyship.order, null, "a colony ship gets no attack order (attackDamage would compute NaN)");
  assert.equal(freighter.order, null, "a freighter gets no attack order either");
  assert.deepEqual(skiff.order, { type: "attack", targetId: "enemy-1" }, "an armed unit attacks");
  assert.deepEqual(mender.order, { type: "attack", targetId: "enemy-1" }, "a support drone still accepts it");
});

test("issueGather only assigns gather-capable units", () => {
  const units = capableDummyUnits(2);
  units[1].type = "skiff";   // simulate a non-gatherer slipping into the selection
  issueGather(units, "node-1");
  assert.deepEqual(units[0].order, { type: "gather", nodeId: "node-1" });
  assert.equal(units[1].order, null);
});

test("issueAssistBuild sends every worker in the group to the same site, no formation spreading", () => {
  const units = capableDummyUnits(3);
  issueAssistBuild(units, "site-1", "barracks");
  units.forEach(u => assert.deepEqual(u.order, { type: "build", buildingId: "site-1" }));
});

test("issueAssistBuild only assigns builders eligible for the target's category", () => {
  const units = capableDummyUnits(2);
  units[1].type = "skiff";   // e.g. a skiff caught in the same selection
  issueAssistBuild(units, "site-1", "barracks");
  assert.deepEqual(units[0].order, { type: "build", buildingId: "site-1" });
  assert.equal(units[1].order, null);
});

test("issueBuild pays the cost, founds a constructing site, and puts the worker on it", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const worker = playerWorker(state);
  const before = state.players.player.resources.ore;

  const id = issueBuild(state, worker.id, "barracks", 800, 500);

  assert.ok(id, "a successful build should return the new site's id");
  assert.equal(state.players.player.resources.ore, before - BUILDINGS.barracks.cost.ore);
  const site = state.buildings.get(id);
  assert.equal(site.constructing, true);
  assert.equal(site.buildProgress, 0);
  assert.deepEqual(worker.order, { type: "build", buildingId: id });
});

test("issueBuild gates a Foundry on a completed Barracks", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const worker = playerWorker(state);
  state.players.player.resources.ore = 1000;

  // No Barracks yet -> the Foundry's prereq is unmet, so founding is refused.
  assert.equal(issueBuild(state, worker.id, "foundry", 800, 500), null, "no Barracks -> Foundry refused");

  const barracks = makeBuilding("barracks", "player", 700, 500);   // completed
  state.buildings.set(barracks.id, barracks);
  const id = issueBuild(state, worker.id, "foundry", 820, 520);
  assert.ok(id, "with a completed Barracks, the Foundry can be founded");
});

test("issueBuild is category-gated: only a unit flagged for a category can found it", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  Object.assign(state.players.player.resources, { ore: 2000, crystals: 2000 });   // turret also costs crystals
  const worker = playerWorker(state);
  const barracks = makeBuilding("barracks", "player", 700, 500);   // completed, so Foundry's prereq is met
  state.buildings.set(barracks.id, barracks);

  const spawn = (type, x, y) => { const u = makeUnit(type, "player", x, y); state.units.set(u.id, u); return u; };
  const mender = spawn("mender", worker.x + 20, worker.y);
  const skiff = spawn("skiff", worker.x + 40, worker.y);

  assert.equal(issueBuild(state, mender.id, "refinery", 900, 500), null, "Mender has no build capability at all");
  assert.equal(issueBuild(state, skiff.id, "turret", 940, 500), null, "a combat unit has no build capability");

  assert.ok(issueBuild(state, worker.id, "turret", 960, 500), "Worker CAN found a Military building");
  assert.ok(issueBuild(state, worker.id, "foundry", 1000, 500), "Worker CAN found an Industrial building");
  assert.ok(issueBuild(state, worker.id, "habitat", 1040, 500), "Worker (the generalist) can found anything");
});

test("issueBuild refuses when the player can't afford it: no site, no charge", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const worker = playerWorker(state);
  state.players.player.resources.ore = 0;
  const buildingsBefore = state.buildings.size;

  const id = issueBuild(state, worker.id, "barracks", 800, 500);

  assert.equal(id, null);
  assert.equal(state.buildings.size, buildingsBefore);
  assert.equal(state.players.player.resources.ore, 0);
  assert.equal(worker.order, null);
});

test("issueBuild refuses an invalid placement without charging for it", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const worker = playerWorker(state);
  const cc = [...state.buildings.values()].find(b => b.owner === "player" && b.type === "command");
  const before = state.players.player.resources.ore;
  const buildingsBefore = state.buildings.size;

  const id = issueBuild(state, worker.id, "barracks", cc.x, cc.y);   // dead center of the Command Center

  assert.equal(id, null);
  assert.equal(state.players.player.resources.ore, before, "a rejected placement must not cost anything");
  assert.equal(state.buildings.size, buildingsBefore);
  assert.equal(worker.order, null);
});

test("issueBuild refuses an Odyssey-only building on the skirmish path (byte-identity guard)", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });   // a skirmish: state.endless is falsy
  const worker = playerWorker(state);
  state.players.player.resources.ore = 999;   // funds in hand, so ONLY the odysseyOnly gate can reject it
  const before = state.buildings.size;

  const id = issueBuild(state, worker.id, "reactor", 800, 500);   // reactor is odysseyOnly with no prereqs

  assert.equal(id, null, "an Odyssey-only building can never be founded in a skirmish");
  assert.equal(state.buildings.size, before, "…and founds nothing");
  assert.equal(state.players.player.resources.ore, 999, "…and charges nothing");
});

test("a Command Center expansion is issuable like any building: charged in full, founded constructing", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const worker = playerWorker(state);
  state.players.player.resources.ore = 500;   // the starting 300 deliberately can't afford the 400 up front

  const id = issueBuild(state, worker.id, "command", 800, 500);

  assert.ok(id, "a clear spot with funds in hand should found the expansion");
  assert.equal(state.players.player.resources.ore, 500 - BUILDINGS.command.cost.ore);
  const site = state.buildings.get(id);
  assert.equal(site.type, "command");
  assert.equal(site.constructing, true);
});

test("issueBuild founds the Market on the Odyssey path: cheap, fast, and ungated — meant to be first", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5, endless: true });
  // endless seeds a Colony Ship, not a built CC + workers (seedPlayer) — plant a Worker directly,
  // same shortcut the industry chain tests use to skip the deploy step (test/industry.test.js).
  const worker = makeUnit("worker", "player", 780, 480);
  state.units.set(worker.id, worker);
  state.players.player.resources.ore = 100;

  const id = issueBuild(state, worker.id, "market", 800, 500);

  assert.ok(id, "a Worker can found a Market with no prereqs, right from the start");
  assert.equal(state.players.player.resources.ore, 100 - BUILDINGS.market.cost.ore);
  const site = state.buildings.get(id);
  assert.equal(site.type, "market");
  assert.equal(site.constructing, true);
});

test("issueBuild refuses the Market on the skirmish path — trading is an Odyssey-only system", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });   // a skirmish: state.endless is falsy
  const worker = playerWorker(state);
  state.players.player.resources.ore = 999;   // funds in hand, so ONLY the odysseyOnly gate can reject it
  const before = state.buildings.size;

  const id = issueBuild(state, worker.id, "market", 800, 500);

  assert.equal(id, null, "the Market can never be founded in a skirmish");
  assert.equal(state.buildings.size, before);
  assert.equal(state.players.player.resources.ore, 999, "…and charges nothing");
});

test("issueBuild pays a multi-commodity cost and refuses when the crystal half is missing", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const worker = playerWorker(state);
  state.players.player.resources.ore = 500;
  state.players.player.resources.crystals = 200;

  const id = issueBuild(state, worker.id, "turret", 800, 500);

  assert.ok(id, "a clear spot with both commodities in hand should found the turret");
  assert.equal(state.players.player.resources.ore, 500 - BUILDINGS.turret.cost.ore);
  assert.equal(state.players.player.resources.crystals, 200 - BUILDINGS.turret.cost.crystals);

  state.players.player.resources.crystals = 0;   // ore still ample, but the crystal half is gone
  const oreBefore = state.players.player.resources.ore;
  const buildingsBefore = state.buildings.size;

  const denied = issueBuild(state, worker.id, "turret", 900, 500);

  assert.equal(denied, null, "ore alone can't cover a crystal-costed building");
  assert.equal(state.buildings.size, buildingsBefore, "a rejected build founds no site");
  assert.equal(state.players.player.resources.ore, oreBefore, "and charges nothing");
});

test("a queued order appends as a waypoint instead of replacing the active one", () => {
  const [unit] = dummyUnits(1);
  issueMove([unit], 500, 400);              // plain: takes effect now
  issueMove([unit], 600, 400, true);        // queued behind it
  issueAttackMove([unit], 700, 400, true);  // queued behind that

  assert.deepEqual(unit.order, { type: "move", x: 500, y: 400 }, "the active order is untouched");
  assert.equal(unit.orderQueue.length, 2, "both queued commands are waiting");
  assert.deepEqual(unit.orderQueue[0], { type: "move", x: 600, y: 400 });
  assert.equal(unit.orderQueue[1].type, "attack-move");
});

test("a queued order to a fully idle unit takes effect immediately, not as a dead first waypoint", () => {
  const [unit] = dummyUnits(1);
  issueMove([unit], 500, 400, true);   // queued, but nothing is active or waiting yet
  assert.deepEqual(unit.order, { type: "move", x: 500, y: 400 });
  assert.equal(unit.orderQueue.length, 0);
});

test("a plain order clears any queued waypoints", () => {
  const [unit] = dummyUnits(1);
  issueMove([unit], 500, 400);
  issueMove([unit], 600, 400, true);
  issueMove([unit], 700, 400, true);
  assert.equal(unit.orderQueue.length, 2);

  issueAttack([unit], "target-1");   // a plain command cancels the chain
  assert.deepEqual(unit.order, { type: "attack", targetId: "target-1" });
  assert.equal(unit.orderQueue.length, 0);
});

test("queued orders are context-sensitive — a mix of move, attack, and gather in one chain", () => {
  const [unit] = capableDummyUnits(1);
  issueMove([unit], 500, 400);
  issueAttack([unit], "enemy-9", true);
  issueGather([unit], "node-3", true);

  assert.equal(unit.orderQueue.length, 2);
  assert.deepEqual(unit.orderQueue[0], { type: "attack", targetId: "enemy-9" });
  assert.deepEqual(unit.orderQueue[1], { type: "gather", nodeId: "node-3" });
});

test("issueSetRally replaces a building's rally point", () => {
  const state = createGameState({ planetId: "ferros" });
  const building = makeBuilding("command", "player", 500, 500);
  state.buildings.set(building.id, building);
  const originalRally = building.rally;

  issueSetRally(state, building.id, 900, 300);

  assert.deepEqual(building.rally, { x: 900, y: 300, nodeId: null });
  assert.notDeepEqual(building.rally, originalRally);
});

test("issueSetRally can bind the rally to a resource node for rally-to-mine", () => {
  const state = createGameState({ planetId: "ferros" });
  const building = makeBuilding("command", "player", 500, 500);
  state.buildings.set(building.id, building);
  issueSetRally(state, building.id, 620, 480, "n7");
  assert.deepEqual(building.rally, { x: 620, y: 480, nodeId: "n7" });
});

test("T-021/D2: issueSetRally silently no-ops on an unknown buildingId, matching every other issue* function's ineligible-target convention", () => {
  const state = createGameState({ planetId: "ferros" });
  assert.doesNotThrow(() => issueSetRally(state, "no-such-building", 1, 1));
});

test("issueHold sets the stance on combat units only; a move order or Stop clears it", () => {
  const combat = { id: "u1", type: "skiff", order: null };
  const worker = { id: "u2", type: "worker", order: null };

  issueHold([combat, worker]);
  assert.equal(combat.hold, true, "a combat unit takes the Hold stance");
  assert.ok(!worker.hold, "a worker doesn't");

  issueMove([combat], 100, 100);
  assert.equal(combat.hold, false, "issuing a move cancels Hold");

  combat.hold = true;
  issueStop([combat]);
  assert.equal(combat.hold, false, "Stop cancels Hold too");
});

test("issueRepair sends only logistics-capable units to patch a target, manually and standing", () => {
  const units = capableDummyUnits(2);
  units[1].type = "skiff";   // e.g. a combat unit caught in the same selection
  issueRepair(units, "target-1");
  assert.deepEqual(units[0].order, { type: "repair", targetId: "target-1", phase: "toSite", manual: true });
  assert.equal(units[1].order, null, "a non-worker never gets a repair order");
});

test("issueServiceBuilding sends only logistics-capable units to service a building, manually and standing", () => {
  const units = capableDummyUnits(2);
  units[1].type = "skiff";   // e.g. a combat unit caught in the same selection
  issueServiceBuilding(units, "building-1");
  assert.deepEqual(units[0].order, { type: "service", buildingId: "building-1", phase: "plan", manual: true });
  assert.equal(units[1].order, null, "a non-worker never gets a service order");
});

test("issueSetHomeBase pins eligible units (worker/support/freighter) to a Command Center, ignoring the rest", () => {
  const worker = { id: "u1", type: "worker", order: null };
  const mender = { id: "u2", type: "mender", order: null };
  const hauler = { id: "u3", type: "hauler", order: null };
  const skiff = { id: "u4", type: "skiff", order: null };

  issueSetHomeBase([worker, mender, hauler, skiff], "cc-1");

  assert.equal(worker.homeCC, "cc-1");
  assert.equal(mender.homeCC, "cc-1", "a Mender consults a home zone too (autoRepairRoam)");
  assert.equal(hauler.homeCC, "cc-1", "a freighter running AI-logistics consults it as well");
  assert.equal(skiff.homeCC, undefined, "a combat unit never consults a home zone, so it's left untouched");
});

test("issueSetHomeBase is passive — it never touches a unit's current order", () => {
  const worker = { id: "u1", type: "worker", order: { type: "gather", nodeId: "n1" } };
  issueSetHomeBase([worker], "cc-2");
  assert.equal(worker.homeCC, "cc-2");
  assert.deepEqual(worker.order, { type: "gather", nodeId: "n1" }, "whatever it was doing keeps running");
});

/* ---------------------------------------------------------------------------------------------
   Patrol: looping attack-move waypoints (docs/improvement-proposals.md). issuePatrol(units,
   points) builds an ordinary attack-move waypoint chain — the first point becomes the active
   order, the rest queue behind it — with every leg flagged patrol:true so engine/sim.js's
   pull-next-queued-order step (test/sim.test.js) recycles each leg onto the tail the instant
   it's pulled off the front, so the chain cycles instead of letting the unit go idle once it
   runs out. The active leg is the one exception: it lands directly in `order` rather than being
   pulled off the queue, so issuePatrol gives it its own trailing copy by hand — otherwise the
   very first waypoint would silently drop out of the rotation after one lap (see sim.test.js's
   "cycles forever" test for the end-to-end proof). Gated to combat/scout roles, the same
   UNITS[type].role check issueHold already uses.
   --------------------------------------------------------------------------------------------- */

test("issuePatrol builds an attack-move waypoint chain with every leg flagged patrol:true", () => {
  const [unit] = dummyUnits(1);   // skiff — combat role
  issuePatrol([unit], [{ x: 500, y: 400 }, { x: 700, y: 600 }, { x: 300, y: 900 }]);

  assert.deepEqual(unit.order, { type: "attack-move", x: 500, y: 400, patrol: true },
    "the first point becomes the active leg");
  assert.equal(unit.orderQueue.length, 3, "the other two points, PLUS a trailing copy of the active leg, wait behind it");
  assert.deepEqual(unit.orderQueue[0], { type: "attack-move", x: 700, y: 600, patrol: true });
  assert.deepEqual(unit.orderQueue[1], { type: "attack-move", x: 300, y: 900, patrol: true });
  assert.deepEqual(unit.orderQueue[2], { type: "attack-move", x: 500, y: 400, patrol: true },
    "the trailing copy of the first leg — without it, the rotation would lose this point after one lap");
});

test("issuePatrol only assigns combat/scout-role units, gated the same way issueHold is", () => {
  const [worker] = capableDummyUnits(1);   // role "worker"
  issuePatrol([worker], [{ x: 500, y: 400 }]);
  assert.equal(worker.order, null, "a worker never gets a patrol order");
  assert.equal(worker.orderQueue, undefined, "and its orderQueue is untouched — dispatch never ran for it");
});

test("issuePatrol accepts a scout-role unit (the Ranger), not just combat", () => {
  const scout = { id: "u1", type: "ranger", order: null };
  issuePatrol([scout], [{ x: 100, y: 100 }, { x: 200, y: 200 }]);
  assert.deepEqual(scout.order, { type: "attack-move", x: 100, y: 100, patrol: true });
  assert.equal(scout.orderQueue.length, 2, "the second point, plus the trailing copy of the active leg");
});

test("issuePatrol replaces whatever the unit was doing, same as any other plain (non-queued) order", () => {
  const [unit] = dummyUnits(1);
  issueMove([unit], 900, 900);
  issueMove([unit], 950, 950, true);   // a queued waypoint behind it
  assert.equal(unit.orderQueue.length, 1, "sanity: something was queued before the patrol command");

  issuePatrol([unit], [{ x: 500, y: 400 }]);

  assert.deepEqual(unit.order, { type: "attack-move", x: 500, y: 400, patrol: true }, "the old move order is gone");
  assert.deepEqual(unit.orderQueue, [{ type: "attack-move", x: 500, y: 400, patrol: true }],
    "the old queued waypoint is dropped — all that's left is the trailing copy of the (single) patrol leg");
});

// A degenerate but valid case: one point still loops (attack-move back to the same spot forever)
// rather than behaving like a one-shot attack-move — the trailing copy is what makes that so.
test("issuePatrol with a single point still loops (the trailing copy is what makes even one point cycle)", () => {
  const [unit] = dummyUnits(1);
  issuePatrol([unit], [{ x: 500, y: 400 }]);
  assert.deepEqual(unit.order, { type: "attack-move", x: 500, y: 400, patrol: true });
  assert.deepEqual(unit.orderQueue, [{ type: "attack-move", x: 500, y: 400, patrol: true }]);
});

test("issuePatrol with no points is a harmless no-op", () => {
  const [unit] = dummyUnits(1);
  issuePatrol([unit], []);
  assert.equal(unit.order, null);
});
