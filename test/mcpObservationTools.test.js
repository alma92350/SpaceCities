import { test } from "node:test";
import assert from "node:assert/strict";
import { createLobby } from "../server/lobby.js";
import { createGameState, makeUnit, makeBuilding } from "../engine/state.js";
import { projectFor, projectForSpectator, SPECTATOR_SEAT } from "../engine/projection.js";
import { createMcpServer, PROTOCOL_VERSION } from "../net/mcp.js";
import { mintSeatHandle, mintWatchHandle } from "../server/mcpSeatHandle.js";
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

test("createObservationTools registers exactly the six named tools", () => {
  const tools = createObservationTools(createLobby(), () => null);
  assert.deepEqual(tools.map(t => t.name).sort(), ["estimate_engagement", "get_counters", "get_map_overview", "get_situation", "get_tech_options", "list_entities"]);
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

/* ============================================================
   WATCHING a match (server/mcpSeatHandle.js's mintWatchHandle): the same observation tools, reading
   the spectator's own deliberately unfiltered projection (engine/projection.js's
   projectForSpectator) instead of a seat's fog-filtered one. The fog difference lives entirely in
   WHICH projection the worker built — these tests pin the two places the tools themselves must
   differ: a scoreboard with no "me" in it, and refusing the one question only a seat can answer.
   ============================================================ */

test("get_situation on a watch handle reports every side, not one seat's own resources", async () => {
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const { state } = fixture();
  const mcp = mcpFor(lobby, match.id, { [SPECTATOR_SEAT]: projectForSpectator(state) });

  const { body } = await callTool(mcp, "get_situation", { seat_handle: mintWatchHandle(match.id) });
  assert.equal(body.result.isError, undefined, JSON.stringify(body.result));
  const sc = body.result.structuredContent;
  assert.equal(sc.watching, true);
  assert.deepEqual(sc.sides.map(s => s.owner), ["player", "ai"]);
  for (const side of sc.sides) {
    assert.ok(side.resources, `${side.owner} has its own resources in the watch view`);
    assert.ok(Object.keys(side.units_by_type).length > 0, `${side.owner} has its own units counted`);
  }
  assert.equal(sc.resources, undefined, "a watcher holds no seat, so there is no 'my resources' to report");
});

test("a watcher sees BOTH sides' entities — including the one a seat's own fog hides", async () => {
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const { state, hiddenEnemyId } = fixture();
  const mcp = mcpFor(lobby, match.id, {
    player: projectFor(state, "player"),
    [SPECTATOR_SEAT]: projectForSpectator(state),
  });

  const seen = (await callTool(mcp, "list_entities", { seat_handle: mintWatchHandle(match.id) })).body.result.structuredContent.entities;
  assert.ok(seen.some(e => e.id === hiddenEnemyId), "the unit sitting outside player's fog is visible to a watcher");

  // ...and is still invisible to the seat itself — the watch path must not have widened anyone's fog.
  const seat_handle = joinedSeat(lobby, match.id, 0);
  const asPlayer = (await callTool(mcp, "list_entities", { seat_handle })).body.result.structuredContent.entities;
  assert.equal(asPlayer.some(e => e.id === hiddenEnemyId), false);
});

test("get_tech_options refuses a watch handle — affordability and prerequisites are per-seat questions", async () => {
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const { state } = fixture();
  const mcp = mcpFor(lobby, match.id, { [SPECTATOR_SEAT]: projectForSpectator(state) });

  const { body } = await callTool(mcp, "get_tech_options", { seat_handle: mintWatchHandle(match.id) });
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /watch-only-handle/);
});

/* ============================================================
   Agent-observability: the observation-side improvements drawn from two recorded matches — income
   as a FLOW rather than a stock, gatherers that have wandered somewhere fatal, a delta instead of
   the whole world every wake, a memory of enemies that have left fog (and the loud reminder that
   an empty list is fog, not victory), and an answer to "am I currently losing this fight".

   The fake cache here answers the three new cache capabilities the same way
   server/mcpObservationCache.js does in production; that file's own tests prove it derives them
   correctly from a real projection stream.
   ============================================================ */

function richCache(projByOwner, extra = {}) {
  return {
    latestProjFor: owner => projByOwner[owner] ?? null,
    mapMeta: () => null,
    incomeFor: () => extra.income ?? null,
    lastSeenFor: () => extra.lastSeen ?? [],
    changesSince: (owner, tick) => extra.changes?.(owner, tick) ?? null,
  };
}

function mcpWith(lobby, matchId, projByOwner, extra) {
  const cache = richCache(projByOwner, extra);
  return createMcpServer({ tools: createObservationTools(lobby, mId => (mId === matchId ? cache : null)) });
}

test("get_situation reports the economy's FLOW, not just the treasury — income per minute and how many workers are gathering", async () => {
  const { state } = fixture();
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = joinedSeat(lobby, match.id, 0);
  const mcp = mcpWith(lobby, match.id, { player: projectFor(state, "player") },
    { income: { per_min: { ore: 210 }, window_seconds: 30 } });

  const { body } = await callTool(mcp, "get_situation", { seat_handle });
  const economy = body.result.structuredContent.economy;
  assert.deepEqual(economy.income_per_min, { ore: 210 });
  assert.equal(economy.income_window_seconds, 30);
  assert.equal(typeof economy.gatherers, "number");
  assert.match(body.result.content[0].text, /Income\/min: ore 210/);
});

test("get_situation NAMES the gatherers that have wandered out of reach of home — the way a worker line actually dies", async () => {
  const { state } = fixture();
  const base = state.map.bases.player;
  // A worker mining a seam clear across the map: exactly what engine/gather.js's own depletion
  // retarget produces, one dry node at a time.
  const strayed = makeUnit("worker", "player", base.x + 1200, base.y);
  strayed.order = { type: "gather", nodeId: state.map.nodes[0].id, phase: "toNode" };
  state.units.set(strayed.id, strayed);
  const homebody = makeUnit("worker", "player", base.x + 40, base.y);
  homebody.order = { type: "gather", nodeId: state.map.nodes[0].id, phase: "toNode" };
  state.units.set(homebody.id, homebody);

  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = joinedSeat(lobby, match.id, 0);
  const mcp = mcpWith(lobby, match.id, { player: projectFor(state, "player") });

  const { body } = await callTool(mcp, "get_situation", { seat_handle });
  const atRisk = body.result.structuredContent.economy.workers_at_risk;
  assert.deepEqual(atRisk.map(w => w.id), [strayed.id]);
  assert.ok(atRisk[0].distance_from_base > 700);
  assert.match(body.result.content[0].text, /1 gatherer\(s\) exposed/);
});

test("list_entities says whether an empty enemy list is fog or absence, and remembers where they were last seen", async () => {
  const { state } = fixture();
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = joinedSeat(lobby, match.id, 0);
  const remembered = [{ id: "u21", type: "bastion", owner: "ai", x: 895, y: 481, hp: 300, tick: 7200, age_seconds: 42 }];
  const mcp = mcpWith(lobby, match.id, { player: projectFor(state, "player") }, { lastSeen: remembered });

  const { body } = await callTool(mcp, "list_entities", { seat_handle });
  const sc = body.result.structuredContent;
  assert.equal(sc.enemy_currently_visible, false, "the fixture's only enemy sits well outside player's fog");
  assert.deepEqual(sc.enemy_last_seen, remembered);
  // The text has to say it too: a recorded match was declared won twice off an empty list.
  assert.match(body.result.content[0].text, /NOT proof they are gone/);
  // And the remembered sighting is never mistaken for a live entity in `entities`.
  assert.equal(sc.entities.find(e => e.id === "u21"), undefined);
});

test("list_entities with since_tick returns only what changed, and says so honestly when it cannot", async () => {
  const { state } = fixture();
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = joinedSeat(lobby, match.id, 0);
  const proj = projectFor(state, "player");
  const movedId = proj.units[0].id;
  const mcp = mcpWith(lobby, match.id, { player: proj },
    { changes: (owner, tick) => (tick === 100 ? { changed: new Set([movedId]), removed: ["u99"] } : null) });

  const { body } = await callTool(mcp, "list_entities", { seat_handle, since_tick: 100 });
  const sc = body.result.structuredContent;
  assert.equal(sc.delta_available, true);
  assert.deepEqual(sc.entities.map(e => e.id), [movedId]);
  assert.deepEqual(sc.removed_ids, ["u99"]);

  // A tick the cache has no history for must return the FULL list flagged as such — an empty
  // delta would read as "nothing changed", which is a different and wrong answer.
  const stale = await callTool(mcp, "list_entities", { seat_handle, since_tick: 5 });
  assert.equal(stale.body.result.structuredContent.delta_available, false);
  assert.ok(stale.body.result.structuredContent.entities.length > 1);
});

test("get_tech_options says WHEN the seat's measured income covers something it cannot afford yet", async () => {
  const { state } = fixture();
  state.players.player.resources.ore = 100;
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = joinedSeat(lobby, match.id, 0);
  const mcp = mcpWith(lobby, match.id, { player: projectFor(state, "player") },
    { income: { per_min: { ore: 300 }, window_seconds: 30 } });

  const { body } = await callTool(mcp, "get_tech_options", { seat_handle });
  const foundry = body.result.structuredContent.buildings.find(b => b.type === "foundry");
  assert.equal(foundry.affordable, false);
  assert.equal(foundry.seconds_until_affordable, 15, "175 ore, 100 in hand, 300/min = 75 ore = 15s");
  const habitat = body.result.structuredContent.buildings.find(b => b.type === "habitat");
  assert.equal(habitat.affordable, true);
  assert.equal(habitat.seconds_until_affordable, undefined, "no ETA on something already affordable");
});

test("get_tech_options gives NO eta for a commodity this seat is not earning at all — 'soon' would be a lie", async () => {
  const { state } = fixture();
  state.players.player.resources.ore = 10;
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = joinedSeat(lobby, match.id, 0);
  const mcp = mcpWith(lobby, match.id, { player: projectFor(state, "player") }, { income: { per_min: { ore: 0 }, window_seconds: 30 } });
  const { body } = await callTool(mcp, "get_tech_options", { seat_handle });
  assert.equal(body.result.structuredContent.buildings.find(b => b.type === "foundry").seconds_until_affordable, undefined);
});

test("estimate_engagement answers the question a counter table cannot: a 1-versus-3 you are losing", async () => {
  const { state } = fixture();
  const base = state.map.bases.player;
  const mine = makeUnit("lancer", "player", base.x, base.y);
  state.units.set(mine.id, mine);
  const theirs = [];
  for (let i = 0; i < 3; i++) {
    // Close enough to sit inside this seat's own fog, so they are legitimately visible to it.
    const enemy = makeUnit("bastion", "ai", base.x + 30 + i * 5, base.y + 10);
    state.units.set(enemy.id, enemy);
    theirs.push(enemy.id);
  }
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = joinedSeat(lobby, match.id, 0);
  const mcp = mcpWith(lobby, match.id, { player: projectFor(state, "player") });

  const { body } = await callTool(mcp, "estimate_engagement", { seat_handle, your_ids: [mine.id], enemy_ids: theirs });
  const sc = body.result.structuredContent;
  assert.equal(sc.predicted_winner, "enemy", "one Lancer loses to three Bastions despite its counter bonus");
  assert.equal(sc.enemy_force, 3);
  assert.match(body.result.content[0].text, /YOU LOSE THIS FIGHT/);

  // The same Lancer against ONE Bastion is the fight the counter table promises.
  const even = await callTool(mcp, "estimate_engagement", { seat_handle, your_ids: [mine.id], enemy_ids: [theirs[0]] });
  assert.equal(even.body.result.structuredContent.predicted_winner, "you");
});

test("estimate_engagement refuses ids this seat cannot see rather than quietly weighing a smaller fight", async () => {
  const { state, hiddenEnemyId } = fixture();
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = joinedSeat(lobby, match.id, 0);
  const mcp = mcpWith(lobby, match.id, { player: projectFor(state, "player") });
  const { body } = await callTool(mcp, "estimate_engagement", { seat_handle, enemy_ids: [hiddenEnemyId] });
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /not-visible/);
});

