/* ============================================================
   ADR-0006's chokepoint invariant, enforced by construction rather than convention:
   net/commandCodec.js is the SOLE path from a wire command to engine/commands.js. A future
   server/session.js handler (or any other net/ or server/ module) that starts calling an issue*
   function directly — bypassing the codec's ownership/fog checks — fails this test the moment it
   lands, instead of shipping a silent hole. This is T-021's own exit criterion, literally: "no
   server module calls issue* outside the codec."

   Same import-walking idiom test/engine-purity.test.js already established for a structurally
   identical problem (a forbidden dependency creeping into a set of files that must stay pure).
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, relative } from "node:path";
import { walkJs } from "./_helpers.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SPEC = /(?:import|export)[^"'`]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
const label = f => relative(root, f);

function importsOf(file) {
  const out = [];
  for (const m of readFileSync(file, "utf8").matchAll(SPEC)) {
    const spec = m[1] || m[2];
    if (spec && spec.startsWith(".")) out.push(resolve(dirname(file), spec));
  }
  return out;
}

test("only net/commandCodec.js imports engine/commands.js from anywhere under net/ or server/", () => {
  const commandsJs = resolve(root, "engine/commands.js");
  const codec = resolve(root, "net/commandCodec.js");
  const scanned = [...walkJs(join(root, "net")), ...walkJs(join(root, "server"))];

  const offenders = scanned
    .filter(f => f !== codec)
    .filter(f => importsOf(f).includes(commandsJs))
    .map(label);

  assert.deepEqual(offenders, [],
    "module(s) under net/ or server/ import engine/commands.js directly, bypassing " +
    "net/commandCodec.js's ownership/fog checks:\n" + offenders.join("\n"));
});

test("guard-on-the-guard: net/commandCodec.js really does import engine/commands.js, so the assertion above is not vacuous", () => {
  const commandsJs = resolve(root, "engine/commands.js");
  assert.ok(importsOf(resolve(root, "net/commandCodec.js")).includes(commandsJs));
});
