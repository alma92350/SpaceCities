import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// Pure engine modules — no DOM/window reference anywhere in their own code or import graph
// (verified by tracing createGameState/createGalaxy/serializeGame/serializeGalaxy's transitive
// imports), so unlike saveload.js itself these are safe to import statically, before the
// document stub below even exists.
import { createGameState } from "../engine/state.js";
import { mulberry32 } from "../engine/rng.js";
import { createGalaxy } from "../engine/galaxy.js";
import { serializeGame, serializeGalaxy } from "../engine/persist.js";
import { installFakeDom } from "./_dom.js";

// saveload.js's bottom comment says the `typeof window !== "undefined"` guard around its
// autosave-timer/listener wiring exists "so importing this module under Node (to unit-test its
// pure logic) doesn't start a real autosave timer". In practice, though, saveload.js imports
// boot.js, which imports hud.js — and hud.js has two MODULE-SCOPE calls that aren't null-guarded
// the way every other dom.js handle wired at module scope is:
//
//   hud.js:30   repairBtn.addEventListener("click", ...)
//   hud.js:31   departBtn.addEventListener("click", ...)
//   boot.js:54  underAttackEl.addEventListener("click", ...)
//
// Under plain `node --test` (no `document` global) dom.js resolves every handle to `null` by
// design (see dom.js + test/dom.test.js), so those three unguarded calls throw
// `TypeError: Cannot read properties of null (reading 'addEventListener')` at IMPORT time —
// before this file's own module body (or its `window` guard) ever runs. That's a real gap in
// the "importing this module under Node ... doesn't [start a timer]" claim, but fixing hud.js /
// boot.js is out of this fix's scope (only dom.js, saveload.js and renderShared.js get new
// tests here). So: shim the minimum fake `document` needed to survive those three specific
// calls, confirmed by tracing the whole saveload.js -> boot.js import graph (render.js,
// minimap.js, camera.js, input.js, effects.js, overlays.js, setup.js, hud.js, hudSelection.js,
// sound.js, the engine/* modules) for any OTHER un-guarded module-scope DOM access — there is
// none. Crucially, `window` is deliberately left undefined, so saveload.js's own
// `typeof window !== "undefined"` guard stays off and no real autosave timer/listener starts —
// preserving exactly the Node-safety the module's comment promises for the functions under
// test below.
//
// The shim below is more capable than the original "survive three addEventListener calls" bar:
// A real EventTarget (Node's is WHATWG-compliant — addEventListener/dispatchEvent behave exactly
// like the browser, see test/input.test.js's own header note on this) plus the handful of extra
// properties/methods this file's later "drive the real Load path" section needs: bootState/
// bootGalaxy (boot.js) call renderHUD() for real at the end of every boot, which cascades into
// hud.js's topbar rebuild and hudSelection.js's selection-panel rebuild — genuine DOM building,
// even though nothing below asserts on any of it. Kept as one class (not per-purpose stubs) so
// every handle dom.js resolves — loadBtn included — is equally capable.
const doc = installFakeDom();
// loadFromFile() (saveload.js, ~line 131) creates a real <input type=file> as a LOCAL variable —
// there's no other way for a test to reach the exact instance it wires its "change" listener onto.
// Stash whichever one createElement most recently made, so the "drive the real Load path" tests
// below can grab it right after clicking loadBtn. loadFromFile is the only code path any test in
// this file ever reaches that creates an <input> (setup.js's seed-input field is the only other
// call site in the whole codebase, and setup.js is never invoked here), so "most recent" is
// unambiguous.
// `lastAnchor` is the same trick for the SAVE side: downloadJSON() (saveload.js) builds a local
// <a download=…> and clicks it, so an anchor appearing here is the only in-process evidence that a
// file download was actually attempted — what the "a watched match never downloads a save file"
// test below needs to assert on.
let lastFileInput = null;
let lastAnchor = null;
const createElement = doc.createElement.bind(doc);
doc.createElement = tag => {
  const el = createElement(tag);
  if (tag === "input") lastFileInput = el;
  if (tag === "a") lastAnchor = el;
  return el;
};
// boot.js/input.js wire a couple of listeners onto the document itself; the shared harness models
// elements, not the document node, so these two stay local no-ops.
doc.addEventListener = () => {};
doc.removeEventListener = () => {};

const { hasSave, hasOdysseySave, storedSaveVersions, autoSave, loadGame, loadOdyssey, recordAutoSaveOutcome } = await import("../saveload.js");

