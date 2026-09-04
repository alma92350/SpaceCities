import { test } from "node:test";
import assert from "node:assert/strict";
import { createMcpServer, PROTOCOL_VERSION, ERROR_CODES } from "../net/mcp.js";

/* ============================================================
   T-049 (FR-13, NFR-5): golden-transcript tests for the Streamable HTTP +
   JSON-RPC 2.0 MCP transport core, against protocol revision 2026-07-28 —
   verified against the live spec (modelcontextprotocol.io/specification/
   2026-07-28), NOT from training-data memory of an earlier MCP shape: this
   revision REMOVED the initialize/initialized handshake, Mcp-Session-Id,
   the GET SSE endpoint, and Last-Event-ID resumability entirely, and added
   per-request MCP-Protocol-Version/Mcp-Method/Mcp-Name headers that MUST
   match the JSON-RPC body, a mandatory server/discover method, and a
   resultType discriminator on every successful result.

   handleRequest is transport-agnostic on purpose (plain {httpMethod,
   origin, headers, rawBody} in, {status, body} out) so this file can drive
   it directly with golden transcripts; test/httpServer.test.js (later)
   exercises the same logic over a REAL http.Server with Node's own
   built-in fetch() — "a real MCP client" per this task's own exit
   criterion, without adding the official SDK as even a dev dependency
   (package.json's own description: "No dependencies, no build step").
   ============================================================ */

const CLIENT_INFO = { name: "TestClient", version: "1.0.0" };

function meta(extra = {}) {
  return {
    "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
    "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
    "io.modelcontextprotocol/clientCapabilities": {},
    ...extra,
  };
}

// A full, spec-conformant request envelope: correct headers, correct _meta — the "everything is
// right" baseline every negative test starts from and deliberately breaks ONE thing at a time.
function req({ id = 1, method, params = {}, headers = {}, protocolVersion = PROTOCOL_VERSION } = {}) {
  const body = { jsonrpc: "2.0", id, method, params: { ...params, _meta: meta({ "io.modelcontextprotocol/protocolVersion": protocolVersion }) } };
  const h = { "content-type": "application/json", "mcp-protocol-version": protocolVersion, "mcp-method": method, ...headers };
  if (params.name !== undefined && h["mcp-name"] === undefined) h["mcp-name"] = params.name;
  if (params.uri !== undefined && h["mcp-name"] === undefined) h["mcp-name"] = params.uri;
  return { httpMethod: "POST", headers: h, rawBody: JSON.stringify(body) };
}

function echoTool() {
  return {
    name: "echo",
    title: "Echo",
    description: "Echoes its input back",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    handler: (args) => ({ content: [{ type: "text", text: args.text }] }),
  };
}

function failingTool() {
  return {
    name: "always_fails",
    description: "Always reports a tool execution error",
    inputSchema: { type: "object", additionalProperties: false },
    handler: () => ({ content: [{ type: "text", text: "could not complete: bad input" }], isError: true }),
  };
}

function throwingTool() {
  return {
    name: "throws",
    description: "Throws an unexpected internal error",
    inputSchema: { type: "object", additionalProperties: false },
    handler: () => { throw new Error("boom"); },
  };
}

test("server/discover returns the supported version, capabilities, and server info", async () => {
  const mcp = createMcpServer({ serverInfo: { name: "SpaceCitiesMCP", version: "1.0.0" }, instructions: "Play a match." });
  const { status, body } = await mcp.handleRequest(req({ method: "server/discover" }));

  assert.equal(status, 200);
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.id, 1);
  assert.equal(body.result.resultType, "complete");
  assert.deepEqual(body.result.supportedVersions, [PROTOCOL_VERSION]);
  assert.deepEqual(body.result.capabilities, { tools: {} });
  assert.deepEqual(body.result._meta["io.modelcontextprotocol/serverInfo"], { name: "SpaceCitiesMCP", version: "1.0.0" });
  assert.equal(body.result.instructions, "Play a match.");
});

test("tools/list returns an empty list for a server with no registered tools", async () => {
  const mcp = createMcpServer();
  const { status, body } = await mcp.handleRequest(req({ method: "tools/list" }));
  assert.equal(status, 200);
  assert.equal(body.result.resultType, "complete");
  assert.deepEqual(body.result.tools, []);
  assert.equal(body.result.nextCursor, undefined);
});

