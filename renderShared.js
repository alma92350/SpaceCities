/* ============================================================
   Render shared toolkit — the primitives and render-side state every draw
   module needs, kept in one leaf (no engine, no cross-render imports) so the
   node / building / unit / effect draw modules can share them without an import
   cycle:
     • DETAIL — the near-white accent used for hull greebles across both colours.
     • the facing map + frame-to-frame interpolation state (prevPos), with
       snapshotPositions / lerpXY / updateFacing / pruneFacing / resetFacing.
     • pure geometry + colour helpers (hash/seed/shade/hexA/polygon/path/orient).
     • inView culling and the drawHealthBar bar primitive (used by units AND
       buildings).
   Pure render-side bookkeeping — never read by the deterministic sim.
   ============================================================ */

"use strict";

import { game } from "./session.js";

import { isVisibleAt } from "./engine/fog.js";

// A light, near-white accent used for hull details (sensor eyes, canopy
// glass, engine glow, antenna lights) across both players' colors — the
// same "light outline reads at small sizes" reasoning the old triangle
// used, just reused for interior greebles too instead of only the outline.
export const DETAIL = "#dce6ff";

// Facing angle per unit id, inferred frame-to-frame from movement — pure
// render-side bookkeeping, never read by the sim. Shared by every oriented
// unit type (currently Skiff, Bastion and Lancer) so hull/turret art can
// point the way the unit is actually moving. Buildings ("b*" ids) reuse it too
// (a Sentinel Turret's barrel), and they can't collide with unit ("u*") ids.
export const facing = new Map();

// --- render interpolation ---------------------------------------------------
// The sim ticks at a fixed 20 Hz but the screen paints at 60–144 Hz, so drawing raw sim
// positions makes every unit teleport in 50 ms steps. boot.js snapshots each unit's position
// BEFORE each tick (snapshotPositions), the loop hands render the leftover fraction (alpha),
// and we draw at prev + (cur - prev) * alpha — pure render-side smoothing that never touches
// the deterministic sim (drawFrame's "never mutates" contract holds). A unit that JUMPED this
// step (relief spawn, world relocation) moves too far to slide, so we snap it instead.
const prevPos = new Map();     // unit id -> { x, y } at the start of the current tick
const TELEPORT_SQ = 60 * 60;   // a one-tick move past this is a teleport, not motion — don't lerp it
const _lerpPt = { x: 0, y: 0 };   // reused scratch so per-frame interpolation allocates nothing

// Record every live unit's current position as the interpolation baseline. Called by boot.js
// immediately before each tick(); reuses stored objects, so it allocates only for new units.
export function snapshotPositions(state) {
  for (const u of state.units.values()) {
    const p = prevPos.get(u.id);
    if (p) { p.x = u.x; p.y = u.y; } else prevPos.set(u.id, { x: u.x, y: u.y });
  }
}

// The position to DRAW unit `u` at, given the frame's interpolation alpha (0..1). Returns the
// live unit when there's no baseline (a unit spawned this tick), at a full step (alpha ≥ 1), or
// across a teleport; otherwise a reused {x,y} scratch on the prev→cur segment. Read it
// immediately — the scratch is overwritten on the next call.
export function lerpXY(u, alpha) {
  const p = prevPos.get(u.id);
  if (!p || alpha >= 1) return u;
  const dx = u.x - p.x, dy = u.y - p.y;
  if (dx * dx + dy * dy >= TELEPORT_SQ) return u;
  _lerpPt.x = p.x + dx * alpha; _lerpPt.y = p.y + dy * alpha;
  return _lerpPt;
}

// Drop facing entries for entities that no longer exist, so a long match with
// heavy unit churn (or repeated restarts) doesn't grow the Map without bound.
// Cheap: one Map.has per live-or-dead key, and after pruning the Map holds at
// most one entry per currently-live oriented entity.
export function pruneFacing(state) {
  for (const id of facing.keys()) {
    if (!state.units.has(id) && !state.buildings.has(id)) facing.delete(id);
  }
  for (const id of prevPos.keys()) {
    if (!state.units.has(id)) prevPos.delete(id);   // interpolation baselines for dead units
  }
}

