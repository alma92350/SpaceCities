/* ============================================================
   Building rendering — the per-type structure silhouettes (Command Center,
   Barracks, Refinery, factories, Turret, …), their health-bar and store-bar
   overlays, and the Odyssey selection cues (jump-staging ring, power grid). The
   shape dispatch (drawBuildingShape) is shared with the HUD's button icons
   (render.js spriteIcon). Split out of render.js; drawFrame calls drawBuildings /
   drawBuildingBars / drawJumpStaging / drawPowerGrid.
   ============================================================ */

"use strict";

import { COM, RECIPES } from "./data.js";
import { game } from "./session.js";
import { BUILDINGS, storeCapOf, storeTotal } from "./engine/entities.js";
import { JUMP_LOAD_RADIUS } from "./engine/galaxy.js";
import { POWER_TIERS, powerThrottle, buildingConcern, recipeOf } from "./engine/industry.js";
import { hashStr } from "./engine/rng.js";
import { DETAIL, facing, shade, hexA, polygonPoints, pathPoints, inView, drawHealthBar, centeredText, hiddenByFog } from "./renderShared.js";
import { drawEnemyPip } from "./renderUnits.js";

/* ---------- buildings ---------- */

// The shape dispatch, factored out of drawBuildings so the HUD's button icons
// (spriteIcon) render the exact same silhouette the map does. The turret (aims at its live
// target) and every ELECTRIFIABLE building (Command Center / Barracks / Habitat / Star Dock —
// their lit-window cue below) read `state`; an icon passes a stub state with empty Maps and no
// `players`/`time`, which is safe here because electrifiedLight bails out before touching either
// unless the building it's drawing is actually electrified — and an icon's stub building never is.
export function drawBuildingShape(ctx, state, b, color) {
  if (b.type === "command") drawCommandCenter(ctx, state, b, color);
  else if (b.type === "barracks") drawBarracks(ctx, state, b, color);
  else if (b.type === "refinery") drawRefinery(ctx, b, color);
  else if (b.type === "foundry") drawFoundry(ctx, b, color);
  else if (b.type === "arsenal") drawArsenal(ctx, b, color);
  else if (b.type === "turret") drawTurret(ctx, state, b, color);
  else if (b.type === "habitat") drawHabitat(ctx, state, b, color);
  else if (b.type === "market") drawMarket(ctx, b, color);
  else if (b.type === "spaceport") drawSpaceport(ctx, b, color);
  else if (b.type === "reactor") drawReactor(ctx, b, color);
  else if (b.type === "combustor") drawCombustor(ctx, b, color);
  else if (b.type === "biomassreactor") drawBiomassReactor(ctx, b, color);
  else if (factoryGlyph(b.type)) drawFactory(ctx, state, b, color);   // Odyssey factories + datacenter/stardock/etc: stamp a function glyph
  else drawGenericBuilding(ctx, b, color);   // any future building still gets a silhouette, never an invisible blank
}

// A small lit cue on an ELECTRIFIED building (Odyssey: Command Center / Barracks / Habitat / Star
// Dock wired into the power grid for +30% — engine/entities.js isElectrifiable, engine/industry.js
// electrifyBoost). Steady gold while the grid can carry its full load; FLICKERING — the same
// throttle that scales the boost itself down, so the light is an honest read of "is this actually
// getting its +30% right now" — whenever it can't, including a dead grid (throttle 0). The flicker
// is deterministic in state.time (this is presentation, not sim, so that's only for a stable
// screenshot/replay-scrub, not a determinism requirement) with a per-building phase (hashStr(b.id))
// so several flickering lights don't blink in lockstep. Draws nothing for a non-electrified
// building — the pre-existing look (a plain DETAIL-coloured fixture, or nothing at all) is
// untouched by this.
function electrifiedLight(ctx, state, b, x, y, r) {
  if (!b.electrified) return;
  let on = true;
  const throttle = powerThrottle(state, b.owner);
  if (throttle < 0.999) {
    const t = state.time * 9 + (hashStr(b.id) % 100);
    on = Math.sin(t) + Math.sin(t * 2.7 + 1.3) * 0.5 > 0.15;   // mostly lit, brief irregular dark beats
  }
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = on ? "#ffd166" : "#3a2f14";   // lit gold, or a dim, currently-unlit fixture
  ctx.fill();
}

// observerMode (default false — every existing caller/test stays byte-identical): bypasses the
// fog gate below, same reasoning as renderUnits.js's drawUnits.
export function drawBuildings(ctx, state, view, observerMode = false) {
  for (const b of state.buildings.values()) {
    if (view && !inView(view, b.x, b.y, b.radius + 12)) continue;   // off-screen (pad for the hp bar above it)
    if (hiddenByFog(state, b, b.x, b.y, observerMode)) continue;
    const color = state.players[b.owner].color;
    ctx.globalAlpha = b.constructing ? 0.5 : b.recycling ? 0.65 : 1;   // ghosted while going up OR coming down

    drawBuildingShape(ctx, state, b, color);

    ctx.globalAlpha = 1;
    // A foe marker under every enemy building, matching the one under enemy units:
    // friend/foe is then a SHAPE cue, not colour alone, so a colourblind player can
    // tell an enemy base from their own without relying on the cyan-vs-red hue.
    if (b.owner !== game.localOwner) drawEnemyPip(ctx, b.x, b.y + b.radius + 8);
  }
}

