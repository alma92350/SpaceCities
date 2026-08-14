import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./_dom.js";

/* ============================================================
   starmap.js has no existing test file — it's a leaf UI module ("self-wires the galaxy-map
   button + M key", only main.js imports it), so no other test file's DOM stub happens to cover
   it either. Uses the shared DOM harness in test/_dom.js (dom.js resolves
   getElementById ONCE at import time — dom.js:16-17 — so the stub must exist BEFORE the dynamic
   import, and every later getElementById(sameId) must keep returning the SAME object, or the
   exported starmapEl this file imports below would diverge from what renderStarmap actually
   appends to). starmap.js ALSO reaches for the bare `window` global unconditionally at module
   scope (`window.addEventListener("keydown", ...)` — no `typeof window !== "undefined"` guard,
   unlike input.js/overlays.js's own wiring) — same as test/boot.test.js's header comment
   documents for that exact pattern, `window` needs a stub in place before the import too, or
   just importing the module throws.

   Getting the IMPORT ORDER right matters more here than it looks. starmap.js imports boot.js
   (for initiateJump/surrenderOdyssey/pauseLoop/resumeLoop), which pulls in the same huge graph
   test/boot.test.js's own header comment traces (setup.js, saveload.js, hud.js, input.js, …).
   saveload.js's autosave wiring is properly guarded (`if (typeof window !== "undefined") {
   setInterval(autoSave, AUTOSAVE_INTERVAL_MS); … }`) — but that guard runs exactly ONCE, the
   first time saveload.js's module body executes, and ES module bodies never re-run on a later
   cached import. So if `window` already exists at that FIRST import, the interval really does
   get scheduled — a live, un-cleared setInterval that keeps `node --test` from ever exiting
   (proven empirically: stubbing `window` up front before importing this graph hangs past a 10s
   timeout with no other symptom). test/boot.test.js hits the identical constraint for the
   opposite reason (input.js needs a real `window`) and solves it the same way: import boot.js's
   whole graph FIRST, while `window` is still undefined (so saveload.js's guard skips the
   interval), THEN stub `window`, THEN import starmap.js itself — by which point boot.js's graph
   is already cached and won't re-execute.
   ============================================================ */

installFakeDom();

// Pre-warm starmap.js's boot.js graph (which includes saveload.js) while `window` is still
// undefined, so saveload.js's guarded autosave `setInterval` never gets scheduled — see the
// header comment. The result is unused; only the caching side effect matters.
await import("../boot.js");

globalThis.window = { addEventListener() {}, removeEventListener() {} };

const { game } = await import("../session.js");
const { createGalaxy, galaxyStatus, addPlanet, createLane, activeState } = await import("../engine/galaxy.js");
const { PLANETS, COM } = await import("../data.js");
const { PLANET_MODIFIERS } = await import("../engine/map.js");
const { renderStarmap } = await import("../starmap.js");
const { starmapEl } = await import("../dom.js");
const { makeBuilding, makeUnit } = await import("../engine/state.js");
const { getColonyPolicy } = await import("../engine/colonyPolicy.js");
const { liveWorld } = await import("./_helpers.js");
const { observedState } = await import("../observer.js");

// The world-node button for `id`, in the exact order renderStarmap built the field (mirrors
// galaxyStatus's own world order, so this never depends on matching by rendered text).
function worldNode(g, id) {
  const field = starmapEl.children.find(c => c._classes.has("starmap-field"));
  const idx = galaxyStatus(g).worlds.findIndex(w => w.id === id);
  return field.children[idx];
}

test("renderStarmap lists each world's deposit icons and yield on a .sm-deps line", () => {
  const g = createGalaxy({ seed: 1 });
  game.galaxy = g;
  renderStarmap();

  const node = worldNode(g, "ferros");
  assert.ok(node, "the ferros node was rendered");
  const deps = node.querySelector(".sm-deps");
  assert.ok(deps, "every node carries a deposit dossier line");
  // ferros deposits ore 2.0 / crystals 0.7 / radioactives 1.0 (data.js) — every icon and yield
  // number must appear, in Object.entries order, with no modifier appended (ferros carries none).
  assert.equal(deps.textContent, `${COM.ore.ico} 2.0 · ${COM.crystals.ico} 0.7 · ${COM.radioactives.ico} 1.0`);

  game.galaxy = null;
});

