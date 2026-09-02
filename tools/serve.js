/* ============================================================
   A zero-dependency static file server for local development, so `npm start`
   works with nothing but Node installed — no `npx serve`, no Python. The game
   has no build step but loads as ES modules, which browsers refuse to import
   over file://; this serves the project root over http:// with the correct
   MIME types (crucially application/javascript for .js, or the modules won't
   load) and opens the door on http://localhost:8080.

   Usage:  node tools/serve.js [port]   (or: npm start)

   Also Phase 0's production entrypoint (see Dockerfile) for deploying to the Hugging Face Space.
   The /data persistence probe and /__bench are production-only, gated on DATA_DIR being set —
   unset in local dev, so their behavior there is unchanged.

   T-027 — "the real multiplayer server" this file's header used to say it was ahead of — lands
   here: ADR-0010's own deployment decision #7 is "serve everything on one port: static assets, the
   game WebSocket, and /mcp." createAppServer() is that server. It still has no lobby (T-033,
   Phase 4) or multi-match worker hosting (T-029) to hand a connection a REAL choice of match, so it
   boots exactly one fixed-at-startup demo match (a fresh random seed each boot, ADR-0011's "one
   match per process" posture) and binds the WebSocket game transport (net/wsServerTransport.js,
   T-026) to it at the root path with a real 20 Hz tick loop — the same `?seat=<owner>` binding
   T-026's own tests already exercise, now actually reachable over the network for the first time.
   /mcp is RESERVED (a 501, not a 404 or a hijacked WebSocket upgrade) since T-049 (Phase 6) is its
   real implementation — this file's only job is to make sure nothing else quietly claims that path
   first, static serving and the game socket both included.
   ============================================================ */

"use strict";

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { runProbe } from "./dataProbe.js";
import { runBenchSuite } from "./bench.js";
import { createGameState } from "../engine/state.js";
import { mulberry32 } from "../engine/rng.js";
import { createMatch, stepMatch } from "../server/matchLoop.js";
import { attachWsMatch } from "../net/wsServerTransport.js";

const ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), ".."));   // project root (tools/ is one level down)
const PORT = Number(process.argv[2]) || Number(process.env.PORT) || 8080;

// Run once at boot, not per-request — a fresh bootId on every request would make every request
// its own "first boot" and the persistence signal (docs/adr/0012, TASKS.md T-008a) would never
// fire. null in local dev (DATA_DIR unset), so /__data-probe 404s there exactly as before this
// existed. Logged immediately too, so the answer is visible in the Space's own boot logs even
// before anyone hits the endpoint.
const dataProbeResult = process.env.DATA_DIR ? runProbe(process.env.DATA_DIR) : null;
if (dataProbeResult) {
  console.log(dataProbeResult.persisted
    ? `/data persistence probe: PERSISTED — found a marker from a previous boot (${dataProbeResult.previousMarker.bootId})`
    : `/data persistence probe: no earlier marker found (first boot, or storage is ephemeral — a second deploy will tell which)`);
  if (!dataProbeResult.writable) console.log(`/data persistence probe: NOT WRITABLE — ${dataProbeResult.writeError}`);
}

// Content types for everything the game actually serves. The .js entry is the whole point —
// a browser will only run an ES module the server labels as JavaScript.
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

// Resolve a request path to an on-disk path, or null if it would escape `root`. Exported (and
// taking `root` as a parameter) so it can be unit-tested without booting a real HTTP server.
//
// Two things have to both hold for this to be safe:
//   1. `normalize()` collapses any ".." segments in the joined path BEFORE we compare it against
//      root, so a request can't smuggle a traversal past the check.
//   2. The comparison itself is boundary-aware — `startsWith(root)` alone is broken, because e.g.
//      "/home/user/RTS-evil/x" starts with the string "/home/user/RTS" with no separator between
//      them. Requiring an exact match OR a match followed by path.sep closes that hole.
export function resolveSafePath(root, pathname) {
  let path = decodeURIComponent(pathname);
  if (path === "/") path = "/index.html";
  const filePath = normalize(join(root, path));
  const withinRoot = filePath === root || filePath.startsWith(root + sep);
  return withinRoot ? filePath : null;
}

const TICK_HZ = 20;   // engine/loop.js's own default rate; docs/analysis/04-hf-deployment.md's F1 measured 20Hz comfortable over the real HF edge
const TICK_DT = 1 / TICK_HZ;
const TICK_MS = 1000 / TICK_HZ;

