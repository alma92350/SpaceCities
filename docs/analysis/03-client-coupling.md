# 03 — Client coupling: what must change to become a networked client

**Status:** analysis, input to ADRs and `TASKS.md`. Not a specification.
**Source audited:** `/home/user/alma92350/spaceexploration-rts` @ working tree (read-only clone).
**Assumed decision (upstream):** server-authoritative headless Node sim; the browser renders a
state it is given and sends commands instead of mutating locally.

All `file.js:line` citations are against the SOURCE tree. Line numbers are exact at the time of
writing; they are cited so a reader can confirm each claim, not as a patch plan.

---

## 0. Headline findings

Five facts shape everything below. They are the reason this port is a re-seaming job and not a
rewrite.

1. **The client barely mutates the sim.** Outside `engine/`, sim mutation happens at exactly
   **56 call sites** across **6 files** — and *all but 10 of them* go through named engine
   functions (`issue*`, `queueProduction`, `sell`/`buy`, …) that already take an explicit
   `(state, entityId, args)` shape. Those 46 sites are already command envelopes; they just
   aren't serialized. The other 10 are `state.selection = …`, which isn't sim state at all
   (`engine/persist.js:777` resets it to `[]` on load).
2. **No client file writes `resources` or `credits` directly.** Verified by grep — zero hits.
   Every economic mutation is an engine call. The trust boundary is therefore already drawn in
   the right place; it is simply not enforced.
3. **The engine is already owner-generic in its bones.** `state.owners` is the canonical side
   list, `state.players` and `state.fogs` are keyed by owner id, and `state.fog`/`state.fogAI`
   are documented *aliases* into `state.fogs` (`engine/state.js:167-189, 227-234`), pinned by
   `test/ownerScaffold.test.js`. Victory already iterates `state.owners`
   (`engine/victory.js:11, 30, 165`). "Seat 3 of 5" is a change to `ownerDefs`
   (`engine/state.js:174-181`), not a sweep.
4. **The renderers are already owner-generic for colour and already fog-gate every entity.**
   Team colour is read as `state.players[owner].color` at all four draw sites
   (`renderUnits.js:66`, `renderBuildings.js:75`, `minimap.js:95`, `minimap.js:100`); the
   fog rule is factored into one named predicate, `renderShared.js:253 hiddenByFog`. Nothing
   hardcodes `#4fd1ff`/`#f87171` for entities — those literals live in `engine/state.js:179-180`
   as *data*.
5. **The sim is cheap.** Measured on this machine: a full skirmish with **both** seats
   AI-driven costs **0.096–0.142 ms/tick** (27,000 ticks, 15 sim-minutes, small and 2× maps).
   At 20 Hz that is ~0.2–0.3 % of one core per match. A single Node process can host dozens of
   concurrent matches without breaking a sweat. Headless authority is not a performance risk.

The real work is concentrated in three places: `boot.js` (the lifecycle), `input.js` +
`inputCommands.js` + `hudSelection.js` (the ~46 synchronous engine calls), and the ~110
hardcoded `"player"`/`"ai"` owner literals scattered across the HUD and renderers.

---

## 1. The local-authority inventory

### 1.1 `engine/commands.js` `issue*` — direct order issuance

`engine/commands.js` exports 22 `issue*` functions (lines 231–531). Four client files import
them. **Every one of these becomes `submitCommand(envelope)`.**

| Site | Call | Notes |
|---|---|---|
| `main.js:21` | *import* `issueMove, issueAttackMove` | minimap right-click |
| `main.js:149` | `issueAttackMove(combatants, world.x, world.y)` | minimap command |
| `main.js:150` | `issueMove(others, world.x, world.y)` | minimap command |
| `input.js:12` | *import* `issueBuild, issueStop, issueScout, issueHold, issueHoldFormation, issuePatrol` | |
| `input.js:346` | `issueStop(selectedUnits())` | S key |
| `input.js:351` | `issueScout(selectedUnits())` | scout toggle |
| `input.js:355` | `issueHold(selectedUnits())` | H key |
| `input.js:372` | `issuePatrol([u], points)` | per-unit patrol loop |
| `input.js:379` | `issueHoldFormation(selectedUnits(), game.formation.shape, game.formation.leaderPos)` | reads client-only `game.formation` (`session.js:75`) |
| `input.js:521` | `issueBuild(state, worker.id, buildingType, p.x, p.y)` | **returns a value the client uses** — see §1.6 |
| `inputCommands.js:27` | *import* 11 `issue*` | the right-click router |
| `inputCommands.js:94` | `issueAttackMove(combatants, x, y, queue, formation)` | |
| `inputCommands.js:95` | `issueMove(others, x, y, queue, formation)` | |
| `inputCommands.js:199` | `issueSetRally(building, p.x, p.y, node?.id)` | passes a **live building object**, not an id |
| `inputCommands.js:212` | `issueAssistBuild(workers, target.id, target.type, queue)` | |
| `inputCommands.js:226` | `issueServiceBuilding(workers, target.id, queue)` | |
| `inputCommands.js:235` | `issueRepair(workers, target.id, queue)` | |
| `inputCommands.js:245` | `issueSetHomeBase(eligible, target.id)` | |
| `inputCommands.js:249` | `issueAttack(attackers, target.id, queue)` | |
| `inputCommands.js:259` | `issueFerryFreighter(workers, target.id, queue)` | |
| `inputCommands.js:266` | `issueRepair(workers, target.id, queue)` | |
| `inputCommands.js:273` | `issueEscort(escorts, target.id, queue)` | |
| `inputCommands.js:278` | `issueGather(workers, node.id, queue)` | |
| `inputCommands.js:282` | `issueMove(selected, p.x, p.y, false, currentFormation(heading))` | |
| `hudSelection.js:21` | *import* `issueSetAILogistics, issueSetCollectPoint, issueSetLogiPriority, issueRecycle, issueCancelRecycle` | |
| `hudSelection.js:518` | `issueSetAILogistics([f], !on, state)` | |
| `hudSelection.js:542` | `issueSetCollectPoint([f], !on)` | |
| `hudSelection.js:600` | `issueSetLogiPriority(state, b.id, LOGI_PRIORITY_NEXT[cur])` | |
| `hudSelection.js:1821` | `issueCancelRecycle(recyclingNow)` | passes **live entity objects** |
| `hudSelection.js:1835` | `issueRecycle(recyclable)` | passes **live entity objects** |
| `tools/ailab.js:78,82,168-320` | `issueAttackMove`, `issueBuild` | headless bench, not shipped client |

**Shape problem to fix once:** most `issue*` take **arrays of live unit objects**, and three take
live building/entity objects (`inputCommands.js:199`, `hudSelection.js:1821`, `:1835`). A wire
envelope must carry **ids**. Recommended: add one dispatcher,
`applyCommand(state, seat, {verb, ids, args})`, in `engine/commands.js` that resolves ids →
entities, **filters to entities owned by `seat`** (this is the anti-cheat gate, and it does not
exist anywhere today), then calls the existing `issue*` unchanged. Every existing
`test/commands.test.js` assertion (503 LOC) keeps passing against the raw `issue*`.

### 1.2 Non-`issue*` engine mutators called from the client

These are just as authoritative and are easy to miss because they don't share a prefix.

