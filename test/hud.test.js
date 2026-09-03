import { test } from "node:test";
import assert from "node:assert/strict";
import * as sound from "../sound.js";
import { createGameState, makeBuilding } from "../engine/state.js";
import { mulberry32 } from "../engine/rng.js";
import { DEFAULT_MATCH_TIME_LIMIT } from "../engine/victory.js";
import { installFakeDom, fakeCtx } from "./_dom.js";

/* ============================================================
   hud.js's endgame clock (docs/improvement-proposals.md "Make the clock endgame visible, honest,
   and configurable"): inside the final 5 minutes of a skirmish's score-decision clock, renderHUD
   flips #matchClock from elapsed time to a countdown and shows a compact two-sided score bar
   (playerScore(state,"player"/"ai")) — the score is otherwise completely invisible in-game, per
   the proposal's own Problem statement.

   renderHUD has no dedicated test file today. The DOM setup is the shared harness in
   test/_dom.js (see its header for why each piece exists, and test/hudSelection.test.js's for
   the full empirical trace of the import-order constraint). hud.js imports hudSelection.js
   directly (renderSelectionPanel), so the exact same transitive graph (render.js, boot.js,
   engine/*, …) has to import cleanly under Node. `context: fakeCtx` because renderSelectionPanel's
   icon buttons run render.js's spriteIcon, which needs a live 2D context and a toDataURL.
   ============================================================ */

installFakeDom({ context: fakeCtx });
// `window` deliberately left undefined, same reasoning as hudSelection.test.js/overlays.test.js:
// every `typeof window !== "undefined"` guard in the imported graph stays off, so no real
// timer/listener starts on import.

sound.setMuted(true);   // renderSelectionPanel's icon buttons can synthesize a blocked-click buzz; keep it silent and AudioContext-free

const { game } = await import("../session.js");
const { renderHUD, resetPanelSignature } = await import("../hud.js");
const { resourcesEl, clockEl, scoreBarEl, idleProductionEl, gateChipEl, canvas } = await import("../dom.js");

function setup(seed, opts = {}) {
  resetPanelSignature();
  const state = createGameState({ planetId: "ferros", seed, rng: mulberry32(seed), ...opts });
  game.state = state;
  game.galaxy = null;
  game.input = { building: null, attackArmed: false, focusIdleWorker() {}, focusIdleProducer() {}, selectAllArmy() {}, groupCounts: () => [] };
  game.supplyBlockedUntil = 0;
  state.selection = [];
  return state;
}

test("renderHUD: outside the final 5 minutes, the clock shows plain elapsed time and the score bar stays hidden", () => {
  const state = setup(401);
  state.time = 120;   // 2:00 elapsed, nowhere near the 40-minute default's final 5

  renderHUD();

  assert.equal(clockEl.textContent, "2:00");
  assert.equal(scoreBarEl.classList.contains("hidden"), true, "the score bar only appears once the endgame window opens");
});

test("renderHUD: inside the final 5 minutes, the clock flips to a countdown and the score bar shows both sides' scores", () => {
  const state = setup(402);
  state.time = DEFAULT_MATCH_TIME_LIMIT - 60;   // exactly 1:00 left on the default 40-minute clock

  renderHUD();

  assert.equal(clockEl.textContent, "-1:00", "a countdown, not elapsed time, once inside the final 5 minutes");
  assert.equal(scoreBarEl.classList.contains("hidden"), false);
  assert.match(scoreBarEl.textContent, /\d+/, "the score bar should show at least one numeric score");
});

