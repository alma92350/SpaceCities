/* ============================================================
   The HUD SELECTION PANEL — the per-selection button/row subsystem, split out
   of hud.js so neither file is a 1000-line god object. Everything that renders
   for the CURRENT SELECTION lives here: the panel rebuild and its live-patched
   rows/queue, the market / freight / diplomacy / capital sub-panels, the factory
   & rig status lines, the signature guards that keep the rebuild off the per-tick
   hot path, and the small button / tooltip factories.

   renderHUD (hud.js) calls renderSelectionPanel() each HUD tick. The buttons
   here call back into renderHUD() to re-render immediately after an action — a
   benign runtime-only import cycle: the renderHUD binding is used only inside
   click handlers, never at module-evaluation time, so ESM's live bindings resolve
   it fine. The bodies are unchanged from the original hud.js.
   ============================================================ */

"use strict";

import { game } from "./session.js";
import { panelEl, isTouchMode, loadBtn } from "./dom.js";
// queueProduction: still called directly for ONE deliberately-untouched site (the Star Dock's
// odysseyOnly production, line ~1198 below — TASKS.md T-012 only ports skirmish-relevant command
// issuing onto game.transport; Odyssey's own mutators, this one included, stay as they were).
// Every OTHER production/research/logistics/recycle/bomb command this file used to call directly
// (cancelProduction, researchUpgrade, researchTech, cancelResearch, issueSetAILogistics,
// issueSetCollectPoint, issueSetLogiPriority, issueRecycle, issueCancelRecycle, lightFuse) now
// goes out as a net/commandShapes.js WireCommand via game.transport.submitCommand(cmd) instead —
// see each call site below.
import { queueProduction } from "./engine/production.js";
import { canRecycle, recycleFrac, recycleValue } from "./engine/recycle.js";
import { FREIGHTER_AI_TECH, aiUpkeepRate, LOGI_PRIORITIES } from "./engine/haul.js";
import { recipeOf, powerEfficiency, onPowerGrid, electrifyBoost, ELECTRIFY_POWER, iceCoolantMult } from "./engine/industry.js";
import { storeTotal, storeCapOf, storeRoom, inputCapOf, isElectrifiable } from "./engine/entities.js";
import { rigInfo } from "./engine/rig.js";
import { BOMB_BLAST_RADIUS, BOMB_CORE_RADIUS, BOMB_DETECT_RANGE, BOMB_FUSE_DELAY } from "./engine/bomb.js";
import { TECHS } from "./engine/techtree.js";
import { BUILDINGS, UNITS, UPGRADES, canAfford, prereqsMet, committedDoctrine, canBuildCategory } from "./engine/entities.js";
import { jumpCost, jumpManifest, jumpManifestAll, jumpCapacity, spaceportTier, upgradeSpaceport, SPACEPORT_MAX_TIER, SPACEPORT_UPGRADE_COST, FUEL_DISCOUNT_BY_TIER, cargoManifest, freightCapacity, loadFreighter, unloadFreighter, freightUsed, freightRoom, JUMP_LOAD_RADIUS, CARGO_GOODS, createLane, deleteLane, assignShipToLane, unassignShipFromLane, upgradeToCapital, jumpVessel, CAPITAL_UPGRADE_COST, CAPITAL_HP_MULT } from "./engine/galaxy.js";
import { setColonyPolicy, getColonyPolicy } from "./engine/colonyPolicy.js";
import { canPlaceBuilding } from "./engine/colliders.js";
import { deployColonyShip, packCommandCenter, PACK_COST } from "./engine/colony.js";
import { sell, buy, unitPrice, tradeables, commodityAvailable, TRADE_LOT, quoteSell } from "./engine/market.js";
import { stanceLabel, offerTribute, tributeCost, APPEASE_TIME, offerGift, fulfillRequest, GOODWILL_CAP } from "./engine/diplomacy.js";
import { initiateJump } from "./boot.js";
import { FORMATION_SHAPES } from "./engine/formation.js";
import { flashHint } from "./overlays.js";
import { spriteIcon } from "./render.js";
import { planetName, COM } from "./data.js";
import * as sound from "./sound.js";
import { renderHUD } from "./hud.js";
// The panel's derived state — everything read OUT of game state, with nothing that builds DOM.
// See hudPanelSignature.js's header for why the line falls exactly there.
import { panelSignature, countByType, summaryRowLabel, counterInfo, factoryStatus, loadableComs, RESEARCHABLE_UPGRADES } from "./hudPanelSignature.js";

// Display text for the formation shape picker (engine/formation.js FORMATION_SHAPES) — UI
// copy, kept out of the engine module.
const FORMATION_LABELS = { grid: "Grid", line: "Line", wedge: "Wedge", circle: "Circle" };
const FORMATION_TIPS = {
  grid: "A simple spread — no leader, no facing",
  line: "Abreast the direction of travel, the leader nudged to the front or back",
  wedge: "A V: the leader at the tip (front) or shielded at the rear vertex (back)",
  circle: "A ring around the leader at its center, protected",
};

// Panel-rebuild guard: the last signature the selection panel was rebuilt for.
// Module-local (only renderSelectionPanel reads/writes it); hud.js's
// resetPanelSignature() clears it via resetSelectionSignature() when a new game
// boots so the first frame rebuilds fresh.
let lastPanelSignature = null;
export function resetSelectionSignature() { lastPanelSignature = null; }











export function renderSelectionPanel() {
  const { state, input } = game;
  const sel = state.selection.map(id => state.units.get(id) || state.buildings.get(id)).filter(Boolean);
  const aggregated = sel.length > 1 && sel.every(e => e.kind === "unit");

  // Only rebuild the panel's DOM when the set of buttons/rows it should
  // show would actually change (selection, build-placement mode,
  // upgrades researched, or the production queue's composition).
  // Rebuilding on every HUD tick — even though hp/progress numbers
  // change constantly — replaced the exact button the player was
  // mid-click on with a fresh DOM node, and a mouseup landing after that
  // swap could drop the click entirely: felt like only a sliver of the
  // button was clickable, when really it was a timing race, not a
  // sizing one.
  const signature = panelSignature(sel, state, input, aggregated);

  if (signature !== lastPanelSignature) {
    lastPanelSignature = signature;
    rebuildSelectionPanel(sel);
    return;
  }

  if (aggregated) {
    // .sel-row-summary (not the plain .sel-row every unrelated row below also carries —
    // queue rows, researched-tech rows, the factory recipe line, etc.) so this positional
    // patch can only ever land on the per-entity summary rows it means to update.
    const rows = panelEl.querySelectorAll(".sel-row-summary");
    [...countByType(sel).entries()].forEach(([type, entry], i) => {
      if (rows[i]) rows[i].textContent = summaryRowLabel(type, entry);
    });
  } else {
    const rows = panelEl.querySelectorAll(".sel-row-summary");
    sel.forEach((e, i) => {
      const def = e.kind === "unit" ? UNITS[e.type] : BUILDINGS[e.type];
      if (rows[i]) rows[i].textContent = `${def.name} — ${Math.ceil(e.hp)}/${e.maxHp} hp`;
    });
  }

  // Patch the in-progress queue slot's live percentage without touching
  // the cancel buttons (a full rebuild would otherwise be needed on
  // every single tick, since progress changes every tick).
  const building = sel.length === 1 && sel[0].kind === "building" ? sel[0] : null;
  if (building && building.queue && building.queue.length) {
    const queueLabels = panelEl.querySelectorAll(".queue-label");
    building.queue.forEach((job, i) => {
      if (!queueLabels[i]) return;
      const def = UNITS[job.unitType];
      queueLabels[i].textContent = i === 0 ? `${def.name} — ${Math.round(job.progress * 100)}%` : `${def.name} (queued)`;
    });
  }

  // Same live patch for a Refinery's doctrine research OR a Datacenter's tech research (each
  // building's own researchQueue, resolved against the right node table by building.type — same
  // split engine/techtree.js's updateResearch itself makes) — otherwise the "Researching … — N%"
  // row(s) would sit frozen at whatever % they had on the last rebuild. The Datacenter renders one
  // cancel-button row PER queued node (renderResearchQueueRows, cancelable research queue); the
  // Refinery still renders the single combined summary row it always has (no cancel button there —
  // see the Datacenter block below for why the two aren't symmetric yet).
  if (building && building.researchQueue && building.researchQueue.length) {
    if (building.type === "datacenter") {
      const rows = panelEl.querySelectorAll(".research-queue-label");
      building.researchQueue.forEach((job, i) => { if (rows[i]) rows[i].textContent = researchQueueRowText(job, TECHS[job.techId], i); });
    } else {
      const row = panelEl.querySelector(".research-progress");
      if (row) row.textContent = researchRowText(building.researchQueue, UPGRADES);
    }
  }

  // Same live patch for an in-progress Recycle — one row per currently-recycling selected
  // entity, in selection order (matches how rebuildSelectionPanel laid them out).
  const recycling = sel.filter(e => e.recycling);
  if (recycling.length) {
    const rows = panelEl.querySelectorAll(".recycle-progress");
    recycling.forEach((e, i) => { if (rows[i]) rows[i].textContent = recycleRowText(e); });
  }

  // Keep a rendered Market panel's prices and Buy/Sell afford state live every tick — see
  // refreshMarketRows (above renderMarket) for why trading can't just rely on the rebuild
  // signature the patches above lean on.
  if (game.galaxy && state.market) refreshMarketRows(state);

  // Same live patch for a pending favor request's "Xs left" countdown — it ticks down every
  // second, and (deliberately, see the signature comment above) isn't part of the rebuild
  // signature, so a rendered row would otherwise freeze at whatever it read on the last rebuild.
  if (game.galaxy && state.diplomacy && state.diplomacy.request) {
    const row = panelEl.querySelector(".favor-progress");
    if (row) row.textContent = favorRowText(state, state.diplomacy.request);
  }
}

// "♻ Recycling Plasma Rig — 42%" — shared by the rebuild and the live patch so they never drift.
function recycleRowText(entity) {
  const def = entity.kind === "building" ? BUILDINGS[entity.type] : UNITS[entity.type];
  return `♻ Recycling ${def.name} — ${Math.round(entity.recycling.progress * 100)}%`;
}

// The research-queue header text ("🖥️ Researching Metallurgy — 40% (+1 queued)") — shared by the
// Datacenter's and the Refinery's rebuild AND live-patch call sites so none of the four can drift
// apart. `table` is whichever node table backs this building — TECHS for a Datacenter, UPGRADES
// for a Refinery — the same split engine/techtree.js's updateResearch itself resolves by
// building.type.
function researchRowText(queue, table) {
  const head = table[queue[0].techId];
  return `${head.ico ? head.ico + " " : ""}Researching ${head.name} — ${Math.round(queue[0].progress * 100)}%`
    + (queue.length > 1 ? ` (+${queue.length - 1} queued)` : "");
}

function renderQueueRows(building) {
  const { state } = game;
  building.queue.forEach((job, i) => {
    const def = UNITS[job.unitType];
    const row = document.createElement("div");
    row.className = "sel-row queue-row";

    const label = document.createElement("span");
    label.className = "queue-label";
    label.textContent = i === 0 ? `${def.name} — ${Math.round(job.progress * 100)}%` : `${def.name} (queued)`;
    row.appendChild(label);

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "queue-cancel";
    cancelBtn.textContent = "×";
    cancelBtn.title = "Cancel (full refund)";
    cancelBtn.addEventListener("click", () => { game.transport.submitCommand({ t: "cancelProduction", building: building.id, i }); renderHUD(); });
    row.appendChild(cancelBtn);

    panelEl.appendChild(row);
  });
}

// One research-queue row's label text ("🔩 Researching Heavy Alloys — 40%" for the head job,
// "🔩 Heavy Alloys (queued)" for anything queued behind it) — shared by renderResearchQueueRows'
// initial build and the live per-tick patch above so the two can never drift apart, same rule
// researchRowText/recycleRowText already follow for their own rows. `def` may be missing for a
// stale techId (a tampered save) — falls back to the raw id rather than throwing.
function researchQueueRowText(job, def, index) {
  const label = def ? `${def.ico ? def.ico + " " : ""}${def.name}` : job.techId;
  return index === 0 ? `${label} — ${Math.round(job.progress * 100)}%` : `${label} (queued)`;
}

// Cancelable research queue with refunds: the Datacenter's research row gets the SAME
// cancel-button-per-job idiom renderQueueRows gives the production queue above — one row per
// queued node, a live "% done" label for the head job and a static "(queued)" for the rest, each
// with its own × button (cancelResearch: full refund, cascading over any queued node that named
// the cancelled one in its own `requires`). `table` is whichever node table this building's queue
// resolves against (TECHS for a Datacenter today — the only caller).
function renderResearchQueueRows(building, table) {
  const { state } = game;
  building.researchQueue.forEach((job, i) => {
    const row = document.createElement("div");
    row.className = "sel-row queue-row";

    const label = document.createElement("span");
    label.className = "research-queue-label";
    label.textContent = researchQueueRowText(job, table[job.techId], i);
    row.appendChild(label);

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "queue-cancel";
    cancelBtn.textContent = "×";
    cancelBtn.title = "Cancel (full refund)";
    cancelBtn.addEventListener("click", () => { game.transport.submitCommand({ t: "cancelResearch", building: building.id, i }); renderHUD(); });
    row.appendChild(cancelBtn);

    panelEl.appendChild(row);
  });
}

// Thresholds below which the market's pressure/glut are everyday single-click noise, not worth a
// glance-able flag — a lone Sell/Buy click (~0.05 pressure) never lights the glyph up, but a few
// lots' worth of bulk trading (Sell x4 / Sell All below, or the AI's own barter) does.
const TREND_PRESSURE_NOTABLE = 0.15;
const TREND_GLUT_NOTABLE = 0.1;

// A short glyph reading this row's price trend off the two numbers engine/market.js already
// simulates but never surfaced: the FAST pressure (relaxes in ~17s) and, for produced goods only,
// the SLOW glut (relaxes over ~8min) — so a player can tell a briefly-depressed price apart from a
// deep glut worth exporting around instead of selling into (the proposal's own "▼ glutted ·
// recovering" example). Pure string math off two numbers — kept here rather than in
// engine/market.js since it's a presentation-only readout, not simulation.
function marketTrend(market, com) {
  const pressure = market.pressure[com] || 0;
  const glut = market.glut?.[com] || 0;
  if (glut > TREND_GLUT_NOTABLE)
    return pressure < -TREND_PRESSURE_NOTABLE ? "▼ Glutted, still falling" : "▼ Glutted, recovering";
  if (pressure < -TREND_PRESSURE_NOTABLE) return "↓ Depressed, recovering";
  if (pressure > TREND_PRESSURE_NOTABLE) return "↑ Elevated";
  return "";
}

