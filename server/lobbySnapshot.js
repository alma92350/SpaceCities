/* ============================================================
   server/lobbySnapshot.js — the FILE-I/O layer over server/lobby.js's own plain,
   JSON-serializable match records (T-033's own exit criterion: "lobby survives a server restart
   via /data"). Mirrors server/matchSnapshot.js's own shape for the same reasons that file's own
   header already gives: writeLobbySnapshot is async and fire-and-forget-safe (never blocks
   whatever caller triggers it — a periodic timer, once this is actually wired into a server,
   T-034's own job), restoreLobby is synchronous and NEVER throws (a corrupted or missing snapshot
   falls back to a fresh, empty lobby rather than blocking boot — an empty lobby is always a valid,
   safe state to start from; a match a restart happened to lose can simply be re-created).

   UNLIKE server/matchSnapshot.js, there is no engine state to serialize here at all — an "open"
   match (server/lobby.js's own whole scope) has no live simulation yet; createGameState doesn't
   run until a match actually STARTS (T-035's own job). So this file just needs to move lobby.js's
   own already-plain match records to and from disk, with no engine/persist.js sanitization layer
   involved — the closest analog to that gate here is simply "is this valid JSON shaped like
   {matches: [...]}", checked directly below.

   SCOPE: like server/lobby.js itself, this file is standalone and NOT yet wired into
   tools/serve.js — nothing calls writeLobbySnapshot on a timer, and nothing calls restoreLobby at
   boot. That wiring belongs to T-034 (which needs it anyway: a lobby only matters once it's
   reachable from a real browser), the same "build the piece, then wire it" staging T-020/T-021/
   T-023 already established for the wire-command layer.
   ============================================================ */

"use strict";

import { readFileSync, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLobby } from "./lobby.js";

/** @param {string} dataDir @returns {string} */
export function lobbySnapshotPath(dataDir) {
  return join(dataDir, "lobby-snapshot.json");
}

/**
 * Writes the lobby's CURRENT full set of matches to disk, overwriting any previous snapshot —
 * always the whole set, never a delta, so a later write can never leave a stale match behind.
 * @param {string} dataDir @param {ReturnType<import("./lobby.js").createLobby>} lobby
 * @returns {Promise<void>}
 */
export function writeLobbySnapshot(dataDir, lobby) {
  const payload = JSON.stringify({ matches: [...lobby.matches.values()] });
  return writeFile(lobbySnapshotPath(dataDir), payload).catch(err => {
    console.error(`lobby snapshot write failed (${lobbySnapshotPath(dataDir)}):`, err.message);
  });
}

/**
 * Rebuilds a real, ready-to-use lobby (server/lobby.js's own createLobby() shape) from the last
 * snapshot written for this dataDir — or a fresh, empty one if there isn't a usable snapshot at
 * all (first boot, corrupted file, or a well-formed file missing its own `matches` array). NEVER
 * throws: an unusable snapshot is exactly as safe to boot from as no snapshot, since an empty
 * lobby is always valid. Synchronous — called once, at boot, before anything else needs the CPU,
 * the same timing server/matchSnapshot.js's own readSnapshot already established.
 * @param {string} dataDir @returns {ReturnType<import("./lobby.js").createLobby>}
 */
export function restoreLobby(dataDir) {
  const lobby = createLobby();
  const path = lobbySnapshotPath(dataDir);
  if (!existsSync(path)) return lobby;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed.matches)) throw new Error("lobby snapshot is missing its own matches array");
    for (const match of parsed.matches) lobby.matches.set(match.id, match);
    return lobby;
  } catch (err) {
    console.error(`lobby snapshot at ${path} could not be read, starting with an empty lobby instead:`, err.message);
    return createLobby();
  }
}
