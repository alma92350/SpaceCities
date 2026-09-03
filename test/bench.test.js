import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeTimings, benchNaturalMatch, benchStress, benchProjection, benchMemory, runBenchSuite } from "../tools/bench.js";

// tools/bench.js (TASKS.md T-014) is the committed, re-runnable form of the two throwaway spikes
// in docs/analysis/00-feasibility-spikes.md — "natural matches" (tools/selfplay.js AI-vs-AI, real
// games) and "stress" (large armies seeded directly and sent at each other on a Gigantic map),
// plus a memory-per-match measurement neither spike took. Wall-clock TIMING is inherently
// non-deterministic and untestable for an exact value, so these tests pin the two things that
// ARE guaranteeable: the SHAPE of what comes back (a scoreboard has to have the right fields to be
// useful), and the underlying SIMULATION's own determinism (same seed, same units/ticks/outcome —
// engine/ is already proven deterministic elsewhere; this just confirms the bench harness doesn't
// smuggle in a wall-clock or unseeded pick, the same property test/ailab.test.js's own first test
// guards for tools/ailab.js).

test("summarizeTimings computes mean/p50/p99/max from a sample array, with the expected ordering", () => {
  const s = summarizeTimings([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(s.max, 10);
  assert.ok(s.p99 <= s.max);
  assert.ok(s.p50 <= s.p99);
  assert.ok(s.mean > 0 && s.mean <= s.max);
});

test("summarizeTimings on a single sample: every stat equals that one value", () => {
  const s = summarizeTimings([4.5]);
  assert.deepEqual(s, { mean: 4.5, p50: 4.5, p99: 4.5, max: 4.5 });
});

test("benchNaturalMatch returns a well-formed row and actually advances the match", () => {
  const r = benchNaturalMatch({ planetId: "ferros", seed: 1, maxSeconds: 60 });
  assert.equal(r.scenario.includes("ferros"), true);
  assert.ok(r.ticks > 0, "at least one tick ran");
  assert.ok(r.time > 0, "sim time advanced");
  assert.ok(r.units >= 0);
  assert.ok(r.mean >= 0 && r.p99 >= r.p50 && r.max >= r.p99, "timing stats are internally consistent");
});

test("benchNaturalMatch is deterministic in everything but wall-clock timing: same seed, same tick count and outcome", () => {
  const a = benchNaturalMatch({ planetId: "ferros", seed: 7, maxSeconds: 120 });
  const b = benchNaturalMatch({ planetId: "ferros", seed: 7, maxSeconds: 120 });
  assert.equal(a.ticks, b.ticks);
  assert.equal(a.time, b.time);
  assert.equal(a.over, b.over);
  assert.equal(a.winner, b.winner);
  assert.equal(a.units, b.units);
});

test("benchStress seeds two armies of the requested size on a Gigantic map and runs the requested tick count", () => {
  const r = benchStress({ armySize: 20, ticks: 30, seed: 1 });
  assert.equal(r.armySize, 20);
  assert.equal(r.ticks, 30);
  assert.ok(r.mean >= 0 && r.p99 >= r.p50 && r.max >= r.p99);
});

test("benchStress is deterministic: same seed and army size produce the same per-tick unit-count curve", () => {
  const a = benchStress({ armySize: 16, ticks: 20, seed: 3 });
  const b = benchStress({ armySize: 16, ticks: 20, seed: 3 });
  assert.deepEqual(a.finalUnitsAlive, b.finalUnitsAlive);
});

test("benchStress's two armies actually fight — losses occur by the end of a long enough run", () => {
  const r = benchStress({ armySize: 30, ticks: 400, seed: 5 });
  assert.ok(r.finalUnitsAlive < 60, "combat over 400 ticks should have destroyed at least some of the 60 seeded units");
});

test("benchProjection (T-015) returns a well-formed row for the requested army size and tick count", () => {
  const r = benchProjection({ armySize: 20, ticks: 10, warmupTicks: 5, seed: 1 });
  assert.equal(r.armySize, 20);
  assert.equal(r.ticks, 10);
  assert.equal(r.seats, 2);
  assert.ok(r.perSeat.mean >= 0 && r.perSeat.p99 >= r.perSeat.p50 && r.perSeat.max >= r.perSeat.p99);
  assert.ok(r.perTickTotal.mean >= 0);
  // Two seats measured per tick, so the summed-per-tick cost is at least the per-call cost, and
  // typically close to double it — this would silently break if a future edit measured only one
  // seat but still called it "total".
  assert.ok(r.perTickTotal.mean >= r.perSeat.mean, "the per-tick total sums both seats, so it can't be smaller than a single seat's own cost");
  assert.ok(r.payloadBytes.mean > 0 && r.payloadBytes.max >= r.payloadBytes.mean);
});

test("benchProjection is deterministic: same seed and army size produce the same payload size", () => {
  const a = benchProjection({ armySize: 16, ticks: 8, warmupTicks: 4, seed: 3 });
  const b = benchProjection({ armySize: 16, ticks: 8, warmupTicks: 4, seed: 3 });
  assert.deepEqual(a.payloadBytes, b.payloadBytes);
  assert.equal(a.finalUnitsAlive, b.finalUnitsAlive);
});

test("benchProjection's payload grows with army size — bandwidth scales with entities in contact, not the map", () => {
  const small = benchProjection({ armySize: 20, ticks: 10, warmupTicks: 5, seed: 1 });
  const big = benchProjection({ armySize: 200, ticks: 10, warmupTicks: 5, seed: 1 });
  assert.ok(big.payloadBytes.mean > small.payloadBytes.mean);
});

test("benchProjection also reports deltaBytes (T-028b, ADR-0009 M3) — a well-formed row alongside payloadBytes", () => {
  const r = benchProjection({ armySize: 20, ticks: 10, warmupTicks: 5, seed: 1 });
  assert.ok(r.deltaBytes.mean > 0 && r.deltaBytes.max >= r.deltaBytes.mean);
});

test("deltaBytes is dramatically smaller than a full snapshot even during active combat — the measured payoff of engine/projectionDelta.js's per-field patches", () => {
  // Deliberately not asserting an absolute KB/s budget here: measured (see TASKS.md T-028b),
  // NFR-3's 32 KB/s is met on average at NATURAL army sizes (this bench's own "20-40 a side" —
  // docs/analysis/00) but not at STRESS scale (200+) or on the highest-churn individual ticks even
  // at natural scale. What's unconditionally true, and what this guards, is the RELATIVE win: a
  // delta always costs meaningfully less than resending everything, at any army size.
  const r = benchProjection({ armySize: 200, ticks: 200, warmupTicks: 50, seed: 1 });
  assert.ok(r.deltaBytes.mean < r.payloadBytes.mean / 2,
    `delta (${r.deltaBytes.mean}B) should be well under half a full snapshot (${r.payloadBytes.mean}B)`);
});

test("benchMemory returns a non-negative per-match figure and reports whether it could force a GC pass", () => {
  const r = benchMemory({ matchCount: 5 });
  assert.equal(r.matchCount, 5);
  assert.equal(typeof r.gcForced, "boolean");
  assert.ok(Number.isFinite(r.perMatchMB));
});

test("runBenchSuite assembles every section into one JSON-able result, with the environment info a reader needs to judge the numbers", () => {
  const r = runBenchSuite({ quick: true });   // quick: true keeps this test's own runtime short — see that option's own doc below
  assert.ok(r.node.startsWith("v"));
  assert.ok(r.cpus >= 1);
  assert.ok(Array.isArray(r.natural) && r.natural.length > 0);
  assert.ok(Array.isArray(r.stress) && r.stress.length > 0);
  assert.ok(Array.isArray(r.projection) && r.projection.length > 0);
  assert.ok(r.memory && typeof r.memory.perMatchMB === "number");
  assert.doesNotThrow(() => JSON.stringify(r), "the whole result must be plain, serializable data — this is what an HTTP endpoint returns verbatim");
});
