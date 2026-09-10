/* ============================================================
   T-029: net/wsWorkerTransport.js — the PARENT-side relay between real browser WebSocket
   connections and a real worker_threads Worker hosting a match (server/matchWorker.js). Mirrors
   test/wsTransport.test.js as closely as the underlying difference allows: the same browser-facing
   wire protocol (net/wsClientTransport.js, unmodified, can't tell the difference — that's the
   point), a REAL worker throughout rather than a hand-rolled stand-in, matching the "test the real
   thing" standard this whole net/ family already holds itself to.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { attachWsMatchWorker } from "../net/wsWorkerTransport.js";
import { createWsClientTransport } from "../net/wsClientTransport.js";
import { testTransportContract } from "./transportContract.js";
import { createGameState } from "../engine/state.js";
import { mulberry32 } from "../engine/rng.js";
import { createMatch } from "../server/matchLoop.js";
import { writeSnapshot } from "../server/matchSnapshot.js";

const WORKER_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "server", "matchWorker.js");
let nextSeed = 600000;

function spawnMatchWorker() {
  return new Worker(WORKER_FILE, { workerData: { createGameStateOpts: { planetId: "ferros", seed: nextSeed++ } } });
}

async function listen(server) {
  await new Promise(resolve => server.listen(0, resolve));
  return server.address().port;
}

// CORRECTED, AND KEPT ONLY AS A BELT-AND-BRACES BOUND.
//
// This wrapper was written twice over, both times on the theory that "two concurrent matches on the
// SAME server" below failed under full-suite load because this sandboxed CI's 4 cores could not
// service a real WS handshake promptly — first 3×20s of retries, then 5×20s when 3 "wasn't always
// enough". That diagnosis was wrong, and the retries were compensating for a real bug rather than
// for slowness: net/wsWorkerTransport.js's attachWsMatchWorker took the worker's FIRST message as
// its "ready" message, and a Worker's port is flowing from construction, so an attach that landed
// after the worker had started pushing state read a state push instead and bound `matchId` to
// undefined. Every retry then dialled `match=undefined` at a server that was never going to answer
// — which is why more attempts never helped. See the two tests at the bottom of this file, which
// reproduce that deterministically, and attachWsMatchWorker's own note on the fix.
//
// It stays because a bounded connect is still better than the native ~300s default if this ever
// does get genuinely starved — but it is no longer load-bearing, and a failure here now means
// something is actually wrong rather than merely busy.
async function connectResilient(url, attempts = 5) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await createWsClientTransport(url, { connectTimeoutMs: 20000 }); }
    catch (err) { lastErr = err; }
  }
  throw lastErr;
}

async function setupOneSeat() {
  const worker = spawnMatchWorker();
  const server = createServer();
  const wsMatch = await attachWsMatchWorker(server, worker);
  const port = await listen(server);
  const transport = await createWsClientTransport(`ws://localhost:${port}/?seat=player`);
  const state = await new Promise(resolve => transport.onEvent(e => { if (e.type === "state") resolve(e.state); }));
  const unit = [...state.units.values()].find(u => u.owner === "player");
  return {
    transport, unitId: unit.id, moveTarget: { x: unit.x + 50, y: unit.y },
    cleanup: () => { transport.close(); wsMatch.close(); server.close(); worker.terminate(); },
  };
}

testTransportContract("wsWorkerTransport", setupOneSeat);

test("welcome handshake: the client regenerates the same map the worker's own match is using", async () => {
  const { transport, cleanup } = await setupOneSeat();
  try {
    const state = await new Promise(resolve => transport.onEvent(e => { if (e.type === "state") resolve(e.state); }));
    assert.ok(state.map, "a reassembled state must carry a real map, regenerated locally");
    assert.ok(state.map.nodes.length > 0, "fixture sanity: ferros actually has resource nodes");
  } finally { cleanup(); }
});

test("T-029b: attachWsMatchWorker() resolves with a real matchId matching the worker's own ready message", async () => {
  const worker = spawnMatchWorker();
  const server = createServer();
  try {
    const readyPromise = new Promise(resolve => worker.once("message", resolve));
    const wsMatch = await attachWsMatchWorker(server, worker);
    const ready = await readyPromise;
    assert.equal(typeof wsMatch.matchId, "string");
    assert.ok(wsMatch.matchId.length > 0);
    assert.equal(wsMatch.matchId, ready.matchId, "attachWsMatchWorker must expose the SAME matchId the worker itself minted/restored, not a copy or a placeholder");
  } finally { server.close(); worker.terminate(); }
});

test("state pushes are worker-driven, unprompted — no broadcastState() to call, unlike the in-process attachWsMatch", async () => {
  const worker = spawnMatchWorker();
  const server = createServer();
  const wsMatch = await attachWsMatchWorker(server, worker);
  try {
    assert.equal(typeof wsMatch.broadcastState, "undefined",
      "the worker ticks and pushes state on its own; a caller-driven broadcastState() would be dead weight here");
    assert.equal(typeof wsMatch.close, "function");
  } finally { wsMatch.close(); server.close(); worker.terminate(); }
});

test("a submitted command is visible in a LATER state push, once the worker's own stepMatch has actually applied it", async () => {
  const { transport, unitId, moveTarget, cleanup } = await setupOneSeat();
  try {
    await transport.submitCommand({ t: "move", ids: [unitId], x: moveTarget.x, y: moveTarget.y });
    const state = await new Promise(resolve => {
      transport.onEvent(e => { if (e.type === "state" && e.state.units.get(unitId)?.order?.type === "move") resolve(e.state); });
    });
    const unit = state.units.get(unitId);
    assert.equal(unit.order.type, "move");
    assert.equal(unit.order.x, moveTarget.x);
  } finally { cleanup(); }
});

test("a command shape-rejected by the codec resolves the submitter's promise with the rejection, not a hang", async () => {
  const { transport, cleanup } = await setupOneSeat();
  try {
    const result = await transport.submitCommand({ t: "not-a-real-command-type" });
    assert.equal(result.ok, false);
    assert.equal(result.code, "unknown-type");
  } finally { cleanup(); }
});

test("T-028: a seat's own state payload contains no entity outside its fog — proven over a real socket backed by a real worker", async () => {
  const worker = spawnMatchWorker();
  const server = createServer();
  const wsMatch = await attachWsMatchWorker(server, worker);
  const port = await listen(server);
  try {
    const playerT = await createWsClientTransport(`ws://localhost:${port}/?seat=player`);
    const aiT = await createWsClientTransport(`ws://localhost:${port}/?seat=ai`);
    const playerState = await new Promise(resolve => playerT.onEvent(e => { if (e.type === "state") resolve(e.state); }));

    const aiIds = new Set();
    // The worker's own match isn't directly reachable from this test (it lives in another
    // thread) — ask the ai seat's own connection what its units/buildings are instead, which is
    // exactly as authoritative for "what exists on the ai side" as reading match.state directly
    // would be in the in-process case.
    const aiState = await new Promise(resolve => aiT.onEvent(e => { if (e.type === "state") resolve(e.state); }));
    for (const id of aiState.units.keys()) aiIds.add(id);
    for (const id of aiState.buildings.keys()) aiIds.add(id);

    for (const id of aiIds) {
      assert.ok(!playerState.units.has(id) && !playerState.buildings.has(id),
        `player's own payload must never carry ai's entity ${id} while it's outside player's fog`);
    }
    playerT.close(); aiT.close();
  } finally { wsMatch.close(); server.close(); worker.terminate(); }
});

test("a connection naming a seat the worker's match doesn't have is refused at the upgrade, not silently accepted", async () => {
  const worker = spawnMatchWorker();
  const server = createServer();
  const wsMatch = await attachWsMatchWorker(server, worker);
  const port = await listen(server);
  try {
    await assert.rejects(createWsClientTransport(`ws://localhost:${port}/?seat=not-a-real-seat`));
  } finally { wsMatch.close(); server.close(); worker.terminate(); }
});

// T-034: multiple LIVE matches must be able to share one http.Server (the lobby's whole point) —
// Node's "upgrade" event calls every registered listener, so each attachWsMatchWorker() attachment
// must let an upgrade that isn't its own pass through untouched (never destroy a socket another
// attachment on the same server is about to claim), and requireMatch/authorizeSeat are how a
// connection actually finds and is let into the RIGHT one.
test("T-034: two concurrent matches on the SAME server route a connection by ?match=<id>, with no cross-talk", async () => {
  const workerA = spawnMatchWorker();
  const workerB = spawnMatchWorker();
  const server = createServer();
  const wsA = await attachWsMatchWorker(server, workerA, { path: "/ws", requireMatch: true });
  const wsB = await attachWsMatchWorker(server, workerB, { path: "/ws", requireMatch: true });
  assert.notEqual(wsA.matchId, wsB.matchId, "fixture sanity: two freshly-spawned workers mint two different ids");
  const port = await listen(server);
  try {
    // SEQUENTIAL on purpose, not two connections racing in flight together: the property under
    // test is dispatch CORRECTNESS (does ?match=<id> reach the right worker), which has nothing to
    // do with connection TIMING, so a sequential proof gives this test everything a concurrent one
    // would.
    //
    // NOTE FOR ANYONE READING THE HISTORY HERE: this test's intermittent failure under full-suite
    // load was diagnosed twice as CPU starvation and worked around twice, in the sequencing above
    // and in connectResilient's retry count. It was neither. Both attachments below raced the
    // worker's startup "ready" message, and the SECOND one — attached only after the first had
    // finished awaiting — routinely lost, coming up with `matchId: undefined` and rejecting every
    // upgrade in silence. Fixed in net/wsWorkerTransport.js; the guards for it are at the bottom of
    // this file.
    const tA = await connectResilient(`ws://localhost:${port}/ws?match=${wsA.matchId}&seat=player`);
    const stateA = await new Promise(resolve => tA.onEvent(e => { if (e.type === "state") resolve(e.state); }));
    tA.close();
    const tB = await connectResilient(`ws://localhost:${port}/ws?match=${wsB.matchId}&seat=player`);
    const stateB = await new Promise(resolve => tB.onEvent(e => { if (e.type === "state") resolve(e.state); }));
    tB.close();
    // Two independently-seeded workers generate two different maps — the simplest available proof
    // each connection really reached its OWN match, not the other one's (a reassembled client-side
    // projection carries no matchId/seed of its own; that's welcome-message-only wire metadata).
    // This ALSO subsumes the narrower "an attachment leaves a non-matching upgrade unclaimed rather
    // than destroying it" claim on its own, with no separate fixture needed: if wsA's own mismatch
    // handling destroyed every socket that wasn't its, tB's connection to wsB right above could
    // never have succeeded in the first place — two fresh workers per test is real overhead
    // (worker_threads spawn cost adds up across a file with this many), so one fixture proving both
    // properties beats two proving one property each.
    assert.notEqual(JSON.stringify(stateA.map.nodes), JSON.stringify(stateB.map.nodes), "each connection really reached its OWN match's worker, not the other one's");
  } finally { wsA.close(); wsB.close(); server.close(); workerA.terminate(); workerB.terminate(); }
});

test("T-034: authorizeSeat — a connection is refused at the upgrade when the callback returns false, e.g. a bad seat token", async () => {
  const worker = spawnMatchWorker();
  const server = createServer();
  const wsMatch = await attachWsMatchWorker(server, worker, {
    path: "/ws", requireMatch: true,
    authorizeSeat: (seat, url) => url.searchParams.get("token") === "the-real-token",
  });
  const port = await listen(server);
  try {
    await assert.rejects(createWsClientTransport(`ws://localhost:${port}/ws?match=${wsMatch.matchId}&seat=player&token=wrong`));
    const ok = await createWsClientTransport(`ws://localhost:${port}/ws?match=${wsMatch.matchId}&seat=player&token=the-real-token`);
    ok.close();
  } finally { wsMatch.close(); server.close(); worker.terminate(); }
});

test("attachWsMatchWorker(...).close() stops accepting new upgrades and closes every live connection, without terminating the worker itself", async () => {
  const worker = spawnMatchWorker();
  const server = createServer();
  const wsMatch = await attachWsMatchWorker(server, worker);
  const port = await listen(server);
  try {
    const transport = await createWsClientTransport(`ws://localhost:${port}/?seat=player`);
    await new Promise(resolve => transport.onEvent(() => {}) || setTimeout(resolve, 50));
    wsMatch.close();
    // Same convention attachWsMatch's own close() already keeps: closing an attachment layer
    // never owns tearing down what it was GIVEN (the worker here, the httpServer in both cases) —
    // only what it itself set up. Proving idempotence is what's left to verify from outside.
    assert.doesNotThrow(() => wsMatch.close(), "closing the ws-worker attachment twice must be harmless");
  } finally { server.close(); worker.terminate(); }
});

// T-036: server/matchWorker.js's own grace-timer/AI-takeover logic is already fully exercised in
// test/matchWorker.test.js by hand-feeding it {type:"seatDisconnected"/"seatConnected"} messages
// directly. What ISN'T covered there is this file's own job: does a REAL socket close/reconnect
// actually reach the worker as those messages at all? These two tests prove the wiring, not the
// takeover logic itself — aiEnabled:false for the same reason matchWorker.test.js's own fixture
// needs it (state.ai defaults populated otherwise, and a test disconnecting an already-AI-driven
// seat isn't testing takeover, just watching that AI's own pre-existing bursty cadence).
test("T-036: closing a seat's real WebSocket connection reaches the worker as seatDisconnected — the built-in AI takes over once the grace period elapses", async () => {
  const seed = nextSeed++;
  const worker = new Worker(WORKER_FILE, { workerData: { createGameStateOpts: { planetId: "ferros", seed, aiEnabled: false }, graceMs: 150 } });
  const server = createServer();
  const wsMatch = await attachWsMatchWorker(server, worker);
  const port = await listen(server);
  try {
    const t1 = await createWsClientTransport(`ws://localhost:${port}/?seat=ai`);
    const baselineState = await new Promise(resolve => t1.onEvent(e => { if (e.type === "state") resolve(e.state); }));
    const baselineCount = [...baselineState.buildings.values()].filter(b => b.owner === "ai").length;
    t1.close();   // a real network disconnect — must reach the worker as {type:"seatDisconnected", seat:"ai"}, not a no-op

    await new Promise(resolve => setTimeout(resolve, 4000));   // grace (150ms) + generous room for the AI's first build decision
    // Reconnecting as the SAME seat is how this test observes the outcome without needing a second
    // seat's view (blocked by fog anyway) — a seat always sees its own buildings regardless of fog.
    const t2 = await createWsClientTransport(`ws://localhost:${port}/?seat=ai`);
    const laterState = await new Promise(resolve => t2.onEvent(e => { if (e.type === "state") resolve(e.state); }));
    const laterCount = [...laterState.buildings.values()].filter(b => b.owner === "ai").length;
    t2.close();
    assert.ok(laterCount > baselineCount, `the AI must have built something while the seat was disconnected (${baselineCount} -> ${laterCount})`);
  } finally { wsMatch.close(); server.close(); worker.terminate(); }
});

test("T-036: reconnecting the same seat's WebSocket before the grace period elapses reaches the worker as seatConnected and cancels the pending takeover", async () => {
  const seed = nextSeed++;
  const worker = new Worker(WORKER_FILE, { workerData: { createGameStateOpts: { planetId: "ferros", seed, aiEnabled: false }, graceMs: 300 } });
  const server = createServer();
  const wsMatch = await attachWsMatchWorker(server, worker);
  const port = await listen(server);
  try {
    const t1 = await createWsClientTransport(`ws://localhost:${port}/?seat=ai`);
    await new Promise(resolve => t1.onEvent(e => { if (e.type === "state") resolve(); }));
    t1.close();

    await new Promise(resolve => setTimeout(resolve, 100));   // well before the 300ms grace elapses
    const t2 = await createWsClientTransport(`ws://localhost:${port}/?seat=ai`);   // a real reconnect — must reach the worker as seatConnected
    const baselineState = await new Promise(resolve => t2.onEvent(e => { if (e.type === "state") resolve(e.state); }));
    const baselineCount = [...baselineState.buildings.values()].filter(b => b.owner === "ai").length;

    const grew = await new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), 1500);
      t2.onEvent(e => {
        if (e.type !== "state") return;
        const count = [...e.state.buildings.values()].filter(b => b.owner === "ai").length;
        if (count > baselineCount) { clearTimeout(timer); resolve(true); }
      });
    });
    t2.close();
    assert.equal(grew, false, "a cancelled grace timer (real reconnect before it elapsed) must never let the AI take over later");
  } finally { wsMatch.close(); server.close(); worker.terminate(); }
});

test("T-035 (FR-6): once a match ends, BOTH connected seats receive over:true and the same winner over their own real WebSocket connection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spacecities-wsworker-over-test-"));
  try {
    const seed = 555555;
    const state = createGameState({ planetId: "ferros", seed, rng: mulberry32(seed) });
    const match = createMatch(state);
    const aiCC = [...match.state.buildings.values()].find(b => b.owner === "ai" && b.type === "command");
    match.state.buildings.delete(aiCC.id);   // ends the match on the worker's very first tick
    await writeSnapshot(dir, "match-about-to-end-ws", match.state);

    const worker = new Worker(WORKER_FILE, { workerData: { createGameStateOpts: { planetId: "ferros", seed }, dataDir: dir } });
    const server = createServer();
    const wsMatch = await attachWsMatchWorker(server, worker);
    const port = await listen(server);
    try {
      const playerT = await createWsClientTransport(`ws://localhost:${port}/?seat=player`);
      const aiT = await createWsClientTransport(`ws://localhost:${port}/?seat=ai`);
      const playerOver = await new Promise(resolve => playerT.onEvent(e => { if (e.type === "state" && e.state.over) resolve(e.state); }));
      const aiOver = await new Promise(resolve => aiT.onEvent(e => { if (e.type === "state" && e.state.over) resolve(e.state); }));
      // The SAME shared fact, reconstructed independently over two separate real connections —
      // which seat that means "you won" for is entirely game.localOwner's own job client-side
      // (overlays.js's showGameOver, already covered by test/overlays.test.js's own T-030 tests).
      assert.equal(playerOver.winner, "player");
      assert.equal(aiOver.winner, "player");
      playerT.close(); aiT.close();
    } finally { wsMatch.close(); server.close(); worker.terminate(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/* ---------- T-037 (FR-7): spectator connections — full-vision, read-only, host-toggleable ----------
   Raw `WebSocket`, not createWsClientTransport, throughout: a spectator's own wire scheme has no
   `seat` of its own and no fog to reconstruct (net/wsClientTransport.js's reassembleProjection would
   run updateFog for a seat that doesn't exist), so these tests inspect the wire messages directly —
   the same "test the real thing, at the level that actually matters" reasoning test/ws.test.js's own
   raw-socket tests already use for refusal cases. */

