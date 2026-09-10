/* ============================================================
   Guards for competition.js's PURE exports only — job construction, per-match seed derivation,
   worker-row -> display-table shaping, and Elo folding. No DOM, no real Worker: the same
   discipline test/duelCore.test.js and test/elo.test.js already hold themselves to for their own
   pure modules (docs/competitions-and-elo.md Phase 1). competition.js's DOM-rendering half (the
   actual Quick Duel / Tournament / Roster / Standings screens) is exercised by each stage's live
   browser verification instead — see CONTRIBUTING.md's C10 note on why the two halves are split in
   the first place. Phase 2 added the roster/standings shaping section; Phase 3 the tournament
   estimate/job/standings/bracket section at the bottom.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildJob, matchCount, matchSeedFor, shapeResultsTable, eloFromRows,
  ARCHETYPE_OPTIONS, ROSTER_FACTION_OPTIONS, resolveEntrantPick, ratingLookup,
  hasRatingHistory, shapeRosterRow, shapeStandingsTable,
  TOURNAMENT_FORMAT_OPTIONS, SECONDS_PER_MATCH, tournamentPairingCount, tournamentEstimate,
  buildTournamentJob, seedFieldByRating, tournamentProgressLabel, tournamentStandingsRows,
  shapeTournamentStandings, shapeBracketView,
  SEAT_DISCLOSURE, gauntletEstimate, buildGauntletStart, shapeGauntletFixtures, nextGauntletFixture,
  humanMatchOutcome, gauntletLadderTrail, shapeGauntletSummary,
  EXHIBITION_NOTE, buildWatchConfig, spectatedMatchOutcome,
  REPLAY_NOTE, replayableMatch, buildReplayConfig, replayVerdict, shapeHistoryMatches,
} from "../competition.js";
// mostRelevantBracket reads the live ledger this module caches, so it moved with the screens when
// competition.js was split into its pure half and competitionScreens.js. Its logic is unchanged
// and so are the tests below it; only the module it lives in moved.
import { mostRelevantBracket } from "../competitionScreens.js";
import { duelSeed, pinnedDuelDials } from "../tools/duelCore.js";
import { createSelfPlayState, tickSelfPlay, runSelfPlayMatch } from "../tools/selfplay.js";
import { runCompetitionJob } from "../competitionWorker.js";
import { INITIAL_RATING } from "../elo.js";
import { ARCHETYPES } from "../engine/aiArchetypes.js";
import {
  createLedger, addRosterEntry, removeRosterEntry, recordCompetition, standingsFor,
  GAUNTLET_DEFAULT_MATCH_SECONDS, startGauntlet, recordGauntletMatch, recordGauntletForfeit,
} from "../competitionLedger.js";
import { buildSwissBracket, buildKnockoutBracket, knockoutMatchCount, swissRoundCount } from "../pairing.js";
import { createGameState } from "../engine/state.js";
import { mulberry32 } from "../engine/rng.js";
import { playerScore } from "../engine/victory.js";
import { planetName } from "../data.js";

/* ---------- buildJob: deterministic job construction from a fixed entrant config ---------- */

const fixedCfg = () => ({
  entrantA: { name: "Alpha", strategy: "aggressive" },
  entrantB: { name: "Beta", strategy: "economic" },
  difficulty: "hard",
  worlds: ["ferros", "korrath"],
  seeds: 3,
  seedBase: 42,
});

test("buildJob is deterministic: the same fixed entrant config produces a byte-identical job", () => {
  const a = buildJob(fixedCfg());
  const b = buildJob(fixedCfg());
  assert.deepEqual(a, b);
});

test("buildJob produces exactly the job message shape competitionWorker.js expects", () => {
  const job = buildJob(fixedCfg());
  assert.deepEqual(job, {
    entrantA: { name: "Alpha", strategy: "aggressive", archetype: null },
    entrantB: { name: "Beta", strategy: "economic", archetype: null },
    difficulty: "hard",
    worlds: ["ferros", "korrath"],
    seeds: 3,
    seedBase: 42,
  });
});

/* ---------- buildJob: archetype (D3) ---------- */

test("buildJob carries a valid archetype key straight through, per entrant, independently", () => {
  const job = buildJob({
    ...fixedCfg(),
    entrantA: { name: "Alpha", strategy: "aggressive", archetype: "rusher" },
    entrantB: { name: "Beta", strategy: "economic", archetype: "economist" },
  });
  assert.equal(job.entrantA.archetype, "rusher");
  assert.equal(job.entrantB.archetype, "economist");
});

test("buildJob defaults a missing archetype to null -- byte-identical to before archetype existed as an option", () => {
  const job = buildJob(fixedCfg());
  assert.equal(job.entrantA.archetype, null);
  assert.equal(job.entrantB.archetype, null);
});

test("buildJob coerces an unrecognised archetype key to null rather than trusting it verbatim", () => {
  const job = buildJob({ ...fixedCfg(), entrantA: { name: "Alpha", strategy: "default", archetype: "not-a-real-archetype" } });
  assert.equal(job.entrantA.archetype, null);
});

test("buildJob coerces a reserved/inherited key (__proto__, constructor, prototype) to null, not to the key itself", () => {
  // Regression: knownArchetype used to be `(a && ARCHETYPES[a]) ? a : null` -- a truthy
  // bracket-access, which for a plain object resolves "__proto__"/"constructor"/"prototype" to an
  // inherited (always-truthy) property rather than "not a real key". That let a hostile archetype
  // string survive into the job as-is, contradicting this function's own doc comment ("anything
  // else -- missing, blank, unknown -- becomes null"). Object.hasOwn is the fix.
  for (const key of ["__proto__", "constructor", "prototype"]) {
    const job = buildJob({ ...fixedCfg(), entrantA: { name: "Alpha", strategy: "default", archetype: key } });
    assert.equal(job.entrantA.archetype, null, `"${key}" must coerce to null, not survive as "${key}"`);
  }
});

test("buildJob treats every ARCHETYPES key as valid, not just one", () => {
  for (const key of Object.keys(ARCHETYPES)) {
    const job = buildJob({ ...fixedCfg(), entrantA: { name: "Alpha", strategy: "default", archetype: key } });
    assert.equal(job.entrantA.archetype, key);
  }
});

test("buildJob carries matchTimeLimit through only when given (optional field)", () => {
  assert.equal("matchTimeLimit" in buildJob(fixedCfg()), false);
  assert.equal(buildJob({ ...fixedCfg(), matchTimeLimit: 900 }).matchTimeLimit, 900);
});

test("buildJob trims entrant names and rejects an empty or blank one", () => {
  assert.equal(buildJob({ ...fixedCfg(), entrantA: { name: "  Alpha  ", strategy: "default" } }).entrantA.name, "Alpha");
  assert.throws(() => buildJob({ ...fixedCfg(), entrantA: { name: "", strategy: "default" } }), /name/i);
  assert.throws(() => buildJob({ ...fixedCfg(), entrantB: { name: "   ", strategy: "default" } }), /name/i);
  assert.throws(() => buildJob({ ...fixedCfg(), entrantA: null }), /name/i);
});

test("buildJob rejects identical entrant names -- they'd collide into one elo.js RatingsTable entry", () => {
  assert.throws(
    () => buildJob({ ...fixedCfg(), entrantA: { name: "Bob", strategy: "default" }, entrantB: { name: "Bob", strategy: "aggressive" } }),
    /same|different|distinct/i,
  );
  // Compared post-trim, same as the existing blank-name check -- "Bob" and " Bob " are one collision,
  // not two distinct entrants that merely LOOK different in the raw input.
  assert.throws(
    () => buildJob({ ...fixedCfg(), entrantA: { name: " Bob ", strategy: "default" }, entrantB: { name: "Bob", strategy: "aggressive" } }),
    /same|different|distinct/i,
  );
});

test("buildJob throws when no world is selected", () => {
  assert.throws(() => buildJob({ ...fixedCfg(), worlds: [] }), /world/i);
});

test("buildJob floors/clamps a non-integer or sub-1 seeds count to a valid positive integer", () => {
  assert.equal(buildJob({ ...fixedCfg(), seeds: 2.9 }).seeds, 2);
  assert.equal(buildJob({ ...fixedCfg(), seeds: 0 }).seeds, 1);
  assert.equal(buildJob({ ...fixedCfg(), seeds: -5 }).seeds, 1);
});

test('buildJob defaults a missing strategy to "default", the same fallback tools/ailab.js\'s own runDuel uses', () => {
  const job = buildJob({ ...fixedCfg(), entrantA: { name: "Alpha" }, entrantB: { name: "Beta" } });
  assert.equal(job.entrantA.strategy, "default");
  assert.equal(job.entrantB.strategy, "default");
});

test("buildJob does not mutate the worlds array it was given", () => {
  const worlds = ["ferros", "korrath"];
  const job = buildJob({ ...fixedCfg(), worlds });
  job.worlds.push("vesper");
  assert.deepEqual(worlds, ["ferros", "korrath"], "buildJob must copy the worlds array, not alias it");
});

/* ---------- matchCount ---------- */

test("matchCount is worlds x seeds x 2 directions (side-swapped)", () => {
  const job = buildJob(fixedCfg());
  assert.equal(matchCount(job), 2 /* worlds */ * 3 /* seeds */ * 2 /* directions */);
});

/* ---------- matchSeedFor: per-match seed derivation reuses duelCore's own duelSeed ---------- */

test("matchSeedFor matches tools/duelCore.js's own duelSeed for identical inputs", () => {
  const job = buildJob(fixedCfg());
  for (const world of job.worlds) {
    for (let rep = 0; rep < job.seeds; rep++) {
      const expected = duelSeed(job.seedBase, world, job.difficulty, job.entrantA.name, job.entrantB.name, rep);
      assert.equal(matchSeedFor(job, world, rep), expected);
    }
  }
});

test("matchSeedFor genuinely varies with world and replicate, matching duelSeed's own sensitivity", () => {
  const job = buildJob(fixedCfg());
  assert.notEqual(matchSeedFor(job, "ferros", 0), matchSeedFor(job, "korrath", 0), "world must vary the seed");
  assert.notEqual(matchSeedFor(job, "ferros", 0), matchSeedFor(job, "ferros", 1), "replicate must vary the seed");
});

