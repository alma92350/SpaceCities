/* ============================================================
   A session owns one match: the engine state, and the ONLY path anything
   outside engine/ has to mutate it. ADR-0003 (server authority) + ADR-0004
   (single-player rides the same seam) — this is the object both the
   in-process loopback transport (net/loopback.js, Phase 1) and, later, a
   real per-connection server handler (Phase 3) wrap.

   PHASE 1 SCOPE. submitCommand resolves ids and applies the matching
   engine/commands.js issue* call — it does NOT validate ownership or fog.
   There is exactly one trusted local client in Phase 1 (loopback), so that
   validation has nothing to defend against yet; Phase 2's net/commandCodec.js
   adds it as a layer IN FRONT of this file, not a rewrite of it (see
   net/commandShapes.js's own header for the fuller version of this argument).
   What this file DOES do even now, deliberately: drop a dead id gracefully
   rather than throw (a real race, not an attack) and reject a malformed or
   unknown command shape (a client bug, not a security event) — both are
   ordinary robustness, independent of who's allowed to do what.

   TICKING. A session does not own a loop (no requestAnimationFrame, no
   setInterval) — tick(dt) advances the sim by exactly one step and returns.
   The CALLER decides the cadence: boot.js's engine/loop.js accumulator in
   the browser, a plain interval for a headless server, or a tight while-loop
   for a bench/test. This mirrors how engine/sim.js's own tick(state, dt) has
   always worked — ticked externally, never self-driving.

   aiSeats lets a session drive MORE than the engine's own built-in "ai" seat
   (engine/sim.js's tick already calls runAI for owner "ai" internally) —
   e.g. aiSeats:["player"] reproduces tools/selfplay.js's tickSelfPlay for a
   fully headless AI-vs-AI match (T-010's own exit criterion), the same
   mechanism Phase 6's MCP-agent-vs-AI matches and Phase 3's server-hosted
   matches will both reuse.
   ============================================================ */

"use strict";

import { createGameState } from "../engine/state.js";
import { tick } from "../engine/sim.js";
import { runAI } from "../engine/ai.js";
import {
  issueMove, issueGather, issueServiceBuilding, issueFerryFreighter, issueRepair,
  issueSetHomeBase, issueSetAILogistics, issueSetCollectPoint, issueSetLogiPriority,
  issueAttack, issueAttackMove, issueEscort, issueHoldFormation, issueBuild,
  issueAssistBuild, issueStop, issueRecycle, issueCancelRecycle, issueHold,
  issuePatrol, issueScout, issueSetRally,
} from "../engine/commands.js";
import { queueProduction, cancelProduction, researchUpgrade } from "../engine/production.js";
import { researchTech, cancelResearch } from "../engine/techtree.js";
import { lightFuse } from "../engine/bomb.js";

export const REJECT = Object.freeze({
  MALFORMED: "malformed",
  UNKNOWN_TYPE: "unknown-type",
  EMPTY: "empty-selection",
  NO_TARGET: "no-target",
  TOO_MANY: "too-many",
});

const MAX_BATCH = 16;

const ok = result => (result === undefined ? { ok: true } : { ok: true, result });
const err = code => ({ ok: false, code });

/* ---------- id resolution: existence only, no ownership/fog (Phase 2's job) ----------
   Same EMPTY-vs-MALFORMED split as the Phase 2 codec this feeds into (dossier 02
   resolveOwn): an id that isn't even a non-empty string is a client bug (MALFORMED);
   ids that are well-formed but resolve to nothing (a unit that died between the
   player clicking and this command applying) is a legitimate race (EMPTY), not a bug. */
function resolveIds(state, ids, pick) {
  if (!Array.isArray(ids) || ids.length === 0) return err(REJECT.EMPTY);
  if (ids.length > 400) return err(REJECT.TOO_MANY);
  const out = [];
  for (const id of ids) {
    if (typeof id !== "string" || !id) return err(REJECT.MALFORMED);
    const e = pick(state, id);
    if (e) out.push(e);
  }
  return out.length ? ok(out) : err(REJECT.EMPTY);
}

