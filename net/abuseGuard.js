/* ============================================================
   net/abuseGuard.js — T-039 (FR-10)'s two pure decisions for EVERY client-driven path (a command
   envelope, a chat message, even a malformed/garbage frame — anything a connection sends), the
   same "pure decision, separately testable" split net/chatLimiter.js already established for chat
   specifically: is this connection sending too fast right now (checkRate), and has it been
   THROTTLED often enough recently that it's not a burst of legitimate play but a sustained flood
   (recordStrike) — the two-stage response TASKS.md's own exit criterion names directly: "a
   flooding client is throttled, then disconnected, without affecting the match."

   checkRate gates BEFORE any parsing or type-dispatch (net/wsWorkerTransport.js's own conn.onmessage
   calls it first, before even attempting JSON.parse) — parsing itself has a real CPU cost, so
   counting raw messages rather than successfully-decoded ones is what actually bounds a flood of
   oversized garbage, not just a flood of well-formed-but-excessive commands. Generous on purpose
   (40/second): sized well above any plausible legitimate peak — even the most aggressive human
   micro rarely issues more than a handful of genuinely distinct orders per second, and a
   multi-unit order is already ONE envelope, not one per unit — so no real player should ever be
   throttled by this at all; it exists to bound a flood, not to shape ordinary play.

   recordStrike is the escalation: every message this file's caller rejected for ANY reason (this
   module's own checkRate, OR net/chatLimiter.js's validChatLength/tryConsume — a determined
   chat-flooder who keeps sending just past ITS OWN stricter limit, forever, is exactly as abusive
   as a raw command flood) is one strike. Only once a connection racks up ABUSE_STRIKE_LIMIT
   strikes within the (longer) abuse window does this report "disconnect it" — a single burst that
   grazed the rate limit once (a big battle's worth of orders issued in one click, say) never gets
   anywhere close; only a connection that keeps getting throttled, over and over, does.

   Deliberately per-CONNECTION, not per-seat (unlike net/chatLimiter.js's own chatTimestampsBySeat,
   which is keyed by seat specifically so a reconnect can't reset ITS budget for free): the goal
   here is "stop THIS flood, right now" — closing the abusive connection already stops it, so there
   is nothing to protect by carrying a grudge past that point. Keying this by seat instead would
   punish a legitimate RECONNECT (a real human behind a fixed, well-behaved client) with an
   instantly-maxed strike count inherited from whatever got the PREVIOUS connection disconnected —
   the opposite of "without affecting the match" for a seat that just wants back in.
   ============================================================ */

"use strict";

const RATE_LIMIT_COUNT = 40;        // messages
const RATE_WINDOW_MS = 1000;        // per this many milliseconds
const ABUSE_STRIKE_LIMIT = 20;      // throttled messages
const ABUSE_WINDOW_MS = 10000;      // within this many milliseconds

/** A fresh, independent tracker for one connection. Never share one instance across connections —
 *  that would pool their budgets together, the same mistake net/chatLimiter.js's own per-seat
 *  array avoids by being the CALLER's state, not a module-level default. */
export function createGuardState() {
  return { timestamps: [], strikes: [] };
}

/**
 * The general per-connection rate gate — call for EVERY inbound message, before parsing it.
 * @param {{timestamps: number[]}} state @param {number} now @returns {boolean}
 */
export function checkRate(state, now) {
  const { timestamps } = state;
  while (timestamps.length && now - timestamps[0] >= RATE_WINDOW_MS) timestamps.shift();
  if (timestamps.length >= RATE_LIMIT_COUNT) return false;
  timestamps.push(now);
  return true;
}

/**
 * Call once for every message the caller rejected, from ANY check (this module's checkRate, or a
 * content-specific one like chat's own). @returns {boolean} true once this connection has crossed
 * the abuse threshold and should be disconnected outright, not merely throttled again.
 * @param {{strikes: number[]}} state @param {number} now @returns {boolean}
 */
export function recordStrike(state, now) {
  const { strikes } = state;
  while (strikes.length && now - strikes[0] >= ABUSE_WINDOW_MS) strikes.shift();
  strikes.push(now);
  return strikes.length >= ABUSE_STRIKE_LIMIT;
}
