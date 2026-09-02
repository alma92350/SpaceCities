// @ts-check
/* ============================================================
   Fog of war: a coarse grid tracks which cells are currently in sight of
   an owner's unit/building (recomputed fresh every tick) and which have
   ever been seen (permanent, once set). Every owner gets its own grid,
   state.fogs[owner] (engine/sim.js updates all of state.owners' fogs each
   tick, not two hardcoded sides — T-018/ADR-0008) — so no side is
   omniscient; the same createFog/updateFog serves all of them (updateFog
   takes the owner). state.fog/state.fogAI remain as aliases into
   state.fogs.player/state.fogs.ai for the many pre-existing consumers, but
   no engine line reads them directly any more (test/ownerScaffold.test.js).
   See engine/ai.js for how the AI's grid gates its decisions.

   Deliberately scoped to units/buildings only — charted surface deposits
   (data.js) stay visible regardless, treated as known map knowledge, not
   battlefield intel. Hidden caches (map.js) are the exception: they only
   count as known once their cell has been explored (isNodeDiscovered).
   There's no "remembered snapshot" of enemy positions once they leave
   vision — they simply stop rendering (or, for the AI, stop being read).
   ============================================================ */

"use strict";

import { UNITS, BUILDINGS } from "./entities.js";
import { sampleTerrain, sideMod, TERRAIN } from "./map.js";

export const FOG_CELL_SIZE = 40;

// Uphill concealment (docs/improvement-proposals.md "A real LOS pass: low ground can't see onto
// high ground"): a source whose own tile is NOT high ground only reveals a high-ground CELL out
// to this fraction of its normal sight radius — a mesa is a stat pad (extra sight/damage for its
// holder) AND a genuine intelligence blind spot for anyone still down in the lowland, not a free
// look from a comfortable distance. combat.js's acquisition (nearestEnemy/spreadEnemy) imports
// this same constant so "what a lowland unit can see" and "what it can shoot at" agree.
export const UPHILL_FRAC = 0.55;

/** @param {GameMap} map @returns {Fog} */
export function createFog(map) {
  const cols = Math.ceil(map.width / FOG_CELL_SIZE);
  const rows = Math.ceil(map.height / FOG_CELL_SIZE);
  return { cols, rows, explored: new Uint8Array(cols * rows), visible: new Uint8Array(cols * rows) };
}

function cellOf(fog, wx, wy) {
  return { cx: Math.floor(wx / FOG_CELL_SIZE), cy: Math.floor(wy / FOG_CELL_SIZE) };
}

function inBounds(fog, cx, cy) {
  return cx >= 0 && cy >= 0 && cx < fog.cols && cy < fog.rows;
}

/** @param {Fog} fog @param {number} wx @param {number} wy @returns {boolean} */
export function isVisibleAt(fog, wx, wy) {
  const { cx, cy } = cellOf(fog, wx, wy);
  return inBounds(fog, cx, cy) && fog.visible[cy * fog.cols + cx] === 1;
}

/** @param {Fog} fog @param {number} wx @param {number} wy @returns {boolean} */
export function isExploredAt(fog, wx, wy) {
  const { cx, cy } = cellOf(fog, wx, wy);
  return inBounds(fog, cx, cy) && fog.explored[cy * fog.cols + cx] === 1;
}

// Ordinary charted deposits are always known; a hidden cache (map.js) only
// exists for the player once they've scouted its cell. The permanent explored
// memory doubles as the discovery record, so a found cache stays on the map
// even after the scout moves on. Used by render/minimap/input alike so what
// shows, what the minimap dots, and what a right-click can target all agree.
/** @param {Fog} fog @param {ResourceNode} node @returns {boolean} */
export function isNodeDiscovered(fog, node) {
  return !node.hidden || isExploredAt(fog, node.x, node.y);
}

