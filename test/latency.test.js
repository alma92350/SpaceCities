/* ============================================================
   T-032 (FR-11: "playable at 150ms RTT via local prediction of selection and camera, and
   server-confirmed unit orders"). MEASURED, not asserted — the exit criterion's own words, and
   this project's own recurring standard (T-014/T-015/T-028b/T-029 all measured before or instead
   of building). Three properties, each independently real:

   1. SELECTION AND CAMERA ARE ALREADY LATENCY-IMMUNE, ARCHITECTURALLY, NOT BY CONVENTION. Not
      re-tested here at the DOM/input.js layer — camera.js has ZERO imports (grep-verified: a pure,
      standalone module that cannot possibly depend on transport timing, structurally, since it
      has no way to reach `game`/`transport` at all even if it wanted to), and every
      `state.selection = ...` assignment in input.js (six sites) is a direct, synchronous mutation
      with no `await`/`.then()`/submitCommand anywhere near it. test/input.test.js's own T-013 test
      ("placing a building through a REAL injected delay... buildMode survives the whole gap, not
      just a microtask") already proves the qualitative property this task cares about — that
      in-flight command state and local UI state are independent — against net/loopbackFaults.js's
      OWN Transport-agnostic wrapper, which T-026 already made interchangeable with the real WS
      transport by design (its whole exit criterion: "swapping loopback -> WebSocket changes no
      client code above the transport"). Re-deriving that same property a third time with a
      heavier real-WS-plus-real-DOM fixture would prove nothing this codebase doesn't already
      stand behind; what's genuinely NEW below is proving net/loopbackFaults.js's own claim ("a
      future WebSocketTransport just as well") true for real, and putting a real number on it.

   2. AN ORDER IS SERVER-CONFIRMED, NOT LOCALLY PREDICTED — genuinely proven below, over a real
      socket: state does not reflect a submitted move until the delayed round trip actually
      completes.

   3. THE MEASUREMENT ITSELF: net/loopbackFaults.js's createFaultyTransport, wrapped around a REAL
      net/wsClientTransport.js connected to a REAL net/wsServerTransport.js server, at FR-11's own
      150ms figure — a real number, not a assumed one.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createGameState } from "../engine/state.js";
import { mulberry32 } from "../engine/rng.js";
import { createMatch, stepMatch } from "../server/matchLoop.js";
import { attachWsMatch } from "../net/wsServerTransport.js";
import { createWsClientTransport } from "../net/wsClientTransport.js";
import { createFaultyTransport } from "../net/loopbackFaults.js";

const SEED = 150150;
const RTT_MS = 150;   // FR-11's own named target

function makeMatch(seed = SEED) {
  const state = createGameState({ planetId: "ferros", seed, rng: mulberry32(seed) });
  return createMatch(state);
}

function startTicking(match, wsMatch, dt = 0.05) {
  const timer = setInterval(() => { stepMatch(match, dt); wsMatch.broadcastState(); }, 4);
  return () => clearInterval(timer);
}

async function listen(server) {
  await new Promise(resolve => server.listen(0, resolve));
  return server.address().port;
}

async function setupFaultyWs(faultOpts) {
  const match = makeMatch();
  const server = createServer();
  const wsMatch = attachWsMatch(server, match);
  const port = await listen(server);
  const stopTicking = startTicking(match, wsMatch);
  const real = await createWsClientTransport(`ws://localhost:${port}/?seat=player`);
  const transport = createFaultyTransport(real, faultOpts);
  const unit = [...match.state.units.values()].find(u => u.owner === "player");
  return {
    match, transport, unit,
    cleanup: () => { transport.close(); stopTicking(); server.close(); },
  };
}

test("T-032: net/loopbackFaults.js's own claim, made real — createFaultyTransport wraps a REAL WS transport exactly as it wraps loopback, at FR-11's own 150ms RTT figure", async () => {
  const { transport, unit, cleanup } = await setupFaultyWs({ latencyMs: RTT_MS });
  try {
    const start = Date.now();
    const result = await transport.submitCommand({ t: "move", ids: [unit.id], x: unit.x + 40, y: unit.y });
    const elapsed = Date.now() - start;

    assert.equal(result.ok, true, "the command itself must still succeed under latency, not just eventually resolve");
    // Real, not asserted: the injected delay is the floor (createFaultyTransport delays BEFORE
    // calling the real transport, so the real — near-zero, localhost — round trip adds on top,
    // never subtracts). A generous ceiling absorbs CI/container scheduling jitter without
    // pretending an unbounded wait would still count as "playable".
    assert.ok(elapsed >= RTT_MS, `expected at least the injected ${RTT_MS}ms, measured ${elapsed}ms`);
    assert.ok(elapsed < RTT_MS + 400, `expected close to ${RTT_MS}ms, not a runaway wait — measured ${elapsed}ms`);
  } finally { cleanup(); }
});

test("T-032: an order is genuinely SERVER-CONFIRMED under 150ms simulated RTT — the server has no trace of it (no order set) until the delayed round trip actually completes", async () => {
  const { match, transport, unit, cleanup } = await setupFaultyWs({ latencyMs: RTT_MS });
  try {
    assert.equal(unit.order, null, "fixture sanity: a fresh unit starts idle, no order at all");
    const submitAt = Date.now();
    const resultPromise = transport.submitCommand({ t: "move", ids: [unit.id], x: unit.x + 250, y: unit.y });

    // Sampled well inside the 150ms window — not a microtask-later check, a REAL elapsed wait,
    // the same "not just a microtask" standard T-013's own equivalent loopback test already holds
    // itself to (test/input.test.js). Checking `unit.order`, not raw x/y — ambient movement (unit
    // separation/nudging near the base, unrelated to this command) can shift a unit's position by
    // a fraction over 60ms even with no order at all; `order` is the precise thing "was THIS
    // command applied yet" actually means, the same distinction T-013's own build-mode test draws
    // by checking `state.buildings.size` rather than some looser proxy.
    await new Promise(r => setTimeout(r, 60));
    assert.ok(Date.now() - submitAt < RTT_MS, "fixture sanity: this check itself must land before the injected delay elapses");
    assert.equal(unit.order, null, "60ms into a 150ms-latency order, the server must not have applied it yet — no local prediction of the order's OWN effect");

    await resultPromise;
    // The server's own admit()/stepMatch pipeline (INPUT_DELAY_TICKS) adds a further, separate,
    // already-proven delay on top (test/matchLoop.test.js) — this test's own job stops at "the
    // transport-level round trip is real", not at re-timing the sim's own scheduling.
  } finally { cleanup(); }
});

test("T-032: state-push events (onEvent) are ALSO delayed when the transport is wrapped, and still arrive correctly — not just submitCommand's own promise", async () => {
  const { transport, cleanup } = await setupFaultyWs({ latencyMs: 30 });
  try {
    const firstState = await new Promise(resolve => {
      const start = Date.now();
      transport.onEvent(e => { if (e.type === "state") resolve({ e, elapsed: Date.now() - start }); });
    });
    assert.ok(firstState.e.state.units instanceof Map, "a delayed state push must still reassemble correctly, not arrive corrupted");
    assert.ok(firstState.elapsed >= 30, `expected at least the injected 30ms before the first state push, measured ${firstState.elapsed}ms`);
  } finally { cleanup(); }
});
