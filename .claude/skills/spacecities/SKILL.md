---
name: spacecities
description: Play a SpaceCities match as an agent over the MCP interface — join a seat, observe the fog-limited world, and issue real commands. Use when asked to play, test, or drive the game as an AI player, to set up an agent-vs-agent or agent-vs-human match, or to exercise the MCP tool surface (join_match, get_situation, issue_command, wait_for_event) end to end.
---

# Playing SpaceCities over MCP

The server exposes a live RTS match to an agent as **11 MCP tools + 4 resources**. An agent
sees a fog-respecting summary and acts through the same server-side validation a human's
click goes through — there is no privileged access and no direct `engine/` import.

Full protocol reference: `docs/agent-guide.md`. Worked client: `tools/referenceAgent.js` — run it
with no arguments for its usage banner.

## Start a server

```
PORT=8099 node tools/serve.js      # default port is 8080; 8099 avoids the user's dev server
```

One port serves everything: static game, game WebSocket, and `POST /mcp`.

## Create a match agents can actually fill

**Creating a match is NOT an MCP operation.** There is no `create_match` tool — the MCP surface
lets an agent *find and join* matches (`list_matches`, `join_match`), never create one. A match must
already exist, made either by a human in the browser's "Host a match" card or by the HTTP call below.
So if you are the agent, wait for a match to appear in `list_matches`; the `curl` here is for
whoever is *setting up* the match, using a different interface than the one you play through.

In the browser the host card's **Seat 1 / Seat 2** dropdowns cover the same ground: set Seat 1 to
"Open (agent)" and the creator holds no seat (that is `hostJoins:false`), leaving the seat(s) for
agents and turning the host button into "👁 Watch". Seat 2 set to "Built-in AI" reveals AI strategy
and difficulty selects.

```
curl -s -X POST http://localhost:8099/api/matches \
  -H 'Content-Type: application/json' \
  -d '{"planetId":"ferros","seatKinds":["open","open"],"hostJoins":false}'
```

**`hostJoins:false` is the whole trick for agent-vs-agent.** Creating a match normally
auto-claims seat 0 for the creator, leaving one seat — so a second agent's `join_match`
fails with `no-open-seat`. With `hostJoins:false` both seats are genuinely open and the
creator only spectates.

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

`join_match` returns a **`seat_handle`** (an opaque base64 blob wrapping the real token).
Pass that same string to every later call. Never log the raw token.

**Poll past `no-state-yet` after joining.** The first `get_situation` almost always fails
with `isError:true` and text `no-state-yet: this match's worker hasn't reported in yet`, because
the match runs in a worker that has not ticked yet. This is normal, not an error to report —
retry every ~400ms; it clears within a second or two. A missing `structuredContent` is the
signal, so check for it rather than assuming success.

### Tools (all take `seat_handle`)

| Tool | Returns / does |
|---|---|
| `list_matches` | open matches + `agent_apm_cap` |
| `join_match` | `{seat_handle, owner, seat_index, started}` — `match_id` required, `seat_index` optional |
| `leave_match` | frees a seat, **only before start** — after start use `surrender` |
| `get_situation` | `{tick, time, over, winner, resources, units_by_type, buildings_by_type}` |
| `list_entities` | `{entities:[{id,type,owner,x,y,hp}]}` — fog-limited; filter with `owner`/`type`/`activity`. Your OWN entities also carry `activity` (idle/gathering/moving/attacking/building/producing/under-construction), `orderTarget`, a producer's queue and a site's `buildProgress`; an enemy's never do, since fog does not reveal intent. `activity:"idle"` is the cheap way to find units that have stopped working. |
| `get_map_overview` | `{nodes:[{id,amount}], bases:[...]}` |
| `get_tech_options` | `{units:[{type,cost,prereqs_met,affordable}], ...}` — per-seat, right now |
| `get_counters` | `{counters:[{attacker,target,bonus}]}` — what beats what. Static: read once, not per round. |
| `issue_command` | applies a `WireCommand` (below) |
| `surrender` | concedes the match |
| `wait_for_event` | blocks up to `timeout_ms`, returns `{tick, events, timed_out}` |

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
- **Fog is real.** `list_entities` shows only what your seat can see; early on that is your
  own 3 workers and 1 command center and nothing else. An empty enemy list means *not
  visible*, not *not present*.

## Verifying it works

Two agents in one match, end to end, is the thing worth checking — it exercises
`hostJoins:false`, the auto-start, and the per-seat fog at once. The relevant regression
tests are `test/mcpLobbyTools.test.js` and `test/httpServer.test.js`; `npm test` (~27s) covers
both. For the two-concurrent-match server path specifically, see
`test/wsWorkerTransport.test.js`.
