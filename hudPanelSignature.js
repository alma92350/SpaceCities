/* ============================================================
   THE SELECTION PANEL'S DERIVED STATE — everything hudSelection.js reads OUT of
   the game state, with nothing that builds DOM.

   The dividing line is exactly that: derive here, render there. It falls out of
   what panelSignature is. That function is the panel's entire reactivity model —
   it decides whether renderSelectionPanel rebuilds AT ALL, so a panel whose own
   state contributes no term to it silently never redraws. (That is not
   hypothetical: it is what left the Freight Lane and Colony Policy controls
   inert, reading as no-ops and inviting a second click that toggled the change
   back.) A model that important should be readable on its own, rather than buried
   in the middle of the panel's button construction — and the derivations it shares with the
   renderers (factoryStatus, loadableComs, countByType, counterInfo) belong beside
   it rather than in the middle of the DOM code, since both sides call them and
   the two must never drift.

   This module imports no DOM and no hud.js, so unlike the panel itself it is a
   genuine leaf: importable and drivable directly from a test, and outside the
   hud/hudSelection import cycle entirely.

   The long-term shape is a registry of { match, signature, render } per panel
   family, co-locating each panel's signature term with the panel that draws it
   (docs/code-improvement-tiers.md, Tier 3). This split is the seam that makes
   that a move rather than a rewrite; test/hudSelection.test.js already drives a
   completeness table over every interactive panel family so a missing term fails
   loudly instead of shipping dead.

   HALF OF THAT IS NOW DONE, which changes what is left. hudSelection.js's twelve
   panel families each have their own renderX() function and rebuildSelectionPanel
   is a dispatcher — so the "render" third of the registry already exists, named
   and separable. What remains is moving each family's SIGNATURE term next to its
   renderer, which is now a per-family move rather than one big one.
   ============================================================ */

"use strict";

import { game } from "./session.js";
import { isTouchMode } from "./dom.js";
import { BUILDINGS, UNITS, UPGRADES, canAfford, storeTotal, storeCapOf, storeRoom, inputTotal, isElectrifiable } from "./engine/entities.js";
import { recipeOf, powerThrottle, powerEfficiency, planetIndustryScale, onPowerGrid, electrifyBoost, iceCoolantMult } from "./engine/industry.js";
import { techMult } from "./engine/techtree.js";
import { canRecycle } from "./engine/recycle.js";
import { rigInfo } from "./engine/rig.js";
import { canPlaceBuilding } from "./engine/colliders.js";
import { getColonyPolicy } from "./engine/colonyPolicy.js";
import { TRADE_LOT } from "./engine/market.js";
import { tributeCost } from "./engine/diplomacy.js";
import { JUMP_COST, jumpManifest, jumpManifestAll, jumpVessel, spaceportTier, freightUsed } from "./engine/galaxy.js";
import { COM } from "./data.js";

// Selecting more than one unit collapses the panel to one row per type
// ("12× Skiff — 84% hp") instead of a row per unit — unusable past a
// handful of units otherwise. A single unit or building still gets its
// own detailed row. Buildings never aggregate (box-select only ever
// picks up units; a building is always a lone click-selection).
export function countByType(units) {
  const counts = new Map();
  units.forEach(u => {
    const entry = counts.get(u.type) || { count: 0, hp: 0, maxHp: 0 };
    entry.count++;
    entry.hp += u.hp;
    entry.maxHp += u.maxHp;
    counts.set(u.type, entry);
  });
  return counts;
}

// "12× Skiff — 84% hp · ▼ falls to Bastion" — shared by rebuildSelectionPanel's per-type rows
// and renderSelectionPanel's live hp-only patch (both walk the same countByType map) so the two
// can never drift, same rule recycleRowText/researchRowText below already follow. Only the "falls
// to" half is shown (not "strong vs") — the point is flagging THIS army's own soft spot at a
// glance, not repeating unitTip's full breakdown inline; counterInfo (above) already returns ""
// when nothing counters the type, so the suffix just doesn't appear then.
export function summaryRowLabel(type, entry) {
  const def = UNITS[type];
  const pct = Math.round((entry.hp / entry.maxHp) * 100);
  const { weak } = counterInfo(def);
  return `${entry.count}× ${def.name} — ${pct}% hp${weak ? " · " + weak : ""}`;
}

