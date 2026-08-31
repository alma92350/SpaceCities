import { test } from "node:test";
import assert from "node:assert/strict";
import * as sound from "../sound.js";
import { installFakeDom, fakeCtx } from "./_dom.js";

/* ============================================================
   hudSelection.js builds the whole selection panel with direct DOM calls
   (document.createElement / panelEl.appendChild / classList / …) and exports
   exactly two functions — renderSelectionPanel() and resetSelectionSignature()
   — everything else (makeButton, the signature guard, every sub-panel
   renderer) is module-private. So the only way to exercise any of it is to
   give it a `document` that behaves enough like the real one, drive it
   through renderSelectionPanel(), and inspect the fake tree it built.

   dom.js resolves every element handle ONCE, at import time, via
   doc.getElementById(id) (doc = typeof document !== "undefined" ? document :
   null — dom.js:16-17). So globalThis.document has to exist BEFORE
   hudSelection.js (or anything that transitively imports dom.js) is first
   imported — under `node --test`'s native ESM loader that means a dynamic
   import() after the stub is installed, not a static one. See
   test/saveload.test.js:1-46 for the identical constraint on saveload.js's
   import graph, which that comment confirms already includes hudSelection.js
   and traces the graph for unguarded module-scope DOM access.

   That file's stubEl() clears the "don't throw at import time" bar (every
   module-scope .addEventListener call it needs to survive — hud.js:31-32,
   boot.js:68 — succeeds against a no-op), but it hands back the SAME inert
   object for every id and hardcodes classList.contains to false. Useless
   here: TARGET 1 needs to read back one SPECIFIC button's real classList,
   and TARGET 2 needs to compare SPECIFIC node references across two renders.
   The shared harness in test/_dom.js tracks real per-instance class state and
   a real children array instead, and — being a real EventTarget — supports the
   same .addEventListener calls stubEl's no-ops were standing in for. It is
   installed with `context: fakeCtx` because makeButton's sprite icons drive
   render.js's spriteIcon, which draws into a real 2D context and reads
   canvas.toDataURL() back; with a null context its own catch fires a
   console.error on EVERY icon button, of every render, in every test here.
   ============================================================ */

installFakeDom({ context: fakeCtx });

// sound.js's tone() unconditionally reaches for window.AudioContext when unmuted; nothing here
// stubs one, so mute up front — same reasoning as test/input.test.js. A DISABLED button's click
// handler (makeButton, hudSelection.js:1586-1589) calls sound.playProductionBlocked() as its
// whole "denied" feedback, and that call has to survive without a real AudioContext for TARGET
// 1's disabled-click tests below to run at all.
sound.setMuted(true);

const { game } = await import("../session.js");
const { createGameState, makeBuilding, makeUnit } = await import("../engine/state.js");
const { BUILDINGS } = await import("../engine/entities.js");
const { commodityAvailable } = await import("../engine/market.js");
const { mulberry32 } = await import("../engine/rng.js");
const { panelEl } = await import("../dom.js");
const { renderSelectionPanel, resetSelectionSignature } = await import("../hudSelection.js");
const { jumpReadyGalaxy, liveWorld } = await import("./_helpers.js");
const { activeState, createLane } = await import("../engine/galaxy.js");
const { setColonyPolicy } = await import("../engine/colonyPolicy.js");
const { queueProduction, researchUpgrade } = await import("../engine/production.js");
const { UNITS, UPGRADES } = await import("../engine/entities.js");
const { createMarket, TRADE_LOT, quoteSell, updateMarket } = await import("../engine/market.js");
const { researchTech, TECHS } = await import("../engine/techtree.js");
const { createDiplomacy, GOODWILL_CAP } = await import("../engine/diplomacy.js");
const { createDirectTransport } = await import("../net/directTransport.js");

// Mirrors hudSelection.js's own module-private costText() (hudSelection.js:1509) — kept local so
// a button's label is matched against UNITS' REAL cost, not a hand-typed "50 ore" that could
// quietly drift from entities.js the next time the Worker gets rebalanced.
function costText(cost) {
  return Object.entries(cost).map(([com, qty]) => `${qty} ${com}`).join(", ");
}

// makeButton (hudSelection.js:1550) puts the label straight on btn.textContent UNLESS the button
// has a sprite icon, in which case the label lives on a nested .btn-label span instead
// (btn.append(iconEl, span), hudSelection.js:1566-1571) and btn.textContent is never touched.
// Every produce/build button in this suite takes the icon path (spriteIcon succeeds against
// fakeCtx above), so a label reader has to check both shapes.
function buttonLabel(el) {
  return el.children.length ? el.children.map(c => c.textContent || "").join("") : (el.textContent || "");
}

function findButton(labelPrefix) {
  return panelEl.children.find(c => c.tagName === "button" && buttonLabel(c).startsWith(labelPrefix));
}

// factoryStatus's {cls,text} (hudSelection.js:578-599) becomes the ONE "sel-note <cls>" div
// rebuildSelectionPanel appends right after the recipe row (hudSelection.js:986-990) — but
// three OTHER sel-note rows in that very same factory panel (Larder, Output, Grid, Ice Coolant)
// can carry the exact same cls words ("bad"/"warn"/"good") for their OWN unrelated reasons (a
// brimming output buffer is ALSO "bad", a far-flung Smelter's grid line is ALSO "warn", …), so
// matching on cls alone would be ambiguous. Matched instead by TEXT PREFIX: the five strings
// factoryStatus actually returns ("Paused"/"Stalled"/"Starved"/"Throttled"/"Running") are the
// only text in the whole panel that starts with those words.
const FACTORY_STATUS_PREFIXES = ["Paused", "Stalled", "Starved", "Throttled", "Running"];
function findStatusLine() {
  return panelEl.children.find(c => c.tagName === "div" && c.className.startsWith("sel-note")
    && FACTORY_STATUS_PREFIXES.some(p => c.textContent.startsWith(p)));
}

// Same list, position-for-position: true only if EVERY slot holds the exact same object as
// before. assert.deepEqual would call two DIFFERENT-but-identically-shaped button objects
// "equal" too — precisely the false positive TARGET 2 has to rule out (a skip proven only by
// looking the same, not by literally being the same node).
function sameNodes(a, b) {
  return a.length === b.length && a.every((node, i) => node === b[i]);
}

// Fresh engine state with a real Command Center selected — the shared starting point for every
// test below. resetSelectionSignature() is NOT optional here: lastPanelSignature (hudSelection.js
// :66) is module-scope and OUTLIVES any single test, and createGameState() resets its entity-id
// counter to 1 on every call (engine/state.js:22,87) — so two unrelated tests' Command Centers
// both mint id "b1", and with everything else about a fresh two-worker skirmish state identical
// too, can produce byte-identical signature strings. Without a reset, a later test's very FIRST
// render could wrongly hit the "nothing changed" branch and inherit the previous test's stale
// DOM — verified empirically while building this file (a sentinel object pushed onto panelEl.
// children survived a fresh createGameState() + render with no reset in between).
function setup(seed) {
  resetSelectionSignature();
  const state = createGameState({ planetId: "ferros", seed, rng: mulberry32(seed) });
  game.state = state;
  // Every production/research/recycle/logistics button now issues its command through
  // game.transport.submitCommand(cmd) (T-012) instead of calling the engine directly — this test
  // file has no server/session.js session behind its fixture state (nothing here needs a real
  // match loop or ownership/fog validation), so net/directTransport.js's adapter is exactly what
  // boot.js itself falls back to for a not-yet-session-backed state. Synchronous underneath (its
  // own header + test/directTransport.test.js), so every assertion below that reads state right
  // after a button click keeps working unchanged.
  game.transport = createDirectTransport(state);
  game.input = { building: null, attackArmed: false, focusIdleWorker() {}, selectAllArmy() {} };
  game.galaxy = null;
  game.collapsedSections = new Set();
  game.hotkeyActions = [];   // the shape rebuildSelectionPanel (hudSelection.js:722) overwrites on every real rebuild
  const cc = [...state.buildings.values()].find(b => b.type === "command" && b.owner === "player");
  state.selection = [cc.id];
  return { state, cc };
}

// "Produce Worker (50 ore)" — the base-cost button (as opposed to the Worker's altCost biomass
// button, which is a separate button with a different label and stays disabled throughout since
// these tests never grant the player any biomass).
const WORKER_LABEL = `Produce Worker (${costText(UNITS.worker.cost)})`;

