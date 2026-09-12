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
| `list_matches` | `include_started?` | Every open (joinable) match by default, plus the server's published `agent_apm_cap` (§6). Pass `include_started:true` to also see running and finished matches — a running match is otherwise invisible here, which is what makes a match you were playing appear to have vanished. Each taken seat reports `idle_seconds`. |
| `join_match` | `match_id`, `seat_index?`, `client_id?` | Omit `seat_index` to auto-pick the first open seat. Returns `seat_handle`, `owner` (the seat's id, e.g. `"player"` or `"ai"`), `seat_index`, `started` — `true` exactly when THIS join was the one that filled every remaining seat, which starts the match immediately — and `rejoined`. With a `client_id` you already used here, this is a REJOIN and works even on a started match (§2.2). |
| `leave_match` | `seat_handle` | Give up a seat before the match starts. Fails once it has. |
| `find_my_seats` | `client_id` | Every seat that client_id holds, with working handles and any finished match's own result — recovery when you have lost everything but your own id (§2.2). |
| `reclaim_seat` | `match_id`, `seat_index?`, `client_id?` | Take back a seat whose holder has gone silent — the recovery path that needs no prior `client_id` (§2.2). |
| `get_match_report` | `match_id` | How a match ended: winner, reason, duration, who played each seat, each side's final standing. Works long after the match and its worker are gone (§5.5). |
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

### 2.2 Rejoining after losing your handle

There is no protocol session and no connection to drop, so nothing about your seat depends on you
staying reachable — but everything depends on keeping the `seat_handle`, which for an LLM client
means keeping it through a context compaction. Three recovery paths, strongest first:

1. **`client_id`.** Mint one random string per agent and pass it to `create_match`/`join_match`.
   `join_match({match_id, client_id})` then returns the SAME seat with a fresh handle
   (`rejoined: true`), and unlike an ordinary join it works on a match already in progress.
   `find_my_seats({client_id})` lists every seat you hold across matches, each with a handle and,
   for a finished match, its result. Treat the id as a secret: whoever knows it can take your seat.
2. **`reclaim_seat({match_id, seat_index?, client_id?})`** — for when you did NOT pass a
   `client_id` before losing the handle, which is the usual case for an agent that has just been
   compacted. It takes over a seat that has been silent past a staleness window (60s by default),
   MINTING A NEW TOKEN so the previous handle is retired and a seat never has two live claimants.
   A seat still making calls is refused with `seat-still-active` and its current idle time. Whether
   this tool is reachable is a server policy (`SEAT_RECLAIM=off` disables it) — on a lobby
   strangers share, "the holder went quiet" is not distinguishable from "the holder is thinking".
3. **`list_matches({include_started: true})`** to find the match in the first place. The default
   listing answers "what can I join", so a running match is absent from it; each seat in the
   extended listing carries `idle_seconds`, which is how you tell your own abandoned seat from one
   someone is actively playing.

Handles are compact (~44 chars) rather than a long opaque blob, specifically so they survive
summarization more often — but that is a mitigation, not a guarantee. Persist the `client_id`.

### 2.3 Going quiet: what the server does about it

A browser client's presence is its open WebSocket, so the server sees it leave and covers the seat
with the game's own AI after a grace period (FR-5). An MCP client has no socket at all — the gap
between two tool calls is the only evidence there is — so presence is recorded from your calls
themselves, and a seat silent for 90 seconds is handed to the AI automatically. **Your next tool
call of any kind hands it straight back**; there is no separate resume step. A handover you
requested yourself with `set_seat_controller` (§4) is never undone this way — only cover the server
applied on its own is automatic to reverse.

### 2.4 Watching: `watch_match`

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
| `get_situation` | `tick`, `time`, `over`, `winner`, this seat's `resources`, `supply`/`supply_cap`, its own `units_by_type`/`buildings_by_type` counts, `idle_unit_ids`, an `economy` block (below), who you are (`you`) and who you're playing (`opponents`), plus the map's `width`/`height`/`tickRate`. |
| `list_entities` | Every visible entity as `{id, type, owner, x, y, hp}`; your OWN entities also carry `activity` (`idle`/`gathering`/`moving`/`attacking`/`building`/`producing`/`under-construction`), `orderTarget`, a gatherer's `cargo` and `gather_phase` (`toNode`/`mining`/`toDrop`), a producer's `queue` and a site's `buildProgress`. Optional `owner`/`type`/`activity` arguments narrow a large list — `activity: "idle"` is how you find units that have stopped working. `since_tick` returns only what CHANGED since a tick you already read, plus `removed_ids`. Also reports `enemy_currently_visible` and `enemy_last_seen` (below). |
| `get_map_overview` | Every discovered resource node as `{id, com, amount, max, x, y, distance_from_base}`, **nearest first**, plus `commodities_available`, every visible base's `{owner, x, y}`, and the map bounds. `com` is the commodity the node actually yields — you never have to scout a node to learn what it is. |
| `get_tech_options` | Every unit/building type with `cost`, full `stats` (hp, attack, range, cooldown, speed, sight, buildTime, supplyCost, bonusVs…), `produced_by`/`buildable`, `prereqs_met` **and `missing_prereqs`** (which requirement is missing, by name), and `affordable` for THIS seat right now. The full table is long — narrow it with `only:["lancer","foundry"]` or `ready_only:true` when you are checking one decision rather than surveying the tree. An unrecognised name in `only` comes back in `unknown_types`. |
| `get_counters` | The real counter table — every `{attacker, target, bonus}` matchup, derived from the same `bonusVs` data the engine's combat math reads. Static; read it once. |
| `estimate_engagement` | Who wins a fight between `your_ids` and `enemy_ids` (omit the latter for every enemy currently in fog): `predicted_winner`, a `margin`, both sides' dps/hp, how long each side lasts, and **`your_survivors`/`enemy_survivors`** — how many are expected to be left standing, which is what separates a close fight from a rout. **Fog does not have to stop you asking:** pass `enemy_composition:{bastion:8}` to weigh against a force you scouted earlier but can no longer see (added to `enemy_ids` if you pass both, flagged `assumed_composition`), and `your_composition:{lancer:20}` to ask how big an army the job actually needs. |

`get_tech_options` also carries `seconds_until_affordable` on anything you cannot pay for yet —
computed from your own MEASURED income, and absent entirely when that income would never get there.
"Affordable in 31s" is a schedule you can plan against; `affordable: false` on its own is a dead end.

### 3.1 The economy is a FLOW, not a number

`get_situation`'s `economy` block reports what the treasury is actually doing:

```
economy: {
  income_per_min: { ore: 224, crystals: 0, ... },   // GROSS delivery, measured over ~30s
  income_window_seconds: 30,
  gatherers: 6,               // workers actually on a node right now
  idle_workers: 0,
  workers_at_risk: [ { id, x, y, distance_from_base, near_enemy } ],
}
```

`income_per_min` is gross — what your workers are delivering — not the treasury's net movement, so
a big purchase never makes it read as if you had stopped earning. `null` means there is not yet
enough history to say.

`workers_at_risk` is the one that decides matches. When a seam runs dry, `engine/gather.js`
re-tasks that worker to the nearest surviving node of the same commodity — which, once the safe
seams are gone, is routinely one deep in contested ground. You also get a `workerRetargeted` event
(`{id, fromNode, toNode, com, x, y, distance}`) at the moment it happens. Both exist because a
worker line walking itself into the open, one depletion at a time, is how two recorded matches were
actually lost.

### 3.2 Fog is not information about the enemy's base

An empty enemy list means **you cannot see them**, never that they are gone. `list_entities`
reports this explicitly:

```
enemy_currently_visible: false,
enemy_last_seen: [ { id, type, owner, x, y, hp, tick, age_seconds: 42 } ],
```

Every entry was genuinely in your fog at the tick it was recorded, and `age_seconds` says how stale
it is — a four-minute-old sighting is a rumour, not intelligence, and expires. **The only things
that decide a match is over are `get_situation`'s own `over`/`winner` and `get_match_report`.** A
recorded match was twice declared won off an empty entity list while the opponent's army was intact.

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

Alongside the `hint` (what to do), a refusal carries a `detail` with the NUMBERS behind it, so you
can tell "wait six seconds" from "never on this economy" without probing: `cannot-afford` names the
`cost`, what you `have`, the `short`fall per commodity and `seconds_until_affordable` at your
measured income; `supply-capped` names the building that raises the cap and by how much;
`invalid-placement` names the `nearest_legal_site`. (For placement, prefer `near: {x, y}` on the
build command itself — the server runs the engine's own placement search and tells you which site it
chose.)

Every `issue_command` result — accepted or rejected — also carries `apm_remaining`/`apm_cap`, and
`seconds_until_next_action` when the budget is spent, so batching is not guesswork.

A `refused` from `build`, `queueProduction` or a research command also carries a `reason` in
`result.structuredContent`, naming the check that actually failed rather than leaving you to probe
for it: `cannot-afford` · `prereq-not-met` · `invalid-placement` · `supply-capped` ·
`unit-cannot-build-this-category` · `building-cannot-produce-this-unit` ·
`building-under-construction` · `odyssey-only-unit` / `odyssey-only-building` ·
`wrong-building-for-research` · `already-researched` · `already-queued` · `doctrine-locked` ·
`no-such-job` · `not-a-bomb` / `bomb-not-armed` / `fuse-already-lit`.

**Every** rejection — the coarse codes above as well as a `refused` reason — also carries a
`hint`: one sentence naming the cause and what to do about it, resolved against the live match.
That is the field to read before you retry.

```
refused (prereq-not-met)  -> hint: "it requires a completed Barracks — build or research that
                                    first, and wait for it to FINISH (a site still under
                                    construction does not count)."
refused (cannot-afford)   -> hint: "you need 130 more Ore (have 20 of 150) — gather or trade for
                                    it before re-issuing."
refused (supply-capped)   -> hint: "supply is capped (10/10, this unit needs 1) — build a Habitat
                                    (or another Command Center) to raise the cap first."
not-visible               -> hint: "that target is outside your vision — scout it or move a unit
                                    within sight range before targeting it."
```

Seat- and lobby-level rejections (`no-such-match`, `seat-taken`, `already-started`,
`match-not-live`, `agent-apm-exceeded`, …) name their own recovery in the rejection text for the
same reason — which tool to call next, not just which rule said no.

Common command shapes (`ids` is an array of 1–400 unit/building ids you own):

```
{ t: "move",        ids, x, y, q? }
{ t: "attackMove",  ids, x, y, q? }
{ t: "attack",      ids, target, q? }
{ t: "gather",      ids, node, q? }
{ t: "stop",        ids }
{ t: "hold",        ids }
{ t: "build",       worker, b, x, y }
{ t: "build",       worker, b, near: {x, y} }   // the server picks the nearest LEGAL site
{ t: "queueProduction", building, u, alt? }
{ t: "cancelProduction", building, i }
{ t: "setRally",    building, x, y }
{ t: "researchTech", building, tech }
```

A successful `queueProduction` returns a receipt — `{building, unit, queueIndex, queueLength,
etaSeconds}` — so you never have to guess whether it landed. **Cost and supply are both charged the
moment a job is QUEUED**, not when it starts building (`engine/production.js` calls `payCost` inside
`queueProduction`, and `engine/supply.js` counts every queued job, not just the one in progress). So
an immediate `get_situation` really does show the ore gone — that drop is confirmation the order
landed, not a reason to re-send. It also means a `cannot-afford` rejection at what you thought was
ample ore is usually honest: something you queued a moment ago already spent it. Re-read
`get_situation`, and the producer's own `queue` in `list_entities`, before re-issuing. `setRally` decides where a producer's new units walk to — set it before a fight rather
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
if (result.isError) console.log("rejected:", result.structuredContent.code, "—", result.structuredContent.hint);
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
and `buildingComplete` has the finished building's `id`. Four events exist specifically to stop an
economy rotting unnoticed: `nodeDepleted` (a node just ran dry), `unitIdle` (a gatherer stopped
because there was nothing left to retarget to), `workerRetargeted` (a gatherer re-tasked itself
to another seam — check how far from home it has just been sent) and `unitStalled` (a gatherer that
still has an order and is still walking, but has made no progress toward its seam or its drop-off
for ten seconds; carries `phase`, `reason` and `seconds`). Watch `unitStalled` in particular: a
stalled worker is **not** idle, so it never reaches `idle_unit_ids` and its `activity` reads as an
ordinary `gathering` — this event is the only thing that reports it. A
timeout is a normal, successful result (`timed_out: true`, `events: []`), never an error: just
call it again. Call this in your main loop instead of `get_situation`-polling in a tight loop.

Every result also carries a **`summary`** — a digest of those same events, so you can branch
without knowing how the engine spells things:

```jsonc
{ "by_type": { "attackHit": 3, "buildingComplete": 1 },
  "groups": ["combat", "construction"],
  "under_attack": true,   // YOUR entities, never your own attack landing
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

### 5.1 `take_turn` — the whole loop in one call

Your loop is almost always "wait, then look" — two round trips and two full re-reads of the same
board, every game-second, for a whole match. `take_turn` takes the same arguments as
`wait_for_event` and returns the wait's events AND the resulting `get_situation` (the state AFTER
those events) as one result. Prefer it.

### 5.2 Waking on a resource threshold, and not needing to wake at all

Nothing in the engine fires when a treasury crosses a number, so `wait_for_event`/`take_turn` take
`wake_on: { ore: 175 }` — resolves as soon as you hold at least that much of every named commodity
(`resources_reached: true`). Asked on its own, an unrelated event will not end that wait; combined
with `types`/`groups`, whichever lands first wins.

Better still, for "keep making these": **`set_production_plan`** is a standing order the server
executes for you, tick by tick, as the resources arrive:

```js
await client.callTool("set_production_plan", { seat_handle, plan: [
  { building: barracksId, unit: "bastion", repeat: 6, max_queued: 2 },
] });
```

Each attempt goes through the identical validation and costs the identical resources your own
`issue_command` would; nothing is queued while you cannot afford it, are supply-capped, or lack the
prerequisite. `repeat` counts down and the entry retires — you get a `planExhausted` event when it
does, and `action: "list"` shows what is still standing. This exists because your think time is
measured in tens of seconds and the sim ticks twenty times a second: a decision that only holds
until your next call is a decision that keeps arriving too late.

### 5.3 Notes that outlive your context: `remember`

`remember({ seat_handle, notes })` stores a few kilobytes against YOUR SEAT; calling it without
`notes` reads them back. It survives a compaction, a restart, and a handle you had to recover with
`reclaim_seat`. Keep the plan there — the build you committed to, the trigger you are waiting for,
what you have learned about the opponent — and re-read it when you come back, rather than
re-deriving it from the board. Nobody else can read it and it has no effect on the game.

### 5.4 Turn-based pacing: `clock_policy: "deliberation"` and `end_turn`

A realtime match does not care how long you think. Create a match with
`clock_policy: "deliberation"` and the world instead FREEZES between turns: it advances one round
only once every agent seat has called `end_turn` (or a server watchdog fires), so a 38-second build
costs the same whoever is playing. Only allowed when no seat is a human — a frozen clock turns your
think time into someone else's dead air. These matches are hidden from the default `list_matches`;
ask for them with `clock_policy: "deliberation"` (or `"any"`).

### 5.5 The end of the match

`wait_for_event` returns IMMEDIATELY on a finished match, with a `matchEnded` event and
`summary.match_over` — it never blocks on a decided match, and never filters that event out however
you narrowed the rest with `types`/`groups`. This event is synthesised by the MCP layer rather than
the engine (`engine/victory.js` sets `state.over` and pushes nothing, because every in-browser
consumer reads it off the frame it is already rendering); without it an agent sitting in
`wait_for_event` cannot tell a decided match from a quiet one and waits out its timeout forever.

`get_match_report({match_id})` then gives the full outcome, and keeps giving it after the match's
worker has exited and even across a server restart:

```jsonc
{ "winner": "ai", "winReason": "commandCenterDestroyed", "time": 612.4, "tick": 12248,
  "seats": [{ "seat_index": 0, "owner": "player", "controller": "agent" },
            { "seat_index": 1, "owner": "ai", "controller": "ai", "ai": { "difficulty": "hard" } }],
  "sides": [{ "owner": "player", "units": 0, "buildings": 0, "won": false },
            { "owner": "ai", "units": 14, "buildings": 6, "won": true }] }
```

`seats` is what makes the result readable: `winner` is a SEAT ID, so `"ai"` means "the seat called
ai", not "the computer" — either seat can be an agent or a scripted AI.

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
