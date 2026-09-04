import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve, relative, sep } from "node:path";
import { walkJs } from "./_helpers.js";

// This project has NO build step — the files in the repo are the files the browser loads. So a
// syntax slip, a mistyped element id, or an import pointing at a moved file isn't caught by a
// compiler; it's a blank white screen the moment someone opens index.html. These are cheap
// static guards that turn each of those silent breakages into a failing test.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Every JS file the app ships, at any depth: the root modules, the engine, and tools/. This used
// to list exactly two directories non-recursively, so anything in a subdirectory escaped the
// parse check and the import check together. (test/ is excluded — `node --test` already parses
// and runs it. docs/ and dot-directories carry no shipped code.)
function shippedJs() {
  return walkJs(root).filter(f => !relative(root, f).startsWith("test" + sep));
}

// The candidate set for the ORPHAN check below: shipped code minus tools/.
//
// The exclusion is about what an unreachable file MEANS, not about what the browser loads — and
// the comment here used to say the latter, which is no longer true: boot.js imports
// tools/selfplay.js, and competition.js / competitionWorker.js / playerFingerprint.js import
// tools/duelCore.js and tools/genome.js, so three tools/ files really do run in the browser today
// (test/engine-purity.test.js derives that same set and purity-scans them for exactly that
// reason). What is still true is that tools/ ALSO holds genuine Node CLI benches — ailab.js,
// selfplay-cli.js, serve.js — which are launched from a shell and are SUPPOSED to be unreachable
// from index.html. Orphan-checking tools/ would therefore report those three as broken every run.
// The browser-reachable ones are covered by the reachability walk anyway, as its own imports.
function browserJs() {
  return shippedJs().filter(f => !relative(root, f).startsWith("tools" + sep));
}