// One market row's live numbers — the label's price, the trend glyph, and every button's afford
// text/state. Shared by renderMarket (the initial build, right below) and refreshMarketRows (the
// every-tick live patch further below) so the two can never drift apart. Sell x4/Sell All quote
// their real marginal proceeds via quoteSell (engine/market.js) — a dry run of the exact lot walk
// sell() itself uses, so the tooltip can never promise more than the click will actually pay.
function marketRowFields(state, com) {
  // Reuse the commodity's data icon (data.js COM) — the same emblem the resource readout uses.
  const meta = COM[com];
  const res = state.players[game.localOwner].resources;
  const have = Math.floor(res[com] || 0);
  const sellPrice = unitPrice(state.market, com, "sell");
  const buyPrice = unitPrice(state.market, com, "buy");
  const sell4Qty = Math.min(TRADE_LOT * 4, have);
  const bulkLocked = have < TRADE_LOT;
  return {
    label: `${meta?.ico ? meta.ico + " " : ""}${meta?.name || com} ◈${Math.round(sellPrice)}`,
    trend: marketTrend(state.market, com),
    sellDisabled: bulkLocked,
    sellTitle: `Sell ${TRADE_LOT} ${com} for ~◈${Math.round(sellPrice * TRADE_LOT)}`,
    sell4Disabled: bulkLocked,
    sell4Title: bulkLocked
      ? `Sell ${TRADE_LOT * 4} ${com} — need at least ${TRADE_LOT}`
      : `Sell ${sell4Qty} ${com} for ~◈${quoteSell(state.market, com, sell4Qty)}`,
    sellAllDisabled: bulkLocked,
    sellAllTitle: bulkLocked
      ? `Sell All — need at least ${TRADE_LOT}`
      : `Sell all ${have} ${com} for ~◈${quoteSell(state.market, com, have)}`,
    buyDisabled: !(game.galaxy.credits >= buyPrice * TRADE_LOT),
    buyTitle: `Buy ${TRADE_LOT} ${com} for ~◈${Math.round(buyPrice * TRADE_LOT)}`,
  };
}

// Live-patch every Market row already in the DOM: the price label, and each Buy/Sell button's
// disabled state + tooltip. Called once right after renderMarket builds the rows, and again on
// every renderSelectionPanel() tick (hudSelection.js's own signature-guard section) — a trade's
// slippage relaxes back toward equilibrium continuously (engine/market.js updateMarket), so the
// underlying price is nearly always drifting. That has to be a PATCH, not folded into the panel's
// rebuild signature: the signature only triggers a full rebuild — tearing down and recreating the
// very Buy/Sell buttons the player may be repeatedly clicking — which is the dropped-click hazard
// the rebuild-signature guard exists to avoid (see the comment above renderSelectionPanel's own
// signature). Patching text/class/title in place instead keeps the price live with zero risk of
// replacing a button out from under an in-flight click.
//
// `.market-row`/`.market-com` are reused far beyond actual Market rows — freighter cargo,
// Freight Lane ship entries, and Colony Standing Orders rows all borrow the same layout classes
// purely for their shared flexbox/spacing styling (see renderFreight's own "Reuses the market
// row styling" comment). Only a REAL market row also carries `data-com` (set by renderMarket,
// just below), so that's the signal this patch keys its scope on — anything else is a
// differently-shaped row this function has no business rewriting. Skipping it here, rather than
// making every other call site set a `data-com` it doesn't otherwise need, is what actually
// fixes it: a row that opted OUT of `data-com` was never asking to be live-priced, and giving it
// one would just make marketRowFields silently stamp a price/trend readout over content it
// doesn't apply to instead of leaving the row alone. Without this guard, any of those OTHER rows
// gets its label clobbered on the very next tick — `marketRowFields(state, undefined)` resolves
// no commodity and no price, so the row reads "undefined ◈NaN" moments after rendering correctly
// (reported against a live save: a Bulk Freighter's cargo panel showing exactly that for every
// row, immediately after selecting it).
function refreshMarketRows(state) {
  panelEl.querySelectorAll(".market-row").forEach(row => {
    const com = row.dataset.com;
    if (!com || !COM[com]) return;
    const fields = marketRowFields(state, com);
    const label = row.querySelector(".market-com");
    if (label) label.textContent = fields.label;
    const trend = row.querySelector(".market-trend");
    if (trend) trend.textContent = fields.trend;
    const sellBtn = row.querySelector(".market-sell");
    if (sellBtn) { sellBtn.className = "market-btn market-sell" + (fields.sellDisabled ? " disabled" : ""); sellBtn.title = fields.sellTitle; }
    const sell4Btn = row.querySelector(".market-sell4");
    if (sell4Btn) { sell4Btn.className = "market-btn market-sell4" + (fields.sell4Disabled ? " disabled" : ""); sell4Btn.title = fields.sell4Title; }
    const sellAllBtn = row.querySelector(".market-sellall");
    if (sellAllBtn) { sellAllBtn.className = "market-btn market-sellall" + (fields.sellAllDisabled ? " disabled" : ""); sellAllBtn.title = fields.sellAllTitle; }
    const buyBtn = row.querySelector(".market-buy");
    if (buyBtn) { buyBtn.className = "market-btn market-buy" + (fields.buyDisabled ? " disabled" : ""); buyBtn.title = fields.buyTitle; }
  });
}

// The Odyssey trade panel, shown under a finished Market building (moved off the Command
// Center so a destroyed/absent CC doesn't strand a colony without a market). One row per
// tradeable commodity: its live sell price, and Sell/Buy buttons in fixed lots. Selling
// banks universal credits (and nudges the local price down); buying spends them (and
// nudges it up) — see engine/market.js.
function renderMarket(state) {
  const coms = tradeables(state);
  // A collapsible clickable header, but keeping the market-head gold accent (its own properties
  // don't overlap with sel-collapsible's button-chrome reset/hover, so both classes compose
  // cleanly) — up to 23 commodities is the single largest cluster in the whole CC panel.
  const collapsed = game.collapsedSections.has("market");
  const head = document.createElement("button");
  head.className = "market-head sel-collapsible";
  head.type = "button";
  head.textContent = `${collapsed ? "▸" : "▾"} Market — trade local goods for credits (${coms.length})`;
  head.addEventListener("click", () => {
    if (collapsed) game.collapsedSections.delete("market"); else game.collapsedSections.add("market");
    renderHUD();
  });
  panelEl.appendChild(head);
  if (collapsed) return;

  const res = state.players[game.localOwner].resources;
  for (const com of coms) {
    const row = document.createElement("div");
    row.className = "market-row";
    row.dataset.com = com;

    const label = document.createElement("span");
    label.className = "market-com";
    row.appendChild(label);

    const trend = document.createElement("span");
    trend.className = "market-trend";
    row.appendChild(trend);

    const sellBtn = document.createElement("button");
    sellBtn.className = "market-btn market-sell";
    sellBtn.textContent = `Sell ${TRADE_LOT}`;
    sellBtn.addEventListener("click", () => {
      if (Math.floor(res[com] || 0) >= TRADE_LOT) { sell(game.galaxy, state, com, TRADE_LOT); renderHUD(); }
      else sound.playProductionBlocked();
    });
    row.appendChild(sellBtn);

    // Sell x4 / Sell All both pass their FULL held qty straight to the real sell() — it already
    // self-limits via marginal lot pricing (engine/market.js), so there's nothing to compute here
    // beyond "how much do we actually hold right now" (re-read fresh at click time, same as the
    // plain Sell button just above).
    const sell4Btn = document.createElement("button");
    sell4Btn.className = "market-btn market-sell4";
    sell4Btn.textContent = `Sell ${TRADE_LOT * 4}`;
    sell4Btn.addEventListener("click", () => {
      const qty = Math.min(TRADE_LOT * 4, Math.floor(res[com] || 0));
      if (qty >= TRADE_LOT) { sell(game.galaxy, state, com, qty); renderHUD(); }
      else sound.playProductionBlocked();
    });
    row.appendChild(sell4Btn);

    const sellAllBtn = document.createElement("button");
    sellAllBtn.className = "market-btn market-sellall";
    sellAllBtn.textContent = "Sell All";
    sellAllBtn.addEventListener("click", () => {
      const qty = Math.floor(res[com] || 0);
      if (qty >= TRADE_LOT) { sell(game.galaxy, state, com, qty); renderHUD(); }
      else sound.playProductionBlocked();
    });
    row.appendChild(sellAllBtn);

    const buyBtn = document.createElement("button");
    buyBtn.className = "market-btn market-buy";
    buyBtn.textContent = `Buy ${TRADE_LOT}`;
    buyBtn.addEventListener("click", () => {
      if (game.galaxy.credits >= unitPrice(state.market, com, "buy") * TRADE_LOT) { buy(game.galaxy, state, com, TRADE_LOT); renderHUD(); }
      else sound.playProductionBlocked();
    });
    row.appendChild(buyBtn);

    panelEl.appendChild(row);
  }
  refreshMarketRows(state);
}


// Freighter cargo hold (Odyssey): load specific goods off THIS world's stockpile into the selected
// freighter, or unload them back — the manual control over what each ship carries on a jump
// (engine/galaxy.js load/unloadFreighter). A hold left empty stays empty at jump time — nothing
// auto-fills any more (engine/galaxy.js loadCargo), so a ship you're deliberately sending home
// empty (to load on the way back only) actually arrives empty. Reuses the market row styling.
function renderFreight(state, f) {
  const cap = UNITS[f.type].cargoHold, used = freightUsed(f), room = freightRoom(f);
  const res = state.players[game.localOwner].resources;

  const head = document.createElement("div");
  head.className = "market-head";
  head.textContent = `🚚 ${UNITS[f.type].name} — hold ${Math.round(used)}/${cap}`;
  panelEl.appendChild(head);

  // Bulk shortcuts: fill the remaining room most-valuable-first, or empty the whole hold to stock.
  const bulk = document.createElement("div");
  bulk.className = "market-row";
  const autoBtn = document.createElement("button");
  autoBtn.className = "market-btn" + (room <= 0 ? " disabled" : "");
  autoBtn.textContent = "Auto-load ▲";
  autoBtn.title = "Fill the remaining hold with the most valuable goods on this world";
  autoBtn.addEventListener("click", () => {
    const manifest = cargoManifest(state, freightRoom(f));
    let any = false;
    for (const com in manifest) if (loadFreighter(state, f.id, com, manifest[com]) > 0) any = true;
    if (any) renderHUD(); else sound.playProductionBlocked();
  });
  bulk.appendChild(autoBtn);
  const clearBtn = document.createElement("button");
  clearBtn.className = "market-btn" + (used <= 0 ? " disabled" : "");
  clearBtn.textContent = "Unload all ▼";
  clearBtn.title = "Unload the whole hold back onto this world's stockpile";
  clearBtn.addEventListener("click", () => {
    let any = false;
    for (const com of Object.keys(f.freight)) if (unloadFreighter(state, f.id, com, f.freight[com]) > 0) any = true;
    if (any) renderHUD(); else sound.playProductionBlocked();
  });
  bulk.appendChild(clearBtn);
  panelEl.appendChild(bulk);

  // One row per commodity that's either aboard already or sitting in this world's stockpile: load
  // all of it that fits, or unload all that's aboard, in one tap each. Collapsible — up to ~22
  // commodities is the single biggest list in the whole panel system.
  const coms = loadableComs(state, f);
  if (sectionToggle("freighter:cargo", "Cargo", coms.length)) {
    for (const com of coms) {
      const meta = COM[com];
      const aboard = Math.floor(f.freight[com] || 0), stock = Math.floor(res[com] || 0);
      const row = document.createElement("div");
      row.className = "market-row";
      const label = document.createElement("span");
      label.className = "market-com";
      label.textContent = `${meta?.ico ? meta.ico + " " : ""}${meta?.name || com} · ${aboard} aboard`;
      row.appendChild(label);

      const loadBtn = document.createElement("button");
      loadBtn.className = "market-btn" + (stock < 1 || room <= 0 ? " disabled" : "");
      loadBtn.textContent = "Load";
      loadBtn.title = `Load ${meta?.name || com} onto the ${UNITS[f.type].name} (as much as fits)`;
      loadBtn.addEventListener("click", () => {
        if (loadFreighter(state, f.id, com, freightRoom(f)) > 0) renderHUD(); else sound.playProductionBlocked();
      });
      row.appendChild(loadBtn);

      const unBtn = document.createElement("button");
      unBtn.className = "market-btn" + (aboard < 1 ? " disabled" : "");
      unBtn.textContent = "Unload";
      unBtn.title = `Unload ${meta?.name || com} back onto this world`;
      unBtn.addEventListener("click", () => {
        if (unloadFreighter(state, f.id, com, f.freight[com] || 0) > 0) renderHUD(); else sound.playProductionBlocked();
      });
      row.appendChild(unBtn);
      panelEl.appendChild(row);
    }
  }
}

// A freighter's AI-LOGISTICS toggle: once FREIGHTER_AI_TECH is researched (a Datacenter node —
// engine/techtree.js), fold it into the local haul/service chain like a worker (engine/sim.js
// updateUnit), at its own cargoHold-sized capacity per trip — routed through issueSetAILogistics
// (engine/commands.js) rather than a bare direct mutation (the Mender/Bomb toggles' usual idiom)
// because turning it ON has to re-check the research gate.
function renderAILogistics(state, f) {
  const upgrades = state.players[game.localOwner].upgrades;
  if (!upgrades[FREIGHTER_AI_TECH]) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "Research Autonomous Freight AI at a Datacenter to fold this ship into your local logistics chain like a worker.";
    panelEl.appendChild(hint);
    return;
  }
  const on = !!f.aiLogistics;
  panelEl.appendChild(makeButton(on ? "🤖 AI Logistics: ON" : "🤖 AI Logistics: OFF",
    () => { game.transport.submitCommand({ t: "setAILogistics", ids: [f.id], on: !on }); renderHUD(); },
    { tip: on ? "Stand down — it stops auto-hauling and waits for your orders"
              : `Put it to work in the local haul/service chain like a worker, at its full ${UNITS[f.type].cargoHold} cargo hold per trip` }));
  if (on) {
    const res = state.players[game.localOwner].resources;
    const rate = aiUpkeepRate(f);
    const stalled = (res.ai || 0) <= 1e-6;
    const row = document.createElement("div");
    row.className = "sel-note " + (stalled ? "bad" : "good");
    row.textContent = stalled
      ? `⚠ STALLED — out of AI Cores (burns ${rate.toFixed(2)}/s while active)`
      : `Autonomous — burning ${rate.toFixed(2)} AI Cores/s (${Math.floor(res.ai || 0)} in reserve)`;
    panelEl.appendChild(row);
  }
}

