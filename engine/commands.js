/* ============================================================
   Player/AI intent -> unit order. Both input.js (mouse/keyboard) and
   ai.js (the scripted opponent) call these directly; orders take effect
   immediately and the next sim tick acts on them.
   ============================================================ */

"use strict";

import { BUILDINGS, UNITS, canAfford, payCost, prereqsMet, canGatherType, canLogisticsType, canBuildCategory, isElectrifiable } from "./entities.js";
import { canPlaceBuilding } from "./colliders.js";
import { makeBuilding } from "./state.js";
import { formationSlots, resolveHeading, clusterUnits } from "./formation.js";
import { FREIGHTER_AI_TECH, LOGI_PRIORITIES } from "./haul.js";
import { canRecycle, beginRecycle, cancelRecycle } from "./recycle.js";

// A local copy of engine/aiCommon.js's isHumanControlled(state, owner) — this file cannot import
// aiCommon.js: aiCommon.js already imports issueBuild from here, and importing back would be the
// exact cycle aiCommon.js's own header forbids ("imports only DOWNWARD, into commands/colliders —
// never back into an AI phase module", enforced by test/static-integrity.test.js's SCC check).
// Same semantics: a seat is human-controlled exactly when it has no AI controller.
function isHumanControlled(state, owner) {
  const controller = owner === "ai" ? state.ai : owner === "player" ? state.playerAi : null;
  return controller == null;
}

// Give a unit an order, either replacing what it's doing (a plain command)
// or appending it as a waypoint (queue = true, the Ctrl+command from input.js).
// Appending only queues when the unit is actually busy — a queued command to a
// fully idle unit acts immediately, so the first waypoint of a chain doesn't
// sit inert. A plain command always wipes any queued waypoints, so it cancels a
// chain cleanly. sim.js pulls the next queued order in as soon as `order` clears.
//
// A DIRECT order (anything except the follow-leader order dispatchFormation itself hands out)
// releases the unit from whatever squad it was following — direct control always wins. The
// squad's leader is untouched by this (a leader never carries squadLeader itself), so giving
// the LEADER a fresh order here never disbands the squad; only a follower ordered on its own
// leaves it.
function dispatch(unit, order, queue) {
  if (order.type !== "follow-leader") setSquadLeader(unit, null);
  if (!unit.orderQueue) unit.orderQueue = [];
  unit.hold = false;   // any positive order (move/attack/gather/waypoint) cancels a Hold stance
  if (queue && (unit.order || unit.orderQueue.length)) {
    unit.orderQueue.push(order);
  } else {
    unit.order = order;
    unit.orderQueue = [];
  }
}

// Attach/detach `unit` to/from `leader`'s squad (or clear it with leader=null). Keeps the
// relationship bidirectional and consistent: leaving a DIFFERENT leader's squad always trims
// that leader's own squadFollowers list too, so a leader never keeps dragging along a unit that
// no longer considers it the leader. Transient, session-only state (never persisted — see
// persist.js's serPlanet, which strips both fields and drops a live follow-leader order
// entirely rather than trying to serialize the object reference it carries).
function setSquadLeader(unit, leader) {
  const old = unit.squadLeader;
  if (old && old !== leader && old.squadFollowers) {
    const i = old.squadFollowers.indexOf(unit);
    if (i >= 0) old.squadFollowers.splice(i, 1);
  }
  unit.squadLeader = leader || undefined;
}

// A formation leader trails a little BELOW its slowest member's own top speed — an exact tie
// would leave a straggler (knocked off its slot by avoidance steering, a longer way around an
// obstacle, still catching up from a fresh spawn, …) with no way to ever close the gap and
// reform, since it can never out-pace a leader moving at its own maximum. This slack gives it
// the room to actually catch up.
const FORMATION_PACE = 0.95;

// The slowest unit's own speed across `units`, trimmed by FORMATION_PACE — a formation leader's
// travel pace is capped to this (order.speedCap, read by engine/movement.js's orderedSpeed) so a
// fast leader can't outrun the group it's leading. Returns undefined (leave the order uncapped)
// when there's nothing to cap to, e.g. an empty follower list.
function groupSpeedCap(units) {
  const speed = units.reduce((m, u) => Math.min(m, UNITS[u.type]?.speed ?? Infinity), Infinity);
  return Number.isFinite(speed) ? speed * FORMATION_PACE : undefined;
}

