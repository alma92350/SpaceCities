import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_APM, createAgentApmGuard } from "../net/agentApm.js";
import { DIFFICULTY_OPTIONS } from "../engine/aiDifficulty.js";
import { APM_BURST_FRAC } from "../engine/aiCommon.js";

/* ============================================================
   T-056 (§6.3, ADR-0007): "Agent APM budget, reusing the existing aiApm mechanism." The REAL
   mechanism (engine/aiCommon.js's accrueActionBudget/canAct/spend) is hardwired to
   state.controllers[owner] — and that field's OWN null-ness is overloaded to mean two things at
   once for the shipped 2-seat design: "no budget to track" AND "don't run the scripted AI's
   decision loop for this owner" (engine/controllers.js's own controllerFor doc: "or null if none
   (a human seat...)"; engine/sim.js's own `else runAI(state, dt)` call has no isHumanControlled
   guard around it at all — runAI's OWN `if (!controller) return` is what stops it from double-
   -running the scripted AI on top of a human/agent-occupied seat, confirmed by reading, not
   assumed). Giving an MCP-agent-occupied seat a real state.controllers entry just to have
   somewhere to store apm/actionBudget would UN-null it and silently turn the scripted AI back on
   for that seat, fighting the real agent for control — exactly the double-dispatch class of bug
   T-048a's own row already flags for a related reason.

   So this task reuses the mechanism's own NUMBERS (the accrual formula, the burst-cap fraction,
   a real published apm value straight from engine/aiDifficulty.js's own difficulty table) rather
   than its storage — a transport-layer guard, alongside net/abuseGuard.js/net/chatLimiter.js
   (same "pure decision, caller owns the state, real wall-clock time in production/an explicit
   value in tests" shape those two already use), gated ENTIRELY outside engine State. This is safe
   specifically BECAUSE issue_command (T-053) is the only path that ever calls it: a real human's
   browser client never reaches this code at all (it plays over the WebSocket transport, never MCP
   tools), so gating unconditionally inside issue_command can never rate-limit a human by mistake.
   ============================================================ */

test("AGENT_APM is the real Hard-tier aiApm value from engine/aiDifficulty.js, not a separately hardcoded number", () => {
  const hard = DIFFICULTY_OPTIONS.find(d => d.label === "Hard");
  assert.ok(hard);
  assert.equal(AGENT_APM, hard.aiApm);
});

test("a fresh seat's very first tryConsume call succeeds immediately — seeded at the full burst cap, never zero", () => {
  const guard = createAgentApmGuard();
  assert.equal(guard.tryConsume("player", 1_000_000), true);
});

test("rapid-fire calls at the SAME instant are capped at the burst allowance, then rejected until time passes", () => {
  const guard = createAgentApmGuard();
  const cap = Math.max(2, AGENT_APM * APM_BURST_FRAC);
  const now = 1_000_000;
  let successes = 0;
  for (let i = 0; i < Math.ceil(cap) + 5; i++) { if (guard.tryConsume("player", now)) successes++; }
  assert.equal(successes, Math.floor(cap));
  assert.equal(guard.tryConsume("player", now), false, "the burst is exhausted — no more at this exact instant");
});

test("budget refills over elapsed wall-clock time at exactly apm/60 credits per second", () => {
  // apm=60 is deliberately chosen so cap = max(2, 60*APM_BURST_FRAC) = max(2, 4) = 4, a WHOLE
  // number — draining exactly 4 calls at the same instant leaves a known, exact remainder of 0,
  // with no fractional leftover to account for (unlike AGENT_APM's own 140, whose cap is
  // fractional and would leave an inexact remainder after an integer number of drains).
  const guard = createAgentApmGuard(60);
  const now = 1_000_000;
  for (let i = 0; i < 4; i++) assert.equal(guard.tryConsume("player", now), true);
  assert.equal(guard.tryConsume("player", now), false, "fixture sanity: exactly drained, nothing left");

  // 60 apm => 1 credit/sec exactly.
  assert.equal(guard.tryConsume("player", now + 999), false, "not quite one second has passed yet");
  assert.equal(guard.tryConsume("player", now + 1001), true, "just over one second has now passed");
});

test("a very long idle gap still caps the refill at the burst allowance — no unbounded hoarding", () => {
  const guard = createAgentApmGuard();
  const now = 1_000_000;
  guard.tryConsume("player", now);   // touch it once so lastMs is set, then let a huge gap pass
  const farFuture = now + 10 * 60 * 1000;   // 10 real minutes later
  const cap = Math.max(2, AGENT_APM * APM_BURST_FRAC);
  let successes = 0;
  for (let i = 0; i < Math.ceil(cap) + 10; i++) { if (guard.tryConsume("player", farFuture)) successes++; }
  assert.ok(successes <= Math.ceil(cap), `expected at most ~${cap} credits banked, got ${successes}`);
});

test("two seats in the SAME guard have fully independent budgets — draining one never affects the other", () => {
  const guard = createAgentApmGuard();
  const now = 1_000_000;
  const cap = Math.max(2, AGENT_APM * APM_BURST_FRAC);
  for (let i = 0; i < Math.ceil(cap) + 5; i++) guard.tryConsume("player", now);
  assert.equal(guard.tryConsume("player", now), false, "fixture sanity: player's own budget is drained");
  assert.equal(guard.tryConsume("ai", now), true, "a different seat's own budget is untouched");
});

test("createAgentApmGuard accepts an explicit apm override, for tests that need a small, fast-to-exhaust budget", () => {
  const guard = createAgentApmGuard(60);   // 1 credit/sec, cap = max(2, 60/15) = 4
  const now = 1_000_000;
  let successes = 0;
  for (let i = 0; i < 10; i++) { if (guard.tryConsume("player", now)) successes++; }
  assert.equal(successes, 4);
});

/* Agent-observability: an agent could previously only learn its ceiling by being refused, which
   makes "fire and find out" the cheapest strategy — the exact behaviour the ceiling exists to
   discourage. remaining() answers the same question without spending anything. */
test("remaining() reports the budget without consuming any of it", () => {
  const guard = createAgentApmGuard(60);   // cap = 4
  const now = 1_000_000;
  assert.equal(guard.remaining("player", now).actions, 4, "a seat that has never acted has its full burst");
  assert.equal(guard.remaining("player", now).actions, 4, "asking twice must not cost an action");
  guard.tryConsume("player", now);
  assert.equal(guard.remaining("player", now).actions, 3);
  assert.equal(guard.remaining("player", now).cap, 4);
});

test("remaining() says HOW LONG until the next action once the budget is spent", () => {
  const guard = createAgentApmGuard(60);   // 1 credit/sec
  const now = 1_000_000;
  while (guard.tryConsume("player", now));
  const drained = guard.remaining("player", now);
  assert.equal(drained.actions, 0);
  assert.ok(drained.seconds_until_next > 0 && drained.seconds_until_next <= 1, `expected ~1s, got ${drained.seconds_until_next}`);
  // And a second later there is one to spend again, with nothing owed.
  assert.equal(guard.remaining("player", now + 1000).seconds_until_next, 0);
  assert.equal(guard.remaining("player", now + 1000).actions, 1);
});
