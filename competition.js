/* ============================================================
   The Competition mode: Quick Duel / Tournament / Roster / Standings
   (docs/competitions-and-elo.md Phases 1-3). Quick Duel pits two entrants against each other,
   side-swapped across every world x seed the player picks, off the main thread in
   competitionWorker.js — never a playable game. This mode never touches boot.js, game.state, the
   canvas, or the HUD: it runs a background simulation and shows a results screen, nothing else.

   PHASE 5: a Quick Duel can also be WATCHED — one match of it, booted into the real game loop with
   both seats AI-driven (boot.js's startSpectatedMatch → tools/selfplay.js's tickSelfPlay) and
   Observer Mode on, so fog is revealed and the human issues no orders. A watched match is
   EXHIBITION ONLY and changes no rating; that decision, and why it isn't a close call, is argued in
   full at EXHIBITION_NOTE below. Its pure half sits with the rest ("WATCHING A MATCH LIVE").

   PHASE 3: the Tournament tab — round-robin, Swiss or a knockout bracket over a multi-selected
   field of roster entries, scheduled by pairing.js inside the same Worker, with an up-front
   match-count/time estimate, round-by-round progress, live standings or a bracket view, and every
   pairing folded into the ledger in real completion order (D6). Its pure half sits with the rest
   below ("TOURNAMENTS"); its screen sits with the rest of the DOM half ("TOURNAMENT SCREEN").

   PHASE 2 (D8/D3): every entrant is now a named, persistent ROSTER row, not a free-typed throwaway
   name — Entrant A/B are each either picked from competitionLedger.js's current roster or drafted
   fresh via "New Entrant" (which joins the roster, via competitionLedger.js's own addRosterEntry,
   the moment the duel using it actually runs — never on a keystroke, so an abandoned draft never
   pollutes the roster). A finished duel's rows are folded into the ledger for the duel's pinned
   difficulty bracket via competitionLedger.js's own recordCompetition — this module never hand-
   rolls a second elo.js applySeries call; the ledger owns that write. Roster and Standings are two
   more sub-screens of this same mode (a small tab row below), reading/writing the SAME ledger.

   Split the SAME way observer.js splits observerStats() (pure) from observerPanel.js's rendering
   consumer, and CONTRIBUTING.md's own C10 rule ("UI modules should stay import-safe under Node,
   guard top-level window/document access"): everything above "DOM RENDERING" below is pure —
   job construction, per-match seed derivation (reusing tools/duelCore.js's own duelSeed, never
   reimplementing its hash), worker-row -> display-table shaping, roster/standings shaping, and
   Elo — directly unit-testable under Node with no DOM and no Worker (test/competition.test.js).
   Everything below it touches `document`/`mapSelectEl` and is guarded the same way setup.js's own
   renderMapSelect() is.

   Wired in from setup.js's renderMapSelect(): a `setup.mode === "competition"` branch delegates
   to renderCompetition() below and returns, mirroring how that function's existing `if (odyssey)`
   branch already short-circuits for Odyssey's own different layout. That import (setup.js's
   STRATEGY_OPTIONS/optionGroup/MAP_CHOICES, reused rather than redefined here) plus setup.js's own
   import of renderCompetition together form a two-file cycle — already true of setup.js and
   boot.js/hud.js/hudSelection.js/overlays.js/saveload.js today (test/static-integrity.test.js's
   "known UI cluster"), so competition.js joins that same documented cluster rather than opening a
   new one; see that test's own KNOWN list for the accompanying note. competitionLedger.js sits
   OUTSIDE that cycle entirely (it imports elo.js/engine/*, nothing that leads back here), so
   importing it below adds no new cycle and needs no TDZ care.

   FAIRNESS carries over from tools/ailab.js/tools/duelCore.js unchanged: ONE shared Difficulty
   pick for the whole duel, never two (see competitionWorker.js's own header). Faction is still NOT
   offered as a DUEL dial — a duel's fairness dial set is archetype/strategy/difficulty
   (tools/selfplay.js's createSelfPlayState takes no faction option at all) — but a roster entry
   DOES carry a faction (competitionLedger.js's own RosterEntry shape), so the New Entrant form
   offers a Faction picker for that entry's own identity/flavor, with a note making clear it's
   cosmetic and doesn't change this duel's outcome; see D3.
   ============================================================ */

"use strict";

import { STRATEGY_OPTIONS, optionGroup, setup } from "./setup.js";
import { archetypeFor, ARCHETYPES, PLANET_ARCHETYPE } from "./engine/aiArchetypes.js";
import { FACTIONS, PLAYABLE_FACTIONS } from "./engine/factions.js";
import { planetName } from "./data.js";
import { duelSeed, pinnedDuelDials } from "./tools/duelCore.js";
import { swissRoundCount, tournamentRoundPlan, tallyStandings } from "./pairing.js";
import { INITIAL_RATING, PROVISIONAL_GAMES, applySeries, applyResult } from "./elo.js";
import { playerScore } from "./engine/victory.js";
import {
  addRosterEntry, removeRosterEntry, recordCompetition, standingsFor,
  GAUNTLET_DEFAULT_MATCH_SECONDS, startGauntlet, currentGauntletFixture,
  recordGauntletMatch, gauntletProgress,
} from "./competitionLedger.js";

/* ============================================================
   PURE — job construction, seed derivation, table/Elo shaping, roster/standings shaping. No DOM,
   no Worker. See test/competition.test.js.
   ============================================================ */

// The Archetype picker's option list (D3), reused via setup.js's own optionGroup — derived
// straight from engine/aiArchetypes.js's ARCHETYPES (its four keys and their own `name` fields),
// never a hardcoded second copy of that roster. `null` ("no override") comes first and is the
// default for both a brand-new draft entrant and a roster entry that never picked one — matches
// createAiController's own archetype opt: absent/unknown falls back to the world's own
// archetypeFor(planetId), byte-identical to before this option existed. Each real entry's `note`
// is likewise derived from the archetype's own numbers (never hand-written prose that could drift
// from the table it's describing).
export const ARCHETYPE_OPTIONS = [
  { label: "World default", mult: null, note: "uses the map's own temperament" },
  ...Object.keys(ARCHETYPES).map(key => ({
    label: ARCHETYPES[key].name,
    mult: key,
    note: `${ARCHETYPES[key].workerTarget} workers · attacks ~${ARCHETYPES[key].attackTimeout}s`,
  })),
];

// The Faction picker for a roster entry (New Entrant / Roster screen's own "add directly" form) —
// derived from engine/factions.js's FACTIONS/PLAYABLE_FACTIONS, plus "neutral" (Unaligned), which
// setup.js's own player-facing FACTION_OPTIONS omits (a skirmish player always picks an aligned
// side) but a roster entry's identity legitimately defaults to. This is FLAVOR on the roster row,
// not a duel dial — tools/selfplay.js's createSelfPlayState takes no faction option at all, so
// picking one here never changes this duel's outcome (the DOM layer says so next to the picker).
export const ROSTER_FACTION_OPTIONS = [...PLAYABLE_FACTIONS, "neutral"].map(id => ({
  label: FACTIONS[id].short, mult: id, note: FACTIONS[id].blurb,
}));

/**
 * Shape a raw config (as the entrant/world/seed pickers below hold it) into exactly the job
 * message competitionWorker.js expects: `{ entrantA:{name,strategy,archetype}, entrantB:{…},
 * difficulty, worlds, seeds, seedBase, matchTimeLimit? }`. Deterministic — same input, same
 * output — so randomness (an unset seed) must already be resolved by the CALLER before this runs
 * (mirrors boot.js's own resolveSeed(setup): random-vs-fixed is a DOM-layer decision, this stays
 * pure). Throws a clear, user-facing message for anything that would make competitionWorker.js's
 * own guards throw anyway — an empty name or an empty world list — so the config screen can catch
 * it before ever spinning up a Worker.
 * Also rejects two entrants sharing a name (post-trim): elo.js's RatingsTable is keyed by name
 * (D1/D2), so a same-name pairing would collide both entrants' Elo into one entry instead of two
 * (elo.js's own applyResult throws on exactly this, as a backstop) — catching it here means the
 * config screen can reject it before ever spinning up a Worker, instead of running a full duel
 * only to throw when the results view folds the rows through eloFromRows.
 * `archetype` (D3) is coerced the same defensive way createAiController itself resolves it: a
 * string that names a real ARCHETYPES key survives, anything else (missing, blank, unknown) becomes
 * `null` — "no override" — rather than being trusted verbatim and handed to the worker.
 * @param {{ entrantA: {name: string, strategy?: string, archetype?: string|null},
 *   entrantB: {name: string, strategy?: string, archetype?: string|null},
 *   difficulty: string, worlds: string[], seeds: number, seedBase: number, matchTimeLimit?: number }} cfg
 */