// session.js is DOM/window-free (a plain data object — see its own header comment), so it's safe
// to import here, well before the window/AudioContext stubs further down: the two-generation
// rotation tests just need to set game.state/game.galaxy directly, not drive a full bootState/
// bootGalaxy boot. The "drive the real Load path" section below reuses this SAME singleton —
// there is only one `game` binding in this file now, imported once, here.
const { game } = await import("../session.js");

// The module's own literal keys (not exported) — pinned again by the "documented literal storage
// keys" test below; redeclared here so the two-generation tests can address the exact same
// localStorage slots saveload.js itself reads/writes.
const SAVE_KEY = "stellarfrontier.save.v1";
const ODYSSEY_KEY = "stellarfrontier.odyssey.v1";

// A minimal in-memory localStorage — same idiom as test/update.test.js's / test/overlays.test.js's
// own fakeLocalStorage (this Node install has no real `localStorage` global by default; the
// "environment sanity" test below pins that down). Assigned fresh INSIDE each test that needs a
// working store — never at this file's own top level — so the "localStorage is unavailable" tests
// right below keep observing exactly that: node:test only starts running test BODIES after this
// whole module has finished its synchronous load, so a module-scope assignment here would flip
// every test in the file — including the ones declared earlier in the file — onto a live store.
function fakeLocalStorage() {
  const store = new Map();
  return {
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
    clear() { store.clear(); },
  };
}

// A quota-simulating variant: setItem throws a QuotaExceededError-shaped error the next `n` calls
// (armed via `_failNext`), then behaves normally — for the "a setItem quota throw drops the .prev
// backup and retries once" test below. Deliberately call-count-based rather than byte-accurate: it
// exercises the exact same retry code path without the test being sensitive to exactly how large a
// real serialized save happens to be.
function quotaLocalStorage() {
  const store = new Map();
  let failNext = 0;
  return {
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) {
      if (failNext > 0) { failNext--; const e = new Error("QuotaExceededError"); e.name = "QuotaExceededError"; throw e; }
      store.set(k, String(v));
    },
    removeItem(k) { store.delete(k); },
    clear() { store.clear(); },
    _failNext(n) { failNext = n; },
  };
}

// --- environment check: is `localStorage` a real global under this Node install? -------------
// Node 22 gained an experimental, opt-in Web Storage implementation (see `node --help` ->
// `--localstorage-file`), but it is NOT on by default and `package.json`'s `test` script
// (`node --test`, no flags) and this repo's CI workflow both run without it on Node 20 AND 22.
// saveload.js's `read()` helper references the bare global `localStorage` (not
// `globalThis.localStorage` / `typeof`), so with no such global declared anywhere, a bare
// reference throws a ReferenceError — which `read()` already try/catches, falling back to null.
// Confirmed empirically (see scopeNotes in the task report) rather than assumed: bare
// `localStorage` throws under `node --test` in this environment, so the three functions below
// are exercised through their documented missing-global fallback path, not a live read/write
// round-trip.
const localStorageIsAvailable = (() => {
  try { void localStorage; return true; }
  catch { return false; }
})();

test("environment sanity: localStorage is not a live global under plain `node --test`", () => {
  // This pins down WHICH branch the tests below are actually exercising, so a future Node
  // upgrade that starts exposing a default `localStorage` doesn't silently leave this suite
  // testing the wrong path without anyone noticing.
  assert.equal(localStorageIsAvailable, false,
    "expected bare `localStorage` to be undeclared under `node --test` on this Node install; " +
    "if this now fails, saveload.js's read()/hasSave()/etc. can be tested against a real " +
    "localStorage round-trip instead of only the missing-global fallback");
});

test("hasSave() gracefully reports false when localStorage is unavailable (no save yet)", () => {
  assert.equal(hasSave(), false);
});

test("hasOdysseySave() gracefully reports false when localStorage is unavailable (no save yet)", () => {
  assert.equal(hasOdysseySave(), false);
});

test("storedSaveVersions() gracefully returns the null-shaped result when localStorage is unavailable", () => {
  assert.deepEqual(storedSaveVersions(), { skirmish: null, odyssey: null });
});

test("none of hasSave / hasOdysseySave / storedSaveVersions throw, called repeatedly", () => {
  // read()'s try/catch is the whole point of this on-ramp — a throwing/missing localStorage
  // must never bubble up into a crash for callers like the update-check / map-select screen.
  assert.doesNotThrow(() => { hasSave(); hasOdysseySave(); storedSaveVersions(); hasSave(); });
});

