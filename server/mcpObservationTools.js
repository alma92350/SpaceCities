/* ============================================================
   T-052 (FR-14): get_situation / list_entities / get_map_overview / get_tech_options (plus
   get_counters, the static counter triangle — see its own comment for why it is a tool as well as
   an MCP resource). Every one
   of these is built on `cache.latestProjFor(owner)` — server/mcpObservationCache.js's remembered
   copy of engine/projection.js's own projectFor(state, owner) output, already fog-filtered by
   the SAME mechanism every real WebSocket push already goes through. Nothing here re-implements
   fog logic, re-reads a raw unit/building, or reaches into a worker's live state directly — this
   file only SUMMARIZES an already-safe projection into a compact, model-digestible shape (this
   task's own exit criterion: "digest fits a reasonable context").

   TECHS is deliberately left out of get_tech_options' own output (an always-empty `techs: []`,
   not a missing field) — see that tool's own comment for why: `proj` carries no signal for
   whether this match is even Odyssey/endless mode, and this whole port's own scope question
   (TASKS.md's Q3, "is multiplayer Odyssey a wanted v2?") is still open. Threading that signal
   through would mean touching engine/projection.js's own security-critical, already-extensively-
   tested wire shape for a feature this port doesn't yet commit to exposing over MCP at all —
   real work for a later task if Odyssey-over-MCP is ever decided, not a silent gap here.
   ============================================================ */

"use strict";

import { withSeat, rejection } from "./mcpSeatHandle.js";
import { SPECTATOR_SEAT } from "../engine/projection.js";
import { UNITS, BUILDINGS, prereqsMet, canAfford } from "../engine/entities.js";

// Every observation tool needs the SAME two things before it can do anything: a resolved seat
// (withSeat's own job) and THAT SEAT'S OWN match's latest cached projection. `getCache(matchId)`
// looks up the right live match's own cache — a production server hosts many concurrent matches,
// each in its own worker with its own independent projection cache (server/mcpObservationCache.js),
// so a single fixed cache reference would silently answer every seat with the WRONG match's data
// the moment a second match existed. Composing this here means no tool handler below hand-rolls
// either the match lookup or the "no state yet" check separately.
function seatAndProj(getCache, handler) {
  return ({ seat, ...rest }) => {
    const cache = getCache(seat.matchId);
    if (!cache) return rejection("match-not-live: this match hasn't started yet — every seat must be filled before there is a world to observe; poll list_matches, or wait and retry");
    // A watch handle's own `owner` IS the spectator pseudo-seat, so this same lookup reaches
    // engine/projection.js's deliberately unfiltered projectForSpectator stream with no special
    // case here — the fog difference lives entirely in which projection the worker built, never
    // in this file.
    const proj = cache.latestProjFor(seat.owner);
    if (!proj) return rejection("no-state-yet: this match's worker hasn't reported in yet — try again shortly");
    return handler({ seat, proj, cache, ...rest });
  };
}

function countByType(items) {
  const out = {};
  for (const it of items) out[it.type] = (out[it.type] || 0) + 1;
  return out;
}

// What an entity IS and what it is DOING. id/type/owner/x/y/hp are the presence-and-health fields
// this always returned; `activity` and `orderTarget` are new and OWN-ENTITIES-ONLY, because
// engine/projection.js's stripIntel already blanks an enemy's order before it ever reaches this
// file (an enemy's intent is exactly what fog is not supposed to reveal) — so reading them off a
// foreign entity would report a uniform, meaningless "idle" for every enemy on the map. Without
// them there was no way at all to ask "which of my workers is standing still?": a worker whose
// seam ran dry just stopped, indistinguishable in this payload from one mining at full rate, and
// an economy could quietly rot for the rest of the match.
//
// `activity` is deliberately a small, closed vocabulary derived from the order the engine actually
// stores, not the raw order shape: gathering/moving/attacking/building/idle, plus the order's own
// type verbatim for anything outside that set, so a new engine order type degrades to its own name
// rather than being mislabelled as idle.
const ACTIVITY = {
  gather: "gathering", move: "moving", attackMove: "moving", patrol: "moving",
  attack: "attacking", build: "building", assistBuild: "building",
};

function activityOf(e) {
  if (e.constructing) return "under-construction";
  if (e.kind === "building") return (e.queue && e.queue.length) ? "producing" : "idle";
  if (!e.order) return "idle";
  return ACTIVITY[e.order.type] || e.order.type;
}

