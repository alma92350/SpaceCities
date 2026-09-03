import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./_dom.js";

/* ============================================================
   Same shared-DOM-harness (test/_dom.js) setup as test/starmap.test.js — see that file's header
   comment for why the stub must exist before ANY import and why the import order below
   (boot.js first, while `window` is still undefined, THEN window, THEN the module under
   test) matters. observer.js sits in the same import graph (boot.js and starmap.js both
   pull it in now), so it needs the exact same treatment.
   ============================================================ */

installFakeDom();
await import("../boot.js");
globalThis.window = { addEventListener() {}, removeEventListener() {} };

const { game } = await import("../session.js");
const { createGalaxy } = await import("../engine/galaxy.js");
const { makeBuilding, makeUnit } = await import("../engine/state.js");
const { createSelfPlayState } = await import("../tools/selfplay.js");
const {
  observedState, enterObserverMode, exitObserverMode, toggleObserverMode,
  spectateWorld, cycleObserverBase, findBases, observerStats,
  SPECTATE_SPEEDS, clampSpectateSpeed, nextSpectateSpeed, setSpectateSpeed,
  requestExitObserverMode,
} = await import("../observer.js");

function resetGame() {
  game.galaxy = null;
  game.state = null;
  game.input = null;
  game.observerMode = false;
  game.spectateId = null;
  game.observerCamera = null;
  game.spectateMatch = null;
  game.spectateSpeed = 1;
  game.networkSpectate = false;
}

/* ---------- observedState / enter / exit / toggle ---------- */

test("observedState() returns game.state while observerMode is off", () => {
  resetGame();
  const g = createGalaxy({ seed: 1 });
  game.galaxy = g;
  game.state = g.planets.get(g.activeId);
  assert.equal(observedState(), game.state);
  resetGame();
});

test("enterObserverMode is a no-op with nothing to observe — no crash, mode stays off", () => {
  resetGame();
  enterObserverMode();
  assert.equal(game.observerMode, false);
  resetGame();
});

/* ---------- spectating a SKIRMISH (docs/competitions-and-elo.md Phase 5) ---------- */

// A watched AI-vs-AI match is exactly the state tools/duelCore.js's runDuelMatch builds, so the
// tests below spectate the real thing rather than a hand-rolled stand-in.
function watchedMatchState() {
  return createSelfPlayState({ planetId: "ferros", seed: 7 });
}

test("enterObserverMode works for a SPECTATED match with no galaxy at all", () => {
  resetGame();
  const state = watchedMatchState();
  game.state = state;
  game.spectateMatch = { aName: "Alpha", bName: "Beta" };

  enterObserverMode();

  assert.equal(game.observerMode, true, "a watched match can be observed without an Odyssey");
  assert.equal(game.spectateId, state.planetId, "spectating the one world the match is on");
  assert.ok(game.observerCamera, "an observer camera was created");
  assert.equal(observedState(), state, "observedState falls back to the match's own state");
  resetGame();
});

test("enterObserverMode still REFUSES an ordinary skirmish the human is playing (no fog cheat)", () => {
  resetGame();
  game.state = watchedMatchState();   // a live match, but not a spectated one and not an Odyssey
  enterObserverMode();
  assert.equal(game.observerMode, false, "Observer Mode is for a match you are NOT playing");
  assert.equal(game.observerCamera, null);
  resetGame();
});

test("exitObserverMode leaves a spectated match cleanly", () => {
  resetGame();
  game.state = watchedMatchState();
  game.spectateMatch = { aName: "Alpha", bName: "Beta" };
  enterObserverMode();
  exitObserverMode();
  assert.equal(game.observerMode, false);
  assert.equal(game.spectateId, null);
  assert.equal(game.observerCamera, null);
  resetGame();
});

test("you cannot STOP observing a watched match — that would hand you an AI's army mid-match", () => {
  resetGame();
  game.state = watchedMatchState();
  game.spectateMatch = { aName: "Alpha", bName: "Beta" };
  enterObserverMode();

  assert.equal(requestExitObserverMode(), false, "the O key / Esc / the topbar button are refused");
  assert.equal(game.observerMode, true, "still observing");
  toggleObserverMode();
  assert.equal(game.observerMode, true, "…and the toggle can't sneak past it either");

  // The unconditional teardown call is a DIFFERENT thing and must still work: boot.js's
  // bootState/restartToMapSelect call it while leaving, before the spectate flag itself is cleared.
  exitObserverMode();
  assert.equal(game.observerMode, false, "teardown is never blocked");
  resetGame();
});

