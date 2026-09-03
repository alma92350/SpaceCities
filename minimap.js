/* ============================================================
   Minimap: a small fixed-scale top-down view of the whole map, drawn
   into its own canvas each render frame. Same fog/ownership visibility
   rules as the main view (engine/fog.js) — it's a spatial summary of
   what render.js already draws, not a separate source of knowledge.
   ============================================================ */

"use strict";

import { isVisibleAt, isNodeDiscovered, FOG_CELL_SIZE } from "./engine/fog.js";
import { game } from "./session.js";

// The minimap's two heavy layers — the explored-fog wash and the terrain features — were
// re-scanned cell-by-cell EVERY animation frame (16k+ fillRects on a big map, into a 200x125
// canvas where each cell is sub-pixel). Both are static or near-static (terrain never changes
// after generateMap; fog.explored only ever flips false→true), so we render them ONCE into an
// offscreen canvas and blit it each frame, rebuilding it only on a coarse cadence (or a new
// map). Nodes, entity dots and the camera rectangle stay live per-frame. Pure render-side.
let underlay = null, underlayCtx = null, underlayMap = null, underlayW = 0, underlayH = 0, underlayAge = 0;
const UNDERLAY_REFRESH = 12;   // rebuild the static layers at most every ~12 frames (fog growth is slow)

function ensureUnderlay(mmW, mmH) {
  if (underlay && underlayW === mmW && underlayH === mmH) return;
  underlay = document.createElement("canvas");
  underlay.width = mmW; underlay.height = mmH;
  underlayCtx = underlay.getContext("2d");
  underlayW = mmW; underlayH = mmH;
  underlayMap = null;   // size changed → force a rebuild
}

function renderUnderlay(state, mmW, mmH) {
  const c = underlayCtx, { map } = state;
  const sx = mmW / map.width, sy = mmH / map.height;
  c.clearRect(0, 0, mmW, mmH);   // transparent — the main draw fills the backdrop before blitting this

  // Dim wash over ever-explored ground so the minimap reads as "known space" at a glance.
  const fog = state.fog;
  if (fog) {
    c.fillStyle = "rgba(79, 209, 255, 0.06)";
    for (let gy = 0; gy < fog.rows; gy++) {
      const row = gy * fog.cols;
      for (let gx = 0; gx < fog.cols; gx++) {
        if (!fog.explored[row + gx]) continue;
        c.fillRect(gx * FOG_CELL_SIZE * sx, gy * FOG_CELL_SIZE * sy, FOG_CELL_SIZE * sx + 1, FOG_CELL_SIZE * sy + 1);
      }
    }
  }

  // Terrain features — high ground warm, rough ground cool. Feature cells only (OPEN draws nothing).
  const terr = map.terrain;
  if (terr) {
    for (let gy = 0; gy < terr.rows; gy++) {
      const row = gy * terr.cols;
      for (let gx = 0; gx < terr.cols; gx++) {
        const code = terr.type[row + gx];
        if (!code) continue;
        c.fillStyle = code === 2 ? "rgba(255, 209, 102, 0.20)" : "rgba(120, 140, 180, 0.18)";
        c.fillRect(gx * terr.cell * sx, gy * terr.cell * sy, terr.cell * sx + 1, terr.cell * sy + 1);
      }
    }
  }
}

// `pings` (effects.js activePings(), threaded in by boot.js's render callback) and
// `observerMode` are both optional (default none / false), so any other caller that hasn't
// been updated keeps working unchanged. observerMode bypasses every fog/discovery gate below,
// same reasoning as render.js's drawFrame.
export function drawMinimap(ctx, state, camera, viewportW, viewportH, mmW, mmH, pings = [], observerMode = false) {
  const { map } = state;
  const sx = mmW / map.width, sy = mmH / map.height;

  ctx.save();
  ctx.fillStyle = "#05070f";
  ctx.fillRect(0, 0, mmW, mmH);

  // The static/near-static layers, cached and refreshed coarsely (or immediately on a new map).
  ensureUnderlay(mmW, mmH);
  if (underlayMap !== map || ++underlayAge >= UNDERLAY_REFRESH) {
    renderUnderlay(state, mmW, mmH);
    underlayMap = map; underlayAge = 0;
  }
  ctx.drawImage(underlay, 0, 0);

  const fog = state.fog;
  ctx.fillStyle = "#ffd166";
  ctx.globalAlpha = 0.7;
  for (const n of map.nodes) {
    if (n.amount <= 0) continue;
    if (!observerMode && !isNodeDiscovered(fog, n)) continue;   // undiscovered caches don't dot the minimap either
    ctx.fillRect(n.x * sx - 1, n.y * sy - 1, 2, 2);
  }
  ctx.globalAlpha = 1;

  for (const b of state.buildings.values()) {
    if (b.owner !== game.localOwner && !observerMode && !isVisibleAt(fog, b.x, b.y)) continue;
    ctx.fillStyle = state.players[b.owner].color;
    ctx.fillRect(b.x * sx - 2, b.y * sy - 2, 4, 4);
  }
  for (const u of state.units.values()) {
    if (u.owner !== game.localOwner && !observerMode && !isVisibleAt(fog, u.x, u.y)) continue;
    ctx.fillStyle = state.players[u.owner].color;
    ctx.fillRect(u.x * sx - 1, u.y * sy - 1, 2, 2);
  }

  // Attack-ping alert rings (docs/improvement-proposals.md "Attack pings on the minimap plus a
  // jump-to-last-alert key"): a pulsing red ring at each live under-attack ping (effects.js
  // activePings(), which keeps a ping around far longer than the world-space one so a raid on a
  // distant flank is still findable here long after the on-screen banner has faded — input.js's
  // Backspace jump-to-last-alert targets that very same spot). Position is scaled into minimap
  // space the same way every other marker above is (x*sx, y*sy); the radius itself stays in
  // fixed minimap pixels (scaling an already-small ring by sx/sy too would shrink it to
  // sub-pixel). `age` is already a 0 (just fired) -> 1 (about to expire) fraction, from
  // activePings() itself.
  if (pings.length) {
    ctx.strokeStyle = "#f87171";
    ctx.lineWidth = 1.5;
    for (const p of pings) {
      const pulse = (p.age * 7.5) % 1;   // ~4 pulses over the ping's full life, same cadence as the world-space ring
      ctx.globalAlpha = Math.max(0, (1 - pulse) * (1 - p.age));
      ctx.beginPath();
      ctx.arc(p.x * sx, p.y * sy, 3 + pulse * 6, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // Camera viewport rectangle, so the minimap also shows where on the
  // map the main view is currently looking.
  const halfW = viewportW / (2 * camera.zoom), halfH = viewportH / (2 * camera.zoom);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";
  ctx.lineWidth = 1;
  ctx.strokeRect((camera.x - halfW) * sx, (camera.y - halfH) * sy, halfW * 2 * sx, halfH * 2 * sy);

  ctx.restore();
}

export function minimapToWorld(map, mmW, mmH, mx, my) {
  return { x: (mx / mmW) * map.width, y: (my / mmH) * map.height };
}
