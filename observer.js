/* ============================================================
   Observer Mode: a free-look, read-only spectator over the Odyssey galaxy — and, since
   docs/competitions-and-elo.md Phase 5, over a WATCHED AI-vs-AI exhibition match too. Toggle it
   on (O) to reveal fog on whichever world you're looking at, jump the camera to ANY world or base
   — yours or a neighbour's — for free, and read a live stats panel (observerPanel.js) instead of
   issuing orders.

   WHERE IT'S OFFERED, and why that list is exactly two entries. Observer Mode reveals fog and
   costs nothing, so it is only ever offered for a game the human is NOT playing competitively:
   the Odyssey (a play-forever sandbox with no opponent to cheat) and a spectated match between two
   AI entrants (game.spectateMatch, boot.js's startSpectatedMatch). Offering it in an ordinary
   player-vs-AI skirmish would just be a fog cheat, so enterObserverMode below refuses that case —
   the SAME early return that used to say "Odyssey only", widened by exactly one term.

   Deliberately does not touch `game.state`, `game.galaxy.activeId`, or the real input camera:
   it only changes what gets DRAWN (boot.js's render callback swaps in observedState() + the
   camera below while active) and reads state that's already simulating regardless of what's
   on screen (stepGalaxy advances every world the galaxy is actually running, active or
   backgrounded — see engine/galaxy.js). A world the galaxy ISN'T running yet (a dormant one:
   only a seeded few are alive from turn one) is shown as a throwaway preview instead of being
   woken — see spectateWorld. So exiting always resumes normal play exactly where it was left,
   and nothing here can affect the deterministic sim.

   input.js delegates its mouse/wheel/keydown handlers to the small helpers below while
   game.observerMode is on, instead of running its own selection/order logic against the wrong
   world.
   ============================================================ */

"use strict";

import { game } from "./session.js";
import { createCamera, zoomAt, dragCamera, panCamera, clampCamera } from "./camera.js";
import { canvas } from "./dom.js";
import { archetypeFor } from "./engine/aiArchetypes.js";
import { hostility, stanceLabel, aiDevelopment } from "./engine/diplomacy.js";
import { supplyUsed, supplyCap } from "./engine/supply.js";
import { previewPlanet } from "./engine/galaxy.js";

const DOUBLE_PRESS_MS = 400;   // repeated Space within this window cycles bases, same feel as centerOnBase

// A small duplicate of input.js's own PAN_KEYS (not imported — input.js imports THIS module to
// delegate its handlers here while observing, so importing back the other way would cycle).
const PAN_KEYS = {
  arrowleft: [-1, 0], arrowright: [1, 0], d: [1, 0],
  arrowup: [0, -1], w: [0, -1],
  arrowdown: [0, 1], s: [0, 1],
};

// The world currently being spectated: the real active world's state when observerMode is
// off (so every other module can keep reading this without an `if (game.observerMode)` of its
// own), else whichever world spectateWorld() last pointed at. A watched skirmish has exactly one
// world and no galaxy, so it falls through to game.state — which is already what this returned
// for a galaxy-less session before Phase 5, hence no branch of its own here.
export function observedState() {
  if (game.observerMode && game.galaxy) {
    // A world the galaxy is really simulating wins; a DORMANT one falls back to the pristine
    // preview spectateWorld built for it (see there), and only then to the real active world.
    return game.galaxy.planets.get(game.spectateId) || game.spectatePreview || game.state;
  }
  return game.state;
}

/* ---------- spectate speed (docs/competitions-and-elo.md Phase 5) ---------- */

// The speed ladder a watched or replayed match offers. Powers of two so each rung is an obvious
// doubling, and capped at 8x because engine/loop.js's MAX_SUBSTEPS bounds how much sim a frame can
// carry: at a 60 Hz display 8x needs ~1.3 of the 5 substeps a frame allows, which leaves real
// headroom. (That number was ~2.7 when a spectated match ran at the ordinary 20 Hz sim rate; Phase
// 5's replay work moved it to tools/selfplay.js's own 10 Hz step — the step every recorded row was
// simulated at — which halves the substeps a given speed needs. 16x would still be the wrong rung
// to add: it would sit near the cap on a 30 fps machine and quietly under-deliver.) Past the cap
// the loop degrades to slow motion rather than spiralling (see its own comment) — a bound worth
// staying inside, not one worth riding.
export const SPECTATE_SPEEDS = [1, 2, 4, 8];