/* ---------- T-037 (FR-7): spectating a REAL LIVE NETWORK match — networkSpectate, not spectateMatch ---------- */

test("enterObserverMode works for a live network spectator (networkSpectate), with no galaxy and no spectateMatch either", () => {
  resetGame();
  const state = watchedMatchState();   // any real state shape works — a network spectator's own
                                        // reassembled state has the identical shape (units/buildings
                                        // Maps, a real map), this fixture just avoids duplicating one
  game.state = state;
  game.networkSpectate = true;

  enterObserverMode();

  assert.equal(game.observerMode, true, "a live network spectator can be observed without an Odyssey or a local exhibition");
  assert.equal(game.spectateId, state.planetId);
  assert.ok(game.observerCamera);
  assert.equal(observedState(), state);
  resetGame();
});

test("you cannot STOP observing a live network spectate connection either — same reasoning as a watched match, no seat to hand control back to", () => {
  resetGame();
  game.state = watchedMatchState();
  game.networkSpectate = true;
  enterObserverMode();

  assert.equal(requestExitObserverMode(), false, "the O key / Esc / the topbar button are refused");
  assert.equal(game.observerMode, true, "still observing");
  toggleObserverMode();
  assert.equal(game.observerMode, true);

  exitObserverMode();
  assert.equal(game.observerMode, false, "teardown is never blocked");
  resetGame();
});

test("in the Odyssey, exiting Observer Mode is still an ordinary player choice", () => {
  resetGame();
  const g = createGalaxy({ seed: 1 });
  game.galaxy = g;
  game.state = g.planets.get(g.activeId);
  enterObserverMode();
  assert.equal(requestExitObserverMode(), true);
  assert.equal(game.observerMode, false, "the Odyssey path is untouched — O still toggles both ways");
  resetGame();
});

/* ---------- spectate speed control ---------- */

test("SPECTATE_SPEEDS is the 1x/2x/4x/8x ladder, ascending", () => {
  assert.deepEqual(SPECTATE_SPEEDS, [1, 2, 4, 8]);
});

test("clampSpectateSpeed only ever yields a real rung — anything else falls back to 1x", () => {
  for (const s of SPECTATE_SPEEDS) assert.equal(clampSpectateSpeed(s), s);
  for (const bad of [0, -4, 3, 16, NaN, Infinity, null, undefined, "4", {}])
    assert.equal(clampSpectateSpeed(bad), 1, `${String(bad)} is not a rung`);
});

test("nextSpectateSpeed cycles the ladder and wraps back to 1x", () => {
  assert.equal(nextSpectateSpeed(1), 2);
  assert.equal(nextSpectateSpeed(2), 4);
  assert.equal(nextSpectateSpeed(4), 8);
  assert.equal(nextSpectateSpeed(8), 1, "8x wraps back round");
  assert.equal(nextSpectateSpeed(99), 2, "an off-ladder value is treated as 1x, so the next is 2x");
});

test("setSpectateSpeed writes a clamped speed onto the session", () => {
  resetGame();
  setSpectateSpeed(4);
  assert.equal(game.spectateSpeed, 4);
  setSpectateSpeed(7);
  assert.equal(game.spectateSpeed, 1, "an off-ladder request never leaves a bogus multiplier live");
  resetGame();
});

test("enterObserverMode spectates the real active world by default, with its own camera", () => {
  resetGame();
  const g = createGalaxy({ seed: 1 });
  game.galaxy = g;
  game.state = g.planets.get(g.activeId);
  enterObserverMode();
  assert.equal(game.observerMode, true);
  assert.equal(game.spectateId, g.activeId);
  assert.ok(game.observerCamera, "an observer camera was created");
  assert.equal(observedState(), g.planets.get(g.activeId));
  resetGame();
});

test("exitObserverMode clears mode, spectateId, and the observer camera", () => {
  resetGame();
  const g = createGalaxy({ seed: 1 });
  game.galaxy = g;
  game.state = g.planets.get(g.activeId);
  enterObserverMode();
  exitObserverMode();
  assert.equal(game.observerMode, false);
  assert.equal(game.spectateId, null);
  assert.equal(game.observerCamera, null);
  assert.equal(observedState(), game.state, "falls back to the real state once observing stops");
  resetGame();
});

