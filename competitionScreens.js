/* ============================================================
   competitionScreens.js — the Competition mode's SCREENS: Quick Duel, Tournament, Roster,
   Standings, Gauntlet and the AI Editor, plus the file import/export and confirm dialogs they
   hang off. Everything in here touches `document`/`mapSelectEl`.

   SPLIT OUT OF competition.js, which is now only the pure half it always described itself as
   having: job construction, per-match seed derivation, worker-row -> display-table shaping,
   roster/standings/bracket shaping and Elo folding. That file carried both halves in one 3773-line
   module, and the seam was already drawn in it — a "DOM RENDERING" banner two thirds of the way
   down, with a note that the two halves split "the SAME way observer.js splits observerStats()
   from observerPanel.js's rendering consumer". This is that split, finally made structural: the
   banner is now a file boundary, and the pure half does not import `document` at all.

   WHY IT WAS WORTH DOING. Coverage is measured per file, so one module holding a 100%-covered
   model and a 2600-line view reported 44% and told you nothing about either. It also made the
   model's own guarantee — that it is testable under Node with no DOM and no Worker — a promise
   held up by a comment rather than by the module graph. Now competition.js cannot reach the DOM
   even by accident, and this file's own coverage is a number about the screens.

   NOTHING MOVED BUT THE LINE BETWEEN THEM. No rendering logic changed in the split; the pure
   functions this file calls are imported from ./competition.js instead of being declared above it.

   The cycle this file sits in is the one competition.js documented and is unchanged in shape:
   setup.js's renderMapSelect() delegates to renderCompetition() here, and this file imports
   setup.js's own STRATEGY_OPTIONS/optionGroup/MAP_CHOICES rather than redefining them — the same
   two-file cycle inside test/static-integrity.test.js's known UI cluster, with every use at CALL
   time and never at module scope, so neither side can read the other in its TDZ.

   Guarded the dom.js way: every entry point below either checks `mapSelectEl` itself or is only
   ever reached from one that did, so this whole file is inert (never throws) under Node with no
   DOM. See test/static-integrity.test.js's C10 check.
   ============================================================ */

"use strict";

import { mapSelectEl } from "./dom.js";
import { game } from "./session.js";
import { STRATEGY_OPTIONS, optionGroup, MAP_CHOICES, MATCH_LENGTH_OPTIONS, setup, renderMapSelect } from "./setup.js";
// The Gauntlet's live matches (Phase 4) are booted through boot.js like any other game, and its
// "back to the competition screen" path leaves one the same way the game-over screen does. boot.js
// imports this module in return (for captureCompetitionResult) — both files are already inside
// test/static-integrity.test.js's documented UI cluster, so this closes no new cycle; every use
// below is at CALL time, never at module scope, so neither side can read the other in its TDZ.
import { startCompetitionMatch, startSpectatedMatch, restartToMapSelect } from "./boot.js";
import { DIFFICULTY_OPTIONS } from "./engine/aiDifficulty.js";
import { archetypeFor } from "./engine/aiArchetypes.js";
import { planetName } from "./data.js";
import { swissRoundCount } from "./pairing.js";
import { INITIAL_RATING, PROVISIONAL_GAMES, applySeries } from "./elo.js";
import {
  createLedger, addRosterEntry, removeRosterEntry, recordCompetition, standingsFor,
  exportLedger, importLedgerJSON, loadLedgerFromStorage, saveLedgerToStorage,
  GAUNTLET_DEFAULT_MATCH_SECONDS, humanEntry, startGauntlet, currentGauntletFixture,
  recordGauntletMatch, recordGauntletForfeit, gauntletProgress, abandonGauntlet,
  seasonSummary, archiveSeason, seasonStandings, MAX_SEASON_LABEL,
} from "./competitionLedger.js";
// The genome whitelist (GENOME_SCHEMA) — the same validator addRosterEntry applies, run here
// too so a bad file is reported to the player rather than silently becoming an empty AI.
import { sanitizeGenome, GENOME_SCHEMA, MIX_ALPHABET, geneKeys, genomeFrom, inertGenes, toCandidate }
  from "./tools/genome.js";
// The pure half, which used to sit directly above every function in this file.
import {
  ARCHETYPE_OPTIONS, ROSTER_FACTION_OPTIONS, buildJob, resolveEntrantPick, ratingLookup,
  hasRatingHistory, shapeRosterRow, shapeStandingsTable, matchCount, shapeResultsTable, eloFromRows,
  TOURNAMENT_FORMAT_OPTIONS, SECONDS_PER_MATCH, tournamentEstimate, buildTournamentJob,
  seedFieldByRating, tournamentProgressLabel, tournamentStandingsRows, shapeTournamentStandings,
  shapeBracketView, SEAT_DISCLOSURE, gauntletEstimate, buildGauntletStart, nextGauntletFixture,
  humanMatchOutcome, shapeGauntletSummary, EXHIBITION_NOTE, buildWatchConfig, spectatedMatchOutcome,
  REPLAY_NOTE, buildReplayConfig, replayVerdict, shapeHistoryMatches, strategyLabel, playTimeText,
} from "./competition.js";

function mk(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

// Persisted across renders/mode-switches, same philosophy as setup.js's own `setup` object
// ("carried across choose another battlefield restarts").
//
// worlds starts EMPTY, not `[MAP_CHOICES[0]]` — this file and setup.js import each other (see the
// header above), and reading an imported binding at TOP LEVEL in either half of a cycle risks a
// TDZ ReferenceError depending purely on which side happens to evaluate first (main.js -> setup.js
// -> competition.js means setup.js is always mid-evaluation, its own `MAP_CHOICES` line not yet
// reached, the instant competition.js's top-level code would run — confirmed by
// test/static-integrity.test.js's cycle test, which spawns EVERY shipped module as its own entry
// point and so catches both directions). renderCompetition() below defaults it lazily, well after
// module evaluation has finished, exactly to avoid this.
const compConfig = {
  // mode: "new" (a draft that joins the roster the instant a duel using it runs) or "roster" (an
  // existing, persistent entry picked by name — see resolveEntrantPick above). Every field below
  // mode is the "new"-mode draft; rosterName is the "roster"-mode pick. Both sets of fields are
  // always present (never deleted on a mode switch) purely so flipping back and forth doesn't lose
  // whatever the player already typed.
  entrantA: { mode: "new", rosterName: "", name: "Entrant A", strategy: "default", archetype: null, faction: "neutral" },
  entrantB: { mode: "new", rosterName: "", name: "Entrant B", strategy: "default", archetype: null, faction: "neutral" },
  difficulty: "medium",
  worlds: [],
  seeds: 1,
  seedText: "",   // blank = random, same convention as setup.js's own Seed row
};

let compScreen = "duel";     // "duel" | "roster" | "standings" — the mode's own tab row
let compView = "config";     // "config" | "progress" | "results" — Quick Duel's own sub-view
let compError = null;        // a validation/run error, shown in the config view
let activeWorker = null;
let activeJob = null;        // the job the current/last worker run was built from
let progress = { completed: 0, total: 0 };
let lastDone = null;         // the last {type:"done", rows, aWins, bWins, draws} message
let lastEloDelta = null;     // { [entrantName]: {before, after} } captured when the last duel's rows were recorded
let lastRecordError = null;  // set only if recordCompetition itself somehow rejected a finished duel's rows
let wrapEl = null;           // the one div this module owns inside mapSelectEl

// The persisted roster + ladder (competitionLedger.js), loaded lazily on first real use — not at
// module-evaluation time, so importing this module for its pure exports alone (tests) never
// touches localStorage, and so a real browser load order that hasn't rendered the competition
// screen yet never pays for a read it doesn't need. competitionLedger.js sits outside this file's
// own import cycle with setup.js (see the header), so there's no TDZ reason for the laziness here —
// it's purely "don't do I/O nothing asked for yet".
let ledger = null;
function ensureLedger() {
  if (!ledger) ledger = loadLedgerFromStorage() || createLedger();
  return ledger;
}

/**
 * Drop the cached ledger and read it back from storage — the module's own state, re-derived.
 *
 * The cache exists so the screens don't re-parse storage on every render, and it is correct right
 * up until the stored copy changes out from under it: another tab importing a ladder, or a caller
 * that wants to see what an import actually persisted rather than what this module happens to be
 * holding. Exported for that second case; test/competitionImport.test.js reads the roster back
 * through it after an import, which is the same door the app itself would use.
 *
 * @returns {object} the reloaded ledger
 */
export function reloadLedgerFromStorage() {
  ledger = loadLedgerFromStorage() || createLedger();
  return ledger;
}

/**
 * Which difficulty bracket the Standings screen should open on, given the one it would otherwise
 * show. Returns `preferred` whenever that bracket already has rated results — a player who was
 * just looking at Hard keeps looking at Hard. Otherwise it falls to the bracket the player is most
 * likely to have meant: an in-progress or just-finished gauntlet's own bracket first (that is the
 * run they were playing), then any bracket that actually has standings, in DIFFICULTY_OPTIONS
 * order so the choice is deterministic rather than dependent on object key insertion. With no
 * rated results anywhere, `preferred` comes back unchanged and the screen shows its ordinary
 * empty-state — there is genuinely nothing to show, and silently hopping brackets would be worse.
 * @param {string} preferred @param {object} [led] the ledger to read (defaults to the live one)
 * @returns {string}
 */
export function mostRelevantBracket(preferred, led = ensureLedger()) {
  const populated = d => standingsFor(led, d).length > 0;
  if (preferred && populated(preferred)) return preferred;
  const run = gauntletProgress(led);
  if (run && run.difficulty && populated(run.difficulty)) return run.difficulty;
  const found = DIFFICULTY_OPTIONS.map(o => o.mult).find(populated);
  return found || preferred;
}

let standingsDifficulty = null;   // lazily defaulted to compConfig.difficulty by renderCompetition() below
let compRosterError = null;       // a validation/import error, shown on the Roster screen
// Phase 5, both on the Standings screen: which ARCHIVED season is being viewed (null = the live
// ladder), the label typed into the archive form, and that screen's own error slot. `viewingSeason`
// is an INDEX into ledger.seasons rather than a copy, so an import/archive that happens while it's
// set can never leave a detached season on screen — every render re-reads the live ledger.
let viewingSeason = null;
let seasonLabelDraft = "";
let standingsError = null;
// The Roster screen's own "add a new entry directly" form state (task's own point 2 — not only
// reachable via a duel's New Entrant path). Rebuilt fresh after every successful add so the form
// doesn't carry a stale name into the next entry.
function freshRosterDraft() {
  return { name: "", strategy: "default", archetype: null, faction: "neutral" };
}
let rosterDraft = freshRosterDraft();

// --- Tournament screen state (Phase 3). Its own config object rather than sharing compConfig's:
// the two screens are configured independently (picking 4 worlds for a tournament shouldn't silently
// rewrite the Quick Duel screen you were just on), but they drive the SAME pickers — see
// renderWorldPicker/renderSeedsRow/renderSeedRow above, which take whichever config they're editing.
// `worlds`/`difficulty` start empty/null and are defaulted lazily by renderCompetition() for exactly
// the TDZ reason compConfig.worlds already documents. ------------------------------------------
const tourneyConfig = {
  format: "round-robin",
  field: [],          // roster NAMES, in tick order — a knockout re-seeds a COPY by rating, never this
  difficulty: null,
  worlds: [],
  seeds: 1,
  seedText: "",       // blank = random, same convention as the Quick Duel/skirmish Seed rows
  roundsText: "",     // Swiss only; blank = pairing.js's own swissRoundCount default
};
let tourneyView = "config";      // "config" | "progress" | "results"
let tourneyError = null;
let gauntletError = null;        // a validation/boot error, shown on the Gauntlet screen
let tourneyJob = null;           // the job the current/last tournament run was built from
let tourneyProgress = null;      // the last {type:"progress"} message (plus a pre-run {completed,total})
let tourneyPairings = [];        // {type:"pairing"} summaries in arrival order — the live standings' input
let tourneyDone = null;          // the last {type:"done"} tournament message
let tourneyLedgerNote = null;    // what the ledger fold did: { recorded, total, error, before, after }

// Same fallback boot.js's own resolveSeed(setup) uses — blank/invalid text means "pick something
// random", a real Math.random call, which is exactly why this lives in the DOM layer and not
// among the pure exports above.
function resolveSeedBase(text) {
  const v = (text || "").trim();
  const n = Number.parseInt(v, 10);
  return (v === "" || Number.isNaN(n)) ? (Math.floor(Math.random() * 0x100000000) >>> 0) : (n >>> 0);
}

function formatElo(entry) {
  if (!entry) return `${INITIAL_RATING}?`;
  return entry.games < PROVISIONAL_GAMES ? `${Math.round(entry.rating)}?` : String(Math.round(entry.rating));
}

function goBack() {
  if (activeWorker) { activeWorker.terminate(); activeWorker = null; }
  compView = "config";
  // Leaving the mode kills whatever was running, so a run that was mid-flight must not come back as
  // a frozen, un-cancellable progress view next time this screen opens. A FINISHED tournament's
  // results are still worth returning to, so only the progress view is reset.
  if (tourneyView === "progress") tourneyView = "config";
  compError = null;
  setup.mode = "skirmish";
  renderMapSelect();
}

const COMP_TABS = [
  { key: "duel", label: "🏆 Quick Duel" },
  { key: "tournament", label: "🏟 Tournament" },
  { key: "roster", label: "📋 Roster" },
  { key: "editor", label: "🧬 AI Editor" },
  { key: "standings", label: "📈 Standings" },
  { key: "gauntlet", label: "🎯 Gauntlet" },
];

function renderCompTabs(container) {
  const row = mk("div", "comp-tabs");
  COMP_TABS.forEach(t => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "comp-tab-btn" + (compScreen === t.key ? " active" : "");
    btn.textContent = t.label;
    btn.addEventListener("click", () => {
      if (compScreen === t.key) return;
      // Opening Standings from the TAB (rather than from a results screen's own "See Standings"
      // button, which sets the bracket it just played) used to land on whatever bracket was last
      // viewed — Medium by default. So finishing a Hard gauntlet and clicking the tab showed an
      // empty table reading "Nobody has played a rated match at this difficulty yet", with the
      // rated games sitting one bracket away and nothing saying so. Land on a bracket that
      // actually has results instead, preferring the one the player is most likely to mean.
      if (t.key === "standings") {
        standingsDifficulty = mostRelevantBracket(standingsDifficulty);
        viewingSeason = null;   // a fresh visit opens on the LIVE ladder, never on a season last browsed
      }
      compScreen = t.key;
      compError = null;
      compRosterError = null;
      tourneyError = null;
      gauntletError = null;
      standingsError = null;
      refreshCompView();
    });
    row.appendChild(btn);
  });
  container.appendChild(row);
}

function refreshCompView() {
  if (!wrapEl) return;
  wrapEl.innerHTML = "";
  const backBtn = mk("button", "btn comp-back-btn", "← Back to Menu");
  backBtn.type = "button";
  backBtn.addEventListener("click", goBack);
  wrapEl.appendChild(backBtn);

  renderCompTabs(wrapEl);

  if (compScreen === "roster") renderRosterScreen(wrapEl);
  else if (compScreen === "editor") renderAiEditorScreen(wrapEl);
  else if (compScreen === "standings") renderStandingsScreen(wrapEl);
  else if (compScreen === "tournament") renderTournamentScreen(wrapEl);
  else if (compScreen === "gauntlet") renderGauntletScreen(wrapEl);
  else if (compView === "progress") renderProgressView(wrapEl);
  else if (compView === "results") renderResultsView(wrapEl);
  else renderConfigView(wrapEl);
}

