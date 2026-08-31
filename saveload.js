/* ============================================================
   Save / load. Because the sim is deterministic and seed-driven, a save is just
   the serialized dynamic state (engine/persist.js); the map regenerates from the
   seed on load. Two channels, by design:

     • The topbar Save / Load buttons move a save to and from a FILE — an explicit
       backup/transfer you keep on disk (download a .json, or pick one to import).
     • AutoSave keeps the CURRENT game in browser localStorage on a timer (and on
       tab-hide / unload), so the map-select "Continue" buttons (setup.js) can
       resume exactly where you left off without any manual save. Two GENERATIONS
       are kept per mode (KEY + the rotated-out KEY+'.prev'), not one overwritten
       slot: loadGame/loadOdyssey fall back to '.prev' if the primary fails to
       deserialize, so a single corrupt/interrupted write can't lose the campaign.

   Both channels branch on the mode: a skirmish is a single state (SAVE_KEY /
   serializeGame); an Odyssey is the whole galaxy (ODYSSEY_KEY / serializeGalaxy).
   A file import auto-detects which by shape (a galaxy carries `planets`).
   ============================================================ */

"use strict";

import { game } from "./session.js";
import { saveBtn, loadBtn, homeBtn } from "./dom.js";
import { serializeGame, serializeGameString, deserializeGame, serializeGalaxy, serializeGalaxyString, deserializeGalaxy } from "./engine/persist.js";
import { bootState, bootGalaxy, restartToMapSelect, pauseLoop, resumeLoop } from "./boot.js";
import { isGalaxySave, resumableMode } from "./saveShape.js";
import { showGalaxyToast } from "./overlays.js";
import { liveCompetitionFixture, forfeitLiveCompetitionMatch } from "./competition.js";
import * as sound from "./sound.js";
// ADR-0003/ADR-0004 (T-012): a resumed skirmish runs behind a real session too, exactly like a
// freshly started one (boot.js's startGame) — createSession({state}) wraps the ALREADY-
// deserialized state as-is instead of building a fresh one (server/session.js's own header on
// that option), since there is no seed/rng left to rebuild it from.
import { createSession } from "./server/session.js";
import { createLoopbackTransport } from "./net/loopback.js";

const SAVE_KEY = "stellarfrontier.save.v1";
const ODYSSEY_KEY = "stellarfrontier.odyssey.v1";
// The previous-generation localStorage slot for either key: KEY + PREV_SUFFIX. autoSave rotates
// the current primary into this slot before writing a fresh one (writeGeneration below), so one
// corrupt/quota-failed write — or a save that lands at a genuinely bad moment — still leaves last
// cycle's good save one fallback away (loadGame/loadOdyssey below) instead of losing the whole
// campaign, as used to happen when a single slot was overwritten every 12 seconds.
const PREV_SUFFIX = ".prev";
const AUTOSAVE_INTERVAL_MS = 12000;   // how often the current game is checkpointed to localStorage
const MAX_SAVE_BYTES = 8 * 1024 * 1024;   // reject an implausibly large import before parsing it (a real save is ≪ this)

const read = key => { try { return localStorage.getItem(key); } catch (e) { return null; } };

// True the instant EITHER generation exists — a `.prev`-only save (the primary write failed most
// recently, but last cycle's landed fine) should still offer "Continue": loadGame/loadOdyssey below
// try both generations too, so this stays consistent with what they can actually resume.
export function hasSave() { return !!read(SAVE_KEY) || !!read(SAVE_KEY + PREV_SUFFIX); }
export function hasOdysseySave() { return !!read(ODYSSEY_KEY) || !!read(ODYSSEY_KEY + PREV_SUFFIX); }

// The save-format version of each stored save (null when absent/unparseable) — used by the
// update check (version.js saveImpact) to tell the player whether a new release keeps their data.
// Prefers the primary generation; falls back to `.prev`'s version when the primary is missing or
// unparseable, so this reports exactly what loadGame/loadOdyssey would actually resume.
export function storedSaveVersions() {
  const ver = raw => { try { const o = JSON.parse(raw); return typeof o?.v === "number" ? o.v : null; } catch (e) { return null; } };
  const versionOf = key => {
    const v = ver(read(key));
    return v != null ? v : ver(read(key + PREV_SUFFIX));
  };
  return { skirmish: versionOf(SAVE_KEY), odyssey: versionOf(ODYSSEY_KEY) };
}

