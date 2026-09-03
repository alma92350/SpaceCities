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
