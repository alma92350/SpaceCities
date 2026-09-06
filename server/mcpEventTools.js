/* ============================================================
   T-054 (FR-17): wait_for_event — "An agent may block on wait_for_event to react to being
   attacked rather than polling." Thin tool wrapper over server/mcpObservationCache.js's own
   waitForEvent (T-054's own addition to that file) — this file adds no new mechanism of its own,
   only seat resolution (server/mcpSeatHandle.js's withSeat, same as every other tool file),
   multi-match routing (getCache(matchId), the same T-052/T-053 lesson applied from the first
   draft rather than rediscovered), and clamping the caller's requested timeout server-side.

   Bounded "well under the client tool-call timeout" (this task's own row): DEFAULT_TIMEOUT_MS is
   the wait when the caller doesn't specify one, MAX_TIMEOUT_MS is a hard cap no requested value
   can exceed — both comfortably under the shortest tool-call timeouts real MCP clients commonly
   use (~30s+), so a chain of wait_for_event calls can never itself be the reason a client times
   out. A caller MAY ask for something SHORTER than the default (tighter polling), just never
   longer than the cap.

   A timed-out wait is a normal, successful result (isError absent, timed_out:true, events:[]) —
   never a tool execution error — exactly this task's own row: "returning 'nothing yet' on expiry
   rather than erroring." An agent's own loop is expected to just call this again.
   ============================================================ */

"use strict";

import { withSeat, rejection } from "./mcpSeatHandle.js";

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_TIMEOUT_MS = 20000;

function clampTimeout(requested) {
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested < 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(requested, MAX_TIMEOUT_MS);
}

/**
 * @param {Object} lobby a createLobby() instance
 * @param {(matchId:string) => {waitForEvent:(owner:string,timeoutMs:number)=>Promise<Object>}|null} getCache
 *   looks up a LIVE match's own projection cache by id (tools/serve.js's own liveMatches) — the
 *   same function shape server/mcpObservationTools.js's own getCache already uses, since this is
 *   the identical per-match-worker cache T-052 built, just calling its second capability.
 */
export function createEventTools(lobby, getCache) {
  return [
    {
      name: "wait_for_event",
      title: "Wait for something new to happen",
      description:
        `Blocks until something new becomes visible to the calling seat (combat, a kill, a completed build, ` +
        `research finishing, and the like) or ${DEFAULT_TIMEOUT_MS}ms passes, whichever comes first — call this ` +
        `in a loop instead of polling get_situation/list_entities. A timeout is reported as a normal result ` +
        `(timed_out:true, no events), never an error; just call it again. Optionally request a shorter ` +
        `timeout_ms for tighter polling — requests above ${MAX_TIMEOUT_MS}ms are capped.`,
      inputSchema: {
        type: "object",
        properties: {
          seat_handle: { type: "string" },
          timeout_ms: { type: "number", description: `Optional. Defaults to ${DEFAULT_TIMEOUT_MS}; capped at ${MAX_TIMEOUT_MS}.` },
        },
        required: ["seat_handle"],
      },
      handler: withSeat(lobby, async ({ seat, timeout_ms }) => {
        const cache = getCache(seat.matchId);
        if (!cache) return rejection("match-not-live: this match hasn't started yet");
        const { tick, events, timedOut } = await cache.waitForEvent(seat.owner, clampTimeout(timeout_ms));
        return {
          content: [{ type: "text", text: timedOut ? "Nothing new yet." : `${events.length} new event(s) at tick ${tick}.` }],
          structuredContent: { tick, events, timed_out: timedOut },
        };
      }),
    },
  ];
}