test("renderHUD: a WATCHED match names both entrants in the score bar — there is no \"you\" in it", () => {
  // Phase 5's spectator drives BOTH seats with the real AI, so the first-person endgame copy
  // ("You 400 · AI 380") addresses a commander who isn't playing. game.spectateMatch carries the
  // two entrant names; it's null in every ordinary game, so the human-facing copy is untouched.
  const state = setup(404);
  state.time = DEFAULT_MATCH_TIME_LIMIT - 60;
  game.spectateMatch = { aName: "Blitz", bName: "Bulwark" };
  try {
    renderHUD();
    assert.match(scoreBarEl.textContent, /Blitz/, "the owner-\"player\" seat is named, not called You");
    assert.match(scoreBarEl.textContent, /Bulwark/, "the owner-\"ai\" seat is named too");
    assert.doesNotMatch(scoreBarEl.textContent, /\bYou\b/, "nobody watching a match is a side in it");
  } finally {
    game.spectateMatch = null;
  }
  // …and with no spectated match the original first-person copy is exactly as it was.
  renderHUD();
  assert.match(scoreBarEl.textContent, /\bYou\b/, "an ordinary match still addresses the player directly");
});

test("T-031: the score bar shows a real chosen opponent name, once one is on record, instead of the generic \"Opponent\" fallback", () => {
  const state = setup(405);
  state.time = DEFAULT_MATCH_TIME_LIMIT - 60;
  game.seatNames = { ai: "Commander Vex" };
  try {
    renderHUD();
    assert.match(scoreBarEl.textContent, /Commander Vex/, "session.js's seatDisplayName must be consulted, not a hardcoded \"Opponent\"");
    assert.doesNotMatch(scoreBarEl.textContent, /\bOpponent\b/);
  } finally { game.seatNames = {}; }
});

test("renderHUD: the countdown respects a matchTimeLimit override, not just the 40-minute default", () => {
  const state = setup(403, { matchTimeLimit: 1200 });   // "Quick 20"
  state.time = 1200 - 30;   // 0:30 left on the SHORT override

  renderHUD();

  assert.equal(clockEl.textContent, "-0:30",
    "the override, not DEFAULT_MATCH_TIME_LIMIT, decides when the endgame window opens");
});

test("renderHUD: right at the 5-minute mark the clock is already a countdown; a second earlier it is still elapsed time", () => {
  const state = setup(404);

  state.time = DEFAULT_MATCH_TIME_LIMIT - 301;   // 5:01 left — just outside the window (34:59 elapsed)
  renderHUD();
  assert.equal(clockEl.textContent, "34:59", "5:01 remaining is still outside the final-5-minutes window");
  assert.equal(scoreBarEl.classList.contains("hidden"), true);

  state.time = DEFAULT_MATCH_TIME_LIMIT - 300;   // exactly 5:00 left — the boundary itself
  renderHUD();
  assert.equal(clockEl.textContent, "-5:00", "5:00 remaining is the boundary — inside the window");
  assert.equal(scoreBarEl.classList.contains("hidden"), false);
});

test("renderHUD: Odyssey (a galaxy in play) never shows the countdown/score bar, even at a huge elapsed time — there is no clock to count down to", () => {
  const state = setup(405, { endless: true });
  game.galaxy = {};   // only truthiness matters to hud.js's own Odyssey gate elsewhere in this file
  state.time = 100000;   // absurdly long — would be deep past any skirmish time limit

  renderHUD();

  assert.equal(scoreBarEl.classList.contains("hidden"), true, "the open-world sandbox has no timeout-score tiebreak to warn about");
  assert.doesNotMatch(clockEl.textContent, /^-/, "never a countdown for a mode with no clock at all");
});

/* ============================================================
   Idle-production topbar chip (docs/improvement-proposals.md "Space cycles bases and an
   idle-production topbar chip"): counts completed player production buildings
   (BUILDINGS[type].produces, !constructing, queue.length === 0) next to the idle-worker loop —
   multiple Barracks are normal mid-game, and an empty queue on one you aren't looking at is
   otherwise invisible.
   ============================================================ */

test("renderHUD: the idle-production chip already reads '1 idle' at kickoff — the seeded, empty-queue Command Center counts", () => {
  const state = setup(410);

  renderHUD();

  assert.equal(idleProductionEl.textContent, "🏭 1 idle");
  assert.equal(idleProductionEl.classList.contains("hidden"), false);

  // Queue something on it — the only producer in a fresh skirmish — and the chip hides at zero.
  const cc = [...state.buildings.values()].find(b => b.owner === "player" && b.type === "command");
  cc.queue.push({ unitType: "worker", progress: 0 });
  renderHUD();

  assert.equal(idleProductionEl.classList.contains("hidden"), true, "a non-empty queue takes the only producer out of the idle count");
});

