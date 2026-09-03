/* ============================================================
   The Tech & Industry Chart — a full-screen overlay that finally makes the unlock ladder
   visible in-game (docs/improvement-proposals.md "Tech & Industry Chart overlay"): Foundry ->
   Arsenal, the Datacenter's TECHS -> Chip Fab/Machine Works -> the Strategic tier -> the
   Antimatter Gate. The Odyssey build menu deliberately hides locked buildings to keep the menu
   short (hudSelection.js's GROUPS/alwaysShow comment), the Datacenter panel is a flat list, and
   docs/player-handbook.html — the one place the ladder was drawn — was linked from nowhere in
   the app. This is that missing map: every building, unit gate, and tech/doctrine node laid out
   in TIER COLUMNS (prereq depth, left to right), coloured by live state, so a T2 player can
   literally see the Gate at the end of the road.

   Pure view over BUILDINGS/UNITS/UPGRADES (engine/entities.js) and TECHS (engine/techtree.js) —
   it reads the live game state at open/render time and rebuilds, the same read-only relationship
   starmap.js has with galaxyStatus(). It does not modify engine/ at all.

   A leaf UI module, modeled on starmap.js: its own element, its own pauseLoop('techchart')/
   resumeLoop pair (imported from boot.js exactly like starmap.js does — boot.js itself never
   imports this file, only main.js does, so there's no cycle), and a self-wired topbar button +
   Esc/T hotkey (guarded against firing while a text control is focused, input.js's own pattern).
   ============================================================ */

"use strict";

import { techChartEl, techChartBtn, canvas, isTouchMode } from "./dom.js";
import { game } from "./session.js";
import { BUILDINGS, UNITS, UPGRADES, prereqsMet, canAfford, canBuildCategory, hasCompletedBuilding } from "./engine/entities.js";
import { TECHS } from "./engine/techtree.js";
import { RECIPES, COM } from "./data.js";
import { spriteIcon } from "./render.js";
import { pauseLoop, resumeLoop } from "./boot.js";
import { flashHint } from "./overlays.js";
import * as sound from "./sound.js";

/* ---------- node set: which defs belong on the chart, and in which mode ---------- */

// odysseyOnly buildings/units "never appear in a skirmish build menu" (entities.js's own header
// comment on the flag) — the chart honours that same line: Skirmish gets the small ladder
// (Barracks -> Foundry -> Arsenal and friends), Odyssey gets the lot, Strategic tier included.
function includeForMode(def, odyssey) { return odyssey || !def.odysseyOnly; }

// Every node the chart draws, unpositioned (tier is stamped in afterwards by computeTiers).
// TECHS are Odyssey-only outright (the Datacenter that hosts them is itself odysseyOnly, and
// TECHS entries carry no odysseyOnly flag of their own to check). UPGRADES (the Refinery
// doctrines) run in BOTH modes (entities.js: "available — and now timed — in BOTH modes"), minus
// `hardEdge` — Hard difficulty's seeded AI-only economic edge, never a player-facing node
// (entities.js: "keeps it out of the player-facing Refinery research panel"). Only GATED units
// (a `requires` of their own) belong on a ladder at all — the rest train from turn one, so
// they're not part of the unlock story this chart exists to show.
function buildNodes(odyssey) {
  const nodes = [];
  for (const def of Object.values(BUILDINGS)) {
    if (!includeForMode(def, odyssey)) continue;
    nodes.push({ id: def.id, kind: "building", def, name: def.name, tier: 0 });
  }
  if (odyssey) {
    for (const def of Object.values(TECHS)) nodes.push({ id: def.id, kind: "tech", def, name: def.name, tier: 0 });
  }
  for (const def of Object.values(UPGRADES)) {
    if (def.aiOnly) continue;
    nodes.push({ id: def.id, kind: "upgrade", def, name: def.name, tier: 0 });
  }
  for (const def of Object.values(UNITS)) {
    if (!def.requires || !def.requires.length) continue;
    if (!includeForMode(def, odyssey)) continue;
    nodes.push({ id: def.id, kind: "unit", def, name: def.name, tier: 0 });
  }
  return nodes;
}

