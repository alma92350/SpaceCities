# In-Game Competitions and Elo — design + phased implementation

*Today the AI competition machinery is a developer tool: `tools/ailab.js` and `tools/selfplay.js`,
driven from a Node CLI by whoever is tuning the AI. This proposal turns it into a **game feature** —
the player organises a competition from the splash screen, between AI entrants alone or with
themselves in the field, and an Elo ranking accumulates across it. Nothing here invents a new way of
deciding who won a match: every phase below is built on the fairness machinery that already exists
and has already had bugs found in it.*

---

## 1. What exists today (and what doesn't)

**The match primitive is done.** `tools/selfplay.js` drives *both* seats of a real skirmish with the
real controller — `runAI(state, dt, owner)` for owner `"ai"`, and a second `state.playerAi`
controller for owner `"player"` — resolved by `engine/victory.js`'s ordinary
elimination/score-at-clock rule, unmodified. The engine is already owner-parametric
(`controllerFor`/`otherOwner` in `engine/aiCommon.js`), and `engine/persist.js` already serialises
`state.playerAi`, so an AI-vs-AI match can even be saved and resumed.

**The fairness machinery is done, and it was hard-won.** `tools/ailab.js` pins APM/micro identically
for both sides through one shared object (`pinnedDuelDials`), side-swaps every pairing by default
(`runSwappedDuel`), alternates the map's own `asym` halves by replicate parity, keeps difficulty as a
never-blended bracket axis (`runDuelBrackets`), and derives every match seed from a sorted hash of
the pair (`duelSeed`). Each of those exists because a naive version was tried first and an
independent review found a real bug in it — see `docs/odyssey-ai-review.md` §2.8.

**The scheduling is done.** `runRoundRobinSwapped` (every pair) and `runSwissTournament` (Swiss
pairing with backtracking matching and proper bye assignment) both already ship in `tools/ailab.js`.

**Three things do not exist:**

| Missing | Where it bites |
|---|---|
| **Any rating system.** Standings are raw `{wins, losses, draws}` tallies. | Nothing carries skill across competitions, and a 6–2 result against a strong field reads the same as 6–2 against a weak one. |
| **Any browser entry point.** `tools/selfplay.js:197` dereferences `process.argv` at module top level, so importing it in a browser throws `ReferenceError`. `setup.js`/`boot.js`/`main.js` are deliberately untouched by it. | The game literally cannot run a self-play match today. |
| **Any human seat in a competition.** Self-play means both seats are AI, by construction. | The whole "compete against the bots yourself" half of the request. |

