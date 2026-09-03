/* ============================================================
   Unit rendering — the per-type vector hulls (Worker, Ranger, Skiff, Bastion,
   …, Freighter, Colony Ship), drawn in two passes (all hulls, then all overlays:
   cargo dot, enemy pip, health bar) so a later hull can't paint out an earlier
   unit's bar. Oriented hulls point the way they're moving (renderShared facing /
   updateFacing) and draw at the interpolated position (lerpXY). The shape
   dispatch (drawUnitShape) is shared with the HUD's button icons (spriteIcon).
   Split out of render.js; drawFrame calls drawUnits.
   ============================================================ */

"use strict";

import { UNITS, rankMults } from "./engine/entities.js";
import { game } from "./session.js";
import { DETAIL, facing, updateFacing, lerpXY, inView, drawHealthBar,
         shade, polygonPoints, pathPoints, toWorld, pathOriented, hiddenByFog } from "./renderShared.js";

/* ---------- units ---------- */

// The unit shape dispatch, factored out of drawUnits so the HUD's button icons render
// the exact same sprite. The caller sets ctx.fillStyle (owner colour) + strokeStyle
// (DETAIL) first, as drawUnits does. Oriented hulls default to facing "up" for a static
// icon (updateFacing has no movement to read).
export function drawUnitShape(ctx, u, def, color) {
  if (u.type === "worker") drawWorker(ctx, u, def, color);
  else if (u.type === "ranger") drawRanger(ctx, u, def, color);
  else if (u.type === "skiff") drawSkiff(ctx, u, def, color);
  else if (u.type === "bastion") drawBastion(ctx, u, def, color);
  else if (u.type === "lancer") drawLancer(ctx, u, def, color);
  else if (u.type === "breacher") drawBreacher(ctx, u, def, color);
  else if (u.type === "dreadnought") drawDreadnought(ctx, u, def, color);
  else if (u.type === "mender") drawMender(ctx, u, def, color);
  else if (u.type === "wraith") drawWraith(ctx, u, def, color);
  else if (u.type === "aegis") drawAegis(ctx, u, def, color);
  else if (u.type === "colossus") drawColossus(ctx, u, def, color);
  else if (u.type === "leviathan") drawLeviathan(ctx, u, def, color);
  else if (u.type === "freighter" || u.type === "hauler" || u.type === "heavyhauler" || u.type === "bulkfreighter") drawFreighter(ctx, u, def, color);
  else if (u.type === "colonyship") drawColonyShip(ctx, u, def, color);
  else if (u.type === "heliumbomb") drawHeliumBomb(ctx, u, def, color);
  else drawGenericUnit(ctx, u, def, color);   // any future unit still gets a silhouette, never an invisible blank
}

