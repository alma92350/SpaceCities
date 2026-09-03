/* ============================================================
   The running game session: startGame (fresh) and bootState (fresh OR loaded)
   wire a state to input, the camera, the fixed-timestep loop and the HUD; the
   render loop also pumps this frame's sim events into sound + visual effects and
   the under-attack alert. Split out of main.js — `state`/`input` now live on the
   shared session (session.js); the loop reads them live so a restart is picked
   up automatically (the previous loop is always stopped first).
   ============================================================ */

"use strict";

import { game } from "./session.js";
import { canvas, ctx, minimapCtx, mapSelectEl, gameOverEl, underAttackEl, pauseBtn, MINIMAP_W, MINIMAP_H } from "./dom.js";
import { mulberry32 } from "./engine/rng.js";
import { createLoop } from "./engine/loop.js";
import { tick } from "./engine/sim.js";
// ADR-0003/ADR-0004 (T-012): an ordinary skirmish, a live competition fixture, and a loaded
// skirmish save now run their sim behind a real server/session.js session, reached over
// net/loopback.js exactly like multiplayer will reach it over a socket — see startGame and
// startCompetitionMatch below. Odyssey, a scenario/raider/bounty, and a spectated match are
// deliberately NOT ported by this pass (TASKS.md T-012's own scoping: they keep ticking on
// their existing stepGalaxy/tickSelfPlay/tick path); createDirectTransport is what still lets
// their OWN input handling and HUD buttons call transport.submitCommand(cmd) uniformly, same as
// every other boot path, without a session behind them.
import { createSession } from "./server/session.js";
import { createLoopbackTransport } from "./net/loopback.js";
import { createDirectTransport } from "./net/directTransport.js";
// The self-play core (docs/competitions-and-elo.md Phase 0 made it browser-importable): the ONE
// way a spectated match gets both of its seats driven by the real AI — createSelfPlayState builds
// the state with a second controller for owner "player", tickSelfPlay runs it before the ordinary
// tick() that already drives owner "ai".
import { createSelfPlayState, tickSelfPlay, SELFPLAY_HZ } from "./tools/selfplay.js";
import { archetypeFor } from "./engine/aiArchetypes.js";
import { isVisibleAt } from "./engine/fog.js";
import { drawFrame, resetFacing, snapshotPositions } from "./render.js";
import { drawMinimap } from "./minimap.js";
import { clampCamera } from "./camera.js";
import { attachInput } from "./input.js";
import { addTracer, addDeathFlash, addUnderAttackPing, addFireworks, addExplosion, addFuseWarning, activePings, resetEffects, DEATH_BASE_RADIUS } from "./effects.js";
import { UNITS, BUILDINGS } from "./engine/entities.js";
import { renderHUD, resetPanelSignature } from "./hud.js";
import { observedState, exitObserverMode, enterObserverMode } from "./observer.js";
import { renderObserverPanel } from "./observerPanel.js";
import { hideChatPanel } from "./chat.js";
import { showObjectives, hideObjectives, showSeedChip, showFactionChip, showGameOver, showScenarioEnd, showGalaxyToast } from "./overlays.js";
import { renderMapSelect, setup, DIFFICULTY_OPTIONS } from "./setup.js";
import { captureCompetitionResult, spectatedGameOverBlock } from "./competition.js";
import { setupEscort, setupRaider, setupBounty } from "./engine/scenarios.js";
import { createGalaxy, activeState, jumpCapital, sweepColonies, stepGalaxy, surrenderGalaxy, DOMINATION_TARGET, playerSpaceports, previewPlanet, canJump, canJumpTo, jumpCost } from "./engine/galaxy.js";
import { openLandingPicker } from "./landingPicker.js";
import { TECHS } from "./engine/techtree.js";
import { planetName, COM } from "./data.js";
import * as sound from "./sound.js";

const UNDER_ATTACK_THROTTLE_MS = 4000;
const UNDER_ATTACK_BANNER_MS = 2500;

// Difficulty → the two AI dials, looked up in setup.js's DIFFICULTY_OPTIONS — the
// single list that also drives the Easy/Medium/Hard picker, so a difficulty key
// can't exist in one list and not the other (previously boot.js kept its own
// separate easy/medium/hard map; if the two ever drifted, an unrecognised key
// silently fell back to Medium instead of erroring). Computed lazily (not at
// module top level) because setup.js and boot.js import each other — by the
// time this runs, both modules have finished loading.
function difficultyDials(key) {
  const opt = DIFFICULTY_OPTIONS.find(o => o.mult === key) || DIFFICULTY_OPTIONS.find(o => o.mult === "medium");
  return { aiApm: opt.aiApm, aiMicro: opt.aiMicro };
}

// Resolve the seed to actually run with: the setup screen's explicit pick, or a
// fresh random one (Math.random is fine here — it's not the sim; everything
// downstream flows from the seeded mulberry32, so same seed => same world), coerced
// to an unsigned 32-bit int either way. One helper for every start* path (skirmish,
// the three scenarios, Odyssey) so they can never disagree on how a seed is drawn.
function resolveSeed(cfg) {
  return (cfg.seed != null ? cfg.seed : Math.floor(Math.random() * 0x100000000)) >>> 0;
}

// Runtime bookkeeping — module-local because only the loop / frame-event pump
// touch them (state + input live on the shared session instead).
let loop, announced, lastHud, lastUnderAttackAt, underAttackTimer;
// Highest Antimatter Gate charge milestone (25/50/75/100%) already announced, so the
// wonderCharging event (which fires every tick) toasts once per threshold, not per frame.
let gateMilestone = 0;
// Where the last under-attack alert fired lives on game.lastAttackAt (session.js, next to
// supplyBlockedUntil) rather than a module-local var — input.js's Backspace "jump to last
// alert" key reads it too, not just the banner click below.
if (underAttackEl) underAttackEl.addEventListener("click", () => {
  if (!game.lastAttackAt || !game.input || !game.state) return;
  const cam = game.input.getCamera();
  cam.x = game.lastAttackAt.x;
  cam.y = game.lastAttackAt.y;
  clampCamera(cam, game.state.map, canvas.clientWidth, canvas.clientHeight);
});

