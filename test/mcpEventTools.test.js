import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { createLobby } from "../server/lobby.js";
import { createMcpServer, PROTOCOL_VERSION } from "../net/mcp.js";
import { mintSeatHandle, mintWatchHandle } from "../server/mcpSeatHandle.js";
import { SPECTATOR_SEAT } from "../engine/projection.js";
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
  const sc = body.result.structuredContent;
  assert.equal(sc.tick, 42);
  assert.deepEqual(sc.events, [{ type: "attackHit", x: 1, y: 1 }]);
  assert.equal(sc.timed_out, false);
  // The summary is a DIGEST of those same events, never a substitute for them — an attackHit on
  // nobody in particular is combat, but it is not this seat being attacked (no targetOwner).
  assert.deepEqual(sc.summary, { by_type: { attackHit: 1 }, groups: ["combat"], under_attack: false });
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
  assert.deepEqual(body.result.structuredContent, {
    tick: 10, events: [], timed_out: true,
    summary: { by_type: {}, groups: [], under_attack: false },
  });
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

/* ============================================================
   The NOTIFICATION half of wait_for_event: a `summary` that answers "am I being attacked, and did
   anything of mine finish" without the caller parsing raw engine events, and `types`/`groups`
   filters so an agent can sleep through everything that is not the thing it is waiting for.
   ============================================================ */

test("summary flags an attack on THIS seat's own entity — with which entity, and where", async () => {
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = joinedSeat(lobby, match.id, 0);
  const events = [
    { type: "attackHit", x: 30, y: 40, sourceId: "u9", targetId: "u2", targetOwner: "player", owner: "ai" },
    { type: "buildingComplete", id: "b7", buildingType: "barracks", owner: "player" },
  ];
  const mcp = mcpFor(lobby, match.id, fakeCache(async () => ({ tick: 5, events, timedOut: false })));

  const { body } = await callTool(mcp, "wait_for_event", { seat_handle });
  const { summary } = body.result.structuredContent;
  assert.equal(summary.under_attack, true);
  assert.deepEqual(summary.attacked, [{ id: "u2", x: 30, y: 40, attacker_id: "u9" }]);
  assert.deepEqual(summary.completed, [{ type: "buildingComplete", id: "b7", entity_type: "barracks" }]);
  assert.deepEqual(summary.groups, ["combat", "construction"]);
  assert.match(body.result.content[0].text, /UNDER ATTACK/);
});

test("my own attack landing on the ENEMY is combat, but it is not me being attacked", async () => {
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = joinedSeat(lobby, match.id, 0);
  const mcp = mcpFor(lobby, match.id, fakeCache(async () => ({
    tick: 5, timedOut: false,
    events: [{ type: "attackHit", x: 1, y: 1, sourceId: "u1", targetId: "e1", targetOwner: "ai", owner: "player" }],
  })));

  const { summary } = (await callTool(mcp, "wait_for_event", { seat_handle })).body.result.structuredContent;
  assert.equal(summary.under_attack, false);
  assert.deepEqual(summary.groups, ["combat"]);
  assert.equal(summary.attacked, undefined);
});

test("types filters what comes back AND keeps waiting through events the caller asked to ignore", async () => {
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = joinedSeat(lobby, match.id, 0);
  // Two rounds: the first carries only an ignored type, the second the one actually wanted. A
  // filter applied only to the RESULT would return an empty list after round one — turning "wake
  // me for a fight" into a busy loop that reports nothing happened while a fight was starting.
  const rounds = [
    { tick: 1, events: [{ type: "unitIdle", id: "u4", owner: "player" }], timedOut: false },
    { tick: 2, events: [{ type: "entityKilled", id: "u2", owner: "player", killerId: "e1", x: 5, y: 6 }], timedOut: false },
  ];
  let calls = 0;
  const mcp = mcpFor(lobby, match.id, fakeCache(async () => rounds[calls++] ?? { tick: 9, events: [], timedOut: true }));

  const { body } = await callTool(mcp, "wait_for_event", { seat_handle, types: ["entityKilled"] });
  const sc = body.result.structuredContent;
  assert.equal(calls, 2, "the ignored round must not end the wait");
  assert.equal(sc.timed_out, false);
  assert.deepEqual(sc.events.map(e => e.type), ["entityKilled"]);
  assert.equal(sc.summary.under_attack, true, "losing my own entity counts as being attacked");
});

