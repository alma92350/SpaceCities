// @ts-check
/* ============================================================
   Worker gather/deposit loop: walk to node -> mine into cargo -> walk to
   the nearest completed drop-off -> deposit -> repeat until the node runs
   dry. A drop-off is the Command Center (see entities.js isGatherDropOff),
   or a landed, player-toggled COLLECTION-POINT Hauler/Freighter closer than
   any CC (unit.collectPoint — see nearestGatherDrop below) — no OTHER
   building ever collects a raw haul, forward or otherwise.
   ============================================================ */

"use strict";

import { stepToward } from "./movement.js";
import { UNITS, BUILDINGS, isGatherDropOff, upgradeMult, freightRoom } from "./entities.js";
import { sideMod } from "./map.js";
import { hashStr } from "./rng.js";
import { isNodeDiscovered } from "./fog.js";

const ORBIT_RADIUS = 16;   // workers ring the node instead of stacking on its exact center
const ARRIVE_REACH = 4;
const DROP_REACH = 30;

// Progress watchdog: how long a gatherer may walk without ever getting closer to what
// it is walking to before it is reported stalled. Generous — a worker steering laterally
// around its own crowd (movement.js senseLateralAvoidance) plateaus for a second or two
// in normal traffic, and a legitimately long haul still closes the gap steadily.
const STALL_AFTER = 10;

// Minimum gap between two adjacent docking spots on a ring. Must clear separation.js's own
// resting distance for two workers — (6+6) * SEPARATION_PAD_MULT = 14.4 — or the crew is
// handed spots it will immediately shove itself off of. Derived from the roster rather than
// written as a bare 15 so a change to the worker hull or the separation pad can't silently
// make these rings too tight again.
export const DOCK_SPACING = UNITS.worker.radius * 2 * 1.25;

// How far out a hauler parks to bank. Comfortably inside DROP_REACH so a worker that
// reaches its spot is always within depositing distance of the drop's centre even after
// a tick or two of being jostled, and capped there however big the crew gets: past the
// cap the ring just packs tighter, which separation resolves on its own — the deposit
// still lands, because the gate is measured from the centre and everyone is inside it.
// That cap is a real ceiling on how many haulers can stand a full DOCK_SPACING apart at
// once — about 2*pi*DOCK_RADIUS_MAX/DOCK_SPACING of them. It is deliberately NOT bought
// by widening DROP_REACH, which would shorten every haul in the game and move the
// economy's whole balance point; a packed ring costs a little jostling and nothing else.
const DOCK_RADIUS = 14;
const DOCK_RADIUS_MAX = DROP_REACH - 6;

// How far a gatherer will look for a fresh seam of the SAME commodity once its current node runs
// dry — far enough to reach a sibling deposit in the same home cluster (UNITS.worker's own
// "~3 home seams" comment below) without sending a worker on a cross-map trek that should really
// be a deliberate player order.
const RETARGET_RADIUS = 600;

// Saturation: with `m` workers assigned to a node, the first `minerSoftCap`
// each mine at full rate and every extra at `minerFalloff` of a share, so the
// node's per-worker efficiency is the average. Floors above 0 (never softlocks
// a lone remaining seam). No cap field on the def (or no miner count, as in the
// direct-call unit tests) means no penalty — full rate, exactly as before.
/** @param {ResourceNode} node @param {*} def @returns {number} */
function miningEfficiency(node, def) {
  const cap = def.minerSoftCap ?? Infinity;
  const m = node.miners || 0;
  if (m <= cap) return 1;
  const extra = def.minerFalloff ?? 1;
  return (cap + (m - cap) * extra) / m;
}

