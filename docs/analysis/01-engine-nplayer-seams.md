# 01 — Engine N-Player Seams: a change-site audit

**Scope.** What must change in `engine/` (and what must change *around* it) for the
`Stellar Frontier: RTS` simulation to support 2–8 seats of mixed human / AI / MCP-agent
control, while preserving `same seed ⇒ same game` (CONTRIBUTING §1) and keeping the
existing 2519 tests meaningful.

**Source of truth.** All citations are `path/file.js:line` against the read-only clone at
`/home/user/alma92350/spaceexploration-rts` at the commit currently on disk.

---

## 0. Headline findings

1. **The engine is far closer to N-player than the literal count suggests.** The
   *combat, movement, gather, haul, repair, supply, industry, production, separation and
   fog kernels are already owner-generic* — they compare `entity.owner` against a bound
   variable (`owner`, `unit.owner`, `building.owner`), never against a string literal. See
   `engine/combat.js:153`, `:243`, `:342`, `:386`, `:411`; `engine/fog.js:135`, `:140`;
   `engine/supply.js:33`, `:48`; `engine/separation.js:105`; `engine/movement.js:181`;
   `engine/production.js:26`; `engine/repair.js:56`, `:161`, `:172`. **Free-for-all combat
   already works for N sides with zero changes.**

2. **`engine/victory.js` is already N-generalized and there is a passing test that proves it
   with three sides** — `test/ownerScaffold.test.js:55-78` splices in a `"rebels"` owner and
   asserts last-side-standing. `checkWinCondition` (`engine/victory.js:28`) filters
   `ownersOf(state)`; `scoreLeader` (`:163`) iterates it; `scoreBreakdown`/`playerScore`
   (`:128`, `:147`) are per-owner.

3. **The whole 1v1 assumption collapses into ~6 chokepoints**, not 53 scattered literals:
   - `otherOwner(owner)` — `engine/aiCommon.js:42-44`, the "there is exactly one enemy" axiom.
   - `controllerFor(state, owner)` — `engine/aiCommon.js:32-36`, the 2-slot controller registry
     (`state.ai` / `state.playerAi`), plus **7 hand-rolled copies** of the same ternary.
   - `ownerDefs` — `engine/state.js:178-181`, the literal side list.
   - `map.bases` — `engine/map.js:161-164`, a 2-entry left/right mirror.
   - `state.fog` / `state.fogAI` in *engine* code — `engine/gather.js:64`, `engine/scout.js:42`,
     `engine/sim.js:70-71`.
   - `rehydratePlanet`'s 2-keyed rebuild — `engine/persist.js:726`, `:729`.

4. **The literal counts.** Exactly **53** owner-literal *comparisons* in `engine/`
   (`23 × === "player"` + `1 × ==="player"` no-space + `12 × === "ai"` + `9 × !== "player"`
   + `9 × !== "ai"` — verified by
   `grep -rEc '(===|!==)\s*"(player|ai)"' engine/`). **35 of those 53 (66%) live in
   `engine/galaxy.js` (19), `engine/scenarios.js` (4), `engine/colonyPolicy.js` (3),
   `engine/sim.js`'s Odyssey-logistics block (4 of 5) and `engine/diplomacy.js` (2)** —
   i.e. in the *Odyssey open-world and scripted-mission layers, which a multiplayer skirmish
   never loads.* The skirmish-critical residue is roughly **18 sites**.

5. **There is a larger, unnoticed surface outside `engine/`: 80 owner-literal comparisons**
   in the UI/tools layer (`inputCommands.js` 16, `tools/ailab.js` 9, `hudSelection.js` 7,
   `renderBuildings.js` 6, `hud.js` 6, `boot.js` 6, `input.js` 5, …). These encode
   *"`player` means me, the local viewer"*. That is the multiplayer client's real work item,
   and it is bigger than the engine's.

6. **⚠️ The single highest-severity finding is a desync landmine, not a feature gap.**
   `engine/gather.js:64` and `engine/scout.js:42` read

   ```js
   const fog = unit.owner === "player" ? state.fog : state.fogAI;
   ```

   `state.fog` is an *alias* into `state.fogs` (`engine/state.js:232-233`). The natural
   multiplayer client change — "rebind `state.fog` to *my* fog so render/HUD keep working" —
   silently makes these two engine lines resolve the **wrong** fog on every client but the
   host, which changes gather retargeting and scout waypoints, which changes unit positions,
   which diverges the simulation. **These two lines must be fixed before any client-side
   rebinding of `state.fog` is attempted.** See §2.

7. **Verdict on phasing: YES, a 2-player human-vs-human first phase is viable and cheap** —
   estimated ~10 engine lines plus a client-side `localOwner` seam — but it is *not* zero-cost,
   and three specific asymmetries would ship as bugs if taken literally. See §9.

---

## 1. Every hardcoded owner literal in `engine/`

Classification key:
- **(a) trivially generalizable** — mechanical substitution, no design decision, no new concept.
- **(b) needs a real design decision** — the fix requires choosing a policy (who is my enemy?
  what is a controller? how do teams work?).
- **(c) genuinely 1v1-only semantics** — the *feature* is 1v1/single-human by construction;
  generalizing means redesigning the feature, or scoping it out of multiplayer.

### 1.1 The core scaffold — `engine/state.js`

| Site | Function | Code | Class |
|---|---|---|---|
| `state.js:178-181` | `createGameState` | `ownerDefs = [{id:"player",…},{id:"ai",…}]` | **(b)** |
| `state.js:227` | `createGameState` | `owners` comment pins `["player","ai"]` | (a) |
| `state.js:232-233` | `createGameState` | `fog: fogs.player`, `fogAI: fogs.ai` | **(b)** |
| `state.js:279` | `createGameState` | `seedDifficultyEdge(state, "ai")` | (a) |
| `state.js:35`, `:61` | `makeUnit`/`makeBuilding` JSDoc | `@param {string} owner "player" \| "ai"` | (a) |

`ownerDefs` is the root. Everything downstream of it in `createGameState` **already iterates**:
`owners = ownerDefs.map(d => d.id)` (`:182`), the `players` map (`:185-186`), `fogs` (`:188-189`),
seeding (`state.js:270`: `for (const id of owners) seedPlayer(state, id, map.bases[id])`) and
the fog prime (`:271`). The file's own comment at `:167-174` states the intent explicitly:

> *"the SCAFFOLD is owner-generic: state.owners is the canonical side list, and the player map,
> per-owner fog, seeding, persistence and the victory check are all driven by ITERATING it —
> not by two hardcoded names. So a future N-faction world is a change to this list, not a sweep
> across the engine."*

That claim is **true for construction and victory, and false for the AI layer, the fog aliases,
`map.bases` and the deserializer.** This audit is largely the enumeration of that gap.

`seedDifficultyEdge(state,"ai")` at `:279` is safe under N: `difficultyFor` (`aiDifficulty.js:117`)
falls back to `medium` for an owner with no controller, and `medium.economicEdge` is falsy.

### 1.2 The AI controller registry — the real 1v1 axiom

