/* ============================================================
   Skirmish map generation.
   Picks one charted world from data.js and scatters resource nodes
   mirrored across the map, sized by that world's own deposit yields —
   so which planet you fight over changes what the map plays like.

   Configurable from the splash screen (see main.js): a size multiplier
   (Small 1x … Gigantic 4x) scales the whole map self-similarly, and a
   resource multiplier (Rare … Abundant) scales every deposit's amount.
   At sizeMult=1, resourceMult=1 the layout is byte-identical to the
   original small map.
   ============================================================ */

"use strict";

import { PLANETS } from "../data.js";
import { factionTrait } from "./factions.js";

// The "Small" map — every other size is a whole-number multiple of this.
export const MAP_WIDTH = 1600;
export const MAP_HEIGHT = 1000;

// Fraction of the (scaled) map width that counts as "near a base" for the
// build-critical resource guarantee below. 500/1600 → exactly 500 on a Small
// map, and proportional on bigger ones.
const NEAR_BASE_FRAC = 500 / MAP_WIDTH;

// Every build ultimately needs ore (all units/buildings), crystals (Turret,
// Reinforced Plating) and radioactives (Breacher, Overcharged Weapons). A
// planet's deposit table is its *specificity* — how much of each it holds —
// but every map must still let you make everything, so any of these three the
// surface doesn't provide near a base gets a lean guaranteed seam. A world
// rich in a commodity keeps its big deposits; a world without it gets just
// this minimum. Ore's floor is highest since it funds the whole economy.
const BUILD_CRITICAL = ["ore", "crystals", "radioactives"];
const MIN_GUARANTEE = { ore: 480, crystals: 300, radioactives: 300 };
// Vertical offset (fraction of height) each guaranteed seam sits at, so the
// three don't pile onto one point when a world needs several of them.
const GUARANTEE_Y = { ore: 0, crystals: -0.12, radioactives: 0.12 };

const CACHE_BASE_AMOUNT = 360;   // ~0.6x a normal 600 cluster — a real bonus, not a second economy

// A guaranteed ore cluster right on the doorstep of each Command Center, at a
// FIXED absolute distance regardless of map size. The deposit clusters sit at
// fractions of the map width, so on a Gigantic (4x) map they drift far from the
// base and the opening economy crawls. These home nodes never move: whatever the
// map size, every base opens onto ore it can reach in seconds — enough to fund a
// second Command Center (400 ore) and push out toward the contested deposits and
// the enemy. Offsets face the map interior (mirrored for the AI) so they never
// fall off the edge, and carry NO rng draw, so the deposit/cache layout and map
// determinism are byte-for-byte untouched. Flagged `home` so the deposit-count
// tests can tell them apart from the surface deposit table.
const HOME_ORE_AMOUNT = 350;                       // per node; 3 nodes ⇒ ~1050 ore on the doorstep
const HOME_ORE_OFFSETS = [                          // absolute px from the base, interior-facing
  { dx: 130, dy: -95 },
  { dx: 165, dy: 0 },
  { dx: 130, dy: 95 },
];

/* ---------- terrain ---------- */

// A coarse per-cell terrain field (a flat Uint8Array of type codes, same idiom
// as the fog grid), sampled O(1) by movement/fog/combat/colliders. Deliberately
// NOT impassable — a slow cell still has speed > 0, so no unit can ever be
// trapped (the engine has no pathfinding) and a wave can never deadlock. Rough
// fields flanking an open lane read as a soft choke; high ground is a strong
// point worth holding. Terrain is static for the whole match and drawn from
// fixed fractional specs, so it consumes ZERO rng draws — map determinism and
// the byte-identical node layout are untouched.
export const TERRAIN_CELL_SIZE = 40;   // aligned with FOG_CELL_SIZE so a future LOS pass can share cell coords
export const TERRAIN = {
  0: { name: "open",  speedMult: 1,   sightMult: 1,    buildable: true,  combatMult: 1 },
  1: { name: "rough", speedMult: 0.6, sightMult: 1,    buildable: false, combatMult: 1 },     // slow, unbuildable field
  2: { name: "high",  speedMult: 1,   sightMult: 1.25, buildable: true,  combatMult: 1.15 },  // high ground: sees + hits farther/harder
};

