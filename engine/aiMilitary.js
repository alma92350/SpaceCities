/* ============================================================
   AI — the military brain: defend a pressed base, else muster and commit the
   next wave (aiMilitary / aiOffense), optional tactical focus-fire and the
   scout sweep, plus the target/mix helpers (chooseAttackTarget, raidTarget,
   pickNextUnitType and the counter-pick). Depends on aiCommon (action budget +
   owner resolution) and aiWorkers (effectiveMix); nothing in aiEconomy/aiIndustry
   depends back on it except through the exported pickNextUnitType, so there's no
   import cycle.

   OWNER-GENERIC (Tier 1 self-play, tools/selfplay.js): every function here that
   reacts to "the enemy" now takes (or reads off ctx) an `owner` — the side THIS
   call is deciding for — and resolves its opponent and its OWN fog from that,
   via engine/aiCommon.js's otherOwner/controllerFor. Every exported function
   defaults `owner` to "ai", so every pre-existing call site (every test, every
   other engine file, tools/ailab.js) reads exactly as before; only engine/ai.js's
   runAI(state, dt, owner) ever passes a different owner, and only when Tier 1
   self-play has populated state.playerAi. Never state.fogAI, never an unfogged
   raw-state read, for either side — that fog discipline is the single most
   important property of this whole module.
   ============================================================ */

"use strict";

import { UNITS, BUILDINGS } from "./entities.js";
import { issueAttackMove, issueMove } from "./commands.js";
import { isVisibleAt, isExploredAt, nearestUnexploredPoint } from "./fog.js";
import { hostility, provoked } from "./diplomacy.js";
import { chargingPlayerWonder } from "./wonder.js";
import { canAct, spend, controllerFor, opponentsOf } from "./aiCommon.js";
import { effectiveMix } from "./aiWorkers.js";
import { playerUnits, playerBuildings } from "./state.js";
import { difficultyFor, adaptivityFor } from "./aiDifficulty.js";
// The opponent READ (docs/ai-adaptive-opponent.md). aiIntel imports only entities/fog/aiCommon,
// so this stays a downward edge with no cycle — the same discipline aiWorkers/aiStrategy keep.
import { enemyIsGreedy } from "./aiIntel.js";
import { formationSlots } from "./formation.js";

const COUNTER_EVERY = 3;   // default cadence: 1 in every 3 units built reacts to the player's army instead of following the mix — difficulty-shaped via aiDifficulty.js's counterEvery (Easy 0, Hard 2), see pickNextUnitType

// Derived once from each unit's bonusVs table (entities.js), rather than
// hardcoded here, so this stays correct automatically if the roster or
// its counter relationships ever change: COUNTER_OF['lancer'] === 'skiff'
// means Skiff is the type that holds bonus damage against Lancer. Also folds
// in each out-of-triangle unit's own optional `counteredBy` (entities.js) —
// not a new bonusVs, just data: the cost-efficiency answer test/balance.test.js
// certifies with a real duel, so COUNTER_OF covers the whole roster while
// staying data-derived, never hardcoded here.
const COUNTER_OF = Object.values(UNITS).reduce((map, def) => {
  if (def.bonusVs) for (const targetType of Object.keys(def.bonusVs)) map[targetType] = def.id;
  if (def.counteredBy) map[def.id] = def.counteredBy;
  return map;
}, {});

// Curated fallback for whatever COUNTER_OF still misses — sourced from each
// unit's own design-doc comment (entities.js) / README.md, not invented: this
// teaches the AI the cost-efficiency answer the design text already states, no
// new bonus damage anywhere. Deliberately overlaps COUNTER_OF's counteredBy
// entries above (breacher/dreadnought/wraith/colossus -> skiff): COUNTER_OF
// wins whenever both exist, so this stays a defensive fallback that keeps
// working even if a unit's counteredBy is ever removed, and it's the ONLY
// source for the Odyssey-only Leviathan, which has no counteredBy of its own.
const SOFT_ANSWER = {
  breacher: "skiff", dreadnought: "skiff", colossus: "skiff", leviathan: "skiff",
  wraith: "skiff", aegis: "lancer",
};

const TURRET_WALL_COUNT = 3;   // more visible static defense than this alone reads as a wall — test/balance.test.js's 4-turret line is the proof

const PROBE_MIN = 3;              // Odyssey: smallest wave a wary neighbour sends — it harasses, never doomstacks
const WAVE_CADENCE_FRAC = 0.3;    // Odyssey: probe spacing as a fraction of attackTimeout, tightening with hostility

// DEFENSE first: if enemy combat is seen pressing a building, recall the army (bar the scout) to meet it. Otherwise OFFENSE: retreat a ground-down wave, then muster and commit the next one (skirmish armyAttackSize, or an Odyssey hostility-paced probe).
/** @param {State} state @param {AiContext} ctx */
export function aiMilitary(state, ctx) {
  const { army, threats, controller } = ctx;
  // DEFENSE first: if the AI can SEE enemy combat units pressing one of its
  // buildings, the whole army (bar the scout) drops what it's doing and rushes
  // that spot — including units already committed forward. This is the recall
  // that makes "absorb the wave, then counter" no longer a free win: hit the
  // AI's base and it brings its force home to meet you, instead of marching on
  // regardless while its economy burns. Exempt from the APM budget, same as the
  // attack commit, so a slow AI still always defends. Once the threat clears
  // vision, the army re-forms at home and the offensive logic below takes over.
  const nonScout = army.filter(u => u.id !== controller.scoutId);
  if (threats.length > 0) {
    if (nonScout.length > 0) {
      const focus = threatCentroid(threats);
      if (controller.micro && nonScout.length > threats.length * 2) {
        // FEINT-RESISTANT (Tactical): a small poke can no longer yank the whole
        // army out of position. Commit only a proportionate defence — the closest
        // units, ~2x the seen threat — and leave the rest on their assignment, so
        // a one-unit feint costs the AI a couple of defenders, not its whole push.
        // A genuinely large attack (threat >= half the army) falls through to the
        // full recall below. Tactical-only, and a passive player never threatens,
        // so the resolves-to-a-winner guarantee is untouched.
        const need = Math.min(nonScout.length, threats.length * 2 + 1);
        const defenders = nonScout.slice()
          .sort((a, b) => Math.hypot(a.x - focus.x, a.y - focus.y) - Math.hypot(b.x - focus.x, b.y - focus.y))
          .slice(0, need);
        issueAttackMove(defenders, focus.x, focus.y);
      } else {
        issueAttackMove(nonScout, focus.x, focus.y);   // Standard (or a serious attack): the whole army rushes home
      }
    }
  } else {
    aiOffense(state, ctx, nonScout);
  }
}

