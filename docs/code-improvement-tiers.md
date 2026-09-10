# Code Improvement Tiers — a TDD-first plan from a full-codebase review

*This is the **code-quality** companion to [improvement-proposals.md](./improvement-proposals.md) (which
proposes changes to the **game**) and [improvement-roadmap.md](./improvement-roadmap.md) (which sequences
them). Nothing here changes a rule, a number, or a mechanic. Every entry is about the code that
implements them: a defect, a missing guard, a type gap, or a structure that made one of those possible.*

## Status

**Tier 1 is delivered.** All 42 items shipped across seven commits, each fix preceded by a test
verified red against the real behaviour, and the mutation-proven gaps re-checked by re-introducing
the exact defect. Suite went from **1,897 → 1,964 tests, still 0 failures**; `npm run typecheck`
stays clean; `// @ts-check` coverage went from **10 files to 20**.

Three things the work itself turned up, beyond the findings as written:

- The NET round-trip tests rejected a first cut of the save hardening that stamped `pacified: false`
  and `rally.nodeId: null` unconditionally. They were right: a hardening pass must be the identity on
  a valid save, byte for byte. Both now adopt only fields the save actually carries.
- `test/_helpers.js`'s header claims its fingerprints are "immune to Map-iteration / JSON-key order".
  True of `entitySnapshot`, whose tuples are joined in a fixed field order — but `galaxySnapshot`
  stringified diplomacy and market pressure raw, so identical values in a different insertion order
  read as a divergence. Another false comment, found the same way as the six in the table below.
- Adopting `// @ts-check` on `persist.js` surfaced a real asymmetry: `deserializeGalaxy`'s object
  literal omitted `lanes` while `createGalaxy`'s includes it, so a `Galaxy` was briefly missing a
  field its own typedef requires. Three further typedef drifts (`Building.rally.nodeId`,
  `Building.queue[].alt`, `Building.rivalAscended`) came out of the same pass.

**D5 (`strictNullChecks`) was evaluated and deliberately deferred**, as the item itself proposed:
turning it on today yields **198 errors** across the 20 checked files. That is a genuine project with
its own fallout, not a Tier-1 slice — it belongs after the Tier-2 structural work, when fewer of
those errors are in code that is about to be rewritten anyway.

The **silhouette-collision half of C6** also moves to Tier 2 as the plan intended: the test is cheap,
but it goes red until the Antimatter Gate and Torpedo Battery get distinct art, and that is an art
decision, not a code one.

**Tier 2 is delivered.** All 20 items shipped across five commits. Suite **1,964 → 2,002 tests**, 0
failures throughout; typecheck clean. Full-suite wall clock **2m17s → 1m34s**.

Three outcomes worth recording, because they changed the plan rather than following it:

- **The per-frame allocation item did not survive measurement.** Memoizing `shade`/`hexA` on
  `(hex, percent)` looks like an obvious win — tiny fixed key space, called per building per frame.
  Benchmarked on a 120-building, 306-unit frame it is a *loss*: garbage 51.5 → 62.2 KB/frame, frame
  time 0.22 → 0.24 ms, because the cache key is itself a fresh string per call. Reverted, with the
  numbers written at the function so the next attempt starts from a baseline instead of the same
  intuition. Only the loop-invariant hoist survived.
- **`tickSelfPlay`'s ordering was corrected in the comment, not the code** — the option the finding
  explicitly sanctioned. Making the claim true needs either a frozen pre-tick read or moving the
  `"ai"` call out of `sim.js`'s hardcoded pipeline; both restructure the tick contract, so they sit
  in Tier 3. The measured bound (one frame, one direction) is now pinned by a characterisation test
  so it cannot widen unnoticed.
- **Two fixes changed behaviour a test fixture depended on**, and both were retargeted rather than
  weakened: consolidating `radiusOf` broke `formation.js`, whose callers pass unit-shaped literals
  with no `kind` field (the helper resolves by type first, with a comment on why); and the
  name-based bye tie-break moved which Swiss candidate draws the bye, so a fixture's winner stopped
  fighting.

The **rebuild-signature co-location** is done to the extent Tier 2 allows: the 141-line expression is
now a named `panelSignature()` function rather than an inline block, which is the seam the Tier-3
panel registry moves into. Genuine per-panel co-location needs the decomposition itself.

**Tier 3 is delivered.** All seven refactors resolved across eight commits. Suite **2,002 → 2,051
tests**, 0 failures throughout; typecheck clean.

Every design question in the table below now has an answer, and three of them changed what got built:

- **The AI decision seam is "export in place", not a new `aiDecisions.js` leaf.** The helpers read
  `state` and `ctx` and belong with their phase; a module existing only for testability would have to
  import back into the layer it came from. Nine predicates are now exported and directly drivable.
  The 13-site build idiom did collapse — into `tryBuild`/`tryBuildAt` — once it was clear the two
  steps that fail *silently* are `canAct` and `spend`: omit the first and the AI ignores its APM
  budget, omit the second and it founds buildings for free. Neither shows up on the default
  archetype, whose `apm` is `null`, which is why five sites had already drifted to relying on a
  `canAct` three lines up. The builder stays a parameter, because two sites have always founded with
  `workers[0]` rather than the nearest free worker, and collapsing that would move the determinism
  fingerprint — a behaviour change, not a refactor.
- **The declarative save schema was evaluated and rejected, and replaced with the guard it was for.**
  Every field's sanitizer in `persist.js` is deliberately different (`popCap`/`matchTimeLimit` must
  *not* go through `num()`, since `Number(null) === 0` turns "no override" into "end the match at
  time 0"), and the comments explaining each choice are the most valuable thing in the file. A table
  would wrap that same bespoke logic in per-entry closures while the payload has to stay
  byte-identical: more risk, less clarity, no new safety. What the table was *for* — catching a field
  written by `serPlanet` and never read by `rehydratePlanet` — is now a payload-level round-trip
  comparison for the game save and the galaxy save alike, so the next such field fails immediately
  instead of resetting silently on load.
- **`hudSelection.js` split by "derive vs render", not by panel.** The registry the table proposes is
  still the destination, but the seam that mattered first was `panelSignature` — the panel's entire
  reactivity model, which decides whether it rebuilds *at all*. It and the derivations it shares with
  the renderers now live in `hudPanelSignature.js`, a genuine leaf outside the `hud → hudSelection`
  cycle: 2,242 → 1,915 lines, with the panel's output byte-identical, verified rather than assumed by
  the golden lock the table asked for (25 fixtures, committed one commit ahead of the first
  extraction).

