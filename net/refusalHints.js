/* ============================================================
   net/refusalHints.js — turns a reject (code + optional machine-readable
   `reason`) into ONE short, action-oriented English sentence: what actually
   blocked the command, and what to do about it.

   Why this exists: the codec's codes are precise but mute. An agent that gets
   back `refused (prereq-not-met)` knows only that something is missing — not
   WHICH building — so its next move is a guess, usually the same command
   again. `requires a completed Foundry — build one first` ends that loop in
   one round trip. Same for `cannot-afford` (which commodity, how short),
   `supply-capped` (build a Habitat), and every coarse envelope-level code
   (`not-visible` -> scout it, `empty-selection` -> refresh your ids).

   PRESENTATION ONLY. Nothing here is a game rule, nothing here mutates state,
   and no caller branches on the text: the machine-readable `code`/`reason`
   pair is unchanged and stays the thing to switch on. This file just reads
   the same state the refusal already consulted and says it out loud, which is
   why it lives at the wire boundary (net/) rather than in engine/ — the engine
   has no notion of "an agent reading a tool result".
   ============================================================ */

"use strict";

import { BUILDINGS, UNITS, UPGRADES, prereqsMet } from "../engine/entities.js";
import { TECHS } from "../engine/techtree.js";
import { supplyUsed, supplyCap } from "../engine/supply.js";
import { COM } from "../data.js";

/* ---------- naming helpers (never throw on an id the caller made up) ---------- */

