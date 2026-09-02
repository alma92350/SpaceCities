/* ============================================================
   Scenario / mission mode — a real-time layer over the skirmish engine that
   swaps the "raze the enemy Command Center" objective for a scripted mission.
   Two scenarios share one convoy-along-a-route simulation, differing only by
   which side the player commands and what the win condition is:

   • CONVOY ESCORT — you control a small escort fleet and must keep a convoy of
     defenceless freighters alive across a multi-leg route, through pirate raids
     (spawned per leg by that leg's risk), before a mission clock runs out.
     Repairs at a station cost from a budget; the score rewards freighters
     delivered, legs survived, risk faced, and budget left unspent.

   • PIRATE RAIDER — the roles flip: an AI convoy (freighters + escort) runs the
     same route toward the gate, and you command the raiders, sinking enough
     freighters to hit a kill quota before the convoy escapes or the clock runs
     out. The score rewards freighters sunk, escorts destroyed, and raiders left
     alive.

   Determinism: all randomness (pirate counts, spawn positions, compositions)
   flows through a seeded RNG stored on the scenario, so the same seed replays
   the same mission — same guarantee as the skirmish sim. The tick pump calls
   updateScenario() in place of runAI() when state.scenario is set (see sim.js);
   the skirmish path is untouched.
   ============================================================ */

"use strict";

import { createGameState, makeUnit } from "./state.js";
import { mulberry32 } from "./rng.js";
import { updateFog } from "./fog.js";
import { UNITS } from "./entities.js";

/* ---------- tuning ---------- */
const PREP_TIME = 12;          // seconds to position escorts before the convoy departs
const STATION_RADIUS = 90;     // a freighter within this of a station counts as arrived / docked
const FIRST_SPAWN_DELAY = 5;   // seconds into a leg before its first pirate wave
const SPAWN_INTERVAL = 6;      // seconds between waves within a leg
const PIRATES_PER_RISK = 5;    // a leg of risk r spawns ~r*this raiders across its waves
const STEER_INTERVAL = 1.5;    // how often pirates re-aim at the lead freighter
const REPAIR_COST_PER_HP = 0.4;// credits per hit point restored at a station

const SCORE = { perFreighter: 300, perLeg: 120, perRisk: 220, timeDivisor: 8 };

// Easy/Medium/Hard tune the escort you're given, the per-leg risk, the clock and
// the repair budget. legRisk length is the number of legs (route has legRisk+1
// stations, start..destination).
export const ESCORT_DIFFICULTY = {
  easy:   { escorts: { skiff: 3, bastion: 1, mender: 1 }, legRisk: [0.3, 0.5, 0.7], timeLimit: 320, budget: 520, dockTime: 16 },
  medium: { escorts: { skiff: 2, bastion: 1, mender: 1 }, legRisk: [0.4, 0.7, 1.0], timeLimit: 280, budget: 420, dockTime: 14 },
  hard:   { escorts: { skiff: 2, lancer: 1 },             legRisk: [0.6, 1.0, 1.4], timeLimit: 240, budget: 300, dockTime: 12 },
};

/* ---------- Pirate Raider tuning ---------- */
const RAIDER_DOCK_TIME = 6;         // seconds the AI convoy pauses at each station (a window to strike)
const PIRATE_AMBUSH_OFFSET = 200;   // how far off the convoy lane the raider fleet lies in wait
const RAIDER_SCORE = { perFreighter: 350, perEscort: 60, perSurvivor: 35, winBonus: 400, timeDivisor: 8 };

// Pirate Raider difficulty: your raider fleet, the AI convoy's escort, how many
// freighters you must sink to win, and the clock. Harder = a tougher, better
// escorted convoy, a leaner raider fleet, and a higher kill quota.
export const RAIDER_DIFFICULTY = {
  easy:   { pirates: { skiff: 4, lancer: 1 }, escort: { skiff: 2 },                                  legs: 3, targetKills: 2, timeLimit: 300 },
  medium: { pirates: { skiff: 3, lancer: 1 }, escort: { skiff: 2, bastion: 1, mender: 1 },           legs: 3, targetKills: 3, timeLimit: 280 },
  hard:   { pirates: { skiff: 3 },            escort: { skiff: 3, bastion: 1, lancer: 1, mender: 1 }, legs: 3, targetKills: 3, timeLimit: 260 },
};

