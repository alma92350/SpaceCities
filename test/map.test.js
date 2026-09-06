import { test } from "node:test";
import assert from "node:assert/strict";
import { generateMap, MAP_WIDTH, MAP_HEIGHT, PLANET_MODIFIERS, sideMod } from "../engine/map.js";
import { PLANET_ARCHETYPE } from "../engine/aiArchetypes.js";
import { PLANETS } from "../data.js";

// Tiny deterministic PRNG so two generateMap runs can share an identical
// rng sequence (() => 0.5 can't distinguish "same seed" from "constant").
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

test("generateMap only scatters surface nodes for commodities the planet actually deposits", () => {
  const map = generateMap("ferros", () => 0.5);
  const coms = new Set(map.nodes.filter(n => !n.hidden).map(n => n.com));   // hidden caches can add others
  assert.deepEqual([...coms].sort(), ["crystals", "ore", "radioactives"]);
});

test("generateMap mirrors clusters so both bases start with access to every deposit", () => {
  const map = generateMap("ferros", () => 0.5);
  const oreNodes = map.nodes.filter(n => n.com === "ore");
  assert.equal(oreNodes.length % 2, 0);
  const nearPlayer = oreNodes.filter(n => n.x < MAP_WIDTH / 2).length;
  const nearAi = oreNodes.filter(n => n.x >= MAP_WIDTH / 2).length;
  assert.equal(nearPlayer, nearAi);
});

test("generateMap places the two bases inside the map bounds", () => {
  const map = generateMap("ferros");
  for (const base of Object.values(map.bases)) {
    assert.ok(base.x >= 0 && base.x <= MAP_WIDTH);
    assert.ok(base.y >= 0 && base.y <= MAP_HEIGHT);
  }
});

test("generateMap throws on an unknown planet id", () => {
  assert.throws(() => generateMap("not-a-real-planet"));
});

test("no two nodes overlap, even across different commodity types", () => {
  // rng() => 0.5 is the exact seed that used to land an ore cluster and a
  // crystals cluster on the identical point (each commodity picks its own
  // y-band independently, with no coordination between them).
  for (const planetId of ["ferros", "korrath", "vesper", "glacius", "helix"]) {
    const map = generateMap(planetId, () => 0.5);
    for (let i = 0; i < map.nodes.length; i++) {
      for (let j = i + 1; j < map.nodes.length; j++) {
        const a = map.nodes[i], b = map.nodes[j];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        assert.ok(dist >= 32 - 1e-6, `${planetId}: ${a.com} node and ${b.com} node are only ${dist.toFixed(1)} apart`);
      }
    }
  }
});

test("overlap resolution keeps every node inside the map bounds", () => {
  const map = generateMap("ferros", () => 0.5);
  for (const n of map.nodes) {
    assert.ok(n.x >= 0 && n.x <= MAP_WIDTH, `node x=${n.x} out of bounds`);
    assert.ok(n.y >= 0 && n.y <= MAP_HEIGHT, `node y=${n.y} out of bounds`);
  }
});

test("a world that deposits no ore still gets a mirrored ore cluster near each base", () => {
  const map = generateMap("glacius", () => 0.5);   // glacius deposits only ice and gas
  const oreNodes = map.nodes.filter(n => n.com === "ore");
  assert.ok(oreNodes.length > 0, "the guarantee should have inserted ore");
  assert.equal(oreNodes.length % 2, 0, "guaranteed ore should come as mirrored pairs");
  const left = oreNodes.filter(n => n.x < MAP_WIDTH / 2).length;
  const right = oreNodes.filter(n => n.x >= MAP_WIDTH / 2).length;
  assert.equal(left, right);
  for (const base of Object.values(map.bases)) {
    const near = oreNodes.some(n => Math.hypot(n.x - base.x, n.y - base.y) <= 500);
    assert.ok(near, "each base should have an ore node within reach");
  }
});

test("every charted world yields ore within reach of both bases", () => {
  for (const planet of PLANETS) {
    const map = generateMap(planet.id, () => 0.5);
    for (const base of Object.values(map.bases)) {
      const near = map.nodes.some(n => n.com === "ore" &&
        Math.hypot(n.x - base.x, n.y - base.y) <= 500);
      assert.ok(near, `${planet.id}: no ore within 500 of the base at (${base.x}, ${base.y})`);
    }
  }
});