test("tools/list returns every registered tool's full definition, in registration order", async () => {
  const mcp = createMcpServer({ tools: [echoTool(), failingTool()] });
  const { body } = await mcp.handleRequest(req({ method: "tools/list" }));
  assert.deepEqual(body.result.tools.map(t => t.name), ["echo", "always_fails"]);
  assert.deepEqual(body.result.tools[0], {
    name: "echo", title: "Echo", description: "Echoes its input back",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  });
});

test("tools/list paginates when the registry is larger than one page", async () => {
  const tools = Array.from({ length: 5 }, (_, i) => ({ name: `t${i}`, description: "d", inputSchema: { type: "object" }, handler: () => ({ content: [] }) }));
  const mcp = createMcpServer({ tools, pageSize: 2 });

  const page1 = await mcp.handleRequest(req({ method: "tools/list" }));
  assert.deepEqual(page1.body.result.tools.map(t => t.name), ["t0", "t1"]);
  assert.ok(page1.body.result.nextCursor);

  const page2 = await mcp.handleRequest(req({ method: "tools/list", params: { cursor: page1.body.result.nextCursor } }));
  assert.deepEqual(page2.body.result.tools.map(t => t.name), ["t2", "t3"]);
  assert.ok(page2.body.result.nextCursor);

  const page3 = await mcp.handleRequest(req({ method: "tools/list", params: { cursor: page2.body.result.nextCursor } }));
  assert.deepEqual(page3.body.result.tools.map(t => t.name), ["t4"]);
  assert.equal(page3.body.result.nextCursor, undefined, "the last page carries no further cursor");
});

test("tools/call invokes the matching tool's handler and wraps its result", async () => {
  const mcp = createMcpServer({ tools: [echoTool()] });
  const { status, body } = await mcp.handleRequest(req({ method: "tools/call", params: { name: "echo", arguments: { text: "hi" } } }));

  assert.equal(status, 200);
  assert.equal(body.result.resultType, "complete");
  assert.deepEqual(body.result.content, [{ type: "text", text: "hi" }]);
  assert.equal(body.result.isError, undefined, "a successful call carries no isError field at all");
});

test("tools/call passes structuredContent through unchanged when the handler returns it", async () => {
  const mcp = createMcpServer({
    tools: [{
      name: "get_thing", description: "d", inputSchema: { type: "object" },
      handler: () => ({ content: [{ type: "text", text: "{}" }], structuredContent: { a: 1 } }),
    }],
  });
  const { body } = await mcp.handleRequest(req({ method: "tools/call", params: { name: "get_thing", arguments: {} } }));
  assert.deepEqual(body.result.structuredContent, { a: 1 });
});

test("tools/call on an unknown tool name is a PROTOCOL error (-32602), not a tool execution error", async () => {
  const mcp = createMcpServer({ tools: [echoTool()] });
  const { status, body } = await mcp.handleRequest(req({ method: "tools/call", params: { name: "nonexistent", arguments: {} } }));

  assert.equal(status, 400);
  assert.equal(body.error.code, ERROR_CODES.INVALID_PARAMS);
  assert.match(body.error.message, /nonexistent/);
  assert.equal(body.result, undefined);
});

test("a tool handler reporting isError:true surfaces as a TOOL EXECUTION error, HTTP 200, not a JSON-RPC error", async () => {
  const mcp = createMcpServer({ tools: [failingTool()] });
  const { status, body } = await mcp.handleRequest(req({ method: "tools/call", params: { name: "always_fails", arguments: {} } }));

  assert.equal(status, 200, "a tool execution error is still a successful JSON-RPC result, per spec");
  assert.equal(body.result.resultType, "complete");
  assert.equal(body.result.isError, true);
  assert.equal(body.error, undefined);
});

test("a tool handler that throws is caught and reported as an internal error, never crashes the transport", async () => {
  const mcp = createMcpServer({ tools: [throwingTool()] });
  const { status, body } = await mcp.handleRequest(req({ method: "tools/call", params: { name: "throws", arguments: {} } }));

  assert.equal(status, 500);
  assert.equal(body.error.code, ERROR_CODES.INTERNAL_ERROR);
});

