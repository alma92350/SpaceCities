/* ============================================================
   T-061 (Ops): one structured JSON line per operational event, written to stdout — the convention
   a container log aggregator (HF Spaces' own included) already understands with zero extra
   tooling, config, or dependency. Deliberately not a logging framework: no levels, no transports,
   no destinations — this deployment's own observability need is four specific things worth
   watching (desyncs, disconnects, match durations, tick overruns; see test/matchWorker.test.js for
   where each is wired in), not general-purpose app logging.
   ============================================================ */

"use strict";

/**
 * @param {string} type
 * @param {Object} [fields]
 */
export function logEvent(type, fields = {}) {
  console.log(JSON.stringify({ t: Date.now(), type, ...fields }));
}
