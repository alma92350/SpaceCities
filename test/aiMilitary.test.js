/* ============================================================
   AI MILITARY (engine/aiMilitary.js) — the offense ramp's real-target guard.

   The living galaxy instantiates every world at galaxy creation, but
   engine/galaxy.js's `addPlanet(..., { unsettled: true })` strips ALL player
   units and buildings from a world the player hasn't reached yet — so a
   background/unvisited neighbour starts with ZERO player footprint. Its own
   diplomacy (engine/diplomacy.js) still drifts toward war on its own —
   scarcity, and past grace, unbounded late-game creep — with no player
   involvement at all. Once hostile, aiOffense's Odyssey branch has, until
   now, mustered and committed a wave regardless: chooseAttackTarget always
   resolves SOME coordinate (the player's charted-but-empty start, or a
   fog-sweep hunt point) even when there is nothing there to fight. That
   wastes the neighbour's whole production line, forever, on a world the
   player may never even visit — and (a real save's data) starves it of the
   surplus it would otherwise bank toward its own economy.

   Written from the requirement, ahead of the fix: an Odyssey neighbour must
   only muster and commit a voluntary wave once the player has SOME real
   footprint on that specific world — a unit or a building, either counts.
   Deliberately NOT fog-gated (unlike visibleEnemyForceCount/counterToPlayerArmy):
   this is "is there anyone there at all", not "can the AI currently see them".
   Skirmish (no state.diplomacy) never reaches the guarded branch, so an
   always-present skirmish player is untouched — see the "no diplomacy"
   coverage in test/diplomacy.test.js.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeBuilding, makeUnit } from "../engine/state.js";
import { runAI } from "../engine/ai.js";
import { raidTarget, chooseAttackTarget, counterToPlayerArmy, visibleEnemyForceCount, updateScout } from "../engine/aiMilitary.js";
import { updateFog } from "../engine/fog.js";
import { opponentsOf } from "../engine/aiCommon.js";

const THINK = 1.5;   // matches ai.js THINK_INTERVAL — forces a fresh think each call

// A `ferros` world with an AI home army banked at the given neighbour stance, but with
// EVERY player unit/building stripped — mirroring exactly what engine/galaxy.js's
// addPlanet(..., {unsettled:true}) leaves behind on a world the player has never reached.
// (createGameState always seeds a starting CC + 3 workers per side in non-endless mode —
// stripping the player's half afterward is what reproduces the real "never been here" world.)
function unvisitedHostileWorld(stance, n = 12) {
  const s = createGameState({ planetId: "ferros" });
  for (const [id, u] of [...s.units]) if (u.owner === "player") s.units.delete(id);
  for (const [id, b] of [...s.buildings]) if (b.owner === "player") s.buildings.delete(id);
  const army = [];
  for (let i = 0; i < n; i++) {
    const u = makeUnit("skiff", "ai", s.map.bases.ai.x, s.map.bases.ai.y);
    s.units.set(u.id, u); army.push(u);
  }
  s.diplomacy = { stance, depletion: 0 };
  return { s, army };
}
const attacking = army => army.filter(u => u.order?.type === "attack-move").length;

test("a deeply-hostile neighbour never commits a wave on a world with zero player presence", () => {
  const { s, army } = unvisitedHostileWorld(-0.95);   // h≈0.94 — would be a near-full commit if anyone were there
  runAI(s, THINK);
  assert.equal(attacking(army), 0, "nothing to attack on a world the player has never set foot on — no wave should launch");
});

test("even a barely-wary neighbour holds its probe, not just its doomstack, with no player footprint", () => {
  const { s, army } = unvisitedHostileWorld(-0.2);   // just past the peace line — a small-probe stance elsewhere
  runAI(s, THINK);
  assert.equal(attacking(army), 0, "no player footprint ⇒ no probe either, however wary the neighbour is");
});

test("the same hostile neighbour commits a wave once the player has a real unit here, even with no building", () => {
  const { s, army } = unvisitedHostileWorld(-0.95);
  const scout = makeUnit("worker", "player", s.map.bases.player.x, s.map.bases.player.y);
  s.units.set(scout.id, scout);
  runAI(s, THINK);
  assert.ok(attacking(army) > 0, "a real player unit is a real target — the wave still launches");
});

test("...and with only a standing player building here, even with no player unit", () => {
  const { s, army } = unvisitedHostileWorld(-0.95);
  const outpost = makeBuilding("command", "player", s.map.bases.player.x, s.map.bases.player.y);
  s.buildings.set(outpost.id, outpost);
  runAI(s, THINK);
  assert.ok(attacking(army) > 0, "a standing player building is a real target — the wave still launches");
});

/* ============================================================
   Garrison dispersal (engine/aiMilitary.js disperseGarrison): the AI's idle home army — whatever
   isn't off attacking — spreads across a few stations around its own Command Center(s) instead of
   sitting clumped at whichever building's rally point produced it. Fixtures below always pre-seed
   a scout (and keep the test army below the archetype's armyAttackSize) so updateScout/aiOffense's
   own wave-muster logic never dips into or consumes the units under test — isolating dispersal
   itself, the same convention the size-triggered/partial-wave tests in test/ai.test.js use.
   ============================================================ */

