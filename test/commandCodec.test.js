/* ============================================================
   T-021 (ADR-0006, docs/analysis/02-command-wire-protocol.md §9): net/commandCodec.js is the sole
   path from a wire-shaped WireCommand to engine/commands.js — the ONE place ownership and fog are
   actually checked (see test/netBoundary.test.js for the "nobody else may import engine/commands.js"
   half of that claim). This file exercises what the codec itself is FOR:

     - ownership: a foreign id anywhere it acts as the SUBJECT of a command is rejected NOT_OWNER,
       never silently dropped or half-applied — swept across the whole command surface, grouped by
       which resolver a command uses (ids->ownUnits, ids->ownEntities, building->ownBuilding, a
       single ownUnit field), so a command added to SCHEMA without ownership checking shows up as a
       gap in one of these tables, not a hole nobody wrote a test for.
     - fog: a command's OBJECT (the entity/node it acts ON, as opposed to the units acting) is
       gated by state.fogs[owner] — visible for a foreign unit, merely explored for a foreign
       building or a hidden resource cache — a rule that exists nowhere in engine/.
     - malformed input: every SCHEMA entry's own shape checks, independent of ownership/fog.
     - the specific defects ADR-0006/T-017/T-019/T-019a exist to close: friendly fire, escort
       self-targeting, setHomeBase's null case, setRally's id-based signature.
     - parity: driving identical orders through the codec vs. directly through issue* produces
       byte-identical engine state — the codec adds a validation layer, it does not change what the
       simulation does once a command clears it (ADR-0006 Option B's whole premise).
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState } from "../engine/state.js";
import { mulberry32 } from "../engine/rng.js";
import { entitySnapshot } from "./_helpers.js";
import { apply, REJECT, COMMAND_TYPES, LIMITS } from "../net/commandCodec.js";
import { COMMAND_TYPES as ENVELOPE_TYPES } from "../net/commandEnvelope.js";
import * as cmd from "../engine/commands.js";
import { queueProduction } from "../engine/production.js";

function makeState(seed = 12345) {
  return createGameState({ planetId: "ferros", seed, rng: mulberry32(seed) });
}

// Force a deterministic fog precondition instead of relying on wherever a fresh map's starting
// vision happens to land — .fill mutates the SAME typed array state.fog/state.fogAI alias into
// (engine/fog.js), so this is visible through either name.
function revealAll(state, owner) {
  state.fogs[owner].visible.fill(1);
  state.fogs[owner].explored.fill(1);
}
function hideAll(state, owner) {
  state.fogs[owner].visible.fill(0);
  state.fogs[owner].explored.fill(0);
}

const playerUnits = s => [...s.units.values()].filter(u => u.owner === "player");
const aiUnits = s => [...s.units.values()].filter(u => u.owner === "ai");
const findBuilding = (s, owner, type) => [...s.buildings.values()].find(b => b.owner === owner && b.type === type);

test("COMMAND_TYPES stays in sync with net/commandEnvelope.js's union — the engine's real accepted surface must never be narrower or wider than what the envelope claims to shape-validate", () => {
  const envelopeReal = ENVELOPE_TYPES.filter(t => t !== "batch");
  assert.deepEqual([...COMMAND_TYPES].sort(), [...envelopeReal].sort());
});

/* ---------- ownership: ids -> ownUnits (the largest group — 14 command types) ---------- */