// Every way a module can name another module: `... from "x"`, `import("x")`, and the bare
// SIDE-EFFECT form `import "x"`. That last alternative is load-bearing and was missing: main.js
// reaches starmap.js, techChart.js and update.js only through side-effect imports (they self-wire
// their buttons and hotkeys at module-load time), so a regex without it both misreports them as
// unreachable and would miss a side-effect import left pointing at a deleted file.
const IMPORT_SPEC = /(?:import|export)[^"'`]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;
const specPath = m => m[1] || m[2] || m[3];

test("every shipped .js file parses (no syntax errors reach the browser)", () => {
  const broken = [];
  for (const file of shippedJs()) {
    try {
      execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
    } catch (e) {
      broken.push(`${file.replace(root + "/", "")}: ${String(e.stderr || e.message).split("\n")[0]}`);
    }
  }
  assert.deepEqual(broken, [], "syntax error(s) in shipped JS:\n" + broken.join("\n"));
});

// Assets index.html points at, as (attr, path) pairs. Kept as a function over a STRING rather
// than over the file so the test below can prove it actually reports a miss — pointing a
// resolver at a known-good tree only ever proves it stays quiet.
function htmlAssetRefs(html) {
  return [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map(m => m[1])
    .filter(p => p && !/^(https?:)?\/\//.test(p) && !p.startsWith("data:") && !p.startsWith("#") && !p.startsWith("/"));
}

test("every asset index.html references exists on disk", () => {
  // index.html IS the entry point — there is no build step and no bundler to catch a rename.
  // Verified: changing `src="main.js"` to `src="mian.js"` used to survive the entire suite on
  // both Node versions plus the typecheck, and ship a blank white screen.
  const html = readFileSync(join(root, "index.html"), "utf8");
  const refs = htmlAssetRefs(html);
  assert.ok(refs.includes("main.js") && refs.includes("style.css"),
    "sanity: the resolver should see index.html's own script and stylesheet");
  assert.deepEqual(refs.filter(p => !existsSync(resolve(root, p))), [],
    "index.html references file(s) that don't exist — the page would load broken or blank");

  // And prove the resolver bites, so this test can never quietly become a no-op.
  const typo = htmlAssetRefs('<script type="module" src="mian.js"></script>');
  assert.deepEqual(typo.filter(p => !existsSync(resolve(root, p))), ["mian.js"],
    "the resolver must report a missing asset, not silently skip it");
});

test("every shipped browser module is reachable from index.html's entry point", () => {
  // With no build step, a module nobody imports is not a link error — it's a feature that
  // silently does nothing. This shipped: commit 2a07a69 fixed "Tech & Industry Chart never
  // opening: main.js never imported it", where the 📊 button and the T hotkey did nothing at all
  // and it was found by a human clicking. main.js still carries three side-effect-only imports
  // (starmap, techChart, update) whose whole purpose is reachability, and seven modules attach
  // their listeners at module-load time.
  const html = readFileSync(join(root, "index.html"), "utf8");
  const entries = [...html.matchAll(/<script[^>]*type="module"[^>]*src="([^"]+)"/g)].map(m => resolve(root, m[1]));
  assert.ok(entries.length >= 1, "index.html must declare at least one module entry point");

  const reached = new Set(entries);
  const queue = [...entries];
  while (queue.length) {
    const file = queue.pop();
    if (!existsSync(file)) continue;                       // the test above owns missing-file reporting
    for (const m of readFileSync(file, "utf8").matchAll(IMPORT_SPEC)) {
      const path = specPath(m);
      if (!path || !path.startsWith(".")) continue;
      const abs = resolve(dirname(file), path);
      if (reached.has(abs)) continue;
      reached.add(abs);
      queue.push(abs);
    }
  }

  // engine/types.js is JSDoc typedefs with no runtime code; it says so itself and is never
  // imported by design. tools/ are Node CLI benches, not browser code.
  //
  // elo.js's own TEMPORARY exemption (docs/competitions-and-elo.md Phase 1) is gone: the in-game
  // competition screen landed (setup.js -> competition.js -> elo.js), so it's reached for real now
  // — no need to list it here any more.
  //
  // competitionLedger.js's own TEMPORARY exemption (Phase 2's first stage, which landed the ledger
  // module itself with no UI wiring yet) is gone too, the same way and for the same reason: this
  // stage wired it into the competition screen for real (competition.js -> competitionLedger.js —
  // Quick Duel resolving/committing roster entries, the Roster screen's CRUD + export/import, the
  // Standings screen's standingsFor), so it's reached for real now.
  //
  // pairing.js's own TEMPORARY exemption (Phase 3's first stage, which landed the pairing/
  // scheduling module with no UI wiring yet) is gone as well, on exactly the schedule its comment
  // named: this stage wired it in for real (competition.js -> pairing.js for the Tournament tab's
  // estimate/standings shaping, and competitionWorker.js -> pairing.js for the schedules
  // themselves), so an import chain from index.html reaches it now.
  //
  // competitionWorker.js is a PERMANENT exemption, not a temporary one: it's never reached by a
  // static `import`/`import()`/bare-`import` edge at all. competition.js instantiates it as
  // `new Worker(new URL("./competitionWorker.js", import.meta.url), { type: "module" })` — a
  // browser API call, not an import statement — which is invisible to the regex-based walk above
  // by design (see that walk's own IMPORT_SPEC comment for exactly which syntaxes it recognises).
  // It genuinely does run in the browser (every "Run Duel" click constructs one for real; the live
  // browser verification for this stage confirms it), the walker just has no way to see the edge.
  //
  // net/commandShapes.js and net/transport.js are PERMANENT exemptions, the same class as
  // engine/types.js above: pure JSDoc typedefs with no runtime code, never imported by design —
  // each file's own header comment says so.
  //
  // server/session.js, net/loopback.js, and net/directTransport.js are gone from the exemption
  // list on schedule too: T-010/T-011 landed them ahead of their UI wiring (TEMPORARILY exempt,
  // same "module lands ahead of its UI wiring" pattern elo.js/competitionLedger.js/pairing.js
  // went through, per the comments above), and T-012 is that wiring — boot.js now imports
  // createSession (server/session.js) and createLoopbackTransport (net/loopback.js) directly in
  // startGame/startCompetitionMatch (saveload.js's loadGame/importSave do too, for a resumed
  // skirmish), and createDirectTransport (net/directTransport.js) for every boot path T-012
  // deliberately leaves off a real session (Odyssey, a scenario/raider/bounty, a spectated
  // match) — so an import chain from index.html reaches all three for real now.
  // net/loopbackFaults.js (T-013) is a PERMANENT exemption too, but for a third reason distinct
  // from either class above: it is genuine runtime code (not a typedef file) that IS reached by a
  // real import — just never from index.html. It is test-only infrastructure by design (its own
  // header: it exists to make the promise-resolves-later gap real inside the deterministic unit
  // suite), imported only by test/loopbackFaults.test.js and test/input.test.js. The browser game
  // itself has no use for a transport that deliberately delays and drops its own commands, so
  // unlike server/session.js/net/loopback.js/net/directTransport.js above, there is no future
  // wiring step that will ever remove this line — the same standing reason tools/ailab.js,
  // tools/selfplay-cli.js and tools/serve.js are excluded from this check entirely (browserJs()'s
  // own comment), just for one file that happens to live in net/ instead of tools/.
  //
  // engine/projection.js's own TEMPORARY exemption (T-015) is gone: T-034's lobbyScreen.js wires a
  // real createWsClientTransport() into a real host/join flow (see the wsClientTransport paragraph
  // below), and that file statically imports this one's reassembleProjection to turn every incoming
  // wire push back into a state-shaped object — so an import chain from index.html reaches this file
  // for real now. The ORIGINAL "M1 (server switches to projectFor) is what gives it a real caller"
  // prediction was about the wrong HALF of this file (projectFor is still server-only — called by
  // server/matchWorker.js/net/wsServerTransport.js, both genuinely unreached, see below), but the
  // conclusion — a real caller removes this line — still landed, just via reassembleProjection and
  // one task later than M1's own guess.
  //
  // net/commandEnvelope.js's own prediction here was wrong too, corrected in place rather than
  // silently fixed (the same treatment server/lobby.js/lobbySnapshot.js's own wrong prediction gets
  // further down): it expected server/matchLoop.js becoming reached to be what pulled this file in.
  // matchLoop.js is STILL genuinely unreached (a server-only module — see its own exempt entry
  // below) and stays exempt. What actually happened is more direct and doesn't involve matchLoop.js
  // at all: net/wsClientTransport.js's own submitCommand calls this file's encode() straight from
  // itself to build the wire envelope it sends, and T-034 is what gives wsClientTransport.js — and
  // through it, this file — a real caller (see that paragraph below).
  //
  // server/replay.js is the same pattern layered one file higher: it exists, is tested
  // (test/replay.test.js) and reuses matchLoop.js's own stepMatch rather than reimplementing it,
  // but nothing records or replays a match on any live boot path yet — that's the same
  // real-server milestone (T-026/T-029) that finally calls matchLoop.js for real.
  //
  // net/ws.js (T-025), net/wsServerTransport.js (T-026) and now net/wsWorkerTransport.js plus
  // server/matchWorker.js (T-029) all have a REAL caller — tools/serve.js's createAppServer
  // (T-027, updated in T-029 to spawn a worker and relay through wsWorkerTransport.js instead of
  // attaching directly) actually attaches a live match's WebSocket handling to a real http.Server,
  // verified against the real Docker image, not just this repo's own test coverage. That caller
  // just isn't a BROWSER one: tools/ is this walk's own standing exclusion (browserJs()'s comment —
  // it holds genuine Node CLI/server entry points, launched from a shell, never from index.html),
  // so the edge is real but invisible to this specific check by design, the same way
  // competitionWorker.js's Worker-construction edge is invisible to it for a different syntactic
  // reason (and server/matchWorker.js's OWN construction — `new Worker("server/matchWorker.js",
  // ...)` inside tools/serve.js — is that identical kind of invisible edge, one layer further out).
  // net/wsClientTransport.js's own wait is OVER: T-034 wires a real createWsClientTransport() call
  // into lobbyScreen.js's joinLive (host a match, or join one via a shareable link) — not boot.js
  // ITSELF constructing one, as this paragraph originally expected, but boot.js's own bootState
  // still receives and runs the resulting transport exactly as expected, so the conclusion holds
  // even though the exact call site was one file over (lobbyScreen.js, reached from main.js's own
  // dynamic import, exactly as this walk already treats that edge for every other module reached
  // only that way). An import chain from index.html now reaches this file for real, so this line —
  // and engine/projection.js's/net/commandEnvelope.js's above — all come out together.
  // engine/projectionDelta.js (T-028b) rides along the same way it was always going to: a real,
  // tested dependency of BOTH net/wsServerTransport.js and net/wsClientTransport.js
  // (computeDelta/applyDelta), so it inherits wsClientTransport.js's own newly-real reachability,
  // not a new reason of its own — this line comes out too.
  //
  // server/matchSnapshot.js (T-029a) joins the exemption list one layer deeper still, the exact
  // same way engine/projectionDelta.js does two paragraphs up: its only real caller is
  // server/matchWorker.js (readSnapshot at boot, writeSnapshot on a periodic timer), so it
  // inherits matchWorker.js's own invisible-edge status rather than carrying a reason of its own.
  // Unlike wsClientTransport's own wait, there is no future boot.js wiring step that will ever
  // remove this line — matchWorker.js is a Node worker_threads entry point, never something a
  // browser import chain could reach even once every other multiplayer feature lands.
  //
  // server/lobby.js and server/lobbySnapshot.js: T-033's own comment here predicted these would
  // come out of the exemption list once tools/serve.js's boot path called createLobby/restoreLobby
  // for real — T-034 is that wiring (createAppServer's own lobby, liveMatches, and the three
  // /api/matches endpoints), but the prediction was wrong, corrected here rather than silently
  // fixed: tools/ is this walk's own standing exclusion (browserJs()'s comment), so a real caller
  // that lives ONLY in tools/serve.js is exactly as invisible to this check as net/ws.js's,
  // net/wsWorkerTransport.js's and server/matchWorker.js's own real callers already are two
  // paragraphs up — none of those came out on that same logic either. Both lines are PERMANENT
  // exemptions now, the same class as server/matchSnapshot.js just above: real, tested, correctly
  // wired code whose only path from index.html runs through a Node CLI/server entry point, never a
  // browser import.
  const EXEMPT = new Set([
    "engine/types.js", "competitionWorker.js",
    "net/commandShapes.js", "net/transport.js",
    "net/loopbackFaults.js",
    "server/matchLoop.js", "server/replay.js", "net/ws.js",
    "net/wsServerTransport.js",
    "net/wsWorkerTransport.js", "server/matchWorker.js", "server/matchSnapshot.js",
    "server/lobby.js", "server/lobbySnapshot.js",
    // T-039: net/abuseGuard.js's only real caller is net/wsWorkerTransport.js itself (the general
    // per-connection rate gate conn.onmessage runs on every inbound message) — it inherits THAT
    // file's own invisible-edge status rather than carrying a reason of its own, the same class as
    // engine/projectionDelta.js/server/matchSnapshot.js above. Unlike net/chatLimiter.js (T-038),
    // which came OUT of this list once chat.js (a real browser module) started importing its
    // MAX_CHAT_LEN for the client-side optimistic length cap, nothing client-side ever needs
    // abuseGuard.js's own exports — deciding whether to throttle or disconnect a connection is
    // inherently a server-side question — so this one has no equivalent future exit.
    "net/abuseGuard.js",
    // T-049: net/mcp.js's only real caller is tools/serve.js's createAppServer (the /mcp route),
    // the exact same class as net/ws.js/net/wsWorkerTransport.js/server/lobby.js above — a real,
    // tested dependency whose only path from index.html runs through a Node server entry point,
    // never a browser import. An MCP agent client is a server-to-server peer, never something a
    // browser tab loads, so unlike net/chatLimiter.js's own past exit there is no future wiring
    // step that would ever make this reachable from index.html.
    "net/mcp.js",
    // T-049a: server/mcpSeatHandle.js's only real callers are the MCP TOOLS that will use
    // withSeat (T-051/T-052/T-053) — themselves server-side, same as net/mcp.js just above.
    "server/mcpSeatHandle.js",
    // T-051: server/mcpLobbyTools.js's only real caller is tools/serve.js's own mcpServer
    // construction — same class as net/mcp.js/server/mcpSeatHandle.js just above.
    "server/mcpLobbyTools.js",
    // T-052: server/mcpObservationTools.js/server/mcpObservationCache.js — same class again,
    // both only ever reached from tools/serve.js's own mcpServer/spawnWorkerFor wiring.
    "server/mcpObservationTools.js",
    "server/mcpObservationCache.js",
    // T-053: server/mcpActionTools.js/server/mcpCommandBridge.js — same class again.
    "server/mcpActionTools.js",
    "server/mcpCommandBridge.js",
  ]);
  const orphans = browserJs()
    .map(f => relative(root, f))
    .filter(f => !EXEMPT.has(f) && !reached.has(join(root, f)));
  assert.deepEqual(orphans, [],
    "shipped module(s) no import chain reaches from index.html — their code never runs in the browser:\n" +
    orphans.join("\n"));
});

test("every getElementById reference resolves to a real element id", () => {
  const html = readFileSync(join(root, "index.html"), "utf8");
  const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));

  // Some elements are built at runtime (e.g. the update banner) rather than living in index.html;
  // a JS `el.id = "foo"` assignment is a legitimate source of an id too. Allow those.
  const dynamicIds = new Set();
  const jsFiles = shippedJs();
  for (const f of jsFiles)
    for (const m of readFileSync(f, "utf8").matchAll(/\.id\s*=\s*["']([^"']+)["']/g)) dynamicIds.add(m[1]);

  const dangling = [];
  for (const f of jsFiles) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/getElementById\(["']([^"']+)["']\)/g)) {
      const id = m[1];
      if (!htmlIds.has(id) && !dynamicIds.has(id)) dangling.push(`${f.replace(root + "/", "")} → #${id}`);
    }
  }
  assert.deepEqual(dangling, [],
    "getElementById targets that exist in no HTML and are never created in JS (typo or removed element):\n" +
    dangling.join("\n"));
});