test("the module reads the documented literal storage keys", () => {
  // hasSave/hasOdysseySave/storedSaveVersions don't export SAVE_KEY/ODYSSEY_KEY, so with no
  // localStorage available to observe a real get/set against them, pin the literal strings
  // in the source itself — a silent rename here would strand every player's existing
  // browser-local autosave (they'd read back "no save" forever) without any other test catching it.
  const src = readFileSync(fileURLToPath(new URL("../saveload.js", import.meta.url)), "utf8");
  assert.match(src, /SAVE_KEY\s*=\s*"stellarfrontier\.save\.v1"/);
  assert.match(src, /ODYSSEY_KEY\s*=\s*"stellarfrontier\.odyssey\.v1"/);
  // The previous-generation suffix (docs/improvement-proposals.md: "move the current value to
  // KEY+'.prev'") — pinned the same way, so a silent rename here can't silently orphan every
  // player's fallback generation either.
  assert.match(src, /PREV_SUFFIX\s*=\s*"\.prev"/);
});

/* ============================================================
   Two-generation autosave with fallback load and surfaced failure (docs/improvement-proposals.md
   "Two-generation autosave with fallback load and surfaced failure"): autoSave() rotates the
   current primary into KEY+'.prev' before writing a fresh generation, loadGame/loadOdyssey fall
   back to '.prev' when the primary fails to deserialize, hasSave/hasOdysseySave/storedSaveVersions
   read both generations, a setItem quota throw drops '.prev' and retries once, and the periodic
   autosave caller counts consecutive failures toward a one-time "autosave is failing" toast.
   ============================================================ */

test("autoSave rotates generations: the previous primary value moves to KEY+'.prev' before the fresh write lands", () => {
  globalThis.localStorage = fakeLocalStorage();
  game.state = createGameState({ seed: 501, planetId: "ferros", rng: mulberry32(501) });
  game.galaxy = null;

  assert.equal(autoSave(), true, "first autosave: nothing to rotate yet, just writes the primary");
  assert.equal(localStorage.getItem(SAVE_KEY + ".prev"), null,
    "no .prev yet — there was nothing stored to rotate on the very first write");
  const firstPrimary = localStorage.getItem(SAVE_KEY);
  assert.ok(firstPrimary, "the primary now holds the first generation");

  game.state = createGameState({ seed: 502, planetId: "ferros", rng: mulberry32(502) });
  assert.equal(autoSave(), true, "second autosave");
  assert.equal(localStorage.getItem(SAVE_KEY + ".prev"), firstPrimary, "the OLD primary rotated into .prev");
  assert.notEqual(localStorage.getItem(SAVE_KEY), firstPrimary, "the primary now holds the fresh (second) generation");

  game.state = null;   // leave the shared session clean for later tests
});

test("hasSave/hasOdysseySave report true when only the .prev generation survives", () => {
  globalThis.localStorage = fakeLocalStorage();
  assert.equal(hasSave(), false);
  assert.equal(hasOdysseySave(), false);

  localStorage.setItem(SAVE_KEY + ".prev", "anything");
  assert.equal(hasSave(), true, "a .prev-only save should still offer Continue — loadGame reads both");
  assert.equal(hasOdysseySave(), false, "the Odyssey key is untouched");

  localStorage.setItem(ODYSSEY_KEY + ".prev", "anything");
  assert.equal(hasOdysseySave(), true);
});

test("storedSaveVersions falls back to .prev's version when the primary is missing or unparseable", () => {
  globalThis.localStorage = fakeLocalStorage();
  localStorage.setItem(SAVE_KEY + ".prev", JSON.stringify({ v: 7 }));
  assert.equal(storedSaveVersions().skirmish, 7, "no primary at all — read .prev's version");

  localStorage.setItem(SAVE_KEY, "{ not valid json");
  assert.equal(storedSaveVersions().skirmish, 7, "an unparseable primary still falls back to .prev's version");

  localStorage.setItem(SAVE_KEY, JSON.stringify({ v: 9 }));
  assert.equal(storedSaveVersions().skirmish, 9, "a valid primary wins over .prev");
});

test("autoSave: a setItem quota throw drops the .prev backup and retries once, so the backup can never starve the primary", () => {
  const ls = quotaLocalStorage();
  globalThis.localStorage = ls;
  ls.setItem(SAVE_KEY, "stale-primary");
  ls.setItem(SAVE_KEY + ".prev", "stale-prev");
  game.state = createGameState({ seed: 503, planetId: "ferros", rng: mulberry32(503) });
  game.galaxy = null;

  ls._failNext(1);   // the very next setItem call (rotating the stale primary into .prev) throws once
  assert.equal(autoSave(), true, "one retry after dropping .prev should still land the primary write");
  assert.equal(ls.getItem(SAVE_KEY + ".prev"), null, "the .prev backup was sacrificed to make room");
  assert.ok(ls.getItem(SAVE_KEY) && ls.getItem(SAVE_KEY) !== "stale-primary", "the fresh primary write landed");

  ls._failNext(2);   // truly out of room: even the retry (after dropping .prev) fails
  assert.equal(autoSave(), false, "no room left even after sacrificing .prev — fails cleanly, doesn't throw");

  game.state = null;
});

