/* ============================================================
   T-029: server/matchWorker.js — a match hosted inside a REAL worker_threads.Worker, not a
   hand-rolled stand-in that could share this test's own misconceptions about postMessage's actual
   behavior (structured clone, message ordering, error propagation) — the same "test the real
   thing" standard test/ws.test.js and test/wsTransport.test.js already hold themselves to, one
   layer down: a real socket there, a real OS thread here.

   WIRE PROTOCOL between parent and worker (postMessage, structured-clone, not JSON — no encode/
   decode step needed at this boundary, unlike the browser-facing WebSocket one layer up):
     worker -> parent
       {type:"ready", owners}                      once, after the match exists and is ticking
       {type:"commandResult", seat, seq, result}    a shape-rejection (immediate) or an applied/
                                                     codec-rejected outcome (via emitAck, later)
       {type:"state", seat, proj}                   once per seat, every tick — RAW projectFor
                                                     output; quantizing/delta-encoding per
                                                     CONNECTION is the PARENT's own job (T-028b/c),
                                                     since only the parent knows connection lifetime
     parent -> worker
       {type:"command", seat, envelope}             relay a client's raw envelope for admission
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { encode } from "../net/commandEnvelope.js";

const WORKER_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "server", "matchWorker.js");
const SEED = 909090;

function spawnMatchWorker(seed = SEED) {
  const worker = new Worker(WORKER_FILE, {
    workerData: { createGameStateOpts: { planetId: "ferros", seed } },
  });
  return worker;
}

// Resolves with the first message matching `pred`, without consuming messages a caller registered
// its OWN "on" listener for elsewhere — tests below mix both styles as convenient.
function waitFor(worker, pred, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("waitFor timed out")), timeoutMs);
    const onMsg = msg => {
      if (pred(msg)) { clearTimeout(timer); worker.off("message", onMsg); resolve(msg); }
    };
    worker.on("message", onMsg);
  });
}

test("a fresh worker posts ready with the match's real owners, once", async () => {
  const worker = spawnMatchWorker();
  try {
    const msg = await waitFor(worker, m => m.type === "ready");
    assert.deepEqual(msg.owners, ["player", "ai"]);
  } finally { await worker.terminate(); }
});

test("the worker's ready message echoes back the createGameStateOpts it actually used — proving workerData genuinely reached createGameState, not a hardcoded fixture", async () => {
  // NOT checking this via the WIRE STATE messages: projectFor deliberately omits map/position data
  // (ADR-0009 — "the client already has enough to regenerate it locally"), and per-planet resource
  // node id/amount pairs turn out to be seed-INDEPENDENT (only their POSITIONS vary by seed, which
  // the wire format never carries at all) — so comparing wire state between two seeds proves
  // nothing here. Starting unit positions are ALSO seed-independent by design in this engine (the
  // same property test/replay.test.js's own two-different-seeds guard relies on: "base positions
  // are seed-independent... needs real time to diverge"). The ready message's own echo is the
  // direct, honest signal instead.
  const worker = spawnMatchWorker(777);
  try {
    const ready = await waitFor(worker, m => m.type === "ready");
    assert.equal(ready.createGameStateOpts.seed, 777);
    assert.equal(ready.createGameStateOpts.planetId, "ferros");
  } finally { await worker.terminate(); }
});

test("the worker pushes a state message for EVERY owner, every tick, unprompted — its own tick loop, not driven by the parent", async () => {
  const worker = spawnMatchWorker();
  try {
    const seen = new Set();
    await new Promise(resolve => {
      worker.on("message", m => { if (m.type === "state") { seen.add(m.seat); if (seen.has("player") && seen.has("ai")) resolve(); } });
    });
    assert.deepEqual([...seen].sort(), ["ai", "player"]);
  } finally { await worker.terminate(); }
});

test("a shape-valid command posted to the worker is admitted and eventually applied — a commandResult with ok:true arrives", async () => {
  const worker = spawnMatchWorker();
  try {
    const ready = await waitFor(worker, m => m.type === "ready");
    const state = await waitFor(worker, m => m.type === "state" && m.seat === "player");
    const unit = state.proj.units.find(u => u.owner === "player");
    assert.ok(unit, "fixture sanity: the player seat has at least one starting unit");

    const envelope = encode({ t: "move", ids: [unit.id], x: unit.x + 50, y: unit.y }, 1);
    worker.postMessage({ type: "command", seat: "player", envelope });

    const result = await waitFor(worker, m => m.type === "commandResult" && m.seat === "player" && m.seq === 1);
    assert.equal(result.result.ok, true);

    // And the move genuinely reached the sim — a LATER state push shows the order.
    const later = await waitFor(worker, m => m.type === "state" && m.seat === "player" && m.proj.units.find(u => u.id === unit.id)?.order?.type === "move");
    assert.equal(later.proj.units.find(u => u.id === unit.id).order.x, unit.x + 50);
  } finally { await worker.terminate(); }
});

test("a shape-REJECTED command (well-formed envelope, unknown command type) resolves with a commandResult ok:false, not a hang or a thrown error", async () => {
  const worker = spawnMatchWorker();
  try {
    await waitFor(worker, m => m.type === "ready");
    // A well-formed ENVELOPE (has a real seq — required to correlate the reply at all) carrying a
    // malformed COMMAND, the same shape test/wsTransport.test.js's own equivalent test uses. An
    // envelope missing `seq` entirely has no way to be correlated back to a reply at all — by
    // design, net/wsServerTransport.js's own comment already documents that as unanswerable.
    const envelope = encode({ t: "not-a-real-command-type" }, 1);
    worker.postMessage({ type: "command", seat: "player", envelope });
    const result = await waitFor(worker, m => m.type === "commandResult" && m.seat === "player");
    assert.equal(result.result.ok, false);
    assert.equal(result.result.code, "unknown-type");
  } finally { await worker.terminate(); }
});

test("a command naming a seat/id combination the codec rejects still resolves with a commandResult, never silently swallowed", async () => {
  const worker = spawnMatchWorker();
  try {
    await waitFor(worker, m => m.type === "ready");
    const envelope = encode({ t: "move", ids: ["not-a-real-id"], x: 0, y: 0 }, 1);
    // "spectator" isn't a real seat in match.state.owners — admit() itself doesn't gate on that
    // (it trusts the caller already authenticated the seat, ADR-0006; ownership is checked later,
    // inside stepMatch's apply() call), so this is admitted immediately (shape-valid) and only
    // rejected once it's actually due — proving the worker relays THAT path (emitAck), not just
    // the immediate shape-rejection one the previous test covers.
    worker.postMessage({ type: "command", seat: "spectator", envelope });
    const result = await waitFor(worker, m => m.type === "commandResult" && m.seat === "spectator");
    assert.equal(result.result.ok, false);
  } finally { await worker.terminate(); }
});

/* ============================================================
   T-029's own exit criterion: "Two concurrent matches in one server replay independently and
   identically." Split into the two properties that phrase actually names, proven separately
   rather than forced into one test — each worker runs its OWN real setInterval on its OWN
   wall-clock pace, so nothing guarantees two INDEPENDENTLY-started workers reach "the Nth state
   push" at the exact same simulated tick; comparing them directly would be testing timing luck,
   not correctness.

   INDEPENDENTLY: two matches running truly concurrently (real, separate OS threads — not
   time-sliced cooperatively the way same-process code would be) never cross-contaminate.
   IDENTICALLY: the same seed and the same command sequence reproduce the exact same outcome —
   proven sequentially, so nothing about wall-clock scheduling can confound the comparison; the
   CONCURRENCY half is what the "independently" test above already establishes doesn't matter to
   correctness in the first place.
   ============================================================ */