| Site | Function | Code | Class |
|---|---|---|---|
| `aiCommon.js:33-34` | `controllerFor` | `if (owner === "ai") return state.ai; if (owner === "player") return state.playerAi;` | **(b)** |
| `aiCommon.js:43` | `otherOwner` | `return owner === "ai" ? "player" : "ai";` | **(b)** |
| `aiCommon.js:68`, `:77`, `:83` | `accrueActionBudget`/`canAct`/`spend` | `owner = "ai"` default param | (a) |
| `ai.js:96` | `runAI` | `owner = "ai"` default param | (a) |
| `ai.js:136` | `aiContext` | `owner = "ai"` default param | (a) |
| `ai.js:138` | `aiContext` | `const enemyOwner = otherOwner(owner)` | **(b)** |
| `aiIntel.js:182`, `:199`, `:279`, `:315` | `updateIntel`, `readEnemy`, `updateAdaptMode`, `adaptDefenceMult` | `owner === "ai" ? state.ai : state.playerAi` | **(b)** |
| `aiDifficulty.js:118` | `difficultyFor` | same ternary | **(b)** |
| `aiStrategy.js:145` | `strategyFor` | same ternary | **(b)** |
| `aiIndustry.js:103` | `rivalGateEligible` | same ternary | **(b)** |
| `aiIntel.js:145` | `sightEnemy` | `otherOwner(owner)` | **(b)** |
| `aiMilitary.js:446`, `:552`, `:572`, `:633` | `visibleEnemyCombatUnits`, `raidTarget`, `chooseAttackTarget`, `counterToPlayerArmy` | `otherOwner(owner)` | **(b)** |
| `aiMilitary.js:589`, `:694` | `chooseAttackTarget`, `updateScout` | `state.map.bases[enemyOwner]` | **(b)** |
| `combat.js:94` | `updateUnitCombat` | `state.ai?.micro && unit.owner === "ai"` | (a) — but see below |
| `techtree.js:144` | `aiResearchPaceMult` | `if (owner !== "ai" && (owner !== "player" \|\| !state.playerAi)) return 1;` | (a) |
| `aiEconomy.js:490` | `aiMarketBarter` | `if (owner !== "ai" \|\| …) return;` | (c)/Odyssey |
| `aiWorkers.js:123` | `assignIdleWorkers` | `fog = state.fogAI` default param | **(b)** |
| `aiEconomy.js:520` | `bestExpansionCluster` | `fog = state.fogAI` default param | **(b)** |
| Default `owner = "ai"` params (no logic) | `aiWorkers.js:156,181,213,230`; `aiMilitary.js:445,461,484,551,571,606,632`; `aiIntel.js:144,181,198,231,278,314`; `aiDifficulty.js:104,117`; `aiIndustry.js:66,67,94`; `aiEconomy.js:489`; `aiStrategy.js:144` | `owner = "ai"` | (a) |

