import { test } from "node:test";
import assert from "node:assert/strict";
import { createGalaxy, activeState, addPlanet, checkDomination, galaxyStatus, DOMINATION_TARGET,
         updateFactionWarmth, sweepColonies } from "../engine/galaxy.js";
import { serializeGalaxy, deserializeGalaxy } from "../engine/persist.js";
import { makeBuilding } from "../engine/state.js";
import { updateDiplomacy, atPeace, PEACE_THRESHOLD, FACTION_ECHO_PENALTY } from "../engine/diplomacy.js";
import { liveWorld, wakeRoster } from "./_helpers.js";

// Eliminate the AI's foothold on a world — its Command Center AND its (undeployed)
// colony ship. A world isn't conquered while the neighbour still holds a colony ship it
// could re-found from (engine/galaxy.js hasAiCommand), so razing only the CC no longer
// pacifies — you must also destroy the ship, which is what "drove them off" means now.
function razeAiCommand(state) {
  for (const [id, b] of [...state.buildings]) if (b.owner === "ai" && b.type === "command") state.buildings.delete(id);
  for (const [id, u] of [...state.units]) if (u.owner === "ai" && u.type === "colonyship") state.units.delete(id);
}

function drainNodes(state, frac) {   // leave `frac` of every deposit — frac 0.05 = nearly mined out
  for (const n of state.map.nodes) n.amount = n.max * frac;
}

// Group the galaxy's worlds by their neighbour's faction (archetypeFor's assignment, read straight
// off each world's live AI player — no claims/checkExpansion needed for this). Used so faction-memory
// fixtures don't have to hard-code specific planet ids, which are an aiArchetypes.js/data.js
// implementation detail these tests shouldn't need to know. Only worlds the galaxy is actually
// simulating can carry a stance at all, so a dormant one (engine/galaxy.js BACKGROUND_WORLDS) is
// skipped — the faction-memory fixtures below wake the whole roster first, precisely so which
// worlds a seed drew can't decide whether there's a faction bloc to test with.
function worldsByFaction(g) {
  const map = new Map();
  for (const id of g.worlds) {
    const s = g.planets.get(id);
    const f = s && s.players.ai && s.players.ai.faction;
    if (!f) continue;
    if (!map.has(f)) map.set(f, []);
    map.get(f).push(id);
  }
  return map;
}

// A faction with at least `n` worlds OTHER than the active seat (kept out of the fixture so
// pacifying/echoing never has to reason about the player's own current world).
function factionWithAtLeast(g, n) {
  for (const [faction, ids] of worldsByFaction(g)) {
    const nonActive = ids.filter(id => id !== g.activeId);
    if (nonActive.length >= n) return { faction, ids: nonActive };
  }
  return null;
}

test("razing a neighbour's Command Center pacifies that world (and queues a toast)", () => {
  const g = createGalaxy({ seed: 30 });
  assert.equal(galaxyStatus(g).pacified, 0, "nothing conquered at the start");
  razeAiCommand(activeState(g));
  checkDomination(g);
  assert.ok(g.pacified.has(g.activeId), "the world is pacified once its capital falls");
  assert.equal(galaxyStatus(g).pacified, 1);
  assert.ok(g.pacifyNotes.includes(g.activeId), "and is queued for a UI toast");
});

test("pacification is sticky — a rebuilt capital can't un-conquer a world", () => {
  const g = createGalaxy({ seed: 31 });
  const s = activeState(g);
  razeAiCommand(s);
  checkDomination(g);
  assert.ok(g.pacified.has(g.activeId));
  const cc = makeBuilding("command", "ai", 100, 100);   // the neighbour rebuilds
  s.buildings.set(cc.id, cc);
  checkDomination(g);
  assert.ok(g.pacified.has(g.activeId), "still conquered — pacification is permanent");
  assert.ok(!activeState(g).over, "one world is not a Domination win");
});

