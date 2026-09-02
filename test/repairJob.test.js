import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeBuilding, makeUnit } from "../engine/state.js";
import { assignRepair, updateRepairJob, NEEDS_REPAIR } from "../engine/repair.js";
import { issueRepair } from "../engine/commands.js";
import { tick } from "../engine/sim.js";

function base() {
  const s = createGameState({ planetId: "ferros" });
  const cc = [...s.buildings.values()].find(b => b.owner === "player" && b.type === "command");
  const worker = [...s.units.values()].find(u => u.owner === "player" && u.type === "worker");
  return { s, cc, worker };
}

test("assignRepair sends an idle worker to a damaged own building below the NEEDS_REPAIR threshold", () => {
  const { s, cc, worker } = base();
  worker.x = cc.x; worker.y = cc.y;
  const turret = makeBuilding("turret", "player", cc.x + 100, cc.y, { hp: 100 });   // 100/350 ≈ 29%
  s.buildings.set(turret.id, turret);

  assignRepair(s, worker);

  assert.ok(worker.order, "the worker took a job");
  assert.equal(worker.order.type, "repair");
  assert.equal(worker.order.targetId, turret.id);
});

test("T-017: the per-tick auto-repair gate applies to ANY human-controlled seat, not just literally \"player\"", () => {
  const s = createGameState({ planetId: "ferros" });
  const cc = [...s.buildings.values()].find(b => b.owner === "ai" && b.type === "command");
  const worker = [...s.units.values()].find(u => u.owner === "ai" && u.type === "worker");
  worker.x = cc.x; worker.y = cc.y; worker.order = null;
  const turret = makeBuilding("turret", "ai", cc.x + 100, cc.y, { hp: 100 });   // 100/350 ≈ 29%, below NEEDS_REPAIR
  s.buildings.set(turret.id, turret);

  s.ai = null;   // simulate a human actually driving the "ai" seat — no AI controller
  tick(s, 0.1);

  assert.ok(worker.order, "a human-controlled seat's idle worker must get the same auto-repair assist \"player\" always got");
  assert.equal(worker.order.type, "repair");
  assert.equal(worker.order.targetId, turret.id);
});

test("a building only lightly scratched (still above NEEDS_REPAIR) is left alone by auto-assignment", () => {
  const { s, cc, worker } = base();
  worker.x = cc.x; worker.y = cc.y;
  const turret = makeBuilding("turret", "player", cc.x + 100, cc.y);
  turret.hp = Math.ceil(turret.maxHp * (NEEDS_REPAIR + 0.05));   // just above the attract threshold
  s.buildings.set(turret.id, turret);

  assignRepair(s, worker);

  assert.equal(worker.order, null, "no worker gets pulled off other work for a trivial scratch");
});

test("a building still under construction is never targeted — it has no battle damage to mend yet", () => {
  const { s, cc, worker } = base();
  worker.x = cc.x; worker.y = cc.y;
  const site = makeBuilding("barracks", "player", cc.x + 100, cc.y, { constructing: true, hp: 30 });
  s.buildings.set(site.id, site);

  assignRepair(s, worker);

  assert.equal(worker.order, null, "a construction site is left to its builder");
});

test("a worker's repair job can also target a wounded mobile UNIT, not just a building", () => {
  const { s, cc, worker } = base();
  worker.x = cc.x; worker.y = cc.y;
  const hurtRanger = makeUnit("ranger", "player", cc.x + 20, cc.y);
  hurtRanger.hp = 5;
  s.units.set(hurtRanger.id, hurtRanger);

  assignRepair(s, worker);

  assert.ok(worker.order, "the worker took a job");
  assert.equal(worker.order.targetId, hurtRanger.id, "a wounded unit is a valid repair target too");
});

test("a worker never assigns itself as its own repair target", () => {
  const { s, cc, worker } = base();
  worker.x = cc.x; worker.y = cc.y;
  worker.hp = 5;   // the worker itself is badly hurt

  assignRepair(s, worker);

  assert.equal(worker.order, null, "no other damaged friendly exists, and it won't repair itself");
});

test("updateRepairJob chases and heals a wounded mobile unit target the same way it patches a building", () => {
  const { s, cc, worker } = base();
  const hurt = makeUnit("ranger", "player", cc.x + 200, cc.y);
  hurt.hp = 10;
  s.units.set(hurt.id, hurt);
  worker.x = cc.x; worker.y = cc.y;
  worker.order = { type: "repair", targetId: hurt.id, phase: "toSite" };

  for (let i = 0; i < 4000 && hurt.hp < hurt.maxHp; i++) updateRepairJob(s, worker, 0.05);

  assert.equal(hurt.hp, hurt.maxHp, "the wounded unit was fully patched");
  assert.equal(worker.order, null, "an auto-assigned worker frees up once the job is done");
});

