/* ============================================================
   The Helium Bomb (engine/entities.js UNITS.heliumbomb): a mobile doomsday
   device, built unarmed — free to move without risk. Once the player ARMS it
   (a direct field flip, `bomb.armed = true`, the same pattern hudSelection.js
   already uses for the Mender's auto-repair toggle), one of three triggers
   sets it off:
     - it takes a hit at all (combat.js's performAttack calls detonateIfAttacked
       before applying normal damage) — an impact fuze, instantaneous,
     - a live enemy unit or building comes within BOMB_DETECT_RANGE (checked
       once per tick from engine/sim.js via updateBombFuse) — lights the fuse,
     - the player manually triggers it ("Detonate Now" in hudSelection.js,
       which calls lightFuse) — also lights the fuse, not an instant blast.
   The two fuse-based triggers don't detonate on the spot: lightFuse just
   timestamps when the blast is due (BOMB_FUSE_DELAY sim-seconds later), and
   updateBombFuse (engine/sim.js, every tick) is what actually calls
   detonateBomb() once that time comes — a real window for the enemy that
   tripped it, or anything standing in the blast, to react. Being attacked
   stays instantaneous by design: it's a defensive reflex, not a timed device.
   Every path that DOES fire the actual blast funnels through detonateBomb()
   so they can never disagree about what it does. An UNARMED bomb ignores all
   three — it can be shot, stood next to, or driven right up to a base with no
   effect, exactly like any other unit — so arming is a deliberate, reversible
   (see disarm in hudSelection.js, which also cuts a lit fuse) commitment, not
   an inherent property of the unit.

   The blast radius is deliberately tied to POWER_TIERS[0] (engine/industry.js)
   — the same "on-grid" ring every Reactor/Generator projects — rather than an
   independent magic number: the bomb's damage reaches exactly as far as a
   power station's innermost efficiency zone, so the number on the tooltip can
   never silently drift from what the power-grid UI already shows the player.

   DAMAGE FALLOFF: the blast isn't a flat "erase everything inside the
   radius" cutoff — HP loss decays with the square of distance from ground
   zero (bombDamageAt below), same shape as a real blast's inverse-square
   falloff. Distance is measured to each caught entity's RIM, not its center
   (rimDistance below) — so a big building's own footprint doesn't stand
   between it and the peak band: at physical contact, a Gate or Command
   Center's hull IS inside BOMB_CORE_RADIUS, not 36-38 units short of it the
   way raw center-to-center distance would read it. The curve itself is still
   referenced against BOMB_CORE_RADIUS (1.5x the bomb's own footprint) rather
   than the true center, since 1/d^2 diverges as d->0; inside that "unitary
   distance" everything takes the same peak hit (BOMB_MAX_DAMAGE, enough to
   one-shot even the toughest building in the game), and it tapers off from
   there out to zero at BOMB_BLAST_RADIUS. So ground zero is still an
   indiscriminate kill, but a lightly-built unit caught out near the edge may
   only take a scratch instead of vanishing outright.

   TERRAFORMING: a detonation doesn't just erase — it also schedules a crater
   (state.craters) at the blast center. Once CRATER_SPAWN_DELAY of sim time
   passes, updateCraters (called every tick from engine/sim.js) turns it into
   a real, mineable ResourceNode, exactly like any node engine/map.js
   generates — gather.js, the fog/discovery rules, and the rendering all need
   zero special-casing for it, because it's a plain node once it exists. The
   commodity is chosen deterministically (hashStr off the crater's own id, the
   sim's only sanctioned source of pseudo-randomness besides the seeded RNG —
   see engine/rng.js) from every RAW-tier commodity, not just the ones this
   planet's deposit table naturally rolled — the blast synthesizes a deposit
   that wouldn't otherwise be here, which is the whole point of paying to
   "terraform" a spot rather than just scouting for one.

   WRECKAGE: separately from the crater, every unit/building the blast actually
   kills also deposits its own battle wreckage (engine/wreckage.js), exactly
   like an ordinary combat kill — the two stack, so a detonation leaves both
   the bomb's synthesized crater AND ordinary wreckage from everything caught
   in it.
   ============================================================ */

