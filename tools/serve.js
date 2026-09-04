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
   game WebSocket, and /mcp." createAppServer() is that server.

   T-049: /mcp is now the real Streamable HTTP + JSON-RPC 2.0 MCP endpoint (net/mcp.js — protocol
   revision 2026-07-28), not the earlier 501 placeholder. A SINGLE exact path, per that revision's
   own "the server MUST provide a single HTTP endpoint path" rule — unlike the placeholder, which
   reserved the whole /mcp/* namespace as a stopgap before the real shape was known, /mcp/anything
   now falls through to ordinary static resolution (a 404, since no such file exists) exactly like
   any other unknown path; there is no URL-based sub-routing in this protocol, only the JSON-RPC
   `method` field in the body. The registered `tools` list here is empty — T-051/T-052/T-053
   (Phase 6's own later tasks) are what actually populate it with real lobby/observation/action
   tools, closing over `lobby`/`liveMatches` the same way the HTTP handlers below already do.

   T-029: a match runs inside its own worker_threads Worker (server/matchWorker.js), relayed to real
   WebSocket connections by net/wsWorkerTransport.js — ADR-0011's own architecture, not a shortcut
   this file invented: a bug that crashes one match's simulation can't take the whole server down
   with it, and a second concurrent match runs on its own CPU core rather than competing with the
   first for Node's single event loop.

   T-034: real matches now, not one fixed-at-startup demo. server/lobby.js decides what matches
   exist; this file's own job is turning that model into three real HTTP endpoints (create match,
   list open matches, join a seat) and a WebSocket upgrade that can find the RIGHT match among
   however many are live: `?match=<id>&seat=<owner>&token=<token>`, replacing T-026's own bare
   `?seat=<owner>` binding (still the shape net/wsWorkerTransport.js accepts underneath — this file
   just also requires the match id to match AND the token to check out, via that function's new
   requireMatch/authorizeSeat opts). Multiple matches share ONE http.Server, which is why
   net/wsWorkerTransport.js's own upgrade handling had to stop destroying a socket that isn't meant
   for IT — see that file's own header for the non-destructive-passthrough-plus-catch-all mechanism
   this file's own catch-all (below) is the other half of.

   T-035 (FR-4): a match no longer spawns its worker the instant it's created — createMatch/joinMatch
   only ever update server/lobby.js's own bookkeeping now. startAndSpawnIfReady is the one place a
   worker actually starts, called after any join that completes the seating (FR-4's "automatically
   when all seats are filled"), after the host's own explicit POST /api/matches/:id/start (FR-4's
   "the host starts it"), and inline from createMatch itself for a seatKinds:["open","ai"] match
   (seat 1 needs no human at all, so it's "filled" from the moment it exists — no separate start
   step should ever be needed for what is, from the host's own seat, an ordinary AI skirmish).
   aiEnabled is decided from the REAL seat state at that moment, not the seat's initial kind alone:
   an "open" seat nobody claimed by start time is FR-3's own "unfilled open seats become AI seats."

   KNOWN GAP, named rather than silently shipped: server/matchSnapshot.js is still "one demo match,
   one fixed filename" (its own header says so) — with two or more concurrent matches BOTH getting a
   real DATA_DIR (production only; unset in local dev and every test), their periodic snapshots would
   overwrite the SAME file. Not fixed here: T-034's own exit criterion (a stranger joins from a link)
   doesn't depend on crash-recovery persistence, and the Space this would matter on is unreachable
   right now (T-008c, account locked) — see TASKS.md's new T-034b row for the tracked, not-yet-done
   fix (per-matchId snapshot filenames). dataDir is still threaded through exactly as before so
   single-match behavior (today's only reachable case) is unaffected.
   ============================================================ */

