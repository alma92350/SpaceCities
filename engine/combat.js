/* ============================================================
   Combat-role units (Skiff, Bastion): auto-acquire the nearest enemy
   within aggro range, close to weapon range, and fire on cooldown. An
   explicit 'attack' order pins the target; 'attack-move' auto-engages
   anything encountered en route to its destination. A unit type's
   bonusVs table (entities.js) adds extra damage against a specific
   target type — Bastion's slow, short-range bulk is built to punch
   through Skiff hulls specifically.

   A plain 'move' order is the deliberate exception: it's how a player
   pulls a unit OUT of a fight or redirects it past a threat, so it
   skips auto-acquire entirely rather than getting silently overridden
   the moment an enemy wanders into aggro range.
   ============================================================ */

"use strict";

import { stepToward, keepEscortStation, keepFormationStation, keepFollowingLeader, orderedSpeed } from "./movement.js";
import { UNITS, BUILDINGS, upgradeMult, rankMults } from "./entities.js";
import { getEntity, removeEntity } from "./state.js";
import { queryNeighbors, REJECT_SLACK } from "./grid.js";
import { sampleTerrain, sideMod, TERRAIN } from "./map.js";
import { UPHILL_FRAC } from "./fog.js";
import { hashStr } from "./rng.js";
import { detonateIfAttacked } from "./bomb.js";
import { depositWreckage } from "./wreckage.js";
import { controllerFor } from "./aiCommon.js";

// This module's broad-phase result buffers (see engine/grid.js) — one per call
// site so no two can alias each other's candidates. acquireTarget in particular
// keeps its list live across a call into spreadEnemy.
const _threatBuf = [], _splashBuf = [], _acquireBuf = [];

