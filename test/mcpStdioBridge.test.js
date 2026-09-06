/* ============================================================
   Guards for tools/mcpStdioBridge.js — the STDIO front door onto net/mcp.js's HTTP server.

   This file shipped with no tests at all, and it is the worst place in the repo for that: it is
   an EXTERNAL CONTRACT SURFACE. Every generic MCP client — Claude Code included — reaches this
   project through this translation layer and nothing else, so a defect here is invisible to the
   3200 tests that exercise the server itself and shows up as "the tools don't work" in somebody
   else's client, with no stack trace on this side.

   Three specific things are worth pinning, because each one fails silently rather than loudly:

     1. THE HANDSHAKE. The whole reason this file exists is that the real server deliberately has
        no initialize/initialized handshake (net/mcp.js, protocol 2026-07-28) and conventional
        clients require one. If the synthesized handshake regresses, a client cannot even begin.
     2. THE REQUEST SHAPE. The bridge re-derives the header/_meta contract tools/mcpClient.js
        established — MCP-Protocol-Version, Mcp-Method, and Mcp-Name for name-or-uri methods only.
        net/mcp.js validates all of it, so a drift here is a rejected request for every relayed
        method at once.
     3. STDOUT DISCIPLINE. STDIO MCP allows nothing on stdout but newline-delimited JSON-RPC. A
        stray extra write corrupts the stream for the whole session, and the failure surfaces as a
        parse error in the client rather than anything this process would notice.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { PROTOCOL_VERSION } from "../net/mcp.js";
import { createBridge } from "../tools/mcpStdioBridge.js";

// A bridge wired to a scripted server. `reply` decides what the fake HTTP round trip returns for
// each relayed method; every outbound request and every line written to stdout is recorded, so a
// test can assert on the wire shape as well as the answer.
function harness({ reply = () => ({ result: {} }), baseUrl = "http://example.test:8080" } = {}) {
  const requests = [];
  const written = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init, headers: init.headers, body: JSON.parse(init.body) });
    const answer = reply(JSON.parse(init.body).method, JSON.parse(init.body).params);
    if (answer instanceof Error) throw answer;
    return { json: async () => answer };
  };
  const bridge = createBridge({ baseUrl, fetchImpl, write: s => written.push(s) });
  return { bridge, requests, written, sent: () => written.map(s => JSON.parse(s)) };
}

test("initialize is answered locally — the bridge's whole reason for existing", async () => {
  const h = harness({ reply: () => ({ result: { capabilities: { tools: {}, resources: {} } } }) });
  await h.bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }));
  const [msg] = h.sent();
  assert.equal(msg.id, 1);
  assert.equal(msg.result.serverInfo.name, "spacecities-bridge");
  assert.ok(msg.result.capabilities, "a client needs capabilities to know what it may call");
});

test("initialize echoes the CALLER's protocol version, not the bridge's own", async () => {
  // The bridge is a translation layer with no protocol version of its own to negotiate; the real
  // server's 2026-07-28 is an internal detail the outward side must never see, or a client built
  // for an older revision concludes it cannot talk to this server at all.
  const h = harness();
  await h.bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "initialize", params: { protocolVersion: "2024-11-05" } }));
  assert.equal(h.sent()[0].result.protocolVersion, "2024-11-05");
  assert.notEqual(h.sent()[0].result.protocolVersion, PROTOCOL_VERSION,
    "the real server's revision is internal — echoing it back defeats the point of the bridge");
});

test("initialize still answers when the caller names no protocol version", async () => {
  const h = harness();
  await h.bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: {} }));
  assert.equal(h.sent()[0].result.protocolVersion, "2025-06-18", "falls back to a conventional revision");
});

test("initialize survives a server that cannot be reached at all", async () => {
  // A client commonly spawns the bridge before the game server is up. Failing the handshake there
  // makes the whole MCP entry look broken; answering with a minimal capability set lets the
  // client connect and get a real error on its first actual call instead.
  const h = harness({ reply: () => new Error("ECONNREFUSED") });
  await h.bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "initialize", params: {} }));
  const [msg] = h.sent();
  assert.ok(!msg.error, "a cold server must not fail the handshake");
  assert.deepEqual(msg.result.capabilities, { tools: {} });
});

test("every relayed method carries the headers net/mcp.js actually validates", async () => {
  const h = harness({ reply: () => ({ result: { ok: true } }) });
  await h.bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "build", arguments: { what: "rax" } } }));
  const [req] = h.requests;
  assert.equal(req.url, "http://example.test:8080/mcp");
  assert.equal(req.init.method, "POST");
  assert.equal(req.headers["MCP-Protocol-Version"], PROTOCOL_VERSION, "the INNER hop speaks the real server's revision");
  assert.equal(req.headers["Mcp-Method"], "tools/call");
  assert.equal(req.headers["Mcp-Name"], "build", "net/mcp.js requires the header to equal params.name");
});

test("Mcp-Name is taken from params.uri for resources/read, and omitted where there is neither", async () => {
  // net/mcp.js's NAME_HEADER_METHODS rule: name for tools/call, uri for resources/read, and the
  // header must be absent otherwise — sending it on tools/list is itself a rejection.
  const h = harness({ reply: () => ({ result: {} }) });
  await h.bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "resources/read", params: { uri: "spacecities://unit-stats" } }));
  assert.equal(h.requests[0].headers["Mcp-Name"], "spacecities://unit-stats");
  await h.bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/list", params: {} }));
  assert.ok(!("Mcp-Name" in h.requests[1].headers), "tools/list must not carry an Mcp-Name header");
});

test("the _meta block every request needs is injected, without trampling the caller's params", async () => {
  const h = harness({ reply: () => ({ result: {} }) });
  await h.bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "scout", arguments: { id: 3 } } }));
  const { body } = h.requests[0];
  assert.equal(body.params._meta["io.modelcontextprotocol/protocolVersion"], PROTOCOL_VERSION);
  assert.deepEqual(body.params.arguments, { id: 3 }, "the caller's own params must survive intact");
  assert.equal(body.jsonrpc, "2.0");
});

test("all four relayed methods reach the server; anything else is a clean -32601", async () => {
  const h = harness({ reply: () => ({ result: { ok: true } }) });
  for (const m of ["tools/list", "resources/list", "resources/read", "tools/call"]) {
    await h.bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: {} }));
  }
  assert.equal(h.requests.length, 4, "every documented method must be relayed, not just the ones with a name");
  await h.bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "prompts/list", params: {} }));
  const last = h.sent().at(-1);
  assert.equal(last.error.code, -32601);
  assert.match(last.error.message, /prompts\/list/, "the client should be told WHICH method it got wrong");
  assert.equal(h.requests.length, 4, "an unsupported method must not be forwarded to the real server");
});

test("a JSON-RPC error from the real server is relayed verbatim, never re-wrapped", async () => {
  // Re-wrapping would turn a precise, actionable server error ("no such unit") into a generic
  // internal error, which is exactly the information the agent on the other end needs.
  const h = harness({ reply: () => ({ error: { code: -32602, message: "no such unit: 41" } }) });
  await h.bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "move" } }));
  const [msg] = h.sent();
  assert.deepEqual(msg.error, { code: -32602, message: "no such unit: 41" });
  assert.equal(msg.id, 11, "and it must answer the id the client actually asked with");
});

test("a transport failure becomes a -32603, still addressed to the caller's id", async () => {
  const h = harness({ reply: () => new Error("socket hang up") });
  await h.bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 12, method: "tools/list", params: {} }));
  const [msg] = h.sent();
  assert.equal(msg.error.code, -32603);
  assert.match(msg.error.message, /socket hang up/);
  assert.equal(msg.id, 12);
});

test("notifications are never answered — an id-less message has nobody to reply to", async () => {
  const h = harness();
  await h.bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  await h.bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: {} }));
  assert.deepEqual(h.written, [], "replying to a notification is a protocol violation");
});

test("malformed and blank input is dropped silently, never echoed to stdout", async () => {
  // There is no id to answer with, so there is no correct reply — and writing anything
  // non-JSON-RPC to stdout would corrupt the stream for every message after it.
  const h = harness();
  await h.bridge.handleLine("not json at all");
  await h.bridge.handleLine("");
  await h.bridge.handleLine("   ");
  await h.bridge.handleLine("{ unterminated");
  assert.deepEqual(h.written, []);
});

test("STDOUT DISCIPLINE: every write is exactly one newline-terminated JSON-RPC message", async () => {
  const h = harness({ reply: () => ({ result: { ok: true } }) });
  await h.bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
  await h.bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }));
  await h.bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "nope" }));
  assert.equal(h.written.length, 3);
  for (const line of h.written) {
    assert.ok(line.endsWith("\n"), "each message must be newline-delimited");
    assert.equal(line.trimEnd().split("\n").length, 1, "a message must never span lines — clients read line by line");
    assert.equal(JSON.parse(line).jsonrpc, "2.0");
  }
});

test("resolveBaseUrl: CLI arg wins, then the env var, then the serve.js default", async () => {
  // Getting this wrong points the bridge at a port nothing is listening on, and every call fails
  // with a connection error that looks like the game server being down.
  const { resolveBaseUrl } = await import("../tools/mcpStdioBridge.js");
  assert.equal(resolveBaseUrl(["http://host:1234"], {}), "http://host:1234");
  assert.equal(resolveBaseUrl([], { SPACECITIES_MCP_URL: "http://env:5678" }), "http://env:5678");
  assert.equal(resolveBaseUrl(["http://host:1234"], { SPACECITIES_MCP_URL: "http://env:5678" }), "http://host:1234",
    "an explicit argument must beat the environment");
  assert.equal(resolveBaseUrl([], {}), "http://localhost:8080", "matches tools/serve.js's own default port");
});
