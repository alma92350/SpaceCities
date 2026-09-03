/* ============================================================
   Cosmetic overlays and cues, drawn on top of the world — attack tracers /
   death flashes / under-attack pings (effects.js), the convoy-scenario route,
   selection rings, rally point, movement waypoints, escort links, the build
   ghost (with its power-grid / rig-survey placement cues), and the drag box.
   These are the only render paths that read wall-clock-timed state (effects.js)
   rather than the sim's own state. Split out of render.js.
   ============================================================ */

"use strict";

import { COM } from "./data.js";
import { game } from "./session.js";
import { UNITS, BUILDINGS } from "./engine/entities.js";
import { isNodeDiscovered } from "./engine/fog.js";
import { powerEfficiency } from "./engine/industry.js";
import { rigSurvey, SURVEY_RADIUS } from "./engine/rig.js";
import { canPlaceBuilding } from "./engine/colliders.js";
import { activeEffects, DEATH_BASE_RADIUS } from "./effects.js";
import { hexA, lerpXY, shade, pathPoints, polygonPoints, drawLabelChip } from "./renderShared.js";
import { POWER_TIER_COLOR, drawReactorBands } from "./renderBuildings.js";

// Cached once: whether the viewer asked the OS to reduce motion. Used to swap
// the repeating alert pulses for a static cue (see drawEffects).
let _reducedMotion = null;
function prefersReducedMotion() {
  if (_reducedMotion === null) {
    _reducedMotion = typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches : false;
  }
  return _reducedMotion;
}

// The convoy route overlay (scenario mode): a dashed lane connecting the
// stations, a muted ring at the start, cyan rings at the waypoint stations, and
// a bright green gate at the destination. The station the convoy is currently
// heading for gets a solid halo so the objective reads at a glance.
export function drawScenario(ctx, state) {
  const sc = state.scenario;
  if (!sc) return;
  if (sc.type === "bounty") { drawBountyMarkers(ctx, sc); return; }
  if (!sc.route) return;
  const route = sc.route;

  ctx.save();
  ctx.strokeStyle = "rgba(79, 209, 255, 0.30)";
  ctx.lineWidth = 2;
  ctx.setLineDash([12, 10]);
  ctx.beginPath();
  ctx.moveTo(route[0].x, route[0].y);
  for (let i = 1; i < route.length; i++) ctx.lineTo(route[i].x, route[i].y);
  ctx.stroke();
  ctx.setLineDash([]);

  const activeTarget = sc.phase === "travel" ? sc.legIndex + 1 : -1;
  route.forEach((p, i) => {
    const dest = i === route.length - 1;
    const start = i === 0;
    const col = dest ? "#4ade80" : start ? "#8593c4" : "#4fd1ff";
    if (i === activeTarget) {                          // halo the station we're steering for
      ctx.beginPath(); ctx.arc(p.x, p.y, 44, 0, Math.PI * 2);
      ctx.fillStyle = dest ? "rgba(74,222,128,0.12)" : "rgba(79,209,255,0.12)";
      ctx.fill();
    }
    ctx.beginPath(); ctx.arc(p.x, p.y, dest ? 38 : 32, 0, Math.PI * 2);
    ctx.strokeStyle = col; ctx.lineWidth = dest ? 4 : 2.5; ctx.stroke();
    ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
    ctx.fillStyle = col; ctx.fill();
  });
  ctx.restore();
}

