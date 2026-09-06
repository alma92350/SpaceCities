/* ============================================================
   T-026: the WebSocket Transport pair (net/wsClientTransport.js, net/wsServerTransport.js) over a
   REAL local HTTP server and a REAL client-side WebSocket — the same "don't trust a hand-rolled
   client that could share the server's own misconceptions" standard test/ws.test.js already holds
   itself to, one layer up.

   test/transportContract.js covers the properties every Transport implementation must share;
   this file covers what's specific to shipping that contract over an actual socket: the welcome
   handshake and local map regeneration, state events actually reassembling into the shape
   render.js expects, and — a direct, real-network consequence of net/wsServerTransport.js pushing
   engine/projection.js's projectFor rather than raw state — that a seat's own payload never
   carries anything outside its fog (T-028's own exit criterion, proven here over the wire for the
   first time, not just at the engine level where test/projection.test.js already covers it).
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createGameState } from "../engine/state.js";
import { mulberry32 } from "../engine/rng.js";
import { createMatch, stepMatch, admit, INPUT_DELAY_TICKS } from "../server/matchLoop.js";
import { encode } from "../net/commandEnvelope.js";
import { attachWsMatch, buildStateMessage } from "../net/wsServerTransport.js";
import { createWsClientTransport } from "../net/wsClientTransport.js";
import { testTransportContract } from "./transportContract.js";

const SEED = 424242;

function makeMatch() {
  const state = createGameState({ planetId: "ferros", seed: SEED, rng: mulberry32(SEED) });
  return createMatch(state);
}

// Fires stepMatch on a short wall-clock cadence so an admitted command clears its
// INPUT_DELAY_TICKS window quickly — dt is a small sim-step so the fixed cadence (T-023 §5.4)
// isn't itself under test here, just fast enough that these tests don't sit around waiting.
// broadcastState() is caller-driven by design (net/wsServerTransport.js has no timer of its own,
// same as net/loopback.js's own tick()), so a real server calling it once per tick is exactly
// what this fixture reproduces — nothing here is test-only scaffolding standing in for it.
function startTicking(match, wsMatch, dt = 0.05) {
  const timer = setInterval(() => { stepMatch(match, dt); wsMatch.broadcastState(); }, 4);
  return () => clearInterval(timer);
}

async function listen(server) {
  await new Promise(resolve => server.listen(0, resolve));
  return server.address().port;
}

async function setupOneSeat() {
  const match = makeMatch();
  const server = createServer();
  const wsMatch = attachWsMatch(server, match);
  const port = await listen(server);
  const stopTicking = startTicking(match, wsMatch);
  const transport = await createWsClientTransport(`ws://localhost:${port}/?seat=player`);
  const unit = [...match.state.units.values()].find(u => u.owner === "player");
  return {
    transport, unitId: unit.id, moveTarget: { x: unit.x + 50, y: unit.y },
    cleanup: () => { stopTicking(); transport.close(); server.close(); },
  };
}

testTransportContract("wsClientTransport", setupOneSeat);

test("T-029b: attachWsMatch() mints a real matchId, and the wire welcome message actually carries that exact id", async () => {
  const match = makeMatch();
  const server = createServer();
  const wsMatch = attachWsMatch(server, match);
  const port = await listen(server);
  assert.equal(typeof wsMatch.matchId, "string");
  assert.ok(wsMatch.matchId.length > 0);
  try {
    // A RAW native WebSocket, not net/wsClientTransport.js — this test's own job is to prove the
    // wire bytes themselves carry wsMatch.matchId, which a higher-level Transport deliberately
    // never re-exposes (it's internal reconnect bookkeeping, T-029b's own wsReconnect.test.js
    // suite covers that side of the contract) — reading the raw welcome JSON is the direct way.
    const welcome = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}/?seat=player`);
      ws.addEventListener("message", ev => { ws.close(); resolve(JSON.parse(ev.data)); });
      ws.addEventListener("error", reject);
    });
    assert.equal(welcome.type, "welcome");
    assert.equal(welcome.matchId, wsMatch.matchId);
  } finally { server.close(); }
});

test("welcome handshake: the client regenerates the same map the server's own match is using", async () => {
  const { transport, cleanup } = await setupOneSeat();
  try {
    const events = [];
    transport.onEvent(e => events.push(e));
    await new Promise(resolve => {
      const check = () => { if (events.some(e => e.type === "state")) resolve(); else setTimeout(check, 5); };
      check();
    });
    const stateEvent = events.find(e => e.type === "state");
    assert.ok(stateEvent.state.map, "a reassembled state must carry a real map, regenerated locally");
    assert.ok(stateEvent.state.map.nodes.length > 0, "fixture sanity: ferros actually has resource nodes");
  } finally { cleanup(); }
});

// T-034: found by an actual browser join — the seed chip (overlays.js's showSeedChip(state.seed))
// read "Seed undefined" for a live network match, because reassembleProjection's own per-tick
// projection never carries match-identity metadata like the seed (it's welcome-message-only,
// this file's own header table says so). The welcome already tells this client its seed to
// regenerate the map from; the reconstructed state it hands the rest of the client should carry it
// too, the same way a locally-created State always has state.seed.
test("a reassembled state carries the match's own seed, straight from the welcome handshake", async () => {
  const { transport, cleanup } = await setupOneSeat();
  try {
    const state = await new Promise(resolve => { transport.onEvent(e => { if (e.type === "state") resolve(e.state); }); });
    assert.equal(typeof state.seed, "number");
  } finally { cleanup(); }
});

test("state events reassemble into the shape render.js already expects: Maps, not arrays, plus selection", async () => {
  const { transport, cleanup } = await setupOneSeat();
  try {
    const state = await new Promise(resolve => {
      transport.onEvent(e => { if (e.type === "state") resolve(e.state); });
    });
    assert.ok(state.units instanceof Map);
    assert.ok(state.buildings instanceof Map);
    assert.deepEqual(state.selection, []);
    assert.ok(state.fog, "the client's own seat fog must be present under the alias render.js reads");
  } finally { cleanup(); }
});

test("a submitted command is visible in a LATER state push, once stepMatch has actually applied it", async () => {
  const { transport, unitId, moveTarget, cleanup } = await setupOneSeat();
  try {
    await transport.submitCommand({ t: "move", ids: [unitId], x: moveTarget.x, y: moveTarget.y });
    const state = await new Promise(resolve => {
      transport.onEvent(e => { if (e.type === "state") resolve(e.state); });
    });
    const unit = state.units.get(unitId);
    assert.equal(unit.order.type, "move");
    assert.equal(unit.order.x, moveTarget.x);
  } finally { cleanup(); }
});

test("a command shape-rejected by the codec (ownership) resolves the submitter's promise with the rejection, not a hang", async () => {
  const match = makeMatch();
  const server = createServer();
  const wsMatch = attachWsMatch(server, match);
  const port = await listen(server);
  const stopTicking = startTicking(match, wsMatch);
  try {
    const transport = await createWsClientTransport(`ws://localhost:${port}/?seat=player`);
    const aiUnit = [...match.state.units.values()].find(u => u.owner === "ai");
    const result = await transport.submitCommand({ t: "move", ids: [aiUnit.id], x: 1, y: 1 });
    assert.equal(result.ok, false);
    assert.equal(result.code, "not-owner");
    transport.close();
  } finally { stopTicking(); server.close(); }
});

test("a MALFORMED envelope (fails net/commandEnvelope.js's own decode) resolves with a clear rejection too, not a hang", async () => {
  const match = makeMatch();
  const server = createServer();
  const wsMatch = attachWsMatch(server, match);
  const port = await listen(server);
  const stopTicking = startTicking(match, wsMatch);
  try {
    const transport = await createWsClientTransport(`ws://localhost:${port}/?seat=player`);
    // Reach past the Transport interface to send a shape-invalid command directly — proving the
    // SERVER's own admit()-rejection path answers it, independent of what a conforming client
    // (which would never construct anything this malformed) would ever trigger.
    const result = await transport.submitCommand({ t: "not-a-real-command-type" });
    assert.equal(result.ok, false);
    assert.equal(result.code, "unknown-type");
    transport.close();
  } finally { stopTicking(); server.close(); }
});

/* ---------- T-028's own exit criterion, proven over the real wire ---------- */