// --- pause -------------------------------------------------------------------
// The sim pauses while a blocking overlay is up (Help, the Home-confirm modal) and on a
// manual P toggle. Reasons are refcounted so closing Help doesn't resume a game the player
// ALSO paused with P. Pausing just gates the update() callback — render keeps drawing the
// frozen frame (and the camera still pans, so you can look around) with overlays on top.
// The loop's own backlog-drop (engine/loop.js: `if (acc > dtFixed) acc = 0`) bounds the
// accumulator while update() is skipped, so no sim time is lost or spiralled on resume and
// the fixed-dt tick sequence — hence replay determinism — is untouched. The PAUSED banner
// (style.css body.paused) shows only for the MANUAL pause; Help/Home carry their own UI.
const pauseReasons = new Set();
function syncPause() {
  const manual = pauseReasons.has("manual");
  document.body.classList.toggle("paused", manual);   // the centered PAUSED banner (style.css) — manual only
  if (pauseBtn) pauseBtn.textContent = manual ? "▶ Resume" : "⏸ Pause";   // the topbar affordance (touch has no P key)
}
function clearPause() { pauseReasons.clear(); syncPause(); }
export function pauseLoop(reason = "manual") { pauseReasons.add(reason); syncPause(); }
export function resumeLoop(reason = "manual") { pauseReasons.delete(reason); syncPause(); }
export function togglePause() {
  if (!game.state || game.state.over) return;   // nothing to pause on the menu or after the match has ended
  if (pauseReasons.has("manual")) resumeLoop("manual"); else pauseLoop("manual");
}
if (pauseBtn) pauseBtn.addEventListener("click", togglePause);   // touch-reachable pause (mirrors the P key)

export function startGame(planetId) {
  // Seed the sim so the match is reproducible: a player can note the seed and
  // re-enter it to replay the exact same map. The seed itself is drawn from the
  // UI layer (Math.random is fine here — it's not the sim); everything downstream
  // flows from the seeded mulberry32, so same seed ⇒ same world.
  const seed = resolveSeed(setup);
  const diff = difficultyDials(setup.difficulty);
  // The player picks their faction; the AI's comes from this world's archetype
  // (aiArchetypes.js), so the opponent's identity is part of the world's character.
  const aiFaction = archetypeFor(planetId).faction || "neutral";
  // ADR-0003/ADR-0004 (T-012): an ordinary skirmish runs behind a real session now, reached
  // through net/loopback.js exactly as multiplayer will reach one over a socket — see boot.js's
  // own header comment. session.getState() is the SAME object bootState hands to game.state
  // (no copy), so every render/HUD read downstream is unchanged.
  const session = createSession({ planetId, seed, rng: mulberry32(seed),
    aiApm: diff.aiApm, aiMicro: diff.aiMicro, aiStrategy: setup.aiStrategy, difficulty: setup.difficulty,
    sizeMult: setup.sizeMult, resourceMult: setup.resourceMult, swapAsym: setup.swapAsym,
    matchTimeLimit: setup.matchTimeLimit, popCap: setup.popCap,
    playerFaction: setup.faction, aiFaction });
  bootState(session.getState(), { intro: true, transport: createLoopbackTransport(session) });
}

// Start one COMPETITION fixture as a real, live skirmish (docs/competitions-and-elo.md Phase 4 —
// the Gauntlet's "Play Next Match"). Deliberately a near-copy of startGame above rather than a
// second code path: same resolveSeed/difficultyDials/createGameState/bootState chain, same loop,
// same HUD — this IS an ordinary skirmish, it just knows which fixture it belongs to. Nothing about
// the running game changes; only `game.competition` (session.js) is set, which the game-over hook
// below reads to route the result into the ledger.
//
// EVERYTHING IS TAKEN FROM THE FIXTURE, not from the setup screen: the world, the exact seed (off
// the gauntlet's own schedule — never a fresh random one, or a resumed run would replay a different
// map, D6), the pinned difficulty, the opponent's own strategy/archetype, the match length, and
// this fixture's swapAsym parity. The human plays owner "player" with their chosen faction, exactly
// as in a normal skirmish (D4: there is no other seat available to them).
//
// The three map dials are PINNED, not read off `setup`: a duel's own createSelfPlayState leaves
// sizeMult/resourceMult/popCap at engine defaults, so every rating already in the ladder was earned
// on that map shape. Letting a player's leftover skirmish preferences (Gigantic, Abundant) shape
// the matches that move THEIR rating in the same bracket would make the two numbers incomparable.
//
// BUT PINNING THOSE DOES NOT MAKE A HUMAN MATCH THE SAME SHAPE AS A SIMULATED ONE, and it would be
// dishonest to imply it does. Three differences remain, by construction, and none of them can be
// closed from here:
//   • ONE match, not a worlds x seeds x 2 sweep — a human cannot play forty games (Phase 4's
//     founding constraint), so a human rating rests on far fewer, noisier samples.
//   • NO side-swap, because the human can only ever hold owner "player" (D4). That is the seat the
//     13%-of-think-cycles edge is measured AGAINST, and it is the deviation the UI discloses.
//   • The human HAS a faction and their simulated opponents do not — a self-play match has no
//     faction dial at all (see aiFaction below), so a faction's passive traits appear on exactly
//     one side of a human match and neither side of every other rated match in the bracket.
// The honest framing, and the one the screen states: a human rating is a rating in the SAME table,
// earned under a documented and bounded set of differences — not a number produced by an identical
// process. Do not add a compensating fudge for any of this; see D4 on why a correction nobody can
// derive is worse than a difference everybody can read.
export function startCompetitionMatch(fixture) {
  const { world, seed, difficulty, matchTimeLimit, swapAsym, aiStrategy, aiArchetype, playerFaction, competition } = fixture;
  sound.unlockAudio();   // a real user gesture (the Play button), same point setup.js's map cards unlock audio
  const resolved = resolveSeed({ seed });
  const diff = difficultyDials(difficulty);
  // The opponent's faction comes from the world's archetype, exactly as in a normal skirmish — a
  // roster entry's own faction stays what Phase 2 made it (flavour on the row), because a self-play
  // match has no faction dial at all, so every AI-vs-AI rating in this bracket was earned without
  // one. Giving the human's opponents a faction edge here alone would break that comparison.
  const aiFaction = archetypeFor(world).faction || "neutral";
  // Same session/loopback path startGame builds above — this IS an ordinary skirmish (see this
  // function's own header comment) sharing the exact same ADR-0003/ADR-0004 machinery.
  const session = createSession({
    planetId: world, seed: resolved, rng: mulberry32(resolved),
    aiApm: diff.aiApm, aiMicro: diff.aiMicro, aiStrategy, difficulty, aiArchetype,
    sizeMult: 1, resourceMult: 1, popCap: null,
    swapAsym: !!swapAsym, matchTimeLimit,
    playerFaction: playerFaction || setup.faction, aiFaction,
  });
  bootState(session.getState(), { intro: true, transport: createLoopbackTransport(session) });
  game.competition = competition;   // after bootState, which clears it (see its own line)
}

