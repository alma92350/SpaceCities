import { test } from "node:test";
import assert from "node:assert/strict";
import { createLobby } from "../server/lobby.js";
import { createGameState, makeUnit, makeBuilding } from "../engine/state.js";
import { projectFor } from "../engine/projection.js";
import { createMcpServer, PROTOCOL_VERSION } from "../net/mcp.js";
import { mintSeatHandle } from "../server/mcpSeatHandle.js";
import { createObservationTools } from "../server/mcpObservationTools.js";
import { UNITS } from "../engine/entities.js";

/* ============================================================
   T-052 (FR-14): get_situation / list_entities / get_map_overview / get_tech_options — this
   task's own exit criterion is explicit: "test proves nothing outside the seat's fog leaks."
   Every tool here is built on engine/projection.js's own projectFor(state, seat) — the SAME
   already-tested, already-security-critical fog filter every real WebSocket push already goes
   through (this file's own header: "a leak is a defect") — never a second, parallel
   implementation of fog logic. These tests drive a REAL createGameState + real fog-relevant
   entities through the REAL projectFor, so the fog-leak proof is against the actual mechanism,
   not a mock of it.

   A fake projection cache ({latestProjFor: seat => proj}) stands in for
   server/mcpObservationCache.js's real worker-message plumbing — proven separately in
   test/mcpObservationCache.test.js — the same "prove the mechanism, then prove the piece that
   feeds it, separately" split this whole codebase already uses throughout. mcpFor's own getCache
   routes by matchId, keyed to exactly ONE match by default — the multi-match routing test below
   is what actually exercises more than one key, proving a real production server (many concurrent
   matches, each with its own cache) can never answer one seat with a DIFFERENT match's data.
   ============================================================ */

function fakeCache(projByOwner, mapMeta = null) {
  return { latestProjFor: owner => projByOwner[owner] ?? null, mapMeta: () => mapMeta };
}

function joinedSeat(lobby, matchId, seatIndex) {
  const joined = lobby.joinMatch(matchId, seatIndex);
  return mintSeatHandle(matchId, seatIndex, joined.token);
}

async function callTool(mcp, name, args) {
  const body = {
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name, arguments: args, _meta: { "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION, "io.modelcontextprotocol/clientCapabilities": {} } },
  };
  return mcp.handleRequest({
    httpMethod: "POST",
    headers: { "mcp-protocol-version": PROTOCOL_VERSION, "mcp-method": "tools/call", "mcp-name": name },
    rawBody: JSON.stringify(body),
  });
}

// A real 2-seat match with a THIRD, distant enemy unit placed far outside player's fog, so every
// test below has a genuine "this must NOT be visible" fixture to check against, not just an
// absence of evidence.
function fixture() {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const hiddenEnemy = makeUnit("skiff", "ai", state.map.bases.ai.x, state.map.bases.ai.y);
  state.units.set(hiddenEnemy.id, hiddenEnemy);
  return { state, hiddenEnemyId: hiddenEnemy.id };
}

function mcpFor(lobby, matchId, projByOwner, mapMeta = null) {
  const cache = fakeCache(projByOwner, mapMeta);
  return createMcpServer({ tools: createObservationTools(lobby, mId => (mId === matchId ? cache : null)) });
}

test("createObservationTools registers exactly the five named tools", () => {
  const tools = createObservationTools(createLobby(), () => null);
  assert.deepEqual(tools.map(t => t.name).sort(), ["get_counters", "get_map_overview", "get_situation", "get_tech_options", "list_entities"]);
});

test("get_situation on a match id with NO live cache at all (never started) is a distinct, clear tool execution error", async () => {
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = joinedSeat(lobby, match.id, 0);
  const mcp = createMcpServer({ tools: createObservationTools(lobby, () => null) });   // getCache always returns null

  const { body } = await callTool(mcp, "get_situation", { seat_handle });
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /match-not-live/);
});

