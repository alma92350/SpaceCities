/* ============================================================
   T-038 (FR-12): net/chatLimiter.js — the two pure decisions in-match chat needs (length-capped,
   rate-limited), factored out so net/wsWorkerTransport.js's own wiring stays a thin relay, the same
   "pure decision, separately testable" split saveShape.js/server/lobby.js already established.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_CHAT_LEN, validChatLength, tryConsume } from "../net/chatLimiter.js";

test("validChatLength: an ordinary short message is valid", () => {
  assert.equal(validChatLength("gg well played"), true);
});

test("validChatLength: an empty string is invalid — nothing to send", () => {
  assert.equal(validChatLength(""), false);
});

test("validChatLength: exactly MAX_CHAT_LEN characters is still valid — the cap is inclusive", () => {
  assert.equal(validChatLength("x".repeat(MAX_CHAT_LEN)), true);
});

test("validChatLength: one character past MAX_CHAT_LEN is invalid", () => {
  assert.equal(validChatLength("x".repeat(MAX_CHAT_LEN + 1)), false);
});

test("validChatLength: a non-string is invalid, not a throw — a modified client can send anything", () => {
  assert.equal(validChatLength(42), false);
  assert.equal(validChatLength(null), false);
  assert.equal(validChatLength(undefined), false);
  assert.equal(validChatLength(["hi"]), false);
  assert.equal(validChatLength({ text: "hi" }), false);
});

test("tryConsume: the first several messages within the window are all allowed", () => {
  const timestamps = [];
  const now = 1000;
  for (let i = 0; i < 5; i++) assert.equal(tryConsume(timestamps, now + i), true, `message ${i + 1} of the allowance must be accepted`);
});

test("tryConsume: one message past the allowance, still inside the window, is rejected", () => {
  const timestamps = [];
  const now = 1000;
  for (let i = 0; i < 5; i++) tryConsume(timestamps, now + i);
  assert.equal(tryConsume(timestamps, now + 5), false, "the 6th message inside the same window must be refused");
});

test("tryConsume: a rejected message never consumes budget — the very next call inside the window is STILL rejected, not accepted", () => {
  const timestamps = [];
  const now = 1000;
  for (let i = 0; i < 5; i++) tryConsume(timestamps, now + i);
  assert.equal(tryConsume(timestamps, now + 5), false);
  assert.equal(tryConsume(timestamps, now + 6), false, "a rejection must not have silently freed a slot for the next attempt");
});

test("tryConsume: once the window has fully elapsed, a fresh message is allowed again", () => {
  const timestamps = [];
  const now = 1000;
  for (let i = 0; i < 5; i++) tryConsume(timestamps, now + i);
  assert.equal(tryConsume(timestamps, now + 5), false, "fixture sanity: still limited immediately after");
  assert.equal(tryConsume(timestamps, now + 20000), true, "well past the window — the old timestamps must have aged out");
});

test("tryConsume: a SLIDING window, not a fixed one — old timestamps age out one at a time, not all at once", () => {
  const timestamps = [];
  const now = 1000;
  for (let i = 0; i < 5; i++) tryConsume(timestamps, now + i * 1000);   // spread across 4 seconds, one per second
  // Advance to just past when the FIRST of the five ages out (its own window), but well before the
  // fifth one does — exactly one slot should have freed up, not all five.
  const t = now + 10001;   // 10001ms after the first message (now+0) — that one is now outside a 10s window
  assert.equal(tryConsume(timestamps, t), true, "the oldest message aged out, freeing exactly one slot");
  assert.equal(tryConsume(timestamps, t), false, "…but only one — the rest are still within their own window");
});

test("tryConsume: independent seats never share a budget — the caller's own per-seat array is what scopes this", () => {
  const seatA = [], seatB = [];
  const now = 1000;
  for (let i = 0; i < 5; i++) assert.equal(tryConsume(seatA, now + i), true);
  assert.equal(tryConsume(seatA, now + 5), false, "seat A is now at its own limit");
  assert.equal(tryConsume(seatB, now + 5), true, "seat B's own budget is untouched by seat A's usage");
});
