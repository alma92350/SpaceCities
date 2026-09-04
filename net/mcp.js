/* ============================================================
   net/mcp.js — T-049 (FR-13, NFR-5): the Streamable HTTP + JSON-RPC 2.0 MCP
   transport core, targeting protocol revision 2026-07-28, zero dependencies.

   This is a genuinely different shape from every earlier, pre-2026 MCP
   tutorial or SDK: revision 2026-07-28 is the largest revision since MCP's
   launch, and REMOVES the initialize/initialized handshake, Mcp-Session-Id,
   the GET SSE stream endpoint, and Last-Event-ID resumability entirely (see
   modelcontextprotocol.io/specification/2026-07-28/basic/transports/
   streamable-http, fetched and re-verified against the live spec before
   writing a line of this file, per this task's own row in TASKS.md). MCP is
   now STATELESS: every request carries its own protocol version, client
   identity, and capabilities in `params._meta`, mirrored onto the
   MCP-Protocol-Version/Mcp-Method/Mcp-Name HTTP headers so a request can be
   validated and routed without reading any prior state at all. There is no
   "connection" this server needs to remember anything about.

   handleRequest is deliberately TRANSPORT-AGNOSTIC — plain
   {httpMethod, origin, headers, rawBody} in, {status, body} out — so it can
   be driven directly by golden-transcript tests (test/mcp.test.js) with no
   real HTTP involved, the same separation net/commandCodec.js already
   keeps from net/ws.js's own raw socket handling. tools/serve.js is the
   only caller that ever touches a real http.IncomingMessage/ServerResponse.

   Scope, matching this task's own row: this file is the TRANSPORT layer —
   JSON-RPC framing, header/body validation, server/discover, tools/list,
   tools/call dispatch against a caller-supplied tool registry. It ships
   with NO game-specific tools of its own; T-051 (lobby tools), T-052
   (observation tools), and T-053 (action tools) register the real ones via
   this same `tools` registry. Sampling/elicitation (MRTR), prompts, and
   subscriptions/listen are out of this task's scope — nothing in Phase 6's
   own tool set needs a server-initiated round-trip back into the agent's
   own LLM, and T-054's own "wait_for_event" row asks for a single
   bounded-timeout response, not a long-lived SSE stream, so this file
   never needs to emit one: every response here is a single JSON object,
   which is fully spec-compliant (the spec lets a server choose
   `application/json` for every request; nothing requires SSE ever be used).

   T-055 (FR-16) added resources/list + resources/read (re-fetched and
   verified against the live spec's own server/resources page before
   writing a line of it, same discipline as T-049's own transport work) —
   a second, PARALLEL registry alongside `tools`, since a resource is a
   fundamentally different kind of thing: addressed by `uri` rather than
   `name`, with no `handler` to invoke (this server's own resources are
   fully static, precomputed content, never a function call), and "not
   found" is a REAL JSON-RPC protocol error (-32602) rather than an
   isError:true tool-execution result — the spec is explicit an empty
   `contents` array must never stand in for "no such resource." Resource
   templates, list-changed notifications, and subscriptions are still out
   of scope: nothing this port exposes is parameterized or ever changes
   after boot (unit stats, the counter triangle, build costs, the tech
   tree — all fixed at the code level, not per-match data).
   ============================================================ */

"use strict";

export const PROTOCOL_VERSION = "2026-07-28";

export const ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  HEADER_MISMATCH: -32020,
  MISSING_REQUIRED_CLIENT_CAPABILITY: -32021,
  UNSUPPORTED_PROTOCOL_VERSION: -32022,
};

// Which methods require the Mcp-Name header (mirroring params.name or params.uri) on top of the
// Mcp-Method every request needs — exactly the three the spec names, resources/read and
// prompts/get included even though this file's own tool registry never serves them, so a future
// resources/prompts task (outside T-049's own scope) doesn't have to touch this validation again.
const NAME_HEADER_METHODS = new Set(["tools/call", "resources/read", "prompts/get"]);

function errorResponse(status, id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  const body = { jsonrpc: "2.0", error };
  if (id !== undefined) body.id = id;
  return { status, body };
}

function resultResponse(id, resultType, payload, serverInfo) {
  const result = { resultType, ...payload };
  if (serverInfo) result._meta = { "io.modelcontextprotocol/serverInfo": serverInfo };
  return { status: 200, body: { jsonrpc: "2.0", id, result } };
}

// Opaque pagination cursor: just the next start index, base64'd so it reads as an opaque token to
// a caller rather than a number they might be tempted to construct by hand.
const encodeCursor = i => Buffer.from(String(i), "utf8").toString("base64");
const decodeCursor = c => { const n = Number(Buffer.from(c, "base64").toString("utf8")); return Number.isInteger(n) && n >= 0 ? n : 0; };

