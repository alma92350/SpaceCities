import { test } from "node:test";
import assert from "node:assert/strict";
import { createLobby } from "../server/lobby.js";
import { createMcpServer, PROTOCOL_VERSION } from "../net/mcp.js";
import { resolveSeatHandle } from "../server/mcpSeatHandle.js";
import { createLobbyTools } from "../server/mcpLobbyTools.js";
import { AGENT_APM } from "../net/agentApm.js";

/* ============================================================
   T-051 (FR-13): the first REAL MCP tools — list_matches/join_match/leave_match — closing the
   loop T-049a's own tests deliberately left open (they minted seat handles directly via
   lobby.joinMatch(), a correct stand-in for what join_match itself does). This is that real
   tool, and this file's own exit criterion IS T-051's own: "an agent joins a match unaided,"
   proven end to end through the real net/mcp.js transport, not just by calling lobby functions
   directly.
   ============================================================ */

function mcpFor(lobby) {
  return createMcpServer({ tools: createLobbyTools(lobby) });
}

async function callTool(mcp, name, args) {
  const body = {
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name, arguments: args, _meta: { "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION, "io.modelcontextprotocol/clientCapabilities": {} } },
  };
  return mcp.handleRequest({
    httpMethod: "POST",
    headers: { "mcp-protocol-version": PROTOCOL_VERSION, "mcp-method": "tools/call", "mcp-name": name },
    rawBody: JSON.stringify(body),
  });
}

test("createLobbyTools registers exactly list_matches, join_match, and leave_match", () => {
  const tools = createLobbyTools(createLobby());
  assert.deepEqual(tools.map(t => t.name).sort(), ["join_match", "leave_match", "list_matches"]);
});

test("list_matches reports every open match's PUBLIC shape — never a seat's real token, never the raw seed", async () => {
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  lobby.joinMatch(match.id, 0);
  const mcp = mcpFor(lobby);

  const { body } = await callTool(mcp, "list_matches", {});
  assert.equal(body.result.isError, undefined);
  assert.equal(body.result.structuredContent.matches.length, 1);
  const listed = body.result.structuredContent.matches[0];
  assert.equal(listed.id, match.id);
  assert.deepEqual(listed.seats, [{ kind: "open", taken: true }, { kind: "open", taken: false }]);
  assert.equal(JSON.stringify(listed).includes(match.seats[0].token), false, "a seat's real token must never appear in the public listing");
});

test("list_matches reports the published, fixed agent_apm_cap (T-056) — a server policy, not per-match data", async () => {
  const mcp = mcpFor(createLobby());
  const { body } = await callTool(mcp, "list_matches", {});
  assert.equal(body.result.structuredContent.agent_apm_cap, AGENT_APM);
});

test("list_matches never lists a match that has already started", async () => {
  const lobby = createLobby();
  const started = lobby.createMatch({ seatKinds: ["open", "open"] });
  lobby.startMatch(started.id);
  const open = lobby.createMatch({ seatKinds: ["open", "open"] });
  const mcp = mcpFor(lobby);

  const { body } = await callTool(mcp, "list_matches", {});
  assert.deepEqual(body.result.structuredContent.matches.map(m => m.id), [open.id]);
});

test("join_match: an agent joins a match UNAIDED — this task's own exit criterion, proven end to end through the real MCP transport", async () => {
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const mcp = mcpFor(lobby);

  const { status, body } = await callTool(mcp, "join_match", { match_id: match.id });
  assert.equal(status, 200);
  assert.equal(body.result.isError, undefined);
  const { seat_handle, owner, seat_index } = body.result.structuredContent;
  assert.equal(owner, "player");
  assert.equal(seat_index, 0);
  assert.ok(seat_handle && typeof seat_handle === "string");

  // The handle it got back is REAL — resolves to the actual seat it just claimed.
  const resolved = resolveSeatHandle(lobby, seat_handle);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.owner, "player");
  assert.equal(resolved.matchId, match.id);
});

test("join_match with no seat_index auto-picks the first still-open seat, mirroring the HTTP join endpoint's own behavior", async () => {
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  lobby.joinMatch(match.id, 0);   // seat 0 already taken by someone else
  const mcp = mcpFor(lobby);

  const { body } = await callTool(mcp, "join_match", { match_id: match.id });
  assert.equal(body.result.structuredContent.seat_index, 1);
  assert.equal(body.result.structuredContent.owner, "ai");
});