test("list_entities reports a gatherer's cargo and which leg of the haul it is on", async () => {
  const { state } = fixture();
  const worker = [...state.units.values()].find(u => u.owner === "player" && u.type === "worker");
  const node = state.map.nodes.find(n => n.com === "ore");
  worker.order = { type: "gather", nodeId: node.id, phase: "toDrop" };
  worker.cargo = { com: "ore", qty: 10 };
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = joinedSeat(lobby, match.id, 0);
  const mcp = mcpFor(lobby, match.id, { player: projectFor(state, "player") });

  const { body } = await callTool(mcp, "list_entities", { seat_handle });
  const mine = body.result.structuredContent.entities.find(e => e.id === worker.id);
  // "gathering" alone cannot tell a worker mining from one wedged halfway home with a
  // full hold — these two fields are what make the difference readable.
  assert.equal(mine.activity, "gathering");
  assert.equal(mine.gather_phase, "toDrop");
  assert.deepEqual(mine.cargo, { com: "ore", qty: 10 });
});

test("an enemy gatherer's cargo and haul leg stay hidden — fog does not reveal intent", async () => {
  const { state } = fixture();
  const seen = makeUnit("worker", "ai", state.map.bases.player.x + 20, state.map.bases.player.y + 20);
  seen.order = { type: "gather", nodeId: state.map.nodes[0].id, phase: "toDrop" };
  seen.cargo = { com: "ore", qty: 10 };
  state.units.set(seen.id, seen);
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = joinedSeat(lobby, match.id, 0);
  const mcp = mcpFor(lobby, match.id, { player: projectFor(state, "player") });

  const { body } = await callTool(mcp, "list_entities", { seat_handle });
  const theirs = body.result.structuredContent.entities.find(e => e.id === seen.id);
  assert.ok(theirs, "the unit itself is visible — it is standing in the player's base");
  assert.equal(theirs.cargo, undefined);
  assert.equal(theirs.gather_phase, undefined);
});

