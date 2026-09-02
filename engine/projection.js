// @ts-check
/* ============================================================
   ADR-0009: the ONE function that produces client-bound state. Every field below follows the
   ADR's decision table directly — see docs/adr/0009-fog-filtered-state.md for the reasoning this
   implements. The map is never included: it's deterministic from (planetId, seed, sizeMult,
   resourceMult, swapAsym), which the caller already has, and the client regenerates it locally.

   Deliberately security-critical (the ADR's own word): a field added to Unit/Building/Player
   without updating this function is an intel leak, not just a missed feature. The no-leak crawler
   in test/projection.test.js exists specifically to catch that class of regression — it walks a
   whole projected+JSON-round-tripped state looking for anything that shouldn't be there, rather
   than trusting that this file's own field list stays exhaustive by inspection.

   Reuses persist.js's sanitizeUnitForExternal/sanitizeBuildingForExternal for the "strip transient,
   session-only bookkeeping" concern (the same denylist the save format needs, for the same reason:
   some of those fields are live object references that can't survive JSON.stringify at all) rather
   than duplicating it — this function's own job is layered strictly on top: which entities this
   seat gets to see at all, and which of their fields are gameplay intel rather than fog itself.
   ============================================================ */

"use strict";

import { isVisibleAt, isNodeDiscovered } from "./fog.js";
import { sanitizeUnitForExternal, sanitizeBuildingForExternal } from "./persist.js";
import { supplyUsed, supplyCap } from "./supply.js";
import { playerScore } from "./victory.js";

// order/orderQueue/homeCC/targetId reveal an enemy's current intent, not what fog is supposed to
// reveal (position, hp, type) — ADR-0009's own list. order/orderQueue are reset to their "idle"
// shape rather than just omitted, so a consumer reading seen.order doesn't need an own-vs-enemy
// branch to know what "no order" looks like; homeCC/targetId are simply absent.
function stripIntel(entity) {
  const { order, orderQueue, homeCC, targetId, ...rest } = entity;
  return { ...rest, order: null, orderQueue: [] };
}

// Facts about a player anyone in the match is entitled to see — a faction roster and public
// scoreboard, not their economy. score/supply/supplyCap are computed, not stored fields (see
// engine/victory.js, engine/supply.js), so every seat's record needs them synthesized here.
function publicPlayer(state, id) {
  const p = state.players[id];
  return {
    id: p.id, faction: p.faction, isAI: p.isAI, color: p.color,
    score: playerScore(state, id),
    supply: supplyUsed(state, id),
    supplyCap: supplyCap(state, id),
  };
}

/** @param {State} state @param {string} seat @returns {Object} */
export function projectFor(state, seat) {
  const fog = state.fogs[seat];
  const ownOrVisible = (e) => e.owner === seat || isVisibleAt(fog, e.x, e.y);

  const units = [...state.units.values()]
    .filter(ownOrVisible)
    .map(u => (u.owner === seat ? sanitizeUnitForExternal(u) : stripIntel(sanitizeUnitForExternal(u))));

  const buildings = [...state.buildings.values()]
    .filter(ownOrVisible)
    .map(b => (b.owner === seat ? sanitizeBuildingForExternal(b) : stripIntel(sanitizeBuildingForExternal(b))));

  // Only `amount` is dynamic (harvested down over time) — everything else about a node the client
  // can already regenerate deterministically from the seed, same as the map it lives on. A hidden
  // node (a cache) is included at all only once this seat's fog has explored its cell; a charted
  // node needs no such gate.
  const nodes = state.map.nodes
    .filter(n => !n.hidden || isNodeDiscovered(fog, n))
    .map(n => ({ id: n.id, amount: n.amount }));

  /** @type {Object.<string, Object>} */
  const players = {};
  for (const id of state.owners) {
    players[id] = id === seat
      ? { ...publicPlayer(state, id), resources: { ...state.players[id].resources }, upgrades: { ...state.players[id].upgrades } }
      : publicPlayer(state, id);
  }

  // Own events always pass; anyone else's only if this seat could currently see where it happened
  // — the same rule as an entity, applied to a point instead of a moving thing.
  const events = state.events.filter(e => e.owner === seat || isVisibleAt(fog, e.x, e.y));

  return {
    tick: state.tick, time: state.time, over: state.over, winner: state.winner, winReason: state.winReason ?? null,
    owners: state.owners,
    players,
    units, buildings, nodes,
    // Keyed like state.fogs itself, just narrowed to the one seat this projection is for — so a
    // client that ever needs to compare shapes with the live engine state doesn't need a special
    // case. explored/visible are copied out of their Uint8Array into plain arrays, the same
    // JSON-safety step engine/persist.js already takes for the save format.
    fogs: { [seat]: { cols: fog.cols, rows: fog.rows, explored: [...fog.explored], visible: [...fog.visible] } },
    events,
  };
}

/**
 * The paired decode step for a projectFor(...) payload that has crossed the wire (so `wire` here
 * is already a plain JSON value, never a live State) — reassembles it into the shape render.js and
 * the rest of the client already read: units/buildings indexed into Maps by id (projectFor emits
 * arrays, the JSON-safe form), `fog`/`fogAI` aliases matching state.js's own (a single-seat
 * projection only ever carries its OWN fog, so both aliases point at the one entry `wire.fogs`
 * has), and `selection: []` — UI-only, and never part of the wire contract at all (ADR-0006 rule
 * 5: it moves to the client session, the server never reads or sends it).
 *
 * `map` is supplied by the caller, never the payload — projectFor deliberately omits it (ADR-0009:
 * deterministic from opts the client already has), so reassembly needs the SAME map the projection
 * was taken against, regenerated locally exactly as engine/state.js's own createGameState would.
 *
 * This is the one property that makes T-026's WebSocket transport satisfy its own exit criterion
 * ("swapping loopback -> WebSocket changes no client code above the transport"): loopback delivers
 * the live engine State object as-is; a WebSocket transport delivers wire JSON, and doing the
 * reassembly HERE — inside the transport, before a StateEvent is ever emitted — is what lets
 * everything above the transport boundary keep reading `event.state` exactly as it always did.
 * Proven pixel-identical against the real renderer by test/projection.test.js's own M0 case, the
 * one this function was extracted out of rather than left duplicated at every future call site.
 * @param {Object} wire - a JSON.parse'd projectFor(...) payload
 * @param {GameMap} map - the client's own locally-regenerated map for this match
 * @returns {Object} a state-shaped object render.js and the client's own read paths already expect
 */
export function reassembleProjection(wire, map) {
  const seat = Object.keys(wire.fogs)[0];
  return {
    ...wire,
    map,
    units: new Map(wire.units.map(u => [u.id, u])),
    buildings: new Map(wire.buildings.map(b => [b.id, b])),
    selection: [],
    fog: wire.fogs[seat],
    fogAI: wire.fogs[seat],
  };
}
