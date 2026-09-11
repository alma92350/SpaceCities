# SpaceCities — MCP player handbook

You are about to play a real-time strategy match against a human, a scripted AI, or another agent.
This is the short version: what to call, in what order, and the four things that will cost you the
match if you get them wrong. For protocol mechanics (headers, `_meta`, error classes) read
[`agent-guide.md`](agent-guide.md); for the full tool catalog, call `tools/list`.

Endpoint: `POST /mcp`. No session — **your `seat_handle` is your session**, and your `client_id` is
how you get a new one if you lose it.

---

## 1. The loop

```js
// once, at the very start — mint a random client_id and NEVER lose it
const client_id = crypto.randomUUID();

const { seat_handle, started } = (await call("create_match", {
  seats: [{ controller: "agent" }, { controller: "ai", difficulty: "hard" }],
  join_as: 0, client_id,
})).structuredContent;

for (;;) {
  const [situation, entities, events] = (await call("batch", {
    seat_handle,
    steps: [
      { tool: "get_situation" },
      { tool: "list_entities", arguments: { activity: "idle" } },
      { tool: "wait_for_event", arguments: { timeout_ms: 5000 } },
    ],
  })).structuredContent.results.map(r => r.structuredContent);

  if (situation.over) break;
  // ... decide, then issue commands (batched too) ...
}
```

That is the whole shape. Everything below is detail on the four calls in it.

---

## 2. Setting up a match — `create_match`

Say who plays each seat. Both seats are fully configurable:

| `controller` | Means |
|---|---|
| `"ai"` | One of the game's own scripted opponents. Optional `ai_strategy` (`default`, `aggressive`, `economic`, `matching`) and `difficulty` (`easy`, `medium`, `hard`). Filled at start; nobody can join it. |
| `"human"` | A person will join from the browser. |
| `"agent"` | An MCP client will claim it with `join_match`. |

```jsonc
{ "seats": [{ "controller": "agent" }, { "controller": "agent" }] }   // agent vs agent
{ "seats": [{ "controller": "ai", "ai_strategy": "economic" }, { "controller": "agent" }] }  // AI on seat 0
{ "seats": [{ "controller": "agent" }, { "controller": "human" }] }   // you vs a person
```

Add `join_as: 0` (plus `client_id`) to take a seat in the same call. Also accepts `planet_id`,
`size_mult`, `resource_mult`, `match_time_limit`, `spectators_enabled`.

**The match starts by itself** the moment every `human`/`agent` seat is claimed — read `started`.
Until then, and for a tick or two after, every observation tool answers `match-not-live` or
`no-state-yet`. That is normal: poll `get_situation` every second until it answers.

To join a match someone else made: `list_matches` → `join_match({match_id, client_id})`.

## 3. Coming back — `client_id`, `join_match`, `find_my_seats`

You will compact your context, restart, or crash. Plan for it:

- **Mint one random `client_id` per agent** and pass it to `create_match`/`join_match`. Treat it as
  a secret — it reclaims your seat.
- **Lost your `seat_handle`?** `join_match({match_id, client_id})` hands the same seat back
  (`rejoined: true`), *including on a match already in progress*, where an ordinary join is refused.
- **Lost the match id too?** `find_my_seats({client_id})` lists every seat you hold, with working
  handles.

## 4. Stepping away — `set_seat_controller`

A human's browser holds a socket, so the server can see them leave and have the AI cover their base
until they come back. You have no socket: going quiet to think looks exactly like going quiet
forever. **So say it.**

```js
await call("set_seat_controller", { seat_handle, controller: "ai", difficulty: "hard" }); // stepping away
// ... compact, restart, think ...
await call("set_seat_controller", { seat_handle, controller: "self" });                   // back
```

Do this before any pause long enough to matter. The match does **not** pause for you — it runs at
20 ticks a second whether or not you are calling. A seat nobody drives just stands there while the
opponent builds an army. Reversible as often as you like; your handle and `client_id` stay valid
throughout. Whatever the AI did stands, so call `get_situation` when you return.

## 5. Acting — `issue_command`, and three levels of batching

`issue_command` takes one `command`, a WireCommand — the same shape a human's click produces, run
through the identical validation. Common ones:

```
{t:"move",ids,x,y}  {t:"attackMove",ids,x,y}  {t:"attack",ids,target}  {t:"gather",ids,node}
{t:"stop",ids}  {t:"hold",ids}  {t:"build",worker,b,x,y}  {t:"setRally",building,x,y}
{t:"queueProduction",building,u}  {t:"cancelProduction",building,i}  {t:"researchTech",building,tech}
```

Use all three batchings — they compose, and they are the difference between playing at the game's
speed and losing to it:

1. **`ids` takes up to 400 entities.** Never command units one at a time.
2. **`{t:"batch", c:[...]}`** applies up to 16 commands *at the same tick*.
3. **The `batch` tool** runs up to 24 *tool calls* in one HTTP request — observations and actions
   mixed, in order. This is the one that matters most: a turn is "look, decide, act, wait", and
   paying network latency four times per turn is how an agent falls behind.

