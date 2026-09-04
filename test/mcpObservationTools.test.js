import { test } from "node:test";
import assert from "node:assert/strict";
import { createLobby } from "../server/lobby.js";
import { createGameState, makeUnit, makeBuilding } from "../engine/state.js";
import { projectFor } from "../engine/projection.js";
import { createMcpServer, PROTOCOL_VERSION } from "../net/mcp.js";
import { mintSeatHandle } from "../server/mcpSeatHandle.js";
import { createObservationTools } from "../server/mcpObservationTools.js";

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

function fakeCache(projByOwner) {
  return { latestProjFor: owner => projByOwner[owner] ?? null };
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

function mcpFor(lobby, matchId, projByOwner) {
  const cache = fakeCache(projByOwner);
  return createMcpServer({ tools: createObservationTools(lobby, mId => (mId === matchId ? cache : null)) });
}

test("createObservationTools registers exactly the four named tools", () => {
  const tools = createObservationTools(createLobby(), () => null);
  assert.deepEqual(tools.map(t => t.name).sort(), ["get_map_overview", "get_situation", "get_tech_options", "list_entities"]);
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

test("list_entities: trims each entity down to id/type/owner/x/y/hp — never the raw engine object's order/orderQueue/homeCC/etc.", async () => {
  const { state } = fixture();
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = joinedSeat(lobby, match.id, 0);
  const mcp = mcpFor(lobby, match.id, { player: projectFor(state, "player") });

  const { body } = await callTool(mcp, "list_entities", { seat_handle });
  const entity = body.result.structuredContent.entities[0];
  assert.deepEqual(Object.keys(entity).sort(), ["hp", "id", "owner", "type", "x", "y"]);
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
  for (const name of ["get_situation", "list_entities", "get_map_overview", "get_tech_options"]) {
    const { status, body } = await callTool(mcp, name, { seat_handle: "garbage" });
    assert.equal(status, 200, `${name}: a bad handle is a tool execution error, not an HTTP-level failure`);
    assert.equal(body.result.isError, true, `${name} must reject a garbage handle`);
  }
});