// Cleared on a fresh game so orientations/positions from a previous match don't linger.
export function resetFacing() {
  facing.clear();
  prevPos.clear();
}

// Infer and store a unit's facing angle from its frame-to-frame movement; returns the angle so
// an oriented hull can draw pointing the way it's actually moving. A near-stationary unit keeps
// its previous angle EXCEPT when the player has set an explicit one (unit.facing — a real,
// engine-side field set by a click-and-drag move/attack-move, engine/commands.js applyFacing):
// then it snaps to/holds THAT instead, so a formation told to face the enemy actually does once
// it stops, rather than freezing at whatever direction its last step of pathing happened to
// leave it pointing. While actually moving, travel direction still wins — a unit sliding
// sideways while nominally "facing" a fixed angle would read as broken, not deliberate. Buildings
// call it too (a turret barrel, which never sets unit.facing) — the "b*"/"u*" id spaces can't
// collide in the shared map.
export function updateFacing(unit) {
  const prev = facing.get(unit.id);
  const explicit = Number.isFinite(unit.facing);
  let angle = prev ? prev.angle : (explicit ? unit.facing : -Math.PI / 2);
  if (prev) {
    const dx = unit.x - prev.x, dy = unit.y - prev.y;
    if (Math.hypot(dx, dy) > 0.5) angle = Math.atan2(dy, dx);
    else if (explicit) angle = unit.facing;
  }
  facing.set(unit.id, { x: unit.x, y: unit.y, angle });
  return angle;
}

// True when (x,y) — padded by radius r — overlaps the on-screen world rect (viewBounds). Every
// draw module culls off-screen entities with it, so on a big map the draw cost tracks what's
// visible, not total map size.
export function inView(view, x, y, r = 0) {
  return x + r >= view.minX && x - r <= view.maxX && y + r >= view.minY && y - r <= view.maxY;
}

/* ---------- small geometry helpers ---------- */

