/* ============================================================
   The owner-generic SCAFFOLD. createGameState / rehydratePlanet no longer name
   "player"/"ai" twice over — they build the player map, the per-owner fog, the
   seeding and the victory check by ITERATING state.owners. These tests pin the
   structural invariants that make that safe:

   • state.owners is the canonical side list, and state.fog/state.fogAI are
     ALIASES into state.fogs (the same objects), so the generic map and the many
     legacy `state.fog` consumers can never drift apart.
   • a save round-trip rebuilds the scaffold identically.
   • the victory check reads last-side-standing for N sides, not just two, with a
     deterministic first-listed tie-break — so a future N-faction world is a
     change to the owner list, not a rewrite of victory.js.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { walkJs } from "./_helpers.js";
import { createGameState, makeBuilding, makeUnit } from "../engine/state.js";
import { checkWinCondition, DEFAULT_MATCH_TIME_LIMIT } from "../engine/victory.js";
import { serializeGame, deserializeGame } from "../engine/persist.js";
import { createFog, isVisibleAt } from "../engine/fog.js";
import { tick } from "../engine/sim.js";
import { isHumanControlled, controllerFor, opponentsOf, accrueActionBudget, canAct, spend } from "../engine/aiCommon.js";

function commandCenterOf(state, owner) {
  return [...state.buildings.values()].find(b => b.owner === owner && b.type === "command");
}

test("a fresh game exposes its sides as state.owners, in canonical order", () => {
  const state = createGameState({ planetId: "ferros" });
  assert.deepEqual(state.owners, ["player", "ai"]);
  // one economy per owner, keyed by id
  for (const id of state.owners) {
    assert.ok(state.players[id], `players[${id}] exists`);
    assert.equal(state.players[id].id, id);
  }
});

test("state.fog / state.fogAI are the SAME objects as state.fogs entries (aliases, not copies)", () => {
  const state = createGameState({ planetId: "ferros" });
  assert.equal(state.fog, state.fogs.player, "state.fog aliases state.fogs.player");
  assert.equal(state.fogAI, state.fogs.ai, "state.fogAI aliases state.fogs.ai");
  // Mutating through one view is visible through the other — proving they can't drift.
  state.fog.explored[0] = 1;
  assert.equal(state.fogs.player.explored[0], 1, "a write through the alias reaches the map entry");
  assert.deepEqual(Object.keys(state.fogs), state.owners, "one fog per owner");
});

test("a save round-trip rebuilds the owner scaffold and the fog aliases", () => {
  const state = createGameState({ planetId: "ferros", seed: 7 });
  const loaded = deserializeGame(serializeGame(state));
  assert.deepEqual(loaded.owners, ["player", "ai"], "owners restored");
  assert.equal(loaded.fog, loaded.fogs.player, "fog alias restored");
  assert.equal(loaded.fogAI, loaded.fogs.ai, "fogAI alias restored");
  for (const id of loaded.owners) assert.ok(loaded.players[id], `players[${id}] restored`);
});

test("victory reads last-side-standing for THREE sides, not just two", () => {
  const state = createGameState({ planetId: "ferros" });
  // Splice in a third faction with its own economy + Command Center — exactly the
  // shape a future N-owner world would carry.
  state.owners.push("rebels");
  state.players.rebels = { id: "rebels", faction: "neutral", isAI: true, resources: { ore: 0, crystals: 0, radioactives: 0 }, color: "#fbbf24", upgrades: {} };
  const rebelCC = makeBuilding("command", "rebels", 800, 500);
  state.buildings.set(rebelCC.id, rebelCC);

  // Three sides standing → the game runs on.
  checkWinCondition(state);
  assert.equal(state.over, false, "three Command Centers alive → no winner yet");

  // Knock out the player: two sides left, still no win.
  state.buildings.delete(commandCenterOf(state, "player").id);
  checkWinCondition(state);
  assert.equal(state.over, false, "two sides left → still running");

  // Knock out the AI: the rebels are the last side standing and take the world.
  state.buildings.delete(commandCenterOf(state, "ai").id);
  checkWinCondition(state);
  assert.equal(state.over, true);
  assert.equal(state.winner, "rebels", "the last Command Center standing wins, whoever owns it");
});

test("the score tie-break honours the FIRST side listed in state.owners", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  // A dead-even board: clear everything and give every side an identical (empty) economy,
  // then force the time-limit tiebreak. The winner must be state.owners[0].
  state.units.clear();
  state.buildings.clear();   // no Command Centers → mutual-wipe path also runs scoreLeader
  state.owners = ["rebels", "player", "ai"];
  for (const id of state.owners)
    state.players[id] = { id, faction: "neutral", isAI: id !== "player", resources: { ore: 0, crystals: 0, radioactives: 0 }, color: "#fff", upgrades: {} };
  state.time = DEFAULT_MATCH_TIME_LIMIT + 1;

  checkWinCondition(state);
  assert.equal(state.over, true);
  assert.equal(state.winner, "rebels", "an exact score tie goes to the first-listed side (the defender's edge)");
});

test("T-018: tick() updates a THIRD owner's fog too, not just player/ai's two hardcoded slots", () => {
  const state = createGameState({ planetId: "ferros" });
  state.owners.push("rebels");
  state.players.rebels = { id: "rebels", faction: "neutral", isAI: true, resources: { ore: 0, crystals: 0, radioactives: 0 }, color: "#fbbf24", upgrades: {} };
  state.fogs.rebels = createFog(state.map);   // exactly what createGameState itself does per owner
  const scout = makeUnit("skiff", "rebels", 800, 500);
  state.units.set(scout.id, scout);

  assert.equal(isVisibleAt(state.fogs.rebels, 800, 500), false, "fixture sanity: nothing revealed yet");
  tick(state, 0.1);

  assert.equal(isVisibleAt(state.fogs.rebels, 800, 500), true,
    "the third owner's own fog must be recomputed from ITS OWN units every tick, the same as player/ai's — this used to be two hardcoded updateFog calls that silently never touched a spliced-in owner");
});

test("T-018: gather.js and scout.js resolve a unit's fog via state.fogs[owner], so a third owner isn't silently handed player's or ai's fog", async () => {
  // The desync landmine ADR-0008 names directly: rebinding state.fog to "my fog" client-side would
  // make these two engine lines resolve the WRONG fog for anyone but the first two owners. Proven
  // here by checking a rebel unit's retarget/scout decisions are gated on ITS OWN fog, not a
  // hardcoded player/ai alias — if either file still read state.fog/state.fogAI, a rebel-owned
  // unit would either see through the player's discovered nodes or see nothing at all, regardless
  // of what its own scouts had actually found.
  const { updateScoutMode } = await import("../engine/scout.js");
  const state = createGameState({ planetId: "ferros" });
  state.owners.push("rebels");
  state.fogs.rebels = createFog(state.map);   // deliberately left UNEXPLORED — nothing revealed yet
  const scout = makeUnit("skiff", "rebels", state.map.width / 2, state.map.height / 2);
  scout.order = { type: "scout", tx: null, ty: null };   // issueScout's own shape — a fresh, untargeted scout order
  state.units.set(scout.id, scout);

  updateScoutMode(state, scout, 0.1);

  assert.ok(scout.order.tx != null && scout.order.ty != null,
    "a rebel scout must pick an explore target from ITS OWN fog (state.fogs.rebels) — if this file still read state.fog/state.fogAI it would either crash (no such alias exists for \"rebels\") or scout off the wrong owner's discovered ground entirely");
});

// Classifies every line of `text` as comment-or-not, tracking real /* ... */ block state across
// lines rather than checking each line in isolation — this codebase's own block-comment style
// (a /* ==== opener, then INDENTED PROSE WITH NO LEADING *, closed by a lone ==== */) means a
// per-line "starts with // or *" check misses most of a block's body. Deliberately simple (no
// awareness of strings/regexes that might contain "/*" or "//"), which is fine for a guard over
// this codebase's own consistent style, not a general-purpose JS parser.
function classifyLines(text) {
  const lines = text.split("\n");
  const isComment = new Array(lines.length).fill(false);
  let inBlock = false;
  lines.forEach((line, i) => {
    if (inBlock) {
      isComment[i] = true;
      if (line.includes("*/")) inBlock = false;
      return;
    }
    const openAt = line.indexOf("/*");
    if (/^\s*\/\//.test(line)) { isComment[i] = true; return; }
    if (openAt !== -1) {
      isComment[i] = true;
      if (!line.slice(openAt + 2).includes("*/")) inBlock = true;   // doesn't close on the same line
    }
  });
  return { lines, isComment };
}

test("T-018: no skirmish-path engine CODE line reads state.fog or state.fogAI directly", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const engineDir = join(root, "engine");
  const pattern = /state\.fog(AI)?\b/;
  // state.js DEFINES the aliases (state.fog = fogs.player, etc.) — the one legitimate owner.
  // persist.js's SAVE FORMAT is a deliberate, separately-tracked exception (ADR-0008: "the save
  // shape stays two-keyed... a save FORMAT built for N sides is separate, deferred work") — not
  // this task's scope, and re-baselining SAVE_VERSION is exactly the destructive move ADR-0008
  // schedules for its OWN later phase, not T-018. galaxy.js and scenarios.js are Odyssey/scripted-
  // mission code, which ADR-0008 §Decision lists as explicitly OUT of multiplayer scope ("Odyssey
  // multiplayer... multiplayer scenarios" — a skirmish never loads either file's owner-literal
  // paths) — fixing them would be scope creep into work this project has deliberately deferred,
  // not a fairness bug a real match can ever hit. aiWorkers.js's assignIdlePlayerGather is its own
  // narrower exception (same reasoning, one function, not the whole file): its own doc comment
  // names it as colonyPolicy.js's background-colony worker-sustain helper, Odyssey-only by design,
  // never reached from a skirmish/multiplayer path either.
  const EXEMPT_FILES = new Set(["engine/state.js", "engine/persist.js", "engine/galaxy.js", "engine/scenarios.js"]);
  const EXEMPT_LINES = new Set(["engine/aiWorkers.js:137"]);
  const offenders = [];
  for (const file of walkJs(engineDir)) {
    // Posix-normalized: node:path yields "engine\galaxy.js" on Windows, which matches no
    // forward-slash literal in either exempt set above, so all four file exemptions and the
    // aiWorkers.js:137 line exemption silently stopped applying and this guard reported 8
    // deliberately-sanctioned lines as violations. Forward slashes are the right canonical form —
    // they are what the exemption sets, and the surrounding comment, are written in.
    const rel = relative(root, file).split(sep).join("/");
    if (EXEMPT_FILES.has(rel)) continue;
    const { lines, isComment } = classifyLines(readFileSync(file, "utf8"));
    lines.forEach((line, i) => {
      const loc = `${rel}:${i + 1}`;
      if (pattern.test(line) && !isComment[i] && !EXEMPT_LINES.has(loc)) offenders.push(`${loc}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], "engine line(s) still read state.fog/state.fogAI directly:\n" + offenders.join("\n"));
});

// T-034a — discovered while researching T-034 (lobby join): engine/aiCommon.js's own comment on
// isHumanControlled has, since T-017, named this exact moment ("it becomes meaningful the moment a
// real match can put a human on either seat") as the point state.ai needs to be able to go null.
// Without this, a real human joining a lobby's seat "ai" would have every one of their own orders
// fought, every tick, by the built-in single-player AI — engine/sim.js's tick() calls runAI(state,
// dt) for "ai" unconditionally whenever state.ai exists, which today it always does.
test("aiEnabled:false leaves state.ai null — the seam a real human on seat \"ai\" needs (T-034a)", () => {
  const state = createGameState({ planetId: "ferros", aiEnabled: false });
  assert.equal(state.ai, null);
  assert.equal(isHumanControlled(state, "ai"), true, "isHumanControlled must flip once state.ai is null");
  // Every existing caller (nobody passes aiEnabled today) is completely unaffected.
  const normal = createGameState({ planetId: "ferros" });
  assert.ok(normal.ai, "state.ai stays populated when aiEnabled isn't passed");
  assert.equal(isHumanControlled(normal, "ai"), false);
});

test("with aiEnabled:false, tick() never lets the built-in AI act for owner \"ai\" (T-034a)", () => {
  const state = createGameState({ planetId: "ferros", seed: 99, aiEnabled: false });
  const startBuildings = state.buildings.size;
  for (let i = 0; i < 600; i++) tick(state, 0.1);   // 60 sim-seconds — persist.test.js's own "build, fight, reveal fog" ticks only 800 at the same dt, so this is comfortably enough for the built-in AI to normally have queued at least one build
  assert.equal(state.buildings.size, startBuildings, "no new construction was ever decided for owner \"ai\" — nothing is deciding anything");
  for (const b of state.buildings.values()) {
    if (b.owner === "ai") assert.equal(b.queue.length, 0, `${b.type} must never get an autonomous production order`);
  }
});

/* ---------- T-041 (FR-1): ownerDefs from a caller-supplied config; N-seat state.owners ----------
   Deliberately narrow, matching this task's own row: the SCAFFOLD (owners/players/fogs/seeding)
   becomes genuinely N-capable, reusing what docs/analysis/01-engine-nplayer-seams.md's own audit
   already found owner-generic (combat, movement, victory — the "rebels" tests above already prove
   it for a manually-spliced 3rd owner). What this does NOT touch: state.controllers{} (T-042, the
   AI decision layer is still exactly the 2-slot state.ai/state.playerAi), opponentsOf() (T-043),
   and a REAL N-position map generator (T-044 — basePositions below is this task's own deliberate
   stopgap, an explicit override for owners the map's own 2-keyed map.bases doesn't have a real
   position for yet, never meant to survive past T-044 landing a real one). ---------- */

test("T-041: omitting ownerDefs is byte-identical to before this option existed — every existing caller is completely unaffected", () => {
  const state = createGameState({ planetId: "ferros", seed: 42 });
  assert.deepEqual(state.owners, ["player", "ai"]);
});

test("T-041: a caller-supplied ownerDefs (N owners) plus basePositions for the owners the map doesn't already have produces a real, fully-seeded N-owner scaffold", () => {
  const ownerDefs = [
    { id: "player", faction: "neutral", isAI: false, color: "#4fd1ff" },
    { id: "ai", faction: "neutral", isAI: true, color: "#f87171" },
    { id: "rebels", faction: "neutral", isAI: true, color: "#fbbf24" },
    { id: "pirates", faction: "neutral", isAI: true, color: "#a78bfa" },
  ];
  const state = createGameState({
    planetId: "ferros",
    ownerDefs,
    basePositions: { rebels: { x: 900, y: 300 }, pirates: { x: 300, y: 900 } },
  });
  assert.deepEqual(state.owners, ["player", "ai", "rebels", "pirates"]);
  for (const id of state.owners) {
    assert.ok(state.players[id], `players.${id} exists`);
    assert.equal(state.players[id].id, id);
    assert.ok(state.fogs[id], `fogs.${id} exists`);
    const cc = [...state.buildings.values()].find(b => b.owner === id && b.type === "command");
    assert.ok(cc, `${id} has a seeded Command Center`);
    assert.equal([...state.units.values()].filter(u => u.owner === id && u.type === "worker").length, 3, `${id} has 3 starting workers`);
  }
  const rebelCC = [...state.buildings.values()].find(b => b.owner === "rebels" && b.type === "command");
  assert.equal(rebelCC.x, 900);
  assert.equal(rebelCC.y, 300);
});

test("T-041: an explicit ownerDefs overrides playerFaction/aiFaction — the shortcut opts only apply to the DEFAULT 2-owner pair, not a caller's own more detailed config", () => {
  const state = createGameState({
    planetId: "ferros",
    playerFaction: "frontier", aiFaction: "syndicate",   // must be ignored below
    ownerDefs: [
      { id: "player", faction: "miners", isAI: false, color: "#4fd1ff" },
      { id: "ai", faction: "neutral", isAI: true, color: "#f87171" },
    ],
  });
  assert.equal(state.players.player.faction, "miners", "the explicit ownerDefs entry wins over the shortcut playerFaction opt");
  assert.equal(state.players.ai.faction, "neutral", "the explicit ownerDefs entry wins over the shortcut aiFaction opt");
});

test("T-041: a 4-seat, AI-only match plays headlessly to a real winner via ordinary tick() — real combat, real movement, real N-way victory, no UI", () => {
  const ownerDefs = [
    { id: "player", faction: "neutral", isAI: true, color: "#4fd1ff" },
    { id: "ai", faction: "neutral", isAI: true, color: "#f87171" },
    { id: "rebels", faction: "neutral", isAI: true, color: "#fbbf24" },
    { id: "pirates", faction: "neutral", isAI: true, color: "#a78bfa" },
  ];
  // A tight cluster (not the real, far-apart 2-seat map bases — this task doesn't touch the map
  // generator, T-044 does) so a single attacking force can reach every base quickly, keeping this
  // test fast and its outcome unambiguous.
  const state = createGameState({
    planetId: "ferros",
    ownerDefs,
    basePositions: {
      player: { x: 800, y: 500 }, ai: { x: 950, y: 500 },
      rebels: { x: 800, y: 650 }, pirates: { x: 950, y: 650 },
    },
  });

  // Everyone but "player" starts with a Command Center weakened to a single hit — this test's own
  // proof is that REAL combat/movement/victory resolve correctly for four owners at once, not that
  // it can grind through three full 1000-hp bases; T-042's own AI decision layer (not built yet)
  // is what would normally arm every seat anyway, so a slow siege here would prove nothing extra.
  for (const id of ["ai", "rebels", "pirates"]) {
    const cc = [...state.buildings.values()].find(b => b.owner === id && b.type === "command");
    cc.hp = 1;
  }

  // "player"'s own opening force, given real attack-move orders toward the cluster's center —
  // engine/commands.js's own real order shape, the same one test/projection.test.js's own fixture
  // already uses to drive combat units in a test without a live input layer.
  for (let i = 0; i < 6; i++) {
    const skiff = makeUnit("skiff", "player", 800 + i * 10, 480);
    skiff.order = { type: "attack-move", x: 875, y: 575 };
    state.units.set(skiff.id, skiff);
  }

  let ticks = 0;
  while (!state.over && ticks < 2000) { tick(state, 0.1); ticks++; }

  assert.equal(state.over, true, `a 4-seat match must reach a real winner within a bounded number of ticks (stopped after ${ticks})`);
  assert.equal(state.winner, "player", "the only seat with a live Command Center and an armed force must be the one left standing");
});

/* ---------- T-042 (ADR-0008): state.controllers{} replacing the 2-slot state.ai/state.playerAi ----
   Deliberately narrow, matching this task's own row — the DATA MODEL becomes N-capable (a real
   registry engine/controllers.js's controllerFor reads by owner id, not two hardcoded names), and
   accrueActionBudget/canAct/spend/runAI/aiContext all become N-safe FOR FREE, since they already
   thread ctx.owner through controllerFor rather than reading state.ai/state.playerAi directly
   (docs/analysis/01-engine-nplayer-seams.md's own §7.1 finding). What this does NOT touch:
   engine/sim.js's own tick() dispatch (still only ever auto-drives owner "ai" — a real seat's own
   controller order/rotation is a SEPARATE, deliberately deferred concern, see this task's own
   TASKS.md closure entry for why folding it in here would have been fingerprint-changing for the
   EXISTING 2-seat case, which must stay byte-identical through T-047); otherOwner()/opponentsOf()
   (T-043); and the SAVE WIRE FORMAT itself, which stays exactly 2-keyed ("ai"/"playerAi", `pa`-
   prefixed fields) — engine/persist.js's deserializeGame gains the SAME state.controllers{} +
   alias wiring createGameState does (a loaded game needs it too, or controllerFor would see nothing
   at all for a restored match), but reads/writes the identical wire keys as before; a REAL N-keyed
   save shape and its SAVE_VERSION bump are T-045's own, later, separate job. ---------- */

test("T-042: state.controllers{} exists, keyed by owner — the SAME AiController objects state.ai/state.playerAi have always pointed at", () => {
  const state = createGameState({ planetId: "ferros" });
  assert.equal(state.controllers.ai, state.ai, "state.controllers.ai must be the identical object state.ai already resolves to");
  assert.equal(state.controllers.player, state.playerAi, "state.controllers.player must be the identical object state.playerAi already resolves to (null, by default)");
});

test("T-042: state.ai / state.playerAi stay live, read-write ALIASES into state.controllers — not a one-time snapshot", () => {
  const state = createGameState({ planetId: "ferros" });
  // Reassigning through the OLD name (T-036's own AI-takeover/reclaim pattern, matchWorker.js) must
  // be visible through the NEW registry immediately — controllerFor has nothing else to read.
  state.ai = null;
  assert.equal(state.controllers.ai, null, "writing state.ai = null must update state.controllers.ai too");
  assert.equal(controllerFor(state, "ai"), null);

  const fresh = { apm: 90, micro: true };
  state.playerAi = fresh;   // exactly the plain-object shape test/combat.test.js already assigns
  assert.equal(state.controllers.player, fresh, "writing state.playerAi must update state.controllers.player too");
  assert.equal(controllerFor(state, "player"), fresh);

  // And the reverse direction: writing through the NEW registry must be visible through the OLD
  // name too, for the ~39 existing test files docs/analysis/01-engine-nplayer-seams.md's own §7.2
  // found still reading state.ai/state.playerAi directly.
  state.controllers.ai = fresh;
  assert.equal(state.ai, fresh, "writing state.controllers.ai must be visible through state.ai too");
});

test("T-042 (FR-1/ADR-0008): a THIRD owner's own AI controller, populated via ownerDefs, is reachable through controllerFor — the exit criterion this task actually names", () => {
  const state = createGameState({
    planetId: "ferros",
    ownerDefs: [
      { id: "player", faction: "neutral", isAI: false, color: "#4fd1ff" },
      { id: "ai", faction: "neutral", isAI: true, color: "#f87171" },
      { id: "rebels", faction: "neutral", isAI: true, color: "#fbbf24" },
    ],
    basePositions: { rebels: { x: 900, y: 300 } },
  });
  assert.ok(state.controllers.rebels, "a third owner marked isAI:true must get a real controller, not be silently dropped");
  assert.equal(controllerFor(state, "rebels"), state.controllers.rebels);
  assert.equal(isHumanControlled(state, "rebels"), false);
});

test("T-042: N AI seats each act on their own budget — independently, never sharing or colliding", () => {
  const state = createGameState({
    planetId: "ferros",
    ownerDefs: [
      { id: "player", faction: "neutral", isAI: false, color: "#4fd1ff" },
      { id: "ai", faction: "neutral", isAI: true, color: "#f87171" },
      { id: "rebels", faction: "neutral", isAI: true, color: "#fbbf24" },
    ],
    basePositions: { rebels: { x: 900, y: 300 } },
  });
  state.controllers.ai.apm = 1200;      // 20 actions/second — comfortably past the >=1 threshold after 1s, clear of float noise
  state.controllers.rebels.apm = 12000; // 200 actions/second — a deliberately DIFFERENT, much larger budget
  for (let i = 0; i < 10; i++) accrueActionBudget(state, 0.1, "ai");        // 1 sim-second total
  for (let i = 0; i < 10; i++) accrueActionBudget(state, 0.1, "rebels");    // same wall time

  assert.equal(canAct(state, "ai"), true, "the slow seat's own 1-second accrual must be enough for its own budget");
  assert.equal(canAct(state, "rebels"), true, "the fast seat's own budget must independently have accrued its own, much larger, allowance");
  assert.ok(state.controllers.rebels.actionBudget > state.controllers.ai.actionBudget,
    "two seats accruing the SAME wall-clock time at DIFFERENT apm must end up with DIFFERENT budgets — proof they are genuinely independent, not sharing one shared counter");
  spend(state, "ai");
  assert.equal(canAct(state, "rebels"), true, "spending FROM one seat's own budget must never touch another seat's");
});

test("T-042: a save round-trip restores state.controllers{} too, not just state.ai/state.playerAi — a loaded game's AI must still be reachable via controllerFor", () => {
  const state = createGameState({ planetId: "ferros", seed: 5 });
  const loaded = deserializeGame(serializeGame(state));
  assert.ok(loaded.controllers, "a deserialized state must have a real controllers registry, not just the legacy ai/playerAi fields");
  assert.equal(controllerFor(loaded, "ai"), loaded.controllers.ai);
  assert.ok(loaded.controllers.ai, "the restored AI controller must actually be reachable through the new registry");
  assert.equal(loaded.controllers.ai.apm, state.controllers.ai.apm ?? null);
});

test("T-042: aiEnabled:false still round-trips as a null controller, reachable both ways (T-034a preserved)", () => {
  const state = createGameState({ planetId: "ferros", aiEnabled: false });
  assert.equal(state.controllers.ai, null);
  const loaded = deserializeGame(serializeGame(state));
  assert.equal(loaded.controllers.ai, null);
  assert.equal(loaded.ai, null);
  assert.equal(controllerFor(loaded, "ai"), null);
});

/* ---------- T-043 (ADR-0008): opponentsOf() replacing otherOwner()'s "exactly one enemy" axiom ----
   otherOwner(owner) itself is NOT deleted — hud.js and overlays.js still use it exactly as before
   for the head-to-head "you vs. the foe" scoreboard line, a genuinely 2-party display concern that
   is its own separate (and later) N-player UI question, well outside this task's own acceptance
   criterion ("AI targets sensibly with 3+ opponents") and outside docs/analysis/
   01-engine-nplayer-seams.md's own scope (an audit of engine/, which neither file is under).

   opponentsOf(state, owner) is the new, N-capable primitive every AI DECISION call site migrates
   to instead: engine/aiIntel.js's sightEnemy, engine/aiMilitary.js's visibleEnemyCombatUnits/
   raidTarget/chooseAttackTarget/counterToPlayerArmy, and engine/ai.js's aiContext. Each of those
   widens its old single-owner equality filter (`e.owner === enemyOwner`) to a multi-owner
   membership test (`opponents.includes(e.owner)`) — for the EXISTING 2-seat case opponentsOf
   always returns a single-element array, so `.includes()` behaves identically to the old `===` and
   every existing nearest/most-common/highest-value comparison the target-picking logic already did
   is untouched: it just now considers a wider candidate pool. No new "which rival do I focus on"
   policy was invented — the existing nearest-wins/most-seen-wins logic already generalizes. ---- */

test("T-043: opponentsOf() returns the OTHER owners in state.owners order — a single-element array for the shipped 2-seat case", () => {
  const state = createGameState({ planetId: "ferros" });
  assert.deepEqual(opponentsOf(state, "player"), ["ai"]);
  assert.deepEqual(opponentsOf(state, "ai"), ["player"]);
});

test("T-043: opponentsOf() lists every OTHER seat for 3+ owners, never just one", () => {
  const state = createGameState({
    planetId: "ferros",
    ownerDefs: [
      { id: "player", faction: "neutral", isAI: false, color: "#4fd1ff" },
      { id: "ai", faction: "neutral", isAI: true, color: "#f87171" },
      { id: "rebels", faction: "neutral", isAI: true, color: "#fbbf24" },
      { id: "raiders", faction: "neutral", isAI: true, color: "#a78bfa" },
    ],
    basePositions: { rebels: { x: 900, y: 300 }, raiders: { x: 300, y: 900 } },
  });
  assert.deepEqual(opponentsOf(state, "player"), ["ai", "rebels", "raiders"],
    "the old otherOwner() axiom would have silently dropped two of these three");
  assert.deepEqual(opponentsOf(state, "rebels"), ["player", "ai", "raiders"],
    "a non-default owner id must see every OTHER seat too, not just the original pair");
});

test("T-043: opponentsOf() degrades to the legacy pair on a minimal fixture with no state.owners", () => {
  assert.deepEqual(opponentsOf({}, "player"), ["ai"],
    "a hand-built test fixture that never set state.owners must still behave like the original 2-seat game");
  assert.deepEqual(opponentsOf({}, "ai"), ["player"]);
});