// Only the queue's *composition* (what's queued, in what order) needs a
// full rebuild -- a job's progress fraction changes every tick and is
// instead patched in place below, same reasoning as the hp-only patch
// path this already sits alongside.
function queueSignature(sel) {
  const b = sel.length === 1 && sel[0].kind === "building" ? sel[0] : null;
  if (!b) return "";
  const prod = b.queue ? b.queue.map(j => j.unitType).join(",") : "";
  // The Datacenter's tech research OR the Refinery's doctrine research is its own queue — include
  // it so queuing/finishing a research rebuilds the panel (the progress % itself is then
  // live-patched each tick, same as the production queue's job labels above).
  const research = b.researchQueue ? b.researchQueue.map(j => j.techId).join(",") : "";
  return prod + "#" + research;
}

// UPGRADES entries a human player can actually see/research at a Refinery — excludes a
// difficulty-only entry like hardEdge (engine/aiDifficulty.js's economic edge), which is
// seeded straight onto the AI's own upgrades at creation and was never meant to be a real,
// purchasable, doctrine-bearing pick. Hoisted once, reused by ALL_COSTS below and the
// Refinery research panel (renderSelectionPanel).
export const RESEARCHABLE_UPGRADES = Object.values(UPGRADES).filter(u => !u.aiOnly);

// Every cost the affordability fingerprint below checks — hoisted to module load
// time. UNITS/BUILDINGS/UPGRADES (engine/entities.js) are static definitions that
// never change at runtime, so rebuilding this array from scratch on every call (as
// availabilitySignature() used to) was pure waste: this runs from renderSelectionPanel
// every HUD tick (~6-7×/sec), selection or not.
const ALL_COSTS = [
  ...Object.values(UNITS).map(u => u.cost),
  ...Object.values(UNITS).filter(u => u.altCost).map(u => u.altCost),   // e.g. the Worker's biomass price
  ...Object.values(BUILDINGS).map(b => b.cost),
  ...RESEARCHABLE_UPGRADES.map(u => u.cost),
];

// Reverse of bonusVs (engine/entities.js): which unit types deal bonus damage AGAINST a given
// type — e.g. COUNTERED_BY.skiff === ["bastion"], because Bastion's bonusVs.skiff is set. Hoisted
// once at module load, same idiom as ALL_COSTS above (UNITS is a static definition that never
// changes at runtime), mirroring the COUNTER_OF reduce shape engine/aiMilitary.js already builds
// off these exact same bonusVs tables for the AI's own counter-picking.
const COUNTERED_BY = Object.values(UNITS).reduce((map, def) => {
  if (def.bonusVs) for (const targetType of Object.keys(def.bonusVs)) (map[targetType] ||= []).push(def.id);
  return map;
}, {});

// The counter-triangle, surfaced from data instead of memorized from the README: what `def` is
// strong against (its own bonusVs keys, plus "structures" for a class-wide siege bonus like the
// Breacher's bonusVsBuildings) and what it falls to (COUNTERED_BY, above). Returns "" for either
// side that doesn't apply — a building def, or a unit deliberately built outside the triangle
// (the Dreadnought, the Leviathan) — so every caller can blindly test-and-append.
export function counterInfo(def) {
  const strongVs = [
    ...Object.keys(def.bonusVs || {}).map(t => UNITS[t]?.name || t),
    ...(def.bonusVsBuildings ? ["structures"] : []),
  ];
  const weakVs = (COUNTERED_BY[def.id] || []).map(t => UNITS[t]?.name || t);
  return {
    strong: strongVs.length ? `▲ strong vs ${strongVs.join(", ")}` : "",
    weak: weakVs.length ? `▼ falls to ${weakVs.join(", ")}` : "",
  };
}

// Fingerprint of what the player can currently afford and which completed
// buildings they hold — the two inputs to every button's greyed/locked state.
function availabilitySignature() {
  const { state } = game;
  const res = state.players[game.localOwner].resources;
  const afford = ALL_COSTS.map(c => (canAfford(res, c) ? 1 : 0)).join("");
  const built = [...new Set([...state.buildings.values()]
    .filter(b => b.owner === game.localOwner && !b.constructing).map(b => b.type))].sort().join(",");
  return afford + "|" + built;
}

