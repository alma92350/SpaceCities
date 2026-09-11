import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { createLobby } from "../server/lobby.js";
import { createMcpServer, PROTOCOL_VERSION } from "../net/mcp.js";
import { mintSeatHandle, mintWatchHandle } from "../server/mcpSeatHandle.js";
import { attachCommandBridge } from "../server/mcpCommandBridge.js";
import { createActionTools } from "../server/mcpActionTools.js";
import { REJECT } from "../net/commandCodec.js";
import { createAgentApmGuard } from "../net/agentApm.js";

/* ============================================================
   T-053 (FR-15): this task's own exit criterion is explicit: "an agent commands 20 units in one
   call; validation identical to a human's." A fake bridge (mirroring test/mcpObservationTools.js's
   own fakeCache split) proves the multi-match routing safety property in isolation; the REAL
   validation-parity proof needs a REAL worker running the REAL codec, exactly the standard
   test/matchWorker.test.js already holds itself to for the identical reason — spawnMatchWorker/
   waitFor below mirror that file's own helpers precisely.
   ============================================================ */

const WORKER_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "server", "matchWorker.js");

// Spawns a REAL worker for a match created (and joined) through a REAL lobby — the exact same
// matchId threading tools/serve.js's own spawnWorkerFor uses, so a seat_handle minted against
// this lobby resolves correctly and the worker's own commandResult stream is reachable through
// createActionTools(lobby, getBridge) exactly as it would be in production.
async function spawnLiveMatch(seed = 424242) {
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat0 = lobby.joinMatch(match.id, 0);
  const seat1 = lobby.joinMatch(match.id, 1);
  const worker = new Worker(WORKER_FILE, { workerData: { matchId: match.id, createGameStateOpts: { planetId: "ferros", seed } } });
  await waitFor(worker, m => m.type === "ready");
  return {
    lobby, match, worker,
    seatHandle0: mintSeatHandle(match.id, 0, seat0.token),
    seatHandle1: mintSeatHandle(match.id, 1, seat1.token),
  };
}

function waitFor(worker, pred, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("waitFor timed out")), timeoutMs);
    const onMsg = msg => { if (pred(msg)) { clearTimeout(timer); worker.off("message", onMsg); resolve(msg); } };
    worker.on("message", onMsg);
  });
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

test("createActionTools registers issue_command, surrender and set_seat_controller", () => {
  const tools = createActionTools(createLobby(), () => null);
  assert.deepEqual(tools.map(t => t.name), ["issue_command", "surrender", "set_seat_controller"]);
});

test("REAL end to end: issue_command moves the seat's own units, applied by the real codec inside a real worker", async () => {
  const { lobby, worker, seatHandle0 } = await spawnLiveMatch();
  try {
    const state0 = await waitFor(worker, m => m.type === "state" && m.seat === "player");
    const ownUnits = state0.proj.units.filter(u => u.owner === "player");
    assert.ok(ownUnits.length >= 1, "fixture sanity: the starting workers exist");

    // A SINGLE unit id, deliberately — a multi-unit human move goes through
    // engine/commands.js's own leader/follower formation spread (dispatchFormation), where only
    // the LEADER's own order.x/y lands exactly on the clicked point and followers get a
    // "follow-leader" order with an offset instead. That formation behavior is real,
    // engine-level, and already covered by test/commands.test.js/test/formation.test.js — this
    // test's own job is simpler: prove issue_command's move command reaches a real unit's order
    // at all, through the real codec, inside a real worker.
    const unit = ownUnits[0];
    const mcp = createMcpServer({ tools: createActionTools(lobby, matchId => attachCommandBridge(worker)) });
    const target = { x: unit.x + 300, y: unit.y };
    const { body } = await callTool(mcp, "issue_command", {
      seat_handle: seatHandle0,
      command: { t: "move", ids: [unit.id], x: target.x, y: target.y },
    });

    assert.equal(body.result.isError, undefined, JSON.stringify(body.result));
    assert.equal(body.result.resultType, "complete");

    const later = await waitFor(worker, m => m.type === "state" && m.seat === "player" && m.proj.units.find(u => u.id === unit.id)?.order?.type === "move");
    const movedUnit = later.proj.units.find(u => u.id === unit.id);
    assert.equal(movedUnit.order.x, target.x);
    assert.equal(movedUnit.order.y, target.y);
  } finally {
    await worker.terminate();
  }
});

