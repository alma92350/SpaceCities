/* ============================================================
   A session owns one match: the engine state, and the ONLY path anything
   outside engine/ has to mutate it. ADR-0003 (server authority) + ADR-0004
   (single-player rides the same seam) — this is the object both the
   in-process loopback transport (net/loopback.js) and, later, a real
   per-connection server handler (Phase 3) wrap.

   PHASE 2 SCOPE (ADR-0006). This file owns no command-application logic of
   its own any more — applyCommand is a thin, named re-export of
   net/commandCodec.js's apply(state, owner, command), the sole path from
   wire to engine. What THIS file adds on top is the one thing the codec
   cannot know on its own: which seat `owner` is. Today that is always
   `localOwner` (default "player" — D4, boot.js: today's client is a single
   local human who can only ever hold that seat; there is no per-connection
   multiplexing yet). A real per-connection server handler (Phase 3) is what
   replaces that constant with the seat the authenticated connection actually
   holds — ADR-0006 rule 2, "the server stamps the owner, always" — without
   this file's own shape changing at all.

   TICKING. A session does not own a loop (no requestAnimationFrame, no
   setInterval) — tick(dt) advances the sim by exactly one step and returns.
   The CALLER decides the cadence: boot.js's engine/loop.js accumulator in
   the browser, a plain interval for a headless server, or a tight while-loop
   for a bench/test. This mirrors how engine/sim.js's own tick(state, dt) has
   always worked — ticked externally, never self-driving.

   aiSeats lets a session drive MORE than the engine's own built-in "ai" seat
   (engine/sim.js's tick already calls runAI for owner "ai" internally) —
   e.g. aiSeats:["player"] reproduces tools/selfplay.js's tickSelfPlay for a
   fully headless AI-vs-AI match (T-010's own exit criterion), the same
   mechanism Phase 6's MCP-agent-vs-AI matches and Phase 3's server-hosted
   matches will both reuse.
   ============================================================ */

"use strict";

import { createGameState } from "../engine/state.js";
import { tick } from "../engine/sim.js";
import { runAI } from "../engine/ai.js";
import { apply } from "../net/commandCodec.js";

/**
 * Apply one WireCommand (net/commandShapes.js) to `state`, as `owner` — the seat the
 * caller is authenticated as, NEVER read from the command itself (ADR-0006 rule 2).
 * Delegates entirely to net/commandCodec.js. Exported standalone (not just as a session
 * method) so net/directTransport.js can reach it for the boot paths that have no session
 * object at all, without needing one just to apply a command.
 * @param {State} state @param {string} owner @param {WireCommand} cmd
 * @returns {CommandResult}
 */
export function applyCommand(state, owner, cmd) {
  return apply(state, owner, cmd);
}

/**
 * @param {Object} opts - everything engine/state.js's createGameState takes,
 *   plus:
 * @param {string[]} [opts.aiSeats] - extra owners to drive via runAI(state, dt, owner)
 *   on every tick, beyond the engine's own built-in "ai" seat. Empty for an
 *   ordinary human-vs-AI skirmish; ["player"] for a fully headless AI-vs-AI
 *   match (T-010's exit criterion, tools/selfplay.js's own pattern).
 * @param {string} [opts.localOwner="player"] - the seat this session's own submitCommand
 *   applies commands as (see this file's header — D4, no per-connection multiplexing yet).
 * @param {State} [opts.state] - wrap this ALREADY-BUILT state instead of building a fresh one
 *   from the rest of opts (which are ignored when this is given). For boot.js's loaded-game
 *   path (T-012): a deserialized save is reconstructed by engine/persist.js, not by
 *   createGameState(gameOpts) — there is no seed/rng to rebuild it from — so the session has to
 *   be able to wrap whatever state the caller already has in hand.
 */
export function createSession(opts = {}) {
  const { aiSeats = [], localOwner = "player", state: providedState, ...gameOpts } = opts;
  const state = providedState || createGameState(gameOpts);

  return {
    getState() {
      return state;
    },
    tick(dt) {
      for (const owner of aiSeats) runAI(state, dt, owner);
      tick(state, dt);
    },
    submitCommand(cmd) {
      return applyCommand(state, localOwner, cmd);
    },
  };
}
