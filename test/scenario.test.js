import { test } from "node:test";
import assert from "node:assert/strict";
import { setupEscort, setupRaider, setupBounty, ESCORT_DIFFICULTY, RAIDER_DIFFICULTY, BOUNTY_DIFFICULTY, repairCost, repairConvoy, departNow } from "../engine/scenarios.js";
import { tick } from "../engine/sim.js";
import { UNITS } from "../engine/entities.js";

const freighters = state => [...state.units.values()].filter(u => u.owner === "player" && u.type === "freighter");
const pirates = state => [...state.units.values()].filter(u => u.owner === "ai");

function runToEnd(state, maxTicks = 6000) {
  let t = 0;
  while (!state.over && t < maxTicks) { tick(state, 0.1); t++; }
  return t;
}

// Raider helpers: the convoy is AI-owned, the raiders are the player's.
const convoy = state => [...state.units.values()].filter(u => u.owner === "ai" && u.type === "freighter");
const raiders = state => [...state.units.values()].filter(u => u.owner === "player" && UNITS[u.type].role === "combat");

// Drive the raiders as a player would: focus the whole fleet onto the weakest
// live freighter each tick so it sinks fast, then roll onto the next.
function driveRaiders(state) {
  const live = convoy(state).filter(f => f.hp > 0).sort((a, b) => a.hp - b.hp);
  if (!live.length) return;
  for (const u of raiders(state)) u.order = { type: "attack", targetId: live[0].id };
}

test("setupEscort lays out a convoy mission, not a skirmish", () => {
  const s = setupEscort({ planetId: "ferros", seed: 7, difficulty: "medium" });
  assert.equal(s.buildings.size, 0, "no Command Centers / economy in a scenario");
  assert.equal(freighters(s).length, 4, "four freighters at the start");
  const escorts = [...s.units.values()].filter(u => u.owner === "player" && u.type !== "freighter");
  assert.ok(escorts.length >= 3, "a player escort fleet");
  assert.ok(escorts.every(u => UNITS[u.type].role === "combat" || UNITS[u.type].role === "support"), "escorts are warships / support");
  assert.equal(s.scenario.route.length, ESCORT_DIFFICULTY.medium.legRisk.length + 1, "one more station than legs");
  assert.equal(s.scenario.phase, "prep");
  assert.equal(s.scenario.outcome, null);
});

test("a scenario always resolves to a win or loss within its time limit", () => {
  for (const difficulty of ["easy", "medium", "hard"]) {
    const s = setupEscort({ planetId: "ferros", seed: 3, difficulty });
    runToEnd(s);
    assert.equal(s.over, true, `${difficulty} should reach a terminal state`);
    assert.ok(["win", "loss"].includes(s.scenario.outcome), `${difficulty} has an outcome`);
    assert.ok(s.scenario.score >= 0, "a score is computed");
  }
});

test("a scenario is deterministic: same seed replays to the same outcome and score", () => {
  const run = () => {
    const s = setupEscort({ planetId: "ferros", seed: 999, difficulty: "medium" });
    const ticks = runToEnd(s);
    return `${s.scenario.outcome}|${s.scenario.score}|${s.tick}|${s.units.size}|${ticks}`;
  };
  assert.equal(run(), run(), "identical seed must replay identically");
});

test("a risk-free route delivers every freighter — a win", () => {
  const s = setupEscort({ planetId: "ferros", seed: 1, difficulty: "easy" });
  s.scenario.legRisk = s.scenario.legRisk.map(() => 0);   // no pirates this run
  runToEnd(s);
  assert.equal(s.scenario.outcome, "win");
  assert.equal(s.scenario.delivered, 4, "all four freighters arrive when nothing attacks them");
  assert.ok(s.scenario.score > 0);
});

test("an undefended convoy under heavy raiding is lost", () => {
  const s = setupEscort({ planetId: "ferros", seed: 4, difficulty: "hard" });
  // Strip the escort so the freighters are defenceless, and crank the risk.
  for (const u of [...s.units.values()]) if (u.owner === "player" && u.type !== "freighter") s.units.delete(u.id);
  s.scenario.legRisk = s.scenario.legRisk.map(() => 1.6);
  runToEnd(s);
  assert.equal(s.scenario.outcome, "loss", "no escort + heavy raids = a lost convoy");
  assert.ok(pirates(s).length > 0, "pirates actually spawned");
});

test("running out of time before delivery is a loss", () => {
  const s = setupEscort({ planetId: "ferros", seed: 2, difficulty: "easy" });
  s.scenario.legRisk = s.scenario.legRisk.map(() => 0);   // no combat, just too slow
  s.scenario.timeLimit = 6;                                // far too little to cross the map
  runToEnd(s);
  assert.equal(s.scenario.outcome, "loss");
  assert.ok(s.time >= 6, "the clock actually expired");
});