function preSeededScout(s, cc) {
  const scout = makeUnit("skiff", "ai", cc.x, cc.y - 200);
  scout.order = { type: "move", x: 100, y: 100 };
  s.units.set(scout.id, scout);
  s.ai.scoutId = scout.id;
}

test("an idle home army disperses across more than one station instead of all sharing the same destination", () => {
  const s = createGameState({ planetId: "ferros" });
  s.time = 0;
  const cc = [...s.buildings.values()].find(b => b.owner === "ai" && b.type === "command");
  preSeededScout(s, cc);
  const army = [];
  for (let i = 0; i < 5; i++) {   // well under any archetype's armyAttackSize — no strike should trigger
    const u = makeUnit("skiff", "ai", cc.x - 30 - i * 4, cc.y);   // clumped near the CC, like a shared rally point
    s.units.set(u.id, u);
    army.push(u);
  }

  runAI(s, THINK);

  const destinations = new Set(
    army.filter(u => u.order?.type === "move").map(u => `${Math.round(u.order.x)},${Math.round(u.order.y)}`));
  assert.ok(destinations.size > 1, "the idle army should split across more than one distinct station, not one shared point");
  for (const u of army) {
    if (u.order?.type !== "move") continue;
    const d = Math.hypot(u.order.x - cc.x, u.order.y - cc.y);
    assert.ok(d > 0 && d < 340, `each station sits a real distance from the CC (${d.toFixed(0)}) but still within the defend-recall radius (340)`);
  }
});

test("a unit already fighting (autoTarget set) is left alone by dispersal, not redirected to a station", () => {
  const s = createGameState({ planetId: "ferros" });
  s.time = 0;
  const cc = [...s.buildings.values()].find(b => b.owner === "ai" && b.type === "command");
  preSeededScout(s, cc);
  const fighter = makeUnit("skiff", "ai", cc.x - 30, cc.y);
  fighter.autoTarget = "some-enemy-id";   // already mid-fight via auto-acquire, no formal order needed for that
  s.units.set(fighter.id, fighter);

  runAI(s, THINK);

  assert.equal(fighter.order, null, "dispersal must never assign a move order to a unit that's already engaged");
});

test("a unit focus-fired onto a target (focusId set) is also left alone by dispersal", () => {
  const s = createGameState({ planetId: "ferros" });
  s.time = 0;
  const cc = [...s.buildings.values()].find(b => b.owner === "ai" && b.type === "command");
  preSeededScout(s, cc);
  const fighter = makeUnit("skiff", "ai", cc.x - 30, cc.y);
  fighter.focusId = "some-enemy-id";
  s.units.set(fighter.id, fighter);

  runAI(s, THINK);

  assert.equal(fighter.order, null, "a tactical focus-fire target counts as engaged too, same as autoTarget");
});

test("a unit far from every Command Center (a stray deep in contested territory) is left alone, not yanked home", () => {
  const s = createGameState({ planetId: "ferros" });
  s.time = 0;
  const cc = [...s.buildings.values()].find(b => b.owner === "ai" && b.type === "command");
  preSeededScout(s, cc);
  const stray = makeUnit("skiff", "ai", cc.x + 1000, cc.y + 1000);   // well outside DISPERSAL_HOME_RADIUS (600)
  s.units.set(stray.id, stray);

  runAI(s, THINK);

  assert.equal(stray.order, null, "a unit this far from home isn't home yet — dispersal leaves it exactly where it stands");
});

