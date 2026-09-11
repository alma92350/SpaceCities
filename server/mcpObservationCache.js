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

// Agent-observability: how far back the income estimate below looks. A seat's resources are
// reported as a STOCK ("you have 150 ore"), which is the one number an agent can already see and
// the wrong one to plan against — a recorded loss ran its whole economy into the ground without
// ever noticing, because 150 ore looks identical whether it took 10 seconds or 90 to accumulate.
// A flow needs two samples over a window: long enough that a single 40-ore haul landing doesn't
// read as a boom, short enough to notice a worker line dying. 30s is roughly three haul cycles.
const INCOME_WINDOW_MS = 30000;
// One sample per push would be 20/s of pure garbage; the estimate only needs the ends of the
// window, so samples are taken at this cadence and old ones dropped.
const INCOME_SAMPLE_MS = 1000;

// Agent-observability: how long an enemy sighting stays in the seat's memory after it leaves fog.
// Nothing is invented here — every entry was genuinely visible to this seat at the tick it was
// recorded — but a sighting from four minutes ago is not intelligence, it is a rumour, so it
// expires rather than accumulating into a false map of a base that has since moved or died.
const LAST_SEEN_TTL_MS = 180000;
const LAST_SEEN_CAP = 256;

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
  // Agent-observability, all three derived from the SAME per-tick projections this cache already
  // receives — no new worker traffic, no new fog reasoning, and nothing recorded for a seat that
  // was not already handed it in its own projection.
  /** @type {Map<string, {atMs: number, tick: number, resources: Object}[]>} */
  const incomeSamplesBySeat = new Map();
  /** @type {Map<string, Map<string, Object>>} */
  const lastSeenBySeat = new Map();
  /** @type {Map<string, Map<string, {sig: string, tick: number}>>} */
  const entitySigBySeat = new Map();
  /** @type {Map<string, {tick: number, ids: string[]}[]>} */
  const removedBySeat = new Map();
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

  function recordIncome(seat, proj) {
    const resources = proj.players?.[seat]?.resources;
    if (!resources) return;   // a spectator projection has no single "your resources" to sample
    const now = Date.now();
    const samples = incomeSamplesBySeat.get(seat) ?? [];
    const last = samples[samples.length - 1];
    if (last && now - last.atMs < INCOME_SAMPLE_MS) return;
    samples.push({ atMs: now, tick: proj.tick, resources: { ...resources } });
    while (samples.length > 1 && now - samples[0].atMs > INCOME_WINDOW_MS) samples.shift();
    incomeSamplesBySeat.set(seat, samples);
  }

  // Only entities the projection ACTUALLY CARRIED are remembered, so this can never see further
  // than the seat itself did: engine/projection.js has already dropped every enemy outside fog by
  // the time this runs.
  function recordSightings(seat, proj) {
    if (seat === SPECTATOR_SEAT) return;   // a watcher sees everything already; remembering it adds nothing
    const seen = lastSeenBySeat.get(seat) ?? new Map();
    const now = Date.now();
    // Every field is read defensively: a projection is shaped by engine/projection.js in
    // production, but this cache is also driven by deliberately minimal test doubles, and a
    // missing field must degrade to "nothing to record" rather than throwing inside a message
    // listener where nobody can catch it.
    for (const e of [...(proj.units ?? []), ...(proj.buildings ?? [])]) {
      if (e.owner === seat) continue;
      // Re-inserted (delete first) so Map order stays "oldest sighting first" for the eviction below.
      seen.delete(e.id);
      seen.set(e.id, { id: e.id, type: e.type, owner: e.owner, x: e.x, y: e.y, hp: e.hp, tick: proj.tick, time: proj.time, atMs: now });
    }
    for (const [id, entry] of [...seen]) if (now - entry.atMs > LAST_SEEN_TTL_MS) seen.delete(id);
    while (seen.size > LAST_SEEN_CAP) seen.delete(seen.keys().next().value);
    lastSeenBySeat.set(seat, seen);
  }

  // A per-entity "what did this look like last time" signature, so a caller can ask for what
  // CHANGED since a tick it already knows instead of re-reading the whole world every wake. The
  // signature is deliberately coarse (position rounded, hp rounded) — an agent does not need to
  // hear that a unit moved four pixels, and a strict comparison would report every entity every
  // tick, which is the thing this exists to avoid.
  function recordChanges(seat, proj) {
    const sigs = entitySigBySeat.get(seat) ?? new Map();
    const present = new Set();
    for (const e of [...(proj.units ?? []), ...(proj.buildings ?? [])]) {
      present.add(e.id);
      const sig = `${Math.round(e.x / 16)},${Math.round(e.y / 16)},${Math.round(e.hp)},${e.order?.type ?? e.activity ?? ""}`;
      const prev = sigs.get(e.id);
      if (!prev || prev.sig !== sig) sigs.set(e.id, { sig, tick: proj.tick });
    }
    const gone = [];
    for (const id of [...sigs.keys()]) if (!present.has(id)) { sigs.delete(id); gone.push(id); }
    entitySigBySeat.set(seat, sigs);
    if (gone.length) {
      // Kept as a short trail rather than a single last value: a caller asking "what changed since
      // tick N" needs every disappearance since N, not only the most recent one.
      const trail = removedBySeat.get(seat) ?? [];
      trail.push({ tick: proj.tick, ids: gone });
      while (trail.length > 64) trail.shift();
      removedBySeat.set(seat, trail);
    }
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
    if (!msg || msg.type !== "state") return;
    // The spectator's own projection is a different, deliberately UNFILTERED audience
    // (engine/projection.js's projectForSpectator). It is cached under the SPECTATOR_SEAT key and
    // NOWHERE else — so it can still never be looked up as if it were some real seat's own
    // fog-safe view, while a watch handle (server/mcpSeatHandle.js's mintWatchHandle, whose own
    // `owner` IS that pseudo-seat) can read and wait on it exactly like a player reads its own.
    // Before this it was dropped entirely, which is why watching a match over MCP was impossible
    // even though the worker had been publishing the stream for it all along.
    bySeat.set(msg.seat, msg.proj);
    recordIncome(msg.seat, msg.proj);
    recordSightings(msg.seat, msg.proj);
    recordChanges(msg.seat, msg.proj);
    recordUndelivered(msg.seat, msg.proj.tick, msg.proj.events || []);
    checkWaiters(msg.seat, msg.proj);
  });

  // The terminal event the ENGINE never emits: engine/victory.js's finish() sets state.over/winner
  // and pushes nothing, because every in-browser consumer already reads state.over off the frame
  // it is rendering anyway. An MCP agent has no frame — it sits in wait_for_event — so without
  // this a decided match is indistinguishable from a quiet one, and an agent waits out its full
  // timeout again and again against a match that will never produce another event as long as it
  // keeps asking. Synthesised here rather than in the engine so no rendering/consumer path
  // changes: a projection already carries everything the event needs.
  function endedEventFor(proj) {
    return { type: "matchEnded", winner: proj.winner ?? null, winReason: proj.winReason ?? null, tick: proj.tick, time: proj.time };
  }

  function waitForEvent(seat, timeoutMs) {
    const current = bySeat.get(seat) ?? null;
    // A finished match resolves IMMEDIATELY, every time, rather than blocking: nothing further can
    // ever happen in it, so the only honest answers are "it is over" now or "nothing yet" in eight
    // seconds, forever. Returning it on every call (rather than once) keeps this idempotent for an
    // agent that asks twice, and costs nothing — the agent reads `over` and stops.
    if (current?.over) {
      return Promise.resolve({ tick: current.tick, events: [endedEventFor(current)], timedOut: false });
    }
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

  // Per-minute income per commodity, measured across the sampling window above — null for a
  // commodity (or a seat) with too little history to say anything honest yet, never a made-up 0.
  function incomeFor(seat) {
    const samples = incomeSamplesBySeat.get(seat) ?? [];
    if (samples.length < 2) return null;
    const first = samples[0], last = samples[samples.length - 1];
    const minutes = (last.atMs - first.atMs) / 60000;
    if (minutes <= 0) return null;
    // GROSS income, summed from the positive step between consecutive samples — deliberately not
    // the treasury's net movement over the window. A seat that earned 400 ore and spent 500 on a
    // Foundry has a net rate of -100/min, and answering "how long until you can afford the next
    // one" with a negative rate says "never", which is both wrong and exactly the answer that
    // would have talked a recorded match out of the build that could have saved it. What a
    // purchase decision needs is the rate the workers are actually delivering at.
    const rates = {};
    for (const com of Object.keys(last.resources)) {
      let gained = 0;
      for (let i = 1; i < samples.length; i++) {
        gained += Math.max(0, (samples[i].resources[com] ?? 0) - (samples[i - 1].resources[com] ?? 0));
      }
      rates[com] = Math.round(gained / minutes);
    }
    return { per_min: rates, window_seconds: Math.round((last.atMs - first.atMs) / 100) / 10 };
  }

  // Every enemy entity this seat has ever had in fog, newest sighting per id, with how stale each
  // one is. The staleness is the whole point — see LAST_SEEN_TTL_MS.
  function lastSeenFor(seat) {
    const seen = lastSeenBySeat.get(seat);
    if (!seen) return [];
    const now = Date.now();
    return [...seen.values()]
      .map(e => ({ id: e.id, type: e.type, owner: e.owner, x: e.x, y: e.y, hp: e.hp, tick: e.tick,
                   age_seconds: Math.round((now - e.atMs) / 100) / 10 }))
      .sort((a, b) => a.age_seconds - b.age_seconds);
  }

  // Which entity ids changed (or vanished) since a tick the caller already has. A caller passing a
  // tick this cache has no history for gets `null`, meaning "no delta available, read it all" —
  // never a silently empty delta, which would read as "nothing changed".
  function changesSince(seat, sinceTick) {
    const sigs = entitySigBySeat.get(seat);
    if (!sigs) return null;
    const changed = new Set();
    for (const [id, entry] of sigs) if (entry.tick > sinceTick) changed.add(id);
    const removed = (removedBySeat.get(seat) ?? []).filter(e => e.tick > sinceTick).flatMap(e => e.ids);
    return { changed, removed: [...new Set(removed)] };
  }

  return { latestProjFor: seat => bySeat.get(seat) ?? null, waitForEvent, mapMeta: () => mapMeta,
           incomeFor, lastSeenFor, changesSince };
}
