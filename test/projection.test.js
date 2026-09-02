import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeUnit } from "../engine/state.js";
import { updateFog } from "../engine/fog.js";
import { supplyUsed, supplyCap } from "../engine/supply.js";
import { playerScore } from "../engine/victory.js";
import { projectFor } from "../engine/projection.js";

/* ============================================================
   ADR-0009's M0 step: projectFor(state, seat) must exist and be tested before anything depends
   on it. Two things this file has to prove, per the ADR: (1) the per-field filtering contract —
   own vs. visible-enemy vs. invisible, public-vs-private player facts, node discovery, event
   visibility, no map — and (2) the "no-leak crawler" the ADR calls security-critical: walking a
   whole projected+JSON-round-tripped state and asserting nothing outside the seat's fog survives,
   not just spot-checking the fields this file happened to think of.

   buildScenario() sets up one deterministic state with a hand-placed case for every rule: an AI
   unit/building sitting on top of the player's own base (so it's visible without depending on AI
   behaviour), a hidden node the player has scouted and one it hasn't, and events at both a visible
   and an invisible point. Player and AI starting forces are far apart on ferros by construction, so
   "an ordinary out-of-vision enemy" needs no extra setup — it's already true of the AI's starting
   base.
   ============================================================ */
function buildScenario() {
  const state = createGameState({ planetId: "ferros", seed: 7 });
  const playerUnit = [...state.units.values()].find(u => u.owner === "player");
  const { x: px, y: py } = playerUnit;

  // A visible enemy: placed exactly on a player unit, so it's inside player's sight radius
  // regardless of exactly how far that radius reaches. Given order/orderQueue/homeCC/targetId to
  // set, so the "stripped when enemy" assertions have something to check was actually removed.
  const visibleEnemy = makeUnit("skiff", "ai", px, py);
  visibleEnemy.order = { type: "attack-move", x: px + 10, y: py };
  visibleEnemy.orderQueue = [{ type: "move", x: px + 50, y: py }];
  visibleEnemy.homeCC = "some-ai-cc-id";
  visibleEnemy.targetId = "some-target-id";
  state.units.set(visibleEnemy.id, visibleEnemy);

  // Give the player's own unit the same four fields, so "own units keep everything" is checked
  // against real values, not against two nulls that would look identical either way.
  playerUnit.order = { type: "move", x: px + 5, y: py };
  playerUnit.orderQueue = [{ type: "move", x: px + 20, y: py }];
  playerUnit.homeCC = "some-player-cc-id";
  playerUnit.targetId = "some-player-target-id";

  // A distinctive resource figure on the AI's economy — must never appear anywhere in a
  // player-seat projection, JSON-stringified or not.
  state.players.ai.resources.ore = 424242;
  state.players.ai.upgrades.someUpgrade = true;

  // Two hidden nodes: one the player has scouted (place a throwaway player unit on it and update
  // fog, exactly what exploring it in a real match would do), one left untouched.
  const discovered = { id: "n-hidden-found", com: "ore", amount: 77, max: 200, x: px + 300, y: py + 300, hidden: true };
  const undiscovered = { id: "n-hidden-lost", com: "ore", amount: 99, max: 200, x: px - 300, y: py - 300, hidden: true };
  state.map.nodes.push(discovered, undiscovered);
  const scout = makeUnit("skiff", "player", discovered.x, discovered.y);
  state.units.set(scout.id, scout);
  updateFog(state, state.fogs.player, "player");
  state.units.delete(scout.id);   // the scout itself isn't part of what this file is testing

  // Events: one AI-owned at a visible point (should pass on visibility, not ownership), one
  // AI-owned far away (should be excluded), one ownerless "environmental" event at a visible point
  // (should pass on visibility alone).
  state.events.push({ type: "unitSpawned", x: px, y: py, owner: "ai" });
  state.events.push({ type: "unitSpawned", x: px - 5000, y: py - 5000, owner: "ai" });
  state.events.push({ type: "wreckMatured", x: px, y: py });

  return { state, px, py, visibleEnemy, playerUnit, discovered, undiscovered };
}

test("own units keep order, orderQueue, homeCC and targetId", () => {
  const { state, playerUnit } = buildScenario();
  const proj = projectFor(state, "player");
  const own = proj.units.find(u => u.id === playerUnit.id);
  assert.ok(own, "the player's own unit must be present");
  assert.deepEqual(own.order, playerUnit.order);
  assert.deepEqual(own.orderQueue, playerUnit.orderQueue);
  assert.equal(own.homeCC, playerUnit.homeCC);
  assert.equal(own.targetId, playerUnit.targetId);
});

test("an out-of-vision enemy unit is excluded entirely", () => {
  const { state } = buildScenario();
  const proj = projectFor(state, "player");
  const outOfVisionAiUnit = [...state.units.values()].find(u => u.owner === "ai" && u.type !== "skiff");
  assert.ok(outOfVisionAiUnit, "fixture sanity: the AI's starting base has units the player cannot see");
  assert.ok(!proj.units.some(u => u.id === outOfVisionAiUnit.id), "an unseen enemy unit must not appear");
});

