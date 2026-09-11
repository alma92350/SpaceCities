import { test } from "node:test";
import assert from "node:assert/strict";
import { createLobby } from "../server/lobby.js";
import { createMcpServer, PROTOCOL_VERSION } from "../net/mcp.js";
import { resolveSeatHandle, mintSeatHandle } from "../server/mcpSeatHandle.js";
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

function mcpFor(lobby, onSeatsFilled, opts) {
  return createMcpServer({ tools: createLobbyTools(lobby, onSeatsFilled, opts) });
}

// A second lobby VIEW over the same match objects — for asserting a different tool policy against
// state a previous assertion already moved, without rebuilding the fixture.
function createLobbyWith(match) {
  const lobby = createLobby();
  lobby.matches.set(match.id, match);
  return lobby;
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

test("createLobbyTools registers the full lobby surface: create/list/join/leave/watch, plus seat recovery", () => {
  const tools = createLobbyTools(createLobby());
  assert.deepEqual(tools.map(t => t.name).sort(),
    ["create_match", "find_my_seats", "get_match_report", "join_match", "leave_match", "list_matches", "reclaim_seat", "watch_match"]);
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
  // idle_seconds is present only for a seat someone actually holds, and is elapsed time rather
  // than a fixed value — checked separately from the shape it rides along with.
  assert.equal(listed.seats[0].idle_seconds >= 0, true);
  assert.deepEqual(listed.seats.map(({ idle_seconds, ...rest }) => rest), [
    { kind: "open", taken: true, controller: "human" },
    { kind: "open", taken: false, controller: "human" },
  ]);
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
  // The code alone leaves a caller guessing its next call; every lobby rejection also names the
  // recovery (server/mcpSeatHandle.js CODE_GUIDANCE), same contract as a rejected command's hint.
  assert.match(noSuchMatch.body.result.content[0].text, /list_matches/);

  const seatTaken = await callTool(mcp, "join_match", { match_id: match.id, seat_index: 0 });
  assert.equal(seatTaken.body.result.isError, true);
  assert.match(seatTaken.body.result.content[0].text, /seat-taken/);
  assert.match(seatTaken.body.result.content[0].text, /list_matches/);

  const alreadyStarted = await callTool(mcp, "join_match", { match_id: startedMatch.id });
  assert.equal(alreadyStarted.body.result.isError, true);
  assert.match(alreadyStarted.body.result.content[0].text, /already-started/);
  assert.match(alreadyStarted.body.result.content[0].text, /client_id|watch_match/, "…and points at what DOES apply to a started match");
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

/* ============================================================
   Seating a match over MCP: who plays each seat (create_match), getting BACK IN after losing a
   handle (join_match's client_id, find_my_seats), and watching without playing (watch_match).
   ============================================================ */

test("create_match seats each side independently — an AI on seat 0, an agent on seat 1, each with its own AI pick", async () => {
  const lobby = createLobby();
  const mcp = mcpFor(lobby);

  const { body } = await callTool(mcp, "create_match", {
    seats: [{ controller: "ai", ai_strategy: "economic", difficulty: "hard" }, { controller: "agent" }],
  });
  assert.equal(body.result.isError, undefined, JSON.stringify(body.result));
  const match = lobby.getMatch(body.result.structuredContent.match_id);
  assert.deepEqual(match.seats.map(s => s.kind), ["ai", "agent"]);
  // The AI pick is stored per SEAT, not match-wide — which is what lets the two seats run
  // different opponents in the same match.
  assert.deepEqual(match.seats[0].ai, { strategy: "economic", difficulty: "hard" });
  assert.equal(match.seats[1].ai, null);
});

test("create_match with join_as hands back a working seat_handle for the seat it just claimed", async () => {
  const lobby = createLobby();
  const mcp = mcpFor(lobby);
  const { body } = await callTool(mcp, "create_match", { seats: [{ controller: "agent" }, { controller: "human" }], join_as: 0 });
  const { seat_handle, match_id, seat_index, owner } = body.result.structuredContent;
  assert.deepEqual({ seat_index, owner }, { seat_index: 0, owner: "player" });
  assert.deepEqual(resolveSeatHandle(lobby, seat_handle),
    { ok: true, matchId: match_id, seatIndex: 0, owner: "player", token: lobby.getMatch(match_id).seats[0].token, watching: false });
});

test("create_match reports `started` from the SAME rule every join goes through — an all-AI match needs no joiner", async () => {
  const lobby = createLobby();
  const seen = [];
  // The caller's own "is this ready, and did it start" hook (tools/serve.js's startAndSpawnIfReady).
  const mcp = mcpFor(lobby, async match => { seen.push(match.id); return match.seats.every(s => s.kind === "ai" || s.owner); });

  const allAi = await callTool(mcp, "create_match", { seats: [{ controller: "ai" }, { controller: "ai" }] });
  assert.equal(allAi.body.result.structuredContent.started, true);

  const waiting = await callTool(mcp, "create_match", { seats: [{ controller: "agent" }, { controller: "agent" }] });
  assert.equal(waiting.body.result.structuredContent.started, false, "two unclaimed agent seats are not a startable match");
  assert.equal(seen.length, 2, "the hook is consulted for every created match, not only the ones that start");
});

test("create_match rejects an unknown controller and a wrong seat count as tool errors, never a crash", async () => {
  const mcp = mcpFor(createLobby());
  const bad = await callTool(mcp, "create_match", { seats: [{ controller: "robot" }, { controller: "ai" }] });
  assert.equal(bad.body.result.isError, true);
  assert.match(bad.body.result.content[0].text, /bad-controller/);

  const wrongCount = await callTool(mcp, "create_match", { seats: [{ controller: "ai" }] });
  assert.equal(wrongCount.body.result.isError, true);
  assert.match(wrongCount.body.result.content[0].text, /bad-seats/);
});

test("an 'agent' seat is genuinely joinable — the kind says who is expected, it does not lock the seat", async () => {
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["agent", "ai"] });
  const mcp = mcpFor(lobby);
  const { body } = await callTool(mcp, "join_match", { match_id: match.id, seat_index: 0 });
  assert.equal(body.result.isError, undefined, JSON.stringify(body.result));
  assert.equal(body.result.structuredContent.owner, "player");
});

test("join_match with the same client_id REJOINS the same seat — the recovery path after losing a handle", async () => {
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const mcp = mcpFor(lobby);

  const first = await callTool(mcp, "join_match", { match_id: match.id, seat_index: 0, client_id: "agent-alpha" });
  const again = await callTool(mcp, "join_match", { match_id: match.id, client_id: "agent-alpha" });

  assert.equal(again.body.result.isError, undefined, JSON.stringify(again.body.result));
  assert.equal(again.body.result.structuredContent.rejoined, true);
  assert.equal(again.body.result.structuredContent.seat_handle, first.body.result.structuredContent.seat_handle,
    "the same seat, the same token — a rejoin re-mints the handle it already had, it does not take a second seat");
  assert.equal(lobby.getMatch(match.id).seats[1].owner, null, "rejoining must never consume the OTHER seat");
});

test("a rejoin works on a STARTED match — which is exactly when it matters, and when a fresh join is refused", async () => {
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "ai"] });
  const mcp = mcpFor(lobby);
  await callTool(mcp, "join_match", { match_id: match.id, seat_index: 0, client_id: "agent-alpha" });
  lobby.startMatch(match.id);

  const back = await callTool(mcp, "join_match", { match_id: match.id, client_id: "agent-alpha" });
  assert.equal(back.body.result.isError, undefined, JSON.stringify(back.body.result));
  assert.equal(back.body.result.structuredContent.started, true);
  assert.equal(resolveSeatHandle(lobby, back.body.result.structuredContent.seat_handle).ok, true);

  // A DIFFERENT client is still refused — rejoining is not a back door into a running match.
  const stranger = await callTool(mcp, "join_match", { match_id: match.id, client_id: "someone-else" });
  assert.equal(stranger.body.result.isError, true);
  assert.match(stranger.body.result.content[0].text, /already-started/);
});

