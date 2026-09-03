/* ============================================================
   server/matchSnapshot.js — the FILE-I/O layer over engine/persist.js's already-proven
   serializeGameString/deserializeGame (T-029a, ADR-0012, FR-22). This file knows nothing about the
   engine's own state shape or determinism guarantees — only where a match's snapshot lives on disk
   and how to write/read it without ever crashing a boot over it. The round-trip's own correctness
   (a match snapshotted mid-play, restored, and continued reproduces the same outcome as one that
   ran uninterrupted) is engine/persist.js's own property, proven directly in
   test/matchLoop.test.js — this file only has to move the bytes.

   WHY THIS EXISTS AT ALL (ADR-0010's finding, restated in TASKS.md's own T-029a row): every deploy
   restarts the Space and destroys in-memory state. HF's own rolling-swap behavior (measured in
   T-007a) means the real outage a player experiences is the ~21s app-start window, not a whole
   build — so losing a match to every deploy was always the wrong bar; surviving an UNEXPECTED
   restart (a crash, not just a deploy) is the actual target.

   SCOPE, stated up front, not discovered as a gap later: this snapshots `state` only — never
   match.pending (admitted-but-not-yet-due commands), match.log, or match.seenSeq. A command still
   in its INPUT_DELAY_TICKS window (~150ms) at the exact moment of an UNEXPECTED crash can be lost;
   a graceful restart never hits this window at all if the caller drains pending commands first (no
   caller does that yet — there is no graceful-restart path in this project today, only crash
   recovery). This is a deliberately bounded, small risk — not the "whole match" loss this task
   exists to fix — and is not silently accepted: it is named here so a future task that wants
   zero-command-loss durability knows exactly what it would need to add (serializing match.pending
   too, at minimum).

   ONE demo match, ONE fixed filename — no lobby (T-033), no match-id concept yet (T-029b) to key
   multiple snapshots by. The same "simplest thing that proves the mechanism" scope T-026's
   `?seat=` binding and T-027's single demo match already established.
   ============================================================ */

"use strict";

import { readFileSync, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { serializeGameString, deserializeGame } from "../engine/persist.js";

/** @param {string} dataDir @returns {string} */
export function snapshotPath(dataDir) {
  return join(dataDir, "demo-match-snapshot.json");
}

/**
 * Writes `state`'s current snapshot to disk, overwriting any previous one. ASYNC and fire-and-
 * forget-safe on purpose: called from inside a match's own tick loop (server/matchWorker.js), a
 * SYNCHRONOUS write would block that thread's event loop for the write's own duration — stalling
 * the sim's fixed-timestep cadence exactly when a player would feel it as lag. A write that loses
 * a race with a slightly-later one just leaves the more recent state on disk, never corrupts it.
 * @param {string} dataDir @param {State} state @returns {Promise<void>}
 */
export function writeSnapshot(dataDir, state) {
  return writeFile(snapshotPath(dataDir), serializeGameString(state)).catch(err => {
    console.error(`match snapshot write failed (${snapshotPath(dataDir)}):`, err.message);
  });
}

/**
 * Reads back the last snapshot written for this dataDir, or null if there isn't one yet (first
 * boot) or it can't be used (corrupted, or an unsupported save version after an engine upgrade) —
 * NEVER throws. Synchronous: called once, at worker boot, before anything else needs the CPU.
 * @param {string} dataDir @returns {State|null}
 */
export function readSnapshot(dataDir) {
  const path = snapshotPath(dataDir);
  if (!existsSync(path)) return null;
  try {
    return deserializeGame(JSON.parse(readFileSync(path, "utf8")));
  } catch (err) {
    console.error(`match snapshot at ${path} could not be read, starting fresh instead:`, err.message);
    return null;
  }
}