// id -> node, to resolve a requires[] TOKEN back to the node it names. Only buildings/tech/
// upgrades ever appear as a requires token (nothing ever requires a specific UNIT), so units are
// deliberately left out of this index. NOTE: TECHS and UPGRADES both define a "recycling" id on
// purpose (engine/techtree.js's own comment: "only one of the two trees is ever active in a given
// match, so the shared key is safe") — whichever is built last below wins this particular index
// slot, but that's harmless here: nothing's requires[] ever names "recycling" as a prereq TOKEN
// (it's a leaf on both trees), so this slot is never actually read during tier/chain resolution.
function indexNodes(nodes) {
  const index = {};
  for (const n of nodes) if (n.kind !== "unit") index[n.id] = n;
  return index;
}

// Depth-first tier assignment: a node with no requires is tier 0 (available from the start);
// otherwise it's one past the DEEPEST of its own requires — so Arsenal (requires Foundry, which
// requires Barracks) lands two tiers past Barracks. A requires token that doesn't resolve in this
// mode's node set (shouldn't happen with the current data — see includeForMode above — but kept
// as a defensive fallback) contributes 0, i.e. is treated as already satisfied at the baseline
// tier. `visiting` is a cycle guard: not expected in this hand-authored, acyclic data, but cheap
// insurance against an infinite recursion if that ever changed — anything already on the current
// DFS path just reads as tier 0 rather than recursing forever.
function tierOf(node, index, memo, visiting) {
  const key = `${node.kind}:${node.id}`;
  if (memo.has(key)) return memo.get(key);
  if (visiting.has(key)) return 0;
  visiting.add(key);
  let t = 0;
  for (const r of node.def.requires || []) {
    const dep = index[r];
    const dt = dep ? tierOf(dep, index, memo, visiting) : 0;
    if (dt + 1 > t) t = dt + 1;
  }
  visiting.delete(key);
  memo.set(key, t);
  return t;
}
function computeTiers(nodes, index) {
  const memo = new Map();
  for (const n of nodes) n.tier = tierOf(n, index, memo, new Set());
}

// Every ancestor of `node`, transitively and deduplicated, in a valid dependency-before-dependent
// order — a post-order DFS over requires[] naturally produces one, since a node is only pushed
// once every one of ITS OWN requires has already been visited. This is what lets a locked node
// spell out its FULL chain ("Barracks -> Foundry -> Arsenal"), not just the one-level "Requires
// Foundry" the Datacenter panel's lockTipFor-style tooltips already gave.
function ancestorsOf(node, index) {
  const seen = new Set([node.id]);
  const list = [];
  function visit(id) {
    if (seen.has(id)) return;
    seen.add(id);
    const dep = index[id];
    if (!dep) return;
    for (const r of dep.def.requires || []) visit(r);
    list.push(dep);
  }
  for (const r of node.def.requires || []) visit(r);
  return list;
}

/* ---------- live state: built / affordable-now / locked ---------- */

function isResearched(state, owner, id) {
  return !!(state.players[owner].upgrades && state.players[owner].upgrades[id]);
}

// The three-way bucket every node is coloured by: "built" (a completed building, or a researched
// tech/doctrine), "afford" (its prereqs are met AND its cost fits right now), or "locked"
// (everything else — either the prereq chain isn't complete, or it is but the cost doesn't fit
// yet; nodeCard below tells those two apart in its own detail text: a full chain for the first,
// a plain "needs X" for the second). A unit gate has no persistent "owned" state of its own (you
// train it repeatedly, you don't complete it once) — it resolves straight to afford/locked.
function nodeState(node, state, owner) {
  const owned = node.kind === "building" ? hasCompletedBuilding(state, owner, node.id)
    : node.kind === "unit" ? false
    : isResearched(state, owner, node.id);
  if (owned) return "built";
  if (!prereqsMet(state, owner, node.def)) return "locked";
  return canAfford(state.players[owner].resources, node.def.cost || {}) ? "afford" : "locked";
}

const RECIPE_BY_ID = Object.fromEntries(RECIPES.map(r => [r.id, r]));
// "2 Ore + 2 Energy Cells -> 2 Metals" — the factory recipe BUILDINGS[].recipe names (data.js
// RECIPES), so a factory's card shows what it actually turns into what, not just its build cost.
function recipeLine(def) {
  if (!def.recipe) return null;
  const r = RECIPE_BY_ID[def.recipe];
  if (!r) return null;
  const ins = Object.entries(r.in).map(([c, q]) => `${q} ${COM[c]?.name || c}`).join(" + ");
  return `${ins} → ${r.qty} ${COM[r.out]?.name || r.out}`;
}