**Note on `combat.js:94`.** It reads `state.ai?.micro` — *the AI seat's* micro flag — but applies
it to `unit.owner === "ai"`. Under the current 2-controller design this is coincidentally correct;
under any N design it is a latent bug (a self-play `"player"` controller with `micro: true` gets no
kiting, and its opponent's flag would leak). The correct form is
`controllerFor(state, unit.owner)?.micro`. Classified (a) because the substitution is mechanical,
but flagged: **it is behaviour-changing for self-play and therefore fingerprint-changing**, so it
needs a determinism re-baseline, not a silent refactor.

**Note on `aiMilitary.js:531`** — `playerHasPresence(state, owner = "player")`. Despite the name,
this is already owner-generic; only the default and the name are 1v1. Called at `:194` as
`playerHasPresence(state, enemyOwner)`. (a).

### 1.3 Fog aliases inside the engine — the desync landmine

| Site | Function | Code | Class |
|---|---|---|---|
| `gather.js:64` | `nextNodeAfterDepletion` | `unit.owner === "player" ? state.fog : state.fogAI` | **(a) — but urgent** |
| `scout.js:42` | `updateScoutMode` | `unit.owner === "player" ? state.fog : state.fogAI` | **(a) — but urgent** |
| `sim.js:70-71` | `tick` | `updateFog(state, state.fog, "player"); updateFog(state, state.fogAI, "ai")` | (a) |

All three become `state.fogs[unit.owner]` / a `for (const o of state.owners)` loop. Mechanically
trivial; see §2 for why they are the top-priority fix.

### 1.4 Skirmish-relevant player-only feature gates

| Site | Function | Code | Class | Consequence under N |
|---|---|---|---|---|
| `commands.js:155` | `issueMove` (formation/squad) | `if (leader.owner !== "player") { …plain per-unit spread…; return; }` | **(b)** | Every non-`"player"` seat silently loses the leader/follow squad mechanic — a real gameplay asymmetry between two humans. |
| `sim.js:241` | `updateUnit` | `if (!unit.order && canLogisticsType(unit.type) && unit.owner === "player") assignRepair(state, unit);` | **(b)** | **Auto-repair is skirmish-active** (`repair.js:104` is not Odyssey-gated). Every non-`"player"` seat's idle workers never auto-repair damaged buildings. |
| `sim.js:198`, `:225`, `:228`, `:231` | `updateUnit` | freighter shuttle / ferry / haul / service gated on `unit.owner === "player"` | (c)/Odyssey | Odyssey-only (`canLogisticsType`, `collectPoint`, `aiLogistics`) — out of scope for a skirmish MP port, but must be generalized if Odyssey ever goes multiplayer. |
| `sim.js:40` | `tick` | `else runAI(state, dt);` — one hardcoded AI drive | **(b)** | The single point where "there is one AI" is baked into the tick pipeline. |

### 1.5 Odyssey / meta layers — `(c)` wholesale

| File | Comparisons | Nature |
|---|---|---|
| `engine/galaxy.js` | **19** (`:187,195,257,258,260,323,415,416,422,434,469,491,492,693,767,912,930,947,999,1047,1158,1201,1232,1246,1427,1428,1429`) | The Odyssey open world models **one human capital seat + one AI neighbour per world**. `checkGalaxyRescue` (`:410-426`) scans for `b.owner === "player" && b.type === "command"`; `surrenderGalaxy` (`:434`) hardcodes `winner = "ai"`; freighter/spaceport/jump (`:912-1246`) are all player-only; `jumpCapital` (`:1427-1429`) re-fogs exactly two sides. |
| `engine/scenarios.js` | 4 comparisons + 23 construction literals (`:101,108,125,139,140,241,280,309,340,346,359,374,390,391,405,464,489,490,525,543,570,571,599,626,647,697,704`) | Scripted 1v1 missions (Convoy Escort / Pirate Raider). The header (`:1-25`) is explicit: two scenarios "differing only by which side the player commands". Freighter ownership flips via `state.scenario.freighterOwner` (`:697`) — a 2-valued switch. |
| `engine/colonyPolicy.js` | 3 (`:98`, `:107`, `:140`) | Odyssey background-colony automation; assumes exactly one human's colonies. |
| `engine/diplomacy.js` | 2 (`:54`, `:348`) + `:439` event | `dip.stance` is **a single scalar**: *this world's AI neighbour's attitude toward the human*. Genuinely 1v1 by data shape (see §5). |
| `engine/market.js` | 1 (`:241`) | `tradeables(state)` returns what `"player"` can trade. Trivially param'd, but the market is Odyssey-only. |
| `engine/wonder.js` | `:92` | `chargingPlayerWonder(state) → chargingWonderOf(state,"player")` — the generic form already exists at `:76`. (a). |
| `engine/victory.js` | `:53`, `:79`, `:86` | `checkEndlessLoss` / `checkEndlessWin` — Odyssey terminal checks. (c). |
| `engine/persist.js` | `:994` | Odyssey freighter validation. (c). |

### 1.6 Summary of engine literals by class

| Class | Count (comparison sites) | Where |
|---|---|---|
| **(a) trivially generalizable** | ~13 | fog aliases (3), `combat.js:94`, `techtree.js:144`, `wonder.js:92`, `market.js:241`, `state.js:279`, default params (many, but zero-logic) |
| **(b) needs a design decision** | ~14 | `controllerFor`/`otherOwner` + 7 ternary copies, `ownerDefs`, `map.bases[enemyOwner]` ×2, `commands.js:155`, `sim.js:241`, `sim.js:40`, `persist.js:726/729` |
| **(c) genuinely 1v1 / single-human** | ~26 | `galaxy.js` (19), `scenarios.js` (4), `colonyPolicy.js` (3), `diplomacy.js` (2), `victory.js` endless (3) |

---

## 2. `state.fog` / `state.fogAI` — who consumes them, and what breaks at 5 fogs

### 2.1 The shape today

`engine/state.js:230-233`:

```js
fogs,                   // per-owner fog of war, keyed by owner id — see engine/fog.js
fog: fogs.player,       // alias: the human player's fog (=== state.fogs.player)
fogAI: fogs.ai,         // alias: the AI's own fog, no longer omniscient (=== state.fogs.ai)
```

`test/ownerScaffold.test.js:36-44` pins that these are *the same objects*, not copies, and that
`Object.keys(state.fogs)` equals `state.owners`.

### 2.2 Consumer census (whole repo, non-test)

**Engine — `state.fogAI` (must all go):**
`galaxy.js:1428`; `sim.js:71`; `aiWorkers.js:123` (default param); `aiEconomy.js:520`
(default param); `gather.js:64`; `scout.js:42`; `persist.js:567`, `:712`, `:729`;
`types.js:338`.

**Engine — `state.fog` (must all go):**
`galaxy.js:260`, `:1427`, `:1429`; `sim.js:70`; `scenarios.js:139`, `:390`, `:570`;
`aiWorkers.js:137`; `gather.js:64`; `scout.js:42`; `persist.js:566`, `:711`, `:778`;
`types.js:336`.

**Render / HUD / input — `state.fog` used as *"the local viewer's fog"* (correct semantics, keep):**
`render.js:202-216` (the fog wash); `minimap.js:36-42`, `:83-99`; `renderNodes.js:26`;
`renderEffects.js:466`; `renderShared.js:254`; `inputCommands.js:58`, `:62`, `:69`;
`boot.js:675`.

**Tools:** `tools/selfplay.js:165` already reads `state.fogs[o]` per owner — the correct pattern.

### 2.3 What breaks with 5 fogs

Structurally: **nothing.** `state.fogs` is already a `{ [ownerId]: Fog }` map built by iterating
`owners` (`state.js:188-189`), and `createFog`/`updateFog` (`fog.js:34`, `:124`) already take the
owner as a parameter. Five fogs is `for (const id of owners) fogs[id] = createFog(map)` — which
is literally the code that runs today.

What breaks is **the aliases' meaning**, in three distinct ways:

**(i) `state.fogAI` becomes meaningless.** With 5 seats there is no "the AI". Every one of the
9 engine consumers above must resolve `state.fogs[owner]` from a bound owner instead. This is
mechanical (class (a)) but non-optional — `state.fogAI` cannot survive as a concept.

**(ii) `state.fog` becomes *client-local state living inside the deterministic sim state*.**
This is the dangerous one. The render/HUD layer's reading of `state.fog` as "my fog" is *correct
and desirable* — it is exactly the seam a multiplayer client wants. But `state.fog` currently
lives on the same object the deterministic simulation mutates. If a client rebinds
`state.fog = state.fogs[myOwner]` to keep 15 render call-sites working, then:

```js
// engine/gather.js:64  — inside the SIMULATION
const fog = unit.owner === "player" ? state.fog : state.fogAI;
```

…resolves, on client 2, to *client 2's* fog for units owned by `"player"`. `nextNodeAfterDepletion`
then picks a different retarget node (`gather.js:66-77` is fog-gated via `isNodeDiscovered`), the
worker walks somewhere else, and the two clients' simulations diverge — with no error, no crash,
and nothing the same-seed determinism test can catch, because it only ever runs one client.

`engine/scout.js:42` has the identical shape and drives `nearestUnexploredPoint` waypoints.

> **Action, ranked #1 in this audit:** replace `gather.js:64` and `scout.js:42` with
> `state.fogs[unit.owner]` **before** any client-side alias rebinding exists. Two lines. Zero
> behaviour change today (`state.fogs.player === state.fog` by construction). It converts a
> future silent-desync class into a non-event.

**(iii) Bandwidth/state-size.** A fog grid is `2 × cols × rows` bytes
(`fog.js:34-37`, `FOG_CELL_SIZE = 40`). On a Gigantic map (`sizeMult 4` → 6400×4000) that is
160×100 = 16 000 cells → 32 KB per owner per grid pair. Eight seats = ~256 KB of fog in state,
and `persist.js:566-567` serializes `explored` as a **JSON array of numbers** — roughly 32 000
characters per owner. An 8-seat Gigantic save's fog section alone approaches ~2 MB of JSON. This
is not a correctness problem but it is a real transport/persistence problem for a Hugging Face
Space; see §6.

### 2.4 Recommended target shape

- Delete `state.fogAI` outright.
- Keep `state.fogs` as the single source of truth; every engine read becomes `state.fogs[owner]`.
- Move "my fog" to a **view-layer** concept: `view.fog = state.fogs[view.localOwner]`, resolved
  in `boot.js`/`render.js`, never on `state`. If a compatibility alias is kept short-term,
  it must be *provably unread by `engine/`* — add a guard to `test/engine-purity.test.js`
  (it already scans `engine/` for forbidden identifiers; `\bstate\.fog\b|\bstate\.fogAI\b`
  is the same class of rule as `Math.random`).

---

## 3. `map.bases` — start positions for N seats

### 3.1 What exists

`engine/map.js:161-164`:

```js
const bases = {
  player: { x: width * 0.1, y: height * 0.5 },
  ai:     { x: width * 0.9, y: height * 0.5 },
};
```

Two fixed points, keyed by owner id, at 10%/90% width on the vertical midline.

### 3.2 The map is not merely "2-keyed", it is *mirror-symmetric by construction*

Every subsequent generation stage emits a **left/right mirrored pair** across the vertical
centreline:

| Stage | Lines | Mirror mechanism |
|---|---|---|
| Home ore doorstep | `map.js:175-180` | `bases.player.x + dx` / `bases.ai.x - dx` |
| Deposit clusters | `:183-194` | `width*0.2 + rng()*0.1w` / `width*0.8 - rng()*0.1w` |
| Build-critical guarantee seams | `:199-212` | same paired form; the *check* (`:206-207`) is done **only against `bases.player`** |
| World `extraClusters` | `:216-225` | same paired form |
| Frontier belt (`sizeMult ≥ 2`) | `:227-250` | mirrored belt |
| Hidden caches | `:252-268` | `cacheSpecs` carries an explicit `mirror` flag; `x` and `width - cx` |
| Terrain features | `:77-98` | spec tuple `[xFrac,yFrac,wFrac,hFrac,code,mirror?]`; `stamp(1-xf, …)` at `:96` |

So `map.bases` is not the constraint — **the entire fairness model is bilateral reflection.**
Adding a third base at, say, `(0.5W, 0.1H)` yields a start position with *no* home-ore doorstep
(`HOME_ORE_OFFSETS` is applied only to the two named bases), no near-base cluster, and no
guaranteed build-critical seam. It would be unplayable, not merely unbalanced.

### 3.3 Can it generate N start positions on the 11 worlds?

Not without a new generator. Concretely, N-player start generation requires:

1. **A symmetry group choice.** Bilateral reflection generalizes to *C<sub>n</sub> rotational
   symmetry* about the map centre — N bases at angle `2πk/N` on a circle of radius `r`, with every
   resource/terrain feature emitted N times under the same rotation. This is the standard RTS
   answer (and it degenerates correctly: N=2 on a wide map is *almost* today's layout, but **not
   byte-identical** — today's is a reflection, not a 180° rotation, and the y-offsets differ:
   `bases.player.x + dx, bases.player.y + dy` vs `bases.ai.x - dx, bases.ai.y + dy` at
   `map.js:177-179` reflects x but **not** y).
2. **Aspect-ratio work.** `MAP_WIDTH:MAP_HEIGHT = 1600:1000 = 1.6:1` (`map.js:21-22`). A 1.6:1
   rectangle hosts 2 bases well and 6 or 8 badly — rotational symmetry on a non-square field gives
   corner seats materially more usable ground than edge seats. Either the aspect ratio becomes
   N-dependent, or start positions go on an inscribed ellipse and accept mild asymmetry.
3. **`NEAR_BASE_FRAC` / guarantee-seam rework.** `map.js:206-207` checks build-critical proximity
   **only for `bases.player`** and then emits one mirrored pair. Under N it must check *every*
   base and emit *per-base* seams — which changes the number of `rng()` draws and therefore
   **every existing map layout**.
4. **`resolveNodeOverlaps` cost.** `map.js:369-393` is O(nodes²) × 40 iterations. Node count
   scales with seats (per-base home ore + clusters + seams). At 8 seats on a Gigantic map this is
   a materially larger generation cost; it is bounded (`RESOLVE_ITERATIONS = 40`) so it cannot
   hang, but it should be measured against `test/perf-guard.test.js`.

**Effort: L. Risk: high** — it is the one item in this audit that cannot be done without changing
the map for existing 2-player seeds unless the N=2 path is kept as a *separate branch*.

> **Recommendation:** keep `generateMap`'s current 2-base mirrored path **verbatim** as the
> `owners.length === 2` branch (preserving every existing seed, every replay, and
> `test/determinism-roster.test.js`), and add a *new* `generateRadialMap` for N ≥ 3. Two
> generators is honest; one generator that "also does 2" will not reproduce today's maps.

### 3.4 Asymmetric worlds (`swapAsym`) and `sideMod`

`engine/map.js:149-151`:

```js
const modifiers = (opts.swapAsym && worldModifiers.asym)
  ? { ...worldModifiers, asym: { player: worldModifiers.asym.ai, ai: worldModifiers.asym.player } }
  : worldModifiers;
```

Two asymmetric worlds exist: **nimbus** (`map.js:330`: `asym: { player: {sightMult:0.95}, ai: {speedMult:1.12} }`)
and **oort** (`map.js:352`: `asym: { player: {gatherMult:1.2}, ai: {buildTimeMult:0.82} }`).

Two independent problems:

- **`sideMod` is already N-safe and degrades correctly.** `map.js:113-120` does
  `const a = m.asym && m.asym[owner]; world = a && a[key] != null ? a[key] : (m[key] ?? dflt)`.
  A third owner simply misses the `asym` block and gets the shared world modifier. **No crash, no
  change needed** — but seats 3..N would play the *symmetric* version of an asymmetric world while
  seats 1–2 keep their edges. That is a silent balance bug, not a technical one. **(b).**
- **`swapAsym` is genuinely 1v1.** It is a 2-element permutation. Under N the concept becomes
  "assign each seat one of N asymmetric roles", i.e. a *seat→role assignment vector* derived
  deterministically from the seed. It is also a persisted generation input
  (`state.js:206`, `persist.js:500`) — changing its type is a save-shape change (§6).

> **Design decision required:** either (i) restrict asymmetric worlds to 2-seat matches,
> (ii) author N-role `asym` tables per world, or (iii) drop `asym` for N ≥ 3 and log it.
> Option (i) is the cheap, honest answer for v1.

### 3.5 `map.bases[enemyOwner]` consumers

`aiMilitary.js:589` (`chooseAttackTarget` fallback: "haven't looked at the enemy start yet — go
there") and `aiMilitary.js:694` (`updateScout`'s sweep toward the enemy). Both assume a *single*
enemy base. Under N they need "the nearest / most-threatening opponent's base", which is a
targeting-policy decision, not a lookup change. **(b).**

---

## 4. Victory — what is 1v1-shaped

### 4.1 Already N-generic (no change needed)

```js
// engine/victory.js:28-37
export function checkWinCondition(state) {
  if (state.over) return;
  const standing = ownersOf(state).filter(o => hasCommandCenter(state, o));
  if (standing.length === 0) { finish(state, scoreLeader(state), "mutual-wipe-score"); return; }
  if (standing.length === 1) { finish(state, standing[0], "elimination"); return; }
  const limit = state.matchTimeLimit ?? DEFAULT_MATCH_TIME_LIMIT;
  if (state.time >= limit) finish(state, scoreLeader(state), "timeout-score");
}
```

- `ownersOf` (`:11`) — iterates `state.owners`, falls back to `["player","ai"]` only for hand-built
  test stubs. **(a)** — the fallback should become `Object.keys(state.players)` or throw.
- `scoreBreakdown` (`:128`) / `playerScore` (`:147`) — per-owner, no literals. **No change.**
- `scoreLeader` (`:163-170`) — iterates owners, strict `>` keeps the first-listed side on a tie.
  **No change.** Note the tie-break precedence is `state.owners` order, documented at `:158-162`
  as "the defender's edge". Under N this becomes *seat-order advantage*, which for a competitive
  multiplayer game is a fairness question: seat 1 wins every exact tie. Worth a deliberate
  decision (randomize-by-seed? shared victory?), though exact ties are vanishingly rare.
- `test/ownerScaffold.test.js:55-78` **already proves 3-side elimination works.**

### 4.2 1v1-shaped — `(c)`

```js
// engine/victory.js:45-54  checkEndlessLoss
if (!hasCommandCenter(state, "player") && !hasColonyShip(state, "player")) finish(state, "ai");
```

```js
// engine/victory.js:75-89  checkEndlessWin
if (b.owner === "player") { … finish(state, "player"); }
if (state.inGalaxy && !b.rivalAscended) { …push({ type:"rivalGateComplete", owner:"ai", … }); }
```

Both are Odyssey terminal checks and are structurally "the human vs the AI". Out of scope for
multiplayer skirmish; must be redesigned if Odyssey ever goes multiplayer.

### 4.3 What N-player victory actually *needs* that does not exist

| Need | Present? | Notes |
|---|---|---|
| Last-side-standing over N | ✅ `victory.js:33` | Works today |
| Score tiebreak over N | ✅ `victory.js:163` | Works today |
| **Per-player elimination event** | ❌ | Nothing pushes an event when one seat loses its last CC. In a 5-player FFA, seat 3's defeat is a *first-class moment* (UI, MCP-agent notification, spectator feed) but the engine only notices when `standing.length === 1`. Needs `state.events.push({type:"ownerEliminated", owner})` + an `eliminatedAt` stamp. |
| **Defeated-but-alive semantics** | ❌ | A seat with no CC but a live army keeps being simulated, keeps fighting, and can still *decide* the match via `scoreLeader` — but can never win. Needs an explicit policy: auto-surrender-on-CC-loss (classic RTS), or "you're out, your units are removed", or "you play on as a spoiler". |
| **Surrender / disconnect** | ❌ | `surrenderGalaxy` (`galaxy.js:430-436`) exists only for Odyssey and hardcodes `winner = "ai"`. Multiplayer needs per-seat surrender that feeds the same `standing` filter. |
| **Teams / alliances** | ❌ | No team concept anywhere. `combat.js:342` (`a.owner !== target.owner` shields allies) defines "ally" as *literally the same owner*. Teams require a `teamOf(state, owner)` predicate threaded into: combat acquisition (`combat.js:153`, `:243`, `:386`, `:411`), aura shielding (`:342`), separation (`separation.js:105`), movement avoidance (`movement.js:181`), fog sharing (a real design fork: shared vision or not), and victory (`standing` → distinct teams). **Effort L, risk high.** |
| **Placement / ranking** | ❌ | `state.winner` is a single string. An N-player match wants an ordered finish list. `winner` should become `winner` + `placements: string[]`, which is a **save-shape change** (§6). |

> **Verdict:** victory is the *cheapest* subsystem to take to N for a free-for-all
> (approximately zero engine change) and one of the **most expensive** to take to *teams*.
> Ship FFA first.

---

## 5. Diplomacy / market / galaxy

### 5.1 Are they Odyssey-only? — Yes, all three, and cleanly gated.

`engine/sim.js:105-106`:

```js
if (state.market) updateMarket(state, dt);        // Odyssey: relax trade pressure
if (state.diplomacy) updateDiplomacy(state, dt);  // Odyssey: drift the neighbour's stance
```

Both are **presence-gated on a state field that only `engine/galaxy.js` ever sets**
(`galaxy.js:262-263`: `state.market = createMarket(state); state.diplomacy = createDiplomacy();`).
A skirmish `createGameState` never sets either. `checkEndlessWin`/`checkEndlessLoss` are gated on
`state.endless` (`sim.js:103`). `galaxy.js` itself is only imported by the Odyssey boot path.

**Consequence: a multiplayer skirmish port can leave all three modules untouched.** That removes
`19 + 2 + 1 = 22` of the 53 engine literals — 42% — from the critical path immediately.

### 5.2 Do they assume a single human? — Yes, structurally, not just by literal.

**`engine/diplomacy.js` — 1v1 by *data shape*, not by string.** The stance is one scalar per
world: `dip.stance` in `[-1, +1]`, meaning *this world's AI neighbour's attitude toward the human*.
The grievance signal is derived from the neighbour's unit-count delta (`:346-351`,
`if (u.owner !== "ai" …) continue`), and the war announcement targets the human
(`:439`: `state.events.push({ type: "neighbourHostile", owner: "player" })`). `aiDevelopment`
(`:52-61`) counts only owner `"ai"`'s buildings and reads `state.players.ai.upgrades` directly.
Generalizing means a stance **matrix** `stance[a][b]`, plus a policy for whether stance is
symmetric — a genuine feature redesign, not a refactor. **(c), effort L.**

**`engine/market.js` — nearly generic already.** Only `tradeables` (`:240-242`) hardcodes
`commodityAvailable(state, "player", c)`; the underlying `commodityAvailable` already takes an
owner. Prices/pressure/glut are **per-world, not per-owner** (`market.js:8-12`), which is
actually the *right* shape for multiplayer: N traders sharing one order book, with
`sell()`'s slippage naturally making the market a contested resource. **(a) for the one literal;
the module's economics need no redesign.** Credits live on the galaxy object, not the state
(`market.js:11-12`) — that *is* single-human and would need per-owner credits.

**`engine/galaxy.js` — single-human by construction.** "The player has a single, relocatable
Command Center: their capital seat travels with them via a Spaceport" (`:5-8`). One
`galaxy.activeId`, one `galaxy.discovered` set, one `galaxy.credits`, one
`checkGalaxyRescue` (`:410`), one `surrenderGalaxy` (`:430`). Multiplayer Odyssey is a
**different product**, not a generalization. **(c), effort XL — recommend explicit out-of-scope.**

---

## 6. Persistence

### 6.1 Current state: the serializer iterates owners; the deserializer does not

**Serializer — already generic (one line):**

```js
// engine/persist.js:517
players: Object.fromEntries((state.owners || Object.keys(state.players)).map(id => [id, serPlayer(state.players[id])])),
```

with the honest comment at `:513-516`:

> *"One entry per side, in state.owners order … The save shape stays two-keyed (fog/fogAI below
> likewise): a save FORMAT built for N sides is separate, deferred work."*

