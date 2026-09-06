/* ============================================================
   hudSelection.js's Freight Lanes panel — the Odyssey Spaceport's standing-shipping UI.

   Eighty-five uncovered lines, and the largest single hole left in hudSelection.js (66% of its
   functions). It is also the least reachable by anything else: the browser smoke tests drive a
   SKIRMISH, so nothing automated has ever rendered an Odyssey Spaceport panel, let alone one with
   lanes on it.

   What makes it worth a test rather than a shrug: a lane is standing infrastructure a player sets
   up once and then stops looking at (engine/galaxy.js runLanes delivers every LANE_PERIOD with no
   further attention), so this panel is the ONLY place the game ever tells them what they have
   running. A lane that renders with the wrong destination, or a capacity that silently reads zero,
   is a wrong answer nobody is positioned to notice.

   Real galaxy, real createLane, real makeBuilding — the fixtures are the functions the game itself
   uses, so this cannot drift into asserting a shape the engine never produces.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom, fakeCtx } from "./_dom.js";

installFakeDom({ context: fakeCtx });

const { createGameState, makeBuilding, makeUnit } = await import("../engine/state.js");
const { mulberry32 } = await import("../engine/rng.js");
const { createGalaxy, createLane } = await import("../engine/galaxy.js");
const { createDirectTransport } = await import("../net/directTransport.js");
const { game } = await import("../session.js");
const { planetName } = await import("../data.js");
const { UNITS } = await import("../engine/entities.js");
const { renderSelectionPanel } = await import("../hudSelection.js");
const { panelEl } = await import("../dom.js");

const textIn = root => {
  const out = [];
  const walk = n => { for (const c of n.children || []) { if (c.textContent) out.push(c.textContent); walk(c); } };
  walk(root);
  return out;
};

// A held Odyssey world with a completed Spaceport selected — the state this panel is drawn for.
function setupSpaceport() {
  const state = createGameState({ planetId: "ferros", rng: mulberry32(7) });
  const base = state.map.bases.player;
  const spaceport = makeBuilding("spaceport", "player", base.x + 80, base.y, { constructing: false }, state);
  state.buildings.set(spaceport.id, spaceport);

  const galaxy = createGalaxy({ seed: 3 });
  game.state = state;
  game.galaxy = galaxy;
  game.transport = createDirectTransport(state);
  game.input = { building: null, attackArmed: false, focusIdleWorker() {}, selectAllArmy() {} };
  game.collapsedSections = new Set();
  game.hotkeyActions = [];
  state.selection = [spaceport.id];
  return { state, galaxy, spaceport };
}

// Two distinct worlds from the real galaxy, so `from`/`to` are ids createLane will accept.
function twoWorlds(galaxy) {
  const ids = [...galaxy.planets.keys()];
  const from = galaxy.activeId;
  const to = ids.find(id => id !== from);
  return { from, to };
}

test("with no lanes set up, the Spaceport panel still renders and says nothing about lanes", () => {
  // The empty case matters: sectionToggle is given a count of 0, and a panel that invented a lane
  // row here would be reporting shipping that does not exist.
  const { galaxy } = setupSpaceport();
  galaxy.lanes = [];
  renderSelectionPanel();
  const rows = textIn(panelEl).filter(t => /Lane ▸/.test(t));
  assert.deepEqual(rows, [], `expected no lane rows, got: ${rows.join(" | ")}`);
});

test("a lane is listed by DESTINATION — the one fact a player needs to read off it", () => {
  const { galaxy } = setupSpaceport();
  const { from, to } = twoWorlds(galaxy);
  assert.ok(createLane(galaxy, from, to), "fixture: the engine must accept this lane");

  renderSelectionPanel();
  const laneRows = textIn(panelEl).filter(t => /Lane ▸/.test(t));
  assert.equal(laneRows.length, 1, `expected exactly one lane row, got: ${laneRows.join(" | ")}`);
  assert.match(laneRows[0], new RegExp(planetName(to).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "the row must name where the freight actually goes");
});

test("an empty lane reads as 0 ships and 0 capacity, not as a blank", () => {
  // A lane with no ships assigned delivers nothing. Saying so plainly is the difference between
  // "I have shipping set up" and "I have shipping set up that does nothing", which is exactly the
  // mistake standing infrastructure invites.
  const { galaxy } = setupSpaceport();
  const { from, to } = twoWorlds(galaxy);
  createLane(galaxy, from, to);
  renderSelectionPanel();
  const row = textIn(panelEl).find(t => /Lane ▸/.test(t));
  assert.match(row, /0 ships/, `expected an explicit zero, got: ${row}`);
  assert.match(row, /0 cap\/cycle/, `expected an explicit zero capacity, got: ${row}`);
});

test("capacity is the SUM of the assigned ships' holds, and pluralisation follows the count", () => {
  // The number that says how much actually moves per cycle. Summing cargoHold across assigned
  // ships is the whole computation, and getting it wrong understates or overstates a player's
  // entire logistics network with no other signal anywhere in the game.
  const { state, galaxy } = setupSpaceport();
  const { from, to } = twoWorlds(galaxy);
  const lane = createLane(galaxy, from, to);

  const freighterType = Object.keys(UNITS).find(k => (UNITS[k].cargoHold || 0) > 0);
  const base = state.map.bases.player;
  const a = makeUnit(freighterType, "player", base.x, base.y, {}, state);
  const b = makeUnit(freighterType, "player", base.x + 10, base.y, {}, state);
  state.units.set(a.id, a);
  state.units.set(b.id, b);
  lane.shipIds.push(a.id, b.id);

  renderSelectionPanel();
  const row = textIn(panelEl).find(t => /Lane ▸/.test(t));
  const expected = (UNITS[freighterType].cargoHold || 0) * 2;
  assert.match(row, /2 ships/, `plural expected, got: ${row}`);
  assert.match(row, new RegExp(`${expected} cap/cycle`), `expected ${expected} total capacity, got: ${row}`);
});

test("a ship that no longer exists contributes nothing rather than breaking the row", () => {
  // A lane holds ids, and a ship on it can be destroyed. The capacity reduce() guards for the
  // missing unit; without that guard this panel throws and takes the whole Spaceport screen with
  // it, at exactly the moment a player is most likely to be looking at it.
  const { galaxy } = setupSpaceport();
  const { from, to } = twoWorlds(galaxy);
  const lane = createLane(galaxy, from, to);
  lane.shipIds.push("a-ship-that-was-destroyed");

  assert.doesNotThrow(() => renderSelectionPanel(), "a dead ship id must not break the lane row");
  const row = textIn(panelEl).find(t => /Lane ▸/.test(t));
  assert.match(row, /1 ship\b/, `the lane still lists its assignment, got: ${row}`);
  assert.match(row, /0 cap\/cycle/, `…but contributes no capacity, got: ${row}`);
});

test("only lanes leaving THIS world are listed", () => {
  // g.lanes holds every lane in the galaxy; this panel is one world's Spaceport. Showing another
  // world's outbound shipping here would be a straightforwardly wrong answer.
  const { galaxy } = setupSpaceport();
  const ids = [...galaxy.planets.keys()];
  const here = galaxy.activeId;
  const elsewhere = ids.find(id => id !== here);
  const third = ids.find(id => id !== here && id !== elsewhere);
  createLane(galaxy, here, elsewhere);
  if (third) createLane(galaxy, elsewhere, third);   // a lane that leaves a DIFFERENT world

  renderSelectionPanel();
  const laneRows = textIn(panelEl).filter(t => /Lane ▸/.test(t));
  assert.equal(laneRows.length, 1, `only this world's outbound lane belongs here, got: ${laneRows.join(" | ")}`);
});
