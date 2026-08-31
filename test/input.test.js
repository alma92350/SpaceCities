import { test } from "node:test";
import assert from "node:assert/strict";
import * as sound from "../sound.js";
import { makeUnit, makeBuilding } from "../engine/state.js";
import { createFog, FOG_CELL_SIZE } from "../engine/fog.js";
import { game } from "../session.js";   // control groups + hotkeyActions live here, not on `state` — see setup()
import { createDirectTransport } from "../net/directTransport.js";
import { createFaultyTransport } from "../net/loopbackFaults.js";

// input.js is one big attachInput() closure that wires real DOM listeners (canvas +
// window), so exercising it under plain `node --test` (no browser, no jsdom — see
// package.json's zero-dependency `test` script) means giving it just enough of a DOM to be
// indistinguishable from the real thing for these three bugs. Node's own EventTarget/
// Event/AbortController are WHATWG-compliant (including the `{ signal }` auto-removal
// input.js relies on for teardown), so a canvas/window built ON them behaves exactly like
// the browser objects input.js expects — no fake dispatch bookkeeping needed. Verified
// empirically (not assumed): Node's EventTarget really does drop a listener once its
// AbortSignal fires, and dispatchEvent really does set event.target to the dispatching
// object, both load-bearing for the tests below.
//
// sound.js's tone() unconditionally calls window.AudioContext when unmuted; nothing here
// stubs an AudioContext, so sound is muted up front — commandAt()/applyBoxSelection() etc.
// still run their sound.playOrder()/playSelect() calls, they just no-op past `if (muted)
// return;` before ever touching window.AudioContext.
sound.setMuted(true);

// input.js's keydown handler reads the bare global `document.body` as part of its
// focused-control guard, but only past its `t &&` (e.target) short-circuit. Every event
// dispatched below that reaches that handler is dispatched straight on the fake `window`,
// and per the WHATWG dispatch algorithm that makes `event.target` that same window object
// — truthy — so the guard does go on to read `document.body`.
//
// The touch handlers separately call onTouchActive(), which flips document.body into "touch
// mode" (bigger tap targets, the touch HUD legend) via .classList.contains()/.add() on first
// real touch — so the stub grows a `classList` mirroring FakeCanvas's own below, still every
// method a harmless no-op/false.
//
const VW = 800, VH = 600;

// getElementById: input.js now imports observer.js (Observer Mode delegation), which imports
// dom.js for `canvas` — dom.js resolves EVERY one of its exports via getElementById at ITS
// OWN module-load time (same constraint test/starmap.test.js's header comment documents),
// so it must exist and return something non-null for every id before that import chain runs,
// even though most of this file's own tests never touch it. A couple of Observer Mode tests
// below DO exercise observer.js's camera clamping through this very stub, so it needs a real
// clientWidth/clientHeight (matching FakeCanvas's own below) — without them clampCamera divides
// by undefined and silently NaNs the camera position instead of throwing.
class FakeDomEl extends EventTarget {
  constructor() {
    super();
    this.classList = { toggle() {}, add() {}, remove() {}, contains() { return false; } };
    this.style = {};
    this.clientWidth = VW;
    this.clientHeight = VH;
  }
  getContext() { return {}; }   // dom.js's context2d() calls this on the canvas/minimap elements
}
globalThis.document = {
  body: { classList: { contains() { return false; }, add() {}, remove() {}, toggle() {} } },
  getElementById() { return new FakeDomEl(); },
};

const { attachInput } = await import("../input.js");

// Stands in for the real HTMLCanvasElement: a real EventTarget (so addEventListener /
// dispatchEvent / the `{ signal }` teardown all behave exactly like the browser) plus the
// handful of extra properties/methods input.js actually reads off it.
class FakeCanvas extends EventTarget {
  constructor() {
    super();
    this.clientWidth = VW;
    this.clientHeight = VH;
    this.classList = { toggle() {}, add() {}, remove() {}, contains() { return false; } };
  }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
}

// Ditto for `window` — input.js reads the bare global identifier, so each test points
// globalThis.window at its own fresh instance before calling attachInput.
class FakeWindow extends EventTarget {}

function ev(type, props = {}) {
  const e = new Event(type, { cancelable: true });
  Object.assign(e, props);
  return e;
}

// A large, empty, all-unrevealed map centred at (2000, 2000) — plenty of room to pan or
// place a click without clampCamera's edges ever getting involved.
//
// `players` is a minimal stand-in for engine/state.js's own createGameState shape — enough for
// canAfford/payCost/prereqsMet (engine/entities.js), which issueBuild always reads regardless of
// what's actually being built. Every other test in this file never touches it; only the
// build-placement test below (transport.submitCommand({t:"build",...})) needs it for real.
function makeState() {
  const map = { width: 4000, height: 4000, nodes: [], bases: {} };
  const players = {
    player: { resources: { ore: 99999, crystals: 99999, radioactives: 99999 }, upgrades: {} },
    ai: { resources: { ore: 99999, crystals: 99999, radioactives: 99999 }, upgrades: {} },
  };
  return { map, units: new Map(), buildings: new Map(), selection: [], fog: createFog(map), planetId: "test", players };
}

function reveal(fog, x, y) {
  const cx = Math.floor(x / FOG_CELL_SIZE), cy = Math.floor(y / FOG_CELL_SIZE);
  fog.visible[cy * fog.cols + cx] = 1;
}

// Fresh canvas/window/state/controller for one test, plus an onChange call counter.
// commandAt/setArmed/etc. don't pass onChange any arguments worth asserting on — only
// whether, and how often, it fired.
// `wrapTransport` (default: identity) lets one test swap in a fault-injecting transport
// (net/loopbackFaults.js, T-013) around the same bare fixture state, to prove the async call
// sites here don't secretly depend on a same-tick reply — every other call site keeps passing
// the plain, always-synchronous-underneath directTransport unchanged.
function setup(wrapTransport = t => t) {
  globalThis.window = new FakeWindow();
  const canvas = new FakeCanvas();
  const state = makeState();
  // Control groups (keyboard digits) and the positional-hotkey action list both live on the
  // shared `game` singleton (session.js), not on `state` — see input.js's groups()/game.hotkeyActions
  // reads. That object survives across every test in this file (it's the same module-cached
  // import each time), so without a reset a group bound in one test — or a stubbed
  // hotkeyActions array — would silently leak into the next one, which always reuses the same
  // "test" planetId. Fresh empty state, every time.
  game.groups[state.planetId] = {};
  game.hotkeyActions = null;
  game.lastAttackAt = null;   // Backspace jump-to-last-alert reads this live off the shared session
  let calls = 0;
  // input.js now issues every command as a net/commandShapes.js WireCommand over a Transport
  // (T-012) instead of calling engine/commands.js directly — this bare fixture `state` has no
  // server/session.js session behind it (nothing here needs ownership/fog validation or a real
  // match loop), so net/directTransport.js's adapter is exactly what boot.js itself falls back to
  // for the same reason on its own not-yet-session-backed boot paths (Odyssey, a scenario,
  // spectate — see that file). It resolves synchronously underneath (net/directTransport.js's own
  // header + test/directTransport.test.js), so every existing assertion below that reads
  // state/unit fields immediately after dispatching an event keeps working unchanged.
  const transport = wrapTransport(createDirectTransport(state));
  const controller = attachInput(canvas, state, transport, () => { calls++; });
  return { canvas, window: globalThis.window, state, transport, controller, calls: () => calls };
}

// The world point at (wx, wy) as canvas-local client coordinates, inverting the same
// screenToWorld math input.js's toWorld() uses (rect.left/top are 0 for FakeCanvas).
function clientFor(controller, wx, wy) {
  const cam = controller.getCamera();
  return { clientX: VW / 2 + (wx - cam.x) * cam.zoom, clientY: VH / 2 + (wy - cam.y) * cam.zoom };
}

