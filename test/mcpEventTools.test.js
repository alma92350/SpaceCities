import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { createLobby } from "../server/lobby.js";
import { createMcpServer, PROTOCOL_VERSION } from "../net/mcp.js";
import { mintSeatHandle } from "../server/mcpSeatHandle.js";
import { attachProjectionCache } from "../server/mcpObservationCache.js";
import { createEventTools } from "../server/mcpEventTools.js";

/* ============================================================
   T-054 (FR-17): wait_for_event — a thin tool wrapper over server/mcpObservationCache.js's own
   waitForEvent, proven in full (baseline-vs-fixed-snapshot semantics, timeout shape, multi-waiter
   and multi-seat isolation — 7 dedicated cases) in test/mcpObservationCache.test.js already. This
   file's own job is everything ABOVE that mechanism: seat resolution, match-not-live handling,
   timeout clamping, multi-match routing, and the MCP response shape — matching
   test/mcpObservationTools.test.js's own "prove the mechanism, then prove the piece that feeds
   it, separately" split. A fake cache ({waitForEvent: async () => ...}) stands in for the real
   one throughout, except for ONE real end-to-end test against a genuinely spawned
   worker_threads.Worker, which proves the full real pipeline (worker -> cache -> tool -> MCP
   response) never crashes or hangs — deliberately exercised on its DETERMINISTIC branch (nothing
   happens, so it times out cleanly) rather than racing a specific real combat/production event's
   exact timing, since the "resolves on a genuinely new event" claim is already exhaustively proven
   at the cache-mechanism layer above and re-timing it here would only add flakiness, not coverage.
   ============================================================ */

function fakeCache(waitForEvent) {
  return { waitForEvent };
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

function mcpFor(lobby, matchId, cache) {
  return createMcpServer({ tools: createEventTools(lobby, mid => (mid === matchId ? cache : null)) });
}

test("createEventTools registers wait_for_event", () => {
  const tools = createEventTools(createLobby(), () => null);
  assert.deepEqual(tools.map(t => t.name), ["wait_for_event"]);
});

test("a resolved wait passes the cache's own tick/events straight through as structuredContent, never an error", async () => {
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = joinedSeat(lobby, match.id, 0);
  let calledWith = null;
  const cache = fakeCache(async (seat, ms) => { calledWith = { seat, ms }; return { tick: 42, events: [{ type: "attackHit", x: 1, y: 1 }], timedOut: false }; });
  const mcp = mcpFor(lobby, match.id, cache);

  const { body } = await callTool(mcp, "wait_for_event", { seat_handle });
  assert.equal(body.result.isError, undefined, JSON.stringify(body.result));
  assert.deepEqual(body.result.structuredContent, { tick: 42, events: [{ type: "attackHit", x: 1, y: 1 }], timed_out: false });
  assert.equal(calledWith.seat, "player");
});

test("a timed-out wait is reported as a normal (non-error) result with timed_out:true and no events — never a tool execution error", async () => {
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = joinedSeat(lobby, match.id, 0);
  const cache = fakeCache(async () => ({ tick: 10, events: [], timedOut: true }));
  const mcp = mcpFor(lobby, match.id, cache);

  const { body } = await callTool(mcp, "wait_for_event", { seat_handle });
  assert.equal(body.result.isError, undefined, JSON.stringify(body.result));
  assert.deepEqual(body.result.structuredContent, { tick: 10, events: [], timed_out: true });
});

test("an omitted timeout_ms uses the server's own default, never undefined/NaN reaching the cache", async () => {
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = joinedSeat(lobby, match.id, 0);
  let usedMs = null;
  const cache = fakeCache(async (seat, ms) => { usedMs = ms; return { tick: 1, events: [], timedOut: true }; });
  const mcp = mcpFor(lobby, match.id, cache);

  await callTool(mcp, "wait_for_event", { seat_handle });
  assert.equal(typeof usedMs, "number");
  assert.ok(Number.isFinite(usedMs) && usedMs > 0);
});

test("a caller-requested timeout_ms is honoured up to the server's own cap, never beyond it", async () => {
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = joinedSeat(lobby, match.id, 0);
  let usedMs = null;
  const cache = fakeCache(async (seat, ms) => { usedMs = ms; return { tick: 1, events: [], timedOut: true }; });
  const mcp = mcpFor(lobby, match.id, cache);

  await callTool(mcp, "wait_for_event", { seat_handle, timeout_ms: 999999999 });
  assert.ok(usedMs < 999999999, "an absurd requested timeout must be clamped server-side, per this task's own 'bounded well under the client tool-call timeout' exit criterion");

  await callTool(mcp, "wait_for_event", { seat_handle, timeout_ms: 5 });
  assert.equal(usedMs, 5, "a SHORT requested timeout is honoured exactly — the cap only ever lowers an excessive request, never raises a modest one");
});

test("a garbage timeout_ms (negative, NaN-producing, non-number) falls back to the default rather than reaching the cache unclamped", async () => {
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = joinedSeat(lobby, match.id, 0);
  const seen = [];
  const cache = fakeCache(async (seat, ms) => { seen.push(ms); return { tick: 1, events: [], timedOut: true }; });
  const mcp = mcpFor(lobby, match.id, cache);

  await callTool(mcp, "wait_for_event", { seat_handle, timeout_ms: -5 });
  await callTool(mcp, "wait_for_event", { seat_handle, timeout_ms: "soon" });
  for (const ms of seen) assert.ok(Number.isFinite(ms) && ms > 0);
});

test("waiting on a match with no live bridge/cache at all is a clear tool execution error, not a crash or a hang", async () => {
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = joinedSeat(lobby, match.id, 0);
  const mcp = createMcpServer({ tools: createEventTools(lobby, () => null) });

  const { body } = await callTool(mcp, "wait_for_event", { seat_handle });
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /match-not-live/);
});

