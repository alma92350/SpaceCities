/* ============================================================
   THE RIVAL GATE (docs/improvement-proposals.md lines 667-675 "the galaxy's strongest faction
   races its own wonder" + lines 689-697 "a fully-teched neighbour races its own Antimatter
   Gate", merged into one feature per the Phase 7 plan). Reconciled trigger: a neighbour that
   has completed the Strategic tier (Antimatter Forge + AI Foundry + Torpedo Works standing —
   antimatter_gate's own `requires`) AND banked a strategic-goods buffer, gated to Hard
   difficulty OR a wantsDeepIndustry temperament (rivalGateEligible/RIVAL_GATE_BUFFER,
   engine/aiIndustry.js) raises and charges its own Antimatter Gate — updateWonder
   (engine/wonder.js) is owner-generic already, so charging needs no special-casing.
   Completion is an 'ascension', never a defeat (engine/victory.js pushes a galaxy event
   instead of finish(); engine/galaxy.js's checkRivalGate applies the consequence: the
   claimed-neighbours burst, the hardEdge upgrade, a permanent stance ceiling, and the
   "rival-gate" milestone). Selection among several simultaneously-eligible worlds reuses
   checkExpansion's own most-developed, tie-by-id idiom.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeBuilding, makeUnit } from "../engine/state.js";
import { tick } from "../engine/sim.js";
import { runAI } from "../engine/ai.js";
import { createGalaxy, activeState, stepGalaxy, checkRivalGate, galaxyStatus } from "../engine/galaxy.js";
import { rivalGateEligible, RIVAL_GATE_BUFFER } from "../engine/aiIndustry.js";
import { checkEndlessWin } from "../engine/victory.js";
import { chargingWonderOf } from "../engine/wonder.js";
import { serializeGalaxy, deserializeGalaxy } from "../engine/persist.js";
import { RIVAL_ASCENSION_STANCE_CEILING } from "../engine/galaxy.js";
import { BUILDINGS } from "../engine/entities.js";
import { PEACE_THRESHOLD, createDiplomacy, updateDiplomacy } from "../engine/diplomacy.js";
import { checkDomination } from "../engine/galaxy.js";
import { liveWorld, liveWorlds } from "./_helpers.js";

// Eliminate the AI's foothold on `state` — its Command Center and its (undeployed) colony ship —
// the same razeAiCommand idiom test/domination.test.js uses, so checkDomination will pacify it.
function razeAiCommand(state) {
  for (const [id, b] of [...state.buildings]) if (b.owner === "ai" && b.type === "command") state.buildings.delete(id);
  for (const [id, u] of [...state.units]) if (u.owner === "ai" && u.type === "colonyship") state.units.delete(id);
}

const GATE = BUILDINGS.antimatter_gate;

// Stock each fed strategic good to `mult` full-charges' worth (mirrors wonder.test.js's own helper).
function stockFeed(res, mult) {
  for (const com in GATE.feed) res[com] = GATE.feed[com] * GATE.chargeTime * mult;
}

// An Odyssey AI base with the whole Strategic tier already standing (Antimatter Forge, AI
// Foundry, Torpedo Works + the Reactor it needs), a real strategic-goods buffer banked, and
// plenty of ore — the "everything but the trigger itself" fixture every eligibility test
// starts from.
function strategicTierBase(planetId, difficulty) {
  const s = createGameState({ planetId, endless: true });
  s.ai.difficulty = difficulty;
  const cc = makeBuilding("command", "ai", 600, 500); s.buildings.set(cc.id, cc);
  const bar = makeBuilding("barracks", "ai", 664, 500); s.buildings.set(bar.id, bar);
  for (let i = 0; i < 5; i++) { const w = makeUnit("worker", "ai", 610 + i * 12, 552); s.units.set(w.id, w); }
  for (const [t, x, y] of [["reactor", 540, 560], ["antimatterforge", 700, 460],
                           ["aifoundry", 700, 560], ["torpedoworks", 800, 460]]) {
    const b = makeBuilding(t, "ai", x, y); s.buildings.set(b.id, b);
  }
  s.players.ai.resources.ore = 6000;
  stockFeed(s.players.ai.resources, 1);   // a full charge's worth banked — well past RIVAL_GATE_BUFFER
  return s;
}

/* ---------- the trigger: rivalGateEligible ---------- */

