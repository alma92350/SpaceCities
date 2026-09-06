/* ============================================================
   The SLOW half of the tools/ailab.js guards — every test in here drives real matches.

   Split out of test/ailab.test.js, unchanged. That file used to run 307s while the whole
   rest of the suite ran in under 25s, which put an AI-tuning sweep on the critical path of
   the command CONTRIBUTING.md asks you to run on every change. These tests are not
   optional and nothing here is skipped: they run under `npm run test:slow`, and CI runs
   that as its own job on every push and pull request. See test/ailab.test.js for the
   fast half and for what the bench is guarding in the first place.

   What lives here is anything that starts a sim: determinism of a lab run, the override
   seam reaching the engine end-to-end, the sparring bots actually behaving as advertised,
   leaderboard/duel/round-robin/Swiss/search/evolution/archive. What stayed behind is
   everything pure — scoring, the health detectors against hand-written curves, and the
   Swiss pairing combinatorics against fake results.

   NOTE ON PATHS: this file sits one directory deeper than the rest of the suite, so its
   imports are `../../`. `npm test` globs `test/*.test.js` and so does NOT pick it up —
   that is the whole mechanism, and test/suite-integrity.test.js pins both halves so
   neither can quietly stop running.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  run, labWorld, summarise, score, applyOverrides, CHECKS, OPPONENTS, WEIGHTS, runLeaderboard,
  runDuel, runRoundRobin, pinnedDuelDials, runSwappedDuel, runDuelBrackets, runRoundRobinSwapped, runSearch,
  runSwissTournament, pairRound, buildSwissBracket, snapshotTables, restoreTables,
  runEvolution, runArchive, ARCHIVE_DIMS, binOf,
} from "../../tools/ailab.js";
import { toCandidate } from "../../tools/genome.js";
import { STRATEGIES } from "../../engine/aiStrategy.js";
import { ARCHETYPES } from "../../engine/aiArchetypes.js";
import { DIFFICULTY_OPTIONS } from "../../engine/aiDifficulty.js";
import { tick } from "../../engine/sim.js";
import { hashStr } from "../../engine/rng.js";

const short = extra => ({ world: "ferros", strategy: "default", difficulty: "medium",
                          opponent: "passive", minutes: 4, sample: 2, seed: 7, ...extra });

// Compare only the summary fields — the curve is a superset of them, so a divergence
// anywhere in the run shows up here too, without a 40-field diff to read.
const fingerprint = r => JSON.stringify(summarise(r.curve));

test("a lab run is deterministic — same configuration, byte-identical metrics", () => {
  assert.equal(fingerprint(run(short())), fingerprint(run(short())),
    "two identical lab runs diverged: something in the harness reads a clock or an unseeded pick");
});

test("the tech opponent is deterministic too — same configuration, byte-identical metrics", () => {
  const cfg = short({ opponent: "tech", minutes: 10 });
  assert.equal(fingerprint(run(cfg)), fingerprint(run(cfg)),
    "two identical tech-opponent runs diverged: the new bot must be exactly as clock-free as the others");
});

test("the seed genuinely varies the run (the lab isn't pinned to one world roll)", () => {
  const a = run(short({ seed: 7 })), b = run(short({ seed: 99 }));
  assert.notEqual(fingerprint(a), fingerprint(b), "two different seeds produced identical metrics");
});

test("labWorld's apm flag resolves to the difficulty row's own aiApm ('real'), or stays unthrottled otherwise", () => {
  const hard = DIFFICULTY_OPTIONS.find(o => o.mult === "hard");
  const cfg = { world: "ferros", strategy: "default", difficulty: "hard", opponent: "passive", seed: 1 };
  const real = labWorld({ ...cfg, apm: "real" });
  assert.equal(real.state.ai.apm, hard.aiApm, "apm:'real' should set state.ai.apm to Hard's own aiApm dial");
  const none = labWorld({ ...cfg, apm: "none" });
  assert.equal(none.state.ai.apm, null, "apm:'none' must preserve today's unthrottled runs");
  const unset = labWorld(cfg);
  assert.equal(unset.state.ai.apm, null, "omitting apm must keep the unthrottled default direct callers (incl. this suite) rely on");
});

test("the apm override seam reaches the sim: 'real' Easy builds measurably less than 'real' Hard over the same window", () => {
  // Mirrors test/sim.test.js's own "AI speed scales with its APM setting" contrast, but through
  // the ailab.js CLI seam specifically — proving --apm doesn't just set a field nobody reads. Easy
  // (20) vs unthrottled converges too fast to tell apart (the opening is resource-limited, not
  // action-limited, well before 20 APM), so this compares the two ends of the real dial instead —
  // exactly what a player choosing a difficulty actually gets.
  const base = { opponent: "passive", minutes: 10, sample: 1, apm: "real" };
  const output = r => r.workersFinal + r.buildingsFinal;
  const easy = output(run(short({ ...base, difficulty: "easy" })));
  const hard = output(run(short({ ...base, difficulty: "hard" })));
  assert.ok(easy < hard * 0.85,
    `Easy's 20-apm run (${easy}) should build noticeably less than Hard's 140-apm run (${hard}) in the same 10 minutes`);
});

test("each sparring opponent sets up the player side it advertises", () => {
  const presence = opponent => {
    const r = run(short({ opponent, minutes: 2 }));
    return r.curve[r.curve.length - 1].playerBuildings;
  };
  assert.equal(presence("none"), 0, "the background-world opponent leaves no player presence at all");
  assert.ok(presence("passive") >= 1, "the passive opponent seats a Command Center");
  assert.ok(presence("turtle") >= 1, "the turtle opponent seats a Command Center");
  assert.ok(presence("tech") >= 1, "the tech opponent seats a Command Center");
  for (const [id, bot] of Object.entries(OPPONENTS))
    assert.equal(typeof bot.desc, "string", `opponent ${id} needs a one-line description for the scoreboard`);
});

test("the turtle bot actually builds an economy — it's a yardstick, not a statue", () => {
  const r = run(short({ opponent: "turtle", minutes: 8, world: "ferros" }));
  const last = r.curve[r.curve.length - 1];
  assert.ok(last.playerBuildings > 1, `the turtle should raise more than its Command Center (got ${last.playerBuildings})`);
});

test("the tech bot climbs past the Barracks and fields more than Skiffs — the composition yardstick", () => {
  // Per this file's own header, this suite "guards the harness, not the AI" — the question
  // is whether the tech bot's OWN build order reaches a Foundry and fields Tier-2/3 units,
  // not whether its base survives 20 minutes against a real, symmetrically-tempo'd medium
  // opponent (a Foundry/Arsenal standing bonus applies to both sides via the shared
  // updateProductionQueue, and can now let a real AI win this race outright on some seeds —
  // an anticipated consequence of that feature, not a harness defect). So the milestones are
  // checked across the whole run, not just the final snapshot: reaching them once and later
  // losing the base still proves the build order works, which is all this test claims.
  const { state, bot } = labWorld({ world: "ferros", strategy: "default", difficulty: "medium",
                                     opponent: "tech", seed: 7 });
  const dt = 0.1;   // mirrors ailab.js's own fixed sim step (DT)
  let sinceThink = 0;
  let sawFoundry = false;
  let guardTypes = new Set();
  for (let i = 0; i < Math.round(20 * 60 / dt); i++) {
    tick(state, dt);
    sinceThink += dt;
    if (sinceThink >= 1.5) { sinceThink = 0; bot.think(state); }   // mirrors ailab.js's own THINK cadence
    if (!sawFoundry && [...state.buildings.values()].some(b => b.owner === "player" && !b.constructing && b.type === "foundry")) sawFoundry = true;
    for (const u of state.units.values()) if (u.owner === "player" && u.type !== "worker") guardTypes.add(u.type);
  }
  assert.ok(sawFoundry, "the tech bot should raise a Foundry within 20 minutes");
  assert.ok([...guardTypes].some(t => t !== "skiff"),
    `the tech bot's guard should include Tier-2/3 units, not just Skiffs (got: ${[...guardTypes].join(", ") || "none"})`);
});

test("an overrides row reaches the sim — a strategy that never initiates commits no waves", () => {
  // The seam the whole search loop rests on: STRATEGIES is a plain object read through
  // strategyFor(), so writing a row into it before a run IS the experiment.
  //
  // snapshotTables/restoreTables, same as the very next test below: applyOverrides writes
  // straight into the LIVE shipped table with no undo of its own, and this test used to have
  // none either — labPacifist stayed in STRATEGIES for the rest of the file, an inert but real
  // leak (nothing else selects strategy "labPacifist", so no other test's result was affected —
  // unlike the aggressive.garrisonMult leak the next test's own comment documents, which DID
  // corrupt 21 later tests before it was caught).
  const snap = snapshotTables();
  try {
    applyOverrides({ strategies: { labPacifist: { neverInitiates: true } } });
    assert.ok(STRATEGIES.labPacifist, "applyOverrides must add the row to the live table");
    const pacifist = run(short({ strategy: "labPacifist", world: "korrath", minutes: 12 }));
    const baseline = run(short({ strategy: "default", world: "korrath", minutes: 12 }));
    assert.equal(pacifist.waves, 0, "a neverInitiates strategy must commit zero waves");
    assert.ok(baseline.waves > 0, "the korrath baseline should commit at least one wave in 12 minutes");
  } finally {
    restoreTables(snap);
  }
});

test("score components stay in 0..1 and the total is their weighted mean", () => {
  const r = run(short({ minutes: 3 }));
  const s = score(r);
  for (const [k, v] of Object.entries(s.parts))
    assert.ok(v >= 0 && v <= 1, `component ${k} out of range: ${v}`);
  const wsum = Object.keys(s.parts).reduce((a, k) => a + WEIGHTS[k], 0);
  const expected = Object.entries(s.parts).reduce((a, [k, v]) => a + (WEIGHTS[k] / wsum) * v, 0);
  assert.ok(Math.abs(s.total - expected) < 1e-3, `total ${s.total} isn't the weighted mean ${expected}`);
});

test("scoring an opponent-less run drops the pressure component instead of scoring zero for it", () => {
  // Nobody to attack means "did it apply pressure?" is unanswerable, not answered badly —
  // scoring it 0 would make the right setting for development work look like a bad AI.
  const s = score(run(short({ opponent: "none", minutes: 3 })));
  assert.ok(!("pressure" in s.parts), "pressure must be dropped when there is no player at all");
  assert.ok(s.total > 0, "the remaining components still produce a usable score");
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

/* ---------- the bench has to encode the CURRENT contract, not a stale one ---------- */