**Deserializer — hard 2-keyed:**

```js
// engine/persist.js:726-729
const players = { player: cleanPlayer(P.players.player), ai: cleanPlayer(P.players.ai) };
const owners = Object.keys(players);
const fogs = { player: fog, ai: fogAI };
```

with `fog`/`fogAI` built at `:711-712` from `P.fog` / `P.fogAI` (`:566-567`).

So a 3-owner state **serializes correctly and deserializes to a 2-owner state**, silently dropping
seat 3's economy and fog. That asymmetry is the concrete persistence bug.

### 6.2 Other 2-slot save fields

| Site | Field | Issue |
|---|---|---|
| `persist.js:566-567` | `fog: [...state.fog.explored]`, `fogAI: [...]` | Two named arrays. Must become `fogs: { [owner]: number[] }`. |
| `persist.js:569-607` | the `ai:` block | ~20 fields, each `state.ai.<x>`, wire-prefixed `aiThink`/`aiScoutId`/… |
| `persist.js:782` | `ai: cleanController(P.ai, "ai", P.planetId)` | one controller |
| `persist.js:785` | `playerAi: P.playerAi ? cleanController(P.playerAi, "pa", …) : null` | the second slot, with a *different wire prefix* (`"pa"`) |
| `persist.js:500` | `swapAsym` | 2-valued asymmetry switch (§3.4) |
| `persist.js:777` | `selection: []` | reset on load — see §8.5 |

