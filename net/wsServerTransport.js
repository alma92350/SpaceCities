/* ============================================================
   net/wsServerTransport.js — the SERVER half of T-026's WebSocket transport. Given an HTTP
   server and an already-built server/matchLoop.js match (the same object T-023's own stepMatch
   drives — mirroring net/loopback.js's own precedent of wrapping an ALREADY-CONSTRUCTED
   server/session.js session rather than building one itself), attaches WebSocket handling for
   that match's seats.

   WIRE PROTOCOL, both directions JSON text frames over net/ws.js:
     server -> client
       {type:"welcome", seat, matchId, createGameState:{planetId,seed,sizeMult,resourceMult,swapAsym}}
         sent once, immediately on connect — everything a client needs to regenerate this match's
         map locally (ADR-0009: the map is deterministic from these fields, so it's never sent).
         `matchId` (T-029b) is this match's stable identity, minted once per attachWsMatch() call —
         a reconnecting client compares it against whatever it saw on its PREVIOUS welcome to tell
         "I rejoined the same match" from "this is a different one" (ADR-0012's "restart-resume and
         player-reconnect are deliberately the same mechanism"). This in-process path never restores
         from a snapshot (that's server/matchWorker.js's own job, T-029a), so every attachWsMatch()
         call mints a fresh id — there is never an existing identity to recover here.
       {type:"state", full:true, proj: <engine/projectionDelta.js's quantizeForWire(projectFor(...))>}
         the FIRST push to a given connection — a full (but quantized, T-028c) snapshot, so a fresh
         client (or one that just reconnected) has a real baseline to delta against from here on.
       {type:"state", full:false, delta: <computeDelta(prev, curr), both sides already quantized>}
         every push after the first, on the SAME connection (ADR-0009 M3, T-028b) — computed against
         the last snapshot actually sent to THIS connection, tracked in lastSnapshotBySeat below and
         cleared on disconnect so a reconnect always gets a fresh full push, never a delta against a
         dead connection's stale baseline. Needs no separate application-level ack: this transport
         runs over a real WebSocket (TCP-backed, in-order, no loss within one connection — net/ws.js
         never drops a frame), so "the last snapshot sent on this still-open connection" already IS
         "the last one the client has" for as long as the socket stays open; a closed/replaced
         connection is exactly the case lastSnapshotBySeat's own clear-on-disconnect handles.
         Both the full-send path and lastSnapshotBySeat store the SAME quantizeForWire(...) output —
         quantizing only one side would make every tick look "changed" against its own
         differently-rounded predecessor, defeating T-028c's own point.
         Either push is sent on broadcastState() — the caller decides the cadence (every stepMatch
         tick, in practice), matching how net/loopback.js's own tick() is caller-driven, never
         self-timed.
       {type:"commandResult", seq, result}
         sent once a submitted command is actually APPLIED (server/matchLoop.js's own emitAck
         hook) — correlates back to the client's own submitCommand call by seq, exactly as
         net/transport.js's CommandResultEvent JSDoc already documents for "once envelopes exist
         (Phase 2/3)".
     client -> server
       a bare net/commandEnvelope.js envelope ({v, seq, tick, cmd}), JSON-encoded — nothing else
       ever arrives on this connection, so no further discriminator is needed.

   SCOPE. One match, whichever seats opts.match.state.owners already lists — no lobby, no seat
   tokens, no multi-match hosting (T-029/T-033 territory). A connection names its seat via
   `?seat=<owner>` on the upgrade URL; that is deliberately the simplest possible binding that
   makes the TRANSPORT itself provable end to end, not a claim that it is how a real deployment
   picks a seat.

   opts.path (T-027): when set, only an upgrade whose URL pathname matches exactly is accepted —
   everything else is refused the same way an unknown seat already is. tools/serve.js's own HTTP
   server uses this to keep its reserved /mcp namespace (T-049's future job) from also silently
   being a valid way in to this match; omitted, every pathname is accepted, unchanged from before
   this option existed.
   ============================================================ */

"use strict";

import { randomUUID } from "node:crypto";
import { acceptUpgrade } from "./ws.js";
import { admit, toCommandResult } from "../server/matchLoop.js";
import { projectFor } from "../engine/projection.js";
import { computeDelta, quantizeForWire } from "../engine/projectionDelta.js";

/**
 * Turns a RAW projectFor(...) output into this seat's next wire "state" message body (everything
 * but the `type` key), tracking the per-connection baseline `lastSnapshotBySeat` needs for next
 * time. Shared between this file's own broadcastState() (an in-process match) and
 * net/wsWorkerTransport.js's relay (a worker-hosted one, T-029) — both need the IDENTICAL
 * quantize-then-full-or-delta decision per connection; only WHERE the raw projection comes from
 * differs between them.
 * @param {Object} rawProj - projectFor(state, seat)'s own output, not yet quantized
 * @param {Map<string, Object>} lastSnapshotBySeat - mutated: this seat's entry is set to the
 *   quantized snapshot this call just computed, for the NEXT call to delta against
 * @param {string} seat
 * @returns {{full:true, proj:Object}|{full:false, delta:Object}}
 */