// Odyssey now distinguishes "doesn't start fights" from "never fights": a neverInitiates strategy
// is entitled to commit once the player has provoked it (engine/diplomacy.js provoked()). If the
// bench kept scoring an unprovoked, quiet neighbour as a defect, the tuning loop would optimise
// straight toward an AI that attacks players who have done nothing to it — the exact bug
// neverInitiates exists to prevent. So "entitled" gates both the detector and the score component.

test("an unprovoked never-initiating neighbour is NOT counted as hostile-but-idle", () => {
  const r = run(short({ world: "korrath", strategy: "economic", opponent: "passive", minutes: 20 }));
  assert.equal(r.waves, 0, "it correctly leaves a player who has done nothing to it alone");
  assert.equal(r.entitledSamples, 0, "…so it never had standing to attack");
  assert.equal(r.hostileIdleFrac, 0, "…and that must not read as a defect");
  assert.ok(!CHECKS.find(c => c.id === "hostile-but-idle").hit(r), "the detector stays silent on correct behaviour");
});

test("pressure is dropped from the score when the AI never had standing to attack", () => {
  const s = score(run(short({ world: "korrath", strategy: "economic", opponent: "passive", minutes: 20 })));
  assert.ok(!("pressure" in s.parts), "an unanswerable question is dropped, not scored zero");
});

test("the skirmisher opponent actually fights — it is the bot that exercises provocation", () => {
  // Contrasted against `passive` — the only bot that genuinely never draws blood. `turtle` is NOT
  // the comparison to make: its turrets kill the AI's scouts, which is the player destroying the
  // neighbour's ships however defensively it was meant, so it provokes too.
  const fights = run(short({ world: "ferros", strategy: "economic", opponent: "skirmisher", minutes: 25 }));
  const ignores = run(short({ world: "ferros", strategy: "economic", opponent: "passive", minutes: 25 }));
  assert.ok(fights.curve.some(c => c.provokedAi), "the skirmisher draws blood, which is the whole point of it");
  assert.ok(!ignores.curve.some(c => c.provokedAi), "…and a player who does nothing at all never does");
  // NOT `army > 0`: docs/odyssey-ai-review.md §2.9 already documents ferros/economic dying to this
  // exact rush within minute 10 (a known, deliberately-unfixed difficulty characteristic), and
  // "Doctrine research develops over time" measurably deepened it on this seed — bisected to
  // 4b95948, where the AI now loses its whole opening (workers and all) before ever fielding a
  // single combat unit, instead of the pre-existing "fields 1-2 units, then still loses" pattern.
  // That's a real difficulty-curve shift `whoever owns that curve` (§2.9's own words) should weigh
  // in on, not something to paper over here — so `buildings > 1` stands in for "a real, developing
  // base existed to fight", true on both sides of that regression, while `army > 0` is not.
  assert.ok(fights.curve.some(c => c.buildings > 1), "the AI it fights is a real opponent, not an empty world");
});

test("for a never-initiating strategy, standing tracks provocation exactly — and provocation FADES", () => {
  // The end-to-end proof that engine and bench agree. Deliberately an invariant rather than "it
  // attacked by minute N": provocation is a memory that decays at a rate the world's temperament
  // sets (engine/diplomacy.js PROVOKE_MEMORY / forgiveness), so whether any particular sample
  // lands inside the window is a timing coincidence. What must ALWAYS hold is that a strategy
  // which doesn't start fights has standing exactly when, and only when, it has been provoked.
  const fought = run(short({ world: "korrath", strategy: "economic", opponent: "skirmisher", minutes: 30 }));
  const ignored = run(short({ world: "korrath", strategy: "economic", opponent: "passive", minutes: 30 }));
  for (const r of [fought, ignored])
    for (const c of r.curve)
      assert.equal(c.entitled, c.provokedAi, "a never-initiating neighbour's standing IS its provocation");
  assert.ok(fought.curve.some(c => c.provokedAi), "a player who attacks it earns a neighbour that may answer");
  assert.ok(!ignored.curve.some(c => c.provokedAi), "…and one who never touches it does not");
  // …and the memory really does fade: the fighting run must show provocation lapsing at some point,
  // not staying branded on for the rest of the session.
  const flips = fought.curve.filter((c, i) => i > 0 && !c.provokedAi && fought.curve[i - 1].provokedAi);
  assert.ok(flips.length > 0, "provocation cools off once the shooting stops — it is not a permanent brand");
});

/* ---------- leaderboard: Tier 0 of ranking candidates against a fixed yardstick ----------

   Not head-to-head play (see the LEADERBOARD header comment in tools/ailab.js) — these tests
   guard the two things that would silently break that promise: that ranking two candidates
   never lets one's overrides bleed into the other's run, and that the whole thing is exactly
   as deterministic as every other lab run. ---------- */

test("leaderboard is deterministic — same candidates, byte-identical ranking", () => {
  const candidates = [{ name: "A", strategy: "default" }, { name: "B", strategy: "aggressive" }];
  const opts = { worlds: ["ferros"], difficulty: "medium", opponent: "passive", seeds: 1, minutes: 4, sample: 2, seed: 7 };
  const strip = rs => JSON.stringify(rs.map(({ worst, ...r }) => r));
  assert.equal(strip(runLeaderboard(candidates, opts)), strip(runLeaderboard(candidates, opts)),
    "two identical leaderboard runs diverged");
});

test("a candidate's overrides never leak into the next candidate's run", () => {
  const before = JSON.stringify(STRATEGIES.aggressive);
  const candidates = [
    { name: "patched", strategy: "aggressive", overrides: { strategies: { aggressive: { garrisonMult: 0.01 } } } },
    { name: "plain", strategy: "aggressive" },
  ];
  runLeaderboard(candidates, { worlds: ["ferros"], opponent: "passive", seeds: 1, minutes: 3, sample: 2, seed: 7 });
  assert.equal(JSON.stringify(STRATEGIES.aggressive), before,
    "STRATEGIES.aggressive must be restored to its pre-leaderboard shape once every candidate has run");
});

test("leaderboard restores the tables even when a later candidate throws", () => {
  const before = JSON.stringify(STRATEGIES.aggressive);
  const candidates = [
    { name: "patched", strategy: "aggressive", overrides: { strategies: { aggressive: { garrisonMult: 0.02 } } } },
    { name: "broken", strategy: "doesNotExist" },
  ];
  assert.throws(
    () => runLeaderboard(candidates, { worlds: ["ferros"], opponent: "passive", seeds: 1, minutes: 3, sample: 2, seed: 7 }),
    /unknown strategy/);
  assert.equal(JSON.stringify(STRATEGIES.aggressive), before,
    "an earlier candidate's patch must not survive a later candidate's failure");
});

test("a candidate needs a name", () => {
  assert.throws(() => runLeaderboard([{ strategy: "default" }], { worlds: ["ferros"], seeds: 1, minutes: 2 }), /needs a "name"/);
});

