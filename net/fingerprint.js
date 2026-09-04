/* ============================================================
   net/fingerprint.js — T-040 (FR-20)'s desync check: a hash a SEAT can independently and correctly
   compute of its OWN corner of a match, cheap enough to send often and specific enough that a real
   divergence shows up.

   Deliberately NOT tools/selfplay.js's own fingerprint(state) (T-024's own tool, already used for
   replay-checkpoint verification) reused as-is — that function needs BOTH seats' full state
   (fogs, resources), plus state.ai/state.playerAi, server-only fields a network client never has at
   all (engine/projection.js's own wire payload never carries them). What a network client CAN
   always correctly compute is narrower but still real: its OWN units/buildings/resources are never
   fog-filtered (engine/projection.js's own ownOrVisible: "e.owner === seat || isVisibleAt(...)" — a
   seat's own entities pass unconditionally, sanitizeUnitForExternal/sanitizeBuildingForExternal
   never strip any field this file reads for them), so a seat-scoped fingerprint is the one slice of
   state a client can compute from either side of the wire and land on the exact same string, with
   zero divergence, PROVIDED nothing has actually gone wrong. Same per-entity string shape as
   tools/selfplay.js's own function (id|type|owner|x|y|hp|order / id|type|owner|hp|buildProgress|
   queue.length) — a mismatch here means the same kind of thing a mismatch there would.

   QUANTIZE_DP=2 rounding, duplicated from engine/projectionDelta.js's own QUANTIZE_DP rather than
   imported: this file runs on BOTH sides of the wire, and only ONE of them (the server, reading raw
   state.units/state.buildings directly) has NOT already been through quantizeForWire's own
   rounding — the client's own reconstructed state (net/wsClientTransport.js) already IS the
   quantized wire values, verbatim. Rounding to the same precision on both sides is what makes the
   comparison meaningful rather than comparing "infinite server precision" against "the necessarily
   coarser copy that went over the wire" — a moving unit's raw x/y is a continuous float that almost
   never lands exactly on a 2-decimal grid, so without this every legitimate, perfectly-synced
   client would look diverged on position alone. The rounding is idempotent (rounding an
   already-rounded value again is a no-op), so applying it unconditionally on BOTH sides is always
   safe, never a source of false divergence by itself, and needs no "which side am I on" branch.
   ============================================================ */

"use strict";

const QUANTIZE_DP = 2;
const QUANTIZE_FACTOR = 10 ** QUANTIZE_DP;
const round = v => Math.round(v * QUANTIZE_FACTOR) / QUANTIZE_FACTOR;

/**
 * @param {State} state - either the server's own live match.state, or a client's own reconstructed
 *   state (net/wsClientTransport.js's reassembleProjection output) — same shape either way for the
 *   fields this reads.
 * @param {string} seat @returns {string}
 */
export function seatFingerprint(state, seat) {
  const units = [...state.units.values()]
    .filter(u => u.owner === seat)
    .map(u => `${u.id}|${u.type}|${u.owner}|${round(u.x)}|${round(u.y)}|${round(u.hp)}|${u.order ? u.order.type : "-"}`)
    .sort();
  const builds = [...state.buildings.values()]
    .filter(b => b.owner === seat)
    .map(b => `${b.id}|${b.type}|${b.owner}|${round(b.hp)}|${round(b.buildProgress)}|${b.queue.length}`)
    .sort();
  const res = JSON.stringify(state.players[seat].resources);
  return JSON.stringify({ units, builds, res, tick: state.tick });
}