// A real right-click (as of the click-and-drag heading gesture) is a button-2 mousedown on the
// canvas followed by a button-2 mouseup on window — commandAt now fires from mouseup, not a bare
// `contextmenu` event (contextmenu's only remaining job is suppressing the browser's native
// menu). Mouse down and up at the SAME point is a plain click: no drag, so no explicit heading —
// byte-identical to the old single-event behaviour these tests were written against.
function rightClick(canvas, window, clientX, clientY, ctrlKey = false) {
  canvas.dispatchEvent(ev("mousedown", { button: 2, clientX, clientY }));
  window.dispatchEvent(ev("mouseup", { button: 2, clientX, clientY, ctrlKey }));
}

// A left-click (selection) is the button-0 equivalent: mousedown on the canvas arms a
// selection box at that point, mouseup on window (same point, no drag) resolves it via
// applyBoxSelection's tiny-box/point-pick branch.
function leftClick(canvas, window, clientX, clientY, ctrlKey = false) {
  canvas.dispatchEvent(ev("mousedown", { button: 0, clientX, clientY }));
  window.dispatchEvent(ev("mouseup", { button: 0, clientX, clientY, ctrlKey }));
}

// A real left-DRAG (box-select): mousedown at the start, then a mousemove to the end point —
// dragBox.x2/y2 only ever advances on mousemove (see input.js), never on mouseup itself — and
// finally mouseup at the end point, which is what actually resolves the box via
// applyBoxSelection. `extra` carries mouseup's own modifier flags (ctrlKey/altKey).
function leftDrag(canvas, window, start, end, extra = {}) {
  canvas.dispatchEvent(ev("mousedown", { button: 0, clientX: start.clientX, clientY: start.clientY }));
  canvas.dispatchEvent(ev("mousemove", { clientX: end.clientX, clientY: end.clientY }));
  window.dispatchEvent(ev("mouseup", { button: 0, clientX: end.clientX, clientY: end.clientY, ...extra }));
}

// ============================================================================
// Bug 1 — alt-tab camera drift: a backgrounded tab doesn't reliably get a keyup, so a
// pan key held at the moment of alt-tab must not stay "held" forever. A window blur is
// the signal a browser DOES reliably deliver, and now clears heldKeys — the keyboard
// counterpart to the touchcancel handling already in place for the touch equivalent.
// ============================================================================

test("a window blur clears held pan keys, stopping the drift", () => {
  const { window, controller } = setup();

  window.dispatchEvent(ev("keydown", { key: "ArrowRight", code: "ArrowRight" }));
  const before = controller.getCamera().x;
  controller.tickCamera(0.1);
  const afterHeld = controller.getCamera().x;
  assert.ok(afterHeld > before, "holding the pan key actually moves the camera (sanity check)");

  window.dispatchEvent(ev("blur"));
  controller.tickCamera(0.1);
  assert.equal(controller.getCamera().x, afterHeld,
    "after a blur, ticking the camera again with the key never released must not move it further");
});

test("a blur with nothing held is a harmless no-op", () => {
  const { window, controller } = setup();
  const before = controller.getCamera().x;
  assert.doesNotThrow(() => window.dispatchEvent(ev("blur")));
  controller.tickCamera(0.1);
  assert.equal(controller.getCamera().x, before, "no key was held, so nothing pans");
});

test("a key held again after a blur still pans normally (blur doesn't wedge the pan system)", () => {
  const { window, controller } = setup();
  window.dispatchEvent(ev("keydown", { key: "d", code: "KeyD" }));
  window.dispatchEvent(ev("blur"));
  window.dispatchEvent(ev("keydown", { key: "d", code: "KeyD" }));   // re-press after tabbing back in
  const before = controller.getCamera().x;
  controller.tickCamera(0.1);
  assert.ok(controller.getCamera().x > before, "a fresh press after the blur pans as normal");
});

test("destroy() tears the blur listener down along with every other listener", () => {
  const { window, controller } = setup();
  controller.destroy();
  // The blur handler is wired with the same { signal } as every other listener in the
  // file; aborting it must leave dispatching a blur harmless, not throwing.
  assert.doesNotThrow(() => window.dispatchEvent(ev("blur")));
});

// ============================================================================
// Bug 2 — commandAt() only called onChange() on the rally branch. Every other
// order-issuing branch (attack, gather, the plain move fallback, ...) left the HUD to
// notice the change on a stray ~150ms tick instead of updating immediately.
// ============================================================================

test("commandAt still notifies on a rally order (regression: the branch that already worked)", () => {
  const { state, canvas, controller, calls } = setup();
  const cc = makeBuilding("command", "player", 1000, 1000);   // BUILDINGS.command.produces is non-empty
  state.buildings.set(cc.id, cc);
  state.selection = [cc.id];

  const { clientX, clientY } = clientFor(controller, 2500, 2600);
  rightClick(canvas, window, clientX, clientY);

  assert.deepEqual(cc.rally, { x: 2500, y: 2600, nodeId: null });
  assert.equal(calls(), 1, "onChange fires exactly once for the order");
});

test("commandAt notifies on an attack order (the headline branch the review flagged)", () => {
  const { state, canvas, controller, calls } = setup();
  const attacker = makeUnit("skiff", "player", 500, 500);
  const enemy = makeUnit("skiff", "ai", 3000, 3000);
  state.units.set(attacker.id, attacker);
  state.units.set(enemy.id, enemy);
  state.selection = [attacker.id];
  reveal(state.fog, enemy.x, enemy.y);   // entityAt only returns a non-player unit if it's visible

  const { clientX, clientY } = clientFor(controller, enemy.x, enemy.y);
  rightClick(canvas, window, clientX, clientY);

  assert.deepEqual(attacker.order, { type: "attack", targetId: enemy.id });
  assert.equal(calls(), 1, "the HUD's Attack-Move button (and everything else onChange refreshes) must hear about this immediately, not on a stray HUD tick");
});

test("commandAt notifies on a gather order", () => {
  const { state, canvas, controller, calls } = setup();
  const worker = makeUnit("worker", "player", 500, 500);
  state.units.set(worker.id, worker);
  state.selection = [worker.id];
  const node = { id: "node-1", x: 2200, y: 2200, amount: 500, hidden: false };
  state.map.nodes.push(node);

  const { clientX, clientY } = clientFor(controller, node.x, node.y);
  rightClick(canvas, window, clientX, clientY);

  assert.deepEqual(worker.order, { type: "gather", nodeId: "node-1" });
  assert.equal(calls(), 1);
});

test("commandAt notifies on the plain move fallback (nothing at the click point)", () => {
  const { state, canvas, controller, calls } = setup();
  const worker = makeUnit("worker", "player", 500, 500);
  state.units.set(worker.id, worker);
  state.selection = [worker.id];

  const { clientX, clientY } = clientFor(controller, 2800, 1400);   // empty ground, no unit/building/node
  rightClick(canvas, window, clientX, clientY);

  assert.deepEqual(worker.order, { type: "move", x: 2800, y: 1400 });
  assert.equal(calls(), 1, "the fallback move branch must notify too, not just the rally special case");
});

