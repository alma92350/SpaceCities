/* ============================================================
   The in-game HUD: the resource/clock/idle readouts, the selection panel
   (its per-selection buttons and live-patched rows/queue), the small button /
   tooltip factories, and the game-over screen. Split out of main.js — the
   live `state`/`input` are read from the shared session (session.js) at the top
   of each function, so the bodies are unchanged from the original.
   ============================================================ */

"use strict";

import { game, seatDisplayName } from "./session.js";
import {
  resourcesEl, clockEl, scoreBarEl, idleWorkersEl, idleProductionEl,
  scenarioBarEl, scenarioBannerEl, scenarioStatusEl, repairBtn, departBtn,
  starmapBtn, saveBtn, loadBtn, groupChipsEl, pauseBtn, gateChipEl, canvas,
} from "./dom.js";
import { supplyUsed, supplyCap } from "./engine/supply.js";
import { UNITS, BUILDINGS } from "./engine/entities.js";
import { powerCap, powerDraw } from "./engine/industry.js";
import { repairCost, repairConvoy, departNow } from "./engine/scenarios.js";
import { stanceLabel, PEACE_THRESHOLD } from "./engine/diplomacy.js";
import { playerScore, DEFAULT_MATCH_TIME_LIMIT } from "./engine/victory.js";
import { otherOwner } from "./engine/aiCommon.js";
import { COM } from "./data.js";
import { clampCamera } from "./camera.js";
// The per-selection button/row subsystem lives in hudSelection.js (this file drives
// the topbar / scenario bar / group chips and orchestrates the tick); renderHUD calls
// renderSelectionPanel each frame, and resetPanelSignature clears both guards on boot.
import { renderSelectionPanel, resetSelectionSignature } from "./hudSelection.js";
// The reactive opening checklist's per-tick driver — see overlays.js's own header comment on
// updateObjectives for the signature-guard reasoning (mirrors this file's own lastTopbarSignature
// just below).
import { updateObjectives } from "./overlays.js";

// Scenario dock actions — wired once. They read game.state at click time, and
// re-render immediately so the button state / budget update without waiting for
// the next HUD tick.
if (repairBtn) repairBtn.addEventListener("click", () => { if (game.state && repairConvoy(game.state)) renderHUD(); });
if (departBtn) departBtn.addEventListener("click", () => { if (game.state) { departNow(game.state); renderHUD(); } });

// The Gate charge chip's click-to-jump — mirrors boot.js's underAttackEl listener exactly
// (getCamera() -> set x/y -> clampCamera against the current viewport). Unlike an under-attack
// PING (a transient event whose coordinates have to be remembered because the thing itself is
// long gone by click time), the Gate is a stationary building that's still sitting in
// state.buildings when this fires, so its position is looked up live rather than cached.
if (gateChipEl) gateChipEl.addEventListener("click", () => {
  if (!game.input || !game.state) return;
  const wonder = [...game.state.buildings.values()].find(b => BUILDINGS[b.type]?.wonder && b.owner === game.localOwner && !b.constructing);
  if (!wonder) return;
  const cam = game.input.getCamera();
  cam.x = wonder.x;
  cam.y = wonder.y;
  clampCamera(cam, game.state.map, canvas.clientWidth, canvas.clientHeight);
});

// How far from the end the clock flips from elapsed time to a countdown + score bar (see
// renderHUD's clock block below) — 5 minutes, matching the proposal's own spec.
const ENDGAME_WINDOW = 300;

// Topbar-rebuild guard: the last signature the resource/supply/credits/power/stance
// topbar was rebuilt for (the selection panel keeps its own guard in hudSelection.js).
// boot.js clears BOTH via resetPanelSignature() when a new game boots so the first
// frame rebuilds fresh.
let lastTopbarSignature = null;

