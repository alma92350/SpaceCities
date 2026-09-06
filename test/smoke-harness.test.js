/* ============================================================
   Guards for tools/smoke.js's own accounting — the part of the browser smoke test that decides
   whether CI goes green.

   tools/smoke.js is a CI GATE with no tests of its own, which is the one place a defect is worst:
   a gate that fails open reports success and nobody looks again. Everything it does inside the
   browser needs Playwright and belongs in the `browser smoke test` job, but the logic that turns
   a list of checks into an exit code is ordinary pure code, and it is exactly the part whose
   failure is silent.

   Two real fail-open paths are pinned here:

     1. A RUN THAT CHECKED NOTHING. `steps.filter(s => !s.ok).length` is 0 for an empty list, so a
        smoke run whose interaction block was removed, skipped, or never reached would print
        "0/0 checks passed" and exit 0 — a perfectly green gate that tested nothing at all. The
        only way to notice today is for a human to read the count.
     2. A TAUTOLOGICAL CHECK. `check("...", true)` always passes and still increments the
        denominator, so a broken step can be hidden behind a green one that asserts nothing. Two
        of these shipped ("a right-click order is dispatched", "keyboard commands are handled");
        they now assert what the minimap check next to them already asserted properly — that the
        interaction raised no new browser error.

   These are unit tests over the exported helpers, so they cost milliseconds and run in `npm test`
   alongside everything else, while the browser half stays in its own job.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createChecklist, exitCodeFor } from "../tools/smoke.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("a checklist records each step's name, outcome and detail", () => {
  const log = [];
  const list = createChecklist(line => log.push(line));
  list.check("the page loads", true);
  list.check("the sim is running", false, "0:00 → 0:00");
  assert.deepEqual(list.steps.map(s => [s.name, s.ok]), [["the page loads", true], ["the sim is running", false]]);
  assert.equal(log.length, 2, "every check is reported as it happens, so a hang says where it got to");
  assert.match(log[1], /FAIL/);
  assert.match(log[1], /0:00 → 0:00/, "the detail is what makes a failure diagnosable from a CI log alone");
});

test("any failed step fails the run", () => {
  const list = createChecklist(() => {});
  list.check("a", true);
  list.check("b", false);
  list.check("c", true);
  assert.equal(exitCodeFor(list.steps), 1);
});

test("a fully passing run succeeds", () => {
  const list = createChecklist(() => {});
  list.check("a", true);
  assert.equal(exitCodeFor(list.steps), 0);
});

test("FAIL-OPEN: a run that checked nothing must NOT report success", () => {
  // The defect this exists for. `filter(s => !s.ok).length` is 0 for an empty list, so a smoke run
  // that never reached its assertions — the interaction block removed, an early return, a refactor
  // that dropped the calls — printed "0/0 checks passed" and exited 0. A gate that passes when it
  // ran nothing is worse than no gate, because it is reported as evidence.
  assert.equal(exitCodeFor([]), 1, "zero checks is a failed smoke run, not a clean one");
});

test("the two tautological checks are gone from tools/smoke.js", () => {
  // `check(name, true)` always passes and still counts toward the total, so it dilutes the score
  // and can only ever hide a real failure. Neither of the two that shipped needed to be one: the
  // minimap check beside them shows the right form — assert the interaction raised no new error.
  const src = readFileSync(join(root, "tools", "smoke.js"), "utf8");
  const tautologies = [...src.matchAll(/check\(\s*(["'`])(.*?)\1\s*,\s*true\s*[,)]/g)].map(m => m[2]);
  assert.deepEqual(tautologies, [],
    `these smoke checks assert nothing and always pass:\n  ${tautologies.join("\n  ")}`);
});

test("importing tools/smoke.js does not launch a browser", () => {
  // The module has to be import-safe for the tests above to exist at all: it reads process.argv
  // and spawns a server in main(), so it uses the same entry guard as tools/ailab.js. If that
  // guard is ever dropped, `npm test` starts trying to run Playwright.
  const src = readFileSync(join(root, "tools", "smoke.js"), "utf8");
  assert.match(src, /import\.meta\.url/, "smoke.js must guard its CLI entry point");
  assert.doesNotMatch(src, /^main\(\)\.catch/m, "main() must not be invoked at import time");
});
