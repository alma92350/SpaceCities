---
name: spacecities-player
description: Play a SpaceCities RTS match to win via its MCP tools (mcp__spacecities__*) — open a match, run the economy, scout, counter the enemy composition, and close it out. Use when asked to join, play, continue, or win a SpaceCities match.
allowed-tools: mcp__spacecities__create_match, mcp__spacecities__list_matches, mcp__spacecities__join_match, mcp__spacecities__leave_match, mcp__spacecities__find_my_seats, mcp__spacecities__reclaim_seat, mcp__spacecities__set_seat_controller, mcp__spacecities__get_situation, mcp__spacecities__list_entities, mcp__spacecities__get_map_overview, mcp__spacecities__get_tech_options, mcp__spacecities__get_counters, mcp__spacecities__issue_command, mcp__spacecities__wait_for_event, mcp__spacecities__batch, mcp__spacecities__surrender, mcp__spacecities__watch_match, mcp__spacecities__get_match_report
---

# SpaceCities Player

Wins SpaceCities matches over MCP. **The tools' own descriptions are the protocol reference** — call
`tools/list` and read them; they ship with the server and cannot go stale, so this file deliberately
does not restate them. (If you happen to have the repo checked out,
`docs/mcp-player-handbook.md` is that same protocol on one page — but never assume it is reachable:
an MCP client usually has only the server.)

This file is the part no tool description carries: what to build, when, and which mistakes have
actually lost matches.

Every number below was verified against the engine's own `entities.js` / `production.js` /
`supply.js`, not recalled from play. Trust them.

## Do this first, every single time

```js
const client_id = crypto.randomUUID();   // then SAY IT IN YOUR REPLY TEXT
```

It is the only cheap way back into a match after a compaction. Everything in **Recovery** is one
call with it and a scramble without it.

## MANDATORY CHECKLIST — read this even if you skip the rest

The recorded failure mode is **losing to a gotcha that was already written down**. In one loss
(korrath 0.6x) every item below was known and unused: the counter table had been read, the scout was
in position, the ore was in the bank. Knowing is not doing. Bind each to a **clock trigger**, not to
a feeling that it's time:

| When | Do | Why |
|---|---|---|
| Immediately | Record `client_id`, and read `you` from `get_situation` | See the `owner` gotcha below — guessing which seat you are wastes whole turns |
| ~20s | `get_counters`, **and write the counter down in your reply text** | Read-and-forget is the #1 recorded loss cause |
| ~40s | Queue the **habitat** (75 ore, 10s build, +8 supply) | Supply blocks production silently; being blocked costs the enemy a free first unit |
| ~60s | Put **one worker on a crystal node** | Crystals gate turret/bastille/aegis — *every* static defense. Ending a match on 0 crystals means you never had the option |
| Before **any** `attackMove` | `list_entities` and count defenders **out loud** | Vision you don't query is worth nothing |
| Every `wait_for_event` | Read `summary.under_attack`; if **workers** are the target, recall now | The worker line dies in seconds and never recovers on 0.6x |
| After **any** lost engagement | `get_counters` before requeuing the same unit | Numbers never fix a counter deficit |

## Verified stats — the only ones that decide early matches

| Unit | Ore | HP | Atk | Range | Speed | Supply | Build | Notes |
|---|---|---|---|---|---|---|---|---|
| worker | 50 | 40 | 4 | 15 | 60 | 1 | 8s | |
| ranger | 45 | 50 | 6 | 22 | 115 | 1 | 10s | `role:"scout"`, **sight 340** — a scout, not a soldier |
| skiff | 100 | 72 | 12 | 40 | 90 | 1 | 12s | `bonusVs:{lancer:10}` only |
| bastion | 160 | 160 | 10 | 44 | 68 | 2 | 18s | `bonusVs:{skiff:10}` — **double** damage into skiffs |
| lancer | 150 | 70 | **16** | **55** | 75 | 2 | 16s | `bonusVs:{bastion:20}` → **36 damage** to a bastion |

| Building | Cost | Gives |
|---|---|---|
| habitat | 75 ore | **+8 supply** (only once finished) |
| barracks | 150 ore | skiff, bastion, lancer, breacher, dreadnought, mender, wraith, aegis, colossus |
| foundry | 175 ore | requires barracks; **unlocks lancer** |
| turret | 150 ore + **100 crystals** | 350hp, 20 atk, range 130 |
| command center | — | produces worker, ranger, colonyship, haulers. **+10 supply** (your starting cap) |

**The counter that decides most matches:** lancer beats bastion. 16 + 20 bonus = **36 damage** per
hit, versus the bastion's 10 back, and it outranges it 55 to 44. **Foundry 175 + 2 lancers 300 = 475
ore beats 3 bastions = 480 ore.** Bastion-vs-bastion from behind is unwinnable — there is no amount
of "more" that fixes a counter deficit.