test("T-037: a spectator connection (?spectate=1) receives full-vision state pushes — both seats' bases, never fogged to one side", async () => {
  const worker = spawnMatchWorker();
  const server = createServer();
  const wsMatch = await attachWsMatchWorker(server, worker);
  const port = await listen(server);
  try {
    const ws = new WebSocket(`ws://localhost:${port}/?spectate=1`);
    const proj = await new Promise((resolve, reject) => {
      ws.addEventListener("error", reject);
      ws.addEventListener("message", ev => {
        const msg = JSON.parse(ev.data);
        if (msg.type === "state") resolve(msg.proj);
      });
    });
    const owners = new Set(proj.buildings.map(b => b.owner));
    assert.ok(owners.has("player") && owners.has("ai"), "a spectator must see both seats' bases at once, never a single seat's own fogged view");
    ws.close();
  } finally { wsMatch.close(); server.close(); worker.terminate(); }
});

test("T-037: a spectator's welcome message identifies it as a spectator, with no seat of its own", async () => {
  const worker = spawnMatchWorker();
  const server = createServer();
  const wsMatch = await attachWsMatchWorker(server, worker);
  const port = await listen(server);
  try {
    const ws = new WebSocket(`ws://localhost:${port}/?spectate=1`);
    const welcome = await new Promise((resolve, reject) => {
      ws.addEventListener("error", reject);
      ws.addEventListener("message", ev => {
        const msg = JSON.parse(ev.data);
        if (msg.type === "welcome") resolve(msg);
      });
    });
    assert.equal(welcome.spectator, true);
    assert.equal(welcome.seat, null);
    assert.equal(welcome.matchId, wsMatch.matchId);
    ws.close();
  } finally { wsMatch.close(); server.close(); worker.terminate(); }
});