test("renderHUD: the idle-production count only includes finished buildings that actually produce something", () => {
  const state = setup(411);
  const cc = [...state.buildings.values()].find(b => b.owner === "player" && b.type === "command");
  cc.queue.push({ unitType: "worker", progress: 0 });   // no longer idle — isolate the count to what's added below

  const idleBarracks = makeBuilding("barracks", "player", 200, 200);
  state.buildings.set(idleBarracks.id, idleBarracks);   // produces, completed, empty queue -> counts

  const constructingBarracks = makeBuilding("barracks", "player", 260, 200, { constructing: true });
  state.buildings.set(constructingBarracks.id, constructingBarracks);   // still constructing -> must not count

  const refinery = makeBuilding("refinery", "player", 320, 200);
  state.buildings.set(refinery.id, refinery);   // no `produces` (it researches upgrades) -> must not count

  renderHUD();

  assert.equal(idleProductionEl.textContent, "🏭 1 idle", "only the finished, empty-queue Barracks counts");
  assert.equal(idleProductionEl.classList.contains("hidden"), false);
});

/* ============================================================
   Persistent Antimatter Gate charge strip (docs/improvement-proposals.md lines 745-753): today
   the Gate's charge is visible only in boot.js's 25%-milestone toasts or by keeping the Gate
   itself selected in hudSelection.js's own wonder panel — invisible while the player is off
   defending the waves a charging Gate provokes (per CHANGELOG), and a stall (starved feed goods
   or throttled Power) is completely silent. renderHUD now finds the player's wonder-flagged
   building — gated on game.galaxy only, the same Odyssey idiom the power readout above already
   uses — and renders a slim persistent chip: percentage + color tier warming with progress,
   flipping to a "stalled" state when charge hasn't advanced since the last tick observed it.
   Clicking it centers the camera on the Gate, mirroring boot.js's underAttackEl click handler.
   ============================================================ */

// A player (or rival) wonder-flagged building, at a chosen charge. `charge` left undefined
// leaves `building.charge` completely unset — exactly what engine/wonder.js's updateWonder
// itself leaves a just-completed Gate with, before anything has fed it a first tick of progress.
function addGate(state, owner, charge, opts = {}) {
  const gate = makeBuilding("antimatter_gate", owner, opts.x ?? 400, opts.y ?? 300, opts);
  if (charge !== undefined) gate.charge = charge;
  state.buildings.set(gate.id, gate);
  return gate;
}

test("renderHUD: no gate chip in a skirmish — gated on game.galaxy only, even with a wonder-flagged building present", () => {
  const state = setup(420);   // setup()'s own default leaves game.galaxy null
  addGate(state, "player", 0.5);

  renderHUD();

  assert.equal(gateChipEl.classList.contains("hidden"), true);
});

test("renderHUD: no gate chip in an Odyssey with no player-owned wonder", () => {
  setup(421);
  game.galaxy = {};

  renderHUD();

  assert.equal(gateChipEl.classList.contains("hidden"), true);
});

test("renderHUD: no gate chip for an AI-owned Gate — the strip watches the player's own clock, not a rival's", () => {
  const state = setup(422);
  game.galaxy = {};
  addGate(state, "ai", 0.5);

  renderHUD();

  assert.equal(gateChipEl.classList.contains("hidden"), true);
});

test("renderHUD: no gate chip while the Gate is still under construction", () => {
  const state = setup(423);
  game.galaxy = {};
  addGate(state, "player", undefined, { constructing: true });

  renderHUD();

  assert.equal(gateChipEl.classList.contains("hidden"), true);
});

test("renderHUD: shows the gate chip with the rounded charge once game.galaxy exists and a player wonder is present", () => {
  const state = setup(424);
  game.galaxy = {};
  addGate(state, "player", 0.417);

  renderHUD();

  assert.equal(gateChipEl.classList.contains("hidden"), false);
  assert.equal(gateChipEl.textContent, "🌀 Gate 42% · provoking neighbours");
});