/* ---------- Bounty Marshal tuning ---------- */
const PACK_MIN_SEP = 300;           // minimum spacing between pirate camps (and from the marshal start)
const PACK_SCATTER_TRIES = 30;      // attempts to place a well-separated camp before taking the last roll
const BOUNTY_SCORE = { perSurvivor: 40, timeBonusPerSec: 2, winBonus: 400 };

// Bounty Marshal difficulty: your posse, how many pirate camps are scattered
// across the sector, each camp's composition, how many you must clear to win
// (quota), and the clock. Harder = a leaner posse, more and tougher camps, a
// higher quota, and less time.
export const BOUNTY_DIFFICULTY = {
  easy:   { marshal: { skiff: 4, lancer: 2, mender: 1 }, packs: 4, packComp: { skiff: 2, bastion: 1 },            targetPacks: 3, timeLimit: 260 },
  medium: { marshal: { skiff: 3, lancer: 2, mender: 1 }, packs: 5, packComp: { skiff: 2, bastion: 1 },            targetPacks: 3, timeLimit: 250 },
  hard:   { marshal: { skiff: 4, lancer: 2, mender: 1 }, packs: 6, packComp: { skiff: 2, bastion: 1, lancer: 1 }, targetPacks: 4, timeLimit: 240 },
};

/* ---------- setup ---------- */

// Build a Convoy Escort game state on `planetId`. Reuses createGameState for the
// map / fog / players scaffold, then strips the skirmish seeding (no CCs, no
// economy) and lays out the route, the freighters, and the player's escort.
export function setupEscort({ planetId = "ferros", seed = 1, difficulty = "medium", sizeMult = 1 } = {}) {
  const diff = ESCORT_DIFFICULTY[difficulty] || ESCORT_DIFFICULTY.medium;
  const state = createGameState({ planetId, seed, rng: mulberry32(seed >>> 0), sizeMult });
  state.units.clear();
  state.buildings.clear();

  const { width, height } = state.map;
  // Stations evenly spaced left→right; legs = the gaps between them.
  const n = diff.legRisk.length;                 // number of legs
  const route = buildRoute(width, height, n);

  const start = route[0];
  // Four freighters clustered at the start station.
  for (let i = 0; i < 4; i++) {
    const f = makeUnit("freighter", "player", start.x + (i % 2) * 26 - 13, start.y + Math.floor(i / 2) * 30 - 15, state);
    state.units.set(f.id, f);
  }
  // The escort fleet, just behind the freighters.
  let ei = 0;
  for (const [type, count] of Object.entries(diff.escorts)) {
    for (let k = 0; k < count; k++) {
      const u = makeUnit(type, "player", start.x - 55 - (ei % 3) * 22, start.y + (ei - 2) * 26, state);
      state.units.set(u.id, u);
      ei++;
    }
  }

  state.scenario = {
    type: "escort",
    difficulty,
    phase: "prep",                 // prep → travel ⇄ docked → done
    phaseTimer: PREP_TIME,
    route,
    legRisk: diff.legRisk,
    legIndex: 0,                   // leg currently being (or about to be) travelled
    timeLimit: Math.round(diff.timeLimit * sizeMult),   // the route scales with the map, so the clock does too
    dockTime: diff.dockTime,
    budget: diff.budget,
    freighterOwner: "player",      // whose freighters these are (player's to protect in Escort)
    freightersTotal: 4,
    delivered: 0,
    legsDone: 0,
    riskFaced: 0,
    score: 0,
    outcome: null,                 // null | "win" | "loss"
    repairedThisStop: false,
    rng: mulberry32((seed ^ 0x9e3779b9) >>> 0),   // scenario RNG, decoupled from map-gen draws
    spawn: { remaining: 0, timer: 0 },
    steerTimer: 0,
    banner: "Prep — position your escorts, then the convoy departs.",
  };

  updateFog(state, state.fog, "player");
  updateFog(state, state.fogAI, "ai");
  return state;
}