export function buildJob({ entrantA, entrantB, difficulty, worlds, seeds, seedBase, matchTimeLimit } = {}) {
  if (!entrantA || !entrantA.name || !entrantA.name.trim()) throw new Error("Entrant A needs a name");
  if (!entrantB || !entrantB.name || !entrantB.name.trim()) throw new Error("Entrant B needs a name");
  if (entrantA.name.trim() === entrantB.name.trim()) throw new Error("Entrant A and Entrant B need different names");
  if (!Array.isArray(worlds) || worlds.length === 0) throw new Error("Pick at least one world");
  // Object.hasOwn, not a truthy `ARCHETYPES[a]` bracket-access: a plain object's inherited keys
  // (e.g. "constructor") or the specially-handled "__proto__" accessor would otherwise read back
  // as "known" even though they name no real archetype — this function's own doc comment above
  // promises unknown input becomes `null`, and a hostile-looking key is exactly "unknown".
  const knownArchetype = a => (typeof a === "string" && Object.hasOwn(ARCHETYPES, a)) ? a : null;
  const job = {
    entrantA: { name: entrantA.name.trim(), strategy: entrantA.strategy || "default", archetype: knownArchetype(entrantA.archetype) },
    entrantB: { name: entrantB.name.trim(), strategy: entrantB.strategy || "default", archetype: knownArchetype(entrantB.archetype) },
    difficulty: difficulty || "medium",
    worlds: [...worlds],
    seeds: Math.max(1, Math.floor(seeds) || 1),
    seedBase: (Number(seedBase) || 0) >>> 0,
  };
  if (matchTimeLimit) job.matchTimeLimit = matchTimeLimit;
  return job;
}

/**
 * Resolve one entrant PICKER's current state (as compConfig.entrantA/B below holds it) against the
 * live ledger, into the plain `{name, strategy, archetype, faction}` shape buildJob/the roster
 * screen both want — the "roster-vs-adhoc entrant resolution" this stage's key UX decision hinges
 * on. `pick.mode === "roster"` reads the CURRENT roster entry back by name (never a stale copy —
 * if the Roster screen edited it, this always sees the latest), and throws a clear error if that
 * name is no longer on the roster (removed, most likely, between picking it and running the duel).
 * Anything else — including a missing/unrecognised mode — resolves as a fresh DRAFT (`isNew: true`)
 * from whatever fields the pick carries, trimmed/defaulted the same way addRosterEntry itself
 * would coerce them; the caller (startDuel) is the one that actually commits a draft to the roster,
 * and only once the duel is genuinely about to run (see this module's header).
 * @param {{ mode?: string, rosterName?: string, name?: string, strategy?: string, archetype?: string|null, faction?: string }} pick
 * @param {{ roster: Array<{name: string, strategy: string, archetype: string|null, faction: string}> }} ledger
 * @returns {{ name: string, strategy: string, archetype: string|null, faction: string, isNew: boolean }}
 */
export function resolveEntrantPick(pick, ledger) {
  if (pick && pick.mode === "roster") {
    const found = ((ledger && ledger.roster) || []).find(r => r.name === pick.rosterName);
    if (!found) throw new Error('Pick an entrant from the roster, or switch to "New Entrant"');
    return { name: found.name, strategy: found.strategy, archetype: found.archetype, faction: found.faction, isNew: false };
  }
  return {
    name: ((pick && pick.name) || "").trim(),
    strategy: (pick && pick.strategy) || "default",
    archetype: (pick && pick.archetype) || null,
    faction: (pick && pick.faction) || "neutral",
    isNew: true,
  };
}

/**
 * One entrant's rating out of a SINGLE bracket's ratings table (`ledger.ratingsByDifficulty
 * [difficulty]`, or undefined for a bracket nobody's played yet) — elo.js's own INITIAL_RATING at
 * 0 games when the entrant hasn't played this bracket, the same "hasn't played yet" reading
 * competitionLedger.js's own standingsFor gives (Object.hasOwn, not a truthy check — a plain
 * object inherits from Object.prototype, so an entrant legitimately named e.g. "toString" would
 * otherwise read back an inherited function as a bogus "rating"). Used by the results view to show
 * a real before/after delta straight from the ledger, replacing Phase 1's session-only eloFromRows
 * read (still exported below, unchanged, for whatever still wants a from-scratch session number).
 * @param {Object.<string, {rating: number, games: number}>|undefined} table
 * @param {string} name
 * @returns {{rating: number, games: number}}
 */
export function ratingLookup(table, name) {
  return (table && Object.hasOwn(table, name)) ? table[name] : { rating: INITIAL_RATING, games: 0 };
}

/**
 * True once `name` has a rating entry in ANY difficulty bracket of `ledger` — the Roster screen's
 * own signal for "removing this would drop something with real history off the Standings screen",
 * used to word its confirm dialog (removeRosterEntry itself never deletes the underlying
 * ratingsByDifficulty/history — see that function's own header — so this is purely about whether
 * the entry disappearing from the roster would also make it disappear from view).
 * @param {{ ratingsByDifficulty: Object.<string, object> }} ledger
 * @param {string} name
 * @returns {boolean}
 */
export function hasRatingHistory(ledger, name) {
  const tables = (ledger && ledger.ratingsByDifficulty) || {};
  return Object.keys(tables).some(d => Object.hasOwn(tables[d], name));
}

// key -> its own STRATEGY_OPTIONS label (setup.js's own table, reused rather than a second import
// of engine/aiStrategy.js's raw STRATEGIES here) — falls back to the first entry ("Adaptive",
// STRATEGIES.default's own label) for a key that isn't in the table, the same fallback strategyFor
// itself gives an absent/unknown strategy.
export function strategyLabel(key) {
  return (STRATEGY_OPTIONS.find(o => o.mult === key) || STRATEGY_OPTIONS[0]).label;
}

/**
 * One roster entry -> its display row: strategy/archetype/faction KEYS resolved to their own
 * canonical display names (never re-deriving or re-wording them), so the Roster screen's table and
 * an entrant picker's roster `<select>` can both render straight off this. A null/unrecognised
 * archetype reads as "World default" — the same meaning ARCHETYPE_OPTIONS' own null entry carries.
 * @param {{ name: string, strategy: string, archetype: string|null, faction: string }} entry
 */
export function shapeRosterRow(entry) {
  return {
    name: entry.name,
    strategy: strategyLabel(entry.strategy),
    archetype: (typeof entry.archetype === "string" && Object.hasOwn(ARCHETYPES, entry.archetype))
      ? ARCHETYPES[entry.archetype].name : "World default",
    faction: (FACTIONS[entry.faction] || FACTIONS.neutral).short,
  };
}

/**
 * competitionLedger.js's own standingsFor(ledger, difficulty) rows -> the Standings table's display
 * rows. Pure FORMATTING only — rating rounded, W-L-D folded into one string, avgMargin fixed to one
 * decimal — never recomputing wins/losses/draws/avgMargin/provisional themselves (those are
 * standingsFor's own job; see this module's header and that function's own doc comment for exactly
 * which fields it already derives). Preserves standingsFor's own sort order (rating descending, tie
 * -> name) verbatim — this never re-sorts.
 *
 * `human` rides through unformatted because the Standings screen is the ONE place a human rating is
 * shown alongside the AI ratings it is being compared against (D4): the table has to mark which row
 * is the person, and state the seat disclosure whenever it contains one. A row without the flag
 * reads as false rather than undefined, so a caller's "does this table contain a human" test is a
 * plain boolean check.
 * @param {Array<{name: string, rating: number, games: number, wins: number, losses: number, draws: number, avgMargin: number, provisional: boolean, human?: boolean}>} standings
 */
