import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeBuilding, makeUnit } from "../engine/state.js";
import { updateGather, nearestCommandCenter } from "../engine/gather.js";
import { UNITS, storeTotal } from "../engine/entities.js";
import { serializeGame, deserializeGame } from "../engine/persist.js";

function firstNode(state, com) {
  return state.map.nodes.find(n => n.com === com);
}

// Cargo gained in one small mining tick with `miners` workers on the node —
// small dt so neither the node amount nor the cargo cap is the binding limit,
// leaving the take equal to gatherRate * efficiency * dt.
function takeWithMiners(miners) {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const worker = [...state.units.values()].find(u => u.owner === "player" && u.type === "worker");
  const node = firstNode(state, "ore");
  worker.x = node.x; worker.y = node.y;
  worker.cargo = { com: "ore", qty: 0 };
  worker.order = { type: "gather", nodeId: node.id, phase: "mining" };
  if (miners !== undefined) node.miners = miners;
  updateGather(state, worker, 0.1);
  return worker.cargo.qty;
}

test("a worker walks to its node, fills cargo, then walks back and deposits", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const worker = [...state.units.values()].find(u => u.owner === "player" && u.type === "worker");
  const node = firstNode(state, "ore");
  const startOre = state.players.player.resources.ore;

  worker.order = { type: "gather", nodeId: node.id };

  // Run enough fixed ticks for a full walk-mine-walk-deposit cycle without
  // hardcoding tick counts to exact travel time (map geometry can shift).
  for (let i = 0; i < 2000 && state.players.player.resources.ore === startOre; i++) {
    updateGather(state, worker, 0.05);
  }

  assert.ok(state.players.player.resources.ore > startOre, "resources should increase after a deposit");
  assert.ok(node.amount < node.max, "the node should have less left after being mined");
});

test("mining respects the worker's cargo cap", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const worker = [...state.units.values()].find(u => u.owner === "player" && u.type === "worker");
  const node = firstNode(state, "ore");
  worker.x = node.x; worker.y = node.y;   // skip travel — isolate the mining phase
  worker.order = { type: "gather", nodeId: node.id, phase: "mining" };

  for (let i = 0; i < 50; i++) updateGather(state, worker, 0.5);

  assert.ok(worker.cargo.qty <= 10, "cargo never exceeds the worker's cap");
});

test("a fully depleted node leaves the worker idle when no other same-commodity node is within range", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const worker = [...state.units.values()].find(u => u.owner === "player" && u.type === "worker");
  const node = firstNode(state, "ore");
  // Starve every OTHER ore node too — ferros seeds several within the retarget radius of any one
  // home seam (see the "rolls onto a sibling seam" tests below), so leaving them untouched here
  // would make the worker retarget instead of idling. Zeroing them isolates the true idle
  // fallback: nextNodeAfterDepletion (engine/gather.js) genuinely has nowhere left to send it.
  for (const n of state.map.nodes) if (n.com === "ore" && n !== node) n.amount = 0;
  node.amount = 4;   // less than one worker's cargo cap
  worker.x = node.x; worker.y = node.y;
  worker.order = { type: "gather", nodeId: node.id, phase: "mining" };

  for (let i = 0; i < 2000 && worker.order; i++) updateGather(state, worker, 0.05);

  assert.equal(worker.order, null);
  assert.ok(node.amount <= 0);
});

/* ---------------------------------------------------------------------------------------------
   Gatherers roll to the next seam when a node runs dry (docs/improvement-proposals.md): a player
   worker used to idle the instant its node hit 0, same as the tests just above pin for the
   genuinely-nowhere-to-go case. These cover the new nextNodeAfterDepletion retarget: nearest
   same-commodity node the OWNER has discovered (fog-gated), within a ~600px radius, preferring one
   under the miner soft cap, distance-then-id tiebreak, idle only when nothing qualifies.
   --------------------------------------------------------------------------------------------- */