/* ---------- per-tick brain (called in place of runAI) ---------- */

// Dispatch the live scenario to its own updater. Both drive the *non-player*
// side of the convoy and settle the objective themselves; combat/movement/fog
// are the shared skirmish sim.
export function updateScenario(state, dt) {
  const sc = state.scenario;
  if (!sc || sc.outcome) return;
  if (sc.type === "raider") updateRaider(state, dt);
  else if (sc.type === "bounty") updateBounty(state, dt);
  else updateEscort(state, dt);
}

function updateEscort(state, dt) {
  const sc = state.scenario;

  const freighters = liveFreighters(state);

  // Terminal checks first — read live entity counts (so a freighter lost to the
  // previous tick's combat is seen here).
  if (freighters.length === 0 && sc.delivered === 0) { endScenario(state, "loss", "The convoy was wiped out."); return; }
  if (state.time >= sc.timeLimit && sc.phase !== "done") {
    endScenario(state, sc.delivered > 0 ? "win" : "loss",
      sc.delivered > 0 ? "Out of time — the mission ends here." : "Out of time — the convoy never made it.");
    return;
  }

  switch (sc.phase) {
    case "prep":
      sc.phaseTimer -= dt;
      if (sc.phaseTimer <= 0) startLeg(state, 0);
      break;

    case "travel": {
      const target = sc.route[sc.legIndex + 1];
      // Keep the freighters trundling toward the leg's station.
      for (const f of freighters) {
        const o = f.order;
        if (!o || o.type !== "move" || o.x !== target.x || o.y !== target.y) f.order = { type: "move", x: target.x, y: target.y };
      }
      updatePirateSpawns(state, dt);
      steerPirates(state, freighters, dt);

      // Arrived when every surviving freighter is at the station.
      if (freighters.every(f => Math.hypot(f.x - target.x, f.y - target.y) <= STATION_RADIUS)) {
        sc.legsDone += 1;
        sc.riskFaced += sc.legRisk[sc.legIndex] || 0;
        if (sc.legIndex + 1 >= sc.route.length - 1) {
          deliverConvoy(state, freighters);
        } else {
          sc.legIndex += 1;
          sc.phase = "docked";
          sc.phaseTimer = sc.dockTime;
          sc.repairedThisStop = false;
          sc.banner = `Docked at station ${sc.legIndex} — Repair, or Depart when ready.`;
        }
      }
      break;
    }

    case "docked":
      for (const f of freighters) f.order = null;   // hold at the station
      sc.phaseTimer -= dt;
      if (sc.phaseTimer <= 0) startLeg(state, sc.legIndex);
      break;
  }
}

// Begin (or resume) travelling leg `i`: aim the freighters at route[i+1] and roll
// this leg's pirate budget from its risk.
function startLeg(state, i) {
  const sc = state.scenario;
  sc.legIndex = i;
  sc.phase = "travel";
  const risk = sc.legRisk[i] || 0;
  sc.spawn = { remaining: Math.round(risk * PIRATES_PER_RISK), timer: FIRST_SPAWN_DELAY };
  const legNo = i + 1, legs = sc.route.length - 1;
  sc.banner = `Leg ${legNo}/${legs} — piracy risk ${riskLabel(risk)}. Protect the freighters.`;
}

function deliverConvoy(state, freighters) {
  const sc = state.scenario;
  sc.delivered = freighters.length;
  for (const f of freighters) state.units.delete(f.id);   // they dock safe at the destination
  endScenario(state, "win", `Convoy delivered — ${sc.delivered}/${sc.freightersTotal} freighters made it.`);
}

function endScenario(state, outcome, banner) {
  const sc = state.scenario;
  sc.outcome = outcome;
  sc.banner = banner;
  sc.timeUsed = state.time;
  sc.score = sc.type === "raider" ? computeRaiderScore(state, sc)
    : sc.type === "bounty" ? computeBountyScore(state, sc)
    : computeEscortScore(sc);
  sc.phase = "done";
  state.over = true;
  state.winner = outcome === "win" ? "player" : "ai";
}