test("matchSeedFor is independent of entrant order, same as duelSeed's own name-sorting", () => {
  const jobAB = buildJob(fixedCfg());
  const jobBA = buildJob({ ...fixedCfg(), entrantA: { name: "Beta", strategy: "economic" }, entrantB: { name: "Alpha", strategy: "aggressive" } });
  assert.equal(matchSeedFor(jobAB, "ferros", 0), matchSeedFor(jobBA, "ferros", 0));
});

/* ---------- shapeResultsTable: worker-shaped {type:"done"} rows -> display table ---------- */

const fixedRows = () => [
  {
    world: "ferros", seed: 111, difficulty: "medium", swapAsym: false,
    aName: "Alpha", aStrategy: "aggressive", bName: "Beta", bStrategy: "economic",
    aDifficulty: "medium", bDifficulty: "medium", aApm: 65, bApm: 65, aMicro: false, bMicro: false,
    winner: "a", winReason: "elimination", time: 812.3, aScore: 40, bScore: 12, margin: 28,
    direction: "bAsAi",
  },
  {
    world: "ferros", seed: 111, difficulty: "medium", swapAsym: true,
    aName: "Alpha", aStrategy: "aggressive", bName: "Beta", bStrategy: "economic",
    aDifficulty: "medium", bDifficulty: "medium", aApm: 65, bApm: 65, aMicro: false, bMicro: false,
    winner: "draw", winReason: null, time: 2520, aScore: 20, bScore: 20, margin: 0,
    direction: "aAsAi",
  },
];

test("shapeResultsTable shapes worker rows into the expected display-table structure", () => {
  const shaped = shapeResultsTable(fixedRows());
  assert.deepEqual(shaped, [
    { world: "ferros", seed: 111, side: "Beta as AI", swap: false, winner: "Alpha", reason: "elimination", time: 812.3, aScore: 40, bScore: 12, margin: 28 },
    { world: "ferros", seed: 111, side: "Alpha as AI", swap: true, winner: "Draw", reason: "-", time: 2520, aScore: 20, bScore: 20, margin: 0 },
  ]);
});

test("shapeResultsTable's winner column names the losing side's name when B wins", () => {
  const rows = [{ ...fixedRows()[0], winner: "b" }];
  assert.equal(shapeResultsTable(rows)[0].winner, "Beta");
});

test("shapeResultsTable does not mutate its input rows", () => {
  const rows = fixedRows();
  const untouched = JSON.stringify(rows);
  shapeResultsTable(rows);
  assert.equal(JSON.stringify(rows), untouched);
});

/* ---------- eloFromRows: feeds worker rows through elo.js's applySeries, in received order ---------- */

test("eloFromRows starts both entrants at INITIAL_RATING and moves them by the match results", () => {
  const ratings = eloFromRows(fixedRows());
  assert.ok(ratings.Alpha, "the winner must appear in the returned ratings table");
  assert.ok(ratings.Beta, "the loser must appear in the returned ratings table");
  assert.equal(ratings.Alpha.games, 2);
  assert.equal(ratings.Beta.games, 2);
  assert.notEqual(ratings.Alpha.rating, INITIAL_RATING, "a match was won -- the rating must have moved");
  assert.notEqual(ratings.Beta.rating, INITIAL_RATING);
});

test("eloFromRows is order-sensitive (D6): reversing the rows settles on a different table", () => {
  const forward = eloFromRows(fixedRows());
  const reversed = eloFromRows([...fixedRows()].reverse());
  assert.notDeepEqual(forward, reversed,
    "Elo is order-dependent -- the same rows in a different order must not settle on the same table");
});

test("eloFromRows is reproducible: the same rows replayed twice give byte-identical ratings", () => {
  assert.deepEqual(eloFromRows(fixedRows()), eloFromRows(fixedRows()));
});

/* ============================================================
   PHASE 2: roster/standings shaping and the roster-vs-adhoc entrant resolution. Same "no DOM, no
   Worker" discipline as everything above -- competitionLedger.js's own functions are real, DOM-free
   exports, so these tests build a live ledger with them directly rather than mocking anything.
   ============================================================ */

/* ---------- ARCHETYPE_OPTIONS / ROSTER_FACTION_OPTIONS: derived tables, not a hardcoded copy ---------- */

test("ARCHETYPE_OPTIONS derives its real entries from engine/aiArchetypes.js's ARCHETYPES, not a hardcoded duplicate list", () => {
  const keys = ARCHETYPE_OPTIONS.filter(o => o.mult !== null).map(o => o.mult);
  assert.deepEqual(keys.sort(), Object.keys(ARCHETYPES).sort());
  for (const opt of ARCHETYPE_OPTIONS) {
    if (opt.mult === null) continue;
    assert.equal(opt.label, ARCHETYPES[opt.mult].name, `${opt.mult}'s label must be its real ARCHETYPES name, not a hardcoded copy`);
  }
});

test("ARCHETYPE_OPTIONS offers a null \"no override\" choice first", () => {
  assert.equal(ARCHETYPE_OPTIONS[0].mult, null);
});

test("ROSTER_FACTION_OPTIONS covers every playable faction plus neutral, with no hardcoded label copy", () => {
  const keys = ROSTER_FACTION_OPTIONS.map(o => o.mult);
  assert.ok(keys.includes("neutral"), "a roster entry can default to Unaligned, unlike the skirmish setup screen's own FACTION_OPTIONS");
  assert.ok(keys.includes("frontier") && keys.includes("miners") && keys.includes("syndicate"));
  assert.equal(new Set(keys).size, keys.length, "no duplicate faction entries");
});

/* ---------- resolveEntrantPick: the roster-vs-adhoc entrant resolution ---------- */

test('resolveEntrantPick in "roster" mode reads the CURRENT roster entry back by name', () => {
  const ledger = createLedger();
  addRosterEntry(ledger, { name: "Blitz", strategy: "aggressive", archetype: "rusher", faction: "syndicate" });
  const resolved = resolveEntrantPick({ mode: "roster", rosterName: "Blitz" }, ledger);
  assert.deepEqual(resolved, { name: "Blitz", strategy: "aggressive", archetype: "rusher", faction: "syndicate", isNew: false });
});

test('resolveEntrantPick in "roster" mode throws a clear error when the picked name is no longer on the roster', () => {
  const ledger = createLedger();
  assert.throws(() => resolveEntrantPick({ mode: "roster", rosterName: "Ghost" }, ledger), /roster/i);
});

test('resolveEntrantPick in "new" mode trims the name and defaults strategy/archetype/faction, marking isNew', () => {
  const resolved = resolveEntrantPick({ mode: "new", name: "  Fresh  " }, createLedger());
  assert.deepEqual(resolved, { name: "Fresh", strategy: "default", archetype: null, faction: "neutral", isNew: true });
});

test('resolveEntrantPick in "new" mode carries a chosen strategy/archetype/faction through unchanged', () => {
  const resolved = resolveEntrantPick(
    { mode: "new", name: "Fresh", strategy: "economic", archetype: "balanced", faction: "miners" }, createLedger());
  assert.deepEqual(resolved, { name: "Fresh", strategy: "economic", archetype: "balanced", faction: "miners", isNew: true });
});

test('resolveEntrantPick defaults to "new" semantics when mode is missing, unrecognised, or the pick itself is absent', () => {
  assert.equal(resolveEntrantPick({ name: "Fresh" }, createLedger()).isNew, true);
  assert.equal(resolveEntrantPick({ mode: "bogus", name: "Fresh" }, createLedger()).isNew, true);
  assert.equal(resolveEntrantPick(undefined, createLedger()).isNew, true);
});

/* ---------- ratingLookup ---------- */

test("ratingLookup returns the table's own entry when the entrant has played this bracket", () => {
  const table = { Alpha: { rating: 1300, games: 5 } };
  assert.deepEqual(ratingLookup(table, "Alpha"), { rating: 1300, games: 5 });
});

test("ratingLookup returns INITIAL_RATING at 0 games for an entrant absent from the table", () => {
  assert.deepEqual(ratingLookup({}, "Nobody"), { rating: INITIAL_RATING, games: 0 });
});

test("ratingLookup returns the same default when the table itself is undefined (bracket never played)", () => {
  assert.deepEqual(ratingLookup(undefined, "Nobody"), { rating: INITIAL_RATING, games: 0 });
});

test("ratingLookup does not mistake an inherited Object.prototype member for a real rating", () => {
  assert.deepEqual(ratingLookup({}, "toString"), { rating: INITIAL_RATING, games: 0 });
});

/* ---------- hasRatingHistory ---------- */

test("hasRatingHistory is true once an entrant has a rating entry in ANY bracket, false beforehand", () => {
  const ledger = createLedger();
  addRosterEntry(ledger, { name: "Alpha" });
  addRosterEntry(ledger, { name: "Beta" });
  assert.equal(hasRatingHistory(ledger, "Alpha"), false);
  recordCompetition(ledger, { difficulty: "hard", aName: "Alpha", bName: "Beta", rows: [{ aName: "Alpha", bName: "Beta", winner: "a" }] });
  assert.equal(hasRatingHistory(ledger, "Alpha"), true);
  assert.equal(hasRatingHistory(ledger, "Beta"), true);
  assert.equal(hasRatingHistory(ledger, "Gamma"), false, "an entrant that never even played has no history");
});

/* ---------- shapeRosterRow ---------- */

test("shapeRosterRow maps strategy/archetype/faction keys to their real display names", () => {
  const row = shapeRosterRow({ name: "Blitz", strategy: "aggressive", archetype: "rusher", faction: "syndicate", createdAt: 1 });
  assert.equal(row.name, "Blitz");
  assert.equal(row.strategy, "Aggressive");
  assert.equal(row.archetype, "Rusher");
  assert.equal(row.faction, "Syndicate");
});