// Building health bars, drawn in a LATER pass than every hull (see drawFrame) so a ship
// passing over a base no longer paints out the base's bar. `selSet` is the current-selection
// Set — computed ONCE per frame by the caller (drawFrame) and threaded down here, rather than
// each of drawBuildingBars/drawJumpStaging/drawPowerGrid/drawUnits reallocating their own
// `new Set(state.selection)` sixty times a second.
export function drawBuildingBars(ctx, state, view, selSet, observerMode = false) {
  for (const b of state.buildings.values()) {
    if (view && !inView(view, b.x, b.y, b.radius + 12)) continue;
    if (hiddenByFog(state, b, b.x, b.y, observerMode)) continue;
    drawHealthBar(ctx, b.x, b.y - b.radius - 8, b.radius * 2, b.hp, b.maxHp, selSet.has(b.id));
    drawStoreBar(ctx, b);   // a producer's output-buffer gauge, under the hull
    drawConcernBadge(ctx, state, b);   // paused / stalled / throttled flag, own producers only
  }
}

// The paused/stalled/throttled colour legend, shared by drawConcernBadge and any HUD legend that
// wants the exact same read the map uses. "paused" has no glyph string: the Unicode pause symbol
// (⏸) renders as a blank tofu box in Chromium's default sans-serif (no glyph in that font), so its
// badge is hand-drawn (two bars) instead of text — see drawConcernBadge.
const CONCERN_STYLE = {
  paused: { bg: "#2c3560", fg: "#aab4e0" },                // muted — a deliberate player choice, not a problem
  bad: { bg: "#5c1f1f", fg: "#f87171", glyph: "!" },       // stalled outright — nothing is happening
  warn: { bg: "#7a5b12", fg: "#fbbf24", glyph: "⚡" },      // running, just not at full rate
};

// A small badge at a producer's top-right corner flagging "is this actually doing its job right
// now" (engine/industry.js buildingConcern) — paused (muted, a deliberate choice), stalled (red —
// no Power/fuel, starved of an input, or its output buffer is brimming), or power-throttled (gold —
// running under-rate). Own producers only: this exposes internal economic state (what's paused, what's
// starved) that fog-of-war otherwise hides about an opponent's base, matching drawStoreBar's
// player-only scope. Silent for anything running fine, so a healthy base stays uncluttered.
function drawConcernBadge(ctx, state, b) {
  if (b.owner !== game.localOwner) return;
  const concern = buildingConcern(state, b);
  if (!concern) return;
  const style = CONCERN_STYLE[concern.level];
  const r = 6.5, x = b.x + b.radius + 2, y = b.y - b.radius - 8;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = style.bg;
  ctx.fill();
  ctx.strokeStyle = "#05070f";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = style.fg;
  if (style.glyph) {
    centeredText(ctx, style.glyph, x, y + 0.5, "bold 9px sans-serif");
  } else {
    ctx.fillRect(x - 3, y - 2.5, 2, 5);   // paused: two small bars, font-independent
    ctx.fillRect(x + 1, y - 2.5, 2, 5);
  }
}

// A producer's finite output buffer (engine/haul.js) as a gauge UNDER the hull: how
// full it is, gold while there's room, red when it's brimming (production has stalled
// until a worker hauls it off). Only drawn for own producers with something in the
// buffer, so it reads as live logistics pressure without cluttering the field.
function drawStoreBar(ctx, b) {
  const cap = storeCapOf(b.type);
  if (cap <= 0 || b.owner !== game.localOwner) return;
  const total = storeTotal(b);
  if (total <= 0) return;
  const pct = Math.min(1, total / cap);
  const w = b.radius * 2, x = b.x - b.radius, y = b.y + b.radius + 4;
  ctx.fillStyle = "#243162";
  ctx.fillRect(x, y, w, 3);
  ctx.fillStyle = pct >= 0.999 ? "#f87171" : "#fbbf24";   // red = full/stalled, gold = filling
  ctx.fillRect(x, y, w * pct, 3);
}