/* ---------- config view ---------- */

const ENTRANT_MODE_OPTIONS = [
  { label: "From Roster", mult: "roster", note: "pick an existing, persistent entrant" },
  { label: "New Entrant", mult: "new", note: "create one — joins the roster once this duel runs" },
];

// name(strategy · archetype · faction) — reuses shapeRosterRow's own display strings so the picker
// and the Roster screen's table never describe the same entry two different ways.
function rosterOptionLabel(entry) {
  const row = shapeRosterRow(entry);
  return `${row.name} — ${row.strategy} · ${row.archetype} · ${row.faction}`;
}

function renderEntrantCard(container, key, label) {
  const entrant = compConfig[key];
  const card = mk("div", "comp-entrant");
  card.appendChild(mk("h4", "comp-entrant-heading", label));

  card.appendChild(optionGroup(entrant.mode, ENTRANT_MODE_OPTIONS, val => { entrant.mode = val; refreshCompView(); }));

  if (entrant.mode === "roster") {
    // The human's own row is not offered: a Quick Duel is SIMULATED by the Worker, so picking it
    // would rate the human on a match they never played, driven by a scripted controller that
    // isn't them (same reasoning as the Tournament field builder and the Gauntlet — see
    // renderTournamentConfig's own note). Their commander competes in the Gauntlet, where a real
    // match is actually played.
    const roster = ensureLedger().roster.filter(entry => entry.human !== true);
    if (roster.length === 0) {
      card.appendChild(mk("p", "setup-hint", "No AI roster entries yet — switch to New Entrant to create one."));
    } else {
      const select = document.createElement("select");
      select.className = "comp-roster-select";
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "— pick an entrant —";
      placeholder.disabled = true;
      placeholder.selected = !entrant.rosterName;
      select.appendChild(placeholder);
      roster.forEach(r => {
        const opt = document.createElement("option");
        opt.value = r.name;
        opt.textContent = rosterOptionLabel(r);
        opt.selected = r.name === entrant.rosterName;
        select.appendChild(opt);
      });
      select.addEventListener("change", () => { entrant.rosterName = select.value; });
      card.appendChild(select);
    }
  } else {
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "comp-name-input";
    nameInput.placeholder = label;
    nameInput.maxLength = 40;
    nameInput.value = entrant.name;
    nameInput.addEventListener("input", () => { entrant.name = nameInput.value; });
    card.appendChild(nameInput);

    card.appendChild(mk("span", "setup-label comp-substrategy-label", "Strategy"));
    card.appendChild(optionGroup(entrant.strategy, STRATEGY_OPTIONS, val => { entrant.strategy = val; }));

    card.appendChild(mk("span", "setup-label comp-substrategy-label", "Archetype"));
    card.appendChild(optionGroup(entrant.archetype, ARCHETYPE_OPTIONS, val => { entrant.archetype = val; }));

    card.appendChild(mk("span", "setup-label comp-substrategy-label", "Faction"));
    card.appendChild(optionGroup(entrant.faction, ROSTER_FACTION_OPTIONS, val => { entrant.faction = val; }));
    card.appendChild(mk("p", "setup-hint",
      "Faction is stored on this roster entry for flavor — it doesn't change this duel (a self-play match has no faction dial)."));
  }

  container.appendChild(card);
}

// The world/seeds/seed pickers below all take the config object they edit, so the Tournament screen
// (Phase 3) drives the SAME three pickers Quick Duel does — same classes, same behaviour, same
// "every world × every seed runs both directions" rule — over its own state, rather than growing a
// second, drifting copy of each. `cfg` is compConfig or tourneyConfig; both carry
// worlds/seeds/seedText.
// `hint` overrides the default line for a format whose worlds mean something else: the Gauntlet
// (Phase 4) plays ONE match per opponent, drawn from this pool, and — being a human match — is
// never side-swapped (D4), so the default sentence would be false there in exactly the way this
// screen is meant to be careful about.
function renderWorldPicker(container, cfg, hint) {
  container.appendChild(mk("p", "setup-hint",
    hint || "Worlds — pick one or more. Every world × every seed below runs BOTH directions, side-swapped."));
  const wrap = mk("div", "opt-group comp-worlds");
  MAP_CHOICES.forEach(id => {
    const selected = cfg.worlds.includes(id);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "opt-btn" + (selected ? " active" : "");
    btn.appendChild(mk("span", "opt-label", planetName(id)));
    btn.appendChild(mk("span", "opt-note", archetypeFor(id).name));
    btn.addEventListener("click", () => {
      cfg.worlds = cfg.worlds.includes(id) ? cfg.worlds.filter(w => w !== id) : [...cfg.worlds, id];
      refreshCompView();
    });
    wrap.appendChild(btn);
  });
  container.appendChild(wrap);
}

function renderSeedsRow(container, cfg) {
  const seedsRow = mk("div", "setup-row");
  seedsRow.appendChild(mk("span", "setup-label", "Seeds / world"));
  const seedsInput = document.createElement("input");
  seedsInput.type = "number";
  seedsInput.min = "1";
  seedsInput.max = "10";
  seedsInput.className = "comp-seeds-input";
  seedsInput.value = String(cfg.seeds);
  seedsInput.addEventListener("change", () => {
    cfg.seeds = Math.max(1, Math.floor(Number(seedsInput.value)) || 1);
    refreshCompView();
  });
  seedsRow.appendChild(seedsInput);
  container.appendChild(seedsRow);
}

function renderSeedRow(container, cfg) {
  const seedRow = mk("div", "setup-row");
  seedRow.appendChild(mk("span", "setup-label", "Seed"));
  const seedInput = document.createElement("input");
  seedInput.type = "text";
  seedInput.inputMode = "numeric";
  seedInput.className = "seed-input";
  seedInput.placeholder = "random";
  seedInput.value = cfg.seedText;
  seedInput.addEventListener("input", () => { cfg.seedText = seedInput.value; });
  seedRow.appendChild(seedInput);
  container.appendChild(seedRow);
}

function renderConfigView(container) {
  container.appendChild(mk("p", "setup-hint comp-intro",
    "Pick two named entrants — from the roster, or fresh — and watch them fight, side-swapped " +
    "across every world × seed you choose. Runs entirely in the background — no player economy, " +
    "no canvas — then folds the result into the ladder for this difficulty's bracket."));

  const entrants = mk("div", "comp-entrants");
  renderEntrantCard(entrants, "entrantA", "Entrant A");
  renderEntrantCard(entrants, "entrantB", "Entrant B");
  container.appendChild(entrants);

  const diffRow = mk("div", "setup-row");
  diffRow.appendChild(mk("span", "setup-label", "Difficulty"));
  diffRow.appendChild(optionGroup(compConfig.difficulty, DIFFICULTY_OPTIONS, key => { compConfig.difficulty = key; }));
  container.appendChild(diffRow);
  container.appendChild(mk("p", "setup-hint",
    "One shared difficulty for the whole duel — pinned identical for both entrants, a duel's whole fairness point."));

  renderWorldPicker(container, compConfig);
  renderSeedsRow(container, compConfig);
  renderSeedRow(container, compConfig);

  const n = compConfig.worlds.length * compConfig.seeds * 2;
  container.appendChild(mk("p", "setup-hint",
    compConfig.worlds.length ? `This will run ${n} match${n === 1 ? "" : "es"}.` : "Pick at least one world."));

  if (compError) container.appendChild(mk("p", "comp-error", compError));

  const runBtn = mk("button", "btn", "▶ Run Duel");
  runBtn.type = "button";
  runBtn.addEventListener("click", startDuel);
  container.appendChild(runBtn);

  // WATCH ONE MATCH LIVE (Phase 5). Sits below Run Duel and is visibly the lesser of the two: Run
  // Duel is what moves the ladder, and the note under this button says outright that watching does
  // not — stated where the decision is taken, not only after the match (where it is stated again).
  const watchBtn = mk("button", "btn ghost comp-watch-btn", "👁 Watch One Match Live");
  watchBtn.type = "button";
  watchBtn.disabled = compConfig.worlds.length === 0;
  if (!watchBtn.disabled) watchBtn.addEventListener("click", watchDuel);
  container.appendChild(watchBtn);
  container.appendChild(mk("p", "comp-disclosure comp-watch-note",
    `Plays match 1 of this duel — ${planetName(compConfig.worlds[0] || MAP_CHOICES[0])}, the same seed and `
    + `dials the simulation would use — in the real game at 1x-8x speed, with fog revealed and no `
    + `orders of your own. ${EXHIBITION_NOTE}`));
}

/* ---------- progress view ---------- */

function renderProgressView(container) {
  const wrap = mk("div", "comp-progress");
  wrap.appendChild(mk("p", "setup-hint", `Running duel — ${progress.completed} of ${progress.total} matches`));

  const bar = mk("div", "comp-progress-bar");
  const fill = mk("div", "comp-progress-fill");
  const pct = progress.total ? Math.round((progress.completed / progress.total) * 100) : 0;
  fill.style.width = pct + "%";
  bar.appendChild(fill);
  wrap.appendChild(bar);

  const cancelBtn = mk("button", "btn", "Cancel");
  cancelBtn.type = "button";
  cancelBtn.addEventListener("click", () => {
    if (activeWorker) { activeWorker.terminate(); activeWorker = null; }
    compView = "config";
    refreshCompView();
  });
  wrap.appendChild(cancelBtn);

  container.appendChild(wrap);
}

/* ---------- results view ---------- */

// `delta` is { before, after } — both real ledger rating entries (ratingLookup), captured straight
// across recordCompetition's own mutation in startDuel's "done" handler below — so the number
// shown is the actual persisted change, not a from-scratch session estimate (Phase 1's own
// eloFromRows, still exported/tested above, but no longer what the results view itself renders).
function eloCard(name, delta) {
  const card = mk("div", "comp-elo-card");
  const change = Math.round(delta.after.rating) - Math.round(delta.before.rating);
  card.appendChild(mk("span", "comp-elo-name", name));
  card.appendChild(mk("span", "comp-elo-value", `${formatElo(delta.after)} (${change > 0 ? "+" : ""}${change})`));
  card.appendChild(mk("span", "comp-elo-games",
    `${delta.after.games} game${delta.after.games === 1 ? "" : "s"}${delta.after.games < PROVISIONAL_GAMES ? " — provisional" : ""}`));
  return card;
}

