/* ============================================================
   T-052 (FR-14): the bridge between a live match's own worker_threads Worker (where the real
   engine State lives, server/matchWorker.js) and a request/response MCP tool call arriving on the
   main thread, where it does not. The worker already posts {type:"state", seat, proj} out
   unprompted every tick, for every seat — proj is engine/projection.js's own projectFor(state,
   seat) output, already fog-filtered (own entities unfiltered, an enemy's only if currently
   visible). net/wsWorkerTransport.js relays that same stream to a live WebSocket connection; this
   is the OTHER consumer, remembering only the LATEST one per seat so an observation tool can read
   it on demand — no new fog logic here at all, this file never looks at a raw unit/building.

   T-054 (FR-17): waitForEvent is a second capability on the SAME per-tick stream, for the SAME
   reason wait_for_event needs it — reacting to something happening beats polling get_situation in
   a loop. `state.events` is never drained server-side (only the single-player client, boot.js,
   ever does `state.events.length = 0`), so it accumulates for a match's whole lifetime, and
   engine/projection.js's own per-seat filter re-applies fresh against that growing history EVERY
   tick using THAT tick's real-time fog (fog.js: "visible... recomputed fresh every tick", unlike
   the permanent `explored` flag) — so a seat's own filtered proj.events can grow OR shrink tick to
   tick as units move in and out of sight. That rules out any array-length/index cursor as unsafe
   (an index doesn't name a stable element across ticks). What's safe: snapshot the events visible
   AT THE MOMENT waitForEvent is called (the "baseline", by VALUE — a Set of JSON strings, cheap
   for the small per-match event lists this game actually produces) and compare every later push
   for that seat against THAT FIXED baseline — never a moving one — until something appears that
   was not in it, or the timeout elapses. No invented event ids, no assumption the history only
   grows: the wait only ever asks "is there something in view now that was not in view when I
   called," which is exactly the fog-of-war-correct meaning of "new to this seat," and a fixed
   baseline means an event that scrolls out of fog and back in UNCHANGED never falsely re-fires.
   ============================================================ */

"use strict";

import { SPECTATOR_SEAT } from "../engine/projection.js";

/**
 * @param {import("node:worker_threads").Worker} worker
 * @returns {{
 *   latestProjFor: (seat: string) => Object|null,
 *   waitForEvent: (seat: string, timeoutMs: number) => Promise<{tick: number|null, events: Object[], timedOut: boolean}>,
 * }}
 */
export function attachProjectionCache(worker) {
  const bySeat = new Map();
  /** @type {Map<string, Set<{baseline: Set<string>, settle: (r: Object) => void}>>} */
  const waitersBySeat = new Map();

  function checkWaiters(seat, proj) {
    const waiters = waitersBySeat.get(seat);
    if (!waiters || waiters.size === 0) return;
    for (const waiter of [...waiters]) {
      const fresh = (proj.events || []).filter(ev => !waiter.baseline.has(JSON.stringify(ev)));
      if (fresh.length > 0) {
        waiters.delete(waiter);
        waiter.settle({ tick: proj.tick, events: fresh, timedOut: false });
      }
    }
  }

  worker.on("message", msg => {
    // The spectator's own projection is a different, deliberately UNFILTERED audience
    // (engine/projection.js's projectForSpectator) — never cached under a real seat id, so it can
    // never be looked up as if it were some seat's own fog-safe view.
    if (!msg || msg.type !== "state" || msg.seat === SPECTATOR_SEAT) return;
    bySeat.set(msg.seat, msg.proj);
    checkWaiters(msg.seat, msg.proj);
  });

  function waitForEvent(seat, timeoutMs) {
    const current = bySeat.get(seat) ?? null;
    const baseline = new Set((current?.events || []).map(ev => JSON.stringify(ev)));
    return new Promise(resolve => {
      let waiter;
      const timer = setTimeout(() => {
        waitersBySeat.get(seat)?.delete(waiter);
        resolve({ tick: current?.tick ?? null, events: [], timedOut: true });
      }, timeoutMs);
      waiter = { baseline, settle: result => { clearTimeout(timer); resolve(result); } };
      if (!waitersBySeat.has(seat)) waitersBySeat.set(seat, new Set());
      waitersBySeat.get(seat).add(waiter);
    });
  }

  return { latestProjFor: seat => bySeat.get(seat) ?? null, waitForEvent };
}