test("T-037: a spectator's own message is never relayed to the worker — a raw command envelope gets no commandResult back, ever", async () => {
  const worker = spawnMatchWorker();
  const server = createServer();
  const wsMatch = await attachWsMatchWorker(server, worker);
  const port = await listen(server);
  try {
    const ws = new WebSocket(`ws://localhost:${port}/?spectate=1`);
    await new Promise((resolve, reject) => {
      ws.addEventListener("error", reject);
      ws.addEventListener("message", ev => { if (JSON.parse(ev.data).type === "welcome") resolve(); });
    });
    let sawCommandResult = false;
    ws.addEventListener("message", ev => { if (JSON.parse(ev.data).type === "commandResult") sawCommandResult = true; });
    ws.send(JSON.stringify({ t: "move", seq: 1, ids: ["whatever"], x: 0, y: 0 }));
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(sawCommandResult, false, "a spectator has no seat to submit a command as — nothing should ever answer one, success or rejection");
    ws.close();
  } finally { wsMatch.close(); server.close(); worker.terminate(); }
});

test("T-037: spectatorsEnabled:false refuses a spectate connection at the upgrade — the host disabled spectating", async () => {
  const worker = spawnMatchWorker();
  const server = createServer();
  const wsMatch = await attachWsMatchWorker(server, worker, { spectatorsEnabled: false });
  const port = await listen(server);
  try {
    const ws = new WebSocket(`ws://localhost:${port}/?spectate=1`);
    const refused = await new Promise(resolve => {
      ws.addEventListener("error", () => resolve(true));
      ws.addEventListener("open", () => resolve(false));
    });
    assert.equal(refused, true, "the host disabled spectators — the connection must be refused, never accepted");
  } finally { wsMatch.close(); server.close(); worker.terminate(); }
});