// `replayBack` (Phase 5): where a Replay launched from this table should return to. Passed rather
// than assumed so the same table can serve the Quick Duel results view (back to Quick Duel) and
// any future caller; omitted, the table renders exactly as it did before replay existed.
function buildResultsTable(rows, replayBack) {
  const shaped = shapeResultsTable(rows);
  const table = document.createElement("table");
  table.className = "comp-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  const heads = ["World", "Seed", "Side", "Swap", "Winner", "Reason", "Time (s)", "Margin"];
  if (replayBack) heads.push("");
  heads.forEach(h => headRow.appendChild(mk("th", null, h)));
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  shaped.forEach((r, i) => {
    const tr = document.createElement("tr");
    [planetName(r.world), r.seed, r.side, r.swap ? "yes" : "no", r.winner, r.reason, r.time, r.margin]
      .forEach(v => tr.appendChild(mk("td", null, String(v))));
    if (replayBack) {
      const actionsTd = document.createElement("td");
      const btn = mk("button", "btn comp-replay-btn", "▶ Replay");
      btn.type = "button";
      btn.title = `Re-run this match from seed ${r.seed} and watch it. Changes no rating — it is already counted.`;
      btn.addEventListener("click", () => startReplay(rows[i], replayBack));
      actionsTd.appendChild(btn);
      tr.appendChild(actionsTd);
    }
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  return table;
}

function renderResultsView(container) {
  const { rows, aWins, bWins, draws } = lastDone;
  const aName = activeJob.entrantA.name, bName = activeJob.entrantB.name;
  const diffLabel = (DIFFICULTY_OPTIONS.find(o => o.mult === activeJob.difficulty) || {}).label || activeJob.difficulty;

  container.appendChild(mk("h3", "cards-heading", `${aName} vs ${bName} — ${aWins}-${bWins}-${draws} (W-L-D)`));
  container.appendChild(mk("p", lastRecordError ? "comp-note" : "comp-note comp-note-good",
    lastRecordError
      ? `The duel finished, but the ladder couldn't be updated: ${lastRecordError}`
      : `Elo updated for the ${diffLabel} bracket — see the Standings screen.`));

  if (lastEloDelta) {
    const eloRow = mk("div", "comp-elo-row");
    eloRow.appendChild(eloCard(aName, lastEloDelta[aName]));
    eloRow.appendChild(eloCard(bName, lastEloDelta[bName]));
    container.appendChild(eloRow);
  }

  const tableWrap = mk("div", "comp-table-wrap");
  // Every row here is a FINISHED match that was just recorded, so each gets a Replay button —
  // this is the results view the Phase 5 brief points at, and returning here (not to the config
  // view) is what makes "replay another one" a single click. See REPLAY_NOTE for what it costs.
  tableWrap.appendChild(buildResultsTable(rows, openDuelResultsScreen));
  container.appendChild(tableWrap);
  container.appendChild(mk("p", "setup-hint", REPLAY_NOTE));

  const actions = mk("div", "comp-actions");
  const again = mk("button", "btn", "Run Another Duel");
  again.type = "button";
  again.addEventListener("click", () => { compView = "config"; refreshCompView(); });
  actions.appendChild(again);
  const seeStandings = mk("button", "btn", "View Standings");
  seeStandings.type = "button";
  seeStandings.addEventListener("click", () => { standingsDifficulty = activeJob.difficulty; compScreen = "standings"; refreshCompView(); });
  actions.appendChild(seeStandings);
  container.appendChild(actions);
}

/* ---------- run ---------- */

function startDuel() {
  compError = null;
  const activeLedger = ensureLedger();

  // Resolve BOTH pickers against the current roster before building the job at all — a "roster"
  // pick whose name has since vanished (removed on the Roster screen mid-edit) is caught here,
  // not after a Worker has already spun up.
  let resolvedA, resolvedB;
  try {
    resolvedA = resolveEntrantPick(compConfig.entrantA, activeLedger);
    resolvedB = resolveEntrantPick(compConfig.entrantB, activeLedger);
  } catch (err) {
    compError = err.message;
    refreshCompView();
    return;
  }

  let job;
  try {
    job = buildJob({
      entrantA: resolvedA,
      entrantB: resolvedB,
      difficulty: compConfig.difficulty,
      worlds: compConfig.worlds,
      seeds: compConfig.seeds,
      seedBase: resolveSeedBase(compConfig.seedText),
    });
  } catch (err) {
    compError = err.message;
    refreshCompView();
    return;
  }

  // THE KEY UX POINT: a brand-new entrant joins the roster HERE — the duel is genuinely about to
  // run, validated and about to start a Worker — never on a keystroke while its form was still a
  // draft. Best-effort atomic: if committing the SECOND entrant fails (its name collided with
  // something added since it was typed, or is one of the three forbidden identity strings —
  // addRosterEntry's own guard), roll back the first so a rejected click never leaves half a pair
  // behind on the roster.
  const committed = [];
  try {
    if (resolvedA.isNew) {
      addRosterEntry(activeLedger, { name: job.entrantA.name, strategy: job.entrantA.strategy, archetype: job.entrantA.archetype, faction: resolvedA.faction, createdAt: Date.now() });
      committed.push(job.entrantA.name);
    }
    if (resolvedB.isNew) {
      addRosterEntry(activeLedger, { name: job.entrantB.name, strategy: job.entrantB.strategy, archetype: job.entrantB.archetype, faction: resolvedB.faction, createdAt: Date.now() });
      committed.push(job.entrantB.name);
    }
  } catch (err) {
    for (const name of committed) removeRosterEntry(activeLedger, name);
    compError = err.message;
    refreshCompView();
    return;
  }
  saveLedgerToStorage(activeLedger);
  // Point each freshly-created entrant's own picker at its new roster row, so "Run Another Duel"
  // reuses it instead of trying (and failing, "already on the roster") to re-add the same name.
  if (resolvedA.isNew) { compConfig.entrantA.mode = "roster"; compConfig.entrantA.rosterName = job.entrantA.name; }
  if (resolvedB.isNew) { compConfig.entrantB.mode = "roster"; compConfig.entrantB.rosterName = job.entrantB.name; }

  activeJob = job;
  progress = { completed: 0, total: matchCount(job) };
  compView = "progress";
  // One worker slot for the whole mode: this duel takes it. A tournament that was running is about
  // to be terminated below, so its progress view must not be left behind to come back frozen.
  if (tourneyView === "progress") tourneyView = "config";
  refreshCompView();

  if (activeWorker) activeWorker.terminate();   // guard against a stray prior worker, belt-and-suspenders
  activeWorker = new Worker(new URL("./competitionWorker.js", import.meta.url), { type: "module" });
  activeWorker.onmessage = e => {
    const msg = e.data;
    // Every branch below updates state unconditionally (the ledger write must happen regardless
    // of which tab is on screen when the worker finishes) but only calls refreshCompView() when
    // the Quick Duel tab is actually the one showing — otherwise a stray progress/done/error tick
    // would wipe wrapEl.innerHTML out from under whatever the Roster/Standings screen is doing
    // right now (an open confirm-delete dialog, most notably) via refreshCompView's own reset.
    const onDuelTab = () => compScreen === "duel";
    if (msg.type === "progress") {
      progress = { completed: msg.completed, total: msg.total };
      if (onDuelTab() && compView === "progress") refreshCompView();
    } else if (msg.type === "done") {
      lastDone = msg;
      activeWorker = null;

      // Fold this duel's rows into the ledger for the pinned difficulty bracket. The ledger owns
      // this write (competitionLedger.js's own recordCompetition, applying elo.js's applySeries
      // internally) — never a second, hand-rolled applySeries call here. Ratings are snapshotted
      // BEFORE and read back AFTER so the results view can show the real persisted delta.
      const bracketBefore = activeLedger.ratingsByDifficulty[job.difficulty];
      const beforeA = ratingLookup(bracketBefore, job.entrantA.name);
      const beforeB = ratingLookup(bracketBefore, job.entrantB.name);
      try {
        recordCompetition(activeLedger, {
          at: Date.now(), difficulty: job.difficulty,
          aName: job.entrantA.name, bName: job.entrantB.name, rows: msg.rows,
        });
        saveLedgerToStorage(activeLedger);
        lastRecordError = null;
      } catch (err) {
        // Not expected in practice — buildJob/addRosterEntry above already guarantee both names are
        // real, distinct, and non-forbidden — but a rejected write must surface, not vanish.
        lastRecordError = err.message;
      }
      const bracketAfter = activeLedger.ratingsByDifficulty[job.difficulty];
      lastEloDelta = {
        [job.entrantA.name]: { before: beforeA, after: ratingLookup(bracketAfter, job.entrantA.name) },
        [job.entrantB.name]: { before: beforeB, after: ratingLookup(bracketAfter, job.entrantB.name) },
      };

      compView = "results";
      if (onDuelTab()) refreshCompView();
    } else if (msg.type === "error") {
      activeWorker = null;
      compError = `The duel failed to run: ${msg.message}`;
      compView = "config";
      if (onDuelTab()) refreshCompView();
    }
  };
  activeWorker.postMessage(job);
}

/* ============================================================
   TOURNAMENT SCREEN (docs/competitions-and-elo.md Phase 3) — format picker, field builder over the
   roster, the shared world/seed/difficulty pickers, an up-front cost estimate, live round-by-round
   progress, and a standings table (round-robin/Swiss) or a real bracket (knockout). Every pairing
   folds into the ledger when the tournament finishes, one recordCompetition call each, in the
   worker's own completion order (D6) — see foldTournamentIntoLedger below.

   ENTRANTS ARE ROSTER ROWS, always. Phase 2 established that for Quick Duel ("every entrant is a
   named, persistent roster row"); a tournament has no ad-hoc-name path AT ALL, because a field of
   throwaway names would write throwaway rows into the very ladder the tournament exists to move.
   Too small a roster is answered by pointing at the Roster tab, not by letting names be typed here.
   ============================================================ */

const formatLabelFor = key => (TOURNAMENT_FORMAT_OPTIONS.find(o => o.mult === key) || {}).label || key;
const difficultyLabelFor = key => (DIFFICULTY_OPTIONS.find(o => o.mult === key) || {}).label || key;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// The Swiss round override as a NUMBER, or undefined for "use pairing.js's own default" — blank and
// junk both mean the default, the same lenient reading resolveSeedBase gives the Seed box.
function swissRoundsOverride() {
  const n = Number.parseInt((tourneyConfig.roundsText || "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function tourneyDifficulty() {
  return tourneyConfig.difficulty || compConfig.difficulty;
}

function renderTournamentScreen(container) {
  if (tourneyView === "progress") renderTournamentProgress(container);
  else if (tourneyView === "results" && tourneyDone) renderTournamentResults(container);
  else renderTournamentConfig(container);
}

/* ---------- tournament: config ---------- */

// The multi-select field builder, over whichever config object owns a `field` array of roster
// NAMES. Shared by the Tournament screen and (Phase 4) the Gauntlet screen rather than copied:
// they differ only in how big a field they need and whether one roster row is excluded (the human
// never plays themself), which is exactly what the two options are for.
// `cfg` is tourneyConfig or gauntletConfig; `exclude` is a predicate on a roster ENTRY.
function renderFieldBuilder(container, cfg, { exclude = null, minimum = 2, tooFewHint = "" } = {}) {
  const roster = ensureLedger().roster.filter(entry => !(exclude && exclude(entry)));
  // The label goes in its own .setup-row, like every other labelled row on this screen (Format,
  // Difficulty, Swiss rounds, Seeds/world). .setup-label is styled for life INSIDE a .setup-row —
  // appended straight into .comp-screen it picked up the wrong layout and sat misaligned against
  // its siblings. The field list and its actions stay OUTSIDE the row: they're a full-width block,
  // not a label-plus-control pair like the others.
  const labelRow = mk("div", "setup-row");
  labelRow.appendChild(mk("span", "setup-label", "Field"));
  container.appendChild(labelRow);

  if (roster.length < minimum) {
    container.appendChild(mk("p", "setup-hint", tooFewHint));
    const go = mk("button", "btn comp-back-btn", "→ Go to the Roster tab");
    go.type = "button";
    go.addEventListener("click", () => { compScreen = "roster"; tourneyError = null; gauntletError = null; refreshCompView(); });
    container.appendChild(go);
    return;
  }

  // Drop any pick whose roster entry has since been removed, so the field can never name a
  // now-missing entrant (resolveEntrantPick guards the Quick Duel side of the same hazard).
  const known = new Set(roster.map(r => r.name));
  cfg.field = cfg.field.filter(name => known.has(name));

  const list = mk("div", "comp-field-list");
  roster.forEach(entry => {
    const shaped = shapeRosterRow(entry);
    const row = mk("label", "comp-field-row" + (cfg.field.includes(entry.name) ? " picked" : ""));
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "comp-field-check";
    box.checked = cfg.field.includes(entry.name);
    box.addEventListener("change", () => {
      cfg.field = box.checked
        ? [...cfg.field, entry.name]
        : cfg.field.filter(name => name !== entry.name);
      refreshCompView();
    });
    row.appendChild(box);
    row.appendChild(mk("span", "comp-field-name", shaped.name));
    row.appendChild(mk("span", "comp-field-meta", `${shaped.strategy} · ${shaped.archetype} · ${shaped.faction}`));
    list.appendChild(row);
  });
  container.appendChild(list);

  const actions = mk("div", "comp-field-actions");
  const all = mk("button", "btn comp-remove-btn", "Select all");
  all.type = "button";
  all.addEventListener("click", () => { cfg.field = roster.map(r => r.name); refreshCompView(); });
  const none = mk("button", "btn comp-remove-btn", "Clear");
  none.type = "button";
  none.addEventListener("click", () => { cfg.field = []; refreshCompView(); });
  actions.append(all, none);
  actions.appendChild(mk("span", "comp-field-count", `${cfg.field.length} of ${roster.length} selected`));
  container.appendChild(actions);
}

function renderTournamentConfig(container) {
  container.appendChild(mk("p", "setup-hint comp-intro",
    "Run a real tournament over your roster — round-robin, Swiss, or a knockout bracket. Every " +
    "pairing is a full side-swapped duel, run in the background, and every one of them folds into " +
    "the ladder for this difficulty's bracket as the tournament finishes."));

  const formatRow = mk("div", "setup-row");
  formatRow.appendChild(mk("span", "setup-label", "Format"));
  formatRow.appendChild(optionGroup(tourneyConfig.format, TOURNAMENT_FORMAT_OPTIONS, val => {
    tourneyConfig.format = val;
    refreshCompView();
  }));
  container.appendChild(formatRow);

  renderFieldBuilder(container, tourneyConfig, {
    // The human is excluded here for the same reason the Gauntlet excludes them, and it matters
    // MORE here: a tournament pairing is SIMULATED. Letting the human's roster row into the field
    // would have the Worker play their name with a scripted AI controller and fold the result into
    // their rating — a rating changing from a match they never played, earned by a strategy that
    // isn't them. That silently breaks the one property this whole feature rests on (D1: a rating
    // means one thing). The human competes through the Gauntlet, where they actually play.
    exclude: entry => entry.human === true,
    minimum: 2,
    tooFewHint: "A tournament runs on named, persistent AI entrants, and needs at least 2 of them. "
      + "Add entrants on the Roster tab, then come back. (Your own commander plays in the Gauntlet, "
      + "not here — a tournament pairing is simulated, so it can't be you.)",
  });

  const diffRow = mk("div", "setup-row");
  diffRow.appendChild(mk("span", "setup-label", "Difficulty"));
  diffRow.appendChild(optionGroup(tourneyDifficulty(), DIFFICULTY_OPTIONS, key => { tourneyConfig.difficulty = key; refreshCompView(); }));
  container.appendChild(diffRow);
  container.appendChild(mk("p", "setup-hint",
    "One shared difficulty for the WHOLE tournament — pinned identical for every entrant in every " +
    "pairing, and its own ladder bracket (D2). Never a per-entrant difficulty."));

  renderWorldPicker(container, tourneyConfig);
  renderSeedsRow(container, tourneyConfig);
  renderSeedRow(container, tourneyConfig);

  const n = tourneyConfig.field.length;
  if (tourneyConfig.format === "swiss") {
    const roundsRow = mk("div", "setup-row");
    roundsRow.appendChild(mk("span", "setup-label", "Swiss rounds"));
    const input = document.createElement("input");
    input.type = "number";
    input.min = "1";
    input.max = "20";
    input.className = "comp-seeds-input";
    input.placeholder = n >= 2 ? String(swissRoundCount(n)) : "auto";
    input.value = tourneyConfig.roundsText;
    input.addEventListener("change", () => { tourneyConfig.roundsText = input.value; refreshCompView(); });
    roundsRow.appendChild(input);
    container.appendChild(roundsRow);
    container.appendChild(mk("p", "setup-hint",
      n >= 2
        ? `Leave blank for the default, max(3, ceil(log₂ n)) — ${plural(swissRoundCount(n), "round")} for this field.`
        : "Leave blank for the default, max(3, ceil(log₂ n))."));
  }

  // The up-front budget, BEFORE Start Tournament is clickable (the Phase 3 brief's own point: a
  // player who picks a huge field deserves to be told it's a long run before it starts).
  const ready = n >= 2 && tourneyConfig.worlds.length > 0;
  if (ready) {
    const est = tournamentEstimate({
      format: tourneyConfig.format, entrants: n,
      worlds: tourneyConfig.worlds, seeds: tourneyConfig.seeds, rounds: swissRoundsOverride(),
    });
    const line = mk("p", "comp-estimate", est.text);
    line.appendChild(mk("span", "comp-estimate-detail",
      `${plural(est.pairings, "pairing")} × ${plural(tourneyConfig.worlds.length, "world")} × ` +
      `${plural(tourneyConfig.seeds, "seed")} × 2 sides, at roughly ${SECONDS_PER_MATCH}s a match`));
    container.appendChild(line);
  } else {
    container.appendChild(mk("p", "setup-hint",
      n < 2 ? "Pick at least 2 entrants above to see what this run will cost." : "Pick at least one world."));
  }

  if (tourneyError) container.appendChild(mk("p", "comp-error", tourneyError));

  const startBtn = mk("button", "btn" + (ready ? "" : " disabled"), "▶ Start Tournament");
  startBtn.type = "button";
  startBtn.disabled = !ready;
  if (ready) startBtn.addEventListener("click", startTournament);
  container.appendChild(startBtn);
}

/* ---------- tournament: progress ---------- */

// One table shared by the live progress view and the finished round-robin/Swiss results view, so
// the number moving on screen and the number it settles on are rendered by the same code.
function renderTournamentStandingsTable(container, rows, showByes) {
  const wrap = mk("div", "comp-table-wrap");
  const table = document.createElement("table");
  table.className = "comp-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  ["#", "Name", "W-L-D", ...(showByes ? ["Byes"] : [])].forEach(h => headRow.appendChild(mk("th", null, h)));
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  shapeTournamentStandings(rows).forEach((row, i) => {
    const tr = document.createElement("tr");
    tr.appendChild(mk("td", null, String(i + 1)));
    tr.appendChild(mk("td", null, row.name));
    tr.appendChild(mk("td", null, row.record));
    if (showByes) tr.appendChild(mk("td", null, String(row.byes)));
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  container.appendChild(wrap);
}

// Every pairing that has finished, newest last — the knockout's live view (a bracket can't be drawn
// until its tree exists) and a running log for the other two formats.
function renderPairingLog(container, pairings) {
  if (!pairings.length) return;
  const wrap = mk("div", "comp-table-wrap");
  const table = document.createElement("table");
  table.className = "comp-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  ["Round", "Pairing", "Result"].forEach(h => headRow.appendChild(mk("th", null, h)));
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  pairings.forEach(p => {
    const tr = document.createElement("tr");
    const winner = p.aWins === p.bWins ? "tied" : `${p.aWins > p.bWins ? p.aName : p.bName} won`;
    [String(p.round), `${p.aName} vs ${p.bName}`, `${p.aWins}-${p.bWins}-${p.draws} — ${winner}`]
      .forEach(v => tr.appendChild(mk("td", null, v)));
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  container.appendChild(wrap);
}

function renderTournamentProgress(container) {
  const wrap = mk("div", "comp-progress");
  const p = tourneyProgress || { completed: 0, total: 0 };
  wrap.appendChild(mk("p", "setup-hint",
    `${formatLabelFor(tourneyConfig.format)} — ` +
    (p.round ? tournamentProgressLabel(p) : `starting… 0 of ${p.total} matches`)));

  const bar = mk("div", "comp-progress-bar");
  const fill = mk("div", "comp-progress-fill");
  fill.style.width = (p.total ? Math.round((p.completed / p.total) * 100) : 0) + "%";
  bar.appendChild(fill);
  wrap.appendChild(bar);

  const cancelBtn = mk("button", "btn", "Cancel");
  cancelBtn.type = "button";
  cancelBtn.addEventListener("click", () => {
    // Worker#terminate() kills the thread outright mid-match — competitionWorker.js needs no
    // cooperative cancellation, and nothing is written to the ledger until its "done" message,
    // which a terminated worker never sends.
    if (activeWorker) { activeWorker.terminate(); activeWorker = null; }
    tourneyView = "config";
    refreshCompView();
  });
  wrap.appendChild(cancelBtn);
  container.appendChild(wrap);

  if (tourneyConfig.format === "knockout") {
    renderPairingLog(container, tourneyPairings);
  } else if (tourneyJob) {
    container.appendChild(mk("p", "setup-hint", "Standings so far:"));
    renderTournamentStandingsTable(
      container,
      tournamentStandingsRows(tourneyJob.field.map(e => e.name), tourneyPairings),
      tourneyConfig.format === "swiss",
    );
    if (tourneyConfig.format === "swiss")
      container.appendChild(mk("p", "setup-hint", "Byes are settled when the tournament finishes."));
  }
}

/* ---------- tournament: results ---------- */

function bracketSeat(name, won, isBye) {
  const seat = mk("div", "comp-bracket-seat" + (won ? " winner" : "") + (isBye ? " bye" : ""));
  seat.appendChild(mk("span", "comp-bracket-seat-name", isBye ? "BYE" : name));
  if (won) seat.appendChild(mk("span", "comp-bracket-check", "✓"));
  return seat;
}

function renderBracket(container, view) {
  const wrap = mk("div", "comp-bracket-wrap");
  const board = mk("div", "comp-bracket");
  view.rounds.forEach(round => {
    const col = mk("div", "comp-bracket-round");
    col.appendChild(mk("h4", "comp-bracket-title", round.title));
    round.matches.forEach(m => {
      const card = mk("div", "comp-bracket-match" + (m.bye ? " is-bye" : ""));
      card.appendChild(bracketSeat(m.a, m.aWon, false));
      card.appendChild(bracketSeat(m.b, m.bWon, m.b == null));
      card.appendChild(mk("span", "comp-bracket-score", m.score));
      col.appendChild(card);
    });
    board.appendChild(col);
  });
  wrap.appendChild(board);
  container.appendChild(wrap);
}

// What the ledger fold actually did to every entrant's rating, straight off the ledger (before and
// after recordCompetition), so "the ladder was updated" is shown rather than merely claimed.
function renderLadderMovement(container, note) {
  const names = Object.keys(note.after);
  if (!names.length) return;
  container.appendChild(mk("p", "setup-hint", "Ladder movement:"));
  const wrap = mk("div", "comp-table-wrap");
  const table = document.createElement("table");
  table.className = "comp-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  ["Name", "Rating", "Change", "Games"].forEach(h => headRow.appendChild(mk("th", null, h)));
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  names
    .sort((x, y) => note.after[y].rating - note.after[x].rating || x.localeCompare(y))
    .forEach(name => {
      const before = note.before[name], after = note.after[name];
      const change = Math.round(after.rating) - Math.round(before.rating);
      const tr = document.createElement("tr");
      [name, formatElo(after), `${change > 0 ? "+" : ""}${change}`, String(after.games)]
        .forEach(v => tr.appendChild(mk("td", null, v)));
      tbody.appendChild(tr);
    });
  table.appendChild(tbody);
  wrap.appendChild(table);
  container.appendChild(wrap);
}

function renderTournamentResults(container) {
  const done = tourneyDone;
  const job = tourneyJob;
  const diffLabel = difficultyLabelFor(job.difficulty);

  container.appendChild(mk("h3", "cards-heading",
    `${formatLabelFor(done.format)} — ${plural(done.field.length, "entrant")}, ${plural(done.pairings.length, "pairing")}`));

  const note = tourneyLedgerNote || { recorded: 0, total: 0, error: "the result was never recorded" };
  container.appendChild(mk("p", note.error ? "comp-note" : "comp-note comp-note-good",
    note.error
      ? `The tournament finished, but the ladder update stopped after ${plural(note.recorded, "pairing")}: ${note.error}`
      : `Elo updated for the ${diffLabel} bracket — ${plural(note.recorded, "pairing")} recorded, in the order they were played. See the Standings screen.`));

  if (done.format === "knockout") {
    container.appendChild(mk("p", "comp-champion", `🏆 Champion: ${done.champion}`));
    renderBracket(container, shapeBracketView(done.bracket));
  } else {
    renderTournamentStandingsTable(container, done.standings, done.format === "swiss");
    if (done.format === "swiss" && done.byeNames && done.byeNames.length)
      container.appendChild(mk("p", "setup-hint",
        `Byes: ${done.byeNames.join(", ")} — a bye is never scored as a win, only recorded as a round sat out.`));
    renderPairingLog(container, done.pairings);
  }

  if (tourneyLedgerNote) renderLadderMovement(container, tourneyLedgerNote);

  const actions = mk("div", "comp-actions");
  const again = mk("button", "btn", "Run Another Tournament");
  again.type = "button";
  again.addEventListener("click", () => { tourneyView = "config"; refreshCompView(); });
  actions.appendChild(again);
  const seeStandings = mk("button", "btn", "View Standings");
  seeStandings.type = "button";
  seeStandings.addEventListener("click", () => { standingsDifficulty = job.difficulty; compScreen = "standings"; refreshCompView(); });
  actions.appendChild(seeStandings);
  container.appendChild(actions);
}

/* ---------- tournament: run ---------- */

// Fold a finished tournament into the ledger: ONE recordCompetition call PER PAIRING, in the exact
// order the worker finished them (round 1 before round 2, in-round order preserved) — D6's
// canonical-ordering rule applied to a multi-pairing tournament, since Elo is order-dependent.
// Deliberately NOT one batched call: recordCompetition is shaped around a single aName/bName pair
// and writes one history entry per competition, exactly as Quick Duel already calls it per duel.
function foldTournamentIntoLedger(job, done) {
  const activeLedger = ensureLedger();
  const names = job.field.map(e => e.name);
  const bracketBefore = activeLedger.ratingsByDifficulty[job.difficulty];
  const before = {};
  for (const name of names) before[name] = ratingLookup(bracketBefore, name);

  let recorded = 0;
  let error = null;
  for (const pairing of done.pairings) {
    try {
      recordCompetition(activeLedger, {
        at: Date.now(), difficulty: job.difficulty,
        aName: pairing.aName, bName: pairing.bName, rows: pairing.rows,
      });
      recorded++;
    } catch (err) {
      // Not expected — buildTournamentJob already guarantees every name is real, distinct and
      // non-forbidden — but a rejected write must surface rather than vanish, and the pairings
      // already recorded stay recorded (they really were played).
      error = err.message;
      break;
    }
  }
  saveLedgerToStorage(activeLedger);

  const bracketAfter = activeLedger.ratingsByDifficulty[job.difficulty];
  const after = {};
  for (const name of names) after[name] = ratingLookup(bracketAfter, name);
  tourneyLedgerNote = { recorded, total: done.pairings.length, error, before, after };
}

function startTournament() {
  tourneyError = null;
  const activeLedger = ensureLedger();

  // Resolve every pick against the CURRENT roster (never a stale copy) before building the job —
  // the same discipline resolveEntrantPick gives a Quick Duel's two pickers.
  const picked = tourneyConfig.field
    .map(name => activeLedger.roster.find(r => r.name === name))
    .filter(Boolean);
  if (picked.length < 2) {
    tourneyError = "Pick at least 2 entrants from the roster.";
    refreshCompView();
    return;
  }

  const difficulty = tourneyDifficulty();
  // A knockout consumes a SEEDING and never invents one (pairing.js's own contract), so seed it
  // here, off this difficulty bracket's own ladder. The other two formats read the field's order as
  // nothing more than an order, so they keep the player's own selection order.
  const field = tourneyConfig.format === "knockout"
    ? seedFieldByRating(picked, activeLedger.ratingsByDifficulty[difficulty])
    : picked;

  let job;
  try {
    job = buildTournamentJob({
      format: tourneyConfig.format,
      field,
      difficulty,
      worlds: tourneyConfig.worlds,
      seeds: tourneyConfig.seeds,
      seedBase: resolveSeedBase(tourneyConfig.seedText),
      rounds: swissRoundsOverride(),
    });
  } catch (err) {
    tourneyError = err.message;
    refreshCompView();
    return;
  }

  tourneyJob = job;
  tourneyPairings = [];
  tourneyDone = null;
  tourneyLedgerNote = null;
  tourneyProgress = {
    completed: 0,
    total: tournamentEstimate({
      format: job.format, entrants: job.field.length, worlds: job.worlds, seeds: job.seeds, rounds: job.rounds,
    }).matches,
  };
  tourneyView = "progress";
  // The mirror of startDuel's own line: a Quick Duel that was still running loses the worker slot
  // below, so its progress view is reset rather than left to come back frozen.
  if (compView === "progress") compView = "config";
  refreshCompView();

  // One worker slot for the whole mode: starting a tournament cancels whatever was running, exactly
  // as starting a duel already does.
  if (activeWorker) activeWorker.terminate();
  activeWorker = new Worker(new URL("./competitionWorker.js", import.meta.url), { type: "module" });
  activeWorker.onmessage = e => {
    const msg = e.data;
    // Same rule as startDuel's handler: state updates land unconditionally (the ledger write must
    // happen whichever tab is on screen), but the DOM is only rebuilt when the Tournament tab is
    // actually showing — otherwise a progress tick would wipe the Roster/Standings screen out from
    // under whatever it's doing.
    const onTourneyTab = () => compScreen === "tournament";
    if (msg.type === "progress") {
      tourneyProgress = msg;
      if (onTourneyTab() && tourneyView === "progress") refreshCompView();
    } else if (msg.type === "pairing") {
      tourneyPairings = [...tourneyPairings, msg];
      if (onTourneyTab() && tourneyView === "progress") refreshCompView();
    } else if (msg.type === "done") {
      activeWorker = null;
      tourneyDone = msg;
      foldTournamentIntoLedger(job, msg);
      tourneyView = "results";
      if (onTourneyTab()) refreshCompView();
    } else if (msg.type === "error") {
      activeWorker = null;
      tourneyError = `The tournament failed to run: ${msg.message}`;
      tourneyView = "config";
      if (onTourneyTab()) refreshCompView();
    }
  };
  activeWorker.postMessage(job);
}

/* ---------- roster screen ---------- */

// A small local Blob-plus-synthetic-anchor download, mirroring saveload.js's own Save-button idiom
// (downloadJSON there) rather than importing it: competitionLedger.js's own header keeps this
// module's dependency surface small on purpose ("kept independent of saveload.js itself ... to
// keep this module DOM-free and its dependency surface small") and saveload.js doesn't export its
// helper anyway — same reasoning, one file over.
function stampFilename() {
  const d = new Date();
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function exportLadderToFile() {
  const blob = new Blob([JSON.stringify(exportLedger(ensureLedger()))], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `stellar-frontier-ladder-${stampFilename()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// A single candidate document is tiny — a few dozen numbers. The cap is deliberately far tighter
// than the ladder one below: nothing legitimate here is even close, so a big file is a wrong file.
export const MAX_AI_FILE_BYTES = 256 * 1024;

// Load one candidate file as a roster entrant. Its genome goes through competitionLedger.js's
// addRosterEntry, which runs tools/genome.js's sanitizeGenome over it — a whitelist against
// GENOME_SCHEMA — so an out-of-range dial, an unknown key or a hostile mix cannot reach the live
// AI tables. Nothing here trusts the file; it only names it.
export function importAiFromFile() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json,.json";
  input.addEventListener("change", () => {
    const file = input.files && input.files[0];
    if (!file) return;
    if (file.size > MAX_AI_FILE_BYTES) { compRosterError = "Import failed: that file is too large to be an AI."; refreshCompView(); return; }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const doc = JSON.parse(String(reader.result));
        const genome = sanitizeGenome(genomeFromCandidate(doc));
        if (!genome) throw new Error("that file carries no readable genome");
        const base = typeof doc.name === "string" && doc.name.trim() ? doc.name.trim() : "Imported AI";
        // Names are unique on the roster, and addRosterEntry throws on a collision. Pick the first
        // free suffix rather than making the player rename by hand or silently replacing an entry
        // they may still care about.
        let name = base;
        for (let i = 2; ensureLedger().roster.some(r => r.name === name); i++) name = `${base} ${i}`;
        addRosterEntry(ensureLedger(), { name, genome, archetype: doc.archetype || null, createdAt: Date.now() });
        saveLedgerToStorage(ensureLedger());
        compRosterError = "";
      } catch (err) {
        compRosterError = `Import failed: ${err.message}`;
      }
      refreshCompView();
    };
    reader.onerror = () => { compRosterError = "Import failed: that file could not be read."; refreshCompView(); };
    reader.readAsText(file);
  });
  input.click();
}

// A candidate document (tools/genome.js toCandidate) stores its genome LOWERED into overrides rows,
// because that is the shape the bench consumes. Lift it back: the strategy row and the entrant's
// own archetype row are the two halves, keyed by whatever name the file was written under.
export function genomeFromCandidate(doc) {
  if (!doc || typeof doc !== "object") return null;
  if (doc.strategy && typeof doc.strategy === "object") return doc;   // already a raw genome
  const strategies = doc.overrides?.strategies || {};
  const archetypes = doc.overrides?.archetypes || {};
  const sRow = Object.values(strategies)[0];
  const aRow = Object.values(archetypes)[0];
  if (!sRow && !aRow) return null;
  return { strategy: sRow || {}, archetype: aRow || {}, sigma: doc.sigma };
}

const MAX_LADDER_FILE_BYTES = 4 * 1024 * 1024;   // generous headroom over any real ladder (competitionLedger.js's own sanitizer caps it further)

function importLadderFromFile() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json,.json";
  input.addEventListener("change", () => {
    const file = input.files && input.files[0];
    if (!file) return;
    if (file.size > MAX_LADDER_FILE_BYTES) { compRosterError = "Import failed: that file is too large to be a real ladder."; refreshCompView(); return; }
    const reader = new FileReader();
    reader.onload = () => {
      // JSON.parse first (never eval); importLedgerJSON sanitizes the structure and every field
      // before any of it is trusted (competitionLedger.js's own untrusted-input pipeline) — a
      // corrupt or hostile file throws a clear message here rather than failing silently.
      try {
        ledger = importLedgerJSON(String(reader.result));
        saveLedgerToStorage(ledger);
        compRosterError = null;
      } catch (err) {
        compRosterError = `Import failed: ${err.message}`;
      }
      refreshCompView();
    };
    reader.onerror = () => { compRosterError = "Import failed: could not read the file."; refreshCompView(); };
    reader.readAsText(file);
  });
  input.click();
}

// A small confirm modal, same overlay/card idiom as saveload.js's own goHome and landingPicker.js's
// landing-pick-confirm — each of those gets its OWN class names rather than literally sharing
// .home-confirm (see landingPicker.js's own comment), so this does too (.comp-confirm/
// .comp-confirm-card in style.css). Shared by the Roster screen's Remove and (Phase 4) the
// Gauntlet's Forfeit/Abandon, because "say what this will do before doing it" is the same dialog
// every time — only its words and its one destructive action differ.
function openCompConfirm({ title, body, confirmLabel, onConfirm }) {
  const overlay = mk("div", "comp-confirm");
  const card = mk("div", "comp-confirm-card");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.tabIndex = -1;
  card.append(mk("h3", null, title), mk("p", null, body));

  // Same close()-funnels-every-exit-path discipline as saveload.js's own goHome() confirm modal:
  // Cancel, Confirm, a backdrop click, AND Escape all have to detach the SAME window keydown
  // listener, or closing any way but Escape leaks one listener per dialog opened.
  const previouslyFocused = document.activeElement;
  const close = () => {
    overlay.remove();
    window.removeEventListener("keydown", onKey);
    if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
  };
  const onKey = e => { if (e.key === "Escape") { e.preventDefault(); close(); } };

  const actions = mk("div", "comp-confirm-actions");
  const cancelBtn = mk("button", "btn ghost", "Cancel");
  cancelBtn.type = "button";
  cancelBtn.addEventListener("click", close);
  const confirmBtn = mk("button", "btn comp-danger-btn", confirmLabel);
  confirmBtn.type = "button";
  confirmBtn.addEventListener("click", () => { close(); onConfirm(); });
  actions.append(cancelBtn, confirmBtn);
  card.appendChild(actions);

  overlay.appendChild(card);
  overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
  window.addEventListener("keydown", onKey);
  wrapEl.appendChild(overlay);
  confirmBtn.focus();
}

function confirmRemoveRosterEntry(name) {
  const activeLedger = ensureLedger();
  const played = hasRatingHistory(activeLedger, name);
  openCompConfirm({
    title: `Remove "${name}"?`,
    body: played
      ? `${name} has rating history. Removing it drops it from the Standings screen, but its recorded matches and ratings stay in the ledger.`
      : `${name} hasn't played a rated match yet.`,
    confirmLabel: "Remove",
    onConfirm: () => {
      removeRosterEntry(activeLedger, name);
      saveLedgerToStorage(activeLedger);
      refreshCompView();
    },
  });
}

function renderRosterTable(container, roster) {
  const wrap = mk("div", "comp-table-wrap");
  const table = document.createElement("table");
  table.className = "comp-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  ["Name", "Strategy", "Archetype", "Faction", ""].forEach(h => headRow.appendChild(mk("th", null, h)));
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  roster.forEach(entry => {
    const row = shapeRosterRow(entry);
    const tr = document.createElement("tr");
    [row.name, row.strategy, row.archetype, row.faction].forEach(v => tr.appendChild(mk("td", null, v)));
    const actionsTd = document.createElement("td");
    const removeBtn = mk("button", "btn comp-remove-btn", "Remove");
    removeBtn.type = "button";
    removeBtn.addEventListener("click", () => confirmRemoveRosterEntry(entry.name));
    actionsTd.appendChild(removeBtn);
    tr.appendChild(actionsTd);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  container.appendChild(wrap);
}

function renderAddRosterEntryForm(container) {
  container.appendChild(mk("h4", "comp-entrant-heading", "Add a roster entry"));
  const card = mk("div", "comp-entrant");

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "comp-name-input";
  nameInput.placeholder = "Name";
  nameInput.maxLength = 40;
  nameInput.value = rosterDraft.name;
  nameInput.addEventListener("input", () => { rosterDraft.name = nameInput.value; });
  card.appendChild(nameInput);

  card.appendChild(mk("span", "setup-label comp-substrategy-label", "Strategy"));
  card.appendChild(optionGroup(rosterDraft.strategy, STRATEGY_OPTIONS, val => { rosterDraft.strategy = val; }));

  card.appendChild(mk("span", "setup-label comp-substrategy-label", "Archetype"));
  card.appendChild(optionGroup(rosterDraft.archetype, ARCHETYPE_OPTIONS, val => { rosterDraft.archetype = val; }));

  card.appendChild(mk("span", "setup-label comp-substrategy-label", "Faction"));
  card.appendChild(optionGroup(rosterDraft.faction, ROSTER_FACTION_OPTIONS, val => { rosterDraft.faction = val; }));

  if (compRosterError) card.appendChild(mk("p", "comp-error", compRosterError));

  const addBtn = mk("button", "btn", "+ Add to Roster");
  addBtn.type = "button";
  addBtn.addEventListener("click", () => {
    const activeLedger = ensureLedger();
    try {
      addRosterEntry(activeLedger, {
        name: rosterDraft.name, strategy: rosterDraft.strategy, archetype: rosterDraft.archetype,
        faction: rosterDraft.faction, createdAt: Date.now(),
      });
      saveLedgerToStorage(activeLedger);
      rosterDraft = freshRosterDraft();
      compRosterError = null;
    } catch (err) {
      compRosterError = err.message;
    }
    refreshCompView();
  });
  card.appendChild(addBtn);

  container.appendChild(card);
}

/* ============================================================
   THE AI EDITOR — build an opponent by hand (docs/ai-evolution-design.md)

   The genome was always meant to be a thing a PLAYER owns, not only something a search breeds.
   Until now owning one meant editing JSON by hand, which is a fine format for a bench and a poor
   one for a person.

   THE WHOLE FORM IS GENERATED FROM GENOME_SCHEMA. Every control's kind, bounds, grouping and label
   come from the schema row, so this screen cannot drift out of step with what the engine actually
   reads: add a gene there and it appears here, with the right widget and the right limits, and it
   is impossible to build an illegal AI through this UI because the bounds ARE the schema's.

   IT SHOWS WHAT IS INERT, which is the feature that justifies a real screen over a text box. The
   genome is full of epistatic switches — under "never initiates" every offense dial is read by
   nothing, matchBuffer/matchFloor are dead unless force-matching is on, the whole diplomacy group
   is dead outside Odyssey. Junk DNA is useful to a search and hostile to a person: someone tuning
   a muster size for ten minutes under a flag that makes it meaningless gets no feedback at all.
   inertGenes() (tools/genome.js) names them and the rows grey out live as you toggle.
   ============================================================ */

// The genome currently on the bench. Null until the screen is first opened, then kept across tab
// switches so a half-built AI survives a trip to the Roster and back.
let editorGenome = null;
let editorName = "";
let editorError = "";
let editorSaved = "";

const EDITOR_GENES = () => geneKeys({ layers: ["strategy", "archetype"], odyssey: true });

// Module -> the plain-English heading a player reads, since "linkage group" is a search concept.
const MODULE_LABELS = {
  offense: "Attacking", economy: "Economy", defense: "Defence", diplomacy: "Diplomacy (Odyssey)",
  adaptation: "Reading the opponent", macro: "Expansion & build-out", tempo: "Attack timing",
  composition: "What it builds",
};

// One-line explanations, keyed by gene. Written for someone who has played the game, not for
// someone who has read the engine.
const GENE_HELP = {
  attackTimeoutMult: "Lower = commits to an attack sooner.",
  armyAttackSizeMult: "Lower = attacks with a smaller force.",
  garrisonMult: "Higher = keeps more units home when it attacks.",
  neverInitiates: "Never starts a fight. Still defends, and still answers a provocation in Odyssey.",
  useBombOffensively: "Walks a built Helium Bomb to the target instead of keeping it as a home trap.",
  workerTargetMult: "Higher = a bigger worker economy.",
  capsArmy: "Hold the standing army at a fixed size and spend the rest on economy.",
  standingArmyCap: "How many combat units it keeps while capped.",
  warFootingMult: "How far the cap lifts once it is attacked.",
  warFootingTime: "How long that surge lasts, in seconds.",
  wantsIndustryAlways: "Climbs the deep factory chain even when its temperament wouldn't.",
  turretCountMult: "Higher = more static defence.",
  matchEnemyForce: "Size its army to mirror whatever it has seen of yours.",
  matchBuffer: "How far above parity it aims.",
  matchFloor: "The smallest home guard it keeps regardless.",
  graceMult: "How long the opening peace lasts.",
  grievanceMult: "How fast it sours when you hurt it.",
  forgiveness: "How fast it cools off again.",
  punishPosture: "How economy-heavy you must look before it raids you.",
  punishConfidence: "How much of you it must have scouted before acting on that.",
  adaptRateMult: "How fast its stance shifts as it learns about you.",
  adaptBandMult: "How big a change it takes to shift at all. Higher = more stubborn.",
  defenceSwingMult: "How far its stance swings turret spending.",
  workerTarget: "Base worker count before multipliers.",
  expandWhenNodesBelow: "Expands once home ore drops below this fraction. 0 = never expands.",
  maxBarracks: "How many production buildings it will run.",
  wantsRefinery: "Builds a Refinery and researches its doctrine.",
  armyAttackSize: "Base wave size before multipliers.",
  attackTimeout: "Base seconds before it commits anyway.",
  garrison: "Base home guard before multipliers.",
  turretCount: "Base turret count before multipliers.",
  unitMix: "Its repeating production cycle. Order matters — the first entry is built first.",
  doctrine: "Which upgrade path it researches.",
  faction: "Its faction bonuses.",
};

function renderAiEditorScreen(container) {
  const genes = EDITOR_GENES();
  if (!editorGenome) editorGenome = genomeFrom({ strategy: "default", archetype: "balanced", genes });

  container.appendChild(mk("p", "setup-hint comp-intro",
    "Build an opponent dial by dial. Every control here comes from the AI's own schema, so anything "
    + "you can set is something the engine really reads and within limits it really accepts — you "
    + "cannot build a broken AI from this screen. Greyed rows are dials that nothing is currently "
    + "reading, and each says why."));

  // START FROM — the shipped strategies and archetypes are far better starting points than a blank
  // form, and "modify a Rusher" is a much more approachable task than "invent an AI".
  //   The seeds are read off STRATEGY_OPTIONS, not engine/aiStrategy.js's raw STRATEGIES: this
  // module deliberately never imports that table (see strategyLabel's own note above), and the row
  // that did reached for an undefined binding — which threw on the first render and made this whole
  // tab a blank screen, since a ReferenceError inside renderAiEditorScreen aborts refreshCompView
  // after it has already emptied the wrapper. STRATEGY_OPTIONS carries the same four keys under
  // `mult` with the same labels, so what a player sees is unchanged.
  const seedRow = mk("div", "comp-io-row");
  seedRow.appendChild(mk("span", "setup-hint", "Start from: "));
  for (const opt of STRATEGY_OPTIONS) {
    const b = mk("button", "btn", opt.label);
    b.type = "button";
    b.addEventListener("click", () => {
      editorGenome = genomeFrom({ strategy: opt.mult, archetype: "balanced", genes });
      editorSaved = ""; editorError = ""; refreshCompView();
    });
    seedRow.appendChild(b);
  }
  container.appendChild(seedRow);

  const inert = inertGenes(editorGenome, { genes, odyssey: false });

  // One block per linkage group, in schema order.
  const modules = [...new Set(genes.map(g => g.module))];
  for (const mod of modules) {
    const rows = genes.filter(g => g.module === mod);
    if (!rows.length) continue;
    container.appendChild(mk("h4", "comp-entrant-heading", MODULE_LABELS[mod] || mod));
    const card = mk("div", "comp-entrant");
    for (const g of rows) card.appendChild(renderGeneRow(g, inert[g.key]));
    container.appendChild(card);
  }

  // SAVE — straight onto the roster, where it is duellable immediately.
  container.appendChild(mk("h4", "comp-entrant-heading", "Save to roster"));
  const saveCard = mk("div", "comp-entrant");
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "comp-name-input";
  nameInput.placeholder = "Name this AI";
  nameInput.maxLength = 40;
  nameInput.value = editorName;
  nameInput.addEventListener("input", () => { editorName = nameInput.value; });
  saveCard.appendChild(nameInput);

  const saveBtn = mk("button", "btn", "Save to roster");
  saveBtn.type = "button";
  saveBtn.addEventListener("click", () => {
    try {
      const name = (editorName || "").trim();
      if (!name) throw new Error("give it a name first");
      // sanitizeGenome again on the way out, even though every control is schema-bounded: the save
      // path is the one that reaches the live AI tables, and it should not depend on the UI having
      // been the only writer.
      addRosterEntry(ensureLedger(), { name, genome: sanitizeGenome(editorGenome), createdAt: Date.now() });
      saveLedgerToStorage(ensureLedger());
      editorSaved = `Saved “${name}” — pick it as an entrant in Quick Duel.`;
      editorError = "";
    } catch (err) {
      editorError = err.message;
      editorSaved = "";
    }
    refreshCompView();
  });
  saveCard.appendChild(saveBtn);

  const dlBtn = mk("button", "btn", "⭳ Download");
  dlBtn.type = "button";
  dlBtn.title = "Save as a candidate file — the same format the bench and Import AI use.";
  dlBtn.addEventListener("click", () => {
    const name = (editorName || "Custom AI").trim();
    const blob = new Blob([JSON.stringify(toCandidate(editorGenome, name, { genes }), null, 2)],
      { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  saveCard.appendChild(dlBtn);
  container.appendChild(saveCard);

  if (editorError) container.appendChild(mk("p", "comp-error", editorError));
  if (editorSaved) container.appendChild(mk("p", "setup-hint", editorSaved));
}

// One control, chosen by the gene's KIND. Bounds come from the schema row, never from here.
function renderGeneRow(g, inertWhy) {
  const row = mk("div", "comp-gene-row" + (inertWhy ? " comp-gene-inert" : ""));
  const label = mk("label", "comp-gene-label", g.key);
  row.appendChild(label);
  const bag = editorGenome[g.layer];

  if (g.kind === "flag") {
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = bag[g.key] === true;
    // A flag can turn other rows inert, so the whole screen re-renders rather than just this row.
    cb.addEventListener("change", () => { bag[g.key] = cb.checked; refreshCompView(); });
    row.appendChild(cb);
  } else if (g.kind === "choice") {
    const sel = document.createElement("select");
    for (const opt of g.of) {
      const o = document.createElement("option");
      o.value = o.textContent = opt;
      if (bag[g.key] === opt) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener("change", () => { bag[g.key] = sel.value; });
    row.appendChild(sel);
  } else if (g.kind === "mix") {
    row.appendChild(renderMixEditor(g, bag));
  } else {
    const isCount = g.kind === "count";
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = String(g.min);
    slider.max = String(g.max);
    slider.step = isCount ? "1" : String(Math.max(0.001, +((g.max - g.min) / 200).toFixed(3)));
    slider.value = String(bag[g.key]);
    const out = mk("span", "comp-gene-value", String(bag[g.key]));
    slider.addEventListener("input", () => {
      const v = isCount ? Math.round(Number(slider.value)) : +Number(slider.value).toFixed(3);
      bag[g.key] = v;
      out.textContent = String(v);
    });
    row.appendChild(slider);
    row.appendChild(out);
  }

  // The reason it is inert outranks the ordinary help text: it is the more actionable fact.
  row.appendChild(mk("span", "setup-hint comp-gene-help", inertWhy || GENE_HELP[g.key] || ""));
  return row;
}

// The production cycle: an ordered list, because order decides what gets built first. Kept simple —
// add a type, remove a slot — rather than drag-and-drop, which is a lot of code for a nine-slot list.
function renderMixEditor(g, bag) {
  const wrap = mk("div", "comp-mix");
  const mix = Array.isArray(bag[g.key]) ? bag[g.key] : [];
  mix.forEach((type, i) => {
    const chip = mk("button", "btn comp-mix-chip", `${i + 1}. ${type} ✕`);
    chip.type = "button";
    chip.title = "Remove this slot";
    chip.addEventListener("click", () => {
      // Two entries is the shortest thing that is still a cycle (tools/genome.js MIX_MIN_LEN).
      if (mix.length <= 2) { editorError = "a production cycle needs at least two entries"; }
      else { mix.splice(i, 1); editorError = ""; }
      refreshCompView();
    });
    wrap.appendChild(chip);
  });
  const add = document.createElement("select");
  const blank = document.createElement("option");
  blank.value = ""; blank.textContent = "+ add…";
  add.appendChild(blank);
  for (const t of MIX_ALPHABET) {
    const o = document.createElement("option");
    o.value = o.textContent = t;
    add.appendChild(o);
  }
  add.addEventListener("change", () => {
    if (!add.value) return;
    if (mix.length >= 10) { editorError = "a production cycle is capped at ten entries"; }
    else { mix.push(add.value); editorError = ""; }
    refreshCompView();
  });
  wrap.appendChild(add);
  return wrap;
}

function renderRosterScreen(container) {
  const activeLedger = ensureLedger();

  container.appendChild(mk("p", "setup-hint comp-intro",
    "Every roster entry is a named, persistent competitor. Quick Duel entrants are picked from " +
    "here — or created fresh there, which adds them here the moment their duel actually runs."));

  if (activeLedger.roster.length === 0) {
    container.appendChild(mk("p", "setup-hint", "No roster entries yet — add one below."));
  } else {
    renderRosterTable(container, activeLedger.roster);
  }

  renderAddRosterEntryForm(container);

  const ioRow = mk("div", "comp-io-row");
  // IMPORT AN AI — a mirror of your own play (the game-over screen's "Save an AI that plays like
  // you"), or a genome someone authored or evolved. The file is a candidate document, exactly the
  // shape tools/ailab.js's duel/sweep already take, so a bench-bred AI and a player-made one are
  // the same artifact and neither needs a converter.
  const importAiBtn = mk("button", "btn", "⭱ Import AI");
  importAiBtn.type = "button";
  importAiBtn.title = "Load a genome file — your own mirror, or one you were sent — as a roster entrant.";
  importAiBtn.addEventListener("click", importAiFromFile);
  ioRow.appendChild(importAiBtn);
  const exportBtn = mk("button", "btn", "⭳ Export Ladder");
  exportBtn.type = "button";
  exportBtn.addEventListener("click", exportLadderToFile);
  ioRow.appendChild(exportBtn);
  const importBtn = mk("button", "btn", "⭱ Import Ladder");
  importBtn.type = "button";
  importBtn.addEventListener("click", importLadderFromFile);
  ioRow.appendChild(importBtn);
  container.appendChild(ioRow);
  container.appendChild(mk("p", "setup-hint",
    "Export downloads the whole ladder (roster, ratings, history) as a .json file. Import replaces " +
    "the current ladder with one from a file — a corrupt or unrecognised file is rejected with an error, never applied silently."));
}

/* ---------- standings screen ---------- */

// A stored wall-clock ms -> a short, local, human date. Only ever used for DISPLAY of an
// already-recorded timestamp (never to make one — those are injected at the write, see
// competitionLedger.js's own purity note), so it is safely a DOM-layer helper.
function shortDate(at) {
  if (!Number.isFinite(at)) return "—";
  const d = new Date(at);
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * The RECORDED-MATCHES list, with a Replay button per row (docs/competitions-and-elo.md Phase 5).
 * This is where finished matches are visible after the session that ran them is gone — the Quick
 * Duel results table shows the duel you just ran; this shows the ladder's whole record, reloads and
 * imports included, which is what makes "replay a finished match" mean something a week later.
 */
function renderMatchHistory(container, activeLedger) {
  const matches = shapeHistoryMatches(activeLedger);
  container.appendChild(mk("h4", "comp-entrant-heading", "Recent matches"));
  if (matches.length === 0) {
    container.appendChild(mk("p", "setup-hint", "No matches recorded yet — run a duel or a tournament."));
    return;
  }
  container.appendChild(mk("p", "setup-hint", REPLAY_NOTE));

  const wrap = mk("div", "comp-table-wrap");
  const table = document.createElement("table");
  table.className = "comp-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  ["When", "Bracket", "World", "Seed", "Side", "Winner", "Margin", ""].forEach(h => headRow.appendChild(mk("th", null, h)));
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  matches.forEach(m => {
    const tr = document.createElement("tr");
    [shortDate(m.at), difficultyLabelFor(m.difficulty), planetName(m.world), m.seed, m.side, m.winner, m.margin]
      .forEach(v => tr.appendChild(mk("td", null, String(v))));
    const actionsTd = document.createElement("td");
    if (m.replayable) {
      const btn = mk("button", "btn comp-replay-btn", "▶ Replay");
      btn.type = "button";
      btn.title = `Re-run this match from seed ${m.seed} on ${planetName(m.world)} and watch it. Changes no rating.`;
      btn.addEventListener("click", () => replayLedgerMatch(m.entryIndex, m.rowIndex, openStandingsScreen));
      actionsTd.appendChild(btn);
    } else {
      // Listed, not hidden: the match happened. The reason it can't be re-run is shown where the
      // button would have been, rather than as a disabled control that explains nothing.
      const note = mk("span", "comp-replay-refused", m.human ? "played live" : "not replayable");
      note.title = m.reason;
      actionsTd.appendChild(note);
    }
    tr.appendChild(actionsTd);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  container.appendChild(wrap);
}

/**
 * The SEASONS block (docs/competitions-and-elo.md Phase 5): the list of closed seasons, each
 * viewable, plus the form that closes the current one. Archiving is confirmed first, and the
 * confirm shows the summary it is about to record — who finished top and how much was played —
 * because "reset my ladder" is exactly the click a player should see the consequences of.
 */
function renderSeasonsBlock(container, activeLedger) {
  const seasons = activeLedger.seasons || [];
  container.appendChild(mk("h4", "comp-entrant-heading", "Seasons"));
  container.appendChild(mk("p", "setup-hint",
    "Archiving files the current ratings and match history under a season label and starts the ladder "
    + "over. The ROSTER is kept — every entrant stays, only their ratings restart. Past seasons stay "
    + "viewable here, and ride the same export/import file as everything else."));

  if (seasons.length) {
    const wrap = mk("div", "comp-table-wrap");
    const table = document.createElement("table");
    table.className = "comp-table";
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    ["#", "Season", "Finished", "Matches", "Champions", ""].forEach(h => headRow.appendChild(mk("th", null, h)));
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    seasons.forEach((season, i) => {
      const tr = document.createElement("tr");
      if (viewingSeason === i) tr.className = "comp-season-row is-viewing";
      const champions = season.summary.brackets.map(b => `${b.top} (${difficultyLabelFor(b.difficulty)} ${Math.round(b.topRating)})`).join(" · ") || "—";
      [String(i + 1), season.label, shortDate(season.finishedAt), String(season.summary.matches), champions]
        .forEach(v => tr.appendChild(mk("td", null, v)));
      const actionsTd = document.createElement("td");
      const btn = mk("button", "btn", viewingSeason === i ? "Viewing" : "View");
      btn.type = "button";
      btn.disabled = viewingSeason === i;
      btn.addEventListener("click", () => { viewingSeason = i; standingsError = null; refreshCompView(); });
      actionsTd.appendChild(btn);
      tr.appendChild(actionsTd);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    container.appendChild(wrap);
  }

  const summary = seasonSummary(activeLedger);
  const row = mk("div", "setup-row");
  row.appendChild(mk("span", "setup-label", "New season"));
  const input = document.createElement("input");
  input.type = "text";
  input.className = "comp-season-input";
  input.placeholder = `Season ${seasons.length + 1}`;
  input.maxLength = MAX_SEASON_LABEL;
  input.value = seasonLabelDraft;
  input.addEventListener("input", () => { seasonLabelDraft = input.value; });
  row.appendChild(input);
  const archiveBtn = mk("button", "btn", "🏁 Archive Season");
  archiveBtn.type = "button";
  archiveBtn.addEventListener("click", () => confirmArchiveSeason(summary));
  row.appendChild(archiveBtn);
  container.appendChild(row);

  if (summary.matches === 0)
    container.appendChild(mk("p", "setup-hint", "Nothing to archive yet — no rated match has been played this season."));
}

// The season summary, as the one plain sentence the confirm dialog and the post-archive note both
// show. Built from seasonSummary's derived numbers, never re-counted here.
function seasonSummaryText(summary) {
  if (!summary.matches) return "No rated matches were played.";
  const champions = summary.brackets.map(b => `${b.top} tops the ${difficultyLabelFor(b.difficulty)} bracket at ${Math.round(b.topRating)}`);
  // `plural` would say "matchs" — the same exception captureCompetitionResult's own matchesLeft
  // already carries, spelled the same way rather than teaching `plural` about English.
  const matches = `${summary.matches} match${summary.matches === 1 ? "" : "es"}`;
  return `${matches} played by ${plural(summary.entrants, "entrant")}. `
    + (champions.length ? `${champions.join("; ")}.` : "");
}

function confirmArchiveSeason(summary) {
  const label = seasonLabelDraft.trim() || `Season ${(ensureLedger().seasons || []).length + 1}`;
  openCompConfirm({
    title: `Archive "${label}"?`,
    body: `${seasonSummaryText(summary)} Archiving files that under "${label}" and RESETS every rating and `
      + "the match history. Your roster is kept — every entrant stays, unrated, ready for the new season. "
      + "The archived season stays viewable here.",
    confirmLabel: "Archive & start a new season",
    onConfirm: () => {
      const activeLedger = ensureLedger();
      try {
        archiveSeason(activeLedger, { label: seasonLabelDraft, at: Date.now() });
        saveLedgerToStorage(activeLedger);
        seasonLabelDraft = "";
        standingsError = null;
        // Land the player ON the season they just closed: it is the thing they were looking at, and
        // the live table is now empty by design — dropping them onto an empty ladder with no
        // explanation would read as data loss.
        viewingSeason = activeLedger.seasons.length - 1;
      } catch (err) {
        standingsError = err.message;
      }
      refreshCompView();
    },
  });
}

function renderStandingsScreen(container) {
  const activeLedger = ensureLedger();
  const seasons = activeLedger.seasons || [];
  // A season index that no longer exists (an import replaced the ladder while it was being viewed)
  // falls back to the live ladder rather than rendering nothing.
  if (viewingSeason != null && !seasons[viewingSeason]) viewingSeason = null;
  const season = viewingSeason != null ? seasons[viewingSeason] : null;

  if (standingsError) container.appendChild(mk("p", "comp-error", standingsError));

  if (season) {
    const back = mk("button", "btn comp-back-btn", "← Back to the live ladder");
    back.type = "button";
    back.addEventListener("click", () => { viewingSeason = null; refreshCompView(); });
    container.appendChild(back);
    container.appendChild(mk("h3", "cards-heading", `${season.label} — final standings`));
    container.appendChild(mk("p", "setup-hint",
      `Closed ${shortDate(season.finishedAt)}. ${seasonSummaryText(season.summary)}`));
  }

  const diffRow = mk("div", "setup-row");
  diffRow.appendChild(mk("span", "setup-label", "Bracket"));
  diffRow.appendChild(optionGroup(standingsDifficulty, DIFFICULTY_OPTIONS, key => { standingsDifficulty = key; refreshCompView(); }));
  container.appendChild(diffRow);
  container.appendChild(mk("p", "setup-hint",
    "Each difficulty is its own bracket (D2) — ratings are never blended across them."));

  // A closed season reads back through seasonStandings (its own table, complete even where the
  // roster has moved on); the live ladder reads through standingsFor exactly as it always did.
  const standings = season ? seasonStandings(activeLedger, viewingSeason, standingsDifficulty)
    : standingsFor(activeLedger, standingsDifficulty);
  if (standings.length === 0) {
    container.appendChild(mk("p", "setup-hint", season
      ? "Nobody played a rated match at this difficulty during this season."
      : "Nobody has played a rated match at this difficulty yet."));
    renderStandingsExtras(container, activeLedger, season);
    return;
  }

  const wrap = mk("div", "comp-table-wrap");
  const table = document.createElement("table");
  table.className = "comp-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  ["#", "Name", "Rating", "Games", "W-L-D", "Avg Margin"].forEach(h => headRow.appendChild(mk("th", null, h)));
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  const shaped = shapeStandingsTable(standings);
  shaped.forEach((row, i) => {
    const tr = document.createElement("tr");
    // The human's row is MARKED, not just present. This is the one table in the mode that ranks a
    // person's rating against the AI ratings it's being compared with, and an unmarked row reads as
    // one more entrant — the reader can't tell which number is theirs, or which one the seat note
    // below qualifies.
    if (row.human) tr.className = "comp-standings-row is-you";
    tr.appendChild(mk("td", null, String(i + 1)));
    const nameTd = mk("td", null, row.name);
    if (row.human) nameTd.appendChild(mk("span", "comp-you-badge", "you"));
    if (row.provisional) nameTd.appendChild(mk("span", "comp-provisional-badge", "provisional"));
    tr.appendChild(nameTd);
    [row.rating, row.games, row.record, row.avgMargin].forEach(v => tr.appendChild(mk("td", null, String(v))));
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  container.appendChild(wrap);

  // D4's disclosure, the fifth place it's stated (config, in-progress standing, final standing,
  // game-over block are the other four) — and the one that matters most, because this is where the
  // human's rating is read AGAINST the AI ratings rather than on its own, and where the Gauntlet's
  // own "View Standings" button lands the player. Shown only when this bracket actually contains
  // the human: on a pure AI bracket there is no seat asymmetry to disclose, and a note about "you"
  // beside a table you're not in would be noise.
  if (shaped.some(row => row.human)) container.appendChild(mk("p", "comp-disclosure", SEAT_DISCLOSURE));

  renderStandingsExtras(container, activeLedger, season);
}

// The two Phase 5 blocks that sit under whichever table is showing. Called from BOTH of
// renderStandingsScreen's exits (the empty-bracket one and the populated one) so archiving and
// replaying are reachable from a bracket nobody has played yet — the most likely state right after
// a season is archived, which is exactly when the season list has to still be on screen.
//
// The match history is deliberately the LIVE ladder's only: a closed season's rows are still in the
// ledger and still replayable in principle, but a history list that silently changed meaning with
// the table above it would be the confusing kind of clever. Viewing a season shows that season's
// standings; replaying is done from the current record.
function renderStandingsExtras(container, activeLedger, season) {
  if (!season) renderMatchHistory(container, activeLedger);
  renderSeasonsBlock(container, activeLedger);
}

/* ============================================================
   GAUNTLET SCREEN (docs/competitions-and-elo.md Phase 4) — the human against a field of AI roster
   entrants, ONE LIVE match each, in field order. The one screen in this mode that leaves the
   screen: every other tab runs simulations in a Worker and shows a table, this one boots a real
   skirmish through boot.js and picks the run back up when the match is over.

   THREE THINGS THIS SCREEN OWES THE PLAYER, all of them Phase 4 requirements rather than polish:
     • THE COST, UP FRONT. Five opponents is five real matches — over three hours at Standard,
       under two at Quick (which is why Quick is the default). gauntletEstimate says so before
       Start is clickable.
     • THE SEAT DISCLOSURE (D4). Stated in plain words wherever the human's rating or standing
       shows: here on config, on the in-progress standing, on the final one, on the game-over
       screen after every match — carried by shapeGauntletSummary itself so a standing can't be
       rendered without it — and on the Standings screen (above), whose table is the only one that
       ranks the human's rating against the AI ratings it is being compared with.
     • RESUMABILITY. The run lives in the ledger (competitionLedger.js), not in this module, so
       entering this tab always reads it back from storage — after a page reload, and after the
       navigation away into a live match and back, which is the normal case, not the edge one.
   ============================================================ */

// Its own config object, like tourneyConfig — the three screens are configured independently.
// `difficulty`/`worlds` start null/empty and are defaulted lazily by renderCompetition(), for
// exactly the TDZ reason compConfig.worlds already documents.
const gauntletConfig = {
  field: [],                                       // roster NAMES, in tick order — the play order
  difficulty: null,
  matchTimeLimit: GAUNTLET_DEFAULT_MATCH_SECONDS,  // Quick, the Phase 4 default (see buildGauntletStart)
  worlds: [],
  seedText: "",
  humanDraft: { name: "", faction: "" },           // only used when there is no human entrant yet
};

const gauntletDifficulty = () => gauntletConfig.difficulty || compConfig.difficulty;

// The human plays a real side, so their picker is setup.js's own playable list — ROSTER_FACTION_OPTIONS
// minus the "Unaligned" entry an AI roster row may legitimately default to.
const humanFactionOptions = () => ROSTER_FACTION_OPTIONS.filter(o => o.mult !== "neutral");

function renderGauntletScreen(container) {
  const activeLedger = ensureLedger();
  // The ledger is the single source of "is there a run" — no module-level view flag to get out of
  // step with it, which is what makes a reload (or a return from a live match) resume correctly.
  if (activeLedger.gauntlet) renderGauntletRun(container, activeLedger);
  else renderGauntletConfig(container, activeLedger);
}

/* ---------- gauntlet: config ---------- */

function renderHumanEntrantCard(container, activeLedger) {
  const you = humanEntry(activeLedger);
  const card = mk("div", "comp-entrant comp-human-card");
  card.appendChild(mk("h4", "comp-entrant-heading", "You"));

  if (you) {
    const row = shapeRosterRow(you);
    card.appendChild(mk("p", "comp-human-name", row.name));
    card.appendChild(mk("p", "setup-hint", `Playing as ${row.faction}. You are an ordinary roster entry with an ordinary rating — remove it on the Roster tab to rename yourself.`));
    container.appendChild(card);
    return;
  }

  card.appendChild(mk("p", "setup-hint",
    "Name yourself. This joins the roster as a normal entrant flagged as the human, and is rated in the same bracketed table as everyone else."));
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "comp-name-input";
  nameInput.placeholder = "Your name";
  nameInput.maxLength = 40;
  nameInput.value = gauntletConfig.humanDraft.name;
  nameInput.addEventListener("input", () => { gauntletConfig.humanDraft.name = nameInput.value; });
  card.appendChild(nameInput);

  card.appendChild(mk("span", "setup-label comp-substrategy-label", "Faction"));
  card.appendChild(optionGroup(gauntletConfig.humanDraft.faction, humanFactionOptions(), val => { gauntletConfig.humanDraft.faction = val; }));
  card.appendChild(mk("p", "setup-hint", "Your own faction, exactly as in a skirmish — you play it in every match of the gauntlet."));
  // Shown HERE rather than only at the foot of the screen: while there's no human entrant yet, this
  // form is the only thing that can fail (Start is disabled without one), and an error about the
  // name you just typed belongs next to the box you typed it in.
  if (gauntletError) card.appendChild(mk("p", "comp-error", gauntletError));

  const addBtn = mk("button", "btn", "+ Add me to the roster");
  addBtn.type = "button";
  addBtn.addEventListener("click", () => {
    try {
      addRosterEntry(activeLedger, {
        name: gauntletConfig.humanDraft.name, faction: gauntletConfig.humanDraft.faction,
        createdAt: Date.now(), human: true,
      });
      saveLedgerToStorage(activeLedger);
      gauntletError = null;
    } catch (err) {
      gauntletError = err.message;
    }
    refreshCompView();
  });
  card.appendChild(addBtn);
  container.appendChild(card);
}

function renderGauntletConfig(container, activeLedger) {
  container.appendChild(mk("p", "setup-hint comp-intro",
    "A Gauntlet is you against a field of AI entrants — ONE live match against each of them, in "
    + "order, at one pinned difficulty. Every other format on this screen simulates its matches in "
    + "the background; these you actually play. Your results are rated on the same ladder, in the "
    + "same bracket, as everyone else's."));
  container.appendChild(mk("p", "comp-disclosure", SEAT_DISCLOSURE));

  const you = humanEntry(activeLedger);
  renderHumanEntrantCard(container, activeLedger);

  renderFieldBuilder(container, gauntletConfig, {
    exclude: entry => entry.human === true,
    minimum: 1,
    tooFewHint: "A gauntlet needs at least one AI entrant to face. Add entrants on the Roster tab, then come back.",
  });

  const diffRow = mk("div", "setup-row");
  diffRow.appendChild(mk("span", "setup-label", "Difficulty"));
  diffRow.appendChild(optionGroup(gauntletDifficulty(), DIFFICULTY_OPTIONS, key => { gauntletConfig.difficulty = key; refreshCompView(); }));
  container.appendChild(diffRow);
  container.appendChild(mk("p", "setup-hint",
    "Pinned for the WHOLE gauntlet — every opponent plays at it, and it is the ladder bracket the "
    + "run is rated into (D2). It can't be changed once the gauntlet starts."));

  const lenRow = mk("div", "setup-row");
  lenRow.appendChild(mk("span", "setup-label", "Match length"));
  lenRow.appendChild(optionGroup(gauntletConfig.matchTimeLimit, MATCH_LENGTH_OPTIONS, val => { gauntletConfig.matchTimeLimit = val; refreshCompView(); }));
  container.appendChild(lenRow);

  // World picker + Seed, but deliberately NOT renderSeedsRow's "Seeds / world": a gauntlet plays
  // exactly one match per opponent, so there are no replicates to run — that row would offer a
  // multiplier this format does not have.
  renderWorldPicker(container, gauntletConfig,
    "Worlds — pick one or more. Each match draws its world from this pool, so a wide pool makes the "
    + "gauntlet a tour rather than the same map every time. The map's asymmetric halves alternate "
    + "match by match; the SEATS never swap (see the seat note above).");
  renderSeedRow(container, gauntletConfig);
  container.appendChild(mk("p", "setup-hint",
    "The seed fixes the whole schedule — which world and which map each match is played on — up "
    + "front, so a run resumed days later replays the fixtures it always had."));

  // THE COST, before Start is clickable: one live match per opponent, and what that means in real
  // hours at this match length.
  const ready = !!you && gauntletConfig.field.length > 0 && gauntletConfig.worlds.length > 0;
  if (gauntletConfig.field.length > 0) {
    const est = gauntletEstimate({ opponents: gauntletConfig.field.length, matchTimeLimit: gauntletConfig.matchTimeLimit });
    const line = mk("p", "comp-estimate", est.text);
    line.appendChild(mk("span", "comp-estimate-detail",
      "One live match per opponent — you play every one of them yourself. A match can end sooner than its clock."));
    container.appendChild(line);
  }
  if (!ready) {
    container.appendChild(mk("p", "setup-hint",
      !you ? "Add yourself above to start a gauntlet."
        : gauntletConfig.field.length === 0 ? "Pick at least one opponent."
          : "Pick at least one world."));
  }

  if (gauntletError && you) container.appendChild(mk("p", "comp-error", gauntletError));   // the no-human case shows it in the card above

  const startBtn = mk("button", "btn" + (ready ? "" : " disabled"), "▶ Start Gauntlet");
  startBtn.type = "button";
  startBtn.disabled = !ready;
  if (ready) startBtn.addEventListener("click", startGauntletRun);
  container.appendChild(startBtn);
}

function startGauntletRun() {
  gauntletError = null;
  const activeLedger = ensureLedger();
  const you = humanEntry(activeLedger);
  try {
    startGauntlet(activeLedger, {
      ...buildGauntletStart({
        field: gauntletConfig.field,
        difficulty: gauntletDifficulty(),
        matchTimeLimit: gauntletConfig.matchTimeLimit,
        worlds: gauntletConfig.worlds,
        // Resolved HERE, in the DOM layer, exactly like startDuel/startTournament — a blank Seed
        // box means "roll one", which is a Math.random call the pure half must never make.
        seedBase: resolveSeedBase(gauntletConfig.seedText),
        humanName: you && you.name,
      }),
      at: Date.now(),
    });
    saveLedgerToStorage(activeLedger);
  } catch (err) {
    gauntletError = err.message;
  }
  refreshCompView();
}

/* ---------- gauntlet: the run (in progress, and finished) ---------- */

function renderGauntletFixtureTable(container, summary) {
  const wrap = mk("div", "comp-table-wrap");
  const table = document.createElement("table");
  table.className = "comp-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  ["#", "Opponent", "World", "Result", "Margin", "Rating"].forEach(h => headRow.appendChild(mk("th", null, h)));
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  summary.rows.forEach(row => {
    const tr = document.createElement("tr");
    tr.className = "comp-fixture-row is-" + row.status;
    tr.appendChild(mk("td", null, String(row.number)));
    tr.appendChild(mk("td", null, row.opponent));
    tr.appendChild(mk("td", null, row.worldName));
    tr.appendChild(mk("td", null, row.statusLabel));
    tr.appendChild(mk("td", null, row.played ? String(row.margin) : "—"));
    tr.appendChild(mk("td", null, row.change == null ? "—" : `${row.ratingAfter} (${row.change > 0 ? "+" : ""}${row.change})`));
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  container.appendChild(wrap);
}

function confirmForfeitNextFixture(next) {
  openCompConfirm({
    title: `Forfeit match ${next.number} of ${next.total}?`,
    // The Phase 4 rule, said out loud BEFORE it happens: a forfeit is a real, rated loss, not a
    // skipped fixture.
    body: `This records a LOSS to ${next.opponent} in the ${difficultyLabelFor(next.difficulty)} bracket — `
      + "rated exactly like a match you played and lost. It cannot be undone.",
    confirmLabel: "Forfeit — record a loss",
    onConfirm: () => {
      const activeLedger = ensureLedger();
      try {
        recordGauntletForfeit(activeLedger, { at: Date.now() });
        saveLedgerToStorage(activeLedger);
        gauntletError = null;
      } catch (err) {
        gauntletError = err.message;
      }
      refreshCompView();
    },
  });
}

function confirmAbandonGauntlet(summary) {
  openCompConfirm({
    title: summary.complete ? "Clear this gauntlet?" : "Abandon this gauntlet?",
    body: summary.complete
      ? "The run's results stay on the ladder — this only clears the finished run so you can start another."
      : (summary.played
        ? `The ${summary.played} match${summary.played === 1 ? "" : "es"} you already played keep their ratings; `
        : "Nothing has been played yet, so nothing is rated; ")
        + `the ${summary.remaining} you never played are NOT rated — nobody is credited for a match that didn't happen.`,
    confirmLabel: summary.complete ? "Clear" : "Abandon",
    onConfirm: () => {
      const activeLedger = ensureLedger();
      abandonGauntlet(activeLedger);
      saveLedgerToStorage(activeLedger);
      gauntletError = null;
      refreshCompView();
    },
  });
}

function renderGauntletRun(container, activeLedger) {
  const summary = shapeGauntletSummary(activeLedger);
  const next = nextGauntletFixture(activeLedger);
  const diffLabel = difficultyLabelFor(summary.difficulty);

  container.appendChild(mk("h3", "cards-heading",
    `${summary.complete ? "Gauntlet complete" : "Gauntlet in progress"} — ${summary.humanName} vs `
    + `${plural(summary.total, "opponent")} · ${diffLabel} bracket`));

  const standing = mk("p", "comp-note comp-note-good",
    `${summary.played} of ${summary.total} played · ${summary.record} (W-L-D)`
    + (summary.forfeits ? ` · ${plural(summary.forfeits, "forfeit")}` : "")
    + (summary.complete ? "" : ` · ${summary.remaining} to play`));
  container.appendChild(standing);

  // The human's rating, then the seat disclosure IMMEDIATELY under it — D4's "one line where the
  // human's rating is shown", not a line somewhere else on the page.
  const eloRow = mk("div", "comp-elo-row");
  const card = mk("div", "comp-elo-card");
  card.appendChild(mk("span", "comp-elo-name", summary.humanName));
  card.appendChild(mk("span", "comp-elo-value",
    `${summary.rating.rating}${summary.rating.provisional ? "?" : ""} (${summary.netChange > 0 ? "+" : ""}${summary.netChange} this run)`));
  card.appendChild(mk("span", "comp-elo-games",
    `${plural(summary.rating.games, "game")} in the ${diffLabel} bracket${summary.rating.provisional ? " — provisional" : ""}`));
  eloRow.appendChild(card);
  container.appendChild(eloRow);
  container.appendChild(mk("p", "comp-disclosure", summary.disclosure));

  renderGauntletFixtureTable(container, summary);

  if (gauntletError) container.appendChild(mk("p", "comp-error", gauntletError));

  const actions = mk("div", "comp-actions");
  if (next) {
    container.appendChild(mk("p", "setup-hint",
      `Next: ${next.label} · ${playTimeText(summary.matchTimeLimit)} match. You play the "player" seat; `
      + `${next.opponent} plays at ${diffLabel}.`));
    const play = mk("button", "btn", `▶ Play Next Match — vs ${next.opponent}`);
    play.type = "button";
    play.addEventListener("click", playNextGauntletMatch);
    actions.appendChild(play);

    const forfeit = mk("button", "btn comp-remove-btn", "Forfeit this match");
    forfeit.type = "button";
    forfeit.addEventListener("click", () => confirmForfeitNextFixture(next));
    actions.appendChild(forfeit);
  } else {
    const seeStandings = mk("button", "btn", "View Standings");
    seeStandings.type = "button";
    seeStandings.addEventListener("click", () => { standingsDifficulty = summary.difficulty; compScreen = "standings"; refreshCompView(); });
    actions.appendChild(seeStandings);
  }

  const abandon = mk("button", "btn comp-remove-btn", summary.complete ? "Clear — start a new gauntlet" : "Abandon gauntlet");
  abandon.type = "button";
  abandon.addEventListener("click", () => confirmAbandonGauntlet(summary));
  actions.appendChild(abandon);
  container.appendChild(actions);

  if (summary.complete)
    container.appendChild(mk("p", "setup-hint",
      "Every match above is on the ladder already — the Standings screen shows you ranked against "
      + "this bracket's AI entrants, with the same rating maths applied to all of them."));
}

/* ---------- gauntlet: booting a live match, and capturing its result ---------- */

// Boot the next fixture as a real skirmish. Everything the match runs with comes from the SCHEDULE
// (world/seed/swapAsym) and the run's pinned dials (difficulty/match length) — never from the setup
// screen, and never freshly rolled (D6).
function playNextGauntletMatch() {
  gauntletError = null;
  const activeLedger = ensureLedger();
  const next = nextGauntletFixture(activeLedger);
  if (!next) { gauntletError = "This gauntlet has no match left to play."; openGauntletScreen(); return; }
  const opponent = activeLedger.roster.find(r => r.name === next.opponent);
  const you = humanEntry(activeLedger);
  if (!opponent) {
    gauntletError = `"${next.opponent}" isn't on the roster any more — add that entrant back, or forfeit this match.`;
    openGauntletScreen();
    return;
  }
  if (!you || you.name !== next.humanName) {
    gauntletError = `This gauntlet was started as "${next.humanName}", who is no longer the roster's human entrant.`;
    openGauntletScreen();
    return;
  }
  // One worker slot for the whole mode, and the live match needs the main thread: a duel or
  // tournament still running is terminated here exactly as starting either one terminates the
  // other, and its progress view is reset so it can't come back frozen.
  if (activeWorker) { activeWorker.terminate(); activeWorker = null; }
  if (compView === "progress") compView = "config";
  if (tourneyView === "progress") tourneyView = "config";

  startCompetitionMatch({
    world: next.world, seed: next.seed, difficulty: next.difficulty,
    matchTimeLimit: next.matchTimeLimit, swapAsym: next.swapAsym,
    aiStrategy: opponent.strategy, aiArchetype: opponent.archetype,
    playerFaction: you.faction,
    // What boot.js parks on game.competition and hands back at game-over. The fixture's own
    // identity (index + opponent + seed) rides along so captureCompetitionResult can refuse to
    // record a result into a gauntlet that has moved on since this match started.
    competition: { kind: "gauntlet", index: next.index, opponent: next.opponent, humanName: next.humanName, seed: next.seed },
  });
}

/**
 * Show the Gauntlet tab from wherever the player currently is — the tab row, the game-over screen
 * of a match just played (which has to leave the match first, exactly as "Choose another
 * battlefield" does), or a different menu screen entirely.
 */
export function openGauntletScreen() {
  compScreen = "gauntlet";
  compError = null;
  compRosterError = null;
  tourneyError = null;
  setup.mode = "competition";
  if (game.state) restartToMapSelect();      // leaves the live/finished match, then re-renders map-select
  else if (wrapEl) refreshCompView();        // already on the competition screen
  else renderMapSelect();                    // on some other menu screen
}

/**
 * Record the just-finished live match into the gauntlet, and shape what the game-over screen shows
 * about it (boot.js's own game-over hook is the only caller). Returns the plain block overlays.js
 * renders — the rating change, the standing, the D4 disclosure, and the next fixture with the
 * action that boots it — or null when this match wasn't a competition fixture after all.
 *
 * `game.competition` is CONSUMED here (cleared before anything else can throw), so one finished
 * match can only ever be rated once however many times a game-over frame is re-entered.
 * @param {object} state   the finished game state.
 */
export function captureCompetitionResult(state) {
  const fixture = game.competition;
  game.competition = null;
  if (!fixture || fixture.kind !== "gauntlet") return null;

  const activeLedger = ensureLedger();
  const outcome = humanMatchOutcome(state);
  const beat = outcome.winner === "human" ? `You beat ${fixture.opponent}`
    : outcome.winner === "opponent" ? `${fixture.opponent} beat you`
      : `You drew with ${fixture.opponent}`;
  const matchesLeft = n => `${n} match${n === 1 ? "" : "es"}`;   // `plural` would say "matchs"

  // The gauntlet must still be owing exactly this fixture. It normally is — but a ledger imported,
  // abandoned or advanced in another tab while the match was being played is a real possibility,
  // and recording into whatever fixture happens to be current now would rate the wrong pairing.
  const pending = currentGauntletFixture(activeLedger);
  const mismatch = !pending || pending.index !== fixture.index || pending.opponent !== fixture.opponent
    || pending.seed !== fixture.seed;
  if (mismatch) {
    return {
      title: "Gauntlet", outcome: beat,
      error: "This match no longer matches the gauntlet in progress, so its result was not recorded.",
      viewLabel: "Back to the Gauntlet", onView: openGauntletScreen,
    };
  }

  const before = ratingLookup(activeLedger.ratingsByDifficulty[pending.difficulty], pending.humanName);
  let error = null;
  try {
    // The ledger owns the write — the same recordGauntletMatch path a forfeit takes, into the same
    // pinned bracket, through the same elo.js code every AI entrant's rating goes through (D1).
    recordGauntletMatch(activeLedger, { ...outcome, at: Date.now() });
    saveLedgerToStorage(activeLedger);
  } catch (err) {
    error = `The match finished, but the ladder couldn't be updated: ${err.message}`;
  }
  const after = ratingLookup(activeLedger.ratingsByDifficulty[pending.difficulty], pending.humanName);
  const change = Math.round(after.rating) - Math.round(before.rating);
  const summary = shapeGauntletSummary(activeLedger);
  const next = nextGauntletFixture(activeLedger);

  return {
    title: `Gauntlet — match ${fixture.index + 1} of ${pending.total} · ${difficultyLabelFor(pending.difficulty)} bracket`,
    outcome: beat + (outcome.margin ? ` — score margin ${Math.abs(outcome.margin)}` : ""),
    ratingLine: error ? null
      : `${pending.humanName}: ${Math.round(after.rating)}${after.games < PROVISIONAL_GAMES ? "?" : ""} `
        + `(${change > 0 ? "+" : ""}${change}) after ${plural(after.games, "rated game")}`,
    standing: summary
      ? (summary.complete
        ? `Gauntlet complete — ${summary.record} (W-L-D), ${summary.netChange > 0 ? "+" : ""}${summary.netChange} rating over the run`
        : `Gauntlet standing: ${summary.record} (W-L-D) — ${matchesLeft(summary.remaining)} left`)
      : null,
    error,
    disclosure: SEAT_DISCLOSURE,
    nextLabel: next ? `▶ Play next — vs ${next.opponent} on ${next.worldName}` : null,
    onNext: next ? playNextGauntletMatch : null,
    viewLabel: next ? "Back to the Gauntlet" : "See the final standing",
    onView: openGauntletScreen,
  };
}

/**
 * Forfeit the live competition match the player is ABANDONING by leaving the game (saveload.js's
 * Home confirm is the only caller, and it says so before this runs — the Phase 4 rule is that
 * abandoning is a rated loss, never a silently dropped result). Returns true if a forfeit was
 * actually recorded.
 */
export function forfeitLiveCompetitionMatch() {
  const fixture = game.competition;
  game.competition = null;   // consumed, exactly like captureCompetitionResult's own first act
  if (!fixture || fixture.kind !== "gauntlet") return false;
  const activeLedger = ensureLedger();
  const pending = currentGauntletFixture(activeLedger);
  if (!pending || pending.index !== fixture.index || pending.opponent !== fixture.opponent) return false;
  try {
    recordGauntletForfeit(activeLedger, { at: Date.now() });
    saveLedgerToStorage(activeLedger);
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * The live competition fixture, for a caller that has to describe it before doing something to it
 * (saveload.js's Home confirm) — null when the running game isn't a competition match at all.
 */
export function liveCompetitionFixture() {
  return game.competition && game.competition.kind === "gauntlet" ? { ...game.competition } : null;
}

/* ---------- watching a match: launching one, and ending one ---------- */

/**
 * What a finished WATCHED match's game-over screen shows (boot.js's game-over hook is the only
 * caller). Two parts: the headline `verdict` that replaces the ordinary Victory/Defeat copy — the
 * human played neither seat, so neither word applies — and the plain-data `block` overlays.js
 * renders below it, restating that this was exhibition-only and offering the way back.
 *
 * Records NOTHING. That is the whole decision (see EXHIBITION_NOTE's own section header): no
 * ledger write, no rating, no history row. There is deliberately no code path from here into
 * competitionLedger.js at all, so the disclosure on screen can't drift from what actually happened.
 *
 * A REPLAY (`watch.recorded` present, Phase 5) ends on the same screen with one thing added: the
 * verdict on whether it reproduced the result it was replaying. That check is on screen, in plain
 * words, because it is the claim the feature is built on — a divergence is a real finding about the
 * simulation's determinism and the player should be the first to see it, not the last.
 * @param {object} state    the finished game state.
 * @param {{ aName: string, bName: string, world: string, seed: number, onLeave?: Function,
 *   recorded?: { winnerName: string|null, margin: number } }} watch
 */
export function spectatedGameOverBlock(state, watch) {
  const out = spectatedMatchOutcome(state, watch);
  const leave = watch.onLeave || openDuelScreen;

  if (watch.recorded) {
    const verdict = replayVerdict(out, watch.recorded);
    return {
      verdict: out.verdict,
      block: {
        title: `Replay — ${out.aName} vs ${out.bName} on ${planetName(watch.world)} · seed ${watch.seed}`,
        outcome: `${out.aName} ${out.aScore} — ${out.bScore} ${out.bName}`
          + (out.winReason ? ` · decided by ${out.winReason}` : "")
          + ` · margin ${Math.abs(out.margin)}`,
        // A reproduction reads as an ordinary result line; a DIVERGENCE takes the error slot, which
        // is styled to be noticed — it means the sim is not the deterministic thing this whole
        // system is built on, and a quiet line would bury it.
        ratingLine: verdict.reproduced ? verdict.line : null,
        error: verdict.reproduced ? null : verdict.line,
        disclosure: REPLAY_NOTE,
        viewLabel: "← Back",
        onView: leave,
      },
    };
  }

  return {
    verdict: out.verdict,
    block: {
      title: `Exhibition — ${out.aName} vs ${out.bName} on ${planetName(watch.world)}`,
      outcome: `${out.aName} ${out.aScore} — ${out.bScore} ${out.bName}`
        + (out.winReason ? ` · decided by ${out.winReason}` : "")
        + ` · margin ${Math.abs(out.margin)}`,
      disclosure: EXHIBITION_NOTE,
      viewLabel: "← Back to Quick Duel",
      onView: leave,
    },
  };
}

/**
 * Show the Quick Duel tab from wherever the player currently is — the spectate bar's Leave button,
 * a watched match's game-over screen (which has to leave the match first, exactly as "Choose
 * another battlefield" does), or another menu screen. Mirrors openGauntletScreen above.
 */
// Back to the Quick Duel RESULTS table (as opposed to openDuelScreen's config view) — where a
// replay launched from that table came from. `lastDone` is module state that survives the trip
// into a live match and back, so the table is still there; if it somehow isn't, this degrades to
// the config view rather than rendering an empty results screen.
export function openDuelResultsScreen() {
  if (lastDone && activeJob) {
    compScreen = "duel";
    compView = "results";
    compError = null;
    setup.mode = "competition";
    if (game.state) restartToMapSelect();
    else if (wrapEl) refreshCompView();
    else renderMapSelect();
    return;
  }
  openDuelScreen();
}

export function openDuelScreen() {
  compScreen = "duel";
  compView = "config";
  compError = null;
  compRosterError = null;
  tourneyError = null;
  gauntletError = null;
  setup.mode = "competition";
  if (game.state) restartToMapSelect();      // leaves the live/finished match, then re-renders map-select
  else if (wrapEl) refreshCompView();        // already on the competition screen
  else renderMapSelect();                    // on some other menu screen
}

/**
 * Show the Standings tab from wherever the player currently is — a replay's own "back" route, and
 * where the match history and the season list live. Mirrors openDuelScreen/openGauntletScreen.
 */
export function openStandingsScreen() {
  compScreen = "standings";
  compError = null;
  compRosterError = null;
  tourneyError = null;
  gauntletError = null;
  setup.mode = "competition";
  if (game.state) restartToMapSelect();      // leaves the live/finished match, then re-renders map-select
  else if (wrapEl) refreshCompView();        // already on the competition screen
  else renderMapSelect();                    // on some other menu screen
}

/**
 * REPLAY one recorded match (docs/competitions-and-elo.md Phase 5) — the Replay buttons on the
 * Standings screen's match history and on the Quick Duel results table are the only callers.
 *
 * Addressed by `{entryIndex, rowIndex}` into the LIVE ledger rather than by a row object captured
 * when the table was drawn: an import or a roster edit between drawing the button and clicking it
 * must be seen, not replayed around. buildReplayConfig re-checks replayability and throws its own
 * reason, which is shown rather than swallowed.
 *
 * WRITES NOTHING, for a sharper reason than a watched match does: this match is ALREADY on the
 * ladder. Re-recording it would count one result twice. There is no path from here into
 * recordCompetition, and `game.competition` stays null so boot.js's game-over hook can't rate it
 * either.
 * @param {number} entryIndex @param {number} rowIndex @param {Function} back  where Leave/game-over returns to
 */
function replayLedgerMatch(entryIndex, rowIndex, back) {
  const entry = (ensureLedger().history || [])[entryIndex];
  startReplay(entry && (entry.rows || [])[rowIndex], back);
}

// Replay a row the caller already holds — the Quick Duel results table's own rows, which ARE the
// rows just recorded. No index indirection is needed (or wanted) there: the table is showing this
// exact duel, so replaying what it shows is right even if the ledger has been imported over since.
function startReplay(row, back) {
  standingsError = null;
  compError = null;
  const activeLedger = ensureLedger();
  let cfg;
  try {
    cfg = buildReplayConfig(row, activeLedger);
  } catch (err) {
    standingsError = `That match can't be replayed: ${err.message}`;
    compError = standingsError;
    refreshCompView();
    return;
  }
  // One worker slot for the whole mode, and a live match needs the main thread — the same
  // termination watchDuel and playNextGauntletMatch both do before booting their own live match.
  if (activeWorker) { activeWorker.terminate(); activeWorker = null; }
  if (compView === "progress") compView = "config";
  if (tourneyView === "progress") tourneyView = "config";

  startSpectatedMatch({ ...cfg, onLeave: back });
}

/**
 * Boot the currently-configured Quick Duel as ONE live, watched match (the config view's Watch
 * button). Resolves both entrant pickers and validates the config through the SAME
 * resolveEntrantPick/buildJob path startDuel uses — so a watched match can't be configured in a way
 * a run one couldn't be — then hands buildWatchConfig's opts to boot.js.
 *
 * DELIBERATELY WRITES NOTHING, not even a roster row. startDuel commits a "New Entrant" draft to
 * the roster the instant the duel is about to run, because that duel is about to write RATINGS
 * under that name and the ladder is keyed by name. A watched match writes no ratings, so there is
 * nothing for a persistent identity to anchor; leaving the roster untouched keeps "watching costs
 * nothing" literally true. Draft an entrant, watch it, decide against it — the roster never knew.
 */
function watchDuel() {
  compError = null;
  const activeLedger = ensureLedger();
  let job;
  try {
    job = buildJob({
      entrantA: resolveEntrantPick(compConfig.entrantA, activeLedger),
      entrantB: resolveEntrantPick(compConfig.entrantB, activeLedger),
      difficulty: compConfig.difficulty,
      worlds: compConfig.worlds,
      seeds: compConfig.seeds,
      seedBase: resolveSeedBase(compConfig.seedText),
    });
  } catch (err) {
    compError = err.message;
    refreshCompView();
    return;
  }
  // One worker slot for the whole mode, and a live match needs the main thread — the same
  // termination playNextGauntletMatch does before booting its own live match.
  if (activeWorker) { activeWorker.terminate(); activeWorker = null; }
  if (compView === "progress") compView = "config";
  if (tourneyView === "progress") tourneyView = "config";

  const watch = buildWatchConfig(job);
  startSpectatedMatch({ ...watch, onLeave: openDuelScreen });
}

/* ---------- entry point, called from setup.js's renderMapSelect() ---------- */

export function renderCompetition() {
  if (!mapSelectEl) return;   // import-safe under Node (CONTRIBUTING: follow the dom.js idiom)
  // Lazy defaults (see compConfig's own comment on why these can't just be the initializers above):
  // by the time a real render happens, module evaluation is long finished either way.
  if (compConfig.worlds.length === 0) compConfig.worlds = [MAP_CHOICES[0]];
  if (tourneyConfig.worlds.length === 0) tourneyConfig.worlds = [MAP_CHOICES[0]];
  if (tourneyConfig.difficulty == null) tourneyConfig.difficulty = compConfig.difficulty;
  if (standingsDifficulty == null) standingsDifficulty = compConfig.difficulty;
  // A gauntlet defaults to the WHOLE world roster, not one world like the two simulated formats:
  // it plays one match per opponent and draws each fixture's world from the pool, so a full pool is
  // what makes a run feel like a tour rather than five games on the same map.
  if (gauntletConfig.worlds.length === 0) gauntletConfig.worlds = [...MAP_CHOICES];
  if (gauntletConfig.difficulty == null) gauntletConfig.difficulty = compConfig.difficulty;
  if (!gauntletConfig.humanDraft.faction) gauntletConfig.humanDraft.faction = setup.faction;
  wrapEl = mk("div", "comp-screen");
  mapSelectEl.appendChild(wrapEl);
  refreshCompView();
}