test("every relative import points at a file that exists", () => {
  const missing = [];
  for (const f of shippedJs()) {
    const src = readFileSync(f, "utf8");
    const dir = dirname(f);
    for (const m of src.matchAll(IMPORT_SPEC)) {
      const path = specPath(m);
      if (!path || !path.startsWith(".")) continue;    // bare/absolute specifiers aren't ours to resolve
      if (!existsSync(resolve(dir, path)))
        missing.push(`${f.replace(root + "/", "")} → ${path}`);
    }
  }
  assert.deepEqual(missing, [], "import(s) pointing at a file that no longer exists:\n" + missing.join("\n"));
});

// Regression guard for a real bug: data.js and engine/factions.js used to BOTH export a
// binding named `FACTIONS` (different shapes — lore/UI flavor vs. real gameplay traits), and
// coexisted only because every importer happened to grab the right one. data.js's export was
// renamed to LORE_FACTIONS so the two names can never again be confused for one another at an
// import site.
test("data.js's lore-flavor faction data has its own name — no duplicate FACTIONS export shared with engine/factions.js", () => {
  const dataSrc = readFileSync(join(root, "data.js"), "utf8");
  assert.match(dataSrc, /export const LORE_FACTIONS\s*=/,
    "data.js should export LORE_FACTIONS (its lore/UI faction flavor data: name/ico/color/desc)");
  assert.doesNotMatch(dataSrc, /export const FACTIONS\s*=/,
    "data.js must not export a FACTIONS binding — engine/factions.js already owns that name for the real playable-faction gameplay data");

  // No shipped file may import a `FACTIONS` binding FROM data.js (only LORE_FACTIONS); a bare
  // `FACTIONS` import is only valid from engine/factions.js.
  const offenders = [];
  for (const f of shippedJs()) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']*\bdata\.js)["']/g)) {
      if (/\bFACTIONS\b/.test(m[1])) offenders.push(`${f.replace(root + "/", "")} imports { FACTIONS } from ${m[2]}`);
    }
  }
  assert.deepEqual(offenders, [], "stale import of data.js's old FACTIONS name (should be LORE_FACTIONS):\n" + offenders.join("\n"));
});

