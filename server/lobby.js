/* ============================================================
   server/lobby.js — the lobby MODEL (T-033, FR-1's create, FR-2's list/join, seat kinds, seat
   tokens). A pure, headless, synchronous module — no HTTP, no WebSocket, no timers, no worker
   spawning — the same "importable and drivable directly from a test" posture server/session.js
   already established for the match-loop side of this project.

   SCOPE, stated up front rather than discovered as a gap later:

   - Still exactly TWO seats, `["player","ai"]` — ADR-0008's own Option B decision (state.owners
     stays the verbatim 2-owner pair through this phase) isn't renegotiated here. FR-1's own
     "seat count" is real config surface for a FUTURE N-seat world (TASKS.md's own Phase 5,
     "ownerDefs from lobby config"), accepted as a config SHAPE now so Phase 5 doesn't need to
     redesign this file, but createMatch REJECTS any `seatKinds` whose length isn't 2 rather than
     silently truncating or padding — an honest, loud "not yet" beats a match that quietly ignores
     half its requested seats.
   - startMatch (T-035) is the one status TRANSITION this file owns — "open" to "started", a
     one-way door — but still no AI-fill decision and no worker spawning here: WHEN to call it
     (the host's own explicit trigger, or automatically once every open seat has a real owner) and
     what "AI-fill" actually means for a seat nobody claimed by then are tools/serve.js's own
     wiring, the same "model vs wiring" split T-033 already drew for createMatch/joinMatch.
   - No HTTP/WS wiring at all. Reachable from a real browser (a shareable join link) is T-034's
     own job. This file is deliberately the SAME kind of standalone, tested layer T-020's wire
     schema and T-021's codec were before T-023 wired them into a live match loop.

   SEAT TOKENS. A genuine (if low-stakes — a self-hosted RTS lobby, not a bank) bearer credential:
   whoever holds a seat's token can reclaim it later (FR-5; T-036 is what actually wires the
   disconnect -> AI-takeover -> reclaim FLOW, this file only has to make reclaiming POSSIBLE).
   Minted fresh per join from node:crypto's randomUUID — never guessable from the match id or seat
   index alone, both of which are routinely PUBLIC (a shareable join link is the whole point of
   FR-2), so the token is the one thing that must not be derivable from anything public.
   ============================================================ */

"use strict";

import { randomUUID } from "node:crypto";

// The same 2-seat interim scheme ADR-0008 Option B already established for state.owners — seat
// index 0 is always "player", seat index 1 is always "ai", for as long as this project stays in
// the 2-seat phase. Not re-derived from `state.owners` (no live engine state exists yet for an
// "open" match — createGameState doesn't run until T-035 actually starts one).
export const OWNER_IDS = Object.freeze(["player", "ai"]);
const SEAT_KINDS = Object.freeze(["open", "ai", "agent"]);

// Which seat kinds a fresh joinMatch may claim. "agent" is joinable for exactly the same reason
// "open" is — it is a seat WAITING for someone to arrive, the label only says who is expected
// (lobbyScreen.js has always mapped its own "an agent plays here" choice onto "open" precisely
// because "agent" used to be unjoinable, which made the kind decorative). "ai" is not: a scripted
// controller already holds it.
const JOINABLE_KINDS = Object.freeze(["open", "agent"]);
export const isJoinableKind = kind => JOINABLE_KINDS.includes(kind);

/**
 * @param {{seatKinds?: string[]}} config - seatKinds defaults to two open seats (an ordinary
 *   human-vs-human skirmish), or must be an array of exactly 2 known kinds otherwise.
 */
function buildSeats(config) {
  const seatKinds = config.seatKinds || ["open", "open"];
  if (seatKinds.length !== 2) {
    throw new Error(`seatKinds must have exactly 2 entries (this project's current 2-seat phase), got ${seatKinds.length}`);
  }
  for (const kind of seatKinds) {
    if (!SEAT_KINDS.includes(kind)) throw new Error(`unknown seat kind: ${kind}`);
  }
  // seatAi[i] is that seat's own scripted-AI config ({strategy, difficulty}) — consulted only for
  // an "ai"-kind seat, and only by whoever actually spawns the match's worker (tools/serve.js).
  // Opaque here, exactly like every other config field this file never interprets.
  const seatAi = Array.isArray(config.seatAi) ? config.seatAi : [];
  return seatKinds.map((kind, i) => ({
    kind, owner: null, token: null,
    // Who is HOLDING this seat, as an opaque caller-chosen string (an MCP client's own stable id)
    // — the one field that survives a client losing its seat_handle, so it can ask for the same
    // seat back rather than being locked out of a match it is already playing.
    clientId: null,
    ai: kind === "ai" ? (seatAi[i] ?? null) : null,
  }));
}

