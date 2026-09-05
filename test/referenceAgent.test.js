/* ============================================================
   T-058 (P2): the reference scripted agent — decide() proven as a pure function first (its own
   strategy in isolation, no network involved), then the whole thing proven against a REAL
   `createAppServer()` over REAL HTTP via tools/mcpClient.js, exactly the way any third-party agent
   developer's own client would connect — never net/mcp.js's handleRequest() in-process, unlike
   every other test/mcp*.test.js file's own callTool() shortcut.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createAppServer } from "../tools/serve.js";
import { createMcpClient } from "../tools/mcpClient.js";
import { decide, runReferenceAgent } from "../tools/referenceAgent.js";

async function withApp(fn) {
  const app = await createAppServer();
  await new Promise(resolve => app.server.listen(0, resolve));
  const port = app.server.address().port;
  try {
    await fn(app, `http://localhost:${port}`);
  } finally {
    app.close();
    await new Promise(resolve => app.server.close(resolve));
  }
}

/* ---------- decide(): pure strategy, no network ---------- */

test("decide(): queues economic production when no enemy is visible and a building can afford one", () => {
  const buildingDefs = [{ id: "command", produces: ["worker", "ranger"] }];
  const entities = [{ id: "b1", type: "command", owner: "player", x: 0, y: 0, hp: 1000 }];
  const techOptions = [
    { type: "worker", prereqs_met: true, affordable: false },
    { type: "ranger", prereqs_met: true, affordable: true },
  ];
  const command = decide({ owner: "player", entities, buildingDefs, techOptions });
  // worker is listed first in `produces` but isn't affordable yet — ranger is the first one that is.
  assert.deepEqual(command, { t: "queueProduction", building: "b1", u: "ranger" });
});

test("decide(): does nothing when nothing is affordable and no enemy is visible", () => {
  const buildingDefs = [{ id: "command", produces: ["worker"] }];
  const entities = [{ id: "b1", type: "command", owner: "player", x: 0, y: 0, hp: 1000 }];
  const techOptions = [{ type: "worker", prereqs_met: true, affordable: false }];
  assert.equal(decide({ owner: "player", entities, buildingDefs, techOptions }), null);
});

test("decide(): attack-moves every owned unit toward a visible enemy, ignoring an affordable economy option that round", () => {
  const buildingDefs = [{ id: "command", produces: ["worker"] }];
  const entities = [
    { id: "b1", type: "command", owner: "player", x: 0, y: 0, hp: 1000 },
    { id: "u1", type: "worker", owner: "player", x: 10, y: 10, hp: 40 },
    { id: "u2", type: "skiff", owner: "ai", x: 500, y: 500, hp: 30 },
  ];
  const techOptions = [{ type: "worker", prereqs_met: true, affordable: true }];
  const command = decide({ owner: "player", entities, buildingDefs, techOptions });
  assert.deepEqual(command, { t: "attackMove", ids: ["u1"], x: 500, y: 500 });
});

test("decide(): a visible enemy with no owned units to send falls through to economy instead of an empty attack", () => {
  const buildingDefs = [{ id: "command", produces: ["worker"] }];
  const entities = [
    { id: "b1", type: "command", owner: "player", x: 0, y: 0, hp: 1000 },
    { id: "u2", type: "skiff", owner: "ai", x: 500, y: 500, hp: 30 },
  ];
  const techOptions = [{ type: "worker", prereqs_met: true, affordable: true }];
  const command = decide({ owner: "player", entities, buildingDefs, techOptions });
  assert.deepEqual(command, { t: "queueProduction", building: "b1", u: "worker" });
});

/* ---------- REAL end to end, over real HTTP, against the real production entrypoint ---------- */

test("REAL end to end: the reference agent joins an open match over real HTTP, waits out the host's own start, and issues a real command", async () => {
  await withApp(async (app, baseUrl) => {
    const created = await fetch(`${baseUrl}/api/matches`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planetId: "ferros", seatKinds: ["open", "open"] }),
    }).then(r => r.json());

    const lines = [];
    // The match is still OPEN (seat 1 unfilled) when this starts — join_match must succeed now,
    // and the subsequent get_situation calls must tolerate "not started yet" until the /start
    // call below actually lands, exactly the real host/agent timing gap this task's own agent is
    // built to handle.
    const agentPromise = runReferenceAgent({
      baseUrl, matchId: created.matchId, maxRounds: 2, waitTimeoutMs: 200,
      startupTimeoutMs: 5000, startupRetryMs: 100, log: l => lines.push(l),
    });

    await fetch(`${baseUrl}/api/matches/${created.matchId}/start`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: created.token }),
    }).then(r => r.json());

    const summary = await agentPromise;
    assert.equal(summary.matchId, created.matchId);
    assert.equal(summary.owner, "ai");   // seat 0 (player) was already taken by the host's own create call
    assert.equal(summary.rounds, 2);
    assert.equal(summary.over, false);
    assert.ok(lines.some(l => l.startsWith("Joined match")), lines.join("\n"));
    // A fresh Command Center can always afford a worker turn one — proves a REAL command reached
    // the REAL codec through this agent's own real HTTP round-trip, not just that the loop ran.
    assert.ok(lines.some(l => l === "Issued queueProduction."), lines.join("\n"));
  });
});

test("REAL end to end: join_match failing (e.g. both seats already taken) surfaces as a clear thrown error, not a hang", async () => {
  await withApp(async (app, baseUrl) => {
    const created = await fetch(`${baseUrl}/api/matches`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planetId: "ferros", seatKinds: ["open", "open"] }),
    }).then(r => r.json());
    // Fill the last open seat directly, over the real transport, before the agent ever gets there.
    const client = createMcpClient(baseUrl);
    await client.callTool("join_match", { match_id: created.matchId });

    await assert.rejects(
      runReferenceAgent({ baseUrl, matchId: created.matchId, maxRounds: 1 }),
      /join_match failed/,
    );
  });
});
