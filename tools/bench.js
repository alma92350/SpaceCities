/* ============================================================
   BENCH — the committed, re-runnable form of the two throwaway spikes in
   docs/analysis/00-feasibility-spikes.md (ADR-0003, PRD NFR-2/NFR-4). Those spikes settled that
   server-side simulation is affordable — this is what re-runs the same two measurements on
   whatever hardware it's actually run on, so "affordable on the session container" (where the
   spikes were first run) becomes "affordable on the real Hugging Face Space" (TASKS.md T-014)
   instead of staying an assumption.

   FOUR MEASUREMENTS, matching the spike's own method plus its own named follow-ons:
     1. NATURAL MATCHES — tools/selfplay.js drives a real AI-vs-AI game; per-tick wall-clock cost
        is measured as it's actually incurred in play, not synthetically.
     2. STRESS — large armies seeded directly (engine/state.js makeUnit) on a Gigantic (4x) map
        and sent at each other (engine/commands.js issueAttackMove), so combat/pathing/targeting/
        separation are all hot at once — the honest worst case a natural 20-40 unit match would
        flatter.
     3. PROJECTION (T-015) — cost of engine/projection.js's projectFor + JSON.stringify per client
        per tick, on the same in-contact armies STRESS uses. Spike 2 found simulation running
        ~500x faster than real time, which made serialization/filtering — not simulation — the
        real suspect for server cost; this is that follow-on, committed rather than left as a
        one-off spike.
     4. MEMORY PER MATCH — server/session.js createSession N times, measuring heap growth. Neither
        original spike measured this; ADR-0003's "N concurrent matches per box" question needs it
        as much as CPU.

   Deterministic wherever it can be: same seed -> same units, same ticks, same outcome (proven in
   test/bench.test.js) — only the WALL-CLOCK TIMING numbers themselves vary run to run, which is
   the whole point of measuring them fresh rather than trusting the spike's old numbers forever.

   Lives in tools/, like tools/ailab.js and tools/selfplay.js — a dev/ops bench, never imported by
   the shipped client or the (future) match server.
   ============================================================ */

"use strict";

import { cpus } from "node:os";
import { createGameState, makeUnit } from "../engine/state.js";
import { tick } from "../engine/sim.js";
import { issueAttackMove } from "../engine/commands.js";
import { mulberry32 } from "../engine/rng.js";
import { createSelfPlayState, tickSelfPlay, SELFPLAY_DT } from "./selfplay.js";
import { computeDelta } from "../engine/projectionDelta.js";
import { createSession } from "../server/session.js";
import { projectFor } from "../engine/projection.js";

// p99 by nearest-rank on a copy sorted ascending — same simple method the original spike used
// (docs/analysis/00's own tables), good enough for a bench, not a statistics paper.
function percentile(sortedAsc, p) {
  const idx = Math.min(sortedAsc.length - 1, Math.floor(p * sortedAsc.length));
  return sortedAsc[idx];
}

/** @param {number[]} samplesMs @returns {{mean:number, p50:number, p99:number, max:number}} */
export function summarizeTimings(samplesMs) {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const mean = samplesMs.reduce((a, v) => a + v, 0) / samplesMs.length;
  return {
    mean: round(mean), p50: round(percentile(sorted, 0.5)),
    p99: round(percentile(sorted, 0.99)), max: round(sorted[sorted.length - 1]),
  };
}

function round(ms) { return Math.round(ms * 1000) / 1000; }   // 3 decimal places — the spike's own tables use 2-3

/**
 * One natural AI-vs-AI match, timed tick by tick. Runs to victory/timeout (state.over) or
 * `maxSeconds` of SIM time, whichever comes first — same "to victory" framing the original
 * spike's 40-minute row used.
 * @param {{planetId?:string, seed?:number, sizeMult?:number, maxSeconds?:number}} [opts]
 */
export function benchNaturalMatch({ planetId = "ferros", seed = 1, sizeMult, maxSeconds = 2400 } = {}) {
  const state = createSelfPlayState({ planetId, seed, sizeMult });
  const samples = [];
  while (!state.over && state.time < maxSeconds) {
    const t0 = performance.now();
    tickSelfPlay(state, SELFPLAY_DT);
    samples.push(performance.now() - t0);
  }
  return {
    scenario: `${planetId}${sizeMult ? ` ${sizeMult}x` : ""}, seed ${seed}, ${Math.round(maxSeconds / 60)} sim-min cap`,
    ...summarizeTimings(samples), ticks: samples.length, units: state.units.size,
    over: state.over, winner: state.winner ?? null, time: round(state.time),
  };
}

