/* ============================================================
   Mouse + keyboard input: left-drag to box-select the player's own
   units, right-click to issue a context-sensitive order (attack an
   enemy, gather a node, or just move), a build-placement mode the HUD
   arms via startBuild(), and camera control (wheel to zoom, WASD/arrows
   to pan).
   ============================================================ */

"use strict";

import { game } from "./session.js";
import { UNITS, BUILDINGS, canBuildCategory } from "./engine/entities.js";

import { createCamera, zoomAt, panCamera, pinchZoomPan } from "./camera.js";
import { createInputCommands, CLICK_THRESHOLD } from "./inputCommands.js";
import * as sound from "./sound.js";
import { toggleObserverMode, requestExitObserverMode, cycleObserverBase, observerWheelZoom, observerDragStart, observerDragMove, observerDragEnd, tickObserverCamera } from "./observer.js";

// A second press within this window recenters/cycles instead of repeating — shared by control
// groups (recallGroup, below) and by Space's base-cycling (centerOnBase, below).
const DOUBLE_GROUP_MS = 400;
const UNIT_PICK_RADIUS = 10;
const NODE_PICK_RADIUS = 14;
const ZOOM_STEP = 1.12;
const EDGE_SCROLL_MARGIN = 20;   // px from a canvas edge that starts scrolling the camera
// A is deliberately NOT a pan key — it's reserved for attack-move (the genre
// standard). Pan left with the arrow key or edge-scroll.
const PAN_KEYS = {
  arrowleft: [-1, 0],
  arrowright: [1, 0], d: [1, 0],
  arrowup: [0, -1], w: [0, -1],
  arrowdown: [0, 1], s: [0, 1],
};