// "150 ore, 100 crystals" — mirrors hudSelection.js's own module-private costText exactly. Kept
// local rather than imported: hudSelection.js exports neither it nor a reusable button builder,
// and importing hudSelection.js at all would pull in its whole HUD-panel graph for one helper.
function costText(cost) {
  return Object.entries(cost).map(([com, qty]) => `${qty} ${com}`).join(", ");
}

const BUILT_DETAIL = { building: "Built", unit: "Available now", tech: "Researched", upgrade: "Researched" };
const AFFORD_DETAIL = { building: "Buildable now", unit: "Available now", tech: "Researchable now", upgrade: "Researchable now" };

// One node's card. Only a BUILDING that isn't already built is ever a real <button> — clicking a
// unit/tech/doctrine node has no defined action (you train/research those from their own panel,
// not from here), and a completed building has nothing left to arm. A locked building is still a
// button so it can give the same audible "denied" feedback makeButton's own disabled path does.
function nodeCard(node, state, owner, index) {
  const bucket = nodeState(node, state, owner);
  const clickable = node.kind === "building" && bucket !== "built";
  const el = document.createElement(clickable ? "button" : "div");
  el.className = `techchart-node kind-${node.kind} ${bucket}`;
  el.dataset.nodeId = node.id;
  el.dataset.kind = node.kind;
  if (clickable) el.type = "button";

  // Icon: the real sprite art for a building/unit (render.js spriteIcon — the same helper and
  // the same .btn-icon tile hudSelection.js's makeButton uses), or the node's own data-icon emoji
  // for a tech/doctrine (TECHS/UPGRADES both carry an `.ico`, the same field the Datacenter/
  // Refinery research buttons already use — hudSelection.js's own icon: { emoji: t.ico } calls).
  let iconEl = null;
  if (node.kind === "building" || node.kind === "unit") {
    const url = spriteIcon(node.kind, node.id, state.players[owner].color);
    if (url) { iconEl = document.createElement("img"); iconEl.className = "btn-icon"; iconEl.src = url; iconEl.alt = ""; }
  } else if (node.def.ico) {
    iconEl = document.createElement("span");
    iconEl.className = "btn-icon btn-emoji";
    iconEl.textContent = node.def.ico;
  }
  if (iconEl) el.appendChild(iconEl);

  const body = document.createElement("div");
  body.className = "techchart-node-body";

  const name = document.createElement("span");
  name.className = "techchart-name";
  name.textContent = node.name;
  body.appendChild(name);

  const cost = document.createElement("span");
  cost.className = "techchart-cost";
  cost.textContent = costText(node.def.cost || {});
  body.appendChild(cost);

  const recipe = recipeLine(node.def);
  if (recipe) {
    const r = document.createElement("span");
    r.className = "techchart-recipe";
    r.textContent = recipe;
    body.appendChild(r);
  }

  const detail = document.createElement("span");
  detail.className = "techchart-detail";
  detail.textContent = bucket === "built" ? BUILT_DETAIL[node.kind]
    : bucket === "afford" ? AFFORD_DETAIL[node.kind]
    : !prereqsMet(state, owner, node.def)
      ? `Requires: ${ancestorsOf(node, index).map(a => a.name).concat(node.name).join(" → ")}`
      : `Needs ${costText(node.def.cost || {})}`;
  body.appendChild(detail);
  el.appendChild(body);
  el.title = detail.textContent;

  if (clickable) el.addEventListener("click", () => onNodeClick(node, bucket, state, owner));
  return el;
}

// Clicking a buildable-now building, with a builder (a Worker, or any other unit whose
// buildCategories covers this building's category — canBuildCategory is the same single source
// of truth hudSelection.js's own build buttons gate on) currently selected, arms input.startBuild
// exactly like the selection panel's own build button does — and closes the overlay, so the next
// click on the field places it. Anything else (locked, or nothing eligible selected) just denies
// audibly, same as makeButton's own disabled-click affordance.
function onNodeClick(node, bucket, state, owner) {
  if (bucket !== "afford") {
    sound.playProductionBlocked();
    if (isTouchMode()) {
      const reason = !prereqsMet(state, owner, node.def) ? "still locked" : `not enough — needs ${costText(node.def.cost || {})}`;
      flashHint(`${node.name}: ${reason}`);
    }
    return;
  }
  const input = game.input;
  if (!input) return;
  const builder = state.selection
    .map(id => state.units.get(id))
    .find(u => u && canBuildCategory(u.type, node.def.category));
  if (!builder) {
    sound.playProductionBlocked();
    flashHint(`Select a Worker to build the ${node.name}`);
    return;
  }
  input.startBuild(node.id);
  closeTechChart();
}