test("find_my_seats returns every seat a client holds, with usable handles, and nothing for an unknown client", async () => {
  const lobby = createLobby();
  const a = lobby.createMatch({ seatKinds: ["open", "ai"] });
  const b = lobby.createMatch({ seatKinds: ["open", "ai"] });
  const mcp = mcpFor(lobby);
  await callTool(mcp, "join_match", { match_id: a.id, seat_index: 0, client_id: "agent-alpha" });
  await callTool(mcp, "join_match", { match_id: b.id, seat_index: 0, client_id: "agent-alpha" });

  const { body } = await callTool(mcp, "find_my_seats", { client_id: "agent-alpha" });
  const seats = body.result.structuredContent.seats;
  assert.deepEqual(seats.map(s => s.match_id).sort(), [a.id, b.id].sort());
  for (const s of seats) assert.equal(resolveSeatHandle(lobby, s.seat_handle).ok, true);

  const none = await callTool(mcp, "find_my_seats", { client_id: "nobody" });
  assert.deepEqual(none.body.result.structuredContent.seats, []);
});

test("watch_match mints a handle that holds no seat, and is refused when the host disabled spectators", async () => {
  const lobby = createLobby();
  const open = lobby.createMatch({ seatKinds: ["open", "ai"] });
  const closed = lobby.createMatch({ seatKinds: ["open", "ai"], spectatorsEnabled: false });
  const mcp = mcpFor(lobby);

  const { body } = await callTool(mcp, "watch_match", { match_id: open.id });
  const resolved = resolveSeatHandle(lobby, body.result.structuredContent.watch_handle);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.watching, true);
  assert.equal(resolved.token, null, "a watcher holds no credential, because it holds no seat");
  assert.deepEqual(open.seats.map(s => s.owner), [null, null], "watching costs no seat — a real player can still join");

  const denied = await callTool(mcp, "watch_match", { match_id: closed.id });
  assert.equal(denied.body.result.isError, true);
  assert.match(denied.body.result.content[0].text, /spectators-disabled/);
});