test("REAL multi-match routing: a seat in match A never sees match B's projection, even though both caches exist simultaneously", async () => {
  const { state: stateA } = fixture();
  stateA.players.player.resources.ore = 111;
  const { state: stateB } = fixture();
  stateB.players.player.resources.ore = 222;

  const lobby = createLobby();
  const matchA = lobby.createMatch({ seatKinds: ["open", "open"] });
  const matchB = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seatA = joinedSeat(lobby, matchA.id, 0);
  const seatB = joinedSeat(lobby, matchB.id, 0);

  const cacheA = fakeCache({ player: projectFor(stateA, "player") });
  const cacheB = fakeCache({ player: projectFor(stateB, "player") });
  const mcp = createMcpServer({
    tools: createObservationTools(lobby, matchId => {
      if (matchId === matchA.id) return cacheA;
      if (matchId === matchB.id) return cacheB;
      return null;
    }),
  });

  const resultA = await callTool(mcp, "get_situation", { seat_handle: seatA });
  const resultB = await callTool(mcp, "get_situation", { seat_handle: seatB });
  assert.equal(resultA.body.result.structuredContent.resources.ore, 111, "match A's seat must see match A's own resources");
  assert.equal(resultB.body.result.structuredContent.resources.ore, 222, "match B's seat must see match B's own resources, never A's");
});

test("get_situation reports own resources, tick/time, and unit/building counts by type — never raw per-unit detail", async () => {
  const { state } = fixture();
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = joinedSeat(lobby, match.id, 0);
  const mcp = mcpFor(lobby, match.id, { player: projectFor(state, "player") });

  const { body } = await callTool(mcp, "get_situation", { seat_handle });
  assert.equal(body.result.isError, undefined);
  const sc = body.result.structuredContent;
  assert.equal(sc.tick, state.tick);
  assert.equal(sc.over, false);
  assert.deepEqual(sc.resources, state.players.player.resources);
  assert.ok(sc.units_by_type.worker >= 1, "the starting workers are counted");
  assert.ok(sc.buildings_by_type.command >= 1, "the starting Command Center is counted");
});

test("get_situation on a match with no state pushed yet (worker hasn't ticked) is a clear tool execution error, not a crash", async () => {
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = joinedSeat(lobby, match.id, 0);
  const mcp = mcpFor(lobby, match.id, {});   // cache exists, but nothing pushed yet for this seat

  const { body } = await callTool(mcp, "get_situation", { seat_handle });
  assert.equal(body.result.isError, true);
});

test("list_entities: the calling seat's own units/buildings are always included, fully", async () => {
  const { state } = fixture();
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = joinedSeat(lobby, match.id, 0);
  const mcp = mcpFor(lobby, match.id, { player: projectFor(state, "player") });

  const { body } = await callTool(mcp, "list_entities", { seat_handle });
  const entities = body.result.structuredContent.entities;
  const ownCC = [...state.buildings.values()].find(b => b.owner === "player" && b.type === "command");
  const found = entities.find(e => e.id === ownCC.id);
  assert.ok(found, "the seat's own Command Center must be listed");
  assert.equal(found.owner, "player");
});

test("list_entities: an enemy unit OUTSIDE this seat's fog never appears — the exact property this task's own exit criterion names", async () => {
  const { state, hiddenEnemyId } = fixture();
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = joinedSeat(lobby, match.id, 0);
  const mcp = mcpFor(lobby, match.id, { player: projectFor(state, "player") });

  const { body } = await callTool(mcp, "list_entities", { seat_handle });
  const entities = body.result.structuredContent.entities;
  assert.equal(entities.some(e => e.id === hiddenEnemyId), false, "an enemy unit outside fog must not leak into the digest");
  // And the raw JSON of the whole response must not contain the hidden unit's id ANYWHERE —
  // not just absent from the entities array, absent from the wire entirely.
  assert.equal(JSON.stringify(body).includes(hiddenEnemyId), false);
});

test("list_entities: once the SAME enemy unit is actually visible (moved into fog), it appears — the filter is real fog, not a blanket owner check", async () => {
  const { state, hiddenEnemyId } = fixture();
  const enemy = state.units.get(hiddenEnemyId);
  // Relocate it next to the player's own base, then recompute fog so it's genuinely, honestly visible.
  enemy.x = state.map.bases.player.x + 20;
  enemy.y = state.map.bases.player.y;
  const { updateFog } = await import("../engine/fog.js");
  updateFog(state, state.fogs.player, "player");

  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = joinedSeat(lobby, match.id, 0);
  const mcp = mcpFor(lobby, match.id, { player: projectFor(state, "player") });

  const { body } = await callTool(mcp, "list_entities", { seat_handle });
  assert.ok(body.result.structuredContent.entities.some(e => e.id === hiddenEnemyId), "a genuinely visible enemy unit must appear");
});