test("an invalid seat_handle is rejected as a tool execution error, never a crash", async () => {
  const mcp = createMcpServer({ tools: createEventTools(createLobby(), () => null) });
  const { body } = await callTool(mcp, "wait_for_event", { seat_handle: "garbage" });
  assert.equal(body.result.isError, true);
});

test("multi-match routing: a seat in match A can never wait on match B's own cache", async () => {
  const lobby = createLobby();
  const matchA = lobby.createMatch({ seatKinds: ["open", "open"] });
  const matchB = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seatA = joinedSeat(lobby, matchA.id, 0);

  let cacheBCalled = false;
  const cacheA = fakeCache(async () => ({ tick: 1, events: [], timedOut: true }));
  const cacheB = fakeCache(async () => { cacheBCalled = true; return { tick: 1, events: [], timedOut: true }; });
  const mcp = createMcpServer({
    tools: createEventTools(lobby, matchId => {
      if (matchId === matchA.id) return cacheA;
      if (matchId === matchB.id) return cacheB;
      return null;
    }),
  });

  await callTool(mcp, "wait_for_event", { seat_handle: seatA });
  assert.equal(cacheBCalled, false, "a seat in match A must never reach match B's own cache");
  void matchB;
});

/* ============================================================
   REAL end to end, against a genuinely spawned worker — mirrors test/mcpActionTools.test.js's own
   spawnLiveMatch/waitFor helpers exactly, proving the real pipeline (worker -> real
   attachProjectionCache -> createEventTools -> net/mcp.js) never crashes or hangs. Deliberately
   exercises the TIMEOUT branch (see this file's own header for why): fast, fully deterministic,
   and still a genuine end-to-end proof of the plumbing this task's own row is about.
   ============================================================ */

const WORKER_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "server", "matchWorker.js");

function waitForMsg(worker, pred, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("waitFor timed out")), timeoutMs);
    const onMsg = msg => { if (pred(msg)) { clearTimeout(timer); worker.off("message", onMsg); resolve(msg); } };
    worker.on("message", onMsg);
  });
}

test("REAL end to end: wait_for_event against a real spawned worker resolves cleanly with timed_out:true when nothing new happens", async () => {
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat0 = lobby.joinMatch(match.id, 0);
  const seat_handle = mintSeatHandle(match.id, 0, seat0.token);
  const worker = new Worker(WORKER_FILE, { workerData: { matchId: match.id, createGameStateOpts: { planetId: "ferros", seed: 13131 } } });
  try {
    await waitForMsg(worker, m => m.type === "ready");
    await waitForMsg(worker, m => m.type === "state" && m.seat === "player");
    const cache = attachProjectionCache(worker);
    const mcp = createMcpServer({ tools: createEventTools(lobby, () => cache) });

    const { body } = await callTool(mcp, "wait_for_event", { seat_handle, timeout_ms: 300 });
    assert.equal(body.result.isError, undefined, JSON.stringify(body.result));
    assert.equal(body.result.structuredContent.timed_out, true);
    assert.deepEqual(body.result.structuredContent.events, []);
  } finally {
    await worker.terminate();
  }
});