| Site | Call | Subsystem |
|---|---|---|
| `hudSelection.js:1098, 1104, 1198, 1629` | `queueProduction(state, b.id, t[, true])` | production |
| `hudSelection.js:197` | `cancelProduction(state, building.id, i)` | production |
| `hudSelection.js:1149` | `researchUpgrade(state, refinery.id, u.id)` | tech |
| `hudSelection.js:1179` | `researchTech(state, datacenter.id, t.id)` | tech (Odyssey) |
| `hudSelection.js:235` | `cancelResearch(state, building.id, i)` | tech |
| `hudSelection.js:381, 395, 405` | `sell(game.galaxy, state, com, qty)` | market (Odyssey) |
| `hudSelection.js:414` | `buy(game.galaxy, state, com, TRADE_LOT)` | market (Odyssey) |
| `hudSelection.js:449, 485` | `loadFreighter(state, f.id, com, qty)` | freight (Odyssey) |
| `hudSelection.js:459, 494` | `unloadFreighter(state, f.id, com, qty)` | freight (Odyssey) |
| `hudSelection.js:630` | `offerTribute(game.galaxy, state)` | diplomacy (Odyssey) |
| `hudSelection.js:661` | `fulfillRequest(game.galaxy, state)` | diplomacy (Odyssey) |
| `hudSelection.js:705` | `offerGift(state, com, TRADE_LOT)` | diplomacy (Odyssey) |
| `hudSelection.js:766, 777, 781, 793` | `unassignShipFromLane / assignShipToLane / deleteLane / createLane` | lanes (Odyssey) |
| `hudSelection.js:831, 837, 850, 870, 876` | `setColonyPolicy(g, planetId, …)` | colony policy (Odyssey) |
| `hudSelection.js:900` | `upgradeToCapital(state, cc)` | Odyssey |
| `hudSelection.js:905` | `packCommandCenter(state, cc.id)` | Odyssey |
| `hudSelection.js:1386` | `upgradeSpaceport(state, spaceport)` | Odyssey |
| `hudSelection.js:1455` | `lightFuse(state, bomb)` | bombs — **skirmish, must be a command** |
| `hudSelection.js:1750` | `deployColonyShip(state, colonyShip.id)` | Odyssey |
| `hud.js:37` | `repairConvoy(game.state)` | scenario |
| `hud.js:38` | `departNow(game.state)` | scenario |
| `starmap.js:229, 239, 244` | `setColonyPolicy(g, w.id, …)` | Odyssey |

For **v1 skirmish MP**, the mandatory set is small: `queueProduction`, `cancelProduction`,
`researchUpgrade`, `cancelResearch`, `lightFuse`, plus the `issue*` family. Everything marked
Odyssey is out of scope (§7) and stays reachable only on the offline path (§8).

### 1.3 Direct `state.*` writes

Only two kinds exist in the whole non-engine tree.

| Site | Write | Verdict |
|---|---|---|
| `input.js:318, 337, 382, 395, 411, 543` | `state.selection = …` | **Not sim state.** Move to the client session. |
| `inputCommands.js:147, 152, 154, 157, 177` | `state.selection = …` | same |
| `boot.js:766` | `state.events.length = 0` | The client *drains* the sim's event queue. On the server path, events arrive per-snapshot and are consumed the same way. |

`state.selection` also has **2 engine references** (`engine/state.js:346` prunes dead ids;
`engine/galaxy.js:1422` clears both sides on a jump), **32 client references** and **124 test
references**. It is single-seat by construction and *must* move out of the shared sim state — it
is the single largest mechanical edit in the port. `engine/persist.js:777` already proves it is
disposable (it saves as `[]`).

### 1.4 `state.players.player.resources` and friends — direct owner-keyed reads

There are **no writes**. Reads (all of which become "read *my* seat"):

| Site | Read |
|---|---|
| `hud.js:99` | `{ ...state.players.player.resources }` (flow history sample) |
| `hud.js:174` | `state.players.player.resources` (topbar readout) |
| `hudSelection.js:272, 363, 432, 522, 680` | `state.players.player.resources` |
| `hudSelection.js:651` | `state.players.player.resources[req.com]` |
| `hudSelection.js:508, 1122, 1157` | `state.players.player.upgrades` |
| `hudSelection.js:1941` | `state.players.player.color` (button sprite tint) |
| `hudSelection.js:1955` | `canAfford(state.players.player.resources, cost)` |
| `hudPanelSignature.js:146, 264, 344` | `state.players.player.resources` |
| `hudPanelSignature.js:180` | `state.players.player.upgrades` |
| `hudPanelSignature.js:227, 228` | `state.players.player.resources[…]` |
| `overlays.js:34` | `st.players.player.faction` **and `st.players.ai.faction`** |
| `observer.js:276` | `state.players.ai` (spectator stats) |
| `techChart.js:36` | `const OWNER = "player"` — the whole module's owner, used at `:138, :153, :196` |

**Fix:** one accessor. `me(state)` → `state.players[session.seat]`. 20 sites, purely mechanical.
`overlays.js:34` and `observer.js:276` are the two that read *someone else's* player record and
therefore need a public-facts channel under filtering (§4).

### 1.5 `createGameState` / `tick()` / `createLoop` — the sim ownership itself

All in `boot.js`. This is the file that becomes the transport.

| Site | Call |
|---|---|
| `boot.js:14` | *import* `createGameState` |
| `boot.js:16` | *import* `createLoop` |
| `boot.js:17` | *import* `tick` |
| `boot.js:22` | *import* `createSelfPlayState, tickSelfPlay, SELFPLAY_HZ` |
| `boot.js:119` | `createGameState({ planetId, seed, rng: mulberry32(seed), … })` — skirmish |
| `boot.js:169` | `createGameState({ … })` — competition fixture |
| `boot.js:207` | `createSelfPlayState({ … })` — watched AI-vs-AI |
| `boot.js:236, 244, 252` | `setupEscort / setupRaider / setupBounty` — scenarios |
| `boot.js:262` | `createGalaxy({ … })` — Odyssey |
| `boot.js:287` | `jumpCapital(game.galaxy, destId, …)` |
| `boot.js:344` | `surrenderGalaxy(game.galaxy)` |
| `boot.js:485` | `loop = createLoop({ hz, speed, update, render })` |
| `boot.js:503` | `stepGalaxy(game.galaxy, dt)` |
| `boot.js:504` | `sweepColonies(game.galaxy, dt)` |
| `boot.js:530` | `tickSelfPlay(game.state, dt)` |
| `boot.js:531` | `tick(game.state, dt)` — **the single skirmish tick** |

Note `engine/loop.js:34` `createLoop` is a *render* loop with an embedded fixed-step accumulator.
On the server, the accumulator half is reusable verbatim; the `requestAnimationFrame` half
(`engine/loop.js:69, 77, 81`, each marked `browser-exempt`) needs a `setInterval`/timer driver.
Recommendation: extract the accumulator into a `stepper` and give it two drivers, rather than
forking the file — the fixed-step semantics documented at `engine/loop.js:18-26` are what make
replay determinism hold, and they must not diverge.

### 1.6 Return values the client consumes — the "optimistic" hazards

Three call sites use the *return value* of a mutation, which a fire-and-forget command envelope
cannot provide:

- `input.js:521` — `issueBuild(...)` returns the new building id or `null`; the client uses the
  falsy result to keep build mode armed and play a rejection sound. Under server authority this
  becomes a *rejection message* or an optimistic ghost that clears on the next snapshot.
- `hudSelection.js:449, 459, 485, 494` — `loadFreighter`/`unloadFreighter` return the quantity
  actually moved and drive the UI feedback (`sound.playProductionBlocked()` on 0). Odyssey-only.
- `boot.js:287` — `jumpCapital` returns a result object or `null`. Odyssey-only.

Only the first matters for v1.

---

## 2. `session.js` / `boot.js` — the lifecycle, and how it re-shapes

### 2.1 `session.js` today (120 LOC)

A single exported mutable object, `game`, that every UI module reads **at call time** (never
destructured at module scope) so a restart is picked up automatically. Its 17 fields are exactly
three kinds of thing:

| Kind | Fields | MP fate |
|---|---|---|
| **The sim handles** | `state` (`session.js:16`), `galaxy` (`:22`) | Become *received* state; `galaxy` out of v1 |
| **The input controller** | `input` (`:17`) | Stays; becomes command-emitting rather than state-mutating |
| **Per-viewer UI state** | `supplyBlockedUntil` (`:34`), `lastAttackAt` (`:40`), `lastGateCharge` (`:52`), `colonyAlerts` (`:64`), `groups` (`:69`), `formation` (`:75`), `collapsedSections` (`:84`), `observerMode` (`:89`), `spectateId` (`:92`), `spectatePreview` (`:99`), `observerCamera` (`:103`), `spectateSpeed` (`:119`) | **Stays exactly as-is.** None of it is sim state; all of it is per-client. |
| **Match-provenance flags** | `competition` (`:30`), `spectateMatch` (`:114`) | Replaced by `match` (server-issued match descriptor) |

**This object is the right shape already.** The port adds fields, it does not restructure:
`seat` (my owner id), `seats` (public roster: id, name, colour, faction, isAI/isAgent),
`transport`, `connection` (connecting/live/desynced/dropped), `serverTick`, `selection`
(moved off `state`), and `role` (`"player" | "spectator"`).

### 2.2 `boot.js` today — the lifecycle in one line each

```
main.js:165  renderMapSelect()                      splash / map-select screen (setup.js:306)
             └ user picks world + dials → setup     (setup.js:104, the shared config object)
boot.js:109  startGame(planetId)                    resolveSeed → difficultyDials → createGameState
boot.js:443  bootState(newState, {intro})           THE single boot path — 5 other entry points funnel here
   :444-446    stop old loop, destroy old input, exitObserverMode
   :447-451    hide mapSelect / gameOver / underAttack overlays
   :453-457    clear galaxy / competition / spectateMatch / groups / colonyAlerts
   :458        game.state = newState
   :463-465    seed chip, faction chip, objectives strip
   :466        game.input = attachInput(canvas, state, () => renderHUD())
   :471-475    open camera on state.map.bases.player, clamp
   :476-482    resetEffects / resetFacing / resetPanelSignature / resetWorldUiBookkeeping / clearPause
   :485        loop = createLoop({ hz: PLAY_HZ(20) | SELFPLAY_HZ, speed, update, render })
   :499-532      update(dt): pause gate → snapshotPositions → (stepGalaxy | tickSelfPlay | tick)
   :533-579      render(alpha): tickCamera → drawFrame → drawMinimap → processFrameEvents
                                → throttled renderHUD/renderObserverPanel (150 ms)
                                → **over-poll**: if (state.over && !announced) → showGameOver
   :581        loop.start(); :582 renderHUD()
boot.js:400  restartToMapSelect()                   loop.stop, input.destroy, null state/galaxy,
                                                    clearPause, renderMapSelect, unhide mapSelect
```

Five other entry points reuse `bootState` verbatim: `startCompetitionMatch` (`:159`),
`startSpectatedMatch` (`:204`), `startScenario`/`startRaider`/`startBounty` (`:234/:242/:250`),
`startOdyssey`→`bootGalaxy` (`:259`/`:273`), and `saveload.js`'s load path.

Three structural properties matter for the port:

- **End of match is a *poll*, not an event** (`boot.js:551`: `if (game.state.over && !announced)`).
  There is no callback, no state machine. The client discovers the match ended by looking.
- **`bootState` is idempotent teardown-then-setup.** Every "leaving" concern is already
  centralised — the comment block at `boot.js:390-399` documents exactly why nulling the session
  matters (stale hotkeys, the autosave timer writing after "Exit without Saving").
- **The loop reads `game.state` live** (`boot.js:501, 503, 530, 531, 545`), never a captured
  binding. Swapping the state under it is already a supported operation (that is how the Odyssey
  jump works, `boot.js:365 focusActivePlanet`).

### 2.3 The multiplayer re-shape

The lifecycle gains one screen and loses ownership of two transitions. Concretely:

```
SPLASH  →  LOBBY  →  (host: configure | join: wait)  →  server: MATCH_START
        →  bootState(receivedSnapshot, {seat})  →  loop(render-only) + command submit
        →  server: MATCH_END  →  post-match screen  →  LOBBY
```

**`setup.js` splits in two.** `setup.js:104`'s `setup` object is *match configuration* — world,
seed, difficulty, sizeMult, resourceMult, matchTimeLimit, popCap, faction. In MP that object is
the **host's lobby form**, sent to the server once, and echoed back to every client as part of
the match descriptor. The battlefield cards (`setup.js:306 renderMapSelect`) stay verbatim for
the host; joiners see the same cards read-only. `setup.js` keeps its exported option tables
(`MAP_CHOICES:29`, `MATCH_LENGTH_OPTIONS:59`, `POP_CAP_OPTIONS:77`, `STRATEGY_OPTIONS:98`,
`DIFFICULTY_OPTIONS` re-export at `:18`) unchanged — they are pure data and the server needs
the same lists to validate a lobby form.

**`startGame` inverts.** `boot.js:109-125` currently *constructs* the state. It becomes:

```
startGame(planetId)  →  transport.requestMatch(setup)   // returns nothing; server decides
server MATCH_START   →  onMatchStart({ config, seat, seats, snapshot })
                     →  bootState(hydrate(config, snapshot), { intro: true, seat })
```

`hydrate` is cheap because the save format already does it: `engine/persist.js:496 serPlanet`
persists only `(seed, planetId, sizeMult, resourceMult, swapAsym)` plus dynamic entities, and
`rehydratePlanet` regenerates the whole map deterministically. **The client can regenerate
terrain and node geometry itself from the config**; only `node.amount` and the entity tables
need to arrive (`engine/persist.js:549-551` already ships exactly `{id, amount}` per node).

**`bootState` keeps its body almost exactly.** Changes:
- `:485` `createLoop` keeps `render` and *drops* the sim from `update`. The `update` callback
  becomes `applySnapshot`/`interpolate`. `snapshotPositions(game.state)` at `:501` must still run
  immediately **before** each applied snapshot (it is the interpolation baseline,
  `renderShared.js:45`); this is the one ordering constraint that must not be lost.
- `:471` `state.map.bases.player` → `state.map.bases[seat]`.
- `:466` `attachInput(canvas, state, onChange)` gains a `seat` and a `submit` collaborator.
- `:551` the over-poll is replaced by an explicit `MATCH_END` message from the server carrying
  `winner`, `winReason`, and per-seat scores (§4 explains why scores must be server-computed).
  Keep the poll as the loopback path's implementation of the same callback (§8).

