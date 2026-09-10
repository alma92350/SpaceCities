/* ============================================================
   Guards for tools/ailab.js — the headless AI bench (see docs/odyssey-ai-review.md).

   The bench exists to answer "did this AI change help?", so the bench itself has to be
   trustworthy in exactly two ways, and the suite pins both:

     1. DETERMINISM. Two runs of the same configuration must produce identical numbers,
        or a "+0.04 improvement" is indistinguishable from noise and the whole loop is
        theatre. The engine is already deterministic; what this guards is that the lab
        (its sparring bots, its sampling cadence, its seed derivation) doesn't smuggle in
        a wall-clock or an unseeded pick.
     2. THE OVERRIDE SEAM. A candidate AI is injected as data into the ARCHETYPES /
        STRATEGIES / DIFFICULTY_OPTIONS tables. If that injection silently no-ops, every
        search result is a measurement of the baseline against itself.

   THIS FILE IS THE FAST HALF, and the split is deliberate. Every test here is pure: it
   scores a hand-written curve, runs a detector, or exercises the Swiss pairing
   combinatorics against fake results. None of them start a sim, so the whole file lands
   in well under a second.

   The half that DOES drive real matches — determinism, the override seam end-to-end, duel
   and evolution and the archive — lives in test/slow/ailab-sweep.test.js and runs under
   `npm run test:slow`. Nothing was deleted or weakened in the move; the 95 tests are the
   same 95 tests.

   WHY: this one file used to take 307s while the entire rest of the suite took under 25s,
   so `npm test` — the command CONTRIBUTING.md tells you to run on every change — was
   gated end-to-end on an AI-tuning sweep that is irrelevant to almost every commit. A
   red-green loop measured in minutes is a loop people stop running. Both halves run in
   CI on every push, as separate jobs; neither is optional, they just aren't serialised
   into the inner loop any more.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  summarise, score, applyOverrides, CHECKS, WORLDS, runSwappedDuel, runDuelBrackets,
  runRoundRobinSwapped, pairRound, rankStandings, buildSwissBracket, snapshotTables, restoreTables,
  ARCHIVE_DIMS, binOf,
} from "../tools/ailab.js";
import { STRATEGIES } from "../engine/aiStrategy.js";

test("applyOverrides merges into an existing row rather than replacing it", () => {
  // Restored afterwards. applyOverrides writes straight into the LIVE shipped table with no undo,
  // and this test had none — so `aggressive.garrisonMult` stayed at 0.9 instead of its shipped 0.4
  // for the rest of the file, and the 21 later tests that select `strategy: "aggressive"` measured a
  // variant the game never ships. Worse, the three "overrides never leak into the next run" tests
  // capture their baseline AFTER this point, so the suite's own leak detector was calibrated
  // against the leaked state. snapshotTables/restoreTables were already exported and simply unused.
  const snap = snapshotTables();
  try {
    applyOverrides({ strategies: { aggressive: { garrisonMult: 0.9 } } });
    assert.equal(STRATEGIES.aggressive.garrisonMult, 0.9, "the overridden field is applied");
    assert.equal(STRATEGIES.aggressive.attackTimeoutMult, 0.55, "…and the untouched fields survive");
  } finally {
    restoreTables(snap);
  }
});

test("every health check is well-formed and covers the whole Odyssey roster", () => {
  const ids = CHECKS.map(c => c.id);
  assert.equal(new Set(ids).size, ids.length, "check ids must be unique — they name findings in reports");
  for (const c of CHECKS) {
    assert.equal(typeof c.hit, "function");
    assert.ok(c.why && c.why.length > 20, `check ${c.id} needs a why: line explaining the mechanism`);
  }
  assert.equal(WORLDS.length, 11, "the lab sweeps the full Odyssey roster (nine skirmish worlds + two extras)");
});

/* ---------- SCALE INVARIANCE: the property that keeps this list honest ----------

   Three of these five detectors have had to be rewritten because they fired on a HEALTHY AI that
   had simply got bigger (2026-07-30 took "any Barracks idle" and a peak-based thrift measure;
   2026-08-05 took supply-deadlock and production-stall — docs/odyssey-ai-review.md §2.12). Each
   time it was caught by a human reading a scoreboard and thinking "that world isn't stuck", which
   is not a mechanism you can rely on.

   This is that judgement written down as a property: take a curve describing an AI that is
   unambiguously doing well, scale every magnitude in it, and assert the whole list stays silent.
   A detector that hard-codes a threshold against one size of economy fails this the moment the
   multiplier grows, which is the whole failure mode, reproduced in a millisecond instead of a
   40-minute sweep. ---------- */