test("on the real ferros map, depleting one home ore seam rolls the worker onto a sibling seam instead of idling", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const worker = [...state.units.values()].find(u => u.owner === "player" && u.type === "worker");
  const node = firstNode(state, "ore");
  node.amount = 4;
  worker.x = node.x; worker.y = node.y;
  worker.order = { type: "gather", nodeId: node.id, phase: "mining" };

  for (let i = 0; i < 50 && worker.order && worker.order.nodeId === node.id; i++) updateGather(state, worker, 0.05);

  assert.ok(worker.order, "ferros seeds several ore seams around the home cluster, well within the retarget radius — the worker should never go idle here");
  assert.notEqual(worker.order.nodeId, node.id, "it must have actually retargeted, not just still be pointed at the dry node");
  assert.equal(worker.order.type, "gather");
  assert.equal(state.map.nodesById.get(worker.order.nodeId).com, "ore", "the new target must be the same commodity");
});

test("retargeting picks the nearest same-commodity node the player has discovered, within the retarget radius", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const worker = [...state.units.values()].find(u => u.owner === "player" && u.type === "worker");
  const node = firstNode(state, "ore");
  // Starve every OTHER real ore node so the one synthetic seam below is the only candidate —
  // isolates the pick from ferros' own dense home-ore cluster (covered by the real-map test above).
  for (const n of state.map.nodes) if (n.com === "ore" && n !== node) n.amount = 0;
  const seam = { id: "test-seam", com: "ore", x: node.x + 200, y: node.y, amount: 300, max: 300 };
  state.map.nodes.push(seam);
  if (state.map.nodesById) state.map.nodesById.set(seam.id, seam);

  node.amount = 4;   // less than one worker's cargo cap — depletes on the very next mining tick
  worker.x = node.x; worker.y = node.y;
  worker.order = { type: "gather", nodeId: node.id, phase: "mining" };

  for (let i = 0; i < 50 && worker.order && worker.order.nodeId === node.id; i++) updateGather(state, worker, 0.05);

  assert.equal(worker.order?.nodeId, seam.id, "must retarget to the discovered seam, not stay stuck on the dry node");
  assert.equal(worker.order.phase, "toNode", "a fresh retarget starts the walk-to-node phase over");
});

test("retargeting only considers the same commodity as the depleted node", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const worker = [...state.units.values()].find(u => u.owner === "player" && u.type === "worker");
  const node = firstNode(state, "ore");
  for (const n of state.map.nodes) if (n.com === "ore" && n !== node) n.amount = 0;
  const wrongCom = { id: "wrong-commodity", com: "crystals", x: node.x + 30, y: node.y, amount: 300, max: 300 };
  state.map.nodes.push(wrongCom);
  if (state.map.nodesById) state.map.nodesById.set(wrongCom.id, wrongCom);

  node.amount = 4;
  worker.x = node.x; worker.y = node.y;
  worker.order = { type: "gather", nodeId: node.id, phase: "mining" };

  for (let i = 0; i < 50 && worker.order && worker.order.nodeId === node.id; i++) updateGather(state, worker, 0.05);

  assert.equal(worker.order, null, "a nearby crystals node must never satisfy a depleted ore worker's retarget");
});

test("retargeting prefers a node under the miner soft cap over a nearer one that's already saturated", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const worker = [...state.units.values()].find(u => u.owner === "player" && u.type === "worker");
  const node = firstNode(state, "ore");
  for (const n of state.map.nodes) if (n.com === "ore" && n !== node) n.amount = 0;
  const cap = UNITS.worker.minerSoftCap;
  const near = { id: "near-saturated", com: "ore", x: node.x + 50, y: node.y, amount: 300, max: 300, miners: cap + 1 };
  const far = { id: "far-open", com: "ore", x: node.x + 400, y: node.y, amount: 300, max: 300, miners: 0 };
  for (const n of [near, far]) { state.map.nodes.push(n); if (state.map.nodesById) state.map.nodesById.set(n.id, n); }

  node.amount = 4;
  worker.x = node.x; worker.y = node.y;
  worker.order = { type: "gather", nodeId: node.id, phase: "mining" };

  for (let i = 0; i < 50 && worker.order && worker.order.nodeId === node.id; i++) updateGather(state, worker, 0.05);

  assert.equal(worker.order?.nodeId, far.id, "an under-cap node beats a nearer already-saturated one, even though it's farther away");
});

