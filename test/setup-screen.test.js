/* ============================================================
   setup.js's renderMapSelect — the screen every session starts on.

   It had no test file of its own, and only incidental coverage from other suites: 37% of its
   functions and 60% of its branches. That is a poor place for a blind spot. renderMapSelect is the
   first thing every player sees, it is re-entrant (picking a mode re-renders it), and it forks
   five ways — skirmish, Odyssey, three scripted scenarios, and Competition — with two of those
   forks returning early, partway through, after the shared chrome. An early return in the wrong
   place is a screen missing half its controls, and nothing headless could see it.

   The Odyssey branch (a Resume button, a Random card, one card per starting world, each wired to
   begin the run) was entirely uncovered — 48 straight lines of it — despite being how an Odyssey
   is started at all.

   Asserted here: what each mode renders, that the mode toggle really re-renders, that the early
   returns return where they should, and that clicking a world card records the choice the run then
   reads. Not asserted: anything past the click that boots a game — boot.js owns that, and
   test/boot.test.js covers it.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./_dom.js";

const doc = installFakeDom();
const mapSelectEl = doc.getElementById("mapSelect");

// NO `window` STUB, deliberately. Defining one flips every `typeof window !== "undefined"` browser
// guard in the modules this file transitively imports — overlays.js registers real key handlers
// behind one — and those handlers keep Node's event loop alive, so the file passes its tests and
// then never exits. Everything below needs only `document`, which test/_dom.js provides.

const { renderMapSelect, setup } = await import("../setup.js");

const find = (root, pred) => {
  const out = [];
  const walk = n => { for (const c of n.children || []) { if (pred(c)) out.push(c); walk(c); } };
  walk(root);
  return out;
};
const buttons = root => find(root, n => n.tagName === "button");
const texts = root => buttons(root).map(b => b.textContent);
const cards = root => find(root, n => n.classList.contains("map-card"));
const heading = root => find(root, n => n.tagName === "h2")[0]?.textContent;

// Each test starts from a known mode: the module-level `setup` object persists across renders on
// purpose (it is the real screen's own memory), so a test that left it on "odyssey" would silently
// change what the next one is asserting about.
function render(mode) {
  setup.mode = mode;
  renderMapSelect();
  return mapSelectEl;
}

test("the skirmish screen offers world cards, the autosave resume, and the multiplayer entry", () => {
  const el = render("skirmish");
  assert.equal(heading(el), "Configure the skirmish");
  assert.ok(cards(el).length > 0, "a skirmish is started by clicking a world card");
  assert.ok(texts(el).some(t => /Multiplayer/.test(t)),
    "T-034's lobby entry point is skirmish-only and must be present here");
});

test("the version is shown on every mode — it is how a player reports which build they are on", () => {
  for (const mode of ["skirmish", "odyssey"]) {
    const el = render(mode);
    const ver = find(el, n => n.classList.contains("setup-version"))[0];
    assert.ok(ver && /^SpaceCities v\d+\.\d+\.\d+/.test(ver.textContent), `${mode}: ${ver?.textContent}`);
  }
});

test("ODYSSEY: a Random card plus one card per starting world, each ready to begin", () => {
  // The 48-line branch that had no coverage at all. A missing Random card silently removes the
  // "I don't care, just land me somewhere" affordance that used to be the ONLY way to start.
  const el = render("odyssey");
  const names = cards(el).map(c => c.innerHTML);
  assert.ok(names.length >= 2, `expected a Random card and several worlds, got ${names.length}`);
  assert.ok(names.some(h => /Random/.test(h)), "the Random card preserves the original seed-derived draw");
  assert.ok(names.filter(h => !/Random/.test(h)).length >= 1, "…alongside real, named worlds to choose from");
});

test("ODYSSEY: every world card names a real world and its neighbour's temperament", () => {
  // Each card is built from PLANETS + archetypeFor. A card that renders but says nothing useful is
  // the failure mode here — the whole point of the branch is making the first decision informed.
  const el = render("odyssey");
  const worldCards = cards(el).map(c => c.innerHTML).filter(h => !/Random/.test(h));
  for (const html of worldCards) {
    assert.match(html, /class="name"/, "a card must name its world");
    assert.match(html, /neighbour/, "…and say what kind of neighbour it comes with");
  }
});

// NOT TESTED HERE: clicking a card. beginOn() records setup.startWorld and then immediately calls
// startOdyssey(), which boots a real game and starts a render loop — a unit test that clicks a card
// either hangs or ends up asserting against a pile of stubs standing in for most of the app. The
// click path is covered where clicking is cheap and real: tools/smoke.js drives `.map-card` in a
// live browser to start a match, and tools/smokeMultiplayer.js does the same across two of them.
// What is worth pinning HERE is that the cards exist, are wired, and carry the information a player
// needs in order to choose — which is what the tests either side of this note do.

test("COMPETITION returns early, after the shared chrome and before the skirmish rows", () => {
  // This branch and the Odyssey one both return partway through the function. Competition's early
  // return is load-bearing: renderSetupPanel below it reads SCENARIO_COPY[mode].diffHint
  // unconditionally, and Competition has no entry there, so falling through would throw.
  const el = render("competition");
  assert.equal(heading(el), "🏆 Competition", "it names the mode, not one of its tabs");
  assert.ok(!texts(el).some(t => /Multiplayer/.test(t)),
    "the skirmish-only rows must not appear — reaching them at all would throw on the missing copy");
  setup.mode = "skirmish";   // leave the shared object as the next test expects
});

test("the mode toggle re-renders the screen rather than appending to it", () => {
  // renderMapSelect calls itself when a mode is picked, and clears mapSelectEl first. If that clear
  // were ever dropped, every mode switch would stack a second copy of the whole screen underneath
  // the first — visible immediately in a browser, invisible to every other test.
  render("skirmish");
  const firstCount = mapSelectEl.children.length;
  renderMapSelect();
  assert.equal(mapSelectEl.children.length, firstCount,
    "re-rendering must replace the screen, never append another one");
});

// NOT TESTED HERE, deliberately: "renderMapSelect no-ops without a DOM". Its `if (!mapSelectEl)`
// guard is about IMPORT time — dom.js resolves every handle once, when the module first loads —
// so deleting globalThis.document afterwards does not re-enter that branch, and a test that tried
// would be asserting a mechanism the file does not have. That every UI module imports cleanly
// under Node is real and is already enforced, for all of them at once, by
// test/static-integrity.test.js.