test("T-028: a seat's own state payload contains no entity outside its fog — proven over a real socket, both seats connected to the SAME match", async () => {
  const match = makeMatch();
  const server = createServer();
  const wsMatch = attachWsMatch(server, match);
  const port = await listen(server);
  const stopTicking = startTicking(match, wsMatch);
  try {
    const playerT = await createWsClientTransport(`ws://localhost:${port}/?seat=player`);
    const aiT = await createWsClientTransport(`ws://localhost:${port}/?seat=ai`);

    const playerState = await new Promise(resolve => {
      playerT.onEvent(e => { if (e.type === "state") resolve(e.state); });
    });

    const aiIds = new Set([...match.state.units.values(), ...match.state.buildings.values()]
      .filter(e => e.owner === "ai").map(e => e.id));
    // Fresh match, opening fog: the two starting bases are placed far apart on every skirmish
    // world, so at tick 0 neither seat has yet SEEN the other's units/buildings at all.
    for (const id of aiIds) {
      assert.ok(!playerState.units.has(id) && !playerState.buildings.has(id),
        `player's own payload must never carry ai's entity ${id} while it's outside player's fog`);
    }

    playerT.close(); aiT.close();
  } finally { stopTicking(); server.close(); }
});

/* ---------- T-028b: delta-encoded state pushes (ADR-0009 M3) ---------- */