// Feature specs are [xFrac, yFrac, wFrac, hFrac, code, mirror?] — a rectangular
// blob centred at (xFrac,yFrac) in fractions of the scaled map, stamped into the
// grid. `mirror` reflects it across the vertical centreline for fairness (both
// sides face the same ground). Scales self-similarly with sizeMult.
function generateTerrain(width, height, specs) {
  const cols = Math.ceil(width / TERRAIN_CELL_SIZE);
  const rows = Math.ceil(height / TERRAIN_CELL_SIZE);
  const type = new Uint8Array(cols * rows);   // 0 = open everywhere by default
  const stamp = (xf, yf, wf, hf, code) => {
    const cx0 = Math.floor(((xf - wf / 2) * width) / TERRAIN_CELL_SIZE);
    const cx1 = Math.floor(((xf + wf / 2) * width) / TERRAIN_CELL_SIZE);
    const cy0 = Math.floor(((yf - hf / 2) * height) / TERRAIN_CELL_SIZE);
    const cy1 = Math.floor(((yf + hf / 2) * height) / TERRAIN_CELL_SIZE);
    for (let gy = Math.max(0, cy0); gy <= Math.min(rows - 1, cy1); gy++)
      for (let gx = Math.max(0, cx0); gx <= Math.min(cols - 1, cx1); gx++)
        type[gy * cols + gx] = code;
  };
  for (const [xf, yf, wf, hf, code, mirror] of specs) {
    stamp(xf, yf, wf, hf, code);
    if (mirror) stamp(1 - xf, yf, wf, hf, code);
  }
  return { cols, rows, cell: TERRAIN_CELL_SIZE, type };
}

// A world-and-faction modifier as seen by ONE side. Two independent layers,
// multiplied together:
//   1. The WORLD. Most worlds tilt both sides equally (a plain `modifiers[key]`),
//      but a world may carry an `asym: { player, ai }` block that overrides a key
//      for just one owner. Lookup: the owner's asym override, then the shared
//      modifier, then the default.
//   2. The FACTION (factions.js). The owner's chosen faction contributes its own
//      trait multiplier for the same key (1 when it has none, or on a map-less /
//      player-less test stub) — so a faction's edge lands exactly where a world's
//      does, through this one seam, and every existing consumer picks it up for
//      free. `neutral` (the test/default faction) contributes 1, leaving the
//      long-standing symmetric behaviour and every exact-value test unchanged.
export function sideMod(state, owner, key, dflt = 1) {
  const m = state && state.map && state.map.modifiers;
  let world = dflt;
  if (m) {
    const a = m.asym && m.asym[owner];
    world = a && a[key] != null ? a[key] : (m[key] ?? dflt);
  }
  return world * factionTrait(state, owner, key);
}

// The TERRAIN entry at a world point. Returns OPEN for a missing grid or an
// out-of-bounds point, so every consumer degrades to "no terrain effect"
// safely (map-less test stubs, off-map coords).
export function sampleTerrain(terrain, x, y) {
  if (!terrain) return TERRAIN[0];
  const gx = Math.floor(x / terrain.cell), gy = Math.floor(y / terrain.cell);
  if (gx < 0 || gy < 0 || gx >= terrain.cols || gy >= terrain.rows) return TERRAIN[0];
  return TERRAIN[terrain.type[gy * terrain.cols + gx]] || TERRAIN[0];
}

/**
 * Deterministically generate a world's map (deposits, bases, terrain) from a seeded rng.
 * @param {string} [planetId]
 * @param {() => number} [rng]
 * @param {{ sizeMult?: number, resourceMult?: number, swapAsym?: boolean, owners?: string[] }} [opts]
 *   owners (T-044, default ["player","ai"]): the side ids to build bases for. Exactly 2 ids
 *   (any names) uses the mirrored path below, keyed by those ids — byte-identical geometry to
 *   today for the default pair. 3+ ids dispatches to generateRadialMap, a genuinely separate
 *   generator (see its own header) — never a generalization of this one, so this function and
 *   every existing seed/replay/determinism fixture stay completely untouched.
 * @returns {GameMap}
 */