test("list_entities: trims each entity down to presence/health plus a curated activity summary — never the raw engine object's order/orderQueue/homeCC/etc.", async () => {
  const { state } = fixture();
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = joinedSeat(lobby, match.id, 0);
  const mcp = mcpFor(lobby, match.id, { player: projectFor(state, "player") });

  const { body } = await callTool(mcp, "list_entities", { seat_handle });
  const entity = body.result.structuredContent.entities[0];
  // `activity`/`orderTarget` are this file's own derived, closed-vocabulary summary of what an OWN
  // entity is doing (see trimEntity) — the raw engine fields behind them still never ship.
  assert.deepEqual(Object.keys(entity).sort().filter(k => !["activity", "orderTarget", "queue", "buildProgress"].includes(k)),
    ["hp", "id", "owner", "type", "x", "y"]);
  for (const e of body.result.structuredContent.entities) {
    for (const leaked of ["order", "orderQueue", "homeCC", "targetId", "cargo", "rally"]) {
      assert.equal(leaked in e, false, `${leaked} must never reach an observer`);
    }
  }
});

test("list_entities: an optional type filter narrows the digest without needing a second tool", async () => {
  const { state } = fixture();
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = joinedSeat(lobby, match.id, 0);
  const mcp = mcpFor(lobby, match.id, { player: projectFor(state, "player") });

  const { body } = await callTool(mcp, "list_entities", { seat_handle, type: "command" });
  assert.ok(body.result.structuredContent.entities.length > 0);
  assert.ok(body.result.structuredContent.entities.every(e => e.type === "command"));
});

test("get_map_overview lists discovered resource nodes and visible bases, never an undiscovered hidden cache", async () => {
  const { state } = fixture();
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = joinedSeat(lobby, match.id, 0);
  const mcp = mcpFor(lobby, match.id, { player: projectFor(state, "player") });

  const { body } = await callTool(mcp, "get_map_overview", { seat_handle });
  const sc = body.result.structuredContent;
  assert.ok(sc.nodes.length > 0, "the home ore doorstep is discovered from the start");
  assert.ok(sc.bases.some(b => b.owner === "player"), "the seat's own base is listed");
  // A hidden, undiscovered node's id must genuinely not appear anywhere on the wire.
  const undiscoveredHidden = state.map.nodes.find(n => n.hidden);
  if (undiscoveredHidden) assert.equal(JSON.stringify(body).includes(undiscoveredHidden.id), false);
});

test("get_tech_options lists buildable units/buildings with real affordability, using the seat's OWN current resources", async () => {
  const { state } = fixture();
  state.players.player.resources.ore = 1000;   // plenty — a Worker (cost.ore=50) must read affordable
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = joinedSeat(lobby, match.id, 0);
  const mcp = mcpFor(lobby, match.id, { player: projectFor(state, "player") });

  const { body } = await callTool(mcp, "get_tech_options", { seat_handle });
  const worker = body.result.structuredContent.units.find(u => u.type === "worker");
  assert.ok(worker, "worker must be listed among the unit options");
  assert.equal(worker.prereqs_met, true);
  assert.equal(worker.affordable, true);
});

test("get_tech_options correctly reports affordable:false when the seat genuinely can't pay", async () => {
  const { state } = fixture();
  state.players.player.resources.ore = 0;
  state.players.player.resources.biomass = 0;
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = joinedSeat(lobby, match.id, 0);
  const mcp = mcpFor(lobby, match.id, { player: projectFor(state, "player") });

  const { body } = await callTool(mcp, "get_tech_options", { seat_handle });
  const worker = body.result.structuredContent.units.find(u => u.type === "worker");
  assert.equal(worker.affordable, false);
});