test("shapeRosterRow shows a clear placeholder for a null (world-default) archetype", () => {
  const row = shapeRosterRow({ name: "Plain", strategy: "default", archetype: null, faction: "neutral" });
  assert.equal(typeof row.archetype, "string");
  assert.notEqual(row.archetype, "");
});

test("shapeRosterRow falls back to the world-default placeholder for a reserved/inherited archetype key too", () => {
  // Regression: a truthy `ARCHETYPES[entry.archetype]` bracket-access resolved "__proto__" to
  // Object.prototype (always truthy, no .name), which would have rendered "undefined" instead of
  // "World default" -- competitionLedger.js's own roster guard means a real roster entry can never
  // actually carry this value, but the display function shouldn't depend on that upstream guard to
  // stay correct on its own.
  for (const key of ["__proto__", "constructor", "prototype"]) {
    const row = shapeRosterRow({ name: "Hostile", strategy: "default", archetype: key, faction: "neutral" });
    assert.equal(row.archetype, "World default", `"${key}" must render the placeholder, not "undefined"`);
  }
});

/* ---------- shapeStandingsTable: formats standingsFor's own rows, never recomputes them ---------- */

test("shapeStandingsTable formats standingsFor's own fields without recomputing any of them", () => {
  const standings = [{ name: "Alpha", rating: 1234.6, games: 7, wins: 5, losses: 1, draws: 1, avgMargin: 12.34, provisional: true, human: false }];
  assert.deepEqual(shapeStandingsTable(standings), [
    { name: "Alpha", rating: 1235, games: 7, record: "5-1-1", avgMargin: "12.3", provisional: true, human: false },
  ]);
});

// D4: without this the Standings screen -- the one screen that shows a human rating NEXT TO the AI
// ratings it is being compared against, and the screen the gauntlet's own "View Standings" button
// routes to -- cannot mark which row is the person, nor know to state the seat disclosure at all.
test("shapeStandingsTable carries the human flag through so the Standings screen can mark the row (D4)", () => {
  const standings = [
    { name: "Ada", rating: 1239.2, games: 2, wins: 1, losses: 1, draws: 0, avgMargin: 3, provisional: true, human: true },
    { name: "Grinder", rating: 1200, games: 2, wins: 1, losses: 1, draws: 0, avgMargin: -3, provisional: true, human: false },
  ];
  assert.deepEqual(shapeStandingsTable(standings).map(r => r.human), [true, false]);
});

// The flag is a marker the DOM layer branches on, so an older/hand-built row that never carried one
// must read as "not the human" rather than as undefined leaking into a `.some(r => r.human)` test.
test("shapeStandingsTable defaults a missing human flag to false rather than passing undefined on", () => {
  const [row] = shapeStandingsTable([{ name: "Alpha", rating: 1200, games: 1, wins: 1, losses: 0, draws: 0, avgMargin: 1, provisional: true }]);
  assert.equal(row.human, false);
});

test("shapeStandingsTable preserves standingsFor's own sort order (never re-sorts)", () => {
  const standings = [
    { name: "B", rating: 1300, games: 1, wins: 1, losses: 0, draws: 0, avgMargin: 5, provisional: true },
    { name: "A", rating: 1200, games: 1, wins: 0, losses: 1, draws: 0, avgMargin: -5, provisional: true },
  ];
  assert.deepEqual(shapeStandingsTable(standings).map(r => r.name), ["B", "A"]);
});

/* ============================================================
   PHASE 3: the Tournament tab's own pure logic -- the up-front cost estimate for all three
   formats, tournament-job construction from a field + format + options, and the standings/bracket
   shaping the results view renders. Same "no DOM, no Worker" discipline as everything above; the
   bracket/standings fixtures are REAL pairing.js schedules run with a synthetic runPair (the idiom
   test/pairing.test.js already uses and explains), so the shaping is tested against the exact shape
   competitionWorker.js posts rather than a hand-written guess at it.
   ============================================================ */

// The same deterministic stand-in test/pairing.test.js uses: the alphabetically-earlier name wins
// 2-0, so a whole schedule resolves predictably with nothing simulated.
const fakePair = (a, b) => ({
  aName: a.name, bName: b.name, draws: 0,
  aWins: a.name < b.name ? 2 : 0,
  bWins: a.name < b.name ? 0 : 2,
  avgMargin: a.name < b.name ? 5 : -5,
});
const tField = n => Array.from({ length: n }, (_, i) => ({ name: `S${String(i).padStart(2, "0")}`, strategy: "default", archetype: null }));

/* ---------- TOURNAMENT_FORMAT_OPTIONS ---------- */

test("TOURNAMENT_FORMAT_OPTIONS offers exactly the three formats pairing.js can schedule, in optionGroup's own shape", () => {
  assert.deepEqual(TOURNAMENT_FORMAT_OPTIONS.map(o => o.mult), ["round-robin", "swiss", "knockout"]);
  for (const o of TOURNAMENT_FORMAT_OPTIONS) {
    assert.equal(typeof o.label, "string");
    assert.ok(o.label.length, "every format needs a label for the picker");
    assert.equal(typeof o.note, "string", "optionGroup renders a note under each label");
  }
});

/* ---------- tournamentPairingCount: the per-format pairing arithmetic ---------- */

test("tournamentPairingCount: a round-robin is n x (n-1) / 2 pairings", () => {
  for (const [n, expected] of [[2, 1], [3, 3], [4, 6], [6, 15], [8, 28]])
    assert.equal(tournamentPairingCount({ format: "round-robin", entrants: n }), expected, `n=${n}`);
});

test("tournamentPairingCount: a knockout is ALWAYS n-1 pairings, byes or no byes", () => {
  for (let n = 2; n <= 17; n++) {
    assert.equal(tournamentPairingCount({ format: "knockout", entrants: n }), n - 1, `n=${n}`);
    // Not a second copy of the formula -- pairing.js's own knockoutMatchCount is the source.
    assert.equal(tournamentPairingCount({ format: "knockout", entrants: n }), knockoutMatchCount(n), `n=${n}`);
  }
});

test("tournamentPairingCount: Swiss is roundCount x floor(n/2), defaulting to max(3, ceil(log2 n))", () => {
  assert.equal(tournamentPairingCount({ format: "swiss", entrants: 4 }), 3 * 2, "ceil(log2 4) = 2, floored at 3 rounds");
  assert.equal(tournamentPairingCount({ format: "swiss", entrants: 5 }), 3 * 2, "an odd field pairs floor(n/2) per round -- the bye is not a pairing");
  assert.equal(tournamentPairingCount({ format: "swiss", entrants: 9 }), 4 * 4, "ceil(log2 9) = 4");
  assert.equal(tournamentPairingCount({ format: "swiss", entrants: 17 }), 5 * 8, "ceil(log2 17) = 5");
  for (const n of [4, 5, 9, 17])
    assert.equal(tournamentPairingCount({ format: "swiss", entrants: n }), swissRoundCount(n) * Math.floor(n / 2), `n=${n}`);
});

test("tournamentPairingCount: an explicit Swiss round override replaces the default", () => {
  assert.equal(tournamentPairingCount({ format: "swiss", entrants: 6, rounds: 2 }), 2 * 3);
  assert.equal(tournamentPairingCount({ format: "swiss", entrants: 6, rounds: 7 }), 7 * 3);
  // The override is Swiss-only -- pairing.js's other two formats have no round count to override.
  assert.equal(tournamentPairingCount({ format: "round-robin", entrants: 6, rounds: 9 }), 15);
  assert.equal(tournamentPairingCount({ format: "knockout", entrants: 6, rounds: 9 }), 5);
});

test("tournamentPairingCount refuses an unknown format and a field too small to run", () => {
  assert.throws(() => tournamentPairingCount({ format: "battle-royale", entrants: 4 }), /format/i);
  assert.throws(() => tournamentPairingCount({ format: "swiss", entrants: 1 }), /at least 2/i);
});

/* ---------- tournamentEstimate: the "is this a 30-second run or a 20-minute one" line ---------- */

test("tournamentEstimate counts MATCHES, not pairings: pairings x worlds x seeds x 2 side-swapped directions", () => {
  const est = tournamentEstimate({ format: "round-robin", entrants: 4, worlds: ["ferros", "korrath"], seeds: 1 });
  assert.equal(est.pairings, 6);
  assert.equal(est.matches, 6 * 2 * 1 * 2);
  assert.equal(est.seconds, est.matches * SECONDS_PER_MATCH);
});

test("tournamentEstimate agrees with Quick Duel's own matchCount for a single pairing's worth of work", () => {
  // A 2-entrant round-robin IS one Quick Duel, so the two estimates must not disagree.
  const est = tournamentEstimate({ format: "round-robin", entrants: 2, worlds: ["ferros", "korrath"], seeds: 3 });
  const job = buildJob(fixedCfg());
  assert.equal(est.matches, matchCount(job));
});

test("tournamentEstimate renders seconds under a minute and minutes above it", () => {
  const quick = tournamentEstimate({ format: "round-robin", entrants: 4, worlds: ["ferros", "korrath"], seeds: 1 });
  assert.equal(quick.seconds, 36);
  assert.match(quick.timeText, /^36 s$/, "under a minute reads in seconds");
  assert.match(quick.text, /24 matches/);

  const long = tournamentEstimate({ format: "knockout", entrants: 6, worlds: ["a", "b", "c", "d"], seeds: 2 });
  assert.equal(long.matches, 5 * 4 * 2 * 2);
  assert.equal(long.seconds, 120);
  assert.match(long.timeText, /^2 min$/, "a minute or more reads in minutes");
  assert.match(long.text, /80 matches/);
});

test("SECONDS_PER_MATCH sits between the doc's measured elimination and full-clock match costs", () => {
  // docs/competitions-and-elo.md's own measured table: ~1.0 s resolved by elimination, ~1.8 s worst
  // case when a match runs the full 40-sim-minute clock. The estimate constant is a documented
  // average of those two, not an invented number.
  assert.ok(SECONDS_PER_MATCH >= 1.0 && SECONDS_PER_MATCH <= 1.8, `got ${SECONDS_PER_MATCH}`);
});

/* ---------- buildTournamentJob: the job message competitionWorker.js's tournament kind expects ---------- */

