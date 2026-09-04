/* ============================================================
   T-039 (FR-10): net/abuseGuard.js — the two pure decisions every client-driven path needs (is
   this connection sending too fast right now, has it been throttled enough recently to disconnect
   outright), factored out the same "pure decision, separately testable" split net/chatLimiter.js
   already established for chat specifically.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createGuardState, checkRate, recordStrike } from "../net/abuseGuard.js";

test("createGuardState returns fresh, independent state each call — no shared default array footgun", () => {
  const a = createGuardState();
  const b = createGuardState();
  checkRate(a, 1000);
  assert.equal(a.timestamps.length, 1);
  assert.equal(b.timestamps.length, 0, "a second tracker must start with its own empty state, not share a's");
});

/* ---------- checkRate ---------- */

test("checkRate: the first several messages within the window are all allowed", () => {
  const state = createGuardState();
  const now = 1000;
  for (let i = 0; i < 40; i++) assert.equal(checkRate(state, now + i), true, `message ${i + 1} of the allowance must be accepted`);
});

test("checkRate: one message past the allowance, still inside the window, is rejected", () => {
  const state = createGuardState();
  const now = 1000;
  for (let i = 0; i < 40; i++) checkRate(state, now + i);
  assert.equal(checkRate(state, now + 40), false, "the 41st message inside the same window must be refused");
});

test("checkRate: a rejected message never consumes budget — the very next call inside the window is STILL rejected", () => {
  const state = createGuardState();
  const now = 1000;
  for (let i = 0; i < 40; i++) checkRate(state, now + i);
  assert.equal(checkRate(state, now + 40), false);
  assert.equal(checkRate(state, now + 41), false, "a rejection must not have silently freed a slot for the next attempt");
});

test("checkRate: once the window has fully elapsed, a fresh message is allowed again", () => {
  const state = createGuardState();
  const now = 1000;
  for (let i = 0; i < 40; i++) checkRate(state, now + i);
  assert.equal(checkRate(state, now + 40), false, "fixture sanity: still limited immediately after");
  assert.equal(checkRate(state, now + 2000), true, "well past the 1s window — the old timestamps must have aged out");
});

test("checkRate: independent connections never share a budget", () => {
  const a = createGuardState(), b = createGuardState();
  const now = 1000;
  for (let i = 0; i < 40; i++) assert.equal(checkRate(a, now + i), true);
  assert.equal(checkRate(a, now + 40), false, "connection a is now at its own limit");
  assert.equal(checkRate(b, now + 40), true, "connection b's own budget is untouched by a's flood");
});

/* ---------- recordStrike ---------- */

test("recordStrike: a single throttled message never crosses the abuse threshold on its own", () => {
  const state = createGuardState();
  assert.equal(recordStrike(state, 1000), false, "one strike out of a 20-strike limit must not disconnect anything yet");
});

test("recordStrike: fewer strikes than the limit, all within the window, still don't disconnect", () => {
  const state = createGuardState();
  const now = 1000;
  for (let i = 0; i < 19; i++) assert.equal(recordStrike(state, now + i), false, `strike ${i + 1} of 19 must stay under the 20-strike limit`);
});

test("recordStrike: reaching the strike limit within the window reports disconnect-worthy", () => {
  const state = createGuardState();
  const now = 1000;
  for (let i = 0; i < 19; i++) recordStrike(state, now + i);
  assert.equal(recordStrike(state, now + 19), true, "the 20th strike inside the same window must cross the abuse threshold");
});

test("recordStrike: strikes age out of their own (longer) sliding window — an occasional, rare throttle never accumulates toward disconnect", () => {
  const state = createGuardState();
  const now = 1000;
  for (let i = 0; i < 19; i++) recordStrike(state, now + i * 20000);   // one strike every 20s — always outside any 10s window together
  assert.equal(recordStrike(state, now + 19 * 20000), false, "19 strikes spread far apart in time must never accumulate into a disconnect");
});

test("recordStrike: independent connections never share a strike count", () => {
  const a = createGuardState(), b = createGuardState();
  const now = 1000;
  for (let i = 0; i < 19; i++) recordStrike(a, now + i);
  assert.equal(recordStrike(a, now + 19), true, "connection a has crossed its own threshold");
  assert.equal(recordStrike(b, now + 19), false, "connection b's own strike count is untouched by a's abuse");
});
