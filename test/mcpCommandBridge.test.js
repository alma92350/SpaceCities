import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { attachCommandBridge } from "../server/mcpCommandBridge.js";

/* ============================================================
   T-053 (FR-15): the other direction from server/mcpObservationCache.js — an MCP action tool,
   arriving on the main thread, needs to SUBMIT a command into a live match's own worker_threads
   Worker and get back the result, exactly the way the WebSocket path already does
   (worker.postMessage({type:"command", seat, envelope}), then a later
   {type:"commandResult", seat, seq, result} message). The only new piece here is CORRELATION:
   a WebSocket client tracks its own seq client-side and matches replies itself; an MCP tool call
   is a single request/response, so this bridge does that matching internally and resolves a
   Promise, one seq per outstanding call.

   A plain node:events EventEmitter stands in for a real worker_threads.Worker here (both expose
   the same on/postMessage-shaped "message" interface for this test's purposes) — a REAL worker
   running the REAL codec is exercised by test/mcpActionTools.test.js instead, which is the one
   that actually proves "validation identical to a human's."
   ============================================================ */

function fakeWorker() {
  const emitter = new EventEmitter();
  const sent = [];
  emitter.postMessage = msg => sent.push(msg);
  return { emitter, sent };
}

test("sendCommand posts {type:'command', seat, envelope} to the worker, envelope carrying a fresh seq", async () => {
  const { emitter, sent } = fakeWorker();
  const bridge = attachCommandBridge(emitter);
  const pending = bridge.sendCommand("player", { t: "stop", ids: ["u1"] });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "command");
  assert.equal(sent[0].seat, "player");
  assert.equal(sent[0].envelope.cmd.t, "stop");
  assert.ok(Number.isInteger(sent[0].envelope.seq));

  emitter.emit("message", { type: "commandResult", seat: "player", seq: sent[0].envelope.seq, result: { ok: true } });
  assert.deepEqual(await pending, { ok: true });
});

test("two concurrent sendCommand calls get DIFFERENT seqs and each resolves with its OWN matching result, never the other's", async () => {
  const { emitter, sent } = fakeWorker();
  const bridge = attachCommandBridge(emitter);

  const p1 = bridge.sendCommand("player", { t: "stop", ids: ["u1"] });
  const p2 = bridge.sendCommand("player", { t: "hold", ids: ["u2"] });
  assert.notEqual(sent[0].envelope.seq, sent[1].envelope.seq);

  // Resolve out of order — the second sent command's result arrives FIRST — to prove this is
  // real seq-keyed correlation, not a naive FIFO queue.
  emitter.emit("message", { type: "commandResult", seat: "player", seq: sent[1].envelope.seq, result: { ok: true, result: { from: "second" } } });
  emitter.emit("message", { type: "commandResult", seat: "player", seq: sent[0].envelope.seq, result: { ok: false, code: "from-first" } });

  assert.deepEqual(await p1, { ok: false, code: "from-first" });
  assert.deepEqual(await p2, { ok: true, result: { from: "second" } });
});

test("a commandResult for a DIFFERENT seat's seq never resolves this seat's own pending call", async () => {
  const { emitter, sent } = fakeWorker();
  const bridge = attachCommandBridge(emitter);
  const pending = bridge.sendCommand("player", { t: "stop", ids: ["u1"] });

  // Same seq value, but a different seat — must NOT be treated as the match (a real worker only
  // ever echoes back the seat it actually applied the command for, but this proves the bridge
  // itself doesn't just key on seq alone if seat were ever to collide).
  emitter.emit("message", { type: "commandResult", seat: "ai", seq: sent[0].envelope.seq, result: { ok: true } });
  emitter.emit("message", { type: "commandResult", seat: "player", seq: sent[0].envelope.seq, result: { ok: true, result: { real: true } } });

  assert.deepEqual(await pending, { ok: true, result: { real: true } });
});

test("non-commandResult messages (ready, state) are ignored by the bridge, never mistaken for a reply", async () => {
  const { emitter, sent } = fakeWorker();
  const bridge = attachCommandBridge(emitter);
  const pending = bridge.sendCommand("player", { t: "stop", ids: ["u1"] });

  emitter.emit("message", { type: "ready", owners: ["player", "ai"] });
  emitter.emit("message", { type: "state", seat: "player", proj: {} });
  emitter.emit("message", { type: "commandResult", seat: "player", seq: sent[0].envelope.seq, result: { ok: true } });

  assert.deepEqual(await pending, { ok: true });
});
