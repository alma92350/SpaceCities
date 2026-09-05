/* ============================================================
   server/matchWorker.js — one match, hosted inside its own worker_threads Worker (ADR-0011, T-029).
   Runs the match's OWN 20Hz tick loop internally (server/matchLoop.js's stepMatch, driven by a real
   setInterval right here — the sim lives wherever its own state lives, never in the parent that
   spawns this worker), and speaks the wire protocol test/matchWorker.test.js documents to whichever
   thread constructed it via `new Worker("server/matchWorker.js", {workerData})`.

   WHY A WORKER, NOT JUST ANOTHER MATCH OBJECT IN THE SAME PROCESS. T-016 already fixed the entity-id
   counter onto per-state (ADR-0011's own "option A, scheduled follow-up") — the correctness defect
   that ORIGINALLY forced one-match-per-process is gone. Workers stay the right call anyway, for the
   two INDEPENDENT reasons ADR-0011 named alongside that defect: a match that throws is isolated to
   its own worker rather than taking the whole server down, and Node is single-threaded — separate
   OS threads are what actually let separate matches use the Space's 2 vCPUs at once, something no
   amount of same-process cleanup buys back. Measured before committing to this (T-029's own TASKS.md
   entry): real worker_threads overhead in this environment came in around 0.5-1.5MB RSS per worker,
   nowhere near large enough to make memory the binding constraint ADR-0011's own "Revisit if" clause
   named — CPU stays the real ceiling, exactly as that ADR anticipated.

   WIRE PROTOCOL (structured-clone postMessage, not JSON — no browser, no wire bytes to save here,
   only net/wsServerTransport.js-and-beyond's own hop to a real socket needs that):
     worker -> parent
       {type:"ready", owners, createGameStateOpts, restored, matchId}   once, right after the match
                                                      exists and is ticking — createGameStateOpts is
                                                      echoed back (the parent already has its own
                                                      copy, since it chose these opts before spawning
                                                      this worker in the first place) mainly so a
                                                      caller can confirm what it asked this worker to
                                                      boot with, the same role
                                                      net/wsServerTransport.js's own welcome message
                                                      plays one hop further out. `restored` (T-029a)
                                                      says whether a snapshot on disk WON over
                                                      createGameStateOpts — when true, the live
                                                      match's actual state came from that snapshot,
                                                      not from createGameStateOpts at all. `matchId`
                                                      (T-029b) is this match's stable identity —
                                                      recovered from the snapshot when `restored` is
                                                      true, freshly minted otherwise — echoed to
                                                      every client via the wire's own welcome message
                                                      one hop further out, so a reconnecting client
                                                      can tell "same match" from "a new one".
       {type:"commandResult", seat, seq, result}  a shape-rejection (immediate, from admit()) or an
                                                   applied/codec-rejected outcome (from emitAck,
                                                   once stepMatch actually processes it)
       {type:"state", seat, proj}                 once per seat, EVERY tick, unprompted — this
                                                   worker's own loop decides the cadence, not the
                                                   parent; RAW projectFor output, never quantized or
                                                   delta-encoded here (T-028b/c is a per-CONNECTION
                                                   concern, and only the parent knows connections)
       {type:"state", seat:SPECTATOR_SEAT, proj}  (T-037) the SAME cadence, ONE extra message per
                                                   tick, carrying projectForSpectator(...)'s full,
                                                   unfiltered view — posted unconditionally, exactly
                                                   like a real seat's own push, whether or not any
                                                   spectator is actually connected right now (again,
                                                   only the parent knows)
     parent -> worker
       {type:"command", seat, envelope}           relay one client's raw envelope for admission
       {type:"seatDisconnected", seat}   (T-036)   that seat's live connection just closed — starts
                                                    a grace-period timer, unless one is already
                                                    running for it
       {type:"seatConnected", seat}      (T-036)   a real, authorized connection for that seat just
                                                    opened (first join OR a reconnect) — cancels any
                                                    pending grace timer and hands control back if the
                                                    AI had already taken over
       {type:"fingerprint", seat, tick, fp}  (T-040)  a seat's own periodic self-check
                                                    (net/fingerprint.js's seatFingerprint, computed
                                                    client-side) — compared against this worker's own
                                                    CURRENT match.state (the only place that state
                                                    lives); a mismatch posts {type:"desyncDetected",
                                                    seat, tick} back AND logs it (T-061's structured
                                                    logEvent) — see the branch below for why comparing against
                                                    "current", not a historical checkpoint at msg.tick,
                                                    is a deliberate v1 simplification
     worker -> parent (continued)
       {type:"desyncDetected", seat, tick}  (T-040)  this seat's own fingerprint report didn't match
                                                    — net/wsWorkerTransport.js relays it back to that
                                                    SAME seat's own connection only, never broadcast

   T-036 (FR-5): DISCONNECT -> AI TAKEOVER -> RECLAIM. net/wsWorkerTransport.js owns detecting a
   connect/disconnect (it already tracks bySeat, one hop further out) and relays it here as the two
   message types above — this file owns the actual GRACE PERIOD and the CONTROLLER SWAP, since only
   it holds the live match.state those controllers actually live on. Deliberately NOT event-only:
   `graceTimers` (seat -> real setTimeout handle) is what makes a reconnect BEFORE the timer fires a
   true no-op cancellation rather than a race against an already-scheduled takeover.

   Owner "ai" already has everything it needs the moment `match.state.ai` is populated:
   engine/sim.js's own tick() calls runAI(state,dt) [owner "ai", its own default] UNCONDITIONALLY,
   and engine/aiCommon.js's runAI/controllerFor are already null-safe (T-034a) — so the takeover for
   "ai" is exactly `match.state.ai = createAiController(...)`, and reclaim is exactly setting it back
   to null; nothing else has to change. Owner "player" is NOT so simple: engine/sim.js's tick() never
   automatically drives "player" (state.playerAi has always been an opt-in, caller-driven slot —
   today, only server/session.js's own `aiSeats` loop for Tier 1 self-play ever populates and drives
   it). This file has no session.js to inherit that from, so its own tick loop below drives
   state.playerAi itself, the exact same one-line pattern session.js already established, so a
   disconnected HOST'S seat can fall to AI too — FR-5 makes no distinction between the two seats.

   No difficulty/strategy/archetype preference to honor here (unlike setup.js's own splash-screen
   dials): an abandoned seat gets a plain default-opts controller — solid and unexceptional, matching
   FR-5's own "falls to AI control" without inventing a preference nothing upstream ever expressed.

   T-057 (§6.3, ADR-0007): workerData.clockPolicy === "deliberation" replaces the real-time
   setInterval tick loop below with a GATED one — the sim advances in fixed batches
   (deliberationTicksPerStep, default 20 = 1 sim second) only once every seat NOT under scripted-AI
   control (engine/controllers.js's controllerFor(state, owner) === null — the same "human/agent
   seat" test T-034a/T-042 already established) has posted {type:"endTurn", seat}, so a bench/eval
   harness gets fully reproducible outcomes (no wall-clock model latency can ever leak into how far
   the sim advanced). A watchdog (watchdogMs, default 20000) force-advances a round that never
   completes — a stalled/crashed agent's own missing seat is simply treated as a pass for that
   round, never a hang. Both are workerData-overridable the same way graceMs already is, so tests
   use tiny values instead of real production ones. Every branch below is a NEW, additive code path
   behind this explicit opt-in — every caller that omits clockPolicy (every one before this task)
   keeps the exact real-time setInterval loop, byte-for-byte unchanged.

   Deliberately never wired to graceTimers/snapshotTimer/fingerprint handling: a deliberation match
   is never reachable through any human-facing surface at all (server/lobby.js's own
   listOpenMatches excludes it, and tools/serve.js's HTTP create-match handler never forwards a
   caller-supplied clockPolicy) — nothing ever opens a real WebSocket to one, so
   seatDisconnected/seatConnected/fingerprint messages simply never arrive for it in practice.

   SNAPSHOT/RESTORE (T-029a, ADR-0012, FR-22, server/matchSnapshot.js). `workerData.dataDir`, when
   given, is where this match's own state (and matchId, T-029b) gets snapshotted so an UNEXPECTED
   restart (a crash, not a graceful one — see matchSnapshot.js's own header for why that's the
   actual target, not every deploy) can resume instead of losing the match. At boot, a snapshot
   already on disk always wins over `createGameStateOpts` — this worker has no way to tell "this is
   a genuine first boot" apart from "this is a crash recovery", and a snapshot only ever exists on
   disk if an earlier boot in this same dataDir already reached this same code path, so trusting it
   is always the right call. No dataDir (local dev, and every test that doesn't pass one) skips both
   restore and snapshotting entirely — the exact same fresh-createGameState behavior this file had
   before T-029a, now also minting a fresh matchId every such boot (T-029b) since there is nothing
   to recover an identity from.
   ============================================================ */

