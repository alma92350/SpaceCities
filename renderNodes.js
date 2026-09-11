/* ============================================================
   Resource-deposit rendering — the charted ore/crystal/gas silhouettes on the
   map. Deposits are charted map knowledge (data.js), not battlefield intel, so
   they draw at full visibility regardless of fog (a hidden cache only appears
   once scouted). Each rock's irregular outline is stable frame-to-frame (seeded
   off its id). Split out of render.js; drawFrame calls drawNodes.
   ============================================================ */

"use strict";

import { COM } from "./data.js";
import { isNodeDiscovered } from "./engine/fog.js";
import { NODE_RADIUS } from "./engine/map.js";
import { UNITS } from "./engine/entities.js";
import { hashStr, seededRng, pathPoints, inView, centeredText } from "./renderShared.js";

// The same amber "running, just not at full rate" tone renderBuildings.js's producer-concern
// badge uses (CONCERN_STYLE.warn) — a saturated node isn't dead, just diminishing.
const SATURATION_COLOR = "#fbbf24";

// observerMode (default false, every existing caller unaffected): a hidden cache is charted
// knowledge to a spectator too — see render.js's drawFrame header comment.
export function drawNodes(ctx, state, view, observerMode = false) {
  for (const n of state.map.nodes) {
    if (n.amount <= 0) continue;
    if (view && !inView(view, n.x, n.y, 20)) continue;   // off-screen deposit
    if (!observerMode && !isNodeDiscovered(state.fog, n)) continue;   // a hidden cache stays dark until scouted
    const r = 7 + 9 * (n.amount / n.max);
    if (n.wreck) {
      drawWreckNode(ctx, n, r);
    } else {
      const extract = COM[n.com]?.extract;
      if (extract === "forage") drawOrganicNode(ctx, n, r);
      else if (extract === "capture") drawGasNode(ctx, n, r);
      else drawRockyNode(ctx, n, r); // mine / exploit — ore, crystals, radioactives, ice, relics
    }

    ctx.fillStyle = "#05070f";
    // baseline "alphabetic": this glyph sits on a hand-tuned +3 offset, not vertically centered.
    centeredText(ctx, COM[n.com]?.ico || "?", n.x, n.y + 3, "10px sans-serif", "alphabetic");

    // Saturation cue: node.miners is retallied every tick by sim.js countMiners, but nothing used
    // to render it, so a node six workers deep just looked like ordinary slow income with no
    // visible cause. Once the live headcount crosses the worker's soft cap (miningEfficiency,
    // engine/gather.js — the point where an extra miner starts pulling a diminishing share), ring
    // it and post the live "miners/cap" count, so "spread out, then expand" reads at a glance
    // without opening the panel.
    if ((n.miners || 0) > UNITS.worker.minerSoftCap) {
      // Ringed at the seam's SIM footprint (NODE_RADIUS), not at the shrinking silhouette
      // above. The drawn rock deliberately shrinks as it drains — that's the "how much is
      // left" cue — but the deposit's footprint never does: colliders.js keeps buildings
      // clear of NODE_RADIUS and gather.js parks the crew on a ring out at ORBIT_RADIUS
      // whatever the amount. Drawing the crowding cue on the shrinking silhouette put it
      // somewhere no worker actually stands, so a nearly-dry, six-deep seam showed a tight
      // little ring with the crew visibly outside it.
      ctx.beginPath();
      ctx.arc(n.x, n.y, NODE_RADIUS + 6, 0, Math.PI * 2);
      ctx.strokeStyle = SATURATION_COLOR;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.font = "9px sans-serif";
      ctx.fillStyle = SATURATION_COLOR;
      ctx.fillText(`${n.miners}/${UNITS.worker.minerSoftCap}`, n.x, n.y - NODE_RADIUS - 9);
    ctx.textAlign = "left";   // restore the canvas default, like textBaseline elsewhere
    }
  }
}