test("join_match reports a clear TOOL EXECUTION error for an unknown match, a taken seat, or an already-started match — never a JSON-RPC protocol error", async () => {
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  lobby.joinMatch(match.id, 0);
  const startedMatch = lobby.createMatch({ seatKinds: ["open", "open"] });
  lobby.startMatch(startedMatch.id);
  const mcp = mcpFor(lobby);

  const noSuchMatch = await callTool(mcp, "join_match", { match_id: "not-a-real-id" });
  assert.equal(noSuchMatch.status, 200);
  assert.equal(noSuchMatch.body.result.isError, true);
  assert.match(noSuchMatch.body.result.content[0].text, /no-such-match/);

  const seatTaken = await callTool(mcp, "join_match", { match_id: match.id, seat_index: 0 });
  assert.equal(seatTaken.body.result.isError, true);
  assert.match(seatTaken.body.result.content[0].text, /seat-taken/);

  const alreadyStarted = await callTool(mcp, "join_match", { match_id: startedMatch.id });
  assert.equal(alreadyStarted.body.result.isError, true);
  assert.match(alreadyStarted.body.result.content[0].text, /already-started/);
});

test("join_match reports a clear tool execution error when every seat is already taken (no open seat left to auto-pick)", async () => {
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  lobby.joinMatch(match.id, 0);
  lobby.joinMatch(match.id, 1);
  const mcp = mcpFor(lobby);

  const { body } = await callTool(mcp, "join_match", { match_id: match.id });
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /no-open-seat/);
});

/* ============================================================
   Bugfix: join_match used to never start a match on its own — docs/agent-guide.md's own §2 told an
   agent to expect this ("the host still has to start the match separately"). Tolerable when a
   human host always held seat 0 and could click Start, a genuine dead end once a match can exist
   with NO seat held by anyone (tools/serve.js's own hostJoins:false, reported live by a user
   trying to seat two independent MCP agents with themselves only spectating) — two agents' own
   join_match calls become the ONLY thing that will ever fill those seats, so they have to be able
   to start it too. onSeatsFilled (createLobbyTools's new optional 2nd argument) is how
   tools/serve.js hooks this in for real; these tests use a fake callback, exactly this file's own
   established style for every dependency lobby tools don't own themselves.
   ============================================================ */

test("createLobbyTools without a second argument still works exactly as before — onSeatsFilled is optional, every pre-existing caller unaffected", async () => {
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const mcp = mcpFor(lobby);   // mcpFor's own helper calls createLobbyTools(lobby) with no 2nd arg

  const { body } = await callTool(mcp, "join_match", { match_id: match.id });
  assert.equal(body.result.isError, undefined);
  assert.equal(body.result.structuredContent.started, false, "no callback provided — must default to false, never throw for a missing one");
});

test("bugfix: join_match calls onSeatsFilled after every successful join, and reports its own `started` result", async () => {
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const seenMatches = [];
  const mcp = createMcpServer({
    tools: createLobbyTools(lobby, async m => { seenMatches.push(m.id); return false; }),
  });

  const { body } = await callTool(mcp, "join_match", { match_id: match.id });
  assert.equal(body.result.structuredContent.started, false, "the callback's own return value is reported verbatim");
  assert.deepEqual(seenMatches, [match.id], "called exactly once, with the match this join actually happened in");
});

test("bugfix: when onSeatsFilled reports true (the join that filled the last seat), join_match reports started:true — proving the exact scenario a hostJoins:false match needs: two agents, no host, and nothing else that could ever start it", async () => {
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const mcp = createMcpServer({
    // A real caller's own callback checks seatsFilled itself (tools/serve.js) — this fake mirrors
    // that exact shape rather than hardcoding true, so it only fires once BOTH seats are real.
    tools: createLobbyTools(lobby, async m => m.seats.every(s => s.owner)),
  });

  const first = await callTool(mcp, "join_match", { match_id: match.id });
  assert.equal(first.body.result.structuredContent.started, false, "one seat filled, one still open");

  const second = await callTool(mcp, "join_match", { match_id: match.id });
  assert.equal(second.body.result.structuredContent.started, true, "the LAST open seat filling must report started:true — no human host exists to call /start in this scenario");
});

test("leave_match: a real join followed by leave_match frees the seat, and the OLD handle no longer works for anything", async () => {
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const mcp = mcpFor(lobby);

  const joined = await callTool(mcp, "join_match", { match_id: match.id });
  const handle = joined.body.result.structuredContent.seat_handle;

  const left = await callTool(mcp, "leave_match", { seat_handle: handle });
  assert.equal(left.status, 200);
  assert.equal(left.body.result.isError, undefined);

  assert.equal(lobby.matches.get(match.id).seats[0].owner, null, "the seat is genuinely free again");
  assert.equal(resolveSeatHandle(lobby, handle).ok, false, "the departed handle must not go on authorizing anything");

  // And it's really re-joinable — not just marked free in name only.
  const rejoined = await callTool(mcp, "join_match", { match_id: match.id });
  assert.equal(rejoined.body.result.isError, undefined);
  assert.equal(rejoined.body.result.structuredContent.seat_index, 0);
});

test("leave_match with an invalid or already-used handle is a tool execution error, not a crash", async () => {
  const lobby = createLobby();
  const mcp = mcpFor(lobby);
  const { body } = await callTool(mcp, "leave_match", { seat_handle: "garbage" });
  assert.equal(body.result.isError, true);
});