/* ---------- localStorage: the automatic checkpoint (resume) ---------- */

// Serialize the current game to a plain object, by mode — or null when there's
// nothing resumable (no game, a finished one, or a scripted scenario, which can't
// be saved). One place both channels agree on what "the current game" is.
function snapshot() {
  const mode = resumableMode(game);
  if (!mode) return null;
  // The JSON STRING directly (serialize*String) — autoSave writes it straight to localStorage,
  // so the fog-heavy payload is stringified once, not stringify→parse→stringify.
  return mode === "galaxy"
    ? { key: ODYSSEY_KEY, str: serializeGalaxyString(game.galaxy) }
    : { key: SAVE_KEY, str: serializeGameString(game.state) };
}

// Write a fresh generation to `key`, rotating whatever's currently there into `key + PREV_SUFFIX`
// FIRST — so loadGame/loadOdyssey below always have last cycle's good save to fall back to if
// this write lands badly (corrupt, or interrupted) or the next one does. A setItem quota throw —
// from either the rotation write or the fresh one — is met with exactly ONE retry: drop the
// `.prev` backup (freeing its space) and write the primary alone, so a nearly-full quota can never
// let the backup starve the primary out of ever being written at all.
function writeGeneration(key, str) {
  const prevKey = key + PREV_SUFFIX;
  try {
    const current = localStorage.getItem(key);
    if (current != null) localStorage.setItem(prevKey, current);
    localStorage.setItem(key, str);
    return true;
  } catch (e) {
    try {
      localStorage.removeItem(prevKey);
      localStorage.setItem(key, str);
      return true;
    } catch (e2) { return false; }
  }
}

// Checkpoint the current game to localStorage. Cheap and safe to call often. Returns
// true on a successful write, false when there's nothing to save OR the write throws
// (quota exceeded, or Safari/Firefox private mode where setItem always throws). The
// periodic caller counts consecutive failures (recordAutoSaveOutcome below) toward a
// one-time warning; "Save & Exit" checks the return value directly, because silently
// swallowing a failure there would tell the player their game was checkpointed and then
// strand them with nothing to Continue.
export function autoSave() {
  const snap = snapshot();
  if (!snap) return false;
  return writeGeneration(snap.key, snap.str);
}

// Parse + deserialize a raw localStorage string with `deserialize`, returning the live object or
// null if either step throws — corrupt JSON, an unsupported save version, or anything
// sanitizeSave/cleanEntity rejects (engine/persist.js). The shared "try it, or don't" shape
// loadGame/loadOdyssey below use for both the primary generation and its `.prev` fallback.
function tryDeserialize(raw, deserialize) {
  if (!raw) return null;
  try { return deserialize(JSON.parse(raw)); }
  catch (e) { return null; }
}

// Resume the autosaved Odyssey galaxy from localStorage (topbar-less; used by the setup "Continue
// Odyssey" button). Tries the primary generation first, then falls back to `.prev` (written by
// writeGeneration above) if the primary is missing, corrupt, or fails to deserialize — so one bad
// write doesn't strand the whole campaign the way a single overwritten slot used to.
export function loadOdyssey() {
  const primaryRaw = read(ODYSSEY_KEY), prevRaw = read(ODYSSEY_KEY + PREV_SUFFIX);
  if (!primaryRaw && !prevRaw) { flashButton(loadBtn, "No save"); return; }
  const galaxy = tryDeserialize(primaryRaw, deserializeGalaxy) || tryDeserialize(prevRaw, deserializeGalaxy);
  if (!galaxy) { flashButton(loadBtn, "Load failed"); return; }
  sound.unlockAudio();
  bootGalaxy(galaxy, { intro: false });
}