export function shapeStandingsTable(standings) {
  return standings.map(s => ({
    name: s.name,
    rating: Math.round(s.rating),
    games: s.games,
    record: `${s.wins}-${s.losses}-${s.draws}`,
    avgMargin: s.avgMargin.toFixed(1),
    provisional: s.provisional,
    human: s.human === true,
  }));
}

// Total matches a job implies: every world x every seed replicate, both directions (side-swapped
// — see competitionWorker.js's own header). Shared by the config view's pre-run estimate and the
// progress view's initial "0 of N" (before the worker's own first progress message arrives).
export function matchCount(job) {
  return job.worlds.length * job.seeds * 2;
}

// One match's seed, reusing tools/duelCore.js's own duelSeed rather than re-deriving the hash —
// same inputs, same seed, by construction. (duelSeed sorts the pair's names into the hash, so this
// is deliberately independent of which entrant plays which owner for this replicate — see
// competitionWorker.js's header on why both directions of one (world, rep) share one map.)
export function matchSeedFor(job, world, rep) {
  return duelSeed(job.seedBase, world, job.difficulty, job.entrantA.name, job.entrantB.name, rep);
}

// Worker-shaped rows (competitionWorker.js's `runCompetitionJob` rows, tagged with `direction`) ->
// the results table's display rows. Never mutates `rows`. Entrant names land in plain strings
// here, not markup — the DOM layer renders every cell via textContent, never innerHTML, so a
// duel entrant's free-typed name can never be interpreted as markup.
export function shapeResultsTable(rows) {
  return rows.map(r => ({
    world: r.world,
    seed: r.seed,
    side: r.direction === "aAsAi" ? `${r.aName} as AI` : `${r.bName} as AI`,
    swap: !!r.swapAsym,
    winner: r.winner === "draw" ? "Draw" : r.winner === "a" ? r.aName : r.bName,
    reason: r.winReason || "-",
    time: r.time,
    aScore: r.aScore,
    bScore: r.bScore,
    margin: r.margin,
  }));
}

// Each match -> an elo.js MatchRow (score from A's point of view), the same eloRowOf shape
// tools/ailab.js's own printed Elo column already uses (D1: one shared meaning for "Elo"
// everywhere). `rows` must already be in the order they were RECEIVED (the worker's own
// completion order) — this folds them through applySeries in that exact order, starting a fresh
// ratings table at elo.js's INITIAL_RATING (D6: Elo is order-dependent; canonical order here is
// simply "the order the caller already has them in").
const eloRowOf = r => ({ aName: r.aName, bName: r.bName, score: r.winner === "a" ? 1 : r.winner === "draw" ? 0.5 : 0 });
export function eloFromRows(rows) {
  return applySeries({}, rows.map(eloRowOf));
}

/* ============================================================
   TOURNAMENTS (docs/competitions-and-elo.md Phase 3) — the pure half of the Tournament tab: the
   up-front cost estimate, the job competitionWorker.js's tournament kind receives, the knockout's
   own seeding, and the standings/bracket shaping the results view renders. Same split as
   everything above (observer.js's observerStats vs observerPanel.js): the DOM layer below decides
   only how these tables LOOK, never what they contain.

   Nothing here re-derives a schedule. pairing.js owns "how many pairings, in how many rounds"
   (tournamentRoundPlan/swissRoundCount) and "what a finished set of pairings tallies to"
   (tallyStandings); this module multiplies that by the worlds/seeds/side-swap the player picked
   and formats the result.
   ============================================================ */

// The format picker's options, in optionGroup's own { label, mult, note } shape — one entry per
// schedule pairing.js can actually run, with the note stating the cost rule the estimate below
// then applies, so the picker itself explains why one format is cheaper than another.
export const TOURNAMENT_FORMAT_OPTIONS = [
  { label: "Round-robin", mult: "round-robin", note: "every pair once — n × (n−1) / 2 pairings" },
  { label: "Swiss", mult: "swiss", note: "rounds paired by standing — ranks a big field cheaply" },
  { label: "Knockout", mult: "knockout", note: "single elimination — always n − 1 pairings" },
];

// Rough wall clock for ONE match, used only to price a run before it starts.
// docs/competitions-and-elo.md's own measured table (§1): ~1.0 s for a match resolved by
// elimination, ~1.8 s worst case for one that runs the full 40-sim-minute clock. 1.5 s is a
// documented average of those two measurements, deliberately nearer the worst case (a tournament
// full of evenly-matched entrants is exactly the population that goes the distance) — not an
// invented constant, and not a promise: the UI always renders it as "≈".
export const SECONDS_PER_MATCH = 1.5;

/**
 * How many PAIRINGS a format schedules over a field of `entrants` — pairing.js's own plan, summed.
 * Round-robin is n×(n−1)/2, Swiss is roundCount × floor(n/2) (an odd field's bye is not a pairing),
 * and a knockout is ALWAYS n−1 however many byes round 1 hands out.
 * @param {{ format: string, entrants: number, rounds?: number }} cfg
 * @returns {number}
 * @throws {Error} on an unknown format or a field smaller than 2 — pairing.js's own guards.
 */
export function tournamentPairingCount({ format, entrants, rounds } = {}) {
  // `rounds` is a Swiss-only override; passing it for the other two would imply it means something
  // there, and it doesn't (see tournamentRoundPlan's own doc comment).
  const plan = tournamentRoundPlan(format, entrants, format === "swiss" ? rounds : undefined);
  return plan.reduce((sum, r) => sum + r.pairings, 0);
}

// Seconds -> a display string, rounded at the granularity a person actually plans around: seconds
// below a minute, whole minutes above it (nobody waits "94 seconds", they wait "about 2 minutes").
function estimateTimeText(seconds) {
  return seconds < 60 ? `${Math.round(seconds)} s` : `${Math.max(1, Math.round(seconds / 60))} min`;
}

/**
 * The whole up-front budget for a tournament — the Phase 3 brief's own "≈ 32 matches, ≈ 1 min",
 * shown BEFORE Start Tournament is clickable. A MATCH is one (world, seed, side) combination
 * within a pairing, so the count is pairings × worlds × seeds × 2 — the same "both directions,
 * side-swapped" rule matchCount applies to a single duel.
 * @param {{ format: string, entrants: number, worlds: string[]|number, seeds: number, rounds?: number }} cfg
 * @returns {{ pairings: number, matches: number, seconds: number, timeText: string, text: string }}
 */
export function tournamentEstimate({ format, entrants, worlds, seeds, rounds } = {}) {
  const pairings = tournamentPairingCount({ format, entrants, rounds });
  const worldCount = Array.isArray(worlds) ? worlds.length : Math.max(0, Math.floor(Number(worlds)) || 0);
  const matches = pairings * worldCount * Math.max(1, Math.floor(seeds) || 1) * 2;
  const seconds = matches * SECONDS_PER_MATCH;
  const timeText = estimateTimeText(seconds);
  return { pairings, matches, seconds, timeText, text: `≈ ${matches} matches · ≈ ${timeText}` };
}

// A field entrant, coerced exactly the way buildJob coerces a duel entrant (trimmed name, defaulted
// strategy, archetype validated against the real ARCHETYPES keys with Object.hasOwn rather than a
// truthy bracket-access). Deliberately carries NO difficulty: difficulty is ONE shared dial for the
// whole tournament (D2), pinned identical for every entrant in every pairing, exactly as a Quick
// Duel already pins it for both sides — a per-entrant difficulty would make the bracket meaningless.
function tournamentEntrant(raw) {
  const name = ((raw && raw.name) || "").trim();
  if (!name) throw new Error("Every tournament entrant needs a name");
  const archetype = raw && raw.archetype;
  return {
    name,
    strategy: (raw && raw.strategy) || "default",
    archetype: (typeof archetype === "string" && Object.hasOwn(ARCHETYPES, archetype)) ? archetype : null,
  };
}

