/* ============================================================
   T-059 (FR-22): server/matchResults.js — the piece T-029a's own live-match snapshot deliberately
   doesn't cover: a permanent, lightweight record of how a match ENDED (winner, reason, who played),
   independent of the raw engine snapshot matchSnapshot.js stops writing the instant a match is
   over (T-035's own header: "nothing ticks or pushes again after"). Mirrors
   server/lobbySnapshot.js's own file-I/O shape (write the whole set, restore synchronously, never
   throw on a missing/corrupted file) for the same reason: correctness of what a result even means
   lives in engine/victory.js, already tested there — this file's only job is "results survive a
   restart."
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchResultsPath, createMatchResultsStore } from "../server/matchResults.js";

function sampleResult(matchId, overrides = {}) {
  // Matches exactly the fields tools/serve.js's own worker-message listener can actually derive
  // from engine/projection.js's own projectFor output (the only shape it ever sees) — never a
  // richer, invented one this store's own tests shouldn't imply exists.
  return {
    matchId, owners: ["player", "ai"], winner: "player", winReason: "elimination",
    tick: 4200, time: 210.5, endedAt: 1234567890,
    ...overrides,
  };
}

async function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "spacecities-match-results-test-"));
  try { return await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("createMatchResultsStore() with no snapshot file yet starts empty — first boot", async () => {
  await withTmpDir(dir => {
    const store = createMatchResultsStore(dir);
    assert.deepEqual(store.list(), []);
  });
});

test("record() adds a result immediately visible via list()", async () => {
  await withTmpDir(dir => {
    const store = createMatchResultsStore(dir);
    store.record(sampleResult("m1"));
    assert.deepEqual(store.list(), [sampleResult("m1")]);
  });
});

test("record() is idempotent per matchId — a match's own final tick pushes several messages that all reflect the same ended match", async () => {
  await withTmpDir(dir => {
    const store = createMatchResultsStore(dir);
    store.record(sampleResult("m1"));
    store.record(sampleResult("m1"));
    store.record(sampleResult("m1"));
    assert.equal(store.list().length, 1, "the same matchId recorded three times must still be exactly one entry");
  });
});

test("has() reports whether a matchId has already been recorded, without needing the caller to keep its own tracking set", async () => {
  await withTmpDir(dir => {
    const store = createMatchResultsStore(dir);
    assert.equal(store.has("m1"), false);
    store.record(sampleResult("m1"));
    assert.equal(store.has("m1"), true);
  });
});

test("results from different matches accumulate — never overwriting each other, unlike the lobby's own single-set snapshot", async () => {
  await withTmpDir(dir => {
    const store = createMatchResultsStore(dir);
    store.record(sampleResult("m1"));
    store.record(sampleResult("m2", { winner: "ai", winReason: "surrender" }));
    assert.deepEqual(store.list().map(r => r.matchId), ["m1", "m2"]);
  });
});

test("a result persists to disk and survives a fresh store instance — the actual restart proof", async () => {
  await withTmpDir(async dir => {
    assert.equal(existsSync(matchResultsPath(dir)), false, "fixture sanity: nothing written yet");
    const before = createMatchResultsStore(dir);
    // record() returns its own write Promise precisely so a caller that genuinely needs the write
    // to have landed (this test, proving a real restart) can await it — a fixed setImmediate/tick
    // guess is exactly the kind of timing assumption that only holds under light load and breaks
    // under the full suite's own real disk-I/O contention, which is genuinely what surfaced this.
    await before.record(sampleResult("m1"));
    assert.ok(existsSync(matchResultsPath(dir)));

    const after = createMatchResultsStore(dir);
    assert.deepEqual(after.list(), [sampleResult("m1")]);
  });
});

test("a corrupted results file falls back to an empty store, never throws", async () => {
  await withTmpDir(dir => {
    writeFileSync(matchResultsPath(dir), "{ not valid json");
    const store = createMatchResultsStore(dir);
    assert.deepEqual(store.list(), []);
  });
});

test("a well-formed file missing its own results array falls back to empty, without throwing", async () => {
  await withTmpDir(dir => {
    writeFileSync(matchResultsPath(dir), JSON.stringify({ notResults: [] }));
    const store = createMatchResultsStore(dir);
    assert.deepEqual(store.list(), []);
  });
});

test("with no dataDir at all, the store works purely in memory — the same 'standalone, no persistence required' contract createLobby() itself has", () => {
  const store = createMatchResultsStore(null);
  store.record(sampleResult("m1"));
  assert.deepEqual(store.list(), [sampleResult("m1")]);
});