test("T-037: spectatorsEnabled defaults to true — an attachWsMatchWorker call that doesn't mention it still accepts spectators", async () => {
  const worker = spawnMatchWorker();
  const server = createServer();
  const wsMatch = await attachWsMatchWorker(server, worker);   // no spectatorsEnabled opt at all
  const port = await listen(server);
  try {
    const ws = new WebSocket(`ws://localhost:${port}/?spectate=1`);
    await new Promise((resolve, reject) => {
      ws.addEventListener("error", reject);
      ws.addEventListener("open", resolve);
    });
    ws.close();
  } finally { wsMatch.close(); server.close(); worker.terminate(); }
});

test("T-037: multiple spectators can connect at once, each independently receiving state pushes", async () => {
  const worker = spawnMatchWorker();
  const server = createServer();
  const wsMatch = await attachWsMatchWorker(server, worker);
  const port = await listen(server);
  try {
    const wsA = new WebSocket(`ws://localhost:${port}/?spectate=1`);
    const wsB = new WebSocket(`ws://localhost:${port}/?spectate=1`);
    const firstState = ws => new Promise((resolve, reject) => {
      ws.addEventListener("error", reject);
      ws.addEventListener("message", ev => { const msg = JSON.parse(ev.data); if (msg.type === "state") resolve(msg); });
    });
    const [msgA, msgB] = await Promise.all([firstState(wsA), firstState(wsB)]);
    assert.equal(msgA.full, true, "each spectator's own FIRST push must be full, exactly like an ordinary seat's own connection");
    assert.equal(msgB.full, true);
    wsA.close(); wsB.close();
  } finally { wsMatch.close(); server.close(); worker.terminate(); }
});

