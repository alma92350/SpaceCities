/* ============================================================
   net/wsClientTransport.js — the CLIENT half of T-026's WebSocket transport, implementing
   net/transport.js's Transport interface exactly (submitCommand/onEvent/close) so client code
   written against it is unable to tell it apart from net/loopback.js's — that IS T-026's own exit
   criterion: "swapping loopback -> WebSocket changes no client code above the transport."

   Loopback delivers the live engine State object as-is (net/loopback.js's own header). A
   WebSocket instead delivers JSON — net/wsServerTransport.js's `{type:"welcome",...}` /
   `{type:"state",...}` / `{type:"commandResult",...}` wire messages — so THIS file is where the
   gap gets closed: createWsClientTransport awaits the one-time "welcome" message to learn the
   match's createGameState opts and regenerate its map locally (engine/projection.js's own
   projectFor never sends the map — ADR-0009, deterministic from opts the client already has by
   then), and every subsequent "state" message is reassembled (engine/projection.js's
   reassembleProjection) into the exact same shape a loopback StateEvent's `state` field already
   has before it is ever handed to onEvent. Nothing above this file ever sees the wire shape.

   ADR-0009 M2 (T-028a): the fog grid isn't part of that wire shape either any more — this file
   also creates and holds this seat's own persistent Fog (createFog(map), right alongside map
   itself, at welcome time) and hands it to reassembleProjection on every "state" message, which
   recomputes it from the wire's own units/buildings via engine/fog.js's updateFog, the exact same
   pure function the server runs. One object, reused and mutated in place for the life of this
   connection — explored accumulates monotonically, the same guarantee state.fogs[owner] already
   gives server-side.

   ADR-0009 M3 (T-028b): a "state" message now carries EITHER a full projectFor(...) payload
   (`full:true, proj`) or a delta against the last one this connection was sent (`full:false,
   delta`) — net/wsServerTransport.js's own header explains why. This file holds `lastProj`, the
   last reconstructed snapshot, and either replaces it outright (full) or folds the delta into it
   (engine/projectionDelta.js's applyDelta) before handing the result to reassembleProjection —
   which never sees the difference, since by the time it runs the wire-level full/delta split is
   already resolved into an ordinary projectFor-shaped object.

   Async on purpose, unlike createLoopbackTransport: establishing a real socket and waiting for
   that first welcome message is genuinely asynchronous, where loopback wraps an
   already-constructed session synchronously. The resolved Transport's own methods stay
   synchronous-shaped (submitCommand still returns a Promise, per the interface), matching every
   other implementation.

   T-029b: AUTOMATIC RECONNECT, once the first handshake has succeeded. ADR-0012 deliberately makes
   restart-resume and player-reconnect the SAME mechanism ("the rarely-exercised path is covered by
   the constantly-exercised one") — this file doesn't try to tell a network blip apart from the
   server process itself restarting after a crash or deploy; either way the socket just closes, and
   either way the right response is the same: retry the same URL after a short fixed delay,
   indefinitely, until it succeeds. (A max-retry cutoff or backoff schedule is deliberately NOT
   built here — T-060, Phase 4, is the named future task for that kind of sleep/wake UX polish; this
   file's own job is the MECHANISM, not the retry policy.)

   The reconnect's own welcome message carries the match's matchId (net/wsServerTransport.js,
   server/matchWorker.js) — compared against whatever this file saw on the PREVIOUS welcome to tell
   "I rejoined the exact same match" from "this is a different match that happens to share a URL"
   (the second case is real: a server that restarted with no snapshot to recover, or one hosting a
   brand-new match at the same address). Two new events reach onEvent() beyond the shared Transport
   contract (net/transport.js) — WS-transport-specific, safely ignorable by a caller that only knows
   the universal StateEvent/CommandResultEvent shapes, the same way a loopback caller never sees
   them at all since net/loopback.js has no real network to drop:
     {type:"disconnected"}                     the connection just dropped unexpectedly; a retry is
                                                already scheduled — fired at most once per outage,
                                                not spammed again on every failed retry attempt
     {type:"reconnected", matchId, sameMatch}  a NEW welcome just arrived on a reconnect attempt.
                                                sameMatch is whether matchId matches the one this
                                                connection saw before. On a same-match reconnect this
                                                file deliberately KEEPS the existing `fog` object
                                                (and its `map`, since matchId only ever matches when
                                                createGameState's own opts — seed included — are
                                                identical too) rather than recreating it — a client's
                                                own accumulated exploration memory is exactly the
                                                kind of state engine/fog.js's own single-player
                                                semantics already never reset, and a restart/blip
                                                that lands back in the same match shouldn't either.
                                                A DIFFERENT matchId gets a fresh fog (and map) — an
                                                old match's exploration memory means nothing against
                                                a new one's geometry.
   `lastProj` (T-028b's own delta baseline) is reset to null on every reconnect regardless — the
   server's own onclose-driven cleanup (net/wsServerTransport.js's lastSnapshotBySeat) already
   guarantees the FIRST push on any new connection is a fresh full snapshot, never a delta against a
   dead connection's stale one, so this is belt-and-suspenders clarity more than a load-bearing
   reset.

   connectTimeoutMs (opt-in, default unbounded — unchanged for every caller that omits it): bounds
   patience for the FIRST handshake only, never a later reconnect (T-029b's own automatic retry is
   deliberately unbounded/un-backed-off, per this header above — this opt must not shorten that).
   Added chasing a real, environment-specific flake: a caller can hit the underlying native
   WebSocket's own effectively-unbounded connect timeout (observed ~300s) when the SERVER is merely
   slow to service the upgrade for a while (e.g. a sandboxed CI box under heavy parallel test load),
   not genuinely unreachable — a caller that would rather fail fast and retry itself (test/
   wsReconnect.test.js's own new tests; test/wsWorkerTransport.test.js's "two concurrent matches"
   test) can now do that instead of waiting out the native default.
   ============================================================ */