Note `cleanController` (`persist.js:170`) is already prefix-parameterized, so an N-controller
save is `controllers: { [owner]: {…} }` with one shared field set — a *simplification*, not a
complication.

### 6.3 Does N require a `SAVE_VERSION` bump? — **Yes, unambiguously.**

`CONTRIBUTING.md` §3 (lines 57-70):

> *"Bump the relevant one whenever you change a save's shape in a way older saves can't survive.
> The version check is exact-match (`if (save.v !== SAVE_VERSION) throw`) — there is no migration
> step… If a change is purely additive (a new optional field with a sensible default), you usually
> don't need to bump."*

The N-player change is **not** purely additive:

- `fog`/`fogAI` → `fogs{}` **removes** two required fields that `rehydratePlanet:711-712`
  dereferences unconditionally (`Uint8Array.from(P.fog)` throws on `undefined`).
- `ai`/`playerAi` → `controllers{}` likewise.
- `winner: string` → `winner + placements[]` changes a consumed field's contract.
- `swapAsym: boolean` → a role-assignment vector changes a *generation input*, which changes the
  regenerated map.

So: **`SAVE_VERSION: 1 → 2`** (`persist.js:44`). `GALAXY_SAVE_VERSION` (`:45`) only needs a bump if
Odyssey is touched — recommend leaving it alone by keeping Odyssey out of scope.

There is no migration step in this codebase by design, so the bump makes every existing skirmish
save unloadable with a clear error (`persist.js:814`). That is the project's stated intent and is
acceptable — but note `test/save-shape.test.js`, `test/save-hardening.test.js`,
`test/sanitize.test.js`, `test/serialize-string.test.js`, `test/persist.test.js` and
`test/saveload.test.js` all assert on the current shape and will need coordinated updates.

**A transitional option worth considering:** keep `SAVE_VERSION = 1` for the 2-seat case by
emitting `fog`/`fogAI`/`ai`/`playerAi` *when and only when* `owners` is exactly
`["player","ai"]`, and emitting `v: 2` with the generic shape otherwise. This is ugly but keeps
every existing save loadable and lets the two formats coexist through the phased rollout. Whether
that is worth the branch is an ADR decision; the cost is one `if` in `serPlanet` and one in
`rehydratePlanet`.

### 6.4 Size

See §2.3 — fog dominates the payload, and it scales linearly in seats. `serializeGameString`
(`persist.js:809`) already exists specifically because "the fog arrays are large" (`:805-808`).
For 8 seats consider a run-length or bitset encoding of `explored` (it is a `Uint8Array` of 0/1);
that is an independent, save-version-gated optimization worth doing at the same bump.

---

## 7. AI controllers — from 2 slots to `state.controllers[owner]`

### 7.1 What exists

Two named slots:
- `state.ai` — always present, created by `createAiController(planetId, {...})` at `state.js:239-248`.
- `state.playerAi` — `null` in every shipped match; populated **only** by
  `tools/selfplay.js:88-91` (a headless bench). See `state.js:250-260`.

Resolution is centralized in `aiCommon.js:32-36`… **and then hand-rolled seven more times**:

```js
// aiIntel.js:182, :199, :279, :315 ; aiDifficulty.js:118 ; aiStrategy.js:145 ; aiIndustry.js:103
const controller = owner === "ai" ? state.ai : state.playerAi;
```

The duplication is deliberate and documented — `aiDifficulty.js:113-115` and `aiStrategy.js:141-142`
both say *"deliberately NOT an import of engine/aiCommon.js's controllerFor, so this file stays the
pure, import-free leaf its header describes."* That is a real constraint
(`test/static-integrity.test.js` enforces an import SCC check per `aiCommon.js:10-14`), and it means
an N-controller refactor cannot simply "call `controllerFor` everywhere" — it must either
(i) accept the import, (ii) pass the controller in, or (iii) move the registry to a new
import-free leaf module that `aiCommon`, `aiIntel`, `aiDifficulty`, `aiStrategy` and `aiIndustry`
can all depend on.

**Option (iii) is the right answer:** a new `engine/controllers.js` leaf exporting
`controllerFor(state, owner)` with zero engine imports.

### 7.2 What reads `state.ai` directly across the repo (non-test)

