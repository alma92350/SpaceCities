/* ============================================================
   liveMatchStorage.js — T-036's own client-side half of "reclaim with the seat token": a tiny,
   DOM-free localStorage wrapper remembering the one live network match this browser is currently
   seated in ({matchId, owner, token}), so a reload or a crashed tab can silently reconnect on the
   next page load instead of dumping the player back at map-select. net/wsWorkerTransport.js's own
   authorizeSeat (tools/serve.js) already accepts a fresh WebSocket connection carrying a seat's
   real token as a genuine reclaim (server/lobby.js's reclaimSeat) — this file only has to make that
   token available again after a reload; there is no separate HTTP "rejoin" endpoint to call.

   Split out of lobbyScreen.js (which owns the actual join/reconnect UI) the same reason
   server/lobby.js is split from tools/serve.js's own wiring: a pure, headless module main.js's own
   top-level kickoff can check SYNCHRONOUSLY, with zero risk of joining lobbyScreen.js's own
   documented import cycle (that file statically pulls in boot.js/setup.js/session.js — main.js
   needs an answer before it even decides whether to load any of that).

   Same read-with-try/catch idiom saveload.js's own `read()` already established: a bare
   `localStorage` reference (never `typeof`/`globalThis`-guarded), so a Node import or a browser
   with storage disabled/unavailable degrades to "no saved match" rather than throwing — see that
   file's own header and test/saveload.test.js's "environment sanity" test for why a bare reference,
   not a typeof guard, is the right shape here.
   ============================================================ */

"use strict";

const KEY = "stellarfrontier.liveMatch.v1";

/** @returns {{matchId:string, owner:string, token:string}|null} null on anything but a well-formed entry */
export function loadLiveMatch() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.matchId !== "string" || typeof parsed.owner !== "string" || typeof parsed.token !== "string") return null;
    return { matchId: parsed.matchId, owner: parsed.owner, token: parsed.token };
  } catch { return null; }
}

/** @param {{matchId:string, owner:string, token:string}} entry - overwrites whatever was saved before */
export function saveLiveMatch(entry) {
  try { localStorage.setItem(KEY, JSON.stringify(entry)); } catch { /* best-effort — a reload just won't auto-rejoin */ }
}

export function clearLiveMatch() {
  try { localStorage.removeItem(KEY); } catch { /* nothing to clear if storage never worked anyway */ }
}
