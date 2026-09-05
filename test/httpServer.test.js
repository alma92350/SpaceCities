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