test("leave_match refuses a watch handle — there is no seat behind it to give up", async () => {
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "ai"] });
  const mcp = mcpFor(lobby);
  const watch = (await callTool(mcp, "watch_match", { match_id: match.id })).body.result.structuredContent.watch_handle;

  const { body } = await callTool(mcp, "leave_match", { seat_handle: watch });
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /watch-only-handle/);
});

/* ============================================================
   RECOVERY WITHOUT FORESIGHT, and the end-of-match report. The client_id rejoin above only helps an
   agent that passed a client_id BEFORE it lost its handle — which an agent that has just been
   compacted did not. These are the paths that work anyway: find the match again (it is running, so
   the default listing hides it), take back a seat nobody is driving, and learn how it all ended.
   ============================================================ */

test("list_matches hides a running match by default and finds it with include_started — the 'my match vanished' case", async () => {
  const lobby = createLobby();
  const open = lobby.createMatch({ seatKinds: ["open", "ai"] });
  const running = lobby.createMatch({ seatKinds: ["open", "ai"] });
  lobby.joinMatch(running.id, 0);
  lobby.startMatch(running.id);
  const mcp = mcpFor(lobby);

  const byDefault = await callTool(mcp, "list_matches", {});
  assert.deepEqual(byDefault.body.result.structuredContent.matches.map(m => m.id), [open.id],
    "the default listing is 'what can I join', which a running match is not");

  const all = await callTool(mcp, "list_matches", { include_started: true });
  assert.deepEqual(all.body.result.structuredContent.matches.map(m => m.id).sort(), [open.id, running.id].sort());
  const listed = all.body.result.structuredContent.matches.find(m => m.id === running.id);
  assert.equal(listed.status, "started");
  assert.equal(typeof listed.seats[0].idle_seconds, "number", "a held seat reports how long its holder has been silent");
});

test("reclaim_seat takes back a seat whose holder has gone silent, and refuses one still playing", async () => {
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "ai"] });
  lobby.joinMatch(match.id, 0);
  lobby.startMatch(match.id);
  const mcp = mcpFor(lobby, undefined, { seatReclaim: { enabled: true, staleMs: 60000 } });

  // Still active: the seat was just joined, so its holder is by definition present.
  const tooSoon = await callTool(mcp, "reclaim_seat", { match_id: match.id, seat_index: 0 });
  assert.equal(tooSoon.body.result.isError, true);
  assert.match(tooSoon.body.result.content[0].text, /seat-still-active/);

  // Now silent for longer than the window — the compacted-agent case.
  lobby.touchSeat(match.id, 0, Date.now() - 120000);
  const taken = await callTool(mcp, "reclaim_seat", { match_id: match.id, seat_index: 0, client_id: "agent-alpha" });
  assert.equal(taken.body.result.isError, undefined, JSON.stringify(taken.body.result));
  const sc = taken.body.result.structuredContent;
  assert.equal(sc.reclaimed, true);
  assert.equal(sc.owner, "player");
  assert.ok(sc.previous_holder_idle_seconds >= 60);
  assert.equal(resolveSeatHandle(lobby, sc.seat_handle).ok, true, "the handed-back handle really drives that seat");
});

