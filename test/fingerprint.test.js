/* ============================================================
   T-040 (FR-20): net/fingerprint.js's seatFingerprint(state, seat) — the one slice of state a
   network client can independently and correctly compute on either side of the wire (its own,
   never-fog-filtered units/buildings/resources), rounded to the same precision T-028b's own wire
   quantization already uses so a legitimate client's necessarily-coarser copy never looks diverged
   on position alone.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeUnit } from "../engine/state.js";
import { seatFingerprint } from "../net/fingerprint.js";

function scenario(seed = 11) {
  return createGameState({ planetId: "ferros", seed });
}

test("seatFingerprint is deterministic — the same state and seat always produce the same string", () => {
  const state = scenario();
  assert.equal(seatFingerprint(state, "player"), seatFingerprint(state, "player"));
});

test("moving the seat's OWN unit changes that seat's own fingerprint", () => {
  const state = scenario();
  const before = seatFingerprint(state, "player");
  const unit = [...state.units.values()].find(u => u.owner === "player");
  unit.x += 5;
  const after = seatFingerprint(state, "player");
  assert.notEqual(before, after);
});

test("moving the OPPONENT's unit never changes this seat's own fingerprint — independence across the fog boundary", () => {
  const state = scenario();
  const before = seatFingerprint(state, "player");
  const enemy = [...state.units.values()].find(u => u.owner === "ai");
  enemy.x += 500;
  enemy.y += 500;
  enemy.hp -= 10;
  const after = seatFingerprint(state, "player");
  assert.equal(before, after, "a seat's own fingerprint must depend ONLY on its own entities — a client never knows the opponent's fogged-out state anyway, so comparing against it could never be meaningful");
});

test("sub-quantization-precision position noise never changes the fingerprint — rounds to the same value T-028b's own wire quantization would have sent", () => {
  const state = scenario();
  const unit = [...state.units.values()].find(u => u.owner === "player");
  unit.x = 100.001;
  const a = seatFingerprint(state, "player");
  unit.x = 100.004;
  const b = seatFingerprint(state, "player");
  assert.equal(a, b, "both values round to the same 2-decimal-place figure — a real client could never tell them apart on the wire, so this must not be flagged as divergence");
});

test("a real, above-quantization-precision position difference DOES change the fingerprint", () => {
  const state = scenario();
  const unit = [...state.units.values()].find(u => u.owner === "player");
  unit.x = 100.01;
  const a = seatFingerprint(state, "player");
  unit.x = 100.02;
  const b = seatFingerprint(state, "player");
  assert.notEqual(a, b, "a genuine one-hundredth difference is real divergence, not quantization noise — it must still be caught");
});

test("entity Map insertion order never affects the fingerprint — units/buildings are sorted before hashing", () => {
  const stateA = scenario();
  const stateB = scenario();
  // Rebuild stateB's units Map with the SAME entries in REVERSED insertion order.
  const reversed = [...stateB.units.entries()].reverse();
  stateB.units = new Map(reversed);
  assert.equal(seatFingerprint(stateA, "player"), seatFingerprint(stateB, "player"));
});

test("a change to the seat's own resources changes its own fingerprint", () => {
  const state = scenario();
  const before = seatFingerprint(state, "player");
  state.players.player.resources.ore += 100;
  const after = seatFingerprint(state, "player");
  assert.notEqual(before, after);
});

test("a change to the OPPONENT's resources never changes this seat's own fingerprint", () => {
  const state = scenario();
  const before = seatFingerprint(state, "player");
  state.players.ai.resources.ore += 999999;
  const after = seatFingerprint(state, "player");
  assert.equal(before, after);
});

test("a tick change alone (nothing else different) changes the fingerprint", () => {
  const state = scenario();
  const before = seatFingerprint(state, "player");
  state.tick += 1;
  const after = seatFingerprint(state, "player");
  assert.notEqual(before, after);
});

test("the two seats' own fingerprints are independent of each other and of which seat is asked first", () => {
  const state = scenario();
  const playerFp1 = seatFingerprint(state, "player");
  const aiFp = seatFingerprint(state, "ai");
  const playerFp2 = seatFingerprint(state, "player");
  assert.equal(playerFp1, playerFp2, "asking for the other seat's fingerprint in between must not mutate or affect this seat's own");
  assert.notEqual(playerFp1, aiFp, "fixture sanity: the two seats start with different forces, so their fingerprints must differ");
});