/* ---------------------------------------------------------------------------------------------
   TARGET 1 — makeButton's affordable gate (hudSelection.js:1550-1594): a button with a `cost`
   greys out unless canAfford(resources, cost), and a disabled button's click plays the denied
   buzz instead of ever calling the real action.
   --------------------------------------------------------------------------------------------- */

test("produce-Worker button is disabled and its click is inert when the player can't afford the cost", () => {
  const { state, cc } = setup(101);
  state.players.player.resources.ore = 10;   // Worker costs 50 ore (UNITS.worker.cost) — well short

  renderSelectionPanel();
  const btn = findButton(WORKER_LABEL);
  assert.ok(btn, "expected to find the produce-Worker button in the rebuilt panel");
  assert.ok(btn.classList.contains("disabled"), "unaffordable ⇒ makeButton must grey the button out");

  // The concrete bug this guards against: if the `locked || !affordable` gate ever broke (e.g.
  // flipped to `locked && !affordable`), this click would fall through to the REAL handler
  // (queueProduction) instead of just buzzing.
  btn.click();
  assert.deepEqual(cc.queue, [], "a disabled button's click must never queue production");
  assert.equal(state.players.player.resources.ore, 10, "…and must never spend resources either");
});

test("the same produce option ungreys, and its click really queues production, once the player affords the exact cost", () => {
  const { state, cc } = setup(102);
  state.players.player.resources.ore = 50;   // exactly UNITS.worker.cost.ore — canAfford is >=, not >, so this is the boundary

  renderSelectionPanel();
  const btn = findButton(WORKER_LABEL);
  assert.ok(btn, "expected to find the produce-Worker button in the rebuilt panel");
  assert.ok(!btn.classList.contains("disabled"), "affording the exact cost must ungrey the button");

  btn.click();
  assert.equal(cc.queue.length, 1, "an enabled button's click must queue the real production job");
  assert.equal(cc.queue[0].unitType, "worker");
  assert.equal(state.players.player.resources.ore, 0, "…and must actually spend the cost, not just pretend to");
});

/* ---------------------------------------------------------------------------------------------
   TARGET 2 — the panel rebuild-signature memoization. lastPanelSignature/queueSignature/
   availabilitySignature/factorySignature: hudSelection.js:62-135; the gate that compares the
   freshly-built signature against lastPanelSignature and either skips or calls
   rebuildSelectionPanel(): hudSelection.js:278-282.
   --------------------------------------------------------------------------------------------- */

test("renderSelectionPanel skips the rebuild — same DOM node objects, not just same-looking ones — when nothing the signature tracks changed", () => {
  setup(103).state.players.player.resources.ore = 300;

  renderSelectionPanel();   // first call after resetSelectionSignature() always rebuilds (signature can never equal null)
  const before = panelEl.children.slice();
  assert.ok(before.length > 0, "sanity: the CC panel actually rendered something to compare");

  renderSelectionPanel();   // nothing touched game.state/game.input/game.formation/game.collapsedSections/… in between
  assert.ok(sameNodes(panelEl.children, before),
    "re-rendering with no covered change must leave every existing node in place — a real rebuild " +
    "would swap the exact button the player might be mid-click on for a fresh, unclicked one, which " +
    "is precisely the dropped-click bug hudSelection.js's own comment above the signature (lines " +
    "142-149) says this guard exists to prevent");
});

test("renderSelectionPanel rebuilds fresh nodes when the production queue changes under an unchanged selection", () => {
  const { state, cc } = setup(104);
  state.players.player.resources.ore = 300;

  renderSelectionPanel();
  const before = panelEl.children.slice();
  const beforeBtn = findButton(WORKER_LABEL);
  assert.ok(beforeBtn, "sanity: the produce-Worker button exists before the queue changes");

  queueProduction(state, cc.id, "worker");   // queueSignature(sel) (hudSelection.js:90-98) now covers this job
  renderSelectionPanel();

  assert.ok(!sameNodes(panelEl.children, before), "the queue changed — this must be a real rebuild, not a skip");
  assert.equal(panelEl.children.length, before.length + 1,
    "the new queue row (hudSelection.js's renderQueueRows, called once cc.queue.length is truthy) must actually appear");
  assert.ok(panelEl.children.some(c => c.className.includes("queue-row")), "…specifically as a .queue-row");
  assert.notEqual(findButton(WORKER_LABEL), beforeBtn,
    "even the untouched produce button must come back as a fresh node — rebuildSelectionPanel " +
    "clears panelEl (innerHTML = \"\") and re-creates everything, it doesn't patch just the diff");
});

test("renderSelectionPanel rebuilds fresh nodes when a button's affordability crosses the line — how TARGET 1's disabled-class flip is even possible", () => {
  const { state } = setup(105);
  state.players.player.resources.ore = 10;   // unaffordable

  renderSelectionPanel();
  const before = findButton(WORKER_LABEL);
  assert.ok(before, "sanity: the produce-Worker button exists before affording it");
  assert.ok(before.classList.contains("disabled"));
  const beforeCount = panelEl.children.length;

  state.players.player.resources.ore = 300;   // now affordable — availabilitySignature() (hudSelection.js:114-121) must change
  renderSelectionPanel();
  const after = findButton(WORKER_LABEL);

  assert.notEqual(after, before,
    "makeButton only computes `affordable` at BUILD time (hudSelection.js:1577) — the disabled " +
    "class can never change via the live-patch skip path, only via a full rebuild, so crossing " +
    "the affordability line must trigger one (this is the same mechanism the two TARGET-1 tests " +
    "above rely on to see the class flip across their own re-render)");
  assert.ok(!after.classList.contains("disabled"), "…and the fresh node must reflect the new affordability");
  assert.equal(panelEl.children.length, beforeCount,
    "unlike the queue-change rebuild above, this one changes no button's existence — same shape, different identity");
});

/* ---------------------------------------------------------------------------------------------
   TARGET 3 — factoryStatus (hudSelection.js:578-599): a genuinely PURE function (no DOM at all)
   that picks a selected factory's status line by PRIORITY — paused, then no Power, then starved
   of a specific input, then a full output buffer, then a Power shortfall throttling everything,
   else running with the live rate. Reached only through renderSelectionPanel(), same as every
   other target in this file, by selecting a real factory building and reading back the ONE
   "sel-note" row it renders (findStatusLine, above). Each test below builds a factory that could
   plausibly match TWO reasons at once and checks the row shows the HIGHER-priority one — not
   just that each reason works in isolation.
   --------------------------------------------------------------------------------------------- */

// A completed Smelter (ore + power -> metals, data.js RECIPES.smelt, prodRate 2) — the simplest
// factory in the game, and the one every test below standardises on. Selecting it REPLACES the
// selection setup() already made (the Command Center it picked stays a building in
// state.buildings, just dropped from state.selection), so the panel's factory branch
// (hudSelection.js:973) is the only sub-panel in play — nothing about a Command Center muddies
// the DOM tree findStatusLine reads back.
function makeSmelter(state, fields = {}) {
  const sm = makeBuilding("smelter", "player", 500, 500);
  Object.assign(sm, fields);
  state.buildings.set(sm.id, sm);
  state.selection = [sm.id];
  return sm;
}

// A completed, fuelled Reactor (energyGrants 30, entities.js). powerCap/powerDraw
// (engine/industry.js) only count a combust-fuelled source as ACTIVE once `powered` is true —
// real play sets that from updateCombustors ticking its own fuel larder down, but these tests
// never call tick()/updateCombustors, so it's set by hand here, the same shortcut
// industry.test.js's "a high-industry world…" test takes for the identical reason.
function makeReactor(state, x = 500, y = 500) {
  const r = makeBuilding("reactor", "player", x, y);
  r.powered = true;
  state.buildings.set(r.id, r);
  return r;
}

test("factoryStatus: paused beats every other reason at once — no Power, starved, AND a full output buffer are ALSO true here", () => {
  const { state } = setup(206);
  // No Reactor anywhere (no Power too), an empty input larder (starved too), and the output
  // buffer already at its 80-unit cap (buffer-full too) — paused is checked FIRST in the source
  // (hudSelection.js:579), so it alone should win the row even though every other branch below
  // it would also fire if it were ever reached.
  makeSmelter(state, { paused: true, input: {}, store: { metals: 80 } });

  renderSelectionPanel();
  const row = findStatusLine();
  assert.ok(row, "expected the factory status row to render");
  assert.equal(row.className, "sel-note paused");
  assert.equal(row.textContent, "Paused — banking its inputs");
});