// The colour-band of a selected factory's status (or "" for none), so a status
// transition triggers a panel rebuild — see the panel signature above.
function factorySignature(sel) {
  const { state } = game;
  const f = sel.find(e => e.kind === "building" && recipeOf(e) && !e.constructing);
  if (!f) return "";
  // Include the grid-efficiency tier (rebuilds the "Grid: …" line when a Reactor is built/razed
  // nearby), the input/output buffer levels (so the larder + output lines stay live as workers
  // carry goods in and out, quantised so it doesn't rebuild every frame), whether ice coolant
  // is banked (so the Ice Coolant row flips the instant the treasury's ice crosses zero either way),
  // and the Logistics Priority cycle button's own label (high/normal/low).
  return factoryStatus(state, f, recipeOf(f)).cls + ":" + powerEfficiency(state, f.owner, f.x, f.y).name
    + ":" + Math.round(inputTotal(f) / 4) + ":" + Math.round(storeTotal(f) / 4) + ":" + (iceCoolantMult(state, f.owner) < 1)
    + ":" + (f.logiPriority || "normal");
}

// The panel's entire reactivity model, in one named place. It decides whether renderSelectionPanel
// rebuilds at all, so a panel whose own state contributes no term here silently never redraws — the
// class of bug that left the Freight Lane and Colony Policy controls inert. Extracted out of
// renderSelectionPanel so it can be read, tested and moved as a unit; the long-term fix is to
// co-locate each panel's term with the panel that draws it (a registry of
// { match, signature, render } — docs/code-improvement-tiers.md, Tier 3), and this is the seam that
// makes that a move rather than a rewrite. test/hudSelection.test.js drives a completeness table
// over every interactive panel family so a missing term fails loudly instead of shipping dead.
export function panelSignature(sel, state, input, aggregated) {
  return sel.map(e => `${e.id}:${e.kind === "building" ? e.constructing : ""}`).join(",")
    + "|" + (input.building ? input.building.buildingType : "")
    + "|" + Object.keys(state.players[game.localOwner].upgrades).sort().join(",")
    + "|" + aggregated
    // Rebuild when attack-move arms/disarms so the Attack-Move button's ARMED label +
    // .armed class actually appear — without this the state changed with no panel cue.
    + "|" + input.attackArmed
    // Rebuild when the formation shape/leader-position choice changes, so the picker's
    // .active button + the leader-position row (line/wedge only) actually update.
    + "|" + game.formation.shape + ":" + game.formation.leaderPos
    // Rebuild when ANY collapsible section (the Build submenu's per-group toggles, CC/Barracks
    // Produce, Refinery/Datacenter Research, Market, the freighter Cargo list, the Spaceport Jump
    // list, …) flips collapsed/expanded, so its button list actually appears/disappears instead of
    // staying frozen at whatever it first rendered. One shared Set covers every section — sorted
    // so the signature is deterministic regardless of click order (Set iteration order isn't).
    + "|" + [...game.collapsedSections].sort().join(",")
    + "|" + queueSignature(sel)
    // Rebuild when any button's enabled state would flip: an option crossing the
    // affordability line, or a completed building unlocking a tech option (e.g.
    // the Foundry un-greying Lancer/Breacher). Keeps the greying live without
    // rebuilding every HUD tick. Skipped with nothing selected: rebuildSelectionPanel's
    // empty-sel branch (just the hint + Idle Worker/Select Army buttons) never reads
    // affordability or built-building state, so this term can't change what renders then.
    + "|" + (sel.length ? availabilitySignature() : "")
    // Rebuild when the app flips into touch mode, so the panel's legend + hints
    // swap from mouse/keyboard to finger phrasing on the first touch.
    + "|" + isTouchMode()
    // Rebuild when a selected factory's status transitions (running ↔ throttled ↔
    // starved ↔ stalled), so its "why it's not producing" line stays live without
    // a full rebuild every HUD tick.
    + "|" + factorySignature(sel)
    // Rebuild any selected gathering worker's live "Miners X/cap" note as other workers join or
    // leave its assigned node (node.miners is retallied every tick by sim.js countMiners) —
    // without this the count would freeze at whatever it read on the panel's last rebuild, same
    // reasoning as factorySignature just above.
    + "|" + sel.filter(e => e.kind === "unit" && e.order && e.order.type === "gather")
        .map(e => {
          const node = state.map.nodesById ? state.map.nodesById.get(e.order.nodeId) : state.map.nodes.find(n => n.id === e.order.nodeId);
          return node ? node.miners || 0 : "";
        }).join(",")
    // Rebuild when the Odyssey diplomacy panel's tribute button would appear/disappear (stance
    // crossing the 0.25 band) or its cost/affordability would flip, a favor request appears/
    // expires/becomes (un)affordable, or the gift picker's own row set would change — so every
    // lever surfaces the moment it applies, without a per-tick rebuild. (The favor countdown's
    // seconds-left text is NOT here on purpose — it's patched every tick further below instead,
    // same split refreshMarketRows already draws for the market's own live price.)
    + "|" + (game.galaxy && state.diplomacy
        ? `${state.diplomacy.stance < 0.25}:${tributeCost(state.diplomacy)}:${game.galaxy.credits >= tributeCost(state.diplomacy)}`
          + `:${!!state.diplomacy.request}:${state.diplomacy.request
              ? Math.floor(state.players[game.localOwner].resources[state.diplomacy.request.com] || 0) >= state.diplomacy.request.qty : ""}`
          + `:${Object.keys(COM).filter(c => Math.floor(state.players[game.localOwner].resources[c] || 0) >= TRADE_LOT).join(",")}`
        : "")
    // Rebuild when the Capital state changes (a CC upgraded to Capital → anchored note), a
    // staged colony ship appears/vanishes (the jump panel's "ship loaded?" hint), or the
    // credits cross the new-world jump cost (those Jump buttons enable/lock).
    + "|" + (game.galaxy
        ? `${jumpVessel(state) ? 1 : 0}:${game.galaxy.credits >= JUMP_COST ? 1 : 0}:${[...state.buildings.values()].filter(b => b.owner === game.localOwner && b.capital).length}`
        : "")
    // Rebuild when a selected colony ship crosses a deploy-placement boundary, so its
    // "Deploy as Command Center" button locks/unlocks live as you move it to clear ground.
    + "|" + (() => {
        const cs = game.galaxy && sel.find(e => e.kind === "unit" && e.type === "colonyship");
        return cs ? (canPlaceBuilding(state, "command", cs.x, cs.y) ? 1 : 0) : "";
      })()
    // Rebuild the Spaceport panel when its tier changes (upgrade) or the staged fleet crosses
    // the pad capacity (units enter/leave the pad radius) — so the manifest preview stays live.
    // Also fold in the ALL-pads combined manifest: with more than one Spaceport, the panel's
    // "combined" note depends on every pad's staged fleet, not just this one.
    + "|" + (() => {
        const sp = game.galaxy && sel.find(e => e.kind === "building" && e.type === "spaceport" && !e.constructing);
        if (!sp) return "";
        const m = jumpManifest(state, sp);
        const all = jumpManifestAll(state);
        return `${spaceportTier(sp)}:${m.used}:${m.leftBehind}:${m.staged}:${all.used}:${all.leftBehind}`;
      })()
    // Rebuild the Helium Bomb panel when its armed state flips, or its fuse lights/is cut —
    // the note text and Disarm/Detonate buttons all depend on both.
    + "|" + (() => {
        const b = sel.find(e => e.kind === "unit" && UNITS[e.type].role === "bomb");
        return b ? `${!!b.armed}:${b.fuseUntil != null}` : "";
      })()
    // Rebuild the freighter cargo panel when its hold or the loadable stockpile changes, so the
    // Load/Unload buttons and the used/cap readout stay live as goods move in and out of the hold.
    + "|" + (() => {
        const f = game.galaxy && sel.find(e => e.kind === "unit" && UNITS[e.type].cargoHold);
        if (!f) return "";
        const res = state.players[game.localOwner].resources;
        return freightUsed(f) + ":" + JSON.stringify(f.freight) + ":" + loadableComs(state, f).map(c => Math.floor(res[c] || 0)).join(",");
      })()
    // Rebuild the freighter AI-logistics toggle when it flips or the treasury's AI Cores count
    // changes by a whole unit (quantised, like the rig/factory buffers above), so the ON/OFF
    // label and the burning/stalled note stay live without a per-tick rebuild.
    + "|" + (() => {
        const f = game.galaxy && sel.find(e => e.kind === "unit" && UNITS[e.type].cargoHold);
        return f ? `${!!f.aiLogistics}:${Math.round(state.players[game.localOwner].resources.ai || 0)}` : "";
      })()
    // Rebuild the freighter Collection-Point toggle when it flips or a shuttle run starts/changes
    // leg, so the ON/OFF label and the "shuttling to CC / back to anchor" note stay live.
    + "|" + (() => {
        const f = game.galaxy && sel.find(e => e.kind === "unit" && UNITS[e.type].cargoHold);
        return f ? `${!!f.collectPoint}:${f.order?.type === "shuttle" ? f.order.phase : ""}` : "";
      })()
    // Rebuild a selected Plasma Rig's status as it digs — its progress, last strike (each dig
    // increments digCount), and its power/nuclear situation — without a per-tick rebuild.
    + "|" + (() => {
        const rig = game.galaxy && sel.find(e => e.kind === "building" && BUILDINGS[e.type].rig && !e.constructing);
        if (!rig) return "";
        const info = rigInfo(state, rig);
        return `${!!rig.paused}:${info.nuclearOk}:${Math.round(info.throttle * 10)}:${rig.digCount || 0}:${Math.round(info.progress * 4)}:${powerEfficiency(state, rig.owner, rig.x, rig.y).name}:${info.storeFull}:${Math.round((info.stored / (info.storeCap || 1)) * 10)}:${iceCoolantMult(state, rig.owner) < 1}`;
      })()
    // Rebuild a selected non-recipe output buffer's (the Plasma Rig) intake line as workers clear it.
    + "|" + (() => {
        const d = sel.find(e => e.kind === "building" && e.owner === game.localOwner && !e.constructing
          && storeCapOf(e.type) > 0 && !BUILDINGS[e.type].recipe && !BUILDINGS[e.type].isCommandCenter);
        return d ? Math.round((storeTotal(d) / (storeCapOf(d.type) || 1)) * 10) : "";
      })()
    // Rebuild a selected fuel-burning power station's (Reactor / Combustion Generator / Biomass
    // Reactor) status when its power state flips, OR its fuel larder level changes enough to matter — a
    // worker topping it up should surface live, same quantized-buffer idiom as the factory Larder
    // signature elsewhere (rebuild on a change of ~4 units, not literally every drop delivered).
    + "|" + (() => {
        const gen = sel.find(e => e.kind === "building" && BUILDINGS[e.type]?.combust && !e.constructing);
        if (!gen) return "";
        const fuels = BUILDINGS[gen.type].combust.fuels.map(f => Math.round((gen.input?.[f] || 0) / 4)).join(",");
        return `${!!gen.paused}:${!!gen.powered}:${gen.fuel || ""}:${fuels}:${iceCoolantMult(state, gen.owner) < 1}:${gen.logiPriority || "normal"}`;
      })()
    // Rebuild the Mender panel when its auto-repair toggle or on-grid power state flips.
    + "|" + (() => {
        const m = sel.find(e => e.kind === "unit" && UNITS[e.type].role === "support");
        return m ? `${!!m.autoRepair}:${game.galaxy ? onPowerGrid(state, m.owner, m.x, m.y) : ""}` : "";
      })()
    // Rebuild the electrify panel when a selected building's electrified flag flips or its live boost
    // band shifts (the grid gaining/losing Power), so the toggle label + gain readout stay current.
    + "|" + (() => {
        const e = game.galaxy && sel.find(x => x.kind === "building" && x.owner === game.localOwner
          && !x.constructing && isElectrifiable(x.type));
        return e ? `${!!e.electrified}:${Math.round(electrifyBoost(state, e.owner) * 100)}` : "";
      })()
    // Rebuild when any selected entity's Recycle state starts/stops/finishes (the button ↔
    // progress-row swap) — the live % itself is then patched in place below, not rebuilt.
    + "|" + sel.map(e => e.recycling ? "r" : canRecycle(e) ? "c" : "x").join("")
    // The two Odyssey panels whose OWN controls the signature used to ignore entirely. Every one
    // of their handlers is `mutate(); renderHUD();` — and with no term here renderSelectionPanel
    // returned early, so the panel stayed frozen on the old value. The control read as a no-op,
    // which invites a second click that silently toggles the change back. Assign/Release only ever
    // appeared to work by accident: they set u.laneId, which perturbs the Spaceport manifest term.
    // Kept COARSE (ids and values, not per-frame floats) so these can't churn a rebuild every tick
    // — a rebuild mid-click is the dropped-click hazard this whole guard exists to avoid.
    + "|" + (() => {
        if (!game.galaxy) return "";
        return (game.galaxy.lanes || [])
          .filter(l => l.from === game.galaxy.activeId || l.to === game.galaxy.activeId)
          .map(l => `${l.id}:${l.commodities.join("/")}:${l.shipIds.join("/")}`).join(",");
      })()
    + "|" + (() => {
        if (!game.galaxy) return "";
        return JSON.stringify(getColonyPolicy(game.galaxy, state.planetId) || null);
      })();
}

