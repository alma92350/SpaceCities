import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as sound from "../sound.js";
import { installFakeDom, fakeCtx } from "./_dom.js";

/* ============================================================
   A GOLDEN LOCK on the whole selection panel.

   rebuildSelectionPanel is 845 lines and ~28 independent "is one of THESE
   selected?" blocks, appended to panelEl in a fixed order. test/hudSelection.
   test.js covers a lot of what those blocks DECIDE — a disabled button stays
   inert, the live-patch path reuses nodes, the lane rows read the right
   commodity — but nothing covers the panel's SHAPE: which rows exist, in what
   order, with which classes and text. That is exactly the property a
   decomposition has to preserve and exactly the one a behavioural test cannot
   see, because every such test looks up the one row it cares about by class or
   text prefix and is blind to a row that moved, vanished, or grew a sibling.

   So: build the panel for a spread of selections, serialize the tree the code
   actually produced, and compare it against a recorded snapshot. A refactor
   that only moves code passes untouched; one that drops a row or reorders two
   fails loudly, naming the fixture.

   The snapshot is DATA, not a claim about what is right — it records what the
   panel does today. When a change to the UI is intended, regenerate it and
   READ THE DIFF; that diff is the review artifact, and it is the whole point:

       UPDATE_PANEL_GOLDEN=1 node --test test/hudSelection-golden.test.js

   Kept in its own file rather than added to test/hudSelection.test.js because
   the two answer different questions and fail for different reasons: that file
   tells you a behaviour broke, this one tells you the output moved.
   ============================================================ */

installFakeDom({ context: fakeCtx });
sound.setMuted(true);

const { game } = await import("../session.js");
const { createGameState, makeBuilding, makeUnit } = await import("../engine/state.js");
const { mulberry32 } = await import("../engine/rng.js");
const { panelEl } = await import("../dom.js");
const { renderSelectionPanel, resetSelectionSignature } = await import("../hudSelection.js");
const { jumpReadyGalaxy } = await import("./_helpers.js");
const { activeState } = await import("../engine/galaxy.js");
const { createMarket } = await import("../engine/market.js");
const { queueProduction } = await import("../engine/production.js");
const { createDiplomacy } = await import("../engine/diplomacy.js");

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "selection-panels.json");
const UPDATING = process.env.UPDATE_PANEL_GOLDEN === "1";

// The serialization. Deliberately NOT a full DOM dump: it keeps what a reader reviewing a diff
// would actually check (structure, classes, text, disabled/title) and drops what would make the
// snapshot churn for no reason (event listeners, inline styles, dataset bookkeeping, the sprite
// icons' data: URIs). textContent is taken only from LEAF nodes — an element that has children
// has its text represented by them, so including both would double every string.
function panelTree(el) {
  const out = { tag: el.tagName };
  if (el.className) out.cls = el.className;
  if (el.children.length) out.kids = el.children.map(panelTree);
  else if (el.textContent) out.text = el.textContent;
  if (el.title) out.title = el.title;
  if (el.disabled) out.disabled = true;
  return out;
}

// Every fixture starts from the same fresh skirmish. resetSelectionSignature() is not optional:
// lastPanelSignature is module-scope and outlives a single test, and createGameState() resets the
// entity-id counter, so two fixtures can mint byte-identical signatures and the second would hit
// the "nothing changed" branch and snapshot the FIRST one's DOM. See test/hudSelection.test.js's
// own setup() for the empirical trace of that.
function base(seed) {
  resetSelectionSignature();
  const state = createGameState({ planetId: "ferros", seed, rng: mulberry32(seed) });
  game.state = state;
  game.galaxy = null;
  game.collapsedSections = new Set();
  game.hotkeyActions = [];
  game.input = {
    building: null, attackArmed: false,
    focusIdleWorker() {}, focusIdleProducer() {}, selectAllArmy() {}, selectType() {},
    groupCounts: () => [],
  };
  return state;
}

function place(state, type, dx = 0, dy = 0, owner = "player") {
  const cc = [...state.buildings.values()].find(b => b.type === "command" && b.owner === "player");
  const b = makeBuilding(type, owner, cc.x + dx, cc.y + dy);
  b.constructing = false;
  state.buildings.set(b.id, b);
  return b;
}

