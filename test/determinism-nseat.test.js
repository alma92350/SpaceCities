import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeUnit } from "../engine/state.js";
import { tick } from "../engine/sim.js";
import { mulberry32, entitySnapshot } from "./_helpers.js";

/* ============================================================
   T-047 (ADR-0008, NFR-8): determinism at N >= 3 seats.

   determinism.test.js and determinism-roster.test.js both prove same-seed replays are
   byte-identical — but every fixture in both files is a 2-seat (player/ai) createGameState.
   ADR-0008's own Phase 2 (T-041/T-044) makes 3+ owners a real, reachable shape (ownerDefs,
   the radial map generator) — this file is the sweep proving the replay guarantee actually
   holds there too, not just on the roster's original two-owner path.

   Two things had to be true before that sweep could mean anything:

   1. entitySnapshot itself had to see every owner, not just the first two. Before this task,
      its `res`/`fog` fields read state.players.player/.ai and state.fog directly — a 3rd or
      4th owner's economy or fog-of-war could diverge between two "identical" runs and the
      fingerprint would never move. test/_helpers.js now maps over state.owners (the
      canonical N-capable roster) for both, byte-identical to the old expression for the
      ["player","ai"] roster every existing 2-seat test still uses — see its own comment.
      The second test below is the guard on THAT guard, the same shape as determinism.test.js's
      own "sensitive to every sim-owned field" test, scoped to the owners beyond the first two.

   2. Real combat has to actually happen on every seat, the same way determinism-roster.test.js's
      own header explains a bare createGameState never reaches it on its own (the player/extra
      seats are inert with no scripted opening). This file uses the identical technique: seed a
      small symmetric army per owner, ordered to attack-move at another seat's base. combat/
      movement resolution (engine/combat.js, engine/movement.js) is per-UNIT, not gated on
      whether that unit's owner has a thinking AI controller — so this reaches real combat,
      wreckage, and id-hashed tie-breaks on every seat even though runAI(state, dt) today
      only ever thinks for the single literal owner "ai" (engine/ai.js). Generalizing that
      dispatch to every isAI-flagged owner is T-048's own "no skirmish-path engine line
      compares an owner to a literal" sweep, not this task's — this file's fixtures are
      designed to prove replay determinism without depending on it.
   ============================================================ */

const OWNER_DEFS = {
  3: [
    { id: "player", faction: "neutral", isAI: false, color: "#4fd1ff" },
    { id: "ai", faction: "neutral", isAI: true, color: "#f87171" },
    { id: "rebels", faction: "neutral", isAI: true, color: "#fbbf24" },
  ],
  4: [
    { id: "player", faction: "neutral", isAI: false, color: "#4fd1ff" },
    { id: "ai", faction: "neutral", isAI: true, color: "#f87171" },
    { id: "rebels", faction: "neutral", isAI: true, color: "#fbbf24" },
    { id: "raiders", faction: "neutral", isAI: true, color: "#a78bfa" },
  ],
};

// One run of an N-seat skirmish: every owner gets a small scripted army ordered to attack-move
// at the NEXT owner's base (a ring — player->ai->rebels[->raiders]->player) so every seat both
// attacks and is attacked, without needing an N^2 pairing.
function runNSeat(n, seed) {
  const ownerDefs = OWNER_DEFS[n];
  const owners = ownerDefs.map(d => d.id);
  // Deliberately NOT endless: true. That flag routes into checkEndlessLoss/checkEndlessWin
  // (engine/victory.js), Odyssey's own single-CC persistent-galaxy terminal checks — and
  // checkEndlessLoss's own loss branch is hardcoded to the literal owner "player", a real
  // 2-seat-only check that ends a 3+ seat match the moment player's home base falls, for a
  // reason that has nothing to do with this file's N-way skirmish victory logic. The plain
  // (non-endless) path runs checkWinCondition — the T-046-generalized, N-owner-generic
  // elimination/surrender/last-seat-standing check this sweep actually means to exercise.
  const s = createGameState({ planetId: "ferros", seed, rng: mulberry32(seed), ownerDefs });
  const bases = s.map.bases;
  for (let idx = 0; idx < owners.length; idx++) {
    const owner = owners[idx];
    const foe = owners[(idx + 1) % owners.length];
    const home = bases[owner], target = bases[foe];
    for (let k = 0; k < 3; k++) {
      const u = makeUnit(["skiff", "bastion", "lancer"][k % 3], owner, home.x + k * 18, home.y);
      u.order = { type: "attack-move", x: target.x, y: target.y };
      s.units.set(u.id, u);
    }
  }
  let sawCombat = false;
  let i = 0;
  for (; i < 1500 && !s.over; i++) {
    tick(s, 0.1);
    if (!sawCombat) sawCombat = [...s.units.values()].some(u => u.order && /^attack/.test(u.order.type));
  }
  return { s, sawCombat, ticks: i };
}

test("same-seed replays are byte-identical at 3 and 4 seats, combat included", () => {
  for (const n of [3, 4]) {
    const a = runNSeat(n, 13579);
    const b = runNSeat(n, 13579);
    assert.equal(a.s.owners.length, n, `fixture sanity: this is really an ${n}-seat match`);
    assert.ok(a.ticks >= 400, `${n}-seat: the run must actually have progressed, not ended instantly`);
    assert.ok(a.sawCombat, `${n}-seat: the sweep must actually reach combat, or it only replays the opening`);
    assert.equal(entitySnapshot(a.s), entitySnapshot(b.s), `${n}-seat: same seed must replay identically`);
  }
});

test("different seeds diverge at 4 seats — the determinism above isn't just a frozen sim", () => {
  const a = entitySnapshot(runNSeat(4, 1).s);
  const b = entitySnapshot(runNSeat(4, 2).s);
  assert.notEqual(a, b, "two different seeds should not produce the same 4-seat world");
});

test("the fingerprint is sensitive to a 3rd/4th owner's economy and fog — the exact blind spot this task closes", () => {
  const ownerDefs = OWNER_DEFS[4];
  const state = createGameState({ planetId: "ferros", seed: 4242, rng: mulberry32(4242), ownerDefs });
  const cases = [
    ["a non-player/ai owner's resources (rebels)", () => { state.players.rebels.resources.metals += 1; }],
    ["a non-player/ai owner's resources (raiders)", () => { state.players.raiders.resources.ore += 1; }],
    ["a non-player/ai owner's fog (rebels)", () => { state.fogs.rebels.explored[0] = (state.fogs.rebels.explored[0] || 0) + 1; }],
    ["a non-player/ai owner's fog (raiders)", () => { state.fogs.raiders.explored[0] = (state.fogs.raiders.explored[0] || 0) + 1; }],
  ];
  for (const [field, mutate] of cases) {
    const before = entitySnapshot(state);
    mutate();
    assert.notEqual(entitySnapshot(state), before, `the fingerprint must see a change to ${field}`);
  }
});
