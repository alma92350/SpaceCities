/* ============================================================
   A guard on the SUITE. CONTRIBUTING.md's hard rules are only "enforced by the test suite"
   for as long as the tests enforcing them keep existing and keep running — and nothing
   checked either. Delete a guard file and CI stays green with a smaller test count nobody
   reads; rely on implicit test-file discovery and a Node upgrade can quietly change what
   gets run. Both are cheap to pin, so pin them.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, sep } from "node:path";
import { walkJs } from "./_helpers.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("every guard test CONTRIBUTING.md names still exists", () => {
  // CONTRIBUTING.md cites specific files as the executable form of each hard rule ("a change
  // that breaks one fails `npm test` rather than shipping"). If one is renamed or deleted, the
  // doc keeps promising a guarantee that nothing checks any more — worse than never having
  // claimed it. Parsing the names out of the doc means the doc itself stays the source of truth.
  const doc = readFileSync(join(root, "CONTRIBUTING.md"), "utf8");
  const named = [...new Set([...doc.matchAll(/test\/[\w.-]+\.test\.js/g)].map(m => m[0]))].sort();
  assert.ok(named.length >= 6, `expected CONTRIBUTING.md to name several guard tests, found ${named.length}`);
  assert.deepEqual(named.filter(f => !existsSync(join(root, f))), [],
    "CONTRIBUTING.md names guard test file(s) that no longer exist — either restore them or update the doc");
});

test("npm test discovers its files explicitly, not by implicit globbing", () => {
  // `node --test` with no path relies on Node's built-in discovery, which has changed across
  // 18/20/22 — and CI runs a two-version matrix. A shell-expanded `test/*.test.js` makes the set
  // of files run a property of this repo rather than of whichever Node happens to be installed.
  // (A bare directory argument is NOT portable: Node 22 tries to load `test/` as a module.) It
  // also stops `_helpers.js` being spawned as a test file in its own right.
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.match(pkg.scripts.test, /(^|\s)test\//,
    `package.json's test script should name the test files explicitly, got: ${pkg.scripts.test}`);
});

test("every test/slow/ file is still run by SOMETHING — the tier is a schedule, not an exemption", () => {
  // test/ailab.test.js was 196s of a 216s suite: 91% of the wall clock for 3.4% of the tests, which
  // is how a suite stops being run before every commit. Moving it to test/slow/ makes `npm test` a
  // ~20s pre-commit tool again. The DANGER is that the same move is indistinguishable from deleting
  // a guard — this file's own header calls that out ("CI stays green with a smaller test count
  // nobody reads"). So the tier only holds if the slow files stay wired to a script AND that script
  // stays wired to CI. Both are asserted here, by reading the real package.json and workflow rather
  // than trusting the convention.
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const slowDir = join(root, "test", "slow");
  const slowFiles = existsSync(slowDir) ? walkJs(slowDir).filter(f => f.endsWith(".test.js")) : [];
  if (slowFiles.length === 0) return;   // the tier is empty — nothing to keep honest

  assert.match(pkg.scripts["test:slow"] ?? "", /(^|\s)test\/slow\//,
    "test/slow/ has files but package.json has no test:slow script naming them");
  const workflow = readFileSync(join(root, ".github", "workflows", "test.yml"), "utf8");
  assert.match(workflow, /npm run test:(slow|all)/,
    "test/slow/ files run in no CI job — a slow tier nobody runs is a deleted guard with extra steps");
});

test("the DOM test double lives in exactly one place", () => {
  // Eight test files each grew their own `class FakeElement extends EventTarget`, and the parts
  // that differed between them were not considered differences — they were whichever subset of
  // the DOM the file that copied it happened to need. So overlays' copy tracked parents and
  // hudSelection's did not; hud's querySelector walked the tree and update's was hardcoded to
  // null; observer's getBoundingClientRect returned a real 800x600 box and saveload's returned
  // zeros. A test written against a weak copy silently asserts less than the identical test
  // written against a strong one, and nothing in the suite told you which one you had landed on.
  // test/_dom.js is now the single source; this stops the copies growing back.
  //
  // Deliberately NOT flagged: a RECORDING context (test/render.test.js, test/render-roster.test.js,
  // test/landing.test.js) is a different tool — it exists to assert on the draw calls, not to
  // stand in for a browser — so those keep their own.
  const files = walkJs(join(root, "test")).filter(f => f.endsWith(".test.js") && !f.endsWith("suite-integrity.test.js"));
  const offenders = [];
  for (const f of files) {
    // Comments stripped first: several files legitimately QUOTE the idiom while explaining how
    // their own recording variant differs from it (test/render-roster.test.js), and a guard that
    // cannot tell a citation from a declaration would force those explanations out of the code.
    const src = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    const rel = "test/" + f.slice(join(root, "test").length + 1);
    if (/class\s+FakeElement\b/.test(src)) offenders.push(`${rel}: declares its own FakeElement`);
    // The no-op-Proxy 2D context, verbatim. A recording proxy pushes onto a log inside the
    // handler and so never matches this.
    if (/new Proxy\(\{\},\s*\{\s*get:\s*\(t,\s*p\)\s*=>\s*\(p in t \? t\[p\] : \(\) => \{\}\)\s*\}\)/.test(src)) {
      offenders.push(`${rel}: declares its own no-op fakeCtx`);
    }
  }
  assert.deepEqual(offenders, [],
    `import FakeElement / fakeCtx from test/_dom.js instead:\n  ${offenders.join("\n  ")}`);
});

/* ----------
   The fast/slow split, pinned from both ends.

   test/ailab.test.js's sim-driving half was moved to test/slow/ because it took 307s while the
   entire rest of the suite took under 25s. That is a real improvement to the inner loop and a
   real new way for tests to stop running: a directory `npm test` deliberately cannot see is one
   nobody notices going quiet. A slow half that is empty, or that no CI job invokes, passes
   vacuously and looks exactly like a slow half that is green.

   So all three legs are asserted here — the directory has tests in it, a script runs them, and
   CI calls that script — and the two halves are checked to be disjoint but exhaustive, so a new
   test file cannot land in a third place that neither command reaches.
   ---------- */

