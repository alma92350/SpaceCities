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

const { applyLiveState } = await import("../lobbyScreen.js");

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
