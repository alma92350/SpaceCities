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

/* The alert vocabulary: which raw engine events matter enough to be worth interrupting a plan for,
   grouped into the handful of things an agent actually reacts to differently. This is a DIGEST of
   `events`, never a replacement — every raw event is still returned in full alongside it; the
   groups exist so a caller can branch on "am I under attack" without knowing that the engine spells
   that `attackHit` with the defender's id in `targetId`.

   under_attack is deliberately the only one that needs the caller's own identity to classify (a
   hit on MY entity is an emergency; a hit on the enemy's is my own attack landing), so it is
   resolved against the seat's owner at call time rather than baked into this table. */
const ALERT_GROUPS = {
  combat: ["attackHit", "entityKilled"],
  construction: ["buildingComplete", "unitSpawned", "researchComplete"],
  economy: ["nodeDepleted", "unitIdle", "productionBlocked", "rigDig", "recycled"],
  match: ["matchEnded", "eliminated", "wonderCharging", "rivalGateComplete", "deployBlocked", "neighbourHostile", "bombFused", "wreckMatured", "craterMatured"],
};

const GROUP_OF = Object.fromEntries(
  Object.entries(ALERT_GROUPS).flatMap(([group, types]) => types.map(t => [t, group])),
);

/**
 * The one-line "what just happened, and does it need me" summary over a batch of raw events —
 * counts per event type, which alert groups fired, and the two things that genuinely change what an
 * agent should do next: something of MINE is being shot at (with where), and something of mine just
 * finished. A watcher (no owner of its own) gets the counts and groups, with no "mine" to resolve.
 */
function digest(events, owner) {
  const by_type = {};
  const groups = new Set();
  const attacked = [];
  const completed = [];
  for (const ev of events) {
    by_type[ev.type] = (by_type[ev.type] || 0) + 1;
    const group = GROUP_OF[ev.type];
    if (group) groups.add(group);
    if (!owner) continue;
    if (ev.type === "attackHit" && ev.targetOwner === owner) attacked.push({ id: ev.targetId, x: ev.x, y: ev.y, attacker_id: ev.sourceId });
    if (ev.type === "entityKilled" && ev.owner === owner) attacked.push({ id: ev.id, x: ev.x, y: ev.y, killed: true, attacker_id: ev.killerId ?? null });
    if ((ev.type === "buildingComplete" || ev.type === "unitSpawned" || ev.type === "researchComplete") && (ev.owner === undefined || ev.owner === owner)) {
      completed.push({ type: ev.type, id: ev.id ?? null, entity_type: ev.entityType ?? ev.unitType ?? ev.buildingType ?? ev.tech ?? null });
    }
  }
  return {
    by_type,
    groups: [...groups].sort(),
    under_attack: attacked.length > 0,
    ...(attacked.length ? { attacked } : {}),
    ...(completed.length ? { completed } : {}),
  };
}

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
        `in a loop instead of polling get_situation/list_entities. Events that fired while NO call was in ` +
        `flight are buffered and delivered by the NEXT call immediately, so nothing is lost between polls. ` +
        `Every result also carries a \`summary\`: counts per event type, which alert groups fired ` +
        `(combat/construction/economy/match), \`under_attack\` with WHICH of your entities are being ` +
        `hit and where, and what of yours just finished — so you can branch on "am I being attacked" ` +
        `without parsing raw events. Narrow what wakes you with \`types\` or \`groups\`. ` +
        `When the match ENDS this returns immediately with a \`matchEnded\` event and ` +
        `\`summary.match_over\` — it never blocks on a finished match, and never filters that event ` +
        `out however you narrowed the rest. ` +
        `A timeout is reported as a normal result ` +
        `(timed_out:true, no events), never an error; just call it again. Optionally request a shorter ` +
        `timeout_ms for tighter polling — requests above ${MAX_TIMEOUT_MS}ms are capped.`,
      inputSchema: {
        type: "object",
        properties: {
          seat_handle: { type: "string", description: "A playing seat_handle, or a watch_handle to follow someone else's match." },
          timeout_ms: { type: "number", description: `Optional. Defaults to ${DEFAULT_TIMEOUT_MS}; capped at ${MAX_TIMEOUT_MS}.` },
          types: {
            type: "array", items: { type: "string" },
            description: "Optional. Only return (and only wake for) these event types — e.g. [\"attackHit\",\"entityKilled\"] to sleep through everything but a fight, or [\"buildingComplete\"] to wake exactly when construction finishes. Omit to receive everything.",
          },
          groups: {
            type: "array", items: { type: "string", enum: Object.keys(ALERT_GROUPS) },
            description: `Optional, coarser than 'types': ${Object.keys(ALERT_GROUPS).join(", ")}. Combined with 'types' as a union.`,
          },
        },
        required: ["seat_handle"],
      },
      handler: withSeat(lobby, async ({ seat, timeout_ms, types, groups }) => {
        const cache = getCache(seat.matchId);
        if (!cache) return rejection("match-not-live: this match hasn't started yet — every seat must be filled before events flow; poll list_matches, or wait and retry");
        const wanted = new Set([
          ...(Array.isArray(types) ? types : []),
          ...(Array.isArray(groups) ? groups.flatMap(g => ALERT_GROUPS[g] ?? []) : []),
        ]);
        const deadline = Date.now() + clampTimeout(timeout_ms);
        // Filtering has to happen around the WAIT, not merely on its result: a wait that resolves
        // carrying only events the caller asked to ignore must keep waiting out the rest of its
        // own budget, or `types` would turn a deliberate "wake me for a fight" into a busy loop
        // that returns an empty list every time anything else ticks.
        let tick = null, collected = [], timedOut = true;
        for (;;) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;
          const round = await cache.waitForEvent(seat.owner, remaining);
          tick = round.tick ?? tick;
          if (round.timedOut) break;
          // matchEnded is never filtered out, whatever the caller asked to be woken for: a decided
          // match produces nothing else ever again, so dropping it for not matching a `types`
          // filter would leave the loop below waiting out its budget on a match that is finished —
          // the exact hang this event exists to prevent.
          const keep = wanted.size ? round.events.filter(ev => wanted.has(ev.type) || ev.type === "matchEnded") : round.events;
          if (keep.length) { collected = keep; timedOut = false; break; }
        }
        const summary = digest(collected, seat.watching ? null : seat.owner);
        const ended = collected.find(ev => ev.type === "matchEnded") ?? null;
        if (ended) summary.match_over = { winner: ended.winner, win_reason: ended.winReason };
        const headline = ended
          ? `The match is over — ${ended.winner ? `${ended.winner} won` : "no winner"}${ended.winReason ? ` (${ended.winReason})` : ""}. Call get_match_report for the full outcome.`
          : timedOut
            ? "Nothing new yet."
            : `${collected.length} new event(s) at tick ${tick}${summary.under_attack ? " — YOU ARE UNDER ATTACK" : ""}${summary.completed ? `, ${summary.completed.length} thing(s) finished` : ""}.`;
        return {
          content: [{ type: "text", text: headline }],
          structuredContent: { tick, events: collected, timed_out: timedOut, summary },
        };
      }),
    },
  ];
}
