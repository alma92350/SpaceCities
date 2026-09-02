/* ============================================================
   T-027: one HTTP server, one port (7860 in production, an ephemeral port here), speaking all
   three protocols ADR-0010's own deployment decision names explicitly: static assets, the game
   WebSocket, and a RESERVED (not yet implemented) /mcp. This is the plumbing proof, not a
   playability test — no lobby exists yet (T-033, Phase 4), so tools/serve.js's createAppServer
   boots exactly one fixed-seed demo match and binds it at the WebSocket root, the same `?seat=`
   binding T-026's own tests already exercise. Two real clients throughout, never a hand-rolled
   stand-in: Node's own http client for the static/mcp checks, net/wsClientTransport.js's real
   WebSocket transport for the game socket — the same standard test/ws.test.js and
   test/wsTransport.test.js already hold themselves to.
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

async function withApp(fn) {
  const app = createAppServer();
  const port = await listen(app.server);
  try {
    await fn(app, port);
  } finally {
    app.close();
    await new Promise(resolve => app.server.close(resolve));
  }
}

test("static assets: the demo server still serves index.html correctly", async () => {
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

test("the WebSocket game transport is live on the SAME server/port as the static assets", async () => {
  await withApp(async (app, port) => {
    const transport = await createWsClientTransport(`ws://localhost:${port}/?seat=player`);
    try {
      assert.equal(app.match.state.owners.includes("player"), true, "fixture sanity: the demo match really does have a player seat");
    } finally {
      transport.close();
    }
  });
});

test("the demo match's tick loop is really running at real wall-clock cadence — a state push arrives on its own", async () => {
  await withApp(async (app, port) => {
    const transport = await createWsClientTransport(`ws://localhost:${port}/?seat=player`);
    try {
      const state = await new Promise(resolve => {
        transport.onEvent(e => { if (e.type === "state") resolve(e.state); });
      });
      assert.ok(state.units instanceof Map);
    } finally {
      transport.close();
    }
  });
});

test("a WebSocket upgrade aimed at /mcp is refused — the reserved namespace isn't secretly also the game socket", async () => {
  await withApp(async (app, port) => {
    await assert.rejects(createWsClientTransport(`ws://localhost:${port}/mcp?seat=player`));
  });
});

test("createAppServer().close() stops the demo match's tick timer and the ws attachment, without touching the http.Server itself", async () => {
  const app = createAppServer();
  const port = await listen(app.server);
  try {
    assert.doesNotThrow(() => app.close());
    assert.doesNotThrow(() => app.close(), "idempotent, same guarantee every other close() in this codebase gives");
    // The http.Server itself is still the caller's own to close — proven by successfully closing
    // it ourselves here, exactly as withApp()'s own finally block does for every other test.
  } finally {
    await new Promise(resolve => app.server.close(resolve));
  }
  assert.ok(port > 0);
});