**Measured cost** (this machine, Node 20 — it decides what's feasible in a browser tab):

| Workload | Wall clock |
|---|---|
| One match resolved by elimination (~8–15 sim-min) | **~1.0 s** |
| One match run to the full 40-sim-min clock (worst case) | **~1.8 s** |
| `duel --worlds korrath,ferros --seeds 2` (8 matches, side-swapped, all went to the clock) | **14 s** |
| An 8-entrant Swiss round at those settings (4 pairings × 2 sides × 2 worlds × 2 seeds = 32 matches) | **~60 s** |

So: a **quick duel is instant enough to run in the foreground; a tournament round is not.** That one
number drives Decision D5 below.

---

## 2. Decisions this plan makes once

The catalog-style convention from `docs/improvement-roadmap.md`: resolve the contentious calls up
front so implementation doesn't stall re-litigating them.

### D1 — One Elo implementation, shared by the game *and* the CLI

A new **root-level pure module `elo.js`**, imported by both the in-game competition screen and
`tools/ailab.js`. Not under `engine/` — `engine/` is the simulation, and a rating is not sim state.
Root-level pure modules are already the established home for this kind of thing (`camera.js`,
`minimap.js`, `saveShape.js`, `version.js`).

*Why it matters:* if the bench and the game each grow their own rating math, a number the player sees
in-game and a number a tuning session reports stop meaning the same thing — and the entire value of a
rating is that it's comparable. One module, one meaning.

### D2 — Ratings are bracketed by difficulty, never blended

`runDuelBrackets`' header already argues this for win-rates: averaging across difficulty brackets lets
an edge at one APM/micro cap paper over a deficit at another, which is the exact confound the duel
mechanism exists to rule out. A shared Elo pool across brackets reintroduces it one level up.

So a rating is keyed **`(entrant, difficulty bracket)`**. A competition declares its bracket(s); each
bracket keeps its own table. "Aggressive @ Hard" and "Aggressive @ Medium" are two ratings, and the UI
says so.

### D3 — An entrant is `{ name, strategy, difficulty, faction }`; archetype is a Phase-2 addition

`createAiController(planetId, opts)` sets `archetype: archetypeFor(planetId)` — **derived from the
world, so both seats in a self-play match share it.** That's fair, but it means "Rusher vs Turtle"
head-to-head is not expressible today. Adding an optional `archetype` opt to `createAiController` is a
small additive change that makes competitions substantially more interesting, so it lands in Phase 2
rather than being smuggled into Phase 1.

### D4 — The human always plays owner `"player"`, and the plan says so out loud

`state.fog` aliases `state.fogs.player`, `state.selection` is documented as the human's, and
`input.js`/`hud.js` resolve the human seat as `"player"` throughout. Seating a human as `"ai"` is not
a competition feature, it's a renderer/HUD/input rewrite.

Consequence: **side-swap — the default correction for seat asymmetry — is unavailable for human
matches.** And there *is* a known seat edge: `tools/selfplay.js`'s own header measures the `"ai"` seat
reading state the `"player"` seat already mutated on 13% of think cycles, "FIXED IN DIRECTION: it
always favours the `ai` seat". The human sits in the seat that edge is measured *against*.

The honest handling, and what this plan does:
- Map-asym swap (`swapAsym`) still alternates by replicate parity for human matches — the map half is
  balanced even when the seat can't be.
- Every ledger row records `seatSwapped: true|false`, so a human-inclusive table is visibly built on
  half-corrected rows rather than silently.
- The competition screen states the bias in one line where the human's rating is shown.
- It is **not** papered over with a compensating rating fudge. A fudge factor nobody can derive is
  worse than a disclosed, bounded, one-directional bias.

### D5 — AI matches batch-simulate in a module Web Worker; the player can watch any one live

From the timings: a duel is foreground-fast, a tournament round is a minute. Freezing the tab for a
minute is not acceptable, and chunking across `setTimeout` makes the sim compete with rendering for
the main thread.

The engine is DOM-free — which is precisely what makes a Worker trivial here. `new Worker("./
competitionWorker.js", { type: "module" })`; `tools/serve.js` already serves `.js` as
`application/javascript`, so no build step and no server change. The worker posts progress per match;
the UI shows a progress bar and a **Cancel** that actually cancels.

Watching a pairing live is the *other* path (Phase 5), through the normal game loop — not a
replacement for batch simulation.

### D6 — A competition is a pure function of `(seed, roster, format)`

Every match seed derives from the competition seed via `hashStr` in the same style as `duelSeed`:
`hashStr(`${seed}:comp:${round}:${pairIdx}:${world}:${rep}`)`. Rating updates are applied in a
**canonical order** (round, then pairing index, then side) because Elo is order-dependent — so
re-running the same competition reproduces the same final table, byte for byte. That is what makes any
of this testable at all, and it matches the determinism discipline the rest of the repo already holds
itself to.

Human matches break purity by definition (a human is not a seeded input). Those rows are recorded as
*results*, not re-derived; a competition containing a human match replays its AI half deterministically
and reads the human rows back from the ledger.

### D7 — Plain Elo first, with honest uncertainty. Not Glicko-2, not margin-scaled

- `E = 1 / (1 + 10^((Rb - Ra)/400))`, `R' = R + K(S - E)`, start **1200**.
- `K = 40` while provisional (< 10 games), then `K = 20`, then `K = 10` above 2400.
- `S ∈ {1, 0.5, 0}`. Draws are near-impossible anyway — `checkWinCondition`'s score tiebreak means a
  "draw" only happens when a run hits its safety-net cutoff undecided.
- **No margin-of-victory scaling.** `engine/victory.js`'s score margin is reported alongside the
  rating as its own column and used as a standings tiebreak — but it does not feed the rating. Rating
  systems that fold in margin need careful calibration nobody here is going to do, and an
  uncalibrated one is a rating that quietly rewards running up the score.
- Entrants below 10 games render with a `?` and their game count. Glicko-2's rating deviation is the
  principled version of that and is a fine later upgrade — it's deferred, not dismissed.

### D8 — The ledger is versioned, sanitized, untrusted input

Same discipline as `engine/persist.js`, in the UI layer: `COMPETITION_VERSION`, exact-match version
gate, `sanitizeLedger()` coercing every field's type and range on load, prev-slot rotation on write
(mirroring `saveload.js`'s `autoSave`). Plus **export/import as a JSON file** through the existing
Save/Load file idiom, so a ladder can be shared or archived.

---

## 3. The format menu (brainstorm)

Formats worth having, ordered by value-per-effort. The first three are mostly *wiring* — the
scheduling already exists in `tools/ailab.js`.

| Format | What it answers | Status of the machinery |
|---|---|---|
| **Quick Duel** — two entrants, best-of-N, side-swapped | "Is A better than B?" | `runSwappedDuel` — done |
| **Round-robin** — every pair once | "Rank this small field" | `runRoundRobinSwapped` — done |
| **Swiss** — N rounds, closest-standing pairing | "Rank a large field cheaply" | `runSwissTournament` — done |
| **Gauntlet** — one entrant vs the entire field | "How good am *I* really?" — the natural human-inclusive format | Trivially a round-robin restricted to one row |
| **Knockout bracket** — single elimination | The most legible tournament *picture*; a real final | New, but small: pairing is a tree, matches are still `runSwappedDuel` |
| **Ladder / season** — persistent Elo, ad-hoc challenge matches, periodic reset | "Play forever" — matches the Odyssey's own sandbox philosophy | New: the ledger (D8) plus a challenge button |

**Human-inclusive scheduling.** The round flow becomes: *your* match is played live, everyone else's
batch-simulates. Concretely — "Round 2 of 5. Your match: **You (Frontier)** vs **Aggressive @ Hard**
on Korrath. `[Play]` `[Forfeit]`" → the human plays a normal skirmish → on `state.over`, the result
posts to the ledger → "Simulating 7 other matches…" → the round table and Elo deltas appear. A
forfeit records a loss; a bye records no rating change (standard Swiss practice, already how
`runSwissTournament` treats byes).

**Handicaps, deliberately not offered as a rating-affecting dial.** A human who wants an easier match
picks a lower-difficulty *opponent* — which is already a distinct entrant with a distinct rating
under D2, so the ladder stays coherent. A separate "handicap" multiplier would silently invalidate
every rating in the pool.

---

## 4. Phased implementation

Each phase is independently shippable and independently valuable. Effort tags are the roadmap's own
S/M/L. TDD per `CONTRIBUTING.md` — tests written from the requirement, red before green.

### Phase 0 — Make the self-play core importable from a browser *(S, no user-visible change)*

The blocker, and nothing else.

- Extract the pure core of `tools/selfplay.js` (`createSelfPlayState`, `tickSelfPlay`,
  `runSelfPlayMatch`, `fingerprint`) so it carries **no Node-only reference at module scope**. Either
  move the CLI half into a sibling `tools/selfplay-cli.js`, or guard line 197 with
  `typeof process !== "undefined"`. Prefer the split: the guard leaves a Node-shaped file in the
  browser's import graph and invites the next such line.
- Keep the file *itself* free of DOM too, so the same module runs in Node, on the main thread, and in
  a Worker.

**Files:** `tools/selfplay.js` (pure core) and `tools/selfplay-cli.js` (CLI entry point).
**Tests:** existing `test/ai-selfplay.test.js` stays green; add a case asserting the core module's
source contains no bare `process`/`document` reference (the `test/engine-purity.test.js` idiom,
pointed at this file).
**Done when:** `node tools/selfplay-cli.js run …` still works and the core imports cleanly with `process`
deleted from the global scope.

**Status: done.** The split landed exactly this way — `tools/selfplay.js` now holds only
`createSelfPlayState`/`tickSelfPlay`/`runSelfPlayMatch`/`fingerprint` (plus the `DT` they share) with
zero `process`/`document` references, and `tools/selfplay-cli.js` took the CLI half
(`parseArgs`/`runCmd`/`USAGE`/`main`) — run it as `node tools/selfplay-cli.js run …`.

### Phase 1 — `elo.js`, and an AI-vs-AI **Quick Duel** in the game *(M)*

The thinnest end-to-end slice: two AI entrants, a real match, a real rating change.

- **`elo.js`** (new, root, pure, `// @ts-check`): `expectedScore(a, b)`, `kFactor(games)`,
  `applyResult(ratings, aName, bName, score)`, `applySeries(ratings, rows)` — the last one enforcing
  D6's canonical ordering. No clock, no storage, no DOM.
- **`tools/ailab.js`**: `duel`/`swiss` gain an Elo column via the same module. This is the proof of
  D1 and costs almost nothing.
- **Competition screen**: a new `"competition"` entry in `setup.js`'s `MODES`, rendering a picker for
  two entrants (Strategy × Difficulty × Faction, reusing `optionGroup` and the existing
  `STRATEGY_OPTIONS`/`DIFFICULTY_OPTIONS`/`FACTION_OPTIONS` tables), worlds, seeds, and match length.
- **`competitionWorker.js`** (new): receives a job, runs matches through the Phase-0 core, posts
  `{type:"progress"}` per match and `{type:"done"}` with the rows. Cancellable.
- **Results view**: per-match table (world, seed, side, winner, reason, score margin) plus the
  rating delta — the shape `ailab`'s own printed table already uses, so the two read alike.

**Files:** `elo.js`, `competition.js` (screen + job orchestration), `competitionWorker.js`,
`setup.js`, `index.html`, `style.css`, `tools/ailab.js`.
**Tests:** `test/elo.test.js` (symmetry: equal ratings ⇒ E = 0.5; zero-sum: `Δa = −Δb` at equal K;
K schedule; **order-independence of the final table under D6's canonical sort**);
`test/competition.test.js` for job-shape/seed-derivation purity; `static-integrity` covers the new
DOM ids automatically.
**Risk:** the Worker is the one genuinely new browser surface. Keep the worker a thin shell — all
logic in importable modules — so it's testable under Node without a Worker at all.

**Status: done.** Landed across two stages on this branch: `elo.js` plus `tools/duelCore.js` (the
match-runner extracted out of `tools/ailab.js` — not in the Files list above, added so a Worker
could import it without ailab's ~1600 lines of CLI code) and `tools/ailab.js`'s own Elo column
landed first; `competition.js` (the Quick Duel screen's pure job/seed/table/Elo logic plus its
DOM rendering) and `competitionWorker.js` (the batch-simulating module Worker) landed second,
wired into `setup.js`'s `MODES`/`renderMapSelect()` and `style.css`. Two deliberate deviations
from the sketch above, both explained in `competition.js`'s own header comment: no Faction picker
(a duel's dial set — archetype/strategy/difficulty — has no faction option at all in
`tools/selfplay.js`'s `createSelfPlayState`, so offering one would be cosmetic in a way that could
misleadingly imply a gameplay effect) and no match-length picker (kept to the screen's own
explicit spec; every duel runs at `engine/victory.js`'s default 40-minute clock). `index.html`
needed no changes — the screen reuses `mapSelectEl`, the same div `setup.js`'s own cards already
own.

### Phase 2 — Named roster, per-entrant archetype, persistent ladder *(M)*

Turns one-off duels into something that accumulates.

- **Roster**: name your entrants ("Blitz", "The Turtle"), stored in the ledger. Same
  `{name, strategy, …}` shape `tools/candidates/*.json` already uses, so a candidate file and a
  roster entry are interchangeable — and `ailab` candidates can be imported straight in.
- **Per-entrant archetype (D3)**: add an optional `archetype` opt to `createAiController`, defaulting
  to `archetypeFor(planetId)` so every existing call is byte-identical. Then an entrant can carry its
  own doctrine and "Rusher vs Turtle" becomes a real matchup.
- **Ledger (D8)**: versioned localStorage store — roster, per-bracket ratings, competition history,
  head-to-head records — plus JSON export/import.
- **Standings screen**: rating, games, W/L/D, average score margin, provisional flag, per bracket.

**Files:** `engine/state.js` (one additive opt), `competition.js`, `competitionLedger.js` (new),
`saveload.js` (file export/import reuse), `engine/types.js` (typedef).
**Tests:** ledger round-trip; sanitizer rejects a wrong-version / corrupt / hostile payload
(`test/save-hardening.test.js` is the model); `createAiController` default-archetype byte-identity;
`test/types-contract.test.js` compliance.
**Save-version note:** the *game* save shape is untouched — this is a new, separately-versioned store.
`state.playerAi` is already persisted, so watching and saving an AI-vs-AI match needs no bump either.

**Status: done.** Landed across two stages on this branch. Stage one: `createAiController`'s
`opts.archetype` (D3's own resolution seam — a string key into `ARCHETYPES`, falling back to
`archetypeFor(planetId)` exactly as before for every pre-existing call site) plus `competitionLedger.js`
itself (`createLedger`/`addRosterEntry`/`removeRosterEntry`/`recordCompetition`/`standingsFor`/
`sanitizeLedgerStructure`/`exportLedger`/`importLedgerJSON`/`loadLedgerFromStorage`/
`saveLedgerToStorage`), with no UI wiring yet. Stage two (this one) wired it all into the game:

- **Archetype threading (D3), the rest of the chain.** `opts.archetype` only ever reached
  `createAiController` before this stage — nothing above it could actually set it for a Quick Duel.
  `engine/state.js`'s `createGameState` gained the matching `opts.aiArchetype`, forwarded to its own
  `state.ai` controller; `tools/selfplay.js`'s `createSelfPlayState` threads `ai.archetype`/
  `playerAi.archetype` independently to both controllers it builds; `tools/duelCore.js`'s
  `runDuelMatch` gained `aArchetype`/`bArchetype` config fields, forwarded into
  `createSelfPlayState`. All additive and opt-in — every field defaults to absent/null, resolving
  identically to before this stage. One deliberate constraint held throughout: `runDuelMatch`'s
  *returned row* never grew an archetype field — `test/duelCore.test.js`'s own exact-shape test
  pins that set byte-for-byte (every `tools/ailab.js` consumer depends on it), so archetype is an
  **input dial only**, resolved into the created states, never echoed back as output.
  `competitionWorker.js`'s `runCompetitionJob` reads `entrantA.archetype`/`entrantB.archetype` off
  the job (defaulting to `null`) and threads each entrant's own archetype onto the correct seat in
  *both* side-swapped directions, right alongside strategy.
- **`competition.js`'s entrant config gained an Archetype picker**, built from `engine/aiArchetypes.js`'s
  `ARCHETYPES` (`ARCHETYPE_OPTIONS`, derived from its four keys' own `name`/`workerTarget`/
  `attackTimeout` fields — no hardcoded second list), reusing `setup.js`'s `optionGroup` per the
  brief. `buildJob` carries `archetype` through per entrant, coercing anything that isn't a real
  `ARCHETYPES` key to `null` rather than trusting it verbatim.
- **The key UX decision — every Quick Duel entrant is now a named, persistent roster row.** Each
  entrant picker is either "From Roster" (a `<select>` of `competitionLedger.js`'s current roster,
  each option reading name + strategy + archetype + faction) or "New Entrant" (the same
  strategy/archetype fields, plus a **Faction** picker — new; Phase 1 deliberately omitted a
  Faction picker for the *duel itself*, still true (`tools/selfplay.js` takes no faction dial), but
  a roster entry's own identity does carry one, so the New Entrant form offers it for that, with a
  line making the distinction explicit). The pure "which entrant is this, really" resolution is
  `resolveEntrantPick(pick, ledger)`, unit-tested directly. A brand-new entrant joins the roster —
  via `addRosterEntry` — the instant `startDuel()` commits to actually running (after `buildJob`'s
  own validation passes, before the Worker spins up), never on a keystroke; a same-name/forbidden-name
  rejection rolls back whichever half of the pair already got added. A finished duel's rows are
  folded into the ledger via `recordCompetition` alone — no second, hand-rolled `applySeries` call
  in `competition.js`. The results view's old "Elo shown ... isn't saved" line is gone; it now
  reads **"Elo updated for the `<Difficulty>` bracket — see the Standings screen."** (green, not the
  amber caveat hue), with the actual before/after ledger ratings shown alongside, not a from-scratch
  session estimate (Phase 1's `eloFromRows` stays exported/tested for whatever still wants that, but
  the results view itself no longer calls it).
- **Roster screen** (`competition.js`'s `renderRosterScreen`): table of `name/strategy/archetype/
  faction` (`shapeRosterRow`, resolving each key to its real display name — never re-deriving one);
  a direct "Add a roster entry" form (the same three fields, not only reachable mid-duel); Remove,
  gated behind a confirm modal (`.comp-confirm`) that reads differently depending on
  `hasRatingHistory` (removing an entry never deletes its `ratingsByDifficulty`/history rows —
  `competitionLedger.js`'s own `removeRosterEntry` contract — the modal says so); Export Ladder
  (a small local Blob-plus-synthetic-anchor download mirroring `saveload.js`'s own `downloadJSON`
  idiom, deliberately *not* importing it — `saveload.js` doesn't export that helper, and
  `competitionLedger.js`'s own header already keeps this dependency surface small on purpose) and
  Import Ladder (a file input through `importLedgerJSON`'s full sanitize-then-coerce pipeline,
  surfacing a clear `.comp-error` on anything corrupt or rejected, never failing silently).
- **Standings screen** (`renderStandingsScreen`): a difficulty/bracket picker (defaulting to the
  Quick Duel screen's own pinned difficulty, so it opens on the bracket you were just playing) over
  a table built from `standingsFor(ledger, difficulty)` alone, formatted (never recomputed) by
  `shapeStandingsTable` — rating rounded, W-L-D folded into one string, a `PROVISIONAL` badge below
  `elo.js`'s `PROVISIONAL_GAMES`. Brackets are never blended (D2): switching the picker is the only
  way to see a different one.
- **Quick Duel / Roster / Standings read as one coherent mode**: a small tab row
  (`COMP_TABS`/`.comp-tabs`) sits below the existing "← Back to Menu" link, all three screens
  sharing the one lazily-loaded ledger (`ensureLedger()`) and `refreshCompView()` dispatcher.

**Deviations from the sketch above:** `engine/types.js` needed no change — `createAiController`'s
*returned* shape (its `archetype` field) was already declared from stage one; every change this
stage made was to functions' own *input options* one layer further up the existing call chain,
never a new field on a constructed object. `saveload.js` was read for its idiom but not imported
from (see above). `competitionWorker.js`'s job shape and `tools/duelCore.js`'s `runDuelMatch` config
gained `archetype`/`aArchetype`/`bArchetype` fields beyond this section's original file list, the
same "found while wiring, not predicted in advance" pattern Phase 1's own status note records for
`tools/duelCore.js` itself.

**Files touched:** `engine/state.js`, `tools/selfplay.js`, `tools/duelCore.js`, `competitionWorker.js`,
`competition.js`, `style.css`. **Tests:** `test/competition.test.js` (extended — archetype threading
into a built job, `resolveEntrantPick`'s roster-vs-adhoc resolution, `ratingLookup`/
`hasRatingHistory`/`shapeRosterRow`/`shapeStandingsTable`, `ARCHETYPE_OPTIONS`/
`ROSTER_FACTION_OPTIONS` derivation); `test/competitionWorker.test.js` (new — the job-to-worker
archetype plumbing specifically); `test/aiArchetypes.test.js`, `test/ai-selfplay.test.js`,
`test/duelCore.test.js` (extended, one layer each, up the `createAiController` → `createGameState` →
`createSelfPlayState` → `runDuelMatch` chain); `test/static-integrity.test.js` (`competitionLedger.js`'s
temporary orphan-module exemption removed — `competition.js` reaches it for real now, the same
removal `elo.js`'s own entry got in Phase 1). `npm test`: 2193/2193 green (2161 baseline + 32 new,
zero regressions — `competitionLedger.js`'s own Phase-2-stage-one tests included, unmodified).
`npm run typecheck`: clean. Live-browser-verified (Playwright): two fresh roster entrants created
and duelled end-to-end, ratings moved off 1200 in the correct direction on both the results view and
a freshly-visited Standings screen, roster **and** standings survived a real page reload, ladder
export/import round-tripped (including proving an import genuinely replaces state, not a no-op), and
an attempted `__proto__` roster entry was rejected with a visible on-screen error and zero
`Object.prototype` pollution — zero console errors, zero page errors, throughout.

### Phase 3 — Real tournaments in-game: round-robin, Swiss, knockout *(M)*

- **Extract the pairing logic** from `tools/ailab.js` into a shared pure module (`pairing.js`), used
  by both the CLI and the game. The Swiss matcher's backtracking, its bye rule, and its
  already-played-pair avoidance are exactly the sort of code that must not be reimplemented — its
  header records that the first, greedy version shipped with a real defect that fuzz-testing caught.
- **Formats**: round-robin, Swiss (rounds auto-sized), knockout bracket (new pairing tree).
- **Tournament UI**: format picker, field builder, round-by-round progress, live standings, and a
  bracket view for knockout.
- **Budget estimate before you start**: show "≈ 32 matches, ≈ 1 min" from the measured per-match cost,
  because a user who picks 16 entrants × 4 worlds × 3 seeds deserves to be told it's a long run before
  it starts, not after.

**Files:** `pairing.js` (new, extracted), `tools/ailab.js` (now imports it), `competition.js`,
`competitionWorker.js`.
**Tests:** move/extend the existing Swiss pairing tests in `test/slow/ailab.test.js` onto the shared
module — including the brute-force fuzz check for avoidable repeats, which is the whole reason that
code is trustworthy; knockout bracket shape (byes for non-power-of-two fields).

**Status: done.** Landed across two stages on this branch. Stage one: `pairing.js` itself — the Swiss
matcher moved out of `tools/ailab.js` whole (comments included, since they are the record of three
real bugs), plus `roundRobinPairs`, `buildKnockoutBracket` and `knockoutMatchCount`, with
`tools/ailab.js` re-exporting the moved names so every CLI caller and test stayed unmodified. Stage
two (this one) wired all three formats into the game as a fourth **Tournament** tab:

- **`competitionWorker.js` gained a SECOND job kind**, `{ kind: "tournament", format, field,
  difficulty, worlds, seeds, seedBase, rounds? }` → `runTournamentJob(job, onProgress)`. The
  single-duel job (no `kind` field) still dispatches to `runCompetitionJob`, unchanged — Quick Duel's
  own message contract is untouched. The tournament's injected `runPair` is a thin wrapper *around
  `runCompetitionJob` itself*, so a tournament pairing **is** a Quick Duel — same side-swap, same
  replicate-parity `swapAsym`, same one pinned difficulty for both seats, same row shape the ledger
  already stores — aggregated into the `{aWins, bWins, draws, avgMargin}` shape `pairing.js`'s
  schedules read. Round-robin loops `roundRobinPairs`; Swiss hands the runner to `buildSwissBracket`
  (which owns its own round loop); knockout hands it to `buildKnockoutBracket`. Progress is posted at
  real granularity — a `{type:"progress"}` per **match** carrying round/pairing coordinates, and a
  `{type:"pairing"}` summary per **pairing** so the screen can fold a finished pairing into live
  standings immediately. The `{type:"done"}` message carries the format's own full result (standings
  for round-robin/Swiss, the whole bracket tree for knockout) plus `pairings`: every pairing's rows
  in true completion order. The rows travel exactly once — the bracket tree and the Swiss rounds log
  are posted with each pairing's rows stripped.
- **Three additions to `pairing.js`**, all schedule facts that would otherwise have been duplicated
  between the worker and the screen: `swissRoundCount(n)` (the `max(3, ceil(log2 n))` default —
  `tools/ailab.js`'s `runSwissTournament` now calls it instead of keeping its own copy of the
  formula), `tournamentRoundPlan(format, n, rounds?)` (pairings per round: the up-front estimate sums
  it, and the Worker turns a flat pairing counter into "round 2 of 4, pairing 3 of 8" with it —
  `test/pairing.test.js` checks every plan against a *real* bracket, round for round, rather than
  against a restatement of its own formula), and `tallyStandings(names, pairings, byeNames)` (the
  after-the-fact tally — the worker's round-robin standings and the screen's live standings are the
  same code, pinned by a test to agree with what `buildSwissBracket` accumulates internally).
- **`competition.js`'s Tournament tab** (`renderTournamentScreen`, alongside the existing Quick Duel /
  Roster / Standings tabs and the same `.comp-tabs` pattern), with three sub-views —
  `renderTournamentConfig` / `renderTournamentProgress` / `renderTournamentResults`:
  - a **format picker** (`TOURNAMENT_FORMAT_OPTIONS`, through `setup.js`'s own `optionGroup`), and a
    **field builder** — a checkbox list of the current roster (`renderFieldBuilder`), with Select
    all/Clear and a live count. Below 2 picked entrants Start Tournament is genuinely `disabled`; an
    under-2 *roster* is answered by a line pointing at the Roster tab plus a button that goes there.
    A tournament has **no ad-hoc-name path at all** (Phase 2's own principle, applied harder: a field
    of throwaway names would write throwaway rows into the ladder the tournament exists to move).
  - the **same world/seeds/seed pickers Quick Duel uses** — `renderWorldPicker`/`renderSeedsRow`/
    `renderSeedRow` now take the config object they edit, so both screens drive one implementation
    over their own state — plus **one shared difficulty** for the whole tournament (D2), never a
    per-entrant one: `buildTournamentJob`'s entrants carry `name`/`strategy`/`archetype` only.
  - an **up-front estimate** before Start is clickable: `tournamentEstimate` → "≈ 30 matches · ≈ 45 s",
    with the working shown ("15 pairings × 1 world × 1 seed × 2 sides"). Pairings come from
    `tournamentPairingCount` (round-robin `n(n−1)/2`; Swiss `roundCount × floor(n/2)`, the round
    count defaulted or overridden through a Swiss-only "Swiss rounds" box; knockout **always** n−1,
    read straight off `knockoutMatchCount`), matches are `pairings × worlds × seeds × 2`, and time is
    `SECONDS_PER_MATCH = 1.5` — a documented average of §1's own measured ~1.0 s (elimination) and
    ~1.8 s (full clock), not an invented constant. Rendered in seconds below a minute, minutes above.
  - a **progress view** reusing Quick Duel's bar, with `tournamentProgressLabel` showing the real
    round/pairing coordinates, live standings (round-robin/Swiss) or a running pairing log
    (knockout), and a Cancel that terminates the Worker.
  - **results**: for round-robin/Swiss a standings table (name, W-L-D, plus a **Byes** column and a
    bye line for Swiss); for knockout a real **bracket view** — one column per round, titled
    Round N / Quarterfinals / Semifinals / Final, each match showing both seats or a visible `BYE`,
    the winner bolded on a green ground with a ✓, ending in a marked champion. The pure shaping
    (`shapeBracketView`, `tournamentStandingsRows`, `shapeTournamentStandings`) is exported and
    unit-tested with no DOM, the same observer.js-style split Phases 1-2 established.
  - **the ledger fold**: `foldTournamentIntoLedger` calls `recordCompetition` **once per pairing**,
    in the worker's own completion order (round 1's pairings before round 2's, in-round order
    preserved) — D6's canonical ordering applied to a multi-pairing tournament, never one batched
    call. The results view then states which bracket moved and shows a **Ladder movement** table
    (before → after, straight off the ledger) plus a View Standings button.
  - a knockout's field is seeded first by `seedFieldByRating` (rating descending off *that* bracket's
    table, name as the tie-break), because `buildKnockoutBracket` deliberately consumes a seeding and
    never invents one.

**Deviations from the sketch above.** `setup.js` is in the touched list beyond the four files named:
its competition-mode title said "🏆 Quick Duel", which stopped being true the moment the mode grew a
second run screen, so it now names the mode ("🏆 Competition") and the tab row says which screen
you're on. `style.css` likewise (new `comp-` classes for the field checklist, the estimate line and
the bracket) — the same "found while wiring" pattern Phases 1-2 record. The Swiss pairing tests did
**not** move out of `test/slow/ailab.test.js`: stage one deliberately left them there as the safety net
proving the extraction changed nothing observable, and added direct `test/pairing.test.js` coverage
instead. Live standings show a Swiss field's **byes** as 0 until the run finishes (the bye is the
schedule's own bookkeeping and `buildSwissBracket` reports it with the final result, not through
`runPair`); the progress view says so.

**Files touched:** `pairing.js`, `competitionWorker.js`, `competition.js`, `style.css`, `setup.js`,
`tools/ailab.js`. **Tests:** `test/competition.test.js` (extended — estimate/match-count formulas for
all three formats, tournament-job construction, knockout seeding, progress labelling, and
standings/bracket shaping off *real* `pairing.js` results); `test/competitionWorker.test.js`
(extended — job validation, and one small end-to-end knockout proving the pairings come back with
their rows in completion order and the progress messages carry real coordinates);
`test/pairing.test.js` (extended — `swissRoundCount`, `tournamentRoundPlan` checked against real
brackets, `tallyStandings` against `buildSwissBracket`'s own standings);
`test/static-integrity.test.js` (`pairing.js`'s temporary orphan exemption removed — the screen and
the Worker reach it for real now). `npm test`: **2267/2267 green** (2223 baseline + 44 new, zero
regressions). `npm run typecheck`: clean. Live-browser-verified (Playwright, zero console messages
and zero page errors throughout): a 3-entrant round-robin (estimate shown up front, all 3 pairings
run, standings 4-0-0/2-2-0/0-4-0, Standings tab and ladder moved to 1271/1200/1128); a 5-entrant
Swiss (round-by-round progress visible, no repeat pairings, byes rotated across Echo/Delta/Charlie
and counted as byes rather than wins); a 5-entrant knockout (3 first-round byes rendered as BYE
slots, 4 = n−1 matches, winners bolded with a ✓, one champion); a 6-entrant round-robin cancelled
mid-run at pairing 6 of 15 (progress stopped dead, the screen returned to config, and the ladder was
untouched by the cancelled run, before and after a reload); and a ledger check showing exactly one
history entry per pairing, in completion order.

### Phase 4 — The human enters the field *(L — the flagship)*

- **Human as an entrant**: a roster row flagged `human: true`, seated as owner `"player"` (D4), with
  its own bracketed rating.
- **Mixed schedule**: the human's match per round is played live; the rest batch-simulate. Play /
  Forfeit / Simulate-the-rest, resume mid-tournament from the ledger.
- **Result capture**: hook `state.over` in `boot.js`'s existing game-over path — the result posts to
  the competition rather than only rendering "Choose another battlefield". The game-over screen shows
  the rating change and the next fixture.
- **Bias disclosure (D4)**: one line where the human's rating shows, and a `seatSwapped: false` flag
  on every human row.
- **Anti-frustration**: a competition is resumable, a match is abandonable (recorded as a forfeit,
  never silently dropped), and the tournament state survives a browser refresh via the ledger.

**Files:** `boot.js`, `competition.js`, `overlays.js` (game-over integration), `hud.js` (a fixture
chip), `competitionLedger.js`.
**Tests:** result-capture from a terminal state; forfeit/abandon paths; resume-from-ledger; a human
row never claims `seatSwapped: true`.
**Risk, named:** this is where scope creep lives. Ship *one* human-inclusive format first — **Gauntlet**
(you vs the field) is the smallest complete one and the most natural "how good am I" answer. Swiss and
knockout with a human in the field follow only once Gauntlet is played and liked.

**Status: done.** Landed across two stages on this branch, Gauntlet only (the named risk above,
respected: no human-inclusive Swiss or knockout).

Stage one: `competitionLedger.js`'s own half — `human` on a `RosterEntry` (at most one, enforced at
both the interactive seam and the import boundary) plus `humanEntry`, and the whole persisted
`gauntlet` field: `startGauntlet` / `currentGauntletFixture` / `recordGauntletMatch` /
`recordGauntletForfeit` / `gauntletProgress` / `abandonGauntlet`, `GAUNTLET_DEFAULT_MATCH_SECONDS`,
and `cleanGauntlet`'s sanitizer. `COMPETITION_VERSION` was deliberately **not** bumped — both fields
are purely additive and their absence already means the right thing in every ledger written before
them; that call is argued in full next to the constant itself. Stage two (this one) built the
playable half:

- **`boot.js`'s `startCompetitionMatch(fixture)`** — a near-copy of `startGame`, deliberately: same
  `resolveSeed` / `difficultyDials` / `createGameState` / `bootState` chain, same loop, same HUD.
  A gauntlet match **is** an ordinary skirmish that knows which fixture it belongs to. Everything
  comes from the fixture (world, the schedule's own seed — never a fresh random one, D6 — pinned
  difficulty, the opponent's strategy/archetype, match length, this fixture's `swapAsym` parity);
  the human plays owner `"player"` with their own faction (D4). `sizeMult`/`resourceMult`/`popCap`
  are **pinned** to the engine defaults `createSelfPlayState` leaves them at, so the matches that
  move a human's rating are the same shape of match every AI rating in that bracket was earned on;
  the opponent's faction still comes from the world's archetype, since a self-play duel has no
  faction dial at all. The fixture rides on `game.competition` (session.js), cleared by `bootState`
  exactly like `game.galaxy`.
- **Result capture at the game-over hook.** `boot.js`'s existing `if (game.state.over && !announced)`
  branch gained exactly one term: `competition: game.competition ? captureCompetitionResult(...) : null`,
  passed through `showGameOver`'s opts. Every ordinary skirmish passes `null` and its game-over
  screen is byte-identical to before. `competition.js`'s `captureCompetitionResult(state)` owns the
  write (it holds the live ledger): it consumes `game.competition` first — so one finished match can
  only ever be rated once — maps the terminal state through the pure `humanMatchOutcome`, refuses to
  record if the ledger has since moved off that fixture, then rates it through the *same*
  `recordGauntletMatch` a forfeit takes. `overlays.js` renders the block from plain data with its
  actions injected as callbacks (`renderCompetitionResult`), so it still imports neither the session
  nor `competition.js`. **No second overlay:** the player needs the victory/defeat verdict and what
  it cost them read together, and a separate screen would either hide the first or repeat it.
- **`competition.js`'s Gauntlet tab** (fifth tab, same `.comp-tabs` pattern), pure half first —
  `SEAT_DISCLOSURE`, `gauntletEstimate`, `buildGauntletStart`, `shapeGauntletFixtures`,
  `nextGauntletFixture`, `humanMatchOutcome`, `gauntletLadderTrail`, `shapeGauntletSummary` — all
  exported and unit-tested with no DOM, the observer.js-style split Phases 1-3 established. The
  screen: a config view (name yourself → a roster row flagged human, multi-select the AI field
  through the *same* `renderFieldBuilder` the Tournament tab uses, one pinned difficulty, match
  length **defaulting to Quick**, worlds, seed) that states the real cost before Start is clickable
  — "4 live matches — one per opponent — up to about 1 h 20 min of real play" — because one live
  match per opponent is what makes the format playable at all and the hours are the number that
  actually decides whether a player starts; an in-progress view (standing, the human's rating, the
  fixture table with each pairing won/lost/drawn/forfeited/next/pending, **Play Next Match**,
  **Forfeit this match**, **Abandon gauntlet**); and a completion view (final standing, per-opponent
  rating change replayed through `gauntletLadderTrail`, and a route to Standings).
- **The disclosure (D4)** is one plain paragraph (`.comp-disclosure`, a left rule, not a tooltip)
  wherever the human's rating or standing appears: the config screen, the in-progress standing
  directly under the rating card, the final standing, and the game-over screen after every match —
  carried by `shapeGauntletSummary`'s own return value so a standing cannot be rendered without it —
  **and the Standings screen**, which is where the completion view's "View Standings" button routes
  and the only table that ranks the human's rating *against* the AI ratings it is being compared
  with. That table also **marks the human's own row** (a `you` pill, a tinted row): `standingsFor`
  carries each roster entry's `human` flag into its standing and `shapeStandingsTable` passes it
  through, so the screen knows both which row is the person and whether to state the note at all
  (an all-AI bracket has no seat asymmetry to disclose).
- **Resumability** is structural rather than bolted on: the run lives in the ledger, and the screen
  reads it back on every entry, so a reload, a navigation into a live match, or a week away all
  resume identically. There is no module-level "is a gauntlet running" flag to get out of step.
- **Abandoning is always a rated forfeit, after a confirm.** The Gauntlet screen's Forfeit button
  says "records a LOSS … rated exactly like a match you played and lost"; leaving a live match by the
  topbar Home button re-words `saveload.js`'s own confirm to say the same and offers **Forfeit &
  Exit** instead of Save & Exit — `game.competition` isn't part of the save, so a resumed autosave
  would be a skirmish belonging to no run, which is worse than an honest forfeit.

**Deviations from the sketch above.** `hud.js` was **not** touched — no fixture chip: the fixture is
already named on the Gauntlet screen you leave from and on the game-over screen you arrive at, and
the topbar already carries the seed chip and the faction chip. `session.js`, `setup.js` (which now
exports `MATCH_LENGTH_OPTIONS`, reused rather than redefined), `saveload.js` (the Home confirm) and
`style.css` are in the touched list beyond the four files named — the same "found while wiring"
pattern Phases 1-3 record. One known, accepted gap: the periodic autosave still writes a live
gauntlet match as an ordinary skirmish, so "Continue — resume autosave" can resume it *outside* the
run; that costs nothing in the ledger (the fixture simply stays unplayed and can be replayed or
forfeited) and suppressing it would mean teaching the save layer about competitions.

**Files touched:** `boot.js`, `competition.js`, `overlays.js`, `saveload.js`, `session.js`,
`setup.js`, `style.css`. **Tests:** `test/competition.test.js` (extended — the seat disclosure's
content, the estimate's one-match-per-opponent arithmetic in real hours, `buildGauntletStart`
including a start that really does drive `startGauntlet`, fixture-list shaping and its
played/next/pending states, next-fixture resolution, `humanMatchOutcome`'s owner-id → gauntlet
vocabulary mapping against a real `createGameState` state, and the ladder trail / completion
summary). `npm test`: **2329/2329 green** (2311 baseline + 18 new, zero regressions).
`npm run typecheck`: clean. Live-browser-verified (Playwright, **zero console messages and zero page
errors across three full passes**): a 3-4 opponent gauntlet started and played through — a real
skirmish booted from the fixture (canvas, HUD, both Command Centers, the scheduled world/seed on the
seed chip), resolved by the ordinary score-at-clock rule for a loss and by elimination for a win,
with the result landing in the ledger and on the game-over screen (rating −20 / +22, the next
fixture, and a button that boots it); **a full page reload mid-gauntlet came back with both results,
both ratings and the next fixture intact**; forfeits recorded through both paths (the screen's own
button and the Home-button abandon) as rated losses with `winReason: "forfeit"`; every human history
row carrying `human: true, seatSwapped: false` with `swapAsym` alternating false/true/false across
the schedule; the human ranked in the same bracketed Standings table as the AI entrants; and an
ordinary skirmish game-over confirmed unchanged (no competition block, ledger untouched).

### Phase 5 — Spectate, replay, season *(M)*

- **Watch any AI-vs-AI pairing live.** Observer Mode already does 90% of this: `input.js` fully
  delegates mouse/wheel/keyboard to `observer.js` whenever `game.observerMode` is set (input.js:342,
  364, 381, 412, 433, 696, 799), and `observedState()` already falls back to `game.state`. The only
  thing standing in the way is `enterObserverMode()`'s `if (!game.galaxy …) return` gate
  (`observer.js:73`) — Observer Mode is Odyssey-only today. Generalising it to a skirmish is a small
  change that reuses the entire camera/delegation path, and it's what makes "watch the final" work.
- **Speed control** for spectated matches (2× / 4× / 8×) via the loop's `hz` — bounded by
  `MAX_SUBSTEPS`, so it degrades to slow-motion rather than spiralling.
- **Replay a finished AI match** from its seed + entrant configs, since a competition is deterministic
  (D6). Costs nothing extra — the seed is already in the ledger.
- **Season**: reset or decay ratings on a schedule, archive the old table, hand out an award line.

**Files:** `observer.js`, `boot.js`, `input.js` (spectator guard), `competition.js`, `style.css`.
**Tests:** observer entry works without a galaxy; a spectated match issues no player orders; a replay
of a recorded match reproduces its recorded winner and score margin exactly.

**Status: DONE — all four bullets.** The spectate half landed first (watch a pairing live, with
speed control); replay-from-the-ledger and Season landed on top of it, and the replay work turned up
a real determinism bug in the spectate half that is written up below rather than quietly fixed.

- **Observer Mode generalised, by relaxing exactly one guard.** `enterObserverMode`'s
  `if (!game.galaxy …) return` became `if (!game.galaxy && !game.spectateMatch) return`, and
  `game.spectateId` falls back to `game.state.planetId` when there is no galaxy. Everything else —
  the whole camera path, `input.js`'s seven delegation points, `observedState()`'s existing
  `game.state` fallback, `boot.js`'s render swap — was already general and is untouched. **Where
  Observer Mode is OFFERED is still exactly two places:** an Odyssey, and a match the human is not
  playing. An ordinary player-vs-AI skirmish is still refused, because revealing its fog would just
  be a cheat, and the Odyssey tests are the safety net that the galaxy path didn't move.
- **`observerStats` degrades honestly rather than crashing or lying.** `aiDevelopment` was *checked*,
  not assumed: it needs no `state.diplomacy` at all (it counts owner "ai"'s finished economic
  buildings plus its researched techs, both present on any skirmish state), so nothing there needed
  a crash guard. What it *is* is the Odyssey's development-curve metric for the one neighbour AI —
  meaningless for one seat of a two-entrant duel — so it now reports `null` without diplomacy and
  the panel omits it, alongside Stance. In its place `observerStats` gained `seats`: army,
  buildings, supply and resources **per owner**, off `state.owners`. The watched-match panel renders
  those two blocks under the entrants' own names instead of "AI army"/"Player forces", which would
  have named the human as a combatant in a match they aren't in. Every pre-existing owner-"ai" field
  keeps its exact meaning, so the Odyssey panel is byte-identical.
- **A watched match is EXHIBITION ONLY, and the UI says so in three places.** This was a real
  decision, argued at `competition.js`'s `EXHIBITION_NOTE`: every rated result in this system is a
  *pairing* — side-swapped, multi-seed, replicate-parity `swapAsym` — precisely because a single
  unswapped match is confounded by the seat edge `tools/selfplay.js` measures and by the map's own
  asymmetric halves. A watched match is one match, one direction, one map half, so rating it would
  mix a differently-earned number into the same bracket (D2) with nothing on the Standings screen
  able to tell them apart. So it moves no rating, writes no history row, and does not even add a
  drafted entrant to the roster — watching costs nothing, literally. Disclosed under the Watch
  button, on the spectate bar for the whole match, and again on the game-over screen (the same
  discipline Phase 1 held to when its Elo wasn't saved).
- **What you watch is what the Worker would have run.** `buildWatchConfig(job)` shapes one match out
  of the *same* `buildJob` the simulated path uses: the same `duelSeed`-derived seed (via
  `matchSeedFor`, never a fresh roll), the same replicate-parity `swapAsym`, one `pinnedDuelDials`
  set on **both** seats, each entrant's own strategy/archetype on its own seat, and
  runDuelMatch's own seating (A owns `"player"`, B owns `"ai"`). `boot.js`'s `startSpectatedMatch`
  feeds exactly that to `createSelfPlayState`, and the loop's update calls `tickSelfPlay` instead of
  `tick` — one `else if` on `game.spectateMatch`, no forked `bootState`.
- **Speed control scales sim time, never the timestep.** `engine/loop.js`'s `createLoop` gained a
  `speed` option (number *or* live getter) that multiplies the real delta feeding the accumulator:
  `update(dtFixed)` stays byte-for-byte what it was, and only *how many* identical steps a real
  second runs changes — the fixed step is what makes replay determinism true, so it must not move.
  It also lands the overload where the existing design already handles it: past `MAX_SUBSTEPS` the
  loop degrades to slow motion instead of spiralling. 8x is the top rung for that reason (at 60 Hz
  it needs ~1.3 of the 5 substeps a frame allows — it was ~2.7 before the sim-rate fix below;
  16x would sit near the cap on a 30 fps machine and under-deliver).
- **The human genuinely cannot play.** `input.js` already refused every mouse/wheel/key path while
  observing; three remaining side doors were closed. The topbar idle-worker/idle-production chips
  and the selection panel's own "Idle Worker"/"Select Army" buttons call `input`/engine commands
  *directly*, bypassing that guard — they're hidden/replaced while spectating. And
  `requestExitObserverMode` (the player-facing O/Esc/button exit, as distinct from the unconditional
  teardown `boot.js` runs) refuses for a watched match: leaving Observer Mode there would hand the
  human one of the two entrants' armies mid-match. The spectate bar's **Leave** is the way out.
- **Leaving is clean, and nothing is left dangling.** `restartToMapSelect` clears
  `spectateMatch`/`spectateSpeed` next to its existing `competition` clear and repaints the observer
  UI once (the render loop that normally hides those elements has just been stopped).
  `saveShape.js`'s `resumableMode` refuses to checkpoint a watched match at all — the "player" seat
  is AI-driven by a *session* flag no save carries, so a resumed autosave would come back as a
  skirmish with an unmanned seat — and Save/Load are hidden to match. The always-visible **⌂ Home**
  confirm is the third door to the same place, so it branches on `spectateMatch` exactly the way
  Phase 4's taught it to branch on a live fixture: **Leave** (the launcher's own `onLeave`, the same
  route the spectate bar takes), no *Save & Exit*, and copy that doesn't promise a checkpoint nothing
  will write. Without that branch it fell back to the ordinary skirmish copy and *Save & Exit*
  downloaded the exhibition match as a plain skirmish save — one that loads back handing the human
  full command of an entrant's army — without even leaving.

#### Replay — and the determinism bug it found

- **A replay is not a recording.** A stored history row already carries its world, its exact seed,
  its `swapAsym` half, its pinned difficulty and both entrants' strategies; the roster carries each
  entrant's archetype. That is the complete input to `createSelfPlayState`, so
  `competition.js`'s **`buildReplayConfig(row, ledger)`** rebuilds the match and `startSpectatedMatch`
  runs it — the same spectator, the same speed control, the same Observer Mode. Nothing is captured,
  nothing is stored, and replaying a year-old row costs exactly what the match cost.
- **THE SEATING, not the labelling, is what gets rebuilt.** Every row is reported A-relative, but
  each was played in one of two directions (`competitionWorker.js` runs both). `"bAsAi"` is
  `runDuelMatch`'s own mapping (A owns `"player"`); `"aAsAi"` is the reverse, relabelled back by the
  worker's `flipRow`. `buildReplayConfig` un-does that relabelling and restates the recorded outcome
  **seat-relative** (`cfg.recorded`), which is what lets `spectatedMatchOutcome` — unchanged, and
  shared with the watched path — be compared against it directly.
- **DETERMINISM HELD, but only after a real bug was fixed, and the bug was in the spectate half this
  document already called done.** `tools/selfplay.js`'s fixed step is `0.1` and was commented "same
  as the game loop (engine/loop.js)". **It is not**: `createLoop`'s default is 20 Hz, i.e. `0.05`. A
  fixed step is not a tuning knob — the same seed advanced in different-sized steps runs a different
  number of ticks, hits its think cycles at different moments and accumulates floats in a different
  order. Measured on ferros/medium from one seed: `dt 0.1` ended `"ai"` by elimination at 1138 s,
  `dt 0.05` ended `"player"` by elimination at 1686 s — **opposite winners**. So a watched match was
  never actually the match the Worker would have simulated, only the same *configuration* of one, and
  a replay would have reproduced nothing. The fix is surgical: `SELFPLAY_DT`/`SELFPLAY_HZ` are now
  exported, `bootState` takes a **`selfPlay`** option, and `startSpectatedMatch` passes it so a
  watched-or-replayed match's loop runs at the self-play step. Ordinary play is untouched at 20 Hz,
  and `test/boot.test.js` drives the real loop by hand to prove both halves of that.
- **A second, smaller mismatch, found the same way.** `spectatedMatchOutcome` computed its margin as
  `round(aScore) - round(bScore)`, while every recorded row computes `round(aScore - bScore)`
  (`runDuelMatch`). Double-rounding put the two up to 0.1 apart, so the identical match reported a
  different margin depending on whether it was simulated or watched — invisible until a replay
  compares the two numbers, and then it reads as a determinism failure that isn't one. Now rounded
  once, off the raw scores, exactly like the row.
- **With both fixed, replay reproduces exactly** — winner, margin, both scores and `winReason`, in
  both recorded directions, headlessly *and* in a real browser. See the verification paragraph below.
- **Refusals are explicit, and each is a refusal rather than a best-effort replay.** `replayableMatch`
  turns down a **human** row (D6: a person is not a seeded input, so re-running the seed would
  simulate somebody else in their seat and call it the same match), a row naming an entrant **no
  longer on the roster** (archetype is an *input* dial `runDuelMatch` deliberately doesn't echo onto
  its row — `test/duelCore.test.js` pins that shape — so the roster is where it lives; roster entries
  are add/remove only, never edited in place, which is what makes that lookup exact), and a row with
  no real world or seed. An un-replayable match is still **listed** with the reason on hover, not
  hidden — it happened.
- **Where the button lives:** on every row of the Quick Duel results table (the results view the
  brief points at), and on a new **Recent matches** list on the Standings screen built from
  `shapeHistoryMatches(ledger)` — the ledger's own record, so a match recorded three sessions ago is
  still replayable after a reload or an import. A replay **writes nothing**: no rating, no history
  row, no `game.competition`. The reason is sharper than the watched match's — this result is
  *already* counted, and re-recording it would count one match twice.
- **The verdict is on screen.** The game-over screen states whether the re-run reproduced the
  recorded result (`replayVerdict`), and a divergence takes the **error** slot rather than a quiet
  line: it would mean the simulation is not the deterministic thing this whole system is built on,
  and the player should be the first to know, not the last.

#### Season

- **`archiveSeason(ledger, {label, at})`** files the live `ratingsByDifficulty` + `history` under a
  label with an injected finish time (never a clock read — this module stays pure), then resets both
  and **keeps the roster**. That asymmetry is the feature: an entrant is an identity the player built,
  a rating is a claim about one stretch of play. Wiping the identities too would make "new season"
  indistinguishable from "delete everything", and nobody would press it.
- **Refused, touching nothing, in two cases:** an empty ladder ("nothing to archive yet"), and a
  gauntlet **still in progress** — that run is one run at one pinned bracket, and splitting it across
  a season boundary would rate half of it into a table its own standing was never computed against. A
  **finished** gauntlet is the opposite case and is cleared with the season it was played in.
- **`seasonSummary({ratingsByDifficulty, history})`** is the plain summary the brief asks for — how
  many matches were played, by how many entrants, and who topped each bracket (in `DIFFICULTY_OPTIONS`
  order, never object-key order). It is shown in the archive confirm *before* the reset, and again on
  the archived season afterwards. **It is always derived and never stored-and-trusted:** `cleanSeason`
  re-computes it on every import, so a hand-edited ladder cannot put a champion on screen who never
  won a match. Same discipline as `cleanGauntlet`'s `nextIndex: results.length`.
- **`seasonStandings(ledger, index, difficulty)`** renders a closed season through
  `standingsFor` itself (whose `@param` widened to a small `StandingsSource` typedef) rather than a
  parallel formatter — but derives its row list from the **season's own ratings table**, not the
  current roster: a closed season's table is what it *finished* as, and removing someone today cannot
  retroactively un-play their matches.
- **Hardening follows this file's existing idioms rather than inventing weaker ones.** A season's
  ratings and history are cleaned by the *same* `cleanRatingsByDifficulty`/`cleanHistory` the live
  ledger uses; the structural gate already walks into `seasons`, so a `__proto__`/`constructor`/
  `prototype` key there throws like anywhere else (tested with the prove-nothing-was-polluted
  assertions this file uses everywhere); labels are trimmed/capped/defaulted rather than trusted; a
  season that cleans away to nothing is dropped whole, exactly as `cleanHistoryEntry` drops an empty
  husk. A season is **inert** — nothing ever writes through it — so per-field coercion is the right
  severity here, unlike `cleanGauntlet`'s drop-the-whole-run rule; that difference is argued at
  `cleanSeason`.
- **COMPETITION_VERSION was NOT bumped, deliberately** (CONTRIBUTING.md rule 3), and the reasoning is
  recorded next to Phase 4's own in `competitionLedger.js`. `seasons` is purely additive: its absence
  in an existing ledger means "this ladder has always been one season", which is exactly true, and
  `ratingsByDifficulty`/`history` still mean what they meant when there was only one season. No stored
  ledger deserializes into something *wrong*, which is the actual test for a bump — and the gate has
  no migration step, so bumping would make every ladder ever saved unloadable in exchange for no
  safety at all. (Replay adds no stored field whatsoever.)

**Deviations from the sketch above.** `input.js` needed no new spectator guard beyond swapping its
Esc handler onto `requestExitObserverMode` — the seven delegation points listed in this section were
already sufficient. Beyond the file list: `session.js`, `observerPanel.js`, `hud.js`,
`hudSelection.js`, `overlays.js`, `saveShape.js`, `dom.js`, `index.html`, `engine/loop.js`,
`competitionLedger.js` and `tools/selfplay.js` — the same "found while wiring" pattern Phases 1-4
record. No Watch button was added to a tournament pairing: a Swiss/knockout pairing's seed base is
folded per round *inside* `pairing.js` and isn't known until the schedule runs. Replay covers that
case instead, and better: a tournament's pairings all land in `history` as ordinary rows, so every
one of them is replayable from the Standings screen once it has been played. The **"decay ratings on
a schedule"** half of the Season bullet was dropped on purpose: decay is a policy that silently
rewrites numbers a player earned, and an explicit archive-and-restart says the same thing honestly
with a button. Two bugs found along the way (the sim-rate mismatch and the double-rounded margin) are
written up under Replay above rather than folded in silently — both were pre-existing, and the first
one means the Phase 5 spectate claim "what you watch is what the Worker would have run" was only true
of the *configuration* until this stage.

**Files touched.** *Spectate:* `observer.js`, `observerPanel.js`, `boot.js`, `competition.js`,
`engine/loop.js`, `session.js`, `saveShape.js`, `hud.js`, `hudSelection.js`, `overlays.js`,
`input.js`, `dom.js`, `index.html`, `style.css`. *Replay + Season, on top:* `competitionLedger.js`
(`seasonSummary`/`archiveSeason`/`seasonStandings`/`MAX_SEASON_LABEL`, `cleanSeason`/`cleanSeasons`,
the `StandingsSource` typedef, the version-bump note), `competition.js` (`REPLAY_NOTE`,
`replayableMatch`, `buildReplayConfig`, `replayVerdict`, `shapeHistoryMatches`, plus the Standings
screen's match-history and Seasons blocks, the results table's Replay column, `openStandingsScreen`/
`openDuelResultsScreen`, and the `spectatedMatchOutcome` margin fix), `tools/selfplay.js`
(`SELFPLAY_DT`/`SELFPLAY_HZ` exported, the wrong "same as the game loop" comment corrected),
`boot.js` (`bootState`'s `selfPlay` option → the loop's `hz`; `startSpectatedMatch` carries
`recorded`), `observerPanel.js` (the bar/banner say REPLAY and name the result being reproduced),
`observer.js` (the stale substep arithmetic), `style.css`.

**Tests:** `test/observer.test.js` (extended — entering without a galaxy,
the ordinary-skirmish refusal, the watched-match exit refusal vs. the Odyssey's ordinary toggle, the
speed ladder, and `observerStats`' two-seat/degraded-development shaping against a real
`createSelfPlayState` state); `test/loop.test.js` (extended — speed multiplies step COUNT not step
SIZE, live getters, slow-motion degradation past the cap, and an invalid speed falling back to 1x);
`test/competition.test.js` (extended — `buildWatchConfig`'s seating/dial-pinning/seed derivation
against the worker's own `duelSeed`, that its opts build a state both AIs really drive,
`EXHIBITION_NOTE`'s content, and `spectatedMatchOutcome` naming the winning entrant rather than
"you"); `test/save-shape.test.js` (extended — a spectated match is never checkpointed).

*Replay + Season tests, written red-first from the requirement:* `test/competition.test.js`
(`buildReplayConfig`'s world/seed/asym rebuild, its seating in **both** recorded directions, its
seat-relative restatement of the recorded outcome, its dial pinning; `replayableMatch`'s three
refusals; `REPLAY_NOTE`'s content; `replayVerdict`'s reproduced/diverged reporting;
`shapeHistoryMatches`' ordering, cap, addressing and un-replayable marking — and, at the bottom,
**the property itself**: a real two-direction duel run through `runCompetitionJob`, recorded through
`recordCompetition`, then replayed headlessly through the shipped `buildReplayConfig` →
`createSelfPlayState` → `spectatedMatchOutcome` path, asserting winner, margin, both scores and
`winReason` reproduce exactly. The two entrants differ in strategy *and* archetype on purpose, so a
seat mistake can't reproduce by symmetry); `test/competitionLedger.test.js` (`seasonSummary`'s
counts/champions/ordering; archive files-and-resets; **the roster survives while ratings restart**;
the archived copy is detached; label defaulting/truncation; both refusals, each proving the ledger
was untouched; a finished gauntlet cleared with its season; `seasonStandings` including an entrant
since removed from the roster; a full archive → export → import round trip; and the hostile-payload
set — a forbidden key inside a season rejected with `Object.prototype` proved clean, a non-array
`seasons` coerced, a **fabricated summary re-derived** rather than believed, junk/husk/unknown-bracket
seasons dropped, labels and finish times coerced); `test/loop.test.js` (the loop at the self-play
step, `SELFPLAY_DT`/`SELFPLAY_HZ` agreeing, 8x inside `MAX_SUBSTEPS` at that step);
`test/boot.test.js` (**driving the real rAF loop by hand**: a spectated match advances in exactly
`SELFPLAY_DT` steps, and an ordinary skirmish still runs its own faster step — the regression guard
that this didn't slow normal play down).

`npm test`: **2395/2395 green** (2360 baseline + 35 new, zero regressions across Phases 0-5).
`npm run typecheck`: clean.

**Live-browser-verified** (Playwright, **zero console messages and zero page errors across four full
passes**). *Replay:* a real Blitz(aggressive/Rusher)-vs-Bulwark(economic/Economist) duel run from the
Quick Duel screen, both recorded rows replayed from the ledger — the `bAsAi` row ending on
"**Reproduced the recorded result exactly — Blitz by 1812.2**" against a recorded `margin=1812.2`,
and the `aAsAi` row (seated Bulwark-vs-Blitz, as it was actually played) on "**Reproduced the
recorded result exactly — Blitz by 1654.7**" against a recorded `margin=1654.7`; the spectate bar
reading `⟲ REPLAY · … · recorded: Blitz by 1812.2` and the banner `👁 REPLAYING Korrath` throughout;
both seats visibly building and fighting with fog revealed; 1x → 8x measured on the match clock
(3 s of sim per 3 s real at 1x, 24 s at 8x); Save/Load hidden; and **localStorage byte-identical
before and after the replay**. *Season:* archiving "Opening Season" from the Standings screen after a
confirm that previewed its own summary ("2 matches played by 2 entrants. Blitz tops the Medium
bracket at 1238"), leaving `ratingsByDifficulty: {}` and an empty history while the **roster survived
intact** (`Blitz/aggressive/rusher, Bulwark/economic/economist` still on the Roster screen); the
closed season still viewable with its full final table; a **full page reload** bringing back both the
season list and the live-but-empty ladder; a second season stacking with a defaulted "Season 2"
label; the archive **refused** on screen ("a gauntlet is still in progress — finish or abandon it
before starting a new season") with ratings, history and the run all provably untouched; a Gauntlet's
own human match listed in the history but marked "played live" with D6's reason on hover and no
Replay button offered; and an in-page `importLedgerJSON` round trip of the live ladder coming back
byte-equal while a hostile `__proto__`-inside-a-season payload was rejected with `Object.prototype`
still clean. *Regression:* an ordinary skirmish unchanged — Observer button hidden, `O` inert, Save/
Load present, and its clock advancing at the ordinary rate. Earlier spectate-only passes remain
valid: a watched duel booted from the Quick Duel screen with both seats
visibly playing (independent build orders, both armies growing, red and blue units engaging in
midfield with fog revealed); every speed rung measured against the match clock (1x → 3 s of sim per
3 s real, 2x → 7 s, 4x → 12 s, 8x → 24 s); a full match run to the 40-minute clock in 306 s of real
time at 8x, ending on "Bulwark wins the exhibition match" with both scores, the margin, the reason,
and the exhibition disclosure — and an empty Standings/Roster/localStorage afterwards; clicks,
right-clicks, Q/A, O and Esc all refused mid-match; Leave and the game-over button both returning to
the Quick Duel tab with the banner, bar, panel and Observe button all torn down; an ordinary
skirmish still refusing Observer Mode (button hidden, O does nothing) while keeping its own Save/
Load and idle chips; and an Odyssey entering Observer Mode with its original banner, stance line and
development score intact, exiting on O and on Esc exactly as before.

---

## 5. Traps specific to this codebase

Collected so the implementation doesn't rediscover them one at a time. The first four have already bitten
someone here.

- **`tools/selfplay.js:197` breaks any browser import.** Phase 0 exists solely for this. Don't
  discover it at the end of Phase 1.
- **The seat edge is real and one-directional.** The `"ai"` seat sees the `"player"` seat's mutations
  on ~13% of think cycles. Side-swap corrects it for AI-vs-AI; nothing corrects it for a human. Any
  claim that a human rating is directly comparable to an AI rating is wrong by exactly that amount.
- **Never blend difficulty brackets** (D2) — for win-rates *or* ratings.
- **Any new AI-phase code must resolve everything from `owner`.** A stray `state.ai`/`state.fogAI`/
  `"ai"` literal on a path that can run for owner `"player"` is exactly how the two documented
  self-play bugs happened, and it still passes `npm test` because the shipped game only ever exercises
  owner `"ai"`.
- **Engine purity is enforced by test.** No `Date.now`/`Math.random` under `engine/`. Ledger
  timestamps are UI-layer and get injected, never read inside a pure module.
- **Every `getElementById` target must exist in `index.html`** (`test/static-integrity.test.js`) —
  each new panel needs its element declared.
- **No build step.** Module Worker, plain ES modules, inlined nothing. `tools/serve.js` already serves
  the right MIME type.
- **Elo is order-dependent.** Without D6's canonical ordering, a re-run of the same competition
  produces a different table and the whole thing becomes untestable.
- **Both candidates in one duel share one live overrides table.** `assertNoOverrideCollision` exists
  because merged patches make both seats play a row belonging to neither — a mirror match that still
  reports a winner from seat/seed noise alone. Any in-game roster that grows custom dials inherits that
  hazard.
- **Neighbour worlds pick their strategy at random** (`neighbourAiProfile`, `engine/galaxy.js`), so
  changing the `STRATEGIES` table for competition purposes changes roughly a quarter of the Odyssey
  galaxy too.

---

## 6. Deferred, with reasons

- **Glicko-2 / rating deviation** — the principled version of D7's provisional flag. Worth doing once
  there's real data on how noisy these ratings actually are; premature before that.
- **Cross-device / online ladders** — the game has no backend and no runtime dependencies. JSON
  export/import (D8) covers sharing without breaking that.
- **Human seated as owner `"ai"`** — a renderer/HUD/input rewrite (D4), not a competition feature.
- **Rating-affecting handicaps** — invalidates the pool; use difficulty brackets instead.
- **Tuning `WEIGHTS`-style objective scoring into the competition** — `tools/ailab.js`'s `score()`
  measures an *Odyssey development curve* and its components need `state.diplomacy`, absent from every
  skirmish state. `duel` already refuses to use it for exactly this reason and reads
  `engine/victory.js`'s `playerScore` instead. Competitions must do the same.
- **N > 2 entrants in a single match (free-for-all).** `state.owners` is genuinely owner-generic and
  `checkWinCondition` already reads for N sides — but map generation seeds exactly two bases
  (`map.bases`), so this is a map-generation project, not a competition one.

---

## 7. Suggested sequence

**Phase 0 → 1** is the smallest thing worth shipping: a player can pit two AI configurations against
each other and see who wins, with a rating that means the same thing the tuning bench means.

**Phase 2** is what makes it stick — without a persistent roster and ladder, every competition is
disposable.

**Phase 3 and Phase 4 are independent** and can run in either order or in parallel; they touch
different files (`pairing.js`/worker vs `boot.js`/game-over). If only one gets built, **Phase 4 is the
one the request is actually about** — a Gauntlet against the field, with your own Elo, is the feature.
Phase 3 is the depth behind it.

**Phase 5 is polish**, but "watch the final" is the cheapest spectacle in this entire plan, because
Observer Mode is one `if` away from already supporting it.

---

## 8. Closing note — the plan has landed

**All six phases (0 through 5) are built and shipped.** The developer tool this document opened by
describing is now a game feature: the player builds a named roster, runs Quick Duels and
round-robin/Swiss/knockout tournaments in a Worker, enters the field themselves in a Gauntlet, watches
any pairing live at 1x-8x, replays any finished match from the ladder's own record, and closes a
season to start a fresh one — all on one bracketed, persistent, exportable Elo ladder.

Two things are worth recording now that it is done. First, **every decision D1-D8 survived
implementation** and each is cited at the code that honours it; none had to be walked back, though
Phase 5 dropped rating *decay* in favour of an explicit archive (argued in its own section) and every
phase records its deviations rather than quietly diverging. Second, **the fairness machinery is what
made the rest cheap**: side-swapping, replicate-parity `swapAsym`, one pinned dial set per match and
`duelSeed`'s sorted hash were all built before any of this, and because a recorded row therefore
carries its own complete inputs, replay turned out to be a re-run rather than a recording system.
The one real surprise was that determinism had to be *verified* rather than assumed — the sim-rate
mismatch Phase 5 found had been silently wrong since the spectate work, and only a test that
re-simulated a recorded row and compared it exposed it. The deferred list in §6 is still deferred,
and still for the reasons given there.