// Regression guard: boot.js used to keep its own hand-maintained easy/medium/hard -> {aiApm,
// aiMicro} map, entirely separate from the list driving the Easy/Medium/Hard picker. If the two
// ever drifted — a difficulty key added to one list but not the other —
// `DIFFICULTY[setup.difficulty] || DIFFICULTY.medium` silently downgraded an unrecognised
// difficulty to Medium instead of erroring. engine/aiDifficulty.js's DIFFICULTY_OPTIONS is the
// one list carrying the AI dials (and, going forward, any economic difficulty fields) — setup.js
// imports it for the picker rather than keeping its own copy, and boot.js derives from it too.
test("engine/aiDifficulty.js's DIFFICULTY_OPTIONS is the single source of every difficulty's AI dials; setup.js and boot.js derive from it", () => {
  const difficultySrc = readFileSync(join(root, "engine", "aiDifficulty.js"), "utf8");
  const setupSrc = readFileSync(join(root, "setup.js"), "utf8");
  const bootSrc = readFileSync(join(root, "boot.js"), "utf8");

  const optionsBlock = difficultySrc.match(/export const DIFFICULTY_OPTIONS\s*=\s*\[([\s\S]*?)\n\];/);
  assert.ok(optionsBlock, "engine/aiDifficulty.js must export DIFFICULTY_OPTIONS");
  const entries = [...optionsBlock[1].matchAll(/\{([^}]*)\}/g)].map(m => m[1]);
  assert.ok(entries.length >= 3, "expected at least the three Easy/Medium/Hard entries");
  for (const entry of entries) {
    assert.match(entry, /mult:\s*"[a-z]+"/, `difficulty option missing its key: ${entry}`);
    assert.match(entry, /aiApm:\s*\d+/, `difficulty option missing its aiApm dial (must live in the canonical list): ${entry}`);
    assert.match(entry, /aiMicro:\s*(true|false)/, `difficulty option missing its aiMicro dial (must live in the canonical list): ${entry}`);
  }

  assert.doesNotMatch(setupSrc, /export const DIFFICULTY_OPTIONS\s*=\s*\[/,
    "setup.js must not keep its own copy of DIFFICULTY_OPTIONS — that duplication is exactly the drift this guards against");
  assert.match(setupSrc, /import\s*\{[^}]*\bDIFFICULTY_OPTIONS\b[^}]*\}\s*from\s*["']\.\/engine\/aiDifficulty\.js["']/,
    "setup.js should import DIFFICULTY_OPTIONS from engine/aiDifficulty.js");
  assert.match(bootSrc, /import\s*\{[^}]*\bDIFFICULTY_OPTIONS\b[^}]*\}\s*from\s*["']\.\/setup\.js["']/,
    "boot.js should import DIFFICULTY_OPTIONS from setup.js rather than hardcoding its own difficulty list");
  assert.doesNotMatch(bootSrc, /easy:\s*\{\s*aiApm/,
    "boot.js must not keep its own separate easy/medium/hard -> {aiApm,aiMicro} map (that duplication is exactly the drift this guards against)");
});

