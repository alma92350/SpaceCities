# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project uses
[semantic versioning](https://semver.org/).

## [Unreleased]

### Added

- **The MCP observation surface now says what things ARE, what they're DOING, and what just
  happened.** Every item below is a gap a real agent player hit in a played match.
  - `get_map_overview` reports each discovered node's **commodity, position, max and distance from
    your nearest base, nearest first**, plus `commodities_available` and the map's bounds. The wire
    projection still ships `{id, amount}` (a browser client regenerates the rest from the seed);
    the static half is now merged in from the match worker's own new `describeMap` reply, keyed by
    the ids in that seat's own fog-filtered projection, so no undiscovered node is ever revealed.
    Previously the only way to learn a node's commodity was to walk a worker to it and watch which
    counter moved — which made "gather from the closest ore" an instruction no agent could follow.
  - `list_entities` reports your own entities' `activity`
    (idle/gathering/moving/attacking/building/producing/under-construction), `orderTarget`, a
    producer's `queue` and a site's `buildProgress`, and takes an `activity` filter — so idle
    workers are findable. An enemy's activity is still never reported: fog doesn't reveal intent.
  - `get_situation` adds `idle_unit_ids`, `supply`/`supply_cap`, `you`/`opponents` and the map's
    bounds and tick rate.
  - `get_tech_options` adds each type's real `stats` (hp, attack, range, speed, build time,
    supply…), `produced_by`/`buildable`, and `missing_prereqs` — which requirement is missing, by
    name, instead of a bare `prereqs_met:false`. A scenario-only unit no building can train (the
    Freighter) now reads `buildable:false` rather than advertising itself as a free unit.
  - `get_counters` exposes the counter triangle as a TOOL, not only as the `game://counters`
    resource many MCP clients never surface.
  - Events carry entity ids: `entityKilled` has the dead entity's `id` (plus `killerId`/
    `killerOwner`), `attackHit` has `sourceId`/`targetId`, `unitSpawned` has the new unit's `id`
    and `fromBuildingId`, `buildingComplete` the finished building's `id`. Two new events —
    `nodeDepleted` and `unitIdle` — announce the quietest way a match rots: a seam running dry and
    the gatherer that then had nowhere to go.

- **A perf guard that can actually fail.** The existing wall-clock alarms are ~12x looser than
  the work they measure, so a 10x regression shipped green — which is how a broad phase scanning
  13x more area than it needed sat at half the sim's CPU unnoticed. Loosening or tightening those
  budgets isn't the fix; they are deliberately slack because wall clock on a shared runner is
  noisy. So the new guard doesn't measure time: it counts the candidates the broad phase visits,
  which is deterministic, identical on every machine, cannot flake, and moves the instant a query
  box grows. It asserts a ratio against a committed baseline, in both directions — a big drop
  fails too, because a stale baseline is a guard that has quietly gone slack again.
- **`test/grid-superset.test.js` — the broad phase's superset invariant, made mechanical.** A
  missed candidate is a missed interaction, and nothing in the suite could see one: determinism
  compares a seed against itself, so both runs miss the same unit identically. Four guards now
  cover it — the box arithmetic against a brute-force scan, the movement-step bound re-derived
  from the game's own unit and modifier tables, the full-tick displacement measured on an
  adversarial fixture, and a static check that every engine call site owns its result buffer.

### Changed

- **The simulation is ~20% faster at 1000 units, with byte-identical results.** Two changes to
  the broad phase, both verified against pristine `main` by comparing full `entitySnapshot`
  fingerprints over four workloads — all four identical, so no replay or balance outcome moves.
  - The grid's query box was padded by a `-1`/`+1` ring of cells. That ring exists to cover how
    far a unit can move between the grid being built at the top of `tick()` and a query reading
    it, but at `CELL = 96` it applied a 96px pad to every query in the game. How stale a bucket
    position can be depends on WHEN in the tick you ask, so the pad is now two named constants:
    queries inside the movement pass (`PAD_MOVE_PHASE`, 32px) can only be one movement step
    stale, which `stepToward` caps at 7.0px for the fastest hull with the largest multipliers in
    the game; everything after the separation pass keeps the full 96px (`PAD_FULL_TICK`).
  - Every hot candidate loop now rejects on squared distance before paying for a `Math.hypot`,
    which was the single largest cost in the sim. Survivors still take the original exact test,
    and the cheap test is widened by `REJECT_SLACK` (1e-4, twelve orders of magnitude above any
    float disagreement between the two) so it provably cannot discard a pair the exact test
    would have kept.
- **`queryNeighbors` takes a caller-owned result buffer.** It used to return one shared
  module-level array, safe only by a convention six call sites had to keep. `acquireTarget`
  already bent it — it hands its candidate list on to `spreadEnemy` to iterate — so any
  neighbour lookup added under that loop would have overwritten the array mid-iteration, and the
  symptom would have been silently wrong targeting that no determinism test could see. Each call
  site now owns its buffer, for the same zero garbage, and a static guard fails the build if a
  new one forgets.

- **A production or build command now reports whether it actually landed, and why not.**
  `queueProduction` returned an empty success even when the engine had refused, and since ore is
  only debited once a job starts, nothing observable distinguished "queued" from "silently
  dropped" — an agent re-sent the same order. It now returns a receipt
  (`{building, unit, queueIndex, queueLength, etaSeconds}`) on success, and a real rejection
  carrying a `reason` (`cannot-afford`, `prereq-not-met`, `supply-capped`,
  `building-cannot-produce-this-unit`, …) when the engine says no. `build`'s `refused` carries the
  same kind of `reason` (`invalid-placement`, `cannot-afford`, `prereq-not-met`, …) instead of
  leaving a caller to probe placement offsets blindly.

