import { test } from "node:test";
import assert from "node:assert/strict";
import { createGalaxy, addPlanet, previewPlanet, jumpCapital, activeState, stepGalaxy, galaxyStatus,
         ODYSSEY_WORLDS, BACKGROUND_WORLDS, backgroundWorldIds, neighbourAiProfile } from "../engine/galaxy.js";
import { serializeGalaxy, deserializeGalaxy } from "../engine/persist.js";
import { DIFFICULTY_OPTIONS } from "../engine/aiDifficulty.js";
import { STRATEGIES } from "../engine/aiStrategy.js";
import { jumpReadyGalaxy, entitySnapshot } from "./_helpers.js";

// The background worlds of a fresh galaxy, in roster order — everything alive but the seat.
const backgroundOf = g => [...g.planets.keys()].filter(id => id !== g.activeId);

test("the living galaxy instantiates the seat plus a BOUNDED set of background worlds, and the player has reached only the seat", () => {
  const g = createGalaxy({ seed: 12 });
  assert.equal(g.planets.size, BACKGROUND_WORLDS + 1, "the start seat plus exactly BACKGROUND_WORLDS live neighbours");
  assert.ok(g.planets.has(g.activeId), "the seat is one of them");
  assert.equal(g.discovered.size, 1, "the player has reached only the start world");
  const st = galaxyStatus(g);
  assert.equal(st.visited, 1, "starmap shows one world visited");
  assert.equal(st.total, ODYSSEY_WORLDS.length, "…out of the WHOLE roster — a dormant world is still a destination");
  assert.equal(st.worlds.filter(w => w.status === "unexplored").length, ODYSSEY_WORLDS.length - 1, "the rest read unexplored");
  for (const w of st.worlds) if (w.status === "unexplored") assert.equal(w.stance, null, "an unexplored world hides its neighbour's stance");
});

/* ---------- WHICH worlds are alive: the seeded, pseudo-random background draw ---------- */

test("backgroundWorldIds draws BACKGROUND_WORLDS distinct real worlds, never the start seat", () => {
  for (const seed of [1, 2, 3, 7, 99, 12345]) {
    for (const startId of [ODYSSEY_WORLDS[0], ODYSSEY_WORLDS[4], ODYSSEY_WORLDS[ODYSSEY_WORLDS.length - 1]]) {
      const ids = backgroundWorldIds(seed, startId);
      assert.equal(ids.length, BACKGROUND_WORLDS, `seed ${seed} from ${startId}: exactly BACKGROUND_WORLDS worlds`);
      assert.equal(new Set(ids).size, ids.length, "no world is drawn twice");
      for (const id of ids) {
        assert.ok(ODYSSEY_WORLDS.includes(id), `${id} must be a real roster world`);
        assert.notEqual(id, startId, "the seat is never one of its own background worlds");
      }
    }
  }
});

test("the background draw is deterministic — same seed, same three worlds, in roster order", () => {
  assert.deepEqual(backgroundWorldIds(4242, "ferros"), backgroundWorldIds(4242, "ferros"), "pure function of (seed, startId)");
  const a = createGalaxy({ seed: 808 }), b = createGalaxy({ seed: 808 });
  assert.deepEqual([...a.planets.keys()], [...b.planets.keys()], "two same-seed galaxies bring up the same worlds");
  const drawn = backgroundWorldIds(808, a.activeId);
  assert.deepEqual(drawn, ODYSSEY_WORLDS.filter(id => drawn.includes(id)), "returned in fixed roster order, not draw order");
  assert.deepEqual(backgroundOf(a), drawn, "…and that's exactly what createGalaxy brought up");
});

test("the background draw VARIES with the seed — not a fixed prefix of the roster, and every world can come up", () => {
  const sets = new Set();
  for (let seed = 1; seed <= 40; seed++) sets.add(backgroundWorldIds(seed, "ferros").join(","));
  assert.ok(sets.size > 1, `expected the live set to differ across seeds, saw only ${[...sets]}`);
  const seen = new Set();
  for (let seed = 1; seed <= 300; seed++) for (const id of backgroundWorldIds(seed, "ferros")) seen.add(id);
  assert.equal(seen.size, ODYSSEY_WORLDS.length - 1, "over enough seeds every non-seat world is reachable by the draw");
});

