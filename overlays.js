/* ============================================================
   The small non-panel UI chrome: the seed + faction chips, the one-time
   objectives strip, and the controls/help overlay. Each self-wires its own
   click/keydown listeners at import time (referencing only its DOM handles and
   its own functions); the initial buildHelpOverlay() kickoff is called by
   main.js. boot.js calls showSeedChip / showFactionChip / showObjectives /
   hideObjectives when a game boots.
   ============================================================ */

"use strict";

import { seedChipEl, factionChipEl, objectivesEl, helpOverlayEl, helpBtn, gameOverEl, galaxyToastEl, uiHintEl } from "./dom.js";
import { FACTIONS } from "./engine/factions.js";
import { UNITS, committedDoctrine, hasCompletedBuilding } from "./engine/entities.js";
import { game, seatDisplayName } from "./session.js";
import { scoreBreakdown, playerScore } from "./engine/victory.js";
import { otherOwner } from "./engine/aiCommon.js";
// PLAY AGAINST YOURSELF (playerFingerprint.js, docs/ai-evolution-design.md): the finished match
// state is the only place a human's own play can be measured, so the offer belongs on this screen.
import { mirrorOfPlayer } from "./playerFingerprint.js";
import { pauseLoop, resumeLoop, togglePause } from "./boot.js";   // runtime-only calls; the boot↔overlays cycle resolves via live bindings
import * as sound from "./sound.js";

/* ---------- seed chip ---------- */

export function showSeedChip(seed) {
  seedChipEl.textContent = `Seed ${seed}`;
  seedChipEl.dataset.seed = String(seed);
  seedChipEl.classList.remove("hidden");
}

// "You: Frontier ⚔ Miners" — your faction vs the opponent's. Hidden for a
// neutral-vs-neutral match (a bare state with no factions picked).
export function showFactionChip(st) {
  const you = FACTIONS[st.players[game.localOwner].faction], foe = FACTIONS[st.players[otherOwner(game.localOwner)].faction];
  if (!you || you.id === "neutral") { factionChipEl.classList.add("hidden"); return; }
  // T-031: seatDisplayName(), not a hardcoded "You"/"Foe" pair — see hud.js's own identical fix
  // for the reasoning (same "You" today, a real chosen name for the other seat once one exists).
  const youName = seatDisplayName(game.localOwner), foeName = seatDisplayName(otherOwner(game.localOwner));
  factionChipEl.textContent = `${youName}: ${you.short} ⚔ ${foe && foe.id !== "neutral" ? foe.short : foeName}`;
  factionChipEl.title = `${youName} — ${you.name}: ${you.blurb}` + (foe && foe.id !== "neutral" ? `\n${foeName} — ${foe.name}: ${foe.blurb}` : "");
  factionChipEl.classList.remove("hidden");
}

if (seedChipEl) seedChipEl.addEventListener("click", () => {
  const s = seedChipEl.dataset.seed;
  if (s && navigator.clipboard) navigator.clipboard.writeText(s).catch(() => {});
  seedChipEl.classList.add("copied");
  setTimeout(() => seedChipEl.classList.remove("copied"), 900);
});

/* ---------- objectives checklist ---------- */

// The reactive opening checklist (docs/improvement-proposals.md "Reactive opening checklist
// replacing the static objectives strip"): a small per-mode predicate table, walked fresh every
// time the strip (re)paints. Each predicate reads (state, galaxy) and returns a boolean — a pure
// state read, so re-evaluating the whole table every HUD tick (updateObjectives, below) is always
// safe, and cheap: a handful of Map iterations, the same cost hud.js's own idle-worker counter
// already pays every tick. `text` is a function too, so the one dynamic item (the worker count)
// can report a live "n/8" instead of freezing at whatever it read on mount.
const WORKER_TARGET = 8;
const COMBAT_TARGET = 5;

function countUnits(state, owner, pred) {
  let n = 0;
  for (const u of state.units.values()) if (u.owner === owner && pred(UNITS[u.type])) n++;
  return n;
}

