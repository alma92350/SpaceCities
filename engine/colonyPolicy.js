// @ts-check
/* ============================================================
   Colony standing orders — the second half of the Phase 6 colony-economy rework
   (the first half is engine/galaxy.js's Freight Lanes; the roadmap explicitly calls
   these "two halves of a single rework", designed together).

   A held colony you leave keeps SIMULATING (stepGalaxy), but until now the player
   side of it got no new orders: production queues emptied and stayed empty, workers
   idled by a depleted node never reassigned, and manufactured surplus piled up in the
   stockpile doing nothing — passive income was a flat, capped 0.3 credits/s/building
   (COLONY_INCOME_PER_BUILDING/COLONY_INCOME_CAP, engine/galaxy.js sweepColonies)
   completely divorced from what the colony actually produces.

   This module is a small per-colony POLICY STORE on the galaxy (a Map
   planetId -> {autoSell, workerTarget}), executed once per throttled galaxy scan
   (stepGalaxy's PROGRESS_CHECK_EVERY block — see runColonyPolicies' own header)
   for BACKGROUND worlds only; the active/rendered seat takes real player orders
   instead, exactly like sweepColonies' own income sweep.

   Two standing orders, both opt-in (off by default — a fresh policy is inert):
     • Auto-sell surplus — sell stock above a per-commodity floor into the world's
       OWN market via the real sell() path (engine/market.js): real slippage, real
       glut. This makes passive income the colony's actual PRODUCTION, and the
       market's own math is what bounds the runaway-annuity worry the
       COLONY_INCOME_CAP comment raises — no separate cap needed here. It's
       ADDITIVE on top of the flat per-building income (sweepColonies), not a
       replacement for it — the flat rate stays the floor under every colony,
       auto-sell is the extra a colony that's actually producing earns on top.
     • Sustain workers — re-queue one worker at the Command Center (paid from the
       COLONY'S OWN stockpile, via production.js queueProduction — never galaxy
       credits) when under a target headcount, and re-task any idle player worker
       on the world to gather (aiWorkers.js's owner-generic assignIdlePlayerGather).

   Deterministic like the rest of the galaxy scheduler: runColonyPolicies is called
   on an INTEGER galaxy.tick schedule (stepGalaxy), iterates galaxy.planets in its
   one fixed Map order (the same order sweepColonies already relies on), and reaches
   for no clock or RNG anywhere in this file.
   ============================================================ */

"use strict";

import { queueProduction } from "./production.js";
import { assignIdlePlayerGather } from "./aiWorkers.js";
import { sell } from "./market.js";
import { COM } from "../data.js";

// A sustain-workers target above this is almost certainly a fat-fingered/garbage save value —
// clamp it so a corrupt or hand-edited policy can't queue an unbounded worker-spam script.
export const MAX_WORKER_TARGET = 20;

// Coerce/clamp an untrusted (or freshly-defaulted) policy into the one shape this module ever
// reads: {autoSell:{enabled,floors}, workerTarget}. Used both by the live setter (setColonyPolicy)
// and by engine/persist.js on load, so save data gets exactly the same treatment a live edit does
// — an unknown commodity or a negative/NaN floor is dropped rather than trusted, and workerTarget
// is clamped into range. A missing/garbage `p` (no policy set yet, or a corrupt save entry)
// resolves to the fully-off default: autoSell disabled, no floors, no sustain target.
/**
 * @param {Object} p an untrusted policy object (a save, or a UI edit)
 * @returns {Object} a policy with every field coerced into range
 */
export function sanitizePolicy(p) {
  const src = (p && typeof p === "object") ? p : {};
  const autoSellSrc = (src.autoSell && typeof src.autoSell === "object") ? src.autoSell : {};
  const floors = {};
  if (autoSellSrc.floors && typeof autoSellSrc.floors === "object") {
    for (const com in autoSellSrc.floors) {
      if (!COM[com]) continue;                                  // not a real commodity — drop it
      const v = Number(autoSellSrc.floors[com]);
      if (Number.isFinite(v) && v >= 0) floors[com] = v;
    }
  }
  const workerTarget = Math.max(0, Math.min(MAX_WORKER_TARGET, Math.round(Number(src.workerTarget) || 0)));
  return { autoSell: { enabled: !!autoSellSrc.enabled, floors }, workerTarget };
}

// The policy for `planetId`, or the off-default when none has been set. Never returns a live
// reference into the store — callers get their own sanitized copy.
/**
 * @param {Galaxy} galaxy
 * @param {string} planetId
 * @returns {Object} that planet's policy, defaulted if it has none yet
 */