// A docking spot on a ring around (cx, cy): the crew's `index`-th of `count` evenly
// spaced places, rotated by a per-site offset so two neighbouring sites don't hand out
// the same angles. The ring GROWS when the crew outnumbers the places `baseRadius` can
// hold at DOCK_SPACING, up to `maxRadius` — so an oversubscribed site packs its ring
// tighter rather than stacking bodies on one point.
//
// Even spacing, not a hash. This used to be `hashStr(unitId) % 360`, and hashStr is
// `h * 31 + charCode` — so the sequentially-numbered ids a production queue actually
// emits hash to sequential values, and a freshly trained crew (u9, u10, u11 …) drew
// angles 331°, 341°, 342°, 343° … Two workers a single degree apart on a radius-16 ring
// stand 0.3px apart, far inside separation.js's 14.4 resting distance, so they shove
// each other forever and NEITHER ever closes to ARRIVE_REACH of its own spot: both walk,
// get pushed, and walk again for the rest of the match without ever starting to mine.
// Silent, too — a wedged worker reads as "moving", never idles, and emits no event.
// (test/gatherCongestion.test.js)
/** @param {number} cx @param {number} cy @param {number} baseRadius @param {number} maxRadius @param {number} index @param {number} count @param {string} siteId @returns {{x:number, y:number, radius:number}} */
function ringSpot(cx, cy, baseRadius, maxRadius, index, count, siteId) {
  // Size by CHORD, not by arc: `count` spots evenly spaced on a radius-r ring stand
  // 2r*sin(pi/count) apart, which is always LESS than the arc between them, so sizing
  // the ring off arc length quietly hands out spots inside the separation floor at
  // exactly the crowded end this is meant to fix. Past maxRadius the ring simply packs
  // tighter — spots stay evenly spread and distinct, which is all the deposit gate needs.
  const needed = count > 1 ? DOCK_SPACING / (2 * Math.sin(Math.PI / count)) : 0;
  const radius = Math.min(Math.max(baseRadius, needed), maxRadius);
  const offset = (hashStr(siteId) % 360) * (Math.PI / 180);   // per-site rotation only — never per-unit spacing
  const angle = offset + (index / Math.max(count, 1)) * 2 * Math.PI;
  return { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius, radius };
}

// This worker's place in a site's crew, as frozen for the tick by sim.js (countMiners /
// countDockers build the id lists). Falls back to a lone worker at index 0 when there is
// no list at all — the direct-call unit tests, which never run a full tick.
/** @param {string[]|undefined} crew @param {string} unitId @returns {{index:number, count:number}} */
function crewSlot(crew, unitId) {
  if (!crew || !crew.length) return { index: 0, count: 1 };
  const index = crew.indexOf(unitId);
  return index < 0 ? { index: 0, count: crew.length + 1 } : { index, count: crew.length };
}

// Where this worker mines from: its slot on the node's ring.
/** @param {ResourceNode} node @param {string} unitId @returns {{x:number, y:number, radius:number}} */
export function orbitSpot(node, unitId) {
  const { index, count } = crewSlot(node.minerIds, unitId);
  return ringSpot(node.x, node.y, ORBIT_RADIUS, ORBIT_RADIUS * 6, index, count, node.id);
}

// Where this worker parks to bank: its slot on the drop's ring.
/** @param {Building|Unit} drop @param {string} unitId @returns {{x:number, y:number, radius:number}} */
export function dockSpot(drop, unitId) {
  const { index, count } = crewSlot(drop.dockerIds, unitId);
  return ringSpot(drop.x, drop.y, DOCK_RADIUS, DOCK_RADIUS_MAX, index, count, drop.id);
}

