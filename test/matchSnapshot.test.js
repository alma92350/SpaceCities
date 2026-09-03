/* ============================================================
   T-029a: server/matchSnapshot.js — the file-I/O layer over engine/persist.js's already-proven
   serializeGame/deserializeGame (test/matchLoop.test.js's own exit-criterion test proves the
   ROUND TRIP itself preserves determinism; this file is purely "where does the JSON live on disk
   and how do we get it back", nothing about the engine).

   T-029b adds `matchId` alongside `state`: a snapshot is now `{matchId, save}` on disk, and
   readSnapshot() returns `{matchId, state}` (or null) — the id travels with the state it names so
   restoring a match recovers the SAME identity a reconnecting client can compare against, not just
   the same gameplay data. See server/matchSnapshot.js's own header for why matchId lives HERE
   (server-only, networking-adjacent identity) rather than inside engine/persist.js's own save
   format (single-player-safe, network-agnostic, deliberately unaware of matchId's existence).
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGameState } from "../engine/state.js";
import { mulberry32 } from "../engine/rng.js";
import { snapshotPath, writeSnapshot, readSnapshot } from "../server/matchSnapshot.js";

function makeState(seed = 424242) {
  return createGameState({ planetId: "ferros", seed, rng: mulberry32(seed) });
}

async function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "spacecities-snapshot-test-"));
  try { return await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("readSnapshot() returns null when no snapshot file exists yet — first boot, or a fresh DATA_DIR", async () => {
  await withTmpDir(dir => {
    assert.equal(readSnapshot(dir), null);
  });
});

test("writeSnapshot() then readSnapshot() round-trips a real match state AND its matchId, restoring a state that continues correctly", async () => {
  await withTmpDir(async dir => {
    const state = makeState();
    await writeSnapshot(dir, "match-abc123", state);
    assert.ok(existsSync(snapshotPath(dir)), "the snapshot file must actually exist on disk after writing");

    const restored = readSnapshot(dir);
    assert.ok(restored, "a freshly-written snapshot must read back successfully");
    assert.equal(restored.matchId, "match-abc123");
    assert.equal(restored.state.seed, state.seed);
    assert.equal(restored.state.owners.join(","), state.owners.join(","));
    assert.equal(restored.state.units.size, state.units.size);
  });
});

test("writeSnapshot() overwrites the previous snapshot, not accumulating one file per call", async () => {
  await withTmpDir(async dir => {
    await writeSnapshot(dir, "match-1", makeState(1));
    await writeSnapshot(dir, "match-2", makeState(2));
    const restored = readSnapshot(dir);
    assert.equal(restored.matchId, "match-2", "the SECOND write's matchId must be what a later read sees");
    assert.equal(restored.state.seed, 2, "the SECOND write's state must be what a later read sees");
  });
});

test("readSnapshot() falls back to null (not a thrown error) on a corrupted/unreadable snapshot file — a match must still be able to boot fresh", async () => {
  await withTmpDir(dir => {
    const path = snapshotPath(dir);
    // Deliberately invalid JSON — the shape sanitizeSave()/deserializeGame() would also reject
    // (wrong version, missing fields, etc.) is covered by engine/persist.test.js's own suite;
    // this file's own job is just "don't let ANY failure here crash the worker's boot."
    writeFileSync(path, "{ this is not valid json");
    assert.equal(readSnapshot(dir), null);
  });
});

test("readSnapshot() falls back to null on a well-formed but unsupported save version, without throwing", async () => {
  await withTmpDir(dir => {
    const path = snapshotPath(dir);
    writeFileSync(path, JSON.stringify({ matchId: "match-x", save: { v: 999999, nextEntityId: 1 } }));
    assert.equal(readSnapshot(dir), null);
  });
});

test("readSnapshot() falls back to null when matchId is missing or not a real string, even if the save itself is valid — an unidentifiable match can't prove reconnect continuity", async () => {
  await withTmpDir(async dir => {
    const path = snapshotPath(dir);
    const state = makeState();
    await writeSnapshot(dir, "throwaway", state);
    const onDisk = JSON.parse(readFileSync(path, "utf8"));

    writeFileSync(path, JSON.stringify({ ...onDisk, matchId: undefined }));
    assert.equal(readSnapshot(dir), null, "a missing matchId must be treated as corrupt");

    writeFileSync(path, JSON.stringify({ ...onDisk, matchId: 42 }));
    assert.equal(readSnapshot(dir), null, "a non-string matchId must be treated as corrupt");

    writeFileSync(path, JSON.stringify({ ...onDisk, matchId: "" }));
    assert.equal(readSnapshot(dir), null, "an empty-string matchId must be treated as corrupt");
  });
});

test("readFileSync's own real content round-trips exactly what was written — not a mock, a real file", async () => {
  await withTmpDir(async dir => {
    const state = makeState(777);
    await writeSnapshot(dir, "match-777", state);
    const raw = JSON.parse(readFileSync(snapshotPath(dir), "utf8"));
    assert.equal(raw.matchId, "match-777");
    assert.equal(raw.save.seed, 777);
  });
});
