/* ============================================================
   T-023 (ADR-0006 rule 4, docs/analysis/02-command-wire-protocol.md §5):
   server/matchLoop.js's whole reason to exist is ONE property — the exit criterion literally
   states it: shuffled arrival order yields an identical final-state fingerprint. Everything else
   here is either a precondition for that (the sort key really is (applyTick, ownerIndex, seq),
   not admission/call order) or a robustness property the dossier calls out by name (a late
   command still applies; a rejection is logged, not dropped; an exact resend is not re-applied).
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState } from "../engine/state.js";
import { mulberry32 } from "../engine/rng.js";
import { serializeGameString, deserializeGame } from "../engine/persist.js";
import { entitySnapshot } from "./_helpers.js";
import { createMatch, admit, stepMatch, INPUT_DELAY_TICKS, toCommandResult } from "../server/matchLoop.js";
import { encode, PROTOCOL_VERSION } from "../net/commandEnvelope.js";

function makeMatch(seed = 12345) {
  const state = createGameState({ planetId: "ferros", seed, rng: mulberry32(seed) });
  return createMatch(state);
}

const playerUnit = m => [...m.state.units.values()].find(u => u.owner === "player");
const aiUnit = m => [...m.state.units.values()].find(u => u.owner === "ai");

test("admit() queues a shape-valid envelope without touching state, stamped for state.tick + INPUT_DELAY_TICKS", () => {
  const match = makeMatch();
  const w = playerUnit(match);
  const before = JSON.stringify(entitySnapshot(match.state));

  const r = admit(match, encode({ t: "move", ids: [w.id], x: 500, y: 500 }, 1), "player");

  assert.equal(r.ok, true);
  assert.equal(match.pending.length, 1);
  assert.equal(match.pending[0].applyTick, match.state.tick + INPUT_DELAY_TICKS);
  assert.equal(match.pending[0].owner, "player");
  assert.equal(match.pending[0].result, null, "not applied yet");
  assert.equal(JSON.stringify(entitySnapshot(match.state)), before, "admission alone never mutates state");
});

test("admit() rejects a shape-invalid envelope and never queues it (delegates to net/commandEnvelope.js's decode)", () => {
  const match = makeMatch();
  const badVersion = encode({ t: "stop", ids: ["u1"] }, 1);
  badVersion.v = PROTOCOL_VERSION + 1;
  assert.equal(admit(match, badVersion, "player").ok, false);

  assert.equal(admit(match, encode({ t: "not-a-real-type" }, 2), "player").ok, false);
  assert.equal(admit(match, null, "player").ok, false);
  assert.equal(match.pending.length, 0, "nothing malformed ever reaches the queue");
});

test("admit() is idempotent on an exact (owner, seq) resend — queued at most once", () => {
  const match = makeMatch();
  const w = playerUnit(match);
  const envelope = encode({ t: "move", ids: [w.id], x: 1, y: 1 }, 7);

  assert.equal(admit(match, envelope, "player").ok, true);
  assert.equal(admit(match, envelope, "player").ok, true, "a resend is not an error");
  assert.equal(match.pending.length, 1, "but it is only ever queued once");

  // A DIFFERENT owner using the same seq is a different (owner, seq) pair — not a duplicate.
  assert.equal(admit(match, envelope, "ai").ok, true);
  assert.equal(match.pending.length, 2);
});

test("stepMatch(): a command applies only once its stamped applyTick has actually arrived, not before", () => {
  const match = makeMatch();
  const w = playerUnit(match);
  admit(match, encode({ t: "move", ids: [w.id], x: 777, y: 777 }, 1), "player");

  for (let i = 0; i < INPUT_DELAY_TICKS; i++) {
    stepMatch(match, 0.05);
    assert.notEqual(w.order && w.order.x, 777, `must not have applied yet at tick ${match.state.tick}`);
  }
  stepMatch(match, 0.05);   // the tick the command is actually due
  assert.equal(w.order.x, 777);
  assert.equal(w.order.y, 777);
});

test("stepMatch(): applies in (applyTick, ownerIndex, seq) order — never admission/call order", () => {
  const match = makeMatch();
  assert.deepEqual(match.state.owners, ["player", "ai"], "fixture assumption: ownerIndex(player)=0, ownerIndex(ai)=1");

  // Admitted (called) in deliberately scrambled order relative to the expected sort.
  admit(match, encode({ t: "stop", ids: ["x"] }, 1), "ai");
  admit(match, encode({ t: "stop", ids: ["x"] }, 5), "player");
  admit(match, encode({ t: "stop", ids: ["x"] }, 0), "ai");
  admit(match, encode({ t: "stop", ids: ["x"] }, 1), "player");

  for (let i = 0; i <= INPUT_DELAY_TICKS; i++) stepMatch(match, 0.05);

  assert.deepEqual(match.log.map(r => `${r.owner}:${r.seq}`), ["player:1", "player:5", "ai:0", "ai:1"],
    "player (ownerIndex 0) before ai (ownerIndex 1); each owner's own records by seq");
});

test("stepMatch(): a command whose applyTick has already passed still applies — sorted by its ORIGINAL applyTick, not dropped", () => {
  const match = makeMatch();
  const w = playerUnit(match);
  // Bypass admit()'s normal stamping to simulate a slow admission arriving after its own
  // scheduled tick has already gone by (dossier §5.3's own named case).
  match.pending.push({ v: 1, seq: 1, owner: "player", applyTick: match.state.tick - 5, cmd: { t: "move", ids: [w.id], x: 42, y: 42 }, result: null });

  stepMatch(match, 0.05);

  assert.equal(w.order.x, 42, "a late command must still apply, not be silently skipped");
});

test("stepMatch(): a rejected command is still appended to the log with its reject code, not silently dropped", () => {
  const match = makeMatch();
  const aiW = aiUnit(match);
  // player has no ownership of an ai unit -> the codec rejects this with NOT_OWNER.
  admit(match, encode({ t: "move", ids: [aiW.id], x: 1, y: 1 }, 1), "player");

  for (let i = 0; i <= INPUT_DELAY_TICKS; i++) stepMatch(match, 0.05);

  assert.equal(match.log.length, 1);
  assert.deepEqual(match.log[0].result, { rejected: "not-owner" });
  assert.equal(match.log[0].appliedAtTick, match.log[0].applyTick, "a same-tick reject still records when it was resolved");
});

test("stepMatch(): emitAck fires once per record, in final (sorted) log order; the default is a harmless no-op", () => {
  const acked = [];
  const state = createGameState({ planetId: "ferros", seed: 9, rng: mulberry32(9) });
  const match = createMatch(state, { emitAck: rec => acked.push(rec.seq) });
  admit(match, encode({ t: "stop", ids: ["x"] }, 9), "player");
  admit(match, encode({ t: "stop", ids: ["x"] }, 2), "player");

  for (let i = 0; i <= INPUT_DELAY_TICKS; i++) stepMatch(match, 0.05);
  assert.deepEqual(acked, [2, 9]);

  const silent = makeMatch();
  admit(silent, encode({ t: "stop", ids: ["x"] }, 1), "player");
  assert.doesNotThrow(() => { for (let i = 0; i <= INPUT_DELAY_TICKS; i++) stepMatch(silent, 0.05); });
});

test("stepMatch(): applies before tick() advances — a record's appliedAtTick is the PRE-tick() value, matching state.tick at the moment apply() ran", () => {
  const match = makeMatch();
  const w = playerUnit(match);
  admit(match, encode({ t: "move", ids: [w.id], x: 5, y: 5 }, 1), "player");
  for (let i = 0; i < INPUT_DELAY_TICKS; i++) stepMatch(match, 0.05);

  const tickBeforeThisStep = match.state.tick;
  stepMatch(match, 0.05);

  assert.equal(match.log[0].appliedAtTick, tickBeforeThisStep);
  assert.equal(match.state.tick, tickBeforeThisStep + 1, "tick() still advanced exactly once, AFTER application");
});

/* ---------- the exit criterion, verbatim ---------- */