function computeEscortScore(sc) {
  const s = sc.delivered * SCORE.perFreighter
    + sc.legsDone * SCORE.perLeg
    + sc.riskFaced * SCORE.perRisk
    + Math.max(0, Math.round(sc.budget))
    - Math.floor((sc.timeUsed || 0) / SCORE.timeDivisor);
  return Math.max(0, Math.round(s));
}

/* ---------- pirates ---------- */

function updatePirateSpawns(state, dt) {
  const sc = state.scenario;
  const sp = sc.spawn;
  if (sp.remaining <= 0) return;
  sp.timer -= dt;
  if (sp.timer > 0) return;
  sp.timer = SPAWN_INTERVAL;

  const risk = sc.legRisk[sc.legIndex] || 0.5;
  const waveSize = Math.min(sp.remaining, 2 + (sc.rng() < risk - 0.5 ? 1 : 0));
  const convoy = centroid(liveFreighters(state)) || sc.route[sc.legIndex];
  const from = sc.route[sc.legIndex], to = sc.route[sc.legIndex + 1];
  const hx = to.x - from.x, hy = to.y - from.y;
  const hlen = Math.hypot(hx, hy) || 1;
  const dirx = hx / hlen, diry = hy / hlen;          // convoy heading
  const px = -diry, py = dirx;                       // perpendicular (a flank)

  for (let k = 0; k < waveSize; k++) {
    const ahead = 220 + sc.rng() * 220;
    const flank = (sc.rng() < 0.5 ? 1 : -1) * (110 + sc.rng() * 180);
    let x = convoy.x + dirx * ahead + px * flank;
    let y = convoy.y + diry * ahead + py * flank;
    x = Math.max(20, Math.min(state.map.width - 20, x));
    y = Math.max(20, Math.min(state.map.height - 20, y));
    const type = pirateType(risk, sc.rng);
    const u = makeUnit(type, "ai", x, y, state);
    u.order = { type: "attack-move", x: convoy.x, y: convoy.y };
    state.units.set(u.id, u);
  }
  sp.remaining -= waveSize;
}

function pirateType(risk, rng) {
  const r = rng();
  if (risk >= 1.0 && r < 0.2) return "lancer";
  if (r < 0.28) return "bastion";
  return "skiff";
}

// Every so often, re-aim each pirate at the freighter nearest the leg's station
// (the "lead" freighter) so they keep pressing the convoy as it moves — combat.js
// handles engaging the escorts they meet on the way.
function steerPirates(state, freighters, dt) {
  const sc = state.scenario;
  sc.steerTimer -= dt;
  if (sc.steerTimer > 0 || freighters.length === 0) return;
  sc.steerTimer = STEER_INTERVAL;
  const target = sc.route[sc.legIndex + 1];
  let lead = freighters[0], bestD = Infinity;
  for (const f of freighters) {
    const d = Math.hypot(f.x - target.x, f.y - target.y);
    if (d < bestD) { bestD = d; lead = f; }
  }
  for (const u of state.units.values()) {
    if (u.owner !== "ai") continue;
    u.order = { type: "attack-move", x: lead.x, y: lead.y };
  }
}

/* ============================================================
   PIRATE RAIDER — the mirror scenario. The convoy (freighters + escort) is now
   AI-owned and drives itself to the gate; the player commands the raiders. The
   scenario force-drives only the convoy (like Escort force-drives the freighters)
   and leaves the player's raiders entirely to the player — so with no input the
   convoy simply reaches the gate and escapes (a loss), which also guarantees the
   mission always terminates.
   ============================================================ */