test("multiple Command Centers each disperse their own nearby units to their own ring", () => {
  const s = createGameState({ planetId: "ferros" });
  s.time = 0;
  const homeCC = [...s.buildings.values()].find(b => b.owner === "ai" && b.type === "command");
  preSeededScout(s, homeCC);
  const expansionCC = makeBuilding("command", "ai", homeCC.x + 500, homeCC.y + 500);
  s.buildings.set(expansionCC.id, expansionCC);
  const homeUnit = makeUnit("skiff", "ai", homeCC.x - 30, homeCC.y);
  const expansionUnit = makeUnit("skiff", "ai", expansionCC.x - 30, expansionCC.y);
  s.units.set(homeUnit.id, homeUnit);
  s.units.set(expansionUnit.id, expansionUnit);

  runAI(s, THINK);

  assert.equal(homeUnit.order?.type, "move");
  assert.equal(expansionUnit.order?.type, "move");
  assert.ok(Math.hypot(homeUnit.order.x - homeCC.x, homeUnit.order.y - homeCC.y) < 340,
    "the home unit's station rings the home CC");
  assert.ok(Math.hypot(expansionUnit.order.x - expansionCC.x, expansionUnit.order.y - expansionCC.y) < 340,
    "the expansion unit's station rings the expansion CC");
  assert.ok(Math.hypot(homeUnit.order.x - expansionCC.x, homeUnit.order.y - expansionCC.y) > 340,
    "...not the OTHER Command Center's ring");
  assert.ok(Math.hypot(expansionUnit.order.x - homeCC.x, expansionUnit.order.y - homeCC.y) > 340,
    "...and vice versa");
});

test("garrisonSlots keeps a large parked group inside the recall radius, corners included (T2)", async () => {
  // The header claims the corrective pull-back "keeps the WHOLE parked group, not just its middle,
  // inside the radius". The premise is false: the anchor is pulled back RADIALLY, but the farthest
  // slot is an off-axis grid CORNER, so max|slot - cc| is not a linear function of the anchor's
  // radius and one pass never converges. Measured residual grows with garrison size — 0.1px at 8
  // units, 1.7px at 40. The branch had also never executed under npm test: every dispersal test
  // uses 1 or 5 units around a bare Command Center, which doesn't overshoot until ~60.
  const { garrisonSlots, DEFEND_RADIUS, STATION_REACH } = await import("../engine/aiMilitary.js");
  const cc = makeBuilding("command", "ai", 1500, 500);
  const buildings = [cc];
  for (let i = 0; i < 8; i++)                         // a built-out footprint, so the ring starts wide
    buildings.push(makeBuilding("barracks", "ai", cc.x + Math.cos(i) * 90, cc.y + Math.sin(i) * 90));
  // 80, not 40: measured, the corrective branch doesn't fire at all below ~60 units, so a smaller
  // fixture asserts nothing about it. Residual grows with size — 0.1px at 60, 1.2px at 80.
  const units = Array.from({ length: 80 }, () => makeUnit("skiff", "ai", cc.x, cc.y));

  const slots = garrisonSlots(units, cc, buildings, 2400, 1000);
  const limit = DEFEND_RADIUS - STATION_REACH;
  const farthest = Math.max(...slots.map(s => Math.hypot(s.x - cc.x, s.y - cc.y)));
  assert.ok(farthest <= limit + 1e-6,
    `every parked slot must sit inside the recall radius — farthest ${farthest.toFixed(2)} vs limit ${limit}`);
});

/* ---- T3: the decision arithmetic, tested directly ------------------------------------------
   These are pure functions over plain arguments, and until now every one of them could only be
   reached by staging a whole match through runAI. That is the direct cause of two coverage gaps
   this review found (an army-cap feature with no test at all, and a corrective branch that had
   never executed), so the point of exporting them is that the arithmetic is now cheap to pin. */

test("withoutHomeGuard keeps the `garrison` units NEAREST home and releases the rest (T3)", async () => {
  const { withoutHomeGuard } = await import("../engine/aiMilitary.js");
  const cc = { x: 0, y: 0 };
  const near = { id: "near", x: 10, y: 0 };
  const mid = { id: "mid", x: 100, y: 0 };
  const far = { id: "far", x: 500, y: 0 };
  const army = [far, near, mid];                       // deliberately unsorted

  assert.deepEqual(withoutHomeGuard(army, cc, 0).map(u => u.id), ["near", "mid", "far"],
    "garrison 0 releases everyone, nearest-home first");
  assert.deepEqual(withoutHomeGuard(army, cc, 1).map(u => u.id), ["mid", "far"],
    "the single closest unit stays home");
  assert.deepEqual(withoutHomeGuard(army, cc, 3), [], "a garrison at or above the army size keeps everyone");
  assert.deepEqual(withoutHomeGuard(army, cc, 9), [], "…and above it too");
  assert.deepEqual(withoutHomeGuard(army, null, 1).map(u => u.id).sort(), ["far", "mid", "near"],
    "with no Command Center there is nothing to measure from, so everyone is released");
});

