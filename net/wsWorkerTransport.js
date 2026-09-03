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

   T-037 (FR-7): SPECTATORS, a second, deliberately much simpler connection kind alongside the seat
   scheme above — `?spectate=1` instead of `?seat=<owner>&token=<token>`, no owners.includes/
   authorizeSeat check (there is no seat to own or reclaim), no seatConnected/seatDisconnected
   message to the worker (a spectator is never a seat server/matchWorker.js's own grace-period logic
   needs to know about), and no command relay AT ALL — conn.onmessage is simply never wired for a
   spectator connection, so "a spectator cannot issue any command" (the PRD's own exit criterion) is
   true by construction here, not merely enforced by the worker rejecting an unrecognized seat later.
   `spectators` (a Set, not a Map — unlike bySeat there is no owner identity to key by, and FR-7
   allows any NUMBER of them at once) tracks live connections; `lastSnapshotBySpectator` (keyed by
   the connection object itself) gives each one its OWN independent T-028b delta baseline, reusing
   buildStateMessage exactly as the seat path does — the wire SHAPE server/matchWorker.js's
   projectForSpectator(...) output carries (units/buildings/nodes arrays) is identical to an ordinary
   projectFor(...) payload, just unfiltered, so quantizeForWire/computeDelta need no changes at all
   to work on it. `spectatorsEnabled` (default true — FR-7's own "unless the host has disabled
   spectators") is a plain opt, not a callback like authorizeSeat: there is no per-connection identity
   to authorize, only a single host-wide on/off switch.
   ============================================================ */

"use strict";

import { acceptUpgrade } from "./ws.js";
import { buildStateMessage } from "./wsServerTransport.js";
import { SPECTATOR_SEAT } from "../engine/projection.js";

/**
 * @param {import("http").Server} httpServer
 * @param {import("worker_threads").Worker} worker - already spawned (new Worker("server/matchWorker.js", {workerData}))
 * @param {{allowedOrigins?: string[], path?: string, requireMatch?: boolean, authorizeSeat?: (seat: string, url: URL) => boolean, spectatorsEnabled?: boolean}} [opts]
 *   requireMatch/authorizeSeat are T-034's own lobby seam — see this file's header for the
 *   multi-match dispatch they exist for. spectatorsEnabled (T-037, default true) gates the
 *   `?spectate=1` connection kind — see this file's header for why it's a plain flag, not a callback.
 * @returns {Promise<{owners: string[], createGameStateOpts: Object, matchId: string, close: () => void}>}
 *   resolves once the worker's own "ready" message arrives; owners/createGameStateOpts/matchId are
 *   that same message's own data, exposed here so a caller doesn't need its own separate copy or a
 *   second round-trip to the worker to learn what it already told this function. `matchId` (T-029b)
 *   is the worker's own — recovered from a restored snapshot, or freshly minted (server/matchWorker.js's
 *   own job either way); this file only relays it into the wire's welcome message, same as owners/
 *   createGameStateOpts.
 */
export function attachWsMatchWorker(httpServer, worker, opts = {}) {
  const { allowedOrigins, path, requireMatch, authorizeSeat, spectatorsEnabled = true } = opts;

  return new Promise(resolve => {
    worker.once("message", readyMsg => {
      const { owners, createGameStateOpts, matchId } = readyMsg;
      const bySeat = new Map();               // owner -> live connection, at most one per seat
      const lastSnapshotBySeat = new Map();    // owner -> last quantized snapshot sent (T-028b)
      const spectators = new Set();                  // every live spectator connection, unbounded (T-037)
      const lastSnapshotBySpectator = new Map();      // connection -> its own last quantized snapshot (T-028b, per spectator)

      function welcomePayload(seat) {
        return JSON.stringify({ type: "welcome", seat, matchId, createGameState: createGameStateOpts });
      }
      function spectatorWelcomePayload() {
        return JSON.stringify({ type: "welcome", seat: null, spectator: true, matchId, createGameState: createGameStateOpts });
      }

      function onUpgrade(req, socket, head) {
        const url = new URL(req.url, "http://localhost");
        // T-034: a MISMATCH here means "not for this attachment", never "not for anyone" — several
        // matches share one http.Server (each call to this function adds its OWN "upgrade"
        // listener, and Node invokes every listener registered for an event), so destroying the
        // socket here would break whichever OTHER attachment the request was actually meant for.
        // Leaving it unclaimed is safe: tools/serve.js's own dispatcher owns a single catch-all that
        // destroys anything no attachment marked handled, once every "upgrade" listener has run.
        if (path && url.pathname !== path) return;
        if (requireMatch && url.searchParams.get("match") !== matchId) return;
        socket.__scHandled = true;   // this request IS for this match — nobody else gets to destroy it

        if (url.searchParams.get("spectate") === "1") {
          if (!spectatorsEnabled) { socket.destroy(); return; }
          acceptUpgrade(req, socket, head, { allowedOrigins }).then(result => {
            if (!result.ok) return;
            const conn = result.connection;
            spectators.add(conn);
            conn.send(spectatorWelcomePayload());
            // Deliberately NO conn.onmessage: see this file's own header on why "cannot issue any
            // command" is true by construction here rather than relying on the worker to reject an
            // unrecognized seat later (defense that never needs testing at that later layer at all).
            conn.onclose = () => { spectators.delete(conn); lastSnapshotBySpectator.delete(conn); };
          });
          return;
        }

        const seat = url.searchParams.get("seat");
        if (!seat || !owners.includes(seat)) { socket.destroy(); return; }
        if (authorizeSeat && !authorizeSeat(seat, url)) { socket.destroy(); return; }

        acceptUpgrade(req, socket, head, { allowedOrigins }).then(result => {
          if (!result.ok) return;
          const conn = result.connection;
          bySeat.set(seat, conn);
          conn.send(welcomePayload(seat));
          worker.postMessage({ type: "seatConnected", seat });

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
            worker.postMessage({ type: "seatDisconnected", seat });
          };
        });
      }

      httpServer.on("upgrade", onUpgrade);

      function onWorkerMessage(msg) {
        if (msg.type === "state" && msg.seat === SPECTATOR_SEAT) {
          for (const conn of spectators) {
            conn.send(JSON.stringify({ type: "state", ...buildStateMessage(msg.proj, lastSnapshotBySpectator, conn) }));
          }
          return;
        }
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
         *  connection — every seat's AND every spectator's. Idempotent. Does NOT terminate the
         *  worker — that's owned by whoever spawned it, the same way attachWsMatch's own close()
         *  never owns the httpServer it was given. */
        close() {
          httpServer.off("upgrade", onUpgrade);
          worker.off("message", onWorkerMessage);
          for (const conn of bySeat.values()) conn.close();
          bySeat.clear();
          lastSnapshotBySeat.clear();
          for (const conn of spectators) conn.close();
          spectators.clear();
          lastSnapshotBySpectator.clear();
        },
      });
    });
  });
}