export function getColonyPolicy(galaxy, planetId) {
  const policies = galaxy.colonyPolicies;
  return sanitizePolicy(policies ? policies.get(planetId) : null);
}

// Patch a colony's policy (creating the store/entry on first use). `patch.autoSell.floors` MERGES
// into the existing floor set (a UI editing one commodity's floor shouldn't blow away every other
// commodity's), while `patch.autoSell.enabled`/`patch.workerTarget` simply override when present.
// Returns the resulting sanitized policy.
/**
 * @param {Galaxy} galaxy
 * @param {string} planetId
 * @param {Object} [patch] fields to merge into the planet's current policy
 * @returns {Object} the resulting sanitized policy
 */
export function setColonyPolicy(galaxy, planetId, patch = {}) {
  const policies = galaxy.colonyPolicies || (galaxy.colonyPolicies = new Map());
  const current = sanitizePolicy(policies.get(planetId));
  const merged = sanitizePolicy({
    autoSell: {
      enabled: patch.autoSell && patch.autoSell.enabled !== undefined ? patch.autoSell.enabled : current.autoSell.enabled,
      floors: { ...current.autoSell.floors, ...(patch.autoSell && patch.autoSell.floors) },
    },
    workerTarget: patch.workerTarget !== undefined ? patch.workerTarget : current.workerTarget,
  });
  policies.set(planetId, merged);
  return merged;
}

const playerWorkerCount = state => {
  let n = 0;
  for (const u of state.units.values()) if (u.owner === "player" && u.type === "worker") n++;
  return n;
};

// The player's own Command Center on this world (deterministic tie-break by id — there's
// normally exactly one on a colony anyway).
function findCommandCenter(state) {
  let best = null;
  for (const b of state.buildings.values()) {
    if (b.owner !== "player" || b.type !== "command" || b.constructing) continue;
    if (!best || b.id < best.id) best = b;
  }
  return best;
}

// Sell stock above each configured floor into the world's own market, via the REAL sell() path
// (engine/market.js) — real per-lot slippage and the slow produced-goods glut, so a colony
// dumping its whole surplus at once doesn't get full equilibrium price for every unit. Iterates
// `floors`' own key order (a plain object with commodity-id string keys — insertion order,
// never Map/Set iteration, so this is deterministic without any extra bookkeeping).
function runAutoSell(galaxy, state, policy) {
  if (!policy.autoSell.enabled) return;
  const res = state.players.player.resources;
  for (const com in policy.autoSell.floors) {
    const floor = policy.autoSell.floors[com];
    const surplus = Math.floor((res[com] || 0) - floor);
    if (surplus > 0) sell(galaxy, state, com, surplus);
  }
}

// Top up toward the worker target (one job at a time — queueProduction only fires when the CC's
// queue is already empty, so a colony under target for several throttled ticks in a row can't
// flood the queue with duplicate jobs while the first one is still building) and put any idle
// player worker on this world back to gathering (assignIdlePlayerGather, aiWorkers.js). Both
// halves are gated on workerTarget > 0 — the single "sustain workers" on/off switch.
function runWorkerSustain(state, policy) {
  if (policy.workerTarget <= 0) return;
  const cc = findCommandCenter(state);
  if (cc && cc.queue.length === 0 && playerWorkerCount(state) < policy.workerTarget) {
    queueProduction(state, cc.id, "worker");
  }
  const idle = [];
  for (const u of state.units.values()) if (u.owner === "player" && u.type === "worker" && !u.order) idle.push(u);
  if (idle.length) assignIdlePlayerGather(state, idle);
}

// Execute every colony's standing orders for this throttled scan. Called from stepGalaxy
// alongside its sibling galaxy-wide scans (checkDomination/checkExpansion/checkGalaxyProgress),
// on the exact same PROGRESS_CHECK_EVERY schedule — so this is already an integer-tick-keyed,
// ~1/sec cadence, not a per-frame one. BACKGROUND worlds only: the active/rendered seat is the
// player's own hands-on orders, not a standing policy acting on their behalf.
/**
 * @param {Galaxy} galaxy
 * @returns {void}
 */
export function runColonyPolicies(galaxy) {
  const policies = galaxy.colonyPolicies;
  if (!policies || !policies.size) return;
  for (const [id, state] of galaxy.planets) {
    if (!state.background) continue;
    const raw = policies.get(id);
    if (!raw) continue;
    const policy = sanitizePolicy(raw);
    runAutoSell(galaxy, state, policy);
    runWorkerSustain(state, policy);
  }
}