const SKIRMISH_OBJECTIVES = [
  {
    text: state => `Train Workers (${Math.min(countUnits(state, game.localOwner, d => d?.role === "worker"), WORKER_TARGET)}/${WORKER_TARGET})`,
    done: state => countUnits(state, game.localOwner, d => d?.role === "worker") >= WORKER_TARGET,
  },
  { text: () => "Build a Barracks", done: state => hasCompletedBuilding(state, game.localOwner, "barracks") },
  { text: () => `Field ${COMBAT_TARGET} combat units`, done: state => countUnits(state, game.localOwner, d => d?.role === "combat") >= COMBAT_TARGET },
  { text: () => "Pick a doctrine at the Refinery", done: state => !!committedDoctrine(state, game.localOwner) },
  { text: () => "Raise a Habitat before the supply cap", done: state => hasCompletedBuilding(state, game.localOwner, "habitat") },
];

const ODYSSEY_OBJECTIVES = [
  { text: () => "Deploy the colony ship", done: state => hasCompletedBuilding(state, game.localOwner, "command") },
  { text: () => "Build a Market", done: state => hasCompletedBuilding(state, game.localOwner, "market") },
  { text: () => "Reactor → Smelter", done: state => hasCompletedBuilding(state, game.localOwner, "reactor") && hasCompletedBuilding(state, game.localOwner, "smelter") },
  { text: () => "Build a Datacenter", done: state => hasCompletedBuilding(state, game.localOwner, "datacenter") },
];

const SKIRMISH_GOAL = "Objective — destroy every enemy Command Center.";
const ODYSSEY_GOAL = "Odyssey — build an economy and win the galaxy.";

// `galaxy` is a truthy/falsy MODE signal here — the same way hud.js's own renderHUD already
// branches Odyssey-only readouts on `game.galaxy` rather than state.endless — not (yet) consulted
// for its own fields, since every predicate above is a per-planet state read.
function objectiveItems(state, galaxy) {
  const table = galaxy ? ODYSSEY_OBJECTIVES : SKIRMISH_OBJECTIVES;
  return table.map(item => ({ text: item.text(state), done: !!item.done(state, galaxy) }));
}
const sigOf = it => `${it.done ? 1 : 0}:${it.text}`;

// "Has this player already finished THIS mode's checklist in some earlier game?" — a UI-layer-only
// localStorage flag (engine/persist.js never sees it), keyed per mode since skirmish and Odyssey
// teach entirely different opening moves — finishing one shouldn't hide the other's first showing.
// Guarded like every other browser-only read in this file, so importing this module under Node
// (no `localStorage` global) never throws; storage being disabled/unavailable just means the strip
// shows every time, same as a player who's never finished it.
function objectivesDoneKey(galaxy) { return `sfObjectivesDone:${galaxy ? "odyssey" : "skirmish"}`; }
function objectivesFinishedBefore(galaxy) {
  try { return typeof localStorage !== "undefined" && localStorage.getItem(objectivesDoneKey(galaxy)) === "1"; }
  catch { return false; }
}
function markObjectivesFinished(galaxy) {
  try { if (typeof localStorage !== "undefined") localStorage.setItem(objectivesDoneKey(galaxy), "1"); }
  catch { /* storage unavailable (private browsing, some embeds) — nothing to persist, harmless */ }
}

// One checklist row: a check glyph (blank until done) + its live label. `flash` marks a row that
// just flipped to done THIS repaint (style.css .obj-row.flash), distinct from a row that was
// already done as of the last repaint.
function objectiveRow(item, flash) {
  const row = document.createElement("div");
  row.className = "obj-row" + (item.done ? " done" : "") + (flash ? " flash" : "");
  const check = document.createElement("span");
  check.className = "obj-check";
  check.textContent = item.done ? "✓" : "";
  const text = document.createElement("span");
  text.className = "obj-text";
  text.textContent = item.text;
  row.appendChild(check);
  row.appendChild(text);
  return row;
}