test("recordAutoSaveOutcome warns exactly once, on the 3rd CONSECUTIVE failure, and a success resets the streak (but never re-arms the one-time flag)", () => {
  assert.equal(recordAutoSaveOutcome(true), false, "a success never warns");
  assert.equal(recordAutoSaveOutcome(false), false, "1st consecutive failure: too early");
  assert.equal(recordAutoSaveOutcome(true), false, "a success in between resets the streak");
  assert.equal(recordAutoSaveOutcome(false), false, "1st failure again (streak was reset): too early");
  assert.equal(recordAutoSaveOutcome(false), false, "2nd consecutive failure: still too early");
  assert.equal(recordAutoSaveOutcome(false), true, "3rd consecutive failure: warn now");
  assert.equal(recordAutoSaveOutcome(true), false, "a later success doesn't itself warn");
  assert.equal(recordAutoSaveOutcome(false), false, "1st failure of a brand-new streak");
  assert.equal(recordAutoSaveOutcome(false), false, "2nd");
  assert.equal(recordAutoSaveOutcome(false), false, "3rd again — already warned once this session, stays quiet for good");
});

test("autoSave() reports 'nothing to save' as false — so the periodic timer must not feed that to the failure streak", () => {
  // Regression fence for a real false alarm: autoSave() returns false BOTH when a write threw and
  // when there is simply no resumable game, and the periodic timer used to hand that conflated
  // boolean straight to recordAutoSaveOutcome. Three intervals on any menu screen (36s) then raised
  // a red "Autosave is failing" banner with localStorage perfectly healthy — rare before the
  // Competition screens existed, constant once a tournament parks you on a menu for minutes.
  // saveload.js now gates the timer on resumableMode(game) BEFORE recording an outcome.
  //
  // Asserting on the two halves this test can reach directly: autoSave() genuinely returns false
  // with no game (so the conflation is real, not hypothetical), and the timer's source carries the
  // guard ahead of its recordAutoSaveOutcome call. The banner itself is browser-only wiring behind
  // `typeof window !== "undefined"`, which is exactly why it went unnoticed.
  game.state = null;
  game.galaxy = null;
  assert.equal(autoSave(), false, "no resumable game: autoSave reports false — indistinguishable from a failed write");

  const src = readFileSync(new URL("../saveload.js", import.meta.url), "utf8");
  const timer = src.slice(src.indexOf("setInterval("), src.indexOf("AUTOSAVE_INTERVAL_MS);", src.indexOf("setInterval(")));
  assert.match(timer, /resumableMode\(game\)/,
    "the periodic autosave timer must check for a resumable game before recording a failure");
  assert.ok(timer.indexOf("resumableMode(game)") < timer.indexOf("recordAutoSaveOutcome"),
    "the guard has to run BEFORE recordAutoSaveOutcome, or the streak still counts menu ticks");
});

// --- driving the REAL file-Load path: loadBtn -> loadFromFile -> importSave -> bootState/bootGalaxy ---
// importSave() (saveload.js ~line 124) is the shape-autodetect dispatch: isGalaxySave(parsed) ?
// bootGalaxy(deserializeGalaxy(parsed)) : bootState(deserializeGame(parsed)). isGalaxySave() itself
// is already fully covered in isolation by test/save-shape.test.js; what's untested until now is
// the WIRING — that a galaxy-shaped file really reaches bootGalaxy/deserializeGalaxy and a
// skirmish-shaped one really reaches bootState/deserializeGame, not swapped.
//
// Getting there for real (driving a click on loadBtn, not re-implementing the dispatch by hand)
// means actually running bootState/bootGalaxy (boot.js), which reaches further into the
// browser-only UI layer than the guard at the top of this file accounts for:
//   - input.js's attachInput() registers real listeners on the bare `window` global
//   - sound.js's unlockAudio() (importSave's own first line) unconditionally reads
//     `window.AudioContext`, ungated by mute or a typeof check
//   - engine/loop.js's createLoop().start() calls the bare `requestAnimationFrame` global
// None of those exist under plain `node --test`. Stubbed below — confirmed empirically to be
// enough for the whole chain, INCLUDING the renderHUD()/renderSelectionPanel() call bootState
// makes for real at the end of every boot (hud.js / hudSelection.js), to run to completion
// without throwing.