const fixedTournamentCfg = () => ({
  format: "swiss",
  field: [
    { name: "Alpha", strategy: "aggressive", archetype: "rusher" },
    { name: "Beta", strategy: "economic", archetype: null },
    { name: "Gamma", strategy: "default" },
  ],
  difficulty: "hard",
  worlds: ["ferros", "korrath"],
  seeds: 2,
  seedBase: 42,
});

test("buildTournamentJob produces exactly the tournament job message shape, and is deterministic", () => {
  const job = buildTournamentJob(fixedTournamentCfg());
  assert.deepEqual(job, {
    kind: "tournament",
    format: "swiss",
    field: [
      { name: "Alpha", strategy: "aggressive", archetype: "rusher" },
      { name: "Beta", strategy: "economic", archetype: null },
      { name: "Gamma", strategy: "default", archetype: null },
    ],
    difficulty: "hard",
    worlds: ["ferros", "korrath"],
    seeds: 2,
    seedBase: 42,
  });
  assert.deepEqual(buildTournamentJob(fixedTournamentCfg()), job, "the same config must build a byte-identical job");
});

test("buildTournamentJob carries a Swiss round override only for Swiss, and only when given", () => {
  assert.equal("rounds" in buildTournamentJob(fixedTournamentCfg()), false, "an unset round count is the worker's own default");
  assert.equal(buildTournamentJob({ ...fixedTournamentCfg(), rounds: 5 }).rounds, 5);
  assert.equal("rounds" in buildTournamentJob({ ...fixedTournamentCfg(), format: "knockout", rounds: 5 }), false,
    "a knockout has no round count to override -- n-1 pairings whatever happens");
  assert.equal("rounds" in buildTournamentJob({ ...fixedTournamentCfg(), format: "round-robin", rounds: 5 }), false);
});

test("buildTournamentJob keeps ONE shared difficulty for the whole tournament (D2), never a per-entrant one", () => {
  const job = buildTournamentJob({
    ...fixedTournamentCfg(),
    field: fixedTournamentCfg().field.map(e => ({ ...e, difficulty: "brutal" })),
  });
  assert.equal(job.difficulty, "hard");
  for (const entrant of job.field)
    assert.deepEqual(Object.keys(entrant).sort(), ["archetype", "name", "strategy"],
      "an entrant carries name/strategy/archetype only -- a per-entrant difficulty would break the bracket's whole fairness rule");
});

test("buildTournamentJob requires at least 2 entrants and rejects duplicate names", () => {
  assert.throws(() => buildTournamentJob({ ...fixedTournamentCfg(), field: [] }), /at least 2/i);
  assert.throws(() => buildTournamentJob({ ...fixedTournamentCfg(), field: [{ name: "Solo" }] }), /at least 2/i);
  assert.throws(() => buildTournamentJob({
    ...fixedTournamentCfg(), field: [{ name: "Alpha" }, { name: " Alpha " }, { name: "Beta" }],
  }), /same name|duplicate|different/i);
});

test("buildTournamentJob trims names, defaults strategy, and coerces an unknown archetype to null", () => {
  const job = buildTournamentJob({
    ...fixedTournamentCfg(),
    field: [{ name: "  Alpha  " }, { name: "Beta", archetype: "not-a-real-archetype" }, { name: "Gamma", archetype: "__proto__" }],
  });
  assert.deepEqual(job.field, [
    { name: "Alpha", strategy: "default", archetype: null },
    { name: "Beta", strategy: "default", archetype: null },
    { name: "Gamma", strategy: "default", archetype: null },
  ]);
  assert.throws(() => buildTournamentJob({ ...fixedTournamentCfg(), field: [{ name: "  " }, { name: "Beta" }] }), /name/i);
});

test("buildTournamentJob rejects an unknown format and an empty world list, before any Worker spins up", () => {
  assert.throws(() => buildTournamentJob({ ...fixedTournamentCfg(), format: "battle-royale" }), /format/i);
  assert.throws(() => buildTournamentJob({ ...fixedTournamentCfg(), worlds: [] }), /world/i);
});

test("buildTournamentJob copies the field and worlds arrays rather than aliasing the caller's", () => {
  const cfg = fixedTournamentCfg();
  const job = buildTournamentJob(cfg);
  job.worlds.push("vesper");
  job.field.push({ name: "Intruder", strategy: "default", archetype: null });
  assert.equal(cfg.worlds.length, 2);
  assert.equal(cfg.field.length, 3);
});

test("buildTournamentJob clamps seeds and coerces seedBase the same way buildJob already does", () => {
  assert.equal(buildTournamentJob({ ...fixedTournamentCfg(), seeds: 2.9 }).seeds, 2);
  assert.equal(buildTournamentJob({ ...fixedTournamentCfg(), seeds: 0 }).seeds, 1);
  assert.equal(buildTournamentJob({ ...fixedTournamentCfg(), seedBase: -1 }).seedBase, 0xFFFFFFFF);
});

/* ---------- seedFieldByRating: the knockout's seeding, which pairing.js deliberately never invents ---------- */

test("seedFieldByRating orders a knockout field strongest-first off the bracket's own ratings table", () => {
  const table = { Alpha: { rating: 1180, games: 12 }, Beta: { rating: 1320, games: 9 }, Gamma: { rating: 1240, games: 4 } };
  const seeded = seedFieldByRating([{ name: "Alpha" }, { name: "Beta" }, { name: "Gamma" }], table);
  assert.deepEqual(seeded.map(e => e.name), ["Beta", "Gamma", "Alpha"]);
});

test("seedFieldByRating falls back to name order for anyone unrated, and never mutates its input", () => {
  const field = [{ name: "Zeta" }, { name: "Alpha" }, { name: "Mu" }];
  const seeded = seedFieldByRating(field, {});
  assert.deepEqual(seeded.map(e => e.name), ["Alpha", "Mu", "Zeta"], "an unrated field seeds alphabetically, deterministically");
  assert.deepEqual(field.map(e => e.name), ["Zeta", "Alpha", "Mu"], "the caller's array must be left alone");
  // An entrant with a rating outranks an unrated one only if that rating is actually higher --
  // ratingLookup's own INITIAL_RATING default is what an unrated entrant is compared at.
  const mixed = seedFieldByRating([{ name: "Zeta" }, { name: "Alpha" }], { Zeta: { rating: INITIAL_RATING + 100, games: 3 } });
  assert.deepEqual(mixed.map(e => e.name), ["Zeta", "Alpha"]);
});

/* ---------- tournamentProgressLabel: real round/pairing granularity, not one opaque spinner ---------- */

test("tournamentProgressLabel names the round AND the pairing for a multi-round format", () => {
  const label = tournamentProgressLabel({ format: "swiss", round: 2, roundTotal: 4, pairing: 3, pairingTotal: 8, completed: 12, total: 128 });
  assert.match(label, /round 2 of 4/i);
  assert.match(label, /pairing 3 of 8/i);
  assert.match(label, /12 of 128/, "the match counter still has to be visible");
});

test("tournamentProgressLabel drops the round clause for a round-robin, which is one flat round", () => {
  const label = tournamentProgressLabel({ format: "round-robin", round: 1, roundTotal: 1, pairing: 5, pairingTotal: 15, completed: 20, total: 60 });
  assert.match(label, /pairing 5 of 15/i);
  assert.doesNotMatch(label, /round 1 of 1/i);
});

/* ---------- tournamentStandingsRows / shapeTournamentStandings ---------- */

test("tournamentStandingsRows tallies completed pairings into wins/losses/draws, ranked best-first", () => {
  const rows = tournamentStandingsRows(["Alpha", "Beta", "Gamma"], [
    { aName: "Alpha", bName: "Beta", aWins: 3, bWins: 1, draws: 0 },
    { aName: "Alpha", bName: "Gamma", aWins: 2, bWins: 2, draws: 0 },
  ]);
  assert.deepEqual(rows.map(r => r.name), ["Alpha", "Gamma", "Beta"], "ranked by win rate, ties broken the same way pairing.js's rankStandings does");
  const alpha = rows.find(r => r.name === "Alpha");
  assert.deepEqual([alpha.wins, alpha.losses, alpha.draws, alpha.byes], [5, 3, 0, 0]);
});

test("tournamentStandingsRows lists an entrant that has not played yet at 0-0-0 rather than omitting it", () => {
  const rows = tournamentStandingsRows(["Alpha", "Beta", "Gamma"], [{ aName: "Alpha", bName: "Beta", aWins: 1, bWins: 0, draws: 0 }]);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.find(r => r.name === "Gamma"), { name: "Gamma", wins: 0, losses: 0, draws: 0, byes: 0 });
});

test("tournamentStandingsRows counts a bye as a bye and NEVER as a win (pairing.js's own rule)", () => {
  const rows = tournamentStandingsRows(["Alpha", "Beta", "Gamma"],
    [{ aName: "Alpha", bName: "Beta", aWins: 2, bWins: 0, draws: 0 }], ["Gamma"]);
  const gamma = rows.find(r => r.name === "Gamma");
  assert.deepEqual([gamma.wins, gamma.losses, gamma.draws, gamma.byes], [0, 0, 0, 1]);
  assert.equal(rows[0].name, "Alpha", "a candidate that only sat out a round can't outrank one that won a real pairing");
});

test("tournamentStandingsRows reproduces buildSwissBracket's OWN standings from the pairings it reports", () => {
  // The live standings the progress view builds pairing-by-pairing must land on exactly the table
  // the finished bracket reports -- otherwise the number moving on screen means something different
  // from the number the results view finally shows.
  const bracket = buildSwissBracket(tField(5), 3, { worlds: ["korrath"], seeds: 1 }, fakePair);
  const pairings = bracket.roundsLog.flatMap(r => r.matches);
  const byeNames = bracket.roundsLog.map(r => r.byeName).filter(Boolean);
  const live = tournamentStandingsRows(tField(5).map(e => e.name), pairings, byeNames);
  assert.deepEqual(live, bracket.standings.map(r => ({ name: r.name, wins: r.wins, losses: r.losses, draws: r.draws, byes: r.byes })));
});