test("a world with a PLANET_MODIFIERS entry appends its rule label to the dossier line", () => {
  const g = createGalaxy({ seed: 1 });
  game.galaxy = g;
  renderStarmap();

  const node = worldNode(g, "glacius");
  const deps = node.querySelector(".sm-deps");
  assert.ok(deps.textContent.endsWith(PLANET_MODIFIERS.glacius.label), "the world's rule-modifier label is appended");
  assert.ok(deps.textContent.includes(COM.ice.ico), "its deposit icons are still there too");

  game.galaxy = null;
});

test("a world with no PLANET_MODIFIERS entry shows only its deposits — no stray separator or 'undefined'", () => {
  const g = createGalaxy({ seed: 1 });
  game.galaxy = g;
  renderStarmap();

  // ferros/korrath/vesper deliberately carry no modifiers (engine/map.js's own header comment).
  for (const id of ["ferros", "korrath", "vesper"]) {
    const deps = worldNode(g, id).querySelector(".sm-deps");
    assert.ok(!/undefined/.test(deps.textContent), `${id}: no modifier -> no stray 'undefined' from a missing label`);
    assert.ok(!deps.textContent.endsWith("·"), `${id}: no dangling separator when there is no modifier to append`);
  }

  game.galaxy = null;
});

test("the dossier line shows even for a still-unexplored world — charted geography, not fog-gated intel", () => {
  const g = createGalaxy({ seed: 3 });
  game.galaxy = g;
  renderStarmap();

  const unexplored = g.worlds.find(w => w !== g.activeId);
  const node = worldNode(g, unexplored);
  assert.ok(node.className.includes("unexplored"), "sanity: this world really is unexplored");
  const deps = node.querySelector(".sm-deps");
  assert.ok(deps && deps.textContent.length > 0, "the deposit dossier is shown even before you've ever visited");

  game.galaxy = null;
});

test("renderStarmap is a no-op with no galaxy — never throws", () => {
  game.galaxy = null;
  assert.doesNotThrow(() => renderStarmap());
});

// A `.starmap-side` section, found by its market-head text (the section's first child) — the
// same reusable idiom renderColonyOrders/renderLaneOverlay both use.
function sideSection(label) {
  return starmapEl.children.find(c => c._classes?.has("starmap-side") && c.children[0]?.textContent === label);
}

test("a held colony gets a standing-orders row on the starmap, toggleable without jumping back", () => {
  const g = createGalaxy({ seed: 7 });
  const destId = g.worlds.find(w => w !== g.activeId);
  const colony = addPlanet(g, destId, { unsettled: true });
  colony.background = true;
  const cc = makeBuilding("command", "player", colony.map.bases.player.x, colony.map.bases.player.y);
  colony.buildings.set(cc.id, cc);
  g.discovered.add(destId);
  game.galaxy = g;

  renderStarmap();

  const section = sideSection("Colony standing orders");
  assert.ok(section, "a standing-orders section is rendered for the held colony");
  const row = section.children.find(c => c._classes?.has("market-row"));
  assert.ok(row, "one row for the colony");
  const toggle = row.children.find(c => c.tagName === "button" && c.textContent.startsWith("Auto-sell"));
  assert.ok(toggle, "an auto-sell toggle is present");
  assert.equal(toggle.textContent, "Auto-sell: OFF", "off by default");

  toggle.click();
  assert.equal(getColonyPolicy(g, destId).autoSell.enabled, true, "clicking the starmap toggle actually flips the policy");

  game.galaxy = null;
});

test("an active Freight Lane gets a summary line on the starmap", () => {
  const g = createGalaxy({ seed: 8 });
  const destId = g.worlds.find(w => w !== g.activeId);
  addPlanet(g, destId, { unsettled: true });
  createLane(g, g.activeId, destId, ["metals"]);
  game.galaxy = g;

  renderStarmap();

  const section = sideSection("Freight Lanes");
  assert.ok(section, "a Freight Lanes section is rendered");
  const row = section.children.find(c => c._classes?.has("market-row"));
  assert.ok(row, "one row for the lane");
  assert.ok(row.children[0].textContent.includes("▸"), "shows the source ▸ destination route");

  game.galaxy = null;
});

test("no colonies and no lanes ⇒ neither starmap-side section renders", () => {
  const g = createGalaxy({ seed: 9 });
  game.galaxy = g;
  renderStarmap();
  assert.equal(starmapEl.children.filter(c => c._classes?.has("starmap-side")).length, 0);
  game.galaxy = null;
});

