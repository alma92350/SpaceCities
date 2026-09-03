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

   Async on purpose, unlike createLoopbackTransport: establishing a real socket and waiting for
   that first welcome message is genuinely asynchronous, where loopback wraps an
   already-constructed session synchronously. The resolved Transport's own methods stay
   synchronous-shaped (submitCommand still returns a Promise, per the interface), matching every
   other implementation.
   ============================================================ */

"use strict";

import { generateMap } from "../engine/map.js";
import { mulberry32 } from "../engine/rng.js";
import { createFog } from "../engine/fog.js";
import { reassembleProjection } from "../engine/projection.js";
import { encode } from "./commandEnvelope.js";

/**
 * @param {string} url - a ws:// or wss:// URL, already carrying whatever seat-selection query
 *   the server side expects (net/wsServerTransport.js's own `?seat=<owner>`)
 * @returns {Promise<Transport>} resolves once the welcome handshake completes and the match's map
 *   has been regenerated locally; rejects if the socket never reaches that point (connection
 *   refused, closed before welcome, malformed welcome payload)
 */
export function createWsClientTransport(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let seq = 0;
    let closed = false;
    let settled = false;   // has the outer promise resolved/rejected yet?
    const pendingBySeq = new Map();   // seq -> resolve(CommandResult)
    const handlers = new Set();
    let map = null;
    let fog = null;   // this seat's OWN persistent fog (ADR-0009 M2) — created once at welcome,
                       // mutated in place by every reassembleProjection call from then on
    let seat = null;

    function emit(event) {
      if (closed) return;
      for (const h of handlers) h(event);
    }

    function fail(err) {
      if (!settled) { settled = true; reject(err); }
    }

    ws.addEventListener("error", () => fail(new Error("WebSocket connection failed")));
    ws.addEventListener("close", () => {
      closed = true;
      fail(new Error("WebSocket closed before the welcome handshake completed"));
      // Any submitCommand() still awaiting a reply at this point never gets one — resolve them all
      // with a clear rejection rather than leaving the caller hanging on a promise that can now
      // never settle any other way, the same "never assume it resolves synchronously, but it MUST
      // eventually resolve" guarantee every Transport implementation owes its callers.
      for (const resolveOne of pendingBySeq.values()) resolveOne({ ok: false, code: "closed" });
      pendingBySeq.clear();
    });

    ws.addEventListener("message", ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (!msg || typeof msg !== "object") return;

      if (msg.type === "welcome") {
        if (settled) return;   // a stray/duplicate welcome after the handshake already completed
        const { planetId, seed, sizeMult, resourceMult, swapAsym } = msg.createGameState;
        map = generateMap(planetId, mulberry32(seed), { sizeMult, resourceMult, swapAsym });
        fog = createFog(map);
        seat = msg.seat;
        settled = true;
        resolve(makeTransport());
        return;
      }
      if (msg.type === "state") {
        emit({ type: "state", state: reassembleProjection(msg.proj, map, fog, seat) });
        return;
      }
      if (msg.type === "commandResult") {
        const resolveOne = pendingBySeq.get(msg.seq);
        if (resolveOne) { pendingBySeq.delete(msg.seq); resolveOne(msg.result); }
        emit({ type: "commandResult", seq: msg.seq, result: msg.result });
        return;
      }
    });

    function makeTransport() {
      return {
        submitCommand(cmd) {
          if (closed) return Promise.resolve({ ok: false, code: "closed" });
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
          ws.close();
        },
      };
    }
  });
}