test("conquering DOMINATION_TARGET worlds fires the grand conquest milestone (no win — play forever)", () => {
  const g = createGalaxy({ seed: 32 });
  for (const id of g.worlds.slice(0, DOMINATION_TARGET)) {
    const s = g.planets.get(id) || addPlanet(g, id);   // visit it (seeds an AI capital)...
    razeAiCommand(s);                                   // ...then raze that capital
  }
  checkDomination(g);
  assert.equal(g.pacified.size, DOMINATION_TARGET);
  assert.ok(!activeState(g).over, "the sandbox does NOT end — conquest is a milestone, not a victory");
  assert.ok(g.reached.has("domination"), "the grand conquest milestone is recorded");
  assert.ok(g.milestones.includes("domination"), "…and queued for a firework");
  checkDomination(g);                                   // idempotent: the milestone fires only once
  assert.equal(g.milestones.filter(m => m === "domination").length, 1, "no duplicate firework on a later tick");
});

test("a fresh, un-razed world is never accidentally pacified", () => {
  const g = createGalaxy({ seed: 34 });
  addPlanet(g, g.worlds.find(w => w !== g.activeId));   // a visited world with its AI capital intact
  checkDomination(g);
  assert.equal(g.pacified.size, 0, "no capital razed → nothing conquered");
});

test("Domination progress survives a save/load", () => {
  const g = createGalaxy({ seed: 33 });
  razeAiCommand(activeState(g));
  checkDomination(g);
  assert.equal(g.pacified.size, 1);
  const restored = deserializeGalaxy(JSON.parse(JSON.stringify(serializeGalaxy(g))));
  assert.ok(restored.pacified.has(g.activeId), "the conquered world persists");
  assert.equal(restored.pacified.size, 1);
});

/* ============================================================
   Domination with teeth: pacified worlds stand down (docs/improvement-proposals.md 657-665).
   checkDomination now also stamps state.diplomacy.pacified on a freshly-razed world; updateDiplomacy
   reads that flag to floor the world's drift TARGET at Neutral permanently.
   ============================================================ */

test("checkDomination stamps state.diplomacy.pacified the moment a world is pacified", () => {
  const g = createGalaxy({ seed: 40 });
  const s = activeState(g);
  assert.ok(!s.diplomacy.pacified, "sanity: unpacified at the start");
  razeAiCommand(s);
  checkDomination(g);
  assert.equal(s.diplomacy.pacified, true, "the diplomacy-side floor flag is stamped alongside galaxy.pacified");
});

test("a pacified world's stance can never reach war again, however scarce its deposits — and this survives save/load", () => {
  const g = createGalaxy({ seed: 41 });
  const s = activeState(g);
  razeAiCommand(s);
  checkDomination(g);

  // Exactly the scarcity+time the sibling diplomacy.test.js proves drives an UNpacified world to war.
  s.time = 1000; drainNodes(s, 0.05);
  for (let i = 0; i < 4000; i++) updateDiplomacy(s, 0.1);
  assert.ok(atPeace(s), "a pacified world never drifts back to war, however scarce its deposits");
  assert.ok(s.diplomacy.stance > PEACE_THRESHOLD);

  const restored = deserializeGalaxy(JSON.parse(JSON.stringify(serializeGalaxy(g))));
  const rs = activeState(restored);
  assert.equal(rs.diplomacy.pacified, true, "the floor flag survives save/load");
  drainNodes(rs, 0.02);
  for (let i = 0; i < 4000; i++) updateDiplomacy(rs, 0.1);
  assert.ok(atPeace(rs), "…and the floor still holds after a reload, under even deeper scarcity");
});

test("an unpacified world is unaffected: identical scarcity still turns it hostile, and a different world's flag stays unset", () => {
  const g = createGalaxy({ seed: 42 });
  const other = g.planets.get(liveWorld(g));
  const s = activeState(g);
  razeAiCommand(s);
  checkDomination(g);   // pacifies the active seat only

  assert.ok(!other.diplomacy.pacified, "a different, unpacified world's floor flag stays unset");
  other.time = 1000; drainNodes(other, 0.05);
  for (let i = 0; i < 4000; i++) updateDiplomacy(other, 0.1);
  assert.ok(!atPeace(other), "…and it turns hostile from scarcity exactly as it would without this feature");
});