// OFFENSE: retreat a ground-down, non-desperation wave that's still facing live opposition, then
// muster and commit the next one. Two regimes split on state.diplomacy: SKIRMISH musters
// armyAttackSize (throwing everything on the desperation timeout — the resolves-to-a-winner path);
// ODYSSEY paces escalating probes by hostility. Always keeps a home guard unless it's a timeout commit.
//
// The archetype's own attackTimeout/armyAttackSize/garrison are scaled by the player-picked
// STRATEGY (engine/aiStrategy.js) before any of the logic below reads them — attackTimeout/
// armyAttackSize/garrison stay archetype fields (unmodified), effAttackTimeout/effArmyAttackSize/
// effGarrison are what this function actually uses. A "default" strategy's multipliers are all
// 1 (`|| 1` below), so this is a no-op until a match actually opts into one.
/** @param {State} state @param {AiContext} ctx @param {Unit[]} nonScout */
function aiOffense(state, ctx, nonScout) {
  const { buildings, archetype, strategy, owner, enemyOwner, fog, controller } = ctx;
  const effAttackTimeout = archetype.attackTimeout * (strategy.attackTimeoutMult || 1);
  const effArmyAttackSize = archetype.armyAttackSize * (strategy.armyAttackSizeMult || 1);
  const effGarrison = Math.round((archetype.garrison || 0) * (strategy.garrisonMult != null ? strategy.garrisonMult : 1));
    // OFFENSE. "Home" army is whatever hasn't already been sent off to attack —
    // a freshly produced or still-idle unit has order null/'move' (its walk to
    // the rally point), while a committed one is mid attack-move (see combat.js).
    // Filtering on that means each new batch automatically forms the next wave
    // once the threshold is met again, so the AI keeps attacking in waves.
    const homeArmy = nonScout.filter(u => !u.order || u.order.type === "move");
    const attackers = nonScout.filter(u => u.order && u.order.type === "attack-move");
    const cc = buildings.find(b => b.type === "command" && !b.constructing) || buildings[0];

    // RETREAT: a committed, non-desperation attack that's been ground down to a
    // fraction of what was sent — and is STILL facing live opposition — pulls its
    // survivors home instead of feeding the last of them into a lost fight. So an
    // engagement trades (both sides keep a remnant) rather than ending in a wipe,
    // and the saved veterans re-form into the next wave. Two guards preserve the
    // resolves-to-a-winner guarantee: a desperation (timeout) commit never
    // retreats, and a retreat only fires while the AI can SEE enemy combat units
    // near the fight — so against an undefended base (every headless resolve
    // test) it never triggers and the AI razes the base exactly as before.
    if (!controller.attackDesperate && controller.attackForce > 0 && attackers.length > 0
        && attackers.length < controller.attackForce * RETREAT_FRACTION && cc) {
      const focus = threatCentroid(attackers);
      if (visibleEnemyCombatNear(state, owner, focus.x, focus.y, RETREAT_SIGHT) >= attackers.length) {
        issueMove(attackers, cc.x, cc.y);   // plain move disengages: combat.js skips auto-acquire on a 'move' order
        controller.attackForce = 0;
      }
    }

    const nextAttackAt = controller.nextAttackAt ?? effAttackTimeout;
    const timedOut = state.time >= nextAttackAt;

    // Build this cycle's strike force. Two regimes, split on whether this world has
    // an Odyssey neighbour (state.diplomacy):
    //  • SKIRMISH (no diplomacy) — byte-for-byte as before: muster armyAttackSize,
    //    or throw everything on the desperation timeout (the resolves-to-a-winner
    //    path). A home guard is kept unless it's a timeout commit.
    //  • ODYSSEY — a hostility ramp (diplomacy.js). At peace (h===0) it holds fire;
    //    once wary it probes on a cadence with a small slice; as the stance sinks
    //    toward fully hostile the muster, the committed fraction and the cadence all
    //    climb, so a banked army bleeds out in escalating waves — never one doomstack.
    //
    // strategy.neverInitiates (Economic / Force-Parity — aiStrategy.js) guards EVERY
    // voluntary commit, INCLUDING the skirmish desperation timeout: a strategy whose
    // whole point is "never attacks unprovoked" must mean that literally, or a genuinely
    // passive player still eventually eats an unexplained all-in wave — which is exactly
    // the bug this guards against (a real player report: an Economic AI "raided" a player
    // who'd built nothing but a scout, purely because enough time had passed). The
    // resolves-to-a-winner guarantee still holds for a mutual-turtle skirmish: victory.js's
    // score-based DEFAULT_MATCH_TIME_LIMIT (40 minutes) settles it without requiring combat
    // — see the "score, not combat" test in test/aiStrategy.test.js. Odyssey never needed a
    // timeout here at all (a world doesn't require combat to resolve), so this is the one
    // regime where the guard is new.
    //
    // playerHasPresence guards the Odyssey commit the same way: the living galaxy
    // instantiates every world from turn one, but a world the player hasn't reached yet
    // starts with zero player units or buildings (engine/galaxy.js addPlanet's `unsettled`
    // seeding). Its diplomacy still drifts to war on its own (scarcity, late-game creep),
    // so without this guard the neighbour would muster and commit waves at chooseAttackTarget's
    // empty fallback coordinate forever — production spent chasing nobody. Skirmish is
    // untouched (it never reaches this branch), and the guard clears the moment the player
    // has anything at all here, so a real expedition still gets fought over normally.
    let strike = [], desperate = false;
    if (cc) {
      if (!state.diplomacy) {
        const readyToAttack = !strategy.neverInitiates && (timedOut || homeArmy.length >= effArmyAttackSize);
        if (homeArmy.length > 0 && readyToAttack) {
          strike = withoutHomeGuard(homeArmy, cc, timedOut ? 0 : effGarrison);
          desperate = timedOut;
        }
      } else if ((!strategy.neverInitiates || provoked(state)) && playerHasPresence(state, enemyOwner)) {
        // ODYSSEY only: neverInitiates means "doesn't START fights", not "never fights" — a
        // neighbour the player has bled (or who can see a galaxy-winning Gate charging) answers
        // once its stance has reached war on its own. Without this, two of the four strategies
        // could never attack at all, and neighbourAiProfile hands one of those to roughly half
        // the galaxy: worlds that read Hostile in the HUD and sent nothing, ever
        // (docs/odyssey-ai-review.md §2.1). The skirmish branch above is untouched — it has no
        // state.diplomacy, so provoked() is false there and the flag stays absolute.
        const h = hostility(state);
        const pm = (archetype.odyssey && archetype.odyssey.probeMin) || PROBE_MIN;   // archetype's Odyssey probe floor (Rusher 5 > Economist 4 > default 3)
        const muster = Math.max(pm, Math.round(effArmyAttackSize * h));
        const waveReady = state.time >= (controller.nextWaveAt ?? 0);
        if (h > 0 && waveReady && homeArmy.length >= muster) {
          const available = withoutHomeGuard(homeArmy, cc, effGarrison);   // always hold the home guard
          const commit = Math.min(available.length, Math.max(pm, Math.round(available.length * h)));
          strike = available.slice(available.length - commit);   // send the forward-most; the rest reinforce
        }
      }
    }

    if (strike.length > 0) {
      // ECONOMY RAID (Tactical): every RAID_EVERY-th wave, if it can see the
      // player's worker line, this one goes for the economy instead of grinding the
      // defended main base — sniping production the way a human harasses. A
      // desperation (timeout) commit always goes for the base so the game resolves.
      controller.waveCount = (controller.waveCount || 0) + 1;
      // ODYSSEY FINALE: once the AI can SEE the player's charging Gate, every wave
      // converges on it — razing the galaxy-ender outranks even an economy raid. Still
      // fog-gated (it has to have eyes on the Gate) and Odyssey-only: in a skirmish
      // state.diplomacy is undefined, so `gate` is falsy and the target pick below is
      // byte-for-byte the original `raid || chooseAttackTarget(...)`.
      const charging = state.diplomacy && chargingPlayerWonder(state);
      const gate = charging && isVisibleAt(fog, charging.x, charging.y) ? charging : null;
      // WHY THIS WAVE RAIDS. Two independent reasons, either of which is enough:
      //
      //   • the CADENCE — every RAID_EVERY-th wave, the original Tactical behaviour, unchanged and
      //     still gated on controller.micro (Hard). A metronome: it harasses on a schedule
      //     regardless of whether harassment is the right answer.
      //   • the READ — the enemy is visibly investing in economy over defence and enough of them
      //     has been scouted to justify acting on it (engine/aiIntel.js enemyIsGreedy). This is
      //     harassment as a RESPONSE: punish greed, and specifically punish the hoarder that
      //     docs/ai-evolution-design.md §9 found winning by never committing its army. An opponent
      //     that can be seen to be undefended should not be safe.
      //
      // The read is deliberately NOT gated on controller.micro. Reacting to what you scouted is
      // ordinary competence, not the unit-level micro Hard buys — and an Easy/Medium AI that never
      // once punishes a greedy opening is the passivity the bench keeps measuring. It IS gated on
      // difficulty's own reactivity dial via adaptReads (engine/aiDifficulty.js), so Easy still
      // plays its learnable, exploitable archetype line — the same argument counterEvery: 0 makes
      // there, applied to targeting instead of composition.
      const cadenceRaid = controller.micro && controller.waveCount % RAID_EVERY === 0;
      // Difficulty scales BOTH whether it reacts at all and how thin the evidence may be: Hard
      // (adaptivity 1.5) commits on a less complete scout than Medium, Easy (0) never does.
      const adapt = adaptivityFor(state, owner);
      const punishRaid = adapt > 0
        && enemyIsGreedy(state, owner, { minConfidence: 0.25 / adapt });
      const raid = !gate && !desperate && (cadenceRaid || punishRaid) && raidTarget(state, owner);
      const target = gate || raid || chooseAttackTarget(state, cc, owner);
      issueAttackMove(strike, target.x, target.y);
      // Cadence: a skirmish keeps the single attackTimeout clock (unchanged);
      // Odyssey paces the NEXT probe by hostility on its own timer — sparse when
      // merely wary, tight when hostile — so the skirmish clock is never touched.
      if (state.diplomacy) {
        controller.nextWaveAt = state.time + effAttackTimeout * WAVE_CADENCE_FRAC * (1 - 0.5 * hostility(state));
      } else {
        controller.nextAttackAt = state.time + effAttackTimeout;
      }
      // Reset the retreat baseline to the whole committed force (survivors of a
      // prior wave plus this reinforcement) so a topped-up wave doesn't read as
      // "ground down".
      controller.attackForce = attackers.length + strike.length;
      controller.attackDesperate = desperate;
    }

    // GARRISON DISPERSAL: whatever's left of the home army after the strike above (everyone, on
    // a cycle with no commit) forms up in a grid just outside the AI's own base — see
    // disperseGarrison below — instead of sitting clumped at whichever building's rally point
    // produced it. Excludes a unit already fighting via auto-acquire (autoTarget/focusId,
    // engine/combat.js) even though it carries no formal order of its own (order:null still
    // auto-engages — only a plain 'move' order suppresses that) — a home-guard unit defending
    // itself in place must never be yanked off that fight mid-engagement to go stand in the grid.
    const strikeIds = new Set(strike.map(u => u.id));
    const toDisperse = homeArmy.filter(u => !strikeIds.has(u.id) && u.autoTarget == null && u.focusId == null);
    disperseGarrison(state, owner, toDisperse, buildings);
}