"use strict";

import { radiusOf } from "./colliders.js";
import { UNITS } from "./entities.js";
import { POWER_TIERS } from "./industry.js";
import { removeEntity } from "./state.js";
import { hashStr } from "./rng.js";
import { depositWreckage } from "./wreckage.js";
import { COM } from "../data.js";

// The power station's "first circle": POWER_TIERS[0] is the innermost,
// on-grid efficiency band every Reactor/Generator projects. Nothing this far
// out (or beyond) takes any blast damage at all.
export const BOMB_BLAST_RADIUS = POWER_TIERS[0].max;

// The falloff curve's "unitary distance": 1.5x the bomb unit's own radius
// (engine/entities.js). Derived, not a separate magic number, so it can
// never drift out of proportion to the unit it's describing. Everything at
// or inside this distance takes the full BOMB_MAX_DAMAGE hit — an inverse-
// square curve diverges as distance approaches zero, so it has to be capped
// somewhere, and this is the natural "ground zero" radius to cap it at.
export const BOMB_CORE_RADIUS = UNITS.heliumbomb.radius * 1.5;

// How close a live enemy has to come before an ARMED bomb lights its fuse on
// its own — the same 1.5x-radius "point-blank" distance the damage falloff
// itself is anchored to (BOMB_CORE_RADIUS), not a separate magic number: if
// you're already standing close enough to take full damage, you're close
// enough to have set it off.
export const BOMB_DETECT_RANGE = BOMB_CORE_RADIUS;

// Peak HP loss at/inside BOMB_CORE_RADIUS — comfortably past the toughest
// building in the game (the Antimatter Gate, 1200hp) so ground zero still
// reads as an outright kill, same as the old flat-erasure blast.
export const BOMB_MAX_DAMAGE = 3000;

// HP lost to the blast at `dist` from ground zero: flat BOMB_MAX_DAMAGE out
// to BOMB_CORE_RADIUS, then falling off with the square of distance the rest
// of the way to BOMB_BLAST_RADIUS (0 beyond it). A pre-baked lookup table
// isn't worth it here — this only ever runs once per detonation, over the
// handful of entities caught in range, never per-frame — so the curve is
// just computed directly rather than approximated.
export function bombDamageAt(dist) {
  if (dist > BOMB_BLAST_RADIUS) return 0;
  const d = Math.max(dist, BOMB_CORE_RADIUS);
  return BOMB_MAX_DAMAGE * (BOMB_CORE_RADIUS / d) ** 2;
}

// How long (sim seconds — state.time, not wall clock) an armed bomb spends
// "cooking" after its fuse is lit — by an enemy coming within
// BOMB_DETECT_RANGE, or the player's own "Detonate Now" command — before the
// actual blast (detonateBomb) goes off. A real window to react instead of the
// old instant, unavoidable detonation. Being attacked is a separate trigger
// (detonateIfAttacked below) and stays instantaneous, unaffected by this.
export const BOMB_FUSE_DELAY = 4;

// How long (sim seconds — state.time, not wall clock) after a detonation the
// crater takes to mature into a mineable deposit.
export const CRATER_SPAWN_DELAY = 60;
// The fresh deposit's size — comparable to a real surface cluster (see
// engine/map.js's deposit amounts), a solid payoff for the strategic goods
// and risk the detonation itself cost.
export const CRATER_NODE_AMOUNT = 400;
// Every commodity a crater can turn up — ALL Raw-tier goods (data.js COM),
// not just what this planet's own deposit table naturally rolled.
export const CRATER_COMMODITIES = Object.keys(COM).filter(id => COM[id].tier === "Raw");

function isBomb(e) {
  return !!e && e.kind === "unit" && UNITS[e.type]?.role === "bomb";
}

// `e`'s own radius — a building carries it directly on the instance (state.js's makeBuilding

