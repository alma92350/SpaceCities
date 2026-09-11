/* ============================================================
   T-027: one HTTP server, one port (7860 in production, an ephemeral port here), speaking all
   three protocols ADR-0010's own deployment decision names explicitly: static assets, the game
   WebSocket, and a RESERVED (not yet implemented) /mcp.

   T-034: createAppServer() no longer boots one fixed-seed demo match at startup — a real lobby
   (server/lobby.js) now decides what matches exist, reached over three new HTTP endpoints
   (POST/GET /api/matches, POST /api/matches/:id/join) and a WebSocket upgrade keyed by
   `?match=<id>&seat=<owner>&token=<token>` instead of the old bare `?seat=<owner>`. Two real
   clients throughout, never a hand-rolled stand-in: Node's own http client for the static/mcp/API
   checks, net/wsClientTransport.js's real WebSocket transport for the game socket — the same
   standard test/ws.test.js and test/wsTransport.test.js already hold themselves to.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { createAppServer } from "../tools/serve.js";
import { createWsClientTransport } from "../net/wsClientTransport.js";
import { PROTOCOL_VERSION } from "../net/mcp.js";

async function listen(server) {
  await new Promise(resolve => server.listen(0, resolve));
  return server.address().port;
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "localhost", port, path, method: "GET" }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

function post(port, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const req = httpRequest({ host: "localhost", port, path, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

async function postJson(port, path, body) {
  const res = await post(port, path, body);
  return { status: res.status, json: res.body ? JSON.parse(res.body) : null };
}

// A real MCP tools/call, over a real HTTP connection to the SAME /mcp endpoint a real agent
// speaks to — every dedicated mcp*.test.js file constructs its own createMcpServer directly
// instead of going through createAppServer's full HTTP stack (this file's own established
// "prove the mechanism, then prove the piece that feeds it, separately" split), so this helper
// exists here only for the one test that specifically needs proof of the REAL tools/serve.js
// wiring end to end, not just the mechanism.
async function callMcpTool(port, name, args) {
  const payload = {
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: {
      name, arguments: args,
      _meta: { "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION, "io.modelcontextprotocol/clientCapabilities": {} },
    },
  };
  const res = await new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = httpRequest({
      host: "localhost", port, path: "/mcp", method: "POST",
      headers: {
        "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body),
        "MCP-Protocol-Version": PROTOCOL_VERSION, "Mcp-Method": "tools/call", "Mcp-Name": name,
      },
    }, r => {
      const chunks = [];
      r.on("data", c => chunks.push(c));
      r.on("end", () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
  return { status: res.status, json: JSON.parse(res.body) };
}

async function withApp(fn) {
  const app = await createAppServer();
  const port = await listen(app.server);
  try {
    await fn(app, port);
  } finally {
    app.close();
    await new Promise(resolve => app.server.close(resolve));
  }
}

test("static assets: the server still serves index.html correctly", async () => {
  await withApp(async (app, port) => {
    const res = await get(port, "/index.html");
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /text\/html/);
    assert.match(res.body, /<title>SpaceCities<\/title>/);
  });
});

test("T-049: GET /mcp is 405 — this protocol revision has no GET SSE endpoint, and the real handler (not the old 501 placeholder) now answers", async () => {
  await withApp(async (app, port) => {
    const res = await get(port, "/mcp");
    assert.equal(res.status, 405);
  });
});

test("T-049: /mcp is a SINGLE exact path — /mcp/anything is no longer specially reserved, it 404s like any other unknown path", async () => {
  await withApp(async (app, port) => {
    const res = await get(port, "/mcp/tools/list");
    assert.equal(res.status, 404);
  });
});

test("T-049: POST /mcp speaks real Streamable HTTP + JSON-RPC 2.0 (protocol revision 2026-07-28) end to end, over a real HTTP connection", async () => {
  await withApp(async (app, port) => {
    const payload = {
      jsonrpc: "2.0", id: 1, method: "server/discover",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    };
    const res = await new Promise((resolve, reject) => {
      const body = JSON.stringify(payload);
      const req = httpRequest({
        host: "localhost", port, path: "/mcp", method: "POST",
        headers: {
          "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body),
          "MCP-Protocol-Version": PROTOCOL_VERSION, "Mcp-Method": "server/discover",
        },
      }, r => {
        const chunks = [];
        r.on("data", c => chunks.push(c));
        r.on("end", () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
      req.end(body);
    });
    assert.equal(res.status, 200);
    const json = JSON.parse(res.body);
    assert.equal(json.result.resultType, "complete");
    assert.deepEqual(json.result.supportedVersions, [PROTOCOL_VERSION]);
    // T-055: the real createAppServer() now registers real static resources (unit stats, the
    // counter triangle, build costs, the tech tree), so its own server/discover capabilities
    // genuinely include resources:{} now — see net/mcp.test.js for the capability-declaration
    // mechanism itself (only ever declared once something is actually registered).
    assert.deepEqual(json.result.capabilities, { tools: {}, resources: {} });
    assert.deepEqual(json.result._meta["io.modelcontextprotocol/serverInfo"], { name: "SpaceCities", version: "1.1.0" });
  });
});

test("an unrelated unknown path still 404s as ordinary static serving would — /mcp's reservation didn't swallow the rest of the server", async () => {
  await withApp(async (app, port) => {
    const res = await get(port, "/not-a-real-path.js");
    assert.equal(res.status, 404);
  });
});

test("createAppServer().close() is idempotent and never touches the http.Server itself", async () => {
  const app = await createAppServer();
  const port = await listen(app.server);
  try {
    assert.doesNotThrow(() => app.close());
    assert.doesNotThrow(() => app.close(), "idempotent, same guarantee every other close() in this codebase gives");
  } finally {
    await new Promise(resolve => app.server.close(resolve));
  }
  assert.ok(port > 0);
});

/* ---------- T-034: the lobby HTTP API ---------- */

test("GET /api/matches lists nothing on a fresh server — no auto-booted demo match any more", async () => {
  await withApp(async (app, port) => {
    const res = await get(port, "/api/matches");
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /application\/json/);
    const body = JSON.parse(res.body);
    assert.deepEqual(body.matches, []);
  });
});