const GARRISON_SKIRT_CLEARANCE = 40;    // how far past its own outermost building the parked grid sits
const GARRISON_MIN_RING_RADIUS = 160;   // floor for a base that's nothing but a bare Command Center yet
const OWN_BASE_SCAN_RADIUS = 320;       // buildings farther than this from a CC belong to a different base, not this one's footprint
export const STATION_REACH = 30;        // close enough to its own slot that re-issuing the same move order would be a no-op
// A unit farther than this from EVERY Command Center isn't "home" yet — a stray unit deep in
// contested or enemy territory (a retreat straggler, a unit some other mechanism dropped there)
// must never get yanked partway across the map onto the grid; it should keep doing whatever
// auto-acquire/self-defense it's already doing right where it stands. Comfortably past the AI's
// own build cluster (every AI building sits within ~250 of its own CC, engine/aiEconomy.js's fixed
// offsets) plus the garrison grid itself, with real slack — nowhere near far enough to reach
// across a normal map to the player's side.
const DISPERSAL_HOME_RADIUS = 600;

// How far this CC's own buildings actually reach — the true edge of its base, not a guess. Only
// buildings within OWN_BASE_SCAN_RADIUS of THIS cc count (mirroring the same "belongs to the
// nearest CC" rule the garrison units themselves get sorted by, below), so a second, distant
// expansion's turrets can't inflate the first base's footprint. Floors at
// GARRISON_MIN_RING_RADIUS for a base that's nothing but its Command Center so far, and stays
// inside DEFEND_RADIUS (with STATION_REACH of slack) so an attack on the parked army still
// triggers the normal recall (visibleThreatsNearHome, below) no matter how sprawling the base
// has grown — the same invariant the old fixed 220-radius ring relied on, just no longer capable
// of landing INSIDE a heavily fortified base's own turret line the way a fixed radius could once
// a base outgrew it.
function baseFootprintRadius(cc, buildings) {
  let radius = GARRISON_MIN_RING_RADIUS;
  for (const b of buildings) {
    if (b === cc) continue;
    const d = Math.hypot(b.x - cc.x, b.y - cc.y);
    if (d > OWN_BASE_SCAN_RADIUS) continue;
    radius = Math.max(radius, d + (BUILDINGS[b.type]?.radius || 0));
  }
  return Math.min(radius + GARRISON_SKIRT_CLEARANCE, DEFEND_RADIUS - STATION_REACH);
}