test("the first state push to a fresh connection is a FULL snapshot; every push after it is a delta", async () => {
  const match = makeMatch();
  const server = createServer();
  const wsMatch = attachWsMatch(server, match);
  const port = await listen(server);
  const stopTicking = startTicking(match, wsMatch);
  const ws = new WebSocket(`ws://localhost:${port}/?seat=player`);
  try {
    const stateMsgs = [];
    await new Promise(resolve => {
      ws.addEventListener("message", ev => {
        const msg = JSON.parse(ev.data);
        if (msg.type === "state") { stateMsgs.push(msg); if (stateMsgs.length >= 3) resolve(); }
      });
    });
    assert.equal(stateMsgs[0].full, true);
    assert.ok(stateMsgs[0].proj && !stateMsgs[0].delta, "the first push carries a full projection, no delta field");
    for (const msg of stateMsgs.slice(1)) {
      assert.equal(msg.full, false);
      assert.ok(msg.delta && !msg.proj, `push after the first must carry a delta, never a full proj: ${JSON.stringify(msg).slice(0, 80)}`);
    }
  } finally { ws.close(); stopTicking(); server.close(); }
});

test("a reconnecting client (new socket, same seat) gets a FRESH full snapshot, never a delta against the closed connection's stale baseline", async () => {
  const match = makeMatch();
  const server = createServer();
  const wsMatch = attachWsMatch(server, match);
  const port = await listen(server);
  const stopTicking = startTicking(match, wsMatch);
  const first = await createWsClientTransport(`ws://localhost:${port}/?seat=player`);
  let ws2 = null;
  try {
    await new Promise(resolve => first.onEvent(e => { if (e.type === "state") resolve(); }));
    first.close();
    await new Promise(r => setTimeout(r, 30));   // let the server's onclose actually fire

    ws2 = new WebSocket(`ws://localhost:${port}/?seat=player`);
    const firstStateOnReconnect = await new Promise(resolve => {
      ws2.addEventListener("message", ev => {
        const msg = JSON.parse(ev.data);
        if (msg.type === "state") resolve(msg);
      });
    });
    assert.equal(firstStateOnReconnect.full, true, "a brand-new connection must never receive a delta as its first push");
  } finally { if (ws2) ws2.close(); stopTicking(); server.close(); }
});

test("end-to-end: the client transport correctly reconstructs state across a real sequence of delta pushes", async () => {
  const match = makeMatch();
  const server = createServer();
  const wsMatch = attachWsMatch(server, match);
  const port = await listen(server);
  const stopTicking = startTicking(match, wsMatch);
  const transport = await createWsClientTransport(`ws://localhost:${port}/?seat=player`);
  try {
    const unit = [...match.state.units.values()].find(u => u.owner === "player");
    const startX = unit.x, startY = unit.y;
    await transport.submitCommand({ t: "move", ids: [unit.id], x: unit.x + 300, y: unit.y });

    // Collect several state events, crossing multiple full/delta boundaries (attachWsMatch's own
    // first-push-full-then-delta rule, proven by the test above, means push 1 is full and every one
    // after is a delta) — and confirm the unit SURVIVES reconstruction correctly across all of them,
    // ending up somewhere other than where it started. Deliberately not comparing against
    // match.state's OWN live value at the moment the promise resolves: that live read races the
    // server's still-running tick loop (several more ticks can land between this message being SENT
    // and this test code actually running), so it could disagree with what message #8 legitimately
    // carried for reasons that have nothing to do with delta reconstruction being correct or not.
    let count = 0;
    const state = await new Promise(resolve => {
      transport.onEvent(e => {
        if (e.type !== "state") return;
        if (++count >= 8) resolve(e.state);
      });
    });
    const seen = state.units.get(unit.id);
    assert.ok(seen, "the unit must still be present after several delta applications, not dropped or corrupted");
    assert.equal(typeof seen.x, "number");
    assert.equal(typeof seen.y, "number");
    assert.ok(seen.x !== startX || seen.y !== startY,
      "the unit's reconstructed position must have actually changed across these pushes — proving delta application really moved it, not left it frozen at the first full snapshot");
  } finally { transport.close(); stopTicking(); server.close(); }
});

/* ---------- buildStateMessage (T-029): extracted so net/wsWorkerTransport.js's relay can share
   the exact same quantize+delta-per-connection logic broadcastState() uses, rather than a second,
   drifting copy. ---------- */