test("exit criterion (independently): two matches running truly concurrently never cross-contaminate each other's state", async () => {
  const a = spawnMatchWorker(11);
  const b = spawnMatchWorker(22);
  try {
    const [readyA, readyB] = await Promise.all([waitFor(a, m => m.type === "ready"), waitFor(b, m => m.type === "ready")]);
    const [stateA, stateB] = await Promise.all([
      waitFor(a, m => m.type === "state" && m.seat === "player"),
      waitFor(b, m => m.type === "state" && m.seat === "player"),
    ]);
    const unitA = stateA.proj.units.find(u => u.owner === "player");
    const unitB = stateB.proj.units.find(u => u.owner === "player");

    // Issue DIFFERENT, distinguishable moves to A and B at the same time, interleaved.
    a.postMessage({ type: "command", seat: "player", envelope: encode({ t: "move", ids: [unitA.id], x: unitA.x + 111, y: unitA.y }, 1) });
    b.postMessage({ type: "command", seat: "player", envelope: encode({ t: "move", ids: [unitB.id], x: unitB.x + 222, y: unitB.y }, 1) });

    const [resultA, resultB] = await Promise.all([
      waitFor(a, m => m.type === "commandResult" && m.seq === 1),
      waitFor(b, m => m.type === "commandResult" && m.seq === 1),
    ]);
    assert.equal(resultA.result.ok, true);
    assert.equal(resultB.result.ok, true);

    const [laterA, laterB] = await Promise.all([
      waitFor(a, m => m.type === "state" && m.seat === "player" && m.proj.units.find(u => u.id === unitA.id)?.order?.type === "move"),
      waitFor(b, m => m.type === "state" && m.seat === "player" && m.proj.units.find(u => u.id === unitB.id)?.order?.type === "move"),
    ]);
    // Each match shows ONLY its own commanded move — never the other's target, never the other's
    // unit id, proving the two concurrently-running workers never leaked into one another.
    assert.equal(laterA.proj.units.find(u => u.id === unitA.id).order.x, unitA.x + 111);
    assert.equal(laterB.proj.units.find(u => u.id === unitB.id).order.x, unitB.x + 222);
    assert.equal(readyA.createGameStateOpts.seed, 11);
    assert.equal(readyB.createGameStateOpts.seed, 22);
  } finally { await Promise.all([a.terminate(), b.terminate()]); }
});