/* ============================================================
   P6 "Starmap live colony ledger and alert badges" (docs/improvement-proposals.md lines
   573-581): renderStarmap reads game.colonyAlerts[planetId] = {type, at} (written by boot.js's
   notifyColony — test/boot.test.js covers that WRITING side, plus focusActivePlanet's clear-on-
   revisit) to badge a world's node — CSS class + sub-label — and, for a world actually held right
   now, a garrison line (CC count + combat-unit supply, read off g.planets.get(id) directly). These
   tests set game.colonyAlerts directly: renderStarmap only cares what's THERE, not how it arrived.
   ============================================================ */

// A background colony on a fresh world: one finished player Command Center, discovered (so
// galaxyStatus reads it "colony", not "unexplored") — the shared shape every alert-badge test
// below needs, mirroring "a held colony gets a standing-orders row" above.
function heldColony(g) {
  const destId = g.worlds.find(w => w !== g.activeId);
  const colony = addPlanet(g, destId, { unsettled: true });
  colony.background = true;
  const cc = makeBuilding("command", "player", colony.map.bases.player.x, colony.map.bases.player.y);
  colony.buildings.set(cc.id, cc);
  g.discovered.add(destId);
  return { destId, colony };
}

test("a fresh 'attacked' alert badges the world under-attack — CSS class and sub-label", () => {
  const g = createGalaxy({ seed: 21 });
  const { destId } = heldColony(g);
  game.galaxy = g;
  game.colonyAlerts = { [destId]: { type: "attacked", at: performance.now() } };

  renderStarmap();

  const node = worldNode(g, destId);
  assert.ok(node.className.includes("alert-attack"), `expected an alert-attack class, got "${node.className}"`);
  const sub = node.querySelector(".sm-sub");
  assert.ok(sub.textContent.startsWith("⚔ under attack"), `sub-label should lead with the badge, got "${sub.textContent}"`);

  game.galaxy = null;
  game.colonyAlerts = {};
});

test("a fresh 'hostile' alert ALSO badges the world under-attack, within the same window", () => {
  const g = createGalaxy({ seed: 22 });
  const { destId } = heldColony(g);
  game.galaxy = g;
  game.colonyAlerts = { [destId]: { type: "hostile", at: performance.now() } };

  renderStarmap();

  const node = worldNode(g, destId);
  assert.ok(node.className.includes("alert-attack"), "a hostile declaration reads as the same live-trouble badge as an attack");

  game.galaxy = null;
  game.colonyAlerts = {};
});

test("the under-attack badge fades once the alert is older than ~30s", () => {
  const g = createGalaxy({ seed: 23 });
  const { destId } = heldColony(g);
  game.galaxy = g;
  game.colonyAlerts = { [destId]: { type: "attacked", at: performance.now() - 31000 } };   // 31s old

  renderStarmap();

  const node = worldNode(g, destId);
  assert.ok(!node.className.includes("alert-attack"), "a 31s-old attack alert must no longer badge the world");
  const sub = node.querySelector(".sm-sub");
  assert.ok(!sub.textContent.includes("under attack"), "the sub-label falls back to the plain colony line");
  assert.ok(sub.textContent.startsWith("your colony"), `expected the plain colony sub-label, got "${sub.textContent}"`);

  game.galaxy = null;
  game.colonyAlerts = {};
});

test("a just-under-30s-old attack alert still badges the world (the window is inclusive, not a hair-trigger)", () => {
  const g = createGalaxy({ seed: 24 });
  const { destId } = heldColony(g);
  game.galaxy = g;
  game.colonyAlerts = { [destId]: { type: "attacked", at: performance.now() - 29000 } };   // 29s old

  renderStarmap();

  const node = worldNode(g, destId);
  assert.ok(node.className.includes("alert-attack"), "a 29s-old alert is still within the ~30s window");

  game.galaxy = null;
  game.colonyAlerts = {};
});

test("a 'lost' alert badges the world as fallen, with the exact click-to-retake sub-label", () => {
  const g = createGalaxy({ seed: 25 });
  const destId = g.worlds.find(w => w !== g.activeId);
  addPlanet(g, destId, { unsettled: true });   // it fell — no player building left standing
  g.discovered.add(destId);
  game.galaxy = g;
  game.colonyAlerts = { [destId]: { type: "lost", at: performance.now() } };

  renderStarmap();

  const node = worldNode(g, destId);
  assert.ok(node.className.includes("alert-fallen"), `expected an alert-fallen class, got "${node.className}"`);
  const sub = node.querySelector(".sm-sub");
  assert.equal(sub.textContent, "☠ fallen — click to retake");

  game.galaxy = null;
  game.colonyAlerts = {};
});

