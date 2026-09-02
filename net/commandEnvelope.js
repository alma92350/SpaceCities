/* ============================================================
   T-020 (ADR-0006 §3.1, dossier 02 §3.1/§5.2): the wire ENVELOPE around a
   WireCommand (net/commandShapes.js) — versioned, id-based (ids are already
   load-bearing per-command), owner stamped by the SERVER only.

   Deliberately separate from net/commandCodec.js (T-021): this file knows
   only the SHAPE of the envelope and which command TYPES exist in the union —
   it never touches a live State, so it needs no game to test against.
   net/commandCodec.js is what validates a command's CONTENTS against live
   state (ownership, fog, affordability) and actually calls engine/commands.js.

   Client -> server: { v, seq, tick, cmd }. `tick` is ADVISORY ONLY — latency
   telemetry, never trusted for scheduling (dossier 02 §5.2: the server stamps
   `applyTick` itself at admission).

   Server -> log record: the same v/seq/cmd, with `owner` and `applyTick`
   ADDED — both stamped here from the authenticated session and the server's
   own clock, NEVER read from the client's envelope even if one happens to
   carry fields with those names. That is the actual security property (dossier
   02 §3.1: "a field a client can set is a field a client will lie about") —
   not that a claimed owner is checked and rejected, but that it is never
   consulted in the first place. See stampRecord's own test in
   test/commandEnvelope.test.js for the adversarial proof.
   ============================================================ */

"use strict";

export const PROTOCOL_VERSION = 1;

// Every wire command type that exists today (net/commandShapes.js's WireCommand
// union, "batch" included). Kept as a plain array here rather than derived from
// net/commandCodec.js's own SCHEMA table (T-021) so this file has zero dependency
// on that one — it can be tested, and used by a client, before the codec exists.
// Keep in sync with commandShapes.js's own WireCommand typedef by hand; the
// round-trip test's EXAMPLES table is the guard against the two drifting apart.
export const COMMAND_TYPES = Object.freeze([
  "move", "attackMove", "holdFormation", "patrol", "stop", "hold", "scout",
  "attack", "escort", "repair", "gather", "service", "ferry", "setHomeBase",
  "assistBuild", "build", "recycle", "cancelRecycle", "setAILogistics",
  "setCollectPoint", "setElectrified", "setLogiPriority", "setRally",
  "queueProduction", "cancelProduction", "researchUpgrade", "researchTech",
  "cancelResearch", "lightFuse", "batch",
]);
const KNOWN_TYPES = new Set(COMMAND_TYPES);
const MAX_BATCH = 16;

export const REJECT = Object.freeze({
  BAD_VERSION: "bad-version",
  MALFORMED: "malformed",
  UNKNOWN_TYPE: "unknown-type",
});

const ok = result => ({ ok: true, result });
const err = code => ({ ok: false, code });

/**
 * Client side: stamp an envelope around a WireCommand. Pure data — no game-state
 * access, no id resolution; that happens server-side in net/commandCodec.js.
 * @param {WireCommand} command
 * @param {number} seq - per-client monotonic counter, starts at 1
 * @param {number} [clientTick] - advisory only; null if omitted (survives JSON, unlike undefined)
 */
export function encode(command, seq, clientTick) {
  return { v: PROTOCOL_VERSION, seq, tick: clientTick ?? null, cmd: command };
}

// Shape-only validation, recursive for a batch's members. Does NOT know whether
// a command's own fields are individually well-formed beyond "does cmd.t name a
// real type" (ids, x/y, enum values, …) — that's net/commandCodec.js's SCHEMA
// table, which needs live state to run most of its checks anyway (fog,
// ownership) and so cannot live in this state-free file.
function validCommandShape(c) {
  if (!c || typeof c !== "object" || typeof c.t !== "string") return err(REJECT.MALFORMED);
  if (!KNOWN_TYPES.has(c.t)) return err(REJECT.UNKNOWN_TYPE);
  if (c.t === "batch") {
    if (!Array.isArray(c.c) || c.c.length === 0 || c.c.length > MAX_BATCH) return err(REJECT.MALFORMED);
    for (const sub of c.c) {
      if (sub && sub.t === "batch") return err(REJECT.MALFORMED);   // no nesting
      const inner = validCommandShape(sub);
      if (!inner.ok) return inner;
    }
  }
  return ok(c);
}

/**
 * Server side: envelope-shape validation only — version, seq, and that cmd.t
 * (recursively, for a batch) names a real command type. Runs on ARRIVAL, before
 * a malformed packet can be scheduled at all.
 * @param {Object} envelope
 * @returns {{ok:true, result:WireCommand}|{ok:false, code:string}}
 */
export function decode(envelope) {
  if (!envelope || typeof envelope !== "object") return err(REJECT.MALFORMED);
  if (envelope.v !== PROTOCOL_VERSION) return err(REJECT.BAD_VERSION);
  if (!Number.isInteger(envelope.seq) || envelope.seq < 0) return err(REJECT.MALFORMED);
  return validCommandShape(envelope.cmd);
}

/**
 * Server side: the LOG RECORD an admitted envelope becomes. `owner` and
 * `applyTick` are AUTHORITATIVE — stamped from the authenticated session and
 * the server's own clock, never read from `envelope`. `result` is attached
 * later by net/commandCodec.js once the command actually applies.
 * @param {Object} envelope @param {string} owner @param {number} applyTick
 */
export function stampRecord(envelope, owner, applyTick) {
  return { v: envelope.v, seq: envelope.seq, owner, applyTick, cmd: envelope.cmd, result: null };
}