- **The Odyssey's living galaxy is now bounded to three background worlds, drawn from the seed.**
  `createGalaxy` used to instantiate and simulate all 11 worlds from turn one; it now brings up
  your start seat plus a pseudo-random draw of `BACKGROUND_WORLDS` (3) others
  (`backgroundWorldIds`, keyed on the galaxy seed and the start world), so which neighbours are
  alive is part of what a seed means rather than "all of them, always". The rest of the roster
  stays **dormant**: still on the starmap, still jumpable, still a full skirmish map — it's
  generated on arrival, exactly as a never-visited destination always was, and simulates from then
  on like any world you've left. The background scheduler, the galaxy-wide sweeps and every save
  therefore carry a handful of worlds instead of the whole roster. Same seed still replays the
  same galaxy. The faction-spread sweep still flies claims across the *whole* starmap, and a
  dormant world now takes the colours it was claimed under when it's finally built in.

### Fixed

- **Every jump button in a Spaceport's panel read "· your colony" and showed no fuel cost.** The
  label asked whether the destination's state existed, which the living galaxy made true for every
  world from turn one — so worlds you had never set foot on advertised themselves as held colonies
  and hid their real (nonzero) price. It now reads the cost `jumpCost` actually charges, which is
  free exactly for a world you've reached before or still hold a base on.
- **A first jump to a world with no state yet skipped the landing-site picker.** `initiateJump`
  treated a missing destination state as "shouldn't happen" and fell straight through to the jump,
  landing at the world's fixed generation-time anchor instead of letting the player pick a spot on
  the blind minimap. It now previews the destination (`previewPlanet`) to draw the picker, without
  waking the world: opening the modal — or backing out of it — leaves a dormant world dormant.
  Observer Mode's free look at "any world, discovered or not" shows the same read-only preview for
  a dormant world rather than silently doing nothing.

- **The Competition screen's 🧬 AI Editor tab was a blank screen.** Its "Start from:" row read
  `engine/aiStrategy.js`'s `STRATEGIES` table, which `competition.js` deliberately never imports —
  so opening the tab threw `ReferenceError: STRATEGIES is not defined` before a single control was
  built, and because `refreshCompView` empties its wrapper before calling the screen renderer, the
  result was an empty pane. The seed buttons now read `setup.js`'s `STRATEGY_OPTIONS`, the same
  table the rest of the module already uses for strategy names; the four seeds and their labels are
  unchanged. `npm run smoke` now clicks through all six Competition tabs and fails on any tab that
  raises, naming the tab that broke.

- **A world you had fought over came back from a save quoting different prices.** `createMarket`
  derives each raw commodity's equilibrium price from its share of *every* node on the map, and
  runs exactly twice in a world's life: at creation, and again on load. Wreck (`engine/wreckage.js`)
  and crater (`engine/bomb.js`) nodes are pushed onto the map *during play*, and the loader restores
  them before recomputing — so the reload derived the book from a strictly larger node set than the
  live one was built from. Because the share is a fraction of the total, this moved **every** raw
  commodity's price, not just the debris's own, and drifted further the more wreckage a world had
  accumulated (measured: radioactives 27 → 34). `createMarket` now skips wreck and crater nodes, the
  same exclusion `worldHasCommodity` already applies for the same reason. No live behaviour changes
  — there is no debris at world creation — and no save-format change: it simply makes load reproduce
  creation, and reload agree with what play already did (wreckage does not move prices mid-game).

