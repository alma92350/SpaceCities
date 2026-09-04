/* ============================================================
   Guards for engine/aiIntel.js — what the AI BELIEVES about its opponent.

   This is the first AI state that can be WRONG (every other read is a fact about the current
   frame), so the properties that matter are not "is the number right" but "is the number honest":

     1. FOG-LIMITED. An unscouted army must not exist as far as the belief is concerned. An
        omniscient read here would be both a cheat and — worse — would delete the scouting
        counter-play the whole design rests on.
     2. "I HAVE SEEN NOTHING" ≠ "I HAVE SEEN AN EMPTY BASE". posture stays null until something is
        actually sighted, and confidence is what separates the two. Collapsing them is how an AI
        ends up confidently raiding into an army it never scouted.
     3. A HIGH-WATER MARK THAT FADES. Only a sighting raises it, only time lowers it — so an army
        stepping out of vision does not erase itself, but five-minute-old intel does decay.
     4. OWNER-PARAMETRIC. Both seats read their own fog and their own enemy. A stray "ai" literal is
        exactly how the two self-play bugs in docs/odyssey-ai-review.md happened.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sightEnemy, updateIntel, readEnemy, enemyIsGreedy, isMilitaryBuilding, INTEL_FADE, INTEL_FULL,
} from "../engine/aiIntel.js";
import { BUILDINGS, UNITS } from "../engine/entities.js";
import { createGameState, createAiController } from "../engine/state.js";
import { FOG_CELL_SIZE } from "../engine/fog.js";
import { advanceThinkCycles } from "./_helpers.js";

const world = () => {
  const s = createGameState({ planetId: "ferros", seed: 1 });
  // Clear the map so each test states its own situation exactly.
  for (const [id] of [...s.units]) s.units.delete(id);
  for (const [id] of [...s.buildings]) s.buildings.delete(id);
  return s;
};

let nextId = 0;
const addUnit = (s, owner, type, x, y) => {
  const u = { id: `u${nextId++}`, owner, type, x, y, hp: UNITS[type].hp, order: null };
  s.units.set(u.id, u);
  return u;
};
const addBuilding = (s, owner, type, x, y) => {
  const b = { id: `b${nextId++}`, owner, type, x, y, hp: BUILDINGS[type].hp, constructing: false, queue: [] };
  s.buildings.set(b.id, b);
  return b;
};
// Light the fog directly rather than driving updateFog off a scout's sight radius: these tests are
// about what the belief does with a sighting, not about how sight is computed, and stating "the AI
// can see this spot" outright keeps each case readable. Mirrors engine/fog.js's own cell math.
const see = (s, owner, x, y, radius = 400) => {
  const fog = s.fogs[owner];
  const r = Math.ceil(radius / FOG_CELL_SIZE);
  const cx = Math.floor(x / FOG_CELL_SIZE), cy = Math.floor(y / FOG_CELL_SIZE);
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) {
      const gx = cx + dx, gy = cy + dy;
      if (gx < 0 || gy < 0 || gx >= fog.cols || gy >= fog.rows) continue;
      fog.visible[gy * fog.cols + gx] = 1;
      fog.explored[gy * fog.cols + gx] = 1;
    }
};

/* ---------- classification ---------- */

test("military buildings are identified from the DEFINITION, not a hardcoded list", () => {
  // Anything that shoots, projects a defensive aura, or produces a combat unit.
  assert.equal(isMilitaryBuilding(BUILDINGS.turret), true, "a turret shoots");
  assert.equal(isMilitaryBuilding(BUILDINGS.bastille), true, "a bastille shoots");
  assert.equal(isMilitaryBuilding(BUILDINGS.barracks), true, "a barracks produces combat units");
  assert.equal(isMilitaryBuilding(BUILDINGS.refinery), false);
  assert.equal(isMilitaryBuilding(BUILDINGS.habitat), false);
  // A Command Center produces only workers and support, so it reads as economy — it is what a
  // greedy player is PROTECTING, not what they are threatening you with.
  assert.equal(isMilitaryBuilding(BUILDINGS.command), false, "a Command Center is economy");
  assert.equal(isMilitaryBuilding(undefined), false, "an unknown def must not throw");
});