test("exit criterion: shuffled arrival (admission) order yields an identical final-state fingerprint", () => {
  const seed = 4242;

  function driveInOrder(order) {
    const match = makeMatch(seed);
    const w0 = [...match.state.units.values()].filter(u => u.owner === "player" && u.type === "worker")[0];
    const w1 = [...match.state.units.values()].filter(u => u.owner === "player" && u.type === "worker")[1];
    const aiW = aiUnit(match);

    const envelopes = [
      { owner: "player", env: encode({ t: "move", ids: [w0.id], x: w0.x + 100, y: w0.y }, 1) },
      { owner: "ai",     env: encode({ t: "move", ids: [aiW.id], x: aiW.x - 100, y: aiW.y }, 1) },
      { owner: "player", env: encode({ t: "move", ids: [w1.id], x: w1.x + 200, y: w1.y }, 2) },
      { owner: "player", env: encode({ t: "recycle", ids: [w1.id] }, 3) },
    ];
    for (const i of order) admit(match, envelopes[i].env, envelopes[i].owner);

    for (let i = 0; i < INPUT_DELAY_TICKS + 20; i++) stepMatch(match, 0.05);
    return entitySnapshot(match.state);
  }

  const forward = driveInOrder([0, 1, 2, 3]);
  const reversed = driveInOrder([3, 2, 1, 0]);
  const shuffled = driveInOrder([2, 0, 3, 1]);

  assert.equal(reversed, forward, "reversed admission order must not change the outcome");
  assert.equal(shuffled, forward, "arbitrarily shuffled admission order must not change the outcome");
});

