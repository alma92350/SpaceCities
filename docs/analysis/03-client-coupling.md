# 03 — Client coupling: what must change to become a networked client

**Status:** analysis, decisive. Input to `docs/adr/` and `TASKS.md`; not a specification.
**Tree audited:** `/home/user/SpaceCities` @ working tree (the imported-verbatim upstream, ADR-0002).
All `file.js:line` citations are against that tree and are exact at time of writing — cited so a
reader can confirm a claim, not as a patch plan.
**Peers:** [`01-engine-nplayer-seams.md`](01-engine-nplayer-seams.md) owns everything inside
`engine/`; [`02-command-wire-protocol.md`](02-command-wire-protocol.md) owns the envelope, codec and
anti-cheat. This dossier stays on the **client** side of that line: the ~17.9k JS + 1.7k CSS lines
outside `engine/`.
**Architecture assumed (decided):** server-authoritative headless Node sim (ADR-0003); single-player
runs the same path through an in-process loopback transport (ADR-0004).

---

## 0. Headline findings

1. **The client mutates the simulation in exactly 64 places, in 6 files.** 26 `issue*` calls,
   38 non-`issue*` engine mutators. Every one already takes an explicit `(state, id, args)`-ish
   shape — they are command envelopes that were never serialized. Dossier 02's D1 ("wrap, do not
   rewrite") is what makes this a re-seaming job.
2. **Only two client lines write a simulation field directly, bypassing `engine/` entirely** —
   `hudSelection.js:1045` (`e.homeCC = null`) and `hudSelection.js:1722` (`e.electrified = v`).
   Neither goes through `engine/commands.js` today. The first is nonetheless free to fix:
   `issueSetHomeBase(units, ccId)` already exists (`engine/commands.js:281`) and accepts `null`, so
   the HUD is bypassing a command that would have done the job. The second is a genuine gap —
   **`electrified` has two direct writers and zero commands**, the HUD and `engine/aiIndustry.js:172`
   (`engine/industry.js:38` documents the duplication outright). These are the only two holes in an
   otherwise correctly-placed trust boundary, and closing them is the single most actionable item
   in this document.
3. **No client file writes `resources` or `credits`.** Verified by grep: every economic mutation
   goes through an engine function. The trust boundary is already drawn in the right place; it is
   simply not enforced. What the client *does* do is **read** the local seat's economy —
   `state.players.player.resources` at 7 sites in `hudSelection.js` alone, 15 across the client —
   a read that per-seat filtering must keep serving (it always can: your own economy is never fogged).
4. **The renderers are already owner-generic where it counts.** Team colour is read as
   `state.players[owner].color` at all four draw sites (`renderUnits.js:66`, `renderBuildings.js:75`,
   `minimap.js:95`, `minimap.js:100`); `#4fd1ff`/`#f87171` live in `engine/state.js:179-180` as
   *data*, and every client occurrence of those literals is unrelated UI chrome. The fog rule is
   factored into one named predicate, `renderShared.js:253 hiddenByFog`. "Seat 3 of 5" does not
   break rendering — and neither does fog filtering: the frame interpolator is **already** safe
   against entities appearing and vanishing between snapshots (§4.2 item 6), which is normally the
   first thing that breaks when a client stops holding the whole world.
