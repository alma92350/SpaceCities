import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeUnit } from "../engine/state.js";
import { updateFog, createFog } from "../engine/fog.js";
import { generateMap } from "../engine/map.js";
import { mulberry32 } from "../engine/rng.js";
import { supplyUsed, supplyCap } from "../engine/supply.js";
import { playerScore } from "../engine/victory.js";
import { projectFor, reassembleProjection, projectForSpectator, reassembleSpectatorProjection } from "../engine/projection.js";

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
  // Recompute once more so state.fogs.player.visible reflects CURRENT units (scout gone) rather
  // than staying frozen mid-scout — exactly the invariant engine/sim.js's own tick() always keeps
  // (fog is recomputed fresh every tick, right after any entity change, never left stale). Without
  // this, `visible` would still show the deleted scout's own sight radius as "currently visible",
  // an inconsistency real gameplay can never produce and that a client-side fog recompute (which
  // only ever sees CURRENT entities, same as this second call) could never reproduce either.
  // `explored` is unaffected either way — it only ever grows, so the scout's one real contribution
  // (discovering the hidden node below) survives permanently regardless of this second call.
  updateFog(state, state.fogs.player, "player");

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

test("the fog grid is never part of the wire payload — the client recomputes it locally (ADR-0009 M2)", () => {
  const { state } = buildScenario();
  const proj = projectFor(state, "player");
  assert.equal(proj.fogs, undefined,
    "shipping the fog grid every tick is exactly what M2 removes — own units/buildings are already in the payload, which is everything engine/fog.js's updateFog needs to recompute it client-side");
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
   T-037 (FR-7): projectForSpectator(state) — the ONE deliberate exception to this file's own
   "no-leak" rule. A spectator gets full-map vision by design (the PRD's own words), so every
   assertion here is the mirror image of the no-leak crawler above: nothing is stripped, nothing is
   filtered, everything both seats have is visible to a client that plays neither of them.
   ============================================================ */

test("projectForSpectator includes every unit and building, own-shaped for BOTH seats — no fog filtering, no intel stripping", () => {
  const { state, visibleEnemy, playerUnit } = buildScenario();
  const proj = projectForSpectator(state);

  const enemy = proj.units.find(u => u.id === visibleEnemy.id);
  assert.ok(enemy, "the AI's unit must be present regardless of whether any seat's fog would show it");
  assert.deepEqual(enemy.order, { type: "attack-move", x: playerUnit.x + 10, y: playerUnit.y });
  assert.deepEqual(enemy.orderQueue, [{ type: "move", x: playerUnit.x + 50, y: playerUnit.y }]);
  assert.equal(enemy.homeCC, "some-ai-cc-id");
  assert.equal(enemy.targetId, "some-target-id");

  const own = proj.units.find(u => u.id === playerUnit.id);
  assert.deepEqual(own.order, { type: "move", x: playerUnit.x + 5, y: playerUnit.y });
  assert.equal(own.homeCC, "some-player-cc-id");
});

test("projectForSpectator includes every AI unit, not just the ones inside some seat's fog", () => {
  const { state } = buildScenario();
  const proj = projectForSpectator(state);
  const outOfVisionAiUnitIds = [...state.units.values()].filter(u => u.owner === "ai" && u.type !== "skiff").map(u => u.id);
  assert.ok(outOfVisionAiUnitIds.length > 0, "fixture sanity");
  const projIds = new Set(proj.units.map(u => u.id));
  for (const id of outOfVisionAiUnitIds) assert.ok(projIds.has(id), `unit ${id} must be visible to a spectator even though no seat's own fog reveals it`);
});

test("projectForSpectator includes every player's real resources and upgrades, not the public-only summary", () => {
  const { state } = buildScenario();
  const proj = projectForSpectator(state);
  assert.equal(proj.players.ai.resources.ore, 424242);
  assert.equal(proj.players.ai.upgrades.someUpgrade, true);
  assert.ok(proj.players.player.resources, "the player's own resources must also be present (both seats, symmetrically)");
});

test("projectForSpectator includes every node, hidden-and-undiscovered ones included — full-map vision has no discovery gate", () => {
  const { state, undiscovered } = buildScenario();
  const proj = projectForSpectator(state);
  assert.ok(proj.nodes.some(n => n.id === undiscovered.id), "an undiscovered hidden node must still be visible to a spectator");
});

test("projectForSpectator includes every event regardless of location or owner", () => {
  const { state } = buildScenario();
  const proj = projectForSpectator(state);
  assert.equal(proj.events.length, state.events.length);
});

test("projectForSpectator never includes the map — same deterministic-regeneration contract as the ordinary per-seat projection", () => {
  const { state } = buildScenario();
  const proj = projectForSpectator(state);
  assert.equal(proj.map, undefined);
});

test("projectForSpectator survives a JSON round-trip (no live object references / circular structures left in)", () => {
  const { state } = buildScenario();
  const proj = projectForSpectator(state);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(proj)));
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

test("M0: projectFor(s, 'player') renders pixel-identically to s once reassembled with the local map", () => {
  const { state, px, py } = buildScenario();
  const camera = { x: px, y: py, zoom: 1 };

  const realCtx = recordingCtx();
  drawFrame(realCtx, state, camera, 800, 600, null, null, 1, false);

  const proj = projectFor(state, "player");
  const wire = JSON.parse(JSON.stringify(proj));
  // Since M2, fog is no longer part of the wire — reassembleProjection recomputes it from the
  // wire's own units/buildings. Seeded from state.fogs.player's OWN current arrays rather than a
  // blank createFog(): this test's job is render parity, not fog-recompute-from-zero (the
  // dedicated tests below cover that against a real multi-tick sequence, where "zero" is honest —
  // here buildScenario()'s discovered hidden node was found by a scout that no longer exists, so a
  // truly blank start could never recover that EXPLORED history no CURRENTLY-live unit witnesses,
  // exactly the gap a client who was actually connected the whole time would never hit for real).
  // The seed only supplies history a one-shot test has no other way to reconstruct; the recompute
  // itself still runs for real, against CURRENT units, same as any other call.
  const fog = createFog(state.map);
  fog.explored.set(state.fogs.player.explored);
  fog.visible.set(state.fogs.player.visible);
  const view = reassembleProjection(wire, state.map, fog, "player");
  const projCtx = recordingCtx();
  drawFrame(projCtx, view, camera, 800, 600, null, null, 1, false);

  assert.deepEqual(projCtx.calls, realCtx.calls);
});

test("reassembleProjection merges the wire's current node amounts into the LOCAL map's own nodes, not just an unused top-level field", () => {
  // Both existing reassembly tests above pass state.map itself as the reassembly target — the
  // SAME object the wire was derived from, so a node's amount already agrees trivially either
  // way and this bug is invisible to them. A real net/wsClientTransport.js client instead builds
  // its OWN, separately-generated map (from the same seed) once at welcome time and reuses it
  // across every subsequent state push — this is that scenario.
  const { state } = buildScenario();
  const chartedNode = state.map.nodes.find(n => !n.hidden);
  const originalAmount = chartedNode.amount;
  chartedNode.amount = originalAmount - 37;   // the server's own copy has been harvested down

  const proj = projectFor(state, "player");
  const wire = JSON.parse(JSON.stringify(proj));

  const freshMap = generateMap(state.planetId, mulberry32(state.seed),
    { sizeMult: state.sizeMult, resourceMult: state.resourceMult, swapAsym: state.swapAsym });
  const freshNodeBefore = freshMap.nodes.find(n => n.id === chartedNode.id);
  assert.equal(freshNodeBefore.amount, originalAmount,
    "fixture sanity: the freshly regenerated map still has the node's ORIGINAL amount — proving this really is a separate instance from state.map, not a coincidental alias");

  const view = reassembleProjection(wire, freshMap, createFog(freshMap), "player");
  const seen = view.map.nodes.find(n => n.id === chartedNode.id);
  assert.equal(seen.amount, chartedNode.amount,
    "the client's own map must reflect the server's current (harvested-down) amount, not the map's generation-time default");
});

/* ============================================================
   Bugfix, reported live by a human playing a real hosted match: battle wreckage (engine/
   wreckage.js) and Helium Bomb craters (engine/bomb.js) never appeared at all. Both push a BRAND
   NEW node onto state.map.nodes mid-match — one that does not exist in the client's own
   deterministically-regenerated map (engine/bomb.js's own spawnCraterNode comment already
   documents this exact fact for persist.js's save/load path: "this one doesn't exist in the
   seed-regenerated map at all, so it needs its whole shape saved and re-added on load"). The live
   wire path never got the same treatment: projectFor reduced every node, wreck/crater included, to
   {id, amount}, and reassembleProjection's own merge loop only ever UPDATED an existing map node's
   amount by id — an id it had never seen came back from `.find()` as undefined and was silently
   dropped, every single tick, forever. Fixed by sending a wreck/crater node in full (projectFor/
   projectForSpectator) and materializing one reassembleProjection/reassembleSpectatorProjection
   doesn't already recognize, instead of discarding it.
   ============================================================ */

test("bugfix: projectFor sends a wreck/crater node in FULL, not reduced to {id, amount} like an ordinary map-generated node", () => {
  const { state } = buildScenario();
  const wreckNode = { id: "wreck-999-metals", com: "metals", amount: 12, max: 12, x: 500, y: 500, wreck: true };
  state.map.nodes.push(wreckNode);
  if (state.map.nodesById) state.map.nodesById.set(wreckNode.id, wreckNode);

  const proj = projectFor(state, "player");
  const seen = proj.nodes.find(n => n.id === wreckNode.id);
  assert.ok(seen, "the wreck node must appear in the projection at all");
  assert.deepEqual(seen, wreckNode,
    "a wreck node has no seed-deterministic shape the client could reconstruct on its own, so it must ship in full, not merely {id, amount}");

  // An ORDINARY map-generated node must be unaffected by this — still reduced to {id, amount},
  // exactly the existing bandwidth-optimal behavior this task must not regress.
  const chartedNode = state.map.nodes.find(n => !n.hidden && !n.wreck && !n.crater);
  const seenOrdinary = proj.nodes.find(n => n.id === chartedNode.id);
  assert.deepEqual(Object.keys(seenOrdinary).sort(), ["amount", "id"]);
});

test("bugfix: reassembleProjection materializes a crater node the client's own regenerated map never had — the actual live-multiplayer defect (a Helium Bomb crater's resource node never appeared for a real human player)", () => {
  const { state } = buildScenario();
  const craterNode = { id: "crater-777", com: "ore", amount: 40, max: 40, x: 600, y: 600, crater: true };
  state.map.nodes.push(craterNode);
  if (state.map.nodesById) state.map.nodesById.set(craterNode.id, craterNode);

  const proj = projectFor(state, "player");
  const wire = JSON.parse(JSON.stringify(proj));

  // A FRESH, separately-regenerated map — exactly like a real net/wsClientTransport.js client's
  // own map, which never had this crater node pushed onto it (created mid-match, server-side,
  // well after the client's own map was already built from the seed).
  const freshMap = generateMap(state.planetId, mulberry32(state.seed),
    { sizeMult: state.sizeMult, resourceMult: state.resourceMult, swapAsym: state.swapAsym });
  assert.ok(!freshMap.nodes.some(n => n.id === craterNode.id),
    "fixture sanity: the freshly regenerated map genuinely has no idea this crater node exists yet");

  const view = reassembleProjection(wire, freshMap, createFog(freshMap), "player");
  const seen = view.map.nodes.find(n => n.id === craterNode.id);
  assert.ok(seen, "the crater node must be ADDED to the client's own map, not silently dropped");
  assert.equal(seen.amount, 40);
  assert.equal(seen.com, "ore");
  assert.equal(freshMap.nodesById.get(craterNode.id), seen,
    "nodesById (hudSelection.js/engine/gather.js's own O(1) lookup) must also learn about it, not just the plain nodes array");
});

test("bugfix: reassembleSpectatorProjection materializes a wreck node the same way, for a network spectator's own full-vision view", () => {
  const { state } = buildScenario();
  const wreckNode = { id: "wreck-555-electronics", com: "electronics", amount: 8, max: 8, x: 700, y: 700, wreck: true };
  state.map.nodes.push(wreckNode);
  if (state.map.nodesById) state.map.nodesById.set(wreckNode.id, wreckNode);

  const proj = projectForSpectator(state);
  const wire = JSON.parse(JSON.stringify(proj));
  const freshMap = generateMap(state.planetId, mulberry32(state.seed),
    { sizeMult: state.sizeMult, resourceMult: state.resourceMult, swapAsym: state.swapAsym });

  const view = reassembleSpectatorProjection(wire, freshMap);
  const seen = view.map.nodes.find(n => n.id === wreckNode.id);
  assert.ok(seen, "a spectator must also see battle wreckage appear, not just an ordinary seat");
  assert.equal(seen.amount, 8);
});

/* ============================================================
   T-037 (FR-7): reassembleSpectatorProjection — the client-side paired decode step for
   projectForSpectator(...)'s own wire shape. No fog to reconstruct (there is no seat to compute it
   FOR, and render.js/minimap.js's own hiddenByFog only ever reads state.fog when observerMode is
   false — a network spectator is ALWAYS rendered through Observer Mode, so state.fog is simply never
   consulted), so this is deliberately simpler than reassembleProjection: no createFog, no updateFog,
   just the same mechanical array-to-Map + node-amount-merge transform every client already needs
   regardless of which projection filled the wire payload.
   ============================================================ */

test("reassembleSpectatorProjection builds units/buildings Maps from the wire, keyed by id, with every field intact", () => {
  const { state, visibleEnemy } = buildScenario();
  const proj = projectForSpectator(state);
  const wire = JSON.parse(JSON.stringify(proj));
  const view = reassembleSpectatorProjection(wire, state.map);
  assert.ok(view.units instanceof Map);
  assert.ok(view.buildings instanceof Map);
  const enemy = view.units.get(visibleEnemy.id);
  assert.ok(enemy, "the AI's unit must survive reassembly, same as it survived the projection itself");
  assert.equal(enemy.homeCC, "some-ai-cc-id", "full fields, not stripped — a spectator's own reassembly must not re-introduce fog filtering client-side either");
});

test("reassembleSpectatorProjection merges the wire's current node amounts into the LOCAL map, same as the ordinary per-seat reassembly", () => {
  const { state } = buildScenario();
  const chartedNode = state.map.nodes.find(n => !n.hidden);
  const originalAmount = chartedNode.amount;
  chartedNode.amount = originalAmount - 41;

  const proj = projectForSpectator(state);
  const wire = JSON.parse(JSON.stringify(proj));
  const freshMap = generateMap(state.planetId, mulberry32(state.seed),
    { sizeMult: state.sizeMult, resourceMult: state.resourceMult, swapAsym: state.swapAsym });

  const view = reassembleSpectatorProjection(wire, freshMap);
  const seen = view.map.nodes.find(n => n.id === chartedNode.id);
  assert.equal(seen.amount, chartedNode.amount);
});

test("reassembleSpectatorProjection's fog/fogAI are null — there is no seat to compute fog for, and Observer Mode's own render path never reads them", () => {
  const { state } = buildScenario();
  const proj = projectForSpectator(state);
  const wire = JSON.parse(JSON.stringify(proj));
  const view = reassembleSpectatorProjection(wire, state.map);
  assert.equal(view.fog, null);
  assert.equal(view.fogAI, null);
});

test("reassembleSpectatorProjection never crashes on a full projectForSpectator round-trip, and selection starts empty", () => {
  const { state } = buildScenario();
  const proj = projectForSpectator(state);
  const wire = JSON.parse(JSON.stringify(proj));
  const view = reassembleSpectatorProjection(wire, state.map);
  assert.deepEqual(view.selection, []);
  assert.equal(view.over, false);
});

test("reassembleProjection works for any seat, not just a hardcoded 'player'", () => {
  const { state } = buildScenario();
  const proj = projectFor(state, "ai");
  const wire = JSON.parse(JSON.stringify(proj));
  const fog = createFog(state.map);
  const view = reassembleProjection(wire, state.map, fog, "ai");
  assert.equal(view.fog, fog, "fog/fogAI alias the SAME recomputed fog object the caller handed in");
  assert.equal(view.fogAI, fog);
  assert.ok(view.units instanceof Map);
  assert.ok(view.buildings instanceof Map);
  assert.deepEqual(view.selection, []);
});

/* ============================================================
   ADR-0009 M2: the fog grid is no longer shipped — reassembleProjection recomputes it from the
   wire's own units/buildings using engine/fog.js's updateFog, the exact same pure function
   engine/sim.js already runs server-side every tick. These tests prove the property M2 actually
   depends on: a client's own recompute must agree with the server's, byte for byte, or players see
   ghosts (ADR-0009's own stated risk) — not just "renders about right" (the M0 test above), but the
   underlying grids themselves.
   ============================================================ */

test("client-recomputed fog agrees with the server's own fog bit-for-bit, accumulated over a real sequence of ticks", () => {
  // Deliberately NOT buildScenario(): its discovered hidden node is found by a scout that is
  // then deleted, so state.fogs.player carries EXPLORED history no currently-live unit witnesses
  // — recoverable by a client that was accumulating the whole time (this test), never by a
  // one-shot snapshot (which is exactly why the M0 test above seeds instead of starting blank).
  // This fixture instead drives BOTH fogs through the SAME real sequence of moves, exactly
  // mirroring how net/wsClientTransport.js actually receives a stream of ticks in production —
  // the property this whole mechanism actually depends on holding.
  const state = createGameState({ planetId: "ferros", seed: 23 });
  const worker = [...state.units.values()].find(u => u.owner === "player");
  const map = generateMap(state.planetId, mulberry32(state.seed),
    { sizeMult: state.sizeMult, resourceMult: state.resourceMult, swapAsym: state.swapAsym });
  const fog = createFog(map);

  const waypoints = [[0, 0], [300, 0], [0, 300], [-500, 150], [200, -400]];
  for (const [dx, dy] of waypoints) {
    worker.x += dx; worker.y += dy;
    updateFog(state, state.fogs.player, "player");   // the server's own per-tick call
    const wire = JSON.parse(JSON.stringify(projectFor(state, "player")));
    reassembleProjection(wire, map, fog, "player");   // the client's own per-tick call
  }

  assert.deepEqual([...fog.explored], [...state.fogs.player.explored]);
  assert.deepEqual([...fog.visible], [...state.fogs.player.visible]);
});

test("explored accumulates across multiple state pushes with the SAME persistent fog object — never cleared, only ever added to", () => {
  const state = createGameState({ planetId: "ferros", seed: 11 });
  const worker = [...state.units.values()].find(u => u.owner === "player");
  const map = generateMap(state.planetId, mulberry32(state.seed),
    { sizeMult: state.sizeMult, resourceMult: state.resourceMult, swapAsym: state.swapAsym });
  const fog = createFog(map);   // ONE persistent object, exactly as net/wsClientTransport.js holds across every "state" message

  // First push: the worker at its starting position.
  updateFog(state, state.fogs.player, "player");
  let wire = JSON.parse(JSON.stringify(projectFor(state, "player")));
  reassembleProjection(wire, map, fog, "player");
  const exploredNearStart = [...fog.explored].reduce((a, v) => a + v, 0);
  assert.ok(exploredNearStart > 0, "fixture sanity: starting position reveals something");

  // Move the worker far away and push again — the OLD area must stay explored (monotonic) even
  // though it's no longer currently visible.
  worker.x += 2000; worker.y += 2000;
  updateFog(state, state.fogs.player, "player");
  wire = JSON.parse(JSON.stringify(projectFor(state, "player")));
  reassembleProjection(wire, map, fog, "player");
  const exploredAfterMove = [...fog.explored].reduce((a, v) => a + v, 0);

  assert.ok(exploredAfterMove >= exploredNearStart,
    "explored must never shrink — the client's own accumulated memory can only grow, matching the server's own updateFog contract");
});