// Set up AFTER saveload.js was already imported above, so the module-scope
// `typeof window !== "undefined"` guard at its own bottom (see this file's header comment) still
// saw `undefined` and stayed off — this file still never starts a real autosave timer/listener.
class FakeWindow extends EventTarget {
  devicePixelRatio = 1;
  matchMedia() { return { matches: false }; }   // read by render.js / renderEffects.js for DPI + reduced-motion
}
globalThis.window = new FakeWindow();

// A minimal Web Audio stand-in — just enough surface (createGain/createOscillator/connect/…) for
// sound.js's ensureContext() to build its master bus without throwing. Nothing below asserts on
// audio at all; this exists purely so unlockAudio() doesn't crash the import.
class FakeAudioContext {
  currentTime = 0;
  destination = {};
  createGain() { return { gain: {}, connect() { return this; } }; }
  createOscillator() { return { frequency: {}, connect() { return this; }, start() {}, stop() {} }; }
  resume() {}
}
globalThis.window.AudioContext = FakeAudioContext;

// FileReader doesn't exist under Node at all. A "picked file" is a plain { size, __content } (or
// { size, __error: true }) object rather than a real File/Blob — loadFromFile only ever reads
// `.size` off it before handing it to `new FileReader()`, so that shape is all readAsText needs.
// onload/onerror fire asynchronously (a queued microtask), same as the real thing, so every test
// below awaits past it via pickFile.
class FakeFileReader extends EventTarget {
  readAsText(file) {
    queueMicrotask(() => {
      if (file.__error) { this.onerror && this.onerror(); return; }
      this.result = file.__content;
      this.onload && this.onload();
    });
  }
}
globalThis.FileReader = FakeFileReader;

// engine/loop.js calls these as bare globals (not `window.`), independently of the window stub
// above. The fake never actually invokes the queued frame callback — this suite is about the
// save/load WIRING, not driving simulated frames — so bootState's loop starts and just sits idle,
// exactly like test/loop.test.js's own stub (see its header comment for the same reasoning).
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

// dom.js resolves its handles (loadBtn included) once, at ITS OWN import time, off the document
// stub set up near the top of this file — importing it again here just returns that already-
// cached module, the IDENTICAL object saveload.js's module-scope
// `loadBtn.addEventListener("click", loadFromFile)` already attached its listener to. `game`
// (session.js) was already imported near the top of this file — bootState/bootGalaxy mutate that
// same live singleton for real, so it's what every test below (including the earlier
// two-generation rotation tests) observes.
const { loadBtn, saveBtn, homeBtn } = await import("../dom.js");

// Real fixtures, not hand-typed JSON: run the actual serializers (engine/persist.js) over a real
// createGameState/createGalaxy, so the payload fed through the fake file below is byte-for-byte
// what a real Save button would have produced — genuinely save-shape-valid, not merely shaped
// like it.
const skirmishState = createGameState({ seed: 4242, planetId: "ferros", rng: mulberry32(4242) });
const skirmishSave = serializeGame(skirmishState);
const galaxy = createGalaxy({ seed: 777 });
const galaxySave = serializeGalaxy(galaxy);

// Drive loadBtn's real click handler, capture the <input type=file> loadFromFile() creates (see
// lastFileInput above), and simulate picking a file of `size` bytes containing `content` — size
// defaults to content's real length, so callers only pass it explicitly to lie about size (the
// MAX_SAVE_BYTES gate test below). One macrotask tick (a resolved setTimeout) is enough to run
// past the FakeFileReader's queued onload/onerror — microtasks always fully drain before the next
// macrotask runs, confirmed empirically against a standalone repro before relying on it here.
async function pickFile(content, size = content.length) {
  loadBtn.dispatchEvent(new Event("click"));
  const input = lastFileInput;
  input.files = [{ size, __content: content }];
  input.dispatchEvent(new Event("change"));
  await new Promise(r => setTimeout(r, 0));
}

test("picking a valid skirmish save file loads it through the real bootState/deserializeGame path — game.state ends up correctly loaded, game.galaxy is untouched", async () => {
  game.state = null;
  game.galaxy = "sentinel";   // a deliberately non-null, non-galaxy marker — proves bootState
  // actively clears game.galaxy below, rather than it coincidentally already being falsy.
  await pickFile(JSON.stringify(skirmishSave));
  assert.equal(game.state && game.state.seed, skirmishSave.seed,
    "game.state should be the deserialized skirmish, identifiable by its seed");
  assert.equal(game.galaxy, null, "a skirmish-shaped save must clear game.galaxy, not leave (or set) a galaxy");
});