test("factoryStatus: no Power beats starved when both are true", () => {
  const { state } = setup(207);
  // No Reactor at all ⇒ powerThrottle is 0 ⇒ "no Power" (hudSelection.js:581) — and the input
  // larder is ALSO empty, so the starved check just below it (hudSelection.js:592) would fire
  // too, if the no-Power branch above it hadn't already returned.
  makeSmelter(state, { input: {} });

  renderSelectionPanel();
  const row = findStatusLine();
  assert.equal(row.className, "sel-note bad");
  assert.equal(row.textContent, "Stalled — no Power");
});

test("factoryStatus: starved beats a full output buffer when both are true, and names the scarce input", () => {
  const { state } = setup(208);
  makeReactor(state);
  // Fully powered (throttle 1, so the no-Power check above it is out of the running) — but the
  // input larder is empty (starved) AND the output buffer already sits at its 80-unit cap
  // (buffer-full), so BOTH hudSelection.js:592 and :593 would match; starved is checked first
  // and should win.
  makeSmelter(state, { input: {}, store: { metals: 80 } });

  renderSelectionPanel();
  const row = findStatusLine();
  assert.equal(row.className, "sel-note bad");
  assert.equal(row.textContent, "Starved — needs Ore carried in",
    "names the ONE scarce commodity the smelt recipe needs (ore) — the only non-energy input it has");
});

// Both of the next two tests share this rig: 1 Reactor (cap 30) + 6 on-grid Smelters (draw 4
// each: smelt's energy 2 × prodRate 2) + 2 on-grid Assembly Plants (draw 3 each: alloy's energy
// 2 × prodRate 1.5) = 24 + 6 = 30 — exactly SATURATING the Reactor with zero slack (throttle
// would be a flat 1.0 with nothing else drawing). `extra` PAUSED Machine Works are then added
// purely as fine-grained Power-draw ballast on top: a paused factory still idles at a
// PAUSED_POWER_FRACTION (5%, industry.js) standby trickle of its own recipe's draw, and Machine
// Works' recipe (data.js RECIPES.machine) draws the LEAST of any factory in the game (1 energy ×
// prodRate 1) — so paused, each one adds exactly 0.05 draw, the finest knob powerDraw exposes.
// That makes the exact 0.995 throttle line (hudSelection.js:594) reachable with real buildings
// instead of a guess: 30/(30+0.05·3) = 200/201 ≈ 0.995025 (just ABOVE the line) and
// 30/(30+0.05·4) = 150/151 ≈ 0.993377 (just BELOW it) — both fractions checked once against the
// literal `0.995` in a node REPL before being written in below, not eyeballed. Being paused (and
// never selected), the filler Machine Works never render a status row of their own — only the
// one selected Smelter's does.
function throttleRig(state, extraPausedMachineWorks) {
  makeReactor(state);
  const sm = makeSmelter(state, { input: { ore: 1000 } });   // the SELECTED factory — plenty of ore, never starved
  for (let i = 0; i < 5; i++) {
    const filler = makeBuilding("smelter", "player", 520 + i * 8, 500);
    state.buildings.set(filler.id, filler);
  }
  for (let i = 0; i < 2; i++) {
    const filler = makeBuilding("assembler", "player", 580 + i * 8, 500);
    state.buildings.set(filler.id, filler);
  }
  for (let i = 0; i < extraPausedMachineWorks; i++) {
    const filler = makeBuilding("machineworks", "player", 620 + i * 8, 500);
    filler.paused = true;
    state.buildings.set(filler.id, filler);
  }
  return sm;
}

test("factoryStatus: throttle just under the 0.995 line reads Throttled, not Running", () => {
  const { state } = setup(209);
  throttleRig(state, 4);   // total draw 30.2 -> throttle 150/151 ≈ 0.993377, which IS < 0.995

  renderSelectionPanel();
  const row = findStatusLine();
  assert.equal(row.className, "sel-note warn");
  assert.equal(row.textContent, "Throttled 99% — low Power");
});

test("factoryStatus: throttle AT the 0.995 line (not below it) reads Running, with the live output rate", () => {
  const { state } = setup(210);
  throttleRig(state, 3);   // total draw 30.15 -> throttle 200/201 ≈ 0.995025, which is NOT < 0.995

  renderSelectionPanel();
  const row = findStatusLine();
  assert.equal(row.className, "sel-note good");
  // rate = prodRate 2 × planetIndustryScale(ferros, industry 4) 0.8 × throttle (200/201) ×
  // recipe.qty 2 — no techs researched, so both techMult factors are the neutral 1×. Computed
  // once in the same node REPL as the throttle fractions above (3.18407960199005, toFixed(1)
  // "3.2"), not re-derived by hand here.
  assert.equal(row.textContent, "Running · +3.2 Metals/s",
    "the `<` in hudSelection.js:594 must let a throttle sitting exactly ON 0.995 through, not just above it");
});

/* ---------------------------------------------------------------------------------------------
   TARGET 4 — the Refinery's doctrine-lock vs tier-lock precedence (hudSelection.js:886-890):
   `doctrineLocked` (committed to a DIFFERENT doctrine) and `tierLocked` (this upgrade's own
   Tier-1 isn't researched yet) are computed independently and OR'd into one `locked` flag, but
   the lockTip STRING picks doctrine's message over tier's whenever both are true. The doctrine
   is committed via the real researchUpgrade (engine/production.js) on a real state, never by
   hand-setting player.upgrades — so a regression in researchUpgrade's OWN doctrine gate would
   surface here too.
   --------------------------------------------------------------------------------------------- */

// Mirrors hudSelection.js's own module-private `label` map inside the refinery branch
// (hudSelection.js:876) — kept local for the same reason costText() is: so a button's title is
// checked against the real doctrine names, not a hand-typed guess that could drift.
const DOCTRINE_LABEL = { assault: "Assault", bulwark: "Bulwark", logistics: "Logistics" };

// A completed Refinery, selected alone — the Research sub-panel (hudSelection.js:872-896) is a
// flat, ungrouped button-per-upgrade list (no separate tree UI), so this is the only building
// whose selection ever renders it.
function selectRefinery(state) {
  const refinery = makeBuilding("refinery", "player", 500, 500);
  state.buildings.set(refinery.id, refinery);
  state.selection = [refinery.id];
  return refinery;
}

// Mirrors the refinery branch's own button label format (hudSelection.js:891) — kept local for
// the same "match the real data, don't hand-type a copy" reason costText()/WORKER_LABEL are.
// Every UPGRADES entry carries an `ico` (unlike the Worker button WORKER_LABEL matches against,
// which takes makeButton's SPRITE-icon path), so — same as makeButton's own emoji-icon branch
// (hudSelection.js:1558-1561, appended before the label span at :1571) — buttonLabel() reads the
// icon's textContent back FIRST, with no separator: the emoji has to lead here too, or findButton
// (a plain .startsWith) never matches.
function upgradeButtonLabel(u) {
  return `${u.ico || ""}Research ${u.name} · ${DOCTRINE_LABEL[u.doctrine]} (${costText(u.cost)})`;
}

test("Refinery research: doctrine-lock wins over tier-lock when a button is BOTH — committed to a different doctrine AND its own Tier-1 is unmet", () => {
  const { state } = setup(211);
  const refinery = selectRefinery(state);
  Object.assign(state.players.player.resources, { ore: 2000, crystals: 2000, radioactives: 2000 });

  // Commit to Assault for real, through the exact gate the button's own click handler calls —
  // not by poking player.upgrades directly.
  assert.equal(researchUpgrade(state, refinery.id, "overchargedWeapons"), true, "sanity: commits the Assault doctrine");

  renderSelectionPanel();
  // Reinforced Bulwark is Bulwark's Tier-2 — a DIFFERENT doctrine than the one just committed
  // (doctrineLocked true) — AND its own Tier-1 (Reinforced Plating) was never researched
  // (tierLocked ALSO true): both locks apply to this one button at once.
  const btn = findButton(upgradeButtonLabel(UPGRADES.reinforcedBulwark));
  assert.ok(btn, "expected the Reinforced Bulwark research button in the rebuilt panel");
  assert.ok(btn.classList.contains("disabled"), "locked (by either reason) ⇒ greyed out");
  assert.equal(btn.title, "Locked — committed to the Assault doctrine",
    "the doctrine-locked message must win over the tier-locked one when both are true");
  assert.ok(!btn.title.includes("Requires"), "must NOT show the tier-locked wording here");

  // And the lock is REAL, not just cosmetic: same idiom as TARGET 1's disabled-click check —
  // clicking a locked button must never grant the upgrade underneath the misleading tip.
  btn.click();
  assert.equal(state.players.player.upgrades.reinforcedBulwark, undefined, "a locked button's click must never research the upgrade");
});

