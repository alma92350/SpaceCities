/* ============================================================
   T-033: server/lobbySnapshot.js — the file-I/O layer over server/lobby.js's own plain,
   JSON-serializable match records (no engine state involved at all here — an "open" match has no
   live simulation yet, see server/lobby.js's own header). Mirrors server/matchSnapshot.js's own
   shape (writeSnapshot async/fire-and-forget-safe, readSnapshot sync/never-throws) for the exact
   same reasons: this file's whole job is "lobby survives a server restart via /data" (T-033's own
   exit criterion), not correctness of the lobby MODEL itself, which test/lobby.test.js already
   covers standalone.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLobby } from "../server/lobby.js";
import { lobbySnapshotPath, writeLobbySnapshot, restoreLobby } from "../server/lobbySnapshot.js";

async function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "spacecities-lobby-snapshot-test-"));
  try { return await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("restoreLobby() returns a fresh, empty lobby when no snapshot file exists yet — first boot", async () => {
  await withTmpDir(dir => {
    const lobby = restoreLobby(dir);
    assert.deepEqual(lobby.listOpenMatches(), []);
  });
});

test("writeLobbySnapshot() then restoreLobby() round-trips every match, exactly as it was — including claimed seats and their real tokens", async () => {
  await withTmpDir(async dir => {
    const lobby = createLobby();
    const match = lobby.createMatch({ planetId: "ferros", seatKinds: ["open", "open"] });
    const joined = lobby.joinMatch(match.id, 0);
    assert.ok(existsSync(lobbySnapshotPath(dir)) === false, "fixture sanity: nothing written yet");

    await writeLobbySnapshot(dir, lobby);
    assert.ok(existsSync(lobbySnapshotPath(dir)));

    const restored = restoreLobby(dir);
    const restoredMatch = restored.getMatch(match.id);
    assert.ok(restoredMatch, "the match itself must still exist after restore");
    assert.equal(restoredMatch.status, "open");
    assert.deepEqual(restoredMatch.seats.map(s => s.kind), ["open", "open"]);
    assert.equal(restoredMatch.seats[0].owner, "player");
    assert.equal(restoredMatch.seats[0].token, joined.token, "the REAL token must survive — a reconnect after a restart depends on it matching exactly");
    assert.equal(restoredMatch.seats[1].owner, null, "an unclaimed seat stays unclaimed");

    // And the restored lobby is a genuinely LIVE, usable one — not just inert data.
    const reclaimed = restored.reclaimSeat(match.id, 0, joined.token);
    assert.equal(reclaimed.ok, true);
  });
});

test("writeLobbySnapshot() overwrites the previous snapshot with the lobby's CURRENT full state, not accumulating history", async () => {
  await withTmpDir(async dir => {
    const lobby = createLobby();
    lobby.createMatch({ planetId: "ferros" });
    await writeLobbySnapshot(dir, lobby);

    lobby.createMatch({ planetId: "ferros" });   // a second match, added after the first write
    await writeLobbySnapshot(dir, lobby);

    const restored = restoreLobby(dir);
    assert.equal(restored.listOpenMatches().length, 2, "the second write must reflect BOTH matches, not just the delta");
  });
});

test("restoreLobby() falls back to a fresh, empty lobby (not a thrown error) on a corrupted snapshot file", async () => {
  await withTmpDir(dir => {
    writeFileSync(lobbySnapshotPath(dir), "{ this is not valid json");
    const lobby = restoreLobby(dir);
    assert.deepEqual(lobby.listOpenMatches(), []);
  });
});

test("restoreLobby() falls back to a fresh, empty lobby on a well-formed file missing its own matches array, without throwing", async () => {
  await withTmpDir(dir => {
    writeFileSync(lobbySnapshotPath(dir), JSON.stringify({ notMatches: [] }));
    const lobby = restoreLobby(dir);
    assert.deepEqual(lobby.listOpenMatches(), []);
  });
});