// A shallow view of a unit at its interpolated draw position. This used to be ONE module-level
// object refilled with Object.assign — which copies own properties but never DELETES stale ones,
// so any optional field a unit lacks was inherited from whichever unit drew before it. Two visible
// consequences, both reproduced: an INERT Helium Bomb rendered with the armed cue (long red spikes,
// hot core — a safety signal) whenever an armed one drew earlier in the same frame, and an idle
// unit snapped to whatever explicit heading the last click-and-drag had set on some other unit,
// defeating the explicit-facing feature. A fresh spread per unit costs one small object per unit
// per pass and cannot carry anything over.
const dispOf = (u, x, y) => ({ ...u, x, y });
// `selSet` is the current-selection Set, computed ONCE per frame by the caller (render.js
// drawFrame) and passed down here rather than allocated fresh on every call.
// observerMode (default false, so every existing caller/test is unaffected): bypasses the fog
// gate below entirely — Observer Mode's whole point is seeing units regardless of ownership or
// vision, never a mutation of state.fog itself (see observer.js's header comment).
export function drawUnits(ctx, state, view, alpha = 1, selSet, observerMode = false) {
  // Two passes over the same culled set: ALL hulls first, then ALL overlays (health bars,
  // enemy pips, cargo dots). Otherwise, in a dense melee, a unit drawn later paints its hull
  // over an earlier unit's health bar — exactly when the bar matters most. lerp+cull recompute
  // per pass is cheap (a Map.get + a couple of mults) and allocates nothing.
  for (const u of state.units.values()) {
    const d = lerpXY(u, alpha);   // interpolated {x,y} (or the live unit when there's no baseline / a teleport)
    if (view && !inView(view, d.x, d.y, 16)) continue;   // off-screen unit
    if (hiddenByFog(state, u, d.x, d.y, observerMode)) continue;
    const def = UNITS[u.type];
    const color = state.players[u.owner].color;
    ctx.fillStyle = color;
    // A dark outline disappears against the (equally dark) background — it only ever separated
    // overlapping same-color units, never defined the silhouette. A light one keeps the shape
    // crisp at small sizes, where anti-aliasing otherwise blurs a hull's corners into a blob.
    ctx.strokeStyle = DETAIL;
    ctx.lineWidth = 1.5;
    // Draw the hull at the interpolated position via a shallow scratch copy, so every shape
    // helper (and updateFacing, which it calls) sees the smoothed coordinates without threading
    // them through each one. The scratch is reused — no per-unit alloc.
    drawUnitShape(ctx, dispOf(u, d.x, d.y), def, color);
  }
  for (const u of state.units.values()) {
    const d = lerpXY(u, alpha);
    if (view && !inView(view, d.x, d.y, 16)) continue;
    if (hiddenByFog(state, u, d.x, d.y, observerMode)) continue;
    const def = UNITS[u.type];
    if (u.cargo && u.cargo.qty > 0) {
      ctx.beginPath();
      ctx.arc(d.x, d.y - def.radius - 5, 3, 0, Math.PI * 2);
      ctx.fillStyle = "#ffd166";
      ctx.fill();
    }
    // A small downward pip marks hostile units — a SHAPE cue, so telling friend from foe in a
    // melee doesn't rely on the cyan-vs-red colour alone. Friendlies carry no marker.
    if (u.owner !== game.localOwner) drawEnemyPip(ctx, d.x, d.y + def.radius + 6);
    // Veterancy chevrons (docs/improvement-proposals.md "Veterancy ranks"): drawn for EITHER
    // side (an enemy veteran's chevrons are exactly the intel a scout brings back, same as the
    // enemy pip above), and independent of drawHealthBar's own "hide at full hp" rule — a rank
    // is a permanent trait, not a damage state, so it stays visible on a topped-off veteran too.
    const rank = rankMults(u).rank;
    if (rank > 0) drawVeterancyChevrons(ctx, d.x, d.y - def.radius - 13, rank);
    drawHealthBar(ctx, d.x, d.y - def.radius - 9, 16, u.hp, u.maxHp, selSet.has(u.id));
  }
}

// A small stack of upward chevrons, one per veterancy rank, just above the health bar — a
// veteran line reads at a glance without opening its stat panel. Own color (distinct from every
// hull detail/cargo-dot/enemy-pip hue already in play here) so it never blends into whichever
// unit it's stamped over.
const CHEVRON_COLOR = "#a5f3fc";
function drawVeterancyChevrons(ctx, cx, y, rank) {
  ctx.strokeStyle = CHEVRON_COLOR;
  ctx.lineWidth = 1.4;
  for (let i = 0; i < rank; i++) {
    const cy = y - i * 4;
    ctx.beginPath();
    ctx.moveTo(cx - 4, cy + 2);
    ctx.lineTo(cx, cy - 2);
    ctx.lineTo(cx + 4, cy + 2);
    ctx.stroke();
  }
}

export function drawEnemyPip(ctx, x, y) {
  ctx.beginPath();
  ctx.moveTo(x - 4, y - 4);
  ctx.lineTo(x + 4, y - 4);
  ctx.lineTo(x, y + 1);
  ctx.closePath();
  ctx.fillStyle = "#f87171";
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "#05070f";
  ctx.stroke();
}

