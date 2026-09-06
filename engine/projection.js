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

import { isVisibleAt, isNodeDiscovered, updateFog } from "./fog.js";
import { sanitizeUnitForExternal, sanitizeBuildingForExternal } from "./persist.js";
import { supplyUsed, supplyCap } from "./supply.js";
import { playerScore } from "./victory.js";

// T-037: the sentinel "seat" name server/matchWorker.js posts a projectForSpectator(...) payload
// under, and net/wsWorkerTransport.js matches on to fan it out to every connected spectator instead
// of looking it up in bySeat. Never a real value in state.owners (ADR-0008's own fixed ["player",
// "ai"] pair today, any future N-seat roster tomorrow) — double-underscored so it reads as an
// implementation sentinel on sight, the same convention socket.__scHandled already uses in
// tools/serve.js/net/wsWorkerTransport.js for the same "this is plumbing, not game data" reason.
export const SPECTATOR_SEAT = "__spectator__";

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
  //
  // Bugfix: EXCEPT a wreck (engine/wreckage.js) or crater (engine/bomb.js) node — those are pushed
  // onto state.map.nodes mid-match and do NOT exist in the client's own seed-regenerated map at
  // all, exactly the same "needs its whole shape" case engine/bomb.js's own spawnCraterNode comment
  // already documents for persist.js's rehydratePlanet (the save/load path). The live wire path
  // never got that same treatment: reducing one of these to {id, amount} left reassembleProjection
  // with no way to materialize it (an id it had never seen, and nothing to construct a real node
  // from), so a live multiplayer client never saw battle wreckage or a Helium Bomb crater's own
  // resource node appear at all. Sent in full instead — plain, already-JSON-safe fields, no live
  // object references — same treatment an "added" entity already gets elsewhere in this payload.
  const nodes = state.map.nodes
    .filter(n => !n.hidden || isNodeDiscovered(fog, n))
    .map(n => (n.wreck || n.crater) ? { ...n } : { id: n.id, amount: n.amount });

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
    // The fog grid itself is NEVER sent (ADR-0009 M2): own units/buildings are already right here
    // in this same payload, which is everything engine/fog.js's updateFog needs to recompute this
    // seat's fog client-side — the exact same pure function this file's own `fog` variable above
    // was itself produced by, one layer up in engine/sim.js. See reassembleProjection below for the
    // client-side half of this.
    events,
  };
}

/**
 * T-037 (FR-7): the ONE deliberate exception to this file's own "deliberately security-critical,
 * a leak is a defect" header — a spectator gets full-map vision BY DESIGN (the PRD's own words),
 * so there is no fog to filter by and no seat whose intel needs stripping from anyone else's view.
 * Every unit/building ships with its full, un-stripped fields (order/orderQueue/homeCC/targetId
 * included) for BOTH seats, every player's real resources/upgrades are included, and every node —
 * hidden-and-undiscovered ones too — is included. Still never the map (same deterministic-
 * regeneration contract as projectFor: the spectator's own client regenerates it from the welcome
 * handshake's opts, exactly as an ordinary seat's client already does) and still only the dynamic
 * {id, amount} per node (everything else about it is deterministic from the seed the client
 * already has). Reuses sanitizeUnitForExternal/sanitizeBuildingForExternal — still real, live
 * engine objects underneath, so the same "strip transient, non-serializable bookkeeping" pass
 * projectFor itself needs applies here too; only the FOG-shaped filtering (ownOrVisible, stripIntel)
 * is skipped.
 * @param {State} state @returns {Object}
 */
export function projectForSpectator(state) {
  const units = [...state.units.values()].map(u => sanitizeUnitForExternal(u));
  const buildings = [...state.buildings.values()].map(b => sanitizeBuildingForExternal(b));
  // Bugfix: same wreck/crater exception as projectFor above — see that function's own comment.
  const nodes = state.map.nodes.map(n => (n.wreck || n.crater) ? { ...n } : { id: n.id, amount: n.amount });

  /** @type {Object.<string, Object>} */
  const players = {};
  for (const id of state.owners) {
    players[id] = { ...publicPlayer(state, id), resources: { ...state.players[id].resources }, upgrades: { ...state.players[id].upgrades } };
  }

  return {
    tick: state.tick, time: state.time, over: state.over, winner: state.winner, winReason: state.winReason ?? null,
    owners: state.owners,
    players,
    units, buildings, nodes,
    events: [...state.events],
  };
}