// Regression: a Reactor/Combustor/Biomass Reactor has neither a recipe nor a storeCap (it's a
// pure fuel-burning power station, entities.js), so commandAt's service-target check — originally
// `recipeOf(target) || storeCapOf(target.type) > 0` — never matched one. Directing a worker onto a
// completed, undamaged Reactor fell all the way through to the plain-move fallback: the worker
// just walked over and stood there, never fetching the radioactives it needed to run. Fixed by
// also matching BUILDINGS[type].combust, the same "is this serviceable" test engine/haul.js's own
// assignService/updateBuild already use internally.
test("commandAt assigns a service order when a worker is directed onto a fuel-needing power station", () => {
  const { state, canvas, controller, calls } = setup();
  const worker = makeUnit("worker", "player", 500, 500);
  state.units.set(worker.id, worker);
  state.selection = [worker.id];
  const reactor = makeBuilding("reactor", "player", 2000, 2000);   // BUILDINGS.reactor.combust: { fuels: ["radioactives"], ... }
  state.buildings.set(reactor.id, reactor);

  const { clientX, clientY } = clientFor(controller, reactor.x, reactor.y);
  rightClick(canvas, window, clientX, clientY);

  assert.deepEqual(worker.order, { type: "service", buildingId: reactor.id, phase: "plan", manual: true },
    "a healthy power station must dispatch the same manual service order a factory/Rig target gets — not a plain move");
  assert.equal(calls(), 1);
});

// ============================================================================
// Click-and-drag heading: a right-DRAG (mousedown then mouseup at a different point) sets the
// destination at the DRAG'S START and stamps the drag direction as an explicit facing (a plain
// click carries none — the two commandAt tests above already cover that byte-identical case).
// ============================================================================

test("a right-drag moves to where the drag STARTED, not where it ended", () => {
  const { state, canvas, controller } = setup();
  const worker = makeUnit("worker", "player", 500, 500);
  state.units.set(worker.id, worker);
  state.selection = [worker.id];

  const start = clientFor(controller, 2800, 1400);
  const end = clientFor(controller, 3200, 1400);   // dragged further along +x
  canvas.dispatchEvent(ev("mousedown", { button: 2, clientX: start.clientX, clientY: start.clientY }));
  window.dispatchEvent(ev("mouseup", { button: 2, clientX: end.clientX, clientY: end.clientY }));

  assert.deepEqual(worker.order, { type: "move", x: 2800, y: 1400 }, "destination is the drag's START point");
});

test("a right-drag stamps the drag direction as the unit's facing; a plain click clears it", () => {
  const { state, canvas, controller } = setup();
  const worker = makeUnit("worker", "player", 500, 500);
  state.units.set(worker.id, worker);
  state.selection = [worker.id];

  const start = clientFor(controller, 2800, 1400);
  const end = clientFor(controller, 2800, 1800);   // dragged straight down (+y) from the start point
  canvas.dispatchEvent(ev("mousedown", { button: 2, clientX: start.clientX, clientY: start.clientY }));
  window.dispatchEvent(ev("mouseup", { button: 2, clientX: end.clientX, clientY: end.clientY }));

  assert.ok(Number.isFinite(worker.facing), "the drag set an explicit facing");
  assert.ok(Math.abs(worker.facing - Math.PI / 2) < 1e-6, "facing straight down (+y) is angle PI/2");

  rightClick(canvas, window, start.clientX, start.clientY);   // a later PLAIN click, no drag
  assert.ok(!Number.isFinite(worker.facing), "a plain command with no heading clears the earlier facing");
});

// ============================================================================
// Bug 3 — dblclick ignored buildMode/attackMoveArmed and ran its normal
// reselect-fleet-of-this-type logic regardless, silently overriding the click that had
// just placed a building or committed an attack-move.
// ============================================================================

function placeTwoSkiffs(state) {
  const a = makeUnit("skiff", "player", 2000, 2000);
  const b = makeUnit("skiff", "player", 2030, 2000);   // both inside the default on-screen viewport
  state.units.set(a.id, a);
  state.units.set(b.id, b);
  return [a, b];
}

test("dblclick in build mode does not reselect — the mousedown for each click already placed", () => {
  const { state, canvas, controller } = setup();
  const [a] = placeTwoSkiffs(state);
  state.selection = [];
  controller.startBuild("barracks");

  const { clientX, clientY } = clientFor(controller, a.x, a.y);
  canvas.dispatchEvent(ev("dblclick", { clientX, clientY }));

  assert.deepEqual(state.selection, [], "the reselect-all-of-type gesture must not run mid-placement");
  assert.ok(controller.building, "build mode itself is untouched by the dblclick guard");
});

test("dblclick with attack-move armed does not reselect either", () => {
  const { state, canvas, controller } = setup();
  const [a] = placeTwoSkiffs(state);
  state.selection = [];
  controller.toggleAttackMove();
  assert.equal(controller.attackArmed, true);

  const { clientX, clientY } = clientFor(controller, a.x, a.y);
  canvas.dispatchEvent(ev("dblclick", { clientX, clientY }));

  assert.deepEqual(state.selection, [], "armed attack-move must not be overridden by a reselect");
});

test("dblclick with neither mode active still does the normal select-all-of-type (regression)", () => {
  const { state, canvas, controller } = setup();
  const [a, b] = placeTwoSkiffs(state);
  state.selection = [];

  const { clientX, clientY } = clientFor(controller, a.x, a.y);
  canvas.dispatchEvent(ev("dblclick", { clientX, clientY }));

  assert.deepEqual([...state.selection].sort(), [a.id, b.id].sort(),
    "with no build/attack-move mode active, dblclick still grabs every same-type unit on screen");
});

// ============================================================================
// placeBuildingAt (T-012): the one command-issuing call site in this file that checks a
// CommandResult instead of firing-and-forgetting (TASKS.md T-013's own flag) — buildMode must
// stay armed until transport.submitCommand's promise actually resolves ok, never optimistically
// cleared before that. See input.js's own comment on placeBuildingAt for the full reasoning.
// ============================================================================

test("placing a building resolves asynchronously: buildMode stays armed until the promise settles, then clears on success and the building exists", async () => {
  const { state, canvas, controller } = setup();
  const worker = makeUnit("worker", "player", 500, 500);
  state.units.set(worker.id, worker);
  state.selection = [worker.id];
  controller.startBuild("barracks");
  const before = state.buildings.size;

  const { clientX, clientY } = clientFor(controller, 900, 900);   // open ground, nothing to collide with
  canvas.dispatchEvent(ev("mousedown", { button: 0, clientX, clientY }));

  // Not yet — transport.submitCommand's mutation already happened (it's synchronous underneath,
  // like every other transport in this codebase), but placeBuildingAt only reads the result and
  // clears buildMode inside its .then(), which is still a queued microtask at this point.
  assert.ok(controller.building, "build mode is still armed — the .then() callback hasn't run yet");

  await Promise.resolve();   // let that microtask run

  assert.equal(state.buildings.size, before + 1, "the building was actually placed");
  assert.equal(controller.building, null, "build mode cleared now that the result resolved ok");
});

test("placing a building with no eligible worker selected is rejected synchronously — no transport round trip needed, so no async gap to wait out", () => {
  const { state, canvas, controller, calls } = setup();
  const skiff = makeUnit("skiff", "player", 500, 500);   // can't build anything (canBuildCategory)
  state.units.set(skiff.id, skiff);
  state.selection = [skiff.id];
  controller.startBuild("barracks");

  const { clientX, clientY } = clientFor(controller, 900, 900);
  canvas.dispatchEvent(ev("mousedown", { button: 0, clientX, clientY }));

  assert.ok(controller.building, "no eligible worker — build mode stays armed so the player can try again");
  assert.equal(state.buildings.size, 0);
  assert.equal(calls(), 1, "onChange still fires once, for the audible-denial feedback");
});

