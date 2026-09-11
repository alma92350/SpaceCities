// @ts-check
/* ============================================================
   Gather congestion: a crowd of workers must keep the economy running.

   Two convergence points in engine/gather.js used to jam, and both presented
   identically — every worker "moving", income at zero, nothing idle and no
   event to poll:

     - the DROP-OFF: every hauler in the `toDrop` phase walked at the Command
       Center's exact centre, so the pile's own separation pushes (which are
       applied per overlapping PAIR, and so add up without bound) shoved the
       outer members back past DROP_REACH faster than their own capped walk
       speed could carry them in. Cargo-full workers that never banked and,
       because they never left `toDrop`, never returned to the seam either.

     - the NODE: docking angles were hashed per unit id, so two workers could
       be handed spots a couple of pixels apart on the ring, and the arrival
       gate was measured against that personal spot at a tolerance smaller
       than one tick of separation displacement. A contested spot could never
       be "reached", so the worker walked, got shoved, and walked again
       forever without ever starting to mine.

   These run the FULL tick (sim.js), not updateGather in isolation: the jam is
   an interaction between gather.js's targets and separation.js's pushes, and
   neither one alone reproduces it.
   ============================================================ */

"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeUnit } from "../engine/state.js";
import { tick } from "../engine/sim.js";
import { nearestCommandCenter, orbitSpot, dockSpot, DOCK_SPACING } from "../engine/gather.js";

const DT = 1 / 30;
const SECONDS = 120;

// Clear the opposing side's units so runAI has nothing to march around with —
// its Command Center STAYS, because razing a side outright ends the match and
// engine/sim.js's tick() then returns immediately, advancing nothing at all.
function quietTheOtherSide(state) {
  for (const u of [...state.units.values()]) if (u.owner === "ai") state.units.delete(u.id);
}

// A crowd of `n` workers, run for SECONDS of sim time. `seams` is how many of the
// nearest ore seams they are spread round-robin across — 1 puts the whole crew on one
// rock, 3 is the ordinary shape of a real opening. Both matter: the drop-off pile is
// worst with one shared destination, while the node ring's own wedge showed up at 3.
// The node is topped back up every tick so the run measures congestion alone —
// a seam running dry is a different test (the retarget funnel, below).
// Returns each worker's completed haul count, keyed by unit id.
function runCrowd(n, seams) {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  quietTheOtherSide(state);

  const cc = nearestCommandCenter(state, "player", 0, 0);
  assert.ok(cc, "the player starts with a Command Center");
  // Retargeting is fog-gated; this test is about congestion, not scouting.
  const fog = state.fogs.player;
  for (const nd of state.map.nodes) if (fog && fog.seenNodes) fog.seenNodes.add(nd.id);
  const ore = state.map.nodes
    .filter(nd => nd.com === "ore" && nd.amount > 0)
    .sort((a, b) => Math.hypot(a.x - cc.x, a.y - cc.y) - Math.hypot(b.x - cc.x, b.y - cc.y))
    .slice(0, seams);
  assert.equal(ore.length, seams, "ferros has this many ore seams near the base");
  const full = new Map(ore.map(nd => [nd.id, nd.amount]));

  // Replace the starting workers with exactly `n` of our own, spawned on the
  // Command Center — the same place a freshly trained worker appears.
  for (const u of [...state.units.values()]) if (u.type === "worker") state.units.delete(u.id);
  const workers = [];
  for (let i = 0; i < n; i++) {
    const w = makeUnit("worker", "player", cc.x, cc.y, state);
    w.order = { type: "gather", nodeId: ore[i % seams].id };
    state.units.set(w.id, w);
    workers.push(w);
  }

  const hauls = new Map(workers.map(w => [w.id, 0]));
  const carrying = new Map(workers.map(w => [w.id, 0]));
  for (let t = 0; t < SECONDS / DT; t++) {
    tick(state, DT);
    for (const nd of ore) nd.amount = full.get(nd.id);   // congestion only: never let a seam run dry
    for (const w of workers) {
      const was = carrying.get(w.id);
      const now = w.cargo ? w.cargo.qty : 0;
      // A deposit is the one place a loaded worker's cargo drops to zero.
      if (was > 0 && now === 0) hauls.set(w.id, hauls.get(w.id) + 1);
      carrying.set(w.id, now);
    }
  }
  return { hauls, state };
}