test("ownership: a foreign unit id is rejected NOT_OWNER across the whole ids->ownUnits command surface", () => {
  const state = makeState();
  revealAll(state, "player");   // isolate ownership from fog — these targets are always visible
  const pCC = findBuilding(state, "player", "command");
  const aiWorker = aiUnits(state)[0];
  const node = state.map.nodes[0];
  assert.ok(node, "fixture assumption: the map has at least one resource node");

  const cases = {
    move: ids => ({ t: "move", ids, x: 10, y: 10 }),
    attackMove: ids => ({ t: "attackMove", ids, x: 10, y: 10 }),
    holdFormation: ids => ({ t: "holdFormation", ids }),
    patrol: ids => ({ t: "patrol", ids, pts: [{ x: 10, y: 10 }] }),
    stop: ids => ({ t: "stop", ids }),
    hold: ids => ({ t: "hold", ids }),
    scout: ids => ({ t: "scout", ids }),
    attack: ids => ({ t: "attack", ids, target: aiWorker.id }),
    escort: ids => ({ t: "escort", ids, target: aiWorker.id }),
    repair: ids => ({ t: "repair", ids, target: pCC.id }),
    service: ids => ({ t: "service", ids, target: pCC.id }),
    gather: ids => ({ t: "gather", ids, node: node.id }),
    setAILogistics: ids => ({ t: "setAILogistics", ids, on: true }),
    setCollectPoint: ids => ({ t: "setCollectPoint", ids, on: true }),
  };

  for (const [type, build] of Object.entries(cases)) {
    const result = apply(state, "player", build([aiWorker.id]));
    assert.equal(result.ok, false, `${type} must reject a foreign unit id`);
    assert.equal(result.code, REJECT.NOT_OWNER, `${type} must reject with NOT_OWNER specifically`);
  }
});

/* ---------- ownership: ids -> ownEntities (units AND buildings) ---------- */

test("ownership: a foreign id is rejected NOT_OWNER across the ids->ownEntities command surface (recycle, cancelRecycle, setElectrified)", () => {
  const state = makeState();
  const aiWorker = aiUnits(state)[0];
  const aiCC = findBuilding(state, "ai", "command");

  const cases = {
    recycle: () => ({ t: "recycle", ids: [aiWorker.id] }),
    cancelRecycle: () => ({ t: "cancelRecycle", ids: [aiWorker.id] }),
    setElectrified: () => ({ t: "setElectrified", ids: [aiCC.id], on: true }),
  };

  for (const [type, build] of Object.entries(cases)) {
    const result = apply(state, "player", build());
    assert.equal(result.ok, false, `${type} must reject a foreign id`);
    assert.equal(result.code, REJECT.NOT_OWNER, `${type} must reject with NOT_OWNER specifically`);
  }
});

/* ---------- ownership: building -> ownBuilding ---------- */

test("ownership: a foreign building id is rejected NOT_OWNER across the whole building->ownBuilding command surface", () => {
  const state = makeState();
  const aiCC = findBuilding(state, "ai", "command");
  const cx = state.map.width / 2, cy = state.map.height / 2;

  const cases = {
    setLogiPriority: b => ({ t: "setLogiPriority", building: b, p: "high" }),
    setRally: b => ({ t: "setRally", building: b, x: cx, y: cy }),
    queueProduction: b => ({ t: "queueProduction", building: b, u: "worker" }),
    cancelProduction: b => ({ t: "cancelProduction", building: b, i: 0 }),
    researchUpgrade: b => ({ t: "researchUpgrade", building: b, up: "overchargedWeapons" }),
    researchTech: b => ({ t: "researchTech", building: b, tech: "metallurgy" }),
    cancelResearch: b => ({ t: "cancelResearch", building: b, i: 0 }),
  };

  for (const [type, build] of Object.entries(cases)) {
    const result = apply(state, "player", build(aiCC.id));
    assert.equal(result.ok, false, `${type} must reject a foreign building id`);
    assert.equal(result.code, REJECT.NOT_OWNER, `${type} must reject with NOT_OWNER specifically`);
  }
});

/* ---------- ownership: single-field ownUnit / ownBuilding cases too irregular for a table ---------- */

test("ownership: build's worker must be your own", () => {
  const state = makeState();
  const aiWorker = aiUnits(state).find(u => u.type === "worker");
  // A safe in-bounds spot unrelated to the (foreign) worker's own position — the AI spawns near
  // the map's right edge, where +300 would trip OUT_OF_BOUNDS before ownership is ever checked.
  const x = state.map.width / 2, y = state.map.height / 2;
  const r = apply(state, "player", { t: "build", worker: aiWorker.id, b: "barracks", x, y });
  assert.equal(r.code, REJECT.NOT_OWNER);
});