**`restartToMapSelect` (`boot.js:400`) becomes `leaveMatch`.** Its existing teardown is exactly
right and should be preserved verbatim (it is the file's most carefully-reasoned function). It
gains: close/park the transport, clear `seat`/`seats`, and — the new hazard — handle *the server
ending the match while the client is mid-teardown*.

**New states with no analogue today:** `LOBBY` (roster, ready-up, seat/faction/colour pick),
`CONNECTING`, `RECONNECTING`, `DESYNCED`, and `OPPONENT_DROPPED`. `pauseReasons`
(`boot.js:94-106`) is a refcounted set and is the right primitive for "the server paused us" —
but note that **`pauseLoop` currently gates only the local `update`** (`boot.js:500`). In MP,
pause must come *from* the server; a client-side pause becomes a render-freeze only, and
`togglePause` (`boot.js:103`) must be disabled or converted to a vote. `landingPicker`,
`starmap`, and `techchart` all currently call `pauseLoop` to freeze the world behind a modal
(`boot.js:332`, `starmap.js` tail, `techChart.js` tail) — **all three must stop pausing in MP**;
they become non-blocking overlays.

---

## 3. Hardcoded "you are the player" assumptions

~110 literal `"player"`/`"ai"` occurrences outside `engine/`. They fall into five classes.

### 3.1 "Is this entity mine?" — the largest class, and the easiest

Every one of these is `owner === "player"` / `owner !== "player"` and becomes
`owner === session.seat`.

| File | Lines |
|---|---|
| `input.js` | `317` (click-select own), `383` (select-all-army), `391` (idle worker), `407` (idle producer), `423` (CC cycle) |
| `inputCommands.js` | `58`, `62` (fog gate on hit-test), `99` (`alivePlayerUnitIds`), `131`, `136`, `170`, `178`, `197`, `210`, `223`, `232`, `242`, `247`, `257`, `264`, `271` — the entire right-click router |
| `hud.js` | `47` (gate chip), `137`, `194`, `336` (idle workers), `352` (idle production), `429` (freighter count) |
| `hudPanelSignature.js` | `149`, `234`, `290`, `312` |
| `renderBuildings.js` | `84` (enemy pip), `120`, `147`, `165`, `181`, `233` |
| `renderEffects.js` | `413`, `563` (rally point), `600` (waypoints), `637` (escort links) |
| `renderUnits.js` | `91` (enemy pip) |
| `renderShared.js` | `254` — `hiddenByFog`, the one fog predicate; **fix here fixes four draw passes at once** |
| `minimap.js` | `94`, `99` |
| `boot.js` | `370` (`focusActivePlanet` finds own CC), `675` (event fog gate), `684`, `704`, `712` (under-attack trigger), `737` (own supply block) |
| `starmap.js` | `56`, `58` |
| `landingPicker.js` | `60`, `61`, `151`, `160` |
| `techChart.js` | `36` — `const OWNER = "player"`, then used at `138`, `153`, `196` |
| `overlays.js` | `68-81` (the eight opening-objective predicates, each `countUnits(state,"player",…)` / `hasCompletedBuilding(state,"player",…)`) |

**Recommendation:** introduce `isMine(e)` in `session.js` and a `SEAT` accessor, then sweep.
This is ~70 one-line edits with excellent test coverage already in place
(`test/input.test.js` 57 tests, `test/renderShared.test.js` 34 tests, `test/hud.test.js` 33).

### 3.2 "The enemy is `"ai"`" — the class that genuinely breaks at N seats

These assume **exactly one opponent**, not merely that it is named `"ai"`:

| Site | Assumption |
|---|---|
| `boot.js:684, 704, 712` | `if (ev.owner === "ai") triggerUnderAttack(...)` — the comment at `boot.js:669-671` states it outright: *"an attackHit whose attacker is the AI necessarily means the target is the player's (only two sides exist)"*. At 5 seats this fires the under-attack alarm for every fight on the map. **Must become `ev.targetOwner === seat`, which means `engine/combat.js` must start emitting the target owner on `attackHit`.** This is the one place a *sim* change is forced by multiplayer. |
| `hud.js:314` | `playerScore(state, "ai")` — the topbar score bar shows "you vs them" |
| `overlays.js:407` | `playerScore(opts.state, "ai")` — the game-over breakdown |
| `overlays.js:34` | `FACTIONS[st.players.ai.faction]` — the faction chip is a two-sided "you vs them" |
| `overlays.js:376, 392` | `winner === "player" ? victory : defeat` |
| `overlays.js:393-394` | *"Victory — the enemy's last Command Center is destroyed"* / *"Defeat — your last Command Center was destroyed."* — singular "the enemy" |
| `observer.js:290, 291` | `supplyUsed(state,"ai")` / `supplyCap(state,"ai")` |
| `observerPanel.js:89` | `owner => (owner === "player" ? watch.aName : watch.bName)` — hard two-entrant |
| `observer.js:116` | `state.map.bases.player \|\| state.map.bases.ai` |
| `hudPanelSignature.js:225-228` | diplomacy signature reads `state.diplomacy` as a single relationship |

The score bar, the faction chip and the game-over copy are all **"two columns" UI**. At N seats
they need to become a small roster table. That is a real (if modest) UI design job, not a rename.

### 3.3 Colours

**Not a problem.** `#4fd1ff` / `#f87171` appear as *entity* colours only in
`engine/state.js:179-180`, as `ownerDefs[].color`. Every renderer reads
`state.players[owner].color` (`renderUnits.js:66`, `renderBuildings.js:75`, `minimap.js:95, 100`),
and `hudSelection.js:1941` / `techChart.js:196` / `landingPicker.js:149` do the same for icons.
The remaining literals in `renderEffects.js:111-113, 315, 326, 447, 511, 542, 584, 616, 680`,
`minimap.js:114`, `renderUnits.js:126`, `renderShared.js:195`, `renderBuildings.js:109, 154, 197`
are **semantic** colours (valid/invalid placement, health tiers, power tiers, tracer types) that
happen to reuse the same hexes. Leave them.

**Action:** extend `ownerDefs` to N entries with a colour ramp; add colours to `style.css`
(3 hits) for the HUD chrome. Nothing else.

### 3.4 `state.fog` vs `state.fogAI`

Already an alias pair over `state.fogs` (`engine/state.js:232-234`, pinned by
`test/ownerScaffold.test.js`). Client reads:

| Site | Read |
|---|---|
| `render.js:202` | `drawFogBase` — the charted-space wash |
| `minimap.js:36, 83` | minimap fog underlay + entity gate |
| `renderShared.js:254` | `hiddenByFog` |
| `renderNodes.js:26` | `isNodeDiscovered(state.fog, n)` |
| `renderEffects.js:466` | node picking overlay |
| `inputCommands.js:58, 62, 69` | hit-test + node-pick gating |
| `boot.js:675` | event audibility |

**All nine become `state.fogs[seat]`.** The remaining hazard is *inside the engine*:
`engine/sim.js:70-71` hardcodes `updateFog(state, state.fog, "player")` and
`updateFog(state, state.fogAI, "ai")` even though `state.fogs` exists. That must become
`for (const id of state.owners) updateFog(state, state.fogs[id], id)` — which is exactly what
`engine/state.js:270` already does at construction time.

### 3.5 `state.map.bases.player`

`boot.js:371`, `boot.js:471`, `input.js:430`, `observer.js:116`, and inside the engine
`engine/galaxy.js:421, 1365`, `engine/map.js:177, 179, 207`. `engine/aiMilitary.js:554, 574, 589,
694` already indexes generically (`state.map.bases[owner]`). Map generation must produce N start
positions — this is a **map-generation change** (`engine/map.js`) and is the single largest
*engine* task implied by N-seat multiplayer. It is out of the client's scope but gates it.

---

## 4. Rendering under authoritative fog

### 4.1 How hard is per-client filtering?

**Much easier than it looks, because the client already renders as if it were filtered.**

`engine/fog.js` is 144 LOC, pure, and already per-owner: `createFog(map)` (`:34`),
`isVisibleAt(fog,x,y)` (`:49`), `isExploredAt` (`:55`), `isNodeDiscovered` (`:66`),
`updateFog(state, fog, owner)` (`:124`). `state.fogs[owner]` exists. There is **no remembered
snapshot of enemy positions** (`engine/fog.js:14-15` says so explicitly) — an out-of-vision enemy
simply stops rendering. That is precisely the semantics a filtered projection provides.

So `projectFor(state, seat)` is a ~60-line pure function:

```
units      → own ∪ { u : isVisibleAt(fogs[seat], u.x, u.y) }, enemy entries stripped
             of order/orderQueue/homeCC/target internals (intel leak)
buildings  → same rule
nodes      → { id, amount } for every charted node; hidden nodes only where
             isNodeDiscovered(fogs[seat], n)          (engine/fog.js:66)
players    → { [seat]: full record } + public facts for the rest
             (id, name, colour, faction, score, supply, isAI)
fogs       → { [seat]: fogs[seat] }, with `fog` aliased for the legacy readers
owners     → unchanged (public)
selection  → this seat's own (once it moves off state)
events     → the rule already at boot.js:675: own events, plus any event
             at a currently-visible point
map        → NOT sent; client regenerates from (planetId, seed, sizeMult,
             resourceMult, swapAsym) — engine/map.js generateMap is deterministic
```

The renderer **needs no changes to consume this**, because every per-entity fog gate
(`renderShared.js:254`, `minimap.js:94, 99`, `renderNodes.js:26`, `inputCommands.js:58, 62`)
simply becomes tautologically true rather than wrong.

### 4.2 What filtering would strip that the client currently needs

Six real dependencies. Five are trivially fixable; one is a genuine visual regression.

1. **`playerScore(state, "ai")`** — `hud.js:314` (score bar), `overlays.js:407` (game-over
   breakdown). Reads *all* of the enemy's bank/army/structures. → Server computes per-seat scores
   and ships them as public facts. `engine/victory.js:158-165` already iterates `ownersOf(state)`.
2. **Enemy faction** — `overlays.js:34` reads `st.players.ai.faction` for the "you vs them" chip.
   → Public lobby fact; ship in the match descriptor.
3. **Enemy supply** — `observer.js:290-291`. Spectator-only; the spectator seat receives an
   unfiltered projection.
4. **Enemy CC existence for victory** — client never checks this; `engine/victory.js` does, on the
   server. No client change.
5. **Hidden-node discovery** — `isNodeDiscovered` gates *right-click targetability*
   (`inputCommands.js:69`), not just drawing. If the client recomputes fog locally (see below), a
   snapshot-rate mismatch could make client and server disagree about whether a cache is
   targetable. → Ship an authoritative `discoveredNodeIds` set per seat. It is tiny (caches are
   a handful per map, `engine/map.js:266-267`).
6. **Interpolation continuity — the real regression.** `renderShared.js:39 prevPos` keys
   interpolation baselines by unit id; `renderShared.js:69 pruneFacing` deletes the baseline the
   moment a unit is absent from `state.units`. Today an enemy unit that ducks behind fog stays in
   the Map (only its *draw* is gated), so it keeps a continuous baseline. Under filtering it
   *leaves the map*, loses its baseline and its `facing` entry, and on re-entry snaps rather than
   slides. → Give `pruneFacing` a grace window (drop after N frames absent, not immediately).
   ~5 lines in a file with 34 existing tests.

Everything else the renderer touches is either the client's own entities, immutable map data it
can regenerate, or already fog-gated.

### 4.3 Measured payload (this machine, `engine/persist.js` format)

Full `serializeGameString` snapshot, 15 sim-minutes, both seats AI-driven:

| Map | units / bldgs | full | fog (both) | units | buildings | nodes |
|---|---|---|---|---|---|---|
| Small (1600×1000) | 16 / 16 | 18.9 KB | 3.9 KB | 4.5 KB | 3.7 KB | 4.4 KB |
| Standard 2× (3200×2000) | 27 / 16 | 30.1 KB | 15.6 KB | 6.7 KB | 3.7 KB | 2.4 KB |
| Gigantic 4× (6400×4000) | — | 69.6 KB | **62.5 KB** | 3.5 KB | 1.1 KB | 1.3 KB |

**Fog dominates on large maps and entities are tiny.** That single fact drives the recommendation.

### 4.4 Recommendation

> **Ship fog-filtered-per-client, and ship *no fog grid at all*.**

Three parts:

1. **Filter entities server-side** with `projectFor(state, seat)`. This is the anti-cheat
   boundary and it must exist before any public or agent-played match. It is ~60 LOC of pure
   engine code, directly unit-testable against the existing `test/fog.test.js` fixtures.
2. **Do not transmit the fog grid.** The client already has everything needed to recompute it:
   its own units and buildings, and a deterministically regenerated map.
   `updateFog(state, myFog, seat)` (`engine/fog.js:124`) is pure, allocation-free, and is exactly
   what `engine/sim.js:70` already calls each tick. `explored` accumulates client-side across
   snapshots (it is monotonic). This deletes 3.9–62.5 KB from every snapshot and makes payload
   scale with *army size* rather than *map size*. The only thing that must remain
   server-authoritative is hidden-node discovery (see §4.2 item 5), which is a tiny id set.
3. **Keep full-state broadcast as a named, flagged mode** — `spectator` and `replay` — not as
   the default. `observer.js` (§7) is already exactly this client, and
   `saveShape.js:28 resumableMode` already encodes "a spectated match is not the player's game".

**Trade-off, stated plainly.** Full-state broadcast is ~2 days of work and lets every existing
client module run untouched; it is also trivially cheatable by anyone who opens devtools, and it
is *especially* wrong for this project because MCP agents receive state programmatically — an
agent handed the full state is not playing the same game as a human. Filtering costs perhaps a
week (the projection function, per-seat score/faction public facts, the `pruneFacing` grace
window, and the discovered-node channel) and is the only version that survives contact with
public play.

**Migration path.** These are additive and independently shippable:

- **M0** — `projectFor(state, seat)` written and tested, but the server still broadcasts full
  state. Test: `projectFor(s,"player")` renders pixel-identically to `s` under the existing
  render tests. This proves the renderer tolerates a filtered state before anything depends on it.
- **M1** — server switches to `projectFor`; fog grid still shipped. Add per-seat public scores
  (`hud.js:314`, `overlays.js:407`) and the faction roster (`overlays.js:34`).
- **M2** — stop shipping fog; client calls `updateFog` locally on each snapshot. Add the
  `discoveredNodeIds` channel. Add the `pruneFacing` grace window.
- **M3** — delta-encode entities against the previous acknowledged snapshot. At 16–27 entities,
  this is optional until army sizes grow.

---

## 5. What is reusable VERBATIM

The tree is 90,762 LOC total (`.js/.css/.html/.json/.md`); 81,257 LOC of `.js/.css/.html`, of
which **43,101 is tests**. Shipped application code is ~35,400 LOC (`engine` 15,659 + top-level
client 17,903 + css/html 1,815).

### 5.1 Zero change — pure, import-free or engine-data-only leaves

| Module | LOC | Why it is untouched |
|---|---|---|
| `sound.js` | 181 | **No imports at all.** Pure WebAudio. Nothing about it is single-player. |
| `effects.js` | 183 | **No imports at all.** Tracers, death flashes, pings, fireworks — pure render-side particle bookkeeping. |
| `camera.js` | 105 | **No imports at all.** `createCamera/zoomAt/panCamera/pinchZoomPan/screenToWorld/clampCamera`. |
| `data.js` | 242 | Static tables (planets, commodities, recipes). Pure data. |
| `dom.js` | 68 | Element handles + `MINIMAP_W/H` + `isTouchMode()`. Already Node-import-safe by design (`dom.js:11-18`). |
| `style.css` | 1,732 | 3 hits on the team hexes; add N-seat colour variables. Otherwise verbatim. |
| `saveShape.js` | 31 | Two pure predicates. Gains one term (§6). |
| `renderShared.js` | 255 | One line (`:254`). Geometry/colour helpers, interpolation, health bars — all generic. |
| `renderNodes.js` | 171 | One line (`:26`). |
| `renderUnits.js` | 699 | Two lines (`:91` enemy pip, `:126` a semantic red). Colour already comes from `players[owner].color` (`:66`). |
| `minimap.js` | 138 | Two lines (`:94, :99`). |
| `render.js` | 277 | `drawFrame` orchestration + `spriteIcon` cache + `drawFogBase`. Only `state.fog` → `state.fogs[seat]` at `:202`. |
| `renderBuildings.js` | 807 | Six `owner !== "player"` lines. Everything else — hull art, power tiers, storage bars, jump staging — is generic. |
| `renderEffects.js` | 683 | Five `owner !== "player"` lines. |
| `techChart.js` | 366 | One line: `const OWNER = "player"` (`:36`). Plus: stop calling `pauseLoop` in MP. |
| `landingPicker.js` | 211 | Four owner lines. Odyssey-only anyway (§7). |
| `elo.js` | 147 | Pure rating math, zero engine/DOM. **Lift to the server verbatim** when MP ranking lands. |
| `pairing.js` | 518 | Pure Swiss/round-robin scheduling; its own header (`pairing.js:15`) notes the single import is `hashStr`. **Lift to the server verbatim.** |
| `version.js` | 60 | Version/save-impact reporting. |
| **Subtotal** | **~6,874** | |

### 5.2 Near-zero change — a rename sweep, no restructuring

| Module | LOC | Change |
|---|---|---|
| `overlays.js` | 585 | Owner literals at `:34, :68-81, :376, :392-394, :406-407`; game-over copy becomes N-seat. Toasts/hints/help/objectives verbatim. |
| `hud.js` | 452 | 9 owner literals; score bar becomes a roster; two scenario buttons (`:37, :38`) become commands. |
| `hudPanelSignature.js` | 380 | 4 owner literals + the `players.player` reads. It is a pure signature/diff function — the mechanism is untouched. |
| `session.js` | 120 | Additive fields only. |
| `observer.js` + `observerPanel.js` | 550 | Repurposed as the spectator client (§7). `enterObserverMode` (`observer.js:128`) gains a third permitted condition. |
| `main.js` | 168 | `:145-151` (minimap right-click) becomes a command submit. Everything else is canvas/DPR/toggles. |
| `starmap.js` | 318 | Odyssey-only; unchanged on the offline path. |
| `update.js` | 108 | Version chip / auto-update. Verbatim. |
| **Subtotal** | **~2,681** | |

### 5.3 Real work

| Module | LOC | Nature |
|---|---|---|
| `boot.js` | 788 | Lifecycle inversion (§2). The single heaviest file. |
| `input.js` | 588 | 6 `state.selection` writes, 6 `issue*` calls, 5 owner literals; becomes command-emitting. Gesture/camera/touch code untouched. |
| `inputCommands.js` | 288 | 5 selection writes, 13 `issue*` calls, 16 owner literals. Its own header (`inputCommands.js:15-17`) notes `commandAt` is *already* the "what does this click mean" decision, callable directly — **this file is the natural home of client-side command construction.** |
| `hudSelection.js` | 1,998 | ~30 mutator calls + `players.player` reads. But ~900–1,000 LOC of it is Odyssey panels (`renderMarket:346`, `renderFreight:430`, `renderDiplomacy:612`, `renderLanes:717`, `renderColonyPolicy:809`, `renderCapital:890`, `renderSpaceport:1328`, `renderDatacenter:1156`) that are **out of v1 scope and need no change at all**. |
| `setup.js` | 462 | Splits into lobby form + option tables (§2.3). |
| `saveload.js` | 371 | §6. |
| **Subtotal** | **~4,495** | |

### 5.4 Quantified

Of the **~17,900 LOC of shipped client JS**:

- **~6,900 LOC (≈39 %) verbatim or one-line-per-file** (§5.1)
- **~2,700 LOC (≈15 %) a mechanical owner-literal sweep** (§5.2)
- **~4,500 LOC (≈25 %) genuine rework** (§5.3), of which roughly a fifth is Odyssey panels that
  are simply not touched in v1
- **~3,800 LOC (≈21 %) out of v1 scope entirely** — the competition cluster (§7)

Plus **1,732 LOC of CSS effectively verbatim** and **15,659 LOC of engine** that keeps running
unchanged — on the server instead of in the tab. The 5 renderer files alone
(`render` + `renderBuildings` + `renderEffects` + `renderNodes` + `renderUnits` +
`renderShared` = **2,892 LOC**) survive with **17 changed lines between them**. That is the
single strongest argument for server-authoritative-with-thin-client over any rewrite.

---

## 6. `saveload.js` / autosave / `localStorage` in multiplayer

### 6.1 What exists

- Two channels (`saveload.js:1-18`): **file** (topbar Save/Load, an explicit `.json`) and
  **localStorage autosave** every 12 s (`saveload.js:39`) plus on tab-hide/unload, feeding the
  map-select "Continue" buttons.
- Two generations per key (`saveload.js:33-38, 84-98`) so one corrupt write cannot lose a run.
- Keys: `stellarfrontier.save.v1` (`:31`), `stellarfrontier.odyssey.v1` (`:32`).
- The decision of *what is resumable* is a 3-line pure function,
  `saveShape.js:28 resumableMode({state, galaxy, spectateMatch})` — already unit-tested
  (`test/save-shape.test.js`) and already refuses to checkpoint a scenario, a finished match, or
  **a spectated match whose player seat isn't really the player's**.
- Other `localStorage` users: `overlays.js:104-108` (objectives-strip dismissed, per mode),
  `update.js:23-24` (version-banner dismissed), `competitionLedger.js:1238-1286` (the Elo ledger,
  two generations, sanitized on read).

### 6.2 Recommendation

> **Drop client saves for multiplayer entirely. Persist matches server-side using the existing
> format. Record replays as command logs, not snapshots.**

1. **Client autosave off in MP — a one-term change.** `saveShape.js:28` already reads
   `{ state, galaxy, spectateMatch }`. Add `netMatch`:
   `if (!state || state.over || state.scenario || spectateMatch || netMatch) return null;`
   That single edit disables autosave, "Save & Exit", and the "Continue" buttons for a networked
   match, in a pure function with existing tests. Resuming a *shared* match from one participant's
   private browser copy is incoherent, and the localStorage payload is attacker-editable — the
   file's own header (`competitionLedger.js:11`) already says so.
2. **Server-side match persistence reuses `engine/persist.js` unchanged.** `serializeGameString`
   (`:808`) / `deserializeGame` (`:811`) already produce and consume the exact snapshot the server
   needs, and `deserializeGame` already treats its input as hostile
   (`sanitizeSave`, `engine/persist.js:48-49`, plus `test/save-hardening.test.js` at 836 LOC).
   The server checkpoints on the same 12 s cadence; a crash resumes the match. **Zero new format.**
3. **Replays are command logs, not snapshot streams.** The sim is deterministic from
   `(config, seed)` and the loop is fixed-step (`engine/loop.js:18-26` explains why the timestep
   is the simulation and not a tuning knob). There is already determinism coverage
   (`test/determinism.test.js`, `test/determinism-roster.test.js`) and a replay concept
   (`boot.js:215-219`'s `recorded`, which lets the game-over screen state honestly whether the
   determinism claim held). A `(config, [{tick, seat, envelope}])` log is orders of magnitude
   smaller than snapshots, doubles as the anti-cheat audit trail, and is the natural artefact for
   an MCP agent to review its own play. **Recording the command log should be built in from day
   one** — it is nearly free once commands are envelopes, and retrofitting it is not.
4. **Keep client `localStorage` for per-viewer preferences only** — `overlays.js:104-108`,
   `update.js:23-24`, volume/mute. These are correct as-is.
5. **File Save/Load stays, single-player only.** Hide `saveBtn`/`loadBtn` (`dom.js:42-43`) in a
   networked match, exactly as `starmapBtn` is already conditionally hidden.
6. **`competitionLedger.js`'s localStorage Elo ledger is single-player only** and stays that way.
   Any MP ladder must be server-side or it is forged by editing a string.

---

## 7. Odyssey / galaxy / competition / observer — in or out for v1

| Subsystem | LOC (client + engine) | v1 verdict |
|---|---|---|
| **Skirmish** (the base game) | — | **IN** — this *is* v1 |
| **Odyssey / galaxy** | `engine/galaxy.js` 1,431 + `colony` 93 + `colonyPolicy` 160 + `diplomacy` 501 + `market` 309 + `wonder` 93 + `starmap.js` 318 + `landingPicker.js` 211 + ~950 of `hudSelection.js` = **≈4,066** | **OUT** |
| **Competition / Elo / ladder** | `competition.js` 3,773 + `competitionLedger.js` 1,290 + `competitionWorker.js` 355 + `pairing.js` 518 + `elo.js` 147 + `playerFingerprint.js` 167 + `tools/duelCore.js` 119 + `tools/genome.js` 680 = **7,049** | **OUT as shipped; mine it** |
| **Observer / spectator** | `observer.js` 304 + `observerPanel.js` 246 = **550** | **IN — repurposed** |
| **Scenarios** (Escort / Raider / Bounty) | `engine/scenarios.js` 720 | **OUT** (offline path only) |

### Odyssey — OUT

Three independent reasons, any one sufficient:

- **It is not a match; it is a save file.** The Odyssey is an open-world sandbox that ticks
  *every world in the galaxy each tick* (`boot.js:503 stepGalaxy`), with a single per-player
  credit pool, background colonies raising notifications (`boot.js:504 sweepColonies` →
  `boot.js:605 notifyColony`), and interplanetary relocation that swaps which state is rendered
  (`boot.js:365 focusActivePlanet`). "Two players share a galaxy" is an unanswered **game-design**
  question, not a porting question.
- **It pauses the world for modals.** `boot.js:332` (landing picker), `starmap.js` (M key), and
  `techChart.js` (T key) all call `pauseLoop`. In MP nothing may pause the shared world for one
  participant. Every Odyssey overlay would need reworking.
- **It carries most of the client's remaining complexity.** Roughly half of `hudSelection.js`
  (the 1,998-LOC file) is Odyssey panels. Excluding Odyssey removes ~950 LOC of panel work from
  v1 at zero cost, because those panels never render when `game.galaxy` is null.

**Keep the code in-tree and reachable on the offline path (§8). Do not delete it.** Its tests
(`test/odyssey.test.js` 809 LOC, `test/starmap.test.js` 482, `test/landing.test.js` 439,
`test/lanes.test.js`, `test/colonyPolicy.test.js`, `test/livingGalaxy.test.js`,
`test/domination.test.js`, `test/rivalgate.test.js`) keep passing and keep protecting the shared
engine code that skirmish also uses.

### Competition / Elo — OUT as shipped, but read it first

`competition.js` (3,773 LOC) is a single-player *ladder screen*: it schedules AI-vs-AI duels,
runs them in a Web Worker (`competitionWorker.js`), and writes ratings into a localStorage ledger.
None of that is multiplayer. But three things in this cluster are the prior art for the port and
should be **read before writing the server**:

- `competitionWorker.js` (355) + `tools/duelCore.js` (119) + `tools/selfplay.js` (169) —
  **this is already a headless, off-main-thread, deterministic match runner.** It is the server
  sim in miniature. `engine/state.js:250-254` documents `state.playerAi`, the second controller
  slot that makes owner `"player"` AI-driven — the exact hook an MCP agent occupies.
- `pairing.js` (518) and `elo.js` (147) are **pure, engine-free, and directly liftable** to the
  server when MP ranking lands. `pairing.js:15` states it holds no engine state at all.
- `playerFingerprint.js` (167) — `fingerprintPlayer(state, owner = "player")` (`:53`) and
  `mirrorOfPlayer(state, {owner})` (`:162`) are already owner-parameterised. Useful for
  agent-vs-human matchmaking later.

Also note the guard at `test/engine-purity.test.js:20-41`: it already extends the determinism scan
to *browser-reachable* `tools/` files precisely because "bench" code started deciding persisted
ratings. **The same guard should be extended to the server's sim entry point on day one.**

### Observer — IN, repurposed as the spectator client

This is the highest-leverage "already written" asset in the tree. `observer.js`'s header states
its contract exactly: it *"reveals fog on whichever world you're looking at"*, gives a free camera,
*"deliberately does not touch `game.state`, `game.galaxy.activeId`, or the real input camera"*,
and makes `input.js` refuse to issue a single order — every mouse/wheel/key path already
early-returns into `observer.js` while `game.observerMode` is on. **That is a spectator client,
already built and already tested** (`test/observer.test.js`, 23 tests).

The change is one condition. `observer.js:128 enterObserverMode()` currently permits exactly two
cases (an Odyssey, or a watched AI-vs-AI match) and refuses an ordinary skirmish because that
would be a fog cheat. Add a third: *the server assigned this connection the spectator role*. The
server then hands that connection an unfiltered projection, which is legitimate precisely because
a spectator has no seat to cheat with.

Justification for including it in v1: multiplayer needs spectating on day one, and **AI-agent
matches make it a requirement, not a nicety** — an MCP agent playing a match is only interesting
if a human can watch it. `observerPanel.js:89`'s two-entrant naming
(`owner === "player" ? watch.aName : watch.bName`) is the only piece needing real work.

---

## 8. Offline / single-player preservation

> **Yes — and it should be the primary design constraint, not an afterthought.**

Two reasons. First, the game *is* the single-player game; shipping a port that can only run
against a server throws away a working product. Second and more practically: of ~2,466 tests,
roughly **1,735 are engine/tools tests** that drive `tick()` and `createGameState` directly, and
roughly **731 are client tests** that drive the current client against a locally-constructed
state (`test/input.test.js` 57, `test/hudSelection.test.js` 50, `test/boot.test.js` 29,
`test/hud.test.js` 33, `test/renderShared.test.js` 34, `test/overlays.test.js` 26,
`test/saveload.test.js` 24, `test/observer.test.js` 23 …). **If the client can no longer run its
own sim, every one of those 731 tests needs a mock.** That is the single biggest risk in the port.

### 8.1 Recommendation — a loopback transport

Define one interface and give it two implementations:

```
Transport {
  submit(envelope)            // a command from this client's seat
  onSnapshot(fn)              // state deliveries
  onMatchStart(fn) / onMatchEnd(fn)
  seat, seats, role
}
```

- **`LoopbackTransport`** — constructs the state in-process with `createGameState`, runs
  `createLoop`/`tick` exactly as `boot.js:485-531` does today, and `submit` **applies the command
  synchronously, in the caller's stack frame**, by calling the same `issue*` the client calls
  today. Behaviourally byte-identical to the current game.
- **`SocketTransport`** — serializes envelopes, applies snapshots.

### 8.2 Why this keeps the tests meaningful

The seam is placed at exactly two points, and both preserve today's *observable* semantics:

1. **Command submission.** Because `LoopbackTransport.submit` mutates before returning, every
   existing client test that asserts "after this click, the unit has this order" **still passes
   unchanged**. This is the whole trick: keep the loopback synchronous.
2. **State delivery.** `boot.js`'s `update` callback (`:499-532`) becomes transport-driven.
   `snapshotPositions(game.state)` (`:501`) must run before either a local tick or an applied
   snapshot — one ordering rule, easy to pin with a test.

Add one new engine function, `applyCommand(state, seat, envelope)`, that resolves ids → entities,
**filters to `seat`-owned entities**, and calls the unchanged `issue*`. Then:

- `test/commands.test.js` (503 LOC) keeps testing `issue*` directly — untouched.
- One new test file pins envelope → `issue*` and the ownership filter (which is *new* safety
  the game has never had: today nothing stops a client from ordering enemy units, because there
  is no adversary).
- `test/input.test.js`, `test/hudSelection.test.js`, `test/boot.test.js` keep working against the
  loopback.

**The one unavoidable test churn is `state.selection`** (§1.3): 124 test references. Moving it to
the client session is mechanical but wide. Budget for it explicitly; do it as its own change,
before the transport work, so the diff is reviewable.

### 8.3 What single-player retains

With a loopback transport, **the full offline game keeps working**: skirmish, all three scenarios
(`boot.js:234, 242, 250`), the whole Odyssey (`boot.js:259`), the competition ladder and its Web
Worker duels, file save/load, and localStorage Continue. `saveShape.js:28`'s `netMatch` term
(§6.2) is exactly what keeps the two worlds from contaminating each other. The Hugging Face Space
can therefore serve one bundle that plays offline *and* connects — and the offline path is also
the fastest development loop for anyone working on the renderers or the HUD.

---

## 9. Summary table

Verdicts: **verbatim** (0–2 changed lines) · **light** (a rename sweep, no restructuring) ·
**heavy** (real rework) · **server-side** (moves out of the browser) ·
**out-v1** (untouched, offline-only)

| Module | LOC | Verdict | Why |
|---|---|---|---|
| `engine/` (all 49 files) | 15,659 | **server-side** | Runs headless. Needs: `applyCommand` dispatcher, `projectFor(state, seat)`, N-entry `ownerDefs` (`state.js:174`), owner-generic `updateFog` loop (`sim.js:70`), N start bases (`map.js`), `attackHit` target owner (`combat.js`) |
| `style.css` | 1,732 | **verbatim** | 3 team-colour hits; add N-seat variables |
| `index.html` | 83 | **light** | Add a lobby container; hide save/load in MP |
| `sound.js` | 181 | **verbatim** | Zero imports |
| `effects.js` | 183 | **verbatim** | Zero imports |
| `camera.js` | 105 | **verbatim** | Zero imports |
| `data.js` | 242 | **verbatim** | Static tables |
| `dom.js` | 68 | **verbatim** | Already Node-safe (`dom.js:11-18`) |
| `version.js` | 60 | **verbatim** | |
| `update.js` | 108 | **verbatim** | Self-wired version chip |
| `saveShape.js` | 31 | **verbatim** | +1 term: `netMatch` (`:28`) |
| `renderShared.js` | 255 | **verbatim** | `:254` only; + `pruneFacing` grace window (§4.2) |
| `renderNodes.js` | 171 | **verbatim** | `:26` only |
| `minimap.js` | 138 | **verbatim** | `:94, :99` |
| `render.js` | 277 | **verbatim** | `:202` (`state.fog` → `fogs[seat]`) |
| `renderUnits.js` | 699 | **verbatim** | `:91`; colour already generic at `:66` |
| `renderBuildings.js` | 807 | **verbatim** | 6 owner lines; colour generic at `:75` |
| `renderEffects.js` | 683 | **verbatim** | 5 owner lines |
| `techChart.js` | 366 | **verbatim** | `:36` `OWNER`; stop pausing in MP |
| `elo.js` | 147 | **server-side** | Pure; lift verbatim when ranking lands |
| `pairing.js` | 518 | **server-side** | Pure; lift verbatim when ranking lands |
| `playerFingerprint.js` | 167 | **out-v1** | Already owner-parameterised (`:53, :162`); useful later |
| `session.js` | 120 | **light** | Additive: `seat`, `seats`, `role`, `transport`, `selection` |
| `main.js` | 168 | **light** | `:145-151` minimap command → submit |
| `hud.js` | 452 | **light** | 9 owner literals; score bar → roster; `:37, :38` → commands |
| `hudPanelSignature.js` | 380 | **light** | 4 owner literals + `players.player` reads |
| `overlays.js` | 585 | **light** | `:34, :68-81, :376, :392-394, :406-407`; N-seat game-over copy |
| `observer.js` | 304 | **light** | `:128` gains a third permitted case → the spectator client |
| `observerPanel.js` | 246 | **light** | `:89` two-entrant naming → N-seat |
| `inputCommands.js` | 288 | **heavy** | 13 `issue*` + 5 selection writes + 16 owner literals; becomes the command constructor |
| `input.js` | 588 | **heavy** | 6 `issue*` + 6 selection writes + 5 owner literals; gesture/camera/touch untouched |
| `setup.js` | 462 | **heavy** | Splits: lobby form + (verbatim) option tables |
| `saveload.js` | 371 | **heavy** | MP: off. SP: unchanged. Server reuses `engine/persist.js` |
| `boot.js` | 788 | **heavy** | Lifecycle inversion; the single biggest file of real work |
| `hudSelection.js` | 1,998 | **heavy** (~1,050) / **out-v1** (~950) | ~30 mutator calls in the skirmish half; the Odyssey panels are untouched |
| `starmap.js` | 318 | **out-v1** | Odyssey |
| `landingPicker.js` | 211 | **out-v1** | Odyssey |
| `competition.js` | 3,773 | **out-v1** | Single-player ladder screen |
| `competitionLedger.js` | 1,290 | **out-v1** | localStorage Elo ledger — forgeable, SP-only |
| `competitionWorker.js` | 355 | **out-v1** | Read as prior art for the headless server sim |
| `tools/` (`selfplay`, `duelCore`, `genome`, `ailab`, `serve`, `smoke`) | 3,593 | **out-v1** | `selfplay.js`/`duelCore.js` are the closest existing thing to the server runner |
| `test/` | 43,101 | **preserve** | ~1,735 engine tests unaffected; ~731 client tests preserved by the synchronous loopback (§8) |

**Totals:** verbatim/near-verbatim ≈ **6,900 LOC (39 % of shipped client JS)** ·
light sweep ≈ **2,700 (15 %)** · heavy ≈ **4,500 (25 %)** · out-v1 ≈ **3,800 (21 %)** ·
plus 15,659 LOC of engine relocated intact and 1,732 LOC of CSS untouched.

---

## 10. Ordered recommendations

1. **Move `state.selection` off the sim state first.** 10 write sites, 32 client reads, 2 engine
   reads, 124 test references. It is the widest mechanical change and it is independent of
   everything else — do it as its own reviewable diff, before the transport.
2. **Add `applyCommand(state, seat, envelope)` to `engine/commands.js`**, with the
   **seat-ownership filter** that does not exist today. Keep every `issue*` unchanged so
   `test/commands.test.js` is untouched.
3. **Introduce `Transport` with `LoopbackTransport` first.** Land the whole port against
   loopback before a socket exists. The client tests are the regression suite.
4. **Sweep the owner literals** behind `session.seat` / `isMine(e)` (§3.1). ~70 one-liners with
   heavy existing coverage.
5. **Make the engine N-seat**: `ownerDefs` (`engine/state.js:174`), the `updateFog` loop
   (`engine/sim.js:70`), N start bases (`engine/map.js`), and `attackHit`'s target owner
   (`engine/combat.js`). `test/ownerScaffold.test.js` is the spec that already exists.
6. **Write `projectFor(state, seat)` and prove it renders identically to the full state**
   before anything depends on it (M0 in §4.4).
7. **Record the command log from day one.** It is nearly free once commands are envelopes, it
   is the replay format, the anti-cheat audit trail, and the MCP agent's trace.
8. **Extend `test/engine-purity.test.js`'s reachability walk to the server entry point** the
   moment it exists. The guard's own comment (`:20-41`) explains what happened last time a
   "bench" file started deciding real outcomes.
9. **Defer Odyssey and the competition ladder; keep both alive on the loopback path.** They cost
   nothing to keep and protect ~1,000 tests over shared engine code.
10. **Ship the spectator seat in v1** by widening `observer.js:128`. It is already written,
    already tested, and AI-agent matches make it a requirement rather than a nicety.