Four things the work turned up that were not in the plan:

- **Three guards written during Tier 3 were vacuous on their first cut, and each was caught by
  mutation rather than by review.** The dead-import guard located the import block by walking lines
  until one stopped looking like an import — and since every file opens with a prose header comment,
  it broke out on the first sentence containing a bracket and reported a file with *twenty* dead
  imports as clean. The save round-trip guard's first mutation (a field defaulting identically on
  both passes) proved nothing, because both payloads agreed. The panel-fixture guard used a node
  count as a proxy for "the setup took" and flagged the Habitat, whose whole panel is legitimately
  two rows. The lesson is the same one Tier 1's mutation pass taught: a green guard is evidence of
  nothing until you have watched it go red.
- **25 dead imports in `hudSelection.js` alone**, twenty of them predating this work — `repairBtn`,
  `departBtn`, `saveBtn`, `pauseBtn`, `starmapBtn`, `resourcesEl`, `clockEl`, `scenarioStatusEl` and
  more, left behind by code that moved to `hud.js`. A dead import advertises a dependency that does
  not exist, so the import block misleads anyone reading it, and the module-reachability guard counts
  an edge nothing walks. The new guard found three more elsewhere (`aiWorkers`'s `UPGRADES`,
  `formation`'s `UNITS`, `input`'s `dragCamera`).
- **The DOM test double had grown to nine hand-rolled copies**, and the differences between them were
  not considered decisions — they were whichever subset of the DOM the file that copied it happened
  to need. `overlays`' copy tracked parents so `.remove()` really spliced and `hudSelection`'s did
  not; `hud`'s `querySelector` walked the tree and `update`'s was hardcoded to `null`; `observer`'s
  `getBoundingClientRect` returned a real 800×600 box and `saveload`'s returned zeros; `saveload`'s
  `appendChild` discarded its argument outright. A test written against a weak copy silently asserts
  less than the identical test written against a strong one, and nothing told you which you had.
  Consolidated into `test/_dom.js` with no assertion weakened — the two axes that genuinely change
  what the code under test does (the 2D context, the viewport size) stay configurable.