// Build a Pirate Raider game state on `planetId`. Same route scaffold as Escort,
// but the convoy is the enemy and the player starts with a raider fleet lying in
// wait off the convoy lane near mid-route.
export function setupRaider({ planetId = "ferros", seed = 1, difficulty = "medium", sizeMult = 1 } = {}) {
  const diff = RAIDER_DIFFICULTY[difficulty] || RAIDER_DIFFICULTY.medium;
  const state = createGameState({ planetId, seed, rng: mulberry32(seed >>> 0), sizeMult });
  state.units.clear();
  state.buildings.clear();

  const { width, height } = state.map;
  const n = diff.legs;
  const route = buildRoute(width, height, n);

  const start = route[0];
  // The AI convoy: four freighters plus its escort, clustered at the start gate.
  // Nothing is ordered yet — the convoy holds until prep ends (updateRaider).
  for (let i = 0; i < 4; i++) {
    const f = makeUnit("freighter", "ai", start.x + (i % 2) * 26 - 13, start.y + Math.floor(i / 2) * 30 - 15, state);
    state.units.set(f.id, f);
  }
  let ei = 0, escortsTotal = 0;
  for (const [type, count] of Object.entries(diff.escort)) {
    for (let k = 0; k < count; k++) {
      const u = makeUnit(type, "ai", start.x - 55 - (ei % 3) * 22, start.y + (ei - 2) * 26, state);
      state.units.set(u.id, u);
      if (UNITS[type].role === "combat") escortsTotal++;
      ei++;
    }
  }

  // The player's raider fleet, off the lane near the middle of the route.
  const mid = route[Math.max(1, Math.floor(n / 2))];
  const ambush = { x: mid.x, y: Math.min(height - 40, mid.y + PIRATE_AMBUSH_OFFSET) };
  let pi = 0;
  for (const [type, count] of Object.entries(diff.pirates)) {
    for (let k = 0; k < count; k++) {
      const u = makeUnit(type, "player", ambush.x + (pi % 3) * 26 - 26, ambush.y + Math.floor(pi / 3) * 26, state);
      state.units.set(u.id, u);
      pi++;
    }
  }

  state.scenario = {
    type: "raider",
    difficulty,
    phase: "prep",                 // prep → travel ⇄ docked → done
    phaseTimer: PREP_TIME,
    route,
    legs: n,
    legIndex: 0,
    timeLimit: Math.round(diff.timeLimit * sizeMult),   // the route scales with the map, so the clock does too
    freighterOwner: "ai",          // the convoy is the enemy in Raider
    freightersTotal: 4,
    targetKills: diff.targetKills,
    destroyed: 0,
    delivered: 0,
    legsDone: 0,
    escortsTotal,
    escortsKilled: 0,
    survivors: 0,
    score: 0,
    outcome: null,                 // null | "win" | "loss"
    rng: mulberry32((seed ^ 0x9e3779b9) >>> 0),
    playerStart: ambush,           // where boot.js opens the camera (on your fleet, not the convoy)
    banner: "Prep — position your raiders. The convoy departs soon.",
  };

  updateFog(state, state.fog, "player");
  updateFog(state, state.fogAI, "ai");
  return state;
}

function updateRaider(state, dt) {
  const sc = state.scenario;
  const live = liveFreighters(state);                       // AI freighters still en route
  sc.destroyed = sc.freightersTotal - live.length - sc.delivered;

  // Terminal checks. Read live counts first so a kill from the previous tick lands.
  if (sc.destroyed >= sc.targetKills) {
    endScenario(state, "win", `Raid successful — ${sc.destroyed} of ${sc.freightersTotal} freighters sent to the deep.`);
    return;
  }
  if (combatCount(state, "player") === 0) {
    endScenario(state, "loss", "Your raiders were wiped out — the convoy sails on.");
    return;
  }
  if (state.time >= sc.timeLimit) {
    endScenario(state, "loss", "Out of time — the convoy slipped through your net.");
    return;
  }

  switch (sc.phase) {
    case "prep":
      sc.phaseTimer -= dt;
      if (sc.phaseTimer <= 0) startRaiderLeg(state, 0);
      break;

    case "travel": {
      const target = sc.route[sc.legIndex + 1];
      driveConvoy(state, live, target);
      // Arrived when every surviving freighter reaches the station.
      if (live.length && live.every(f => Math.hypot(f.x - target.x, f.y - target.y) <= STATION_RADIUS)) {
        sc.legsDone += 1;
        if (sc.legIndex + 1 >= sc.route.length - 1) {
          deliverRaiderConvoy(state, live);
        } else {
          sc.legIndex += 1;
          sc.phase = "docked";
          sc.phaseTimer = RAIDER_DOCK_TIME;
          sc.banner = `The convoy docks at station ${sc.legIndex} — hit it while it's stopped.`;
        }
      }
      break;
    }

    case "docked":
      for (const f of live) f.order = null;   // freighters hold; the escort still defends them
      sc.phaseTimer -= dt;
      if (sc.phaseTimer <= 0) startRaiderLeg(state, sc.legIndex);
      break;
  }
}