test("toggleObserverMode flips both directions and is a no-op without a galaxy", () => {
  resetGame();
  toggleObserverMode();
  assert.equal(game.observerMode, false, "no galaxy — still off");

  const g = createGalaxy({ seed: 1 });
  game.galaxy = g;
  game.state = g.planets.get(g.activeId);
  toggleObserverMode();
  assert.equal(game.observerMode, true);
  toggleObserverMode();
  assert.equal(game.observerMode, false);
  resetGame();
});

/* ---------- spectateWorld ---------- */

test("spectateWorld is a no-op when not currently observing", () => {
  resetGame();
  const g = createGalaxy({ seed: 1 });
  game.galaxy = g;
  game.state = g.planets.get(g.activeId);
  const other = g.worlds.find(id => id !== g.activeId);
  spectateWorld(other);
  assert.equal(game.spectateId, null, "still off, so the click had no effect");
  resetGame();
});

test("spectateWorld jumps the VIEW to another world for free — no activeId change", () => {
  resetGame();
  const g = createGalaxy({ seed: 1 });
  game.galaxy = g;
  game.state = g.planets.get(g.activeId);
  enterObserverMode();
  const other = g.worlds.find(id => id !== g.activeId);

  spectateWorld(other);

  assert.equal(game.spectateId, other, "now spectating the neighbour");
  assert.equal(observedState(), g.planets.get(other));
  assert.equal(g.activeId, g.planets.get(g.activeId).planetId, "the REAL active world never moved");
  assert.notEqual(g.activeId, other, "sanity: we really did spectate a different world than the real seat");
  resetGame();
});

test("spectateWorld ignores an id the galaxy doesn't actually have", () => {
  resetGame();
  const g = createGalaxy({ seed: 1 });
  game.galaxy = g;
  game.state = g.planets.get(g.activeId);
  enterObserverMode();
  const before = game.spectateId;

  spectateWorld("not-a-real-world");

  assert.equal(game.spectateId, before, "unrecognised id left the spectated world unchanged");
  resetGame();
});

/* ---------- findBases / cycleObserverBase ---------- */

test("findBases finds a completed Command Center regardless of owner, and skips one still under construction", () => {
  const state = { units: new Map(), buildings: new Map(), map: { width: 4000, height: 4000, bases: {} } };
  const playerCC = makeBuilding("command", "player", 500, 500);
  const aiCC = makeBuilding("command", "ai", 1500, 1500);
  const risingCC = makeBuilding("command", "ai", 2500, 2500);
  risingCC.constructing = true;
  for (const b of [playerCC, aiCC, risingCC]) state.buildings.set(b.id, b);

  const bases = findBases(state);

  assert.equal(bases.length, 2, "both completed CCs, any owner — not the one still going up");
  assert.ok(bases.some(b => b.owner === "player"));
  assert.ok(bases.some(b => b.owner === "ai"), "an AI base is a legitimate cycle stop, not just the player's own");
});

test("cycleObserverBase advances through every base on repeated calls, any owner", () => {
  resetGame();
  const g = createGalaxy({ seed: 1 });
  game.galaxy = g;
  game.state = g.planets.get(g.activeId);
  enterObserverMode();
  const other = g.worlds.find(id => id !== g.activeId);
  const state = g.planets.get(other);
  state.buildings.clear();
  const a = makeBuilding("command", "ai", 400, 400);
  const b = makeBuilding("command", "player", 1200, 1200);
  state.buildings.set(a.id, a);
  state.buildings.set(b.id, b);
  spectateWorld(other);   // already parks the camera on base 0 as part of just arriving

  // Mirrors input.js's own centerOnBase: lastObsBaseAt resets to -Infinity on arrival, so the
  // FIRST Space press reads as a fresh (non-cycling) press and re-confirms base 0 — only a
  // SECOND, quick press actually advances to the next base. Both calls land well inside the
  // double-press window (real elapsed time between two synchronous calls is microseconds).
  cycleObserverBase();
  const firstStop = { x: game.observerCamera.x, y: game.observerCamera.y };
  cycleObserverBase();
  const secondStop = { x: game.observerCamera.x, y: game.observerCamera.y };

  assert.notDeepEqual(secondStop, firstStop, "a second Space press advances to the OTHER base");
  assert.equal(findBases(state).length, 2, "sanity: exactly the two bases this test set up");
  // A third press wraps back around — clampCamera may have nudged either stop off the base's
  // raw x/y (a small test map, real behaviour, not a bug), so round-tripping through the SAME
  // two-base cycle is what actually proves both bases got a turn, not just "it moved once".
  cycleObserverBase();
  const thirdStop = { x: game.observerCamera.x, y: game.observerCamera.y };
  assert.deepEqual(thirdStop, firstStop, "a third press wraps back to the first base");
  resetGame();
});

