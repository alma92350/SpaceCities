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

test("the spectator's own projection is cached under SPECTATOR_SEAT and NEVER under a real seat id — a different audience, with unfiltered vision", () => {
  const worker = new EventEmitter();
  const cache = attachProjectionCache(worker);
  worker.emit("message", { type: "state", seat: SPECTATOR_SEAT, proj: { tick: 1, unfiltered: true } });
  // Readable by a watch handle (server/mcpSeatHandle.js's mintWatchHandle resolves to exactly this
  // pseudo-seat) — which is what makes watching a match over MCP possible at all...
  assert.deepEqual(cache.latestProjFor(SPECTATOR_SEAT), { tick: 1, unfiltered: true });
  // ...and still invisible to every REAL seat, which is the property that actually matters: an
  // unfogged projection must never be reachable by asking for a player's own view.
  assert.equal(cache.latestProjFor("player"), null);
  assert.equal(cache.latestProjFor("ai"), null);
});

test("non-state messages (commandResult, ready, etc.) are ignored, not mistaken for a projection", () => {
  const worker = new EventEmitter();
  const cache = attachProjectionCache(worker);
  worker.emit("message", { type: "ready", owners: ["player", "ai"] });
  worker.emit("message", { type: "commandResult", seat: "player", seq: 1, result: { ok: true } });
  assert.equal(cache.latestProjFor("player"), null);
});