function startRaiderLeg(state, i) {
  const sc = state.scenario;
  sc.legIndex = i;
  sc.phase = "travel";
  const legNo = i + 1, legs = sc.route.length - 1;
  sc.banner = `Leg ${legNo}/${legs} — the convoy runs for the gate. Sink ${sc.targetKills} to win.`;
}

// Force-drive the AI convoy toward the next station: freighters plain-move (they
// never fight), escorts + support attack-move so they engage raiders met en route
// while staying with the convoy. Only (re)issue an order when it actually changed,
// so an escort mid-engagement isn't reset every tick.
function driveConvoy(state, freighters, target) {
  for (const f of freighters) {
    const o = f.order;
    if (!o || o.type !== "move" || o.x !== target.x || o.y !== target.y) f.order = { type: "move", x: target.x, y: target.y };
  }
  for (const u of state.units.values()) {
    if (u.owner !== "ai" || u.type === "freighter") continue;
    const role = UNITS[u.type].role;
    if (role !== "combat" && role !== "support") continue;
    const o = u.order;
    if (!o || o.type !== "attack-move" || o.x !== target.x || o.y !== target.y) {
      u.order = { type: "attack-move", x: target.x, y: target.y };
    }
  }
}

// The convoy reached the final gate: whatever survived escapes (delivered), and
// the mission settles on whether the kill quota was met. In practice a met quota
// already won above, so reaching the gate is the raider's loss condition.
function deliverRaiderConvoy(state, live) {
  const sc = state.scenario;
  sc.delivered = live.length;
  for (const f of live) state.units.delete(f.id);
  sc.destroyed = sc.freightersTotal - sc.delivered;
  const won = sc.destroyed >= sc.targetKills;
  endScenario(state, won ? "win" : "loss",
    won ? `The gate opens too late — ${sc.destroyed} freighters already lost.`
        : `The convoy reaches the gate — ${sc.delivered}/${sc.freightersTotal} freighters escaped you.`);
}

function computeRaiderScore(state, sc) {
  sc.escortsKilled = Math.max(0, sc.escortsTotal - combatCount(state, "ai"));
  sc.survivors = combatCount(state, "player");
  const won = sc.destroyed >= sc.targetKills;
  const s = sc.destroyed * RAIDER_SCORE.perFreighter
    + sc.escortsKilled * RAIDER_SCORE.perEscort
    + sc.survivors * RAIDER_SCORE.perSurvivor
    + (won ? RAIDER_SCORE.winBonus : 0)
    - Math.floor((sc.timeUsed || 0) / RAIDER_SCORE.timeDivisor);
  return Math.max(0, Math.round(s));
}

/* ============================================================
   BOUNTY MARSHAL — a seek-and-destroy hunt, not a convoy run. Pirate camps are
   scattered across the sector; you command a marshal's posse and must clear a
   quota of camps before the clock runs out. There is no route: the packs sit at
   their camps and defend (auto-acquiring anything that strays into range), so
   the player picks their targets and their order. With no input the clock simply
   expires with nothing cleared (a loss), which guarantees the mission terminates.
   ============================================================ */