// Commodities a freighter panel offers to load: anything already aboard, or anything the player
// holds in stock on this world (excluding `energy` — that's Power, a utility, not freight). This
// deliberately goes beyond the market's tradeables, so the STRATEGIC goods (antimatter, AI cores,
// plasma torpedoes) — which no market buys — can still be loaded and shipped to the world charging
// your Antimatter Gate or building Leviathans at a Stardock, their only real sinks.
export function loadableComs(state, f) {
  const res = state.players[game.localOwner].resources;
  return [...new Set([
    ...Object.keys(f.freight || {}),
    ...Object.keys(COM).filter(c => c !== "energy" && Math.floor(res[c] || 0) >= 1),
  ])];
}

// Why a selected factory is (or isn't) producing — the answer to "my antimatter
// isn't going up." Checks the same limits updateProduction (engine/industry.js)
// applies, in priority order: no Power at all, then a missing input, then a Power
// shortfall throttling everything, else running (with the live output rate).
export function factoryStatus(state, b, recipe) {
  if (b.paused) return { cls: "paused", text: "Paused — banking its inputs" };
  const throttle = powerThrottle(state, b.owner);
  if (throttle <= 0) return { cls: "bad", text: "Stalled — no Power" };

  // Inputs now come from the factory's LOCAL larder (engine/haul.js), filled by worker supply
  // runs — so "starved" means a worker needs to bring it, not that the whole economy is dry.
  const input = b.input || {};
  let scarce = null, scarceRatio = Infinity;
  for (const com in recipe.in) {
    if (com === "energy") continue;
    const ratio = (input[com] || 0) / recipe.in[com];
    if (ratio < scarceRatio) { scarceRatio = ratio; scarce = com; }
  }
  if (scarceRatio < 1) return { cls: "bad", text: `Starved — needs ${COM[scarce]?.name || scarce} carried in` };
  if (storeRoom(b) <= 1e-6) return { cls: "bad", text: "Stalled — output buffer full (needs a hauler)" };
  if (throttle < 0.995) return { cls: "warn", text: `Throttled ${Math.round(throttle * 100)}% — low Power` };

  const def = BUILDINGS[b.type], ups = state.players[b.owner].upgrades;
  // yieldMult is scoped by building type (techtree.js techMult/appliesTo — e.g. Heavy Alloys names
  // only the Smelter/Assembly Plant) so this predicted rate never overstates a factory outside that
  // list, matching exactly what updateProduction (engine/industry.js) actually banks.
  const rate = (def.prodRate || 1) * techMult(ups, "rateMult") * planetIndustryScale(state)
    * throttle * recipe.qty * techMult(ups, "yieldMult", b.type);
  return { cls: "good", text: `Running · +${rate.toFixed(1)} ${COM[recipe.out]?.name || recipe.out}/s` };
}
