/* ============================================================
   server/replay.js — the payoff of ADR-0006's server-stamped, deterministic-order design
   (docs/analysis/02-command-wire-protocol.md §7): a seed plus its ordered command log IS a
   complete match. This file is deliberately small because server/matchLoop.js already does
   all the real work — recordReplay just captures what a fresh createGameState + a replayed
   stepMatch loop needs to reproduce a match bit-for-bit; replayMatch reconstructs exactly that
   and drives it with the SAME stepMatch a live match already uses (T-023), never a parallel
   apply loop that could quietly drift from it.

   SCOPE (T-024). Covers an ordinary skirmish match — createGameState(opts) with no further
   setup. Tier 1 self-play's postCreate mutations (tools/selfplay.js populating state.playerAi
   AFTER createGameState returns) are dossier 02 §7.2's own documented extension point, not
   implemented here: the self-play/duel ladder has its own persistence today
   (competitionLedger.js) and doesn't ask for this mechanism. Extend `sim` with a `postCreate`
   list (dossier 02 §7.2) if that ever changes — this file's replayMatch already refuses an
   unrecognized replay shape rather than silently reconstructing the wrong match, so that
   extension is additive, not a rewrite.

   Also out of THIS pass, for the same reason: periodic checkpoints (dossier 02 §7.3 point 7) for
   localizing a divergence faster than "somewhere in the whole match". T-024's own exit criterion
   is exact replay, not fast debugging of a broken one — a checkpoint list is additive on top of
   this shape (`commands` is unaffected either way) whenever that need actually arrives.

   engineVersion uses this repo's own existing release identifier (version.js's APP_VERSION,
   already the source of truth save/load compatibility checks against) rather than a git commit
   hash — the dossier's own suggestion, but one that assumes a `.git` checkout is present at
   runtime, which a deployed container image is not guaranteed to have.
   ============================================================ */

"use strict";

import { createGameState } from "../engine/state.js";
import { mulberry32 } from "../engine/rng.js";
import { createMatch, stepMatch } from "./matchLoop.js";
import { PROTOCOL_VERSION } from "../net/commandEnvelope.js";
import { APP_VERSION } from "../version.js";

export const REPLAY_VERSION = 1;

export const REPLAY_REJECT = Object.freeze({
  MALFORMED: "malformed",
  BAD_REPLAY_VERSION: "bad-replay-version",
  BAD_ENGINE_VERSION: "bad-engine-version",
});

/**
 * Capture everything needed to reproduce `match` from nothing but this object: the engine build,
 * the wire protocol version, every createGameState option (not just the seed — sizeMult/
 * resourceMult/swapAsym all shape the map too), the fixed step this match was ticked at, the
 * full ordered command log (server/matchLoop.js's stepMatch already produces it in
 * (applyTick, ownerIndex, seq) order — REJECTIONS INCLUDED, on purpose: they're audit evidence
 * and cost nothing to replay, since apply() re-rejects them identically), and the outcome so far.
 * Safe to call on a match that hasn't ended yet — outcome.over just reads false.
 * @param {Object} opts
 * @param {ReturnType<import("./matchLoop.js").createMatch>} opts.match
 * @param {number} opts.dt - the FIXED step this match is ticked at; never varies mid-match (T-023 §5.4)
 * @param {Object} opts.createGameStateOpts - the exact opts this match's own createGameState(...) used
 *   — `rng` is dropped even if present (see replayMatch's own note on why a live closure can
 *   never be part of a replay; `seed` is what actually reconstructs it)
 */
export function recordReplay({ match, dt, createGameStateOpts }) {
  const { state } = match;
  const { rng, ...jsonSafeOpts } = createGameStateOpts;
  return {
    replayVersion: REPLAY_VERSION,
    engineVersion: APP_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    dt,
    createGameState: jsonSafeOpts,
    commands: match.log.map(rec => ({ ...rec })),   // a detached copy — the live match keeps logging
    outcome: { tick: state.tick, over: state.over, winner: state.winner, winReason: state.winReason ?? null },
  };
}

/**
 * Reconstruct a match from a recordReplay() payload and drive it, through the SAME
 * server/matchLoop.js stepMatch a live match uses, to the recorded outcome tick. Refuses to
 * replay across an engine version mismatch (a balance/behavior change silently invalidates a
 * stored log) or a malformed payload, rather than producing a plausible lie.
 *
 * ALWAYS reconstructs `rng` as a fresh `mulberry32(seed)`, never anything the payload itself
 * might carry under that key. mulberry32 returns a STATEFUL closure (engine/rng.js — each call
 * advances it), so it can never round-trip through JSON in the first place; even in-process,
 * reusing the SAME live rng a caller's own createGameState(...) already partly consumed (the
 * obvious thing to do with the very opts object already in hand) would replay the map from a
 * shifted point in the sequence — identical seed, subtly different game. `seed` alone is what
 * actually reconstructs the sequence; this is why recordReplay strips `rng` before it ever
 * reaches here.
 * @param {Object} replay - recordReplay's own output shape
 * @returns {{ok:true, state:State}|{ok:false, code:string}}
 */
export function replayMatch(replay) {
  if (!replay || typeof replay !== "object") return { ok: false, code: REPLAY_REJECT.MALFORMED };
  if (!Number.isInteger(replay.replayVersion)) return { ok: false, code: REPLAY_REJECT.MALFORMED };
  if (replay.replayVersion !== REPLAY_VERSION) return { ok: false, code: REPLAY_REJECT.BAD_REPLAY_VERSION };
  if (replay.engineVersion !== APP_VERSION) return { ok: false, code: REPLAY_REJECT.BAD_ENGINE_VERSION };
  if (!replay.createGameState || typeof replay.createGameState !== "object") return { ok: false, code: REPLAY_REJECT.MALFORMED };
  if (!Number.isInteger(replay.createGameState.seed)) return { ok: false, code: REPLAY_REJECT.MALFORMED };
  if (!Array.isArray(replay.commands)) return { ok: false, code: REPLAY_REJECT.MALFORMED };
  if (!replay.outcome || !Number.isInteger(replay.outcome.tick) || replay.outcome.tick < 0) {
    return { ok: false, code: REPLAY_REJECT.MALFORMED };
  }
  if (!Number.isFinite(replay.dt) || replay.dt <= 0) return { ok: false, code: REPLAY_REJECT.MALFORMED };

  const state = createGameState({ ...replay.createGameState, rng: mulberry32(replay.createGameState.seed) });
  const match = createMatch(state);
  // A fresh copy per replay call — stepMatch mutates each record (result, appliedAtTick) and
  // reassigns match.pending as commands clear, and a caller may legitimately replay the same
  // stored payload more than once.
  match.pending = replay.commands.map(rec => ({ ...rec }));
  const targetTick = replay.outcome.tick;
  while (state.tick < targetTick && !state.over) stepMatch(match, replay.dt);
  return { ok: true, state };
}