// A freighter's COLLECTION-POINT toggle: once switched on, a full hold triggers a SHUTTLE run to
// the nearest Command Center and back to its anchor (engine/haul.js assignShuttle/
// updateFreighterShuttle) — no research needed, unlike AI Logistics. Routed through
// issueSetCollectPoint (engine/commands.js) so the anchor-stamping lives in one place, not
// duplicated at every call site.
function renderCollectPoint(state, f) {
  const on = !!f.collectPoint;
  panelEl.appendChild(makeButton(on ? "📍 Collection Point: ON" : "📍 Collection Point: OFF",
    () => { game.transport.submitCommand({ t: "setCollectPoint", ids: [f.id], on: !on }); renderHUD(); },
    { tip: on ? "Stand down — it stops shuttling to the Command Center on its own"
              : "Anchor it here: once its hold fills up, it drives itself to the nearest Command Center, unloads, and comes back" }));
  if (on) {
    const used = freightUsed(f), cap = UNITS[f.type].cargoHold;
    const shuttling = f.order && f.order.type === "shuttle";
    const row = document.createElement("div");
    row.className = "sel-note " + (shuttling ? "warn" : "good");
    row.textContent = shuttling
      ? `Shuttling ${f.order.phase === "toCC" ? "to the Command Center to unload" : "back to its anchor"}…`
      : `Collecting at this spot — ${Math.round(used)}/${cap} aboard`;
    panelEl.appendChild(row);
  }
}


// A "Grid: On-grid · draws ×1.0" line for a selected power consumer (factory / rig),
// its colour keyed to the efficiency tier (engine/industry.js powerEfficiency): the
// further it sits from a Reactor, the more grid capacity it draws — so this tells the
// player at a glance whether it's well-sited or bleeding the grid on transmission loss.
function gridEfficiencyRow(state, b) {
  const eff = powerEfficiency(state, b.owner, b.x, b.y);
  const row = document.createElement("div");
  const cls = eff.mult <= 1.001 ? "good" : eff.mult < 1.5 ? "" : eff.mult < 2 ? "warn" : "bad";
  row.className = "sel-note " + cls;
  row.textContent = eff.mult <= 1.001
    ? `Grid: ${eff.label} · full efficiency (draws ×1.0)`
    : `Grid: ${eff.label} · draws ×${eff.mult.toFixed(1)} Power — closer to a Reactor is cheaper`;
  return row;
}

// A "❄ Ice Coolant" status line for a selected factory / Rig / power station: banked ice
// (engine/industry.js iceCoolantMult) halves its fuel/input burn and Power draw for as long as ANY
// is in the treasury — but running it isn't free, chargeIceUpkeep drains a little of that ice every
// tick it's actually benefiting, so the discount (and this row) lasts only as long as the ice does.
// Shown either way (not just when active), the same discoverability gridEfficiencyRow already gives
// grid placement, so a player who's never banked ice learns the mechanic exists instead of
// wondering why a rival's economy runs so much leaner.
function iceCoolantRow(state, owner) {
  const active = iceCoolantMult(state, owner) < 1;
  const row = document.createElement("div");
  row.className = "sel-note " + (active ? "good" : "");
  row.textContent = active
    ? "❄ Ice Coolant active — half fuel/input burn, half Power draw (draining banked ice)"
    : "No ice banked — bank some to halve fuel/input burn and Power draw";
  return row;
}

// A factory/power-station's per-building LOGISTICS PRIORITY (engine/commands.js
// issueSetLogiPriority, engine/haul.js priorityWeight): a cycle button, high -> normal -> low ->
// high on each click — "keep the Reactor fed before the Smelter" without dedicating a
// permanently-manual worker to it. Shared by the factory and fuel-burning power-station panels
// below, same idiom as gridEfficiencyRow/iceCoolantRow just above.
const LOGI_PRIORITY_NEXT = { high: "low", normal: "high", low: "normal" };
const LOGI_PRIORITY_LABEL = { high: "▲ High", normal: "● Normal", low: "▽ Low" };
function renderLogiPriority(state, b) {
  const cur = LOGI_PRIORITIES.includes(b.logiPriority) ? b.logiPriority : "normal";
  panelEl.appendChild(makeButton(`Logistics priority: ${LOGI_PRIORITY_LABEL[cur]}`,
    () => { game.transport.submitCommand({ t: "setLogiPriority", building: b.id, p: LOGI_PRIORITY_NEXT[cur] }); renderHUD(); },
    { tip: cur === "high" ? "Draws haulers from further away and gets one extra hauler/server slot — click to drop to Low"
        : cur === "low" ? "Only served once nothing higher-priority needs the worker — click to reset to Normal"
        : "Even weight with every other building — click to raise to High" }));
}

// The Odyssey diplomacy panel, under the Command Center's market. Three independent levers:
// tribute (brake — appease a cooling-or-worse neighbour with credits), gifts (accelerator — hand
// over local goods to build goodwill toward Allied) and favor requests (an occasional bespoke ask
// that pays a premium). Unlike tribute, gifts/favors are useful precisely once the neighbour is
// ALREADY comfortably cordial — pushing further, toward Allied — so this panel (unlike tribute's
// own button below) stays visible across the whole stance range, not just once it's cooled.
function renderDiplomacy(state) {
  const dip = state.diplomacy;

  const head = document.createElement("div");
  head.className = "market-head";
  head.textContent = `Diplomacy — ${stanceLabel(dip.stance)} neighbour`;
  panelEl.appendChild(head);

  // Tribute: pay universal credits to appease the neighbour for a while (engine/diplomacy.js
  // offerTribute). The cost escalates per tribute and the truce decays, so it's a stopgap — buy
  // time to weather a wave or finish a jump, not a permanent peace. A charging Antimatter Gate is
  // unappeasable, by design. Credit-gated via locked/lockTip (NOT makeButton's `cost`, which
  // checks the LOCAL economy), the same idiom as the Spaceport jump. Shown only once the stance
  // has cooled to Neutral-or-worse — no point paying to appease while comfortably cordial.
  if (dip.stance < 0.25) {
    const cost = tributeCost(dip);
    const afford = game.galaxy.credits >= cost;
    panelEl.appendChild(makeButton(`Send tribute (◈${cost})`,
      () => { offerTribute(game.galaxy, state); },   // makeButton adds renderHUD() on the affordable path
      { tip: `Buy ~${APPEASE_TIME}s of peace — the neighbour stands down, but the truce decays and each tribute costs more. A charging Gate can't be bought off.`,
        locked: !afford,
        lockTip: `Need ◈${cost} — you have ◈${Math.floor(game.galaxy.credits)}` }));
  }

  renderFavorRequest(state);
  renderGiftPicker(state);
}

// "⭐ Favor requested — 42s left" plus a Fulfill button, shown only while dip.request is live
// (engine/diplomacy.js updateDiplomacy rolls one every few minutes for a peaceful neighbour, and
// clears it on its own once the deadline passes). Fulfilling pays the exact ask in full — no
// partial credit, this is a favor, not a market trade — for a credit reward plus a goodwill bump.
// The countdown text carries its own ".favor-progress" class so renderSelectionPanel's per-tick
// patch (right after refreshMarketRows) can keep it live without a full rebuild, same reasoning
// as the market rows' price patch.
function renderFavorRequest(state) {
  const req = state.diplomacy.request;
  if (!req || state.time >= req.until) return;
  const meta = COM[req.com];
  const have = Math.floor(state.players[game.localOwner].resources[req.com] || 0);
  const afford = have >= req.qty;

  const head = document.createElement("div");
  head.className = "market-head favor-progress";
  head.textContent = favorRowText(state, req);
  panelEl.appendChild(head);

  panelEl.appendChild(makeButton(
    `Fulfill: ${req.qty} ${meta?.ico ? meta.ico + " " : ""}${meta?.name || req.com} (◈${req.reward})`,
    () => { fulfillRequest(game.galaxy, state); },
    { tip: `The neighbour needs ${req.qty} ${meta?.name || req.com} — bring it before the deadline for ◈${req.reward} credits and a goodwill bump toward Allied`,
      locked: !afford,
      lockTip: `Need ${req.qty} ${meta?.name || req.com} — you have ${have}` }));
}

// "⭐ Favor requested — 42s left" — shared by renderFavorRequest (the initial build) and the
// per-tick live patch below so the two can never drift apart, same rule researchRowText/
// recycleRowText already follow for their own progress rows.
function favorRowText(state, req) {
  return `⭐ Favor requested — ${Math.max(0, Math.ceil(req.until - state.time))}s left`;
}

// One row per commodity the player currently holds at least a full lot of (engine/market.js
// TRADE_LOT — the same increment Gift hands over): a Gift button that calls offerGift, reusing
// the market row's own styling. No afford-gating needed beyond that filter — every row shown is
// already gift-able for the full TRADE_LOT. Silent (no header, no rows) once nothing qualifies,
// so a bare-stockpile early game doesn't clutter the panel with an empty picker.
function renderGiftPicker(state) {
  const res = state.players[game.localOwner].resources;
  const held = Object.keys(COM).filter(c => Math.floor(res[c] || 0) >= TRADE_LOT);
  if (!held.length) return;

  const pct = Math.round(((state.diplomacy.goodwill || 0) / GOODWILL_CAP) * 100);
  const head = document.createElement("div");
  head.className = "market-head";
  head.textContent = `Gift goods — raise goodwill toward Allied (${pct}% banked)`;
  panelEl.appendChild(head);

  for (const com of held) {
    const meta = COM[com];
    const row = document.createElement("div");
    row.className = "market-row";
    row.dataset.com = com;

    const label = document.createElement("span");
    label.className = "market-com";
    label.textContent = `${meta?.ico ? meta.ico + " " : ""}${meta?.name || com}`;
    row.appendChild(label);

    const giftBtn = document.createElement("button");
    giftBtn.className = "market-btn";
    giftBtn.textContent = `Gift ${TRADE_LOT}`;
    giftBtn.title = `Hand over ${TRADE_LOT} ${meta?.name || com} (~◈${Math.round(TRADE_LOT * unitPrice(state.market, com, "sell"))} of local value) to build goodwill toward Allied`;
    giftBtn.addEventListener("click", () => { offerGift(state, com, TRADE_LOT); renderHUD(); });
    row.appendChild(giftBtn);

    panelEl.appendChild(row);
  }
}

// Freight Lanes (Odyssey): standing shipping between held worlds, set up here at a Spaceport.
// A ship assigned to a lane stops being a jump rider (galaxy.js stagedRiders/jumpManifestAll
// exclude it) — it's a fixed route now, delivering cargo every LANE_PERIOD (engine/galaxy.js
// runLanes) straight from this world's treasury to the destination's, no jump or player
// attention required.
function renderLanes(state, spaceport) {
  const g = game.galaxy;
  const fromId = g.activeId;
  const lanes = (g.lanes || []).filter(l => l.from === fromId);

  if (!sectionToggle("spaceport:lanes", "Freight Lanes", lanes.length)) return;

  for (const lane of lanes) {
    const capacity = lane.shipIds.reduce((sum, id) => {
      const u = state.units.get(id);
      return sum + (u ? (UNITS[u.type]?.cargoHold || 0) : 0);
    }, 0);
    const head = document.createElement("div");
    head.className = "market-head";
    head.textContent = `🚀 Lane ▸ ${planetName(lane.to)} — ${lane.shipIds.length} ship${lane.shipIds.length === 1 ? "" : "s"} · ${capacity} cap/cycle`;
    panelEl.appendChild(head);

    // Commodity filter: a chip per CARGO_GOODS entry, toggled directly on the lane (a plain array
    // on galaxy state — the same "flip a field, re-render" idiom the Electrify toggle above uses).
    // At least one commodity always stays included, so the filter can never silently go empty.
    const filterRow = document.createElement("div");
    filterRow.className = "market-row";
    for (const com of CARGO_GOODS) {
      const included = lane.commodities.includes(com);
      const chip = document.createElement("button");
      chip.className = "market-btn";
      chip.textContent = `${included ? "✓" : "—"} ${COM[com]?.name || com}`;
      chip.title = included ? "Shipped by this lane — click to exclude" : "Excluded — click to ship it too";
      chip.addEventListener("click", () => {
        if (included) { if (lane.commodities.length > 1) lane.commodities = lane.commodities.filter(c => c !== com); }
        else lane.commodities.push(com);
        renderHUD();
      });
      filterRow.appendChild(chip);
    }
    panelEl.appendChild(filterRow);

    for (const id of lane.shipIds) {
      const u = state.units.get(id);
      const row = document.createElement("div");
      row.className = "market-row";
      const label = document.createElement("span");
      label.className = "market-com";
      label.textContent = u ? `${UNITS[u.type].name} (${UNITS[u.type].cargoHold} cap)` : "(lost)";
      row.appendChild(label);
      const releaseBtn = document.createElement("button");
      releaseBtn.className = "market-btn";
      releaseBtn.textContent = "Release";
      releaseBtn.title = "Free this ship from the lane — it can jump or take orders normally again";
      releaseBtn.addEventListener("click", () => { unassignShipFromLane(g, lane.id, id); renderHUD(); });
      row.appendChild(releaseBtn);
      panelEl.appendChild(row);
    }

    // Every player freighter parked at THIS pad and not already committed to some lane.
    const available = [...state.units.values()].filter(u =>
      u.owner === game.localOwner && UNITS[u.type]?.cargoHold && !u.laneId
      && Math.hypot(u.x - spaceport.x, u.y - spaceport.y) <= JUMP_LOAD_RADIUS);
    for (const u of available) {
      panelEl.appendChild(makeButton(`Assign ${UNITS[u.type].name} (${UNITS[u.type].cargoHold} cap)`,
        () => { assignShipToLane(g, lane.id, u.id); renderHUD(); },
        { tip: "Park it here for good — it stops riding jumps and starts shipping this lane's cargo automatically, every few seconds of galaxy time." }));
    }

    panelEl.appendChild(makeButton("✕ Disband Lane", () => { deleteLane(g, lane.id); renderHUD(); },
      { tip: "Free every assigned ship and remove this route." }));
  }

  // New lane: any OTHER world you actually hold a colony on (a real destination treasury) —
  // shipping cargo to a world you don't hold has nowhere useful to land.
  const targets = g.worlds.filter(w => w !== fromId).filter(w => {
    const s = g.planets.get(w);
    return s && [...s.buildings.values()].some(b => b.owner === game.localOwner);
  });
  for (const w of targets) {
    panelEl.appendChild(makeButton(`+ New Lane ▸ ${planetName(w)}`,
      () => { createLane(g, fromId, w, [...CARGO_GOODS]); renderHUD(); },
      { tip: "Open a standing route (every commodity, by default): assign freighters below to ship this world's surplus there automatically." }));
  }
  if (!targets.length) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "No other colony to route to yet — settle a second world to open a lane.";
    panelEl.appendChild(hint);
  }
}