// Build a Bounty Marshal game state on `planetId`. The posse musters at the
// centre of the map; pirate camps are scattered around it, each with a bounty.
export function setupBounty({ planetId = "ferros", seed = 1, difficulty = "medium", sizeMult = 1 } = {}) {
  const diff = BOUNTY_DIFFICULTY[difficulty] || BOUNTY_DIFFICULTY.medium;
  const state = createGameState({ planetId, seed, rng: mulberry32(seed >>> 0), sizeMult });
  state.units.clear();
  state.buildings.clear();

  const { width, height } = state.map;
  const rng = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const center = { x: width * 0.5, y: height * 0.5 };

  // The marshal's posse, mustered at the centre.
  let mi = 0;
  for (const [type, count] of Object.entries(diff.marshal)) {
    for (let k = 0; k < count; k++) {
      const u = makeUnit(type, "player", center.x + (mi % 4) * 28 - 42, center.y + Math.floor(mi / 4) * 28 - 14, state);
      state.units.set(u.id, u);
      mi++;
    }
  }

  // Scatter the pirate camps around the sector, spaced apart and clear of the
  // muster point, and spawn each camp's pack tagged with its packId.
  const packs = [];
  const placed = [center];
  for (let p = 0; p < diff.packs; p++) {
    const pos = scatterPoint(rng, width, height, placed);
    placed.push(pos);
    const bounty = 200 + Math.round(rng() * 160);
    packs.push({ id: p, x: pos.x, y: pos.y, bounty, cleared: false });
    let k = 0;
    for (const [type, count] of Object.entries(diff.packComp)) {
      for (let c = 0; c < count; c++) {
        const u = makeUnit(type, "ai", pos.x + (k % 3) * 26 - 26, pos.y + Math.floor(k / 3) * 26 - 13, state);
        u.packId = p;
        state.units.set(u.id, u);
        k++;
      }
    }
  }

  state.scenario = {
    type: "bounty",
    difficulty,
    phase: "prep",                 // prep → hunt → done
    phaseTimer: PREP_TIME,
    timeLimit: Math.round(diff.timeLimit * sizeMult),   // camps spread across the map, so the clock scales with it
    packs,
    totalPacks: diff.packs,
    packsCleared: 0,
    targetPacks: diff.targetPacks,
    bounty: 0,                     // total bounty banked from cleared camps
    survivors: 0,
    score: 0,
    outcome: null,                 // null | "win" | "loss"
    rng,
    playerStart: center,           // boot.js opens the camera on the posse
    banner: "Prep — survey the sector. Wanted camps are marked on the map.",
  };

  updateFog(state, state.fog, "player");
  updateFog(state, state.fogAI, "ai");
  return state;
}

// Pick a scattered camp position inside the map margins, as far as possible from
// every already-placed point (posse muster + earlier camps). Deterministic: all
// rolls come from the scenario RNG. Keeps the best of a bounded set of tries so a
// crowded map still terminates instead of looping forever.
function scatterPoint(rng, width, height, placed) {
  let best = null, bestD = -1;
  for (let t = 0; t < PACK_SCATTER_TRIES; t++) {
    const x = width * (0.14 + 0.72 * rng());
    const y = height * (0.14 + 0.72 * rng());
    let nearest = Infinity;
    for (const q of placed) nearest = Math.min(nearest, Math.hypot(q.x - x, q.y - y));
    if (nearest > bestD) { bestD = nearest; best = { x, y }; }
    if (nearest >= PACK_MIN_SEP) break;   // good enough — well clear of everything placed
  }
  return best;
}

function updateBounty(state, dt) {
  const sc = state.scenario;

  // Recompute each camp's live membership + centroid, so a marker tracks its pack
  // as it drifts, and a camp with no survivors is newly cleared.
  const alive = new Map();   // packId → { n, x, y }
  for (const u of state.units.values()) {
    if (u.owner !== "ai" || u.packId == null || u.hp <= 0) continue;
    const a = alive.get(u.packId) || { n: 0, x: 0, y: 0 };
    a.n++; a.x += u.x; a.y += u.y;
    alive.set(u.packId, a);
  }
  for (const pack of sc.packs) {
    if (pack.cleared) continue;
    const a = alive.get(pack.id);
    if (!a) {
      pack.cleared = true;
      sc.packsCleared += 1;
      sc.bounty += pack.bounty;
      sc.banner = `Bounty claimed — ${sc.packsCleared}/${sc.totalPacks} camps cleared (+${pack.bounty} 💰).`;
    } else {
      pack.x = a.x / a.n; pack.y = a.y / a.n;
    }
  }

  // Terminal checks. Clearing the quota wins immediately (clearing every camp is
  // just the quota-met case where all are down).
  if (sc.packsCleared >= sc.targetPacks) {
    const all = sc.packsCleared >= sc.totalPacks;
    endScenario(state, "win",
      all ? "Every camp cleared — the sector is yours, Marshal."
          : `Quota met — ${sc.packsCleared} camps cleared. The sector is secured.`);
    return;
  }
  if (combatCount(state, "player") === 0) {
    endScenario(state, "loss", "Your posse was wiped out — the outlaws hold the sector.");
    return;
  }
  if (state.time >= sc.timeLimit) {
    endScenario(state, "loss", `Time — only ${sc.packsCleared}/${sc.targetPacks} camps cleared.`);
    return;
  }

  // Prep is just a survey beat (the camps never move on their own); it flips to
  // the hunt banner and otherwise leaves the posse entirely to the player.
  if (sc.phase === "prep") {
    sc.phaseTimer -= dt;
    if (sc.phaseTimer <= 0) {
      sc.phase = "hunt";
      sc.banner = `Hunt — clear ${sc.targetPacks} of ${sc.totalPacks} pirate camps before the clock.`;
    }
  }
}