test("every observation tool rejects an invalid seat_handle as a tool execution error, never a crash or a JSON-RPC protocol error", async () => {
  const lobby = createLobby();
  const mcp = mcpFor(lobby, "irrelevant-no-real-match-here", {});
  for (const name of ["get_situation", "list_entities", "get_map_overview", "get_tech_options", "get_counters"]) {
    const { status, body } = await callTool(mcp, name, { seat_handle: "garbage" });
    assert.equal(status, 200, `${name}: a bad handle is a tool execution error, not an HTTP-level failure`);
    assert.equal(body.result.isError, true, `${name} must reject a garbage handle`);
  }
});


/* ---------------------------------------------------------------
   Agent-observability: what a thing IS, what it is DOING, and where.
   Each case below is a gap a real MCP agent hit in a played match — a node whose commodity was
   unknowable without walking a worker to it, a worker that silently stopped, combat stats that
   lived only in an MCP resource many clients never surface.
   --------------------------------------------------------------- */

// The mapMeta shape server/mcpObservationCache.js builds from server/matchWorker.js's describeMap
// reply — built here from the SAME state the projection is taken against, so the merge under test
// is exercised against real node ids rather than invented ones.
function mapMetaFor(state) {
  return {
    map: { width: state.map.width, height: state.map.height, planetId: state.planetId, tickRate: 20 },
    nodesById: new Map(state.map.nodes.map(n => [n.id, { id: n.id, com: n.com, x: n.x, y: n.y, max: n.max, hidden: !!n.hidden }])),
  };
}

test("get_map_overview reports each discovered node's commodity, position and distance from base", async () => {
  const { state } = fixture();
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = joinedSeat(lobby, match.id, 0);
  const mcp = mcpFor(lobby, match.id, { player: projectFor(state, "player") }, mapMetaFor(state));

  const { body } = await callTool(mcp, "get_map_overview", { seat_handle });
  const sc = body.result.structuredContent;
  assert.ok(sc.nodes.every(n => typeof n.com === "string" && typeof n.x === "number" && typeof n.y === "number"),
    "every node must say WHICH commodity it yields and where it is — the whole point of the merge");
  assert.ok(sc.commodities_available.includes("ore"), "the home ore doorstep is reachable from the start");
  const dists = sc.nodes.map(n => n.distance_from_base);
  assert.deepEqual(dists, [...dists].sort((a, b) => a - b), "nodes come back nearest-first");
  assert.equal(sc.map.width, state.map.width);
});

test("get_map_overview's node merge never introduces a node this seat has not discovered", async () => {
  const { state } = fixture();
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = joinedSeat(lobby, match.id, 0);
  // mapMeta deliberately carries EVERY node, hidden caches included — the merge must still be
  // keyed by the seat's own fog-filtered projection.
  const mcp = mcpFor(lobby, match.id, { player: projectFor(state, "player") }, mapMetaFor(state));

  const { body } = await callTool(mcp, "get_map_overview", { seat_handle });
  const undiscoveredHidden = state.map.nodes.find(n => n.hidden);
  assert.ok(undiscoveredHidden, "the fixture must actually contain a hidden cache for this to prove anything");
  assert.equal(JSON.stringify(body).includes(undiscoveredHidden.id), false);
});

test("get_map_overview degrades to the plain {id, amount} shape when the map reference hasn't arrived yet", async () => {
  const { state } = fixture();
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = joinedSeat(lobby, match.id, 0);
  const mcp = mcpFor(lobby, match.id, { player: projectFor(state, "player") });   // no mapMeta

  const { body } = await callTool(mcp, "get_map_overview", { seat_handle });
  assert.equal(body.result.isError, undefined);
  assert.ok(body.result.structuredContent.nodes.every(n => n.com === null));
});