// Colony standing orders (Odyssey), set on a Command Center: what a background colony does
// with itself once you leave it. Both policies are opt-in (off by default — a fresh colony is
// inert, exactly like today) and take effect only while this world is a BACKGROUND colony
// (engine/colonyPolicy.js runColonyPolicies) — the active seat is your own hands-on orders.
// Editable here or from the starmap's per-colony row (starmap.js).
function renderColonyPolicy(state, cc) {
  const g = game.galaxy;
  const planetId = state.planetId;
  const policy = getColonyPolicy(g, planetId);

  const head = document.createElement("div");
  head.className = "market-head";
  head.textContent = "📜 Standing Orders — takes effect once this becomes a background colony";
  panelEl.appendChild(head);

  // Sustain workers: re-queue at THIS CC (from the colony's own stockpile) when under target,
  // and re-task any idle worker on the world to gather. One target for the whole world.
  const wtRow = document.createElement("div");
  wtRow.className = "market-row";
  const wtLabel = document.createElement("span");
  wtLabel.className = "market-com";
  wtLabel.textContent = `Sustain workers: ${policy.workerTarget > 0 ? policy.workerTarget : "off"}`;
  wtRow.appendChild(wtLabel);
  const dec = document.createElement("button");
  dec.className = "market-btn";
  dec.textContent = "−";
  dec.title = "Lower the sustained worker headcount";
  dec.addEventListener("click", () => { setColonyPolicy(g, planetId, { workerTarget: Math.max(0, policy.workerTarget - 1) }); renderHUD(); });
  wtRow.appendChild(dec);
  const inc = document.createElement("button");
  inc.className = "market-btn";
  inc.textContent = "+";
  inc.title = "Raise the sustained worker headcount";
  inc.addEventListener("click", () => { setColonyPolicy(g, planetId, { workerTarget: policy.workerTarget + 1 }); renderHUD(); });
  wtRow.appendChild(inc);
  panelEl.appendChild(wtRow);

  // Auto-sell surplus: sell stock above a per-commodity floor into THIS world's own market
  // (the real sell() path — real slippage, real glut). Additive on top of the existing flat
  // per-building passive income, not a replacement for it.
  const asRow = document.createElement("div");
  asRow.className = "market-row";
  const asBtn = document.createElement("button");
  asBtn.className = "market-btn";
  asBtn.textContent = policy.autoSell.enabled ? "Auto-sell surplus: ON" : "Auto-sell surplus: OFF";
  asBtn.title = "Sell stock above each commodity's floor into this world's own market while it's a background colony — on top of the flat per-building income, not instead of it.";
  asBtn.addEventListener("click", () => { setColonyPolicy(g, planetId, { autoSell: { enabled: !policy.autoSell.enabled } }); renderHUD(); });
  asRow.appendChild(asBtn);
  panelEl.appendChild(asRow);

  if (policy.autoSell.enabled) {
    const coms = tradeables(state);
    if (sectionToggle("cc:autosell", "Auto-sell floors", coms.length)) {
      for (const com of coms) {
        const meta = COM[com];
        const floor = policy.autoSell.floors[com] || 0;
        const row = document.createElement("div");
        row.className = "market-row";
        const label = document.createElement("span");
        label.className = "market-com";
        label.textContent = `${meta?.ico ? meta.ico + " " : ""}${meta?.name || com} · keep ${floor}`;
        row.appendChild(label);
        const lower = document.createElement("button");
        lower.className = "market-btn";
        lower.textContent = `−${TRADE_LOT}`;
        lower.title = "Lower the floor — more of this commodity sells";
        lower.addEventListener("click", () => { setColonyPolicy(g, planetId, { autoSell: { floors: { [com]: Math.max(0, floor - TRADE_LOT) } } }); renderHUD(); });
        row.appendChild(lower);
        const raise = document.createElement("button");
        raise.className = "market-btn";
        raise.textContent = `+${TRADE_LOT}`;
        raise.title = "Raise the floor — less of this commodity sells (more stays banked)";
        raise.addEventListener("click", () => { setColonyPolicy(g, planetId, { autoSell: { floors: { [com]: floor + TRADE_LOT } } }); renderHUD(); });
        row.appendChild(raise);
        panelEl.appendChild(row);
      }
    }
  }
}

// The Odyssey Capital control on a Command Center: this CC is already the anchored
// Capital (a note, and nothing else — it's permanent), or it's still a plain CC that can
// EITHER fortify into the Capital (if the player doesn't have one yet elsewhere) OR pack
// up and relocate (always available on a plain CC, even once a Capital exists elsewhere —
// "only a smaller CC relocates"). Fortifying doubles HP and anchors it for good; packing is
// the opposite bet — trade the building for a Colony Ship and re-found somewhere else.
function renderCapital(state, cc) {
  if (cc.capital) {
    const row = document.createElement("div");
    row.className = "sel-note good";
    row.textContent = `◆ Capital — anchored fortress (${Math.ceil(cc.hp)}/${cc.maxHp} hp). Defends, never jumps.`;
    panelEl.appendChild(row);
    return;
  }
  if (![...state.buildings.values()].some(b => b.owner === game.localOwner && b.capital)) {
    panelEl.appendChild(makeButton(`◆ Upgrade to Capital (${costText(CAPITAL_UPGRADE_COST)})`,
      () => { upgradeToCapital(state, cc); },
      { cost: CAPITAL_UPGRADE_COST, icon: { kind: "building", type: "command" },
        tip: `Fortify this Command Center into your anchored Capital: ×${CAPITAL_HP_MULT} HP. The Capital never jumps — only a smaller CC relocates.` }));
  }
  panelEl.appendChild(makeButton(`📦 Pack Up (${costText(PACK_COST)})`,
    () => { packCommandCenter(state, cc.id); },
    { cost: PACK_COST, icon: { kind: "unit", type: "colonyship" },
      tip: "Pack this Command Center back into a Colony Ship — move it to a new site and deploy it there, like your original landing. Any queued production is refunded first." }));
}

// Positional production/build hotkeys: the Nth produce/build button of the current panel is
// bound to the Nth of these keys (annotated on the label, like "Stop ( X )"). Chosen to avoid
// every existing key (digits, X/Q/E/A/H, P, `, M, WASD/arrows). game.hotkeyActions is the live
// list input.js invokes; each entry mimics a real click (so a locked option just buzzes).
const PANEL_HOTKEYS = ["z", "c", "v", "b", "n"];
let panelActions = [];
// A produce/build button that also claims the next positional hotkey. Wraps makeButton, shows
// the key in the label, and registers a click-mimicking action. Non-primary buttons (upgrades,
// market, tribute) keep plain makeButton and take no hotkey.
function prodButton(label, run, opts) {
  const key = PANEL_HOTKEYS[panelActions.length];
  const btn = makeButton(key ? `${label}  ( ${key.toUpperCase()} )` : label, run, opts);
  panelActions.push({ key, click: () => btn.click() });   // click() replays the real handler (incl. the disabled buzz)
  return btn;
}

// Shared collapsible-section header: a quiet clickable divider (▾ expanded / ▸ collapsed) that
// remembers its own open/closed state on game.collapsedSections (session.js) — a Set of collapsed
// section keys, so any number of independent sections can each fold without session.js growing a
// dedicated boolean per section. Appends the header button to panelEl and returns whether the
// section is currently expanded, so a call site wraps whatever it'd otherwise render
// unconditionally in `if (sectionToggle(key, label, count)) { ...buttons... }`.
function sectionToggle(key, label, count) {
  const collapsed = game.collapsedSections.has(key);
  const head = document.createElement("button");
  head.className = "sel-group sel-collapsible";
  head.type = "button";
  head.textContent = `${collapsed ? "▸" : "▾"} ${label} (${count})`;
  head.addEventListener("click", () => {
    if (collapsed) game.collapsedSections.delete(key); else game.collapsedSections.add(key);
    renderHUD();
  });
  panelEl.appendChild(head);
  return !collapsed;
}

// The units a building's panel should offer: the ENGINE's own roster, filtered by the ENGINE's own
// two gates. This used to be three hand-maintained copies of entities.js's `produces` lists — two
// identical literals plus a pair of unrolled blocks — so adding a unit to a roster made it
// buildable by the engine and by the AI while staying invisible in the UI, with nothing failing.
// The Odyssey gate was duplicated differently as well: queueProduction gates per-unit on
// `def.odysseyOnly && !state.endless`, while the HUD hand-split the array on game.galaxy.
//
// Module-level, taking `state` explicitly, rather than a closure inside rebuildSelectionPanel: the
// Command Center and Stardock panels both call it, and they now live in their own functions.
function producibleAt(state, type) {
  return (BUILDINGS[type].produces || []).filter(t => {
    const def = UNITS[t];
    if (!def) return false;
    if (def.odysseyOnly && !state.endless && !game.galaxy) return false;
    // A specialty unit whose cost commodity this world can neither mine nor stock is hidden rather
    // than shown forever-greyed — the engine's own availability rule (engine/market.js).
    return Object.keys(def.cost).every(c => commodityAvailable(state, game.localOwner, c));
  });
}

/* ============================================================
   ONE PANEL FAMILY, ONE FUNCTION

   rebuildSelectionPanel was 871 lines: a preamble, then two dozen independent
   `if (<thing selected>) { ...build its controls... }` blocks in a row. Nothing about that shape
   required one function — the blocks share only `state`, `sel` and `input`, and the file was
   already splitting the newer ones out (renderMarket, renderFreight, renderLanes, renderLanes'
   siblings). This finishes what that started, so the dispatcher reads as a table of contents and
   each family is editable without scrolling past the other eleven.

   hudPanelSignature.js's header asked for exactly this ("a model that important should be
   readable on its own, without scrolling past 800 lines of button construction") and
   docs/code-improvement-tiers.md files it as Tier 3. The registry of
   { match, signature, render } per family that both describe is the next step, and it is a much
   smaller one now that every family is already a named function.
   ============================================================ */

/** The rows at the TOP of the panel naming what is selected: aggregated by type when it is a
    pure multi-unit selection, one row per entity otherwise. Both branches are the same panel
    family, so they move together. */
function renderSelectionSummary(state, sel, input) {
if (sel.length > 1 && sel.every(e => e.kind === "unit")) {
  const counts = countByType(sel);
  const multiType = counts.size > 1;   // only worth sub-selecting when the mix has 2+ types
  for (const [type, entry] of counts) {
    const def = UNITS[type];
    const label = summaryRowLabel(type, entry);
    // With several types selected, each row is a button that narrows the selection
    // to just that type (input.selectType) — click "3× Bastion" to keep only them.
    if (multiType) {
      const btn = document.createElement("button");
      // sel-row-summary marks this as one of the per-entity summary rows the cheap
      // live-patch path in renderSelectionPanel() positionally rewrites each tick —
      // plain .sel-row alone isn't specific enough: half a dozen unrelated rows
      // elsewhere in this function (queue rows, researched-tech rows, the factory
      // recipe line, …) carry it too.
      btn.className = "sel-row sel-row-summary type-row";
      btn.textContent = label;
      btn.title = `Select only your ${def.name}s`;
      btn.addEventListener("click", () => input.selectType(type));
      panelEl.appendChild(btn);
    } else {
      const row = document.createElement("div");
      row.className = "sel-row sel-row-summary";
      row.textContent = label;
      panelEl.appendChild(row);
    }
  }
} else {
  sel.forEach(e => {
    const def = e.kind === "unit" ? UNITS[e.type] : BUILDINGS[e.type];
    const row = document.createElement("div");
    row.className = "sel-row sel-row-summary";
    row.textContent = `${def.name} — ${Math.ceil(e.hp)}/${e.maxHp} hp`;
    panelEl.appendChild(row);

    // Damaged (a completed building) or wounded (a unit): say so plainly, and whether a worker's
    // already patching it (engine/repair.js updateRepairJob/countRepairJobs) — the same "needs a
    // hauler" style stall note a factory/rig gets below, generalized to any structure or unit.
    if (!e.constructing && e.hp > 0 && e.hp < e.maxHp) {
      const repairing = (e.repairers || 0) > 0;
      const what = e.kind === "building" ? "Damaged" : "Wounded";
      const note = document.createElement("div");
      note.className = "sel-note " + (repairing ? "warn" : "bad");
      note.textContent = repairing
        ? `${what} — ${e.repairers} worker${e.repairers > 1 ? "s" : ""} repairing`
        : `${what} — right-click with a worker selected to repair`;
      panelEl.appendChild(note);
    }
    // A player-assigned home base (engine/commands.js issueSetHomeBase): this unit prefers that
    // Command Center's zone over the usual nearest-CC guess for its haul/service/ferry/repair
    // job search (engine/gather.js zoneFirst) — right-click a DIFFERENT Command Center to move
    // it, or the "Clear" button to fall back to plain nearest-distance.
    if (e.kind === "unit" && e.homeCC) {
      const home = state.buildings.get(e.homeCC);
      const note = document.createElement("div");
      note.className = "sel-note " + (home ? "good" : "");
      note.textContent = home ? "🏠 Home base assigned — jobs stay loyal to it first" : "🏠 Home base assigned (that Command Center is gone — using nearest-distance for now)";
      panelEl.appendChild(note);
      if (home) panelEl.appendChild(makeButton("Clear home base", () => { game.transport.submitCommand({ t: "setHomeBase", ids: [e.id], target: null }); renderHUD(); }, { tip: "Go back to picking jobs by plain nearest-distance" }));
    }
    // A gathering worker's node saturation (engine/gather.js miningEfficiency / sim.js
    // countMiners): node.miners is retallied every tick but nothing used to show it, so a
    // deposit six workers deep just read as ordinary slow income with no visible cause. Resolve
    // the order's node the same way updateGather does (nodesById when the map built one) and
    // report the live headcount against the worker's own soft cap, flagging the
    // diminishing-returns band (miningEfficiency's own cutoff) once it's crossed.
    if (e.kind === "unit" && e.order && e.order.type === "gather") {
      const node = state.map.nodesById
        ? state.map.nodesById.get(e.order.nodeId)
        : state.map.nodes.find(n => n.id === e.order.nodeId);
      const cap = UNITS[e.type].minerSoftCap;
      if (node && Number.isFinite(cap)) {
        const miners = node.miners || 0;
        const over = miners > cap;
        const note = document.createElement("div");
        note.className = "sel-note " + (over ? "warn" : "");
        note.textContent = `Miners ${miners}/${cap}` + (over ? " — diminishing returns" : "");
        panelEl.appendChild(note);
      }
    }
  });
}
}