test("every shipped building classifies without throwing", () => {
  for (const [id, def] of Object.entries(BUILDINGS))
    assert.equal(typeof isMilitaryBuilding(def), "boolean", `${id} did not classify`);
});

/* ---------- fog limits ---------- */

test("an unscouted army does not exist as far as the belief is concerned", () => {
  const s = world();
  addUnit(s, "player", "skiff", 2000, 2000);
  addUnit(s, "player", "skiff", 2010, 2000);
  assert.deepEqual(sightEnemy(s, "ai"), { mil: 0, eco: 0 }, "unseen enemies must not be counted");
  updateIntel(s, "ai");
  const r = readEnemy(s, "ai");
  assert.equal(r.posture, null, "never having seen anything must read as 'I do not know'");
  assert.equal(r.confidence, 0);
});

test("what it can see, it counts — split into military and economy", () => {
  const s = world();
  addUnit(s, "player", "skiff", 100, 100);          // combat
  addUnit(s, "player", "worker", 120, 100);         // economy
  addBuilding(s, "player", "turret", 140, 100);     // military
  addBuilding(s, "player", "refinery", 160, 100);   // economy
  see(s, "ai", 130, 100);
  const live = sightEnemy(s, "ai");
  const val = c => Object.values(c || {}).reduce((a, v) => a + v, 0);
  assert.equal(live.mil, val(UNITS.skiff.cost) + val(BUILDINGS.turret.cost));
  assert.equal(live.eco, val(UNITS.worker.cost) + val(BUILDINGS.refinery.cost));
});

test("it never counts its OWN units as the enemy's", () => {
  const s = world();
  addUnit(s, "ai", "skiff", 100, 100);
  addBuilding(s, "ai", "turret", 120, 100);
  see(s, "ai", 110, 100);
  assert.deepEqual(sightEnemy(s, "ai"), { mil: 0, eco: 0 });
});

/* ---------- "seen nothing" vs "seen an empty base" ---------- */

test("an empty base that HAS been looked at is not the same as never having looked", () => {
  const s = world();
  addBuilding(s, "player", "refinery", 100, 100);
  see(s, "ai", 100, 100);
  updateIntel(s, "ai");
  const r = readEnemy(s, "ai");
  assert.equal(r.posture, 0, "all economy, no military => a pure economy read");
  assert.ok(r.confidence > 0, "having actually seen something must produce non-zero confidence");
  // …and the never-looked case above reads posture null with confidence 0. The two are distinct,
  // which is the entire reason confidence exists as a separate number.
});

test("confidence needs BOTH enough seen and recently seen", () => {
  const s = world();
  addBuilding(s, "player", "refinery", 100, 100);
  see(s, "ai", 100, 100);
  s.time = 0;
  updateIntel(s, "ai");
  const fresh = readEnemy(s, "ai").confidence;

  // Same sighting, gone stale: the belief survives but confidence in it does not.
  s.time = INTEL_FADE / 2;
  const half = readEnemy(s, "ai").confidence;
  assert.ok(half < fresh && half > 0, `staleness must erode confidence (${fresh} -> ${half})`);
  s.time = INTEL_FADE + 1;
  assert.equal(readEnemy(s, "ai").confidence, 0, "intel older than the fade window is worth nothing");
});

test("confidence saturates on how much has been seen, not on a single glimpse", () => {
  const s = world();
  addUnit(s, "player", "worker", 100, 100);
  see(s, "ai", 100, 100);
  updateIntel(s, "ai");
  const oneWorker = readEnemy(s, "ai").confidence;
  assert.ok(oneWorker < 0.5, `one worker must not make the AI confident (got ${oneWorker})`);
  // A whole base's worth does.
  for (let i = 0; i < 12; i++) addBuilding(s, "player", "refinery", 100 + i, 100);
  updateIntel(s, "ai");
  assert.ok(readEnemy(s, "ai").confidence > oneWorker, "seeing more must raise confidence");
});