test('renderHUD: a freshly-completed Gate at exactly 0% charge reads as stalled, not "provoking neighbours"', () => {
  const state = setup(425);
  game.galaxy = {};
  addGate(state, "player", undefined);   // a just-finished Gate: nothing fed into it yet

  renderHUD();

  assert.equal(gateChipEl.textContent, "🌀 Gate 0% · stalled");
  assert.equal(gateChipEl.classList.contains("stalled"), true);
});

test("renderHUD: the gate chip's color tier warms as charge climbs, and drops warm/hot as appropriate", () => {
  const state = setup(426);
  game.galaxy = {};
  const gate = addGate(state, "player", 0.3);

  renderHUD();
  assert.equal(gateChipEl.classList.contains("warm"), false);
  assert.equal(gateChipEl.classList.contains("hot"), false);

  gate.charge = 0.6;
  renderHUD();
  assert.equal(gateChipEl.classList.contains("warm"), true);
  assert.equal(gateChipEl.classList.contains("hot"), false);

  gate.charge = 0.9;
  renderHUD();
  assert.equal(gateChipEl.classList.contains("hot"), true);
  assert.equal(gateChipEl.classList.contains("warm"), false);
});

test("renderHUD: the gate chip is not stalled on the very first sighting of a charging wonder", () => {
  const state = setup(427);
  game.galaxy = {};
  addGate(state, "player", 0.3);

  renderHUD();

  assert.equal(gateChipEl.classList.contains("stalled"), false,
    "no prior tick to compare against yet, so this must not read as a stall");
});

test("renderHUD: the gate chip flips to a stalled state when charge hasn't advanced since the last tick", () => {
  const state = setup(428);
  game.galaxy = {};
  addGate(state, "player", 0.3);

  renderHUD();   // establishes the baseline tick
  renderHUD();   // charge unchanged since that baseline

  assert.equal(gateChipEl.classList.contains("stalled"), true);
  assert.match(gateChipEl.textContent, /stalled/);
});

test("renderHUD: the gate chip stays out of the stalled state while charge keeps climbing tick over tick", () => {
  const state = setup(429);
  game.galaxy = {};
  const gate = addGate(state, "player", 0.3);

  renderHUD();
  gate.charge = 0.35;   // real progress since the last tick
  renderHUD();

  assert.equal(gateChipEl.classList.contains("stalled"), false);
  assert.match(gateChipEl.textContent, /provoking neighbours/);
});

test("renderHUD: a Gate razed and rebuilt starts its own clean stalled comparison instead of reading the dead Gate's last charge", () => {
  const state = setup(430);
  game.galaxy = {};
  const gate = addGate(state, "player", 0.6);
  renderHUD();
  renderHUD();   // the old Gate reads stalled at 60% (two ticks, no change)
  assert.equal(gateChipEl.classList.contains("stalled"), true, "sanity: the old Gate really is showing stalled");

  state.buildings.delete(gate.id);   // razed mid-charge
  addGate(state, "player", 0.02, { x: 500, y: 500 });   // freshly rebuilt, low charge, genuinely advancing
  renderHUD();

  assert.equal(gateChipEl.classList.contains("stalled"), false,
    "a brand-new wonder id must not be judged against the destroyed Gate's final charge");
});

test("renderHUD: the topbar signature guard skips the gate chip too — an unrelated HUD change doesn't force a spurious re-render", () => {
  const state = setup(431);
  game.galaxy = {};
  addGate(state, "player", 0.5);

  renderHUD();   // priming tick: establishes game.lastGateCharge
  renderHUD();   // "before" snapshot -- charge unchanged since the priming tick, so this is already stable
  const before = gateChipEl.textContent;
  assert.ok(before.length > 0);

  gateChipEl.textContent = "SENTINEL";   // stomp — a real rebuild would overwrite this
  state.time += 5;   // an unrelated HUD change (the clock), not part of the topbar signature
  renderHUD();

  assert.equal(gateChipEl.textContent, "SENTINEL",
    "nothing the topbar signature tracks changed, so the chip's DOM must not be touched");
});