## GOTCHA — `owner` is a seat id, and it is probably not what you assume

Seat 0 is owner `"player"`, seat 1 is owner `"ai"`. **`"ai"` does not mean the computer** — it is
just seat 1's name, and it may well be you. Read `you` and `opponents` from `get_situation` once at
the start and use those variables everywhere:

```js
const { you, opponents } = situation;                        // e.g. you="player"
list_entities({ seat_handle, owner: you });                  // MY units
list_entities({ seat_handle, owner: opponents[0] });         // THEIR units (visible ones only)
```

The same applies at the end: `winner:"ai"` may be a win. Check `get_match_report`'s `seats` array
(`seat_index`/`owner`/`controller`) before telling the user who won.

## GOTCHA — having vision is not having information

In the lost match a ranger sat at (1200,500) with 340 sight, 240 units from the enemy base — their
*entire* 3-bastion army was inside my fog for over a minute and I never called `list_entities`. I
then `attackMove`'d a skiff + 2 rangers into it, losing ~190 ore of units for 100 ore of kills plus
all map presence. `get_map_overview`'s `bases` shows position and owner but **never the garrison**;
only `list_entities` does. "I have a scout there" and "I know what's there" are different states.

Corollary: **a base can vanish from `bases` without being destroyed** — that list is what is in fog
*right now*, not what you have discovered. One match read "their base is gone, am I winning?" when
the revealing scout had simply died. Never infer a kill from an absent base; confirm with
`get_situation`'s `over` flag.

## Economy

Workers gather with `{t:"gather", ids:[...], node:"n0"}`. The command center produces more workers.
Keep economy and military production running in parallel the entire match — never pause one for the
other.

**Cost and supply are charged when you QUEUE, not when the job starts.** (`payCost` runs inside
`queueProduction`; `supplyUsed` counts every queued job, not just the one in progress.) Three
consequences, all of which have cost matches:

- An immediate `get_situation` showing the ore **gone** is confirmation the order landed. Do not
  re-send.
- A `cannot-afford` at what looked like ample ore is almost always **honest** — something you queued
  seconds earlier already spent it, and your ore reading is stale. One match burned eight calls over
  four minutes chasing a phantom bug here. **Re-read `get_situation`, and the producer's own `queue`
  in `list_entities`, before re-issuing.** A non-empty queue means production is already running.
- Queue-stuffing cannot beat the supply cap: reservations happen at queue time.

**Supply.** You start at **10** (command center). Each habitat adds **+8**, but only once it has
finished building. Bastions cost 2 supply each, so the cap binds far sooner than it feels like it
should. Build the 2nd and 3rd habitat as soon as ore allows rather than waiting for
`refused (supply-capped)` / `productionBlocked{reason:"supply"}` — stalled production is pure lost
tempo.

**Node depletion.** Nodes drain to `amount: 0` while workers still *look* busy. On `nodeDepleted`,
workers auto-retarget the **nearest** node — which after a battle is often a junk **36-ore unit
wreck**, so income silently stalls. Re-issue `gather` explicitly at a real, rich node whenever
`nodeDepleted` fires; prefer the large far nodes (1170 ore) over small home ones (525) once home is
dry.

**Wrecks are a real late-game economy.** Destroyed *buildings* leave big wrecks — one was **1016
ore**. Late in a match with every real node at 0, salvaging a single building wreck took ore from 65
to 445 and funded the lancer mass that won it. When starved, check `get_map_overview` for wrecks near
recent fights, not just for untapped nodes.

**Spend exotic commodities or don't gather them.** One loss ended holding **252 relics** and no
arsenal — dead capital. If a commodity is accumulating with nothing queued that consumes it, either
build toward the consumer or move that worker back to ore.

## Military

- `{t:"build", worker:"<workerId>", b:"barracks", x, y}` — **`worker` and `building` take entity
  IDs, never type names.** `building:"barracks"` is rejected `no-target`; use `"b13"` from
  `list_entities`. Same for `setRally`/`researchTech`.
- A successful `queueProduction` echoes `{building, unit, queueIndex, queueLength, etaSeconds}`. **No
  receipt means it did not take.**
- **Queuing at the wrong building fails silently** — `bastion`/`skiff` at the command center returns
  `{}` and nothing ever spawns. If a unit never appears after 2+ checks, suspect this first.
- Queuing at a barracks still under construction returns `refused (building-under-construction)` —
  wait for its `buildingComplete` event.
- A `build` refused with affordability and prereqs both fine is usually **placement**: retry 40+
  units away from other buildings.
