/* ============================================================
   T-028b: ADR-0009 M3 — delta-encode projectFor snapshots against the client's last acknowledged
   one, full snapshots reserved for an infrequent baseline (join/reconnect). T-015 measured that a
   full snapshot every tick misses NFR-3's 32 KB/s budget by ~50x at every measured army size, and
   PRD NFR-3 itself now names this file's own mechanism as the required fix, not optional headroom.

   computeDelta/applyDelta operate purely on projectFor's own JSON-shaped output — no engine State,
   no networking — so they're testable in complete isolation from the transport that will use them
   (net/wsServerTransport.js/net/wsClientTransport.js, wired in a later step). The one property that
   actually matters: applyDelta(prev, computeDelta(prev, curr)) reproduces curr exactly. Everything
   else here is about HOW SMALL the delta gets for the case that actually pays for this file to
   exist — most entities unchanged tick to tick — which is checked directly, not inferred.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeDelta, applyDelta, quantizeForWire } from "../engine/projectionDelta.js";

function baseProj(overrides = {}) {
  return {
    tick: 10, time: 0.5, over: false, winner: null, winReason: null,
    owners: ["player", "ai"],
    players: {
      player: { id: "player", faction: "f1", isAI: false, color: "#fff", score: 1, supply: 2, supplyCap: 10, resources: { ore: 100 }, upgrades: {} },
      ai: { id: "ai", faction: "f2", isAI: true, color: "#000", score: 0, supply: 1, supplyCap: 10 },
    },
    units: [{ id: "u1", x: 1, y: 1, hp: 10, owner: "player" }, { id: "u2", x: 2, y: 2, hp: 20, owner: "ai" }],
    buildings: [{ id: "b1", x: 5, y: 5, hp: 100, owner: "player" }],
    nodes: [{ id: "n1", amount: 50 }],
    events: [{ type: "unitSpawned", x: 1, y: 1, owner: "player" }],
    ...overrides,
  };
}

// Entity arrays are compared by SET, not by array order: applyEntityDiff rebuilds them from a Map
// keyed by id (removed deleted, changed/added set), so the resulting order reflects Map insertion
// order, not necessarily curr's own original array order — a difference with no consequence, since
// every real consumer (reassembleProjection) immediately re-indexes these arrays into a Map by id
// anyway. Order-sensitive assert.deepEqual would be testing an accident of construction order, not
// a real guarantee.
function assertSameProjection(applied, curr) {
  for (const key of Object.keys(curr)) {
    if (["units", "buildings", "nodes"].includes(key)) {
      const sortById = arr => [...arr].sort((a, b) => a.id < b.id ? -1 : 1);
      assert.deepEqual(sortById(applied[key]), sortById(curr[key]), `${key} differs`);
    } else {
      assert.deepEqual(applied[key], curr[key], `${key} differs`);
    }
  }
}

test("computeDelta + applyDelta round-trips exactly, with adds, removes and changes all present at once", () => {
  const prev = baseProj();
  const curr = baseProj({
    tick: 11, time: 0.55,
    units: [
      { id: "u1", x: 1, y: 1, hp: 10, owner: "player" },        // unchanged
      { id: "u3", x: 9, y: 9, hp: 5, owner: "ai" },              // added (u2 removed, u3 added)
    ],
    nodes: [{ id: "n1", amount: 45 }],                            // changed (amount dropped)
    events: [{ type: "unitDied", x: 2, y: 2, owner: "ai" }],
  });

  const delta = computeDelta(prev, curr);
  const applied = applyDelta(prev, delta);
  assertSameProjection(applied, curr);
});

test("the round-trip holds regardless of entity array order — only the SET of entities and their data is guaranteed, never array position", () => {
  const prev = baseProj({ units: [baseProj().units[1], baseProj().units[0]] });   // prev's own order reversed
  const curr = baseProj({
    units: [
      { id: "u3", x: 9, y: 9, hp: 5, owner: "ai" },               // added, listed FIRST this time
      { id: "u1", x: 1, y: 1, hp: 10, owner: "player" },          // unchanged, listed SECOND
    ],
  });
  const applied = applyDelta(prev, computeDelta(prev, curr));
  assertSameProjection(applied, curr);
});

test("an entity identical in both snapshots is absent from the delta entirely — the whole point of this file", () => {
  const prev = baseProj();
  const curr = baseProj();   // byte-identical
  const delta = computeDelta(prev, curr);
  assert.deepEqual(delta.units.added, []);
  assert.deepEqual(delta.units.removed, []);
  assert.deepEqual(delta.units.changed, [], "u1/u2 are unchanged and must not be re-sent");
});

test("an added unit appears in `added` with full data, never in `changed`", () => {
  const prev = baseProj({ units: [] });
  const curr = baseProj();
  const delta = computeDelta(prev, curr);
  assert.deepEqual(delta.units.added.map(u => u.id).sort(), ["u1", "u2"]);
  assert.deepEqual(delta.units.changed, []);
});

test("a removed unit appears in `removed` as just its id, never carrying its old data over the wire", () => {
  const prev = baseProj();
  const curr = baseProj({ units: [] });
  const delta = computeDelta(prev, curr);
  assert.deepEqual(delta.units.removed.sort(), ["u1", "u2"]);
  assert.deepEqual(delta.units.added, []);
  const blob = JSON.stringify(delta);
  assert.ok(!blob.includes('"hp":10'), "a removed entity's old field values must not appear in the delta at all");
});

test("a changed unit is re-sent as a PER-FIELD patch — only `id` plus the fields that actually differ, never the whole object", () => {
  // Measured, not assumed (tools/bench.js benchProjection's own deltaBytes): whole-object resend on
  // any change barely beats a full snapshot during active combat, where most units have SOMETHING
  // changing (x/y moving, hp dropping) every tick but MOST of a unit's other fields (type, owner,
  // maxHp, cargo, …) never do. Only hp actually changed here — x/y/owner didn't — so only `hp`
  // (plus the always-present `id`) belongs in the patch.
  const prev = baseProj();
  const curr = baseProj({ units: [{ id: "u1", x: 1, y: 1, hp: 7, owner: "player" }, prev.units[1]] });
  const delta = computeDelta(prev, curr);
  assert.equal(delta.units.changed.length, 1);
  assert.deepEqual(delta.units.changed[0], { id: "u1", hp: 7 });
});

test("a patch with several changed fields carries exactly those fields, nothing untouched", () => {
  const prev = baseProj();
  const curr = baseProj({ units: [{ id: "u1", x: 9, y: 1, hp: 7, owner: "player" }, prev.units[1]] });
  const delta = computeDelta(prev, curr);
  assert.deepEqual(delta.units.changed[0], { id: "u1", x: 9, hp: 7 });
});

test("applying a per-field patch MERGES it into the existing entity rather than replacing it — untouched fields survive", () => {
  const prev = baseProj();
  const curr = baseProj({ units: [{ id: "u1", x: 1, y: 1, hp: 7, owner: "player" }, prev.units[1]] });
  const delta = computeDelta(prev, curr);
  const applied = applyDelta(prev, delta);
  const u1 = applied.units.find(u => u.id === "u1");
  assert.deepEqual(u1, { id: "u1", x: 1, y: 1, hp: 7, owner: "player" },
    "x/y/owner weren't in the patch but must still be present, carried over from prev");
});

test("buildings and nodes follow the identical added/removed/changed rule as units", () => {
  const prev = baseProj();
  const curr = baseProj({
    buildings: [],   // b1 removed
    nodes: [{ id: "n1", amount: 50 }, { id: "n2", amount: 10 }],   // n2 added, n1 unchanged
  });
  const delta = computeDelta(prev, curr);
  assert.deepEqual(delta.buildings.removed, ["b1"]);
  assert.deepEqual(delta.nodes.added.map(n => n.id), ["n2"]);
  assert.deepEqual(delta.nodes.changed, [], "n1's amount is identical and must not be re-sent");
});

test("players, events, tick/time/over/winner/owners are always carried in full — never diffed", () => {
  const prev = baseProj();
  const curr = baseProj({ tick: 999 });
  const delta = computeDelta(prev, curr);
  assert.deepEqual(delta.players, curr.players);
  assert.deepEqual(delta.events, curr.events);
  assert.equal(delta.tick, 999);
  assert.deepEqual(delta.owners, curr.owners);
});

test("computeDelta(x, x) — nothing at all changed between two ticks — produces an empty delta", () => {
  const proj = baseProj({ events: [] });   // no events this tick either, the realistic quiet case
  const delta = computeDelta(proj, proj);
  assert.deepEqual(delta.units, { added: [], removed: [], changed: [] });
  assert.deepEqual(delta.buildings, { added: [], removed: [], changed: [] });
  assert.deepEqual(delta.nodes, { added: [], removed: [], changed: [] });
});

test("a realistically-sized delta (few changes among many entities) is dramatically smaller than a full snapshot", () => {
  const many = (n, mk) => Array.from({ length: n }, (_, i) => mk(i));
  const prev = baseProj({
    units: many(200, i => ({ id: `u${i}`, x: i, y: i, hp: 30, owner: i % 2 ? "ai" : "player" })),
  });
  // Only 5 of 200 units actually move this tick — the common case in a real match outside an
  // all-out battle (most of an idle economy sits still tick to tick).
  const curr = baseProj({
    units: prev.units.map((u, i) => (i < 5 ? { ...u, x: u.x + 1 } : u)),
  });
  const delta = computeDelta(prev, curr);
  const fullBytes = JSON.stringify(curr).length;
  const deltaBytes = JSON.stringify(delta).length;
  assert.equal(delta.units.changed.length, 5);
  assert.ok(deltaBytes < fullBytes / 4, `delta (${deltaBytes}B) should be well under a quarter of a full snapshot (${fullBytes}B)`);
});

/* ============================================================
   T-028c: quantizeForWire — measured (see TASKS.md), not assumed: a real match's own x/y and hp
   values accumulate full floating-point noise (velocity*dt integration, repeated damage
   subtraction) — e.g. `831.2830042896674` where nothing past the decimal point is visually or
   gameplay meaningful for a pixel-rendered 2D game. In one real stress-scenario delta, 41.7% of
   the payload's own bytes were spent on that noise; rounding to 2 decimal places recovers most of
   it while still leaving room for a genuinely fractional field like buildProgress (a 0..1 ratio)
   to read smoothly rather than jumping straight from 0 to 1.
   ============================================================ */