// A curve for an AI that is plainly healthy: developing, growing its army, spending what it earns,
// producing continuously, and never wedged. `k` scales every magnitude — a 1x AI and a 20x AI are
// the SAME behaviour at different sizes, so no detector may distinguish them.
function healthyCurve(k = 1, samples = 30) {
  return Array.from({ length: samples }, (_, i) => ({
    t: i * 60,
    dev: Math.round(2 + i * 0.6),                 // still climbing at the end
    army: Math.round(k * (5 + i * 2)),            // …and still growing
    armyValue: Math.round(k * (5 + i * 2) * 120),
    workers: Math.round(k * 12),
    buildings: Math.round(k * (4 + i)),
    banked: Math.round(k * 900),                  // a working balance, in transit
    stance: -0.2, hostility: 0.3, waves: Math.floor(i / 4),
    rax: Math.max(1, Math.round(k)), idleRax: 0,  // the line is busy
    armyCapped: false,
    canAffordNext: true,                          // …and it could buy more if it wanted
    supplyBlocked: i % 3 === 0,                   // brushes its ceiling constantly, like any busy AI
    habitatPending: false,
    canAffordUnblock: true,
    supplyCapNow: 20 + i * 8,                     // …and keeps raising it — this is what "resolving" looks like
    supplyFree: 6, playerBuildings: 3, entitled: true, aiAlive: true,
  }));
}

test("SCALE INVARIANCE: no health check fires on a healthy AI, at any size", () => {
  for (const k of [1, 5, 20, 100]) {
    const r = summarise(healthyCurve(k));
    const fired = CHECKS.filter(c => c.hit(r)).map(c => c.id);
    assert.deepEqual(fired, [],
      `a healthy AI scaled ${k}x must fire nothing; fired: ${fired.join(", ")} ` +
      `(dev ${r.devFinal}/+${r.devGrowthTail}, army ${r.armyFinal}/+${r.armyGrowthTail}, ` +
      `banked ${r.bankedFinal}, idle ${r.idleRichFrac}, blocked ${r.supplyDeadlockFrac}, ` +
      `cap +${r.supplyCapGrowthTail})`);
  }
});

test("SCALE INVARIANCE: the detectors still catch each real defect, at any size", () => {
  // The other half, and the reason the test above is not just "make everything pass": a genuinely
  // stuck AI must still be caught, and caught for the SAME reason, however big it is.
  const broken = {
    "dev-flatline":     c => c.map(x => ({ ...x, dev: 3 })),                                    // climb stopped
    "hoarding":         c => c.map(x => ({ ...x, banked: 60000, army: 9 })),                    // bank never converted
    "production-stall": c => c.map(x => ({ ...x, idleRax: x.rax, army: 9 })),                   // line stopped on affordable money
    "supply-deadlock":  c => c.map(x => ({ ...x, supplyBlocked: true, supplyCapNow: 40 })),     // ceiling frozen
  };
  for (const k of [1, 20]) {
    for (const [id, breakIt] of Object.entries(broken)) {
      const r = summarise(breakIt(healthyCurve(k)));
      assert.ok(CHECKS.find(c => c.id === id).hit(r),
        `${id} must still fire on its own defect at ${k}x scale`);
    }
  }
});

// Two detectors were rewritten after the first fix round, because scaling the AI up turned them
// into false positives: "any Barracks idle while holding 400" fired on 42 of 44 HEALTHY runs once
// surplus opened six Barracks, and a peak-based thrift measure scored a working economy (peaks
// high, spends straight back down) the same as a stalled one. A metric that fires on correct
// behaviour is worse than no metric — the tuning loop optimises against it.

