/* ============================================================
   net/wsSpectatorTransport.js — T-037's own CLIENT half: connects to a live match as a spectator
   (`?spectate=1`, net/wsWorkerTransport.js's own second connection kind) and reassembles each
   incoming projectForSpectator(...) push into the same state shape render.js/hud.js/etc. already
   expect (engine/projection.js's reassembleSpectatorProjection).

   DELIBERATELY NOT net/wsClientTransport.js's own createWsClientTransport, reused with a null seat:
   that function's whole shape (seq tracking, per-seat fog reconstruction, reconnect-preserving-fog)
   exists for a PLAYABLE seat — a spectator has none of that (no fog to reconstruct at all; see
   engine/projection.js's own reassembleSpectatorProjection header on why fog/fogAI are simply
   null). Rather than stretch one function to cover two genuinely different contracts, this file is
   its own small, honest thing.

   submitCommand EXISTS (net/transport.js's own Transport shape requires it — a spectator transport
   can still be handed to boot.js's bootState/attachInput uniformly, the same way every other
   transport already is), but it is a pure, wire-touching-nothing no-op that always resolves
   {ok:false, code:"spectator"} — it never sends anything over the socket at all. This is defense in
   depth on the CLIENT side matching net/wsWorkerTransport.js's own SERVER-side choice to never wire
   conn.onmessage for a spectator connection in the first place: "a spectator cannot issue any
   command" (the PRD's own exit criterion) is true by construction on BOTH sides, not merely
   enforced once and trusted. NOT run through test/transportContract.js's shared Transport contract
   (test/wsSpectatorTransport.test.js's own header explains why: that contract requires a valid
   command to actually succeed, the opposite of this file's own point).

   NO AUTOMATIC RECONNECT (T-029b's own mechanism is wsClientTransport.js-only): a spectator dropped
   mid-match just stops updating. Losing a spectator's own view is a much lower-stakes event than
   losing a PLAYER's live seat (T-036's entire reason for existing) — reconnecting is a fresh
   createWsSpectatorTransport() call from whatever UI offered "Watch" in the first place, not a
   background retry loop. Revisit only if real use shows this matters.
   ============================================================ */

"use strict";

import { generateMap } from "../engine/map.js";
import { mulberry32 } from "../engine/rng.js";
import { reassembleSpectatorProjection } from "../engine/projection.js";
import { applyDelta } from "../engine/projectionDelta.js";

/**
 * @param {string} url - a ws:// or wss:// URL already carrying `?spectate=1` (and whatever
 *   `?match=<id>` net/wsWorkerTransport.js's own requireMatch opt expects)
 * @returns {Promise<{onEvent: (fn: (event: Object) => void) => void, submitCommand: (cmd: Object) => Promise<Object>, close: () => void}>}
 *   resolves once the welcome handshake completes and the match's map has been regenerated
 *   locally; rejects if the socket never reaches that point (refused — spectatorsEnabled:false —
 *   or closed before the welcome message ever arrived).
 */
export function createWsSpectatorTransport(url) {
  return new Promise((resolve, reject) => {
    let closed = false;
    let settled = false;
    const handlers = new Set();
    let map = null;
    let lastProj = null;
    let seed = null, planetId = null;   // carried onto every emitted state event — see wsClientTransport.js's own T-034 fix for why (a per-tick projection has no match-identity fields of its own)

    const ws = new WebSocket(url);

    function emit(event) {
      if (closed) return;
      for (const h of handlers) h(event);
    }
    function fail(err) {
      if (!settled) { settled = true; reject(err); }
    }

    ws.addEventListener("error", () => { if (!settled) fail(new Error("WebSocket connection failed")); });
    ws.addEventListener("close", () => { if (!settled) fail(new Error("WebSocket closed before the welcome handshake completed")); });

    ws.addEventListener("message", ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (!msg || typeof msg !== "object") return;

      if (msg.type === "welcome") {
        if (settled) return;   // a stray duplicate welcome
        // Named distinctly from the outer seed/planetId (assigned right below) — same shadowing
        // trap wsClientTransport.js's own header already documents for the identical destructure.
        const { planetId: welcomePlanetId, seed: welcomeSeed, sizeMult, resourceMult, swapAsym } = msg.createGameState;
        map = generateMap(welcomePlanetId, mulberry32(welcomeSeed), { sizeMult, resourceMult, swapAsym });
        seed = welcomeSeed;
        planetId = welcomePlanetId;
        settled = true;
        resolve({
          onEvent(handler) { handlers.add(handler); },
          // Always false, always local — see this file's own header on why this exists as a real
          // function rather than being omitted.
          submitCommand() { return Promise.resolve({ ok: false, code: "spectator" }); },
          close() {
            if (closed) return;
            closed = true;
            handlers.clear();
            ws.close();
          },
        });
        return;
      }
      if (msg.type === "state") {
        lastProj = msg.full ? msg.proj : applyDelta(lastProj, msg.delta);
        emit({ type: "state", state: { ...reassembleSpectatorProjection(lastProj, map), seed, planetId } });
        return;
      }
      if (msg.type === "chat") {
        // T-038: read-only, same as everything else this transport hands a caller — there is no
        // sendChat here to pair with it (this file's own header: "a spectator cannot issue any
        // command" stays true by construction, chat included), just the passive receive.
        emit({ type: "chat", from: msg.from, text: msg.text });
        return;
      }
    });
  });
}