test("shapeTournamentStandings formats a row for display without recomputing any of it", () => {
  assert.deepEqual(shapeTournamentStandings([{ name: "Alpha", wins: 5, losses: 3, draws: 1, byes: 2 }]), [
    { name: "Alpha", record: "5-3-1", wins: 5, losses: 3, draws: 1, byes: 2 },
  ]);
});

test("shapeTournamentStandings preserves its input order (the ranking is tournamentStandingsRows' job)", () => {
  const rows = [{ name: "B", wins: 0, losses: 1, draws: 0, byes: 0 }, { name: "A", wins: 1, losses: 0, draws: 0, byes: 0 }];
  assert.deepEqual(shapeTournamentStandings(rows).map(r => r.name), ["B", "A"]);
});

/* ---------- shapeBracketView: the knockout picture, shaped off a REAL pairing.js bracket ---------- */

test("shapeBracketView turns a finished bracket into one column per round, ending in a champion", () => {
  const bracket = buildKnockoutBracket(tField(4), {}, fakePair);
  const view = shapeBracketView(bracket);
  assert.equal(view.champion, "S00");
  assert.equal(view.rounds.length, 2);
  assert.deepEqual(view.rounds.map(r => r.round), [1, 2]);
  assert.deepEqual(view.rounds.map(r => r.matches.length), [2, 1]);
  assert.deepEqual(view.rounds[1].matches[0], {
    round: 2, a: "S00", b: "S02", bye: false, winner: "S00", aWon: true, bWon: false, score: "2-0",
  });
});

test("shapeBracketView names the closing rounds Final/Semifinals/Quarterfinals, numbering the rest", () => {
  assert.deepEqual(shapeBracketView(buildKnockoutBracket(tField(2), {}, fakePair)).rounds.map(r => r.title), ["Final"]);
  assert.deepEqual(shapeBracketView(buildKnockoutBracket(tField(4), {}, fakePair)).rounds.map(r => r.title), ["Semifinals", "Final"]);
  assert.deepEqual(shapeBracketView(buildKnockoutBracket(tField(8), {}, fakePair)).rounds.map(r => r.title),
    ["Quarterfinals", "Semifinals", "Final"]);
  assert.deepEqual(shapeBracketView(buildKnockoutBracket(tField(16), {}, fakePair)).rounds.map(r => r.title),
    ["Round 1", "Quarterfinals", "Semifinals", "Final"]);
});

test("shapeBracketView renders a non-power-of-two field's first-round byes as visible BYE slots", () => {
  // 6 entrants: nextPow2(6) - 6 = 2 byes off the top, then two real matches (pairing.js's own rule).
  const view = shapeBracketView(buildKnockoutBracket(tField(6), {}, fakePair));
  const round1 = view.rounds[0].matches;
  assert.equal(round1.length, 4);
  assert.deepEqual(round1.filter(m => m.bye).map(m => m.a), ["S00", "S01"]);
  for (const m of round1.filter(m => m.bye)) {
    assert.equal(m.b, null, "a bye has no opponent -- the view has to say so rather than render an empty name");
    assert.equal(m.winner, m.a, "a bye advances its own entrant");
    assert.equal(m.aWon, true);
    assert.equal(m.bWon, false);
  }
  assert.equal(view.rounds.reduce((s, r) => s + r.matches.filter(m => !m.bye).length, 0), knockoutMatchCount(6),
    "the rendered bracket must show exactly the n-1 matches that really ran");
});

test("shapeBracketView marks exactly one winner per played match, and it is the entrant that advanced", () => {
  const bracket = buildKnockoutBracket(tField(5), {}, fakePair);
  const view = shapeBracketView(bracket);
  for (const round of view.rounds)
    for (const m of round.matches) {
      assert.equal(m.aWon !== m.bWon, true, `${m.a}/${m.b}: exactly one side may be flagged as the winner`);
      assert.equal(m.winner, m.aWon ? m.a : m.b);
    }
  const finalMatch = view.rounds.at(-1).matches[0];
  assert.equal(view.champion, finalMatch.winner, "the champion is whoever won the final, never re-derived some other way");
});

test("shapeBracketView reads names only -- it never assumes the worker shipped the match rows back inside the tree", () => {
  // competitionWorker.js posts the bracket with each pairing's rows stripped out (they travel once,
  // in the pairings list, for the ledger). The view must be shapeable from what actually arrives.
  const bracket = buildKnockoutBracket(tField(5), {}, fakePair);
  const lean = JSON.parse(JSON.stringify(bracket));
  for (const r of lean.rounds) for (const m of r.matches) if (m.result) delete m.result.rows;
  assert.deepEqual(shapeBracketView(lean), shapeBracketView(bracket));
});

/* ============================================================
   PHASE 4 (docs/competitions-and-elo.md, D4/D6) — THE GAUNTLET's pure half: the config -> start
   construction competitionLedger.js's own startGauntlet consumes, the fixture-list shaping the
   in-progress screen renders, next-fixture resolution, the live match's own outcome mapping
   (state.winner -> the gauntlet's "human"/"opponent"/"draw" vocabulary), and the completion
   summary with its per-opponent rating change.

   Same "no DOM, no Worker, no real match" discipline as everything above: every ledger below is a
   real one built through competitionLedger.js's own exports, and the one function that reads a
   game STATE is fed a real engine state built by createGameState — never a hand-shaped stub, since
   the score margin it computes comes from engine/victory.js's own playerScore.
   ============================================================ */

const BOTS = n => Array.from({ length: n }, (_, i) => `Bot${i + 1}`);

// A ledger with the human plus `n` AI entrants, and a gauntlet already started over all of them.
function gauntletLedger(n = 3, opts = {}) {
  const ledger = createLedger();
  addRosterEntry(ledger, { name: "You", human: true, faction: "frontier" });
  for (const name of BOTS(n)) addRosterEntry(ledger, { name, strategy: "aggressive" });
  startGauntlet(ledger, {
    field: BOTS(n), difficulty: "medium", matchTimeLimit: 1200, seedBase: 99,
    worlds: ["ferros", "korrath"], ...opts,
  });
  return ledger;
}

/* ---------- D4: the seat-asymmetry disclosure is a real, stated sentence, not a tooltip ---------- */

test("SEAT_DISCLOSURE states all three facts of D4: the seat, the missing side-swap, and which side the edge favours", () => {
  assert.equal(typeof SEAT_DISCLOSURE, "string");
  assert.match(SEAT_DISCLOSURE, /"player"/, "it must name the seat the human always plays");
  assert.match(SEAT_DISCLOSURE, /side-?swap/i, "it must say side-swap cannot balance it");
  assert.match(SEAT_DISCLOSURE, /"ai"/, "it must name the seat the known edge favours");
  assert.ok(SEAT_DISCLOSURE.length > 80, "one plain line of real disclosure, not a three-word label");
});

/* ---------- the up-front cost: ONE live match per opponent, and what that means in real time ---------- */

test("gauntletEstimate prices a gauntlet as one LIVE match per opponent, in real wall-clock play time", () => {
  const quick = gauntletEstimate({ opponents: 5, matchTimeLimit: 1200 });
  assert.equal(quick.matches, 5, "one match per opponent — never worlds x seeds x sides, which is what makes this playable");
  assert.equal(quick.seconds, 5 * 1200);
  assert.match(quick.timeText, /1 h 40 min/);
  assert.match(quick.text, /5 live matches/);

  const standard = gauntletEstimate({ opponents: 5, matchTimeLimit: 2400 });
  assert.ok(standard.seconds > 3 * 3600, "the same field at Standard really is over three hours — the config screen has to say so");
  assert.match(standard.timeText, /3 h 20 min/);
});

test("gauntletEstimate defaults an unset match length to Quick, and reads a single opponent in the singular", () => {
  assert.equal(gauntletEstimate({ opponents: 3 }).seconds, 3 * GAUNTLET_DEFAULT_MATCH_SECONDS);
  assert.match(gauntletEstimate({ opponents: 1, matchTimeLimit: 1200 }).text, /1 live match\b/);
  assert.equal(gauntletEstimate({}).matches, 0, "no opponents picked yet is 0 matches, not a crash");
});

/* ---------- config -> start-state construction ---------- */

const startCfg = (over = {}) => ({
  field: BOTS(3), difficulty: "hard", matchTimeLimit: 1200,
  worlds: ["ferros", "korrath"], seedBase: 7, humanName: "You", ...over,
});

test("buildGauntletStart shapes exactly the opts competitionLedger.js's startGauntlet consumes, deterministically", () => {
  const a = buildGauntletStart(startCfg());
  assert.deepEqual(a, {
    field: ["Bot1", "Bot2", "Bot3"], difficulty: "hard", matchTimeLimit: 1200,
    worlds: ["ferros", "korrath"], seedBase: 7,
  });
  assert.deepEqual(buildGauntletStart(startCfg()), a, "same config in, byte-identical start opts out");
});

test("buildGauntletStart's output really does start a gauntlet — the two halves are wired to each other, not merely similar", () => {
  const ledger = createLedger();
  addRosterEntry(ledger, { name: "You", human: true });
  for (const name of BOTS(3)) addRosterEntry(ledger, { name });
  startGauntlet(ledger, { ...buildGauntletStart(startCfg()), at: 1234 });
  assert.deepEqual(ledger.gauntlet.field, BOTS(3));
  assert.equal(ledger.gauntlet.difficulty, "hard");
  assert.equal(ledger.gauntlet.matchTimeLimit, 1200);
  assert.equal(ledger.gauntlet.schedule.length, 3);
  assert.ok(ledger.gauntlet.schedule.every(f => f.world === "ferros" || f.world === "korrath"),
    "the world pool the config screen picked is the pool the schedule drew from");
});

test("buildGauntletStart defaults the match length to Quick — the Phase 4 brief's own default", () => {
  assert.equal(buildGauntletStart({ ...startCfg(), matchTimeLimit: undefined }).matchTimeLimit, GAUNTLET_DEFAULT_MATCH_SECONDS);
  assert.equal(GAUNTLET_DEFAULT_MATCH_SECONDS, 1200);
});