test("the ore guarantee never fires on an ore-bearing world: ferros keeps its deposit-table node count", () => {
  const map = generateMap("ferros", () => 0.5);
  // surface deposit ore only — caches (hidden) and the fixed home cluster (home) are separate
  const oreNodes = map.nodes.filter(n => n.com === "ore" && !n.hidden && !n.home);
  assert.equal(oreNodes.length, Math.round(2.0 * 1.5) * 2);   // ferros' ore yieldMult drives exactly 3 mirrored clusters
});

test("generateMap is deterministic: the same planet and rng seed reproduce the same nodes", () => {
  const a = generateMap("glacius", lcg(42));
  const b = generateMap("glacius", lcg(42));
  assert.deepEqual(a.nodes, b.nodes);
});

test("asymmetric worlds apply per-side modifiers; symmetric worlds tilt both sides equally", () => {
  const oort = { map: generateMap("oort", () => 0.5) };
  assert.equal(sideMod(oort, "player", "gatherMult"), 1.2, "the player's richer claim banks more");
  assert.equal(sideMod(oort, "ai", "gatherMult", 1), 1, "the enemy gets no gather bonus");
  assert.equal(sideMod(oort, "ai", "buildTimeMult"), 0.82, "the enemy's factory builds faster");
  assert.equal(sideMod(oort, "player", "buildTimeMult"), 1, "the player builds at the normal rate");

  const nimbus = { map: generateMap("nimbus", () => 0.5) };
  assert.equal(sideMod(nimbus, "player", "sightMult"), 0.95, "the player sees through the thinning storm");
  assert.equal(sideMod(nimbus, "ai", "sightMult"), 0.75, "the enemy stays in the murk (the world's shared value)");
  assert.equal(sideMod(nimbus, "ai", "speedMult"), 1.12, "but the enemy strikes faster out of it");

  // A symmetric world tilts both sides equally, and an unmodified one is neutral.
  const glacius = { map: generateMap("glacius", () => 0.5) };
  assert.equal(sideMod(glacius, "player", "speedMult"), sideMod(glacius, "ai", "speedMult"), "glacius slows both sides the same");
  const ferros = { map: generateMap("ferros", () => 0.5) };
  assert.equal(sideMod(ferros, "player", "speedMult"), 1, "ferros has no modifier -> default");
});

test("opts.swapAsym exchanges the player/ai halves of an asymmetric world's matchup", () => {
  const swapped = { map: generateMap("oort", () => 0.5, { swapAsym: true }) };
  assert.equal(sideMod(swapped, "player", "buildTimeMult"), 0.82, "the player now gets the faster factory");
  assert.equal(sideMod(swapped, "ai", "gatherMult"), 1.2, "the AI now gets the richer claim");
  assert.equal(sideMod(swapped, "ai", "buildTimeMult", 1), 1, "the enemy loses the build-speed edge once swapped");
  assert.equal(sideMod(swapped, "player", "gatherMult", 1), 1, "the player loses the gather edge it had unswapped");

  const swappedNimbus = { map: generateMap("nimbus", () => 0.5, { swapAsym: true }) };
  assert.equal(sideMod(swappedNimbus, "player", "speedMult", 1), 1.12, "the player now strikes faster out of the storm");
  assert.equal(sideMod(swappedNimbus, "ai", "sightMult"), 0.95, "the enemy now sees through the thinning storm");
});

test("opts.swapAsym never mutates the shared PLANET_MODIFIERS table", () => {
  generateMap("oort", () => 0.5, { swapAsym: true });
  assert.equal(PLANET_MODIFIERS.oort.asym.player.gatherMult, 1.2, "the shared table's player half is unchanged");
  assert.equal(PLANET_MODIFIERS.oort.asym.ai.buildTimeMult, 0.82, "the shared table's ai half is unchanged");
  // An UNSWAPPED game generated after a swapped one must still read the normal assignment —
  // proof the swap attached a copy, not a mutation of the object every game shares by reference.
  const again = { map: generateMap("oort", () => 0.5) };
  assert.equal(sideMod(again, "player", "gatherMult"), 1.2, "an unswapped game after a swapped one reads the normal assignment");
  assert.equal(sideMod(again, "ai", "buildTimeMult"), 0.82, "…on both halves of the matchup");
});

