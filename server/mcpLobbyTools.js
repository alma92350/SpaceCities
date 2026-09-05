/* ============================================================
   T-051 (FR-13): the first REAL MCP tools — list_matches, join_match, leave_match — the ones
   T-049a's own tests deliberately deferred (they minted seat handles directly via
   lobby.joinMatch() as a correct stand-in, not because a real tool was out of reach). This is
   that real tool: createLobbyTools(lobby) returns a `tools` array ready to hand straight to
   net/mcp.js's createMcpServer, the same shape tools/serve.js's own `mcpServer` construction
   already expects.

   Deliberately thin over the EXISTING lobby model, never a second implementation of it: every
   tool here calls straight into server/lobby.js (createMatch/listOpenMatches/joinMatch/
   leaveSeat) and reuses tools/serve.js's own publicMatch() redaction — an agent sees exactly
   the same safe subset of a match record a stranger browsing GET /api/matches already does,
   never a seat's real token or the live createGameStateOpts seed.

   join_match hands back a seat_handle (server/mcpSeatHandle.js's mintSeatHandle), never the raw
   {matchId, seatIndex, token} triple — the whole point of the "Stateful Tools" pattern T-049a
   built is that an agent tracks ONE opaque string across every later call, not three separate
   fields it could transcribe wrong. leave_match is wrapped in withSeat so an invalid or already-
   spent handle is rejected the exact same way every future seat-scoped tool (T-052/T-053) will
   reject one.

   T-056 (§6.3, ADR-0007): list_matches also reports agent_apm_cap — the published, fixed actions-
   -per-minute ceiling EVERY issue_command call is subject to (net/agentApm.js), server-wide, so
   an agent (or a human deciding whether to join a match an agent might occupy) can see the rule
   up front rather than discovering it only after being rate-limited. A single top-level field,
   not repeated per match: it's a server policy, not a per-match setting. Lives here rather than
   inside server/lobby.js's own publicMatch() — that file is a deliberate zero-import leaf (its
   own header), and importing net/agentApm.js into it would break that property for a field that
   isn't really part of a match record at all.
   ============================================================ */

"use strict";

import { publicMatch } from "./lobby.js";
import { mintSeatHandle, withSeat, rejection } from "./mcpSeatHandle.js";
import { AGENT_APM } from "../net/agentApm.js";

/** @param {Object} lobby a createLobby() instance (server/lobby.js) */
export function createLobbyTools(lobby) {
  return [
    {
      name: "list_matches",
      title: "List open matches",
      description: "Lists every match currently open for a seat to join — world, size, resource level, match length, which seats are taken, and whether spectators are allowed. Never includes a seat's real token or the match's random seed. Also reports agent_apm_cap, the published actions-per-minute ceiling issue_command is subject to.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: () => {
        const matches = lobby.listOpenMatches().map(publicMatch);
        return {
          content: [{ type: "text", text: matches.length ? `${matches.length} open match(es).` : "No open matches right now." }],
          structuredContent: { matches, agent_apm_cap: AGENT_APM },
        };
      },
    },
    {
      name: "join_match",
      title: "Join a match",
      description: "Joins an open seat in the named match, returning a seat_handle — pass this SAME string as the seat_handle argument to every later tool call made as this seat (leave_match, and every observation/action tool once they exist). If seat_index is omitted, the first still-open seat is claimed automatically.",
      inputSchema: {
        type: "object",
        properties: {
          match_id: { type: "string", description: "A match id from list_matches" },
          seat_index: { type: "integer", description: "Which seat to claim; omit to auto-pick the first open one" },
        },
        required: ["match_id"],
      },
      handler: ({ match_id, seat_index }) => {
        let seatIndex = seat_index;
        if (seatIndex === undefined) {
          const match = lobby.getMatch(match_id);
          if (!match) return rejection("no-such-match");
          seatIndex = match.seats.findIndex(s => s.kind === "open" && !s.owner);
          if (seatIndex === -1) return rejection("no-open-seat");
        }
        const joined = lobby.joinMatch(match_id, seatIndex);
        if (!joined.ok) return rejection(joined.code);
        const seat_handle = mintSeatHandle(match_id, seatIndex, joined.token);
        return {
          content: [{ type: "text", text: `Joined match ${match_id} as seat ${seatIndex} (${joined.owner}). Keep this seat_handle for every later call.` }],
          structuredContent: { seat_handle, match_id, seat_index: seatIndex, owner: joined.owner },
        };
      },
    },
    {
      name: "leave_match",
      title: "Leave a match before it starts",
      description: "Voluntarily gives up a seat joined via join_match, freeing it for someone else — only while the match is still open. Once a match has started, use the surrender tool instead (not this one).",
      inputSchema: {
        type: "object",
        properties: { seat_handle: { type: "string", description: "The seat_handle join_match returned" } },
        required: ["seat_handle"],
      },
      handler: withSeat(lobby, ({ seat }) => {
        const left = lobby.leaveSeat(seat.matchId, seat.seatIndex, seat.token);
        if (!left.ok) return rejection(left.code);
        return { content: [{ type: "text", text: `Left match ${seat.matchId}, seat ${seat.seatIndex}.` }] };
      }),
    },
  ];
}