// Deterministic string hash → seeded PRNG, so each resource node's
// "irregular rock" silhouette is stable frame to frame (derived from its
// id) instead of jittering every draw call like a fresh Math.random() would.
export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
export function seededRng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Lightens (positive percent) or darkens (negative) a "#rrggbb" color, used
// to derive hull-shadow/highlight tones from a player's own color so
// buildings/units read as one paint job rather than a flat single fill.
// NOT memoized, and deliberately so. This is called per building per frame and builds a few
// short-lived strings, so caching on (hex, percent) looks like an easy win — it was tried and
// MEASURED, and it is a loss: the cache key is itself a fresh string per call, which costs more
// than the result it saves. On a 120-building, 306-unit frame the memo took garbage from
// 51.5 KB/frame to 62.2 and the frame from 0.22ms to 0.24. Left plain; test/renderShared.test.js
// pins the returned strings either way, so a future attempt starts from a real baseline.
export function shade(hex, percent) {
  const num = parseInt(hex.slice(1), 16);
  const amt = Math.round(2.55 * percent);
  const clamp = (v) => Math.min(255, Math.max(0, v));
  const r = clamp((num >> 16) + amt);
  const g = clamp(((num >> 8) & 0xff) + amt);
  const b = clamp((num & 0xff) + amt);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

// A "#rrggbb" hex plus an alpha → an "rgba(r,g,b,a)" string, so a fixed palette
// colour can be drawn translucent (the efficiency-zone fills/rings).
export function hexA(hex, alpha) {
  const num = parseInt(hex.slice(1), 16);
  return `rgba(${num >> 16}, ${(num >> 8) & 0xff}, ${num & 0xff}, ${alpha})`;
}

export function polygonPoints(cx, cy, r, sides, rotation = 0) {
  const pts = [];
  for (let i = 0; i < sides; i++) {
    const a = rotation + (i / sides) * Math.PI * 2;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return pts;
}

export function pathPoints(ctx, pts) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
}

// Rotates a local point (nose along +x) by `angle` and places it at (cx,cy)
// — lets oriented-unit shapes be authored once in "facing right" space.
export function toWorld(cx, cy, angle, lx, ly) {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  return [cx + lx * cos - ly * sin, cy + lx * sin + ly * cos];
}
export function pathOriented(ctx, cx, cy, angle, localPts) {
  pathPoints(ctx, localPts.map(([lx, ly]) => toWorld(cx, cy, angle, lx, ly)));
}

// A three-band (green / amber / red) health bar, drawn only when damaged (or forced, e.g. a
// selected unit). Shared by the unit overlay pass and the building bar pass.
export function drawHealthBar(ctx, cx, y, w, hp, maxHp, force = false) {
  if (hp >= maxHp && !force) return;
  const pct = Math.max(0, hp / maxHp);
  ctx.fillStyle = "#243162";
  ctx.fillRect(cx - w / 2, y, w, 3);
  ctx.fillStyle = pct > 0.6 ? "#4ade80" : pct > 0.3 ? "#fbbf24" : "#f87171";
  ctx.fillRect(cx - w / 2, y, w * pct, 3);
}

// Centered text, with the canvas defaults put back afterwards.
//
// The restore is the whole point. textAlign/textBaseline are CANVAS-WIDE state, not per-call
// arguments, so a helper that centers text and walks away shifts every later draw in the frame.
// That is not hypothetical: two sites here shipped without the restore and were invisible
// precisely because drawFrame's outer save/restore papered over them once per frame — the
// mis-aligned text was whatever happened to be drawn NEXT, in a different file. Making the pair
// un-splittable is the only fix that stays fixed.
//
// A caller already inside its own ctx.save()/restore() doesn't need this and can set the state
// directly; this is for the majority that aren't.
/** @param {any} ctx @param {string} text @param {number} x @param {number} y @param {string} font @param {string} [baseline] */
export function centeredText(ctx, text, x, y, font, baseline = "middle") {
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = baseline;
  ctx.fillText(text, x, y);
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
}

// A label on a dark plate, centered on x and sitting with its BASELINE at y — the floating
// annotation the placement ghosts hang above a building footprint (the grid-efficiency readout,
// the Plasma Rig survey verdict). The plate is measured from the text so it always fits, which is
// the part worth having in one place: the two call sites had independently hand-rolled the same
// `measureText → fillRect(x - w/2 - 5, y - 15, w + 10, 17)` arithmetic, and a plate sized by a
// stale constant is a legible label on an illegible background.
//
// Assumes the caller holds a ctx.save() — it leaves font/textAlign/textBaseline/fillStyle set,
// exactly as the inline code it replaces did.
/** @param {any} ctx @param {string} label @param {number} x @param {number} y @param {string} color @param {string} [plate] */
export function drawLabelChip(ctx, label, x, y, color, plate = "rgba(5, 7, 15, 0.78)") {
  ctx.font = "bold 13px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  const w = ctx.measureText(label).width;
  ctx.fillStyle = plate;
  ctx.fillRect(x - w / 2 - 5, y - 15, w + 10, 17);
  ctx.fillStyle = color;
  ctx.fillText(label, x, y);
}

// "Should this entity be drawn at all?" — the fog rule, in one named place.
//
// Four draw passes (units' hulls, units' overlays, buildings' hulls, buildings' bars) each
// carried their own copy of `owner !== "player" && !observerMode && !isVisibleAt(...)`. Every
// clause is easy to get backwards and the failure is silent in the direction that matters: an
// inverted or dropped test doesn't crash or look wrong, it quietly paints the enemy's army
// through the fog. Naming it makes the rule auditable and drivable from a test instead of
// re-derived at four call sites.
//
// observerMode is the self-play/replay camera: it bypasses the gate rather than mutating
// state.fog, so what the player's own fog records is untouched (see observer.js's header).
/** @param {State} state @param {{owner:string}} e @param {number} x @param {number} y @param {boolean} [observerMode] @returns {boolean} */
export function hiddenByFog(state, e, x, y, observerMode = false) {
  return e.owner !== game.localOwner && !observerMode && !isVisibleAt(state.fog, x, y);
}