test("ownership: lightFuse's unit must be your own; a dead/unknown id is NO_TARGET, not silently ignored", () => {
  const state = makeState();
  const [w] = playerUnits(state);
  const aiWorker = aiUnits(state)[0];
  assert.equal(apply(state, "player", { t: "lightFuse", unit: aiWorker.id }).code, REJECT.NOT_OWNER);
  assert.equal(apply(state, "player", { t: "lightFuse", unit: "no-such-unit" }).code, REJECT.NO_TARGET);
  assert.equal(apply(state, "player", { t: "lightFuse", unit: 5 }).code, REJECT.MALFORMED);
  // A real, owned, non-bomb unit: the codec still routes it through (ok:true) — whether lightFuse
  // itself does anything to a unit that isn't a Helium Bomb is engine/bomb.js's own concern.
  assert.equal(apply(state, "player", { t: "lightFuse", unit: w.id }).ok, true);
});

test("ownership: ferry's target must be YOUR OWN freighter, not merely visible — dossier 02's point that a foreign or nonexistent ferry target must never be silently accepted", () => {
  const state = makeState();
  revealAll(state, "player");
  const [w] = playerUnits(state);
  const aiUnit = aiUnits(state)[0];
  assert.equal(apply(state, "player", { t: "ferry", ids: [w.id], target: aiUnit.id }).code, REJECT.NOT_OWNER);
  assert.equal(apply(state, "player", { t: "ferry", ids: [w.id], target: "no-such-unit" }).code, REJECT.NO_TARGET);
  const aiWorker = aiUnits(state).find(u => u.type === "worker" && u.id !== aiUnit.id) || aiUnit;
  assert.equal(apply(state, "player", { t: "ferry", ids: [aiWorker.id], target: w.id }).code, REJECT.NOT_OWNER);
});

/* ---------- fog: the codec's own rule, not the engine's ---------- */

test("fog: an unexplored foreign unit is a NOT_VISIBLE target for attack (and everything else routed through targetEntity)", () => {
  const state = makeState();
  hideAll(state, "player");
  const [w] = playerUnits(state);
  const aiUnit = aiUnits(state)[0];
  const r = apply(state, "player", { t: "attack", ids: [w.id], target: aiUnit.id });
  assert.equal(r.ok, false);
  assert.equal(r.code, REJECT.NOT_VISIBLE);
});

test("fog: a foreign BUILDING only needs to be EXPLORED, not currently visible — a remembered structure stays targetable, same as the renderer already draws it", () => {
  const state = makeState();
  hideAll(state, "player");
  state.fogs.player.explored.fill(1);   // explored, but visible stays all-zero
  const [w] = playerUnits(state);
  const aiCC = findBuilding(state, "ai", "command");
  const r = apply(state, "player", { t: "repair", ids: [w.id], target: aiCC.id, q: false });
  assert.equal(r.ok, true, "an explored-but-not-visible enemy building must still be a valid target");
});

test("fog: a foreign UNIT that is merely explored but not currently visible is still rejected — units need LIVE vision, unlike buildings", () => {
  const state = makeState();
  hideAll(state, "player");
  state.fogs.player.explored.fill(1);
  const [w] = playerUnits(state);
  const aiUnit = aiUnits(state)[0];
  const r = apply(state, "player", { t: "attack", ids: [w.id], target: aiUnit.id });
  assert.equal(r.code, REJECT.NOT_VISIBLE);
});

test("fog: your OWN entities are always a valid target, regardless of fog — you always see your own stuff", () => {
  const state = makeState();
  hideAll(state, "player");
  const [w0, w1] = playerUnits(state);
  const r = apply(state, "player", { t: "repair", ids: [w0.id], target: w1.id, q: false });
  assert.equal(r.ok, true);
});

