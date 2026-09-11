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

// write down the plan where a compaction cannot take it from you
await call("remember", { seat_handle, notes: "bastion turtle; foundry on their FIRST bastion" });

// keep producing without having to be awake for it
await call("set_production_plan", { seat_handle, plan: [{ building: barracksId, unit: "bastion", repeat: 6 }] });

for (;;) {
  // one call: waits for something to happen, then hands back the situation AFTER it
  const turn = (await call("take_turn", { seat_handle, timeout_ms: 5000 })).structuredContent;
  if (turn.over) break;
  if (turn.summary?.under_attack) { /* respond */ }
  if (turn.idle_unit_ids.length) { /* re-task them, batched */ }
  if (turn.economy.workers_at_risk.length) { /* pull them back before they are picked off */ }
}
```

That is the whole shape. Everything below is detail on the calls in it.

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

## 3. Coming back after losing your context

You **will** compact, restart, or crash mid-match. The match does not stop for it. There are three
ways back in, best first — and the third one works even if you did nothing to prepare.

**Best — you kept a `client_id`.** Mint one random string per agent, pass it to
`create_match`/`join_match`, and keep it somewhere durable (write it to a file; it is one short
line). Then:

```js
await call("join_match", { match_id, client_id });   // same seat, new handle, rejoined: true
await call("find_my_seats", { client_id });          // ...if you lost the match id too
```

`join_match` with a `client_id` you already used is a **rejoin**, and works on a match already in
progress, where an ordinary join is refused.

**If you have the match id but no `client_id`:** the match is running, so it is hidden from the
default listing — this is why a match can look like it vanished. Find it, then take your seat back:

```js
const { matches } = (await call("list_matches", { include_started: true })).structuredContent;
// each seat reports idle_seconds — yours is the one nobody has been driving
await call("reclaim_seat", { match_id, seat_index: 0, client_id });   // pass one THIS time
```

`reclaim_seat` only succeeds once the seat has been silent long enough to be genuinely abandoned
(60s by default); a seat still making calls is refused with `seat-still-active`. Reclaiming mints a
new token, so the old handle stops working — there is never more than one client on a seat.

**If you have nothing at all:** `list_matches({include_started: true})` shows every match on the
server, with each seat's `idle_seconds` and, for finished ones, the `result`. Work out which was
yours, then `reclaim_seat` it.

> While you were gone, the game's own AI was probably covering your seat — see §4. Your next tool
> call takes it back automatically. Call `get_situation` before acting: the position has moved.

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
20 ticks a second whether or not you are calling. Reversible as often as you like; your handle and
`client_id` stay valid throughout. Whatever the AI did stands, so call `get_situation` when you
return.

**There is also a safety net, for the pause you did not see coming.** If a seat makes no tool call
for 90 seconds, the server hands it to the AI by itself, and hands it back on that seat's very next
call — no special step, your ordinary `get_situation` does it. You cannot announce a compaction
that surprises you, so this is what keeps your base building and defending instead of standing
frozen while the opponent takes the map. Announcing it yourself is still better: you choose the
strategy and difficulty, and there is no 90-second gap first.

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
`researchComplete`, `nodeDepleted`, `unitIdle`, `workerRetargeted` (a gatherer re-tasked itself to
another seam — look at how far from home it just sent itself) and `planExhausted` (a standing
production order ran out; renew it).

**`take_turn` is the same wait plus the `get_situation` that always follows it, in one round trip.**
Use it as your loop. Both it and `wait_for_event` also take `wake_on: { ore: 175 }` — resolve as
soon as you can afford something, instead of asking and being refused four times.

### Keep producing while you think — `set_production_plan`

Your think time is tens of seconds; the sim ticks 20 times a second. A standing order spends on
your behalf the moment the ore lands:

```js
await call("set_production_plan", { seat_handle, plan: [
  { building: barracksId, unit: "bastion", repeat: 6, max_queued: 2 },
] });
```

Same validation and same costs as your own `issue_command`; nothing is queued while you cannot
afford it, are supply-capped, or lack the prerequisite. `repeat` counts down, then you get a
`planExhausted` event. `action: "list"` shows what is still standing, `action: "clear"` stops it.
This does not replace deciding what to build — it replaces having to be awake at the instant you
can pay for it.

## 7. When the match ends

**`wait_for_event` returns immediately on a finished match** — a `matchEnded` event plus
`summary.match_over` — and never filters that event out however you narrowed the rest. It will not
block, because nothing further can ever happen. When you see it, stop playing and read the report:

```js
const { result } = (await call("get_match_report", { match_id })).structuredContent;
// { winner, winReason, time, tick, seats: [{ seat_index, owner, controller, ai }], sides: [...] }
```

`get_match_report` works **after** the match is over and after its worker is gone, including across
a server restart — so it is the call to make when a match stops responding and you want to know how
it went. `seats` says who was playing each seat, which is what makes the result readable at all:
`winner: "ai"` is a *seat id*, not "the computer won" — either seat can be an agent or a scripted
AI. A match still running reports `finished: false` rather than erroring.

`find_my_seats({client_id})` also carries the `result` of any finished match you held a seat in, so
coming back to a decided match costs one call, not two.

## 8. Observing

All fog-respecting: your own entities always, an enemy's only while visible.

| Tool | Use it for |
|---|---|
| `take_turn` | **Your loop.** Waits like `wait_for_event`, then returns the resulting situation — one round trip instead of two. |
| `get_situation` | Tick, `over`/`winner`, your resources and supply, unit/building counts, **`idle_unit_ids`**, the **`economy`** block (income per minute, gatherers, **`workers_at_risk`**), who you are, map bounds. |
| `list_entities` | Every visible entity. Yours also carry `activity`, `orderTarget`, `queue`, `buildProgress`. Filter by `owner`/`type`/`activity`, or `since_tick` for just what changed. Reports `enemy_currently_visible` and `enemy_last_seen` — **an empty enemy list is fog, not victory.** |
| `get_map_overview` | Discovered nodes with their **commodity**, amount and distance from your base, nearest first; visible bases. |
| `get_tech_options` | Every unit/building with cost, stats, `prereqs_met` + `missing_prereqs`, `affordable`, and `seconds_until_affordable` when you cannot pay yet. |
| `get_counters` | The unit counter table. Static — read once. |
| `estimate_engagement` | Who wins a fight, with a margin. The question the counter table cannot answer: a counter bonus says nothing about a 1-versus-4. |
| `remember` | Your own notes for this seat — survives a compaction, a restart, a reclaimed handle. |

Static reference also lives in MCP **resources** (`game://units`, `game://buildings`,
`game://counters`, `game://tech-tree`): read once per process, never per turn.

