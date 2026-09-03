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

test("/mcp is RESERVED, not a 404 — a distinct response, since T-049 (Phase 6) is its real implementation", async () => {
  await withApp(async (app, port) => {
    const res = await get(port, "/mcp");
    assert.equal(res.status, 501, "501 Not Implemented: a real, recognized endpoint, just not built yet");
    assert.match(res.headers["content-type"], /application\/json/);
    const body = JSON.parse(res.body);
    assert.equal(body.error, "not_implemented");
  });
});

test("/mcp reserves its whole namespace, not just the exact path", async () => {
  await withApp(async (app, port) => {
    const res = await get(port, "/mcp/tools/list");
    assert.equal(res.status, 501);
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

test("POST /api/matches creates a match, auto-joins the host to seat 0, and the match is immediately live", async () => {
  await withApp(async (app, port) => {
    const created = await postJson(port, "/api/matches", { planetId: "ferros" });
    assert.equal(created.status, 201);
    assert.equal(typeof created.json.matchId, "string");
    assert.ok(created.json.matchId.length > 0);
    assert.equal(created.json.seatIndex, 0);
    assert.equal(created.json.owner, "player");
    assert.equal(typeof created.json.token, "string");
    assert.ok(created.json.token.length > 0);

    // Immediately live: the host can connect over WS using exactly what this response gave them.
    const transport = await createWsClientTransport(`ws://localhost:${port}/ws?match=${created.json.matchId}&seat=player&token=${created.json.token}`);
    const state = await new Promise(resolve => transport.onEvent(e => { if (e.type === "state") resolve(e.state); }));
    assert.ok(state.units instanceof Map);
    transport.close();
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
    const list = JSON.parse((await get(port, "/api/matches")).body);
    const match = list.matches.find(m => m.id === created.json.matchId);
    assert.equal(match.seats[1].kind, "ai");
    const joinAttempt = await postJson(port, `/api/matches/${created.json.matchId}/join`, {});
    assert.equal(joinAttempt.status, 409, "an ai-kind seat is never open to a human join");
  });
});

test("two matches created back to back run fully independently — different seeds, different live workers, no cross-talk over HTTP or WS", async () => {
  await withApp(async (app, port) => {
    const a = await postJson(port, "/api/matches", { planetId: "ferros" });
    const b = await postJson(port, "/api/matches", { planetId: "ferros" });
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
    const created = await postJson(port, "/api/matches", { planetId: "ferros" });
    await assert.rejects(createWsClientTransport(`ws://localhost:${port}/mcp?match=${created.json.matchId}&seat=player&token=${created.json.token}`));
  });
});

test("a WebSocket upgrade naming a match id that was never created is refused, not left hanging forever — the catch-all destroys what nobody claims", async () => {
  await withApp(async (app, port) => {
    await assert.rejects(createWsClientTransport(`ws://localhost:${port}/ws?match=00000000-0000-0000-0000-000000000000&seat=player&token=x`));
  });
});

test("createAppServer().close() stops every live match's worker and ws attachment, without touching the http.Server itself", async () => {
  const app = await createAppServer();
  const port = await listen(app.server);
  const created = await postJson(port, "/api/matches", { planetId: "ferros" });
  try {
    assert.doesNotThrow(() => app.close());
    assert.doesNotThrow(() => app.close(), "idempotent");
    // A connection to the now-closed match's worker can no longer succeed.
    await assert.rejects(createWsClientTransport(`ws://localhost:${port}/ws?match=${created.json.matchId}&seat=player&token=${created.json.token}`));
  } finally {
    await new Promise(resolve => app.server.close(resolve));
  }
});