test("Refinery research: with the SAME doctrine committed, an unmet Tier-1 alone shows the tier-locked message (sanity baseline)", () => {
  const { state } = setup(212);
  const refinery = selectRefinery(state);
  Object.assign(state.players.player.resources, { ore: 2000, crystals: 2000, radioactives: 2000 });

  // Commit to Logistics via its OWN Tier-1 (Logistics Network). Field Recycling is Logistics'
  // Tier-3: its doctrine is already satisfied (doctrineLocked false — chosen === u.doctrine) but
  // its own Tier-2 prereq (Rapid Fabrication) was never researched (tierLocked true) — only ONE
  // of the two locks applies to this button.
  assert.equal(researchUpgrade(state, refinery.id, "logisticsNetwork"), true, "sanity: commits the Logistics doctrine");

  renderSelectionPanel();
  const btn = findButton(upgradeButtonLabel(UPGRADES.recycling));
  assert.ok(btn, "expected the Field Recycling research button in the rebuilt panel");
  assert.ok(btn.classList.contains("disabled"));
  assert.equal(btn.title, "Requires Rapid Fabrication", "same doctrine ⇒ only the tier-locked message applies");
});

/* ---------------------------------------------------------------------------------------------
   Doctrine research develops over time (Tier 1 proposal): the Refinery now gets its own live
   progress row, reusing the Datacenter research-row idiom — a queued-but-developing upgrade
   drops out of the plain button list (same as a Datacenter node already does) in favour of the
   progress row saying it's underway.
   --------------------------------------------------------------------------------------------- */

test("Refinery research: a queued upgrade shows a live progress row and drops out of the button list", () => {
  const { state } = setup(214);
  const refinery = selectRefinery(state);
  Object.assign(state.players.player.resources, { crystals: 2000 });

  assert.equal(researchUpgrade(state, refinery.id, "reinforcedPlating"), true, "sanity: queues Reinforced Plating");
  renderSelectionPanel();

  const row = panelEl.querySelector(".research-progress");
  assert.ok(row, "expected a live progress row for the Refinery's own research queue, same idiom as the Datacenter");
  assert.ok(row.textContent.includes("Reinforced Plating"), "names the upgrade actually developing");
  assert.ok(row.textContent.includes("0%"), "starts at 0%, not landed instantly");
  assert.ok(!findButton(upgradeButtonLabel(UPGRADES.reinforcedPlating)),
    "the now-queued upgrade drops out of the plain button list — the progress row above already says it's underway");
});

/* ---------------------------------------------------------------------------------------------
   Cancelable research queue with refunds (docs/improvement-proposals.md): the Datacenter's
   research row gets the production-queue's own cancel-button idiom (renderQueueRows) — one row
   per queued node, each with its own × button calling cancelResearch and re-rendering.
   --------------------------------------------------------------------------------------------- */

function selectDatacenter(state) {
  const dc = makeBuilding("datacenter", "player", 600, 500);
  state.buildings.set(dc.id, dc);
  state.selection = [dc.id];
  return dc;
}

test("Datacenter research: a queued node gets its own cancel button, and clicking it fully refunds and dequeues", () => {
  const { state } = setup(215);
  const dc = selectDatacenter(state);
  state.players.player.resources.crystals = 1000;

  assert.equal(researchTech(state, dc.id, "metallurgy"), true, "sanity: queues Metallurgy");
  const before = state.players.player.resources.crystals;
  renderSelectionPanel();

  const cancelBtn = panelEl.querySelector(".queue-cancel");
  assert.ok(cancelBtn, "expected a cancel button on the Datacenter's queued research row, same idiom as the production queue");
  cancelBtn.click();

  assert.equal(dc.researchQueue.length, 0, "cancelling empties the queue");
  assert.equal(state.players.player.resources.crystals, before + TECHS.metallurgy.cost.crystals, "…and fully refunds it");
});

test("Datacenter research: queued-behind nodes each get their own row and cancel button, and cancelling the head cascades the panel too", () => {
  const { state } = setup(216);
  const dc = selectDatacenter(state);
  state.players.player.resources.crystals = 1000;

  researchTech(state, dc.id, "metallurgy");
  researchTech(state, dc.id, "electronics");   // requires metallurgy — queued ahead of it, a second row
  renderSelectionPanel();

  const cancelBtns = panelEl.querySelectorAll(".queue-cancel");
  assert.equal(cancelBtns.length, 2, "one cancel button per queued research job");

  cancelBtns[0].click();   // cancel Metallurgy (the head) — Electronics depends on it and must cascade out too
  assert.equal(dc.researchQueue.length, 0, "the dependent cascades out of the queue along with its prereq");
});

/* ---------------------------------------------------------------------------------------------
   TARGET 5 — the reported bug: the Market panel's price/afford-state live patch
   (hudSelection.js's marketRowFields/refreshMarketRows). A Buy or Sell trade mutates
   engine/market.js's trade pressure, but touches nothing renderSelectionPanel's rebuild
   SIGNATURE tracks (selection, queue, upgrades, collapsed sections, …) — so the price the panel
   shows has to be kept live by patching the existing row's nodes in place, on every
   renderSelectionPanel() tick, not by waiting for a rebuild that a trade alone never triggers.
   Before the fix, this left the price frozen until the player deselected the Market and
   reselected it (the only thing that forces a rebuild).
   --------------------------------------------------------------------------------------------- */

// A finished Market building, selected alone, with a real price book (engine/market.js
// createMarket). Mirrors setup()'s shape but swaps the Command Center for a Market. Both the ore
// stockpile and the credit balance are absurd on purpose: availabilitySignature() (hudSelection.js)
// folds "can the player afford every UNIT/BUILDING/UPGRADE cost" into the panel's rebuild
// signature, and some upgrade costs run into the thousands (TARGET 4 above uses 2000) — a modest
// ore balance could cross one of those lines after a couple of trade lots and trigger a REAL
// rebuild, which is a legitimate reason to rebuild (TARGET 2 covers it) but would wrongly conflate
// with what THESE tests isolate: a trade that crosses no such line and must be a pure live patch.
// 1e7/1e9 sit far above every real cost table, so a handful of TRADE_LOTs can never cross one.
function setupMarket(seed) {
  const { state } = setup(seed);
  const market = makeBuilding("market", "player", 500, 500);
  state.buildings.set(market.id, market);
  state.selection = [market.id];
  state.market = createMarket(state);
  state.players.player.resources.ore = 1e7;
  game.galaxy = { credits: 1e9 };
  return { state, market };
}

function marketRow(com) {
  return panelEl.querySelectorAll(".market-row").find(r => r.dataset.com === com);
}

// Ore runs cheap on an ore-rich map (e.g. base 5 on ferros) — one lot's ~5% slippage can round to
// the same displayed integer and make a text-equality assertion flaky. Several lots' worth of
// slippage compounds past any rounding boundary regardless of the map's (seed-dependent) base
// price — confirmed against every seed these tests use before picking this constant.
const PROBE_LOTS = 4;

test("clicking Sell in the Market panel refreshes that row's price and Sell button in place — no rebuild needed", () => {
  const { state } = setupMarket(301);

  renderSelectionPanel();
  const row = marketRow("ore");
  assert.ok(row, "expected an 'ore' row in the rebuilt Market panel");
  const oreBefore = state.players.player.resources.ore;
  const priceBefore = row.querySelector(".market-com").textContent;
  const sellBtn = row.querySelector(".market-sell");
  assert.ok(sellBtn, "expected a Sell button in the ore row");

  for (let i = 0; i < PROBE_LOTS; i++) sellBtn.click();   // sell(): drops stock, crashes the price — neither touches the rebuild signature
  assert.equal(state.players.player.resources.ore, oreBefore - PROBE_LOTS * TRADE_LOT, "sanity: the clicks really sold that many lots");

  const rowAfter = marketRow("ore");
  assert.equal(rowAfter, row, "the row must still be the SAME node — a live patch, not a rebuild");
  const priceAfter = rowAfter.querySelector(".market-com").textContent;
  assert.notEqual(priceAfter, priceBefore,
    "the displayed price must move as the trades land — this is the reported bug: it used to stay " +
    "frozen at the pre-trade price until the Market was deselected and reselected");
});

