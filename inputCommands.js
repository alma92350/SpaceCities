/* ============================================================
   WHAT A CLICK MEANS — the stateless half of input handling.

   input.js's attachInput was 785 lines in one closure. Most of that length is genuinely
   stateful: drag boxes, pinch gestures, held keys, cycle counters — all mutable, all shared
   between listeners, and none of it separable without inventing a context object that would
   just move the coupling somewhere less obvious.

   These twelve functions are the part that ISN'T. They answer "what is at this point" and
   "what should clicking here do", read only `state` / `camera` / the canvas rect, and touch
   none of that gesture state. Splitting on that line rather than on "mouse vs touch vs
   keyboard" is what makes it a move instead of a rewrite: every listener keeps calling them by
   exactly the same name.

   The payoff is commandAt — 92 lines deciding what a right-click issues (attack / gather /
   build-assist / ferry / repair / set-home / rally / move), previously reachable only by
   constructing a real canvas and dispatching a real MouseEvent. It is now callable directly.

   A factory rather than free functions taking four extra arguments each: the four collaborators
   are fixed for the lifetime of one input controller, so binding them once keeps every call
   site inside attachInput reading exactly as it did.
   ============================================================ */

"use strict";

import { game } from "./session.js";
import { UNITS, BUILDINGS, storeCapOf, canGatherType, canLogisticsType, canBuildCategory } from "./engine/entities.js";
import { recipeOf } from "./engine/industry.js";
import { isVisibleAt, isNodeDiscovered } from "./engine/fog.js";
import { screenToWorld, clampCamera } from "./camera.js";
import * as sound from "./sound.js";

// The slop below which a drag counts as a click rather than a gesture. Owned here because
// applyBoxSelection is the primary reader; input.js imports it for the same decision on the
// screen-space side, so the two can never drift to different numbers.
export const CLICK_THRESHOLD = 4;
const UNIT_PICK_RADIUS = 10;
const NODE_PICK_RADIUS = 14;

/**
 * Bind the stateless click-interpretation helpers to one input controller's collaborators.
 *
 * `transport` is the ADR-0004 seam (net/transport.js) — every order below goes out as a
 * net/commandShapes.js WireCommand via transport.submitCommand(cmd), never a direct
 * engine/commands.js issue* call, so this file (and everything downstream of it) no longer
 * touches engine/ mutation at all. None of these call sites await or branch on the returned
 * CommandResult (nothing here ever did check an issue* return value either) — fire, play the
 * sound, onChange(). submitCommand's mutation is synchronous-underneath for both the real
 * loopback transport and boot.js's directTransport shim (proven in test/loopback.test.js), so
 * sound.playOrder()/onChange() right after still see the post-command state, unchanged from
 * before this file went through a transport at all.
 * @param {{ canvas: Object, state: Object, camera: Object, transport: Object, onChange: Function }} deps
 */