// Commodity flow ledger (docs/improvement-proposals.md lines 795-803, "Commodity flow ledger: net
// rates, not just stock levels"): the topbar above shows only absolute stocks, so a player can't
// tell a commodity has gone net-negative until whatever depends on it actually goes dark (a
// combustor/Reactor's fuel larder runs dry, the Gate stalls). A small ring buffer samples
// player.resources on a state.time cadence — NEVER a wall clock (no Date.now/performance.now
// here, matching the engine's one-clock rule even though this file sits entirely outside
// engine/), so it's pause-safe (boot.js gates the SIM, not the render loop — a paused game keeps
// calling renderHUD every animation frame with a frozen state.time, and sampleFlowLedger below
// then simply never advances) and a same-seed replay would compute an identical history. Kept
// deliberately BESIDE lastTopbarSignature above rather than folded into it: taking a new sample
// must never itself force the topbar's innerHTML rebuild (see sampleFlowLedger's own comment), so
// `sig` below never reads any of this. Reset together in resetPanelSignature — a new game/world
// starts its own clean history, never compared against a previous world's timeline.
const FLOW_SAMPLE_INTERVAL = 2;      // seconds of state.time between ring-buffer samples
const FLOW_HISTORY_LEN = 30;         // samples retained -> up to ~60s of oldest-vs-newest smoothing once full
let flowHistory = [];                // [{ time, resources: {com: qty, ...} }, ...] oldest first
let lastFlowSampleTime = null;       // state.time of the last sample taken; null = none yet (or just reset)

export function resetPanelSignature() {
  lastTopbarSignature = null;
  game.lastGateCharge = null;   // don't compare a new world's Gate against the previous one's charge history
  flowHistory = [];
  lastFlowSampleTime = null;
  resetSelectionSignature();
}

// Push a new flow-ledger sample once at least FLOW_SAMPLE_INTERVAL seconds of STATE time (never
// wall-clock) have passed since the last one. Called unconditionally every renderHUD tick, ahead
// of (and independent from) the topbar signature check below — so a paused game (state.time
// frozen) never accumulates phantom samples no matter how many animation frames re-render it, and
// a sample that IS taken never perturbs `sig`, so it can never itself trigger the guarded rebuild.
function sampleFlowLedger(state) {
  if (lastFlowSampleTime !== null && state.time - lastFlowSampleTime < FLOW_SAMPLE_INTERVAL) return;
  lastFlowSampleTime = state.time;
  flowHistory.push({ time: state.time, resources: { ...state.players[game.localOwner].resources } });
  if (flowHistory.length > FLOW_HISTORY_LEN) flowHistory.shift();
}

// Net units/min for one commodity, from the ring buffer's oldest-vs-newest sample. Fewer than two
// samples yet (a fresh game, or right after resetPanelSignature) — or a non-positive elapsed span
// — reads as flat: there's nothing to compare against yet, so a fresh stockpile never shows a
// phantom rate. A commodity missing from an older sample (didn't exist in player.resources yet)
// defaults to 0, the same `|| 0` idiom the topbar itself uses below.
function flowRate(com) {
  if (flowHistory.length < 2) return 0;
  const oldest = flowHistory[0], newest = flowHistory[flowHistory.length - 1];
  const dt = newest.time - oldest.time;
  if (dt <= 0) return 0;
  return ((newest.resources[com] || 0) - (oldest.resources[com] || 0)) / dt * 60;
}

// "+N/min" / "-N/min" for an already-ROUNDED rate — callers round once and reuse that same
// integer for both the label and the red-highlight test below, so the two can never disagree (a
// trickle that rounds to 0 always reads "+0/min", never a red "-0/min").
function formatFlowRate(rounded) {
  return `${rounded < 0 ? "-" : "+"}${Math.abs(rounded)}/min`;
}