// The full (re)build of the strip's contents: goal line, every item row, the dismiss button. Built
// with createElement/appendChild (like showGameOver/showScenarioEnd below), not a raw innerHTML
// template, so wiring the dismiss button needs no querySelector round-trip.
function paintObjectives(galaxy, items, flashed) {
  objectivesEl.innerHTML = "";
  const goal = document.createElement("span");
  goal.className = "obj-goal";
  goal.textContent = galaxy ? ODYSSEY_GOAL : SKIRMISH_GOAL;
  objectivesEl.appendChild(goal);

  const list = document.createElement("div");
  list.className = "obj-list";
  items.forEach((item, i) => list.appendChild(objectiveRow(item, flashed[i])));
  objectivesEl.appendChild(list);

  const close = document.createElement("button");
  close.className = "obj-close";
  close.title = "Dismiss";
  close.ariaLabel = "Dismiss";
  close.textContent = "×";
  close.addEventListener("click", hideObjectives);
  objectivesEl.appendChild(close);

  objectivesEl.classList.remove("hidden");
}

// The last-painted signature (each item's done flag + its live label) and per-item done[] flags —
// together they let updateObjectives skip a repaint when nothing visible changed, and tell a row
// that just flipped to done apart from one that was already done as of the previous paint.
let lastObjSig = null;
let lastObjDone = null;

// Computes the current checklist for `state`/`galaxy` and paints it fresh — used both for the
// initial mount (showObjectives) and by any caller that wants the live item list (e.g. a test).
// Returns the computed items. If every item is ALREADY satisfied (e.g. this mode's tutorial was
// somehow finished before the strip ever got a chance to show), it retires itself immediately
// instead of mounting a fully-checked list that would otherwise never go away on its own.
export function renderObjectives(state, galaxy) {
  const items = objectiveItems(state, galaxy);
  if (items.every(it => it.done)) { markObjectivesFinished(galaxy); hideObjectives(); return items; }
  paintObjectives(galaxy, items, items.map(() => false));
  lastObjSig = items.map(sigOf).join("|");
  lastObjDone = items.map(it => it.done);
  return items;
}

// A one-time checklist at match start: a live, reactive to-do list (see renderObjectives above)
// instead of one static sentence that used to auto-dismiss after 30s whether or not the player had
// actually done anything. `endless` is accepted only for call-site compatibility with boot.js's
// existing `showObjectives(state.endless)` — by the time bootState calls this, game.state/
// game.galaxy are already the freshly-booted values, so the live pair is read straight off the
// session instead of re-deriving mode from a lone boolean.
export function showObjectives(endless = false) {
  const state = game.state;
  // The scenario bar already states a scripted mission's own objective/clock/budget; these
  // predicates (Barracks, doctrine, supply…) describe a base economy a scenario doesn't have.
  if (!state || state.scenario) return;
  if (objectivesFinishedBefore(game.galaxy)) return;   // a returning player who's already finished THIS mode's checklist doesn't need it again
  renderObjectives(state, game.galaxy);
}
export function hideObjectives() {
  objectivesEl.classList.add("hidden");
}

// Called every HUD tick (hud.js renderHUD, ~150ms cadence) to keep the checklist reactive. Cheap
// on the overwhelming majority of ticks: bails immediately when there's no strip currently shown,
// and otherwise a signature guard — each item's done flag plus its live label (e.g. "Train Workers
// (4/8)") — skips the repaint unless something a player would actually SEE has changed, the same
// guard idiom hud.js's own renderHUD uses for the resource topbar (lastTopbarSignature). Retires
// the strip itself, and remembers the completion, the moment every item is done — rather than
// waiting on the player to notice and dismiss it.
export function updateObjectives(game) {
  const state = game.state;
  if (!state || state.scenario) return;
  if (objectivesEl.classList.contains("hidden")) return;
  const galaxy = game.galaxy;
  const items = objectiveItems(state, galaxy);
  const sig = items.map(sigOf).join("|");
  if (sig === lastObjSig) return;

  const flashed = items.map((it, i) => it.done && !(lastObjDone && lastObjDone[i]));
  lastObjSig = sig;
  lastObjDone = items.map(it => it.done);

  if (items.every(it => it.done)) { markObjectivesFinished(galaxy); hideObjectives(); return; }
  paintObjectives(galaxy, items, flashed);
}

/* ---------- galaxy toast (Odyssey background-colony alerts) ---------- */