/**
 * The paired decode step for a projectFor(...) payload that has crossed the wire (so `wire` here
 * is already a plain JSON value, never a live State) — reassembles it into the shape render.js and
 * the rest of the client already read: units/buildings indexed into Maps by id (projectFor emits
 * arrays, the JSON-safe form), `fog`/`fogAI` aliases matching state.js's own, and `selection: []`
 * — UI-only, and never part of the wire contract at all (ADR-0006 rule 5: it moves to the client
 * session, the server never reads or sends it).
 *
 * `map` is supplied by the caller, never the payload — projectFor deliberately omits it (ADR-0009:
 * deterministic from opts the client already has), so reassembly needs the SAME map the projection
 * was taken against, regenerated locally exactly as engine/state.js's own createGameState would.
 *
 * `fog` is ALSO supplied by the caller, for the same reason the fog grid itself is never part of
 * `wire` any more (ADR-0009 M2): own units/buildings are already right here in `wire`, which is
 * everything engine/fog.js's updateFog needs, so this recomputes the seat's fog client-side rather
 * than trusting a shipped copy — the dominant cost T-015 measured (bandwidth, not CPU) is exactly
 * what M2 removes. `fog` must be the SAME object across every call for one connection (created
 * once via createFog(map), exactly as net/wsClientTransport.js holds it) — `explored` accumulates
 * monotonically INTO it, in place, the same "never cleared, only added to" contract updateFog
 * already gives the server's own state.fogs[owner]. `seat` is supplied too, now that there is no
 * `wire.fogs` key left to read it back out of.
 *
 * This is the one property that makes T-026's WebSocket transport satisfy its own exit criterion
 * ("swapping loopback -> WebSocket changes no client code above the transport"): loopback delivers
 * the live engine State object as-is; a WebSocket transport delivers wire JSON, and doing the
 * reassembly HERE — inside the transport, before a StateEvent is ever emitted — is what lets
 * everything above the transport boundary keep reading `event.state` exactly as it always did.
 * Proven pixel-identical against the real renderer by test/projection.test.js's own M0 case, the
 * one this function was extracted out of rather than left duplicated at every future call site —
 * and, since M2, that same test doubles as proof the client's OWN recomputed fog agrees with the
 * server's closely enough to draw identical pixels; test/projection.test.js's own dedicated
 * bit-for-bit comparison checks the grids directly rather than relying on that alone.
 * @param {Object} wire - a JSON.parse'd projectFor(...) payload
 * @param {GameMap} map - the client's own locally-regenerated map for this match
 * @param {Fog} fog - the client's own persistent fog object for this seat (createFog(map)),
 *   reused and mutated in place across every call for the lifetime of one connection
 * @param {string} seat - which seat this projection and fog belong to
 * @returns {Object} a state-shaped object render.js and the client's own read paths already expect
 */