/* ============================================================
   get_tech_options narrowing, and estimate_engagement answering under fog. Both come straight out
   of recorded agent matches: the full tech table was being re-read in full to check one unit, and
   the engagement estimate — the one call that would have prevented the decisive loss in three
   recorded matches — was unanswerable at the exact moment it was needed, because the enemy force
   the agent had scouted a minute earlier was no longer visible ("Fog blocks the estimate —
   committing", followed by feeding five Lancers into eight Bastions).
   ============================================================ */

function techFixture() {
  const { state } = fixture();
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = joinedSeat(lobby, match.id, 0);
  return { seat_handle, mcp: mcpWith(lobby, match.id, { player: projectFor(state, "player") }) };
}

test("get_tech_options: `only` narrows the table to the types actually being weighed", async () => {
  const { seat_handle, mcp } = techFixture();
  const full = (await callTool(mcp, "get_tech_options", { seat_handle })).body.result.structuredContent;
  const { body } = await callTool(mcp, "get_tech_options", { seat_handle, only: ["lancer", "foundry"] });
  const sc = body.result.structuredContent;
  assert.deepEqual(sc.units.map(u => u.type), ["lancer"]);
  assert.deepEqual(sc.buildings.map(b => b.type), ["foundry"]);
  assert.ok(full.units.length > 1 && full.buildings.length > 1, "the unfiltered table is genuinely the long one");
  // Narrowing must not change what it SAYS about a type, only how many it reports.
  assert.deepEqual(sc.units[0], full.units.find(u => u.type === "lancer"));
});