/* ---------- the high-water mark ---------- */

test("an army that walks out of vision is remembered, not forgotten", () => {
  const s = world();
  const skiffs = [addUnit(s, "player", "skiff", 100, 100), addUnit(s, "player", "skiff", 110, 100)];
  see(s, "ai", 105, 100);
  s.time = 10;
  updateIntel(s, "ai");
  const seenMil = readEnemy(s, "ai").mil;
  assert.ok(seenMil > 0);

  // They leave. A live-only read would collapse to zero here — which is exactly the failure mode
  // this module exists to avoid, since it would make the AI forget an army the moment it blinked.
  for (const u of skiffs) { u.x = 3000; u.y = 3000; }
  s.time = 20;
  updateIntel(s, "ai");
  assert.ok(readEnemy(s, "ai").mil > 0, "the belief must survive losing sight of the army");
});

test("only a sighting raises the estimate; only time lowers it", () => {
  const s = world();
  addUnit(s, "player", "skiff", 100, 100);
  see(s, "ai", 100, 100);
  s.time = 0;
  updateIntel(s, "ai");
  const first = readEnemy(s, "ai").mil;

  // Seeing MORE raises it.
  addUnit(s, "player", "skiff", 105, 100);
  updateIntel(s, "ai");
  const grown = readEnemy(s, "ai").mil;
  assert.ok(grown > first, "a bigger sighting must raise the belief");

  // Time with nothing in sight lowers it, and eventually to nothing.
  for (const u of [...s.units.values()]) if (u.owner === "player") { u.x = 4000; u.y = 4000; }
  s.time = INTEL_FADE * 0.5;
  updateIntel(s, "ai");
  const faded = readEnemy(s, "ai").mil;
  assert.ok(faded > 0 && faded < grown, `time must fade the belief (${grown} -> ${faded})`);
  s.time = INTEL_FADE * 3;
  updateIntel(s, "ai");
  assert.equal(readEnemy(s, "ai").mil, 0, "a long-unrefreshed belief must fade to nothing");
});

/* ---------- the SHAPE of the fade, not just its direction ----------

   The three tests above step `s.time` in ONE hop and call updateIntel ONCE per hop. That is not
   how engine/ai.js drives this module: runAI calls updateIntel every THINK_INTERVAL (1.5 sim
   seconds), so between two sightings it runs dozens of times. A fade that is correct for one call
   and wrong for many passes every assertion above, because they only ever check a DIRECTION
   ("faded > 0 && faded < grown") — and any decay curve at all satisfies that, including one two
   hundred times too steep.

   That is exactly the bug these three tests were written for: updateIntel used to write its faded
   value back and then re-fade it from the same timestamp next cycle, so the decay compounded once
   per think cycle and the documented four-minute fade really emptied in about sixty seconds. So
   these drive it at the production cadence and assert the NUMBER the docs promise.        */

// Run `seconds` of sim forward the way the game does: many think cycles, not one jump. The cadence
// comes from engine/ai.js's own exported THINK_INTERVAL via test/_helpers.js, deliberately not a
// local copy — a test whose idea of the think rate can drift from the engine's is how this class
// of bug hides in the first place.
const think = (s, seconds, owner = "ai") =>
  advanceThinkCycles(s, seconds, st => updateIntel(st, owner));