test("fog: a hidden resource cache is ungatherable until explored; pushing it into the map fixture directly proves the gate, not just an ordinary always-known node", () => {
  const state = makeState();
  const [w] = playerUnits(state);
  const hidden = {
    id: "test-hidden-node", com: "crystals", amount: 100, max: 100,
    x: state.map.width - 10, y: state.map.height - 10, hidden: true,
  };
  state.map.nodes.push(hidden);
  hideAll(state, "player");

  const blocked = apply(state, "player", { t: "gather", ids: [w.id], node: hidden.id });
  assert.equal(blocked.code, REJECT.NOT_VISIBLE);

  state.fogs.player.explored.fill(1);
  const allowed = apply(state, "player", { t: "gather", ids: [w.id], node: hidden.id });
  assert.equal(allowed.ok, true);
});

test("gather: an unknown node id is NO_TARGET", () => {
  const state = makeState();
  const [w] = playerUnits(state);
  const r = apply(state, "player", { t: "gather", ids: [w.id], node: "no-such-node" });
  assert.equal(r.code, REJECT.NO_TARGET);
});

/* ---------- the specific defects ADR-0006/T-017/T-019/T-019a exist to close ---------- */

test("friendly-fire: attack targeting your OWN unit is rejected NOT_OWNER before the engine is ever asked — codec-level defense in depth on top of T-019's engine-level fix (combat.js)", () => {
  const state = makeState();
  const [w0, w1] = playerUnits(state);
  const r = apply(state, "player", { t: "attack", ids: [w0.id], target: w1.id });
  assert.equal(r.ok, false);
  assert.equal(r.code, REJECT.NOT_OWNER);
});

test("escort: the target is filtered out of its own escort ring even when included in ids — a unit can never be ordered to escort itself", () => {
  const state = makeState();
  const [w0, w1] = playerUnits(state);
  const before = w0.order;
  const r = apply(state, "player", { t: "escort", ids: [w0.id, w1.id], target: w0.id });
  assert.equal(r.ok, true);
  assert.deepEqual(w0.order, before, "the escort target itself must never receive an escort-self order");
  assert.equal(w1.order.type, "escort");
  assert.equal(w1.order.targetId, w0.id);
});

test("escort: a selection that is ONLY the target (nothing left to escort with, once self-filtered) is EMPTY, not a silent no-op", () => {
  const state = makeState();
  const [w0] = playerUnits(state);
  const r = apply(state, "player", { t: "escort", ids: [w0.id], target: w0.id });
  assert.equal(r.ok, false);
  assert.equal(r.code, REJECT.EMPTY);
});

test("setHomeBase: null clears it (T-019a); a non-null target and the acting ids are both still ownership-checked", () => {
  const state = makeState();
  const [w] = playerUnits(state);
  const pCC = findBuilding(state, "player", "command");
  const aiCC = findBuilding(state, "ai", "command");

  const set = apply(state, "player", { t: "setHomeBase", ids: [w.id], target: pCC.id });
  assert.equal(set.ok, true);
  assert.equal(w.homeCC, pCC.id);

  const cleared = apply(state, "player", { t: "setHomeBase", ids: [w.id], target: null });
  assert.equal(cleared.ok, true);
  assert.equal(w.homeCC, null);

  assert.equal(apply(state, "player", { t: "setHomeBase", ids: [w.id], target: aiCC.id }).code, REJECT.NOT_OWNER);
  const aiWorker = aiUnits(state)[0];
  assert.equal(apply(state, "player", { t: "setHomeBase", ids: [aiWorker.id], target: pCC.id }).code, REJECT.NOT_OWNER);
});