test("an unknown METHOD (not just an unknown tool) is rejected 404 with JSON-RPC -32601", async () => {
  const mcp = createMcpServer();
  const { status, body } = await mcp.handleRequest(req({ method: "totally/madeup" }));
  assert.equal(status, 404);
  assert.equal(body.error.code, ERROR_CODES.METHOD_NOT_FOUND);
});

test("GET to the MCP endpoint is 405 — this revision has no GET SSE stream endpoint at all", async () => {
  const mcp = createMcpServer();
  const { status } = await mcp.handleRequest({ httpMethod: "GET", headers: {}, rawBody: "" });
  assert.equal(status, 405);
});

test("DELETE to the MCP endpoint is 405 — this revision has no session to terminate", async () => {
  const mcp = createMcpServer();
  const { status } = await mcp.handleRequest({ httpMethod: "DELETE", headers: {}, rawBody: "" });
  assert.equal(status, 405);
});

test("malformed JSON body is rejected with -32700 Parse error", async () => {
  const mcp = createMcpServer();
  const { status, body } = await mcp.handleRequest({ httpMethod: "POST", headers: { "mcp-protocol-version": PROTOCOL_VERSION }, rawBody: "{not json" });
  assert.equal(status, 400);
  assert.equal(body.error.code, ERROR_CODES.PARSE_ERROR);
});

test("a body that isn't a valid JSON-RPC request is rejected with -32600 Invalid Request", async () => {
  const mcp = createMcpServer();
  const { status, body } = await mcp.handleRequest({
    httpMethod: "POST", headers: { "mcp-protocol-version": PROTOCOL_VERSION },
    rawBody: JSON.stringify({ jsonrpc: "2.0" }),   // no method at all
  });
  assert.equal(status, 400);
  assert.equal(body.error.code, ERROR_CODES.INVALID_REQUEST);
});

test("a well-formed notification (no id) is accepted: 202, no body", async () => {
  const mcp = createMcpServer();
  const body = { jsonrpc: "2.0", method: "notifications/whatever", params: {} };
  const { status, body: respBody } = await mcp.handleRequest({
    httpMethod: "POST", headers: { "mcp-protocol-version": PROTOCOL_VERSION, "mcp-method": "notifications/whatever" },
    rawBody: JSON.stringify(body),
  });
  assert.equal(status, 202);
  assert.equal(respBody, null);
});

test("a missing MCP-Protocol-Version header is rejected with -32020 HeaderMismatch", async () => {
  const mcp = createMcpServer();
  const r = req({ method: "server/discover" });
  delete r.headers["mcp-protocol-version"];
  const { status, body } = await mcp.handleRequest(r);
  assert.equal(status, 400);
  assert.equal(body.error.code, ERROR_CODES.HEADER_MISMATCH);
});

test("a missing Mcp-Method header is rejected with -32020 HeaderMismatch", async () => {
  const mcp = createMcpServer();
  const r = req({ method: "server/discover" });
  delete r.headers["mcp-method"];
  const { status, body } = await mcp.handleRequest(r);
  assert.equal(status, 400);
  assert.equal(body.error.code, ERROR_CODES.HEADER_MISMATCH);
});

test("an Mcp-Method header that disagrees with the body's own method is rejected with -32020 HeaderMismatch", async () => {
  const mcp = createMcpServer();
  const r = req({ method: "server/discover", headers: { "mcp-method": "tools/list" } });
  const { status, body } = await mcp.handleRequest(r);
  assert.equal(status, 400);
  assert.equal(body.error.code, ERROR_CODES.HEADER_MISMATCH);
});

test("tools/call without the required Mcp-Name header is rejected with -32020 HeaderMismatch", async () => {
  const mcp = createMcpServer({ tools: [echoTool()] });
  const r = req({ method: "tools/call", params: { name: "echo", arguments: { text: "hi" } } });
  delete r.headers["mcp-name"];
  const { status, body } = await mcp.handleRequest(r);
  assert.equal(status, 400);
  assert.equal(body.error.code, ERROR_CODES.HEADER_MISMATCH);
});

