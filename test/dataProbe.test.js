import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeProbeResult, readPreviousMarker, writeCurrentMarker, runProbe } from "../tools/dataProbe.js";

// computeProbeResult is the pure core (docs/adr/0012-crash-tolerant-matches.md, TASKS.md T-008a):
// given whatever marker THIS boot found on disk (or null), does that prove storage survived a
// restart? It answers that from data alone, so it's tested without touching a filesystem — the
// same idiom test/serve.test.js uses for resolveSafePath.

test("computeProbeResult reports no persistence on a genuinely first boot (no previous marker)", () => {
  const r = computeProbeResult(null, "boot-b", "2026-08-31T00:00:00.000Z");
  assert.equal(r.persisted, false);
  assert.equal(r.previousMarker, null);
  assert.deepEqual(r.currentMarker, { bootId: "boot-b", writtenAt: "2026-08-31T00:00:00.000Z" });
});

test("computeProbeResult reports persistence when a DIFFERENT boot's marker survived", () => {
  const previous = { bootId: "boot-a", writtenAt: "2026-08-30T23:00:00.000Z" };
  const r = computeProbeResult(previous, "boot-b", "2026-08-31T00:00:00.000Z");
  assert.equal(r.persisted, true, "a marker from an earlier boot proves the disk survived the restart");
  assert.deepEqual(r.previousMarker, previous);
});

test("computeProbeResult does not mistake THIS boot's own marker for a survived restart", () => {
  // A caller re-reading the marker this SAME process just wrote (identical bootId) must not
  // register as persistence — that is the same process, not a marker that survived anything.
  const same = { bootId: "boot-b", writtenAt: "2026-08-31T00:00:00.000Z" };
  const r = computeProbeResult(same, "boot-b", "2026-08-31T00:05:00.000Z");
  assert.equal(r.persisted, false);
});

test("computeProbeResult treats a malformed previous marker as no marker at all", () => {
  assert.equal(computeProbeResult({ garbage: true }, "boot-b", "now").persisted, false);
  assert.equal(computeProbeResult({ bootId: 42 }, "boot-b", "now").persisted, false, "bootId must be a string");
  assert.equal(computeProbeResult(undefined, "boot-b", "now").persisted, false);
});

// readPreviousMarker / writeCurrentMarker / runProbe touch a REAL filesystem — a temp directory
// standing in for DATA_DIR — so these are the integration layer around the pure core above.

test("readPreviousMarker returns null when nothing has been written yet", () => {
  const dir = mkdtempSync(join(tmpdir(), "spacecities-probe-"));
  try {
    assert.equal(readPreviousMarker(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readPreviousMarker returns null for a corrupt marker file rather than throwing", () => {
  const dir = mkdtempSync(join(tmpdir(), "spacecities-probe-"));
  try {
    writeCurrentMarker(dir, "not valid json {{{");   // simulate a truncated/corrupt write
    assert.equal(readPreviousMarker(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeCurrentMarker then readPreviousMarker round-trips the marker", () => {
  const dir = mkdtempSync(join(tmpdir(), "spacecities-probe-"));
  try {
    const marker = { bootId: "boot-x", writtenAt: "2026-08-31T00:00:00.000Z" };
    writeCurrentMarker(dir, marker);
    assert.deepEqual(readPreviousMarker(dir), marker);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runProbe: first call in a fresh directory reports not-persisted and leaves a marker behind", () => {
  const dir = mkdtempSync(join(tmpdir(), "spacecities-probe-"));
  try {
    const r = runProbe(dir, "boot-1", "2026-08-31T00:00:00.000Z");
    assert.equal(r.persisted, false);
    assert.equal(r.writable, true);
    assert.deepEqual(readPreviousMarker(dir), { bootId: "boot-1", writtenAt: "2026-08-31T00:00:00.000Z" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runProbe: a second call with a different bootId against the SAME directory reports persisted", () => {
  // This is the actual test T-008a runs against the live Space: boot once, redeploy (a fresh
  // process, fresh bootId), boot again against the same DATA_DIR, and ask whether the first
  // boot's marker was still there to find.
  const dir = mkdtempSync(join(tmpdir(), "spacecities-probe-"));
  try {
    runProbe(dir, "boot-1", "2026-08-31T00:00:00.000Z");
    const r2 = runProbe(dir, "boot-2", "2026-08-31T00:10:00.000Z");
    assert.equal(r2.persisted, true);
    assert.equal(r2.previousMarker.bootId, "boot-1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runProbe reports writable:false rather than throwing when the directory doesn't exist", () => {
  const missing = join(tmpdir(), "spacecities-probe-does-not-exist-" + Date.now());
  const r = runProbe(missing, "boot-1", "2026-08-31T00:00:00.000Z");
  assert.equal(r.writable, false);
  assert.equal(typeof r.writeError, "string");
  // Reading is still attempted and still degrades to "no marker found", not a throw.
  assert.equal(r.persisted, false);
});