test("a 'lost' alert's fallen badge never expires on its own — it persists until explicitly cleared", () => {
  const g = createGalaxy({ seed: 26 });
  const destId = g.worlds.find(w => w !== g.activeId);
  addPlanet(g, destId, { unsettled: true });
  g.discovered.add(destId);
  game.galaxy = g;
  game.colonyAlerts = { [destId]: { type: "lost", at: performance.now() - 10 * 60 * 1000 } };   // 10 minutes old

  renderStarmap();

  const node = worldNode(g, destId);
  assert.ok(node.className.includes("alert-fallen"), "unlike the attack badge, a fallen badge has no time window");

  game.galaxy = null;
  game.colonyAlerts = {};
});

test("no recorded alert ⇒ no badge class, plain sub-label", () => {
  const g = createGalaxy({ seed: 27 });
  const { destId } = heldColony(g);
  game.galaxy = g;
  game.colonyAlerts = {};   // nothing was ever recorded for this world

  renderStarmap();

  const node = worldNode(g, destId);
  assert.ok(!/\balert-(attack|fallen)\b/.test(node.className), `expected no alert badge class, got "${node.className}"`);
  const sub = node.querySelector(".sm-sub");
  assert.ok(sub.textContent.startsWith("your colony"), `expected the plain colony sub-label, got "${sub.textContent}"`);

  game.galaxy = null;
});

test("garrison line: player CC count and combat-unit supply on a held world, read from g.planets.get(id)", () => {
  const g = createGalaxy({ seed: 28 });
  const { destId, colony } = heldColony(g);   // already carries one finished player CC
  const cc2 = makeBuilding("command", "player", colony.map.bases.player.x + 60, colony.map.bases.player.y);
  const ccBuilding = makeBuilding("command", "player", colony.map.bases.player.x + 120, colony.map.bases.player.y, { constructing: true });
  const aiCc = makeBuilding("command", "ai", colony.map.bases.ai.x, colony.map.bases.ai.y);
  colony.buildings.set(cc2.id, cc2);
  colony.buildings.set(ccBuilding.id, ccBuilding);   // still under construction — must not count
  colony.buildings.set(aiCc.id, aiCc);               // the neighbour's CC — must not count
  const skiff = makeUnit("skiff", "player", cc2.x, cc2.y);       // role combat, supplyCost 1
  const bastion = makeUnit("bastion", "player", cc2.x, cc2.y);   // role combat, supplyCost 2
  const worker = makeUnit("worker", "player", cc2.x, cc2.y);     // role worker — must not count toward supply
  const aiSkiff = makeUnit("skiff", "ai", cc2.x, cc2.y);         // wrong owner — must not count
  colony.units.set(skiff.id, skiff);
  colony.units.set(bastion.id, bastion);
  colony.units.set(worker.id, worker);
  colony.units.set(aiSkiff.id, aiSkiff);
  game.galaxy = g;
  game.colonyAlerts = {};

  renderStarmap();

  const node = worldNode(g, destId);
  const garrison = node.querySelector(".sm-garrison");
  assert.ok(garrison, "a held world shows a garrison line");
  assert.equal(garrison.textContent, "🛡 2 CC · 3 supply",
    "2 finished player CCs (the constructing one and the AI's excluded) · 1+2 supply from the skiff+bastion (the worker and the AI's skiff excluded)");

  game.galaxy = null;
});

test("the active seat also shows its own garrison line", () => {
  const g = createGalaxy({ seed: 29 });
  // An Odyssey world starts with an UNDEPLOYED colony ship, not a built base (engine/state.js
  // seedPlayer: state.endless skips straight past the skirmish's finished-CC seeding) — so the
  // active seat needs its own Command Center built by hand here, same as heldColony() does for a
  // background world above.
  const active = activeState(g);
  const cc = makeBuilding("command", "player", active.map.bases.player.x, active.map.bases.player.y);
  active.buildings.set(cc.id, cc);
  const skiff = makeUnit("skiff", "player", active.map.bases.player.x, active.map.bases.player.y);
  active.units.set(skiff.id, skiff);
  game.galaxy = g;
  game.colonyAlerts = {};

  renderStarmap();

  const node = worldNode(g, g.activeId);
  assert.ok(node.className.includes("seat"), "sanity: this is the active seat");
  const garrison = node.querySelector(".sm-garrison");
  assert.ok(garrison, "the active seat shows a garrison line too");
  assert.equal(garrison.textContent, "🛡 1 CC · 1 supply");

  game.galaxy = null;
});

