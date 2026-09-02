import { test } from "node:test";
import assert from "node:assert/strict";
import { createDirectTransport } from "../net/directTransport.js";
import { createGameState } from "../engine/state.js";
import { mulberry32 } from "../engine/rng.js";

// net/directTransport.js is the Transport-shaped (net/transport.js) adapter for the boot paths
// T-012 deliberately leaves off server/session.js + net/loopback.js for now — Odyssey, a
// scenario/raider/bounty, a spectated match (TASKS.md T-012's own scoping). Those still tick
// their `state` on their own existing path (stepGalaxy, tickSelfPlay, engine/sim.js's tick
// called directly by boot.js) — this only gives input.js/inputCommands.js/hudSelection.js the
// SAME submitCommand(cmd) they call everywhere else, so none of them need to know or care
// whether a real session is behind the state they're pointed at. Unlike net/loopback.js, this
// owns no tick/getState/AI-seat behaviour at all — it is nothing but
// server/session.js's own applyCommand(state, owner, cmd), Promise-wrapped, applying as
// "player" by default (D4: every boot path this adapter serves is still a single local human).

function makeState(seed = 12345) {
  return createGameState({ planetId: "ferros", seed, rng: mulberry32(seed) });
}

test("submitCommand resolves with applyCommand's own CommandResult", async () => {
  const state = makeState();
  const transport = createDirectTransport(state);
  const worker = [...state.units.values()].find(u => u.owner === "player");

  const result = await transport.submitCommand({ t: "move", ids: [worker.id], x: 300, y: 300 });
  assert.equal(result.ok, true);
  assert.equal(worker.order.x, 300);
});

test("submitCommand's mutation is visible to the caller BEFORE the promise resolves — genuinely synchronous underneath, same guarantee as net/loopback.js", () => {
  const state = makeState();
  const transport = createDirectTransport(state);
  const worker = [...state.units.values()].find(u => u.owner === "player");

  transport.submitCommand({ t: "move", ids: [worker.id], x: 600, y: 600 });
  // No `await`: a real queued microtask delaying the MUTATION itself (not just the promise)
  // would still see the unit's pre-command order here and fail.
  assert.equal(worker.order.x, 600);
});

test("submitCommand rejects a malformed command the same way applyCommand does directly, never throws", async () => {
  const state = makeState();
  const transport = createDirectTransport(state);
  const result = await transport.submitCommand({ t: "not-a-real-command-type" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "unknown-type");
});

test("onEvent and close are harmless no-ops — this adapter owns no event stream or lifecycle to tear down", () => {
  const state = makeState();
  const transport = createDirectTransport(state);
  assert.doesNotThrow(() => transport.onEvent(() => {}));
  assert.doesNotThrow(() => transport.close());
});
