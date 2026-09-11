import { test } from "node:test";
import assert from "node:assert/strict";
import { createLobby } from "../server/lobby.js";
import { createSeatPresence } from "../server/seatPresence.js";

/* ============================================================
   AI cover for an MCP seat whose holder went quiet (server/seatPresence.js). T-036's own
   disconnect -> AI takeover is driven by a WebSocket closing and therefore cannot fire for an MCP
   seat, which has no connection to lose — so a compacting agent used to leave its base frozen for
   the rest of the match while the opponent played on. Every test here drives `sweep(nowMs)`
   directly rather than waiting out a real interval, so the clock is explicit and nothing is timing
   -dependent.
   ============================================================ */

// Records every setSeatAi the presence module issues, so a test asserts what the match WORKER was
// actually told rather than only what the module thinks it did.
function fakeBridge(calls) {
  return { setSeatAi: async (seat, enabled) => { calls.push({ seat, enabled }); return { ai: enabled }; } };
}

function liveMatch(lobby, { seatKinds = ["open", "ai"], join = [0] } = {}) {
  const match = lobby.createMatch({ seatKinds });
  for (const i of join) lobby.joinMatch(match.id, i, `client-${i}`);
  lobby.startMatch(match.id);
  return match;
}

function presenceFor(lobby, calls, opts = {}) {
  return createSeatPresence({ lobby, getBridge: () => fakeBridge(calls), idleMs: 90000, ...opts });
}

test("a seat silent past the idle window is handed to the game's AI", async () => {
  const lobby = createLobby();
  const calls = [];
  const match = liveMatch(lobby);
  const presence = presenceFor(lobby, calls);

  const now = Date.now();
  lobby.touchSeat(match.id, 0, now - 30000);
  await presence.sweep(now);
  assert.deepEqual(calls, [], "30s of silence is ordinary deliberation, not an abandoned seat");

  lobby.touchSeat(match.id, 0, now - 120000);
  await presence.sweep(now);
  assert.deepEqual(calls, [{ seat: "player", enabled: true }]);
  assert.equal(presence.isAutoCovered(match.id, "player"), true);
});

test("cover is applied once, not re-applied on every sweep", async () => {
  const lobby = createLobby();
  const calls = [];
  const match = liveMatch(lobby);
  const presence = presenceFor(lobby, calls);

  const now = Date.now();
  lobby.touchSeat(match.id, 0, now - 120000);
  await presence.sweep(now);
  await presence.sweep(now + 5000);
  await presence.sweep(now + 10000);
  assert.deepEqual(calls, [{ seat: "player", enabled: true }]);
});

test("the seat's next call hands control straight back — returning needs no special step", async () => {
  const lobby = createLobby();
  const calls = [];
  const match = liveMatch(lobby);
  const presence = presenceFor(lobby, calls);

  lobby.touchSeat(match.id, 0, Date.now() - 120000);
  await presence.sweep();
  presence.onSeatActive(match.id, 0);   // what withSeat does on the agent's very next tool call

  assert.deepEqual(calls, [{ seat: "player", enabled: true }, { seat: "player", enabled: false }]);
  assert.equal(presence.isAutoCovered(match.id, "player"), false);
});

test("a seat that was never covered is not 'handed back' on an ordinary call", async () => {
  const lobby = createLobby();
  const calls = [];
  const match = liveMatch(lobby);
  const presence = presenceFor(lobby, calls);

  presence.onSeatActive(match.id, 0);
  assert.deepEqual(calls, [], "an active seat's every tool call must not post a controller swap");
});

test("a seat the AGENT handed to the AI is never auto-handed-back by its own observation calls", async () => {
  const lobby = createLobby();
  const calls = [];
  const match = liveMatch(lobby);
  const presence = presenceFor(lobby, calls);

  // The agent's own set_seat_controller(ai) — it is stepping away deliberately.
  presence.setManual(match.id, "player", true);
  // ...and then keeps watching the match while away. This must NOT take the seat back.
  presence.onSeatActive(match.id, 0);
  assert.deepEqual(calls, []);

  // Nor may the idle sweep touch a seat whose controller the agent is deliberately holding.
  lobby.touchSeat(match.id, 0, Date.now() - 600000);
  await presence.sweep();
  assert.deepEqual(calls, []);

  // Only an explicit take-back clears it, after which ordinary idle cover applies again.
  presence.setManual(match.id, "player", false);
  await presence.sweep();
  assert.deepEqual(calls, [{ seat: "player", enabled: true }]);
});

test("only a live, started match with a real seat holder is ever covered", async () => {
  const lobby = createLobby();
  const calls = [];

  // Open (never started): no worker, nothing to drive.
  const open = lobby.createMatch({ seatKinds: ["open", "ai"] });
  lobby.joinMatch(open.id, 0);
  // Started, but this boot has no worker for it (restored from a snapshot, or already torn down).
  const dead = liveMatch(lobby);
  // Started and live, but its OTHER seat is a scripted AI nobody holds.
  const live = liveMatch(lobby);

  const presence = createSeatPresence({
    lobby, idleMs: 90000,
    getBridge: () => fakeBridge(calls),
    isLive: matchId => matchId === live.id,
  });

  const now = Date.now();
  for (const m of [open, dead, live]) lobby.touchSeat(m.id, 0, now - 600000);
  await presence.sweep(now);

  assert.deepEqual(calls, [{ seat: "player", enabled: true }], "exactly one seat qualified: the held seat of the live match");
});

test("a seat with no recorded presence at all (a snapshot from an older build) is treated as abandoned, not as present forever", async () => {
  const lobby = createLobby();
  const calls = [];
  const match = liveMatch(lobby);
  match.seats[0].lastSeenAt = null;   // exactly what restoreLobby yields for a pre-presence snapshot
  const presence = presenceFor(lobby, calls);

  await presence.sweep();
  // seatIdleMs reports null (unknown) for such a seat, and the sweep skips what it cannot judge —
  // the seat is covered on its own terms once it has been seen once and then goes quiet.
  assert.deepEqual(calls, [], "an unknown presence is not evidence of absence");
  lobby.touchSeat(match.id, 0, Date.now() - 120000);
  await presence.sweep();
  assert.deepEqual(calls, [{ seat: "player", enabled: true }]);
});
