---
name: spacecities-player
description: Play a SpaceCities RTS match to win via its MCP tools (mcp__spacecities__*) — open a match, run the economy, scout, counter the enemy composition, and close it out. Use when asked to join, play, continue, or win a SpaceCities match.
allowed-tools: mcp__spacecities__create_match, mcp__spacecities__list_matches, mcp__spacecities__join_match, mcp__spacecities__leave_match, mcp__spacecities__find_my_seats, mcp__spacecities__reclaim_seat, mcp__spacecities__set_seat_controller, mcp__spacecities__get_situation, mcp__spacecities__list_entities, mcp__spacecities__get_map_overview, mcp__spacecities__get_tech_options, mcp__spacecities__get_counters, mcp__spacecities__issue_command, mcp__spacecities__wait_for_event, mcp__spacecities__batch, mcp__spacecities__surrender, mcp__spacecities__watch_match, mcp__spacecities__get_match_report, mcp__spacecities__take_turn, mcp__spacecities__estimate_engagement, mcp__spacecities__set_production_plan, mcp__spacecities__remember, mcp__spacecities__end_turn
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

Then, as soon as you hold a seat, **write your plan into the seat itself**:

```js
remember({ seat_handle, notes: "client_id=<id>; bastion turtle; foundry on their FIRST bastion; 2nd habitat at 18 supply" });
```

`remember({seat_handle})` with no notes reads it back. It survives a compaction, a restart and a
reclaimed handle — which is exactly when you need the plan and no longer have it. Update it when
the plan changes; re-read it whenever you come back or feel unsure what you were doing.

## The tools that do your waiting for you

Three of them change how the loop is written, and all three exist because an agent's think time is
tens of seconds while the sim runs at 20 ticks a second.

- **`take_turn`** is `wait_for_event` + `get_situation` in ONE call, returning the state *after* the
  events. Make it your loop. It halves the round trips and the context you burn per game-second —
  a recorded match was abandoned mid-game with the agent out of context budget.
- **`set_production_plan`** is a standing order: `[{building, unit, repeat, max_queued}]`, queued
  for you the moment you can afford each one. Set it the instant you decide what to mass. This is
  the single highest-value call in the whole surface — "keep making bastions" that survives your
  thinking time is worth more than any build order you can execute by hand.
- **`wake_on: {ore: 175}`** on `take_turn`/`wait_for_event` sleeps until you can afford something,
  instead of asking, being told `cannot-afford`, and asking again. A recorded loss burned ~60
  seconds of production in exactly that churn.

Two more that answer questions you used to have to guess at:

- **`estimate_engagement({your_ids, enemy_ids})`** — who wins, with a margin, and how many of each
  side are left standing (`your_survivors`/`enemy_survivors` — read these, not just the margin: a
  0.76x margin and "you lose all five, they keep three" are the same fact, and only one of them
  reads as a rout). Under ~1.5x it is a coin flip. **Call it before every commit.** The counter
  table tells you lancer beats bastion; it does not tell you that your one lancer loses to their
  three. **If fog has taken the ids, do not skip the call** — pass `enemy_composition:{bastion:8}`
  and weigh what you scouted. Asking with a stale number beats committing blind; a recorded match
  hit exactly this, wrote "fog blocks the estimate — committing", and fed five lancers into eight
  bastions. To size a force before building it, ask `your_composition:{lancer:20}` instead.