test("repair heals the convoy at a station and spends the budget once per stop", () => {
  const s = setupEscort({ planetId: "ferros", seed: 5, difficulty: "medium" });
  // Force a docked state with a damaged, cheap-to-fix convoy.
  s.scenario.phase = "docked";
  s.scenario.repairedThisStop = false;
  s.scenario.budget = 1000;
  const f = freighters(s)[0];
  f.hp = f.maxHp - 50;
  const before = s.scenario.budget;
  const cost = repairCost(s);
  assert.ok(cost > 0, "there is damage to pay for");
  assert.equal(repairConvoy(s), true, "repair succeeds when the budget covers it");
  assert.equal(f.hp, f.maxHp, "the freighter is back to full");
  assert.equal(s.scenario.budget, before - cost, "the cost came out of the budget");
  assert.equal(repairConvoy(s), false, "no second repair at the same stop");
});

/* ---------- Pirate Raider ---------- */

test("setupRaider lays out an AI convoy and a player raider fleet", () => {
  const s = setupRaider({ planetId: "ferros", seed: 7, difficulty: "medium" });
  assert.equal(s.buildings.size, 0, "no economy in a scenario");
  assert.equal(s.scenario.type, "raider");
  assert.equal(s.scenario.freighterOwner, "ai", "the convoy is the enemy");
  assert.equal(convoy(s).length, 4, "four AI freighters");
  const escort = [...s.units.values()].filter(u => u.owner === "ai" && u.type !== "freighter");
  assert.ok(escort.length >= 1, "the convoy has an escort");
  assert.ok(raiders(s).length >= 3, "the player commands a raider fleet");
  assert.equal(s.scenario.route.length, RAIDER_DIFFICULTY.medium.legs + 1, "one more station than legs");
  assert.equal(s.scenario.phase, "prep");
});

test("a raider mission always resolves to a win or loss within its time limit", () => {
  for (const difficulty of ["easy", "medium", "hard"]) {
    const s = setupRaider({ planetId: "ferros", seed: 3, difficulty });
    runToEnd(s);
    assert.equal(s.over, true, `${difficulty} should reach a terminal state`);
    assert.ok(["win", "loss"].includes(s.scenario.outcome), `${difficulty} has an outcome`);
    assert.ok(s.scenario.score >= 0, "a score is computed");
  }
});

test("a raider mission is deterministic: same seed replays identically", () => {
  const run = () => {
    const s = setupRaider({ planetId: "vesper", seed: 424242, difficulty: "medium" });
    const ticks = runToEnd(s);
    return `${s.scenario.outcome}|${s.scenario.score}|${s.tick}|${s.units.size}|${ticks}`;
  };
  assert.equal(run(), run(), "identical seed must replay identically");
});

test("with no raiding, the convoy escapes to the gate — a loss for the pirate", () => {
  const s = setupRaider({ planetId: "ferros", seed: 11, difficulty: "easy" });
  runToEnd(s);
  assert.equal(s.scenario.outcome, "loss", "an idle raider lets the whole convoy through");
  assert.equal(s.scenario.destroyed, 0, "no freighters were sunk");
  assert.equal(s.scenario.delivered, 4, "every freighter reached the gate");
});

test("a focused raider fleet sinks its quota — a win", () => {
  const s = setupRaider({ planetId: "ferros", seed: 8, difficulty: "easy" });
  let t = 0;
  while (!s.over && t < 6000) { driveRaiders(s); tick(s, 0.1); t++; }
  assert.equal(s.scenario.outcome, "win", "focusing freighters should hit the kill quota");
  assert.ok(s.scenario.destroyed >= s.scenario.targetKills, "quota met");
  assert.ok(s.scenario.score > 0);
});

test("losing every raider ends the raid in defeat", () => {
  const s = setupRaider({ planetId: "ferros", seed: 6, difficulty: "medium" });
  for (const u of [...s.units.values()]) if (u.owner === "player") s.units.delete(u.id);
  tick(s, 0.1);
  assert.equal(s.scenario.outcome, "loss", "no raiders left = a lost raid");
  assert.match(s.scenario.banner, /wiped out/);
});

