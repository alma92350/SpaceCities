/* ============================================================
   T-058 (P2): a minimal, dependency-free MCP client over real HTTP — the counterpart every
   test/mcp*.test.js's own callTool() helper stands in for by calling net/mcp.js's handleRequest()
   in-process. A real third-party agent has no such shortcut: it only ever reaches this server over
   the wire, exactly the way this file does. Deliberately thin — it knows nothing about SpaceCities'
   own tools/resources, only the generic Streamable HTTP/JSON-RPC shape net/mcp.js implements
   (PROTOCOL_VERSION, the MCP-Protocol-Version/Mcp-Method/Mcp-Name headers, the _meta fields every
   request needs) — reused here rather than re-typed, so this client can never silently drift from
   what the real transport actually validates.
   ============================================================ */

"use strict";

import { PROTOCOL_VERSION } from "../net/mcp.js";

/**
 * @param {string} baseUrl e.g. "http://localhost:7860"
 * @returns {{
 *   callTool: (name: string, args?: Object) => Promise<Object>,
 *   readResource: (uri: string) => Promise<Object>,
 * }}
 */
export function createMcpClient(baseUrl) {
  let nextId = 1;

  async function request(method, params) {
    const id = nextId++;
    // net/mcp.js's own header-match rule (NAME_HEADER_METHODS): the Mcp-Name header must equal
    // params.name for tools/call, or params.uri for resources/read — never both, never neither.
    const headerName = params.name !== undefined ? params.name : params.uri;
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "MCP-Protocol-Version": PROTOCOL_VERSION,
        "Mcp-Method": method,
        ...(headerName !== undefined ? { "Mcp-Name": headerName } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id, method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    const body = await res.json();
    // A JSON-RPC `error` is a PROTOCOL failure (malformed request, unknown method/resource) —
    // never seen for a well-formed call against a real tool/resource this client already knows
    // about, so surfacing it as a thrown Error (rather than a return value the caller must
    // remember to check) matches how unexpected this actually is.
    if (body.error) throw new Error(`MCP ${method} error ${body.error.code}: ${body.error.message}`);
    return body.result;
  }

  return {
    // A TOOL's own business-rule rejection (isError:true) is a normal result, never a thrown
    // error — net/mcp.js's own dispatch draws exactly this line, and a caller reacting to a
    // rejected command (e.g. "not enough resources") needs the result, not a catch block.
    callTool: (name, args = {}) => request("tools/call", { name, arguments: args }),
    readResource: uri => request("resources/read", { uri }),
  };
}
