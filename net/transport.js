/* ============================================================
   The Transport interface — the one seam ADR-0004 exists to create.

   No runtime code, exactly like engine/types.js and net/commandShapes.js: pure
   documentation the type checker verifies real implementations against.
   Global typedefs (no imports/exports), so any file can reference `Transport`
   by name.

   A client depends on NOTHING but this shape. Two implementations exist (or
   will): LoopbackTransport (net/loopback.js, Phase 1 — same process,
   synchronous, wraps a session directly, single-player) and WebSocketTransport
   (Phase 3 — remote, asynchronous, one socket per client). Swapping one for
   the other must never require touching client code that only talks to
   `Transport` — that is the entire point of the interface existing.

   The shared contract every implementation must satisfy lives in
   test/transportContract.js, not here — this file has no code to run.
   ============================================================ */

"use strict";

/**
 * @typedef {Object} StateEvent
 * A fresh view of the world, pushed from the session side. In Phase 1
 * (loopback) this is literally the session's own `state` object — no copy, no
 * filtering, since there is exactly one trusted local client. Phase 3's
 * WebSocketTransport instead delivers a per-seat fog-filtered JSON snapshot
 * (ADR-0009); client code that only reads `event.state`'s documented shape
 * cannot tell the difference.
 * @property {"state"} type
 * @property {State} state
 */

/**
 * @typedef {Object} CommandResultEvent
 * The outcome of one submitted command, so the caller can roll back an
 * optimistic UI action (a build ghost, say) on rejection. Correlated to the
 * submission by `seq` once envelopes exist (Phase 2/3); in Phase 1 there is
 * only ever one command in flight per synchronous call, so `seq` is omitted.
 * @property {"commandResult"} type
 * @property {number} [seq]
 * @property {CommandResult} result
 */

/** @typedef {StateEvent|CommandResultEvent} TransportEvent */

/**
 * @typedef {Object} Transport
 * @property {(command: WireCommand) => void} submitCommand
 *   Client -> session. Fire-and-forget from the caller's perspective — the
 *   outcome arrives later as a CommandResultEvent via onEvent, never as a
 *   return value, so client code behaves identically whether the session is
 *   in the same tab (synchronous underneath) or across a socket (genuinely
 *   asynchronous). Relying on a synchronous return here is the exact trap
 *   TASKS.md T-013 exists to catch (input.js:521) — see that task and
 *   test/loopbackFaults.test.js.
 * @property {(handler: (event: TransportEvent) => void) => void} onEvent
 *   Subscribe to session -> client events. A transport delivers events to
 *   every subscriber that registered before the event was produced; it does
 *   not replay history to a late subscriber.
 * @property {() => void} close
 *   Tear down the transport. Idempotent — closing an already-closed transport
 *   is a no-op, not a throw, so client teardown code never needs to track
 *   whether it already called this.
 */