test("placing a building through a REAL injected delay (net/loopbackFaults.js): buildMode survives the whole gap, not just a microtask — the concrete proof T-013 exists to produce", async () => {
  const { state, canvas, controller } = setup(t => createFaultyTransport(t, { latencyMs: 20 }));
  const worker = makeUnit("worker", "player", 500, 500);
  state.units.set(worker.id, worker);
  state.selection = [worker.id];
  controller.startBuild("barracks");
  const before = state.buildings.size;

  const { clientX, clientY } = clientFor(controller, 900, 900);
  canvas.dispatchEvent(ev("mousedown", { button: 0, clientX, clientY }));

  await new Promise(r => setTimeout(r, 10));
  assert.ok(controller.building, "10ms into a 20ms-latency command, build mode must still be armed");
  assert.equal(state.buildings.size, before, "and the building genuinely hasn't been placed yet either");

  await new Promise(r => setTimeout(r, 20));
  assert.equal(state.buildings.size, before + 1, "past the injected delay, the command actually landed");
  assert.equal(controller.building, null, "and only now does build mode clear");
});

// ============================================================================
// Ctrl+click promotes an already-selected unit to leader (selection[0] — the formation leader,
// see engine/formation.js pickLeader) instead of the Set-union no-op it used to be.
// ============================================================================

test("ctrl+clicking a unit already in the selection promotes it to the front (leader)", () => {
  const { state, canvas, controller } = setup();
  const a = makeUnit("skiff", "player", 500, 500);
  const b = makeUnit("skiff", "player", 700, 500);
  const c = makeUnit("skiff", "player", 900, 500);
  [a, b, c].forEach(u => state.units.set(u.id, u));
  state.selection = [a.id, b.id, c.id];

  const { clientX, clientY } = clientFor(controller, c.x, c.y);
  leftClick(canvas, window, clientX, clientY, true);   // ctrl+click c, already selected

  assert.deepEqual(state.selection, [c.id, a.id, b.id], "c is promoted to the front; a/b keep their relative order");
});

test("ctrl+clicking a not-yet-selected unit still just appends (existing behaviour, unchanged)", () => {
  const { state, canvas, controller } = setup();
  const a = makeUnit("skiff", "player", 500, 500);
  const b = makeUnit("skiff", "player", 700, 500);
  state.units.set(a.id, a); state.units.set(b.id, b);
  state.selection = [a.id];

  const { clientX, clientY } = clientFor(controller, b.x, b.y);
  leftClick(canvas, window, clientX, clientY, true);   // ctrl+click b, not yet selected

  assert.deepEqual(state.selection, [a.id, b.id], "b is appended after the existing leader, a stays first");
});

test("ctrl+clicking the unit that's already the leader is a harmless no-op", () => {
  const { state, canvas, controller } = setup();
  const a = makeUnit("skiff", "player", 500, 500);
  const b = makeUnit("skiff", "player", 700, 500);
  state.units.set(a.id, a); state.units.set(b.id, b);
  state.selection = [a.id, b.id];

  const { clientX, clientY } = clientFor(controller, a.x, a.y);
  leftClick(canvas, window, clientX, clientY, true);   // ctrl+click a, already the leader

  assert.deepEqual(state.selection, [a.id, b.id], "already the leader — selection order is unchanged");
});

test("a plain (non-ctrl) click on an already-selected unit still resets the selection to just it", () => {
  const { state, canvas, controller } = setup();
  const a = makeUnit("skiff", "player", 500, 500);
  const b = makeUnit("skiff", "player", 700, 500);
  state.units.set(a.id, a); state.units.set(b.id, b);
  state.selection = [a.id, b.id];

  const { clientX, clientY } = clientFor(controller, b.x, b.y);
  leftClick(canvas, window, clientX, clientY, false);   // plain click on b, no ctrl

  assert.deepEqual(state.selection, [b.id], "a plain click always replaces the selection — promotion is a ctrl-only gesture");
});

// ============================================================================
// Keydown hotkey dispatch — control groups, Q/X, Escape, and the positional Z/C/V/B/N
// production keys. This whole dispatch body was previously only reachable through a real
// browser driving real keystrokes, so despite being the single most-used input path in the
// game (a fast-paced RTS lives and dies by hotkeys, not menu-hunting) it sat effectively
// untested. Same FakeWindow/`ev()` dispatch the blur tests up top already use —
// window.dispatchEvent(ev("keydown", {...})) is indistinguishable from the real thing for
// everything this handler reads (e.key/e.code/e.shiftKey/e.repeat/e.target).
// ============================================================================

test("Shift+digit binds the current selection to a control group; the bare digit recalls exactly that later, even after the selection has moved on", () => {
  const { state, window } = setup();
  const a = makeUnit("skiff", "player", 500, 500);
  const b = makeUnit("skiff", "player", 700, 500);
  const c = makeUnit("skiff", "player", 900, 500);
  [a, b, c].forEach(u => state.units.set(u.id, u));
  state.selection = [a.id, b.id];

  // Shift is the bind modifier (not Ctrl — Ctrl+digit is the browser's own tab-switch shortcut
  // and can't be reliably suppressed, per input.js's own comment). The match is on e.code, so
  // the real e.key ("!" under Shift on a US layout) never has to be right for this to bind.
  window.dispatchEvent(ev("keydown", { key: "1", code: "Digit1", shiftKey: true }));

  state.selection = [c.id];   // selection moves on to something else entirely before recalling

  window.dispatchEvent(ev("keydown", { key: "1", code: "Digit1" }));   // bare 1 — no shiftKey

  assert.deepEqual(state.selection, [a.id, b.id],
    "recall restores exactly what was bound earlier — a snapshot taken at bind time, not a live reference to whatever the selection is now");
});

test("recalling a control-group digit that was never bound is a harmless no-op", () => {
  const { state, window } = setup();
  const a = makeUnit("skiff", "player", 500, 500);
  state.units.set(a.id, a);
  state.selection = [a.id];

  window.dispatchEvent(ev("keydown", { key: "9", code: "Digit9" }));   // group 9 was never assigned

  assert.deepEqual(state.selection, [a.id], "an unbound group's digit must not clear or otherwise touch the current selection");
});

test("Q selects the whole army — every combat-role unit you own, on-screen or not", () => {
  const { state, window } = setup();
  const skiff = makeUnit("skiff", "player", 500, 500);
  const offscreenBastion = makeUnit("bastion", "player", 3500, 3500);   // well outside the default viewport — Q is whole-map, not just what's visible
  const worker = makeUnit("worker", "player", 500, 500);                // role "worker" — must be excluded
  const enemySkiff = makeUnit("skiff", "ai", 500, 500);                 // right type, wrong owner — must be excluded
  [skiff, offscreenBastion, worker, enemySkiff].forEach(u => state.units.set(u.id, u));
  state.selection = [];

  window.dispatchEvent(ev("keydown", { key: "q", code: "KeyQ" }));

  assert.deepEqual([...state.selection].sort(), [skiff.id, offscreenBastion.id].sort(),
    "grabs every player-owned combat unit anywhere on the map; the worker (wrong role) and the enemy skiff (wrong owner) are both excluded");
});

test("X halts the selection: clears its active order and any queued waypoints", () => {
  const { state, window } = setup();
  const worker = makeUnit("worker", "player", 500, 500);
  worker.order = { type: "gather", nodeId: "node-1" };
  worker.orderQueue = [{ type: "move", x: 999, y: 999 }];   // a Ctrl-queued waypoint behind the current order
  state.units.set(worker.id, worker);
  state.selection = [worker.id];

  window.dispatchEvent(ev("keydown", { key: "x", code: "KeyX" }));

  assert.equal(worker.order, null, "the active order is cleared");
  assert.deepEqual(worker.orderQueue, [], "queued waypoints are dropped too — X is a full stop, not just cancel-the-current-leg");
});