"use strict";

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { Worker } from "node:worker_threads";
import { runProbe } from "./dataProbe.js";
import { runBenchSuite } from "./bench.js";
import { attachWsMatchWorker } from "../net/wsWorkerTransport.js";
import { createLobby, OWNER_IDS, publicMatch } from "../server/lobby.js";
import { restoreLobby, writeLobbySnapshot } from "../server/lobbySnapshot.js";
import { createMcpServer } from "../net/mcp.js";
import { createLobbyTools } from "../server/mcpLobbyTools.js";
import { createObservationTools } from "../server/mcpObservationTools.js";
import { attachProjectionCache } from "../server/mcpObservationCache.js";

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

const MATCH_WORKER_FILE = join(ROOT, "server", "matchWorker.js");

const requestHandler = async (req, res) => {
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
};

// A safe, small JSON body reader for the /api/matches endpoints below — every request this server
// ever expects a body from is tiny (a handful of scalar config fields), so no size-streaming
// concern like static file serving has. Returns {} for an empty body (GET-shaped convenience for a
// join call that doesn't care which seat), or null for a body that isn't valid JSON — the caller
// turns that into a 400, never a thrown exception reaching the request handler's own catch.
function readJsonBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      if (chunks.length === 0) { resolve({}); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { resolve(null); }
    });
  });
}

function respondJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