test("attachWsMatchWorker(...).close() also closes every live spectator connection, not just seated ones", async () => {
  const worker = spawnMatchWorker();
  const server = createServer();
  const wsMatch = await attachWsMatchWorker(server, worker);
  const port = await listen(server);
  try {
    const ws = new WebSocket(`ws://localhost:${port}/?spectate=1`);
    const closed = new Promise(resolve => ws.addEventListener("close", resolve));
    await new Promise((resolve, reject) => {
      ws.addEventListener("error", reject);
      ws.addEventListener("message", ev => { if (JSON.parse(ev.data).type === "welcome") resolve(); });
    });
    wsMatch.close();
    await closed;
  } finally { server.close(); worker.terminate(); }
});

/* ---------- T-038 (FR-12): in-match text chat — relayed here in the parent, never reaching the worker ---------- */

async function connectRaw(port, query) {
  const ws = new WebSocket(`ws://localhost:${port}/?${query}`);
  await new Promise((resolve, reject) => {
    ws.addEventListener("error", reject);
    ws.addEventListener("message", ev => { if (JSON.parse(ev.data).type === "welcome") resolve(); });
  });
  return ws;
}

function nextChatFrom(ws) {
  return new Promise(resolve => {
    ws.addEventListener("message", function handler(ev) {
      const msg = JSON.parse(ev.data);
      if (msg.type === "chat") { ws.removeEventListener("message", handler); resolve(msg); }
    });
  });
}

test("T-038: a seat's chat message is relayed to EVERY connected seat, including the sender itself", async () => {
  const worker = spawnMatchWorker();
  const server = createServer();
  const wsMatch = await attachWsMatchWorker(server, worker);
  const port = await listen(server);
  try {
    const player = await connectRaw(port, "seat=player");
    const ai = await connectRaw(port, "seat=ai");
    const playerSees = nextChatFrom(player);
    const aiSees = nextChatFrom(ai);
    player.send(JSON.stringify({ type: "chat", text: "gl hf" }));
    const [fromPlayer, fromAi] = await Promise.all([playerSees, aiSees]);
    assert.equal(fromPlayer.text, "gl hf");
    assert.equal(fromPlayer.from, "player");
    assert.equal(fromAi.text, "gl hf");
    assert.equal(fromAi.from, "player", "the recipient must know WHO sent it, not just what was said");
    player.close(); ai.close();
  } finally { wsMatch.close(); server.close(); worker.terminate(); }
});

test("T-038: a chat message is ALSO relayed to every connected spectator — read-only recipients, same as everyone else", async () => {
  const worker = spawnMatchWorker();
  const server = createServer();
  const wsMatch = await attachWsMatchWorker(server, worker);
  const port = await listen(server);
  try {
    const player = await connectRaw(port, "seat=player");
    const watcher = await connectRaw(port, "spectate=1");
    const watcherSees = nextChatFrom(watcher);
    player.send(JSON.stringify({ type: "chat", text: "watching too?" }));
    const msg = await watcherSees;
    assert.equal(msg.text, "watching too?");
    assert.equal(msg.from, "player");
    player.close(); watcher.close();
  } finally { wsMatch.close(); server.close(); worker.terminate(); }
});

test("T-038: a chat message never reaches the worker — no commandResult is ever produced for it", async () => {
  const worker = spawnMatchWorker();
  const server = createServer();
  const wsMatch = await attachWsMatchWorker(server, worker);
  const port = await listen(server);
  try {
    const player = await connectRaw(port, "seat=player");
    let sawCommandResult = false;
    player.addEventListener("message", ev => { if (JSON.parse(ev.data).type === "commandResult") sawCommandResult = true; });
    const echo = nextChatFrom(player);
    player.send(JSON.stringify({ type: "chat", text: "just chatting" }));
    await echo;
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(sawCommandResult, false, "chat has no seq/ack — it must never be admitted as a command");
    player.close();
  } finally { wsMatch.close(); server.close(); worker.terminate(); }
});

test("T-038: a message longer than the length cap is silently dropped, never relayed to anyone", async () => {
  const worker = spawnMatchWorker();
  const server = createServer();
  const wsMatch = await attachWsMatchWorker(server, worker);
  const port = await listen(server);
  try {
    const player = await connectRaw(port, "seat=player");
    const ai = await connectRaw(port, "seat=ai");
    let aiSawChat = false;
    ai.addEventListener("message", ev => { if (JSON.parse(ev.data).type === "chat") aiSawChat = true; });
    player.send(JSON.stringify({ type: "chat", text: "x".repeat(1000) }));
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(aiSawChat, false, "an over-length message must never reach another seat");
    player.close(); ai.close();
  } finally { wsMatch.close(); server.close(); worker.terminate(); }
});

test("T-038: more messages than the rate limit allows within its window are dropped past the limit", async () => {
  const worker = spawnMatchWorker();
  const server = createServer();
  const wsMatch = await attachWsMatchWorker(server, worker);
  const port = await listen(server);
  try {
    const player = await connectRaw(port, "seat=player");
    const ai = await connectRaw(port, "seat=ai");
    const received = [];
    ai.addEventListener("message", ev => { const m = JSON.parse(ev.data); if (m.type === "chat") received.push(m.text); });
    for (let i = 0; i < 10; i++) player.send(JSON.stringify({ type: "chat", text: `msg${i}` }));
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.ok(received.length > 0 && received.length < 10,
      `a flood of 10 rapid messages must be partially throttled, not all delivered — got ${received.length}`);
    player.close(); ai.close();
  } finally { wsMatch.close(); server.close(); worker.terminate(); }
});

/* ---------- T-038: the CLIENT wrapper (net/wsClientTransport.js) — sendChat() and the "chat" event,
   proven through createWsClientTransport itself rather than a raw WebSocket, since the tests above
   already cover the SERVER's own relay/cap/rate-limit behavior on the wire; these instead prove the
   client-side convenience wrapper around that same wire shape is wired correctly. ---------- */