/* ============================================================
   Faction memory: grievances (and goodwill) echo across a faction's worlds
   (docs/improvement-proposals.md 519-527), tuned as ONE system with the floor above.
   ============================================================ */

test("pacifying one faction world echoes a bounded, clamped stance penalty onto its unpacified faction-mates, never onto an already-pacified one or a different faction", () => {
  const g = wakeRoster(createGalaxy({ seed: 43 }));   // faction blocs need the whole roster simulating
  const picked = factionWithAtLeast(g, 3);
  assert.ok(picked, "sanity: the roster has a faction with at least 3 non-active worlds");
  const [aId, bId, cId] = picked.ids;
  const otherEntry = [...worldsByFaction(g)].find(([f]) => f !== picked.faction);
  const otherId = otherEntry[1].find(id => id !== g.activeId);
  assert.ok(otherId, "sanity: a different faction has a non-active world too");

  // c is already pacified before A's echo fires — it must never take a second hit.
  razeAiCommand(g.planets.get(cId));
  checkDomination(g);
  assert.ok(g.pacified.has(cId), "sanity: c is pacified up front");

  const beforeB = g.planets.get(bId).diplomacy.stance;
  const beforeC = g.planets.get(cId).diplomacy.stance;
  const beforeOther = g.planets.get(otherId).diplomacy.stance;

  razeAiCommand(g.planets.get(aId));
  checkDomination(g);   // pacifies A; should echo onto B only
  assert.ok(g.pacified.has(aId));

  const afterB = g.planets.get(bId).diplomacy.stance;
  assert.ok(Math.abs((beforeB - afterB) - FACTION_ECHO_PENALTY) < 1e-9,
    `B (unpacified faction-mate) takes exactly the bounded FACTION_ECHO_PENALTY hit (before ${beforeB}, after ${afterB})`);
  assert.ok(afterB >= -1 && afterB <= 1, "clamped within the stance range");

  assert.equal(g.planets.get(cId).diplomacy.stance, beforeC, "an already-pacified faction-mate is untouched by the echo");
  assert.equal(g.planets.get(otherId).diplomacy.stance, beforeOther, "a different faction's world is untouched");
});

test("an Allied world lifts its faction-mates' diplomacy target a little (updateFactionWarmth)", () => {
  const g = wakeRoster(createGalaxy({ seed: 44 }));
  const g2 = wakeRoster(createGalaxy({ seed: 44 }));   // an identical twin that never gets updateFactionWarmth called on it
  const picked = factionWithAtLeast(g, 2);
  assert.ok(picked, "sanity: a faction with 2+ non-active worlds exists");
  const [allyId, mateId] = picked.ids;

  g.planets.get(allyId).diplomacy.stance = 0.9;   // Allied
  updateFactionWarmth(g);
  assert.ok(g.planets.get(mateId).diplomacy.factionWarmth > 0, "the mate's warmth count reflects its Allied faction-mate");

  const mate = g.planets.get(mateId), mate2 = g2.planets.get(mateId);
  // Full, untouched deposits on both — a clearly cordial target well inside [-1, 1] regardless of
  // which archetype got picked, so the ally lift's small target bump is never swallowed by a clamp
  // (a heavily-drained fixture here can, worst-case archetype composition, push BOTH sides' raw
  // target below -1 via late-game creep, saturating the comparison at an identical -1 for both).
  for (let i = 0; i < 4000; i++) { updateDiplomacy(mate, 0.1); updateDiplomacy(mate2, 0.1); }

  assert.ok(mate.diplomacy.stance > mate2.diplomacy.stance + 1e-6,
    `the Allied faction-mate's lift raises the target (and so the resting stance): with ${mate.diplomacy.stance.toFixed(4)} vs without ${mate2.diplomacy.stance.toFixed(4)}`);
});