test("a raid that runs out the clock is a loss, even with raiders still alive and kills on the board", () => {
  // The raider mission's TIMEOUT branch. Its two sibling loss paths (every raider dead; the whole
  // convoy delivered) were both covered and this one was not, which is the easiest of the three to
  // break silently: a raid that stalls just short of quota has live ships and real progress, so
  // anything that fails to end it leaves the mission running forever rather than visibly wrong.
  const s = setupRaider({ planetId: "ferros", seed: 8, difficulty: "easy" });
  // Sink ONE freighter, then stop — real progress, deliberately short of targetKills.
  const first = convoy(s).sort((a, b) => (a.id < b.id ? -1 : 1))[0];
  s.units.delete(first.id);
  s.scenario.destroyed = 1;
  assert.ok(s.scenario.targetKills > 1, "fixture sanity: the quota must need more than the one kill above");
  s.scenario.timeLimit = s.time + 0.5;   // the clock is about to expire, nothing else has resolved

  runToEnd(s, 200);
  assert.equal(s.over, true, "an expired clock must actually end the mission");
  assert.equal(s.scenario.outcome, "loss", "short of quota when time runs out is a loss");
  assert.ok(raiders(s).length > 0, "this is the timeout path, not the wiped-out path");
  assert.match(s.scenario.banner, /Out of time/);
});

test("departNow skips the remaining dock timer, and is a no-op in every other phase", () => {
  // departNow is the UI's "set off early" button. Both halves matter: it has to actually cut the
  // wait (or the button lies), and it must not fire mid-leg (or a convoy teleports out of a phase
  // its own logic assumes it is in). Nothing exercised it at all.
  const s = setupEscort({ planetId: "ferros", seed: 7, difficulty: "medium" });
  s.scenario.phase = "docked";
  s.scenario.phaseTimer = 25;
  departNow(s);
  assert.equal(s.scenario.phaseTimer, 0, "docked: the remaining wait is cleared");

  s.scenario.phase = "travel";
  s.scenario.phaseTimer = 25;
  departNow(s);
  assert.equal(s.scenario.phaseTimer, 25, "not docked: the timer must be left completely alone");

  // And with no scenario at all (a plain skirmish state) it must not throw.
  assert.doesNotThrow(() => departNow({ scenario: null }));
});

/* ---------- Bounty Marshal ---------- */

const posse = state => [...state.units.values()].filter(u => u.owner === "player" && UNITS[u.type].role === "combat");
const camps = state => [...state.units.values()].filter(u => u.owner === "ai" && u.packId != null);

// Clear the pirates belonging to `n` distinct packs outright (delete them), to
// exercise the objective logic independently of combat balance.
function wipePacks(state, n) {
  const ids = [...new Set(camps(state).map(u => u.packId))].slice(0, n);
  const target = new Set(ids);
  for (const u of [...state.units.values()]) if (u.owner === "ai" && target.has(u.packId)) state.units.delete(u.id);
}

test("setupBounty scatters pirate camps and musters a posse", () => {
  const s = setupBounty({ planetId: "ferros", seed: 7, difficulty: "medium" });
  const diff = BOUNTY_DIFFICULTY.medium;
  assert.equal(s.buildings.size, 0, "no economy in a scenario");
  assert.equal(s.scenario.type, "bounty");
  assert.equal(s.scenario.packs.length, diff.packs, "one marker per camp");
  assert.equal(s.scenario.totalPacks, diff.packs);
  assert.equal(new Set(camps(s).map(u => u.packId)).size, diff.packs, "every camp has its own pack");
  assert.ok(posse(s).length >= 4, "the marshal has a posse");
  assert.ok(s.scenario.packs.every(p => p.bounty > 0 && !p.cleared), "each camp carries an uncleared bounty");
});

test("a bounty mission always resolves to a win or loss within its time limit", () => {
  for (const difficulty of ["easy", "medium", "hard"]) {
    const s = setupBounty({ planetId: "ferros", seed: 3, difficulty });
    runToEnd(s);
    assert.equal(s.over, true, `${difficulty} should reach a terminal state`);
    assert.ok(["win", "loss"].includes(s.scenario.outcome), `${difficulty} has an outcome`);
    assert.ok(s.scenario.score >= 0, "a score is computed");
  }
});

test("a bounty mission is deterministic: same seed replays identically", () => {
  const run = () => {
    const s = setupBounty({ planetId: "glacius", seed: 31337, difficulty: "medium" });
    const ticks = runToEnd(s);
    return `${s.scenario.outcome}|${s.scenario.score}|${s.tick}|${s.units.size}|${ticks}`;
  };
  assert.equal(run(), run(), "identical seed must replay identically");
});

test("with no hunting, the clock expires with nothing cleared — a loss", () => {
  const s = setupBounty({ planetId: "ferros", seed: 11, difficulty: "easy" });
  runToEnd(s);
  assert.equal(s.scenario.outcome, "loss", "an idle posse clears no camps");
  assert.equal(s.scenario.packsCleared, 0, "no camps were cleared");
  assert.ok(s.time >= s.scenario.timeLimit, "the clock actually expired");
});

