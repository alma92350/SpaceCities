/* ============================================================
   T-061 (Ops): server/log.js — one structured JSON line per operational event, to stdout, the
   convention a container log aggregator (HF Spaces' own included) already understands with zero
   extra tooling. This file's own job is exhaustively simple (one function, no levels, no
   transports) — the real coverage that matters is at each of the four call sites this task wires
   it into (test/matchWorker.test.js).
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { logEvent } from "../server/log.js";

function captureLog(fn) {
  const original = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  try { fn(); } finally { console.log = original; }
  return lines;
}

test("logEvent writes exactly one parseable JSON line per call, carrying the event type and every given field", () => {
  const lines = captureLog(() => logEvent("desync", { matchId: "m1", seat: "player", tick: 5 }));
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.type, "desync");
  assert.equal(parsed.matchId, "m1");
  assert.equal(parsed.seat, "player");
  assert.equal(parsed.tick, 5);
});

test("logEvent stamps a real, current timestamp on every event, not a placeholder", () => {
  const before = Date.now();
  const lines = captureLog(() => logEvent("matchEnded", { matchId: "m1" }));
  const after = Date.now();
  const parsed = JSON.parse(lines[0]);
  assert.ok(Number.isFinite(parsed.t) && parsed.t >= before && parsed.t <= after);
});

test("logEvent works with no extra fields at all — the type and timestamp alone are still a valid event", () => {
  const lines = captureLog(() => logEvent("boot"));
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.type, "boot");
  assert.ok(Number.isFinite(parsed.t));
});

test("logEvent never lets one event's fields leak into another's", () => {
  const lines = captureLog(() => {
    logEvent("seatDisconnected", { matchId: "m1", seat: "player" });
    logEvent("seatReconnected", { matchId: "m1", seat: "ai" });
  });
  assert.equal(lines.length, 2);
  assert.deepEqual(Object.keys(JSON.parse(lines[1])).sort(), ["matchId", "seat", "t", "type"]);
  assert.equal(JSON.parse(lines[1]).seat, "ai");
});