const pickUnit = (state, id) => state.units.get(id) || null;
const pickEntity = (state, id) => state.units.get(id) || state.buildings.get(id) || null;
const isStr = v => typeof v === "string" && v.length > 0;
const isNum = v => typeof v === "number" && Number.isFinite(v);

function resolveBuilding(state, id) {
  if (!isStr(id)) return err(REJECT.MALFORMED);
  const b = state.buildings.get(id);
  return b ? ok(b) : err(REJECT.NO_TARGET);
}

function resolveNode(state, id) {
  if (!isStr(id)) return err(REJECT.MALFORMED);
  const n = state.map.nodes.find(n => n.id === id);
  return n ? ok(n) : err(REJECT.NO_TARGET);
}

/* ---------- the dispatch table: WireCommand.t -> (state, cmd) -> CommandResult ----------
   Each handler resolves ITS OWN ids/targets, then delegates to the same engine/
   function the single-player client calls today — no game rule is reimplemented
   here (affordability, prereqs, placement all stay in engine/, exactly as ADR-0006
   for Phase 2's codec documents). */

const HANDLERS = {
  move(state, cmd) {
    const units = resolveIds(state, cmd.ids, pickUnit);
    if (!units.ok) return units;
    if (!isNum(cmd.x) || !isNum(cmd.y)) return err(REJECT.MALFORMED);
    issueMove(units.result, cmd.x, cmd.y, !!cmd.q, cmd.f);
    return ok();
  },
  attackMove(state, cmd) {
    const units = resolveIds(state, cmd.ids, pickUnit);
    if (!units.ok) return units;
    if (!isNum(cmd.x) || !isNum(cmd.y)) return err(REJECT.MALFORMED);
    issueAttackMove(units.result, cmd.x, cmd.y, !!cmd.q, cmd.f);
    return ok();
  },
  holdFormation(state, cmd) {
    const units = resolveIds(state, cmd.ids, pickUnit);
    if (!units.ok) return units;
    issueHoldFormation(units.result, cmd.s, cmd.l);
    return ok();
  },
  patrol(state, cmd) {
    const units = resolveIds(state, cmd.ids, pickUnit);
    if (!units.ok) return units;
    if (!Array.isArray(cmd.pts) || cmd.pts.length === 0 || cmd.pts.length > 32) return err(REJECT.MALFORMED);
    issuePatrol(units.result, cmd.pts);
    return ok();
  },
  stop(state, cmd) {
    const units = resolveIds(state, cmd.ids, pickUnit);
    if (!units.ok) return units;
    issueStop(units.result);
    return ok();
  },
  hold(state, cmd) {
    const units = resolveIds(state, cmd.ids, pickUnit);
    if (!units.ok) return units;
    issueHold(units.result);
    return ok();
  },
  scout(state, cmd) {
    const units = resolveIds(state, cmd.ids, pickUnit);
    if (!units.ok) return units;
    issueScout(units.result);
    return ok();
  },
  attack(state, cmd) {
    const units = resolveIds(state, cmd.ids, pickUnit);
    if (!units.ok) return units;
    const target = resolveEntityId(state, cmd.target);
    if (!target.ok) return target;
    issueAttack(units.result, target.result.id, !!cmd.q);
    return ok();
  },
  escort(state, cmd) {
    const units = resolveIds(state, cmd.ids, pickUnit);
    if (!units.ok) return units;
    const target = resolveEntityId(state, cmd.target);
    if (!target.ok) return target;
    issueEscort(units.result, target.result.id, !!cmd.q);
    return ok();
  },
  repair(state, cmd) {
    const units = resolveIds(state, cmd.ids, pickUnit);
    if (!units.ok) return units;
    const target = resolveEntityId(state, cmd.target);
    if (!target.ok) return target;
    issueRepair(units.result, target.result.id, !!cmd.q);
    return ok();
  },
  gather(state, cmd) {
    const units = resolveIds(state, cmd.ids, pickUnit);
    if (!units.ok) return units;
    const node = resolveNode(state, cmd.node);
    if (!node.ok) return node;
    issueGather(units.result, node.result.id, !!cmd.q);
    return ok();
  },
  service(state, cmd) {
    const units = resolveIds(state, cmd.ids, pickUnit);
    if (!units.ok) return units;
    const target = resolveBuilding(state, cmd.target);
    if (!target.ok) return target;
    issueServiceBuilding(units.result, target.result.id, !!cmd.q);
    return ok();
  },
  ferry(state, cmd) {
    const units = resolveIds(state, cmd.ids, pickUnit);
    if (!units.ok) return units;
    const target = resolveEntityId(state, cmd.target);
    if (!target.ok) return target;
    issueFerryFreighter(units.result, target.result.id, !!cmd.q);
    return ok();
  },
  setHomeBase(state, cmd) {
    const units = resolveIds(state, cmd.ids, pickUnit);
    if (!units.ok) return units;
    const target = resolveBuilding(state, cmd.target);
    if (!target.ok) return target;
    issueSetHomeBase(units.result, target.result.id);
    return ok();
  },
  assistBuild(state, cmd) {
    const units = resolveIds(state, cmd.ids, pickUnit);
    if (!units.ok) return units;
    const target = resolveBuilding(state, cmd.target);
    if (!target.ok) return target;
    issueAssistBuild(units.result, target.result.id, target.result.type, !!cmd.q);
    return ok();
  },
  build(state, cmd) {
    if (!isStr(cmd.worker) || !isStr(cmd.b) || !isNum(cmd.x) || !isNum(cmd.y)) return err(REJECT.MALFORMED);
    const buildingId = issueBuild(state, cmd.worker, cmd.b, cmd.x, cmd.y);
    return buildingId ? ok({ buildingId }) : err(REJECT.NO_TARGET);
  },
  recycle(state, cmd) {
    const entities = resolveIds(state, cmd.ids, pickEntity);
    if (!entities.ok) return entities;
    issueRecycle(entities.result);
    return ok();
  },
  cancelRecycle(state, cmd) {
    const entities = resolveIds(state, cmd.ids, pickEntity);
    if (!entities.ok) return entities;
    issueCancelRecycle(entities.result);
    return ok();
  },
  setAILogistics(state, cmd) {
    const units = resolveIds(state, cmd.ids, pickUnit);
    if (!units.ok) return units;
    if (typeof cmd.on !== "boolean") return err(REJECT.MALFORMED);
    issueSetAILogistics(units.result, cmd.on, state);
    return ok();
  },
  setCollectPoint(state, cmd) {
    const units = resolveIds(state, cmd.ids, pickUnit);
    if (!units.ok) return units;
    if (typeof cmd.on !== "boolean") return err(REJECT.MALFORMED);
    issueSetCollectPoint(units.result, cmd.on);
    return ok();
  },
  setLogiPriority(state, cmd) {
    if (!isStr(cmd.building)) return err(REJECT.MALFORMED);
    issueSetLogiPriority(state, cmd.building, cmd.p);
    return ok();
  },
  setRally(state, cmd) {
    const building = resolveBuilding(state, cmd.building);
    if (!building.ok) return building;
    if (!isNum(cmd.x) || !isNum(cmd.y)) return err(REJECT.MALFORMED);
    issueSetRally(building.result, cmd.x, cmd.y, cmd.node ?? null);
    return ok();
  },
  queueProduction(state, cmd) {
    const building = resolveBuilding(state, cmd.building);
    if (!building.ok) return building;
    if (!isStr(cmd.u)) return err(REJECT.MALFORMED);
    queueProduction(state, building.result.id, cmd.u, !!cmd.alt);
    return ok();
  },
  cancelProduction(state, cmd) {
    const building = resolveBuilding(state, cmd.building);
    if (!building.ok) return building;
    if (!isNum(cmd.i)) return err(REJECT.MALFORMED);
    cancelProduction(state, building.result.id, cmd.i);
    return ok();
  },
  researchUpgrade(state, cmd) {
    const building = resolveBuilding(state, cmd.building);
    if (!building.ok) return building;
    if (!isStr(cmd.up)) return err(REJECT.MALFORMED);
    researchUpgrade(state, building.result.id, cmd.up);
    return ok();
  },
  researchTech(state, cmd) {
    const building = resolveBuilding(state, cmd.building);
    if (!building.ok) return building;
    if (!isStr(cmd.tech)) return err(REJECT.MALFORMED);
    researchTech(state, building.result.id, cmd.tech);
    return ok();
  },
  cancelResearch(state, cmd) {
    const building = resolveBuilding(state, cmd.building);
    if (!building.ok) return building;
    if (!isNum(cmd.i)) return err(REJECT.MALFORMED);
    cancelResearch(state, building.result.id, cmd.i);
    return ok();
  },
  lightFuse(state, cmd) {
    if (!isStr(cmd.unit)) return err(REJECT.MALFORMED);
    const bomb = state.units.get(cmd.unit);
    if (!bomb) return err(REJECT.NO_TARGET);
    lightFuse(state, bomb);
    return ok();
  },
  batch(state, cmd) {
    if (!Array.isArray(cmd.c) || cmd.c.length === 0 || cmd.c.length > MAX_BATCH) return err(REJECT.MALFORMED);
    for (const sub of cmd.c) {
      if (sub && sub.t === "batch") return err(REJECT.MALFORMED);   // no nesting
      const r = applyCommand(state, sub);
      if (!r.ok) return r;   // all-or-nothing: the client's disambiguation was built on stale state
    }
    return ok();
  },
};