- **A conquered colony reported `income: 0` on the starmap while it was paying you every second.**
  `galaxyStatus` decided a world's label and its income in one `if` chain, and the `pacified` arm
  short-circuited before the income line — so a world you had conquered *and* colonised showed
  nothing, which for a well-built world could be your best earner. `sweepColonies` pays such a world
  both halves additively (its buildings' passive income **and** the occupation dividend), and the
  reported figure now mirrors that ledger exactly, dividend included — which also surfaces
  `PACIFIED_INCOME`, previously invisible in the reported income of *any* world. "Pacified" still
  outranks colony/contested as the label; the active seat still reports nothing, because
  `sweepColonies` skips it.

- **`snapLandingPoint` was not idempotent: snapping its own output moved the point.** It rounded a
  click onto the 160-unit grid and *then* clamped it to a 100-unit margin — not a multiple of the
  grid — so the whole edge band collapsed onto an off-lattice 100 that re-snapped to 160: 161 of the
  1601 x-values on a 1600-wide map. The natural way to build a landing UI ("snap to show where
  you'll land, then send that point") therefore landed 60 units from the ring the player was looking
  at, with nothing on screen to say so. A click now resolves to the **nearest allowed landing site**
  instead, which makes every output a fixed point. The set of reachable sites is unchanged — the
  margin ring, the grid points between, and the far margin, exactly what round-then-clamp already
  produced — so **no landing area is gained or lost and no balance changes**; only which click maps
  to which site moves, and only inside the edge bands, where a click now resolves to the site
  genuinely closest to it (x = 90 lands at 100, where it used to skip out to 160). The site list is
  exported as `landingSites(map)` so a picker can offer the real sites rather than assume the bare
  grid — which near an edge would be 60 units wrong.

## [1.1.0] — 2026-08-08

Everything below shipped since 1.0.0. Save formats are unchanged (`SAVE_VERSION` 1,
`GALAXY_SAVE_VERSION` 1), so saves written by 1.0.0 load unchanged.

### Added

- **Observer Mode — a free-look spectator over the Odyssey galaxy.** Press O (or the topbar's
  🔭 Observe button) to watch how the AI archetypes develop and interact, like a scientist
  running the simulation and just watching: fog is revealed on whichever world you're looking
  at, the Galaxy map becomes a free camera jump to ANY world — discovered or not, no fuel, no
  Spaceport, no change to your real seat — and Space cycles every base on that world, including
  a neighbour's, not just your own. A live stats panel reads the spectated world's archetype,
  strategy, diplomatic stance and hostility, army composition by owner and type, buildings and
  development score, supply, and resources — all data the engine already computes, just newly
  surfaced. Mouse and keyboard orders are disabled while observing (this isn't your world to
  command); Escape or a second O press returns you to normal play exactly where you left it —
  observer.js never touches `state`, `galaxy.activeId`, or the real camera, so nothing about a
  spectated world's simulation changes because you looked at it. The first of three planned
  layers (observation now; a history/analytics view and live experimentation controls — changing
  a world's archetype/difficulty on the fly, controlling sim speed — are follow-ups, not yet
  built).

- **Patrol orders.** Combat and scout units can now be sent on a looping attack-move circuit
  instead of going idle at the end of a waypoint chain — select a unit with an existing move/
  attack-move order queued and press R to convert it into a loop.
- **The counter-triangle is finally visible where it matters.** Attacks that land a hard counter
  (Skiff on Lancer, Bastion on Skiff, Lancer on Bastion, a Breacher on a building) now draw a
  hotter, thicker tracer and impact flash, and unit tooltips and selection rows spell out what
  a unit is strong or weak against — derived straight from the data, not hand-written. Every
  weapon also got its own tracer shape and a muzzle flash, instead of one shared red line.
- **Gatherers no longer idle when a node runs dry.** They now roll onto the nearest same-
  commodity node you've discovered, the same self-healing the AI already had. Node saturation
  (too many workers on one seam) is now visible too — a ring on the map and a line in the panel.
- **Doctrine research now takes time to develop** instead of landing the instant it's paid for,
  scaled by the world's tech rating — a Refinery mid-research is a raidable window, and Bulwark's
  structure shielding (it already reduced damage to turrets and buildings, not just units) is now
  documented and tested rather than an accident of how damage math was written.
- **Odyssey: pick your starting world, or reroll it** — a card row like skirmish's, instead of
  always landing on a random one. Asymmetric skirmish worlds (Oort, Nimbus) also get a side-swap
  toggle so either half of the matchup is playable. Starmap nodes now show a world's deposits and
  rule modifiers before you jump, not just after you land.
- **A reactive opening checklist** replaces the old static 30-second objectives banner — it tracks
  what you've actually done (workers trained, a Barracks up, a doctrine picked, a Habitat raised)
  and checks items off live.
- **The clock is an honest, configurable endgame now.** The final five minutes flip the elapsed-
  time readout to a countdown with a live two-sided score bar, the post-game screen tells you the
  *real* reason the match ended (elimination vs. the score tiebreak — it used to claim the enemy's
  last Command Center fell even when a timeout decided it), and skirmish setup gets a Quick/
  Standard/Marathon match-length option.
- **The Leviathan has a real hull.** The endgame flagship used to fall through to the generic
  fallback silhouette; it now has a bespoke twin-spine capital-ship render befitting the biggest
  thing you'll ever build. A new full-roster render smoke test guards every unit and building type
  against silently falling back to a generic shape again.
- **A fourth AI archetype, the Technologist,** gives Kybernet — the Odyssey's research-capital
  world — its own small, teched-up elite-army temperament instead of playing as a generic
  Economist, and is the first archetype whose mix ever fields the Colossus.
- `tools/ailab.js` (the AI bench) gained a `tech` sparring opponent that climbs the Foundry/
  Arsenal gate and fields a real Tier-2/3 composition instead of Skiffs only, and a `--apm`
  flag so a probe can exercise a difficulty row's real APM throttle instead of always running
  unthrottled.
- **The AI reads what kind of game you're playing, and answers it.** It now keeps a running,
  fog-limited picture of you — how much of your investment went into army versus economy, as far
  as it has actually *scouted* — and acts on it. Play greedy and undefended and it will come for
  your worker line instead of grinding your front door; mass an army and it walls up instead of
  wasting ore on turrets it doesn't need. This is the first thing the AI believes that can be
  **wrong**: kill its scout and its picture of you goes stale, which makes denying it vision a real
  counter-play rather than a formality. Its stance is deliberately damped so it stays *legible* —
  you can notice it turtling and respond — and Easy never adapts at all, keeping the predictable,
  learnable opponent a new player needs. Adaptation changes tempo and targeting, never identity: a
  Rusher still rushes.
- **Play against yourself.** After any match, "Save an AI that plays like you" measures what you
  actually built — economy versus army, your unit mix, how far you expanded, whether you walled —
  and fits an AI genome to it. Import it from the Competition roster and duel it. Your own army,
  read back in the order you leaned on it, becomes the AI's production cycle. Roster entrants can
  now carry a genome of their own rather than only naming one of the four shipped strategies, so a
  bench-bred AI and a player-made one are the same thing and neither needs converting.
- **The AI opponent can now be EVOLVED** — `node tools/ailab.js evolve` breeds a population of
  AI "genomes" (`tools/genome.js`: the dial tables as a schema'd, mutable, crossable data
  structure) and selects them by real head-to-head self-play, with the four shipped strategies
  riding along as a fixed rating anchor. Mutation is per gene *kind* — multiplicative for
  ratios, additive for headcounts, rare flips for the switches that decide whether other genes
  mean anything, and sequence operators for the unit-mix production cycle — and crossover cuts
  at the boundaries between functional modules (offense / economy / defense / composition), so
  a child inherits a working sub-plan intact rather than a shredded one. Nothing under
  `engine/` changed: a candidate AI was already just JSON, which is what makes this possible at
  all. Design, traps and results: `docs/ai-evolution-design.md`.
  Two supporting fixes fell out of building it, both of which had been silently wrong:
  `runDuel` never forwarded a candidate's own archetype to the match runner (so a CLI duel gave
  both seats the *world's* temperament and ignored the candidate files), and `duelSeed` hashes
  the candidates' names, so generated names drew their own map set every generation — it now
  takes an optional `seedKey` to pin one, with today's derivation unchanged when it's omitted.

### Added

- **A 150 rung on the Population cap**, below what used to be the tightest setting. It's there for
  frame rate rather than balance: the cap bounds both sides' armies *and* the housing that feeds
  them, so it's the one setting that bounds how many things exist at all. Measured on the heaviest
  world the improved AI produces — a 60-minute Ferros Odyssey, timing one simulated minute at the
  end — a capped-at-150 world holds 100 units across 39 buildings and simulates ~12× faster than an
  uncapped one, which reaches 563 units across 166 buildings. Pick it if you want the galaxy to stay
  responsive; Max is still the default and still uncapped.

### Changed

- **Odyssey neighbours now actually grow, because they can finally afford to.** Every archetype
  gets an Odyssey worker crew about half again as large as its skirmish one (Rusher 6→9, Economist
  11→17, Technologist 7→11, and Balanced — which had no Odyssey overlay at all — 6→9), which fixes
  a bootstrap the AI could never start on its own. Its worker target only ever grew by "two haulers
  per factory you own", a reward for industry it had to already be rich enough to have built; on a
  strategy that also spends freely on units, unit production took every ore first and the loop
  never began. A neighbour on Ferros sat on development 3 and thirteen workers for a full forty
  minutes while the *same* archetype behind an army cap reached development 27. Measured over 176
  runs across all eleven worlds at Medium and Hard: the `dev-flatline` defect halves (25 → 12) and
  `hostile-but-idle` drops from 9 to 3. Skirmish matches are byte-identical — this overlay is only
  read when a world has diplomacy.
- **The Aggressive strategy now funds its own aggression.** Head-to-head, the four strategies
  played against *each other* rather than against a scripted bot, it was the worst of the four at
  Medium — 25W-47L, last place, against the Economic strategy's 51W-21L. Its offense dials weren't
  the problem (attacking with bigger waves or a fatter home guard barely moved it); it simply had
  no economy to follow up an early push with. It now carries the same worker investment its
  toughest rival does, which takes it to 53% at Medium and 54% at Hard — second place in both.
- **The AI's counter-pick logic is unified and sharper.** It used to go blind the moment your
  army's dominant type fell outside the Skiff/Bastion/Lancer triangle (a massed Breacher,
  Dreadnought, Wraith, Aegis, or Colossus army drew no reaction at all), and it never once
  factored in static defense — the test suite already proved a turret wall was fully
  uncounterable. It now falls back to each unit's documented cost-efficiency answer when it has
  no hard counter, and reads a turret wall the same way it reads an army, answering with
  Breachers once the wall is the bigger threat. Difficulty now shapes *how* it counter-picks, not
  just how fast: Easy never counter-picks (a learnable, exploitable army), Hard reacts nearly
  twice as often as Medium.
- **A graduated Hard Rusher now actually re-arms for the tier it graduated into.** It could
  already climb the tech ladder all the way to a Leviathan while its Barracks kept cycling
  Tier-1 Skiffs and Bastions forever; its unit mix now extends alongside its industry.
- The Helium Bomb's blast radius is now measured to a target's rim instead of its center, so the
  header's claim that it can one-shot even the Antimatter Gate is finally true at point-blank
  range instead of geometrically impossible; the AI also no longer detonates its own offensive
  bomb short of the kill band. Its offensive delivery now travels inside an actual committed
  attack wave instead of walking in alone to be shot down before it arrives.

### Fixed

- **The adaptive AI actually remembers what it scouted now.** Its opponent belief was documented
  to fade in a straight line over four minutes, but the code faded the stored value and wrote the
  faded number back, then re-faded *that* from the same timestamp on the next think cycle. The
  decay compounded once per cycle, so at the AI's real 1.5-second cadence a four-minute fade
  emptied in about sixty seconds — and because confidence gates everything downstream, the whole
  adaptive layer sat pinned at neutral the moment the enemy left vision. Scouting bought almost
  nothing and `adaptDefenceMult` returned 1.0, identical to having no adaptation at all. The peak
  is now immutable and the fade is computed at read time from elapsed time, so it is the straight
  line it always claimed to be, at any think rate. Military and economic belief also fade on
  separate clocks: a worker parked in view used to keep re-dating the *military* estimate, holding
  up the AI's read of an army that had long since walked away.
- **`npm run typecheck` passes again**, and CI pins the compiler version. Two JSDoc signatures in
  `competitionLedger.js` were wrong — `addRosterEntry` never declared the `genome` field it reads
  and writes, and `recordCompetition` typed its match rows as bare `object`. The build had been red
  since 2026-08-05. CI also installed TypeScript unpinned, so the same source reported 2 errors
  under 5.7 and 21 under 7.0.2; the invocation is now pinned so a compiler release can't turn a
  green commit red on its own.
- A worker whose gathering node hit exactly 0 mid-carry could strand its last partial load
  forever (never banked); this is now rare in practice, since the same fix that stops gatherers
  from idling at a dry node also gives it somewhere to carry the stranded load — the fully-idle
  fallback path can still lose it.

Twenty-one improvement proposals from `docs/improvement-proposals.md`'s Tier 1 and Tier 2 (per
`docs/improvement-roadmap.md`'s phased sequencing) shipped in this batch, built by parallel TDD
teams sharing one working tree. One of those changes (timed doctrine research) measurably deepens
an already-documented, deliberately-unfixed AI weakness — `docs/odyssey-ai-review.md` §2.9 has the
details and the repro.

### Added

- **Formations now rank by weapon range.** A wedge or line used to interleave whatever you selected
  in whatever order you clicked it; short-ranged units (Bastion, Skiff) now screen the front of a
  shaped formation while long-ranged ones (Lancer, Breacher, Colossus) trail behind, and an unarmed
  support unit (the Mender) sinks to the rearmost slot of all instead of leading the charge. The
  legacy grid-shape spread and the AI's own formation calls are untouched.
- **Per-building logistics priority.** A high/normal/low cycle on any factory or power station's
  panel now weights the auto-haulage scans toward (or away from) that building — high halves its
  effective distance and lifts its hauler/server cap by one; low quadruples its effective distance
  — instead of the previous flat nearest-first-with-a-hard-cap assignment being the only lever.
- **Bulk trading.** The Market panel gained Sell ×4 and Sell All buttons (quoting the real marginal
  proceeds before you click) alongside the original single-lot button, plus a trend glyph per row
  that tells a briefly-depressed price apart from a deep, slow-draining glut.
- **Grid Substation** — a cheap Odyssey-only relay that extends power-grid reach one hop from an
  active source, so an expansion's factories no longer have to sit inside one dense power blob or
  buy a whole second fuel-burning station just to stop paying the distance tax.
- **Gifts and favor requests give diplomacy an actual road to Allied.** Tribute still only buys a
  truce; you can now hand a neighbour commodities to build lasting goodwill (with diminishing
  returns, so one dump can't buy friendship outright) and fulfill occasional favor requests for
  credits and stance — and an Allied world's market spread tightens, so alliance finally pays for
  itself instead of being a HUD word nothing reads.
- **Bigger maps grow a contested middle, not just distance.** Large and Gigantic worlds now seed a
  mirrored frontier belt of full-size deposit clusters in the map's contested band, one extra belt
  per size step, instead of the same near-base economy stretched over a larger empty map.
- **High ground now extends weapon range, not just sight.** A unit or turret holding a mesa or ridge
  could already see farther than the README promised — it can finally shoot that far too.
- **Attack pings on the minimap**, plus a Backspace hotkey that jumps the camera to the most recent
  one — a raid on a far flank used to be findable only within the under-attack banner's few-second
  window.
- **Space now cycles through every base** on repeated presses instead of always landing on the
  first Command Center, and a new topbar chip surfaces idle production buildings the same way the
  idle-worker chip already does.
- **Alt+click / Alt+drag subtracts from the current selection**, and Ctrl+double-click extends
  select-all-of-type to the whole map instead of just the visible viewport.
- **A Tech & Industry Chart overlay (hotkey T)** finally makes the unlock ladder visible in-game —
  every building, unit gate, and tech node as tier columns, colored by whether it's built,
  affordable now, or locked (with its full prerequisite chain spelled out), with a link to the full
  field manual that was previously linked from nowhere in the app.
- The landing picker now charts the destination's rough and high terrain from orbit instead of
  showing nothing but fog — you still can't see deposits, units, or the fog state, only the ground.
- **Research can be canceled for a full refund**, at the Datacenter or the Refinery, instead of a
  mis-click stranding the cost until completion.
- Reactor, Combustion Generator, and Biomass Reactor get bespoke hull art instead of sharing one
  generic hexagon, and a running factory now shows a subtle work pulse — previously a humming base
  and a dead one looked identical.
- **Autosaves now keep two generations.** A corrupted or interrupted write used to mean losing an
  entire Odyssey campaign; loading now falls back to the previous generation automatically, and
  three consecutive save failures surface a one-time warning instead of failing silently forever.

### Changed

- Heavy Alloys now only boosts the Smelter and Assembly Plant it advertises, instead of silently
  boosting every recipe building in the game including the Antimatter Forge and AI Foundry.
- **A standing Foundry and Arsenal now speed up military production** (~8% each) instead of going
  inert the moment their gate is unlocked, so they're worth defending and raiding past that point.
  This applies through the same shared production code both sides use, so it retunes Tier-2 tempo
  symmetrically for the player and the AI alike — worth knowing if a build or matchup suddenly
  feels faster-paced than before.

### Fixed

- A shaped formation's range-ranking fallback for a unit with no declared weapon range sorted it to
  the *front* of the formation instead of the rear — harmless for most of the roster, but it put
  the unarmed Mender in the most exposed slot of all, backwards from the point of a healer.

Seventeen more proposals from Tier 2 of `docs/improvement-proposals.md` shipped in this batch (per
`docs/improvement-roadmap.md`'s Phase 3), again built by parallel TDD teams sharing one working
tree. Every team that hit an unexpected test failure this round verified it against a clean
baseline instead of assuming it was unrelated — one real, fully-anticipated interaction (the
Foundry/Arsenal tempo change above, applied to a fixed-seed AI bench test) surfaced this way and
was fixed at the test, not the feature.

### Added

- **A second static-defense tier, the Bastille.** One turret type used to serve all four tiers;
  a Foundry-gated heavy emplacement now sits alongside it — tankier and harder-hitting, but
  deliberately shorter-ranged than the plain Sentinel Turret, so siege units still crack a
  turtled base exactly as before. The AI fortifies with it too, once it has a Foundry standing.
- **An Arsenal-gated guard-aura projector, the Aegis Bastion.** Every siege unit in the game
  already outranges static defense by design, so the late base had no way to hold longer except
  with an army. This building doesn't change that — it still can't stop a Breacher, Colossus, or
  Leviathan from shelling it out of range — but every friendly unit *and structure* inside its
  bubble takes 20% less damage, buying the defender time by attrition instead of range.
  Odyssey's charging Antimatter Gate finally has a buildable bodyguard.
- **The Plasma Torpedo Battery**, the endgame's first real static defense: an ammo-fed structure
  that only fires while workers keep it stocked with plasma torpedoes hauled in the same way a
  Reactor's fuel larder is fed — real logistics, not a free-fire tower. It out-ranges the
  Breacher, so an early siege tool alone isn't enough by the Strategic tier, but the Colossus and
  Leviathan both still out-range *it*, so a battery line stays crackable, just not for free.
- **Colossus splash damage** — the game's first area-damage weapon outside the Helium Bomb. A
  hit now rattles enemy units caught near the impact point too, falling off with distance, so
  spreading out against artillery is finally a real defensive answer instead of having no effect
  at all; a cost-parity Skiff swarm still beats a Colossus head-on, splash included.

Four proposals from Tier 2/3 and the Strategic tier of `docs/improvement-proposals.md` shipped in
this batch (per `docs/improvement-roadmap.md`'s Phase 4) — the smallest phase so far, and the one
the roadmap gated on Phase 2's AI counter-intelligence work landing first, since the test suite
already proved a turret wall was uncounterable before that. The three new static-defense
structures were built by one team as a single rationalized tier rather than three independent
additions, keeping one balance invariant intact throughout: every siege unit still strictly
out-ranges every static-defense structure (with the Torpedo Battery's out-ranging-the-Breacher-
specifically as the one documented, deliberate exception). No regressions surfaced this round.

### Changed

- **The Assault and Bulwark doctrines now go three tiers deep, matching Logistics.** Both used to
  plateau at Tier 2 as a repeated flat percentage with no new decision attached. Assault's Tier 2
  now also grants a "combat drive" — armies close distance on a fleeing target 10% faster — and
  its new Arsenal-gated Tier-3 capstone, Overdrive Actuators, adds a distinct tempo identity on
  top (10% faster attacks). Bulwark's Tier 2 now heals role:combat units out of combat once
  they've gone unhit for a while, and its capstone, Self-Sealing Plating, doesn't just repeat that
  grant — it heals faster and kicks in sooner, a genuine deepening rather than the same number
  again. A unit under continuous fire still never benefits from either tier, so nothing about
  existing combat balance changed.

### Added

- **Freight Lanes**: assign parked freighters at a Spaceport to standing shipping routes between
  held worlds, and they move goods on a schedule from then on — no more personally flying every
  load between colonies. A lane-assigned ship is physically present and raidable, not free
  teleportation; it can't jump-board with the rest of the fleet while committed to its route.
- **Colony standing orders**: set a policy on a Command Center before you jump away from it —
  auto-sell surplus above a floor into that world's own market (priced with real slippage and
  glut, on top of the existing flat background income, never replacing it), and sustain the
  colony's own workforce so an unattended world's idle workers keep gathering and its population
  keeps growing instead of the queue running dry the moment you leave.
- **Spaceport tiers now discount new-world jump fuel** (up to 30% at Tier 3), not just the supply
  a jump can carry — upgrading the pad is a genuine choice now, not a niche army-ferry knob.
- **A trade-industry branch** opens a second, genuinely independent path up the Odyssey tech
  tree: a Chemical Plant (biomass → chemicals, no ore or Smelter needed at all) and a Fabricator
  (alloys + chemicals → consumer goods) turn agri-world deposits into a real credits engine for
  fuel, tribute, and freight — an alternative to climbing the strategic-goods spine, not a
  detour off it.
- **The starmap now shows which colonies need attention.** Worlds badge as under attack or
  fallen based on real, recent events instead of a toast you might have missed, and every world
  you hold shows a live garrison line (Command Centers and army supply) right on the map.

Four proposals from the Odyssey/Economy/Tech dimensions of `docs/improvement-proposals.md` shipped
in this batch (per `docs/improvement-roadmap.md`'s Phase 6) — the largest and most
determinism-sensitive workstream in the roadmap, since Freight Lanes and Colony standing orders
both run inside the background galaxy simulation the determinism suite replays byte-for-byte.
Three teams worked concurrently in one shared tree with real, sustained file overlap (all three
touched starmap.js; two touched hudSelection.js) and every team isolated its own commits with
`git add -p` rather than a broad add. No regressions surfaced this round.

### Added

- **A rival faction can now race its own Antimatter Gate.** Until now the galaxy-win threat only
  ever pointed at the player — a neighbour that reaches the Strategic tier and banks a real
  goods buffer (gated to Hard difficulty, or a patient temperament, so it stays an event) can now
  raise and charge a Gate of its own. Razing it mid-charge costs them the whole investment, same
  as it would you; letting it finish doesn't end the game (nothing does) but marks the galaxy as
  changed — that faction claims its unclaimed neighbours in one burst and its worlds turn
  permanently colder toward you.
- **Conquest finally means something.** Pacifying a neighbour by razing its capital now actually
  sticks — a "Conquered" world can rebuild and defend itself, but it can never be dragged back to
  war again, and it quietly pays a small tribute for as long as you hold it. Domination sprees
  also have a cost: pacifying one world of a faction echoes a bounded, temporary chill onto its
  unpacified faction-mates, while an Allied world warms its faction-mates' standing a little in
  return — the "living galaxy" reacts as a body politic for the first time.
- **A persistent Gate charge strip** shows your charging Antimatter Gate's progress right on the
  HUD at all times, warming in color as it climbs and flipping to a stalled look the moment
  something (starved feed goods, throttled power) stops it from advancing — no more finding out
  only from a 25%-milestone toast, or by keeping the Gate selected.
- **An Easy-difficulty neighbour now stays gentle at the endgame.** Its industry climb stops
  before the Strategic tier, so a long Odyssey session on Easy never ends with a 900hp Leviathan
  and a doomsday bomb from a neighbour who was supposed to be the forgiving one.

Four proposals from `docs/improvement-proposals.md` shipped in this batch (per
`docs/improvement-roadmap.md`'s Phase 7) — a deliberately curated slice of the catalog's
Gate-adjacent proposals rather than all of them, per the roadmap's own monoculture warning. The
Rival Gate merges two independently-written proposals that converged on the same feature from
different angles; integration caught and fixed one real interaction between it and Domination's
new pacification floor (an ascended-then-conquered world could get stuck fighting itself between
the two effects forever) before either shipped.

### Added

- **High ground now grants real concealment, not just a sight bonus.** A unit standing in the
  lowland used to reveal a mesa top exactly as easily as open plain and could shoot at anything
  it could see up there; now a source that isn't itself on high ground reveals — and can acquire
  targets on — high ground only within a fraction of its normal range. Climb the ridge, take the
  vantage yourself, or push in blind. Applies identically to the AI's own fog, so a held ridge is
  a real objective for both sides.
- **Veteran units are stronger, and you can see it.** Every kill now counts: survive enough
  fights and a unit gains small chevrons over its health bar along with a permanent damage-dealt
  bonus and damage-taken reduction. Pulling a bloodied army back to repair and re-field it is now
  strictly better than re-buying it from scratch — for both sides equally.
- **Deaths finally carry weight.** A Worker popping, a Dreadnought going down, and a Command
  Center cracking now look and sound like three different kinds of loss instead of the identical
  280ms ring and tone every death used to get — bigger hulls get bigger death flashes, debris,
  and a deeper, longer boom; buildings collapse in a slower double ring.
- **A commodity flow ledger on the topbar** shows net rates, not just stock — hover any resource
  to see whether it's climbing or draining and how fast, and a commodity flashes red when it's
  both net-negative and something currently live (a fuel-burning station, a charging Gate)
  actually depends on it running dry.
- **The main view no longer redraws fog and terrain one cell at a time.** On a fully-zoomed-out
  Gigantic map this was up to 16,000 individual fills every frame; terrain is now a cached
  offscreen image blitted once per frame, and the fog wash merges each row into a handful of
  spans instead of thousands of individual cells — same look, a fraction of the cost.

Five proposals from `docs/improvement-proposals.md`'s Cross-tier section shipped in this batch
(per `docs/improvement-roadmap.md`'s Phase 8) — **the final phase of the improvement roadmap**.
The fog-render performance work was sequenced to land only after the LOS pass, since it depends
on exactly the fog-cell contract that change produced.

- **How long a neighbour holds a grudge is now part of its personality.** Souring was already
  flavoured by temperament — a Warlord world turns on you twice as fast as a patient one — but
  *cooling off* was identical everywhere, and once you had drawn blood a neighbour stayed
  primed against you for the rest of the session. A new `forgiveness` dial drives both halves of
  that cooldown: how fast a soured stance drifts back up, and how long the world keeps treating
  you as an active aggressor. It composes across world × AI Strategy × difficulty and is bounded,
  so the spread runs from about 17 minutes of grudge on an Aggressive Warlord world at Hard down
  to about 2 on a patient trading world with an Economic opponent on Easy. Souring is untouched —
  a personality that forgives slowly does not also turn hostile slowly. A charging Antimatter Gate
  still provokes for as long as it charges, whatever the memory says, and every fresh loss re-arms
  the clock so a running war never quietly cools off underneath you.
- The Refinery, Foundry, and Arsenal no longer double as forward resource drop-offs — they're
  ore-tech buildings only now (Refinery for doctrine research, Foundry/Arsenal as Tier-2/Tier-3
  gates). All gather and haul traffic runs straight to a Command Center; the AI no longer plants
  additional Refineries out at far ore seams as decentralized collection points.

### Fixed

- **The Odyssey AI no longer freezes solid in a long session.** Its Habitat trigger was sized for
  a 2-supply unit while the Odyssey roster has 4- and 8-supply ones, and the unit-mix cycle retries
  the same entry until it succeeds — so a developed neighbour could wedge permanently with an empty
  production queue and tens of thousands of unspent ore. The supply margin is now sized from what
  the AI is actually trying to build, supply already under construction is credited, and Habitats
  are placed at any of its Command Centers rather than only the capital.
- **The AI develops on worlds where it never used to.** Unit production ran before industry with no
  ore held back, so a cheap-unit archetype spent itself below a Reactor's cost every think cycle and
  never built one; Hard's rusher graduation landed roughly 30 minutes past its own trigger. A
  bounded bootstrap reserve now banks for the power grid and the first two factories.
- **A rich neighbour spends its income instead of hoarding it.** Sustained surplus opens extra
  Barracks, and — for strategies that cap their standing army — funds a colony ship regardless of
  home depletion, so the build order no longer terminates in a mode that doesn't.
- **A neighbour dragged to Hostile can now act on it.** The Economic and Force Parity strategies
  could never attack under any circumstances, and Odyssey hands one of them to roughly half the
  galaxy's worlds — so half a galaxy read "Hostile" and never sent anything. In Odyssey those
  strategies now mean "doesn't start fights": they still answer a player who has destroyed their
  ships or begun charging an Antimatter Gate. Skirmish behaviour is unchanged.
- **The opening grace window can't collapse any more.** The archetype, strategy and difficulty
  grace/grievance multipliers all compounded, cutting the documented 7-minute window to under 40
  seconds on an Aggressive + Hard combination the setup screen offers directly. The layers still
  compose; they're now bounded.
- A neighbour deploying its own colony ship (or triggering its own Helium Bomb) counted as you
  destroying one of its ships, so it soured its own stance for founding a colony.
- **A very dense, long-idle same-owner army no longer spikes CPU when its background world
  ticks.** Profiling a real save (reported as high sustained CPU usage) traced it to one Odyssey
  colony that had accumulated a 642-unit standing army over about 70 minutes with nothing to
  spend it on, almost all of it piled within a few grid cells of its rally point — the broad-phase
  neighbor query `applySeparation` uses scales with *local density*, not army size, and 30+
  same-owner units sharing a cell meant a single tick there ran up to ~94ms, ~15ms of it in
  separation alone. `applySeparation` now bounds how many candidates it resolves per unit per
  call; the scan window rotates by the unit's index and the simulation tick, so a huge pile still
  fully settles over time instead of some units being permanently skipped over. Ordinary battles
  never come close to the cap, so this is unobservable outside a pathological pile-up — on the
  profiled world it cut the separation phase by ~74% and the whole tick by ~40%.

### Added

- `tools/ailab.js` — a headless bench for the Odyssey AI. Runs the real sim for 30–60 sim-minutes
  per world (seconds of wall clock), drives the player side with scripted sparring bots, and
  scores the opponent on development / growth / pressure / thrift / liveness / survival. Candidate
  AIs are injected as JSON into the archetype, strategy and difficulty tables (`--overrides`), so
  the whole space can be searched without touching `engine/`. Subcommands: `probe`, `sweep`,
  `compare`, `search`, `check`. Four scripted sparring opponents, including a `skirmisher` that
  actually attacks.
- `docs/odyssey-ai-review.md` — a measured review of how the AI plays in Odyssey, with the
  findings the bench turned up (a supply deadlock that permanently freezes a developed AI, a
  terminating build order, a Rusher that never develops, and a non-initiating half of the galaxy),
  plus the tuning loop to run against them.
- `docs/improvement-proposals.md` — a full-game improvement catalog from a fanned-out review
  team: 71 proposals across nine dimensions (combat, economy, tech/industry, defense/victory,
  AI, Odyssey meta, worlds, UX, presentation/platform), each anchored to the game's progression
  ladder (T1 Opening → T2 Developed → T3 Advanced → Strategic Endgame, plus cross-tier), graded
  by effort and impact, and grounded in the exact files and functions a change would start from.
  A critic's pass over the whole set closes it out: duplicate proposals to merge, collisions to
  decide before scheduling (three dimensions independently patching `counterToPlayerArmy`, the
  free-vs-paid world-intel doctrine, Gate-charge economics), coverage gaps no dimension owned
  (scenarios, replays, post-match debrief, accessibility, audio, modding-by-data), and a
  twelve-item shortlist ranked on player impact per unit of effort.

## [1.0.0] — 2026-07-22

First tagged release. A complete, self-contained real-time strategy game plus an open-world
Odyssey meta-layer, with no build step and no runtime dependencies.

### Skirmish

- 1v1 real-time battles against a fog-limited scripted AI on one of nine charted worlds, with a
  fixed-timestep sim decoupled from render (render interpolation for smooth play on high-refresh
  displays).
- A rock-paper-scissors combat triangle (Skiff / Bastion / Lancer) plus the out-of-triangle
  Breacher siege unit; local-avoidance movement with a separation safety net.
- Economy with worker gather/haul, saturation-limited nodes, scouted resource caches, and a
  supply cap raised by Habitats.
- A real tech layer: Refinery mutually-exclusive Assault/Bulwark doctrines (each with a Tier-2),
  a Foundry tech gate, and Datacenter research.
- Terrain (rough ground and high ground) on six worlds, per-world rule modifiers, and two
  asymmetric matchups; a match time-limit score resolution guarantees a terminal state.
- Three AI temperaments (Rusher / Economist / Balanced) that scout, counter-build, expand,
  fortify, and attack in repeated waves.

### Odyssey (open-world meta)

- A galaxy of worlds you jump between via Spaceports, carrying universal credits and settling new
  worlds with colony ships; worlds you leave become background colonies that pay passive income.
- Per-world diplomacy (grace, grievance, tribute truces), a commodity market for funding jumps,
  and a play-forever design where progress is marked by fireworks/milestones (colonies founded,
  the Antimatter Gate coming online, conquest domination) rather than a hard win.

### Platform & hygiene

- Deterministic engine (`same seed ⇒ same game`) with purity and determinism guards; the whole
  sim runs headless under `node --test`.
- Versioned, sanitized saves (skirmish and galaxy), autosave to localStorage with file
  import/export, and an in-app update check.
- Zero-dependency local dev server (`npm start`), 560+ tests covering the engine, persistence,
  determinism roster sweep, and static integrity (syntax, DOM-id and import resolution).
