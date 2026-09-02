/* ============================================================
   The Transport-shaped adapter for a `state` that has no server/session.js session behind it
   yet. TASKS.md T-012 ports the ordinary skirmish/competition/loaded-skirmish boot paths onto a
   real session + net/loopback.js — Odyssey, a scenario/raider/bounty, and a spectated match are
   explicitly excluded from that pass (they keep ticking on their own existing path: stepGalaxy,
   tickSelfPlay, or engine/sim.js's tick called directly by boot.js's loop). Those boot paths
   still wire up input.js/inputCommands.js/hudSelection.js, which now ALWAYS call
   transport.submitCommand(cmd) — never an engine/commands.js issue* function directly — so this
   file exists purely to give them something submitCommand-shaped to call that has no session,
   no tick, no aiSeats: just server/session.js's own applyCommand(state, cmd), Promise-wrapped.

   Same synchronous-underneath guarantee net/loopback.js documents and proves (see its header,
   and test/loopback.test.js): the mutation happens and is visible to the caller BEFORE the
   returned promise ever resolves. That is what lets input.js's placeBuildingAt (and every other
   fire-and-forget call site) behave identically whether the state behind it is session-backed or
   not — this adapter, not the caller, is what would need to change if one of these boot paths
   were ever ported onto a real session later.

   Deliberately NOT net/loopback.js with a null session: loopback's tick()/getState() extensions
   promise a live session underneath (T-012's own header on that file), and this has none — a
   separate, smaller shape says that honestly instead of leaving two dead methods on the object.

   `owner` defaults to "player" for the same reason server/session.js's own localOwner does
   (D4, boot.js: every boot path this adapter serves is still a single local human who can only
   ever hold that seat) — every command submitted through it now runs through
   net/commandCodec.js's real ownership/fog checks via server/session.js's applyCommand, not the
   unvalidated pass-through this adapter used before ADR-0006's codec existed.
   ============================================================ */

"use strict";

import { applyCommand } from "../server/session.js";

/**
 * @param {State} state - a bare engine/state.js-shaped state, ticked by the CALLER on
 *   whichever path it already uses (this adapter never ticks anything itself).
 * @param {string} [owner="player"] - the seat every command submitted through this transport
 *   applies as.
 * @returns {Transport}
 */
export function createDirectTransport(state, owner = "player") {
  return {
    submitCommand(cmd) {
      return Promise.resolve(applyCommand(state, owner, cmd));
    },
    onEvent() {},
    close() {},
  };
}