- **`list_entities`'s `enemy_last_seen`** — every enemy you have ever had in fog, with
  `age_seconds`. Use it instead of concluding anything from an empty list.

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
| **First enemy bastion sighted** | Start the **foundry** that same turn — do not answer bastions with bastions | The pivot takes 38s and 325 ore to produce one lancer. React late and it never arrives (see the deadline math) |
| Can't afford it yet | `wake_on` the shortfall, or plan it — never re-ask in a loop | The rejection tells you the exact number and ETA; churning on it cost a match ~60s of production |
| ~120s | Count your own bastions. **Fewer than 3?** Your economy is the problem, not your composition | The benchmark below: 4 by 180s wins, 1 by 160s loses |
| Before **any** `attackMove` | `list_entities` and count defenders **out loud** | Vision you don't query is worth nothing |
| Every `take_turn` | Read `summary.under_attack`; if **workers** are the target, recall now | The worker line dies in seconds and never recovers on 0.6x |
| Every `take_turn` | Read `economy.income_per_min` and `economy.workers_at_risk` | A stalled economy and a worker line wandering into the open both look like "150 ore" otherwise |
| On `workerRetargeted` | Check where that worker just sent itself; pull it back if it left home | A depleted seam re-tasks workers across the map, one at a time, until a single raider eats your economy |
| On `unitStalled` | Re-issue that worker's `gather` order | A stalled hauler never shows as idle and never banks; its cargo and its seam are both simply out of the economy |
| The moment you pick a unit to mass | `set_production_plan` for it | Production that only continues while you are awake is production that stops |
| Every `take_turn` | `supply_used >= cap - 6`? Queue the **next habitat now** | Reactive habitats cost minutes: one match banked 720-845 idle ore at cap while the barracks sat empty |
| Every `take_turn` | Barracks queue empty **and** ore > one unit? Requeue by hand | A `set_production_plan` **exhausts its `repeat` count silently**. "The plan is set" is not "the queue is full" |
| Within **30s** of any launch | Re-scout the target. Vision older than that is a guess | Four strike forces died walking into defenses — including a turret — that were not there when the attack was decided |
| After **any** lost strike | Rebuild the **garrison first**, army second | The recorded kill shot: a spent strike force, zero defenders at home, whole worker line and command centre gone in one pass |
| Before **any** commit | `estimate_engagement` | "Losing count" is a number, not a feeling |
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

### The pivot has a deadline, and it is earlier than it feels

Foundry is 175 ore / **22s** to build; a lancer is 150 ore / **16s**. So from the moment you decide,
**the first lancer is 38 seconds and 325 ore away** — before worker travel, and assuming the ore is
already banked. That number is the whole game:

- Sighting enemy bastions at **160s** means your first lancer lands around **200s**. An enemy that
  attacks at 180s wins before it exists. This lost a match (see the record below), and the loser's
  own post-mortem — "switch to foundry immediately when I saw 2 bastions" — is **still too late**.
- So treat the foundry as **insurance bought early, not a reaction**. It is 175 ore. Put it up while
  you are still safe, and the counter is 16s away instead of 38s when you actually need it.
- If they are already marching and you have no foundry, the pivot is not available. Defend with what
  you have plus a **turret** (150 ore + 100 crystals, 12s — far faster than a foundry chain), and
  accept that you are playing for the counter-punch, not the counter-unit.

### Benchmarks — check yourself against these, not against how busy you feel

Both sides of one 234s agent-vs-agent match, same map:

| Time | Winner had | Loser had |
|---|---|---|
| ~30-40s | barracks + habitat | barracks + habitat (identical) |
| ~120s | ramping bastions, workers still queuing | — |
| ~160s | 3-4 bastions | **1 bastion, no foundry** |
| ~180s | **4 bastions**, 1 held home as garrison | scout dead, no vision |
| end | 6 units, **supply at cap (18)** | 3 units, **5 supply, 170 idle ore** |

The openings were the same. **The match was decided by production rate, not by the build order** —
"4 bastions vs their 1" in the winner's own words. If you are at 1-2 bastions around 160s with ore in
the bank, stop diagnosing composition and fix the queue: you are not supply-blocked *and* not
spending, which means you simply are not queueing enough.

**Supply used is your real production meter.** The winner finished at cap; the loser finished on 5
supply holding 170 ore. Idle ore with spare supply is always a queueing failure.

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