"use strict";

import { parentPort, workerData } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { createGameState, createAiController } from "../engine/state.js";
import { runAI } from "../engine/ai.js";
import { controllerFor } from "../engine/controllers.js";
import { surrender } from "../engine/victory.js";
import { mulberry32 } from "../engine/rng.js";
import { projectFor, projectForSpectator, SPECTATOR_SEAT } from "../engine/projection.js";
import { createMatch, admit, stepMatch, toCommandResult, TICK_DT, TICK_MS } from "./matchLoop.js";
import { readSnapshot, writeSnapshot } from "./matchSnapshot.js";
import { seatFingerprint } from "../net/fingerprint.js";
import { logEvent } from "./log.js";

const { seed } = workerData.createGameStateOpts;
const dataDir = workerData.dataDir || null;
const restored = dataDir ? readSnapshot(dataDir) : null;
// T-034: a snapshot restore always wins (unchanged) — but for a genuinely FRESH match, the lobby
// that decided to spawn this worker already minted its own matchId (server/lobby.js's own
// createMatch) and needs THIS worker's live match to answer to that SAME id, not a second,
// independently-minted one nobody else knows about. workerData.matchId is that opt-in override;
// omitted (every test and every pre-T-034 caller), this is exactly the old self-minting behavior.
const matchId = restored ? restored.matchId : (workerData.matchId || randomUUID());
const state = restored ? restored.state : createGameState({ ...workerData.createGameStateOpts, rng: mulberry32(seed) });
const match = createMatch(state);