test("buildGauntletStart rejects an empty field, a duplicate opponent, the human themself, and an empty world pool", () => {
  assert.throws(() => buildGauntletStart({ ...startCfg(), field: [] }), /at least one opponent/i);
  assert.throws(() => buildGauntletStart({ ...startCfg(), field: ["Bot1", "Bot1"] }), /twice/i);
  assert.throws(() => buildGauntletStart({ ...startCfg(), field: ["Bot1", "You"] }), /yourself/i);
  assert.throws(() => buildGauntletStart({ ...startCfg(), worlds: [] }), /world/i);
});

/* ---------- the fixture list: what the in-progress screen renders ---------- */

test("shapeGauntletFixtures gives one row per fixture, in play order, with the world named for display", () => {
  const rows = shapeGauntletFixtures(gauntletLedger(3));
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(r => r.number), [1, 2, 3]);
  assert.deepEqual(rows.map(r => r.opponent), BOTS(3));
  for (const row of rows) {
    assert.equal(row.worldName, planetName(row.world), "the world is resolved to its real display name, never a raw id");
    assert.equal(typeof row.swapAsym, "boolean");
  }
  assert.deepEqual(shapeGauntletFixtures(createLedger()), [], "no gauntlet, no fixtures");
});

test("shapeGauntletFixtures marks each fixture played/won/lost/forfeited, the one that's next, and the ones still pending", () => {
  const ledger = gauntletLedger(4);
  assert.deepEqual(shapeGauntletFixtures(ledger).map(r => r.status), ["next", "pending", "pending", "pending"]);

  recordGauntletMatch(ledger, { winner: "human", margin: 21 });
  recordGauntletMatch(ledger, { winner: "opponent", margin: -9 });
  recordGauntletForfeit(ledger, {});

  const rows = shapeGauntletFixtures(ledger);
  assert.deepEqual(rows.map(r => r.status), ["won", "lost", "forfeit", "next"]);
  assert.deepEqual(rows.map(r => r.statusLabel), ["Won", "Lost", "Forfeited", "Next up"]);
  assert.deepEqual(rows.map(r => r.played), [true, true, true, false]);
  assert.deepEqual(rows.map(r => r.current), [false, false, false, true]);
  assert.equal(rows[0].margin, 21, "a played fixture carries its own score margin, human-relative");
  assert.equal(rows[3].margin, null, "an unplayed one has no margin to show");
});

test("shapeGauntletFixtures reads a DRAW as its own status, never as a loss", () => {
  const ledger = gauntletLedger(2);
  recordGauntletMatch(ledger, { winner: "draw", margin: 0 });
  assert.equal(shapeGauntletFixtures(ledger)[0].status, "drawn");
});

/* ---------- next-fixture resolution: what Play Next Match actually boots ---------- */

test("nextGauntletFixture resolves everything a live match needs to boot, plus its own display label", () => {
  const ledger = gauntletLedger(3);
  const next = nextGauntletFixture(ledger);
  assert.equal(next.index, 0);
  assert.equal(next.number, 1);
  assert.equal(next.total, 3);
  assert.equal(next.opponent, "Bot1");
  assert.equal(next.humanName, "You");
  assert.equal(next.difficulty, "medium", "the gauntlet's ONE pinned difficulty rides along (D2)");
  assert.equal(next.matchTimeLimit, 1200);
  assert.equal(next.seed, ledger.gauntlet.schedule[0].seed, "the seed comes from the SCHEDULE, never freshly rolled (D6)");
  assert.equal(next.world, ledger.gauntlet.schedule[0].world);
  assert.equal(next.swapAsym, false);
  assert.equal(next.worldName, planetName(next.world));
  assert.match(next.label, /Bot1/);
  assert.match(next.label, /1 of 3/);
});

test("nextGauntletFixture advances exactly one fixture per recorded result, and is null once the run is done", () => {
  const ledger = gauntletLedger(2);
  assert.equal(nextGauntletFixture(createLedger()), null, "no gauntlet, no next fixture");
  recordGauntletMatch(ledger, { winner: "human" });
  assert.equal(nextGauntletFixture(ledger).opponent, "Bot2");
  assert.equal(nextGauntletFixture(ledger).swapAsym, true, "the map's asym halves alternate by match index (D4's one available correction)");
  recordGauntletMatch(ledger, { winner: "human" });
  assert.equal(nextGauntletFixture(ledger), null, "a finished gauntlet has no next match to offer");
});

/* ---------- result capture: a finished game state -> the gauntlet's own vocabulary ---------- */

function finishedState(winner, winReason = "elimination") {
  const state = createGameState({ planetId: "ferros", seed: 5, rng: mulberry32(5) });
  state.over = true;
  state.winner = winner;
  state.winReason = winReason;
  state.time = 612.5;
  return state;
}

test("humanMatchOutcome maps the ENGINE's owner ids into the gauntlet's own human/opponent/draw vocabulary", () => {
  assert.equal(humanMatchOutcome(finishedState("player")).winner, "human",
    "the human is always owner \"player\" (D4) — a player win is a human win");
  assert.equal(humanMatchOutcome(finishedState("ai")).winner, "opponent");
  assert.equal(humanMatchOutcome(finishedState(null, null)).winner, "draw", "no winner at all is a draw, not a crash");
  for (const winner of ["player", "ai", null])
    assert.ok(["human", "opponent", "draw"].includes(humanMatchOutcome(finishedState(winner)).winner),
      "recordGauntletMatch only accepts its own three words — an owner id must never leak through");
});

test("humanMatchOutcome reports the score margin from the HUMAN's own side, plus the match's time and reason", () => {
  const state = finishedState("player", "timeout-score");
  const out = humanMatchOutcome(state);
  assert.equal(out.margin, +(playerScore(state, "player") - playerScore(state, "ai")).toFixed(1),
    "margin is the human's score minus the opponent's — the same aName-relative convention every ledger row uses");
  assert.equal(out.time, 612.5);
  assert.equal(out.winReason, "timeout-score");
  assert.equal(humanMatchOutcome(finishedState("ai", null)).winReason, null, "a missing reason stays null, never undefined");
});

test("humanMatchOutcome's result is accepted verbatim by recordGauntletMatch", () => {
  const ledger = gauntletLedger(2);
  recordGauntletMatch(ledger, { ...humanMatchOutcome(finishedState("player")), at: 1 });
  assert.equal(ledger.gauntlet.results[0].winner, "human");
  assert.equal(ledger.history[0].rows[0].seatSwapped, false, "and lands as a disclosed, non-side-swapped human row (D4)");
});

/* ---------- the completion summary, and the per-opponent rating change ---------- */

test("gauntletLadderTrail reports the human's rating before and after EACH gauntlet match, in play order", () => {
  const ledger = gauntletLedger(3);
  recordGauntletMatch(ledger, { winner: "human", margin: 10 });
  recordGauntletMatch(ledger, { winner: "opponent", margin: -4 });

  const trail = gauntletLadderTrail(ledger);
  assert.deepEqual(trail.map(t => t.index), [0, 1]);
  assert.deepEqual(trail.map(t => t.opponent), ["Bot1", "Bot2"]);
  assert.equal(trail[0].before.rating, INITIAL_RATING, "the human starts the run at the ordinary starting rating");
  assert.ok(trail[0].change > 0, "beating Bot1 moved the rating up");
  assert.ok(trail[1].change < 0, "losing to Bot2 moved it back down");
  assert.equal(trail[1].before.rating, trail[0].after.rating,
    "each match starts from where the previous one left off — Elo is order-dependent (D6)");
  assert.deepEqual(gauntletLadderTrail(createLedger()), []);
});

test("shapeGauntletSummary is the whole run: the standing, the record, every fixture's rating change, and the disclosure", () => {
  const ledger = gauntletLedger(3);
  recordGauntletMatch(ledger, { winner: "human", margin: 15 });
  recordGauntletMatch(ledger, { winner: "opponent", margin: -6 });
  recordGauntletForfeit(ledger, {});

  const summary = shapeGauntletSummary(ledger);
  assert.equal(summary.humanName, "You");
  assert.equal(summary.difficulty, "medium");
  assert.equal(summary.complete, true);
  assert.equal(summary.record, "1-2-0", "a forfeit is a loss like any other — it is rated, not dropped");
  assert.equal(summary.forfeits, 1);
  assert.deepEqual(summary.rows.map(r => r.status), ["won", "lost", "forfeit"]);
  assert.equal(summary.rows[0].change > 0, true);
  assert.ok(summary.rows.every(r => Number.isFinite(r.change)), "every played fixture reports its own rating change");
  assert.equal(summary.rating.games, 3, "three rated matches, in the gauntlet's own bracket");
  assert.equal(summary.disclosure, SEAT_DISCLOSURE, "the seat disclosure travels WITH the standing it qualifies (D4)");

  const net = summary.rows.reduce((sum, r) => sum + (r.change || 0), 0);
  assert.equal(summary.netChange, net, "the run's net change is exactly the sum of its matches' changes");
});

test("shapeGauntletSummary reads a half-played run too — that is what a resumed gauntlet shows", () => {
  const ledger = gauntletLedger(4);
  recordGauntletMatch(ledger, { winner: "human", margin: 2 });
  const summary = shapeGauntletSummary(ledger);
  assert.equal(summary.complete, false);
  assert.equal(summary.played, 1);
  assert.equal(summary.remaining, 3);
  assert.equal(summary.record, "1-0-0");
  assert.equal(summary.rows[1].status, "next");
  assert.equal(summary.rows[1].change, null, "an unplayed fixture has no rating change to claim");
  assert.equal(shapeGauntletSummary(createLedger()), null, "no gauntlet, no summary");
});

/* ---------- mostRelevantBracket: opening Standings from the TAB lands somewhere real ---------- */

test("mostRelevantBracket keeps the preferred bracket whenever that bracket already has results", () => {
  const ledger = gauntletLedger(2, { difficulty: "hard" });
  recordGauntletMatch(ledger, { winner: "human", margin: 10 });
  // "hard" now has rated rows; a player already looking at hard stays on hard.
  assert.equal(mostRelevantBracket("hard", ledger), "hard");
});