// WATCH one AI-vs-AI match live (docs/competitions-and-elo.md Phase 5 — competition.js's Quick
// Duel "Watch" button is the only caller). Same relationship to startGame that
// startCompetitionMatch above has: one bootState, one loop, one HUD — what makes this a SPECTATED
// match rather than a played one is two facts parked on the session afterwards.
//
// 1. THE STATE COMES FROM createSelfPlayState, not createGameState. That is what gives owner
//    "player" a second AI controller (state.playerAi), and it is the SAME constructor
//    tools/duelCore.js's runDuelMatch feeds for every simulated, rated match — so what you watch
//    is configured identically to what the Worker would have run: same world, same derived seed,
//    same swapAsym parity, the same ONE pinned difficulty dial set on both seats, each entrant's
//    own strategy/archetype on its own seat. competition.js's buildWatchConfig shapes that config
//    and is unit-tested against the worker's own seed derivation.
// 2. `game.spectateMatch` then makes the loop below call tickSelfPlay instead of tick (so owner
//    "player" is actually driven), lets Observer Mode be entered without an Odyssey, and marks the
//    match un-checkpointable (saveShape.js's resumableMode).
//
// Observer Mode is entered immediately and deliberately: it is what reveals the fog, gives the
// spectator its own free camera, and — the part that matters most — makes input.js refuse to issue
// a single order (every mouse/wheel/key path already early-returns into observer.js while
// game.observerMode is on). The human watches; they do not play.
//
// EXHIBITION ONLY: nothing here writes to the ledger. `game.competition` stays null, so the
// game-over hook's captureCompetitionResult returns null and no rating moves — see the exhibition
// argument at competition.js's EXHIBITION_NOTE, and the honest game-over copy it feeds.
export function startSpectatedMatch(cfg) {
  const { world, seed, swapAsym, matchTimeLimit, ai, playerAi, aName, bName, difficulty, onLeave, recorded } = cfg;
  sound.unlockAudio();   // a real user gesture (the Watch button), same point startCompetitionMatch unlocks audio
  const fresh = createSelfPlayState({ planetId: world, seed, swapAsym, matchTimeLimit, ai, playerAi });
  // `selfPlay: true` is what makes this the same simulation the Worker runs, not merely the same
  // configuration: the loop steps at tools/selfplay.js's own fixed step. It is what a REPLAY needs
  // to reproduce its recorded row, and the watched path shares it so "what you watch is what the
  // Worker would have run" is true of the run and not just of the config.
  bootState(fresh, { intro: false, selfPlay: true });   // no objectives strip: that checklist is a PLAYER's to-do list
  // After bootState, which clears both (see its own lines) — exactly the startOdyssey/
  // startCompetitionMatch pattern.
  // `recorded` (present only for a REPLAY) is the outcome this re-run is expected to reproduce —
  // carried so the spectate bar can say what is being replayed and the game-over screen can state,
  // honestly, whether the determinism claim held this time. It is read-only display data; nothing
  // in the sim ever sees it.
  game.spectateMatch = { aName, bName, world, seed, difficulty, matchTimeLimit, onLeave, recorded: recorded || null };
  game.spectateSpeed = 1;
  enterObserverMode();
  // bootState's own renderHUD() ran a frame ago, while the flag above was still null — so the
  // selection panel and the topbar chips were built for an ordinary skirmish and their signature
  // guard (hudPanelSignature.js) would keep them frozen that way, offering "Select Army" over an
  // AI's army. The flag is set exactly once per game, right here, so one forced repaint is the
  // whole fix; nothing downstream has to re-check it every tick.
  resetPanelSignature();
  renderHUD();
}

// Start a Convoy Escort scenario on `planetId` at the chosen difficulty. Shares
// the seed/boot machinery with a skirmish; the scenario state carries its own
// objective (engine/scenarios.js), so bootState wires it the same way.
export function startScenario(planetId) {
  const seed = resolveSeed(setup);
  const fresh = setupEscort({ planetId, seed, difficulty: setup.difficulty, sizeMult: setup.sizeMult });
  bootState(fresh, { intro: false });
}

// Start a Pirate Raider scenario on `planetId` — the mirror of Escort (you raid
// the AI convoy). Same boot machinery; the scenario carries its own objective.
export function startRaider(planetId) {
  const seed = resolveSeed(setup);
  const fresh = setupRaider({ planetId, seed, difficulty: setup.difficulty, sizeMult: setup.sizeMult });
  bootState(fresh, { intro: false });
}

// Start a Bounty Marshal scenario on `planetId` — hunt scattered pirate camps
// across the sector against a clock. Same boot machinery.
export function startBounty(planetId) {
  const seed = resolveSeed(setup);
  const fresh = setupBounty({ planetId, seed, difficulty: setup.difficulty, sizeMult: setup.sizeMult });
  bootState(fresh, { intro: false });
}

// Start an Odyssey — the open-world campaign. Builds a galaxy (Phase 1: one
// randomly-chosen starting world), boots its active planet, and parks the galaxy
// on the session so the HUD/credits and the later jump machinery can reach it.
export function startOdyssey() {
  const seed = resolveSeed(setup);
  const diff = difficultyDials(setup.difficulty);
  bootGalaxy(createGalaxy({
    seed, difficulty: setup.difficulty, sizeMult: setup.sizeMult, resourceMult: setup.resourceMult,
    playerFaction: setup.faction, aiApm: diff.aiApm, aiMicro: diff.aiMicro, aiStrategy: setup.aiStrategy,
    startId: setup.startWorld, popCap: setup.popCap,
  }), { intro: true });
}

// Boot a galaxy (fresh from startOdyssey, or rehydrated from a save by
// saveload.js). bootState clears game.galaxy and rewires input/camera/HUD to the
// active world; the loop reads game.galaxy live, so the background worlds resume
// on their own once it's set right after.
export function bootGalaxy(galaxy, { intro = false } = {}) {
  bootState(activeState(galaxy), { intro });
  game.galaxy = galaxy;
}

// Launch an interplanetary jump to `destId` — relocate the capital + staged
// units (engine/galaxy.js), then repoint the running loop at the new world. The
// loop keeps running and keeps ticking the world you left (now a background
// colony), so this only swaps what's rendered and controlled. `landingPoint`
// (world coords) is only ever consulted by jumpCapital when the destination has
// no player Spaceport of its own — see initiateJump below, the picker's own
// caller.
export function performJump(destId, landingPoint) {
  if (!game.galaxy) return null;
  const result = jumpCapital(game.galaxy, destId, landingPoint ? { landingPoint } : undefined);
  if (!result) return null;   // couldn't launch (no Spaceport here, or too poor for a new world)
  focusActivePlanet();
  return result;
}

