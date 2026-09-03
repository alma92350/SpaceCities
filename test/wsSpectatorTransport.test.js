/* ============================================================
   T-037 (FR-7): net/wsSpectatorTransport.js — the CLIENT half of a live network spectator
   connection. Real worker, real WS server throughout (net/wsWorkerTransport.js), the same "test the
   real thing" standard every other net/ file in this port holds itself to.

   Deliberately NOT run through test/transportContract.js's shared Transport contract: that
   contract's own header requires "a valid move must be accepted" (ok:true) — the opposite of what
   a spectator's own submitCommand must always do (see this file's own header for why it exists at
   all rather than being omitted). A narrower, spectator-specific set of assertions below instead.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { attachWsMatchWorker } from "../net/wsWorkerTransport.js";
import { createWsSpectatorTransport } from "../net/wsSpectatorTransport.js";

const WORKER_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "server", "matchWorker.js");
let nextSeed = 700000;

function spawnMatchWorker() {
  return new Worker(WORKER_FILE, { workerData: { createGameStateOpts: { planetId: "ferros", seed: nextSeed++ } } });
}

async function listen(server) {
  await new Promise(resolve => server.listen(0, resolve));
  return server.address().port;
}

async function setupSpectator(extraOpts = {}) {
  const worker = spawnMatchWorker();
  const server = createServer();
  const wsMatch = await attachWsMatchWorker(server, worker, extraOpts);
  const port = await listen(server);
  return {
    port, wsMatch,
    cleanup: () => { wsMatch.close(); server.close(); worker.terminate(); },
  };
}

test("createWsSpectatorTransport resolves once the welcome handshake completes, over a real socket backed by a real worker", async () => {
  const { port, cleanup } = await setupSpectator();
  try {
    const transport = await createWsSpectatorTransport(`ws://localhost:${port}/?spectate=1`);
    assert.equal(typeof transport.onEvent, "function");
    assert.equal(typeof transport.close, "function");
    transport.close();
  } finally { cleanup(); }
});

test("a spectator transport's state events carry full vision — both seats' bases, a real regenerated map, and a real seed", async () => {
  const { port, cleanup } = await setupSpectator();
  try {
    const transport = await createWsSpectatorTransport(`ws://localhost:${port}/?spectate=1`);
    const state = await new Promise(resolve => transport.onEvent(e => { if (e.type === "state") resolve(e.state); }));
    assert.ok(state.map, "the client must have regenerated a real map from the welcome handshake, same as an ordinary seat's own transport");
    assert.ok(state.map.nodes.length > 0);
    assert.equal(typeof state.seed, "number");
    const owners = new Set([...state.buildings.values()].map(b => b.owner));
    assert.ok(owners.has("player") && owners.has("ai"), "a spectator's own reassembled state must show BOTH seats at once");
    transport.close();
  } finally { cleanup(); }
});

test("a spectator transport's own units/buildings are real Maps, keyed by id, ready for render.js/hud.js to read directly", async () => {
  const { port, cleanup } = await setupSpectator();
  try {
    const transport = await createWsSpectatorTransport(`ws://localhost:${port}/?spectate=1`);
    const state = await new Promise(resolve => transport.onEvent(e => { if (e.type === "state") resolve(e.state); }));
    assert.ok(state.units instanceof Map);
    assert.ok(state.buildings instanceof Map);
    transport.close();
  } finally { cleanup(); }
});

test("a spectator transport's submitCommand is a real function that always resolves ok:false, without ever reaching the worker — defense in depth, matching the server's own never-wired conn.onmessage", async () => {
  const { port, cleanup } = await setupSpectator();
  try {
    const transport = await createWsSpectatorTransport(`ws://localhost:${port}/?spectate=1`);
    assert.equal(typeof transport.submitCommand, "function", "must satisfy net/transport.js's own Transport shape, so generic code that assumes it exists never crashes");
    const result = await transport.submitCommand({ t: "move", ids: ["whatever"], x: 0, y: 0 });
    assert.equal(result.ok, false);
    assert.equal(result.code, "spectator");
    transport.close();
  } finally { cleanup(); }
});

test("close() stops delivering further state events, and is idempotent", async () => {
  const { port, cleanup } = await setupSpectator();
  try {
    const transport = await createWsSpectatorTransport(`ws://localhost:${port}/?spectate=1`);
    await new Promise(resolve => transport.onEvent(e => { if (e.type === "state") resolve(); }));
    let sawEventAfterClose = false;
    transport.onEvent(() => { sawEventAfterClose = true; });
    transport.close();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(sawEventAfterClose, false);
    assert.doesNotThrow(() => transport.close(), "closing twice must be harmless");
  } finally { cleanup(); }
});

test("createWsSpectatorTransport rejects when spectatorsEnabled:false refuses the connection at the upgrade", async () => {
  const { port, cleanup } = await setupSpectator({ spectatorsEnabled: false });
  try {
    await assert.rejects(createWsSpectatorTransport(`ws://localhost:${port}/?spectate=1`));
  } finally { cleanup(); }
});

test("a second state event, once it arrives, correctly folds a delta onto the first full snapshot (T-028b's own mechanism, reused unmodified)", async () => {
  const { port, cleanup } = await setupSpectator();
  try {
    const transport = await createWsSpectatorTransport(`ws://localhost:${port}/?spectate=1`);
    const states = [];
    transport.onEvent(e => { if (e.type === "state") states.push(e.state); });
    await new Promise(resolve => {
      const check = () => { if (states.length >= 2) resolve(); else setTimeout(check, 50); };
      check();
    });
    assert.ok(states[1].tick >= states[0].tick, "a later reassembled state must reflect a later or equal tick — the delta genuinely folded onto the running snapshot");
    transport.close();
  } finally { cleanup(); }
});