test("get_tech_options: an unrecognised name in `only` is reported, never silently dropped", async () => {
  const { seat_handle, mcp } = techFixture();
  const { body } = await callTool(mcp, "get_tech_options", { seat_handle, only: ["lancer", "spinnaker"] });
  const sc = body.result.structuredContent;
  assert.deepEqual(sc.unknown_types, ["spinnaker"]);
  // A typo must not read as "that type exists but is unavailable to you".
  assert.deepEqual(sc.units.map(u => u.type), ["lancer"]);
});

test("get_tech_options: `ready_only` reports just what could be started right now", async () => {
  const { seat_handle, mcp } = techFixture();
  const { body } = await callTool(mcp, "get_tech_options", { seat_handle, ready_only: true });
  const sc = body.result.structuredContent;
  const all = [...sc.units, ...sc.buildings];
  assert.ok(all.length > 0, "a fresh base can start something");
  for (const o of all) {
    assert.equal(o.prereqs_met, true, `${o.type} reported ready without its prereqs`);
    assert.equal(o.affordable, true, `${o.type} reported ready but unaffordable`);
    assert.notEqual(o.buildable, false);
    assert.notEqual(o.supply_blocked, true);
  }
  const full = (await callTool(mcp, "get_tech_options", { seat_handle })).body.result.structuredContent;
  assert.ok(all.length < full.units.length + full.buildings.length, "ready_only actually narrows the table");
});