test("composition: pacifying A echoes onto B, then pacifying B later still lets the floor win despite the lingering echo, and A never gets a second echo", () => {
  const g = wakeRoster(createGalaxy({ seed: 45 }));
  const picked = factionWithAtLeast(g, 2);
  assert.ok(picked, "sanity: a faction with 2+ non-active worlds exists");
  const [aId, bId] = picked.ids;
  const aState = g.planets.get(aId), bState = g.planets.get(bId);

  // Push B into a real, scarcity-driven war on its own, well before any conquest — past grace,
  // deposits nearly gone (the same proven recipe the sibling diplomacy.test.js uses).
  bState.time = 1000;
  drainNodes(bState, 0.05);
  for (let i = 0; i < 4000; i++) updateDiplomacy(bState, 0.1);
  assert.ok(!atPeace(bState), "sanity: B is genuinely at war from scarcity alone, unpacified");

  // Pacify A: B (unpacified, same faction) takes the echo — a stance hit plus a live
  // reduced-forgiveness recovery window, stamped at B's current (already-past-grace) time.
  razeAiCommand(aState);
  checkDomination(g);
  assert.ok(g.pacified.has(aId));
  assert.ok(bState.diplomacy.factionEchoUntil > bState.time, "B is inside its post-echo recovery window");

  // Now pacify B too, while that window is still live.
  razeAiCommand(bState);
  checkDomination(g);
  assert.ok(g.pacified.has(bId));
  assert.equal(bState.diplomacy.pacified, true, "B's own floor flag is now set");
  assert.ok(bState.time < bState.diplomacy.factionEchoUntil, "sanity: the echo window is still live the moment B is pacified");

  // Deposits stay scarce (the floor must win despite that) and time keeps advancing — some of the
  // recovery happens under the echo's reduced forgiveness, some after the window naturally expires;
  // either way the DESTINATION is the same floored target, so the two mechanisms compose instead of
  // fighting: B eventually settles at peace and STAYS there.
  let reachedPeace = false;
  for (let i = 0; i < 20000 && !reachedPeace; i++) {
    updateDiplomacy(bState, 0.1); bState.time += 0.1;
    if (atPeace(bState)) reachedPeace = true;
  }
  assert.ok(reachedPeace, "the pacified floor eventually wins out over the lingering echo — they compose, not fight");
  for (let i = 0; i < 500; i++) { updateDiplomacy(bState, 0.1); bState.time += 0.1; }
  assert.ok(atPeace(bState), "…and stays at peace afterward — the floor is permanent");

  // A, already pacified when B was pacified, must not have received a second echo from B's own conquest.
  assert.equal(aState.diplomacy.factionEchoUntil, undefined, "an already-pacified faction-mate never receives the echo");
});

/* ============================================================
   Optional (docs/improvement-proposals.md 663): an occupation dividend — pacified worlds pay a
   small credits/min stream, mirroring the existing COLONY_INCOME_PER_BUILDING pattern, so a
   razed-but-unsettled world isn't worth strictly zero.
   ============================================================ */

test("a pacified world pays a small occupation dividend, even with no player buildings there", () => {
  const g = createGalaxy({ seed: 46 });
  const otherId = liveWorld(g);
  const other = g.planets.get(otherId);
  razeAiCommand(other);   // pacify it — the player never founds a colony here
  checkDomination(g);
  assert.ok(g.pacified.has(otherId), "sanity: the world is pacified");
  assert.equal([...other.buildings.values()].filter(b => b.owner === "player").length, 0,
    "sanity: no player buildings on this world at all");

  g.credits = 1000;
  const before = g.credits;
  sweepColonies(g, 10);
  assert.ok(g.credits > before, "a pacified world contributes a small occupation dividend even without a player colony");
});

test("an unpacified background world pays no occupation dividend", () => {
  const g = createGalaxy({ seed: 47 });
  const otherId = liveWorld(g);   // fresh, background, AI foothold intact — not pacified
  g.credits = 1000;
  const before = g.credits;
  sweepColonies(g, 10);
  assert.equal(g.credits, before, "no dividend without pacification, and no player buildings to pay ordinary colony income either");
});