export function updateCombat(state, unit, dt) {
  const def = UNITS[unit.type];
  unit.attackTimer = Math.max(0, unit.attackTimer - dt);

  if (unit.order && unit.order.type === "move") {
    // Clear the auto-acquired target on the way out. This block returns BEFORE the acquisition
    // code below, and that code is the only place in the engine that ever writes autoTarget — so
    // the field was unreachable-for-clearing for the whole duration of a move. separation.js's
    // isCombatMode reads it, which made a unit pulled out of a fight with Move (the documented way
    // to disengage) keep the tight combat packing forever instead of the padded idle spacing
    // SEPARATION_PAD_MULT exists to give it — contradicting isCombatMode's own comment, which
    // claims a stale autoTarget only reads as combat-mode "for one tick too long".
    unit.autoTarget = null;
    const arrived = stepToward(state, unit, unit.order.x, unit.order.y, orderedSpeed(def.speed, unit.order), dt);
    if (arrived) unit.order = null;
    return;
  }

  let targetId = unit.order && unit.order.type === "attack" ? unit.order.targetId : null;
  // T-019/FR-10: a dead target clears the order (unchanged); so, now, does a FRIENDLY one (same
  // owner as the attacker) — an explicit attack order naming your own side was never rejected
  // here before. issueAttack (commands.js) has no state to check ownership against at issue time,
  // so this execution-time check is where friendly-fire actually gets stopped, whatever put the
  // order there — a client bug today, or an untrusted network client once T-021's codec is the
  // only thing standing between a wire command and this engine.
  if (targetId) {
    const target = getEntity(state, targetId);
    if (!target || target.hp <= 0 || target.owner === unit.owner) { unit.order = null; targetId = null; }
  }
  // AI focus-fire (engine/ai.js sets focusId when the Tactical AI is directing a
  // squad onto one target): concentrate on it while it's a live enemy inside this
  // unit's aggro. If it's dead or out of reach we fall straight through to the
  // normal dispersed auto-acquire, so a stale/too-far focus never freezes a unit.
  if (!targetId && unit.focusId && stillEngageable(state, unit, def, unit.focusId)) {
    targetId = unit.focusId;
  }
  if (!targetId) {
    // Stick to last tick's auto-target while it's still a live enemy in aggro
    // range; only when it dies or slips away do we acquire a fresh (dispersed)
    // one. Committing to a target instead of re-picking the nearest every tick
    // is what makes spread-targeting hold — otherwise the whole line would
    // re-converge on the single closest enemy each frame.
    if (unit.autoTarget && stillEngageable(state, unit, def, unit.autoTarget)) {
      targetId = unit.autoTarget;
    } else {
      targetId = acquireTarget(state, unit, def);
      unit.autoTarget = targetId;
    }
  }

  if (targetId) {
    const target = getEntity(state, targetId);
    if (target && target.hp > 0) {
      const dist = Math.hypot(target.x - unit.x, target.y - unit.y);
      if (dist > def.range) {
        // Hold stance: stand fast rather than chasing an out-of-range target —
        // fire only once something comes to us (a player-set defensive stance;
        // the AI never sets it, so this can't touch the resolve guarantee).
        // Overcharged Core's chaseSpeedMult (Assault Tier 2, entities.js UPGRADES) closes
        // distance ~10% faster specifically HERE — an already-acquired target being run down —
        // never on the plain 'move' order above (that branch reads def.speed directly, untouched).
        // "Combat drive": the tactical verb that makes Assault's Tier-2 more than a second flat
        // damage multiplier.
        const chaseSpeed = def.speed * upgradeMult(state.players[unit.owner]?.upgrades, "chaseSpeedMult");
        if (!unit.hold) stepToward(state, unit, target.x, target.y, chaseSpeed, dt);
      } else if (unit.attackTimer <= 0) {
        const died = performAttack(state, unit, def, target);
        // Overdrive Actuators (Assault Tier 3, entities.js UPGRADES) shortens every cooldown
        // reset after a landed shot via attackCooldownMult — see updateWorkerCombat below for the
        // other reset site (a worker's explicit attack order). Deliberately NOT applied in
        // updateBuildingCombat's own reset, further down: this is the ARMY's tempo upgrade
        // (mobile units only), not a base-defense buff — Bulwark, not Assault, is the doctrine
        // that already reaches structures too (reinforcedPlating's own comment, entities.js).
        unit.attackTimer = def.cooldown * upgradeMult(state.players[unit.owner]?.upgrades, "attackCooldownMult");
        if (died && unit.order && unit.order.targetId === target.id) unit.order = null;
      } else if (controllerFor(state, unit.owner)?.micro && def.range >= KITE_MIN_RANGE) {
        // T-017/ADR-0008: this used to be state.ai?.micro && unit.owner === "ai" — kiting followed
        // a hardcoded owner literal, so seat B always kited (or never did) regardless of who was
        // actually driving it. Now it follows the unit's OWN controller: Tactical AI kites, and
        // (once a match can actually populate state.playerAi for a live human vs. Tier-1-self-play
        // pairing) so would a micro-enabled controller on the OTHER seat. Behaviour-preserving for
        // every match today — state.playerAi is null outside self-play/duels — but fingerprint-
        // changing wherever it isn't, so self-play/duel fixtures were re-baselined in this same
        // change (test/ai-selfplay.test.js, test/duelCore.test.js), not silently.
        maybeKite(state, unit, def, dt);   // in range but reloading — a Tactical ranged unit stutter-steps back
      }
      return;
    }
  }

  if (unit.order && unit.order.type === "attack-move") {
    const arrived = stepToward(state, unit, unit.order.x, unit.order.y, orderedSpeed(def.speed, unit.order), dt);
    if (arrived) unit.order = null;
    return;
  }

  // Escort: with no threat acquired above (that block returns when engaging), keep station on
  // the protective ring around the guarded ship — a persistent follow, never cleared on arrival,
  // so the escort trails the target wherever it's ordered until given a new order.
  if (unit.order && unit.order.type === "escort") {
    keepEscortStation(state, unit, def.speed, dt);
  } else if (unit.order && unit.order.type === "hold-formation") {
    // Same idea, but the "target" is this unit's OWN fixed anchor rather than a moving ship —
    // a formation leader holding its ground, still fully combat-reactive above (this only runs
    // once no threat was acquired/engaged this tick).
    keepFormationStation(state, unit, def.speed, dt);
  } else if (unit.order && unit.order.type === "follow-leader") {
    // A formation follower: keeps its slot relative to the leader's live position, same
    // combat-reactive treatment as escort/hold-formation above.
    keepFollowingLeader(state, unit, def.speed, dt);
  }
}