// The RAW body string for /mcp — unlike readJsonBody above, this does NOT parse it: net/mcp.js's
// own handleRequest does its own JSON.parse so a malformed body becomes a spec-correct JSON-RPC
// -32700 Parse error response, not a generic 400 this file would otherwise have to invent.
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// Builds one fresh HTTP server: static assets, the real /mcp endpoint, the lobby's three HTTP
// endpoints, and every LIVE match's own WebSocket game transport, all on whatever port the caller
// eventually `.listen()`s. A factory rather than a module-level singleton so tests can build an
// independent instance per test (its own lobby, its own matches, its own mcpServer) and tear it
// down cleanly afterward — the same reason net/wsWorkerTransport.js's attachWsMatchWorker is a
// function and not a side effect of importing it.
export async function createAppServer() {
  const dataDir = process.env.DATA_DIR || null;   // production only — same gate dataProbeResult/__bench already use above
  const lobby = dataDir ? restoreLobby(dataDir) : createLobby();
  // matchId -> {worker, wsMatch, projCache} — only matches THIS boot actually spawned a worker
  // for. Declared BEFORE mcpServer below so the observation tools' own getCache can close over
  // this SAME map by reference — matches start (and get an entry here) well after boot, so the
  // tools need the live, growing Map itself, never a snapshot taken at construction time.
  const liveMatches = new Map();
  // T-051/T-052: the real lobby tools (list_matches/join_match/leave_match) and observation tools
  // (get_situation/list_entities/get_map_overview/get_tech_options), closing over this SAME
  // `lobby`/`liveMatches` the HTTP handlers below already share — an MCP agent and a browser
  // client see and mutate the identical lobby/match state, never two independent copies. T-053
  // appends the real action tools here once they exist, the same way.
  const mcpServer = createMcpServer({
    serverInfo: { name: "SpaceCities", version: "1.1.0" },
    tools: [
      ...createLobbyTools(lobby),
      ...createObservationTools(lobby, matchId => liveMatches.get(matchId)?.projCache ?? null),
    ],
  });

  // Spawns this match's own worker_threads Worker and attaches its WebSocket transport, keyed by
  // this match's own id (server/matchWorker.js's workerData.matchId override, T-034) so the lobby's
  // id and the live match's id are always the SAME id, never two independently-minted ones. Called
  // only once a match has actually STARTED (T-035, startAndSpawnIfReady below) — never eagerly at
  // creation any more. aiEnabled (T-034a's own seam) is decided from the seats' REAL state at that
  // moment: an "ai"-kind seat is an ordinary skirmish opponent; an "open"-kind seat nobody ever
  // joined is FR-3's own "unfilled open seats become AI seats at match start" — AI-filled the
  // instant the match starts, never before (a still-open, still-waiting seat must stay genuinely
  // undriven, not secretly AI-controlled while a real join is still possible).
  async function spawnWorkerFor(match) {
    const seed = (Math.floor(Math.random() * 0x100000000)) >>> 0;
    const worker = new Worker(MATCH_WORKER_FILE, {
      workerData: {
        matchId: match.id,
        createGameStateOpts: {
          planetId: match.config.planetId, sizeMult: match.config.sizeMult, resourceMult: match.config.resourceMult,
          matchTimeLimit: match.config.matchTimeLimit, seed,
          aiEnabled: match.seats[1].kind === "ai" || !match.seats[1].owner,
        },
        // KNOWN GAP (this file's own header): two+ concurrent matches with a real dataDir would
        // collide on server/matchSnapshot.js's still-single fixed filename. Threaded through
        // unchanged rather than silently dropped, since the single-match case (today's only
        // reachable one) must keep working exactly as before — see TASKS.md T-034b.
        dataDir,
      },
    });
    const wsMatch = await attachWsMatchWorker(server, worker, {
      path: "/ws", requireMatch: true,
      // A connection's token must be the REAL one server/lobby.js minted for that exact seat —
      // reusing reclaimSeat rather than a parallel check, since an initial connect right after
      // joinMatch is really just the first "reclaim" of a token that already exists.
      authorizeSeat: (seat, url) => {
        const seatIndex = OWNER_IDS.indexOf(seat);
        return lobby.reclaimSeat(match.id, seatIndex, url.searchParams.get("token")).ok;
      },
      // T-037 (FR-7): "unless the host has disabled spectators" — read from this match's OWN
      // config at the moment its worker actually spawns, same as aiEnabled just above; !== false
      // so an omitted field (every caller before this task, and any caller that just doesn't care)
      // defaults to enabled.
      spectatorsEnabled: match.config.spectatorsEnabled !== false,
    });
    // T-052: an independent listener on the SAME worker `attachWsMatchWorker` already listens
    // to — Node's EventEmitter supports any number of "message" listeners with no interference
    // between them, so this never competes with or changes that relay. Remembers only the
    // LATEST per-seat projection so an MCP observation tool can read it on demand, without ever
    // needing a live WebSocket connection of its own.
    const projCache = attachProjectionCache(worker);
    liveMatches.set(match.id, { worker, wsMatch, projCache });
  }

  // T-035 (FR-4): "all seats filled" — every seat is either not "open" kind (an "ai"/"agent" seat
  // is always pre-filled, never waited on) or genuinely has a real owner. For today's two-seat
  // shapes this means: ["open","ai"] is filled the instant the host's own auto-join lands (seat 1
  // needs no human at all); ["open","open"] is filled only once a second human actually joins.
  function seatsFilled(match) {
    return match.seats.every(s => s.kind !== "open" || s.owner);
  }

  // The ONE place anything actually starts a match: called after the host's own creating join,
  // after any join that might complete the seating, and from the host's own explicit /start
  // request. Idempotent by construction (server/lobby.js's own startMatch refuses a second
  // transition), so every caller can invoke it unconditionally without first checking status
  // itself — "maybe start, maybe it's already started" is exactly the same call either way.
  async function startAndSpawnIfReady(match) {
    const started = lobby.startMatch(match.id);
    if (!started.ok) return false;   // already started (or, in principle, gone) — not this call's to redo
    await spawnWorkerFor(match);
    if (dataDir) writeLobbySnapshot(dataDir, lobby);
    return true;
  }

  async function handleCreateMatch(req, res) {
    const body = await readJsonBody(req);
    if (body === null) { respondJson(res, 400, { error: "bad-json" }); return; }
    let match;
    try {
      match = lobby.createMatch({
        planetId: typeof body.planetId === "string" && body.planetId ? body.planetId : "ferros",
        sizeMult: Number.isFinite(body.sizeMult) ? body.sizeMult : undefined,
        resourceMult: Number.isFinite(body.resourceMult) ? body.resourceMult : undefined,
        matchTimeLimit: Number.isFinite(body.matchTimeLimit) ? body.matchTimeLimit : undefined,
        seatKinds: Array.isArray(body.seatKinds) ? body.seatKinds : undefined,
        // T-037 (FR-7): opaque to server/lobby.js's own createMatch (it already spreads whatever
        // config it's given into match.config, same as every other field here) — omitted stays
        // undefined, which spawnWorkerFor's own `!== false` check already reads as enabled.
        spectatorsEnabled: typeof body.spectatorsEnabled === "boolean" ? body.spectatorsEnabled : undefined,
      });
    } catch (err) { respondJson(res, 400, { error: "bad-config", message: err.message }); return; }
    // The host auto-claims seat 0 in the SAME request that creates the match — a stranger opening
    // a shareable link should never find a match that exists but has nobody in it yet.
    const joined = lobby.joinMatch(match.id, 0);
    // Auto-starts ONLY when seat 1 needed no human to begin with (seatKinds:["open","ai"]) — an
    // ordinary ["open","open"] host still waits, per FR-4, for a second join or their own /start.
    const started = seatsFilled(match) ? await startAndSpawnIfReady(match) : false;
    if (dataDir) writeLobbySnapshot(dataDir, lobby);
    respondJson(res, 201, { matchId: match.id, seatIndex: 0, owner: joined.owner, token: joined.token, started });
  }

  function handleListMatches(req, res) {
    respondJson(res, 200, { matches: lobby.listOpenMatches().map(publicMatch) });
  }

  async function handleJoinMatch(req, res, matchId) {
    const body = await readJsonBody(req);
    if (body === null) { respondJson(res, 400, { error: "bad-json" }); return; }
    const match = lobby.getMatch(matchId);
    if (!match) { respondJson(res, 404, { error: "no-such-match" }); return; }
    let seatIndex = body.seatIndex;
    if (seatIndex === undefined) {
      // No seat named: pick the first still-open, still-unclaimed one — the common case, a
      // stranger who just followed a shareable link and doesn't know or care about seat indices.
      seatIndex = match.seats.findIndex(s => s.kind === "open" && !s.owner);
      if (seatIndex === -1) { respondJson(res, 409, { error: "no-open-seat" }); return; }
    }
    const joined = lobby.joinMatch(matchId, seatIndex);
    if (!joined.ok) { respondJson(res, 409, { error: joined.code }); return; }
    // FR-4's own "automatically when all seats are filled" clause: a join that completes the
    // seating starts the match right here, in the same request — the joiner proceeds straight to
    // connecting, never a separate "now wait for someone to press start" step of their own.
    const started = seatsFilled(match) ? await startAndSpawnIfReady(match) : false;
    if (dataDir) writeLobbySnapshot(dataDir, lobby);
    respondJson(res, 200, { matchId, seatIndex, owner: joined.owner, token: joined.token, started });
  }

  // FR-4's other clause: "the host starts it" — a deliberate override that AI-fills whatever seat
  // is STILL open regardless of whether anyone else ever joins. Host-only (seat 0's own token),
  // and idempotent: a host who clicks Start after a second player already triggered auto-start
  // just gets confirmation, never an error — see startAndSpawnIfReady's own header.
  async function handleStartMatch(req, res, matchId) {
    const body = await readJsonBody(req);
    if (body === null) { respondJson(res, 400, { error: "bad-json" }); return; }
    const match = lobby.getMatch(matchId);
    if (!match) { respondJson(res, 404, { error: "no-such-match" }); return; }
    if (!lobby.reclaimSeat(matchId, 0, body.token).ok) { respondJson(res, 403, { error: "not-the-host" }); return; }
    if (match.status === "open") await startAndSpawnIfReady(match);
    respondJson(res, 200, { matchId, started: true });
  }

  // T-049: the real MCP endpoint — net/mcp.js's handleRequest is transport-agnostic (plain
  // {httpMethod, origin, headers, rawBody} in, {status, body} out), so this is the ONLY place that
  // touches a real http.IncomingMessage/ServerResponse for it. A non-POST method (GET, DELETE, …)
  // still reaches handleRequest with an empty rawBody — it replies 405 on its own before ever
  // looking at the body, so there's no need to special-case that here.
  async function handleMcp(req, res) {
    const rawBody = req.method === "POST" ? await readRawBody(req) : "";
    const result = await mcpServer.handleRequest({ httpMethod: req.method, origin: req.headers.origin, headers: req.headers, rawBody });
    if (result.body === null) { res.writeHead(result.status, { "Cache-Control": "no-store" }).end(); return; }
    respondJson(res, result.status, result.body);
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/mcp") { handleMcp(req, res); return; }
    if (url.pathname === "/api/matches" && req.method === "POST") { handleCreateMatch(req, res); return; }
    if (url.pathname === "/api/matches" && req.method === "GET") { handleListMatches(req, res); return; }
    const joinMatch = req.method === "POST" && /^\/api\/matches\/([^/]+)\/join$/.exec(url.pathname);
    if (joinMatch) { handleJoinMatch(req, res, decodeURIComponent(joinMatch[1])); return; }
    const startMatch = req.method === "POST" && /^\/api\/matches\/([^/]+)\/start$/.exec(url.pathname);
    if (startMatch) { handleStartMatch(req, res, decodeURIComponent(startMatch[1])); return; }
    requestHandler(req, res);
  });

  // T-034: several matches' own attachWsMatchWorker() attachments all share this ONE server, each
  // only ever claiming an upgrade meant for IT (net/wsWorkerTransport.js's own header explains the
  // non-destructive-passthrough half of this). This is the other half: once every "upgrade"
  // listener registered so far has had its synchronous turn, destroy whatever none of them marked
  // handled — a bogus match id, a stale link to a match that already ended, /mcp, or any other
  // upgrade nothing here was ever going to accept. queueMicrotask defers past that whole synchronous
  // dispatch regardless of how many matches are live or in what order they were created.
  server.on("upgrade", (req, socket) => {
    queueMicrotask(() => { if (!socket.__scHandled && !socket.destroyed) socket.destroy(); });
  });

  // Periodic, not per-write — mirrors server/matchWorker.js's own SNAPSHOT_INTERVAL_MS reasoning
  // exactly (bounds an unexpected-crash loss window, not perfectly current). Unset in local dev and
  // every test, same DATA_DIR gate every other production-only feature in this file already uses.
  const LOBBY_SNAPSHOT_INTERVAL_MS = 5000;
  const snapshotTimer = dataDir ? setInterval(() => writeLobbySnapshot(dataDir, lobby), LOBBY_SNAPSHOT_INTERVAL_MS) : null;

  return {
    server,
    lobby,
    // Exposed the same reason `lobby` is: test/httpServer.test.js's own T-035 aiEnabled proof needs
    // to inspect the REAL opts a live match's worker was actually spawned with — checking that
    // directly is both faster AND more correct than waiting to OBSERVE AI behavior over a real WS
    // connection would be, since a fresh AI-filled seat's own buildings start outside the other
    // seat's fog (this engine's ordinary two-base-apart skirmish layout), making "did state.buildings
    // for owner ai grow" an unreliable, slow proxy for a property this already answers directly.
    liveMatches,
    close() {
      if (snapshotTimer) clearInterval(snapshotTimer);
      for (const { worker, wsMatch } of liveMatches.values()) { wsMatch.close(); worker.terminate(); }
      liveMatches.clear();
    },
  };
}

// Only bind a port when this file is run directly (`node tools/serve.js` / `npm start`), not when
// it's imported — e.g. by a test — for `resolveSafePath` or `createAppServer`.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { server } = await createAppServer();
  server.listen(PORT, () => {
    console.log(`SpaceCities — serving ${ROOT}`);
    console.log(`  open  http://localhost:${PORT}/`);
    console.log(`  lobby  POST /api/matches to host, GET /api/matches to list, POST /api/matches/:id/join to join`);
    console.log("  stop  Ctrl+C");
  });
}