test("the belief fades LINEARLY over INTEL_FADE when driven at the real think cadence", () => {
  const s = world();
  const skiffs = [addUnit(s, "player", "skiff", 100, 100), addUnit(s, "player", "skiff", 110, 100)];
  see(s, "ai", 105, 100);
  s.time = 0;
  updateIntel(s, "ai");
  const peak = readEnemy(s, "ai").mil;
  assert.ok(peak > 0, "fixture sanity: the army was actually seen");

  // They leave, and are never seen again. Every checkpoint is a fraction of the documented window.
  for (const u of skiffs) { u.x = 4000; u.y = 4000; }
  for (const [elapsed, expectedShare] of [[0.25, 0.75], [0.25, 0.5], [0.25, 0.25]]) {
    think(s, INTEL_FADE * elapsed);
    const got = readEnemy(s, "ai").mil;
    const want = peak * expectedShare;
    assert.ok(Math.abs(got - want) < peak * 0.02,
      `at ${Math.round(s.time)}s of a ${INTEL_FADE}s fade the belief should be ~${want.toFixed(1)} ` +
      `(${expectedShare * 100}% of ${peak.toFixed(1)}), got ${got.toFixed(4)}`);
  }
});

test("the fade depends on ELAPSED TIME, not on how many think cycles ran in it", () => {
  // The property the bug violated. Two identical worlds, the same sim seconds, different cadences:
  // a coarse one and a fine one. A per-cycle decay makes the fine-grained run fade far further; a
  // time-based one lands both on the same number.
  const run = (cadence) => {
    const s = world();
    const skiff = addUnit(s, "player", "skiff", 100, 100);
    see(s, "ai", 100, 100);
    s.time = 0;
    updateIntel(s, "ai");
    skiff.x = 4000; skiff.y = 4000;
    const until = INTEL_FADE * 0.5;
    while (s.time < until) { s.time = Math.min(until, s.time + cadence); updateIntel(s, "ai"); }
    return readEnemy(s, "ai").mil;
  };
  const coarse = run(30), fine = run(0.25);
  assert.ok(Math.abs(coarse - fine) < 0.01,
    `the same ${INTEL_FADE * 0.5}s must fade the belief identically at any cadence ` +
    `(30s steps -> ${coarse.toFixed(4)}, 0.25s steps -> ${fine.toFixed(4)})`);
});

test("a worker still in sight does not freeze the belief about an army that left", () => {
  // The other half of the property, and the one a single shared "last seen anything" timestamp
  // gets wrong: economy and military decay on their OWN clocks. A worker line parked in view is a
  // genuine refresh of what the AI knows about the ECONOMY, and says nothing whatsoever about the
  // army that walked off — so it must not hold the military estimate up.
  const s = world();
  const skiff = addUnit(s, "player", "skiff", 100, 100);
  addUnit(s, "player", "worker", 120, 100);
  see(s, "ai", 110, 100);
  s.time = 0;
  updateIntel(s, "ai");
  const peakMil = readEnemy(s, "ai").mil;
  assert.ok(peakMil > 0 && readEnemy(s, "ai").eco > 0, "fixture sanity: both channels were seen");

  skiff.x = 4000; skiff.y = 4000;          // the army leaves; the worker stays in view
  think(s, INTEL_FADE * 0.5);
  const r = readEnemy(s, "ai");
  assert.ok(Math.abs(r.mil - peakMil * 0.5) < peakMil * 0.02,
    `the military belief must keep fading on its own clock (~${(peakMil * 0.5).toFixed(1)}), got ${r.mil.toFixed(4)}`);
  assert.ok(r.eco > 0, "the economy belief stays fresh — that worker really is still there");
});

/* ---------- posture ---------- */

test("posture reads 0 for a pure economy game and 1 for a pure war game", () => {
  const eco = world();
  for (let i = 0; i < 4; i++) addUnit(eco, "player", "worker", 100 + i * 5, 100);
  addBuilding(eco, "player", "refinery", 130, 100);
  see(eco, "ai", 110, 100);
  updateIntel(eco, "ai");
  assert.equal(readEnemy(eco, "ai").posture, 0);

  const war = world();
  for (let i = 0; i < 4; i++) addUnit(war, "player", "skiff", 100 + i * 5, 100);
  addBuilding(war, "player", "turret", 130, 100);
  see(war, "ai", 110, 100);
  updateIntel(war, "ai");
  assert.equal(readEnemy(war, "ai").posture, 1);
});