// Which commodities currently have something LIVE standing on them: a built (not constructing)
// fuel-burning station's fuels, a Plasma Rig's nuclear burn (always radioactives — engine/rig.js
// updatePlasmaRig), or the Antimatter Gate's feed goods while it's actually charging. Gates the
// red highlight below so it only fires for a shortage that's about to bite something real, not a
// stockpile nobody has ever spent from (docs/improvement-proposals.md: "rather than coloring
// every net-negative commodity red regardless of whether it matters yet"). Player-owned only —
// the topbar is the player's own economy. A charge of exactly 0 does NOT count as "charging",
// mirroring this file's own gateStalled reasoning below (a freshly-completed Gate hasn't drawn a
// drop of its feed goods yet, so flagging them red would be a lie before the first tick actually
// spends any) — nor does a charge of 1 (fully charged, no longer drawing). Pure scan of
// state.buildings + BUILDINGS defs; writes nothing, reads only.
function liveConsumers(state) {
  const coms = new Set();
  for (const b of state.buildings.values()) {
    if (b.owner !== game.localOwner || b.constructing) continue;
    const def = BUILDINGS[b.type];
    if (!def) continue;
    if (def.combust) for (const com of def.combust.fuels) coms.add(com);
    if (def.rig) coms.add("radioactives");
    if (def.wonder && b.charge > 0 && b.charge < 1) {
      for (const com in def.feed || {}) coms.add(com);
    }
  }
  return coms;
}

