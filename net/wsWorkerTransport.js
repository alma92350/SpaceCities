/* ============================================================
   net/wsWorkerTransport.js — the PARENT half of T-029: given an HTTP server and an already-spawned
   server/matchWorker.js Worker, attaches WebSocket handling for that worker's match, exactly the
   role net/wsServerTransport.js's attachWsMatch plays for an in-process match. Same browser-facing
   wire protocol (net/wsClientTransport.js can't tell the two apart — see that file's own header),
   same `?seat=<owner>` binding, same opts.path gate — everything ADR-0011 assigns to the parent
   ("owns... the WebSocket connections... and relays commands and state between sockets and
   workers") lives here; everything else (the match itself, its own tick loop) lives inside the
   worker (server/matchWorker.js).

   ASYNC, unlike attachWsMatch: this function must wait for the worker's own "ready" message before
   it knows the match's owners/createGameStateOpts (needed for seat validation and the welcome
   payload) — there is no synchronous match.state to read here, only a thread boundary to cross.

   NO broadcastState(): unlike an in-process match, the worker runs its OWN internal tick loop and
   pushes a "state" message per seat unprompted, every tick — this file only ever REACTS to what
   the worker sends, via buildStateMessage (net/wsServerTransport.js's own shared helper) applied
   per connection, exactly the same quantize-then-full-or-delta decision broadcastState() makes.

   admit()/toCommandResult() DON'T appear here at all — those run INSIDE the worker
   (server/matchWorker.js imports them directly); this file only ever relays raw envelopes in and
   commandResult messages back out.
   ============================================================ */

"use strict";

import { acceptUpgrade } from "./ws.js";
import { buildStateMessage } from "./wsServerTransport.js";

/**
 * @param {import("http").Server} httpServer
 * @param {import("worker_threads").Worker} worker - already spawned (new Worker("server/matchWorker.js", {workerData}))
 * @param {{allowedOrigins?: string[], path?: string}} [opts]
 * @returns {Promise<{owners: string[], createGameStateOpts: Object, matchId: string, close: () => void}>}
 *   resolves once the worker's own "ready" message arrives; owners/createGameStateOpts/matchId are
 *   that same message's own data, exposed here so a caller doesn't need its own separate copy or a
 *   second round-trip to the worker to learn what it already told this function. `matchId` (T-029b)
 *   is the worker's own — recovered from a restored snapshot, or freshly minted (server/matchWorker.js's
 *   own job either way); this file only relays it into the wire's welcome message, same as owners/
 *   createGameStateOpts.
 */
export function attachWsMatchWorker(httpServer, worker, opts = {}) {
  const { allowedOrigins, path } = opts;

  return new Promise(resolve => {
    worker.once("message", readyMsg => {
      const { owners, createGameStateOpts, matchId } = readyMsg;
      const bySeat = new Map();               // owner -> live connection, at most one per seat
      const lastSnapshotBySeat = new Map();    // owner -> last quantized snapshot sent (T-028b)

      function welcomePayload(seat) {
        return JSON.stringify({ type: "welcome", seat, matchId, createGameState: createGameStateOpts });
      }

      function onUpgrade(req, socket, head) {
        const url = new URL(req.url, "http://localhost");
        if (path && url.pathname !== path) { socket.destroy(); return; }
        const seat = url.searchParams.get("seat");
        if (!seat || !owners.includes(seat)) { socket.destroy(); return; }

        acceptUpgrade(req, socket, head, { allowedOrigins }).then(result => {
          if (!result.ok) return;
          const conn = result.connection;
          bySeat.set(seat, conn);
          conn.send(welcomePayload(seat));

          conn.onmessage = (data, isBinary) => {
            if (isBinary) return;   // a client only ever sends a JSON command envelope, never binary
            let envelope;
            try { envelope = JSON.parse(data); } catch { return; }   // malformed JSON: nothing to relay
            // Shape validation and application both happen INSIDE the worker (admit()/stepMatch),
            // never here — this handler is a pure relay, exactly ADR-0011's own "parent relays
            // commands and state" wording. The worker answers a shape-rejection immediately and an
            // applied/codec-rejected outcome later, both via its own commandResult message, which
            // the worker.on("message") listener below forwards on unchanged.
            worker.postMessage({ type: "command", seat, envelope });
          };
          conn.onclose = () => {
            if (bySeat.get(seat) === conn) bySeat.delete(seat);
            // Same reasoning as net/wsServerTransport.js's own onclose: a reconnect must get a
            // fresh full snapshot, never a delta against a dead connection's stale baseline.
            lastSnapshotBySeat.delete(seat);
          };
        });
      }

      httpServer.on("upgrade", onUpgrade);

      function onWorkerMessage(msg) {
        const conn = bySeat.get(msg.seat);
        if (!conn) return;   // that seat isn't currently connected — nothing to relay to
        if (msg.type === "commandResult") {
          conn.send(JSON.stringify({ type: "commandResult", seq: msg.seq, result: msg.result }));
        } else if (msg.type === "state") {
          conn.send(JSON.stringify({ type: "state", ...buildStateMessage(msg.proj, lastSnapshotBySeat, msg.seat) }));
        }
      }
      worker.on("message", onWorkerMessage);

      resolve({
        owners,
        createGameStateOpts,
        matchId,
        /** Stop accepting new upgrades on this httpServer for this match and close every live
         *  connection. Idempotent. Does NOT terminate the worker — that's owned by whoever spawned
         *  it, the same way attachWsMatch's own close() never owns the httpServer it was given. */
        close() {
          httpServer.off("upgrade", onUpgrade);
          worker.off("message", onWorkerMessage);
          for (const conn of bySeat.values()) conn.close();
          bySeat.clear();
          lastSnapshotBySeat.clear();
        },
      });
    });
  });
}