test("list_entities reports what your OWN units are doing, and can filter to just the idle ones", async () => {
  const { state } = fixture();
  const worker = [...state.units.values()].find(u => u.owner === "player" && u.type === "worker");
  assert.ok(worker, "the fixture must start the player with a worker");
  worker.order = null;   // exactly the shape a drained node leaves behind
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = joinedSeat(lobby, match.id, 0);
  const mcp = mcpFor(lobby, match.id, { player: projectFor(state, "player") });

  const { body } = await callTool(mcp, "list_entities", { seat_handle, activity: "idle" });
  const ids = body.result.structuredContent.entities.map(e => e.id);
  assert.ok(ids.includes(worker.id), "an order-less worker must be findable as idle");

  const all = await callTool(mcp, "list_entities", { seat_handle });
  const mine = all.body.result.structuredContent.entities.filter(e => e.owner === "player");
  assert.ok(mine.every(e => typeof e.activity === "string"), "own entities carry an activity");
});

test("list_entities never reports an enemy's activity — fog does not reveal intent", async () => {
  const { state } = fixture();
  // Put an enemy unit right next to the player's base so it IS visible, order and all.
  const seen = makeUnit("skiff", "ai", state.map.bases.player.x + 20, state.map.bases.player.y + 20);
  seen.order = { type: "move", x: 1, y: 1 };
  state.units.set(seen.id, seen);
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = joinedSeat(lobby, match.id, 0);
  const mcp = mcpFor(lobby, match.id, { player: projectFor(state, "player") });

  const { body } = await callTool(mcp, "list_entities", { seat_handle, owner: "ai" });
  const enemy = body.result.structuredContent.entities.find(e => e.id === seen.id);
  assert.ok(enemy, "the adjacent enemy must be visible at all for this to prove anything");
  assert.equal(enemy.activity, undefined);
  assert.equal(enemy.orderTarget, undefined);
});

test("get_situation names the seat, its opponents and its idle units", async () => {
  const { state } = fixture();
  for (const u of state.units.values()) if (u.owner === "player") u.order = null;
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = joinedSeat(lobby, match.id, 0);
  const mcp = mcpFor(lobby, match.id, { player: projectFor(state, "player") }, mapMetaFor(state));

  const { body } = await callTool(mcp, "get_situation", { seat_handle });
  const sc = body.result.structuredContent;
  assert.equal(sc.you, "player");
  assert.deepEqual(sc.opponents, ["ai"]);
  assert.ok(sc.idle_unit_ids.length > 0);
  assert.equal(sc.map.tickRate, 20);
});

test("get_tech_options carries combat stats, the missing prereq by name, and where a unit is produced", async () => {
  const { state } = fixture();
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = joinedSeat(lobby, match.id, 0);
  const mcp = mcpFor(lobby, match.id, { player: projectFor(state, "player") });

  const { body } = await callTool(mcp, "get_tech_options", { seat_handle });
  const sc = body.result.structuredContent;
  const skiff = sc.units.find(u => u.type === "skiff");
  assert.ok(skiff.stats.hp > 0 && skiff.stats.attack > 0, "combat math needs real stats, not a hand-kept table");
  assert.deepEqual(skiff.produced_by, ["barracks"]);
  assert.deepEqual(skiff.missing_prereqs, [], "the Skiff has no prerequisite of its own");

  // The Lancer does: its Foundry doesn't exist at match start, and "prereqs_met:false" alone left a
  // caller with no way to find out what to build first.
  const lancer = sc.units.find(u => u.type === "lancer");
  assert.equal(lancer.prereqs_met, false);
  assert.deepEqual(lancer.missing_prereqs, ["foundry"]);

  // The scenario-only Freighter advertises no cost and no producer — it must read as unbuildable
  // rather than as a free unit an out-of-ore agent can go looking for.
  const freighter = sc.units.find(u => u.type === "freighter");
  assert.deepEqual(freighter.produced_by, []);
  assert.equal(freighter.buildable, false);
});

test("get_counters exposes the same real bonusVs table the engine's combat math reads", async () => {
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = joinedSeat(lobby, match.id, 0);
  const mcp = mcpFor(lobby, match.id, {});

  const { body } = await callTool(mcp, "get_counters", { seat_handle });
  const counters = body.result.structuredContent.counters;
  assert.ok(counters.length > 0);
  assert.ok(counters.every(c => UNITS[c.attacker] && c.bonus > 0));
  for (const c of counters) assert.equal(UNITS[c.attacker].bonusVs[c.target], c.bonus);
});