| File:line | Read | Note |
|---|---|---|
| `engine/persist.js:569-607` | ~20 × `state.ai.<field>` | **Unguarded** — throws if `state.ai` is null |
| `engine/diplomacy.js:195` | `state.ai.archetype && state.ai.archetype.odyssey` | **Unguarded** — Odyssey only |
| `engine/combat.js:94` | `state.ai?.micro` | Optional-chained, null-safe |
| `engine/aiIntel.js:182,199,279,315` | via ternary | Null-guarded (`if (!controller) return`) |
| `engine/aiDifficulty.js:118` | via ternary | Null-safe (falls back to `medium`) |
| `engine/aiStrategy.js:145` | via ternary | Null-safe (falls back to `STRATEGIES.default`) |
| `engine/aiIndustry.js:103` | via ternary | — |
| `tools/selfplay.js:166`, `tools/selfplay-cli.js:40`, `tools/duelCore.js:114-115`, `tools/ailab.js:341` | direct | Bench/CLI |
| **Tests** | **39 of 115 test files** touch `state.ai` / `state.playerAi` | The blast radius |

**The two unguarded reads matter for phasing:** nulling `state.ai` for a human-vs-human match
breaks saving (`persist.js:569`) immediately. See §9.

### 7.3 Proposed N-controller design

```js
// engine/state.js — createGameState
state.controllers = {};                 // { [ownerId]: AiController | null }
for (const d of ownerDefs)
  state.controllers[d.id] = d.isAI ? createAiController(planetId, d.aiOpts) : null;
```

with:

- `engine/controllers.js` (new, import-free leaf):
  `export const controllerFor = (state, owner) => state.controllers?.[owner] ?? null;`
- `state.ai` / `state.playerAi` kept as **getter aliases** during the transition
  (`Object.defineProperty(state, "ai", { get: () => state.controllers.ai })`) so 39 test files
  and 4 tools files keep working — **but note this breaks `JSON.stringify` shape expectations**,
  so `persist.js` must be updated in the same change, not after.
- `sim.js:40` becomes:
  ```js
  if (state.scenario) updateScenario(state, dt);
  else for (const o of state.owners) if (state.controllers[o]) runAI(state, dt, o);
  ```

### 7.4 ⚠️ The controller-ordering fairness bug is already measured and documented

`tools/selfplay.js:104-127` is unusually candid and is a **direct design input**:

> *"This comment used to claim both controllers think on the IDENTICAL pre-tick snapshot. They do
> not. runAI(…, "player") is not a read: issueBuild inserts into state.buildings immediately…
> Measured over 400 player think-cycles in a 10-sim-minute korrath match: orders differed on 13% of
> cycles, queues and resources on 6%, and buildings on 1%. … Small, but FIXED IN DIRECTION: it
> always favours the "ai" seat, every cycle, in every duel and Swiss match."*

Cause: `tickSelfPlay` (`selfplay.js:129-132`) calls `runAI(state, dt, "player")` and *then*
`tick(state, dt)`, which internally calls `runAI(state, dt)` for `"ai"`. The second controller
reads a world the first has already mutated.

Under N controllers this bug becomes **N-fold and order-dependent**: seat 1 always acts on a clean
world, seat N always acts on a world 
N-1 seats have already changed. For a competitive multiplayer
RTS with agent seats that is not acceptable.

> **This is the single strongest argument for doing the controller work properly rather than
> incrementally.** The fix is architectural: either (i) all controllers read a frozen pre-tick
> snapshot and emit *command lists* applied in a deterministic order, or (ii) controller order is
> rotated deterministically per tick (`state.tick % owners.length`). Option (i) is also exactly the
> shape a lockstep/command-log netcode and an MCP agent API want — **the same refactor pays for
> multiplayer, agent play, and fairness at once.** `tools/selfplay.js:120-127` explicitly defers
> this as "Tier 3" work; the multiplayer port is the moment to do it.

Note also `state.playerAi`'s wire prefix in saves is `"pa"` (`persist.js:785`) vs `"ai"` — a
generic registry removes that wart.

---

## 8. Determinism risks under N players

The guarantee (`CONTRIBUTING.md:35-39`): *"Two runs from the same seed must produce byte-identical
state, on every world. … watch iteration order and float-accumulation order especially."*
Enforced by `test/determinism.test.js`, `test/determinism-roster.test.js` (11-world sweep,
`:16-51`), and `test/engine-purity.test.js` (`FORBIDDEN = Math.random|Date.now|new Date|performance.now`,
`:17`).

### 8.1 Owner ids do NOT feed the RNG — renaming seats is safe

Verified: every `hashStr` call site keys off an **entity id** or a **world/seed string**, never an
owner id:
- `gather.js:47` — `hashStr(unitId)` (worker orbit angle)
- `separation.js:132` — `hashStr(idA + idB)` (dodge direction)
- `bomb.js:219`, `wreckage.js:232`, `:252`, `rig.js:58` — entity/site ids
- `diplomacy.js:457` — `hashStr(\`${state.planetId}:${state.seed}:favor:${bucket}\`)`

**Consequence: renaming `"player"`/`"ai"` to `"p1"`/`"p2"` (or to session-scoped seat ids) does not
change any replay**, provided `map.bases` is re-keyed and iteration order is preserved.

### 8.2 Entity-id minting order is the real constraint — and appending is safe

`state.js:270`: `for (const id of owners) seedPlayer(state, id, map.bases[id]);`
`seedPlayer` (`state.js:311-329`) mints CC then 3 workers per owner, from a counter reset to 1 at
`state.js:161`.

So `owners = ["player","ai"]` mints `b1,u1,u2,u3` then `b2,u4,u5,u6`. **Appending a third owner
yields `b3,u7,u8,u9` and leaves every existing id untouched** — so ids, and therefore the
id-hashed tie-breaks and the id-string tie-breaks, are preserved for the original two seats.

**Reordering `state.owners`, however, silently reassigns every id and diverges every replay.**
`state.owners` order is therefore a **load-bearing, seed-equivalent input**. It must be:
- derived deterministically (lobby seat order, sorted, or seed-shuffled — but *decided once* and
  persisted),
- persisted (it is, implicitly, via `players` key order at `persist.js:517`),
- and **asserted** in a test. Recommend extending `test/ownerScaffold.test.js` with
  "appending an owner does not change the ids minted for existing owners".

### 8.3 Tie-break helpers are string-lexicographic, not numeric

Ubiquitous pattern: `n.id < best.id` (`gather.js:74`, `:189`, `:195`, `:208`;
`haul.js:291`, `:332`, `:367`; `wonder.js:82`; `wreckage.js:138`; `aiMilitary.js:429`;
`commands.js:105`; `galaxy.js:918`, `:1014`, `:1052`, `:1062`).

Ids are `u1`, `u2`, … `u10`, so `"u10" < "u9"` lexicographically. This is **deterministic but
non-monotonic in creation order**. Adding seats pushes entity counts into new digit-widths sooner
(`u100+`), which *reshuffles* tie-break precedence relative to a 2-player game — harmless for
correctness, invisible to a same-seed replay of the *same* configuration, but it means **a
3-player game is not "a 2-player game plus one"** at the tie-break level. Do not expect
cross-configuration fingerprint stability; do not write tests that assume it.

### 8.4 Float-accumulation order

The per-tick pipeline iterates `state.units` / `state.buildings` (JS `Map`, insertion-ordered) —
`sim.js:68` (`updateUnit`), `:72-84` (buildings), `combat.js` acquisition, `collectAnvils`
(`sim.js:117-137`). Damage/resource accumulation therefore depends on Map insertion order.

The codebase already defends this well: `countMiners`, `countLogistics`, `countRepairJobs`,
`countMenderTargets`, `collectAnvils` are all **frozen at tick start before any mutation**
(`sim.js:44-62`), with explicit comments citing determinism (`sim.js:46-47`, `:52-54`). Object-key
iteration is explicitly sorted where it matters (`haul.js:232`: `Object.keys(s).sort()`;
`colonyPolicy.js:114-116` documents that `floors` is a plain object with insertion order).