test("ordinary churn in a scaled-up production line is not a production stall", () => {
  const healthy = { rax: 6, idleRax: 2 };
  const stalled = { rax: 6, idleRax: 6 };
  const frac = c => summarise([{ ...c, dev: 0, army: 0, waves: 0, hostility: 0, playerBuildings: 1,
                                 entitled: true, canAffordNext: true, banked: 2200, armyValue: 0, workers: 0,
                                 buildings: 0, supplyBlocked: false, aiAlive: true, t: 0 }]).idleRichFrac;
  assert.equal(frac(healthy), 0, "two of six Barracks between jobs is not a stall");
  assert.equal(frac(stalled), 1, "every Barracks idle while it can afford the next unit is");
});

test("the money gate is scale-free — it asks what the AI could BUY, not how much ore it holds", () => {
  // The gate used to be `banked > 1000`, a threshold calibrated against one particular size of
  // economy: on a neighbour earning several times what it used to, 1,000 banked is change in
  // transit. These two rows are identical except for the size of the bank, and the detector must
  // not care — only whether the next unit was affordable (docs/odyssey-ai-review.md §2.12).
  const row = extra => ({ dev: 0, army: 0, waves: 0, hostility: 0, playerBuildings: 1, entitled: true,
                          rax: 2, idleRax: 2, armyValue: 0, workers: 0, buildings: 0,
                          supplyBlocked: false, aiAlive: true, t: 0, ...extra });
  assert.equal(summarise([row({ banked: 900, canAffordNext: true })]).idleRichFrac, 1,
    "a small bank that still covers the next unit is a stall — the old absolute gate missed this");
  assert.equal(summarise([row({ banked: 250000, canAffordNext: false })]).idleRichFrac, 0,
    "…and a huge bank it cannot spend on THIS unit is not — being broke in the right currency is an excuse");
});

test("hoarding means a bank it never spent, not a bank it passed through", () => {
  const hoard = CHECKS.find(c => c.id === "hoarding");
  assert.ok(hoard.hit({ bankedFinal: 30000, armyGrowthTail: 0 }), "big final bank + a frozen army is hoarding");
  assert.ok(!hoard.hit({ bankedFinal: 2200, armyGrowthTail: 51 }), "a working balance with a growing army is not");
  assert.ok(!hoard.hit({ bankedFinal: 30000, armyGrowthTail: 40 }), "…nor is a big balance it's actively converting");
});

test("supply PRESSURE with a Habitat on the way is not a deadlock", () => {
  // A healthy AI at full tilt lives close to its cap and is momentarily unable to fit the next
  // unit all the time. A third detector had to learn that difference: measured, helix grew its army
  // 75 -> 327 and drained a 10,000 bank to 854 while the old test still called it deadlocked.
  const base = { dev: 0, army: 0, waves: 0, hostility: 0, playerBuildings: 1, entitled: true,
                 armyValue: 0, workers: 0, buildings: 0, rax: 1, idleRax: 0, aiAlive: true, t: 0 };
  const frac = c => summarise([{ ...base, ...c }]).supplyDeadlockFrac;
  assert.equal(frac({ supplyBlocked: true, habitatPending: true, canAffordUnblock: true }), 0,
    "blocked, but a Habitat is already going up — it resolves itself");
  assert.equal(frac({ supplyBlocked: true, habitatPending: false, canAffordUnblock: false }), 0,
    "blocked with nothing on the way but no money for a Habitat — broke, not deadlocked");
  assert.equal(frac({ supplyBlocked: true, habitatPending: false, canAffordUnblock: true }), 1,
    "blocked with nothing on the way and the money to fix it is the state that never resolves");
});

test("a rising supply ceiling clears the deadlock detector however often the AI is momentarily blocked", () => {
  // The case this detector actually got wrong (docs/odyssey-ai-review.md §2.12): an AI outgrowing
  // its housing lives AT its ceiling, so a per-sample "blocked right now" test fires constantly on
  // a world that is manifestly fine. The `why` string always claimed to measure "the state that
  // never resolves itself"; now the predicate does too.
  const deadlock = CHECKS.find(c => c.id === "supply-deadlock");
  assert.ok(deadlock.hit({ supplyDeadlockFrac: 0.9, supplyCapGrowthTail: 0 }),
    "blocked almost always AND the ceiling never moved — genuinely wedged");
  assert.ok(!deadlock.hit({ supplyDeadlockFrac: 0.9, supplyCapGrowthTail: 441 }),
    "blocked just as often, but the ceiling climbed 441 supply in the tail — growing, not stuck");
});

