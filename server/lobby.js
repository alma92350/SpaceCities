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
   - No AI-fill, no "start a match", no worker spawning. FR-3 ("unfilled open seats become AI
     seats AT MATCH START") is T-035's own row ("Match lifecycle: start conditions, AI fill...") —
     nothing in this file interprets or transitions `status` beyond treating it as a plain string;
     a match created here simply stays "open" for the whole of this file's own scope.
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
  return seatKinds.map(kind => ({ kind, owner: null, token: null }));
}

/** @returns {{matches: Map<string, Object>, createMatch: Function, listOpenMatches: Function, getMatch: Function, joinMatch: Function, reclaimSeat: Function}} */
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

  function listOpenMatches() {
    return [...matches.values()].filter(m => m.status === "open");
  }

  /** @returns {Object|null} */
  function getMatch(matchId) {
    return matches.get(matchId) || null;
  }

  /** @returns {{ok:true, token:string, owner:string}|{ok:false, code:string}} */
  function joinMatch(matchId, seatIndex) {
    const match = matches.get(matchId);
    if (!match) return { ok: false, code: "no-such-match" };
    const seat = match.seats[seatIndex];
    if (!seat) return { ok: false, code: "no-such-seat" };
    if (seat.kind !== "open") return { ok: false, code: "seat-not-open" };
    if (seat.owner) return { ok: false, code: "seat-taken" };
    seat.owner = OWNER_IDS[seatIndex];
    seat.token = randomUUID();
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

  return { matches, createMatch, listOpenMatches, getMatch, joinMatch, reclaimSeat };
}