const buildingName = t => BUILDINGS[t]?.name || t;
const unitName     = t => UNITS[t]?.name || t;
const techName     = t => UPGRADES[t]?.name || TECHS[t]?.name || t;
const comName      = c => COM[c]?.name || c;
const list         = xs => xs.length <= 1 ? (xs[0] || "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

/** Which of `def.requires` this owner is still missing, named for a human. */
function missingPrereqs(state, owner, def) {
  const reqs = def?.requires || [];
  return reqs
    .filter(req => !prereqsMet(state, owner, { requires: [req] }))
    .map(req => BUILDINGS[req] ? `a completed ${buildingName(req)}` : `the ${techName(req)} upgrade`);
}

/** "80 ore (have 20)" for every commodity actually short — the whole point of the hint. */
function shortfall(resources, cost) {
  const short = Object.entries(cost || {})
    .filter(([com, qty]) => (resources?.[com] || 0) < qty)
    .map(([com, qty]) => `${Math.ceil(qty - (resources[com] || 0))} more ${comName(com)} (have ${Math.floor(resources[com] || 0)} of ${qty})`);
  return list(short);
}

/* ---------- the coarse codes (net/commandCodec.js REJECT) ---------- */

const BY_CODE = Object.freeze({
  "malformed":       "the command's fields are missing or the wrong type for this command — check the argument shape and re-send.",
  "unknown-type":    "no such command type — send one of the types this tool documents.",
  "not-owner":       "that entity belongs to another player (or you aimed a friendly-only order at an enemy) — re-read get_situation and pick ids you own.",
  "no-target":       "that target id no longer exists — it died, finished, or was never real; re-read get_situation for live ids.",
  "not-visible":     "that target is outside your vision — scout it or move a unit within sight range before targeting it.",
  "empty-selection": "none of those ids resolved to a live entity of yours — they died or you sent stale ids; re-read get_situation.",
  "too-many":        "too many ids or waypoints in one command — split the order across several commands.",
  "out-of-bounds":   "those coordinates are off the map — clamp x/y to the map width/height in get_situation.",
  "refused":         "the engine declined this order.",
  "bad-version":     "the envelope's protocol version does not match this server's — reconnect with a client built against the same protocol.",
  "rate-limited":    "you are issuing commands faster than the per-seat budget allows — pace your orders and retry shortly.",
  "command-timeout": "the match worker never acknowledged the command — the match may be ending; re-read get_situation before retrying.",
});

/* ---------- the REFUSED reasons (engine/*RefusalReason) ---------- */

/** @returns {string|null} */
function refusedHint(state, owner, command, reason) {
  const c = command || {};
  switch (reason) {
    case "no-such-worker":
      return "that worker is gone — pick a live worker id from get_situation.";
    case "no-such-building":
      return "that building is gone — pick a live building id from get_situation.";
    case "unknown-building-type":
      return `no building type "${c.b}" exists — use one of the ids in the build catalogue.`;
    case "unknown-unit-type":
      return `no unit type "${c.u}" exists — use one of the ids the producing building lists.`;
    case "unknown-upgrade":
    case "unknown-tech":
      return `no research "${c.up ?? c.tech}" exists — use one of the ids the research catalogue lists.`;
    case "odyssey-only-building":
      return `the ${buildingName(c.b)} only exists in Odyssey (endless) mode — it cannot be built in a skirmish.`;
    case "odyssey-only-unit":
      return `the ${unitName(c.u)} only exists in Odyssey (endless) mode — it cannot be trained in a skirmish.`;
    case "unit-cannot-build-this-category": {
      const worker = state.units.get(c.worker);
      const cat = BUILDINGS[c.b]?.category;
      return `a ${unitName(worker?.type)} cannot found ${cat} buildings — order a Worker to build the ${buildingName(c.b)} instead.`;
    }
    case "cannot-afford": {
      const { resources, cost } = costContext(state, owner, command);
      const gap = cost ? shortfall(resources, cost) : "";
      return gap ? `you need ${gap} — gather or trade for it before re-issuing.`
                 : "you cannot afford this yet — gather or trade for the missing commodity first.";
    }
    case "prereq-not-met": {
      const def = prereqDef(state, command);
      const missing = missingPrereqs(state, owner, def);
      return missing.length
        ? `it requires ${list(missing)} — build or research that first, and wait for it to FINISH (a site still under construction does not count).`
        : "a prerequisite is not met yet — finish its prerequisite building or upgrade first.";
    }
    case "invalid-placement":
      return `a ${buildingName(c.b)} does not fit at (${Math.round(c.x)}, ${Math.round(c.y)}) — the ground is blocked by terrain, a resource node, or another building's footprint; try a clear spot a little further out.`;
    case "building-under-construction":
      return "that building is still under construction — send workers to assist it (assistBuild) and re-issue once it completes.";
    case "building-cannot-produce-this-unit": {
      const b = state.buildings.get(c.building);
      const can = BUILDINGS[b?.type]?.produces || [];
      return `a ${buildingName(b?.type)} cannot train the ${unitName(c.u)}${can.length ? ` — it trains ${list(can.map(unitName))}` : ""}; queue this unit at the building that produces it.`;
    }
    case "supply-capped": {
      const b = state.buildings.get(c.building);
      const o = b ? b.owner : owner;
      const need = UNITS[c.u]?.supplyCost || 0;
      return `supply is capped (${supplyUsed(state, o)}/${supplyCap(state, o)}, this unit needs ${need}) — build a Habitat (or another Command Center) to raise the cap first.`;
    }
    case "wrong-building-for-research": {
      const b = state.buildings.get(c.building);
      const where = c.up !== undefined ? "a Refinery" : "a Datacenter";
      return `research is queued at ${where}, not at a ${buildingName(b?.type)} — re-issue against ${where} you own.`;
    }
    case "already-researched":
      return `${techName(c.up ?? c.tech)} is already researched — it is live now, no need to re-order it.`;
    case "already-queued":
      return `${techName(c.up ?? c.tech)} is already in that building's research queue — wait for it to finish.`;
    case "doctrine-locked":
      return `you are already committed to the other doctrine, so ${techName(c.up)} is permanently locked this match — spend on your committed doctrine's line instead.`;
    case "no-such-job":
      return "there is no job at that queue index — re-read the building's queue and cancel by its current index.";
    case "not-a-bomb":
      return "that unit is not a bomb — only a bomb unit can have its fuse lit.";
    case "bomb-not-armed":
      return "that bomb is not armed yet — arm it before lighting the fuse.";
    case "fuse-already-lit":
      return "that bomb's fuse is already burning — it will detonate on its own.";
    default:
      return null;
  }
}

/** The resources/cost pair behind a `cannot-afford`, per command type. */
function costContext(state, owner, c) {
  if (c.t === "build") {
    const worker = state.units.get(c.worker);
    const o = worker ? worker.owner : owner;
    return { resources: state.players[o]?.resources, cost: BUILDINGS[c.b]?.cost };
  }
  const b = state.buildings.get(c.building);
  const o = b ? b.owner : owner;
  const resources = state.players[o]?.resources;
  if (c.t === "queueProduction") {
    const def = UNITS[c.u];
    return { resources, cost: (c.alt && def?.altCost) ? def.altCost : def?.cost };
  }
  if (c.t === "researchUpgrade") return { resources, cost: UPGRADES[c.up]?.cost };
  if (c.t === "researchTech")    return { resources, cost: TECHS[c.tech]?.cost };
  return { resources, cost: null };
}

/** The def whose `requires` a `prereq-not-met` refers to, per command type. */
function prereqDef(state, c) {
  if (c.t === "build")            return BUILDINGS[c.b];
  if (c.t === "queueProduction")  return UNITS[c.u];
  if (c.t === "researchUpgrade")  return UPGRADES[c.up];
  if (c.t === "researchTech")     return TECHS[c.tech];
  return null;
}

/**
 * The action-oriented line for a coarse reject code alone, with no state or command in hand —
 * the shape-rejection path (server/matchWorker.js's admit() reply) never reaches the codec, so
 * there is nothing state-dependent to say about it.
 * @param {string} code @returns {string}
 */
export function hintForCode(code) {
  return BY_CODE[code] || "the command was rejected — re-read get_situation and re-issue against current state.";
}

/**
 * One action-oriented sentence for a rejected command. Never throws, and always returns
 * something usable — an unknown code still gets the generic "here is what to check" line.
 * @param {Object} state live match state (read-only)
 * @param {string} owner the seat that submitted the command
 * @param {Object} command the WireCommand that was rejected (its fields name what was refused)
 * @param {{code?: string, reason?: string}} reject
 * @returns {string}
 */
export function hintFor(state, owner, command, reject) {
  const code = reject?.code;
  const reason = reject?.reason;
  try {
    if (code === "refused" && reason) {
      const detail = refusedHint(state, owner, command, reason);
      if (detail) return detail;
      return `the engine declined this order (${reason}).`;
    }
    return hintForCode(code);
  } catch {
    // A hint is never worth failing a command result over: fall back to the coarse line.
    return BY_CODE[code] || "the command was rejected.";
  }
}