test("threatCentroid averages the threat positions (T3)", async () => {
  const { threatCentroid } = await import("../engine/aiMilitary.js");
  assert.deepEqual(threatCentroid([{ x: 0, y: 0 }, { x: 10, y: 20 }]), { x: 5, y: 10 });
  assert.deepEqual(threatCentroid([{ x: 7, y: -3 }]), { x: 7, y: -3 });
});

/* ============================================================
   T-043 (ADR-0008): opponentsOf() replacing otherOwner()'s "exactly one enemy" axiom.

   visibleEnemyCombatUnits/raidTarget/chooseAttackTarget/counterToPlayerArmy each used to filter on
   a single hardcoded `enemyOwner`. otherOwner("ai") always answered "player" — so on a 3-owner
   match a third seat's army was structurally invisible to every one of these: not merely unscouted,
   but excluded from the candidate pool before fog was even consulted. No new "which rival do I
   focus on" policy was needed to fix this — every one of these already picks nearest/most-common
   among a pool; opponentsOf(state, owner) just widens that pool to every real opponent, and the
   existing pick logic does the rest. ============================================================ */

// Mirrors unvisitedHostileWorld's own "clear the map so each test states its own situation exactly"
// convention, but with a third AI-controlled owner (basePositions is T-041's own stopgap — it seeds
// "rebels" a starting position without needing a real N-position map generator, T-044's later job).
// Strips every OPPONENT's default seeding, same as unvisitedHostileWorld — but, unlike it, keeps
// "ai"'s own starting Command Center/workers: that CC (sight 220) is what gives updateFog(state,
// state.fogs.ai, "ai") anything to reveal from at all, exactly as ai.test.js's own revealPlayerArmy
// helper relies on it too.
function world3() {
  const s = createGameState({
    planetId: "ferros",
    ownerDefs: [
      { id: "player", faction: "neutral", isAI: false, color: "#4fd1ff" },
      { id: "ai", faction: "neutral", isAI: true, color: "#f87171" },
      { id: "rebels", faction: "neutral", isAI: true, color: "#fbbf24" },
    ],
    basePositions: { rebels: { x: 900, y: 300 } },
  });
  for (const [id, u] of [...s.units]) if (u.owner !== "ai") s.units.delete(id);
  for (const [id, b] of [...s.buildings]) if (b.owner !== "ai") s.buildings.delete(id);
  return s;
}

test("T-043: visibleEnemyForceCount() counts visible combat units from EVERY opponent, not just one", () => {
  const s = world3();
  const aiBase = s.map.bases.ai;
  const p = makeUnit("skiff", "player", aiBase.x + 40, aiBase.y);
  const r = makeUnit("skiff", "rebels", aiBase.x + 60, aiBase.y);
  s.units.set(p.id, p); s.units.set(r.id, r);
  updateFog(s, s.fogs.ai, "ai");
  assert.equal(visibleEnemyForceCount(s, "ai"), 2, "both opponents' visible combat units must count, not just one");
});

test("T-043: raidTarget() finds the nearest visible worker across EVERY opponent, not just one", () => {
  const s = world3();
  const aiBase = s.map.bases.ai;
  // Both within the seeded Command Center's own 220 sight radius, so both are genuinely VISIBLE —
  // proof this is picking the nearer of two seen candidates, not merely ignoring an unseen one.
  const farWorker = makeUnit("worker", "player", aiBase.x + 180, aiBase.y);
  const nearWorker = makeUnit("worker", "rebels", aiBase.x + 50, aiBase.y);
  s.units.set(farWorker.id, farWorker); s.units.set(nearWorker.id, nearWorker);
  updateFog(s, s.fogs.ai, "ai");
  const target = raidTarget(s, "ai");
  assert.ok(target, "a visible worker exists — must not return null");
  assert.equal(target.x, nearWorker.x, "the NEARER opponent's worker wins, regardless of which opponent it belongs to");
  assert.equal(target.y, nearWorker.y);
});