// Every unit's own grid slot for this CC's parked garrison: anchored past its own built footprint
// (baseFootprintRadius), on the side facing away from the map's center so a base sitting near the
// map's edge doesn't waste the spot off the playable area — outside the base, at its skirt, not
// dropped among the buildings or at a single rally point inside them. Deterministic (no RNG, so
// two same-seed matches place an identical grid).
//
// baseFootprintRadius already keeps the ANCHOR itself inside DEFEND_RADIUS, but the grid drawn
// around it has its own size — a large garrison's outer corners can still land past the limit
// even though its center doesn't. formationSlots is asked once to find out how far that farthest
// corner actually reaches, and if it overshoots, the anchor is pulled back in by exactly that much
// and asked again — one corrective pass, not a search, since a grid's own footprint doesn't change
// with where it's centered. Keeps the WHOLE parked group, not just its middle, inside the radius
// an attack still recalls it from, however many units end up in it.
// Exported so its geometry can be unit-tested directly. The corrective branch below had NEVER
// executed under `npm test`: every dispersal test uses 1 or 5 units around a bare Command Center,
// and a bare CC's grid doesn't overshoot until ~60 units.
export function garrisonSlots(units, cc, buildings, mapWidth, mapHeight) {
  const away = Math.atan2(cc.y - mapHeight / 2, cc.x - mapWidth / 2);
  const radius = baseFootprintRadius(cc, buildings);
  const anchorAt = r => ({ x: cc.x + Math.cos(away) * r, y: cc.y + Math.sin(away) * r });

  const limit = DEFEND_RADIUS - STATION_REACH;
  const farthestOf = ss => Math.max(...ss.map(s => Math.hypot(s.x - cc.x, s.y - cc.y)));

  let ringRadius = radius;
  let slots = formationSlots(units, anchorAt(ringRadius).x, anchorAt(ringRadius).y, { shape: "grid" });
  // Iterate to a fixed point instead of correcting once. The old single pass assumed pulling the
  // anchor in by the overshoot removes the overshoot — true only if the farthest slot lay on the
  // pull-back axis. It doesn't: it's an off-axis grid CORNER, so max|slot - cc| is not a linear
  // function of the ring radius and one pass always left a residual, growing with garrison size
  // (measured 0.1px at 60 units, 1.2px at 80). A handful of passes converge; the loop is bounded so
  // a pathological footprint can't spin, and the floor keeps a bare base's ring off its own skirt.
  for (let pass = 0; pass < 8; pass++) {
    const farthest = farthestOf(slots);
    if (farthest <= limit) break;
    const next = Math.max(GARRISON_MIN_RING_RADIUS, ringRadius - (farthest - limit));
    if (next === ringRadius) break;                    // already at the floor — nothing more to give
    ringRadius = next;
    const a = anchorAt(ringRadius);
    slots = formationSlots(units, a.x, a.y, { shape: "grid" });
  }
  return slots;
}