test("prereqsMet + a banked buffer + Hard difficulty ⇒ eligible", () => {
  const s = strategicTierBase("ferros", "hard");
  assert.ok(rivalGateEligible(s), "Hard, tier standing, buffer banked");
});

test("prereqsMet + a banked buffer + a wantsDeepIndustry temperament (not Hard) ⇒ ALSO eligible", () => {
  const s = strategicTierBase("ferros", "medium");   // ferros -> Economist archetype, wantsRefinery: true
  assert.ok(rivalGateEligible(s), "Medium + wantsDeepIndustry temperament is the OTHER half of the reconciled OR gate");
});

test("Medium + no wantsDeepIndustry temperament, below Hard ⇒ NOT eligible, however the tier got built", () => {
  const s = strategicTierBase("korrath", "medium");   // korrath -> Rusher archetype, no wantsRefinery
  assert.ok(!rivalGateEligible(s), "neither Hard nor a patient temperament — stays an event, not a default");
});

test("no banked buffer ⇒ NOT eligible, even with the whole Strategic tier standing on Hard", () => {
  const s = strategicTierBase("ferros", "hard");
  for (const com in GATE.feed) s.players.ai.resources[com] = 0;
  assert.ok(!rivalGateEligible(s), "the tier alone isn't enough — a real investment must be banked");
});

test("the Strategic tier not yet standing ⇒ NOT eligible, even on Hard with goods in the bank", () => {
  const s = strategicTierBase("ferros", "hard");
  for (const [id, b] of [...s.buildings]) if (b.type === "torpedoworks") s.buildings.delete(id);
  assert.ok(!rivalGateEligible(s), "Torpedo Works missing -> antimatter_gate's own requires aren't met yet");
});

// The Easy strategic ceiling (Phase 7's prerequisite proposal) MUST hold here too — proven, not
// assumed. By construction (engine/aiIndustry.js's sliced INDUSTRY_CHAIN/RESEARCH_ORDER) an Easy
// neighbour can never actually raise the Forge/Foundry/Works in the first place, but this proves
// the trigger itself is ALSO false even when those buildings are force-placed directly (as if the
// ceiling had somehow been bypassed) — a belt-and-suspenders guarantee, not a reliance on the
// chain never reaching that far.
test("an Easy/strategicCeiling neighbour is NEVER eligible, even with the tier force-completed and a banked buffer", () => {
  const s = strategicTierBase("ferros", "easy");
  assert.ok(!rivalGateEligible(s), "strategicCeiling forbids the rival Gate outright, independent of prereqsMet");
});

test("rivalGateEligible is false outside Odyssey (skirmish never builds industry at all)", () => {
  const s = createGameState({ planetId: "ferros", endless: false, difficulty: "hard" });
  assert.ok(!rivalGateEligible(s));
});

/* ---------- aiIndustry.js actually raises the Gate, decision-level (mirrors the rest of
   test/aiIndustry.test.js's own DECISION-level idiom: prereqs pre-set, a handful of think
   cycles, fast and robust to map timing) ---------- */

test("a Hard neighbour past the Strategic tier with goods banked raises its own Antimatter Gate", () => {
  const s = strategicTierBase("ferros", "hard");
  for (let i = 0; i < 10; i++) runAI(s, 1.5);
  const gate = [...s.buildings.values()].find(b => b.owner === "ai" && b.type === "antimatter_gate");
  assert.ok(gate, "the AI founded its own rival Gate");
});

test("a Medium wantsDeepIndustry neighbour ALSO raises one — Hard is not the only path", () => {
  const s = strategicTierBase("ferros", "medium");
  for (let i = 0; i < 10; i++) runAI(s, 1.5);
  const gate = [...s.buildings.values()].find(b => b.owner === "ai" && b.type === "antimatter_gate");
  assert.ok(gate, "wantsDeepIndustry alone is enough, per the reconciled OR trigger");
});

test("a Medium Rusher neighbour (no wantsDeepIndustry, below Hard) never raises a rival Gate", () => {
  const s = strategicTierBase("korrath", "medium");
  for (let i = 0; i < 10; i++) runAI(s, 1.5);
  assert.ok(![...s.buildings.values()].some(b => b.owner === "ai" && b.type === "antimatter_gate"));
});