// `transport` is the ADR-0004 seam (net/transport.js) this controller and every command it
// issues routes through — boot.js hands in either the real session-backed loopback transport
// (an ordinary skirmish/competition/loaded game, T-012) or, for the boot paths T-012
// deliberately leaves untouched (Odyssey, scenario, a spectated match), its directTransport
// shim, which applies the same WireCommand straight to this `state` with no session behind it.
// Either way this file never calls an engine/commands.js issue* function itself.
export function attachInput(canvas, state, transport, onChange) {
  const controller = new AbortController();
  const { signal } = controller;
  const camera = createCamera(state.map);
  const heldKeys = new Set();

  // The stateless "what is at this point / what does clicking here do" helpers (inputCommands.js).
  // Bound once to this controller's collaborators, so every call below reads unchanged.
  const { viewport, toWorld, entityAt, nodeAt, currentFormation, aggressiveMove, alivePlayerUnitIds,
          selectedUnits, centerCamera, applyBoxSelection, selectSameTypeAt, commandAt } =
    createInputCommands({ canvas, state, camera, transport, onChange });

  let dragBox = null;
  let rightDragStart = null;   // world-space {x,y} where a right-button drag began, or null between drags
  let buildMode = null;
  let attackMoveArmed = false;   // set by the A key; the next left-click issues an attack-move
  let lastWorldPos = { x: state.map.width / 2, y: state.map.height / 2 };
  // Control groups live on the shared session, keyed per planet id, so they survive an
  // Odyssey jump (which destroys + rebuilds this input controller) and can be shown/tapped in
  // the HUD. `{ digit: [ids] }` per world.
  const groups = () => (game.groups[state.planetId] ||= {});
  let lastGroupDigit = null, lastGroupAt = -Infinity;   // a second press of the same digit re-centers
  let idleCycle = 0;                 // round-robins through idle workers on repeated presses
  let idleProducerCycle = 0;         // round-robins through idle production buildings on repeated presses
  let baseCycle = 0, lastBaseAt = -Infinity;   // round-robins through completed CCs on repeated Space presses
  let edgePan = [0, 0];              // camera nudge from the cursor sitting at a screen edge

  // ---- touch state ----
  // One finger = tap-to-select / tap-to-command / drag-a-box; two fingers =
  // pinch-zoom + pan. See the touch handlers below for the full gesture map.
  let touchStart = null;         // { cx, cy, wx, wy, moved } for the active one-finger drag (client + world)
  let pinchPrev = null;          // last two-finger snapshot { ax, ay, bx, by } for pinchZoomPan
  let gestureActive = false;     // a two-finger gesture happened; ignore fingers until all lift
  let lastTapAt = 0, lastTapCX = 0, lastTapCY = 0;   // for double-tap detection (client coords + time)

  // The A key arms attack-move; the crosshair cursor + field tint show it's armed, and the
  // HUD's Attack-Move button flips to its ARMED state. onChange() is what makes that button
  // rebuild — without it, arming via the A key (or a right-click cancel) changed nothing the
  // player could see on the panel until some unrelated HUD tick happened to rebuild it.
  function setArmed(v) {
    if (attackMoveArmed === v) return;
    attackMoveArmed = v;
    canvas.classList.toggle("aim-cursor", v);
    onChange();
  }

  // First real touch flips the app into touch mode: CSS (style.css) grows the
  // tap targets and the HUD swaps to the touch legend. Idempotent.
  function onTouchActive() {
    if (!document.body.classList.contains("touch")) document.body.classList.add("touch");
  }

  // Abandon any gesture in progress without issuing it. mousedown/touchstart arm this
  // controller's drag state on the CANVAS, but the matching mouseup is a WINDOW listener (so a
  // drag that ends off-canvas — e.g. at a screen edge while panning — still completes, by
  // design). That means a right-click-drag (or box-select, or an armed attack-move) begun on the
  // canvas is still "live" even after a blocking modal opens over it — the eventual mouseup,
  // wherever it lands, bubbles to window and resolves against the STALE start point on the world
  // behind the modal. Concretely: right-click-drag toward a Spaceport's Jump button, the picker
  // opens mid-drag, and releasing over its landing-site chart reads as a move order on the
  // current planet instead of a landing pick. Callers that open such a modal (boot.js's
  // initiateJump, starmap.js's openStarmap) must call this first so no gesture is left armed to
  // resolve later against a canvas the player can no longer see or intend to be clicking on.
  function cancelGesture() {
    dragBox = null;
    rightDragStart = null;
    buildMode = null;
    setArmed(false);
    touchStart = null;
    pinchPrev = null;
    gestureActive = false;
  }

  // ---- shared selection / command logic ----
  // Extracted so the mouse and touch paths issue byte-identical orders: a
  // finger-tap runs exactly the same routing as a right-click, a drag-box the
  // same as a mouse box, and a double-tap the same as a double-click.

  canvas.addEventListener("mousedown", e => {
    // Observer Mode: the canvas shows a possibly-different world than `state` (see
    // observer.js's observedState) — every one of this handler's hit-tests below reads
    // `state`/the real `camera`, so they'd resolve against the wrong world's coordinates.
    // Left-drag just pans the observer camera instead; every other button is a no-op.
    if (game.observerMode) { if (e.button === 0) observerDragStart(e.clientX, e.clientY); return; }
    if (e.button === 2) {
      // The actual command (or a build/attack-move cancel) fires on mouseup below, once we
      // know whether this stayed a click or became a drag — just mark where it started.
      rightDragStart = toWorld(e.clientX, e.clientY);
      return;
    }
    if (e.button !== 0) return;
    const p = toWorld(e.clientX, e.clientY);
    if (buildMode) { placeBuildingAt(p); return; }
    // Armed attack-move: this click commits the order instead of starting a
    // selection drag. Consumes the arm, whether or not anything is selected.
    if (attackMoveArmed) {
      setArmed(false);
      const selected = selectedUnits();
      if (selected.length) { aggressiveMove(selected, p.x, p.y); sound.playOrder(); onChange(); }
      return;
    }
    dragBox = { x1: p.x, y1: p.y, x2: p.x, y2: p.y };
  }, { signal });

  canvas.addEventListener("mousemove", e => {
    if (game.observerMode) { observerDragMove(e.clientX, e.clientY); return; }
    lastWorldPos = toWorld(e.clientX, e.clientY);   // tracked continuously for the build-placement ghost
    // Edge scroll: cursor within a margin of a canvas edge nudges the camera
    // that way, so you can drag the view without touching the keyboard.
    const rect = canvas.getBoundingClientRect();
    const lx = e.clientX - rect.left, ly = e.clientY - rect.top;
    edgePan = [
      lx < EDGE_SCROLL_MARGIN ? -1 : lx > rect.width - EDGE_SCROLL_MARGIN ? 1 : 0,
      ly < EDGE_SCROLL_MARGIN ? -1 : ly > rect.height - EDGE_SCROLL_MARGIN ? 1 : 0,
    ];
    if (!dragBox) return;
    dragBox.x2 = lastWorldPos.x;
    dragBox.y2 = lastWorldPos.y;
  }, { signal });
  canvas.addEventListener("mouseleave", () => { edgePan = [0, 0]; }, { signal });

  window.addEventListener("mouseup", e => {
    if (game.observerMode) { observerDragEnd(); return; }
    if (e.button === 2) {
      const start = rightDragStart;
      rightDragStart = null;
      if (!start) return;   // the button went down somewhere this listener never saw (e.g. off-canvas)
      if (buildMode) { buildMode = null; onChange(); return; }
      if (attackMoveArmed) { setArmed(false); return; }   // right-click cancels a pending attack-move
      const end = toWorld(e.clientX, e.clientY);
      const dx = end.x - start.x, dy = end.y - start.y;
      // A plain click carries no heading (the shape/facing fall back to the group's own travel
      // direction, exactly as before); a real drag's direction becomes the explicit heading —
      // see currentFormation/applyFacing. Holding Ctrl queues the order as a waypoint instead of
      // replacing what the units are doing, so a sequence of Ctrl+right-drags lays down a
      // multi-leg, individually-aimed path.
      const heading = Math.hypot(dx, dy) >= CLICK_THRESHOLD ? { x: dx, y: dy } : null;
      commandAt(start, e.ctrlKey, heading);
      return;
    }
    if (e.button !== 0 || !dragBox) return;
    const box = dragBox;
    dragBox = null;
    // Ctrl (the game's modifier — see the waypoint note below) adds to the current selection
    // instead of replacing it, so you can pull several groups together; Alt instead SUBTRACTS
    // the box's catch from the current selection (pulling specific units back out of a big
    // blob). An empty additive/subtractive click leaves the selection untouched.
    applyBoxSelection(box, e.ctrlKey, e.altKey);
  }, { signal });

  // Double-click a unit to grab every same-type unit of yours currently on screen — the standard
  // "select all of this type" gesture. Ctrl+double-click extends that to the whole map.
  canvas.addEventListener("dblclick", e => {
    if (game.observerMode) return;
    // Mid-build-placement or with attack-move armed, each of the two clicks that make up this
    // dblclick already went through mousedown's own buildMode/attackMoveArmed handling (placed
    // the building / committed the attack-move); the reselect-fleet-of-this-type gesture below
    // doesn't apply on top of that, same as every other handler that checks these flags first.
    if (buildMode || attackMoveArmed) return;
    selectSameTypeAt(toWorld(e.clientX, e.clientY), e.ctrlKey);
  }, { signal });

  // The actual right-click handling (build/attack-move cancel, or commandAt with whatever
  // heading the drag implies) lives on mouseup above, which fires before this — contextmenu's
  // only remaining job is suppressing the browser's native menu. NOT Shift+right-click: Firefox
  // force-shows the native context menu on it and bypasses preventDefault, so a Shift-modified
  // right-drag could never be captured — Ctrl is the queue modifier here instead, for exactly
  // that reason.
  canvas.addEventListener("contextmenu", e => { e.preventDefault(); }, { signal });

  canvas.addEventListener("wheel", e => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    if (game.observerMode) { observerWheelZoom(e.clientX, e.clientY, rect, factor); return; }
    const { vw, vh } = viewport();
    zoomAt(camera, state.map, vw, vh, e.clientX - rect.left, e.clientY - rect.top, factor);
  }, { signal, passive: false });

  /* ---------- touch (phones / tablets) ----------
     A one-button, no-hover parallel to the mouse controls, so the game is fully
     playable by finger:
       • tap your unit/building ....... select it (double-tap = all of that type on screen)
       • tap elsewhere ................ command the selection (move / attack a foe / gather a
                                        node), or set a selected production building's rally
       • one-finger drag .............. box-select your units
       • two-finger drag .............. pan · pinch ...... zoom (about the pinch)
       • Build mode / Attack-move ..... tap places the building / commits the attack-move
     Runs the SAME applyBoxSelection / commandAt / selectSameTypeAt / placeBuildingAt as the
     mouse, so touch and desktop issue identical orders. `touch-action: none` on the canvas
     (style.css) stops the browser hijacking these as page scroll / zoom. */
  const TAP_MOVE_TOL = 14;    // client px a finger may travel and still count as a tap, not a drag
  const DOUBLE_TAP_MS = 300, DOUBLE_TAP_DIST = 30;

  function twoSnapshot(t0, t1) {
    const rect = canvas.getBoundingClientRect();
    return { ax: t0.clientX - rect.left, ay: t0.clientY - rect.top,
             bx: t1.clientX - rect.left, by: t1.clientY - rect.top };
  }

  canvas.addEventListener("touchstart", e => {
    e.preventDefault();
    onTouchActive();
    if (e.touches.length >= 2) {
      // Second finger down: abandon any one-finger drag/box and start pinch-pan.
      touchStart = null; dragBox = null; gestureActive = true;
      pinchPrev = twoSnapshot(e.touches[0], e.touches[1]);
      return;
    }
    if (e.touches.length === 1 && !gestureActive) {
      const t = e.touches[0];
      const w = toWorld(t.clientX, t.clientY);
      touchStart = { cx: t.clientX, cy: t.clientY, wx: w.x, wy: w.y, moved: false };
      lastWorldPos = w;   // so the build ghost sits under the finger from the first touch
    }
  }, { signal, passive: false });

  canvas.addEventListener("touchmove", e => {
    e.preventDefault();
    const { vw, vh } = viewport();
    if (e.touches.length >= 2 && pinchPrev) {
      const cur = twoSnapshot(e.touches[0], e.touches[1]);
      pinchZoomPan(camera, state.map, vw, vh, pinchPrev, cur);
      pinchPrev = cur;
      return;
    }
    if (e.touches.length === 1 && touchStart && !gestureActive) {
      const t = e.touches[0];
      const w = toWorld(t.clientX, t.clientY);
      lastWorldPos = w;
      if (!touchStart.moved && Math.hypot(t.clientX - touchStart.cx, t.clientY - touchStart.cy) > TAP_MOVE_TOL) {
        touchStart.moved = true;
        // A drag that isn't placing a building becomes a selection box.
        if (!buildMode) dragBox = { x1: touchStart.wx, y1: touchStart.wy, x2: w.x, y2: w.y };
      }
      if (dragBox) { dragBox.x2 = w.x; dragBox.y2 = w.y; }
    }
  }, { signal, passive: false });

  function endTouch(e) {
    e.preventDefault();
    if (e.touches.length >= 2) { pinchPrev = twoSnapshot(e.touches[0], e.touches[1]); return; }
    if (e.touches.length === 1) {
      // Dropped from two fingers to one: don't let the leftover finger act — wait
      // for a clean, all-up release so a lifted pinch never fires a stray tap.
      pinchPrev = null;
      return;
    }
    // All fingers up.
    if (gestureActive) { gestureActive = false; touchStart = null; dragBox = null; return; }
    if (!touchStart) return;
    const start = touchStart; touchStart = null;

    if (start.moved && dragBox) {          // a drag: finish the selection box
      const box = dragBox; dragBox = null;
      applyBoxSelection(box, false);
      return;
    }
    dragBox = null;
    const p = { x: start.wx, y: start.wy };

    // In build mode, place at where the finger LIFTED (lastWorldPos tracks the
    // move) so a drag-to-position works; for a plain tap that's the tap point.
    if (buildMode) { placeBuildingAt(lastWorldPos); return; }
    if (attackMoveArmed) {
      setArmed(false);
      const sel = selectedUnits();
      if (sel.length) { aggressiveMove(sel, p.x, p.y); sound.playOrder(); onChange(); }
      return;
    }

    // A quick second tap near the first upgrades to select-all-of-type.
    const now = performance.now();   // UI-only timing; the deterministic sim never reads a clock
    const isDouble = now - lastTapAt < DOUBLE_TAP_MS
      && Math.hypot(start.cx - lastTapCX, start.cy - lastTapCY) < DOUBLE_TAP_DIST;
    lastTapAt = now; lastTapCX = start.cx; lastTapCY = start.cy;
    if (isDouble && selectSameTypeAt(p)) return;

    // Single tap: your own entity selects; anything else is a command to the
    // current selection (mirrors left-click select vs right-click order).
    const hit = entityAt(p.x, p.y);
    if (hit && hit.owner === game.localOwner) {
      state.selection = [hit.id];
      sound.playSelect();
      onChange();
    } else {
      commandAt(p, false);
    }
  }
  canvas.addEventListener("touchend", endTouch, { signal, passive: false });
  canvas.addEventListener("touchcancel", endTouch, { signal, passive: false });

  function assignGroup(digit) {
    groups()[digit] = [...state.selection];
  }
  // Recall a bound group; a SECOND press of the same digit within DOUBLE_GROUP_MS also
  // recenters the camera on the group's centroid (the standard "tap to select, tap again to
  // jump to them"). Selecting a live-only subset (dead ids filtered) as before.
  function recallGroup(digit) {
    const ids = alivePlayerUnitIds(groups()[digit] || []);
    if (!ids.length) return;
    state.selection = ids;
    const now = performance.now();
    if (digit === lastGroupDigit && now - lastGroupAt < DOUBLE_GROUP_MS) {
      const us = ids.map(id => state.units.get(id)).filter(Boolean);
      if (us.length) centerCamera(us.reduce((s, u) => s + u.x, 0) / us.length, us.reduce((s, u) => s + u.y, 0) / us.length);
    }
    lastGroupDigit = digit; lastGroupAt = now;
  }
  function stopSelected() {
    const ids = selectedUnits().map(u => u.id);
    if (ids.length) transport.submitCommand({ t: "stop", ids });
  }
  // Send every selected Ranger off to chart the map on its own (see scout.js).
  // A no-op if nothing scout-role is selected.
  function scoutSelected() {
    const ids = selectedUnits().map(u => u.id);
    if (ids.length) transport.submitCommand({ t: "scout", ids });
  }
  // Put selected combat units into the Hold-position stance.
  function holdSelected() {
    const ids = selectedUnits().map(u => u.id);
    if (ids.length) transport.submitCommand({ t: "hold", ids });
  }
  // R: convert the selection's EXISTING move/attack-move waypoint chain into a looping patrol
  // (engine/commands.js issuePatrol) — the same points already laid down by right-click /
  // Ctrl+right-click keep going instead of running out at the last stop. Reads each unit's own
  // order + orderQueue independently (a mixed selection can be at a different point in its own
  // chain), so this is a conversion of what's already there, not a fresh command with its own
  // destination. Only move/attack-move legs carry a map point to patrol between — anything else
  // queued (an attack on a specific target, a gather, …) isn't a waypoint and is skipped, so a
  // unit with none of those queued just keeps doing whatever it's doing: nothing to loop.
  // issuePatrol itself re-applies the combat/scout role gate, so a worker caught in the
  // selection is silently skipped here too.
  function patrolSelected() {
    for (const u of selectedUnits()) {
      const points = [u.order, ...(u.orderQueue || [])]
        .filter(o => o && (o.type === "move" || o.type === "attack-move"))
        .map(o => ({ x: o.x, y: o.y }));
      if (points.length) transport.submitCommand({ t: "patrol", ids: [u.id], pts: points });
    }
  }
  // Form up right where the selection stands, in the player's chosen shape, and hold there —
  // the "protect a formation" stance (engine/commands.js issueHoldFormation), the group-scale
  // sibling of Escort (which protects one external ship instead).
  function formSelected() {
    const ids = selectedUnits().map(u => u.id);
    if (ids.length) transport.submitCommand({ t: "holdFormation", ids, s: game.formation.shape, l: game.formation.leaderPos });
  }
  function selectAllArmy() {
    state.selection = [...state.units.values()]
      .filter(u => u.owner === game.localOwner && UNITS[u.type].role === "combat")
      .map(u => u.id);
  }
  // Cycle to the next worker of yours that's sitting idle (no order, no queued
  // waypoints) — selecting it and centering the camera on it, so a stalled
  // gatherer on a big map is one keypress away instead of a manual hunt.
  function focusIdleWorker() {
    const idle = [...state.units.values()].filter(u =>
      u.owner === game.localOwner && UNITS[u.type]?.role === "worker" && !u.order && (!u.orderQueue || !u.orderQueue.length));
    if (!idle.length) return;
    const w = idle[idleCycle % idle.length];
    idleCycle++;
    state.selection = [w.id];
    centerCamera(w.x, w.y);
    onChange();
  }
  // The building-scale sibling of focusIdleWorker above: cycle to the next completed player
  // production building (BUILDINGS[type].produces) sitting idle — an empty queue, not
  // constructing — selecting it and centering the camera on it. Multiple Barracks are normal
  // mid-game, and an empty queue on one you're not currently looking at is otherwise invisible.
  // Wired to the topbar's "N idle" production chip (main.js) the same way focusIdleWorker is
  // wired to the idle-workers chip.
  function focusIdleProducer() {
    const idle = [...state.buildings.values()].filter(b =>
      b.owner === game.localOwner && !b.constructing && BUILDINGS[b.type]?.produces && b.queue.length === 0);
    if (!idle.length) return;
    const b = idle[idleProducerCycle % idle.length];
    idleProducerCycle++;
    state.selection = [b.id];
    centerCamera(b.x, b.y);
    onChange();
  }
  // Snap the camera to a base — a completed Command Center, else the landing zone. The macro
  // "get me home" key (Space), so a raid on your economy is one press away. A .find() used to
  // always land on the SAME (first-found) Command Center once an expansion existed; repeated
  // presses within DOUBLE_GROUP_MS (the same double-press timing recallGroup already uses for
  // its own centroid re-center) now cycle through every completed CC in turn, sorted by id for a
  // stable order — matching engine/galaxy.js's own id-sorted playerSpaceports precedent.
  function centerOnBase() {
    const ccs = [...state.buildings.values()]
      .filter(b => b.owner === game.localOwner && b.type === "command" && !b.constructing)
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const now = performance.now();
    const cycling = ccs.length > 0 && now - lastBaseAt < DOUBLE_GROUP_MS;
    lastBaseAt = now;
    if (!ccs.length) {
      baseCycle = 0;
      const at = state.map.bases && state.map.bases[game.localOwner];
      if (at) { centerCamera(at.x, at.y); onChange(); }
      return;
    }
    baseCycle = cycling ? (baseCycle + 1) % ccs.length : 0;
    const at = ccs[baseCycle];
    centerCamera(at.x, at.y);
    onChange();
  }
  // Backspace: the standard RTS "jump to last alert" — recenter on wherever the most recent
  // under-attack ping fired (game.lastAttackAt, session.js — written by boot.js's frame-event
  // pump next to supplyBlockedUntil). A no-op before the game's first alert.
  function jumpToLastAttack() {
    if (!game.lastAttackAt) return;
    centerCamera(game.lastAttackAt.x, game.lastAttackAt.y);
    onChange();
  }

  window.addEventListener("keydown", e => {
    const k = e.key.toLowerCase();
    heldKeys.add(k);   // still feeds the WASD/arrow camera pan (kept above the focus guard)
    if (e.repeat) return;
    // Don't hijack keys meant for a FOCUSED control (a HUD button, the Home-confirm modal's
    // buttons, a text input): Space would otherwise e.preventDefault() the button's own
    // activation, and a letter would fire a game command instead of reaching the control.
    // During normal play focus sits on <body>/the canvas, so every hotkey still works.
    const t = e.target;
    if (t && t !== document.body && t !== canvas && typeof t.closest === "function"
        && t.closest("button, input, textarea, select, [tabindex]")) return;
    // O toggles Observer Mode from either side (a no-op outside an Odyssey or a WATCHED AI-vs-AI
    // match — see observer.js's enterObserverMode, which refuses an ordinary skirmish because
    // revealing its fog would just be a cheat), so it must be checked before the "swallow
    // everything else while observing" branch right below, or there'd be no way back out via the
    // keyboard.
    if (k === "o") { toggleObserverMode(); onChange(); return; }
    if (game.observerMode) {
      // Space repurposes to cycling every base on the spectated world (any owner) instead of
      // just the player's own; every other order/build/group hotkey below assumes `state` is
      // what's on screen, which isn't true while spectating a different world — swallow them.
      if (k === " ") { e.preventDefault(); cycleObserverBase(); onChange(); return; }
      // requestExitObserverMode, not the raw exit: a WATCHED match refuses it (see that function's
      // own comment — there's no seat to hand back to), the Odyssey behaves exactly as before.
      if (k === "escape") { requestExitObserverMode(); onChange(); return; }
      return;
    }
    // Match on e.code, not e.key: with Shift held the number row's e.key becomes
    // "!@#…", so only the physical Digit1–9 code is reliable for the bind case.
    const digit = /^Digit([1-9])$/.exec(e.code);
    if (digit) {
      // Shift+digit binds the current selection to a control group; a plain
      // digit recalls it. (Ctrl+digit is the browser's own tab-switch shortcut
      // and can't be reliably suppressed, so Shift is the bind modifier here.)
      if (e.shiftKey) assignGroup(digit[1]);
      else recallGroup(digit[1]);
      onChange();
      return;
    }
    if (k === "x") { stopSelected(); onChange(); return; }
    if (k === "q") { selectAllArmy(); onChange(); return; }
    if (k === "e") { scoutSelected(); onChange(); return; }   // send selected Rangers to auto-scout
    if (k === "a") { setArmed(true); return; }        // arm attack-move; next left-click commits it
    if (k === "h") { holdSelected(); onChange(); return; }   // hold position
    if (k === "r") { patrolSelected(); onChange(); return; }   // convert the current waypoint chain into a looping patrol
    if (k === "f") { formSelected(); onChange(); return; }   // form up in place and hold the shape
    if (k === "escape") { setArmed(false); buildMode = null; onChange(); return; }   // bail out of a pending action
    if (k === "`") { focusIdleWorker(); return; }   // it calls onChange itself
    if (k === " ") { e.preventDefault(); centerOnBase(); return; }   // Space — jump the camera to your base (repeat: cycle bases)
    if (k === "backspace") { e.preventDefault(); jumpToLastAttack(); return; }   // Backspace — jump to the last under-attack alert
    // Positional production/build hotkeys (Z/C/V/B/N): fire the Nth produce/build button the
    // HUD is currently showing (game.hotkeyActions, set by hud.js). click() replays the real
    // button handler, so orders flow through the same queueProduction/startBuild path — the
    // skirmish sim/AI is byte-identical, this is a pure UI shortcut.
    const action = game.hotkeyActions && game.hotkeyActions.find(a => a.key === k);
    if (action) { action.click(); return; }
  }, { signal });
  window.addEventListener("keyup", e => heldKeys.delete(e.key.toLowerCase()), { signal });
  // Browsers don't reliably deliver keyup to a backgrounded tab, so alt-tabbing away while
  // holding a pan key would otherwise leave it stuck "held" -- the camera keeps drifting after
  // you tab back in until you tap that key again. Same hazard the touchcancel handler guards
  // against for touch; this is the keyboard equivalent.
  window.addEventListener("blur", () => heldKeys.clear(), { signal });

  // Only exits build mode on an actual successful placement -- an
  // invalid spot (see engine/colliders.js) or no eligible worker just
  // leaves the ghost up so the player can click again without having to
  // re-open the build menu. The ghost itself (drawBuildGhost in
  // render.js) already shows red/green before they even click.
  //
  // The one call site in this file that genuinely needs the CommandResult, not just fire-and-
  // forget (TASKS.md T-013's own flag): buildMode must stay armed on a rejection so the player
  // can click again, so it can only be cleared once transport.submitCommand's promise actually
  // resolves ok — never optimistically before that. Under loopback/directTransport the
  // mutation (and so the result) is ready before the promise's .then() microtask even runs, so
  // this resolves within the same frame exactly as the old synchronous check did; a real network
  // transport (Phase 3) just makes that gap real, which is exactly what this await-shaped code
  // already tolerates and T-013 will exercise on purpose.
  function placeBuildingAt(p) {
    const buildingType = buildMode.buildingType;
    const worker = state.selection.map(id => state.units.get(id))
      .find(u => u && canBuildCategory(u.type, BUILDINGS[buildingType]?.category));
    if (!worker) { sound.playProductionBlocked(); onChange(); return; }
    transport.submitCommand({ t: "build", worker: worker.id, b: buildingType, x: p.x, y: p.y }).then(result => {
      if (result.ok) buildMode = null;
      else sound.playProductionBlocked();   // rejected (invalid spot) — audibly denied, not silent
      onChange();
    });
  }

  return {
    getDragBox: () => dragBox,
    startBuild(buildingType) { buildMode = { buildingType }; },
    get building() { return buildMode; },
    getBuildGhost() { return buildMode ? { buildingType: buildMode.buildingType, x: lastWorldPos.x, y: lastWorldPos.y } : null; },
    getCamera: () => camera,
    focusIdleWorker,
    // The topbar's "N idle" production chip (main.js) clicks this, mirroring idleWorkersEl's own
    // wiring to focusIdleWorker above.
    focusIdleProducer,
    selectAllArmy: () => { selectAllArmy(); onChange(); },
    // Narrow the current selection to one unit type — the HUD's aggregated type rows
    // are clickable (hud.js), so clicking "12× Skiff" keeps only the Skiffs.
    selectType(type) {
      const ids = state.selection
        .map(id => state.units.get(id)).filter(u => u && u.type === type).map(u => u.id);
      if (ids.length) { state.selection = ids; sound.playSelect(); onChange(); }
    },
    stopSelected: () => { stopSelected(); onChange(); },
    scoutSelected: () => { scoutSelected(); onChange(); },
    holdSelected: () => { holdSelected(); onChange(); },
    patrolSelected: () => { patrolSelected(); onChange(); },
    formSelected: () => { formSelected(); onChange(); },
    // Recall a group from the HUD chip (touch has no number row); same double-press-recenter
    // as the keyboard path.
    recallGroup: digit => { recallGroup(digit); onChange(); },
    // Live per-group counts for the HUD chip row: [{ digit, count }] over bound groups with
    // at least one surviving unit, in digit order.
    groupCounts() {
      const g = groups();
      return Object.keys(g).sort()
        .map(d => ({ digit: d, count: alivePlayerUnitIds(g[d]).length }))
        .filter(e => e.count > 0);
    },
    // Attack-move as a HUD button (touch has no A key): toggle it, cancel it, and
    // read the armed state so the button can show as active.
    toggleAttackMove: () => { setArmed(!attackMoveArmed); onChange(); },
    get attackArmed() { return attackMoveArmed; },
    tickCamera(dt) {
      // Observer Mode pans its OWN camera off the same held-key set (see observer.js's
      // tickObserverCamera) — the real camera/edge-pan below must stay frozen meanwhile, or
      // resuming normal play would find the view had silently drifted while you were spectating.
      if (game.observerMode) { tickObserverCamera(dt, heldKeys); return; }
      let dx = edgePan[0], dy = edgePan[1];
      for (const key of heldKeys) {
        const dir = PAN_KEYS[key];
        if (dir) { dx += dir[0]; dy += dir[1]; }
      }
      const { vw, vh } = viewport();
      panCamera(camera, state.map, vw, vh, dx, dy, dt);
    },
    // See cancelGesture above: call this before showing any modal that pauses the loop and
    // covers the canvas (a landing pick, the starmap), so a drag armed before it opened can't
    // resolve later against the world hidden behind it.
    cancelGesture,
    // Removes every listener this call added — without this, starting a
    // new game (map picker -> startGame again) would stack a second,
    // third, ... full set of handlers on the same canvas/window, each
    // reacting to one real click with a growing pile of stale ones.
    destroy() { controller.abort(); },
  };
}