test("quantizeForWire rounds every number in units/buildings/nodes to 2 decimal places", () => {
  const proj = baseProj({
    units: [{ id: "u1", x: 831.2830042896674, y: 4.999999999999998, hp: 10, owner: "player" }],
    buildings: [{ id: "b1", x: 1, y: 1, hp: 100, owner: "player", buildProgress: 0.3333333333 }],
    nodes: [{ id: "n1", amount: 12.005 }],
  });
  const q = quantizeForWire(proj);
  assert.equal(q.units[0].x, 831.28);
  assert.equal(q.units[0].y, 5);
  assert.equal(q.buildings[0].buildProgress, 0.33);
  assert.equal(q.nodes[0].amount, 12.01);
});

test("quantizeForWire rounds nested numeric fields too (order, rally), not just top-level ones", () => {
  const proj = baseProj({
    units: [{ id: "u1", x: 1, y: 1, hp: 10, owner: "player", order: { type: "move", x: 5.123456, y: 9 } }],
    buildings: [{ id: "b1", x: 1, y: 1, hp: 100, owner: "player", rally: { x: 20.987654, y: 30 } }],
  });
  const q = quantizeForWire(proj);
  assert.equal(q.units[0].order.x, 5.12);
  assert.equal(q.buildings[0].rally.x, 20.99);
});

