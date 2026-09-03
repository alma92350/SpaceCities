/* ============================================================
   net/chatLimiter.js — T-038 (FR-12)'s two pure decisions: is this message short enough to send,
   and has this seat sent too many too recently. No DOM, no engine, no network — factored out of
   net/wsWorkerTransport.js's own wiring the same reason saveShape.js's resumableMode and
   server/lobby.js are their own pure modules: directly unit-testable, and the wiring layer that
   actually relays chat stays a thin caller of these two decisions rather than reimplementing them
   inline.
   ============================================================ */

"use strict";

export const MAX_CHAT_LEN = 240;
const RATE_LIMIT_COUNT = 5;      // messages
const RATE_LIMIT_WINDOW_MS = 10000;   // per this many milliseconds

/** @param {*} text @returns {boolean} - a real, non-empty string no longer than MAX_CHAT_LEN */
export function validChatLength(text) {
  return typeof text === "string" && text.length > 0 && text.length <= MAX_CHAT_LEN;
}

/**
 * A sliding-window rate limiter, one instance's worth of state per call: `timestamps` is the
 * CALLER's own array for one seat (net/wsWorkerTransport.js keeps a Map<seat, number[]>), mutated
 * in place — stale entries (older than the window) are always pruned first, regardless of the
 * outcome, so the array never grows unbounded even under a steady stream of rejections. `now` is
 * the current time in ms (Date.now() in production; an explicit value in tests, so the window's
 * own boundary is exactly reproducible rather than racing a real clock).
 *
 * A REJECTED message never consumes budget — only an accepted one is pushed onto `timestamps` —
 * so refusing a flood doesn't itself free up room for the next flood attempt a moment later.
 * @param {number[]} timestamps @param {number} now @returns {boolean}
 */
export function tryConsume(timestamps, now) {
  while (timestamps.length && now - timestamps[0] >= RATE_LIMIT_WINDOW_MS) timestamps.shift();
  if (timestamps.length >= RATE_LIMIT_COUNT) return false;
  timestamps.push(now);
  return true;
}
