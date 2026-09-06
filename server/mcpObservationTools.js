/* ============================================================
   T-052 (FR-14): get_situation / list_entities / get_map_overview / get_tech_options (plus
   get_counters, the static counter triangle — see its own comment for why it is a tool as well as
   an MCP resource). Every one
   of these is built on `cache.latestProjFor(owner)` — server/mcpObservationCache.js's remembered
   copy of engine/projection.js's own projectFor(state, owner) output, already fog-filtered by
   the SAME mechanism every real WebSocket push already goes through. Nothing here re-implements
   fog logic, re-reads a raw unit/building, or reaches into a worker's live state directly — this
   file only SUMMARIZES an already-safe projection into a compact, model-digestible shape (this
   task's own exit criterion: "digest fits a reasonable context").

   TECHS is deliberately left out of get_tech_options' own output (an always-empty `techs: []`,
   not a missing field) — see that tool's own comment for why: `proj` carries no signal for
   whether this match is even Odyssey/endless mode, and this whole port's own scope question
   (TASKS.md's Q3, "is multiplayer Odyssey a wanted v2?") is still open. Threading that signal
   through would mean touching engine/projection.js's own security-critical, already-extensively-
   tested wire shape for a feature this port doesn't yet commit to exposing over MCP at all —
   real work for a later task if Odyssey-over-MCP is ever decided, not a silent gap here.
   ============================================================ */

"use strict";

import { withSeat, rejection } from "./mcpSeatHandle.js";
import { UNITS, BUILDINGS, prereqsMet, canAfford } from "../engine/entities.js";

// Every observation tool needs the SAME two things before it can do anything: a resolved seat
// (withSeat's own job) and THAT SEAT'S OWN match's latest cached projection. `getCache(matchId)`
// looks up the right live match's own cache — a production server hosts many concurrent matches,
// each in its own worker with its own independent projection cache (server/mcpObservationCache.js),
// so a single fixed cache reference would silently answer every seat with the WRONG match's data
// the moment a second match existed. Composing this here means no tool handler below hand-rolls
// either the match lookup or the "no state yet" check separately.
function seatAndProj(getCache, handler) {
  return ({ seat, ...rest }) => {
    const cache = getCache(seat.matchId);
    if (!cache) return rejection("match-not-live: this match hasn't started yet");
    const proj = cache.latestProjFor(seat.owner);
    if (!proj) return rejection("no-state-yet: this match's worker hasn't reported in yet — try again shortly");
    return handler({ seat, proj, cache, ...rest });
  };
}

function countByType(items) {
  const out = {};
  for (const it of items) out[it.type] = (out[it.type] || 0) + 1;
  return out;
}

// What an entity IS and what it is DOING. id/type/owner/x/y/hp are the presence-and-health fields
// this always returned; `activity` and `orderTarget` are new and OWN-ENTITIES-ONLY, because
// engine/projection.js's stripIntel already blanks an enemy's order before it ever reaches this
// file (an enemy's intent is exactly what fog is not supposed to reveal) — so reading them off a
// foreign entity would report a uniform, meaningless "idle" for every enemy on the map. Without
// them there was no way at all to ask "which of my workers is standing still?": a worker whose
// seam ran dry just stopped, indistinguishable in this payload from one mining at full rate, and
// an economy could quietly rot for the rest of the match.
//
// `activity` is deliberately a small, closed vocabulary derived from the order the engine actually
// stores, not the raw order shape: gathering/moving/attacking/building/idle, plus the order's own
// type verbatim for anything outside that set, so a new engine order type degrades to its own name
// rather than being mislabelled as idle.
const ACTIVITY = {
  gather: "gathering", move: "moving", attackMove: "moving", patrol: "moving",
  attack: "attacking", build: "building", assistBuild: "building",
};

function activityOf(e) {
  if (e.constructing) return "under-construction";
  if (e.kind === "building") return (e.queue && e.queue.length) ? "producing" : "idle";
  if (!e.order) return "idle";
  return ACTIVITY[e.order.type] || e.order.type;
}

function trimEntity(e, own) {
  const base = { id: e.id, type: e.type, owner: e.owner, x: e.x, y: e.y, hp: e.hp };
  if (!own) return base;
  return {
    ...base,
    activity: activityOf(e),
    // The order's own target, flattened to whichever id/point it actually carries — enough to tell
    // two gathering workers on different nodes apart without shipping the raw order object.
    orderTarget: orderTargetOf(e),
    ...(e.queue ? { queue: e.queue.map(j => j.unitType) } : {}),
    ...(e.constructing ? { buildProgress: e.buildProgress } : {}),
  };
}

