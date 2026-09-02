/* ============================================================
   net/wsServerTransport.js — the SERVER half of T-026's WebSocket transport. Given an HTTP
   server and an already-built server/matchLoop.js match (the same object T-023's own stepMatch
   drives — mirroring net/loopback.js's own precedent of wrapping an ALREADY-CONSTRUCTED
   server/session.js session rather than building one itself), attaches WebSocket handling for
   that match's seats.

   WIRE PROTOCOL, both directions JSON text frames over net/ws.js:
     server -> client
       {type:"welcome", seat, createGameState:{planetId,seed,sizeMult,resourceMult,swapAsym}}
         sent once, immediately on connect — everything a client needs to regenerate this match's
         map locally (ADR-0009: the map is deterministic from these fields, so it's never sent).
       {type:"state", proj: <engine/projection.js's projectFor(state, seat) output>}
         sent on broadcastState() — the caller decides the cadence (every stepMatch tick, in
         practice), matching how net/loopback.js's own tick() is caller-driven, never self-timed.
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

import { acceptUpgrade } from "./ws.js";
import { admit } from "../server/matchLoop.js";
import { projectFor } from "../engine/projection.js";

// server/matchLoop.js's own log records deliberately store a SIMPLER shape than net/transport.js's
// documented CommandResult ({ok, code?, result?}): `null` (or a success payload like {buildingId})
// for an applied command, `{rejected: code}` for one the codec declined — matchLoop.js's own
// header explains why (it's the direct, minimal thing stepMatch needs to log, nothing more). This
// reconstructs the CommandResult shape every Transport implementation owes its own caller,
// specifically at THIS boundary — the one place a match's internal log record ever has to speak
// the client-facing wire contract.
function toCommandResult(recResult) {
  if (recResult && typeof recResult === "object" && "rejected" in recResult) {
    return { ok: false, code: recResult.rejected };
  }
  return { ok: true, result: recResult ?? null };
}

/**
 * @param {import("http").Server} httpServer
 * @param {ReturnType<import("../server/matchLoop.js").createMatch>} match
 * @param {{allowedOrigins?: string[]}} [opts]
 * @returns {{broadcastState: () => void, close: () => void}}
 */
export function attachWsMatch(httpServer, match, opts = {}) {
  const { allowedOrigins, path } = opts;
  const bySeat = new Map();   // owner -> live connection, at most one per seat at a time

  function welcomePayload(seat) {
    const { planetId, seed, sizeMult, resourceMult, swapAsym } = match.state;
    return JSON.stringify({ type: "welcome", seat, createGameState: { planetId, seed, sizeMult, resourceMult, swapAsym } });
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
      conn.onclose = () => { if (bySeat.get(seat) === conn) bySeat.delete(seat); };
    });
  }

  httpServer.on("upgrade", onUpgrade);

  match.emitAck = rec => {
    const conn = bySeat.get(rec.owner);
    if (conn) conn.send(JSON.stringify({ type: "commandResult", seq: rec.seq, result: toCommandResult(rec.result) }));
  };

  return {
    /** Push a fresh per-seat projection to every currently-connected seat. Caller-driven, once per
     *  stepMatch tick in practice — this function has no timer or loop of its own. */
    broadcastState() {
      for (const [seat, conn] of bySeat) conn.send(JSON.stringify({ type: "state", proj: projectFor(match.state, seat) }));
    },
    /** Stop accepting new upgrades on this httpServer for this match and close every live
     *  connection. Idempotent — closing twice is a harmless no-op, same guarantee every other
     *  transport in this codebase gives. */
    close() {
      httpServer.off("upgrade", onUpgrade);
      for (const conn of bySeat.values()) conn.close();
      bySeat.clear();
    },
  };
}
