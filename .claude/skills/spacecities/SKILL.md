---
name: spacecities
description: Play a SpaceCities match as an agent over the MCP interface — join a seat, observe the fog-limited world, and issue real commands. Use when asked to play, test, or drive the game as an AI player, to set up an agent-vs-agent or agent-vs-human match, or to exercise the MCP tool surface (join_match, get_situation, issue_command, wait_for_event) end to end.
---

# Playing SpaceCities over MCP

The server exposes a live RTS match to an agent as **17 MCP tools + 4 resources**. An agent
sees a fog-respecting summary and acts through the same server-side validation a human's
click goes through — there is no privileged access and no direct `engine/` import.

Player handbook (read this first): `docs/mcp-player-handbook.md`. Full protocol reference: `docs/agent-guide.md`. Worked client: `tools/referenceAgent.js` — run it
with no arguments for its usage banner.

## Start a server

```
PORT=8099 node tools/serve.js      # default port is 8080; 8099 avoids the user's dev server
```

One port serves everything: static game, game WebSocket, and `POST /mcp`.

## BEFORE YOU DO ANYTHING: mint a client_id

```js
const client_id = crypto.randomUUID();   // then WRITE IT TO A FILE
```

Pass it to `create_match`/`join_match`. When your context is compacted mid-match — and it will be —
this one string is what gets you back into your seat. Without it, recovery means
`list_matches({include_started:true})` + `reclaim_seat`, and only after a 60s staleness window.

## Create a match

`create_match` seats both sides: `{controller: "ai" | "human" | "agent"}` per seat, with optional
`ai_strategy`/`difficulty` on an AI seat. Either seat can be any of the three.

```js
await call("create_match", {
  seats: [{ controller: "agent" }, { controller: "ai", difficulty: "hard" }],
  join_as: 0, client_id,
});
```

Agent-vs-agent is `[{controller:"agent"},{controller:"agent"}]` with no `join_as` (or `join_as` for
the seat you take). The old `hostJoins:false` HTTP trick is no longer needed for this — the browser
host card and `POST /api/matches` still work and are unchanged, but an agent no longer needs either.

The match **auto-starts the instant the last seat fills**. Read the `started` flag that
`join_match` returns; do not look for a separate start step. (Verified: seat 0 join returns
`started:false`, seat 1 join returns `started:true`.)

Seat index maps to a fixed owner string: **seat 0 = `"player"`, seat 1 = `"ai"`**. The name
`"ai"` is just seat 1's owner id — it is your agent, not the built-in bot.

## The client (use this — do not hand-roll the headers)

`tools/mcpClient.js` already implements this. If writing a standalone script, the request
shape is strict and fails closed with `-32020` on any mismatch:

```js
const BASE = "http://localhost:8099";
async function rpc(method, params = {}) {
  const body = { jsonrpc: "2.0", id: Math.floor(Math.random() * 1e6), method,
    params: { ...params, _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {} } } };
  const headers = { "Content-Type": "application/json",
    "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": method };
  // Mcp-Name is REQUIRED for these two, and must equal the body's own value.
  if (method === "tools/call") headers["Mcp-Name"] = params.name;
  if (method === "resources/read") headers["Mcp-Name"] = params.uri;
  const r = await fetch(`${BASE}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
}
const call = (name, args) => rpc("tools/call", { name, arguments: args });
```

Every request stands alone — no session handshake in this protocol revision.

## The loop

```
join_match  ->  read game:// resources ONCE  ->  loop { get_situation, decide, issue_command, wait_for_event }
```

`join_match` returns a **`seat_handle`** (a compact opaque string wrapping the real token).
Pass that same string to every later call. Never log the raw token.

**If the match stops answering,** it has probably ended: `wait_for_event` returns a `matchEnded`
event immediately on a finished match (it never blocks on one), and `get_match_report({match_id})`
gives the outcome afterwards — including long after the match's worker is gone. A finished match
also disappears from the default `list_matches`; use `include_started:true` to see it.

**Poll past `no-state-yet` after joining.** The first `get_situation` almost always fails
with `isError:true` and text `no-state-yet: this match's worker hasn't reported in yet`, because
the match runs in a worker that has not ticked yet. This is normal, not an error to report —
retry every ~400ms; it clears within a second or two. A missing `structuredContent` is the
signal, so check for it rather than assuming success.

### Tools (all take `seat_handle`)

| Tool | Returns / does |
|---|---|
| `create_match` | seats both sides (`ai`/`human`/`agent`), optional `join_as` + `client_id`; auto-starts when full |
| `list_matches` | open matches + `agent_apm_cap`; `include_started:true` also shows running/finished ones, with each seat's `idle_seconds` |
| `join_match` | `{seat_handle, owner, seat_index, started, rejoined}` — `match_id` required; **with a `client_id` you already used this is a REJOIN and works on a started match** |
| `reclaim_seat` | takes back a seat silent >60s, minting a fresh handle — recovery with no prior `client_id` |
| `find_my_seats` | every seat a `client_id` holds, with handles and any finished match's result |
| `get_match_report` | how a match ended — winner, reason, duration, who played each seat; works after the match is gone |
| `watch_match` | a watch-only handle: unfogged, both sides, cannot act |
| `set_seat_controller` | `"ai"` hands your seat to the built-in AI while you are away; `"self"` takes it back |
| `batch` | up to 24 tool calls in ONE request — use this for a whole turn |
| `leave_match` | frees a seat, **only before start** — after start use `surrender` |
| `get_situation` | `{tick, time, over, winner, resources, units_by_type, buildings_by_type}` |
| `list_entities` | `{entities:[{id,type,owner,x,y,hp}]}` — fog-limited; filter with `owner`/`type`/`activity`. Your OWN entities also carry `activity` (idle/gathering/moving/attacking/building/producing/under-construction), `orderTarget`, a producer's queue and a site's `buildProgress`; an enemy's never do, since fog does not reveal intent. `activity:"idle"` is the cheap way to find units that have stopped working. |
| `get_map_overview` | `{nodes:[{id,amount}], bases:[...]}` |
| `get_tech_options` | `{units:[{type,cost,prereqs_met,affordable}], ...}` — per-seat, right now |
| `get_counters` | `{counters:[{attacker,target,bonus}]}` — what beats what. Static: read once, not per round. |
| `issue_command` | applies a `WireCommand` (below) |
| `surrender` | concedes the match |
| `wait_for_event` | blocks up to `timeout_ms`, returns `{tick, events, timed_out, summary}`. `summary.under_attack` names which of your entities are being hit; `summary.match_over` means the match is decided. Narrow with `types`/`groups`. |

### Resources — read once, they never change mid-match

`game://units`, `game://buildings`, `game://counters`, `game://tech-tree`. Static rules
(costs, `produces` lists, hp, counters). Reading them every round is wasted APM.

