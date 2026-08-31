import { test } from "node:test";
import assert from "node:assert/strict";
import { createFaultyTransport } from "../net/loopbackFaults.js";
import { createLoopbackTransport } from "../net/loopback.js";
import { createSession } from "../server/session.js";
import { mulberry32 } from "../engine/rng.js";

// net/loopbackFaults.js wraps any real Transport (net/transport.js) and reintroduces the two
// things a same-process loopback (net/loopback.js, ADR-0004) is honest about NOT having: real
// latency, and real loss. Both net/loopback.js's own header comment and net/transport.js's
// submitCommand JSDoc call this out explicitly — client code written against a Promise-returning
// submitCommand is "already correct" for a transport where the gap is real, not just possible,
// and THIS is the transport that makes the gap real inside the deterministic unit suite, so that
// claim is proven rather than assumed. TASKS.md T-013's own exit criteria: netcode behaviour
// under 150ms RTT and 2% loss covered here, deterministically — no wall-clock 150ms waits, no
// flaky real randomness (every "random" outcome below is driven by a scripted `rng` — a plain
// function returning pre-chosen values in sequence — so a reordering test is reproducible, not
// probabilistic).
//
// Latency values below are small (10-30ms) relative to the 150ms figure in the PRD/TASKS.md
// purely so this file runs fast — the wrapper itself is not limited to small values; nothing
// about its implementation treats 150 differently from 15.

function makeSession(seed = 12345) {
  return createSession({ planetId: "ferros", seed, rng: mulberry32(seed) });
}

