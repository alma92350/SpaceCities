import { test } from "node:test";
import assert from "node:assert/strict";
import { game } from "../session.js";
// Pure engine/fixture modules — no DOM/window reference anywhere in their own code or import
// graph (engine/galaxy.js, engine/state.js — see test/saveload.test.js's header comment for the
// identical reasoning about createGalaxy), so safe to import statically here, before the document
// stub below even exists. jumpReadyGalaxy is the shared "pad, staged ship, funded" origin fixture
// test/odyssey.test.js's own jumpCapital tests already use — reused below (P2 finding, near the
// bottom of this file) so initiateJump's own tests don't re-roll it slightly differently.
import { jumpReadyGalaxy } from "./_helpers.js";
import { liveWorld, liveWorlds, dormantWorld } from "./_helpers.js";
import { makeBuilding } from "../engine/state.js";
import { installFakeDom, fakeCtx, FakeElement } from "./_dom.js";

/* ============================================================
   boot.js's pause-reason refcounting is the #4 finding from the test-suite review (boot.js
   sits at 35% line / 0% function coverage). A module-scope `pauseReasons` Set backs three
   exported functions — pauseLoop(reason), resumeLoop(reason), togglePause() — and the whole
   POINT of refcounting it (instead of a plain boolean) is that several independent callers
   pause on open and resume on close: starmap.js ("starmap"), overlays.js's Help ("help"),
   saveload.js's Home-confirm modal ("home"), and boot.js's own landing-picker flow
   ("landing-pick"), on top of the manual P-key toggle ("manual"). Closing ONE of those must
   never resume a game the player ALSO paused another way — that's the behavior under test
   here, driven only through the three exported functions (pauseReasons/syncPause are private
   and deliberately not reached directly).

   --- import setup (the pattern is test/saveload.test.js's — see its header comment for the
   full trace of *why* this is needed) ------------------------------------------------------
   boot.js pulls in a large transitive graph (render.js, minimap.js, hud.js, overlays.js,
   setup.js, input.js, engine/scenarios.js, engine/galaxy.js, landingPicker.js, data.js,
   sound.js, ...), and a few modules in that graph make un-guarded MODULE-SCOPE DOM calls —
   e.g. hud.js's `repairBtn.addEventListener(...)`/`departBtn.addEventListener(...)` and
   boot.js's own `underAttackEl.addEventListener(...)` (line ~68). Under plain `node --test`
   (no `document` global) dom.js resolves every handle to `null` by design, so those calls
   throw at IMPORT time unless `document` already exists. saveload.js already imports boot.js
   and test/saveload.test.js proved the fix: install the shared fake `document` (test/_dom.js)
   BEFORE the dynamic `await import(...)`, so dom.js's handles resolve to elements, not null.
   `window` is deliberately left UNDEFINED — saveload.js and overlays.js both guard their own
   real browser wiring behind `typeof window !== "undefined"`, and leaving it undefined keeps
   those guards off, exactly as intended for a Node-side unit test (no real timers/listeners).

   Confirmed by reading boot.js's own module-scope code (everything NOT inside a function
   body): the only two executable statements are `underAttackEl.addEventListener(...)` and
   `if (pauseBtn) pauseBtn.addEventListener("click", togglePause);` — both satisfied by the
   shared harness.

   What this file leans on hardest is a WORKING `classList`. boot.js's private syncPause() calls
   `document.body.classList.toggle("paused", manual)` at RUNTIME (every pauseLoop/resumeLoop/
   togglePause call, not just at import) — since boot.js exports no paused-query, that class
   (plus, secondarily, the topbar pause button's label — also set by syncPause) is the ONLY
   observable signal of pause state from outside the module. An earlier hand-rolled stub in this
   repo hardcoded `contains() { return false; }`, which would make every assertion below pass or
   fail for the wrong reason; the shared FakeElement backs classList with a real Set.
   `context: fakeCtx` because the landing-picker section far below drives a REAL
   openLandingPicker(), which draws into the canvas it creates.
   ============================================================ */

const doc = installFakeDom({ context: fakeCtx });
// boot.js/input.js wire a couple of listeners onto the document node itself; the shared harness
// models elements, not the document, so these two stay local no-ops.
doc.addEventListener = () => {};
doc.removeEventListener = () => {};

const { pauseLoop, resumeLoop, togglePause, startGame, startOdyssey, initiateJump, notifyColony, isUnderAttackEvent, bootState } = await import("../boot.js");
// dom.js is already loaded (boot.js imports it statically) — re-importing it here just returns
// the SAME cached module, i.e. the SAME `pauseBtn` object boot.js's syncPause() mutates. A
// second, independent observable of the same `manual` boolean: the topbar button's label.
// galaxyToastEl is the same reasoning — the P6 colony-alert tests below need it to clean up
// after notifyColony's real showGalaxyToast calls (see resetToasts near those tests).
const { pauseBtn, galaxyToastEl } = await import("../dom.js");

// The only observable signal of pause state from outside boot.js — pauseReasons is private and
// boot.js exports no paused-query, so this (or pauseBtn's label, checked separately below) is it.
const isPausedUI = () => document.body.classList.contains("paused");

// Every reason any test below touches. pauseReasons is module-scope in boot.js and persists
// across tests in this file (node:test runs one file's top-level tests sequentially by
// default), and there is no exported way to reset it directly — only resumeLoop(reason) per
// reason, since clearPause() is private. Calling this at the START of every test (rather than
// only trusting each test's own end-of-test cleanup) means a test that fails partway through
// can never leak a stuck pause into the next one. Set.delete on an absent entry is a documented
// no-op, so resuming a reason that isn't actually active is always harmless.
const ALL_REASONS = ["manual", "landing-pick", "never-added"];
function resetPause() { for (const r of ALL_REASONS) resumeLoop(r); }

