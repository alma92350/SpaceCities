/* ============================================================
   The live game session — the single mutable holder the UI modules read
   and boot.js reassigns. Before the split these were module-level `let`
   bindings in main.js that every function closed over; now they live on one
   shared object so hud / boot / save / the top-level listeners all see the
   same current game across a "choose another battlefield" restart.

   Read at CALL time (never destructured at module scope), exactly as the old
   closure vars were, so a fresh game swapped in by bootState is picked up by
   every consumer automatically.
   ============================================================ */

"use strict";

export const game = {
  state: null,   // the current engine game state (engine/state.js), or null on the splash screen
  // T-030 (ADR-0008's own "client localOwner seam", the largest single work item its Phase 1 row
  // names): which owner id in `state.owners` IS the local human at this browser. Every existing
  // boot path — single-player, Odyssey, a competition fixture, a spectated match — is UNCHANGED
  // by this seam and always leaves it at the default "player", exactly the literal every one of
  // those call sites hardcoded before this field existed. It becomes "ai" only for a live
  // multiplayer connection's SECOND seat, once a lobby/join flow (Phase 4) actually sets it from
  // the transport's own reported seat — ADR-0008's Option B interim design keeps state.owners as
  // the verbatim ["player","ai"] pair, so seat B's local human is genuinely owner "ai" there, not
  // a UI relabeling. UI code reads this — never the literal "player" — for "is this mine",
  // reserving the literal "ai" for the ACTUAL Odyssey/skirmish AI opponent's own logic (untouched,
  // still real single-player AI code) and for the handful of sites ADR-0008 calls out as needing
  // individual redesign rather than a mechanical seam (an AI-difficulty display has no meaning
  // once the "other side" is a live human, for instance).
  localOwner: "player",
  input: null,   // the current input controller (input.js attachInput), or null before a game
  // The ADR-0004 seam every command-issuing UI module (input.js, inputCommands.js,
  // hudSelection.js) submits through — never null once a game is running, though which kind it
  // is varies with boot.js's own T-012 scoping: a real, server/session.js-backed
  // net/loopback.js transport for an ordinary skirmish, a live competition fixture, or a
  // loaded skirmish save; a net/directTransport.js adapter (ADR-0013) with no session behind it
  // — applying commands straight to `state`, no ownership/fog validation, no tick of its own —
  // for every boot path T-012 doesn't port yet (Odyssey, a scenario/raider/bounty, a spectated
  // match). Set by bootState/focusActivePlanet next to `state`/`input` above; UI code never
  // branches on which kind this is, by design (see ADR-0013).
  transport: null,
  // The Odyssey galaxy (engine/galaxy.js) when in open-world mode, else null. In
  // Odyssey `state` is the active planet's state = galaxy.planets.get(activeId);
  // credits + the other planets live on the galaxy. Read at call time like the rest.
  galaxy: null,
  // Which COMPETITION FIXTURE the running match belongs to, or null for an ordinary skirmish —
  // `{ kind: "gauntlet", index, opponent, humanName }` (docs/competitions-and-elo.md Phase 4).
  // Set by boot.js's startCompetitionMatch right after bootState (which clears it, exactly like
  // `galaxy` above), read at game-over by competition.js's captureCompetitionResult — which
  // records the result into the ledger and clears this again, so one finished match can only ever
  // be rated once — and by saveload.js's Home confirm, which has to warn that leaving a live
  // gauntlet match forfeits it. Never part of the sim or the persisted save: like `galaxy`, it
  // says which run this state belongs to, not anything about the state itself.
  competition: null,
  // Timestamp until which the supply readout flashes red after a blocked
  // production attempt: written by boot.js's frame-event pump, read by hud.js's
  // renderHUD. Kept here because it crosses that module boundary.
  supplyBlockedUntil: 0,
  // World-space {x,y} of the most recent under-attack alert, or null before the first one this
  // game — written by boot.js's frame-event pump (triggerUnderAttack), read by input.js's
  // Backspace "jump to last alert" keybind and by boot.js's own under-attack banner click
  // handler. Kept here, next to supplyBlockedUntil above, for the same reason: it crosses that
  // same module boundary.
  lastAttackAt: null,
  // { id, charge } of the player's Antimatter Gate as last observed by hud.js's renderHUD (P7
  // "Persistent Gate charge strip"), or null before the first sighting — lets the chip tell
  // "charge climbed since the last tick" from "charge is stalled" without engine/ carrying
  // UI-only comparison state (the engine side only ever knows the CURRENT charge, on the
  // building itself). Keyed by wonder id, not just the charge float, so a Gate razed mid-charge
  // and rebuilt (engine/wonder.js's own header documents that risk) starts its own clean
  // comparison instead of reading as stalled against the dead Gate's final charge. Reset by
  // hud.js's resetPanelSignature() — the same per-boot/per-jump reset the topbar signature
  // itself already goes through, so a new world's Gate never inherits the old one's charge
  // history (the exact bug class boot.js's resetWorldUiBookkeeping comment documents for
  // gateMilestone/lastAttackAt).
  lastGateCharge: null,
  // Live per-world alert badges for the Odyssey starmap (P6 "Starmap live colony ledger"):
  // planetId -> {type, at}, written by boot.js's notifyColony for every attack/hostile/lost
  // notification a background colony raises (engine/galaxy.js sweepColonies) — the SAME trigger
  // that already fires the transient toast, just remembered here too so starmap.js's
  // renderStarmap can badge a world at a glance instead of relying on whichever toast the player
  // happened to catch. `at` is a performance.now() timestamp; starmap.js treats an attack/hostile
  // entry as "live" only within its own ~30s window, while a "lost" entry persists as a badge
  // until boot.js's focusActivePlanet clears that ONE planet's entry — i.e. until the player
  // actually jumps back and looks. Reset to {} on every fresh boot (bootState), like `groups`
  // below; never part of the deterministic sim or the persisted save (same reasoning as
  // lastAttackAt above — this crosses the boot.js/starmap.js module boundary, nothing more).
  colonyAlerts: {},
  // Control groups, keyed per planet id → { digit: [unitIds] }. Lives on the session (not
  // in the per-game input controller) so a group survives an Odyssey jump — which tears down
  // and rebuilds attachInput — and can be shown in the HUD and persisted UI-side. Never part
  // of the deterministic sim; kept out of engine/persist.js's sanitized save payload.
  groups: {},
  // The player's current formation choice (engine/formation.js FORMATION_SHAPES /
  // LEADER_POSITIONS) — a UI preference, not per-game state, so it's fine to just carry over
  // across a "choose another battlefield" restart like any other setup preference. Read by
  // input.js when issuing a move/attack-move/Hold-Formation order, and mutated directly by
  // hudSelection.js's formation picker buttons.
  formation: { shape: "grid", leaderPos: "front" },
  // Which collapsible panel sections (the Build submenu's per-category groups, the CC/Barracks
  // Produce lists, the Refinery/Datacenter Research lists, Market, the freighter Cargo list, the
  // Spaceport Jump list, …) the player has manually collapsed — a UI preference like `formation`
  // above, not per-unit/per-game state, so collapsing one keeps it collapsed across every later
  // selection until toggled back. A key ABSENT from the set means "expanded" (starts open,
  // unchanged behaviour) — so a new collapsible section needs zero migration code here, it just
  // starts expanded like everything else. Keys are the stable strings passed to hudSelection.js's
  // sectionToggle(), e.g. "build:economy", "cc:produce", "market".
  collapsedSections: new Set(),
  // Observer Mode (observer.js): a free-look, read-only spectator over the Odyssey galaxy —
  // fog reveals, any world/base is a free camera jump, no orders can be issued. Never touches
  // `state`/`galaxy.activeId` or the real input camera, so exiting always resumes normal play
  // exactly where it was left; never part of the deterministic sim or the persisted save.
  observerMode: false,
  // Which world is currently being spectated while observerMode is on — a planetId, or null
  // when observerMode is off. Defaults to the real active world on entry.
  spectateId: null,
  // The throwaway state observer.js is showing for a DORMANT world (engine/galaxy.js
  // previewPlanet), or null whenever the spectated world is one the galaxy is really simulating.
  // Only a seeded handful of worlds are alive from turn one (BACKGROUND_WORLDS), but Observer
  // Mode's promise is a free look at ANY world — so a dormant one is shown as the pristine world
  // it would be on arrival, WITHOUT waking it. Never ticked, never registered on the galaxy,
  // never saved: the read-only guarantee above holds.
  spectatePreview: null,
  // The observer's own camera (camera.js createCamera shape), separate from the real
  // game.input camera so panning/zooming while spectating never disturbs normal play's view —
  // and so clamping uses whichever world's map is actually being looked at, not the active one's.
  observerCamera: null,
  // A WATCHED AI-vs-AI exhibition match (docs/competitions-and-elo.md Phase 5), or null for every
  // ordinary game — `{ aName, bName, world, seed, difficulty, matchTimeLimit, onLeave }`. Set by
  // boot.js's startSpectatedMatch right after bootState (which clears it, exactly like `galaxy`
  // and `competition` above) and read in three places: boot.js's loop, which drives BOTH seats
  // through tools/selfplay.js's tickSelfPlay instead of the ordinary tick(); observer.js, which
  // lets Observer Mode be entered without an Odyssey when — and only when — this is set (a
  // spectated match is one the human is NOT playing, so revealing its fog is not a cheat); and the
  // spectate UI (observerPanel.js), whose Leave button calls `onLeave` rather than importing
  // competition.js and closing a new module cycle. Never part of the sim or the persisted save —
  // saveShape.js's resumableMode refuses to checkpoint a match this flag marks.
  spectateMatch: null,
  // The spectated match's speed multiplier — one of observer.js's SPECTATE_SPEEDS (1/2/4/8).
  // engine/loop.js reads it live through its `speed` option, and scales the SIM TIME a real second
  // buys, never the fixed timestep itself. Ignored (pinned to 1) whenever spectateMatch is null,
  // so an ordinary game can never inherit a leftover multiplier.
  spectateSpeed: 1,
};