export function generateMap(planetId = "ferros", rng = Math.random, opts = {}) {   // deterministic-exempt: unseeded default rng
  const owners = opts.owners || ["player", "ai"];
  if (owners.length !== 2) return generateRadialMap(owners, planetId, rng, opts);
  const [P, A] = owners;

  const planet = PLANETS.find(p => p.id === planetId);
  if (!planet) throw new Error(`Unknown planet: ${planetId}`);
  const worldModifiers = PLANET_MODIFIERS[planetId] || {};
  // Pick your side of an asymmetric matchup (Oort, Nimbus): opts.swapAsym exchanges the
  // player/ai halves of `asym`. Attach a shallow COPY — never mutate `worldModifiers` in
  // place, since it's the SAME object every game on this planet reads by reference
  // (PLANET_MODIFIERS[planetId]); mutating it would corrupt the next game that reads it.
  // Consumes no rng draw, so the map layout below is byte-identical either way.
  const modifiers = (opts.swapAsym && worldModifiers.asym)
    ? { ...worldModifiers, asym: { player: worldModifiers.asym.ai, ai: worldModifiers.asym.player } }
    : worldModifiers;

  const sizeMult = opts.sizeMult || 1;
  const resourceMult = opts.resourceMult || 1;
  const width = MAP_WIDTH * sizeMult;
  const height = MAP_HEIGHT * sizeMult;
  // A node's final amount: its base yield, the world's own richness modifier,
  // and the player's Rare/Normal/Abundant resource choice, all folded in.
  const amountOf = base => Math.max(1, Math.round(base * (modifiers.nodeAmountMult || 1) * resourceMult));

  const bases = {
    [P]: { x: width * 0.1, y: height * 0.5 },
    [A]: { x: width * 0.9, y: height * 0.5 },
  };

  const nodes = [];
  let nid = 0;

  // Home ore, on every base's doorstep at a fixed absolute distance (see
  // HOME_ORE_OFFSETS). Fractional offsets from each base, mirrored across the
  // centreline so both starts open onto the same head start. No rng — added
  // before the rng-driven clusters so the draw sequence, and thus the rest of
  // the map, is untouched. `home` marks them out from the deposit table.
  const homeAmount = amountOf(HOME_ORE_AMOUNT);
  for (const { dx, dy } of HOME_ORE_OFFSETS) {
    nodes.push({ id: `n${nid++}`, com: "ore", amount: homeAmount, max: homeAmount,
      x: bases[P].x + dx, y: bases[P].y + dy, home: true });
    nodes.push({ id: `n${nid++}`, com: "ore", amount: homeAmount, max: homeAmount,
      x: bases[A].x - dx, y: bases[A].y + dy, home: true });
  }

  // A near-base cluster on each side, mirrored, sized by the planet's yield.
  // x is drawn independently per side (matching the original generator), y
  // spreads the clusters down the map. All in fractions of the scaled dims.
  Object.entries(planet.deposits).forEach(([com, yieldMult]) => {
    const clusters = Math.max(1, Math.round(yieldMult * 1.5));
    for (let i = 0; i < clusters; i++) {
      const t = (i + 1) / (clusters + 1);
      const y = height * 0.12 + t * height * 0.76;
      const amount = amountOf(600 * yieldMult);
      nodes.push({ id: `n${nid++}`, com, amount, max: amount, x: width * 0.2 + rng() * width * 0.1, y });
      nodes.push({ id: `n${nid++}`, com, amount, max: amount, x: width * 0.8 - rng() * width * 0.1, y });
    }
  });

  // Build-critical minimums: any of ore/crystals/radioactives the surface
  // doesn't already offer near the player base gets a lean mirrored seam, so
  // every build is possible on every world. Checked (and added) in a fixed
  // order so the rng draw sequence — and thus the map — stays deterministic.
  // Placed before the caches so a hidden cache can never satisfy the check.
  const nearBase = width * NEAR_BASE_FRAC;
  for (const com of BUILD_CRITICAL) {
    // Home ore is excluded here so the seam logic is exactly as it always was:
    // the deposit table alone decides whether a world needs a guaranteed seam,
    // keeping the rng draw sequence and node layout byte-identical.
    const has = nodes.some(n => n.com === com && !n.home &&
      Math.hypot(n.x - bases[P].x, n.y - bases[P].y) <= nearBase);
    if (has) continue;
    const y = height * (0.5 + GUARANTEE_Y[com]);
    const amount = amountOf(MIN_GUARANTEE[com]);
    nodes.push({ id: `n${nid++}`, com, amount, max: amount, x: width * 0.2 + rng() * width * 0.1, y });
    nodes.push({ id: `n${nid++}`, com, amount, max: amount, x: width * 0.8 - rng() * width * 0.1, y });
  }

  // A world can seed extra deposit clusters (helix's dense crystal belt),
  // mirrored per side, stacked around mid-map. Before resolveNodeOverlaps so
  // the newcomers get spread apart from the deposit-table nodes just the same.
  Object.entries(modifiers.extraClusters || {}).forEach(([com, extra]) => {
    for (let i = 0; i < extra; i++) {
      const y = height * 0.5 + (i - (extra - 1) / 2) * height * 0.12;
      const amount = amountOf(600 * (planet.deposits[com] || 1));
      nodes.push({ id: `n${nid++}`, com, amount, max: amount, x: width * 0.2 + rng() * width * 0.1, y });
      nodes.push({ id: `n${nid++}`, com, amount, max: amount, x: width * 0.8 - rng() * width * 0.1, y });
    }
  });

  // Frontier belt: on bigger maps (sizeMult >= 2), a mirrored belt of full-size
  // VISIBLE deposit clusters seeded in the contested middle (x ~0.35-0.45),
  // one additional mirrored set per size step above 1, cycling the world's own
  // deposit commodities. sizeMult used to only grow the hidden caches
  // (0.6x singletons below) — a Gigantic map was the same economy stretched
  // over 16x area with nothing contestable in the middle. Now each size tier
  // adds a real fight over new ground, not just a longer walk. Gated strictly
  // on sizeMult >= 2 and placed after every earlier rng-consuming block, so a
  // sizeMult=1 game's rng draw sequence — and thus its node layout — stays
  // byte-identical (test/map.test.js's byte-for-byte pin). `frontier` marks
  // these out from the deposit-table nodes, same idiom as `home`/`hidden`.
  if (sizeMult >= 2) {
    const beltComs = Object.keys(planet.deposits);
    const beltSteps = sizeMult - 1;
    for (let i = 0; i < beltSteps; i++) {
      const com = beltComs[i % beltComs.length];
      const y = height * 0.5 + (i - (beltSteps - 1) / 2) * height * 0.12;
      const amount = amountOf(600 * (planet.deposits[com] || 1));
      nodes.push({ id: `n${nid++}`, com, amount, max: amount, x: width * 0.35 + rng() * width * 0.10, y, frontier: true });
      nodes.push({ id: `n${nid++}`, com, amount, max: amount, x: width * 0.65 - rng() * width * 0.10, y, frontier: true });
    }
  }

  // Hidden resource caches: extra deposits the survey missed, out in the
  // contested middle and along the vertical extremes, invisible until a unit
  // scouts their cell (fog.js's isNodeDiscovered). Fixed, mirrored fractional
  // positions — the find is gated by fog, not placement luck — and more of
  // them on bigger maps so exploring the larger space keeps paying off.
  const cacheAmount = amountOf(CACHE_BASE_AMOUNT);
  for (const [xf, yf, com, mirror] of cacheSpecs(sizeMult)) {
    // Per-match position jitter so cache spots aren't memorizable map knowledge:
    // each seed hides them somewhere a little different. A mirrored pair jitters
    // its anchor and reflects it (both sides stay equidistant — fair); a
    // centerline cache keeps x=0.5 and only shifts vertically. The jitter is
    // small and the anchors sit far from both bases, so a cache never lands in
    // reach of a start (map.test guards the >300 clearance).
    const jx = mirror ? (rng() - 0.5) * 0.08 : 0;   // ±4% of width; centerline stays centered
    const jy = (rng() - 0.5) * 0.10;                // ±5% of height
    const cx = width * (xf + jx), cy = height * (yf + jy);
    nodes.push({ id: `n${nid++}`, com, amount: cacheAmount, max: cacheAmount, x: cx, y: cy, hidden: true });
    if (mirror) nodes.push({ id: `n${nid++}`, com, amount: cacheAmount, max: cacheAmount, x: width - cx, y: cy, hidden: true });
  }

  resolveNodeOverlaps(nodes, width, height);
  // Index by id so the per-tick node lookups (gather, render, AI) are O(1)
  // instead of a linear .find over a node list that grows with map size. Nodes
  // are never added or removed after generation (they deplete in place), so the
  // Map stays valid for the whole match and holds live references.
  const nodesById = new Map(nodes.map(n => [n.id, n]));
  // Static terrain field from this world's fixed specs (none ⇒ an all-open
  // grid). Built after nodes, consumes no rng — determinism unaffected.
  const terrain = generateTerrain(width, height, modifiers.terrain || []);
  return { planet, width, height, bases, nodes, nodesById, terrain, modifiers };
}