test("quantizeForWire leaves non-numeric fields (ids, strings, booleans, null) completely untouched", () => {
  const proj = baseProj();
  const q = quantizeForWire(proj);
  assert.equal(q.units[0].id, proj.units[0].id);
  assert.equal(q.units[0].owner, proj.units[0].owner);
});

test("quantizeForWire does not touch players/events/tick/etc — only units/buildings/nodes carry the byte cost this exists to cut", () => {
  const proj = baseProj({ players: { player: { id: "player", resources: { ore: 100.123456 } } } });
  const q = quantizeForWire(proj);
  assert.equal(q.players.player.resources.ore, 100.123456, "players is tiny and always sent in full regardless — nothing to gain by rounding it, so it's left alone");
});

test("computeDelta after quantizeForWire produces a meaningfully smaller delta than without it, on real noisy floats", () => {
  const prev = quantizeForWire(baseProj({
    units: [{ id: "u1", x: 100.00000000001, y: 200, hp: 10, owner: "player" }],
  }));
  const curr = quantizeForWire(baseProj({
    units: [{ id: "u1", x: 100.30000000002, y: 200.00000000003, hp: 10, owner: "player" }],
  }));
  const delta = computeDelta(prev, curr);
  // y's noise (200 vs 200.00000000003) rounds away entirely once quantized — only x, which
  // genuinely moved, should appear in the patch.
  assert.deepEqual(delta.units.changed, [{ id: "u1", x: 100.3 }]);
});
