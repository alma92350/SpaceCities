/* ============================================================
   tools/mcpStdioBridge.js — exposes net/mcp.js's real HTTP MCP server (protocol revision
   2026-07-28, which deliberately REMOVES the initialize/initialized handshake — see net/mcp.js's
   own header) as an ordinary STDIO MCP server instead: the one transport every MCP client
   (including Claude Code) unambiguously supports, and the one every such client expects a
   conventional initialize handshake from. This file speaks BOTH sides — a normal handshake
   outward, to whatever spawned it, and this project's own header/body-mirrored HTTP JSON-RPC
   inward, to the real game server — reusing exactly the request-shaping tools/mcpClient.js already
   established and test/mcpClient-backed tools already exercise, just generalized here to every
   method (tools/list, resources/list, resources/read, tools/call), not only the two that file's
   own narrower callTool/readResource pair covers.

   WHY THIS EXISTS AT ALL, rather than pointing a generic MCP client straight at /mcp: a stateless,
   handshake-less server is fully spec-compliant for 2026-07-28, but a client built against the
   older, still-dominant initialize/initialized convention has nothing to negotiate with there —
   this bridge is that negotiation, done once, so every future client (not just Claude Code) can
   reach this server the ordinary way.

   USAGE
     claude mcp add --transport stdio spacecities -- node tools/mcpStdioBridge.js http://localhost:8080
   (swap the URL for wherever the real game server is actually listening — first CLI arg, else
   SPACECITIES_MCP_URL, else localhost:8080 to match tools/serve.js's own default).

   STDIO MCP'S OWN HARD RULE, worth stating explicitly: stdout carries ONLY newline-delimited
   JSON-RPC messages, nothing else — a stray console.log would corrupt the stream and silently
   break every client speaking to this process. Every diagnostic below goes to stderr instead.
   ============================================================ */

"use strict";

import { createInterface } from "node:readline";
import { PROTOCOL_VERSION } from "../net/mcp.js";

const baseUrl = process.argv[2] || process.env.SPACECITIES_MCP_URL || "http://localhost:8080";

// Mirrors tools/mcpClient.js's own request() exactly (same headers, same _meta, same
// Mcp-Name-only-for-name-or-uri-methods rule) but generalized to every method this bridge relays,
// not just tools/call/resources/read — this project's own net/mcp.js only requires the Mcp-Name
// header for those two anyway, so a `headerName` of undefined for tools/list &c. already omits it
// exactly as required.
async function callServer(method, params) {
  const headerName = params?.name !== undefined ? params.name : params?.uri;
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "MCP-Protocol-Version": PROTOCOL_VERSION,
      "Mcp-Method": method,
      ...(headerName !== undefined ? { "Mcp-Name": headerName } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method,
      params: {
        ...(params || {}),
        _meta: {
          "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const body = await res.json();
  if (body.error) throw body.error;   // a real JSON-RPC error object ({code, message}) — relayed as-is below, never re-wrapped
  return body.result;
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

const RELAYED_METHODS = new Set(["tools/list", "resources/list", "resources/read", "tools/call"]);

async function handleLine(line) {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }   // malformed line: no id to reply to safely, drop it (mirrors net/mcp.js's own posture toward unparseable input)
  const { id, method, params } = msg;
  const isNotification = id === undefined;

  if (method === "notifications/initialized" || isNotification) return;   // nothing to answer, ever

  try {
    if (method === "initialize") {
      // Echo the CALLER's own requested protocolVersion back rather than assert one of this
      // bridge's own choosing — this bridge has no real protocol version of its own to negotiate;
      // it is a pure translation layer, and the real server's own version (2026-07-28) is an
      // internal-only detail the outward side never needs to see.
      const discover = await callServer("server/discover", {}).catch(() => null);
      send({
        jsonrpc: "2.0", id,
        result: {
          protocolVersion: (params && params.protocolVersion) || "2025-06-18",
          capabilities: (discover && discover.capabilities) || { tools: {} },
          serverInfo: { name: "spacecities-bridge", version: "1.0.0" },
        },
      });
      return;
    }

    if (RELAYED_METHODS.has(method)) {
      const result = await callServer(method, params || {});
      send({ jsonrpc: "2.0", id, result });
      return;
    }

    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (err) {
    const isJsonRpcError = err && typeof err.code === "number";
    send({ jsonrpc: "2.0", id, error: isJsonRpcError ? err : { code: -32603, message: (err && err.message) || String(err) } });
  }
}

createInterface({ input: process.stdin, terminal: false }).on("line", line => {
  handleLine(line).catch(err => process.stderr.write(`mcpStdioBridge: unhandled error: ${err.stack || err}\n`));
});
