/* ============================================================
   The supported Node version, asserted in the three places that must agree.

   package.json said `"node": ">=20"`. That was not true, and had not been since the multiplayer
   work landed: net/wsClientTransport.js and net/wsSpectatorTransport.js both construct a global
   `WebSocket`, which Node only exposes from 22 (Node 20 has it solely behind
   --experimental-websocket). On Node 20 every WebSocket test does not merely fail — it HANGS,
   because a connection that can never open is awaited until the job's own timeout.

   That is exactly what happened to CI. The `tests (node 20)` matrix leg ran for 36 minutes while
   `tests (node 22)` finished the identical suite in 72 seconds, and because the run never
   concluded, the whole gate looked broken rather than pointing at a one-line version claim.

   A version floor is a promise about where this code runs, and it was being kept in three
   independent places — package.json, the Dockerfile that actually ships, and the CI matrix that
   decides what gets tested. Nothing compared them, so they drifted, and the one that was wrong was
   the one nobody executes. This test compares them.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
const workflow = readFileSync(join(root, ".github", "workflows", "test.yml"), "utf8");

const declaredFloor = () => {
  const m = /^>=\s*(\d+)$/.exec(String(pkg.engines?.node ?? "").trim());
  assert.ok(m, `package.json engines.node should read ">=<major>", got: ${pkg.engines?.node}`);
  return Number(m[1]);
};

test("the engines floor is at least 22 — below that the global WebSocket does not exist", () => {
  // Not a style preference: net/wsClientTransport.js's `new WebSocket(url)` is a ReferenceError on
  // Node 20, so every live match, every spectator connection and every agent client is broken
  // there. Claiming support for a runtime the multiplayer code cannot run on is worse than
  // claiming nothing.
  assert.ok(declaredFloor() >= 22,
    `engines.node is ${pkg.engines?.node}, but the global WebSocket needs Node 22+`);
});

test("the Dockerfile ships the version package.json claims to support", () => {
  // The Dockerfile is the only one of the three that is load-bearing in production, so it is the
  // reference the other two answer to.
  const m = /^FROM node:(\d+)/m.exec(dockerfile);
  assert.ok(m, "Dockerfile should pin a node:<major> base image");
  assert.ok(Number(m[1]) >= declaredFloor(),
    `Dockerfile ships node:${m[1]} but package.json claims >=${declaredFloor()}`);
});

test("CI tests every version the floor claims to support, and none it does not", () => {
  // The matrix is the only thing that can actually falsify the claim, so it has to be the claim.
  // A leg for an unsupported version is not free caution: on Node 20 it hangs for the job's full
  // timeout, and a run that never finishes reads as "CI is broken", not "that version is out".
  const m = /node-version:\s*\[([^\]]*)\]/.exec(workflow);
  assert.ok(m, ".github/workflows/test.yml should declare a node-version matrix");
  const matrix = m[1].split(",").map(s => Number(s.trim())).filter(n => !Number.isNaN(n));
  assert.ok(matrix.length > 0, "the matrix must name at least one Node version");
  const floor = declaredFloor();
  assert.deepEqual(matrix.filter(v => v < floor), [],
    `the CI matrix tests Node ${matrix.filter(v => v < floor).join(", ")}, below the declared floor of ${floor}`);
  assert.ok(matrix.includes(floor),
    `the matrix must test the floor itself (${floor}) — that is the version the promise is about`);
});

test("this process is itself running a supported Node — the suite cannot vouch for one it never ran on", () => {
  const major = Number(process.versions.node.split(".")[0]);
  assert.ok(major >= declaredFloor(),
    `running on Node ${process.versions.node}, below the declared floor of >=${declaredFloor()}`);
});