// Fraction of the (scaled) map's own width/height that the radial bases' inscribed ellipse
// uses for its two semi-axes — scaled to each dimension separately so the ellipse naturally
// matches the map's own 1.6:1 aspect ratio (§3.3 point 2's "inscribed ellipse, accept mild
// asymmetry" option) rather than stretching a circle or needing an N-dependent aspect ratio.
const RADIAL_RX_FRAC = 0.35;
const RADIAL_RY_FRAC = 0.35;

/**
 * T-044 (ADR-0008): N-fold rotational-symmetry map for 3+ seats — a SEPARATE generator from
 * generateMap's own 2-base mirrored path above, never a generalization of it (see this file's
 * own module header for why: two generators is honest, one that "also does 2" would not
 * reproduce today's maps). Bases sit on an ellipse inscribed in the map rectangle, evenly
 * spaced by angle. Every per-base resource stage (home ore, deposit clusters, build-critical
 * guarantee seams, extraClusters, frontier belt, hidden caches) places its nodes along the
 * line from that base toward the map centre — the wedge-shaped generalization of the 2-seat
 * path's own "player column / ai column" — so every base gets the exact same node COUNT
 * nearby: no seat's start is left unplayable (docs/analysis/01-engine-nplayer-seams.md §3.2's
 * own bar), by construction.
 *
 * Deliberately narrower than the 2-seat path, both explicit design decisions (§3.4's own
 * "cheap, honest answer for v1"), not oversights:
 *   - Per-world terrain features and `asym` overrides are dropped entirely for N>=3. True
 *     N-fold rotation of an arbitrary rectangular terrain stamp is a real geometry problem
 *     (rotated-rect rasterization) this task doesn't take on; reusing today's LEFT/RIGHT
 *     specs as-is would silently favor whichever 2 of the N bases happen to land near them —
 *     exactly the "seats 3..N play the symmetric version" bug §3.4 itself warns against. Every
 *     N>=3 match plays the plain, symmetric version of every world instead — sideMod's own
 *     `m.asym && m.asym[owner]` already degrades this way for any owner missing from `asym`;
 *     dropping the block here just makes that true for every owner, not only the ones beyond
 *     the original "player"/"ai" pair.
 *   - Hidden caches are a simple one-per-base ring rather than the 2-seat path's own bespoke
 *     hand-placed fractional spec table (itself built around exactly two bases) — still real
 *     bonus resources, just simpler geometry.
 * @param {string[]} owners @param {string} planetId @param {() => number} rng
 * @param {{ sizeMult?: number, resourceMult?: number }} opts
 * @returns {GameMap}
 */