test("retargeting stays within the ~600px radius — a same-commodity node beyond it is not a candidate", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const worker = [...state.units.values()].find(u => u.owner === "player" && u.type === "worker");
  const node = firstNode(state, "ore");
  for (const n of state.map.nodes) if (n.com === "ore" && n !== node) n.amount = 0;
  const tooFar = { id: "too-far", com: "ore", x: node.x + 900, y: node.y, amount: 300, max: 300 };
  state.map.nodes.push(tooFar);
  if (state.map.nodesById) state.map.nodesById.set(tooFar.id, tooFar);

  node.amount = 4;
  worker.x = node.x; worker.y = node.y;
  worker.order = { type: "gather", nodeId: node.id, phase: "mining" };

  for (let i = 0; i < 50 && worker.order && worker.order.nodeId === node.id; i++) updateGather(state, worker, 0.05);

  assert.equal(worker.order, null, "the only same-commodity node left is out of range — the worker idles rather than trekking cross-map");
});

test("retargeting never sends a worker into an undiscovered hidden cache", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const worker = [...state.units.values()].find(u => u.owner === "player" && u.type === "worker");
  const node = firstNode(state, "ore");
  for (const n of state.map.nodes) if (n.com === "ore" && n !== node) n.amount = 0;
  const cache = { id: "hidden-cache", com: "ore", x: node.x + 100, y: node.y, amount: 300, max: 300, hidden: true };
  state.map.nodes.push(cache);
  if (state.map.nodesById) state.map.nodesById.set(cache.id, cache);

  node.amount = 4;
  worker.x = node.x; worker.y = node.y;
  worker.order = { type: "gather", nodeId: node.id, phase: "mining" };

  for (let i = 0; i < 50 && worker.order && worker.order.nodeId === node.id; i++) updateGather(state, worker, 0.05);

  assert.equal(worker.order, null, "an undiscovered hidden cache must not be a retarget candidate, fog or no fog");
});

test("retargeting breaks an exact distance tie by node id, deterministically", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const worker = [...state.units.values()].find(u => u.owner === "player" && u.type === "worker");
  const node = firstNode(state, "ore");
  for (const n of state.map.nodes) if (n.com === "ore" && n !== node) n.amount = 0;
  // Two candidates at the exact same distance from the depleted node (mirrored east/west) — only
  // their ids differ, so the tiebreak alone decides the outcome.
  const east = { id: "zz-later", com: "ore", x: node.x + 150, y: node.y, amount: 300, max: 300 };
  const west = { id: "aa-earlier", com: "ore", x: node.x - 150, y: node.y, amount: 300, max: 300 };
  for (const n of [east, west]) { state.map.nodes.push(n); if (state.map.nodesById) state.map.nodesById.set(n.id, n); }

  node.amount = 4;
  worker.x = node.x; worker.y = node.y;
  worker.order = { type: "gather", nodeId: node.id, phase: "mining" };

  for (let i = 0; i < 50 && worker.order && worker.order.nodeId === node.id; i++) updateGather(state, worker, 0.05);

  assert.equal(worker.order?.nodeId, "aa-earlier", "an exact distance tie must resolve to the lower id, not insertion/iteration order");
});

test("an AI-owned gatherer also rolls onto the next seam, gated by the AI's own fog", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const worker = [...state.units.values()].find(u => u.owner === "ai" && u.type === "worker");
  assert.ok(worker, "sanity: the AI starts with a worker too");
  const oreNodes = state.map.nodes.filter(n => n.com === "ore");
  // The ore node nearest the AI's own starting worker — its home seam, sitting inside the AI's own
  // explored fog (state.fogAI), unlike the player's home cluster on the far side of the map.
  const node = oreNodes.reduce((best, n) =>
    Math.hypot(n.x - worker.x, n.y - worker.y) < Math.hypot(best.x - worker.x, best.y - worker.y) ? n : best);
  for (const n of oreNodes) if (n !== node) n.amount = 0;
  const seam = { id: "ai-test-seam", com: "ore", x: node.x + 200, y: node.y, amount: 300, max: 300 };
  state.map.nodes.push(seam);
  if (state.map.nodesById) state.map.nodesById.set(seam.id, seam);

  node.amount = 4;
  worker.x = node.x; worker.y = node.y;
  worker.order = { type: "gather", nodeId: node.id, phase: "mining" };

  for (let i = 0; i < 50 && worker.order && worker.order.nodeId === node.id; i++) updateGather(state, worker, 0.05);

  assert.equal(worker.order?.nodeId, seam.id, "the AI's own worker retargets too, gated by state.fogAI rather than the player's state.fog");
});