export function buildStateMessage(rawProj, lastSnapshotBySeat, seat) {
  // Quantized (T-028c) BEFORE it's used for anything — both the full-send path and the stored
  // baseline for the NEXT delta must agree on the same rounding, or every tick would look
  // "changed" against its own differently-rounded predecessor.
  const curr = quantizeForWire(rawProj);
  const prev = lastSnapshotBySeat.get(seat);
  lastSnapshotBySeat.set(seat, curr);
  return prev ? { full: false, delta: computeDelta(prev, curr) } : { full: true, proj: curr };
}

/**
 * @param {import("http").Server} httpServer
 * @param {ReturnType<import("../server/matchLoop.js").createMatch>} match
 * @param {{allowedOrigins?: string[]}} [opts]
 * @returns {{matchId: string, broadcastState: () => void, close: () => void}}
 */
export function attachWsMatch(httpServer, match, opts = {}) {
  const { allowedOrigins, path } = opts;
  const matchId = randomUUID();   // T-029b — see this file's own header for why always-fresh here
  const bySeat = new Map();   // owner -> live connection, at most one per seat at a time
  const lastSnapshotBySeat = new Map();   // owner -> the last projectFor(...) output actually SENT on the current connection (T-028b)

  function welcomePayload(seat) {
    const { planetId, seed, sizeMult, resourceMult, swapAsym } = match.state;
    return JSON.stringify({ type: "welcome", seat, matchId, createGameState: { planetId, seed, sizeMult, resourceMult, swapAsym } });
  }

  function onUpgrade(req, socket, head) {
    const url = new URL(req.url, "http://localhost");
    if (path && url.pathname !== path) { socket.destroy(); return; }
    const seat = url.searchParams.get("seat");
    if (!seat || !match.state.owners.includes(seat)) { socket.destroy(); return; }

    acceptUpgrade(req, socket, head, { allowedOrigins }).then(result => {
      if (!result.ok) return;
      const conn = result.connection;
      bySeat.set(seat, conn);
      conn.send(welcomePayload(seat));

      conn.onmessage = (data, isBinary) => {
        if (isBinary) return;   // a client only ever sends a JSON command envelope, never binary
        let envelope;
        try { envelope = JSON.parse(data); } catch { return; }   // malformed JSON: nothing to admit, nothing to ack
        const admitted = admit(match, envelope, seat);
        // A SHAPE-VALID envelope's real outcome (applied or rejected by the codec) arrives later,
        // through emitAck below, once stepMatch actually processes it — never from this handler.
        // A shape-REJECTED envelope never reaches stepMatch at all, so emitAck will never fire for
        // it — if that rejection is left unanswered here, the client's own submitCommand() promise
        // (net/wsClientTransport.js) hangs forever waiting for a commandResult that was never
        // coming. Answer it now, correlated by whatever seq the envelope carries — every rejection
        // reason short of "not even an object" still leaves envelope.seq readable, and a
        // conforming client (net/commandEnvelope.js's own encode()) never sends anything that bad.
        if (!admitted.ok) {
          const seq = envelope && Number.isInteger(envelope.seq) ? envelope.seq : null;
          if (seq !== null) conn.send(JSON.stringify({ type: "commandResult", seq, result: { ok: false, code: admitted.code } }));
        }
      };
      conn.onclose = () => {
        if (bySeat.get(seat) === conn) bySeat.delete(seat);
        // Clear the baseline too — a RECONNECT (new socket, same seat) must get a fresh full
        // snapshot as its own first push, never a delta computed against a now-dead connection's
        // last state. Not conditioned on `bySeat.get(seat) === conn` the way the line above is:
        // there is no lobby/reconnect flow yet (T-033/T-036) for two connections to genuinely race
        // for the same seat, so the only way this fires late is a deliberate close-then-reconnect —
        // exactly the case this exists to handle.
        lastSnapshotBySeat.delete(seat);
      };
    });
  }

  httpServer.on("upgrade", onUpgrade);

  match.emitAck = rec => {
    const conn = bySeat.get(rec.owner);
    if (conn) conn.send(JSON.stringify({ type: "commandResult", seq: rec.seq, result: toCommandResult(rec.result) }));
  };

  return {
    matchId,
    /** Push a fresh per-seat projection to every currently-connected seat. Caller-driven, once per
     *  stepMatch tick in practice — this function has no timer or loop of its own. The first push
     *  on a connection is always full (T-028b: lastSnapshotBySeat has no entry for this seat yet);
     *  every one after is a delta against whatever was last actually sent on THIS connection. */
    broadcastState() {
      for (const [seat, conn] of bySeat) {
        conn.send(JSON.stringify({ type: "state", ...buildStateMessage(projectFor(match.state, seat), lastSnapshotBySeat, seat) }));
      }
    },
    /** Stop accepting new upgrades on this httpServer for this match and close every live
     *  connection. Idempotent — closing twice is a harmless no-op, same guarantee every other
     *  transport in this codebase gives. */
    close() {
      httpServer.off("upgrade", onUpgrade);
      for (const conn of bySeat.values()) conn.close();
      bySeat.clear();
      lastSnapshotBySeat.clear();
    },
  };
}
