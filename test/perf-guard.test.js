/* ============================================================
   Two different instruments, because they catch different things.

   1. WALL-CLOCK CATASTROPHE ALARMS. NOT benchmarks — they exist to catch an accidental
   O(n^2)->O(n^3) regression or a per-tick allocation blow-up, with budgets generous
   enough not to flake on a loaded CI runner.

   These two tests lived in test/determinism.test.js until they were split out. The
   problem wasn't the budgets, it was the filing: a slow shared runner tripping a perf
   alarm made the DETERMINISM guard go red, which teaches contributors to rerun a red
   determinism file rather than read it. Timing noise and replay correctness are
   different failure modes and deserve different files.

   2. A WORK COUNTER. The alarms above are ~12x looser than the work they measure
   (200 units x 120 ticks runs in ~680ms against an 8000ms budget), so a 10x
   regression ships green — which is how a broad phase that scanned 13x more area
   than it needed sat at 50% of sim CPU in a codebase this carefully guarded.
   Loosening the budgets isn't the fix: they are that loose ON PURPOSE, because wall
   clock on a shared runner is noisy.

   So the second instrument doesn't measure time at all. It counts the candidates
   engine/grid.js's broad phase visits, which is deterministic, identical on every
   machine, cannot flake, and moves the instant a query box grows. That is the same
   preference for exact counters over proxies the engine already shows with its fog
   and logistics counts.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { createGameState, makeUnit } from "../engine/state.js";
import { neighborQueryStats, resetNeighborQueryStats } from "../engine/grid.js";
import { tick } from "../engine/sim.js";
import { mulberry32 } from "./_helpers.js";

test("perf guard: 200 units for 120 ticks stays well under a generous budget", () => {
  const state = createGameState({ planetId: "ferros", rng: mulberry32(7) });
  for (let i = 0; i < 200; i++) {
    const owner = i % 2 === 0 ? "player" : "ai";
    const type = ["skiff", "bastion", "lancer"][i % 3];
    const u = makeUnit(type, owner, 700 + (i % 20) * 6, 400 + Math.floor(i / 20) * 6);
    u.order = { type: "attack-move", x: 800, y: 500 };
    state.units.set(u.id, u);
  }
  const t0 = performance.now();
  for (let i = 0; i < 120; i++) tick(state, 0.05);
  const elapsed = performance.now() - t0;
  assert.ok(elapsed < 8000, `200-unit sim took ${elapsed.toFixed(0)}ms for 120 ticks (budget 8000ms)`);
});

test("perf guard at scale: ~500 units on a Gigantic map stays under a catastrophe budget", () => {
  // The bigger sibling of the guard above, at the scale where an O(n^2) neighbour
  // scan or a per-tick fog rebuild would actually bite: a 4x map (both fog grids
  // over 16k cells) with ~500 units. Measured ~4.1s for the 300 ticks on a dev box,
  // so the 20s budget allows roughly 5x before it trips.
  const state = createGameState({ planetId: "ferros", rng: mulberry32(11), sizeMult: 4 });
  const base = state.map.bases;
  const types = ["skiff", "bastion", "lancer", "breacher", "worker"];
  for (let i = 0; i < 250; i++) {
    for (const [owner, b] of [["player", base.player], ["ai", base.ai]]) {
      const u = makeUnit(types[i % types.length], owner, b.x + (i % 20) * 14, b.y + Math.floor(i / 20) * 14);
      if (u.type !== "worker") u.order = { type: "attack-move", x: state.map.width / 2, y: state.map.height / 2 };
      state.units.set(u.id, u);
    }
  }
  assert.ok(state.units.size >= 500, "fixture sanity: ~500 units in play");
  const t0 = performance.now();
  for (let i = 0; i < 300; i++) tick(state, 0.05);
  const elapsed = performance.now() - t0;
  assert.ok(elapsed < 20000, `500-unit Gigantic sim took ${elapsed.toFixed(0)}ms for 300 ticks (budget 20000ms)`);
});

// Committed baseline for the work counter below, measured on the fixture in that
// test. Unlike a wall-clock number this is a property of the CODE, not of the
// machine: the same fixture visits the same candidates everywhere.
//
// UPDATING IT IS THE POINT. A diff that moves this number is a diff that changed
// how much the broad phase looks at, and that should be a visible line in review
// with a sentence saying why — a wider query box, a new call site, a bigger cell.
// Moving it to make a red test green, with no such sentence, is the review smell.
// For scale: this fixture made 405,982 queries either way, and the same run
// visited 46,909,263 candidates (115.5 per query) before movement avoidance
// stopped paying the worst-case pad — so the tolerance below is tight enough
// to have caught that 13% as a regression had it gone the other way.
const BROAD_PHASE_BASELINE = 40_644_620;   // candidate visits over the 300-tick run
const BROAD_PHASE_TOLERANCE = 1.10;

test("perf guard: the broad phase visits no more candidates than it used to", () => {
  const state = createGameState({ planetId: "ferros", rng: mulberry32(11), sizeMult: 4 });
  const base = state.map.bases;
  const types = ["skiff", "bastion", "lancer", "breacher", "worker"];
  for (let i = 0; i < 250; i++) {
    for (const [owner, b] of [["player", base.player], ["ai", base.ai]]) {
      const u = makeUnit(types[i % types.length], owner, b.x + (i % 20) * 14, b.y + Math.floor(i / 20) * 14);
      if (u.type !== "worker") u.order = { type: "attack-move", x: state.map.width / 2, y: state.map.height / 2 };
      state.units.set(u.id, u);
    }
  }
  resetNeighborQueryStats();
  for (let i = 0; i < 300; i++) tick(state, 0.05);
  const { queries, candidates } = neighborQueryStats();

  const ratio = candidates / BROAD_PHASE_BASELINE;
  assert.ok(ratio <= BROAD_PHASE_TOLERANCE,
    `the broad phase visited ${candidates.toLocaleString()} candidates over ${queries.toLocaleString()} queries ` +
    `(${(candidates / queries).toFixed(1)} per query) — ${ratio.toFixed(2)}x the committed baseline of ` +
    `${BROAD_PHASE_BASELINE.toLocaleString()}. Something widened a query box or added a call site on the hot path.`);
  // The floor matters too: a big drop means the baseline is stale and the guard
  // has quietly gone slack, which is exactly the failure this test exists to end.
  assert.ok(ratio >= 1 / BROAD_PHASE_TOLERANCE,
    `the broad phase visited ${candidates.toLocaleString()} candidates, only ${ratio.toFixed(2)}x the committed ` +
    `baseline of ${BROAD_PHASE_BASELINE.toLocaleString()} — a real improvement, so re-commit the baseline to lock it in.`);
});