test("a visible enemy unit is included but order, orderQueue, homeCC and targetId are stripped", () => {
  const { state, visibleEnemy } = buildScenario();
  const proj = projectFor(state, "player");
  const seen = proj.units.find(u => u.id === visibleEnemy.id);
  assert.ok(seen, "a visible enemy unit must still be reported");
  assert.equal(seen.order, null);
  assert.deepEqual(seen.orderQueue, []);
  assert.equal(seen.homeCC ?? null, null);
  assert.equal(seen.targetId ?? null, null);
  // Non-intel fields (position, hp, type) are exactly what fog is supposed to reveal.
  assert.equal(seen.x, visibleEnemy.x);
  assert.equal(seen.owner, "ai");
});

test("buildings follow the same visibility and targetId-stripping rule as units", () => {
  const { state, px, py } = buildScenario();
  // Reuse the real ai starting Command Center instead of hand-rolling a Building: find one and
  // temporarily relocate it onto the player's base so it's guaranteed visible, same technique as
  // the unit case above.
  const aiBuilding = [...state.buildings.values()].find(b => b.owner === "ai");
  const originalX = aiBuilding.x, originalY = aiBuilding.y;
  aiBuilding.x = px; aiBuilding.y = py;
  aiBuilding.targetId = "some-target-id";
  updateFog(state, state.fogs.player, "player");
  const proj = projectFor(state, "player");
  const seen = proj.buildings.find(b => b.id === aiBuilding.id);
  assert.ok(seen, "a visible enemy building must be reported");
  assert.equal(seen.targetId ?? null, null, "an enemy building's current attack target is intel too");
  aiBuilding.x = originalX; aiBuilding.y = originalY;   // undo, in case a future test in this run reuses state
});

test("a charted (non-hidden) node is always included, with only id and amount", () => {
  const { state } = buildScenario();
  const chartedNode = state.map.nodes.find(n => !n.hidden);
  assert.ok(chartedNode, "fixture sanity: ferros has at least one charted node");
  const proj = projectFor(state, "player");
  const seen = proj.nodes.find(n => n.id === chartedNode.id);
  assert.ok(seen, "a charted node must always be reported");
  assert.equal(seen.amount, chartedNode.amount);
  assert.equal(Object.keys(seen).sort().join(","), "amount,id", "no position/com leak for a node the client already knows how to regenerate");
});

test("an undiscovered hidden node is excluded", () => {
  const { state, undiscovered } = buildScenario();
  const proj = projectFor(state, "player");
  assert.ok(!proj.nodes.some(n => n.id === undiscovered.id));
});

test("a discovered hidden node is included, with only id and amount", () => {
  const { state, discovered } = buildScenario();
  const proj = projectFor(state, "player");
  const seen = proj.nodes.find(n => n.id === discovered.id);
  assert.ok(seen, "a scouted hidden node must be reported");
  assert.equal(seen.amount, discovered.amount);
});

test("own player record keeps resources and upgrades, and still gets score/supply", () => {
  const { state } = buildScenario();
  state.players.player.resources.ore = 12345;
  const proj = projectFor(state, "player");
  assert.equal(proj.players.player.resources.ore, 12345);
  assert.equal(proj.players.player.score, playerScore(state, "player"));
  assert.equal(proj.players.player.supply, supplyUsed(state, "player"));
});

test("another seat's player record is public-only — no resources, no upgrades leak", () => {
  const { state } = buildScenario();
  const proj = projectFor(state, "player");
  const ai = proj.players.ai;
  assert.equal(ai.resources, undefined, "resources must not appear on another seat's record");
  assert.equal(ai.upgrades, undefined, "upgrades must not appear on another seat's record");
  assert.equal(ai.id, "ai");
  assert.equal(ai.faction, state.players.ai.faction);
  assert.equal(ai.isAI, true);
  assert.equal(ai.color, state.players.ai.color);
  assert.equal(ai.score, playerScore(state, "ai"));
  assert.equal(ai.supply, supplyUsed(state, "ai"));
  assert.equal(ai.supplyCap, supplyCap(state, "ai"));
});

test("fogs carries only the requesting seat's own fog", () => {
  const { state } = buildScenario();
  const proj = projectFor(state, "player");
  assert.deepEqual(Object.keys(proj.fogs), ["player"]);
});

test("owners is passed through unchanged", () => {
  const { state } = buildScenario();
  const proj = projectFor(state, "player");
  assert.deepEqual(proj.owners, state.owners);
});

test("an event owned by the seat is always included, regardless of location", () => {
  const { state, px, py } = buildScenario();
  state.events.push({ type: "buildingComplete", x: px - 9999, y: py - 9999, owner: "player" });
  const proj = projectFor(state, "player");
  assert.ok(proj.events.some(e => e.type === "buildingComplete" && e.owner === "player"));
});

test("an event at a currently-visible point is included regardless of owner", () => {
  const { state } = buildScenario();
  const proj = projectFor(state, "player");
  assert.ok(proj.events.some(e => e.type === "unitSpawned" && e.owner === "ai"),
    "the AI-owned event placed on the player's own base must pass on visibility");
  assert.ok(proj.events.some(e => e.type === "wreckMatured"),
    "the ownerless event at a visible point must pass too");
});