const slowDir = join(root, "test", "slow");

test("the slow half exists and is not empty — a vacuously-green directory is not a passing suite", () => {
  assert.ok(existsSync(slowDir), "test/slow/ must exist; it holds the long-running bench guards");
  const files = walkJs(slowDir).filter(f => f.endsWith(".test.js"));
  assert.ok(files.length > 0, "test/slow/ exists but contains no test files — the long guards have gone missing");
});

test("npm run test:slow exists and names test/slow explicitly, like npm test does", () => {
  // Same reasoning as the discovery test above: an explicit glob makes the set of files run a
  // property of this repo rather than of whichever Node is installed.
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.ok(pkg.scripts["test:slow"], "package.json needs a test:slow script, or nothing runs test/slow/");
  assert.match(pkg.scripts["test:slow"], /test\/slow\//,
    `test:slow should name the slow directory explicitly, got: ${pkg.scripts["test:slow"]}`);
});

test("CI actually invokes the slow half — a job nobody runs is not a gate", () => {
  // The whole point of moving these tests off the critical path was that they keep running,
  // just not in the inner loop. If the workflow step is ever dropped, the split silently
  // becomes a deletion of 72 tests.
  const wf = readFileSync(join(root, ".github", "workflows", "test.yml"), "utf8");
  assert.match(wf, /npm run test:slow/,
    ".github/workflows/test.yml must run `npm run test:slow` — otherwise test/slow/ is dead weight");
});

test("the two halves are disjoint and exhaustive: every test file is run by exactly one command", () => {
  // `npm test` globs test/*.test.js (one level, so it cannot see test/slow/) and `npm run
  // test:slow` globs test/slow/*.test.js. A file added to test/slow/deeper/ or to some third
  // directory under test/ would be run by neither and would look, from the outside, exactly like
  // a file that passes.
  const all = walkJs(join(root, "test")).filter(f => f.endsWith(".test.js"));
  const orphans = all
    .map(f => "test/" + f.slice(join(root, "test").length + 1).split(sep).join("/"))
    .filter(rel => !/^test\/[^/]+\.test\.js$/.test(rel) && !/^test\/slow\/[^/]+\.test\.js$/.test(rel));
  assert.deepEqual(orphans, [],
    `these test files are run by neither \`npm test\` nor \`npm run test:slow\`:\n  ${orphans.join("\n  ")}`);
});

test("CI invokes the two-browser multiplayer smoke test — a script nobody runs is dead weight", () => {
  // Same reasoning as the slow-suite guard above. tools/smokeMultiplayer.js is the only thing in
  // this repo that exercises host -> share link -> second browser joins -> both in one match, and
  // it found a real crash in every live match on its first run. If its CI step is ever dropped, no
  // failure appears anywhere — the script simply stops being run and multiplayer goes back to
  // being verified by hand, which is how it went unverified in the first place.
  const wf = readFileSync(join(root, ".github", "workflows", "test.yml"), "utf8");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.ok(pkg.scripts["smoke:mp"], "package.json needs a smoke:mp script");
  assert.match(wf, /npm run smoke:mp/,
    ".github/workflows/test.yml must run `npm run smoke:mp`, or the multiplayer smoke test is dead weight");
});
