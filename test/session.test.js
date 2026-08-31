import { test } from "node:test";
import assert from "node:assert/strict";
import { createSession } from "../server/session.js";
import { createGameState } from "../engine/state.js";
import { mulberry32 } from "../engine/rng.js";

// server/session.js is the ADR-0003/ADR-0004 seam: a session owns one match's
// state, applies commands through the SAME command taxonomy the wire protocol
// will use (net/commandShapes.js), and can be driven headlessly with no
// browser, no transport, no requestAnimationFrame — exactly like
// tools/selfplay.js already proves the underlying engine can be.
//
// Phase 1 scope (TASKS.md, ADR-0004): submitCommand resolves ids and applies
// the corresponding engine/commands.js issue* call — it does NOT yet validate
// ownership or fog (that is Phase 2's net/commandCodec.js, layered on top of
// this, not a rewrite of it). What it DOES do, deliberately, even now: drop a
// dead id gracefully rather than throw, and reject a malformed/unknown
// command shape — both are basic input robustness, not security policy.

function baseOpts(seed = 12345) {
  return { planetId: "ferros", seed, rng: mulberry32(seed) };
}

test("createSession produces a state shaped like engine/state.js's createGameState", () => {
  const session = createSession(baseOpts());
  const state = session.getState();
  assert.equal(state.planetId, "ferros");
  assert.deepEqual(state.owners, ["player", "ai"]);
  assert.equal(state.time, 0);
  assert.equal(state.over, false);
  assert.ok(state.units.size > 0, "a fresh skirmish seeds starting units");
});

test("tick(dt) advances sim time by exactly dt, deterministically", () => {
  const session = createSession(baseOpts());
  session.tick(0.05);
  assert.equal(session.getState().time, 0.05);
  session.tick(0.05);
  assert.equal(session.getState().time, 0.1);
});

test("two sessions built from the same seed tick to byte-identical fingerprints", () => {
  // The whole point of keeping determinism under server authority (ADR-0003):
  // this is what makes (seed, command log) a complete replay later.
  //
  // Deliberately SEQUENTIAL, not interleaved. engine/state.js's nextEntityId is a
  // module-global (docs/adr/0011-one-match-per-process.md, TASKS.md T-016,
  // scheduled for Phase 2 — not fixed here): two sessions ticked in an
  // INTERLEAVED loop in one process mint colliding entity ids from the shared
  // counter, which is a real, already-documented, deliberately-deferred defect,
  // not something this test exists to catch. Running the two sessions fully
  // one after the other avoids that interleaving and still proves the actual
  // property this test cares about — same seed, same game.
  const a = createSession(baseOpts(777));
  for (let i = 0; i < 50; i++) a.tick(0.05);
  const fingerprintA = JSON.parse(JSON.stringify([...a.getState().units.values()]));

  const b = createSession(baseOpts(777));
  for (let i = 0; i < 50; i++) b.tick(0.05);
  const fingerprintB = JSON.parse(JSON.stringify([...b.getState().units.values()]));

  assert.deepEqual(fingerprintA, fingerprintB);
});

test("submitCommand(move) issues a move order on a real owned unit", () => {
  const session = createSession(baseOpts());
  const state = session.getState();
  const worker = [...state.units.values()].find(u => u.owner === "player");
  assert.ok(worker, "fixture assumption: the player starts with at least one unit");

  const result = session.submitCommand({ t: "move", ids: [worker.id], x: 500, y: 500 });
  assert.equal(result.ok, true);
  assert.equal(worker.order.type, "move");
  assert.equal(worker.order.x, 500);
  assert.equal(worker.order.y, 500);
});

test("submitCommand drops a dead/unknown id instead of throwing, and reports empty-selection when nothing resolves", () => {
  const session = createSession(baseOpts());
  const state = session.getState();
  const worker = [...state.units.values()].find(u => u.owner === "player");

  // One real id, one fabricated — the real one still gets the order.
  const mixed = session.submitCommand({ t: "move", ids: [worker.id, "u-does-not-exist"], x: 400, y: 400 });
  assert.equal(mixed.ok, true);
  assert.equal(worker.order.x, 400);

  // Every id fabricated — nothing to apply, and no throw.
  const empty = session.submitCommand({ t: "move", ids: ["u-nope-1", "u-nope-2"], x: 1, y: 1 });
  assert.equal(empty.ok, false);
  assert.equal(empty.code, "empty-selection");
});