test("leaderboard results are sorted best-first", () => {
  const candidates = [{ name: "A", strategy: "default" }, { name: "B", strategy: "economic" }, { name: "C", strategy: "aggressive" }];
  const results = runLeaderboard(candidates, { worlds: ["ferros"], opponent: "passive", seeds: 1, minutes: 3, sample: 2, seed: 7 });
  for (let i = 1; i < results.length; i++)
    assert.ok(results[i - 1].mean >= results[i].mean, "leaderboard must be sorted highest score first");
});

test("leaderboard ranks a crippled candidate below a normal one against an opponent that attacks", () => {
  // Same override seam the earlier "an overrides row reaches the sim" test already trusts —
  // this just proves the leaderboard's own ranking (not just the raw score) reflects it.
  const candidates = [
    { name: "normal", strategy: "default" },
    { name: "crippled", strategy: "labCrippled", overrides: { strategies: { labCrippled: { neverInitiates: true, standingArmyCap: 1 } } } },
  ];
  const results = runLeaderboard(candidates,
    { worlds: ["korrath"], difficulty: "medium", opponent: "tech", seeds: 1, minutes: 20, sample: 4, seed: 7 });
  assert.deepEqual(results.map(r => r.name), ["normal", "crippled"],
    "a token 1-unit standing army should rank below the default Rusher build against an opponent that presses it");
});

/* ---------- duel: Tier 2, TRUE head-to-head via Tier 1 self-play ----------

   Unlike leaderboard above (a proxy: every candidate vs the SAME fixed sparring bot), duel
   makes two candidates fight each other for real via tools/selfplay.js, resolved by engine/
   victory.js exactly like any other skirmish. These tests guard the three things a "fair
   fight" claim rests on: it replays byte-identically, it actually detects who won, and the
   one dial that would silently break fairness (APM/micro, both derived from difficulty) is
   provably identical for both sides — not just passed as the same CLI flag and trusted. ---------- */

const shortDuel = extra => ({ worlds: ["ferros"], difficulty: "medium", seeds: 1, seedBase: 7, minutes: 5, ...extra });

test("duel is deterministic — same two candidates, same seed, byte-identical result", () => {
  const a = { name: "A", strategy: "default" };
  const b = { name: "B", strategy: "aggressive" };
  const opts = shortDuel();
  assert.equal(JSON.stringify(runDuel(a, b, opts)), JSON.stringify(runDuel(a, b, opts)),
    "two identical duels diverged: something reads a clock or an unseeded pick");
});

test("a different seed genuinely changes the duel (not pinned to one roll)", () => {
  const a = { name: "A", strategy: "default" };
  const b = { name: "B", strategy: "aggressive" };
  const x = runDuel(a, b, shortDuel({ seedBase: 1 }));
  const y = runDuel(a, b, shortDuel({ seedBase: 2 }));
  assert.notEqual(JSON.stringify(x.rows), JSON.stringify(y.rows), "two different seed bases produced identical duel rows");
});

test("duel winner detection: a strong candidate beats a deliberately crippled one, consistently, across worlds and seeds", () => {
  // neverInitiates + a standing-army cap of ZERO (not engine/aiEconomy.js's warFootingMult
  // escape hatch — that only multiplies a non-zero base) means this candidate can never field
  // a defender at all, in skirmish, where neverInitiates is absolute (no desperation timeout
  // — see engine/aiStrategy.js / the ai-lab skill notes). "default" plays true to its
  // archetype and DOES attack on its own timeout, so this is elimination, not a coin flip.
  const normal = { name: "normal", strategy: "default" };
  const crippled = {
    name: "crippled", strategy: "labCrippledDuel",
    overrides: { strategies: { labCrippledDuel: { neverInitiates: true, standingArmyCap: 0 } } },
  };
  // minutes: 30, not 20 (T-017/ADR-0008). runDuel always plays candidate A as owner "player", and
  // duelCore.js populates state.playerAi for every duel — a duel candidate is never a human, no
  // matter which seat it plays. Before T-017, sim.js's idle-worker auto-assist (ferry/haul/service/
  // repair) was gated on the literal owner==="player", so "normal" got it unconditionally, same as
  // a real human would; after T-017 it's correctly gated on isHumanControlled, which duelCore's
  // playerAi makes false — so "normal" now mops up ferros/3009028770 in ~23min instead of ~10min,
  // matching what "crippled" (owner "ai") already experienced. This is the fix working — every
  // PRIOR A-as-player-vs-B-as-ai duel comparison was quietly biased toward whichever candidate
  // landed on "player" — not a flake; 20min was already the tightest margin among these four
  // (world, seed) pairs even before this fix (615s of a 1200s budget), so it was always the one
  // likely to need headroom first. 30min gives verified margin on all four.
  const res = runDuel(normal, crippled, { worlds: ["korrath", "ferros"], difficulty: "medium", seeds: 2, seedBase: 7, minutes: 30 });
  assert.equal(res.n, 4, "fixture: 2 worlds x 2 seeds");
  assert.equal(res.aWins, res.n, `the normal candidate must win every match (got ${JSON.stringify(res.rows.map(r => r.winner))})`);
  assert.equal(res.bWins, 0);
  assert.ok(res.rows.every(r => r.winReason === "elimination"),
    `a defenseless base should lose to a genuine assault before the clock — reasons: ${res.rows.map(r => r.winReason)}`);
  assert.ok(res.avgMargin > 0, "the winning side's average score margin must be positive");
  for (const r of res.rows) assert.ok(r.margin > 0, `every individual match margin must favour the winner (${r.world}/${r.seed}: ${r.margin})`);
});

test("difficulty — and therefore APM/micro — is genuinely pinned identical for both sides, read back from the run itself", () => {
  // Structural, not a trusted convention: read back state.playerAi/state.ai's OWN configured
  // dials off each match, for two candidates running DIFFERENT strategies, at two different
  // difficulties, and assert they agree — the only way they could differ is a bug that let the
  // two sides read from two different places.
  for (const difficulty of ["easy", "hard"]) {
    const dial = DIFFICULTY_OPTIONS.find(o => o.mult === difficulty);
    const expected = pinnedDuelDials(difficulty);
    assert.deepEqual(expected, { difficulty, apm: dial.aiApm, micro: !!dial.aiMicro },
      "pinnedDuelDials must read straight off the named difficulty row");

    const a = { name: "A", strategy: "default" };
    const b = { name: "B", strategy: "economic" };   // deliberately a DIFFERENT strategy from A
    const res = runDuel(a, b, shortDuel({ difficulty, seeds: 2 }));
    assert.ok(res.rows.length > 0, "fixture: the duel actually ran matches");
    for (const r of res.rows) {
      assert.equal(r.aDifficulty, difficulty);
      assert.equal(r.bDifficulty, difficulty);
      assert.equal(r.aApm, dial.aiApm, `candidate A's own controller must carry ${difficulty}'s aiApm`);
      assert.equal(r.bApm, dial.aiApm, `candidate B's own controller must carry the SAME aiApm as A, not its own`);
      assert.equal(r.aMicro, !!dial.aiMicro);
      assert.equal(r.bMicro, !!dial.aiMicro);
      assert.equal(r.aApm, r.bApm, "no APM edge between the two sides");
      assert.equal(r.aMicro, r.bMicro, "no micro edge between the two sides");
    }
  }
});

test("a duel candidate needs a name, on either side", () => {
  const named = { name: "A", strategy: "default" };
  assert.throws(() => runDuel({ strategy: "default" }, named, shortDuel()), /candidate A needs a "name"/);
  assert.throws(() => runDuel(named, { strategy: "default" }, shortDuel()), /candidate B needs a "name"/);
});

test("a duel's two candidates must have different names -- elo.js's RatingsTable is keyed by name, " +
  "so a same-name pairing would collide both sides into one entry (see test/elo.test.js)", () => {
  const a = { name: "Same", strategy: "default" };
  const b = { name: "Same", strategy: "aggressive" };
  assert.throws(() => runDuel(a, b, shortDuel()), /same|different|distinct/i);
});

test("a duel's overrides never leak into what runs next", () => {
  const before = JSON.stringify(STRATEGIES.aggressive);
  const a = { name: "A", strategy: "aggressive", overrides: { strategies: { aggressive: { garrisonMult: 0.01 } } } };
  const b = { name: "B", strategy: "default" };
  runDuel(a, b, shortDuel());
  assert.equal(JSON.stringify(STRATEGIES.aggressive), before,
    "STRATEGIES.aggressive must be restored once the duel is done, exactly like runLeaderboard's own promise");
});

