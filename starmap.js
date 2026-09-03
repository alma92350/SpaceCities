/* ============================================================
   The Odyssey starmap — a full-screen overview of the galaxy. Every world sits
   on a ring, coloured by your relationship to it: your active capital, a colony
   you hold (with its neighbour's stance), or somewhere still unexplored. If your
   capital has a Spaceport and the credits for fuel, clicking a world jumps there
   straight from the map. Opened from the topbar button or the M key.

   Pure view over engine/galaxy.js's galaxyStatus() — it reads the live galaxy at
   open time and rebuilds, so it always reflects the current state.
   ============================================================ */

"use strict";

import { starmapEl, starmapBtn } from "./dom.js";
import { game } from "./session.js";
import { galaxyStatus, canJump, canJumpTo, activeState, jumpCost, playerSpaceports, spaceportTier,
         FUEL_DISCOUNT_BY_TIER } from "./engine/galaxy.js";
import { initiateJump, surrenderOdyssey, pauseLoop, resumeLoop } from "./boot.js";
import { spectateWorld } from "./observer.js";
import { showGalaxyToast } from "./overlays.js";
import { planetName as worldName, LORE_FACTIONS, PLANETS, COM } from "./data.js";
import { archetypeFor } from "./engine/aiArchetypes.js";
import { stanceLabel } from "./engine/diplomacy.js";
import { PLANET_MODIFIERS } from "./engine/map.js";
import { getColonyPolicy, setColonyPolicy } from "./engine/colonyPolicy.js";
import { UNITS } from "./engine/entities.js";

// Live colony alert badges (P6 "Starmap live colony ledger and alert badges"): boot.js's
// notifyColony stamps game.colonyAlerts[planetId] = {type, at} for every attack/hostile/lost
// notification a background colony raises (engine/galaxy.js sweepColonies) — the same trigger
// that already fires the transient toast, just remembered here too so a world reads its own
// trouble at a glance. A "lost" alert badges the world until the player actually revisits (boot.js
// focusActivePlanet clears that one planet's entry on arrival); an attack/hostile alert only reads
// as live for ATTACK_ALERT_WINDOW_MS after it fired, so a raid from ten minutes ago doesn't still
// flag the world red forever.
const ATTACK_ALERT_WINDOW_MS = 30000;
function alertBadge(planetId) {
  const alert = game.colonyAlerts[planetId];
  if (!alert) return null;
  if (alert.type === "lost") return "fallen";
  return performance.now() - alert.at <= ATTACK_ALERT_WINDOW_MS ? "attack" : null;
}

// This held world's own defence at a glance: your Command Center count (a razed CC drops this to
// zero even while other buildings still stand) and the supply committed to COMBAT units here —
// workers/freighters/colony ships don't count, since the question is "how much of a fight can
// this world put up", not its whole population (that's the topbar's job, engine/supply.js
// supplyUsed). Reads `state.buildings`/`state.units` directly off g.planets.get(id) (the State
// shape, engine/types.js) rather than any cached snapshot — cheap enough to run only when the
// starmap actually (re)renders: it opens paused (openStarmap calls pauseLoop('starmap')) and this
// is never on a per-frame path (confirmed by reading every renderStarmap call site: the topbar
// button/M-key open and this file's own standing-order/lane-toggle re-renders, nothing periodic).
function garrisonOf(state) {
  let cc = 0, supply = 0;
  for (const b of state.buildings.values())
    if (b.owner === game.localOwner && b.type === "command" && !b.constructing) cc++;
  for (const u of state.units.values())
    if (u.owner === game.localOwner && UNITS[u.type]?.role === "combat") supply += UNITS[u.type].supplyCost || 0;
  return { cc, supply };
}

