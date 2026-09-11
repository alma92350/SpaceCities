/* ============================================================
   server/matchLoop.js — the ONLY place a wire command reaches the sim through the
   deterministic, multi-client-safe path (ADR-0006 §Decision rule 4; dossier
   docs/analysis/02-command-wire-protocol.md §5). Two responsibilities, kept apart:

   admit()     Client -> a PENDING queue. Validates envelope SHAPE only
               (net/commandEnvelope.js's decode) and stamps a server-controlled
               applyTick — never applies anything, never touches ownership/fog.
   stepMatch() PENDING -> the sim, once per fixed tick. Pulls every command whose
               stamped applyTick has arrived, sorts the whole batch into ONE
               total order, applies each through net/commandCodec.js (ownership/
               fog validated HERE, against live state, not admission-time state),
               logs it, THEN advances tick(state, dt).

   WHY A DELAY, NOT IMMEDIATE APPLICATION (dossier §5.2). Commands arrive from N
   clients over N sockets with no shared clock. Stamping `state.tick +
   INPUT_DELAY_TICKS` lets every command headed for the same tick be collected
   into one batch and sorted by a rule that depends on nothing but the log itself
   (never wall-clock arrival, which `test/engine-purity.test.js` already bans from
   the sim and which network jitter would make unreplayable). The server, not the
   client, stamps it — a client's own claimed tick is advisory telemetry at most,
   same rule ADR-0006 already applies to `owner`.

   WHY THE SORT KEY IS (applyTick, ownerIndex, seq), NOT ARRIVAL ORDER. `ownerIndex
   = state.owners.indexOf(owner)` is stable and seed-independent — the same array
   that already drives every other owner-generic loop in the engine. `seq` is the
   client's OWN per-connection monotonic counter, preserving *that client's*
   intent order (queuing move-then-attackMove on the same units means something
   different from the reverse). `(owner, seq)` is unique by construction, so no
   two records ever tie — admit() drops an exact-duplicate (owner, seq) resend
   idempotently rather than queuing it twice, the one piece of state this module
   keeps beyond the queue/log themselves.

   WHY BEFORE tick(), NEVER INSIDE IT. tick(state, dt) opens by running the AI
   (engine/sim.js), which issues its own orders through the same issue* surface.
   In single-player, DOM input handlers already fire BETWEEN update() calls (JS
   is single-threaded) — "commands land before the AI thinks" is the existing
   single-player ordering, not a change stepMatch invents.

   PHASE 2 SCOPE (this file's own moment in TASKS.md's plan). Built and tested
   as a standalone, correct module — same posture net/commandEnvelope.js and
   net/commandCodec.js each had for one phase before something wired them in for
   real. server/session.js's loopback path keeps its own immediate-apply
   submitCommand for now (ADR-0004: there is exactly one trusted local input
   source in single-player, so there is no ordering ambiguity for this module to
   resolve yet, and net/loopback.js's tested "synchronous underneath" contract is
   load-bearing for existing client code). This file becomes the real, live match
   loop once a real multi-socket server exists to admit from (T-026/T-029) —
   see test/static-integrity.test.js's temporary exemption for this file.
   ============================================================ */

"use strict";

import { tick } from "../engine/sim.js";
import { apply } from "../net/commandCodec.js";
import { decode, stampRecord } from "../net/commandEnvelope.js";

// 150ms at the engine's own 20Hz default (engine/loop.js) — covers typical RTT + jitter, and
// gives every spectator/relay a chance to see a command before it lands (dossier §5.2). 0 is a
// valid, still-correct configuration (everything just applies at the very next stepMatch); this
// default is a latency/batching-window choice, not a correctness requirement.
export const INPUT_DELAY_TICKS = 3;

// engine/loop.js's own default rate, and what docs/analysis/04-hf-deployment.md's F1 measured
// comfortable over the real HF edge — the one cadence every REAL (wall-clock-driven) stepMatch
// loop in this codebase drives at: tools/serve.js's single-process demo match (T-027) and
// server/matchWorker.js's own worker-hosted one (T-029) alike. Test fixtures deliberately use a
// much faster interval to avoid sitting around waiting — see e.g. test/wsTransport.test.js's own
// startTicking comment — so this is NOT exported for them to reuse.
export const TICK_HZ = 20;
export const TICK_DT = 1 / TICK_HZ;
export const TICK_MS = 1000 / TICK_HZ;

const ownerIndex = (state, owner) => state.owners.indexOf(owner);