test("round-robin: every pair runs once, and standings tally wins/losses/draws across all of them", () => {
  const candidates = [{ name: "A", strategy: "default" }, { name: "B", strategy: "economic" }, { name: "C", strategy: "aggressive" }];
  const { pairs, standings } = runRoundRobin(candidates, shortDuel());
  assert.equal(pairs.length, 3, "3 candidates -> 3 unordered pairs (AB, AC, BC)");
  assert.equal(standings.length, 3);
  const totalWins = standings.reduce((s, c) => s + c.wins, 0);
  const totalLosses = standings.reduce((s, c) => s + c.losses, 0);
  assert.equal(totalWins, totalLosses, "every win on one side of a pair is a loss on the other");
  for (let i = 1; i < standings.length; i++)
    assert.ok(standings[i - 1].wins >= standings[i].wins, "standings must be sorted most-wins-first");
});

/* ---------- Tier 3: side-swap (default) + difficulty brackets (never blended) ----------

   runDuel above already pins difficulty/APM/micro identical for both sides within ONE match-up
   in ONE direction. Tier 3 wraps it with the two things a noisy objective needs before a
   verdict means anything (docs/odyssey-ai-review.md §3 / the ai-lab skill's standing lesson):
   both owner-slot assignments run and reported (not just one, and not collapsed into a single
   number that could hide a side-symmetry bug), and every difficulty asked for is its own
   standalone result (never averaged across brackets, which would quietly reintroduce the APM
   confound duel's whole difficulty-pinning exists to prevent). ---------- */

test("Tier 3 duel is side-swapped by default: both directions are present and independently inspectable", () => {
  const a = { name: "A", strategy: "default" };
  const b = { name: "B", strategy: "aggressive" };
  const res = runSwappedDuel(a, b, shortDuel());
  assert.ok(res.bAsAi && res.aAsAi, "both sub-results must be present in the output");
  assert.equal(res.bAsAi.aName, "A", 'the "B as ai" sub-result must still label A as A, not swap the names too');
  assert.equal(res.aAsAi.aName, "A", 'the "A as ai" sub-result must ALSO label A as A -- both directions read from the same A/B perspective');
  assert.equal(res.n, res.bAsAi.n + res.aAsAi.n, "combined match count is the sum of both directions");
  assert.equal(res.aWins, res.bAsAi.aWins + res.aAsAi.aWins, "combined A wins must be the sum across both directions");
  assert.equal(res.bWins, res.bAsAi.bWins + res.aAsAi.bWins, "combined B wins must be the sum across both directions");
  // The two directions are genuinely separate matches (different owner-slot assignment means a
  // different duelSeed stream — see tools/ailab.js's own aName/bName-ordered seed derivation),
  // not one direction's numbers silently duplicated into the other.
  assert.notEqual(JSON.stringify(res.bAsAi.rows), JSON.stringify(res.aAsAi.rows),
    "the two directions must be independently-computed matches, not a copy of one relabelled as the other");
});

test("side-swap doesn't invert win attribution: a strong candidate beats a crippled one in BOTH directions", () => {
  // Mirrors runDuel's own "duel winner detection" fixture (neverInitiates + a zero standing-army
  // cap is an absolute defencelessness in skirmish, no desperation timeout), but run through
  // runSwappedDuel specifically to prove flipDuelResult attributes each win to the right
  // CANDIDATE, not to whichever owner slot happened to win — the exact bug a naive swap could
  // introduce silently.
  const normal = { name: "normal", strategy: "default" };
  const crippled = {
    name: "crippled", strategy: "labCrippledSwapDuel",
    overrides: { strategies: { labCrippledSwapDuel: { neverInitiates: true, standingArmyCap: 0 } } },
  };
  const res = runSwappedDuel(normal, crippled, { worlds: ["korrath"], difficulty: "medium", seeds: 1, seedBase: 7, minutes: 20 });
  assert.equal(res.aWins, res.n, "the normal candidate must win every match, both directions combined");
  assert.equal(res.bWins, 0);
  assert.equal(res.bAsAi.aWins, res.bAsAi.n, `normal must win while playing "player" (crippled as "ai")`);
  assert.equal(res.aAsAi.aWins, res.aAsAi.n,
    `normal must ALSO win while playing "ai" (crippled as "player") -- proves the relabelling attributes `
    + `wins to the right candidate, not the right owner slot`);
});

test("a swapped duel candidate needs a name, on either side", () => {
  const named = { name: "A", strategy: "default" };
  assert.throws(() => runSwappedDuel({ strategy: "default" }, named, shortDuel()), /candidate A needs a "name"/);
  assert.throws(() => runSwappedDuel(named, { strategy: "default" }, shortDuel()), /candidate B needs a "name"/);
});

test("Tier 3 duel keeps difficulty brackets separate — never blended into one mean", () => {
  const a = { name: "A", strategy: "default" };
  const b = { name: "B", strategy: "aggressive" };
  const brackets = runDuelBrackets(a, b, shortDuel({ difficulties: ["easy", "hard"] }));
  assert.ok(Array.isArray(brackets), "runDuelBrackets must return one entry per difficulty, never a single blended aggregate");
  assert.equal(brackets.length, 2, "two difficulties in -> two distinct bracket results out");
  assert.deepEqual(brackets.map(r => r.difficulty), ["easy", "hard"], "each bracket keeps its own difficulty label");
  // Genuinely independent runs, not the same numbers relabeled: each bracket's rows must carry
  // THAT bracket's own aiApm/aiMicro (pinnedDuelDials), and the underlying matches must differ.
  for (const r of brackets) {
    const dial = DIFFICULTY_OPTIONS.find(o => o.mult === r.difficulty);
    for (const row of [...r.bAsAi.rows, ...r.aAsAi.rows]) {
      assert.equal(row.aApm, dial.aiApm, `${r.difficulty} bracket rows must carry that bracket's own aiApm`);
      assert.equal(row.bApm, dial.aiApm, `${r.difficulty} bracket rows must pin BOTH sides to that bracket's own aiApm`);
    }
  }
  assert.notEqual(JSON.stringify(brackets[0].bAsAi.rows), JSON.stringify(brackets[1].bAsAi.rows),
    "easy and hard brackets must be independently-run matches, not one result duplicated under two labels");
});

test("Tier 3 duel stays deterministic — swapped, bracketed, byte-identical across two runs", () => {
  const a = { name: "A", strategy: "default" };
  const b = { name: "B", strategy: "aggressive" };
  const opts = shortDuel({ difficulties: ["medium", "hard"] });
  assert.equal(JSON.stringify(runDuelBrackets(a, b, opts)), JSON.stringify(runDuelBrackets(a, b, opts)),
    "two identical Tier 3 duel runs diverged: something reads a clock or an unseeded pick");
});

test("a different seed base genuinely changes a Tier 3 duel (not pinned to one roll)", () => {
  const a = { name: "A", strategy: "default" };
  const b = { name: "B", strategy: "aggressive" };
  const x = runDuelBrackets(a, b, shortDuel({ seedBase: 1 }));
  const y = runDuelBrackets(a, b, shortDuel({ seedBase: 2 }));
  assert.notEqual(JSON.stringify(x), JSON.stringify(y), "two different seed bases produced identical Tier 3 duel results");
});

test("round-robin swapped: side-swap and difficulty brackets both apply, standings still balance", () => {
  const candidates = [{ name: "A", strategy: "default" }, { name: "B", strategy: "economic" }, { name: "C", strategy: "aggressive" }];
  const brackets = runRoundRobinSwapped(candidates, shortDuel({ difficulties: ["medium", "hard"] }));
  assert.equal(brackets.length, 2, "two difficulties -> two standalone round-robin brackets, never merged into one table");
  assert.deepEqual(brackets.map(r => r.difficulty), ["medium", "hard"]);
  for (const { difficulty, pairs, standings } of brackets) {
    assert.equal(pairs.length, 3, `3 candidates -> 3 unordered pairs, same as the single-direction round robin (${difficulty})`);
    assert.equal(standings.length, 3);
    const totalWins = standings.reduce((s, c) => s + c.wins, 0);
    const totalLosses = standings.reduce((s, c) => s + c.losses, 0);
    assert.equal(totalWins, totalLosses, `every win on one side of a pair is a loss on the other (${difficulty})`);
  }
});

test("round-robin swapped rejects duplicate candidate names up front, before running anything", () => {
  const dup = [{ name: "A", strategy: "default" }, { name: "A", strategy: "aggressive" }];
  assert.throws(() => runRoundRobinSwapped(dup, shortDuel()), /duplicate candidate name/);
});

/* ---------- search: Tier 4, a second OBJECTIVE for the same coordinate scan ----------

   node tools/ailab.js search already scans a strategy's numeric dials and keeps whichever
   value scores best against a fixed --opponent sparring bot (score()). --tournament-against
   swaps ONLY what evaluate() scores a candidate value BY — Tier 2/3's fair, side-swapped,
   difficulty-bracketed self-play duel (runDuelBrackets) against a named baseline candidate —
   without touching the coordinate-scan loop itself. These tests guard exactly that seam: the
   flag genuinely reaches the duel path (not just a relabelled score() run), and omitting the
   flag reproduces the ORIGINAL search algorithm byte-for-byte, not merely "looks similar". ---------- */