export function renderStarmap() {
  const g = game.galaxy;
  if (!g) return;
  const status = galaxyStatus(g);
  const canLaunch = canJump(activeState(g));
  starmapEl.innerHTML = "";

  // The origin's best completed Spaceport tier discounts new-world fuel (FUEL_DISCOUNT_BY_TIER,
  // engine/galaxy.js jumpCost) — surfaced here too, since this hint is the other cost-preview
  // call site jumpCost feeds.
  const padTier = playerSpaceports(activeState(g)).reduce((max, sp) => Math.max(max, spaceportTier(sp)), 0);
  const fuelMult = FUEL_DISCOUNT_BY_TIER[padTier] ?? 1;

  const head = document.createElement("div");
  head.className = "starmap-head";
  const hint = canLaunch
    ? `Click a world to jump — free to a colony you hold, fuel scaled by distance to settle a new one`
      + (fuelMult < 1 ? ` (×${fuelMult} at your Tier ${padTier} pad)` : "")
    : "No Spaceport here — click a colony you already hold to fall back to it (build a Spaceport to reach new worlds)";
  // textContent, not innerHTML: `status` counts and credits derive from a (possibly
  // hand-edited) save, and building them as text can't inject markup even if a value
  // is hostile. The one static heading is a plain element.
  const h2 = document.createElement("h2");
  h2.textContent = "Galaxy";
  const p = document.createElement("p");
  p.textContent = `Visited ${status.visited}/${status.total} · Conquered ${status.pacified}/${status.dominationTarget} · ◈ ${Math.floor(g.credits)} · ${hint}`;
  head.append(h2, p);
  starmapEl.appendChild(head);

  const field = document.createElement("div");
  field.className = "starmap-field";
  // Angular slice per world is weighted by card footprint, not split evenly: a world with a
  // PLANET_MODIFIERS rule label (engine/map.js) wraps a noticeably bigger dossier card (its
  // sm-deps line, style.css) than a plain deposits-only one, so it earns a proportionally wider
  // slice of the ring. An even 360/n split (the previous behaviour) packs every world the same
  // regardless of its own card size — fine when the bigger cards land apart, but several landing
  // consecutively (Nimbus/Pyralis/Helix Belt/Oort Reach, on the current 11-world roster) then pack
  // uniformly close and visibly overlap, wherever in the ring that happens to fall.
  const weights = status.worlds.map(w => (PLANET_MODIFIERS[w.id] ? 1.25 : 1));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  let cumWeight = 0;
  const angles = weights.map(wt => {
    const ang = ((cumWeight + wt / 2) / totalWeight) * Math.PI * 2 - Math.PI / 2;
    cumWeight += wt;
    return ang;
  });
  status.worlds.forEach((w, i) => {
    const ang = angles[i];
    const node = document.createElement("button");
    const badge = alertBadge(w.id);   // 'attack' | 'fallen' | null — this world's live alert state
    node.className = "starmap-world " + w.status + (badge ? ` alert-${badge}` : "");
    node.style.left = `${50 + Math.cos(ang) * 42}%`;
    node.style.top = `${50 + Math.sin(ang) * 44}%`;
    const baseSub = w.status === "seat" ? (w.pacified ? "◉ you are here · pacified" : "◉ you are here")
      : w.status === "pacified" ? "⚔ conquered"
      : w.status === "colony" ? `your colony · +${w.income} ◈/min`
      : w.status === "contested" ? `contested · ${stanceLabel(w.stance)}`
      // An unexplored world that a faction has claimed (checkExpansion) reads as that faction's
      // sphere — so you watch factions spread across the frontier before you ever set foot there.
      : w.controlledBy ? `${LORE_FACTIONS[w.controlledBy]?.name || archetypeFor(w.id).name} space`
      : archetypeFor(w.id).name;
    // The alert badge drives the sub-label: 'fallen' replaces it outright — it already says
    // everything that matters, and the underlying status text (almost always "contested"; a razed
    // outpost on an otherwise-pacified world is the one rare exception) would only repeat the same
    // news in other words. 'attack' instead PREFIXES the base line: the colony/income text
    // underneath is still useful context for deciding whether it's worth reinforcing, not just
    // that it's on fire.
    const sub = badge === "fallen" ? "☠ fallen — click to retake"
      : badge === "attack" ? `⚔ under attack · ${baseSub}`
      : baseSub;
    // The world's faction emblem: the DYNAMIC controlling faction (checkExpansion spread) when one has
    // claimed it, else its native faction (data.js LORE_FACTIONS) — so the map's emblems shift as factions
    // colonise across it, a world reading by whoever holds it at a glance.
    const ico = (LORE_FACTIONS[w.controlledBy || w.faction]?.ico) || "🪐";
    // Build each span with textContent, not one innerHTML string: worldName(w.id) falls
    // back to the raw id for an unknown world (data.js), and a hostile save could park
    // markup there — as text it can only ever render as text. Industry/Tech drive the
    // "where to settle" decision, so the stats badge stays.
    const mk = (cls, text) => { const s = document.createElement("span"); s.className = cls; s.textContent = text; return s; };
    // World dossier: deposit icons + yield (data.js PLANETS, the same table the skirmish select
    // cards already print freely — setup.js) plus the world's PLANET_MODIFIERS rule label when
    // it has one (engine/map.js, imported UI-side exactly as setup.js already does). Charted
    // geography, not scouted intel — shown for every world regardless of `discovered` status,
    // same as the industry/tech badge above.
    const planet = PLANETS.find(pl => pl.id === w.id);
    const mod = PLANET_MODIFIERS[w.id];
    const depsText = planet
      ? Object.entries(planet.deposits).map(([c, y]) => `${COM[c]?.ico || "◆"} ${y.toFixed(1)}`).join(" · ")
      : "";
    const dossier = mod ? `${depsText} · ${mod.label}` : depsText;
    // The dossier line is CSS-clamped to 2 lines (style.css) so a long modifier label can't
    // balloon this one card's height past its neighbours on the ring below — title gives back
    // the untruncated text on hover, so clamping never actually loses the modifier's full wording.
    const depsEl = mk("sm-deps", dossier);
    if (dossier) depsEl.title = dossier;
    node.append(
      mk("sm-ico", ico),
      mk("sm-name", worldName(w.id)),
      mk("sm-sub", sub),
      mk("sm-stats", `⚙ ${w.industry} · 🔬 ${w.tech}`),
      depsEl,
    );
    // Garrison line: your standing defence on a world you actually hold RIGHT NOW — the active
    // seat, or a background colony with a building still standing (galaxyStatus's own "colony"
    // test). Not shown for a contested/pacified/unexplored node, where "how many CCs" wouldn't
    // mean "yours" anyway.
    if (w.status === "seat" || w.status === "colony") {
      const { cc, supply } = garrisonOf(g.planets.get(w.id));
      node.append(mk("sm-garrison", `🛡 ${cc} CC · ${supply} supply`));
    }
    node.addEventListener("click", () => onWorldClick(w));
    field.appendChild(node);
  });
  starmapEl.appendChild(field);

  renderColonyOrders(status);   // per-colony standing-orders quick toggle (engine/colonyPolicy.js)
  renderLaneOverlay(g);         // Freight Lanes summary (engine/galaxy.js runLanes)

  const foot = document.createElement("p");
  foot.className = "starmap-foot";
  foot.textContent = "M or Esc to close · the Odyssey never ends unless you surrender";
  starmapEl.appendChild(foot);

  // Surrender — the ONLY way to end the Odyssey (a wipeout just sends relief). Two-click confirm
  // so it can't be hit by accident; the armed state lives on this element until the map re-renders.
  const surrender = document.createElement("button");
  surrender.className = "starmap-surrender";
  surrender.textContent = "🏳 Surrender Odyssey";
  let armed = false;
  surrender.addEventListener("click", () => {
    if (!armed) { armed = true; surrender.textContent = "🏳 Click again to confirm surrender"; surrender.classList.add("armed"); return; }
    closeStarmap();
    surrenderOdyssey();
  });
  starmapEl.appendChild(surrender);
}