function computeBountyScore(state, sc) {
  sc.survivors = combatCount(state, "player");
  const timeLeft = Math.max(0, sc.timeLimit - (sc.timeUsed || 0));
  const s = sc.bounty
    + sc.survivors * BOUNTY_SCORE.perSurvivor
    + Math.floor(timeLeft) * BOUNTY_SCORE.timeBonusPerSec
    + (sc.outcome === "win" ? BOUNTY_SCORE.winBonus : 0);
  return Math.max(0, Math.round(s));
}

/* ---------- player actions (wired to the HUD) ---------- */

// Credits to fully repair every surviving player ship right now.
export function repairCost(state) {
  let missing = 0;
  for (const u of playerShips(state)) missing += Math.max(0, u.maxHp - u.hp);
  return Math.ceil(missing * REPAIR_COST_PER_HP);
}

// Repair the whole convoy + escort to full, once per stop, if the budget covers it.
export function repairConvoy(state) {
  const sc = state.scenario;
  if (!sc || sc.phase !== "docked" || sc.repairedThisStop) return false;
  const cost = repairCost(state);
  if (cost <= 0 || cost > sc.budget) return false;
  for (const u of playerShips(state)) u.hp = u.maxHp;
  sc.budget -= cost;
  sc.repairedThisStop = true;
  return true;
}

// Skip the rest of the dock timer and set off on the next leg.
export function departNow(state) {
  const sc = state.scenario;
  if (sc && sc.phase === "docked") sc.phaseTimer = 0;
}

/* ---------- helpers ---------- */

// The shared convoy lane: `legs + 1` stations evenly spaced left→right across the map (a leg is
// the gap between two neighbouring stations), all sitting on the map's vertical center. Escort
// and Raider both run a convoy along this exact lane — only which side owns the freighters
// differs — so both setup functions build their route through this one definition.
function buildRoute(width, height, legs) {
  const y = height * 0.5;
  const route = [];
  for (let i = 0; i <= legs; i++) route.push({ x: width * (0.08 + (0.86 * i) / legs), y });
  return route;
}

function liveFreighters(state) {
  const owner = state.scenario.freighterOwner;   // "player" in Escort, "ai" in Raider
  const out = [];
  for (const u of state.units.values()) if (u.owner === owner && u.type === "freighter") out.push(u);
  return out;
}
function playerShips(state) {
  const out = [];
  for (const u of state.units.values()) if (u.owner === "player") out.push(u);
  return out;
}
function combatCount(state, owner) {
  let n = 0;
  for (const u of state.units.values()) if (u.owner === owner && UNITS[u.type].role === "combat") n++;
  return n;
}
function centroid(list) {
  if (!list.length) return null;
  let x = 0, y = 0;
  for (const u of list) { x += u.x; y += u.y; }
  return { x: x / list.length, y: y / list.length };
}
function riskLabel(r) {
  return r < 0.45 ? "low" : r < 0.85 ? "moderate" : r < 1.2 ? "high" : "extreme";
}
