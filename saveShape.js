/* ============================================================
   The two save-format DECISIONS, factored out of saveload.js as pure functions:
   no DOM, no engine, no imports — so they're directly unit-testable under Node and
   can't drift from the branches the real save/load paths take. Getting either wrong
   is a data-loss bug (an Odyssey loaded as a skirmish, a scenario silently
   checkpointed), so they're worth pinning down on their own.
   ============================================================ */

"use strict";

// A parsed save file is an Odyssey GALAXY iff it carries a `planets` array; otherwise it's a
// single-world skirmish. This is exactly the fork the file-import path takes before handing the
// object to the matching deserializer.
export function isGalaxySave(parsed) {
  return !!parsed && Array.isArray(parsed.planets);
}

// Given the session's game handle ({ state, galaxy, spectateMatch, networkSpectate }), what the
// autosave/checkpoint should write — or null when there's nothing resumable: no state at all, a
// finished match, a scripted scenario (scenarios can't be saved), a SPECTATED AI-vs-AI exhibition
// match, or a live network SPECTATOR. Returns the MODE only; the caller pairs it with the storage
// key and serializer.
//
// The spectate rule (docs/competitions-and-elo.md Phase 5) is the same call a scenario gets, for a
// stronger reason: a watched match isn't the player's game at all. Both seats are AI-driven, and
// what makes the "player" seat AI-driven is game.spectateMatch — a session flag, not save data.
// Checkpointing one would let "Continue" resume it as an ordinary skirmish whose player seat is
// suddenly unmanned, which is worse than having nothing to continue.
//
// T-037's networkSpectate gets the identical refusal, for an even more direct reason: a real,
// found-by-a-real-browser bug — a live network spectator's own reassembled state has fog:null
// (engine/projection.js's reassembleSpectatorProjection; there is no seat to compute fog FOR), and
// engine/persist.js's own serializer reads state.fog.explored unconditionally. Without this,
// autoSave's beforeunload/hidden handler threw a real page error the instant a spectator closed
// the tab or switched away — this file's own job is exactly to stop that class of mismatch before
// it reaches the serializer at all, the same as the scenario/spectateMatch checks already do.
// T-034 (networkLive) is the SAME refusal for the same reason, one step wider: a live network
// PLAYER's state is a reassembled projection too (engine/projection.js sends entities and
// resources, never the per-owner fog structures or controllers a save needs), so serPlanet threw
// `Cannot read properties of undefined (reading 'player')` on state.fogs[id] the moment autoSave's
// 12s timer fired — in every live match, in both clients, for as long as multiplayer has existed.
// The spectator half of this rule was found by a real browser; this half was found by a real
// SECOND browser (tools/smokeMultiplayer.js), which is the only thing that can see it.
//
// It is also the semantically right answer rather than merely the safe one. A live match lives on
// the server, and rejoining one already has its own mechanism: liveMatchStorage.js's
// {matchId, owner, token} and lobbyScreen.js's rejoinLiveMatch. A localStorage skirmish checkpoint
// of a live match would offer "Continue" into a half-state single-player game that never existed.
export function resumableMode({ state, galaxy, spectateMatch, networkSpectate, networkLive } = {}) {
  if (!state || state.over || state.scenario || spectateMatch || networkSpectate || networkLive) return null;
  return galaxy ? "galaxy" : "skirmish";
}
