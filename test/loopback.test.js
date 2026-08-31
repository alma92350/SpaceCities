import { test } from "node:test";
import assert from "node:assert/strict";
import { createLoopbackTransport } from "../net/loopback.js";
import { createSession } from "../server/session.js";
import { mulberry32 } from "../engine/rng.js";

// net/loopback.js wires a client directly to a server/session.js session, in
// process, with no socket (ADR-0004). It implements the generic net/transport.js
// Transport interface (submitCommand/onEvent/close) — the shape a future
// WebSocketTransport will also implement — plus two LOOPBACK-SPECIFIC
// extensions (tick, getState) that only make sense when client and session
// share a process; T-012 decides how much the client actually leans on them.
//
// submitCommand returns a Promise even though the underlying work is
// genuinely synchronous (the state mutation happens before the Promise ever
// resolves) — so client code written against this transport is ALREADY
// correct for a real async transport, and T-013's fault-injection layer has
// something to actually delay.

function makeSession(seed = 12345) {
  return createSession({ planetId: "ferros", seed, rng: mulberry32(seed) });
}

test("submitCommand resolves with the session's own CommandResult", async () => {
  const session = makeSession();
  const transport = createLoopbackTransport(session);
  const worker = [...session.getState().units.values()].find(u => u.owner === "player");

  const result = await transport.submitCommand({ t: "move", ids: [worker.id], x: 300, y: 300 });
  assert.equal(result.ok, true);
  assert.equal(worker.order.x, 300);
});

test("submitCommand's mutation is visible to the caller BEFORE the promise resolves — genuinely synchronous underneath", () => {
  const session = makeSession();
  const transport = createLoopbackTransport(session);
  const worker = [...session.getState().units.values()].find(u => u.owner === "player");

  transport.submitCommand({ t: "move", ids: [worker.id], x: 600, y: 600 });
  // No `await` above: if this were genuinely asynchronous (a real queued microtask
  // delaying the mutation itself, not just the promise), this assertion would see
  // the unit's PRE-command order and fail.
  assert.equal(worker.order.x, 600);
});

test("onEvent receives a commandResult event for every submitted command", async () => {
  const session = makeSession();
  const transport = createLoopbackTransport(session);
  const worker = [...session.getState().units.values()].find(u => u.owner === "player");
  const events = [];
  transport.onEvent(e => events.push(e));

  await transport.submitCommand({ t: "move", ids: [worker.id], x: 100, y: 100 });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "commandResult");
  assert.equal(events[0].result.ok, true);
});

test("onEvent supports multiple independent subscribers", async () => {
  const session = makeSession();
  const transport = createLoopbackTransport(session);
  const worker = [...session.getState().units.values()].find(u => u.owner === "player");
  let a = 0, b = 0;
  transport.onEvent(() => a++);
  transport.onEvent(() => b++);

  await transport.submitCommand({ t: "move", ids: [worker.id], x: 1, y: 1 });
  assert.equal(a, 1);
  assert.equal(b, 1);
});

test("tick(dt) advances the underlying session AND emits a state event", () => {
  const session = makeSession();
  const transport = createLoopbackTransport(session);
  const events = [];
  transport.onEvent(e => events.push(e));

  transport.tick(0.05);
  assert.equal(session.getState().time, 0.05);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "state");
  assert.equal(events[0].state.time, 0.05);
});

test("getState() returns the session's own live state — no copy, in-process", () => {
  const session = makeSession();
  const transport = createLoopbackTransport(session);
  assert.equal(transport.getState(), session.getState());
});

test("close() is idempotent and stops delivering events", () => {
  const session = makeSession();
  const transport = createLoopbackTransport(session);
  const events = [];
  transport.onEvent(e => events.push(e));

  transport.close();
  assert.doesNotThrow(() => transport.close());   // closing twice is not an error
  transport.tick(0.05);
  assert.equal(events.length, 0, "no events after close");
});

test("submitCommand after close resolves with a clear rejection, never throws", async () => {
  const session = makeSession();
  const transport = createLoopbackTransport(session);
  transport.close();
  const worker = [...session.getState().units.values()].find(u => u.owner === "player");
  const result = await transport.submitCommand({ t: "move", ids: [worker.id], x: 1, y: 1 });
  assert.equal(result.ok, false);
});