function trimEntity(e, own) {
  const base = { id: e.id, type: e.type, owner: e.owner, x: e.x, y: e.y, hp: e.hp };
  if (!own) return base;
  return {
    ...base,
    activity: activityOf(e),
    // The order's own target, flattened to whichever id/point it actually carries — enough to tell
    // two gathering workers on different nodes apart without shipping the raw order object.
    orderTarget: orderTargetOf(e),
    // A gatherer's CARGO and which leg of the haul cycle it is on. "activity" alone reports
    // "gathering" for a worker mining, one walking to the seam, and one wedged halfway home with a
    // full hold — three states an agent has to tell apart to notice its economy has stopped. With
    // these, "gathering / toDrop / cargo 10" that never changes is a diagnosis; without them it was
    // indistinguishable from a worker doing its job. Own entities only, like everything here:
    // projection.js's stripIntel has already blanked an enemy's order before this file sees it.
    ...(e.cargo && e.cargo.qty > 0 ? { cargo: { com: e.cargo.com, qty: e.cargo.qty } } : {}),
    ...(e.order && e.order.type === "gather" && e.order.phase ? { gather_phase: e.order.phase } : {}),
    ...(e.queue ? { queue: e.queue.map(j => j.unitType) } : {}),
    ...(e.constructing ? { buildProgress: e.buildProgress } : {}),
  };
}

function orderTargetOf(e) {
  const o = e.order;
  if (!o) return null;
  if (o.nodeId) return { nodeId: o.nodeId };
  if (o.targetId) return { entityId: o.targetId };
  if (o.buildingId) return { entityId: o.buildingId };
  if (typeof o.x === "number") return { x: o.x, y: o.y };
  return null;
}

// prereqsMet(state, owner, def) needs state.players[owner] (upgrades) and to scan
// state.buildings.values() for a completed prerequisite — both fully answerable from this seat's
// OWN slice of `proj` (always complete/unfiltered for its own owner), so a deliberately narrower
// State-shaped object works here exactly the way engine/projection.js's own reassembleProjection
// already builds one for updateFog — never the full State, only the two fields the callee reads.
function miniStateFor(proj, owner) {
  const ownBuildings = proj.buildings.filter(b => b.owner === owner);
  return { players: proj.players, buildings: new Map(ownBuildings.map(b => [b.id, b])) };
}

// WHICH prerequisites are missing, using exactly the same rule prereqsMet itself applies (a
// required BUILDING must exist, owned and finished; anything else is an upgrade key on the player)
// — deliberately re-derived per requirement here rather than changing prereqsMet's own boolean
// contract, which the engine, the AI and the UI all depend on.
function missingPrereqs(miniState, owner, def) {
  const reqs = def.requires || [];
  return reqs.filter(req => !prereqsMet(miniState, owner, { requires: [req] }));
}

// The stats an agent needs for combat and build-order math. Read straight off the engine's own
// definitions — the same objects engine/combat.js computes damage from — so a balance change can
// never leave this reporting a stale hand-copied number.
const STAT_FIELDS = ["hp", "attack", "range", "cooldown", "speed", "sight", "buildTime", "supplyCost", "role", "bonusVs", "bonusVsBuildings", "cargoCap", "gatherRate", "altCost"];

function statsOf(def) {
  const out = {};
  for (const f of STAT_FIELDS) if (def[f] !== undefined) out[f] = def[f];
  return out;
}

// Every building type whose own `produces` list contains this unit — the authoritative answer to
// "where do I train this?", and the only honest way to report a unit no building produces at all.
function producersOf(unitType) {
  return Object.values(BUILDINGS).filter(b => b.produces?.includes(unitType)).map(b => b.id);
}

// ===== Economy flow, and the worker line's exposure (agent-observability) =====
// A projection reports a STOCK ("you have 150 ore"); a build order is paid out of a FLOW. Both
// recorded matches were decided in this gap — one agent ran its economy into the ground without
// ever noticing, because a treasury that has stopped growing looks exactly like one that is about
// to pay for the next unit. Everything below is derived from the same projections the cache is
// already keeping, plus this seat's own bases; nothing new is fetched and nothing is invented.