test("groups is the coarse form of types — 'construction' wakes for a finished building, not for a fight", async () => {
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = joinedSeat(lobby, match.id, 0);
  const rounds = [
    { tick: 1, events: [{ type: "attackHit", x: 0, y: 0, targetOwner: "ai", sourceId: "u1", targetId: "e1" }], timedOut: false },
    { tick: 2, events: [{ type: "buildingComplete", id: "b1", buildingType: "refinery", owner: "player" }], timedOut: false },
  ];
  let calls = 0;
  const mcp = mcpFor(lobby, match.id, fakeCache(async () => rounds[calls++] ?? { tick: 9, events: [], timedOut: true }));

  const sc = (await callTool(mcp, "wait_for_event", { seat_handle, groups: ["construction"] })).body.result.structuredContent;
  assert.deepEqual(sc.events.map(e => e.type), ["buildingComplete"]);
  assert.deepEqual(sc.summary.completed, [{ type: "buildingComplete", id: "b1", entity_type: "refinery" }]);
});

test("a filtered wait that never sees its event times out normally rather than spinning or erroring", async () => {
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = joinedSeat(lobby, match.id, 0);
  let calls = 0;
  // Every round carries something — just never the wanted type. The wait must end on its own
  // deadline, not keep re-waiting forever.
  const mcp = mcpFor(lobby, match.id, fakeCache(async () => {
    calls++;
    return { tick: calls, events: [{ type: "unitIdle", id: "u1", owner: "player" }], timedOut: false };
  }));

  const { body } = await callTool(mcp, "wait_for_event", { seat_handle, types: ["entityKilled"], timeout_ms: 60 });
  assert.equal(body.result.isError, undefined);
  assert.equal(body.result.structuredContent.timed_out, true);
  assert.deepEqual(body.result.structuredContent.events, []);
});

test("a WATCH handle can wait on a match's events, and gets counts with no 'mine' to resolve", async () => {
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  let askedSeat = null;
  const mcp = mcpFor(lobby, match.id, fakeCache(async seat => {
    askedSeat = seat;
    return { tick: 3, events: [{ type: "attackHit", x: 1, y: 1, targetOwner: "player", sourceId: "e1", targetId: "u1" }], timedOut: false };
  }));

  const { body } = await callTool(mcp, "wait_for_event", { seat_handle: mintWatchHandle(match.id) });
  assert.equal(body.result.isError, undefined, JSON.stringify(body.result));
  assert.equal(askedSeat, SPECTATOR_SEAT, "a watcher waits on the unfiltered spectator stream");
  const { summary } = body.result.structuredContent;
  assert.deepEqual(summary.by_type, { attackHit: 1 });
  assert.equal(summary.under_attack, false, "a watcher owns nothing, so nothing being hit is theirs");
});

/* ============================================================
   Agent-observability: two additions to the waiting loop itself — a wait that ends on a RESOURCE
   THRESHOLD (nothing in the engine fires when a treasury crosses a number, so an agent had no
   choice but to ask, be refused, and ask again), and take_turn, which folds the wait and the
   situation read that always follows it into one round trip.
   ============================================================ */

function cacheWithResources(getResources, waitForEvent) {
  return {
    waitForEvent: waitForEvent ?? (async (seat, ms) => { await new Promise(r => setTimeout(r, Math.min(ms, 50))); return { tick: 7, events: [], timedOut: true }; }),
    latestProjFor: owner => ({ tick: 7, players: { [owner]: { resources: getResources() } } }),
  };
}

test("wait_for_event with wake_on returns AT ONCE when the threshold is already met", async () => {
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = joinedSeat(lobby, match.id, 0);
  const mcp = mcpFor(lobby, match.id, cacheWithResources(() => ({ ore: 300 })));

  const { body } = await callTool(mcp, "wait_for_event", { seat_handle, wake_on: { ore: 175 }, timeout_ms: 5000 });
  assert.equal(body.result.isError, undefined);
  assert.equal(body.result.structuredContent.resources_reached, true);
  assert.equal(body.result.structuredContent.timed_out, false);
});

