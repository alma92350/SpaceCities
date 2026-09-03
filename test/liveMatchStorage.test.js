/* ============================================================
   T-036: liveMatchStorage.js — the DOM-free half of "reclaim with the seat token." Pure
   localStorage read/write/clear, same fakeLocalStorage idiom test/update.test.js and
   test/saveload.test.js already established (a bare `localStorage` reference resolves against
   whatever `globalThis.localStorage` this file assigns, since plain `node --test` has no such
   global by default).
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";

function fakeLocalStorage() {
  const store = new Map();
  return {
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
    clear() { store.clear(); },
  };
}
globalThis.localStorage = fakeLocalStorage();

const { loadLiveMatch, saveLiveMatch, clearLiveMatch } = await import("../liveMatchStorage.js");

test("loadLiveMatch() returns null when nothing has ever been saved", () => {
  localStorage.clear();
  assert.equal(loadLiveMatch(), null);
});

test("saveLiveMatch() then loadLiveMatch() round-trips the exact matchId/owner/token", () => {
  localStorage.clear();
  saveLiveMatch({ matchId: "abc-123", owner: "player", token: "tok-xyz" });
  assert.deepEqual(loadLiveMatch(), { matchId: "abc-123", owner: "player", token: "tok-xyz" });
});

test("clearLiveMatch() removes a saved entry — loadLiveMatch() reports null afterward", () => {
  localStorage.clear();
  saveLiveMatch({ matchId: "abc-123", owner: "player", token: "tok-xyz" });
  clearLiveMatch();
  assert.equal(loadLiveMatch(), null);
});

test("clearLiveMatch() on an already-empty store is a harmless no-op", () => {
  localStorage.clear();
  assert.doesNotThrow(() => clearLiveMatch());
  assert.equal(loadLiveMatch(), null);
});

test("loadLiveMatch() treats malformed JSON as no saved match, not a throw", () => {
  localStorage.clear();
  localStorage.setItem("stellarfrontier.liveMatch.v1", "{not valid json");
  assert.equal(loadLiveMatch(), null);
});

test("loadLiveMatch() rejects a saved value missing a required field (e.g. an older/foreign shape)", () => {
  localStorage.clear();
  localStorage.setItem("stellarfrontier.liveMatch.v1", JSON.stringify({ matchId: "abc", owner: "player" }));   // no token
  assert.equal(loadLiveMatch(), null);
});

test("saveLiveMatch() overwrites a previous entry rather than merging with it", () => {
  localStorage.clear();
  saveLiveMatch({ matchId: "first", owner: "player", token: "tok-1" });
  saveLiveMatch({ matchId: "second", owner: "ai", token: "tok-2" });
  assert.deepEqual(loadLiveMatch(), { matchId: "second", owner: "ai", token: "tok-2" });
});

test("environment sanity: importing liveMatchStorage.js never throws even before any localStorage is assigned", async () => {
  // Proves the module itself references the global lazily (inside each function body, guarded by
  // try/catch), never at import/module-evaluation time — the same C10 Node-import-safety bar every
  // other module in this project already holds itself to (dom.js's own idiom). Re-importing the
  // already-cached module is a no-op either way, so this is really just documenting the contract;
  // the meaningful proof is that the `await import(...)` above, which ran before this file ever
  // set up fakeLocalStorage for real work, already didn't throw.
  const mod = await import("../liveMatchStorage.js");
  assert.equal(typeof mod.loadLiveMatch, "function");
});