/* ============================================================
   T-054 (FR-17): waitForEvent — the SAME cache, a second capability. server/matchWorker.js's own
   pushState() drains `state.events` every tick (right after building every seat's projection), so
   proj.events here is genuinely just that tick's own fresh events, not a growing whole-match
   history — an earlier version of this file's own header documented the opposite as deliberate,
   which turned out to double as a live-match bug (the same undrained history also replayed every
   past attack's tracer/sound forever for a real WS-relayed human client; see matchWorker.js's own
   pushState() comment). None of that changes what's safe here: a fixed snapshot of the events
   visible AT THE MOMENT waitForEvent was called (the "baseline"), compared by VALUE (JSON) against
   every later push for that seat until something appears that was not in that baseline, or the
   timeout elapses — this is what correctly aggregates "new since the call" across however many
   ticks land before the wait resolves, with no invented event ids and no assumption about whether
   any single tick's own proj.events repeats something already seen.
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
  // (Still true with the undelivered buffer below: an event the latest proj still carries is
  // baseline, not a lost event.)
  const result = await cache.waitForEvent("player", 80).then(r => r, () => { throw new Error("must not reject"); });
  worker.emit("message", { type: "state", seat: "player", proj: { tick: 2, events: [{ type: "unitSpawned", x: 1, y: 1 }] } });
  assert.equal(result.timedOut, true);
});

// Post-T-054 gap, observed in real agent play: events firing while NO wait_for_event call is in
// flight used to be lost forever (the worker drains state.events every tick and nothing kept
// them) — three recorded match losses happened exactly this way. The buffer delivers them on the
// NEXT call — but only the ones the latest projection no longer carries: an event still visible
// in the latest proj is baseline (the fog-scroll contract), while one that already scrolled out
// happened and is gone, and no future push will ever carry it again.
test("events that fired while NO waiter was in flight are delivered by the NEXT waitForEvent, not lost", async () => {
  const worker = new EventEmitter();
  const cache = attachProjectionCache(worker);
  worker.emit("message", {
    type: "state", seat: "player",
    proj: { tick: 7, events: [{ type: "entityKilled", id: "u8", owner: "ai" }, { type: "attackHit", x: 5, y: 5 }] },
  });
  // Later ticks move the latest proj on (as real 20Hz pushes always do) — the events are now
  // nowhere the agent can see, which is exactly what made them lost before.
  worker.emit("message", { type: "state", seat: "player", proj: { tick: 8, events: [] } });

  const result = await cache.waitForEvent("player", 2000);
  assert.equal(result.timedOut, false);
  assert.equal(result.tick, 7);
  assert.deepEqual(result.events, [{ type: "entityKilled", id: "u8", owner: "ai" }, { type: "attackHit", x: 5, y: 5 }]);
});

test("buffered events are delivered exactly ONCE — the next call waits again instead of re-delivering", async () => {
  const worker = new EventEmitter();
  const cache = attachProjectionCache(worker);
  worker.emit("message", { type: "state", seat: "player", proj: { tick: 7, events: [{ type: "attackHit", x: 5, y: 5 }] } });
  worker.emit("message", { type: "state", seat: "player", proj: { tick: 8, events: [] } });

  const first = await cache.waitForEvent("player", 2000);
  assert.equal(first.timedOut, false);

  const second = await cache.waitForEvent("player", 50);
  assert.equal(second.timedOut, true);
  assert.deepEqual(second.events, []);
});

test("an event the latest proj STILL carries is baseline even though no waiter was registered when it fired", async () => {
  const worker = new EventEmitter();
  const cache = attachProjectionCache(worker);
  worker.emit("message", { type: "state", seat: "player", proj: { tick: 7, events: [{ type: "attackHit", x: 5, y: 5 }] } });

  // No later push — the event is still inside the latest proj, so it is baseline, not lost.
  const result = await cache.waitForEvent("player", 50);
  assert.equal(result.timedOut, true);
  assert.deepEqual(result.events, []);
});

test("events delivered to a registered waiter are NOT also buffered for the next call", async () => {
  const worker = new EventEmitter();
  const cache = attachProjectionCache(worker);
  worker.emit("message", { type: "state", seat: "player", proj: { tick: 1, events: [] } });

  const pending = cache.waitForEvent("player", 2000);
  worker.emit("message", { type: "state", seat: "player", proj: { tick: 2, events: [{ type: "attackHit", x: 1, y: 1 }] } });
  const result = await pending;
  assert.equal(result.timedOut, false);

  const next = await cache.waitForEvent("player", 50);
  assert.equal(next.timedOut, true);
});

test("the undelivered buffer is bounded — a flood of events between polls delivers the newest, drops the oldest", async () => {
  const worker = new EventEmitter();
  const cache = attachProjectionCache(worker);
  // 300 distinct events across pushes with no waiter registered; cap is 256 pushes. The last
  // push's own event is baseline (still in the latest proj), so 255 deliver.
  for (let tick = 1; tick <= 300; tick++) {
    worker.emit("message", { type: "state", seat: "player", proj: { tick, events: [{ type: "attackHit", seq: tick }] } });
  }

  const result = await cache.waitForEvent("player", 2000);
  assert.equal(result.timedOut, false);
  assert.equal(result.events.length, 255);
  assert.equal(result.events[0].seq, 45);          // oldest survivor
  assert.equal(result.events[254].seq, 299);       // newest NOT still in the latest proj
  assert.equal(result.tick, 299);
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


/* ---------- the static map reference (agent-observability) ----------
   engine/projection.js ships a node as {id, amount} only; an MCP agent has no map generator to
   regenerate the rest from the seed, so the cache asks the worker for it once. Requested rather
   than pushed at boot because tools/serve.js attaches this listener after an await and would miss
   a one-shot message. */

test("attachProjectionCache asks its worker for the map reference and remembers the reply", () => {
  const worker = new EventEmitter();
  const asked = [];
  worker.postMessage = msg => asked.push(msg);
  const cache = attachProjectionCache(worker);

  assert.deepEqual(asked, [{ type: "describeMap" }]);
  assert.equal(cache.mapMeta(), null, "null until the reply lands — a tool degrades, never blocks");

  worker.emit("message", {
    type: "mapMeta",
    map: { width: 100, height: 80, planetId: "ferros", tickRate: 20 },
    nodes: [{ id: "n1", com: "ore", x: 10, y: 20, max: 500, hidden: false }],
  });

  const meta = cache.mapMeta();
  assert.equal(meta.map.width, 100);
  assert.equal(meta.nodesById.get("n1").com, "ore");
});

test("attachProjectionCache tolerates a worker double with no postMessage at all", () => {
  const worker = new EventEmitter();   // no postMessage, as every pre-existing caller's double has
  const cache = attachProjectionCache(worker);
  assert.equal(cache.mapMeta(), null);
});