// A gatherer this far from its nearest base is out where a raider finds it first. Sized against
// the real thing that kills worker lines: engine/gather.js's own RETARGET_RADIUS lets a depleted
// worker re-task several hundred units away, one depletion at a time, and this is the distance at
// which that walk has left the seat's own defended ground.
const WORKER_RISK_DISTANCE = 700;
// How recent an enemy sighting has to be for a worker near it to count as threatened rather than
// merely far from home.
const THREAT_RECENCY_SECONDS = 45;
const THREAT_RADIUS = 400;

function economyFor(proj, seat, cache) {
  const own = proj.units.filter(u => u.owner === seat.owner);
  const gatherers = own.filter(u => u.order?.type === "gather");
  const bases = proj.buildings.filter(b => b.owner === seat.owner && BUILDINGS[b.type]?.isCommandCenter);
  const distToBase = (x, y) => bases.length ? Math.round(Math.min(...bases.map(b => Math.hypot(b.x - x, b.y - y)))) : null;
  const threats = (cache.lastSeenFor?.(seat.owner) ?? []).filter(e => e.age_seconds <= THREAT_RECENCY_SECONDS);
  const atRisk = gatherers
    .map(u => ({ id: u.id, x: u.x, y: u.y, distance_from_base: distToBase(u.x, u.y),
                 near_enemy: threats.find(t => Math.hypot(t.x - u.x, t.y - u.y) <= THREAT_RADIUS)?.id ?? null }))
    .filter(w => w.near_enemy !== null || (w.distance_from_base ?? 0) > WORKER_RISK_DISTANCE);
  const income = cache.incomeFor?.(seat.owner) ?? null;
  return {
    ...(income ? { income_per_min: income.per_min, income_window_seconds: income.window_seconds } : { income_per_min: null }),
    gatherers: gatherers.length,
    idle_workers: own.filter(u => UNITS[u.type]?.gatherRate && !u.order).length,
    // WHICH workers are exposed, not merely how many: the answer has to name units to be
    // actionable, and re-tasking them is one gather command.
    workers_at_risk: atRisk,
  };
}

// How long this seat's CURRENT income needs to cover a cost it cannot pay yet. null when it is
// already affordable, and null (never a comforting number) when the seat is not earning the
// commodity at all — "you will never afford this on this economy" is the answer that matters.
function secondsUntilAffordable(cost, resources, incomePerMin) {
  if (!cost || canAfford(resources, cost)) return null;
  if (!incomePerMin) return null;
  let worst = 0;
  for (const [com, amount] of Object.entries(cost)) {
    const short = amount - (resources[com] ?? 0);
    if (short <= 0) continue;
    const rate = incomePerMin[com] ?? 0;
    if (rate <= 0) return null;
    worst = Math.max(worst, (short / rate) * 60);
  }
  return Math.round(worst);
}

// ===== Engagement estimate (agent-observability) =====
// Deliberately a simple sustained-damage model over the engine's OWN unit table: total effective
// dps each side deals the other (attack + bonusVs the actual composition facing it, divided by
// cooldown) against total hp. It ignores range, pathing, terrain, upgrades, veterancy, focus fire
// and reinforcement — and says so, loudly, in the tool's own description — because the question it
// exists to answer is not "simulate this fight", it is the one both recorded matches got wrong:
// "is this a fight I am currently losing?" One agent fed single Lancers into a four-unit ball
// three times running; the counter table it had already read could not answer that, because a
// counter bonus says nothing about a 1-vs-4.
function sideDps(attackers, defenders) {
  const defenderMix = {};
  for (const d of defenders) defenderMix[d.type] = (defenderMix[d.type] || 0) + 1;
  const total = defenders.length || 1;
  let dps = 0;
  for (const a of attackers) {
    const def = UNITS[a.type] ?? BUILDINGS[a.type];
    if (!def || !def.attack || !def.cooldown) continue;
    // Averaged over the composition actually present, so a bonus counts for exactly the share of
    // the enemy it applies to rather than all of it.
    let bonus = 0;
    for (const [type, count] of Object.entries(defenderMix)) bonus += ((def.bonusVs?.[type] ?? 0) * count) / total;
    dps += (def.attack + bonus) / def.cooldown;
  }
  return dps;
}