- **The render extraction found its own targets by measurement rather than by the plan's list.** Of
  the proposed primitives, the ones that earned their place were the three where copying had already
  caused or hidden a bug: `centeredText` (whose *restore* is the point — `textAlign` is canvas-wide
  state, and two sites shipped without it, invisible only because `drawFrame`'s outer save/restore
  swallowed the damage once per frame), `drawLabelChip` (two sites had independently hand-rolled the
  same plate arithmetic), and `hiddenByFog` (four copies of a rule whose failure is silent in the
  direction that matters — it paints the enemy's army through the fog). A blanket `fillStroked`
  collapse was measured and skipped: the 26 candidate sites set their fill/stroke state in enough
  different orders that a helper would have moved the assignments, not removed them.

## How this was produced

Eight reviewers worked the codebase in parallel, one per domain — engine core sim, AI + `tools/ailab.js`,
economy/logistics, persistence/galaxy, UI/HUD/input, render, the test suite itself, and the cross-cutting
seams (types, import graph, duplication, tooling). Each was given `CONTRIBUTING.md`'s hard rules as
constraints and told that a finding without a citation and a reproduction is not a finding.

The evidence bar matters for how you read what follows. Findings were not inferred from reading code —
they were **executed**. The reviewers ran real games, mutated real source in scratch clones and re-ran the
full suite, instrumented canvas contexts to count `save`/`restore` depth, ran `tsc` probes against
`engine/types.js`, and built the import graph from actual `import` statements across 181 files. Where a
number appears below it was measured. I spot-checked the highest-impact claims against the tree myself and
found no overstatements.

**Baseline at the time of review** (commit `c775143`):

| | |
|---|---|
| Test suite | **1,897 tests, 0 failures**, 4,723 `assert.*` calls across 101 `*.test.js` files (31,711 lines) |
| Wall clock | **145 s** here; measured separately at 150.4 s full vs. **20.5 s without `test/slow/ailab.test.js`** — that one file is **87% of the suite's wall clock** for 3.4% of its tests |
| `npm run typecheck` | exits 0, zero output |
| Production code | 58,701 lines; 76 shipped modules; largest is `hudSelection.js` at 2,201 lines / 131 KB |
| Type coverage | `// @ts-check` on **10 of 76 modules (13%)** — all in `engine/`, **0 of 29 root modules** |

## The four patterns worth internalising

Individual findings are listed by tier below. But the same four shapes turned up independently in domains
that never talked to each other, and they are the more useful output of this review.

### 1. Comments assert invariants the code does not hold

This codebase explains *why*, which is a real strength — and it has quietly become a liability, because
several load-bearing "why" comments are now **factually false**, and each one was believed by a later
reader. Six were found independently:

- `engine/bomb.js:139` says its `radiusOf` is "same as movement.js/formation.js's own" — the three bodies
  have diverged, and only `bomb.js`'s handles buildings. `movement.js`'s copy is in a `// @ts-check`ed
  file whose JSDoc advertises `@param {Unit|Building}` while silently returning the magic constant `9`
  for any building.
- `engine/separation.js:100` says a stale `autoTarget` "reads as still-combat-mode for one tick too long
  — harmless." It is never cleared on a move order at all, so it reads that way permanently.
- `engine/industry.js:300` lists the callers that "never touch this cache" and names the HUD — while
  `buildingConcern`, 90 lines below in the same file, calls it, and `renderBuildings.js:122` calls that
  every frame.
- `engine/persist.js:828` says the lane load path re-runs "exactly like `runLanes`' own per-cycle
  validation does at runtime." It skips the de-duplication `assignShipToLane` enforces.
- `engine/aiMilitary.js:294` says its corrective pull-back "keeps the WHOLE parked group inside the
  radius." The correction is radial and the farthest slot is an off-axis corner, so it never converges —
  measured residual grows from 0.1 px at 8 units to 1.7 px at 40.
- `tools/selfplay.js:81` says both controllers "think on the IDENTICAL pre-tick snapshot." Measured over
  400 think cycles, the `"player"` seat had already mutated orders on 13% of them and founded buildings on
  1% before the `"ai"` seat read the state.

**The lesson is not "write fewer comments."** It is that a prose invariant in this codebase should be
accompanied by the test that makes it executable — otherwise it decays into a confident-sounding lie that
the next contributor builds on.

### 2. Guards check the easy direction

Nearly every guard in the repo verifies the direction that was easy to think of, and is structurally blind
to its complement:

| Guard | Checks | Blind to |
|---|---|---|
| `save-hardening` NET round-trip | serialize→load→serialize is stable | a field absent from **both** sides — which is exactly how `galaxy.rivalAscended` shipped unpersisted |
| `render-roster` | a type isn't drawn as the generic fallback | a type drawn identically to **another real type** — 3 real collisions today, one of them the Odyssey wonder |
| `static-integrity` | every relative import resolves to a file | a module that resolves fine but **nothing imports** — the orphan bug that shipped in `2a07a69` |
| ailab bye tests | a bye never *gains* a candidate credit | a bye never *costs* rank — it does, structurally |
| ailab override tests | overrides don't leak *out* of a duel | two candidates colliding *within* one duel — silently merged |
| `engine-purity` | every file in `engine/` | anything in an `engine/` **subdirectory**, and `data.js` (19 importers, imported by 9 engine modules) |

### 3. The type system is opt-in *and* declawed

`engine/types.js` is a good idea implemented halfway, and the halfway state is worse than either end.

- **12 fields exist at runtime but are missing from 5 typedefs** (proved with a `tsc` probe returning 12
  errors and 0 control failures) — including `State.playerAi`, the central field of the flagship self-play
  feature, omitted by the very commit that added it.
- Adding `// @ts-check` to 12 of the most load-bearing engine files — `sim.js`, `persist.js`, `combat.js`
  among them — produces **zero errors**, because `strict: false` + `noImplicitAny: false` makes every
  un-annotated param `any`. `engine/recycle.js` already carries the pragma and has **0 `@param` tags**
  across its 7 exports: nominally covered, checks nothing.
- The drift **actively blocks** the file-by-file expansion `CONTRIBUTING.md` prescribes: annotating one
  function in `engine/supply.js` immediately produces three errors *in correct code*, which trains
  contributors to distrust the checker.

A pragma-only coverage campaign would take the number to 100% and catch zero bugs. Fix the typedefs first.

### 4. Coverage is example-based and first-cycle

The suite has genuinely good hygiene — **zero tests with no assertion, zero assertions on literals**, one
load-bearing `try/catch`, and excellent assertion messages. What it lacks is *properties*. It proves "a
worker fills the battery once", never "and again after that"; it asserts a specific number at a specific
site, never a conserved quantity. Two of this review's sharpest bugs live precisely there — a `servers`
tally that only ever climbs, and a wonder that keeps eating the treasury after it is done — and both sit
inside green suites.

The reviewer proved the gap by **mutation testing**: 15 realistic regressions injected into a scratch
clone, **6 survived the full suite**, including gutting `drawBuildingBars` (every health bar, build-progress
bar and stall badge in the game) to `return;`, dropping the entire `playerAi` block from saves, and typo'ing
`<script src="main.js">` in `index.html` to a nonexistent file — which ships a blank white screen with CI
green on both Node versions.

---

# Tier 1 — Ship now

High value, low risk, no design decision required. Every item has a named red-first test and an `S`/`M`
effort. Items marked **⚠ replay** change simulation output and need their own commit with
`determinism*.test.js` and `balance.test.js` re-verified.

## 1A. Live defects

Every one of these was reproduced by running the real code.

| # | Defect | Where | Fix | E |
|---|---|---|---|---|
| A1 | **Escorts strand on a ghost leader forever.** `keepFollowingLeader` decides its leader is gone by `hp <= 0`, but `deployColonyShip` and `updateUnitRecycle` remove units at *full* hp. Escorting a colony ship and deploying it — the canonical Odyssey play — permanently bricks the escorts, orbiting a unit no longer in `state.units`. | `engine/movement.js:99`; removals at `engine/recycle.js:151`, `engine/colony.js:40` | Ask the state, not the field: `\|\| !state.units.has(leader.id)` | S |
| A2 | **Squad-release loop splices the array it iterates**, so every splice skips the next element. Dropping two adjacent followers releases only the first; the second keeps `squadLeader` pointing at a leader whose own list no longer contains it. | `engine/commands.js:161-165`, `:46-53` | `for (const old of [...leader.squadFollowers])` | S |
| A3 | **A Torpedo Battery is locked out of auto-resupply forever.** `countLogistics` resets `servers` for factories and combust plants but not for the third input-taking kind `inputNeedsOf` grew (`def.ammo`), so the tally only climbs — 7 after one run, permanently above `MAX_SERVERS`. *This is verbatim the bug the file already documents as fixed for power stations at `haul.js:161`.* | `engine/haul.js:158-164` | Reset from the single source of truth: `if (inputNeedsOf(b)) b.servers = 0;` | S |
| A4 | **A completed Antimatter Gate eats the Strategic tier forever.** `updateWonder` clamps the *charge* but not the *spend*, and `victory.js:80` deliberately never ends a galaxy game. Measured: 90 AI cores / 135 antimatter / 45 plasmatorp destroyed in 450 sim-seconds *after* the Gate finished. The Leviathan competes for the same three goods. | `engine/wonder.js:43-51` | Early-return at `charge >= 1`; clamp `p` to the remaining charge so the last tick pays only for what it banks | S |
| A5 | **A Rival Gate ascension is undone by save/load.** `galaxy.rivalAscended` — the idempotency latch the code calls by that name — is never written to the payload (0 hits in `persist.js`, 0 in `test/`). On reload the permanent stance ceiling is lost and the `ascended` event re-fires on every Continue. Autosave runs every 12 s. | `engine/persist.js:706-733` | Additive: persist as an array, restore filtered against `known` exactly like `claims` at `:778`. **No version bump.** | S |
| A6 | **Freight Lane and Colony Policy panels are dead controls.** Their handlers do `mutate(); renderHUD();` but the 141-line rebuild signature contains no lane or policy term, so the panel never redraws. Reproduced by node identity: commodity chips, `+ New Lane`, disband, and every Colony Policy control are inert — and clicking again silently toggles the state back. | `hudSelection.js:1043-1092`, `:1129-1174`; root cause `:204-344` | Add the two missing signature terms (serialized lane set, colony policy), gated on `game.galaxy` | S |
| A7 | **One throwing draw permanently kills the view.** `drawFrame` has a bare `save()`/`restore()` pair; `loop.js:44` swallows a throwing render so the loop survives — but the camera transform is never popped, so every later frame draws on top of it, including the backdrop clear. Measured save-depth stays at 1 forever. A live trigger exists: `renderEffects.js:579` destructures `building.rally` unguarded, and `cleanEntity` never defaults `rally`. | `render.js:113`/`:146`; `renderEffects.js:579` | `try { … } finally { ctx.restore(); }` + a `rally` guard + restore `textAlign` at `renderBuildings.js:139`/`:723`, `renderNodes.js:38` | S |
| A8 | **An inert Helium Bomb renders as armed**, and idle units snap to another unit's commanded facing. The module-level `_disp` scratch is filled with `Object.assign`, which never deletes stale keys, so one unit's optional fields leak into the next. Measured: the armed-core fill appears twice for one armed bomb. It is a safety cue. | `renderUnits.js:43`, `:69` | `const d2 = { ...u, x: d.x, y: d.y }` (S) — or drop the scratch entirely (M) | S |
| A9 | **`runDuel` merges both candidates' overrides into one shared table.** Two variants of the same dial — the natural A/B workflow — silently degenerate into a mirror match against a Frankenstein row belonging to neither, and report a normal-looking winner. Every tuning decision runs through this. | `tools/ailab.js:672-673`, `:476` | Diff the two candidates' key sets first; throw a named error on any shared key | S |
| A10 | **The barracks hides units the engine would happily build.** The HUD reimplements availability as "every cost commodity has a local node", a rule the engine does not have — and the engine's own `tradeables` is the same predicate *one clause longer* (`present.has(c) \|\| (res[c] \|\| 0) > 0`). Ship gas to a gas-free world and the Wraith button is absent, not greyed. | `hudSelection.js:1405-1407` vs `engine/market.js:219-222` | Export `commodityAvailable(state, owner, com)` from `market.js`; both callers use it | S |
| A11 | **`cachedPowerThrottle` never invalidates on a `tick`-less state** (`undefined !== undefined` is false forever) — the stub idiom used throughout `industry.test.js` and reachable from any non-`tick()` caller. Also `buildingConcern`'s factory epsilon (`1e-6`) disagrees with `updateProduction`'s (none), so the badge can read "bufferFull" while the factory produces. | `engine/industry.js:302-317`, `:406`, `:422` | Initialise `_powerCacheTick = -1`; align the epsilon; fix the two false comments | S |
| A12 | **Owner-parametric leak:** `plannedMix`/`wantsDeepIndustry` read `state.ai`'s difficulty and strategy regardless of who is asking. Measured on a two-controller Odyssey state, the `"player"` controller's entire deep-industry identity is decided by the *other* controller's difficulty. `rivalGateEligible` is already owner-parametric and already wrong. | `engine/aiWorkers.js:157`, `:181` | Thread `owner` through, defaulting `"ai"` so single-owner behaviour is byte-identical | S |
| A13 | **⚠ replay — `autoTarget` is never cleared on a move order.** It is written in exactly one place and read by `isCombatMode`, so a unit pulled out of a fight with Move (the documented way to disengage) uses tight combat packing forever instead of the padded idle spacing `SEPARATION_PAD_MULT` exists to give it. | `engine/combat.js:32-36`, `:53-58` | Clear it in the move branch before returning. **Own commit; re-check `balance.test.js`.** | S |

## 1B. Save-safety — untrusted input reaching live state

`cleanEntity` is genuinely well-hardened, with ~20 coerced per-field cases and excellent reasoning. That
discipline **stops at the entity boundary**. Three whole sub-objects reachable from an Odyssey save are
written into live state verbatim.

| # | Hole | Where | Measured consequence |
|---|---|---|---|
| B1 | **Diplomacy block spread verbatim** — `{ ...createDiplomacy(), ...P.diplomacy }`, untrusted object wins. `clamp` is the identity on a non-number, so `stance` string-concatenates: `"friendly"` → a 4,801-char string in ~160 sim-seconds → trips `sanitizeSave`'s own `MAX_STRING_LEN` on the game's own output. Autosave rotates both generations, so **both save slots become permanently unloadable and the campaign is gone.** | `engine/persist.js:798` | Data loss. Fix pattern already in the file (`cleanPlayer`, `:329`). |
| B2 | **Market `pressure`/`glut` overlaid unvalidated.** Runtime clamps to ±0.6 / 0.85; the load path clamps nothing. Measured: `unitPrice` of 5,000,005; a *negative* sell price; 125 M credits from one sell; and a string pressure makes `galaxy.credits` **irreversibly NaN** (`updateMarket` is multiplicative, so it never self-heals). | `engine/persist.js:795-797` | Economy death or infinite credits. The bands already exist in `market.js` — export and reuse them. |
| B3 | **AI controller restored verbatim**, 15 fields, no `num()`, no enum check — in a file where a unit's `facing` gets a five-line comment justifying its coercion. `nextAttackAt: "later"` makes `state.time >= nextAttackAt` false forever: **the AI's attack timeout is permanently disabled**, with no crash. `state.playerAi` has **zero** save coverage in any test file. | `engine/persist.js:639-670` | A quiet game reads as boring, not broken. |
| B4 | **`updateService` derefs `unit.cargo` unguarded** while every sibling path guards it. `persist.js:122` nulls a freighter's cargo while leaving `aiLogistics: true`, so a corrupt save loads "clean" and then throws on tick 1 **inside the rAF loop, past load's `try/catch`** — the player cannot get back in. This is verbatim the failure `production.js:76` already guards against. | `engine/haul.js:476-477` | Unrecoverable. Mint the slot lazily at the consumer. |
| B5 | **Lane load path drops two runtime invariants.** Duplicated `shipIds` survive (measured: 750 ore moved by one 250-hold hauler in one cycle — 3× throughput), and `laneSeq` is not lifted past the ids the save carries, so a new lane can collide and become permanently unreachable from the UI. Both fix patterns are already written twice in the same function (`maxOwnEntityId`, `maxGId`). | `engine/persist.js:831-844`, `:789` | Free throughput; an undeletable lane. |
| B6 | **`rally` is the one coordinate pair never clamped.** `order` and `anchor` are both clamped for the stated reason that garbage "flows straight into `stepToward`" — `rally` flows to exactly the same place via `production.js:108`. Measured: a `1e9` rally spawns units at 2722, 3084 on a 1600×1000 map, outside every fog and grid bound. | `engine/persist.js:98-269` | Reuse the existing `clampOrderCoords` closure. |

## 1C. Guards that don't guard

The most alarming section, because these are the mechanisms `CONTRIBUTING.md` cites as making its hard
rules executable.

| # | Guard | What's wrong | Fix |
|---|---|---|---|
| C1 | `determinism.test.js` | Fingerprints with a **local, weaker** snapshot than the project's own `_helpers.entitySnapshot` — proved blind, field by field, to unit cargo qty and commodity, move-order target coordinates, building `charge`, `tier`, `constructing`, and `state.time`. `_helpers.js:8` exists so "a dozen suites don't each re-roll them slightly differently" — and the most load-bearing suite re-rolled it. | Delete the local `snapshot()` and `mulberry32`; import from `_helpers.js`. Add a sensitivity test as the guard-on-the-guard. **S** |
| C2 | `determinism-roster.test.js` | Sweeps all 11 worlds but only **400 ticks = 40 sim-seconds** — measured **0 combat orders on every world**, ≤8 units, ≤3 buildings. The deep run uses the weak fingerprint on one world; the broad run replays only the opening. Raising to 2,000 ticks costs **+1.3 s** and buys 6,034 combat-order ticks. | Raise the loop; assert the fixture actually reaches combat. **S** |
| C3 | `engine-purity` + `static-integrity` | Both use non-recursive `readdirSync`. A file placed at `engine/net/lockstep.js` calling `Math.random`, `Date.now`, `window.localStorage`, `document` **and** importing a nonexistent module passed all four guards, 8 pass / 0 fail. The purity test's own rationale mentions netcode — the first thing that growth produces is `engine/net/`. Separately, `data.js` (19 importers, 9 of them engine modules) is scanned by neither guard. | One shared recursive `walkJs(dir)`; extend the purity scan to root modules transitively imported by `engine/`. **S** |
| C4 | `index.html` | Never validated. Changing `src="main.js"` to `src="mian.js"` **survives the full suite** — a totally dead game, green on two Node versions plus typecheck. `main.js` is also the one root module no test imports. | Resolve every `src`/`href` in `index.html` against disk. **S** |
| C5 | Module reachability | Nothing checks that a shipped module is reachable from the single entry point. This bug **already shipped** (`2a07a69`: the Tech Chart button and T hotkey silently did nothing), and three modules still hang off bare side-effect imports in `main.js`. 7 modules attach top-level listeners and would lose all wiring silently. | Walk the graph from the entry point parsed out of `index.html`; allow-list `engine/types.js`. **S** |
| C6 | `render-roster.test.js` | Proves "not the generic fallback", not "distinct from every other type". Traced pairwise: **`antimatter_gate` is drawn as a slightly larger `antimatterforge`** — the Odyssey wonder, a victory condition — and `torpedobattery` as a smaller `torpedoworks`. Also never varies entity state, so `constructing`, `capital`, `electrified`, tier pips, armed, laden and veterancy branches are all unreached; `drawUnits` is tested with exactly one unit type (Skiff, 1 of 18). | Radius-normalized silhouette uniqueness with a named `SHARED_HULLS` allowlist; roster × state-variant sweep. **S** (test) |
| C7 | Render entry points | **9 of 14 exported render functions have zero test call sites**, `drawFrame` among them — the orchestrator owning draw order, `selSet` threading and the save/restore of A7. A wrong draw order silently reintroduces the "ship paints out a base's health bar" bug that `render.js:135` exists to fix. | Draw-order assertion + `doesNotThrow` smokes with realistic state. **M** |
| C8 | Vacuous render tests | `drawBuildingBars` and `drawBuildGhost` are covered only by `assert.doesNotThrow`. Replacing each body with `return;` **survives the full 1,832-test suite** — every health bar, build-progress bar, buffer gauge and stall badge can vanish, green. The same mutation on `drawEffects`/`drawBuildings`/`drawUnits`/`drawTerrain`/`drawNodes` was killed every time: the recording-Proxy pattern works, it just wasn't applied here. | Trace assertions using this file's existing *recording* `fakeCtx`. **S** |
| C9 | Save round-trip | Dropping `aiColonyTarget`, `aiLastThreatAt`, or the **entire `playerAi` block** from `persist.js` survives the full suite. (`aiWaveCount` and a wonder's `charge` were both killed — the per-field pattern exists, it just stops short.) | One table-driven controller round-trip test. **S** |
| C10 | UI import-safety | `CONTRIBUTING.md:52` requires UI modules to import cleanly under Node. **8 of 11 throw** — `hud.js`, `hudSelection.js`, `overlays.js`, `boot.js`, `observerPanel.js`, `techChart.js`, `setup.js`, `main.js` — and the pattern is inconsistent *within* files (`boot.js:101` guards, `boot.js:71` doesn't). All 13 DOM test files install `globalThis.document` before importing, papering over it permanently. | Child-process-per-module import check (a sibling's stub would mask it). **M** |
| C11 | `data-integrity.test.js` | Guards exactly one stringly-typed cross-reference. Three more seams are unguarded and currently clean: commodity keys across all cost/upkeep/consumes/inputs tables and 18 recipes, `BUILDINGS[*].produces` against `UNITS`, and `ODYSSEY_WORLDS` against `PLANETS` + the archetype map. The repo has been bitten by this genre twice already. | Three roster-driven tests, each red-provable with one typo. **S** |
| C12 | Suite integrity | `npm test` passes **no path**, relying on Node's implicit discovery globs (which changed across 18/20/22). Nothing asserts the ten named guard files still exist — delete one and CI is green with a smaller number nobody reads. `_helpers.js` is itself spawned as a test file. | `"test": "node --test test/"` + a meta-test parsing the guard names out of `CONTRIBUTING.md`. **S** |
| C13 | Perf-in-determinism | The suite's only two wall-clock assertions live **inside `determinism.test.js`** (measured headroom 4.8×, not the "~6×" claimed, on a two-version CI matrix). If the perf alarm trips, the file that goes red is the *determinism* guard — training contributors to dismiss a red determinism file as flaky. | Move both to `test/perf-guard.test.js`, budgets unchanged. **S** |
| C14 | Untested shipped behaviour | Commit `ac44339`'s ore-surplus army-cap feature has **zero tests** — proved by mutation: replacing its body with `return 0` leaves all 1,897 green. The commit records "manually probed" in place of tests. Blind because every `standingArmyCap` test runs in skirmish, where the code short-circuits. | Three `endless`-state tests, incl. the skirmish guard. **S** |
| C15 | Hot-path contract | `grid.js`'s shared `_scratch` buffer has a documented aliasing contract ("none makes a second `queryNeighbors` call while a prior result is still being iterated") that no test asserts. Two call sites hold it *across* a loop body. A violation would deterministically skip separation pairs — invisible to determinism testing, since both runs would be wrong identically. | Pin the reuse contract by array identity, plus the real guard. **S** |
| C16 | Dead branch | `loop.js:39`'s backlog-drop branch is **unreachable at the shipped `hz`** — `0.25 s` clamp ÷ `dtFixed 0.05` = exactly `MAX_SUBSTEPS 5`, an undocumented exact identity coupling three constants. Measured 0 times taken at `hz=20`, 72 at `hz=60`. Bump to 30 Hz and a dead line starts running, handing the renderer an interpolation alpha ≥ 1. | Cover it at `hz: 60`; name the coupling at the constant. **S** |

## 1D. Make the type system real

Order matters here — **D1 unblocks everything else**.

1. **D1 — Fix the 12 drifted fields in `engine/types.js`.** `State.popCap`, `State.playerAi`,
   `AiState.strategy`, `AiState.lastThreatAt`, `Galaxy.lanes`, `Galaxy.laneSeq`,
   `GalaxySettings.startId`, `GalaxySettings.popCap`, and `Diplomacy.{provokedAt, goodwill, request,
   lastFavorBucket}`; plus `Archetype.{wantsRefinery, turretCount, maxBarracks, garrison}` and
   `Order.{tx, ty, explore, patrol}`. Also decide whether `Diplomacy.lastAiUnits` — declared but never
   constructed — should be declared or deleted. Guard it with a text-diff test between each typedef block
   and its factory literal, asserting on the *sorted array* so the failure names the field. **S, zero
   runtime risk** (`types.js` has no runtime code and zero importers).
2. **D2 — Make the pragma mean something.** Add a `static-integrity` test asserting every `// @ts-check`
   file annotates its exported functions with the shared typedefs. Red today on `engine/recycle.js`
   (7 exports, 0 annotations). Without this, expanding coverage raises a number and catches nothing.
3. **D3 — Adopt, one file per commit, in this order:** `supply.js` → `aiCommon.js` → `colliders.js` →
   `victory.js` → `production.js` → the AI leaves (`aiStrategy`, `aiDifficulty`, `aiArchetypes` — all
   0 errors once D1 lands) → `scout.js` → `persist.js`. `persist.js` is the prize: every save field is a
   `State`/`Unit`/`Building` field read by name, so annotating it makes **save-shape drift a check-time
   error**. Leave `galaxy.js` and `entities.js` for last.
4. **D4 — Add `"tools/**/*.js"` to `jsconfig.json`'s `include`.** `tools/` is not in the program at all
   today, so `ailab.js` and `selfplay.js` cannot be checked even if they opted in.
5. **D5 — Evaluate `strictNullChecks` separately.** `engine/haul.js` *has* the pragma and `Unit.cargo` is
   correctly typed `Cargo|null`, yet B4's crash produces no error because `strict: false` turns off null
   checking. This is its own change with its own fallout — keep it off the critical path.

## 1E. Documentation drift

- **E1** — `docs/improvement-roadmap.md:77` still lists the Technologist archetype as pending Phase 2 work,
  and `improvement-proposals.md:491` still describes Kybernet in the present tense as playing "a generic
  Economist". It shipped in `17e2aad`. The roadmap's Phase 2 gates Phase 4, so a completed item sitting in
  the pending table can block downstream work. **S**
- **E2** — `README.md`'s Project layout omits **19 shipped modules**, including `hudSelection.js` (the
  largest file in the repo) and `main.js` (the page's only entry point, and the file whose missing import
  caused `2a07a69`). The README never mentions `npm run typecheck`, which CI runs as a required step.
  `CONTRIBUTING.md:82` lists 6 `// @ts-check` files; the real count is 10 — understating existing coverage
  by 40%, on the list that is the on-ramp for D3. **S**

---

# Tier 2 — Structural

Real value, but each needs care: several move replays and need re-baselining, and a few change a public
surface.

**Correctness with a wider blast radius**
- **Collection-point freighter stalls empire-wide.** `assignShuttle`'s "don't leave yet" guard runs through
  `zoneFirst`'s *unbounded global* fallback, so a partly-loaded ship waits on a backlog anywhere in the
  empire. Reproduced with two bases 3,600 px apart. It is also the only zone-aware scan that doesn't
  forward `unit.homeCC`. Single-CC games are unaffected by construction. `engine/haul.js:623-631`. **M**
- **Yield bonus overfills a hold, and save/load then deletes the excess** (measured 251 → 250 on a 250 cap).
  Breaks the hold's capacity *and* "a save round-trips identically" — invisible to replay testing because
  both runs agree until someone saves. `engine/gather.js:138-143`. **S**
- **`garrisonSlots`' single corrective pass never converges** (residual 0.1 px at 8 units → 1.7 px at 40),
  and the branch has **never executed under `npm test`** — every dispersal test uses 1 or 5 units around a
  bare CC, which doesn't overshoot until ~60. `engine/aiMilitary.js:301-314`. **S**
- **`order.patrol` carries two incompatible meanings** — a boolean requeue flag in `sim.js:170` and a
  numeric circuit index in `scout.js:54`. Latent today only because `issueScout` bypasses the order queue;
  index 0 is falsy, 1–3 requeue forever. **S**
- **`nearestGatherDrop`/`nearestCommandCenter` are the only "nearest" scans with no id tie-break**, while
  six siblings pin theirs explicitly. `zoneFirst` resolves zone membership by identity against the result,
  so two equidistant CCs make every zone boundary depend on Map insertion order. Correct today; a
  different *kind* of guarantee from its neighbours. **S**
- **`radiusOf` triplicated and already divergent** — `bomb.js`'s handles buildings, the other two return
  `9`, and `movement.js`'s `// @ts-check`ed JSDoc advertises `Unit|Building`. Move the correct body to
  `engine/colliders.js`. **S, ⚠ replay-adjacent** (hot path; verify all call sites pass units — they do).
- **Galaxy meta sets unfiltered** (`pacified`, `reached`, `discovered`, `wonBy`, `settings`) while `claims`,
  `colonyPolicies` and `worlds` are filtered three lines away. Free domination milestones from junk ids,
  and a tampered `settings` builds a NaN-sized map on the next jump — the galaxy twin of a hazard already
  closed on the skirmish path. Careful: `reached` must filter against *milestone* ids, not world ids.
  **M**

**Tests that would have caught the above**
- **Conservation-of-resources property test.** No test anywhere sums total holdings across treasury +
  building `store`/`input` + freighter `freight` + worker `cargo`. This one property catches A4 and the
  overfill bug together, and it documents the *intentional* exceptions (rig overflow spill, wonder feed,
  recycle fraction) which today are only prose. The helpers already exist and are exported. **M**
- **"Every state field is persisted or deliberately transient."** The NET round-trip tests cannot express
  "forgotten". A denylist test over `Object.keys(state)` / `Object.keys(createGalaxy(...))` goes **red
  today on `rivalAscended`** — the general net that would have caught A5. Fold `claims`, `discovered`,
  `wonBy` and `rivalAscended` into `_helpers.galaxySnapshot` too. **M**
- **Panel-completeness meta-test.** Table-driven, one row per panel family, asserting the panel actually
  rebuilds when its own state changes. Red today naming exactly the unwatched panels — converts A6's class
  of omission from invisible to red. **M**
- **`commandAt` precedence table.** The 10-branch right-click ladder is game policy the engine does not
  re-check, and `issueEscort`/`issueFerryFreighter`/`issueSetHomeBase`/`issueAssistBuild`/`issueRepair`
  have **zero** occurrences in `input.test.js`. No test pins which branch wins when two match. **M**
- **`ailab.test.js` permanently mutates the shipped `STRATEGIES` table** (`aggressive.garrisonMult`
  0.4 → 0.9) with no restore — so 21 later tests measure a strategy the game never ships, and the suite's
  own three leak-detector tests capture their baseline *after* the leak. `snapshotTables`/`restoreTables`
  are already exported and simply not imported. **S**

**Speed and structure**
- **`test/slow/ailab.test.js` is 87% of the suite's wall clock** — ~130 s for 65 tests, all guarding a dev
  bench. Roughly 51 s is spent simulating real matches to assert *pure combinatorics* (pairing counts, bye
  rotation, sort order, `ceil(log2(n))`). The file already demonstrates the fast idiom once, at `:834`, and
  its own comment explains why it's better. Dropping the loop from ~150 s to ~20 s is the difference
  between "run the full suite every cycle" being followed and being routed around. **M**
- **Swiss standings rank raw win totals across unequal match counts**, so the ranking is literally
  "everyone who avoided a bye, then everyone who didn't" — and the round-1 bye is decided by **CLI argument
  order** (measured: always the last-listed candidate). This is the mirror image of the bug `e9ad1d0` just
  fixed. **M**
- **The side-swap runs its two directions on different map seeds** (measured overlap: 0 of 2), so the one
  mechanism built to detect seat asymmetry is confounded with seed variance and cannot fire — while
  `tickSelfPlay` has a real, measured, always-same-direction seat edge. Sort the names into the seed hash;
  `swapAsym` already shows what the paired design looks like. **S** (re-baselines duel/Swiss fixtures)
- **`tickSelfPlay`'s ordering claim.** Pick one deliberately: make it true, alternate by tick parity, or
  correct the comment and pin the bound with a characterisation test. Do not leave the comment and the
  code disagreeing. **M**
- **Rebuild-signature co-location.** 141 lines with 11 inline IIFEs, each re-deriving a lookup that
  `rebuildSelectionPanel` derives again further down the file. **M**
  *(Partly done, 2026-08-08: `rebuildSelectionPanel` is now a dispatcher over twelve named
  `renderX()` families instead of one 871-line body, so the "render" third of the registry exists
  already. What is left is moving each family's signature term next to its renderer — now a
  per-family move rather than one big one.)*
- **Production rosters copied out of `BUILDINGS[].produces` in three hand-maintained shapes**, with the
  Odyssey gate duplicated *differently* from the engine's own. Land the test before the refactor — it
  passes today. **S**
- **Silhouette collisions** (C6's art half — the Gate deserves a bespoke hull), **per-frame allocation**
  (measured 2.16 ms of pure JS and 0.9 MB/s of garbage at 306 units, before any rasterization; pop caps go
  to 300 *per side*), **five byte-identical cross-module function bodies** (the two that actually bit
  — `clamp`, `negate` — are shared now and re-forking is guarded by
  `test/static-integrity.test.js`), and the **UI import cycle** (now 7 modules, not 6: `competition.js`
  joined it deliberately. Still benign only because every back-edge is called at runtime rather than
  at module-evaluation time, and still failing as a blank white screen if that stops being true —
  but no longer "guarded nowhere": a Tarjan check in `test/static-integrity.test.js` freezes the
  cluster's exact membership, so a new cycle anywhere, or an eighth member here, fails the suite).
  Each **S–M**.

---

# Tier 3 — Deep refactors, design call first

Do not start these until the design question in each is answered. All are worth doing eventually; none is
urgent, and each is a poor first PR.

**All seven are now delivered** (see Status, above, for the three whose answers changed what got built).
Outcomes, in the table's order:

1. `hudSelection.js` — split by *derive vs render*: `hudPanelSignature.js`, 2,242 → 1,915 lines, behind a
   25-fixture golden lock landed one commit ahead of the extraction. The per-panel registry remains the
   destination; this is the seam it moves into.
2. `haul.js` — four explicit `*_PHASES` sets with a terminal unknown-phase guard. The collection-point
   asymmetry was ruled **intentional** and is now documented at the code rather than inferable from it.
3. AI decisions — nine predicates exported in place; the 13-site build idiom collapsed into
   `tryBuild`/`tryBuildAt`.
4. Save schema — the field table was **rejected on inspection** and replaced by a payload-level
   round-trip guard, which delivers the property the table was for.
5. Render boilerplate — `centeredText`, `drawLabelChip`, `hiddenByFog`. A blanket `fillStroked` collapse
   was measured and skipped.
6. Test harness — nine hand-rolled DOM doubles consolidated into `test/_dom.js`, one file at a time, with
   a suite-integrity guard against regrowth.
7. Formation ranking — **per-cluster**, not global. The first test written for it compared destinations
   to *origin* centroids and so measured nothing; rewritten to the real invariant (ranking permutes
   within a cluster, never across).

| Refactor | The question to answer first | Safety net required before starting |
|---|---|---|
| **`hudSelection.js` decomposition** — 2,201 lines, 2 exports, one 845-line function with 17 entity-type branches. Proposed: a panel registry of `{ key, match, signature, render }` over five modules, leaving a ~250-line orchestrator. Co-locating `signature` with `render` is what structurally prevents A6 recurring. | Registry shape, and whether the runtime `hudSelection → hud → hudSelection` cycle constrains it | Golden `panelTree()` serializer over ~20 fixtures, committed *with* the harness; every extraction commit must leave all goldens untouched |
| **`haul.js`'s four phase machines** — 657 lines, 14 untyped phase strings, five near-identical "walk there, then act" legs, two provably dead branches, and a behavioural asymmetry hidden in the duplication (`updateHaul` banks at a collection point; `updateService`/`updateFerry` walk past one to the CC). | **Is the collection-point asymmetry intentional?** That is a behaviour decision, not a refactor | Pin both behaviours first. *The unknown-phase guard — a terminal `else unit.order = null` — is a Tier-1 slice worth splitting out now* |
| **AI decision extraction** — `ai.js` has one export, `aiContext` is private, so every phase test must stage a whole match. Twelve pure helpers are unreachable; this is the **direct cause** of C14 and the `garrisonSlots` gap. Plus a 13-site build idiom. | Where the seam lives (`aiDecisions.js` leaf vs. exports), and how to handle the two build sites that do extra work inside the `if` | Characterisation tests on `standingArmyCap` and `withoutHomeGuard` against hand-built plain objects |
| **Declarative save schema** — ~630 of `persist.js`'s 865 lines are hand-rolled per-field code across four functions, with the 15 controller fields written out **four times** with two hand-typed prefixes. This is the root cause of A5, B1–B4 and B6 all being *omissions* rather than mistakes. | Whether the payload must stay byte-identical (it must — every `.prev` autosave in the wild) | The controller field-set equality test, and the two version-coupling guards, both **Tier 1 and cheap**: `SAVE_VERSION === GALAXY_SAVE_VERSION` while `serPlanet` is shared, since the galaxy embeds per-planet payloads with no per-planet `v` |
| **Render boilerplate extraction** — ~1/5 of `renderBuildings.js`'s 809 lines is copy-pasted drawing shape (30 hairline-outline sites, four near-verbatim blocks). New roster art is written by copy-paste, which is how the silhouette collisions and the missing `textAlign` restores arrived. | How far to push the primitives | Land C6's state-variant coverage **first**, then pinned per-type traces |
| **Shared test harness** — `_helpers.js` is imported by 7 of 101 files; the rest hand-roll 6 divergent fingerprints, 7 `fakeCtx` variants (with three-way circular attribution in their comments) and **1,538 lines** of DOM scaffolding. C1 is the direct cost of that divergence. | Nothing structural — but migrate **one file per commit**; the stubs differ in load-bearing ways | Per-file pass-count baseline; a shared fake being *stricter* is a feature, and any test it newly fails is a genuine finding |
| **Formation range-ranking vs. clustering** — `rankSlotsByRange` flattens the nested cluster layout `formationSlots` deliberately builds, so units cross-swap sub-formations and walk an extra ~150 px. | **Per-cluster or global ranking?** | A multi-cluster fixture asserting each follower lands nearer its own centroid |

---

# Suggested sequence

Five PRs, ordered so each makes the next safer. Roughly a week of focused work for Tier 1.

1. **The guards, first.** C1 + C2 together (they are two halves of one hole — deep-but-weak and
   broad-but-shallow), C3, C4, C12, C13. Nothing else in this document is trustworthy until the
   determinism guard can see cargo and the purity scan can see a subdirectory. Cost: ~1.3 s of suite time
   and a handful of small test edits.
2. **D1 + D2.** Fix the 12 drifted typedefs and add the annotation-density guard. Cheap, zero runtime risk,
   and it unblocks D3 — which is otherwise actively blocked, since annotating `supply.js` today produces
   errors in correct code.
3. **Save-safety: B1 → B2 → B4 → B5 → B6, plus A5.** All identity-for-valid-saves, so the NET round-trip
   tests stay green throughout. B1 first: it is the only one that destroys a campaign outright.
4. **The live defects: A1, A2, A3, A4, A6, A7, A8, A9.** Each is small and self-contained; A3, A4 and A7
   fix bugs whose *identical twin* is already fixed and documented elsewhere in the same file, so the tests
   are close to copy-paste. Hold A13 back for its own commit with the balance harness re-checked.
5. **C5, C6, C8, C9, C11, C14, C15, C16 + E1, E2.** Pure coverage and documentation. This is where the
   mutation-testing findings get closed, and it is the batch that makes steps 1–4 *stay* fixed.

Then reassess. Tier 2 splits cleanly across parallel workstreams; Tier 3 should wait until its design
questions have actual answers.

*(Historical: this sequence was followed. Tier 1 shipped in seven commits, Tier 2 in five, Tier 3 in
eight — each tier merged as its own PR, with the design questions answered in writing before the
corresponding Tier-3 refactor started.)*

---

# Appendix — findings by domain

Full per-domain reports, with the reproductions and exact TDD plans behind each summary line above, were
produced for: **engine core sim** (8), **AI + ailab** (10), **economy/logistics** (10),
**persistence/galaxy** (10), **UI/HUD/input** (8), **render** (8), **test suite** (11), and
**cross-cutting** (10) — 75 findings total, of which 69 survived de-duplication and ranking into the
42 Tier-1, 20 Tier-2 and 7 Tier-3 entries above.

Domain health, in one line each:

- **Engine core sim** — genuinely good. Determinism discipline is real (`_gi` indices, `hashStr`
  tie-breaks, two-pass splash), the hot path is allocation-conscious. Weak seam: entity liveness is asked
  by `hp` while two removal paths delete live units.
- **Economy/logistics** — well-built; buffers clamped, throttles order-independent, tie-breaks explicit.
  Weak seam: coverage is example-based and first-cycle, so "works once" hides "never again".
- **Persistence/galaxy** — excellent *for entities*, and that discipline stops exactly at the entity
  boundary.
- **AI + ailab** — unusually well-decomposed; `ai.js` threading one `AiContext` through phase modules is a
  good structure. Weak seam: the newest tier carries its correctness claims in prose.
- **UI/HUD/input** — hygiene is better than it looks (`AbortController` teardown, null-guarded queries,
  `innerHTML` only from literals). The problem is shape, not rot.
- **Render** — the drawing is well-reasoned (real culling, cached silhouettes, batched fog). The problem is
  the seam between "a draw threw" and "the frame recovers".
- **Test suite** — good by the metrics most suites fail. The holes are in the guards, not the ordinary
  tests.
- **Cross-cutting** — architecture is healthy: zero engine→UI leaks, one documented cycle, zero orphans.
  The gaps are in what's *enforced*, not what's *true*.