function spawn(state, type, dx = 0, dy = 0, owner = "player") {
  const cc = [...state.buildings.values()].find(b => b.type === "command" && b.owner === "player");
  const u = makeUnit(type, owner, cc.x + dx, cc.y + dy);
  state.units.set(u.id, u);
  return u;
}

const RICH = { ore: 5000, crystals: 5000, radioactives: 5000, biomass: 5000 };

// One entry per selection worth locking. The aim is coverage of rebuildSelectionPanel's BRANCHES,
// not of the game: every `if (x)` block in it should be entered by at least one fixture, and the
// empty/multi-unit/single-entity top-level shapes each get one too.
const FIXTURES = {
  "empty selection": s => { s.selection = []; },

  "one command center": s => {
    s.selection = [[...s.buildings.values()].find(b => b.type === "command").id];
  },

  "command center, player rich": s => {
    Object.assign(s.players.player.resources, RICH);
    s.selection = [[...s.buildings.values()].find(b => b.type === "command").id];
  },

  // T-030: the SAME command-center panel, but as SEAT B sees it — game.localOwner "ai", an
  // "ai"-owned Command Center selected. Must render as an OWN, ordinary command-center panel
  // (build/produce controls, own economy readouts) — never as "an enemy building"'s stripped-down
  // panel (compare that fixture below), which is exactly the bug a hardcoded "player" seam would
  // have produced for this seat.
  "command center, seat B (localOwner ai)": s => {
    game.localOwner = "ai";
    Object.assign(s.players.ai.resources, RICH);
    s.selection = [[...s.buildings.values()].find(b => b.type === "command" && b.owner === "ai").id];
  },

  "command center with a queued worker": s => {
    Object.assign(s.players.player.resources, RICH);
    const cc = [...s.buildings.values()].find(b => b.type === "command");
    queueProduction(s, cc.id, "worker");
    s.selection = [cc.id];
  },

  "one worker": s => { s.selection = [[...s.units.values()].find(u => u.type === "worker").id]; },

  "two workers": s => {
    const ws = [...s.units.values()].filter(u => u.type === "worker").slice(0, 2);
    s.selection = ws.map(u => u.id);
  },

  "mixed unit selection": s => {
    const a = spawn(s, "skiff", 40, 0), b = spawn(s, "skiff", 55, 0), c = spawn(s, "bastion", 70, 0);
    s.selection = [a.id, b.id, c.id];
  },

  "a damaged building": s => {
    const b = place(s, "barracks", 90, -90);
    b.hp = Math.floor(b.maxHp * 0.4);
    s.selection = [b.id];
  },

  "barracks": s => { Object.assign(s.players.player.resources, RICH); s.selection = [place(s, "barracks", 90, -90).id]; },
  "refinery": s => { Object.assign(s.players.player.resources, RICH); s.selection = [place(s, "refinery", -90, -90).id]; },
  "datacenter": s => { Object.assign(s.players.player.resources, RICH); s.selection = [place(s, "datacenter", -120, 0).id]; },
  "reactor": s => { s.selection = [place(s, "reactor", -60, 60).id]; },
  "habitat": s => { s.selection = [place(s, "habitat", 0, 90).id]; },
  "foundry": s => { Object.assign(s.players.player.resources, RICH); s.selection = [place(s, "foundry", -90, 90).id]; },
  "arsenal": s => { Object.assign(s.players.player.resources, RICH); s.selection = [place(s, "arsenal", -90, -30).id]; },
  "stardock": s => { Object.assign(s.players.player.resources, RICH); s.selection = [place(s, "stardock", 120, -90).id]; },
  "turret": s => { s.selection = [place(s, "turret", 60, 60).id]; },

  "a constructing building": s => {
    const b = place(s, "barracks", 90, -90);
    b.constructing = true; b.buildProgress = 0.35;
    s.selection = [b.id];
  },

  "an enemy building": s => { s.selection = [place(s, "barracks", 300, 300, "ai").id]; },
  "an enemy unit": s => { s.selection = [spawn(s, "skiff", 300, 300, "ai").id]; },

  "a freighter": s => { s.selection = [spawn(s, "freighter", 30, 30).id]; },
  "a mender": s => { s.selection = [spawn(s, "mender", 30, 30).id]; },
  "a ranger": s => { s.selection = [spawn(s, "ranger", 30, 30).id]; },

  "a worker mid-gather": s => {
    const w = [...s.units.values()].find(u => u.type === "worker");
    const node = s.map.nodes[0];
    w.order = { type: "gather", nodeId: node.id };
    node.miners = 4;
    s.selection = [w.id];
  },

  "a building placement in progress": s => {
    game.input.building = "barracks";
    const w = [...s.units.values()].find(u => u.type === "worker");
    s.selection = [w.id];
  },

  "a spaceport in a galaxy": s => {
    const g = jumpReadyGalaxy(9001);
    game.galaxy = g;
    game.state = s = activeState(g);
    s.market = createMarket(s, mulberry32(9001));
    s.diplomacy = s.diplomacy || createDiplomacy(mulberry32(9001));
    const cc = [...s.buildings.values()].find(b => b.type === "command" && b.owner === "player");
    const sp = makeBuilding("spaceport", "player", cc.x + 150, cc.y);
    sp.constructing = false;
    s.buildings.set(sp.id, sp);
    s.selection = [sp.id];
  },
};