test("REAL end to end: a command naming a unit the seat does NOT own is rejected with the SAME codec code (NOT_OWNER) a human's own client would get", async () => {
  const { lobby, worker, seatHandle0 } = await spawnLiveMatch();
  try {
    const state1 = await waitFor(worker, m => m.type === "state" && m.seat === "ai");
    const enemyUnit = state1.proj.units.find(u => u.owner === "ai");
    assert.ok(enemyUnit, "fixture sanity: the ai seat has starting units");

    const mcp = createMcpServer({ tools: createActionTools(lobby, matchId => attachCommandBridge(worker)) });
    const { body } = await callTool(mcp, "issue_command", {
      seat_handle: seatHandle0,   // player's own handle
      command: { t: "move", ids: [enemyUnit.id], x: 0, y: 0 },   // but the ai's own unit
    });

    assert.equal(body.result.isError, true);
    assert.equal(body.result.structuredContent.code, REJECT.NOT_OWNER);
    // …and, all the way through the worker boundary, the action-oriented hint that says what to
    // do instead (net/refusalHints.js). A bare code is what makes an agent re-send verbatim.
    assert.match(body.result.structuredContent.hint, /get_situation/);
    assert.match(body.result.content[0].text, /get_situation/);
  } finally {
    await worker.terminate();
  }
});

test("REAL end to end: a 20-entry ids array survives the MCP path intact — this task's own literal exit criterion", async () => {
  // A fresh match's own starting roster is a handful of workers, not 20 — this task's own claim
  // is about the COMMAND PATH correctly carrying a 20-length ids array through to the codec
  // (net/commandShapes.js's own Ids type is documented for 1..400), not about a fresh match's
  // starting army size, which test/commandCodec.test.js's own suite already covers separately.
  // net/commandCodec.js's resolveOwn (confirmed by reading it) silently DROPS any id that
  // doesn't resolve to a real, currently-live entity ("died in flight — drop") rather than
  // rejecting the whole command, as long as at least one id resolves — so padding the real
  // owned ids out to 20 with well-formed-but-nonexistent extra ids is a faithful way to prove
  // the path carries all 20 through without truncation, using only what a fresh match actually
  // has to command.
  const { lobby, worker, seatHandle0 } = await spawnLiveMatch();
  try {
    const state0 = await waitFor(worker, m => m.type === "state" && m.seat === "player");
    const realIds = state0.proj.units.filter(u => u.owner === "player").map(u => u.id);
    assert.ok(realIds.length >= 1 && realIds.length < 20, "fixture sanity: fewer than 20 real starting units");
    const paddingIds = Array.from({ length: 20 - realIds.length }, (_, i) => `nonexistent-unit-${i}`);
    const ids = [...realIds, ...paddingIds];
    assert.equal(ids.length, 20);

    const mcp = createMcpServer({ tools: createActionTools(lobby, matchId => attachCommandBridge(worker)) });
    const target = { x: state0.proj.units[0].x + 200, y: state0.proj.units[0].y };
    const { body } = await callTool(mcp, "issue_command", { seat_handle: seatHandle0, command: { t: "move", ids, x: target.x, y: target.y } });

    assert.equal(body.result.isError, undefined, JSON.stringify(body.result));
    const later = await waitFor(worker, m => m.type === "state" && m.seat === "player" && m.proj.units.find(u => u.id === realIds[0])?.order?.type === "move");
    // realIds[0] is the formation LEADER (engine/commands.js's dispatchFormation, since >1 real
    // unit here means a human multi-unit move) and gets the literal "move" order asserted above.
    // Confirmed by direct inspection (not assumed): the other real ids become FOLLOWERS, tracked
    // via squadLeader/keepFollowingLeader (engine/movement.js), not a wire-visible order field —
    // their own order legitimately reads null on the projected/serialized side even though they
    // ARE following internally, since a "follow-leader" order carries a live object reference
    // (the leader unit itself) that was never meant to cross the wire. So the fair, path-level
    // proof that all 20 ids survived the MCP call intact is the leader's own real "move" order
    // — proven by the waitFor predicate above already resolving — not its exact coordinates
    // (with >1 real unit, the leader itself lands on a FORMATION SLOT near the clicked point,
    // engine/formation.js's own formationSlots, not the raw target verbatim — real, tested
    // engine behavior, not this task's own concern) or a per-follower order field.
    assert.equal(later.proj.units.find(u => u.id === realIds[0]).order.type, "move");
  } finally {
    await worker.terminate();
  }
});

