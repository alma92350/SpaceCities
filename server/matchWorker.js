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
       {type:"ready", owners, createGameStateOpts}   once, right after the match exists and is
                                                      ticking — createGameStateOpts is echoed back
                                                      (the parent already has its own copy, since it
                                                      chose these opts before spawning this worker in
                                                      the first place) mainly so a caller can confirm
                                                      what actually reached createGameState, the same
                                                      role net/wsServerTransport.js's own welcome
                                                      message plays one hop further out
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
   ============================================================ */

"use strict";

import { parentPort, workerData } from "node:worker_threads";
import { createGameState } from "../engine/state.js";
import { mulberry32 } from "../engine/rng.js";
import { projectFor } from "../engine/projection.js";
import { createMatch, admit, stepMatch, toCommandResult, TICK_DT, TICK_MS } from "./matchLoop.js";

const { seed } = workerData.createGameStateOpts;
const state = createGameState({ ...workerData.createGameStateOpts, rng: mulberry32(seed) });
const match = createMatch(state);

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

parentPort.postMessage({ type: "ready", owners: match.state.owners, createGameStateOpts: workerData.createGameStateOpts });

setInterval(() => {
  stepMatch(match, TICK_DT);
  for (const seat of match.state.owners) {
    parentPort.postMessage({ type: "state", seat, proj: projectFor(match.state, seat) });
  }
}, TICK_MS);