function estimateFight(mine, theirs) {
  const myHp = mine.reduce((sum, e) => sum + (e.hp ?? 0), 0);
  const theirHp = theirs.reduce((sum, e) => sum + (e.hp ?? 0), 0);
  const myDps = sideDps(mine, theirs), theirDps = sideDps(theirs, mine);
  const myTimeToKill = myDps > 0 ? theirHp / myDps : Infinity;
  const theirTimeToKill = theirDps > 0 ? myHp / theirDps : Infinity;
  if (myTimeToKill === Infinity && theirTimeToKill === Infinity) {
    return { predicted_winner: "neither", note: "neither side can damage the other" };
  }
  const winner = myTimeToKill < theirTimeToKill ? "you" : myTimeToKill > theirTimeToKill ? "enemy" : "too close to call";
  // The margin is what makes this usable as a go/no-go: a 1.1x edge is a coin flip once terrain
  // and arrival order are in play, a 2x edge is a decision.
  const ratio = theirTimeToKill === Infinity ? Infinity : myTimeToKill === Infinity ? 0 : theirTimeToKill / myTimeToKill;
  return {
    predicted_winner: winner,
    margin: ratio === Infinity ? null : Math.round(ratio * 100) / 100,
    confidence: ratio === Infinity || ratio === 0 ? "high" : (ratio > 1.5 || ratio < 0.67) ? "high" : "low",
    your_dps: Math.round(myDps * 10) / 10, enemy_dps: Math.round(theirDps * 10) / 10,
    your_hp: Math.round(myHp), enemy_hp: Math.round(theirHp),
    seconds_to_kill_enemy: myTimeToKill === Infinity ? null : Math.round(myTimeToKill),
    seconds_to_lose_your_force: theirTimeToKill === Infinity ? null : Math.round(theirTimeToKill),
  };
}

/**
 * @param {Object} lobby a createLobby() instance
 * @param {(matchId:string) => {latestProjFor:(owner:string)=>Object|null}|null} getCache looks up
 *   a LIVE match's own projection cache by id (tools/serve.js's own liveMatches, keyed the same
 *   way) — null for a match that hasn't started yet (no worker, so no cache exists at all).
 */