test("opts.swapAsym is a no-op on a world with no asym block, and doesn't perturb node generation", () => {
  const normal = generateMap("ferros", () => 0.5);
  const swapped = generateMap("ferros", () => 0.5, { swapAsym: true });
  assert.deepEqual(swapped.modifiers, normal.modifiers, "no asym block to swap -> modifiers are unaffected");
  assert.deepEqual(swapped.nodes, normal.nodes, "swapping consumes no rng draw -> the map layout is untouched");

  const oortNormal = generateMap("oort", () => 0.5);
  const oortSwapped = generateMap("oort", () => 0.5, { swapAsym: true });
  assert.deepEqual(oortSwapped.nodes, oortNormal.nodes, "swapping which side gets which bonus doesn't touch the map layout");
});

test("generateMap attaches the planet's modifiers (empty for the unmodified worlds)", () => {
  assert.deepEqual(generateMap("ferros", () => 0.5).modifiers, {}, "ferros carries no modifiers");
  assert.equal(generateMap("glacius", () => 0.5).modifiers.speedMult, 0.9, "glacius slows every unit");
});

test("helix's dense belt adds one extra crystal cluster per side, on top of its deposit table", () => {
  const map = generateMap("helix", () => 0.5);
  const crystals = map.nodes.filter(n => n.com === "crystals" && !n.hidden);   // surface crystals only
  const left = crystals.filter(n => n.x < MAP_WIDTH / 2).length;
  const right = crystals.filter(n => n.x >= MAP_WIDTH / 2).length;
  // helix crystals yieldMult 1.4 -> round(1.4 * 1.5) = 2 deposit clusters per side, + 1 belt cluster.
  assert.equal(left, Math.round(1.4 * 1.5) + 1);
  assert.equal(right, Math.round(1.4 * 1.5) + 1);
});

test("oort's rich frontier makes its deposits hold 30% more", () => {
  const map = generateMap("oort", () => 0.5);
  // surface deposit ore only — home cluster and hidden caches size differently
  const oreNodes = map.nodes.filter(n => n.com === "ore" && !n.hidden && !n.home);
  assert.ok(oreNodes.length > 0);
  // oort deposits ore at 1.2, so the ore guarantee never fires here — every
  // surface ore node is a deposit-table node scaled by the 1.3 nodeAmountMult.
  for (const n of oreNodes) {
    assert.equal(n.max, Math.round(600 * 1.2 * 1.3));
  }
});

test("every world seeds hidden caches out in the field, away from both bases", () => {
  for (const id of ["ferros", "korrath", "glacius"]) {
    const map = generateMap(id, () => 0.5);
    const caches = map.nodes.filter(n => n.hidden);
    assert.ok(caches.length >= 6, `${id}: should scatter several discoverable caches`);
    for (const c of caches) {
      assert.ok(c.amount > 0 && c.max > 0, "a cache holds a real amount");
      assert.ok(["ore", "crystals", "radioactives"].includes(c.com), "caches hold spendable commodities");
      for (const base of Object.values(map.bases)) {
        assert.ok(Math.hypot(c.x - base.x, c.y - base.y) > 300, `${id}: a cache must sit out where you have to explore for it`);
      }
    }
  }
});

test("every world guarantees a near-base surface source of every build-critical resource", () => {
  // ore (all units/buildings), crystals (Turret, Reinforced Plating) and
  // radioactives (Breacher, Overcharged Weapons) must be buildable on any
  // world — even ones whose deposit table lacks them (korrath has no crystals,
  // vesper no radioactives) get a lean guaranteed seam near the base. The
  // planet's own deposits still shape how *much* of each there is.
  const near = 500 + 60;   // the near-base radius, plus slack for overlap relaxation
  for (const id of ["korrath", "vesper", "glacius", "nimbus", "ferros", "forge"]) {
    const map = generateMap(id, () => 0.5);
    for (const com of ["ore", "crystals", "radioactives"]) {
      const nearBase = map.nodes.some(n => n.com === com && !n.hidden &&
        Math.hypot(n.x - map.bases.player.x, n.y - map.bases.player.y) <= near);
      assert.ok(nearBase, `${id}: needs a surface ${com} source near the base for its builds`);
    }
  }
});