// Periodic, not per-tick — a snapshot only needs to be fresh enough to bound how much an
// UNEXPECTED crash can lose, not perfectly current (see this file's own header). Chosen against
// T-007a's own measured ~21s app-start outage window (TASKS.md T-029a's row, echoing T-007a): 5s
// bounds crash loss to well under a tenth of that window, nowhere near "a multi-minute worst
// case" the row explicitly says NOT to size against. What this has NOT been checked against is
// real write cost on HF's actual persistent storage, which docs/analysis/04-hf-deployment.md
// already characterizes as object storage rather than POSIX-latency local disk — TASKS.md's own
// open uncertainty U5 tracks that measurement separately and explicitly; this interval is a
// reasoned starting point against the outage-window math above, not a claim U5 is resolved.
const SNAPSHOT_INTERVAL_MS = 5000;
const snapshotTimer = dataDir ? setInterval(() => writeSnapshot(dataDir, matchId, match.state), SNAPSHOT_INTERVAL_MS) : null;

// T-036 (FR-5): long enough that net/wsClientTransport.js's own automatic reconnect (T-029b, a
// ~1.5s retry cadence) has resolved a genuine network blip many times over before this ever fires —
// this grace period is for "really gone" (closed the tab, closed the laptop), not a dropped packet.
// workerData-overridable so tests don't have to wait 20 real seconds per case.
const GRACE_MS = Number.isFinite(workerData.graceMs) ? workerData.graceMs : 20000;
const graceTimers = new Map();   // seat -> real setTimeout handle, only while counting down

// T-057: deliberation mode's own tuning, both workerData-overridable (tests use tiny values) —
// see this file's own header. clockPolicy defaults to "realtime" for anything other than the
// literal opt-in string, so a typo/unexpected value never silently disables the ordinary loop.
const clockPolicy = workerData.clockPolicy === "deliberation" ? "deliberation" : "realtime";
const DELIBERATION_TICKS_PER_STEP = Number.isFinite(workerData.deliberationTicksPerStep) ? workerData.deliberationTicksPerStep : 20;
const WATCHDOG_MS = Number.isFinite(workerData.watchdogMs) ? workerData.watchdogMs : 20000;
let readySeats = new Set();
let watchdogTimer = null;

// Owner "ai" already has state.ai (engine/sim.js's own built-in, unconditional runAI call); owner
// "player" needs its own state.playerAi (this file's own tick loop below drives it explicitly,
// since the engine never does) — see this file's own header for why the two aren't symmetric.
function aiSlotFor(owner) { return owner === "ai" ? "ai" : "playerAi"; }

match.emitAck = rec => {
  parentPort.postMessage({ type: "commandResult", seat: rec.owner, seq: rec.seq, result: toCommandResult(rec.result) });
};

