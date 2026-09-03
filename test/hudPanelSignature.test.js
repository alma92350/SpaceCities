/* ============================================================
   T-030: hudPanelSignature.js's own header calls it "a genuine leaf: importable and drivable
   directly from a test" — this file takes it up on that, but only for the ONE property T-030
   actually changed here: `state.players[game.localOwner]` replacing a hardcoded
   `state.players.player` throughout. Not comprehensive coverage of this module (a real gap, but a
   separate effort from this task) — loadableComs is the simplest exported function that reads the
   local economy, so it's the direct, minimal proof the seam holds here too.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState } from "../engine/state.js";
import { mulberry32 } from "../engine/rng.js";
import { game } from "../session.js";
import { loadableComs } from "../hudPanelSignature.js";

test("T-030: loadableComs reads game.localOwner's own resources, not a hardcoded \"player\"", () => {
  const state = createGameState({ planetId: "ferros", seed: 55, rng: mulberry32(55) });
  const original = game.localOwner;
  try {
    // Give ONLY "ai"'s economy a loadable commodity — "player" stays at its fresh-game baseline
    // (a handful of starting resources, none of them this one).
    state.players.player.resources.crystals = 0;
    state.players.ai.resources.crystals = 500;
    const freighterStub = { freight: {} };

    game.localOwner = "player";
    assert.ok(!loadableComs(state, freighterStub).includes("crystals"), "fixture sanity: \"player\" has none of it");

    game.localOwner = "ai";
    assert.ok(loadableComs(state, freighterStub).includes("crystals"), "must read \"ai\"'s own resources once localOwner is \"ai\", not \"player\"'s");
  } finally { game.localOwner = original; }
});