`list_entities` now says this out loud so you cannot miss it: `enemy_currently_visible: false` with
a populated `enemy_last_seen` means *you have lost sight of them*, and each entry's `age_seconds`
says how old that sighting is. A 40-second-old bastion position is where they were, not where they
are. Nothing but `over`/`winner` and `get_match_report` ever decides a match.

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
  four minutes chasing a phantom bug here. **Read the rejection's own `detail`**: it names the
  `cost`, what you `have`, the `short`fall and `seconds_until_affordable` at your measured income.
  Then either `wake_on` that number or set a `set_production_plan` entry and stop asking.
- Queue-stuffing cannot beat the supply cap: reservations happen at queue time.

**Supply.** You start at **10** (command center). Each habitat adds **+8**, but only once it has
finished building. Bastions cost 2 supply each, so the cap binds far sooner than it feels like it
should. Build the 2nd and 3rd habitat as soon as ore allows rather than waiting for
`refused (supply-capped)` / `productionBlocked{reason:"supply"}` — stalled production is pure lost
tempo.

**Watch the FLOW, not the balance.** `get_situation`'s `economy` block reports
`income_per_min` (gross delivery, measured), `gatherers`, and `workers_at_risk` — named gatherers
standing too far from home or next to a recently-seen enemy. A recorded loss never noticed its
economy had died until it had 5 ore and no workers; another lost six workers to one raiding bastion.
Check both every turn, and pull exposed workers back — the army goes between them and the enemy,
not chasing the raider across the map.

**Node depletion.** Nodes drain to `amount: 0` while workers still *look* busy. On `nodeDepleted`
(and its pair, `workerRetargeted`, which names the node the worker just sent itself to and how far),
workers auto-retarget the **nearest** node — which after a battle is often a junk **36-ore unit
wreck**, so income silently stalls. Re-issue `gather` explicitly at a real, rich node whenever
`nodeDepleted` fires; prefer the large far nodes (1170 ore) over small home ones (525) once home is
dry.

**Three workers per node, not more.** `UNITS.worker.minerSoftCap` is **3**: the first three miners
on a seam work at full rate, the fourth and beyond pull only **0.4** of a share each. Two or three
on one rock is correct and is not something to "fix" — spreading a crew of three across three seams
buys nothing but walking time. Past the cap the node draws a saturation ring and posts a live
`miners/3` count.

**A stalled gatherer is not an idle one, and only one signal reports it.** A worker wedged on the
way to a seam or to a drop-off still has an order and is still walking, so it never appears in
`idle_unit_ids` and its `activity` reads as a perfectly ordinary `gathering`. `wait_for_event`'s
**`unitStalled`** (`phase`, `reason`, `seconds`) is the only thing that names it — fired once per
leg after ten seconds of no progress toward the target. Treat it like `nodeDepleted`: re-issue the
worker's order rather than assuming it will sort itself out. `list_entities` also carries a
gatherer's **`cargo`** and **`gather_phase`** (`toNode` / `mining` / `toDrop`) on your own units, so
"gathering / toDrop / cargo 10" unchanged across two polls is a diagnosis, not a worker doing its
job.

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
  — and note that, like every `{t:...}` form in this section, it is a **command passed to
  `issue_command`, not a tool of its own**. Calling `mcp__spacecities__setRally` errors with *"No
  such tool available"*; a recorded match lost its rally point mid-rebuild to exactly that. Pointed
  at the command center means every new unit walks home to the defensive position instead of
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
- **Size the garrison against the enemy army you have actually SEEN, not a fixed number.** One win
  held back a single bastion and was never punished — because scouting had confirmed the opponent
  only ever had one. That is not a rule that 1 is enough; it is the same rule as always, priced
  against a known enemy. Unscouted, or against a force that can arrive in full, the earlier
  guidance stands: nearer 50% than 35%, and never zero.

- **The garrison floor is never the source of reinforcements for an attack.** Topping an attack
  up from home is how a base ends up empty: the 997s loss below sent "most of the army, keeping a
  modest home guard" four times, and each rebuild came out of the guard. The floor grows with the
  clock; it is never spent.