/** Command Center: worker/support production, the home-base pin, and the Capital upgrade. */
function renderCommandCenter(state, cc) {
  // How many units are explicitly pinned to THIS Command Center as their home base
  // (engine/commands.js issueSetHomeBase) — right-click this CC with eligible units selected to
  // add more; right-click a DIFFERENT one to move them there instead.
  const homedHere = [...state.units.values()].filter(u => u.owner === game.localOwner && u.homeCC === cc.id).length;
  if (homedHere > 0) {
    const homeRow = document.createElement("div");
    homeRow.className = "sel-note good";
    homeRow.textContent = `🏠 ${homedHere} unit${homedHere > 1 ? "s" : ""} call this home — their jobs stay loyal to it first`;
    panelEl.appendChild(homeRow);
  }
  // Odyssey: the CC also builds Colony Ships — the mobile seed you deploy to found a
  // new base (no more building a CC directly). Gated on game.galaxy like the sibling
  // Odyssey CC panels below, so a skirmish CC shows only Worker/Ranger.
  // Odyssey adds the Colony Ship (found a base) and the three cargo ships (haul goods on a jump —
  // gated behind the Spaceport, so they surface once you've built the jump pad).
  const ccUnits = producibleAt(state, "command");
  // Collapsible: 7-11 produce buttons (base + altCost variants) is the biggest cluster on the
  // CC panel — count matches what a player thinks of as "the list" (one entry per unit type),
  // not the raw altCost-doubled button count.
  const ccCount = ccUnits.reduce((n, t) => n + (UNITS[t].altCost ? 2 : 1), 0);
  if (sectionToggle("cc:produce", "Produce", ccCount)) {
    for (const t of ccUnits) {
      const def = UNITS[t];
      const locked = !prereqsMet(state, game.localOwner, def);
      panelEl.appendChild(prodButton(`Produce ${def.name} (${costText(def.cost)})`,
        () => game.transport.submitCommand({ t: "queueProduction", building: cc.id, u: t }),
        { cost: def.cost, tip: unitTip(def), locked, lockTip: locked ? lockTipFor(def) : null, icon: { kind: "unit", type: t } }));
      // A unit with an alternative price (the Worker, buildable on biomass instead of ore) gets a
      // second button paying that cost — so a biomass-rich, ore-poor claim can still grow its labour.
      if (def.altCost) {
        panelEl.appendChild(prodButton(`Produce ${def.name} (${costText(def.altCost)})`,
          () => game.transport.submitCommand({ t: "queueProduction", building: cc.id, u: t, alt: true }),
          { cost: def.altCost, tip: `${def.name} paid in ${costText(def.altCost)} instead of ore`, locked,
            lockTip: locked ? lockTipFor(def) : null, icon: { kind: "unit", type: t } }));
      }
    }
  }
  if (cc.queue.length) renderQueueRows(cc);
  if (game.galaxy) renderCapital(state, cc);              // Odyssey: fortify this CC into the anchored Capital
  if (game.galaxy) renderColonyPolicy(state, cc);          // Odyssey: standing orders for once you leave this world
  // Odyssey diplomacy: tribute (appease), gifts, and favor requests — the panel itself always
  // shows once there's a neighbour to have one with; renderDiplomacy gates its OWN tribute
  // button to Neutral-or-worse, but gifts/favors matter across the whole stance range (they're
  // the lever that pushes an already-cordial world on toward Allied).
  if (game.galaxy && state.diplomacy) renderDiplomacy(state);
}

/** Refinery: the doctrine research list, tier- and doctrine-gated. */
function renderRefinery(state, refinery) {
  const upgrades = state.players[game.localOwner].upgrades;
  const chosen = committedDoctrine(state, game.localOwner);   // null until the first research commits (or queues) a doctrine
  const label = { assault: "Assault", bulwark: "Bulwark", logistics: "Logistics" };
  const queue = refinery.researchQueue || [];
  const queued = new Set(queue.map(j => j.techId));
  if (queue.length) {
    const row = document.createElement("div");
    row.className = "sel-row research-progress";   // patched live each tick (see renderSelectionPanel)
    row.textContent = researchRowText(queue, UPGRADES);
    panelEl.appendChild(row);
  }
  const visibleUpgrades = RESEARCHABLE_UPGRADES.filter(u => !queued.has(u.id));
  if (sectionToggle("refinery:research", "Research", visibleUpgrades.length)) {
    visibleUpgrades.forEach(u => {
      if (upgrades[u.id]) {
        const row = document.createElement("div");
        row.className = "sel-row";
        row.textContent = `${u.ico ? u.ico + " " : ""}${u.name} (${label[u.doctrine]}) — researched`;
        panelEl.appendChild(row);
        return;
      }
      const doctrineLocked = chosen && chosen !== u.doctrine;
      const tierLocked = !prereqsMet(state, game.localOwner, u);
      const locked = doctrineLocked || tierLocked;
      const lockTip = doctrineLocked ? `Locked — committed to the ${label[chosen]} doctrine`
        : tierLocked ? `Requires ${UPGRADES[(u.requires || [])[0]]?.name || "its Tier 1"}` : null;
      panelEl.appendChild(makeButton(`Research ${u.name} · ${label[u.doctrine]} (${costText(u.cost)})`,
        () => game.transport.submitCommand({ t: "researchUpgrade", building: refinery.id, up: u.id }),
        { cost: u.cost, tip: u.desc, locked, lockTip, icon: u.ico ? { emoji: u.ico } : null }));
    });
  }
}

/** Datacenter (Odyssey): the tech-tree research list. */
function renderDatacenter(state, datacenter) {
  const upgrades = state.players[game.localOwner].upgrades;
  const queue = datacenter.researchQueue || [];
  const queued = new Set(queue.map(j => j.techId));
  // Cancelable research queue with refunds: one row per queued node, each with its own ×
  // cancel button (renderResearchQueueRows — the production-queue's renderQueueRows idiom),
  // instead of the single un-cancelable summary row the Refinery's doctrine research still uses.
  if (queue.length) renderResearchQueueRows(datacenter, TECHS);
  // Already-queued nodes are dropped here (reflected in the progress row's "+N queued" above,
  // not repeated below), so the collapsible count matches exactly what the list itself shows.
  const visibleTechs = Object.values(TECHS).filter(t => !queued.has(t.id));
  if (sectionToggle("datacenter:research", "Research", visibleTechs.length)) {
    visibleTechs.forEach(t => {
      if (upgrades[t.id]) {
        const row = document.createElement("div");
        row.className = "sel-row";
        row.textContent = `${t.ico ? t.ico + " " : ""}${t.name} — researched`;
        panelEl.appendChild(row);
        return;
      }
      // Available if every prereq is researched, a completed building, or queued ahead.
      const ready = (t.requires || []).every(r => queued.has(r) || prereqsMet(state, game.localOwner, { requires: [r] }));
      panelEl.appendChild(makeButton(`Research ${t.name} (${costText(t.cost)})`,
        () => game.transport.submitCommand({ t: "researchTech", building: datacenter.id, tech: t.id }),
        { cost: t.cost, tip: t.desc, locked: !ready, lockTip: !ready ? lockTipFor(t) : null, icon: t.ico ? { emoji: t.ico } : null }));
    });
  }
}

/** Stardock: the heavy/Tier-3 unit production list. */
function renderStardock(state, stardock) {
  // Driven off BUILDINGS.stardock.produces like the CC and Barracks panels, rather than two
  // hand-unrolled blocks — the third shape this same roster used to be written in.
  for (const t of producibleAt(state, "stardock")) {
    const def = UNITS[t];
    const locked = !prereqsMet(state, game.localOwner, def);
    // The doomsday device gets an extra line about its blast (engine/bomb.js; it is built unarmed,
    // and arming is a separate step once it's out on the field).
    const tip = t === "heliumbomb"
      ? `${unitTip(def)} · ${BOMB_BLAST_RADIUS}-radius blast, ${BOMB_FUSE_DELAY}s fuse once triggered — damage falls off with distance from ground zero`
      : unitTip(def);
    panelEl.appendChild(prodButton(`Produce ${def.name} (${costText(def.cost)})`,
      () => queueProduction(state, stardock.id, t),
      { cost: def.cost, tip, locked, lockTip: locked ? lockTipFor(def) : null, icon: { kind: "unit", type: t } }));
  }
  if (stardock.queue.length) renderQueueRows(stardock);
}

/** Factory (Odyssey): recipe, power/throttle status, and the input/output larder. */
function renderFactory(state, factory) {
  const recipe = recipeOf(factory);
  const inParts = Object.entries(recipe.in)
    .filter(([c]) => c !== "energy")
    .map(([c, q]) => `${q}${COM[c]?.ico || ""} ${COM[c]?.name || c}`).join(" + ");
  const energy = recipe.in.energy || 0;
  const recRow = document.createElement("div");
  recRow.className = "sel-row";
  recRow.textContent = `${inParts} → ${recipe.qty} ${COM[recipe.out]?.name || recipe.out}`
    + (energy ? ` · ⚡${energy}` : "");
  panelEl.appendChild(recRow);

  const st = factoryStatus(state, factory, recipe);
  const stRow = document.createElement("div");
  stRow.className = "sel-note " + st.cls;
  stRow.textContent = st.text;
  panelEl.appendChild(stRow);

  // Local logistics buffers (engine/haul.js): the input larder workers fill and the output
  // buffer workers drain. Makes visible why a factory is fed/starved and clear/backed-up.
  // Each input commodity gets its OWN slice of the larder (entities.js inputCapOf — an
  // oversupplied one can never crowd out room for another the recipe still needs), so the
  // breakdown shows each commodity against ITS OWN cap rather than one misleading combined total.
  const input = factory.input || {};
  const inCap = inputCapOf(factory.type);
  const inList = Object.keys(recipe.in).filter(c => c !== "energy")
    .map(c => `${Math.floor(input[c] || 0)}/${Math.floor(inCap)}${COM[c]?.ico || ""}`).join(" ");
  const larder = document.createElement("div");
  larder.className = "sel-note";
  larder.textContent = `Larder${inList ? " " + inList : ""} — carried in by workers`;
  panelEl.appendChild(larder);

  const outBuf = document.createElement("div");
  const outPct = storeCapOf(factory.type) ? Math.round((storeTotal(factory) / storeCapOf(factory.type)) * 100) : 0;
  outBuf.className = "sel-note " + (storeRoom(factory) <= 1e-6 ? "bad" : outPct >= 66 ? "warn" : "");
  outBuf.textContent = `Output ${Math.round(storeTotal(factory))}/${storeCapOf(factory.type)} ${COM[recipe.out]?.name || recipe.out} — hauled to a Command Center`;
  panelEl.appendChild(outBuf);

  panelEl.appendChild(gridEfficiencyRow(state, factory));
  panelEl.appendChild(iceCoolantRow(state, factory.owner));
  renderLogiPriority(state, factory);

  // Pause toggle: stop this factory drawing down its inputs — the way to keep a hungry
  // Smelter from eating all your ore, or to free most of the grid for the Gate (a paused
  // factory still idles at a 5% Power trickle rather than freeing its whole reserved draw).
  panelEl.appendChild(makeButton(factory.paused ? "▶ Resume production" : "⏸ Pause production",
    () => { factory.paused = !factory.paused; },
    { tip: factory.paused ? "Resume converting inputs into goods"
                          : "Stop consuming inputs — banks nothing and idles its Power draw down to a 5% trickle until resumed" }));
}

/** Plasma Rig (Odyssey): extraction progress, power status and the output buffer. */
function renderPlasmaRig(state, rig) {
  const info = rigInfo(state, rig);
  const meta = COM[info.vein];
  const head = document.createElement("div");
  head.className = "sel-row";
  head.textContent = `⛏ Mining ${meta?.ico || ""} ${meta?.name || info.vein} · seam: ${info.richLabel}`;
  panelEl.appendChild(head);

  const progRow = document.createElement("div");
  progRow.className = "sel-note";
  progRow.textContent = `Dig ${Math.round(info.progress * 100)}%`
    + (info.lastTier ? ` · last strike: ${info.lastTier} (+${Math.round(info.lastYield)} ${meta?.name || info.vein})` : " · warming up…");
  panelEl.appendChild(progRow);

  // Finite output buffer (engine/haul.js): what's piled up waiting to be hauled to a
  // Command Center, and how close it is to full — the point at which the rig stalls.
  const bufRow = document.createElement("div");
  const bufPct = info.storeCap ? Math.round((info.stored / info.storeCap) * 100) : 0;
  bufRow.className = "sel-note " + (info.storeFull ? "bad" : bufPct >= 66 ? "warn" : "");
  bufRow.textContent = `Output buffer ${Math.round(info.stored)}/${info.storeCap} (${bufPct}%) — workers haul it to a Command Center`;
  panelEl.appendChild(bufRow);

  let cls = "good", text = "Digging at full power";
  if (!info.nuclearOk) { cls = "bad"; text = "Stalled — out of radioactives (no nuclear to exploit)"; }
  else if (info.throttle <= 0) { cls = "bad"; text = "Stalled — no Power for the plasma arc (build a Reactor)"; }
  else if (info.storeFull) { cls = "bad"; text = "Stalled — output buffer full (needs a hauler to a Command Center)"; }
  else if (info.throttle < 0.995) { cls = "warn"; text = `Throttled ${Math.round(info.throttle * 100)}% — low Power`; }
  const stRow = document.createElement("div");
  stRow.className = "sel-note " + cls;
  stRow.textContent = text;
  panelEl.appendChild(stRow);

  panelEl.appendChild(gridEfficiencyRow(state, rig));
  panelEl.appendChild(iceCoolantRow(state, rig.owner));

  panelEl.appendChild(makeButton(rig.paused ? "▶ Resume digging" : "⏸ Pause digging",
    () => { rig.paused = !rig.paused; },
    { tip: rig.paused ? "Restart the plasma arc"
                      : "Stop burning radioactives and idle the plasma arc's Power draw down to a 5% trickle until resumed" }));
}

