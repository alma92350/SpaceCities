/* ============================================================
   T-031: session.js's seatDisplayName — the ONE place a seat's owner id turns into text a
   player reads, so no call site ever interpolates the raw "player"/"ai" string into user-facing
   copy again (the exit criterion this task exists to satisfy). Not to be confused with
   test/session.test.js, which covers a DIFFERENT file entirely — server/session.js's match
   session wrapper (ADR-0003/0004), a server-side concept with no relation to this client-side
   `game` object beyond the unfortunately-shared filename stem.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { game, seatDisplayName } from "../session.js";

test("seatDisplayName(game.localOwner) is always \"You\", on the default boot (localOwner \"player\")", () => {
  const original = { localOwner: game.localOwner, seatNames: game.seatNames };
  try {
    game.localOwner = "player";
    game.seatNames = {};
    assert.equal(seatDisplayName("player"), "You");
  } finally { game.localOwner = original.localOwner; game.seatNames = original.seatNames; }
});

test("seatDisplayName falls back to \"Opponent\" for the other seat when no real name is set", () => {
  const original = { localOwner: game.localOwner, seatNames: game.seatNames };
  try {
    game.localOwner = "player";
    game.seatNames = {};
    assert.equal(seatDisplayName("ai"), "Opponent");
  } finally { game.localOwner = original.localOwner; game.seatNames = original.seatNames; }
});

test("seatDisplayName respects game.localOwner, not a hardcoded \"player\" — seat B's own screen calls seat B \"You\"", () => {
  const original = { localOwner: game.localOwner, seatNames: game.seatNames };
  try {
    game.localOwner = "ai";
    game.seatNames = {};
    assert.equal(seatDisplayName("ai"), "You", "seat B's own seat is \"You\" on seat B's own screen");
    assert.equal(seatDisplayName("player"), "Opponent", "the OTHER seat is the opponent now");
  } finally { game.localOwner = original.localOwner; game.seatNames = original.seatNames; }
});

test("seatDisplayName returns a real chosen name for the other seat once one is set, instead of the generic fallback", () => {
  const original = { localOwner: game.localOwner, seatNames: game.seatNames };
  try {
    game.localOwner = "player";
    game.seatNames = { ai: "Commander Vex" };
    assert.equal(seatDisplayName("ai"), "Commander Vex");
  } finally { game.localOwner = original.localOwner; game.seatNames = original.seatNames; }
});

test("seatDisplayName still returns \"You\" for the local seat even when a real name is ALSO on record for it — first-person context wins", () => {
  const original = { localOwner: game.localOwner, seatNames: game.seatNames };
  try {
    game.localOwner = "player";
    game.seatNames = { player: "Alice" };
    assert.equal(seatDisplayName("player"), "You", "a player's own screen calls their own seat \"You\", not their own recorded name");
  } finally { game.localOwner = original.localOwner; game.seatNames = original.seatNames; }
});

test("seatDisplayName never returns the raw owner id itself, under any of the above configurations", () => {
  const original = { localOwner: game.localOwner, seatNames: game.seatNames };
  try {
    for (const localOwner of ["player", "ai"]) {
      for (const seatNames of [{}, { player: "Alice", ai: "Vex" }]) {
        game.localOwner = localOwner;
        game.seatNames = seatNames;
        for (const owner of ["player", "ai"]) {
          const name = seatDisplayName(owner);
          assert.notEqual(name, "player");
          assert.notEqual(name, "ai");
        }
      }
    }
  } finally { game.localOwner = original.localOwner; game.seatNames = original.seatNames; }
});