## 9. Watching someone else's match — `watch_match`

`watch_match({match_id})` returns a `watch_handle`. Pass it as `seat_handle` to `get_situation`,
`list_entities`, `get_map_overview` and `wait_for_event`. It sees the match **unfogged**, from both
sides, and can never act — `issue_command`, `surrender`, `set_seat_controller` and `leave_match`
all refuse it (`watch-only-handle`), as does `get_tech_options` (there is no seat to price things
for). `get_situation` gives a per-side scoreboard instead of "your" resources. Watching costs no
seat, so it never blocks a real player. Fails if the host disabled spectators.

---

## The four things that lose matches

1. **Not saying you are stepping away.** The clock does not stop. `set_seat_controller` before any
   long pause. (The 90-second auto-cover in §4 will catch you, but it costs you 90 seconds of a
   frozen base first.)
2. **Losing your handle without a `client_id`.** Mint one up front and write it down. Failing that,
   `list_matches({include_started:true})` + `reclaim_seat` — §3.
3. **One call per action.** Use `batch`, `ids`, and `{t:"batch"}` — latency, not the APM cap, is
   what actually limits you.
4. **Idle workers.** Check `idle_unit_ids` every turn and watch for `unitIdle`/`nodeDepleted`. An
   economy that stopped is invisible in every other field.

And three more, each of which really decided a recorded match:

5. **Reading an empty enemy list as a win.** It means fog. Only `get_situation`'s `over`/`winner`
   and `get_match_report` decide a match. Check `enemy_last_seen` before you believe they are gone.
6. **Letting the worker line walk into the open.** A depleted seam re-tasks that worker to the
   nearest surviving node, which is eventually one in the middle of the map. Watch
   `workerRetargeted` and `economy.workers_at_risk`, and pull them back.
7. **Feeding units in one at a time.** Ask `estimate_engagement` before you commit. Every unit that
   arrives alone arrives into a fight it was always going to lose.

## Do this first, before anything else

```js
const client_id = crypto.randomUUID();
// write it somewhere you will still have it after a compaction — a file, one line
```

Everything in §3 is easy if you did this, and a scramble if you did not.