test("a mixed opponent reads between the two", () => {
  const s = world();
  addUnit(s, "player", "skiff", 100, 100);
  addUnit(s, "player", "worker", 110, 100);
  see(s, "ai", 105, 100);
  updateIntel(s, "ai");
  const p = readEnemy(s, "ai").posture;
  assert.ok(p > 0 && p < 1, `a mixed game must read between the extremes (got ${p})`);
});

/* ---------- the greed predicate ---------- */

test("enemyIsGreedy needs BOTH a low posture and enough confidence", () => {
  const s = world();
  // A single worker: greedy-looking, but far too little seen to act on.
  addUnit(s, "player", "worker", 100, 100);
  see(s, "ai", 100, 100);
  updateIntel(s, "ai");
  assert.equal(enemyIsGreedy(s, "ai"), false, "one worker is not grounds to commit a raid");

  // A whole economy, clearly seen.
  for (let i = 0; i < 10; i++) addBuilding(s, "player", "refinery", 100 + i * 2, 100);
  updateIntel(s, "ai");
  assert.equal(enemyIsGreedy(s, "ai"), true, "a scouted, undefended economy is exactly the target");

  // …and an army alongside it is not greed any more.
  for (let i = 0; i < 30; i++) addUnit(s, "player", "skiff", 100 + i, 105);
  updateIntel(s, "ai");
  assert.equal(enemyIsGreedy(s, "ai"), false, "an enemy with a real army must not read as greedy");
});

test("never having scouted must never read as greedy — hedge, do not assume weakness", () => {
  const s = world();
  for (let i = 0; i < 20; i++) addBuilding(s, "player", "refinery", 2000 + i, 2000);   // unseen
  updateIntel(s, "ai");
  assert.equal(enemyIsGreedy(s, "ai"), false,
    "an unscouted enemy must not be treated as undefended — that is how an AI walks into an army");
});

/* ---------- owner-parametric ---------- */

test("both seats read their OWN fog and their OWN enemy", () => {
  const s = world();
  s.playerAi = createAiController("ferros", {});
  addUnit(s, "player", "skiff", 100, 100);      // the "ai" seat's enemy
  addUnit(s, "ai", "worker", 900, 900);         // the "player" seat's enemy
  see(s, "ai", 100, 100);                       // only the ai seat can see the skiff
  see(s, "player", 900, 900);                   // only the player seat can see the worker

  updateIntel(s, "ai");
  updateIntel(s, "player");
  const ai = readEnemy(s, "ai"), pl = readEnemy(s, "player");
  assert.equal(ai.posture, 1, "the ai seat sees only an enemy skiff => pure war");
  assert.equal(pl.posture, 0, "the player seat sees only an enemy worker => pure economy");
  // Each belief lives on its own controller — no shared object, no leak.
  assert.ok(s.ai.intelMil > 0 && s.ai.intelEco === 0);
  assert.ok(s.playerAi.intelEco > 0 && s.playerAi.intelMil === 0);
});

test("driving a 'player' seat with no controller configured is a silent no-op", () => {
  const s = world();
  assert.doesNotThrow(() => updateIntel(s, "player"));
  assert.deepEqual(readEnemy(s, "player"), { posture: null, confidence: 0, mil: 0, eco: 0, age: null });
});

/* ---------- determinism ---------- */

test("the read is a pure function of state — same state, same answer", () => {
  const build = () => {
    const s = world();
    addUnit(s, "player", "skiff", 100, 100);
    addBuilding(s, "player", "refinery", 120, 100);
    see(s, "ai", 110, 100);
    s.time = 42;
    updateIntel(s, "ai");
    return JSON.stringify(readEnemy(s, "ai"));
  };
  assert.equal(build(), build());
});

/* ============================================================
   PHASE 2 — the raid is a RESPONSE, not a metronome
   (engine/aiMilitary.js aiOffense, docs/ai-adaptive-opponent.md)

   The behaviour these pin: an enemy that can be SEEN to be undefended should not be safe. That is
   the structural answer to docs/ai-evolution-design.md §9's finding — a champion that won by
   hoarding an army it never committed, which only works because nobody could see it was
   undefended.
   ============================================================ */

