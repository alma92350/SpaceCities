/* ============================================================
   T-059 (FR-22): a permanent, lightweight record of how a match ENDED — winner, reason, who
   played — independent of server/matchSnapshot.js's own raw engine-state snapshot, which
   deliberately stops being written the instant a match is over (server/matchWorker.js's own
   header: "nothing ticks or pushes again after [over:true]... an ended match's own last snapshot
   before this point is all a restart could ever need to recover"). That snapshot exists to resume
   an INTERRUPTED live match; it says nothing once a match has genuinely finished, and nothing else
   in this codebase records that a match ever happened at all once its worker exits — server/lobby.js's
   own `match.status` only ever moves "open" -> "started", never further.

   Mirrors server/lobbySnapshot.js's own file-I/O contract (write the whole set, restore
   synchronously, never throw on a missing/corrupted file) rather than a growing append-only log —
   this deployment's realistic match volume never makes rewriting the whole file a real cost, and
   reusing the one established `/data` persistence shape beats inventing a second one.

   Factory style matches server/lobby.js's own createLobby(): a `dataDir` of `null`/undefined
   works purely in memory (every existing caller/test that has no dataDir at all), exactly the
   same "standalone unless told to persist" contract that file already has.
   ============================================================ */

"use strict";

import { readFileSync, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/** @param {string} dataDir @returns {string} */
export function matchResultsPath(dataDir) {
  return join(dataDir, "match-results.json");
}

function loadFromDisk(dataDir) {
  const path = matchResultsPath(dataDir);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed.results)) throw new Error("match results file is missing its own results array");
    return parsed.results;
  } catch (err) {
    console.error(`match results at ${path} could not be read, starting with an empty list instead:`, err.message);
    return [];
  }
}

function persistToDisk(dataDir, results) {
  return writeFile(matchResultsPath(dataDir), JSON.stringify({ results })).catch(err => {
    console.error(`match results write failed (${matchResultsPath(dataDir)}):`, err.message);
  });
}

/**
 * @param {string|null} [dataDir] omit (or pass null) for an in-memory-only store — every existing
 *   test and any caller with no `/data` mount at all.
 * @returns {{
 *   record: (result: Object) => void,
 *   list: () => Object[],
 *   has: (matchId: string) => boolean,
 * }}
 */
export function createMatchResultsStore(dataDir) {
  const results = dataDir ? loadFromDisk(dataDir) : [];

  function has(matchId) {
    return results.some(r => r.matchId === matchId);
  }

  // Idempotent per matchId: a match's own final tick pushes one {type:"state", ...} message per
  // owner PLUS one for the spectator, all reflecting the identical over:true outcome — the caller
  // (tools/serve.js) is expected to call record() on every one of them rather than track its own
  // "have I already seen this match end" bookkeeping.
  function record(result) {
    if (has(result.matchId)) return;
    results.push(result);
    if (dataDir) persistToDisk(dataDir, results);
  }

  function list() {
    return [...results];
  }

  return { record, list, has };
}