test("a world rich in a commodity keeps its big deposits; a world without it gets only the minimum", () => {
  // helix deposits crystals heavily; korrath deposits none. Both are buildable,
  // but helix's surface crystal total should dwarf korrath's guaranteed floor.
  const total = (id, com) => generateMap(id, () => 0.5).nodes
    .filter(n => n.com === com && !n.hidden).reduce((s, n) => s + n.amount, 0);
  assert.ok(total("helix", "crystals") > total("korrath", "crystals") * 2,
    "the planet's deposit table still drives how much of a resource it holds");
});

test("map size scales the dimensions, bases, and node bounds; sizeMult 1 is the Small default", () => {
  const small = generateMap("ferros", () => 0.5);
  assert.equal(small.width, MAP_WIDTH);
  assert.equal(small.height, MAP_HEIGHT);

  const big = generateMap("ferros", () => 0.5, { sizeMult: 3 });
  assert.equal(big.width, MAP_WIDTH * 3);
  assert.equal(big.height, MAP_HEIGHT * 3);
  assert.ok(Math.abs(big.bases.player.x - big.width * 0.1) < 1e-6, "player base stays at 10% in");
  assert.ok(Math.abs(big.bases.ai.x - big.width * 0.9) < 1e-6, "AI base stays at 90% in");
  for (const n of big.nodes) {
    assert.ok(n.x >= 0 && n.x <= big.width && n.y >= 0 && n.y <= big.height, "every node stays inside the bigger map");
  }
});

test("every base opens onto home ore at a fixed distance, on every map size and world", () => {
  // The whole point of the home cluster: the opening economy can't scale away
  // from the base as the map grows. On Small through Gigantic, and on a world
  // that deposits no ore at all, both bases must have reachable ore within a
  // fixed absolute radius — enough to fund a 400-ore second Command Center.
  const HOME_REACH = 260;   // ~165px offset + overlap-relaxation slack; independent of map size
  for (const size of [1, 2, 4]) {
    for (const id of ["ferros", "glacius"]) {   // glacius deposits no ore — only the home cluster can satisfy this
      const map = generateMap(id, () => 0.5, { sizeMult: size });
      for (const [side, base] of Object.entries(map.bases)) {
        const homeOre = map.nodes.filter(n => n.com === "ore" && n.home &&
          Math.hypot(n.x - base.x, n.y - base.y) <= HOME_REACH);
        assert.ok(homeOre.length > 0, `${id} ${size}x: ${side} base needs home ore within ${HOME_REACH}`);
        const total = homeOre.reduce((s, n) => s + n.amount, 0);
        assert.ok(total >= 400, `${id} ${size}x: ${side} home ore (${total}) must fund a second Command Center`);
      }
    }
  }
});

test("home ore is mirrored so both starts get the identical head start", () => {
  const map = generateMap("ferros", () => 0.5);
  const home = map.nodes.filter(n => n.home);
  const left = home.filter(n => n.x < MAP_WIDTH / 2);
  const right = home.filter(n => n.x >= MAP_WIDTH / 2);
  assert.equal(left.length, right.length, "same count of home nodes each side");
  assert.equal(left.reduce((s, n) => s + n.amount, 0), right.reduce((s, n) => s + n.amount, 0),
    "same total home ore each side");
});

test("sizeMult 1 / resourceMult 1 reproduces the original map byte-for-byte", () => {
  const a = generateMap("ferros", lcg(99));
  const b = generateMap("ferros", lcg(99), { sizeMult: 1, resourceMult: 1 });
  assert.deepEqual(a.nodes, b.nodes, "explicit defaults must match the implicit ones exactly");
});