test("Escape disarms a pending attack-move", () => {
  const { window, controller } = setup();
  controller.toggleAttackMove();
  assert.equal(controller.attackArmed, true, "attack-move is actually armed before Escape (sanity check)");

  window.dispatchEvent(ev("keydown", { key: "Escape", code: "Escape" }));

  assert.equal(controller.attackArmed, false, "Escape is the keyboard way to back out of an armed attack-move, same as a right-click cancel");
});

test("Escape also exits build mode", () => {
  const { window, controller } = setup();
  controller.startBuild("barracks");
  assert.ok(controller.building, "build mode is actually active before Escape (sanity check)");

  window.dispatchEvent(ev("keydown", { key: "Escape", code: "Escape" }));

  assert.equal(controller.building, null, "Escape backs out of build-placement mode without placing anything");
});

test("a positional production hotkey (Z) fires the HUD's bound action exactly once per keypress", () => {
  const { window } = setup();
  // hudSelection.js populates game.hotkeyActions with { key, click } entries as it rebuilds the
  // selection panel — click() replays the real button's own handler (see prodButton there). A
  // fake entry with its own counting `click` is enough to prove input.js finds the right slot
  // and fires it, without dragging in the whole HUD module just for this.
  let runs = 0;
  game.hotkeyActions = [{ key: "z", click: () => { runs++; } }];

  window.dispatchEvent(ev("keydown", { key: "z", code: "KeyZ" }));

  assert.equal(runs, 1, "the Z slot's action fired exactly once for one keypress");
});

// ============================================================================
// R: patrol (docs/improvement-proposals.md "Patrol: looping attack-move waypoints") — converts
// the selection's existing move/attack-move waypoint chain into a looping patrol
// (engine/commands.js issuePatrol), the same points already laid down by right-click /
// Ctrl+right-click. P was unavailable (overlays.js already binds it to pause), so R.
// ============================================================================

test("R converts the selection's move/attack-move waypoint chain into a looping patrol", () => {
  const { state, window } = setup();
  const skiff = makeUnit("skiff", "player", 500, 500);
  state.units.set(skiff.id, skiff);
  state.selection = [skiff.id];
  skiff.order = { type: "move", x: 600, y: 500 };
  skiff.orderQueue = [{ type: "attack-move", x: 700, y: 500 }];

  window.dispatchEvent(ev("keydown", { key: "r", code: "KeyR" }));

  assert.deepEqual(skiff.order, { type: "attack-move", x: 600, y: 500, patrol: true },
    "the active leg's point is kept, but it's now an attack-move flagged patrol:true");
  assert.deepEqual(skiff.orderQueue, [
    { type: "attack-move", x: 700, y: 500, patrol: true },
    { type: "attack-move", x: 600, y: 500, patrol: true },
  ], "the queued point survives too, plus the trailing copy of the active leg that makes it loop (engine/commands.js issuePatrol)");
});

test("R skips a non-combat/non-scout unit in the selection (e.g. a worker) — same gate issuePatrol applies", () => {
  const { state, window } = setup();
  const worker = makeUnit("worker", "player", 500, 500);
  state.units.set(worker.id, worker);
  state.selection = [worker.id];
  worker.order = { type: "move", x: 600, y: 500 };

  window.dispatchEvent(ev("keydown", { key: "r", code: "KeyR" }));

  assert.deepEqual(worker.order, { type: "move", x: 600, y: 500 }, "a worker's plain move order is left completely untouched — R never applies to it");
});

test("R on a unit with nothing move/attack-move queued (e.g. standing idle) is a harmless no-op", () => {
  const { state, window } = setup();
  const skiff = makeUnit("skiff", "player", 500, 500);
  state.units.set(skiff.id, skiff);
  state.selection = [skiff.id];
  skiff.order = null;

  assert.doesNotThrow(() => window.dispatchEvent(ev("keydown", { key: "r", code: "KeyR" })));
  assert.equal(skiff.order, null, "nothing to convert into a patrol, so nothing happens");
});

// ============================================================================
// The focused-control guard: hotkeys must not fire while a real HUD control (a button, a text
// input, the Home-confirm modal) has focus, or Space/letters would double as both a game
// command AND whatever that control does with the same keystroke. dispatchEvent always sets
// event.target to the object dispatchEvent was called on (see the file-top comment on the
// document stub) — there's no DOM tree here for a click to bubble up from some other focused
// descendant, so this test's `window` instance has to stand in for the focused control itself.
// The guard only probes one method on that target, `.closest(...)`, so giving `window` one that
// returns truthy — exactly what a real focused <button>/<input>'s own .closest("button, input,
// ...") would return — reproduces the same branch a real focused HUD control takes.
// ============================================================================

test("the focused-control guard suppresses a hotkey while a real HUD control has focus", () => {
  const { state, window, calls } = setup();
  const army = makeUnit("skiff", "player", 500, 500);
  state.units.set(army.id, army);
  state.selection = [];

  window.closest = () => true;   // stands in for "event.target is inside a focused button/input/etc."

  window.dispatchEvent(ev("keydown", { key: "q", code: "KeyQ" }));

  assert.deepEqual(state.selection, [], "Q must not fire while a focused control 'owns' the keystroke");
  assert.equal(calls(), 0, "nothing should react at all — onChange must not fire either");
});

// ============================================================================
// Touch double-tap: the finger equivalent of dblclick (see the Bug 3 section above) — a second
// tap close to the first, both in time (DOUBLE_TAP_MS) and screen position (DOUBLE_TAP_DIST),
// upgrades to select-all-of-this-type instead of just re-tapping the one unit. Runs through the
// exact same canvas EventTarget dispatch as the mouse tests; touchstart/touchend just need a
// `touches` array carrying the properties input.js actually reads (clientX/clientY) — same idea
// as `ev()` supplying whatever extra properties a MouseEvent needs.
// ============================================================================

// A tap is a single-finger touchstart immediately followed by touchend at the same point — the
// touch equivalent of leftClick/rightClick above. `touches: []` on touchend matches a real
// TouchList once the one finger that was down has lifted (input.js's endTouch only ever reads
// e.touches.length, never .changedTouches, so an empty array is all "all fingers up" needs).
function tap(canvas, clientX, clientY) {
  canvas.dispatchEvent(ev("touchstart", { touches: [{ clientX, clientY }] }));
  canvas.dispatchEvent(ev("touchend", { touches: [] }));
}

test("two quick taps on the same unit are a double-tap: select every unit of that type on screen (the touch equivalent of dblclick)", () => {
  const { state, canvas, controller } = setup();
  const [a, b] = placeTwoSkiffs(state);
  state.selection = [];

  // The very first tap of a fresh controller can never register as a double no matter how the
  // timing falls: lastTapCX/CY start at literal 0, and this tap's client position (near the
  // canvas center) is nowhere close to that origin, so the distance half of isDouble alone
  // already rules it out — no need to fake or wait out performance.now().
  const { clientX, clientY } = clientFor(controller, a.x, a.y);
  tap(canvas, clientX, clientY);
  assert.deepEqual(state.selection, [a.id], "a single tap on a unit just selects it, like a single click (sanity check)");

  tap(canvas, clientX, clientY);   // second tap, same spot, immediately after
  assert.deepEqual([...state.selection].sort(), [a.id, b.id].sort(),
    "a double-tap grabs every same-type unit on screen, exactly like dblclick");
});