test("mostRelevantBracket falls to the gauntlet's own bracket rather than showing an empty table", () => {
  // The real failure this fixes: finish a HARD gauntlet, click the Standings TAB (which carries
  // whatever bracket was last viewed -- "medium" by default), and the screen reads "Nobody has
  // played a rated match at this difficulty yet" while three rated games sit one bracket away.
  const ledger = gauntletLedger(2, { difficulty: "hard" });
  recordGauntletMatch(ledger, { winner: "human", margin: 10 });
  assert.equal(standingsFor(ledger, "medium").length, 0, "fixture sanity: medium really is empty");
  assert.equal(mostRelevantBracket("medium", ledger), "hard",
    "an empty preferred bracket must yield to the bracket the player was actually playing in");
});

test("mostRelevantBracket returns the preferred bracket unchanged when NOTHING is rated anywhere", () => {
  // With no results at all there is genuinely nothing to show, and silently hopping brackets would
  // be worse than the honest empty-state -- so the preferred bracket comes back untouched.
  const ledger = createLedger();
  addRosterEntry(ledger, { name: "Solo", strategy: "default" });
  assert.equal(mostRelevantBracket("medium", ledger), "medium");
});

test("mostRelevantBracket is deterministic when several brackets have results and none is preferred", () => {
  // Falls through DIFFICULTY_OPTIONS order rather than object key insertion order, so the same
  // ledger always opens on the same bracket.
  const ledger = createLedger();
  addRosterEntry(ledger, { name: "A", strategy: "default" });
  addRosterEntry(ledger, { name: "B", strategy: "aggressive" });
  const row = (aName, bName) => [{ aName, bName, winner: "a", margin: 5 }];
  recordCompetition(ledger, { difficulty: "hard", aName: "A", bName: "B", rows: row("A", "B") });
  recordCompetition(ledger, { difficulty: "easy", aName: "A", bName: "B", rows: row("A", "B") });
  const first = mostRelevantBracket("medium", ledger);
  assert.equal(first, mostRelevantBracket("medium", ledger), "same ledger, same answer, every time");
  assert.ok(["easy", "hard"].includes(first), "and it is one of the brackets that actually has rows");
});

/* ============================================================
   WATCHING A MATCH LIVE (docs/competitions-and-elo.md Phase 5) — the pure half: the config a
   watched match is booted from, and the exhibition framing that says it isn't rated.
   ============================================================ */

const watchJob = () => buildJob({
  entrantA: { name: "Alpha", strategy: "aggressive", archetype: "rusher" },
  entrantB: { name: "Beta", strategy: "economic", archetype: "economist" },
  difficulty: "hard",
  worlds: ["korrath", "ferros"],
  seeds: 2,
  seedBase: 42,
});

test("buildWatchConfig seats the entrants exactly the way the simulated path does", () => {
  const job = watchJob();
  const cfg = buildWatchConfig(job);

  // tools/duelCore.js's runDuelMatch: entrant A owns "player", entrant B owns "ai". A watched
  // match has to agree, or "who won" would be reported for the wrong entrant.
  assert.equal(cfg.aName, "Alpha");
  assert.equal(cfg.bName, "Beta");
  assert.equal(cfg.playerAi.strategy, "aggressive");
  assert.equal(cfg.playerAi.archetype, "rusher");
  assert.equal(cfg.ai.strategy, "economic");
  assert.equal(cfg.ai.archetype, "economist");
});

test("buildWatchConfig pins ONE difficulty dial set onto both seats, like every rated match", () => {
  const cfg = buildWatchConfig(watchJob());
  const dials = pinnedDuelDials("hard");
  for (const seat of [cfg.ai, cfg.playerAi]) {
    assert.equal(seat.difficulty, dials.difficulty);
    assert.equal(seat.apm, dials.apm);
    assert.equal(seat.micro, dials.micro);
  }
});

test("buildWatchConfig draws the SAME world/seed/asym the worker would have run for that replicate", () => {
  const job = watchJob();
  const first = buildWatchConfig(job);
  assert.equal(first.world, "korrath", "the first picked world by default");
  assert.equal(first.seed, matchSeedFor(job, "korrath", 0), "the schedule's own seed, not a fresh roll");
  assert.equal(first.seed, duelSeed(42, "korrath", "hard", "Alpha", "Beta", 0));
  assert.equal(first.swapAsym, false, "replicate 0 keeps the map's own halves");

  const second = buildWatchConfig(job, { world: "ferros", rep: 1 });
  assert.equal(second.world, "ferros");
  assert.equal(second.seed, matchSeedFor(job, "ferros", 1));
  assert.equal(second.swapAsym, true, "replicate parity flips the asym halves, same rule as the worker");
});

test("buildWatchConfig refuses a world the job never scheduled", () => {
  assert.throws(() => buildWatchConfig(watchJob(), { world: "not-a-world" }), /world/i);
});

test("buildWatchConfig's opts build a real self-play state that both AIs actually drive", () => {
  const cfg = buildWatchConfig(watchJob());
  const state = createSelfPlayState({
    planetId: cfg.world, seed: cfg.seed, swapAsym: cfg.swapAsym,
    matchTimeLimit: cfg.matchTimeLimit, ai: cfg.ai, playerAi: cfg.playerAi,
  });
  assert.ok(state.playerAi, "the SECOND controller exists — this is what makes both seats AI-driven");
  assert.equal(state.playerAi.strategy, "aggressive");
  assert.equal(state.ai.strategy, "economic");
  // Both controllers really do act: run a slice and check each side has ordered something.
  for (let i = 0; i < 600; i++) tickSelfPlay(state);
  const owners = new Set([...state.units.values()].map(u => u.owner));
  assert.ok(owners.has("player") && owners.has("ai"), "both seats field units");
});

test("EXHIBITION_NOTE states plainly that a watched match changes no rating", () => {
  assert.match(EXHIBITION_NOTE, /exhibition/i);
  assert.match(EXHIBITION_NOTE, /not|no/i);
  assert.match(EXHIBITION_NOTE, /rating|rated|ladder/i);
  // The REASON has to be there too, not just the claim — a single unswapped match is not the
  // side-swapped, multi-seed pairing every rated row in this system is built from.
  assert.match(EXHIBITION_NOTE, /swap/i);
});

test("spectatedMatchOutcome names the WINNING ENTRANT, never \"you\"", () => {
  const state = createGameState({ planetId: "ferros", seed: 5, rng: mulberry32(5) });
  const watch = { aName: "Alpha", bName: "Beta" };

  state.over = true; state.winner = "player"; state.winReason = "elimination";
  const aWon = spectatedMatchOutcome(state, watch);
  assert.equal(aWon.winnerName, "Alpha");
  assert.match(aWon.verdict, /Alpha/);
  assert.doesNotMatch(aWon.verdict, /\b(you|your|victory|defeat)\b/i,
    "nobody watching a match won or lost it");

  state.winner = "ai";
  assert.equal(spectatedMatchOutcome(state, watch).winnerName, "Beta");

  state.winner = null;
  const drawn = spectatedMatchOutcome(state, watch);
  assert.equal(drawn.winnerName, null);
  assert.match(drawn.verdict, /draw/i);
});

test("spectatedMatchOutcome carries both entrants' scores, A-relative like every duel row", () => {
  const state = createGameState({ planetId: "ferros", seed: 5, rng: mulberry32(5) });
  state.over = true; state.winner = "player";
  const out = spectatedMatchOutcome(state, { aName: "Alpha", bName: "Beta" });
  assert.equal(out.aScore, +playerScore(state, "player").toFixed(1));
  assert.equal(out.bScore, +playerScore(state, "ai").toFixed(1));
  assert.equal(out.margin, +(out.aScore - out.bScore).toFixed(1));
  assert.equal(out.exhibition, true, "the block itself is flagged as unrated");
});

/* ============================================================
   REPLAYING A FINISHED MATCH (docs/competitions-and-elo.md Phase 5) — a recorded ledger row
   carries its world, its exact seed, its map half and both entrants' configs, so replaying is not
   a recording/playback system at all: it is RE-RUNNING the same deterministic simulation from the
   same inputs (D6).

   THE PROPERTY THIS SECTION EXISTS TO PROVE, rather than assume, is at the bottom: a replay
   reproduces the recorded winner AND score margin EXACTLY. Everything above it is the shaping that
   has to be right for that property to be provable at all — most of all the SEATING, because a
   recorded row is always reported A-relative while the match it describes was played in one of two
   directions, and replaying the wrong direction is a different match between the same two names.
   ============================================================ */

// A ledger holding two DELIBERATELY DIFFERENT entrants (different strategy and different
// archetype) plus one recorded two-row duel — one row per direction, exactly as the worker posts
// them. The asymmetry is the point: a seating bug reproduces silently in a mirror matchup.
const REPLAY_A = { name: "Blitz", strategy: "aggressive", archetype: "rusher", faction: "syndicate" };
const REPLAY_B = { name: "Bulwark", strategy: "economic", archetype: "economist", faction: "miners" };

function replayLedger(rows) {
  const ledger = createLedger();
  addRosterEntry(ledger, REPLAY_A);
  addRosterEntry(ledger, REPLAY_B);
  if (rows) recordCompetition(ledger, { at: 100, difficulty: "medium", aName: REPLAY_A.name, bName: REPLAY_B.name, rows });
  return ledger;
}

// One recorded row, in the worker's own shape. `direction` decides which entrant actually held
// owner "player": "bAsAi" is A, "aAsAi" is B (competitionWorker.js's own two directions).
const recordedRow = (overrides = {}) => ({
  world: "ferros", seed: 12345, difficulty: "medium", swapAsym: false,
  aName: REPLAY_A.name, aStrategy: "aggressive", bName: REPLAY_B.name, bStrategy: "economic",
  aDifficulty: "medium", bDifficulty: "medium", aApm: 65, bApm: 65, aMicro: false, bMicro: false,
  winner: "a", winReason: "elimination", time: 700,
  aScore: 90, bScore: 30, margin: 60, direction: "bAsAi",
  ...overrides,
});