test("POST /api/matches (default seatKinds, both open) creates a match, auto-joins the host to seat 0, and reports it's NOT started yet — waiting for a second player or an explicit start (T-035, FR-4)", async () => {
  await withApp(async (app, port) => {
    const created = await postJson(port, "/api/matches", { planetId: "ferros" });
    assert.equal(created.status, 201);
    assert.equal(typeof created.json.matchId, "string");
    assert.ok(created.json.matchId.length > 0);
    assert.equal(created.json.seatIndex, 0);
    assert.equal(created.json.owner, "player");
    assert.equal(typeof created.json.token, "string");
    assert.ok(created.json.token.length > 0);
    assert.equal(created.json.started, false, "an ordinary two-open-seat match waits for a second seat, it doesn't start itself");

    // Not live yet: no worker exists for this match until something actually starts it.
    await assert.rejects(createWsClientTransport(`ws://localhost:${port}/ws?match=${created.json.matchId}&seat=player&token=${created.json.token}`));
  });
});

test("T-057 (ADR-0007): POST /api/matches can never set clockPolicy — a client-supplied clockPolicy in the request body is silently ignored, never forwarded to the lobby", async () => {
  await withApp(async (app, port) => {
    const created = await postJson(port, "/api/matches", { planetId: "ferros", clockPolicy: "deliberation" });
    assert.equal(created.status, 201);
    const match = app.lobby.getMatch(created.json.matchId);
    assert.equal(match.config.clockPolicy, undefined, "the ONLY network-reachable match-creation path must never be able to set a non-realtime clockPolicy — that would break ADR-0007's own \"never in a lobby with a human\" safety property");
    // Also publicly listed — confirming it's a genuinely ordinary (realtime) match, not just that
    // the field was dropped.
    assert.ok(app.lobby.listOpenMatches().some(m => m.id === created.json.matchId));
  });
});

/* ============================================================
   Bugfix, reported live: a user trying to seat TWO separate MCP agents into the two seats of an
   ordinary match (intending to watch as a spectator, playing neither seat themselves) found the
   second agent's own join_match always rejected with "no-open-seat" — because creating the match
   at all (POST /api/matches) unconditionally auto-claimed seat 0 for the host in the same request,
   leaving only ONE seat ever open for anyone else to join, agent or human. hostJoins:false lets a
   creator opt out of that auto-claim (default true, so every existing caller — including every
   test above this one — is unaffected) specifically for this "I'm only spectating" case.
   ============================================================ */

test("bugfix: POST /api/matches with hostJoins:false claims NEITHER seat — the creator gets no seat/token, and the match waits with every seat still genuinely open for someone else to join", async () => {
  await withApp(async (app, port) => {
    const created = await postJson(port, "/api/matches", { planetId: "ferros", hostJoins: false });
    assert.equal(created.status, 201);
    assert.equal(created.json.seatIndex, null);
    assert.equal(created.json.owner, null);
    assert.equal(created.json.token, null);
    assert.equal(created.json.started, false);

    const match = app.lobby.getMatch(created.json.matchId);
    assert.equal(match.seats[0].owner, null, "seat 0 must still be genuinely unclaimed, not silently taken by the creator");
    assert.equal(match.seats[1].owner, null);
  });
});

test("bugfix: two separate joins fill both seats of a hostJoins:false match — the exact scenario a human host previously could never set up (two independent agents, no seat of their own)", async () => {
  await withApp(async (app, port) => {
    const created = await postJson(port, "/api/matches", { planetId: "ferros", hostJoins: false });

    const first = await postJson(port, `/api/matches/${created.json.matchId}/join`, {});
    assert.equal(first.json.seatIndex, 0);
    assert.equal(first.json.started, false, "one seat filled, one still open — not ready yet");

    const second = await postJson(port, `/api/matches/${created.json.matchId}/join`, {});
    assert.equal(second.json.seatIndex, 1);
    assert.equal(second.json.started, true, "the LAST open seat filling must start the match on its own — no host token exists to call /start with in this scenario");

    // Genuinely live, for BOTH seats — not just a flag that says so.
    const transportA = await createWsClientTransport(`ws://localhost:${port}/ws?match=${created.json.matchId}&seat=${first.json.owner}&token=${first.json.token}`);
    const transportB = await createWsClientTransport(`ws://localhost:${port}/ws?match=${created.json.matchId}&seat=${second.json.owner}&token=${second.json.token}`);
    const stateA = await new Promise(resolve => transportA.onEvent(e => { if (e.type === "state") resolve(e.state); }));
    assert.ok(stateA.units instanceof Map);
    transportA.close();
    transportB.close();
  });
});

test("bugfix, REAL end to end: two real join_match MCP tool calls (not the HTTP join endpoint) fill both seats of a hostJoins:false match and start it — the exact reported scenario, over the real /mcp endpoint tools/serve.js actually wires", async () => {
  await withApp(async (app, port) => {
    const created = await postJson(port, "/api/matches", { planetId: "ferros", hostJoins: false });

    const first = await callMcpTool(port, "join_match", { match_id: created.json.matchId });
    assert.equal(first.json.result.isError, undefined, JSON.stringify(first.json.result));
    assert.equal(first.json.result.structuredContent.started, false);

    const second = await callMcpTool(port, "join_match", { match_id: created.json.matchId });
    assert.equal(second.json.result.isError, undefined, JSON.stringify(second.json.result));
    assert.equal(second.json.result.structuredContent.started, true,
      "join_match itself must start the match once it fills the last seat — nothing else in this scenario ever could");

    const { owner: ownerA } = first.json.result.structuredContent;
    const { owner: ownerB } = second.json.result.structuredContent;
    assert.notEqual(ownerA, ownerB, "fixture sanity: two genuinely different seats");
    // Confirmed live on the SAME match the two agents just joined — app.lobby, not a second copy.
    assert.equal(app.lobby.getMatch(created.json.matchId).status, "started");
  });
});

test("POST /api/matches with seatKinds:['open','ai'] auto-starts immediately — no second human to wait for (T-035, FR-4's own \"all seats filled\" clause: an ai-kind seat counts as already filled)", async () => {
  await withApp(async (app, port) => {
    const created = await postJson(port, "/api/matches", { planetId: "ferros", seatKinds: ["open", "ai"] });
    assert.equal(created.json.started, true);
    const transport = await createWsClientTransport(`ws://localhost:${port}/ws?match=${created.json.matchId}&seat=player&token=${created.json.token}`);
    const state = await new Promise(resolve => transport.onEvent(e => { if (e.type === "state") resolve(e.state); }));
    assert.ok(state.units instanceof Map);
    transport.close();
  });
});

