/* ============================================================
   T-052 (FR-14): the bridge between a live match's own worker_threads Worker (where the real
   engine State lives, server/matchWorker.js) and a request/response MCP tool call arriving on the
   main thread, where it does not. The worker already posts {type:"state", seat, proj} out
   unprompted every tick, for every seat — proj is engine/projection.js's own projectFor(state,
   seat) output, already fog-filtered (own entities unfiltered, an enemy's only if currently
   visible). net/wsWorkerTransport.js relays that same stream to a live WebSocket connection; this
   is the OTHER consumer, remembering only the LATEST one per seat so an observation tool can read
   it on demand — no new fog logic here at all, this file never looks at a raw unit/building.
   ============================================================ */

"use strict";

import { SPECTATOR_SEAT } from "../engine/projection.js";

/**
 * @param {import("node:worker_threads").Worker} worker
 * @returns {{latestProjFor: (seat: string) => Object|null}}
 */
export function attachProjectionCache(worker) {
  const bySeat = new Map();
  worker.on("message", msg => {
    // The spectator's own projection is a different, deliberately UNFILTERED audience
    // (engine/projection.js's projectForSpectator) — never cached under a real seat id, so it can
    // never be looked up as if it were some seat's own fog-safe view.
    if (msg && msg.type === "state" && msg.seat !== SPECTATOR_SEAT) bySeat.set(msg.seat, msg.proj);
  });
  return { latestProjFor: seat => bySeat.get(seat) ?? null };
}