test("pauseLoop/resumeLoop refcount independently: closing one overlay must not resume a game paused another way", () => {
  resetPause();
  assert.equal(isPausedUI(), false, "sanity: clean slate before this test's own assertions");

  // Two independent real-world callers pausing for two independent reasons — e.g. the player
  // hit P (manual) and then a jump opened the landing picker (landing-pick), which also pauses.
  pauseLoop("manual");
  pauseLoop("landing-pick");
  assert.equal(isPausedUI(), true, "either reason alone is enough for the game to read as paused");
  assert.ok(pauseBtn.textContent.includes("Resume"), "the topbar button reflects the manual reason being active");

  // The landing picker closes (Confirm or Cancel, boot.js's initiateJump) and resumes ONLY its
  // own reason.
  resumeLoop("landing-pick");
  assert.equal(isPausedUI(), true,
    "closing ONE overlay must not resume a game the player ALSO paused manually with P — this " +
    "refcounted Set is the entire reason pauseReasons isn't a plain boolean");

  // Only once EVERY outstanding reason is resumed does the game actually read as running again.
  resumeLoop("manual");
  assert.equal(isPausedUI(), false, "the last outstanding reason resumed -> unpaused");
  assert.ok(pauseBtn.textContent.includes("Pause") && !pauseBtn.textContent.includes("Resume"),
    "the topbar button flips back once the manual reason clears");

  resetPause();
});

test("togglePause() is a no-op when there is no game in progress (game.state is falsy)", () => {
  resetPause();
  game.state = null;   // the map-select / menu screen — no engine state exists yet
  assert.doesNotThrow(() => togglePause());
  assert.equal(isPausedUI(), false, "nothing to pause on the menu -> togglePause must not add the manual reason");
  resetPause();
});

test("togglePause() is a no-op once the match has already ended (game.state.over)", () => {
  resetPause();
  game.state = { over: true };   // the game-over screen is up; the match is decided
  assert.doesNotThrow(() => togglePause());
  assert.equal(isPausedUI(), false, "an ended match can't be paused");
  resetPause();
  game.state = null;
});

test("togglePause() flips the manual pause on, then off, for a live in-progress game", () => {
  resetPause();
  game.state = {};   // a live game: no `over` flag set, so togglePause's guard falls through
  assert.equal(isPausedUI(), false, "sanity: starts unpaused");

  togglePause();   // e.g. the player presses P
  assert.equal(isPausedUI(), true, "first press pauses");

  togglePause();   // presses P again
  assert.equal(isPausedUI(), false, "second press resumes");

  resetPause();
  game.state = null;
});

test("resumeLoop() on a reason that was never added is harmless", () => {
  resetPause();
  assert.equal(isPausedUI(), false);
  assert.doesNotThrow(() => resumeLoop("never-added"));
  assert.equal(isPausedUI(), false,
    "Set.delete on a missing entry is a documented no-op in JS; resuming a reason that was " +
    "never paused must not somehow pause the game either");

  // Prove it's harmless NEXT TO an active, unrelated reason too — not just against an empty
  // Set. This is exactly the shape of bug this whole file guards against: a resumeLoop that
  // clears everything instead of deleting one entry would fail only this half of the test.
  pauseLoop("manual");
  resumeLoop("never-added");
  assert.equal(isPausedUI(), true, "an unrelated already-active pause reason must survive an unrelated resume");

  resumeLoop("manual");
  assert.equal(isPausedUI(), false);
  resetPause();
});

/* ============================================================
   P1 finding #8 (the second boot.js gap from the same test-suite review): two more
   module-private helpers — difficultyDials(key) and resolveSeed(cfg) — are neither exported nor
   reachable except by driving a real start* function and reading what landed on the resulting
   game.state. startGame(planetId) is the natural driver: it calls both
   (difficultyDials(setup.difficulty), resolveSeed(setup)) and their outputs land straight on the
   created state — aiApm/aiMicro under state.ai.apm/state.ai.micro, the seed under state.seed
   (engine/state.js createGameState, confirmed by reading it: `apm: opts.aiApm ?? null`,
   `micro: opts.aiMicro ?? false`, `seed: opts.seed ?? null`).

   difficultyDials looks `key` up in setup.js's own exported DIFFICULTY_OPTIONS (the SAME array
   that drives the Easy/Medium/Hard picker) and falls back to the "medium" entry when `key`
   matches none of them — the exact fix boot.js's own comment on difficultyDials describes:
   boot.js used to keep a SEPARATE easy/medium/hard map, and a key that existed in one list but
   not the other silently fell back to Medium instead of erroring. That fallback branch (an
   unrecognised key) has never been exercised by any existing test. resolveSeed(cfg) either
   honors an explicit cfg.seed or draws a fresh Math.random() one, coerced >>> 0 to an unsigned
   32-bit int either way — also never directly exercised.

   --- extending the stub: what actually broke, in order, driving startGame("ferros") against
   the document-only stub above (confirmed empirically, not guessed) ---------------------------
     1. overlays.js's showObjectives() — called by bootState whenever `intro: true`, which
        startGame's own call to bootState always passes — does
        `objectivesEl.querySelector(".obj-close").addEventListener("click", hideObjectives)`.
        The shared FakeElement's querySelector really walks the built tree, so it finds the
        close button showObjectives just appended.
     2. input.js's attachInput() (bootState wires every fresh state to one) registers its
        mouseup/keydown/keyup/blur listeners directly on the bare `window` global — unlike
        saveload.js's and overlays.js's own browser wiring, this call is NOT behind a
        `typeof window !== "undefined"` guard, so `window` must actually exist by the time
        startGame runs. Exactly the gap test/saveload.test.js's own "driving the real Load path"
        section already hit (see its header comment) and solved the same way: set up AFTER
        boot.js/setup.js are already imported above, so their own module-scope
        `typeof window !== "undefined"` guards (which already ran, above) still saw `undefined`
        and stayed off — this file still starts no real timers/listeners on import; only this
        section's own explicit startGame() calls below ever touch `window`.
     3. engine/loop.js's createLoop().start() (the last thing bootState does) calls the bare
        `requestAnimationFrame` global directly, and — once `loop` is already set, from an
        earlier call in this same section — loop.stop() equally needs `cancelAnimationFrame`.
   Nothing else broke: unlike saveload.test.js's Load-path section, no AudioContext stub is
   needed here — startGame/bootState never call sound.unlockAudio() or any sound.play*()
   synchronously (those only ever fire from click handlers, or from showGameOver/showScenarioEnd,
   neither reached here since a freshly created state always starts with `over: false`).

   One more real, ticking side effect showObjectives leaves behind: a genuine 30-SECOND
   `setTimeout(hideObjectives, 30000)` (overlays.js). Confirmed empirically: without cleanup,
   `node --test` on this file hangs for ~30s after its last test instead of exiting immediately,
   because a live Node timer keeps the process alive. hideObjectives() (which bootState itself
   already calls, unconditionally, at the very top of every later boot) clears it; each test below
   calls it again at the end so the suite never carries a live timer past its own last test.
   ============================================================ */

globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

// setup.js/overlays.js are already loaded (transitively, via boot.js's own import graph at the
// top of this file) — re-importing them here just returns the SAME cached modules: the identical
// live `setup` object every UI module reads/writes (setup.js's card-click handlers, boot.js's
// start* functions), and the identical hideObjectives the comment above relies on.
const { setup, DIFFICULTY_OPTIONS } = await import("../setup.js");
const { hideObjectives } = await import("../overlays.js");
const { sideMod, PLANET_MODIFIERS } = await import("../engine/map.js");

// Whatever difficulty/seed/startWorld/swapAsym the setup screen actually started at — captured
// once, so every test below restores the EXACT starting values rather than a hardcoded guess.
// setup is a live cross-test singleton exactly like game (see the game.state resets throughout
// this file); no other test in this file touches it, but nothing resets it between files either.
const ORIGINAL_DIFFICULTY = setup.difficulty, ORIGINAL_SEED = setup.seed;
const ORIGINAL_START_WORLD = setup.startWorld, ORIGINAL_SWAP_ASYM = setup.swapAsym;
const ORIGINAL_MATCH_TIME_LIMIT = setup.matchTimeLimit;
const ORIGINAL_POP_CAP = setup.popCap;
function resetSetup() {
  setup.difficulty = ORIGINAL_DIFFICULTY; setup.seed = ORIGINAL_SEED;
  setup.startWorld = ORIGINAL_START_WORLD; setup.swapAsym = ORIGINAL_SWAP_ASYM;
  setup.matchTimeLimit = ORIGINAL_MATCH_TIME_LIMIT;
  setup.popCap = ORIGINAL_POP_CAP;
}

test("difficultyDials(): a recognized difficulty key drives the created state's AI with that exact difficulty's aiApm/aiMicro", () => {
  resetSetup();
  const hard = DIFFICULTY_OPTIONS.find(o => o.mult === "hard");
  setup.difficulty = "hard";

  startGame("ferros");

  assert.equal(game.state.ai.apm, hard.aiApm, "state.ai.apm should be Hard's real aiApm from DIFFICULTY_OPTIONS");
  assert.equal(game.state.ai.micro, hard.aiMicro, "state.ai.micro should be Hard's real aiMicro (true — the AI micros: focus-fire, kiting)");

  hideObjectives();
  game.state = null;
  resetSetup();
});

test("difficultyDials(): an unrecognized key silently falls back to Medium's dials — never throws, never some other plausible-but-wrong default", () => {
  resetSetup();
  const medium = DIFFICULTY_OPTIONS.find(o => o.mult === "medium");
  setup.difficulty = "not-a-real-difficulty";   // e.g. a stale/typo'd save, or a future rename that missed one call site

  // This is the exact regression difficultyDials's own `|| DIFFICULTY_OPTIONS.find(o => o.mult
  // === "medium")` fallback exists to prevent: a difficulty key that matches no entry must not
  // crash the whole game start...
  assert.doesNotThrow(() => startGame("ferros"));
  // ...and must not silently run some OTHER wrong-but-plausible difficulty either — it must be
  // Medium's dials specifically.
  assert.equal(game.state.ai.apm, medium.aiApm, "an unrecognized key should fall back to Medium's aiApm");
  assert.equal(game.state.ai.micro, medium.aiMicro, "an unrecognized key should fall back to Medium's aiMicro");

  hideObjectives();
  game.state = null;
  resetSetup();
});

test("resolveSeed(): an explicit setup.seed is honored exactly on the created state, not overridden by a random draw", () => {
  resetSetup();
  setup.seed = 12345;

  startGame("ferros");

  assert.equal(game.state.seed, 12345, "an explicit seed must land on state.seed completely unchanged");

  hideObjectives();
  game.state = null;
  resetSetup();
});