test("POST /api/matches/:id/start (host-only) starts a waiting match on demand — FR-4's \"the host starts it\" clause", async () => {
  await withApp(async (app, port) => {
    const created = await postJson(port, "/api/matches", { planetId: "ferros" });
    await assert.rejects(createWsClientTransport(`ws://localhost:${port}/ws?match=${created.json.matchId}&seat=player&token=${created.json.token}`),
      "fixture sanity: not live before start");

    const started = await postJson(port, `/api/matches/${created.json.matchId}/start`, { token: created.json.token });
    assert.equal(started.status, 200);

    const transport = await createWsClientTransport(`ws://localhost:${port}/ws?match=${created.json.matchId}&seat=player&token=${created.json.token}`);
    const state = await new Promise(resolve => transport.onEvent(e => { if (e.type === "state") resolve(e.state); }));
    assert.ok(state.units instanceof Map);
    transport.close();
  });
});

test("POST /api/matches/:id/start refuses anyone but the host (seat 0's own token)", async () => {
  await withApp(async (app, port) => {
    const created = await postJson(port, "/api/matches", { planetId: "ferros" });
    const res = await postJson(port, `/api/matches/${created.json.matchId}/start`, { token: "not-the-hosts-token" });
    assert.equal(res.status, 403);
  });
});

test("POST /api/matches/:id/start on an already-started match is a harmless no-op success, not an error — the host's own \"Start\" click must work whether or not a second player already triggered it", async () => {
  await withApp(async (app, port) => {
    const created = await postJson(port, "/api/matches", { planetId: "ferros" });
    await postJson(port, `/api/matches/${created.json.matchId}/join`, {});   // auto-starts it
    const res = await postJson(port, `/api/matches/${created.json.matchId}/start`, { token: created.json.token });
    assert.equal(res.status, 200);
  });
});

test("POST /api/matches/:id/start on an unknown match returns a clear 404", async () => {
  await withApp(async (app, port) => {
    const res = await postJson(port, "/api/matches/00000000-0000-0000-0000-000000000000/start", { token: "x" });
    assert.equal(res.status, 404);
  });
});

test("T-035 (FR-3): starting a match with its second seat still unfilled really hands it to the built-in AI — proven on the REAL spawned worker's own opts, not by waiting to observe it through the other seat's fog", async () => {
  // An early version of this test waited on a real WebSocket connection to SEE owner "ai" build
  // something — flawed, not just slow: a fresh AI-filled seat's own buildings start on the far side
  // of this engine's ordinary two-bases-apart skirmish layout, outside the "player" seat's own fog,
  // so "did state.buildings for ai grow" never fires within any reasonable wait, through no fault of
  // the AI. T-034a's own engine-level tests already prove aiEnabled:true genuinely produces AI
  // behavior (600 ticks, 2 buildings -> 5, no fog in the way there); what THIS layer actually needs
  // to prove is narrower and answerable directly: did tools/serve.js compute aiEnabled correctly and
  // hand it to the REAL spawned worker for an unfilled seat.
  await withApp(async (app, port) => {
    const created = await postJson(port, "/api/matches", { planetId: "ferros" });
    await postJson(port, `/api/matches/${created.json.matchId}/start`, { token: created.json.token });
    const live = app.liveMatches.get(created.json.matchId);
    assert.ok(live, "the match must actually have a live worker once started");
    assert.equal(live.wsMatch.createGameStateOpts.aiEnabled, true, "seat 1 was never joined — FR-3's own AI fill must have engaged for it");
  });
});

test("T-035 (FR-3, control): a SECOND HUMAN filling seat 1 gets aiEnabled:false — the built-in AI must never also be fighting a real player for the same seat", async () => {
  await withApp(async (app, port) => {
    const created = await postJson(port, "/api/matches", { planetId: "ferros" });
    await postJson(port, `/api/matches/${created.json.matchId}/join`, {});   // auto-starts it
    const live = app.liveMatches.get(created.json.matchId);
    assert.equal(live.wsMatch.createGameStateOpts.aiEnabled, false, "a human-joined seat must stay human-controlled, never secretly AI-driven too (T-034a)");
  });
});

/* ============================================================
   Choosing WHICH built-in AI an "ai"-kind seat runs. spawnWorkerFor computed a single boolean
   (aiEnabled) and nothing else, so every AI seat played engine/aiStrategy.js's `default` at the
   engine's default difficulty — the four strategies and three difficulty rows that already exist,
   and that createGameState already accepts as aiStrategy/difficulty, were simply unreachable from
   the lobby. Threaded through here so a host can pick an opponent, which is what makes an
   "agent vs a NAMED AI" match possible at all rather than "agent vs whatever the default is".
   ============================================================ */

test("POST /api/matches threads aiStrategy and difficulty into the real spawned worker's createGameStateOpts", async () => {
  await withApp(async (app, port) => {
    const created = await postJson(port, "/api/matches", {
      planetId: "ferros", seatKinds: ["open", "ai"], aiStrategy: "aggressive", difficulty: "hard",
    });
    const live = app.liveMatches.get(created.json.matchId);
    assert.ok(live, "an ['open','ai'] match is filled on creation, so its worker must already be live");
    assert.equal(live.wsMatch.createGameStateOpts.aiEnabled, true);
    assert.equal(live.wsMatch.createGameStateOpts.aiStrategy, "aggressive",
      "the host's chosen strategy must reach the worker, not be silently dropped on the way");
    assert.equal(live.wsMatch.createGameStateOpts.difficulty, "hard");
  });
});

test("omitting aiStrategy/difficulty leaves them undefined rather than inventing a value — the engine's own defaults must stay the defaults", async () => {
  // The "omitted preserves prior behavior" contract spectatorsEnabled and hostJoins already hold
  // themselves to: every caller predating this change must be byte-for-byte unaffected.
  await withApp(async (app, port) => {
    const created = await postJson(port, "/api/matches", { planetId: "ferros", seatKinds: ["open", "ai"] });
    const live = app.liveMatches.get(created.json.matchId);
    assert.equal(live.wsMatch.createGameStateOpts.aiStrategy, undefined);
    assert.equal(live.wsMatch.createGameStateOpts.difficulty, undefined);
  });
});