test("clearing the quota of camps wins and banks their bounty", () => {
  const s = setupBounty({ planetId: "ferros", seed: 9, difficulty: "medium" });
  wipePacks(s, s.scenario.targetPacks);   // clear exactly the quota
  tick(s, 0.1);
  assert.equal(s.scenario.outcome, "win", "meeting the quota wins immediately");
  assert.equal(s.scenario.packsCleared, s.scenario.targetPacks);
  assert.ok(s.scenario.bounty > 0, "cleared camps bank their bounty");
  assert.ok(s.scenario.score > 0);
});

test("losing the whole posse ends the hunt in defeat", () => {
  const s = setupBounty({ planetId: "ferros", seed: 6, difficulty: "medium" });
  for (const u of [...s.units.values()]) if (u.owner === "player") s.units.delete(u.id);
  tick(s, 0.1);
  assert.equal(s.scenario.outcome, "loss", "no posse left = a lost hunt");
  assert.match(s.scenario.banner, /wiped out/);
});

/* ---------- map size scaling (all scenarios) ---------- */

test("a larger map scales the mission clock with its dimensions", () => {
  const small = setupEscort({ planetId: "ferros", seed: 1, difficulty: "medium", sizeMult: 1 });
  const large = setupEscort({ planetId: "ferros", seed: 1, difficulty: "medium", sizeMult: 3 });
  assert.equal(large.map.width, small.map.width * 3, "the map itself is 3x wider");
  assert.equal(large.scenario.timeLimit, small.scenario.timeLimit * 3, "the clock scales with the route");
  // The route still spans the (wider) map end to end.
  assert.ok(large.scenario.route.at(-1).x > small.scenario.route.at(-1).x * 2.5, "the route grows with the map");
});

test("a risk-free convoy still delivers on a gigantic map — the clock keeps up", () => {
  const s = setupEscort({ planetId: "korrath", seed: 2, difficulty: "easy", sizeMult: 4 });
  s.scenario.legRisk = s.scenario.legRisk.map(() => 0);
  runToEnd(s, s.scenario.timeLimit / 0.1 + 2000);
  assert.equal(s.scenario.outcome, "win", "the convoy can cross a 4x map within the scaled clock");
  assert.equal(s.scenario.delivered, 4);
});

test("scattered camps stay reachable on a large map — a driven posse still wins", () => {
  const s = setupBounty({ planetId: "korrath", seed: 2, difficulty: "easy", sizeMult: 3 });
  let t = 0;
  const max = s.scenario.timeLimit / 0.1 + 2000;
  while (!s.over && t < max) {
    const p = posse(s), men = [...s.units.values()].filter(u => u.owner === "player" && UNITS[u.type].role === "support");
    const live = camps(s).filter(u => u.hp > 0);
    if (p.length && live.length) {
      const c = { x: 0, y: 0 };
      for (const u of p) { c.x += u.x; c.y += u.y; }
      c.x /= p.length; c.y /= p.length;
      let near = live[0], best = Infinity;
      for (const u of live) { const d = Math.hypot(u.x - c.x, u.y - c.y); if (d < best) { best = d; near = u; } }
      for (const u of p) u.order = { type: "attack-move", x: near.x, y: near.y };
      for (const u of men) u.order = { type: "move", x: c.x, y: c.y };
    }
    tick(s, 0.1); t++;
  }
  assert.equal(s.scenario.outcome, "win", "the posse can traverse a 3x sector and clear its quota in time");
});

test("a posse that hunts down camps clears at least one through real combat", () => {
  const s = setupBounty({ planetId: "ferros", seed: 8, difficulty: "easy" });
  // Drive the posse camp to camp: attack-move the whole posse at the nearest
  // live pirate, so it engages and wipes camps the way a player would.
  let t = 0;
  while (!s.over && t < 3000) {
    const live = camps(s).filter(u => u.hp > 0);
    if (live.length) {
      const c = { x: 0, y: 0 };
      for (const u of posse(s)) { c.x += u.x; c.y += u.y; }
      const p = posse(s);
      if (p.length) {
        c.x /= p.length; c.y /= p.length;
        let near = live[0], best = Infinity;
        for (const u of live) { const d = Math.hypot(u.x - c.x, u.y - c.y); if (d < best) { best = d; near = u; } }
        for (const u of p) u.order = { type: "attack-move", x: near.x, y: near.y };
      }
    }
    tick(s, 0.1);
    t++;
  }
  assert.ok(s.scenario.packsCleared >= 1, "the posse cleared at least one camp in real combat");
});
