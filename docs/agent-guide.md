# Agent developer guide

SpaceCities exposes a real-time-strategy match to an AI agent over **MCP** (Model Context
Protocol), targeting spec revision **`2026-07-28`**. This is the same match a human plays in a
browser — an agent sees a fog-respecting summary of it and acts through the identical
server-side validation a human's click goes through. This guide is everything a third party
needs to connect an agent, with no other document required. If you are an agent about to PLAY
rather than a developer about to integrate, read the short
[MCP player handbook](mcp-player-handbook.md) instead — same surface, one page, ordered by what you
do first. A complete, runnable client
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
| `create_match` | `seats`, `join_as?`, `client_id?`, `planet_id?`, `size_mult?`, `resource_mult?`, `match_time_limit?`, `spectators_enabled?` | Make your own match and say who plays each seat — see §2.1. `join_as` claims one of them in the same call, returning a `seat_handle`. |
| `list_matches` | *(none)* | Every open (joinable) match, plus the server's published `agent_apm_cap` (§6). A match already running, or restricted to a benchmark harness, never appears here. |
| `join_match` | `match_id`, `seat_index?`, `client_id?` | Omit `seat_index` to auto-pick the first open seat. Returns `seat_handle`, `owner` (the seat's id, e.g. `"player"` or `"ai"`), `seat_index`, `started` — `true` exactly when THIS join was the one that filled every remaining seat, which starts the match immediately — and `rejoined`. With a `client_id` you already used here, this is a REJOIN and works even on a started match (§2.2). |
| `leave_match` | `seat_handle` | Give up a seat before the match starts. Fails once it has. |
| `find_my_seats` | `client_id` | Every seat that client_id holds, with working handles — recovery when you have lost everything but your own id (§2.2). |
| `watch_match` | `match_id` | A `watch_handle`: observe a match unfogged, from both sides, without taking a seat (§2.3). |

**If your own `join_match` still reports `started: false`**, another seat is still open and
waiting — a human host can fill it (via the browser) or start early anyway
(`POST /api/matches/:id/start`), or a second agent can `join_match` the same way you just did.
Every tool below reports a `match-not-live` tool execution error until the match actually starts —
a real agent should tolerate this gap (poll `get_situation` every second or so, or watch for
`started: true` on your own join) rather than assume a seat means a running match. See
`runReferenceAgent`'s own startup loop in `tools/referenceAgent.js` for a working example.

### 2.1 Seating a match: `create_match`

`seats` is exactly two entries, seat 0 first, each `{controller, ai_strategy?, difficulty?}`:

- `"ai"` — one of the game's own scripted opponents, filled at match start and not joinable.
  `ai_strategy` is `default` / `aggressive` / `economic` / `matching`; `difficulty` is `easy` /
  `medium` / `hard`. Unknown names fall back to the default rather than erroring.
- `"human"` — a seat a person will join from the browser.
- `"agent"` — a seat an MCP client will claim with `join_match`.

Either seat can be any of the three, so agent-vs-AI, agent-vs-agent, agent-vs-human and AI-vs-AI are
all just different arrays. The match starts automatically once every `human`/`agent` seat is
claimed; an all-AI match starts on creation. Read `started` rather than assuming.

```js
const { seat_handle, match_id, started } = (await client.callTool("create_match", {
  seats: [{ controller: "agent" }, { controller: "ai", ai_strategy: "aggressive", difficulty: "hard" }],
  join_as: 0, client_id,
})).structuredContent;
```

### 2.2 Rejoining: `client_id`

There is no protocol session and no connection to drop, so nothing about your seat depends on you
staying reachable — but everything depends on you keeping the `seat_handle`. Mint one random
`client_id` per agent, pass it to `create_match`/`join_match`, and you have a second way in:

- `join_match({match_id, client_id})` returns the SAME seat and a fresh working handle
  (`rejoined: true`) — and unlike an ordinary join, it works on a match already in progress.
- `find_my_seats({client_id})` lists every seat you hold, across matches, each with a handle.

Treat the id as a secret: whoever knows it can reclaim your seat.

### 2.3 Watching: `watch_match`

A `watch_handle` is the same opaque string, naming a match but no seat. Pass it as `seat_handle` to
`get_situation` (which reports a per-side scoreboard instead of "your" resources), `list_entities`,
`get_map_overview` and `wait_for_event`. It sees the match unfogged and can never act: every acting
tool refuses it with `watch-only-handle`, and so does `get_tech_options` (affordability is a
per-seat question). Watching consumes no seat. Refused if the host disabled spectators.

## 3. Observing — fog-respecting, summarized, never a raw state dump

Every observation tool takes `seat_handle` and reports only what that seat's own fog of war
reveals: its own units/buildings unconditionally, an opponent's only if currently visible.

| Tool | Returns |
|---|---|
| `get_situation` | `tick`, `time`, `over`, `winner`, this seat's `resources`, `supply`/`supply_cap`, its own `units_by_type`/`buildings_by_type` counts, `idle_unit_ids`, who you are (`you`) and who you're playing (`opponents`), plus the map's `width`/`height`/`tickRate`. |
| `list_entities` | Every visible entity as `{id, type, owner, x, y, hp}`; your OWN entities also carry `activity` (`idle`/`gathering`/`moving`/`attacking`/`building`/`producing`/`under-construction`), `orderTarget`, a producer's `queue` and a site's `buildProgress`. Optional `owner`/`type`/`activity` arguments narrow a large list — `activity: "idle"` is how you find units that have stopped working. |
| `get_map_overview` | Every discovered resource node as `{id, com, amount, max, x, y, distance_from_base}`, **nearest first**, plus `commodities_available`, every visible base's `{owner, x, y}`, and the map bounds. `com` is the commodity the node actually yields — you never have to scout a node to learn what it is. |
| `get_tech_options` | Every unit/building type with `cost`, full `stats` (hp, attack, range, cooldown, speed, sight, buildTime, supplyCost, bonusVs…), `produced_by`/`buildable`, `prereqs_met` **and `missing_prereqs`** (which requirement is missing, by name), and `affordable` for THIS seat right now. |
| `get_counters` | The real counter table — every `{attacker, target, bonus}` matchup, derived from the same `bonusVs` data the engine's combat math reads. Static; read it once. |

None of these ever include an enemy's internal `order`/`orderQueue` — intent isn't something fog
reveals, only position, type, and hp. That's why `activity`/`orderTarget` appear on your own
entities only.

## 4. Acting — one flexible tool over the same codec a human's click uses

There is a single action tool, `issue_command`, whose `command` argument is a `WireCommand` — the
same shape the browser client sends for a human, validated by the identical server-side codec
(ownership, fog, affordability, rate limits). A rejected command gets the same machine-readable
`code` a human's own rejected click would get:

`malformed` · `unknown-type` · `not-owner` · `no-target` · `not-visible` · `empty-selection` ·
`too-many` · `out-of-bounds` · `refused` (the engine itself said no — cost or prerequisite unmet,
bad placement).

A `refused` from `build` or `queueProduction` also carries a `reason` in
`result.structuredContent`, naming the check that actually failed rather than leaving you to probe
for it: `cannot-afford` · `prereq-not-met` · `invalid-placement` · `supply-capped` ·
`unit-cannot-build-this-category` · `building-cannot-produce-this-unit` ·
`building-under-construction` · `odyssey-only-unit` / `odyssey-only-building`.

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
{ t: "cancelProduction", building, i }
{ t: "setRally",    building, x, y }
{ t: "researchTech", building, tech }
```

A successful `queueProduction` returns a receipt — `{building, unit, queueIndex, queueLength,
etaSeconds}` — so you never have to guess whether it landed. (Ore is debited when the job *starts*,
not when it's queued, so an immediate `get_situation` showing unchanged ore is not evidence the
order was dropped. Read the receipt, or the building's own `queue` in `list_entities`, instead of
re-sending.) `setRally` decides where a producer's new units walk to — set it before a fight rather
than moving every spawn by hand.

Wrap several into `{ t: "batch", c: [...] }` (max 16) to apply them together at the same tick —
this, plus `ids` already holding up to 400 entries, is what "batched, group-oriented" means: you
are never forced to spend your action budget one unit at a time.

### Batching ROUND TRIPS: the `batch` tool

The two batchings above are game-level: they put more work into one tick. `batch` is the transport
level — up to 24 of this server's own tool calls in ONE request, observations and actions mixed, in
order. A turn is rarely one command ("look at the situation, find my idle workers, send them
mining, queue a unit, then wait"), and over a 20Hz real-time match paying network latency five
times for that is the single largest gap between an MCP client and a browser client.

```js
const { results } = (await client.callTool("batch", {
  seat_handle,
  steps: [
    { tool: "get_situation" },
    { tool: "issue_command", arguments: { command: { t: "gather", ids: idleWorkers, node: "n7" } } },
    { tool: "wait_for_event", arguments: { timeout_ms: 4000, groups: ["combat"] } },
  ],
})).structuredContent;
```

Each step omitting `seat_handle` inherits the batch's own. Every step runs through the identical
handler, validation, rate limit and rejection codes a separate call would reach — batching is
cheaper, never more permissive, and a batch of ten commands spends ten actions. Steps are not
atomic and nothing rolls back; by default the batch stops at the first failing step (so a dependent
chain cannot run on a broken premise), and `continue_on_error: true` runs them all. The result
always lists every step that ran, each carrying exactly the result it would have returned alone.

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

### Stepping away: `set_seat_controller`

A human's browser holds a live WebSocket, so the server can SEE them leave and hand their seat to
the game's own AI after a grace period, handing it back when they reconnect. You have no such
socket — going quiet for two minutes to compact your context is indistinguishable from thinking
hard, and the match does not pause for either. So say it explicitly:

```js
await client.callTool("set_seat_controller", { seat_handle, controller: "ai", difficulty: "hard" });
// ... compact, restart, deliberate ...
await client.callTool("set_seat_controller", { seat_handle, controller: "self" });
```

`controller: "ai"` hands your seat to a built-in opponent (optionally naming `ai_strategy` /
`difficulty`) so your base keeps building and defending itself; `controller: "self"` takes it back
and your commands work immediately. Reversible as often as you like, and your `seat_handle` and
`client_id` stay valid throughout — this is not leaving the match. Whatever the AI did while it held
the seat stands, so call `get_situation` when you return rather than assuming the position you left.

## 5. Reacting instead of polling

`wait_for_event` blocks (up to a bounded timeout, default 8s, capped at 20s server-side — always
comfortably under a real client's own tool-call timeout) until something new becomes visible to
your seat — combat, a kill, a completed build, research finishing — or the timeout elapses.
Events carry entity ids, not just coordinates, so you never have to reconstruct a fight by diffing
two `list_entities` calls: `entityKilled` has the dead entity's `id` (plus `killerId`/`killerOwner`),
`attackHit` has `sourceId`/`targetId`, `unitSpawned` has the new unit's `id` and `fromBuildingId`,
and `buildingComplete` has the finished building's `id`. Two events exist specifically to stop an
economy rotting unnoticed: `nodeDepleted` (a node just ran dry) and `unitIdle` (a gatherer stopped
because there was nothing left to retarget to). A
timeout is a normal, successful result (`timed_out: true`, `events: []`), never an error: just
call it again. Call this in your main loop instead of `get_situation`-polling in a tight loop.

Every result also carries a **`summary`** — a digest of those same events, so you can branch
without knowing how the engine spells things:

```jsonc
{ "by_type": { "attackHit": 3, "buildingComplete": 1 },
  "groups": ["combat", "construction"],
  "under_attack": true,
  "attacked":  [{ "id": "u12", "x": 300, "y": 540, "attacker_id": "e4" }],
  "completed": [{ "type": "buildingComplete", "id": "b3", "entity_type": "barracks" }] }
```

`under_attack` means YOUR entities are being hit or killed — your own attack landing on the enemy
is `combat`, but not that. Narrow what wakes you with `types: ["entityKilled"]`, or the coarser
`groups` (`combat` / `construction` / `economy` / `match`); a filtered wait keeps waiting through
events you excluded rather than returning an empty list, so "wake me when a fight starts" stays one
call rather than a busy loop.

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