test("renderHUD: the topbar signature guard still rebuilds the chip once the tracked charge actually changes", () => {
  const state = setup(432);
  game.galaxy = {};
  const gate = addGate(state, "player", 0.5);

  renderHUD();
  renderHUD();
  gateChipEl.textContent = "SENTINEL";
  gate.charge = 0.7;   // a real, tracked change
  renderHUD();

  assert.notEqual(gateChipEl.textContent, "SENTINEL");
  assert.match(gateChipEl.textContent, /70%/);
});

test("clicking the gate chip centers the camera on the Gate, mirroring boot.js's underAttackEl click handler", () => {
  const state = setup(433);
  game.galaxy = {};
  canvas.clientWidth = 800;
  canvas.clientHeight = 600;
  const cx = state.map.width / 2, cy = state.map.height / 2;
  addGate(state, "player", 0.5, { x: cx, y: cy });
  const camera = { x: 0, y: 0, zoom: 1 };
  game.input.getCamera = () => camera;

  renderHUD();
  gateChipEl.click();

  assert.equal(camera.x, cx);
  assert.equal(camera.y, cy);
});

test("clicking the gate chip when there is no player wonder is a no-op", () => {
  setup(434);
  game.galaxy = {};
  const camera = { x: 111, y: 222, zoom: 1 };
  game.input.getCamera = () => camera;

  renderHUD();   // no wonder -- chip stays hidden
  gateChipEl.click();

  assert.equal(camera.x, 111);
  assert.equal(camera.y, 222);
});

test("clicking the gate chip never throws with no active game", () => {
  game.state = null;
  game.input = null;
  game.galaxy = null;

  assert.doesNotThrow(() => gateChipEl.click());
});

/* ============================================================
   Commodity flow ledger (docs/improvement-proposals.md lines 795-803, "Commodity flow ledger:
   net rates, not just stock levels"): the topbar above shows only absolute stocks, so a player
   can't tell a commodity has gone net-negative until whatever depends on it goes dark (a
   combustor/Reactor runs out of fuel, the Gate stalls). renderHUD now keeps a small ring buffer
   sampling state.players.player.resources on a state.time cadence (~2s, pause-safe — keyed to
   state.time so a paused game, which keeps calling renderHUD every animation frame per boot.js
   while the sim itself is gated off, never advances it), and shows each topbar resource span's
   net rate as a "+X/min" / "-X/min" hover tooltip computed from the buffer's oldest-vs-newest
   sample. A commodity is colored red (the "deficit" class) only when it's BOTH net-negative AND
   something live currently depends on it — a standing (built, non-constructing) fuel-burning
   station, a Plasma Rig's nuclear burn, or the Gate while it's actually charging — never merely
   for being net-negative on its own.

   Zero engine/ involvement: every fixture below drives renderHUD/state.time directly, exactly
   like the endgame-clock and Gate-chip tests above.
   ============================================================ */

test("renderHUD: the flow ledger samples the ring buffer on a ~2s state.time cadence and is pause-safe — resource churn or repeated renders at a frozen state.time never sample; only state.time itself crossing the cadence does", () => {
  const state = setup(501);
  state.time = 0;
  renderHUD();   // the very first sample ever taken: ore=300 @ t=0

  // A paused game keeps calling renderHUD on every animation frame while state.time sits frozen
  // (boot.js: "paused: skip the sim; render still draws the frozen frame"). Hammer that: churn
  // the stock (forcing an ordinary topbar rebuild each time, via the existing stock-floor
  // signature) and re-render repeatedly without ever moving state.time.
  for (let i = 0; i < 10; i++) {
    state.players.player.resources.ore = 290 - i;
    renderHUD();
  }
  let oreSpan = resourcesEl.children.find(el => el.dataset.com === "ore");
  assert.match(oreSpan.title, /\+0\/min/,
    "state.time never moved, so the ledger still holds only its first-ever sample — nothing to compare against yet, no matter how many times renderHUD ran or the stock changed");

  // Short of the ~2s cadence: still no second sample.
  state.time = 1.9;
  state.players.player.resources.ore = 150;
  renderHUD();
  oreSpan = resourcesEl.children.find(el => el.dataset.com === "ore");
  assert.match(oreSpan.title, /\+0\/min/, "1.9s of state.time is short of the ~2s sampling cadence");

  // Crossing the cadence takes the second sample, using the CURRENT stock at that instant.
  state.time = 2;
  state.players.player.resources.ore = 100;
  renderHUD();
  oreSpan = resourcesEl.children.find(el => el.dataset.com === "ore");
  assert.match(oreSpan.title, /-6000\/min/,
    "(100 - 300) ore over 2s of state.time, extrapolated to a per-minute rate");
});