```js
await call("batch", {
  seat_handle,
  steps: [
    { tool: "issue_command", arguments: { command: { t: "gather", ids: idleWorkers, node: "n7" } } },
    { tool: "issue_command", arguments: { command: { t: "queueProduction", building: "b1", u: "worker" } } },
    { tool: "wait_for_event", arguments: { timeout_ms: 4000, groups: ["combat"] } },
  ],
});
```

Steps inherit the batch's `seat_handle`. A failed step stops the batch by default (a dependent
chain must not run on a broken premise); pass `continue_on_error: true` for independent steps.
Batching is cheaper, never more permissive: every step is validated and rate-limited exactly as a
separate call would be.

**Rate limit.** Every `issue_command` spends from a published actions-per-minute budget — the same
one the hardest scripted AI plays under. It is reported as `agent_apm_cap` by `list_matches`.
Exceeding it rejects the command (`agent-apm-exceeded`); back off, don't retry in a tight loop.

**Rejections are normal.** `result.isError: true` with a `code` in `structuredContent` means the
game said no (`not-owner`, `not-visible`, `refused` with a `reason` like `cannot-afford`). Read it
and adjust — it is information, not an exception.

`surrender({seat_handle})` concedes a live match; `leave_match({seat_handle})` gives up a seat
before one starts.

## 6. Knowing what happened — `wait_for_event`

**Do not poll in a tight loop.** `wait_for_event` blocks until something new becomes visible to you
(default 8s, capped at 20s) and returns immediately when it does. Events that fired while you were
not waiting are buffered, so nothing is lost between calls. A timeout is a normal result
(`timed_out: true`), not an error.

Every result carries a `summary` so you can branch without parsing raw events:

```jsonc
{ "by_type": { "attackHit": 3, "buildingComplete": 1 },
  "groups": ["combat", "construction"],
  "under_attack": true,
  "attacked":  [{ "id": "u12", "x": 300, "y": 540, "attacker_id": "e4" }],
  "completed": [{ "type": "buildingComplete", "id": "b3", "entity_type": "barracks" }] }
```

`under_attack` is **your** entities being hit or killed — your own attack landing on the enemy is
`combat`, but not that. Narrow what wakes you with `types: ["entityKilled"]` or the coarser
`groups: ["combat" | "construction" | "economy" | "match"]`; a filtered wait keeps waiting through
events you excluded instead of returning empty.

Raw events carry ids, not just coordinates: `attackHit` (`sourceId`/`targetId`), `entityKilled`
(`id`, `killerId`), `unitSpawned` (`id`, `fromBuildingId`), `buildingComplete` (`id`),
`researchComplete`, `nodeDepleted`, `unitIdle`.

## 7. Observing

All fog-respecting: your own entities always, an enemy's only while visible.

| Tool | Use it for |
|---|---|
| `get_situation` | Tick, `over`/`winner`, your resources and supply, unit/building counts, **`idle_unit_ids`**, who you are, map bounds. |
| `list_entities` | Every visible entity. Yours also carry `activity`, `orderTarget`, `queue`, `buildProgress`. Filter by `owner`/`type`/`activity`. |
| `get_map_overview` | Discovered nodes with their **commodity**, amount and distance from your base, nearest first; visible bases. |
| `get_tech_options` | Every unit/building with cost, stats, `prereqs_met` + `missing_prereqs`, `affordable`. |
| `get_counters` | The unit counter table. Static — read once. |

Static reference also lives in MCP **resources** (`game://units`, `game://buildings`,
`game://counters`, `game://tech-tree`): read once per process, never per turn.

## 8. Watching someone else's match — `watch_match`

`watch_match({match_id})` returns a `watch_handle`. Pass it as `seat_handle` to `get_situation`,
`list_entities`, `get_map_overview` and `wait_for_event`. It sees the match **unfogged**, from both
sides, and can never act — `issue_command`, `surrender`, `set_seat_controller` and `leave_match`
all refuse it (`watch-only-handle`), as does `get_tech_options` (there is no seat to price things
for). `get_situation` gives a per-side scoreboard instead of "your" resources. Watching costs no
seat, so it never blocks a real player. Fails if the host disabled spectators.

---

## The four things that lose matches

1. **Not saying you are stepping away.** The clock does not stop. `set_seat_controller` before any
   long pause.
2. **Losing your handle without a `client_id`.** Mint one up front; that is the only way back into
   a running match.
3. **One call per action.** Use `batch`, `ids`, and `{t:"batch"}` — latency, not the APM cap, is
   what actually limits you.
4. **Idle workers.** Check `idle_unit_ids` every turn and watch for `unitIdle`/`nodeDepleted`. An
   economy that stopped is invisible in every other field.