/**
 * Shape a tournament config into exactly the job message competitionWorker.js's tournament kind
 * expects. Deterministic (an unset seed is resolved by the caller, same as buildJob), and it throws
 * a clear, user-facing message for anything the worker's own guards would reject anyway, so the
 * config screen can catch it before spinning a Worker up. The FIELD ORDER IS MEANINGFUL — it is the
 * knockout's seeding (see seedFieldByRating below), so this never sorts it.
 * @param {{ format: string, field: object[], difficulty: string, worlds: string[], seeds: number,
 *   seedBase: number, rounds?: number }} cfg
 */
export function buildTournamentJob({ format, field, difficulty, worlds, seeds, seedBase, rounds } = {}) {
  if (!TOURNAMENT_FORMAT_OPTIONS.some(o => o.mult === format)) throw new Error(`Unknown tournament format "${format}"`);
  const list = Array.isArray(field) ? field : [];
  if (list.length < 2) throw new Error("Pick at least 2 entrants for a tournament");
  const entrants = list.map(tournamentEntrant);
  const seen = new Set();
  for (const e of entrants) {
    // Same reasoning as buildJob's own same-name guard: elo.js's RatingsTable is keyed by name, so
    // one name twice in a field would collide two entrants' ratings into one entry.
    if (seen.has(e.name)) throw new Error(`"${e.name}" is in the field twice — every entrant needs a different name`);
    seen.add(e.name);
  }
  if (!Array.isArray(worlds) || worlds.length === 0) throw new Error("Pick at least one world");
  const job = {
    kind: "tournament",
    format,
    field: entrants,
    difficulty: difficulty || "medium",
    worlds: [...worlds],
    seeds: Math.max(1, Math.floor(seeds) || 1),
    seedBase: (Number(seedBase) || 0) >>> 0,
  };
  // Swiss is the only format with a round count to override; the worker defaults an absent one to
  // pairing.js's swissRoundCount, so leaving it off is meaningful, not lossy.
  if (format === "swiss" && rounds > 0) job.rounds = Math.floor(rounds);
  return job;
}

/**
 * Order a knockout field strongest-first for pairing.js's buildKnockoutBracket, which consumes a
 * seeding and deliberately never invents one (its own header: "it consumes an order, it does not
 * invent one" — that is what keeps it decoupled from the ledger). Rating descending off THIS
 * bracket's own ratings table, falling back to name for anyone unrated, so the seeding is total and
 * reproducible rather than dependent on the order boxes happened to be ticked in.
 * @param {{name: string}[]} entrants
 * @param {Object.<string, {rating: number, games: number}>|undefined} table   one difficulty bracket's table
 * @returns {object[]} a new array; the caller's own is untouched.
 */