/* ---------- observerStats ---------- */

test("observerStats tallies units/buildings by owner and type, and surfaces archetype/stance/economy", () => {
  const state = {
    planetId: "ferros",
    units: new Map(), buildings: new Map(),
    diplomacy: { stance: -0.6, pacified: false },
    players: { ai: { resources: { ore: 42.7 } }, player: { upgrades: {} } },
  };
  const skiff1 = makeUnit("skiff", "ai", 0, 0);
  const skiff2 = makeUnit("skiff", "ai", 10, 10);
  const worker = makeUnit("worker", "player", 5, 5);
  for (const u of [skiff1, skiff2, worker]) state.units.set(u.id, u);
  const cc = makeBuilding("command", "ai", 0, 0);
  state.buildings.set(cc.id, cc);

  const s = observerStats(state);

  assert.equal(s.planetId, "ferros");
  assert.equal(typeof s.archetypeName, "string");
  assert.ok(s.archetypeName.length > 0, "ferros' archetype has a real name");
  assert.equal(s.stanceLabel, "Hostile");   // stance -0.6 <= -0.5, per engine/diplomacy.js stanceLabel
  assert.ok(s.hostility > 0, "a hostile stance reads as nonzero hostility");
  assert.deepEqual(s.units.ai, { skiff: 2 });
  assert.deepEqual(s.units.player, { worker: 1 });
  assert.deepEqual(s.buildings.ai, { command: 1 });
  assert.equal(s.resources.ore, 42.7);
});

test("observerStats reads null stance/hostility for a state with no diplomacy object", () => {
  const state = {
    planetId: "ferros", units: new Map(), buildings: new Map(),
    players: { ai: { resources: {} } },
  };
  const s = observerStats(state);
  assert.equal(s.stance, null);
  assert.equal(s.stanceLabel, null);
  assert.equal(s.hostility, null);
});

test("observerStats keeps the Odyssey development score, and DROPS it on a diplomacy-less skirmish", () => {
  // aiDevelopment (engine/diplomacy.js) doesn't need state.diplomacy to RUN — it counts owner
  // "ai"'s finished economic buildings plus its researched techs. But it is the Odyssey's own
  // development-curve metric for the one neighbour AI, and a spectated duel has two entrants and
  // no neighbour: reporting it there would be a confident number about half the match. It degrades
  // to null rather than to a wrong-but-plausible integer.
  const g = createGalaxy({ seed: 1 });
  const odyssey = g.planets.get(g.activeId);
  assert.equal(typeof observerStats(odyssey).development, "number",
    "the Odyssey path is untouched — every galaxy world carries diplomacy");

  const skirmish = createSelfPlayState({ planetId: "ferros", seed: 3 });
  assert.equal(skirmish.diplomacy, undefined, "sanity: a skirmish state has no diplomacy at all");
  assert.equal(observerStats(skirmish).development, null);
});

test("observerStats reports BOTH seats for a spectated match, not just owner \"ai\"", () => {
  const state = createSelfPlayState({ planetId: "ferros", seed: 3 });
  const s = observerStats(state);

  assert.ok(Array.isArray(s.seats), "a per-seat breakdown exists");
  assert.deepEqual(s.seats.map(seat => seat.owner), state.owners,
    "one entry per owner, in the state's own canonical owner order");
  for (const seat of s.seats) {
    assert.equal(typeof seat.supplyUsed, "number");
    assert.equal(typeof seat.supplyCap, "number");
    assert.ok(seat.units && seat.buildings, "each seat carries its own army/building tallies");
    assert.ok(Object.keys(seat.resources).length > 0, "…and its own economy, not the other seat's");
  }
  // The pre-existing owner-"ai" fields keep meaning exactly what they did (the Odyssey panel
  // reads them), so generalising the panel never changed the Odyssey's own numbers.
  const ai = s.seats.find(seat => seat.owner === "ai");
  assert.equal(ai.supplyUsed, s.supplyUsed);
  assert.equal(ai.supplyCap, s.supplyCap);
  assert.deepEqual(ai.resources, s.resources);
});