// Distance from the bomb's center to `e`'s RIM, not its center — max(0, ...) so an entity whose
// footprint already overlaps the bomb (or contains it) reads as point-blank, never negative. This
// is the fix behind the header's one-shot claim: raw center-to-center distance used to count a big
// building's own radius AGAINST it, putting even physical wall contact outside BOMB_CORE_RADIUS.
function rimDistance(e, bomb) {
  return Math.max(0, Math.hypot(e.x - bomb.x, e.y - bomb.y) - radiusOf(e));
}

// Detonate `bomb` right now, unconditionally — the ONE place the blast itself
// happens, so every trigger produces the exact same result. Every unit and
// building within BOMB_BLAST_RADIUS of the bomb's center (measured to each
// one's own RIM, not its center — rimDistance above), ANY owner included (the
// bomb's own side's units and buildings, and the bomb itself, are not
// exempt), takes bombDamageAt(dist) HP loss and dies (outright removed, and —
// same as an ordinary combat kill — deposits its own wreckage,
// engine/wreckage.js) if that drops it to 0 or below; anything too far out to
// be reduced to 0 just survives, scarred. Snapshots
// the caught set with its distances before removing anything, so the sweep
// can't be thrown off by entities disappearing mid-scan. One bombDetonated
// event drives the explosion VFX + sound (boot.js/effects.js/sound.js); each
// killed entity still gets its own entityKilled event so the ordinary
// death-flash plays across the whole blast.
export function detonateBomb(state, bomb) {
  if (!bomb || bomb.hp <= 0) return;   // already gone — e.g. two triggers fired the same tick

  const caught = [];
  for (const u of state.units.values()) {
    const dist = rimDistance(u, bomb);
    if (dist <= BOMB_BLAST_RADIUS) caught.push({ e: u, dist });
  }
  for (const b of state.buildings.values()) {
    const dist = rimDistance(b, bomb);
    if (dist <= BOMB_BLAST_RADIUS) caught.push({ e: b, dist });
  }

  for (const { e, dist } of caught) {
    e.hp -= bombDamageAt(dist);
    if (e.hp <= 0) {
      depositWreckage(state, e);
      removeEntity(state, e.id);
      // unitType/kind (docs/improvement-proposals.md "Tiered destruction"): same additive fields
      // engine/combat.js's own entityKilled pushes carry, so a blast's casualties get the same
      // size-scaled death ring/sound as an ordinary kill, not the flat default.
      state.events.push({ type: "entityKilled", id: e.id, x: e.x, y: e.y, owner: e.owner, unitType: e.type, kind: e.kind });
    }
  }
  state.events.push({
    type: "bombDetonated", x: bomb.x, y: bomb.y,
    radius: BOMB_BLAST_RADIUS, coreRadius: BOMB_CORE_RADIUS, owner: bomb.owner,
  });

  // Schedule the crater. Named off the bomb's own (globally-unique, module-global-minted)
  // id rather than a fresh counter, so it can never collide with a map-generated node's
  // "n<N>" id scheme — the two id spaces are namespaced apart by construction.
  (state.craters || (state.craters = [])).push({
    id: `crater-${bomb.id}`, x: bomb.x, y: bomb.y, owner: bomb.owner,
    spawnAt: state.time + CRATER_SPAWN_DELAY,
  });
}

// Per-tick check (engine/sim.js, once per tick — not per-unit): matures every pending
// crater whose timer has come due this tick (there can be more than one; nothing staggers
// them). Mutates state.craters/state.map in place; nothing to return.
export function updateCraters(state) {
  if (!state.craters || !state.craters.length) return;
  const ready = state.craters.filter(c => state.time >= c.spawnAt);
  if (!ready.length) return;
  state.craters = state.craters.filter(c => state.time < c.spawnAt);
  for (const crater of ready) spawnCraterNode(state, crater);
}