test("T-043: chooseAttackTarget() picks the nearest seen Command Center across EVERY opponent, not just one", () => {
  const s = world3();
  const aiBase = s.map.bases.ai;
  // Both within the seeded Command Center's own 220 sight radius, so both are genuinely VISIBLE —
  // proof this is picking the nearer of two seen candidates, not merely ignoring an unseen one.
  const farCC = makeBuilding("command", "player", aiBase.x + 180, aiBase.y);
  const nearCC = makeBuilding("command", "rebels", aiBase.x + 80, aiBase.y);
  s.buildings.set(farCC.id, farCC); s.buildings.set(nearCC.id, nearCC);
  updateFog(s, s.fogs.ai, "ai");
  const target = chooseAttackTarget(s, null, "ai");
  assert.equal(target.x, nearCC.x, "the nearer opponent's Command Center wins the target, whichever opponent it belongs to");
  assert.equal(target.y, nearCC.y);
});

test("T-043: chooseAttackTarget()'s hunting fallback degrades safely when an opponent has no known start yet", () => {
  // Built by SPLICING a third owner onto an otherwise-plain 2-owner state — the same convention
  // test/ownerScaffold.test.js's own pre-existing "rebels" tests use — rather than via ownerDefs:
  // T-044 landed a real radial map generator that now gives every ownerDefs-supplied owner a
  // genuine base, so "an opponent with no known start" can no longer be reached that way.
  // Splicing keeps state.map.bases at its original 2-key shape untouched, reproducing the
  // scenario this guard exists for. Nothing placed, nothing seen.
  const s = createGameState({ planetId: "ferros" });
  s.owners.push("rebels");
  assert.equal(s.map.bases.rebels, undefined, "fixture sanity: a spliced-on owner has no map.bases entry of its own");
  const target = chooseAttackTarget(s, null, "ai");
  assert.deepEqual(target, { x: s.map.bases.player.x, y: s.map.bases.player.y },
    "with only one opponent's start actually known, the fallback must use it rather than throw");
});

test("T-043: updateScout() doesn't crash when its primary opponent has no known base position yet", () => {
  // Same splice as above (state.map.bases must stay 2-keyed — T-044's real generator would
  // otherwise give a THIRD ownerDefs-supplied owner a genuine base). Reordering state.owners
  // puts "rebels" before "player" so opponentsOf(s,"ai")[0] (ai.js's aiContext) — "ai"'s PRIMARY
  // opponent — resolves to it, and state.map.bases never gets an entry for it.
  const s = createGameState({ planetId: "ferros" });
  s.owners = ["rebels", "player", "ai"];
  assert.deepEqual(opponentsOf(s, "ai"), ["rebels", "player"], "fixture sanity: rebels must be ai's PRIMARY (first) opponent here");
  assert.equal(s.map.bases.rebels, undefined, "fixture sanity: rebels has no real map.bases entry");

  const army = [];
  for (let i = 0; i < 5; i++) {
    const u = makeUnit("skiff", "ai", s.map.bases.ai.x + i * 5, s.map.bases.ai.y);
    s.units.set(u.id, u); army.push(u);
  }
  const ctx = { army, rangers: [], owner: "ai", enemyOwner: opponentsOf(s, "ai")[0], controller: s.controllers.ai };
  assert.doesNotThrow(() => updateScout(s, ctx, false),
    "must not crash reaching for an opponent's not-yet-known base position");
});

test("T-043: counterToPlayerArmy() tallies visible combat unit types across EVERY opponent combined, not just one", () => {
  const s = world3();
  const aiBase = s.map.bases.ai;
  // 2 Dreadnoughts from "player" + 3 from "rebels" = 5 combined outnumbering anything else visible —
  // COUNTER_OF's Dreadnought counter (Skiff, per test/ai.test.js's own single-opponent proof) must
  // still win, which only happens if the tally is genuinely COMBINING across opponents.
  for (let i = 0; i < 2; i++) { const u = makeUnit("dreadnought", "player", aiBase.x + 40 + i * 14, aiBase.y); s.units.set(u.id, u); }
  for (let i = 0; i < 3; i++) { const u = makeUnit("dreadnought", "rebels", aiBase.x + 40 + i * 14, aiBase.y + 20); s.units.set(u.id, u); }
  updateFog(s, s.fogs.ai, "ai");
  assert.equal(counterToPlayerArmy(s, "ai"), "skiff", "5 combined visible Dreadnoughts across two opponents must still draw the Skiff counter-pick");
});