test("buildReplayConfig rebuilds the recorded match's world, seed and map half — never a fresh roll", () => {
  const row = recordedRow();
  const cfg = buildReplayConfig(row, replayLedger([row]));
  assert.equal(cfg.world, "ferros");
  assert.equal(cfg.seed, 12345);
  assert.equal(cfg.swapAsym, false);
  assert.equal(cfg.difficulty, "medium");

  const swapped = buildReplayConfig(recordedRow({ swapAsym: true }), replayLedger([recordedRow()]));
  assert.equal(swapped.swapAsym, true, "the map half is part of what was recorded, not re-derived from parity");
});

test("buildReplayConfig seats each entrant where the RECORDED DIRECTION actually put it", () => {
  const ledger = replayLedger([recordedRow()]);

  // Direction 1: entrant A held owner "player" — runDuelMatch's own fixed mapping.
  const forward = buildReplayConfig(recordedRow({ direction: "bAsAi" }), ledger);
  assert.equal(forward.aName, "Blitz", "aName is whoever held owner \"player\"");
  assert.equal(forward.bName, "Bulwark");
  assert.equal(forward.playerAi.strategy, "aggressive");
  assert.equal(forward.playerAi.archetype, "rusher");
  assert.equal(forward.ai.strategy, "economic");
  assert.equal(forward.ai.archetype, "economist");

  // Direction 2: the row was recorded A-relative, but entrant B is the one that held "player".
  const flipped = buildReplayConfig(recordedRow({ direction: "aAsAi" }), ledger);
  assert.equal(flipped.aName, "Bulwark", "the flipped direction really did seat B as owner \"player\"");
  assert.equal(flipped.bName, "Blitz");
  assert.equal(flipped.playerAi.strategy, "economic");
  assert.equal(flipped.playerAi.archetype, "economist");
  assert.equal(flipped.ai.strategy, "aggressive");
  assert.equal(flipped.ai.archetype, "rusher");
});

test("buildReplayConfig states the recorded outcome from the SEAT's point of view, so a replay can be compared directly", () => {
  const ledger = replayLedger([recordedRow()]);

  const forward = buildReplayConfig(recordedRow({ winner: "a", margin: 60 }), ledger);
  assert.equal(forward.recorded.winnerName, "Blitz");
  assert.equal(forward.recorded.margin, 60);
  assert.equal(forward.recorded.aScore, 90);
  assert.equal(forward.recorded.bScore, 30);

  // Same row, other direction: "a won" still means Blitz won, but Blitz sat in the "ai" seat, so
  // seat-relative the margin is negated and the winner is the B-seat name.
  const flipped = buildReplayConfig(recordedRow({ direction: "aAsAi", winner: "a", margin: 60 }), ledger);
  assert.equal(flipped.recorded.winnerName, "Blitz", "who won is a fact about the ENTRANT, not the seat");
  assert.equal(flipped.recorded.margin, -60, "…but the margin is stated the way the replay will measure it");
  assert.equal(flipped.recorded.aScore, 30);
  assert.equal(flipped.recorded.bScore, 90);

  const drawn = buildReplayConfig(recordedRow({ winner: "draw", margin: 0 }), ledger);
  assert.equal(drawn.recorded.winnerName, null);
});

test("buildReplayConfig pins ONE difficulty dial set onto both seats, exactly as the recorded match ran", () => {
  const cfg = buildReplayConfig(recordedRow({ difficulty: "hard" }), replayLedger([recordedRow()]));
  const dials = pinnedDuelDials("hard");
  for (const seat of [cfg.ai, cfg.playerAi]) {
    assert.equal(seat.difficulty, dials.difficulty);
    assert.equal(seat.apm, dials.apm);
    assert.equal(seat.micro, dials.micro);
  }
});

test("replayableMatch refuses a match a HUMAN played — a person is not a seeded input (D6)", () => {
  const ledger = replayLedger([recordedRow()]);
  const humanRow = recordedRow({ human: true, seatSwapped: false });
  const verdict = replayableMatch(humanRow, ledger);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /human|played|person/i);
  assert.throws(() => buildReplayConfig(humanRow, ledger), /human|played|person/i);
});

test("replayableMatch refuses a match whose entrant is no longer on the roster — its archetype is unrecoverable", () => {
  const ledger = replayLedger([recordedRow()]);
  removeRosterEntry(ledger, "Bulwark");
  const verdict = replayableMatch(recordedRow(), ledger);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /Bulwark/);
  assert.match(verdict.reason, /roster/i);
});

test("replayableMatch refuses a row whose world or seed isn't real", () => {
  const ledger = replayLedger([recordedRow()]);
  assert.equal(replayableMatch(recordedRow({ world: "not-a-world" }), ledger).ok, false);
  assert.equal(replayableMatch(recordedRow({ seed: "soon" }), ledger).ok, false);
  assert.equal(replayableMatch(recordedRow(), ledger).ok, true, "…and accepts a real one");
});

test("REPLAY_NOTE states plainly that a replay re-rates nothing — the match is already counted", () => {
  assert.match(REPLAY_NOTE, /replay/i);
  assert.match(REPLAY_NOTE, /rating|rated|ladder/i);
  assert.match(REPLAY_NOTE, /already/i);
});

test("replayVerdict reports whether the re-run reproduced the recorded result, and says so honestly when it didn't", () => {
  const recorded = { winnerName: "Blitz", margin: 60 };
  const same = replayVerdict({ winnerName: "Blitz", margin: 60 }, recorded);
  assert.equal(same.reproduced, true);
  assert.match(same.line, /reproduc/i);

  const otherWinner = replayVerdict({ winnerName: "Bulwark", margin: -12 }, recorded);
  assert.equal(otherWinner.reproduced, false);
  assert.match(otherWinner.line, /Blitz/, "a divergence has to name what was RECORDED, not only what just happened");

  const otherMargin = replayVerdict({ winnerName: "Blitz", margin: 59.9 }, recorded);
  assert.equal(otherMargin.reproduced, false, "the margin is part of the claim, not just the winner");
});

test("shapeHistoryMatches lists the ledger's recorded matches newest-first, each with its own replayability", () => {
  const ledger = replayLedger([recordedRow(), recordedRow({ direction: "aAsAi", winner: "b", margin: -20 })]);
  recordCompetition(ledger, {
    at: 200, difficulty: "hard", aName: REPLAY_A.name, bName: REPLAY_B.name,
    rows: [recordedRow({ world: "korrath", seed: 7, difficulty: "hard", winner: "b", margin: -5 })],
  });

  const shaped = shapeHistoryMatches(ledger);
  assert.equal(shaped.length, 3);
  assert.equal(shaped[0].world, "korrath", "the most recently recorded competition comes first");
  assert.equal(shaped[0].difficulty, "hard");
  assert.equal(shaped[0].winner, "Bulwark", "the winner reads as an entrant NAME, never \"a\"/\"b\"");
  assert.equal(shaped[0].replayable, true);
  assert.equal(shaped[0].entryIndex, 1);
  assert.equal(shaped[0].rowIndex, 0);
  assert.ok(shaped.every(m => typeof m.side === "string" && m.side.length), "each row says which entrant held which seat");

  assert.deepEqual(shapeHistoryMatches(ledger, { limit: 2 }).length, 2, "the list is capped for display");
  assert.deepEqual(shapeHistoryMatches(createLedger()), [], "an empty ledger shapes to an empty list, never a throw");
});

test("shapeHistoryMatches marks a match it cannot replay, with the reason, instead of hiding it", () => {
  const ledger = replayLedger([recordedRow({ human: true })]);
  const shaped = shapeHistoryMatches(ledger);
  assert.equal(shaped.length, 1, "an unreplayable match is still part of the record");
  assert.equal(shaped[0].replayable, false);
  assert.match(shaped[0].reason, /human|played|person/i);
});

/* ---------- THE PROPERTY ITSELF: a replay really does reproduce what was recorded ----------
   This runs FOUR real matches (two recorded, two replayed) through the same headless path the
   Worker uses, so it costs a few seconds — deliberately, because it is the only assertion in this
   repo that actually PROVES the determinism claim D6 makes rather than restating it. The two
   entrants differ in strategy AND archetype, so replaying the wrong SEAT would show up as a
   different result rather than reproducing by symmetry. */

test("a replay reproduces the recorded winner and score margin EXACTLY, in both recorded directions", () => {
  const job = buildJob({
    entrantA: REPLAY_A, entrantB: REPLAY_B,
    difficulty: "medium", worlds: ["ferros"], seeds: 1, seedBase: 4242,
  });
  const { rows } = runCompetitionJob(job);
  assert.equal(rows.length, 2, "fixture sanity: one duel is both directions of one (world, replicate)");

  const ledger = replayLedger(rows);
  assert.equal(ledger.history.length, 1);

  for (const row of ledger.history[0].rows) {
    const cfg = buildReplayConfig(row, ledger);
    // Exactly what boot.js's startSpectatedMatch feeds createSelfPlayState — same constructor,
    // same fields, so this is the shipped replay path, not a parallel re-implementation of it.
    const state = createSelfPlayState({
      planetId: cfg.world, seed: cfg.seed, swapAsym: cfg.swapAsym,
      matchTimeLimit: cfg.matchTimeLimit, ai: cfg.ai, playerAi: cfg.playerAi,
    });
    runSelfPlayMatch(state);
    const outcome = spectatedMatchOutcome(state, cfg);

    assert.equal(outcome.winnerName, cfg.recorded.winnerName,
      `replaying the ${row.direction} row must reproduce its recorded winner`);
    assert.equal(outcome.margin, cfg.recorded.margin,
      `replaying the ${row.direction} row must reproduce its recorded score margin exactly`);
    assert.equal(outcome.aScore, cfg.recorded.aScore);
    assert.equal(outcome.bScore, cfg.recorded.bScore);
    assert.equal(outcome.winReason, cfg.recorded.winReason, "…down to WHY the match ended");
    assert.equal(replayVerdict(outcome, cfg.recorded).reproduced, true);
  }
});