**Residual N-risk:** none that is *new in kind*. Adding owners adds entities, which changes
accumulation order — but that is a different configuration, not a broken guarantee. The
`Set` instances in `engine/` (surveyed: `diplomacy.js:71`, `market.js:41`, `:91`, `haul.js:408-411`,
`techtree.js:202`, `:243`, `aiMilitary.js:275`, `rig.js:38`, plus `galaxy.js`/`persist.js` galaxy
sets) are all either constant lookup sets or membership tests, **not iterated for accumulation**
in the skirmish path. Verify `aiMilitary.js:275` (`strikeIds`) stays membership-only if that code
is touched.

### 8.5 Client state inside sim state

`state.selection` (`state.js:231`, typed at `types.js:335`) is *"unit/building ids currently
selected by the human player"* — a **single viewer's** selection living on the deterministic sim
object. It is mutated by `removeEntity` (`state.js:347`) and cleared by `galaxy.js:1422`; it is
reset to `[]` on load (`persist.js:777`); and crucially **nothing in the sim reads it to make a
decision** (all `selection` references in `commands.js`/`formation.js` are comments about
caller-supplied unit arrays, not reads of `state.selection`).

So it is not a determinism hazard today — but it *is* per-client state on a shared object, and in
a multiplayer client it must move to the view layer alongside `state.fog` (§2.4). Leaving it
would mean either every client sees the same selection or the sim object differs per client.

### 8.6 Where adding owners could silently change *existing* replays

| Mechanism | Changes existing 2P replays? | Mitigation |
|---|---|---|
| Appending a 3rd owner to `ownerDefs` | **No** — ids preserved (§8.2) | Add a regression test |
| Reordering `state.owners` | **Yes** — every id reassigned | Freeze order; assert it |
| Renaming owner ids | **No** (§8.1) — provided `map.bases` re-keyed | Assert `map.bases` keys ≡ `state.owners` |
| Per-base guarantee-seam rework in `map.js` (§3.3) | **Yes** — changes the `rng()` draw count | Keep the N=2 generator path verbatim |
| Rotational map symmetry replacing reflection | **Yes** — different node coordinates | Separate `generateRadialMap` for N≥3 |
| `combat.js:94` → `controllerFor(state, unit.owner)?.micro` | **Only for self-play/micro-enabled runs**; `micro` is false by default and in all tests | Re-baseline `test/ai-selfplay.test.js`, `test/duelCore.test.js` |
| Controller-ordering fix (§7.4) | **Yes for self-play/duels** — that is the point | Re-baseline Elo/duel fixtures deliberately |
| Extra fogs / extra entities | No — different configuration, still deterministic | — |

---

## 9. Verdict: is a phased approach viable?

## **Yes — ship 2-player human-vs-human first. The engine cost is roughly 10 lines. But it is not zero, and three specific asymmetries would ship as bugs if the phase is taken literally.**

### 9.1 Why Phase 1 (2P HvH) is genuinely cheap — the evidence

Keep `state.owners = ["player","ai"]` verbatim. Seat A drives owner `"player"`; seat B drives owner
`"ai"`. Then:

| Subsystem | Change needed for 2P HvH | Evidence |
|---|---|---|
| Combat / targeting / splash / auras | **none** | `combat.js:153,243,342,386,411` compare `e.owner === unit.owner` |
| Movement / separation / avoidance | **none** | `movement.js:181`, `separation.js:105` |
| Gather / haul / drop-off | **none** (except the fog line) | `gather.js:182,192,206`; `haul.js:284,324,362,589` |
| Supply / pop cap | **none** | `supply.js:33,48` take `owner` |
| Production / research / industry | **none** | `production.js:26`; `entities.js:773,790`; `industry.js:145,167,237,255` |
| Fog | **none** structurally | `fog.js:135,140` take `owner`; `state.fogs` already per-owner |
| Victory | **none** | `victory.js:28-37` already last-side-standing; `test/ownerScaffold.test.js:55` proves 3 sides |
| Map | **none** | 2 bases already exist, already mirrored, already fair |
| Persistence | **none** for the 2-key shape | `persist.js:517` iterates; `:726` already expects exactly these 2 keys |
| Faction traits / `sideMod` | **none** | `map.js:113-120` is owner-parameterized |
| Per-owner colours in render | **none** | `renderBuildings.js:75`, `renderUnits.js:66`, `minimap.js:95,100` read `state.players[owner].color` |
| **`SAVE_VERSION`** | **no bump** | The shape is unchanged |

### 9.2 What Phase 1 *does* cost

**Engine (≈10 lines, all class (a)):**

1. `gather.js:64` → `state.fogs[unit.owner]` — **mandatory, desync-critical** (§2.3).
2. `scout.js:42` → `state.fogs[unit.owner]` — same.
3. `sim.js:70-71` → `for (const o of state.owners) updateFog(state, state.fogs[o], o);`
4. `sim.js:40` → drive AI only for seats that have a controller.
5. `persist.js:569-607` → null-guard the `ai:` block, **or** keep a dormant `state.ai` object and
   never tick it. *(The dormant-object route is 0 lines here but leaves `combat.js:94`'s
   `state.ai?.micro` able to grant seat B free kiting — pick one, deliberately.)*

**Three asymmetries that must be fixed or Phase 1 ships unfair:**

6. **`commands.js:155`** — `if (leader.owner !== "player")` means **seat B loses the entire
   leader/follow squad formation mechanic**. Seat A gets `formationSlots` + speed-capped squad
   movement; seat B gets a plain per-unit spread. This is a visible, competitive gameplay
   difference between two humans.
7. **`sim.js:241`** — `assignRepair` is gated on `unit.owner === "player"`, and `repair.js:104` is
   **not** Odyssey-gated. **Seat B's idle workers never auto-repair damaged buildings.** In a
   skirmish where base damage is routine, this is a material economic edge for seat A.
8. **`combat.js:94`** — kiting is gated on `unit.owner === "ai"`. If micro is enabled, only seat B
   kites; if `state.ai` is nulled, neither does. Either way it is not symmetric by construction.

All three want the same new predicate — `isHumanControlled(state, owner)` or, better,
`controllerFor(state, owner) === null` — not a literal. That predicate is also exactly what
Phase 2 needs.

**Client (the larger half of Phase 1):**

9. A `localOwner` seam replacing the 80 non-engine `"player"` literals — `inputCommands.js` (16),
   `input.js` (5), `hudSelection.js` (7), `hud.js` (6), `boot.js` (6), `renderBuildings.js` (6),
   `renderEffects.js` (4), `landingPicker.js` (4), `hudPanelSignature.js` (4), etc.
10. Rebinding "my fog" — **only after items 1–3 land** (§2.3).
11. `state.selection` moves to the view layer (§8.5).

**Effort: engine S, client M. Risk: low for the engine, medium for the client.**

### 9.3 Why phasing is the right call (not just possible)

- **Phase 1 requires no `SAVE_VERSION` bump and no map-generator change** — the two most
  destructive, least-reversible items in this audit stay untouched.
- **Phase 1's engine work is a strict subset of Phase 2's.** Every one of items 1–8 is a change
  Phase 2 needs anyway: fog-by-owner, controller-registry-driven AI dispatch, and an
  `isHumanControlled` predicate. **Nothing is thrown away.**
- **Phase 1 makes the netcode/agent problem observable before the N problem is layered on it.**
  Lockstep desync, command ordering and the `tools/selfplay.js:104-127` fairness bug are all
  2-player-visible. Debugging them at N=2 with byte-identical replays available is dramatically
  cheaper than at N=5.
- **The tests stay meaningful.** All 115 files and 2519 tests keep passing at Phase 1: owner ids,
  save shape, map layout and entity-id minting are all unchanged, so
  `test/determinism.test.js`, `test/determinism-roster.test.js` and the golden HUD/render tests
  are untouched. That is *not* true of Phase 2, where the map generator and save version move.

### 9.4 Recommended phase boundaries

