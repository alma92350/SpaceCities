/* ============================================================
   Every DOM handle the UI reaches for, resolved once, in one place — so the
   split-out UI modules (hud, setup, overlays, save, boot) share the exact same
   element references instead of each re-querying the document. Plus the two
   minimap-canvas dimension constants and the touch-mode predicate, which several
   modules read.
   ============================================================ */

"use strict";

// Resolve `document` defensively: in the browser it's the real thing, under Node (`node --test`
// importing a UI module for its pure logic) it's absent. Guarding here — instead of touching the
// global directly on every line below — means every UI module that imports this file becomes
// import-safe under Node: the element handles come back null rather than throwing at load. In a
// real browser `doc` IS document and every handle resolves exactly as before, so nothing changes.
const doc = typeof document !== "undefined" ? document : null;
const byId = id => (doc ? doc.getElementById(id) : null);
const context2d = el => (el ? el.getContext("2d") : null);

export const canvas = byId("field");
export const ctx = context2d(canvas);
export const minimapCanvas = byId("minimap");
export const minimapCtx = context2d(minimapCanvas);
export const resourcesEl = byId("resources");
export const clockEl = byId("matchClock");
export const scoreBarEl = byId("scoreBar");
export const panelEl = byId("selectionPanel");
export const gameOverEl = byId("gameOver");
export const mapSelectEl = byId("mapSelect");
export const lobbyScreenEl = byId("lobbyScreen");
export const muteBtn = byId("muteBtn");
export const underAttackEl = byId("underAttackAlert");
export const gateChipEl = byId("gateChip");
export const seedChipEl = byId("seedChip");
export const factionChipEl = byId("factionChip");
export const sheetToggleEl = byId("sheetToggle");
export const panelToggleEl = byId("panelToggle");
export const idleWorkersEl = byId("idleWorkers");
export const idleProductionEl = byId("idleProduction");
export const objectivesEl = byId("objectives");
export const helpOverlayEl = byId("helpOverlay");
export const helpBtn = byId("helpBtn");
export const saveBtn = byId("saveBtn");
export const loadBtn = byId("loadBtn");
export const homeBtn = byId("homeBtn");
export const starmapBtn = byId("starmapBtn");
export const pauseBtn = byId("pauseBtn");
export const starmapEl = byId("starmap");
export const observerBtn = byId("observerBtn");
export const observerBannerEl = byId("observerBanner");
export const spectateBarEl = byId("spectateBar");
export const observerPanelEl = byId("observerPanel");
export const chatPanelEl = byId("chatPanel");
export const techChartBtn = byId("techChartBtn");
export const techChartEl = byId("techChart");
export const volumeEl = byId("volume");
export const galaxyToastEl = byId("galaxyToast");
export const groupChipsEl = byId("groupChips");
export const uiHintEl = byId("uiHint");
export const scenarioBarEl = byId("scenarioBar");
export const scenarioBannerEl = byId("scenarioBanner");
export const scenarioStatusEl = byId("scenarioStatus");
export const repairBtn = byId("repairBtn");
export const departBtn = byId("departBtn");

export const MINIMAP_W = 200, MINIMAP_H = 125;

// Touch mode is a body-class flag (set by the first touch — see input.js and
// main.js). Read by hud (legend/hints phrasing) and overlays.
export function isTouchMode() { return !!doc && doc.body.classList.contains("touch"); }