// Called from updateGather's two depletion exits (the node is already dry when its order is
// picked up, and the deposit that drains the last of it) so a gatherer keeps working instead of
// idling at every drained seam — the AI already self-heals this way every think (aiWorkers.js
// assignIdleWorkers); this gives the player the same outcome inline, without waiting for a
// separate pass. Retargets `unit` to the NEAREST same-commodity node its OWNER has discovered
// (fog-gated via isNodeDiscovered, so a hidden cache stays hidden until scouted — same rule the
// AI's own search already follows) within RETARGET_RADIUS of the drained node, preferring one
// still under the miner soft cap so the crew doesn't just pile onto the next-nearest node that's
// already saturated. Ties (and the "prefer under-cap" partition itself) break on id, never on Map/
// array iteration order, so two same-seed runs can't diverge. Idles (unit.order = null), exactly
// as before, when nothing qualifies.
/** @param {State} state @param {Unit} unit @param {ResourceNode} node */
function nextNodeAfterDepletion(state, unit, node) {
  const fog = state.fogs[unit.owner];
  const cap = UNITS[unit.type].minerSoftCap ?? Infinity;
  let best = null, bestUnderCap = false, bestDist = Infinity;
  for (const n of state.map.nodes) {
    if (n.com !== node.com || n.amount <= 0 || !isNodeDiscovered(fog, n)) continue;
    const dist = Math.hypot(n.x - node.x, n.y - node.y);
    if (dist > RETARGET_RADIUS) continue;
    const underCap = (n.miners || 0) < cap;
    const better = !best
      || (underCap && !bestUnderCap)
      || (underCap === bestUnderCap && (dist < bestDist || (dist === bestDist && n.id < best.id)));
    if (better) { best = n; bestUnderCap = underCap; bestDist = dist; }
  }
  // Claim the seat on the way out. countMiners freezes `miners` once at the top of the
  // tick, so a whole crew whose node drained together would otherwise every one of them
  // read the SAME stale counts and pick the SAME "nearest under-cap" seam — nine workers
  // funnelling onto one rock in lockstep, which is exactly what a late-game map of
  // half-drained seams produces over and over. Counting the claim immediately means the
  // next worker through this function sees the seat taken and moves to the next seam.
  // Recomputed from scratch next tick regardless, so this can never drift.
  if (best) {
    best.miners = (best.miners || 0) + 1;
    (best.minerIds || (best.minerIds = [])).push(unit.id);
    best.minerIds.sort();   // same stable order countMiners maintains, so ring slots agree
  }
  unit.order = best ? { type: "gather", nodeId: best.id, phase: "toNode" } : null;
  // workerRetargeted (agent-observability): the OTHER half of a depletion, and the dangerous one.
  // A gatherer whose seam runs dry silently re-tasks itself to the nearest surviving node of the
  // same commodity — which, once the safe seams near home are gone, is routinely one deep in
  // contested ground. Two recorded matches were decided by exactly this: a worker line that
  // walked itself out to the middle of the map, one depletion at a time, and was picked apart
  // there by a single raider while its owner was reading its own base. Nothing announced it,
  // because from the engine's own point of view nothing went wrong. Carries the new node's
  // position so an observer can measure the walk against its own bases — this file has no
  // business deciding what counts as "too far".
  if (best) {
    state.events.push({ type: "workerRetargeted", id: unit.id, unitType: unit.type, owner: unit.owner,
                        fromNode: node.id, toNode: best.id, com: best.com, x: best.x, y: best.y,
                        distance: Math.round(bestDist) });
  }
  // unitIdle (agent-observability): a worker whose seam ran dry with nothing left to retarget to
  // simply stopped, silently — no event, and nothing in a unit's projected shape an observer could
  // poll for it either, so a match could quietly rot with half an economy standing still. Emitted
  // exactly at the one transition that produces an idle worker, never per-tick while it stays idle.
  if (!best) state.events.push({ type: "unitIdle", id: unit.id, unitType: unit.type, reason: "node-depleted", x: unit.x, y: unit.y, owner: unit.owner });
}

// Watch a walking gatherer for progress and announce one that has stopped making any.
// unitStalled is the missing twin of unitIdle above: a worker wedged on the way to a seam
// or to a drop-off is NOT idle — it has an order, it is moving, and every observable an
// agent (or the HUD) can poll says "working", while the economy it was supposed to feed
// sits at zero. That is precisely how the drop-off and node jams stayed invisible for as
// long as they did. Reported ONCE per stalled leg, not per tick, and cleared the moment
// the worker gets closer to its target than it has ever been on this leg.
/** @param {State} state @param {Unit} unit @param {Object} order @param {number} dist @param {number} dt */
function watchProgress(state, unit, order, dist, dt) {
  // A new leg starts its own watch: the previous leg measured distance to a different
  // thing entirely, so carrying its best across would read as an instant stall. The drop
  // is part of the key, not just the phase — nearestGatherDrop re-picks every tick, and a
  // collection-point freighter landing nearby legitimately moves the target mid-haul.
  const key = `${order.phase}|${order.dropId || ""}`;
  if (order.watchPhase !== key) {
    order.watchPhase = key; order.watchBest = dist; order.stallFor = 0; order.stalled = false;
    return;
  }
  if (dist < (order.watchBest ?? Infinity)) {
    order.watchBest = dist; order.stallFor = 0;
    return;
  }
  order.stallFor = (order.stallFor || 0) + dt;
  if (order.stallFor >= STALL_AFTER && !order.stalled) {
    order.stalled = true;
    state.events.push({
      type: "unitStalled", id: unit.id, unitType: unit.type, owner: unit.owner,
      phase: order.phase, seconds: order.stallFor, x: unit.x, y: unit.y,
      reason: order.phase === "toDrop" ? "cannot-reach-dropoff" : "cannot-reach-node",
    });
  }
}