// Any input -> a real rung, or 1x. Deliberately NOT a nearest-rung round: an off-ladder value is a
// caller bug or a stale persisted number, and silently promoting 6 to 8 would run the match faster
// than anything on screen claims. 1x is the honest fallback.
export function clampSpectateSpeed(v) {
  return SPECTATE_SPEEDS.includes(v) ? v : 1;
}

// The next rung up, wrapping 8x back to 1x — the "cycle speed" affordance, so one control can walk
// the whole ladder.
export function nextSpectateSpeed(v) {
  const i = SPECTATE_SPEEDS.indexOf(clampSpectateSpeed(v));
  return SPECTATE_SPEEDS[(i + 1) % SPECTATE_SPEEDS.length];
}

// Set the live multiplier boot.js's loop reads (session.js game.spectateSpeed). Always clamped, so
// a bogus value can never reach engine/loop.js at all.
export function setSpectateSpeed(v) {
  game.spectateSpeed = clampSpectateSpeed(v);
}

// Whether a spectate-only affordance (the speed control, the Leave button, the two-seat stats
// panel) applies right now: a watched exhibition match, as opposed to the Odyssey.
export function isSpectatingMatch() {
  return !!game.spectateMatch;
}

// Any completed Command-Center-type building on `state`, regardless of owner — the whole point
// being to also land on a neighbour's capital, not just your own. Sorted by id for a stable
// cycling order (matches input.js's own player-only centerOnBase precedent).
export function findBases(state) {
  return [...state.buildings.values()]
    .filter(b => b.type === "command" && !b.constructing)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

// Where to point the camera at a world we've just started spectating: its first base (any
// owner), else the map's own landing-zone marker, else createCamera's plain map-center default.
function initialFocus(state) {
  const bases = findBases(state);
  if (bases.length) return { x: bases[0].x, y: bases[0].y };
  const at = state.map.bases && (state.map.bases.player || state.map.bases.ai);
  return at ? { x: at.x, y: at.y } : null;
}

function pointCameraAt(state, at) {
  if (!game.observerCamera) return;
  if (at) { game.observerCamera.x = at.x; game.observerCamera.y = at.y; }
  clampCamera(game.observerCamera, state.map, canvas.clientWidth, canvas.clientHeight);
}

let obsBaseCycle = 0, lastObsBaseAt = -Infinity;

export function enterObserverMode() {
  // The one gate (see this file's header): an Odyssey, or a match the human is not playing —
  // networkSpectate (T-037) widens the second half of that to a REAL live network match, not just
  // a local AI-vs-AI exhibition (spectateMatch). A plain skirmish falls through every term and
  // stays un-observable — that would be a fog cheat.
  if (!game.galaxy && !game.spectateMatch && !game.networkSpectate) return;
  if (!game.state && !game.galaxy) return;   // nothing to look at (belt-and-braces: spectateMatch always implies a state)
  if (game.observerMode) return;
  if (game.input) game.input.cancelGesture();   // don't let a drag armed just before this resolve into a real order
  game.observerMode = true;
  game.spectateId = game.galaxy ? game.galaxy.activeId : game.state.planetId;
  game.spectatePreview = null;   // entry always lands on a world that really is simulating (see spectateWorld)
  const real = game.input ? game.input.getCamera() : null;
  // Start exactly where normal play was looking — entering shouldn't jar the view — and only
  // recenter once actual observer navigation (Space / a starmap jump) asks for somewhere else.
  game.observerCamera = real ? { x: real.x, y: real.y, zoom: real.zoom } : createCamera(observedState().map);
  obsBaseCycle = 0; lastObsBaseAt = -Infinity;
}

export function exitObserverMode() {
  if (!game.observerMode) return;
  game.observerMode = false;
  game.spectateId = null;
  game.spectatePreview = null;
  game.observerCamera = null;
}

// The PLAYER-facing "stop observing" (the O key, Esc, the topbar button) — as opposed to
// exitObserverMode above, which is the unconditional teardown boot.js runs while leaving a game.
// Refused for a watched match, and the distinction is the whole point: in the Odyssey, leaving
// Observer Mode returns you to commanding your own world. In an AI-vs-AI exhibition there is
// nothing to return TO — the human commands neither seat — and dropping the delegation would hand
// input.js's ordinary selection/order path an army belonging to one of the two entrants, mid-match.
// So a watched match is observed for as long as it lasts; the spectate bar's Leave button (which
// ends the match and returns to the Competition screen) is the way out.
// Returns whether Observer Mode was actually left.
export function requestExitObserverMode() {
  // T-037: a network spectator has no seat of their own either — same "nothing to return to"
  // reasoning as spectateMatch just above, so the same refusal applies. Leaving a live spectate
  // connection is lobbyScreen.js's own job (closing the transport), never this toggle's.
  if (game.spectateMatch || game.networkSpectate) return false;
  exitObserverMode();
  return true;
}

export function toggleObserverMode() {
  if (game.observerMode) requestExitObserverMode(); else enterObserverMode();
}

// Free jump to any world's camera — no fuel, no canJumpTo gate, no real galaxy.activeId
// change. A no-op unless observerMode is actually on and `id` is a world of this galaxy at all.
//
// "Any world" includes a DORMANT one (engine/galaxy.js BACKGROUND_WORLDS: only a seeded few
// simulate from turn one). There's no live state to look at there, so previewPlanet builds the
// pristine world the player WOULD arrive at and that's what gets shown — read-only, never ticked
// and never registered on the galaxy, so spectating still can't wake a world or otherwise touch
// the sim (this module's header comment). Nothing is happening on a dormant world, and a frozen,
// untouched world is exactly how that reads.
export function spectateWorld(id) {
  if (!game.observerMode || !game.galaxy || !game.galaxy.worlds.includes(id)) return;
  game.spectateId = id;
  game.spectatePreview = game.galaxy.planets.has(id) ? null : previewPlanet(game.galaxy, id);
  obsBaseCycle = 0; lastObsBaseAt = -Infinity;
  const state = observedState();
  pointCameraAt(state, initialFocus(state));
}

// Space, while observing: cycle every completed Command Center on the spectated world, any
// owner — repeated presses within DOUBLE_PRESS_MS advance to the next one, same feel as
// input.js's own centerOnBase.
export function cycleObserverBase() {
  const state = observedState();
  if (!state) return;
  const bases = findBases(state);
  const now = performance.now();
  const cycling = bases.length > 0 && now - lastObsBaseAt < DOUBLE_PRESS_MS;
  lastObsBaseAt = now;
  if (!bases.length) { obsBaseCycle = 0; pointCameraAt(state, initialFocus(state)); return; }
  obsBaseCycle = cycling ? (obsBaseCycle + 1) % bases.length : 0;
  const at = bases[obsBaseCycle];
  pointCameraAt(state, { x: at.x, y: at.y });
}

/* ---------- camera input, delegated to from input.js while observerMode is on ---------- */

// `heldKeys` is input.js's own live Set (tickCamera calls this with it directly) — observer.js
// doesn't track keyboard state of its own, it just reads whichever keys are currently down.
export function tickObserverCamera(dt, heldKeys) {
  const state = observedState();
  if (!state || !game.observerCamera) return;
  let dx = 0, dy = 0;
  for (const key of heldKeys) {
    const dir = PAN_KEYS[key];
    if (dir) { dx += dir[0]; dy += dir[1]; }
  }
  panCamera(game.observerCamera, state.map, canvas.clientWidth, canvas.clientHeight, dx, dy, dt);
}

export function observerWheelZoom(clientX, clientY, rect, factor) {
  const state = observedState();
  if (!state || !game.observerCamera) return;
  zoomAt(game.observerCamera, state.map, rect.width, rect.height, clientX - rect.left, clientY - rect.top, factor);
}

let dragAnchor = null;
export function observerDragStart(clientX, clientY) { dragAnchor = { x: clientX, y: clientY }; }
export function observerDragMove(clientX, clientY) {
  if (!dragAnchor) return;
  const state = observedState();
  if (!state || !game.observerCamera) return;
  const dsx = clientX - dragAnchor.x, dsy = clientY - dragAnchor.y;
  dragAnchor = { x: clientX, y: clientY };
  dragCamera(game.observerCamera, state.map, canvas.clientWidth, canvas.clientHeight, dsx, dsy);
}
export function observerDragEnd() { dragAnchor = null; }

/* ---------- stats panel data (observerPanel.js formats/displays this) ---------- */

// Live unit/building tallies for `state`, grouped by owner then type — the panel's "what does
// this archetype actually field" readout. Plain counts, computed fresh every call (state.units/
// buildings are already live Maps — nothing here is cached or sampled over time; that's the
// analytics/history layer this intentionally doesn't attempt yet).
function tally(map, keyOf) {
  const byOwner = {};
  for (const e of map.values()) {
    const owner = e.owner;
    (byOwner[owner] ||= {});
    const k = keyOf(e);
    byOwner[owner][k] = (byOwner[owner][k] || 0) + 1;
  }
  return byOwner;
}

// A snapshot of everything the panel shows for `state` — pure data, no DOM, so it's directly
// testable and reusable if a future analytics view wants the same numbers on a timer.
//
// TWO AUDIENCES, ONE FUNCTION. In the Odyssey there is a player and ONE neighbour AI, so the
// owner-"ai" fields below (supply/resources/development) are "what the neighbour has" and every
// one of them means exactly what it always did. In a spectated duel (Phase 5) both seats are AI
// entrants and neither is "the AI", so:
//   • `seats` carries the same economy per owner, off state.owners — the honest shape for a
//     two-entrant match, and simply ignored by the Odyssey panel;
//   • `development` degrades to NULL without diplomacy. aiDevelopment (engine/diplomacy.js) does
//     not need state.diplomacy to run — it counts owner "ai"'s finished economic buildings plus
//     its researched techs, both present on any skirmish state — but it is the Odyssey's own
//     development-curve metric for the one neighbour, and reporting it for one seat of a two-seat
//     duel would be a confident number about half the match. Same reasoning docs/competitions-and
//     -elo.md §6 gives for keeping ailab.js's Odyssey-shaped score() out of competitions entirely.
// Every galaxy world carries diplomacy (engine/galaxy.js's spawnPlanet, and persist.js's
// cleanDiplomacy on load), so gating on it leaves the Odyssey panel byte-identical.
export function observerStats(state) {
  const archetype = archetypeFor(state.planetId);
  const dip = state.diplomacy;
  const ai = state.players.ai;
  const units = tally(state.units, u => u.type);
  const buildings = tally(state.buildings, b => b.type);
  return {
    planetId: state.planetId,
    archetypeName: archetype.name,
    faction: archetype.faction,
    stance: dip ? dip.stance : null,
    stanceLabel: dip ? stanceLabel(dip.stance) : null,
    hostility: dip ? hostility(state) : null,
    pacified: !!(dip && dip.pacified),
    units,
    buildings,
    development: dip ? aiDevelopment(state) : null,
    supplyUsed: supplyUsed(state, "ai"),
    supplyCap: supplyCap(state, "ai"),
    resources: ai ? { ...ai.resources } : {},
    // Per-seat, in the state's own canonical owner order (engine/state.js's state.owners), so a
    // two-entrant match reads as two entrants rather than as "the AI" plus "the player".
    seats: (state.owners || []).map(owner => ({
      owner,
      units: units[owner] || {},
      buildings: buildings[owner] || {},
      supplyUsed: supplyUsed(state, owner),
      supplyCap: supplyCap(state, owner),
      resources: state.players[owner] ? { ...state.players[owner].resources } : {},
    })),
  };
}
