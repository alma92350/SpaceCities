# Game Improvement Proposals — All Dimensions, By Tier

*2026-07-31 — produced by a fanned-out team of nine dimension agents (one per game system, each reading its slice of the engine, tests, and design docs) plus a completeness critic run over the combined set. 71 proposals total.*

This is a proposal catalog, not a commitment. Every entry is grounded in code that was actually read — the **Where** line names the files and functions a developer would start from — and every entry was written under the project's standing invariants:

- **Determinism** — same seed ⇒ same game; no wall-clock or unseeded randomness in `engine/`.
- **Engine purity** — `engine/` never touches the DOM.
- **No build step, no runtime dependencies.**
- **The resource law** — everything is paid in gathered commodities; no new abstract currencies.
- **Skirmish/Odyssey separation** — Odyssey-only systems stay inert in skirmish, per the `odysseyOnly` pattern.

## How to read this

Proposals are organized by the game's own progression ladder — the tier a player is living in when the improvement would land — then grouped by dimension within each tier. Each proposal carries an **effort** grade (S/M/L) and an **impact** grade (1–5, how much better the game gets for players if shipped). The [shortlist](#the-shortlist) is the critic's pick of the best impact-per-effort across the whole set; the [review section](#review-merges-conflicts-and-open-gaps) lists which proposals are the same idea twice, which collide and need a decision first, and which parts of the game no agent claimed.

## Coverage matrix

| Dimension | T1 | T2 | T3 | Strategic | Cross | Total |
|---|---|---|---|---|---|---|
| Combat & Units | 2 | 2 | 2 | 1 | 1 | 8 |
| Economy & Logistics | 2 | 2 | 2 | 1 | 1 | 8 |
| Tech, Research & Industry | 1 | 3 | 3 | 1 | — | 8 |
| Defense, Superweapons & Victory | 1 | 2 | 1 | 3 | 1 | 8 |
| AI Opponent | 1 | 1 | 2 | 3 | 1 | 8 |
| Odyssey Meta-Layer | 2 | 1 | 3 | 2 | — | 8 |
| Worlds, Maps & Terrain | 1 | 2 | 2 | 1 | 1 | 7 |
| UX, HUD & Controls | 2 | 2 | 3 | 1 | — | 8 |
| Presentation & Platform | 1 | 1 | 2 | 2 | 2 | 8 |
| **All** | **13** | **16** | **20** | **15** | **7** | **71** |

## The shortlist

The critic's twelve green-light-first picks, chosen for player impact per unit of effort and spread across tiers and dimensions:

1. Surface the counter-triangle on unit buttons and selection rows — S-effort fix to the game's core literacy at the exact moment of the production decision; absorb Combat's bonus-hit telegraph as its in-battle half.
2. Gatherers roll to the next seam when a node runs dry — the player is the only agent in the game without depletion self-healing (the AI has assignIdleWorkers); kills a silent T1 income cliff every match hits.
3. Let the player choose (or reroll) their starting world — S effort since the skirmish card grid already exists; returns the Odyssey's most consequential decision to the player while keeping random as the default.
4. Teach the AI's counter-pick about out-of-triangle units / Soft-answer fallback (merged duplicate pair) — restores the README's central AI promise exactly at the tier where blind spots decide games, and it is mostly a data-table fix.
5. Teach the AI to read a turret wall and answer with Breachers — the test suite proves the turtle is currently uncounterable; this must land before any of the three proposed new static-defense structures does.
6. Range-layered formation ranks: brawlers screen, artillery trails — turns an existing cosmetic feature into the T2 tactical payoff with a pure slot-assignment sort, no new content.
7. Grid Substation: a passive one-hop relay that extends power-grid reach — one cheap building makes the whole power layer produce base-layout decisions instead of the current single dense blob.
8. Starmap world dossiers: deposits and world rules — S effort (skirmish cards already print this data); fixes blind jump/settle decisions and resolves the free-vs-paid intel conflict in favor of the game's own charted-knowledge doctrine.
9. Make the clock endgame visible, honest, and configurable — removes a factually false game-over message and makes the guaranteed terminal state (the score race) visible, learnable, and playable.
10. Persistent Antimatter Gate charge strip — S effort; puts the finale's entire clock on screen while the player is off defending it, and makes a starved or throttled charge diagnosable instead of silent.
11. Give the Leviathan a real capital-ship hull — S effort; the endgame flagship currently renders below the Dreadnought via the generic fallback; ship it with the full-roster render smoke test so no roster addition falls through silently again.
12. The rival Gate (merge the Defense and AI twins) — the one L-size bet worth green-lighting now: two dimensions independently converged on it, and it gives the play-forever sandbox the external clock and two-directional finale that several other Strategic proposals quietly assume.

## Tier 1 — Opening

*The first minutes: Workers, the Skiff/Bastion/Lancer counter-triangle, Command Center / Barracks / Refinery / Habitat / Sentinel Turret / Market, raw goods, and the Assault-vs-Bulwark doctrine pick.*

### Combat & Units

#### Counter-triangle telegraphs: flag bonus hits and surface matchups in the HUD

*Effort: small · Impact: 3/5*

**Problem.** The triangle is the game's core opening lesson (README, entities.js header comment), but it is invisible in play: performAttack (engine/combat.js ~line 151) pushes an attackHit event carrying only position/type/owner and a 'heavy' flag for siege-vs-building hits, so a Skiff hitting a Lancer (bonus) draws exactly the same tracer as a Skiff futilely plinking a Bastion. Players can only learn the counters by reading the README or losing repeatedly.

**Change.** Telegraph counter damage: stamp a 'bonus' flag on the attackHit event whenever bonusVs applied, render bonus tracers/impacts in a hotter color and slightly thicker, and list each selected unit's 'Strong vs / Weak vs' relationships in the side panel (derived from the UNITS bonusVs tables, the same derivation aiMilitary.js's COUNTER_OF already does). Zero sim behavior change — pure event/UI clarity.

**Where.** engine/combat.js performAttack: add `bonus: !!(def.bonusVs && def.bonusVs[target.type])` to the pushed attackHit event (events are already replay-inert). effects.js spawnTracer + renderEffects.js (tracers loop ~line 131, tracerColor ~line 101): branch on the flag for color/width and a brighter impact flash. hudSelection.js unit info: compute 'strong vs' from def.bonusVs and 'weak vs' by inverting all UNITS bonusVs tables (reuse the COUNTER_OF reduce shape from engine/aiMilitary.js ~line 27). No engine state, no save shape change.

#### Patrol: looping attack-move waypoints

*Effort: medium · Impact: 3/5*

**Problem.** Ctrl+right-click builds a one-shot waypoint chain (input.js; dispatch/orderQueue in engine/commands.js ~line 28) and combat units attack-move along it, but the chain ends and the units go idle. There is no way to keep Skiffs sweeping the approach lanes or screening the mineral line — the exact harass/vision job the fast-cheap T1 unit is built for (entities.js: 'it wins by harassment') — without re-issuing orders every pass. No patrol exists anywhere in engine/ (verified by grep).

**Change.** A patrol order: combat/scout units cycle their waypoint chain indefinitely with attack-move semantics (engage anything encountered, resume the loop). Issue via a modifier on the waypoint chain (e.g. Ctrl+Shift+right-click) or a P-key conversion of the current queue.

**Where.** engine/commands.js: issuePatrol(units, points) builds orderQueue entries {type:'attack-move', x, y, patrol:true} (gate on UNITS[type].role 'combat'/'scout', like issueHold does). engine/sim.js updateUnit's pull-next-queued-order step (~line 137): when a completed order carries patrol:true, push it to the back of unit.orderQueue instead of dropping it, so the chain cycles. combat.js needs nothing — patrol legs are ordinary attack-move orders. input.js: keybinding + route to issuePatrol; persist.js already serializes order/orderQueue shapes, additive flag coerces in cleanEntity (no version bump per CONTRIBUTING's additive-field rule). Tests: commands.test.js (queue cycling), combat.test.js (engages then resumes loop), determinism unaffected (no randomness).

### Economy & Logistics

#### Gatherers roll to the next seam when a node runs dry

*Effort: medium · Impact: 4/5*

**Problem.** engine/gather.js updateGather nulls the order the moment node.amount <= 0 (both at the 'toDrop' deposit and at order pickup), so player workers idle at every depletion; the AI self-heals via aiWorkers.js assignIdleWorkers, but the player's only mitigation is the idle-worker cycle key. Late-opening, every drained seam silently sheds ~3 workers, and the resulting income cliff is invisible until the ore counter stalls.

**Change.** On depletion, auto-retarget the gatherer to the nearest same-commodity node the player has discovered (fog-gated, so hidden caches stay hidden) within a bounded radius (~600px), preferring nodes under the miner soft cap; if none qualifies, idle exactly as today. Deterministic: distance-then-id tiebreak, reading the per-tick node.miners tally that already exists.

**Where.** engine/gather.js: add a nextNodeAfterDepletion(state, unit, node) helper called from updateGather's two depletion exits; use state.map.nodes + node.miners (frozen by sim.js countMiners) + isNodeDiscovered(state.fog, n) from engine/fog.js; UNITS.worker.minerSoftCap for the saturation preference. Apply to both owners (the AI reassigns anyway on its next think). Tests in test/gather.test.js; determinism suite assertions updated per CONTRIBUTING TDD since this is an intended behaviour change.

#### Make node saturation visible on the map and in the panel

*Effort: small · Impact: 3/5*

**Problem.** miningEfficiency (engine/gather.js) silently cuts per-worker rate once miners exceed minerSoftCap (3, falloff 0.4), and node.miners is recomputed every tick by sim.js countMiners — but nothing in render.js, hud.js, or hudSelection.js reads it (verified: zero references). The core T1 lesson — spread out, then expand — is invisible: six workers on home ore just looks like slow income.

**Change.** Show 'Miners 5/3 — diminishing returns' when a gathering worker or a node is under the cursor/selected, and tint or ring an over-cap node in render.js so saturation reads at a glance from the map. Pure view-layer work; no engine change.

**Where.** render.js drawNodes: compare node.miners to UNITS.worker.minerSoftCap and draw a small count/ring when over; hudSelection.js: add an info line for a selected worker on a gather order (resolve its node via state.map.nodesById). Both files already receive the live state each frame.

### Tech, Research & Industry

#### Doctrine research develops over time instead of landing instantly

*Effort: medium · Impact: 3/5*

**Problem.** engine/production.js researchUpgrade is instant-on-payment — its header documents "it applies the instant it's paid for", and engine/aiDifficulty.js notes doctrine upgrades "aren't timed at all". So an army-wide +15%/-12% can be panic-bought mid-battle, there is no scoutable tech-timing window in the opening, and the Refinery stops mattering as a target the moment both tiers are bought. The documented convention records an implementation convenience, not a design goal; trading it buys real counterplay.

**Change.** Doctrine upgrades become short timed developments (~25-40s, scaled by researchTimeScale so skirmish world tech ratings finally matter) queued on the Refinery exactly like Datacenter research. Effects still apply live army-wide on completion. Creates a raidable window ("their Refinery is spinning — hit now"), a visible tech-timing game, and a doctrine-side hook for the AI research-pace dial.

**Where.** Generalize engine/techtree.js updateResearch to resolve its node table by building type (datacenter→TECHS, refinery→UPGRADES) — engine/sim.js line 77 already calls it for every building. Turn production.js researchUpgrade into an enqueue that pays up front (keep the committedDoctrine lock + prereqsMet, add a queued-dupe guard). engine/persist.js cleanEntity's researchQueue filter (line ~232) must accept UPGRADES ids too. Add a Refinery progress row in hudSelection.js reusing the Datacenter idiom (~line 953). Update test/production.test.js researchUpgrade assertions and add a re-entry guard in engine/aiEconomy.js aiResearch.

### Defense, Superweapons & Victory

#### Make Bulwark's structure shielding official — the turtle doctrine defends the base, and says so

*Effort: small · Impact: 2/5*

**Problem.** attackDamage in engine/combat.js applies upgradeMult(state.players[target.owner]?.upgrades, "damageTakenMult") to EVERY target with no kind/role filter, so a Bulwark player's turrets, Command Center and Habitats already take 12-23% less damage — but UPGRADES.reinforcedPlating/reinforcedBulwark descs in engine/entities.js say "-12% damage taken by all combat units" and the README frames doctrines as army-wide. The T1 doctrine pick secretly changes how well static defense and raid targets (Habitat hp 250) hold up, and neither the player nor any test knows it: test/combat.test.js only exercises unit targets.

