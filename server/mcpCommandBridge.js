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
 * @param {number} [ackTimeoutMs] how long sendCommand waits for the worker's commandResult before
 *   giving up on THIS call (default 5000 — a realtime ack is due INPUT_DELAY_TICKS=3 after
 *   admission, ~150ms at 20Hz, so 5s is ~30x headroom while staying two orders of magnitude under
 *   the ~120s tool-call timeout a real MCP client enforces; an agent observed that client timeout
 *   three matches running when a result ever failed to arrive).
 * @returns {{
 *   sendCommand: (seat: string, cmd: Object) => Promise<{ok:boolean, code?:string, result?:Object}>,
 *   surrender: (seat: string) => void,
 *   setSeatAi: (seat: string, enabled: boolean, opts?: {strategy?: string, difficulty?: string}) => Promise<{ai: boolean}>,
 *   findBuildSite: (buildingType: string, x: number, y: number) => Promise<{site: {x:number,y:number}|null}>,
 *   setProductionPlan: (seat: string, action: "set"|"clear"|"list", plan?: Object[]) => Promise<{plan: Object[]|null}>,
 *   endTurn: (seat: string) => void,
 * }}
 */
export function attachCommandBridge(worker, ackTimeoutMs = 5000) {
  let nextSeq = 1;
  /** @type {Map<number, {seat: string, resolve: (result: Object) => void}>} */
  const pending = new Map();

  const COMMAND_TIMEOUT_RESULT = { ok: false, code: "command-timeout" };

  // A pending call whose worker can never reply must not pend forever: the MCP client itself
  // enforces a ~120s tool-call timeout, and a call that hangs that long costs an agent an entire
  // blind window (three observed match losses). Two cases a real worker can still produce:
  //   - the commandResult message is simply lost (worker mid-step, admit() threw, match just ended
  //     so its own stepMatch loop stopped draining the rec), so THIS timeout fires per call; and
  //   - the worker exits entirely (crash, lobby teardown), after which NO pending call can ever
  //     resolve — the exit handler below settles all of them at once.
  function settle(seq, result) {
    const waiting = pending.get(seq);
    if (!waiting) return;
    pending.delete(seq);
    clearTimeout(waiting.timer);
    waiting.resolve(result);
  }

  worker.on("message", msg => {
    if (!msg || msg.type !== "commandResult" || !pending.has(msg.seq)) return;
    // Defense in depth, not a case a real worker ever actually produces: this bridge only ever
    // resolves a pending call with a reply for the SAME seat it was sent for, even though seq
    // alone (globally unique per bridge instance, never reused) would already be enough in
    // practice — see this file's own test for the adversarial shape this guards.
    const waiting = pending.get(msg.seq);
    if (msg.seat !== waiting.seat) return;
    settle(msg.seq, msg.result);
  });

  worker.on("exit", () => {
    for (const seq of [...pending.keys()]) settle(seq, COMMAND_TIMEOUT_RESULT);
  });

  function sendCommand(seat, cmd) {
    const seq = nextSeq++;
    const envelope = encode(cmd, seq, null);
    return new Promise(resolve => {
      const timer = setTimeout(() => settle(seq, COMMAND_TIMEOUT_RESULT), ackTimeoutMs);
      pending.set(seq, { seat, resolve, timer });
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

  // Seat handover (MCP set_seat_controller). Request/response, unlike surrender: the caller needs
  // to know the swap actually landed before it stops playing (or starts again), and the worker's
  // own setSeatAi handler answers every request with one {type:"seatController", seat, ai}. Keyed
  // by seat rather than a seq because a seat only ever has one handover in flight — it is a
  // toggle, not a stream of independent submissions the way commands are. A worker that never
  // answers (crashed, torn down) settles the same way sendCommand's own timeout does, reporting
  // the state the caller asked for rather than hanging.
  /** @type {Map<string, (r: {ai: boolean}) => void>} */
  const pendingController = new Map();

  worker.on("message", msg => {
    if (!msg || msg.type !== "seatController") return;
    const resolve = pendingController.get(msg.seat);
    if (!resolve) return;
    pendingController.delete(msg.seat);
    resolve({ ai: !!msg.ai });
  });

  function setSeatAi(seat, enabled, opts = {}) {
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        if (pendingController.get(seat) === settle) pendingController.delete(seat);
        resolve({ ai: !!enabled });
      }, ackTimeoutMs);
      const settle = result => { clearTimeout(timer); resolve(result); };
      pendingController.set(seat, settle);
      worker.postMessage({ type: "setSeatAi", seat, enabled: !!enabled, opts });
    });
  }

  // ===== Agent-observability round-trips =====
  // Three more request/response pairs on the same worker port, each correlated the same way
  // sendCommand already correlates a command ack. They are here rather than as WireCommands
  // because none of them is a command: two are questions about the match, and the third
  // (a standing production order) is a policy the worker applies on the agent's behalf, tick by
  // tick, through the ordinary command path.
  let nextReqId = 1;
  /** @type {Map<number, (payload: Object) => void>} */
  const pendingReq = new Map();

  worker.on("message", msg => {
    if (!msg || (msg.type !== "buildSite" && msg.type !== "productionPlan")) return;
    const resolve = pendingReq.get(msg.reqId);
    if (!resolve) return;
    pendingReq.delete(msg.reqId);
    resolve(msg);
  });

  function request(message, fallback) {
    const reqId = nextReqId++;
    return new Promise(resolve => {
      const timer = setTimeout(() => { pendingReq.delete(reqId); resolve(fallback); }, ackTimeoutMs);
      pendingReq.set(reqId, payload => { clearTimeout(timer); resolve(payload); });
      worker.postMessage({ ...message, reqId });
    });
  }

  const findBuildSite = (buildingType, x, y) =>
    request({ type: "findBuildSite", buildingType, x, y }, { site: null });

  const setProductionPlan = (seat, action, plan) =>
    request({ type: "productionPlan", seat, action, plan }, { plan: null });

  // Fire-and-forget like surrender, and for the same reason: the worker answers an end-of-turn
  // with the ROUND's own advance (an endTurnResult and then a state push), which the caller
  // observes through its ordinary situation/event tools rather than through this reply.
  function endTurn(seat) {
    worker.postMessage({ type: "endTurn", seat });
  }

  return { sendCommand, surrender, setSeatAi, findBuildSite, setProductionPlan, endTurn };
}