import { adaptivityFor, DIFFICULTY_OPTIONS } from "../engine/aiDifficulty.js";

test("adaptivity is a difficulty dial: Easy never adapts, Hard adapts hardest", () => {
  const at = mult => adaptivityFor({ controllers: { ai: { difficulty: mult } } }, "ai");
  assert.equal(at("easy"), 0,
    "Easy must never act on the read — its play stays learnable and exploitable, same argument as counterEvery: 0");
  assert.equal(at("medium"), 1, "Medium carries no value, so it composes as ordinary adaptation");
  assert.ok(at("hard") > 1, "Hard reacts harder and on thinner evidence");
  // An unknown/legacy difficulty key must compose as ordinary behaviour, never as a silent opt-out.
  assert.equal(at("nonsense-key"), 1);
  assert.equal(adaptivityFor({}, "ai"), 1, "a state with no controller must not throw");
});

test("Medium carries no adaptivity field at all — the baseline stays byte-identical to unset", () => {
  const medium = DIFFICULTY_OPTIONS.find(o => o.mult === "medium");
  assert.ok(!("adaptivity" in medium),
    "Medium is the baseline every dial is relative to; giving it an explicit value breaks that convention");
});

test("Hard commits on thinner evidence than Medium, and Easy on none", () => {
  // The confidence bar is 0.25 / adaptivity, so a partial scout that convinces Hard need not
  // convince Medium — and nothing convinces Easy.
  const s = world();
  s.time = 0;
  // A partial scout: 1 worker + 2 habitats = 200 ore of 900, i.e. confidence 0.222 — deliberately
  // BETWEEN Hard's bar (0.25/1.5 = 0.167) and Medium's (0.25). If this fixture ever drifts out of
  // that band the assertion below stops testing anything, so the band is asserted first.
  addUnit(s, "player", "worker", 100, 100);
  addBuilding(s, "player", "habitat", 104, 100);
  addBuilding(s, "player", "habitat", 108, 100);
  see(s, "ai", 105, 100);
  updateIntel(s, "ai");
  const conf = readEnemy(s, "ai").confidence;
  assert.ok(conf > 0.25 / 1.5 && conf < 0.25,
    `this fixture must sit BETWEEN the two bars to be a real test (confidence ${conf})`);
  assert.equal(enemyIsGreedy(s, "ai", { minConfidence: 0.25 / 1.5 }), true, "Hard's bar is cleared");
  assert.equal(enemyIsGreedy(s, "ai", { minConfidence: 0.25 / 1 }), false, "Medium's is not");
});

/* ============================================================
   PHASE 3 — the damped stance
   ============================================================ */

import { updateAdaptMode, adaptDefenceMult, ADAPT_NEUTRAL, ADAPT_DEAD_BAND, ADAPT_RATE } from "../engine/aiIntel.js";

test("an unscouted enemy cannot move the stance — it hedges at neutral", () => {
  const s = world();
  for (let i = 0; i < 30; i++) addUnit(s, "player", "skiff", 2000 + i, 2000);   // massing, unseen
  updateIntel(s, "ai");
  assert.equal(updateAdaptMode(s, "ai", 1), ADAPT_NEUTRAL,
    "never having looked must never produce a stance — hedge and scout, do not commit");
  assert.equal(adaptDefenceMult(s, "ai"), 1, "and neutral must compose as a no-op");
});

test("Easy is pinned at neutral forever, so it stays a fixed learnable opponent", () => {
  const s = world();
  for (let i = 0; i < 40; i++) addUnit(s, "player", "skiff", 100 + i, 100);
  see(s, "ai", 120, 100);
  updateIntel(s, "ai");
  for (let i = 0; i < 200; i++) updateAdaptMode(s, "ai", 0);
  assert.equal(s.ai.adaptMode, ADAPT_NEUTRAL, "adaptivity 0 must never leave neutral");
  assert.equal(adaptDefenceMult(s, "ai"), 1);
});