const searchTmpDir = () => mkdtempSync(join(tmpdir(), "ailab-search-test-"));

test("--tournament-against switches the search's evaluate step onto the Tier 2/3 duel path, not score()", () => {
  const name = "labSearchTournamentDial";
  applyOverrides({ strategies: { [name]: { garrisonMult: 0.5, attackTimeoutMult: 0.5 } } });
  const baselinePath = join(searchTmpDir(), "baseline.json");
  writeFileSync(baselinePath, JSON.stringify({ name: "baselineCandidate", strategy: "default" }));

  const args = {
    strategy: name, dials: "garrisonMult=0.2:0.8", steps: "1",
    worlds: "korrath", difficulties: "medium", seeds: "1", minutes: "5", seed: "7",
    "tournament-against": baselinePath,
  };
  const result = runSearch(args);
  assert.equal(result.mode, "tournament", "the flag must switch the search into tournament mode");
  assert.equal(result.baseline.name, "baselineCandidate", "the named baseline candidate must be loaded from the JSON file");

  const steps = result.log.filter(e => e.kind === "step");
  assert.ok(steps.length > 0, "fixture: the search actually evaluated candidate dial values");
  for (const s of steps) {
    // Duel-shaped tallies (aWins/bWins/draws summing to n) are only produced by runDuelBrackets —
    // score()-mode's evaluate never returns them, it returns a `rows` array of run() curves.
    assert.equal(s.detail.aWins + s.detail.bWins + s.detail.draws, s.detail.n,
      "tournament-mode evaluate must return duel win/loss/draw tallies that sum to the match count");
    assert.ok(Array.isArray(s.detail.brackets) && s.detail.brackets.length > 0,
      "tournament-mode evaluate must carry the runDuelBrackets() result, one entry per difficulty");
    assert.ok(!("rows" in s.detail), "tournament-mode evaluate must not be score()-mode's run()-row shape");
    // The underlying matches must be genuine self-play duel rows (engine/victory.js-resolved
    // skirmishes), not solo score() curves -- winReason/aScore/bScore/swapAsym only exist on a
    // duelRun() row (tools/ailab.js), never on a sample()/summarise() row.
    const row = s.detail.brackets[0].bAsAi.rows[0];
    assert.ok(row, "fixture: at least one underlying duel match ran");
    for (const field of ["winReason", "aScore", "bScore", "swapAsym", "aName", "bName"])
      assert.ok(field in row, `tournament-mode's underlying row must be a genuine duel row (missing ${field})`);
  }
  assert.ok(typeof result.bestScore === "number" && result.bestScore >= -1 && result.bestScore <= 1,
    "tournament standing (win differential) must land in [-1, 1]");
});

test("--tournament-against is deterministic — same dials, same baseline, byte-identical result", () => {
  const name = "labSearchTournamentDeterminism";
  applyOverrides({ strategies: { [name]: { garrisonMult: 0.5 } } });
  const baselinePath = join(searchTmpDir(), "baseline.json");
  writeFileSync(baselinePath, JSON.stringify({ name: "baselineCandidate", strategy: "economic" }));
  const args = {
    strategy: name, dials: "garrisonMult=0.3:0.7", steps: "1",
    worlds: "korrath", difficulties: "medium", seeds: "1", minutes: "5", seed: "3",
    "tournament-against": baselinePath,
  };
  const strip = r => JSON.stringify({ mode: r.mode, best: r.best, bestScore: r.bestScore,
    log: r.log.map(e => ({ kind: e.kind, k: e.k, v: e.v, mean: e.mean, better: e.better })) });
  assert.equal(strip(runSearch(args)), strip(runSearch(args)),
    "two identical tournament-mode searches diverged: something reads a clock or an unseeded pick");
});

test("search without --tournament-against reproduces the ORIGINAL solo-score() algorithm exactly (regression, not an assumption)", () => {
  const name = "labSearchRegression";
  applyOverrides({ strategies: { [name]: { garrisonMult: 0.5, attackTimeoutMult: 0.5 } } });
  const dials = [{ k: "garrisonMult", lo: 0.2, hi: 0.8 }];
  const worlds = ["korrath"], difficulties = ["medium"];
  const steps = 2, seedBase = 7;

  // Independently replicates the PRE-Tier-4 search algorithm off the public primitives
  // run()/score()/applyOverrides() -- not a call into runSearch's own refactored internals, so
  // this is a genuine regression check against runSearch's numbers, not an assumption that the
  // refactor preserved them.
  const evalRow = row => {
    applyOverrides({ strategies: { [`${name}__lab`]: row } });
    const rows = [];
    for (const world of worlds)
      for (const difficulty of difficulties)
        rows.push(run({
          world, strategy: `${name}__lab`, difficulty, opponent: "passive",
          minutes: 3, sample: 2, apm: "real",
          seed: hashStr(`${seedBase}:${world}:${name}__lab:${difficulty}:0`),
        }));
    return rows.reduce((a, r) => a + score(r).total, 0) / rows.length;
  };
  const base = { ...(STRATEGIES[name] || {}) };
  let best = { ...base }, bestScore = evalRow(best);
  for (const d of dials) {
    for (let i = 0; i <= steps; i++) {
      const v = +(d.lo + (d.hi - d.lo) * (i / steps)).toFixed(3);
      const cand = { ...best, [d.k]: v };
      const mean = evalRow(cand);
      if (mean > bestScore + 1e-9) { best = cand; bestScore = mean; }
    }
  }

  const args = {
    strategy: name, dials: "garrisonMult=0.2:0.8", steps: "2",
    worlds: "korrath", difficulties: "medium", seeds: "1", minutes: "3", sample: "2", seed: "7", opponent: "passive",
  };
  const result = runSearch(args);
  assert.equal(result.mode, "score", "omitting --tournament-against must use the original score() objective");
  assert.equal(result.baseline, null, "no baseline candidate should be loaded when the flag is absent");
  assert.equal(result.bestScore, bestScore,
    "runSearch's bestScore must match the independently-replicated original algorithm exactly");
  assert.deepEqual(result.best, best,
    "runSearch's winning dial row must match the independently-replicated original algorithm exactly");
});

test("search's coordinate-scan mechanics are unchanged: the loop still keeps only genuine improvements, in both objective modes", () => {
  // Not a duplicate of the regression test above -- this pins the LOOP's own decision rule
  // ("keep a candidate only if it beats the current best by more than the noise epsilon") by
  // checking every logged step is internally consistent with `better`, for both objectives.
  const check = result => {
    let running = result.log.find(e => e.kind === "start").mean;
    for (const e of result.log.filter(x => x.kind === "step")) {
      assert.equal(e.better, e.mean > running + 1e-9, "the `better` flag must follow the loop's own epsilon rule");
      if (e.better) running = e.mean;
    }
    const finalBest = result.log.find(e => e.kind === "best");
    assert.equal(finalBest.mean, running, "the reported best must be the last kept improvement, in either mode");
  };

  const scoreName = "labSearchMechanicsScore";
  applyOverrides({ strategies: { [scoreName]: { garrisonMult: 0.5 } } });
  check(runSearch({
    strategy: scoreName, dials: "garrisonMult=0.2:0.8", steps: "2",
    worlds: "korrath", difficulties: "medium", seeds: "1", minutes: "3", sample: "2", seed: "7", opponent: "passive",
  }));

  const tournName = "labSearchMechanicsTournament";
  applyOverrides({ strategies: { [tournName]: { garrisonMult: 0.5 } } });
  const baselinePath = join(searchTmpDir(), "baseline.json");
  writeFileSync(baselinePath, JSON.stringify({ name: "baselineCandidate", strategy: "default" }));
  check(runSearch({
    strategy: tournName, dials: "garrisonMult=0.3:0.7", steps: "1",
    worlds: "korrath", difficulties: "medium", seeds: "1", minutes: "5", seed: "3",
    "tournament-against": baselinePath,
  }));
});

test("an unknown --dials flag still prints the usage hint instead of throwing, in either mode", () => {
  assert.equal(runSearch({ strategy: "default" }), null, "no --dials at all must return null (CLI prints the usage line)");
});

/* ---------- Tier 5: Swiss pairing — the same runSwappedDuel primitive, a cheaper schedule ----------

   runRoundRobinSwapped above already proves the FAIRNESS of one pairing (side-swap, difficulty
   brackets, pinned APM/micro). Swiss reuses that primitive unchanged — these tests guard the
   SCHEDULE on top of it: it actually runs fewer matches than round-robin for a pool where that
   matters, byes rotate instead of piling onto one candidate, rematches are avoided while an
   unplayed opponent still exists, standings tally correctly including bye credit, and the whole
   thing is exactly as deterministic as every other lab command. ---------- */

