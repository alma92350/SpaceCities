/* ============================================================
   T-020 (ADR-0006 §3.1, dossier 02 §3.1/§5.2): the wire ENVELOPE around a
   WireCommand — versioned, id-based (ids are already load-bearing per-command,
   net/commandShapes.js), owner stamped by the SERVER only. This file tests
   net/commandEnvelope.js in isolation, with no game state at all — that's the
   whole point of splitting it from net/commandCodec.js (T-021), which needs
   live state to validate ownership/fog and doesn't exist yet.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { PROTOCOL_VERSION, COMMAND_TYPES, REJECT, encode, decode, stampRecord } from "../net/commandEnvelope.js";

// One well-formed example of every command type in the union (net/commandShapes.js).
// Deliberately hand-maintained, not derived from COMMAND_TYPES, so the round-trip
// test below actually catches a type ADDED to the union without a matching example
// (missing key -> the test's own "every type has an example" assertion fails), same
// as a WireCommand added without a codec test would (dossier 02 §9's own stated goal
// for its ownership-test table).
const EXAMPLES = {
  move: { t: "move", ids: ["u1"], x: 100, y: 200 },
  attackMove: { t: "attackMove", ids: ["u1"], x: 100, y: 200, q: true },
  holdFormation: { t: "holdFormation", ids: ["u1", "u2"], s: "wedge", l: "front" },
  patrol: { t: "patrol", ids: ["u1"], pts: [{ x: 1, y: 2 }, { x: 3, y: 4 }] },
  stop: { t: "stop", ids: ["u1"] },
  hold: { t: "hold", ids: ["u1"] },
  scout: { t: "scout", ids: ["u1"] },
  attack: { t: "attack", ids: ["u1"], target: "u2", q: false },
  escort: { t: "escort", ids: ["u1"], target: "u2" },
  repair: { t: "repair", ids: ["u1"], target: "b1" },
  gather: { t: "gather", ids: ["u1"], node: "n1" },
  service: { t: "service", ids: ["u1"], target: "b1" },
  ferry: { t: "ferry", ids: ["u1"], target: "u2" },
  setHomeBase: { t: "setHomeBase", ids: ["u1"], target: "b1" },
  assistBuild: { t: "assistBuild", ids: ["u1"], target: "b1" },
  build: { t: "build", worker: "u1", b: "barracks", x: 100, y: 200 },
  recycle: { t: "recycle", ids: ["u1", "b1"] },
  cancelRecycle: { t: "cancelRecycle", ids: ["u1"] },
  setAILogistics: { t: "setAILogistics", ids: ["u1"], on: true },
  setCollectPoint: { t: "setCollectPoint", ids: ["u1"], on: false },
  setElectrified: { t: "setElectrified", ids: ["b1"], on: true },
  setLogiPriority: { t: "setLogiPriority", building: "b1", p: "high" },
  setRally: { t: "setRally", building: "b1", x: 100, y: 200, node: null },
  queueProduction: { t: "queueProduction", building: "b1", u: "worker" },
  cancelProduction: { t: "cancelProduction", building: "b1", i: 0 },
  researchUpgrade: { t: "researchUpgrade", building: "b1", up: "someUpgrade" },
  researchTech: { t: "researchTech", building: "b1", tech: "someTech" },
  cancelResearch: { t: "cancelResearch", building: "b1", i: 0 },
  lightFuse: { t: "lightFuse", unit: "u1" },
  batch: { t: "batch", c: [{ t: "move", ids: ["u1"], x: 1, y: 1 }, { t: "stop", ids: ["u1"] }] },
};

test("EXAMPLES fixture sanity: every COMMAND_TYPES entry has an example, and vice versa", () => {
  assert.deepEqual(Object.keys(EXAMPLES).sort(), [...COMMAND_TYPES].sort(),
    "the fixture table and the real union have drifted apart");
});

test("PROTOCOL_VERSION is a positive integer", () => {
  assert.ok(Number.isInteger(PROTOCOL_VERSION) && PROTOCOL_VERSION > 0);
});

for (const type of COMMAND_TYPES) {
  test(`round-trip: encode -> decode recovers "${type}" exactly`, () => {
    const cmd = EXAMPLES[type];
    const envelope = encode(cmd, 42, 1000);
    const decoded = decode(envelope);

    assert.equal(decoded.ok, true, `"${type}" must decode successfully`);
    assert.deepEqual(decoded.result, cmd, `"${type}" must round-trip byte-identical`);
  });
}

test("encode stamps the protocol version and the given seq/tick", () => {
  const envelope = encode({ t: "stop", ids: ["u1"] }, 7, 1234);
  assert.equal(envelope.v, PROTOCOL_VERSION);
  assert.equal(envelope.seq, 7);
  assert.equal(envelope.tick, 1234);
});

test("encode's tick is optional — omitted becomes null, not undefined (so it survives JSON)", () => {
  const envelope = encode({ t: "stop", ids: ["u1"] }, 7);
  assert.equal(envelope.tick, null);
  assert.equal(JSON.parse(JSON.stringify(envelope)).tick, null, "undefined would vanish from JSON; null survives");
});

test("decode rejects a version mismatch, never coercing it", () => {
  const envelope = encode({ t: "stop", ids: ["u1"] }, 1);
  envelope.v = PROTOCOL_VERSION + 1;
  const decoded = decode(envelope);
  assert.equal(decoded.ok, false);
  assert.equal(decoded.code, REJECT.BAD_VERSION);
});

test("decode rejects a missing/malformed envelope", () => {
  assert.equal(decode(null).code, REJECT.MALFORMED);
  assert.equal(decode({ v: PROTOCOL_VERSION }).code, REJECT.MALFORMED, "no seq, no cmd");
  assert.equal(decode({ v: PROTOCOL_VERSION, seq: 1 }).code, REJECT.MALFORMED, "no cmd at all");
  assert.equal(decode({ v: PROTOCOL_VERSION, seq: 1, cmd: { ids: ["u1"] } }).code, REJECT.MALFORMED, "cmd.t missing");
  assert.equal(decode({ v: PROTOCOL_VERSION, seq: -1, cmd: { t: "stop", ids: [] } }).code, REJECT.MALFORMED, "negative seq");
  assert.equal(decode({ v: PROTOCOL_VERSION, seq: 1.5, cmd: { t: "stop", ids: [] } }).code, REJECT.MALFORMED, "non-integer seq");
});

test("decode rejects an unknown command type", () => {
  const decoded = decode(encode({ t: "selfDestructTheServer" }, 1));
  assert.equal(decoded.ok, false);
  assert.equal(decoded.code, REJECT.UNKNOWN_TYPE);
});

test("decode rejects a batch nested inside a batch", () => {
  const nested = { t: "batch", c: [{ t: "batch", c: [{ t: "stop", ids: ["u1"] }] }] };
  const decoded = decode(encode(nested, 1));
  assert.equal(decoded.ok, false);
  assert.equal(decoded.code, REJECT.MALFORMED);
});

test("decode rejects an oversized batch", () => {
  const tooBig = { t: "batch", c: Array.from({ length: 17 }, () => ({ t: "stop", ids: ["u1"] })) };
  const decoded = decode(encode(tooBig, 1));
  assert.equal(decoded.ok, false);
  assert.equal(decoded.code, REJECT.MALFORMED);
});

test("decode rejects a batch containing an unknown sub-command", () => {
  const bad = { t: "batch", c: [{ t: "stop", ids: ["u1"] }, { t: "nonsense" }] };
  const decoded = decode(encode(bad, 1));
  assert.equal(decoded.ok, false);
  assert.equal(decoded.code, REJECT.UNKNOWN_TYPE);
});

test("T-020's core security property: stampRecord's owner is server-supplied, never read from the envelope", () => {
  const envelope = encode({ t: "stop", ids: ["u1"] }, 5, 999);
  // A malicious or buggy client sneaking in fields with the RIGHT names, hoping something
  // downstream trusts them.
  envelope.owner = "ai";
  envelope.applyTick = 1;

  const record = stampRecord(envelope, "player", 500);

  assert.equal(record.owner, "player", "the server-supplied owner must win, regardless of what the envelope claims");
  assert.equal(record.applyTick, 500, "the server-supplied applyTick must win too");
});

test("stampRecord carries the envelope's v/seq/cmd through unchanged", () => {
  const cmd = { t: "move", ids: ["u1"], x: 1, y: 2 };
  const envelope = encode(cmd, 9, 100);
  const record = stampRecord(envelope, "player", 103);
  assert.equal(record.v, PROTOCOL_VERSION);
  assert.equal(record.seq, 9);
  assert.deepEqual(record.cmd, cmd);
  assert.equal(record.result, null, "no result yet — the codec attaches it once the command actually applies");
});