- **`setRally` on the barracks is worth one call:** `{t:"setRally", building:"<barracksId>", x, y}`
  pointed at the command center means every new unit walks home to the defensive position instead of
  piling up at the barracks. Forgetting it lost a match outright.

## Home defense — the most expensive lesson in this file

Four separate matches were lost to variations of one mistake. The rule:

> **Keep a fixed garrison on the command center's OWN coordinates, at all times, once any military
> exists.** Not "near home". Not at the barracks. Not "we'll recall them".

- **Stripping home to intercept** lost a match: the entire army (4 bastions + 4 rangers) chased a
  visible raid, won that fight, and a second wave walked into the empty command center and destroyed
  it before the army could return.
- **A forward garrison is not home defense**: an army parked near the barracks was swept alongside
  the gatherers and the command center simultaneously — 6 bastions + lancer + ranger lost for 2 kills.
- **A long march is a race you can lose**: against a base ~2500 units away, a correct-looking
  5-attack/3-home split still lost, because the AI counter-raided with 7 the instant the strike force
  left. Travel time alone made the recall too late (and one recall even returned `command-timeout`).
  Before a long attack: build static defense first, size home nearer **50%** than 35%, and confirm
  the enemy doesn't already have an army in the field.
- **Idle is a fine defensive stance** — units left idle at base auto-engage anything that wanders in.
  No need to issue `hold`.

The flip side is that **the garrison is where the ore advantage comes from**, not insurance you hope
not to need: the defender pays no travel time and the attacker arrives piecemeal. Three bastions
parked on the command center killed an incoming skiff + 2 rangers for zero losses and decided a match
(297s) on the spot — the opponent had spent their whole opening on that army.

## Openings that have actually won

**Bastion turtle — three recorded wins (215s, 232s, 6:45).** The default. Pick this unless you have
scouted something that beats it.

1. **0-60s:** 3 starting workers onto the two nearest ore nodes; queue 2 more workers immediately.
2. **~40-70s:** barracks, ~40 units from the command center. Habitat *before* the cap binds.
3. **70-120s:** one ranger from the command center to scout — sent **alone**, never risked in a
   fight. First bastion queued at the barracks.
4. **`setRally` barracks → command center** the moment the barracks finishes.
5. **120-200s:** mass bastions continuously. Nothing else.
6. **200s+:** with 7-8 bastions and the garrison counted at ≤4-5, attack with 5 and **keep 2-3 on the
   command center**. Reinforce the same coordinates as new bastions spawn.
7. Numeric superiority alone was enough — no tech upgrades needed when you simply outnumber the
   visible garrison.

**Skiff harassment — one win (189s), one loss.** Faster, and conditional.
Skiffs cost 100 vs 160 and train in 12s vs 18s, so they arrive first and can kill workers and
foundries before defenses exist. Economy disruption is the point: trading 1 skiff for 2 workers wins.

> **CAVEAT, and it is not optional: this loses outright to a standing bastion garrison.** The 189s
> win was against an opponent that had none. From the other side of that matchup, three bastions
> idling on a command center ate a skiff + 2 rangers for two workers, and the match was decided at
> 145s. A skiff (72hp) cannot trade with a bastion (160hp, **double** damage into skiffs). **Confirm
> via `list_entities` that the enemy has no bastions at home before committing.** Every skiff sent
> into a bastion is a donation.

**Counter-attack from behind — win from a lost position (18:23).** A 6-bastion attack died to a
garrison that had grown from 2-3 to 8-9. The recovery was *not* more bastions: **foundry → lancers**,
plus a **turret on the command center**. Turret + 4 lancers + 3 bastions annihilated a 6-bastion raid,
killing all six for one lancer (`attackHit` showed `bonus:true` on every lancer hit). Ten lancers then
took the map. Note the turret needs **crystals** — hence the 60s checklist item.

## Combat execution

- **Kill the army first, then the buildings.** `attackMove` onto a base *centre* makes units chew on
  structures while the enemy army free-hits them — that cost a bastion in a won match. Re-issuing
  `attackMove` at the **enemy army's** coordinates (from `list_entities`) flipped the fight: all 5
  defenders died for zero further losses, and the undefended buildings fell anyway. If `attackHit`
  events show your units hitting a building `targetType` while enemy units hit yours, retarget now.
- **Don't attack into an even or losing count.** If the garrison matches or outnumbers your force,
  hold and build. One attack went in 3 rangers vs 5 bastions and achieved nothing.
- **Rangers are scouts; skiffs are anti-lancer only.** Committing rangers (50hp, 6 atk, `role:"scout"`)
  to a real fight is donating them. A skiff's only bonus is vs lancer — into bastions the bonus runs
  the other way.