test("the resource multiplier scales deposit amounts up (abundant) and down (rare)", () => {
  const oreTotal = mult => generateMap("ferros", () => 0.5, { resourceMult: mult }).nodes
    .filter(n => n.com === "ore").reduce((s, n) => s + n.amount, 0);
  const rare = oreTotal(0.6), normal = oreTotal(1), abundant = oreTotal(1.5);
  assert.ok(rare < normal && normal < abundant, "Rare < Normal < Abundant ore on the same world");
  assert.ok(Math.abs(abundant / normal - 1.5) < 0.05, "abundant is ~1.5x normal");
});

test("bigger maps seed more hidden caches to fill the larger contested space", () => {
  const caches = size => generateMap("ferros", () => 0.5, { sizeMult: size }).nodes.filter(n => n.hidden).length;
  assert.ok(caches(4) > caches(1), "a Gigantic map should hide more caches than a Small one");
});

// ---- Frontier belts: bigger maps add contested expansion fields, not just distance.
// sizeMult used to only grow the HIDDEN caches; a Small map's contested middle held
// nothing VISIBLE to fight over. Nothing before this exercised a belt at all.

test("sizeMult 1 (Small) seeds no frontier belt at all", () => {
  const map = generateMap("ferros", () => 0.5);
  assert.equal(map.nodes.filter(n => n.frontier).length, 0, "the Small map keeps today's two-base-band layout only");
});

test("sizeMult 1 draws no extra rng for the belt, so the byte-identical layout is untouched", () => {
  // Same rng seed, sizeMult passed explicitly vs left implicit — if the belt block ever
  // consumed an rng draw at sizeMult 1 this would desync and fail, exactly like the
  // existing "byte-for-byte" pin above but naming the belt explicitly for intent.
  const a = generateMap("ferros", lcg(7));
  const b = generateMap("ferros", lcg(7), { sizeMult: 1 });
  assert.deepEqual(a.nodes, b.nodes);
});

test("sizeMult >= 2 seeds a mirrored frontier belt of full-size visible clusters in the contested middle", () => {
  for (const size of [2, 3, 4]) {
    const map = generateMap("ferros", () => 0.5, { sizeMult: size });
    const belt = map.nodes.filter(n => n.frontier);
    assert.equal(belt.length, (size - 1) * 2, `${size}x: one additional MIRRORED set per size step above 1`);
    for (const n of belt) {
      assert.ok(!n.hidden, "belt clusters are visible on the map, not hidden caches");
      const xf = n.x / map.width;
      const inContestedBand = (xf >= 0.35 - 1e-6 && xf <= 0.45 + 1e-6) || (xf >= 0.55 - 1e-6 && xf <= 0.65 + 1e-6);
      assert.ok(inContestedBand, `belt node x-fraction ${xf.toFixed(3)} should sit in the contested middle (~0.35-0.45, mirrored), not a base-side band`);
    }
    const left = belt.filter(n => n.x < map.width / 2), right = belt.filter(n => n.x >= map.width / 2);
    assert.equal(left.length, right.length, "the belt is mirrored across the centreline");
    assert.equal(left.reduce((s, n) => s + n.amount, 0), right.reduce((s, n) => s + n.amount, 0), "mirrored halves hold equal amounts");
  }
});

test("frontier belt clusters are full-size (600 * yieldMult), not the smaller hidden-cache amount", () => {
  const map = generateMap("ferros", () => 0.5, { sizeMult: 2 });
  const belt = map.nodes.filter(n => n.frontier);
  assert.ok(belt.length > 0, "fixture sanity: a belt exists at 2x");
  for (const n of belt) {
    const yieldMult = PLANETS.find(p => p.id === "ferros").deposits[n.com] || 1;
    assert.equal(n.max, Math.round(600 * yieldMult), `${n.com} belt node should size like a full deposit cluster, not a 0.6x cache`);
  }
});

test("the frontier belt cycles the world's own deposit commodities, growing by one mirrored set per size step", () => {
  const deposits = Object.keys(PLANETS.find(p => p.id === "helix").deposits);   // ore, crystals, radioactives
  const map3 = generateMap("helix", () => 0.5, { sizeMult: 3 });   // 2 belt sets -> cycles the first two commodities
  const coms3 = map3.nodes.filter(n => n.frontier).map(n => n.com);
  assert.deepEqual([...new Set(coms3)].sort(), deposits.slice(0, 2).sort());

  const map4 = generateMap("helix", () => 0.5, { sizeMult: 4 });   // 3 belt sets -> the whole 3-commodity table
  const coms4 = map4.nodes.filter(n => n.frontier).map(n => n.com);
  assert.deepEqual([...new Set(coms4)].sort(), deposits.slice().sort());
});