test("reclaiming ROTATES the token, so the abandoned holder's old handle stops working — never two clients on one seat", async () => {
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "ai"] });
  const joined = lobby.joinMatch(match.id, 0);
  lobby.startMatch(match.id);
  const oldHandle = mintSeatHandle(match.id, 0, joined.token);
  assert.equal(resolveSeatHandle(lobby, oldHandle).ok, true);

  lobby.touchSeat(match.id, 0, Date.now() - 120000);
  const mcp = mcpFor(lobby, undefined, { seatReclaim: { enabled: true, staleMs: 60000 } });
  await callTool(mcp, "reclaim_seat", { match_id: match.id, seat_index: 0 });

  assert.equal(resolveSeatHandle(lobby, oldHandle).ok, false, "the previous holder's handle is retired by the reclaim");
});

test("reclaim_seat picks the longest-silent seat when none is named, and can be switched off entirely", async () => {
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  lobby.joinMatch(match.id, 0);
  lobby.joinMatch(match.id, 1);
  lobby.startMatch(match.id);
  lobby.touchSeat(match.id, 0, Date.now() - 70000);
  lobby.touchSeat(match.id, 1, Date.now() - 300000);

  const open = mcpFor(lobby, undefined, { seatReclaim: { enabled: true, staleMs: 60000 } });
  const picked = await callTool(open, "reclaim_seat", { match_id: match.id });
  assert.equal(picked.body.result.structuredContent.seat_index, 1, "the seat silent longest is the one to take back");

  const locked = mcpFor(createLobbyWith(match), undefined, { seatReclaim: { enabled: false } });
  const refused = await callTool(locked, "reclaim_seat", { match_id: match.id });
  assert.equal(refused.body.result.isError, true);
  assert.match(refused.body.result.content[0].text, /seat-reclaim-disabled/);
});

test("get_match_report answers for a finished match — including one whose worker and live state are long gone", async () => {
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["agent", "ai"] });
  lobby.joinMatch(match.id, 0);
  lobby.startMatch(match.id);
  const result = {
    matchId: match.id, owners: ["player", "ai"], winner: "ai", winReason: "commandCenterDestroyed",
    tick: 12000, time: 600, endedAt: Date.now(),
    sides: [{ owner: "player", units: 0, buildings: 0, won: false }, { owner: "ai", units: 14, buildings: 6, won: true }],
  };
  // No live match at all — exactly the state after a worker exits, or after a server restart.
  const mcp = mcpFor(lobby, undefined, { getResult: id => (id === match.id ? result : null) });

  const { body } = await callTool(mcp, "get_match_report", { match_id: match.id });
  assert.equal(body.result.isError, undefined, JSON.stringify(body.result));
  assert.equal(body.result.structuredContent.finished, true);
  assert.deepEqual(body.result.structuredContent.result, result);
  assert.match(body.result.content[0].text, /ai won \(commandCenterDestroyed\)/);
  assert.match(body.result.content[0].text, /10m00s/);
});

test("get_match_report on a match still in progress says so, rather than erroring", async () => {
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "ai"] });
  lobby.startMatch(match.id);
  const mcp = mcpFor(lobby);

  const { body } = await callTool(mcp, "get_match_report", { match_id: match.id });
  assert.equal(body.result.isError, undefined);
  assert.deepEqual(
    { finished: body.result.structuredContent.finished, status: body.result.structuredContent.status, result: body.result.structuredContent.result },
    { finished: false, status: "started", result: null });
});

test("find_my_seats carries a finished match's own result, so recovering never needs a second call to learn it is over", async () => {
  const lobby = createLobby();
  const match = lobby.createMatch({ seatKinds: ["open", "ai"] });
  lobby.joinMatch(match.id, 0, "agent-alpha");
  lobby.startMatch(match.id);
  const result = { matchId: match.id, winner: "ai", winReason: "commandCenterDestroyed", time: 300 };
  const mcp = mcpFor(lobby, undefined, { getResult: id => (id === match.id ? result : null) });

  const { body } = await callTool(mcp, "find_my_seats", { client_id: "agent-alpha" });
  const seat = body.result.structuredContent.seats[0];
  assert.equal(seat.status, "finished");
  assert.deepEqual(seat.result, result);
});
