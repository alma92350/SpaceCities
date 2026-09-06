import { test } from "node:test";
import assert from "node:assert/strict";
import { createLobby } from "../server/lobby.js";
import { createMcpServer, PROTOCOL_VERSION } from "../net/mcp.js";
import { mintSeatHandle, resolveSeatHandle, withSeat } from "../server/mcpSeatHandle.js";

/* ============================================================
   T-049a (FR-13): the MCP spec's own "Stateful Tools" pattern
   (modelcontextprotocol.io/specification/2026-07-28/server/tools#stateful-tools) applied to
   this game's EXISTING per-seat bearer token, not a new credential concept — wrap, don't
   rewrite (ADR-0006 D1). server/lobby.js's own joinMatch already mints a real, unguessable
   per-seat token and reclaimSeat already validates one; a seat handle here is just that same
   {matchId, seatIndex, token} triple, opaque-encoded into ONE string so an agent never has to
   track three separate fields itself — "opaque identifiers... do not [invite parsing or
   guessing]," the spec's own guidance on handle design.

   Deliberately NOT this task's job, matching T-049's own "tools registered later" scoping:
   the real `join_match` MCP tool that would mint a handle for a real agent (T-051's own row).
   These tests mint handles directly via lobby.joinMatch() — a real, correct stand-in for what
   join_match will do once it exists — so the MECHANISM (mint once, present on every later
   call, reject on tamper) is fully proven now rather than blocked on T-051 landing first,
   exactly the "build the piece, then wire it" staging test/lobby.test.js's own header already
   named for T-033/T-034/T-035.
   ============================================================ */

function twoSeatMatch(lobby) {
  const match = lobby.createMatch({ seatKinds: ["open", "open"] });
  const p0 = lobby.joinMatch(match.id, 0);
  const p1 = lobby.joinMatch(match.id, 1);
  return { match, p0, p1 };
}

test("mintSeatHandle + resolveSeatHandle round-trips to the real owner for a genuinely joined seat", () => {
  const lobby = createLobby();
  const { match, p0 } = twoSeatMatch(lobby);
  const handle = mintSeatHandle(match.id, 0, p0.token);

  const resolved = resolveSeatHandle(lobby, handle);
  assert.deepEqual(resolved, { ok: true, matchId: match.id, seatIndex: 0, owner: "player", token: p0.token });
});

test("a handle minted for seat 1 resolves to seat 1's own owner, not seat 0's", () => {
  const lobby = createLobby();
  const { match, p1 } = twoSeatMatch(lobby);
  const handle = mintSeatHandle(match.id, 1, p1.token);
  assert.deepEqual(resolveSeatHandle(lobby, handle), { ok: true, matchId: match.id, seatIndex: 1, owner: "ai", token: p1.token });
});

test("a handle with the right shape but a WRONG token is rejected, not silently trusted", () => {
  const lobby = createLobby();
  const { match } = twoSeatMatch(lobby);
  const forged = mintSeatHandle(match.id, 0, "00000000-0000-0000-0000-000000000000");
  const resolved = resolveSeatHandle(lobby, forged);
  assert.equal(resolved.ok, false);
  assert.equal(resolved.code, "bad-token");
});

/* ============================================================
   T-050 (FR-18): "an agent can act only on its own seat" is not a NEW property this file
   introduces — resolveSeatHandle already replays server/lobby.js's own reclaimSeat, and each
   seat's token is independently minted (joinMatch's own randomUUID() per call, never derived
   from the other seat's) — but a property nobody has tried to BREAK isn't proven, only assumed.
   These are the adversarial attempts: not "a wrong token" in the abstract (already covered
   above), but a REAL, valid credential for one seat deliberately relabeled to claim another.
   ============================================================ */

test("T-050: seat 0's own REAL token, relabeled to claim seat 1, is rejected — a valid credential for the WRONG seat is not a valid credential", () => {
  const lobby = createLobby();
  const { match, p0 } = twoSeatMatch(lobby);
  const impersonation = mintSeatHandle(match.id, 1, p0.token);   // seat 0's real token, seatIndex swapped to 1
  const resolved = resolveSeatHandle(lobby, impersonation);
  assert.equal(resolved.ok, false, "seat 0's token must never resolve as seat 1, no matter what the handle CLAIMS its seatIndex is");
  assert.equal(resolved.code, "bad-token");
});