test("no garrison line for a contested world you no longer hold", () => {
  const g = createGalaxy({ seed: 30 });
  const destId = g.worlds.find(w => w !== g.activeId);
  addPlanet(g, destId, { unsettled: true });   // no player buildings ⇒ status "contested", not "colony"
  g.discovered.add(destId);
  game.galaxy = g;
  game.colonyAlerts = {};

  renderStarmap();

  const node = worldNode(g, destId);
  assert.ok(node.className.includes("contested"), "sanity: this world reads contested");
  assert.equal(node.querySelector(".sm-garrison"), null, "no garrison line for a world you don't currently hold");

  game.galaxy = null;
});

test("no garrison line for a still-unexplored world", () => {
  const g = createGalaxy({ seed: 31 });
  game.galaxy = g;
  game.colonyAlerts = {};

  renderStarmap();

  const unexplored = g.worlds.find(w => w !== g.activeId);
  const node = worldNode(g, unexplored);
  assert.ok(node.className.includes("unexplored"), "sanity: this world really is unexplored");
  assert.equal(node.querySelector(".sm-garrison"), null, "no garrison line for a world with no foothold");

  game.galaxy = null;
});

// Observer Mode (observer.js): while spectating, a starmap click is a free camera jump — no
// Spaceport, no fuel, no real activeId change — to ANY world, discovered or not.
test("Observer Mode: clicking an unexplored world (no Spaceport, no fuel) spectates it for free and closes the map", () => {
  const g = createGalaxy({ seed: 32 });
  const realActiveId = g.activeId;
  game.galaxy = g;
  game.colonyAlerts = {};
  game.observerMode = true;
  game.spectateId = realActiveId;
  game.observerCamera = { x: 0, y: 0, zoom: 1 };

  renderStarmap();
  starmapEl.classList.remove("hidden");
  const unexplored = liveWorld(g);
  worldNode(g, unexplored).click();

  assert.equal(game.spectateId, unexplored, "the click jumped the spectated world with no Spaceport/fuel gate");
  assert.equal(g.activeId, realActiveId, "the real seat never moved — only the spectated view did");
  assert.ok(starmapEl.classList.contains("hidden"), "the starmap closes after an observer jump, same as a real one");

  game.galaxy = null;
  game.observerMode = false;
  game.spectateId = null;
  game.observerCamera = null;
});

// "ANY world" has to include a DORMANT one — only a seeded handful simulate from turn one
// (engine/galaxy.js BACKGROUND_WORLDS), and the starmap offers every world as a node either way.
// With no live state to look at, observer.js shows the pristine world the player WOULD land on
// (previewPlanet) rather than waking it, so spectating still can't touch the sim.
test("Observer Mode: clicking a DORMANT world spectates a read-only preview of it, without bringing it to life", () => {
  const g = createGalaxy({ seed: 32 });
  const realActiveId = g.activeId;
  game.galaxy = g;
  game.colonyAlerts = {};
  game.observerMode = true;
  game.spectateId = realActiveId;
  game.observerCamera = { x: 0, y: 0, zoom: 1 };

  renderStarmap();
  starmapEl.classList.remove("hidden");
  const dormant = g.worlds.find(w => !g.planets.has(w));
  assert.ok(dormant, "fixture sanity: the seeded draw leaves some world dormant");
  worldNode(g, dormant).click();

  assert.equal(game.spectateId, dormant, "the click really jumped the spectated world");
  assert.equal(observedState().planetId, dormant, "…and what gets drawn IS that world, not a fallback to the seat");
  assert.ok(!g.planets.has(dormant), "the galaxy never woke it — spectating stays read-only");
  assert.equal(g.activeId, realActiveId, "the real seat never moved");

  game.galaxy = null;
  game.observerMode = false;
  game.spectateId = null;
  game.spectatePreview = null;
  game.observerCamera = null;
});

// Not the no-Spaceport/no-fuel gate (that path's showGalaxyToast schedules a real 5s cleanup
// timer the test runner would have to wait out) — clicking your OWN world exercises the same
// "observerMode off -> fall through unchanged" ordering via a different, toast-free early exit.
test("Observer Mode off: clicking a world leaves spectateId untouched — normal play's own gating still runs", () => {
  const g = createGalaxy({ seed: 32 });
  game.galaxy = g;
  game.colonyAlerts = {};
  assert.equal(game.observerMode, false, "sanity: not observing");

  renderStarmap();
  worldNode(g, g.activeId).click();   // the real "already here" no-op branch

  assert.equal(game.spectateId, null, "no observer jump happened — the click fell through to normal play's own logic");

  game.galaxy = null;
});