test("an Easy neighbour never raises a rival Gate, even with the tier force-completed and goods banked", () => {
  const s = strategicTierBase("ferros", "easy");
  for (let i = 0; i < 15; i++) runAI(s, 1.5);
  assert.ok(![...s.buildings.values()].some(b => b.owner === "ai" && b.type === "antimatter_gate"),
    "strategicCeiling holds even with the (otherwise impossible) tier force-placed");
});

/* ---------- charging: deterministic given goods, owner-generic (updateWonder needed no changes) ---------- */

test("an AI-owned rival Gate charges deterministically given goods — two identical runs match exactly", () => {
  const run = () => {
    const s = createGameState({ planetId: "ferros", endless: true });
    const gate = makeBuilding("antimatter_gate", "ai", 660, 520);
    s.buildings.set(gate.id, gate);
    stockFeed(s.players.ai.resources, 1.3);
    for (let i = 0; i < GATE.chargeTime * 5; i++) tick(s, 0.1);
    return gate.charge;
  };
  const a = run(), b = run();
  assert.ok(a > 0, "it actually charged");
  assert.equal(a, b, "same setup, same result — no clock/RNG in the charge path");
});

test("a starved AI-owned Gate never charges — the same stalling rule as the player's", () => {
  const s = createGameState({ planetId: "ferros", endless: true });
  const gate = makeBuilding("antimatter_gate", "ai", 660, 520);
  s.buildings.set(gate.id, gate);
  for (let i = 0; i < 200; i++) tick(s, 0.1);
  assert.equal(gate.charge || 0, 0);
});

/* ---------- razing: stops it, refunds nothing ---------- */

test("razing a mid-charge rival Gate stops it cold — the fed goods it already consumed are never refunded", () => {
  const s = createGameState({ planetId: "ferros", endless: true });
  const gate = makeBuilding("antimatter_gate", "ai", 660, 520);
  s.buildings.set(gate.id, gate);
  stockFeed(s.players.ai.resources, 1.3);
  for (let i = 0; i < 400; i++) tick(s, 0.1);
  const chargedAt = gate.charge;
  const spentAntimatter = s.players.ai.resources.antimatter;
  assert.ok(chargedAt > 0 && chargedAt < 1, "partially charged before razing");
  assert.ok(spentAntimatter < GATE.feed.antimatter * GATE.chargeTime * 1.3, "goods were consumed feeding it");

  s.buildings.delete(gate.id);   // razed — same total-loss rule as the player's own Gate (wonder.js header)
  for (let i = 0; i < 200; i++) tick(s, 0.1);
  assert.equal(s.players.ai.resources.antimatter, spentAntimatter, "no refund of what it already ate");
  assert.ok(!s.over, "razing a rival Gate never ends the game either");
});

/* ---------- completion: an 'ascension', never a defeat ---------- */

test("checkEndlessWin never calls finish() for an AI-owned wonder in a galaxy — it pushes an event instead", () => {
  const s = createGameState({ planetId: "ferros", endless: true });
  s.inGalaxy = true;
  const gate = makeBuilding("antimatter_gate", "ai", 660, 520);
  gate.charge = 1;
  s.buildings.set(gate.id, gate);
  checkEndlessWin(s);
  assert.ok(!s.over, "the play-forever invariant holds even at the galaxy's own endgame bid");
  assert.equal(s.winner, null);
  const ev = s.events.find(e => e.type === "rivalGateComplete");
  assert.ok(ev, "a completion event was pushed for the galaxy layer to consume");
  assert.equal(ev.owner, "ai");
});

test("checkEndlessWin latches the AI-owned completion event — it fires once, not every tick", () => {
  const s = createGameState({ planetId: "ferros", endless: true });
  s.inGalaxy = true;
  const gate = makeBuilding("antimatter_gate", "ai", 660, 520);
  gate.charge = 1;
  s.buildings.set(gate.id, gate);
  checkEndlessWin(s);
  checkEndlessWin(s);
  checkEndlessWin(s);
  const events = s.events.filter(e => e.type === "rivalGateComplete");
  assert.equal(events.length, 1, "latched on the building — a repeat scan is a no-op");
});