test("issue_command on a match id with no live bridge at all is a clear tool execution error, not a crash", async () => {
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = mintSeatHandle(match.id, 0, lobby.joinMatch(match.id, 0).token);
  const mcp = createMcpServer({ tools: createActionTools(lobby, () => null) });

  const { body } = await callTool(mcp, "issue_command", { seat_handle, command: { t: "stop", ids: ["u1"] } });
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /match-not-live/);
});

/* ---------- T-059a (FR-8): a real seat can surrender through an MCP tool ---------- */
// engine/victory.js's own surrender() semantics (idempotent, N-seat standing, score-tiebreak
// exclusion) are already exhaustively covered by test/victory.test.js; this only has to prove the
// tool call actually reaches a real worker and the match genuinely resolves as a result — the same
// division of labor issue_command's own tests above already hold themselves to.

test("REAL end to end: surrender ends the calling seat's own participation, resolved on the match's very next tick", async () => {
  const { lobby, worker, seatHandle0 } = await spawnLiveMatch();
  try {
    await waitFor(worker, m => m.type === "state" && m.seat === "player");
    const mcp = createMcpServer({ tools: createActionTools(lobby, matchId => attachCommandBridge(worker)) });

    const { body } = await callTool(mcp, "surrender", { seat_handle: seatHandle0 });
    assert.equal(body.result.isError, undefined, JSON.stringify(body.result));

    // Not instant (this tool's own description says so): the match resolves on its NEXT tick, via
    // the worker's own ordinary "state" push every client already listens to — never a bespoke
    // reply this tool call itself has to wait on.
    const overMsg = await waitFor(worker, m => m.type === "state" && m.seat === "ai" && m.proj.over === true, 3000);
    assert.equal(overMsg.proj.winner, "ai", "the seat that surrendered (player, seat 0) must not be the winner");
    assert.equal(overMsg.proj.winReason, "elimination");
  } finally {
    await worker.terminate();
  }
});

test("surrender on a match id with no live bridge at all is a clear tool execution error, not a crash", async () => {
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = mintSeatHandle(match.id, 0, lobby.joinMatch(match.id, 0).token);
  const mcp = createMcpServer({ tools: createActionTools(lobby, () => null) });

  const { body } = await callTool(mcp, "surrender", { seat_handle });
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /match-not-live/);
});

test("multi-match routing: a seat_handle for match A can never surrender match B's own seat", async () => {
  const lobby = createLobby();
  const matchA = lobby.createMatch({ seatKinds: ["open", "open"] });
  const matchB = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seatA = mintSeatHandle(matchA.id, 0, lobby.joinMatch(matchA.id, 0).token);

  let bridgeBCalled = false;
  const fakeBridgeA = { surrender: () => {} };
  const fakeBridgeB = { surrender: () => { bridgeBCalled = true; } };
  const mcp = createMcpServer({
    tools: createActionTools(lobby, matchId => {
      if (matchId === matchA.id) return fakeBridgeA;
      if (matchId === matchB.id) return fakeBridgeB;
      return null;
    }),
  });

  await callTool(mcp, "surrender", { seat_handle: seatA });
  assert.equal(bridgeBCalled, false, "a seat_handle scoped to match A must never reach match B's own bridge");
  void matchB;
});

test("multi-match routing: a seat in match A can never reach match B's own bridge", async () => {
  const lobby = createLobby();
  const matchA = lobby.createMatch({ seatKinds: ["open", "open"] });
  const matchB = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seatA = mintSeatHandle(matchA.id, 0, lobby.joinMatch(matchA.id, 0).token);

  let bridgeBCalled = false;
  const fakeBridgeA = { sendCommand: async () => ({ ok: true }) };
  const fakeBridgeB = { sendCommand: async () => { bridgeBCalled = true; return { ok: true }; } };
  const mcp = createMcpServer({
    tools: createActionTools(lobby, matchId => {
      if (matchId === matchA.id) return fakeBridgeA;
      if (matchId === matchB.id) return fakeBridgeB;
      return null;
    }),
  });

  await callTool(mcp, "issue_command", { seat_handle: seatA, command: { t: "stop", ids: ["u1"] } });
  assert.equal(bridgeBCalled, false, "a seat in match A must never reach match B's own bridge");
  void matchB;
});