test("a growing army clears the production-stall detector however often a Barracks is caught idle", () => {
  const stall = CHECKS.find(c => c.id === "production-stall");
  assert.ok(stall.hit({ idleRichFrac: 0.9, armyGrowthTail: 0 }),
    "idle on affordable money AND the army never grew — the line really stopped");
  assert.ok(!stall.hit({ idleRichFrac: 0.9, armyGrowthTail: 37 }),
    "…caught idle just as often while the army grew 37 is a busy line sampled between jobs");
});

test("a strategy that deliberately caps its army isn't reported as a production stall", () => {
  // Economic keeps 3 units and Force Parity mirrors what it has seen — idle Barracks are the
  // POINT of those strategies, and counting them made the detector fire on the design working.
  const base = { dev: 0, army: 0, waves: 0, hostility: 0, playerBuildings: 1, entitled: true,
                 armyValue: 0, workers: 0, buildings: 0, rax: 2, idleRax: 2, canAffordNext: true,
                 supplyBlocked: false, habitatPending: false, aiAlive: true, t: 0 };
  assert.equal(summarise([{ ...base, armyCapped: true }]).idleRichFrac, 0,
    "an army-capped strategy sitting on idle Barracks is doing what it was asked to");
  assert.equal(summarise([{ ...base, armyCapped: false }]).idleRichFrac, 1,
    "…an uncapped one doing the same has run out of things to buy");
});

/* ---------- duel: Tier 2, TRUE head-to-head via Tier 1 self-play ----------

   Unlike leaderboard above (a proxy: every candidate vs the SAME fixed sparring bot), duel
   makes two candidates fight each other for real via tools/selfplay.js, resolved by engine/
   victory.js exactly like any other skirmish. These tests guard the three things a "fair
   fight" claim rests on: it replays byte-identically, it actually detects who won, and the
   one dial that would silently break fairness (APM/micro, both derived from difficulty) is
   provably identical for both sides — not just passed as the same CLI flag and trusted. ---------- */

/* ---------- search: Tier 4, a second OBJECTIVE for the same coordinate scan ----------

   node tools/ailab.js search already scans a strategy's numeric dials and keeps whichever
   value scores best against a fixed --opponent sparring bot (score()). --tournament-against
   swaps ONLY what evaluate() scores a candidate value BY — Tier 2/3's fair, side-swapped,
   difficulty-bracketed self-play duel (runDuelBrackets) against a named baseline candidate —
   without touching the coordinate-scan loop itself. These tests guard exactly that seam: the
   flag genuinely reaches the duel path (not just a relabelled score() run), and omitting the
   flag reproduces the ORIGINAL search algorithm byte-for-byte, not merely "looks similar". ---------- */

/* ---------- Tier 5: Swiss pairing — the same runSwappedDuel primitive, a cheaper schedule ----------

   runRoundRobinSwapped above already proves the FAIRNESS of one pairing (side-swap, difficulty
   brackets, pinned APM/micro). Swiss reuses that primitive unchanged — these tests guard the
   SCHEDULE on top of it: it actually runs fewer matches than round-robin for a pool where that
   matters, byes rotate instead of piling onto one candidate, rematches are avoided while an
   unplayed opponent still exists, standings tally correctly including bye credit, and the whole
   thing is exactly as deterministic as every other lab command. ---------- */

/* ---- Swiss SCHEDULE tests, on synthetic results ---------------------------------------------
   These four used to drive real 15-40 sim-minute matches to assert pure combinatorics — round
   count, pairings per round, bye rotation, rematch avoidance — roughly 50 s of the suite's wall
   clock spent proving arithmetic. tools/ailab.js now exposes buildSwissBracket with the match
   runner injected, so they run on a stub in milliseconds. This is the idiom pairRound's own test
   already used, and explained: "isolates the pairing algorithm from match simulation entirely."
   The genuinely end-to-end tests (a strong candidate beating a crippled one, determinism,
   override isolation) still run real matches. */