/** @param {State} state @param {Unit} unit @param {number} dt */
export function updateGather(state, unit, dt) {
  const def = UNITS[unit.type];
  const order = unit.order;
  const node = state.map.nodesById
    ? state.map.nodesById.get(order.nodeId)
    : state.map.nodes.find(n => n.id === order.nodeId);
  if (!node) { unit.order = null; return; }
  if (node.amount <= 0) { nextNodeAfterDepletion(state, unit, node); return; }
  if (!order.phase) order.phase = "toNode";

  if (order.phase === "toNode") {
    const spot = orbitSpot(node, unit.id);
    const dist = Math.hypot(spot.x - unit.x, spot.y - unit.y);
    // Arrive on EITHER reaching the assigned spot or simply being at the rock. The
    // second gate is what makes the transition impossible to deny: ARRIVE_REACH (4) is
    // smaller than one tick of separation displacement, so a worker whose spot is
    // contested can be held just outside it indefinitely — and the "mining" phase has no
    // range check of its own anyway (a miner shoved off the seam keeps mining), so
    // insisting on the exact spot bought nothing but the deadlock.
    const atRock = Math.hypot(node.x - unit.x, node.y - unit.y) <= spot.radius + ARRIVE_REACH;
    if (dist <= ARRIVE_REACH || atRock) order.phase = "mining";
    else { watchProgress(state, unit, order, dist, dt); stepToward(state, unit, spot.x, spot.y, def.speed, dt); }
    return;
  }

  if (order.phase === "mining") {
    // Re-tasked mid-carry to a node of a DIFFERENT commodity: don't throw the
    // load away — haul it home and deposit it first, then come back to mine
    // the new node. (Same commodity just tops off the existing cargo.)
    if (unit.cargo.qty > 0 && unit.cargo.com && unit.cargo.com !== node.com) {
      order.phase = "toDrop";
      return;
    }
    unit.cargo.com = node.com;
    const room = def.cargoCap - unit.cargo.qty;
    const take = Math.min(def.gatherRate * miningEfficiency(node, def) * dt, node.amount, room);
    unit.cargo.qty += take;
    node.amount -= take;
    // nodeDepleted (agent-observability): the pairing event for unitIdle above — announced ONCE per
    // node (the flag), not once per miner that happens to land the finishing tick, and not again on
    // every later tick a miner walks up to the dry seam.
    if (node.amount <= 0 && !node.depletedAnnounced) {
      node.depletedAnnounced = true;
      state.events.push({ type: "nodeDepleted", id: node.id, com: node.com, x: node.x, y: node.y });
    }
    if (unit.cargo.qty >= def.cargoCap - 1e-6 || node.amount <= 0) order.phase = "toDrop";
    return;
  }

  if (order.phase === "toDrop") {
    const drop = nearestGatherDrop(state, unit.owner, unit.x, unit.y);
    if (!drop) { unit.order = null; return; }   // no Command Center → hold the load, idle
    // Remember which drop this haul is headed for: sim.js's countDockers reads it next
    // tick to hand out ring slots, and it is what an observer polls to tell a worker
    // hauling home from one stuck on the road (engine/projection.js).
    order.dropId = drop.id;
    const dist = Math.hypot(drop.x - unit.x, drop.y - unit.y);
    if (dist <= DROP_REACH) {
      const player = state.players[unit.owner];
      // Per-side economy modifier for an asymmetric world (default 1 elsewhere):
      // a richer claim banks more per haul. The Logistics doctrine's yield upgrade
      // stacks on top (upgradeMult reads the researched upgrades). Applies identically
      // whichever kind of drop this is — the bonus is earned at the point of harvest,
      // not by however it later gets to the treasury.
      const mult = sideMod(state, unit.owner, "gatherMult", 1) * upgradeMult(player.upgrades, "gatherYieldMult");
      if (drop.kind === "unit") {
        // A collection-point Hauler/Freighter (unit.collectPoint — see nearestGatherDrop below):
        // bank into its freight hold instead of the treasury, clamped to its remaining room —
        // same partial-deposit shape engine/haul.js's own depositToFreighter uses for factory
        // backlog. Clamp on the RAW quantity moved (a physical hold-space constraint, exactly
        // like factory backlog fills it), THEN apply the yield bonus to what actually gets
        // credited — so a full hold caps how much cargo leaves the worker, not how much value it's
        // worth. Whatever doesn't fit stays aboard the worker; the next "toDrop" tick re-picks the
        // nearest drop and tries again (this same Hauler if it's freed up room, another one, or the
        // Command Center) — no special-casing needed, nearestGatherDrop already re-runs every tick.
        // Clamp the CREDITED amount, then derive how much cargo that consumes. Clamping the raw
        // quantity instead and applying the bonus afterwards let a partial deposit land more than
        // fits (measured: 251 into a 250 hold at the Logistics Network's 1.25x), which breaks the
        // hold's capacity AND "a save round-trips identically" — persist.js truncates the excess on
        // load, so continuing a game stopped being the same as saving and continuing it. That
        // second half is invisible to every replay test: both runs agree until someone saves.
        const credited = Math.min(unit.cargo.qty * mult, freightRoom(drop));
        const rawMove = credited / mult;
        if (rawMove > 0) {
          drop.freight[unit.cargo.com] = (drop.freight[unit.cargo.com] || 0) + credited;
          unit.cargo.qty -= rawMove;
          if (unit.cargo.qty <= 1e-9) { unit.cargo.qty = 0; unit.cargo.com = null; }
        }
      } else {
          const banked = unit.cargo.qty * mult;
        player.resources[unit.cargo.com] = (player.resources[unit.cargo.com] || 0) + banked;
        unit.cargo.qty = 0;
      }
      if (node.amount > 0) order.phase = "toNode";
      else nextNodeAfterDepletion(state, unit, node);   // this deposit drained the last of it — roll to the next seam or idle
    } else {
      watchProgress(state, unit, order, dist, dt);
      // Walk to a slot on the drop's ring, never to its exact centre. Every hauler
      // seeking one identical point was the drop-off half of the same jam: separation
      // pushes are applied per overlapping PAIR and so add up without bound, while a
      // worker's approach is capped at its own speed — which is exactly PUSH_SPEED — so
      // a dense enough pile shoves its outer members back past DROP_REACH faster than
      // they can walk in, and a cargo-full worker that never banks never returns to the
      // seam either. Spots sit inside DROP_REACH, so reaching one always banks.
      const spot = dockSpot(drop, unit.id);
      stepToward(state, unit, spot.x, spot.y, def.speed, dt);
    }
  }
}