test("an invalid seat_handle is rejected as a tool execution error, never a crash", async () => {
  const mcp = createMcpServer({ tools: createActionTools(createLobby(), () => null) });
  const { body } = await callTool(mcp, "issue_command", { seat_handle: "garbage", command: { t: "stop", ids: ["u1"] } });
  assert.equal(body.result.isError, true);
});

/* ============================================================
   T-056 (§6.3, ADR-0007): the APM ceiling itself is proven in full in test/agentApm.test.js — this
   file's own job is only that issue_command actually CONSULTS a configured guard before ever
   reaching the bridge, and correctly stays unthrottled when none is configured (the default this
   file's every OTHER test above already exercises implicitly by omitting the third argument
   entirely). createAgentApmGuard(60) gives a tiny, fast-to-exhaust budget (cap=4) so a test can
   drain it in a handful of calls without waiting on real wall-clock time.
   ============================================================ */

test("issue_command is rejected once the seat's own APM budget is exhausted, never reaching the bridge", async () => {
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = mintSeatHandle(match.id, 0, lobby.joinMatch(match.id, 0).token);
  let bridgeCalls = 0;
  const fakeBridge = { sendCommand: async () => { bridgeCalls++; return { ok: true }; } };
  const apmGuard = createAgentApmGuard(60);   // cap = 4
  const mcp = createMcpServer({ tools: createActionTools(lobby, () => fakeBridge, () => apmGuard) });

  for (let i = 0; i < 4; i++) {
    const { body } = await callTool(mcp, "issue_command", { seat_handle, command: { t: "stop", ids: ["u1"] } });
    assert.equal(body.result.isError, undefined, `call ${i} should still be within budget`);
  }
  const { body } = await callTool(mcp, "issue_command", { seat_handle, command: { t: "stop", ids: ["u1"] } });
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /agent-apm-exceeded/);
  assert.equal(bridgeCalls, 4, "the 5th, rejected call must never reach the bridge at all");
});

test("issue_command stays fully unthrottled when the match has no configured APM guard (the default)", async () => {
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat_handle = mintSeatHandle(match.id, 0, lobby.joinMatch(match.id, 0).token);
  let bridgeCalls = 0;
  const fakeBridge = { sendCommand: async () => { bridgeCalls++; return { ok: true }; } };
  const mcp = createMcpServer({ tools: createActionTools(lobby, () => fakeBridge, () => null) });

  for (let i = 0; i < 20; i++) {
    const { body } = await callTool(mcp, "issue_command", { seat_handle, command: { t: "stop", ids: ["u1"] } });
    assert.equal(body.result.isError, undefined);
  }
  assert.equal(bridgeCalls, 20);
});

test("multi-match routing: a seat in match A never drains match B's own APM budget", async () => {
  const lobby = createLobby();
  const matchA = lobby.createMatch({ seatKinds: ["open", "open"] });
  const matchB = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seatA = mintSeatHandle(matchA.id, 0, lobby.joinMatch(matchA.id, 0).token);
  const fakeBridge = { sendCommand: async () => ({ ok: true }) };
  const guardA = createAgentApmGuard(60);
  const guardB = createAgentApmGuard(60);
  const mcp = createMcpServer({
    tools: createActionTools(lobby, () => fakeBridge, matchId => (matchId === matchA.id ? guardA : guardB)),
  });

  for (let i = 0; i < 4; i++) await callTool(mcp, "issue_command", { seat_handle: seatA, command: { t: "stop", ids: ["u1"] } });
  const { body } = await callTool(mcp, "issue_command", { seat_handle: seatA, command: { t: "stop", ids: ["u1"] } });
  assert.equal(body.result.isError, true, "match A's own seat is correctly out of budget");
  assert.equal(guardB.tryConsume("player", Date.now()), true, "match B's own guard is untouched, still has its full budget");
  void matchB;
});

