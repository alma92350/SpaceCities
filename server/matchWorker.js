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
     parent -> worker
       {type:"command", seat, envelope}           relay one client's raw envelope for admission

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
import { createGameState } from "../engine/state.js";
import { mulberry32 } from "../engine/rng.js";
import { projectFor } from "../engine/projection.js";
import { createMatch, admit, stepMatch, toCommandResult, TICK_DT, TICK_MS } from "./matchLoop.js";
import { readSnapshot, writeSnapshot } from "./matchSnapshot.js";

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

match.emitAck = rec => {
  parentPort.postMessage({ type: "commandResult", seat: rec.owner, seq: rec.seq, result: toCommandResult(rec.result) });
};

parentPort.on("message", msg => {
  if (msg.type !== "command") return;
  const admitted = admit(match, msg.envelope, msg.seat);
  // Mirrors net/wsServerTransport.js's own in-process reasoning exactly: a shape-rejected envelope
  // never reaches stepMatch, so emitAck never fires for it — answer immediately or the client's own
  // submitCommand() promise hangs forever. A shape-ACCEPTED envelope's real outcome always arrives
  // later, through emitAck, once it's actually due.
  if (!admitted.ok) {
    const seq = msg.envelope && Number.isInteger(msg.envelope.seq) ? msg.envelope.seq : null;
    if (seq !== null) parentPort.postMessage({ type: "commandResult", seat: msg.seat, seq, result: { ok: false, code: admitted.code } });
  }
});

parentPort.postMessage({ type: "ready", owners: match.state.owners, createGameStateOpts: workerData.createGameStateOpts, restored: !!restored, matchId });

// T-035 (FR-6): a final push still goes out WITH `over: true` (so every connected client's own
// showGameOver fires — see boot.js's render loop, which already reads game.state.over generically,
// T-030's own seam), but nothing ticks or pushes again after — a finished match has no more state
// to advance and no one left who should keep paying its CPU/bandwidth cost. The periodic snapshot
// stops too: an ended match's own last snapshot before this point is all a restart could ever need
// to recover (there's nothing further to lose).
const tickTimer = setInterval(() => {
  stepMatch(match, TICK_DT);
  for (const seat of match.state.owners) {
    parentPort.postMessage({ type: "state", seat, proj: projectFor(match.state, seat) });
  }
  if (match.state.over) {
    clearInterval(tickTimer);
    if (snapshotTimer) clearInterval(snapshotTimer);
  }
}, TICK_MS);