const shortSwiss = extra => ({ worlds: ["ferros"], seeds: 1, seedBase: 7, minutes: 4, ...extra });

test("Swiss is deterministic — same candidates, same config, byte-identical result", () => {
  const candidates = [
    { name: "A", strategy: "default" }, { name: "B", strategy: "aggressive" },
    { name: "C", strategy: "economic" }, { name: "D", strategy: "default" },
  ];
  const opts = shortSwiss();
  assert.equal(JSON.stringify(runSwissTournament(candidates, opts)), JSON.stringify(runSwissTournament(candidates, opts)),
    "two identical Swiss tournaments diverged: something reads a clock or an unseeded pick");
});

test("a different seed base genuinely changes a Swiss tournament (not pinned to one roll)", () => {
  const candidates = [
    { name: "A", strategy: "default" }, { name: "B", strategy: "aggressive" },
    { name: "C", strategy: "economic" }, { name: "D", strategy: "default" },
  ];
  const x = runSwissTournament(candidates, shortSwiss({ seedBase: 1 }));
  const y = runSwissTournament(candidates, shortSwiss({ seedBase: 2 }));
  assert.notEqual(JSON.stringify(x), JSON.stringify(y), "two different seed bases produced identical Swiss results");
});

test("Swiss needs at least 2 candidates, and rejects duplicate names up front (round-robin's own guard)", () => {
  assert.throws(() => runSwissTournament([{ name: "A", strategy: "default" }], shortSwiss()), /at least 2 candidates/);
  const dup = [{ name: "A", strategy: "default" }, { name: "A", strategy: "aggressive" }];
  assert.throws(() => runSwissTournament(dup, shortSwiss()), /duplicate candidate name/);
});

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
const field = n => Array.from({ length: n }, (_, i) => ({ name: `C${i}`, strategy: "default" }));

test("a bye never lets a candidate that structurally cannot fight tie or beat one that actually won", () => {
  // The exact scenario an independent review found broken: an odd field where one candidate is
  // neverInitiates + a zero standing-army cap (cannot ever field a fight in skirmish) draws a bye,
  // and a genuine winner must still rank strictly above it — a bye must never be worth what a real
  // win is worth.
  // Names chosen so the bye lands on a CRIPPLED candidate: pairRound tie-breaks an all-zero round-1
  // standing by name (it used to take whichever was listed last, which made the bye depend on CLI
  // argument order), and the recipient is the last such name. So "zz-crippled" draws it, leaving
  // "a-normal" to actually fight — which is what gives this test something to compare.
  const normal = { name: "a-normal", strategy: "default" };
  const crippled = (name) => ({
    name, strategy: `labByeCrippled_${name}`,
    overrides: { strategies: { [`labByeCrippled_${name}`]: { neverInitiates: true, standingArmyCap: 0 } } },
  });
  const candidates = [normal, crippled("m-crippled"), crippled("zz-crippled")];
  const opts = shortSwiss({ worlds: ["korrath"], minutes: 15, seeds: 1, rounds: 1 });
  const [bracket] = runSwissTournament(candidates, opts);
  const byeRecipient = bracket.roundsLog[0].byeName;
  assert.ok(byeRecipient, "fixture: 3 candidates is odd, a bye must fire");
  const byeRow = bracket.standings.find(s => s.name === byeRecipient);
  const normalRow = bracket.standings.find(s => s.name === "a-normal");
  assert.equal(byeRow.wins, 0, "a candidate that never fought must have zero wins, bye or not");
  assert.ok(normalRow.wins > byeRow.wins,
    `the genuine winner (${normalRow.wins} wins) must rank strictly above a bye recipient that never fought (${byeRow.wins} wins)`);
});

test("Swiss standings: total wins equal total losses — a bye contributes to neither", () => {
  // Every REAL pairing is win/loss-balanced (one side's win is the other's loss, exactly like
  // round-robin's own invariant), and a bye is now scorable-neutral (previous test) — so unlike a
  // points-based Swiss ladder, there is no unmatched credit anywhere in these standings at all.
  const candidates = Array.from({ length: 5 }, (_, i) => ({ name: `C${i}`, strategy: "default" }));
  const [bracket] = runSwissTournament(candidates, shortSwiss());
  const totalWins = bracket.standings.reduce((s, c) => s + c.wins, 0);
  const totalLosses = bracket.standings.reduce((s, c) => s + c.losses, 0);
  assert.equal(totalWins, totalLosses, "every win must have a matching loss somewhere — a bye must add to neither");
});

test("a strong candidate rises to the top of Swiss standings against a field of crippled ones", () => {
  // Same crippled fixture shape as the duel/round-robin tests above (neverInitiates + a zero
  // standing-army cap is absolute defencelessness in skirmish) — proves the Swiss SCHEDULE, not
  // just one pairing, surfaces a genuinely stronger candidate at the top.
  const normal = { name: "normal", strategy: "default" };
  const crippled = (i) => ({
    name: `crippled${i}`, strategy: `labSwissCrippled${i}`,
    overrides: { strategies: { [`labSwissCrippled${i}`]: { neverInitiates: true, standingArmyCap: 0 } } },
  });
  const candidates = [normal, crippled(1), crippled(2), crippled(3)];
  const [bracket] = runSwissTournament(candidates, shortSwiss({ worlds: ["korrath"], minutes: 15, seeds: 1 }));
  assert.equal(bracket.standings[0].name, "normal",
    `the only genuine fighter should top the Swiss standings, got: ${JSON.stringify(bracket.standings.map(s => s.name))}`);
});

test("--difficulties (plural) runs an independent Swiss tournament per difficulty, never blended", () => {
  const candidates = [
    { name: "A", strategy: "default" }, { name: "B", strategy: "aggressive" }, { name: "C", strategy: "economic" },
  ];
  const brackets = runSwissTournament(candidates, shortSwiss({ difficulties: ["easy", "hard"] }));
  assert.equal(brackets.length, 2, "two difficulties -> two standalone Swiss tournaments");
  assert.deepEqual(brackets.map(b => b.difficulty), ["easy", "hard"]);
  assert.notEqual(JSON.stringify(brackets[0].roundsLog), JSON.stringify(brackets[1].roundsLog),
    "the two difficulty brackets must be independently-run tournaments, not one relabelled as two");
});

test("an unknown difficulty is normalized everywhere it's reported, not just where matches run: duel, round-robin, Swiss", () => {
  // pinnedDuelDials() already normalizes an unknown/typo'd difficulty to "medium" for apm/micro,
  // and every match row reports that normalized value — but three separate top-level aggregate
  // fields each independently echoed the raw input instead: runDuel's own return, and (found by a
  // later independent review of this same difficulty-echo bug CLASS) runRoundRobinSwapped's and
  // runSwissBracket's per-bracket `.difficulty` field. All three must agree with what actually ran.
  const a = { name: "A", strategy: "default" }, b = { name: "B", strategy: "aggressive" };
  const c = { name: "C", strategy: "economic" };
  const short = { worlds: ["ferros"], seeds: 1, minutes: 3 };
  const bogus = "totallyBogusTypo";

  const duelRes = runDuel(a, b, { ...short, difficulty: bogus });
  assert.equal(duelRes.difficulty, "medium", "runDuel's aggregate difficulty must be normalized, not the raw input");

  const [rrBracket] = runRoundRobinSwapped([a, b, c], { ...short, difficulty: bogus });
  assert.equal(rrBracket.difficulty, "medium", "runRoundRobinSwapped's bracket difficulty must be normalized, not the raw input");

  const [swissBracket] = runSwissTournament([a, b, c], { ...short, difficulty: bogus });
  assert.equal(swissBracket.difficulty, "medium", "runSwissTournament's bracket difficulty must be normalized, not the raw input");
});

test("a Swiss tournament's overrides never leak into what runs next", () => {
  const before = JSON.stringify(STRATEGIES.aggressive);
  const candidates = [
    { name: "A", strategy: "aggressive", overrides: { strategies: { aggressive: { garrisonMult: 0.01 } } } },
    { name: "B", strategy: "default" }, { name: "C", strategy: "economic" },
  ];
  runSwissTournament(candidates, shortSwiss());
  assert.equal(JSON.stringify(STRATEGIES.aggressive), before,
    "STRATEGIES.aggressive must be restored once the Swiss tournament is done, same promise as duel/round-robin/leaderboard");
});

