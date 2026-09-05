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
   a loop. server/matchWorker.js's own pushState() drains `state.events` right after building every
   seat's (and the spectator's) projection each tick, so proj.events here is genuinely just that
   tick's own fresh events — NOT a growing whole-match history (an earlier version of this file
   deliberately kept the history growing forever for this waiter's own baseline-diff to lean on;
   that turned out to double as a live-match bug, since the SAME undrained state.events also fed
   every WS-relayed human client, replaying every past attack's tracer/sound on every single tick
   forever — see matchWorker.js's own pushState() comment). This waiter's baseline-vs-later-pushes
   diff still works exactly as before regardless: snapshot the events visible AT THE MOMENT
   waitForEvent is called (the "baseline", by VALUE — a Set of JSON strings, cheap for the small
   per-match event lists this game actually produces) and compare every later push for that seat
   against THAT FIXED baseline until something appears that was not in it, or the timeout elapses —
   this is what correctly aggregates "new since the call" across however many ticks land before the
   wait resolves, whether or not any single tick's own proj.events also happens to repeat something
   already seen.
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