// Only genuinely ranged units kite (Lancer 55 / Breacher 150 / Dreadnought 68);
// short-range brawlers (Skiff 40, Bastion 44) stand and trade.
const KITE_MIN_RANGE = 50;

// Stutter-step kiting: while a ranged unit is reloading and an enemy UNIT has
// closed inside 0.75x its weapon range, it steps directly away to keep the
// distance advantage, then stops to fire the instant its weapon is ready (that's
// the branch above this one). Only ever reacts to enemy UNITS — never buildings —
// so a ranged unit shelling an undefended base never backs off, keeping the
// resolves-to-a-winner guarantee intact. The retreat point is clamped to the map
// so a cornered kiter can't walk off the edge.
function maybeKite(state, unit, def, dt) {
  const danger = def.range * 0.75;
  const threat = nearestEnemyUnitWithin(state, unit, danger);
  if (!threat) return;
  const dx = unit.x - threat.x, dy = unit.y - threat.y;
  const len = Math.hypot(dx, dy) || 1;
  let tx = unit.x + (dx / len) * 40, ty = unit.y + (dy / len) * 40;
  if (state.map) {
    tx = Math.max(0, Math.min(state.map.width, tx));
    ty = Math.max(0, Math.min(state.map.height, ty));
  }
  stepToward(state, unit, tx, ty, def.speed, dt);
}

function nearestEnemyUnitWithin(state, unit, radius) {
  const cands = state.unitGrid ? queryNeighbors(state.unitGrid, unit.x, unit.y, radius, undefined, _threatBuf) : state.units.values();
  let best = null, bestD = Infinity;
  for (const e of cands) {
    if (e.owner === unit.owner || e.hp <= 0 || UNITS[e.type].role !== "combat") continue;
    const dx = e.x - unit.x, dy = e.y - unit.y;
    // Squared-distance pre-reject — see REJECT_SLACK in engine/grid.js.
    if (dx * dx + dy * dy > radius * radius * REJECT_SLACK) continue;
    const d = Math.hypot(dx, dy);
    if (d <= radius && d < bestD) { bestD = d; best = e; }
  }
  return best;
}

