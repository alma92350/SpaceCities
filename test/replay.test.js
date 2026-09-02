/* ============================================================
   T-024 (docs/analysis/02-command-wire-protocol.md §7): server/replay.js's whole reason to exist
   is the exit criterion TASKS.md states verbatim — (seed, log) replays to an identical
   fingerprint(state). Driven through the SAME admit()/stepMatch() a live match uses
   (test/matchLoop.test.js), not a hand-rolled substitute, so a real match and its own replay can
   never quietly diverge in how commands are applied.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState } from "../engine/state.js";
import { mulberry32 } from "../engine/rng.js";
import { entitySnapshot } from "./_helpers.js";
import { createMatch, admit, stepMatch, INPUT_DELAY_TICKS } from "../server/matchLoop.js";
import { encode } from "../net/commandEnvelope.js";
import { recordReplay, replayMatch, REPLAY_VERSION, REPLAY_REJECT } from "../server/replay.js";
import { APP_VERSION } from "../version.js";

function playMatch(seed, ticks) {
  const createGameStateOpts = { planetId: "ferros", seed, rng: mulberry32(seed) };
  const state = createGameState(createGameStateOpts);
  const match = createMatch(state);
  const dt = 0.05;

  const w0 = [...state.units.values()].filter(u => u.owner === "player" && u.type === "worker")[0];
  const w1 = [...state.units.values()].filter(u => u.owner === "player" && u.type === "worker")[1];
  const pCC = [...state.buildings.values()].find(b => b.owner === "player" && b.type === "command");
  const aiW = [...state.units.values()].find(u => u.owner === "ai");

  admit(match, encode({ t: "move", ids: [w0.id], x: w0.x + 200, y: w0.y }, 1), "player");
  admit(match, encode({ t: "build", worker: w1.id, b: "barracks", x: w1.x + 300, y: w1.y + 300 }, 2), "player");
  admit(match, encode({ t: "queueProduction", building: pCC.id, u: "worker" }, 3), "player");
  // A command the codec will REJECT (cross-owner) — the dossier's own point: rejections are audit
  // evidence, kept in the log, and cost nothing to replay because apply() re-rejects identically.
  admit(match, encode({ t: "move", ids: [aiW.id], x: 1, y: 1 }, 4), "player");

  for (let i = 0; i < ticks; i++) stepMatch(match, dt);
  return { match, dt, createGameStateOpts };
}

test("recordReplay + replayMatch: a played match replays to a byte-identical fingerprint", () => {
  const { match, dt, createGameStateOpts } = playMatch(4242, INPUT_DELAY_TICKS + 400);
  const replay = recordReplay({ match, dt, createGameStateOpts });

  const result = replayMatch(replay);
  assert.equal(result.ok, true);
  assert.equal(entitySnapshot(result.state), entitySnapshot(match.state));
});

test("replayMatch reconstructs its own fresh rng from the seed — never reuses whatever a caller's own createGameStateOpts.rng closure happens to carry", () => {
  // The real bug this pins: mulberry32 (engine/rng.js) returns a STATEFUL closure — each call
  // advances it — so it can never survive JSON in the first place, and reusing the SAME live
  // closure a caller's own createGameState(...) already partly consumed (the obvious thing to
  // do with the very opts object already in hand, exactly like this test's own playMatch does)
  // would replay from a shifted point in the sequence: identical seed, subtly different game.
  // A hostile payload making the same mistake on purpose — smuggling a `rng` key hoping
  // something downstream trusts it — must be just as harmless.
  const { match, dt, createGameStateOpts } = playMatch(4242, INPUT_DELAY_TICKS + 400);
  const replay = recordReplay({ match, dt, createGameStateOpts });
  assert.ok(!("rng" in replay.createGameState), "recordReplay must never store the live closure at all");

  const tampered = { ...replay, createGameState: { ...replay.createGameState, rng: createGameStateOpts.rng } };
  const result = replayMatch(tampered);

  assert.equal(result.ok, true);
  assert.equal(entitySnapshot(result.state), entitySnapshot(match.state),
    "a smuggled rng closure on the payload must be ignored, not consulted");
});

test("a rejected command in the log is replayed too, and re-rejects identically — no special-casing needed", () => {
  const { match, dt, createGameStateOpts } = playMatch(555, INPUT_DELAY_TICKS + 5);
  const rejected = match.log.find(r => r.result && r.result.rejected);
  assert.ok(rejected, "fixture sanity: the cross-owner move must actually have been rejected");

  const replay = recordReplay({ match, dt, createGameStateOpts });
  const rec = replay.commands.find(r => r.seq === rejected.seq && r.owner === rejected.owner);
  assert.ok(rec, "the rejected command must still be present in the recorded log");

  const result = replayMatch(replay);
  assert.equal(entitySnapshot(result.state), entitySnapshot(match.state));
});

test("replaying an IN-PROGRESS (not yet over) match reproduces it up to the same tick", () => {
  const { match, dt, createGameStateOpts } = playMatch(9, 50);
  assert.equal(match.state.over, false, "fixture sanity: 50 ticks is nowhere near a match end");

  const replay = recordReplay({ match, dt, createGameStateOpts });
  assert.equal(replay.outcome.over, false);
  assert.equal(replay.outcome.tick, match.state.tick);

  const result = replayMatch(replay);
  assert.equal(result.state.tick, match.state.tick);
  assert.equal(entitySnapshot(result.state), entitySnapshot(match.state));
});

test("two different seeds replay to two different fingerprints — the mechanism isn't a constant", () => {
  // 1500 ticks, matching determinism.test.js's own "different seeds diverge" fixture — base
  // positions are seed-independent (only terrain/node layout varies), and this suite's own
  // scripted commands target fixed offsets from each unit's own (identical) spawn point, so a
  // short window shows nothing seed-dependent yet; divergence needs real time for the two AIs'
  // own economies to actually diverge.
  const a = playMatch(1, 1500);
  const b = playMatch(2, 1500);
  const replayA = recordReplay({ ...a });
  const replayB = recordReplay({ ...b });
  assert.notEqual(entitySnapshot(replayMatch(replayA).state), entitySnapshot(replayMatch(replayB).state));
});

test("recordReplay's own shape carries what replayMatch needs, verbatim", () => {
  const { match, dt, createGameStateOpts } = playMatch(3, 20);
  const replay = recordReplay({ match, dt, createGameStateOpts });
  assert.equal(replay.replayVersion, REPLAY_VERSION);
  assert.equal(replay.engineVersion, APP_VERSION);
  assert.equal(replay.dt, dt);
  const { rng, ...jsonSafeOpts } = createGameStateOpts;
  assert.deepEqual(replay.createGameState, jsonSafeOpts, "rng — a live, unserializable closure — must be stripped");
  assert.equal(replay.commands.length, match.log.length);
  assert.equal(replay.outcome.tick, match.state.tick);
});

test("replayMatch rejects a malformed, version-mismatched, or shape-invalid payload without throwing", () => {
  const { match, dt, createGameStateOpts } = playMatch(7, 20);
  const good = recordReplay({ match, dt, createGameStateOpts });

  assert.equal(replayMatch(null).code, REPLAY_REJECT.MALFORMED);
  assert.equal(replayMatch({}).code, REPLAY_REJECT.MALFORMED);
  assert.equal(replayMatch({ ...good, replayVersion: REPLAY_VERSION + 1 }).code, REPLAY_REJECT.BAD_REPLAY_VERSION);
  assert.equal(replayMatch({ ...good, engineVersion: "0.0.0-not-real" }).code, REPLAY_REJECT.BAD_ENGINE_VERSION);
  assert.equal(replayMatch({ ...good, createGameState: null }).code, REPLAY_REJECT.MALFORMED);
  assert.equal(replayMatch({ ...good, commands: "not-an-array" }).code, REPLAY_REJECT.MALFORMED);
  assert.equal(replayMatch({ ...good, outcome: { tick: -1 } }).code, REPLAY_REJECT.MALFORMED);
  assert.equal(replayMatch({ ...good, dt: 0 }).code, REPLAY_REJECT.MALFORMED);

  assert.equal(replayMatch(good).ok, true, "the untouched payload must still replay cleanly");
});

test("replaying the same stored payload twice doesn't mutate it, and yields the same result both times", () => {
  const { match, dt, createGameStateOpts } = playMatch(11, 60);
  const replay = recordReplay({ match, dt, createGameStateOpts });
  const snapshot = JSON.stringify(replay);

  const first = replayMatch(replay);
  const second = replayMatch(replay);

  assert.equal(JSON.stringify(replay), snapshot, "replayMatch must not mutate the stored payload");
  assert.equal(entitySnapshot(first.state), entitySnapshot(second.state));
});