// Two facing lines, `armySize` skiffs each, ALREADY IN CONTACT — a fixed, modest gap between them
// regardless of map size (a Gigantic map's edges are thousands of pixels apart; anchoring armies
// there instead of near the centre makes almost every one of `ticks` a pure march with near-zero
// combat cost, and only the last few ticks after they finally close the distance actually stress
// combat/pathing/targeting/separation — measured, not assumed: an earlier edge-to-edge version of
// this file produced a p50 of 0ms for 400+ unit armies for exactly that reason). Spread across
// rows so units don't all stack on one point (the same reason a real army isn't a single-file
// line); 40-wide rows keep even an 800-unit army's own footprint modest next to the gap.
function seedFacingArmies(state, armySize) {
  const { width: w, height: h } = state.map;
  const rowW = 40, spacing = 22, gap = 260;   // gap comfortably inside a skiff's attack range + a short close
  const cx = w / 2, cy = h / 2;
  const army = (owner, dir) => {
    const units = [];
    for (let i = 0; i < armySize; i++) {
      const row = Math.floor(i / rowW), col = i % rowW;
      const u = makeUnit("skiff", owner, cx + dir * (gap / 2 + row * spacing), cy + (col - rowW / 2) * spacing);
      state.units.set(u.id, u);
      units.push(u);
    }
    return units;
  };
  return { a: army("player", -1), b: army("ai", 1) };
}

/**
 * Two `armySize`-unit armies in contact on a Gigantic map for `ticks` steps — the spike's
 * "honest worst case", combat/pathing/targeting/separation all hot simultaneously.
 * @param {{armySize:number, ticks?:number, seed?:number}} opts
 */
export function benchStress({ armySize, ticks = 1200, seed = 1 }) {
  const state = createGameState({ planetId: "ferros", seed, rng: mulberry32(seed), sizeMult: 4 });
  const { width: w, height: h } = state.map;
  const { a, b } = seedFacingArmies(state, armySize);
  // Attack-move THROUGH the opposing line (well past it, not just to its near edge) so units keep
  // engaging instead of arriving, disengaging once nothing is left in range, and going idle.
  issueAttackMove(a, w / 2 + w * 0.1, h / 2);
  issueAttackMove(b, w / 2 - w * 0.1, h / 2);
  const samples = [];
  for (let i = 0; i < ticks; i++) {
    const t0 = performance.now();
    tick(state, 0.1);
    samples.push(performance.now() - t0);
  }
  const alive = [...state.units.values()].filter(u => u.hp > 0).length;
  return { armySize, ticks, ...summarizeTimings(samples), finalUnitsAlive: alive };
}

/**
 * T-015 — cost of ADR-0009's projectFor per client per tick: the measurement docs/analysis/00
 * flagged as "likely dominant" once Spike 2 found the simulation itself running ~500x faster than
 * real time (so the server spends nearly all its wall clock idle — serialization/filtering, not
 * simulation, is the real cost). Same army-in-contact scenario as benchStress, since fog filtering
 * has to walk every unit/building regardless of whether they're fighting, and combat is what
 * churns the event list projectFor also filters. `warmupTicks` runs before any sample is taken, so
 * the measured ticks reflect a real in-combat state (armies already engaged, events actually
 * flowing) rather than the instant-of-spawn stillness benchStress's own header warns about.
 * @param {{armySize:number, ticks?:number, warmupTicks?:number, seed?:number}} opts
 */
