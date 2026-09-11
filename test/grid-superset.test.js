/* ============================================================
   The broad phase's load-bearing invariant, made mechanical.

   engine/grid.js is a BROAD PHASE: queryNeighbors returns a candidate set that
   every caller re-filters by exact distance. That is only sound if the
   candidate set is a SUPERSET of the true neighbours — a missed candidate is a
   missed interaction, and it would be invisible to every other guard in this
   suite. Determinism can't see it: both runs of a seeded replay would miss the
   same unit identically. Balance can't see it: one unit failing to dodge or to
   acquire once is far under the noise those tests tolerate.

   Two things have to hold for the superset property, and each gets a test:

   1. The box arithmetic covers the requested radius (no off-by-one in the
      floor(), no gap from the cellKey packing).
   2. QUERY_PAD covers how far a unit can actually move between the grid being
      built at the top of tick() and the last query that reads it — the buckets
      hold pre-movement positions, but callers filter against live ones.

   Until now (2), the reason the box was padded at all, lived only in a comment
   in engine/grid.js. It was spelled as a +/-1 ring of cells, which at CELL = 96
   is a 96 px pad for a displacement that measures ~7 px, and the cost of that
   13x over-scan was half the simulation's CPU.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createGameState, makeUnit } from "../engine/state.js";
import { buildUnitGrid, queryNeighbors, PAD_MOVE_PHASE, PAD_FULL_TICK } from "../engine/grid.js";
import { tick } from "../engine/sim.js";
import { MAX_UNIT_RADIUS } from "../engine/movement.js";
import { UNITS } from "../engine/entities.js";
import { FACTIONS } from "../engine/factions.js";
import { PLANET_MODIFIERS } from "../engine/map.js";
import { mulberry32, walkJs } from "./_helpers.js";

const TICK_DT = 0.05;   // the 20 Hz fixed timestep every caller of tick() uses (engine/loop.js)

// The radii the four real call sites ask for, so the sweep covers what the game
// actually queries rather than only round numbers: movement avoidance
// (selfR + MAX_UNIT_RADIUS + AVOID_RANGE), separation (SEP_RADIUS), combat
// acquisition (aggro range) and splash, and Mender repair range.
const REAL_RADII = [2 * MAX_UNIT_RADIUS * 1.2, 40, 60, 90, 140, 220, 400];

function bruteForceWithin(units, x, y, radius) {
  const out = new Set();
  for (const u of units) {
    if (Math.hypot(u.x - x, u.y - y) <= radius) out.add(u);
  }
  return out;
}

// A crowded Gigantic map: two armies attack-moving into each other, plus a
// deliberately dense idle pile (the pathological case separation.js's own
// MAX_SEPARATION_NEIGHBORS cap exists for), so the displacement measured below
// includes separation churn and not just clean movement steps.
function crowdedState(seed) {
  const state = createGameState({ planetId: "ferros", rng: mulberry32(seed), sizeMult: 4 });
  const base = state.map.bases;
  const types = ["skiff", "bastion", "lancer", "breacher", "ranger", "wraith", "worker"];
  for (let i = 0; i < 250; i++) {
    for (const [owner, b] of [["player", base.player], ["ai", base.ai]]) {
      const u = makeUnit(types[i % types.length], owner, b.x + (i % 20) * 14, b.y + Math.floor(i / 20) * 14);
      if (u.type !== "worker") u.order = { type: "attack-move", x: state.map.width / 2, y: state.map.height / 2 };
      state.units.set(u.id, u);
    }
  }
  // The pile: 60 units crammed onto one point, all pushing on each other.
  for (let i = 0; i < 60; i++) {
    const u = makeUnit("skiff", "player", base.player.x + 200 + (i % 3), base.player.y + 200 + (i % 2));
    state.units.set(u.id, u);
  }
  return state;
}

test("broad phase: every engine call site owns its result buffer", () => {
  // The structural half of the _scratch fix. Per-call-site buffers only hold
  // the line if new call sites keep passing one — and the failure mode if one
  // doesn't is silent (two sites aliasing, corrupting a live iteration), so it
  // needs a guard rather than a code-review habit. Static, in the same idiom as
  // test/engine-purity.test.js: read the source, don't run it.
  const offenders = [];
  for (const file of walkJs("engine")) {
    const src = readFileSync(file, "utf8");
    // queryNeighbors(grid, x, y, radius, pad, out) — six arguments, the last
    // being this call site's own buffer. Anything shorter takes the default.
    for (const call of src.match(/queryNeighbors\([^;]*?\)/gs) || []) {
      if (call.split(",").length < 6) offenders.push(`${file}: ${call.replace(/\s+/g, " ")}`);
    }
  }
  assert.deepEqual(offenders, [],
    "these engine call sites fall back to grid.js's shared _scratch buffer — give each its own " +
    "module-level array and pass it as the `out` argument:\n" + offenders.join("\n"));
});

test("broad phase: the query box covers its radius with no help from the pad", () => {
  const state = crowdedState(23);
  for (let i = 0; i < 40; i++) tick(state, 0.05);

  // Rebuild the grid so bucket positions and live positions agree exactly, and
  // query with pad 0: this isolates the box ARITHMETIC (the floor() bounds and
  // the cellKey packing), so a gap there can't hide behind a generous pad.
  const grid = buildUnitGrid(state);
  const units = [...state.units.values()];
  assert.ok(units.length >= 500, `fixture sanity: ${units.length} units in play`);

  let checked = 0;
  for (const u of units) {
    for (const radius of REAL_RADII) {
      const got = new Set(queryNeighbors(grid, u.x, u.y, radius, 0));
      for (const truth of bruteForceWithin(units, u.x, u.y, radius)) {
        assert.ok(got.has(truth),
          `queryNeighbors missed ${truth.type} at (${truth.x.toFixed(1)}, ${truth.y.toFixed(1)}) ` +
          `for a radius-${radius.toFixed(1)} query at (${u.x.toFixed(1)}, ${u.y.toFixed(1)})`);
      }
      checked++;
    }
  }
  assert.ok(checked >= 3500, `fixture sanity: ${checked} queries compared against brute force`);
});

test("broad phase: PAD_MOVE_PHASE covers two units' worth of one movement step", () => {
  // The narrow pad rests on an ANALYTIC bound, so assert the bound itself from
  // the game's own data rather than from a sampled run: stepToward caps a step
  // at speed * speedMult * terrainMult * dt, terrainMult only ever slows a unit,
  // and sideMod composes the map and faction multipliers by multiplying them.
  // If someone adds a faster hull or a bigger speed buff, this fails here — at
  // the constant — instead of silently shrinking the broad phase's margin.
  const fastest = Math.max(...Object.values(UNITS).map(u => u.speed || 0));
  const factionMult = Math.max(1, ...Object.values(FACTIONS).map(f => (f.traits && f.traits.speedMult) || 1));
  const mapMult = Math.max(1, ...Object.values(PLANET_MODIFIERS).flatMap(m => [
    m.speedMult || 1,
    ...Object.values(m.asym || {}).map(a => a.speedMult || 1),
  ]));
  const step = fastest * factionMult * mapMult * TICK_DT;
  const worstPair = 2 * step;   // both units in a pair can have taken one step

  assert.ok(worstPair < PAD_MOVE_PHASE,
    `one movement step is ${step.toFixed(2)}px (${fastest} px/s x ${factionMult} faction x ${mapMult} map x ${TICK_DT}s), ` +
    `so two units can drift ${worstPair.toFixed(2)}px apart — past the ${PAD_MOVE_PHASE}px PAD_MOVE_PHASE, ` +
    `which would make movement avoidance start missing neighbours`);
});

test("broad phase: PAD_FULL_TICK covers a whole tick, separation churn included", () => {
  // Nothing between the top of tick() and buildUnitGrid moves a unit (the AI
  // and scenario passes issue orders, they don't write positions), so the
  // positions here are exactly the ones the grid buckets.
  //
  // Unlike the movement step above, separation pushes have no analytic bound:
  // each is capped at PUSH_SPEED * dt / 2 = 1.5px, but a unit in a dense pile
  // takes many in one pass. So this one is measured, on a fixture built to be
  // as bad as the game plausibly gets, and the margin it reports is the real
  // safety margin of the default pad.
  const state = crowdedState(29);
  let worst = 0, worstType = "";
  for (let i = 0; i < 120; i++) {
    const before = new Map();
    for (const [id, u] of state.units) before.set(id, { x: u.x, y: u.y });
    tick(state, 0.05);
    for (const [id, u] of state.units) {
      const p = before.get(id);
      if (!p) continue;   // spawned mid-tick: not in this tick's grid at all
      const moved = Math.hypot(u.x - p.x, u.y - p.y);
      if (moved > worst) { worst = moved; worstType = u.type; }
    }
  }
  assert.ok(2 * worst < PAD_FULL_TICK,
    `a ${worstType} moved ${worst.toFixed(2)}px in one tick, so a pair can drift ${(2 * worst).toFixed(2)}px — ` +
    `past the ${PAD_FULL_TICK}px PAD_FULL_TICK that keeps the late-tick queries (separation, Mender repair) ` +
    `a superset. Widen the pad, or bound separation churn.`);
});