// Regression guard: boot.js used to copy-paste the exact seed-resolution expression
// `(setup.seed != null ? setup.seed : Math.floor(Math.random()*0x100000000)) >>> 0` at five
// separate call sites (startGame, startScenario, startRaider, startBounty, startOdyssey) — one
// fix to the replay-determinism logic could easily miss the other four. It's now a single
// named helper (resolveSeed) called from all five.
test("boot.js resolves the seed through one shared helper, not copy-pasted at every call site", () => {
  const bootSrc = readFileSync(join(root, "boot.js"), "utf8");
  const rawExpr = "Math.floor(Math.random() * 0x100000000)) >>> 0";
  const rawOccurrences = bootSrc.split(rawExpr).length - 1;
  assert.equal(rawOccurrences, 1,
    `the seed-resolution expression should appear exactly once now (inside its helper), found ${rawOccurrences} — it must not be copy-pasted at call sites again`);

  const helperCalls = [...bootSrc.matchAll(/\bresolveSeed\(setup\)/g)].length;
  assert.ok(helperCalls >= 5,
    `expected resolveSeed(setup) to be called at every start* site (>=5: skirmish, escort, raider, bounty, Odyssey), found ${helperCalls}`);
});

test("every shipped UI module imports cleanly under Node with no DOM (C10)", () => {
  // CONTRIBUTING.md: "UI modules should stay import-safe under Node (guard top-level
  // window/document access), so their logic can be unit-tested. dom.js already resolves `document`
  // defensively; follow that pattern." Eight of eleven root UI modules threw, and the pattern was
  // inconsistent WITHIN files — boot.js guards one addEventListener and not the one twenty lines
  // above it. Nothing caught it because all thirteen DOM test files install globalThis.document
  // BEFORE importing, which papers over the violation permanently.
  //
  // Each module is spawned in its OWN child process: a sibling test file's stub, or an earlier
  // module in this loop, would otherwise mask the very failure being checked.
  const broken = [];
  for (const file of browserJs()) {
    const rel = relative(root, file);
    if (rel.startsWith("engine" + sep)) continue;          // the engine is DOM-free by its own guard
    // server/matchWorker.js (T-029) is a worker_threads ENTRY POINT, not a UI module this check's
    // own remedy ("guard the top-level access") can fix: it reads workerData/parentPort at module
    // top level by necessity — that IS its whole job, the moment it's loaded as a real Worker — so
    // there is no DOM-less-but-still-plain-Node import path for it to guard toward. Importing it
    // directly (as this check does, on every OTHER file) is simply the wrong way to run it, not a
    // bug in it; test/matchWorker.test.js exercises it for real, inside an actual Worker.
    if (rel === join("server", "matchWorker.js")) continue;
    try {
      execFileSync(process.execPath, ["--input-type=module", "-e", `import(${JSON.stringify(pathToFileURL(file).href)})`],
        { stdio: "pipe", timeout: 20000 });
    } catch (e) {
      broken.push(`${rel}: ${String(e.stderr || e.message).split("\n").find(l => /Error/.test(l)) || "failed"}`);
    }
  }
  assert.deepEqual(broken, [],
    "UI module(s) that throw when imported without a DOM — guard the top-level element access the way " +
    "dom.js does:\n" + broken.join("\n"));
});