test("picking a valid galaxy (Odyssey) save file loads it through the real bootGalaxy/deserializeGalaxy path — game.galaxy ends up correctly loaded", async () => {
  game.state = null;
  game.galaxy = null;
  await pickFile(JSON.stringify(galaxySave));
  assert.equal(game.galaxy && game.galaxy.seed, galaxySave.seed,
    "game.galaxy should be the deserialized galaxy, identifiable by its seed");
  assert.equal(game.state, game.galaxy && game.galaxy.planets.get(game.galaxy.activeId),
    "bootGalaxy also boots the galaxy's active planet onto game.state (boot.js activeState)");
});

test("a file whose size exceeds MAX_SAVE_BYTES is rejected by the size gate BEFORE parsing", async () => {
  const before = { state: game.state, galaxy: game.galaxy };
  loadBtn.textContent = "Load";
  // Deliberately-broken JSON: if the size gate didn't run before JSON.parse, this would instead
  // throw and land in the DIFFERENT "Load failed" branch below — the exact flashed text (see
  // flashButton, saveload.js ~line 151) tells the two apart. 9 MB > MAX_SAVE_BYTES (8 MB,
  // saveload.js ~line 29).
  await pickFile("{ this is not JSON", 9 * 1024 * 1024);
  assert.equal(loadBtn.textContent, "File too large");
  assert.equal(game.state, before.state, "a rejected import must not disturb the current game");
  assert.equal(game.galaxy, before.galaxy, "a rejected import must not disturb the current game");
});

test("a file containing invalid JSON is caught gracefully by the try/catch around JSON.parse — flashes 'Load failed', game.state/galaxy stay untouched", async () => {
  const before = { state: game.state, galaxy: game.galaxy };
  loadBtn.textContent = "Load";
  // If the try/catch in loadFromFile's reader.onload were ever removed, this throw would escape
  // a queued microtask callback as an uncaught exception — crashing the whole test run rather
  // than failing one assertion. Simply reaching the asserts below is itself part of what "caught
  // gracefully" means here.
  await pickFile("{ not: valid json");
  assert.equal(loadBtn.textContent, "Load failed");
  assert.equal(game.state, before.state, "a failed import must not disturb the current game");
  assert.equal(game.galaxy, before.galaxy, "a failed import must not disturb the current game");
});

// --- driving the REAL localStorage Continue path: loadGame/loadOdyssey's primary → .prev fallback ---
// Same "drive the real thing, don't reimplement it" spirit as the file-Load tests above, now against
// the setup "Continue"/"Continue Odyssey" buttons' own path (loadGame/loadOdyssey), reusing the
// window/AudioContext/requestAnimationFrame stubs already established for bootState/bootGalaxy above.

test("loadGame falls back to the .prev generation when the primary fails to deserialize, and boots it", () => {
  globalThis.localStorage = fakeLocalStorage();
  game.state = null; game.galaxy = "sentinel";
  localStorage.setItem(SAVE_KEY, "{ not valid json");
  localStorage.setItem(SAVE_KEY + ".prev", JSON.stringify(skirmishSave));
  loadBtn.textContent = "Load";

  loadGame();

  assert.equal(game.state && game.state.seed, skirmishSave.seed, "the .prev generation was booted");
  assert.equal(game.galaxy, null, "booting a skirmish (even via fallback) still clears game.galaxy");
  assert.equal(loadBtn.textContent, "Load", "a successful fallback load doesn't flash any failure text");
});

test("loadOdyssey falls back to the .prev generation when the primary fails to deserialize, and boots it", () => {
  globalThis.localStorage = fakeLocalStorage();
  game.state = null; game.galaxy = null;
  localStorage.setItem(ODYSSEY_KEY, "{ not valid json");
  localStorage.setItem(ODYSSEY_KEY + ".prev", JSON.stringify(galaxySave));
  loadBtn.textContent = "Load";

  loadOdyssey();

  assert.equal(game.galaxy && game.galaxy.seed, galaxySave.seed, "the .prev generation was booted");
  assert.equal(loadBtn.textContent, "Load", "a successful fallback load doesn't flash any failure text");
});

