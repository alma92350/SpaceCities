/* ============================================================
   T-049a (FR-13): the MCP spec's own "Stateful Tools" pattern
   (modelcontextprotocol.io/specification/2026-07-28/server/tools#stateful-tools), applied to
   this game's EXISTING per-seat bearer token rather than a new credential concept — wrap, don't
   rewrite (ADR-0006 D1). Protocol revision 2026-07-28 has no session at all (net/mcp.js's own
   header), so an agent that wants to keep acting as the SAME seat across many tool calls needs
   an explicit handle to pass on every one — this file is that handle's mint/resolve pair,
   built directly on server/lobby.js's own joinMatch/reclaimSeat (the exact same per-seat token
   net/wsWorkerTransport.js's authorizeSeat opt already checks for the WebSocket path), not a
   parallel credential system.

   A handle is {matchId, seatIndex, token} opaque-encoded into ONE string — never presented to
   an agent as three separate fields to track, and never meant to be parsed by the caller: the
   spec's own guidance is explicit that "opaque identifiers... do not [invite parsing or
   guessing]." Resolving one replays the EXACT SAME check reclaimSeat already performs, so a
   handle is exactly as forgeable as the underlying token already was (not at all, absent the
   real per-seat secret) and exactly as long-lived (a seat's token is never rotated once minted,
   the same lifetime every existing reconnect/reclaim path already assumes).
   ============================================================ */

"use strict";

/**
 * @param {string} matchId @param {number} seatIndex @param {string} token
 * @returns {string} an opaque handle string — see this file's own header for why base64/JSON
 *   rather than a bare token, and why that's still "opaque" in the spec's own sense.
 */
export function mintSeatHandle(matchId, seatIndex, token) {
  return Buffer.from(JSON.stringify({ matchId, seatIndex, token }), "utf8").toString("base64url");
}

/**
 * Resolves a handle back to the real, CURRENTLY-VALID seat it names — every check
 * server/lobby.js's own reclaimSeat already performs, so a stale, forged, or malformed handle
 * is rejected exactly like a bad token on the WebSocket reconnect path already is. Never
 * throws: a malformed handle (bad base64, non-JSON, wrong shape) is just another rejection
 * reason, not a crash a caller has to guard against separately.
 *
 * T-051: the resolved shape carries `token` too (not just `owner`), so a tool that needs to make
 * a FURTHER authenticated lobby call on this same seat (leave_match's own `leaveSeat`) can pass
 * it straight through — that mutation re-validates the token itself, the same self-authenticating
 * shape `reclaimSeat` already has, rather than trusting that whatever called it must already have
 * gone through `withSeat`. A tool handler that has no use for the raw token just ignores it; it's
 * the seat's OWN already-proven-valid credential, not a new thing exposed to it.
 * @param {Object} lobby a createLobby() instance (server/lobby.js)
 * @param {string} handle
 * @returns {{ok:true, matchId:string, seatIndex:number, owner:string, token:string}|{ok:false, code:string}}
 */
export function resolveSeatHandle(lobby, handle) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(String(handle), "base64url").toString("utf8"));
  } catch {
    return { ok: false, code: "bad-handle" };
  }
  const { matchId, seatIndex, token } = parsed || {};
  if (typeof matchId !== "string" || !Number.isInteger(seatIndex) || typeof token !== "string") {
    return { ok: false, code: "bad-handle" };
  }
  const claim = lobby.reclaimSeat(matchId, seatIndex, token);
  if (!claim.ok) return { ok: false, code: claim.code };
  return { ok: true, matchId, seatIndex, owner: claim.owner, token };
}

/**
 * Wraps a seat-scoped tool handler so every registered tool doesn't hand-roll the same
 * "resolve seat_handle, bail out as a tool execution error if it doesn't check out" boilerplate
 * — the pattern T-051/T-052/T-053's own real game tools all need. An invalid handle is a TOOL
 * EXECUTION error (isError:true, HTTP 200), never a JSON-RPC protocol error: the spec's own
 * Error Handling section reserves protocol errors for the request shape itself being wrong
 * (unknown tool, malformed params), not for an argument value failing a business check — the
 * same distinction net/mcp.js's own tools/call dispatch already draws for a handler's own
 * isError result. The wrapped handler is called with `seat` (resolveSeatHandle's own success
 * shape) merged alongside every other argument, `seat_handle` itself left in place rather than
 * stripped — a handler that genuinely has no use for the raw string just ignores it.
 * @param {Object} lobby
 * @param {(args:Object & {seat:{matchId:string,seatIndex:number,owner:string}}) => (Object|Promise<Object>)} handler
 */
export function withSeat(lobby, handler) {
  return async (args = {}) => {
    const resolved = resolveSeatHandle(lobby, args.seat_handle);
    if (!resolved.ok) {
      return { content: [{ type: "text", text: `Invalid or expired seat handle (${resolved.code}). Call join_match again to get a new one.` }], isError: true };
    }
    return handler({ ...args, seat: resolved });
  };
}

// T-051/T-052/T-053: the one shape every tool's own business-rule rejection uses — a TOOL
// EXECUTION error (isError:true, HTTP 200, never a JSON-RPC protocol error), carrying a short
// machine-readable code in the text so a model can read e.g. "seat-taken" or "no-such-match" and
// decide what to try next, rather than a generic failure it can only retry blindly. Shared here
// (not duplicated per tool file) the moment a SECOND file needed the identical shape.
export function rejection(code) {
  return { content: [{ type: "text", text: `Could not complete: ${code}` }], isError: true };
}