test("checkEndlessWin still wins the game outright for a PLAYER-owned wonder OUTSIDE a galaxy — unchanged", () => {
  const s = createGameState({ planetId: "ferros", endless: true });
  const gate = makeBuilding("antimatter_gate", "player", 660, 520);
  gate.charge = 1;
  s.buildings.set(gate.id, gate);
  checkEndlessWin(s);
  assert.ok(s.over && s.winner === "player");
});

/* ---------- the galaxy layer: selection, ascension, milestone, galaxyStatus ---------- */

// A background world seeded with an AI-owned rival Gate (bypassing aiIndustry's own build
// decision — already covered above — to test the galaxy scan's SELECTION/ASCENSION plumbing in
// isolation, the same "decision level" idiom the rest of this suite uses). `devBuildings` extra
// Reactors control aiDevelopment deterministically for the tie-break tests.
function seedRivalGate(galaxy, worldId, { charge = 0.3, devBuildings = 0 } = {}) {
  const s = galaxy.planets.get(worldId);
  const gate = makeBuilding("antimatter_gate", "ai", 700, 500);
  gate.charge = charge;
  s.buildings.set(gate.id, gate);
  for (let i = 0; i < devBuildings; i++) {
    const r = makeBuilding("reactor", "ai", 700 + 40 * (i + 1), 600);
    s.buildings.set(r.id, r);
  }
  return { state: s, gate };
}

test("checkRivalGate tracks the single most-developed qualifying world (checkExpansion's own idiom)", () => {
  const g = createGalaxy({ seed: 21 });
  const others = liveWorlds(g);
  const [lo, hi] = others;
  seedRivalGate(g, lo, { devBuildings: 1 });
  seedRivalGate(g, hi, { devBuildings: 4 });   // strictly more developed
  checkRivalGate(g);
  assert.ok(g.rivalGate, "a candidate was selected");
  assert.equal(g.rivalGate.worldId, hi, "the more-developed world wins, not iteration order");
});

test("checkRivalGate tie-breaks by world id, lowest wins — deterministic, no clock/RNG", () => {
  const g = createGalaxy({ seed: 22 });
  const others = liveWorlds(g).sort();
  const [a, b] = others;
  seedRivalGate(g, a, { devBuildings: 2 });
  seedRivalGate(g, b, { devBuildings: 2 });   // identical development
  checkRivalGate(g);
  assert.equal(g.rivalGate.worldId, a < b ? a : b);
});

test("galaxyStatus surfaces the tracked rival Gate's world and live charge", () => {
  const g = createGalaxy({ seed: 23 });
  const w = liveWorld(g);
  const { gate } = seedRivalGate(g, w, { charge: 0.42 });
  checkRivalGate(g);
  const status = galaxyStatus(g);
  assert.ok(status.rivalGate, "surfaced on the starmap status");
  assert.equal(status.rivalGate.worldId, w);
  assert.ok(Math.abs(status.rivalGate.charge - 0.42) < 1e-9);
  gate.charge = 0.77;
  assert.ok(Math.abs(galaxyStatus(g).rivalGate.charge - 0.77) < 1e-9, "reads the live charge, not a stale snapshot");
});

test("galaxyStatus.rivalGate is null when nothing is charging", () => {
  const g = createGalaxy({ seed: 24 });
  assert.equal(galaxyStatus(g).rivalGate, null);
});

test("razing the tracked rival Gate clears the tracking without any ascension", () => {
  const g = createGalaxy({ seed: 25 });
  const w = liveWorld(g);
  const { state, gate } = seedRivalGate(g, w, { charge: 0.5 });
  checkRivalGate(g);
  assert.equal(g.rivalGate.worldId, w);
  state.buildings.delete(gate.id);   // razed
  checkRivalGate(g);
  assert.equal(g.rivalGate, null, "tracking clears once the building is gone");
  assert.ok(!g.reached.has("rival-gate"), "no ascension for a razed Gate");
});