for (const [n, seams] of [[8, 1], [16, 1], [8, 3], [16, 3], [24, 3]]) {
  test(`${n} workers across ${seams} seam(s) all keep hauling — none jams at the node or the drop-off`, () => {
    const { hauls } = runCrowd(n, seams);
    const counts = [...hauls.values()];
    const stuck = [...hauls.entries()].filter(([, c]) => c === 0).map(([id]) => id);
    assert.deepEqual(stuck, [],
      `every worker must complete at least one haul in ${SECONDS}s; these never banked anything: ${stuck.join(", ")}`);
    // Nobody starves relative to the crew: a worker that is being shoved out of
    // the deposit zone (or off its docking spot) on most cycles shows up here as
    // a fraction of what its neighbours manage, even when it isn't fully wedged.
    const best = Math.max(...counts), worst = Math.min(...counts);
    assert.ok(worst >= best * 0.4,
      `the slowest worker (${worst} hauls) must not be starved against the fastest (${best}) — congestion must degrade evenly, not wedge one worker`);
  });
}

test("a drained seam spreads its crew instead of funnelling the whole crowd onto one survivor", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  quietTheOtherSide(state);
  const cc = nearestCommandCenter(state, "player", 0, 0);

  // Reveal the whole map to the player: retargeting is fog-gated, and this test
  // is about the choice among known seams, not about scouting.
  const fog = state.fogs.player;
  for (const nd of state.map.nodes) if (fog && fog.seenNodes) fog.seenNodes.add(nd.id);

  const ore = state.map.nodes.filter(nd => nd.com === "ore" && nd.amount > 0)
    .sort((a, b) => Math.hypot(a.x - cc.x, a.y - cc.y) - Math.hypot(b.x - cc.x, b.y - cc.y));
  assert.ok(ore.length >= 3, "ferros has several ore seams near the base");
  const doomed = ore[0];

  for (const u of [...state.units.values()]) if (u.type === "worker") state.units.delete(u.id);
  const workers = [];
  for (let i = 0; i < 9; i++) {
    const w = makeUnit("worker", "player", doomed.x, doomed.y, state);
    w.order = { type: "gather", nodeId: doomed.id, phase: "mining" };
    state.units.set(w.id, w);
    workers.push(w);
  }

  doomed.amount = 1;   // drains on the first mining tick, retargeting the whole crew at once
  for (let t = 0; t < 60 / DT; t++) tick(state, DT);

  const targets = new Map();
  for (const w of workers) {
    const id = w.order && w.order.type === "gather" ? w.order.nodeId : "(idle)";
    targets.set(id, (targets.get(id) || 0) + 1);
  }
  assert.ok(!targets.has("(idle)"),
    "a retargeting crew must find work, not stop");
  const heaviest = Math.max(...targets.values());
  assert.ok(heaviest <= 4,
    `a 9-worker crew whose seam ran dry must spread across the seams it knows, not pile ${heaviest} onto one (targets: ${[...targets].map(([k, v]) => `${k}:${v}`).join(", ")})`);
});

/* ---------- the root cause, guarded directly ---------- */