export function reassembleProjection(wire, map, fog, seat) {
  // wire.nodes carries only the DYNAMIC part of each visible-or-charted node (id, current amount —
  // projectFor's own comment: "everything else... the client can already regenerate deterministically
  // from the seed"). render.js and everything else reads state.map.nodes, never a top-level
  // `nodes` field, so the only meaningful thing to do with wire.nodes is merge its amounts INTO
  // the caller's own map — in place, exactly mirroring how a live single-player state.map is
  // mutated directly by the engine's own gather logic. `map` is the client's own private,
  // otherwise-static regenerated map (reused across every reassembly call by
  // net/wsClientTransport.js), so this accumulates correctly tick over tick, the same as the
  // server's own copy.
  //
  // Bugfix: a wreck (engine/wreckage.js) or crater (engine/bomb.js) node has no entry in the
  // client's own regenerated map at all — it was never part of the deterministic seed generation,
  // it was pushed onto state.map.nodes mid-match, server-side, same reasoning persist.js's own
  // rehydratePlanet already documents for the save/load path. Its `mapNode` lookup below always
  // came back undefined for one of these, so it was silently dropped every tick — a live
  // multiplayer human never saw battle wreckage or a Helium Bomb crater's resource node appear at
  // all. projectFor now sends one of these in FULL (not reduced to {id, amount}) for exactly this
  // reason, so it can be materialized here instead of discarded — mirroring persist.js's own
  // map.nodes.push(node) on load, one layer further out.
  const { nodes: wireNodes, ...rest } = wire;
  for (const n of wireNodes) {
    const mapNode = map.nodes.find(mn => mn.id === n.id);
    if (mapNode) { mapNode.amount = n.amount; continue; }
    if (n.wreck || n.crater) {
      map.nodes.push(n);
      if (map.nodesById) map.nodesById.set(n.id, n);
    }
  }

  const units = new Map(wire.units.map(u => [u.id, u]));
  const buildings = new Map(wire.buildings.map(b => [b.id, b]));
  // A minimal state-shaped object carrying only what updateFog actually reads: this seat's own
  // units/buildings (already unfiltered/own-fields-intact in `wire`, since projectFor never strips
  // its OWN seat's entities), the local map (terrain, for sight-radius modifiers), and `players`
  // (for factionTrait's sight trait — wire.players[seat].faction is always present, a public
  // field). updateFog filters units/buildings by owner itself, so handing it the seat's full
  // (already own-and-visible-only) map is exactly right — it only ever reveals from ITS OWN
  // entities regardless of what else happens to be in these Maps. Deliberately narrower than a
  // real State (no tick/over/owners/…) — updateFog never reads anything else, so the cast below
  // documents that gap instead of padding this object with fields nothing uses.
  updateFog(/** @type {State} */ ({ units, buildings, map, players: wire.players }), fog, seat);

  return {
    ...rest,
    map,
    units,
    buildings,
    selection: [],
    fog,
    fogAI: fog,
  };
}

/**
 * T-037 (FR-7): the client-side paired decode step for projectForSpectator(...)'s own wire shape —
 * deliberately simpler than reassembleProjection above: no createFog/updateFog, because there is no
 * seat to compute fog FOR. render.js's hiddenByFog and minimap.js's own equivalent only ever read
 * state.fog when observerMode is false (`e.owner !== game.localOwner && !observerMode && ...` —
 * short-circuits before touching fog at all once observerMode is true), and a network spectator's
 * client always renders through Observer Mode (lobbyScreen.js's own spectateLive calls
 * enterObserverMode() immediately after boot) — so fog/fogAI are simply null here, never consulted.
 * Same node-amount-merge and array-to-Map mechanics as reassembleProjection either way: the wire
 * SHAPE is identical regardless of which projection function filled it.
 * @param {Object} wire - a JSON.parse'd projectForSpectator(...) payload
 * @param {GameMap} map - the client's own locally-regenerated map for this match
 * @returns {Object} a state-shaped object render.js and the client's own read paths already expect
 */
export function reassembleSpectatorProjection(wire, map) {
  // Bugfix: same wreck/crater materialization as reassembleProjection above — see its own comment.
  const { nodes: wireNodes, ...rest } = wire;
  for (const n of wireNodes) {
    const mapNode = map.nodes.find(mn => mn.id === n.id);
    if (mapNode) { mapNode.amount = n.amount; continue; }
    if (n.wreck || n.crater) {
      map.nodes.push(n);
      if (map.nodesById) map.nodesById.set(n.id, n);
    }
  }
  const units = new Map(wire.units.map(u => [u.id, u]));
  const buildings = new Map(wire.buildings.map(b => [b.id, b]));
  return {
    ...rest,
    map,
    units,
    buildings,
    selection: [],
    fog: null,
    fogAI: null,
  };
}