test("submitCommand rejects a malformed envelope without throwing", () => {
  const session = createSession(baseOpts());
  assert.equal(session.submitCommand({ t: "not-a-real-command-type" }).ok, false);
  assert.equal(session.submitCommand({ t: "not-a-real-command-type" }).code, "unknown-type");
  assert.equal(session.submitCommand(null).ok, false);
  assert.equal(session.submitCommand({}).ok, false);
});

test("submitCommand(batch) applies every member command in order", () => {
  const session = createSession(baseOpts());
  const state = session.getState();
  const workers = [...state.units.values()].filter(u => u.owner === "player").slice(0, 2);
  assert.ok(workers.length >= 2, "fixture assumption: at least two starting player units");

  const result = session.submitCommand({
    t: "batch",
    c: [
      { t: "move", ids: [workers[0].id], x: 200, y: 200 },
      { t: "move", ids: [workers[1].id], x: 800, y: 800 },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(workers[0].order.x, 200);
  assert.equal(workers[1].order.x, 800);
});

test("submitCommand(queueProduction) and (researchUpgrade) reach the same engine calls the client's HUD makes", () => {
  const session = createSession(baseOpts());
  const state = session.getState();
  const cc = [...state.buildings.values()].find(b => b.owner === "player" && b.type === "command");
  assert.ok(cc, "fixture assumption: the player starts with a Command Center");

  const result = session.submitCommand({ t: "queueProduction", building: cc.id, u: "worker" });
  assert.equal(result.ok, true);
  assert.ok(cc.queue && cc.queue.length > 0, "queueProduction should have queued a build order");
});

test("submitCommand(build) constructs a building for a real worker", () => {
  const session = createSession(baseOpts());
  const state = session.getState();
  const worker = [...state.units.values()].find(u => u.owner === "player" && u.type === "worker");
  assert.ok(worker, "fixture assumption: the player starts with a Worker");

  const before = state.buildings.size;
  // Far enough from the base to not collide with existing structures.
  const result = session.submitCommand({ t: "build", worker: worker.id, b: "barracks", x: worker.x + 300, y: worker.y + 300 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(state.buildings.size, before + 1);
});

test("submitCommand(recycle) works on a real owned unit", () => {
  const session = createSession(baseOpts());
  const state = session.getState();
  const worker = [...state.units.values()].find(u => u.owner === "player" && u.type === "worker");
  const result = session.submitCommand({ t: "recycle", ids: [worker.id] });
  assert.equal(result.ok, true);
  assert.ok(worker.recycling, "issueRecycle should mark the unit as recycling");
});

test("createSession wraps an ALREADY-BUILT state as-is (opts.state) instead of building a fresh one — boot.js's loaded-game path needs this: a deserialized save is not re-creatable from gameOpts", () => {
  const prebuilt = createGameState(baseOpts(42));
  const worker = [...prebuilt.units.values()].find(u => u.owner === "player");
  worker.hp = 1;   // a mutation only visible if the session really is THIS object, not a fresh one
  const session = createSession({ state: prebuilt });

  assert.equal(session.getState(), prebuilt, "no copy — the exact object handed in");
  assert.equal(session.getState().units.get(worker.id).hp, 1, "the caller's own state, not a freshly re-created one");
});

test("a session with both seats AI-driven plays a full match headlessly to a winner", () => {
  // Mirrors tools/selfplay.js's proven createSelfPlayState/tickSelfPlay pattern, just
  // reached through the session's own shape — this IS T-010's exit criterion.
  const session = createSession({ ...baseOpts(999), matchTimeLimit: 600, aiSeats: ["player"] });
  const DT = 0.1;
  let ticks = 0;
  const MAX_TICKS = (600 + 120) / DT;   // matchTimeLimit + slack, same bound tools/selfplay.js uses
  while (!session.getState().over && ticks < MAX_TICKS) {
    session.tick(DT);
    ticks++;
  }
  assert.equal(session.getState().over, true, "the match should reach a terminal state within its own time limit");
  assert.ok(session.getState().winner !== undefined, "a finished match records a winner (or a draw)");
});