export function seedFieldByRating(entrants, table) {
  return [...entrants].sort((a, b) =>
    ratingLookup(table, b.name).rating - ratingLookup(table, a.name).rating
    || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * One progress message -> the line the progress view shows. Real granularity, per the Phase 3
 * brief: a multi-round format names the round AND the pairing within it; a round-robin is one flat
 * round (roundRobinPairs' own shape), so naming "round 1 of 1" would be noise. The match counter
 * rides along either way, because that is what the bar is filling with.
 * @param {{ round: number, roundTotal: number, pairing: number, pairingTotal: number, completed: number, total: number }} p
 * @returns {string}
 */
export function tournamentProgressLabel({ round, roundTotal, pairing, pairingTotal, completed, total } = {}) {
  const head = roundTotal > 1
    ? `Round ${round} of ${roundTotal} · pairing ${pairing} of ${pairingTotal}`
    : `Pairing ${pairing} of ${pairingTotal}`;
  return `${head} — ${completed} of ${total} matches`;
}

/**
 * Standings rows for a set of FINISHED pairings — pairing.js's own tallyStandings, which is the
 * same arithmetic buildSwissBracket accumulates internally (and, for a bye, the same "adds to
 * nobody's wins or losses" rule). Used for the LIVE table as each pairing lands and, for a
 * round-robin, for the final one too; a finished Swiss bracket ships its own ranked standings and
 * those are used verbatim instead of being recomputed here.
 * @param {string[]} names        the whole field, so an entrant that hasn't played yet still shows.
 * @param {{aName: string, bName: string, aWins: number, bWins: number, draws: number}[]} pairings
 * @param {string[]} [byeNames]
 */
export function tournamentStandingsRows(names, pairings, byeNames) {
  return tallyStandings(names, pairings, byeNames);
}

/**
 * Tournament standings rows -> display rows. Pure FORMATTING, exactly like shapeStandingsTable's
 * own contract (W-L-D folded into one string, nothing recomputed, the input order — which IS the
 * ranking — preserved). `byes` rides through for the Swiss table's own extra column.
 * @param {{name: string, wins: number, losses: number, draws: number, byes: number}[]} rows
 */
export function shapeTournamentStandings(rows) {
  return rows.map(r => ({
    name: r.name,
    record: `${r.wins}-${r.losses}-${r.draws}`,
    wins: r.wins, losses: r.losses, draws: r.draws,
    byes: r.byes || 0,
  }));
}

// The closing rounds get their real names, counting back from the final; anything earlier is just
// "Round N". Indexed by DISTANCE from the last round, so a 2-entrant bracket's single round is the
// Final and a 16-entrant bracket's first round isn't miscalled one.
const KNOCKOUT_ROUND_TITLES = ["Final", "Semifinals", "Quarterfinals"];

/**
 * A finished knockout bracket (pairing.js's own KnockoutBracket, with or without the per-match rows
 * — competitionWorker.js strips those before posting) -> the bracket VIEW: one column per round,
 * each match naming both entrants (or a bye), which of them advanced, and the pairing's aggregate
 * score. Names only, no entrant objects: the DOM layer renders every cell via textContent.
 * @param {{ rounds: {round: number, matches: object[]}[], champion: {name: string} }} bracket
 */
export function shapeBracketView(bracket) {
  const rounds = (bracket && bracket.rounds) || [];
  return {
    champion: (bracket && bracket.champion && bracket.champion.name) || null,
    rounds: rounds.map(r => ({
      round: r.round,
      title: KNOCKOUT_ROUND_TITLES[rounds.length - r.round] || `Round ${r.round}`,
      matches: r.matches.map(m => {
        const a = m.a ? m.a.name : null;
        const b = m.b ? m.b.name : null;
        const winner = m.winner ? m.winner.name : null;
        const res = m.result;
        return {
          round: m.round, a, b, bye: !!m.bye, winner,
          aWon: winner != null && winner === a,
          bWon: b != null && winner === b,
          // A bye is not a scoreline; a played pairing shows its aggregate from A's side, with the
          // draw count appended only when there actually were draws (they're near-impossible here —
          // D7 — so a permanent "-0" would be noise).
          score: m.bye ? "bye" : res ? (res.draws ? `${res.aWins}-${res.bWins}-${res.draws}` : `${res.aWins}-${res.bWins}`) : "",
        };
      }),
    })),
  };
}

/* ============================================================
   THE GAUNTLET (docs/competitions-and-elo.md Phase 4) — the pure half of the human-inclusive
   format: the config the player builds -> the start opts competitionLedger.js's startGauntlet
   consumes, the fixture list the in-progress screen renders, next-fixture resolution, the live
   match's own outcome mapping, and the completion summary. Same split as everything above.

   ONE LIVE MATCH PER OPPONENT, and that is the format's defining decision, not an economy measure.
   An AI-vs-AI pairing is worlds x seeds x 2 sides of SIMULATED matches — a few seconds of compute
   — but a person cannot play 40 real matches. One live match each is what makes a human-inclusive
   format playable at all, which is why Gauntlet is the one that ships first (the doc's own Phase 4
   note). Everything below prices, schedules and reports a run on exactly that basis: `matches`
   here is a count of REAL GAMES A PERSON SITS AND PLAYS, so it is measured in wall-clock hours,
   never in the ~1.5 s/match SECONDS_PER_MATCH the AI-vs-AI estimates above use.

   D4 runs through all of it: the human is always owner "player", so a human pairing cannot be
   side-swapped, the seat edge tools/selfplay.js measures runs against the human, and that is
   DISCLOSED (SEAT_DISCLOSURE below, carried by shapeGauntletSummary itself so a standing and the
   caveat that qualifies it can't be rendered apart) rather than papered over with a rating fudge.
   ============================================================ */

// D4's disclosure, in one plain sentence-set, stated wherever the human's rating or standing shows
// — the config screen, the in-progress standing, the completion summary, the game-over screen after
// a live match, and the Standings screen whenever the bracket being shown contains the human (which
// is the one place the rating is read AGAINST the AI ratings rather than on its own, and where the
// completion view's "View Standings" button lands). Deliberately a plain string constant, not
// markup and not a tooltip: the Phase 4 brief's own wording is "plain and factual, not buried in a
// tooltip", and a constant is also the only shape a Node test can assert the CONTENT of.
export const SEAT_DISCLOSURE =
  'Seat note: you always play the "player" seat, so a gauntlet pairing can never be side-swapped ' +
  'the way an AI-vs-AI one is. The known edge runs the other way — the "ai" seat reads state the ' +
  '"player" seat has already changed on ~13% of think cycles, always in the "ai" seat\'s favour. ' +
  "Your rating is not adjusted for it (an underivable correction would be worse than a disclosed " +
  "one); the map's own asymmetric halves do still alternate from match to match.";

// Seconds -> the granularity a person planning an evening actually thinks in. Minutes below an
// hour, hours-and-minutes above it — deliberately NOT estimateTimeText above, which prices a
// background SIMULATION in seconds-to-minutes; this prices real play in minutes-to-hours.
export function playTimeText(seconds) {
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/**
 * What a gauntlet will actually cost the player, shown BEFORE Start is clickable: one live match
 * per opponent, and the wall-clock that implies at the pinned match length. `seconds` is the
 * worst case — every match running its full clock — hence "up to" in the text; a match settled by
 * elimination ends sooner.
 * @param {{ opponents: number, matchTimeLimit?: number }} cfg
 * @returns {{ matches: number, perMatch: number, seconds: number, timeText: string, text: string }}
 */
export function gauntletEstimate({ opponents, matchTimeLimit } = {}) {
  const matches = Math.max(0, Math.floor(Number(opponents)) || 0);
  const perMatch = Number(matchTimeLimit) > 0 ? Math.floor(Number(matchTimeLimit)) : GAUNTLET_DEFAULT_MATCH_SECONDS;
  const seconds = matches * perMatch;
  return {
    matches, perMatch, seconds, timeText: playTimeText(seconds),
    text: `${matches} live match${matches === 1 ? "" : "es"} — one per opponent — up to about `
      + `${playTimeText(seconds)} of real play (${playTimeText(perMatch)} each)`,
  };
}

/**
 * Shape the Gauntlet config screen's state into exactly the opts competitionLedger.js's
 * startGauntlet consumes. Deterministic — an unset seed is resolved by the CALLER before this runs,
 * the same division buildJob/buildTournamentJob already hold to — and it throws the same
 * user-facing messages startGauntlet's own guards would, so the config screen can refuse a bad
 * field without a half-built run ever existing.
 * @param {{ field: string[], difficulty?: string, matchTimeLimit?: number, worlds: string[],
 *   seedBase?: number, humanName?: string }} cfg
 * @returns {{ field: string[], difficulty: string, matchTimeLimit: number, worlds: string[], seedBase: number }}
 */
export function buildGauntletStart({ field, difficulty, matchTimeLimit, worlds, seedBase, humanName } = {}) {
  const names = (Array.isArray(field) ? field : []).map(n => (typeof n === "string" ? n.trim() : "")).filter(Boolean);
  if (names.length === 0) throw new Error("Pick at least one opponent for the field");
  const seen = new Set();
  for (const name of names) {
    // Same reasoning as buildJob's own same-name guard: the ladder is keyed by name, and the
    // gauntlet plays each opponent EXACTLY once, so one name twice is not a field this can run.
    if (seen.has(name)) throw new Error(`"${name}" is in the field twice — each opponent is played exactly once`);
    seen.add(name);
    if (humanName && name === humanName) throw new Error("Leave yourself out of the field — you play everyone else");
  }
  if (!Array.isArray(worlds) || worlds.length === 0) throw new Error("Pick at least one world");
  return {
    field: names,
    difficulty: difficulty || "medium",
    // Quick (20 min) is the default for a real reason worth restating at the seam that applies it:
    // five opponents at Standard is over three hours of PLAY. GAUNTLET_DEFAULT_MATCH_SECONDS is
    // competitionLedger.js's own constant, so the picker, this builder and the sanitizer's fallback
    // are all one number.
    matchTimeLimit: Number(matchTimeLimit) > 0 ? Math.floor(Number(matchTimeLimit)) : GAUNTLET_DEFAULT_MATCH_SECONDS,
    worlds: [...worlds],
    seedBase: (Number(seedBase) || 0) >>> 0,
  };
}

// A resolved fixture's status, from the run's own record: a played one reads off its result (a
// forfeit is a loss, but a DISTINGUISHABLE one — the screen shows it as what it was), an unplayed
// one is either the next match or still waiting behind it.
const GAUNTLET_STATUS_LABEL = {
  won: "Won", lost: "Lost", drawn: "Drawn", forfeit: "Forfeited", next: "Next up", pending: "Pending",
};

/**
 * The gauntlet's whole fixture list, shaped for display — one row per opponent, in play order,
 * each carrying its own state. Never re-derives a schedule (competitionLedger.js owns that, once,
 * at start — D6) and never re-decides an outcome: this reads `results` and `nextIndex` back.
 * @param {{ gauntlet: object|null }} ledger
 * @returns {Array<{index: number, number: number, opponent: string, world: string, worldName: string,
 *   swapAsym: boolean, played: boolean, current: boolean, status: string, statusLabel: string,
 *   margin: number|null}>}
 */
export function shapeGauntletFixtures(ledger) {
  const g = ledger && ledger.gauntlet;
  if (!g) return [];
  return g.schedule.map((fixture, i) => {
    const result = g.results[i] || null;
    const status = result
      ? (result.forfeit ? "forfeit" : result.winner === "human" ? "won" : result.winner === "opponent" ? "lost" : "drawn")
      : (i === g.nextIndex ? "next" : "pending");
    return {
      index: i, number: i + 1,
      opponent: fixture.opponent,
      world: fixture.world, worldName: planetName(fixture.world),
      swapAsym: !!fixture.swapAsym,
      played: !!result, current: status === "next",
      status, statusLabel: GAUNTLET_STATUS_LABEL[status],
      margin: result ? result.margin : null,
    };
  });
}

/**
 * The next unplayed fixture — competitionLedger.js's own currentGauntletFixture (which is what a
 * live match is actually booted from: the SCHEDULED world and seed, never a fresh random one)
 * plus the two display fields the screen and the game-over view both need. Null when there is no
 * gauntlet, or when every opponent has been faced.
 * @param {object} ledger
 */
export function nextGauntletFixture(ledger) {
  const fixture = currentGauntletFixture(ledger);
  if (!fixture) return null;
  const worldName = planetName(fixture.world);
  return {
    ...fixture,
    number: fixture.index + 1,
    worldName,
    label: `Match ${fixture.index + 1} of ${fixture.total} — you vs ${fixture.opponent} on ${worldName}`,
  };
}

/**
 * A finished live match's terminal state -> the result recordGauntletMatch takes, stated in the
 * GAUNTLET's own vocabulary. The mapping is deliberately made HERE and only here: the human is
 * always owner "player" (D4), so "the player seat won" is "the human won" — but recordGauntletMatch
 * refuses owner ids outright precisely so that equivalence is written down once, in a tested pure
 * function, rather than assumed at each call site.
 *
 * `margin` is engine/victory.js's own playerScore difference, human-relative — the same
 * aName-relative convention tools/duelCore.js's runDuelMatch row already uses, so a human row's
 * margin means exactly what an AI row's does.
 * @param {{ winner: string|null, winReason: string|null, time: number }} state  a finished game state.
 * @returns {{ winner: "human"|"opponent"|"draw", margin: number, time: number|null, winReason: string|null }}
 */
export function humanMatchOutcome(state) {
  const human = playerScore(state, "player");
  const opponent = playerScore(state, "ai");
  return {
    winner: state.winner === "player" ? "human" : state.winner === "ai" ? "opponent" : "draw",
    margin: +(human - opponent).toFixed(1),
    time: Number.isFinite(state.time) ? +state.time.toFixed(1) : null,
    winReason: typeof state.winReason === "string" ? state.winReason : null,
  };
}

/**
 * What each gauntlet match did to the HUMAN's rating, per fixture. Not stored anywhere — a
 * GauntletResult carries the outcome, not a rating snapshot — so it is REPLAYED here: every history
 * entry in the gauntlet's own bracket, in the order the ledger recorded it, folded through the same
 * elo.js applyResult competitionLedger.js itself applied (D1: one rating implementation), reading
 * the human's entry off before and after each row that belongs to a fixture of THIS run.
 *
 * Replaying the whole bracket rather than just this run's rows is the point: a rating change is a
 * function of what both sides were rated going in, so a gauntlet interleaved with duels or a
 * tournament must see those too, or its numbers would silently disagree with the Standings screen.
 * Rows are matched to fixtures by (world, seed, opponent) — the fixture's own identity, recorded on
 * every human row — never by position, which a later run against the same field would break.
 * @param {object} ledger
 * @returns {Array<{index: number, opponent: string, before: {rating: number, games: number},
 *   after: {rating: number, games: number}, change: number}>}
 */
export function gauntletLadderTrail(ledger) {
  const g = ledger && ledger.gauntlet;
  if (!g) return [];
  const wanted = new Map();
  g.schedule.forEach((f, i) => { if (i < g.results.length) wanted.set(`${f.world}|${f.seed}|${f.opponent}`, i); });

  const ratings = {};
  const trail = [];
  for (const entry of ledger.history || []) {
    if (entry.difficulty !== g.difficulty) continue;   // D2: a rating only ever moves inside its own bracket
    for (const row of entry.rows) {
      const mine = row.human === true && row.aName === g.humanName
        ? wanted.get(`${row.world}|${row.seed}|${row.bName}`) : undefined;
      // Captured BEFORE the fold: applyResult replaces the table's entry object rather than
      // mutating it, so this reference stays the genuine pre-match rating afterwards.
      const before = mine === undefined ? null : ratingLookup(ratings, g.humanName);
      applyResult(ratings, row.aName, row.bName, row.winner === "a" ? 1 : row.winner === "draw" ? 0.5 : 0);
      if (mine === undefined) continue;
      const after = ratingLookup(ratings, g.humanName);
      trail.push({
        index: mine, opponent: row.bName,
        before: { ...before }, after: { ...after },
        // Rounded on both ends, exactly like the results view's own eloCard, so the change shown
        // is the change between the two numbers actually on screen.
        change: Math.round(after.rating) - Math.round(before.rating),
      });
    }
  }
  return trail.sort((a, b) => a.index - b.index);
}

/**
 * The whole run, shaped for the in-progress standing AND the final one — they are the same table,
 * just at different points (a resumed gauntlet is exactly a half-finished one, so giving them two
 * shapes would mean two things to keep in step). Counts come from competitionLedger.js's own
 * gauntletProgress, the rating from the pinned bracket's table, the per-fixture change from
 * gauntletLadderTrail above; nothing here re-derives an outcome. Null when there's no gauntlet.
 * @param {object} ledger
 */
export function shapeGauntletSummary(ledger) {
  const progress = gauntletProgress(ledger);
  if (!progress) return null;
  const trail = new Map(gauntletLadderTrail(ledger).map(t => [t.index, t]));
  const rating = ratingLookup((ledger.ratingsByDifficulty || {})[progress.difficulty], progress.humanName);
  const rows = shapeGauntletFixtures(ledger).map(row => {
    const moved = trail.get(row.index) || null;
    return { ...row, change: moved ? moved.change : null, ratingAfter: moved ? Math.round(moved.after.rating) : null };
  });
  return {
    humanName: progress.humanName,
    difficulty: progress.difficulty,
    matchTimeLimit: progress.matchTimeLimit,
    total: progress.total, played: progress.played, remaining: progress.remaining,
    wins: progress.wins, losses: progress.losses, draws: progress.draws, forfeits: progress.forfeits,
    complete: progress.complete,
    record: `${progress.wins}-${progress.losses}-${progress.draws}`,
    rating: { rating: Math.round(rating.rating), games: rating.games, provisional: rating.games < PROVISIONAL_GAMES },
    netChange: rows.reduce((sum, r) => sum + (r.change || 0), 0),
    rows,
    // The disclosure travels WITH the standing (D4): a caller can render one without the other only
    // by deliberately dropping a field, rather than by simply forgetting a separate constant exists.
    disclosure: SEAT_DISCLOSURE,
  };
}

/* ============================================================
   WATCHING A MATCH LIVE (docs/competitions-and-elo.md Phase 5) — the pure half: the config one
   watched match is booted from, the exhibition framing, and the game-over block it ends on.

   THE DECISION THIS SECTION MAKES, DELIBERATELY: A WATCHED MATCH IS EXHIBITION ONLY. It does not
   move any rating, and it writes nothing to the ledger — not a rating, not a history row, not even
   a roster entry for an entrant drafted purely to watch. Why, stated once so nobody has to
   re-litigate it at the button:

     • Every rated result in this system is a PAIRING, not a match. tools/ailab.js's runSwappedDuel,
       competitionWorker.js's own loop, and every tournament pairing all run each (world, seed)
       replicate BOTH WAYS and alternate the map's asym halves by replicate parity, precisely
       because a single unswapped match is confounded by seat and map asymmetry — and the seat edge
       here is measured, real and one-directional (tools/selfplay.js's own header: the "ai" seat
       reads state the "player" seat already mutated on ~13% of think cycles). A watched match is
       exactly one match, one direction, one map half.
     • So rating it would put a differently-earned number into the same bracketed table (D2) as
       numbers earned the careful way, and nothing on the Standings screen could tell them apart.
     • The cheap-looking alternative — "watch it, and count it, it's still a real match" — is how a
       ladder quietly becomes meaningless.

   The other half of being deliberate is SAYING SO, on screen, where the button is and again when
   the match ends — the same discipline Phase 1 held to when its Elo wasn't saved yet.

   Watching is therefore free in both directions: run the same pairing for real afterwards and the
   rated result is unaffected by how many times you watched it.
   ============================================================ */

// The disclosure, in one plain sentence-set, shown next to the Watch button and again on the
// watched match's own game-over screen. A constant, not markup and not a tooltip — the same
// reasoning SEAT_DISCLOSURE gives above, and the only shape a Node test can assert the CONTENT of.
export const EXHIBITION_NOTE =
  "Exhibition only — a watched match does NOT change any rating, and records nothing on the "
  + "ladder. It is a single match in one direction on one map half; every rated result here is a "
  + "side-swapped, multi-seed pairing, so counting one watched game would mix a differently-earned "
  + "number into the same bracket. Run the duel for real to move the ladder.";

/**
 * One match out of a duel job -> exactly the config boot.js's startSpectatedMatch feeds
 * tools/selfplay.js's createSelfPlayState. The whole point is that this is the SAME configuration
 * competitionWorker.js would have simulated for that (world, replicate): the same duelSeed-derived
 * seed (via matchSeedFor above, never a fresh roll), the same replicate-parity swapAsym, the same
 * ONE pinnedDuelDials set on BOTH seats (the duel's whole fairness point), and each entrant's own
 * strategy/archetype riding its own seat.
 *
 * SEATING follows tools/duelCore.js's runDuelMatch exactly — entrant A owns "player", entrant B
 * owns "ai" — which is what makes "A won" mean the same thing on a watched match's game-over
 * screen as in a simulated row. That is direction 1 ("bAsAi") of the worker's own pair; a watched
 * match is deliberately just the one direction, which is precisely why it isn't rated (see above).
 * @param {object} job                a job from buildJob above.
 * @param {{ world?: string, rep?: number }} [pick]  which scheduled match to watch; defaults to the
 *   first world's first replicate.
 * @returns {{ world: string, seed: number, swapAsym: boolean, matchTimeLimit: number|undefined,
 *   difficulty: string, aName: string, bName: string, ai: object, playerAi: object }}
 */
export function buildWatchConfig(job, { world, rep = 0 } = {}) {
  const pickWorld = world || job.worlds[0];
  if (!job.worlds.includes(pickWorld)) throw new Error(`"${pickWorld}" isn't one of this duel's worlds`);
  const replicate = Math.max(0, Math.floor(rep) || 0);
  const dials = pinnedDuelDials(job.difficulty);
  return {
    world: pickWorld,
    seed: matchSeedFor(job, pickWorld, replicate),
    swapAsym: replicate % 2 === 1,   // replicate parity — the same rule competitionWorker.js uses
    matchTimeLimit: job.matchTimeLimit,
    difficulty: dials.difficulty,
    aName: job.entrantA.name,
    bName: job.entrantB.name,
    // Both seats read from ONE dials object, exactly like runDuelMatch's own two lines.
    playerAi: { ...dials, strategy: job.entrantA.strategy, archetype: job.entrantA.archetype },
    ai: { ...dials, strategy: job.entrantB.strategy, archetype: job.entrantB.archetype },
  };
}

/**
 * A finished watched match's terminal state -> the outcome, in the ENTRANTS' own names. The human
 * played neither seat, so there is no victory and no defeat here — only which entrant won. Scores
 * are A-relative, the same convention tools/duelCore.js's runDuelMatch row uses, so a watched
 * match's margin reads exactly like a simulated one's.
 * @param {{ winner: string|null, winReason: string|null }} state  a finished game state.
 * @param {{ aName: string, bName: string }} watch
 */
export function spectatedMatchOutcome(state, { aName, bName }) {
  // Entrant A holds owner "player" (buildWatchConfig / buildReplayConfig).
  const rawA = playerScore(state, "player"), rawB = playerScore(state, "ai");
  const winnerName = state.winner === "player" ? aName : state.winner === "ai" ? bName : null;
  return {
    winnerName,
    verdict: winnerName ? `${winnerName} wins the exhibition match.` : "The exhibition match ended in a draw.",
    aName, bName,
    aScore: +rawA.toFixed(1), bScore: +rawB.toFixed(1),
    // Rounded ONCE, off the raw scores — byte-for-byte tools/duelCore.js's runDuelMatch, which is
    // what every recorded row's margin is. Rounding each score first and subtracting the rounded
    // pair (which this used to do) double-rounds and lands up to 0.1 away, so the identical match
    // reported a different margin depending on whether it was simulated or watched. Harmless-looking
    // until Phase 5's replay compares the two numbers directly — then it reads as a determinism
    // failure that isn't one, which is worse than a wrong digit.
    margin: +(rawA - rawB).toFixed(1),
    winReason: typeof state.winReason === "string" ? state.winReason : null,
    exhibition: true,
  };
}

/* ============================================================
   REPLAYING A FINISHED MATCH (docs/competitions-and-elo.md Phase 5) — the pure half: deciding
   whether a recorded row CAN be replayed, rebuilding the exact match it describes, and judging
   whether the re-run actually reproduced it.

   THIS IS NOT A RECORDING/PLAYBACK SYSTEM, and that is the whole point. A recorded ledger row
   already carries its world, its exact seed, its map half, both entrants' strategies and the one
   pinned difficulty dial set they shared; the roster carries each entrant's archetype. That is the
   complete input to createSelfPlayState, so "replay" is just RE-RUNNING the same deterministic
   simulation from the same inputs and watching it through the spectator (D6). Nothing is stored, no
   frames are captured, and a replay of a ten-year-old row costs exactly what the match cost.

   TWO THINGS THAT ARE EASY TO GET WRONG HERE, both of which have their own tests:

   • THE SEAT. Every row is reported A-relative (entrant A's names, A's scores, A-relative margin),
     but each row was actually played in one of two DIRECTIONS — competitionWorker.js runs each
     (world, replicate) both ways. "bAsAi" is runDuelMatch's own fixed mapping (A owns "player");
     "aAsAi" is the reverse, relabelled back onto A by the worker's flipRow. Replaying the wrong
     direction is a different match between the same two names, so buildReplayConfig below rebuilds
     the SEATING, not the labelling, and restates the recorded outcome seat-relative so the re-run
     can be compared to it directly.

   • THE FIXED STEP. A recorded row was simulated at tools/selfplay.js's own SELFPLAY_DT. The
     ordinary game loop runs at a different step, and a fixed step is the simulation, not a tuning
     knob — the same seed advanced in different-sized steps is a different game (measured: opposite
     winners; see SELFPLAY_DT's own comment). That is boot.js's half of this, via bootState's
     `selfPlay` option, but it is named here because it is the reason replay determinism actually
     holds rather than nearly holding.

   AND A REPLAY RE-RATES NOTHING. It is the same match, already counted — re-recording it would
   double-count a result that only happened once. There is deliberately no path from here into
   recordCompetition, exactly as there is none for a watched match.
   ============================================================ */

// Said next to every Replay button and again when a replay ends. Same shape and same reasoning as
// EXHIBITION_NOTE above: a constant, not a tooltip, so a Node test can assert its CONTENT.
export const REPLAY_NOTE =
  "A replay re-runs this match from its recorded seed and both entrants' configs — the same "
  + "deterministic simulation, not a captured video. It changes no rating and records nothing new: "
  + "this result is already counted on the ladder.";

// The worlds a match can actually be booted on — engine/aiArchetypes.js's own PLANET_ARCHETYPE
// keys, the same list competitionLedger.js validates a gauntlet fixture's world against, and for
// the same reason it reads them there rather than from setup.js (a world cannot exist in one list
// and not the other).
const REPLAYABLE_WORLDS = new Set(Object.keys(PLANET_ARCHETYPE));

/**
 * Can this recorded history row be re-run? `{ ok: true }`, or `{ ok: false, reason }` with a
 * plain-language reason the UI shows verbatim instead of a disabled button that explains nothing.
 *
 * THE REFUSALS, and why each is a refusal rather than a best-effort replay:
 *   • A HUMAN row. D6 is explicit that a human is not a seeded input; re-running the seed would
 *     simulate an AI playing the human's seat and call the result the same match. That is not a
 *     replay, it is a different match wearing its name.
 *   • AN ENTRANT NO LONGER ON THE ROSTER. The archetype an entrant played with lives on its roster
 *     row, not on the match row (runDuelMatch takes archetype as an INPUT dial and deliberately
 *     doesn't echo it back — test/duelCore.test.js pins that row shape). Roster entries are
 *     add/remove only, never edited in place, so a name still on the roster carries exactly the
 *     archetype it played with; a name that is gone carries nothing, and guessing "probably no
 *     override" would silently produce a different match.
 *   • A ROW WITH NO REAL WORLD OR SEED. Nothing to re-run.
 * @param {object} row       a competitionWorker.js-shaped row, as stored in ledger.history
 * @param {{ roster?: Array<{name: string, archetype: string|null}> }} ledger
 * @returns {{ ok: boolean, reason?: string }}
 */
export function replayableMatch(row, ledger) {
  if (!row || typeof row !== "object") return { ok: false, reason: "There is no recorded match here to replay." };
  if (row.human)
    return { ok: false, reason: "This is a match you played yourself, and a human isn't a seeded input — re-running the seed would simulate somebody else in your seat, not replay your match (D6)." };
  if (typeof row.world !== "string" || !REPLAYABLE_WORLDS.has(row.world))
    return { ok: false, reason: `This match records no world this game can boot (${String(row.world)}).` };
  if (!Number.isFinite(row.seed))
    return { ok: false, reason: "This match records no seed, so there is nothing to re-run." };
  const roster = (ledger && ledger.roster) || [];
  for (const name of [row.aName, row.bName]) {
    if (typeof name !== "string" || !name) return { ok: false, reason: "This match doesn't name both entrants." };
    if (!roster.some(r => r.name === name))
      return { ok: false, reason: `"${name}" is no longer on the roster, so the archetype it played with can't be recovered — a replay would be a different match.` };
  }
  return { ok: true };
}

/**
 * A recorded history row -> exactly the config boot.js's startSpectatedMatch feeds
 * createSelfPlayState, plus the recorded outcome restated SEAT-relative so the re-run can be
 * compared against it directly. Throws replayableMatch's own reason for a row that can't be
 * replayed, so a caller that skipped the check still can't boot a bogus match.
 *
 * `aName`/`bName` are the entrants that held owner "player"/"ai" IN THE RECORDED MATCH — the same
 * meaning buildWatchConfig gives them, which is what lets spectatedMatchOutcome, the spectate bar
 * and the game-over screen serve both paths unchanged.
 * @param {object} row
 * @param {{ roster?: Array<{name: string, archetype: string|null}> }} ledger
 * @returns {{ world: string, seed: number, swapAsym: boolean, matchTimeLimit: number|undefined,
 *   difficulty: string, aName: string, bName: string, ai: object, playerAi: object,
 *   recorded: { winnerName: string|null, margin: number, aScore: number, bScore: number, winReason: string|null } }}
 */
export function buildReplayConfig(row, ledger) {
  const check = replayableMatch(row, ledger);
  if (!check.ok) throw new Error(check.reason);

  // "aAsAi" is the worker's SECOND direction: entrant B held owner "player", and the row was
  // relabelled back onto A afterwards. Everything below un-does exactly that relabelling.
  const flipped = row.direction === "aAsAi";
  const seatA = flipped ? row.bName : row.aName;
  const seatB = flipped ? row.aName : row.bName;
  // Validated against the real strategy table, not merely defaulted when absent. A history row is
  // untrusted input — competitionLedger.js's cleanHistoryRow coerces aName/bName and leaves the
  // rest as it found it, so a hand-edited or imported ladder can carry any string here. The engine
  // would survive it (strategyFor falls back to STRATEGIES.default for an unknown key), but the
  // replay would then silently run a DIFFERENT match than the row describes and report the
  // mismatch as a divergence — a determinism failure that isn't one, which is exactly the wrong
  // thing for the one feature whose whole promise is "this reproduces what was recorded". Mirrors
  // archetypeOf's own Object.hasOwn check just below; the two are the same hazard.
  const knownStrategy = s =>
    (typeof s === "string" && STRATEGY_OPTIONS.some(o => o.mult === s)) ? s : "default";
  const seatAStrategy = knownStrategy(flipped ? row.bStrategy : row.aStrategy);
  const seatBStrategy = knownStrategy(flipped ? row.aStrategy : row.bStrategy);
  const archetypeOf = name => {
    const entry = ((ledger && ledger.roster) || []).find(r => r.name === name);
    return (entry && typeof entry.archetype === "string" && Object.hasOwn(ARCHETYPES, entry.archetype)) ? entry.archetype : null;
  };
  // -0 is not 0 to a strict comparison, and a drawn match's margin is exactly 0 — so a negation
  // that can produce -0 would make a perfectly reproduced draw read as a divergence.
  const seatSigned = n => {
    const v = Number.isFinite(n) ? (flipped ? -n : n) : 0;
    return v === 0 ? 0 : v;
  };
  const dials = pinnedDuelDials(row.difficulty);

  return {
    world: row.world,
    seed: row.seed,
    swapAsym: row.swapAsym === true,
    // A Quick Duel / tournament job never sets a match length, so a recorded row carrying none is
    // exactly right: the match ran at engine/victory.js's own default and the replay must too.
    // Honoured when present so a row that does record one replays at that length rather than the
    // default (which would be a different match).
    matchTimeLimit: Number.isFinite(row.matchTimeLimit) ? row.matchTimeLimit : undefined,
    difficulty: dials.difficulty,
    aName: seatA,
    bName: seatB,
    // ONE dials object read for both seats, exactly as the recorded match ran it.
    playerAi: { ...dials, strategy: seatAStrategy, archetype: archetypeOf(seatA) },
    ai: { ...dials, strategy: seatBStrategy, archetype: archetypeOf(seatB) },
    recorded: {
      // Who won is a fact about the ENTRANT and is read straight off the A-relative row…
      winnerName: row.winner === "draw" ? null : row.winner === "a" ? row.aName : row.bName,
      // …while the scores and margin are restated the way the re-run will measure them.
      margin: seatSigned(row.margin),
      aScore: flipped ? row.bScore : row.aScore,
      bScore: flipped ? row.aScore : row.bScore,
      winReason: typeof row.winReason === "string" ? row.winReason : null,
    },
  };
}

/**
 * Did the re-run reproduce what was recorded? Compares the two facts a replay actually promises —
 * the winner and the score margin — and produces the line the game-over screen shows.
 *
 * A DIVERGENCE IS REPORTED, NOT HIDDEN. If the sim ever stops being deterministic under this path
 * (a stray clock read, a changed fixed step, an iteration-order regression), the player is the
 * first person to see it, in plain words, on the screen where the claim was made. Quietly showing
 * whatever just happened would turn a real bug into a shrug.
 * @param {{ winnerName: string|null, margin: number }} outcome   spectatedMatchOutcome's own shape
 * @param {{ winnerName: string|null, margin: number }} recorded  buildReplayConfig's `recorded`
 * @returns {{ reproduced: boolean, line: string }}
 */
export function replayVerdict(outcome, recorded) {
  const said = r => (r.winnerName ? `${r.winnerName} by ${Math.abs(r.margin)}` : `a draw (margin ${Math.abs(r.margin)})`);
  const reproduced = outcome.winnerName === recorded.winnerName && outcome.margin === recorded.margin;
  return {
    reproduced,
    line: reproduced
      ? `Reproduced the recorded result exactly — ${said(recorded)}.`
      : `DIVERGED from the recorded result. Recorded: ${said(recorded)}. This run: ${said(outcome)}.`,
  };
}

// How many recorded matches the history list shows by default. A ladder accumulates thousands of
// rows over time (one tournament is hundreds), and a Standings screen that rebuilds all of them on
// every render would be both unreadable and slow; the most recent competitions are what a "replay
// that one" affordance is actually for.
const HISTORY_MATCH_LIMIT = 24;

/**
 * The ledger's recorded matches, shaped for a history table with a Replay button per row: newest
 * COMPETITION first (a duel/tournament pairing/gauntlet fixture is one history entry), rows within
 * one competition kept in the order they were played, capped at `limit`.
 *
 * Each item carries its own `{entryIndex, rowIndex}` address into the ledger rather than a copy of
 * the row, so the click handler re-reads the live ledger instead of replaying a snapshot that a
 * roster edit or an import may have invalidated since the table was drawn. `replayable`/`reason`
 * come from replayableMatch, so an unreplayable match is still LISTED — it happened — with the
 * reason it can't be re-run, rather than vanishing from the record.
 * @param {{ history?: Array<{at: number|null, difficulty: string, rows: object[]}>, roster?: object[] }} ledger
 * @param {{ limit?: number }} [opts]
 */
export function shapeHistoryMatches(ledger, { limit = HISTORY_MATCH_LIMIT } = {}) {
  const history = (ledger && ledger.history) || [];
  const out = [];
  for (let entryIndex = history.length - 1; entryIndex >= 0; entryIndex--) {
    const entry = history[entryIndex];
    const rows = (entry && entry.rows) || [];
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      if (out.length >= limit) return out;
      const row = rows[rowIndex];
      const check = replayableMatch(row, ledger);
      out.push({
        entryIndex, rowIndex,
        at: Number.isFinite(entry.at) ? entry.at : null,
        difficulty: entry.difficulty,
        world: row.world,
        seed: row.seed,
        aName: row.aName, bName: row.bName,
        // The same wording shapeResultsTable uses, so one match reads identically in the duel
        // results table and in the history list.
        side: row.direction === "aAsAi" ? `${row.aName} as AI` : `${row.bName} as AI`,
        winner: row.winner === "draw" ? "Draw" : row.winner === "a" ? row.aName : row.bName,
        margin: row.margin,
        winReason: row.winReason || "-",
        human: row.human === true,
        replayable: check.ok,
        reason: check.ok ? null : check.reason,
      });
    }
  }
  return out;
}