/** Combustion Generator (Odyssey): fuel larder, burn rate and the lit/unlit state. */
function renderGenerator(state, gen) {
  const def = BUILDINGS[gen.type];
  const fuelCap = inputCapOf(gen.type);
  const larder = def.combust.fuels.map(f => `${Math.floor(gen.input?.[f] || 0)}/${Math.floor(fuelCap)}${COM[f]?.ico || ""}`).join(" ");
  const row = document.createElement("div");
  const lit = !gen.paused && gen.powered;
  row.className = "sel-note " + (gen.paused ? "" : lit ? "good" : "bad");
  row.textContent = gen.paused ? `Paused — grants no Power (⚡${def.energyGrants} when running)`
    : lit ? `Grants ⚡${def.energyGrants} Power · burning ${COM[gen.fuel]?.name || gen.fuel}`
          : `Stalled — larder empty (needs ${def.combust.fuels.map(f => COM[f]?.name || f).join(" or ")} hauled in)`;
  panelEl.appendChild(row);
  const larderRow = document.createElement("div");
  larderRow.className = "sel-note";
  larderRow.textContent = `Larder ${larder} — carried in by workers`;
  panelEl.appendChild(larderRow);
  const note = document.createElement("p");
  note.className = "hint";
  const burnRate = def.combust.rate * iceCoolantMult(state, gen.owner);   // banked ice halves the live burn rate
  note.textContent = `Powers your factories over its own grid — if total draw outruns your Power, every factory throttles. Burns ${burnRate.toFixed(2)}/s of `
    + `${def.combust.fuels.map(f => COM[f]?.name || f).join(" or ")} while running; a worker keeps the larder fed like a factory's input, or pause it.`;
  panelEl.appendChild(note);
  panelEl.appendChild(iceCoolantRow(state, gen.owner));
  renderLogiPriority(state, gen);
  panelEl.appendChild(makeButton(gen.paused ? "▶ Resume" : "⏸ Pause",
    () => { gen.paused = !gen.paused; },
    { tip: gen.paused ? "Bring it back online, feeding the grid again" : "Take it off the grid until resumed, without demolishing it" }));
}

/** Spaceport (Odyssey): the staged-fleet manifest, cargo hold, pad upgrade and the jump list. */
function renderSpaceport(state, spaceport) {
  const m = jumpManifest(state, spaceport);   // capacity-capped preview: what THIS pad alone lifts, what waits
  const tier = spaceportTier(spaceport);
  const vessel = jumpVessel(state);            // is a colony ship on any pad? (settles a NEW world) — a hint, not a gate
  // A jump actually combines every completed Spaceport's staged units (jumpManifestAll), not
  // just this one — comparing totals against this pad's own is a cheap way to tell whether a
  // second pad is in play, without adding another exported "how many spaceports" helper.
  const all = jumpManifestAll(state);
  const otherPads = all.capacity > m.capacity;

  // Fuel discount this pad's tier grants on NEW-world jumps (FUEL_DISCOUNT_BY_TIER,
  // engine/galaxy.js jumpCost) — free return jumps are unaffected, so the copy only
  // ever claims a new-world discount, never "jumps are cheaper" in general.
  const fuelMult = FUEL_DISCOUNT_BY_TIER[tier] ?? 1;
  const tierLine = document.createElement("div");
  tierLine.className = "sel-note good";
  tierLine.textContent = `Spaceport · Tier ${tier}/${SPACEPORT_MAX_TIER} · jump capacity ${m.capacity} supply`
    + (fuelMult < 1 ? ` · new-world fuel ×${fuelMult}` : "");
  panelEl.appendChild(tierLine);

  const info = document.createElement("p");
  info.className = "hint";
  info.textContent = `Jump the fleet staged by the pad to another world — free to a world you already hold, fuel scaled by distance to reach a new one. A jump lifts up to ${m.capacity} supply (ship population); a larger fleet crosses in several jumps. Your bases here stay as a colony.`;
  panelEl.appendChild(info);

  // Staged-fleet manifest: total population vs the pad's capacity, and what waits for the next trip.
  const fleet = document.createElement("p");
  fleet.className = m.leftBehind > 0 ? "hint warn" : "hint";
  fleet.textContent = m.staged === 0
    ? "No units staged by the pad — a jump will carry only cargo. Park an army (to reinforce) or a Colony Ship (to settle) here to bring it."
    : m.leftBehind > 0
      ? `Fleet staged: ${m.stagedSupply} supply, ${m.staged} units. This jump lifts ${m.used}/${m.capacity} — ${m.leftBehind} unit${m.leftBehind === 1 ? "" : "s"} wait for the next trip (or upgrade the pad).`
      : `Fleet staged: ${m.stagedSupply}/${m.capacity} supply (${m.staged} units) — all fit in one jump.`;
  panelEl.appendChild(fleet);

  // You hold more than one completed Spaceport: a jump combines every pad's staged fleet, so
  // this panel's numbers (this pad alone) understate what actually launches — spell that out.
  if (otherPads) {
    const combined = document.createElement("p");
    combined.className = "hint";
    combined.textContent = `You hold more than one Spaceport — a jump lifts staged units from ALL of them together: ${all.used}/${all.capacity} supply combined this trip${all.leftBehind > 0 ? `, ${all.leftBehind} waiting` : ""}.`;
    panelEl.appendChild(combined);
  }

  const shipHint = document.createElement("p");
  shipHint.className = "hint";
  shipHint.textContent = vessel
    ? "A Colony Ship is loaded — jump to a new world and deploy it to found a base."
    : "No Colony Ship on the pad: you can still hop to a world you hold (to control or reinforce it). To settle a NEW world, build a Colony Ship at a Command Center and park it here first.";
  panelEl.appendChild(shipHint);

  // Upgrade the launch pad (raises jump capacity AND cuts new-world fuel) — an Odyssey
  // fortification, like the Capital.
  if (tier < SPACEPORT_MAX_TIER) {
    const upCost = SPACEPORT_UPGRADE_COST[tier + 1];
    const nextCap = jumpCapacity({ tier: tier + 1 });
    const nextMult = FUEL_DISCOUNT_BY_TIER[tier + 1] ?? 1;
    panelEl.appendChild(makeButton(`⬆ Upgrade to Tier ${tier + 1} (${costText(upCost)}) — capacity ${nextCap}`,
      () => upgradeSpaceport(state, spaceport),
      { cost: upCost, icon: { kind: "building", type: "spaceport" },
        tip: `A bigger launch pad: jump capacity ${m.capacity} → ${nextCap} supply, so more of your fleet crosses per jump. New-world fuel drops to ×${nextMult} too.` }));
  }

  // Cargo hold: manufactured goods ride in the CARGO SHIPS staged for this jump — the hold is
  // their combined capacity (build Haulers/Heavy Haulers/Bulk Freighters at a Command Center and
  // park them by the pad). Shows what's actually aboard right now (hand-loaded via each ship's
  // own panel, Load/Unload) — a jump no longer auto-fills an empty hold (engine/galaxy.js
  // loadCargo), so this preview is exactly what will be delivered, not a hypothetical pick.
  const capacity = freightCapacity(m.riders);
  const cargo = {};
  for (const u of m.riders) for (const com in (u.freight || {})) cargo[com] = (cargo[com] || 0) + u.freight[com];
  const cargoTotal = Object.values(cargo).reduce((a, b) => a + b, 0);
  const cargoInfo = document.createElement("p");
  cargoInfo.className = "hint";
  cargoInfo.textContent = capacity === 0
    ? "Cargo hold: none — stage a cargo ship (Hauler / Heavy Hauler / Bulk Freighter) by the pad to haul goods."
    : cargoTotal
      ? `Cargo hold (${cargoTotal}/${capacity}): ${Object.entries(cargo).map(([c, q]) => `${q} ${c}`).join(", ")} — delivered to the destination.`
      : `Cargo hold (0/${capacity}): empty — load specific goods on a staged ship's own panel before you jump, or it arrives with nothing.`;
  panelEl.appendChild(cargoInfo);
  const jumpWorlds = game.galaxy.worlds.filter(w => w !== game.galaxy.activeId);
  if (sectionToggle("spaceport:jump", "Jump", jumpWorlds.length)) {
    for (const w of jumpWorlds) {
      const name = planetName(w);
      // Free EXACTLY when engine/galaxy.js's jumpCost says so — a world you've reached before or
      // still hold a base on. Read off the cost itself rather than "does this world's state
      // exist": a world's state existing means only that it's one of the seeded few simulating in
      // the background (BACKGROUND_WORLDS), which is not somewhere you've ever been.
      const cost = jumpCost(game.galaxy, w);
      const owned = cost === 0;
      const afford = game.galaxy.credits >= cost;
      panelEl.appendChild(makeButton(`Jump ▸ ${name}${owned ? " · your colony" : ` · ◈${cost}`}`,
        () => initiateJump(w),
        { tip: owned ? "Hop to this world you already hold — free. Staged units ride along to control or reinforce it."
                     : "Settle new ground: carry the staged expedition here. Bring a Colony Ship to found a base.",
          locked: !afford,
          lockTip: `Need ◈${cost} fuel — you have ◈${Math.floor(game.galaxy.credits)}` }));
    }
  }

  renderLanes(state, spaceport);
}

/** Helium Bomb: arm/disarm and the fuse state. */
function renderBomb(state, bomb, sel) {
  const armed = !!bomb.armed;
  const fused = armed && bomb.fuseUntil != null;
  const note = document.createElement("div");
  note.className = "sel-note " + (fused || armed ? "bad" : "good");
  note.textContent = fused
    ? `🔥 FUSE LIT — detonating in ~${BOMB_FUSE_DELAY}s. Disarm now to cut the fuse.`
    : armed
      ? `⚠ ARMED — a live enemy within ${Math.round(BOMB_DETECT_RANGE)} of it (point-blank) lights a ${BOMB_FUSE_DELAY}s fuse, and so does your command. The blast that follows reaches ${BOMB_BLAST_RADIUS} — any owner, including yours — an outright kill within ${Math.round(BOMB_CORE_RADIUS)} of ground zero, tapering off with distance beyond that. A direct hit still sets it off instantly, no fuse.`
      : `Unarmed — safe to move anywhere. Once armed: ${BOMB_BLAST_RADIUS}-radius blast, any owner — a guaranteed kill within ${Math.round(BOMB_CORE_RADIUS)} of ground zero, tapering off with distance beyond that.`;
  panelEl.appendChild(note);
  panelEl.appendChild(makeButton(armed ? "◯ Disarm" : "☢ Arm the Bomb",
    () => {
      const v = !armed;
      for (const e of sel) if (e.kind === "unit" && UNITS[e.type].role === "bomb") {
        e.armed = v;
        if (!v) e.fuseUntil = null;   // standing down cuts a lit fuse too
      }
    },
    { tip: armed ? (fused ? "Stand down — cuts the fuse, cancelling the detonation"
                          : "Stand down — safe again until re-armed")
                 : "Arm it: from now on a hit detonates it instantly; proximity or your command lights a fuse" }));
  if (armed && !fused) {
    panelEl.appendChild(makeButton("💥 Detonate Now", () => game.transport.submitCommand({ t: "lightFuse", unit: bomb.id }),
      { tip: `Light the fuse — detonates in ${BOMB_FUSE_DELAY}s` }));
  }
}

/** The BUILD menu a selected worker offers, grouped by category. */
function renderBuildMenu(state, builders, input) {
  const canBuild = t => builders.some(b => canBuildCategory(b.type, BUILDINGS[t].category));
  const buildBtn = t => {
    const def = BUILDINGS[t];
    const locked = !prereqsMet(state, game.localOwner, def);
    return prodButton(`Build ${def.name} (${costText(def.cost)})`,
      () => input.startBuild(t),
      { cost: def.cost, tip: unitTip(def), locked, lockTip: locked ? lockTipFor(def) : null, icon: { kind: "building", type: t } });
  };
  // Odyssey adds the Spaceport (jump pad) and the whole industry chain. You DON'T build a
  // Command Center here — new bases are founded by deploying a Colony Ship (build one at a
  // CC, move it, deploy). That's ~18 buildings — a flat list is a wall — so group them by
  // purpose. The entry tier of each group is always shown; deeper buildings REVEAL as their
  // prereqs are met (a greyed button per locked tier would bury the menu), mirroring how the
  // Barracks hides units you can't yet field. NOTE: these "Economy"/"Military" group labels
  // are a pre-existing purely cosmetic UI layout grouping — unrelated to BUILDINGS[t].category
  // (the worker build-capability check), which is applied independently via canBuild.
  const GROUPS = [
    ["Economy", ["market", "reactor", "combustor", "biomassreactor", "substation", "smelter", "datacenter", "chemplant", "assembler",
                 "fabricator", "chipfab", "machineworks", "antimatterforge", "aifoundry", "torpedoworks", "plasmarig"]],
    ["Military", ["barracks", "foundry", "arsenal", "refinery", "turret", "bastille", "aegisbastion", "torpedobattery", "habitat", "stardock"]],
    ["Endgame", ["antimatter_gate"]],
    ["Travel", ["spaceport"]],
  ];
  // bastille/aegisbastion join turret here (visible-but-locked, like the Foundry/Arsenal/
  // Spaceport gates themselves) so the player sees the rest of the static-defense ladder as a
  // goal before it's reachable — torpedobattery deliberately stays OUT of this set: it's a
  // deep Strategic-tier leaf (Foundry/Arsenal-gated stuff previews early, but a Torpedo Works
  // hasn't even been teched toward yet at that point), so it reveals only once actually reached,
  // same as chipfab/machineworks/torpedoworks/stardock/antimatter_gate already do.
  const alwaysShow = new Set(["market", "barracks", "foundry", "arsenal", "refinery", "turret", "bastille", "aegisbastion",
                              "habitat", "reactor", "combustor", "biomassreactor", "substation", "smelter", "datacenter", "spaceport"]);
  // What's actually SHOWN (not just category-eligible) in each mode — the header's count
  // mirrors this exactly, so "▸ Build (N)" never promises more than expanding reveals.
  const shownGroups = state.endless
    ? GROUPS.map(([title, types]) => [title, types.filter(t => canBuild(t) && (alwaysShow.has(t) || prereqsMet(state, game.localOwner, BUILDINGS[t])))])
        .filter(([, shown]) => shown.length)
    : [[null, ["barracks", "foundry", "arsenal", "refinery", "turret", "bastille", "aegisbastion", "habitat", "command"].filter(canBuild)]];
  // Collapsible PER GROUP: a generalist Worker (every category) or a mixed selection can offer
  // a long wall of options, and different players care about different groups — Economy vs
  // Military fold independently (game.collapsedSections, session.js), remembered across
  // selections like the formation choice below. Skirmish's single flat list (title === null,
  // shownGroups above) has no sub-groups to split, so it falls through to one flat "Build"
  // toggle instead — same shape, same helper, no special-casing needed. Collapsing a group
  // shifts which building the Z/C/V/B/N hotkeys map to (prodButton claims them positionally by
  // render order) — pre-existing behaviour, now scoped per group instead of per whole submenu.
  for (const [title, shown] of shownGroups) {
    const key = title ? `build:${title.toLowerCase()}` : "build:all";
    if (sectionToggle(key, title || "Build", shown.length)) {
      for (const t of shown) panelEl.appendChild(buildBtn(t));
    }
  }
}