test("exit criterion (identically): the same seed and the same command sequence reproduce the exact same outcome", async () => {
  const SHARED_SEED = 55555;

  async function driveToFingerprint() {
    const worker = spawnMatchWorker(SHARED_SEED);
    try {
      await waitFor(worker, m => m.type === "ready");
      const first = await waitFor(worker, m => m.type === "state" && m.seat === "player");
      const unit = first.proj.units.find(u => u.owner === "player");

      worker.postMessage({ type: "command", seat: "player", envelope: encode({ t: "move", ids: [unit.id], x: unit.x + 333, y: unit.y + 40 }, 1) });
      await waitFor(worker, m => m.type === "commandResult" && m.seq === 1);

      // Collect a run of consecutive ticks past the command's own applyTick, then fingerprint —
      // stringifying the whole per-seat projection is a strictly MORE demanding equality check
      // than test/matchLoop.test.js's own entitySnapshot-based fingerprint, since it also covers
      // fog/players/events, not just entity fields.
      let count = 0;
      const finalState = await new Promise(resolve => {
        const onMsg = m => {
          if (m.type === "state" && m.seat === "player") {
            count++;
            if (count >= 15) { worker.off("message", onMsg); resolve(m.proj); }
          }
        };
        worker.on("message", onMsg);
      });
      return JSON.stringify(finalState);
    } finally { await worker.terminate(); }
  }

  // Sequential, deliberately not concurrent (see this section's own header) — proves DETERMINISM
  // in isolation from wall-clock scheduling, which the test above already covers separately.
  const fingerprintA = await driveToFingerprint();
  const fingerprintB = await driveToFingerprint();
  assert.equal(fingerprintA, fingerprintB);
});