parentPort.on("message", msg => {
  if (msg.type === "command") {
    const admitted = admit(match, msg.envelope, msg.seat);
    // Mirrors net/wsServerTransport.js's own in-process reasoning exactly: a shape-rejected
    // envelope never reaches stepMatch, so emitAck never fires for it — answer immediately or the
    // client's own submitCommand() promise hangs forever. A shape-ACCEPTED envelope's real outcome
    // always arrives later, through emitAck, once it's actually due.
    if (!admitted.ok) {
      const seq = msg.envelope && Number.isInteger(msg.envelope.seq) ? msg.envelope.seq : null;
      if (seq !== null) parentPort.postMessage({ type: "commandResult", seat: msg.seat, seq, result: { ok: false, code: admitted.code } });
    }
    return;
  }
  if (msg.type === "surrender") {
    // T-059a (FR-8): the real network trigger single-player already has (boot.js/overlays.js/
    // starmap.js all call this exact same engine/victory.js function) and multiplayer never did.
    // Nothing else needs to happen here: engine/victory.js's own surrender() doesn't end the match
    // immediately, only marks this seat eliminated — the very next regular tick's own stepMatch ->
    // checkWinCondition resolves state.over/winner/winReason from that, the identical one-tick
    // latency every other elimination (a lost Command Center, T-046) already has. Same
    // defense-in-depth guard endTurn already uses above: a scripted-AI-controlled seat has no real
    // connection (WebSocket or MCP seat handle) to ever send this from.
    if (!controllerFor(match.state, msg.seat)) surrender(match.state, msg.seat);
    return;
  }
  if (msg.type === "endTurn") {
    // Only a REQUIRED seat's own call counts — a scripted-AI-controlled owner never sends this
    // message at all (it has no MCP tool call driving it), so this guard is defense-in-depth
    // against a malformed/stray message, not something a real caller would ever hit.
    if (clockPolicy !== "deliberation" || controllerFor(match.state, msg.seat)) return;
    readySeats.add(msg.seat);
    const required = match.state.owners.filter(o => !controllerFor(match.state, o));
    if (required.every(o => readySeats.has(o))) advanceDeliberationRound();
    return;
  }
  if (msg.type === "seatDisconnected") {
    if (graceTimers.has(msg.seat)) return;   // already counting down — a second close for the same seat is not a second grace period
    logEvent("seatDisconnected", { matchId, seat: msg.seat });
    graceTimers.set(msg.seat, setTimeout(() => {
      graceTimers.delete(msg.seat);
      const slot = aiSlotFor(msg.seat);
      if (!match.state[slot]) {
        match.state[slot] = createAiController(match.state.planetId, {});
        logEvent("aiTakeover", { matchId, seat: msg.seat });
      }
    }, GRACE_MS));
    return;
  }
  if (msg.type === "seatConnected") {
    const timer = graceTimers.get(msg.seat);
    // A genuine reconnect (mid-grace, or after AI had already taken over) is worth an operational
    // log line; seatConnected ALSO fires for a seat's very first join (this file's own header),
    // which is not a reconnect at all and would just be noise here.
    const wasAway = !!timer || !!match.state[aiSlotFor(msg.seat)];
    if (timer) { clearTimeout(timer); graceTimers.delete(msg.seat); }
    // Hands control back unconditionally — a harmless no-op if the grace period never actually
    // fired (already null), the real point if it did.
    match.state[aiSlotFor(msg.seat)] = null;
    if (wasAway) logEvent("seatReconnected", { matchId, seat: msg.seat });
    return;
  }
  if (msg.type === "fingerprint") {
    // T-040 (FR-20): compared against THIS worker's own CURRENT match.state — not a historical
    // checkpoint at msg.tick — a deliberate v1 simplification (net/fingerprint.js's own header
    // documents why this file is the only place that can do the comparison at all: match.state
    // lives only here). Under real network latency a client's own report always reflects a tick
    // slightly behind whatever this worker is at by the time it arrives, so an occasional benign
    // mismatch from tick drift alone is possible — acceptable for what this is: an operations
    // signal a human reviews (logEvent below — one structured JSON line, T-061), never an
    // enforcement action (no disconnect, no correction), so a rare false positive costs a look at
    // a log line, not a wrongly-punished player. A genuine, sustained divergence (the actual
    // target) reproduces on every report, tick drift or not.
    const expected = seatFingerprint(match.state, msg.seat);
    if (expected !== msg.fp) {
      logEvent("desync", { matchId, seat: msg.seat, tick: msg.tick });
      parentPort.postMessage({ type: "desyncDetected", seat: msg.seat, tick: msg.tick });
    }
    return;
  }
});

parentPort.postMessage({ type: "ready", owners: match.state.owners, createGameStateOpts: workerData.createGameStateOpts, restored: !!restored, matchId });

// T-036: state.playerAi driven explicitly, BEFORE stepMatch — engine/sim.js's own tick() only ever
// auto-drives "ai" (its own hardcoded default), so a disconnected HOST's seat needs this file to do
// for "player" what the engine already does for "ai" on its own. Same ordering server/session.js's
// own aiSeats loop already established (AI decisions before the sim step that acts on them, so both
// AI-driven owners get applied at the same relative tick position). Shared verbatim by both clock
// policies below — advancing the sim by exactly one tick is the same operation either way; only
// WHEN it happens, and whether every intermediate tick gets its own state push, differs.
function stepOnce() {
  if (match.state.playerAi) runAI(match.state, TICK_DT, "player");
  stepMatch(match, TICK_DT);
}