test("every modified world is a real planet with a nonempty label, and has an archetype", () => {
  for (const [id, mod] of Object.entries(PLANET_MODIFIERS)) {
    assert.ok(PLANETS.some(p => p.id === id), `${id} should be a real planet`);
    assert.ok(id in PLANET_ARCHETYPE, `${id} should be in the picker roster`);
    assert.ok(mod.label && mod.label.length > 0, `${id} should carry a human-readable label`);
  }
});

/* ============================================================
   T-044 (ADR-0008): a radial map generator for N >= 3 start positions.

   docs/analysis/01-engine-nplayer-seams.md §3.3's own recommendation: keep generateMap's
   current 2-base mirrored path VERBATIM as the owners.length === 2 branch (every existing
   seed/replay/test/determinism-roster.test.js untouched), and add a SEPARATE generator for
   N >= 3 — "two generators is honest; one generator that also does 2 will not reproduce
   today's maps." Bases go on an ellipse inscribed in the map rectangle (§3.3 point 2's own
   "accept mild asymmetry" option, scaled to the map's own 1.6:1 aspect ratio rather than an
   N-dependent aspect ratio), evenly spaced by angle. Every per-base resource stage places its
   nodes along the line from that base to the map centre — the wedge-shaped generalization of
   the 2-seat path's own "player column / ai column" — so node COUNT near every base is
   exactly equal, satisfying §3.2's "unplayable, not merely unbalanced" bar.

   Deliberately narrower than the 2-seat path (§3.4's own "cheap, honest answer for v1"),
   not an oversight: per-world terrain features and asym overrides are NOT applied at N >= 3
   (true N-fold rotation of an arbitrary rectangular terrain stamp is a real geometry problem
   this task doesn't take on, and reusing today's LEFT/RIGHT specs as-is would silently favor
   whichever 2 of the N bases happen to land near them — exactly the "seats 3..N play the
   symmetric version" bug §3.4 itself warns against); hidden caches are a simple ring rather
   than the 2-seat path's own bespoke fractional spec table (itself built around exactly two
   bases).
   ============================================================ */

function ownersN(n) {
  const ids = ["player", "ai", "rebels", "raiders", "outcasts", "syndicate", "vanguard", "wardens"];
  return ids.slice(0, n);
}

test("T-044: generateMap's 2-seat path stays byte-identical when owners is omitted, and when it's explicitly [\"player\",\"ai\"]", () => {
  const before = generateMap("ferros", lcg(7));
  const omitted = generateMap("ferros", lcg(7));
  const explicit = generateMap("ferros", lcg(7), { owners: ["player", "ai"] });
  assert.deepEqual(omitted, before);
  assert.deepEqual(explicit, before);
});

test("T-044: a 2-seat match with custom owner ids still uses the mirrored path, just keyed by those ids", () => {
  const custom = generateMap("ferros", lcg(7), { owners: ["alice", "bob"] });
  const stock = generateMap("ferros", lcg(7));
  assert.deepEqual(Object.keys(custom.bases).sort(), ["alice", "bob"]);
  assert.ok(Math.abs(custom.bases.alice.x - stock.bases.player.x) < 1e-9, "same geometry, just a different key");
  assert.ok(Math.abs(custom.bases.bob.x - stock.bases.ai.x) < 1e-9);
});