test("setHomeBase: a resolved, owned target that isn't a command building is rejected MALFORMED — the engine never validates this itself", () => {
  const state = makeState();
  const [w] = playerUnits(state);
  cmd.issueBuild(state, w.id, "barracks", w.x + 300, w.y + 300);
  const barracks = [...state.buildings.values()].find(b => b.owner === "player" && b.type === "barracks");
  assert.ok(barracks, "fixture sanity: the barracks was actually built");
  const r = apply(state, "player", { t: "setHomeBase", ids: [w.id], target: barracks.id });
  assert.equal(r.ok, false);
  assert.equal(r.code, REJECT.MALFORMED);
});

test("assistBuild: both the target site and the assisting ids are ownership-checked; a finished (non-constructing) site is NO_TARGET", () => {
  const state = makeState();
  const [w0, w1] = playerUnits(state);
  const buildingId = cmd.issueBuild(state, w0.id, "barracks", w0.x + 300, w0.y + 300);
  assert.ok(buildingId, "fixture sanity");

  assert.equal(apply(state, "player", { t: "assistBuild", ids: [w1.id], target: buildingId, q: false }).ok, true);

  const aiCC = findBuilding(state, "ai", "command");
  assert.equal(apply(state, "player", { t: "assistBuild", ids: [w1.id], target: aiCC.id, q: false }).code, REJECT.NOT_OWNER);

  const aiWorker = aiUnits(state)[0];
  assert.equal(apply(state, "player", { t: "assistBuild", ids: [aiWorker.id], target: buildingId, q: false }).code, REJECT.NOT_OWNER);

  const pCC = findBuilding(state, "player", "command");   // already finished, not constructing
  assert.equal(apply(state, "player", { t: "assistBuild", ids: [w1.id], target: pCC.id, q: false }).code, REJECT.NO_TARGET);
});

test("setRally is id-based (ADR-0006 D2): applies to an owned building by id, and an out-of-bounds rally point is rejected before the engine is asked", () => {
  const state = makeState();
  const pCC = findBuilding(state, "player", "command");
  const ok1 = apply(state, "player", { t: "setRally", building: pCC.id, x: pCC.x + 50, y: pCC.y + 50 });
  assert.equal(ok1.ok, true);
  assert.deepEqual(pCC.rally, { x: pCC.x + 50, y: pCC.y + 50, nodeId: null });

  const oob = apply(state, "player", { t: "setRally", building: pCC.id, x: state.map.width + 1000, y: 0 });
  assert.equal(oob.code, REJECT.OUT_OF_BOUNDS);

  assert.equal(apply(state, "player", { t: "setRally", building: "no-such-building", x: 1, y: 1 }).code, REJECT.NO_TARGET);
});

/* ---------- malformed input: independent of ownership/fog ---------- */

test("malformed: move rejects out-of-range coordinates, a non-boolean q, empty ids, and a non-string id", () => {
  const state = makeState();
  const [w] = playerUnits(state);
  assert.equal(apply(state, "player", { t: "move", ids: [w.id], x: state.map.width + 1000, y: 0 }).code, REJECT.OUT_OF_BOUNDS);
  assert.equal(apply(state, "player", { t: "move", ids: [w.id], x: 10, y: 10, q: "yes" }).code, REJECT.MALFORMED);
  assert.equal(apply(state, "player", { t: "move", ids: [], x: 10, y: 10 }).code, REJECT.EMPTY);
  assert.equal(apply(state, "player", { t: "move", ids: [123], x: 10, y: 10 }).code, REJECT.MALFORMED);
});

test("malformed: move/attackMove reject an invalid WireFormation — wrong shape enum, or a non-object f", () => {
  const state = makeState();
  const [w] = playerUnits(state);
  assert.equal(apply(state, "player", { t: "move", ids: [w.id], x: 10, y: 10, f: { s: "not-a-shape" } }).code, REJECT.MALFORMED);
  assert.equal(apply(state, "player", { t: "move", ids: [w.id], x: 10, y: 10, f: "nope" }).code, REJECT.MALFORMED);
  // A well-formed formation is accepted and reaches the engine.
  assert.equal(apply(state, "player", { t: "attackMove", ids: [w.id], x: 10, y: 10, f: { s: "wedge", l: "back" } }).ok, true);
});