test("choosing the start world doesn't perturb the draw's own stream — the same seed picks from the same roll", () => {
  // The draw is keyed on (seed, startId), so it must resolve identically for a galaxy that
  // reached that seat by chance and one told to land there — the same guarantee createGalaxy's
  // always-drawn start pick already makes for every other seeded stream.
  const base = createGalaxy({ seed: 21 });
  const explicit = createGalaxy({ seed: 21, startId: base.activeId });
  assert.deepEqual(backgroundOf(explicit), backgroundOf(base));
});

test("a world nobody drew stays dormant — still on the roster, brought to life on arrival", () => {
  const g = jumpReadyGalaxy(31);
  const dormant = ODYSSEY_WORLDS.find(id => !g.planets.has(id));
  assert.ok(dormant, "a bounded draw leaves worlds dormant");
  assert.ok(g.worlds.includes(dormant), "…but a dormant world is still on the starmap roster");
  assert.ok(jumpCapital(g, dormant), "and the player can jump there");
  assert.equal(g.activeId, dormant, "it becomes the active seat");
  assert.equal(g.planets.get(dormant).background, false, "…instantiated as the live world, not a background one");
  assert.ok(g.planets.get(dormant).players.ai, "with its own neighbour waiting, exactly as a drawn world would have");
});

test("previewPlanet shows a dormant world without waking it, and matches what arriving there really builds", () => {
  // The contract the landing picker (boot.js initiateJump) and Observer Mode both lean on: a
  // dormant world can be LOOKED at — its map, its neighbour — with no entry added to the live
  // set, and what the player was shown is exactly what they land on.
  const g = createGalaxy({ seed: 77 });
  const dormant = ODYSSEY_WORLDS.find(id => !g.planets.has(id));
  const before = g.planets.size;

  const preview = previewPlanet(g, dormant);
  assert.equal(preview.planetId, dormant, "the preview really is that world");
  assert.equal(g.planets.size, before, "…and previewing it registered nothing");
  assert.ok(!g.planets.has(dormant), "the world is still dormant");

  const real = addPlanet(g, dormant, { unsettled: true });
  assert.equal(entitySnapshot(real), entitySnapshot(preview), "the arrival state is byte-identical to the preview");
  assert.deepEqual(real.map.nodes, preview.map.nodes, "…including the map the picker drew");

  assert.equal(previewPlanet(g, dormant), real, "once a world IS live, its preview is that live state itself");
});

test("a dormant world claimed by a spreading faction flies those colours once it's instantiated", () => {
  // checkExpansion's claims sweep runs over the WHOLE roster, so a faction's sphere of influence
  // can reach a world that isn't simulating yet. Arriving there must show the flag the starmap
  // has been flying, not the world's native archetype faction.
  const g = createGalaxy({ seed: 44 });
  const dormant = ODYSSEY_WORLDS.find(id => !g.planets.has(id));
  g.claims.set(dormant, "syndicate");
  const s = addPlanet(g, dormant, { unsettled: true });
  assert.equal(s.players.ai.faction, "syndicate", "the arriving world flies the claiming faction's colours");
});

test("background AI factions develop on their own worlds over time (the galaxy is alive unseen)", () => {
  const g = createGalaxy({ seed: 8 });
  const other = backgroundOf(g)[0];
  const s = g.planets.get(other);
  assert.ok(s.background, "a non-seat world runs in the background");
  assert.equal([...s.buildings.values()].filter(b => b.owner === "ai").length, 0, "it starts with just a colony ship — no buildings");
  for (let i = 0; i < 4000; i++) stepGalaxy(g, 0.05);   // ~200s of galaxy time
  const aiBuildings = [...s.buildings.values()].filter(b => b.owner === "ai");
  assert.ok(aiBuildings.length > 0, `the neighbour built up its base unseen (${aiBuildings.length} buildings)`);
  assert.ok(aiBuildings.some(b => b.type === "command"), "its faction founded a Command Center from the colony ship");
});

