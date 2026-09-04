/* ============================================================
   T-033: server/lobby.js — the lobby MODEL (FR-1's create, FR-2's list/join, seat kinds, seat
   tokens). Deliberately narrow, matching this project's own established "build the piece, then
   wire it" staging (T-020's wire schema before T-021's codec before T-023's real wiring):

   - Still exactly TWO seats, `["player","ai"]`, same as every match today — ADR-0008's own Option
     B decision (state.owners stays the verbatim 2-owner pair) isn't renegotiated by this task;
     FR-1's "seat count" is real config surface for a FUTURE N-seat world (Phase 5's own
     ownerDefs-from-lobby-config work, TASKS.md's own Phase 5 row), accepted here without being
     acted on yet — createMatch validates seatKinds.length === 2 rather than silently truncating
     or padding a caller's other-length config, so a Phase 5 caller gets a clear, honest rejection
     instead of a match that quietly ignores 3 of its 4 requested seats.
   - No AI-fill and no worker spawning: "unfilled open seats become AI seats AT MATCH START"
     (FR-3) is explicitly T-035's own row ("Match lifecycle: start conditions, AI fill..."), and
     nothing here starts a match at all. A lobby match stays "open" (or, once T-035 exists,
     whatever status IT sets — this file doesn't interpret status beyond a plain string) for the
     whole of this file's own scope.
   - No HTTP/WS wiring: server/lobby.js is a pure, headless, synchronous model — the same
     "importable and drivable directly from a test" posture server/session.js's own test file
     established — reachable from a real client is T-034's job (a shareable join link, T-034's own
     exit criterion).

   Seat tokens are a genuine (if low-stakes — this is a self-hosted RTS lobby, not a bank) bearer
   credential: whoever holds a seat's token can reclaim it later (FR-5, T-036's own job to actually
   wire the reconnect flow) — minted fresh per join, never guessable from the match/seat ids alone
   (both of those are OFTEN public — a shareable join link, FR-2 — so the token is the only thing
   that must not be).
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createLobby, OWNER_IDS } from "../server/lobby.js";

function baseConfig(overrides = {}) {
  return { planetId: "ferros", sizeMult: 1, resourceMult: 1, matchTimeLimit: null, ...overrides };
}

test("createMatch mints a real, unique id and starts the match \"open\" with the requested seat kinds", () => {
  const lobby = createLobby();
  const a = lobby.createMatch(baseConfig({ seatKinds: ["open", "open"] }));
  const b = lobby.createMatch(baseConfig({ seatKinds: ["open", "ai"] }));

  assert.equal(typeof a.id, "string");
  assert.ok(a.id.length > 0);
  assert.notEqual(a.id, b.id);
  assert.equal(a.status, "open");
  assert.deepEqual(a.seats.map(s => s.kind), ["open", "open"]);
  assert.deepEqual(b.seats.map(s => s.kind), ["open", "ai"]);
  assert.ok(a.seats.every(s => s.owner === null && s.token === null), "no seat is claimed yet");
});

test("createMatch defaults to two open seats when seatKinds is omitted — today's ordinary skirmish shape", () => {
  const lobby = createLobby();
  const match = lobby.createMatch(baseConfig());
  assert.deepEqual(match.seats.map(s => s.kind), ["open", "open"]);
});

test("createMatch rejects a seatKinds length other than 2 — honestly, not by silently truncating/padding", () => {
  const lobby = createLobby();
  assert.throws(() => lobby.createMatch(baseConfig({ seatKinds: ["open", "open", "open"] })), /seatKinds/);
  assert.throws(() => lobby.createMatch(baseConfig({ seatKinds: ["open"] })), /seatKinds/);
});

test("createMatch rejects an unknown seat kind", () => {
  const lobby = createLobby();
  assert.throws(() => lobby.createMatch(baseConfig({ seatKinds: ["open", "referee"] })), /seat kind/);
});

test("listOpenMatches returns every \"open\" match, and none that aren't", () => {
  const lobby = createLobby();
  const a = lobby.createMatch(baseConfig());
  const b = lobby.createMatch(baseConfig());
  const listed = lobby.listOpenMatches();
  assert.deepEqual(listed.map(m => m.id).sort(), [a.id, b.id].sort());
});

test("getMatch returns null for an id that was never created, never throws", () => {
  const lobby = createLobby();
  assert.equal(lobby.getMatch("not-a-real-id"), null);
});

test("joinMatch claims an open seat, mints a real token, and assigns the owner id matching that seat's position", () => {
  const lobby = createLobby();
  const match = lobby.createMatch(baseConfig());

  const first = lobby.joinMatch(match.id, 0);
  assert.equal(first.ok, true);
  assert.equal(typeof first.token, "string");
  assert.ok(first.token.length > 0);
  assert.equal(first.owner, OWNER_IDS[0]);

  const second = lobby.joinMatch(match.id, 1);
  assert.equal(second.ok, true);
  assert.equal(second.owner, OWNER_IDS[1]);
  assert.notEqual(second.token, first.token, "two different seats must never share a token");
});

test("joinMatch refuses a seat that's already taken", () => {
  const lobby = createLobby();
  const match = lobby.createMatch(baseConfig());
  lobby.joinMatch(match.id, 0);
  const again = lobby.joinMatch(match.id, 0);
  assert.equal(again.ok, false);
  assert.equal(again.code, "seat-taken");
});

test("joinMatch refuses a seat that isn't \"open\" (an \"ai\" seat can never be claimed by a human)", () => {
  const lobby = createLobby();
  const match = lobby.createMatch(baseConfig({ seatKinds: ["open", "ai"] }));
  const result = lobby.joinMatch(match.id, 1);
  assert.equal(result.ok, false);
  assert.equal(result.code, "seat-not-open");
});

test("joinMatch reports a clear rejection for an unknown match or an out-of-range seat, never throws", () => {
  const lobby = createLobby();
  const match = lobby.createMatch(baseConfig());
  assert.equal(lobby.joinMatch("not-a-real-id", 0).ok, false);
  assert.equal(lobby.joinMatch("not-a-real-id", 0).code, "no-such-match");
  assert.equal(lobby.joinMatch(match.id, 5).ok, false);
  assert.equal(lobby.joinMatch(match.id, 5).code, "no-such-seat");
});

test("reclaimSeat succeeds with the exact token joinMatch minted, and reports the same owner id", () => {
  const lobby = createLobby();
  const match = lobby.createMatch(baseConfig());
  const joined = lobby.joinMatch(match.id, 0);

  const reclaimed = lobby.reclaimSeat(match.id, 0, joined.token);
  assert.equal(reclaimed.ok, true);
  assert.equal(reclaimed.owner, OWNER_IDS[0]);
});

test("reclaimSeat refuses a wrong token — a guess, or another seat's real token, must never work", () => {
  const lobby = createLobby();
  const matchA = lobby.createMatch(baseConfig());
  const matchB = lobby.createMatch(baseConfig());
  const joinedA0 = lobby.joinMatch(matchA.id, 0);
  lobby.joinMatch(matchA.id, 1);
  lobby.joinMatch(matchB.id, 0);

  assert.equal(lobby.reclaimSeat(matchA.id, 0, "not-the-real-token").ok, false);
  assert.equal(lobby.reclaimSeat(matchA.id, 0, "not-the-real-token").code, "bad-token");
  // Seat 1's own real token must not reclaim seat 0, even in the SAME match.
  const joinedA1Token = lobby.matches.get(matchA.id).seats[1].token;
  assert.equal(lobby.reclaimSeat(matchA.id, 0, joinedA1Token).ok, false);
  // A DIFFERENT match's real token must not reclaim a seat here either.
  const matchBToken = lobby.matches.get(matchB.id).seats[0].token;
  assert.equal(lobby.reclaimSeat(matchA.id, 0, matchBToken).ok, false);
  // The real token, unchanged, still legitimately works — this test isn't leaving the fixture broken.
  assert.equal(lobby.reclaimSeat(matchA.id, 0, joinedA0.token).ok, true);
});

test("reclaimSeat refuses an unclaimed seat (no token exists yet to match against) and an unknown match, without throwing", () => {
  const lobby = createLobby();
  const match = lobby.createMatch(baseConfig());
  const result = lobby.reclaimSeat(match.id, 0, "anything");
  assert.equal(result.ok, false);
  assert.equal(result.code, "no-such-seat");
  assert.equal(lobby.reclaimSeat("not-a-real-id", 0, "anything").ok, false);
});

// T-035: FR-4's own start conditions. startMatch is the ONE transition out of "open" — this file
// still doesn't decide WHEN to call it (host-triggered vs. all-seats-filled is tools/serve.js's
// own wiring, same "model vs wiring" split T-033 already drew for create/join) or spawn anything;
// it only ever flips status and refuses to flip it twice.
test("startMatch transitions an open match to \"started\", and it drops out of listOpenMatches", () => {
  const lobby = createLobby();
  const match = lobby.createMatch(baseConfig());
  const result = lobby.startMatch(match.id);
  assert.equal(result.ok, true);
  assert.equal(result.match.status, "started");
  assert.equal(lobby.getMatch(match.id).status, "started", "the SAME match object the lobby itself tracks, not a copy");
  assert.deepEqual(lobby.listOpenMatches(), []);
});

test("startMatch refuses an unknown match, without throwing", () => {
  const lobby = createLobby();
  const result = lobby.startMatch("not-a-real-id");
  assert.equal(result.ok, false);
  assert.equal(result.code, "no-such-match");
});

test("startMatch refuses a match that's already started — starting is a one-way door", () => {
  const lobby = createLobby();
  const match = lobby.createMatch(baseConfig());
  lobby.startMatch(match.id);
  const result = lobby.startMatch(match.id);
  assert.equal(result.ok, false);
  assert.equal(result.code, "already-started");
});

test("joinMatch refuses a seat once the match has started — the window for a casual join has closed (T-036's reclaim flow is the only way back into an AI-filled seat)", () => {
  const lobby = createLobby();
  const match = lobby.createMatch(baseConfig());
  lobby.startMatch(match.id);
  const result = lobby.joinMatch(match.id, 1);
  assert.equal(result.ok, false);
  assert.equal(result.code, "already-started");
});

// T-051: leaveSeat — a NEW capability, not needed until an MCP agent (which holds no persistent
// connection at all, so has nothing analogous to T-036's own disconnect detection) needs a way to
// voluntarily give up a seat it hasn't started playing yet. Self-authenticating like reclaimSeat
// itself (a token, re-checked here, not trusted from whatever validated it earlier) rather than a
// bare matchId+seatIndex — every OTHER mutating function in this file already re-checks its own
// token, and this one shouldn't be the first exception.
test("leaveSeat frees an open match's seat back to unowned, with the exact right token", () => {
  const lobby = createLobby();
  const match = lobby.createMatch(baseConfig());
  const joined = lobby.joinMatch(match.id, 0);

  const left = lobby.leaveSeat(match.id, 0, joined.token);
  assert.equal(left.ok, true);

  const seat = lobby.matches.get(match.id).seats[0];
  assert.equal(seat.owner, null);
  assert.equal(seat.token, null);
  assert.equal(seat.kind, "open", "the seat's KIND is untouched — still open for someone else to claim");
});

test("a freed seat can genuinely be re-joined by someone else, with a fresh token — leaveSeat isn't just a bookkeeping no-op", () => {
  const lobby = createLobby();
  const match = lobby.createMatch(baseConfig());
  const joined = lobby.joinMatch(match.id, 0);
  lobby.leaveSeat(match.id, 0, joined.token);

  const rejoined = lobby.joinMatch(match.id, 0);
  assert.equal(rejoined.ok, true);
  assert.notEqual(rejoined.token, joined.token, "a fresh token, never the departed seat's old one");
  // The old token is well and truly dead — it must not reclaim the new occupant's seat.
  assert.equal(lobby.reclaimSeat(match.id, 0, joined.token).ok, false);
  assert.equal(lobby.reclaimSeat(match.id, 0, rejoined.token).ok, true);
});

test("leaveSeat refuses a wrong token — a departing seat can only be freed by whoever actually holds it", () => {
  const lobby = createLobby();
  const match = lobby.createMatch(baseConfig());
  const joined = lobby.joinMatch(match.id, 0);

  const result = lobby.leaveSeat(match.id, 0, "not-the-real-token");
  assert.equal(result.ok, false);
  assert.equal(result.code, "bad-token");
  // Refused, so the seat is UNTOUCHED — still legitimately reclaimable by its real owner.
  assert.equal(lobby.reclaimSeat(match.id, 0, joined.token).ok, true);
});

test("leaveSeat refuses once the match has started — a live seat leaves through the engine's own surrender, not the lobby", () => {
  const lobby = createLobby();
  const match = lobby.createMatch(baseConfig());
  const joined = lobby.joinMatch(match.id, 0);
  lobby.startMatch(match.id);

  const result = lobby.leaveSeat(match.id, 0, joined.token);
  assert.equal(result.ok, false);
  assert.equal(result.code, "already-started");
});

test("leaveSeat refuses an unclaimed seat and an unknown match, without throwing", () => {
  const lobby = createLobby();
  const match = lobby.createMatch(baseConfig());
  assert.equal(lobby.leaveSeat(match.id, 0, "anything").code, "no-such-seat");
  assert.equal(lobby.leaveSeat("not-a-real-id", 0, "anything").ok, false);
});