test("mining saturates: workers past the soft cap pull a diminishing share, never zero", () => {
  const rate = UNITS.worker.gatherRate, cap = UNITS.worker.minerSoftCap, fall = UNITS.worker.minerFalloff;
  const full = rate * 0.1;
  // At or below the soft cap: full rate.
  assert.ok(Math.abs(takeWithMiners(1) - full) < 1e-9, "one miner mines at full rate");
  assert.ok(Math.abs(takeWithMiners(cap) - full) < 1e-9, "at the soft cap, still full rate");
  // Past it: the per-worker share is the node average (cap + extra*fall)/m.
  const eff6 = (cap + (6 - cap) * fall) / 6;
  assert.ok(Math.abs(takeWithMiners(6) - full * eff6) < 1e-9, "six miners each pull the averaged share");
  // Monotonically diminishing, but always above the floor.
  assert.ok(takeWithMiners(4) > takeWithMiners(6) && takeWithMiners(6) > takeWithMiners(10), "more miners -> less each");
  assert.ok(takeWithMiners(20) > full * fall * 0.99, "efficiency never drops below the falloff floor");
});

test("no miner count set (a direct-call test or legacy state) means no penalty — full rate", () => {
  const rate = UNITS.worker.gatherRate;
  assert.ok(Math.abs(takeWithMiners(undefined) - rate * 0.1) < 1e-9, "unset node.miners reads as full rate");
});

test("a worker re-tasked to a different commodity keeps its load and hauls it home first", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const worker = [...state.units.values()].find(u => u.owner === "player" && u.type === "worker");
  const oreNode = firstNode(state, "ore");
  worker.cargo = { com: "crystals", qty: 7 };   // already carrying a partial crystal load
  worker.x = oreNode.x; worker.y = oreNode.y;
  worker.order = { type: "gather", nodeId: oreNode.id, phase: "mining" };
  const startCrystals = state.players.player.resources.crystals;

  // One mining-phase tick should NOT zero the cargo — it should route to drop.
  updateGather(state, worker, 0.05);
  assert.equal(worker.cargo.qty, 7, "the already-mined crystals are not thrown away");
  assert.equal(worker.order.phase, "toDrop", "instead the worker heads home to deposit them first");

  // Let it finish: it deposits the crystals, then returns to mine the ore node.
  for (let i = 0; i < 4000 && state.players.player.resources.crystals === startCrystals; i++) {
    updateGather(state, worker, 0.05);
  }
  assert.ok(state.players.player.resources.crystals >= startCrystals + 7, "the carried crystals reach the bank");
});

test("a constructing expansion Command Center only becomes a dropoff once it completes", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const worker = [...state.units.values()].find(u => u.owner === "player" && u.type === "worker");
  const node = firstNode(state, "ore");
  const site = makeBuilding("command", "player", node.x + 60, node.y, { constructing: true });
  state.buildings.set(site.id, site);

  // A full worker right beside the site, ready to deposit.
  worker.x = site.x + 10; worker.y = site.y;
  worker.cargo = { com: "ore", qty: 10 };
  worker.order = { type: "gather", nodeId: node.id, phase: "toDrop" };
  const before = state.players.player.resources.ore;

  updateGather(state, worker, 0.05);
  assert.equal(state.players.player.resources.ore, before, "a construction site accepts no deposits — the worker heads for the distant seeded CC");

  site.constructing = false;
  site.buildProgress = 1;
  updateGather(state, worker, 0.05);
  assert.ok(state.players.player.resources.ore > before, "the finished expansion is the nearest dropoff");
});