test("the reached-world set survives a save/load", () => {
  const g = createGalaxy({ seed: 5 });
  g.discovered.add(ODYSSEY_WORLDS.find(id => id !== g.activeId));   // the player has reached a second world
  const g2 = deserializeGalaxy(JSON.parse(JSON.stringify(serializeGalaxy(g))));
  assert.equal(g2.discovered.size, 2, "discovered round-trips");
  assert.ok(g2.discovered.has(g.activeId), "…including the seat");
});

/* ============================================================
   VARIED NEIGHBOUR DIFFICULTY/PERSONALITY. The player's Difficulty and AI Strategy
   picks at setup are a single splash-screen choice — but they must only describe
   the world the player actually lands on. Every OTHER world in the living galaxy
   carries its OWN difficulty and personality (strategy), some easier, some
   harder, independent of what the player picked — so the galaxy is worth
   exploring, and the player has to learn each neighbour's temperament by playing
   it, not read it off a settings screen. Written from the requirement, ahead of
   the implementation (neighbourAiProfile doesn't exist yet as of this test file).
   ============================================================ */

const VALID_DIFFICULTIES = DIFFICULTY_OPTIONS.map(o => o.mult);
const VALID_STRATEGIES = Object.keys(STRATEGIES);

/* ---------- neighbourAiProfile(seed, planetId): the pure per-world pick ---------- */

test("neighbourAiProfile is deterministic — the same seed and planet always resolve the same profile", () => {
  const a = neighbourAiProfile(999, "korrath");
  const b = neighbourAiProfile(999, "korrath");
  assert.deepEqual(a, b);
});

test("neighbourAiProfile always returns a real difficulty key, with aiApm/aiMicro matching THAT difficulty's own dials", () => {
  for (const planetId of ODYSSEY_WORLDS) {
    const p = neighbourAiProfile(4242, planetId);
    assert.ok(VALID_DIFFICULTIES.includes(p.difficulty), `${planetId}: "${p.difficulty}" must be a real difficulty key`);
    const matching = DIFFICULTY_OPTIONS.find(o => o.mult === p.difficulty);
    assert.equal(p.aiApm, matching.aiApm, `${planetId}: aiApm must belong to the SAME difficulty entry as p.difficulty`);
    assert.equal(p.aiMicro, matching.aiMicro, `${planetId}: aiMicro must belong to the SAME difficulty entry as p.difficulty`);
  }
});

test("neighbourAiProfile always returns a real AI Strategy key", () => {
  for (const planetId of ODYSSEY_WORLDS) {
    const p = neighbourAiProfile(1234, planetId);
    assert.ok(VALID_STRATEGIES.includes(p.aiStrategy), `${planetId}: "${p.aiStrategy}" must be a real STRATEGIES key`);
  }
});

test("neighbourAiProfile produces real variety across the roster — some easier, some harder, not one constant pick", () => {
  const difficulties = new Set(), strategies = new Set();
  for (const planetId of ODYSSEY_WORLDS) {
    const p = neighbourAiProfile(2026, planetId);
    difficulties.add(p.difficulty);
    strategies.add(p.aiStrategy);
  }
  assert.ok(difficulties.size > 1, `expected more than one difficulty across ${ODYSSEY_WORLDS.length} worlds, saw only ${[...difficulties]}`);
  assert.ok(strategies.size > 1, `expected more than one AI Strategy across ${ODYSSEY_WORLDS.length} worlds, saw only ${[...strategies]}`);
});

/* ---------- createGalaxy/addPlanet: only the start world hears the player's pick ---------- */