function generateRadialMap(owners, planetId, rng, opts) {
  const planet = PLANETS.find(p => p.id === planetId);
  if (!planet) throw new Error(`Unknown planet: ${planetId}`);
  const worldModifiers = PLANET_MODIFIERS[planetId] || {};
  const modifiers = { ...worldModifiers };
  delete modifiers.asym;
  delete modifiers.terrain;

  const sizeMult = opts.sizeMult || 1;
  const resourceMult = opts.resourceMult || 1;
  const width = MAP_WIDTH * sizeMult;
  const height = MAP_HEIGHT * sizeMult;
  const amountOf = base => Math.max(1, Math.round(base * (modifiers.nodeAmountMult || 1) * resourceMult));

  const n = owners.length;
  const cx = width / 2, cy = height / 2;
  const rx = width * RADIAL_RX_FRAC, ry = height * RADIAL_RY_FRAC;
  /** @type {Object.<string, {x:number,y:number}>} */
  const bases = {};
  for (let k = 0; k < n; k++) {
    const angle = (2 * Math.PI * k) / n;
    bases[owners[k]] = { x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) };
  }
  const baseList = owners.map(id => bases[id]);

  // A point along the line from `base` toward the map centre, `t` of the way there (0 = on the
  // base, 1 = at the centre), nudged sideways by up to `jitter` px — the per-base local frame
  // every resource stage below places nodes in, so the same relative layout rotates cleanly to
  // whatever angle that base landed at.
  const along = (base, t, jitter) => {
    const dx = cx - base.x, dy = cy - base.y;
    const d = Math.hypot(dx, dy) || 1;
    const tX = -dy / d, tY = dx / d;   // unit tangential (perpendicular to the inward direction)
    const side = (rng() - 0.5) * jitter;
    return { x: base.x + dx * t + tX * side, y: base.y + dy * t + tY * side };
  };

  const nodes = [];
  let nid = 0;

  // Home ore doorstep: the SAME fixed absolute offsets/amount/count as the 2-seat path, one
  // ring per base, rotated into that base's own local frame (inward = toward the centre,
  // tangential = perpendicular) so every base opens onto an identical head start.
  const homeAmount = amountOf(HOME_ORE_AMOUNT);
  for (const base of baseList) {
    const dx0 = cx - base.x, dy0 = cy - base.y;
    const d0 = Math.hypot(dx0, dy0) || 1;
    const inX = dx0 / d0, inY = dy0 / d0, tX = -dy0 / d0, tY = dx0 / d0;
    for (const { dx, dy } of HOME_ORE_OFFSETS) {
      nodes.push({ id: `n${nid++}`, com: "ore", amount: homeAmount, max: homeAmount,
        x: base.x + inX * dx + tX * dy, y: base.y + inY * dx + tY * dy, home: true });
    }
  }

  // Deposit clusters: every base gets its own copy of every commodity the planet deposits,
  // spread along its own line toward the centre — the wedge-based generalization of the
  // 2-seat path's "player column / ai column".
  Object.entries(planet.deposits).forEach(([com, yieldMult]) => {
    const clusters = Math.max(1, Math.round(yieldMult * 1.5));
    const amount = amountOf(600 * yieldMult);
    for (let i = 0; i < clusters; i++) {
      const t = 0.2 + (i / clusters) * 0.35;
      for (const base of baseList) {
        const p = along(base, t, width * 0.08);
        nodes.push({ id: `n${nid++}`, com, amount, max: amount, x: p.x, y: p.y });
      }
    }
  });

  // Build-critical minimums: checked and, if missing, added PER BASE — under N seats every
  // base needs its own seam, not one mirrored pair.
  const nearBase = width * NEAR_BASE_FRAC;
  for (const com of BUILD_CRITICAL) {
    const amount = amountOf(MIN_GUARANTEE[com]);
    for (const base of baseList) {
      const has = nodes.some(node => node.com === com && !node.home &&
        Math.hypot(node.x - base.x, node.y - base.y) <= nearBase);
      if (has) continue;
      const p = along(base, 0.3, width * 0.03);
      nodes.push({ id: `n${nid++}`, com, amount, max: amount, x: p.x, y: p.y });
    }
  }

  // extraClusters (helix's dense belt): same per-base treatment as the deposit table above.
  Object.entries(modifiers.extraClusters || {}).forEach(([com, extra]) => {
    const amount = amountOf(600 * (planet.deposits[com] || 1));
    for (let i = 0; i < extra; i++) {
      for (const base of baseList) {
        const p = along(base, 0.45 + i * 0.08, width * 0.05);
        nodes.push({ id: `n${nid++}`, com, amount, max: amount, x: p.x, y: p.y });
      }
    }
  });

  // Frontier belt (sizeMult >= 2): one full-size cluster per base per size step, partway
  // between each base and the centre, cycling the world's own commodities — the same
  // "one more real fight per size tier" idea as the 2-seat path's own belt.
  if (sizeMult >= 2) {
    const beltComs = Object.keys(planet.deposits);
    const beltSteps = sizeMult - 1;
    for (let i = 0; i < beltSteps; i++) {
      const com = beltComs[i % beltComs.length];
      const amount = amountOf(600 * (planet.deposits[com] || 1));
      for (const base of baseList) {
        const p = along(base, 0.6 + i * 0.05, width * 0.06);
        nodes.push({ id: `n${nid++}`, com, amount, max: amount, x: p.x, y: p.y, frontier: true });
      }
    }
  }

  // Hidden caches: one per base, out toward the centre, cycling commodities — a deliberately
  // simpler v1 than the 2-seat path's own hand-placed spec table (see this function's header).
  const cacheAmount = amountOf(CACHE_BASE_AMOUNT);
  const cacheComs = ["crystals", "radioactives", "ore"];
  owners.forEach((id, k) => {
    const p = along(bases[id], 0.85, width * 0.05);
    const com = cacheComs[k % cacheComs.length];
    nodes.push({ id: `n${nid++}`, com, amount: cacheAmount, max: cacheAmount, x: p.x, y: p.y, hidden: true });
  });

  resolveNodeOverlaps(nodes, width, height);
  const nodesById = new Map(nodes.map(nd => [nd.id, nd]));
  const terrain = generateTerrain(width, height, []);   // no per-world terrain at N>=3 — see header
  return { planet, width, height, bases, nodes, nodesById, terrain, modifiers };
}