test("clicking Buy in the Market panel refreshes that row's price and Buy button in place — no rebuild needed", () => {
  const { state } = setupMarket(302);

  renderSelectionPanel();
  const row = marketRow("ore");
  const oreBefore = state.players.player.resources.ore;
  const priceBefore = row.querySelector(".market-com").textContent;
  const buyBtn = row.querySelector(".market-buy");
  assert.ok(buyBtn, "expected a Buy button in the ore row");
  const buyTitleBefore = buyBtn.title;

  for (let i = 0; i < PROBE_LOTS; i++) buyBtn.click();   // buy(): adds stock, pushes the price the OTHER direction
  assert.equal(state.players.player.resources.ore, oreBefore + PROBE_LOTS * TRADE_LOT, "sanity: the clicks really bought that many lots");

  const rowAfter = marketRow("ore");
  assert.equal(rowAfter, row, "the row must still be the SAME node — a live patch, not a rebuild");
  assert.notEqual(rowAfter.querySelector(".market-com").textContent, priceBefore,
    "buying must also refresh the live price, not just selling");
  assert.notEqual(rowAfter.querySelector(".market-buy").title, buyTitleBefore,
    "the Buy button's own tooltip (its cost for the next lot) must move too, since the price it quotes just did");
});

test("the Market panel's live patch survives an UNRELATED renderSelectionPanel tick (the normal 150ms HUD poll) without losing the fresh price", () => {
  setupMarket(303);

  renderSelectionPanel();
  const row = marketRow("ore");
  for (let i = 0; i < PROBE_LOTS; i++) row.querySelector(".market-sell").click();
  const priceAfterSell = row.querySelector(".market-com").textContent;

  renderSelectionPanel();   // an ordinary tick — nothing changed since the clicks' own renderHUD() already patched it
  assert.equal(marketRow("ore"), row, "an unrelated tick must not rebuild the row either");
  assert.equal(marketRow("ore").querySelector(".market-com").textContent, priceAfterSell,
    "the price must stay exactly what the trades set it to — not drift, not revert");
});

/* ---------------------------------------------------------------------------------------------
   TARGET 8 — Bulk trading UI + glut/pressure trend readout (docs/improvement-proposals.md): each
   Market row also gets a Sell x4 and a Sell All button — both pass the FULL qty straight to the
   real sell() (engine/market.js), which self-limits via marginal pricing, so nothing new to gate
   here beyond "at least one lot held" — plus a small trend glyph derived from
   state.market.pressure/glut so a glutted commodity reads at a glance instead of requiring a
   mental price-history comparison.
   --------------------------------------------------------------------------------------------- */

test("the Market panel offers Sell x4 and Sell All buttons per row, alongside the existing Sell/Buy pair", () => {
  setupMarket(311);
  renderSelectionPanel();
  const row = marketRow("ore");
  assert.ok(row.querySelector(".market-sell"), "sanity: the plain Sell button is still there");
  assert.ok(row.querySelector(".market-buy"), "sanity: the plain Buy button is still there");
  const sell4 = row.querySelector(".market-sell4");
  const sellAll = row.querySelector(".market-sellall");
  assert.ok(sell4, "expected a Sell x4 button");
  assert.ok(sellAll, "expected a Sell All button");
  assert.equal(sell4.textContent, `Sell ${TRADE_LOT * 4}`);
  assert.equal(sellAll.textContent, "Sell All");
});

test("Sell x4 sells exactly 4 lots through the real sell(), and its tooltip previews quoteSell's real proceeds", () => {
  const { state } = setupMarket(312);
  renderSelectionPanel();
  const row = marketRow("ore");
  const oreBefore = state.players.player.resources.ore;
  const creditsBefore = game.galaxy.credits;
  const preview = quoteSell(state.market, "ore", TRADE_LOT * 4);
  assert.ok(row.querySelector(".market-sell4").title.includes(String(preview)),
    `expected the Sell x4 tooltip to quote quoteSell's own ${preview}, got: ${JSON.stringify(row.querySelector(".market-sell4").title)}`);

  row.querySelector(".market-sell4").click();

  assert.equal(state.players.player.resources.ore, oreBefore - TRADE_LOT * 4, "sold exactly 4 lots");
  assert.equal(game.galaxy.credits, creditsBefore + preview,
    "the real sale must earn exactly what the preview quoted — a UI preview that could drift from engine math is the bug this guards");
});

test("Sell All sells the player's full remaining holding, including a partial final lot", () => {
  const { state } = setupMarket(313);
  state.players.player.resources.ore = TRADE_LOT * 5 + 10;   // 5 full lots plus a partial one
  renderSelectionPanel();
  const row = marketRow("ore");

  row.querySelector(".market-sellall").click();

  assert.equal(state.players.player.resources.ore, 0, "Sell All must clear the entire holding, partial lot included");
  assert.ok(game.galaxy.credits > 1e9, "credits went up by the sale proceeds");
});

test("Sell x4 and Sell All are disabled and inert below one full lot, same gate as the plain Sell button", () => {
  const { state } = setupMarket(314);
  state.players.player.resources.ore = TRADE_LOT - 1;   // short of even one lot
  renderSelectionPanel();
  const row = marketRow("ore");
  const sell4 = row.querySelector(".market-sell4"), sellAll = row.querySelector(".market-sellall");
  assert.ok(sell4.classList.contains("disabled"), "Sell x4 must grey out short of one lot");
  assert.ok(sellAll.classList.contains("disabled"), "Sell All must grey out short of one lot");

  const before = state.players.player.resources.ore;
  sell4.click();
  sellAll.click();
  assert.equal(state.players.player.resources.ore, before, "a disabled bulk-sell click must never sell anything");
});

test("Sell x4/Sell All live-patch their tooltip across an unrelated renderSelectionPanel tick, same as the plain Sell/Buy pair", () => {
  const { state } = setupMarket(315);
  renderSelectionPanel();
  const row = marketRow("ore");
  const titleBefore = row.querySelector(".market-sell4").title;

  for (let i = 0; i < PROBE_LOTS; i++) row.querySelector(".market-sell").click();
  renderSelectionPanel();   // an ordinary tick

  assert.equal(marketRow("ore"), row, "an unrelated tick must not rebuild the row");
  assert.notEqual(marketRow("ore").querySelector(".market-sell4").title, titleBefore,
    "the Sell x4 tooltip must track the price the earlier Sell clicks just moved, not stay frozen");
});

test("a fresh market row shows no trend glyph — nothing notable to flag at equilibrium", () => {
  setupMarket(316);
  renderSelectionPanel();
  const trend = marketRow("ore").querySelector(".market-trend");
  assert.ok(trend, "expected a trend span in the row");
  assert.equal(trend.textContent, "", "a freshly-created market has no pressure/glut yet to read a trend from");
});

test("heavy selling of a produced good reads as glutted — 'still falling' right after, then 'recovering' once the fast pressure alone relaxes", () => {
  const { state } = setupMarket(317);
  state.players.player.resources.machinery = 5000;   // a produced good — the only tier glut ever applies to
  renderSelectionPanel();

  for (let i = 0; i < 20; i++) marketRow("machinery").querySelector(".market-sell").click();   // saturate pressure AND glut
  renderSelectionPanel();
  const justAfter = marketRow("machinery").querySelector(".market-trend").textContent;
  assert.equal(justAfter, "▼ Glutted, still falling",
    "fresh off heavy selling, the fast pressure term is still deeply negative too");

  updateMarket(state, 20);   // dt=20 fully relaxes the ~17s-constant pressure in one step, but barely dents the ~8min glut
  renderSelectionPanel();
  const later = marketRow("machinery").querySelector(".market-trend").textContent;
  assert.equal(later, "▼ Glutted, recovering",
    "pressure has relaxed but the slow glut hasn't — the trend glyph must distinguish the two, not conflate them");
});

test("heavy buying (no glut on the buy side) reads as elevated", () => {
  setupMarket(318);
  renderSelectionPanel();
  for (let i = 0; i < 15; i++) marketRow("ore").querySelector(".market-buy").click();
  renderSelectionPanel();
  assert.equal(marketRow("ore").querySelector(".market-trend").textContent, "↑ Elevated");
});