function orderTargetOf(e) {
  const o = e.order;
  if (!o) return null;
  if (o.nodeId) return { nodeId: o.nodeId };
  if (o.targetId) return { entityId: o.targetId };
  if (o.buildingId) return { entityId: o.buildingId };
  if (typeof o.x === "number") return { x: o.x, y: o.y };
  return null;
}

// prereqsMet(state, owner, def) needs state.players[owner] (upgrades) and to scan
// state.buildings.values() for a completed prerequisite — both fully answerable from this seat's
// OWN slice of `proj` (always complete/unfiltered for its own owner), so a deliberately narrower
// State-shaped object works here exactly the way engine/projection.js's own reassembleProjection
// already builds one for updateFog — never the full State, only the two fields the callee reads.
function miniStateFor(proj, owner) {
  const ownBuildings = proj.buildings.filter(b => b.owner === owner);
  return { players: proj.players, buildings: new Map(ownBuildings.map(b => [b.id, b])) };
}

// WHICH prerequisites are missing, using exactly the same rule prereqsMet itself applies (a
// required BUILDING must exist, owned and finished; anything else is an upgrade key on the player)
// — deliberately re-derived per requirement here rather than changing prereqsMet's own boolean
// contract, which the engine, the AI and the UI all depend on.
function missingPrereqs(miniState, owner, def) {
  const reqs = def.requires || [];
  return reqs.filter(req => !prereqsMet(miniState, owner, { requires: [req] }));
}

// The stats an agent needs for combat and build-order math. Read straight off the engine's own
// definitions — the same objects engine/combat.js computes damage from — so a balance change can
// never leave this reporting a stale hand-copied number.
const STAT_FIELDS = ["hp", "attack", "range", "cooldown", "speed", "sight", "buildTime", "supplyCost", "role", "bonusVs", "bonusVsBuildings", "cargoCap", "gatherRate", "altCost"];

function statsOf(def) {
  const out = {};
  for (const f of STAT_FIELDS) if (def[f] !== undefined) out[f] = def[f];
  return out;
}

// Every building type whose own `produces` list contains this unit — the authoritative answer to
// "where do I train this?", and the only honest way to report a unit no building produces at all.
function producersOf(unitType) {
  return Object.values(BUILDINGS).filter(b => b.produces?.includes(unitType)).map(b => b.id);
}

/**
 * @param {Object} lobby a createLobby() instance
 * @param {(matchId:string) => {latestProjFor:(owner:string)=>Object|null}|null} getCache looks up
 *   a LIVE match's own projection cache by id (tools/serve.js's own liveMatches, keyed the same
 *   way) — null for a match that hasn't started yet (no worker, so no cache exists at all).
 */