// A deterministic stand-in for runSwappedDuel: alphabetically-earlier name wins, so standings move
// in a predictable way without simulating anything.
const fakePair = (a, b) => ({
  aName: a.name, bName: b.name, n: 2, draws: 0,
  aWins: a.name < b.name ? 2 : 0,
  bWins: a.name < b.name ? 0 : 2,
  avgMargin: 0, rows: [],
});
const field = n => Array.from({ length: n }, (_, i) => ({ name: `C${i}`, strategy: "default" }));
const swissRounds = n => Math.max(3, Math.ceil(Math.log2(n)));

test("default rounds follow ceil(log2(n)), and every round pairs at most floor(n/2) matches", () => {
  const candidates = field(8);
  const bracket = buildSwissBracket(candidates, swissRounds(8), { worlds: ["korrath"], seeds: 1 }, fakePair);
  assert.equal(bracket.rounds, 3, "ceil(log2(8)) = 3, at least the floor of 3");
  assert.equal(bracket.roundsLog.length, 3);
  for (const { byeName, matches } of bracket.roundsLog) {
    assert.equal(matches.length, 4, "8 candidates, even, no bye -> 4 pairings a round");
    assert.equal(byeName, null, "an even pool never needs a bye");
  }
});

test("Swiss runs strictly fewer pairings than full round-robin for a pool large enough for it to matter", () => {
  const n = 10;
  const candidates = field(n);
  const bracket = buildSwissBracket(candidates, swissRounds(n), { worlds: ["korrath"], seeds: 1 }, fakePair);
  const swissPairings = bracket.roundsLog.reduce((a, r) => a + r.matches.length, 0);
  const roundRobinPairings = (n * (n - 1)) / 2;
  assert.ok(swissPairings < roundRobinPairings,
    `Swiss (${swissPairings} pairings over ${bracket.rounds} rounds) should cost less than round-robin's C(${n},2)=${roundRobinPairings}`);
});

test("byes rotate: nobody gets a second bye while another candidate hasn't had one yet", () => {
  // 5 candidates (odd) over enough rounds that everyone gets exactly one bye before anyone gets a
  // second — 5 rounds guarantees every candidate has been the odd one out exactly once.
  const candidates = field(5);
  const bracket = buildSwissBracket(candidates, 5, { worlds: ["korrath"], seeds: 1 }, fakePair);
  const byes = bracket.roundsLog.map(r => r.byeName);
  assert.equal(new Set(byes).size, 5, `every candidate should get exactly one bye across 5 rounds of 5, got: ${byes.join(", ")}`);
});

test("a bye is scorable-neutral: it adds to nobody's wins or losses, only its own bye count", () => {
  // A bye is a candidate the schedule couldn't pair, not a match anyone won — crediting it as a
  // win (at ANY size) lets a candidate that never fights outrank one that actually won something.
  // The only thing a bye should move is `byes` (bookkeeping/reporting), never `wins`/`losses`.
  // Pure bookkeeping — no match needs simulating to prove a bye moves only `byes`.
  const opts = { worlds: ["ferros", "vesper"], seeds: 2 };
  const bracket = buildSwissBracket(field(3), swissRounds(3), opts, fakePair);
  const round = bracket.roundsLog.find(r => r.byeName);
  assert.ok(round, "fixture: an odd pool must produce a bye somewhere");
  // byeMatchCount is purely informational — "how big a real pairing this round would have been" —
  // and must still be reported accurately, just never added to anyone's standing.
  const expectedMatchCount = opts.worlds.length * opts.seeds * 2;
  assert.equal(bracket.byeMatchCount, expectedMatchCount);
  assert.equal(round.byeMatchCount, expectedMatchCount);
});

test("rematch avoidance: with enough candidates relative to rounds, no pairing repeats", () => {
  // A plain greedy pairing (this test's first version) could strand two candidates together even
  // when a full zero-repeat matching existed elsewhere in the round — independent review found it
  // failing 25-51% of the time at these exact scales, and that this very test only passed because
  // its hardcoded seedBase (7) happened to be a lucky one (seedBases 6, 9, 10 reproducibly failed
  // with the old algorithm). pairRound now backtracks to find a zero-repeat matching whenever one
  // exists, so this checks across several seed bases — including the ones independently confirmed
  // to break the old algorithm — rather than trusting a single roll.
  const candidates = field(6);
  for (const seedBase of [1, 6, 7, 9, 10]) {
    const bracket = buildSwissBracket(candidates, 3, { worlds: ["korrath"], seeds: 1, seedBase }, fakePair);
    const seen = new Set();
    for (const { matches } of bracket.roundsLog) {
      for (const res of matches) {
        const key = [res.aName, res.bName].sort().join("::");
        assert.ok(!seen.has(key),
          `seedBase=${seedBase}: pairing ${key} repeated across rounds even though unplayed opponents remained (6 candidates, 3 rounds)`);
        seen.add(key);
      }
    }
  }
});

