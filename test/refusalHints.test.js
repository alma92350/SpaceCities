/* ============================================================
   net/refusalHints.js — every rejection a caller can get back says WHAT to do about it, not
   just that it happened. The failure this closes is specific and was observable in real agent
   play: a tool result of `refused (prereq-not-met)` names no building, so the agent's next move
   is a guess and usually a verbatim re-send of the same command. These tests pin the parts of
   each hint that carry the action — the missing building's NAME, the commodity and the amount
   short, "Habitat" for a supply cap — rather than the whole sentence, so the wording stays free
   to improve without a test rewrite.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState } from "../engine/state.js";
import { mulberry32 } from "../engine/rng.js";
import { apply, REJECT } from "../net/commandCodec.js";
import { hintForCode } from "../net/refusalHints.js";
import { makeBuilding } from "../engine/state.js";

const makeState = (seed = 4242) => createGameState({ planetId: "ferros", seed, rng: mulberry32(seed) });

const findBuilding = (state, owner, type) =>
  [...state.buildings.values()].find(b => b.owner === owner && b.type === type);
const playerWorker = state => [...state.units.values()].find(u => u.owner === "player" && u.type === "worker");

/* ---------- the REFUSED reasons: the cause, named ---------- */

test("prereq-not-met names the building that is missing — the case an agent cannot guess", () => {
  const state = makeState();
  const worker = playerWorker(state);
  state.players.player.resources.ore = 10000;

  // The Foundry requires a completed Barracks (engine/entities.js). Nothing is built yet.
  const r = apply(state, "player", { t: "build", worker: worker.id, b: "foundry", x: worker.x + 220, y: worker.y + 220 });
  assert.equal(r.code, REJECT.REFUSED);
  assert.equal(r.reason, "prereq-not-met", "the machine-readable pair is unchanged");
  assert.match(r.hint, /Barracks/, "the hint must name WHICH prerequisite is missing");
  assert.match(r.hint, /FINISH|completed/, "…and that a site still under construction does not count");
});

test("cannot-afford names the commodity and how much is short, for a build and for production alike", () => {
  const state = makeState();
  const worker = playerWorker(state);
  const cc = findBuilding(state, "player", "command");
  for (const com of Object.keys(state.players.player.resources)) state.players.player.resources[com] = 0;
  state.players.player.resources.ore = 20;

  const build = apply(state, "player", { t: "build", worker: worker.id, b: "barracks", x: worker.x + 220, y: worker.y + 220 });
  assert.equal(build.reason, "cannot-afford");
  assert.match(build.hint, /Ore/, "the hint must name the commodity");
  assert.match(build.hint, /130/, "…and the exact shortfall (a Barracks costs 150 ore, the seat holds 20)");

  const train = apply(state, "player", { t: "queueProduction", building: cc.id, u: "worker" });
  assert.equal(train.reason, "cannot-afford");
  assert.match(train.hint, /Ore/);
});

test("supply-capped points at the Habitat — the specific build that unblocks it", () => {
  const state = makeState();
  const cc = findBuilding(state, "player", "command");
  state.players.player.resources.ore = 10000;
  // Fill the roster's supply to the brim by queueing until the cap bites (each queued job counts).
  let last = null;
  for (let i = 0; i < 200; i++) {
    last = apply(state, "player", { t: "queueProduction", building: cc.id, u: "worker" });
    if (!last.ok) break;
  }
  assert.equal(last.reason, "supply-capped", "sanity: the cap, not the price, is what stopped it");
  assert.match(last.hint, /Habitat/);
  assert.match(last.hint, /\d+\/\d+/, "the hint reports the actual used/cap numbers");
});

test("invalid-placement says it is the GROUND, and where — not a bare refusal to probe against", () => {
  const state = makeState();
  const worker = playerWorker(state);
  const cc = findBuilding(state, "player", "command");
  state.players.player.resources.ore = 10000;

  const r = apply(state, "player", { t: "build", worker: worker.id, b: "barracks", x: cc.x, y: cc.y });
  assert.equal(r.reason, "invalid-placement");
  assert.match(r.hint, /Barracks/);
  assert.match(r.hint, new RegExp(`${Math.round(cc.x)}`), "the coordinates that failed are echoed back");
});

test("building-cannot-produce-this-unit lists what that building DOES train", () => {
  const state = makeState();
  const cc = findBuilding(state, "player", "command");
  state.players.player.resources.ore = 10000;

  const r = apply(state, "player", { t: "queueProduction", building: cc.id, u: "skiff" });
  assert.equal(r.reason, "building-cannot-produce-this-unit");
  assert.match(r.hint, /Worker/, "the Command Center's own roster is the actionable half");
});