// Turn one matured crater into a real, plain ResourceNode (engine/types.js) — indistinguishable
// to gather.js/rendering/fog from anything engine/map.js generated, except for the `crater: true`
// tag persist.js uses to know it needs full serialization (a map-generated node only ever needs
// its `amount` saved; this one doesn't exist in the seed-regenerated map at all, so it needs its
// whole shape saved and re-added on load — see persist.js's rehydratePlanet). The commodity is
// picked deterministically off the crater's own id: same crater, same roll, every time, on every
// machine — no engine randomness involved (engine-purity.test.js).
function spawnCraterNode(state, crater) {
  const com = CRATER_COMMODITIES[hashStr(crater.id) % CRATER_COMMODITIES.length];
  const node = {
    id: crater.id, com, amount: CRATER_NODE_AMOUNT, max: CRATER_NODE_AMOUNT,
    x: crater.x, y: crater.y, crater: true,
  };
  state.map.nodes.push(node);
  if (state.map.nodesById) state.map.nodesById.set(node.id, node);
  state.events.push({ type: "craterMatured", x: crater.x, y: crater.y, com, owner: crater.owner });
}

// If `target` is an ARMED Helium Bomb, being hit AT ALL — regardless of how
// much damage the shot would have dealt — sets it off instead of chipping
// its hp. Called from combat.js's performAttack before the normal damage/
// death path runs. Returns whether it detonated, so the caller can
// short-circuit (the normal hp/wreckage/entityKilled bookkeeping doesn't
// apply — detonateBomb already erased it, along with everything else caught,
// and already deposited its wreckage itself).
// Unlike the other two triggers, this one is instantaneous — no fuse.
export function detonateIfAttacked(state, target) {
  if (!isBomb(target) || !target.armed) return false;
  detonateBomb(state, target);
  return true;
}

// Lights `bomb`'s fuse: BOMB_FUSE_DELAY sim-seconds from now, updateBombFuse
// will detonate it — no matter what else happens to it between now and then.
// Idempotent: re-triggering an already-lit fuse (another enemy wanders into
// range, "Detonate Now" pressed again) does NOT restart the clock. Fires a
// bombFused event (once, the moment it's actually lit) so the VFX/sound layer
// can warn the player something is about to go off, and where.
export function lightFuse(state, bomb) {
  if (bomb.fuseUntil != null) return;
  bomb.fuseUntil = state.time + BOMB_FUSE_DELAY;
  state.events.push({ type: "bombFused", x: bomb.x, y: bomb.y, owner: bomb.owner, delay: BOMB_FUSE_DELAY });
}

// Per-tick check for an ARMED bomb: is any live enemy unit or building within
// BOMB_DETECT_RANGE of its RIM, not its center (rimDistance above — the same
// measure detonateBomb uses, so "close enough to trip the fuse" and "close
// enough to take full damage" never disagree on a big hull)? Lights the fuse
// (see lightFuse) rather than detonating outright. Called from updateBombFuse
// below; also safe to call standalone (e.g. tests) since lightFuse is
// idempotent either way.
export function checkBombProximity(state, bomb) {
  if (!bomb.armed || bomb.fuseUntil != null) return false;
  for (const u of state.units.values()) {
    if (u.owner === bomb.owner || u.hp <= 0) continue;
    if (rimDistance(u, bomb) <= BOMB_DETECT_RANGE) { lightFuse(state, bomb); return true; }
  }
  for (const b of state.buildings.values()) {
    if (b.owner === bomb.owner || b.constructing) continue;
    if (rimDistance(b, bomb) <= BOMB_DETECT_RANGE) { lightFuse(state, bomb); return true; }
  }
  return false;
}

// Per-tick update for an ARMED bomb (engine/sim.js, once per role:"bomb" unit,
// before its normal per-tick update): if the fuse is already lit, detonates
// it the instant state.time reaches bomb.fuseUntil; otherwise runs the
// proximity check, which may light it. Returns whether the bomb is
// "committed" this tick — fused (about to blow, or just did) — so sim.js can
// skip the rest of the tick's update for it: once lit, a bomb no longer takes
// orders, same as it never did in the old instant-detonate world.
export function updateBombFuse(state, bomb) {
  if (!bomb.armed) return false;
  if (bomb.fuseUntil != null) {
    if (state.time >= bomb.fuseUntil) detonateBomb(state, bomb);
    return true;
  }
  return checkBombProximity(state, bomb);
}