// A brief top-center notice for things happening on a world you're not on — a colony under
// attack or lost, a milestone, a relief ship (boot.js drives these). #galaxyToast is a STACK:
// up to MAX_TOASTS live at once, each with its own timer + onclick, so a routine alert can no
// longer silently overwrite a one-shot clickable one (the old single-slot behaviour lost the
// "colony has fallen — click to retake" click target for good). An optional onClick makes a
// toast actionable (jump to the world); clicking runs it and dismisses that toast, and a
// clickable alert lingers a little longer. Eviction rule at cap: drop the oldest NON-clickable
// toast; a plain toast never pushes out a clickable one (if it would have to, the plain one is
// dropped instead — it's non-critical). Same signature, so every caller is unchanged.
const MAX_TOASTS = 3;
export function showGalaxyToast(msg, kind = "warn", onClick = null) {
  const stack = galaxyToastEl;
  stack.className = "galaxy-toast-stack";   // #galaxyToast is the container; toasts are its children
  stack.classList.remove("hidden");
  const clickable = !!onClick;

  if (stack.children.length >= MAX_TOASTS) {
    const evict = [...stack.children].find(c => !c._clickable);
    if (evict) { clearTimeout(evict._timer); evict.remove(); }
    else if (!clickable) return null;                     // full of clickable alerts; don't sacrifice one for a plain toast
    else { const oldest = stack.firstElementChild; clearTimeout(oldest._timer); oldest.remove(); }
  }

  const el = document.createElement("div");
  el.className = "galaxy-toast " + kind + (clickable ? " clickable" : "");
  el.textContent = msg;
  el._clickable = clickable;
  const remove = () => { clearTimeout(el._timer); el.remove(); if (!stack.children.length) stack.classList.add("hidden"); };
  if (clickable) el.onclick = () => { remove(); onClick(); };
  el._timer = setTimeout(remove, clickable ? 8000 : 5000);
  stack.appendChild(el);
  return el;
}

/* ---------- transient UI hint ---------- */

// A brief, single-slot bottom-center hint for immediate button feedback — chiefly the touch
// "why is this greyed" tip (hud.js makeButton). Deliberately SEPARATE from the galaxy-toast
// stack: that channel is capacity-limited and protects clickable colony alerts, so routing
// button feedback through it could let a full stack of alerts swallow the tip. This one is
// user-initiated and always shows (a new hint just replaces the last).
let uiHintTimer;
export function flashHint(msg) {
  uiHintEl.textContent = msg;
  uiHintEl.classList.remove("hidden");
  clearTimeout(uiHintTimer);
  uiHintTimer = setTimeout(() => uiHintEl.classList.add("hidden"), 2600);
}

/* ---------- help overlay ---------- */