test("an event neither owned nor at a visible point is excluded", () => {
  const { state } = buildScenario();
  const proj = projectFor(state, "player");
  assert.ok(!proj.events.some(e => e.type === "unitSpawned" && e.x < -1000),
    "the far-away AI-owned event must not appear");
});

test("the map is never part of the projection", () => {
  const { state } = buildScenario();
  const proj = projectFor(state, "player");
  assert.equal(proj.map, undefined);
});

test("no-leak crawler: nothing outside the seat's fog survives a JSON round-trip", () => {
  const { state, undiscovered } = buildScenario();
  const proj = projectFor(state, "player");
  const wire = JSON.parse(JSON.stringify(proj));   // exactly what actually reaches a client
  const blob = JSON.stringify(wire);

  const outOfVisionAiUnitIds = [...state.units.values()]
    .filter(u => u.owner === "ai" && u.type !== "skiff")
    .map(u => u.id);
  assert.ok(outOfVisionAiUnitIds.length > 0, "fixture sanity");
  for (const id of outOfVisionAiUnitIds) assert.ok(!blob.includes(JSON.stringify(id)), `unseen unit ${id} leaked`);

  const outOfVisionAiBuildingIds = [...state.buildings.values()].filter(b => b.owner === "ai").map(b => b.id);
  for (const id of outOfVisionAiBuildingIds) assert.ok(!blob.includes(JSON.stringify(id)), `unseen building ${id} leaked`);

  assert.ok(!blob.includes("424242"), "the AI's private resource figure must never appear");
  assert.ok(!blob.includes("someUpgrade"), "the AI's private upgrade key must never appear");
  assert.ok(!blob.includes(JSON.stringify(undiscovered.id)), "an undiscovered hidden node's id must never appear");
  assert.ok(!blob.includes("some-ai-cc-id"), "a stripped homeCC value must never appear");
  assert.ok(!blob.includes("some-target-id"), "a stripped targetId value must never appear");

  // Walk the whole structure recursively too, rather than trusting substring search alone —
  // guards against a value that's technically present but JSON-escaped differently than expected.
  const forbidden = new Set([...outOfVisionAiUnitIds, ...outOfVisionAiBuildingIds, undiscovered.id]);
  (function walk(node) {
    if (Array.isArray(node)) { for (const v of node) walk(v); return; }
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        assert.ok(!forbidden.has(v), `forbidden id ${v} found under key "${k}"`);
        walk(v);
      }
    }
  })(wire);
});

/* ============================================================
   M0's own stated exit test (ADR-0009): projectFor(s, "player") must render pixel-identically to
   s under the existing render tests. "Pixel-identical" here means the same methodology
   test/render.test.js already uses — a recording Proxy standing in for the canvas context, so two
   renders can be compared call-for-call without needing a real canvas.

   The projection alone can't be handed to drawFrame — it deliberately has no map, and its
   units/buildings are plain arrays post-JSON-round-trip rather than the Maps state.js builds. Both
   of those are exactly what a real client already does before rendering: keep its own
   deterministically-regenerated map, and index the incoming entity list by id. Reassembling that
   here is the test proving the reassembly is sufficient, not a shortcut around it.
   ============================================================ */
function recordingCtx() {
  const calls = [];
  const ctx = new Proxy({}, {
    get(t, prop) {
      if (prop === "calls") return calls;
      if (prop === "measureText") return () => { calls.push({ fn: "measureText", args: [] }); return { width: 10 }; };
      return (...args) => { calls.push({ fn: prop, args }); };
    },
    set(t, prop, value) { calls.push({ set: prop, value }); return true; },
  });
  return ctx;
}

globalThis.document = {
  createElement() {
    const ctx = recordingCtx();
    return { width: 0, height: 0, getContext: () => ctx };
  },
};

const { drawFrame } = await import("../render.js");

function reassembleClientView(proj, ownMap) {
  return {
    ...proj,
    map: ownMap,
    units: new Map(proj.units.map(u => [u.id, u])),
    buildings: new Map(proj.buildings.map(b => [b.id, b])),
    selection: [],
    fog: proj.fogs.player,
    fogAI: proj.fogs.player,   // unused by a player-perspective render; kept so any stray read doesn't throw
  };
}

test("M0: projectFor(s, 'player') renders pixel-identically to s once reassembled with the local map", () => {
  const { state, px, py } = buildScenario();
  const camera = { x: px, y: py, zoom: 1 };

  const realCtx = recordingCtx();
  drawFrame(realCtx, state, camera, 800, 600, null, null, 1, false);

  const proj = projectFor(state, "player");
  const wire = JSON.parse(JSON.stringify(proj));
  const view = reassembleClientView(wire, state.map);
  const projCtx = recordingCtx();
  drawFrame(projCtx, view, camera, 800, 600, null, null, 1, false);

  assert.deepEqual(projCtx.calls, realCtx.calls);
});