// Worker — a small hex-bodied utility pod with two stub grabber arms and a
// sensor "eye", reading as a drone rather than a combatant. Unoriented
// (nothing about gathering/building implies a facing), unlike the two
// combat units below.
function drawWorker(ctx, u, def, color) {
  const r = def.radius, cx = u.x, cy = u.y;
  pathPoints(ctx, polygonPoints(cx, cy, r, 6, Math.PI / 6));
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = shade(color, -25);
  ctx.fillRect(cx - r - 2.5, cy - 1.5, 2.5, 3);
  ctx.fillRect(cx + r, cy - 1.5, 2.5, 3);

  ctx.beginPath();
  ctx.arc(cx, cy - r * 0.1, r * 0.3, 0, Math.PI * 2);
  ctx.fillStyle = DETAIL;
  ctx.fill();
}

// Ranger — a light, fast recon craft: a slim forward-swept hull ringed by a
// sensor scanner amidships with a lit eye at the nose, so the scout reads as
// "eyes, not guns" — distinct from the Skiff's winged dart. Oriented, since it's
// almost always on the move charting the map.
function drawRanger(ctx, u, def, color) {
  const angle = updateFacing(u);
  const r = def.radius, L = r * 1.7, W = r * 0.85, cx = u.x, cy = u.y;
  pathOriented(ctx, cx, cy, angle, [
    [L, 0],
    [-L * 0.35, W],
    [-L * 0.7, 0],
    [-L * 0.35, -W],
  ]);
  ctx.fill();
  ctx.stroke();

  ctx.beginPath();                                   // sensor ring — signals its long sight
  ctx.arc(cx, cy, r * 0.55, 0, Math.PI * 2);
  ctx.strokeStyle = DETAIL;
  ctx.lineWidth = 1.1;
  ctx.stroke();

  const [nx, ny] = toWorld(cx, cy, angle, L * 0.5, 0);   // lit scanner eye at the nose
  ctx.beginPath();
  ctx.arc(nx, ny, r * 0.24, 0, Math.PI * 2);
  ctx.fillStyle = DETAIL;
  ctx.fill();
}

// Colony Ship (Odyssey) — a mobile Command Center: the CC's octagonal hull at unit
// scale with a raised central dome so it reads as "a base in transit", and a warm
// engine flare at the stern so its heading is clear. Deploys (engine/colony.js) into
// a real Command Center at its parked spot.
function drawColonyShip(ctx, u, def, color) {
  const angle = updateFacing(u);
  const r = def.radius, cx = u.x, cy = u.y;

  const [fx, fy] = toWorld(cx, cy, angle, -r * 1.35, 0);   // engine flare behind the hull
  ctx.beginPath();
  ctx.arc(fx, fy, r * 0.42, 0, Math.PI * 2);
  ctx.fillStyle = "#ffb454";
  ctx.fill();

  pathPoints(ctx, polygonPoints(cx, cy, r, 8, Math.PI / 8));   // octagon hull (echoes the CC)
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = DETAIL;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.beginPath();                                            // raised central dome
  ctx.arc(cx, cy, r * 0.42, 0, Math.PI * 2);
  ctx.fillStyle = shade(color, 20);
  ctx.fill();
  ctx.strokeStyle = "#05070f";
  ctx.lineWidth = 1;
  ctx.stroke();
}

// Mender — a support drone, not a combatant. A rounded octagonal body carrying
// a bright green medic cross (a fixed heal-green on both sides, so "this one
// heals" reads independent of the friend/foe colour), flanked by two little
// emitter nubs. Unoriented like the Worker — it hovers and mends, it doesn't
// charge — so nothing about it says "gun", which is exactly the point.
const HEAL_GREEN = "#8ef5b0";
function drawMender(ctx, u, def, color) {
  const r = def.radius, cx = u.x, cy = u.y;
  pathPoints(ctx, polygonPoints(cx, cy, r, 8, Math.PI / 8));
  ctx.fill();
  ctx.stroke();

  // Twin emitter nubs at the flanks (where the repair beams would emit from).
  ctx.fillStyle = shade(color, -25);
  ctx.fillRect(cx - r - 2, cy - 1.5, 2.5, 3);
  ctx.fillRect(cx + r - 0.5, cy - 1.5, 2.5, 3);

  // The medic cross — the whole identity of the unit.
  const a = r * 0.72, t = r * 0.26;
  ctx.fillStyle = HEAL_GREEN;
  ctx.fillRect(cx - t / 2, cy - a / 2, t, a);
  ctx.fillRect(cx - a / 2, cy - t / 2, a, t);
}