test("wait_for_event with wake_on sleeps through the shortfall and wakes on the crossing", async () => {
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = joinedSeat(lobby, match.id, 0);
  let ore = 100;
  const mcp = mcpFor(lobby, match.id, cacheWithResources(() => ({ ore })));
  setTimeout(() => { ore = 200; }, 250);

  const started = Date.now();
  const { body } = await callTool(mcp, "wait_for_event", { seat_handle, wake_on: { ore: 175 }, timeout_ms: 5000 });
  assert.equal(body.result.structuredContent.resources_reached, true);
  assert.ok(Date.now() - started >= 200, "it must actually have waited, not returned on the first poll");
});

test("a wait asked ONLY for a resource threshold is not ended by an unrelated event", async () => {
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = joinedSeat(lobby, match.id, 0);
  let ore = 100;
  // The cache is chattering with events the caller never asked about.
  const noisy = async () => ({ tick: 9, events: [{ type: "unitSpawned", owner: "player", id: "u9" }], timedOut: false });
  const mcp = mcpFor(lobby, match.id, cacheWithResources(() => ({ ore }), noisy));
  setTimeout(() => { ore = 200; }, 200);

  const { body } = await callTool(mcp, "wait_for_event", { seat_handle, wake_on: { ore: 175 }, timeout_ms: 4000 });
  assert.equal(body.result.structuredContent.resources_reached, true, "the unrelated spawn must not have ended this wait");
});

test("wake_on times out normally (never an error) when the threshold is never reached", async () => {
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = joinedSeat(lobby, match.id, 0);
  const mcp = mcpFor(lobby, match.id, cacheWithResources(() => ({ ore: 10 })));
  const { body } = await callTool(mcp, "wait_for_event", { seat_handle, wake_on: { ore: 175 }, timeout_ms: 300 });
  assert.equal(body.result.isError, undefined);
  assert.equal(body.result.structuredContent.timed_out, true);
  assert.equal(body.result.structuredContent.resources_reached, undefined);
});

test("take_turn returns the wait AND the resulting situation in one call — the state AFTER the events", async () => {
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = joinedSeat(lobby, match.id, 0);
  const cache = cacheWithResources(() => ({ ore: 10 }), async () => ({ tick: 12, events: [{ type: "unitSpawned", owner: "player", id: "u9" }], timedOut: false }));
  // The registered get_situation handler, stood in for here the same way the cache is: take_turn's
  // own claim is that it CALLS it and merges the two answers, not what that handler computes.
  const getSituation = async ({ seat_handle: h }) => ({
    content: [{ type: "text", text: "Tick 12. 4 units (1 idle), 2 buildings." }],
    structuredContent: { tick: 12, handle_seen: h, units_by_type: { worker: 4 }, idle_unit_ids: ["u3"] },
  });
  const mcp = createMcpServer({ tools: createEventTools(lobby, mid => (mid === match.id ? cache : null), getSituation) });

  const { body } = await callTool(mcp, "take_turn", { seat_handle, timeout_ms: 500 });
  const sc = body.result.structuredContent;
  assert.equal(sc.tick, 12);
  assert.deepEqual(sc.units_by_type, { worker: 4 });
  assert.deepEqual(sc.idle_unit_ids, ["u3"]);
  assert.equal(sc.events.length, 1);
  assert.equal(sc.summary.by_type.unitSpawned, 1);
  assert.equal(sc.handle_seen, seat_handle, "the same seat drives both halves");
  assert.match(body.result.content[0].text, /4 units/);
});

test("take_turn is not registered at all when no get_situation handler was supplied", () => {
  const tools = createEventTools(createLobby(), () => null);
  assert.equal(tools.find(t => t.name === "take_turn"), undefined);
  assert.ok(createEventTools(createLobby(), () => null, async () => ({})).find(t => t.name === "take_turn"));
});

test("take_turn surfaces a bad handle as the error it is, rather than asking for a situation on top of it", async () => {
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  let situationCalls = 0;
  const mcp = createMcpServer({
    tools: createEventTools(lobby, () => cacheWithResources(() => ({})), async () => { situationCalls++; return {}; }),
  });
  const { body } = await callTool(mcp, "take_turn", { seat_handle: "garbage" });
  assert.equal(body.result.isError, true);
  assert.equal(situationCalls, 0);
  void match;
});