test("a Refinery planted right on a node is NOT a drop-off — the gatherer walks past it to the Command Center", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const worker = [...state.units.values()].find(u => u.owner === "player" && u.type === "worker");
  const node = firstNode(state, "ore");
  // A completed Refinery planted right on the node, far from the seeded base CC.
  const refinery = makeBuilding("refinery", "player", node.x + 12, node.y, { constructing: false });
  state.buildings.set(refinery.id, refinery);
  const cc = [...state.buildings.values()].find(b => b.type === "command");
  worker.x = node.x; worker.y = node.y;
  worker.cargo = { com: "ore", qty: 10 };
  worker.order = { type: "gather", nodeId: node.id, phase: "toDrop" };
  const before = state.players.player.resources.ore;
  assert.ok(Math.hypot(cc.x - worker.x, cc.y - worker.y) > 30, "the base CC is out of drop reach — the Refinery sits right next to the worker");

  updateGather(state, worker, 0.05);
  assert.equal(storeTotal(refinery), 0, "the Refinery has no intake buffer — it never banks a raw haul");
  assert.equal(state.players.player.resources.ore, before, "nothing reaches the treasury yet — the worker is still walking to the CC");
  assert.equal(worker.cargo.qty, 10, "cargo stays aboard, unaffected by standing next to the Refinery");

  // Walk it all the way home and confirm it banks at the CC, never at the Refinery.
  for (let i = 0; i < 4000 && state.players.player.resources.ore === before; i++) updateGather(state, worker, 0.05);
  assert.ok(state.players.player.resources.ore > before, "it reached the Command Center and banked there");
  assert.equal(storeTotal(refinery), 0, "the Refinery still received nothing");
});

test("a landed collection-point Hauler closer than the Command Center receives the deposit into its freight hold, not the treasury", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const worker = [...state.units.values()].find(u => u.owner === "player" && u.type === "worker");
  const node = firstNode(state, "ore");
  const cc = [...state.buildings.values()].find(b => b.type === "command" && b.owner === "player");
  const hauler = makeUnit("hauler", "player", node.x + 10, node.y);
  hauler.collectPoint = true;
  state.units.set(hauler.id, hauler);

  worker.x = hauler.x; worker.y = hauler.y;
  worker.cargo = { com: "ore", qty: 10 };
  worker.order = { type: "gather", nodeId: node.id, phase: "toDrop" };
  const before = state.players.player.resources.ore;
  assert.ok(Math.hypot(cc.x - worker.x, cc.y - worker.y) > 30, "the base CC is out of drop reach — the Hauler sits right next to the worker instead");

  updateGather(state, worker, 0.05);

  assert.equal(state.players.player.resources.ore, before, "nothing reaches the treasury directly — it went to the Hauler's hold instead");
  assert.equal(worker.cargo.qty, 0, "the worker's whole load fit in the Hauler's hold and is gone");
  assert.equal(hauler.freight.ore, 10, "the Hauler's freight hold now carries the deposited ore");
});

test("a Hauler NOT toggled as a collection point is invisible to nearestGatherDrop — the worker walks past it to the Command Center", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const worker = [...state.units.values()].find(u => u.owner === "player" && u.type === "worker");
  const node = firstNode(state, "ore");
  const hauler = makeUnit("hauler", "player", node.x + 10, node.y);   // collectPoint left off
  state.units.set(hauler.id, hauler);

  worker.x = hauler.x; worker.y = hauler.y;
  worker.cargo = { com: "ore", qty: 10 };
  worker.order = { type: "gather", nodeId: node.id, phase: "toDrop" };
  const before = state.players.player.resources.ore;

  updateGather(state, worker, 0.05);

  assert.equal(state.players.player.resources.ore, before, "still walking to the distant CC — an un-toggled Hauler is never a candidate");
  assert.equal(worker.cargo.qty, 10, "cargo stays aboard");
  assert.equal(hauler.freight.ore || 0, 0, "the Hauler received nothing");
});

test("a full collection-point Hauler is skipped — nothing to deposit until it (or another drop) has room", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const worker = [...state.units.values()].find(u => u.owner === "player" && u.type === "worker");
  const node = firstNode(state, "ore");
  const hauler = makeUnit("hauler", "player", node.x + 10, node.y);
  hauler.collectPoint = true;
  hauler.freight.ore = UNITS.hauler.cargoHold;   // already full
  state.units.set(hauler.id, hauler);

  worker.x = hauler.x; worker.y = hauler.y;
  worker.cargo = { com: "ore", qty: 10 };
  worker.order = { type: "gather", nodeId: node.id, phase: "toDrop" };
  const before = state.players.player.resources.ore;

  updateGather(state, worker, 0.05);

  assert.equal(hauler.freight.ore, UNITS.hauler.cargoHold, "the full Hauler's hold is untouched");
  assert.equal(state.players.player.resources.ore, before, "still walking — the far-off CC is the only remaining candidate");
  assert.equal(worker.cargo.qty, 10, "cargo stays aboard, waiting for a real drop");
});