// Hidden-cache placements as [xFrac, yFrac, commodity, mirror?]: mirror pairs
// the spot across the map's vertical centerline for fairness; a centerline
// spot (xFrac 0.5) is left single (equidistant from both bases). All sit clear
// of the base-side deposit clusters, out where you have to explore. Bigger
// maps add extra mirrored pairs tiling the wider middle, cycling commodities.
function cacheSpecs(sizeMult) {
  const specs = [
    [0.375, 0.20, "crystals", true],
    [0.375, 0.80, "radioactives", true],
    [0.4375, 0.50, "ore", true],
    [0.5, 0.15, "radioactives", false],
    [0.5, 0.85, "crystals", false],
  ];
  const coms = ["crystals", "radioactives", "ore"];
  let k = 0;
  for (let layer = 1; layer < sizeMult; layer++) {
    const xf = 0.30 + (layer / sizeMult) * 0.18;
    for (const yf of [0.30, 0.50, 0.70]) specs.push([xf, yf, coms[k++ % coms.length], true]);
  }
  return specs;
}

/* ---------- per-planet rule modifiers ---------- */

// Per-planet RTS-only combat/economy tweaks, keyed by planet id. These live
// engine-side (data.js is carried over verbatim from the turn-based game and
// stays pure flavor data) and get threaded into movement/fog/combat/production
// as `state.map.modifiers`. A world with no entry here plays by the defaults —
// which is why ferros/korrath/vesper (the original three) deliberately carry
// none, keeping their long-established sim behavior unchanged.
export const PLANET_MODIFIERS = {
  // `terrain` (optional) is a list of feature specs (see generateTerrain):
  // [xFrac, yFrac, wFrac, hFrac, code, mirror?], code 1=rough, 2=high ground.
  glacius: {
    speedMult: 0.9, label: "Frozen ground: all units 10% slower; ice fields flank a central lane",
    // Rough ice fields top and bottom of the midline pinch armies through an
    // open central corridor — a soft choke on top of the world's global slow.
    terrain: [[0.5, 0.13, 0.34, 0.2, 1, false], [0.5, 0.87, 0.34, 0.2, 1, false]],
  },
  nimbus:  {
    sightMult: 0.75, label: "Storm front (asymmetric): your skies are clearer; the enemy surges out of the murk",
    // On a short-sight world, high ground (which extends sight) is doubly worth
    // taking — a way to see over the storm. Two vantages, north and south of
    // the midline, kept off the centre so neither base overlooks the field.
    terrain: [[0.5, 0.28, 0.12, 0.14, 2, false], [0.5, 0.72, 0.12, 0.14, 2, false]],
    // Asymmetric matchup: the storm has half-cleared YOUR side (you see almost
    // normally, 0.95 vs the enemy's 0.75), but the enemy strikes fast out of it
    // (units 12% quicker). You out-scout; they out-tempo.
    asym: { player: { sightMult: 0.95 }, ai: { speedMult: 1.12 } },
  },
  pyralis: {
    sightMult: 1.15, label: "Open dunes: long sightlines, and a central mesa worth holding",
    // High-ground mesa in the contested middle: extra sight and a damage edge
    // for whoever seizes it — a real objective on an otherwise open field.
    terrain: [[0.5, 0.5, 0.16, 0.26, 2, false]],
  },
  helix:   {
    extraClusters: { crystals: 1 }, label: "Dense belt: an extra crystal field per side, and a central ridge to hold",
    // A crystalline high-ground ridge down the centreline — the contested spine
    // of the belt, giving sight and a combat edge to whoever seizes the middle.
    terrain: [[0.5, 0.5, 0.1, 0.38, 2, false]],
  },
  oort:    {
    nodeAmountMult: 1.3, label: "Contested frontier (asymmetric): your claim is richer; the enemy's foundry runs hotter",
    // Rugged rough ground on the flanks funnels the fight through the open
    // centre — the price of the world's rich but broken frontier.
    terrain: [[0.4, 0.28, 0.12, 0.18, 1, true], [0.4, 0.72, 0.12, 0.18, 1, true]],
    // Asymmetric matchup: YOUR claim struck a rich vein (every haul banks 20%
    // more), while the enemy's forward base is a war factory (18% faster
    // construction and production). You out-mine; they out-build.
    asym: { player: { gatherMult: 1.2 }, ai: { buildTimeMult: 0.82 } },
  },
  forge:   {
    buildTimeMult: 0.85, label: "Factory world: 15% faster construction; rough industrial sprawl midfield",
    // Scattered rough ground on the approach makes the flanks slow going and
    // the direct centre the fast lane.
    terrain: [[0.4, 0.32, 0.13, 0.18, 1, true], [0.4, 0.68, 0.13, 0.18, 1, true]],
  },
};

