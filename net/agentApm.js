/* ============================================================
   T-056 (§6.3, ADR-0007): "Agent APM budget, reusing the existing aiApm mechanism." The real
   mechanism (engine/aiCommon.js's accrueActionBudget/canAct/spend) is hardwired to
   state.controllers[owner], whose OWN null-ness is overloaded to also mean "don't run the
   scripted AI's decision loop for this owner" (engine/controllers.js's controllerFor, engine/
   sim.js's unconditional `else runAI(state, dt)`, engine/ai.js's own `if (!controller) return`) —
   giving an MCP-agent-occupied seat a real controllers entry just to track a budget would silently
   turn the scripted AI back on for it. So this file reuses the mechanism's own NUMBERS (the
   accrual formula, the burst-cap fraction from engine/aiCommon.js's own APM_BURST_FRAC, and a
   real published apm value straight from engine/aiDifficulty.js's own difficulty table) at the
   TRANSPORT layer instead — the same "pure decision, caller owns the state, real wall-clock time
   in production" shape net/abuseGuard.js and net/chatLimiter.js already use, gated entirely
   outside engine State. Safe unconditionally: server/mcpActionTools.js's issue_command is the
   ONLY path that ever calls this, and a real human's browser client never reaches it at all (it
   plays over the WebSocket transport) — so this can never rate-limit a human by mistake.

   One deliberate difference from the engine's own version, and why: the scripted AI accrues
   CONTINUOUSLY from tick 0 (engine/ai.js calls accrueActionBudget every tick regardless of when
   its own first decision lands), so by the time it ever spends anything it already has several
   ticks' worth of credit. An MCP agent's budget is only ever touched lazily, at the moment of an
   actual tryConsume call — with no earlier ticks to have silently accrued during, treating a fresh
   seat's balance as 0 would reject its very first-ever action outright. Seeding a fresh seat at
   the FULL BURST CAP instead means "an agent's first action is always allowed," with the exact
   same accrual/cap mechanics governing every call after that — never an unbounded head start.
   ============================================================ */

"use strict";

import { DIFFICULTY_OPTIONS } from "../engine/aiDifficulty.js";
import { APM_BURST_FRAC } from "../engine/aiCommon.js";

// The published cap (ADR-0007: "a published cap, like every scripted opponent") is the SAME
// number the toughest scripted opponent already runs at — not a separately invented figure — so
// it moves automatically if a future balance pass ever retunes Hard's own aiApm.
export const AGENT_APM = DIFFICULTY_OPTIONS.find(d => d.label === "Hard").aiApm;

/**
 * @param {number} [apm] published actions-per-minute ceiling; defaults to AGENT_APM. Overridable
 *   only for tests that need a small, fast-to-exhaust budget — production callers always use the
 *   one published default.
 * @returns {{tryConsume: (owner: string, nowMs: number) => boolean,
 *            remaining: (owner: string, nowMs: number) => {actions: number, cap: number, seconds_until_next: number}}}
 */
export function createAgentApmGuard(apm = AGENT_APM) {
  const cap = Math.max(2, apm * APM_BURST_FRAC);
  /** @type {Map<string, {actionBudget: number, lastMs: number}>} */
  const bySeat = new Map();

  function tryConsume(owner, nowMs) {
    let budget = bySeat.get(owner);
    if (!budget) {
      // First-ever touch for this seat — see this file's own header for why the full cap, not 0.
      budget = { actionBudget: cap, lastMs: nowMs };
      bySeat.set(owner, budget);
    } else {
      const elapsedSeconds = Math.max(0, (nowMs - budget.lastMs) / 1000);
      budget.actionBudget = Math.min(budget.actionBudget + (apm / 60) * elapsedSeconds, cap);
      budget.lastMs = nowMs;
    }
    if (budget.actionBudget < 1) return false;
    budget.actionBudget -= 1;
    return true;
  }

  // Agent-observability: how much budget is actually left, WITHOUT spending any of it. An agent
  // previously learned its budget only by being refused — so batching was guesswork, and the
  // honest strategy ("fire and see") is the one that wastes the budget fastest. Accrual is lazy
  // here exactly as in tryConsume, so asking is free and never itself changes the answer beyond
  // crediting time that had already passed.
  function remaining(owner, nowMs) {
    const budget = bySeat.get(owner);
    if (!budget) return { actions: Math.floor(cap), cap, seconds_until_next: 0 };
    const elapsedSeconds = Math.max(0, (nowMs - budget.lastMs) / 1000);
    const balance = Math.min(budget.actionBudget + (apm / 60) * elapsedSeconds, cap);
    return {
      actions: Math.floor(balance),
      cap,
      // Zero whenever an action is available right now; otherwise how long until one is.
      seconds_until_next: balance >= 1 ? 0 : Math.round(((1 - balance) / (apm / 60)) * 10) / 10,
    };
  }

  return { tryConsume, remaining };
}