// A persistent hotkey reference, openable at ANY time (unlike the selection-panel
// legend, which is only there when nothing is selected).
const HELP_ROWS = [
  ["Left-drag", "Select units · Ctrl+drag adds to selection · Alt+drag subtracts from it"],
  ["Right-click", "Move · attack an enemy · gather a node"],
  ["Right-click and drag", "…the drag direction also becomes the group's (or a lone unit's) facing"],
  ["A, then click", "Attack-move — advance and engage on the way"],
  ["Ctrl+right-click", "Queue a waypoint (chain a path)"],
  ["1–9 / Shift+1–9", "Recall / bind a control group"],
  ["Double-click", "Select every unit of that type on screen"],
  ["Ctrl+double-click", "Select every unit of that type across the WHOLE map, not just what's on screen"],
  ["Q · E · X", "Select army · Ranger scout mode · stop"],
  ["H", "Hold position — fire in range, don't chase"],
  ["R", "Patrol — loop the current waypoint chain, engaging anything met along the way"],
  ["F", "Form up — hold the chosen formation shape right here"],
  ["Z C V B N", "Produce / build the selected panel's Nth option"],
  ["`", "Jump to the next idle worker"],
  ["Space", "Jump the camera to your base — press again quickly to cycle through every base"],
  ["Backspace", "Jump to the last under-attack alert"],
  ["P", "Pause / resume"],
  ["M", "Odyssey — open the galaxy map"],
  ["T", "Tech & Industry chart — the unlock ladder, coloured by what you can build/research now"],
  ["Right-click a node", "(building selected) rally new workers to mine it"],
  ["Minimap", "Left-click to jump · right-click to order"],
  ["Wheel · arrows · edge", "Zoom · pan the camera"],
  ["Esc", "Cancel build placement or a pending attack-move"],
  ["F1 or ?", "Toggle this help"],
];
// The finger-only control scheme (see input.js's touch handlers).
const TOUCH_HELP_ROWS = [
  ["Tap your unit", "Select it · double-tap grabs all of that type on screen"],
  ["Tap elsewhere", "Order the selection — move · tap a foe to attack · tap a node to gather"],
  ["One-finger drag", "Box-select your units"],
  ["Two fingers", "Drag to pan · pinch to zoom"],
  ["Attack-Move button", "Arm it, then tap the map to advance-and-engage"],
  ["Tap a node (building selected)", "Rally new workers to mine it"],
  ["Minimap", "Tap to jump the view"],
];
function helpRows(rows) {
  return rows.map(([k, v]) =>
    `<div class="help-row"><span class="help-key">${k}</span><span>${v}</span></div>`).join("");
}
export function buildHelpOverlay() {
  if (!helpOverlayEl) return;   // import-safe under Node (CONTRIBUTING: follow the dom.js idiom)
  helpOverlayEl.innerHTML = `<div class="help-card"><h2>Controls &amp; Help</h2>`
    + `<h3 class="help-sub">Mouse &amp; keyboard</h3>${helpRows(HELP_ROWS)}`
    + `<h3 class="help-sub">Touch</h3>${helpRows(TOUCH_HELP_ROWS)}`
    + `<p class="help-dismiss">Press F1, ?, or Esc to close</p>`
    // docs/player-handbook.html draws the full tier ladder + every stat table this quick
    // reference only summarizes — linked from nowhere else in the app before techChart.js
    // (docs/improvement-proposals.md "Tech & Industry Chart overlay"). target="_blank" so
    // opening it never navigates away from (and loses) the running match.
    + `<p class="help-manual"><a href="docs/player-handbook.html" target="_blank" rel="noopener">Full field manual ↗</a></p></div>`;
}

function toggleHelp(force) {
  const show = force ?? helpOverlayEl.classList.contains("hidden");
  helpOverlayEl.classList.toggle("hidden", !show);
  if (show) pauseLoop("help"); else resumeLoop("help");   // the sim holds while the reference is open
}
// Browser-only wiring: the help toggle button + the global F1/?/Esc/P hotkeys. Guarded so this
// module imports cleanly under Node (where the elements are null and `window` doesn't exist).
if (typeof window !== "undefined") {
  helpBtn.addEventListener("click", () => toggleHelp());
  helpOverlayEl.addEventListener("click", () => toggleHelp(false));
  window.addEventListener("keydown", e => {
    if (e.key === "F1" || e.key === "?") { e.preventDefault(); toggleHelp(); }
    else if (e.key === "Escape" && !helpOverlayEl.classList.contains("hidden")) toggleHelp(false);
    else if ((e.key === "p" || e.key === "P") && !e.ctrlKey && !e.metaKey) { e.preventDefault(); togglePause(); }
  });
}

/* ---------- game-over overlay ---------- */

// Skirmish/scenario copy, keyed by engine/victory.js's state.winReason — so this screen stops
// always claiming a conquest that may not have happened (docs/improvement-proposals.md "Make the
// clock endgame visible, honest, and configurable"). A missing/unrecognised reason (an older save
// resuming into a game-over some other way, or any caller that predates this field) falls back to
// the original conquest copy below, unchanged.
// T-030: keyed by "you"/"them" (relative to game.localOwner), not the literal winner's owner id —
// this table's whole POINT is text written from the local viewer's own point of view ("Victory",
// "your last Command Center"), which a literal-owner key silently gets backwards the moment the
// local seat isn't "player": WIN_REASON_COPY[reason]["ai"] used to mean "the ai LOST", which is
// only true when the local viewer IS "player" — for seat B's own screen, a win keyed "ai" would
// have rendered as a "Defeat" message. See showGameOver's own lookup below.
const WIN_REASON_COPY = {
  elimination: {
    you: "Victory — the enemy's last Command Center is destroyed.",
    them: "Defeat — your last Command Center was destroyed.",
  },
  "mutual-wipe-score": {
    you: "Victory — both sides' last Command Centers fell, and you held the higher score.",
    them: "Defeat — both sides' last Command Centers fell, and the enemy held the higher score.",
  },
  "timeout-score": {
    you: "Victory — the match went the distance, and you held the higher score at the bell.",
    them: "Defeat — the match went the distance, and the enemy held the higher score at the bell.",
  },
};