test("a partial Hauler deposit leaves the remainder aboard the worker, which tops off at the node rather than abandoning the load", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const worker = [...state.units.values()].find(u => u.owner === "player" && u.type === "worker");
  const node = firstNode(state, "ore");
  const hauler = makeUnit("hauler", "player", node.x + 10, node.y);
  hauler.collectPoint = true;
  hauler.freight.ore = UNITS.hauler.cargoHold - 4;   // only 4 units of room left
  state.units.set(hauler.id, hauler);

  worker.x = hauler.x; worker.y = hauler.y;
  worker.cargo = { com: "ore", qty: 10 };
  worker.order = { type: "gather", nodeId: node.id, phase: "toDrop" };

  updateGather(state, worker, 0.05);

  assert.equal(hauler.freight.ore, UNITS.hauler.cargoHold, "the Hauler took exactly what fit");
  assert.equal(worker.cargo.qty, 6, "the leftover 6 stayed aboard instead of being lost or force-fit past capacity");
  assert.equal(worker.order.phase, "toNode", "same commodity the node it's already tasked to — it tops back off there rather than being stranded");
});

test("Logistics Network (+25% yield) applies the same bonus depositing into a Hauler as it does at the Command Center", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  state.players.player.upgrades.logisticsNetwork = true;
  const worker = [...state.units.values()].find(u => u.owner === "player" && u.type === "worker");
  const node = firstNode(state, "ore");
  const hauler = makeUnit("hauler", "player", node.x + 10, node.y);
  hauler.collectPoint = true;
  state.units.set(hauler.id, hauler);

  worker.x = hauler.x; worker.y = hauler.y;
  worker.cargo = { com: "ore", qty: 10 };
  worker.order = { type: "gather", nodeId: node.id, phase: "toDrop" };

  updateGather(state, worker, 0.05);

  assert.ok(Math.abs(hauler.freight.ore - 12.5) < 1e-6, `+25% yield credited to the Hauler's hold too: got ${hauler.freight.ore}`);
});

test("Logistics Network (+25% yield) banks more per haul", () => {
  const bank = withUpgrade => {
    const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
    if (withUpgrade) state.players.player.upgrades.logisticsNetwork = true;
    const worker = [...state.units.values()].find(u => u.owner === "player" && u.type === "worker");
    const cc = [...state.buildings.values()].find(b => b.type === "command" && b.owner === "player");
    worker.x = cc.x; worker.y = cc.y;                     // on the drop-off, so one tick deposits
    worker.cargo = { com: "ore", qty: 10 };
    worker.order = { type: "gather", nodeId: firstNode(state, "ore").id, phase: "toDrop" };
    const before = state.players.player.resources.ore;
    updateGather(state, worker, 0.05);
    return state.players.player.resources.ore - before;
  };
  const base = bank(false), boosted = bank(true);
  assert.ok(Math.abs(boosted - base * 1.25) < 1e-6, `+25% yield: ${boosted} vs ${base}`);
});

test("nearestCommandCenter breaks an exact distance tie by id, not by Map insertion order (T2)", () => {
  // These two scans were the only "nearest" lookups in the domain with a bare `d < bestD` and no
  // explicit tie-break, while six siblings (haul.js x3, wreckage.js, colonyPolicy.js, wonder.js)
  // all pin theirs with `d === bestD && b.id < best.id`. gather.js's own comment leaned on it:
  // "deterministic Map order breaks ties within each kind". That's correct TODAY but it is a
  // different KIND of guarantee — one resting on a data-structure incident rather than a stated
  // rule — and zoneFirst resolves zone membership by IDENTITY against this result, so two
  // equidistant Command Centers make every zone boundary depend on insertion order.
  const build = reversed => {
    const st = createGameState({ planetId: "ferros", seed: 71 });
    st.buildings.clear();
    const a = makeBuilding("command", "player", 400, 500);
    const b = makeBuilding("command", "player", 600, 500);
    for (const x of reversed ? [b, a] : [a, b]) { x.constructing = false; st.buildings.set(x.id, x); }
    return nearestCommandCenter(st, "player", 500, 500).id;   // exactly equidistant
  };
  assert.equal(build(false), build(true),
    "the same pick regardless of the order the Map happened to be built in");
});