export function createObservationTools(lobby, getCache) {
  return [
    {
      name: "get_situation",
      title: "Get current situation",
      description: "A compact status summary for the calling seat: match tick/time, whether it has ended, own resources and supply, own unit/building counts by type, which of your units are currently IDLE (idle_unit_ids — check this every turn, an idle worker is the commonest way a match quietly rots), who you are and who you're playing, and the map's bounds and tick rate. For individual entity detail (including visible enemies), use list_entities instead.",
      inputSchema: { type: "object", properties: { seat_handle: { type: "string" } }, required: ["seat_handle"] },
      handler: withSeat(lobby, seatAndProj(getCache, ({ seat, proj, cache }) => {
        // A watcher holds no seat, so "your resources" has no referent — it gets the per-owner
        // scoreboard for EVERY side instead, which is the whole reason to watch a match rather
        // than play it. Everything below this branch is the unchanged per-seat answer.
        if (seat.owner === SPECTATOR_SEAT) {
          const meta = cache.mapMeta?.() ?? null;
          const sides = proj.owners.map(o => ({
            owner: o,
            resources: proj.players[o]?.resources ?? null,
            supply: proj.players[o]?.supply ?? null, supply_cap: proj.players[o]?.supplyCap ?? null,
            units_by_type: countByType(proj.units.filter(u => u.owner === o)),
            buildings_by_type: countByType(proj.buildings.filter(b => b.owner === o)),
          }));
          return {
            content: [{ type: "text", text: `Watching: tick ${proj.tick} (t=${proj.time.toFixed(1)}s)${proj.over ? `, match over — winner: ${proj.winner ?? "none"}` : ""}. ${sides.map(s2 => `${s2.owner}: ${proj.units.filter(u => u.owner === s2.owner).length}u`).join(", ")}.` }],
            structuredContent: {
              tick: proj.tick, time: proj.time, over: proj.over, winner: proj.winner,
              watching: true, owners: proj.owners, sides,
              ...(meta ? { map: meta.map } : {}),
            },
          };
        }
        const ownUnits = proj.units.filter(u => u.owner === seat.owner);
        const ownBuildings = proj.buildings.filter(b => b.owner === seat.owner);
        // Idle own units are called out as their own number and id list rather than left for the
        // caller to derive from list_entities: an idle worker is the single most common way a
        // match quietly rots (a drained node retargets to nothing and the worker just stops), and
        // nothing in this summary used to hint at it.
        const idle = ownUnits.filter(u => activityOf(u) === "idle");
        const meta = cache.mapMeta?.() ?? null;
        const economy = economyFor(proj, seat, cache);
        const atRisk = economy.workers_at_risk.length;
        return {
          content: [{ type: "text", text: `Tick ${proj.tick} (t=${proj.time.toFixed(1)}s)${proj.over ? ", match over" : ""}. ${ownUnits.length} units (${idle.length} idle), ${ownBuildings.length} buildings.${economy.income_per_min ? ` Income/min: ${Object.entries(economy.income_per_min).map(([c, r]) => `${c} ${r}`).join(", ")}.` : ""}${atRisk ? ` ${atRisk} gatherer(s) exposed.` : ""}` }],
          structuredContent: {
            tick: proj.tick, time: proj.time, over: proj.over, winner: proj.winner,
            resources: proj.players[seat.owner].resources,
            supply: proj.players[seat.owner].supply, supply_cap: proj.players[seat.owner].supplyCap,
            units_by_type: countByType(ownUnits),
            buildings_by_type: countByType(ownBuildings),
            idle_unit_ids: idle.map(u => u.id),
            // The FLOW behind the stock above, plus which gatherers are standing somewhere that
            // gets them killed — see economyFor's own comment for why a stock alone loses matches.
            economy,
            // Who this seat actually IS, and who it is playing against — an agent previously had to
            // infer even "the enemy is west" from where one of its workers happened to die.
            you: seat.owner, opponents: proj.owners.filter(o => o !== seat.owner),
            ...(meta ? { map: meta.map } : {}),
          },
        };
      })),
    },
    {
      name: "list_entities",
      title: "List visible entities",
      description:
        "Lists every unit/building currently visible to the calling seat — its own, always, plus any enemy's currently " +
        "inside its fog of war. Each entry carries id/type/owner/x/y/hp; your OWN entities also carry what they are " +
        "currently doing (activity, orderTarget, a gatherer's cargo and gather_phase, a producer's queue, a " +
        "site's buildProgress) — an enemy's never does, " +
        "since fog does not reveal intent. Optionally filter by owner or type to narrow a large list, or pass " +
        "since_tick to get back only what has CHANGED since a tick you already read (plus removed_ids), which is how " +
        "to poll a long match without re-reading the whole world every time. " +
        "AN EMPTY ENEMY LIST MEANS YOU CANNOT SEE THEM, NEVER THAT THEY ARE GONE: enemy_currently_visible says which " +
        "it is, and enemy_last_seen carries every enemy this seat has ever had in fog with how many seconds stale " +
        "each sighting is. Never conclude a match is won from this tool — get_situation's own `over`/`winner` and " +
        "get_match_report are the only things that decide that.",
      inputSchema: {
        type: "object",
        properties: {
          seat_handle: { type: "string" },
          owner: { type: "string", description: "Only entities belonging to this owner id" },
          type: { type: "string", description: "Only entities of this unit/building type" },
          activity: { type: "string", description: "Only your OWN entities currently doing this: idle, gathering, moving, attacking, building, producing, under-construction. Use 'idle' to find units that have stopped working." },
          since_tick: { type: "number", description: "Only entities whose position/health/activity changed after this tick, plus removed_ids for ones that vanished. Pass the `tick` from your last read. If no delta is available for that tick you get the full list back with delta_available:false." },
        },
        required: ["seat_handle"],
      },
      handler: withSeat(lobby, seatAndProj(getCache, ({ seat, proj, cache, owner, type, activity, since_tick }) => {
        let entities = [...proj.units, ...proj.buildings];
        if (owner) entities = entities.filter(e => e.owner === owner);
        if (type) entities = entities.filter(e => e.type === type);
        // A watcher's projection is unfiltered by construction, so every entity in it carries its
        // real order — reporting activity/orderTarget for all of them reveals nothing the watcher
        // was not already handed, and withholding it would just make the watch view strictly worse
        // than the raw data behind it.
        let trimmed = entities.map(e => trimEntity(e, seat.owner === SPECTATOR_SEAT || e.owner === seat.owner));
        // Filtering on activity happens AFTER the trim, since activity is only ever computed for
        // this seat's own entities (an enemy's order is stripped by the projection itself) — so
        // this filter deliberately narrows to own entities, which is the only case it can answer.
        if (activity) trimmed = trimmed.filter(e => e.activity === activity);
        // A delta the cache cannot honestly produce (a tick it has no history for, a seat it has
        // only just started tracking) returns the FULL list with delta_available:false, never a
        // silently empty one — which a caller would read as "nothing changed".
        const delta = Number.isFinite(since_tick) ? (cache.changesSince?.(seat.owner, since_tick) ?? null) : null;
        if (delta) trimmed = trimmed.filter(e => delta.changed.has(e.id));
        const lastSeen = seat.owner === SPECTATOR_SEAT ? [] : (cache.lastSeenFor?.(seat.owner) ?? []);
        const visibleEnemies = [...proj.units, ...proj.buildings].filter(e => e.owner !== seat.owner);
        return {
          content: [{ type: "text", text: `${trimmed.length} ${delta ? `changed since tick ${since_tick}` : "visible"} entities.${seat.owner === SPECTATOR_SEAT ? "" : ` ${visibleEnemies.length} enemy entities in fog right now${visibleEnemies.length === 0 && lastSeen.length ? ` — ${lastSeen.length} remembered from earlier sightings, NOT proof they are gone` : ""}.`}` }],
          structuredContent: {
            entities: trimmed,
            ...(Number.isFinite(since_tick) ? { delta_available: !!delta, ...(delta ? { removed_ids: delta.removed } : {}) } : {}),
            ...(seat.owner === SPECTATOR_SEAT ? {} : {
              enemy_currently_visible: visibleEnemies.length > 0,
              enemy_last_seen: lastSeen,
            }),
          },
        };
      })),
    },
    {
      name: "get_map_overview",
      title: "Get map overview",
      description:
        "Every resource node this seat has discovered — id, WHICH COMMODITY it yields (ore/crystal/relic/...), " +
        "its position, its current and maximum amount, and how far it is from your nearest base, nearest first — " +
        "plus every currently-visible base's owner and position and the map's own bounds. A node this seat has " +
        "never explored, or an enemy base outside its fog, never appears. Use this before sending a worker: " +
        "\"the closest ore\" is answerable from `nodes` alone, without scouting each node by hand.",
      inputSchema: { type: "object", properties: { seat_handle: { type: "string" } }, required: ["seat_handle"] },
      handler: withSeat(lobby, seatAndProj(getCache, ({ seat, proj, cache }) => {
        const bases = proj.buildings
          .filter(b => BUILDINGS[b.type]?.isCommandCenter)
          .map(b => ({ owner: b.owner, x: b.x, y: b.y }));
        const ownBases = bases.filter(b => b.owner === seat.owner);
        const distanceFromBase = (x, y) => {
          if (!ownBases.length || typeof x !== "number") return null;
          return Math.round(Math.min(...ownBases.map(b => Math.hypot(b.x - x, b.y - y))));
        };
        // engine/projection.js reduces an ordinary node to {id, amount} — everything else about it
        // is deterministic from the seed a browser client already has, but an MCP agent has no map
        // generator, so it could only learn a node's commodity by walking a worker to it and
        // watching which counter moved. The static half is merged back in here from the match's
        // own describeMap reply (server/mcpObservationCache.js). A wreck or crater node already
        // arrives in full (it does not exist in the seeded map at all), so its own fields win.
        // The merge is keyed by the ids in THIS seat's own fog-filtered proj.nodes, so an
        // undiscovered node stays absent exactly as before — this adds detail, never nodes.
        const meta = cache.mapMeta?.() ?? null;
        const nodes = proj.nodes.map(n => {
          const stat = meta?.nodesById.get(n.id);
          const merged = { ...(stat || {}), ...n };
          const dist = distanceFromBase(merged.x, merged.y);
          return {
            id: merged.id, com: merged.com ?? null, amount: merged.amount,
            max: merged.max ?? null, x: merged.x ?? null, y: merged.y ?? null,
            ...(merged.wreck ? { wreck: true } : {}), ...(merged.crater ? { crater: true } : {}),
            ...(dist === null ? {} : { distance_from_base: dist }),
          };
        }).sort((a, b) => (a.distance_from_base ?? Infinity) - (b.distance_from_base ?? Infinity) || (a.id < b.id ? -1 : 1));
        const live = nodes.filter(n => n.amount > 0);
        return {
          content: [{ type: "text", text: `${nodes.length} discovered resource node(s) (${live.length} not yet depleted), ${bases.length} visible base(s).` }],
          structuredContent: {
            nodes, bases,
            ...(meta ? { map: meta.map } : {}),
            // Which commodities this seat can actually reach right now, cheapest possible check for
            // "can I even afford to plan a turret?" before committing a 40-second worker haul.
            commodities_available: [...new Set(live.map(n => n.com).filter(Boolean))].sort(),
          },
        };
      })),
    },
    {
      name: "get_tech_options",
      title: "Get buildable units and buildings",
      description:
        "Every unit and building type with everything needed to decide whether to build it: cost, full combat/economy " +
        "stats (hp, attack, range, speed, build time, supply), which building produces it, whether this seat meets its " +
        "prerequisites (and if not, exactly which ones are missing), whether it can currently afford it and, when it " +
        "cannot yet, how many seconds this seat's MEASURED income needs to get there (seconds_until_affordable — " +
        "absent when the current economy would never get there at all). A type " +
        "needing a building or upgrade this match doesn't have reads prereqs_met:false rather than being omitted, so " +
        "the list stays a complete reference. Odyssey-only research is not included over this transport yet.",
      inputSchema: { type: "object", properties: { seat_handle: { type: "string" } }, required: ["seat_handle"] },
      handler: withSeat(lobby, seatAndProj(getCache, ({ seat, proj, cache }) => {
        // "What can I afford, and do I meet its prerequisites" is a question only a seat has —
        // a watcher owns no buildings and no resources to answer it against.
        if (seat.owner === SPECTATOR_SEAT) return rejection("watch-only-handle: build options are per-seat; join a match to ask this");
        const miniState = miniStateFor(proj, seat.owner);
        const resources = proj.players[seat.owner].resources;
        const supplyRoom = (proj.players[seat.owner].supplyCap ?? 0) - (proj.players[seat.owner].supply ?? 0);
        const incomePerMin = cache.incomeFor?.(seat.owner)?.per_min ?? null;
        const optionFor = def => {
          const cost = def.cost || {};
          const producers = UNITS[def.id] ? producersOf(def.id) : null;
          return {
            type: def.id, name: def.name, cost,
            prereqs_met: prereqsMet(miniState, seat.owner, def),
            // WHICH prerequisite is missing, not just that one is — "prereqs_met:false" alone left a
            // caller with no next action, since the requirement isn't visible anywhere else either.
            missing_prereqs: missingPrereqs(miniState, seat.owner, def),
            affordable: canAfford(resources, cost),
            // "Affordable in 31s" is a schedule; "affordable:false" is a dead end. Absent when it
            // is already affordable, and absent (never a reassuring number) when this seat's
            // current income will never get there — see secondsUntilAffordable.
            ...((() => { const eta = secondsUntilAffordable(cost, resources, incomePerMin); return eta === null ? {} : { seconds_until_affordable: eta }; })()),
            // Combat math is impossible without these, and they were previously reachable only
            // through the game://units MCP resource, which many clients never surface at all — so
            // an agent had no way to answer "do two skiffs beat a bastion?" except by trying it.
            stats: statsOf(def),
            // Where a unit is actually trained. An empty list means NOTHING can produce this type in
            // this match — the honest answer for a scenario-only unit like the Freighter, which
            // previously advertised itself as cost-free and always affordable and could never
            // actually be built by anyone.
            ...(producers ? { produced_by: producers, buildable: producers.length > 0 } : {}),
            ...(UNITS[def.id] && (def.supplyCost || 0) > supplyRoom ? { supply_blocked: true } : {}),
          };
        };
        const units = Object.values(UNITS).map(optionFor);
        const buildings = Object.values(BUILDINGS).map(optionFor);
        const ready = o => o.prereqs_met && o.affordable && o.buildable !== false && !o.supply_blocked;
        const readyCount = list => list.filter(ready).length;
        return {
          content: [{ type: "text", text: `${readyCount(units)} unit type(s) and ${readyCount(buildings)} building type(s) currently ready to build.` }],
          structuredContent: { units, buildings, techs: [] },
        };
      })),
    },
    {
      name: "estimate_engagement",
      title: "Estimate who wins a fight",
      description:
        "Given your units and the enemy units you can see, says who wins the fight and by how much — the question " +
        "get_counters cannot answer, because a counter bonus says nothing about a 1-versus-4. Pass your_ids and " +
        "enemy_ids (both must be entities you can currently see); omit enemy_ids to weigh your force against every " +
        "enemy entity in fog right now. Returns predicted_winner, a margin (how many times faster you kill them than " +
        "they kill you — under ~1.5 treat it as a coin flip), each side's dps and hp, and how long each side lasts. " +
        "A sustained-damage model over the engine's own unit table: it accounts for hp, attack, cooldown and the " +
        "counter bonus against the composition actually facing each side, and deliberately ignores range, pathing, " +
        "terrain, upgrades, veterancy, focus fire, turrets you have not seen and reinforcements. Use it as a go/no-go " +
        "before committing, not as a simulation.",
      inputSchema: {
        type: "object",
        properties: {
          seat_handle: { type: "string" },
          your_ids: { type: "array", items: { type: "string" }, description: "Your unit ids. Omit to use every combat unit you own." },
          enemy_ids: { type: "array", items: { type: "string" }, description: "Enemy ids. Omit to use every enemy entity currently visible." },
        },
        required: ["seat_handle"],
      },
      handler: withSeat(lobby, seatAndProj(getCache, ({ seat, proj, your_ids, enemy_ids }) => {
        if (seat.owner === SPECTATOR_SEAT) return rejection("watch-only-handle: this weighs YOUR force against an enemy's; join a match to ask this");
        const all = [...proj.units, ...proj.buildings];
        const byId = new Map(all.map(e => [e.id, e]));
        // An id this seat cannot see is refused rather than silently dropped: quietly weighing 3
        // units when the caller named 5 answers a different question than the one it asked.
        const pick = (ids, fallback) => {
          if (!Array.isArray(ids)) return { ok: true, list: fallback };
          const missing = ids.filter(id => !byId.has(id));
          if (missing.length) return { ok: false, missing };
          return { ok: true, list: ids.map(id => byId.get(id)) };
        };
        const mine = pick(your_ids, proj.units.filter(u => u.owner === seat.owner && UNITS[u.type]?.attack));
        const theirs = pick(enemy_ids, all.filter(e => e.owner !== seat.owner));
        if (!mine.ok || !theirs.ok) return rejection(`not-visible: ${[...(mine.missing ?? []), ...(theirs.missing ?? [])].join(", ")}`);
        const wrongOwner = mine.list.filter(e => e.owner !== seat.owner).map(e => e.id);
        if (wrongOwner.length) return rejection(`not-owner: ${wrongOwner.join(", ")} — your_ids must be your own entities`);
        if (!mine.list.length || !theirs.list.length) {
          return {
            content: [{ type: "text", text: theirs.list.length ? "You have no combat units to weigh." : "No enemy entities visible to weigh against — remember that fog hides them, it does not remove them." }],
            structuredContent: { predicted_winner: null, your_force: mine.list.length, enemy_force: theirs.list.length },
          };
        }
        const estimate = estimateFight(mine.list, theirs.list);
        return {
          content: [{ type: "text", text: `${mine.list.length} of yours vs ${theirs.list.length} of theirs: ${estimate.predicted_winner === "you" ? "you win" : estimate.predicted_winner === "enemy" ? "YOU LOSE THIS FIGHT" : estimate.predicted_winner}${estimate.margin ? ` (margin ${estimate.margin}x, ${estimate.confidence} confidence)` : ""}.` }],
          structuredContent: { ...estimate, your_force: mine.list.length, enemy_force: theirs.list.length,
            note: "approximate: ignores range, terrain, upgrades, veterancy, focus fire and anything outside your fog" },
        };
      })),
    },
    {
      // The same counter triangle the game://counters MCP resource already publishes, exposed as a
      // TOOL as well: a resource is only readable by a client that surfaces MCP resources at all,
      // and an agent that can only call tools was left memorising matchups from experience.
      // Derived from each unit's own real bonusVs table (the exact data engine/combat.js's
      // attackDamage reads), never a hand-written description of it.
      name: "get_counters",
      title: "Get the unit counter table",
      description: "Every unit type's real bonus damage against another unit type — what counters what — derived from the same data the engine's own combat math uses. Static for the whole match; read it once.",
      inputSchema: { type: "object", properties: { seat_handle: { type: "string" } }, required: ["seat_handle"] },
      handler: withSeat(lobby, () => {
        const counters = [];
        for (const u of Object.values(UNITS)) {
          if (!u.bonusVs) continue;
          for (const [target, bonus] of Object.entries(u.bonusVs)) counters.push({ attacker: u.id, target, bonus });
        }
        return {
          content: [{ type: "text", text: `${counters.length} counter matchup(s).` }],
          structuredContent: { counters },
        };
      }),
    },
  ];
}
