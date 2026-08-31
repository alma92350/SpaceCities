/* ============================================================
   /data persistence probe — the empirical answer to "does storage actually survive a restart
   here", rather than trusting documentation describing a feature Hugging Face has since retired
   (docs/analysis/04-hf-deployment.md §4: "the persistent storage feature is no longer available…
   /data is now an attached Storage Bucket volume"). See docs/adr/0012-crash-tolerant-matches.md
   and TASKS.md T-008a.

   The method: every boot writes a small marker (a random boot id + timestamp) into DATA_DIR, and
   first checks whether a marker from a DIFFERENT boot is already sitting there. If one is, this
   disk survived whatever caused the restart — a redeploy, a sleep/wake, a crash. If not, either
   this is genuinely the first boot ever, or storage is ephemeral; those two cases are
   indistinguishable from a single boot, which is why the SECOND deploy is the one that actually
   answers the question.

   Only wired into tools/serve.js when DATA_DIR is set in the environment — i.e. under the Docker
   image (see Dockerfile), never under plain `npm start` for local development.
   ============================================================ */

"use strict";

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MARKER_FILE = ".persistence-probe.json";

// Pure: given whatever marker THIS boot found already on disk (or null), decide whether that
// proves persistence, and what the new marker should say. No I/O, so it's testable with no
// filesystem — same idiom tools/serve.js's resolveSafePath uses (test/serve.test.js).
export function computeProbeResult(previousMarker, bootId, nowIso) {
  const persisted = previousMarker != null
    && typeof previousMarker === "object"
    && typeof previousMarker.bootId === "string"
    && previousMarker.bootId !== bootId;
  return {
    persisted,
    previousMarker: previousMarker ?? null,
    currentMarker: { bootId, writtenAt: nowIso },
  };
}

// Missing, unreadable, and corrupt all degrade to the same "no marker found" outcome — a probe
// that can't prove persistence must never crash the server trying.
export function readPreviousMarker(dataDir) {
  try {
    const parsed = JSON.parse(readFileSync(join(dataDir, MARKER_FILE), "utf8"));
    return (parsed && typeof parsed === "object") ? parsed : null;
  } catch {
    return null;
  }
}

export function writeCurrentMarker(dataDir, marker) {
  writeFileSync(join(dataDir, MARKER_FILE), typeof marker === "string" ? marker : JSON.stringify(marker), "utf8");
}

// The whole probe, run once at boot. `bootId`/`nowIso` are injectable for tests; a real boot lets
// them default. Never throws: an unwritable/missing DATA_DIR is exactly the interesting case this
// exists to surface, so it degrades to `writable: false` with the reason, not a crashed server.
export function runProbe(dataDir, bootId = randomBootId(), nowIso = new Date().toISOString()) {
  const previous = readPreviousMarker(dataDir);
  const result = computeProbeResult(previous, bootId, nowIso);
  try {
    writeCurrentMarker(dataDir, result.currentMarker);
    result.writable = true;
  } catch (e) {
    result.writable = false;
    result.writeError = String(e && e.message || e);
  }
  return result;
}

function randomBootId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