// World point at the centre of the nearest never-explored cell to (fromX, fromY),
// or null when the whole grid has been explored. A row-major scan with a strict
// `<` keeps the pick deterministic (first cell wins a distance tie), so it's safe
// to call from the sim. Shared by the Ranger's scout mode (heads for the nearest
// dark ground to reveal it) and the AI's hunt for a hidden Command Center (sweeps
// unexplored ground when it can see no enemy). Cheap enough at this grid
// resolution to call on demand, and only ever when a new target is needed.
/** @param {Fog} fog @param {number} fromX @param {number} fromY */
export function nearestUnexploredPoint(fog, fromX, fromY) {
  let best = null, bestD = Infinity;
  for (let cy = 0; cy < fog.rows; cy++) {
    for (let cx = 0; cx < fog.cols; cx++) {
      if (fog.explored[cy * fog.cols + cx]) continue;
      const wx = cx * FOG_CELL_SIZE + FOG_CELL_SIZE / 2;
      const wy = cy * FOG_CELL_SIZE + FOG_CELL_SIZE / 2;
      const d = (wx - fromX) * (wx - fromX) + (wy - fromY) * (wy - fromY);
      if (d < bestD) { bestD = d; best = { x: wx, y: wy }; }
    }
  }
  return best;
}

// `terrain` is the map's terrain grid (engine/map.js generateTerrain — cols/rows/cell all shared
// 1:1 with this fog grid, both 40px cells, per TERRAIN_CELL_SIZE's own comment) or undefined for a
// map-less state; `srcHigh` is whether the SOURCE's own tile is high ground (type 2), computed
// once by the caller (updateFog) rather than re-sampled per candidate cell here. A source not on
// high ground reveals a high-ground cell only out to UPHILL_FRAC of `sight` — everything else
// (open/rough ground, or a source that's itself on the high ground) reveals at the full radius.
function reveal(fog, x, y, sight, terrain, srcHigh) {
  const { cx, cy } = cellOf(fog, x, y);
  const reach = Math.ceil(sight / FOG_CELL_SIZE);
  const sightSq = sight * sight;   // compare squared distances — no per-cell sqrt (Math.hypot)
  const uphillCap = sight * UPHILL_FRAC;
  const uphillSq = uphillCap * uphillCap;
  const gyMax = Math.min(fog.rows - 1, cy + reach), gxMax = Math.min(fog.cols - 1, cx + reach);
  for (let gy = Math.max(0, cy - reach); gy <= gyMax; gy++) {
    const row = gy * fog.cols;                                // hoisted out of the inner loop
    const dy = gy * FOG_CELL_SIZE + FOG_CELL_SIZE / 2 - y;
    for (let gx = Math.max(0, cx - reach); gx <= gxMax; gx++) {
      const dx = gx * FOG_CELL_SIZE + FOG_CELL_SIZE / 2 - x;
      const idx = row + gx;
      // Uphill concealment: a high-ground cell (terrain type 2) seen from a NON-high-ground
      // source is compared against the shorter uphill radius instead of the full one.
      const limitSq = (!srcHigh && terrain && terrain.type[idx] === 2) ? uphillSq : sightSq;
      if (dx * dx + dy * dy > limitSq) continue;
      fog.visible[idx] = 1;
      fog.explored[idx] = 1;
    }
  }
}

// Recomputes `visible` from scratch each call (cheap at this grid
// resolution) and folds newly-seen cells permanently into `explored`.
/** @param {State} state @param {Fog} fog @param {string} owner */
export function updateFog(state, fog, owner) {
  fog.visible.fill(0);
  // A world's sight modifier scales every reveal radius (see PLANET_MODIFIERS).
  // Optional-chained so the fog tests' map-less stubs read the default 1.
  const sightMult = sideMod(state, owner, "sightMult");   // per-side on an asymmetric world (updateFog is already called per owner)
  // A source standing on high ground sees farther (terrain sightMult) AND is exempt from the
  // uphill-concealment cap below (srcHigh) — ONE sampleTerrain call per source serves both. OPEN
  // ground and the map-less test stubs read TERRAIN[0] (sightMult 1, never high).
  const terr = state.map?.terrain;
  const srcTerrain = (x, y) => (terr ? sampleTerrain(terr, x, y) : TERRAIN[0]);
  for (const u of state.units.values()) {
    if (u.owner !== owner) continue;
    const t = srcTerrain(u.x, u.y);
    reveal(fog, u.x, u.y, UNITS[u.type].sight * sightMult * t.sightMult, terr, t === TERRAIN[2]);
  }
  for (const b of state.buildings.values()) {
    if (b.owner !== owner) continue;
    const t = srcTerrain(b.x, b.y);
    reveal(fog, b.x, b.y, BUILDINGS[b.type].sight * sightMult * t.sightMult, terr, t === TERRAIN[2]);
  }
}