// Per-colony standing orders (engine/colonyPolicy.js): a quick toggle row for every world you
// currently hold a colony on, mirroring the fuller panel on that world's own Command Center
// (hudSelection.js renderColonyPolicy) — editable from the starmap so a policy for a world you've
// LEFT doesn't require jumping back just to change it.
function renderColonyOrders(status) {
  const g = game.galaxy;
  const colonies = status.worlds.filter(w => w.status === "colony");
  if (!colonies.length) return;

  const wrap = document.createElement("div");
  wrap.className = "starmap-side";
  const head = document.createElement("div");
  head.className = "market-head";
  head.textContent = "Colony standing orders";
  wrap.appendChild(head);

  for (const w of colonies) {
    const policy = getColonyPolicy(g, w.id);
    const row = document.createElement("div");
    row.className = "market-row";

    const label = document.createElement("span");
    label.className = "market-com";
    label.textContent = worldName(w.id);
    row.appendChild(label);

    const asBtn = document.createElement("button");
    asBtn.className = "market-btn";
    asBtn.textContent = policy.autoSell.enabled ? "Auto-sell: ON" : "Auto-sell: OFF";
    asBtn.title = "Sell stock above its floors into this colony's own market while you're away (set floors from its Command Center panel).";
    asBtn.addEventListener("click", () => { setColonyPolicy(g, w.id, { autoSell: { enabled: !policy.autoSell.enabled } }); renderStarmap(); });
    row.appendChild(asBtn);

    const wtLabel = document.createElement("span");
    wtLabel.className = "market-trend";
    wtLabel.textContent = `workers ${policy.workerTarget > 0 ? policy.workerTarget : "off"}`;
    row.appendChild(wtLabel);
    const dec = document.createElement("button");
    dec.className = "market-btn";
    dec.textContent = "−";
    dec.addEventListener("click", () => { setColonyPolicy(g, w.id, { workerTarget: Math.max(0, policy.workerTarget - 1) }); renderStarmap(); });
    row.appendChild(dec);
    const inc = document.createElement("button");
    inc.className = "market-btn";
    inc.textContent = "+";
    inc.addEventListener("click", () => { setColonyPolicy(g, w.id, { workerTarget: policy.workerTarget + 1 }); renderStarmap(); });
    row.appendChild(inc);

    wrap.appendChild(row);
  }
  starmapEl.appendChild(wrap);
}