test("pairRound backtracks to a zero-repeat matching a plain greedy walk would miss", () => {
  // The exact failure an independent review reproduced: greedily pairing the two joint leaders
  // first strands the round's one forbidden pair together, even though pairing either leader with
  // one of them instead leaves a perfectly valid zero-repeat matching for the rest. Tested directly
  // against pairRound on synthetic standings — fast, and isolates the pairing algorithm from match
  // simulation entirely.
  const standings = [
    { name: "Aggressive", wins: 3, losses: 1 }, { name: "QuickCommit", wins: 3, losses: 1 },
    { name: "Adaptive", wins: 1, losses: 3 }, { name: "ForceParity", wins: 1, losses: 3 },
  ];
  const played = new Set(["Adaptive::ForceParity"]);
  const { pairs } = pairRound(standings, played, new Set());
  const pairKeys = pairs.map(([a, b]) => [a.name, b.name].sort().join("::"));
  assert.equal(pairs.length, 2, "4 candidates must produce 2 pairs");
  assert.ok(!pairKeys.includes("Adaptive::ForceParity"),
    `pairRound repeated the one forbidden pair even though a zero-repeat matching existed: got ${pairKeys.join(", ")}`);
});

test("pairRound still completes (with a forced repeat) when a zero-repeat matching is genuinely impossible", () => {
  // 4 candidates who have all already played each other (a fully round-robin'd played-set) leave
  // no zero-repeat option anywhere — pairRound must still return a complete pairing (via its
  // greedy fallback) rather than hang or throw.
  const standings = ["A", "B", "C", "D"].map(name => ({ name, wins: 0, losses: 0 }));
  const played = new Set(["A::B", "A::C", "A::D", "B::C", "B::D", "C::D"]);
  const { pairs } = pairRound(standings, played, new Set());
  assert.equal(pairs.length, 2, "must still produce a complete pairing even with no zero-repeat option");
  const paired = new Set(pairs.flatMap(([a, b]) => [a.name, b.name]));
  assert.equal(paired.size, 4, "every candidate must appear in exactly one pair");
});

test("standings are sorted by win RATE, with raw wins as the tie-break", () => {
  // Updated, not deleted: this used to assert most-wins-first, which ranked "everyone who avoided a
  // bye, then everyone who didn't" — a bye recipient plays one fewer pairing and so has strictly
  // fewer chances to earn a win. Rate is the contract now; wins break a rate tie.
  const bracket = buildSwissBracket(field(6), swissRounds(6), { worlds: ["korrath"], seeds: 1 }, fakePair);
  const rate = r => { const n = r.wins + r.losses + r.draws; return n > 0 ? r.wins / n : 0; };
  for (let i = 1; i < bracket.standings.length; i++) {
    const prev = bracket.standings[i - 1], cur = bracket.standings[i];
    assert.ok(rate(prev) > rate(cur) || (rate(prev) === rate(cur) && prev.wins >= cur.wins),
      `standings order violated at index ${i}: ${JSON.stringify(prev)} before ${JSON.stringify(cur)}`);
  }
});

test("this suite leaves the shipped strategy table exactly as it found it (T2)", () => {
  // Placed last on purpose: it is a whole-file assertion, not a unit one.
  assert.equal(STRATEGIES.aggressive.garrisonMult, 0.4, "the shipped garrisonMult, not a test's override");
  assert.equal(STRATEGIES.aggressive.attackTimeoutMult, 0.55);
});