test("resolveSeed(): a null setup.seed draws a fresh, valid unsigned-32-bit seed every call — never frozen/cached, never out of range", () => {
  resetSetup();
  setup.seed = null;

  startGame("ferros");
  const seed1 = game.state.seed;
  startGame("ferros");
  const seed2 = game.state.seed;

  for (const s of [seed1, seed2]) {
    assert.ok(Number.isInteger(s), `resolved seed ${s} must be an integer`);
    assert.ok(s >= 0 && s <= 0xFFFFFFFF, `resolved seed ${s} must be a valid unsigned 32-bit value`);
  }
  // Not an exact-value assertion (it's genuinely random) — proving it's really drawing a fresh
  // value each time, not some frozen/cached one, is instead that two independent draws disagree.
  assert.notEqual(seed1, seed2, "back-to-back calls with no explicit seed must not repeat the same random seed");

  hideObjectives();
  game.state = null;
  resetSetup();
});

// setup.js's Match length row (docs/improvement-proposals.md "Make the clock endgame visible,
// honest, and configurable") — a skirmish-only pick (Quick 20 / Standard 40 / Marathon 60) plumbed
// straight through startGame -> createGameState onto state.matchTimeLimit.
test("setup.matchTimeLimit is plumbed through startGame onto the created state, overriding the 40-minute default", () => {
  resetSetup();
  setup.matchTimeLimit = 1200;   // "Quick 20"

  startGame("ferros");

  assert.equal(game.state.matchTimeLimit, 1200, "the picked Match length must land on state.matchTimeLimit unchanged");

  hideObjectives();
  game.state = null;
  resetSetup();
});

test("setup.popCap is plumbed through startGame onto the created state", () => {
  resetSetup();
  setup.popCap = 250;

  startGame("ferros");

  assert.equal(game.state.popCap, 250, "the picked Population cap must land on state.popCap unchanged");

  hideObjectives();
  game.state = null;
  resetSetup();
});

test("setup.popCap of Max (null, the default) leaves state.popCap null — byte-identical to before this option existed", () => {
  resetSetup();

  startGame("ferros");

  assert.equal(game.state.popCap, null);

  hideObjectives();
  game.state = null;
  resetSetup();
});

// Odyssey Setup workstream: the player picks (or rerolls) their starting world instead of one
// forced random draw (docs/improvement-proposals.md). setup.startWorld is a plain pass-through
// into createGalaxy's opts.startId (engine/galaxy.js already covers validation/fallback/
// determinism in test/odyssey.test.js) — this is the boot.js WIRING itself: driving the real
// startOdyssey() and reading the result off game.galaxy, the same pattern difficultyDials/
// resolveSeed above use for startGame.
test("startOdyssey(): an explicit setup.startWorld lands the galaxy's active seat on that exact world", () => {
  resetSetup();
  setup.startWorld = "helix";

  startOdyssey();

  assert.equal(game.galaxy.activeId, "helix", "the chosen start world becomes the galaxy's active seat");

  hideObjectives();
  game.state = null;
  game.galaxy = null;
  resetSetup();
});

test("startOdyssey(): a null setup.startWorld (Random) draws the galaxy's own seed-derived world, same as before this feature", () => {
  resetSetup();
  setup.seed = 999;
  setup.startWorld = null;

  startOdyssey();
  const withNoPick = game.galaxy.activeId;
  game.galaxy = null;

  startOdyssey();   // same seed, still no pick -> must draw the identical world again
  assert.equal(game.galaxy.activeId, withNoPick, "Random reproduces the seed's own draw, not a fresh roll");

  hideObjectives();
  game.state = null;
  game.galaxy = null;
  resetSetup();
});

// Population cap is a shared MATCH RULE, not a per-world AI-temperament dial (difficulty/
// aiStrategy) — every world in the galaxy gets the player's own pick, including a background
// neighbour the player has never visited, not just the active seat (engine/galaxy.js addPlanet
// threads galaxy.settings.popCap unconditionally, the same way it already does sizeMult/resourceMult).
test("startOdyssey(): setup.popCap lands on every world's state, active seat and background neighbours alike", () => {
  resetSetup();
  setup.popCap = 300;

  startOdyssey();

  assert.equal(game.state.popCap, 300, "the active seat gets the configured cap");
  const neighbourId = [...game.galaxy.planets.keys()].find(id => id !== game.galaxy.activeId);
  assert.ok(neighbourId, "the galaxy seeds every other world in the background from turn one");
  assert.equal(game.galaxy.planets.get(neighbourId).popCap, 300,
    "a background world the player hasn't even visited yet still carries the same configured cap");

  hideObjectives();
  game.state = null;
  game.galaxy = null;
  resetSetup();
});

// Pick your side of the Oort/Nimbus asymmetric matchups: setup.swapAsym threads through
// createGameState into generateMap's opts.swapAsym (engine/map.js's own tests cover the swap
// logic itself) — this proves boot.js's startGame actually wires the setup flag through end to
// end, onto the real created state's map.
test("startGame(): setup.swapAsym threads through to the created state's swapped map modifiers", () => {
  resetSetup();
  setup.swapAsym = true;

  startGame("oort");

  assert.equal(game.state.swapAsym, true, "the swap flag lands on state.swapAsym");
  assert.equal(sideMod(game.state, "player", "buildTimeMult"), PLANET_MODIFIERS.oort.asym.ai.buildTimeMult,
    "the player now reads oort's AI-side modifier — the swap actually took effect on the created map");

  hideObjectives();
  game.state = null;
  resetSetup();
});