test("research refusals are reported at all, and say where research actually happens", () => {
  const state = makeState();
  const cc = findBuilding(state, "player", "command");
  state.players.player.resources.crystals = 10000;

  // A Command Center is neither a Refinery nor a Datacenter: the engine has always refused this,
  // the codec used to answer ok anyway (a silent no-op the caller could not see).
  const upgrade = apply(state, "player", { t: "researchUpgrade", building: cc.id, up: "overchargedWeapons" });
  assert.equal(upgrade.code, REJECT.REFUSED);
  assert.equal(upgrade.reason, "wrong-building-for-research");
  assert.match(upgrade.hint, /Refinery/);

  const tech = apply(state, "player", { t: "researchTech", building: cc.id, tech: "metallurgy" });
  assert.equal(tech.reason, "wrong-building-for-research");
  assert.match(tech.hint, /Datacenter/);
});

test("a real research refusal at the RIGHT building still names its own cause", () => {
  const state = makeState();
  const dc = makeBuilding("datacenter", "player", 700, 600);
  state.buildings.set(dc.id, dc);
  for (const com of Object.keys(state.players.player.resources)) state.players.player.resources[com] = 0;

  const broke = apply(state, "player", { t: "researchTech", building: dc.id, tech: "metallurgy" });
  assert.equal(broke.reason, "cannot-afford");
  assert.match(broke.hint, /Crystals/);

  state.players.player.resources.crystals = 10000;
  assert.equal(apply(state, "player", { t: "researchTech", building: dc.id, tech: "metallurgy" }).ok, true);

  const again = apply(state, "player", { t: "researchTech", building: dc.id, tech: "metallurgy" });
  assert.equal(again.reason, "already-queued", "re-sending an in-flight order is exactly the loop this ends");
  assert.match(again.hint, /wait/i);

  const stale = apply(state, "player", { t: "cancelResearch", building: dc.id, i: 7 });
  assert.equal(stale.reason, "no-such-job", "a stale queue index is no longer reported as a cancel");
});

test("lightFuse on a unit that is not a bomb is refused with the cause, not silently stamped", () => {
  const state = makeState();
  const worker = playerWorker(state);

  const r = apply(state, "player", { t: "lightFuse", unit: worker.id });
  assert.equal(r.reason, "not-a-bomb");
  assert.equal(worker.fuseUntil, undefined, "…and nothing was written to the unit");
  assert.match(r.hint, /bomb/);
});

/* ---------- the coarse codes: every rejection is actionable, not just the engine's ---------- */

test("the codec's own gates carry a hint too — ownership, fog and bounds each name the recovery", () => {
  const state = makeState();
  const worker = playerWorker(state);
  const aiUnit = [...state.units.values()].find(u => u.owner === "ai");

  const foreign = apply(state, "player", { t: "move", ids: [aiUnit.id], x: 100, y: 100 });
  assert.equal(foreign.code, REJECT.NOT_OWNER);
  assert.match(foreign.hint, /get_situation/, "the hint names the tool that fixes it");

  const offMap = apply(state, "player", { t: "move", ids: [worker.id], x: -50, y: 100 });
  assert.equal(offMap.code, REJECT.OUT_OF_BOUNDS);
  assert.match(offMap.hint, /map/);

  const gone = apply(state, "player", { t: "move", ids: ["no-such-unit"], x: 100, y: 100 });
  assert.equal(gone.code, REJECT.EMPTY);
  assert.ok(gone.hint.length > 0);
});

test("a batch member's rejection is explained by the MEMBER that failed, not the wrapper", () => {
  const state = makeState();
  const worker = playerWorker(state);
  const cc = findBuilding(state, "player", "command");
  state.players.player.resources.ore = 10000;

  const r = apply(state, "player", {
    t: "batch",
    c: [
      { t: "move", ids: [worker.id], x: worker.x + 10, y: worker.y },
      { t: "build", worker: worker.id, b: "foundry", x: cc.x + 250, y: cc.y + 250 },   // no Barracks yet
    ],
  });
  assert.equal(r.code, REJECT.REFUSED);
  assert.match(r.hint, /Barracks/, "the wrapper has no b/u fields to explain a refusal with");
});

test("hintForCode answers for a code alone (the shape-rejection path has no state or command)", () => {
  assert.match(hintForCode("bad-version"), /protocol/);
  assert.match(hintForCode("command-timeout"), /get_situation/);
  assert.ok(hintForCode("a-code-nobody-has-defined-yet").length > 0, "an unknown code still gets usable guidance");
});