// Stand this controller's idle home army up in a grid at a single anchor point just outside each
// of its own Command Centers, instead of leaving it clumped at whichever building's rally point
// produced it — an orderly parked garrison covers more ground and isn't a single engagement away
// from losing its whole standing defense. Each Command Center (home, plus any same-map expansion)
// claims its own anchor and whichever idle units are already nearest it AND actually within
// DISPERSAL_HOME_RADIUS of it (mirrors zoneFirst's own "stay loyal to your own base" spirit,
// engine/gather.js) — a unit too far from every Command Center is left alone, not redirected.
//
// formationSlots (engine/formation.js — the same primitive a player's own move/hold-formation
// orders use) gives every unit in the group its OWN slot in the grid: no two units are ever sent
// to the identical point. That matters because a shared destination never lets separation.js and
// movement.js's arrival test both settle at once — two units ordered to the same (x,y) each keep
// walking toward it while separation keeps shoving them back apart, forever, which is exactly what
// the old fixed 3-station round-robin did once a garrison grew past 3 (a visible, endless jitter —
// the "Brownian motion" a parked army should never show). A plain move order walks each unit to
// its own slot; once arrived it clears to idle and falls back to ordinary auto-defense (combat.js)
// like any other idle unit — the grid still sits inside DEFEND_RADIUS, so an attack on it still
// triggers the normal recall (visibleThreatsNearHome). Recomputed fresh every cycle, same as
// everything else in this file — no persisted per-unit slot assignment — so a unit already
// standing at its slot just skips the redundant order (STATION_REACH) instead of re-arriving
// every cycle. Costs one action, like sending the scout (updateScout) — a management decision,
// not the exempt attack/defense commit — but only once something real is actually dispatched,
// not merely offered the chance. `owner` picks whose action budget (canAct/spend) this spends from.
function disperseGarrison(state, owner, garrison, buildings) {
  if (!garrison.length) return;
  const ccs = buildings.filter(b => b.type === "command" && !b.constructing);
  if (!ccs.length || !canAct(state, owner)) return;

  const byCC = new Map(ccs.map(cc => [cc, []]));
  for (const u of garrison) {
    let best = null, bestD = Infinity;
    for (const cc of ccs) {
      const d = Math.hypot(u.x - cc.x, u.y - cc.y);
      if (d < bestD) { bestD = d; best = cc; }
    }
    if (bestD <= DISPERSAL_HOME_RADIUS) byCC.get(best).push(u);
  }
  const { width, height } = state.map;
  let dispatched = false;
  for (const cc of ccs) {
    const units = byCC.get(cc);
    if (!units.length) continue;
    const slots = garrisonSlots(units, cc, buildings, width, height);
    units.forEach((u, i) => {
      const slot = slots[i];
      if (Math.hypot(u.x - slot.x, u.y - slot.y) > STATION_REACH) {
        issueMove([u], slot.x, slot.y);
        dispatched = true;
      }
    });
  }
  if (dispatched) spend(state, owner);
}

const FOCUS_RANGE = 340;   // only army units this close to the chosen target concentrate on it

// Point every nearby combat unit's focus at a single best enemy: the lowest-HP visible enemy
// combat unit (secure the kill, cut its DPS), tie-broken toward the more dangerous one, then by id
// for determinism. combat.js reads unit.focusId and prefers it while it's a live enemy in aggro
// (else falls back to the normal dispersed acquire). Cleared when nothing hostile is in sight, so
// the razing path uses ordinary targeting untouched. Takes the whole ctx (not just the army) so it
// reads ctx.owner's OWN fog (via visibleEnemyCombatUnits) rather than ever defaulting to state.fogAI
// regardless of which side is calling — the same fog discipline every reactive read in this file
// keeps.
/** @param {State} state @param {AiContext} ctx */
export function applyFocusFire(state, ctx) {
  const { army, owner } = ctx;
  const enemies = [...visibleEnemyCombatUnits(state, owner)];
  if (!enemies.length) { for (const a of army) a.focusId = null; return; }
  enemies.sort((a, b) => a.hp - b.hp
    || (UNITS[b.type].attack - UNITS[a.type].attack)
    || (a.id < b.id ? -1 : 1));
  const focus = enemies[0];
  for (const a of army) {
    a.focusId = Math.hypot(a.x - focus.x, a.y - focus.y) <= FOCUS_RANGE ? focus.id : null;
  }
}

const RETREAT_FRACTION = 0.4;   // a committed attack ground below this share of its launch size pulls back
const RETREAT_SIGHT = 260;      // ...if it can see at least as many enemy combat units this close (still losing)

// Enemy combat units `owner` can currently SEE in ITS OWN fog (state.fogs[owner]) — the shared
// "live visible opposition" filter behind applyFocusFire, visibleEnemyCombatNear and
// visibleThreatsNearHome, so the two-line owner/role/visibility test lives in exactly one place.
// `owner` defaults to "ai" so every pre-existing (single-owner) caller is unaffected; a self-play
// "player" controller passes its own owner so it reacts to what IT has seen through state.fog,
// never state.fogAI — the fairness guarantee this whole module exists to keep. T-043: every OTHER
// owner counts as an enemy (opponentsOf, FFA — no alliances), not one hardcoded rival; for the
// shipped 2-seat case opponentsOf is always a single-element array, so this is byte-identical.
function* visibleEnemyCombatUnits(state, owner = "ai") {
  const enemies = opponentsOf(state, owner);
  const fog = state.fogs[owner];
  for (const u of state.units.values()) {
    if (!enemies.includes(u.owner) || UNITS[u.type].role !== "combat") continue;
    if (!isVisibleAt(fog, u.x, u.y)) continue;
    yield u;
  }
}