function build(name) {
  const state = base(7000 + name.length);
  // T-030: reset before EVERY fixture, not just the ones that care — a fixture that deliberately
  // sets game.localOwner = "ai" (below) must never leak into whichever fixture Object.keys()
  // happens to iterate next, regardless of insertion order.
  game.localOwner = "player";
  FIXTURES[name](state);
  renderSelectionPanel();
  // game.state, not `state`: the galaxy fixture swaps in the active world's own state object.
  return { tree: panelTree(panelEl), state: game.state };
}

const built = {}, states = {};
for (const name of Object.keys(FIXTURES)) {
  const { tree, state } = build(name);
  built[name] = tree;
  states[name] = state;
}

if (UPDATING) {
  mkdirSync(dirname(GOLDEN), { recursive: true });
  writeFileSync(GOLDEN, JSON.stringify(built, null, 2) + "\n");
}

const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));

test("the golden file covers exactly the fixtures this file defines", () => {
  // A fixture added without regenerating would otherwise be silently unchecked, and a fixture
  // deleted would leave a stale entry nothing compares against.
  assert.deepEqual(Object.keys(golden).sort(), Object.keys(FIXTURES).sort(),
    "regenerate with UPDATE_PANEL_GOLDEN=1 node --test test/hudSelection-golden.test.js");
});

for (const name of Object.keys(FIXTURES)) {
  test(`selection panel shape is unchanged: ${name}`, () => {
    assert.deepEqual(built[name], golden[name],
      `the panel built for "${name}" no longer matches the recorded shape. If the change is `
      + `intended, regenerate with UPDATE_PANEL_GOLDEN=1 and review the diff.`);
  });
}

test("every fixture's setup actually took — its selection resolves to live entities", () => {
  // Without this, a fixture whose setup silently failed (a building that never got placed, an id
  // that resolves to nothing) would still "pass" forever against a golden entry recording the
  // same emptiness — a snapshot test's classic failure mode, locking a bug in as the standard.
  // Checked as the real property rather than proxied by node count: a Habitat's whole panel is
  // legitimately two rows, so "small tree" and "broken fixture" are not the same thing.
  for (const [name, state] of Object.entries(states)) {
    if (name === "empty selection") continue;
    assert.ok(state.selection.length > 0, `fixture "${name}" selected nothing`);
    const dangling = state.selection.filter(id => !state.units.has(id) && !state.buildings.has(id));
    assert.deepEqual(dangling, [], `fixture "${name}" selected id(s) that resolve to no entity`);
  }
});

test("the fixtures reach every top-level shape rebuildSelectionPanel branches on", () => {
  // The snapshot is only as good as its coverage: these four shapes take structurally different
  // paths through rebuildSelectionPanel (the early return, the per-type summary rows, the
  // per-entity rows, and the enemy-owned read-only panel), and a fixture set that lost one would
  // leave that whole path unlocked while every remaining assertion still passed.
  const shapes = { empty: 0, multiUnit: 0, single: 0, enemy: 0 };
  for (const [name, state] of Object.entries(states)) {
    const sel = state.selection.map(id => state.units.get(id) || state.buildings.get(id));
    if (!sel.length) shapes.empty++;
    else if (sel.length > 1 && sel.every(e => e.kind === "unit")) shapes.multiUnit++;
    else shapes.single++;
    if (sel.some(e => e && e.owner !== "player")) shapes.enemy++;
  }
  for (const [shape, n] of Object.entries(shapes)) {
    assert.ok(n > 0, `no fixture covers the "${shape}" panel shape`);
  }
});
