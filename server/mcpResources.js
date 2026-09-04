/* ============================================================
   T-055 (FR-16): "Static game reference... exposed as MCP resources, readable once rather than
   re-sent every turn." Deliberately the ONLY T-05x file with no lobby/getCache dependency — none
   of this content is per-match or per-seat, so createGameResources takes no arguments at all and
   is a pure function of the engine's own static tables. Reuses those tables directly
   (engine/entities.js's UNITS/BUILDINGS, engine/techtree.js's TECHS) rather than a hand-maintained
   second copy that could silently drift the next time a balance pass changes a number — the
   counter triangle in particular is DERIVED from each unit's own real `bonusVs` field, the exact
   data engine/combat.js's attackDamage reads, never a separately-authored description of it.

   Every field trimmed here is deliberately curated the same way
   server/mcpObservationTools.js's own trimEntity/optionFor are: enough for an agent to reason
   about strategy (cost, stats, prereqs, what a tech actually does), never internal mechanics an
   agent has no use for (radius, minerSoftCap, aggroRange's exact tuning, a tech's own multiplier
   field when `desc` already says in words what it does).
   ============================================================ */

"use strict";

import { UNITS, BUILDINGS } from "../engine/entities.js";
import { TECHS } from "../engine/techtree.js";

const UNIT_FIELDS = ["id", "name", "role", "hp", "attack", "range", "cooldown", "bonusVsBuildings", "speed", "sight", "cost", "altCost", "buildTime", "supplyCost", "requires", "odysseyOnly", "bonusVs"];
const BUILDING_FIELDS = ["id", "name", "hp", "cost", "buildTime", "produces", "category", "requires", "sight", "attack", "range", "cooldown"];
const TECH_FIELDS = ["id", "name", "cost", "time", "requires", "desc"];

function pick(def, fields) {
  const out = {};
  for (const f of fields) if (def[f] !== undefined) out[f] = def[f];
  return out;
}

function unitsResource() {
  const units = Object.values(UNITS).map(u => pick(u, UNIT_FIELDS));
  return {
    uri: "game://units", name: "units", title: "Unit stats",
    description: "Every unit type's combat/economy stats and build cost, straight from the engine's own definitions.",
    mimeType: "application/json", text: JSON.stringify(units),
  };
}

function buildingsResource() {
  const buildings = Object.values(BUILDINGS).map(b => pick(b, BUILDING_FIELDS));
  return {
    uri: "game://buildings", name: "buildings", title: "Building stats and build costs",
    description: "Every building type's cost, build time, and (for static defense) combat stats, straight from the engine's own definitions.",
    mimeType: "application/json", text: JSON.stringify(buildings),
  };
}

// Flattened directly out of each unit's own bonusVs table — never a hand-authored description of
// the triangle, so it can never drift from the real combat math (engine/combat.js's attackDamage
// reads this exact same UNITS[...].bonusVs). A unit with no bonusVs at all (e.g. the Breacher,
// deliberately outside the triangle) contributes no rows, rather than a synthesized zero-bonus row.
function countersResource() {
  const counters = [];
  for (const u of Object.values(UNITS)) {
    if (!u.bonusVs) continue;
    for (const [target, bonus] of Object.entries(u.bonusVs)) counters.push({ attacker: u.id, target, bonus });
  }
  return {
    uri: "game://counters", name: "counters", title: "Unit counter triangle",
    description: "Every unit type's real bonus-damage matchup against another type, derived from the same data the engine's own combat math uses.",
    mimeType: "application/json", text: JSON.stringify(counters),
  };
}

function techTreeResource() {
  const techs = Object.values(TECHS).map(t => pick(t, TECH_FIELDS));
  return {
    uri: "game://tech-tree", name: "tech-tree", title: "Research tech tree",
    description: "Every research node's cost, time, prerequisites, and effect, straight from the engine's own tech tree.",
    mimeType: "application/json", text: JSON.stringify(techs),
  };
}

/** @returns {Array<{uri:string,name:string,title:string,description:string,mimeType:string,text:string}>} */
export function createGameResources() {
  return [unitsResource(), buildingsResource(), countersResource(), techTreeResource()];
}