## Commands

`issue_command` takes one `WireCommand`; the full union is in `net/commandShapes.js`, which
is the authority. Common shapes:

```js
{ t:"move",  ids:["u2"], x:250, y:600 }              // ids order is LOAD-BEARING: ids[0] leads
{ t:"attackMove", ids:["u2","u3"], x:900, y:300 }
{ t:"gather", ids:["u2"], node:"n0" }
{ t:"build",  worker:"u2", b:"barracks", x:300, y:520 }
{ t:"queueProduction", building:"b1", u:"worker" }
{ t:"researchTech", building:"b4", tech:"..." }
{ t:"batch", c:[ /* 1..16 commands, applied at one tick, never nested */ ] }
```

**Reading the result.** Success is `content:"Command applied."` with an *empty*
`structuredContent:{}`. Rejection is `isError:true` with the reason in
`structuredContent.code` (e.g. `unknown-type`). So **do not test success by truthiness of
`structuredContent`** — check `isError`.

Rate limit: every `issue_command` is subject to a fixed server-wide APM ceiling
(`net/agentApm.js`), published as `agent_apm_cap` by `list_matches`. Batch related orders
rather than firing them individually.

## Traps that cost real debugging time

- **Node resource ids are not entities.** `get_map_overview` reports nodes as `n0`, `n1`…
  but those ids do **not** appear in `list_entities`. Get a `gather` target from
  `get_map_overview`, not by scanning entities for an `n`-prefixed id.
- **`wait_for_event` returning `{events:[], timed_out:true}` is normal**, including right
  after you issued commands. It means nothing *notable* happened, not that the command
  failed. An early-game loop will see many of these.
- **The `"ai"` owner string is seat 1**, not the built-in bot. Do not treat entities owned by
  `"ai"` as enemies-by-definition when you are seat 1 — compare against your own `owner`
  from `join_match`.
- **Going quiet costs you the match.** The sim runs at 20Hz regardless of whether you are calling.
  A seat silent for 90s is handed to the built-in AI automatically and handed back on your next
  call — a safety net, not a plan. Before any deliberate pause, call
  `set_seat_controller({controller:"ai"})` and take it back with `"self"`.
- **A lost `seat_handle` is not a lost match.** Rejoin with your `client_id`, or find the match with
  `list_matches({include_started:true})` and `reclaim_seat` the seat with the high `idle_seconds`.
- **Fog is real.** `list_entities` shows only what your seat can see; early on that is your
  own 3 workers and 1 command center and nothing else. An empty enemy list means *not
  visible*, not *not present*.

## Verifying it works

Two agents in one match, end to end, is the thing worth checking — it exercises
`hostJoins:false`, the auto-start, and the per-seat fog at once. The relevant regression
tests are `test/mcpLobbyTools.test.js` and `test/httpServer.test.js`; `npm test` covers both. The
compaction/recovery and end-of-match-report paths are covered end to end in
`test/httpServer.test.js`, and the idle-seat AI cover in `test/seatPresence.test.js`. For the two-concurrent-match server path specifically, see
`test/wsWorkerTransport.test.js`.