test("two taps far apart on screen are NOT a double-tap — the second lands as an ordinary command instead", () => {
  const { state, canvas, controller } = setup();
  const [a] = placeTwoSkiffs(state);
  state.selection = [];

  const first = clientFor(controller, a.x, a.y);
  tap(canvas, first.clientX, first.clientY);   // selects `a` (see the distance argument in the test above)
  assert.deepEqual(state.selection, [a.id], "the first tap alone just selects a (sanity check)");

  // Dispatched an instant later (well inside DOUBLE_TAP_MS), but DOUBLE_TAP_DIST (30 client px)
  // away from the first tap — distance alone must disqualify this as a double-tap, even with
  // essentially zero time elapsed between the two taps.
  const far = { clientX: first.clientX + 200, clientY: first.clientY };
  tap(canvas, far.clientX, far.clientY);

  assert.deepEqual(state.selection, [a.id], "the far tap did not extend the selection to every skiff on screen");
  assert.deepEqual(a.order, { type: "move", x: 2200, y: 2000 },
    "instead it was read as an ordinary command for the standing selection — the same plain-move fallback commandAt uses elsewhere");
});

// ============================================================================
// Backspace: jump-to-last-alert (docs/improvement-proposals.md "Attack pings on the minimap plus
// a jump-to-last-alert key") — centers the camera on game.lastAttackAt (session.js), written by
// boot.js's frame-event pump next to supplyBlockedUntil, the same established cross-module
// pattern. A no-op before the game's first alert (game.lastAttackAt still null).
// ============================================================================

test("Backspace centers the camera on the most recent under-attack alert (game.lastAttackAt)", () => {
  const { window, controller } = setup();
  game.lastAttackAt = { x: 2800, y: 1400 };

  window.dispatchEvent(ev("keydown", { key: "Backspace", code: "Backspace" }));

  assert.equal(controller.getCamera().x, 2800);
  assert.equal(controller.getCamera().y, 1400);
});

test("Backspace before any alert has ever fired (game.lastAttackAt is null) is a harmless no-op", () => {
  const { window, controller, calls } = setup();
  const before = { x: controller.getCamera().x, y: controller.getCamera().y };

  assert.doesNotThrow(() => window.dispatchEvent(ev("keydown", { key: "Backspace", code: "Backspace" })));

  assert.equal(controller.getCamera().x, before.x, "nothing to jump to, so the camera must not move");
  assert.equal(controller.getCamera().y, before.y);
  assert.equal(calls(), 0, "nothing changed, so onChange should not fire either");
});

// ============================================================================
// Space cycles bases (docs/improvement-proposals.md "Space cycles bases and an idle-production
// topbar chip"): centerOnBase() used to always land on the FIRST completed Command Center a
// .find() happened to hit; repeated presses within DOUBLE_GROUP_MS now cycle through every one
// in turn (sorted by id), the same double-press timing recallGroup already uses for its own
// jump-to-centroid gesture. A single, isolated press always lands on the first (sorted) CC —
// unchanged single-base behavior.
// ============================================================================

test("Space centers on the (single) completed Command Center — unchanged single-base behavior", () => {
  const { state, window, controller } = setup();
  const cc = makeBuilding("command", "player", 2500, 2600);
  state.buildings.set(cc.id, cc);

  window.dispatchEvent(ev("keydown", { key: " ", code: "Space" }));

  assert.equal(controller.getCamera().x, 2500);
  assert.equal(controller.getCamera().y, 2600);
});

test("Space falls back to the landing zone when no completed Command Center exists yet", () => {
  const { state, window, controller } = setup();
  state.map.bases.player = { x: 1500, y: 1600 };
  const constructingCC = makeBuilding("command", "player", 1000, 1000, { constructing: true });
  state.buildings.set(constructingCC.id, constructingCC);   // still under construction -- must not count

  window.dispatchEvent(ev("keydown", { key: " ", code: "Space" }));

  assert.equal(controller.getCamera().x, 1500);
  assert.equal(controller.getCamera().y, 1600);
});

test("repeated Space presses within the double-press window cycle through every completed CC in turn, sorted by id", () => {
  const { state, window, controller } = setup();
  const a = makeBuilding("command", "player", 1000, 1200);
  const b = makeBuilding("command", "player", 3000, 3200);
  state.buildings.set(a.id, a);
  state.buildings.set(b.id, b);
  const [first, second] = [a, b].sort((x, y) => (x.id < y.id ? -1 : 1));

  window.dispatchEvent(ev("keydown", { key: " ", code: "Space" }));
  assert.deepEqual([controller.getCamera().x, controller.getCamera().y], [first.x, first.y],
    "the first press lands on the first CC (sorted by id)");

  window.dispatchEvent(ev("keydown", { key: " ", code: "Space" }));   // second press, right away -- within the window
  assert.deepEqual([controller.getCamera().x, controller.getCamera().y], [second.x, second.y],
    "a quick second press cycles to the next CC");

  window.dispatchEvent(ev("keydown", { key: " ", code: "Space" }));   // third press, still quick -- wraps back around
  assert.deepEqual([controller.getCamera().x, controller.getCamera().y], [first.x, first.y],
    "a third quick press wraps back to the first CC");
});

test("a Space press after the double-press window has elapsed restarts the cycle at the first CC", async () => {
  const { state, window, controller } = setup();
  const a = makeBuilding("command", "player", 1000, 1200);
  const b = makeBuilding("command", "player", 3000, 3200);
  state.buildings.set(a.id, a);
  state.buildings.set(b.id, b);
  const [first, second] = [a, b].sort((x, y) => (x.id < y.id ? -1 : 1));

  window.dispatchEvent(ev("keydown", { key: " ", code: "Space" }));   // -> first
  window.dispatchEvent(ev("keydown", { key: " ", code: "Space" }));   // quick second -> second
  assert.deepEqual([controller.getCamera().x, controller.getCamera().y], [second.x, second.y]);

  await new Promise(r => setTimeout(r, 450));   // let the double-press window (400ms) lapse

  window.dispatchEvent(ev("keydown", { key: " ", code: "Space" }));   // a slow next press -- restarts at the first CC
  assert.deepEqual([controller.getCamera().x, controller.getCamera().y], [first.x, first.y]);
});

// ============================================================================
// focusIdleProducer (docs/improvement-proposals.md "Space cycles bases and an idle-production
// topbar chip"): the building-scale sibling of focusIdleWorker — cycles to and selects the next
// completed player production building (BUILDINGS[type].produces) whose queue is empty.
// ============================================================================

test("focusIdleProducer selects and centers on the next idle production building, cycling like focusIdleWorker", () => {
  const { state, controller } = setup();
  const barracksA = makeBuilding("barracks", "player", 500, 600);
  const barracksB = makeBuilding("barracks", "player", 900, 1000);
  state.buildings.set(barracksA.id, barracksA);
  state.buildings.set(barracksB.id, barracksB);

  controller.focusIdleProducer();
  assert.deepEqual(state.selection, [barracksA.id]);
  assert.equal(controller.getCamera().x, 500);
  assert.equal(controller.getCamera().y, 600);

  controller.focusIdleProducer();
  assert.deepEqual(state.selection, [barracksB.id], "a second call cycles to the other idle producer");

  controller.focusIdleProducer();
  assert.deepEqual(state.selection, [barracksA.id], "a third call wraps back around");
});

test("focusIdleProducer skips a constructing building, one with a non-empty queue, and one with no `produces` at all", () => {
  const { state, controller } = setup();
  const constructing = makeBuilding("barracks", "player", 100, 100, { constructing: true });
  const busy = makeBuilding("barracks", "player", 200, 200);
  busy.queue.push({ unitType: "skiff", progress: 0 });
  const nonProducer = makeBuilding("refinery", "player", 300, 300);   // no `produces` — the Refinery researches upgrades instead
  const idle = makeBuilding("barracks", "player", 400, 400);
  [constructing, busy, nonProducer, idle].forEach(b => state.buildings.set(b.id, b));

  controller.focusIdleProducer();

  assert.deepEqual(state.selection, [idle.id], "only the truly idle producer is ever reachable");
});