// The jump staging area around a SELECTED player Spaceport: a dashed ring at
// JUMP_LOAD_RADIUS with a faint fill (the disc whose units ride along on a jump —
// engine/galaxy.js stagedRiders), and a highlight on each unit currently inside it.
// Answers "where do I park units so they come with me?" — drawn only when the
// Spaceport is selected, so it never clutters the map otherwise.
export function drawJumpStaging(ctx, state, view, selSet) {
  for (const b of state.buildings.values()) {
    if (b.type !== "spaceport" || b.owner !== game.localOwner || b.constructing || !selSet.has(b.id)) continue;
    if (view && !inView(view, b.x, b.y, JUMP_LOAD_RADIUS + 8)) continue;

    ctx.save();
    ctx.beginPath();
    ctx.arc(b.x, b.y, JUMP_LOAD_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(120, 200, 255, 0.06)";   // faint disc so the AREA reads
    ctx.fill();
    ctx.setLineDash([9, 6]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(120, 200, 255, 0.7)";
    ctx.stroke();
    ctx.restore();

    // Ring the units that would ride along, so it's clear WHICH entities jump.
    for (const u of state.units.values()) {
      if (u.owner !== game.localOwner) continue;
      if (Math.hypot(u.x - b.x, u.y - b.y) > JUMP_LOAD_RADIUS) continue;
      ctx.beginPath();
      ctx.arc(u.x, u.y, (u.radius || 6) + 3, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(120, 200, 255, 0.85)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
}

// The grid-efficiency tier palette (engine/industry.js POWER_TIERS): the closer a
// factory/rig sits to a Reactor the cheaper it is to power, so these zones tell the
// player WHERE to drop one. Green (on-grid, no loss) → red (isolated, worst). Exported:
// renderEffects.js's drawGhostPowerCue reads it too, for the same tier coloring on a
// build-placement ghost.
export const POWER_TIER_COLOR = { linked: "#4ade80", near: "#a3e635", far: "#fbbf24", isolated: "#f87171" };

// Concentric efficiency zones around one power source at (rx, ry): a faint tinted disc per
// finite band (painted largest-first so each inner band shows its own hue) with a dashed
// boundary ring. `scale` is the source's powerRange — a short-range Generator's zones shrink,
// so its rings sit tighter than a Reactor's. Shared by the selected-source overlay (below) and
// renderEffects.js's build-placement ghost cue — exported for that second caller.
export function drawReactorBands(ctx, rx, ry, scale = 1) {
  const bands = POWER_TIERS.filter(t => Number.isFinite(t.max));
  ctx.save();
  for (let i = bands.length - 1; i >= 0; i--) {        // largest radius first, so inner hues win
    const t = bands[i], col = POWER_TIER_COLOR[t.name];
    ctx.beginPath();
    ctx.arc(rx, ry, t.max * scale, 0, Math.PI * 2);
    ctx.fillStyle = hexA(col, 0.05);
    ctx.fill();
  }
  ctx.setLineDash([8, 7]);
  ctx.lineWidth = 1.5;
  for (const t of bands) {
    ctx.beginPath();
    ctx.arc(rx, ry, t.max * scale, 0, Math.PI * 2);
    ctx.strokeStyle = hexA(POWER_TIER_COLOR[t.name], 0.55);
    ctx.stroke();
  }
  ctx.restore();
}

// The power-grid overlay around a SELECTED player power source (Reactor or Combustion Generator):
// its efficiency zones, so a player can see the on-grid / near / far bands — scaled to the source's
// reach — before placing a factory or rig near it. Drawn only for a selected source (mirrors the
// Spaceport's jump-staging ring), so it never clutters the field otherwise.
export function drawPowerGrid(ctx, state, view, selSet) {
  const outer = POWER_TIERS[POWER_TIERS.length - 2].max;
  for (const b of state.buildings.values()) {
    const def = BUILDINGS[b.type];
    if (!(def && def.energyGrants > 0) || b.owner !== game.localOwner || b.constructing || !selSet.has(b.id)) continue;
    const scale = def.powerRange || 1;
    if (view && !inView(view, b.x, b.y, outer * scale + 8)) continue;
    drawReactorBands(ctx, b.x, b.y, scale);
  }
}

// Command Center — the base's biggest, most "important-looking" structure:
// an octagonal hull, a raised central dome, four corner struts and a
// blinking antenna, so it reads as the hub building even before checking HP.
function drawCommandCenter(ctx, state, b, color) {
  const r = b.radius, cx = b.x, cy = b.y;

  pathPoints(ctx, polygonPoints(cx, cy, r, 8, Math.PI / 8));
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = "#05070f";
  ctx.lineWidth = 2;
  ctx.stroke();

  // Loop-invariant: the same colour for all four struts, so set it once instead of per iteration.
  ctx.fillStyle = shade(color, -25);
  for (const [x, y] of polygonPoints(cx, cy, r * 0.92, 4, Math.PI / 4)) {
    ctx.fillRect(x - 2.5, y - 2.5, 5, 5);
  }

  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.5, 0, Math.PI * 2);
  ctx.fillStyle = shade(color, 20);
  ctx.fill();
  ctx.strokeStyle = "#05070f";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.strokeStyle = DETAIL;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx, cy - r * 0.85);
  ctx.lineTo(cx, cy - r * 1.2);
  ctx.stroke();
  if (b.electrified) {
    electrifiedLight(ctx, state, b, cx, cy - r * 1.2, 2.2);
  } else {
    ctx.beginPath();
    ctx.arc(cx, cy - r * 1.2, 2, 0, Math.PI * 2);
    ctx.fillStyle = DETAIL;
    ctx.fill();
  }

  // The anchored Capital (engine/galaxy.js upgradeToCapital) wears a gold ring, so a
  // fortified, non-jumping Capital reads apart from a normal Command Center at a glance.
  if (b.capital) {
    pathPoints(ctx, polygonPoints(cx, cy, r * 1.3, 8, Math.PI / 8));
    ctx.strokeStyle = "#f2c14e";
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }
}

// Barracks — an angular bunker (a "home plate" silhouette with a pointed
// front) with hangar-door stripes and a radar dish, distinct from the
// Command Center's rounded dome and the Refinery's cylindrical tanks.
function drawBarracks(ctx, state, b, color) {
  const r = b.radius, cx = b.x, cy = b.y, w = r * 1.9, h = r * 1.6;
  pathPoints(ctx, [
    [cx - w / 2, cy - h / 2],
    [cx + w / 2, cy - h / 2],
    [cx + w / 2, cy + h * 0.05],
    [cx, cy + h / 2],
    [cx - w / 2, cy + h * 0.05],
  ]);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = "#05070f";
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = shade(color, -25);
  ctx.fillRect(cx - w * 0.28, cy - h * 0.4, w * 0.16, h * 0.55);
  ctx.fillRect(cx + w * 0.12, cy - h * 0.4, w * 0.16, h * 0.55);

  ctx.strokeStyle = DETAIL;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx + w * 0.4, cy - h / 2);
  ctx.lineTo(cx + w * 0.48, cy - h * 0.75);
  ctx.stroke();
  if (b.electrified) {
    electrifiedLight(ctx, state, b, cx + w * 0.48, cy - h * 0.75, 2.2);
  } else {
    ctx.beginPath();
    ctx.arc(cx + w * 0.48, cy - h * 0.75, 2, 0, Math.PI * 2);
    ctx.fillStyle = DETAIL;
    ctx.fill();
  }
}

// Refinery — a low industrial base with two cylindrical storage tanks
// (each given a highlight stripe to read as round, not just circular
// blobs) joined by a connecting pipe.
function drawRefinery(ctx, b, color) {
  const r = b.radius, cx = b.x, cy = b.y, w = r * 1.7, h = r * 0.9;

  ctx.fillStyle = shade(color, -15);
  ctx.fillRect(cx - w / 2, cy + h * 0.05, w, h * 0.55);
  ctx.strokeStyle = "#05070f";
  ctx.lineWidth = 2;
  ctx.strokeRect(cx - w / 2, cy + h * 0.05, w, h * 0.55);

  ctx.strokeStyle = shade(color, -10);
  ctx.lineWidth = r * 0.35;
  ctx.beginPath();
  ctx.moveTo(cx - w * 0.28, cy);
  ctx.lineTo(cx + w * 0.28, cy);
  ctx.stroke();

  const tankR = r * 0.5;
  for (const tx of [cx - w * 0.28, cx + w * 0.28]) {
    ctx.beginPath();
    ctx.arc(tx, cy - h * 0.1, tankR, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = "#05070f";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.strokeStyle = DETAIL;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(tx - tankR * 0.3, cy - h * 0.1 - tankR * 0.6);
    ctx.lineTo(tx - tankR * 0.3, cy - h * 0.1 + tankR * 0.6);
    ctx.stroke();
  }
}

// Habitat — a small residential dome: a squat foundation slab, a half-dome
// roof and a row of lit windows, so a supply building reads as "people live
// here" rather than as another weapons platform.
function drawHabitat(ctx, state, b, color) {
  const r = b.radius, cx = b.x, cy = b.y, w = r * 1.8, h = r * 0.9;
  ctx.fillStyle = shade(color, -20);
  ctx.fillRect(cx - w / 2, cy, w, h * 0.7);
  ctx.strokeStyle = "#05070f"; ctx.lineWidth = 2;
  ctx.strokeRect(cx - w / 2, cy, w, h * 0.7);

  ctx.beginPath();
  ctx.arc(cx, cy, w * 0.42, Math.PI, 0);
  ctx.closePath();
  ctx.fillStyle = color; ctx.fill(); ctx.stroke();

  ctx.fillStyle = DETAIL;
  for (const dx of [-w * 0.25, 0, w * 0.25]) ctx.fillRect(cx + dx - 1.5, cy + h * 0.2, 3, 3);

  // Electrified (Odyssey): wired into the power grid for +30% supply capacity
  // (engine/industry.js electrifyBoost, toggled in hudSelection.js) — a small lit dot inside the
  // dome, so a powered Habitat reads at a glance without opening its panel.
  electrifiedLight(ctx, state, b, cx, cy - w * 0.42 * 0.55, Math.max(1.8, r * 0.16));
}

// Market — an open-air trading stall: a striped, scalloped awning over a counter
// stocked with goods, so the building that opens the commodity panel reads as a
// bazaar at a glance, distinct from every other building's bunkers and tanks.
function drawMarket(ctx, b, color) {
  const r = b.radius, cx = b.x, cy = b.y, w = r * 2.1, h = r * 1.5;
  const awningTop = cy - h * 0.62, awningBot = cy - h * 0.32;
  const counterY = cy + h * 0.04, counterH = h * 0.32;

  // Support poles — full height, so the counter and awning (drawn over them below)
  // read as resting ON the poles rather than floating.
  ctx.strokeStyle = shade(color, -30);
  ctx.lineWidth = Math.max(1.5, r * 0.14);
  for (const px of [cx - w * 0.4, cx + w * 0.4]) {
    ctx.beginPath();
    ctx.moveTo(px, awningTop + h * 0.05);
    ctx.lineTo(px, counterY + counterH);
    ctx.stroke();
  }

  // Counter — the table the goods sit on.
  ctx.fillStyle = shade(color, -18);
  ctx.fillRect(cx - w / 2, counterY, w, counterH);
  ctx.strokeStyle = "#05070f"; ctx.lineWidth = 1.5;
  ctx.strokeRect(cx - w / 2, counterY, w, counterH);

  // Wares on the counter, in the same gold the trade panel prices credits with —
  // standing for "everything here is for sale."
  ctx.fillStyle = "#f2c14e";
  for (const dx of [-w * 0.26, 0, w * 0.26]) ctx.fillRect(cx + dx - 2, counterY - 2.6, 4, 4);

  // Awning — a scalloped canopy in alternating stripes, the stall's signature silhouette.
  const teeth = 3, tw = w / teeth;
  for (let i = 0; i < teeth; i++) {
    const x0 = cx - w / 2 + i * tw;
    pathPoints(ctx, [
      [x0, awningTop], [x0 + tw, awningTop], [x0 + tw, awningBot],
      [x0 + tw / 2, awningBot + h * 0.12], [x0, awningBot],
    ]);
    ctx.fillStyle = i % 2 === 0 ? color : shade(color, -18);
    ctx.fill();
    ctx.strokeStyle = "#05070f"; ctx.lineWidth = 1;
    ctx.stroke();
  }

  // A small trade pennant above the canopy peak — the building's one distinguishing
  // top accent, the same idiom as the Command Center's antenna or the Barracks' dish.
  ctx.strokeStyle = DETAIL; ctx.lineWidth = 1.3;
  ctx.beginPath();
  ctx.moveTo(cx, awningTop);
  ctx.lineTo(cx, awningTop - h * 0.3);
  ctx.stroke();
  pathPoints(ctx, [[cx, awningTop - h * 0.3], [cx + w * 0.22, awningTop - h * 0.2], [cx, awningTop - h * 0.1]]);
  ctx.fillStyle = "#f2c14e";
  ctx.fill();
}

// Foundry — the Tier-2 war-smeltery that unlocks the Lancer and Breacher: an
// industrial hall under a sawtooth factory roofline, a tall smokestack tipped
// with a hot ember and a molten forge vent glowing orange through its face, so
// the building that opens the advanced units reads as a working forge — not
// just another bunker.
function drawFoundry(ctx, b, color) {
  const r = b.radius, cx = b.x, cy = b.y, w = r * 2.0, h = r * 1.4;

  ctx.fillStyle = color;                                       // main hall
  ctx.fillRect(cx - w / 2, cy - h * 0.2, w, h * 0.7);
  ctx.strokeStyle = "#05070f"; ctx.lineWidth = 2;
  ctx.strokeRect(cx - w / 2, cy - h * 0.2, w, h * 0.7);

  const teeth = 3, tw = w / teeth;                             // sawtooth roof
  for (let i = 0; i < teeth; i++) {
    const x0 = cx - w / 2 + i * tw;
    pathPoints(ctx, [[x0, cy - h * 0.2], [x0, cy - h * 0.52], [x0 + tw, cy - h * 0.2]]);
    ctx.fillStyle = shade(color, -20); ctx.fill();
    ctx.strokeStyle = "#05070f"; ctx.lineWidth = 1; ctx.stroke();
  }

  ctx.fillStyle = "#ff8c42";                                   // molten forge vent
  ctx.fillRect(cx - w * 0.18, cy + h * 0.08, w * 0.36, h * 0.24);

  ctx.fillStyle = shade(color, -30);                           // smokestack
  ctx.fillRect(cx + w * 0.3, cy - h * 0.78, w * 0.15, h * 0.6);
  ctx.strokeStyle = "#05070f"; ctx.lineWidth = 1.5;
  ctx.strokeRect(cx + w * 0.3, cy - h * 0.78, w * 0.15, h * 0.6);
  ctx.beginPath();                                             // ember at the stack tip
  ctx.arc(cx + w * 0.375, cy - h * 0.8, 2.2, 0, Math.PI * 2);
  ctx.fillStyle = "#ffd166"; ctx.fill();
}

// Arsenal — the Tier-3 weapons manufactory that unlocks the Dreadnought capital
// ship: a squat armoured bunker with chamfered corners, a reinforced cap, a rack
// of stubby missile tubes on the roof and a lit reactor core, so the top of the
// tech tree reads as the most fortified, most militarised structure on the field.
function drawArsenal(ctx, b, color) {
  const r = b.radius, cx = b.x, cy = b.y, w = r * 1.9, h = r * 1.5, ch = r * 0.5;

  pathPoints(ctx, [                                            // chamfered armoured hull
    [cx - w / 2 + ch, cy - h * 0.35], [cx + w / 2 - ch, cy - h * 0.35],
    [cx + w / 2, cy - h * 0.35 + ch], [cx + w / 2, cy + h * 0.4 - ch],
    [cx + w / 2 - ch, cy + h * 0.4], [cx - w / 2 + ch, cy + h * 0.4],
    [cx - w / 2, cy + h * 0.4 - ch], [cx - w / 2, cy - h * 0.35 + ch],
  ]);
  ctx.fillStyle = color; ctx.fill();
  ctx.strokeStyle = "#05070f"; ctx.lineWidth = 2; ctx.stroke();

  ctx.fillStyle = shade(color, -22);                           // reinforced cap
  ctx.fillRect(cx - w * 0.3, cy - h * 0.5, w * 0.6, h * 0.18);
  ctx.strokeStyle = "#05070f"; ctx.lineWidth = 1;
  ctx.strokeRect(cx - w * 0.3, cy - h * 0.5, w * 0.6, h * 0.18);

  ctx.fillStyle = shade(color, -35);                           // roof missile tubes
  for (const dx of [-w * 0.2, 0, w * 0.2]) ctx.fillRect(cx + dx - 2, cy - h * 0.62, 4, h * 0.16);

  ctx.beginPath();                                             // lit reactor core
  ctx.arc(cx, cy + h * 0.02, r * 0.34, 0, Math.PI * 2);
  ctx.fillStyle = shade(color, 25); ctx.fill();
  ctx.strokeStyle = "#05070f"; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy + h * 0.02, r * 0.15, 0, Math.PI * 2);
  ctx.fillStyle = DETAIL; ctx.fill();
}

// Reactor — the grid's primary power source: a tapered cooling-tower hull (a pulled-in waist,
// echoing the real thing) on a squat foundation, with a lit core glowing at its base. It's the
// GRID itself, not a recipe factory, so it earns its own bespoke hull here — same art tier as the
// Foundry/Arsenal above — instead of sharing the glyph-disc hex every recipe factory uses below
// (drawFactory). `lit` mirrors hudSelection.js's own "is it actually fed" read (`!paused &&
// powered`, set by engine/industry.js updateCombustors from the Reactor's own fuel larder): bright
// gold while burning fuel, the same dim fixture color electrifiedLight uses for "currently unlit"
// while dry or paused — so a dead grid reads off the hull, not just the corner concern badge.
function drawReactor(ctx, b, color) {
  const r = b.radius, cx = b.x, cy = b.y;

  ctx.fillStyle = shade(color, -25);                            // foundation slab
  ctx.fillRect(cx - r * 0.9, cy + r * 0.55, r * 1.8, r * 0.35);
  ctx.strokeStyle = "#05070f"; ctx.lineWidth = 2;
  ctx.strokeRect(cx - r * 0.9, cy + r * 0.55, r * 1.8, r * 0.35);

  const top = cy - r * 1.15, bot = cy + r * 0.6;                // hourglass tower: wide rim/base, pulled-in waist
  pathPoints(ctx, [
    [cx - r * 0.8, bot], [cx - r * 0.32, cy - r * 0.05], [cx - r * 0.55, top],
    [cx + r * 0.55, top], [cx + r * 0.32, cy - r * 0.05], [cx + r * 0.8, bot],
  ]);
  ctx.fillStyle = color; ctx.fill();
  ctx.strokeStyle = "#05070f"; ctx.lineWidth = 2; ctx.stroke();

  ctx.strokeStyle = shade(color, 18); ctx.lineWidth = 1;        // waist highlight so the taper reads round, not folded
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.28, cy - r * 0.5);
  ctx.lineTo(cx - r * 0.28, cy + r * 0.3);
  ctx.stroke();

  const lit = !b.paused && b.powered;
  ctx.beginPath();                                              // the lit core
  ctx.arc(cx, cy + r * 0.2, r * 0.3, 0, Math.PI * 2);
  ctx.fillStyle = lit ? "#ffd166" : "#3a2f14";
  ctx.fill();
  ctx.strokeStyle = "#05070f"; ctx.lineWidth = 1.5; ctx.stroke();
}

// Combustion Generator — the cheap fuel-burning alternative to the Reactor: a squat housing and a
// fuel tank under a single stack tipped with a flame. The flare is lit only while its own larder is
// actually feeding it (same `lit` read as the Reactor's core above); it goes to cold embers on an
// empty larder or a paused generator, so a dead backup grid reads off the hull too.
function drawCombustor(ctx, b, color) {
  const r = b.radius, cx = b.x, cy = b.y, w = r * 1.6, h = r * 0.85;

  ctx.fillStyle = color;                                        // housing
  ctx.fillRect(cx - w / 2, cy + h * 0.1, w, h * 0.6);
  ctx.strokeStyle = "#05070f"; ctx.lineWidth = 2;
  ctx.strokeRect(cx - w / 2, cy + h * 0.1, w, h * 0.6);

  ctx.fillStyle = shade(color, -30);                            // a fuel tank beside the stack
  ctx.beginPath();
  ctx.arc(cx - w * 0.26, cy + h * 0.28, r * 0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#05070f"; ctx.lineWidth = 1.5; ctx.stroke();

  const stackX = cx + w * 0.18, stackW = w * 0.28, stackTop = cy - r * 1.05;
  ctx.fillStyle = shade(color, -20);                            // the stack itself
  ctx.fillRect(stackX - stackW / 2, stackTop, stackW, cy + h * 0.1 - stackTop);
  ctx.strokeStyle = "#05070f"; ctx.lineWidth = 1.5;
  ctx.strokeRect(stackX - stackW / 2, stackTop, stackW, cy + h * 0.1 - stackTop);

  const lit = !b.paused && b.powered;
  pathPoints(ctx, [                                             // the flare — a teardrop lit only while actually burning fuel
    [stackX, stackTop - r * 0.55], [stackX + stackW * 0.6, stackTop - r * 0.05],
    [stackX, stackTop + r * 0.15], [stackX - stackW * 0.6, stackTop - r * 0.05],
  ]);
  ctx.fillStyle = lit ? "#ff8c42" : "#3a2412";
  ctx.fill();
  ctx.strokeStyle = "#05070f"; ctx.lineWidth = 1; ctx.stroke();
  if (lit) {
    ctx.beginPath();                                            // a hot inner core to the flame
    ctx.arc(stackX, stackTop - r * 0.15, stackW * 0.22, 0, Math.PI * 2);
    ctx.fillStyle = "#ffd166"; ctx.fill();
  }
}

// Biomass Reactor — the Combustion Generator's biomass-burning sibling: a rounded vat instead of a
// hard-edged tank, glowing green while its larder is actually feeding it (same `lit` read as its
// two siblings above), dull and murky when dry or paused. Organic where the Reactor and Combustion
// Generator read mechanical, so the three power buildings stay distinguishable from EACH OTHER
// too, not just from the recipe factories they no longer share a silhouette with.
function drawBiomassReactor(ctx, b, color) {
  const r = b.radius, cx = b.x, cy = b.y;

  ctx.fillStyle = shade(color, -22);                            // collar foundation
  ctx.beginPath();
  ctx.ellipse(cx, cy + r * 0.58, r * 0.85, r * 0.26, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#05070f"; ctx.lineWidth = 1.5; ctx.stroke();

  ctx.beginPath();                                              // the vat body — a rounded-top tank, not a hard box
  ctx.moveTo(cx - r * 0.72, cy + r * 0.5);
  ctx.lineTo(cx - r * 0.62, cy - r * 0.6);
  ctx.quadraticCurveTo(cx, cy - r * 1.05, cx + r * 0.62, cy - r * 0.6);
  ctx.lineTo(cx + r * 0.72, cy + r * 0.5);
  ctx.closePath();
  ctx.fillStyle = color; ctx.fill();
  ctx.strokeStyle = "#05070f"; ctx.lineWidth = 2; ctx.stroke();

  const lit = !b.paused && b.powered;
  ctx.beginPath();                                              // the biomass glow, filling most of the vat
  ctx.ellipse(cx, cy - r * 0.05, r * 0.4, r * 0.5, 0, 0, Math.PI * 2);
  ctx.fillStyle = lit ? "#7ed957" : "#233a1c";
  ctx.fill();

  ctx.strokeStyle = lit ? "#c8f7a8" : shade(color, -12);        // rising bubbles, brighter while actually fed
  ctx.lineWidth = 1.2;
  for (const dx of [-r * 0.14, r * 0.16]) {
    ctx.beginPath();
    ctx.moveTo(cx + dx, cy + r * 0.28);
    ctx.lineTo(cx + dx, cy - r * 0.32);
    ctx.stroke();
  }
}

// A last-resort silhouette for any building type without a bespoke draw — a
// hexagonal hull with a lit core. Nothing on the current roster falls through
// to it (every type above is handled), but it guarantees the "every entity has
// a graphical representation" invariant holds for anything added later, so a new
// building can never ship as an invisible click target.
// recipe id -> the commodity it OUTPUTS (data.js RECIPES), so a factory can show what it makes.
const RECIPE_OUT = Object.fromEntries(RECIPES.map(r => [r.id, r.out]));

// A distinguishing glyph for buildings that otherwise share the plain hex silhouette. A
// recipe-running factory shows the commodity it OUTPUTS; a handful of non-recipe industrial
// buildings get an explicit emoji for what they DO — the Datacenter runs research (🔬), the
// Stardock is a capital-ship yard (🛰️), the Antimatter Gate is the wonder (🌀), the Plasma Rig digs
// (⛏️), the Substation relays the grid (🔌, engine/entities.js `powerRelay`). The static-defense
// ladder's two non-turret rungs get one too — the Bastille a heavy emplacement (🏰), the Aegis
// Bastion its guard-aura emblem (🔰) — and the Torpedo Battery shows the same icon as the
// commodity it fires (💥 plasmatorp, data.js COM), matching "a factory shows what it makes"'s
// spirit even though it consumes rather than produces that good. The Reactor / Combustion
// Generator / Biomass Reactor are the grid itself, not a recipe factory sharing this hex — they
// get their own bespoke hulls (drawReactor/drawCombustor/drawBiomassReactor above), dispatched in
// drawBuildingShape before this glyph fallback ever sees them.
// A glyph must not collide with the COMMODITY icon a factory producing that good already draws
// (factoryGlyph below falls back to COM[recipe.out].ico). Two did, and the result was two pairs of
// buildings rendered byte-identically in hull, glyph and colour, differing only in radius:
// the Antimatter Gate — the Odyssey WONDER, a victory condition — was a slightly larger Antimatter
// Forge, and the Torpedo Battery, a gun that shoots back, was a smaller Torpedo Works. Guarded now
// by a pairwise silhouette test (test/render-roster.test.js), so a future glyph can't re-collide.
const BUILDING_GLYPH = {
  datacenter: "🔬", stardock: "🛰️", antimatter_gate: "🌌", plasmarig: "⛏️", substation: "🔌",
  bastille: "🏰", aegisbastion: "🔰", torpedobattery: "🎯",
};
function factoryGlyph(type) {
  const def = BUILDINGS[type];
  if (def && def.recipe && RECIPE_OUT[def.recipe]) return COM[RECIPE_OUT[def.recipe]]?.ico || null;
  return BUILDING_GLYPH[type] || null;
}

// True for a genuinely productive recipe factory THIS frame: completed (not still going up or
// coming down), not paused, and buildingConcern (engine/industry.js — the exact same read
// drawConcernBadge uses for the corner badge) comes back clean — no stall, no starvation, no
// power throttle to flag. Checked independently of buildingConcern's OWN null cases rather than
// trusting a bare `=== null`: buildingConcern also reads null while constructing/recycling
// (nothing to flag yet — not the same as "running") and for any building without a recipe/rig at
// all (nothing to concern-check — also not "running"), so both are excluded here explicitly.
// Guards a missing `state.players` too: render.js's spriteIcon draws every building type —
// including every recipe factory — through a stub state with no players/time/owner at all
// (render.js:76), and buildingConcern reaches into state.players[owner] unconditionally once past
// this function's own recipe check.
function isRunningFactory(state, b) {
  if (b.constructing || b.recycling || b.paused) return false;
  if (!b.owner || !state.players) return false;
  if (!recipeOf(b)) return false;   // scoped to recipe-running factories — not the Rig, not a wonder, not a relay
  return buildingConcern(state, b) === null;
}

// A subtle "this factory is actually working" glow behind its glyph disc — the positive
// counterpart to drawConcernBadge's silence-when-fine: a badge only ever appears when something's
// WRONG, so a healthy producer used to look identical to an idle one. Only ever called for a
// genuinely running recipe factory (isRunningFactory above). Phased by hashStr(b.id) so a base full
// of factories doesn't breathe in lockstep, and driven by state.time, never a wall-clock — the same
// deterministic-presentation idiom electrifiedLight uses just above.
function drawWorkPulse(ctx, state, b, r) {
  const t = state.time * 1.4 + (hashStr(b.id) % 100) * 0.15;
  const glow = 0.5 + Math.sin(t) * 0.5;   // 0..1, slow breathing cycle
  ctx.beginPath();
  ctx.arc(b.x, b.y, r * 0.6 + 1.5 + glow * 1.5, 0, Math.PI * 2);
  ctx.strokeStyle = hexA("#8fd3ff", 0.25 + glow * 0.35);
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

// Every recipe-running factory (Smelter, Assembly Plant, Chip Fab, …) and the remaining non-recipe
// industrial buildings (Datacenter, Star Dock, Antimatter Gate, Plasma Rig, Substation) otherwise
// share the plain hex silhouette below — indistinguishable on the map and in the build menu. Stamp
// the building's glyph (its product's emoji, or the explicit icon) on a dark disc so each reads at
// a glance as what it does. Keyed on the building TYPE, so the HUD button icon (spriteIcon renders
// this same shape) gets the glyph too. A RECIPE factory that's actually running right now gets a
// slow work-pulse glow behind its disc as well (isRunningFactory/drawWorkPulse above) — the
// positive read a silent concern badge alone can't give you.
function drawFactory(ctx, state, b, color) {
  drawGenericBuilding(ctx, b, color);
  // Electrified (Odyssey): only the Star Dock among everything sharing this silhouette is
  // ELECTRIFIABLE (engine/entities.js isElectrifiable) — a lit beacon above the hex, same cue as
  // the Command Center/Barracks/Habitat. electrifiedLight no-ops for every other type here (their
  // `electrified` flag is never set), so this is safe to call unconditionally.
  electrifiedLight(ctx, state, b, b.x, b.y - b.radius * 0.85, 2.2);
  const ico = factoryGlyph(b.type);
  if (!ico) return;
  const r = b.radius;
  if (isRunningFactory(state, b)) drawWorkPulse(ctx, state, b, r);
  ctx.beginPath();
  ctx.arc(b.x, b.y, r * 0.6, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(5,7,15,0.74)"; ctx.fill();
  centeredText(ctx, ico, b.x, b.y, `${Math.round(r * 0.95)}px sans-serif`);
}

function drawGenericBuilding(ctx, b, color) {
  const r = b.radius, cx = b.x, cy = b.y;
  pathPoints(ctx, polygonPoints(cx, cy, r, 6, Math.PI / 6));
  ctx.fillStyle = color; ctx.fill();
  ctx.strokeStyle = "#05070f"; ctx.lineWidth = 2; ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.4, 0, Math.PI * 2);
  ctx.fillStyle = shade(color, 20); ctx.fill();
  ctx.strokeStyle = "#05070f"; ctx.lineWidth = 1; ctx.stroke();
}

// Spaceport — a round launch pad ringed by a gantry with an upright rocket
// standing on it, so the "leave this world" building reads at a glance.
function drawSpaceport(ctx, b, color) {
  const r = b.radius, cx = b.x, cy = b.y;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = color; ctx.fill();
  ctx.strokeStyle = "#05070f"; ctx.lineWidth = 2; ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, r * 0.66, 0, Math.PI * 2);
  ctx.strokeStyle = shade(color, -30); ctx.lineWidth = 3; ctx.stroke();

  const bw = r * 0.26, bh = r * 0.92;                     // upright rocket body
  ctx.fillStyle = DETAIL;
  ctx.beginPath();
  ctx.moveTo(cx, cy - bh);
  ctx.lineTo(cx + bw, cy - bh * 0.4);
  ctx.lineTo(cx + bw, cy + bh * 0.5);
  ctx.lineTo(cx - bw, cy + bh * 0.5);
  ctx.lineTo(cx - bw, cy - bh * 0.4);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = shade(color, -20);                     // fins
  ctx.beginPath();
  ctx.moveTo(cx - bw, cy + bh * 0.12); ctx.lineTo(cx - bw * 2.1, cy + bh * 0.5); ctx.lineTo(cx - bw, cy + bh * 0.5); ctx.closePath();
  ctx.moveTo(cx + bw, cy + bh * 0.12); ctx.lineTo(cx + bw * 2.1, cy + bh * 0.5); ctx.lineTo(cx + bw, cy + bh * 0.5); ctx.closePath();
  ctx.fill();

  // Tier pips (1–3): the launch pad's jump-capacity rank (engine/galaxy.js), so a bigger
  // Spaceport reads at a glance on the map.
  const tier = Math.min(3, Math.max(1, b.tier || 1));
  const pipR = r * 0.11, gap = pipR * 2.6, py = cy + r * 0.66;
  for (let i = 0; i < tier; i++) {
    const px = cx + (i - (tier - 1) / 2) * gap;
    ctx.beginPath(); ctx.arc(px, py, pipR, 0, Math.PI * 2);
    ctx.fillStyle = "#ffd76a"; ctx.fill();
    ctx.strokeStyle = "#05070f"; ctx.lineWidth = 1; ctx.stroke();
  }
}

// Sentinel Turret — a hexagonal base pad with a single barrel that swings to
// track its current target, so a defended base reads as actively guarded
// rather than as just another building. The barrel angle comes from the
// sim's auto-acquired targetId, not from any movement (a turret never moves).
function drawTurret(ctx, state, b, color) {
  const r = b.radius, cx = b.x, cy = b.y;
  pathPoints(ctx, polygonPoints(cx, cy, r, 6, Math.PI / 6));           // base pad
  ctx.fillStyle = color; ctx.fill();
  ctx.strokeStyle = "#05070f"; ctx.lineWidth = 2; ctx.stroke();

  const angle = turretFacing(state, b);
  ctx.strokeStyle = shade(color, -25); ctx.lineWidth = 3.5;
  ctx.beginPath(); ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(angle) * r * 1.5, cy + Math.sin(angle) * r * 1.5); ctx.stroke();

  ctx.beginPath(); ctx.arc(cx, cy, r * 0.5, 0, Math.PI * 2);          // mount
  ctx.fillStyle = shade(color, 20); ctx.fill();
  ctx.strokeStyle = "#05070f"; ctx.lineWidth = 1.5; ctx.stroke();

  ctx.beginPath();                                                    // muzzle tip light
  ctx.arc(cx + Math.cos(angle) * r * 1.5, cy + Math.sin(angle) * r * 1.5, 1.8, 0, Math.PI * 2);
  ctx.fillStyle = DETAIL; ctx.fill();
}

// Reuses the module-level facing Map — building "b*" ids can't collide with
// unit "u*" ids. Holds its last aim when idle (targetId null) instead of
// snapping back to a default, so a turret between shots keeps pointing where
// it last fired.
function turretFacing(state, b) {
  const prev = facing.get(b.id);
  let angle = prev ? prev.angle : -Math.PI / 2;
  const t = b.targetId ? (state.units.get(b.targetId) || state.buildings.get(b.targetId)) : null;
  if (t) angle = Math.atan2(t.y - b.y, t.x - b.x);
  facing.set(b.id, { x: b.x, y: b.y, angle });
  return angle;
}