- **A spent strike force is an emergency at home, not a prompt to rebuild the army.** The moment a
  commit dies, the enemy knows your base is empty and is already moving. Queue defenders and put
  them on the command centre coordinates before you queue anything else.

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
5. **120-200s:** mass bastions continuously. Nothing else. Do this with
   `set_production_plan([{building: barracksId, unit: "bastion", repeat: 8}])` rather than by hand:
   the recorded losses did not fail to know they should mass bastions, they failed to be awake at
   the moment each one became affordable.
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
- **Don't attack into an even or losing count — and check that with `estimate_engagement`, not by
  eye.** Fog is not an excuse to skip it: `enemy_composition` answers from your last scout, and
  `assumed_composition:true` in the reply tells you the answer rests on it. Pass your ids and the
  defenders' ids and read `predicted_winner`, `margin` and the survivor counts. **The bar is not
  one number — it depends on where the fight happens:**
    - **A fight in the field** (their raid at your base, an army you catch in the open): under
      ~1.5x is a coin flip. Above it, commit.
    - **An assault on their base needs far more, and 1.5x is nowhere near enough.** The call prices
      ONE engagement against the units you name it. A base is a running fight: the defender
      reinforces from its barracks mid-fight, fights under a turret you may not have seen, and pays
      no travel time, while you arrive tired and piecemeal. **A 3.32x estimate lost an entire strike
      force; the winning assault in that same match went in at 11.79x.** Treat anything under ~3x as
      a field-fight number misapplied, and wait for the estimate to read as a rout.
  One attack went in 3 rangers vs 5 bastions and achieved nothing; another match fed
  single lancers into a 4-unit ball three times running. Both would have been answered in one call.
- **Arrive together or not at all.** A unit that walks out as it spawns fights alone and dies alone.
  `setRally` to the garrison point, gather the ball at home, then commit it with ONE command
  (`ids[0]` leads). If you are reinforcing mid-fight, send the reinforcement to the fight, not the
  spawn to the map.
- **Rangers are scouts; skiffs are anti-lancer only.** Committing rangers (50hp, 6 atk, `role:"scout"`)
  to a real fight is donating them. A skiff's only bonus is vs lancer — into bastions the bonus runs
  the other way.
- **A scout has a job, then a retreat.** Park it, call `list_entities`, write the count down — then
  **pull it back out of range**. A ranger left sitting in their army dies the moment that army moves,
  and it dies exactly when you most need it: one loss went blind at 180s because the scout was still
  parked where it had finished scouting an hour of game-time earlier.