const requestHandler = async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;

    // Reserved, not a 404: T-049 (Phase 6) is /mcp's real implementation. A distinct status
    // (501, not the static handler's 404 or the traversal guard's 403) says "this path is real
    // and spoken for" rather than "doesn't exist" — checked before static resolution so nothing
    // under this namespace can ever be shadowed by an actual on-disk /mcp file or directory.
    if (pathname === "/mcp" || pathname.startsWith("/mcp/")) {
      res.writeHead(501, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: "not_implemented", message: "MCP transport not yet implemented — see TASKS.md T-049." }));
      return;
    }

    // The boot-time probe result, if DATA_DIR is set — 404s exactly like any other unknown path
    // in local dev, where dataProbeResult is null. See docs/adr/0012, TASKS.md T-008a.
    if (pathname === "/__data-probe") {
      if (!dataProbeResult) { res.writeHead(404).end("Not found"); return; }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(dataProbeResult, null, 2));
      return;
    }

    // TEMPORARY — TASKS.md T-014: re-runs the tools/bench.js suite (the feasibility spikes plus a
    // memory-per-match measurement) synchronously and returns the JSON scoreboard, so the numbers
    // in docs/analysis/00-feasibility-spikes.md can be measured on the real Space instead of just
    // the session container the original spike ran on. Gated the same way /__data-probe is (DATA_DIR
    // set = production), and MUST be removed or re-gated once that re-run has actually happened —
    // it blocks this single-threaded server's event loop for its whole duration (the full suite:
    // tens of seconds), which is fine for a one-off self-triggered measurement on an otherwise-idle
    // dev Space and would not be fine left standing. `?full=1` runs the complete suite (docs/
    // analysis/00's own three natural-match scenarios + three stress sizes + memory); the bare
    // endpoint defaults to `quick: true` (one short scenario each) so an accidental or automated
    // hit — a health check, a crawler — costs milliseconds, not a real block.
    if (pathname === "/__bench") {
      if (!dataProbeResult) { res.writeHead(404).end("Not found"); return; }   // same gate as /__data-probe: production only
      const full = new URL(req.url, "http://localhost").searchParams.get("full") === "1";
      const result = runBenchSuite({ quick: !full });
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(result, null, 2));
      return;
    }

    // Strip the query string, default "/" to index.html, and resolve WITHIN the root — a
    // request can't escape the project directory via "../" traversal.
    const filePath = resolveSafePath(ROOT, pathname);
    if (!filePath) { res.writeHead(403).end("Forbidden"); return; }

    const body = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-cache",   // always serve the file on disk — no stale-module surprises while developing
    });
    res.end(body);
  } catch (e) {
    if (e.code === "ENOENT") { res.writeHead(404).end("Not found"); return; }
    res.writeHead(500).end("Server error");
  }
};

// Builds one fresh HTTP server: static assets, the /mcp reservation, and one demo match's
// WebSocket game transport, all on whatever port the caller eventually `.listen()`s. A factory
// rather than a module-level singleton so tests can build an independent instance per test (its
// own demo match, its own tick timer) and tear it down cleanly afterward — the same reason
// net/wsServerTransport.js's attachWsMatch is a function and not a side effect of importing it.
//
// The demo match: no lobby exists yet (T-033, Phase 4) to hand a connection a real choice, so this
// boots exactly one fixed-at-startup skirmish (ADR-0011's "one match per process" posture) and
// binds net/wsServerTransport.js to it at the WebSocket root ("/", the same pathname T-026's own
// tests already use) with a real 20Hz tick loop — wall-clock real, not the compressed cadence
// test fixtures use to avoid sitting around waiting. `path: "/"` keeps an upgrade aimed at the
// reserved /mcp namespace above from also being accepted as this match's game socket.
export function createAppServer() {
  const server = createServer(requestHandler);

  const seed = (Math.floor(Math.random() * 0x100000000)) >>> 0;
  const match = createMatch(createGameState({ planetId: "ferros", seed, rng: mulberry32(seed) }));
  const wsMatch = attachWsMatch(server, match, { path: "/" });
  const tickTimer = setInterval(() => { stepMatch(match, TICK_DT); wsMatch.broadcastState(); }, TICK_MS);

  return {
    server,
    match,
    // Stops this app's own timer and WebSocket attachment. The http.Server itself stays the
    // caller's to close, same convention attachWsMatch's own close() already keeps.
    close() { clearInterval(tickTimer); wsMatch.close(); },
  };
}

// Only bind a port when this file is run directly (`node tools/serve.js` / `npm start`), not when
// it's imported — e.g. by a test — for `resolveSafePath` or `createAppServer`.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { server, match } = createAppServer();
  server.listen(PORT, () => {
    console.log(`SpaceCities — serving ${ROOT}`);
    console.log(`  open  http://localhost:${PORT}/`);
    console.log(`  demo match live: seed ${match.state.seed}, seats [${match.state.owners.join(", ")}] — connect ws://localhost:${PORT}/?seat=<owner>`);
    console.log("  stop  Ctrl+C");
  });
}