/* ---------------------------------------------------------------------------------------------
   TARGET 6 — node saturation visible in the panel (docs/improvement-proposals.md): a selected
   worker on a real gather order shows its assigned node's live "Miners X/cap" headcount
   (node.miners, retallied every tick by sim.js's countMiners), flagging the diminishing-returns
   band once it crosses UNITS.worker.minerSoftCap — the same number miningEfficiency
   (engine/gather.js) already silently divides by, with nothing anywhere showing it until now.
   --------------------------------------------------------------------------------------------- */

function findMinersNote() {
  return panelEl.children.find(c => c.tagName === "div" && (c.textContent || "").startsWith("Miners "));
}

// Selects the seeded starting Worker and puts it on a real gather order against `node`, with
// `miners` standing in for the live per-tick tally sim.js's countMiners would otherwise freeze on
// this node (these tests never call tick(), same shortcut the rest of this file takes).
function selectGatheringWorker(state, node, miners) {
  const worker = [...state.units.values()].find(u => u.owner === "player" && u.type === "worker");
  worker.order = { type: "gather", nodeId: node.id, phase: "mining" };
  node.miners = miners;
  state.selection = [worker.id];
  return worker;
}

test("a selected gathering worker shows its node's live miner count against the soft cap", () => {
  const { state } = setup(401);
  const node = state.map.nodes.find(n => n.com === "ore");
  selectGatheringWorker(state, node, 2);   // under UNITS.worker.minerSoftCap (3)

  renderSelectionPanel();
  const note = findMinersNote();
  assert.ok(note, "expected a 'Miners …' note for the selected gathering worker");
  assert.equal(note.textContent, `Miners 2/${UNITS.worker.minerSoftCap}`);
  assert.ok(!note.className.includes("warn"), "under the cap is not a warning");
});

test("a selected gathering worker flags diminishing returns once its node's miners exceed the soft cap", () => {
  const { state } = setup(402);
  const node = state.map.nodes.find(n => n.com === "ore");
  const over = UNITS.worker.minerSoftCap + 2;
  selectGatheringWorker(state, node, over);

  renderSelectionPanel();
  const note = findMinersNote();
  assert.ok(note, "expected a 'Miners …' note for the selected gathering worker");
  assert.equal(note.textContent, `Miners ${over}/${UNITS.worker.minerSoftCap} — diminishing returns`);
  assert.ok(note.className.includes("warn"), "over the cap should read as a warning");
});

test("a selected worker with no gather order shows no miners note", () => {
  const { state } = setup(403);
  const worker = [...state.units.values()].find(u => u.owner === "player" && u.type === "worker");
  state.selection = [worker.id];   // idle — no order at all

  renderSelectionPanel();
  assert.equal(findMinersNote(), undefined, "an idle worker has no node to report saturation for");
});

test("the miners note stays live across an unrelated renderSelectionPanel tick as the node's headcount changes", () => {
  const { state } = setup(404);
  const node = state.map.nodes.find(n => n.com === "ore");
  selectGatheringWorker(state, node, 1);

  renderSelectionPanel();
  assert.equal(findMinersNote().textContent, `Miners 1/${UNITS.worker.minerSoftCap}`);

  node.miners = UNITS.worker.minerSoftCap + 4;   // another worker piles on, tallied on some later tick
  renderSelectionPanel();   // an ordinary tick — nothing ELSE about the selection changed
  assert.equal(findMinersNote().textContent, `Miners ${UNITS.worker.minerSoftCap + 4}/${UNITS.worker.minerSoftCap} — diminishing returns`,
    "the live headcount must not freeze at whatever it read on the panel's last rebuild — same " +
    "live-patch requirement TARGET 5's market rows pin above");
});

/* ---------------------------------------------------------------------------------------------
   TARGET 7 — counter-triangle readability (docs/improvement-proposals.md "Counter-triangle
   telegraphs" + "Surface the counter-triangle on unit buttons and selection rows", merged):
   unitTip() appends "strong vs / falls to" lines derived from UNITS[].bonusVs (+
   bonusVsBuildings -> "structures"), and the aggregated per-type selection rows (countByType,
   both rebuildSelectionPanel's initial build and renderSelectionPanel's live hp-only patch) get
   the same "falls to" suffix so a mixed-army scan shows its soft spots. Both are pure reads off
   the static UNITS table — no engine change, no new DOM machinery beyond what's already here.
   --------------------------------------------------------------------------------------------- */

test("a produce button's tooltip carries the counter-triangle 'strong vs' / 'falls to' lines, derived from UNITS[].bonusVs", () => {
  const { state } = setup(501);
  const barracks = makeBuilding("barracks", "player", 500, 500);
  state.buildings.set(barracks.id, barracks);
  state.selection = [barracks.id];

  renderSelectionPanel();
  const btn = findButton(`Produce Skiff (${costText(UNITS.skiff.cost)})`);
  assert.ok(btn, "expected the produce-Skiff button in the rebuilt Barracks panel");
  assert.ok(btn.title.includes("▲ strong vs Lancer"), `expected a 'strong vs Lancer' line in the tooltip, got: ${JSON.stringify(btn.title)}`);
  assert.ok(btn.title.includes("▼ falls to Bastion"), `expected a 'falls to Bastion' line in the tooltip, got: ${JSON.stringify(btn.title)}`);
});

test("a unit deliberately outside the triangle (the Dreadnought) shows neither counter line", () => {
  const { state } = setup(502);
  const barracks = makeBuilding("barracks", "player", 500, 500);
  state.buildings.set(barracks.id, barracks);
  state.selection = [barracks.id];

  renderSelectionPanel();
  const btn = findButton(`Produce Dreadnought (${costText(UNITS.dreadnought.cost)})`);
  assert.ok(btn, "expected the produce-Dreadnought button");
  assert.ok(!btn.title.includes("▲ strong vs"), `Dreadnought has no bonusVs — expected no 'strong vs' line, got: ${JSON.stringify(btn.title)}`);
  assert.ok(!btn.title.includes("▼ falls to"), `nothing counters the Dreadnought — expected no 'falls to' line, got: ${JSON.stringify(btn.title)}`);
});

test("a siege unit's 'strong vs' line reads 'structures' for its class-wide bonusVsBuildings, not a specific unit type", () => {
  const { state } = setup(503);
  const barracks = makeBuilding("barracks", "player", 500, 500);
  state.buildings.set(barracks.id, barracks);
  // The Breacher requires a completed Foundry (UNITS.breacher.requires) — build one so the button
  // is actually unlocked and shows its real unitTip, not lockTipFor's "Requires Foundry" instead.
  const foundry = makeBuilding("foundry", "player", 560, 500);
  state.buildings.set(foundry.id, foundry);
  state.selection = [barracks.id];

  renderSelectionPanel();
  const btn = findButton(`Produce Breacher (${costText(UNITS.breacher.cost)})`);
  assert.ok(btn, "expected the produce-Breacher button");
  assert.ok(btn.title.includes("▲ strong vs structures"), `expected 'strong vs structures' from bonusVsBuildings, got: ${JSON.stringify(btn.title)}`);
});

test("the aggregated multi-type selection row is suffixed with its 'falls to' counter, so a mixed army shows its soft spot", () => {
  const { state } = setup(504);
  const skiffA = makeUnit("skiff", "player", 500, 500);
  const skiffB = makeUnit("skiff", "player", 520, 500);
  const bastion = makeUnit("bastion", "player", 540, 500);
  [skiffA, skiffB, bastion].forEach(u => state.units.set(u.id, u));
  state.selection = [skiffA.id, skiffB.id, bastion.id];

  renderSelectionPanel();
  const rows = panelEl.querySelectorAll(".sel-row-summary");
  const skiffRow = rows.find(r => r.textContent.startsWith("2× Skiff"));
  const bastionRow = rows.find(r => r.textContent.startsWith("1× Bastion"));
  assert.ok(skiffRow, "expected the aggregated Skiff row");
  assert.ok(bastionRow, "expected the aggregated Bastion row");
  assert.ok(skiffRow.textContent.includes("▼ falls to Bastion"),
    `expected the Skiff row to flag its Bastion weakness, got: ${skiffRow.textContent}`);
  assert.ok(bastionRow.textContent.includes("▼ falls to Lancer"),
    `expected the Bastion row to flag its Lancer weakness (the real counter, not the Skiff it's grouped with), got: ${bastionRow.textContent}`);
});