test("the round-1 bye doesn't depend on the order candidates were listed in (T2)", () => {
  // pairRound sorts on wins alone, and in round 1 every standing is 0-0. V8's sort is stable, so
  // the order is preserved and the loop takes the LAST element — i.e. `--candidates a,…,e`
  // structurally penalised whichever file was listed last. Nothing to do with merit.
  const names = ["A", "B", "C", "D", "E"];
  const rows = order => order.map(n => ({ name: n, wins: 0, losses: 0, draws: 0, byes: 0 }));
  const byeFor = order => pairRound(rows(order), new Set(), new Set()).byeName;
  const a = byeFor(names);
  const b = byeFor([...names].reverse());
  const c = byeFor(["C", "A", "E", "B", "D"]);
  assert.equal(a, b, `listing the same field in reverse changed the bye (${a} vs ${b})`);
  assert.equal(a, c, `listing the same field shuffled changed the bye (${a} vs ${c})`);
});

test("standings rank by RESULT, not by how many pairings the schedule handed out (T2)", () => {
  // A bye is scorable-neutral (the e9ad1d0 fix) — but the standings still sorted on absolute win
  // totals, and a bye recipient simply plays one fewer pairing, i.e. worlds x seeds x 2 fewer
  // chances to earn a win (16 under the swiss CLI defaults). So the ranking was literally "everyone
  // who avoided a bye, then everyone who didn't": a 2W-2L candidate at 50% ranked below a 3W-3L
  // candidate at 50% purely for having played more. This is the mirror image of the bug e9ad1d0
  // just fixed, in the one place the tool is supposed to be trustworthy.
  const played = { name: "played-more", wins: 3, losses: 3, draws: 0, byes: 0 };
  const byed = { name: "took-a-bye", wins: 2, losses: 2, draws: 0, byes: 1 };
  const ranked = rankStandings([played, byed]);
  assert.equal(ranked[0].name, ranked[1].name === "played-more" ? "took-a-bye" : "played-more",
    "sanity: the two are distinct rows");
  assert.deepEqual(ranked.map(r => r.name).sort(), ["played-more", "took-a-bye"]);
  assert.equal(rankStandings([played, byed])[0].wins / 6, 0.5, "both are at 50% — this is a genuine tie");
  // The real assertion: equal rates must not be broken in favour of the bigger denominator.
  const strictlyBetter = { name: "better", wins: 3, losses: 1, draws: 0, byes: 1 };
  assert.equal(rankStandings([played, strictlyBetter])[0].name, "better",
    "a 75% record must outrank a 50% one even though it played fewer pairings");
});

/* ---------- evolve: a population, bred and selected by real self-play ----------

   Short runs (tiny population, 4-minute matches) — this guards the LOOP, not the AI. Whether an
   evolved genome is actually better is a question for a long run and the search ledger, never for
   a test suite that has to finish in seconds.
   ---------- */

/* ---------- archive: MAP-Elites, a CAST rather than one optimum ----------

   The archive's whole claim is that local competition produces global diversity — a genome only
   ever displaces the current occupant of its OWN behaviour cell, so the degenerate turtle `evolve`
   found can win the "never attacks" cell and nothing else. These pin that mechanism, plus the
   binning it rests on. Short runs (tiny descriptor/duel budgets): this guards the loop, not the AI.
   ---------- */

test("binOf is total and ordered — every real value lands in exactly one bin", () => {
  for (const d of ARCHIVE_DIMS) {
    assert.equal(d.names.length, d.edges.length + 1, `${d.label}: n edges must give n+1 bins`);
    for (let i = 1; i < d.edges.length; i++)
      assert.ok(d.edges[i] > d.edges[i - 1], `${d.label}: edges must ascend`);
    assert.equal(binOf(-1e9, d.edges), 0, `${d.label}: below every edge is bin 0`);
    assert.equal(binOf(1e9, d.edges), d.edges.length, `${d.label}: above every edge is the last bin`);
    // The boundary itself belongs to the UPPER bin, and each edge must actually move the bin —
    // an edge that changes nothing is a silently missing axis.
    d.edges.forEach((e, i) => {
      assert.equal(binOf(e, d.edges), i + 1, `${d.label}: a value ON edge ${e} belongs to the upper bin`);
      assert.equal(binOf(e - 1e-9, d.edges), i, `${d.label}: just below edge ${e} belongs to the lower bin`);
    });
  }
});