test("no helper is defined more than once under engine/ (T2)", () => {
  // Five byte-identical function bodies used to span module boundaries. The two that actually bit
  // are fixed and shared now (clamp, negate); this keeps them from re-forking. costText and
  // parseArgs are deliberately left alone — a one-line UI formatter, and two standalone CLI tools
  // where independence is a feature.
  const dupes = [];
  for (const name of ["clamp", "negate", "radiusOf", "hasCompletedBuilding"]) {
    const sites = walkJs(join(root, "engine"))
      .filter(f => new RegExp(`^(export )?function ${name}\\(`, "m").test(readFileSync(f, "utf8")))
      .map(f => relative(root, f));
    if (sites.length > 1) dupes.push(`${name}: ${sites.join(", ")}`);
  }
  assert.deepEqual(dupes, [], "helper(s) defined in more than one engine module:\n" + dupes.join("\n"));
});

test("the shipped module graph has no import cycle outside the known UI cluster (T2)", () => {
  // Tarjan over the real import graph. The one cycle is benign TODAY only because every back-edge
  // is called at runtime rather than at module-evaluation time — an invariant documented in exactly
  // one inline comment (overlays.js) and enforced nowhere. Adding a top-level
  // `const X = someImportedFn()` to any member throws a TDZ ReferenceError during evaluation, which
  // in a no-build-step ES-module page is a blank white screen. Node's test import order differs from
  // the browser's, so the existing suites protect against that only by coincidence. This freezes the
  // cycle at its current membership: a seventh member, or any NEW cycle (especially inside engine/),
  // fails the suite.
  const files = browserJs();
  const idx = new Map(files.map((f, i) => [f, i]));
  const adj = files.map(f => {
    const out = [];
    for (const m of readFileSync(f, "utf8").matchAll(IMPORT_SPEC)) {
      const p = specPath(m);
      if (!p || !p.startsWith(".")) continue;
      const abs = resolve(dirname(f), p);
      if (idx.has(abs)) out.push(idx.get(abs));
    }
    return out;
  });

  // Iterative Tarjan (the graph is small, but recursion depth is not worth risking).
  const N = files.length;
  const index = new Array(N).fill(-1), low = new Array(N).fill(0), onStack = new Array(N).fill(false);
  const stack = [], sccs = [];
  let counter = 0;
  for (let s0 = 0; s0 < N; s0++) {
    if (index[s0] !== -1) continue;
    const work = [[s0, 0]];
    while (work.length) {
      const frame = work[work.length - 1];
      const [v, pi] = frame;
      if (pi === 0) { index[v] = low[v] = counter++; stack.push(v); onStack[v] = true; }
      let recursed = false;
      for (let i = pi; i < adj[v].length; i++) {
        const w = adj[v][i];
        if (index[w] === -1) { frame[1] = i + 1; work.push([w, 0]); recursed = true; break; }
        if (onStack[w]) low[v] = Math.min(low[v], index[w]);
      }
      if (recursed) continue;
      if (low[v] === index[v]) {
        const comp = [];
        for (;;) { const w = stack.pop(); onStack[w] = false; comp.push(relative(root, files[w])); if (w === v) break; }
        if (comp.length > 1) sccs.push(comp.sort());
      }
      work.pop();
      if (work.length) { const p = work[work.length - 1][0]; low[p] = Math.min(low[p], low[v]); }
    }
  }

  // competition.js joined this cluster in docs/competitions-and-elo.md's Phase 1 (the in-game
  // Quick Duel screen): setup.js delegates its whole rendering to competition.js's
  // renderCompetition() (a `setup.mode === "competition"` branch in renderMapSelect(), the same
  // shape as the existing `if (odyssey)` branch), and competition.js reuses setup.js's own
  // STRATEGY_OPTIONS/optionGroup/MAP_CHOICES rather than redefining them — CONTRIBUTING.md's own
  // "prefer a small pure helper in the right module" over a duplicate copy. Both edges are real
  // and intentional, so this is a deliberate 7th member of the SAME cycle, not a new one — same
  // "called at runtime, not at module-evaluation time" invariant as the other six (see
  // competition.js's own header for the TDZ hazard this would otherwise create, and how its
  // `compConfig.worlds` default is deferred specifically to avoid it).
  // lobbyScreen.js (T-034) joins as an 8th member, the same "called at runtime, not at
  // module-evaluation time" invariant as every other member: setup.js's own new Multiplayer button
  // reaches it through a DYNAMIC import(), never a static one, specifically so setup.js doesn't pay
  // a TDZ hazard for a module it only needs after a real click — but this test's own IMPORT_SPEC
  // regex (its header comment: "SIDE-EFFECT form... was missing") matches a dynamic import() edge
  // exactly like a static one, so the edge is real to Tarjan even though it never fires at eval
  // time. The back-edge closing the cycle is lobbyScreen.js's own (static) import of setup.js's
  // renderMapSelect/MAP_CHOICES/SIZE_OPTIONS/RESOURCE_OPTIONS/MATCH_LENGTH_OPTIONS and boot.js's
  // bootState — reused rather than redefined, the same CONTRIBUTING.md reason competition.js's own
  // paragraph above already gives, and every one of those calls also lives inside a function
  // (renderLobbyScreen/joinLive), never at this file's own module-evaluation time either.
  const KNOWN = ["boot.js", "competition.js", "hud.js", "hudSelection.js", "lobbyScreen.js", "overlays.js", "saveload.js", "setup.js"];
  assert.deepEqual(sccs.map(c => c.join(" ")), [KNOWN.join(" ")],
    "import cycle(s) other than the documented UI cluster (see overlays.js's note on live bindings):\n" +
    sccs.map(c => c.join(", ")).join("\n"));
});