test("the aggregated row's counter suffix survives the live hp-only patch too, not just the initial rebuild (same rule TARGET 5's market rows and TARGET 6's miners note already pin)", () => {
  const { state } = setup(505);
  const skiff = makeUnit("skiff", "player", 500, 500);
  const bastion = makeUnit("bastion", "player", 520, 500);
  state.units.set(skiff.id, skiff);
  state.units.set(bastion.id, bastion);
  state.selection = [skiff.id, bastion.id];

  renderSelectionPanel();   // initial rebuild
  skiff.hp = Math.max(1, skiff.hp - 10);   // damage only — doesn't change the panel's rebuild signature
  renderSelectionPanel();   // live hp-only patch path (TARGET 2)

  const rows = panelEl.querySelectorAll(".sel-row-summary");
  const skiffRow = rows.find(r => r.textContent.startsWith("1× Skiff"));
  assert.ok(skiffRow, "expected the live-patched Skiff row");
  assert.ok(skiffRow.textContent.includes("▼ falls to Bastion"),
    `expected the live-patched row to still carry the counter suffix, got: ${skiffRow.textContent}`);
});

/* ---------------------------------------------------------------------------------------------
   TARGET 9 — Gifts and favor requests: an actual road to Allied (docs/improvement-proposals.md):
   the Diplomacy panel now stays visible across the WHOLE stance range (not just Neutral-or-worse
   — gifts/favors are exactly what a comfortably-Cordial-or-better player would use, pushing toward
   Allied), and grows a gift picker (one row per held commodity, engine/diplomacy.js offerGift) and
   a favor-request row (fulfillRequest) alongside the pre-existing, still-conditional tribute button.
   --------------------------------------------------------------------------------------------- */

function setupDiplomacy(seed, stance = 0.35) {
  const { state, cc } = setup(seed);
  state.diplomacy = createDiplomacy();
  state.diplomacy.stance = stance;
  state.market = createMarket(state);
  game.galaxy = { credits: 1e9 };
  return { state, cc };
}

function diplomacyHead() {
  return panelEl.children.find(c => c.tagName === "div" && (c.textContent || "").startsWith("Diplomacy —"));
}
function giftRow(com) {
  return panelEl.querySelectorAll(".market-row").find(r => r.dataset.com === com);
}

test("the Diplomacy panel stays visible even when the neighbour is comfortably Cordial or Allied", () => {
  setupDiplomacy(601, 0.9);   // deep into Allied — the old gate (stance < 0.25) used to hide the whole panel here
  renderSelectionPanel();
  assert.ok(diplomacyHead(), "expected the Diplomacy panel to render regardless of how friendly the neighbour already is");
});

test("the tribute button itself still only shows once the neighbour has cooled to Neutral-or-worse", () => {
  const { state } = setupDiplomacy(602, 0.5);   // Cordial — comfortably at peace
  renderSelectionPanel();
  assert.ok(!findButton("Send tribute"), "no point paying tribute while comfortably cordial");

  state.diplomacy.stance = 0.1;   // Neutral
  renderSelectionPanel();
  assert.ok(findButton("Send tribute"), "the tribute lever reappears once the stance actually cools");
});

test("the gift picker offers a row per held commodity, and gifting deducts stock and raises goodwill", () => {
  const { state } = setupDiplomacy(603, 0.35);
  state.players.player.resources.metals = 100;
  renderSelectionPanel();

  const row = giftRow("metals");
  assert.ok(row, "expected a gift row for the held metals");
  const giftBtn = row.querySelector(".market-btn");
  assert.ok(giftBtn, "expected a Gift button in the row");
  assert.equal(giftBtn.textContent, `Gift ${TRADE_LOT}`);

  const goodwillBefore = state.diplomacy.goodwill || 0;
  giftBtn.click();
  assert.equal(state.players.player.resources.metals, 100 - TRADE_LOT, "the gift left the stockpile");
  assert.ok((state.diplomacy.goodwill || 0) > goodwillBefore, "the gift raised the goodwill pool");
  assert.ok(state.diplomacy.goodwill <= GOODWILL_CAP, "…without exceeding the pool's own cap");
});

test("a commodity short of a full lot gets no gift row", () => {
  const { state } = setupDiplomacy(604, 0.35);
  state.players.player.resources.metals = TRADE_LOT - 1;
  renderSelectionPanel();
  assert.equal(giftRow("metals"), undefined, "nothing to gift below one lot");
});

test("no favor row appears without a pending request", () => {
  setupDiplomacy(605, 0.35);
  renderSelectionPanel();
  assert.ok(!panelEl.querySelector(".favor-progress"), "no live request ⇒ no favor row");
});

test("a pending favor request shows a Fulfill button that pays the reward and clears the request", () => {
  const { state } = setupDiplomacy(606, 0.35);
  state.players.player.resources.ore = 200;
  state.diplomacy.request = { com: "ore", qty: 50, until: state.time + 60, reward: 321 };
  renderSelectionPanel();

  const progress = panelEl.querySelector(".favor-progress");
  assert.ok(progress, "expected a live favor-progress row");
  assert.equal(progress.textContent, "⭐ Favor requested — 60s left");

  const btn = findButton("Fulfill:");
  assert.ok(btn, "expected a Fulfill button");
  assert.ok(!btn.classList.contains("disabled"), "affordable ⇒ not locked");

  const creditsBefore = game.galaxy.credits;
  btn.click();
  assert.equal(state.players.player.resources.ore, 150, "the exact requested qty is deducted");
  assert.equal(game.galaxy.credits, creditsBefore + 321, "the reward is paid");
  assert.ok(!panelEl.querySelector(".favor-progress"), "the favor row disappears once fulfilled");
});

test("the Fulfill button is disabled and inert without enough stock to cover the ask", () => {
  const { state } = setupDiplomacy(607, 0.35);
  state.players.player.resources.ore = 10;   // short of the 50 asked
  state.diplomacy.request = { com: "ore", qty: 50, until: state.time + 60, reward: 321 };
  renderSelectionPanel();

  const btn = findButton("Fulfill:");
  assert.ok(btn, "expected a Fulfill button even though it's locked");
  assert.ok(btn.classList.contains("disabled"));

  const creditsBefore = game.galaxy.credits;
  btn.click();
  assert.equal(state.players.player.resources.ore, 10, "a locked Fulfill click must never spend stock");
  assert.equal(game.galaxy.credits, creditsBefore, "…or pay out a reward");
});

test("the favor countdown live-patches across an unrelated renderSelectionPanel tick", () => {
  const { state } = setupDiplomacy(608, 0.35);
  state.players.player.resources.ore = 200;
  state.time = 0;
  state.diplomacy.request = { com: "ore", qty: 50, until: 60, reward: 321 };
  renderSelectionPanel();
  const before = panelEl.querySelector(".favor-progress").textContent;

  state.time = 30;   // 30s closer to the deadline — nothing else about the selection changed
  renderSelectionPanel();
  const after = panelEl.querySelector(".favor-progress").textContent;
  assert.notEqual(after, before, "the countdown must not freeze at whatever it read on the panel's last rebuild");
});

/* ---------------------------------------------------------------------------------------------
   TARGET 10 — the reported bug: refreshMarketRows (hudSelection.js) scoped its live-patch sweep
   to `.market-row` alone, a layout class reused far beyond actual Market rows — a Bulk
   Freighter's cargo panel (renderFreight) borrows it purely for the shared flexbox spacing, with
   no `data-com` of its own (only a REAL market row sets that, in renderMarket). The very next
   renderSelectionPanel() tick after selecting a freighter called marketRowFields(state,
   undefined) against every one of its cargo rows and stamped "undefined ◈NaN" over the correct
   "<Commodity> · <N> aboard" label — reported against a live save, reproduced by loading it into
   a running build and screenshotting the panel. The fix: skip any `.market-row` without a real,
   catalog-known `data-com`.
   --------------------------------------------------------------------------------------------- */