test("malformed: holdFormation rejects an invalid shape/leaderPos enum value", () => {
  const state = makeState();
  const [w] = playerUnits(state);
  assert.equal(apply(state, "player", { t: "holdFormation", ids: [w.id], s: "nonsense" }).code, REJECT.MALFORMED);
  assert.equal(apply(state, "player", { t: "holdFormation", ids: [w.id], l: "nonsense" }).code, REJECT.MALFORMED);
});

test("malformed: patrol rejects an empty point list, and an out-of-bounds point", () => {
  const state = makeState();
  const [w] = playerUnits(state);
  assert.equal(apply(state, "player", { t: "patrol", ids: [w.id], pts: [] }).code, REJECT.MALFORMED);
  assert.equal(apply(state, "player", { t: "patrol", ids: [w.id], pts: [{ x: state.map.width + 1000, y: 0 }] }).code, REJECT.OUT_OF_BOUNDS);
});

test("LIMITS: patrol rejects more than LIMITS.patrolPoints points with TOO_MANY", () => {
  const state = makeState();
  const [w] = playerUnits(state);
  const pts = Array.from({ length: LIMITS.patrolPoints + 1 }, () => ({ x: 1, y: 1 }));
  assert.equal(apply(state, "player", { t: "patrol", ids: [w.id], pts }).code, REJECT.TOO_MANY);
});

test("LIMITS: any ids->resolver command rejects more than LIMITS.ids ids with TOO_MANY, before resolving a single one", () => {
  const state = makeState();
  const ids = Array.from({ length: LIMITS.ids + 1 }, (_, i) => `nonexistent-${i}`);
  assert.equal(apply(state, "player", { t: "stop", ids }).code, REJECT.TOO_MANY);
});

test("malformed: build rejects an unknown building type; a placement collision is REFUSED by the engine, not the codec", () => {
  const state = makeState();
  const w = playerUnits(state).find(u => u.type === "worker");
  assert.equal(apply(state, "player", { t: "build", worker: w.id, b: "not-a-real-building", x: w.x + 300, y: w.y + 300 }).code, REJECT.MALFORMED);
  assert.equal(apply(state, "player", { t: "build", worker: w.id, b: "barracks", x: state.map.width + 1000, y: w.y }).code, REJECT.OUT_OF_BOUNDS);

  const pCC = findBuilding(state, "player", "command");
  const refused = apply(state, "player", { t: "build", worker: w.id, b: "barracks", x: pCC.x, y: pCC.y });
  assert.equal(refused.ok, false, "building on top of an existing structure must be declined by the engine");
  assert.equal(refused.code, REJECT.REFUSED);

  const succeeded = apply(state, "player", { t: "build", worker: w.id, b: "barracks", x: w.x + 300, y: w.y + 300 });
  assert.equal(succeeded.ok, true);
  assert.ok(succeeded.result.buildingId);
});

test("malformed: recycle/cancelRecycle/setElectrified report EMPTY when every id resolves to nothing — a legitimate race, not thrown", () => {
  const state = makeState();
  assert.equal(apply(state, "player", { t: "recycle", ids: ["gone-1", "gone-2"] }).code, REJECT.EMPTY);
  assert.equal(apply(state, "player", { t: "cancelRecycle", ids: ["gone-1"] }).code, REJECT.EMPTY);
  assert.equal(apply(state, "player", { t: "setElectrified", ids: ["gone-1"], on: true }).code, REJECT.EMPTY);
});

test("malformed: setElectrified/setLogiPriority reject a non-boolean/non-enum payload", () => {
  const state = makeState();
  const [w] = playerUnits(state);
  const pCC = findBuilding(state, "player", "command");
  assert.equal(apply(state, "player", { t: "setElectrified", ids: [w.id], on: "not-a-bool" }).code, REJECT.MALFORMED);
  assert.equal(apply(state, "player", { t: "setLogiPriority", building: pCC.id, p: "not-a-priority" }).code, REJECT.MALFORMED);
});

