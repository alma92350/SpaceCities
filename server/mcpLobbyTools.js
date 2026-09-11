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

   Bugfix: join_match's optional second constructor argument, `onSeatsFilled(match) =>
   Promise<boolean>`, lets tools/serve.js — the only real caller — hook a successful join into its
   own "does every seat now have someone, and if so start it" decision (mirroring the HTTP join
   endpoint's own long-standing `seatsFilled(match) ? await startAndSpawnIfReady(match) : false`),
   without this file ever needing to know what "started" even means. Before this, join_match never
   started anything on its own — tolerable when a human host always held seat 0 and could click
   Start, a genuine dead end once a match can exist with NO seat held by anyone able to click
   anything (tools/serve.js's own hostJoins:false) — two agents' own join_match calls become the
   ONLY thing that will ever fill those seats, so they have to be able to start it too. Optional and
   defaulted to a no-op so every existing caller (this file's own tests included) that predates
   this parameter keeps working unchanged.
   ============================================================ */

"use strict";

import { publicMatch, isJoinableKind } from "./lobby.js";
import { mintSeatHandle, mintWatchHandle, withSeat, rejection, requirePlayingSeat } from "./mcpSeatHandle.js";
import { AGENT_APM } from "../net/agentApm.js";

// The vocabulary create_match speaks, and what each word means to server/lobby.js's own seat kinds.
// Three words rather than two because "a human will sit here" and "an MCP client will sit here" are
// genuinely different INTENTIONS even though both resolve to a seat waiting for a joiner — a
// browsing human should be able to see which is which before taking a seat someone is already on
// their way to.
const CONTROLLER_KINDS = { ai: "ai", human: "open", agent: "agent" };

// One seat's own controller request inside create_match's `seats` array.
const SEAT_SCHEMA = {
  type: "object",
  properties: {
    controller: {
      type: "string", enum: ["ai", "human", "agent"],
      description: "ai = one of the game's own built-in scripted opponents, filled at start and never joinable; human = a seat a person will join from the browser; agent = a seat an MCP client will join with join_match. Both human and agent seats must actually be claimed before the match starts.",
    },
    ai_strategy: { type: "string", description: "Only for controller:'ai' — which built-in strategy it plays (e.g. default, aggressive, economic, matching). Unknown names fall back to the default." },
    difficulty: { type: "string", description: "Only for controller:'ai' — easy, medium or hard. Unknown names fall back to medium." },
  },
  required: ["controller"],
};

function seatConfigFrom(seats) {
  const list = Array.isArray(seats) && seats.length ? seats : [{ controller: "agent" }, { controller: "ai" }];
  if (list.length !== 2) return { error: `bad-seats: this game seats exactly 2 players, got ${list.length}` };
  const seatKinds = [];
  const seatAi = [];
  for (const entry of list) {
    const kind = CONTROLLER_KINDS[entry?.controller];
    if (!kind) return { error: `bad-controller: ${JSON.stringify(entry?.controller)} — use ai, human or agent` };
    seatKinds.push(kind);
    seatAi.push(kind === "ai"
      ? { ...(entry.ai_strategy ? { strategy: entry.ai_strategy } : {}), ...(entry.difficulty ? { difficulty: entry.difficulty } : {}) }
      : null);
  }
  return { seatKinds, seatAi };
}

/**
 * @param {Object} lobby a createLobby() instance (server/lobby.js)
 * @param {(match: Object) => Promise<boolean>} [onSeatsFilled] called after every successful join
 *   AND after create_match
 *   (whether or not it happened to be the LAST open seat) — see this file's own header for why the
 *   "is the match actually ready to start" decision lives in the caller, not here.
 */
export function createLobbyTools(lobby, onSeatsFilled) {
  const maybeStart = async match => (onSeatsFilled ? await onSeatsFilled(match) : false);

  return [
    {
      name: "create_match",
      title: "Create a match",
      description:
        "Creates a new match and says, seat by seat, WHO plays it: one of the game's own built-in " +
        "AI opponents (controller:'ai', optionally naming its strategy and difficulty), a human who " +
        "will join from the browser (controller:'human'), or an MCP client that will claim the seat " +
        "with join_match (controller:'agent'). Seat 0 and seat 1 are both fully configurable — an " +
        "agent-vs-AI, agent-vs-agent, agent-vs-human or AI-vs-AI match are all just different " +
        "`seats` arrays. Pass join_as to claim one of the seats in the same call (the usual case: " +
        "create the match you are about to play). The match starts automatically the moment every " +
        "seat that needs a joiner has one — check the returned `started`.",
      inputSchema: {
        type: "object",
        properties: {
          seats: { type: "array", items: SEAT_SCHEMA, minItems: 2, maxItems: 2, description: "Exactly 2 entries, seat 0 first. Defaults to [{controller:'agent'},{controller:'ai'}] — you against the built-in AI." },
          join_as: { type: "integer", description: "Claim this seat index in the same call and get a seat_handle back. Must be a human/agent seat." },
          client_id: { type: "string", description: "Your own stable id, used with join_as — see join_match's own client_id." },
          planet_id: { type: "string", description: "Which world to play on (default: ferros)." },
          size_mult: { type: "number", description: "Map size multiplier." },
          resource_mult: { type: "number", description: "Resource richness multiplier." },
          match_time_limit: { type: "number", description: "Match length in seconds; omit for no limit." },
          spectators_enabled: { type: "boolean", description: "Whether watch_match may observe this match (default true)." },
        },
        additionalProperties: false,
      },
      handler: async ({ seats, join_as, client_id, planet_id, size_mult, resource_mult, match_time_limit, spectators_enabled }) => {
        const seatConfig = seatConfigFrom(seats);
        if (seatConfig.error) return rejection(seatConfig.error);
        let match;
        try {
          match = lobby.createMatch({
            planetId: typeof planet_id === "string" && planet_id ? planet_id : "ferros",
            ...(Number.isFinite(size_mult) ? { sizeMult: size_mult } : {}),
            ...(Number.isFinite(resource_mult) ? { resourceMult: resource_mult } : {}),
            ...(Number.isFinite(match_time_limit) ? { matchTimeLimit: match_time_limit } : {}),
            ...(typeof spectators_enabled === "boolean" ? { spectatorsEnabled: spectators_enabled } : {}),
            seatKinds: seatConfig.seatKinds, seatAi: seatConfig.seatAi,
          });
        } catch (e) { return rejection(`bad-config: ${e.message}`); }
        let seat_handle, seat_index, owner;
        if (join_as !== undefined) {
          const joined = lobby.joinMatch(match.id, join_as, client_id ?? null);
          if (!joined.ok) return rejection(joined.code);
          seat_handle = mintSeatHandle(match.id, join_as, joined.token);
          seat_index = join_as;
          owner = joined.owner;
        }
        // An all-AI or "ai + the seat I just took" match needs nothing further to be ready, so the
        // same auto-start rule every join already goes through runs here too — otherwise a caller
        // who created exactly the match they wanted would still be waiting for a start step that
        // nothing was ever going to perform (there may be no human host in this match at all).
        const started = await maybeStart(lobby.getMatch(match.id));
        return {
          content: [{ type: "text", text: `Created match ${match.id} (${seatConfig.seatKinds.join(" vs ")}).${seat_handle ? ` You hold seat ${seat_index} (${owner}).` : ""}${started ? " It has started." : " Waiting for the remaining seat(s) to be claimed."}` }],
          structuredContent: {
            match_id: match.id, match: publicMatch(lobby.getMatch(match.id)), started,
            ...(seat_handle ? { seat_handle, seat_index, owner } : {}),
          },
        };
      },
    },
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
      description: "Joins an open seat in the named match, returning a seat_handle — pass this SAME string as the seat_handle argument to every later tool call made as this seat (leave_match, and every observation/action tool once they exist). If seat_index is omitted, the first still-open seat is claimed automatically. If this join fills every seat in the match, it starts automatically — check the returned `started` flag rather than assuming a separate start step is still needed.",
      inputSchema: {
        type: "object",
        properties: {
          match_id: { type: "string", description: "A match id from list_matches" },
          seat_index: { type: "integer", description: "Which seat to claim; omit to auto-pick the first open one" },
          client_id: {
            type: "string",
            description:
              "YOUR OWN stable id — mint one random string per agent and reuse it for the whole match. " +
              "Passing it makes this call idempotent: calling join_match again with the same client_id " +
              "and match_id hands back the SAME seat and a working seat_handle, even after the match has " +
              "started. That is the supported way to get back in after losing your handle (a context " +
              "compaction, a restart). Treat it as a secret: whoever knows it can reclaim your seat.",
          },
        },
        required: ["match_id"],
      },
      handler: async ({ match_id, seat_index, client_id }) => {
        // REJOIN FIRST, always — before any "is there an open seat" reasoning. A client that
        // already holds a seat here is not joining, it is coming back, and coming back has to
        // work on a STARTED match (where joinMatch itself correctly refuses everyone) or the
        // whole recovery path is useless exactly when it is needed.
        if (client_id) {
          const mine = lobby.findSeatForClient(match_id, client_id);
          if (mine.ok) {
            return {
              content: [{ type: "text", text: `Rejoined match ${match_id} as seat ${mine.seatIndex} (${mine.owner}) — you already held this seat. If you handed it to the AI while you were away, call set_seat_controller with controller:'self' to take it back.` }],
              structuredContent: {
                seat_handle: mintSeatHandle(match_id, mine.seatIndex, mine.token),
                match_id, seat_index: mine.seatIndex, owner: mine.owner,
                started: lobby.getMatch(match_id)?.status !== "open", rejoined: true,
              },
            };
          }
        }
        let seatIndex = seat_index;
        if (seatIndex === undefined) {
          const match = lobby.getMatch(match_id);
          if (!match) return rejection("no-such-match");
          // Report the REAL reason first. A started match usually has no unclaimed seat left
          // either, so the auto-pick below would answer "no-open-seat" — true but misleading, and
          // it points a caller at waiting for a seat to free up rather than at the two things that
          // actually apply (rejoin with your client_id, or watch_match).
          if (match.status !== "open") return rejection("already-started: to get back into a match you were playing, pass your client_id; to observe it, use watch_match");
          seatIndex = match.seats.findIndex(s => isJoinableKind(s.kind) && !s.owner);
          if (seatIndex === -1) return rejection("no-open-seat");
        }
        const joined = lobby.joinMatch(match_id, seatIndex, client_id ?? null);
        if (!joined.ok) return rejection(joined.code);
        const seat_handle = mintSeatHandle(match_id, seatIndex, joined.token);
        const started = await maybeStart(lobby.getMatch(match_id));
        return {
          content: [{ type: "text", text: `Joined match ${match_id} as seat ${seatIndex} (${joined.owner}).${started ? " Every seat is now filled — the match has started." : " Keep this seat_handle for every later call."}` }],
          structuredContent: { seat_handle, match_id, seat_index: seatIndex, owner: joined.owner, started, rejoined: false },
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
        const watching = requirePlayingSeat(seat);
        if (watching) return watching;
        const left = lobby.leaveSeat(seat.matchId, seat.seatIndex, seat.token);
        if (!left.ok) return rejection(left.code);
        return { content: [{ type: "text", text: `Left match ${seat.matchId}, seat ${seat.seatIndex}.` }] };
      }),
    },
    {
      name: "watch_match",
      title: "Watch a match without playing",
      description:
        "Returns a WATCH handle for a match — the same opaque string every observation tool takes as " +
        "seat_handle, but naming no seat: it sees the whole match unfogged (both sides' units, both " +
        "economies) and can never issue a command, surrender, or leave. Use it to spectate a match " +
        "between two other players, or to follow a match you set up but are not playing. Works on a " +
        "live match; fails if the match's host disabled spectators. Watching is free — it costs no " +
        "seat, so it never stops a real player from joining.",
      inputSchema: {
        type: "object",
        properties: { match_id: { type: "string", description: "A match id from list_matches or create_match" } },
        required: ["match_id"],
      },
      handler: ({ match_id }) => {
        const match = lobby.getMatch(match_id);
        if (!match) return rejection("no-such-match");
        if (match.config.spectatorsEnabled === false) return rejection("spectators-disabled: this match's host turned spectating off");
        return {
          content: [{ type: "text", text: `Watching match ${match_id} (${match.status}). Pass watch_handle as seat_handle to get_situation, list_entities, get_map_overview and wait_for_event.` }],
          structuredContent: { watch_handle: mintWatchHandle(match_id), match_id, status: match.status, match: publicMatch(match) },
        };
      },
    },
    {
      name: "find_my_seats",
      title: "Find the seats you already hold",
      description:
        "Every match your client_id currently holds a seat in, each with a working seat_handle — the " +
        "recovery call for an agent that lost its handles but still knows its own client_id (after a " +
        "context compaction, a restart, or a crash). Returns an empty list if you hold none.",
      inputSchema: {
        type: "object",
        properties: { client_id: { type: "string", description: "The same client_id you passed to join_match or create_match." } },
        required: ["client_id"],
      },
      handler: ({ client_id }) => {
        const seats = lobby.listSeatsForClient(client_id).map(s => ({
          match_id: s.matchId, status: s.status, seat_index: s.seatIndex, owner: s.owner,
          seat_handle: mintSeatHandle(s.matchId, s.seatIndex, s.token),
        }));
        return {
          content: [{ type: "text", text: seats.length ? `You hold ${seats.length} seat(s).` : "You hold no seats right now." }],
          structuredContent: { seats },
        };
      },
    },
  ];
}