function resolveEntityId(state, id) {
  if (!isStr(id)) return err(REJECT.MALFORMED);
  const e = pickEntity(state, id);
  return e ? ok(e) : err(REJECT.NO_TARGET);
}

/**
 * Apply one WireCommand (net/commandShapes.js) to `state`. Exported standalone
 * (not just as a session method) so Phase 2's net/commandCodec.js can call it
 * directly once it has already done its own ownership/fog validation, without
 * needing a whole session object just to reach the dispatch table.
 * @param {State} state
 * @param {WireCommand} cmd
 * @returns {CommandResult}
 */
export function applyCommand(state, cmd) {
  if (!cmd || typeof cmd !== "object" || typeof cmd.t !== "string") return err(REJECT.MALFORMED);
  const handler = HANDLERS[cmd.t];
  if (!handler) return err(REJECT.UNKNOWN_TYPE);
  return handler(state, cmd);
}

/**
 * @param {Object} opts - everything engine/state.js's createGameState takes,
 *   plus:
 * @param {string[]} [opts.aiSeats] - extra owners to drive via runAI(state, dt, owner)
 *   on every tick, beyond the engine's own built-in "ai" seat. Empty for an
 *   ordinary human-vs-AI skirmish; ["player"] for a fully headless AI-vs-AI
 *   match (T-010's exit criterion, tools/selfplay.js's own pattern).
 * @param {State} [opts.state] - wrap this ALREADY-BUILT state instead of building a fresh one
 *   from the rest of opts (which are ignored when this is given). For boot.js's loaded-game
 *   path (T-012): a deserialized save is reconstructed by engine/persist.js, not by
 *   createGameState(gameOpts) — there is no seed/rng to rebuild it from — so the session has to
 *   be able to wrap whatever state the caller already has in hand.
 */
export function createSession(opts = {}) {
  const { aiSeats = [], state: providedState, ...gameOpts } = opts;
  const state = providedState || createGameState(gameOpts);

  return {
    getState() {
      return state;
    },
    tick(dt) {
      for (const owner of aiSeats) runAI(state, dt, owner);
      tick(state, dt);
    },
    submitCommand(cmd) {
      return applyCommand(state, cmd);
    },
  };
}
