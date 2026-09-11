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
  economy: ["nodeDepleted", "unitIdle", "workerRetargeted", "planExhausted", "productionBlocked", "rigDig", "recycled"],
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
/**
 * @param {Object} lobby
 * @param {Function} getCache
 * @param {(args: Object) => Promise<Object>} [getSituationHandler] the registered get_situation
 *   tool's own handler, reused verbatim by take_turn below rather than a second, drifting copy of
 *   the same summary. Omitted in tests that only exercise wait_for_event; take_turn is simply not
 *   registered then.
 */
export function createEventTools(lobby, getCache, getSituationHandler = null) {
  const tools = [
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
          wake_on: {
            type: "object",
            description:
              "Optional resource threshold to wake for, e.g. {ore:175}. Resolves as soon as you hold at least that " +
              "much of EVERY named commodity, even if no event fires — the way to sleep until you can afford " +
              "something instead of re-asking and being told 'cannot-afford' four times. Combine with nothing else " +
              "and it is a pure 'wake me when I am rich enough'; combine it with types/groups and whichever happens " +
              "first wins. (For 'keep building these as the ore arrives', prefer set_production_plan — it spends " +
              "without needing you awake at all.)",
            additionalProperties: { type: "number" },
          },
        },
        required: ["seat_handle"],
      },
      handler: withSeat(lobby, async ({ seat, timeout_ms, types, groups, wake_on }) => {
        const cache = getCache(seat.matchId);
        if (!cache) return rejection("match-not-live: this match hasn't started yet — every seat must be filled before events flow; poll list_matches, or wait and retry");
        const wanted = new Set([
          ...(Array.isArray(types) ? types : []),
          ...(Array.isArray(groups) ? groups.flatMap(g => ALERT_GROUPS[g] ?? []) : []),
        ]);
        const deadline = Date.now() + clampTimeout(timeout_ms);
        // A resource threshold is not an event — nothing in the engine fires when a treasury
        // crosses a number — so it is checked against the latest projection on every round of the
        // wait below, including before the first one (a threshold already met returns at once).
        const threshold = wake_on && typeof wake_on === "object" ? Object.entries(wake_on).filter(([, v]) => Number.isFinite(v)) : [];
        const resourcesNow = () => cache.latestProjFor(seat.owner)?.players?.[seat.owner]?.resources ?? null;
        const thresholdMet = () => {
          if (!threshold.length) return false;
          const have = resourcesNow();
          return !!have && threshold.every(([com, amount]) => (have[com] ?? 0) >= amount);
        };
        if (thresholdMet()) {
          const have = resourcesNow();
          return {
            content: [{ type: "text", text: `Resource threshold met: ${threshold.map(([c, v]) => `${c} ${Math.floor(have[c] ?? 0)}/${v}`).join(", ")}.` }],
            structuredContent: { tick: cache.latestProjFor(seat.owner)?.tick ?? null, events: [], timed_out: false,
                                 resources_reached: true, resources: have, summary: digest([], seat.watching ? null : seat.owner) },
          };
        }
        // Filtering has to happen around the WAIT, not merely on its result: a wait that resolves
        // carrying only events the caller asked to ignore must keep waiting out the rest of its
        // own budget, or `types` would turn a deliberate "wake me for a fight" into a busy loop
        // that returns an empty list every time anything else ticks.
        let tick = null, collected = [], timedOut = true;
        for (;;) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;
          // With a threshold pending, no single round may sleep the whole budget: the wait has to
          // come up for air often enough to notice a number it will never be told about.
          const round = await cache.waitForEvent(seat.owner, threshold.length ? Math.min(remaining, 500) : remaining);
          if (thresholdMet()) {
            const have = resourcesNow();
            return {
              content: [{ type: "text", text: `Resource threshold met: ${threshold.map(([c, v]) => `${c} ${Math.floor(have[c] ?? 0)}/${v}`).join(", ")}.` }],
              structuredContent: { tick: round.tick ?? null, events: round.events ?? [], timed_out: false,
                                   resources_reached: true, resources: have, summary: digest(round.events ?? [], seat.watching ? null : seat.owner) },
            };
          }
          tick = round.tick ?? tick;
          if (round.timedOut && !threshold.length) break;
          // matchEnded is never filtered out, whatever the caller asked to be woken for: a decided
          // match produces nothing else ever again, so dropping it for not matching a `types`
          // filter would leave the loop below waiting out its budget on a match that is finished —
          // the exact hang this event exists to prevent.
          // A wait asked ONLY for a resource threshold is not ended by an unrelated event: the
          // caller said what it was waiting for, and "a worker finished walking" is not it. Where
          // both were asked for, whichever lands first wins — the matchEnded exception below
          // outranks both, since nothing else will ever happen after it.
          const eventsWanted = wanted.size > 0 || threshold.length === 0;
          const keep = wanted.size ? round.events.filter(ev => wanted.has(ev.type) || ev.type === "matchEnded")
                                   : (eventsWanted ? round.events : round.events.filter(ev => ev.type === "matchEnded"));
          if (keep.length) { collected = keep; timedOut = false; break; }
          // A round that resolved immediately with nothing this caller wanted (a filtered-out
          // event, a threshold not yet crossed) must yield to the event loop before going again.
          // Without this, a busy match filtered down to "wake me for a fight" spins on microtasks
          // and starves the timers — including the very tick that would deliver what it is waiting
          // for, which is how a threshold wait could sit out its whole budget on a match that had
          // already crossed it.
          if (!round.timedOut) await new Promise(r => setTimeout(r, 50));
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

  // ===== take_turn (agent-observability) =====
  // One call where an agent's loop used to spend three. Every wake previously cost a
  // wait_for_event, then a get_situation, then a list_entities — three round trips and three full
  // re-serialisations of the same world, per game-second, for the whole match. That is not merely
  // slow: a recorded match was abandoned mid-game with the agent explicitly out of context budget,
  // having spent most of it re-reading a board that had barely changed. This composes the two
  // halves that are always wanted together (what happened, and where that leaves me) and returns
  // them as one result, with no new mechanism underneath — it calls the same two handlers.
  if (getSituationHandler) {
    tools.push({
      name: "take_turn",
      title: "Wait for something to happen, then read the situation",
      description:
        "The whole agent loop in one call: blocks like wait_for_event (same timeout_ms/types/groups/wake_on " +
        "arguments), then returns the resulting situation — tick, your resources and supply, unit and building " +
        "counts, WHICH of your units are idle, your measured income and any exposed gatherers — alongside the events " +
        "that woke it. Prefer this over calling wait_for_event and get_situation separately every round: it is one " +
        "round trip instead of two, and it returns the state AFTER the events rather than before them.",
      inputSchema: {
        type: "object",
        properties: {
          seat_handle: { type: "string" },
          timeout_ms: { type: "number", description: `Optional. Defaults to ${DEFAULT_TIMEOUT_MS}; capped at ${MAX_TIMEOUT_MS}.` },
          types: { type: "array", items: { type: "string" }, description: "Optional. Only wake for these event types." },
          groups: { type: "array", items: { type: "string", enum: Object.keys(ALERT_GROUPS) }, description: `Optional, coarser than 'types': ${Object.keys(ALERT_GROUPS).join(", ")}.` },
          wake_on: { type: "object", additionalProperties: { type: "number" }, description: "Optional resource threshold, e.g. {ore:175} — see wait_for_event." },
        },
        required: ["seat_handle"],
      },
      // Deliberately NOT wrapped in withSeat: both handlers it calls already resolve the handle
      // themselves, and wrapping would resolve it (and record presence) twice per turn.
      handler: async args => {
        const waited = await tools[0].handler(args);
        // A failed wait (bad handle, match not live) is the answer — asking for a situation on top
        // of it would only produce a second copy of the same error.
        if (waited.isError) return waited;
        const situation = await getSituationHandler({ seat_handle: args.seat_handle });
        if (situation.isError) return situation;
        const events = waited.structuredContent ?? {};
        const state = situation.structuredContent ?? {};
        return {
          content: [{ type: "text", text: `${waited.content?.[0]?.text ?? ""} ${situation.content?.[0]?.text ?? ""}`.trim() }],
          structuredContent: { ...state, events: events.events ?? [], summary: events.summary ?? null,
                               timed_out: !!events.timed_out, ...(events.resources_reached ? { resources_reached: true } : {}) },
        };
      },
    });
  }

  return tools;
}