// Freight Lanes overlay (engine/galaxy.js runLanes): one line per standing route, galaxy-wide —
// set up and edited at the source world's Spaceport panel (hudSelection.js renderLanes); this is
// a read-only summary so a route between two worlds you're not currently standing on is still
// visible at a glance.
function renderLaneOverlay(g) {
  const lanes = g.lanes || [];
  if (!lanes.length) return;

  const wrap = document.createElement("div");
  wrap.className = "starmap-side";
  const head = document.createElement("div");
  head.className = "market-head";
  head.textContent = "Freight Lanes";
  wrap.appendChild(head);

  for (const lane of lanes) {
    const row = document.createElement("div");
    row.className = "market-row";
    const label = document.createElement("span");
    label.className = "market-com";
    label.textContent = `${worldName(lane.from)} ▸ ${worldName(lane.to)}`;
    row.appendChild(label);
    const info = document.createElement("span");
    info.className = "market-trend";
    info.textContent = `${lane.shipIds.length} ship${lane.shipIds.length === 1 ? "" : "s"}`;
    row.appendChild(info);
    wrap.appendChild(row);
  }
  starmapEl.appendChild(wrap);
}

function onWorldClick(w) {
  const g = game.galaxy;
  if (!g) return;
  // Observer Mode: free camera jump to ANY world, discovered or not — no fuel, no Spaceport
  // gate, no real activeId change (see observer.js's header comment). Takes over the whole
  // click, including a world you're already spectating (re-clicking your own real seat while
  // observing is a legitimate way to look back at it).
  if (game.observerMode) { spectateWorld(w.id); closeStarmap(); return; }
  if (w.id === g.activeId) return;
  // With no Spaceport here you can still fall back to a world you hold — only a NEW world needs one.
  if (!canJumpTo(g, w.id)) {
    showGalaxyToast(`No Spaceport here — you can only fall back to a colony you already hold. Build a Spaceport to reach ${worldName(w.id)}.`, "warn");
    return;
  }
  const cost = jumpCost(g, w.id);   // free to a world you hold, JUMP_COST to reach a new one
  if (g.credits < cost) { showGalaxyToast(`Need ◈${cost} fuel to jump to ${worldName(w.id)}.`, "warn"); return; }
  closeStarmap();
  initiateJump(w.id);   // carries the expedition (or, if stranded, evacuates the force) to the world — may open a landing-site picker first
}

// Same dangling-gesture hazard as boot.js's initiateJump (see input.js's cancelGesture): a
// right-click-drag begun on the canvas just before the starmap opens would otherwise still
// resolve into a move order once released over it.
export function openStarmap() { if (!game.galaxy) return; if (game.input) game.input.cancelGesture(); renderStarmap(); starmapEl.classList.remove("hidden"); pauseLoop("starmap"); }   // hold the sim while the starmap is up
export function closeStarmap() { starmapEl.classList.add("hidden"); resumeLoop("starmap"); }
function toggleStarmap() { if (starmapEl.classList.contains("hidden")) openStarmap(); else closeStarmap(); }

// Self-wired, like the other overlays: the topbar button and the M key toggle it
// (M only in Odyssey — there's no galaxy otherwise), Esc closes it. Clicking the
// backdrop (the overlay itself, not a world button) also closes.
if (starmapBtn) starmapBtn.addEventListener("click", toggleStarmap);
if (starmapEl) starmapEl.addEventListener("click", e => { if (e.target === starmapEl) closeStarmap(); });
if (typeof window !== "undefined") window.addEventListener("keydown", e => {
  if ((e.key === "m" || e.key === "M") && game.galaxy) { e.preventDefault(); toggleStarmap(); }
  else if (e.key === "Escape" && !starmapEl.classList.contains("hidden")) closeStarmap();
});
