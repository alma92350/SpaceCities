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
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { walkJs } from "./_helpers.js";
import { createGameState, makeBuilding, makeUnit } from "../engine/state.js";
import { checkWinCondition, DEFAULT_MATCH_TIME_LIMIT } from "../engine/victory.js";
import { serializeGame, deserializeGame } from "../engine/persist.js";
import { createFog, isVisibleAt } from "../engine/fog.js";
import { tick } from "../engine/sim.js";

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
    const rel = relative(root, file);
    if (EXEMPT_FILES.has(rel)) continue;
    const { lines, isComment } = classifyLines(readFileSync(file, "utf8"));
    lines.forEach((line, i) => {
      const loc = `${rel}:${i + 1}`;
      if (pattern.test(line) && !isComment[i] && !EXEMPT_LINES.has(loc)) offenders.push(`${loc}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], "engine line(s) still read state.fog/state.fogAI directly:\n" + offenders.join("\n"));
});