test("two duel candidates that patch the same table key are rejected, not silently merged (A9)", () => {
  // runDuel applies BOTH candidates' overrides into the same live STRATEGIES table, and
  // applyOverrides MERGES rather than replaces. Two variants of the same dial under the same
  // strategy key — the natural A/B tuning workflow — therefore collapsed into one Frankenstein row
  // belonging to neither candidate, played by BOTH seats, and reported a perfectly normal-looking
  // winner that was pure seat/seed noise. Every tuning decision runs through this function, and
  // `search --tournament-against` scores every dial value through it.
  const a = { name: "early", strategy: "probe", overrides: { strategies: { probe: { attackTimeoutMult: 0.2 } } } };
  const b = { name: "late", strategy: "probe", overrides: { strategies: { probe: { attackTimeoutMult: 1.8 } } } };
  assert.throws(() => runDuel(a, b, { worlds: ["korrath"], seeds: 1, minutes: 2 }),
    /both candidates override/,
    "a shared override key must be refused up front, not merged into a mirror match");
});

test("two duel candidates overriding DIFFERENT keys still run (A9 regression fence)", () => {
  const a = { name: "x", strategy: "probeA", overrides: { strategies: { probeA: { attackTimeoutMult: 0.5 } } } };
  const b = { name: "y", strategy: "probeB", overrides: { strategies: { probeB: { attackTimeoutMult: 1.5 } } } };
  assert.doesNotThrow(() => runDuel(a, b, { worlds: ["korrath"], seeds: 1, minutes: 2 }));
});

test("the side-swap is a PAIRED comparison: both directions play the same maps (T2)", () => {
  // runSwappedDuel's own header says the swap exists so "a side-symmetry bug would show up as those
  // two disagreeing". It could not: duelSeed hashes the candidate names in ORDER, and the two
  // directions call runDuel(a,b) then runDuel(b,a), so the halves differed in seat AND MAP.
  // A disagreement was therefore confounded with ordinary seed variance and carried no information
  // about seat symmetry — while the seat asymmetry it was meant to catch is real and measurable.
  // swapAsym, the map-side control, was already paired correctly by replicate parity; this makes
  // the seat-side control match.
  const res = runSwappedDuel({ name: "alpha" }, { name: "beta" },
    { worlds: ["korrath"], seeds: 2, minutes: 2 });
  const fixture = rows => rows.map(r => [r.world, r.seed, r.swapAsym]);
  assert.deepEqual(fixture(res.bAsAi.rows), fixture(res.aAsAi.rows),
    "both directions must play the SAME world/seed/asym fixtures — only the seat differs");
});

/* ---------- the per-side archetype plumb through runDuel (docs/ai-evolution-design.md §8.4) ----------

   tools/duelCore.js's runDuelMatch has always accepted aArchetype/bArchetype, and
   competitionWorker.js has always passed them — but runDuel never forwarded them, so a CLI duel
   silently ignored a candidate's own archetype and gave BOTH seats whatever temperament the world
   hands out. That is invisible from the outside: the duel runs, a winner is reported, and it is a
   measurement of something other than what the candidate files describe.
   ---------- */

test("runDuel forwards each candidate's own archetype, so two temperaments really do meet", () => {
  const worlds = ["ferros"];   // an Economist world — neither candidate's own pick, so both differ from it
  const opts = { worlds, seeds: 1, minutes: 6 };
  const bothWorlds = runDuel({ name: "plain-a" }, { name: "plain-b" }, opts);
  const rusherVsTech = runDuel(
    { name: "rush", archetype: "rusher" },
    { name: "tech", archetype: "technologist" }, opts);
  // If the archetype were dropped, both duels would be the SAME match modulo candidate names — and
  // duelSeed hashes the names, so compare on the match OUTCOME rather than the seed.
  const shape = r => r.rows.map(x => `${x.winReason}:${x.time}:${x.aScore}:${x.bScore}`).join("|");
  assert.notEqual(shape(bothWorlds), shape(rusherVsTech),
    "a candidate's archetype reached nothing — runDuel is dropping aArchetype/bArchetype");
});

test("an absent archetype is byte-identical to today's behaviour", () => {
  const opts = { worlds: ["korrath"], seeds: 1, minutes: 6 };
  const shape = r => r.rows.map(x => `${x.seed}:${x.winner}:${x.winReason}:${x.time}:${x.margin}`).join("|");
  assert.equal(
    shape(runDuel({ name: "a" }, { name: "b" }, opts)),
    shape(runDuel({ name: "a", archetype: null }, { name: "b", archetype: undefined }, opts)),
    "an absent/null archetype must not change a single existing duel row");
});

test("runDuel's seedKey pins a pair's maps regardless of the candidates' names", () => {
  const opts = { worlds: ["ferros"], seeds: 2, minutes: 4, seedKey: "evolve" };
  const seeds = r => r.rows.map(x => x.seed).join("|");
  assert.equal(
    seeds(runDuel({ name: "g1i0" }, { name: "g1i1" }, opts)),
    seeds(runDuel({ name: "g9i7" }, { name: "g9i2" }, opts)),
    "with seedKey pinned, two differently-named pairs must draw the identical map set");
  assert.notEqual(
    seeds(runDuel({ name: "g1i0" }, { name: "g1i1" }, { ...opts, seedKey: undefined })),
    seeds(runDuel({ name: "g9i7" }, { name: "g9i2" }, { ...opts, seedKey: undefined })),
    "sanity: without it, the names DO reach the map draw — which is the confound seedKey exists for");
});

/* ---------- evolve: a population, bred and selected by real self-play ----------

   Short runs (tiny population, 4-minute matches) — this guards the LOOP, not the AI. Whether an
   evolved genome is actually better is a question for a long run and the search ledger, never for
   a test suite that has to finish in seconds.
   ---------- */

const evoOpts = {
  population: 4, generations: 2, worlds: ["korrath"], seeds: 1, minutes: 4, rounds: 2, elites: 1,
};

test("runEvolution is deterministic: the same seed breeds the same champion", () => {
  const strip = r => JSON.stringify({ best: r.best, log: r.log });
  assert.equal(strip(runEvolution({ ...evoOpts, seed: 5 })), strip(runEvolution({ ...evoOpts, seed: 5 })));
});

test("a different seed breeds a different run — the search is actually stochastic", () => {
  const a = runEvolution({ ...evoOpts, seed: 5, generations: 3 });
  const b = runEvolution({ ...evoOpts, seed: 6, generations: 3 });
  assert.notEqual(JSON.stringify(a.log), JSON.stringify(b.log));
});

test("the champion is a RUNNABLE candidate — it duels without an adapter", () => {
  const res = runEvolution({ ...evoOpts, seed: 3 });
  assert.ok(res.best.name && res.best.strategy && res.best.overrides.strategies[res.best.name]);
  // The actual contract: it goes straight back into the tooling it came from.
  const snap = snapshotTables();
  try {
    const duel = runDuel(res.best, { name: "Baseline: Adaptive" }, { worlds: ["korrath"], seeds: 1, minutes: 4 });
    assert.equal(duel.n, 1);
    assert.ok(["a", "b", "draw"].includes(duel.rows[0].winner));
  } finally { restoreTables(snap); }
});

test("evolution leaves the shipped AI tables exactly as it found them", () => {
  // Every genome writes a row into STRATEGIES to be evaluated. If one leaked, every LATER
  // measurement in the same process — a sweep, a check, another duel — would silently be measuring
  // a mutant. runDuel snapshot/restores around each pairing; this asserts the whole loop does too.
  const before = JSON.stringify({ s: STRATEGIES, a: ARCHETYPES, d: DIFFICULTY_OPTIONS });
  runEvolution({ ...evoOpts, seed: 8, layers: ["strategy", "archetype"] });
  assert.equal(JSON.stringify({ s: STRATEGIES, a: ARCHETYPES, d: DIFFICULTY_OPTIONS }), before);
});

test("the hall of fame is rated alongside the population and anchors the scale", () => {
  const hallOfFame = [{ name: "Baseline: Adaptive" }, { name: "Baseline: Aggressive", strategy: "aggressive" }];
  const res = runEvolution({ ...evoOpts, seed: 4, hallOfFame });
  for (const entry of res.log) {
    assert.deepEqual(entry.anchors.map(a => a.name), hallOfFame.map(h => h.name),
      "both baselines must appear in every generation's ratings");
    // edge is elo measured against the anchors' own mean — the only cross-generation-comparable
    // number here, since eloForMatches restarts from a fresh 1200 every generation.
    // (every term is logged rounded to 1dp, so the identity holds only to within that rounding)
    for (const r of entry.ranked) assert.ok(Math.abs((r.elo - entry.anchorMean) - r.edge) < 0.2,
      `edge must be elo above the anchor mean: ${r.elo} - ${entry.anchorMean} != ${r.edge}`);
  }
});