test("renderHUD: the resource tooltip shows the correct net rate, computed from the ring buffer's oldest-vs-newest sample", () => {
  const state = setup(502);
  state.time = 0;
  state.players.player.resources.crystals = 40;   // crystals starts at 0 — give it a real stock to track
  renderHUD();   // sample #1: crystals=40 @ t=0

  state.time = 10;
  state.players.player.resources.crystals = 90;   // +50 crystals over 10s of state.time
  renderHUD();   // sample #2

  const crystalSpan = resourcesEl.children.find(el => el.dataset.com === "crystals");
  assert.equal(crystalSpan.title, "Crystals · +300/min", "(90 - 40) crystals over 10s of state.time = +300/min");
});

test("renderHUD: a net-negative resource is colored only when something live currently depends on it, not every net-negative commodity", () => {
  const state = setup(510);
  state.time = 0;
  state.players.player.resources.radioactives = 100;
  state.players.player.resources.crystals = 100;   // also net-negative below, but nothing ever depends on crystals
  renderHUD();

  state.time = 2;
  state.players.player.resources.radioactives = 80;
  state.players.player.resources.crystals = 80;
  renderHUD();

  let radSpan = resourcesEl.children.find(el => el.dataset.com === "radioactives");
  let crystalSpan = resourcesEl.children.find(el => el.dataset.com === "crystals");
  assert.match(radSpan.title, /-600\/min/);
  assert.equal(radSpan.classList.contains("deficit"), false, "net-negative, but no live consumer standing yet");
  assert.equal(crystalSpan.classList.contains("deficit"), false, "net-negative, and crystals is never a combust/rig/wonder input");

  // Stand up a live consumer of radioactives — a completed, non-constructing Reactor burns it
  // (engine/entities.js BUILDINGS.reactor.combust).
  const reactor = makeBuilding("reactor", "player", 500, 500);
  state.buildings.set(reactor.id, reactor);

  state.time = 4;
  state.players.player.resources.radioactives = 60;
  state.players.player.resources.crystals = 60;
  renderHUD();

  radSpan = resourcesEl.children.find(el => el.dataset.com === "radioactives");
  crystalSpan = resourcesEl.children.find(el => el.dataset.com === "crystals");
  assert.equal(radSpan.classList.contains("deficit"), true, "still net-negative, and now a standing Reactor depends on it");
  assert.equal(crystalSpan.classList.contains("deficit"), false, "still no live consumer for crystals");
});

test("renderHUD: a fuel-burning station still under construction is not a live consumer yet", () => {
  const state = setup(511);
  state.time = 0;
  state.players.player.resources.radioactives = 100;
  renderHUD();

  const reactor = makeBuilding("reactor", "player", 500, 500, { constructing: true });
  state.buildings.set(reactor.id, reactor);

  state.time = 2;
  state.players.player.resources.radioactives = 80;
  renderHUD();

  const radSpan = resourcesEl.children.find(el => el.dataset.com === "radioactives");
  assert.match(radSpan.title, /-600\/min/);
  assert.equal(radSpan.classList.contains("deficit"), false, "a building site isn't burning fuel yet");
});

test("renderHUD: a Plasma Rig's nuclear burn makes radioactives count as live-consumed too", () => {
  const state = setup(512);
  state.time = 0;
  state.players.player.resources.radioactives = 100;
  renderHUD();

  const rig = makeBuilding("plasmarig", "player", 500, 500);
  state.buildings.set(rig.id, rig);

  state.time = 2;
  state.players.player.resources.radioactives = 80;
  renderHUD();

  const radSpan = resourcesEl.children.find(el => el.dataset.com === "radioactives");
  assert.equal(radSpan.classList.contains("deficit"), true, "a standing Rig's nuclear-to-exploit cost also depends on radioactives");
});