// Returns true if the target died. Shared by mobile units and turrets so
// upgrade multipliers and kill/event bookkeeping stay in exactly one place.
// The attackHit event carries both endpoints and the attacker's type so
// render.js can draw a tracer from shooter to target (a turret reads as
// its own "turret" type), `heavy` so a siege hit thumps deeper, `bonus`
// so a counter-triangle hit (Skiff catching a Lancer, etc.) telegraphs too —
// scoped to the per-type hard counter (bonusVs) only, distinct from `heavy`'s
// class-wide siege bonus (bonusVsBuildings), since there's no specific
// matchup to telegraph there — and `splashRadius` (def.splash's radius, when
// the attacker carries one) so renderEffects.js can draw an impact ring.
// Zero sim effect — the flags are read only by the UI layer (effects.js/
// renderEffects.js, hudSelection.js derives its "strong vs / falls to" text
// straight from the same bonusVs tables independently).
function performAttack(state, attacker, def, target) {
  // An ARMED Helium Bomb doesn't take damage from a hit — it detonates instead,
  // dealing distance-falloff blast damage to everything (attacker included)
  // within its blast radius. Checked before the normal damage/death path,
  // which never runs for it.
  if (detonateIfAttacked(state, target)) return true;
  const dmg = attackDamage(state, attacker, def, target);
  target.hp -= dmg;
  // Bulwark's out-of-combat regen (engine/repair.js updateBulwarkRegen) reads this to tell
  // whether a unit is still "in a fight" — stamped wherever damage actually lands, unit or
  // building alike, so a target under continuous fire can never coast into regen between two
  // hits that land less than the doctrine's own delay apart. See applySplash below for the same
  // stamp on splash damage.
  target.lastHitAt = state.time;
  state.events.push({
    // sourceId/targetId (agent-observability): an MCP agent reading this event off the wire has
    // no way to diff two list_entities calls fast enough to tell WHICH of its units is under fire
    // when several fights overlap — coordinates alone forced it to reconstruct the battle. Purely
    // additive alongside the pre-existing x/y/fromX/fromY the renderer already draws tracers from.
    type: "attackHit", x: target.x, y: target.y, sourceId: attacker.id, targetId: target.id,
    targetType: target.type, targetOwner: target.owner,
    fromX: attacker.x, fromY: attacker.y, unitType: attacker.type, owner: attacker.owner,
    heavy: !!(def.bonusVsBuildings && target.kind === "building"),
    bonus: !!(def.bonusVs && def.bonusVs[target.type]),
    splashRadius: def.splash ? def.splash.radius : undefined,
  });
  // Splash (def.splash = {radius, frac}, Colossus first): after the primary hit above, rattle
  // any enemy UNITS caught near the impact point too — see applySplash's own header comment for
  // why this can never touch a building or the attacker's own side.
  if (def.splash) applySplash(state, attacker, target, dmg, def.splash);
  if (target.hp <= 0) {
    // Veterancy (docs/improvement-proposals.md "Veterancy ranks"): a UNIT-kind attacker's
    // confirmed kill counts toward its own rankMults (entities.js), applied in attackDamage
    // above/below like any other multiplier. Buildings/turrets (kind "building") never accrue
    // this — static defense holds ground by hp and ammo, not by leveling up.
    if (attacker.kind === "unit") attacker.kills = (attacker.kills || 0) + 1;
    // Nothing is really destroyed: ~80% of whatever was spent building this thing
    // reappears as a minable wreck site a short delay later (engine/wreckage.js) —
    // replaces the old instant, combat-unit-only salvage refund, and now covers
    // workers and buildings too.
    depositWreckage(state, target);
    removeEntity(state, target.id);
    // unitType/kind (docs/improvement-proposals.md "Tiered destruction"): purely additive on top
    // of the pre-existing x/y/owner — boot.js/effects.js/renderEffects.js/sound.js scale the
    // death's visuals and audio by what actually died (a Worker pops, a Dreadnought booms).
    state.events.push({ type: "entityKilled", id: target.id, x: target.x, y: target.y, owner: target.owner, unitType: target.type, kind: target.kind, killerId: attacker.id, killerOwner: attacker.owner });
    return true;
  }
  return false;
}

