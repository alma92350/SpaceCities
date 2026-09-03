import { test } from "node:test";
import assert from "node:assert/strict";
import { isGalaxySave, resumableMode } from "../saveShape.js";

// These two decisions live in saveShape.js precisely so they can be tested without the DOM: a
// wrong branch here is a data-loss bug — an Odyssey save booted as a skirmish, or a scenario
// silently checkpointed over the player's real game.

test("isGalaxySave: a save with a planets array is an Odyssey galaxy, everything else a skirmish", () => {
  assert.equal(isGalaxySave({ v: 1, planets: [{ planetId: "ferros" }] }), true, "galaxy: has planets[]");
  assert.equal(isGalaxySave({ v: 1, planets: [] }), true, "even an empty planets array is the galaxy shape");
  assert.equal(isGalaxySave({ v: 1, seed: 5, units: [] }), false, "a skirmish carries no planets");
  assert.equal(isGalaxySave({ planets: { ferros: {} } }), false, "planets must be an ARRAY, not an object");
  assert.equal(isGalaxySave(null), false, "null is not a galaxy");
  assert.equal(isGalaxySave(undefined), false, "undefined is not a galaxy");
});

test("resumableMode: reports the checkpoint mode, or null when nothing is resumable", () => {
  assert.equal(resumableMode({ state: { over: false } }), "skirmish", "a live skirmish resumes as a skirmish");
  assert.equal(resumableMode({ state: { over: false }, galaxy: { seed: 1 } }), "galaxy",
    "a live game with a galaxy resumes as an Odyssey");

  assert.equal(resumableMode({ state: null }), null, "no state → nothing to resume");
  assert.equal(resumableMode({}), null, "an empty game handle → nothing to resume");
  assert.equal(resumableMode(), null, "no game handle at all → nothing to resume");
  assert.equal(resumableMode({ state: { over: true } }), null, "a finished match is not resumable");
  assert.equal(resumableMode({ state: { scenario: "escort" } }), null, "a scripted scenario can't be checkpointed");
  assert.equal(resumableMode({ state: { over: true }, galaxy: { seed: 1 } }), null,
    "a finished game is not resumable even in Odyssey mode");
});

test("resumableMode: a SPECTATED AI-vs-AI match is never checkpointed", () => {
  // docs/competitions-and-elo.md Phase 5. A watched match isn't the player's game: both seats are
  // AI-driven, and a resumed autosave would come back as an ordinary skirmish with the "player"
  // seat suddenly unmanned (game.spectateMatch, and with it tickSelfPlay, does not survive a
  // reload). Refusing the checkpoint is the honest answer — the same call a scenario already gets.
  assert.equal(resumableMode({ state: { over: false }, spectateMatch: { aName: "A", bName: "B" } }), null,
    "a spectated match is not the player's game to resume");
  assert.equal(resumableMode({ state: { over: false }, spectateMatch: null }), "skirmish",
    "…and an ordinary skirmish is untouched by that rule");
});

test("resumableMode: T-037 — a live network SPECTATOR is never checkpointed either", () => {
  // A real, found-by-a-real-browser bug: a network spectator's own reassembled state has
  // fog:null (engine/projection.js's reassembleSpectatorProjection — there is no seat to compute
  // fog FOR), and engine/persist.js's own serializer reads state.fog.explored unconditionally —
  // autoSave's beforeunload/hidden handler crashed with a real page error the instant a spectator
  // closed the tab, since nothing had ever told it this session has nothing resumable either.
  // Same reasoning as spectateMatch above, one flag over: a spectator has no seat of their own
  // to resume as, and the state it would try to serialize isn't even save-shaped.
  assert.equal(resumableMode({ state: { over: false }, networkSpectate: true }), null,
    "a live network spectator has nothing of their own to resume");
  assert.equal(resumableMode({ state: { over: false }, networkSpectate: false }), "skirmish",
    "…and an ordinary skirmish is untouched by that rule");
});