test("completion fires the 'rival-gate' milestone, applies the ascension consequence, and never sets state.over", () => {
  const g = createGalaxy({ seed: 26 });
  const w = liveWorld(g);
  const { state } = seedRivalGate(g, w, { charge: 1 });   // already complete
  state.diplomacy = createDiplomacy();
  state.diplomacy.stance = 0.5;   // Cordial — the ceiling below must actually pull it down
  checkRivalGate(g);

  assert.ok(g.reached.has("rival-gate"), "milestone fired");
  assert.ok(g.milestones.includes("rival-gate"), "…queued for a firework");
  assert.ok(!activeState(g).over, "the play-forever invariant holds — no defeat, anywhere");

  assert.equal(state.players.ai.upgrades.hardEdge, true, "the ascended world gains the hardEdge upgrade");
  assert.ok(state.diplomacy.stance <= PEACE_THRESHOLD, "a permanent stance ceiling — it can no longer be Cordial/Allied");

  assert.equal(g.claims.get(w), state.players.ai.faction, "the ascending world claims itself too");
  const otherClaims = [...g.claims.entries()].filter(([id]) => id !== w);
  assert.ok(otherClaims.length > 0, "the claims burst reached at least one other unclaimed world");
  assert.ok(otherClaims.every(([, faction]) => faction === state.players.ai.faction), "…all under the ascending faction's colours");
});

test("the ascension's stance ceiling is REAPPLIED every scan — it doesn't erode back up over time", () => {
  const g = createGalaxy({ seed: 27 });
  const w = liveWorld(g);
  const { state } = seedRivalGate(g, w, { charge: 1 });
  state.diplomacy = createDiplomacy();
  checkRivalGate(g);
  assert.ok(state.diplomacy.stance <= PEACE_THRESHOLD);

  state.diplomacy.stance = 0.9;   // simulate something pushing it back up between scans
  checkRivalGate(g);
  assert.ok(state.diplomacy.stance <= PEACE_THRESHOLD, "the ceiling is reasserted, not a one-time snap");
});

test("the milestone fires only once, however many times checkRivalGate re-scans a completed world", () => {
  const g = createGalaxy({ seed: 28 });
  const w = liveWorld(g);
  seedRivalGate(g, w, { charge: 1 });
  checkRivalGate(g);
  const milestonesAfterFirst = g.milestones.length;
  checkRivalGate(g);
  checkRivalGate(g);
  assert.equal(g.milestones.length, milestonesAfterFirst, "idempotent — no repeat fireworks");
});

// CROSS-FEATURE: Domination with teeth (checkDomination/updateDiplomacy) floors a PACIFIED
// world's stance target permanently at Neutral. Rival Gate ascension ceils an ASCENDED world's
// raw stance permanently at PEACE_THRESHOLD, reapplied every scan (see the header comment on
// RIVAL_ASCENSION_STANCE_CEILING). A world that ascends and is LATER personally pacified by the
// player must resolve toward the floor, not stay pinned at the ceiling forever — otherwise
// conquering an ascended neighbour's capital would have no visible effect on its stance, which
// reads as broken to a player who just won that fight. Conquest is the more direct, more recent
// player action, so it wins.
test("pacifying an ALREADY-ASCENDED world lets the pacified floor win — conquest overrides ascension", () => {
  const g = createGalaxy({ seed: 40 });
  const w = liveWorld(g);
  const { state } = seedRivalGate(g, w, { charge: 1 });
  state.diplomacy = createDiplomacy();
  checkRivalGate(g);
  assert.ok(state.diplomacy.stance <= PEACE_THRESHOLD, "sanity: ascended and ceiled, as the earlier test already proves");

  razeAiCommand(state);
  checkDomination(g);
  assert.ok(state.diplomacy.pacified, "sanity: the world is now also pacified");

  // Drift several times, the same way the real background loop would call updateDiplomacy
  // repeatedly — interleaved with re-scans of the (still-ascended) rival-gate ledger, exactly as
  // stepGalaxy's own throttled cadence does both in the same pass.
  for (let i = 0; i < 200; i++) {
    updateDiplomacy(state, 1);
    checkRivalGate(g);
  }
  assert.ok(state.diplomacy.stance > PEACE_THRESHOLD,
    "the pacified floor eventually wins — the stale ascension ceiling must stop being reasserted once conquered");
});

/* ---------- wired into stepGalaxy's throttled scan, end to end ---------- */