test("tools/call whose Mcp-Name header disagrees with params.name is rejected with -32020 HeaderMismatch", async () => {
  const mcp = createMcpServer({ tools: [echoTool()] });
  const r = req({ method: "tools/call", params: { name: "echo", arguments: { text: "hi" } }, headers: { "mcp-name": "not-echo" } });
  const { status, body } = await mcp.handleRequest(r);
  assert.equal(status, 400);
  assert.equal(body.error.code, ERROR_CODES.HEADER_MISMATCH);
});

test("a request declaring an unsupported protocol version gets UnsupportedProtocolVersionError (-32022), listing what IS supported", async () => {
  const mcp = createMcpServer();
  const r = req({ method: "server/discover", protocolVersion: "1900-01-01" });
  const { status, body } = await mcp.handleRequest(r);
  assert.equal(status, 400);
  assert.equal(body.error.code, ERROR_CODES.UNSUPPORTED_PROTOCOL_VERSION);
  assert.deepEqual(body.error.data.supported, [PROTOCOL_VERSION]);
  assert.equal(body.error.data.requested, "1900-01-01");
});

test("a request whose header protocol version disagrees with its own body _meta version is a HeaderMismatch, not silently resolved either way", async () => {
  const mcp = createMcpServer();
  const r = req({ method: "server/discover", headers: { "mcp-protocol-version": "2025-11-25" } });   // body _meta still says PROTOCOL_VERSION
  const { status, body } = await mcp.handleRequest(r);
  assert.equal(status, 400);
  assert.equal(body.error.code, ERROR_CODES.HEADER_MISMATCH);
});

test("a request missing the required _meta.protocolVersion field is -32602 Invalid params", async () => {
  const mcp = createMcpServer();
  const body = { jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: { "io.modelcontextprotocol/clientCapabilities": {} } } };
  const { status, body: respBody } = await mcp.handleRequest({
    httpMethod: "POST", headers: { "mcp-protocol-version": PROTOCOL_VERSION, "mcp-method": "server/discover" }, rawBody: JSON.stringify(body),
  });
  assert.equal(status, 400);
  assert.equal(respBody.error.code, ERROR_CODES.INVALID_PARAMS);
});

test("a request missing the required _meta.clientCapabilities field is -32602 Invalid params", async () => {
  const mcp = createMcpServer();
  const body = { jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: { "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION } } };
  const { status, body: respBody } = await mcp.handleRequest({
    httpMethod: "POST", headers: { "mcp-protocol-version": PROTOCOL_VERSION, "mcp-method": "server/discover" }, rawBody: JSON.stringify(body),
  });
  assert.equal(status, 400);
  assert.equal(respBody.error.code, ERROR_CODES.INVALID_PARAMS);
});

test("every successful result carries resultType:\"complete\" and the server's identity in _meta", async () => {
  const mcp = createMcpServer({ tools: [echoTool()], serverInfo: { name: "X", version: "9" } });
  for (const r of [req({ method: "server/discover" }), req({ method: "tools/list" }), req({ method: "tools/call", params: { name: "echo", arguments: { text: "z" } } })]) {
    const { body } = await mcp.handleRequest(r);
    assert.equal(body.result.resultType, "complete");
    assert.deepEqual(body.result._meta["io.modelcontextprotocol/serverInfo"], { name: "X", version: "9" });
  }
});

test("Origin validation: an allowed Origin passes, a disallowed one is rejected 403, and no Origin at all is never rejected", async () => {
  const mcp = createMcpServer({ allowedOrigins: ["https://good.example"] });

  const allowed = req({ method: "server/discover", headers: { origin: "https://good.example" } });
  assert.equal((await mcp.handleRequest(allowed)).status, 200);

  const disallowed = req({ method: "server/discover", headers: { origin: "https://evil.example" } });
  assert.equal((await mcp.handleRequest(disallowed)).status, 403);

  const noOrigin = req({ method: "server/discover" });
  assert.equal((await mcp.handleRequest(noOrigin)).status, 200, "an ABSENT Origin header is never itself a rejection reason");
});

test("with no allowedOrigins configured, every Origin is accepted (the permissive default for a publicly-reachable server)", async () => {
  const mcp = createMcpServer();
  const r = req({ method: "server/discover", headers: { origin: "https://anything.example" } });
  assert.equal((await mcp.handleRequest(r)).status, 200);
});
