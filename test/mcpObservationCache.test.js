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

/* ============================================================
   T-054 (FR-17): waitForEvent — the SAME cache, a second capability. state.events is never
   drained server-side (confirmed by reading matchWorker.js/session.js/loop.js/sim.js directly —
   only the single-player client, boot.js, ever does `state.events.length = 0`), so a live match's
   full event history accumulates for its whole lifetime; engine/projection.js's own per-seat
   filter (`e.owner === seat || isVisibleAt(fog, e.x, e.y)`) is re-applied fresh against that
   growing history EVERY tick using THIS tick's fog, which is real-time ("recomputed fresh every
   tick", fog.js's own header) rather than permanent discovery — so a seat's own filtered
   proj.events can both grow AND shrink tick to tick as units move in and out of sight. That rules
   out any array-length/index cursor as unsafe (indices don't name a stable element). What IS safe:
   a fixed snapshot of the events visible AT THE MOMENT waitForEvent was called (the "baseline"),
   compared by VALUE (JSON) against every later push for that seat until something appears that
   was not in that baseline, or the timeout elapses. No invented event ids, no assumption the
   history only grows — the wait only ever asks "is there something in view now that was not in
   view when I called," which is exactly the fog-of-war-correct meaning of "new to this seat."
   ============================================================ */

test("waitForEvent resolves once a genuinely new event appears for that seat, carrying only the new one(s)", async () => {
  const worker = new EventEmitter();
  const cache = attachProjectionCache(worker);
  worker.emit("message", { type: "state", seat: "player", proj: { tick: 1, events: [{ type: "unitSpawned", x: 1, y: 1 }] } });

  const pending = cache.waitForEvent("player", 2000);
  worker.emit("message", { type: "state", seat: "player", proj: { tick: 2, events: [{ type: "unitSpawned", x: 1, y: 1 }] } });
  worker.emit("message", {
    type: "state", seat: "player",
    proj: { tick: 3, events: [{ type: "unitSpawned", x: 1, y: 1 }, { type: "attackHit", x: 5, y: 5, owner: "ai" }] },
  });

  const result = await pending;
  assert.equal(result.timedOut, false);
  assert.equal(result.tick, 3);
  assert.deepEqual(result.events, [{ type: "attackHit", x: 5, y: 5, owner: "ai" }]);
});

test("waitForEvent times out with timedOut:true and no events, never a throw, when nothing new happens", async () => {
  const worker = new EventEmitter();
  const cache = attachProjectionCache(worker);
  worker.emit("message", { type: "state", seat: "player", proj: { tick: 1, events: [] } });

  const result = await cache.waitForEvent("player", 50);
  assert.equal(result.timedOut, true);
  assert.deepEqual(result.events, []);
  assert.equal(result.tick, 1);
});

test("an event already present at call time never causes an immediate resolve — only genuinely NEW content does", async () => {
  const worker = new EventEmitter();
  const cache = attachProjectionCache(worker);
  worker.emit("message", { type: "state", seat: "player", proj: { tick: 1, events: [{ type: "unitSpawned", x: 1, y: 1 }] } });

  // The exact same event, re-sent unchanged (as a real tick push naturally would while nothing
  // new has happened) — must NOT resolve early just because a "state" message arrived at all.
  const result = await cache.waitForEvent("player", 80).then(r => r, () => { throw new Error("must not reject"); });
  worker.emit("message", { type: "state", seat: "player", proj: { tick: 2, events: [{ type: "unitSpawned", x: 1, y: 1 }] } });
  assert.equal(result.timedOut, true);
});

test("an event that scrolls out of fog and back in UNCHANGED is not reported twice — the baseline stays fixed for the whole wait, not the immediately-prior tick", async () => {
  const worker = new EventEmitter();
  const cache = attachProjectionCache(worker);
  const seen = { type: "entityKilled", x: 9, y: 9, owner: "ai" };
  worker.emit("message", { type: "state", seat: "player", proj: { tick: 1, events: [seen] } });

  const pending = cache.waitForEvent("player", 300);
  // Vision lost (shrinks) then regained with the SAME already-known event (grows back) — neither
  // half is "new," so this must keep waiting rather than resolving on the shrink or the re-grow.
  worker.emit("message", { type: "state", seat: "player", proj: { tick: 2, events: [] } });
  worker.emit("message", { type: "state", seat: "player", proj: { tick: 3, events: [seen] } });
  // Only now does something genuinely new arrive.
  const fresh = { type: "attackHit", x: 2, y: 2, owner: "ai" };
  worker.emit("message", { type: "state", seat: "player", proj: { tick: 4, events: [seen, fresh] } });

  const result = await pending;
  assert.equal(result.timedOut, false);
  assert.equal(result.tick, 4);
  assert.deepEqual(result.events, [fresh]);
});

test("waitForEvent works even before this seat's first state push ever arrives — baseline is just empty", async () => {
  const worker = new EventEmitter();
  const cache = attachProjectionCache(worker);
  const pending = cache.waitForEvent("player", 2000);
  worker.emit("message", { type: "state", seat: "player", proj: { tick: 1, events: [{ type: "unitSpawned", x: 1, y: 1 }] } });
  const result = await pending;
  assert.equal(result.timedOut, false);
  assert.deepEqual(result.events, [{ type: "unitSpawned", x: 1, y: 1 }]);
});

test("two concurrent waiters on the SAME seat each resolve independently once their own condition is met", async () => {
  const worker = new EventEmitter();
  const cache = attachProjectionCache(worker);
  worker.emit("message", { type: "state", seat: "player", proj: { tick: 1, events: [] } });

  const first = cache.waitForEvent("player", 2000);
  const second = cache.waitForEvent("player", 2000);
  const ev = { type: "attackHit", x: 3, y: 3, owner: "ai" };
  worker.emit("message", { type: "state", seat: "player", proj: { tick: 2, events: [ev] } });

  const [r1, r2] = await Promise.all([first, second]);
  assert.deepEqual(r1.events, [ev]);
  assert.deepEqual(r2.events, [ev]);
});

test("a wait for seat A is never resolved by seat B's own new event", async () => {
  const worker = new EventEmitter();
  const cache = attachProjectionCache(worker);
  worker.emit("message", { type: "state", seat: "player", proj: { tick: 1, events: [] } });
  worker.emit("message", { type: "state", seat: "ai", proj: { tick: 1, events: [] } });

  const pending = cache.waitForEvent("player", 80);
  worker.emit("message", { type: "state", seat: "ai", proj: { tick: 2, events: [{ type: "unitSpawned", x: 1, y: 1 }] } });

  const result = await pending;
  assert.equal(result.timedOut, true, "seat ai's own new event must never resolve seat player's own wait");
});