test("a full galaxy run: a banked, eligible neighbour raises, charges, and ascends its own Gate over time", () => {
  const g = createGalaxy({ seed: 29 });
  const w = liveWorld(g);
  const s = g.planets.get(w);
  s.ai.difficulty = "hard";
  s.ai.apm = null;   // unthrottled decisions — same fast decision-level idiom test/aiIndustry.test.js
                      // uses throughout; the APM pacing itself is that file's own concern, not this
                      // end-to-end wiring proof's (stepGalaxy -> aiIndustry -> wonder charge ->
                      // checkRivalGate -> milestone, through the REAL background-world schedule).
  s.ai.archetype = { ...s.ai.archetype, wantsRefinery: true };   // a patient developer, regardless
                      // of which world this seed happens to hand us — the archetype temperament
                      // (Rusher vs. Economist) is test/aiIndustry.test.js's own concern, not this
                      // end-to-end wiring proof's.
  const cc = makeBuilding("command", "ai", 600, 500); s.buildings.set(cc.id, cc);
  const bar = makeBuilding("barracks", "ai", 664, 500); s.buildings.set(bar.id, bar);
  for (let i = 0; i < 5; i++) { const wk = makeUnit("worker", "ai", 610 + i * 12, 552); s.units.set(wk.id, wk); }
  for (const [t, x, y] of [["reactor", 540, 560], ["antimatterforge", 700, 460],
                           ["aifoundry", 700, 560], ["torpedoworks", 800, 460]]) {
    const b = makeBuilding(t, "ai", x, y); s.buildings.set(b.id, b);
  }
  s.players.ai.resources.ore = 6000;
  stockFeed(s.players.ai.resources, 3);   // enough banked to both found AND fully charge the Gate

  for (let i = 0; i < GATE.chargeTime * 40 && !g.reached.has("rival-gate"); i++) stepGalaxy(g, 0.1);

  assert.ok(g.reached.has("rival-gate"), "the whole pipeline ran: eligible -> built -> charged -> ascended");
  assert.ok(!activeState(g).over, "never a defeat for the player");
});

/* ---- A5: the ascension must survive a save/load ---------------------------------------------
   galaxy.rivalAscended is the idempotency latch the code names as such — but it was never written
   to the payload (zero hits in engine/persist.js, and zero across test/). Continuing a campaign
   therefore dropped it, which costs the "permanent" stance ceiling once the Gate is gone and
   re-fires the ascension event on every reload. Autosave runs every 12 s. */

test("an ascension survives a save/load — the permanent stance ceiling still applies after the Gate is razed", () => {
  const g = createGalaxy({ seed: 4242 });
  const worldId = liveWorld(g);
  const st = g.planets.get(worldId);
  const gate = makeBuilding("antimatter_gate", "ai", 700, 500);
  gate.charge = 1;
  gate.constructing = false;
  st.buildings.set(gate.id, gate);
  checkRivalGate(g);
  assert.ok(g.rivalAscended && g.rivalAscended.has(worldId), "fixture sanity: the world ascended");

  st.buildings.delete(gate.id);                       // the Gate is later razed
  const g2 = deserializeGalaxy(serializeGalaxy(g));
  assert.ok(g2.rivalAscended && g2.rivalAscended.has(worldId),
    "the ascension latch must survive the save — without it the ceiling can never be re-applied, " +
    "because checkRivalGate can only re-latch by finding a completed Gate that no longer exists");

  const st2 = g2.planets.get(worldId);
  st2.diplomacy.stance = 0.9;
  checkRivalGate(g2);
  assert.ok(st2.diplomacy.stance <= RIVAL_ASCENSION_STANCE_CEILING,
    `the permanent stance ceiling must still be enforced after a reload, got ${st2.diplomacy.stance}`);
});

test("the ascension event does not re-fire on every reload (A5)", () => {
  const g = createGalaxy({ seed: 4243 });
  const worldId = liveWorld(g);
  const st = g.planets.get(worldId);
  const gate = makeBuilding("antimatter_gate", "ai", 700, 500);
  gate.charge = 1;
  gate.constructing = false;
  st.buildings.set(gate.id, gate);
  checkRivalGate(g);
  const before = (g.rivalGateNotes || []).filter(n => n.type === "ascended").length;
  assert.equal(before, 1, "fixture sanity: the ascension announced itself once");

  const g2 = deserializeGalaxy(serializeGalaxy(g));
  checkRivalGate(g2);
  assert.equal((g2.rivalGateNotes || []).filter(n => n.type === "ascended").length, 0,
    "a reload must not replay an ascension the player was already told about");
});