test("a non-string aiStrategy/difficulty is ignored, not forwarded — a bad body must never reach createGameState", async () => {
  await withApp(async (app, port) => {
    const created = await postJson(port, "/api/matches", {
      planetId: "ferros", seatKinds: ["open", "ai"], aiStrategy: { evil: true }, difficulty: 7,
    });
    assert.equal(created.status, 201, "a junk AI option is ignored, not a 400 — it is a preference, not a required field");
    const live = app.liveMatches.get(created.json.matchId);
    assert.equal(live.wsMatch.createGameStateOpts.aiStrategy, undefined);
    assert.equal(live.wsMatch.createGameStateOpts.difficulty, undefined);
  });
});

test("a created match (default seatKinds) shows up in GET /api/matches as open, with seat 0 already taken and no token ever leaked", async () => {
  await withApp(async (app, port) => {
    const created = await postJson(port, "/api/matches", { planetId: "ferros" });
    const list = await get(port, "/api/matches");
    const body = JSON.parse(list.body);
    const match = body.matches.find(m => m.id === created.json.matchId);
    assert.ok(match, "the newly-created match must appear in the open list");
    assert.equal(match.seats[0].taken, true, "the host's own seat is already claimed");
    assert.equal(match.seats[1].taken, false, "the second seat is still open for a stranger to join");
    assert.equal(JSON.stringify(match).includes(created.json.token), false, "a seat token must never appear in a public listing");
  });
});

test("POST /api/matches/:id/join claims the open seat, and a stranger reaches the SAME live match the host is in", async () => {
  await withApp(async (app, port) => {
    const created = await postJson(port, "/api/matches", { planetId: "ferros" });
    const joined = await postJson(port, `/api/matches/${created.json.matchId}/join`, {});
    assert.equal(joined.status, 200);
    assert.equal(joined.json.seatIndex, 1);
    assert.equal(joined.json.owner, "ai");   // T-033's fixed 2-seat mapping — seat 1 is owner "ai" regardless of who's really behind it
    assert.notEqual(joined.json.token, created.json.token, "each seat mints its own distinct token");

    const hostT = await createWsClientTransport(`ws://localhost:${port}/ws?match=${created.json.matchId}&seat=player&token=${created.json.token}`);
    const guestT = await createWsClientTransport(`ws://localhost:${port}/ws?match=${created.json.matchId}&seat=ai&token=${joined.json.token}`);
    const hostState = await new Promise(resolve => hostT.onEvent(e => { if (e.type === "state") resolve(e.state); }));
    const guestState = await new Promise(resolve => guestT.onEvent(e => { if (e.type === "state") resolve(e.state); }));
    // Same live match, proven the same way T-034's wsWorkerTransport test proves the OPPOSITE
    // (two DIFFERENT matches never share a map) — here the map must be IDENTICAL.
    assert.equal(JSON.stringify(hostState.map.nodes), JSON.stringify(guestState.map.nodes));
    hostT.close(); guestT.close();
  });
});

test("joining with a WRONG token is refused at the WebSocket upgrade, not silently let in", async () => {
  await withApp(async (app, port) => {
    const created = await postJson(port, "/api/matches", { planetId: "ferros" });
    await assert.rejects(createWsClientTransport(`ws://localhost:${port}/ws?match=${created.json.matchId}&seat=player&token=not-the-real-token`));
  });
});

test("joining an unknown match id returns a clear 404, not a crash", async () => {
  await withApp(async (app, port) => {
    const res = await postJson(port, "/api/matches/00000000-0000-0000-0000-000000000000/join", {});
    assert.equal(res.status, 404);
    assert.equal(res.json.error, "no-such-match");
  });
});

test("joining a match whose only open seat is already taken returns a clear 409, not a crash", async () => {
  await withApp(async (app, port) => {
    const created = await postJson(port, "/api/matches", { planetId: "ferros" });
    const first = await postJson(port, `/api/matches/${created.json.matchId}/join`, {});
    assert.equal(first.status, 200);
    const second = await postJson(port, `/api/matches/${created.json.matchId}/join`, {});
    assert.equal(second.status, 409);
    assert.equal(second.json.error, "no-open-seat");
  });
});

test("seatKinds:['open','ai'] hosts an ordinary skirmish-vs-AI through the lobby — no second human ever needed", async () => {
  await withApp(async (app, port) => {
    const created = await postJson(port, "/api/matches", { planetId: "ferros", seatKinds: ["open", "ai"] });
    // T-035: this auto-starts immediately (seat 1 needs no human), so it's no longer in the OPEN
    // listing at all by the time this checks — exactly the same reason a started ["open","open"]
    // match drops out too. Nothing left to browse for; a join attempt is still the real proof an
    // "ai" seat is never human-joinable, started or not.
    const list = JSON.parse((await get(port, "/api/matches")).body);
    assert.equal(list.matches.some(m => m.id === created.json.matchId), false, "an auto-started match is no longer publicly listed as open");
    const joinAttempt = await postJson(port, `/api/matches/${created.json.matchId}/join`, {});
    assert.equal(joinAttempt.status, 409, "an ai-kind seat is never open to a human join");
  });
});

test("two matches created back to back run fully independently — different seeds, different live workers, no cross-talk over HTTP or WS", async () => {
  await withApp(async (app, port) => {
    // seatKinds:["open","ai"] so both are immediately live — this test's own point is cross-talk
    // isolation between two CONCURRENT matches, not T-035's own start-condition semantics.
    const a = await postJson(port, "/api/matches", { planetId: "ferros", seatKinds: ["open", "ai"] });
    const b = await postJson(port, "/api/matches", { planetId: "ferros", seatKinds: ["open", "ai"] });
    assert.notEqual(a.json.matchId, b.json.matchId);
    const tA = await createWsClientTransport(`ws://localhost:${port}/ws?match=${a.json.matchId}&seat=player&token=${a.json.token}`);
    const tB = await createWsClientTransport(`ws://localhost:${port}/ws?match=${b.json.matchId}&seat=player&token=${b.json.token}`);
    const stateA = await new Promise(resolve => tA.onEvent(e => { if (e.type === "state") resolve(e.state); }));
    const stateB = await new Promise(resolve => tB.onEvent(e => { if (e.type === "state") resolve(e.state); }));
    assert.notEqual(JSON.stringify(stateA.map.nodes), JSON.stringify(stateB.map.nodes));
    tA.close(); tB.close();
  });
});