// The nearest COMPLETED collection point a gatherer may bank a raw haul at: a Command Center (or
// dropOff building, engine/entities.js isGatherDropOff — today that's the Command Center alone),
// OR a landed, player-toggled COLLECTION-POINT freighter (unit.collectPoint — engine/haul.js's
// assignFerry/assignShuttle idiom, HUD-toggled, no research needed) with room to spare. The
// freighter option mirrors assignFerry's own eligibility check exactly (owned, collectPoint,
// cargo-capable, actual room) — it already knows how to shuttle its own hold home
// (updateFreighterShuttle), so a gatherer or wreck-salvager banking into one instead of trekking
// all the way back to a Command Center is just another leg of the same logistics chain, not a new
// one. Closest wins, whichever kind it is — deterministic Map order breaks ties within each kind,
// and buildings are scanned before units so a building exactly as close (bestD strictly less-than)
// always wins that tie. `excludeId`, when given, skips that one BUILDING — a defensive guard
// against a worker finding its own HAUL source as its drop target and looping (engine/haul.js
// updateHaul passes its own source id here); harmless no-op while a Command Center can never
// itself be a HAUL source, and never applies to the unit scan (a Hauler is never a HAUL source).
/** @param {State} state @param {string} owner @param {number} x @param {number} y @param {string} [excludeId] @returns {Building|Unit|null} */
export function nearestGatherDrop(state, owner, x, y, excludeId) {
  let best = null, bestD = Infinity;
  for (const b of state.buildings.values()) {
    if (b.owner !== owner || b.constructing || !isGatherDropOff(b.type)) continue;
    if (excludeId && b.id === excludeId) continue;
    const d = Math.hypot(b.x - x, b.y - y);
    // Explicit id tie-break, matching haul.js/wreckage.js/colonyPolicy.js/wonder.js. This used to
    // rely on Map insertion order — correct today, but a different KIND of guarantee from every
    // neighbouring scan: one resting on a data-structure incident rather than a stated rule. It
    // matters here because zoneFirst resolves zone membership by IDENTITY against this result.
    if (d < bestD || (d === bestD && best && b.id < best.id)) { bestD = d; best = b; }
  }
  for (const u of state.units.values()) {
    if (u.owner !== owner || !u.collectPoint || !UNITS[u.type]?.cargoHold) continue;
    if (freightRoom(u) <= 0) continue;
    const d = Math.hypot(u.x - x, u.y - y);
    if (d < bestD || (d === bestD && best && u.id < best.id)) { bestD = d; best = u; }
  }
  return best;
}