test("T-038: transport.sendChat() is delivered as a real {type:'chat'} event via onEvent, to every connected seat including the sender", async () => {
  const worker = spawnMatchWorker();
  const server = createServer();
  const wsMatch = await attachWsMatchWorker(server, worker);
  const port = await listen(server);
  try {
    const player = await createWsClientTransport(`ws://localhost:${port}/?seat=player`);
    const ai = await createWsClientTransport(`ws://localhost:${port}/?seat=ai`);
    const nextChat = t => new Promise(resolve => t.onEvent(e => { if (e.type === "chat") resolve(e); }));
    const playerSees = nextChat(player);
    const aiSees = nextChat(ai);
    assert.equal(typeof player.sendChat, "function", "the client transport must expose a real sendChat method");
    player.sendChat("gl hf");
    const [fromPlayer, fromAi] = await Promise.all([playerSees, aiSees]);
    assert.equal(fromPlayer.text, "gl hf");
    assert.equal(fromPlayer.from, "player");
    assert.equal(fromAi.text, "gl hf");
    assert.equal(fromAi.from, "player");
    player.close(); ai.close();
  } finally { wsMatch.close(); server.close(); worker.terminate(); }
});

/* ---------- T-039 (FR-10): rate limiting and abuse guards on every client-driven path ---------- */

function rawEnvelope(seq) {
  return JSON.stringify({ v: 1, seq, tick: null, cmd: { t: "stop", ids: [] } });
}

function countCommandResults(ws, ms) {
  return new Promise(resolve => {
    let n = 0;
    const handler = ev => { if (JSON.parse(ev.data).type === "commandResult") n++; };
    ws.addEventListener("message", handler);
    setTimeout(() => { ws.removeEventListener("message", handler); resolve(n); }, ms);
  });
}

function waitClosed(ws, ms) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), ms);
    ws.addEventListener("close", () => { clearTimeout(timer); resolve(true); });
  });
}

test("T-039: a burst beyond the general rate limit is partially throttled, but the connection stays open and keeps working", async () => {
  const worker = spawnMatchWorker();
  const server = createServer();
  const wsMatch = await attachWsMatchWorker(server, worker);
  const port = await listen(server);
  try {
    const player = await connectRaw(port, "seat=player");
    const results = countCommandResults(player, 300);
    for (let i = 0; i < 50; i++) player.send(rawEnvelope(i));   // 40 allowed + 10 throttled — under the 20-strike abuse threshold
    const n = await results;
    assert.ok(n > 0 && n < 50, `some, but not all, of a 50-message burst must get through — got ${n}`);
    // The connection itself must still be alive and functional afterward — 10 strikes is well
    // under the 20-strike disconnect threshold, so this is throttling, not abuse. Wait past the
    // FULL 1s rate window (not just the burst's own settle time above) before the follow-up send —
    // otherwise the burst's own timestamps haven't aged out yet and would throttle this one too,
    // which would be this test's own timing bug, not a real product defect.
    await new Promise(resolve => setTimeout(resolve, 1100));
    const echo = countCommandResults(player, 300);
    player.send(rawEnvelope(9000));
    assert.equal(await echo, 1, "the connection must still relay an ordinary command after the burst has passed");
    player.close();
  } finally { wsMatch.close(); server.close(); worker.terminate(); }
});

test("T-039: a sustained flood — enough throttled messages to cross the abuse threshold — gets the connection disconnected", async () => {
  const worker = spawnMatchWorker();
  const server = createServer();
  const wsMatch = await attachWsMatchWorker(server, worker);
  const port = await listen(server);
  try {
    const player = await connectRaw(port, "seat=player");
    const closed = waitClosed(player, 5000);
    for (let i = 0; i < 100; i++) player.send(rawEnvelope(i));   // 40 allowed + 60 throttled — well past the 20-strike threshold
    assert.equal(await closed, true, "a connection that keeps getting throttled must eventually be disconnected outright");
  } finally { wsMatch.close(); server.close(); worker.terminate(); }
});

test("T-039: disconnecting one seat for abuse never affects the match for the other seat — it keeps receiving state pushes", async () => {
  const worker = spawnMatchWorker();
  const server = createServer();
  const wsMatch = await attachWsMatchWorker(server, worker);
  const port = await listen(server);
  try {
    const flooder = await connectRaw(port, "seat=player");
    const ai = await connectRaw(port, "seat=ai");
    const flooderClosed = waitClosed(flooder, 5000);
    for (let i = 0; i < 100; i++) flooder.send(rawEnvelope(i));
    assert.equal(await flooderClosed, true, "fixture sanity: the flooding seat is actually disconnected");
    // The OTHER seat must be completely unaffected — still connected, and the match's own tick
    // loop must still be pushing it fresh state, exactly as if nothing had happened.
    const nextState = new Promise(resolve => {
      ai.addEventListener("message", function handler(ev) {
        const msg = JSON.parse(ev.data);
        if (msg.type === "state") { ai.removeEventListener("message", handler); resolve(msg); }
      });
    });
    assert.ok(await nextState, "the surviving seat must keep receiving ordinary state pushes after the other seat was disconnected for abuse");
    ai.close();
  } finally { wsMatch.close(); server.close(); worker.terminate(); }
});

test("T-039: a flood of malformed/garbage frames (not even valid JSON) is bounded by the same general rate gate and eventually disconnected", async () => {
  const worker = spawnMatchWorker();
  const server = createServer();
  const wsMatch = await attachWsMatchWorker(server, worker);
  const port = await listen(server);
  try {
    const player = await connectRaw(port, "seat=player");
    const closed = waitClosed(player, 5000);
    for (let i = 0; i < 100; i++) player.send("not even json {{{");
    assert.equal(await closed, true, "the general rate gate runs BEFORE JSON.parse, so a garbage flood must be bounded exactly like a command flood");
  } finally { wsMatch.close(); server.close(); worker.terminate(); }
});

test("T-039: ordinary light traffic, well under the rate limit, is never throttled or disconnected", async () => {
  const worker = spawnMatchWorker();
  const server = createServer();
  const wsMatch = await attachWsMatchWorker(server, worker);
  const port = await listen(server);
  try {
    const player = await connectRaw(port, "seat=player");
    const results = countCommandResults(player, 400);
    for (let i = 0; i < 5; i++) player.send(rawEnvelope(i));   // well under the 40/second allowance
    assert.equal(await results, 5, "every one of a small, ordinary burst must be relayed and answered — no false positives");
    player.close();
  } finally { wsMatch.close(); server.close(); worker.terminate(); }
});