test("the stance moves toward a massing enemy, and never faster than the rate limit", () => {
  const s = world();
  for (let i = 0; i < 40; i++) addUnit(s, "player", "skiff", 100 + i * 2, 100);
  addBuilding(s, "player", "turret", 200, 100);
  see(s, "ai", 140, 100);
  updateIntel(s, "ai");
  let prev = ADAPT_NEUTRAL;
  for (let i = 0; i < 40; i++) {
    const next = updateAdaptMode(s, "ai", 1);
    assert.ok(next - prev <= ADAPT_RATE + 1e-9, `moved ${next - prev} in one cycle, faster than the rate limit`);
    prev = next;
  }
  assert.ok(prev > ADAPT_NEUTRAL, "a scouted, massing enemy must eventually pull the stance toward war");
  assert.ok(adaptDefenceMult(s, "ai") > 1, "…and that must mean more static defence");
});

test("the stance moves the other way against a visibly greedy opponent", () => {
  const s = world();
  for (let i = 0; i < 8; i++) addBuilding(s, "player", "refinery", 100 + i * 3, 100);
  see(s, "ai", 110, 100);
  updateIntel(s, "ai");
  for (let i = 0; i < 40; i++) updateAdaptMode(s, "ai", 1);
  assert.ok(s.ai.adaptMode < ADAPT_NEUTRAL, "a pure economy opponent must pull the stance toward economy");
  assert.ok(adaptDefenceMult(s, "ai") < 1, "…and that must mean fewer turrets, not more");
});

test("the dead band stops a small read from moving the stance at all", () => {
  const s = world();
  // A read close enough to neutral that acting on it would be noise-chasing.
  addUnit(s, "player", "skiff", 100, 100);
  addUnit(s, "player", "worker", 104, 100);
  see(s, "ai", 102, 100);
  updateIntel(s, "ai");
  const r = readEnemy(s, "ai");
  const target = ADAPT_NEUTRAL + (r.posture - ADAPT_NEUTRAL) * r.confidence;
  assert.ok(Math.abs(target - ADAPT_NEUTRAL) <= ADAPT_DEAD_BAND,
    `fixture must sit INSIDE the dead band to test it (target ${target})`);
  for (let i = 0; i < 50; i++) updateAdaptMode(s, "ai", 1);
  assert.equal(s.ai.adaptMode, ADAPT_NEUTRAL, "inside the dead band the stance must not drift at all");
});

test("the defence multiplier stays inside its designed swing — adaptation never changes identity", () => {
  const s = world();
  for (const mode of [0, 0.25, 0.5, 0.75, 1]) {
    s.ai.adaptMode = mode;
    const m = adaptDefenceMult(s, "ai");
    assert.ok(m >= 0.4 && m <= 1.6, `defence multiplier ${m} escaped its swing at mode ${mode}`);
  }
  s.ai.adaptMode = ADAPT_NEUTRAL;
  assert.equal(adaptDefenceMult(s, "ai"), 1, "neutral must be exactly 1 — a no-op, not nearly one");
});

test("both seats keep their own stance", () => {
  const s = world();
  s.playerAi = createAiController("ferros", {});
  for (let i = 0; i < 40; i++) addUnit(s, "player", "skiff", 100 + i * 2, 100);   // the ai seat's enemy: massing
  for (let i = 0; i < 8; i++) addBuilding(s, "ai", "refinery", 900 + i * 3, 900); // the player seat's enemy: greedy
  see(s, "ai", 140, 100);
  see(s, "player", 910, 900);
  for (let i = 0; i < 40; i++) {
    updateIntel(s, "ai"); updateAdaptMode(s, "ai", 1);
    updateIntel(s, "player"); updateAdaptMode(s, "player", 1);
  }
  assert.ok(s.ai.adaptMode > ADAPT_NEUTRAL, "the ai seat faces an army");
  assert.ok(s.playerAi.adaptMode < ADAPT_NEUTRAL, "the player seat faces an economy");
});