// Cached per-node unit silhouette (offsets at radius 1), so the seeded-PRNG
// polygon jitter is computed once per node instead of every single frame — the
// shape is static, only its radius changes as the deposit depletes.
const nodeShapeCache = new Map();
function rockyShape(id) {
  let shape = nodeShapeCache.get(id);
  if (!shape) {
    const rng = seededRng(hashStr(id));
    const rot = rng() * Math.PI * 2;   // same rng draw order as the original, so silhouettes are unchanged
    shape = [];
    for (let i = 0; i < 8; i++) {
      const a = rot + (i / 8) * Math.PI * 2;
      const jitter = 0.72 + rng() * 0.5;
      shape.push([Math.cos(a) * jitter, Math.sin(a) * jitter]);
    }
    nodeShapeCache.set(id, shape);
  }
  return shape;
}

// Mined/exploited deposits (ore, crystals, radioactives, ice, relics) read
// as a faceted asteroid chunk — an irregular polygon beats a perfect circle
// at selling "rock" at a glance, and the per-node seed keeps it stable.
function drawRockyNode(ctx, n, r) {
  const pts = rockyShape(n.id).map(([ux, uy]) => [n.x + ux * r, n.y + uy * r]);
  pathPoints(ctx, pts);
  ctx.fillStyle = "#ffd166";
  ctx.globalAlpha = 0.85;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = "#b9822f";
  ctx.lineWidth = 1;
  ctx.stroke();
}

// Foraged deposits (biomass, spice) read as a soft cluster of overlapping
// blobs — organic growth rather than mineral facets.
function drawOrganicNode(ctx, n, r) {
  const rng = seededRng(hashStr(n.id) ^ 0x9e3779b9);
  ctx.fillStyle = "#ffd166";
  ctx.globalAlpha = 0.85;
  const lobes = 3;
  for (let i = 0; i < lobes; i++) {
    const a = (i / lobes) * Math.PI * 2 + rng() * 0.6;
    const dist = r * 0.32 * rng();
    const lr = r * (0.55 + rng() * 0.15);
    ctx.beginPath();
    ctx.arc(n.x + Math.cos(a) * dist, n.y + Math.sin(a) * dist, lr, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// Battle wreckage (engine/wreckage.js `wreck: true`) reads as jagged scrap — a sharper,
// more irregular silhouette than a natural deposit's faceted-but-round asteroid look, in
// a cool grey/rust palette instead of the warm gold every mined/foraged/captured deposit
// shares — so a battlefield's mineable aftermath reads at a glance as wreckage, not an
// ore seam that happened to be sitting there. Regardless of its actual commodity (a
// wreck node can be any raw good, or the Phase-2 battle bonus's metals/electronics/
// relics — none of which have a distinct `extract` shape of their own), every wreck node
// shares this one look.
function drawWreckNode(ctx, n, r) {
  const pts = wreckShape(n.id).map(([ux, uy]) => [n.x + ux * r, n.y + uy * r]);
  pathPoints(ctx, pts);
  ctx.fillStyle = "#8a8f98";
  ctx.globalAlpha = 0.85;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = "#c65a3a";
  ctx.lineWidth = 1;
  ctx.stroke();
}

// Cached per-node silhouette, same idea as rockyShape above: computed once, reused every
// frame. One fewer point and a wider jitter band than a rocky node's 8-point shape, so it
// reads as jagged debris rather than a smooth asteroid facet.
const wreckShapeCache = new Map();
function wreckShape(id) {
  let shape = wreckShapeCache.get(id);
  if (!shape) {
    const rng = seededRng(hashStr(id) ^ 0x51ed270b);
    const rot = rng() * Math.PI * 2;
    shape = [];
    const points = 7;
    for (let i = 0; i < points; i++) {
      const a = rot + (i / points) * Math.PI * 2;
      const jitter = 0.55 + rng() * 0.85;
      shape.push([Math.cos(a) * jitter, Math.sin(a) * jitter]);
    }
    wreckShapeCache.set(id, shape);
  }
  return shape;
}

// Captured deposits (Helium-3 gas) read as a soft drifting cloud — nested
// translucent rings instead of a hard edge.
function drawGasNode(ctx, n, r) {
  const rings = [
    { rr: r * 1.3, a: 0.18 },
    { rr: r * 0.95, a: 0.35 },
    { rr: r * 0.55, a: 0.7 },
  ];
  for (const { rr, a } of rings) {
    ctx.beginPath();
    ctx.arc(n.x, n.y, rr, 0, Math.PI * 2);
    ctx.fillStyle = "#ffd166";
    ctx.globalAlpha = a;
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}