test("a WebSocket upgrade aimed at /mcp is refused — the reserved namespace isn't secretly also a game socket", async () => {
  await withApp(async (app, port) => {
    const created = await postJson(port, "/api/matches", { planetId: "ferros", seatKinds: ["open", "ai"] });
    await assert.rejects(createWsClientTransport(`ws://localhost:${port}/mcp?match=${created.json.matchId}&seat=player&token=${created.json.token}`));
  });
});

test("a WebSocket upgrade naming a match id that was never created is refused, not left hanging forever — the catch-all destroys what nobody claims", async () => {
  await withApp(async (app, port) => {
    await assert.rejects(createWsClientTransport(`ws://localhost:${port}/ws?match=00000000-0000-0000-0000-000000000000&seat=player&token=x`));
  });
});

/* ---------- T-037 (FR-7): spectators, wired end to end through the real lobby + app server ---------- */

test("a real spectator connects to a live match created via POST /api/matches and receives full-vision state — spectatorsEnabled defaults to true", async () => {
  await withApp(async (app, port) => {
    const created = await postJson(port, "/api/matches", { planetId: "ferros", seatKinds: ["open", "ai"] });
    assert.equal(created.json.started, true, "fixture sanity: live immediately");
    const ws = new WebSocket(`ws://localhost:${port}/ws?match=${created.json.matchId}&spectate=1`);
    try {
      const proj = await new Promise((resolve, reject) => {
        ws.addEventListener("error", reject);
        ws.addEventListener("message", ev => { const msg = JSON.parse(ev.data); if (msg.type === "state") resolve(msg.proj); });
      });
      const owners = new Set(proj.buildings.map(b => b.owner));
      assert.ok(owners.has("player") && owners.has("ai"), "a spectator reached through the real app server must still see both seats at once");
    } finally { ws.close(); }
  });
});

test("POST /api/matches with spectatorsEnabled:false creates a match that refuses a real spectate connection", async () => {
  await withApp(async (app, port) => {
    const created = await postJson(port, "/api/matches", { planetId: "ferros", seatKinds: ["open", "ai"], spectatorsEnabled: false });
    const ws = new WebSocket(`ws://localhost:${port}/ws?match=${created.json.matchId}&spectate=1`);
    const refused = await new Promise(resolve => {
      ws.addEventListener("error", () => resolve(true));
      ws.addEventListener("open", () => resolve(false));
    });
    assert.equal(refused, true, "the host disabled spectators at creation time — a watch attempt must be refused");
  });
});

test("GET /api/matches exposes spectatorsEnabled in the public listing, so a client can know before attempting to watch", async () => {
  await withApp(async (app, port) => {
    const enabled = await postJson(port, "/api/matches", { planetId: "ferros" });
    const disabled = await postJson(port, "/api/matches", { planetId: "ferros", spectatorsEnabled: false });
    const list = JSON.parse((await get(port, "/api/matches")).body);
    const mEnabled = list.matches.find(m => m.id === enabled.json.matchId);
    const mDisabled = list.matches.find(m => m.id === disabled.json.matchId);
    assert.equal(mEnabled.spectatorsEnabled, true);
    assert.equal(mDisabled.spectatorsEnabled, false);
  });
});

/* ============================================================
   T-059 (FR-22): GET /api/results — a match's own final outcome, recorded once its worker
   reports over:true, independent of the raw engine snapshot (which stops the instant a match
   ends — server/matchWorker.js's own header). matchTimeLimit gives a REAL, fast, deterministic
   way to end a match in a test without inventing a special test-only trigger: engine/victory.js's
   own checkWinCondition ends it via "timeout-score" the moment state.time reaches the limit,
   exactly the same path a real long match eventually hits on its own.
   ============================================================ */

test("GET /api/results starts empty, before any match has ever ended", async () => {
  await withApp(async (app, port) => {
    const res = await get(port, "/api/results");
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body).results, []);
  });
});

test("a real match ending via matchTimeLimit is recorded and reported by GET /api/results", async () => {
  await withApp(async (app, port) => {
    const created = await postJson(port, "/api/matches", {
      planetId: "ferros", seatKinds: ["open", "ai"], matchTimeLimit: 0.2,
    });
    assert.equal(created.json.started, true, "fixture sanity: an [open, ai] match starts immediately");

    const result = await new Promise((resolve, reject) => {
      const deadline = Date.now() + 10000;
      const poll = async () => {
        const listed = JSON.parse((await get(port, "/api/results")).body).results;
        const found = listed.find(r => r.matchId === created.json.matchId);
        if (found) { resolve(found); return; }
        if (Date.now() > deadline) { reject(new Error("match never appeared in /api/results")); return; }
        setTimeout(poll, 100);
      };
      poll();
    });

    assert.equal(result.winReason, "timeout-score");
    assert.deepEqual(result.owners, ["player", "ai"]);
    assert.ok(result.owners.includes(result.winner), "the recorded winner must be one of this match's own real owners");
    assert.ok(result.time >= 0.2, "the match must have actually run at least matchTimeLimit's own worth of sim time");
    assert.ok(Number.isFinite(result.tick) && result.tick > 0);
    assert.ok(Number.isFinite(result.endedAt) && result.endedAt <= Date.now());
  });
});

test("createAppServer().close() stops every live match's worker and ws attachment, without touching the http.Server itself", async () => {
  const app = await createAppServer();
  const port = await listen(app.server);
  // Immediately live (seatKinds:["open","ai"]) so close()'s own effect is actually what this test
  // proves — a match that was never live to begin with would make the rejection below vacuous.
  const created = await postJson(port, "/api/matches", { planetId: "ferros", seatKinds: ["open", "ai"] });
  try {
    assert.doesNotThrow(() => app.close());
    assert.doesNotThrow(() => app.close(), "idempotent");
    // A connection to the now-closed match's worker can no longer succeed.
    await assert.rejects(createWsClientTransport(`ws://localhost:${port}/ws?match=${created.json.matchId}&seat=player&token=${created.json.token}`));
  } finally {
    await new Promise(resolve => app.server.close(resolve));
  }
});