test("estimate_engagement: enemy_composition answers from a stale scout, with no vision at all", async () => {
  const { state } = fixture();
  const base = state.map.bases.player;
  const mine = [];
  for (let i = 0; i < 5; i++) {
    const u = makeUnit("lancer", "player", base.x + i * 5, base.y);
    state.units.set(u.id, u);
    mine.push(u.id);
  }
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = joinedSeat(lobby, match.id, 0);
  const mcp = mcpWith(lobby, match.id, { player: projectFor(state, "player") });

  // Nothing of the enemy's is visible — exactly the state the losing agent was in.
  const blind = await callTool(mcp, "estimate_engagement", { seat_handle, your_ids: mine });
  assert.equal(blind.body.result.structuredContent.predicted_winner, null);
  assert.match(blind.body.result.content[0].text, /enemy_composition/, "the dead end must name the way out of it");

  // The real fight from the transcript: 5 Lancers into 8 Bastions.
  const { body } = await callTool(mcp, "estimate_engagement", { seat_handle, your_ids: mine, enemy_composition: { bastion: 8 } });
  const sc = body.result.structuredContent;
  assert.equal(sc.predicted_winner, "enemy");
  assert.equal(sc.enemy_force, 8);
  assert.equal(sc.assumed_composition, true);
  assert.match(sc.note, /ASSUMED/);
  // The survivor count is the point: "margin 0.76x" reads as close, "you lose all five" does not.
  assert.equal(sc.your_survivors, 0);
  assert.ok(sc.enemy_survivors > 0, "the side that wins this keeps units");
});

test("estimate_engagement: a remembered composition ADDS to the ids you can still see", async () => {
  const { state } = fixture();
  const base = state.map.bases.player;
  const mine = makeUnit("lancer", "player", base.x, base.y);
  state.units.set(mine.id, mine);
  const seen = makeUnit("bastion", "ai", base.x + 30, base.y + 10);
  state.units.set(seen.id, seen);
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = joinedSeat(lobby, match.id, 0);
  const mcp = mcpWith(lobby, match.id, { player: projectFor(state, "player") });

  const { body } = await callTool(mcp, "estimate_engagement", {
    seat_handle, your_ids: [mine.id], enemy_ids: [seen.id], enemy_composition: { bastion: 2 },
  });
  assert.equal(body.result.structuredContent.enemy_force, 3, "one seen plus two remembered is one force of three");
});

test("estimate_engagement: your_composition weighs an army you have not built yet", async () => {
  const { state } = fixture();
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = joinedSeat(lobby, match.id, 0);
  const mcp = mcpWith(lobby, match.id, { player: projectFor(state, "player") });

  const five = await callTool(mcp, "estimate_engagement", {
    seat_handle, your_ids: [], your_composition: { lancer: 5 }, enemy_composition: { bastion: 8 },
  });
  const twenty = await callTool(mcp, "estimate_engagement", {
    seat_handle, your_ids: [], your_composition: { lancer: 20 }, enemy_composition: { bastion: 8 },
  });
  assert.equal(five.body.result.structuredContent.predicted_winner, "enemy");
  assert.equal(twenty.body.result.structuredContent.predicted_winner, "you", "enough Lancers do beat the wall — the question was always how many");
  assert.ok(twenty.body.result.structuredContent.your_survivors > 0);
});

test("estimate_engagement: an unknown type in a composition is refused, not counted as nothing", async () => {
  const { state } = fixture();
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = joinedSeat(lobby, match.id, 0);
  const mcp = mcpWith(lobby, match.id, { player: projectFor(state, "player") });
  const { body } = await callTool(mcp, "estimate_engagement", { seat_handle, enemy_composition: { bastion: 4, spinnaker: 2 } });
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /unknown-type: spinnaker/);
});