test("loadGame flashes 'Load failed' and leaves the current game untouched when BOTH generations are corrupt", () => {
  globalThis.localStorage = fakeLocalStorage();
  const before = createGameState({ seed: 909, planetId: "ferros", rng: mulberry32(909) });
  game.state = before; game.galaxy = null;
  localStorage.setItem(SAVE_KEY, "{ not valid json");
  localStorage.setItem(SAVE_KEY + ".prev", "{ also not valid json");
  loadBtn.textContent = "Load";

  loadGame();

  assert.equal(loadBtn.textContent, "Load failed");
  assert.equal(game.state, before, "a failed fallback load must not disturb the current game");
});

test("loadGame flashes 'No save' when neither generation exists at all", () => {
  globalThis.localStorage = fakeLocalStorage();
  loadBtn.textContent = "Load";
  loadGame();
  assert.equal(loadBtn.textContent, "No save");
});

/* ============================================================
   The ⌂ Home confirm during a WATCHED / REPLAYED match (docs/competitions-and-elo.md Phase 5).

   Phase 5 closes the save path for a spectated AI-vs-AI match in two places — hud.js HIDES the
   topbar Save/Load buttons, and saveShape.js's resumableMode refuses to checkpoint one — but the ⌂
   Home button is visible in EVERY mode, so its confirm dialog is the third door to the same place.
   Left on the ordinary skirmish copy it promised something false ("Your progress autosaves — Save &
   Exit checkpoints it now") and offered "Save & Exit" as the default-focused PRIMARY button, where
   clicking it: got false back from autoSave(), fell through to a FILE download of the exhibition
   match (a plain skirmish save that loads back handing the human one entrant's army — the exact
   outcome requestExitObserverMode and resumableMode exist to prevent), flashed "Saved ✓" on the
   button hud.js had just hidden, and did not exit. Same shape as the gauntlet-fixture branch Phase 4
   added right above it, so it's pinned the same way: honest copy, no Save & Exit, a plain Leave.
   ============================================================ */

// Drive the REAL topbar ⌂ handler and return the dialog it built, addressed the way the code builds
// it (overlay.home-confirm > card.home-card > [h2, p, div.home-actions]) rather than by index.
function openHomeConfirm() {
  homeBtn.dispatchEvent(new Event("click"));
  const overlay = doc.body.children.filter(el => el.classList.contains("home-confirm")).pop();
  assert.ok(overlay, "clicking ⌂ Home should build a confirm dialog");
  const card = overlay.querySelector(".home-card");
  const actions = overlay.querySelector(".home-actions");
  const [heading, body] = card.children;
  return { overlay, heading: heading.textContent, body: body.textContent, buttons: actions.children };
}

// A watched match's session shape: an ordinary skirmish state plus the spectate flag boot.js's
// startSpectatedMatch parks on the session (game.competition stays null — a watched match is
// exhibition-only, so liveCompetitionFixture() is null and the Phase 4 branch does NOT cover this).
function spectateSession({ recorded = null } = {}) {
  globalThis.localStorage = fakeLocalStorage();
  lastAnchor = null;
  saveBtn.textContent = "Save";
  game.galaxy = null;
  game.competition = null;
  game.state = createGameState({ seed: 606, planetId: "ferros", rng: mulberry32(606) });
  let left = 0;
  game.spectateMatch = { aName: "Alpha", bName: "Beta", world: "ferros", seed: 606, recorded, onLeave: () => { left++; } };
  return { left: () => left };
}

test("the ⌂ Home confirm during a WATCHED match offers no 'Save & Exit' and never claims the match autosaves", () => {
  spectateSession();
  const { heading, body, buttons } = openHomeConfirm();
  const labels = buttons.map(b => b.textContent);

  assert.ok(!labels.includes("Save & Exit"),
    `a spectated match must not offer to save someone else's match — got ${JSON.stringify(labels)}`);
  assert.deepEqual(labels, ["Leave", "Cancel"], "a plain Leave, exactly like the spectate bar's own way out");
  assert.ok(buttons[0].classList.contains("primary"),
    "Leave is the primary (and default-focused) action — the dialog's first button");
  assert.doesNotMatch(body, /autosave|Save & Exit|Continue later/i,
    `the copy must not promise a checkpoint resumableMode refuses to write — got ${JSON.stringify(body)}`);
  assert.match(heading + " " + body, /watch/i, "the copy should say what leaving actually does: stop watching");
  assert.match(body, /Alpha|Beta/, "…and name the two entrants whose match this is");

  game.spectateMatch = null; game.state = null;
});

test("the ⌂ Home confirm during a REPLAY says so, and still refuses to save it", () => {
  spectateSession({ recorded: { winnerName: "Alpha", margin: 3 } });
  const { heading, body, buttons } = openHomeConfirm();

  assert.deepEqual(buttons.map(b => b.textContent), ["Leave", "Cancel"]);
  assert.match(heading + " " + body, /replay/i,
    "a replay is a re-run of an already-rated match — the copy should say replay, not 'watch'");
  assert.doesNotMatch(body, /autosave|Save & Exit/i);

  game.spectateMatch = null; game.state = null;
});