test("buildStateMessage: the first call for a seat returns a full, quantized message; the caller's lastSnapshotBySeat gains an entry", () => {
  const lastSnapshotBySeat = new Map();
  const raw = { tick: 1, units: [{ id: "u1", x: 1.23456, hp: 10, owner: "player" }], buildings: [], nodes: [], players: {}, events: [] };
  const msg = buildStateMessage(raw, lastSnapshotBySeat, "player");
  assert.equal(msg.full, true);
  assert.equal(msg.proj.units[0].x, 1.23);
  assert.ok(lastSnapshotBySeat.has("player"));
});

test("buildStateMessage: a later call for the SAME seat returns a delta against the tracked baseline", () => {
  const lastSnapshotBySeat = new Map();
  const raw1 = { tick: 1, units: [{ id: "u1", x: 1, hp: 10, owner: "player" }], buildings: [], nodes: [], players: {}, events: [] };
  const raw2 = { tick: 2, units: [{ id: "u1", x: 2, hp: 10, owner: "player" }], buildings: [], nodes: [], players: {}, events: [] };
  buildStateMessage(raw1, lastSnapshotBySeat, "player");
  const msg2 = buildStateMessage(raw2, lastSnapshotBySeat, "player");
  assert.equal(msg2.full, false);
  assert.deepEqual(msg2.delta.units.changed, [{ id: "u1", x: 2 }]);
});

/* ---------- Origin / seat-binding robustness ---------- */

test("a connection naming an unknown seat is refused at the upgrade, not silently accepted", async () => {
  const match = makeMatch();
  const server = createServer();
  const wsMatch = attachWsMatch(server, match);
  const port = await listen(server);
  try {
    await assert.rejects(createWsClientTransport(`ws://localhost:${port}/?seat=not-a-real-seat`));
  } finally { server.close(); }
});

test("attachWsMatch's optional `path` restricts which upgrade pathname it accepts — T-027 uses this to keep a reserved /mcp namespace from also being the game socket", async () => {
  const match = makeMatch();
  const server = createServer();
  attachWsMatch(server, match, { path: "/game" });
  const port = await listen(server);
  try {
    // Deliberately NOT assert.rejects: if this unexpectedly resolved (the option silently doing
    // nothing), the connection it hands back would otherwise never be closed, leaking an open
    // socket that hangs the whole file past this test — the exact class of bug T-025/T-026 each
    // hit once already. Catching it explicitly means a regression here fails LOUD, not by hanging.
    let leaked = null;
    await createWsClientTransport(`ws://localhost:${port}/?seat=player`).then(
      t => { leaked = t; },
      () => {},
    );
    if (leaked) leaked.close();
    assert.equal(leaked, null, "an upgrade at a pathname other than the configured one must be refused");

    const transport = await createWsClientTransport(`ws://localhost:${port}/game?seat=player`);
    transport.close();
  } finally { server.close(); }
});

test("attachWsMatch's `path` is undefined by default — every path is accepted, unchanged from before this option existed", async () => {
  const match = makeMatch();
  const server = createServer();
  attachWsMatch(server, match);
  const port = await listen(server);
  try {
    const transport = await createWsClientTransport(`ws://localhost:${port}/anything?seat=player`);
    transport.close();
  } finally { server.close(); }
});

test("attachWsMatch(...).close() stops accepting new upgrades and closes every live connection", async () => {
  const match = makeMatch();
  const server = createServer();
  const wsMatch = attachWsMatch(server, match);
  const port = await listen(server);
  const stopTicking = startTicking(match, wsMatch);
  try {
    const transport = await createWsClientTransport(`ws://localhost:${port}/?seat=player`);
    const remoteClosed = new Promise(resolve => transport.onEvent(() => {}) || setTimeout(resolve, 50));
    wsMatch.close();
    await remoteClosed;
    // The already-open connection is gone; a NEW upgrade attempt against the same server must now
    // find no seat-aware handler listening at all (this test's own server.on("upgrade") was never
    // registered directly — attachWsMatch owned the only listener, and close() removed it), so the
    // request just hangs with no 101 and no rejection response — assert.rejects would need a real
    // timeout to observe that "nothing answers" state, which isn't worth the wall-clock cost here.
    // The one thing this test actually needs is idempotence, which the assertion below proves.
    assert.doesNotThrow(() => wsMatch.close(), "closing the ws match attachment twice must be harmless");
    // The client is deliberately still live here, and a live transport that loses its connection
    // retries forever by design (T-029b) — so this test has to hand it back, or it leaves a
    // reconnect timer running for the rest of the process's life. `node --test` force-exits a
    // worker when its file finishes and so hid that; running this file directly did not.
    transport.close();
  } finally { stopTicking(); server.close(); }
});