// The entry point every "Jump ▸ world" affordance should call (starmap.js, hudSelection.js's
// Spaceport panel, notifyColony's reinforce/retake toasts below) — NOT performJump directly.
// Decides whether the destination needs a player-chosen landing site first: engine/galaxy.js's
// landingZone lands at the player's own Spaceport when one already stands on `destId` (no pick
// needed — it already knows where "home" is there), and otherwise falls back to a point the
// player chooses on a blind minimap (landingPicker.js) — there's no beacon to home in on, and no
// scouted intel to show while picking. A Spaceport-less ORIGIN never needs a pick at all: with
// nothing to load, that's a pure control-switch hop (jumpCapital's header comment) that moves no
// units, so there's nowhere for a landing site to matter.
//
// Runs the same afford/reachability checks jumpCapital itself re-validates at launch (mirroring
// the pre-check every existing call site already did before calling performJump), so a jump that
// plain can't happen still fails fast, synchronously, with no picker ever shown. Returns null on
// that failure, the jump's result object if it launched immediately, or `true` if a picker opened
// (the jump completes later, from the picker's own Confirm button, once the player commits to a
// spot).
export function initiateJump(destId) {
  // A real jump changes galaxy.activeId — Observer Mode's whole guarantee is that spectating
  // never touches that (see observer.js's header comment), so it's refused here at the single
  // choke point every real-jump trigger funnels through (the starmap, a Spaceport's Jump
  // button, a colony-alert toast's "jump to defend"), not just the starmap click this file
  // also special-cases into a free spectateWorld instead.
  if (game.observerMode) return null;
  const g = game.galaxy;
  if (!g || !canJumpTo(g, destId)) return null;
  if (g.credits < jumpCost(g, destId)) return null;
  // The destination may still be DORMANT — only a seeded handful of worlds are alive from turn
  // one (engine/galaxy.js BACKGROUND_WORLDS), and a first jump to an unvisited world is exactly
  // the case this picker exists for. previewPlanet builds what the jump WOULD arrive at without
  // adding it to the live set, so opening this modal (or backing out of it) never wakes a world;
  // jumpCapital builds the identical state for real once the player commits.
  const dest = previewPlanet(g, destId);
  const needsPick = canJump(activeState(g)) && playerSpaceports(dest).length === 0;
  if (!needsPick) return performJump(destId);
  // A right-click-drag (or box-select, or an armed attack-move) started on the origin's canvas
  // just before this modal opens is otherwise still "live" — see input.js's cancelGesture — and
  // its eventual mouseup, landing anywhere on the picker, would read as a move order on the
  // current planet instead of a landing pick. Cancel it before the picker can steal that release.
  if (game.input) game.input.cancelGesture();
  pauseLoop("landing-pick");
  openLandingPicker(dest, planetName(destId), {
    onPick: point => { resumeLoop("landing-pick"); performJump(destId, point); },
    onCancel: () => resumeLoop("landing-pick"),
  });
  return true;
}

// Voluntarily end the Odyssey — the ONLY way it ends (a wipeout just sends relief). Marks the
// active seat over; the render loop's over-poll then shows the game-over (surrender) screen.
export function surrenderOdyssey() {
  if (!game.galaxy) return;
  surrenderGalaxy(game.galaxy);
}

// Per-world UI bookkeeping that must NOT carry across a world change (a fresh boot or a
// jump): the Gate-progress high-water mark, the remembered under-attack hit + banner, and
// the supply-warning window. Shared by bootState and focusActivePlanet so the next field
// added can't drift between them — the bug this fixes was focusActivePlanet resetting none
// of it, so after a jump the old world's Gate% swallowed the new world's toasts and the
// under-attack click panned to stale coordinates on the wrong map.
function resetWorldUiBookkeeping() {
  gateMilestone = 0;
  game.lastAttackAt = null;
  lastUnderAttackAt = -Infinity;
  game.supplyBlockedUntil = 0;
  underAttackEl.classList.add("hidden");
  clearTimeout(underAttackTimer);
}

// Repoint the view/input at the galaxy's active planet without restarting the
// loop (used after a jump). Mirrors bootState's per-state wiring, minus creating
// the loop and minus touching game.galaxy.
function focusActivePlanet() {
  const state = activeState(game.galaxy);
  game.state = state;
  // A fresh directTransport per jump: each planet in the galaxy owns its own `state` object, and
  // this adapter just closes over one (see net/directTransport.js's header) — it has no session
  // to carry across a jump, unlike the loopback path startGame/startCompetitionMatch build below.
  game.transport = createDirectTransport(state);
  if (game.input) game.input.destroy();
  game.input = attachInput(canvas, state, game.transport, () => renderHUD());
  const cc = [...state.buildings.values()].find(b => b.owner === game.localOwner && b.type === "command");
  const openAt = cc || state.map.bases[game.localOwner];
  const cam = game.input.getCamera();
  cam.x = openAt.x;
  cam.y = openAt.y;
  clampCamera(cam, state.map, canvas.clientWidth, canvas.clientHeight);
  resetEffects();
  resetFacing();
  resetPanelSignature();
  resetWorldUiBookkeeping();   // don't carry the previous world's Gate%, under-attack hit, or supply window
  // The player is physically here now — any starmap alert badge for THIS world is stale. Only
  // this one entry: game.colonyAlerts tracks every held colony at once (unlike the per-world
  // bookkeeping resetWorldUiBookkeeping just cleared above), so a jump here must never blow away
  // what's still burning on a world the player hasn't looked at yet.
  delete game.colonyAlerts[state.planetId];
  showSeedChip(state.seed);
  showFactionChip(state);
  renderHUD();
}