test("the start world's AI runs at exactly the player's picked difficulty and strategy", () => {
  const g = createGalaxy({ seed: 77, difficulty: "hard", aiApm: 140, aiMicro: true, aiStrategy: "aggressive" });
  const start = g.planets.get(g.activeId);
  assert.equal(start.ai.difficulty, "hard");
  assert.equal(start.ai.apm, 140);
  assert.equal(start.ai.micro, true);
  assert.equal(start.ai.strategy, "aggressive");
});

test("neighbour worlds are NOT forced onto the player's picked difficulty/strategy — each resolves its own profile", () => {
  const g = createGalaxy({ seed: 77, difficulty: "hard", aiApm: 140, aiMicro: true, aiStrategy: "aggressive" });
  const neighbours = backgroundOf(g).map(id => g.planets.get(id));
  assert.equal(neighbours.length, BACKGROUND_WORLDS);

  // Asserted per world against neighbourAiProfile rather than by counting distinct values across
  // the live set: only BACKGROUND_WORLDS worlds are up, so a legitimate draw can hand three worlds
  // the same difficulty. Roster-wide VARIETY is covered by its own test above, on the pure pick.
  for (const s of neighbours) {
    const profile = neighbourAiProfile(g.seed, s.planetId);
    assert.equal(s.ai.difficulty, profile.difficulty, `${s.planetId}: runs its OWN difficulty, not the player's`);
    assert.equal(s.ai.strategy, profile.aiStrategy, `${s.planetId}: runs its OWN strategy, not the player's`);
  }

  for (const s of neighbours) {
    // Every neighbour's apm/micro must belong to ITS OWN difficulty, never a stale mix of
    // "this world's difficulty key" + "the player's own apm/micro dials".
    const matching = DIFFICULTY_OPTIONS.find(o => o.mult === s.ai.difficulty);
    assert.equal(s.ai.apm, matching.aiApm, `${s.planetId}: apm must match its own difficulty, not the player's`);
    assert.equal(s.ai.micro, matching.aiMicro, `${s.planetId}: micro must match its own difficulty, not the player's`);
  }
});

test("neighbour difficulty/strategy assignment is fully deterministic — same galaxy seed, same roster-wide result", () => {
  const mk = () => createGalaxy({ seed: 555, difficulty: "medium", aiStrategy: "default" });
  const g1 = mk(), g2 = mk();
  assert.deepEqual([...g1.planets.keys()], [...g2.planets.keys()], "the same worlds come up at all");
  for (const id of g1.planets.keys()) {
    const a = g1.planets.get(id).ai, b = g2.planets.get(id).ai;
    assert.equal(a.difficulty, b.difficulty, `${id}: difficulty must replay identically`);
    assert.equal(a.strategy, b.strategy, `${id}: strategy must replay identically`);
    assert.equal(a.apm, b.apm, `${id}: apm must replay identically`);
    assert.equal(a.micro, b.micro, `${id}: micro must replay identically`);
  }
});

test("a world's varied difficulty/strategy survives a save/load like every other per-planet AI field", () => {
  const g = createGalaxy({ seed: 321, difficulty: "easy", aiStrategy: "economic" });
  const other = backgroundOf(g)[0];
  const before = g.planets.get(other).ai;
  const g2 = deserializeGalaxy(JSON.parse(JSON.stringify(serializeGalaxy(g))));
  const after = g2.planets.get(other).ai;
  assert.equal(after.difficulty, before.difficulty);
  assert.equal(after.strategy, before.strategy);
});

test("galaxyStatus never exposes a world's AI difficulty or personality, discovered or not — the player learns it only by playing", () => {
  const g = createGalaxy({ seed: 9, difficulty: "hard", aiStrategy: "aggressive" });
  const secondWorld = ODYSSEY_WORLDS.find(id => id !== g.activeId);
  g.discovered.add(secondWorld);   // even once "discovered", the starmap summary must stay silent on this
  const st = galaxyStatus(g);
  for (const w of st.worlds) {
    assert.equal(w.difficulty, undefined, `${w.id}: galaxyStatus must never surface a raw difficulty field`);
    assert.equal(w.aiStrategy, undefined, `${w.id}: galaxyStatus must never surface a raw strategy field`);
  }
});