/** @returns {{matches: Map<string, Object>, createMatch: Function, listOpenMatches: Function, getMatch: Function, joinMatch: Function, reclaimSeat: Function, leaveSeat: Function, startMatch: Function}} */
export function createLobby() {
  const matches = new Map();

  /** @param {Object} config - planetId/sizeMult/resourceMult/matchTimeLimit/seatKinds/hostId, all opaque to this file except seatKinds */
  function createMatch(config) {
    const id = randomUUID();
    const seats = buildSeats(config);
    const match = {
      id,
      status: "open",
      config: { ...config, seatKinds: seats.map(s => s.kind) },
      seats,
      hostId: config.hostId ?? null,
      createdAt: Date.now(),
    };
    matches.set(id, match);
    return match;
  }

  // T-057: a deliberation-clockPolicy match is never listed — the one piece of this file's own
  // defense-in-depth against "never in a lobby with a human" (ADR-0007's own safety property);
  // the real guarantee is that no network-reachable path ever CREATES one with anything but the
  // default (realtime) clockPolicy in the first place (see tools/serve.js's own create-match
  // handler), but a browsing human should never even SEE one exists, belt and braces.
  function listOpenMatches() {
    return [...matches.values()].filter(m => m.status === "open" && (m.config.clockPolicy ?? "realtime") === "realtime");
  }

  /** @returns {Object|null} */
  function getMatch(matchId) {
    return matches.get(matchId) || null;
  }

  /**
   * @param {string} matchId @param {number} seatIndex
   * @param {string|null} [clientId] an opaque, caller-chosen stable identity for whoever is taking
   *   this seat — see buildSeats' own `clientId` comment. Omitted (every caller before this) is
   *   stored as null and changes nothing.
   * @returns {{ok:true, token:string, owner:string}|{ok:false, code:string}}
   */
  function joinMatch(matchId, seatIndex, clientId = null) {
    const match = matches.get(matchId);
    if (!match) return { ok: false, code: "no-such-match" };
    // T-035: once started, the window for a casual join has closed — an AI-filled seat is only
    // reachable again through T-036's own reclaim flow, never a fresh join.
    if (match.status !== "open") return { ok: false, code: "already-started" };
    const seat = match.seats[seatIndex];
    if (!seat) return { ok: false, code: "no-such-seat" };
    if (!isJoinableKind(seat.kind)) return { ok: false, code: "seat-not-open" };
    if (seat.owner) return { ok: false, code: "seat-taken" };
    seat.owner = OWNER_IDS[seatIndex];
    seat.token = randomUUID();
    seat.clientId = clientId ?? null;
    return { ok: true, token: seat.token, owner: seat.owner };
  }

  /** @returns {{ok:true, owner:string}|{ok:false, code:string}} */
  function reclaimSeat(matchId, seatIndex, token) {
    const match = matches.get(matchId);
    if (!match) return { ok: false, code: "no-such-match" };
    const seat = match.seats[seatIndex];
    // A seat nobody has ever joined has no token to compare against — indistinguishable, on
    // purpose, from an out-of-range seat index: neither has anything legitimate to reclaim.
    if (!seat || !seat.token) return { ok: false, code: "no-such-seat" };
    if (seat.token !== token) return { ok: false, code: "bad-token" };
    return { ok: true, owner: seat.owner };
  }

  /**
   * T-051: the twin of joinMatch — frees an OPEN match's seat back to unowned (kind untouched, so
   * it stays exactly as re-joinable as it was before anyone ever claimed it), for an MCP agent
   * that has nothing analogous to T-036's own disconnect detection (no persistent connection at
   * all to lose) and needs an explicit way to voluntarily give up a seat before a match starts.
   * Self-authenticating like reclaimSeat, on purpose: every other mutating function here already
   * re-checks its own token rather than trusting an already-validated caller, and a seat's own
   * token is retired the moment it's freed — a departed seat's old token can never reclaim
   * whoever joins next, only the fresh one joinMatch mints for them.
   * @returns {{ok:true}|{ok:false, code:string}}
   */
  function leaveSeat(matchId, seatIndex, token) {
    const match = matches.get(matchId);
    if (!match) return { ok: false, code: "no-such-match" };
    const seat = match.seats[seatIndex];
    if (!seat || !seat.token) return { ok: false, code: "no-such-seat" };
    if (seat.token !== token) return { ok: false, code: "bad-token" };
    // Mirrors joinMatch's own "already-started" refusal: once live, a seat leaves through the
    // engine's own surrender (engine/victory.js, T-046), not by vanishing from the lobby model.
    if (match.status !== "open") return { ok: false, code: "already-started" };
    seat.owner = null;
    seat.token = null;
    seat.clientId = null;
    return { ok: true };
  }

  /**
   * T-035 (FR-4): the ONE transition out of "open" — a one-way door, never re-openable. This file
   * still doesn't decide WHEN to call it (host-triggered vs. all-seats-filled) or spawn anything;
   * that's tools/serve.js's own wiring, the same "model vs wiring" split T-033 already drew for
   * createMatch/joinMatch themselves.
   * @returns {{ok:true, match:Object}|{ok:false, code:string}}
   */
  function startMatch(matchId) {
    const match = matches.get(matchId);
    if (!match) return { ok: false, code: "no-such-match" };
    if (match.status !== "open") return { ok: false, code: "already-started" };
    match.status = "started";
    return { ok: true, match };
  }

  /**
   * The seat `clientId` already holds in this match, if any — the recovery path for an MCP client
   * that lost its seat_handle (a context compaction, a process restart) but still knows its own
   * id. Deliberately NOT authenticated by anything but the client id itself: it hands back the
   * same token that client was already given, so it is exactly as strong as whoever can guess that
   * id, which is why the id is expected to be a random one the client mints for itself (see
   * server/mcpLobbyTools.js's own join_match doc). Works whether or not the match has started —
   * rejoining a LIVE match is the whole point.
   * @returns {{ok:true, seatIndex:number, owner:string, token:string}|{ok:false, code:string}}
   */
  function findSeatForClient(matchId, clientId) {
    const match = matches.get(matchId);
    if (!match) return { ok: false, code: "no-such-match" };
    if (!clientId) return { ok: false, code: "no-client-id" };
    const seatIndex = match.seats.findIndex(s => s.clientId === clientId && s.token);
    if (seatIndex === -1) return { ok: false, code: "no-seat-for-client" };
    const seat = match.seats[seatIndex];
    return { ok: true, seatIndex, owner: seat.owner, token: seat.token };
  }

  /**
   * Every match this client currently holds a seat in, started or not — what an MCP client with
   * nothing but its own id left calls to find its way back into whatever it was playing.
   * @returns {{matchId:string, status:string, seatIndex:number, owner:string, token:string}[]}
   */
  function listSeatsForClient(clientId) {
    if (!clientId) return [];
    const out = [];
    for (const match of matches.values()) {
      match.seats.forEach((seat, seatIndex) => {
        if (seat.clientId === clientId && seat.token) {
          out.push({ matchId: match.id, status: match.status, seatIndex, owner: seat.owner, token: seat.token });
        }
      });
    }
    return out;
  }

  return { matches, createMatch, listOpenMatches, getMatch, joinMatch, reclaimSeat, leaveSeat, startMatch, findSeatForClient, listSeatsForClient };
}