// Re-open the map-select screen (the game-over "choose another battlefield"
// button, passed into overlays' showGameOver so that module needn't import setup;
// also the topbar Home button via saveload.js). Stops the running loop AND tears the
// session down: without clearing game.input/state/galaxy the old game stayed live behind
// the menu — its window-level hotkeys kept firing, the M key reopened the now-dead
// Odyssey starmap, and the timer/beforeunload autosave kept writing (so "Exit without
// Saving" saved anyway). destroy() aborts the input listeners; nulling the session makes
// snapshot() a no-op and the M-key/hotkey gates false. Every other game.state reader
// (minimap handlers, under-attack click, save/repair buttons) already null-guards. Callers
// that need to persist first (Save & Exit) run autoSave BEFORE this. Idempotent.
export function restartToMapSelect() {
  if (loop) loop.stop();
  if (game.input) { game.input.destroy(); game.input = null; }
  exitObserverMode();   // a dangling spectateId into a galaxy that's about to be nulled would wedge the next game's input guards
  // T-035: every Transport's own close() is guaranteed safe to call regardless of kind (the shared
  // contract test/transportContract.js holds every implementation to) — a live network match's real
  // WebSocket must not linger, still receiving pushes, after its owner has already left. bootState's
  // own next call always reassigns game.transport before anything could read it again.
  if (game.transport) { game.transport.close(); game.transport = null; }
  game.state = null;
  game.galaxy = null;
  // No game, no fixture in play. Every path that leaves a LIVE competition match has already
  // settled it before reaching here — the game-over hook records its result, saveload.js's Home
  // confirm forfeits it — so this is the belt-and-suspenders clear, not the one that decides.
  game.competition = null;
  // …and no watched match either. Nothing to settle for a spectated one (it is exhibition-only and
  // writes nothing), but leaving it set would tell the NEXT game's loop to drive owner "player"
  // with an AI controller that state doesn't have, and would keep offering Observer Mode in an
  // ordinary skirmish. Same dangling-session hazard as the spectateId exitObserverMode clears above.
  game.spectateMatch = null;
  game.spectateSpeed = 1;
  // …and no live network spectate connection either (T-037) — same dangling-session hazard,
  // one flag over: left set, it would keep offering Observer Mode in the NEXT (ordinary) game.
  game.networkSpectate = false;
  // T-030's own seam back to its documented default. A genuine pre-existing gap, found while
  // adding networkSpectate above: lobbyScreen.js's joinLive sets this to a real seat ("player" OR
  // "ai") BEFORE bootState, and nothing ever reset it back afterward — a player who joined a live
  // match as seat "ai" (or, now, spectated one — this task's own spectateLive sets it to null),
  // then returned here and started an ORDINARY single-player skirmish, would silently keep
  // localOwner stuck at "ai"/null: the camera would open on the WRONG base (or crash — see
  // bootState's own openAt fallback), and every "is this mine" check throughout input/HUD would
  // read inverted or reject everything. joinLive/spectateLive both set the real value they need
  // AFTER this point runs (a fresh call always follows a return-to-map-select), so resetting the
  // default here can never race or get overwritten out from under a live connection.
  game.localOwner = "player";
  // Repaint the observer UI once, now that all of the above is false: the banner, the spectate bar
  // and the stats panel are only ever hidden by this function, and the render loop that normally
  // calls it has just been stopped. Without this they survive as stale elements — covered by the
  // full-screen map-select, but still live, and still there under the NEXT game until its first
  // HUD tick happens to hide them. The same "don't leave the session half torn down" reasoning as
  // the exitObserverMode call above.
  renderObserverPanel();
  hideChatPanel();   // T-038 — same dangling-session hazard: left showing, the NEXT game's screen would carry the PREVIOUS match's chat log
  clearPause();   // leaving a game clears any pause + the PAUSED banner
  pauseBtn.classList.add("hidden");   // …and the topbar pause control (no game to pause)
  renderMapSelect();
  mapSelectEl.classList.remove("hidden");
}

// The sim rate ordinary play has always run at — engine/loop.js's own default, restated here
// because bootState now chooses between two rates and a caller reading this file should see both
// numbers side by side rather than one of them hiding in a default parameter.
const PLAY_HZ = 20;