test("Odyssey-gated genes are excluded by default, because a duel is a skirmish", () => {
  const res = runEvolution({ ...evoOpts, seed: 9 });
  const keys = res.genes.map(g => g.key);
  for (const dead of ["graceMult", "grievanceMult", "forgiveness", "wantsIndustryAlways", "useBombOffensively"])
    assert.ok(!keys.includes(dead), `${dead} is read by nothing in a skirmish — evolving it is scoring drift`);
  assert.ok(runEvolution({ ...evoOpts, seed: 9, odyssey: true }).genes.some(g => g.odysseyOnly),
    "…and asking for them explicitly must still work");
});

test("elitism is monotone: the best genome is never lost to an unlucky mutation", () => {
  // With a noisy objective a generation WILL sometimes breed nothing better than what it had. The
  // guarantee elites buy is that the run's best-so-far can only ever improve.
  const res = runEvolution({ ...evoOpts, seed: 2, generations: 4, elites: 2 });
  let seen = -Infinity;
  for (const entry of res.log) seen = Math.max(seen, entry.champion.edge);
  assert.equal(+res.bestEdge.toFixed(1), seen,   // the log rounds to 1dp; the result carries full precision
    "the reported best must be the best edge any generation actually reached");
});

/* ---------- archive: MAP-Elites, a CAST rather than one optimum ----------

   The archive's whole claim is that local competition produces global diversity — a genome only
   ever displaces the current occupant of its OWN behaviour cell, so the degenerate turtle `evolve`
   found can win the "never attacks" cell and nothing else. These pin that mechanism, plus the
   binning it rests on. Short runs (tiny descriptor/duel budgets): this guards the loop, not the AI.
   ---------- */

const archiveOpts = {
  iterations: 5, descriptorWorlds: ["korrath"], descriptorMinutes: 6,
  duelWorlds: ["korrath"], duelMinutes: 4, duelSeeds: 1, screen: false,
  panel: [{ name: "Panel: Adaptive" }],
};

test("runArchive is deterministic: the same seed builds the same cast", () => {
  const strip = r => JSON.stringify(r.cells.map(c => [c.key, c.fitness, c.genome]));
  assert.equal(strip(runArchive({ ...archiveOpts, seed: 3 })), strip(runArchive({ ...archiveOpts, seed: 3 })));
});

test("a genome only ever displaces the occupant of its OWN cell", () => {
  // The mechanism, asserted directly against the log: every seating that displaced somebody must
  // name a strictly worse fitness in the SAME cell, and no seating may remove a different cell.
  const res = runArchive({ ...archiveOpts, iterations: 8, seed: 11 });
  const held = new Map();
  for (const e of res.log) {
    if (!e.seated) continue;
    if (e.beat != null) {
      assert.ok(held.has(e.cell), `${e.name} displaced someone in an empty cell "${e.cell}"`);
      assert.ok(e.fitness > e.beat, `${e.name} seated in "${e.cell}" without beating the holder`);
    }
    held.set(e.cell, e.fitness);
  }
  // …and every cell in the final archive is one the log actually seated, at that fitness.
  for (const c of res.cells) assert.equal(held.get(c.key), +c.fitness.toFixed(3));
});

test("every cell in the archive really is a distinct behaviour", () => {
  const res = runArchive({ ...archiveOpts, iterations: 8, seed: 4 });
  assert.equal(new Set(res.cells.map(c => c.key)).size, res.cells.length, "duplicate cell keys");
  // The key must be derivable from the descriptors — i.e. a cell genuinely describes how it plays,
  // rather than being an arbitrary label attached at seating time.
  for (const c of res.cells)
    assert.equal(c.key, ARCHIVE_DIMS.map(d => d.names[binOf(c.desc[d.key], d.edges)]).join("/"),
      "a cell's key disagrees with its own measured descriptors");
});

test("the health screen refuses entry outright, and never duels what it refuses", () => {
  // Forcing the refusal path takes a deliberate setup now, and the reason is the point: with the
  // seed strategies present, a 6-minute descriptor run's dev-flatline is TOLERATED, because the
  // shipped AI trips it here too. Passing no seeds leaves nothing to calibrate against, so the raw
  // detector list is enforced — which is the only configuration where an absolute screen is the
  // intended behaviour rather than the bug the test below pins.
  const res = runArchive({ ...archiveOpts, iterations: 6, seed: 7, screen: true, seedStrategies: [] });
  assert.deepEqual(res.tolerated, [], "with no seeds there is nothing to calibrate against");
  const refused = res.log.filter(e => e.reason === "screen");
  assert.ok(refused.length > 0, "a 6-minute descriptor run must trip dev-flatline — CHECKS is calibrated for 40-60m");
  for (const e of refused) {
    assert.equal(e.seated, false);
    // The early return is the saving, not a detail: scoring is the expensive half of an evaluation,
    // so a screen that refused AFTER duelling would cost the same as no screen at all.
    assert.equal(e.fitness, undefined, "a refused genome must not be duelled");
    assert.ok(!res.cells.some(c => c.name === e.name), "a refused genome reached the archive anyway");
  }
  assert.equal(res.rejected, refused.length);
});

test("archive cells lower to runnable candidates, each carrying its own strategy key", () => {
  const res = runArchive({ ...archiveOpts, iterations: 6, seed: 5 });
  assert.ok(res.cells.length > 0, "the archive is empty — nothing to promote");
  const names = new Set();
  for (const c of res.cells) {
    const cand = toCandidate(c.genome, `cast-${c.key.replace(/\//g, "-")}`, { genes: res.genes });
    assert.ok(cand.overrides.strategies[cand.name], "no strategy row");
    assert.ok(!names.has(cand.name), "two cells produced the same candidate name — they would collide in a duel");
    names.add(cand.name);
  }
});

test("the archive leaves the shipped AI tables exactly as it found them", () => {
  const before = JSON.stringify({ s: STRATEGIES, a: ARCHETYPES, d: DIFFICULTY_OPTIONS });
  runArchive({ ...archiveOpts, iterations: 6, seed: 9, layers: ["strategy", "archetype"] });
  assert.equal(JSON.stringify({ s: STRATEGIES, a: ARCHETYPES, d: DIFFICULTY_OPTIONS }), before);
});

test("labWorld forwards an archetype, so a genome's own temperament reaches the descriptor run", () => {
  // Without this the solo bench silently measures the WORLD's archetype, and an archive over the
  // archetype chromosome would bin every genome by a temperament none of them carry.
  const shape = s => `${s.ai.archetype.name}`;
  assert.equal(shape(labWorld({ world: "ferros", strategy: "default", difficulty: "medium",
    opponent: "passive", seed: 1, apm: "real" }).state), "Economist", "ferros' own archetype");
  assert.equal(shape(labWorld({ world: "ferros", strategy: "default", difficulty: "medium",
    opponent: "passive", seed: 1, apm: "real", archetype: "rusher" }).state), "Rusher",
    "an explicit archetype must win over the world's");
});

test("the health screen never refuses the SHIPPED strategies — it calibrates against them", () => {
  // THE REGRESSION THIS EXISTS FOR. The archive's first real run refused 39 of its first 41
  // genomes, including all four shipped strategies, because CHECKS was calibrated against the
  // `passive` sparring bot while the descriptor run deliberately uses a provoking one — where the
  // AI spends on army, takes losses, and never clears dev-flatline's development threshold. A
  // detector firing on correct behaviour is worse than no detector; the seeds are the definition
  // of correct behaviour available, so they set the tolerance instead of being judged by it.
  const res = runArchive({ ...archiveOpts, iterations: 8, seed: 13, screen: true, descriptorMinutes: 6 });
  const seeds = res.log.filter(e => e.origin.startsWith("seed:"));
  assert.equal(seeds.length, Object.keys(STRATEGIES).length, "every shipped strategy must be evaluated");
  for (const s of seeds)
    assert.notEqual(s.reason, "screen", `the shipped strategy ${s.origin} was refused by the screen`);
  // A 6-minute descriptor run trips detectors calibrated for 40-60m, so this run MUST have
  // something to tolerate — otherwise the test would pass vacuously on a screen that never fired.
  assert.ok(res.tolerated.length > 0, "nothing was tolerated — the calibration path never engaged");
  // …and the tolerance is exactly what the seeds tripped, no more.
  const seedTrips = new Set(seeds.flatMap(s => s.tripped));
  assert.deepEqual([...res.tolerated].sort(), [...seedTrips].sort());
  // Nobody is refused for a defect the shipped AI also shows.
  for (const e of res.log.filter(e => e.reason === "screen")) {
    assert.ok(e.novel.length > 0, `${e.name} was refused with no novel defect`);
    for (const t of e.novel) assert.ok(!res.tolerated.includes(t), `${t} is tolerated but was held against ${e.name}`);
  }
});