/** Multi-unit orders: formation shape and leader position for a mixed selection. */
function renderMultiUnitOrders(input) {
  const head = document.createElement("div");
  head.className = "sel-group";
  head.textContent = "Formation";
  panelEl.appendChild(head);

  const leaderHint = document.createElement("p");
  leaderHint.className = "hint";
  leaderHint.textContent = "The first unit you selected leads — the rest follow it, even on a later solo move. Ctrl+click a unit already in the selection to promote it to leader instead.";
  panelEl.appendChild(leaderHint);

  const shapeRow = document.createElement("div");
  shapeRow.className = "formation-row";
  for (const shape of FORMATION_SHAPES) {
    const btn = document.createElement("button");
    btn.className = "btn formation-btn" + (game.formation.shape === shape ? " active" : "");
    btn.textContent = FORMATION_LABELS[shape];
    btn.title = FORMATION_TIPS[shape];
    btn.addEventListener("click", () => {
      game.formation.shape = shape;
      // A Circle's leader is always centered — force leaderPos to "center" so a stale
      // "front"/"back" left over from Line/Wedge can't silently put it ON the ring instead
      // (engine/formation.js's circleOffsets treats anything other than exactly "front"/"back"
      // as "center"). Leaving Circle resets it back to a sane Line/Wedge default.
      if (shape === "circle") game.formation.leaderPos = "center";
      else if (game.formation.leaderPos === "center") game.formation.leaderPos = "front";
      renderHUD();
    });
    shapeRow.appendChild(btn);
  }
  panelEl.appendChild(shapeRow);

  // Leader position only matters for a shape with a real front/back — Grid has no natural
  // leader slot, and a Circle's leader is always centered (protected), not toggled.
  if (game.formation.shape === "line" || game.formation.shape === "wedge") {
    const leaderRow = document.createElement("div");
    leaderRow.className = "formation-row";
    for (const leaderPos of ["front", "back"]) {
      const btn = document.createElement("button");
      btn.className = "btn formation-btn" + (game.formation.leaderPos === leaderPos ? " active" : "");
      btn.textContent = leaderPos === "front" ? "Leader: Front" : "Leader: Back";
      btn.title = leaderPos === "front" ? "The strongest unit leads at the point"
                                         : "The strongest unit is shielded at the rear; flanks lead";
      btn.addEventListener("click", () => { game.formation.leaderPos = leaderPos; renderHUD(); });
      leaderRow.appendChild(btn);
    }
    panelEl.appendChild(leaderRow);
  } else if (game.formation.shape === "circle") {
    const note = document.createElement("p");
    note.className = "hint";
    note.textContent = "Leader: center — protected in the middle of the ring.";
    panelEl.appendChild(note);
  }

  panelEl.appendChild(makeButton("Hold Formation ( F )", () => input.formSelected(),
    { tip: "Form up right here in the chosen shape and hold — a defensive stance for the whole group, not just one ship" }));
}

function rebuildSelectionPanel(sel) {
  const { state, input } = game;
  panelEl.innerHTML = "";
  panelActions = [];
  game.hotkeyActions = panelActions;   // input.js reads this live array for the Z/C/V/B/N production keys

  // WATCHING a match (docs/competitions-and-elo.md Phase 5): the panel offers NOTHING. Neither
  // army belongs to the player, so every affordance this function can build — the two selection
  // shortcuts just below, and every produce/build/order button above a real selection — would
  // command one of the two AI entrants. input.js already refuses every mouse and keyboard route
  // into a selection while Observer Mode is on; this closes the panel's OWN buttons, which call
  // input/engine commands directly and so bypass that guard entirely.
  // (No panelSignature term is needed for this: game.spectateMatch is set once, by
  // startSpectatedMatch immediately after bootState, and never changes for the life of the game —
  // which is exactly why that function forces one resetPanelSignature()/renderHUD() right there.)
  if (game.spectateMatch) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "Spectating — both sides are AI. You issue no orders in a watched match.";
    panelEl.appendChild(hint);
    return;
  }

  if (!sel.length) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "Drag-select units, or click a building.";
    panelEl.appendChild(hint);
    panelEl.appendChild(makeButton("Idle Worker ( ` )", () => input.focusIdleWorker()));
    panelEl.appendChild(makeButton("Select Army ( Q )", () => input.selectAllArmy()));
    panelEl.appendChild(controlsLegend());
    return;
  }

  renderSelectionSummary(state, sel, input);

  const cc = sel.find(e => e.kind === "building" && e.type === "command" && !e.constructing);
  if (cc) renderCommandCenter(state, cc);

  const market = sel.find(e => e.kind === "building" && e.type === "market" && !e.constructing);
  // Odyssey: trade local commodities for universal credits — its own building (not the CC),
  // so a destroyed/absent Command Center doesn't strand a colony without a market.
  if (market && game.galaxy && state.market) renderMarket(state);

  const barracks = sel.find(e => e.kind === "building" && e.type === "barracks" && !e.constructing);
  if (barracks) {
    // Only offer a unit this world can actually pay for — a specialty unit
    // (Wraith/gas, Aegis/ice, Colossus/relics) is hidden entirely on a map that
    // deposits none of its commodity, instead of showing a forever-greyed button.
    const trainable = producibleAt(state, "barracks");
    if (sectionToggle("barracks:produce", "Produce", trainable.length)) {
      for (const t of trainable) {
        const def = UNITS[t];
        const locked = !prereqsMet(state, game.localOwner, def);
        panelEl.appendChild(prodButton(`Produce ${def.name} (${costText(def.cost)})`,
          () => game.transport.submitCommand({ t: "queueProduction", building: barracks.id, u: t }),
          { cost: def.cost, tip: unitTip(def), locked, lockTip: locked ? lockTipFor(def) : null, icon: { kind: "unit", type: t } }));
      }
    }
    if (barracks.queue.length) renderQueueRows(barracks);
  }

  // Refinery: the doctrine upgrades. Same queued/timed idiom as the Datacenter's tech tree below
  // (production.js researchUpgrade pays up front and queues; engine/techtree.js updateResearch
  // develops it) — a live progress row for whatever's currently developing, and the plain
  // button-per-upgrade list below it drops anything already queued (the progress row already
  // says it's underway), same split the Datacenter panel makes.
  const refinery = sel.find(e => e.kind === "building" && e.type === "refinery" && !e.constructing);
  if (refinery) renderRefinery(state, refinery);

  // Datacenter (Odyssey): the industrial tech tree. Researches one node at a time,
  // paid in gathered commodities and developed over time — flat lock-tip buttons,
  // the same idiom as the Refinery's doctrine research (no separate tree UI).
  const datacenter = sel.find(e => e.kind === "building" && e.type === "datacenter" && !e.constructing);
  if (datacenter) renderDatacenter(state, datacenter);

  // Star Dock (Odyssey): trains the Leviathan capital ship. Its own panel (not the
  // Barracks) because the Leviathan costs strategic goods that never sit on the map,
  // so the Barracks' on-map-cost filter would hide it.
  const stardock = sel.find(e => e.kind === "building" && e.type === "stardock" && !e.constructing);
  if (stardock) renderStardock(state, stardock);

  // Antimatter Gate (Odyssey): the endgame wonder. Shows its charge toward the
  // galaxy win — keep antimatter flowing and hold the line.
  const wonder = sel.find(e => e.kind === "building" && BUILDINGS[e.type]?.wonder && !e.constructing);
  if (wonder) {
    const pct = Math.round((wonder.charge || 0) * 100);
    const row = document.createElement("div");
    row.className = "sel-row";
    row.textContent = `Charging the galaxy jump — ${pct}%`;
    panelEl.appendChild(row);
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "Feeds on antimatter and shares your Reactor Power. At 100% the Gate fires and you win the galaxy — but razed mid-charge, the whole investment is lost, so defend it.";
    panelEl.appendChild(hint);
  }

  // Factory (Odyssey): a production building that converts raw hauls into refined
  // goods. Without this a selected Smelter reads only "420/420 hp" — the chain's
  // core loop is invisible. Show its recipe and, in colour, whether it's running
  // and why not (no Power / low Power / starved of an input).
  const factory = sel.find(e => e.kind === "building" && recipeOf(e) && !e.constructing);
  if (factory) renderFactory(state, factory);

  // Plasma Rig (Odyssey): deep-core extraction. Say what it mines, how rich the seam is, its dig
  // progress + last strike, and why it's slow/stalled (out of nuclear, or a starved Power grid).
  const rig = sel.find(e => e.kind === "building" && BUILDINGS[e.type].rig && !e.constructing);
  if (rig) renderPlasmaRig(state, rig);

  // A fuel-burning power station (Odyssey) — the Reactor (radioactives), the Combustion Generator
  // (gas), or the Biomass Reactor (biomass) — grants Power to the grid rather than running a
  // recipe, so it has no factory panel of its own; instead it burns its OWN local fuel larder,
  // kept fed by a worker SERVICE run (engine/haul.js), not drawn straight from the treasury. Say
  // how much it grants, how full each accepted fuel's slice of the larder is, whether it's
  // actually fed right now, and let the player pause it (engine/industry.js sourceActive) to stop
  // the fuel bill without demolishing it.
  const gen = sel.find(e => e.kind === "building" && BUILDINGS[e.type]?.combust && !e.constructing);
  if (gen) renderGenerator(state, gen);

  // Any non-recipe building with a finite output buffer (storeCap, engine/entities.js) that
  // isn't the Command Center: surface how full it is and whether it's full, same finite-storage
  // idiom as the factory/Rig panels above.
  const drop = sel.find(e => e.kind === "building" && e.owner === game.localOwner && !e.constructing
    && storeCapOf(e.type) > 0 && !BUILDINGS[e.type].recipe && !BUILDINGS[e.type].isCommandCenter);
  if (drop) {
    const cap = storeCapOf(drop.type), have = storeTotal(drop);
    const pct = cap ? Math.round((have / cap) * 100) : 0;
    const full = storeRoom(drop) <= 1e-6;
    const row = document.createElement("div");
    row.className = "sel-note " + (full ? "bad" : pct >= 66 ? "warn" : "");
    row.textContent = `Output buffer ${Math.round(have)}/${cap} (${pct}%)`
      + (full ? " — FULL: production stalls until it's hauled off" : " — workers haul it to a Command Center");
    panelEl.appendChild(row);
  }

  // Electrify (Odyssey): a non-power building — Command Center, Barracks, Star Dock or Habitat — can
  // be wired into the power grid to run 30% better (produce faster; a Habitat houses 30% more), at the
  // cost of a steady grid draw. The bonus scales with the grid throttle, so it's only worth it once you
  // have Power to spare. Player + Odyssey only (game.galaxy), so a skirmish never surfaces the toggle.
  const elec = game.galaxy && sel.find(e => e.kind === "building" && e.owner === game.localOwner
    && !e.constructing && isElectrifiable(e.type));
  if (elec) {
    const on = !!elec.electrified;
    const isHab = !!BUILDINGS[elec.type].supplyGrants && !BUILDINGS[elec.type].produces;
    const what = isHab ? "houses 30% more" : "trains 30% faster";
    panelEl.appendChild(makeButton(on ? "⚡ Electrified: ON" : "⚡ Electrify: OFF",
      () => {
        const v = !elec.electrified;
        const ids = sel.filter(e => e.kind === "building" && e.owner === game.localOwner && isElectrifiable(e.type)).map(e => e.id);
        game.transport.submitCommand({ t: "setElectrified", ids, on: v });
        renderHUD();
      },
      { tip: on ? `Unwire it — stops drawing ⚡${ELECTRIFY_POWER} from the grid`
                : `Wire it into the grid: ${what} while powered, but draws ⚡${ELECTRIFY_POWER} (competes with your factories)` }));
    if (on) {
      const gain = Math.round(electrifyBoost(state, elec.owner) * 100);   // live bonus after the grid throttle
      const eff = powerEfficiency(state, elec.owner, elec.x, elec.y);
      const row = document.createElement("div");
      row.className = "sel-note " + (gain >= 20 ? "good" : gain > 0 ? "warn" : "bad");
      row.textContent = gain > 0
        ? `Wired in (${eff.label}) — currently +${gain}% (build more Reactors to reach +30%)`
        : "Wired in but the grid has no Power to spare — build a Reactor/Generator for the bonus";
      panelEl.appendChild(row);
    }
  }

  // Spaceport (Odyssey): the interplanetary jump panel. Relocate the capital +
  // the units staged nearby to another world; the world you leave carries on as
  // a colony.
  const spaceport = sel.find(e => e.kind === "building" && e.type === "spaceport" && !e.constructing);
  if (spaceport && game.galaxy) renderSpaceport(state, spaceport);

  // Colony ship (Odyssey): settle in place into a Command Center. Locked (with the
  // reason) when the current spot is blocked — move to clear ground and deploy.
  const colonyShip = sel.find(e => e.kind === "unit" && e.type === "colonyship");
  if (colonyShip && game.galaxy) {
    const blocked = !canPlaceBuilding(state, "command", colonyShip.x, colonyShip.y);
    panelEl.appendChild(makeButton("⛨ Deploy as Command Center",
      () => deployColonyShip(state, colonyShip.id),
      { locked: blocked, icon: { kind: "building", type: "command" },
        lockTip: blocked ? "Blocked here — move to open, buildable ground clear of buildings, nodes and rough terrain" : null,
        tip: "Settle: the colony ship becomes a Command Center on this spot (it can't move again). Colonists disembark as workers." }));
  }

  // Freighter (Odyssey cargo ship): a load/unload cargo panel for the first one selected, plus its
  // Collection Point toggle (no research needed) and its AI-logistics toggle once
  // FREIGHTER_AI_TECH is researched.
  const freighter = game.galaxy && sel.find(e => e.kind === "unit" && UNITS[e.type].cargoHold);
  if (freighter) { renderFreight(state, freighter); renderCollectPoint(state, freighter); renderAILogistics(state, freighter); }

  // Mender: an auto-repair toggle (roam and mend on its own) + its Odyssey power state (it heals at
  // full rate only on the powered grid, near a Reactor/Generator).
  const mender = sel.find(e => e.kind === "unit" && UNITS[e.type].role === "support");
  if (mender) {
    const on = !!mender.autoRepair;
    panelEl.appendChild(makeButton(on ? "🔧 Auto-repair: ON" : "🔧 Auto-repair: OFF",
      () => { const v = !mender.autoRepair; for (const e of sel) if (e.kind === "unit" && UNITS[e.type].role === "support") e.autoRepair = v; },
      { tip: on ? "Stop roaming; it only mends whatever it's parked beside"
                : "Roam to the nearest damaged building/unit and mend it automatically" }));
    if (game.galaxy) {
      const powered = onPowerGrid(state, mender.owner, mender.x, mender.y);
      const row = document.createElement("div");
      row.className = "sel-note " + (powered ? "good" : "warn");
      row.textContent = powered ? "On the power grid — repairing at full rate"
                                 : "Off-grid — mending slowly on reserves (move near a Reactor/Generator)";
      panelEl.appendChild(row);
    }
  }

  // Helium Bomb: an Arm/Disarm toggle (same direct-mutation pattern as the Mender's
  // auto-repair above) plus a manual trigger, once armed. UNARMED it's inert and safe to
  // move anywhere; ARMED it detonates instantly on the first hit it takes, but proximity
  // and "Detonate Now" instead light a BOMB_FUSE_DELAY-second fuse (engine/bomb.js's
  // lightFuse) — the actual blast (detonateBomb) follows once that timer comes due, not
  // on the spot. Disarming while fused cuts it — the whole point of "reversible."
  const bomb = sel.find(e => e.kind === "unit" && UNITS[e.type].role === "bomb");
  if (bomb) renderBomb(state, bomb, sel);

  // Every selected unit that can found/assist-build ANYTHING (Worker, the sole generalist that
  // carries a buildCategories list). The building list below is then filtered to whatever's in
  // the UNION of the selection's categories via canBuildCategory, same single source of truth
  // issueBuild itself gates on.
  const builders = sel.filter(e => e.kind === "unit" && UNITS[e.type]?.buildCategories?.length);
  if (builders.length && !input.building) renderBuildMenu(state, builders, input);

  // Formation: shown for any multi-unit selection. Picks the shape (and, where it matters, the
  // leader position) that THIS and every later move/attack-move/Hold-Formation command uses — a
  // session preference (game.formation, session.js), not per-unit state, so it carries across
  // selections until changed. Grid is the plain default (today's spread-to-a-grid, unchanged);
  // the other three trade that for a deliberate shape (engine/formation.js has the geometry).
  if (sel.length > 1 && sel.some(e => e.kind === "unit")) renderMultiUnitOrders(input);

  if (sel.some(e => e.kind === "unit")) {
    panelEl.appendChild(makeButton("Stop ( X )", () => input.stopSelected()));
  }

  // Recycle: reclaim part of an OWNED unit/building's cost (engine/recycle.js — the refund
  // fraction depends on type and research). Shown for the whole current selection: an
  // already-recycling entity gets a live progress row (patched each tick above) + a free Cancel;
  // an eligible-but-idle one gets a Recycle button. A Command Center, and anything already
  // recycling, is filtered out by canRecycle, so it just silently doesn't appear.
  const recyclingNow = sel.filter(e => e.recycling);
  if (recyclingNow.length) {
    recyclingNow.forEach(e => {
      const row = document.createElement("div");
      row.className = "sel-row recycle-progress";
      row.textContent = recycleRowText(e);
      panelEl.appendChild(row);
    });
    panelEl.appendChild(makeButton("Cancel Recycle", () => { game.transport.submitCommand({ t: "cancelRecycle", ids: recyclingNow.map(e => e.id) }); renderHUD(); },
      { tip: "Stand it back down — free, nothing was spent or lost" }));
  }
  const recyclable = sel.filter(e => canRecycle(e));
  if (recyclable.length) {
    const one = recyclable.length === 1 ? recyclable[0] : null;
    const frac = recycleFrac(state, game.localOwner, recyclable[0]);
    // recycleValue folds in whatever the entity is CURRENTLY holding (a factory's larder/backlog,
    // a freighter's freight, a worker's cargo) at full value, on top of the cost-based fraction —
    // so a single-entity preview shows the real total the player will actually get back, not just
    // the cost-based estimate.
    const label = one
      ? `♻ Recycle (+${Object.entries(recycleValue(state, one)).map(([com, qty]) => `${Math.round(qty)} ${com}`).join(", ")})`
      : `♻ Recycle Selected (${Math.round(frac * 100)}%)`;
    panelEl.appendChild(makeButton(label, () => { game.transport.submitCommand({ t: "recycle", ids: recyclable.map(e => e.id) }); renderHUD(); },
      { tip: `Scrap it for ${Math.round(frac * 100)}% of its cost back, plus everything in its larder/hold right now — takes a little time in place, and a Command Center can't be recycled` }));
  }

  if (sel.some(e => e.kind === "unit" && UNITS[e.type].role === "combat")) {
    // Attack-move as a button — the only way to arm it on touch (no A key), and a
    // discoverable one on desktop. Shows ARMED while waiting for the target tap.
    const amBtn = makeButton(input.attackArmed ? "Attack-Move: ARMED ( A )" : "Attack-Move ( A )",
      () => input.toggleAttackMove(),
      { tip: "Then tap the map: units advance and engage anything met on the way" });
    if (input.attackArmed) amBtn.classList.add("armed");
    panelEl.appendChild(amBtn);
    panelEl.appendChild(makeButton("Hold Position ( H )", () => input.holdSelected(),
      { tip: "Fire on anything in range, but hold ground — don't chase out of position" }));
  }
  const hasRanger = sel.some(e => e.kind === "unit" && UNITS[e.type].role === "scout");
  if (hasRanger) {
    panelEl.appendChild(makeButton("Scout Mode ( E )", () => input.scoutSelected(),
      { tip: "Auto-explore: the Ranger ranges toward the nearest unexplored ground — leading its formation at the group's pace if it has one, on its own otherwise" }));
  }

  const touch = isTouchMode();
  if (input.building) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = touch ? "Tap the map to place it. Tap Build again to cancel."
                             : "Click the map to place it. Right-click to cancel.";
    panelEl.appendChild(hint);
  } else if (hasRanger) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = touch ? "Ranger: all-terrain, far sight. E / Scout Mode to auto-explore; tap the map to move it."
                             : "Ranger: all-terrain, far sight. E to auto-scout; right-click to move it yourself.";
    panelEl.appendChild(hint);
  } else if (sel.some(e => e.kind === "unit" && UNITS[e.type].role === "combat")) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = touch ? "Tap the map to move. Tap a foe to attack. Attack-Move advances and engages."
                             : "A + click to attack-move. Right-click moves (ignores enemies). Right-drag also sets a facing. Ctrl+right-click queues a waypoint.";
    panelEl.appendChild(hint);
  } else if (sel.length === 1 && (cc || barracks)) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = touch ? "Tap the map to set a rally point — tap a resource node to rally new workers onto it."
                             : "Right-click to set a rally point — right-click a resource node to rally new workers straight onto it.";
    panelEl.appendChild(hint);
  }
}