// Wire a state — freshly created OR loaded from a save — to input, camera, the
// fixed-timestep loop, and the HUD. The single boot path both startGame and
// loadGame funnel through.
//
// `selfPlay` (docs/competitions-and-elo.md Phase 5) runs the loop at tools/selfplay.js's own fixed
// step instead of PLAY_HZ. It is set for the one kind of game whose tick sequence has to MATCH
// something already simulated — a watched or replayed AI-vs-AI match — because a fixed step is the
// simulation, not a tuning knob: same seed, different step, different game (see SELFPLAY_DT's own
// comment for the measured proof). Every other boot path is untouched and still runs at PLAY_HZ.
// `transport` (T-012): the real session-backed loopback transport, when the caller already built
// one from a server/session.js session (startGame, startCompetitionMatch, and saveload.js's
// skirmish load — see each). Every OTHER boot path (Odyssey's own bootGalaxy->bootState, a
// scenario/raider/bounty, a spectated match) leaves this null: bootState then falls back to
// wrapping `newState` in a directTransport for input/HUD routing only, and — critically — the
// loop below keeps ticking `newState` on its OWN existing path (galaxy/spectate/tick) instead of
// calling transport.tick(dt), because a directTransport owns no ticking at all (net/directTransport.js).
export function bootState(newState, { intro, selfPlay = false, transport = null }) {
  if (loop) loop.stop();
  if (game.input) game.input.destroy();
  exitObserverMode();   // fresh/loaded game → fresh session, same reasoning as game.groups/colonyAlerts below
  mapSelectEl.classList.add("hidden");
  gameOverEl.classList.add("hidden");
  underAttackEl.classList.add("hidden");
  clearTimeout(underAttackTimer);
  hideObjectives();

  game.galaxy = null;   // cleared by default; startOdyssey re-sets it right after this returns
  game.competition = null;   // …and likewise: startCompetitionMatch re-sets it right after this returns
  game.spectateMatch = null; game.spectateSpeed = 1;   // …and likewise: startSpectatedMatch re-sets them right after this returns
  game.networkSpectate = false;   // …and likewise: lobbyScreen.js's spectateLive re-sets this right after this returns (T-037)
  game.groups = {};     // fresh game → fresh control groups (entity ids reset per game, so stale groups would mis-select)
  game.colonyAlerts = {};   // fresh game → fresh starmap alert ledger (a previous game's background-colony alerts are meaningless here)
  game.state = newState;
  // Every input/HUD command site calls game.transport.submitCommand(cmd) unconditionally now
  // (T-012) — give it the real one when the caller built a session, else a directTransport
  // wrapping this same newState (see this function's own header comment above).
  game.transport = transport || createDirectTransport(newState);
  const state = newState;   // alias for the synchronous setup below (identical to the original)
  // A scenario shows the scenario bar at the top-center; the body class drops the
  // under-attack banner below it (style.css) so a raid alert isn't hidden behind the bar.
  document.body.classList.toggle("scenario", !!state.scenario);
  showSeedChip(state.seed);
  showFactionChip(state);
  if (intro) showObjectives(state.endless);
  game.input = attachInput(canvas, state, game.transport, () => renderHUD());
  const input = game.input;
  // Open on the player's own ships — the escort/convoy start station, the raider
  // fleet's ambush point, or the player's base in a skirmish — never the map
  // centre, which on a big map is empty space. A network SPECTATOR (T-037) has no seat of its own
  // — game.localOwner is null, so state.map.bases has no entry for it — so this falls back to a
  // harmless {0,0} (clampCamera right below pulls it into valid bounds regardless): the caller
  // (lobbyScreen.js's spectateLive) always calls enterObserverMode() immediately after bootState,
  // which recenters the camera for real, so this fallback's own value is never actually seen.
  const openAt = state.scenario ? (state.scenario.playerStart || state.scenario.route[0])
    : (state.map.bases[game.localOwner] || { x: 0, y: 0 });
  const cam = input.getCamera();
  cam.x = openAt.x;
  cam.y = openAt.y;
  clampCamera(cam, state.map, canvas.clientWidth, canvas.clientHeight);
  resetEffects();
  resetFacing();
  announced = false;
  lastHud = 0;
  resetPanelSignature();
  resetWorldUiBookkeeping();
  clearPause();   // a fresh game is never born paused (and clears a stale PAUSED banner)
  let lastFrame = performance.now();

  loop = createLoop({
    // The fixed step (see this function's own `selfPlay` note). Read ONCE, at construction, and
    // deliberately not a live getter like `speed` below: the timestep must not move mid-match, or
    // the run stops being the deterministic thing a replay is comparing against.
    hz: selfPlay ? SELFPLAY_HZ : PLAY_HZ,
    // Spectate speed (docs/competitions-and-elo.md Phase 5), read LIVE so the on-screen
    // 1x/2x/4x/8x control takes effect on the very next frame without rebuilding the loop. Pinned
    // to 1 whenever no match is being watched, so an ordinary game can never inherit a leftover
    // multiplier — and engine/loop.js scales the SIM TIME a real second buys, never the fixed
    // timestep, so the tick sequence (and replay determinism) is exactly what it always was.
    speed: () => (game.spectateMatch ? game.spectateSpeed : 1),
    // Odyssey advances every world in the galaxy each tick (only the active one
    // is rendered), so the colonies you left keep evolving; otherwise just the
    // one match state ticks.
    update: dt => {
      if (pauseReasons.size) return;   // paused: skip the sim; render still draws the frozen frame + overlays
      snapshotPositions(game.state);   // interpolation baseline: positions BEFORE this tick moves them (render.js)
      if (game.galaxy) {
        stepGalaxy(game.galaxy, dt);   // active world full-rate, colonies on a coarser schedule
        for (const n of sweepColonies(game.galaxy, dt)) notifyColony(n);
        // Conquest progress: a freshly-razed neighbour capital → a toast + a small firework.
        if (game.galaxy.pacifyNotes.length) {
          for (const id of game.galaxy.pacifyNotes) {
            showGalaxyToast(`Conquered ${planetName(id)} — ${game.galaxy.pacified.size}/${DOMINATION_TARGET} worlds`, "good");
            addFireworks(3);
          }
          game.galaxy.pacifyNotes.length = 0;
        }
        // Progress milestones (engine/galaxy.js): a firework show + toast for each, in place of a
        // victory screen — the Odyssey is a play-forever sandbox, so you keep going.
        if (game.galaxy.milestones.length) {
          for (const m of game.galaxy.milestones) celebrateMilestone(m);
          game.galaxy.milestones.length = 0;
        }
        // Relief: a total wipeout is never a defeat — a fresh colony ship is dispatched so you
        // can re-found. Announce it so the player finds the ship at their landing zone.
        if (game.galaxy.reliefNote) {
          game.galaxy.reliefNote = false;
          showGalaxyToast("A relief colony ship has arrived at your landing zone — re-found your Odyssey.", "warn");
        }
      } else if (game.spectateMatch) {
        // A WATCHED match: owner "player" is driven by state.playerAi here, then tickSelfPlay's own
        // tick() drives owner "ai" exactly as the branch below does. Deliberately the same
        // tools/selfplay.js entry point every simulated duel already runs through, so a match you
        // watch and the identical match the Worker would have simulated advance the same way.
        tickSelfPlay(game.state, dt);
      } else if (transport && typeof transport.tick === "function") {
        // The ADR-0003/ADR-0004 path (T-012): transport.tick(dt) is net/loopback.js's own
        // session.tick(dt) — aiSeats (empty for an ordinary human-played match) then
        // engine/sim.js's tick(state, dt), the SAME call the plain branch below makes, on the
        // SAME game.state object (session.getState() returned it by reference at boot) — so this
        // is a routing change, not a behavior change. Bound to the `transport` OPTION, not
        // game.transport: only a caller that actually built a session (startGame,
        // startCompetitionMatch, a loaded skirmish) reaches here; every other boot path's
        // game.transport is a directTransport with no tick() of its own, and keeps ticking below.
        transport.tick(dt);
      } else if (transport) {
        // T-034: a LIVE NETWORK transport (net/wsClientTransport.js's real shape — submitCommand/
        // onEvent/close, deliberately no .tick of its own) — the SERVER'S OWN worker owns this
        // match's ticking (T-029), so there is nothing to do here, every frame, on purpose. Found
        // by an actual browser join: without this branch, `transport.tick(dt)` above threw on the
        // very first frame, and engine/loop.js's own update() is deliberately UNGUARDED (its own
        // header: "a throwing sim update is a correctness problem this catch isn't meant to paper
        // over"), so that throw killed the whole render loop after one frame — a hard freeze, not a
        // cosmetic bug. game.state itself is kept current by the caller's own ongoing
        // transport.onEvent subscription (lobbyScreen.js's joinLive), never by ticking it here.
      } else tick(game.state, dt);
    },
    render: (alpha) => {
      const now = performance.now();
      game.input.tickCamera((now - lastFrame) / 1000);
      lastFrame = now;

      // While paused no tick runs, so the leftover fraction wobbles with the accumulator —
      // pin alpha to 1 (settled/live positions) so paused units sit still instead of jittering.
      const a = pauseReasons.size ? 1 : alpha;
      // Observer Mode draws observedState() (possibly a different, backgrounded world) through
      // its own camera instead of the real game.state/game.input camera — see observer.js's
      // header comment. Neither is touched by the other: normal play resumes exactly where it
      // was left the moment observerMode goes back off.
      const viewState = game.observerMode ? observedState() : game.state;
      const viewCamera = game.observerMode ? game.observerCamera : game.input.getCamera();
      drawFrame(ctx, viewState, viewCamera, canvas.clientWidth, canvas.clientHeight, game.input.getDragBox(), game.input.getBuildGhost(), a, game.observerMode);
      drawMinimap(minimapCtx, viewState, viewCamera, canvas.clientWidth, canvas.clientHeight, MINIMAP_W, MINIMAP_H, activePings(), game.observerMode);
      processFrameEvents();
      if (now - lastHud > 150) { lastHud = now; renderHUD(); renderObserverPanel(); }
      if (game.state.over && !announced) {
        announced = true;
        loop.stop();
        // A WATCHED match's own ending, computed BEFORE Observer Mode is torn down (it reads
        // game.spectateMatch). Then leave Observer Mode and repaint its UI once, so the spectate
        // bar and stats panel — which carry explicit z-indexes and would otherwise sit ON TOP of
        // the game-over overlay — are gone before that overlay goes up.
        const spectate = game.spectateMatch ? spectatedGameOverBlock(game.state, game.spectateMatch) : null;
        if (spectate) { exitObserverMode(); renderObserverPanel(); }
        if (game.state.scenario) showScenarioEnd(game.state, restartToMapSelect);
        else showGameOver(game.state.winner, game.state.seed, restartToMapSelect,
          { odyssey: !!game.galaxy, wonBy: game.galaxy?.wonBy, surrendered: !!game.galaxy?.surrendered,
            // A WATCHED match's ending (Phase 5, computed just above). Neither seat is the
            // player's, so the ordinary "Victory — the enemy's last Command Center is destroyed"
            // copy would be a lie in both directions; competition.js names the entrant that
            // actually won and restates that the result was exhibition-only. null for every other
            // game, leaving that screen untouched.
            spectate,
            // winReason (engine/victory.js finish) + the state itself, so showGameOver can branch
            // its copy honestly and, for a score decision, show the bank/army/structures breakdown.
            winReason: game.state.winReason, state: game.state,
            // A competition fixture's result is recorded HERE, at the one point the match is
            // genuinely over (docs/competitions-and-elo.md Phase 4) — competition.js owns the write
            // (it holds the live ledger) and hands back the block this screen shows: the rating
            // change, the seat disclosure, and what the next fixture is with a button to play it.
            // null for every ordinary skirmish, which leaves this screen byte-identical to before.
            competition: game.competition ? captureCompetitionResult(game.state) : null });
      }
    },
  });
  loop.start();
  renderHUD();
}