test("focusIdleProducer is a harmless no-op when nothing is idle", () => {
  const { state, controller, calls } = setup();
  const busy = makeBuilding("barracks", "player", 200, 200);
  busy.queue.push({ unitType: "skiff", progress: 0 });
  state.buildings.set(busy.id, busy);
  state.selection = [];

  assert.doesNotThrow(() => controller.focusIdleProducer());
  assert.deepEqual(state.selection, [], "nothing idle -> nothing selected");
  assert.equal(calls(), 0, "nothing changed, so onChange should not fire");
});

// ============================================================================
// Selection subtraction (docs/improvement-proposals.md "Selection subtraction and map-wide
// select-all-of-type"): Alt+click / Alt+drag is a third applyBoxSelection mode that filters
// state.selection down (subtracting the picked units), preserving the order of whatever
// survives — so the formation leader (selection[0]) stays leader unless it's one of the units
// actually removed. Ctrl+click's own leader-promotion gesture (tested above) is untouched.
// ============================================================================

test("Alt+click removes an already-selected unit, preserving the order of the rest (the leader survives)", () => {
  const { state, canvas, controller } = setup();
  const a = makeUnit("skiff", "player", 500, 500);
  const b = makeUnit("skiff", "player", 700, 500);
  const c = makeUnit("skiff", "player", 900, 500);
  [a, b, c].forEach(u => state.units.set(u.id, u));
  state.selection = [a.id, b.id, c.id];

  const { clientX, clientY } = clientFor(controller, b.x, b.y);
  canvas.dispatchEvent(ev("mousedown", { button: 0, clientX, clientY }));
  window.dispatchEvent(ev("mouseup", { button: 0, clientX, clientY, altKey: true }));

  assert.deepEqual(state.selection, [a.id, c.id], "b is subtracted; a stays the leader, c keeps its relative order");
});

test("Alt+click on a unit that ISN'T currently selected is a harmless no-op (nothing to subtract)", () => {
  const { state, canvas, controller } = setup();
  const a = makeUnit("skiff", "player", 500, 500);
  const b = makeUnit("skiff", "player", 700, 500);
  state.units.set(a.id, a); state.units.set(b.id, b);
  state.selection = [a.id];

  const { clientX, clientY } = clientFor(controller, b.x, b.y);
  canvas.dispatchEvent(ev("mousedown", { button: 0, clientX, clientY }));
  window.dispatchEvent(ev("mouseup", { button: 0, clientX, clientY, altKey: true }));

  assert.deepEqual(state.selection, [a.id], "b was never selected, so alt-clicking it changes nothing");
});

test("Alt+drag subtracts every unit the box catches from the current selection", () => {
  const { state, canvas, controller } = setup();
  const a = makeUnit("skiff", "player", 500, 500);
  const b = makeUnit("skiff", "player", 700, 500);
  const c = makeUnit("skiff", "player", 2000, 2000);   // well outside the drag box below
  [a, b, c].forEach(u => state.units.set(u.id, u));
  state.selection = [a.id, b.id, c.id];

  const start = clientFor(controller, 400, 400);
  const end = clientFor(controller, 800, 600);   // a box that catches a and b, not c
  leftDrag(canvas, window, start, end, { altKey: true });

  assert.deepEqual(state.selection, [c.id], "a and b (caught by the box) are subtracted; c (outside it) survives");
});

test("Alt-drag over a mix of army + workers only subtracts the army — a worker alongside a fighter is excluded from the box's own picks, same as replace/additive mode", () => {
  const { state, canvas, controller } = setup();
  const skiff = makeUnit("skiff", "player", 500, 500);
  const worker = makeUnit("worker", "player", 520, 500);
  [skiff, worker].forEach(u => state.units.set(u.id, u));
  state.selection = [skiff.id, worker.id];

  const start = clientFor(controller, 400, 400);
  const end = clientFor(controller, 700, 600);   // catches both skiff and worker
  leftDrag(canvas, window, start, end, { altKey: true });

  assert.deepEqual(state.selection, [worker.id],
    "the box's own army-priority filter drops the worker from its picks whenever a fighter is present, so only the skiff is actually subtracted");
});

test("a plain (non-alt) drag over the same units still replaces the selection as before — alt-drag is additive-mode-only otherwise unchanged", () => {
  const { state, canvas, controller } = setup();
  const a = makeUnit("skiff", "player", 500, 500);
  const b = makeUnit("skiff", "player", 700, 500);
  [a, b].forEach(u => state.units.set(u.id, u));
  state.selection = [a.id];

  const start = clientFor(controller, 400, 400);
  const end = clientFor(controller, 800, 600);
  leftDrag(canvas, window, start, end);   // no altKey

  assert.deepEqual([...state.selection].sort(), [a.id, b.id].sort(), "a plain drag replaces the selection with the box's catch, as before");
});

// ============================================================================
// Map-wide select-all-of-type (docs/improvement-proposals.md "Selection subtraction and map-wide
// select-all-of-type"): Ctrl+double-click extends selectSameTypeAt to the whole map instead of
// just the current viewport, matching the map-wide semantics Q and the panel's type rows use. A
// plain double-click (no Ctrl) stays viewport-limited, as before.
// ============================================================================

test("Ctrl+double-click selects every unit of that type across the WHOLE map, not just the current viewport", () => {
  const { state, canvas, controller } = setup();
  const onscreen = makeUnit("skiff", "player", 2000, 2000);
  const offscreen = makeUnit("skiff", "player", 3900, 3900);   // well outside the default viewport
  state.units.set(onscreen.id, onscreen);
  state.units.set(offscreen.id, offscreen);
  state.selection = [];

  const { clientX, clientY } = clientFor(controller, onscreen.x, onscreen.y);
  canvas.dispatchEvent(ev("dblclick", { clientX, clientY, ctrlKey: true }));

  assert.deepEqual([...state.selection].sort(), [onscreen.id, offscreen.id].sort(),
    "Ctrl+double-click reaches every same-type unit anywhere on the map, matching Q's map-wide semantics");
});

test("a plain double-click (no Ctrl) stays viewport-limited, as before", () => {
  const { state, canvas, controller } = setup();
  const onscreen = makeUnit("skiff", "player", 2000, 2000);
  const offscreen = makeUnit("skiff", "player", 3900, 3900);
  state.units.set(onscreen.id, onscreen);
  state.units.set(offscreen.id, offscreen);
  state.selection = [];

  const { clientX, clientY } = clientFor(controller, onscreen.x, onscreen.y);
  canvas.dispatchEvent(ev("dblclick", { clientX, clientY }));   // no ctrlKey

  assert.deepEqual(state.selection, [onscreen.id], "the off-screen unit of the same type is not swept in without Ctrl");
});

/* ============================================================
   Observer Mode (observer.js): O toggles it, and while it's on every order/build/group hotkey
   is swallowed (this isn't your world to command) and Space cycles bases on the SPECTATED
   world — any owner — instead of input.js's own player-only centerOnBase. enterObserverMode
   needs a minimal `game.galaxy` shape ({ activeId, planets }, the only two fields it and
   observedState() actually read) — a full engine/galaxy.js createGalaxy() is more than this
   file's deliberately bare fixtures need.
   ============================================================ */

function enterObserving(state) {
  game.input = null;   // forces enterObserverMode's own createCamera(...) fallback, not a real camera copy
  game.galaxy = { activeId: state.planetId, planets: new Map([[state.planetId, state]]) };
  game.state = state;
  window.dispatchEvent(ev("keydown", { key: "o", code: "KeyO" }));
}