// "150 ore, 100 crystals" — renders any multi-commodity cost so buttons for
// crystal/radioactive-costed things read the same as the plain-ore ones.
function costText(cost) {
  return Object.entries(cost).map(([com, qty]) => `${qty} ${com}`).join(", ");
}

// A compact keyboard/mouse reference, shown when nothing is selected so the
// controls aren't hidden knowledge.
function controlsLegend() {
  const box = document.createElement("div");
  box.className = "legend";
  // Touch mode gets the finger legend; mouse/keyboard the desktop one.
  const rows = isTouchMode() ? [
    ["Tap unit", "select · double-tap = all of type"],
    ["Tap map", "move / attack / gather"],
    ["Drag", "box-select your units"],
    ["Two fingers", "pan · pinch to zoom"],
    ["Buttons", "Attack-Move · Stop · Hold · Scout · Form Up"],
    ["Minimap", "tap to jump the view"],
    ["▾ handle", "hide / show this panel"],
    ["?", "all controls"],
  ] : [
    ["Left-drag", "select · Ctrl adds · Alt subtracts"],
    ["Right-click", "move / attack / gather"],
    ["Right-drag", "…and face that direction"],
    ["A + click", "attack-move"],
    ["Ctrl+right", "queue a waypoint"],
    ["Shift+1–9", "set group · 1–9 recall"],
    ["Double-click", "select type · Ctrl+dbl = whole map"],
    ["Q · E · X · H · F", "army · scout · stop · hold · form up"],
    ["Backspace", "jump to last attack"],
    ["Minimap", "left jumps · right orders"],
    ["Wheel", "zoom · arrows / edge-scroll pan"],
    ["F1 / ?", "all controls"],
  ];
  box.innerHTML = rows
    .map(([k, v]) => `<div class="legend-row"><span class="legend-key">${k}</span><span>${v}</span></div>`).join("");
  return box;
}

// A build/produce/research button. When `cost` is given and the player can't
// afford it, the button greys out and a click just plays the denied buzz — so a
// broke click gives feedback instead of silently doing nothing (previously the
// only "can't" feedback was the supply block). `tip` becomes a hover tooltip.
function makeButton(label, onClick, { cost = null, tip = null, locked = false, lockTip = null, icon = null } = {}) {
  const { state } = game;
  const btn = document.createElement("button");
  btn.className = "btn";
  // An optional icon sits left of the label: a SPRITE ({kind,type}) — the actual unit/building
  // art the map draws — or an EMOJI ({emoji}) reused from the game's data icons (data.js COM /
  // FACTIONS, tech/doctrine icons), so a research or planet button reads at a glance too.
  let iconEl = null;
  if (icon && icon.emoji) {
    iconEl = document.createElement("span");
    iconEl.className = "btn-icon btn-emoji";
    iconEl.textContent = icon.emoji;
  } else if (icon && icon.kind && icon.type) {
    const url = spriteIcon(icon.kind, icon.type, state.players[game.localOwner].color);
    if (url) { iconEl = document.createElement("img"); iconEl.className = "btn-icon"; iconEl.src = url; iconEl.alt = ""; }
  }
  if (iconEl) {
    btn.classList.add("has-icon");
    const span = document.createElement("span");
    span.className = "btn-label";
    span.textContent = label;
    btn.append(iconEl, span);
  } else {
    btn.textContent = label;
  }
  const tipText = locked && lockTip ? lockTip : (tip || "");
  btn.title = tipText;
  const affordable = !cost || canAfford(state.players[game.localOwner].resources, cost);
  if (locked || !affordable) {
    btn.classList.add("disabled");   // a tech-locked or unaffordable option greys and just buzzes on click
    // On TOUCH there's no hover, so the reason a button is greyed is otherwise unreachable —
    // surface it on the tap that would just buzz. Prefer the BLOCK reason (the tech-lock, or
    // the affordability shortfall) over the stat tip, and use the dedicated hint channel, NOT
    // the capacity-limited galaxy-alert stack (colony alerts could otherwise suppress it).
    const reason = locked ? (lockTip || tip)
      : (!affordable ? `Not enough — needs ${costText(cost)}` : tip);
    btn.addEventListener("click", () => {
      sound.playProductionBlocked();
      if (isTouchMode() && reason) flashHint(reason);
    });
  } else {
    btn.addEventListener("click", () => { onClick(); renderHUD(); });
  }
  return btn;
}

// "Requires Foundry" style tooltip listing a def's unmet prerequisites by name.
// A prereq token is a building type, a doctrine upgrade, or a tech-tree node — the
// name lookup covers all three (prereqsMet resolves them the same way).
function lockTipFor(def) {
  return `Requires ${(def.requires || []).map(r => BUILDINGS[r]?.name || UPGRADES[r]?.name || TECHS[r]?.name || r).join(", ")}`;
}

// A compact stat line for a unit/building button tooltip, plus the counter-triangle "strong
// vs / falls to" lines (counterInfo, above) each on their own line — a building def (or a unit
// deliberately outside the triangle) contributes neither, so this is a no-op append for those.
function unitTip(def) {
  const bits = [`${def.hp} hp`];
  if (def.attack) bits.push(`${def.attack} dmg`, `rng ${def.range}`);
  if (def.repairRate) bits.push(`heals ${def.repairRate}/s`, `rng ${def.repairRange}`);
  if (def.cargoHold) bits.push(`cargo ${def.cargoHold}`);
  if (def.speed) bits.push(`spd ${def.speed}`);
  if (def.supplyCost) bits.push(`${def.supplyCost} supply`);
  if (def.supplyGrants) bits.push(`+${def.supplyGrants} supply`);
  if (def.dropOff || def.isCommandCenter) bits.push("resource drop-off");
  let tip = bits.join(" · ");
  const { strong, weak } = counterInfo(def);
  if (strong) tip += `\n${strong}`;
  if (weak) tip += `\n${weak}`;
  return tip;
}
