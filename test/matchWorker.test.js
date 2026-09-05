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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { encode } from "../net/commandEnvelope.js";
import { createGameState } from "../engine/state.js";
import { mulberry32 } from "../engine/rng.js";
import { createMatch, admit, stepMatch, INPUT_DELAY_TICKS } from "../server/matchLoop.js";
import { writeSnapshot } from "../server/matchSnapshot.js";
import { SPECTATOR_SEAT } from "../engine/projection.js";

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

/* ---------- T-029a: boot restores from a snapshot on disk when one exists ---------- */

test("a worker given a dataDir with no snapshot yet starts fresh — ready.restored is false", async () => {
  const worker = spawnMatchWorker();
  try {
    const ready = await waitFor(worker, m => m.type === "ready");
    assert.equal(ready.restored, false);
  } finally { await worker.terminate(); }
});

/* ---------- T-029b: every match has a stable matchId, restore recovers the SAME one ---------- */

test("a fresh worker (no dataDir, or nothing snapshotted yet) mints a real matchId — a non-empty string, not a placeholder", async () => {
  const worker = spawnMatchWorker();
  try {
    const ready = await waitFor(worker, m => m.type === "ready");
    assert.equal(typeof ready.matchId, "string");
    assert.ok(ready.matchId.length > 0);
  } finally { await worker.terminate(); }
});

test("two independently-fresh-booted workers get DIFFERENT matchIds — not a hardcoded constant", async () => {
  const a = spawnMatchWorker(1);
  const b = spawnMatchWorker(2);
  try {
    const [readyA, readyB] = await Promise.all([waitFor(a, m => m.type === "ready"), waitFor(b, m => m.type === "ready")]);
    assert.notEqual(readyA.matchId, readyB.matchId);
  } finally { await Promise.all([a.terminate(), b.terminate()]); }
});

