/* ============================================================
   T-053 (FR-15): the submit-side counterpart to server/mcpObservationCache.js — a live match's
   real engine State, and the ONLY codec that may ever mutate it (net/commandCodec.js, run
   entirely INSIDE the worker via admit()/stepMatch — see server/matchWorker.js's own header),
   lives inside its own worker_threads Worker. An MCP action tool call arrives on the main
   thread and needs to submit a command the exact same way a real WebSocket connection already
   does (worker.postMessage({type:"command", seat, envelope}), then a later
   {type:"commandResult", seat, seq, result} message) — the only new piece is CORRELATION: a
   WebSocket client tracks its own seq and matches replies client-side; a single MCP tools/call
   is one request/response, so this bridge does that matching here and resolves a Promise.
   ============================================================ */

"use strict";

import { encode } from "../net/commandEnvelope.js";

/**
 * @param {import("node:worker_threads").Worker} worker
 * @returns {{
 *   sendCommand: (seat: string, cmd: Object) => Promise<{ok:boolean, code?:string, result?:Object}>,
 *   surrender: (seat: string) => void,
 * }}
 */
export function attachCommandBridge(worker) {
  let nextSeq = 1;
  /** @type {Map<number, {seat: string, resolve: (result: Object) => void}>} */
  const pending = new Map();

  worker.on("message", msg => {
    if (!msg || msg.type !== "commandResult" || !pending.has(msg.seq)) return;
    const waiting = pending.get(msg.seq);
    // Defense in depth, not a case a real worker ever actually produces: this bridge only ever
    // resolves a pending call with a reply for the SAME seat it was sent for, even though seq
    // alone (globally unique per bridge instance, never reused) would already be enough in
    // practice — see this file's own test for the adversarial shape this guards.
    if (msg.seat !== waiting.seat) return;
    pending.delete(msg.seq);
    waiting.resolve(msg.result);
  });

  function sendCommand(seat, cmd) {
    const seq = nextSeq++;
    const envelope = encode(cmd, seq, null);
    return new Promise(resolve => {
      pending.set(seq, { seat, resolve });
      worker.postMessage({ type: "command", seat, envelope });
    });
  }

  // T-059a (FR-8): fire-and-forget — unlike sendCommand, nothing here correlates a reply, because
  // server/matchWorker.js's own "surrender" handler sends none back (engine/victory.js's own
  // surrender() doesn't end the match immediately; the caller's next get_situation/wait_for_event
  // call is what actually observes the outcome, on the match's own very next tick).
  function surrender(seat) {
    worker.postMessage({ type: "surrender", seat });
  }

  return { sendCommand, surrender };
}