/* ============================================================
   P2 finding: initiateJump's afford + needsPick gating (boot.js, `export function
   initiateJump(destId)`). Exported, so — unlike difficultyDials/resolveSeed above — it's
   directly importable; the interesting part is exercising its three branches for real, against a
   genuine galaxy (jumpReadyGalaxy from test/_helpers.js — the same "pad, staged ship, funded"
   origin fixture test/odyssey.test.js's own jumpCapital tests already use):

     1. Can't afford it (g.credits < jumpCost(g, destId)) -> null. initiateJump's own header
        comment: "a jump that plain can't happen still fails fast, synchronously, with no picker
        ever shown" — jumpCapital re-validates the SAME afford check internally, so this check
        alone isn't provable on the immediate-jump branch (double-gated there either way); it only
        bites for real on the needsPick=true branch, where — without it — a picker would open for
        a jump the player can't actually complete. So the test below deliberately targets a
        destination with NO player Spaceport (needsPick would be true if reached), the same shape
        as test 3 below, just unaffordable.
     2. Affordable, and the destination ALREADY has a player Spaceport (playerSpaceports(dest).length
        > 0) -> `needsPick` is false (engine/galaxy.js's landingZone already knows where "home" is
        there) -> jumps immediately, returning jumpCapital's own summary object — NOT the bare
        `true` the picker branch returns.
     3. Affordable, destination has NO player Spaceport, origin can actually launch (canJump) -> a
        pick genuinely applies -> returns `true`, having deferred the real jump to the landing
        picker's own onPick callback (landingPicker.js openLandingPicker).

   Branch 3 drives the REAL landingPicker.js openLandingPicker — a named ES-module import inside
   boot.js, so it can't be swapped for a spy from outside (and this repo's CI matrix runs Node 20
   too, where node:test's `mock.module` isn't available even if the target were only 22+). Read in
   full (landingPicker.js) for exactly what DOM surface it touches: div/h2/p/canvas/button elements
   via document.createElement, a 2D context to draw into, and one document.body.appendChild for the
   overlay itself — withLandingPickDom below swaps in a document built from the shared harness,
   enough for it to run to completion for real, and the overlay it genuinely appends is the
   observable proof a picker really opened. The swap is installed and restored inside EACH test body (never at module
   scope), so it can never affect another test regardless of where in the file it's written — every
   test body here only runs after this whole module's own top-level evaluation (every statement in
   this file, top to bottom) has already finished.
   ============================================================ */

// Swap in a document capable of running the real openLandingPicker for the duration of `fn`
// (synchronous), returning whatever got appended to document.body — restored in a `finally` so a
// failing assertion can never leak the swap into a later test.
function withLandingPickDom(fn) {
  const appended = [];
  const originalCreateElement = document.createElement;
  const originalAppendChild = document.body.appendChild;
  document.createElement = tag => new FakeElement(tag);
  document.body.appendChild = c => { appended.push(c); return c; };
  try { fn(); } finally { document.createElement = originalCreateElement; document.body.appendChild = originalAppendChild; }
  return appended;
}

test("initiateJump: insufficient credits returns null without opening a picker or launching", () => {
  resetPause();
  game.input = null;   // isolate from whatever attachInput() the startGame-driving tests above left behind
  const g = jumpReadyGalaxy(101);
  const originId = g.activeId;
  const destId = g.worlds.find(w => w !== g.activeId);   // never-visited -> jumpCost(g, destId) > 0, and starts with no player Spaceport
  g.credits = 0;                                          // can't afford ANY nonzero-cost jump
  game.galaxy = g;

  const appended = withLandingPickDom(() => {
    assert.equal(initiateJump(destId), null, "an unaffordable jump must return null");
  });
  assert.equal(appended.length, 0, "no landing-picker overlay should ever have been created for a jump that can't be paid for");
  assert.equal(g.activeId, originId, "no jump can have happened — the active world is unchanged");
  assert.equal(g.credits, 0, "nothing was spent");

  game.galaxy = null;
  resetPause();
});

test("initiateJump: a destination that already has a player Spaceport needs no pick and jumps immediately", () => {
  resetPause();
  game.input = null;
  const g = jumpReadyGalaxy(102);
  const destId = liveWorld(g);
  const dest = g.planets.get(destId);
  // Stand a finished Spaceport right on the destination — the exact shape test/landing.test.js's
  // own "a Spaceport already standing at the destination" fixture uses.
  const destPad = makeBuilding("spaceport", "player", dest.map.bases.player.x + 40, dest.map.bases.player.y);
  dest.buildings.set(destPad.id, destPad);   // playerSpaceports(dest).length > 0 -> needsPick is false
  game.galaxy = g;

  const result = initiateJump(destId);
  assert.notEqual(result, true, "an immediate jump must return jumpCapital's own result object, never the bare `true` the picker branch returns");
  assert.ok(result && typeof result === "object" && result.destId === destId,
    "the returned value is the real jump summary (engine/galaxy.js jumpCapital)");
  assert.equal(g.activeId, destId, "the jump actually ran synchronously — the active world changed");

  game.galaxy = null;
  game.state = null;
  game.input = null;
  resetPause();
});