test("Leave from the ⌂ Home confirm during a watched match exits via the launcher's own onLeave, writing and downloading nothing", () => {
  const watch = spectateSession();
  const { overlay, buttons } = openHomeConfirm();

  buttons[0].dispatchEvent(new Event("click"));   // "Leave"

  assert.equal(watch.left(), 1, "it takes the SAME way out the spectate bar's Leave button does");
  assert.equal(localStorage.getItem(SAVE_KEY), null, "nothing was checkpointed to localStorage");
  assert.equal(localStorage.getItem(SAVE_KEY + ".prev"), null);
  assert.equal(lastAnchor, null, "and no <a download> was built — a watched match is never written to a file");
  assert.equal(saveBtn.textContent, "Save", "no 'Saved ✓' / 'Save failed' flash on a button hud.js has hidden");
  assert.ok(!doc.body.children.includes(overlay), "the dialog closes on its way out");

  game.spectateMatch = null; game.state = null;
});

// T-037: a live network spectator's own session shape — an ordinary skirmish state plus
// game.networkSpectate, the SAME "additive flag on an otherwise-ordinary state" shape
// spectateSession() above already established for game.spectateMatch. localOwner is null (T-030's
// own seam has no seat to point at, lobbyScreen.js's spectateLive), matching the real thing.
function networkSpectateSession() {
  globalThis.localStorage = fakeLocalStorage();
  lastAnchor = null;
  saveBtn.textContent = "Save";
  game.galaxy = null;
  game.competition = null;
  game.spectateMatch = null;
  game.localOwner = null;
  game.state = createGameState({ seed: 909, planetId: "ferros", rng: mulberry32(909) });
  game.networkSpectate = true;
}

test("T-037: the ⌂ Home confirm during a live network spectate offers no 'Save & Exit' and never claims the match autosaves", () => {
  networkSpectateSession();
  const { heading, body, buttons } = openHomeConfirm();
  const labels = buttons.map(b => b.textContent);

  assert.ok(!labels.includes("Save & Exit"),
    `a network spectator must not offer to save someone else's match — got ${JSON.stringify(labels)}`);
  assert.deepEqual(labels, ["Leave", "Cancel"], "a plain Leave, exactly like the watched-match branch above");
  assert.ok(buttons[0].classList.contains("primary"));
  assert.doesNotMatch(body, /autosave|Save & Exit|Continue later/i,
    `the copy must not promise a checkpoint resumableMode refuses to write — got ${JSON.stringify(body)}`);
  assert.match(heading + " " + body, /spectat|watch/i, "the copy should say what leaving actually does");

  game.spectateMatch = null; game.networkSpectate = false; game.localOwner = "player"; game.state = null;
});

test("T-037: Leave from the ⌂ Home confirm during a live network spectate just tears down — writes and downloads nothing", () => {
  networkSpectateSession();
  const { overlay, buttons } = openHomeConfirm();

  buttons[0].dispatchEvent(new Event("click"));   // "Leave"

  assert.equal(localStorage.getItem(SAVE_KEY), null, "nothing was checkpointed to localStorage");
  assert.equal(localStorage.getItem(SAVE_KEY + ".prev"), null);
  assert.equal(lastAnchor, null, "and no <a download> was built — a spectator's view is never written to a file");
  assert.equal(saveBtn.textContent, "Save", "no 'Saved ✓' / 'Save failed' flash on a button hud.js has hidden");
  assert.ok(!doc.body.children.includes(overlay), "the dialog closes on its way out");

  game.spectateMatch = null; game.networkSpectate = false; game.localOwner = "player"; game.state = null;
});

test("an ordinary skirmish still gets Save & Exit and the autosave copy — the spectate branch is additive", () => {
  globalThis.localStorage = fakeLocalStorage();
  game.galaxy = null;
  game.competition = null;
  game.spectateMatch = null;
  game.state = createGameState({ seed: 607, planetId: "ferros", rng: mulberry32(607) });

  const { body, buttons } = openHomeConfirm();
  assert.deepEqual(buttons.map(b => b.textContent), ["Save & Exit", "Exit without Saving", "Cancel"]);
  assert.match(body, /autosaves/, "the ordinary skirmish promise is unchanged — it is true there");

  buttons[2].dispatchEvent(new Event("click"));   // Cancel — leave the shared session alone
  game.state = null;
});
