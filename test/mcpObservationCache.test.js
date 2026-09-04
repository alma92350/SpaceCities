import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { SPECTATOR_SEAT } from "../engine/projection.js";
import { attachProjectionCache } from "../server/mcpObservationCache.js";

/* ============================================================
   T-052 (FR-14): a live match's real engine State lives inside its own worker_threads Worker
   (server/matchWorker.js) — an MCP tool call, arriving on the MAIN thread, can never reach it
   directly. What the worker DOES already do, every tick, unprompted, for every seat: post
   {type:"state", seat, proj:projectFor(state,seat)} out to the parent (net/wsWorkerTransport.js
   relays this to a live WebSocket connection). This cache is the OTHER consumer of that same
   stream — no new fog logic, no reaching into the worker, just remembering the latest ALREADY
   fog-safe projection per seat so a request/response tool call can read it on demand instead of
   needing a live push. A plain node:events EventEmitter stands in for a real worker_threads.Worker
   here (both expose the same on/emit "message" interface) — a real worker's own posted messages
   are exercised end to end by test/mcpObservationTools.test.js instead, matching every other
   worker-message-based component in this codebase's own test split.
   ============================================================ */

test("attachProjectionCache remembers the LATEST proj for a seat, not the first", () => {
  const worker = new EventEmitter();
  const cache = attachProjectionCache(worker);

  worker.emit("message", { type: "state", seat: "player", proj: { tick: 1 } });
  worker.emit("message", { type: "state", seat: "player", proj: { tick: 2 } });

  assert.deepEqual(cache.latestProjFor("player"), { tick: 2 });
});

test("attachProjectionCache keeps every seat's own projection independently", () => {
  const worker = new EventEmitter();
  const cache = attachProjectionCache(worker);

  worker.emit("message", { type: "state", seat: "player", proj: { tick: 1, who: "player" } });
  worker.emit("message", { type: "state", seat: "ai", proj: { tick: 1, who: "ai" } });

  assert.deepEqual(cache.latestProjFor("player"), { tick: 1, who: "player" });
  assert.deepEqual(cache.latestProjFor("ai"), { tick: 1, who: "ai" });
});

test("a seat with no state pushed yet returns null, not undefined or a throw", () => {
  const worker = new EventEmitter();
  const cache = attachProjectionCache(worker);
  assert.equal(cache.latestProjFor("nobody-has-joined-this-seat-yet"), null);
});

test("the spectator's own projection is never cached under a real seat id — it is a different audience with unfiltered vision", () => {
  const worker = new EventEmitter();
  const cache = attachProjectionCache(worker);
  worker.emit("message", { type: "state", seat: SPECTATOR_SEAT, proj: { tick: 1, unfiltered: true } });
  assert.equal(cache.latestProjFor(SPECTATOR_SEAT), null);
});

test("non-state messages (commandResult, ready, etc.) are ignored, not mistaken for a projection", () => {
  const worker = new EventEmitter();
  const cache = attachProjectionCache(worker);
  worker.emit("message", { type: "ready", owners: ["player", "ai"] });
  worker.emit("message", { type: "commandResult", seat: "player", seq: 1, result: { ok: true } });
  assert.equal(cache.latestProjFor("player"), null);
});
