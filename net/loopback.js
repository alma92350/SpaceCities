/* ============================================================
   The in-process Transport — same tab, same process, no socket (ADR-0004).
   Wraps a server/session.js session directly. Single-player wires a client
   to a session through THIS, exactly as multiplayer will wire a client to a
   session through a (Phase 3) WebSocketTransport — same interface
   (net/transport.js), so client code written against Transport never knows
   which one it has.

   submitCommand returns a Promise even though the work underneath is
   genuinely synchronous — the mutation happens and is visible to the caller
   BEFORE the promise ever resolves (see test/loopback.test.js's own test for
   this). That is deliberate: client code written against a Promise-returning
   submitCommand is already correct for a transport where the promise takes
   real time to resolve, so nothing about the client changes when
   WebSocketTransport replaces this. It is also what T-013's fault-injection
   layer needs — there is a real async gap here to delay.

   tick() and getState() are LOOPBACK-SPECIFIC EXTENSIONS beyond the generic
   Transport contract — a real remote transport cannot offer either (ticking
   happens server-side, invisible to a remote client; state arrives only as
   pushed events, never by synchronous pull). T-012 decides how much of the
   client actually leans on these vs. driving purely off onEvent; both are
   valid against this shape. Do not add either to net/transport.js's
   documented interface — that would silently make it a contract only
   loopback can satisfy.
   ============================================================ */

"use strict";

/**
 * @param {ReturnType<import("../server/session.js").createSession>} session
 * @returns {Transport & { tick: (dt: number) => void, getState: () => State }}
 */
export function createLoopbackTransport(session) {
  const handlers = new Set();
  let closed = false;

  function emit(event) {
    if (closed) return;
    for (const h of handlers) h(event);
  }

  return {
    submitCommand(cmd) {
      if (closed) return Promise.resolve({ ok: false, code: "closed" });
      const result = session.submitCommand(cmd);   // synchronous — see file header
      emit({ type: "commandResult", result });
      return Promise.resolve(result);
    },
    onEvent(handler) {
      handlers.add(handler);
    },
    close() {
      closed = true;
      handlers.clear();
    },
    tick(dt) {
      if (closed) return;
      session.tick(dt);
      emit({ type: "state", state: session.getState() });
    },
    getState() {
      return session.getState();
    },
  };
}
