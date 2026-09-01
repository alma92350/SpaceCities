/* ============================================================
   A zero-dependency static file server for local development, so `npm start`
   works with nothing but Node installed — no `npx serve`, no Python. The game
   has no build step but loads as ES modules, which browsers refuse to import
   over file://; this serves the project root over http:// with the correct
   MIME types (crucially application/javascript for .js, or the modules won't
   load) and opens the door on http://localhost:8080.

   Usage:  node tools/serve.js [port]   (or: npm start)

   Also Phase 0's production entrypoint (see Dockerfile) for deploying the existing
   single-player game to the Hugging Face Space, ahead of the real multiplayer server
   (TASKS.md Phase 1+). The one production-only addition is the /data persistence
   probe below, gated entirely on DATA_DIR being set — unset in local dev, so this
   file's behavior there is unchanged.
   ============================================================ */

"use strict";

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { runProbe } from "./dataProbe.js";
import { runBenchSuite } from "./bench.js";

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

const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;

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
});

// Only bind a port when this file is run directly (`node tools/serve.js` / `npm start`), not when
// it's imported — e.g. by a test — for `resolveSafePath`.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  server.listen(PORT, () => {
    console.log(`SpaceCities — serving ${ROOT}`);
    console.log(`  open  http://localhost:${PORT}/`);
    console.log("  stop  Ctrl+C");
  });
}