// callMcpTool returns the raw JSON-RPC envelope; every test below wants the `result` object a
// real agent's own client (tools/mcpClient.js) hands back, so unwrap it once here.
// A match's worker reports its first projection a tick or two after the match starts, so every
// observation tool answers "no-state-yet" for a brief window right after create_match — exactly
// the gap docs/mcp-player-handbook.md tells a real agent to tolerate. Poll through it rather than
// racing it.
async function untilLive(port, seat_handle) {
  for (let i = 0; i < 100; i++) {
    const result = await mcpResult(port, "get_situation", { seat_handle });
    if (!result.isError) return result;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error("the match never reported a projection");
}

// The GET twin of postJson above — several of the parity tests below read plain lobby JSON.
async function getJson(port, path) {
  const res = await get(port, path);
  return { status: res.status, json: res.body ? JSON.parse(res.body) : null };
}

async function mcpResult(port, name, args) {
  const { json } = await callMcpTool(port, name, args);
  assert.equal(json.error, undefined, `MCP ${name} protocol error: ${JSON.stringify(json.error)}`);
  return json.result;
}

/* ============================================================
   The MCP seating surface, proven through the REAL tools/serve.js wiring rather than a
   hand-constructed tool registry: who plays each seat (create_match), a seat 0 driven by the game's
   own AI (which needs engine/state.js's ownerDefs, not the seat-1-only aiEnabled shortcut), and
   watching a match nobody at this client is playing.
   ============================================================ */

test("create_match over MCP can put the game's own AI on SEAT 0 — and that seat really plays", async () => {
  const app = await createAppServer();
  const port = await listen(app.server);
  try {
    const created = await mcpResult(port, "create_match", {
      seats: [{ controller: "ai", ai_strategy: "aggressive" }, { controller: "ai" }],
    });
    assert.equal(created.isError, undefined, JSON.stringify(created));
    assert.equal(created.structuredContent.started, true, "an all-AI match needs no joiner, so it starts on creation");

    // Watch it, and let it run far enough that a seat nobody is driving must have DONE something —
    // seat 0 ("player") is the one the old seat-1-only aiEnabled path could never have driven.
    const watch = await mcpResult(port, "watch_match", { match_id: created.structuredContent.match_id });
    const watch_handle = watch.structuredContent.watch_handle;

    let seat0 = null;
    for (let i = 0; i < 60 && !seat0?.units_by_type?.worker; i++) {
      await mcpResult(port, "wait_for_event", { seat_handle: watch_handle, timeout_ms: 200 });
      const situation = await mcpResult(port, "get_situation", { seat_handle: watch_handle });
      seat0 = situation.structuredContent.sides?.find(s => s.owner === "player") ?? null;
    }
    assert.ok(seat0, "a watcher sees a per-side scoreboard for every owner");
    assert.ok(seat0.units_by_type.worker > 0, "seat 0 has its own units");
    // The real claim: seat 0 is being PLAYED, not just seeded. Its starting workers idle forever
    // unless a controller sends them somewhere.
    const entities = (await mcpResult(port, "list_entities", { seat_handle: watch_handle, owner: "player" })).structuredContent.entities;
    assert.ok(entities.some(e => e.activity && e.activity !== "idle"),
      `seat 0's own units should be doing something under AI control, got ${JSON.stringify(entities.map(e => e.activity))}`);
  } finally {
    app.close();
    await new Promise(resolve => app.server.close(resolve));
  }
});

test("an MCP client creates a match, plays a turn in ONE batched call, and can rejoin it by client_id alone", async () => {
  const app = await createAppServer();
  const port = await listen(app.server);
  try {
    const created = await mcpResult(port, "create_match", {
      seats: [{ controller: "agent" }, { controller: "ai" }],
      join_as: 0, client_id: "agent-alpha",
    });
    assert.equal(created.structuredContent.started, true, "the only seat needing a joiner was claimed in this same call");
    const { seat_handle, match_id } = created.structuredContent;

    await untilLive(port, seat_handle);
    const batched = await mcpResult(port, "batch", {
      seat_handle,
      steps: [
        { tool: "get_situation" },
        { tool: "get_map_overview" },
        { tool: "wait_for_event", arguments: { timeout_ms: 300 } },
      ],
    });
    assert.equal(batched.isError, undefined, JSON.stringify(batched));
    assert.deepEqual(batched.structuredContent.results.map(r => r.tool), ["get_situation", "get_map_overview", "wait_for_event"]);
    assert.equal(batched.structuredContent.failed, 0, JSON.stringify(batched.structuredContent.results));
    assert.equal(batched.structuredContent.results[0].structuredContent.you, "player");

    // Everything the client is assumed to have lost except its own id — the compaction/restart case.
    const found = await mcpResult(port, "find_my_seats", { client_id: "agent-alpha" });
    assert.deepEqual(found.structuredContent.seats.map(s => s.match_id), [match_id]);
    const rejoined = await mcpResult(port, "join_match", { match_id, client_id: "agent-alpha" });
    assert.equal(rejoined.structuredContent.rejoined, true);
    // The recovered handle is not merely well-formed — it still commands the same live seat.
    const situation = await mcpResult(port, "get_situation", { seat_handle: rejoined.structuredContent.seat_handle });
    assert.equal(situation.structuredContent.you, "player");
  } finally {
    app.close();
    await new Promise(resolve => app.server.close(resolve));
  }
});

test("an MCP client hands its live seat to the AI and takes it back, through the real server", async () => {
  const app = await createAppServer();
  const port = await listen(app.server);
  try {
    const created = await mcpResult(port, "create_match", {
      seats: [{ controller: "agent" }, { controller: "ai" }], join_as: 0, client_id: "agent-alpha",
    });
    const { seat_handle } = created.structuredContent;

    await untilLive(port, seat_handle);
    const away = await mcpResult(port, "set_seat_controller", { seat_handle, controller: "ai", difficulty: "hard" });
    assert.equal(away.structuredContent.ai_controlled, true);
    const back = await mcpResult(port, "set_seat_controller", { seat_handle, controller: "self" });
    assert.equal(back.structuredContent.ai_controlled, false);
    // The seat is still ours throughout — a handover is not leaving the match.
    assert.equal((await mcpResult(port, "get_situation", { seat_handle })).structuredContent.you, "player");
  } finally {
    app.close();
    await new Promise(resolve => app.server.close(resolve));
  }
});

/* ============================================================
   THE COMPACTION CASE, end to end through the real server. Observed in a real Sonnet session: the
   agent compacted its context ~10 minutes in, lost its seat_handle, and from then on could not
   find its match (a running match is hidden from the default listing), could not get back into its
   seat (it had passed no client_id), and never learned the outcome (nothing over MCP reads the
   results store). Its base meanwhile stood frozen, because an MCP seat has no socket whose close
   could trigger the AI cover a browser client's seat already gets.
   ============================================================ */

test("an agent that lost EVERYTHING but the server address finds its match, takes its seat back, and reads the outcome", async () => {
  const app = await createAppServer();
  const port = await listen(app.server);
  try {
    // Deliberately no client_id — this is an agent that did not know it would need one.
    const created = await mcpResult(port, "create_match", {
      seats: [{ controller: "agent" }, { controller: "ai" }], join_as: 0,
    });
    const match_id = created.structuredContent.match_id;
    await untilLive(port, created.structuredContent.seat_handle);

    // --- the compaction: every handle it held is gone ---

    // 1. Finding the match again. The default listing is "what can I join", so a running match is
    //    absent from it — which is exactly what "my match disappeared" looked like.
    const joinable = await mcpResult(port, "list_matches", {});
    assert.equal(joinable.structuredContent.matches.some(m => m.id === match_id), false);
    const all = await mcpResult(port, "list_matches", { include_started: true });
    const mine = all.structuredContent.matches.find(m => m.id === match_id);
    assert.ok(mine, "include_started must surface the running match");
    assert.equal(mine.status, "started");
    assert.equal(typeof mine.seats[0].idle_seconds, "number", "which seat is silent is readable without any credential");

    // 2. Taking the seat back. Refused while the seat is plainly active...
    const tooSoon = await mcpResult(port, "reclaim_seat", { match_id, seat_index: 0 });
    assert.equal(tooSoon.isError, true);
    assert.match(tooSoon.content[0].text, /seat-still-active/);

    // ...and granted once it has genuinely gone quiet. (Reaching into the lobby to age the seat is
    // the one thing a test cannot do by waiting: the real window is 60s.)
    app.lobby.touchSeat(match_id, 0, Date.now() - 120000);
    const reclaimed = await mcpResult(port, "reclaim_seat", { match_id, seat_index: 0, client_id: "agent-alpha" });
    assert.equal(reclaimed.isError, undefined, JSON.stringify(reclaimed));
    const seat_handle = reclaimed.structuredContent.seat_handle;

    // 3. The recovered handle really drives the seat — not merely a well-formed string.
    const situation = await mcpResult(port, "get_situation", { seat_handle });
    assert.equal(situation.structuredContent.you, "player");

    // 4. And having passed a client_id this time, the NEXT recovery is a plain rejoin.
    const rejoined = await mcpResult(port, "join_match", { match_id, client_id: "agent-alpha" });
    assert.equal(rejoined.structuredContent.rejoined, true);
  } finally {
    app.close();
    await new Promise(resolve => app.server.close(resolve));
  }
});

test("a finished match reports its outcome over MCP — wait_for_event resolves at once and get_match_report explains it", async () => {
  const app = await createAppServer();
  const port = await listen(app.server);
  try {
    const created = await mcpResult(port, "create_match", {
      seats: [{ controller: "agent" }, { controller: "ai" }], join_as: 0, client_id: "agent-alpha",
    });
    const match_id = created.structuredContent.match_id;
    const { seat_handle } = created.structuredContent;
    await untilLive(port, seat_handle);

    // Concede, to reach a real decided match quickly rather than playing one out.
    await mcpResult(port, "surrender", { seat_handle });

    // wait_for_event must RESOLVE, not block out its timeout: a decided match will never produce
    // another event, so blocking on one is an agent hanging forever by design.
    let waited = null;
    for (let i = 0; i < 40; i++) {
      waited = await mcpResult(port, "wait_for_event", { seat_handle, timeout_ms: 250 });
      if (waited.structuredContent.summary?.match_over) break;
    }
    assert.ok(waited.structuredContent.summary?.match_over, `wait_for_event never reported the match ending: ${JSON.stringify(waited.structuredContent)}`);
    assert.ok(waited.structuredContent.events.some(e => e.type === "matchEnded"));
    assert.match(waited.content[0].text, /The match is over/);

    // The report survives the match itself — who won, why, how long, and who was playing each seat.
    const report = await mcpResult(port, "get_match_report", { match_id });
    assert.equal(report.structuredContent.finished, true);
    const result = report.structuredContent.result;
    assert.equal(result.winner, "ai", JSON.stringify(result));
    assert.ok(result.winReason, "a report must say WHY it ended, not just who won");
    assert.deepEqual(result.seats.map(s => s.controller), ["agent", "ai"],
      "who played each seat — 'ai won' is meaningless without it, since 'ai' is a seat id");
    assert.equal(result.sides.find(s => s.owner === "ai").won, true);

    // And an agent coming back with only its client_id learns the match is over in one call.
    const found = await mcpResult(port, "find_my_seats", { client_id: "agent-alpha" });
    assert.equal(found.structuredContent.seats[0].status, "finished");
    assert.equal(found.structuredContent.seats[0].result.winner, "ai");
  } finally {
    app.close();
    await new Promise(resolve => app.server.close(resolve));
  }
});

test("a seat that goes quiet is covered by the game's AI, and handed back on the agent's next call", async () => {
  const app = await createAppServer();
  const port = await listen(app.server);
  try {
    const created = await mcpResult(port, "create_match", {
      seats: [{ controller: "agent" }, { controller: "ai" }], join_as: 0, client_id: "agent-alpha",
    });
    const { seat_handle, match_id } = created.structuredContent;
    await untilLive(port, seat_handle);

    const controllerOf = owner => app.liveMatches.get(match_id).worker && app.lobby.getMatch(match_id) && owner;
    assert.ok(controllerOf("player"));

    // Nothing yet — the agent has just been playing.
    await app.seatPresence.sweep();
    assert.equal(app.seatPresence.isAutoCovered(match_id, "player"), false);

    // Now it compacts: silent well past the idle window. (Aging the clock is the one thing a test
    // cannot do by waiting — the real window is 90s.)
    app.lobby.touchSeat(match_id, 0, Date.now() - 600000);
    await app.seatPresence.sweep();
    assert.equal(app.seatPresence.isAutoCovered(match_id, "player"), true,
      "an MCP seat has no socket whose close could trigger cover — silence is the only signal there is");

    // Coming back needs no special call: any ordinary tool call hands the seat straight back.
    await mcpResult(port, "get_situation", { seat_handle });
    assert.equal(app.seatPresence.isAutoCovered(match_id, "player"), false);

    // ...and the seat is genuinely commandable again.
    const cmd = await mcpResult(port, "issue_command", { seat_handle, command: { t: "stop", ids: ["u1"] } });
    assert.notEqual(cmd.structuredContent?.code, "command-timeout");
  } finally {
    app.close();
    await new Promise(resolve => app.server.close(resolve));
  }
});

test("an EXPLICIT set_seat_controller('ai') is not undone by the agent's own observation calls while away", async () => {
  const app = await createAppServer();
  const port = await listen(app.server);
  try {
    const created = await mcpResult(port, "create_match", {
      seats: [{ controller: "agent" }, { controller: "ai" }], join_as: 0, client_id: "agent-alpha",
    });
    const { seat_handle, match_id } = created.structuredContent;
    await untilLive(port, seat_handle);

    await mcpResult(port, "set_seat_controller", { seat_handle, controller: "ai" });
    // Watching the match while deliberately away must not silently take the seat back.
    await mcpResult(port, "get_situation", { seat_handle });
    assert.equal(app.seatPresence.isAutoCovered(match_id, "player"), false);

    const back = await mcpResult(port, "set_seat_controller", { seat_handle, controller: "self" });
    assert.equal(back.structuredContent.ai_controlled, false);
  } finally {
    app.close();
    await new Promise(resolve => app.server.close(resolve));
  }
});

/* ============================================================
   BROWSER / MCP PARITY. The lobby is one shared model, but the two front doors onto it did not
   agree about what was in it: GET /api/matches only ever listed matches still OPEN to join, and a
   match an MCP client creates typically starts the instant it is created (it claims its own seat in
   the same call, or its opponent is an AI needing no joiner). Such a match was never OPEN for even
   one poll, so the browser could not see it, watch it, or know it existed.
   ============================================================ */

test("GET /api/matches?include_started=1 shows a running MCP-created match that the default listing hides", async () => {
  const app = await createAppServer();
  const port = await listen(app.server);
  try {
    const created = await mcpResult(port, "create_match", {
      seats: [{ controller: "agent" }, { controller: "ai" }], join_as: 0,
    });
    const match_id = created.structuredContent.match_id;
    assert.equal(created.structuredContent.started, true, "this shape of match starts on creation");

    const openOnly = await getJson(port, "/api/matches");
    assert.equal(openOnly.json.matches.some(m => m.id === match_id), false,
      "the default listing is 'what can I join', which a running match is not");

    const all = await getJson(port, "/api/matches?include_started=1");
    const listed = all.json.matches.find(m => m.id === match_id);
    assert.ok(listed, "the browser must be able to see the matches its own agents are playing");
    assert.equal(listed.status, "started");
    assert.deepEqual(listed.seats.map(s => s.controller), ["agent", "ai"]);
  } finally {
    app.close();
    await new Promise(resolve => app.server.close(resolve));
  }
});

test("GET /api/matches/:id answers for one match, including after it has finished", async () => {
  const app = await createAppServer();
  const port = await listen(app.server);
  try {
    const created = await mcpResult(port, "create_match", {
      seats: [{ controller: "agent" }, { controller: "ai" }], join_as: 0, client_id: "agent-alpha",
    });
    const { match_id, seat_handle } = created.structuredContent;
    await untilLive(port, seat_handle);

    const live = await getJson(port, `/api/matches/${match_id}`);
    assert.equal(live.status, 200);
    assert.equal(live.json.status, "started");
    assert.equal(live.json.live, true);
    assert.equal(live.json.result, undefined);

    await mcpResult(port, "surrender", { seat_handle });
    let finished = null;
    for (let i = 0; i < 60; i++) {
      finished = await getJson(port, `/api/matches/${match_id}`);
      if (finished.json.result) break;
      await new Promise(r => setTimeout(r, 50));
    }
    assert.ok(finished.json.result, "a finished match's outcome is readable from the browser too");
    assert.equal(finished.json.result.winner, "ai");

    assert.equal((await getJson(port, "/api/matches/no-such-id")).status, 404);
  } finally {
    app.close();
    await new Promise(resolve => app.server.close(resolve));
  }
});

test("a match hosted from the browser is joinable by an MCP agent, and one created over MCP is joinable from the browser", async () => {
  const app = await createAppServer();
  const port = await listen(app.server);
  try {
    // Browser hosts, agent joins — the direction that already worked, pinned so it stays working.
    const hosted = await postJson(port, "/api/matches", { planetId: "ferros", seatKinds: ["open", "open"] });
    const agentJoin = await mcpResult(port, "join_match", { match_id: hosted.json.matchId, client_id: "agent-alpha" });
    assert.equal(agentJoin.isError, undefined, JSON.stringify(agentJoin));
    assert.equal(agentJoin.structuredContent.started, true, "the agent's join filled the last seat");

    // Agent creates with a seat left open, browser joins it over plain HTTP — the direction that
    // did not work: the open seat is an "agent" KIND, which the browser's own joinable rule (and,
    // before this, the lobby's) refused.
    const made = await mcpResult(port, "create_match", {
      seats: [{ controller: "agent" }, { controller: "human" }], join_as: 0, client_id: "agent-beta",
    });
    const browserJoin = await postJson(port, `/api/matches/${made.structuredContent.match_id}/join`, {});
    assert.equal(browserJoin.status, 200, JSON.stringify(browserJoin.json));
    assert.equal(browserJoin.json.owner, "ai", "seat 1 is the one that was left for a person");
    assert.equal(browserJoin.json.started, true);
  } finally {
    app.close();
    await new Promise(resolve => app.server.close(resolve));
  }
});