// def.splash's implementation (Colossus first): enemy units of attacker.owner within
// `splash.radius` of the primary target's own position (the impact point) take
// dmg*splash.frac*(1 - d/splash.radius) falloff damage — the mechanical punishment for a packed,
// same-owner formation (separation.js's own packing behavior). The primary target itself is
// excluded: it already took the full, unmitigated `dmg` hit above, so splash is purely what
// happens to everyone ELSE caught nearby, not a second helping for the thing actually hit.
//
// Mirrors acquireTarget's own grid/full-scan idiom (queryNeighbors when state.unitGrid exists,
// else a plain scan over state.units.values() for the many direct-call tests that never build a
// grid) — and by walking only state.unitGrid/state.units, this can never reach a building no
// matter how close one stands to the impact (buildUnitGrid only ever indexes units; see
// engine/grid.js), so "buildings never take splash damage" holds by construction, not by a
// proximity check that could drift out of sync with colliders.js's placement rules.
//
// HP subtraction happens for every caught unit in one pass BEFORE any of them is checked for
// death (a second pass over the same `hit` list) — so the outcome can never depend on the order
// queryNeighbors happens to return candidates in. Each splash death still funnels through the
// same depositWreckage/removeEntity/entityKilled path as an ordinary kill.
function applySplash(state, attacker, target, dmg, splash) {
  const cands = state.unitGrid
    ? queryNeighbors(state.unitGrid, target.x, target.y, splash.radius, undefined, _splashBuf)
    : state.units.values();
  const hit = [];
  for (const e of cands) {
    if (e.id === target.id || e.owner === attacker.owner || e.hp <= 0) continue;   // never the primary target, never friendly, never an already-dead grid straggler
    const dx = e.x - target.x, dy = e.y - target.y;
    // Squared-distance pre-reject — see REJECT_SLACK in engine/grid.js.
    if (dx * dx + dy * dy > splash.radius * splash.radius * REJECT_SLACK) continue;
    const d = Math.hypot(dx, dy);
    if (d > splash.radius) continue;   // queryNeighbors is a padded superset — the exact-distance check is still ours to make
    e.hp -= dmg * splash.frac * (1 - d / splash.radius);
    e.lastHitAt = state.time;   // splash counts as a landed hit too — see performAttack's own stamp above
    hit.push(e);
  }
  for (const e of hit) {
    if (e.hp > 0) continue;
    depositWreckage(state, e);
    removeEntity(state, e.id);
    // Same unitType/kind addition as performAttack's own entityKilled push above — a splash
    // kill gets the same tiered destruction feedback as a direct one.
    state.events.push({ type: "entityKilled", id: e.id, x: e.x, y: e.y, owner: e.owner, unitType: e.type, kind: e.kind, killerId: attacker.id, killerOwner: attacker.owner });
  }
}

// Workers can fight, but only on an explicit 'attack' order — they never
// auto-acquire (that's the whole point of keeping them on the economy), so
// this handles just the ordered case: close to the target, strike on cooldown
// with the worker's weak stats (entities.js), and drop the order when it dies
// so a queued waypoint (or idle) takes over. Reuses the same performAttack as
// real combat units, so a worker's hit shows a tracer and plays its sound too.
export function updateWorkerCombat(state, unit, def, dt) {
  unit.attackTimer = Math.max(0, unit.attackTimer - dt);
  const targetId = unit.order.targetId;
  const target = getEntity(state, targetId);
  // T-019/FR-10: same friendly-fire check as updateCombat above — an explicit attack order naming
  // your own side is rejected here too, not just a dead target.
  if (!target || target.hp <= 0 || target.owner === unit.owner) { unit.order = null; return; }
  const dist = Math.hypot(target.x - unit.x, target.y - unit.y);
  if (dist > def.range) {
    // No chaseSpeedMult here — Overcharged Core's "combat drive" is scoped to updateCombat's own
    // chase branch above (an army unit running down an acquired target), not a worker closing on
    // its explicit attack order; the proposal's own "Where" section names updateCombat only.
    stepToward(state, unit, target.x, target.y, def.speed, dt);
  } else if (unit.attackTimer <= 0) {
    const died = performAttack(state, unit, def, target);
    // Overdrive Actuators (Assault Tier 3) applies here too — see updateCombat's own reset site
    // above for the shared attackCooldownMult comment.
    unit.attackTimer = def.cooldown * upgradeMult(state.players[unit.owner]?.upgrades, "attackCooldownMult");
    if (died) unit.order = null;
  }
}