export function renderHUD() {
  const { state } = game;

  // The galaxy-map button shows only in Odyssey. Save/Load work in a skirmish and
  // in an Odyssey (whole-galaxy save), but a scripted scenario can't be resumed,
  // so they're hidden there.
  starmapBtn.classList.toggle("hidden", !game.galaxy);
  // A WATCHED match (docs/competitions-and-elo.md Phase 5) hides Save/Load for the same reason a
  // scenario does, one step further: it isn't the player's game to keep. Both seats are AI-driven
  // by a session flag that no save carries, so a saved-and-resumed watched match would come back
  // as a skirmish with an unmanned player seat (saveShape.js's resumableMode already refuses to
  // autosave one — this is the matching affordance).
  const spectating = !!game.spectateMatch;
  saveBtn.classList.toggle("hidden", !!state.scenario || spectating);
  loadBtn.classList.toggle("hidden", !!state.scenario || spectating);
  pauseBtn.classList.remove("hidden");   // pause is available in every mode (touch has no P key)

  if (state.scenario) {
    // A scenario has no economy: its budget + clock live in the scenario bar,
    // so blank the skirmish readouts and drive the bar instead.
    resourcesEl.innerHTML = "";
    idleWorkersEl.classList.add("hidden");
    idleProductionEl.classList.add("hidden");
    clockEl.textContent = "";
  } else {
    const res = state.players[game.localOwner].resources;

    // Sample the flow ledger every tick — see sampleFlowLedger's own comment for why this sits
    // here, unconditionally, ahead of the signature guard below rather than inside it.
    sampleFlowLedger(state);

    const used = supplyUsed(state, game.localOwner), cap = supplyCap(state, game.localOwner);
    const blocked = performance.now() < game.supplyBlockedUntil;
    const pCap = game.galaxy ? powerCap(state, game.localOwner) : 0, pDraw = game.galaxy ? powerDraw(state, game.localOwner) : 0;
    const stance = game.galaxy && state.diplomacy ? state.diplomacy.stance : null;

    // Persistent Antimatter Gate charge strip (docs/improvement-proposals.md lines 745-753):
    // gated on game.galaxy only, the same Odyssey idiom the Power readout above already uses
    // (antimatter_gate is odysseyOnly, so `wonder` is always null in a skirmish regardless).
    // `state.buildings` is the ACTIVE planet's roster — like hudSelection.js's own wonder panel,
    // this only finds the Gate while physically on its world (a background colony's Gate keeps
    // charging per stepGalaxy, just off-screen here — same as that panel today). Constructing
    // excluded to match chargingWonderOf/the wonder panel's own precedent: a building site isn't
    // charging or provoking anyone yet.
    const wonder = game.galaxy
      ? [...state.buildings.values()].find(b => BUILDINGS[b.type]?.wonder && b.owner === game.localOwner && !b.constructing)
      : null;
    let gatePct = 0, gateStalled = false;
    if (wonder) {
      const charge = wonder.charge || 0;
      gatePct = Math.round(charge * 100);   // matches hudSelection.js's own wonder-panel rounding, so the two readouts never disagree
      const prev = game.lastGateCharge;
      // Stalled = no progress since the last tick THIS SAME wonder was observed (see
      // game.lastGateCharge's own comment for why the id has to match too) — OR sitting at
      // exactly 0%, which engine/wonder.js's chargingWonderOf treats as not-yet-charging
      // (c > 0 required) and diplomacy.js's GATE_WAR_TARGET never provokes for, so "provoking
      // neighbours" would be a lie before the first drop of antimatter is fed in.
      gateStalled = charge <= 0 || (!!prev && prev.id === wonder.id && charge <= prev.charge);
      game.lastGateCharge = { id: wonder.id, charge };
    }

    // Signature-guard the topbar exactly like the selection panel: this whole readout was torn
    // down and rebuilt (~8 createElement/appendChild) every 150 ms even when nothing changed.
    // Skip the rebuild unless a displayed value actually moved. (The clock + idle count below
    // are single-text writes, cheap enough to patch every tick.)
    const sig = Object.entries(res).map(([c, q]) => `${c}${Math.floor(q)}`).join("|")
      + `|s${used}/${cap}${used >= cap ? "C" : ""}${blocked ? "B" : ""}`
      + (game.galaxy ? `|◈${Math.floor(game.galaxy.credits)}|p${Math.round(pDraw)}/${pCap}` : "")
      + (stance !== null ? `|r${stance.toFixed(2)}` : "")
      + (wonder ? `|gate${gatePct}${gateStalled ? "!" : ""}` : "");
    if (sig !== lastTopbarSignature) {
      lastTopbarSignature = sig;
      resourcesEl.innerHTML = "";
      const liveCons = liveConsumers(state);
      Object.entries(res).forEach(([com, qty]) => {
        const n = Math.floor(qty);
        // Suppress empty stockpiles (a fresh Odyssey shows "ai: 0", "antimatter: 0",
        // … for a dozen goods you haven't made yet) — but always keep ore, the
        // bread-and-butter you're never without. An iconed readout ("🪨 120")
        // reads far faster than a wall of "com: n" labels.
        if (n <= 0 && com !== "ore") return;
        const meta = COM[com];
        const span = document.createElement("span");
        span.textContent = meta?.ico ? `${meta.ico} ${n}` : `${com}: ${n}`;
        span.dataset.com = com;
        // Flow-ledger tooltip: the net rate from the ring buffer's oldest-vs-newest sample (reads
        // 0 with fewer than two samples yet — see flowRate). Red only when BOTH net-negative and
        // something live currently depends on this commodity (liveConsumers) — a stockpile
        // nobody has ever spent from stays the ordinary color even while it drains.
        const rate = Math.round(flowRate(com));
        span.title = `${meta?.name || com} · ${formatFlowRate(rate)}`;
        if (rate < 0 && liveCons.has(com)) span.classList.add("deficit");
        resourcesEl.appendChild(span);
      });

      const supplySpan = document.createElement("span");
      supplySpan.className = "supply" + (used >= cap ? " at-cap" : "") + (blocked ? " blocked" : "");
      // cap can be fractional (an electrified Habitat's grant is scaled by the grid throttle,
      // engine/supply.js) — round for display only; the at-cap comparison above stays on the
      // exact value so it can't flicker a rounding-boundary case.
      supplySpan.textContent = `supply: ${used}/${Math.round(cap)}`;
      resourcesEl.appendChild(supplySpan);

      // Odyssey: your universal credit balance lives on the galaxy, not the planet
      // — shown alongside the local economy (spent on jumps and the market later).
      if (game.galaxy) {
        const creditsSpan = document.createElement("span");
        creditsSpan.className = "credits";
        creditsSpan.textContent = `◈ ${Math.floor(game.galaxy.credits)}`;
        creditsSpan.title = "Universal credits — galaxy-wide, carried between planets";
        resourcesEl.appendChild(creditsSpan);

        // Industrial Power — shown only once you've started industrializing (a
        // Reactor or a factory exists), so it never clutters the pre-industry HUD.
        // Reads like the supply gauge: draw/cap, flagged when factories out-draw
        // the Reactors and production throttles.
        if (pCap > 0 || pDraw > 0) {
          const pw = document.createElement("span");
          pw.className = "power" + (pDraw > pCap ? " at-cap" : "");
          // pCap can be fractional too (the powerMult tech scales it, engine/industry.js) —
          // round for display only, same as supply above; the at-cap comparison stays exact.
          pw.textContent = `⚡ ${Math.round(pDraw)}/${Math.round(pCap)}`;
          pw.title = "Industrial Power — Reactors grant it, factories draw it; short power throttles all production";
          resourcesEl.appendChild(pw);
        }

        // The neighbour's stance — it drifts hostile as this world's deposits run scarce.
        if (stance !== null) {
          const relSpan = document.createElement("span");
          relSpan.className = "relation " + (stance <= PEACE_THRESHOLD ? "hostile" : stance < 0.25 ? "neutral" : "friendly");
          relSpan.textContent = `neighbour: ${stanceLabel(stance)}`;
          relSpan.title = "Your neighbour's stance — it turns hostile as this world's deposits run scarce";
          resourcesEl.appendChild(relSpan);
        }
      }

      // The Gate chip itself: hidden with no player wonder on this world, otherwise the
      // percentage + provoking/stalled copy the proposal calls for, color tier warming with
      // progress and flipping to the dedicated stalled look regardless of tier once charge
      // stops climbing (a near-full Gate that stalls must still read as stalled, not "hot").
      if (wonder) {
        gateChipEl.textContent = `🌀 Gate ${gatePct}% · ${gateStalled ? "stalled" : "provoking neighbours"}`;
        gateChipEl.classList.remove("hidden");
        gateChipEl.classList.toggle("stalled", gateStalled);
        gateChipEl.classList.toggle("hot", !gateStalled && gatePct >= 75);
        gateChipEl.classList.toggle("warm", !gateStalled && gatePct >= 50 && gatePct < 75);
      } else {
        gateChipEl.classList.add("hidden");
      }
    }

    // The clock: plain elapsed time normally, but inside the FINAL 5 MINUTES of a skirmish's
    // score-decision tiebreak (engine/victory.js checkWinCondition / DEFAULT_MATCH_TIME_LIMIT) it
    // flips to a countdown with a compact two-sided score bar — the score is otherwise completely
    // invisible in-game (docs/improvement-proposals.md "Make the clock endgame visible, honest,
    // and configurable"). `state.endless` (Odyssey) has no clock/score tiebreak at all — checked
    // here rather than via game.galaxy so a standalone endless test-fixture state behaves the same
    // way a real Odyssey world does — so it never enters this window regardless of elapsed time.
    const limit = state.matchTimeLimit ?? DEFAULT_MATCH_TIME_LIMIT;
    const remain = limit - state.time;
    if (!state.endless && remain <= ENDGAME_WINDOW) {
      const clamped = Math.max(0, remain);   // state.time can tick a hair past `limit` before checkWinCondition ends the match
      const m = Math.floor(clamped / 60), s = Math.floor(clamped % 60).toString().padStart(2, "0");
      clockEl.textContent = `-${m}:${s}`;
      clockEl.classList.add("endgame");
      const you = Math.round(playerScore(state, game.localOwner)), foe = Math.round(playerScore(state, otherOwner(game.localOwner)));
      // In a WATCHED match there is no "you" — both seats are AI (docs/competitions-and-elo.md
      // Phase 5), so name the two entrants instead of addressing a commander who isn't playing.
      // game.spectateMatch carries them; it's null in every ordinary game, which keeps the
      // first-person copy exactly as it was for the mode that actually has a human in it.
      const watching = game.spectateMatch;
      // T-031: seatDisplayName(), not a hardcoded "You"/"Opponent" pair — the SAME "You" today
      // (game.localOwner's own seat), but now a real chosen name for the other seat once a lobby
      // ever sets one (session.js's own seatNames), rather than a second sweep to find this site.
      scoreBarEl.textContent = watching
        ? `⚔ ${watching.aName} ${you} · ${watching.bName} ${foe}`
        : `⚔ ${seatDisplayName(game.localOwner)} ${you} · ${seatDisplayName(otherOwner(game.localOwner))} ${foe}`;
      scoreBarEl.classList.remove("hidden");
    } else {
      const mins = Math.floor(state.time / 60);
      const secs = Math.floor(state.time % 60).toString().padStart(2, "0");
      clockEl.textContent = `${mins}:${secs}`;
      clockEl.classList.remove("endgame");
      scoreBarEl.classList.add("hidden");
    }

    // Idle-worker indicator: a lost worker on a big map is easy to miss, so surface
    // the count in the topbar (click, or `, to jump to the next one).
    let idle = 0;
    for (const u of state.units.values()) {
      if (u.owner === game.localOwner && UNITS[u.type]?.role === "worker" && !u.order && (!u.orderQueue || !u.orderQueue.length)) idle++;
    }
    idleWorkersEl.textContent = `⚒ ${idle} idle`;
    // Hidden outright while WATCHING a match. These two chips are the only remaining route into
    // state.selection while Observer Mode is on (input.js delegates every mouse/key path away, but
    // these call input.focusIdleWorker/focusIdleProducer directly through main.js), and a selection
    // is what puts real order buttons on the selection panel. In a spectated match those workers
    // aren't the player's to command — so the affordance goes, not just the orders.
    idleWorkersEl.classList.toggle("hidden", idle === 0 || spectating);

    // Idle-production indicator: the building-scale sibling above — multiple Barracks are normal
    // mid-game (the AI explicitly runs several, per README), and an empty Produce queue on one
    // you aren't looking at is otherwise invisible. Click (input.focusIdleProducer, wired in
    // main.js) cycles to and selects the next one.
    let idleProduction = 0;
    for (const b of state.buildings.values()) {
      if (b.owner === game.localOwner && !b.constructing && BUILDINGS[b.type]?.produces && b.queue.length === 0) idleProduction++;
    }
    idleProductionEl.textContent = `🏭 ${idleProduction} idle`;
    idleProductionEl.classList.toggle("hidden", idleProduction === 0 || spectating);   // see the idle-worker chip above
  }

  renderScenarioBar(state);
  renderGroupChips();
  renderSelectionPanel();
  updateObjectives(game);
}

