/* ============================================================
   lobbyScreen.js — applyLiveState: folds each incoming live-match "state" push onto the SAME
   game.state object bootState wired input/camera/control-groups to (net/wsClientTransport.js's own
   reassembleProjection rebuilds a brand-new object, new Maps included, on every push — see this
   file's own header). Everything else about a live match (hosting, joining, the actual WebSocket
   wiring) is exercised by test/wsWorkerTransport.test.js/test/wsTransport.test.js one layer down;
   this file only needs its own field-by-field merge to be correct.

   A REAL bug, found by playing the game rather than by any prior test: applyLiveState used to copy
   EVERY field from the fresh push onto `live`, including `selection` — which reassembleProjection
   always hardcodes to `[]` (engine/projection.js's own header: it's UI-only, "the server never
   reads or sends it"). Since a live match pushes several times a second, a player's own click
   (input.js's own `state.selection = [...]`) was wiped by the very next tick, making every click
   un-selectable in practice. These tests pin the fix down directly.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./_dom.js";

installFakeDom();

const { applyLiveState, hostSeatConfig, hostNextAction } = await import("../lobbyScreen.js");

/* ============================================================
   hostNextAction — what the host button becomes once POST /api/matches has replied. Both branches
   that existed assumed the creator holds seat 0: one connected with created.token, the other POSTed
   /start with it. A hostJoins:false creator has no token at all, so "Start match" would 403
   (not-the-host) and "Enter match" would connect with a null token — the creator's only honest
   option is to WATCH, and to wait for the seats to fill rather than trying to start the match itself.
   ============================================================ */

test("a seated host whose match is already live enters it", () => {
  assert.equal(hostNextAction({ started: true, token: "t" }), "enter");
});

test("a seated host whose match is still waiting can start it", () => {
  assert.equal(hostNextAction({ started: false, token: "t" }), "start");
});

test("a watch-only host (hostJoins:false, so no token) watches an already-live match rather than 'entering' it with a null token", () => {
  assert.equal(hostNextAction({ started: true, token: null }), "watch");
});

test("a watch-only host of a not-yet-full match still watches — it must WAIT for the seats to fill, never POST /start it has no token for", () => {
  assert.equal(hostNextAction({ started: false, token: null }), "watch");
});

/* ============================================================
   hostSeatConfig — the host form's two seat dropdowns, reduced to the two POST /api/matches fields
   that actually decide who can play: seatKinds and hostJoins. Previously the form hardcoded neither,
   so tools/serve.js's own default (hostJoins:true) always auto-claimed seat 0 for the creator and
   the ONLY reachable match was "the host plus one other human" — an agent-vs-agent match, or a
   watch-only host, could not be set up from the browser at all, only by hand-rolling the curl.
   ============================================================ */

test("Me + Open (agent): the ordinary human-hosted match — the host claims seat 0, both seats are joinable kinds", () => {
  assert.deepEqual(hostSeatConfig("me", "agent"), { seatKinds: ["open", "agent"], hostJoins: true });
});

test("Me + Built-in AI: seat 1 is an 'ai' kind, so tools/serve.js's seatsFilled sees a full match and auto-starts it", () => {
  assert.deepEqual(hostSeatConfig("me", "ai"), { seatKinds: ["open", "ai"], hostJoins: true });
});

test("Open (agent) + Open (agent): hostJoins:false is the whole point — leaves BOTH seats genuinely open for two agents' own join_match", () => {
  assert.deepEqual(hostSeatConfig("agent", "agent"), { seatKinds: ["agent", "agent"], hostJoins: false });
});

test("Open (agent) + Built-in AI: one agent against a named built-in AI, with the creator only ever spectating", () => {
  assert.deepEqual(hostSeatConfig("agent", "ai"), { seatKinds: ["agent", "ai"], hostJoins: false });
});

test("a seat the host designated for an agent is requested as the 'agent' KIND, so the intent survives to the server", () => {
  // This used to be forbidden: an "agent" kind made the seat unjoinable (joinMatch rejected it with
  // seat-not-open) AND made seatsFilled treat it as already filled, auto-starting the match before
  // any agent arrived, so both dropdown values meaning "an agent plays here" had to flatten to
  // "open". With both of those fixed, flattening would only throw away the one fact that tells an
  // agent seat apart from a seat waiting for a person.
  assert.deepEqual(hostSeatConfig("me", "agent").seatKinds[1], "agent");
  assert.deepEqual(hostSeatConfig("agent", "agent").seatKinds, ["agent", "agent"]);
  // ...but a seat the host is PLAYING is an ordinary human seat, whatever seat 2 is.
  assert.equal(hostSeatConfig("me", "ai").seatKinds[0], "open");
});

test("an unrecognised dropdown value falls back to the plain human-vs-human match rather than inventing a seating", () => {
  assert.deepEqual(hostSeatConfig("", ""), { seatKinds: ["open", "open"], hostJoins: true });
});

function entity(id, extra = {}) {
  return { id, x: 0, y: 0, hp: 100, owner: "player", ...extra };
}

// Shaped exactly like engine/projection.js's own reassembleProjection output: real Maps (never
// arrays) for units/buildings, and `selection: []` — its own permanent placeholder, never the
// player's real selection, which reassembleProjection has no way to know at all.
function freshState(overrides = {}) {
  return {
    tick: 1, time: 0.05, over: false, winner: null,
    units: new Map([["u1", entity("u1")], ["u2", entity("u2")]]),
    buildings: new Map([["b1", entity("b1", { type: "command" })]]),
    selection: [],
    ...overrides,
  };
}

function liveState(overrides = {}) {
  return {
    tick: 0, time: 0, over: false, winner: null,
    units: new Map(), buildings: new Map(), selection: [],
    ...overrides,
  };
}

test("applyLiveState updates ordinary server-authoritative fields (tick, units, buildings) from the fresh push", () => {
  const live = liveState();
  applyLiveState(live, freshState({ tick: 5 }));
  assert.equal(live.tick, 5);
  assert.deepEqual([...live.units.keys()], ["u1", "u2"]);
  assert.deepEqual([...live.buildings.keys()], ["b1"]);
});

test("a selection made locally survives the next state push — the real bug this file's own header documents", () => {
  const live = liveState({ selection: ["u1"] });
  applyLiveState(live, freshState());   // reassembleProjection's own selection:[] must NOT win
  assert.deepEqual(live.selection, ["u1"]);
});

test("a selection survives MULTIPLE consecutive pushes, not just one — a live match pushes continuously, several times a second", () => {
  const live = liveState({ selection: ["u1", "u2"] });
  for (let i = 0; i < 5; i++) applyLiveState(live, freshState({ tick: i }));
  assert.deepEqual(live.selection, ["u1", "u2"]);
});

test("a selected id is dropped once its own entity is actually gone from a fresh push — the same cleanup engine/state.js's removeEntity does for single-player, which this network path never calls itself", () => {
  const live = liveState({ selection: ["u1", "u2"] });
  const fresh = freshState();
  fresh.units.delete("u2");   // u2 was destroyed since the player selected it
  applyLiveState(live, fresh);
  assert.deepEqual(live.selection, ["u1"]);
});

test("a selected BUILDING id survives a push exactly the same way a selected unit id does", () => {
  const live = liveState({ selection: ["b1"] });
  applyLiveState(live, freshState());
  assert.deepEqual(live.selection, ["b1"]);
});

test("an empty selection stays empty — no phantom ids are ever introduced by a push", () => {
  const live = liveState();
  applyLiveState(live, freshState());
  assert.deepEqual(live.selection, []);
});