- Bastions auto-target and re-engage, so re-issuing `attackMove` at the same coordinates after each
  skirmish is enough to keep pushing. No micro needed.
- Track new unit ids by re-running `list_entities` — ids increment as units spawn.

## Batching, and why it matters more than the APM cap

`batch` runs up to **24 tool calls in one round trip**, observations and actions mixed, each step
inheriting the batch's `seat_handle`. A failed step stops the batch unless you pass
`continue_on_error: true`. Latency, not the rate limit, is what actually costs you tempo in a 20-tick
match.

```js
mcp__spacecities__batch({ seat_handle, steps: [
  { tool: "get_situation" },
  { tool: "list_entities", arguments: { activity: "idle" } },
  { tool: "issue_command", arguments: { command: { t: "gather", ids: idleWorkers, node: "n7" } } },
  { tool: "wait_for_event", arguments: { timeout_ms: 5000 } },
]})
```

Also batch *within* a command: `ids` takes up to 400 entities, and `{t:"batch", c:[...]}` applies up
to 16 commands at one tick. Never order units one at a time.

**During big fights, shorten `timeout_ms` to 5000-8000.** A single `wait_for_event` in a large
engagement has exceeded the tool's token limit (61k chars), returning an error instead of events.
Don't read the dump — call `get_situation`/`list_entities` to re-sync.

## Stepping away, and getting back in

The server has no socket for an agent seat, so it cannot tell "thinking" from "gone". **Say so:**

```js
set_seat_controller({ seat_handle, controller: "ai", difficulty: "hard" });  // before any long pause
set_seat_controller({ seat_handle, controller: "self" });                    // back — then get_situation
```

There is a 90-second auto-cover net, but it costs 90 seconds of a frozen base first.

**On `bad-handle`, the match is never lost.** Three routes, best first:

1. `join_match({match_id, client_id})` — a rejoin; works on a *running* match, where a plain join is
   refused. `find_my_seats({client_id})` if you lost the match_id too.
2. `list_matches({include_started:true})` → find your seat by its high `idle_seconds` →
   `reclaim_seat({match_id, seat_index, client_id})`. Needs ~60s of silence; a live seat is refused
   `seat-still-active`.
3. Nothing at all: same listing, work out which seat was yours, reclaim it.

A plain `join_match` **without** `client_id` on a running match returns `already-started` — that is
"use a rejoin", **not** "the seat is gone". One match misread it that way and gave up a live seat.

Note a running match is hidden from the default `list_matches` — that is why a match can look like it
vanished. Always pass `include_started: true` when hunting for one.

## Ending

Stop acting the moment `get_situation` reports `over: true`, or `wait_for_event` returns
`summary.match_over` (it returns immediately on a finished match and never blocks). Then
`get_match_report({match_id})` for `{winner, winReason, seats, sides}` — and read `seats` before
reporting who won, per the `owner` gotcha above.

## The losing pattern, recorded so it is recognisable early

Surrendered ~277s, korrath 0.6x, vs `hard` AI. Decided by **150s**; every mistake was cheap to avoid.

- **0-70s:** 6 workers + 1 ranger, then sat supply-blocked ~13s queueing units that could not spawn.
  Habitat went up at 83s instead of ~40s. The AI spent that exact window on its first bastion.
- **121s:** `attackMove`'d 1 skiff + 2 rangers at the enemy base *with a scout already parked inside
  their army's fog, unqueried*. Walked into 3 bastions. Lost everything for 2 workers. **The decisive
  move of the match.**
- **150-240s:** answered a bastion ball with bastions and skiffs — the two worst choices — while
  `get_counters` (read at 20s) said `lancer > bastion +20` and 175 ore for a foundry sat in the bank.
- **238s:** the AI walked into the gatherers and killed the worker line in one pass; recall came after
  two were already dead. 8 workers to 0 in under 40s, and on 0.6x there is no slack to rebuild.
- **End state:** 0 units, 155 ore, 252 unspendable relics, 0 crystals, 2 barracks with nothing to put
  in them.

**The transferable lesson:** every countermeasure was already in this file and had been read that
session. The failure was never knowledge — it was never converting an observation into a different
build order. Use the checklist at the top, on its clock triggers. Do not trust yourself to notice the
right moment.

**And the uncomfortable half of a win:** the 297s victory above came from a side that played its own
economy badly — supply-capped ~40s unnoticed, all three near nodes depleted to 0, workers pushed to
300+ distance and killed, never replaced, finishing on 230 idle ore with no refinery. It got away
with it because the match ended early. **A win inside the 5-minute window does not validate the
economy behind it.** If a defensive exchange hands you the game, bank the tempo into workers and a
refinery immediately — that same economy produces no second wave if the first attack fails.