// The nearest COMPLETED Command Center — the treasury/warehouse. Haulage delivers to it and
// supply runs pick up from it (engine/haul.js). Null if the owner has no standing Command Center.
/** @param {State} state @param {string} owner @param {number} x @param {number} y @returns {Building|null} */
export function nearestCommandCenter(state, owner, x, y) {
  let best = null, bestD = Infinity;
  for (const b of state.buildings.values()) {
    if (b.owner !== owner || b.constructing || !BUILDINGS[b.type].isCommandCenter) continue;
    const d = Math.hypot(b.x - x, b.y - y);
    if (d < bestD || (d === bestD && best && b.id < best.id)) { bestD = d; best = b; }
  }
  return best;
}

// A Command Center's "zone" is simply whichever of an owner's CCs sits nearest to a point — no
// stored/cached assignment, so founding or losing a CC instantly redraws every boundary on the
// very next call, with nothing to invalidate. `zoneFirst` runs a caller-supplied scan TWICE: once
// restricted to the searcher's OWN zone (candidates whose nearest CC matches the searcher's), and —
// only if that comes back empty — once more with no restriction at all, today's plain global
// search. This is how haulers/servers/ferriers (engine/haul.js) and the auto-repair Mender/worker
// repair job (engine/repair.js) all stay loyal to their own base first and only "commute" to
// another one when their own genuinely has nothing queued — the fix for a multi-base empire
// where a saturated home base used to send idle labour on long, arbitrary cross-map treks the
// instant its own ≤2-per-target caps filled up.
//
// A one-CC game (nearly every test, and most real matches before a player expands) has exactly one
// zone, so the FIRST pass's candidate set is identical to the plain global one — `scan(inZone)` and
// `scan(null)` return the exact same answer, and behaviour is byte-identical to before this existed.
// `scan(inZone)` receives either a same-zone predicate `(x,y) => boolean` or `null` (no restriction);
// it does its own candidate loop/tie-break and returns its best match or null either way.
//
// `homeId`, when given, is a PLAYER-ASSIGNED override (`unit.homeCC`, engine/commands.js
// issueSetHomeBase — a right-click on a Command Center with eligible units selected) that wins over
// the usual "nearest CC by distance" guess: the player decides which base's territory a worker/
// Mender/freighter stays loyal to, not just raw distance. A stale override (its CC destroyed, or
// never valid) is ignored and this falls straight back to the distance guess — self-healing, same
// "never cache, recompute from state" shape as everything else here.
//
// The two cases behave differently once the home zone comes up EMPTY, by design:
//   - No override (or a stale one): the distance guess is just a heuristic, not a commitment, so an
//     empty home zone still widens to the whole empire — today's plain global search, a last resort.
//   - A VALID explicit override: the player deliberately assigned this base, so it's a hard
//     boundary, not a suggestion. An empty zone returns null (no job) rather than reaching into
//     another base's territory — the unit just waits for its OWN zone to need something, until the
//     player reassigns it to a different Command Center or clears the override outright.
/** @param {State} state @param {string} owner @param {number} x @param {number} y
 *  @param {(inZone: ((ex:number, ey:number) => boolean)|null) => *} scan @param {string} [homeId]
 *  @returns {*} */
export function zoneFirst(state, owner, x, y, scan, homeId) {
  const overrideCC = homeId ? state.buildings.get(homeId) : null;
  const pinned = !!(overrideCC && overrideCC.owner === owner && !overrideCC.constructing && BUILDINGS[overrideCC.type]?.isCommandCenter);
  const home = pinned ? overrideCC : nearestCommandCenter(state, owner, x, y);
  if (!home) return scan(null);
  const inZone = (ex, ey) => nearestCommandCenter(state, owner, ex, ey) === home;
  const result = scan(inZone);
  if (result != null) return result;
  return pinned ? null : scan(null);
}