function exitObserving() {
  if (game.observerMode) window.dispatchEvent(ev("keydown", { key: "o", code: "KeyO" }));
  game.galaxy = null; game.state = null; game.spectateId = null; game.observerCamera = null;
}

test("O enters and exits Observer Mode; while on, an order hotkey (Q) is swallowed instead of selecting the army", () => {
  const { window, state } = setup();
  const skiff = makeUnit("skiff", "player", 500, 500);
  state.units.set(skiff.id, skiff);
  state.selection = [];

  enterObserving(state);
  assert.equal(game.observerMode, true, "O enters Observer Mode");

  window.dispatchEvent(ev("keydown", { key: "q", code: "KeyQ" }));
  assert.deepEqual(state.selection, [], "Q (selectAllArmy) never fired — order hotkeys are swallowed while observing");

  exitObserving();
  assert.equal(game.observerMode, false, "a second O press exits");
});

test("Space, while observing, cycles bases on the spectated world (any owner) — not the player-only centerOnBase", () => {
  const { window, state } = setup();
  state.buildings.clear();
  const aiCC = makeBuilding("command", "ai", 900, 900);   // AI-only: the ordinary Space handler would find nothing here at all
  state.buildings.set(aiCC.id, aiCC);

  enterObserving(state);
  window.dispatchEvent(ev("keydown", { key: " ", code: "Space" }));

  assert.ok(game.observerCamera, "the observer camera exists");
  assert.equal(game.observerCamera.x, aiCC.x, "Space landed on the AI's base");
  assert.equal(game.observerCamera.y, aiCC.y);

  exitObserving();
});

test("Escape, while observing, exits Observer Mode instead of the normal build/attack-move cancel", () => {
  const { window, state, controller } = setup();
  enterObserving(state);

  window.dispatchEvent(ev("keydown", { key: "Escape", code: "Escape" }));

  assert.equal(game.observerMode, false, "Escape backs out of Observer Mode, same as every other overlay in this codebase");
  game.galaxy = null; game.state = null; game.spectateId = null; game.observerCamera = null;
});

test("a left-drag, while observing, pans the OBSERVER camera instead of box-selecting the real state", () => {
  const { canvas, window, state } = setup();
  // The fresh camera starts centered on the 4000x4000 map's middle (2000,2000) — screen center
  // — so this decoy sits exactly where a drag spanning most of the viewport would catch it
  // under NORMAL (non-observing) box-select.
  const decoy = makeUnit("skiff", "player", 2000, 2000);
  state.units.set(decoy.id, decoy);
  state.selection = [];
  enterObserving(state);
  const startCam = { x: game.observerCamera.x, y: game.observerCamera.y };

  leftDrag(canvas, window, { clientX: 50, clientY: 50 }, { clientX: VW - 50, clientY: VH - 50 });

  assert.notDeepEqual({ x: game.observerCamera.x, y: game.observerCamera.y }, startCam,
    "the drag panned the observer camera");
  assert.deepEqual(state.selection, [], "no box-selection ran on the real state — the decoy was never touched");

  exitObserving();
});

test("the wheel, while observing, zooms the OBSERVER camera instead of the real one", () => {
  const { canvas, window, controller, state } = setup();
  enterObserving(state);
  const startZoom = game.observerCamera.zoom;
  const realZoomBefore = controller.getCamera().zoom;

  canvas.dispatchEvent(ev("wheel", { clientX: VW / 2, clientY: VH / 2, deltaY: -100 }));

  assert.notEqual(game.observerCamera.zoom, startZoom, "the observer camera zoomed");
  assert.equal(controller.getCamera().zoom, realZoomBefore, "the real camera never moved while observing");

  exitObserving();
});

/* ---- T2: commandAt's precedence ladder -------------------------------------------------------
   The right-click ladder is the most-exercised interaction in the game, and it is GAME POLICY that
   the engine does not re-check: issueServiceBuilding dispatches a service order to whatever id it
   is handed, with no validation that the building is serviceable. Five of its ten branches had zero
   occurrences anywhere in this file, and NO test pinned which branch wins when two match — even
   though input.js's own comment records that exactly this class of bug already shipped (a Reactor
   matched no branch, so right-clicking a Worker onto it silently walked it there). */

function rightClickOn(env, target) {
  const { clientX, clientY } = clientFor(env.controller, target.x, target.y);
  rightClick(env.canvas, window, clientX, clientY);
}

test("a damaged serviceable factory takes SERVICE, not repair (T2 precedence)", () => {
  const env = setup();
  const { state } = env;
  const smelter = makeBuilding("smelter", "player", 1200, 1200);
  smelter.constructing = false;
  smelter.hp = Math.round(smelter.maxHp * 0.4);
  state.buildings.set(smelter.id, smelter);
  const worker = makeUnit("worker", "player", 1100, 1200);
  state.units.set(worker.id, worker);
  state.selection = [worker.id];

  rightClickOn(env, smelter);
  assert.equal(worker.order?.type, "service",
    "the service branch precedes the repair branch — a factory that needs inputs is serviced first");
});

test("a damaged Command Center takes REPAIR, not set-home-base (T2 precedence)", () => {
  const env = setup();
  const { state } = env;
  const cc = makeBuilding("command", "player", 1200, 1200);
  cc.constructing = false;
  cc.hp = Math.round(cc.maxHp * 0.4);
  state.buildings.set(cc.id, cc);
  const worker = makeUnit("worker", "player", 1100, 1200);
  state.units.set(worker.id, worker);
  state.selection = [worker.id];

  rightClickOn(env, cc);
  assert.equal(worker.order?.type, "repair", "repair precedes the passive set-home-base branch");
});

test("a HEALTHY Command Center assigns a home base and leaves the order alone (T2 precedence)", () => {
  const env = setup();
  const { state } = env;
  const cc = makeBuilding("command", "player", 1200, 1200);
  cc.constructing = false;
  state.buildings.set(cc.id, cc);
  const worker = makeUnit("worker", "player", 1100, 1200);
  state.units.set(worker.id, worker);
  state.selection = [worker.id];

  rightClickOn(env, cc);
  assert.equal(worker.homeCC, cc.id, "the home base is pinned");
  assert.equal(worker.order, null, "and the branch is passive — it issues no movement order");
});

test("a friendly freighter takes FERRY from a worker but ESCORT from a combat unit (T2 precedence)", () => {
  const env = setup();
  const { state } = env;
  const freighter = makeUnit("hauler", "player", 1200, 1200);
  state.units.set(freighter.id, freighter);
  const worker = makeUnit("worker", "player", 1100, 1200);
  const skiff = makeUnit("skiff", "player", 1150, 1200);
  state.units.set(worker.id, worker);
  state.units.set(skiff.id, skiff);

  state.selection = [worker.id];
  rightClickOn(env, freighter);
  assert.equal(worker.order?.type, "ferry", "a worker ferries it");

  state.selection = [skiff.id];
  rightClickOn(env, freighter);
  assert.equal(skiff.order?.type, "escort",
    "a combat unit falls past the ferry branch (its worker filter is empty) to escort");
});

test("a constructing friendly building takes ASSIST-BUILD, not service (T2 precedence)", () => {
  const env = setup();
  const { state } = env;
  const site = makeBuilding("smelter", "player", 1200, 1200);
  site.constructing = true;
  site.buildProgress = 0.2;
  state.buildings.set(site.id, site);
  const worker = makeUnit("worker", "player", 1100, 1200);
  state.units.set(worker.id, worker);
  state.selection = [worker.id];

  rightClickOn(env, site);
  assert.equal(worker.order?.type, "build", "assist-build precedes every other building branch");
});