// The end-of-match overlay: a terminal overlay like the objectives/help ones, so
// it lives here rather than with the live HUD readouts (it shares no code with
// them). Param-driven — the seed and the restart action are passed in, so this
// module needs neither the session nor setup.js (onRestart re-opens map-select).
// opts.winReason + opts.state (engine/victory.js's state.winReason, and the state itself for the
// score breakdown below) are optional: an Odyssey game-over never sets either, and a caller that
// predates this feature simply gets the old conquest-copy default.
export function showGameOver(winner, seed, onRestart, opts = {}) {
  // A SPECTATED AI-vs-AI match (docs/competitions-and-elo.md Phase 5) has no "you" in it: the
  // human watched two AI entrants play. Neither the fanfare nor the funeral is right, so it gets
  // silence and its own verdict line below — every other caller is byte-identical to before.
  if (opts.spectate) { /* no verdict sound: the watcher neither won nor lost this */ }
  else if (winner === game.localOwner) sound.playVictory(); else sound.playDefeat();

  gameOverEl.classList.remove("hidden");
  gameOverEl.innerHTML = "";

  // The Odyssey is a play-forever sandbox — it never ends in defeat, only by surrender (a
  // wipeout sends a relief colony ship instead). So an Odyssey game-over is always a surrender.
  // Skirmish/scenario keep the win-or-lose copy, now branched on WHY it ended.
  const msg = document.createElement("div");
  msg.textContent = opts.spectate
    ? opts.spectate.verdict   // "<entrant> wins…" — named, never "Victory"/"Defeat" (see above)
    : opts.odyssey
    ? (opts.surrendered
        ? "Surrendered — you lay down your flag. The frontier falls quiet."
        : "The Odyssey has ended.")
    : (WIN_REASON_COPY[opts.winReason]?.[winner === game.localOwner ? "you" : "them"]
        ?? (winner === game.localOwner
            ? "Victory — the enemy's last Command Center is destroyed."
            : "Defeat — your last Command Center was destroyed."));
  gameOverEl.appendChild(msg);

  // A SCORE decision (as opposed to conquest) gets a small breakdown — same "gameover-seed" div
  // idiom showScenarioEnd's own BREAKDOWNS use below — so "why did the clock decide this" is
  // answerable on screen, not just asserted. Conquest (winReason "elimination") shows none: the
  // score math had nothing to do with that outcome. Shown from the human player's own numbers,
  // alongside the enemy's final score for direct comparison.
  // …and never for a spectated match: this breakdown is written from "your"/"enemy"'s point of
  // view, which has no referent when the human played neither seat. The spectate block below
  // carries both entrants' scores side by side instead, named.
  if (!opts.odyssey && !opts.spectate && opts.state && (opts.winReason === "mutual-wipe-score" || opts.winReason === "timeout-score")) {
    const bd = scoreBreakdown(opts.state, game.localOwner);
    const enemyScore = playerScore(opts.state, otherOwner(game.localOwner));
    const breakdown = document.createElement("div");
    breakdown.className = "gameover-seed";
    breakdown.innerHTML = `Bank (×0.25): ${Math.round(bd.bank)} · Army (×1.35): ${Math.round(bd.army)} · Structures: ${Math.round(bd.structures)}`
      + `<br>Your score: <b>${Math.round(bd.total)}</b> · Enemy score: <b>${Math.round(enemyScore)}</b>`;
    gameOverEl.appendChild(breakdown);
  }

  if (seed != null) {
    const seedLine = document.createElement("div");
    seedLine.className = "gameover-seed";
    seedLine.textContent = `Seed ${seed} — enter it on the setup screen to replay this map.`;
    gameOverEl.appendChild(seedLine);
  }

  // A COMPETITION fixture's outcome (docs/competitions-and-elo.md Phase 4), when this match was
  // one: what it did to the ladder, the seat disclosure that qualifies that rating (D4), and the
  // next fixture with a button that boots it. Absent — the case for every ordinary skirmish — this
  // whole block is skipped and the screen is exactly what it always was.
  //
  // Rendered from a PLAIN DATA OBJECT with its actions injected as callbacks, the same param-driven
  // discipline the rest of this function already holds to (see its header): overlays.js still needs
  // neither the session, nor setup.js, nor competition.js to show a competition result.
  if (opts.competition) renderCompetitionResult(opts.competition);
  // A watched match's own block — the two entrants' scores, the exhibition-only disclosure, and a
  // route back to the Competition screen. Rendered through the SAME plain-data block renderer:
  // the two blocks say different things but have identical structure, and a second near-copy of
  // it would be the thing that drifts.
  else if (opts.spectate && opts.spectate.block) renderCompetitionResult(opts.spectate.block);

  // MIRROR ME — turn the game that just finished into an AI that plays the way you just played
  // (playerFingerprint.js). Offered only where there is a "you" to measure: never on a spectated
  // AI-vs-AI match, and only once the match actually carried a state to read.
  //
  // Downloads the genome as a candidate file rather than adding it to the competition roster,
  // because competitionLedger.js's addRosterEntry validates `strategy` against KNOWN_STRATEGIES —
  // a roster entry cannot yet CARRY a genome, only name a shipped one, so storing it there would
  // silently flatten the mirror back to "default". Making the ledger carry a genome is the next
  // stage; until then the file drops straight into `ailab duel` and into Import Ladder later.
  if (!opts.spectate && opts.state) {
    const mirrorBtn = document.createElement("button");
    mirrorBtn.className = "btn";
    mirrorBtn.style.width = "auto";
    mirrorBtn.style.padding = "10px 20px";
    mirrorBtn.style.marginTop = "16px";
    mirrorBtn.textContent = "\u29c9 Save an AI that plays like you";
    mirrorBtn.title = "Measures what you built this match — economy vs army, your unit mix, how far "
      + "you expanded — and fits an AI genome to it.";
    mirrorBtn.addEventListener("click", () => {
      try {
        // T-030: owner passed explicitly — playerFingerprint.js's own default stays "player" on
        // purpose (that module is deliberately pure/session-free, workable from a Worker with no
        // game.localOwner to read), so "measure the LOCAL viewer's own play" is this caller's job.
        const { candidate, fingerprint } = mirrorOfPlayer(opts.state, { owner: game.localOwner, name: "Your Mirror" });
        const note = fingerprint.posture == null ? "no assets to measure"
          : `${Math.round((1 - fingerprint.posture) * 100)}% economy, ${fingerprint.army} army, `
            + `${fingerprint.workers} workers${fingerprint.mix.length ? `, built ${fingerprint.mix.join("/")}` : ""}`;
        const blob = new Blob([JSON.stringify({ ...candidate, _hypothesis: `Mirror of a human game: ${note}.` }, null, 2)],
          { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "your-mirror.json";
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        mirrorBtn.textContent = `\u2713 Saved — ${note}`;
        mirrorBtn.disabled = true;
      } catch (err) {
        mirrorBtn.textContent = `Couldn't build a mirror: ${err.message}`;
      }
    });
    gameOverEl.appendChild(mirrorBtn);
  }

  const again = document.createElement("button");
  again.className = "btn";
  again.style.width = "auto";
  again.style.padding = "10px 20px";
  again.style.marginTop = "16px";
  again.textContent = "Choose another battlefield";
  again.addEventListener("click", () => {
    gameOverEl.classList.add("hidden");
    onRestart();
  });
  gameOverEl.appendChild(again);
}

/**
 * The competition block inside showGameOver above — deliberately part of THAT screen rather than a
 * second overlay of its own: what the player needs after a gauntlet match is the ordinary
 * victory/defeat verdict AND what it cost or earned them, read together. A separate screen would
 * either hide the win/loss copy or repeat it. Also renders a SPECTATED match's exhibition block
 * (Phase 5), which has the same shape — a title, an outcome line, a note, and a way back.
 * @param {{ title?: string, outcome?: string, ratingLine?: string, error?: string,
 *   disclosure?: string, standing?: string, nextLabel?: string, onNext?: Function,
 *   viewLabel?: string, onView?: Function }} comp
 */
function renderCompetitionResult(comp) {
  const box = document.createElement("div");
  box.className = "gameover-comp";
  const line = (text, cls) => {
    if (!text) return;
    const el = document.createElement("div");
    el.className = cls;
    el.textContent = text;   // textContent, never innerHTML: an entrant name is free-typed input
    box.appendChild(el);
  };
  line(comp.title, "gameover-comp-title");
  line(comp.outcome, "gameover-comp-outcome");
  line(comp.ratingLine, "gameover-comp-rating");
  line(comp.standing, "gameover-comp-standing");
  line(comp.error, "gameover-comp-error");
  line(comp.disclosure, "gameover-comp-note");

  const actions = document.createElement("div");
  actions.className = "gameover-comp-actions";
  const act = (label, fn, cls) => {
    if (!label || !fn) return;
    const b = document.createElement("button");
    b.className = "btn" + (cls ? " " + cls : "");
    b.textContent = label;
    // Hiding the overlay here (not inside the callback) keeps every exit from this screen
    // consistent with the "Choose another battlefield" button just below it.
    b.addEventListener("click", () => { gameOverEl.classList.add("hidden"); fn(); });
    actions.appendChild(b);
  };
  act(comp.nextLabel, comp.onNext, "primary");
  act(comp.viewLabel, comp.onView);
  if (actions.children.length) box.appendChild(actions);

  gameOverEl.appendChild(box);
}

// The mission-end screen for a scenario (engine/scenarios.js) — its own screen
// rather than showGameOver, because it reports the objective + a score breakdown.
export function showScenarioEnd(state, onRestart) {
  const sc = state.scenario;
  if (sc.outcome === "win") sound.playVictory(); else sound.playDefeat();

  gameOverEl.classList.remove("hidden");
  gameOverEl.innerHTML = "";

  const win = sc.outcome === "win";
  const TITLES = {
    raider: win ? "Raid Successful" : "Convoy Escaped",
    bounty: win ? "Bounties Claimed" : "Quota Not Met",
    escort: win ? "Convoy Delivered" : "Convoy Lost",
  };
  const title = document.createElement("div");
  title.textContent = TITLES[sc.type] || TITLES.escort;
  gameOverEl.appendChild(title);

  const banner = document.createElement("div");
  banner.className = "gameover-seed";
  banner.textContent = sc.banner;
  gameOverEl.appendChild(banner);

  const BREAKDOWNS = {
    raider: `Freighters sunk: ${sc.destroyed}/${sc.freightersTotal} (quota ${sc.targetKills}) · Escorts destroyed: ${sc.escortsKilled}`
      + ` · Raiders surviving: ${sc.survivors}<br>Final score: <b>${sc.score}</b>`,
    bounty: `Camps cleared: ${sc.packsCleared}/${sc.totalPacks} (quota ${sc.targetPacks}) · Bounty banked: 💰 ${sc.bounty}`
      + ` · Posse surviving: ${sc.survivors}<br>Final score: <b>${sc.score}</b>`,
    escort: `Freighters delivered: ${sc.delivered}/${sc.freightersTotal} · Legs cleared: ${sc.legsDone}`
      + ` · Budget left: ${Math.round(sc.budget)}<br>Final score: <b>${sc.score}</b>`,
  };
  const breakdown = document.createElement("div");
  breakdown.className = "gameover-seed";
  breakdown.innerHTML = BREAKDOWNS[sc.type] || BREAKDOWNS.escort;
  gameOverEl.appendChild(breakdown);

  const again = document.createElement("button");
  again.className = "btn";
  again.style.width = "auto";
  again.style.padding = "10px 20px";
  again.style.marginTop = "16px";
  again.textContent = "Back to menu";
  again.addEventListener("click", () => {
    gameOverEl.classList.add("hidden");
    onRestart();
  });
  gameOverEl.appendChild(again);
}