// A small always-visible row of the player's bound control groups ("1:8  2:3") near the
// minimap — so groups are discoverable, and on touch (no number row) each chip recalls its
// group on tap (a second tap recenters, via input.recallGroup's double-press). Rebuilt each
// HUD tick from live counts; hidden when nothing is bound.
let lastGroupChipSig = "";
function renderGroupChips() {
  const input = game.input;
  const list = input && input.groupCounts ? input.groupCounts() : [];
  const sig = list.map(e => `${e.digit}:${e.count}`).join(" ");
  if (sig === lastGroupChipSig) return;   // only touch the DOM when the counts actually change
  lastGroupChipSig = sig;
  groupChipsEl.innerHTML = "";
  groupChipsEl.classList.toggle("hidden", list.length === 0);
  for (const { digit, count } of list) {
    const chip = document.createElement("button");
    chip.className = "group-chip";
    chip.textContent = `${digit}:${count}`;
    chip.title = `Control group ${digit} (${count} unit${count === 1 ? "" : "s"}) — tap to select, tap again to jump`;
    // Read game.input LIVE in the handler, not the controller captured at build time: an
    // Odyssey jump swaps the controller, and if the chip counts happen to match (same sig)
    // the row isn't rebuilt — a captured handler would then recall on the old, destroyed
    // world's controller. recallGroup reads game.groups[planetId] live, so this is correct.
    chip.addEventListener("click", () => game.input && game.input.recallGroup(digit));
    groupChipsEl.appendChild(chip);
  }
}