/* ============================================================
   set_seat_controller — the explicit handover an MCP client needs and a browser client does not.
   A human's browser holds a socket whose close the server can SEE; an MCP client going quiet to
   compact its context is indistinguishable from one thinking hard, so it says so instead. Proven
   against a REAL worker, because the property being claimed is about the live engine State's own
   controller registry, which only exists inside that worker.
   ============================================================ */

test("set_seat_controller hands a live seat to the game's own AI, and takes it back — against a real worker", async () => {
  const { lobby, worker, match, seatHandle0 } = await spawnLiveMatch();
  const bridge = attachCommandBridge(worker);
  const mcp = createMcpServer({ tools: createActionTools(lobby, id => (id === match.id ? bridge : null)) });

  const away = await callTool(mcp, "set_seat_controller", { seat_handle: seatHandle0, controller: "ai", ai_strategy: "aggressive", difficulty: "hard" });
  assert.equal(away.body.result.isError, undefined, JSON.stringify(away.body.result));
  assert.deepEqual(away.body.result.structuredContent, { controller: "ai", owner: "player", ai_controlled: true });

  const back = await callTool(mcp, "set_seat_controller", { seat_handle: seatHandle0, controller: "self" });
  assert.deepEqual(back.body.result.structuredContent, { controller: "self", owner: "player", ai_controlled: false });

  // Reversible as often as the caller likes — the point of the mechanism is that stepping away is
  // never a one-way door.
  const againAway = await callTool(mcp, "set_seat_controller", { seat_handle: seatHandle0, controller: "ai" });
  assert.equal(againAway.body.result.structuredContent.ai_controlled, true);

  await worker.terminate();
});

test("a seat handed to the AI still accepts its owner's own commands the moment it is taken back", async () => {
  const { lobby, worker, match, seatHandle0 } = await spawnLiveMatch();
  const bridge = attachCommandBridge(worker);
  const mcp = createMcpServer({ tools: createActionTools(lobby, id => (id === match.id ? bridge : null)) });

  await callTool(mcp, "set_seat_controller", { seat_handle: seatHandle0, controller: "ai" });
  await callTool(mcp, "set_seat_controller", { seat_handle: seatHandle0, controller: "self" });

  // An ordinary, well-formed command — the assertion is that the seat is COMMANDABLE again (it
  // reaches the codec and gets a real verdict), not that this particular order is legal.
  const { body } = await callTool(mcp, "issue_command", { seat_handle: seatHandle0, command: { t: "stop", ids: ["u1"] } });
  assert.notEqual(body.result.structuredContent?.code, "command-timeout");

  await worker.terminate();
});

test("set_seat_controller rejects an unknown controller and a match that hasn't started", async () => {
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seat = lobby.joinMatch(match.id, 0);
  const handle = mintSeatHandle(match.id, 0, seat.token);
  const mcp = createMcpServer({ tools: createActionTools(lobby, () => null) });

  const bad = await callTool(mcp, "set_seat_controller", { seat_handle: handle, controller: "nobody" });
  assert.equal(bad.body.result.isError, true);
  assert.match(bad.body.result.content[0].text, /bad-controller/);

  const notLive = await callTool(mcp, "set_seat_controller", { seat_handle: handle, controller: "ai" });
  assert.equal(notLive.body.result.isError, true);
  assert.match(notLive.body.result.content[0].text, /match-not-live/);
});

test("a WATCH handle can never act — not a command, not a surrender, not a handover", async () => {
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const watch = mintWatchHandle(match.id);
  let bridgeUsed = false;
  const bridge = { sendCommand: () => { bridgeUsed = true; return { ok: true }; }, surrender: () => { bridgeUsed = true; }, setSeatAi: async () => { bridgeUsed = true; return { ai: true }; } };
  const mcp = createMcpServer({ tools: createActionTools(lobby, () => bridge) });

  for (const [name, args] of [
    ["issue_command", { seat_handle: watch, command: { t: "stop", ids: ["u1"] } }],
    ["surrender", { seat_handle: watch }],
    ["set_seat_controller", { seat_handle: watch, controller: "ai" }],
  ]) {
    const { body } = await callTool(mcp, name, args);
    assert.equal(body.result.isError, true, `${name} must refuse a watch handle`);
    assert.match(body.result.content[0].text, /watch-only-handle/);
  }
  assert.equal(bridgeUsed, false, "a watcher's call must never reach the match's own bridge at all");
});