test("initiateJump: a destination with no player Spaceport, origin launch-ready, opens a landing picker and defers the jump", () => {
  resetPause();
  game.input = null;
  const g = jumpReadyGalaxy(103);
  const originId = g.activeId;
  const destId = g.worlds.find(w => w !== g.activeId);   // never-visited, unsettled -> starts with no player Spaceport
  const creditsBefore = g.credits;
  game.galaxy = g;

  const appended = withLandingPickDom(() => {
    assert.equal(initiateJump(destId), true, "a pick that genuinely applies returns the bare `true` sentinel, not a jump result");
  });
  assert.equal(appended.length, 1, "the real landing picker (landingPicker.js openLandingPicker) should have appended its overlay to document.body");
  assert.equal(appended[0].className, "landing-pick-confirm", "…specifically the landing-pick overlay, identifiable by its own class");
  assert.equal(g.activeId, originId, "the jump itself is DEFERRED to the picker's own onPick — nothing has moved yet");
  assert.equal(g.credits, creditsBefore, "fuel isn't spent until the jump actually launches from onPick, not merely from opening the picker");

  resumeLoop("landing-pick");   // this test never drives the picker's own onPick/onCancel, so clear the pause it opened
  game.galaxy = null;
  resetPause();
});

// The common case of that same path, now that only a seeded handful of worlds simulate from turn
// one (engine/galaxy.js BACKGROUND_WORLDS): a first jump to a world with no state yet. The picker
// still has to open — that world is exactly the "no beacon to home in on" case it exists for —
// and merely opening it must not add the world to the live set, or window-shopping destinations
// would quietly wake the galaxy one modal at a time.
test("initiateJump: a DORMANT destination still opens the landing picker, and opening it doesn't wake the world", () => {
  resetPause();
  game.input = null;
  const g = jumpReadyGalaxy(104);
  const originId = g.activeId;
  const destId = dormantWorld(g);
  assert.ok(destId, "fixture sanity: the seeded background draw leaves some world dormant");
  game.galaxy = g;

  const appended = withLandingPickDom(() => {
    assert.equal(initiateJump(destId), true, "the pick applies here too — a never-simulated world has no pad to home in on");
  });
  assert.equal(appended.length, 1, "the picker really opened for a world with no state of its own");
  assert.equal(g.activeId, originId, "the jump is still deferred to the picker's own onPick");
  assert.ok(!g.planets.has(destId), "…and the destination is still dormant — a preview was drawn, not a world woken");

  resumeLoop("landing-pick");
  game.galaxy = null;
  resetPause();
});

/* ============================================================
   P6 "Starmap live colony ledger and alert badges" (docs/improvement-proposals.md lines
   573-581): notifyColony used to timestamp a private, module-scope lastColonyNote[planetId]
   purely to throttle its own "under attack" toast. That record now lives on the session instead
   — game.colonyAlerts[planetId] = {type, at} — so starmap.js's renderStarmap can badge a world
   with its live trouble (test/starmap.test.js covers that reading side) instead of the player
   having to remember whichever toast scrolled by. This section covers the WRITING side: every
   notification type lands a record, and boot.js's focusActivePlanet clears the one world the
   player actually revisits (and only that one — an empire's other still-burning colonies must
   survive an unrelated jump).

   notifyColony is now exported (previously private, reached only via the loop's own update()
   callback pumping sweepColonies' output every frame) specifically so this can be driven
   directly with a constructed notification, the same "direct state construction, no mocks" idiom
   CONTRIBUTING.md's TDD section asks for — a full engine-tick simulation of a real background
   raid would test sweepColonies' own triggering logic (already covered in test/galaxy.test.js)
   far more than notifyColony's record-writing itself.
   ============================================================ */

// notifyColony unconditionally calls overlays.js's showGalaxyToast for all three alert types,
// which (see this file's own header comment on the 30-second showObjectives timer) arms a REAL
// 5s/8s setTimeout per toast — a live timer that would keep `node --test` from exiting promptly
// after this file's last test. Cleared + emptied at the start of every test below, so a failing
// test can never leak a live timer OR a stale toast (MAX_TOASTS=3 eviction, overlays.js) into a
// later one's assertions.
function resetToasts() {
  for (const c of [...galaxyToastEl.children]) clearTimeout(c._timer);
  galaxyToastEl.children.length = 0;
}

test("notifyColony records an 'attacked' alert onto game.colonyAlerts with a fresh timestamp", () => {
  resetToasts();
  game.colonyAlerts = {};

  const before = performance.now();
  notifyColony({ type: "attacked", planetId: "ferros" });
  const after = performance.now();

  const alert = game.colonyAlerts.ferros;
  assert.ok(alert, "a notification for ferros must land a record under its own planet id");
  assert.equal(alert.type, "attacked");
  assert.ok(alert.at >= before && alert.at <= after, "the timestamp is a fresh performance.now() taken during this call, not stale/frozen");

  game.colonyAlerts = {};
  resetToasts();
});

test("notifyColony records a 'hostile' alert onto game.colonyAlerts", () => {
  resetToasts();
  game.colonyAlerts = {};

  notifyColony({ type: "hostile", planetId: "korrath" });

  assert.equal(game.colonyAlerts.korrath?.type, "hostile");
  assert.equal(typeof game.colonyAlerts.korrath.at, "number");

  game.colonyAlerts = {};
  resetToasts();
});

test("notifyColony records a 'lost' alert onto game.colonyAlerts", () => {
  resetToasts();
  game.colonyAlerts = {};

  notifyColony({ type: "lost", planetId: "vesper" });

  assert.equal(game.colonyAlerts.vesper?.type, "lost");
  assert.equal(typeof game.colonyAlerts.vesper.at, "number");

  game.colonyAlerts = {};
  resetToasts();
});