function pushState() {
  for (const seat of match.state.owners) {
    parentPort.postMessage({ type: "state", seat, proj: projectFor(match.state, seat) });
  }
  // T-037 (FR-7): posted unconditionally, every push, exactly like each real seat's own push above
  // — this worker has no idea whether any spectator is actually connected (that bookkeeping is
  // entirely net/wsWorkerTransport.js's own job, one hop further out), so it doesn't try to know.
  parentPort.postMessage({ type: "state", seat: SPECTATOR_SEAT, proj: projectForSpectator(match.state) });
}

// A finished match has no more state to advance and no one left who should keep paying its
// CPU/bandwidth cost — shared end-of-match cleanup for both clock policies (T-057's own
// deliberation path has no dataDir/graceTimers in practice per this file's own header, but a
// stray one left running costs nothing to also stop here).
function stopMatchTimers(tickTimer) {
  // Only ever called once match.state.over is true (both call sites below gate on it first) — safe
  // to log the match's own final outcome unconditionally right here, the one place both clock
  // policies' end-of-match paths already converge.
  logEvent("matchEnded", { matchId, tick: match.state.tick, time: match.state.time, winner: match.state.winner, winReason: match.state.winReason ?? null });
  if (tickTimer) clearInterval(tickTimer);
  if (snapshotTimer) clearInterval(snapshotTimer);
  if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; }
  for (const timer of graceTimers.values()) clearTimeout(timer);
  graceTimers.clear();
}

// NFR-2: < 25ms of server-side work per tick (a 4-seat Gigantic-map late game, HF free-tier CPU) —
// workerData-overridable the same way graceMs/watchdogMs/deliberationTicksPerStep already are, so
// a test can force (or rule out) an overrun deterministically instead of depending on real machine
// speed. Deliberately not wired into deliberation mode below — it advances a whole batch of ticks
// silently and by design answers to no wall-clock-per-tick budget at all (this file's own header).
const TICK_BUDGET_MS = Number.isFinite(workerData.tickBudgetMs) ? workerData.tickBudgetMs : 25;

if (clockPolicy === "realtime") {
  // T-035 (FR-6): a final push still goes out WITH `over: true` (so every connected client's own
  // showGameOver fires — see boot.js's render loop, which already reads game.state.over
  // generically, T-030's own seam), but nothing ticks or pushes again after.
  const tickTimer = setInterval(() => {
    const t0 = performance.now();
    stepOnce();
    pushState();
    const elapsedMs = performance.now() - t0;
    if (elapsedMs > TICK_BUDGET_MS) logEvent("tickOverrun", { matchId, tick: match.state.tick, elapsedMs: Math.round(elapsedMs * 100) / 100 });
    if (match.state.over) stopMatchTimers(tickTimer);
  }, TICK_MS);
} else {
  // T-057: one push for the starting tick=0 state — an agent needs to see what it's starting with
  // to decide its own first turn — then no interval at all: the first ROUND advances only once
  // every required seat has posted its own endTurn (the message handler above) or this initial
  // watchdog fires first, whichever happens first. advanceDeliberationRound re-arms the next
  // round's own watchdog itself.
  pushState();
  armDeliberationWatchdog();
}

function armDeliberationWatchdog() {
  watchdogTimer = setTimeout(advanceDeliberationRound, WATCHDOG_MS);
}

// T-057 (§6.3, ADR-0007): a whole round — up to DELIBERATION_TICKS_PER_STEP ticks, advanced
// SILENTLY (no per-tick state push; an eval harness never asked to see N-1 throwaway intermediate
// frames) — then ONE state push reflecting the round's own final tick. endTurnResult is posted
// BEFORE that push, deliberately: it's the signal a caller's own sequential "await the result, THEN
// await the resulting state" awaits in that order (test/matchWorker.test.js's own T-057 cases), and
// since each postMessage is delivered as its own turn on the receiving side, sending the smaller,
// order-defining message first is what makes that chaining reliable rather than racy.
function advanceDeliberationRound() {
  if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; }
  readySeats = new Set();
  for (let i = 0; i < DELIBERATION_TICKS_PER_STEP && !match.state.over; i++) stepOnce();
  parentPort.postMessage({ type: "endTurnResult", tick: match.state.tick });
  pushState();
  if (match.state.over) { stopMatchTimers(null); return; }
  armDeliberationWatchdog();
}