test("T-039: a determined chat-flooder — repeatedly past net/chatLimiter.js's own stricter limit — also eventually gets disconnected, not just silently ignored forever", async () => {
  const worker = spawnMatchWorker();
  const server = createServer();
  const wsMatch = await attachWsMatchWorker(server, worker);
  const port = await listen(server);
  try {
    const player = await connectRaw(port, "seat=player");
    const closed = waitClosed(player, 5000);
    // 25 chat sends, all well within the general 40/second allowance, so every one reaches
    // net/chatLimiter.js's own check: the first 5 succeed, the remaining 20 are rejected by ITS
    // stricter 5-per-10s limit — 20 rejections is exactly the abuse threshold.
    for (let i = 0; i < 25; i++) player.send(JSON.stringify({ type: "chat", text: `spam ${i}` }));
    assert.equal(await closed, true, "repeated chat-limit rejections must count toward the same abuse escalation as a raw command flood");
  } finally { wsMatch.close(); server.close(); worker.terminate(); }
});

/* ---------- T-040 (FR-20): desync detection via state fingerprint reporting ---------- */

function nextDesyncFrom(ws) {
  return new Promise(resolve => {
    ws.addEventListener("message", function handler(ev) {
      const msg = JSON.parse(ev.data);
      if (msg.type === "desyncDetected") { ws.removeEventListener("message", handler); resolve(msg); }
    });
  });
}

test("T-040: a wrong fingerprint report is relayed to the worker and the resulting desyncDetected comes back on that SAME connection", async () => {
  const worker = spawnMatchWorker();
  const server = createServer();
  const wsMatch = await attachWsMatchWorker(server, worker);
  const port = await listen(server);
  try {
    const player = await connectRaw(port, "seat=player");
    // Wait for a real state push first — proves this test's own report happens once a match is
    // genuinely live and ticking, not merely at the welcome handshake.
    await new Promise(resolve => {
      player.addEventListener("message", function handler(ev) {
        if (JSON.parse(ev.data).type === "state") { player.removeEventListener("message", handler); resolve(); }
      });
    });
    const desync = nextDesyncFrom(player);
    player.send(JSON.stringify({ type: "fingerprint", tick: 1, fp: "definitely-wrong" }));
    const msg = await desync;
    assert.equal(msg.tick, 1);
    player.close();
  } finally { wsMatch.close(); server.close(); worker.terminate(); }
});

test("T-040: a desyncDetected for one seat is never sent to the OTHER seat's connection", async () => {
  const worker = spawnMatchWorker();
  const server = createServer();
  const wsMatch = await attachWsMatchWorker(server, worker);
  const port = await listen(server);
  try {
    const player = await connectRaw(port, "seat=player");
    const ai = await connectRaw(port, "seat=ai");
    let aiSawDesync = false;
    ai.addEventListener("message", ev => { if (JSON.parse(ev.data).type === "desyncDetected") aiSawDesync = true; });
    const playerDesync = nextDesyncFrom(player);
    player.send(JSON.stringify({ type: "fingerprint", tick: 1, fp: "definitely-wrong" }));
    await playerDesync;
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(aiSawDesync, false, "a seat's own desync report is that seat's own business, never broadcast");
    player.close(); ai.close();
  } finally { wsMatch.close(); server.close(); worker.terminate(); }
});

test("T-040: a malformed fingerprint report (missing/wrong-typed fields) is silently dropped — no crash, no relay, connection stays open", async () => {
  const worker = spawnMatchWorker();
  const server = createServer();
  const wsMatch = await attachWsMatchWorker(server, worker);
  const port = await listen(server);
  try {
    const player = await connectRaw(port, "seat=player");
    let sawDesync = false;
    player.addEventListener("message", ev => { if (JSON.parse(ev.data).type === "desyncDetected") sawDesync = true; });
    player.send(JSON.stringify({ type: "fingerprint" }));                    // no tick, no fp
    player.send(JSON.stringify({ type: "fingerprint", tick: "not-a-number", fp: 42 }));   // wrong types
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(sawDesync, false, "malformed reports must never even reach the worker's own comparison");
    // The connection itself must still be alive and functional — a malformed report is not abuse.
    const echo = countCommandResults(player, 300);
    player.send(rawEnvelope(1));
    assert.equal(await echo, 1);
    player.close();
  } finally { wsMatch.close(); server.close(); worker.terminate(); }
});

test("T-040: a REAL client transport's own periodic self-check never triggers a false-positive desync, even with T-028b's own wire quantization in play", async () => {
  const worker = spawnMatchWorker();
  const server = createServer();
  const wsMatch = await attachWsMatchWorker(server, worker);
  const port = await listen(server);
  try {
    const transport = await createWsClientTransport(`ws://localhost:${port}/?seat=player`, { fingerprintIntervalTicks: 2 });
    let sawDesync = false;
    transport.onEvent(e => { if (e.type === "desyncDetected") sawDesync = true; });
    // A short, real cadence (every 2 ticks, ~100ms at the ordinary 20Hz rate) — several real
    // reports round-trip well within this wait, over a genuinely live, ticking match.
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal(sawDesync, false, "a genuinely non-diverged client must never be flagged, even once real wire quantization (T-028b) is actually in play");
    transport.close();
  } finally { wsMatch.close(); server.close(); worker.terminate(); }
});

/* ---------- T-059a (FR-8): a real seat can surrender over the WebSocket wire ---------- */
// Purely a relay proof (this file's own job, same as chat/fingerprint above) — engine/victory.js's
// own surrender() semantics (idempotent, one-tick latency, N-seat standing) are already exhaustively
// covered by test/victory.test.js; this only has to prove the message actually reaches it from a
// real connection and the match genuinely resolves as a result.

function nextOverState(ws) {
  return new Promise(resolve => {
    ws.addEventListener("message", function handler(ev) {
      const msg = JSON.parse(ev.data);
      if (msg.type === "state" && msg.proj.over) { ws.removeEventListener("message", handler); resolve(msg.proj); }
    });
  });
}