test("notifyColony overwrites a world's alert with whichever notification landed most recently", () => {
  resetToasts();
  game.colonyAlerts = {};

  notifyColony({ type: "hostile", planetId: "oort" });
  assert.equal(game.colonyAlerts.oort.type, "hostile");

  notifyColony({ type: "lost", planetId: "oort" });
  assert.equal(game.colonyAlerts.oort.type, "lost", "a later notification for the same world replaces the earlier one — the badge tracks the freshest truth");

  game.colonyAlerts = {};
  resetToasts();
});

test("notifyColony's under-attack toast throttle survives the move to game.colonyAlerts unchanged: a 'hostile' write doesn't suppress the very next 'attacked' toast", () => {
  resetToasts();
  game.colonyAlerts = {};

  // A hostile declaration and a raid landing within the same ~9s window on the same world — the
  // hostile write must not be mistaken for a prior ATTACKED alert and swallow this toast.
  notifyColony({ type: "hostile", planetId: "korrath" });
  assert.equal(galaxyToastEl.children.length, 1, "the hostile toast fired");

  notifyColony({ type: "attacked", planetId: "korrath" });
  assert.equal(galaxyToastEl.children.length, 2, "the very next attacked toast must still fire — it has no PRIOR attacked alert to throttle against");
  assert.equal(game.colonyAlerts.korrath.type, "attacked", "and the record now reflects the fresher, attacked notification");

  game.colonyAlerts = {};
  resetToasts();
});

test("bootState resets game.colonyAlerts to a fresh, empty ledger for every new game", () => {
  resetPause();
  resetToasts();
  game.colonyAlerts = { ferros: { type: "lost", at: 0 } };   // a stale alert as if carried over from a previous game

  startGame("ferros");

  assert.deepEqual(game.colonyAlerts, {}, "a fresh game must not carry over a previous game's colony alerts");

  hideObjectives();
  game.state = null;
  resetPause();
});

test("a real jump (focusActivePlanet) clears only the destination world's colony alert — an unrelated world's alert survives", () => {
  resetPause();
  resetToasts();
  game.input = null;
  const g = jumpReadyGalaxy(201);
  const destId = liveWorld(g);
  const dest = g.planets.get(destId);
  // A Spaceport already standing at the destination -> needsPick is false -> jumps immediately,
  // same fixture shape as the "needs no pick" test above — no landing-picker DOM needed here.
  const destPad = makeBuilding("spaceport", "player", dest.map.bases.player.x + 40, dest.map.bases.player.y);
  dest.buildings.set(destPad.id, destPad);
  const otherId = liveWorlds(g).find(w => w !== destId);
  game.colonyAlerts = {
    [destId]: { type: "attacked", at: performance.now() },
    [otherId]: { type: "lost", at: performance.now() },
  };
  game.galaxy = g;

  const result = initiateJump(destId);
  assert.ok(result && typeof result === "object", "sanity: the jump actually launched immediately");

  assert.equal(game.colonyAlerts[destId], undefined, "arriving at the destination clears its own alert — the player has now revisited it");
  assert.equal(game.colonyAlerts[otherId]?.type, "lost", "an unrelated held world's alert must survive a jump that isn't to IT");

  game.galaxy = null;
  game.state = null;
  game.input = null;
  game.colonyAlerts = {};
  resetPause();
});

/* ============================================================
   THE SIM RATE A SPECTATED/REPLAYED MATCH RUNS AT (docs/competitions-and-elo.md Phase 5).

   This is the seam a replay lives or dies on, and it is worth stating why it needs a test of its
   own rather than being obvious. Every recorded ledger row was produced by tools/selfplay.js at
   ITS fixed step (SELFPLAY_DT); ordinary play runs the loop at the game's own step. Those two
   numbers are not the same, and a fixed step is not a cosmetic tuning knob — the same seed
   advanced in different-sized steps is a DIFFERENT GAME (different tick count, different think
   cycles, different float accumulation). So a match booted through startSpectatedMatch has to be
   driven at the self-play step, and an ordinary skirmish has to keep running at exactly the rate
   it always did.

   Driven end-to-end through the REAL loop rather than by inspecting a constant: the rAF callback
   is captured and fed timestamps by hand (test/loop.test.js's own harness idiom), and the
   assertion is on how far the simulation itself actually advanced.
   ============================================================ */

const { startSpectatedMatch } = await import("../boot.js");
const { SELFPLAY_DT } = await import("../tools/selfplay.js");
const { pinnedDuelDials } = await import("../tools/duelCore.js");

