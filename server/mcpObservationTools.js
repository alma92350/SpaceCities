/* ============================================================
   T-052 (FR-14): get_situation / list_entities / get_map_overview / get_tech_options. Every one
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
    return handler({ seat, proj, ...rest });
  };
}

function countByType(items) {
  const out = {};
  for (const it of items) out[it.type] = (out[it.type] || 0) + 1;
  return out;
}

// The ONLY fields an observer needs to reason about an entity's presence and health — never the
// raw engine object's order/orderQueue/homeCC/rally/tier/queue/etc., which is both far larger
// than this task's own "fits a reasonable context" budget and none of it meaningful to an agent
// that doesn't itself own the entity (and for the seat's OWN entities, action tools — T-053 — are
// the place to read and act on order state, not this observation-only surface).
function trimEntity(e) {
  return { id: e.id, type: e.type, owner: e.owner, x: e.x, y: e.y, hp: e.hp };
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
      description: "A compact status summary for the calling seat: match tick/time, whether it has ended, own resources, and own unit/building counts by type. For individual entity detail (including visible enemies), use list_entities instead.",
      inputSchema: { type: "object", properties: { seat_handle: { type: "string" } }, required: ["seat_handle"] },
      handler: withSeat(lobby, seatAndProj(getCache, ({ seat, proj }) => {
        const ownUnits = proj.units.filter(u => u.owner === seat.owner);
        const ownBuildings = proj.buildings.filter(b => b.owner === seat.owner);
        return {
          content: [{ type: "text", text: `Tick ${proj.tick} (t=${proj.time.toFixed(1)}s)${proj.over ? ", match over" : ""}. ${ownUnits.length} units, ${ownBuildings.length} buildings.` }],
          structuredContent: {
            tick: proj.tick, time: proj.time, over: proj.over, winner: proj.winner,
            resources: proj.players[seat.owner].resources,
            units_by_type: countByType(ownUnits),
            buildings_by_type: countByType(ownBuildings),
          },
        };
      })),
    },
    {
      name: "list_entities",
      title: "List visible entities",
      description: "Lists every unit/building currently visible to the calling seat — its own, always, plus any enemy's currently inside its fog of war. Each entry is trimmed to id/type/owner/x/y/hp. Optionally filter by owner or type to narrow a large list.",
      inputSchema: {
        type: "object",
        properties: {
          seat_handle: { type: "string" },
          owner: { type: "string", description: "Only entities belonging to this owner id" },
          type: { type: "string", description: "Only entities of this unit/building type" },
        },
        required: ["seat_handle"],
      },
      handler: withSeat(lobby, seatAndProj(getCache, ({ proj, owner, type }) => {
        let entities = [...proj.units, ...proj.buildings];
        if (owner) entities = entities.filter(e => e.owner === owner);
        if (type) entities = entities.filter(e => e.type === type);
        return {
          content: [{ type: "text", text: `${entities.length} visible entities.` }],
          structuredContent: { entities: entities.map(trimEntity) },
        };
      })),
    },
    {
      name: "get_map_overview",
      title: "Get map overview",
      description: "Discovered resource nodes (id and current amount) and every currently-visible base's owner and position. A node this seat has never explored, or an enemy base outside its fog, never appears.",
      inputSchema: { type: "object", properties: { seat_handle: { type: "string" } }, required: ["seat_handle"] },
      handler: withSeat(lobby, seatAndProj(getCache, ({ proj }) => {
        const bases = proj.buildings
          .filter(b => BUILDINGS[b.type]?.isCommandCenter)
          .map(b => ({ owner: b.owner, x: b.x, y: b.y }));
        return {
          content: [{ type: "text", text: `${proj.nodes.length} discovered resource node(s), ${bases.length} visible base(s).` }],
          structuredContent: { nodes: proj.nodes, bases },
        };
      })),
    },
    {
      name: "get_tech_options",
      title: "Get buildable units and buildings",
      description: "Every unit and building type, each annotated with whether this seat currently meets its prerequisites and can currently afford it. A type needing a building or upgrade this match doesn't have reads prereqs_met:false rather than being omitted, so the list stays a complete reference. Odyssey-only research is not included over this transport yet.",
      inputSchema: { type: "object", properties: { seat_handle: { type: "string" } }, required: ["seat_handle"] },
      handler: withSeat(lobby, seatAndProj(getCache, ({ seat, proj }) => {
        const miniState = miniStateFor(proj, seat.owner);
        const resources = proj.players[seat.owner].resources;
        const optionFor = def => ({
          type: def.id, cost: def.cost || {},
          prereqs_met: prereqsMet(miniState, seat.owner, def),
          affordable: canAfford(resources, def.cost || {}),
        });
        const units = Object.values(UNITS).map(optionFor);
        const buildings = Object.values(BUILDINGS).map(optionFor);
        const readyCount = list => list.filter(o => o.prereqs_met && o.affordable).length;
        return {
          content: [{ type: "text", text: `${readyCount(units)} unit type(s) and ${readyCount(buildings)} building type(s) currently ready to build.` }],
          structuredContent: { units, buildings, techs: [] },
        };
      })),
    },
  ];
}