// How many enemy combat units `owner` can currently SEE, full stop — the "Force Parity" strategy's
// read of the enemy's strength (engine/aiStrategy.js matchEnemyForce, consumed by
// engine/aiEconomy.js's standing-army throttle). Deliberately the same fog-limited intel as
// everything else the AI reacts to (counterToPlayerArmy, visibleThreatsNearHome): an enemy army
// massed somewhere `owner` has never scouted doesn't count until it's actually seen, so "matching"
// is an honest reaction to known strength, not omniscient mirroring.
export function visibleEnemyForceCount(state, owner = "ai") {
  let n = 0;
  for (const _ of visibleEnemyCombatUnits(state, owner)) n++;
  return n;
}

// Enemy combat units `owner` can currently SEE within `radius` of (x, y) — the live opposition at
// a fight. Zero against an undefended base, which is what makes the retreat safe for the
// resolves-to-a-winner guarantee.
export function visibleEnemyCombatNear(state, owner, x, y, radius) {
  let n = 0;
  for (const u of visibleEnemyCombatUnits(state, owner)) {
    if (Math.hypot(u.x - x, u.y - y) <= radius) n++;
  }
  return n;
}

export const DEFEND_RADIUS = 340;   // enemy combat units this close to an AI building trigger a recall

// Enemy combat units `owner` can currently SEE (its own fog) sitting within DEFEND_RADIUS of any
// building it owns. A lone scouting worker doesn't count — only real combat threats pull the army
// home, so the AI isn't yanked off an attack by a single drone. What it can't see, it can't react
// to. `owner` defaults to "ai" so the pre-existing (single-owner) call site is unaffected.
export function visibleThreatsNearHome(state, owner = "ai") {
  const myBuildings = [...state.buildings.values()].filter(b => b.owner === owner);
  if (!myBuildings.length) return [];
  const threats = [];
  for (const u of visibleEnemyCombatUnits(state, owner)) {
    if (myBuildings.some(b => Math.hypot(b.x - u.x, b.y - u.y) <= DEFEND_RADIUS)) threats.push(u);
  }
  return threats;
}

export function threatCentroid(threats) {
  let x = 0, y = 0;
  for (const t of threats) { x += t.x; y += t.y; }
  return { x: x / threats.length, y: y / threats.length };
}

// Hold back the `garrison` units closest to home; return the rest as the strike
// force, ordered nearest-home-first / forward-most-last. That ordering is what
// lets a caller taking only part of the result (the Odyssey wave, below) slice
// off the tail and get the forward-most units — so it still has to hold for an
// all-in archetype with garrison:0 (nobody held back, but the order is exactly
// as load-bearing for a PARTIAL commit as it is when garrison > 0): sort first,
// then drop the closest `garrison` (zero is a no-op slice, not a skip).

// Exported for direct unit testing. engine/ai.js has ONE export (runAI) and aiContext is private,
// so every phase test had to stage a whole match — which is the direct cause of two gaps this
// review found: commit ac44339's army-cap feature shipped with no test at all, and garrisonSlots'
// corrective branch had never executed under npm test. These helpers are pure arithmetic over
// plain arguments; exporting them (rather than moving them to a testability-only leaf module,
// which would need imports back into the phase that owns them) is the smallest change that makes
// that arithmetic reachable without a staged game.
export function withoutHomeGuard(homeArmy, cc, garrison) {
  if (homeArmy.length <= garrison) return [];
  if (!cc) return homeArmy.slice();   // nothing to measure distance from — can't sort, return everyone
  const byDistHome = homeArmy.slice().sort((a, b) =>
    Math.hypot(a.x - cc.x, a.y - cc.y) - Math.hypot(b.x - cc.x, b.y - cc.y));
  return byDistHome.slice(garrison);   // drop the closest `garrison` — they stay home
}

// Does `enemyOwner` have ANYTHING at all on this world — a unit or a building, either counts?
// Deliberately NOT fog-gated, unlike the AI's other reactive reads (visibleEnemyForceCount,
// counterToPlayerArmy, visibleThreatsNearHome): those ask "what can `owner` currently see", this
// asks "could a wave possibly find anyone at all" — a background world the player has never
// reached has zero of both (engine/galaxy.js addPlanet's `unsettled` seeding strips them at
// creation), and no amount of fog-of-war nuance changes that a wave sent there fights nobody.
// `owner` defaults to "player" (the caller always means "the OTHER side", and every pre-existing
// call site is aiOffense's Odyssey branch checking the human player).
export function playerHasPresence(state, owner = "player") {
  return playerUnits(state, owner).length > 0 || playerBuildings(state, owner).length > 0;
}

// Where to send the wave. Prefer a seen enemy Command Center (the win
// condition), then any seen enemy building, then a seen enemy unit (raid the
// army or worker line). With nothing in sight it goes HUNTING: an enemy CC is
// still standing somewhere (the game isn't over), and the enemy can hold — and
// hide — several of them, so razing the first is not the win. It first marches on
// the enemy's start if it hasn't even charted it yet (the likeliest spot early,
// and the fast beeline that keeps the game resolving); once that's explored and
// empty, it sweeps the nearest unexplored ground, attack-moving to reveal fog,
// until it turns up a hidden expansion CC — instead of committing forever to a
// start coordinate the enemy has long since left.
const RAID_EVERY = 3;   // every Nth Tactical wave goes for the economy instead of the base