test("a yield bonus never pushes a collection-point hold past its cargoHold (T2)", () => {
  // The clamp was applied to the RAW quantity moved and the bonus to the CREDITED quantity, so with
  // a yield multiplier (Logistics Network's 1.25, or an asym world's gatherMult) a PARTIAL deposit
  // landed more than fits. haul.js's own depositToFreighter has no such asymmetry — it moves and
  // credits the same number. It breaks two stated invariants at once: the hold's capacity, and "a
  // save round-trips identically", because persist.js truncates the excess on load. That second
  // half is invisible to every replay test: both runs agree until someone saves.
  const st = createGameState({ planetId: "ferros", seed: 91 });
  const cc = [...st.buildings.values()].find(b => b.owner === "player" && b.type === "command");
  const hauler = makeUnit("hauler", "player", cc.x + 30, cc.y);
  hauler.collectPoint = true;
  hauler.freight = { ore: UNITS.hauler.cargoHold - 4 };
  st.units.set(hauler.id, hauler);

  const worker = [...st.units.values()].find(u => u.owner === "player" && u.cargo);
  worker.x = hauler.x; worker.y = hauler.y;
  worker.cargo = { com: "ore", qty: 10 };
  worker.order = { type: "gather", nodeId: st.map.nodes[0].id, phase: "toDrop" };
  st.players.player.upgrades = { ...(st.players.player.upgrades || {}), logisticsNetwork: true };

  updateGather(st, worker, 0.1);
  const used = Object.values(hauler.freight).reduce((a, v) => a + v, 0);
  assert.ok(used <= UNITS.hauler.cargoHold + 1e-9,
    `a collection-point hold must never exceed cargoHold — got ${used} of ${UNITS.hauler.cargoHold}`);
});

test("a collection-point hold survives a save/load with no quantity lost (T2)", () => {
  const st = createGameState({ planetId: "ferros", seed: 92 });
  const hauler = makeUnit("hauler", "player", 700, 500);
  hauler.collectPoint = true;
  hauler.freight = { ore: UNITS.hauler.cargoHold };
  st.units.set(hauler.id, hauler);
  const before = Object.values(hauler.freight).reduce((a, v) => a + v, 0);
  const loaded = deserializeGame(serializeGame(st)).units.get(hauler.id);
  const after = Object.values(loaded.freight).reduce((a, v) => a + v, 0);
  assert.equal(after, before, "load-time truncation must never silently delete matter");
});


/* ---------- depletion is announced, not silent (agent-observability) ----------
   A drained seam used to leave a worker standing still with no event and nothing in its projected
   shape to poll — the quietest way for a match to rot. */

test("a node running dry emits nodeDepleted exactly once, no matter how many miners land the last tick", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const node = firstNode(state, "ore");
  const workers = [...state.units.values()].filter(u => u.owner === "player" && u.type === "worker").slice(0, 2);
  assert.ok(workers.length >= 1);
  node.amount = 1;
  for (const w of workers) {
    w.x = node.x; w.y = node.y;
    w.cargo = { com: "ore", qty: 0 };
    w.order = { type: "gather", nodeId: node.id, phase: "mining" };
  }
  state.events.length = 0;
  for (const w of workers) updateGather(state, w, 1);
  const depleted = state.events.filter(e => e.type === "nodeDepleted");
  assert.equal(depleted.length, 1, "announced once per node, not once per miner");
  assert.equal(depleted[0].id, node.id);
  assert.equal(depleted[0].com, "ore");

  // And never again on a later tick against the same dry node.
  state.events.length = 0;
  for (const w of workers) updateGather(state, w, 1);
  assert.equal(state.events.filter(e => e.type === "nodeDepleted").length, 0);
});

test("a gatherer left with nowhere to go emits unitIdle naming itself", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const worker = [...state.units.values()].find(u => u.owner === "player" && u.type === "worker");
  const node = firstNode(state, "ore");
  // Nothing anywhere left to retarget to, so the retarget search must come up empty.
  for (const n of state.map.nodes) n.amount = 0;
  worker.x = node.x; worker.y = node.y;
  worker.order = { type: "gather", nodeId: node.id, phase: "mining" };
  state.events.length = 0;

  updateGather(state, worker, 1);
  assert.equal(worker.order, null);
  const idle = state.events.find(e => e.type === "unitIdle");
  assert.ok(idle, "a worker that just stopped working must say so");
  assert.equal(idle.id, worker.id);
  assert.equal(idle.owner, "player");
  assert.equal(idle.reason, "node-depleted");
});