/* ---------- render ---------- */

export function renderTechChart() {
  const state = game.state;
  if (!state) return;
  const odyssey = !!game.galaxy;
  techChartEl.innerHTML = "";

  const head = document.createElement("div");
  head.className = "techchart-head";
  const h2 = document.createElement("h2");
  h2.textContent = "Tech & Industry Chart";
  const p = document.createElement("p");
  p.textContent = odyssey
    ? "The full Odyssey chart — every building, unit gate and tech node, Strategic tier included. Select a Worker (or another builder) and click a buildable entry to place it."
    : "Skirmish's unlock ladder. Select a Worker and click a buildable entry to place it.";
  head.append(h2, p);
  techChartEl.appendChild(head);

  const nodes = buildNodes(odyssey);
  const index = indexNodes(nodes);
  computeTiers(nodes, index);

  const body = document.createElement("div");
  body.className = "techchart-body";
  const maxTier = nodes.reduce((m, n) => Math.max(m, n.tier), 0);
  for (let tier = 0; tier <= maxTier; tier++) {
    const inTier = nodes.filter(n => n.tier === tier);
    if (!inTier.length) continue;
    const col = document.createElement("div");
    col.className = "techchart-col";
    const colHead = document.createElement("div");
    colHead.className = "techchart-col-head";
    colHead.textContent = `Tier ${tier}`;
    col.appendChild(colHead);
    // Grouped building / unit / tech / doctrine within a tier, so the column reads as a scan,
    // not a shuffled pile — a fixed, stable order regardless of Object.values() enumeration order.
    for (const kind of ["building", "unit", "tech", "upgrade"]) {
      for (const n of inTier.filter(x => x.kind === kind)) col.appendChild(nodeCard(n, state, game.localOwner, index));
    }
    body.appendChild(col);
  }
  techChartEl.appendChild(body);

  const foot = document.createElement("p");
  foot.className = "techchart-foot";
  foot.textContent = "T or Esc to close";
  techChartEl.appendChild(foot);

  // The one place the full ladder — every stat, every recipe, the whole Strategic-tier writeup —
  // already lived, now actually reachable from inside the game (docs/improvement-proposals.md:
  // "linked from nowhere in the app"). target="_blank" so opening it never navigates away from
  // (and loses) the running match.
  const manual = document.createElement("a");
  manual.className = "techchart-manual-link";
  manual.href = "docs/player-handbook.html";
  manual.target = "_blank";
  manual.rel = "noopener";
  manual.textContent = "Full field manual ↗";
  techChartEl.appendChild(manual);
}

/* ---------- open / close / hotkey — starmap.js's exact idiom ---------- */

// Same dangling-gesture hazard starmap.js's openStarmap guards against (see input.js's
// cancelGesture): a right-click-drag begun on the canvas just before this overlay opens would
// otherwise still resolve into a move order once released over it.
export function openTechChart() {
  if (!game.state) return;
  if (game.input) game.input.cancelGesture();
  renderTechChart();
  techChartEl.classList.remove("hidden");
  pauseLoop("techchart");
}
export function closeTechChart() {
  techChartEl.classList.add("hidden");
  resumeLoop("techchart");
}
function toggleTechChart() { if (techChartEl.classList.contains("hidden")) openTechChart(); else closeTechChart(); }

// Self-wired, like starmap.js: the topbar button and the T key toggle it, Esc closes it, and
// clicking the backdrop (the overlay itself, not a node) also closes it.
if (techChartBtn) techChartBtn.addEventListener("click", toggleTechChart);
if (techChartEl) techChartEl.addEventListener("click", e => { if (e.target === techChartEl) closeTechChart(); });
if (typeof window !== "undefined" && window) window.addEventListener("keydown", e => {
  if ((e.key === "t" || e.key === "T") && !e.ctrlKey && !e.metaKey && !e.altKey && game.state) {
    // Don't hijack a key meant for a FOCUSED control (a HUD button, a text input, …) — the same
    // guard input.js's own keydown listener uses for its positional hotkeys.
    const t = e.target;
    if (t && t !== document.body && t !== canvas && typeof t.closest === "function"
        && t.closest("button, input, textarea, select, [tabindex]")) return;
    e.preventDefault();
    toggleTechChart();
  } else if (e.key === "Escape" && !techChartEl.classList.contains("hidden")) {
    closeTechChart();
  }
});