test("no shipped module imports a name it never uses", () => {
  // hudSelection.js was importing twenty symbols it never referenced — repairBtn, departBtn,
  // saveBtn, pauseBtn, starmapBtn, resourcesEl, clockEl, scenarioStatusEl and more — leftovers
  // from code that moved to hud.js. A dead import is not merely tidy-up: it advertises a
  // dependency that doesn't exist, so anyone reading the file's import block to learn what it
  // couples to is misled, and the module-reachability guard above counts an edge nothing walks.
  // With no check, the list only ever grows, because removing an import is exactly the step a
  // hurried refactor skips.
  //
  // Deliberately textual, not a real parse: a name is "used" if it appears anywhere in the file
  // outside the import block. That can only ever UNDER-report (a name mentioned in a comment
  // counts as used), which is the right direction for a guard nobody should have to argue with.
  // Whole import STATEMENTS are stripped, and what is left is the body. An earlier cut tried to
  // find where the import block ENDS by walking lines — and every file here opens with a prose
  // header comment, so the walk broke out on the first sentence containing a bracket, left the
  // imports themselves inside the "body", and found every name trivially "used". The guard passed
  // on a file with twenty dead imports. Stripping the statements has no boundary to get wrong.
  const STATEMENT = /^import\s[\s\S]*?from\s*["'][^"']+["'];?|^import\s*["'][^"']+["'];?/gm;
  const NAMED = /import\s*\{([^}]*)\}\s*from\s*["'][^"']+["']/g;
  const offenders = [];
  for (const f of shippedJs()) {
    const src = readFileSync(f, "utf8");
    // Deliberately textual, not a real parse: a name counts as used if it appears anywhere in
    // what remains, comments included. That can only ever UNDER-report, which is the right
    // direction for a guard nobody should have to argue with.
    const body = src.replace(STATEMENT, "");
    for (const m of src.matchAll(NAMED)) {
      for (const part of m[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/).pop().trim();
        if (!name) continue;
        if (!new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(body)) {
          offenders.push(`${relative(root, f)}: imports \`${name}\` but never uses it`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], `dead imports:\n  ${offenders.join("\n  ")}`);
});

// T-032 (FR-11: "the client remains responsive under latency... via local prediction of selection
// and camera"). camera.js has ZERO imports today — not by convention, but because it has no way
// to reach `game`/a Transport/anything network-adjacent even if some future change wanted it to.
// That is what makes camera movement STRUCTURALLY latency-immune rather than merely
// latency-immune-in-practice: a future edit that wired camera panning through a submitCommand
// round trip (an accidental regression, not a deliberate redesign) would have to add an import to
// get there, and this guard catches exactly that edit, not just its symptom three files away.
// Deliberately narrow (one file, one property) rather than a general "no UI module imports net/"
// rule — camera.js is the one module FR-11 names by name, and input.js's own selection code
// (state.selection = ..., six sites, all direct synchronous assignment — no await/.then/
// submitCommand anywhere near them) is proven at the behavioral level instead, by
// test/input.test.js's own T-013 fault-injection test ("buildMode survives the whole gap") and
// test/latency.test.js's T-032 tests (the real-WS-transport, 150ms-RTT measurement FR-11's exit
// criterion itself asks for) — a second, static "camera has no imports" style check for input.js
// would either have to allowlist its many legitimate imports individually or prove nothing a
// behavioral test doesn't already prove more directly.
test("T-032: camera.js has zero imports — camera movement is structurally unable to depend on network/transport timing, not just conventionally", () => {
  const src = readFileSync(join(root, "camera.js"), "utf8");
  const specs = [...src.matchAll(IMPORT_SPEC)].map(specPath);
  assert.deepEqual(specs, [], `camera.js must import nothing at all — found: ${specs.join(", ")}`);
});