// Background-colony notifications from galaxy.sweepColonies. "Under attack" is
// throttled per planet so a sustained raid pings occasionally rather than every
// tick; "lost" fires once per loss (sweepColonies only reports each transition once —
// retaking and losing a world again re-arms it). Both toasts are clickable — clicking
// jumps straight to that world to defend or retake it (a free hop, since it's a world
// you've held). If no Spaceport stands on the world you're currently on, the jump can't
// launch, so the click explains why instead.
//
// Every notification here ALSO lands on game.colonyAlerts[planetId] = {type, at}
// (session.js) — the starmap's live ledger (starmap.js renderStarmap reads it for a badge
// + garrison line, P6 "Starmap live colony ledger"), so a multi-colony empire can see
// "where's the fire" on the map itself instead of from memory of whichever toast scrolled
// by. Written unconditionally for all three types, independent of the toast throttle below
// — the badge should track the freshest real event even while the TOAST itself stays quiet
// mid-siege — and cleared per-world by boot.js's focusActivePlanet the instant the player
// actually arrives there. The throttle itself is untouched: it still only ever compares
// against THIS world's own previous ATTACKED alert (never a hostile/lost one that might
// have just landed on the same record), so a hostile-declaration toast can never suppress
// the very next under-attack toast.
const COLONY_NOTE_THROTTLE_MS = 9000;
export function notifyColony(n) {
  const name = planetName(n.planetId);
  const jumpThere = () => {
    if (!initiateJump(n.planetId))
      showGalaxyToast(`Build a Spaceport on your current world to jump to ${name}.`, "warn");
  };
  const now = performance.now();
  const prevAlert = game.colonyAlerts[n.planetId];
  if (n.type === "lost") {
    game.colonyAlerts[n.planetId] = { type: n.type, at: now };
    showGalaxyToast(`⚠ Your colony on ${name} has fallen — click to retake ▸`, "bad", jumpThere);
    return;
  }
  // A background world's neighbour has just declared war (fires once — diplomacy latches it).
  // Surface it so the first warning isn't the colony already dying; clicking jumps to reinforce.
  if (n.type === "hostile") {
    game.colonyAlerts[n.planetId] = { type: n.type, at: now };
    showGalaxyToast(`⚔ The neighbour on ${name} has turned hostile — click to reinforce ▸`, "warn", jumpThere);
    return;
  }
  // "attacked": throttle against this world's own previous ATTACKED record specifically — NOT
  // whatever prevAlert holds if the last write here was actually the hostile/lost branch above.
  const lastAttackAt = prevAlert && prevAlert.type === "attacked" ? prevAlert.at : undefined;
  game.colonyAlerts[n.planetId] = { type: n.type, at: now };
  if (lastAttackAt !== undefined && now - lastAttackAt < COLONY_NOTE_THROTTLE_MS) return;   // undefined ⇒ first alert always fires
  showGalaxyToast(`⚔ Your colony on ${name} is under attack — click to defend ▸`, "warn", jumpThere);
}

// A reached progress milestone (engine/galaxy.js checkGalaxyProgress / checkDomination) →
// a firework show + a celebratory toast. The Odyssey has no victory screen any more
// (play-forever); these mark how far you've come instead. The two grand milestones — the
// Antimatter Gate coming online and conquering the galaxy — get a bigger show.
function celebrateMilestone(id) {
  const [kind, arg] = id.split(":");
  const dominAll = kind === "domination" && arg === "all";   // every world pacified — the maximal feat
  const grand = kind === "gate" || kind === "domination";
  const msg =
      kind === "world"      ? (arg === "1" ? "★ First colony founded — your Odyssey begins!"
                                           : `★ Colony #${arg} established — your reach grows.`)
    : kind === "capital"    ? "★ Capital fortified — your anchor world stands strong."
    : kind === "gate"       ? "★ Antimatter Gate online — a triumph of industry!"
    : dominAll              ? "★ Every world pacified — the galaxy is yours!"
    : kind === "domination" ? `★ ${DOMINATION_TARGET} worlds conquered — the galaxy trembles before your fleet!`
    :                         "★ Milestone reached!";
  addFireworks(dominAll ? 12 : grand ? 8 : 5);
  showGalaxyToast(msg, "good");
  sound.playBuildingComplete();
}

// Stereo pan (-1..1) for a world-x, relative to the camera: a fight off the
// left edge of the view is heard on the left. Clamped, and flattened toward
// center for things near the middle so it isn't distractingly hard-panned.
function panFor(worldX) {
  const { state, input } = game;
  if (!state || !input) return 0;
  const cam = input.getCamera();
  const halfW = canvas.clientWidth / (2 * cam.zoom) || 1;
  return Math.max(-1, Math.min(1, (worldX - cam.x) / halfW)) * 0.85;
}

// T-019b: which events count as "the local seat is under attack" — anyone ELSE'S event, not
// specifically a hardcoded owner "ai". `ev.owner === "ai"` used to gate the alarm directly, correct
// only because exactly two owners exist today; once a third does (an observed match, a future
// N-player game), an "ai"-caused event no longer necessarily means the LOCAL seat got hit. Pure and
// exported so it's testable on its own — triggerUnderAttack itself reaches into the DOM
// (underAttackEl, setTimeout) in a way this file's own boot.test.js deliberately doesn't drive
// through private internals (see that file's header). T-030: `game.localOwner`, not the literal
// "player" this already generalized away from "ai" — the SAME reasoning one step further, since
// the local seat is not always "player" either once a live multiplayer seat B connects.
export function isUnderAttackEvent(ev) { return ev.owner !== game.localOwner; }

