# Agent developer guide

SpaceCities exposes a real-time-strategy match to an AI agent over **MCP** (Model Context
Protocol), targeting spec revision **`2026-07-28`**. This is the same match a human plays in a
browser — an agent sees a fog-respecting summary of it and acts through the identical
server-side validation a human's click goes through. This guide is everything a third party
needs to connect an agent, with no other document required. A complete, runnable client
implementing all of it lives at [`tools/referenceAgent.js`](../tools/referenceAgent.js), built
using `tools/mcpClient.js`'s own minimal HTTP client — read this guide alongside that file.

## 1. Connecting

One endpoint: `POST /mcp` on the game server (`http://localhost:7860` locally; the deployed
Space's own URL in production). There is no session handshake in this spec revision — every
request stands alone and carries everything it needs.

Every request needs:

- **Headers**: `Content-Type: application/json`, `MCP-Protocol-Version: 2026-07-28`,
  `Mcp-Method: <the JSON body's own method>`, and — for `tools/call` and `resources/read`
  specifically — `Mcp-Name` set to the body's `params.name` (`tools/call`) or `params.uri`
  (`resources/read`). A header that disagrees with the body is rejected (`-32020`).
- **Body**: standard JSON-RPC 2.0 (`jsonrpc`, `id`, `method`, `params`), plus two required
  `_meta` fields under `params._meta`: `"io.modelcontextprotocol/protocolVersion": "2026-07-28"`
  and `"io.modelcontextprotocol/clientCapabilities": {}`.

```
POST /mcp
Content-Type: application/json
MCP-Protocol-Version: 2026-07-28
Mcp-Method: tools/call
Mcp-Name: get_situation

{
  "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": {
    "name": "get_situation",
    "arguments": { "seat_handle": "..." },
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {}
    }
  }
}
```

Call `server/discover` first to confirm the server's identity and declared capabilities
(`{tools:{}, resources:{}}`); call `tools/list` / `resources/list` (both cursor-paginated) to
discover the exact tool/resource catalog live rather than trusting this document to never drift.

### Two kinds of failure, and they mean different things

- A **JSON-RPC error** (a top-level `error` object, e.g. `-32601 Method not found`,
  `-32602 Invalid params`) means the *request itself* was malformed — an unknown tool name, a
  missing resource, a header that doesn't match the body. This is a bug in your client, not a
  legal move the game rejected.
- A **tool execution error** (`result.isError: true` inside an ordinary `200` response) means
  your request was well-formed but the *game* said no — you don't own that unit, you can't
  afford that building, your seat handle expired. Read `result.content[0].text` for a
  human-readable reason and, for `issue_command`, `result.structuredContent.code` for a
  machine-readable one (see §5). This is a normal, expected outcome your agent should react to,
  not an exception to catch and ignore.

## 2. Getting a seat

There is no protocol-level session, so **the seat handle is your session**: mint it once with
`join_match`, then pass it as `seat_handle` on every later call. Treat it as opaque — don't parse
it, just store and resend it.

| Tool | Arguments | Notes |
|---|---|---|
| `list_matches` | *(none)* | Every open (joinable) match, plus the server's published `agent_apm_cap` (§6). A match already running, or restricted to a benchmark harness, never appears here. |
| `join_match` | `match_id`, `seat_index?` | Omit `seat_index` to auto-pick the first open seat. Returns `seat_handle`, `owner` (the seat's id, e.g. `"player"` or `"ai"`), `seat_index`. Fails once the match has already started — join before the host starts it. |
| `leave_match` | `seat_handle` | Give up a seat before the match starts. Fails once it has. |

**The host still has to start the match separately** (outside MCP, via the ordinary
`POST /api/matches/:id/start`) once every seat is filled. Every tool below reports a
`match-not-live` tool execution error until that happens — a real agent should tolerate this gap
(poll `get_situation` every second or so) rather than assume a seat means a running match. See
`runReferenceAgent`'s own startup loop in `tools/referenceAgent.js` for a working example.

## 3. Observing — fog-respecting, summarized, never a raw state dump

Every observation tool takes `seat_handle` and reports only what that seat's own fog of war
reveals: its own units/buildings unconditionally, an opponent's only if currently visible.

| Tool | Returns |
|---|---|
| `get_situation` | `tick`, `time`, `over`, `winner`, this seat's `resources`, and its own `units_by_type`/`buildings_by_type` counts — a compact status line. |
| `list_entities` | Every visible entity, trimmed to `{id, type, owner, x, y, hp}`. Optional `owner`/`type` arguments narrow a large list. |
| `get_map_overview` | Discovered resource nodes (`{id, amount}`) and every currently-visible base's `{owner, x, y}`. |
| `get_tech_options` | Every unit/building type, each tagged `prereqs_met`/`affordable` for THIS seat right now — the input to any build decision. |

None of these ever include an enemy's internal `order`/`orderQueue` — intent isn't something fog
reveals, only position, type, and hp.

## 4. Acting — one flexible tool over the same codec a human's click uses

There is a single action tool, `issue_command`, whose `command` argument is a `WireCommand` — the
same shape the browser client sends for a human, validated by the identical server-side codec
(ownership, fog, affordability, rate limits). A rejected command gets the same machine-readable
`code` a human's own rejected click would get:

`malformed` · `unknown-type` · `not-owner` · `no-target` · `not-visible` · `empty-selection` ·
`too-many` · `out-of-bounds` · `refused` (the engine itself said no — cost or prerequisite unmet,
bad placement).

Common command shapes (`ids` is an array of 1–400 unit/building ids you own):

```
{ t: "move",        ids, x, y, q? }
{ t: "attackMove",  ids, x, y, q? }
{ t: "attack",      ids, target, q? }
{ t: "gather",      ids, node, q? }
{ t: "stop",        ids }
{ t: "hold",        ids }
{ t: "build",       worker, b, x, y }
{ t: "queueProduction", building, u, alt? }
{ t: "researchTech", building, tech }
```

Wrap several into `{ t: "batch", c: [...] }` (max 16) to apply them together at the same tick —
this, plus `ids` already holding up to 400 entries, is what "batched, group-oriented" means: you
are never forced to spend your action budget one unit at a time.

```js
const result = await client.callTool("issue_command", {
  seat_handle,
  command: { t: "attackMove", ids: myUnitIds, x: target.x, y: target.y },
});
if (result.isError) console.log("rejected:", result.structuredContent.code);
```

### Conceding: `surrender`

A second, separate action tool — not a `WireCommand` (there's no `ids`, no ownership/fog/affordability
to check; you're ending your own participation, not commanding an entity). Irreversible, and not
instant: it marks your seat eliminated, but the match's own `over`/`winner`/`winReason` resolve on
the *next* tick, the same one-tick latency a real Command Center loss already has — check
`get_situation` or `wait_for_event` afterward to see the outcome.

```js
await client.callTool("surrender", { seat_handle });
```

Before a match has started, use `leave_match` (§2) instead — `surrender` only works on a live match.

## 5. Reacting instead of polling

`wait_for_event` blocks (up to a bounded timeout, default 8s, capped at 20s server-side — always
comfortably under a real client's own tool-call timeout) until something new becomes visible to
your seat — combat, a kill, a completed build, research finishing — or the timeout elapses. A
timeout is a normal, successful result (`timed_out: true`, `events: []`), never an error: just
call it again. Call this in your main loop instead of `get_situation`-polling in a tight loop.

```js
const { structuredContent } = await client.callTool("wait_for_event", { seat_handle, timeout_ms: 5000 });
if (!structuredContent.timed_out) { /* structuredContent.events has what changed */ }
```

## 6. Rate limit — the same published cap every scripted opponent has

Every `issue_command` call spends from an actions-per-minute budget — the identical mechanism
and numbers the game's own hardest scripted AI difficulty uses (a published, symmetric handicap,
not a hidden throttle). The cap is reported as `agent_apm_cap` by both `GET /api/matches` and the
`list_matches` tool, so you can see it before you're ever limited by it. Exceeding it rejects the
command with `result.isError: true` and `"agent-apm-exceeded"` inside `result.content[0].text` —
back off and retry rather than treating it as fatal. Unlike a genuine codec rejection (§4), this
one has no separate `result.structuredContent.code` field to check instead — it shares the
generic seat/lobby rejection shape (`content` text only), so matching on the text itself (or
simply treating any `issue_command` `isError` as "didn't happen, try again") is the reliable way
to detect it.

## 7. Static reference — read once, not every turn

Four MCP **resources** hold everything that never changes mid-match — read each once per agent
process, not once per turn:

| URI | Contents |
|---|---|
| `game://units` | Every unit type's combat/economy stats and build cost. |
| `game://buildings` | Every building type's cost, build time, static-defense stats, and `produces` — which unit types it can build (what `tools/referenceAgent.js`'s own economy rule reads). |
| `game://counters` | The real unit counter triangle, derived straight from the engine's own combat math — never a hand-authored, driftable description of it. |
| `game://tech-tree` | Every research node's cost, time, prerequisites, and effect. |

```js
const res = await client.readResource("game://buildings");
const buildings = JSON.parse(res.contents[0].text);   // an array — see server/mcpResources.js for the exact field list
```

## 8. A complete example

```js
import { createMcpClient } from "./mcpClient.js";

const client = createMcpClient("http://localhost:7860");
const joined = await client.callTool("join_match", { match_id });
const { seat_handle, owner } = joined.structuredContent;

// ... wait for the host to start the match (see §2) ...

const buildings = JSON.parse((await client.readResource("game://buildings")).contents[0].text);

for (;;) {
  const situation = (await client.callTool("get_situation", { seat_handle })).structuredContent;
  if (situation.over) break;

  const entities = (await client.callTool("list_entities", { seat_handle })).structuredContent.entities;
  const techOptions = (await client.callTool("get_tech_options", { seat_handle })).structuredContent.units;

  // ... your own strategy: build a WireCommand from situation/entities/techOptions/buildings ...
  const command = decide({ owner, entities, buildingDefs: buildings, techOptions });
  if (command) await client.callTool("issue_command", { seat_handle, command });

  await client.callTool("wait_for_event", { seat_handle, timeout_ms: 5000 });
}
```

This is exactly `tools/referenceAgent.js`'s own `runReferenceAgent`, minus its startup-retry
loop and logging. Run the real thing directly:

```
node tools/referenceAgent.js run --url http://localhost:7860 --match <id>
```

`tools/referenceAgent.js`'s own `decide()` is deliberately simple — attack any visible enemy with
every owned unit, otherwise queue the first affordable unit type your first producing building
can build — a correct, minimal illustration of the tool surface, not a strong opponent
(`engine/ai.js` is the game's own real AI; reading it is a reasonable next step once your agent
speaks the protocol correctly).