"use strict";

import { generateMap } from "../engine/map.js";
import { mulberry32 } from "../engine/rng.js";
import { createFog } from "../engine/fog.js";
import { reassembleProjection } from "../engine/projection.js";
import { applyDelta } from "../engine/projectionDelta.js";
import { encode } from "./commandEnvelope.js";

/**
 * @param {string} url - a ws:// or wss:// URL, already carrying whatever seat-selection query
 *   the server side expects (net/wsServerTransport.js's own `?seat=<owner>`)
 * @param {{reconnectDelayMs?: number}} [opts] - reconnectDelayMs (default 1500): how long to wait
 *   after an unexpected close before retrying the same URL. Only ever used AFTER the first
 *   handshake succeeds — a failure before that still rejects immediately, unchanged from before
 *   T-029b (a caller that never got a working transport at all is a different problem than one
 *   that had a working transport and lost it).
 * @returns {Promise<Transport>} resolves once the welcome handshake completes and the match's map
 *   has been regenerated locally; rejects if the socket never reaches that point (connection
 *   refused, closed before welcome, malformed welcome payload)
 */
export function createWsClientTransport(url, opts = {}) {
  const { reconnectDelayMs = 1500, connectTimeoutMs } = opts;
  return new Promise((resolve, reject) => {
    let ws = null;
    let seq = 0;
    let closed = false;      // true only once the CALLER explicitly calls transport.close()
    let settled = false;     // has the OUTER promise resolved/rejected yet (the very first handshake)?
    let announcedDisconnected = false;   // avoid re-emitting "disconnected" on every failed retry
    let reconnectTimer = null;
    const pendingBySeq = new Map();   // seq -> resolve(CommandResult)
    const handlers = new Set();
    let map = null;
    let fog = null;   // this seat's OWN persistent fog (ADR-0009 M2) — created at welcome time,
                       // mutated in place by every reassembleProjection call; PRESERVED across a
                       // same-match reconnect (T-029b), only recreated for a genuinely new match
    let seat = null;
    let matchId = null;   // T-029b — this connection's last-seen match identity
    let seed = null, planetId = null;   // T-034 — carried from the welcome handshake onto every
                                         // reassembled state (see the "state" handler below); a
                                         // per-tick projection has no match-identity fields of its own
    let lastProj = null;   // the last reconstructed projectFor(...)-shaped snapshot (ADR-0009 M3,
                            // T-028b) — a full push replaces it outright; a delta is applied against it

    function emit(event) {
      if (closed) return;
      for (const h of handlers) h(event);
    }

    function fail(err) {
      if (!settled) { settled = true; reject(err); }
    }

    function scheduleReconnect() {
      if (closed) return;
      reconnectTimer = setTimeout(connect, reconnectDelayMs);
    }

    function connect() {
      reconnectTimer = null;
      const myWs = new WebSocket(url);
      ws = myWs;
      let welcomedThisConnection = false;   // guards a stray/duplicate welcome on THIS ONE connection
      let connectTimedOut = false;          // WE aborted this attempt on purpose — the "close" handler
                                             // below must treat that as "the first attempt failed",
                                             // never as a post-success disconnect worth reconnecting from

      // Bounded initial-connect patience (see this file's own header) — only ever armed for the
      // very FIRST attempt (settled is still false at that point); a later reconnect leaves it
      // unset, preserving T-029b's own deliberately-unbounded retry cadence untouched.
      const connectTimeoutTimer = (connectTimeoutMs && !settled) ? setTimeout(() => {
        connectTimedOut = true;
        // fail() BEFORE close(): closing a still-CONNECTING WebSocket synchronously fires ITS OWN
        // "error" event as part of aborting the handshake — reaching the "error" listener below
        // before this callback would otherwise get back to its own fail() call. fail()'s guard is
        // idempotent (whichever call reaches it first wins), so calling it here first is what makes
        // the caller actually see THIS timeout's own message, not a generic "connection failed" one.
        fail(new Error(`WebSocket connection timed out after ${connectTimeoutMs}ms`));
        myWs.close();
      }, connectTimeoutMs) : null;

      myWs.addEventListener("error", () => {
        if (connectTimeoutTimer) clearTimeout(connectTimeoutTimer);
        // Only the very first connection attempt ever gets an outer-promise rejection out of this —
        // once the transport is live (settled), a reconnect attempt's own error is just a precursor
        // to its "close" event below, which is where the actual retry decision happens.
        if (!settled) fail(new Error("WebSocket connection failed"));
      });

      myWs.addEventListener("close", () => {
        // Any submitCommand() still awaiting a reply at this point never gets one on THIS
        // connection — resolve them all with a clear rejection rather than leaving the caller
        // hanging on a promise that can now never settle any other way, the same "never assume it
        // resolves synchronously, but it MUST eventually resolve" guarantee every Transport
        // implementation owes its callers. A reconnect starts every seq/ack bookkeeping fresh
        // (net/wsServerTransport.js has no memory of a dead connection's in-flight commands either).
        for (const resolveOne of pendingBySeq.values()) resolveOne({ ok: false, code: "closed" });
        pendingBySeq.clear();

        if (closed) return;   // the CALLER closed this on purpose — never reconnect
        // connectTimedOut's own fail() call above already settled (rejected) the outer promise —
        // this later, asynchronous "close" (from the myWs.close() that same callback issued) must
        // not be mistaken for "the transport was live and just dropped", or it would schedule an
        // orphaned reconnect loop nothing ever awaits or can cancel.
        if (connectTimedOut) return;
        if (!settled) { fail(new Error("WebSocket closed before the welcome handshake completed")); return; }

        // T-029b: an unexpected close after the transport was already live — retry, whatever the
        // cause (see this file's own header for why that distinction doesn't matter here).
        if (!announcedDisconnected) { announcedDisconnected = true; emit({ type: "disconnected" }); }
        scheduleReconnect();
      });

      myWs.addEventListener("message", ev => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (!msg || typeof msg !== "object") return;

        if (msg.type === "welcome") {
          if (welcomedThisConnection) return;   // a stray duplicate welcome on this SAME connection
          welcomedThisConnection = true;
          if (connectTimeoutTimer) clearTimeout(connectTimeoutTimer);   // the handshake beat the clock

          // Named distinctly from the outer seed/planetId (T-034) they get assigned to just below —
          // a bare `const { planetId, seed }` here would SHADOW those for the rest of this block
          // instead of setting them.
          const { planetId: welcomePlanetId, seed: welcomeSeed, sizeMult, resourceMult, swapAsym } = msg.createGameState;
          map = generateMap(welcomePlanetId, mulberry32(welcomeSeed), { sizeMult, resourceMult, swapAsym });
          const isReconnect = settled;   // the outer promise already resolved once before -> this welcome is from a RETRY, not the original connect
          const sameMatch = isReconnect && matchId === msg.matchId;
          if (!sameMatch) fog = createFog(map);   // no exploration memory worth preserving for a genuinely different match (or the very first connect)
          matchId = msg.matchId;
          seat = msg.seat;
          seed = welcomeSeed;
          planetId = welcomePlanetId;
          lastProj = null;

          if (!isReconnect) {
            settled = true;
            resolve(makeTransport());
          } else {
            announcedDisconnected = false;
            emit({ type: "reconnected", matchId, sameMatch });
          }
          return;
        }
        if (msg.type === "state") {
          // T-028b: the first push on this connection is always full (net/wsServerTransport.js's own
          // rule); every one after is a delta against whatever this client last reconstructed. There
          // is no separate ack to send — the WebSocket itself is the ack (see that file's own header
          // for why TCP's in-order delivery already gives the server everything "acknowledged" needs).
          lastProj = msg.full ? msg.proj : applyDelta(lastProj, msg.delta);
          // T-034: seed/planetId ride along from the welcome handshake (already parsed above, into
          // `map` — these two are what regenerated it), never from the per-tick projection itself,
          // which carries no match-identity metadata of its own. Found by an actual browser join:
          // without this, overlays.js's seed chip read "Seed undefined" for a live network match —
          // a locally-created State always has a real state.seed, so a wire-reconstructed one must too.
          emit({ type: "state", state: { ...reassembleProjection(lastProj, map, fog, seat), seed, planetId } });
          return;
        }
        if (msg.type === "commandResult") {
          const resolveOne = pendingBySeq.get(msg.seq);
          if (resolveOne) { pendingBySeq.delete(msg.seq); resolveOne(msg.result); }
          emit({ type: "commandResult", seq: msg.seq, result: msg.result });
          return;
        }
      });
    }

    function makeTransport() {
      return {
        submitCommand(cmd) {
          if (closed) return Promise.resolve({ ok: false, code: "closed" });
          // Mid-reconnect (old socket dead, new one not open yet): ws.send() on a non-OPEN native
          // WebSocket THROWS synchronously, which would break every caller's "always get a Promise
          // back" assumption (net/transport.js's own JSDoc) — answer immediately instead, the same
          // shape a "closed" rejection already takes, just a distinct code since this one recovers.
          if (ws.readyState !== WebSocket.OPEN) return Promise.resolve({ ok: false, code: "disconnected" });
          const mySeq = ++seq;
          ws.send(JSON.stringify(encode(cmd, mySeq)));
          return new Promise(res => { pendingBySeq.set(mySeq, res); });
        },
        onEvent(handler) {
          handlers.add(handler);
        },
        close() {
          closed = true;
          handlers.clear();
          if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
          ws.close();
        },
      };
    }

    connect();
  });
}