// Range-layered formation ranks: re-pair `units.slice(1)` (the followers) with `spots.slice(1)`
// (their assigned slots) by weapon range instead of raw selection-array order — a wedge or line
// otherwise interleaves a Bastion and a Breacher arbitrarily, purely by which order the player
// happened to add them to the selection. `forwardness` is each follower slot's projection onto the
// SAME heading formationSlots itself just oriented the shape around (resolveHeading, engine/
// formation.js — deliberately not unit-normalized, which is fine: a positive scalar multiple never
// changes which of two spots projects further forward, only relative order matters here). Units
// are sorted by (UNITS[type].range ?? Infinity) ascending, id tie-break (deterministic — a string
// comparison, unlike object/Map iteration order); slots are sorted by forwardness descending; the
// two lists are zipped index-for-index — so the shortest-ranged unit (Bastion, Skiff) lands on the
// most forward slot, the longest-ranged (Lancer, Breacher, Colossus) trail behind, and any unarmed
// unit (Mender, a freighter caught in a squad select) sinks to the rearmost slot of all — the
// missing-range fallback has to sort LAST, not first, or an unarmed support unit would rank as the
// single shortest range in the group and lead the charge. Returns a
// new spots array, same length and leader-first as the input, so callers keep reading `spots[i]`
// exactly as before; `spots[0]` (the leader's own slot) passes through untouched — the leader is a
// documented player choice (engine/formation.js header), never re-picked by a stat.
function rankSlotsByRange(units, spots, x, y, formation) {
  const leaderSpot = spots[0];
  const heading = resolveHeading(units, x, y, formation);
  const followers = units.slice(1);
  const slotOf = new Map(units.map((u, i) => [u, spots[i]]));

  // Rank WITHIN each spatial cluster, not across the whole selection. formationSlots deliberately
  // gives each cluster its own sub-formation — "spaced by each cluster's own footprint so
  // sub-formations can't overlap" — and clusterUnits promises it "preserves each unit's relative
  // position". A single global sort of all followers by range against all slots by forwardness had
  // no cluster awareness in either half, so two armies far apart cross-swapped sub-formations and
  // each walked the extra distance to the other's slots: the resulting shape was still correct, but
  // units marched through each other to reach it, which reads as pathing jank rather than as two
  // features disagreeing. Ranking per cluster honours both — each keeps its members, and each is
  // internally range-layered, which is the whole point of the layering.
  const byRange = us => us.slice().sort((a, b) => {
    const ra = UNITS[a.type]?.range ?? Infinity, rb = UNITS[b.type]?.range ?? Infinity;
    return ra !== rb ? ra - rb : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
  const byForwardness = ss => ss.slice().sort((s1, s2) => {
    const f1 = (s1.x - leaderSpot.x) * heading.x + (s1.y - leaderSpot.y) * heading.y;
    const f2 = (s2.x - leaderSpot.x) * heading.x + (s2.y - leaderSpot.y) * heading.y;
    return f2 - f1;
  });

  // Cluster the WHOLE selection, exactly as formationSlots does — not just the followers. Excluding
  // the leader first splits its own cluster-mates off into singletons, which re-creates the very
  // cross-cluster swap this is fixing. The leader's slot is then held out of its group's pool,
  // since spots[0] passes through untouched by design.
  const leader = units[0];
  const spotFor = new Map();
  for (const group of clusterUnits(units)) {
    const members = group.filter(u => u !== leader);
    if (!members.length) continue;
    const ranked = byRange(members);
    const ordered = byForwardness(members.map(u => slotOf.get(u)));
    ranked.forEach((u, i) => spotFor.set(u, ordered[i]));
  }
  return [leaderSpot, ...followers.map(u => spotFor.get(u))];
}

// The shared machinery behind issueMove/issueAttackMove/issueHoldFormation: lay the group out
// in `formation`'s shape, give the LEADER (units[0] — see engine/formation.js) its own real
// order via `makeLeaderOrder(point)`, and give every OTHER unit a persistent "follow-leader"
// order that keeps it at a fixed offset from the leader's LIVE position from now on
// (engine/movement.js keepFollowingLeader) — not just for this one command. That's what makes
// "select the leader alone and move it" drag the rest of the formation along for free: a later
// solo command to the leader (the n===1 branch below) re-uses its EXISTING squadFollowers
// (pruned of anything that's died) purely to recompute the group's speed cap; it never touches
// the followers' own orders, because they're already perpetually chasing the leader regardless
// of what NEW order the leader receives.
//
// The whole squad's travel speed is capped to its SLOWEST member (order.speedCap, read by
// engine/movement.js's orderedSpeed) so a fast leader can't outrun its own formation — without
// this, followers would perpetually lag behind a leader moving at its own full speed, stretching
// the shape out instead of holding it.
// `state` is OPTIONAL and trailing (T-017/ADR-0008): every caller before this fix — the scripted
// AI, input.js's single-player UI, and every pre-existing test — never passed one, and omitting it
// preserves the exact original `leader.owner === "player"` check, byte-identical. Only
// server/session.js's HANDLERS (the actual multiplayer command-application path) pass state, so
// that a human driving EITHER seat gets the real leader/follower mechanic, not just literally
// "player". No mid-match caller mixes both call styles for the same match, so there's no risk of
// the two forms disagreeing about the same leader within one game.
function dispatchFormation(units, x, y, formation, queue, makeLeaderOrder, state) {
  const leader = units[0];

  // The leader/follow squad is a PLAYER selection-UX feature — there's no analogous "the unit
  // you built a selection around" concept for the scripted AI (or a test double with no owner
  // set at all), and the existing tactical AI (kiting, retreats, feint response, wave sizing…)
  // reads every one of ITS units' own real move/attack-move order directly. So anything that
  // isn't human-controlled skips the whole leader/follower mechanic and just gets the plain
  // per-unit spread this replaces — one real order per unit, exactly as before this feature
  // existed. (Every player-issued command always passes real player.owner==="player" units —
  // see input.js's selectedUnits().)
  const humanControlled = state ? isHumanControlled(state, leader.owner) : leader.owner === "player";
  if (!humanControlled) {
    const spots = formationSlots(units, x, y, formation);
    units.forEach((u, i) => dispatch(u, makeLeaderOrder(spots[i]), queue));
    return;
  }

  if (units.length === 1) {
    const order = makeLeaderOrder({ x, y });
    if (leader.squadFollowers && leader.squadFollowers.length) {
      leader.squadFollowers = leader.squadFollowers.filter(f => f.hp > 0);
      const cap = groupSpeedCap([leader, ...leader.squadFollowers]);
      if (cap !== undefined) order.speedCap = cap;
    }
    dispatch(leader, order, queue);
    return;
  }

  let spots = formationSlots(units, x, y, formation);
  // Range-layered ranks (see rankSlotsByRange above): only for an opt-in SHAPED formation, never
  // the legacy grid spread and never when the caller passed no formation at all (formationSlots'
  // own shape default is "grid" either way) — the AI/owner-less path above already returned before
  // reaching here, so this only ever reorders a real player leader/follower squad.
  if (formation && formation.shape && formation.shape !== "grid") {
    spots = rankSlotsByRange(units, spots, x, y, formation);
  }
  const leaderSpot = spots[0];
  const newFollowers = units.slice(1);

  // Redefining the squad for exactly this unit set: anyone who WAS following this leader but
  // isn't part of it this time is released — and actually stopped, not just unlinked, so a
  // dropped unit doesn't silently keep chasing a leader that no longer lists it.
  if (leader.squadFollowers) {
    // Iterate a SNAPSHOT: setSquadLeader(old, null) splices `old` out of this very array, and a
    // for...of iterator is index-based, so mutating in place skips the next element. Dropping two
    // adjacent followers used to release only the first, leaving the second with squadLeader
    // pointing at a leader whose own list no longer contained it.
    for (const old of [...leader.squadFollowers]) {
      if (!newFollowers.includes(old)) { setSquadLeader(old, null); old.order = null; }
    }
  }
  leader.squadFollowers = newFollowers;

  const leaderOrder = makeLeaderOrder(leaderSpot);
  const cap = groupSpeedCap(units);
  if (cap !== undefined) leaderOrder.speedCap = cap;
  dispatch(leader, leaderOrder, queue);

  for (let i = 1; i < units.length; i++) {
    setSquadLeader(units[i], leader);
    dispatch(units[i], {
      type: "follow-leader", leader,
      offsetX: spots[i].x - leaderSpot.x, offsetY: spots[i].y - leaderSpot.y,
    }, queue);
  }
}

// A click-and-drag command's drag vector (formation.headingX/headingY) is also the direction
// the player wants the group to FACE — not just how the shape is oriented while travelling.
// Stamped onto every commanded unit as `facing` (read by renderShared.js's updateFacing once a
// unit stops moving, overriding the angle it would otherwise just freeze at) — the "give a
// formation, or a single/multiple selection, a direction to face" ask (e.g. holding a line
// facing the enemy). A PLAIN command (a click, no drag — no explicit heading) clears any
// earlier facing instead, so it never lingers stale once the player stops aiming their orders.
function applyFacing(units, formation) {
  const hx = formation?.headingX || 0, hy = formation?.headingY || 0;
  if (hx || hy) {
    const angle = Math.atan2(hy, hx);
    for (const u of units) u.facing = angle;
  } else {
    for (const u of units) delete u.facing;
  }
}

// `formation` ({shape, leaderPos, headingX, headingY}, engine/formation.js) is optional —
// omitted, it's the original flat grid spread (byte-identical to the old behaviour), unchanged
// for any caller that doesn't pass one (the AI, and every pre-existing test).
export function issueMove(units, x, y, queue = false, formation, state) {
  if (!units.length) return;
  dispatchFormation(units, x, y, formation, queue, pt => ({ type: "move", x: pt.x, y: pt.y }), state);
  applyFacing(units, formation);
}

export function issueGather(units, nodeId, queue = false) {
  units.forEach(u => { if (canGatherType(u.type)) dispatch(u, { type: "gather", nodeId }, queue); });
}

// Assign workers to SERVICE a building — a standing round trip that carries its inputs in and its
// output out (engine/haul.js). `manual` keeps them on that one building until re-ordered, instead
// of the auto-logistics that re-picks the nearest needy building each cycle.
export function issueServiceBuilding(units, buildingId, queue = false) {
  units.forEach(u => {
    if (canLogisticsType(u.type)) dispatch(u, { type: "service", buildingId, phase: "plan", manual: true }, queue);
  });
}

// Assign workers to FERRY a landed freighter — a standing loop that carries nearby producer
// backlog onto its hold (so it becomes its own mobile collection point) and, once there's nothing
// left to load, carries some of that hold back to the treasury (engine/haul.js updateFerry). Any
// freighter qualifies — this is a worker physically loading a ship, not the ship acting on its
// own; see issueSetAILogistics for that separate, research-gated mode.
export function issueFerryFreighter(units, freighterId, queue = false) {
  units.forEach(u => {
    if (canLogisticsType(u.type)) dispatch(u, { type: "ferry", freighterId, phase: "plan", manual: true }, queue);
  });
}

// Assign workers to REPAIR a damaged own building OR wounded own unit — a standing job that keeps
// patching the target at WORKER_REPAIR_RATE hp/sec (engine/repair.js updateRepairJob) until it's
// fully healed, then waits there for it to take damage again, the same auto-vs-manual split
// issueServiceBuilding uses. ANY completed building qualifies (a turret, a Habitat, the Command
// Center itself) — not just a logistics-buffered one — and any mobile unit too; this is a worker
// literally patching the hull, unrelated to hauling its goods.
export function issueRepair(units, targetId, queue = false) {
  units.forEach(u => {
    if (canLogisticsType(u.type)) dispatch(u, { type: "repair", targetId, phase: "toSite", manual: true }, queue);
  });
}

// Pin `units`' assigned home Command Center — an explicit player override for zoneFirst's usual
// "nearest CC by distance" guess (engine/gather.js), so the player decides which base's territory a
// worker/Mender/freighter's job search, ferry-target pick, and repair-roam all stay loyal to instead
// of pure distance ("Player is in charge of where sufficient resources are, per area"). Passive: it
// never touches whatever order the unit is already running — it only changes what the NEXT idle job
// search prefers. Silently no-ops any unit type that never consults a home zone (a combat unit, a
// scout) so a mixed selection right-clicking a Command Center still does the right thing for the
// units that actually care.
export function issueSetHomeBase(units, ccId) {
  units.forEach(u => {
    if (canLogisticsType(u.type) || UNITS[u.type]?.role === "support" || UNITS[u.type]?.role === "freighter") {
      u.homeCC = ccId;
    }
  });
}

// Toggle a freighter's AI-LOGISTICS mode: put to work in the local haul/service chain like a
// worker (engine/sim.js updateUnit), but at its own far larger cargo capacity, burning AI Cores
// from the treasury while active (engine/haul.js payAIUpkeep). Turning it OFF always works (stand
// down is never gated); turning it ON requires its owner to have researched FREIGHTER_AI_TECH —
// unresearched freighters in the selection are silently skipped rather than the whole call failing,
// so a mixed selection still does what it can.
export function issueSetAILogistics(units, on, state) {
  units.forEach(u => {
    if (UNITS[u.type]?.role !== "freighter") return;
    if (on && !state.players[u.owner]?.upgrades[FREIGHTER_AI_TECH]) return;
    u.aiLogistics = on;
    if (on && !u.cargo) u.cargo = { com: null, qty: 0 };
  });
}

// Toggle a freighter's COLLECTION-POINT mode (engine/haul.js assignShuttle/updateFreighterShuttle):
// once its hold is full it drives itself to the nearest Command Center, banks everything, and
// returns to its ANCHOR to keep collecting. No research needed — unlike AI-logistics this doesn't
// fold it into the base's whole haul/service chain, it's just "empty me when I'm full". Turning it
// ON stamps the freighter's CURRENT spot as that anchor, so it comes back to wherever it was
// standing when you switched it on. Turning it OFF always works.
export function issueSetCollectPoint(units, on) {
  units.forEach(u => {
    if (UNITS[u.type]?.role !== "freighter") return;
    u.collectPoint = on;
    if (on) u.anchor = { x: u.x, y: u.y };
  });
}

// Toggle a building's ELECTRIFY state (Odyssey): wired into the power grid, it runs 30% better
// while powered, at a steady draw (see hudSelection.js's Electrify panel). T-019a/ADR-0006: this
// used to have NO command at all — hudSelection.js wrote `e.electrified = v` directly, the only
// thing stopping it electrifying an opponent's Habitat was that same client's own
// `e.owner === "player"` filter, not anything in the engine. `owner` is OPTIONAL, same pattern as
// issueRecycle: omitted, this is unfiltered (aiIndustry.js's own internal write stays direct — it's
// engine code setting its OWN controller's building, not a trust boundary); passed, entities not
// owned by `owner` are skipped.
export function issueSetElectrified(entities, on, owner) {
  entities.forEach(e => {
    if (owner !== undefined && e.owner !== owner) return;
    if (e.kind === "building" && isElectrifiable(e.type)) e.electrified = on;
  });
}

// Toggle a building's per-building LOGISTICS PRIORITY — high/normal/low, a building-panel cycle
// button (hudSelection.js) on a factory or fuel-burning power station. A pure weight on the SAME
// distance-then-id nearest-first scans every producer/factory already competes on
// (engine/haul.js priorityWeight, read by nearestBacklogProducer and assignService's scanFor):
// "keep the Reactor fed before the Smelter" without dedicating a worker to it by hand
// (order.manual, issueServiceBuilding). Same idiom as issueSetCollectPoint just above: a plain
// field flip, no cost, no prereq. Takes a single building (by id), not a unit selection — this is
// a property of the BUILDING being serviced, not of whoever's servicing it. An unknown building id
// is a silent no-op (the panel button that calls this only ever names the currently selected
// building); an unrecognised priority string collapses to "normal" — the same fallback
// engine/haul.js's priorityWeight already applies to a missing field, so a building can never end
// up in an unrecognised state.
export function issueSetLogiPriority(state, buildingId, priority) {
  const b = state.buildings.get(buildingId);
  if (!b) return;
  b.logiPriority = LOGI_PRIORITIES.includes(priority) ? priority : "normal";
}

// Only ARMED units (or a support drone, whose 'attack' order updateSupport reinterprets
// as "advance on that foe" and mend nearby, dealing no damage) accept an attack order.
// A weaponless rider — a colony ship, a freighter — has no `attack` stat, so routing an
// order to it would make attackDamage compute `undefined + …` = NaN and permanently
// NaN-poison the target's hp (never ≤ 0, so it never dies: an un-killable ghost). Today
// only the UI filters this; the engine boundary now self-defends, so tests/AI/future
// callers can't trip it. A no-op for every valid caller, so determinism is unchanged.
export function issueAttack(units, targetId, queue = false) {
  units.forEach(u => {
    const def = UNITS[u.type];
    if (def && (def.attack || def.role === "support")) dispatch(u, { type: "attack", targetId }, queue);
  });
}

export function issueAttackMove(units, x, y, queue = false, formation, state) {
  if (!units.length) return;
  dispatchFormation(units, x, y, formation, queue, pt => ({ type: "attack-move", x: pt.x, y: pt.y }), state);
  applyFacing(units, formation);
}

// Escort a friendly ship: each unit takes a stable slot on a protective ring around the
// target and follows it wherever it's ordered (engine/movement.js escortSlot), holding the
// formation until given another order. A combat escort still auto-acquires threats that come
// near, then reforms. The target itself is never told to escort (it's filtered out by the
// caller). `slot`/`slots` fix each unit's place at issue time, so the ring is deterministic.
export function issueEscort(units, targetId, queue = false) {
  const n = units.length;
  units.forEach((u, i) => dispatch(u, { type: "escort", targetId, slot: i, slots: n }, queue));
}

// Protection of a FORMATION, not one external ship: the group forms up in the chosen shape
// right where it's standing (its own current centroid) and holds there — the LEADER holds its
// own fixed anchor (engine/movement.js keepFormationStation), everyone else follows it there and
// keeps station relative to it (keepFollowingLeader) exactly like a hold-formation-flavoured
// move, so a later solo command to just the leader picks the whole formation back up too (see
// dispatchFormation). Combat units also take the Hold stance (issueHold's existing "stand fast,
// don't chase" rule) — LEADER AND FOLLOWERS alike — so the whole formation keeps its shape
// instead of scattering to run down a distant target; non-combat units (workers, a Mender) still
// take a slot — sheltering behind/inside the line — they just have no stance flag to set.
export function issueHoldFormation(units, shape = "grid", leaderPos = "front", state) {
  if (!units.length) return;
  let sx = 0, sy = 0;
  for (const u of units) { sx += u.x; sy += u.y; }
  const anchorX = sx / units.length, anchorY = sy / units.length;
  dispatchFormation(units, anchorX, anchorY, { shape, leaderPos, originX: anchorX, originY: anchorY }, false,
    pt => ({ type: "hold-formation", anchorX: pt.x, anchorY: pt.y, offsetX: 0, offsetY: 0 }), state);
  for (const u of units) if (UNITS[u.type] && UNITS[u.type].role === "combat") u.hold = true;
}

// Pays the cost up front, drops a constructing building on the spot, and
// sends the chosen worker to stand at it until it finishes. Placement is
// validated (and payment withheld) before anything is committed, so a bad
// click never charges the player -- see engine/colliders.js for what
// counts as valid ground.
export function issueBuild(state, workerId, buildingType, x, y) {
  const worker = state.units.get(workerId);
  if (!worker) return null;
  const player = state.players[worker.owner];
  const def = BUILDINGS[buildingType];
  if (!def) return null;
  // Odyssey-only buildings (e.g. the Spaceport) can never be founded on the skirmish
  // path — the same hard guarantee queueProduction makes for units (production.js), so
  // the skirmish sim/AI stays byte-identical and can't be handed Odyssey content.
  if (def.odysseyOnly && !state.endless) return null;
  // A unit may only found a building whose category it's flagged for (engine/entities.js
  // canBuildCategory) — Worker covers every category, so this only ever blocks a non-worker
  // (e.g. a combat unit) from founding one.
  if (!canBuildCategory(worker.type, def.category)) return null;
  if (!canAfford(player.resources, def.cost)) return null;
  if (!prereqsMet(state, worker.owner, def)) return null;   // e.g. no founding a Foundry without a completed Barracks
  if (!canPlaceBuilding(state, buildingType, x, y)) return null;
  payCost(player.resources, def.cost);
  const building = makeBuilding(buildingType, worker.owner, x, y, { constructing: true });
  state.buildings.set(building.id, building);
  setSquadLeader(worker, null);   // a direct order releases the worker from any squad it was following
  worker.order = { type: "build", buildingId: building.id };
  return building.id;
}

// Sends more workers to help an already-founded construction site — no
// cost (already paid when it was placed), no new building. Extra hands
// speed the build up; see production.js's updateBuildingConstruction.
// `buildingType` resolves the site's category so only a unit eligible for THAT category can be
// sent to help, same rule as founding it (issueBuild) in the first place.
export function issueAssistBuild(units, buildingId, buildingType, queue = false) {
  const category = BUILDINGS[buildingType]?.category;
  units.forEach(u => { if (canBuildCategory(u.type, category)) dispatch(u, { type: "build", buildingId }, queue); });
}

// Halt: drop the active order and any queued waypoints so the unit stops
// where it stands. A combat unit still defends itself (it re-auto-acquires an
// enemy that wanders into range next tick), but it won't chase or resume a
// path — the standard RTS "stop" that pulls a unit out of a move or a chain.
// A direct order like this always releases the unit from a squad it was following.
// Also stands down an in-progress Recycle (engine/recycle.js) — Stop is the general "abort
// whatever this unit is doing" command, and a recycle left running with its order cleared would
// otherwise strand the unit: sim.js keeps skipping it every tick (it checks `recycling`, not
// `order`) with no way back short of the dedicated Cancel Recycle button.
export function issueStop(units) {
  units.forEach(u => { setSquadLeader(u, null); u.order = null; u.orderQueue = []; u.hold = false; u.recycling = null; });
}

// Recycle an OWNED, eligible unit or building for part of its cost back (engine/recycle.js —
// refund fraction and the in-place timer). A unit is released from its squad and any Hold stance,
// same as a direct order; a building just starts its timer where it stands, staying fully
// functional until the timer completes (see updateBuildingRecycle). Ineligible entries (a
// Command Center, something already constructing or already recycling) are silently skipped, so
// a mixed selection just recycles whatever in it actually can be.
//
// `owner` is OPTIONAL (T-019/FR-10, same pattern as issueMove/issueAttackMove's trailing `state` —
// see dispatchFormation's own comment): omitted, every pre-existing caller (input.js, every test)
// is unchanged — this function never actually checked ownership despite recycle.js's own comment
// once claiming it did (canRecycle doesn't either). Passed, entities NOT owned by `owner` are
// skipped, same as any other ineligible entry — closing that gap wherever a caller HAS an owner to
// check against. server/session.js doesn't pass one yet: Phase 1 has no validated "who issued
// this command" signal (T-010's own header), which is exactly what T-021's codec adds in front of
// this file, not a rewrite of it.
export function issueRecycle(entities, owner) {
  entities.forEach(e => {
    if (owner !== undefined && e.owner !== owner) return;
    if (!canRecycle(e)) return;
    if (e.kind === "unit") { setSquadLeader(e, null); e.hold = false; }
    beginRecycle(e);
  });
}

// Stand a recycle back down — free, since nothing was ever paid or disabled beyond refusing new
// orders (a building) or acting at all (a unit): no refund, the entity just resumes normal life.
export function issueCancelRecycle(entities) {
  entities.forEach(e => { if (e.recycling) cancelRecycle(e); });
}

// Hold position: a combat unit stands its ground and fires on anything that
// wanders into weapon range, but never CHASES an auto-acquired target out of
// position (combat.js honours unit.hold) — the standard defensive stance for
// holding a line or a choke. Any move/attack order, or Stop, clears it.
export function issueHold(units) {
  units.forEach(u => {
    if (UNITS[u.type] && UNITS[u.type].role === "combat") { setSquadLeader(u, null); u.order = null; u.orderQueue = []; u.hold = true; }
  });
}

// Patrol: a looping attack-move waypoint chain. Each point becomes an ordinary {type:
// 'attack-move', x, y} leg — engine/combat.js needs nothing extra, a patrol leg auto-engages
// anything encountered exactly like any other attack-move — except every leg also carries
// `patrol: true`, which engine/sim.js's pull-next-queued-order step reads to requeue a leg right
// back onto the tail the moment it's pulled off the front, so the chain cycles forever instead of
// draining to idle once the last point is reached.
// Built with the same per-unit `dispatch` plumbing every other order goes through (queue=false
// for the first point replaces whatever the unit was doing, same as a plain command; queue=true
// for the rest appends them behind it) so a fresh patrol command cleanly cancels an old one.
// Gated to combat/scout roles, the same UNITS[type].role check issueHold uses just above — a
// worker or freighter caught in the selection is silently skipped, like every other role-gated
// order in this file.
export function issuePatrol(units, points) {
  if (!points.length) return;
  units.forEach(u => {
    if (!UNITS[u.type] || (UNITS[u.type].role !== "combat" && UNITS[u.type].role !== "scout")) return;
    points.forEach((p, i) => dispatch(u, { type: "attack-move", x: p.x, y: p.y, patrol: true }, i > 0));
    // The first point lands directly in `order` (dispatch's queue=false branch above, for i===0)
    // rather than being pulled off orderQueue — the ONE place (engine/sim.js) that re-enqueues a
    // patrol leg once it's activated. Give it that same "there's another copy of me waiting"
    // treatment by hand here, or the loop would quietly drop the very first waypoint after one
    // lap (leg two -> leg three -> leg two -> ... forever, leg one never revisited) instead of
    // genuinely cycling through every point that was given.
    u.orderQueue.push(u.order);
  });
}

// Put a Ranger into autonomous scout mode (order type "scout"): it ranges the
// map on its own toward the nearest unexplored ground until re-ordered (see
// scout.js). Only scout-role units accept it, so issuing it to a mixed selection
// simply skips everything that isn't a Ranger. Clears any queued waypoints, like
// a plain command — the mode is persistent, not something to stack behind.
//
// A Ranger LEADING a formation keeps leading it here rather than abandoning it: its followers
// are left exactly as they are, still chasing it on their existing follow-leader order (the same
// "a new leader order never touches the followers' own orders" rule dispatchFormation's solo-move
// branch already relies on), and the scout order itself is capped to the group's speed
// (order.speedCap — the same group-minimum a move/attack-move/hold-formation leader gets, see
// groupSpeedCap/dispatchFormation above) so it doesn't outrun its own escorts — a protective scout
// leading the pack into the fog at ITS pace, not a lone unit racing off alone. A solo Ranger (no
// squadFollowers) scouts at its own full speed exactly as before — nothing to keep pace with.
export function issueScout(units) {
  units.forEach(u => {
    if (UNITS[u.type] && UNITS[u.type].role === "scout") {
      setSquadLeader(u, null);
      const order = { type: "scout" };
      if (u.squadFollowers && u.squadFollowers.length) {
        u.squadFollowers = u.squadFollowers.filter(f => f.hp > 0);
        const cap = groupSpeedCap([u, ...u.squadFollowers]);
        if (cap !== undefined) order.speedCap = cap;
      }
      u.order = order;
      u.orderQueue = [];
    }
  });
}

// Every unit the building produces from now on walks to this point instead of
// wherever the old rally was — production.js reads building.rally fresh at spawn
// time, so this takes effect immediately with no other plumbing needed. If the
// rally was set ON a resource node (nodeId given), new workers spawn already
// gathering it instead of standing idle at the point — the standard "rally to
// minerals" convenience. Non-workers just walk to the point.
// T-021/ADR-0006 D2: the ONE engine signature change the wire protocol needs — was
// `(building, x, y, nodeId)`, a bare object reference with no state at all, the one export that
// would otherwise force net/commandCodec.js to hand a raw object across the wire->engine boundary
// instead of an id. 3 call sites (dossier 02 §4.2). A missing/unknown buildingId is a silent no-op,
// matching the "silent-skip is the house style" convention every other issue* function already
// follows for an ineligible/vanished target.
export function issueSetRally(state, buildingId, x, y, nodeId = null) {
  const b = state.buildings.get(buildingId);
  if (!b) return;
  b.rally = { x, y, nodeId };
}