test("T-050: withSeat given seat 0's real handle can never observe seat 1's identity, and vice versa — full cross-seat matrix", async () => {
  const lobby = createLobby();
  const { match, p0, p1 } = twoSeatMatch(lobby);
  const handle0 = mintSeatHandle(match.id, 0, p0.token);
  const handle1 = mintSeatHandle(match.id, 1, p1.token);
  const crossed0as1 = mintSeatHandle(match.id, 1, p0.token);
  const crossed1as0 = mintSeatHandle(match.id, 0, p1.token);

  const seen = [];
  const handler = withSeat(lobby, ({ seat }) => { seen.push(seat.owner); return { content: [] }; });

  await handler({ seat_handle: handle0 });
  await handler({ seat_handle: handle1 });
  assert.deepEqual(seen, ["player", "ai"], "each seat's own real handle resolves to exactly its own owner");

  const crossResult0 = await handler({ seat_handle: crossed0as1 });
  const crossResult1 = await handler({ seat_handle: crossed1as0 });
  assert.equal(crossResult0.isError, true, "seat 0's token cannot be relabeled to act as seat 1");
  assert.equal(crossResult1.isError, true, "seat 1's token cannot be relabeled to act as seat 0");
  assert.deepEqual(seen, ["player", "ai"], "neither cross-seat attempt ever reached the handler at all");
});

test("a handle naming a match that no longer exists (or never did) is rejected, not thrown", () => {
  const lobby = createLobby();
  const handle = mintSeatHandle("no-such-match", 0, "any-token");
  assert.deepEqual(resolveSeatHandle(lobby, handle), { ok: false, code: "no-such-match" });
});

test("a handle naming an out-of-range seat index is rejected, not thrown", () => {
  const lobby = createLobby();
  const { match, p0 } = twoSeatMatch(lobby);
  const handle = mintSeatHandle(match.id, 7, p0.token);
  assert.deepEqual(resolveSeatHandle(lobby, handle), { ok: false, code: "no-such-seat" });
});

test("a garbage string is never a valid handle — malformed base64/JSON is rejected gracefully, never thrown", () => {
  const lobby = createLobby();
  for (const garbage of ["not-base64!!!", "", Buffer.from("not json at all").toString("base64url"), Buffer.from(JSON.stringify({ matchId: 5, seatIndex: "x", token: null })).toString("base64url")]) {
    assert.doesNotThrow(() => resolveSeatHandle(lobby, garbage));
    assert.equal(resolveSeatHandle(lobby, garbage).ok, false);
  }
});

test("withSeat calls the wrapped handler with the resolved seat when the handle is valid", async () => {
  const lobby = createLobby();
  const { match, p0 } = twoSeatMatch(lobby);
  const handle = mintSeatHandle(match.id, 0, p0.token);

  let receivedSeat = null;
  const handler = withSeat(lobby, ({ seat, ...rest }) => {
    receivedSeat = seat;
    return { content: [{ type: "text", text: `hi ${seat.owner}, extra=${rest.extra}` }] };
  });

  const result = await handler({ seat_handle: handle, extra: "x" });
  assert.deepEqual(receivedSeat, { ok: true, matchId: match.id, seatIndex: 0, owner: "player", token: p0.token });
  assert.deepEqual(result.content, [{ type: "text", text: "hi player, extra=x" }]);
});

test("withSeat reports an invalid handle as a TOOL EXECUTION error (isError:true), never calling the wrapped handler", async () => {
  const lobby = createLobby();
  let called = false;
  const handler = withSeat(lobby, () => { called = true; return { content: [] }; });

  const result = await handler({ seat_handle: "garbage" });
  assert.equal(called, false, "the wrapped handler must never run against an unresolved seat");
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /seat handle/i);
});

test("withSeat rejects a MISSING seat_handle argument the same way as an invalid one, not a crash", async () => {
  const lobby = createLobby();
  const handler = withSeat(lobby, () => ({ content: [] }));
  const result = await handler({});
  assert.equal(result.isError, true);
});

test("end to end through the real MCP transport: a handle minted from a real join authorizes a tools/call, and a tampered one does not", async () => {
  const lobby = createLobby();
  const { match, p0 } = twoSeatMatch(lobby);
  const validHandle = mintSeatHandle(match.id, 0, p0.token);
  const tamperedHandle = mintSeatHandle(match.id, 0, "wrong-token");

  const mcp = createMcpServer({
    tools: [{
      name: "whoami", description: "reports the calling seat", inputSchema: { type: "object", properties: { seat_handle: { type: "string" } }, required: ["seat_handle"] },
      handler: withSeat(lobby, ({ seat }) => ({ content: [{ type: "text", text: seat.owner }] })),
    }],
  });

  function call(seatHandle) {
    const body = {
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: {
        name: "whoami", arguments: { seat_handle: seatHandle },
        _meta: { "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION, "io.modelcontextprotocol/clientCapabilities": {} },
      },
    };
    return mcp.handleRequest({
      httpMethod: "POST",
      headers: { "mcp-protocol-version": PROTOCOL_VERSION, "mcp-method": "tools/call", "mcp-name": "whoami" },
      rawBody: JSON.stringify(body),
    });
  }

  const good = await call(validHandle);
  assert.equal(good.status, 200);
  assert.deepEqual(good.body.result.content, [{ type: "text", text: "player" }]);
  assert.equal(good.body.result.isError, undefined);

  const bad = await call(tamperedHandle);
  assert.equal(bad.status, 200, "a rejected seat handle is a TOOL execution error, not a transport-level HTTP failure");
  assert.equal(bad.body.result.isError, true);
});