// A last-resort silhouette for any unit type without a bespoke draw — a small
// diamond with a lit core. Every current roster type has its own drawUnitShape
// case below (test/render-roster.test.js's smoke test enforces this — it fails
// loudly the moment a type's trace matches this fallback's), so this exists
// purely to guarantee the "every entity has a graphical representation"
// invariant for anything added LATER: a new unit can never ship invisible, even
// in the gap before its own bespoke hull lands.
function drawGenericUnit(ctx, u, def, color) {
  const r = def.radius, cx = u.x, cy = u.y;
  pathPoints(ctx, [[cx, cy - r], [cx + r, cy], [cx, cy + r], [cx - r, cy]]);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.3, 0, Math.PI * 2);
  ctx.fillStyle = DETAIL;
  ctx.fill();
}

// Skiff — fast, ranged, cheap: drawn as a slim dart with swept wingtips and
// a lit engine tail, pointing the way it's moving so a mixed army reads at
// a glance and hints at facing mid-fight.
function drawSkiff(ctx, u, def, color) {
  const angle = updateFacing(u);
  const r = def.radius, L = r * 1.6, W = r * 1.1;
  const cx = u.x, cy = u.y;

  pathOriented(ctx, cx, cy, angle, [
    [L, 0],
    [-L * 0.3, W],
    [-L * 0.6, W * 0.35],
    [-L * 0.75, 0],
    [-L * 0.6, -W * 0.35],
    [-L * 0.3, -W],
  ]);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = DETAIL;
  for (const side of [1, -1]) {
    const [ex, ey] = toWorld(cx, cy, angle, -L * 0.7, side * W * 0.35);
    ctx.beginPath();
    ctx.arc(ex, ey, r * 0.16, 0, Math.PI * 2);
    ctx.fill();
  }
}

