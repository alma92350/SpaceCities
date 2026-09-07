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

// Agent-observability (post-T-054 gap, observed in real agent play): the worker drains
// state.events after EVERY tick, and checkWaiters only delivers to a waiter registered at the
// moment a push lands — so an event firing while NO wait_for_event call is in flight used to be
// lost forever. Three recorded match losses happened exactly this way (every worker died between
// two polls; zero entityKilled events ever arrived). UNDELIVERED_EVENTS_CAP is a small per-seat
// ring of those events: pushes with no waiter present land here, and the seat's NEXT waitForEvent
// delivers the ones the latest projection no longer carries (waitForEvent's own comment). Bounded,
// because a match can produce events faster than an agent polls.
const UNDELIVERED_EVENTS_CAP = 256;

/**
 * @param {import("node:worker_threads").Worker} worker
 * @returns {{
 *   latestProjFor: (seat: string) => Object|null,
 *   waitForEvent: (seat: string, timeoutMs: number) => Promise<{tick: number|null, events: Object[], timedOut: boolean}>,
 *   mapMeta: () => {map: Object, nodesById: Map<string, Object>}|null,
 * }}
 */
export function attachProjectionCache(worker) {
  const bySeat = new Map();
  // Agent-observability: this match's own STATIC map reference (node commodity/position/max, map
  // bounds, tick rate), requested once here and answered by server/matchWorker.js's describeMap
  // handler. Held OUTSIDE bySeat because it is not per-seat and carries no fog: a caller
  // (server/mcpObservationTools.js) only ever merges it onto the node ids in a seat's OWN
  // fog-filtered projection, so an undiscovered node can never reach an answer through it.
  // Requested rather than pushed at boot because this listener is attached after an await in
  // tools/serve.js and would miss a one-shot message. null until the reply lands (a tool falls
  // back to the plain {id, amount} shape until then, never blocks on it).
  let mapMeta = null;
  /** @type {Map<string, Set<{baseline: Set<string>, settle: (r: Object) => void}>>} */
  const waitersBySeat = new Map();
  /** @type {Map<string, {tick: number, evs: Object[]}[]>} */
  const undeliveredBySeat = new Map();

  // Only pushes that arrived with NO waiter registered are "undelivered": if a waiter was
  // present, the fresh-diff below owned those events (and anything in its baseline is old news
  // that a later call's own baseline would suppress anyway — buffering it here would re-deliver).
  function recordUndelivered(seat, tick, evs) {
    if (evs.length === 0) return;
    if ((waitersBySeat.get(seat)?.size ?? 0) > 0) return;
    const buffer = undeliveredBySeat.get(seat) ?? [];
    buffer.push({ tick, evs });
    while (buffer.length > UNDELIVERED_EVENTS_CAP) buffer.shift();
    undeliveredBySeat.set(seat, buffer);
  }

  // Called at the top of waitForEvent — the seat's next call consumes whatever accumulated.
  function drainUndelivered(seat) {
    const buffer = undeliveredBySeat.get(seat);
    undeliveredBySeat.set(seat, []);
    return buffer ?? [];
  }

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
    if (msg && msg.type === "mapMeta") {
      mapMeta = { map: msg.map, nodesById: new Map(msg.nodes.map(n => [n.id, n])) };
      return;
    }
    // The spectator's own projection is a different, deliberately UNFILTERED audience
    // (engine/projection.js's projectForSpectator) — never cached under a real seat id, so it can
    // never be looked up as if it were some seat's own fog-safe view.
    if (!msg || msg.type !== "state" || msg.seat === SPECTATOR_SEAT) return;
    bySeat.set(msg.seat, msg.proj);
    recordUndelivered(msg.seat, msg.proj.tick, msg.proj.events || []);
    checkWaiters(msg.seat, msg.proj);
  });

  function waitForEvent(seat, timeoutMs) {
    const current = bySeat.get(seat) ?? null;
    // Events that fired while no waiter was in flight are buffered (see UNDELIVERED_EVENTS_CAP).
    // Deliver ONLY the ones NOT still visible in the latest projection: an event the latest proj
    // still carries is baseline (e.g. a fog scroll re-sending an already-known event — the
    // baseline-diff contract below), while one that already scrolled out happened and is gone —
    // nobody was waiting when it fired, and no future push will ever carry it again. With real
    // 20Hz pushes the latest proj moves on within one tick, so genuinely lost events pass this
    // filter; the residual gap (a call landing within the same tick) matches the old baseline
    // rule. The whole buffer drains either way: what survives is delivered, the rest is
    // baseline the caller can already see.
    const baseline = new Set((current?.events || []).map(ev => JSON.stringify(ev)));
    const buffered = drainUndelivered(seat);
    const lost = buffered
      .map(entry => ({ tick: entry.tick, evs: entry.evs.filter(ev => !baseline.has(JSON.stringify(ev))) }))
      .filter(entry => entry.evs.length > 0);
    if (lost.length > 0) {
      return Promise.resolve({
        tick: lost[lost.length - 1].tick,
        events: lost.flatMap(entry => entry.evs),
        timedOut: false,
      });
    }
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

  // Tolerates a test double with no postMessage at all — every caller before this existed passes
  // a real worker_threads Worker, and one that can't be asked simply leaves mapMeta null.
  if (typeof worker.postMessage === "function") worker.postMessage({ type: "describeMap" });

  return { latestProjFor: seat => bySeat.get(seat) ?? null, waitForEvent, mapMeta: () => mapMeta };
}