/**
 * @param {Object} opts
 * @param {Array<{name:string, title?:string, description:string, inputSchema:Object, outputSchema?:Object, handler:(args:Object)=>(Object|Promise<Object>)}>} [opts.tools]
 * @param {Array<{uri:string, name:string, title?:string, description?:string, mimeType?:string, text:string}>} [opts.resources]
 *   fully static resources — this server never needs a per-read handler because none of what T-055
 *   exposes (unit stats, the counter triangle, build costs, the tech tree) is per-match or
 *   per-caller data; every resource's own `text` is fixed content computed once by the caller.
 * @param {{name:string, version:string}} [opts.serverInfo]
 * @param {string} [opts.instructions]
 * @param {string[]|null} [opts.allowedOrigins] a null/omitted allowlist accepts every Origin — the
 *   right default for a publicly-reachable server with no single "home" origin to protect (the
 *   DNS-rebinding attack Origin validation exists for targets a LOCALLY-bound server); set this to
 *   lock the endpoint down to specific known front ends once one exists.
 * @param {number} [opts.pageSize] tools/list AND resources/list page size, default generous since
 *   Phase 6's own tool/resource counts are small — configurable so the pagination MECHANISM itself
 *   is testable at a small size.
 */
export function createMcpServer({ tools = [], resources = [], serverInfo, instructions, allowedOrigins = null, pageSize = 50 } = {}) {
  const toolsByName = new Map(tools.map(t => [t.name, t]));
  const toolList = tools.map(({ name, title, description, inputSchema, outputSchema }) => {
    const def = { name, description, inputSchema };
    if (title !== undefined) def.title = title;
    if (outputSchema !== undefined) def.outputSchema = outputSchema;
    return def;
  });

  const resourcesByUri = new Map(resources.map(r => [r.uri, r]));
  // resources/list is metadata ONLY (spec's own example: no `text` on a listed entry) — the
  // content itself is exactly what resources/read is for.
  const resourceList = resources.map(({ uri, name, title, description, mimeType }) => {
    const def = { uri, name };
    if (title !== undefined) def.title = title;
    if (description !== undefined) def.description = description;
    if (mimeType !== undefined) def.mimeType = mimeType;
    return def;
  });

  async function dispatch(method, params, id) {
    if (method === "server/discover") {
      const capabilities = { tools: {} };
      // Only declared once something is actually registered — a server constructed with no
      // resources genuinely doesn't support the capability yet, and this keeps every pre-existing
      // caller (every tool-only server built before T-055) getting the exact same capabilities
      // shape it always has.
      if (resources.length > 0) capabilities.resources = {};
      return resultResponse(id, "complete", {
        supportedVersions: [PROTOCOL_VERSION],
        capabilities,
        ...(instructions !== undefined ? { instructions } : {}),
      }, serverInfo);
    }

    if (method === "tools/list") {
      const start = typeof params.cursor === "string" ? decodeCursor(params.cursor) : 0;
      const page = toolList.slice(start, start + pageSize);
      const nextCursor = start + pageSize < toolList.length ? encodeCursor(start + pageSize) : undefined;
      const payload = { tools: page };
      if (nextCursor !== undefined) payload.nextCursor = nextCursor;
      return resultResponse(id, "complete", payload, serverInfo);
    }

    if (method === "resources/list") {
      const start = typeof params.cursor === "string" ? decodeCursor(params.cursor) : 0;
      const page = resourceList.slice(start, start + pageSize);
      const nextCursor = start + pageSize < resourceList.length ? encodeCursor(start + pageSize) : undefined;
      const payload = { resources: page };
      if (nextCursor !== undefined) payload.nextCursor = nextCursor;
      return resultResponse(id, "complete", payload, serverInfo);
    }

    if (method === "resources/read") {
      const resource = resourcesByUri.get(params.uri);
      // Spec's own "Error Handling" section: a missing resource is a REAL JSON-RPC error
      // (-32602), never an empty `contents` array — that would be ambiguous with "this resource
      // exists but has no content," which none of this server's own resources ever are.
      if (!resource) return errorResponse(400, id, ERROR_CODES.INVALID_PARAMS, "Resource not found", { uri: params.uri });
      const content = { uri: resource.uri, text: resource.text };
      if (resource.mimeType !== undefined) content.mimeType = resource.mimeType;
      return resultResponse(id, "complete", { contents: [content] }, serverInfo);
    }

    if (method === "tools/call") {
      const tool = toolsByName.get(params.name);
      if (!tool) return errorResponse(400, id, ERROR_CODES.INVALID_PARAMS, `Unknown tool: ${params.name}`);
      let outcome;
      try {
        outcome = await tool.handler(params.arguments ?? {});
      } catch (e) {
        return errorResponse(500, id, ERROR_CODES.INTERNAL_ERROR, `Tool "${tool.name}" threw: ${e.message}`);
      }
      const payload = { content: outcome.content ?? [] };
      if (outcome.isError) payload.isError = true;
      if (outcome.structuredContent !== undefined) payload.structuredContent = outcome.structuredContent;
      return resultResponse(id, "complete", payload, serverInfo);
    }

    return errorResponse(404, id, ERROR_CODES.METHOD_NOT_FOUND, `Method not found: ${method}`);
  }

  async function handleRequest({ httpMethod, origin, headers = {}, rawBody }) {
    if (httpMethod !== "POST") return { status: 405, body: null };

    // Origin validation: PRESENT and not on an explicitly-configured allowlist -> 403. Absent, or
    // no allowlist configured at all, is never itself a rejection reason (see allowedOrigins above).
    const originHeader = origin ?? headers.origin ?? headers.Origin;
    if (allowedOrigins && originHeader !== undefined && !allowedOrigins.includes(originHeader)) {
      return { status: 403, body: null };
    }

    let parsed;
    try { parsed = JSON.parse(rawBody); } catch { return errorResponse(400, undefined, ERROR_CODES.PARSE_ERROR, "Invalid JSON"); }

    if (!parsed || typeof parsed !== "object" || parsed.jsonrpc !== "2.0" || typeof parsed.method !== "string") {
      return errorResponse(400, parsed && parsed.id, ERROR_CODES.INVALID_REQUEST, "Malformed JSON-RPC message");
    }

    const isNotification = !("id" in parsed);
    if (isNotification) {
      // No client-to-server notification is defined by the core protocol over Streamable HTTP
      // (see this file's header) — accept and discard, exactly as the spec's own "the server MUST
      // return 202 Accepted with no body" rule for an accepted notification POST.
      return { status: 202, body: null };
    }
    if (parsed.id === null || (typeof parsed.id !== "string" && typeof parsed.id !== "number")) {
      return errorResponse(400, undefined, ERROR_CODES.INVALID_REQUEST, "A request id must be a string or number, and must not be null");
    }

    const { id, method } = parsed;
    const params = parsed.params && typeof parsed.params === "object" ? parsed.params : {};
    const metaIn = params._meta && typeof params._meta === "object" ? params._meta : {};
    const bodyProtocolVersion = metaIn["io.modelcontextprotocol/protocolVersion"];
    const clientCapabilities = metaIn["io.modelcontextprotocol/clientCapabilities"];

    if (typeof bodyProtocolVersion !== "string" || typeof clientCapabilities !== "object" || clientCapabilities === null) {
      return errorResponse(400, id, ERROR_CODES.INVALID_PARAMS,
        "Missing required _meta field: io.modelcontextprotocol/protocolVersion and io.modelcontextprotocol/clientCapabilities are both required on every request");
    }

    // Header <-> body validation (Streamable HTTP's own "Request Metadata" section): every
    // required header must be PRESENT and must agree with the body value it mirrors.
    const headerProtocolVersion = headers["mcp-protocol-version"];
    const headerMethod = headers["mcp-method"];
    if (headerProtocolVersion === undefined) return errorResponse(400, id, ERROR_CODES.HEADER_MISMATCH, "Missing required header: MCP-Protocol-Version");
    if (headerProtocolVersion !== bodyProtocolVersion) {
      return errorResponse(400, id, ERROR_CODES.HEADER_MISMATCH,
        `Header mismatch: MCP-Protocol-Version header value '${headerProtocolVersion}' does not match body value '${bodyProtocolVersion}'`);
    }
    if (headerMethod === undefined) return errorResponse(400, id, ERROR_CODES.HEADER_MISMATCH, "Missing required header: Mcp-Method");
    if (headerMethod !== method) {
      return errorResponse(400, id, ERROR_CODES.HEADER_MISMATCH, `Header mismatch: Mcp-Method header value '${headerMethod}' does not match body value '${method}'`);
    }
    if (NAME_HEADER_METHODS.has(method)) {
      const bodyName = params.name !== undefined ? params.name : params.uri;
      const headerName = headers["mcp-name"];
      if (headerName === undefined) return errorResponse(400, id, ERROR_CODES.HEADER_MISMATCH, "Missing required header: Mcp-Name");
      if (headerName !== bodyName) {
        return errorResponse(400, id, ERROR_CODES.HEADER_MISMATCH, `Header mismatch: Mcp-Name header value '${headerName}' does not match body value '${bodyName}'`);
      }
    }

    if (bodyProtocolVersion !== PROTOCOL_VERSION) {
      return errorResponse(400, id, ERROR_CODES.UNSUPPORTED_PROTOCOL_VERSION, "Unsupported protocol version",
        { supported: [PROTOCOL_VERSION], requested: bodyProtocolVersion });
    }

    return dispatch(method, params, id);
  }

  return { handleRequest };
}