// The enemy economy to snipe: the nearest visible worker belonging to ANY opponent `owner` can see
// (T-043: opponentsOf, not one hardcoded rival — nearest-wins already picks sensibly across a wider
// pool). A Tactical raid peels a wave onto the worker line to cripple production rather than
// grinding the defended main base. Null when no worker is in sight — nothing to raid, so the caller
// falls back to the ordinary base assault. `owner` defaults to "ai" so the pre-existing
// (single-owner) call site is unaffected.
export function raidTarget(state, owner = "ai") {
  const enemies = opponentsOf(state, owner);
  const fog = state.fogs[owner];
  const from = state.map.bases[owner];
  let best = null, bestD = Infinity;
  for (const u of state.units.values()) {
    if (!enemies.includes(u.owner) || UNITS[u.type]?.role !== "worker") continue;
    if (!isVisibleAt(fog, u.x, u.y)) continue;
    const d = Math.hypot(u.x - from.x, u.y - from.y);
    if (d < bestD) { bestD = d; best = u; }
  }
  return best ? { x: best.x, y: best.y } : null;
}

// `owner` defaults to "ai" so the pre-existing (single-owner) call site — including
// engine/aiSuperweapon.js's own chooseAttackTarget(state, ctx.cc), a file this Tier stays out of —
// reads exactly as before. A self-play "player" controller passes its own owner, so every read
// below (seen buildings/units, the fallback start coordinate, the fog sweep) resolves off ITS OWN
// fog (state.fogs[owner]) and targets every OTHER side (T-043: opponentsOf(owner), never a
// hardcoded "player"/state.fogAI pair or a single hardcoded rival) — nearest-wins already picks
// sensibly across a wider candidate pool, so no new "which rival do I focus on" policy is needed.
export function chooseAttackTarget(state, cc, owner = "ai") {
  const enemies = opponentsOf(state, owner);
  const fog = state.fogs[owner];
  const from = cc || { x: state.map.bases[owner].x, y: state.map.bases[owner].y };
  const seen = e => enemies.includes(e.owner) && isVisibleAt(fog, e.x, e.y);
  const seenBuildings = [...state.buildings.values()].filter(seen);
  const ccs = seenBuildings.filter(b => b.type === "command");
  const nearestOf = list => {
    let best = null, bestD = Infinity;
    for (const e of list) {
      const d = Math.hypot(e.x - from.x, e.y - from.y);
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  };
  const target = nearestOf(ccs) || nearestOf(seenBuildings)
      || nearestOf([...state.units.values()].filter(seen));
  if (target) return target;
  // Nothing seen of ANY opponent yet: head for the nearest opponent start this map actually has a
  // position for — state.map.bases is still 2-keyed pre-T-044 (engine/state.js's own basePositions
  // is a seeding-time-only stopgap, never written back into map.bases), so an opponent beyond the
  // original pair may have no entry here at all yet; skip it rather than crash on `undefined.x`.
  // For the shipped 2-seat case `starts` is always the same single element the old code used, so
  // this is byte-identical: prefer one not yet explored (still worth a look, nearest first — the
  // old `if (!isExploredAt(start...)) return start`), else fall through to the blind fog sweep
  // (already fully owner-agnostic, unchanged) and finally the nearest known start regardless of
  // explored state (the old `|| start`) — or, only reachable for an opponent with no known start at
  // all, `from` itself as a last-resort no-op rather than an undefined target.
  const starts = enemies.map(o => state.map.bases[o]).filter(Boolean);
  const unexploredStarts = starts.filter(s => !isExploredAt(fog, s.x, s.y));
  if (unexploredStarts.length) return nearestOf(unexploredStarts);
  return nearestUnexploredPoint(fog, from.x, from.y) || nearestOf(starts) || from;
}

// The next unit to build: normally the next entry in the archetype's mix, but
// every `every`-th unit (COUNTER_EVERY by default; difficulty-shaped — Easy
// never counter-picks, Hard reacts half again as fast, see aiDifficulty.js's
// counterEvery) it instead builds the counter to whatever the enemy fields
// most, per counterToPlayerArmy below. Both draw from effectiveMix — the mix
// with entries this map can't pay for dropped (e.g. the Breacher on a world
// with no radioactives) — so the cycle never stalls on an unbuildable type,
// and a counter is only chosen when this map can actually build it. `owner`
// defaults to "ai" so every pre-existing call site (every test, tools/ailab.js)
// reads exactly as before; a self-play "player" controller passes its own
// ctx.owner so it counter-picks off ITS OWN fog and ITS OWN unitsBuilt tally,
// never the "ai" controller's.
export function pickNextUnitType(state, archetype, owner = "ai") {
  const mix = effectiveMix(state, archetype, owner);
  const controller = controllerFor(state, owner);
  const built = (controller && controller.unitsBuilt) || 0;
  const every = difficultyFor(state, owner).counterEvery ?? COUNTER_EVERY;
  if (every > 0 && built > 0 && built % every === 0) {
    const counter = counterToPlayerArmy(state, owner);
    if (counter && mix.includes(counter)) return counter;
  }
  return mix[built % mix.length];
}

// Whatever combat type the enemy currently fields the most of — among only the units `owner` can
// actually SEE right now (its own fog) — mapped to its counter: COUNTER_OF's hard (bonusVs- or
// counteredBy-derived) counter first, else the curated SOFT_ANSWER cost-efficiency fallback. No
// vision of the enemy's army means no counter-pick, so the AI has to scout or fight to earn that
// intel, the same as its opponent. Ties keep whichever type was seen first; there's no
// meaningfully "correct" pick between two equally common threats.
//
// Static defense is invisible to that unit scan, so a turtling opponent fielding no army at all
// was never answered — a separate pass counts visible enemy buildings that can shoot (fog-gated,
// same discipline as the unit scan) and answers with "breacher" whenever the wall would beat the
// dominant seen unit type, or is simply large enough to read as a wall on its own (the
// test/balance.test.js turret-line proof), overriding the unit-type counter above —
// prefersBuildings targeting and its 150 range (outranging the turret's 130) do the rest once it's
// queued. `owner` defaults to "ai" so the pre-existing (single-owner) call site is unaffected.
// T-043: tallies across every OTHER owner combined (opponentsOf), not one hardcoded rival — the
// existing "most-common-type wins" pick already generalizes over a wider combined pool.
export function counterToPlayerArmy(state, owner = "ai") {
  const enemies = opponentsOf(state, owner);
  const fog = state.fogs[owner];
  const counts = {};
  for (const u of state.units.values()) {
    if (!enemies.includes(u.owner) || UNITS[u.type].role !== "combat") continue;
    if (!isVisibleAt(fog, u.x, u.y)) continue;   // can't counter what it hasn't seen
    counts[u.type] = (counts[u.type] || 0) + 1;
  }
  let best = null, bestCount = 0;
  for (const [type, count] of Object.entries(counts)) {
    if (count > bestCount) { bestCount = count; best = type; }
  }
  let staticDefense = 0;
  for (const b of state.buildings.values()) {
    // BUILDINGS[b.type]?.attack (not a hardcoded "turret" check) so a future
    // second static-defense tier (docs/improvement-roadmap.md Phase 4, gated on
    // this landing first) is read for free. Only "turret" qualifies today.
    if (!enemies.includes(b.owner) || b.constructing || !BUILDINGS[b.type]?.attack) continue;
    if (!isVisibleAt(fog, b.x, b.y)) continue;   // same fog discipline as the unit scan
    staticDefense++;
  }
  if (staticDefense > 0 && (staticDefense > bestCount || staticDefense > TURRET_WALL_COUNT)) return "breacher";
  return best ? (COUNTER_OF[best] || SOFT_ANSWER[best] || null) : null;
}

// Keep one spare unit ranging across the contested middle so this controller earns its intel —
// uncovering hidden caches and spotting the enemy's forces — instead of knowing the map for free.
// Only lends a scout once the army can spare one; a box sweep of the centre laid down as plain-move
// waypoints (it reveals fog rather than diving into a fight), re-issued whenever the scout falls
// idle or dies. Runs before assignIdleWorkers so a scout is never re-tasked to gather. Takes the
// whole ctx (not just army/rangers) so it reads/writes ctx.controller.scoutId (never state.ai's,
// unless owner IS "ai") and spends from ctx.owner's own action budget.
/** @param {State} state @param {AiContext} ctx @param {boolean} [defending] */
export function updateScout(state, ctx, defending = false) {
  if (defending) return;   // base under attack — hold every unit home, don't lend a scout
  const { army, rangers, owner, enemyOwner, controller } = ctx;
  let scout;
  const ranger = (rangers && rangers.length) ? rangers[0] : null;
  if (ranger) {
    // Prefer a dedicated Ranger (Tactical builds one): it out-sees any fighter,
    // goes anywhere, and costs the army nothing. Leave it be while it's sweeping;
    // re-task only once it falls idle (or send it out the first time).
    if (ranger.order || (ranger.orderQueue && ranger.orderQueue.length)) return;
    scout = ranger;
  } else {
    // No Ranger: fall back to lending a combat unit, but only if one isn't already
    // out — don't pull a second fighter off the line.
    const current = controller.scoutId ? state.units.get(controller.scoutId) : null;
    if (current && (current.order || (current.orderQueue && current.orderQueue.length))) return;
    if (army.length < 4) { controller.scoutId = null; return; }   // need a genuine spare to lend
    // `army` is EVERY combat unit this controller owns, not just the idle ones — a prior wave
    // still mid attack-move stays in it. Only an idle/home unit (no order, or still walking to
    // the rally point — the same "home army" test aiOffense uses) is eligible, so a unit actively
    // pressing an assault is never yanked off it to go scouting instead.
    scout = army.find(u => u.id !== controller.scoutId && (!u.order || u.order.type === "move"));
  }
  if (!scout || !canAct(state, owner)) return;   // no spare, or no action budget to send one out yet
  spend(state, owner);
  controller.scoutId = scout.id;
  const w = state.map.width, h = state.map.height;
  const home = { x: scout.x, y: scout.y };
  // T-043: ctx.enemyOwner is the PRIMARY opponent (opponentsOf(state,owner)[0] — see aiContext),
  // but state.map.bases is still 2-keyed pre-T-044 (basePositions is a seeding-time-only stopgap,
  // engine/state.js — it never writes back into map.bases), so an opponent beyond the original
  // pair may have no entry here yet. `pb` guards that: with no known bias direction, the box sweep
  // above still ran and already revealed fog, so skipping the swing leg is a safe degrade, not a
  // silently-worse scout — never a crash on `undefined.x`.
  const pb = state.map.bases[enemyOwner];
  issueMove([scout], w * 0.42, h * 0.22);
  issueMove([scout], w * 0.58, h * 0.22, true);
  issueMove([scout], w * 0.58, h * 0.78, true);
  issueMove([scout], w * 0.42, h * 0.78, true);
  // ...then swing toward the enemy's side to actually see the army it needs to
  // counter (a pure centre sweep can miss what's massing at the enemy base),
  // stopping short of diving into the base itself, before folding back home.
  if (pb) issueMove([scout], home.x + (pb.x - home.x) * 0.6, home.y + (pb.y - home.y) * 0.6, true);
  issueMove([scout], home.x, home.y, true);   // and head home to fold back into the army
}
