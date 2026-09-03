/* ============================================================
   T-029b: net/wsClientTransport.js's automatic reconnect — ADR-0012's "restart-resume and
   player-reconnect are deliberately the same mechanism" made real on the CLIENT side. A dropped
   connection (a network blip, or the server process itself dying and restarting — the two are
   indistinguishable to a socket) is retried automatically; the reconnect's own welcome message
   carries the SAME matchId (net/wsServerTransport.js, server/matchWorker.js) the client already
   saw if — and only if — it genuinely landed back in the same match, letting this file tell "my
   own server just restarted from its own snapshot" apart from "this is a different match that
   happens to share a URL" (T-029a's own restore only ever recovers a snapshot's matchId, never
   invents one — see server/matchSnapshot.js).

   Real sockets, a real net/http.Server, a real net/ws.js server and net/wsClientTransport.js
   client throughout — the same "test the real thing" standard every other net/ file in this port
   holds itself to. An abrupt disconnect is simulated by destroying the raw TCP socket directly
   (test/ws.test.js's own new T-029b test proves net/ws.js itself reports this correctly, with
   RFC 6455's own 1006) — never a clean ws.close(), since a real crash or restart never gets the
   chance to run a graceful close handshake either.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createGameState } from "../engine/state.js";
import { mulberry32 } from "../engine/rng.js";
import { createMatch, stepMatch } from "../server/matchLoop.js";
import { attachWsMatch } from "../net/wsServerTransport.js";
import { createWsClientTransport } from "../net/wsClientTransport.js";

function makeMatch(seed) {
  const state = createGameState({ planetId: "ferros", seed, rng: mulberry32(seed) });
  return createMatch(state);
}

// Same fixture shape as test/wsTransport.test.js's own startTicking — a real caller-driven tick
// loop on a fast wall-clock cadence, not test-only scaffolding standing in for one.
function startTicking(match, wsMatch, dt = 0.05) {
  const timer = setInterval(() => { stepMatch(match, dt); wsMatch.broadcastState(); }, 4);
  return () => clearInterval(timer);
}

async function listen(server, port = 0) {
  await new Promise(resolve => server.listen(port, resolve));
  return server.address().port;
}

function closeServer(server) {
  return new Promise(resolve => server.close(resolve));
}

function waitForEvent(transport, pred, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("waitForEvent timed out waiting for a matching event")), timeoutMs);
    transport.onEvent(e => { if (pred(e)) { clearTimeout(timer); resolve(e); } });
  });
}

test("an abrupt disconnect (same server, same match) auto-reconnects: a disconnected event fires, then a reconnected event reports sameMatch:true, the client's own fog object is preserved (exploration memory survives), and commands work again", async () => {
  const match = makeMatch(1001);
  const server = createServer();
  const wsMatch = attachWsMatch(server, match);
  let rawSocket = null;
  // A second, independent listener on the SAME upgrade event attachWsMatch's own onUpgrade is
  // already attached to — purely to grab the raw TCP socket for this test's own use, exactly
  // test/ws.test.js's own new T-029b test does one layer down.
  server.on("upgrade", (req, socket) => { rawSocket = socket; });
  const port = await listen(server);
  const stopTicking = startTicking(match, wsMatch);

  const transport = await createWsClientTransport(`ws://localhost:${port}/?seat=player`, { reconnectDelayMs: 50 });
  try {
    const firstState = await waitForEvent(transport, e => e.type === "state");
    const fogBefore = firstState.state.fog;
    assert.ok(fogBefore, "fixture sanity: a real fog object is present on the very first state event");

    const disconnected = waitForEvent(transport, e => e.type === "disconnected");
    rawSocket.destroy();   // simulate a crash/network death, never a clean close handshake
    await disconnected;

    const reconnected = await waitForEvent(transport, e => e.type === "reconnected");
    assert.equal(reconnected.sameMatch, true, "the SAME attachWsMatch() instance is still running — this must read as the same match");
    assert.equal(typeof reconnected.matchId, "string");

    const stateAfter = await waitForEvent(transport, e => e.type === "state");
    assert.equal(stateAfter.state.fog, fogBefore, "reconnecting to the SAME match must reuse the existing fog object, not discard the player's own exploration memory");

    const unit = [...stateAfter.state.units.values()].find(u => u.owner === "player");
    const result = await transport.submitCommand({ t: "move", ids: [unit.id], x: unit.x + 10, y: unit.y });
    assert.equal(result.ok, true, "the transport must be fully functional again after an automatic reconnect");
  } finally { stopTicking(); transport.close(); await closeServer(server); }
});

test("while a reconnect is pending (old socket dead, new one not yet open), submitCommand resolves immediately with ok:false rather than throwing or hanging", async () => {
  const match = makeMatch(1002);
  const server = createServer();
  const wsMatch = attachWsMatch(server, match);
  let rawSocket = null;
  server.on("upgrade", (req, socket) => { rawSocket = socket; });
  const port = await listen(server);
  const stopTicking = startTicking(match, wsMatch);

  // A deliberately long delay — long enough that this test's own submitCommand call below is
  // guaranteed to land WHILE still waiting to retry, not after a fresh connection is already open.
  const transport = await createWsClientTransport(`ws://localhost:${port}/?seat=player`, { reconnectDelayMs: 2000 });
  try {
    await waitForEvent(transport, e => e.type === "state");
    const disconnected = waitForEvent(transport, e => e.type === "disconnected");
    rawSocket.destroy();
    await disconnected;

    const result = await transport.submitCommand({ t: "stop", ids: ["whatever"] });
    assert.equal(result.ok, false);
  } finally { stopTicking(); transport.close(); await closeServer(server); }
});

test("transport.close() while a reconnect is pending stops it — no further connection attempt is ever made", async () => {
  const match = makeMatch(1003);
  const server = createServer();
  const wsMatch = attachWsMatch(server, match);
  let rawSocket = null;
  let upgradeCount = 0;
  server.on("upgrade", (req, socket) => { rawSocket = socket; upgradeCount++; });
  const port = await listen(server);
  const stopTicking = startTicking(match, wsMatch);

  const transport = await createWsClientTransport(`ws://localhost:${port}/?seat=player`, { reconnectDelayMs: 50 });
  try {
    await waitForEvent(transport, e => e.type === "state");
    assert.equal(upgradeCount, 1, "fixture sanity: exactly one upgrade so far, the initial connect");

    const disconnected = waitForEvent(transport, e => e.type === "disconnected");
    rawSocket.destroy();
    await disconnected;

    transport.close();   // called BEFORE the 50ms retry delay elapses
    await new Promise(r => setTimeout(r, 300));   // well past reconnectDelayMs, if a retry were still going to happen
    assert.equal(upgradeCount, 1, "close() during the reconnect wait must cancel the pending retry, not just the live connection");
  } finally { stopTicking(); await closeServer(server); }
});

test("reconnecting after the server itself restarts (a brand-new match, a different matchId) reports sameMatch:false and hands the client a FRESH fog object, never the old match's exploration memory", async () => {
  const matchA = makeMatch(2001);
  const serverA = createServer();
  const wsMatchA = attachWsMatch(serverA, matchA);
  const port = await listen(serverA);
  const stopTickingA = startTicking(matchA, wsMatchA);

  const transport = await createWsClientTransport(`ws://localhost:${port}/?seat=player`, { reconnectDelayMs: 50 });
  let stopTickingB = null;
  let serverB = null;
  try {
    const firstState = await waitForEvent(transport, e => e.type === "state");
    const fogBefore = firstState.state.fog;

    const disconnected = waitForEvent(transport, e => e.type === "disconnected");
    stopTickingA();
    wsMatchA.close();
    await closeServer(serverA);   // release the port before a second server tries to bind it
    await disconnected;

    // A brand-new, INDEPENDENT match + attachWsMatch() call — mints its OWN fresh matchId
    // (net/wsServerTransport.js's own header) — reusing the SAME port, simulating a real restart
    // where the same URL now serves a genuinely different match.
    const matchB = makeMatch(2002);
    serverB = createServer();
    const wsMatchB = attachWsMatch(serverB, matchB);
    await listen(serverB, port);
    stopTickingB = startTicking(matchB, wsMatchB);

    const reconnected = await waitForEvent(transport, e => e.type === "reconnected", 5000);
    assert.equal(reconnected.sameMatch, false);
    assert.notEqual(reconnected.matchId, undefined);

    const stateAfter = await waitForEvent(transport, e => e.type === "state");
    assert.notEqual(stateAfter.state.fog, fogBefore, "a genuinely different match must get a FRESH fog object, never the previous match's exploration memory");
  } finally {
    stopTickingA(); stopTickingB?.(); transport.close(); if (serverB) await closeServer(serverB);
  }
});