// Bonus-vs-type is a flat add (a specific hard counter), while researched
// Refinery upgrades (entities.js's UPGRADES) are multipliers applied on
// top — one on the attacker's side (damage dealt), one on the
// defender's (damage taken) — so both sides' research matters on every
// single hit, not just for units built after researching.
function attackDamage(state, unit, def, target) {
  const bonus = def.bonusVs && def.bonusVs[target.type] || 0;
  // Siege class (Breacher) hits every building for a flat class-wide bonus
  // via bonusVsBuildings — kept separate from bonusVs (which is a hard
  // counter to one unit type) so new buildings need no per-type entries.
  const structureBonus = target.kind === "building" ? (def.bonusVsBuildings || 0) : 0;
  let dmg = (def.attack || 0) + bonus + structureBonus;   // belt-and-braces: a weaponless def can't NaN-poison hp

  // Every researched Assault upgrade (attacker side) stacks its damage-dealt
  // multiplier; every Bulwark upgrade (defender side) its damage-taken multiplier.
  // Data-driven via upgradeMult, so the doctrine tiers just work. Both sides
  // optional-chained symmetrically: an attacker whose owner isn't in state.players
  // (a corrupt/tampered entity — a valid owner always is) reads no-upgrades (mult 1)
  // instead of throwing on `.upgrades`, matching the defender-side guard below.
  dmg *= upgradeMult(state.players[unit.owner]?.upgrades, "damageDealtMult");
  dmg *= upgradeMult(state.players[target.owner]?.upgrades, "damageTakenMult");

  // Veterancy (entities.js rankMults): the same shape as the two upgrade multipliers just
  // above — the attacker's own kill tally raises damage dealt, the target's raises damage
  // taken (i.e. reduces it, since takenMult < 1 per rank). 1/1 no-op for a fresh unit or any
  // building/turret (kills never set on those), so this is purely additive to existing combat.
  dmg *= rankMults(unit).dealtMult;
  dmg *= rankMults(target).takenMult;

  // The attacker's faction (and any future world) damage edge, through the same
  // sideMod seam as every other side modifier. 1 for a neutral/economy/mobility
  // faction; the Syndicate's firepower trait multiplies here (see factions.js).
  dmg *= sideMod(state, unit.owner, "damageDealtMult");

  // A positional edge, not a counter: an attacker firing from high ground hits
  // for a flat bonus (terrain combatMult). Situational and symmetric, so the RPS
  // triangle is untouched. OPEN / map-less states read 1.
  if (state.map?.terrain) dmg *= sampleTerrain(state.map.terrain, unit.x, unit.y).combatMult;

  // A friendly Aegis nearby projects a cryo-armour bubble that reduces the damage its
  // allies take — the anvil's real value, applied wherever it stands (no targeting change
  // needed). Reads the tick's precomputed anvil list (sim.js), so it's O(anvils) — usually
  // zero. An Aegis never shields itself, so it can still be focused down.
  dmg *= anvilAura(state, target);

  return dmg;
}

// The damage multiplier from any friendly aura projector (Aegis) covering `target`. 1 when
// none is in range (or the list isn't built — a bare test state). Deterministic: positions
// are the tick-start snapshot in state.anvils.
function anvilAura(state, target) {
  const anvils = state.anvils;
  if (!anvils) return 1;
  for (const a of anvils) {
    if (a.owner !== target.owner || a.id === target.id) continue;   // shields allies, never itself
    if (Math.hypot(a.x - target.x, a.y - target.y) <= a.range) return a.mult;
  }
  return 1;
}

// How many of the nearest in-weapon-range enemies attackers fan out across,
// instead of the whole line dogpiling the single closest. This is the softener
// for the focus-fire snowball: spreading damage lets the losing side keep its
// shooters alive longer, so engagements trade instead of ending in a near-wipe
// from a slight edge (Lanchester's square law relaxed toward a linear one).
const SPREAD_TARGETS = 3;

// Still worth holding onto: a live enemy inside this unit's aggro range.
function stillEngageable(state, unit, def, id) {
  const e = getEntity(state, id);
  if (!e || e.hp <= 0) return false;
  const terrainMult = state.map?.terrain ? sampleTerrain(state.map.terrain, unit.x, unit.y).sightMult : 1;
  const aggro = def.aggroRange * sideMod(state, unit.owner, "sightMult") * terrainMult;
  return Math.hypot(e.x - unit.x, e.y - unit.y) <= aggro;
}