// Resume the autosaved skirmish from localStorage (setup "Continue" button). Same primary-then-
// `.prev` fallback as loadOdyssey above.
export function loadGame() {
  const primaryRaw = read(SAVE_KEY), prevRaw = read(SAVE_KEY + PREV_SUFFIX);
  if (!primaryRaw && !prevRaw) { flashButton(loadBtn, "No save"); return; }
  const state = tryDeserialize(primaryRaw, deserializeGame) || tryDeserialize(prevRaw, deserializeGame);
  if (!state) { flashButton(loadBtn, "Load failed"); return; }
  sound.unlockAudio();
  const session = createSession({ state });
  bootState(session.getState(), { intro: false, transport: createLoopbackTransport(session) });
}

/* ---------- file: the explicit backup/transfer (Save / Load buttons) ---------- */

function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function downloadJSON(filename, obj) {
  const blob = new Blob([JSON.stringify(obj)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Save button — download the current game as a .json file (galaxy or skirmish).
function saveToFile() {
  try {
    if (game.galaxy) {
      downloadJSON(`stellar-frontier-odyssey-${stamp()}.json`, serializeGalaxy(game.galaxy));
    } else if (game.state) {
      downloadJSON(`stellar-frontier-skirmish-seed${game.state.seed}-${stamp()}.json`, serializeGame(game.state));
    } else { flashButton(saveBtn, "No game"); return; }
    flashButton(saveBtn, "Saved ✓");
  } catch (e) { flashButton(saveBtn, "Save failed"); }
}

// Boot a parsed save, auto-detecting the mode by shape — a galaxy carries `planets`.
function importSave(parsed) {
  sound.unlockAudio();
  if (isGalaxySave(parsed)) bootGalaxy(deserializeGalaxy(parsed), { intro: false });
  else {
    const session = createSession({ state: deserializeGame(parsed) });
    bootState(session.getState(), { intro: false, transport: createLoopbackTransport(session) });
  }
}

// Load button — open a file picker and import the chosen .json save.
function loadFromFile() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json,.json";
  input.addEventListener("change", () => {
    const file = input.files && input.files[0];
    if (!file) return;
    if (file.size > MAX_SAVE_BYTES) { flashButton(loadBtn, "File too large"); return; }   // bound before we parse it
    const reader = new FileReader();
    reader.onload = () => {
      // JSON.parse first (never eval), then deserialize sanitizes the shape (engine/persist.js).
      try { importSave(JSON.parse(reader.result)); }
      catch (e) { flashButton(loadBtn, "Load failed"); }
    };
    reader.onerror = () => flashButton(loadBtn, "Load failed");
    reader.readAsText(file);
  });
  input.click();
}

function flashButton(btn, msg) {
  if (!btn) return;
  const original = btn.dataset.label || btn.textContent;
  btn.dataset.label = original;
  btn.textContent = msg;
  clearTimeout(btn._flashTimer);
  btn._flashTimer = setTimeout(() => { btn.textContent = btn.dataset.label; }, 1100);
}

// Home button — return to the menu, first asking whether to keep progress. A scenario
// can't be resumed, so it's a plain "leave?" confirm there; a skirmish/Odyssey offers
// "Save & Exit", which checkpoints to localStorage so the setup "Continue" button can
// pick it up. A lightweight modal built on the fly (Cancel / backdrop / Esc dismiss it).
function goHome() {
  const scenario = !!(game.state && game.state.scenario);
  // A live COMPETITION fixture (docs/competitions-and-elo.md Phase 4) is the third case, and it
  // changes what leaving MEANS: abandoning a gauntlet match records a forfeit — a rated loss —
  // rather than silently dropping the fixture, and the player has to be told that before it
  // happens, which is exactly what this dialog is for. It is also deliberately NOT offered a
  // "Save & Exit": game.competition isn't part of the save, so a resumed autosave would be an
  // ordinary skirmish that no longer belongs to any run, which is a worse outcome than an honest
  // forfeit.
  const fixture = liveCompetitionFixture();
  // …and a WATCHED or REPLAYED match (Phase 5) is the fourth, for the stronger reason saveShape.js's
  // resumableMode already gives: it isn't the player's game at all. This button is visible in EVERY
  // mode, so without a branch of its own the dialog fell back to the ordinary skirmish copy — which
  // PROMISED a checkpoint ("Your progress autosaves…") that resumableMode refuses to write, and
  // offered "Save & Exit" as the default-focused primary. Clicking it got false back from autoSave()
  // and fell through to a FILE download of the AI-vs-AI match: a plain skirmish save that loads back
  // handing the human full command of one entrant's army (exactly what observer.js's
  // requestExitObserverMode refuses mid-match), flashing "Saved ✓" on a Save button hud.js has
  // hidden, without leaving. So: no Save & Exit, honest copy, a plain Leave.
  const watching = game.spectateMatch;

  const overlay = document.createElement("div");
  overlay.className = "home-confirm";
  const card = document.createElement("div");
  card.className = "home-card";
  // The card is the semantic dialog: it's the focus-bounded box with the heading, body
  // text, and actions — the overlay is just the click-to-dismiss backdrop behind it.
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.tabIndex = -1;   // focusable as a fallback landing spot if there's ever no button to focus
  const h = document.createElement("h2");
  h.id = "home-confirm-title";
  h.textContent = fixture ? "Forfeit this gauntlet match?"
    : watching ? (watching.recorded ? "Stop replaying this match?" : "Stop watching this match?")
    : scenario ? "Leave the mission?" : "Return to the menu?";
  card.setAttribute("aria-labelledby", h.id);
  const p = document.createElement("p");
  p.textContent = fixture
    ? `Leaving now records a LOSS to ${fixture.opponent} in your gauntlet, rated exactly like a match you played and lost. `
      + "A competition match can't be saved and resumed."
    : watching
      // The same two facts the spectate bar shows all match long, restated at the moment of leaving:
      // whose match this is, and that nothing is riding on it either way. A replay says the sharper
      // version — its result is already on the ladder, so re-running it records nothing by design.
      ? `${watching.aName} vs ${watching.bName} is a match between two AI entrants — you command neither seat, `
        + "so there's nothing here to save. "
        + (watching.recorded
          ? "This match is already on the ladder; re-running it records nothing."
          : "Nothing is recorded either way.")
    : scenario
      ? "A scenario can't be saved — leaving abandons this run."
      : "Your progress autosaves — Save & Exit checkpoints it now so you can Continue later.";
  const actions = document.createElement("div");
  actions.className = "home-actions";
  card.append(h, p, actions);
  overlay.appendChild(card);

  // Focus management: remember whatever had focus (the Home button, typically) so it can be
  // restored on close, and move focus into the dialog on open per WAI-ARIA dialog pattern.
  const previouslyFocused = document.activeElement;
  pauseLoop("home");   // hold the sim while the leave-confirm modal is up
  const close = () => {
    resumeLoop("home"); overlay.remove(); window.removeEventListener("keydown", onKey);
    if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
  };
  const onKey = e => { if (e.key === "Escape") { e.preventDefault(); close(); } };
  const act = (label, fn, cls) => {
    const b = document.createElement("button");
    b.className = "btn" + (cls ? " " + cls : "");
    b.textContent = label;
    b.addEventListener("click", () => { close(); fn(); });
    actions.appendChild(b);
  };

  // Save & Exit only leaves once the checkpoint actually lands. If localStorage is
  // unavailable (quota / private mode) we DON'T pretend it saved and exit into a lost
  // game — we fall back to a file download and keep the player in-game so nothing is lost.
  // Offered for the two modes that can actually be resumed; the other three each get their own
  // single primary below, because for them there is no checkpoint to write in the first place.
  if (!scenario && !fixture && !watching) act("Save & Exit", () => {
    if (autoSave()) restartToMapSelect();
    else saveToFile();
  }, "primary");
  if (fixture) act("Forfeit & Exit", () => { forfeitLiveCompetitionMatch(); restartToMapSelect(); }, "primary");
  // One way out of a watched match, not two: the callback its launcher parked on game.spectateMatch
  // is the same route the spectate bar's own Leave button takes (observerPanel.js), so ⌂ Home lands
  // back on the Competition screen it came from rather than inventing a second destination. The
  // fallback covers a launcher that parked none — restartToMapSelect clears spectateMatch itself.
  else if (watching) act("Leave", () => { if (watching.onLeave) watching.onLeave(); else restartToMapSelect(); }, "primary");
  else act(scenario ? "Leave" : "Exit without Saving", () => restartToMapSelect(), scenario ? "primary" : "");
  act("Cancel", () => {}, "ghost");

  overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
  window.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);
  (actions.querySelector("button") || card).focus();   // first actionable button, or the card itself
}

if (saveBtn) saveBtn.addEventListener("click", saveToFile);
if (loadBtn) loadBtn.addEventListener("click", loadFromFile);
if (homeBtn) homeBtn.addEventListener("click", goHome);

// Consecutive autoSave() failures the PERIODIC timer has observed — NOT the visibilitychange/
// beforeunload calls below, which each fire once at a moment the player is already leaving (a
// toast then would go unseen, and a tab-hide/close is exactly the moment a save is most likely to
// race something else anyway). After AUTOSAVE_FAIL_TOAST consecutive failures, surface it exactly
// ONCE per session: silent, repeated failure otherwise means a corrupt/full-quota/private-mode
// browser quietly strands the player with nothing to Continue, discovered only when they come back
// and "Continue" has nothing (see this file's own header). A later success resets the STREAK (a
// fresh run of failures needs AUTOSAVE_FAIL_TOAST in a row again to re-warrant concern) but never
// re-arms the one-time flag — this is a "your autosave is unreliable" notice, not a per-incident
// alert that would nag on every transient blip.
const AUTOSAVE_FAIL_TOAST = 3;
let autoSaveFailStreak = 0;
let autoSaveFailToastShown = false;

// Record one autoSave() outcome from the periodic timer; returns true exactly once — the instant
// the streak first reaches AUTOSAVE_FAIL_TOAST consecutive failures — so the caller knows to show
// the toast right then. Pure bookkeeping, no DOM: exported so the threshold/one-time behavior is
// directly testable without a real localStorage or toast-stack element.
export function recordAutoSaveOutcome(ok) {
  if (ok) { autoSaveFailStreak = 0; return false; }
  autoSaveFailStreak++;
  if (autoSaveFailStreak === AUTOSAVE_FAIL_TOAST && !autoSaveFailToastShown) {
    autoSaveFailToastShown = true;
    return true;
  }
  return false;
}

// Keep the current game checkpointed without any manual step: on a timer, whenever the
// tab is hidden (task-switch / phone lock), and on unload (tab close / refresh). These
// are the writes the setup "Continue" buttons read back. Guarded so importing this module
// under Node (to unit-test its pure logic) doesn't start a real autosave timer or touch a
// non-existent `window` — the whole block is browser-only wiring.
if (typeof window !== "undefined") {
  setInterval(() => {
    // "Nothing to save" is NOT a failure, and must never feed the failure streak. autoSave()
    // returns false for two unrelated reasons — no resumable game, or a write that actually threw
    // — and conflating them meant sitting on any menu screen for three intervals (36s) raised a
    // red "Autosave is failing" banner while localStorage was perfectly healthy. Rare before the
    // Competition screens existed (nobody idled on the splash that long); constant once a
    // tournament keeps you on a menu screen for minutes at a time, which is how this surfaced.
    // Checked here rather than inside autoSave() so its documented return contract is untouched:
    // "Save & Exit" still needs false to mean "did not save" for BOTH reasons, since either one
    // leaves the player with nothing to Continue.
    if (!resumableMode(game)) return;
    if (recordAutoSaveOutcome(autoSave())) {
      showGalaxyToast("Autosave is failing — use Save to export a file.", "bad");
    }
  }, AUTOSAVE_INTERVAL_MS);
  window.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") autoSave(); });
  window.addEventListener("beforeunload", autoSave);
}