// The safe subset of a match record a stranger (browsing the open-match list, or an MCP agent's
// own list_matches, T-051) may see: never a seat's own token (a bearer credential — this file's
// own header), never the live createGameStateOpts seed (would let a spectator predict resource-
// node placement ahead of discovering it in-fog). spectatorsEnabled (T-037) IS meant for exactly
// this audience — a prospective spectator needs to know before attempting to watch, same reason a
// seat's own kind/taken state is public. Lives here, not in tools/serve.js/server/mcpLobbyTools.js,
// so BOTH can import the one real redaction without either importing the other (server/lobby.js
// itself has no imports of its own beyond node:crypto, so nothing importing FROM it can ever cycle
// back through it).
export function publicMatch(match) {
  return {
    id: match.id, status: match.status, createdAt: match.createdAt,
    planetId: match.config.planetId, sizeMult: match.config.sizeMult ?? 1, resourceMult: match.config.resourceMult ?? 1,
    matchTimeLimit: match.config.matchTimeLimit ?? null,
    // `controller` is the same three-value vocabulary server/mcpLobbyTools.js's own create_match
    // accepts back ("ai" | "human" | "agent"), so what a caller asked for and what it later reads
    // back are spelled the same way. `ai` is that seat's scripted-AI pick, present only when there
    // actually is one — never a token, never a client id (both are credentials, see this
    // function's own header).
    seats: match.seats.map(s => ({
      kind: s.kind, taken: !!s.owner,
      controller: s.kind === "ai" ? "ai" : (s.kind === "agent" ? "agent" : "human"),
      ...(s.ai ? { ai: s.ai } : {}),
    })),
    spectatorsEnabled: match.config.spectatorsEnabled !== false,
  };
}