- **Killing THEIR scout is a real tempo move**, not incidental. The winner of that same match listed
  "killed their scout at ~180s" among its decisive plays — it blinded the opponent right before the
  attack landed. A lone enemy ranger wandering past your garrison is free value; let the idle
  garrison take it.
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
  { tool: "issue_command", arguments: { command: { t: "gather", ids: idleWorkers, node: "n7" } } },
  { tool: "take_turn", arguments: { timeout_ms: 5000 } },   // wait AND re-read, in the same trip
]})
```

`take_turn` already folds the wait and the situation read together, so a batch that used to be four
steps is usually two: act, then take your turn.

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

Prefer a standing production order to a handover where you can: a `set_production_plan` keeps
spending while you are away without giving the seat to an AI that will play its own game with your
army. Use both for a genuinely long pause.

**On `bad-handle`, the match is never lost.** Three routes, best first:

1. `join_match({match_id, client_id})` — a rejoin; works on a *running* match, where a plain join is
   refused. `find_my_seats({client_id})` if you lost the match_id too.
2. `list_matches({include_started:true})` → find your seat by its high `idle_seconds` →
   `reclaim_seat({match_id, seat_index, client_id})`. Needs ~60s of silence; a live seat is refused
   `seat-still-active`.
3. Nothing at all: same listing, work out which seat was yours, reclaim it.

Once back in: `remember({seat_handle})` reads back the plan you left there, which is faster and more
reliable than re-deriving it from the board.

A plain `join_match` **without** `client_id` on a running match returns `already-started` — that is
"use a rejoin", **not** "the seat is gone". One match misread it that way and gave up a live seat.

Note a running match is hidden from the default `list_matches` — that is why a match can look like it
vanished. Always pass `include_started: true` when hunting for one.

## Ending

Stop acting the moment `get_situation`/`take_turn` reports `over: true`, or the wait returns
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

## The OTHER losing pattern: the long game you were winning

Recorded in full from **both seats** — a 997s match where the loser had the better economy the whole
way and still lost by elimination. This is the failure mode the rest of this file does not catch,
because every individual decision looked defensible.

**The loser (seat `ai`)** peaked at **800-1000+ ore/min, 5 habitats, 50 supply** — a bigger economy
than the winner ever had. It launched **four separate strike forces** at the enemy base. All four
were wiped. After the fourth, the opponent walked into a base with **zero defenders**, killed the
entire worker line, and took the command centre.

**The winner (seat `player`)** had its *own* first push wiped by hidden bastions. It then attacked
**twice** in the whole match. In between it destroyed **three full enemy armies at home**, on its own
command centre, behind a turret.

Neither side out-mechaniced the other. Four things separated them:

1. **Incremental commitment is the trap.** "Attack with most of the army, keep a modest home guard,
   rebuild, attack again" is four forces that each lose, when one force built from all four would
   have won. If you cannot commit at a margin that reads as a **rout** (see the margin bar below),
   you are not ready to attack — you are ready to keep massing. **A second attempt at the same base
   with a similar-sized force is the same decision, and it has already failed once.**

   **The garrison floor comes off the top, not out of the strike force.** Count the home guard
   first, then ask whether what is LEFT clears the bar. If it doesn't, you are not ready — the
   answer is never to borrow from home. A 708s loss did exactly that: it committed 5 bastions + 1
   lancer at a reported **3.32x**, killed their scout and their entire worker line on the way in,
   and then had nothing at home when the counter-raid arrived. Its own post-mortem names it:
   *"committing the entire army in one strike rather than keeping a home garrison."* "One decisive
   force" and "an empty base" are not the same sentence.
2. **Defence is a resource multiplier, not a delay.** The defender pays no travel time, fights under
   its turret, and reinforces from the barracks mid-fight. The winner's three defensive wins cost it
   almost nothing and cost the attacker everything. **Against an opponent that keeps attacking you,
   the correct play can be to keep not attacking.**
3. **Harvest the wrecks.** Every one of those battles left wrecks *on the winner's doorstep* — 1232
   ore at distance 114, then 1852 ore at distance 78. It redirected workers onto them immediately and
   rebuilt its economy twice off its own defensive kills. Losing a battle at your base and winning one
   at theirs both produce wrecks; only one of them produces wrecks you can actually mine. **After any
   fight near home, `get_map_overview` for new nodes and send idle workers.**
4. **Rebuilding the army is not rebuilding the defence.** Both are "queue units", and only one of them
   keeps you alive. See the garrison floor rule above.

**The tell, and it is loud:** if you have attacked the same base twice and been wiped twice, the
plan is wrong, not the execution. Stop. Turtle, take the wrecks, mass to a force that
`estimate_engagement` calls a rout, and go once.

**Confirmed in a second two-sided match (708s, korrath 0.6x)**, where the two seats split on
exactly this and the winner's log reads like this section: it let the enemy strike force come to its
defended base and killed it there, rebuilt an economy that had lost its ENTIRE worker line and its
foundry off a 1180-ore wreck at distance 107, re-scouted, and then attacked once at 11.79x and ended
the match. The loser attacked first, at 3.32x, and never got a second economy. Losing your worker
line is survivable; losing your worker line at *their* base is not, because the wrecks that would
have paid for the rebuild are sitting under their army.

**One caveat, so this is not read as "never attack":** the winner did have to attack eventually, and
it won by doing so — *after* the opponent's army was spent against its garrison. Turtling is how you
buy the favourable attack, not a substitute for one. A pure turtle with no finishing push is the same
loss on a longer clock.

## Match record — the same 234s match from BOTH sides

The strongest evidence in this file, because nothing is reconstructed: two agents, one match, each
writing up its own result. Openings were **identical** (barracks ~30s, habitat ~40s, ranger scout).

**The winner (seat `ai`)** simply kept producing: 4 bastions by 180s, one held on the command centre,
three sent west. It killed the enemy scout, then took a 3v1 against their single bastion, then the
workers, then the command centre. It finished at supply cap. Its own summary: *"Game decided when you
had 4 bastions vs their 1."*

**The loser (seat `player`)** did the checklist and still lost:

- ✅ Read `get_counters` at 20s and **knew** lancer +20 beats bastion.
- ❌ Saw 2 enemy bastions at 160s with 1 bastion and no foundry — and **queued more bastions**.
- ❌ Left the scout parked in their army; it died at ~180s, taking all vision with it.
- ❌ Had no garrison on the command centre when the attack came; recall was too late.
- Ended on **170 idle ore and 5 supply**, rebuilding workers into a lost position.

**Two lessons that are new, and neither is "read the counter table" — it did that:**

1. **Knowing the counter and *paying for it in advance* are different acts.** The counter was read at
   20s and never converted into a foundry. By the time the sighting made it urgent, the 38s pivot
   could not land. Buy the foundry while you are safe.
2. **Same opening, opposite result, decided by production rate.** Neither side out-built the other on
   *plan*; one just kept the queue full. Check the benchmarks above at 120s and 160s, because "I am
   executing the opening correctly" is exactly what the loser reported at 70s and it was true.

One footnote worth knowing: the two reports **disagree about the final state** (the loser lists a
damaged command centre still standing; the winner reports it destroyed). The winner is right — the
loser's table came from a `get_situation` taken slightly before the end. **Read `get_match_report`
for the outcome; your last observation is stale by definition.**

**And the uncomfortable half of a win:** the 297s victory above came from a side that played its own
economy badly — supply-capped ~40s unnoticed, all three near nodes depleted to 0, workers pushed to
300+ distance and killed, never replaced, finishing on 230 idle ore with no refinery. It got away
with it because the match ended early. **A win inside the 5-minute window does not validate the
economy behind it.** If a defensive exchange hands you the game, bank the tempo into workers and a
refinery immediately — that same economy produces no second wave if the first attack fails.

## What the server now does for you (and why you should let it)

Everything in this section exists because a recorded match was lost to the thing it fixes. None of
it plays the game for you; all of it removes the tax of playing through a request/response transport.

| Instead of | Call | The loss it answers |
|---|---|---|
| `wait_for_event` then `get_situation` | `take_turn` | An agent ran out of context re-reading the same board and abandoned a live match |
| queue → `cannot-afford` → wait → retry | `set_production_plan`, or `wake_on` | ~60s of production churned away 25 ore short of a Foundry |
| guessing an x/y and being refused | `{t:"build", ..., near:{x,y}}` | Three commands and ~15s spent hunting a legal turret spot mid-attack |
| eyeballing whether a fight is winnable | `estimate_engagement` | Single lancers fed into a four-unit ball, three times running |
| "no enemies in `list_entities`, I've won" | `enemy_last_seen` + `over`/`winner` | Victory declared twice while the opponent's army was intact |
| re-deriving your plan after a compaction | `remember` | The plan written at 40s was not the plan being played at 180s |
| a stock of ore | `economy.income_per_min` | An economy that had stopped looked identical to one about to pay for the next unit |
| watching for wandering gatherers | `economy.workers_at_risk`, `workerRetargeted` | Six workers, then the whole worker line, eaten by one raider |
| losing the game to your own think time | `clock_policy:"deliberation"` + `end_turn` | Only available in agent-only matches — the world waits for your turn instead of running while you think |

A rejection now carries `detail`: the `cost`, what you `have`, the `short`fall, and
`seconds_until_affordable` at your **measured** income (or nothing at all, if that income would never
get there — which is itself the answer). Every `issue_command` result carries `apm_remaining`.
Read them instead of guessing.