// A log record's own `result` field is deliberately the SIMPLEST shape stepMatch itself needs —
// `null`/a success payload for an applied command, `{rejected: code}` for one the codec declined
// (see stepMatch's own comment). net/transport.js documents a different, client-facing
// CommandResult shape (`{ok, code?, result?}`) — this is the one place a match's internal log
// record ever has to speak that wire contract, shared by every caller that needs to (T-026's
// in-process transport and T-029's worker relay alike), rather than each reimplementing it.
/** @param {Object|null} recResult - a log record's own `.result` field @returns {{ok:boolean, code?:string, result?:*}} */
export function toCommandResult(recResult) {
  if (recResult && typeof recResult === "object" && "rejected" in recResult) {
    // `reason` (agent-observability) is the codec's own optional, human/machine-readable detail
    // BEHIND a coarse reject code — "refused" alone can't distinguish a locked unit from an
    // unaffordable one. Only present when the codec supplied one, so every existing rejection's
    // wire shape is byte-identical to before.
    return {
      ok: false,
      code: recResult.rejected,
      ...(recResult.reason ? { reason: recResult.reason } : {}),
      // `hint` (net/refusalHints.js) is the same refusal said in one action-oriented English
      // sentence — what blocked it and what to do instead. Same additive rule as `reason`:
      // only present when the codec supplied one.
      ...(recResult.hint ? { hint: recResult.hint } : {}),
    };
  }
  return { ok: true, result: recResult ?? null };
}

/**
 * @param {State} state
 * @param {Object} [opts]
 * @param {(rec: Object) => void} [opts.emitAck] - called once per applied/rejected record, in
 *   final log order, inside stepMatch — the hook a real server pushes acks/log entries out to
 *   sockets from. Defaults to a no-op; nothing in this module's own tests needs it wired further.
 */
export function createMatch(state, opts = {}) {
  return {
    state,
    pending: [],
    log: [],
    emitAck: opts.emitAck || (() => {}),
    seenSeq: new Map(),   // owner -> Set<seq>, admission-time dedupe only (see admit())
  };
}

/**
 * Admit one client envelope as `owner` — the seat the CALLER already authenticated the
 * connection as, never read from the envelope (ADR-0006 rule 2, same as net/commandCodec.js's
 * own `owner` parameter). Validates envelope SHAPE only (net/commandEnvelope.js's decode) and,
 * if valid, schedules it for application at `state.tick + INPUT_DELAY_TICKS` — this function
 * never calls engine/commands.js, never checks ownership or fog, and never touches `state`
 * beyond reading its current tick. Ownership/fog are checked later, inside stepMatch's apply()
 * call, against whatever is live AT that tick — not against state that may already be stale by
 * the time the command is actually due.
 *
 * An exact (owner, seq) resend — a client retrying after a dropped ack, most likely — is dropped
 * idempotently, admitted at most once, rather than silently double-applying a repeated command.
 * @returns {{ok:true}|{ok:false, code:string}} the shape-validation result only
 */
export function admit(match, envelope, owner) {
  const decoded = decode(envelope);
  if (!decoded.ok) return decoded;

  let seen = match.seenSeq.get(owner);
  if (!seen) { seen = new Set(); match.seenSeq.set(owner, seen); }
  if (seen.has(envelope.seq)) return { ok: true };   // already admitted once; not an error
  seen.add(envelope.seq);

  const applyTick = match.state.tick + INPUT_DELAY_TICKS;
  match.pending.push(stampRecord(envelope, owner, applyTick));
  return { ok: true };
}

/**
 * Pull every command scheduled at or before the CURRENT state.tick, order it deterministically,
 * apply it, append it to the log, THEN advance the sim by exactly one fixed step. Never applies
 * anything mid-tick, and never skips a command whose applyTick has already passed (a slow
 * admission, a resumed connection) — it still applies, sorted by its ORIGINAL applyTick, so the
 * log stays monotonic and a replay built from it is exact.
 * @param {ReturnType<createMatch>} match @param {number} dt
 */
export function stepMatch(match, dt) {
  const { state, pending, log } = match;

  const due = pending.filter(r => r.applyTick <= state.tick);
  if (due.length) {
    due.sort((a, b) =>
      a.applyTick - b.applyTick ||
      ownerIndex(state, a.owner) - ownerIndex(state, b.owner) ||
      a.seq - b.seq);
    for (const rec of due) {
      // A rejection is a fact about the match (anti-cheat forensics, and a spectator needs to
      // know why nothing happened) — it carries no state mutation, so it can't affect replay,
      // but it must still be PRESENT in the log for the log to be auditable (dossier §5.3).
      const res = apply(state, rec.owner, rec.cmd);
      rec.result = res.ok ? res.result : { rejected: res.code, ...(res.reason ? { reason: res.reason } : {}), ...(res.hint ? { hint: res.hint } : {}) };
      rec.appliedAtTick = state.tick;
      log.push(rec);
      match.emitAck(rec);
    }
    match.pending = pending.filter(r => r.applyTick > state.tick);
  }

  tick(state, dt);
}