// Each commodity picks its cluster spots independently, so two different
// deposit types can land on (or right next to) the same point — same
// stacking problem as units, just at generation time instead of every
// tick. A fixed number of relaxation passes nudges every overlapping pair
// apart regardless of what they are, until none are left (or the budget
// runs out on a pathological case rather than looping forever).
// Matches drawNodes' max render radius (7 + 9) in render.js. Exported
// because colliders.js treats it as the node's physical footprint too —
// what the map draws and what a building must keep clear of stay one number.
export const NODE_RADIUS = 16;
const RESOLVE_ITERATIONS = 40;

function resolveNodeOverlaps(nodes, width, height) {
  const minDist = NODE_RADIUS * 2;
  for (let iter = 0; iter < RESOLVE_ITERATIONS; iter++) {
    let moved = false;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let dist = Math.hypot(dx, dy);
        if (dist >= minDist) continue;
        moved = true;
        if (dist < 1e-4) { dx = 1; dy = 0; dist = 1; }
        const push = (minDist - dist) / 2;
        const nx = dx / dist, ny = dy / dist;
        a.x -= nx * push; a.y -= ny * push;
        b.x += nx * push; b.y += ny * push;
      }
    }
    if (!moved) break;
  }
  for (const n of nodes) {
    n.x = Math.min(Math.max(n.x, 20), width - 20);
    n.y = Math.min(Math.max(n.y, 20), height - 20);
  }
}