// Bastion — slow, tanky, short-ranged, bonus damage vs Skiffs: drawn as a
// heavier hull with side turret pods and twin nose cannons, so it reads
// as armored muscle rather than the Skiff's slim dart even at a glance.
function drawBastion(ctx, u, def, color) {
  const angle = updateFacing(u);
  const r = def.radius, L = r * 1.3, W = r * 1.0;
  const cx = u.x, cy = u.y;

  pathOriented(ctx, cx, cy, angle, [
    [L, 0],
    [L * 0.45, W],
    [-L * 0.6, W * 0.85],
    [-L * 0.6, -W * 0.85],
    [L * 0.45, -W],
  ]);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = shade(color, -25);
  for (const side of [1, -1]) {
    const [tx, ty] = toWorld(cx, cy, angle, -L * 0.05, side * W * 0.95);
    ctx.beginPath();
    ctx.arc(tx, ty, r * 0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  ctx.fillStyle = DETAIL;
  for (const side of [1, -1]) {
    const [nx, ny] = toWorld(cx, cy, angle, L * 0.85, side * W * 0.25);
    ctx.beginPath();
    ctx.arc(nx, ny, r * 0.16, 0, Math.PI * 2);
    ctx.fill();
  }
}

// Lancer — long-ranged, armor-piercing, squishier than Bastion: drawn as a
// slender javelin hull with a lit lance-tip and small tail fins, reading as
// a precision skirmisher distinct from Skiff's stubby dart and Bastion's
// armored bulk.
function drawLancer(ctx, u, def, color) {
  const angle = updateFacing(u);
  const r = def.radius, L = r * 2.0, W = r * 0.55;
  const cx = u.x, cy = u.y;

  pathOriented(ctx, cx, cy, angle, [
    [L, 0],
    [L * 0.2, W],
    [-L * 0.7, W * 0.4],
    [-L, 0],
    [-L * 0.7, -W * 0.4],
    [L * 0.2, -W],
  ]);
  ctx.fill();
  ctx.stroke();

  ctx.strokeStyle = DETAIL;
  ctx.lineWidth = 1;
  const [shaftX1, shaftY1] = toWorld(cx, cy, angle, L * 0.9, 0);
  const [shaftX2, shaftY2] = toWorld(cx, cy, angle, -L * 0.3, 0);
  ctx.beginPath();
  ctx.moveTo(shaftX1, shaftY1);
  ctx.lineTo(shaftX2, shaftY2);
  ctx.stroke();

  ctx.fillStyle = DETAIL;
  const [tipX, tipY] = toWorld(cx, cy, angle, L, 0);
  ctx.beginPath();
  ctx.arc(tipX, tipY, r * 0.14, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = shade(color, -25);
  for (const side of [1, -1]) {
    const [fx1, fy1] = toWorld(cx, cy, angle, -L * 0.45, side * W * 0.3);
    const [fx2, fy2] = toWorld(cx, cy, angle, -L * 0.65, side * W * 0.55);
    const [fx3, fy3] = toWorld(cx, cy, angle, -L * 0.85, side * W * 0.25);
    ctx.beginPath();
    ctx.moveTo(fx1, fy1);
    ctx.lineTo(fx2, fy2);
    ctx.lineTo(fx3, fy3);
    ctx.closePath();
    ctx.fill();
  }
}

// Breacher — a wide, low siege chassis CARRYING an oversized gun, where the
// Lancer's whole hull instead IS its javelin. The barrel overhangs the hull
// well past the nose and two recoil spades brace the rear, so it reads as
// artillery hauling a cannon rather than a fighter.
function drawBreacher(ctx, u, def, color) {
  const angle = updateFacing(u);
  const r = def.radius, L = r * 1.2, W = r * 0.9;
  const cx = u.x, cy = u.y;

  pathOriented(ctx, cx, cy, angle, [
    [L * 0.5, W],
    [L * 0.5, -W],
    [-L * 0.7, -W * 0.8],
    [-L * 0.7, W * 0.8],
  ]);
  ctx.fill();
  ctx.stroke();

  ctx.strokeStyle = shade(color, -25);
  ctx.lineWidth = r * 0.3;
  const [bx1, by1] = toWorld(cx, cy, angle, -L * 0.2, 0);
  const [bx2, by2] = toWorld(cx, cy, angle, L * 1.9, 0);
  ctx.beginPath();
  ctx.moveTo(bx1, by1);
  ctx.lineTo(bx2, by2);
  ctx.stroke();

  ctx.fillStyle = shade(color, -25);
  for (const side of [1, -1]) {
    pathOriented(ctx, cx, cy, angle, [
      [-L * 0.6, side * W * 0.45],
      [-L * 0.6, side * W * 0.8],
      [-L, side * W * 0.6],
    ]);
    ctx.fill();
  }

  ctx.fillStyle = DETAIL;
  const [tipX, tipY] = toWorld(cx, cy, angle, L * 1.9, 0);
  ctx.beginPath();
  ctx.arc(tipX, tipY, r * 0.16, 0, Math.PI * 2);
  ctx.fill();
}

// Dreadnought — the Tier-3 capital ship: a big, broad, armoured hull with a
// spinal cannon, four side batteries and a bright command bridge, so it reads
// as a fortress that dwarfs the line units even at a glance.
function drawDreadnought(ctx, u, def, color) {
  const angle = updateFacing(u);
  const r = def.radius, L = r * 1.5, W = r * 1.15;
  const cx = u.x, cy = u.y;

  // Broad angular hull.
  pathOriented(ctx, cx, cy, angle, [
    [L, 0],
    [L * 0.55, W],
    [-L * 0.65, W],
    [-L, W * 0.5],
    [-L, -W * 0.5],
    [-L * 0.65, -W],
    [L * 0.55, -W],
  ]);
  ctx.fill();
  ctx.stroke();

  // Spinal cannon down the centreline.
  ctx.strokeStyle = shade(color, -30);
  ctx.lineWidth = r * 0.35;
  const [sx1, sy1] = toWorld(cx, cy, angle, -L * 0.4, 0);
  const [sx2, sy2] = toWorld(cx, cy, angle, L * 1.35, 0);
  ctx.beginPath(); ctx.moveTo(sx1, sy1); ctx.lineTo(sx2, sy2); ctx.stroke();

  // Four side battery pods.
  ctx.fillStyle = shade(color, -25);
  for (const side of [1, -1]) {
    for (const fx of [0.15, -0.5]) {
      const [px, py] = toWorld(cx, cy, angle, L * fx, side * W * 0.8);
      ctx.beginPath(); ctx.arc(px, py, r * 0.26, 0, Math.PI * 2); ctx.fill();
    }
  }

  // Command bridge glow.
  ctx.fillStyle = DETAIL;
  const [bx, by] = toWorld(cx, cy, angle, -L * 0.25, 0);
  ctx.beginPath(); ctx.arc(bx, by, r * 0.32, 0, Math.PI * 2); ctx.fill();
}

// Wraith — the gas-fuelled glass cannon: a long, forward-swept interceptor with
// wingtips raked back and a hot fusion core amidships, so it reads as the
// fastest, most dangerous, most fragile thing on the field — all engine and gun,
// no armour.
const FUSION = "#ffd166";   // Helium-3 core glow (warm) — distinct from the Mender's heal-green
function drawWraith(ctx, u, def, color) {
  const angle = updateFacing(u);
  const r = def.radius, L = r * 1.9, W = r * 1.2;
  const cx = u.x, cy = u.y;

  pathOriented(ctx, cx, cy, angle, [
    [L, 0],
    [-L * 0.15, W * 0.5],
    [-L * 0.7, W],            // raked-back wingtip
    [-L * 0.5, W * 0.2],
    [-L * 0.85, 0],
    [-L * 0.5, -W * 0.2],
    [-L * 0.7, -W],
    [-L * 0.15, -W * 0.5],
  ]);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = FUSION;                                   // fusion core amidships
  const [gx, gy] = toWorld(cx, cy, angle, -L * 0.08, 0);
  ctx.beginPath(); ctx.arc(gx, gy, r * 0.3, 0, Math.PI * 2); ctx.fill();

  ctx.fillStyle = DETAIL;                                   // lit nose
  const [nx, ny] = toWorld(cx, cy, angle, L * 0.6, 0);
  ctx.beginPath(); ctx.arc(nx, ny, r * 0.16, 0, Math.PI * 2); ctx.fill();
}

// Aegis — the ice-armoured wall: a broad, blocky hull wider than it is long,
// carrying a thick frontal armour plate and only a token gun, so it reads as a
// shield on legs — the anvil the Wraith is the hammer to.
function drawAegis(ctx, u, def, color) {
  const angle = updateFacing(u);
  const r = def.radius, L = r * 1.1, W = r * 1.25;
  const cx = u.x, cy = u.y;

  pathOriented(ctx, cx, cy, angle, [
    [L, W * 0.6],
    [L, -W * 0.6],
    [-L * 0.7, -W],
    [-L, -W * 0.4],
    [-L, W * 0.4],
    [-L * 0.7, W],
  ]);
  ctx.fill();
  ctx.stroke();

  // Thick frontal armour plate, standing just off the nose.
  ctx.strokeStyle = shade(color, -30);
  ctx.lineWidth = r * 0.5;
  const [f1x, f1y] = toWorld(cx, cy, angle, L * 1.05, W * 0.8);
  const [f2x, f2y] = toWorld(cx, cy, angle, L * 1.05, -W * 0.8);
  ctx.beginPath(); ctx.moveTo(f1x, f1y); ctx.lineTo(f2x, f2y); ctx.stroke();

  ctx.fillStyle = DETAIL;
  const [cxx, cyy] = toWorld(cx, cy, angle, -L * 0.2, 0);
  ctx.beginPath(); ctx.arc(cxx, cyy, r * 0.28, 0, Math.PI * 2); ctx.fill();
}

// Colossus — the relic siege engine: a heavy hexagonal chassis behind an
// enormous barrel that overhangs far past the nose (the longest reach on the
// field), with an ancient-tech violet muzzle and core, so it reads as a slow,
// fragile-for-its-size superweapon that must be screened.
const RELIC = "#c4b5fd";   // ancient-tech violet
function drawColossus(ctx, u, def, color) {
  const angle = updateFacing(u);
  const r = def.radius, L = r * 1.3, W = r * 1.05;
  const cx = u.x, cy = u.y;

  pathOriented(ctx, cx, cy, angle, [
    [L * 0.7, W],
    [L, 0],
    [L * 0.7, -W],
    [-L * 0.8, -W],
    [-L, 0],
    [-L * 0.8, W],
  ]);
  ctx.fill();
  ctx.stroke();

  // The oversized barrel — reaches further than any other unit's gun.
  ctx.strokeStyle = shade(color, -30);
  ctx.lineWidth = r * 0.32;
  const [b1x, b1y] = toWorld(cx, cy, angle, -L * 0.3, 0);
  const [b2x, b2y] = toWorld(cx, cy, angle, L * 2.4, 0);
  ctx.beginPath(); ctx.moveTo(b1x, b1y); ctx.lineTo(b2x, b2y); ctx.stroke();

  ctx.fillStyle = RELIC;                                    // muzzle + reactor core in relic-violet
  const [tx, ty] = toWorld(cx, cy, angle, L * 2.4, 0);
  ctx.beginPath(); ctx.arc(tx, ty, r * 0.2, 0, Math.PI * 2); ctx.fill();
  const [cxx, cyy] = toWorld(cx, cy, angle, -L * 0.15, 0);
  ctx.beginPath(); ctx.arc(cxx, cyy, r * 0.3, 0, Math.PI * 2); ctx.fill();
}

// Leviathan — the Strategic-tier endgame flagship: a long twin-spine super-capital hull, broader
// and longer than the Dreadnought (whose 4-battery/single-spine design it deliberately outdoes in
// every cue), so the last ship you ever build is unmistakably the biggest thing on the field. The
// stern tapers into two trailing spine prongs around a V-notch — the "twin-spine" silhouette —
// with a stern engine array glowing in the notch between them (a cue nothing else on the roster
// has), twin spinal cannon lines running the hull's length either side of the centerline (doubling
// the Dreadnought's single spinal cannon), six battery pods (half again the Dreadnought's four),
// and a bigger, outlined command bridge.
function drawLeviathan(ctx, u, def, color) {
  const angle = updateFacing(u);
  const r = def.radius, L = r * 2.0, W = r * 1.3;
  const cx = u.x, cy = u.y;

  // Broad hull, tapering aft into twin trailing spines around a stern notch.
  pathOriented(ctx, cx, cy, angle, [
    [L, 0],
    [L * 0.55, W * 0.85],
    [-L * 0.5, W * 0.85],
    [-L * 0.85, W * 0.55],     // upper spine root
    [-L * 1.15, W * 0.5],      // upper spine tip
    [-L * 0.75, W * 0.08],     // notch inner, upper
    [-L * 0.75, -W * 0.08],    // notch inner, lower
    [-L * 1.15, -W * 0.5],     // lower spine tip
    [-L * 0.85, -W * 0.55],    // lower spine root
    [-L * 0.5, -W * 0.85],
    [L * 0.55, -W * 0.85],
  ]);
  ctx.fill();
  ctx.stroke();

  // Twin spinal cannons — a pair of lines flanking the centreline the full hull length, doubling
  // the Dreadnought's single spinal cannon.
  ctx.strokeStyle = shade(color, -30);
  ctx.lineWidth = r * 0.2;
  for (const off of [1, -1]) {
    const [x1, y1] = toWorld(cx, cy, angle, -L * 0.7, off * W * 0.16);
    const [x2, y2] = toWorld(cx, cy, angle, L * 1.4, off * W * 0.16);
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }

  // Six battery pods (three a side) — half again the Dreadnought's four, outlined as well as
  // filled so they read as mounted turrets rather than flat dots.
  ctx.fillStyle = shade(color, -25);
  ctx.strokeStyle = shade(color, -40);
  ctx.lineWidth = 1;
  for (const side of [1, -1]) {
    for (const fx of [0.35, -0.05, -0.45]) {
      const [px, py] = toWorld(cx, cy, angle, L * fx, side * W * 0.78);
      ctx.beginPath(); ctx.arc(px, py, r * 0.22, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
  }

  // Lit command bridge — bigger than the Dreadnought's, and outlined for extra presence.
  ctx.fillStyle = DETAIL;
  const [bx, by] = toWorld(cx, cy, angle, -L * 0.12, 0);
  ctx.beginPath(); ctx.arc(bx, by, r * 0.34, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = shade(color, -30);
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Stern engine array — three glow points nested in the notch between the twin spines, a cue
  // unique to the Leviathan on the current roster.
  ctx.fillStyle = DETAIL;
  for (const off of [0, 0.42, -0.42]) {
    const [ex, ey] = toWorld(cx, cy, angle, -L * 0.95, off * W);
    ctx.beginPath(); ctx.arc(ex, ey, r * 0.13, 0, Math.PI * 2); ctx.fill();
  }
}

// Freighter — a slow, blocky cargo hauler for the convoy scenarios: a wide hull
// stacked with darker container blocks and a lit bridge at the nose, so it reads
// unmistakably as a civilian freighter to protect, not a warship.
function drawFreighter(ctx, u, def, color) {
  const angle = updateFacing(u);
  const r = def.radius, L = r * 1.5, W = r * 0.95;
  const cx = u.x, cy = u.y;

  pathOriented(ctx, cx, cy, angle, [
    [L, W * 0.45], [L, -W * 0.45],
    [L * 0.6, -W], [-L, -W],
    [-L, W], [L * 0.6, W],
  ]);
  ctx.fill();
  ctx.stroke();

  // Cargo containers stacked down the hull — gold when the freighter is actually laden (a player
  // hand-loaded hold, engine/galaxy.js freight), dim when empty, so a loaded ship reads at a glance.
  const laden = !!(u.freight && Object.keys(u.freight).length);
  ctx.fillStyle = laden ? "#e8b23a" : shade(color, -30);
  for (const fx of [0.35, -0.05, -0.45]) {
    pathOriented(ctx, cx, cy, angle, [
      [L * fx + r * 0.18, W * 0.72], [L * fx + r * 0.18, -W * 0.72],
      [L * fx - r * 0.22, -W * 0.72], [L * fx - r * 0.22, W * 0.72],
    ]);
    ctx.fill();
  }

  ctx.fillStyle = DETAIL;                                   // bridge light at the nose
  const [bx, by] = toWorld(cx, cy, angle, L * 0.82, 0);
  ctx.beginPath(); ctx.arc(bx, by, r * 0.18, 0, Math.PI * 2); ctx.fill();
}

// Helium Bomb — a spiked mine-like orb (engine/entities.js UNITS.heliumbomb, engine/bomb.js
// for the arm/detonate logic). Unoriented, like the Mender: it doesn't face anywhere, it just
// sits there being dangerous. UNARMED reads as inert — short spikes, a dark dead core — safe
// to park anywhere. ARMED has to be unmistakable at a glance, since walking anything (even a
// friendly) into it is the whole hazard: longer, more numerous spikes AND a hot glowing core,
// so the cue survives colourblindness on shape alone, not just the colour swap.
function drawHeliumBomb(ctx, u, def, color) {
  const r = def.radius, cx = u.x, cy = u.y;
  const armed = !!u.armed;

  const spikes = armed ? 10 : 6;
  const spikeLen = armed ? r * 0.65 : r * 0.35;
  ctx.strokeStyle = armed ? "#ff5e3d" : DETAIL;
  ctx.lineWidth = 2;
  for (let i = 0; i < spikes; i++) {
    const a = (i / spikes) * Math.PI * 2;
    const [ix, iy] = toWorld(cx, cy, a, r * 0.9, 0);
    const [ox, oy] = toWorld(cx, cy, a, r * 0.9 + spikeLen, 0);
    ctx.beginPath();
    ctx.moveTo(ix, iy);
    ctx.lineTo(ox, oy);
    ctx.stroke();
  }

  // The body: the owner's colour, so it still reads as a friendly/enemy unit at a glance,
  // armed or not.
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.75, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = DETAIL;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // The core: dark and inert unarmed, a bright hot glow armed — the primary "is this thing
  // live right now" signal, independent of the spike-count cue above.
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.35, 0, Math.PI * 2);
  ctx.fillStyle = armed ? "#ff8a3d" : "#1a2233";
  ctx.fill();
  if (armed) {
    ctx.strokeStyle = "#fff3c4";
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}