// Uphill concealment's acquisition half (mirrors fog.js's reveal(): same UPHILL_FRAC, same "the
// SOURCE'S own tile decides, not the candidate's" rule): an acquirer whose own tile is NOT high
// ground can only find (or hold) an enemy standing on high ground within UPHILL_FRAC of the
// normal range — beyond that, the ridge is as blind to weapons as it is to fog. Computed once per
// acquirer (via the `acquirerHigh` flag callers pass in — one sampleTerrain call, not one per
// candidate) and applied only to a CANDIDATE that itself sits on high ground; open/rough ground
// targets, and any target when the acquirer is itself on high ground, use the plain `range`.
function highGroundCap(terrain, acquirerHigh, e, range) {
  if (acquirerHigh || !terrain) return range;
  return sampleTerrain(terrain, e.x, e.y) === TERRAIN[2] ? range * UPHILL_FRAC : range;
}

function nearestEnemy(state, entities, unit, maxRange) {
  const terrain = state.map?.terrain;
  const acquirerHigh = !!(terrain && sampleTerrain(terrain, unit.x, unit.y) === TERRAIN[2]);
  let best = null, bestD = Infinity;
  for (const e of entities) {
    if (e.owner === unit.owner || e.hp <= 0) continue;   // hp>0 also skips stale dead refs a grid bucket may still hold
    const d = Math.hypot(e.x - unit.x, e.y - unit.y);
    const cap = highGroundCap(terrain, acquirerHigh, e, maxRange);
    if (d <= cap && d < bestD) { bestD = d; best = e; }
  }
  return best ? { id: best.id, d: bestD } : null;
}

// Like nearestEnemy, but once several enemies are within weapon range it fans
// this unit onto one of the SPREAD_TARGETS nearest (chosen by a per-unit hash),
// rather than everyone locking the single closest. Still returns the plain
// nearest while closing in (nothing in weapon range yet), so units approach
// together and only spread once they can actually fire. Combined with the
// target stickiness in updateCombat, each attacker commits to its own target.
function spreadEnemy(state, entities, unit, def, aggro) {
  // The local engagement band — a bit past weapon range so it catches the front
  // line even in a tight melee, where almost no one has 2+ foes strictly within
  // their (often short) weapon range at once. Spreading across this band is what
  // actually reduces the dogpile.
  const band = def.range + 60;
  const terrain = state.map?.terrain;
  const acquirerHigh = !!(terrain && sampleTerrain(terrain, unit.x, unit.y) === TERRAIN[2]);
  let nearest = null, nearestD = Infinity;
  const local = [];
  for (const e of entities) {
    if (e.owner === unit.owner || e.hp <= 0) continue;
    const dx = e.x - unit.x, dy = e.y - unit.y;
    // Squared-distance pre-reject — see REJECT_SLACK in engine/grid.js.
    // Conservative against the cap below because highGroundCap only ever
    // SHRINKS the reach it is given (to UPHILL_FRAC of it), never widens it —
    // so anything past `aggro` is past every cap. This also skips the
    // per-candidate sampleTerrain inside highGroundCap for the rejects.
    if (dx * dx + dy * dy > aggro * aggro * REJECT_SLACK) continue;
    const d = Math.hypot(dx, dy);
    if (d > highGroundCap(terrain, acquirerHigh, e, aggro)) continue;
    if (d < nearestD) { nearestD = d; nearest = e; }
    if (d <= highGroundCap(terrain, acquirerHigh, e, band)) local.push({ e, d });
  }
  if (!nearest) return null;
  if (local.length <= 1) return { id: nearest.id, d: nearestD };   // approaching, or a lone foe — just take nearest
  local.sort((a, b) => a.d - b.d || (a.e.id < b.e.id ? -1 : 1));   // stable, deterministic order
  const pick = local[hashStr(unit.id) % Math.min(local.length, SPREAD_TARGETS)];
  return { id: pick.e.id, d: pick.d };
}