test("updateRepairJob walks to the building, patches it up over time, and auto-frees the worker once full", () => {
  const { s, cc, worker } = base();
  const turret = makeBuilding("turret", "player", cc.x + 300, cc.y, { hp: 50 });
  s.buildings.set(turret.id, turret);
  worker.x = cc.x; worker.y = cc.y;
  worker.order = { type: "repair", targetId: turret.id, phase: "toSite" };

  for (let i = 0; i < 4000 && turret.hp < turret.maxHp; i++) updateRepairJob(s, worker, 0.05);

  assert.equal(turret.hp, turret.maxHp, "the turret was fully patched");
  assert.equal(worker.order, null, "an auto-assigned worker frees up once the job is done");
});

test("a manually-assigned repair worker parks by a now-full building instead of going idle", () => {
  const { s, cc, worker } = base();
  const turret = makeBuilding("turret", "player", cc.x + 20, cc.y, { hp: 50 });
  s.buildings.set(turret.id, turret);
  worker.x = turret.x; worker.y = turret.y;
  issueRepair([worker], turret.id);
  assert.equal(worker.order.manual, true);

  for (let i = 0; i < 4000 && turret.hp < turret.maxHp; i++) updateRepairJob(s, worker, 0.05);

  assert.equal(turret.hp, turret.maxHp, "fully healed");
  assert.ok(worker.order, "a manually-assigned worker stays put, ready for the next ding");
  assert.equal(worker.order.targetId, turret.id);
});

test("MAX_REPAIRERS caps auto-assignment at 2 workers per building — a 3rd idle worker with nothing else to fix stays idle", () => {
  const { s, cc } = base();
  const turret = makeBuilding("turret", "player", cc.x + 50, cc.y, { hp: 50 });
  s.buildings.set(turret.id, turret);
  const workers = [...s.units.values()].filter(u => u.owner === "player" && u.type === "worker");
  assert.ok(workers.length >= 3, "the seeded base starts with 3 workers");
  workers.forEach(w => { w.x = cc.x; w.y = cc.y; });

  assignRepair(s, workers[0]);
  assignRepair(s, workers[1]);
  assignRepair(s, workers[2]);

  assert.equal(workers[0].order.targetId, turret.id);
  assert.equal(workers[1].order.targetId, turret.id);
  assert.equal(workers[2].order, null, "the cap holds — no third worker piles onto the same building");
  assert.equal(turret.repairers, 2);
});

test("MAX_REPAIRERS caps auto-assignment at 2 workers per wounded UNIT too — a 3rd idle worker with nothing else to fix stays idle", () => {
  const { s, cc } = base();
  const hurtRanger = makeUnit("ranger", "player", cc.x + 50, cc.y);
  hurtRanger.hp = 5;
  s.units.set(hurtRanger.id, hurtRanger);
  const workers = [...s.units.values()].filter(u => u.owner === "player" && u.type === "worker");
  assert.ok(workers.length >= 3, "the seeded base starts with 3 workers");
  workers.forEach(w => { w.x = cc.x; w.y = cc.y; });

  assignRepair(s, workers[0]);
  assignRepair(s, workers[1]);
  assignRepair(s, workers[2]);

  assert.equal(workers[0].order.targetId, hurtRanger.id);
  assert.equal(workers[1].order.targetId, hurtRanger.id);
  assert.equal(workers[2].order, null, "the cap holds — no third worker piles onto the same wounded unit");
  assert.equal(hurtRanger.repairers, 2);
});

test("assignRepair prefers a damaged building in the worker's own Command Center zone over a nearer one in another base's zone", () => {
  const s = createGameState({ planetId: "ferros" });
  const ccA = [...s.buildings.values()].find(b => b.owner === "player" && b.type === "command");
  ccA.x = 0; ccA.y = 0;
  const ccB = makeBuilding("command", "player", 1000, 0);
  s.buildings.set(ccB.id, ccB);
  const worker = [...s.units.values()].find(u => u.owner === "player" && u.type === "worker");
  worker.x = 300; worker.y = 0;   // home zone = CC-A (dist 300 vs 700)

  const farA = makeBuilding("turret", "player", -500, 0, { hp: 50 });   // zone A, 800 from the worker
  s.buildings.set(farA.id, farA);
  const nearB = makeBuilding("turret", "player", 650, 0, { hp: 50 });   // zone B, only 350 from the worker — the trap
  s.buildings.set(nearB.id, nearB);

  assignRepair(s, worker);

  assert.equal(worker.order.targetId, farA.id, "it patches the own-zone turret, not the nearer cross-zone one");
});