export function createInputCommands({ canvas, state, camera, transport, onChange }) {
    function viewport() {
      return { vw: canvas.clientWidth, vh: canvas.clientHeight };
    }

    function toWorld(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      const { vw, vh } = viewport();
      return screenToWorld(camera, vw, vh, clientX - rect.left, clientY - rect.top);
    }

    function entityAt(x, y) {
      for (const u of state.units.values()) {
        if (u.owner !== "player" && !isVisibleAt(state.fog, u.x, u.y)) continue;
        if (Math.hypot(u.x - x, u.y - y) <= UNIT_PICK_RADIUS) return u;
      }
      for (const b of state.buildings.values()) {
        if (b.owner !== "player" && !isVisibleAt(state.fog, b.x, b.y)) continue;
        if (Math.abs(b.x - x) <= b.radius && Math.abs(b.y - y) <= b.radius) return b;
      }
      return null;
    }

    function nodeAt(x, y) {
      return state.map.nodes.find(n => n.amount > 0 && isNodeDiscovered(state.fog, n)
        && Math.hypot(n.x - x, n.y - y) <= NODE_PICK_RADIUS) || null;
    }

    // The player's current formation choice (session.js), read fresh on every order — so
    // switching shapes in the HUD mid-game takes effect on the very next command issued.
    // `heading` ({x,y}, a world-space vector — NOT normalized, engine/formation.js does that) is
    // set only by a right-click-DRAG (see rightDragStart below): the drag direction becomes both
    // the formation's facing while it travels and the persisted `unit.facing` it holds once
    // stopped (engine/commands.js applyFacing). A plain click carries no heading, so the shape
    // orients itself off the group's own travel direction as before, and any earlier facing is
    // cleared.
    // Wire-shaped (net/commandShapes.js's WireFormation: s/l/hx/hy, not the engine's own
    // shape/leaderPos/headingX/headingY) — net/commandCodec.js's decodeFormation translates
    // this into the engine's opts bag server-side; sending the engine's own key names here
    // would silently decode to the all-defaults formation instead of the player's actual choice.
    function currentFormation(heading) {
      const f = { s: game.formation.shape, l: game.formation.leaderPos };
      if (heading) { f.hx = heading.x; f.hy = heading.y; }
      return f;
    }

    // Attack-move to (x,y): combat units advance-and-engage anything met on the
    // way; non-combat units (workers, the Ranger) can't attack-move, so they just
    // move. Same split the Ctrl-queue and minimap-command paths use.
    function aggressiveMove(units, x, y, queue = false, heading) {
      const combatants = units.filter(u => UNITS[u.type].role === "combat");
      const others = units.filter(u => UNITS[u.type].role !== "combat");
      const formation = currentFormation(heading);
      if (combatants.length) transport.submitCommand({ t: "attackMove", ids: combatants.map(u => u.id), x, y, q: queue, f: formation });
      if (others.length) transport.submitCommand({ t: "move", ids: others.map(u => u.id), x, y, q: queue, f: formation });
    }

    function alivePlayerUnitIds(ids) {
      return ids.filter(id => { const u = state.units.get(id); return u && u.owner === "player"; });
    }

    function selectedUnits() {
      return state.selection.map(id => state.units.get(id)).filter(Boolean);
    }

    function centerCamera(x, y) {
      const { vw, vh } = viewport();
      camera.x = x; camera.y = y;
      clampCamera(camera, state.map, vw, vh);
    }

    // Resolve a world-space selection box (a tiny box is a point-pick) into the new
    // selection, additively when asked. Returns the ids picked.
    //
    // Additively re-picking a single unit that's ALREADY in the selection promotes it to the
    // front instead of no-op'ing there — i.e. makes it the formation leader (engine/formation.js
    // pickLeader is always selection[0]) without having to clear the selection and rebuild it
    // around that unit from scratch. Ctrl+clicking any one squadmate is enough to hand it the lead.
    //
    // `subtractive` (Alt+click / Alt+drag) is a third mode, independent of `additive`: it REMOVES
    // whatever the box/click picked from the current selection instead of replacing or adding to
    // it, filtering state.selection down rather than rebuilding it — Array#filter preserves the
    // order of whatever survives, so the formation leader (selection[0]) stays leader unless it's
    // one of the units actually subtracted. Takes precedence over `additive` if somehow both are
    // set (not a real gesture — Ctrl+click's own leader-promotion behavior is otherwise untouched).
    function applyBoxSelection(box, additive, subtractive = false) {
      const dx = Math.abs(box.x2 - box.x1), dy = Math.abs(box.y2 - box.y1);
      let picks;
      if (dx < CLICK_THRESHOLD && dy < CLICK_THRESHOLD) {
        const hit = entityAt(box.x1, box.y1);
        picks = hit && hit.owner === "player" ? [hit.id] : [];
      } else {
        const x1 = Math.min(box.x1, box.x2), x2 = Math.max(box.x1, box.x2);
        const y1 = Math.min(box.y1, box.y2), y2 = Math.max(box.y1, box.y2);
        let inBox = [...state.units.values()]
          .filter(u => u.owner === "player" && u.x >= x1 && u.x <= x2 && u.y >= y1 && u.y <= y2);
        // Prioritise the army: a box that catches any fighter drops the workers, so
        // sweeping across your base to grab your army doesn't drag the workers along
        // (standard RTS). A box with no fighters still selects the workers as before.
        if (inBox.some(u => UNITS[u.type].role === "combat"))
          inBox = inBox.filter(u => UNITS[u.type].role !== "worker");
        picks = inBox.map(u => u.id);
      }
      if (subtractive) {
        if (picks.length) {
          const drop = new Set(picks);
          state.selection = state.selection.filter(id => !drop.has(id));
        }
      } else if (additive) {
        if (picks.length === 1 && state.selection.includes(picks[0])) {
          const [id] = picks;
          state.selection = [id, ...state.selection.filter(sid => sid !== id)];
        } else if (picks.length) {
          state.selection = [...new Set([...state.selection, ...picks])];
        }
      } else {
        state.selection = picks;
      }
      if (picks.length) sound.playSelect();
      onChange();
      return picks;
    }

    // Grab every same-type unit of yours currently on screen (the double-click / double-tap
    // gesture) — or, with `mapWide` (Ctrl+double-click), everywhere on the whole map, matching the
    // map-wide semantics Q and the panel's type rows already use. Returns true if it hit one of
    // your units.
    function selectSameTypeAt(p, mapWide = false) {
      const hit = entityAt(p.x, p.y);
      if (!hit || hit.owner !== "player" || hit.kind !== "unit") return false;
      // bounds stays null for the map-wide path, skipping the tl/br screen clamp below entirely.
      let bounds = null;
      if (!mapWide) {
        const { vw, vh } = viewport();
        bounds = { tl: screenToWorld(camera, vw, vh, 0, 0), br: screenToWorld(camera, vw, vh, vw, vh) };
      }
      state.selection = [...state.units.values()]
        .filter(u => u.owner === "player" && u.type === hit.type
          && (!bounds || (u.x >= bounds.tl.x && u.x <= bounds.br.x && u.y >= bounds.tl.y && u.y <= bounds.br.y)))
        .map(u => u.id);
      onChange();
      return true;
    }

    // The context command at a world point (the right-click / touch command-tap):
    // a single selected production building sets its rally; otherwise the current
    // unit selection assists-builds, attacks, gathers, or moves as the target
    // warrants. `queue` chains it as a waypoint instead of replacing the order.
    // `heading` (world-space {x,y}, only ever set by a right-click-drag — see
    // rightDragStart) only matters to the final plain-move fallback: gathering,
    // attacking, escorting, and assisting/servicing a building all target a SPECIFIC
    // entity/node, where "which way to face while getting there" isn't a choice —
    // only an undirected move onto open ground is.
    function commandAt(p, queue, heading) {
      if (state.selection.length === 1) {
        const building = state.buildings.get(state.selection[0]);
        if (building && building.owner === "player" && BUILDINGS[building.type].produces) {
          const node = nodeAt(p.x, p.y);
          transport.submitCommand({ t: "setRally", building: building.id, x: p.x, y: p.y, node: node ? node.id : null });
          sound.playOrder();
          onChange();
          return;
        }
      }

      const selected = state.selection.map(id => state.units.get(id)).filter(Boolean);
      if (!selected.length) return;

      const target = entityAt(p.x, p.y);
      if (target && target.owner === "player" && target.kind === "building" && target.constructing) {
        const workers = selected.filter(u => canBuildCategory(u.type, BUILDINGS[target.type]?.category));
        if (workers.length) { transport.submitCommand({ t: "assistBuild", ids: workers.map(u => u.id), target: target.id, q: queue }); sound.playOrder(); onChange(); }
        return;
      }
      // A completed friendly building with logistics buffers (a factory, the Rig) OR a fuel-burning
      // power station (a Reactor/Combustor/Biomass Reactor — BUILDINGS[type].combust, entities.js):
      // selected workers are ASSIGNED to service it — a standing round trip carrying its inputs in
      // (and, for a factory/Rig, its output out) — until re-ordered elsewhere. The combust check
      // mirrors engine/haul.js's own "is this building serviceable" test (its updateBuild/assignService
      // internals gate on the exact same `recipeOf(b) || BUILDINGS[b.type]?.combust`) — without it, a
      // power station never matched here, so right-clicking a Worker onto a Reactor that needed
      // radioactives just silently walked it there instead of fetching fuel.
      if (target && target.owner === "player" && target.kind === "building" && !target.constructing
          && (recipeOf(target) || storeCapOf(target.type) > 0 || BUILDINGS[target.type]?.combust)) {
        const workers = selected.filter(u => canLogisticsType(u.type));
        if (workers.length) { transport.submitCommand({ t: "service", ids: workers.map(u => u.id), target: target.id, q: queue }); sound.playOrder(); onChange(); return; }
      }
      // A completed friendly building below full HP, and not already claimed by the logistics-service
      // branch above (a damaged factory keeps its existing "service" behaviour): selected workers
      // patch it up instead — a turret, a Habitat, the Command Center itself, whatever soaked damage
      // or Odyssey wear (engine/commands.js issueRepair).
      if (target && target.owner === "player" && target.kind === "building" && !target.constructing
          && target.hp < target.maxHp) {
        const workers = selected.filter(u => canLogisticsType(u.type));
        if (workers.length) { transport.submitCommand({ t: "repair", ids: workers.map(u => u.id), target: target.id, q: queue }); sound.playOrder(); onChange(); return; }
      }
      // A completed, undamaged (or damage-repair-less) friendly Command Center: selected eligible units
      // (workers, Menders, freighters) are pinned to it as their assigned HOME BASE (engine/commands.js
      // issueSetHomeBase) — an explicit override for zoneFirst's usual nearest-CC guess, so the player
      // decides which base's territory a unit's logistics/repair jobs stay loyal to. Passive: it never
      // interrupts whatever the unit is currently doing.
      if (target && target.owner === "player" && target.kind === "building" && target.type === "command"
          && !target.constructing) {
        const eligible = selected.filter(u => canLogisticsType(u.type) || UNITS[u.type]?.role === "support" || UNITS[u.type]?.role === "freighter");
        if (eligible.length) { transport.submitCommand({ t: "setHomeBase", ids: eligible.map(u => u.id), target: target.id }); sound.playOrder(); onChange(); return; }
      }
      if (target && target.owner !== "player") {
        const attackers = selected.filter(u => UNITS[u.type].attack);
        if (attackers.length) { transport.submitCommand({ t: "attack", ids: attackers.map(u => u.id), target: target.id, q: queue }); sound.playOrder(); onChange(); }
        return;
      }
      // A friendly, landed FREIGHTER as the target: selected WORKERS are assigned to FERRY it — carry
      // nearby producer backlog onto its hold (engine/haul.js updateFerry), so it becomes its own
      // mobile collection point — instead of escorting it. Any non-worker selection (or a selection
      // with no workers at all) falls through to the general friendly-ship escort branch below, so
      // e.g. combat ships still escort a freighter through hostile space.
      if (target && target.owner === "player" && target.kind === "unit" && UNITS[target.type]?.role === "freighter") {
        const workers = selected.filter(u => canLogisticsType(u.type));
        if (workers.length) { transport.submitCommand({ t: "ferry", ids: workers.map(u => u.id), target: target.id, q: queue }); sound.playOrder(); onChange(); return; }
      }
      // A damaged friendly UNIT as the target (not claimed by the ferry branch above — a freighter
      // needing ferried always wins that click): selected workers patch it up directly instead of
      // escorting it (engine/commands.js issueRepair) — the same worker repair job a building gets.
      if (target && target.owner === "player" && target.kind === "unit" && target.hp < target.maxHp) {
        const workers = selected.filter(u => canLogisticsType(u.type) && u.id !== target.id);
        if (workers.length) { transport.submitCommand({ t: "repair", ids: workers.map(u => u.id), target: target.id, q: queue }); sound.playOrder(); onChange(); return; }
      }
      // A friendly SHIP as the target: the selection forms a protective escort ring around it and
      // follows it wherever it's ordered (engine/commands.js issueEscort). The target itself is
      // excluded, so right-clicking a ship that's part of the selection escorts it with the rest.
      if (target && target.owner === "player" && target.kind === "unit") {
        const escorts = selected.filter(u => u.id !== target.id);
        if (escorts.length) { transport.submitCommand({ t: "escort", ids: escorts.map(u => u.id), target: target.id, q: queue }); sound.playOrder(); onChange(); return; }
      }
      const node = nodeAt(p.x, p.y);
      if (node) {
        const workers = selected.filter(u => canGatherType(u.type));
        if (workers.length) { transport.submitCommand({ t: "gather", ids: workers.map(u => u.id), node: node.id, q: queue }); sound.playOrder(); onChange(); }
        return;
      }
      if (queue) aggressiveMove(selected, p.x, p.y, true, heading);
      else transport.submitCommand({ t: "move", ids: selected.map(u => u.id), x: p.x, y: p.y, q: false, f: currentFormation(heading) });
      sound.playOrder();
      onChange();
    }

  return { viewport, toWorld, entityAt, nodeAt, currentFormation, aggressiveMove, alivePlayerUnitIds, selectedUnits, centerCamera, applyBoxSelection, selectSameTypeAt, commandAt };
}