// A minimal Web Audio stand-in — startSpectatedMatch calls sound.unlockAudio() (a real user
// gesture starts it in the browser), which reads `window.AudioContext` unguarded. Same idiom, and
// the same reason, as test/saveload.test.js's own FakeAudioContext.
class SilentAudioContext {
  currentTime = 0;
  state = "running";
  destination = {};
  createGain() { return { gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
  createOscillator() { return { type: "sine", frequency: { value: 0, setValueAtTime() {} }, connect() {}, start() {}, stop() {} }; }
  createBuffer() { return { getChannelData: () => new Float32Array(1) }; }
  createBufferSource() { return { buffer: null, connect() {}, start() {}, stop() {} }; }
  createBiquadFilter() { return { type: "lowpass", frequency: { value: 0 }, connect() {} }; }
  resume() {}
}

// Boot `start()`, then feed the loop `frames` animation frames `msPerFrame` apart, and report how
// far the sim advanced. render() is left to do whatever it does — createLoop already catches a
// throwing render by design, so this measures the UPDATE path exactly as the browser drives it.
function driveFrames(start, { frames, msPerFrame }) {
  let cb = null;
  const prevRaf = globalThis.requestAnimationFrame, prevError = console.error;
  globalThis.requestAnimationFrame = fn => { cb = fn; return 1; };
  console.error = () => {};
  try {
    start();
    assert.ok(cb, "sanity: booting started a loop and asked for an animation frame");
    for (let i = 0; i <= frames; i++) cb(i * msPerFrame);   // frame 0 primes `last`, no elapsed time yet
    return { tick: game.state.tick, time: game.state.time };
  } finally {
    globalThis.requestAnimationFrame = prevRaf;
    console.error = prevError;
  }
}

test("a SPECTATED match advances at tools/selfplay.js's own fixed step — the one every recorded row was simulated at", () => {
  resetPause();
  window.AudioContext = SilentAudioContext;
  const dials = pinnedDuelDials("medium");
  const advanced = driveFrames(() => startSpectatedMatch({
    world: "ferros", seed: 4242, swapAsym: false, aName: "Blitz", bName: "Bulwark", difficulty: "medium",
    ai: { ...dials, strategy: "defensive", archetype: "turtle" },
    playerAi: { ...dials, strategy: "aggressive", archetype: "rusher" },
  }), { frames: 4, msPerFrame: SELFPLAY_DT * 1000 });

  assert.equal(advanced.tick, 4, "four self-play-step frames must run exactly four sim ticks");
  assert.ok(Math.abs(advanced.time - 4 * SELFPLAY_DT) < 1e-9,
    `each tick must advance the sim by exactly ${SELFPLAY_DT}s — got ${advanced.time / 4}s per tick`);

  game.spectateMatch = null;
  game.state = null;
  game.input = null;
  delete window.AudioContext;
  hideObjectives();
  resetPause();
});

test("an ORDINARY skirmish keeps its own sim rate — the self-play step is for spectated matches only", () => {
  resetPause();
  resetSetup();
  const advanced = driveFrames(() => startGame("ferros"), { frames: 4, msPerFrame: SELFPLAY_DT * 1000 });

  assert.ok(advanced.tick > 4,
    "an ordinary game must still run its own (faster) fixed step — this is the regression guard that " +
    "the spectate change didn't slow normal play down");
  assert.ok(Math.abs(advanced.time - 4 * SELFPLAY_DT) < 1e-9,
    "…covering the same amount of SIM TIME, just in more, smaller steps");

  game.state = null;
  game.input = null;
  hideObjectives();
  resetPause();
});

// T-034: found by an actual browser join (Node's own transportContract tests never drive the real
// loop against a non-loopback transport) — a LIVE network transport (net/wsClientTransport.js's
// real shape: submitCommand/onEvent/close, no .tick() at all, since the SERVER's own worker owns
// ticking, T-029) used to make the fixed-timestep loop's `update` callback throw
// "transport.tick is not a function" on the very first frame. engine/loop.js's own update() is
// DELIBERATELY unguarded (its header: "a throwing sim update is a correctness problem this catch
// isn't meant to paper over"), so that throw unwound past the loop's own requestAnimationFrame
// call and killed the whole match after one frame — a hard freeze, not a cosmetic bug.
test("T-034: booting with a live network transport (no .tick() of its own) never throws from the loop, and never ticks the sim locally", () => {
  resetPause();
  resetSetup();
  startGame("ferros");   // an ordinary boot first, just to get a real state object to re-wrap below
  // net/transport.js's own generic Transport shape — deliberately NOT loopback-shaped (no .tick/
  // .getState, the two loopback-only extensions net/loopback.js's own header names).
  const fakeRemoteTransport = { submitCommand: () => Promise.resolve({ ok: true }), onEvent() {}, close() {} };
  const advanced = driveFrames(() => bootState(game.state, { intro: false, transport: fakeRemoteTransport }),
    { frames: 4, msPerFrame: 50 });
  assert.equal(advanced.tick, 0, "the SERVER'S OWN worker owns this match's ticking — nothing here may advance it locally");

  game.state = null;
  game.input = null;
  hideObjectives();
  resetPause();
});

// T-019b: isUnderAttackEvent used to be `ev.owner === "ai"` inlined at three call sites — correct
// only because exactly two owners exist today. Pure, so testable directly with plain objects; no
// game/DOM state needed at all.
test("T-019b: isUnderAttackEvent fires for anyone else's event, not just a hardcoded owner \"ai\"", () => {
  assert.equal(isUnderAttackEvent({ owner: "ai" }), true, "unchanged from before: the AI hitting you is still an alert");
  assert.equal(isUnderAttackEvent({ owner: "rebels" }), true,
    "a third owner's hit must alarm you too - the old ===\"ai\" check would have silently missed this");
});

test("T-019b: isUnderAttackEvent never fires for the local seat's own event", () => {
  assert.equal(isUnderAttackEvent({ owner: "player" }), false, "you attacking someone is not you being attacked");
});

// T-030: the SAME reasoning one step further — isUnderAttackEvent reads game.localOwner, not a
// hardcoded "player", so the local seat isn't always the same literal either. Not pure any more
// (it now reads session.js's game object), but still testable directly with plain objects, no
// DOM needed.
test("T-030: isUnderAttackEvent respects game.localOwner, not a hardcoded \"player\"", () => {
  const original = game.localOwner;
  try {
    game.localOwner = "ai";
    assert.equal(isUnderAttackEvent({ owner: "ai" }), false, "seat B's own event is never an alarm for seat B");
    assert.equal(isUnderAttackEvent({ owner: "player" }), true, "seat B is alarmed by the OTHER seat's event now");
  } finally { game.localOwner = original; }
});
