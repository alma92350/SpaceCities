import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, relative, sep } from "node:path";
import { walkJs } from "./_helpers.js";

// The sim's determinism rests on the engine drawing ALL randomness from the one
// seeded rng (engine/rng.js) and never reading the wall clock. This guard scans
// the engine for the usual nondeterminism leaks so a future edit can't quietly
// reintroduce one — the kind of regression the same-seed-twice test can only
// catch by luck. A line that is genuinely not the sim (an unseeded map default,
// the render loop's wall clock) opts out with a `deterministic-exempt` comment.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const engineDir = join(root, "engine");
const FORBIDDEN = /\bMath\.random\b|\bDate\.now\b|\bnew Date\b|\bperformance\.now\b/;
const SPEC = /(?:import|export)[^"'`]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;

// Extra scan roots: the files under tools/ that the SHIPPED APP actually loads.
//
// tools/ was once purely Node CLI benches, and the scan's "engine/ plus what engine/ imports"
// boundary was exactly right for that. It is not any more. boot.js imports tools/selfplay.js,
// competition.js and competitionWorker.js import tools/duelCore.js and tools/genome.js, and
// playerFingerprint.js imports tools/genome.js — so today three "bench" files run inside a browser
// Worker and decide the outcomes that become persisted Elo ratings. Nothing in engine/ imports
// them, so the fixed-point walk below never reached them: structurally identical code was guarded
// on one side of a directory line and completely unguarded on the other.
//
// Both halves of the guard are the right ones for these files. A Worker has no `document`, so a
// DOM reference is a crash rather than a style violation; and a duel that does not replay
// identically makes every rating derived from it meaningless.
//
// DERIVED, NOT LISTED. Walking out from index.html means a fourth tools/ file pulled into the app
// tomorrow is covered the day it is imported, with no list to remember to update.
function browserReachableToolsFiles() {
  const html = readFileSync(join(root, "index.html"), "utf8");
  const entries = [...html.matchAll(/<script[^>]*type="module"[^>]*src="([^"]+)"/g)].map(m => resolve(root, m[1]));
  // competitionWorker.js is reached by `new Worker(new URL(...))`, not by an import statement, so
  // the walk cannot see that edge — seed it explicitly, exactly as static-integrity.test.js
  // documents for the same file. It is the module that pulls in duelCore/genome for real.
  const workerEntry = join(root, "competitionWorker.js");
  const queue = [...entries, ...(existsSync(workerEntry) ? [workerEntry] : [])];
  const seen = new Set(queue);
  while (queue.length) {
    const file = queue.pop();
    if (!existsSync(file)) continue;
    for (const m of readFileSync(file, "utf8").matchAll(SPEC)) {
      const path = m[1] || m[2] || m[3];
      if (!path || !path.startsWith(".")) continue;
      const abs = resolve(dirname(file), path);
      if (seen.has(abs) || !existsSync(abs)) continue;
      seen.add(abs);
      queue.push(abs);
    }
  }
  return [...seen].filter(f => relative(root, f).startsWith("tools" + sep)).sort();
}

// The purity rules are transitive: the engine's determinism guarantee is only as strong as the
// modules it imports. `data.js` lives at the repo ROOT but is imported by nine engine modules
// (and is the repo's second-most-imported file), so a `Date.now()`-seeded default in a PLANETS
// entry would break same-seed replays while this guard stayed green and determinism.test.js
// failed cryptically, pointing away from the culprit. So: walk engine/ at every depth, then
// follow relative imports out of it to their fixed point. A side benefit — if an engine file
// ever imports a UI module, that module's DOM references fail the scan below, which is exactly
// the right alarm for an engine→view leak.
function purityScanFiles() {
  const files = [...walkJs(engineDir), ...browserReachableToolsFiles()];
  const seen = new Set(files);
  for (let i = 0; i < files.length; i++) {
    const src = readFileSync(files[i], "utf8");
    for (const m of src.matchAll(SPEC)) {
      const path = m[1] || m[2];
      if (!path || !path.startsWith(".")) continue;
      const abs = resolve(dirname(files[i]), path);
      if (!abs.endsWith(".js") || seen.has(abs) || !existsSync(abs)) continue;
      seen.add(abs);
      files.push(abs);
    }
  }
  return files;
}

// Every comparison in this file — the includes() checks, the deepEqual against the literal
// ["tools/duelCore.js", ...] list — goes through here, so normalizing the separator once here fixes
// all of them. node:path yields "tools\genome.js" on Windows, which matches no forward-slash
// literal in this file and failed three of its guards for a reason that has nothing to do with
// engine purity. Posix-style is the right canonical form: it is what the import specifiers in the
// source actually use, and what index.html's src= attributes use.
const label = f => relative(root, f).split(sep).join("/");

test("the purity scan reaches every engine file at any depth, plus what the engine imports", () => {
  // A guard on the guards below. Both scans used a non-recursive readdirSync over engine/ only:
  // a file at engine/net/lockstep.js calling Math.random, Date.now, window.localStorage AND
  // document passed all of them. This pins the file set itself so that can't come back.
  const scanned = purityScanFiles().map(label);
  assert.ok(scanned.includes("engine/sim.js"), "the scan must cover engine/ itself");
  assert.ok(scanned.includes("data.js"),
    "the scan must follow the engine's own imports out of engine/ — data.js is imported by nine engine modules");
  assert.deepEqual(
    walkJs(engineDir).map(label).filter(f => !scanned.includes(f)), [],
    "every .js under engine/, at any depth, must be scanned");
});

test("the scan also covers every tools/ file the shipped app loads, and knows which those are", () => {
  // The guard that keeps the tools/ extension honest in BOTH directions.
  //
  // Downward: these three really are browser code today (boot.js -> selfplay.js; competition.js
  // and competitionWorker.js -> duelCore.js + genome.js; playerFingerprint.js -> genome.js), and a
  // refactor that stops importing one should make this list shrink visibly rather than silently
  // dropping a file out of the purity net while it is still shipping.
  //
  // Upward: the Node-only benches must STAY out. tools/ailab.js imports node:fs and legitimately
  // calls Date.now for wall-clock run timing; sweeping it in would fail the scan for no reason and
  // teach the next contributor that the purity guard cries wolf.
  const reachable = browserReachableToolsFiles().map(label);
  assert.deepEqual(reachable,
    ["tools/duelCore.js", "tools/genome.js", "tools/selfplay.js"],
    "the set of tools/ files the browser loads changed — if that is intended, update this list; " +
    "if not, a Node-only bench has been pulled into the shipped app");

  const scanned = purityScanFiles().map(label);
  for (const f of reachable) assert.ok(scanned.includes(f), `${f} ships to the browser but is not purity-scanned`);
  assert.ok(!scanned.includes("tools/ailab.js"),
    "tools/ailab.js is a Node CLI bench (node:fs, wall-clock timing) and must stay outside the scan");
});

test("engine/ contains no unsanctioned nondeterminism (Math.random / Date / performance.now)", () => {
  const offenders = [];
  for (const file of purityScanFiles()) {
    readFileSync(file, "utf8").split(/\r?\n/).forEach((line, i) => {
      if (FORBIDDEN.test(line) && !line.includes("deterministic-exempt")) {
        offenders.push(`${label(file)}:${i + 1}  ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [],
    "nondeterministic call(s) in engine/ — route randomness through a seeded rng, or mark the line " +
    "`deterministic-exempt` if it genuinely isn't the sim:\n" + offenders.join("\n"));
});

// The engine is meant to be pure logic — no DOM, no browser globals — so the whole sim
// runs headless under `node --test` and could one day run server-side (netcode, replays).
// This guard catches a DOM/browser dependency creeping in (a stray `document.querySelector`,
// a `localStorage` read, a `fetch`). Unlike the determinism guard above it scans CODE ONLY:
// words like "window" (grace window) and "fetch" (fetch a colony ship) appear legitimately in
// prose, so comments are stripped first (newline-preserving, to keep line numbers). The one
// sanctioned browser seam — loop.js's requestAnimationFrame render driver, which touches no sim
// state — opts each line out with a `browser-exempt` marker.
const BROWSER_GLOBAL = /\b(document|window|localStorage|sessionStorage|navigator|XMLHttpRequest|requestAnimationFrame|cancelAnimationFrame|alert|history|location)\b|\bfetch\s*\(/;

// Blank out comments while preserving line count and columns: block comments become spaces
// (newlines kept), line comments are trimmed to end-of-line. Good enough for a source guard —
// engine code never hides a DOM call inside a string literal.
// Splits on /\r?\n/, not "\n". Under a CRLF checkout the trailing "\r" survives a "\n" split and
// makes the `$` in /\/\/.*$/ miss, so NOTHING gets stripped and every prose comment is scanned as
// live code — the word "window" in "the brief banking window" then fails the DOM guard below. That
// is not hypothetical: it produced 7 spurious failures across this file on Windows. .gitattributes
// now pins the checkout to LF, but this guard reads raw bytes off disk and must not silently invert
// its own meaning based on how the tree happened to be cloned.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "))
    .split(/\r?\n/).map(l => l.replace(/\/\/.*$/, "")).join("\n");
}

test("engine/ has no DOM or browser-global dependency (stays headless-pure)", () => {
  const offenders = [];
  for (const file of purityScanFiles()) {
    const raw = readFileSync(file, "utf8").split(/\r?\n/);
    stripComments(raw.join("\n")).split("\n").forEach((code, i) => {
      // Match on the comment-free code, but read the exempt marker off the original line
      // (the marker lives in a comment, which stripping removed).
      if (BROWSER_GLOBAL.test(code) && !raw[i].includes("browser-exempt")) {
        offenders.push(`${label(file)}:${i + 1}  ${raw[i].trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [],
    "browser/DOM reference(s) in engine/ — the engine must stay pure logic (move UI code to a " +
    "non-engine module), or mark a genuine render-loop seam `browser-exempt`:\n" + offenders.join("\n"));
});
