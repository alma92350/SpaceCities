/* ============================================================
   Fault injection over a real Transport (net/transport.js) — TASKS.md T-013. Wraps ANY
   implementation (net/loopback.js today; a future WebSocketTransport just as well) and
   reintroduces the two things a same-process loopback is honest about not having: real latency
   before a submitCommand promise resolves or an onEvent fires, and real loss.

   WHY THIS MATTERS, CONCRETELY. net/loopback.js's submitCommand resolves synchronously
   underneath (test/loopback.test.js proves it) — deliberately, so single-player pays no needless
   delay. That is exactly the shape that lets client code get away with silently assuming a
   synchronous reply, because every existing test would keep passing right up until a real
   network transport made the gap real in production (net/transport.js's own submitCommand JSDoc
   names this trap explicitly). This file makes that gap real INSIDE the deterministic unit
   suite, so "no client path depends on a synchronous reply" (T-013's own exit criterion) is
   something a test can actually catch, not just something the architecture hopes is true.

   DETERMINISM. `rng` defaults to Math.random for real use, but every test in
   test/loopbackFaults.test.js passes a SCRIPTED one (a plain function returning pre-chosen values
   in sequence) — so "which commands get delayed how much" and "which commands get dropped" are
   as reproducible as everything else this codebase simulates. This wrapper never uses a clock for
   anything but the setTimeout delay itself; which delay to use is always drawn from `rng`.

   WHAT "REORDERING" MEANS HERE. The underlying mutation already happens strictly in submission
   order — it happens the moment `inner.submitCommand`/tick is actually called, which this wrapper
   only ever calls after ITS OWN delay elapses, never out of order relative to when THAT delay was
   scheduled relative to other calls' delays. What jitter (a random ADDITIONAL delay on top of
   latencyMs, independent per call) genuinely reorders is which PROMISE resolves first — two
   commands submitted close together can have their results arrive back at the client in a
   different order than they were sent, exactly as two packets on a real, jittery connection can.
   Client code must not assume "the promise I'm awaiting first corresponds to the command I sent
   first" — this wrapper is what proves that assumption isn't hiding anywhere.
   ============================================================ */

"use strict";

/**
 * @param {Transport} inner - the real transport to wrap (net/loopback.js, or eventually a
 *   WebSocketTransport — this file works against the interface, not the implementation).
 * @param {Object} [opts]
 * @param {number} [opts.latencyMs] - base delay added before a submitCommand promise resolves or
 *   a pushed event reaches an onEvent subscriber. Default 0 (no delay).
 * @param {number} [opts.jitterMs] - additional random delay in [0, jitterMs), drawn independently
 *   per call from `rng`, on top of latencyMs. Default 0 (no jitter, no reordering).
 * @param {number} [opts.dropRate] - fraction in [0, 1) of calls that are lost entirely: a dropped
 *   submitCommand's promise never resolves and `inner` never sees the command (no mutation, ever
 *   — a lost order, not a delayed one); a dropped event never reaches onEvent subscribers.
 *   Compared with `rng() < dropRate`, so 0 never drops even against a scripted rng returning 0.
 * @param {() => number} [opts.rng] - returns a value in [0, 1). Called at most once per
 *   submitCommand/pushed event for the drop check (skipped entirely when dropRate <= 0 — a test
 *   exercising only jitter never has to account for a drop draw it doesn't care about), then at
 *   most once more for the jitter amount (likewise skipped when jitterMs <= 0). Defaults to
 *   Math.random.
 * @returns {Transport}
 */
export function createFaultyTransport(inner, opts = {}) {
  const { latencyMs = 0, jitterMs = 0, dropRate = 0, rng = Math.random } = opts;
  const timers = new Set();
  let closed = false;

  function delayFor() {
    return latencyMs + (jitterMs > 0 ? Math.floor(rng() * jitterMs) : 0);
  }

  // Schedules `fn` after this call's delay, unless dropped (never scheduled at all) or the
  // wrapper has since been closed (scheduled but a no-op when it fires, and untracked so close()
  // has nothing left to clear for it).
  function afterDelay(fn) {
    if (dropRate > 0 && rng() < dropRate) return;   // lost: never reaches `inner`, never fires
    const delay = delayFor();
    if (delay <= 0 && !closed) { fn(); return; }
    const id = setTimeout(() => {
      timers.delete(id);
      if (!closed) fn();
    }, delay);
    timers.add(id);
  }

  return {
    submitCommand(cmd) {
      return new Promise(resolve => {
        afterDelay(() => { inner.submitCommand(cmd).then(resolve); });
        // A dropped or post-close command's promise deliberately never resolves — see this
        // file's header on why that, not a synthetic rejection, is the honest simulation of loss.
      });
    },
    onEvent(handler) {
      inner.onEvent(event => afterDelay(() => handler(event)));
    },
    close() {
      closed = true;
      for (const id of timers) clearTimeout(id);
      timers.clear();
      inner.close();
    },
  };
}