test("T-044: N >= 3 owners each get a real base, evenly spaced on the inscribed ellipse and equally angled", () => {
  // "Equidistant" here means every base sits exactly ON the same inscribed ellipse (the
  // ellipse-normalized distance is 1 for all of them) and consecutive bases are separated by
  // the same angle (2*PI/N) — NOT the same raw Euclidean pixel distance from centre, which an
  // ellipse (unlike a circle) never gives by construction. That's the audit's own explicit
  // tradeoff (docs/analysis/01-engine-nplayer-seams.md §3.3 point 2): an inscribed ellipse
  // scaled to the map's own 1.6:1 aspect ratio, accepting this "mild asymmetry" over either an
  // N-dependent aspect ratio or a circle that either wastes width or pushes bases off a
  // narrower map.
  for (const n of [3, 4, 6, 8]) {
    const owners = ownersN(n);
    const map = generateMap("ferros", lcg(11), { owners });
    assert.deepEqual(Object.keys(map.bases).sort(), owners.slice().sort(), `${n} owners -> ${n} bases`);
    const cx = map.width / 2, cy = map.height / 2;
    const rx = map.width * 0.35, ry = map.height * 0.35;
    const angles = [];
    for (const id of owners) {
      const b = map.bases[id];
      const ellipseDist = ((b.x - cx) / rx) ** 2 + ((b.y - cy) / ry) ** 2;
      assert.ok(Math.abs(ellipseDist - 1) < 1e-6, `${n}-seat: ${id}'s base must sit exactly on the inscribed ellipse`);
      angles.push(Math.atan2((b.y - cy) / ry, (b.x - cx) / rx));
    }
    angles.sort((a, b) => a - b);
    const gaps = angles.map((a, i) => (i + 1 < angles.length ? angles[i + 1] - a : angles[0] + 2 * Math.PI - a));
    for (const g of gaps) assert.ok(Math.abs(g - (2 * Math.PI) / n) < 1e-6, `${n}-seat: every base must be evenly angled around the ellipse`);
  }
});

test("T-044: N >= 3 bases stay inside the map bounds", () => {
  const map = generateMap("ferros", lcg(3), { owners: ownersN(6) });
  for (const base of Object.values(map.bases)) {
    assert.ok(base.x >= 0 && base.x <= map.width);
    assert.ok(base.y >= 0 && base.y <= map.height);
  }
});

test("T-044: N >= 3 — every base opens onto its own home ore doorstep, the same total as the 2-seat path", () => {
  const owners = ownersN(4);
  const map = generateMap("ferros", lcg(5), { owners });
  for (const id of owners) {
    const near = map.nodes.filter(n => n.home && n.com === "ore" &&
      Math.hypot(n.x - map.bases[id].x, n.y - map.bases[id].y) < 250);
    const total = near.reduce((s, n) => s + n.amount, 0);
    assert.equal(near.length, 3, `${id}: must get all 3 home ore nodes, same as the 2-seat path`);
    assert.equal(total, 1050, `${id}: home ore total must match the 2-seat path's own 350*3`);
  }
});

test("T-044: N >= 3 — build-critical guarantee holds independently for every base, not just the first", () => {
  // korrath has no crystals deposit and vesper no radioactives — exactly the worlds the 2-seat
  // guarantee test above already exercises, now checked per-base instead of per-mirrored-pair.
  const near = 500 + 80;
  for (const [planetId, owners] of [["korrath", ownersN(3)], ["vesper", ownersN(5)]]) {
    const map = generateMap(planetId, lcg(9), { owners });
    for (const id of owners) {
      for (const com of ["ore", "crystals", "radioactives"]) {
        const has = map.nodes.some(n => n.com === com && !n.hidden &&
          Math.hypot(n.x - map.bases[id].x, n.y - map.bases[id].y) <= near);
        assert.ok(has, `${planetId}/${id}: needs a surface ${com} source near its own base`);
      }
    }
  }
});