// A sim event plays a sound (and spawns a matching visual effect — see
// effects.js) if it's the player's own, or if it happened somewhere
// currently visible — same "you can hear what you can see" rule as fog
// of war applies to rendering. Every AI-only skirmish happening off in
// the fogged dark stays silent.
function processFrameEvents() {
  const { state } = game;
  for (const ev of state.events) {
    if (ev.owner !== game.localOwner && !isVisibleAt(state.fog, ev.x, ev.y)) continue;
    const pan = panFor(ev.x);   // stereo-place the sound by where it happened on screen
    switch (ev.type) {
      case "unitSpawned":
        sound.playUnitSpawned(pan);
        break;
      case "attackHit":
        (ev.heavy ? sound.playHeavyHit : sound.playAttackHit)(pan);
        addTracer(ev.fromX, ev.fromY, ev.x, ev.y, ev.unitType, ev.bonus, ev.splashRadius);
        if (isUnderAttackEvent(ev)) triggerUnderAttack(ev.x, ev.y);
        break;
      // Tiered destruction (docs/improvement-proposals.md): the event's unitType/kind (engine/
      // combat.js/engine/bomb.js) let the death ring/sound scale by what actually died, instead
      // of every kill playing the identical 280ms ring + tone. Falls back to the def-less
      // baseline for an event somehow missing them (shouldn't happen post-this-change, but keeps
      // this handler from ever crashing on a stray/older-shaped event).
      case "entityKilled": {
        const def = ev.kind === "building" ? BUILDINGS[ev.unitType] : UNITS[ev.unitType];
        const radius = def?.radius || DEATH_BASE_RADIUS;
        sound.playEntityKilled(pan, radius / DEATH_BASE_RADIUS);
        addDeathFlash(ev.x, ev.y, radius, ev.kind || "unit");
        break;
      }
      // A Helium Bomb's fuse just lit (engine/bomb.js) — proximity or the player's own
      // "Detonate Now" command. The real blast (bombDetonated below) doesn't land for
      // another ev.delay sim-seconds; this is the warning that it's now inevitable.
      case "bombFused":
        sound.playFuseLit(pan);
        addFuseWarning(ev.x, ev.y, ev.delay * 1000);
        if (isUnderAttackEvent(ev)) triggerUnderAttack(ev.x, ev.y);
        break;
      // The Helium Bomb's detonation (engine/bomb.js) — one event for the blast itself,
      // alongside the individual entityKilled events for everything the falloff-damaged
      // blast actually killed outright.
      case "bombDetonated":
        sound.playExplosion(pan);
        addExplosion(ev.x, ev.y, ev.radius, ev.coreRadius);
        if (isUnderAttackEvent(ev)) triggerUnderAttack(ev.x, ev.y);
        break;
      // A Helium Bomb crater (engine/bomb.js) finished terraforming — the payoff for the
      // detonation, easy to miss if it's not called out (the deposit can land anywhere the
      // bomb went off, not necessarily somewhere the player is still looking).
      case "craterMatured":
        sound.playBuildingComplete(pan);
        showGalaxyToast(`${COM[ev.com]?.ico || "◆"} A ${COM[ev.com]?.name || ev.com} deposit has formed in the blast crater`, "good");
        break;
      // Battle wreckage (engine/wreckage.js) finished settling into real deposits — one
      // node per commodity it accumulated, so the toast lists all of them at once rather
      // than firing once per node. Same payoff-callout reasoning as craterMatured above:
      // easy to miss otherwise if the fight's moved on since it happened.
      case "wreckMatured": {
        sound.playBuildingComplete(pan);
        const goods = (ev.coms || []).map(com => `${COM[com]?.ico || "◆"} ${COM[com]?.name || com}`).join(", ");
        showGalaxyToast(`Battle wreckage has settled into a deposit: ${goods}`, "good");
        break;
      }
      case "buildingComplete":
        sound.playBuildingComplete(pan);
        break;
      // Only the player's own supply block beeps and flashes — a visible
      // enemy stalling on supply is their problem, not a HUD alert of ours.
      case "productionBlocked":
        if (ev.owner === game.localOwner) {
          sound.playProductionBlocked();
          game.supplyBlockedUntil = performance.now() + 800;
        }
        break;
      // Odyssey research finishing was previously silent — announce the unlock so
      // the player connects the wait to the reward (and notices new build options).
      case "researchComplete":
        sound.playBuildingComplete(pan);
        showGalaxyToast(`Researched ${TECHS[ev.techId]?.name || ev.techId}`, "good");
        break;
      // The neighbour just crossed from peace into war — a one-time heads-up so the
      // first raid doesn't land unannounced (diplomacy.js fires this once per world).
      case "neighbourHostile":
        sound.playProductionBlocked();
        showGalaxyToast("⚔ Your neighbour has turned hostile — expect raids. Ready your defence.", "bad");
        break;
      // The Antimatter Gate charge (fires every tick) — toast once per 25% so the
      // multi-minute climb to the galaxy win is visible without selecting the Gate.
      case "wonderCharging": {
        const pct = Math.floor((ev.charge || 0) * 4) * 25;
        if (pct >= 25 && pct > gateMilestone) {
          gateMilestone = pct;
          showGalaxyToast(`Antimatter Gate charging — ${pct}%`, pct >= 75 ? "bad" : "warn");
        }
        break;
      }
    }
  }
  state.events.length = 0;
}

// Throttled independently of sound.js's own internal throttle (which
// only governs the alarm tone) so the banner and the minimap/world ping
// stay in lockstep with each other during a sustained siege instead of
// re-flashing on every single hit.
function triggerUnderAttack(x, y) {
  // Nobody's base is under attack in a WATCHED match — both sides are AI entrants, and "⚠ Under
  // Attack" over a match the human isn't playing is simply false. (The alarm fires off an
  // owner-"ai" attackHit, which in a spectated duel just means one entrant hit the other.)
  if (game.spectateMatch) return;
  game.lastAttackAt = { x, y };   // remembered even while throttled, so a click/Backspace always jumps to the freshest hit
  const now = performance.now();
  if (now - lastUnderAttackAt < UNDER_ATTACK_THROTTLE_MS) return;
  lastUnderAttackAt = now;

  sound.playUnderAttack();
  addUnderAttackPing(x, y);
  underAttackEl.classList.remove("hidden");
  clearTimeout(underAttackTimer);
  underAttackTimer = setTimeout(() => underAttackEl.classList.add("hidden"), UNDER_ATTACK_BANNER_MS);
}