5. **What "seat 3 of 5" actually breaks is 119 owner-literal sites outside `engine/`** — 68
   comparisons, 29 owner arguments passed to already-parameterized engine functions, and 22
   hardcoded `state.players.player`/`.ai` property paths. (Counting `tools/` and `competition.js`
   too, the comparison total is 80, matching dossier 01's finding #5.) **110 of the 119 are the same
   assertion — "`player` means me" — and collapse to one `state.localOwner` seam.** The remaining
   **9** are the harder assertion, "the enemy is `ai`": genuine 1v1 semantics that must be
   redesigned or scoped out. §3.2 lists all nine.
6. **Broadcasting full state is not affordable, and the numbers are not close.** Measured on this
   machine with `engine/persist.js`: a 4× map with 800-vs-800 units serializes to **404 KB in
   4.45 ms**; at 20 Hz × 4 seats that is 32 MB/s and 18 ms of a 50 ms tick budget spent on
   `JSON.stringify` alone. A per-seat fog-filtered delta of the same state is **55 KB in 0.69 ms**.
   Dossier 00's "the sim runs ~500× faster than real time" is confirmed from the other side:
   **serialization is the server cost, and filtering is what makes it affordable, not what makes it
   expensive.** Recommendation: **fog-filtered per client, from day one.** §4.
7. **The map never has to cross the wire.** `serializeGame` does not include `state.map` at all
   (measured: `map` is absent from the payload's top-level keys) — terrain, node positions and base
   positions are regenerated from `seed` + `planetId` on load (`engine/persist.js` `rehydratePlanet`).
   A client that is told `{planetId, seed, sizeMult, resourceMult}` at join reconstructs the entire
   static world locally. That is the largest single replication saving available and it is already
   built.
8. **~45% of the client is verbatim or a one-line-per-site substitution.** Counting the modules that
   ship in multiplayer v1, **68% of the in-scope 12,856 LOC needs zero or near-zero change**. The
   real work is concentrated in four files totalling 3,662 LOC — `boot.js`, `hudSelection.js`,
   `input.js`, `inputCommands.js` — and inside three of those four the touched lines are under 15%
   of the file. §5.

---

## 1. The local-authority inventory

Every place outside `engine/` that mutates simulation state, or assumes it owns the simulation.

### 1.1 `engine/commands.js` `issue*` — direct order issuance (26 sites, 4 files)

Imports: `inputCommands.js:27`, `hudSelection.js:21`, `main.js:21`, `input.js:12`.

| # | Site | Call | Notes for the codec |
|---|---|---|---|
| 1 | `inputCommands.js:94` | `issueAttackMove(combatants, x, y, queue, formation)` | right-click; split from :95 by role |
| 2 | `inputCommands.js:95` | `issueMove(others, x, y, queue, formation)` | same click, second envelope — see §1.6 |
| 3 | `inputCommands.js:199` | `issueSetRally(building, p.x, p.y, node?.id)` | **the one engine signature change** (02 D2): bare `Building` ref, no `state` |
| 4 | `inputCommands.js:212` | `issueAssistBuild(workers, target.id, target.type, queue)` | `target.type` is client-supplied — 02 flags it |
| 5 | `inputCommands.js:226` | `issueServiceBuilding(workers, target.id, queue)` | |
| 6 | `inputCommands.js:235` | `issueRepair(workers, target.id, queue)` | building target |
| 7 | `inputCommands.js:245` | `issueSetHomeBase(eligible, target.id)` | |
| 8 | `inputCommands.js:249` | `issueAttack(attackers, target.id, queue)` | |
| 9 | `inputCommands.js:259` | `issueFerryFreighter(workers, target.id, queue)` | |
| 10 | `inputCommands.js:266` | `issueRepair(workers, target.id, queue)` | unit target |
| 11 | `inputCommands.js:273` | `issueEscort(escorts, target.id, queue)` | **array order is the ring slot** (02 D4) |
| 12 | `inputCommands.js:278` | `issueGather(workers, node.id, queue)` | |
| 13 | `inputCommands.js:282` | `issueMove(selected, p.x, p.y, false, formation)` | |
| 14 | `hudSelection.js:518` | `issueSetAILogistics([f], !on, state)` | reads `state` for the tech gate |
| 15 | `hudSelection.js:542` | `issueSetCollectPoint([f], !on)` | |
| 16 | `hudSelection.js:600` | `issueSetLogiPriority(state, b.id, …)` | already id-based |
| 17 | `hudSelection.js:1821` | `issueCancelRecycle(recyclingNow)` | |
| 18 | `hudSelection.js:1835` | `issueRecycle(recyclable)` | banks resources later (02 #17) |
| 19 | `main.js:149` | `issueAttackMove(combatants, world.x, world.y)` | minimap right-click |
| 20 | `main.js:150` | `issueMove(others, world.x, world.y)` | same click |
| 21 | `input.js:346` | `issueStop(selectedUnits())` | |
| 22 | `input.js:351` | `issueScout(selectedUnits())` | |
| 23 | `input.js:355` | `issueHold(selectedUnits())` | |
| 24 | `input.js:372` | `issuePatrol([u], points)` | **unbounded `points`** (02 #20) |
| 25 | `input.js:379` | `issueHoldFormation(selectedUnits(), shape, leaderPos)` | anchor is the live centroid |
| 26 | `input.js:521` | `issueBuild(state, worker.id, type, p.x, p.y)` | **return value consumed** — §1.6 |

### 1.2 Non-`issue*` engine mutators called from the client (38 sites, 3 files)

Dossier 02's scope correction is confirmed and this is where the money is: **every cost-bearing
action** (production, research, market, diplomacy, colony, galaxy) goes through this group, not
through `commands.js`.

| Family | Sites | Engine module |
|---|---|---|
| Production / research | `hudSelection.js:197` `cancelProduction`, `:235` `cancelResearch`, `:1098`, `:1104`, `:1198`, `:1629` `queueProduction`, `:1149` `researchUpgrade`, `:1179` `researchTech` | `production.js`, `techtree.js` |
| Market (spends credits) | `hudSelection.js:381`, `:395`, `:405` `sell`, `:414` `buy` | `market.js` |
| Freight | `hudSelection.js:449`, `:485` `loadFreighter`; `:459`, `:494` `unloadFreighter` | `galaxy.js` |
| Diplomacy | `hudSelection.js:630` `offerTribute`, `:661` `fulfillRequest`, `:705` `offerGift` | `diplomacy.js` |
| Lanes | `hudSelection.js:766` `unassignShipFromLane`, `:777` `assignShipToLane`, `:781` `deleteLane`, `:793` `createLane` | `galaxy.js` |
| Colony policy | `hudSelection.js:831`, `:837`, `:850`, `:870`, `:876`; `starmap.js:229`, `:239`, `:244` `setColonyPolicy` | `colonyPolicy.js` |
| Colony / capital | `hudSelection.js:900` `upgradeToCapital`, `:905` `packCommandCenter`, `:1750` `deployColonyShip` | `galaxy.js`, `colony.js` |
| Spaceport | `hudSelection.js:1386` `upgradeSpaceport` | `galaxy.js` |
| Bomb | `hudSelection.js:1455` `lightFuse(state, bomb)` | `bomb.js` — takes a live object |
| Scenario | `hud.js:37` `repairConvoy(game.state)`, `hud.js:38` `departNow(game.state)` | `scenarios.js` |

**Two of these are Odyssey/galaxy-only** (lanes, colony policy, freight, spaceport, capital) and
therefore out of multiplayer v1 by §7 — which removes 22 of the 38 from the v1 codec surface.

### 1.3 Direct `state.*` writes from the client

There are exactly four kinds, and they are not all the same severity.

| Kind | Sites | Verdict |
|---|---|---|
| `state.selection = …` | `inputCommands.js:147`, `:152`, `:154`, `:157`, `:177`; `input.js:318`, `:337`, `:382`, `:395`, `:411`, `:543` (**11**) | **Not sim state.** `engine/persist.js` resets it to `[]` on load and dossier 02 D6 moves it to the client session. Zero wire cost. |
| `state.events.length = 0` | `boot.js:766` | **The client drains the sim's event queue.** In multiplayer, events must be produced server-side, fog-filtered per seat (`boot.js:675` already applies the fog rule), replicated, and drained *client-locally*. See §4.2. |
| Galaxy notification drains | `boot.js:511` `pacifyNotes.length = 0`, `:517` `milestones.length = 0`, `:522` `reliefNote = false` | Odyssey-only ⇒ out of v1 (§7). Same pattern as the event drain. |
| **Raw entity-field writes** | `hudSelection.js:1045` `e.homeCC = null`; `hudSelection.js:1722` `e.electrified = v` | **The only true trust-boundary holes.** Neither goes through `engine/commands.js`. `:1045` is free to fix — `issueSetHomeBase(units, ccId)` (`engine/commands.js:281`) already accepts `null`. `:1722` needs a new command. Fix both before the codec ships. |

`hudSelection.js:1722` is the worse of the two, for two reasons. It writes `electrified` on
**every** building in the current selection, with only a client-side `e.owner === "player"` filter
standing between it and electrifying an opponent's Habitat — and under server authority that filter
disappears along with the client that enforced it. And `electrified` has **no command anywhere**:
`engine/aiIndustry.js:172` sets it directly too, which `engine/industry.js:38` documents as
deliberate (*"engine/aiIndustry.js, which flips `electrified` on its buildings the same way the HUD
does"*). A new `issueSetElectrified(state, buildingIds, on)` should become the single writer, with
the AI routed through it as well.

### 1.4 `state.players.player.…` — direct owner-keyed reads (22 sites + 1 optional-chained)

No writes; all reads. They matter because each is a place that must be re-pointed at the local seat
*and* must survive fog filtering (the local seat's own economy is always fully visible, so filtering
never strips these — but they hard-code the key).

- **`state.players.player.resources`** — `hudSelection.js:272`, `:363`, `:432`, `:522`, `:651`,
  `:680`, `:1955`; `hudPanelSignature.js:146`, `:227`, `:228`, `:264`, `:272`, `:344`;
  `hud.js:99`, `:174`
- **`.upgrades`** — `hudSelection.js:508`, `:1122`, `:1157`; `hudPanelSignature.js:180`
- **`.color`** — `hudSelection.js:1941`; `landingPicker.js:149` (optional-chained:
  `dest.players?.player?.color || "#4fd1ff"` — the one place a hardcoded owner *and* a hardcoded
  colour appear on the same line; Odyssey-only, out of v1)
- **`.faction`** — `overlays.js:34` (`st.players.player.faction` **and** `st.players.ai.faction` in
  one line — a 1v1 assumption, not just a local-seat one)
- **Already owner-generic** — `techChart.js:138`, `:153`, `:196` via `const OWNER = "player"`
  (`techChart.js:36`); `hudPanelSignature.js:373` via `state.players[b.owner]`;
  `minimap.js:95`, `:100`, `renderUnits.js:66`, `renderBuildings.js:75` via `state.players[e.owner]`
- **Enemy-keyed** — `observer.js:276` `state.players.ai`

> **Trap.** `data.js:124` defines a commodity whose id is literally `"ai"`
> (`{ id: "aifab", out: "ai", … }` — AI cores). `hudPanelSignature.js:272` reads
> `state.players.player.resources.ai`. **A blind rename of the owner id `"ai"` will corrupt the
> economy.** Any owner-literal sweep must be site-by-site.

### 1.5 `createGameState` / `tick` / `createLoop` — the sim ownership itself

All in `boot.js`. This is the part that genuinely moves to the server.

| Site | Call | Moves to |
|---|---|---|
| `boot.js:119` | `createGameState({planetId, seed, rng, aiApm, …})` (skirmish) | server, from the lobby's agreed config |
| `boot.js:169` | `createGameState(…)` (competition fixture) | out of v1 (§7) |
| `boot.js:207` | `createSelfPlayState(…)` (watched duel) | out of v1 / server-side spectate |
| `boot.js:236`, `:244`, `:252` | `setupEscort` / `setupRaider` / `setupBounty` | server (single-player scenarios via loopback) |
| `boot.js:262` | `createGalaxy(…)` | out of v1 (§7) |
| `boot.js:287` | `jumpCapital(game.galaxy, destId, …)` | out of v1 |
| `boot.js:344` | `surrenderGalaxy(game.galaxy)` | out of v1 |
| `boot.js:485` | `createLoop({hz, speed, update, render})` | **splits.** The *sim* half (`update`) moves to the server; the *render* half (`render`) stays and becomes a plain `requestAnimationFrame` interpolator |
| `boot.js:503-504` | `stepGalaxy` / `sweepColonies` | out of v1 |
| `boot.js:530` | `tickSelfPlay(game.state, dt)` | out of v1 |
| `boot.js:531` | `tick(game.state, dt)` | **server** |

`engine/loop.js` is a fixed-timestep accumulator with a render callback and an `alpha` interpolation
fraction. Server-side it keeps the accumulator and drops the render callback; client-side the render
callback survives essentially unchanged because `render.js` already interpolates between two
positions per entity (`snapshotPositions`, `boot.js:501`) — the exact mechanism a networked client
needs for snapshot interpolation. **That is a significant unplanned gift.**

### 1.6 Return values the client consumes — the optimistic-update hazards

Server authority makes every mutation asynchronous. These sites read a synchronous answer *now*:

| Site | Pattern | Why it breaks |
|---|---|---|
| `input.js:521-523` | `const built = worker && issueBuild(...); if (built) buildMode = null; else sound.playProductionBlocked();` | Build mode exits (and the ghost clears) **only on a successful placement**. The client must either predict the placement locally and roll back on a server NACK, or keep the ghost up until an ack — a visible latency change either way. This is the highest-visibility UX consequence in the whole port. |
| `hudSelection.js:449`, `:459`, `:485`, `:494` | `if (loadFreighter(...) > 0) any = true` | Loop over commodities, branching on how much actually moved. Out of v1 with Odyssey, but the pattern recurs. |
| `hud.js:37` | `if (repairConvoy(game.state)) renderHUD()` | Repaints only if the repair took. |
| `boot.js:287-290` | `const result = jumpCapital(...); if (!result) return null; focusActivePlanet();` | Out of v1. |
| `inputCommands.js` (throughout) | each handler `return`s `true`/`false` to mean "this click was consumed" | **Benign.** The consumption decision is a *client-side hit test*, not a sim answer; it can stay synchronous. |

Everything else fires and forgets, followed by `renderHUD()` — which under authority just becomes
"repaint on the next snapshot", i.e. strictly simpler.

---

## 2. `session.js` / `boot.js` — the lifecycle, and how it re-shapes

### 2.1 `session.js` today (120 LOC, zero imports)

A single exported mutable object, `game`, holding 16 fields. It has **no imports at all** and
contains no logic — it exists so `hud`/`boot`/`save`/`input` all see the same current game across a
restart, and everything reads it *at call time* rather than destructuring at module scope
(`session.js:8-10`). That discipline is why a networked rewire is cheap: swapping what `game.state`
points at is already the supported operation.

Fields, grouped by what happens to them:

| Group | Fields | Fate |
|---|---|---|
| **The sim handles** | `state` (`:16`), `galaxy` (`:21`) | `state` becomes a **replicated view**, not the authority. `galaxy` out of v1. |
| **Local input/UI** | `input` (`:17`), `formation` (`:75`), `collapsedSections` (`:84`), `groups` (`:69`) | **Verbatim.** All already documented as "never part of the deterministic sim". |
| **Cross-module UI bookkeeping** | `supplyBlockedUntil` (`:34`), `lastAttackAt` (`:40`), `lastGateCharge` (`:52`), `colonyAlerts` (`:64`) | Verbatim; driven by replicated events instead of local ones. |
| **Mode flags** | `competition` (`:30`), `spectateMatch` (`:114`), `spectateSpeed` (`:119`) | Out of v1 (§7). |
| **Observer** | `observerMode` (`:89`), `spectateId` (`:92`), `spectatePreview` (`:99`), `observerCamera` (`:103`) | **Kept and repurposed** (§7). |

**The re-shape is additive.** `session.js` gains a small, well-defined set of new fields and loses
nothing that v1 ships:

```js
// new in session.js
transport: null,   // LoopbackTransport | WebSocketTransport (ADR-0004)
match:     null,   // { matchId, seats:[{owner,name,kind,color}], mapCfg, hostSeat }
localOwner: null,  // MY seat id — the single seam §3 collapses into
serverTick: 0,     // last applied authoritative tick
lobby:     null,   // pre-match lobby model (setup.js renders it)
netStatus: "offline",  // offline | connecting | live | lagging | resyncing | dropped
```

`localOwner` is the load-bearing one. `state.localOwner` (or `game.localOwner`) is what turns 110 of
the 119 owner-literal sites (§3) into one substitution.

### 2.2 `boot.js` today — the lifecycle, one line each

- **Splash → map select.** `main.js:165` calls `renderMapSelect()` at module-eval time. `setup.js`
  owns the screen; card click → `startGame(planetId)` (or a scenario / Odyssey / Continue variant).
- **`startGame(planetId)`** — `boot.js:109`. Draws a seed (`resolveSeed`, `:64`), resolves difficulty
  dials (`:54`), picks the AI's faction from the world archetype (`:118`), calls
  `createGameState` (`:119`), hands off to `bootState(fresh, {intro:true})` (`:124`).
- **`bootState(newState, {intro, selfPlay})`** — `boot.js:443`. **The single funnel every start path
  uses.** In order: stop the old loop (`:444`), destroy old input (`:445`), exit observer mode
  (`:446`), hide map-select / game-over / under-attack (`:447-450`), clear mode flags and per-game UI
  (`:453-457`), **assign `game.state`** (`:458`), toggle the scenario body class (`:462`), show
  seed + faction chips (`:463-464`), objectives strip (`:465`), `attachInput` (`:466`), park the
  camera on the player's base (`:471-475`), reset effects/facing/panel-signature/world bookkeeping
  (`:476-481`), clear pause (`:482`), **`createLoop`** (`:485`), `loop.start()` (`:581`),
  `renderHUD()` (`:582`).
- **The loop's `update`** — `boot.js:499-532`. Skip if paused (`:500`); `snapshotPositions` (`:501`);
  then one of three branches: galaxy (`:502-524`), spectated self-play (`:525-530`), or plain
  `tick(game.state, dt)` (`:531`).
- **The loop's `render`** — `boot.js:533-579`. `tickCamera`; pin `alpha` to 1 while paused (`:540`);
  choose `viewState`/`viewCamera` (observer or live, `:545-546`); `drawFrame` (`:547`);
  `drawMinimap` (`:548`); `processFrameEvents()` (`:549`); throttled `renderHUD` every 150 ms
  (`:550`); **then the over-poll** (`:551`).
- **Win / lose.** `boot.js:551`: `if (game.state.over && !announced)` → `announced = true`,
  `loop.stop()` (`:553`), then `showScenarioEnd` or `showGameOver(winner, seed, restartToMapSelect,
  {…})` (`:560-577`). The client **polls a boolean the sim set** — it does not decide.
- **Restart.** `restartToMapSelect()` — `boot.js:400`. Stop loop, destroy input, exit observer,
  null `state`/`galaxy`/`competition`/`spectateMatch`, repaint observer UI, clear pause, hide the
  pause button, `renderMapSelect()`, unhide map-select. Documented as idempotent (`:399`).
- **Pause.** Refcounted reasons (`boot.js:94-107`) — Help, the Home-confirm modal, the landing
  picker, and a manual `P`. **Gates `update()` only; render keeps drawing.**

### 2.3 The multiplayer re-shape, precisely

The shape of `bootState` is exactly right and should be preserved. What changes is **who calls it,
with what, and who decides it is over**.

| Today | Networked |
|---|---|
| `renderMapSelect()` at `main.js:165` | unchanged — the splash is still local |
| Card click → `startGame(planetId)` | Card click → `createMatch(cfg)` / `joinMatch(code)` → **lobby screen** |
| — | **`renderLobby()`** (new, in `setup.js`): seat list, per-seat ready flags, kind (human / AI / MCP agent), colour, faction, host-only map dials. Driven by a replicated `lobby` snapshot; the host's dial changes are commands like any other. |
| `resolveSeed(setup)` at `boot.js:114` — client draws the seed with `Math.random` | **server draws the seed** and announces it in the match-start message. The client's `resolveSeed` survives for single-player-over-loopback only. |
| `createGameState(…)` at `boot.js:119` | **server** constructs it from the lobby config; the client receives `{matchId, seats, planetId, seed, sizeMult, resourceMult, matchTimeLimit, popCap, swapAsym}` and rebuilds the *static* world locally (§0.7) |
| `bootState(fresh, {intro:true})` | `bootState(view, {intro, seats, localOwner})` — **same function**, called from the transport's `match-start` handler instead of from a click handler. Everything from `:444` to `:482` is unchanged. |
| `loop = createLoop({update: dt => tick(state,dt), render})` | `createLoop({update: **applyPendingSnapshot + advanceInterpolation**, render})`. The render half at `:533-579` is untouched. `hz` becomes the snapshot cadence, not the sim rate. |
| `snapshotPositions(game.state)` at `:501` | **unchanged and now load-bearing** — it is already the interpolation baseline; it becomes the previous *authoritative* snapshot. |
| `processFrameEvents()` at `:549`, draining `state.events` | drains the **replicated, per-seat-filtered** event list the snapshot carried |
| `if (game.state.over && !announced)` at `:551` | **replaced by a server `match-end` message.** Polling a local boolean is wrong under authority: a client whose connection dropped would poll a stale `over:false` forever, and a modified client could set `over` to skip the screen. The `showGameOver(...)` call at `:561` keeps its exact argument shape — `winner`, `seed`, `winReason`, `state` all arrive in the message. |
| `restartToMapSelect()` at `:400` | keeps its whole teardown, **plus** `transport.leave(matchId)` and `game.match = game.localOwner = null`. Its idempotence (`:399`) is exactly what a "server ended the match while you were in the Home dialog" race needs. |
| Refcounted pause (`:94-107`) | **local pause is gone in multiplayer** — one player cannot stop four others' clocks. `pauseLoop`/`resumeLoop` survive as *render-side* modal gating (Help, Home-confirm keep working), but must no longer gate `update`. Add a `pauseReasons` guard: in a networked match the sim never pauses; the overlay just goes up. Server-side pause (host-initiated, all-seat) is a v2 feature. |
| `game.spectateSpeed` / `speed:` at `:495` | ignored in multiplayer — the server owns the clock. |

**Four new lifecycle states** that do not exist today, each needing a screen or a banner:

1. **Lobby** — between map-select and `bootState`. New; ~150–250 LOC in `setup.js`.
2. **Waiting for seats / countdown** — trivial, lives in the lobby screen.
3. **Reconnect** — the transport drops; the client must show a banner and either resync from a full
   snapshot or fall out to map-select. `game.netStatus` drives a CSS class, exactly like
   `document.body.classList.toggle("paused", …)` at `boot.js:97`.
4. **Someone else left / was eliminated** — an in-match event with no analogue today (`state.over`
   is binary). Needs a toast (`showGalaxyToast` already exists, `overlays.js`) and a seat-list
   update.

### 2.4 What must not move

- **`main.js`'s side-effect imports** (`main.js:26-28`: `starmap.js`, `techChart.js`, `update.js`)
  self-wire buttons and hotkeys at module-load time. Dropping one silently disables a feature. If
  `starmap.js` is scoped out of v1 (§7), the *import must stay* with the module stubbed, or the
  `M` key handler and the galaxy button go missing without an error.
- **`session.js`'s read-at-call-time discipline** (`session.js:8-10`). Every networked rewire depends
  on being able to swap `game.state` under running consumers.
- **`bootState` as the single funnel.** Adding a second boot path for multiplayer is the exact
  mistake ADR-0004 rejects at the transport layer, one level up.

---

## 3. "You are the player" assumptions

Three counted forms, **119 sites** in the shipping client:

| Form | Count | Distribution |
|---|---|---|
| **Comparisons** — `owner === "player"`, `!== "ai"` | **68** | `inputCommands.js` 16 · `hudSelection.js` 7 · `renderBuildings.js` 6 · `hud.js` 6 · `boot.js` 6 · `input.js` 5 · `renderEffects.js` 4 · `hudPanelSignature.js` 4 · `landingPicker.js` 4 · `minimap.js` 2 · `overlays.js` 2 · `renderShared.js` 2 · `starmap.js` 2 · `renderUnits.js` 1 · `observerPanel.js` 1 |
| **Owner arguments** — `prereqsMet(state,"player",…)`, `supplyUsed(state,"ai")` | **29** | `overlays.js` 12 · `hudSelection.js` 10 · `hud.js` 3 · `observer.js` 2 · `renderEffects.js` 1 · `techChart.js` 1 |
| **Property paths** — `state.players.player.resources` | **22** | `hudSelection.js` 11 · `hudPanelSignature.js` 7 · `hud.js` 2 · `observer.js` 1 · `overlays.js` 1 (+ `landingPicker.js:149`, optional-chained) |

Adding `tools/ailab.js` (9), `tools/duelCore.js` (1) and `competition.js` (2) brings the comparison
total to the **80** dossier 01's finding #5 reports.

The **owner-argument** form is the cheapest of the three and worth calling out: those 29 sites call
engine functions that are *already* owner-parameterized (`prereqsMet`, `countUnits`,
`hasCompletedBuilding`, `supplyUsed`/`supplyCap`, `powerCap`/`powerDraw`, `playerScore`,
`scoreBreakdown`, `commodityAvailable`, `committedDoctrine`, `recycleFrac`, `powerEfficiency`). The
engine is ready; only the caller hardcodes the seat.

Across all three forms the sites are **three different assertions** with three different costs.

### 3.1 "Is this entity mine?" — the large, easy class

The dominant pattern. Mechanical substitution: `"player"` → `state.localOwner`.

| File | Sites |
|---|---|
| `inputCommands.js` | `:58`, `:62` (fog gate on hit-test), `:99` (`selectedUnits`), `:131`, `:136` (box select), `:170`, `:178` (double-click type select), `:197`, `:210`, `:223`, `:232`, `:242`, `:247`, `:257`, `:264`, `:271` (right-click target dispatch) |
| `input.js` | `:317` (click select), `:383` (select-all-army), `:391` (idle worker), `:407` (idle producer), `:423` (CC cycle) |
| `hudSelection.js` | `:773`, `:789`, `:898`, `:1076`, `:1696`, `:1713`, `:1722` |
| `hudPanelSignature.js` | `:149`, `:234`, `:290`, `:312` |
| `hud.js` | `:47`, `:137`, `:194`, `:336`, `:352`, `:429` |
| `renderBuildings.js` | `:84` (enemy pip), `:120`, `:147`, `:165`, `:181`, `:233` (own-only overlays: rally lines, storage bars, jump staging, power grid) |
| `renderEffects.js` | `:413`, `:419`, `:563`, `:600`, `:637` |
| `renderUnits.js` | `:91` (enemy pip) |
| `renderShared.js` | `:254` (`hiddenByFog` — **the single fog predicate**) |
| `minimap.js` | `:94`, `:99` |
| `overlays.js` | `:68`, `:69`, `:71`, `:72`, `:73`, `:74`, `:78`, `:79`, `:80`, `:81` (tutorial objectives, via `countUnits(state,"player",…)` / `hasCompletedBuilding(state,"player",…)`) |
| `boot.js` | `:370` (camera to my CC), `:675` (event fog gate), `:737` (my supply block) |
| `starmap.js` | `:56`, `:58` |
| `landingPicker.js` | `:60`, `:61`, `:151`, `:160` |
| `techChart.js` | `:36` (`const OWNER = "player"` — **already one seam**) |

**110 of the 119 sites are this class. Cost: one line each, plus one place to set
`state.localOwner`.** `techChart.js:36` is the pattern to copy everywhere — name the seam once per
module, then read the name — and `hudPanelSignature.js:373` (`state.players[b.owner].upgrades`)
shows the property-path form done right.

**Do not sweep with `sed`.** `data.js:124` defines a commodity whose id is `"ai"` (AI cores), read as
`state.players.player.resources.ai` at `hudPanelSignature.js:272`. Site-by-site, or the economy
breaks silently.

### 3.2 "The enemy is `ai`" — the class that genuinely breaks at N seats

Nine sites. These do not have a mechanical fix; each needs a design answer.

| Site | Code | What breaks at 5 seats |
|---|---|---|
| `hud.js:314` | `const you = playerScore(state,"player"), foe = playerScore(state,"ai")` | The score chip shows **one** opponent. Needs a leaderboard, or "you vs. best rival". |
| `overlays.js:34` | `FACTIONS[st.players.player.faction]`, `FACTIONS[st.players.ai.faction]` | The faction chip is a two-sided "you vs them" line. |
| `overlays.js:376` | `winner === "player" ? playVictory() : playDefeat()` | Every non-winner hears defeat, including seats that placed 2nd of 5 — arguably fine, but it is a decision. |
| `overlays.js:392-394` | `winner === "player" ? "Victory — the enemy's last Command Center is destroyed." : "Defeat — your last Command Center was destroyed."` | "**the** enemy" is false with 4 opponents. Needs `winner === state.localOwner` plus a named-winner string. |
| `overlays.js:406-407` | `scoreBreakdown(opts.state,"player")`, `playerScore(opts.state,"ai")` | "Your score / Enemy score" — needs N rows. |
| `boot.js:684`, `:704`, `:712` | `if (ev.owner === "ai") triggerUnderAttack(ev.x, ev.y)` | **A live defect at N seats.** The header comment at `boot.js:669-671` states the assumption outright: *"An attackHit whose attacker is the AI necessarily means the target is the player's (only two sides exist)."* With 5 seats, seat 2 shelling seat 4 in your line of sight fires **your** under-attack alarm. Correct predicate: `ev.targetOwner === state.localOwner`. This requires the engine event to carry the target's owner — a change on the **engine** side (dossier 01's surface), flagged here because the client is where the bug is visible. |
| `observer.js:290-291` | `supplyUsed(state,"ai")`, `supplyCap(state,"ai")` | The observer's "what the neighbour has" panel is single-opponent by construction. |
| `observerPanel.js:89` | `owner === "player" ? watch.aName : watch.bName` | Two-entrant naming; out of v1 with competitions (§7). |
| `observer.js:116` | `state.map.bases.player \|\| state.map.bases.ai` | Free-camera home point; see §3.5. |

### 3.3 Colours

**Not a problem.** `#4fd1ff` and `#f87171` are owner colours **only** in `engine/state.js:179-180`,
as `ownerDefs` data. Every client occurrence of those hex strings is unrelated chrome:

- `style.css:13` `--accent: #4fd1ff`, `style.css:16` `--bad: #f87171` — UI theme tokens
- `renderEffects.js:111`, `:113` — per-unit-type weapon tracer colours (`lancer` beam,
  `dreadnought` bolt), not team colours
- `renderEffects.js:58`, `:315`, `:326`, `:447`, `:511`, `:542`, `:584`, `:616`, `:680` — ghost
  validity, waypoint lines, rally lines, escort rings
- `renderShared.js:195`, `renderBuildings.js:109`, `:154`, `:197`, `minimap.js:114`,
  `renderUnits.js:126` — health-bar / power-tier / concern-badge palettes
- `landingPicker.js:149` — `dest.players?.player?.color || "#4fd1ff"` — **the one real coupling**:
  a hardcoded fallback plus a hardcoded owner key. Odyssey-only, out of v1.

Every actual entity draw reads `state.players[owner].color`: `renderUnits.js:66`,
`renderBuildings.js:75`, `minimap.js:95`, `minimap.js:100`. **Adding seats 3–8 needs new entries in
`engine/state.js`'s `ownerDefs` and nothing in the renderers.** Two caveats: pick a palette that is
distinguishable at minimap-dot size (4–5 px) and colour-blind-safe, and decide whether colour is
per-seat (absolute) or per-viewer (you are always blue) — the latter is friendlier and costs one
remap at `bootState`, but breaks screenshots and spectating.

### 3.4 `state.fog` vs `state.fogAI`

The client reads `state.fog` at **9 sites** and never `state.fogAI`:

`inputCommands.js:58`, `:62`, `:69`; `renderEffects.js:466`; `boot.js:675`; `render.js:202`;
`minimap.js:36`, `:83`; `renderShared.js:254`; `renderNodes.js:26`.

`engine/state.js:232-233` makes `state.fog`/`state.fogAI` **aliases** into `state.fogs`. So the
obvious client fix — "point `state.fog` at *my* seat's fog and every reader keeps working" — is a
one-line change that makes all 9 sites correct at once.

> ⚠️ **Do not do this before dossier 01's finding #6 is fixed.** `engine/gather.js:64` and
> `engine/scout.js:42` read `unit.owner === "player" ? state.fog : state.fogAI`. Rebinding the alias
> client-side is harmless *on a client that no longer simulates* — but the same client code path runs
> the loopback single-player server (ADR-0004), where it would silently resolve the wrong fog and
> desync. **Sequence: fix the engine, then rebind.**

Under the recommended fog-filtered replication (§4), the client is only ever *sent* one fog grid —
its own — so `state.fog` naturally is the local seat's fog and `state.fogAI` should not exist on a
client state at all. Assert that in a test.

### 3.5 `state.map.bases.player`

`boot.js:371` and `boot.js:471` open the camera at `state.map.bases.player`; `input.js:430` uses it
as the fallback for the CC-cycle key; `observer.js:116` falls back to `bases.player || bases.ai`.
`engine/map.js` builds `bases` as a 2-entry left/right mirror (dossier 01 finding #3). N-seat start
positions are an **engine/map** change; the client needs `state.map.bases[state.localOwner]` and
nothing more.

### 3.6 The "seat 3 of 5" test, summarized

| Layer | Verdict |
|---|---|
| Renderers, minimap, colours | **Already works.** Owner-generic reads throughout. |
| Selection, hit-testing, HUD panels, objectives | **Works after one substitution per site** (~71 sites). |
| Fog | **Works after one alias rebind**, once the engine's two `=== "player"` fog reads are fixed. |
| Under-attack alarm | **Broken** — fires on any `owner === "ai"` hit. Needs a target-owner field on the event. |
| Score chip, faction chip, victory copy, score breakdown | **Broken** — hardcoded two-sided copy. ~6 sites, all in `hud.js`/`overlays.js`, all cosmetic-but-visible. |
| Start positions | **Engine change** (`map.bases`), then one client substitution. |

---

## 4. Rendering under authoritative fog

### 4.1 How hard is per-client filtering, given `engine/fog.js`?

**Easy — the primitive already exists and is already the right shape.** `engine/fog.js` is 144 lines.
Fog is a coarse grid (`FOG_CELL_SIZE = 40`, `fog.js:23`) of two `Uint8Array`s per owner —
`visible` (recomputed from scratch every tick, `fog.js:125`) and `explored` (permanent). Every owner
has their own, keyed in `state.fogs` and recomputed by the same `updateFog(state, fog, owner)`
(`fog.js:124`). The whole filter predicate is one existing exported function:

```js
isVisibleAt(state.fogs[seat], e.x, e.y)     // engine/fog.js:49 — two divides, one array index
```

Measured cost of filtering both entity collections for one seat: **0.24–0.69 ms** at 400–1,600 units
(§4.3). The server already pays `updateFog` per owner every tick regardless — filtering adds one
O(1) lookup per entity per seat, which is noise next to the `JSON.stringify` it *saves*.

The engine also documents the exact semantics we need: *"There's no 'remembered snapshot' of enemy
positions once they leave vision — they simply stop rendering"* (`fog.js:14-15`). So the shipped
game has **no last-known-position ghosts today**. Filtering therefore strips nothing the current
renderer draws for enemies.

### 4.2 What filtering would strip that the renderer legitimately needs

Six things. Five are already solved by how the codebase is built; one is a real decision.

1. **The static map — already free.** `serializeGame` does not include `state.map`; terrain, node
   positions and base positions are regenerated from `seed` + `planetId` by `rehydratePlanet`
   (`engine/persist.js`). The client is told the map config once at match start and builds the world
   itself. **Nothing per-tick.**
2. **Resource nodes — must NOT be filtered by `visible`.** `renderNodes.js:26` and
   `inputCommands.js:69` gate nodes on `isNodeDiscovered(state.fog, n)`, which reads **`explored`**,
   not `visible` (`fog.js:66-67`) — deliberately: charted deposits are "map knowledge, not
   battlefield intel" (`fog.js:10-13`), and only `hidden` caches need scouting. A filter that used
   `visible` would make every deposit blink out the moment a worker walks away. **Filter nodes on
   `explored`, not `visible`** — and note that `n.amount` changes as *anyone* mines: sending live
   amounts for a node in enemy territory is an intel leak. Send `amount` only for nodes currently
   `visible`; send last-seen `amount` otherwise.
3. **Craters and wrecks — survive filtering for free.** `engine/wreckage.js` and `engine/bomb.js`
   turn into *resource nodes* with `crater: true` / `wreck: true`
   (`engine/persist.js:549`, `:682-708`), drawn by `renderNodes.js:28` / `:114-150`. They are map
   knowledge under rule 2, not entities. Pending (not-yet-matured) craters and wrecks are separate
   top-level arrays (`persist.js:554`, `:562`) and are small — 0.0 KB and 0.8 KB measured.
   **Send both unfiltered; they are terrain, and the deposit's existence is not secret intel.**
4. **The fog grid itself — send one, not two.** `serializeGame` ships `fog` **and** `fogAI`
   (`persist.js:566-567`): **31 KB each on a 4× map**. Broadcasting both to every client literally
   hands each player their opponent's vision map. The client needs exactly one grid — its own — and
   only `explored` (which is what `drawFogBase`, `render.js:201-244`, paints from, plus
   `isNodeDiscovered`). `visible` can be recomputed client-side from the entities the client can
   see, or sent as a delta; `explored` is monotone and compresses to a run-length or a bitset
   trivially (16,000 cells → 2 KB as a bitset, vs 31 KB as a JSON array of 0/1).
5. **Events — must be filtered, and the rule already exists.** `boot.js:675` reads
   `if (ev.owner !== "player" && !isVisibleAt(state.fog, ev.x, ev.y)) continue;` — the client already
   applies exactly the per-seat event filter the server needs. **Move that line to the server, per
   seat, verbatim.** The under-attack trigger (`boot.js:684`, `:704`, `:712`) and the supply-block
   beep (`:737`) then need the target-owner field from §3.2.
6. **Interpolation continuity — already safe, which is the surprise.** Under filtering an entity can
   legitimately vanish between snapshots (it walked into fog) or appear mid-motion far from where it
   was last seen. That is normally the first thing to break when a client stops holding the whole
   world. Here all three cases are already handled, by code written for a different reason:

   - **Appearing.** `lerpXY` (`renderShared.js:56-58`) returns the *live* entity when it has no
     baseline — *"a unit spawned this tick"*. A newly-visible enemy snaps to its true position
     instead of lerping from nowhere. ✔
   - **Reappearing far away.** `TELEPORT_SQ = 60*60` (`renderShared.js:40`, applied at `:59-60`):
     *"a one-tick move past this is a teleport, not motion — don't lerp it."* A unit re-sighted
     across the map snaps rather than sliding. ✔
   - **Vanishing.** `pruneFacing(state)` runs **every frame**, at the top of `drawFrame`
     (`render.js:112`), dropping `prevPos` and `facing` entries for ids no longer in `state.units`
     (`renderShared.js:69-76`). An entity that leaves the filtered view is cleaned up that frame;
     if it comes back it has no baseline and takes the "appearing" path above. ✔

   One cosmetic residue: a re-sighted enemy loses its remembered facing and re-derives from
   `updateFacing`'s default (`renderShared.js:97`), so it may point "up" for a frame or two before
   its next movement corrects it. A one-line fix if it ever reads badly (keep `facing` entries
   longer than `prevPos`); not a blocker.

   **`snapshotPositions` needs no change at all.** Called from `boot.js:501` immediately before each
   `tick`, it becomes "immediately before applying each authoritative snapshot" — which is precisely
   snapshot interpolation. The client already has the mechanism a networked renderer needs.

### 4.3 Measured payloads (this machine, `engine/persist.js` format)

`serializeGame` is the *save* format, not a wire format, so treat these as an upper bound with the
right shape. Node v22, same container as dossier 00.

| Scenario | Units | Full snapshot | `stringify` | Fog arrays | Fog-filtered per seat |
|---|---|---|---|---|---|
| Standard map, natural 20-min self-play match | 21 | 19.2 KB | 0.23 ms | 2 KB × 2 | 2.6 KB / 0.04 ms |
| Standard map, 200 v 200 | 406 | **96 KB** | 0.82 ms | 2 KB × 2 | 14 KB / 0.25 ms |
| 4× map, 200 v 200 | 406 | **154 KB** | 2.56 ms | **31 KB × 2** | 14 KB / 0.24 ms |
| 4× map, 400 v 400 | 806 | **236 KB** | 3.21 ms | 31 KB × 2 | 28 KB / 0.35 ms |
| 4× map, 800 v 800 | 1,606 | **404 KB** | 4.45 ms | 31 KB × 2 | 55 KB / 0.69 ms |

At 20 Hz with 4 seats:

- **Full broadcast**, 4× / 800v800: 404 KB × 20 × 4 = **32 MB/s egress**, and 4.45 ms × 4 =
  **17.8 ms of a 50 ms tick** in `JSON.stringify` alone (the sim itself costs 22 ms p99 at this
  size per dossier 00 — together they blow NFR-2).
- **Fog-filtered**, same scenario: 55 KB × 20 × 4 = 4.4 MB/s, 2.8 ms total. Still too much for
  20 Hz snapshots without deltas, which is why §4.4's migration path exists — but it is the
  difference between "needs delta encoding" and "architecturally impossible".
- **Realistic band** (4× map, 200v200, the near-supply-cap case dossier 00 calls normal): full
  154 KB → 12 MB/s; filtered 14 KB → 1.1 MB/s.

Dossier 00's conclusion is confirmed from the other side. The sim runs ~500× real time; the server
spends its wall clock waiting. **Serialization is the cost centre, and it scales with what you send,
not with what you simulate.**

### 4.4 Recommendation

**Fog-filtered per client. From day one. Not as an optimization — as the architecture.**

Four reasons, in order of weight:

1. **ADR-0003 chose server authority specifically so fog could not be map-hacked** (its Context §1
   and §2). Full-state broadcast reinstates the exact property lockstep was rejected for: every
   client holds the whole map, and fog becomes a client-side rendering courtesy. It would make the
   central architectural decision decorative.
2. **PRD G2 makes agents first-class players.** The MCP server (dossier 05) has to hand an agent a
   legitimate, seat-scoped view. That filter has to exist regardless. Building it once and using it
   for browsers too is strictly less work than building it for agents and a bypass for browsers.
3. **The numbers say full-broadcast does not fit** (§4.3), and the cost is in the *format*, not the
   *filter*: `fog`+`fogAI` alone are 62 KB of the 154 KB at 4×, and both are per-seat secrets.
4. **Retrofitting is worse than starting there.** Every client module written against "I hold
   everything" acquires a quiet dependency on data it should not have. `renderShared.js:253`'s
   comment already names the failure mode: *"an inverted or dropped test doesn't crash or look wrong,
   it quietly paints the enemy's army through the fog."*

**Trade-offs accepted, stated plainly:**

| Cost of filtering | Mitigation |
|---|---|
| Server does N filter passes per tick instead of 1 serialize | Measured 0.24–0.69 ms per seat; the sim it accompanies is 0.2–22 ms. Noise. |
| Interpolation must handle entities appearing/vanishing | **Already handled** — §4.2 item 6. Zero lines. |
| Spectator/replay wants full state | Give the **spectator** a synthetic all-seeing seat (`observerMode` already bypasses `hiddenByFog`, `renderShared.js:254`). One extra filter config, not an extra path. |
| Harder to debug ("why is the client missing X?") | A dev-only `--no-fog-filter` server flag, and a test that asserts a filtered snapshot contains no entity the seat cannot see. |

**Migration path** (each step independently shippable and testable):

1. **Send the map config, not the map.** Client rebuilds terrain/nodes from `{planetId, seed,
   sizeMult, resourceMult}`. Removes the largest static payload before any filtering exists.
2. **Send one fog grid, not two**, and only `explored`, as a bitset. −60 KB/tick at 4× and closes
   the vision leak immediately.
3. **Ship a full-snapshot loopback first** (ADR-0004). No filter, no socket: proves the
   client-renders-a-given-state seam with the inherited tests still running.
4. **Insert the filter in the loopback.** `filterFor(state, seat)` → the same `View` shape. Single-
   player now pays for and therefore *tests* the filter (ADR-0004's explicit intent). Assert
   `filterFor(state,"player")` contains no entity outside `state.fogs.player`.
5. **Delta-encode.** Only entities whose fields changed since the client's last acked snapshot, plus
   an id list for removals. This is where 55 KB becomes a few KB; do it after correctness.
6. **Then and only then, the socket.**

---

## 5. What is reusable verbatim

Client tree: **19,635 LOC** (17,903 JS + 1,732 CSS) across 38 files.

### 5.1 Zero change — 2,850 LOC (14.5%)

| Module | LOC | Why |
|---|---|---|
| `style.css` | 1,732 | No owner concept. Gains additive rules for the lobby and `netStatus`. |
| `data.js` | 242 | Pure display data (planet names, commodity table). One incidental `"ai"` — a **commodity** id (`:124`), not an owner. |
| `effects.js` | 183 | Particle/decal bookkeeping over `{x,y,type}`. Fed by replicated events instead of local ones — no signature change. |
| `sound.js` | 181 | Zero references to `state`, `player` or `ai`. |
| `renderNodes.js` | 171 | Owner-free; its one coupling is `state.fog` (`:26`), which the alias rebind (§3.4) handles. |
| `update.js` | 108 | Version-chip / auto-update. Untouched. |
| `camera.js` | 105 | Pure math. Zero references to `state`, `player`, `ai`. |
| `dom.js` | 68 | Element handles. |
| `version.js` | 60 | Version + save-impact display. |

### 5.2 Near-zero change — 5,942 LOC (30.3%)

A `localOwner` substitution, one predicate, or an added parameter. **No restructuring.**

| Module | LOC | Touch points |
|---|---|---|
| `renderBuildings.js` | 807 | 6 owner literals (`:84`, `:120`, `:147`, `:165`, `:181`, `:233`) |
| `renderUnits.js` | 699 | 1 (`:91`) |
| `renderEffects.js` | 683 | 5 (`:413`, `:419`, `:563`, `:600`, `:637`) |
| `overlays.js` | 585 | 10 objectives (`:68-81`) + 4 victory-copy sites (`:376`, `:392`, `:406`, `:407`) + 1 faction chip (`:34`) |
| `setup.js` | 462 | Option model and map cards verbatim; card click re-targets to the lobby. New lobby screen is *additive*. |
| `hud.js` | 452 | 6 owner literals + 2 `players.player.resources` reads + the 1v1 score chip (`:314`) |
| `hudPanelSignature.js` | 380 | 4 owner literals + 6 `players.player` reads. The signature *mechanism* — repaint only when the panel's meaningful inputs change — is exactly right for a snapshot-driven client and should be kept. |
| `techChart.js` | 366 | 1 line: `const OWNER = "player"` (`:36`) → `state.localOwner`. |
| `observer.js` | 304 | Repurposed as the spectator client (§7); 4 sites (`:116`, `:276`, `:290`, `:291`) |
| `render.js` | 277 | `state.fog` (`:202`) only — the interpolator needs nothing (§4.2 item 6) |
| `renderShared.js` | 255 | 1 predicate: `hiddenByFog` (`:253-255`) |
| `observerPanel.js` | 246 | 1 site (`:89`) |
| `main.js` | 168 | 2 `issue*` (`:149-150`) → transport sends. Everything else (canvas resize, DPR, panel folds, mute) verbatim. |
| `minimap.js` | 138 | 2 (`:94`, `:99`) |
| `session.js` | 120 | Additive fields only (§2.1) |

### 5.3 Real work — 3,662 LOC (18.6%)

| Module | LOC | Touch points | Nature |
|---|---|---|---|
| `hudSelection.js` | 1,998 | **67 distinct lines** (7 comparisons + 10 owner args + 11 property paths + 5 `issue*` + 33 mutators + 2 raw writes, one line double-counted) | Every panel's *layout* is verbatim; only the click handlers change from "call the engine" to "send a command", and the affordability reads re-point at the local seat. **3.4% of the file.** Mechanical but wide. |
| `boot.js` | 788 | The lifecycle itself | §2.3. The genuinely architectural file. |
| `input.js` | 588 | **18** (5 comparisons + 6 `issue*` + 6 selection writes + `map.bases.player` `:430`), plus `placeBuildingAt` (`:517-525`) going async | Gesture handling, camera, hotkeys, control groups all verbatim. **3% of the file.** |
| `inputCommands.js` | 288 | **35 distinct lines** (16 comparisons + 13 `issue*` + 5 selection writes + `state.fog` `:69`) — **12% of the file** | The densest coupling in the tree, and the most important to get right: it is the whole right-click dispatch. |

### 5.4 Out of multiplayer v1 — 6,779 LOC (34.5%)

`competition.js` 3,773 · `competitionLedger.js` 1,290 · `pairing.js` 518 · `competitionWorker.js` 355
· `starmap.js` 318 · `landingPicker.js` 211 · `playerFingerprint.js` 167 · `elo.js` 147. See §7.

### 5.5 Repurposed — 402 LOC (2.0%)

`saveload.js` 371 · `saveShape.js` 31. See §6.

### 5.6 The number that matters

Excluding the modules that do not ship in v1, the **in-scope client is 12,856 LOC**:

| Verdict | LOC | Share of in-scope |
|---|---|---|
| Verbatim | 2,850 | **22%** |
| Near-zero | 5,942 | **46%** |
| **Verbatim + near-zero** | **8,792** | **68%** |
| Real work | 3,662 | 28% |
| Repurposed | 402 | 3% |

**Roughly two-thirds of the shipping client is reusable as-is or with per-site substitutions.** That
is the strongest argument in this dossier for the port being a re-seaming job.

---

## 6. `saveload.js` / autosave / `localStorage` in multiplayer

### 6.1 What exists

`saveload.js` (371 LOC) runs two channels over `localStorage`:

- **Autosave** — a 12 s timer (`AUTOSAVE_INTERVAL_MS`, `:39`) plus `beforeunload` (`:370`),
  writing `serializeGameString(game.state)` to `stellarfrontier.save.v1` (`:31`) or
  `serializeGalaxyString(game.galaxy)` to `stellarfrontier.odyssey.v1` (`:32`), with a
  rotated previous generation (`KEY + '.prev'`, `:33`, `writeGeneration` `:84-95`).
- **File export/import** — `saveToFile` (`:166`), `loadFromFile` (`:185`).
- **Resume** — `loadGame` (`:138`) / `loadOdyssey` (`:127`) feed `bootState`/`bootGalaxy`; the
  setup screen's "Continue" button (`setup.js:347`, `:372`).
- **Failure surfacing** — `recordAutoSaveOutcome` (`:338`) toasts after 3 consecutive failures.
- `saveShape.js:29` `resumableMode` already refuses to checkpoint a state that is `over`, a
  scenario, or a spectated match.

Other `localStorage` users: `update.js:23-24` (dismissed-update flag), `overlays.js:97-100`
(help-strip seen flag), `competitionLedger.js:1238-1290` (the ratings ledger).

### 6.2 Recommendation

**Client-side autosave of match state is deleted in multiplayer. Not disabled — deleted from the
multiplayer path.**

Reasoning:

1. **The client no longer holds the authoritative state.** `serializeGameString(game.state)` on a
   fog-filtered view produces a save of a *partial world*. Loading it would resume a game with the
   enemy's army missing. There is no correct thing for it to write.
2. **A single seat cannot resume a 4-seat match.** Resumption is a *match-level* operation: it needs
   every seat's consent and every seat's presence. That makes it a server feature or nothing.
3. **"Continue" would be a lie.** The setup screen's Continue button restores *your* game. In
   multiplayer there is no such thing.

**What replaces it:**

| Concern | Multiplayer answer |
|---|---|
| Crash / refresh mid-match | **Server-side match persistence + rejoin by `matchId`.** The server holds the state anyway; snapshot it to disk on a slow cadence (30–60 s) as a host-crash guard. The client keeps `{matchId, seat, token}` in `localStorage` — a few dozen bytes — and offers "Rejoin match" on the splash. This is the *right* use of `localStorage` here. |
| Replay / post-match analysis | **Server-side command log**, not a client save. Dossier 02 D7: a match replays from `{engineCommit, createGameStateOpts, dt, aiSeatConfigs, orderedCommandLog}`. That is a few KB for a whole match versus 400 KB for one snapshot, and it is the artefact the MCP/agent work (dossier 05) wants anyway. |
| Single-player | **Autosave stays, unchanged.** Under ADR-0004 the loopback server is in the tab and holds the full authoritative state. `saveload.js` re-points from `game.state` to `session.server.state` — a one-line change to `snapshot()` (`:68-76`) — and every existing test keeps meaning what it meant. |

**Keep, verbatim:** `update.js`'s dismissed-update flag, `overlays.js`'s help-strip flag,
`game.formation` / `game.collapsedSections` / `game.groups` if they are ever persisted. These are
per-viewer preferences, exactly what browser storage is for.

**Guard rails to add:**

- `saveShape.js:29` `resumableMode` gains one clause: return `null` when `game.match` is a networked
  match. That single line disables the timer, the `beforeunload` write and the Continue button
  together, because everything funnels through `snapshot()`.
- A test asserting that no networked match ever writes `stellarfrontier.save.v1`. The failure mode
  here is silent (`saveload.js:42` swallows storage exceptions by design) so it must be asserted, not
  observed.

---

## 7. Odyssey / galaxy / competition / observer — in or out of multiplayer v1

### Odyssey (open-world campaign) — **OUT**

**Client LOC:** `starmap.js` 318 + `landingPicker.js` 211 = **529**, plus large fractions of
`hudSelection.js` (lanes, colony policy, freight, spaceport, capital, electrify — 22 of the 38
mutator sites in §1.2), the galaxy branch of `boot.js`'s loop (`:502-524`), `startOdyssey`/
`bootGalaxy`/`performJump`/`initiateJump`/`surrenderOdyssey`/`focusActivePlanet`/`notifyColony`/
`celebrateMilestone` (`boot.js:259-388`, `:605-652`) ≈ **180 LOC of `boot.js`**, and
`observer.js`'s galaxy spectating. Call it **~900 client LOC plus a third of `hudSelection.js`'s
behaviour**.

**Why out:**

1. **It is a different game shape.** Odyssey simulates *every world in the galaxy* each tick
   (`boot.js:503` `stepGalaxy`), with the player controlling one and the rest running as background
   colonies. Multiplayer would have to decide whose worlds tick, who sees which world, and what a
   "jump" means when four players are on four different planets. That is a design project, not a port.
2. **It carries the engine's worst owner-literal concentration.** Dossier 01 finding #4:
   35 of 53 engine owner literals live in `galaxy.js` (19), `scenarios.js` (4), `colonyPolicy.js` (3),
   `sim.js`'s Odyssey-logistics block (4) and `diplomacy.js` (2) — *"in the Odyssey open-world and
   scripted-mission layers, which a multiplayer skirmish never loads."* **Scoping Odyssey out of v1
   removes two-thirds of the engine's N-player work.** This is the single highest-leverage scope
   decision available.
3. **Credits are a galaxy-level singleton.** `game.galaxy.credits` (`hudSelection.js:291`, `:414`,
   `:628`, `hud.js:257`, `starmap.js:87`) is one number for one player. There is no defined meaning
   for it with 5 seats.

**Preserved through the loopback:** single-player Odyssey keeps working unchanged (ADR-0004), which
is the whole reason this scoping is cheap rather than a feature deletion.

**Keep the imports.** `main.js:26` side-effect-imports `starmap.js` for the M key and the galaxy
button. In a multiplayer build the module must still load (stubbed) or the hotkey silently disappears.

### Competitions / Elo — **OUT as shipped, but read `pairing.js` and `elo.js` first**

**Client LOC:** `competition.js` 3,773 + `competitionLedger.js` 1,290 + `pairing.js` 518 +
`competitionWorker.js` 355 + `playerFingerprint.js` 167 + `elo.js` 147 = **6,250 LOC — 32% of the
entire client tree, and the largest single module in it.**

**Why out:** the whole subsystem is a *local* ladder. `competitionLedger.js` stores ratings in
`localStorage` (`:1238-1290`); `competitionWorker.js` runs AI-vs-AI duels in a Web Worker;
`competition.js`'s Gauntlet plays fixtures against simulated opponents. Its founding constraint is
stated in `boot.js:148-153`: *"a human cannot play forty games"*, and *"NO side-swap, because the
human can only ever hold owner `player`"*. A real multiplayer ladder is server-side, cross-player and
authoritative — a different system that happens to share a rating formula.

**But two pieces are directly reusable and should not be rewritten:**

- **`elo.js` (147 LOC)** — a pure rating function. Move it server-side as-is for a real ladder.
- **`pairing.js` (518 LOC)** — round-robin/Swiss pairing and schedule generation. This is
  matchmaking. Read it before writing a lobby queue.
- `playerFingerprint.js` (167 LOC) — `fingerprintPlayer(state, owner = "player")` (`:53`) is already
  owner-parameterized. Useful later for agent behaviour analysis (dossier 05), not for v1.

### Observer Mode — **IN, repurposed as the spectator client**

**Client LOC:** `observer.js` 304 + `observerPanel.js` 246 = **550**.

**Why in — it is the cheapest feature in the port.** Observer Mode already is a
render-a-state-you-do-not-control client:

- It bypasses fog at the single predicate (`renderShared.js:254`'s `observerMode` argument,
  threaded from `boot.js:547-548`), rather than mutating `state.fog` (`observer.js` header,
  `renderShared.js:250-251`).
- It has its own camera (`game.observerCamera`, `session.js:103`) independent of `game.input`'s.
- It makes `input.js` refuse to issue orders — *"every mouse/wheel/key path already early-returns
  into observer.js while `game.observerMode` is on"* (`boot.js:197-199`).
- It renders a **different state object** than the one being played (`observedState()`,
  `boot.js:545`) — which is precisely "render a replicated view".

**The changes are small:** `observer.js:290-291`'s `supplyUsed(state,"ai")` becomes per-seat;
`observerPanel.js:89`'s two-entrant naming becomes an N-seat list; entry gating moves from
"Odyssey or `spectateMatch`" (`observer.js`) to "the server assigned me a spectator seat".

**A spectator is exactly the synthetic all-seeing seat §4.4 needs.** Server-side, a spectator gets a
filter config of "everything" (or, for competitive integrity, a delayed full view). The client-side
machinery for it already ships.

### Scenarios (Escort / Raider / Bounty) — **OUT of multiplayer v1, IN via loopback**

`boot.js:234-254` — three single-player scripted missions with their own objectives. Co-op scenarios
are an appealing v2 (`setupEscort` etc. already build a full state), but they are PvE content with
2-side scripting. Single-player keeps them unchanged through the loopback.

---

## 8. Offline single-player preservation

### 8.1 The loopback works for this client, and the client is unusually ready for it

ADR-0004 Option C requires that the client never touches `engine/` mutation directly and instead
talks to a session through a transport. From the client's side that is:

- **64 mutation call sites** (§1.1, §1.2) become `session.send(cmd)`. Every one already has an
  explicit argument list; dossier 02's codec owns the id→object resolution.
- **13 sim-ownership sites** (§1.5) move behind `session.createMatch(cfg)` / the transport's
  match-start message.
- **`game.state` becomes the received view.** `session.js`'s read-at-call-time discipline
  (`:8-10`) means every consumer already tolerates that object being swapped.

Because the loopback server runs **in the same tab**, single-player keeps: no network, no latency, no
service dependency, byte-identical determinism, and the full `serializeGame` save (§6).

### 8.2 Why this keeps the 2,519 tests meaningful

The inherited suite constructs a `State` and calls engine functions directly. Under ADR-0004:

- **`engine/` tests are untouched.** The engine's API does not change (dossier 02 D2: exactly one
  signature change, `issueSetRally`).
- **Client tests that drive `boot.js`** (`test/boot.test.js` drives the real loop) keep working
  because `bootState` keeps its shape (§2.3) and the loopback is synchronous.
- **The multiplayer machinery gets covered by every single-player test run** — the codec, the
  ownership check and the per-seat filter all execute on the loopback path. That is ADR-0004's
  entire thesis and it holds on the client side.

### 8.3 What in the client resists the loopback — five flags

1. **`input.js:517-525` `placeBuildingAt` needs a synchronous answer.** `issueBuild` returns the new
   building's id and build mode exits only if it is truthy. Loopback is synchronous so this
   *survives unchanged locally* — which is the trap: **it will pass every single-player test and
   fail over a socket.** Either make the transport interface async-by-contract from day one (the
   loopback resolving immediately), or the WebSocket path will be the first place anyone discovers
   this. **Recommend: async-by-contract, and use ADR-0004's fault-injection mode (its Decision
   section) to run the single-player suite with simulated latency in CI.** The same applies to
   `hud.js:37`, `hudSelection.js:449/459/485/494` and `boot.js:287`.
2. **`boot.js:551` polls `game.state.over`.** Harmless over loopback, wrong over a socket (§2.3).
   Make it a message from day one so the loopback exercises the message path.
3. **Refcounted pause gates `update()`** (`boot.js:500`). Correct for single-player, illegal for
   multiplayer. The branch has to exist; ensure single-player takes the *same* code path with a
   server-side pause command rather than a client-side `return`.
4. **`state.fog` alias rebinding is unsafe until the engine is fixed** — `engine/gather.js:64`,
   `engine/scout.js:42` (§3.4, dossier 01 finding #6). Because the loopback server runs the same
   engine in the same tab, a client-side rebind here does not merely mis-render, it **desyncs the
   single-player sim**. Fix order matters.
5. **`main.js`'s side-effect imports** (`:26-28`) self-wire at module-load. A build that trims
   modules for the multiplayer bundle must keep the import or explicitly re-wire; the failure is
   silent (README already documents this).

### 8.4 What single-player retains, unchanged

Full-state rendering (its loopback server can hand it an unfiltered view, or the filtered one — it
should hand it the **filtered** one, so single-player tests the filter), autosave and Continue,
Odyssey, the three scenarios, competitions and the local ladder, Observer Mode, the file
export/import, and every hotkey. **Nothing in §7's "out of v1" list is deleted; it is only absent
from networked matches.**

---

## 9. Summary table

Verdicts: **verbatim** (no edits) · **light** (per-site substitution, no restructuring) ·
**heavy** (restructuring) · **server-side** (moves out of the browser) ·
**out-v1** (not in multiplayer v1; still shipped for single-player).

| Module | LOC | Verdict | Why |
|---|---|---|---|
| `style.css` | 1,732 | **verbatim** | additive lobby/net-status rules only |
| `camera.js` | 105 | **verbatim** | pure math, zero state coupling |
| `dom.js` | 68 | **verbatim** | element handles |
| `sound.js` | 181 | **verbatim** | zero owner/state references |
| `effects.js` | 183 | **verbatim** | `{x,y,type}` bookkeeping; fed by replicated events |
| `data.js` | 242 | **verbatim** | pure display data (`:124`'s `"ai"` is a commodity) |
| `version.js` | 60 | **verbatim** | version/save-impact chip |
| `update.js` | 108 | **verbatim** | auto-update chip; keeps its `localStorage` flag |
| `renderNodes.js` | 171 | **verbatim** | owner-free; `state.fog` (`:26`) via the alias rebind |
| `renderBuildings.js` | 807 | **light** | 6 literals: `:84`, `:120`, `:147`, `:165`, `:181`, `:233` |
| `renderUnits.js` | 699 | **light** | 1 literal: `:91`. Colour already generic (`:66`) |
| `renderEffects.js` | 683 | **light** | 5 literals: `:413`, `:419`, `:563`, `:600`, `:637` |
| `overlays.js` | 585 | **light** | objectives `:68-81`; victory copy `:376`, `:392`, `:406-407`; faction chip `:34` |
| `setup.js` | 462 | **light** + additive | option model verbatim; new `renderLobby()` (~150–250 LOC) |
| `hud.js` | 452 | **light** | 6 literals + 2 `players.player` reads + 1v1 score chip `:314` |
| `hudPanelSignature.js` | 380 | **light** | 4 literals + 6 `players.player` reads; the signature idea is *right* for snapshots |
| `techChart.js` | 366 | **light** | one line: `:36` `const OWNER = "player"` |
| `observer.js` | 304 | **light** | repurposed as spectator; `:116`, `:276`, `:290`, `:291` |
| `render.js` | 277 | **light** | `state.fog` `:202`; interpolator already fog-safe (§4.2.6) |
| `renderShared.js` | 255 | **light** | one predicate: `hiddenByFog` `:253-255` |
| `observerPanel.js` | 246 | **light** | `:89` two-entrant naming → N seats |
| `main.js` | 168 | **light** | 2 `issue*` `:149-150`; side-effect imports `:26-28` must survive |
| `minimap.js` | 138 | **light** | 2 literals `:94`, `:99`; colours already generic `:95`, `:100` |
| `session.js` | 120 | **light** | additive fields: `transport`, `match`, `localOwner`, `serverTick`, `lobby`, `netStatus` |
| `hudSelection.js` | 1,998 | **heavy** (wide, shallow) | 59 touch points = 3% of the file; layout verbatim, handlers become sends; **`:1045`, `:1722` need new engine commands** |
| `boot.js` | 788 | **heavy** | the lifecycle: loop split, match-end message, pause semantics, lobby entry |
| `input.js` | 588 | **heavy** | 17 touch points + `placeBuildingAt` `:517-525` goes async |
| `inputCommands.js` | 288 | **heavy** | 37 touch points = 13% of the file; the right-click dispatch |
| `saveload.js` | 371 | **server-side** | match persistence + rejoin move to the server; single-player keeps it (§6) |
| `saveShape.js` | 31 | **light** | one clause: refuse to checkpoint a networked match |
| `competition.js` | 3,773 | **out-v1** | local ladder vs simulated opponents |
| `competitionLedger.js` | 1,290 | **out-v1** | `localStorage` ratings store |
| `pairing.js` | 518 | **out-v1** | **read first** — this is matchmaking |
| `competitionWorker.js` | 355 | **out-v1** | Web Worker duel runner |
| `starmap.js` | 318 | **out-v1** | Odyssey galaxy map; keep the `main.js` import |
| `landingPicker.js` | 211 | **out-v1** | Odyssey jump landing site |
| `playerFingerprint.js` | 167 | **out-v1** | already owner-generic (`:53`); useful for agent analysis later |
| `elo.js` | 147 | **out-v1** | **reuse server-side** — pure rating function |
| **Total** | **19,635** | | |

**Roll-up (in-scope for v1 = 12,856 LOC):** verbatim 2,850 (22%) · light 5,942 (46%) ·
heavy 3,662 (28%) · server-side/repurposed 402 (3%). **Verbatim + light = 68%.**

---

## 10. Ordered recommendations

1. **Close the two raw entity writes before the codec ships.** `hudSelection.js:1045` routes to the
   existing `issueSetHomeBase([unit], null)` (`engine/commands.js:281`) — no engine change at all.
   `hudSelection.js:1722` needs a new `issueSetElectrified(state, buildingIds, on)`, with
   `engine/aiIndustry.js:172` routed through it too so the field has exactly one writer. Smallest
   change in this document, largest correctness payoff: these are the only client mutations dossier
   02's codec cannot see.
2. **Fix `engine/gather.js:64` and `engine/scout.js:42` before anything rebinds `state.fog`.**
   Dossier 01 finding #6. Under the loopback this is a desync, not a render bug.
3. **Introduce `state.localOwner` (or `game.localOwner`) and sweep the 71 "is this mine" literals
   site-by-site.** Never with a blind `sed`: `data.js:124` defines a commodity called `"ai"`.
4. **Scope Odyssey and competitions out of multiplayer v1.** Removes 6,779 client LOC and — per
   dossier 01 finding #4 — two-thirds of the engine's owner-literal work. Both keep working in
   single-player via the loopback.
5. **Make the transport interface asynchronous by contract from day one**, and run the single-player
   suite under ADR-0004's fault-injection latency in CI. Otherwise `input.js:521` and the four other
   return-value sites pass every test and break over the socket.
6. **Replace the `game.state.over` poll (`boot.js:551`) with a `match-end` message immediately**, so
   the loopback exercises the message path from the first commit.
7. **Ship fog-filtered replication from day one** (§4.4), following the six-step migration path.
   Send the map config not the map, and one `explored` bitset not two JSON fog arrays.
8. **Keep `bootState` as the single boot funnel and `session.js`'s read-at-call-time discipline.**
   They are why the rest of this is cheap.