test("a freighter's cargo row survives an unrelated renderSelectionPanel tick without turning into 'undefined ◈NaN'", () => {
  const { state } = setup(401);
  const freighter = makeUnit("bulkfreighter", "player", 500, 500);
  freighter.freight = { electronics: 1600 };
  state.units.set(freighter.id, freighter);
  state.selection = [freighter.id];
  game.galaxy = { credits: 1e9 };
  state.market = createMarket(state);

  renderSelectionPanel();
  const cargoRow = panelEl.querySelectorAll(".market-row")
    .find(r => r.querySelector(".market-com")?.textContent.includes("Electronics"));
  assert.ok(cargoRow, "expected a cargo row labelled with the aboard commodity");
  const labelBefore = cargoRow.querySelector(".market-com").textContent;
  assert.match(labelBefore, /Electronics.*1600.*aboard/i, "sanity: the row reads name + quantity, not a market price");

  renderSelectionPanel();   // an ordinary tick — nothing about the selection changed
  const labelAfter = cargoRow.querySelector(".market-com").textContent;
  assert.equal(labelAfter, labelBefore,
    "an unrelated tick must not touch a freighter cargo row at all — it has no data-com to live-patch, " +
    "and the pre-fix bug was refreshMarketRows silently overwriting it with 'undefined ◈NaN' anyway");
});

/* ---------------------------------------------------------------------------------------------
   A6 — the rebuild signature must WATCH every panel it draws. renderSelectionPanel returns early
   unless its 141-line signature string changed, so a panel whose state contributes no term to that
   string never redraws: its buttons mutate the sim and the UI stays frozen on the old value, which
   reads as a no-op and invites the player to click again and silently toggle the change back. Two
   whole Odyssey panel families were in that state — Freight Lanes and Colony Policy.
   --------------------------------------------------------------------------------------------- */

function setupOdyssey(seed = 61) {
  resetSelectionSignature();
  const g = jumpReadyGalaxy(seed);
  const state = activeState(g);
  game.state = state;
  game.transport = createDirectTransport(state);   // same reasoning as setup() above
  game.galaxy = g;
  game.input = { building: null, attackArmed: false, focusIdleWorker() {}, selectAllArmy() {} };
  game.collapsedSections = new Set();
  game.hotkeyActions = [];
  const cc = [...state.buildings.values()].find(b => b.type === "command" && b.owner === "player");
  state.selection = [cc.id];
  return { g, state, cc };
}

test("changing a Freight Lane's commodities rebuilds the panel (A6)", () => {
  const { g, state } = setupOdyssey();
  const dest = liveWorld(g);
  const lane = createLane(g, g.activeId, dest, ["ore"]);
  assert.ok(lane, "fixture sanity: a lane was created");

  renderSelectionPanel();
  const before = [...panelEl.children];
  lane.commodities.push("metals");                       // exactly what a commodity chip's click does
  renderSelectionPanel();
  assert.ok(!sameNodes([...panelEl.children], before),
    "a lane's commodity filter changed, so the panel must redraw — otherwise the ✓/— never flips");
});

test("creating a new Freight Lane rebuilds the panel (A6)", () => {
  const { g } = setupOdyssey(62);
  const dest = liveWorld(g);
  renderSelectionPanel();
  const before = [...panelEl.children];
  createLane(g, g.activeId, dest, []);                   // exactly what "+ New Lane" does
  renderSelectionPanel();
  assert.ok(!sameNodes([...panelEl.children], before),
    "a brand-new lane must appear — an empty one perturbs nothing else the signature watches");
});

test("changing a colony's standing orders rebuilds the panel (A6)", () => {
  const { g, state } = setupOdyssey(63);
  renderSelectionPanel();
  const before = [...panelEl.children];
  setColonyPolicy(g, state.planetId, { autoSell: { enabled: true, floors: {} }, workerTarget: 3 });
  renderSelectionPanel();
  assert.ok(!sameNodes([...panelEl.children], before),
    "Auto-sell gates a whole sub-section, so toggling it must redraw or the floor rows never appear");
});

test("a specialty unit stays offered once its commodity is in the treasury, even with no local node (A10)", () => {
  // The HUD reimplemented availability as "every cost commodity has a local node" — a rule the
  // engine does not have. queueProduction checks produces/odysseyOnly/prereqsMet/canAfford/supply,
  // and the engine's OWN equivalent (market.tradeables) is the same predicate one clause longer:
  // `present.has(c) || (res[c] || 0) > 0`. The HUD's copy had dropped the "or you hold some" half,
  // so shipping gas to a gas-free world made the Wraith button vanish rather than grey out.
  const { state } = setupOdyssey(64);
  const gasUnit = "wraith";
  const gasCost = Object.keys(UNITS[gasUnit].cost).find(c => !state.map.nodes.some(n => n.com === c));
  assert.ok(gasCost, `fixture sanity: ${gasUnit} needs a commodity this world has no node for`);

  const barracks = makeBuilding("barracks", "player", 700, 500);
  barracks.constructing = false;
  state.buildings.set(barracks.id, barracks);
  state.selection = [barracks.id];

  state.players.player.resources[gasCost] = 0;
  resetSelectionSignature();
  renderSelectionPanel();
  assert.equal(findButton(`Produce ${UNITS[gasUnit].name}`), undefined,
    "with neither a node nor any stock it stays hidden, as before");

  state.players.player.resources[gasCost] = UNITS[gasUnit].cost[gasCost] * 4;
  resetSelectionSignature();
  renderSelectionPanel();
  assert.ok(findButton(`Produce ${UNITS[gasUnit].name}`),
    "holding the commodity must offer the unit — the engine would accept the order");
});

/* ---- T2: a completeness meta-test over every interactive panel ------------------------------
   A6 patched the two panels that were provably dead. This is the general net: a panel whose own
   state contributes NO term to the rebuild signature never redraws, and the failure is silent —
   the control reads as a no-op and a second click undoes the first. Table-driven so a new panel
   family is one row, not a rediscovery. */

const PANEL_MUTATIONS = [
  ["lane commodities", g => { const l = g.lanes[0] || createLane(g, g.activeId, liveWorld(g), ["ore"]); l.commodities.push("metals"); }],
  ["lane membership", g => { const l = g.lanes[0] || createLane(g, g.activeId, liveWorld(g), ["ore"]); l.shipIds.push("u-not-real"); }],
  ["new lane", g => createLane(g, g.activeId, liveWorld(g), [])],
  ["colony auto-sell", (g, st) => setColonyPolicy(g, st.planetId, { autoSell: { enabled: true, floors: {} }, workerTarget: 2 })],
  ["colony worker target", (g, st) => setColonyPolicy(g, st.planetId, { autoSell: { enabled: false, floors: {} }, workerTarget: 5 })],
];

for (const [name, mutate] of PANEL_MUTATIONS) {
  test(`the panel rebuilds when ${name} changes (T2 completeness)`, () => {
    const { g, state } = setupOdyssey(70);
    renderSelectionPanel();
    const before = [...panelEl.children];
    mutate(g, state);
    renderSelectionPanel();
    assert.ok(!sameNodes([...panelEl.children], before),
      `${name} changed the simulation but the panel didn't redraw — its controls read as no-ops`);
  });
}

test("every unit in BUILDINGS[type].produces gets a produce button on that building's panel (T2)", () => {
  // The rosters were copied out of engine/entities.js into three different hand-maintained shapes
  // in the HUD — two identical literals and one pair of unrolled blocks — while the ENGINE already
  // owns and enforces the list (queueProduction refuses anything not in `produces`). Adding a unit
  // to a building's roster therefore made it buildable by the engine and by the AI, but invisible
  // in the UI, with nothing failing. The Odyssey gate was duplicated DIFFERENTLY too: the engine
  // gates per-unit on `def.odysseyOnly && !state.endless` while the HUD hand-split the array.
  const { state } = setupOdyssey(71);
  for (const type of ["command", "barracks", "stardock"]) {
    const b = makeBuilding(type, "player", 700, 500);
    b.constructing = false;
    state.buildings.set(b.id, b);
    state.selection = [b.id];
    resetSelectionSignature();
    renderSelectionPanel();
    for (const t of BUILDINGS[type].produces || []) {
      // Two legitimate reasons a produced unit isn't offered, both engine rules rather than HUD
      // opinions: it's Odyssey-only in a skirmish (queueProduction's own gate), or this world can
      // neither mine nor stock one of its cost commodities (commodityAvailable — a forever-greyed
      // button helps nobody). Everything else must be on the panel.
      const def = UNITS[t];
      if (def.odysseyOnly && !state.endless && !game.galaxy) continue;
      if (!Object.keys(def.cost).every(c => commodityAvailable(state, "player", c))) continue;
      assert.ok(findButton(`Produce ${def.name}`),
        `${type}'s panel is missing a button for ${t}, which BUILDINGS.${type}.produces lists ` +
        `and queueProduction would accept`);
    }
    state.buildings.delete(b.id);
  }
});