| Phase | Content | `SAVE_VERSION` | Map gen | Determinism baseline |
|---|---|---|---|---|
| **1 — 2P HvH** | fog-by-owner in engine; controller-registry AI dispatch; `isHumanControlled` predicate for the 3 asymmetries; client `localOwner`; view-layer fog + selection | 1 (no bump) | unchanged | **preserved** |
| **2 — N seats, FFA, ≤2 asymmetric-world seats** | `ownerDefs` from lobby; `state.controllers{}`; `opponentsOf()` replacing `otherOwner`; N-fog/N-controller save shape; elimination events; surrender | **2** | 2-seat path verbatim + new `generateRadialMap` for N≥3 | re-baselined for N≥3; **2-seat replays preserved** |
| **3 — controller-ordering fairness + agent/MCP command API** | frozen-snapshot command emission, deterministic apply order | 2 | unchanged | **re-baselined deliberately** (duel/Elo fixtures) |
| **4 — teams / alliances** | `teamOf()` threaded through combat, auras, separation, avoidance, fog sharing, victory | 3 | unchanged | re-baselined |
| **Out of scope** | Odyssey multiplayer (`galaxy.js`, `diplomacy.js`, `colonyPolicy.js`, market credits), multiplayer scenarios (`scenarios.js`) | — | — | — |

---

## 10. Summary table of change-sites

Effort: **S** ≤ ~20 lines · **M** ~a file · **L** a subsystem · **XL** a product.
Risk: probability × blast radius of a silent regression.

| # | Site | What | Class | Effort | Risk | Phase |
|---|---|---|---|---|---|---|
| 1 | `engine/gather.js:64` | `unit.owner === "player" ? state.fog : state.fogAI` → `state.fogs[unit.owner]` | (a) | S | **high** (desync landmine) | 1 |
| 2 | `engine/scout.js:42` | same | (a) | S | **high** | 1 |
| 3 | `engine/sim.js:70-71` | two `updateFog` calls → loop `state.owners` | (a) | S | low | 1 |
| 4 | `engine/sim.js:40` | `else runAI(state, dt)` → per-owner controller dispatch | (b) | S | med | 1 |
| 5 | `engine/commands.js:155` | `leader.owner !== "player"` gates squad/formation | (b) | S | med (silent unfairness) | 1 |
| 6 | `engine/sim.js:241` | `assignRepair` gated on `"player"` — skirmish-active | (b) | S | med (silent unfairness) | 1 |
| 7 | `engine/combat.js:94` | `state.ai?.micro && unit.owner === "ai"` → `controllerFor(state, unit.owner)?.micro` | (a) | S | med (fingerprint-changing for micro runs) | 1 |
| 8 | `engine/persist.js:569-607` | `ai:` block dereferences `state.ai` unguarded | (b) | S | med (throws on save) | 1 |
| 9 | Client: 80 literals in `inputCommands.js`/`input.js`/`hud*.js`/`render*.js`/`boot.js` | `"player"` → `localOwner` | (b) | **M** | med | 1 |
| 10 | Client: `state.fog` alias + `state.selection` → view layer | per-viewer state off the sim object | (b) | M | med | 1 |
| 11 | `engine/state.js:178-181` | `ownerDefs` from lobby config | (b) | S | low | 2 |
| 12 | `engine/aiCommon.js:32-36` + 7 ternary copies (`aiIntel.js:182,199,279,315`; `aiDifficulty.js:118`; `aiStrategy.js:145`; `aiIndustry.js:103`) | → new import-free `engine/controllers.js` leaf | (b) | M | med (SCC/import-purity constraint) | 2 |
| 13 | `engine/aiCommon.js:43` `otherOwner` | → `opponentsOf(state, owner)` (+ threat/target policy) | (b) | **L** | **high** (rewires all AI targeting) | 2 |
| 14 | `engine/ai.js:138`, `aiIntel.js:145`, `aiMilitary.js:446,552,572,633` | `enemyOwner` single-value → set | (b) | L | high | 2 |
| 15 | `engine/aiMilitary.js:589,694` | `state.map.bases[enemyOwner]` → target-selection policy | (b) | M | med | 2 |
| 16 | `engine/state.js:232-233` + all `state.fogAI` engine reads | delete the aliases | (a) | S | low (after #1-3) | 2 |
| 17 | `engine/persist.js:726,729` | 2-keyed `players`/`fogs` rebuild → iterate save's owner list | (b) | S | med | 2 |
| 18 | `engine/persist.js:566-567,782,785` + `SAVE_VERSION:44` | `fogs{}`/`controllers{}`; bump 1→2 | (b) | M | **high** (all saves invalidated; 6 test files) | 2 |
| 19 | `engine/map.js:161-164` + all mirrored stages (`:175-268`, `:94-96`) | new `generateRadialMap` for N≥3; keep N=2 verbatim | (b) | **L** | **high** (map layout / balance / perf) | 2 |
| 20 | `engine/map.js:149-151` + `nimbus`/`oort` `asym` (`:330`, `:352`) | `swapAsym` 2-permutation → seat-role vector, or restrict asym worlds to 2 seats | (b) | M | med (balance) | 2 |
| 21 | `engine/victory.js:11` | `ownersOf` fallback `["player","ai"]` | (a) | S | low | 2 |
| 22 | `engine/victory.js` (new) | elimination events, defeated-but-alive policy, surrender, `placements[]` | (b) | M | med | 2 |
| 23 | `tools/selfplay.js:129-132` + `engine/sim.js:40` | controller-ordering fairness (frozen snapshot / rotated order) | (b) | **L** | **high** (deliberate replay re-baseline; Elo fixtures) | 3 |
| 24 | Teams: `combat.js:153,243,342,386,411`; `separation.js:105`; `movement.js:181`; fog sharing; `victory.js` | thread `teamOf(state, owner)` | (b) | **L** | **high** | 4 |
| 25 | `engine/diplomacy.js` (`:54,348,439` + scalar `dip.stance`) | stance scalar → matrix | (c) | L | high | out |
| 26 | `engine/galaxy.js` (19 sites, single capital seat, `galaxy.credits`) | multiplayer open world | (c) | **XL** | high | out |
| 27 | `engine/colonyPolicy.js:98,107,140`; `engine/market.js:241` | per-owner colony automation / tradeables | (c) | S–M | low | out |
| 28 | `engine/scenarios.js` (27 sites, `freighterOwner` 2-switch) | multiplayer missions | (c) | L | med | out |
| 29 | `engine/victory.js:53,79,86` | Odyssey terminal checks | (c) | S | low | out |
| 30 | `test/ownerScaffold.test.js` (extend) | assert id-minting stability on owner append; assert `map.bases` keys ≡ `state.owners` | — | S | low (**guard**) | 1 |
| 31 | `test/engine-purity.test.js` (extend) | forbid `state.fog` / `state.fogAI` inside `engine/` | — | S | low (**guard**) | 1 |

---

## 11. Open questions for the ADR

1. **Seat identity.** Keep `"player"`/`"ai"` as seat 1/2 ids through Phase 1 (cheapest, preserves
   every save and replay), or rename to `p1..pN` immediately (cleaner, and §8.1 shows it is
   replay-safe)? Renaming still requires re-keying `map.bases` and the two `asym` tables.
2. **Owner order authority.** `state.owners` order is a seed-equivalent input (§8.2). Who fixes it
   — lobby join order, sorted seat id, or seed-derived shuffle? It must be decided once and
   asserted.
3. **Tie-break fairness.** `scoreLeader` (`victory.js:163`) gives seat 1 every exact tie. Acceptable
   for competitive N-player, or randomize by seed?
4. **Defeated-seat policy.** Auto-surrender on last-CC loss, or play on as a spoiler that can still
   swing `scoreLeader`?
5. **Save compatibility.** Bump `SAVE_VERSION` to 2 outright, or run the dual-shape transitional
   scheme in §6.3?
6. **Asymmetric worlds at N≥3.** Restrict to 2 seats (recommended for v1), author N-role tables, or
   drop `asym` for N≥3?
7. **Controller ordering.** Do the frozen-snapshot command-list refactor in Phase 3 as scheduled,
   or pull it into Phase 1 because the MCP agent API wants the same shape anyway? (Argument for
   pulling it in: it is the one refactor that serves netcode, agent play and the already-measured
   fairness bug simultaneously.)
8. **Fog encoding.** Bitset/RLE `explored` at the same save bump (§6.4), given 8-seat Gigantic
   payloads approach ~2 MB of JSON?