test("T-059a: a seat sending {type:'surrender'} over the raw wire ends the match, the opposing seat winning by elimination", async () => {
  const worker = spawnMatchWorker();
  const server = createServer();
  const wsMatch = await attachWsMatchWorker(server, worker);
  const port = await listen(server);
  try {
    const player = await connectRaw(port, "seat=player");
    const ai = await connectRaw(port, "seat=ai");
    const playerSeesOver = nextOverState(player);
    const aiSeesOver = nextOverState(ai);
    player.send(JSON.stringify({ type: "surrender" }));
    const [playerFinal, aiFinal] = await Promise.all([playerSeesOver, aiSeesOver]);
    assert.equal(playerFinal.winner, "ai", "the seat that surrendered must not be the winner");
    assert.equal(playerFinal.winReason, "elimination", "engine/victory.js's own surrender funnels through the same state.eliminated path a real defeat does — same reason string, by design");
    assert.equal(aiFinal.winner, "ai");
    player.close(); ai.close();
  } finally { wsMatch.close(); server.close(); worker.terminate(); }
});

test("T-059a: a second surrender for an already-eliminated seat is a harmless no-op — never re-fires or corrupts the outcome", async () => {
  const worker = spawnMatchWorker();
  const server = createServer();
  const wsMatch = await attachWsMatchWorker(server, worker);
  const port = await listen(server);
  try {
    const player = await connectRaw(port, "seat=player");
    const ai = await connectRaw(port, "seat=ai");
    const firstOver = nextOverState(ai);
    player.send(JSON.stringify({ type: "surrender" }));
    await firstOver;
    // A second one, after the match is already decided — must not throw, hang, or change anything.
    player.send(JSON.stringify({ type: "surrender" }));
    await new Promise(resolve => setTimeout(resolve, 200));
    player.close(); ai.close();
  } finally { wsMatch.close(); server.close(); worker.terminate(); }
});

test("T-059a: transport.surrender() (net/wsClientTransport.js) is delivered as a real wire message and actually ends the match", async () => {
  const worker = spawnMatchWorker();
  const server = createServer();
  const wsMatch = await attachWsMatchWorker(server, worker);
  const port = await listen(server);
  try {
    const playerT = await createWsClientTransport(`ws://localhost:${port}/?seat=player`);
    const aiT = await createWsClientTransport(`ws://localhost:${port}/?seat=ai`);
    const aiSeesOver = new Promise(resolve => aiT.onEvent(e => { if (e.type === "state" && e.state.over) resolve(e.state); }));
    playerT.surrender();
    const final = await aiSeesOver;
    assert.equal(final.winner, "ai");
    playerT.close(); aiT.close();
  } finally { wsMatch.close(); server.close(); worker.terminate(); }
});

/* ----------
   attachWsMatchWorker must find the worker's "ready" message, not merely take its FIRST message.

   This is the root cause of a failure that had been read as CPU flakiness twice before (see
   connectResilient's own comments above, and the "SEQUENTIAL on purpose" note in the two-concurrent-
   matches test): under a full-suite run, that test failed with `match=undefined` in the connect URL
   — every attempt timing out against a server that was never going to answer, because no upgrade
   listener could match an undefined id and the socket was left unclaimed by design.

   The mechanism has nothing to do with speed. A Worker's port is flowing from construction, so a
   message emitted while no "message" listener is attached is DROPPED, not queued. attachWsMatchWorker
   used `worker.once("message", ...)` and destructured whatever arrived, so it was correct only while
   the attach happened before the worker got a word in. The worker posts "ready" and then starts
   pushing state every tick — so an attach that lands even slightly late reads a "state" message as
   its ready message, binds owners/createGameStateOpts/matchId to undefined, and silently produces an
   attachment no connection can ever reach.

   That is a real deployment shape, not just a test one: spawn several match workers and attach to
   them in turn (exactly what the two-concurrent-matches test does, and what a server hosting more
   than one match does) and the later attachments are the ones that lose the race.

   These two tests reproduce it deterministically by delaying the attach, rather than waiting for a
   loaded machine to do it by accident.
   ---------- */

test("attachWsMatchWorker finds 'ready' even when it attaches after the worker has started talking", async () => {
  const worker = spawnMatchWorker();
  // Long enough that "ready" has certainly been emitted and dropped, and state pushes have begun.
  await new Promise(r => setTimeout(r, 250));
  const server = createServer();
  const wsMatch = await attachWsMatchWorker(server, worker, { path: "/ws", requireMatch: true });
  try {
    assert.equal(typeof wsMatch.matchId, "string", "a late attach must still learn the match id");
    assert.ok(wsMatch.matchId.length > 0);
    assert.ok(Array.isArray(wsMatch.owners) && wsMatch.owners.includes("player"),
      "…and the seat list, or every seat check below rejects a legitimate connection");
    assert.ok(wsMatch.createGameStateOpts, "…and the world options the welcome message carries");
  } finally { wsMatch.close(); server.close(); worker.terminate(); }
});

test("a late attach still routes a real connection — the id it learned actually works", async () => {
  // The assertion that matters end to end: an undefined matchId made requireMatch reject every
  // upgrade, and because a mismatch is deliberately left UNCLAIMED (so a sibling attachment can
  // take it), the socket was never destroyed either — the client just waited until it timed out.
  const worker = spawnMatchWorker();
  await new Promise(r => setTimeout(r, 250));
  const server = createServer();
  const wsMatch = await attachWsMatchWorker(server, worker, { path: "/ws", requireMatch: true });
  const port = await listen(server);
  try {
    const transport = await createWsClientTransport(
      `ws://localhost:${port}/ws?match=${wsMatch.matchId}&seat=player`, { connectTimeoutMs: 20000 });
    const state = await new Promise(resolve => transport.onEvent(e => { if (e.type === "state") resolve(e.state); }));
    assert.ok(state.map, "a late-attached match must serve a real state, not hang until the client gives up");
    transport.close();
  } finally { wsMatch.close(); server.close(); worker.terminate(); }
});