**Change.** Keep the behavior and make it the design: Bulwark is the defense doctrine for army AND base. Update both upgrade descs to "all units and structures", pin the behavior with tests (a turret and a Habitat under reinforcedPlating take reduced damage; Assault's damageDealtMult already applies to turret shots via the shared performAttack — assert that too, since turrets attacking with doctrine bonuses is equally undocumented). This sharpens the T1 fork: Assault raids harder, Bulwark turtles harder, and the doctrine buttons finally sell the real trade.

**Where.** engine/entities.js: edit UPGRADES.reinforcedPlating.desc / reinforcedBulwark.desc (and README.md's doctrine paragraph). test/combat.test.js: two new cases near the existing reinforcedPlating test (line ~364) using makeBuilding("turret"/"habitat") as target, and one asserting a turret owned by an Assault player deals attack*damageDealtMult via updateBuildingCombat. No engine code changes — this is documentation + coverage of live behavior (or, if the team prefers units-only, a one-line target.kind==="unit" guard in attackDamage — but keeping it is the better game).

### AI Opponent

#### Difficulty-shaped counter-picking: Easy is readable, Hard punishes one-note armies

*Effort: small · Impact: 3/5*

**Problem.** The counter-pick cadence is a hardcoded const (COUNTER_EVERY = 3, engine/aiMilitary.js:21) identical at every difficulty, so Easy/Medium/Hard feel the same at the tier where new players live: the Skiff/Bastion/Lancer triangle. Easy is only 'slow, no micro' (aiApm 20) — it still hard-counters a beginner's first massed-Skiff army exactly as often as Hard does, while Hard gets no extra reactive edge beyond speed. Difficulty as an experience, not a multiplier, is exactly what the aiDifficulty.js header's tiered-dial pattern was built for.

**Change.** Add a counterEvery dial to DIFFICULTY_OPTIONS: Easy 0 (never counter-picks — its army is its archetype mix, learnable and exploitable by design, and the note string can say so), Medium absent (defaults to 3, byte-identical per the 'Medium carries none of them' contract), Hard 2 (reacts to your composition half again as fast). Pure data plus one read site — the same defensive-composition pattern every other difficulty dial follows.

**Where.** engine/aiDifficulty.js: add counterEvery: 0 to the Easy row and counterEvery: 2 to Hard; extend the header's tier list. engine/aiMilitary.js pickNextUnitType: import difficultyFor (aiDifficulty is a leaf module, no cycle) and use `const every = difficultyFor(state).counterEvery ?? COUNTER_EVERY; if (every > 0 && built % every === 0) …`. Pin with tests in test/ (Easy never returns the counter, Hard cadence is 2, Medium unchanged); setup.js difficulty note strings can mention 'predictable' for Easy.

### Odyssey Meta-Layer

#### Let the player choose (or reroll) their starting world

*Effort: small · Impact: 3/5*

**Problem.** The single most consequential Odyssey decision — which of 11 worlds shapes your whole opening economy, deposits, and neighbour temperament — is made by the RNG: createGalaxy (engine/galaxy.js line ~74) draws startId from the seed, and setup.js's Odyssey branch (line ~278-295) deliberately shows one 'Begin Odyssey — land on a random world' button instead of the card grid. Skirmish players already pick worlds from a card grid, so the affordance exists; Odyssey withholds the game's first real decision. The setup.js comment reads as a UI simplification, not a design commitment, and 'random' can stay the default.

**Change.** Add an optional start-world picker to the Odyssey setup: a compact row of the 11 world cards (reusing the skirmish card data: name, deposits tag, archetype name, industry/tech) plus a default 'Random' card. Selecting a world threads a startId override into createGalaxy; Random preserves today's seed-derived draw exactly, so existing seeds and saves replay unchanged.

**Where.** engine/galaxy.js createGalaxy: accept opts.startId, validate against ODYSSEY_WORLDS, and only use the pick() draw when absent (keep consuming the draw so downstream RNG use is identical either way); record the choice in galaxy.settings. boot.js startOdyssey passes setup.startWorld. setup.js: extend the Odyssey branch with the card row (MAP_CHOICES already derives from PLANET_ARCHETYPE; append kybernet/verdani from ODYSSEY_EXTRA_ARCHETYPE). No save-shape change (activeId already persists). Extend test/odyssey.test.js with a fixed-startId galaxy asserting activeId and same-seed determinism.

#### Survey probes: pay credits to scout a world before you jump

*Effort: medium · Impact: 4/5*

**Problem.** The first jump is a ~340-720 credit blind bet: galaxyStatus (engine/galaxy.js line ~468) shows an unexplored world only industry/tech, native faction, and archetype name, while the things that actually decide a settlement — the deposit table (data.js PLANETS[].deposits), the neighbour's varied difficulty/strategy profile (neighbourAiProfile, a pure exported function), and its current stance — stay hidden until you have already paid the fuel and landed. Meanwhile the early credit economy has almost no sinks between the 500 starting credits and the first jump, so there is no T1 spending decision at all.

**Change.** A 'Survey' action on unexplored starmap worlds: pay a distance-scaled credit fee (~25-35% of that world's jumpCost) to permanently mark it surveyed, revealing its deposit specialties, its neighbour's temperament/difficulty band, and its live stance on the starmap. Turns destination choice into an informed decision, gives credits a real opening use, and rewards planning without touching the sim.

**Where.** engine/galaxy.js: add galaxy.surveyed = new Set() in createGalaxy, export surveyWorld(galaxy, id) (deduct credits, add to set — pure, deterministic) and a SURVEY_COST helper mirroring jumpCost's distance math; galaxyStatus returns surveyed flag plus, for surveyed worlds, deposits (from PLANETS), profile (neighbourAiProfile(galaxy.seed, id)) and stance. engine/persist.js: additive surveyed array in galaxyPayload/deserializeGalaxy (defaults empty — no GALAXY_SAVE_VERSION bump needed per CONTRIBUTING). starmap.js: a Survey button on unexplored nodes and a richer sm-sub line for surveyed ones. Tests in test/odyssey-meta.test.js.

### Worlds, Maps & Terrain

#### Pick your side of the asymmetric matchups (Oort, Nimbus)

*Effort: medium · Impact: 3/5*

**Problem.** PLANET_MODIFIERS.oort/nimbus (engine/map.js) hard-code the asym.player/asym.ai halves: the human always plays Oort's rich claim (gatherMult 1.2) and Nimbus's clear skies (sightMult 0.95), the AI always gets the war factory (buildTimeMult 0.82) and the storm tempo (speedMult 1.12). README sells these as matchups where 'which corner you start in defines your plan', yet half of each matchup is never playable — and sideMod already resolves everything per-owner, so nothing structural forces the assignment.

**Change.** A per-match side toggle on the two asymmetric world cards: play the out-builder against the out-miner on Oort, or the fast-out-of-the-murk side against the scout on Nimbus. Doubles the effective asymmetric roster from 2 to 4 openings with no new mechanics.

**Where.** engine/map.js generateMap: accept opts.swapAsym; when set and modifiers.asym exists, attach a shallow copy with the player/ai asym blocks exchanged (must copy — generateMap currently attaches the shared PLANET_MODIFIERS object by reference). Thread the flag through engine/state.js createGameState (~line 94) and boot.js startGame from a new setup.swapAsym rendered only on cards whose world has an asym block (setup.js renderMapSelect), with a swapped variant of the mod label. Persist it as an additive optional field next to sizeMult/resourceMult in engine/persist.js (defaults false, so no SAVE_VERSION bump per CONTRIBUTING). Extend test/map.test.js's asym assertions (lines ~106-116) with the swapped case.

### UX, HUD & Controls

#### Reactive opening checklist replacing the static objectives strip

*Effort: medium · Impact: 4/5*

**Problem.** overlays.js showObjectives() is one static sentence that auto-dismisses after 30s (the Odyssey variant is a ~70-word wall of bolded terms); nothing tracks whether the player actually built the Barracks, picked a doctrine, or raised a Habitat, and once dismissed a first-timer has no in-game guidance left — the supply-block buzz (boot.js productionBlocked) is the only reactive teaching moment in the whole opening.

**Change.** Turn the strip into a live 4-6 item checklist per mode whose predicates are evaluated on the existing ~150ms HUD cadence: Skirmish — 'Train Workers (n/8)', 'Build a Barracks', 'Field 5 combat units', 'Pick a doctrine at the Refinery', 'Raise a Habitat before the supply cap'; Odyssey — 'Deploy the colony ship', 'Build a Market', 'Reactor -> Smelter', 'Build a Datacenter'. Items check off with a flash as the state satisfies them; the strip retires itself when complete (or via the existing x), and a localStorage flag (UI layer only) skips it for players who have finished it once.

**Where.** overlays.js: replace showObjectives' innerHTML with a renderObjectives(state, galaxy) that walks a small predicate table (count units by UNITS[type].role, buildings by type, committedDoctrine(state,'player'), supplyUsed/supplyCap — all already imported by hud.js/hudSelection.js); hud.js renderHUD calls overlays.updateObjectives(game) each tick behind a cheap done-bitmask signature; boot.js keeps the same showObjectives(intro) call site; style.css checklist rows. Pure UI reads — engine untouched.

#### Surface the counter-triangle on unit buttons and selection rows

*Effort: small · Impact: 4/5*

**Problem.** The Skiff>Lancer, Bastion>Skiff, Lancer>Bastion triangle is the game's core literacy (README) and is fully data-driven (UNITS[].bonusVs in engine/entities.js ~lines 630-660, bonusVsBuildings for the Breacher), but hudSelection.js unitTip() prints only raw stats ('72 hp · 12 dmg · rng 40'); at the moment of the production decision nothing in the HUD says what a unit beats or folds to, and on touch there is no hover at all.

**Change.** Derive counter text from the data: '▲ strong vs Lancer' from def.bonusVs keys (+ bonusVsBuildings -> 'structures'), '▼ falls to Bastion' from a module-load reverse index over UNITS (same hoisting idiom as ALL_COSTS). Append the two lines to unitTip tooltips, include them in the touch flashHint reason path (makeButton's blocked-tap channel), and suffix the aggregated multi-type selection rows ('12x Skiff — 84% hp · ▼ Bastion') so a mixed-army scan shows its soft spots.

**Where.** hudSelection.js: add counterInfo(type) with a hoisted reverse map built from Object.values(UNITS); extend unitTip(def) and the countByType row labels in rebuildSelectionPanel/renderSelectionPanel's live-patch (keep both label builders shared so patch and rebuild can't drift, same rule as recycleRowText). No engine change — reads existing bonusVs data.

### Presentation & Platform

#### Per-weapon fire signatures for the counter-triangle (tracer shapes + muzzle flash)

*Effort: small · Impact: 3/5*

**Problem.** All weapon fire is one 2px straight line; tracerColor in renderEffects.js special-cases only bastion (gold) and lancer (blue) — skiff, breacher, turret, dreadnought, wraith and colossus all fall to the same hostile-red default, including your own units. There is no muzzle flash at the firing end. The Skiff/Bastion/Lancer triangle is THE opening mechanic and README says scouting-and-countering what shoots you matters, yet the fire itself is nearly unreadable in a melee.

**Change.** Replace tracerColor with a TRACER_STYLE table keyed on unitType: skiff = short bright dart segment sliding along the line, bastion = thick stubby gold bolt, lancer = full-length thin beam with a hot tip, breacher/colossus = arcing shell (quadratic curve) with a heavier impact spark, turret = its own hue; plus a one-flicker muzzle flash polygon at (fromX, fromY) that fades faster than the tracer. Player-vs-enemy stays distinguishable via the existing enemy pip, so tracers are free to encode weapon class.

**Where.** renderEffects.js: rework the tracers loop in drawEffects around a style table and draw the flash from t.age < 0.3; effects.js addTracer already stores unitType, and engine/combat.js's attackHit event already carries unitType/heavy — no engine changes at all.

## Tier 2 — Developed

*The Foundry gate and its Tier-2 combat units, doctrine Tier-2s, expansions, the power grid (Reactor / Combustor / Biomass Reactor), the first factories (Smelter, Assembly Plant), Refined goods.*

### Combat & Units

#### Range-layered formation ranks: brawlers screen, artillery trails

*Effort: medium · Impact: 4/5*

**Problem.** Formations become tactically meaningful exactly when the Foundry adds mixed ranges (Lancer 55, Breacher 150 vs Skiff 40/Bastion 44), but formationSlots (engine/formation.js ~line 248) assigns units to shape slots purely by selection-array order — so a wedge or line interleaves Bastions and Breachers arbitrarily, and the shapes are cosmetic: your siege pieces end up on the leading edge as often as your tanks. The header comment only reserves slot 0 for the player-chosen leader; follower placement is unconsidered.

**Change.** Within line/wedge/circle layouts, assign follower slots by weapon range: shortest-ranged units (Bastion, Skiff) take the most forward slots, longest-ranged (Lancer, Breacher, Colossus) the rearmost, support (Mender) and unarmed units innermost/rear. The leader keeps slot 0 (that pick is a documented player choice — formation.js header), and the legacy 'grid' path stays byte-identical (commands.test.js pins it), so only the opt-in shaped formations reorder.

**Where.** engine/commands.js dispatchFormation (~line 86): after formationSlots returns spots, compute each non-leader slot's forwardness = dot(spot - leaderSpot, heading) and re-pair units.slice(1) with spots.slice(1) — sort units by (UNITS[type].range ?? -1) ascending with id tie-break (deterministic), sort slots by forwardness descending, zip. Skip when shape is 'grid' or the caller passed no formation (AI path, old tests unchanged). Alternatively do it inside formation.js behind an opts.rankByRange flag. Tests: new cases in test/formation.test.js/commands.test.js asserting a Bastion+Breacher wedge puts the Breacher behind, plus the existing grid byte-identity tests staying green.

#### Give the doctrine Tier-2s a verb: Assault combat drive, Bulwark field regeneration

*Effort: medium · Impact: 3/5*

**Problem.** The doctrine Tier-2s are literally 'the same number again' — overchargedCore is a second 1.15 damageDealtMult, reinforcedBulwark a second 0.88 damageTakenMult (engine/entities.js UPGRADES ~line 483/492). The Logistics doctrine's own tier-3 already breaks this mold by gating a capability (recycling). The combat doctrines' deepening tier changes no decision the player makes in a fight — it fails the 'each tier adds a tactical verb, not bigger numbers' bar this dimension is judged on.

**Change.** Keep the existing multipliers (so the mutual-exclusion design and balance tests are untouched) but add a small identity verb to each combat Tier-2: Overcharged Core also grants +10% move speed while a unit has an acquired target ('combat drive' — Assault armies run down kiters and close faster), Reinforced Bulwark also grants slow out-of-combat hull regeneration (~0.5 hp/s after ~8s unhit — Bulwark armies win attrition wars by cycling out of fights, synergizing with the Mender and wreckage-era army preservation). This extends, not contradicts, the documented 'deepen your chosen path' intent.

**Where.** engine/entities.js: add chaseSpeedMult:1.1 to overchargedCore and regenRate:0.5 to reinforcedBulwark (upgradeMult already generically products multiplier fields; regenRate is read directly like recycling's capability flag). engine/combat.js: performAttack stamps target.lastHitAt = state.time; the chase branch in updateCombat (~line 68) multiplies speed by upgradeMult(owner upgrades,'chaseSpeedMult'). engine/repair.js (or a small pass in sim.js next to updateRepair): for players whose upgrades carry regenRate, heal role:'combat' units where state.time - (unit.lastHitAt||0) > 8, clamped to maxHp. lastHitAt is additive numeric state — cleanEntity coercion covers it, no SAVE_VERSION bump. Regen is out-of-combat only so balance.test.js auto-battles (continuous fire) stay green; add cases to combat.test.js/repair.test.js.

### Economy & Logistics

#### Per-building logistics priority (the shipped-half of docs item 5)

*Effort: medium · Impact: 3/5*

**Problem.** docs/logistics-design.md §2.3 item 5 planned player prioritisation on top of auto-haulage, but what shipped is all-or-nothing: flat nearest-first scans with hard ≤2-per-building caps (engine/haul.js MAX_HAULERS/MAX_SERVERS, nearestBacklogProducer/assignService), or a worker manually locked to one building forever (order.manual). Once a base runs Smelter + Assembler + fuel-burning power stations, there is no way to say 'keep the Reactor fed before the Smelter' without dedicating micro-managed workers.

**Change.** A three-state per-building priority (high/normal/low) toggled from the building panel: high halves a building's effective distance in the auto-assign scans and lifts its cap by +1; low quadruples effective distance so it only draws labour when nothing else needs it. Deterministic — a pure weight on the existing distance-then-id scoring.

**Where.** engine/commands.js: issueSetLogiPriority following the issueSetCollectPoint idiom; engine/haul.js: multiply d by priorityWeight(b) inside nearestBacklogProducer and assignService's scanFor, and read the cap as MAX_HAULERS + (high ? 1 : 0); engine/persist.js cleanEntity: coerce the new field to the enum; hudSelection.js: a cycle button on factory/power-station panels. Tests alongside test/haul.test.js.

#### Bulk trading UI plus a glut/pressure trend readout

*Effort: small · Impact: 3/5*

**Problem.** engine/market.js sell()/buy() already walk arbitrary quantities in TRADE_LOT chunks at marginal prices — the code comments explicitly anticipate a 'Sell All' — but hudSelection.js marketRowFields only offers one 25-lot per click, so clearing a few hundred metals after the first factories means a dozen clicks. Meanwhile pressure and the slow 8-minute glut are fully simulated (state.market.pressure/glut) yet invisible, so a player can't distinguish a briefly-depressed price from a deep glut worth exporting around.

**Change.** Add Sell ×4 and Sell All buttons per market row (pass the full qty to the existing sell() — the engine already self-limits via marginal pricing), with a tooltip previewing actual marginal proceeds, plus a small trend glyph per row derived from pressure/glut (e.g. ▼ glutted · recovering) so make-here/sell-there becomes a legible decision.

**Where.** engine/market.js: export a pure quoteSell(market, com, qty) that dry-runs the same lot walk (so UI preview can never drift from engine math); hudSelection.js renderMarket/marketRowFields/refreshMarketRows: extra buttons + a trend span reading state.market.pressure[com] and glut[com]. No sim change, no save change.

### Tech, Research & Industry

#### Scope Heavy Alloys to the factories its tooltip names

*Effort: small · Impact: 2/5*

**Problem.** TECHS.heavyalloys promises "+40% output from the Smelter and Assembly Plant", but techMult(ups, "yieldMult") in engine/industry.js updateProduction (line ~338) multiplies outPerBatch for every recipe building — so this cheap early node silently boosts Chip Fab, Machine Works, and even Antimatter Forge/AI Foundry/Torpedo Works output by 40%, inflating strategic-good throughput far beyond its advertised early-chain role and flattening endgame pacing.

**Change.** Give passive nodes an optional appliesTo list of building types and honor it: heavyalloys reads ["smelter","assembler"], matching its desc; nodes without the field stay global (reactors/automation unchanged). Also opens the slot for future per-stage yield techs deeper in the tree.

**Where.** engine/techtree.js — extend techMult (or add techMultFor(upgrades, field, buildingType)) to skip nodes whose appliesTo excludes the asking building type; engine/industry.js updateProduction passes building.type at the yieldMult site only. Add a test asserting a chipfab batch is unchanged by heavyalloys (beside the existing industry tests).

#### Grid Substation: a passive one-hop relay that extends power-grid reach

*Effort: medium · Impact: 4/5*

**Problem.** engine/industry.js POWER_TIERS taxes any consumer far from a source (up to x2.3 draw), and the only remedy is another fuel-burning station (Reactor: 120 ore plus 0.12 radioactives/s forever). Every base therefore collapses into one dense blob — engine/aiIndustry.js literally spirals the whole chain around the CC — and the grid layer never produces interesting layouts; a factory at an expansion is permanently "Isolated".

**Change.** A cheap odysseyOnly Substation (~60 ore + 30 crystals; no energyGrants, no fuel) that acts as a one-hop distance relay: if it stands within the 'linked' band of an active source, it counts as a virtual source point (its own modest powerRange ~0.8) for tier computation, and it adds a small flat grid draw (the ELECTRIFY_POWER idiom) so extending the grid still costs capacity. One hop, no chaining — the scan stays O(sources x relays) and trivially deterministic, and power capacity itself is still only ever bought with fueled stations, preserving the fueled-grid design.

**Where.** engine/entities.js BUILDINGS: add substation with a powerRelay def field. engine/industry.js bestGridDist gains a second pass over completed relays (relay qualifies only if within POWER_TIERS[0].max of an active source, range-scaled); powerDraw adds the relay's flat draw. render.js's placement cue and hudSelection.js's tier label pick it up for free via powerEfficiency. Tests: tier improves through a relay; a relay with no active source relays nothing.

#### Foundry and Arsenal keep working after the unlock (standing bonuses)

*Effort: medium · Impact: 3/5*

**Problem.** engine/entities.js documents the Foundry and Arsenal as pure prerequisite buildings — no produces, no recipe — and the Unreleased CHANGELOG deliberately stripped their drop-off role, so 175/220 ore buys a one-time button-unlock and then dead weight. Razing one only matters if the owner still needs to queue gated units; for the owner the buildings have zero ongoing value.

**Change.** While a completed Foundry stands, military unit production runs ~8% faster; a standing Arsenal stacks a second step. Live-scanned, so losing the building loses the bonus — the gates become ongoing infrastructure worth defending and raiding, without touching the documented drop-off decision (this is a production passive, not a logistics role).

**Where.** engine/entities.js: add produceTimeMult: 0.92 to the foundry/arsenal defs plus a small structureMult(state, owner, field) helper mirroring committedDoctrine's live scan (cache per tick like industry.js ownerPowerCache if profiling warrants). engine/production.js updateProductionQueue multiplies it in beside the existing upgradeMult term. Tests beside test/production.test.js; CHANGELOG note since it retunes T2 tempo for both sides symmetrically.

### Defense, Superweapons & Victory

#### Teach the AI to read a turret wall and answer with Breachers

*Effort: medium · Impact: 4/5*

**Problem.** counterToPlayerArmy (engine/aiMilitary.js:386) counts only visible player units with role "combat", so static defense is invisible to the AI's counter-pick; its only Breachers come from fixed archetype unitMix entries (1-in-8 for Economist, 1-in-6 for Balanced, none for Rusher — engine/aiArchetypes.js). test/balance.test.js proves a 4-turret line stops same-cost Bastion and Lancer armies cold, so a player who turtles behind turrets watches the AI feed its normal mix into the wall until the 40-minute score check — the README promises the AI "builds the direct counter to whatever combat type you field most", but the classic turtle is exactly the composition it cannot counter.

**Change.** Extend the every-COUNTER_EVERY-th counter-pick to consider seen static defense: count visible player turrets (fogAI-gated, same isVisibleAt discipline as the unit count), and when turrets outnumber the dominant seen unit type (or exceed ~3), return "breacher" as the counter. effectiveMix already drops Breacher on radioactives-less worlds, so pickNextUnitType's existing mix.includes(counter) guard keeps this from stalling — same graceful degradation as today. The wave itself needs no changes: Breachers' prefersBuildings targeting (engine/combat.js acquireTarget) and 150 range do the rest.

**Where.** engine/aiMilitary.js: in counterToPlayerArmy, add a building scan over state.buildings for owner "player", type "turret" (or any def with attack), isVisibleAt(state.fogAI,...); if that count beats bestCount, return "breacher". pickNextUnitType unchanged. Tests in test/aiMilitary.test.js or test/ai.test.js: reveal N player turrets to fogAI, assert the COUNTER_EVERY-th pick is "breacher"; assert no pick when the turrets are unseen (fog-gating), and no pick on a crystal/radioactives-poor mix (effectiveMix filter).

#### A second static-defense tier at the Foundry gate — the Bastille heavy emplacement

*Effort: medium · Impact: 4/5*

**Problem.** One turret type serves all four tiers (only BUILDINGS.turret has an attack stat in engine/entities.js). By T2 the attacker unlocks Lancer and Breacher plus doctrine tier-2s, while the defender's static option is more copies of the same 350hp/20dmg tower; a "wall of them" (README's phrase) is pure count, and there is no fortification investment that scales with the Foundry economy. The focus question — is one Sentinel type enough across four tiers — is currently answered 'no' by omission.

**Change.** Add one Foundry-gated heavy emplacement: roughly hp 600, attack 32, cooldown 1.4, range 115 (deliberately UNDER the Breacher's 150 and Colossus's 185 so the documented siege identity — 'outranging the turret' — and the cracksBase balance invariant survive intact), cost { ore: 200, crystals: 150, radioactives: 60 } so the defender spends the same rare goods attackers spend on Breachers/doctrines (resource law: gathered commodities only). It anchors a T2 defensive spike against Lancer/Bastion timing pushes while staying strictly siege-vulnerable — deepening Breacher-vs-turtle rather than resolving it.

**Where.** engine/entities.js: new BUILDINGS entry (same combat stat names as turret so combat.js updateBuildingCombat works verbatim, per turret's own comment; requires: ["foundry"], category "military"). hudSelection.js: add to the skirmish build list (line ~1394 hardcodes ["barracks",...,"turret","habitat","command"]), the Odyssey GROUPS/alwaysShow sets (~1380-1388). engine/aiEconomy.js: in the fortify block (~line 346), alternate to the heavy type for turret indices past 1 when prereqsMet. test/balance.test.js: assert a Breacher budget army still cracks a mixed Sentinel+heavy line, and a Lancer army does not; test/entities.test.js roster invariants.

### AI Opponent

#### Graduation reaches the army: a developed Rusher techs the Foundry, not just the factories

*Effort: medium · Impact: 4/5*

**Problem.** rusherGraduates (Hard) and the Economic strategy's wantsIndustryAlways only feed wantsDeepIndustry (engine/aiIndustry.js:52-55), which drives the FACTORY chain — the unit mix never changes. The Rusher's mix is pure Tier-1 (engine/aiArchetypes.js:17), and aiBaseAndTech's Foundry gate is computed from archetype.unitMix alone (engine/aiEconomy.js:238 wantsFoundry), so a graduated Hard Rusher on korrath/nimbus/oort climbs all the way to Star Dock and fields 8-supply Leviathans while its Barracks still cycles Skiff/Bastion forever — it can build a capital ship but never a Lancer. Three of nine skirmish worlds' archetypes (and their Odyssey neighbours) never play the Foundry gate at all.

**Change.** When wantsDeepIndustry(state) is true in Odyssey, extend the effective mix with a small graduate extension (e.g. append ['lancer', 'lancer', 'dreadnought'] once, only if the base mix has no Foundry-gated entry), and compute the Foundry/Arsenal 'wants' gates from that same extended list so the tech buildings actually get built. effectiveMix's existing prereq/afford filters keep the cycle deadlock-free until the Foundry lands; the flip happens deterministically at RUSHER_GRADUATE_TIME (pure function of state.time). Skirmish stays byte-identical behind the state.endless gate.

**Where.** Move wantsDeepIndustry + RUSHER_GRADUATE_TIME from engine/aiIndustry.js into engine/aiWorkers.js (it may import strategyFor/difficultyFor — both leaf modules, acyclic; aiIndustry re-imports from aiWorkers). Add a plannedMix(state, archetype) helper in aiWorkers.js returning base mix + graduate extension pre-filter; effectiveMix filters it as today, and engine/aiEconomy.js aiBaseAndTech computes wantsFoundry/wantsArsenal from plannedMix instead of archetype.unitMix. Verify with `node tools/ailab.js probe --world korrath --difficulty hard --opponent none --minutes 60` (army composition should shift past minute 20) and the determinism suite.

### Odyssey Meta-Layer

#### Gifts and favor requests: an actual road to Allied

*Effort: medium · Impact: 4/5*

**Problem.** Diplomacy is all brake and no accelerator. The only lever, offerTribute (engine/diplomacy.js line ~186), snaps stance to APPEASE_FLOOR = 0.0, whose own comment says it 'stops short of friendship'; nothing a player does can push stance toward the Allied band (>= 0.6 in stanceLabel), and no system reads a high stance anyway — atPeace/hostility only care about the war threshold. So a T2 player with a Smelter full of metals on a metal-starved neighbour's world has no diplomatic use for their industry, and 'Allied' is a dead HUD word.

**Change.** Two additions, both goods-funded per the resource law: (1) Gifts — hand the neighbour gathered/refined commodities from the local stockpile; stance rises by the goods' local market value through a decaying goodwill pool (diminishing returns, so you cannot buy +1.0 in one dump), and unlike tribute this has no ceiling short of Allied. (2) Deterministic favor requests — every few minutes a peaceful neighbour asks for a commodity its world lacks (highest market.base multiplier = scarcest); fulfilling before the deadline pays credits plus a stance bump. Then make Allied pay: on an Allied world the market's spread tightens (SPREAD 1.15 -> ~1.05 in buy()) and tributeCost is discounted, so friendship is an investment with a yield. Tribute's documented 'stopgap truce' role is untouched — this is the separate, slower friendship path.

**Where.** engine/diplomacy.js: offerGift(state, com, qty) (deduct from state.players.player.resources, lift dip.stance via a dip.goodwill pool that decays in updateDiplomacy); request generation in updateDiplomacy keyed on a seeded per-world stream (mulberry32 of a planetSeed-style hash + time bucket — no wall clock), stored as dip.request {com, qty, until, reward}; fulfillRequest(galaxy, state). engine/market.js buy(): read state.diplomacy.stance for the Allied spread. hudSelection.js renderDiplomacy (line ~681): gift picker + request row. dip fields persist for free (persist.js spreads state.diplomacy). Extend test/diplomacy.test.js.

### Worlds, Maps & Terrain

#### Frontier belts: bigger maps add contested expansion fields, not just distance

*Effort: medium · Impact: 4/5*

**Problem.** generateMap places every visible deposit cluster in the two base-side bands (x fractions 0.2-0.3 and 0.7-0.8) with counts driven only by the deposit table's yieldMult; sizeMult grows only hidden caches (cacheSpecs), which are 0.6x singletons. A Gigantic (4x) map is therefore the same economy stretched over 16x area — the contested middle holds nothing visible, a second Command Center targets the same near-base fields merely moved farther away, and Large/Gigantic play 'just bigger' despite setup.js's own notes promising 'room to expand' and 'sprawling war'.

**Change.** For sizeMult >= 2, seed a mirrored 'frontier belt' of full-size visible deposit clusters in the contested band (x ~0.35-0.45), one additional mirrored set per size step cycling the world's own deposit commodities — so each map-size tier adds contestable expansion sites and the mid-game becomes a fight over the middle rather than a longer walk.

**Where.** engine/map.js generateMap: a new block after the extraClusters loop and before the cache loop, appending rng draws only for sizeMult >= 2 so the sizeMult=1 layout stays byte-identical (the header invariant and test/map.test.js line 238 both pin this). Amounts through amountOf(600 * yieldMult); positions mirrored like existing clusters so resolveNodeOverlaps spreads them. No AI change needed: engine/aiEconomy.js expansion scoring already scans state.map.nodes for the richest live cluster (lines ~446-465), so both sides contest the belt automatically. Extend the size-sweep tests in test/map.test.js (~line 216) with belt-count assertions per size.

#### High ground extends weapon acquisition, not just fog sight

*Effort: small · Impact: 3/5*

**Problem.** Fog reveal scales by the source tile's terrain sightMult (engine/fog.js updateFog srcMult), so a unit or Sentinel Turret on high ground sees 25% farther — but combat acquisition (engine/combat.js acquireTarget ~line 312, stillEngageable ~line 261) multiplies aggroRange only by the sideMod sightMult, never by terrain. A Lancer or turret holding Pyralis's mesa or Helix's ridge sees enemies it refuses to engage, so README's 'sees farther and hits harder' is only half true and vantage points feel weaker than advertised.

**Change.** Fold the attacker's terrain sightMult into aggro, mirroring fog: units and turrets standing on high ground acquire (and hold) targets out to the same extended radius they can see, making a held mesa tangibly dangerous to approach.

**Where.** engine/combat.js: in acquireTarget and stillEngageable, multiply aggro by state.map?.terrain ? sampleTerrain(state.map.terrain, unit.x, unit.y).sightMult : 1 (sampleTerrain is already imported for the combatMult damage bonus at line ~221; turrets share this path per the static-defense comment). Add a test beside the existing high-ground damage case in test/combat.test.js (~line 731) asserting a high-ground unit acquires at 1.25x range and an open-ground one does not.

### UX, HUD & Controls

#### Attack pings on the minimap plus a jump-to-last-alert key

*Effort: medium · Impact: 4/5*

**Problem.** triggerUnderAttack (boot.js) shows a 2.5s banner and a world-space ping (effects.js addUnderAttackPing), but drawMinimap (minimap.js) renders no alert layer — on a Large/Gigantic map, or once you hold the second base that defines T2, a raid on the far flank is findable only by clicking the banner inside its short window; lastAttackAt is retained module-locally in boot.js but unreachable from the keyboard.

**Change.** Draw pulsing red rings on the minimap at active under-attack ping sites, lingering ~8-10s (longer than the banner), and add a hotkey (Backspace, unclaimed in input.js's key map) that recenters the camera on the most recent attack — the standard RTS 'jump to last alert'.

**Where.** effects.js: export activePings() (pings already store {x,y,born}); boot.js render callback passes them into drawMinimap and moves lastAttackAt onto the session (game.lastAttackAt) next to supplyBlockedUntil, which already crosses this module boundary; minimap.js: draw rings scaled by sx/sy with an age-based alpha; input.js keydown: 'backspace' -> centerCamera(game.lastAttackAt) reusing the existing centerCamera/centerOnBase pattern; add rows to controlsLegend (hudSelection.js) and HELP_ROWS (overlays.js).

#### Space cycles bases and an idle-production topbar chip

*Effort: medium · Impact: 3/5*

**Problem.** input.js centerOnBase() does a .find() for the first completed Command Center, so once you take the expansion that defines T2 the Space key always lands on the same base; and nothing surfaces production buildings sitting idle — the idle-workers chip (hud.js renderHUD + input.focusIdleWorker) covers workers only, while multiple Barracks are normal mid-game (the AI explicitly runs several, per README) and an empty queue is invisible unless that building is selected.

**Change.** Repeated Space presses within a short window cycle through all completed CCs (the same double-press timing recallGroup already uses, DOUBLE_GROUP_MS); and add a second topbar chip '🏭 N idle' counting player production buildings (BUILDINGS[type].produces, !constructing, queue.length === 0), whose click cycles to and selects the next idle producer so its Produce panel — and the Z/C/V/B/N hotkeys — are immediately live.

**Where.** input.js: centerOnBase -> collect CCs sorted by id, keep a cycle index + lastBaseAt timestamp; add focusIdleProducer() mirroring focusIdleWorker (select building id, centerCamera, onChange) and expose it on the returned controller; hud.js renderHUD: count idle producers next to the idle-worker loop, toggle the new chip; index.html + dom.js: idleProductionEl beside idleWorkers; main.js: click wiring like idleWorkersEl.

### Presentation & Platform

#### Bespoke power-plant hulls and a deterministic 'working' pulse for running factories

*Effort: medium · Impact: 3/5*

**Problem.** T2's industrial reveal — Reactor, Combustion Generator, Biomass Reactor — renders through drawFactory as the same generic hexagon with an emoji (⚡🔥🌿) from BUILDING_GLYPH in renderBuildings.js. Worse, a healthy running factory shows nothing at all: drawConcernBadge is deliberately silent when fine, so a humming industrial base is visually indistinguishable from a dead one until something breaks.

**Change.** (a) Give the three power buildings bespoke silhouettes at the Foundry/Arsenal art level (cooling-tower Reactor with a lit core, flame-stack Combustor, green-vat Biomass Reactor) — they are the grid, not recipe factories, so this doesn't disturb the documented product-glyph system. (b) Add a subtle work pulse to recipe factories that are actually running (completed, not paused, buildingConcern === null): the glyph disc or Foundry ember glows on a slow cycle phased by hashStr(b.id) and driven by state.time — exactly the deterministic-presentation idiom electrifiedLight already documents.

**Where.** renderBuildings.js: new drawReactor/drawCombustor/drawBiomassReactor cases in drawBuildingShape; in drawBuildingBars, reuse the buildingConcern result already computed per player producer per frame (drawConcernBadge) to flag 'running' and draw the pulse in drawFactory. spriteIcon picks the new hulls up automatically.

## Tier 3 — Advanced

*The Arsenal gate (Dreadnought), Tier-3 specialty units, the Datacenter research tree, Chip Fab / Machine Works, Component/Finished/Luxury goods, the Spaceport and multi-world Odyssey play.*

### Combat & Units

#### Teach the AI's counter-pick about out-of-triangle units

*Effort: small · Impact: 4/5*

**Problem.** COUNTER_OF (engine/aiMilitary.js ~line 27) is derived from bonusVs, whose only keys are skiff/bastion/lancer — so counterToPlayerArmy (~line 386) returns null the moment the player's most-fielded visible type is a Breacher, Dreadnought, Wraith, Aegis or Colossus. The README promises the AI 'builds the direct counter to whatever combat type you field most', and the balance suite proves mass Skiff beats the Dreadnought (test/balance.test.js 'hard-countered by mass Skiff') and the README says the Breacher 'folds to massed Skiffs' — but the AI cannot express any of it, exactly at the tier where blind spots decide games.

**Change.** Add an optional counteredBy field to out-of-triangle unit defs — the soft counter the balance suite already certifies (dreadnought: 'skiff', breacher: 'skiff', colossus: 'skiff'; wraith/aegis/leviathan settled empirically by new duels) — and fold it into COUNTER_OF, so the counter-pick covers the whole roster while staying data-derived, never hardcoded.

**Where.** engine/entities.js: counteredBy:'skiff' on dreadnought/breacher/colossus (plus wraith/aegis once duels confirm). engine/aiMilitary.js COUNTER_OF reduce: also `if (def.counteredBy) map[def.id] = def.counteredBy`. pickNextUnitType already requires mix.includes(counter) and every archetype mix contains skiff (engine/aiArchetypes.js lines 44/70), so it engages immediately. Guard the data with balance.test.js additions asserting each declared counteredBy actually wins its cost- or supply-parity duel (the Dreadnought case is already covered), so the field can never go stale — the same self-verifying pattern COUNTER_OF's derivation comment calls for.

#### Colossus splash: def-driven area damage as the T3 anti-mass verb

*Effort: medium · Impact: 4/5*

**Problem.** Outside the Helium Bomb (engine/bomb.js), no weapon in the game deals area damage — every T3 unit is single-target, so 'spread out vs artillery' — the classic positional verb — does not exist, and clumped deathballs (which separation.js actively produces by packing same-owner units) are never punished. The Colossus (entities.js ~line 761: 42 dmg / 2.6s cd / 185 range, fragile, 'must be screened') is thematically the artillery piece but mechanically just a slow single-target sniper that massed cheap units barely notice.

**Change.** A generic def.splash = {radius, frac} mechanic, shipped on the Colossus first (e.g. radius 26, 50% falloff damage to enemy units near the impact): the reactivated ancient siege engine becomes true artillery, spread formations become a real defensive answer, and the mechanism is data-driven for any future unit (a Leviathan variant later). Enemy-only splash — friendly fire would fight separation.js's own packing behavior.

**Where.** engine/combat.js performAttack: after the primary hit, if def.splash, queryNeighbors(state.unitGrid, target.x, target.y, radius) (full-scan fallback like acquireTarget), damage enemy units of attacker.owner by dmg*frac*(1 - d/radius); hp subtraction is order-independent and each death funnels through the existing depositWreckage path, so determinism holds. Extend the attackHit event with splashRadius so renderEffects.js draws an impact ring. Balance guards: new balance.test.js duel asserting cost-parity Skiffs STILL beat Colossus head-on (its counteredBy from the previous proposal), and the existing 'Breacher is the turtle-breaker' tests untouched (splash is units-only; building spacing — colliders.js PLACEMENT_GAP 8 with radii ~18 — keeps structures outside a 26 radius anyway). Tune radius/frac against test/balance.test.js like SALVAGE_FRAC was tuned.

### Economy & Logistics

#### Freight Lanes: standing shipping between held worlds

*Effort: large · Impact: 5/5*

**Problem.** All inter-world logistics is capital-coupled: goods move only when the player personally jumps (engine/galaxy.js loadCargo inside jumpCapital), so a mature multi-colony empire — the point of T3 — still has the player ferrying every load. Background colonies keep simulating and their factories keep producing (stepGalaxy), but output just piles in their local treasuries, while colony income stays a flat, capped 0.3 credits/s/building (COLONY_INCOME_PER_BUILDING / COLONY_INCOME_CAP) with no connection to the commodity economy.

**Change.** At a Spaceport on a held world, assign specific freighters to a LANE (source world → destination world, commodity filter). Every LANE_PERIOD of galaxy time the lane moves min(assigned cargoHold sum, filtered stock) from source treasury to destination treasury. Assigned freighters must stay parked within JUMP_LOAD_RADIUS of the source pad and are flagged busy — physically present, raidable, and unavailable for anything else, so a lane is a real standing investment, not free teleportation. V1 riskless beyond that raidability; diplomacy-based interdiction can come later.

**Where.** engine/galaxy.js: a galaxy.lanes array plus runLanes(galaxy) called where sweepColonies already runs, keyed to galaxy.tick like the background scheduler; validate assigned ships each cycle (alive, parked near the source Spaceport — reuse JUMP_LOAD_RADIUS and freightCapacity); commodity pick reuses the cargoManifest most-valuable-first shape restricted to the lane's filter. engine/persist.js: sanitize galaxy.lanes (additive field, default []). UI: lane setup on the Spaceport panel (hudSelection.js) + a starmap overlay line. Tests in test/galaxy tests mirroring sweepColonies coverage.

#### Promote the Luxury tier from legacy data to a live export good

*Effort: medium · Impact: 3/5*

**Problem.** The ladder is Raw→Refined→Component→Finished→Luxury→Strategic (data.js TIERS), but Luxury has zero live production and Finished is machinery-only: luxefab (spice + electronics + energy → luxury) is documented legacy — data.js's RECIPES header says its req token gates nothing and instructs 'do NOT assume req gates a new factory without adding the tech + wiring'. So a whole ladder rung creates no decision, and spice (deposited on Verdani, the Odyssey agri world, and already a CARGO_GOODS export) has no industrial sink at all.

**Change.** Follow data.js's own promotion path: a Datacenter tech node (e.g. Artisan Fabrication, gated on electronics) unlocking an odysseyOnly Atelier building running recipe 'luxefab'. engine/market.js already prices and gluts every produced good, so luxury (base 220, steep glut) instantly becomes the premier make-here/sell-there freight cargo — a genuine T3 fork: electronics into machinery (chain progress toward the Gate) versus luxury (credits now). Add 'luxury' and 'goods' to CARGO_GOODS so auto-fill freight carries it.

**Where.** engine/entities.js: Atelier def (ore-costed per the reachability convention, recipe: 'luxefab', requires ['chipfab', <new tech id>], odysseyOnly, dropOff to match siblings); engine/techtree.js: the new TECHS node; engine/galaxy.js: extend CARGO_GOODS; data.js untouched (recipe already exists). Note the change explicitly against the RECIPES 'legacy' header comment. Chain test alongside the existing industry tests.

### Tech, Research & Industry

#### Tier-3 doctrine capstones so Assault/Bulwark match Logistics' depth

*Effort: medium · Impact: 4/5*

**Problem.** engine/entities.js UPGRADES gives Logistics three tiers (ending in the recycling capability) but Assault and Bulwark stop at Tier-2 — and both are the same shape, a repeated flat percentage. Committed doctrine identity plateaus exactly when the Arsenal tier arrives, and the two combat doctrines differ only in which stat the identical multiplier touches.

**Change.** One Arsenal-gated capstone each that changes texture, not just magnitude: Assault "Overdrive Actuators" (attackCooldownMult 0.9 — the army shoots faster, tempo identity) and Bulwark "Self-Sealing Plating" (slow out-of-combat hp regen — armies that hold ground recover, sustain identity that complements rather than replaces the Mender). prereqsMet already resolves mixed building+upgrade tokens, so requires: ["overchargedCore","arsenal"] needs zero new gating machinery, and it ties doctrine depth to the building ladder.

**Where.** engine/entities.js UPGRADES: two tier-3 entries. engine/combat.js applies attackCooldownMult where attackTimer is reset (updateWorkerCombat ~line 186 plus the main attack path). Regen: stamp unit.lastHitT where damage lands, add an owner-flag-gated pass in engine/sim.js (skipped entirely when unresearched, so skirmish replays without it are untouched); engine/types.js typedef for the new field. Tests in the combat and production suites; hudSelection.js Refinery panel needs no changes (RESEARCHABLE_UPGRADES is data-driven).

#### Promote the legacy consumer-goods recipes into a trade-industry branch

*Effort: large · Impact: 4/5*

**Problem.** data.js RECIPES carries chem/consumer/luxefab as documented legacy ("no producer"), yet engine/market.js prices the entire catalog — goods (base 130) and luxury (220) have live per-world prices and a designed niche that nothing can fill (engine/aiArchetypes.js: "Verdani the low-industry agri contrast where finished goods sell dear"). Biomass/spice worlds have no industrial identity beyond reactor fuel, and the tech tree is a single military/Gate spine with no economic fork.

**Change.** Add the exact "tech + wiring" data.js's LIVE vs LEGACY comment reserves as the promotion path: a `chemistry` node unlocking a Chemical Plant (chem: biomass+power→chemicals) as a true off-spine branch (no metallurgy prereq), and a `consumerfab` node unlocking a Fabricator (consumer: alloys+chemicals+power→goods), with luxefab as a later spice-world extension. This is a genuinely different way up the tree — a credits engine for fuel, tribute, and freight instead of strategic goods — and it turns agri-world deposits into industrial inputs.

**Where.** engine/techtree.js: two TECHS nodes. engine/entities.js: two odysseyOnly buildings with recipe/dropOff/prodRate following the smelter/assembler pattern (recipes already exist in data.js; market pricing and glut already cover the outputs via PRODUCED). engine/haul.js input larders handle chemicals automatically (inputCapOf splits per commodity). Optionally extend engine/aiIndustry.js INDUSTRY_CHAIN/RESEARCH_ORDER on biomass-rich worlds. Tests: chain production, galaxy persist round-trip, and a market sell of goods.

#### Cancelable research queue with refunds

*Effort: small · Impact: 2/5*

**Problem.** engine/techtree.js researchTech pays on enqueue and the only exit is completion. cancelProduction exists for unit queues with a documented full-refund convention (engine/production.js), but there is no research counterpart — a mis-click or a strategy pivot at the Datacenter strands 100+ crystals/radioactives in a queue the player cannot touch.

**Change.** cancelResearch(state, buildingId, index) mirroring cancelProduction's full-refund convention, with cancel controls on the research queue rows. If a cancelled node has dependents queued behind it (researchTech's queued-ahead allowance), cancel-and-refund those too so the queue can never hold an unsatisfiable job.

**Where.** engine/techtree.js: export cancelResearch (splice + negate-refund; share or duplicate production.js's 2-line negate helper), cascading over queue entries whose requires include the cancelled techId. hudSelection.js: give the Datacenter research row the production-queue cancel-button idiom (renderQueueRows). Tests beside test/galaxy-persist.test.js and a new techtree cancel case.

### Defense, Superweapons & Victory

#### Arsenal-gated Aegis Bastion — a static guard-aura projector for the late-game base

*Effort: medium · Impact: 3/5*

**Problem.** At T3+ every siege attacker outranges static defense by design (Colossus 185, Leviathan 200 vs turret 130), so defense becomes exclusively mobile and the Arsenal — the T3 gate — unlocks three offensive specialists and zero defensive structures. There is no way to make a base HOLD longer at the tier where Gate-defense (Odyssey finale waves converge on the wonder, engine/aiMilitary.js) and Dreadnought pushes arrive. The aura mechanic already exists and is proven: UNITS.aegis.guardAura feeds sim.js collectAnvils into combat.js anvilAura — but collectAnvils scans units only.

**Change.** Add an Arsenal-gated building with a guardAura (range ~130, damageTakenMult ~0.8, hp 500, cost { ore: 250, crystals: 180 }): every friendly unit AND building inside the bubble takes 20% less damage. It defends by attrition math, not range, so Breacher/Colossus/Leviathan still shell it with impunity from outside — it buys the defender time for the army to answer (the 'answer a win' half T3 lacks) without ever hard-stopping siege. In Odyssey it is the natural Gate bodyguard, making 'defend the charging wonder' a buildable plan rather than only an army posture.

**Where.** engine/entities.js: new BUILDINGS entry with guardAura and requires:["arsenal"] (no produces/supplyGrants, so isElectrifiable already excludes it). engine/sim.js collectAnvils: add a buildings pass (skip constructing, hp>0) pushing the same {id,owner,x,y,range,mult} shape — combat.js anvilAura is already target-kind-agnostic. hudSelection.js build lists as in the heavy-emplacement proposal. Tests: test/combat.test.js (a building and a unit inside the bubble take reduced damage; the projector never shields itself — anvilAura's id check); test/balance.test.js (a Breacher army still cracks an aura-shielded turret base, just slower).

### AI Opponent

#### Soft-answer fallback: the AI reacts to Breacher, Dreadnought and Tier-3 armies

*Effort: medium · Impact: 4/5*

**Problem.** COUNTER_OF is derived from bonusVs tables (engine/aiMilitary.js:27-30), and only the T1 triangle has them — its keys are exactly skiff/bastion/lancer. When the player's most-seen unit is a Breacher, Dreadnought, Wraith, Aegis, Colossus or Leviathan, counterToPlayerArmy returns COUNTER_OF[type] = undefined and the counter-pick silently disables — the AI stops reacting precisely when the stakes rise. entities.js documents these units as deliberately having no hard counter, but it also names their soft answers ('massed units still trade cost-effectively into it' for Dreadnought/Leviathan, 'folds to massed Skiffs for a fraction of its cost' for Breacher in README.md, 'must be screened or it's sniped/rushed down' for Colossus) — knowledge the AI doesn't have.

**Change.** Add a curated SOFT_ANSWER map in aiMilitary.js used only as a fallback when COUNTER_OF misses: breacher/dreadnought/colossus/leviathan → skiff (mass trades in, per each unit's own doc comment), wraith → skiff (focus-fire fodder that can chase), aegis → lancer (out-shoot the aura tank's token gun). This is not new bonus damage — no entities.js change, so the documented 'nothing hard-counters it' design holds; it's the AI learning the cost-efficiency answers the design already states. The existing mix.includes guard keeps each archetype in character, and skiff is in every effectiveMix fallback.

**Where.** engine/aiMilitary.js: add the SOFT_ANSWER const beside COUNTER_OF and change counterToPlayerArmy's return to `COUNTER_OF[best] || SOFT_ANSWER[best] || null`. Tune the specific entries with the ailab tech bot (see the bench proposal) rather than by hand; pin one test asserting a visible massed-breacher player army yields a skiff pick. Touches nothing else — pickNextUnitType and effectiveMix already handle prereqs/affordability.

#### A fourth archetype: the Technologist on Kybernet — SHIPPED (commit 17e2aad)

*Effort: medium · Impact: 3/5 — **delivered**; ARCHETYPES.technologist exists and
ODYSSEY_EXTRA_ARCHETYPE maps Kybernet to it. The Problem statement below describes the
world as it was BEFORE that commit and is kept for the record.*

**Problem.** Eleven worlds share three archetypes (rusher x3, economist x4, balanced x4 — engine/aiArchetypes.js PLANET_ARCHETYPE + ODYSSEY_EXTRA_ARCHETYPE), so a full Odyssey session meets the same three temperaments over and over, and Kybernet — the research capital, tech 10, whose whole identity is fastest research (engine/techtree.js researchTimeScale) and fastest factories — plays as a generic Economist. No archetype ever fields the Colossus (no mix contains it), so one of the four Arsenal specialists is dead content on the AI side.

**Change.** Add ARCHETYPES.technologist: a small-elite-army temperament that rushes the tech ladder — workerTarget ~7, armyAttackSize ~7, attackTimeout ~220, unitMix ['skiff','lancer','lancer','dreadnought','colossus','wraith'], turretCount 2, maxBarracks 2, wantsRefinery: true (the deep-industry signal), doctrine 'assault', plus an odyssey overlay with patient grace and high forgiveness. Map ODYSSEY_EXTRA_ARCHETYPE.kybernet to it. effectiveMix's surface-affordability filter drops colossus/wraith on worlds lacking relics/gas automatically, and PLANET_ARCHETYPE stays untouched so the skirmish nine and their pinned archetype-contract tests are byte-identical.

**Where.** engine/aiArchetypes.js only — a new ARCHETYPES row plus the one-line ODYSSEY_EXTRA_ARCHETYPE change; every field is already read defensively so no engine edits. test/aiArchetypes.test asserts key validity automatically. Tune the numbers with `node tools/ailab.js sweep --worlds kybernet` against baseline JSON per the docs/odyssey-ai-review.md §3.3 loop, and record the experiment in the §4 ledger.

### Odyssey Meta-Layer

#### Colony standing orders: policies for the worlds you leave

*Effort: large · Impact: 5/5*

**Problem.** 'A background colony keeps working for you' is only one-third true. The sim ticks (stepGalaxy), but the player side gets no new orders: production queues empty and stay empty, workers idled by node depletion never reassign, and manufactured surplus piles up in the stockpile doing nothing. Income is divorced from the colony's real economy — sweepColonies (engine/galaxy.js line ~209) pays a flat 0.3 credits/s per building capped at 6, so a humming factory world and six Habitats pay identically. There is nothing to decide about a colony after you leave it, which hollows out the multi-world tier the Spaceport is supposed to open.

**Change.** A small per-colony policy panel (set on the Command Center before you jump, editable from the starmap): (a) Auto-sell surplus — sell stock above a per-commodity floor into that world's own market via the real sell() path, so passive income becomes the colony's actual production priced with real slippage and glut (the existing market maths naturally bounds the annuity the COLONY_INCOME_CAP comment worries about); (b) Sustain workers — re-queue a worker at the CC (paid from the colony stockpile) when below a target and re-task idle workers to gather. Colonies become economies you tune, not building counts.

**Where.** New engine/colonyPolicy.js: policy store on galaxy (Map planetId -> {autoSell: {enabled, floors}, workerTarget}), executed inside stepGalaxy's throttled PROGRESS_CHECK_EVERY block for background states only — deterministic (integer schedule, no RNG). Auto-sell calls market.sell(galaxy, state, com, qty); worker sustain reuses production.js queueProduction plus an owner-generic version of aiWorkers' idle-gather assignment. Persist policies in engine/persist.js galaxyPayload (additive). UI: hudSelection.js CC panel (Odyssey branch) + a starmap.js per-colony row. Keep the flat income as the floor. Tests in test/livingGalaxy.test.js and test/determinism.test.js coverage of the throttled path.

#### Spaceport tiers discount jump fuel, not just capacity

*Effort: small · Impact: 3/5*

**Problem.** The Spaceport's three tiers (engine/galaxy.js SPACEPORT_CAPACITY = [0,12,24,40], upgrade ore 250/500) affect exactly one number: supply lifted per jump. A player who ferries small expeditions never has a reason to upgrade, and jumpCost (line ~623) reads only distance and the discovered set — your launch infrastructure is irrelevant to what launching costs. The upgrade is a niche army-ferry knob instead of a tiered economic decision.

**Change.** Make the pad's tier cut new-world fuel: jumps to undiscovered worlds cost x1.0 / x0.85 / x0.7 by the origin's best completed pad tier. A Tier-3 pad turns ~720-credit far-frontier jumps into ~500, so deep expansion pushes you to invest in home infrastructure first — a real T3 choice between upgrading the pad, banking fuel, or jumping early at full price. Free return jumps stay free, so nothing regresses.

**Where.** engine/galaxy.js jumpCost: take the origin state (it already has galaxy.activeId -> activeState), compute max spaceportTier over playerSpaceports(from), apply a FUEL_DISCOUNT_BY_TIER table to the distance-scaled branch only. Update the two cost-preview call sites (starmap.js onWorldClick/hint, hudSelection.js Spaceport panel line ~1211-1216 copy) — both already call jumpCost so they pick it up automatically; just extend the tier line text. Extend test/odyssey-meta.test.js with a tiered-pad cost assertion.

#### Faction memory: grievances echo across a faction's worlds

*Effort: medium · Impact: 4/5*

**Problem.** The living galaxy's factions are paint. checkExpansion (engine/galaxy.js line ~422) spreads claims across the starmap and flips a colonised world's AI faction, but diplomacy is 11 sealed dyads: pacifying a Mining Guild homeworld (checkDomination) leaves every other Mining Guild world exactly as cordial as before, so conquest has no diplomatic cost and the 'living galaxy' never reacts as a body politic. The brief's missing pieces — coalitions, consequences — have their natural hook here, and all the data already exists (galaxy.claims, state.players.ai.faction, per-world dip.stance).

**Change.** When a world is freshly pacified, every other unpacified world of the same faction (by claim or AI faction) takes a bounded one-time stance hit (~-0.2) plus a starmap toast ('The Mining Guild remembers Ferros'), and its forgiveness composes ~0.8x for a few minutes. Symmetrically, holding an Allied stance on one world of a faction gives its faction-mates a small standing target lift (+0.05, inside the existing DEV_SOFT-style bounding). Domination sprees now snowball resistance; befriending a bloc pays across worlds — coalition dynamics without any new AI machinery.

**Where.** engine/galaxy.js checkDomination: on each pacifyNotes push, resolve the razed world's faction and iterate galaxy.planets applying the stance delta (clamped) and pushing a note onto expansionNotes for boot.js's toast pump. The Allied echo lives in engine/diplomacy.js updateDiplomacy as a galaxy-fed target term — thread a per-world factionWarmth number in via a field stepGalaxy refreshes on the throttled PROGRESS_CHECK_EVERY scan (state stays engine-pure; deterministic integer schedule). Do NOT stamp dip.provokedAt — provoked()'s header documents the strictly action-based neverInitiates contract, and an echo is not the player attacking that world. Stance persists already; no save bump. Tests: test/domination.test.js + test/diplomacy.test.js.

### Worlds, Maps & Terrain

#### Starmap world dossiers: deposits and world rules, not just industry/tech badges

*Effort: small · Impact: 4/5*

**Problem.** The settle/jump decision happens on the starmap, which shows only the industry/tech badge (starmap.js sm-stats, fed by galaxyStatus in engine/galaxy.js line ~503). A world's deposit table — which decides whether the Strategic chain's radioactives hunger (antifab/plasmafab burn 2 each, the reactor recipe and Plasma Rig digs burn more) is fed locally or only by lean guarantee seams (Vesper/Glacius/Nimbus/Kybernet/Verdani deposit none), and whether gas/biomass power is available — plus its PLANET_MODIFIERS rule label are invisible until you pay fuel and land. Yet data.js frames these as charted worlds and the skirmish select cards already print the same information freely.

**Change.** Each starmap node (and the jump-confirm flow) lists the world's deposit icons with yield hints and its one-line rule-modifier label, so choosing where to settle, industrialize, or chase the Strategic tier becomes an informed geography read — the world-tier system the ratings already imply, finally legible.

**Where.** starmap.js renderStarmap: it already imports from data.js — add PLANETS/COM lookups and import PLANET_MODIFIERS from engine/map.js (setup.js already imports it UI-side); append a mk('sm-deps', ...) span from Object.entries(p.deposits) using COM[c].ico plus mod.label when present, keeping the textContent-only construction the file's comments require. Alternatively extend galaxyStatus's per-world snapshot if the data should stay engine-sourced. Pure view change — no engine, save, or determinism surface.

#### The landing picker charts the lay of the land from orbit

*Effort: small · Impact: 3/5*

**Problem.** landingPicker.js deliberately draws nothing but a reference grid (its header: a never-visited world 'really is a total unknown'), but this contradicts the game's own doctrine that charted surface geography is map knowledge, not battlefield intel (engine/fog.js header), and the blindness has uncounterable teeth: snapLandingPoint (engine/galaxy.js ~line 814) never checks terrain, so an expedition can be dropped into a rough field it crawls through at 0.6 speed and cannot build on (colliders.js canPlaceBuilding rejects rough), or into the neighbour's quadrant — a dice roll, not a decision. The documented rationale should change because geography is precisely what an orbital approach would see.

**Change.** Draw the destination's static terrain silhouette (rough and high cells in faint shades, the same static layer minimap.js already renders) on the picker canvas, while keeping deposits, fog, and all enemy/unit intel hidden exactly as today; update the header comment and the 'Fog of war is total' copy to 'terrain charted from orbit'.

**Where.** landingPicker.js draw(): iterate dest.map.terrain (cols/rows/cell/type — generated up front for every world by createGalaxy, so it always exists) and fill cells scaled by mmW/map.width, reusing minimap.js's terrain-layer colours (minimap.js ~line 49); adjust the two hasFootprint copy strings and the aria-label. No engine change, no save surface.

### UX, HUD & Controls

#### Tech & Industry Chart overlay — make the tier ladder visible

*Effort: large · Impact: 5/5*

**Problem.** The unlock ladder (Foundry -> Arsenal, Datacenter TECHS -> Chip Fab/Machine Works -> Strategic tier -> Antimatter Gate) cannot be seen in-game: the Odyssey build menu deliberately hides buildings whose prereqs are unmet (hudSelection.js GROUPS/alwaysShow — documented there as 'a greyed button per locked tier would bury the menu', which this proposal complements rather than reverses), the Datacenter panel is a flat list with only 'Requires X' lockTips, and docs/player-handbook.html — the one place the ladder is drawn — is linked from nowhere in the app (verified: no reference in any js file or index.html).

**Change.** A full-screen overlay on the starmap/help idiom (own element, pauseLoop('techchart'), Esc/hotkey T, a topbar button): tier columns rendering every building, unit gate, and tech node with prereq edges derived from BUILDINGS[].requires / UNITS[].requires / TECHS[].requires and factory recipes from BUILDINGS[].recipe, coloured by live state — built/researched, affordable now (canAfford), locked (with the full chain spelled out). Clicking a buildable-now building with a Worker selected arms input.startBuild and closes. Skirmish shows its small ladder; Odyssey the full chart including the Strategic tier, so a T2 player can literally see the Gate at the end of the road. Add a 'Full field manual' link (docs/player-handbook.html, target _blank) in this overlay's footer and in buildHelpOverlay.

**Where.** New techChart.js leaf module modeled on landingPicker.js/starmap.js (no boot.js import cycle; pause/resume passed or imported like starmap does); index.html overlay div + dom.js handle + style.css; data comes entirely from existing exports (BUILDINGS/UNITS/prereqsMet/canAfford from engine/entities.js, TECHS from engine/techtree.js, UPGRADES for doctrines); node icons via render.js spriteIcon exactly as makeButton does; wire the hotkey in its own self-wired keydown like starmap.js's M key, gated to not fire while a text control is focused (reuse input.js's focus guard pattern).

#### Selection subtraction and map-wide select-all-of-type

*Effort: small · Impact: 3/5*

**Problem.** input.js applyBoxSelection supports only replace and Ctrl-additive (Ctrl+click on an already-selected unit is reserved for leader promotion — a documented behaviour this keeps intact); there is no gesture to remove units from a selection, and selectSameTypeAt is screen-limited, so pulling the Menders out of a 60-unit T3 blob, or grabbing every Wraith across a Gigantic map, means rebuilding the selection by hand.

**Change.** Alt+click / Alt+drag subtracts the picked units from the current selection (Shift+left is the documented fallback if Alt proves awkward — Shift is only claimed for digit binds, and the Firefox caveat in input.js applies to right-click only); and Ctrl+double-click extends select-all-of-type to the whole map instead of the viewport, matching the map-wide semantics of Q and the panel's type rows.

**Where.** input.js: thread e.altKey from mousedown/mouseup into applyBoxSelection as a third mode that filters state.selection (preserving order so the formation leader survives); selectSameTypeAt gains an optional bounds=null path skipping the tl/br screen clamp, and the dblclick handler passes e.ctrlKey; document both in controlsLegend (hudSelection.js) and HELP_ROWS/TOUCH rows (overlays.js).

#### Starmap live colony ledger and alert badges

*Effort: medium · Impact: 4/5*

**Problem.** Multi-world play routes all colony trouble through transient toasts (boot.js notifyColony, 5-8s lifetime, max 3 on screen), while the starmap — the actual management surface — shows only status/income/stance/industry (starmap.js renderStarmap over galaxyStatus): a world currently under attack, recently fallen, or sitting undefended looks identical to a healthy one, so the management load of 4+ colonies is carried entirely by the player's memory of which toast they missed.

**Change.** Badge starmap worlds with live state: '⚔ under attack' when a colony alert fired within ~30s, '☠ fallen — click to retake' persisting until revisited, and a garrison line per held world (player CC count and army supply read from g.planets.get(id)), so opening M answers 'where is the fire and what's holding it' at a glance — exactly the load T3's Spaceport play creates.

**Where.** boot.js notifyColony already timestamps lastColonyNote[planetId] for throttling — move that record onto the session as game.colonyAlerts[planetId] = {type, at} (written for attack/hostile/lost, cleared by focusActivePlanet on arrival); starmap.js renderStarmap: read it when building each node's sub label + a CSS badge class, and compute garrison from the destination state's buildings/units maps (cheap: runs only at open, and the sim is paused via pauseLoop('starmap') while it's up).

### Presentation & Platform

#### Tiered destruction: deaths scale with what died, in both visuals and audio

*Effort: medium · Impact: 4/5*

**Problem.** engine/combat.js (and engine/bomb.js) push entityKilled with only {x, y, owner}; boot.js maps every death to the identical 280ms 6→22px ring (effects.js DEATH_LIFETIME_MS) and the identical playEntityKilled tone. A 40hp Worker, a 340hp Dreadnought and a 1000hp Command Center die with exactly the same feedback — by the T3 era of capital ships and base cracks, battles carry no sense of weight and a building loss is easy to miss entirely.

**Change.** Carry unitType/kind on the entityKilled event, then scale: death-ring radius and lifetime proportional to the def's radius; a few outward debris shards for hulls radius >= 10; a slower double-ring collapse for buildings. sound.playEntityKilled gains a size parameter that drops the base frequency and stretches the decay (the playHeavyHit vs playAttackHit precedent), so a Dreadnought kill lands as a deep boom while a Worker pops.

**Where.** engine/combat.js performAttack and engine/bomb.js's kill loop: add unitType/kind to the pushed event (purely additive fields — both determinism runs emit identical events, drained by the UI); boot.js processFrameEvents 'entityKilled' passes size/kind to addDeathFlash; effects.js stores them, renderEffects.js's deaths loop scales draw; sound.js playEntityKilled(pan, size).

#### Two-generation autosave with fallback load and surfaced failure

*Effort: medium · Impact: 3/5*

**Problem.** A multi-world Odyssey campaign lives in exactly one localStorage slot (ODYSSEY_KEY in saveload.js), overwritten every 12 seconds, and autoSave() failures are silently swallowed by the interval/visibilitychange/beforeunload callers. One corrupt or quota-failed write — or a save landing at a bad moment — and 'Continue' has nothing; the player discovers it only when deserializeGalaxy throws and flashButton says 'Load failed', with the whole campaign gone.

**Change.** Rotate two generations per mode: before writing a fresh autosave, move the current value to KEY+'.prev'; loadGame/loadOdyssey fall back to the previous generation when the primary fails JSON.parse or deserialization. On a setItem quota throw, delete the .prev copy and retry once so the backup can never starve the primary. Count consecutive autoSave() failures in the interval caller and after ~3 show a one-time toast: 'Autosave is failing — use Save to export a file.' No save-shape change, no SAVE_VERSION bump — this respects the documented exact-match, no-migration policy entirely.

**Where.** saveload.js: autoSave/snapshot rotation, loadGame/loadOdyssey/hasSave/hasOdysseySave/storedSaveVersions read both keys; the failure toast via overlays.js showGalaxyToast (already imported by boot.js — or import it in saveload.js). Add cases to test/saveload.test.js / test/save-hardening.test.js for the fallback path.

## Strategic — Endgame

*Antimatter Forge, AI Foundry, Torpedo Works, Plasma Rig, Star Dock / Leviathan, Strategic goods, the Antimatter Gate, domination and the finale.*

### Combat & Units

#### Plasma Torpedo Battery: ammo-fed static defense for the endgame

*Effort: large · Impact: 4/5*

**Problem.** The Sentinel Turret (entities.js ~line 41: attack 20, range 130, 350 hp) is the game's only static defense and is wallpaper by the Strategic tier — yet that is exactly when the player must hold ground for 150 seconds of Antimatter Gate charging while the whole galaxy is provoked (engine/wonder.js; CHANGELOG: 'a charging Gate still provokes for as long as it charges'). Defense of the Gate is army-only; the Torpedo Works manufactures plasmatorp that only the Leviathan and the Gate feed ever consume.

**Change.** A Torpedo Battery (odysseyOnly, requires torpedoworks): heavy single-shot static defense (~attack 55, range 180, cooldown 2.5) that only fires while stocked with plasma torpedoes hauled in by workers — real logistics, paid entirely in manufactured commodities (resource law intact). It gives the endgame a defensive verb (fortify the charging Gate, at real strategic-goods opportunity cost vs the Leviathan and the Gate feed) with built-in counterplay: the Leviathan (200) and Colossus (185) both outrange it, so sieging a battery line is the intended answer.

**Where.** engine/entities.js BUILDINGS: torpedobattery {odysseyOnly:true, requires:['torpedoworks'], cost:{ore:250, alloys:10}, attack/range/cooldown/aggroRange, ammo:{com:'plasmatorp', perShot:0.25}}; extend realInputComs/inputCapOf (~line 399) so def.ammo joins recipe/combust as a real input commodity — engine/haul.js's SERVICE machinery then delivers torpedoes into building.input with zero new hauling code (same seam the Reactor's fuel larder uses). engine/combat.js updateBuildingCombat: before firing, require building.input?.[def.ammo.com] >= perShot and decrement on shot; dry battery holds fire. building.input persistence already exists for buffered buildings (engine/persist.js cleanEntity path). Optional follow-up: aiSuperweapon.js places one beside the AI's own charging gate. Tests: combat.test.js (fires only when stocked, decrements), haul.test.js (workers service it), entities.test.js roster invariants.

### Economy & Logistics

#### Surge-feed and trickle-feed modes for the Antimatter Gate

*Effort: medium · Impact: 4/5*

**Problem.** engine/wonder.js updateWonder charges at a fixed dt/chargeTime clamped only by the scarcest fed good, so the finale's only economic lever is stockpile size. Yet charge DURATION is the real strategic cost: a charging Gate provokes the neighbour for as long as it charges (CHANGELOG Unreleased confirms this is deliberate and unbypassable). The player can't trade goods for time in either direction.

**Change.** A Gate feed-mode toggle: Surge (charge rate ×2, ×1.5 total goods per charge point — pay a strategic-goods premium to halve the war window) and Trickle (rate ×0.5, ×0.75 total cost — charge cheap and slow while weathering waves). Both still clamp to stock exactly as today, and the power-draw/not-power-gated design is untouched.

**Where.** engine/wonder.js: read building.feedMode and scale p and the per-commodity spend (the scarcest-good clamp already handles stock); engine/commands.js: issueSetFeedMode following the issueSetCollectPoint idiom; engine/persist.js cleanEntity: coerce feedMode; hudSelection.js: mode button plus a time-to-full-charge estimate line on the Gate panel. Tests in the wonder/victory test files.

### Tech, Research & Industry

#### An exclusive Gate-craft research pair for the finale

*Effort: medium · Impact: 4/5*

**Problem.** The Datacenter tree dead-ends at freighterai: during the actual endgame — charging the Antimatter Gate — there is nothing left to research, and no tech anywhere touches the wonder (engine/wonder.js updateWonder reads no techMult). The finale is pure stockpile logistics with no tech decision, and despite the techtree.js header pitching "research next building vs boost what I have" as a fork, the tree contains zero mutual exclusivity — every player walks the same spine.

**Change.** Two mutually exclusive capstones requiring aicores, priced in manufactured goods (the freighterai precedent): "Resonant Injection" (wonderFeedMult 0.75 — the Gate consumes fewer strategic goods per charge; slower, safer) vs "Parallel Injectors" (chargeTime x0.8 but the charging Gate's powerDraw x1.5 — faster, but it taxes the factories harder while shortening the provocation window diplomacy keys off a charging Gate). A real safe-vs-fast fork that keeps the Datacenter alive to the end and gives the tree its first true exclusivity primitive.

**Where.** engine/techtree.js: two TECHS entries carrying an exclusiveGroup field plus a ~4-line check in researchTech (reject when any owned or queued node shares the group); lockTip wording in hudSelection.js. engine/wonder.js updateWonder multiplies feed and chargeTime via techMult; engine/industry.js powerDraw's wonder branch (line ~239) reads the draw multiplier. Tests in the wonder/techtree suites; optionally engine/aiSuperweapon.js/aiIndustry.js pick a side by strategy.

### Defense, Superweapons & Victory

#### Measure the Helium Bomb blast to the target's rim, and close the AI's standoff gap

*Effort: small · Impact: 3/5*

**Problem.** engine/bomb.js's header claims peak damage is 'enough to one-shot even the toughest building in the game (the Antimatter Gate, 1200hp)', but detonateBomb computes center-to-center distance while BOMB_CORE_RADIUS is 15: a Gate (radius 28) or CC (26) at physical contact sits ~36-38 from the bomb's center, taking only ~470-520 hp — the documented one-shot is geometrically unreachable for exactly the buildings the doomsday device exists to threaten. Compounding it, engine/aiSuperweapon.js arms and lights the fuse at ARRIVE_RADIUS 70 from the target, where bombDamageAt(70) is ~138 hp — the AI pays gas 150 + antimatter 3 + plasmatorp 3 and 45s of Star Dock time for a firecracker against its own chosen target.

**Change.** Measure blast distance to each victim's rim: dist = max(0, hypot(...) - (e.radius || 0)) in detonateBomb's caught loop (bombDamageAt's curve and its tests are untouched), so a bomb at a building's wall is IN the peak band and the header's promise becomes true; apply the same rim measure in checkBombProximity so an armed defensive bomb trips correctly on big hulls. Shrink the AI's trigger to target.radius + BOMB_CORE_RADIUS so its offensive walk-in actually detonates in the kill band. Defender counterplay is preserved and clarified: shooting a fused bomb at range still detonates it early where damage has fallen off — now a genuinely correct read instead of an accident of mistuning.

**Where.** engine/bomb.js: detonateBomb caught-set distance and checkBombProximity distances subtract e.radius; header comment updated. engine/aiSuperweapon.js: replace the flat ARRIVE_RADIUS 70 with a per-target threshold derived from target radius + BOMB_CORE_RADIUS. test/bomb.test.js: update the two detonate-path expectedDmg computations (lines ~334/364) to rim distance and add 'a bomb at a Command Center's wall kills it outright'; test/aiSuperweapon.test.js: arrival-threshold assertion. Deterministic throughout — pure geometry, no new randomness.

#### Domination with teeth: pacified worlds stand down and pay reparations

*Effort: medium · Impact: 4/5*

**Problem.** checkDomination (engine/galaxy.js) records pacified worlds solely for a toast, a starmap badge and the DOMINATION_TARGET firework — a repo-wide grep shows no mechanical consumer. The neighbour on a 'Conquered' world can re-found via aiFoundOrSurvive/aiExpand and drift back to Hostile through the same updateDiplomacy pipeline as anyone, so conquest changes nothing about how the world treats you, and the domination path pays nothing while the Gate path pays a finale. The military endgame is a cosmetic chase.

**Change.** When checkDomination adds a world to galaxy.pacified, also stamp state.diplomacy.pacified = true on that world (it holds the state in its loop). updateDiplomacy then floors that world's drift target at APPEASE_FLOOR (Neutral) permanently — a conquered neighbour rebuilds and defends itself but never re-initiates — applied AFTER the Gate-finale clause, so pacifying a world is the one thing that exempts it from the finale mobilization: conquest becomes the military counter to your own Gate's provocation, tying the two endgames together. Optionally add an occupation dividend: pacified worlds contribute a small credits/min stream in galaxyStatus, mirroring the existing COLONY_INCOME_PER_BUILDING pattern (existing universal credits — no new currency, resource law intact).

**Where.** engine/galaxy.js checkDomination: one line stamping the flag (and re-stamp on load for already-pacified saves in deserializeGalaxy, since old saves carry galaxy.pacified). engine/diplomacy.js updateDiplomacy: a target = Math.max(target, APPEASE_FLOOR) clause guarded on dip.pacified, placed after the gate clause; persistence is free — persist.js spreads state.diplomacy (line ~626) and rehydrates over createDiplomacy() (line ~685), additive field, no GALAXY_SAVE_VERSION bump. Tests: test/domination.test.js (a pacified world's stance can never reach war again, survives save/load; unpacified world unaffected) and a finale-interaction case in test/diplomacy.test.js.

#### The rival Gate: the galaxy's strongest faction races its own wonder

*Effort: large · Impact: 5/5*

**Problem.** The galaxy-win threat is one-directional: engine/aiIndustry.js climbs to Star Dock, Leviathan, Helium Bomb and Plasma Rig but never builds antimatter_gate, and engine/wonder.js's chargingPlayerWonder scans owner === "player" only. The player defends a Gate but never answers one, so the finale machinery (diplomacy override, siege convergence, 'razed mid-charge loses everything') only ever points at the player, domination has no urgency, and the living galaxy's faction spread (checkExpansion) escalates into nothing. Every tier has a way to answer the player's win bid; no tier gives the galaxy a bid of its own.

**Change.** Let the single most-developed AI faction (reuse aiDevelopment and the checkExpansion selection idiom — deterministic, tie by world id) build and charge its own Antimatter Gate once its strategic chain stands; updateWonder is already owner-generic (it reads building.owner's resources). Surface it as a starmap alert with live charge. The player answers by jumping there and razing it — same total-loss rule as their own Gate — or racing their own. If it completes, the play-forever invariant holds: no defeat — an 'ascension' event instead: that faction instantly claims its unclaimed neighbours (a checkExpansion burst), its worlds take a permanent stance penalty toward you, and a unique milestone marks that the galaxy changed under you. Conquest, tribute, jumps and the Gate race all gain stakes from one addition.

**Where.** engine/wonder.js: generalize to chargingWonderOf(state, owner) with chargingPlayerWonder delegating (diplomacy.js/aiMilitary.js callers unchanged). engine/aiIndustry.js: a gate step after the Star Dock block — prereqsMet already gates on the AI's own chain; feed goods come from its existing factory output. engine/galaxy.js: rival-gate scan in the throttled stepGalaxy block (PROGRESS_CHECK_EVERY cadence), rivalGate fields in galaxyStatus, ascension consequence + reachMilestone("rival-gate"); starmap.js/boot.js toast + charge readout. Persistence free (building.charge already serializes per wonder.js). New test/rivalgate.test.js: deterministic charging given goods; razing stops it and refunds nothing; completion fires the milestone and never sets state.over.

### AI Opponent

#### The Helium Bomb travels with the wave, not alone

*Effort: small · Impact: 3/5*

**Problem.** aiSuperweapon's offensive delivery (engine/aiSuperweapon.js:56-65) walks the 80-hp bomb by itself straight at chooseAttackTarget via a bare issueMove. 'Unarmed = risk-free in transit' only means no accidental detonation (engine/bomb.js) — the player's Sentinel Turrets (range 130) and army still shoot it down long before ARRIVE_RADIUS, so the Aggressive strategy's endgame flourish almost never lands against any defended player, which is exactly who it exists for.

**Change.** Synchronize delivery with the strike wave: only advance the bomb while a committed attack force exists (units on order.type 'attack-move' — the same test aiOffense uses for attackers), route it toward the wave's centroid so it travels inside the escort, and hold it home otherwise. Arming/lightFuse at the target stays exactly as-is, and the defensive-trap branch is untouched.

**Where.** engine/aiSuperweapon.js: compute attackers from ctx.army (filter on order.type === 'attack-move'); if none, return early instead of issuing the solo move; if some, issueMove the bomb toward min(target, attacker centroid) each think cycle it falls idle. ctx already carries army and bombs (engine/ai.js aiContext), so no new snapshot fields. Test: construct a state with a defended target and assert the bomb holds position until a wave is committed.

#### The rival Gate: a fully-teched neighbour races its own Antimatter Gate

*Effort: large · Impact: 5/5*

**Problem.** The Antimatter Gate is Odyssey's endgame, but the race only runs one way: chargingPlayerWonder (engine/wonder.js) makes every neighbour converge on YOUR charging Gate, while no AI ever builds one — INDUSTRY_CHAIN (engine/aiIndustry.js:33) ends at torpedoworks and nothing places antimatter_gate. docs/odyssey-ai-review.md §2.7 defers 'the AI does not play the Odyssey' pending a designer decision, and this proposal is a deliberately scoped slice of that decision: an own-world Gate needs none of the jump/settle questions §2.7 flags, and the doc itself calls this layer 'the largest single lever on how alive the galaxy feels'. Today the Strategic tier has no external clock pressure at all.

**Change.** Let a neighbour that has completed the Strategic tier (Antimatter Forge + AI Foundry + Torpedo Works standing — the Gate's existing `requires`) and banked a strategic-goods buffer raise and charge its own Gate, gated to Hard difficulty or a wantsDeepIndustry temperament so it stays an event, not a default. updateWonder is already owner-generic (reads building.owner / state.players[owner]), so charging works unmodified; checkEndlessWin (engine/victory.js:61) is player-only, so completion needs a designed consequence that respects play-forever — propose: a 'Rival Ascension' galaxy milestone where that world gains the hardEdge upgrade and a permanent stance floor, plus a starmap badge and a discovery toast while charging, giving the player a raid-or-race decision with the Gate as a fat, killable objective (razing it already costs the AI the whole investment, per wonder.js).

**Where.** engine/aiIndustry.js: after the Plasma Rig block, an Odyssey-only, difficulty/temperament-gated build of BUILDINGS.antimatter_gate once prereqsMet and antimatter stock exceeds a buffer. engine/wonder.js: add chargingAiWonder(state) mirroring chargingPlayerWonder. engine/victory.js: on an AI-owned wonder reaching charge 1, push a galaxy event instead of finish(). engine/galaxy.js: consume it into milestones/pacifyNotes-style toasts plus the permanent-effect application; engine/diplomacy.js needs no change (the player razing it is ordinary combat/grievance). Surface via existing event/toast plumbing in boot.js/overlays.js — engine stays DOM-free. Bench: extend ailab's sample() with gate charge so the feature is measurable; add a determinism-roster case.

#### An Easy strategic ceiling: gentle neighbours stay gentle at the endgame

*Effort: small · Impact: 2/5*

**Problem.** aiIndustry gates the deep chain, Star Dock, Leviathan and Helium Bomb only on wantsDeepIndustry (engine/aiIndustry.js:130) — difficulty is never consulted past rusherGraduates, so an Easy Economist neighbour (neighbourAiProfile hands Easy to ~1/3 of Odyssey worlds, engine/galaxy.js:59) climbs to 900-hp Leviathans and a doomsday bomb in a long session. Easy already withholds marketAccess specifically so 'a new player isn't shown an AI that trades in a way they can't yet see or counter' (aiDifficulty.js header) — the same logic applies far more strongly to the Strategic tier.

**Change.** Add a strategicCeiling flag to the Easy row: its INDUSTRY_CHAIN climb stops after machineworks, which transitively prevents the Star Dock, Leviathan, and Helium Bomb via existing prereqs (no per-unit gating needed) while keeping the full T2/T3 factory economy, Datacenter research through 'machining', and the Plasma Rig-free late game intact. Medium/Hard unchanged; this is the second identity-level difficulty dial, following exactly the precedent the header documents for rusherGraduates ('the one identity-level change').

**Where.** engine/aiDifficulty.js: strategicCeiling: true on Easy plus a header paragraph. engine/aiIndustry.js: in the chain-find and RESEARCH_ORDER loops, slice the lists before antimatterforge/'antimatter' when difficultyFor(state).strategicCeiling. Note for the bench: Easy rows' develop component caps lower (score() normalizes devFinal/20) — record the intentional shift in the docs/odyssey-ai-review.md ledger and gate the dev-flatline detector on the ceiling the same way `entitled` already gates hostile-but-idle, so the tuning loop isn't taught to break the design.

### Odyssey Meta-Layer

#### The Gate network: an online Antimatter Gate changes how the galaxy plays

*Effort: medium · Impact: 4/5*

**Problem.** Bringing the Gate online is the Odyssey's stated triumph, but mechanically it is a firework: checkGalaxyProgress (engine/galaxy.js line ~357) sets the 'gate' milestone, boot.js celebrateMilestone plays 8 fireworks, and then a building that consumed a Strategic-goods mountain (wonder.js feed) sits inert forever. In a play-forever sandbox the crowning achievement should bend the sandbox afterward — CHANGELOG frames it as 'a triumph you keep playing past', but there is nothing new to play WITH past it.

**Change.** Once any player Gate reaches full charge, the galaxy latches gateOnline and the Gate becomes infrastructure: all jump fuel drops to zero (the Gate is the jump network now), and jumps launched from the Gate's world ignore pad capacity (the Gate lifts the whole staged fleet). The finale's reward is the frictionless multi-world empire the whole Odyssey was building toward — post-Gate play becomes fast conquest/logistics instead of the same fuel accounting, without adding any win state.

**Where.** engine/galaxy.js: checkGalaxyProgress already computes gateOnline — latch galaxy.gateOnline = true there; jumpCost returns 0 when set; jumpManifestAll takes an uncapped branch when the origin state holds the charged wonder (BUILDINGS[type].wonder && charge >= 1). engine/persist.js: additive gateOnline bool in galaxyPayload/deserializeGalaxy. Surface it in starmap.js's head line and extend the 'gate' copy in boot.js celebrateMilestone ('…the jump network is yours — all jumps are free'). Tests: test/finale.test.js asserts free jumps and uncapped manifest post-charge.

#### A galaxy-scale finale: faction expeditions answer a charging Gate

*Effort: large · Impact: 5/5*

**Problem.** The finale is fought by exactly one AI. diplomacy.js's GATE_WAR_TARGET clause reads chargingPlayerWonder(state) per world, so only the neighbour sharing the Gate's planet mobilises; charge the Gate on a pacified or backwater world and the 'bid to win the whole galaxy' (the wonder.js header's own framing) is contested by nobody — the climactic mechanic is trivially safe to route around, and the living galaxy watches its own ending passively.

**Change.** Past ~50% charge, the claimed worlds of the defending neighbour's faction (and past ~75%, every claimed faction) start dispatching expeditions to the Gate world: each developed source world pays real unit costs from its own AI stockpile, and the strike group makes planetfall at a deterministic map-edge point with attack-move orders on the Gate, on a per-source cooldown. The finale becomes a genuinely galactic defense whose intensity scales with how much living galaxy you left alive — pacifying worlds beforehand (domination track) now materially de-fangs the Gate defense, tying the two endgame arcs together into one strategic decision.

**Where.** New engine/gateSiege.js called from stepGalaxy's throttled block: scan planets for a charging player wonder (reuse chargingPlayerWonder), gather eligible sources from galaxy.claims + aiDevelopment(state) >= CLAIM_DEV, skipping galaxy.pacified; pay UNITS[type].cost from the source's players.ai.resources (resource law holds — nothing spawns free), mint riders with the 'g' id scheme exactly like checkGalaxyRescue/jumpCapital, place them at a hashStr-derived edge point of the Gate world, set u.order = {type:'attack-move', x, y} (scenarios.js idiom). Per-source cooldown on galaxy.time like RELIEF_COOLDOWN; cap concurrent expeditions. Toast via a transient galaxy note queue drained in boot.js. Tests: extend test/finale.test.js (spawn determinism, cost deduction, pacified worlds abstain).

### Worlds, Maps & Terrain

#### Promote the hidden deep-space worlds into an endgame frontier

*Effort: large · Impact: 4/5*

**Problem.** The Odyssey endgame (Antimatter Forge, Plasma Rig, Star Dock, Gate) burns radioactives and strategic goods continuously, but the 11-world roster opens no new geography late — the last new map a player sees arrives long before the antimatter era, and Spaceport tier-3 capacity plus distance-scaled jumpCost have nothing distant to spend themselves on. Meanwhile data.js carries Tartarus (radioactives 1.3, ore 1.6), Pandora, and Elysium flagged hidden/colonizable with an explicit invitation: 'Kept for reference / possible future promotion (a hidden world could become a premium late-game jump destination)', and engine/galaxy.js's worldIndexCache comment documents that append-only roster growth on load is already supported by engine/persist.js.

**Change.** A Deep-Space frontier: two or three hidden worlds join galaxy.worlds once the player enters the antimatter era (the 'antimatter' tech researched, or the 'gate' milestone in galaxy.reached), reachable only at their long-x jump costs (x 21-28 puts jumpCost around 750-950 credits), each a strategic-raw motherlode with its own tough neighbourAiProfile — giving the endgame fleet, fuel economy, and Spaceport tiers a destination worth them.

**Where.** engine/aiArchetypes.js: a DEEP_ARCHETYPE table kept out of PLANET_ARCHETYPE so the skirmish picker and its full-resolve tests stay frozen at nine (the documented ODYSSEY_EXTRA_ARCHETYPE pattern). engine/galaxy.js: an unlockDeepWorlds(galaxy) step inside the throttled checkGalaxyProgress block that, on the milestone, REBUILDS galaxy.worlds with the new ids appended (the WeakMap index cache keys on array identity, and appending preserves existing roster indices/schedules) and calls addPlanet(id, {unsettled:true}) for each; starmap.js already renders whatever galaxyStatus lists, and jumpCost's planetX distance term prices them unchanged. Swap Tartarus's relics deposit for radioactives/crystals or verify gather/market handle relics (COM lists it, STORE_IDS carries it). Persist: roster growth is additive per the existing append-only path; bump GALAXY_SAVE_VERSION only if a new serialized field is added. Tests: a galaxy test driving the milestone and asserting deterministic same-seed unlock, plus determinism-roster coverage for the new planet ids.

### UX, HUD & Controls

#### Persistent Antimatter Gate charge strip

*Effort: small · Impact: 4/5*

**Problem.** The Gate's multi-minute charge is the finale's whole clock, and per CHANGELOG a charging Gate provokes every neighbour for as long as it charges — yet the number is visible only in 25% milestone toasts (boot.js gateMilestone) or by keeping the Gate selected (hudSelection.js wonder panel). While defending the waves the charge attracts, the value you are defending for is off-screen, and a stall (starved feed goods or throttled Power) is silent.

**Change.** When a player-owned wonder exists (game.galaxy only, matching the Odyssey-gating idiom of the power readout), show a slim persistent chip: '🌀 Gate 42% · provoking neighbours', colour warming with progress and flipping to a warn state when charge is not advancing (compare against the last tick's value); clicking it centers the camera on the Gate, mirroring the underAttackEl click handler.

**Where.** hud.js renderHUD: find the player wonder ([...state.buildings.values()].find(b => BUILDINGS[b.type]?.wonder && b.owner === 'player')), fold charge into the topbar signature, render the chip; index.html + dom.js: gateChipEl next to underAttackAlert; click handler in hud.js using game.input.getCamera() + clampCamera exactly like boot.js's underAttackEl listener. The stalled test reuses the same charge-delta the wonderCharging event already carries.

### Presentation & Platform

#### Give the Leviathan a real capital-ship hull (it ships as the generic fallback diamond)

*Effort: small · Impact: 4/5*

**Problem.** UNITS.leviathan (engine/entities.js: 900hp, radius 14, Star Dock-gated, paid in Strategic goods) has no case in renderUnits.js drawUnitShape, so the endgame flagship draws via drawGenericUnit — a featureless diamond that reads a tier BELOW the Dreadnought's detailed hull, on the map and on its HUD production button alike (spriteIcon shares the dispatch). The file's own comment on drawGenericUnit — 'Nothing on the roster falls through to it today' — is now factually stale.

**Change.** A bespoke drawLeviathan: a long twin-spine super-capital silhouette that out-details the Dreadnought in every cue — broader oriented hull via updateFacing/pathOriented, six battery pods, twin spinal cannon lines, a lit command bridge and a stern engine array — so the last ship you ever build is unmistakably the biggest thing on the field. Fix the stale comment while there.

**Where.** renderUnits.js: add drawLeviathan and its dispatch line in drawUnitShape (the toWorld/pathOriented helpers from renderShared.js do all the geometry); update the drawGenericUnit comment. HUD icon inherits automatically via render.js spriteIcon.

#### A monumental Antimatter Gate whose charge is visible on the map (and a Star Dock worth the name)

*Effort: large · Impact: 4/5*

**Problem.** The Antimatter Gate — the largest structure in the game (radius 28 vs the Command Center's 26) and the Odyssey's only win condition — renders as drawGenericBuilding's hex stamped with a 🌀 emoji (BUILDING_GLYPH in renderBuildings.js). Its multi-minute charge (building.charge 0..1, engine/wonder.js) has zero on-map presence; the only feedback is boot.js's toast every 25% (gateMilestone). wonder.js's header calls it 'a fat, defendable objective', and engine/aiSuperweapon.js means a HOSTILE Gate can be charging too — yet neither reads as anything but another factory hex.

**Change.** Bespoke Gate art: a ring/torus structure whose inner arc fills with b.charge and whose vortex glow intensity and rotation phase are driven by state.time (the deterministic-presentation idiom electrifiedLight documents), so a 75% Gate visibly seethes from across the map — threat readability for enemy Gates, anticipation for yours. Give the Star Dock a drydock-gantry silhouette befitting the Leviathan's yard. Optionally add the endgame's soundscape: a low sustained hum whose pitch tracks charge, driven from the wonderCharging event — sound.js's first held tone (a managed looping oscillator alongside the one-shot tone()).

**Where.** renderBuildings.js: drawGate(ctx, state, b, color) reading b.charge + state.time and drawStarDock, both added to drawBuildingShape's dispatch; remove antimatter_gate/stardock from BUILDING_GLYPH. Audio: sound.js gains startHum/setHumLevel/stopHum keyed like lastPlayed; boot.js's existing wonderCharging case drives it.

## Cross-tier — Systemic

*Improvements that span the whole ladder and can't be anchored to one tier.*

### Combat & Units

#### Veterancy ranks: kills forge small combat multipliers and visible chevrons

*Effort: medium · Impact: 4/5*

**Problem.** A unit that survives ten battles is identical to one fresh off the Barracks line, so the systems the game just built around army preservation — the Mender ('keeping an army alive becomes a strategy, not just re-buying it', entities.js ~line 684), worker repair jobs (engine/repair.js), and wreckage economics (docs/battle-wreckage-design.md) — have no compounding payoff on the units themselves, and combat.js's spread-targeting comment explicitly aims for engagements that 'trade instead of ending in a near-wipe', which produces exactly the surviving-veterans this rewards. This is genuinely un-anchorable to one tier: it touches the first Skiff duel and the last Leviathan stand equally.

**Change.** Per-unit veterancy: each kill increments unit.kills; thresholds (e.g. 3/8/18) confer ranks worth roughly +6% damage dealt and -6% damage taken per rank, applied symmetrically to both sides (the AI benefits with zero AI code, like wreckage did). Rendered as chevrons over the health bar so a veteran line reads at a glance. Withdrawing, repairing and re-fielding a bloodied army becomes strictly stronger than re-buying it.

**Where.** engine/combat.js performAttack: on the target-died branch, `if (attacker.kind === 'unit') attacker.kills = (attacker.kills||0)+1`. A pure rankMults(unit) helper (entities.js or combat.js) maps kills to the two multipliers; attackDamage applies them beside the existing upgradeMult calls (~line 210). renderUnits.js: chevrons near drawHealthBar (~line 82). Persistence: kills is an additive numeric field — engine/persist.js cleanEntity coerces it, no SAVE_VERSION bump (CONTRIBUTING's additive rule); add to types.js Unit typedef. Deterministic by construction (kill order is already deterministic). Tune thresholds so a single engagement rarely mints rank 1 mid-fight, and confirm all of test/balance.test.js's auto-battle invariants stay green — those duels are the regression harness for exactly this kind of drift.

### Economy & Logistics

#### Commodity flow ledger: net rates, not just stock levels

*Effort: medium · Impact: 3/5*

**Problem.** The treasury is drained continuously by systems at every tier — combustor/Reactor fuel burns (0.06-0.12/s, engine/industry.js updateCombustors), the Rig's nuclear cost, ice coolant upkeep, autonomous-freighter AI-Core upkeep (engine/haul.js payAIUpkeep), and the Gate's feed — while the topbar (hud.js resourcesEl) shows only absolute stocks. A player can't see radioactives are net-negative until the Reactor goes dark; this genuinely spans every tier, from T1 gather income to Strategic-tier upkeep, so it can't be anchored to one rung.

**Change.** A HUD-side flow ledger: sample player.resources on a state.time cadence (~2s ring buffer, pause-safe), show +X/min or −X/min per commodity on hover of each topbar entry, and colour a commodity red when net-negative and something live (a fuel-burning station, the Gate) depends on it. Zero engine change, zero determinism exposure — a pure read-only view.

**Where.** hud.js: keep the ring buffer beside the existing topbar signature-guard, keyed to state.time so wall-clock never enters; tooltip per resource span; a small helper mapping commodities to live consumers (scan state.buildings for combust/rig/wonder defs) for the red highlight. No engine/ or persist changes.

### Defense, Superweapons & Victory

#### Make the clock endgame visible, honest, and configurable

*Effort: medium · Impact: 4/5*

**Problem.** The 40-minute score resolution is the guaranteed terminal state, yet it is invisible and then misreported: hud.js shows only elapsed time (line ~133), no countdown and no score — victory.js exports playerScore 'so a HUD could show the score' and nothing does — and overlays.js showGameOver prints 'the enemy's last Command Center is destroyed' even for a score decision, a factual lie on screen. victory.js's own comment anticipates a quick-match override via state.matchTimeLimit, but setup.js offers no way to set it. A player in a close turtle game cannot know they are losing the tiebreak, cannot play to the score (the whole BANK_WEIGHT/COMBAT_BONUS design is unlearnable), and cannot pick a shorter format.

**Change.** (a) engine/victory.js finish() records state.winReason: "elimination" | "mutual-wipe-score" | "timeout-score". (b) hud.js: inside the final 5 minutes the clock flips to a countdown and a compact two-sided score bar renders from playerScore(state,"player"/"ai") at the existing 1 Hz HUD cadence. (c) overlays.js showGameOver branches its copy on winReason and appends a small breakdown (bank x0.25 / army x1.35 / structures), reusing showScenarioEnd's breakdown idiom. (d) setup.js gains a Match length row (Quick 20 / Standard 40 / Marathon 60 — never 'unlimited', preserving the terminal-state guarantee) plumbed as opts.matchTimeLimit through createGameState.

**Where.** engine/victory.js: finish(state, winner, reason) + its three call sites; engine/types.js State typedef; engine/persist.js: winReason and matchTimeLimit are additive fields (sanitizeSave defaults — no SAVE_VERSION bump per CONTRIBUTING's additive rule). hud.js updateHud; overlays.js showGameOver (boot.js line ~370 passes state or the reason). setup.js: new option row following the SIZE_OPTIONS pattern (line ~31); main.js/boot.js startGame passes it; engine/state.js createGameState stores it. Tests: test/victory.test.js asserts winReason per path and the matchTimeLimit override round-trips in test/persist.test.js.

### AI Opponent

#### Close the bench's blind spots: a teching sparring bot and real-APM runs

*Effort: medium · Impact: 3/5*

**Problem.** tools/ailab.js can't see most of what the proposals above change: all four sparring bots field only Skiffs (turtle.think queues UNITS.skiff exclusively, skirmisher reuses it), so counter-picking, the T2/T3 war, and any mix/counter change are unmeasurable — and labWorld pins aiApm: null (tools/ailab.js:86), so the single biggest difficulty dial (APM 20/65/140) is exercised by zero measurements; difficulty rows differ in the bench only via multipliers and the micro flag. docs/odyssey-ai-review.md §3.3's whole loop depends on the bench being able to see the component you intend to move.

**Change.** Two contained bench additions: (1) an OPPONENTS.tech bot — the turtle economy that also climbs Barracks→Foundry→Arsenal via botBuild and cycles a lancer/breacher/dreadnought guard, committing waves like the skirmisher — answering 'does the AI react to and survive a composition, not a blob'; (2) an --apm flag (default 'real') making labWorld use the difficulty row's own aiApm, with 'none' preserving today's unthrottled runs for baseline comparability. Both are tools/-only — engine/ stays untouched, exactly the boundary the bench was built on.

**Where.** tools/ailab.js: add the tech bot beside skirmisher (reuse botBuild/botGather; queue from a fixed comp list, cheapest-affordable-first so it never stalls); thread args.apm through labWorld into createGameState's aiApm. Update the usage header and test/slow/ailab.test.js (determinism of the new bot; the override seam still reaches the sim). Record the re-baselined sweep in the docs/odyssey-ai-review.md §4 ledger since scores are not comparable across bot sets — the doc's own methodology note.

### Worlds, Maps & Terrain

#### A real LOS pass: low ground can't see onto high ground

*Effort: large · Impact: 4/5*

**Problem.** engine/fog.js reveal() is a pure radius flood: a Skiff in the lowland reveals a mesa top exactly as easily as open plain, so high ground grants its holder sight and damage but costs attackers zero information — the vantages on Pyralis/Nimbus/Helix are stat pads, not objectives you must scout or climb. The code explicitly anticipates fixing this: engine/map.js's TERRAIN_CELL_SIZE comment reads 'aligned with FOG_CELL_SIZE so a future LOS pass can share cell coords'. This is systemic — it changes scouting in the opening, mesa fights in the mid-game, and endgame army posture alike, on every terrain world.

**Change.** Uphill concealment: a source whose own tile is not high ground reveals high-ground cells only within a fraction (~0.55) of its sight, and combat acquisition honours the same rule — so you climb, take the vantage yourself, or push blind into a held ridge. Both fog grids inherit it, so the AI is equally blinded uphill (it already reacts only through its fog).

**Where.** engine/fog.js reveal(): pass the source's terrain code (one sampleTerrain per source, already computed as srcMult in updateFog); inside the cell loop, when the terrain grid marks a cell type 2 and the source is not high, compare against (sight * UPHILL_FRAC)^2 — fog and terrain share the 40px cell so indices map 1:1 (the documented hook). engine/combat.js nearestEnemy/spreadEnemy: skip enemies on high ground beyond aggro * UPHILL_FRAC when the acquirer's tile is not high (deterministic, symmetric, pairs with the acquisition-parity proposal). Renderer and AI need nothing — both already read fog. New cases in test/terrain.test.js and the fog tests; the determinism roster sweep guards replay identity.

### Presentation & Platform

#### Stop per-cell fog/terrain fills in the main view: static terrain layer + span-batched fog wash

*Effort: medium · Impact: 3/5*

**Problem.** render.js drawFogBase and drawTerrain issue one fillRect per cell per frame; camera.js minZoomFor explicitly lets a Gigantic map fit entirely on screen ('drops low enough to fit the whole thing'), which means up to 160x100 = 16,000 fog cells scanned (and thousands filled) at 60Hz, plus the same again for TERRAIN_CELL_SIZE=40 terrain. minimap.js's header documents this exact pathology ('16k+ fillRects on a big map') and fixed it with an offscreen underlay — the main view never got the fix, and it sits under every late-game frame as fixed overhead competing with army rendering.

**Change.** (a) Terrain is immutable per map: pre-render it once into an offscreen canvas at cell resolution (cols x rows pixels, one pixel per cell) keyed on state.map identity, and blit the visible sub-rect with a single drawImage per frame (imageSmoothing off preserves the current hard-edged look). (b) For the fog wash — explored AND not-visible, which changes every tick — merge horizontal runs of qualifying cells into single fillRects (fog is spatially coherent, so thousands of rects collapse to dozens of spans), or cache the explored layer offscreen on minimap.js's coarse-refresh pattern and keep only the visible-cell punch-out live.

**Where.** render.js: rework drawTerrain around a module-level {map, canvas} cache (the underlayMap idiom from minimap.js); rework drawFogBase's inner loop into run-length span emission. Pure render-side; no engine or state changes, no determinism exposure.

#### Full-roster render smoke test with a 'no silent fallback' guard

*Effort: small · Impact: 2/5*

**Problem.** The render suite (test/renderBuildings.test.js, test/renderEffects.test.js) covers only the build-ghost/power-cue regression; nothing ever draws every UNITS/BUILDINGS type. Two live bug classes ship unguarded: a draw path that throws for one type (the exact every-frame-throw freeze renderBuildings.test.js documents from the god-file split), and a roster addition that silently falls through to the generic silhouette — the Leviathan proves the second is real today, and the fallback's own comment claiming otherwise shows nobody noticed.

**Change.** test/render-roster.test.js: iterate every key of UNITS and BUILDINGS, calling drawUnitShape / drawBuildingShape with the proven fakeCtx Proxy idiom (and spriteIcon's stub-state trick — empty Maps — for state-reading buildings), asserting (a) no draw throws, and (b) using a call-RECORDING proxy, that each type's method trace differs from the trace drawGenericUnit/drawGenericBuilding produces for the same def — an identical trace means it fell through, failing with 'type X has no bespoke silhouette'. Roster-driven iteration means every future unit/building is covered automatically, turning an invisible presentation-bug class into a red test.

**Where.** New file under test/ following renderBuildings.test.js's fakeCtx pattern, extended to record (method, rounded-args) tuples; imports UNITS/BUILDINGS from engine/entities.js and the two shape dispatchers from renderUnits.js/renderBuildings.js. No production code changes needed (the Leviathan fix lands first or the test ships expecting-fail for it).

## Review: merges, conflicts, and open gaps

A completeness critic read the full set against the codebase. Its findings, verbatim:

### Tier balance

Counting the 71 proposals: T1 13, T2 16, T3 20, Strategic 15, Cross-tier 7 — a healthy overall shape, and the ladder reads coherent because each tier's proposals share that tier's true failure mode: T1 is almost entirely 'make existing rules legible' (telegraphs, tooltips, saturation visibility, checklist) rather than new mechanics, which is right for an opening that works but teaches nothing; T2 adds verbs and systems maturity (formations, substation, second static tier, alerts); the T3 bulge lands where the game is thinnest (multi-world economy, AI blind spots, doctrine depth, dossiers); Strategic adds stakes. Three cells are starved — Odyssey-T2 has a single proposal (Gifts) even though the first jump is the meta-layer's own opening, Defense-T3 has one, and Tech has no cross-tier entry — while Cross-tier's scarcity (7) is fine since it is properly reserved for genuinely systemic items (veterancy, flow ledger, LOS, the clock, fog perf, render tests). The real bloat is not a tier but a building: 8 of the 15 Strategic-tier proposals orbit the Antimatter Gate (two rival-Gate twins, galaxy finale, Gate network, surge/trickle feed, Gate-craft research, charge strip, Gate monument) versus two for the Helium Bomb and effectively one for domination — green-lighting the Gate cluster wholesale would make the endgame a one-building monoculture, so it needs a curated subset more than any tier needs more proposals.

### Same idea twice — merge before scheduling

- 'The rival Gate: the galaxy's strongest faction races its own wonder' (Defense) = 'The rival Gate: a fully-teched neighbour races its own Antimatter Gate' (AI Opponent) — the same feature down to the same cited gaps (no antimatter_gate in INDUSTRY_CHAIN, player-only chargingPlayerWonder), proposed twice at L/impact-5; the independent convergence is itself a green-light signal, but it is one workstream.
- 'Teach the AI's counter-pick about out-of-triangle units' (Combat & Units) = 'Soft-answer fallback: the AI reacts to Breacher, Dreadnought and Tier-3 armies' (AI Opponent) — identical diagnosis (COUNTER_OF derived from triangle-only bonusVs, counterToPlayerArmy returning null) and identical fix (a soft-answer table); one implementation.
- 'Promote the Luxury tier from legacy data to a live export good' (Economy) = 'Promote the legacy consumer-goods recipes into a trade-industry branch' (Tech) — both revive the same documented-legacy recipes (luxefab, chem/consumer) into live production; Tech's is the superset design, Economy's the narrow slice of it.
- 'Counter-triangle telegraphs: flag bonus hits and surface matchups in the HUD' (Combat) overlaps 'Surface the counter-triangle on unit buttons and selection rows' (UX) on the entire show-matchups-in-the-HUD half — keep Combat's bonus-hit event and UX's button/tooltip surface as one triangle-readability feature (Presentation's fire-signature proposal is a compatible third leg, not a duplicate).
- 'Give the doctrine Tier-2s a verb' (Combat) overlaps 'Tier-3 doctrine capstones so Assault/Bulwark match Logistics' depth' (Tech) — same diagnosis (combat doctrines are repeated flat percentages while Logistics gates a capability), same UPGRADES table, adjacent tiers; should be one doctrine-depth redesign, not two proposals.
- 'Freight Lanes: standing shipping between held worlds' (Economy) overlaps 'Colony standing orders: policies for the worlds you leave' (Odyssey) — both L/impact-5 attacks on the same root (background-colony output piles up while income stays flat 0.3/s per building, capped) and both would rewrite sweepColonies/stepGalaxy; two halves of a single colony-economy rework.
- 'Persistent Antimatter Gate charge strip' (UX) overlaps 'A monumental Antimatter Gate whose charge is visible on the map' (Presentation) — both exist to fix the same invisible charge (both cite the 25% gateMilestone toasts as the only feedback); complementary surfaces (HUD vs map), but scope them together so charge visibility ships once.

### Collisions — decide these first

- 'Survey probes: pay credits to scout a world before you jump' (Odyssey) vs 'Starmap world dossiers: deposits and world rules, not just industry/tech badges' (Worlds) — one prices deposit/world-rule intel as a T1 credit sink, the other publishes the same data free as charted map knowledge; shipping both leaves probes selling almost nothing, so the free-vs-paid intel doctrine must be decided first.
- 'Plasma Torpedo Battery' (Combat), 'A second static-defense tier — the Bastille' (Defense) and 'Arsenal-gated Aegis Bastion' (Defense) collectively triple a static-defense roster that 'Teach the AI to read a turret wall' (Defense) proves the AI already cannot break — the new structures must ship after (or with) the AI answer and as one rationalized tier ladder, or turtling becomes uncounterable and the README's counter-play promise degrades further.
- 'An Easy strategic ceiling: gentle neighbours stay gentle at the endgame' (AI) vs 'The rival Gate' (AI and Defense) — one clamps AI escalation by difficulty, the other's entire value is the galaxy escalating into its own win bid; both gate on the same wantsDeepIndustry path in aiIndustry.js and must agree on whether an Easy-heavy Odyssey galaxy (~1/3 of worlds) ever produces a rival Gate.
- 'Domination with teeth: pacified worlds stand down and pay reparations' (Defense) vs 'Faction memory: grievances echo across a faction's worlds' (Odyssey) — one lowers conquest's cost and adds a payout, the other raises its galaxy-wide diplomatic price; both rewrite the same stance/checkDomination pipeline, and domination's net value depends on tuning them as one system.
- 'Teach the AI to read a turret wall' (Defense), 'Soft-answer fallback' (AI) and 'Teach the AI's counter-pick about out-of-triangle units' (Combat) all rewrite counterToPlayerArmy/COUNTER_OF at engine/aiMilitary.js ~386 — three dimensions patching one function; merge into a single counter-intelligence rework or they trample each other in code.
- 'A real LOS pass: low ground can't see onto high ground' (Worlds) vs 'Stop per-cell fog/terrain fills in the main view' (Presentation) — the render batching bakes in the current radius-flood fog-cell model that the LOS pass replaces; sequence LOS first or design the fog-cell contract jointly, or the optimization gets rewritten.
- 'Surge-feed and trickle-feed modes for the Antimatter Gate' (Economy) vs 'An exclusive Gate-craft research pair for the finale' (Tech) — both introduce the game's first charge-time levers into wonder.js updateWonder (today a fixed dt/chargeTime with no modifiers); compatible in spirit but overlapping design space, so Gate-charge economics needs one owner.

### Unclaimed territory — gaps no agent owned

- The scenario/mission mode has no owner: engine/scenarios.js plus setup.js ship two complete scripted missions (Convoy Escort, Pirate Raider) with their own scoring and splash copy, and none of the 71 proposals touches the mode — no third scenario, no tuning pass, and no bridge into the Odyssey, where a convoy-escort 'favor mission' is exactly the concrete verb the Gifts/Allied proposal lacks.
- Replay and spectating: the same-seed determinism invariant (CONTRIBUTING: 'keep replays identical') makes seed-plus-command-log replays, a post-defeat 'watch what the AI did under its fog' view, and share-a-seed challenge runs nearly free, and tools/ailab.js already runs watchable headless matches — nobody proposed any of it, even though replay-after-loss is the best teacher of the counter-literacy half the set keeps reaching for.
- Post-match debrief: victory.js exports playerScore explicitly 'so a HUD could show the score', yet no proposal adds an end-of-match summary — score race over time, income/army-value curves, kills by unit type, which counters were used against you; the Defense clock proposal surfaces only the live score, so the retrospective learning loop (where difficulty onboarding actually lives) is unowned.
- Accessibility got zero coverage: no colorblind-safe owner-color option (Presentation's own fire-signature proposal documents friendly and hostile tracers sharing the same red), no rebindable keys (Q/X/backtick/P/Space are hardcoded in input.js), no UI-scale option; only prefers-reduced-motion is honored today (renderEffects.js, style.css) — all vanilla-CSS/JS feasible under the invariants.
- Audio as a system: sound.js is a procedural WebAudio layer whose master bus is commented for 'future mixing', but the set's only audio mention is a rider inside Presentation's tiered-destruction proposal — no alert-sound hierarchy (a raid, a colony toast, and research-done are indistinguishable by ear on a multi-world map), no ambient/tension layer, no stereo pan; all asset-free and invariant-clean.
- Modding-by-data and seed control: data.js is pure content, saves already round-trip as user-held JSON files, and ailab injects JSON overrides into the AI tables — yet no proposal opens custom worlds/rosters/recipes through the same sanitized-import channel, or even exposes the map seed on the setup screen for reroll/share; with no build step the data surface IS the mod surface, and nobody claimed it.
- Within covered dimensions, the Odyssey's own midgame is a starved cell: exactly one T2 proposal (Gifts) covers the whole first-jump-to-second-world transition — nothing on colony-ship escort UX, what to load for a first settlement, or guidance for the meta-layer's opening moves, despite two dimensions (Odyssey, Worlds) owning adjacent territory.
- Movement feel through terrain: engine/map.js line 65 documents 'the engine has no pathfinding' — units never prefer routing around rough ground, so terrain reads as a flat speed tax; every terrain proposal in the set is about sight (LOS, acquisition range, dossiers) and none examines movement, even a light deterministic prefer-clear-ground steering bias that would make the 'slows and shapes' design legible.

## Appendix — Current state by dimension

Each dimension agent's summary of how its slice of the game works today, as read from the code:

**Combat & Units.** Combat (engine/combat.js) is hitscan-on-cooldown: auto-acquire with 3-way spread targeting and target stickiness, flat attack plus flat bonusVs adds forming the Skiff/Bastion/Lancer triangle (enforced by auto-battle regressions in test/balance.test.js), with doctrine/faction/high-ground multipliers and the Aegis guardAura precomputed in sim.js collectAnvils. The roster (engine/entities.js UNITS) runs Skiff/Bastion in the opening, Foundry-gated Lancer/Breacher/Mender, Arsenal-gated Dreadnought plus the Wraith/Aegis/Colossus specialists, and the Odyssey-only Star Dock Leviathan and Helium Bomb — but every unit past T1 is purely passive stats, no unit or building has an ammo/ability behavior, and the Helium Bomb blast (engine/bomb.js) is the only area damage in the game. Order-side micro is comparatively deep: formations with shapes, nesting, leader/follower squads and facing (engine/formation.js + commands.js), escort rings, a Hold stance, waypoint queues, worker/Mender repair (engine/repair.js), and battle wreckage (engine/wreckage.js) that makes holding ground pay. Stutter-step kiting and focus fire are AI-only (state.ai.micro in combat.js, applyFocusFire in aiMilitary.js), and the AI's counter-pick table (COUNTER_OF in aiMilitary.js) is derived solely from bonusVs, so it recognizes counters only for the three triangle units. Static defense is a single T1 building — the Sentinel Turret (attack 20, range 130) — with nothing defensive added at any later tier.

**Economy & Logistics.** T1 is a classic gather loop (engine/gather.js): workers mine softcap-3 nodes (0.4 falloff, tallied per-tick by sim.js countMiners) and bank only at Command Centers — forward drop-offs were deliberately removed (CHANGELOG Unreleased). Odyssey layers a real logistics game on top (engine/haul.js): finite building store/input buffers, auto-assigned haul/service/ferry jobs capped at 2 workers per building, collect-point freighters, and the research-gated autonomous-freighter mode that burns AI Cores (FREIGHTER_AI_TECH, payAIUpkeep); the Plasma Rig (engine/rig.js) is a perpetual, power- and radioactives-fed source that stalls on a full 120-cap buffer. Per-world markets (engine/market.js) price the whole COM catalog by abundance/industry with fast pressure and a slow glut on produced goods, and sell()/buy() already price bulk trades marginally — but the UI only trades one 25-lot per click. The live production chain covers metals→alloys/electronics→machinery→antimatter/AI/torpedoes; the Finished tier is machinery-only and the Luxury tier is entirely legacy-unreachable data (data.js RECIPES header). Inter-world logistics is manual and capital-coupled (goods move only when the player jumps, engine/galaxy.js loadCargo), and background colonies pay a flat, capped credit trickle (COLONY_INCOME_PER_BUILDING) unrelated to what they actually produce.

**Tech, Research & Industry.** Skirmish research lives in engine/entities.js UPGRADES: three mutually exclusive Refinery doctrines (Assault and Bulwark are two tiers of repeated flat multipliers, Logistics has three tiers ending in recycling), locked by committedDoctrine and bought instantly in engine/production.js researchUpgrade, while the Foundry/Arsenal in the BUILDINGS table are pure ore-costed prerequisite gates with no function after their one-time unlock. Odyssey research is engine/techtree.js TECHS: ten Datacenter nodes forming a single unlock spine (metallurgy→electronics→machining→antimatter→aicores→freighterai) with four passives hanging off it, timed via a researchQueue (pay-on-enqueue, queue-ahead prereqs, no cancel/refund) and scaled by the world's tech rating in researchTimeScale — no node anywhere is exclusive with another. Industry (engine/industry.js) runs a fueled power grid (POWER_TIERS distance-efficiency bands, fuel-burning Reactor/Combustor/Biomass Reactor, a single power tech `reactors`) and a factory chain wired to the live subset of data.js RECIPES (smelt→alloy→chipfab→machine→antifab/aifab/plasmafab), throttled by one owner-wide power number and boosted by three global techMult passives. The rest of the recipe catalog (chem, consumer, luxefab, medlab, weapfab, dronefab) is documented legacy with no producer, even though engine/market.js prices every commodity in the catalog, and engine/wonder.js's Antimatter Gate charge reads no tech at all — the tree dead-ends before the finale it unlocks.

**Defense, Superweapons & Victory.** Static defense is exactly one building across all four tiers: BUILDINGS.turret in engine/entities.js (attack 20, range=aggroRange 130, hp 350, no prereqs, no upgrades), fired by updateBuildingCombat in engine/combat.js — nothing else in BUILDINGS carries an attack stat, and every tier-3+ siege unit (Breacher 150, Colossus 185, Leviathan 200) outranges it by documented design, with test/balance.test.js cracksBase guarding that Breachers crack turret lines that stop line units. Skirmish victory (engine/victory.js) is last-Command-Center-standing with a 40-minute DEFAULT_MATCH_TIME_LIMIT score tiebreak; playerScore is exported "so a HUD could show the score" but nothing reads it — hud.js shows only an elapsed clock, and overlays.js showGameOver always prints "the enemy's last Command Center is destroyed" even when scoreLeader decided the match, while the state.matchTimeLimit override hook ("a future quick-match option") is set by no one. Odyssey's endgame works one-directionally: the player's Antimatter Gate (engine/wonder.js) drives a diplomacy finale (GATE_WAR_TARGET in engine/diplomacy.js) and fog-gated AI siege convergence (engine/aiMilitary.js, covered by test/finale.test.js), but engine/aiIndustry.js tops out at Star Dock/Leviathan/Helium Bomb and never builds a wonder, and checkDomination (engine/galaxy.js) makes pacification a sticky cosmetic milestone with no mechanical consumer — a "Conquered" neighbour can rebuild and go hostile again. The Helium Bomb (engine/bomb.js) measures its inverse-square blast center-to-center with a 15-unit peak band, so the header's claimed building one-shots are geometrically unreachable for large footprints (a CC at contact takes ~520 of 1000 hp), and engine/aiSuperweapon.js detonates at ARRIVE_RADIUS 70 where the blast deals ~138 hp to its own chosen target.

**AI Opponent.** The opponent is one orchestrator (engine/ai.js runAI) threading a per-cycle snapshot through ordered phases, with all behaviour coming from three composed plain-data tables — world-picked archetype (engine/aiArchetypes.js: 3 temperaments across 11 worlds), player-picked strategy (engine/aiStrategy.js: 4 rows), difficulty (engine/aiDifficulty.js: APM/micro plus multiplier dials) — gated in Odyssey by a diplomacy hostility ramp. Tier-1 play is genuinely complete: fog-honest scouting, a counter-pick every 3rd unit derived from the bonusVs triangle (engine/aiMilitary.js COUNTER_OF), doctrine research adapted to world economy (engine/aiWorkers.js aiDoctrine), expansion, turrets, and escalating waves. T2/T3/Strategic coverage is partial: Economist/Balanced archetypes tech Foundry/Arsenal and the Odyssey industry chain climbs to Star Dock/Leviathan/Helium Bomb/Plasma Rig (engine/aiIndustry.js), but the Rusher's unit mix never contains a Foundry-gated unit so it never builds one even after Hard's rusherGraduates fires, the counter table has keys only for skiff/bastion/lancer so the AI stops reacting to any T2+/T3 army, and the AI never builds an Antimatter Gate (docs/odyssey-ai-review.md §2.7 defers galaxy-level play). Difficulty tiers are mostly bare multipliers plus the aiMicro tactical bundle, and tools/ailab.js measures only Odyssey worlds, with sparring bots that field nothing but Skiffs and aiApm pinned to null.

**Odyssey Meta-Layer.** The Odyssey meta-layer (engine/galaxy.js) drops the player on a seed-random world (createGalaxy picks startId from ODYSSEY_WORLDS; setup.js line 291 offers only "Begin Odyssey — land on a random world"), instantiates all 11 worlds as living background sims, and moves the player between them via Spaceport jumps with distance-scaled fuel (jumpCost) that is free to any discovered world. A world you leave becomes a background colony that pays a flat, capped credit trickle (COLONY_INCOME_PER_BUILDING * min(6, buildings)) and raises attacked/lost/hostile toasts via sweepColonies — but its player side receives no new orders, so queues drain, idle workers stay idle, and surplus goods pile up unsold. Diplomacy (engine/diplomacy.js) is strictly per-world and one-directional in player agency: grace, grievance, forgiveness, dev-softening, late creep, and geometric tribute all exist, but nothing the player does can raise stance above the truce floor (APPEASE_FLOOR "stops short of friendship"), and the Allied band in stanceLabel is read by no gameplay system. Factions spread across the starmap (checkExpansion claims) but carry no memory — razing a Mining Guild capital changes nothing on any other Mining Guild world — and the finale is local: a charging Gate provokes only the one neighbour on its own world (chargingPlayerWonder in updateDiplomacy), then the "gate" milestone fires fireworks (checkGalaxyProgress) and changes nothing afterward. Net effect: real decisions exist at the start (where to jump) and at the Gate/domination push, but the middle tiers are mostly automatic — colonies, alliances, spaceport tiers (capacity-only, SPACEPORT_CAPACITY) and faction politics offer almost no player-facing choices.

**Worlds, Maps & Terrain.** Nine skirmish worlds share one generator (engine/map.js generateMap): mirrored deposit clusters sized by each planet's data.js deposit table, fixed home-ore nodes on every doorstep, BUILD_CRITICAL seams guaranteeing lean ore/crystals/radioactives near each base, and hidden caches whose count grows with map size. Six worlds carry a PLANET_MODIFIERS entry (speed/sight/build-time/richness plus rectangular rough/high-ground terrain stamped into a 40px Uint8Array), two of them asymmetric via per-owner asym blocks resolved by sideMod; terrain is consumed by movement.js (speed), fog.js (source-tile sight), combat.js (attacker damage), and colliders.js (rough is unbuildable). Map sizes scale self-similarly 1-4x, but only cache counts grow with sizeMult — deposit cluster counts come solely from yieldMult, so Gigantic maps stretch the same surface economy over 16x the area, and bases sit at the same (0.1, 0.5)/(0.9, 0.5) fractions on every world. In Odyssey, ODYSSEY_WORLDS (the skirmish nine plus Kybernet/Verdani) act as de-facto world tiers through data.js industry/tech ratings (industry.js planetIndustryScale, techtree.js researchTimeScale, market.js produced-goods pricing), but the starmap shows only industry/tech badges and a jump to an unsettled world lands via a deliberately blind minimap pick (landingPicker.js, galaxy.js snapLandingPoint).

**UX, HUD & Controls.** The HUD is a signature-guarded topbar (hud.js renderHUD: resources/supply/credits/power/stance, idle-worker chip, group chips) plus a 1661-line per-selection side panel (hudSelection.js) with collapsible sections, positional Z/C/V/B/N hotkeys, live-patched queue/market rows, and rich per-building status lines; input.js gives full mouse/touch parity (box select, Ctrl-additive select with leader promotion, right-drag facing, Ctrl waypoints, per-planet control groups on the session, idle-worker cycling, Space-to-base). Alerts run through boot.js processFrameEvents: an under-attack banner (click jumps to lastAttackAt), a capacity-limited clickable galaxy-toast stack, and world-space pings in effects.js — but minimap.js draws no alert layer at all. Onboarding is a one-time 30-second static objectives strip (overlays.js showObjectives) and a static F1 help sheet; docs/player-handbook.html ships a full field manual but is linked from nowhere in the app. Odyssey adds a ring starmap rebuilt at open time (starmap.js: status/income/stance/industry, no live alert or garrison info) and a blind landing picker (landingPicker.js). Deep-tier discoverability is deliberately thin: the Odyssey build menu hides buildings whose prereqs are unmet (hudSelection.js GROUPS/alwaysShow), Datacenter techs render as a flat lockTip list, and the Gate's charge is visible only in 25% toasts or by keeping the Gate selected.

**Presentation & Platform.** All art is procedural canvas vector work: render.js orchestrates draw order with viewport culling (viewBounds/inView), renderUnits.js/renderBuildings.js hold per-type silhouettes shared with HUD buttons via spriteIcon, and effects.js keeps wall-clock transient effects (tracers, death rings, pings, the Helium Bomb shockwave, milestone fireworks) fed by boot.js processFrameEvents draining state.events — the same queue that drives sound.js's throttled, stereo-panned WebAudio tones. Performance rests on a 20Hz fixed-step sim with render interpolation (renderShared.js lerpXY), a spatial hash (engine/grid.js), and a minimap static-layer underlay cache — but the main view's drawFogBase/drawTerrain still issue per-cell fillRects every frame, up to ~16k cells each when a Gigantic map is fully zoomed out (camera.js minZoomFor allows it). Saves are exact-match versioned and heavily sanitized (engine/persist.js sanitizeSave/cleanEntity), with one localStorage slot per mode autosaved every 12s whose failures are silently swallowed for the periodic callers (saveload.js autoSave). Tier reading is strong through T3 (bespoke Dreadnought, Foundry, Arsenal) but collapses at the top: the Leviathan has no drawUnitShape case and falls to the generic diamond (contradicting renderUnits.js's own "nothing falls through today" comment), and the Antimatter Gate — the game's largest building and only Odyssey win condition — renders as a generic hex stamped with a 🌀 emoji, its 0..1 charge invisible on the map. Render tests (test/renderBuildings.test.js, renderEffects.test.js) cover only the build-ghost/power-cue regression with a fakeCtx Proxy; no test draws the full roster.
