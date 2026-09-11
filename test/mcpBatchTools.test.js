import { test } from "node:test";
import assert from "node:assert/strict";
import { createMcpServer, PROTOCOL_VERSION } from "../net/mcp.js";
import { createBatchTools } from "../server/mcpBatchTools.js";

/* ============================================================
   `batch` — one MCP call that runs several of this server's own tool calls (server/mcpBatchTools.js).
   The property under test throughout is that a batched step is INDISTINGUISHABLE from the same call
   made directly: same handler, same arguments, same result shape, same rejection. Batching is a
   latency optimization, never a second, more permissive way in — so these tests assert what a step
   RECEIVES and what it gives back, not merely that something ran.
   ============================================================ */

// A tool registry that records exactly what each handler was called with, so a test can prove the
// arguments a step received rather than inferring it from the result.
function fakeTools(calls) {
  return [
    {
      name: "echo",
      description: "records its args",
      inputSchema: { type: "object", properties: {} },
      handler: args => { calls.push(["echo", args]); return { content: [{ type: "text", text: "ok" }], structuredContent: { got: args } }; },
    },
    {
      name: "fails",
      description: "always rejects",
      inputSchema: { type: "object", properties: {} },
      handler: args => { calls.push(["fails", args]); return { content: [{ type: "text", text: "Could not complete: nope" }], isError: true }; },
    },
    {
      name: "throws",
      description: "always throws",
      inputSchema: { type: "object", properties: {} },
      handler: () => { throw new Error("boom"); },
    },
  ];
}

function batchServer(calls) {
  const tools = [];
  tools.push(...fakeTools(calls), ...createBatchTools(() => tools));
  return { tools, run: args => tools.find(t => t.name === "batch").handler(args) };
}

test("createBatchTools registers exactly one tool, named batch", () => {
  assert.deepEqual(createBatchTools(() => []).map(t => t.name), ["batch"]);
});

test("every step runs in order, through the SAME handler a direct call would reach", async () => {
  const calls = [];
  const { run } = batchServer(calls);
  const result = await run({ steps: [{ tool: "echo", arguments: { n: 1 } }, { tool: "echo", arguments: { n: 2 } }] });

  assert.equal(result.isError, undefined);
  assert.deepEqual(calls.map(([, a]) => a.n), [1, 2], "steps run in the order given");
  assert.deepEqual(result.structuredContent.results.map(r => r.structuredContent.got.n), [1, 2]);
  assert.deepEqual(
    { ran: result.structuredContent.ran, requested: result.structuredContent.requested, failed: result.structuredContent.failed, stopped_at: result.structuredContent.stopped_at },
    { ran: 2, requested: 2, failed: 0, stopped_at: null });
});

test("a step that omits seat_handle inherits the batch's own — and one that names its own keeps it", async () => {
  const calls = [];
  const { run } = batchServer(calls);
  await run({ seat_handle: "BATCH", steps: [{ tool: "echo" }, { tool: "echo", arguments: { seat_handle: "OWN" } }] });
  assert.deepEqual(calls.map(([, a]) => a.seat_handle), ["BATCH", "OWN"]);
});

test("by default a failed step STOPS the batch — a dependent chain must not run on a broken premise", async () => {
  const calls = [];
  const { run } = batchServer(calls);
  const result = await run({ steps: [{ tool: "echo" }, { tool: "fails" }, { tool: "echo" }] });

  assert.deepEqual(calls.map(([name]) => name), ["echo", "fails"], "the third step never runs");
  assert.equal(result.structuredContent.stopped_at, 1);
  assert.equal(result.structuredContent.ran, 2);
  // The batch itself still SUCCEEDS: steps 0's result would otherwise be hidden behind the failure.
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.results[1].isError, true);
});

test("continue_on_error runs the remaining steps and reports each outcome in place", async () => {
  const calls = [];
  const { run } = batchServer(calls);
  const result = await run({ steps: [{ tool: "fails" }, { tool: "echo" }], continue_on_error: true });

  assert.deepEqual(calls.map(([name]) => name), ["fails", "echo"]);
  assert.deepEqual(result.structuredContent.results.map(r => !!r.isError), [true, false]);
  assert.equal(result.structuredContent.stopped_at, null);
  assert.equal(result.structuredContent.failed, 1);
});

test("an unknown tool name is that STEP's failure, never a thrown protocol error that discards the steps before it", async () => {
  const calls = [];
  const { run } = batchServer(calls);
  const result = await run({ steps: [{ tool: "echo" }, { tool: "no_such_tool" }], continue_on_error: true });

  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.results[0].isError, undefined, "the step that already ran is still reported");
  assert.equal(result.structuredContent.results[1].isError, true);
  assert.match(result.structuredContent.results[1].content[0].text, /unknown-tool/);
});

test("a handler that THROWS becomes that step's own failure, so the steps around it still report", async () => {
  const calls = [];
  const { run } = batchServer(calls);
  const result = await run({ steps: [{ tool: "throws" }, { tool: "echo" }], continue_on_error: true });

  assert.match(result.structuredContent.results[0].content[0].text, /tool-threw — boom/);
  assert.equal(result.structuredContent.results[1].isError, undefined);
});

test("a batch cannot nest inside a batch — the step cap it enforces would multiply", async () => {
  const calls = [];
  const { run } = batchServer(calls);
  const result = await run({ steps: [{ tool: "batch", arguments: { steps: [{ tool: "echo" }] } }] });
  assert.match(result.structuredContent.results[0].content[0].text, /no-nested-batch/);
  assert.equal(calls.length, 0);
});

test("an empty or oversized step list is rejected outright, before anything runs", async () => {
  const calls = [];
  const { run } = batchServer(calls);
  assert.match((await run({ steps: [] })).content[0].text, /no-steps/);
  assert.match((await run({ steps: Array.from({ length: 25 }, () => ({ tool: "echo" })) })).content[0].text, /too-many-steps/);
  assert.equal(calls.length, 0);
});

test("batch is reachable over the real transport, and sees tools registered alongside it", async () => {
  const calls = [];
  const { tools } = batchServer(calls);
  const mcp = createMcpServer({ tools });
  const name = "batch";
  const { body } = await mcp.handleRequest({
    httpMethod: "POST",
    headers: { "mcp-protocol-version": PROTOCOL_VERSION, "mcp-method": "tools/call", "mcp-name": name },
    rawBody: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: {
        name, arguments: { seat_handle: "H", steps: [{ tool: "echo", arguments: { n: 7 } }] },
        _meta: { "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION, "io.modelcontextprotocol/clientCapabilities": {} },
      },
    }),
  });
  assert.equal(body.result.isError, undefined);
  assert.deepEqual(body.result.structuredContent.results[0].structuredContent.got, { seat_handle: "H", n: 7 });
});