test("T-044: N >= 3 — every base is assigned the exact same node count, for every commodity — no seat starts behind", () => {
  // A fixed pixel radius isn't the right measure here: adjacent bases can sit closer together
  // than double a generous "near" radius (more so as N grows), so a node genuinely generated
  // FOR one base can also fall inside a NEIGHBOUR's fixed-radius circle — that's a real
  // shared/contested-middle effect (the same idea the 2-seat path's own frontier belt and
  // hidden caches already lean on), not an unfairness bug. What the construction actually
  // guarantees or breaks is which base each node is CLOSEST to: every resource stage below
  // runs the identical `for (const base of baseList)` loop once per base, so grouping every
  // non-hidden node by its NEAREST base is the honest, geometry-proof way to check every base
  // was given an equal share.
  const owners = ownersN(4);
  const map = generateMap("helix", lcg(13), { owners });   // helix: extraClusters too, the richest layout
  const nearestOwner = (x, y) => owners.reduce((best, id) =>
    Math.hypot(x - map.bases[id].x, y - map.bases[id].y) < Math.hypot(x - map.bases[best].x, y - map.bases[best].y) ? id : best);
  const countsFor = id => {
    const counts = {};
    for (const n of map.nodes) {
      if (n.hidden || n.frontier) continue;   // caches/frontier are a shared bonus, not the per-base guarantee itself
      if (nearestOwner(n.x, n.y) === id) counts[n.com] = (counts[n.com] || 0) + 1;
    }
    return counts;
  };
  const base = countsFor(owners[0]);
  for (const id of owners.slice(1)) {
    assert.deepEqual(countsFor(id), base, `${id} must be assigned the exact same node counts as ${owners[0]}`);
  }
});

test("T-044: generateMap is deterministic for N >= 3 too: the same seed reproduces the same nodes and bases", () => {
  const owners = ownersN(5);
  const a = generateMap("glacius", lcg(42), { owners });
  const b = generateMap("glacius", lcg(42), { owners });
  assert.deepEqual(a.nodes, b.nodes);
  assert.deepEqual(a.bases, b.bases);
});

test("T-044: N >= 3 — asymmetric worlds are restricted to 2-seat matches: every owner reads the plain shared modifier", () => {
  const map = generateMap("oort", () => 0.5, { owners: ownersN(3) });
  assert.equal(map.modifiers.asym, undefined, "the asym block must not survive into an N>=3 map's own modifiers");
  const state = { map };
  assert.equal(sideMod(state, "player", "gatherMult", 1), 1, "no more per-owner override — everyone reads the shared/default value");
  assert.equal(sideMod(state, "rebels", "buildTimeMult", 1), 1);
  // The world's own SHARED (non-asym) modifiers still apply to everyone alike.
  const nodeAmountMap = generateMap("oort", () => 0.5, { owners: ownersN(3) });
  assert.equal(nodeAmountMap.modifiers.nodeAmountMult, 1.3, "the shared richness modifier still applies");
});

test("T-044: N >= 3 — no per-world terrain features (avoids favoring whichever 2 bases would land near a 2-way-mirrored spec)", () => {
  const map = generateMap("pyralis", () => 0.5, { owners: ownersN(4) });   // pyralis: a real terrain feature normally
  assert.ok(map.terrain.type.every(t => t === 0), "every cell must read as plain open ground");
});

test("T-044: N >= 3 — no two nodes overlap, same guarantee the 2-seat path already gets", () => {
  const map = generateMap("ferros", lcg(17), { owners: ownersN(5) });
  for (let i = 0; i < map.nodes.length; i++) {
    for (let j = i + 1; j < map.nodes.length; j++) {
      const a = map.nodes[i], b = map.nodes[j];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      assert.ok(dist >= 32 - 1e-6, `${a.com} node and ${b.com} node are only ${dist.toFixed(1)} apart`);
    }
  }
});

test("T-044: N >= 3 — sizeMult/resourceMult still scale the radial map the same way they scale the 2-seat one", () => {
  const owners = ownersN(3);
  const big = generateMap("ferros", lcg(4), { owners, sizeMult: 2 });
  assert.equal(big.width, MAP_WIDTH * 2);
  assert.equal(big.height, MAP_HEIGHT * 2);
  for (const n of big.nodes) assert.ok(n.x >= 0 && n.x <= big.width && n.y >= 0 && n.y <= big.height);

  const rare = generateMap("ferros", lcg(4), { owners, resourceMult: 0.5 });
  const normal = generateMap("ferros", lcg(4), { owners });
  const oreRare = rare.nodes.find(n => n.com === "ore" && !n.home);
  const oreNormal = normal.nodes.find(n => n.com === "ore" && !n.home);
  assert.ok(oreRare.amount < oreNormal.amount, "resourceMult must still scale radial-map deposits down");
});