// A scripted rng: returns each of `values` in order, then keeps returning the last one forever
// (so a test can't run off the end of a short script by calling the transport one time too many).
function scriptedRng(values) {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

test("submitCommand resolves only after the configured latency has elapsed, not before", async () => {
  const session = makeSession();
  const transport = createFaultyTransport(createLoopbackTransport(session), { latencyMs: 25 });
  const worker = [...session.getState().units.values()].find(u => u.owner === "player");

  let resolved = false;
  transport.submitCommand({ t: "move", ids: [worker.id], x: 300, y: 300 }).then(() => { resolved = true; });

  await new Promise(r => setTimeout(r, 10));
  assert.equal(resolved, false, "10ms in, a 25ms-latency command must not have resolved yet");

  await new Promise(r => setTimeout(r, 30));
  assert.equal(resolved, true, "well past 25ms, it must have resolved by now");
});

test("unlike bare loopback, the underlying mutation is NOT visible before the delay elapses — this is the exact gap T-013 exists to make real", async () => {
  const session = makeSession();
  const transport = createFaultyTransport(createLoopbackTransport(session), { latencyMs: 20 });
  const worker = [...session.getState().units.values()].find(u => u.owner === "player");

  const before = { x: worker.order?.x, y: worker.order?.y };
  const result = transport.submitCommand({ t: "move", ids: [worker.id], x: 700, y: 700 });
  // No await yet: bare loopback (test/loopback.test.js) proves the mutation IS visible here.
  // A faulty transport with real latency must prove the opposite, or client code that (wrongly)
  // assumed synchronous-underneath behaviour would pass every test and only break in production.
  assert.deepEqual({ x: worker.order?.x, y: worker.order?.y }, before,
    "the command has not reached the session yet — nothing should have moved");

  await result;
  assert.equal(worker.order.x, 700, "once the promise resolves, the mutation has genuinely happened");
});

test("a dropped command (dropRate: 1) never resolves and never mutates state", async () => {
  const session = makeSession();
  const transport = createFaultyTransport(createLoopbackTransport(session), { latencyMs: 5, dropRate: 1, rng: () => 0 });
  const worker = [...session.getState().units.values()].find(u => u.owner === "player");
  const before = { x: worker.order?.x, y: worker.order?.y };

  let settled = false;
  transport.submitCommand({ t: "move", ids: [worker.id], x: 900, y: 900 }).then(() => { settled = true; });

  await new Promise(r => setTimeout(r, 40));
  assert.equal(settled, false, "a dropped command's promise must never resolve — there is nothing to await successfully");
  assert.deepEqual({ x: worker.order?.x, y: worker.order?.y }, before, "a lost command never reaches the session at all");
});

test("dropRate: 0 never drops, even against a lopsided rng — the threshold is a strict less-than", async () => {
  const session = makeSession();
  const transport = createFaultyTransport(createLoopbackTransport(session), { latencyMs: 0, dropRate: 0, rng: () => 0 });
  const worker = [...session.getState().units.values()].find(u => u.owner === "player");

  const result = await transport.submitCommand({ t: "move", ids: [worker.id], x: 111, y: 111 });
  assert.equal(result.ok, true);
});

test("jitter can reorder resolution relative to submission order — proven with a scripted rng, not real randomness", async () => {
  const session = makeSession();
  // First call to rng() picks command A's delay, second picks B's. Scripted so A draws the LONGER
  // delay and B the shorter one, despite A being submitted first — B must resolve first.
  const rng = scriptedRng([0.9, 0.1]);
  const transport = createFaultyTransport(createLoopbackTransport(session), { latencyMs: 5, jitterMs: 40, rng });
  const [a, b] = [...session.getState().units.values()].filter(u => u.owner === "player").slice(0, 2);
  assert.ok(a && b, "fixture assumption: at least two starting player units");

  const order = [];
  const pA = transport.submitCommand({ t: "move", ids: [a.id], x: 1, y: 1 }).then(() => order.push("A"));
  const pB = transport.submitCommand({ t: "move", ids: [b.id], x: 2, y: 2 }).then(() => order.push("B"));
  await Promise.all([pA, pB]);

  assert.deepEqual(order, ["B", "A"], "B (short jittered delay) resolves before A (long jittered delay) despite being submitted second");
});

test("onEvent delivery is independently delayed on top of submitCommand's own delay — the mutation (and so the event describing it) can only happen once the command itself has actually arrived", async () => {
  const session = makeSession();
  const transport = createFaultyTransport(createLoopbackTransport(session), { latencyMs: 20 });
  const events = [];
  transport.onEvent(e => events.push(e));
  const worker = [...session.getState().units.values()].find(u => u.owner === "player");

  transport.submitCommand({ t: "move", ids: [worker.id], x: 5, y: 5 });
  assert.equal(events.length, 0, "the commandResult event must not have arrived yet either");

  // The two 20ms delays COMPOUND, not overlap: this wrapper only calls inner.submitCommand (which
  // is what triggers inner's own emit()) after the submit's own 20ms elapses, and the wrapped
  // onEvent handler then applies ITS OWN 20ms on top of that — so the event genuinely lands
  // around 40ms, not 20ms. Realistic enough to be worth keeping (a broadcast state-push and a
  // direct reply are two separate messages, in general free to arrive independently), and the
  // more adversarial timing is the more useful one for a fault injector to produce.
  await new Promise(r => setTimeout(r, 25));
  assert.equal(events.length, 0, "25ms in, only the submit's own 20ms has elapsed — the event's own 20ms hasn't even started yet");

  await new Promise(r => setTimeout(r, 30));
  assert.equal(events.length, 1, "well past the compounded ~40ms, the event has landed");
  assert.equal(events[0].type, "commandResult");
});

test("the submitCommand promise and the broadcast event are independently droppable — a scripted rng lets the command through but loses the event, modeling a reply that arrives while its own state-push doesn't", async () => {
  const session = makeSession();
  // afterDelay drops when rng() < dropRate. First draw is for the SUBMIT's own check: 0.9 is NOT
  // under dropRate (0.5), so it survives. That success is what makes inner.submitCommand actually
  // run, which triggers inner's own emit() into the onEvent wrapper this transport installed —
  // THAT delivery draws again, independently: 0.1 IS under dropRate, so the event is lost.
  const rng = scriptedRng([0.9, 0.1]);
  const transport = createFaultyTransport(createLoopbackTransport(session), { latencyMs: 0, dropRate: 0.5, rng });
  const events = [];
  transport.onEvent(e => events.push(e));
  const worker = [...session.getState().units.values()].find(u => u.owner === "player");

  const result = await transport.submitCommand({ t: "move", ids: [worker.id], x: 5, y: 5 });
  assert.equal(result.ok, true, "the command itself got through — its own reply channel survived");
  assert.equal(worker.order.x, 5, "and it genuinely mutated state, same as any other surviving command");
  assert.equal(events.length, 0, "but the broadcast commandResult event for it never arrived — a separately-lost packet");
});

test("close() clears every pending delayed callback — no timer fires after close, and close never throws even with delays in flight", async () => {
  const session = makeSession();
  const transport = createFaultyTransport(createLoopbackTransport(session), { latencyMs: 20 });
  const events = [];
  transport.onEvent(e => events.push(e));
  const worker = [...session.getState().units.values()].find(u => u.owner === "player");

  let settled = false;
  transport.submitCommand({ t: "move", ids: [worker.id], x: 5, y: 5 }).then(() => { settled = true; });
  assert.doesNotThrow(() => transport.close());

  await new Promise(r => setTimeout(r, 40));   // past the 20ms latency — nothing must fire
  assert.equal(events.length, 0, "no event delivery survives close()");
  assert.equal(settled, false,
    "a promise already in flight when close() ran is simply abandoned, same as a dropped command — never resolved, never rejected, never thrown");
});

test("with latencyMs: 0 and dropRate: 0 (the default), behaviour is indistinguishable from the bare inner transport", async () => {
  const session = makeSession();
  const transport = createFaultyTransport(createLoopbackTransport(session));
  const worker = [...session.getState().units.values()].find(u => u.owner === "player");

  transport.submitCommand({ t: "move", ids: [worker.id], x: 42, y: 42 });
  assert.equal(worker.order.x, 42, "with every fault knob at its default (off), the mutation is still visible synchronously, exactly like bare loopback");
});