// The crowd tests above catch a wedge only where the map geometry happens to produce
// one. This is the property that makes a wedge possible at all, asserted straight:
// no two workers sharing a site may be handed spots closer together than the distance
// separation.js will immediately push them to. Sequential ids on purpose — that is what
// a production queue emits, and it is precisely the input the old hashed angles failed
// on (hashStr is `h * 31 + charCode`, so u9/u10/u11 hashed to 331°/341°/342°).
for (const [what, spots] of [
  ["a node's miners", ids => {
    const node = { id: "n3", x: 400, y: 400, minerIds: ids };
    return ids.map(id => orbitSpot(node, id));
  }],
  ["a drop-off's haulers", ids => {
    const drop = { id: "b1", x: 160, y: 500, dockerIds: ids };
    return ids.map(id => dockSpot(drop, id));
  }],
]) {
  for (const crew of [2, 3, 6, 12, 24]) {
    test(`${what}: ${crew} sequentially-named workers get spots separation cannot shove them off`, () => {
      const ids = Array.from({ length: crew }, (_, i) => `u${9 + i}`);
      const placed = spots(ids);
      // The drop's ring is capped by DROP_REACH (a spot outside it could never bank), so
      // past that ceiling the guarantee is the best the ring allows rather than the full
      // separation floor: evenly spread and distinct. The node's ring has no such gate
      // and must always make the floor. Either way the failure this guards — two spots
      // on top of each other, so neither worker can ever reach its own — cannot happen.
      const ring = Math.max(...placed.map(s => s.radius));
      const bestPossible = crew > 1 ? 2 * ring * Math.sin(Math.PI / crew) : Infinity;
      const floor = Math.min(DOCK_SPACING, bestPossible);
      assert.ok(floor > 1, `${crew} spots must stay meaningfully apart, not collapse onto one point`);
      for (let i = 0; i < placed.length; i++) {
        for (let j = i + 1; j < placed.length; j++) {
          const d = Math.hypot(placed[i].x - placed[j].x, placed[i].y - placed[j].y);
          assert.ok(d >= floor - 1e-9,
            `${ids[i]} and ${ids[j]} are ${d.toFixed(2)}px apart, inside the ${floor.toFixed(2)}px this ring can hold — they would shove each other off their spots forever`);
        }
      }
    });
  }
}

// A worker that isn't on the crew list yet (its first tick inbound, before sim.js has
// seen the order) must still get a usable spot rather than crashing or landing on the
// centre — crewSlot's fallback. Direct-call unit tests rely on this too.
test("a worker missing from the crew list still gets a spot off the centre", () => {
  const node = { id: "n3", x: 400, y: 400, minerIds: ["u1", "u2"] };
  const spot = orbitSpot(node, "u99");
  assert.ok(Math.hypot(spot.x - node.x, spot.y - node.y) > 1, "never the exact centre");
  const bare = orbitSpot({ id: "n4", x: 0, y: 0 }, "u1");
  assert.ok(Number.isFinite(bare.x) && Number.isFinite(bare.y), "no crew list at all is still a finite spot");
});

/* ---------- observability: a stalled gatherer must be visible ---------- */

// A worker with an order is never "idle", so nothing in idle_unit_ids, activity, or the
// resource counter distinguishes one hauling home from one wedged on the way. unitStalled
// is the only signal that does — without it an economy can rot for the rest of a match
// with every observable reporting "working".
test("a gatherer that stops making progress announces itself exactly once", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  quietTheOtherSide(state);
  const cc = nearestCommandCenter(state, "player", 0, 0);
  const node = state.map.nodes.find(nd => nd.com === "ore" && nd.amount > 0);
  const worker = [...state.units.values()].find(u => u.owner === "player" && u.type === "worker");
  worker.x = cc.x; worker.y = cc.y;
  worker.order = { type: "gather", nodeId: node.id, phase: "toNode" };

  // Pin the worker in place: it has an order and a target it never gets nearer to —
  // exactly what a jam looked like from the outside.
  const stalls = [];
  for (let t = 0; t < 40 / DT; t++) {
    const { x, y } = worker;
    tick(state, DT);
    worker.x = x; worker.y = y;
    // state.events accumulates until a consumer drains it (engine/loop.js does in a real
    // match); a raw-tick test has to drain it itself or it re-counts the same event forever.
    for (const e of state.events) if (e.type === "unitStalled") stalls.push(e);
    state.events.length = 0;
  }
  assert.equal(stalls.length, 1, "reported once per stalled leg, not once per tick");
  assert.equal(stalls[0].id, worker.id);
  assert.equal(stalls[0].phase, "toNode");
  assert.equal(stalls[0].reason, "cannot-reach-node");
  assert.equal(stalls[0].owner, "player");
});

test("a gatherer making normal progress is never reported stalled", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  quietTheOtherSide(state);
  const node = state.map.nodes.find(nd => nd.com === "ore" && nd.amount > 0);
  for (const u of state.units.values()) if (u.type === "worker" && u.owner === "player") u.order = { type: "gather", nodeId: node.id };
  let stalls = 0;
  for (let t = 0; t < 120 / DT; t++) {
    tick(state, DT);
    for (const e of state.events) if (e.type === "unitStalled") stalls++;
    state.events.length = 0;
  }
  assert.equal(stalls, 0, "a full walk-mine-haul cycle, repeated, must never trip the watchdog");
});