export function benchProjection({ armySize, ticks = 300, warmupTicks = 50, seed = 1 }) {
  const state = createGameState({ planetId: "ferros", seed, rng: mulberry32(seed), sizeMult: 4 });
  const { width: w, height: h } = state.map;
  const { a, b } = seedFacingArmies(state, armySize);
  issueAttackMove(a, w / 2 + w * 0.1, h / 2);
  issueAttackMove(b, w / 2 - w * 0.1, h / 2);
  // Drain events every tick, warmup included — boot.js:807 does the same after every real render
  // frame ("drained and turned into sound"). A real server broadcasts each tick's events once,
  // then clears; without this, state.events grows for the whole bench run instead of holding just
  // the current tick's, and every later JSON.stringify pays to re-serialize the entire match's
  // combat log over and over.
  for (let i = 0; i < warmupTicks; i++) { tick(state, 0.1); state.events.length = 0; }

  const perSeatMs = [];      // one sample per projectFor+stringify call, both seats pooled
  const perTickTotalMs = []; // one sample per tick: BOTH seats' cost summed — what actually competes with the tick budget
  const payloadBytes = [];   // one sample per projectFor+stringify call: a FULL snapshot's own size
  const deltaBytes = [];     // one sample per tick after the first, per seat (T-028b, ADR-0009 M3):
                              // engine/projectionDelta.js's computeDelta against the PREVIOUS tick's
                              // own projection for that seat — the size a connected client actually
                              // receives from tick 2 onward, once net/wsServerTransport.js has a
                              // real baseline to delta against (this loop's own first tick has none,
                              // exactly mirroring a fresh connection's own one-time full push).
  const prevProjBySeat = new Map();
  for (let i = 0; i < ticks; i++) {
    tick(state, 0.1);
    let tickTotal = 0;
    for (const seat of state.owners) {
      const t0 = performance.now();
      const proj = projectFor(state, seat);
      const wire = JSON.stringify(proj);
      const dt = performance.now() - t0;
      perSeatMs.push(dt);
      payloadBytes.push(wire.length);
      tickTotal += dt;

      const prev = prevProjBySeat.get(seat);
      if (prev) deltaBytes.push(JSON.stringify(computeDelta(prev, proj)).length);
      prevProjBySeat.set(seat, proj);
    }
    perTickTotalMs.push(tickTotal);
    state.events.length = 0;
  }
  const alive = [...state.units.values()].filter(u => u.hp > 0).length;
  return {
    armySize, ticks, seats: state.owners.length, finalUnitsAlive: alive,
    perSeat: summarizeTimings(perSeatMs),
    perTickTotal: summarizeTimings(perTickTotalMs),
    payloadBytes: { mean: Math.round(payloadBytes.reduce((a, v) => a + v, 0) / payloadBytes.length), max: Math.max(...payloadBytes) },
    deltaBytes: { mean: Math.round(deltaBytes.reduce((a, v) => a + v, 0) / deltaBytes.length), max: Math.max(...deltaBytes) },
  };
}

/**
 * Heap growth from creating `matchCount` independent sessions (server/session.js), the shape the
 * real match server actually instantiates per match. Forces a GC pass before/after when the
 * process was launched with --expose-gc (not required — `gcForced: false` just means the reading
 * is noisier, not that it's missing).
 * @param {{matchCount?:number}} [opts]
 */
export function benchMemory({ matchCount = 20 } = {}) {
  const gcForced = typeof global.gc === "function";
  if (gcForced) global.gc();
  const before = process.memoryUsage().heapUsed;
  const sessions = [];
  for (let i = 0; i < matchCount; i++) {
    sessions.push(createSession({ planetId: "ferros", seed: i + 1, rng: mulberry32(i + 1) }));
  }
  if (gcForced) global.gc();
  const after = process.memoryUsage().heapUsed;
  const deltaMB = (after - before) / (1024 * 1024);
  return { matchCount, gcForced, totalMB: round(deltaMB), perMatchMB: round(deltaMB / matchCount) };
}

/**
 * The whole scoreboard as one JSON-able object — what /__bench (tools/serve.js) returns verbatim.
 * `quick` shrinks every scenario for a fast smoke run (test/bench.test.js); the real re-run
 * (TASKS.md T-014) calls this with no arguments.
 * @param {{quick?:boolean}} [opts]
 */
export function runBenchSuite({ quick = false } = {}) {
  const natural = quick
    ? [benchNaturalMatch({ seed: 1, maxSeconds: 30 })]
    : [
        benchNaturalMatch({ seed: 1, maxSeconds: 600 }),
        benchNaturalMatch({ seed: 2, maxSeconds: 2400 }),
        benchNaturalMatch({ seed: 3, sizeMult: 4, maxSeconds: 2400 }),
      ];
  const stress = quick
    ? [benchStress({ armySize: 10, ticks: 10 })]
    : [200, 400, 800].map(armySize => benchStress({ armySize }));
  const projection = quick
    ? [benchProjection({ armySize: 10, ticks: 10, warmupTicks: 5 })]
    : [200, 400, 800].map(armySize => benchProjection({ armySize }));
  return {
    node: process.version, cpus: cpus().length, at: new Date().toISOString(),
    natural, stress, projection, memory: benchMemory({ matchCount: quick ? 3 : 20 }),
  };
}