// The scenario status strip: the phase banner, a leg/freighters/clock/budget
// line, and the Repair / Depart actions while docked at a station. Hidden
// entirely in a skirmish.
function renderScenarioBar(state) {
  const sc = state.scenario;
  if (!sc) { scenarioBarEl.classList.add("hidden"); return; }
  scenarioBarEl.classList.remove("hidden");
  scenarioBannerEl.textContent = sc.banner;

  const remain = Math.max(0, sc.timeLimit - state.time);

  // Bounty Marshal: a seek-and-destroy hunt — camps cleared toward the quota,
  // bounty banked, and the clock. No route/legs, so this runs before any route
  // access (a bounty scenario has no sc.route); no budget, no dock actions.
  if (sc.type === "bounty") {
    scenarioStatusEl.textContent =
      `Camps ${sc.packsCleared}/${sc.totalPacks} · Quota ${sc.targetPacks} · ⏱ ${clockStr(remain)} · 💰 ${sc.bounty}`;
    repairBtn.classList.add("hidden");
    departBtn.classList.add("hidden");
    return;
  }

  // The convoy scenarios (escort / raider) run a route of legs.
  const legs = sc.route.length - 1;
  const legNo = Math.min(sc.legIndex + 1, legs);

  // Pirate Raider: you hunt the AI convoy, so the readout is kills-toward-quota,
  // convoy still afloat, and the clock — no budget, no dock actions.
  if (sc.type === "raider") {
    const afloat = [...state.units.values()].filter(u => u.owner === sc.freighterOwner && u.type === "freighter").length;
    const sunk = sc.outcome ? sc.destroyed : (sc.freightersTotal - afloat - (sc.delivered || 0));
    scenarioStatusEl.textContent =
      `Leg ${legNo}/${legs} · Sunk ${sunk}/${sc.targetKills} · Convoy ${afloat} afloat · ⏱ ${clockStr(remain)}`;
    repairBtn.classList.add("hidden");
    departBtn.classList.add("hidden");
    return;
  }

  const alive = [...state.units.values()].filter(u => u.owner === game.localOwner && u.type === "freighter").length;
  const shown = sc.outcome ? sc.delivered : alive;
  scenarioStatusEl.textContent =
    `Leg ${legNo}/${legs} · Freighters ${shown}/${sc.freightersTotal} · ⏱ ${clockStr(remain)} · 💰 ${Math.round(sc.budget)}`;

  if (sc.phase === "docked") {
    const cost = repairCost(state);
    repairBtn.classList.remove("hidden");
    departBtn.classList.remove("hidden");
    repairBtn.classList.toggle("disabled", sc.repairedThisStop || cost === 0 || cost > sc.budget);
    repairBtn.textContent = sc.repairedThisStop ? "Repaired ✓"
      : cost === 0 ? "No damage"
      : cost > sc.budget ? `Repair (${cost}) — no funds`
      : `Repair all (${cost} 💰)`;
  } else {
    repairBtn.classList.add("hidden");
    departBtn.classList.add("hidden");
  }
}

function clockStr(sec) {
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}