test("malformed: unknown command type is UNKNOWN_TYPE; a non-object/typeless command is MALFORMED", () => {
  const state = makeState();
  assert.equal(apply(state, "player", { t: "selfDestructTheServer" }).code, REJECT.UNKNOWN_TYPE);
  assert.equal(apply(state, "player", null).code, REJECT.MALFORMED);
  assert.equal(apply(state, "player", {}).code, REJECT.MALFORMED);
});

/* ---------- toggles and production/research: ownership already swept above; this is "reaches the engine" ---------- */

test("toggle commands succeed for owned entities and reach the engine: setAILogistics, setCollectPoint, setElectrified, setLogiPriority", () => {
  const state = makeState();
  const [w] = playerUnits(state);
  const pCC = findBuilding(state, "player", "command");

  assert.equal(apply(state, "player", { t: "setAILogistics", ids: [w.id], on: true }).ok, true);
  assert.equal(apply(state, "player", { t: "setCollectPoint", ids: [w.id], on: true }).ok, true);
  assert.equal(apply(state, "player", { t: "setElectrified", ids: [pCC.id], on: true }).ok, true);
  assert.equal(pCC.electrified, true);
  assert.equal(apply(state, "player", { t: "setLogiPriority", building: pCC.id, p: "high" }).ok, true);
});

test("production/research commands reach the engine for an owned building — the codec proves routing (ownership+shape), not game-balance legality, which is engine/production.js's and engine/techtree.js's own concern", () => {
  const state = makeState();
  const pCC = findBuilding(state, "player", "command");

  const q = apply(state, "player", { t: "queueProduction", building: pCC.id, u: "worker" });
  assert.equal(q.ok, true);
  assert.ok(pCC.queue && pCC.queue.length > 0);

  assert.equal(apply(state, "player", { t: "queueProduction", building: pCC.id, u: 42 }).code, REJECT.MALFORMED);
  assert.equal(apply(state, "player", { t: "cancelProduction", building: pCC.id, i: "x" }).code, REJECT.MALFORMED);
  assert.equal(apply(state, "player", { t: "cancelProduction", building: pCC.id, i: 0 }).ok, true);

  assert.equal(apply(state, "player", { t: "researchUpgrade", building: pCC.id, up: "overchargedWeapons" }).ok, true);
  assert.equal(apply(state, "player", { t: "researchUpgrade", building: pCC.id, up: 1 }).code, REJECT.MALFORMED);
  assert.equal(apply(state, "player", { t: "researchTech", building: pCC.id, tech: "metallurgy" }).ok, true);
  assert.equal(apply(state, "player", { t: "researchTech", building: pCC.id, tech: 1 }).code, REJECT.MALFORMED);
  assert.equal(apply(state, "player", { t: "cancelResearch", building: pCC.id, i: 0 }).ok, true);
  assert.equal(apply(state, "player", { t: "cancelResearch", building: pCC.id, i: "x" }).code, REJECT.MALFORMED);
});

/* ---------- batch ---------- */

test("batch: applies every member in array order, at one call", () => {
  const state = makeState();
  const [w0, w1] = playerUnits(state);
  const r = apply(state, "player", {
    t: "batch",
    c: [
      { t: "move", ids: [w0.id], x: 200, y: 200 },
      { t: "move", ids: [w1.id], x: 800, y: 800 },
    ],
  });
  assert.equal(r.ok, true);
  assert.equal(w0.order.x, 200);
  assert.equal(w1.order.x, 800);
});