// Bounty Marshal has no route — it marks the scattered pirate camps instead. An
// uncleared camp gets a dashed red "wanted" ring and its bounty value (a hunt
// beacon that reads through fog, so the player always knows where to go); a
// cleared camp fades to a faint green ring so progress is visible on the map.
function drawBountyMarkers(ctx, sc) {
  ctx.save();
  ctx.textAlign = "center";
  for (const pack of sc.packs) {
    if (pack.cleared) {
      ctx.strokeStyle = "rgba(74, 222, 128, 0.28)";
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(pack.x, pack.y, 30, 0, Math.PI * 2); ctx.stroke();
      continue;
    }
    ctx.strokeStyle = "rgba(248, 113, 113, 0.6)";
    ctx.lineWidth = 2.5;
    ctx.setLineDash([7, 7]);
    ctx.beginPath(); ctx.arc(pack.x, pack.y, 48, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = "12px sans-serif";
    ctx.fillStyle = "#fca5a5";
    ctx.fillText(`💰 ${pack.bounty}`, pack.x, pack.y - 56);
  }
  ctx.restore();
}

// Per-weapon fire signature: shape + base color keyed by the firing unit's type (attackHit's
// unitType, engine/combat.js — a turret reads as its own "turret" type). Replaces the old
// two-case tracerColor() special-case (only bastion/lancer were colored; every other type —
// skiff, breacher, turret, dreadnought, wraith, colossus, including the player's OWN units —
// fell to the same hostile-red default). `shape` picks which branch of drawTracer (below) draws
// it; `color`/`width` are the base look BEFORE the counter-triangle bonus-hit brightening
// (drawTracer again). Every type that can actually fire (UNITS[]/BUILDINGS[].attack truthy) gets
// its own entry — see test/renderEffects.test.js's roster-completeness check. `default` is the
// fallback for a hypothetical future type this table hasn't caught up with yet — kept a neutral
// pale color rather than red, so a gap here reads as "unclassified", not "hostile".
export const TRACER_STYLE = {
  skiff:       { shape: "dart", color: "#8be9fd", width: 2 },
  bastion:     { shape: "bolt", color: "#ffd166", width: 4 },
  lancer:      { shape: "beam", color: "#4fd1ff", width: 1.5 },
  breacher:    { shape: "arc",  color: "#ff8a3d", width: 3 },
  dreadnought: { shape: "bolt", color: "#f87171", width: 4.5 },
  wraith:      { shape: "dart", color: "#c084fc", width: 2 },
  aegis:       { shape: "beam", color: "#7dd3fc", width: 1.5 },
  colossus:    { shape: "arc",  color: "#fb7185", width: 4 },
  leviathan:   { shape: "arc",  color: "#facc15", width: 5 },
  turret:      { shape: "beam", color: "#a78bfa", width: 2 },   // static defense — its own hue, distinct from every mobile hull
  bastille:       { shape: "bolt", color: "#c026d3", width: 3.5 },   // the turret's tankier, heavier-hitting sibling
  torpedobattery: { shape: "arc",  color: "#34d399", width: 4 },     // ammo-fed endgame siege — a heavy lobbed plasma hit
  worker:      { shape: "default", color: "#e2e8f0", width: 1.5 },
  ranger:      { shape: "default", color: "#e2e8f0", width: 1.5 },
  default:     { shape: "default", color: "#e2e8f0", width: 2 },
};

// The flash is fully gone well before the tracer itself finishes fading (TRACER_LIFETIME_MS,
// effects.js), so it reads as a one-frame flicker at the gun, not a second glow racing the shot
// down the line.
const MUZZLE_FLASH_FRACTION = 0.3;

// One tracer, in whatever shape its firing unit's TRACER_STYLE assigns, brightened and thickened
// when it carries a counter-triangle bonus hit (engine/combat.js's `bonus` flag — a Skiff
// catching a Lancer, etc.), plus a one-flicker muzzle flash at the firing end. Split out of
// drawEffects so each weapon shape reads as its own small branch, not one long loop body.
function drawTracer(ctx, t) {
  const style = TRACER_STYLE[t.unitType] || TRACER_STYLE.default;
  const color = t.bonus ? shade(style.color, 35) : style.color;
  const width = style.width * (t.bonus ? 1.6 : 1);
  const dx = t.toX - t.fromX, dy = t.toY - t.fromY;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;   // unit vector shooter -> target, for the shape branches below

  ctx.globalAlpha = Math.max(0, 1 - t.age);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;

  if (style.shape === "bolt") {
    // Thick and stubby: only the last stretch of the line, near the target — a heavy close-range
    // punch (Bastion/Dreadnought) rather than a full-length beam.
    const cut = Math.max(0, len - Math.min(len, 30 + len * 0.35));
    ctx.beginPath();
    ctx.moveTo(t.fromX + ux * cut, t.fromY + uy * cut);
    ctx.lineTo(t.toX, t.toY);
    ctx.stroke();
  } else if (style.shape === "beam") {
    // A full-length thin beam with a hot, slightly thicker tip near the target.
    ctx.beginPath();
    ctx.moveTo(t.fromX, t.fromY);
    ctx.lineTo(t.toX, t.toY);
    ctx.stroke();
    const tipStart = Math.max(0, len - Math.min(len, 22));
    ctx.strokeStyle = t.bonus ? "#fff7cc" : shade(color, 30);
    ctx.lineWidth = width + 1;
    ctx.beginPath();
    ctx.moveTo(t.fromX + ux * tipStart, t.fromY + uy * tipStart);
    ctx.lineTo(t.toX, t.toY);
    ctx.stroke();
  } else if (style.shape === "dart") {
    // A short bright segment that SLIDES from shooter to target as the tracer ages, over a faint
    // full-length guide line — reads as a fast, light round rather than a static drawn line.
    ctx.globalAlpha = Math.max(0, (1 - t.age) * 0.25);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(t.fromX, t.fromY);
    ctx.lineTo(t.toX, t.toY);
    ctx.stroke();
    const cx = t.fromX + dx * t.age, cy = t.fromY + dy * t.age;
    const half = Math.min(len / 2, 9);
    ctx.globalAlpha = Math.max(0, 1 - t.age);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(cx - ux * half, cy - uy * half);
    ctx.lineTo(cx + ux * half, cy + uy * half);
    ctx.stroke();
  } else if (style.shape === "arc") {
    // A lobbed shell: a quadratic curve bulging away from the straight line — siege fire
    // (Breacher/Colossus/Leviathan) reads as arcing in, not a flat direct shot.
    const bulge = Math.min(40, len * 0.18);
    const midX = (t.fromX + t.toX) / 2 - uy * bulge, midY = (t.fromY + t.toY) / 2 + ux * bulge;
    ctx.beginPath();
    ctx.moveTo(t.fromX, t.fromY);
    ctx.quadraticCurveTo(midX, midY, t.toX, t.toY);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.moveTo(t.fromX, t.fromY);
    ctx.lineTo(t.toX, t.toY);
    ctx.stroke();
  }

  // A one-flicker muzzle flash at the firing end — gone well before the tracer itself fades, so
  // it reads as the gun flashing, not a second glow racing the shot down the line. A little spin
  // (rotation keyed to age) sells the "flicker" rather than a static stamp.
  if (t.age < MUZZLE_FLASH_FRACTION) {
    ctx.globalAlpha = Math.max(0, 1 - t.age / MUZZLE_FLASH_FRACTION);
    ctx.fillStyle = t.bonus ? "#fff7cc" : color;
    pathPoints(ctx, polygonPoints(t.fromX, t.fromY, style.width + (t.bonus ? 2.5 : 1.5), 5, t.age * 3));
    ctx.fill();
  }

  // The impact spark where the round lands — a quick bright flash that fades faster than the
  // tracer, so a hit reads as connecting, not just a line drawn through the target. Bigger and
  // hotter on a counter-triangle bonus hit, so the extra damage reads at the point of impact too.
  ctx.globalAlpha = Math.max(0, 1 - t.age * 1.6);
  ctx.fillStyle = t.bonus ? "#fff7cc" : "#ffe9c2";
  ctx.beginPath();
  ctx.arc(t.toX, t.toY, (t.bonus ? 4 : 2.5) + (1 - t.age) * (t.bonus ? 2.5 : 1.5), 0, Math.PI * 2);
  ctx.fill();

  // A splash hit (engine/combat.js's attackHit `splashRadius` field — def.splash, Colossus
  // first) also draws a fading ring at the true impact radius, in the same per-weapon color this
  // shot already picked above — so an area hit reads as such at a glance, distinct from every
  // single-target tracer's plain impact spark just above. Falsy (0) for every non-splash hit, so
  // this is purely additive and data-driven for any future splash-capable unit.
  if (t.splashRadius) {
    ctx.globalAlpha = Math.max(0, 0.55 * (1 - t.age));
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(t.toX, t.toY, t.splashRadius, 0, Math.PI * 2);
    ctx.stroke();
  }
}

// The Helium Bomb shockwave (see drawEffects below): the fireball collapses
// within the first slice of the effect's life, the ring then spends most of
// the rest slowly traveling out to the true blast radius, and the remainder
// is left for it to fade out once it arrives.
const EXPLOSION_FLASH_FRACTION = 0.15;
const EXPLOSION_SHOCKWAVE_FRACTION = 0.85;
// Hot (near ground zero, peak damage) -> cool ash-grey (the tapering edge),
// matching bombDamageAt's own falloff from full HP loss to a scratch.
const SHOCKWAVE_HOT = [255, 180, 80];
const SHOCKWAVE_COOL = [148, 163, 184];
function lerpColor(a, b, t) {
  const r = Math.round(a[0] + (b[0] - a[0]) * t);
  const g = Math.round(a[1] + (b[1] - a[1]) * t);
  const b2 = Math.round(a[2] + (b[2] - a[2]) * t);
  return `rgb(${r}, ${g}, ${b2})`;
}

// Tiered destruction: a hull at or above this radius flings debris shards on death (Breacher 10,
// Dreadnought/Aegis/Colossus 11-12, Leviathan 14, and up — every Skiff/Lancer/worker-scale unit
// stays a plain ring).
const DEBRIS_MIN_RADIUS = 10;
const DEBRIS_SHARD_COUNT = 5;

// Attack tracers, death flashes, and under-attack pings: all purely
// cosmetic and short-lived (see effects.js), so this is the only place
// in render.js that reads wall-clock-timed state instead of the sim's
// own state object.
export function drawEffects(ctx) {
  const { tracers, deaths, pings, explosions, fuseWarnings } = activeEffects();

  for (const t of tracers) drawTracer(ctx, t);

  // Tiered destruction (docs/improvement-proposals.md): the ring's size/lifetime already scale
  // with the killed entity's own radius (effects.js addDeathFlash/deathLifeMs, DEATH_BASE_RADIUS
  // the baseline both files share) — this just draws the SHAPE differently by tier: a plain
  // single ring for most deaths, a few outward debris shards bolted on for a big hull
  // (radius >= DEBRIS_MIN_RADIUS), and a building gets a slower TWO-ring collapse (an outer ring
  // plus a lagging inner one) instead of one, reading as a structure caving in rather than a unit
  // popping.
  for (const d of deaths) {
    const scale = d.radius / DEATH_BASE_RADIUS;
    const rMax = 16 * scale;
    const r = 6 * scale + d.age * rMax;
    ctx.globalAlpha = Math.max(0, 1 - d.age);
    ctx.strokeStyle = "#ffab5e";
    ctx.lineWidth = Math.max(1.5, Math.min(3.2, 2 * scale));
    ctx.beginPath();
    ctx.arc(d.x, d.y, r, 0, Math.PI * 2);
    ctx.stroke();

    if (d.kind === "building") {
      // A second, inner ring trailing the outer one by a quarter of the effect's life — the core
      // caves in a beat behind the shockwave, instead of the whole structure vanishing on one ring.
      const innerAge = Math.max(0, d.age - 0.25);
      const innerR = 4 * scale + innerAge * rMax * 0.7;
      ctx.globalAlpha = Math.max(0, (1 - d.age) * 0.8);
      ctx.beginPath();
      ctx.arc(d.x, d.y, innerR, 0, Math.PI * 2);
      ctx.stroke();
    } else if (d.radius >= DEBRIS_MIN_RADIUS) {
      // A handful of shards flung outward for a heavy hull — angle hashed off position so it's
      // stable across the effect's own lifetime rather than reshuffling every frame.
      ctx.fillStyle = "#ffab5e";
      for (let i = 0; i < DEBRIS_SHARD_COUNT; i++) {
        const a = (i / DEBRIS_SHARD_COUNT) * Math.PI * 2 + (d.x + d.y) * 0.01;
        const dist = d.age * rMax * 1.4;
        ctx.beginPath();
        ctx.arc(d.x + Math.cos(a) * dist, d.y + Math.sin(a) * dist, Math.max(0.5, 2 * (1 - d.age)), 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  const reduced = prefersReducedMotion();
  for (const p of pings) {
    if (reduced) {
      // Motion-sensitive players get a steady ring that just fades out, instead
      // of the repeating expanding pulse.
      ctx.globalAlpha = Math.max(0, 0.6 * (1 - p.age));
      ctx.strokeStyle = "#f87171";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 24, 0, Math.PI * 2);
      ctx.stroke();
      continue;
    }
    // Two expanding rings on a repeating pulse read as an alarm rather
    // than a one-shot flash, matching a ping's much longer lifetime.
    const pulse = (p.age * 2.5) % 1;
    ctx.globalAlpha = Math.max(0, (1 - pulse) * (1 - p.age * 0.6));
    ctx.strokeStyle = "#f87171";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 14 + pulse * 40, 0, Math.PI * 2);
    ctx.stroke();
  }

  // A Helium Bomb's fuse just lit (engine/bomb.js's bombFused event): an amber warning ring
  // pulsing right at ground zero for the whole fuse burn — distinct from the red under-attack
  // ping above and the hot explosion ring below, its own place in the alert color language.
  // The pulse rate itself accelerates as f.age climbs toward 1, so the rhythm quickens right
  // up to the moment the real blast (drawn below, once detonateBomb actually fires) takes over.
  for (const f of fuseWarnings) {
    if (reduced) {
      ctx.globalAlpha = Math.max(0, 0.5 * (1 - f.age));
      ctx.strokeStyle = "#fbbf24";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(f.x, f.y, 20, 0, Math.PI * 2);
      ctx.stroke();
      continue;
    }
    const pulseHz = 2 + f.age * 4;   // ~2Hz freshly lit, accelerating to ~6Hz right before it blows
    const pulse = (f.age * pulseHz) % 1;
    ctx.globalAlpha = Math.max(0, (1 - pulse) * 0.85);
    ctx.strokeStyle = "#fbbf24";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(f.x, f.y, 10 + pulse * 22, 0, Math.PI * 2);
    ctx.stroke();
  }

  // The Helium Bomb's detonation (engine/bomb.js): a bright fireball flash at ground zero
  // that collapses fast, under a slow-moving shockwave ring that crawls out from
  // e.coreRadius (the guaranteed-kill distance) to e.radius (the true blast radius the
  // damage falloff reaches zero at) over most of the effect's life — a deliberately
  // unhurried, decelerating travel (real shockwaves lose speed as they lose energy) so the
  // blast reads as a big, dramatic event rather than a one-frame pop. The ring cools from a
  // hot core color to an ash-grey edge color as it travels, echoing bombDamageAt's own
  // falloff from peak damage to a scratch. Reduced-motion viewers get a single fast static
  // ring at the true radius instead of the slow travel.
  for (const e of explosions) {
    const flashT = Math.min(1, e.age / EXPLOSION_FLASH_FRACTION);
    const flashR = (e.coreRadius || e.radius * 0.3) * Math.max(0, 1 - flashT);
    ctx.globalAlpha = Math.max(0, 1 - flashT * 1.2);
    ctx.fillStyle = "#fff3c4";
    ctx.beginPath();
    ctx.arc(e.x, e.y, flashR, 0, Math.PI * 2);
    ctx.fill();

    if (reduced) {
      ctx.globalAlpha = Math.max(0, 0.6 * (1 - e.age));
      ctx.strokeStyle = "#ff8a3d";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.radius, 0, Math.PI * 2);
      ctx.stroke();
      continue;
    }

    const travel = Math.min(1, e.age / EXPLOSION_SHOCKWAVE_FRACTION);
    const eased = 1 - (1 - travel) ** 3;   // ease-out: fast off the blast, decelerating outward
    const ringR = (e.coreRadius || 0) + (e.radius - (e.coreRadius || 0)) * eased;
    const ringAlpha = e.age < EXPLOSION_SHOCKWAVE_FRACTION
      ? 0.9 - 0.5 * travel
      : Math.max(0, 0.4 * (1 - (e.age - EXPLOSION_SHOCKWAVE_FRACTION) / (1 - EXPLOSION_SHOCKWAVE_FRACTION)));
    ctx.globalAlpha = Math.max(0, ringAlpha);
    ctx.strokeStyle = lerpColor(SHOCKWAVE_HOT, SHOCKWAVE_COOL, eased);
    ctx.lineWidth = Math.max(1, 5 * (1 - eased * 0.6));
    ctx.beginPath();
    ctx.arc(e.x, e.y, ringR, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.globalAlpha = 1;
}

// The grid-efficiency cue drawn under a power-consumer build ghost: the nearest own
// Reactor's zones + a connector to it, and the ghost's resulting tier as a coloured ring
// and label ("On-grid · draw ×1.0" … "Isolated · draw ×2.3"). Mirrors how the Spaceport
// shows its jump radius — it turns "where do I put this factory?" into a visible choice.
function drawGhostPowerCue(ctx, state, ghost, def) {
  // The source that DETERMINES the ghost's tier: the nearest by RANGE-SCALED distance, so a
  // close short-range Generator can out-rank a far Reactor exactly as the efficiency math does.
  let nearest = null, bestD = Infinity, nearestScale = 1;
  for (const b of state.buildings.values()) {
    const bd = BUILDINGS[b.type];
    if (b.owner !== game.localOwner || b.constructing || !(bd && bd.energyGrants > 0)) continue;
    const scale = bd.powerRange || 1;
    const d = Math.hypot(b.x - ghost.x, b.y - ghost.y) / scale;
    if (d < bestD) { bestD = d; nearest = b; nearestScale = scale; }
  }

  const tier = powerEfficiency(state, game.localOwner, ghost.x, ghost.y);
  const col = POWER_TIER_COLOR[tier.name];

  if (nearest) {
    drawReactorBands(ctx, nearest.x, nearest.y, nearestScale);
    ctx.save();
    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = hexA(col, 0.8);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(nearest.x, nearest.y);
    ctx.lineTo(ghost.x, ghost.y);
    ctx.stroke();
    ctx.restore();
  }

  // A ring in the tier colour around the ghost, plus a label above it.
  ctx.save();
  ctx.beginPath();
  ctx.arc(ghost.x, ghost.y, def.radius + 7, 0, Math.PI * 2);
  ctx.strokeStyle = col;
  ctx.lineWidth = 2.5;
  ctx.stroke();

  const label = nearest
    ? `${tier.label} · draw ×${tier.mult.toFixed(1)}`
    : "No Reactor — power it first";
  const ly = ghost.y - def.radius - 12;
  drawLabelChip(ctx, label, ghost.x, ly, nearest ? col : "#f87171");
  ctx.restore();
}

// The Plasma Rig placement survey: a dashed violet ring at the survey radius, a highlight on
// each VISIBLE deposit the rig would read inside it, and a label predicting the vein + seam
// richness below (engine/rig.js rigSurvey). Only the player's charted surface counts, so a spot
// with no visible deposits reads "blind — a gamble", and an unscouted cache stays a surprise.
function drawRigSurveyCue(ctx, state, ghost, def) {
  const VIOLET = "180, 140, 255";
  ctx.save();
  ctx.setLineDash([4, 8]);
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = `rgba(${VIOLET}, 0.5)`;
  ctx.beginPath();
  ctx.arc(ghost.x, ghost.y, SURVEY_RADIUS, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  const visible = state.map.nodes.filter(n => n.amount > 0 && isNodeDiscovered(state.fog, n)
    && Math.hypot(n.x - ghost.x, n.y - ghost.y) < SURVEY_RADIUS);
  ctx.save();
  ctx.setLineDash([]);
  ctx.strokeStyle = `rgba(${VIOLET}, 0.85)`;
  ctx.lineWidth = 1.5;
  for (const n of visible) {
    ctx.beginPath();
    ctx.arc(n.x, n.y, 7 + 9 * (n.amount / n.max) + 4, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();

  const survey = rigSurvey(visible, state.planetId, ghost.x, ghost.y);
  const meta = survey.likelyVein ? COM[survey.likelyVein] : null;
  const confWord = !survey.likelyVein ? "" : survey.confidence >= 0.6 ? "likely " : survey.confidence >= 0.35 ? "maybe " : "toss-up: ";
  const label = survey.likelyVein
    ? `⛏ ${confWord}${meta?.name || survey.likelyVein} · ${survey.richLabel} seam`
    : "⛏ blind spot — no surface to read (a gamble)";

  ctx.save();
  const ly = ghost.y - def.radius - 34;   // sits above the grid-efficiency label (at radius+12)
  drawLabelChip(ctx, label, ghost.x, ly, survey.likelyVein ? "#c4b5fd" : "#f0a0a0", "rgba(5, 7, 15, 0.8)");
  ctx.restore();
}

// Translucent footprint under the cursor while placing a building, green
// when the spot is buildable and red when it isn't (out of bounds,
// overlapping another building, or too close to a resource node — see
// engine/colliders.js) so invalid placement is obvious before the
// player even clicks, not just rejected silently after.
export function drawBuildGhost(ctx, state, ghost) {
  const def = BUILDINGS[ghost.buildingType];
  if (!def) return;

  // Placing a power consumer (a factory, the Plasma Rig, or the Gate)? Surface the
  // grid-efficiency zones of every nearby Reactor and tag the ghost with the tier it
  // would land in, so the "closer is cheaper to power" call is visible BEFORE the click.
  if (def.recipe || def.rig || def.wonder) drawGhostPowerCue(ctx, state, ghost, def);

  // Placing a Plasma Rig? Read the visible surface deposits and predict the vein + seam
  // richness below, so late-game placement is an educated guess off the map, not a blind pick.
  if (def.rig) drawRigSurveyCue(ctx, state, ghost, def);

  const valid = canPlaceBuilding(state, ghost.buildingType, ghost.x, ghost.y);
  const color = valid ? "#4ade80" : "#f87171";
  const r = def.radius;

  ctx.globalAlpha = 0.45;
  ctx.fillStyle = color;
  ctx.fillRect(ghost.x - r, ghost.y - r, r * 2, r * 2);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  // An INVALID spot carries a non-colour cue too — a dashed outline plus an ✕ across the
  // footprint — so it reads without relying on the red-vs-green hue alone (the same
  // colourblind-safe principle the health bars use). A valid spot stays a clean solid box.
  if (valid) {
    ctx.strokeRect(ghost.x - r, ghost.y - r, r * 2, r * 2);
  } else {
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(ghost.x - r, ghost.y - r, r * 2, r * 2);
    ctx.beginPath();
    ctx.moveTo(ghost.x - r, ghost.y - r); ctx.lineTo(ghost.x + r, ghost.y + r);
    ctx.moveTo(ghost.x + r, ghost.y - r); ctx.lineTo(ghost.x - r, ghost.y + r);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

// `force` keeps the bar visible at full health for a selected entity, so you
// can confirm your army's condition at a glance instead of it vanishing the
// moment it's topped off. Three colour bands (green / amber / red) so the
// health tier reads without relying on the green-vs-red distinction alone.

export function drawSelectionRings(ctx, state, alpha = 1) {
  ctx.strokeStyle = "#4fd1ff";
  ctx.lineWidth = 2;
  for (const id of state.selection) {
    const unit = state.units.get(id);
    const e = unit || state.buildings.get(id);
    if (!e) continue;
    const baseRadius = unit ? UNITS[unit.type].radius : e.radius;
    const r = baseRadius + 4;
    const d = unit ? lerpXY(unit, alpha) : e;   // ring follows the interpolated hull (buildings are static)
    ctx.beginPath();
    ctx.arc(d.x, d.y, r, 0, Math.PI * 2);
    ctx.stroke();
  }
}

// Shown only for the single selected production building, matching the
// usual RTS convention of not cluttering the view with every building's
// rally line at once.
export function drawRallyPoint(ctx, state) {
  if (state.selection.length !== 1) return;
  const building = state.buildings.get(state.selection[0]);
  if (!building || building.owner !== game.localOwner || !BUILDINGS[building.type].produces) return;

  // Guard before destructuring: `rally` is optional on a Building and engine/persist.js's
  // cleanEntity never defaults it, so an older or hand-edited save reaches here with none. A
  // TypeError from a single entity used to take the whole frame — and, before drawFrame's
  // try/finally, every frame after it.
  const rally = building.rally;
  if (!rally) return;
  const { x: rx, y: ry } = rally;
  ctx.save();
  ctx.setLineDash([6, 6]);
  ctx.strokeStyle = "rgba(79, 209, 255, 0.6)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(building.x, building.y);
  ctx.lineTo(rx, ry);
  ctx.stroke();
  ctx.restore();

  ctx.beginPath();
  ctx.arc(rx, ry, 5, 0, Math.PI * 2);
  ctx.fillStyle = "#4fd1ff";
  ctx.fill();
  ctx.strokeStyle = "#05070f";
  ctx.lineWidth = 1;
  ctx.stroke();
}

// The queued-waypoint path for every selected player unit: a dashed line
// threading the unit through its active order and each queued step,
// with a dot at each stop. Only drawn for units that actually have a queue,
// so an ordinary single-destination move doesn't clutter the field.
export function drawWaypoints(ctx, state) {
  ctx.save();
  ctx.setLineDash([4, 5]);
  for (const id of state.selection) {
    const unit = state.units.get(id);
    if (!unit || unit.owner !== game.localOwner || !unit.orderQueue || unit.orderQueue.length === 0) continue;

    const stops = [];
    for (const order of [unit.order, ...unit.orderQueue]) {
      const pt = orderPoint(state, order);
      if (pt) stops.push(pt);
    }
    if (!stops.length) continue;

    ctx.strokeStyle = "rgba(79, 209, 255, 0.5)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(unit.x, unit.y);
    for (const s of stops) ctx.lineTo(s.x, s.y);
    ctx.stroke();

    ctx.fillStyle = "#4fd1ff";
    for (const s of stops) {
      ctx.beginPath();
      ctx.arc(s.x, s.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

// A faint link from each selected escort to the friendly ship it's guarding, plus a ring on the
// target — so an active escort order reads at a glance (it carries no waypoint line otherwise).
// Escort green, distinct from the cyan waypoint colour.
export function drawEscortLinks(ctx, state) {
  const guarded = new Set();
  ctx.save();
  ctx.setLineDash([3, 4]);
  ctx.strokeStyle = "rgba(120, 230, 170, 0.5)";
  ctx.lineWidth = 1.1;
  for (const id of state.selection) {
    const u = state.units.get(id);
    if (!u || u.owner !== game.localOwner || !u.order || u.order.type !== "escort") continue;
    const t = state.units.get(u.order.targetId);
    if (!t || t.hp <= 0) continue;
    ctx.beginPath(); ctx.moveTo(u.x, u.y); ctx.lineTo(t.x, t.y); ctx.stroke();
    guarded.add(t);
  }
  ctx.setLineDash([]);
  ctx.strokeStyle = "rgba(120, 230, 170, 0.75)";
  ctx.lineWidth = 1.4;
  for (const t of guarded) {
    ctx.beginPath();
    ctx.arc(t.x, t.y, (UNITS[t.type]?.radius || 10) + 6, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

// Where an order points on the map, for its waypoint marker — a fixed spot
// for move/attack-move, or the live position of the unit/building/node it's
// chasing. Null for an order with nowhere to point.
function orderPoint(state, order) {
  if (!order) return null;
  if (order.type === "move" || order.type === "attack-move") return { x: order.x, y: order.y };
  if (order.type === "attack" || order.type === "escort") {
    const t = state.units.get(order.targetId) || state.buildings.get(order.targetId);
    return t ? { x: t.x, y: t.y } : null;
  }
  if (order.type === "gather") {
    const n = state.map.nodes.find(nd => nd.id === order.nodeId);
    return n ? { x: n.x, y: n.y } : null;
  }
  if (order.type === "build") {
    const b = state.buildings.get(order.buildingId);
    return b ? { x: b.x, y: b.y } : null;
  }
  return null;
}

export function drawDragBox(ctx, box) {
  const x = Math.min(box.x1, box.x2), y = Math.min(box.y1, box.y2);
  const w = Math.abs(box.x2 - box.x1), h = Math.abs(box.y2 - box.y1);
  ctx.fillStyle = "rgba(79, 209, 255, 0.15)";
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = "#4fd1ff";
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, w, h);
}