test('renderHUD: the Gate only counts as a live consumer of its feed goods once it is actually charging, not the instant it completes at 0% — mirrors this file\'s own gateStalled "0% is not yet charging" rule', () => {
  const state = setup(513);
  state.time = 0;
  state.players.player.resources.antimatter = 100;
  renderHUD();

  const gate = makeBuilding("antimatter_gate", "player", 500, 500);   // charge left unset -> 0%, freshly completed
  state.buildings.set(gate.id, gate);

  state.time = 2;
  state.players.player.resources.antimatter = 80;
  renderHUD();

  let anteSpan = resourcesEl.children.find(el => el.dataset.com === "antimatter");
  assert.equal(anteSpan.classList.contains("deficit"), false, "a Gate sitting at exactly 0% hasn't drawn a drop of antimatter yet");

  gate.charge = 0.3;   // now genuinely mid-charge
  state.time = 4;
  state.players.player.resources.antimatter = 60;
  renderHUD();

  anteSpan = resourcesEl.children.find(el => el.dataset.com === "antimatter");
  assert.equal(anteSpan.classList.contains("deficit"), true, "the Gate is genuinely charging now, drawing down its feed goods");
});

test("renderHUD: a net-POSITIVE resource is never colored red, even with a live consumer standing", () => {
  const state = setup(514);
  state.time = 0;
  state.players.player.resources.radioactives = 20;
  renderHUD();

  const reactor = makeBuilding("reactor", "player", 500, 500);
  state.buildings.set(reactor.id, reactor);

  state.time = 2;
  state.players.player.resources.radioactives = 40;   // climbing, not draining
  renderHUD();

  const radSpan = resourcesEl.children.find(el => el.dataset.com === "radioactives");
  assert.match(radSpan.title, /\+600\/min/);
  assert.equal(radSpan.classList.contains("deficit"), false, "gaining stock is never a shortage warning, regardless of who depends on it");
});

test("renderHUD: the topbar signature guard still skips the resource row when nothing tracked changed — taking a new flow-ledger sample does not itself force a rebuild", () => {
  const state = setup(520);
  state.time = 0;
  renderHUD();   // priming sample
  renderHUD();   // "before" snapshot -- already stable, nothing changed since the priming tick

  const oreSpan = resourcesEl.children.find(el => el.dataset.com === "ore");
  assert.ok(oreSpan);
  oreSpan.textContent = "SENTINEL";   // stomp -- a real rebuild would overwrite this

  // Cross a whole ~2s flow-ledger sampling cadence with every displayed value held exactly
  // constant. If sampling were folded into the topbar's signature, this alone would force a
  // rebuild and wipe the sentinel.
  state.time = 5;
  renderHUD();

  assert.equal(oreSpan.textContent, "SENTINEL",
    "nothing the topbar signature tracks changed — taking a new ring-buffer sample must not perturb it");
});

test("renderHUD: the topbar signature guard still rebuilds the resource row once a tracked stock actually changes, with the ledger folded in", () => {
  const state = setup(521);
  state.time = 0;
  renderHUD();
  renderHUD();

  // Unlike gateChipEl (a single persistent node patched in place), the resource row is torn down
  // and rebuilt wholesale (resourcesEl.innerHTML = "" + fresh createElement) on a real rebuild —
  // so the proof is a FRESH node replacing the stomped one, not the same node mutating in place.
  const before = resourcesEl.children.find(el => el.dataset.com === "ore");
  before.textContent = "SENTINEL";
  state.players.player.resources.ore = 301;   // a real, tracked change (the stock's floor moves)
  renderHUD();

  const after = resourcesEl.children.find(el => el.dataset.com === "ore");
  assert.notEqual(after, before, "a real stock change must rebuild the resource row with fresh nodes");
  assert.notEqual(after.textContent, "SENTINEL");
});