// Default policy is nearest-of-anything, with exact ties going to units
// (they're scanned first, so an equal-distance building never displaces a
// unit already chosen). prefersBuildings flips that for siege: shell
// structures inside aggro even when a unit stands closer, falling back to
// the nearest unit only when no building is in range.
function acquireTarget(state, unit, def) {
  // The same sight modifier that scales fog reveal also scales how far a unit
  // (or turret) reaches out to acquire — so a storm-shortened world bites both
  // sides' aggro symmetrically. Optional-chained for map-less test states.
  // Terrain folds in the same way fog.js's updateFog scales reveal by the source
  // tile's sightMult (srcMult there): a unit standing on high ground acquires (and,
  // via stillEngageable below, holds) targets out to the same extended radius it can
  // see, not just the flat aggroRange — a held mesa is dangerous to approach, not just
  // hard to sneak up on. Turrets share this path (updateBuildingCombat calls this too),
  // so a Sentinel Turret on high ground gets the same reach.
  const terrainMult = state.map?.terrain ? sampleTerrain(state.map.terrain, unit.x, unit.y).sightMult : 1;
  const aggro = def.aggroRange * sideMod(state, unit.owner, "sightMult") * terrainMult;
  // Units through the broad-phase grid (there can be hundreds); buildings stay a
  // straight scan since there are only ever a handful. Full-scan fallback when
  // no grid is present (direct combat tests). Both nearestEnemy/spreadEnemy apply
  // uphill concealment's acquisition half internally (highGroundCap above) — the
  // mesa's extra reach cuts both ways: it sees farther, but a lowland unit still
  // can't shoot back at it past UPHILL_FRAC of that same reach.
  // _acquireBuf, not the shared default: this array is handed on to spreadEnemy
  // to iterate, so it stays live across a call into other code. Owning the
  // buffer is what makes that safe no matter what spreadEnemy grows into.
  const unitCandidates = state.unitGrid
    ? queryNeighbors(state.unitGrid, unit.x, unit.y, aggro, undefined, _acquireBuf)
    : state.units.values();
  const u = spreadEnemy(state, unitCandidates, unit, def, aggro);
  const b = nearestEnemy(state, state.buildings.values(), unit, aggro);
  if (def.prefersBuildings && b) return b.id;
  if (!u) return b ? b.id : null;
  if (!b) return u.id;
  return u.d <= b.d ? u.id : b.id;
}

// Static defense: a completed building with an attack stat (Sentinel
// Turret) acquires and fires like a unit that can never move — it only
// engages inside its own range (aggroRange === range by definition) and
// never chases. Buildings have no order pipeline, so there is no
// player-directed focus fire; nearest-enemy is the whole policy.
export function updateBuildingCombat(state, building, dt) {
  const def = BUILDINGS[building.type];
  if (!def.attack) return;
  if (building.constructing) { building.targetId = null; return; }

  building.attackTimer = Math.max(0, building.attackTimer - dt);
  building.targetId = acquireTarget(state, building, def);
  if (!building.targetId || building.attackTimer > 0) return;

  const target = getEntity(state, building.targetId);
  // Same live-target guard the mobile updateCombat path applies before firing: the
  // acquired target may have been removed or dropped to hp<=0 between acquire and
  // now (a stale/tampered targetId, or a future reorder of the tick), so re-check it
  // exists and is alive — otherwise performAttack would deref undefined / NaN-poison
  // hp. Identity for valid data: a freshly acquired target is always live.
  if (!target || target.hp <= 0) return;
  // Ammo-fed static defense (the Torpedo Battery, entities.js def.ammo): real logistics paid
  // in a manufactured commodity a worker hauls in (engine/haul.js), not a free-fire structure —
  // a dry magazine holds fire rather than shooting for nothing. Still acquires/tracks a target
  // above (so it visibly trains on the threat), it just won't spend a cooldown on an empty gun;
  // the very next tick re-checks, so it fires the instant a hauler tops the larder back up.
  // A no-op for every ammo-less def (turret/bastille/…), so their firing is untouched.
  if (def.ammo && (building.input?.[def.ammo.com] || 0) < def.ammo.perShot) return;
  performAttack(state, building, def, target);
  building.attackTimer = def.cooldown;
  if (def.ammo) building.input[def.ammo.com] -= def.ammo.perShot;
}