test("batch: rejects nesting, an empty member array, and more than 16 members", () => {
  const state = makeState();
  const [w] = playerUnits(state);
  const nested = apply(state, "player", { t: "batch", c: [{ t: "batch", c: [{ t: "stop", ids: [w.id] }] }] });
  assert.equal(nested.code, REJECT.MALFORMED);
  assert.equal(apply(state, "player", { t: "batch", c: [] }).code, REJECT.MALFORMED);
  const tooBig = apply(state, "player", { t: "batch", c: Array.from({ length: 17 }, () => ({ t: "stop", ids: [w.id] })) });
  assert.equal(tooBig.code, REJECT.TOO_MANY);
});

test("batch: an unknown member type is UNKNOWN_TYPE, propagated from the member, not swallowed as MALFORMED", () => {
  const state = makeState();
  const [w] = playerUnits(state);
  const r = apply(state, "player", { t: "batch", c: [{ t: "stop", ids: [w.id] }, { t: "nonsense" }] });
  assert.equal(r.code, REJECT.UNKNOWN_TYPE);
});

test("batch: atomic on VALIDATION, but NOT rolled back once an earlier member has already mutated state (this file's own documented caveat) — a later member's rejection leaves the earlier mutation in place", () => {
  const state = makeState();
  const [w0] = playerUnits(state);
  const r = apply(state, "player", {
    t: "batch",
    c: [
      { t: "move", ids: [w0.id], x: 111, y: 222 },
      { t: "move", ids: ["does-not-exist"], x: 1, y: 1 },
    ],
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, REJECT.EMPTY);
  assert.equal(w0.order.x, 111, "the first member's mutation is not rolled back");
  assert.equal(w0.order.y, 222);
});

/* ---------- parity: the codec is a validation layer, not a behavior change ---------- */

test("parity: identical orders applied via the codec vs. directly via issue*/engine functions produce byte-identical engine state", () => {
  const seed = 555;
  function actorsOf(state) {
    const workers = [...state.units.values()].filter(u => u.owner === "player" && u.type === "worker");
    const cc = findBuilding(state, "player", "command");
    return { w0: workers[0], w1: workers[2] ?? workers[1], cc };
  }

  // The two states are built and driven to completion FULLY SEQUENTIALLY, never interleaved —
  // engine/state.js's nextEntityId is a module-global (ADR-0011, TASKS.md T-016, deliberately
  // deferred): building both states up front and THEN mutating each in turn would let one state's
  // mid-test mutation shift the other's entity ids out from under it. test/session.test.js's own
  // determinism test documents and works around the identical hazard.
  const viaCodec = makeState(seed);
  const a = actorsOf(viaCodec);
  // Through the codec — ids only, exactly what a real client sends.
  assert.equal(apply(viaCodec, "player", { t: "move", ids: [a.w0.id], x: a.w0.x + 200, y: a.w0.y }).ok, true);
  assert.equal(apply(viaCodec, "player", { t: "build", worker: a.w1.id, b: "barracks", x: a.w1.x + 300, y: a.w1.y + 300 }).ok, true);
  assert.equal(apply(viaCodec, "player", { t: "queueProduction", building: a.cc.id, u: "worker" }).ok, true);
  const snapshotCodec = entitySnapshot(viaCodec);

  const viaDirect = makeState(seed);
  const b = actorsOf(viaDirect);
  assert.equal(a.w0.id, b.w0.id, "fixture sanity: the same seed must mint identical entities in identical order");
  assert.equal(a.w1.id, b.w1.id);
  // Directly through the same engine functions the codec itself calls, resolving ids to live
  // objects by hand — exactly what server/session.js did before T-021 existed.
  cmd.issueMove([b.w0], b.w0.x + 200, b.w0.y, false, undefined, viaDirect);
  cmd.issueBuild(viaDirect, b.w1.id, "barracks", b.w1.x + 300, b.w1.y + 300);
  queueProduction(viaDirect, b.cc.id, "worker", false);
  const snapshotDirect = entitySnapshot(viaDirect);

  assert.equal(snapshotCodec, snapshotDirect);
});
