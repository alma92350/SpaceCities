---
title: SpaceCities
emoji: 🚀
colorFrom: indigo
colorTo: purple
sdk: docker
app_port: 7860
pinned: false
header: mini
fullWidth: true
short_description: Multiplayer space RTS with an MCP endpoint for AI agents.
license: mit
tags:
  - game
  - multiplayer
  - rts
  - websocket
  - mcp
---

# SpaceCities

A browser-based real-time strategy game set in the same universe as
[Stellar Frontier](https://github.com/alma92350/SpaceExploration) (the turn-based space
trading/exploration game) — a separate, standalone game, not a mode bolted onto the original.
Vanilla JavaScript, ES modules, **no build step, no dependencies**. Play a 1v1 skirmish against a
scripted AI, or an open-ended **Odyssey** that strings worlds together into a galaxy you settle,
trade across, and conquer.

This repository is a port of [Stellar Frontier: RTS](https://github.com/alma92350/SpaceExploration-RTS)
into a **multiplayer** RTS deployed at
[huggingface.co/spaces/Almaatla/SpaceCities](https://huggingface.co/spaces/Almaatla/SpaceCities),
adding networked matches and an MCP server so AI agents can play as ordinary seats alongside
humans. Everything below documents the game **as it plays today** — the single-player skirmish and
Odyssey described in this README are unchanged and still run entirely offline (see
[Architecture Decision Record 0004](docs/adr/0004-loopback-transport.md)). The multiplayer and
agent-play work is tracked in [`docs/PRD.md`](docs/PRD.md) (what and why),
[`docs/adr/`](docs/adr/) (the architecture decisions and their evolution), and
[`TASKS.md`](TASKS.md) (where the port is and what's left).

## Running it

The game has no build step, but it loads as ES modules, which browsers refuse to import over
`file://` — so it needs to be served over HTTP. A zero-dependency dev server ships with the repo:

```
npm start          # serves at http://localhost:8080
```

Nothing to install first — no `npm install`. (Any static server works too: `npx serve .` or
`python3 -m http.server`.) Then open the printed URL. Requires Node ≥ 20.

## Tests

```
npm test
```

Runs the full suite (`node --test`): the engine's unit and integration tests — including a full
simulated skirmish played out to a winner and a galaxy played across multiple worlds — plus the
determinism, purity, and static-integrity guards. See [CONTRIBUTING.md](CONTRIBUTING.md) for the
invariants those guard.

```
npm run typecheck
```

Type-checks the JSDoc-annotated files against the shared shapes in `engine/types.js`
(`tsc -p jsconfig.json`; needs a TypeScript compiler on the path, or `npx -y typescript`). CI runs
it as a required step alongside the suite, so it is worth running before you push.

## The skirmish

A 1v1 real-time match against a scripted AI on one of nine charted worlds, picked at the start.
Gather ore/crystals/radioactives with Workers, build a Barracks, produce a mixed army, expand and
fortify, fight under fog of war, and win by destroying the enemy's last Command Center (or lose
yours). A defensive stall can't run forever: if neither side is finished off, a match time limit
settles it on score (banked resources plus the built value of everything you own), so there's
always a terminal state.

The splash screen configures the skirmish before you pick a world. **AI speed** is a 1–150
actions-per-minute cap on the opponent — every command it takes (produce, build, expand, research,
scout) spends one action, so a low setting is a sluggish, forgiving foe and a high one relentless
(its attack commit is exempt, so it always resolves the game). **Map size** scales the field from
Small (1600×1000) up to Gigantic (4×) with more caches in the bigger space, **Resources**
(Rare / Normal / Abundant) scales every deposit's yield, and **Match length** picks Quick (20 min),
Standard (40 min), or Marathon (60 min) instead of always the same fixed clock — the final 5
minutes flip the readout to a countdown next to a live score bar either way. Whatever the world,
every map guarantees a near-base surface source of ore, crystals, and radioactives so all builds
are possible — the planet's own deposit table just shapes how much of each there is. Oort's and
Nimbus's asymmetric matchups also offer a side-swap toggle, so either half is playable from either
seat.

**Units.** Four combat units. Three form a genuine rock-paper-scissors triangle, not just a single
hard counter: Skiff (fast, cheap) beats Lancer, Bastion (slow, short-ranged, tanky) beats Skiff,
and Lancer (long-ranged, armor-piercing) beats Bastion — each unit's bonus damage targets exactly
the matchup that would otherwise be its worst, and nothing beats all three at once. The fourth, the
Breacher, sits deliberately *outside* the triangle: a slow siege platform that outranges static
defenses and tears through buildings, but has the worst anti-unit damage in the game and folds to
massed Skiffs for a fraction of its cost — a turtle-breaker that's helpless without an escort.
Scouting what the enemy is building, and countering it, matters.

**Veterancy.** Every confirmed kill counts toward a unit's own record — three permanent ranks
(earned at 3, 8, and 18 kills) each layer roughly the same compounding bonus, stacking to about
+19% damage dealt and −17% taken at max rank, visible as small chevrons over the health bar.
Turrets and buildings never rank up; only units that can actually fight do, and the bonus survives
repair, so a bloodied army is worth pulling back to heal rather than replacing.

**Tech: doctrines and structures.** A Refinery (built by a Worker, like the Barracks) researches
army-wide upgrades — timed rather than instant now (scaled by the world's own tech rating, so a
Refinery mid-research is a real, raidable window), applied live the moment each finishes, not just
to future production — but they're three **mutually-exclusive doctrines**, so this is a real
commitment, not a buy-both. **Assault** (Overcharged Weapons → Overcharged Core → Overdrive
Actuators) stacks more damage dealt and eventually faster attacks; **Bulwark** (Reinforced Plating →
Reinforced Bulwark → Self-Sealing Plating) stacks less damage taken and adds out-of-combat regen —
by every unit AND every structure, turrets and the Command Center and Habitats included, so it's the
turtle doctrine for your base as much as your army. **Logistics** trades combat power for economy
and tempo instead. Researching one locks out the other two, and each now runs a full three tiers
deep, the last gated behind an Arsenal. Assault costs radioactives and Bulwark crystals, so a
world's deposit specialty (Korrath has no crystals, Vesper no radioactives) tilts which doctrine
comes easier. Beyond the Refinery, a Foundry and a Datacenter open further research — crystals and
radioactives fund all of it, so those deposits never dead-end.

**Expanding and fortifying.** The Command Center is buildable (steep — 400 ore, slow to raise), so
taking a second base is a real mid-game decision: nodes deplete, and a fresh field plus a fresh
drop-off point is how you outlast a drained home economy. Static defense now runs three tiers: the
Sentinel Turret (crystal-funded), the Foundry-gated Bastille (tankier and harder-hitting but
shorter-ranged), and the Arsenal-gated Aegis Bastion (fires nothing — it just shields everything
friendly nearby, units and structures alike, by 20%) — all of it makes raids cost something and
base layout matter, and the Breacher remains the answer to a wall of any of them, since every siege
unit still strictly outranges every static-defense structure.

**Supply.** Army size is capped by supply, not just ore: every unit costs some, Command Centers
grant a baseline, and a cheap Habitat raises the ceiling. It's a genuine macro choice (army now vs.
infrastructure now), a raidable weak point (burn a Habitat and push someone over their cap), and it
keeps late-game battles bounded. Losing a Habitat can leave you legally over cap — nothing dies,
but production blocks until you rebuild.

**The AI.** Each world gives the AI a different temperament — Rusher (small economy, commits
early), Economist (out-scales before attacking, expands and turtles behind turrets), Balanced, or
the Kybernet-only Technologist (small and teched-up — the only archetype that ever fields a
Colossus) — and it plays the whole toolkit: it attacks in repeated waves, not just once; it scouts
and reacts to whatever combat type you field most, a hard counter inside the Skiff/Bastion/Lancer
triangle and a documented cost-efficient answer (usually massed Skiffs) for anything outside it,
including a wall of your own turrets — more often the higher the difficulty, never on Easy; and it
expands when its home ore runs thin, fortifies the approach lane with turrets (and Bastilles, once
it has a Foundry), runs multiple Barracks, and raises Habitats to stay under supply. It plays under
its own fog too — not omniscient — reacting only to what it has actually seen.

**Worlds.** Six of the nine worlds carry a single rule modifier that applies to both sides —
Glacius's ice slows everyone, Nimbus's storms shorten sight, Pyralis's open dunes lengthen it, Helix
packs an extra crystal field, Oort's deposits run rich, and Forge's industry speeds construction.
Six also carry **terrain**: rough ground you cross slower (never impassable — it slows and shapes,
it doesn't wall) and high ground that sees farther and hits harder — real objectives to seize.
Terrain is mirrored, so both sides face the same ground, and you can't build on rough ground, so
base layout has to work around it. Two worlds are **asymmetric matchups** where the modifier hits
the sides *differently* (Oort: you out-mine, they out-build; Nimbus: you out-scout, they
out-tempo), so which corner you start in defines your plan. The three original worlds (Ferros,
Korrath, Vesper) stay clean open plains.

**Fog & caches.** Fog of war hides enemy units and buildings outside your vision. The charted
surface deposits near each base are always shown — map knowledge, not battlefield intel — but the
map also hides resource **caches** in the contested middle and along the edges: extra deposits the
survey missed, invisible until one of your units scouts their location, then marked permanently.
They often hold the crystals or radioactives a world's surface lacks, so scouting can unlock a
resource — and the tech that needs it — you'd otherwise have no access to.

### Controls

Left-drag to select (Ctrl+drag adds to the selection, Alt+drag subtracts), right-click to move or
gather/assist-build/attack/set-rally depending on what's selected and under the cursor,
Ctrl+right-click to queue that order as a waypoint (chain several to lay down a path — combat units
attack-move along it), mouse wheel to zoom, WASD/arrow keys or the screen edge to pan. Control
groups bind with Shift+1–9 and recall with 1–9; double-click a unit to grab every on-screen unit of
that type (Ctrl+double-click extends the grab to the whole map, not just what's on screen); **Q**
selects your whole army, **X** halts the selection, **R** turns a selection's already-queued
waypoint path into a looping patrol, **`** cycles idle workers, **Space** centers on (and cycles
through) your bases, **Backspace** jumps to the most recent attack ping, **T** opens a full Tech &
Industry Chart overlay, and **P** pauses. Right-click the minimap to order the selection somewhere
off-screen. Click a Worker or a completed building for build/produce/research options in the side
panel (unaffordable options are greyed out); a full controls reference sits in the panel whenever
nothing is selected, and **F1** or **?** opens the help overlay.

## The Odyssey

The Odyssey is the open-world meta-layer: instead of a single match, you play a whole galaxy. Pick
your starting world from a card row of all 11 (or roll randomly), and every world is a full
skirmish map — but they never resolve by conquest or clock. Instead you hold **universal credits**
that travel with you, build a **Spaceport**, and **jump** to another world (jumps cost fuel, scaled
by distance and discounted up to 30% by your Spaceport's tier, funded by trading commodities at the
market). Settle a new world by carrying a **colony ship** on the jump and deploying it into a
Command Center; the world you leave becomes a **background colony** that keeps working, pays you
passive income while you're away, and can be handed standing orders (an auto-sell floor, a worker
headcount to sustain) so it keeps developing unattended.

The galaxy is alive before you visit it, but not all of it at once: alongside your seat, three
other worlds — a pseudo-random draw from the galaxy seed, so which three is part of what that seed
means — develop, trade and drift diplomatically in the background from turn one, and every world
you've been to keeps running after you leave. The rest of the roster stays dormant until you jump
there, then joins the living galaxy too.

Each world's neighbour has its own **diplomacy** — a grace period, grievances if you strip-mine or
attack, forgiveness that varies by personality, paid tribute truces, and now gifts plus occasional
favor requests as an actual road to Allied (which also trades at a tighter market spread) — so how
you treat a world shapes whether it turns hostile and sends waves after you. A developed neighbour
on Hard, or a patient one on any difficulty but Easy, can even race its own Antimatter Gate; if it
finishes, that faction claims the galaxy's unclaimed worlds in one burst and its stance toward you
locks cold for good. There's no hard win: the Odyssey is a **play-forever sandbox**, and progress is
marked by milestone fireworks — colonies founded, an **Antimatter Gate** coming online, and
**conquest domination** as you pacify neighbour after neighbour (a pacified world can never be
dragged back to war, quietly pays you a small annuity, and ripples its faction's standing toward
you) — that you keep playing past. Press **O** any time to flip into **Observer Mode**, a free-look
spectator camera over the whole galaxy with a live stats readout, if you'd rather watch the AI
factions develop than play a hand yourself. The world roster is the nine skirmish worlds plus two
Odyssey-only extras (a research capital and an agri world).

Aiming to pacify all 11? See
[docs/odyssey-conquest-strategy.md](docs/odyssey-conquest-strategy.md) for a full campaign playbook
against Hard difficulty, sourced from the engine and from real `tools/ailab.js` probes.

## Saves

Because the sim is deterministic and seed-driven, a save is just the serialized dynamic state — the
map regenerates from the seed on load, so saves stay small. Two channels:

- **Autosave** keeps the current game in browser `localStorage` on a timer (and on tab-hide /
  unload), so the map-select **Continue** buttons resume exactly where you left off — no manual
  save. Skirmish and Odyssey each have their own slot.
- **Save / Load** buttons move a save to and from a `.json` **file** — an explicit backup or
  transfer you keep on disk. A file import auto-detects whether it's a skirmish or a whole galaxy by
  its shape.

Saves are untrusted input: every load is sanitized and coerced (bad types dropped, numbers clamped)
before it touches the running game. Version checking is exact-match, not migration — a save whose
`v` doesn't equal the current `SAVE_VERSION`/`GALAXY_SAVE_VERSION` is rejected outright rather than
loaded into a broken state, with no attempt to translate it forward.

## Versioning

`version.js` holds `APP_VERSION` (the running build's semver) and is kept in sync with
`version.json`; an in-app update check compares the deployed `version.json` against the baked-in
value and tells you when a newer build is live — and whether it keeps your saves. Save-format
versions (`SAVE_VERSION` for skirmish, `GALAXY_SAVE_VERSION` for Odyssey) live in
`engine/persist.js` and are bumped independently whenever a save's shape changes in a way older
saves can't survive. Bumping either is a hard compatibility break: the loader requires an exact
version match and rejects anything else outright, with no migration and no partial tolerance —
which is what that "whether it keeps your saves" note above is warning you about. See
[CHANGELOG.md](CHANGELOG.md) for release history.

## Project layout

- `engine/` — the simulation: pure, deterministic, DOM-free logic. Fixed-timestep loop, movement +
  local avoidance, gather, combat, production, supply, placement validation, fog of war, AI, the
  market, diplomacy, colony/jump mechanics, and save serialization. Runs headless under
  `node --test`.
- `main.js` — **the page's only entry point** (`index.html` loads it and nothing else). Its
  side-effect-only imports (`starmap.js`, `techChart.js`, `update.js`) are load-bearing: those
  modules self-wire their buttons and hotkeys at module-load time, so dropping one silently
  disables a feature rather than raising an error.
- `render.js` / `renderUnits.js` / `renderBuildings.js` / `renderEffects.js` / `renderNodes.js` /
  `renderShared.js` / `minimap.js` / `camera.js` / `effects.js` — the canvas view. `render.js`
  orchestrates the frame; the `render*.js` family draws units, buildings, effects and nodes; there
  are no images, every silhouette is vector drawing code.
- `input.js` / `inputCommands.js` — mouse/keyboard/touch controls. `input.js` owns the stateful
  half (drag boxes, pinch gestures, held keys, control groups); `inputCommands.js` owns the
  stateless half — what is at a point, and what the right-click command ladder does about it.
- `hud.js` / `hudSelection.js` / `hudPanelSignature.js` / `overlays.js` / `setup.js` /
  `landingPicker.js` / `observerPanel.js` / `techChart.js` / `starmap.js` / `dom.js` — UI chrome.
  `hudSelection.js` owns the selection panel: one `render*` function per panel family, dispatched
  by `rebuildSelectionPanel`, with `hudPanelSignature.js` deciding when a rebuild is needed at all.
- `boot.js` / `session.js` / `saveload.js` / `update.js` / `version.js` / `saveShape.js` — wiring
  the sim to the page, session state, save/load, and the version/auto-update check.
- `sound.js` / `observer.js` — audio cues and Observer Mode.
- `data.js` — pure content (factions, the commodity catalog, production recipes, the charted
  worlds).
- `tools/serve.js` / `tools/ailab.js` / `tools/selfplay-cli.js` — Node CLI benches, never loaded by
  the browser: the zero-dependency dev server behind `npm start`, and a headless AI bench that runs
  the sim without a browser, scores the opponent over a long session, A/B-tests candidate AIs
  supplied as JSON, and evolves new ones. See [docs/odyssey-ai-review.md](docs/odyssey-ai-review.md)
  and [docs/ai-evolution-design.md](docs/ai-evolution-design.md).
- `tools/selfplay.js` / `tools/duelCore.js` / `tools/genome.js` — **shipped code that happens to live
  under `tools/`**, not benches. They run a match headlessly, which is what the CLI wants *and* what
  the in-browser competition Worker (`competitionWorker.js`) wants, so `boot.js`, `competition.js`
  and `playerFingerprint.js` import them too. Because a duel's outcome becomes a persisted Elo
  rating, they carry the same determinism and DOM-free requirements as `engine/`, and
  `test/engine-purity.test.js` scans them alongside it.

## Background: why a separate repo

The original game has no build step and no module system: ~30 script-tag files all read and mutate
one global state singleton, built entirely around discrete player-action "cycles." A real-time game
needs a wall-clock delta-time loop and a different state/update model, so retrofitting it would mean
a large, risky rewrite of a game that already works. This repo starts clean instead — same universe,
new engine.

What carried over: `data.js` (copied verbatim — genuinely pure data with zero dependency on the
original's turn/state engine) and the `style.css` `:root` colour palette (so the two games read as
the same universe). `catalogs.js` and `galaxygen.js` were **not** copied — they look like reusable
content tables but are logic-coupled to the original's global state and turn/political systems, so
copying them would just import dead or broken references. Anything worth reusing from them is design
inspiration to rebuild deliberately for a real-time model, not code to drag over.

## License

[MIT](LICENSE).