/* ---------- toCommandResult (T-029): a shared log-record -> wire-CommandResult translator ---------- */

test("toCommandResult() turns a rejected record's {rejected:code} shape into {ok:false, code}", () => {
  assert.deepEqual(toCommandResult({ rejected: "not-owner" }), { ok: false, code: "not-owner" });
});

test("toCommandResult() turns an applied record's success payload into {ok:true, result}", () => {
  assert.deepEqual(toCommandResult({ buildingId: "b42" }), { ok: true, result: { buildingId: "b42" } });
});

test("toCommandResult() turns a bare null (applied, no payload) into {ok:true, result:null}", () => {
  assert.deepEqual(toCommandResult(null), { ok: true, result: null });
});

/* ---------- T-029a's own exit criterion: snapshot mid-play, restore, continue ---------- */

test("a match snapshotted mid-play, restored into a fresh state object and continued, yields the same fingerprint as one that ran uninterrupted", () => {
  const seed = 87654;

  function driveUninterrupted() {
    const match = makeMatch(seed);
    const w = playerUnit(match);
    admit(match, encode({ t: "move", ids: [w.id], x: w.x + 150, y: w.y }, 1), "player");
    for (let i = 0; i < 60; i++) stepMatch(match, 0.05);
    return entitySnapshot(match.state);
  }

  function driveViaSnapshotRestore() {
    const match = makeMatch(seed);
    const w = playerUnit(match);
    admit(match, encode({ t: "move", ids: [w.id], x: w.x + 150, y: w.y }, 1), "player");
    // Drive well past INPUT_DELAY_TICKS so the admitted move has already been applied and
    // match.pending is empty — engine/persist.js's save format covers state only, never
    // match.pending/log/seenSeq (see server/matchSnapshot.js's own header for why that's a
    // deliberate, bounded scope decision, not an oversight this test happens to dodge).
    for (let i = 0; i < 30; i++) stepMatch(match, 0.05);
    assert.equal(match.pending.length, 0, "fixture sanity: nothing still in flight at snapshot time");

    // The actual round trip: serialize, then rehydrate into a COMPLETELY FRESH state object and
    // match wrapper — never the same live objects — proving restoration, not just continuing the
    // original in memory.
    const saved = serializeGameString(match.state);
    const restoredMatch = createMatch(deserializeGame(JSON.parse(saved)));

    for (let i = 0; i < 30; i++) stepMatch(restoredMatch, 0.05);
    return entitySnapshot(restoredMatch.state);
  }

  assert.equal(driveViaSnapshotRestore(), driveUninterrupted());
});