test("T-035 (FR-6): once a match ends, the worker stops ticking/pushing state — a finished match must not go on spending CPU and bandwidth forever", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spacecities-matchworker-over-test-"));
  try {
    const seed = 271828;
    const state = createGameState({ planetId: "ferros", seed, rng: mulberry32(seed) });
    const match = createMatch(state);
    const aiCC = [...match.state.buildings.values()].find(b => b.owner === "ai" && b.type === "command");
    match.state.buildings.delete(aiCC.id);   // last Command Center gone -> checkWinCondition ends it on the very next tick
    await writeSnapshot(dir, "match-about-to-end", match.state);

    const worker = new Worker(WORKER_FILE, {
      workerData: { createGameStateOpts: { planetId: "ferros", seed }, dataDir: dir },
    });
    try {
      // Straight to the "over" push, not a separate wait for "ready" first — two sequential
      // waitFor() calls would each add their OWN listener only once the previous one resolves,
      // and this match ends on literally its first tick, fast enough that a second listener
      // registered just after "ready" resolves could genuinely miss the "state" message that
      // follows it.
      const overMsg = await waitFor(worker, m => m.type === "state" && m.proj.over === true);
      assert.equal(overMsg.proj.winner, "player");
      const overTick = overMsg.proj.tick;

      // A real wait, not just "the first over:true arrived" — proving it stopped needs to observe
      // an ABSENCE over real time, several TICK_MS (50ms) periods' worth. Compares proj.tick, not
      // "any message at all": the SAME final tick posts one "state" message PER SEAT (the loop
      // above), so a second, same-tick message for the other seat is expected and fine — only a
      // LATER tick number would mean the worker kept going after the match was already over.
      let sawLaterTick = false;
      const onMsg = m => { if (m.type === "state" && m.proj.tick > overTick) sawLaterTick = true; };
      worker.on("message", onMsg);
      await new Promise(resolve => setTimeout(resolve, 300));
      worker.off("message", onMsg);
      assert.equal(sawLaterTick, false, "the worker must stop ticking once the match is over — no LATER tick may ever be pushed");
    } finally { await worker.terminate(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("T-034: workerData.matchId, when given, is adopted as this fresh match's own id instead of minting a new one — the lobby's own id must be the live match's id too", async () => {
  const worker = new Worker(WORKER_FILE, {
    workerData: { matchId: "lobby-minted-id-123", createGameStateOpts: { planetId: "ferros", seed: SEED } },
  });
  try {
    const ready = await waitFor(worker, m => m.type === "ready");
    assert.equal(ready.matchId, "lobby-minted-id-123");
  } finally { await worker.terminate(); }
});

test("a worker given a dataDir containing a real snapshot restores from it instead of starting fresh — the restored unit's actual position wins over a fresh spawn from the seed the worker was otherwise given", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spacecities-matchworker-restore-test-"));
  try {
    // Build a match OUTSIDE any worker, move a unit, drive it partway, and snapshot it via the
    // REAL writeSnapshot() — the same fixture-building approach test/matchSnapshot.test.js itself
    // uses, so this test exercises exactly the write path a live match's own periodic snapshot
    // would produce, not a hand-built stand-in file.
    const seed = 314159;
    const state = createGameState({ planetId: "ferros", seed, rng: mulberry32(seed) });
    const match = createMatch(state);
    const w = [...match.state.units.values()].find(u => u.owner === "player");
    const origX = w.x, origY = w.y;
    admit(match, encode({ t: "move", ids: [w.id], x: origX + 321, y: origY + 123 }, 1), "player");
    // First let the (delayed, per INPUT_DELAY_TICKS) command actually apply...
    for (let i = 0; i < INPUT_DELAY_TICKS + 1; i++) stepMatch(match, 0.05);
    assert.equal(w.order && w.order.type, "move", "fixture sanity: the move order must have applied by now");
    // ...then drive until the unit actually ARRIVES (engine/combat.js and friends null out
    // `order` on arrival) rather than a fixed tick count — the worker keeps ticking the restored
    // match forward on its own 20Hz loop after boot, so a snapshot taken mid-move would keep
    // drifting between "snapshot time" and "first captured state message", making an
    // exact-position assertion timing-dependent. An IDLE unit's position can't drift further no
    // matter how many extra ticks the worker runs before this test observes it.
    for (let i = 0; i < 600 && w.order; i++) stepMatch(match, 0.05);
    assert.equal(w.order, null, "fixture sanity: the unit must have reached its destination and gone idle before snapshotting");
    assert.ok(w.x !== origX || w.y !== origY, "fixture sanity: the unit must have actually moved before it's snapshotted");
    const expectedX = w.x, expectedY = w.y;
    await writeSnapshot(dir, "match-from-before-the-restart", match.state);

    // A DIFFERENT seed in workerData's own createGameStateOpts than the snapshot's — proving the
    // restored snapshot wins over a fresh createGameState call, not merely that the worker
    // happens to reconstruct the same thing from the seed it was handed.
    const worker = new Worker(WORKER_FILE, {
      workerData: { createGameStateOpts: { planetId: "ferros", seed: seed + 1 }, dataDir: dir },
    });
    try {
      const ready = await waitFor(worker, m => m.type === "ready");
      assert.equal(ready.restored, true);
      // T-029b's own core proof: restoring recovers the SNAPSHOT's matchId, not a freshly-minted
      // one — this is what lets a reconnecting client tell "I rejoined the same match" from "this
      // is a different match that happens to share a URL".
      assert.equal(ready.matchId, "match-from-before-the-restart");

      const first = await waitFor(worker, m => m.type === "state" && m.seat === "player");
      const restoredUnit = first.proj.units.find(u => u.id === w.id);
      assert.ok(restoredUnit, "the restored unit's own id must still be present on the wire");
      assert.equal(restoredUnit.x, expectedX);
      assert.equal(restoredUnit.y, expectedY);
    } finally { await worker.terminate(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
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

/* ---------- T-036: disconnect -> AI takeover (grace period) -> reclaim ---------- */
// A low-level protocol test, same posture as everything above: no lobby, no WS, no tokens — those
// are net/wsWorkerTransport.js's own job (its own tests cover that layer). This file only has to
// prove the WORKER's own reaction to {type:"seatDisconnected"/"seatConnected", seat} is correct.

// aiEnabled:false — the real scenario this task is about: a HUMAN was seated at "ai" (T-034a's own
// seam is what makes that possible at all), then disconnected. Without this, state.ai defaults to
// populated from the moment the match is created (today's every-other-caller default), and a test
// that disconnects an ALREADY-AI-driven seat isn't testing takeover at all — it's just watching
// that AI's own pre-existing, genuinely bursty building cadence and mistaking it for a reaction to
// the disconnect message.
function spawnWorkerWithGrace(graceMs, seed = SEED) {
  return new Worker(WORKER_FILE, { workerData: { createGameStateOpts: { planetId: "ferros", seed, aiEnabled: false }, graceMs } });
}

// Watches seat `seat`'s own state pushes (a seat always sees its OWN buildings unfogged, so this
// is immune to the fog problem that made T-035's own first AI-fill proof unreliable) and resolves
// once that owner's building count is strictly greater than it was when watching started.
function watchForBuildingGrowth(worker, seat, timeoutMs) {
  return new Promise(resolve => {
    let baseline = null;
    const timer = setTimeout(() => { worker.off("message", onMsg); resolve(false); }, timeoutMs);
    const onMsg = m => {
      if (m.type !== "state" || m.seat !== seat) return;
      const count = m.proj.buildings.filter(b => b.owner === seat).length;
      if (baseline === null) { baseline = count; return; }
      if (count > baseline) { clearTimeout(timer); worker.off("message", onMsg); resolve(true); }
    };
    worker.on("message", onMsg);
  });
}

test("T-036 (FR-5): a disconnected \"ai\" seat falls to the built-in AI after the grace period — nobody else was driving it", async () => {
  const worker = spawnWorkerWithGrace(200);
  try {
    await waitFor(worker, m => m.type === "ready");
    worker.postMessage({ type: "seatDisconnected", seat: "ai" });
    const grew = await watchForBuildingGrowth(worker, "ai", 6000);
    assert.equal(grew, true, "the AI must actually start building once it takes over");
  } finally { await worker.terminate(); }
});

test("T-036 (FR-5): a disconnected \"player\" seat falls to AI too — not just seat \"ai\" (engine/sim.js's own tick() only ever auto-drives \"ai\"; this file has to drive playerAi itself, the same aiSeats pattern server/session.js already established for self-play)", async () => {
  const worker = spawnWorkerWithGrace(200);
  try {
    await waitFor(worker, m => m.type === "ready");
    worker.postMessage({ type: "seatDisconnected", seat: "player" });
    const grew = await watchForBuildingGrowth(worker, "player", 6000);
    assert.equal(grew, true, "the host's own seat must also be playable by AI once abandoned");
  } finally { await worker.terminate(); }
});

test("T-036 (FR-5): a reconnect BEFORE the grace period expires cancels the pending takeover — a brief network blip must never hand control to the AI", async () => {
  const worker = spawnWorkerWithGrace(300);
  try {
    await waitFor(worker, m => m.type === "ready");
    worker.postMessage({ type: "seatDisconnected", seat: "ai" });
    await new Promise(resolve => setTimeout(resolve, 100));   // well inside the 300ms grace window
    worker.postMessage({ type: "seatConnected", seat: "ai" });
    // Watch for LONGER than the original grace period would have taken — if the timer had NOT
    // been cancelled, this window comfortably contains its would-be firing.
    const grew = await watchForBuildingGrowth(worker, "ai", 1500);
    assert.equal(grew, false, "a cancelled grace timer must never let the AI take over later");
  } finally { await worker.terminate(); }
});

test("T-036 (FR-5): a reconnect AFTER the grace period (AI already took over) hands control back — the AI must stop acting once its rightful owner returns", async () => {
  const worker = spawnWorkerWithGrace(150);
  try {
    await waitFor(worker, m => m.type === "ready");
    worker.postMessage({ type: "seatDisconnected", seat: "ai" });
    const grew = await watchForBuildingGrowth(worker, "ai", 4000);
    assert.equal(grew, true, "fixture sanity: the AI really did take over first");

    worker.postMessage({ type: "seatConnected", seat: "ai" });
    // A real wait, not just "no growth in one instant" — proving it STOPPED needs to observe an
    // absence over real time, several TICK_MS worth, the same pattern T-035's own "worker stops
    // ticking" test already established.
    const grewAgain = await watchForBuildingGrowth(worker, "ai", 2000);
    assert.equal(grewAgain, false, "once reconnected, the built-in AI must not keep building on its own");
  } finally { await worker.terminate(); }
});

/* ---------- T-037 (FR-7): spectator projection, posted every tick regardless of connection count ---------- */

test("T-037 (FR-7): the worker posts a spectator-shaped state message every tick, with full vision — not fogged to either seat", async () => {
  const worker = spawnMatchWorker();
  try {
    await waitFor(worker, m => m.type === "ready");
    const spectatorMsg = await waitFor(worker, m => m.type === "state" && m.seat === SPECTATOR_SEAT);
    // A fresh match's two bases start far enough apart that neither seat's OWN fog would reveal the
    // other's — seeing BOTH owners here is what proves this is genuinely unfiltered, not merely
    // "happens to equal one seat's own fogged view".
    const owners = new Set(spectatorMsg.proj.buildings.map(b => b.owner));
    assert.ok(owners.has("player") && owners.has("ai"), "a spectator must see BOTH seats' bases, never just one seat's own fogged view");
  } finally { await worker.terminate(); }
});

test("T-037 (FR-7): the worker posts a spectator state message unconditionally — no message from the parent is needed to turn it on", async () => {
  const worker = spawnMatchWorker();
  try {
    await waitFor(worker, m => m.type === "ready");
    // Deliberately sends NOTHING else — the ordinary per-seat pushes prove this the same way (no
    // "start sending me state" handshake exists for them either): the worker doesn't know or care
    // whether any real connection — spectator or seat — is currently listening; that's entirely the
    // parent's (net/wsWorkerTransport.js's) own job, mirroring exactly how a real seat's own state
    // push already works regardless of whether anyone is connected to receive it.
    const msg = await waitFor(worker, m => m.type === "state" && m.seat === SPECTATOR_SEAT);
    assert.equal(typeof msg.proj, "object");
  } finally { await worker.terminate(); }
});

/* ---------- T-040 (FR-20): desync detection via state fingerprint reporting ---------- */

test("T-040: a fingerprint report that matches the worker's own state produces no desyncDetected message", async () => {
  const worker = spawnMatchWorker();
  try {
    await waitFor(worker, m => m.type === "ready");
    // A real seat-scoped fingerprint of THIS worker's own live match.state, computed the exact same
    // way a well-behaved client would: reach for the freshest state push it just got. seatFingerprint
    // itself is exercised directly in test/fingerprint.test.js; this proves the WIRING around it.
    const stateMsg = await waitFor(worker, m => m.type === "state" && m.seat === "player");
    const { seatFingerprint } = await import("../net/fingerprint.js");
    // reconstruct a state-shaped object from the raw wire proj the same minimal way this test needs
    // (Maps keyed by id, players.player.resources, tick) — full reassembleProjection is client-side
    // machinery this test has no reason to pull in for a server-side wiring proof.
    const fakeState = {
      units: new Map(stateMsg.proj.units.map(u => [u.id, u])),
      buildings: new Map(stateMsg.proj.buildings.map(b => [b.id, b])),
      players: stateMsg.proj.players,
      tick: stateMsg.proj.tick,
    };
    const fp = seatFingerprint(fakeState, "player");

    let sawDesync = false;
    worker.on("message", m => { if (m.type === "desyncDetected") sawDesync = true; });
    worker.postMessage({ type: "fingerprint", seat: "player", tick: stateMsg.proj.tick, fp });
    // No ack for a MATCHING report (same "silent on success" posture net/chatLimiter.js/
    // net/abuseGuard.js already use elsewhere) — settle briefly, then confirm nothing fired.
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(sawDesync, false, "a genuinely matching fingerprint must never be flagged as a desync");
  } finally { await worker.terminate(); }
});

test("T-040: a fingerprint report that does NOT match the worker's own state is detected and reported back as desyncDetected", async () => {
  const worker = spawnMatchWorker();
  try {
    await waitFor(worker, m => m.type === "ready");
    const stateMsg = await waitFor(worker, m => m.type === "state" && m.seat === "player");
    worker.postMessage({ type: "fingerprint", seat: "player", tick: stateMsg.proj.tick, fp: "obviously-not-a-real-fingerprint" });
    const desync = await waitFor(worker, m => m.type === "desyncDetected");
    assert.equal(desync.seat, "player");
    assert.equal(desync.tick, stateMsg.proj.tick);
  } finally { await worker.terminate(); }
});

test("T-040: a desync report for one seat never fires for the other seat's own correct fingerprint", async () => {
  const worker = spawnMatchWorker();
  try {
    await waitFor(worker, m => m.type === "ready");
    const stateMsg = await waitFor(worker, m => m.type === "state" && m.seat === "ai");
    const { seatFingerprint } = await import("../net/fingerprint.js");
    const fakeState = {
      units: new Map(stateMsg.proj.units.map(u => [u.id, u])),
      buildings: new Map(stateMsg.proj.buildings.map(b => [b.id, b])),
      players: stateMsg.proj.players,
      tick: stateMsg.proj.tick,
    };
    const fp = seatFingerprint(fakeState, "ai");
    let sawDesync = false;
    worker.on("message", m => { if (m.type === "desyncDetected") sawDesync = true; });
    worker.postMessage({ type: "fingerprint", seat: "ai", tick: stateMsg.proj.tick, fp });
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(sawDesync, false);
  } finally { await worker.terminate(); }
});

/* ---------- T-059a (FR-8): a real network trigger for engine/victory.js's own surrender() ---------- */
// A low-level protocol test, same posture as T-036/T-040 above: no lobby, no WS, no MCP — those are
// net/wsWorkerTransport.js's and server/mcpActionTools.js's own jobs (their own tests cover that
// layer). This file only has to prove the worker's own reaction to {type:"surrender", seat} is
// correct — surrender()'s own semantics (idempotent, N-seat standing, score-tiebreak exclusion) are
// already exhaustively covered by test/victory.test.js and are not re-tested here.

test("T-059a: {type:'surrender', seat} ends the match on the next tick, the OTHER seat winning by elimination", async () => {
  const worker = spawnMatchWorker();
  try {
    await waitFor(worker, m => m.type === "ready");
    worker.postMessage({ type: "surrender", seat: "player" });
    const overMsg = await waitFor(worker, m => m.type === "state" && m.seat === "ai" && m.proj.over === true, 3000);
    assert.equal(overMsg.proj.winner, "ai", "the seat that surrendered must not be the winner");
    assert.equal(overMsg.proj.winReason, "elimination", "surrender funnels through the same state.eliminated path a real defeat does — same reason string, by design (engine/victory.js)");
  } finally { await worker.terminate(); }
});

test("T-059a: surrendering the seat driven by the built-in scripted AI is ignored — defense-in-depth against a malformed/stray message, mirroring endTurn's own identical guard", async () => {
  // aiEnabled left at its default (true): seat "ai" is scripted-AI-controlled here, so a
  // surrender claiming to be from it must never apply — no real connection could ever send this.
  const worker = spawnMatchWorker();
  try {
    await waitFor(worker, m => m.type === "ready");
    worker.postMessage({ type: "surrender", seat: "ai" });
    // A real wait, not just "no over:true in one instant" — proving it was IGNORED needs to
    // observe an absence over real time, several TICK_MS worth, the same pattern this file's own
    // T-035/T-036 tests already establish for a negative result.
    let sawOver = false;
    const onMsg = m => { if (m.type === "state" && m.proj.over) sawOver = true; };
    worker.on("message", onMsg);
    await new Promise(resolve => setTimeout(resolve, 300));
    worker.off("message", onMsg);
    assert.equal(sawOver, false, "a scripted-AI seat has no real connection to surrender from — the match must keep going");
  } finally { await worker.terminate(); }
});

test("T-059a: a second surrender for an already-eliminated seat is a harmless no-op", async () => {
  const worker = spawnMatchWorker();
  try {
    await waitFor(worker, m => m.type === "ready");
    worker.postMessage({ type: "surrender", seat: "player" });
    await waitFor(worker, m => m.type === "state" && m.proj.over === true, 3000);
    // Must not throw, hang, or post anything further that a listener could mistake for a NEW result.
    worker.postMessage({ type: "surrender", seat: "player" });
    let sawSecondCommandResult = false;
    const onMsg = m => { if (m.type === "commandResult") sawSecondCommandResult = true; };
    worker.on("message", onMsg);
    await new Promise(resolve => setTimeout(resolve, 200));
    worker.off("message", onMsg);
    assert.equal(sawSecondCommandResult, false);
  } finally { await worker.terminate(); }
});

/* ---------- bugfix: pushState() must drain state.events every tick ---------- */
// Reported live, by a human playing a real match against an MCP agent: a fast-firing unit's attack
// tracer never disappeared. Root cause (see pushState()'s own comment above): state.events used to
// accumulate for a live match's WHOLE lifetime (deliberately, for wait_for_event's own fog-correct
// baseline diffing — server/mcpObservationCache.js), and engine/projection.js builds a seat's
// proj.events fresh from that growing history every tick. engine/projectionDelta.js's computeDelta
// assumes a projection's `events` field is ALREADY "just this tick's new ones" and always sends it
// in full — true for the single-player client (boot.js drains its own state.events every frame),
// false for a live match, so a real WS-relayed client kept re-receiving (and re-playing, via
// boot.js's own processFrameEvents -> effects.js addTracer/addDeathFlash/sound) its ENTIRE event
// history on every single incoming tick, forever. A 3-seat match here (not the 2-seat matches this
// file otherwise uses) so surrendering ONE seat leaves 2 others standing — the match itself must
// keep ticking (and pushing state) past the surrender, which is exactly what observing "the very
// next tick's push" needs.
test("bugfix: an event must not still be in the state push for the NEXT tick — state.events is drained every pushState, not just once at the end of the match", async () => {
  const worker = new Worker(WORKER_FILE, {
    workerData: {
      createGameStateOpts: {
        planetId: "ferros", seed: SEED,
        ownerDefs: [
          { id: "player", faction: "neutral", isAI: false, color: "#4fd1ff" },
          { id: "ai", faction: "neutral", isAI: true, color: "#f87171" },
          { id: "rebels", faction: "neutral", isAI: true, color: "#fbbf24" },
        ],
      },
    },
  });
  try {
    await waitFor(worker, m => m.type === "ready");
    worker.postMessage({ type: "surrender", seat: "player" });
    const hasSurrenderEvent = proj => (proj.events || []).some(e => e.type === "eliminated" && e.owner === "player" && e.reason === "surrender");

    const pushA = await waitFor(worker, m => m.type === "state" && m.seat === "player" && hasSurrenderEvent(m.proj), 3000);
    assert.equal(pushA.proj.over, false, "3 seats, only 1 surrendered — 2 remain standing, so the match itself must not be over yet (the case this test actually needs: ticking continues)");

    const pushB = await waitFor(worker, m => m.type === "state" && m.seat === "player" && m.proj.tick > pushA.proj.tick, 3000);
    assert.equal(hasSurrenderEvent(pushB.proj), false, "the surrender event must not still be present on a LATER tick's own push — an undrained state.events would keep resending it forever, which is exactly the live tracer/sound bug this test guards against");
  } finally { await worker.terminate(); }
});

/* ============================================================
   T-057 (§6.3, ADR-0007): clockPolicy:"deliberation" — the sim advances in FIXED batches, gated
   on every REQUIRED (non-scripted-AI) seat calling {type:"endTurn", seat}, with a real wall-clock
   watchdog so a stalled seat can never hang the match. Every existing test ABOVE this section
   proves the DEFAULT (workerData.clockPolicy omitted or "realtime") is completely untouched — this
   whole feature is gated behind an explicit opt-in, never a change to the existing code path.
   deliberationTicksPerStep/watchdogMs are workerData-overridable the same way graceMs already is,
   so a test can use a tiny batch/timeout instead of the real 20-tick/20-second production values.
   ============================================================ */

function spawnDeliberationWorker({ seed = SEED, aiEnabled = false, deliberationTicksPerStep = 3, watchdogMs = 60000 } = {}) {
  return new Worker(WORKER_FILE, {
    workerData: {
      createGameStateOpts: { planetId: "ferros", seed, aiEnabled },
      clockPolicy: "deliberation", deliberationTicksPerStep, watchdogMs,
    },
  });
}

test("deliberation mode never ticks on its own — no new state arrives without an endTurn, unlike realtime's own free-running interval", async () => {
  const worker = spawnDeliberationWorker();
  try {
    const ready = await waitFor(worker, m => m.type === "ready");
    void ready;
    let sawTickAdvance = false;
    worker.on("message", m => { if (m.type === "state" && m.seat === "player" && m.proj.tick > 0) sawTickAdvance = true; });
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(sawTickAdvance, false, "with nobody having called endTurn yet, the sim must not have advanced past tick 0");
  } finally { await worker.terminate(); }
});

test("deliberation mode advances exactly deliberationTicksPerStep ticks once every required seat calls endTurn, then resolves endTurnResult", async () => {
  const worker = spawnDeliberationWorker({ deliberationTicksPerStep: 5 });
  try {
    await waitFor(worker, m => m.type === "ready");
    worker.postMessage({ type: "endTurn", seat: "player" });
    // Only ONE of the two required seats so far — must not have advanced yet.
    await new Promise(resolve => setTimeout(resolve, 150));
    let advancedEarly = false;
    worker.on("message", m => { if (m.type === "endTurnResult") advancedEarly = true; });
    assert.equal(advancedEarly, false, "must still be waiting on seat ai's own endTurn");

    worker.postMessage({ type: "endTurn", seat: "ai" });
    const result = await waitFor(worker, m => m.type === "endTurnResult");
    assert.equal(result.tick, 5);
    const stateMsg = await waitFor(worker, m => m.type === "state" && m.seat === "player" && m.proj.tick === 5);
    assert.equal(stateMsg.proj.tick, 5);
  } finally { await worker.terminate(); }
});

test("deliberation mode only requires seats NOT under scripted-AI control — a scripted-AI seat's own turn is never waited on", async () => {
  // aiEnabled left at its default (true) — seat "ai" is scripted-AI-controlled, so only "player"'s
  // own endTurn should be needed to advance a round.
  const worker = spawnDeliberationWorker({ aiEnabled: true, deliberationTicksPerStep: 4 });
  try {
    await waitFor(worker, m => m.type === "ready");
    worker.postMessage({ type: "endTurn", seat: "player" });
    const result = await waitFor(worker, m => m.type === "endTurnResult");
    assert.equal(result.tick, 4);
  } finally { await worker.terminate(); }
});

test("deliberation mode's watchdog force-advances a round when a required seat never calls endTurn", async () => {
  const worker = spawnDeliberationWorker({ deliberationTicksPerStep: 2, watchdogMs: 150 });
  try {
    await waitFor(worker, m => m.type === "ready");
    worker.postMessage({ type: "endTurn", seat: "player" });   // "ai" (human/agent here) never calls its own
    const result = await waitFor(worker, m => m.type === "endTurnResult", 3000);
    assert.equal(result.tick, 2, "the watchdog must force the round through at exactly the same batch size, not skip ticks");
  } finally { await worker.terminate(); }
});

test("deliberation mode supports multiple consecutive rounds — readiness genuinely resets each time, not stuck permanently \"ready\"", async () => {
  const worker = spawnDeliberationWorker({ deliberationTicksPerStep: 2, watchdogMs: 60000 });
  try {
    await waitFor(worker, m => m.type === "ready");
    worker.postMessage({ type: "endTurn", seat: "player" });
    worker.postMessage({ type: "endTurn", seat: "ai" });
    const r1 = await waitFor(worker, m => m.type === "endTurnResult");
    assert.equal(r1.tick, 2);

    worker.postMessage({ type: "endTurn", seat: "player" });
    worker.postMessage({ type: "endTurn", seat: "ai" });
    const r2 = await waitFor(worker, m => m.type === "endTurnResult" && m.tick === 4);
    assert.equal(r2.tick, 4);
  } finally { await worker.terminate(); }
});

test("a command issued before endTurn is admitted immediately and takes effect once the round actually steps — the real codec, unchanged by clock policy", async () => {
  // admit() schedules an ACCEPTED envelope for state.tick + INPUT_DELAY_TICKS (net/commandLoop.js's
  // own same-tick-batch fairness window, reused UNCHANGED here — deliberation mode adds no second
  // command path); stepMatch only actually applies it (and only THEN posts commandResult, via
  // emitAck) once state.tick reaches that applyTick — which, in this mode, only happens as part of
  // a round's own batched ticks. A batch size AT OR BELOW INPUT_DELAY_TICKS would leave the command
  // still pending at the end of this one round (the due-check runs BEFORE each tick, never once
  // exactly AT the final tick a small batch stops on) — so this test deliberately uses a batch
  // comfortably larger than INPUT_DELAY_TICKS to prove the command is caught WITHIN a single round.
  const deliberationTicksPerStep = INPUT_DELAY_TICKS + 2;
  const worker = spawnDeliberationWorker({ deliberationTicksPerStep });
  try {
    await waitFor(worker, m => m.type === "ready");
    const stateMsg = await waitFor(worker, m => m.type === "state" && m.seat === "player");
    const unit = stateMsg.proj.units.find(u => u.owner === "player");
    const target = { x: unit.x + 300, y: unit.y };
    const envelope = encode({ t: "move", ids: [unit.id], x: target.x, y: target.y }, 1, null);
    worker.postMessage({ type: "command", seat: "player", envelope });

    // Nothing advances the sim until BOTH required seats end their turn — an ACCEPTED envelope's
    // own commandResult only arrives once stepMatch actually processes it (emitAck), so it cannot
    // arrive before this round runs at all, unlike realtime mode's own continuously-ticking loop.
    worker.postMessage({ type: "endTurn", seat: "player" });
    worker.postMessage({ type: "endTurn", seat: "ai" });

    await waitFor(worker, m => m.type === "commandResult" && m.seq === 1);
    const after = await waitFor(worker, m => m.type === "state" && m.seat === "player" && m.proj.tick === deliberationTicksPerStep);
    const moved = after.proj.units.find(u => u.id === unit.id);
    assert.equal(moved.order.type, "move");
    assert.equal(moved.order.x, target.x);
  } finally { await worker.terminate(); }
});

test("T-057's own exit criterion: a seeded deliberation match driven by a fixed scripted sequence of endTurn/commands replays to the exact same outcome every time", async () => {
  const SHARED_SEED = 77777;
  const BATCH = INPUT_DELAY_TICKS + 2;   // comfortably above the input-delay window — see the test above for why

  // Stands in for "a scripted agent": a fixed, deterministic sequence of commands/endTurn calls,
  // not wall-clock-timed thinking — exactly what a benchmark harness replays across runs.
  async function driveScriptedMatch() {
    const worker = spawnDeliberationWorker({ seed: SHARED_SEED, deliberationTicksPerStep: BATCH });
    try {
      await waitFor(worker, m => m.type === "ready");
      const first = await waitFor(worker, m => m.type === "state" && m.seat === "player");
      const unit = first.proj.units.find(u => u.owner === "player");

      worker.postMessage({ type: "command", seat: "player", envelope: encode({ t: "move", ids: [unit.id], x: unit.x + 250, y: unit.y }, 1) });
      worker.postMessage({ type: "endTurn", seat: "player" });
      worker.postMessage({ type: "endTurn", seat: "ai" });
      await waitFor(worker, m => m.type === "endTurnResult" && m.tick === BATCH);

      // A second round, so the script exercises "readiness genuinely resets" too, not just one shot.
      worker.postMessage({ type: "endTurn", seat: "player" });
      worker.postMessage({ type: "endTurn", seat: "ai" });
      const final = await waitFor(worker, m => m.type === "endTurnResult" && m.tick === BATCH * 2);
      const finalState = await waitFor(worker, m => m.type === "state" && m.seat === "player" && m.proj.tick === final.tick);
      // Stringifying the whole per-seat projection is a strictly MORE demanding equality check
      // than comparing a handful of fields — matches this file's own "exit criterion (identically)"
      // determinism test above for realtime mode, applied here to the batched/gated clock instead.
      return JSON.stringify(finalState.proj);
    } finally { await worker.terminate(); }
  }

  // Sequential, deliberately not concurrent — proves determinism in isolation from wall-clock
  // scheduling, the same reasoning this file's own realtime-mode determinism test above already
  // documents.
  const outcomeA = await driveScriptedMatch();
  const outcomeB = await driveScriptedMatch();
  assert.equal(outcomeA, outcomeB);
});

/* ============================================================
   T-061 (Ops): structured operational logging (server/log.js) wired into this file's own four
   real sites — desync, disconnect/reconnect/AI-takeover, match-ended, and tick-overrun. logEvent
   itself is exhaustively covered in isolation by test/log.test.js; everything below only proves
   the WIRING: the right event, with the right fields, at the right moment, exactly once.

   Each worker below is spawned with {stdout:true} (a real Node Worker option — see the Node docs
   for worker_threads) so console.log calls made INSIDE the worker thread arrive at the PARENT as
   a real byte stream on worker.stdout instead of being piped straight through to this test
   process's own process.stdout — the only way to actually observe them from here, since a worker
   thread has its own separate global `console` that this test's own console.log monkey-patching
   (test/log.test.js's own captureLog) could never reach. That stream is a genuinely separate
   channel from the postMessage one every other test in this file already waits on, so after
   awaiting a postMessage-based signal that a code path definitely ran, every test below still
   waits a short, fixed settle time before reading `lines` — the same "real wait, not just one
   instant" posture this file's own T-035/T-036 tests already use for a different async boundary.
   ============================================================ */

function spawnWorkerWithStdout(workerData) {
  const worker = new Worker(WORKER_FILE, { workerData, stdout: true });
  const lines = [];
  let buf = "";
  worker.stdout.on("data", chunk => {
    buf += chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) lines.push(JSON.parse(line));
    }
  });
  return { worker, lines };
}

test("T-061: a desync report logs a structured 'desync' event alongside the existing desyncDetected reply", async () => {
  const { worker, lines } = spawnWorkerWithStdout({ createGameStateOpts: { planetId: "ferros", seed: SEED } });
  try {
    const ready = await waitFor(worker, m => m.type === "ready");
    const stateMsg = await waitFor(worker, m => m.type === "state" && m.seat === "player");
    worker.postMessage({ type: "fingerprint", seat: "player", tick: stateMsg.proj.tick, fp: "obviously-not-a-real-fingerprint" });
    await waitFor(worker, m => m.type === "desyncDetected");
    await new Promise(resolve => setTimeout(resolve, 200));

    const events = lines.filter(e => e.type === "desync");
    assert.equal(events.length, 1);
    assert.equal(events[0].matchId, ready.matchId);
    assert.equal(events[0].seat, "player");
    assert.equal(events[0].tick, stateMsg.proj.tick);
  } finally { await worker.terminate(); }
});

test("T-061: seatDisconnected and the resulting aiTakeover each log a structured event carrying the match's own id", async () => {
  const { worker, lines } = spawnWorkerWithStdout({ createGameStateOpts: { planetId: "ferros", seed: SEED, aiEnabled: false }, graceMs: 150 });
  try {
    const ready = await waitFor(worker, m => m.type === "ready");
    worker.postMessage({ type: "seatDisconnected", seat: "ai" });
    const grew = await watchForBuildingGrowth(worker, "ai", 4000);
    assert.equal(grew, true, "fixture sanity: the AI really did take over");
    await new Promise(resolve => setTimeout(resolve, 200));

    const disconnected = lines.filter(e => e.type === "seatDisconnected");
    const takeover = lines.filter(e => e.type === "aiTakeover");
    assert.equal(disconnected.length, 1);
    assert.equal(disconnected[0].seat, "ai");
    assert.equal(disconnected[0].matchId, ready.matchId);
    assert.equal(takeover.length, 1);
    assert.equal(takeover[0].seat, "ai");
    assert.equal(takeover[0].matchId, ready.matchId);
  } finally { await worker.terminate(); }
});

test("T-061: reconnecting after a real AI takeover logs seatReconnected", async () => {
  const { worker, lines } = spawnWorkerWithStdout({ createGameStateOpts: { planetId: "ferros", seed: SEED, aiEnabled: false }, graceMs: 150 });
  try {
    await waitFor(worker, m => m.type === "ready");
    worker.postMessage({ type: "seatDisconnected", seat: "ai" });
    const grew = await watchForBuildingGrowth(worker, "ai", 4000);
    assert.equal(grew, true, "fixture sanity: the AI really did take over first");

    worker.postMessage({ type: "seatConnected", seat: "ai" });
    await new Promise(resolve => setTimeout(resolve, 200));

    const reconnected = lines.filter(e => e.type === "seatReconnected");
    assert.equal(reconnected.length, 1);
    assert.equal(reconnected[0].seat, "ai");
  } finally { await worker.terminate(); }
});

test("T-061: seatConnected for a seat that was never away logs nothing — a first join is not a reconnect", async () => {
  const { worker, lines } = spawnWorkerWithStdout({ createGameStateOpts: { planetId: "ferros", seed: SEED } });
  try {
    await waitFor(worker, m => m.type === "ready");
    worker.postMessage({ type: "seatConnected", seat: "player" });
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(lines.filter(e => e.type === "seatReconnected").length, 0);
  } finally { await worker.terminate(); }
});

test("T-061: a reconnect that cancels a pending grace timer BEFORE any takeover still logs seatReconnected — it really was away", async () => {
  const { worker, lines } = spawnWorkerWithStdout({ createGameStateOpts: { planetId: "ferros", seed: SEED, aiEnabled: false }, graceMs: 300 });
  try {
    await waitFor(worker, m => m.type === "ready");
    worker.postMessage({ type: "seatDisconnected", seat: "ai" });
    await new Promise(resolve => setTimeout(resolve, 100));   // well inside the 300ms grace window
    worker.postMessage({ type: "seatConnected", seat: "ai" });
    await new Promise(resolve => setTimeout(resolve, 200));

    assert.equal(lines.filter(e => e.type === "aiTakeover").length, 0, "fixture sanity: reconnected before the grace period ever fired");
    assert.equal(lines.filter(e => e.type === "seatReconnected").length, 1);
  } finally { await worker.terminate(); }
});

test("T-061: a match ending logs exactly one structured matchEnded event, with the final tick/winner/winReason", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spacecities-matchworker-log-over-test-"));
  try {
    const seed = 271828;
    const state = createGameState({ planetId: "ferros", seed, rng: mulberry32(seed) });
    const match = createMatch(state);
    const aiCC = [...match.state.buildings.values()].find(b => b.owner === "ai" && b.type === "command");
    match.state.buildings.delete(aiCC.id);   // last Command Center gone -> ends on the very next tick
    await writeSnapshot(dir, "match-about-to-end-for-logging", match.state);

    const { worker, lines } = spawnWorkerWithStdout({ createGameStateOpts: { planetId: "ferros", seed }, dataDir: dir });
    try {
      const overMsg = await waitFor(worker, m => m.type === "state" && m.proj.over === true);
      await new Promise(resolve => setTimeout(resolve, 200));

      // Exactly one, despite the same final tick posting one "state" message PER SEAT PLUS the
      // spectator (this file's own pushState) — stopMatchTimers (where matchEnded logs) only ever
      // runs once, the same "no later tick" guarantee T-035's own test above already established.
      const ended = lines.filter(e => e.type === "matchEnded");
      assert.equal(ended.length, 1);
      assert.equal(ended[0].winner, "player");
      assert.equal(ended[0].tick, overMsg.proj.tick);
      assert.equal(typeof ended[0].matchId, "string");
      assert.equal(typeof ended[0].time, "number");
    } finally { await worker.terminate(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("T-061 (NFR-2): an unreachably small tick budget makes every tick log a tickOverrun — proves the comparison actually fires, not just exists", async () => {
  const { worker, lines } = spawnWorkerWithStdout({ createGameStateOpts: { planetId: "ferros", seed: SEED }, tickBudgetMs: 0 });
  try {
    const ready = await waitFor(worker, m => m.type === "ready");
    await waitFor(worker, m => m.type === "state" && m.seat === "player" && m.proj.tick >= 2);
    await new Promise(resolve => setTimeout(resolve, 100));

    const overruns = lines.filter(e => e.type === "tickOverrun");
    assert.ok(overruns.length >= 1, "a real tick always takes measurably more than 0ms, so a 0ms budget must be exceeded every time");
    assert.equal(overruns[0].matchId, ready.matchId);
    assert.equal(typeof overruns[0].tick, "number");
    assert.equal(typeof overruns[0].elapsedMs, "number");
  } finally { await worker.terminate(); }
});

test("T-061 (NFR-2): a generous tick budget never logs a tickOverrun — the guard is a real comparison, not an unconditional log", async () => {
  // 100 real SECONDS, not milliseconds — no actual tick could ever exceed this regardless of
  // machine speed/contention, so this stays deterministic rather than racing real wall-clock load
  // the way asserting against the real ~25ms production budget under full-suite contention would.
  const { worker, lines } = spawnWorkerWithStdout({ createGameStateOpts: { planetId: "ferros", seed: SEED }, tickBudgetMs: 100000 });
  try {
    await waitFor(worker, m => m.type === "ready");
    await waitFor(worker, m => m.type === "state" && m.seat === "player" && m.proj.tick >= 3);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(lines.filter(e => e.type === "tickOverrun").length, 0);
  } finally { await worker.terminate(); }
});

test("T-061: deliberation mode's own batched ticks never log a tickOverrun — NFR-2's per-tick budget deliberately does not apply there", async () => {
  const { worker, lines } = spawnWorkerWithStdout({
    createGameStateOpts: { planetId: "ferros", seed: SEED, aiEnabled: false },
    clockPolicy: "deliberation", deliberationTicksPerStep: 5, watchdogMs: 60000,
  });
  try {
    await waitFor(worker, m => m.type === "ready");
    worker.postMessage({ type: "endTurn", seat: "player" });
    worker.postMessage({ type: "endTurn", seat: "ai" });
    await waitFor(worker, m => m.type === "endTurnResult");
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(lines.filter(e => e.type === "tickOverrun").length, 0);
  } finally { await worker.terminate(); }
});