export function createObservationTools(lobby, getCache) {
  return [
    {
      name: "get_situation",
      title: "Get current situation",
      description: "A compact status summary for the calling seat: match tick/time, whether it has ended, own resources and supply, own unit/building counts by type, which of your units are currently IDLE (idle_unit_ids — check this every turn, an idle worker is the commonest way a match quietly rots), who you are and who you're playing, and the map's bounds and tick rate. For individual entity detail (including visible enemies), use list_entities instead.",
      inputSchema: { type: "object", properties: { seat_handle: { type: "string" } }, required: ["seat_handle"] },
      handler: withSeat(lobby, seatAndProj(getCache, ({ seat, proj, cache }) => {
        const ownUnits = proj.units.filter(u => u.owner === seat.owner);
        const ownBuildings = proj.buildings.filter(b => b.owner === seat.owner);
        // Idle own units are called out as their own number and id list rather than left for the
        // caller to derive from list_entities: an idle worker is the single most common way a
        // match quietly rots (a drained node retargets to nothing and the worker just stops), and
        // nothing in this summary used to hint at it.
        const idle = ownUnits.filter(u => activityOf(u) === "idle");
        const meta = cache.mapMeta?.() ?? null;
        return {
          content: [{ type: "text", text: `Tick ${proj.tick} (t=${proj.time.toFixed(1)}s)${proj.over ? ", match over" : ""}. ${ownUnits.length} units (${idle.length} idle), ${ownBuildings.length} buildings.` }],
          structuredContent: {
            tick: proj.tick, time: proj.time, over: proj.over, winner: proj.winner,
            resources: proj.players[seat.owner].resources,
            supply: proj.players[seat.owner].supply, supply_cap: proj.players[seat.owner].supplyCap,
            units_by_type: countByType(ownUnits),
            buildings_by_type: countByType(ownBuildings),
            idle_unit_ids: idle.map(u => u.id),
            // Who this seat actually IS, and who it is playing against — an agent previously had to
            // infer even "the enemy is west" from where one of its workers happened to die.
            you: seat.owner, opponents: proj.owners.filter(o => o !== seat.owner),
            ...(meta ? { map: meta.map } : {}),
          },
        };
      })),
    },
    {
      name: "list_entities",
      title: "List visible entities",
      description: "Lists every unit/building currently visible to the calling seat — its own, always, plus any enemy's currently inside its fog of war. Each entry carries id/type/owner/x/y/hp; your OWN entities also carry what they are currently doing (activity, orderTarget, a producer's queue, a site's buildProgress) — an enemy's never does, since fog does not reveal intent. Optionally filter by owner or type to narrow a large list.",
      inputSchema: {
        type: "object",
        properties: {
          seat_handle: { type: "string" },
          owner: { type: "string", description: "Only entities belonging to this owner id" },
          type: { type: "string", description: "Only entities of this unit/building type" },
          activity: { type: "string", description: "Only your OWN entities currently doing this: idle, gathering, moving, attacking, building, producing, under-construction. Use 'idle' to find units that have stopped working." },
        },
        required: ["seat_handle"],
      },
      handler: withSeat(lobby, seatAndProj(getCache, ({ seat, proj, owner, type, activity }) => {
        let entities = [...proj.units, ...proj.buildings];
        if (owner) entities = entities.filter(e => e.owner === owner);
        if (type) entities = entities.filter(e => e.type === type);
        let trimmed = entities.map(e => trimEntity(e, e.owner === seat.owner));
        // Filtering on activity happens AFTER the trim, since activity is only ever computed for
        // this seat's own entities (an enemy's order is stripped by the projection itself) — so
        // this filter deliberately narrows to own entities, which is the only case it can answer.
        if (activity) trimmed = trimmed.filter(e => e.activity === activity);
        return {
          content: [{ type: "text", text: `${trimmed.length} visible entities.` }],
          structuredContent: { entities: trimmed },
        };
      })),
    },
    {
      name: "get_map_overview",
      title: "Get map overview",
      description:
        "Every resource node this seat has discovered — id, WHICH COMMODITY it yields (ore/crystal/relic/...), " +
        "its position, its current and maximum amount, and how far it is from your nearest base, nearest first — " +
        "plus every currently-visible base's owner and position and the map's own bounds. A node this seat has " +
        "never explored, or an enemy base outside its fog, never appears. Use this before sending a worker: " +
        "\"the closest ore\" is answerable from `nodes` alone, without scouting each node by hand.",
      inputSchema: { type: "object", properties: { seat_handle: { type: "string" } }, required: ["seat_handle"] },
      handler: withSeat(lobby, seatAndProj(getCache, ({ seat, proj, cache }) => {
        const bases = proj.buildings
          .filter(b => BUILDINGS[b.type]?.isCommandCenter)
          .map(b => ({ owner: b.owner, x: b.x, y: b.y }));
        const ownBases = bases.filter(b => b.owner === seat.owner);
        const distanceFromBase = (x, y) => {
          if (!ownBases.length || typeof x !== "number") return null;
          return Math.round(Math.min(...ownBases.map(b => Math.hypot(b.x - x, b.y - y))));
        };
        // engine/projection.js reduces an ordinary node to {id, amount} — everything else about it
        // is deterministic from the seed a browser client already has, but an MCP agent has no map
        // generator, so it could only learn a node's commodity by walking a worker to it and
        // watching which counter moved. The static half is merged back in here from the match's
        // own describeMap reply (server/mcpObservationCache.js). A wreck or crater node already
        // arrives in full (it does not exist in the seeded map at all), so its own fields win.
        // The merge is keyed by the ids in THIS seat's own fog-filtered proj.nodes, so an
        // undiscovered node stays absent exactly as before — this adds detail, never nodes.
        const meta = cache.mapMeta?.() ?? null;
        const nodes = proj.nodes.map(n => {
          const stat = meta?.nodesById.get(n.id);
          const merged = { ...(stat || {}), ...n };
          const dist = distanceFromBase(merged.x, merged.y);
          return {
            id: merged.id, com: merged.com ?? null, amount: merged.amount,
            max: merged.max ?? null, x: merged.x ?? null, y: merged.y ?? null,
            ...(merged.wreck ? { wreck: true } : {}), ...(merged.crater ? { crater: true } : {}),
            ...(dist === null ? {} : { distance_from_base: dist }),
          };
        }).sort((a, b) => (a.distance_from_base ?? Infinity) - (b.distance_from_base ?? Infinity) || (a.id < b.id ? -1 : 1));
        const live = nodes.filter(n => n.amount > 0);
        return {
          content: [{ type: "text", text: `${nodes.length} discovered resource node(s) (${live.length} not yet depleted), ${bases.length} visible base(s).` }],
          structuredContent: {
            nodes, bases,
            ...(meta ? { map: meta.map } : {}),
            // Which commodities this seat can actually reach right now, cheapest possible check for
            // "can I even afford to plan a turret?" before committing a 40-second worker haul.
            commodities_available: [...new Set(live.map(n => n.com).filter(Boolean))].sort(),
          },
        };
      })),
    },
    {
      name: "get_tech_options",
      title: "Get buildable units and buildings",
      description:
        "Every unit and building type with everything needed to decide whether to build it: cost, full combat/economy " +
        "stats (hp, attack, range, speed, build time, supply), which building produces it, whether this seat meets its " +
        "prerequisites (and if not, exactly which ones are missing) and whether it can currently afford it. A type " +
        "needing a building or upgrade this match doesn't have reads prereqs_met:false rather than being omitted, so " +
        "the list stays a complete reference. Odyssey-only research is not included over this transport yet.",
      inputSchema: { type: "object", properties: { seat_handle: { type: "string" } }, required: ["seat_handle"] },
      handler: withSeat(lobby, seatAndProj(getCache, ({ seat, proj }) => {
        const miniState = miniStateFor(proj, seat.owner);
        const resources = proj.players[seat.owner].resources;
        const supplyRoom = (proj.players[seat.owner].supplyCap ?? 0) - (proj.players[seat.owner].supply ?? 0);
        const optionFor = def => {
          const cost = def.cost || {};
          const producers = UNITS[def.id] ? producersOf(def.id) : null;
          return {
            type: def.id, name: def.name, cost,
            prereqs_met: prereqsMet(miniState, seat.owner, def),
            // WHICH prerequisite is missing, not just that one is — "prereqs_met:false" alone left a
            // caller with no next action, since the requirement isn't visible anywhere else either.
            missing_prereqs: missingPrereqs(miniState, seat.owner, def),
            affordable: canAfford(resources, cost),
            // Combat math is impossible without these, and they were previously reachable only
            // through the game://units MCP resource, which many clients never surface at all — so
            // an agent had no way to answer "do two skiffs beat a bastion?" except by trying it.
            stats: statsOf(def),
            // Where a unit is actually trained. An empty list means NOTHING can produce this type in
            // this match — the honest answer for a scenario-only unit like the Freighter, which
            // previously advertised itself as cost-free and always affordable and could never
            // actually be built by anyone.
            ...(producers ? { produced_by: producers, buildable: producers.length > 0 } : {}),
            ...(UNITS[def.id] && (def.supplyCost || 0) > supplyRoom ? { supply_blocked: true } : {}),
          };
        };
        const units = Object.values(UNITS).map(optionFor);
        const buildings = Object.values(BUILDINGS).map(optionFor);
        const ready = o => o.prereqs_met && o.affordable && o.buildable !== false && !o.supply_blocked;
        const readyCount = list => list.filter(ready).length;
        return {
          content: [{ type: "text", text: `${readyCount(units)} unit type(s) and ${readyCount(buildings)} building type(s) currently ready to build.` }],
          structuredContent: { units, buildings, techs: [] },
        };
      })),
    },
    {
      // The same counter triangle the game://counters MCP resource already publishes, exposed as a
      // TOOL as well: a resource is only readable by a client that surfaces MCP resources at all,
      // and an agent that can only call tools was left memorising matchups from experience.
      // Derived from each unit's own real bonusVs table (the exact data engine/combat.js's
      // attackDamage reads), never a hand-written description of it.
      name: "get_counters",
      title: "Get the unit counter table",
      description: "Every unit type's real bonus damage against another unit type — what counters what — derived from the same data the engine's own combat math uses. Static for the whole match; read it once.",
      inputSchema: { type: "object", properties: { seat_handle: { type: "string" } }, required: ["seat_handle"] },
      handler: withSeat(lobby, () => {
        const counters = [];
        for (const u of Object.values(UNITS)) {
          if (!u.bonusVs) continue;
          for (const [target, bonus] of Object.entries(u.bonusVs)) counters.push({ attacker: u.id, target, bonus });
        }
        return {
          content: [{ type: "text", text: `${counters.length} counter matchup(s).` }],
          structuredContent: { counters },
        };
      }),
    },
  ];
}
