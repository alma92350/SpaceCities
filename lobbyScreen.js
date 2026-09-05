/* ============================================================
   lobbyScreen.js — T-034's own client entry point: host a match or join one via a shareable link,
   over the real HTTP+WebSocket lobby server/lobby.js and tools/serve.js's /api/matches now serve.
   Named lobbyScreen.js, not lobby.js, because server/lobby.js already owns that name for the
   server-side MODEL this file is only ever a CLIENT of — the two must never be confused for one.

   FLOW:
     Host: renderLobbyScreen() -> pick world/size/resources/length -> POST /api/matches -> show a
       shareable link (?join=<matchId>) -> "Start playing" connects over WS as seat 0.
     Join (by link): main.js detects ?join=<matchId> in the URL at boot and calls
       renderLobbyScreen({ joinMatchId }) instead of the ordinary map-select screen -> "Join match"
       POSTs /api/matches/:id/join -> connects over WS as whichever seat that returns.
     Join (browsing): the open-matches list (GET /api/matches) offers the same join flow without a
       link at all — a cheap, reasonable addition once the endpoint already exists for the link flow.
     Rejoin (T-036): main.js's own boot-time check finds a {matchId, owner, token} a PREVIOUS
       joinLive() saved (liveMatchStorage.js) and calls rejoinLiveMatch() instead of the ordinary
       map-select screen — the same joinLive() under the hood, just fed remembered credentials
       instead of a fresh POST's response.
     Watch (T-037, FR-7): the SAME shareable link a player uses also offers "👁 Watch" on the
       renderJoinByLink card — spectateLive() connects over WS as a read-only spectator
       (net/wsSpectatorTransport.js's own `?spectate=1`, no seat/token at all) and immediately
       enters Observer Mode (observer.js), the same free-camera/full-vision/no-orders view a
       watched local AI-vs-AI exhibition already gets, just fed by a real network match. The host's
       own card offers a "Allow spectators" checkbox (POST /api/matches's spectatorsEnabled).

   SCOPE, same discipline every task in this phase states up front: FR-3 (AI fill for unfilled open
   seats) and FR-4 (start conditions) are T-035's own job, not this file's — a match is simply live
   the moment it's created (tools/serve.js's own scope note), and this screen never waits for a
   second seat to fill before letting the host start playing.
   ============================================================ */

"use strict";

import { lobbyScreenEl, mapSelectEl } from "./dom.js";
import { PLANETS } from "./data.js";
import { MAP_CHOICES, SIZE_OPTIONS, RESOURCE_OPTIONS, MATCH_LENGTH_OPTIONS, renderMapSelect } from "./setup.js";
import { createWsClientTransport } from "./net/wsClientTransport.js";
import { createWsSpectatorTransport } from "./net/wsSpectatorTransport.js";
import { bootState } from "./boot.js";
import { enterObserverMode } from "./observer.js";
import { game } from "./session.js";
import * as sound from "./sound.js";
import { saveLiveMatch, clearLiveMatch } from "./liveMatchStorage.js";
import { initChatPanel } from "./chat.js";

async function apiPost(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  const json = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, json };
}
async function apiGet(path) {
  const res = await fetch(path);
  const json = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, json };
}

function wsUrlFor(matchId, seat, token) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws?match=${encodeURIComponent(matchId)}&seat=${encodeURIComponent(seat)}&token=${encodeURIComponent(token)}`;
}

function wsSpectateUrlFor(matchId) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws?match=${encodeURIComponent(matchId)}&spectate=1`;
}

function shareLink(matchId) {
  const url = new URL(location.href);
  url.search = `?join=${encodeURIComponent(matchId)}`;
  return url.toString();
}

// Folds a freshly-reconstructed wire state onto the SAME live object bootState wired input/camera/
// control-groups to, field by field — never replaces game.state's own identity. Necessary because
// net/wsClientTransport.js's reassembleProjection rebuilds a brand-new object (new Maps included)
// on every "state" push, unlike single-player's own createSession, whose ONE state object is
// mutated in place for the whole match; input.js's attachInput captures a `state` reference at
// bootState time (T-034's own boot.js fix explains why this file, not that one, owns applying
// pushes: nothing ticks locally for a live network transport, so nothing else ever touches
// game.state again after boot without this).
function applyLiveState(live, fresh) {
  for (const key of Object.keys(fresh)) live[key] = fresh[key];
}

// Connects over a real WebSocket as the given seat and hands off into the running match, exactly
// the same bootState() every other boot path (startGame, loadGame, ...) ends at — see boot.js's
// own header. game.localOwner (T-030's own seam) is set BEFORE bootState, since bootState reads it
// immediately (camera framing on the local seat's own base). The ongoing onEvent subscription is
// registered only AFTER bootState has actually set game.state, so applyLiveState never has a stale
// or wrong object to fold onto.
// T-060 (ADR-0010): the Space this game is deployed to sleeps after 48h idle and returns a 503
// until it wakes — every joinLive() caller below shares this ONE connection call, so fixing the
// "first visitor after idle sees a loading state, not an error" gap here fixes it everywhere at
// once, rather than needing each host/join/rejoin call site to remember its own retry handling.
async function connectLive(matchId, owner, token, statusEl) {
  return createWsClientTransport(wsUrlFor(matchId, owner, token), {
    initialConnectRetry: {
      onRetry(attempt, delayMs) {
        if (statusEl) statusEl.textContent = `Waking up the game server… (attempt ${attempt}, retrying in ${Math.round(delayMs / 1000)}s)`;
      },
    },
  });
}

async function joinLive(matchId, owner, token, statusEl) {
  if (statusEl) statusEl.textContent = "Connecting…";
  let transport;
  try {
    transport = await connectLive(matchId, owner, token, statusEl);
  } catch (err) {
    if (statusEl) statusEl.textContent = "Could not reach the game server. Please try again.";
    throw err;
  }
  const firstState = await new Promise(resolve => { transport.onEvent(e => { if (e.type === "state") resolve(e.state); }); });
  sound.unlockAudio();   // a real user gesture (the Host/Join click) led here — safe to start audio now
  game.localOwner = owner;
  lobbyScreenEl.classList.add("hidden");
  // T-036: remembered so a reload/crash mid-match can silently reconnect (main.js's own boot-time
  // check) instead of dumping the player back at map-select — net/wsWorkerTransport.js's
  // authorizeSeat already treats a fresh connection carrying this exact token as a legitimate
  // reclaim, so there is nothing else a rejoin needs beyond what's saved here. Cleared on either of
  // the two ways this seat's own tenancy of the match legitimately ends: the player closes the
  // transport (wrapped below — covers boot.js's restartToMapSelect, the one choke point every
  // voluntary leave already funnels through), or the match itself ends while still connected (the
  // over:true branch in the onEvent handler below) — a finished match's worker stops ticking
  // entirely (T-035) and would never answer a later reconnect attempt with a first state push.
  saveLiveMatch({ matchId, owner, token });
  const closeTransport = transport.close.bind(transport);
  transport.close = () => { clearLiveMatch(); closeTransport(); };
  bootState(firstState, { intro: true, transport });
  initChatPanel();   // T-038 — after bootState, same as everywhere else here: game.transport must already be this one
  transport.onEvent(e => {
    if (e.type !== "state") return;
    applyLiveState(game.state, e.state);
    if (e.state.over) clearLiveMatch();
  });
}

// T-037 (FR-7): connects as a READ-ONLY spectator and hands off into Observer Mode — the same
// free-camera, full-vision, no-orders view boot.js's own startSpectatedMatch already gives a
// watched local AI-vs-AI exhibition, just fed by a REAL live network match instead. Deliberately
// NOT joinLive: a spectator has no seat and no token — nothing to persist for a T-036-style
// reclaim (liveMatchStorage.js is seat-specific by design) — and createWsSpectatorTransport's own
// submitCommand is a pure no-op regardless, so handing it to bootState/attachInput uniformly is
// still safe even though nothing issued through it could ever reach the worker.
// game.localOwner = null (not a real seat, T-030's own seam has nothing to point at) is set BEFORE
// bootState, same reason joinLive's own comment gives (bootState's camera-open code reads it
// immediately). game.networkSpectate is the OPPOSITE ordering, same as spectateMatch/competition
// elsewhere in this file's own family: bootState clears it to false internally (its own header:
// "cleared by default; lobbyScreen.js's spectateLive re-sets this right after this returns"), so
// it must be set AFTER bootState returns, not before — setting it first would just get wiped out
// by that same reset. enterObserverMode() runs right after, exactly where startSpectatedMatch
// already calls it, and reads networkSpectate as part of its own gate.
async function spectateLive(matchId, statusEl) {
  if (statusEl) statusEl.textContent = "Connecting…";
  const transport = await createWsSpectatorTransport(wsSpectateUrlFor(matchId));
  const firstState = await new Promise(resolve => { transport.onEvent(e => { if (e.type === "state") resolve(e.state); }); });
  sound.unlockAudio();   // a real user gesture (the Watch click) led here — safe to start audio now
  game.localOwner = null;
  lobbyScreenEl.classList.add("hidden");
  bootState(firstState, { intro: false, transport });   // no objectives strip — a spectator has no checklist of their own
  game.networkSpectate = true;
  enterObserverMode();
  initChatPanel();   // T-038 — after networkSpectate is set: initChatPanel's own gate reads it (no sendChat here to key off instead)
  transport.onEvent(e => { if (e.type === "state") applyLiveState(game.state, e.state); });
}

// T-036: called from main.js's own boot-time check (a saved {matchId, owner, token} survived a
// reload) — the same joinLive() every fresh host/join click already uses, so a rejoin is simply
// "connect again with the credentials we already have," never a separate code path. A failure
// (the match ended, the server restarted with nothing to recover, or the token was somehow no
// longer valid) clears the stale entry and falls back to the ordinary map-select screen — the exact
// same screen a player who'd never had a saved match at all would have landed on.
export async function rejoinLiveMatch(entry) {
  if (!lobbyScreenEl) return;   // import-safe under Node (dom.js idiom)
  if (mapSelectEl) mapSelectEl.classList.add("hidden");
  lobbyScreenEl.classList.remove("hidden");
  lobbyScreenEl.innerHTML = "";
  const title = document.createElement("h2");
  title.textContent = "🌐 Multiplayer";
  lobbyScreenEl.appendChild(title);
  const status = document.createElement("p");
  status.className = "setup-hint";
  status.textContent = "Reconnecting to your match…";
  lobbyScreenEl.appendChild(status);
  try {
    await joinLive(entry.matchId, entry.owner, entry.token, status);
  } catch {
    clearLiveMatch();
    lobbyScreenEl.classList.add("hidden");
    renderMapSelect();
  }
}

function planetOptionsInto(select) {
  for (const id of MAP_CHOICES) {
    const p = PLANETS.find(pl => pl.id === id);
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = p ? p.name : id;
    select.appendChild(opt);
  }
}

function dialSelectInto(container, label, options) {
  const row = document.createElement("label");
  row.className = "lobby-row";
  row.textContent = label;
  const select = document.createElement("select");
  for (const o of options) {
    const opt = document.createElement("option");
    opt.value = String(o.mult);
    opt.textContent = o.note ? `${o.label} — ${o.note}` : o.label;
    select.appendChild(opt);
  }
  row.appendChild(select);
  container.appendChild(row);
  return select;
}

function renderHostCard(container) {
  const card = document.createElement("div");
  card.className = "setup lobby-card";
  const h = document.createElement("h3");
  h.className = "cards-heading";
  h.textContent = "Host a match";
  card.appendChild(h);

  const planetRow = document.createElement("label");
  planetRow.className = "lobby-row";
  planetRow.textContent = "World";
  const planetSelect = document.createElement("select");
  planetOptionsInto(planetSelect);
  planetRow.appendChild(planetSelect);
  card.appendChild(planetRow);

  const sizeSelect = dialSelectInto(card, "Map size", SIZE_OPTIONS);
  const resourceSelect = dialSelectInto(card, "Resources", RESOURCE_OPTIONS);
  const lengthSelect = dialSelectInto(card, "Match length", MATCH_LENGTH_OPTIONS);

  // T-037 (FR-7): "unless the host has disabled spectators" — on by default (an unchecked box is
  // the ONE thing that changes today's behavior, so the default matches what every match already
  // did before this task existed).
  const spectatorsRow = document.createElement("label");
  spectatorsRow.className = "lobby-row";
  const spectatorsCheckbox = document.createElement("input");
  spectatorsCheckbox.type = "checkbox";
  spectatorsCheckbox.checked = true;
  spectatorsRow.appendChild(spectatorsCheckbox);
  spectatorsRow.appendChild(document.createTextNode(" Allow spectators"));
  card.appendChild(spectatorsRow);

  const status = document.createElement("p");
  status.className = "setup-hint";
  card.appendChild(status);

  const linkRow = document.createElement("div");
  linkRow.className = "lobby-link-row hidden";
  const linkInput = document.createElement("input");
  linkInput.type = "text";
  linkInput.readOnly = true;
  linkInput.className = "lobby-link-input";
  const copyBtn = document.createElement("button");
  copyBtn.className = "btn";
  copyBtn.type = "button";
  copyBtn.textContent = "Copy link";
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(linkInput.value);
      copyBtn.textContent = "Copied!";
      setTimeout(() => { copyBtn.textContent = "Copy link"; }, 1500);
    } catch { linkInput.select(); }
  });
  linkRow.appendChild(linkInput);
  linkRow.appendChild(copyBtn);
  card.appendChild(linkRow);

  const hostBtn = document.createElement("button");
  hostBtn.className = "btn primary";
  hostBtn.type = "button";
  hostBtn.textContent = "Host match";
  hostBtn.addEventListener("click", async () => {
    hostBtn.disabled = true;
    status.textContent = "Creating match…";
    const res = await apiPost("/api/matches", {
      planetId: planetSelect.value,
      sizeMult: Number(sizeSelect.value), resourceMult: Number(resourceSelect.value), matchTimeLimit: Number(lengthSelect.value),
      spectatorsEnabled: spectatorsCheckbox.checked,
    });
    if (!res.ok) {
      status.textContent = `Could not create a match (${(res.json && res.json.error) || res.status}).`;
      hostBtn.disabled = false;
      return;
    }
    const created = res.json;
    linkInput.value = shareLink(created.matchId);
    linkRow.classList.remove("hidden");
    hostBtn.disabled = false;
    if (created.started) {
      // Today's host form always requests two open seats, so this path isn't reachable from it yet
      // — kept honest for a future seatKinds picker (an "open","ai" match auto-starts on creation,
      // T-035's own FR-4 "all seats filled" clause) rather than assumed away.
      status.textContent = "Match created and already live.";
      hostBtn.textContent = "▶ Enter match";
      hostBtn.onclick = () => {
        hostBtn.disabled = true;
        joinLive(created.matchId, created.owner, created.token, status).catch(() => { hostBtn.disabled = false; });
      };
      return;
    }
    status.textContent = "Match created — share the link, or start now against the built-in AI.";
    // FR-4's "the host starts it" clause: POSTs /start (idempotent — a no-op if a second player's
    // own join already auto-started it first, FR-4's OTHER clause) before connecting, so an
    // unfilled seat is genuinely AI-filled (T-035, FR-3) by the time this seat's own client boots.
    hostBtn.textContent = "▶ Start match";
    hostBtn.onclick = async () => {
      hostBtn.disabled = true;
      status.textContent = "Starting…";
      const startRes = await apiPost(`/api/matches/${encodeURIComponent(created.matchId)}/start`, { token: created.token });
      if (!startRes.ok) {
        status.textContent = `Could not start the match (${(startRes.json && startRes.json.error) || startRes.status}).`;
        hostBtn.disabled = false;
        return;
      }
      try {
        await joinLive(created.matchId, created.owner, created.token, status);
      } catch { hostBtn.disabled = false; }
    };
  });
  card.appendChild(hostBtn);

  container.appendChild(card);
}

async function joinMatchById(matchId, statusBtn) {
  statusBtn.disabled = true;
  statusBtn.textContent = "Joining…";
  const res = await apiPost(`/api/matches/${encodeURIComponent(matchId)}/join`, {});
  if (!res.ok) {
    statusBtn.disabled = false;
    statusBtn.textContent = res.json && res.json.error === "no-open-seat" ? "Seat taken" : "Join";
    return;
  }
  try {
    // statusBtn doubles as joinLive's own statusEl — a button's textContent is exactly as
    // writable as a status paragraph's, so a T-060 "waking up…" message (or the connect-failure
    // one) shows right on the button a player just clicked, not silently nowhere.
    await joinLive(matchId, res.json.owner, res.json.token, statusBtn);
  } catch {
    statusBtn.disabled = false;
  }
}

function renderOpenMatchesCard(container) {
  const card = document.createElement("div");
  card.className = "setup lobby-card";
  const h = document.createElement("h3");
  h.className = "cards-heading";
  h.textContent = "Open matches";
  card.appendChild(h);
  const list = document.createElement("div");
  list.className = "lobby-match-list";
  const loading = document.createElement("p");
  loading.className = "setup-hint";
  loading.textContent = "Loading…";
  list.appendChild(loading);
  card.appendChild(list);
  container.appendChild(card);

  apiGet("/api/matches").then(res => {
    list.innerHTML = "";
    const hasOpenSeat = m => m.seats.some(s => s.kind === "open" && !s.taken);
    const joinable = (res.json ? res.json.matches : []).filter(hasOpenSeat);
    if (joinable.length === 0) {
      const p = document.createElement("p");
      p.className = "setup-hint";
      p.textContent = "No open matches right now — host one instead.";
      list.appendChild(p);
      return;
    }
    for (const m of joinable) {
      const row = document.createElement("div");
      row.className = "lobby-match-row";
      const label = document.createElement("span");
      const planet = PLANETS.find(p => p.id === m.planetId);
      label.textContent = planet ? planet.name : m.planetId;
      row.appendChild(label);
      const joinBtn = document.createElement("button");
      joinBtn.className = "btn";
      joinBtn.type = "button";
      joinBtn.textContent = "Join";
      joinBtn.addEventListener("click", () => joinMatchById(m.id, joinBtn));
      row.appendChild(joinBtn);
      list.appendChild(row);
    }
  });
}

function renderJoinByLink(joinMatchId) {
  const card = document.createElement("div");
  card.className = "setup lobby-card";
  const h = document.createElement("h3");
  h.className = "cards-heading";
  h.textContent = "Join match";
  card.appendChild(h);
  const status = document.createElement("p");
  status.className = "setup-hint";
  status.textContent = "You've been invited to a match.";
  card.appendChild(status);
  const joinBtn = document.createElement("button");
  joinBtn.className = "btn primary";
  joinBtn.type = "button";
  joinBtn.textContent = "Join match";
  joinBtn.addEventListener("click", async () => {
    joinBtn.disabled = true;
    status.textContent = "Joining…";
    const res = await apiPost(`/api/matches/${encodeURIComponent(joinMatchId)}/join`, {});
    if (!res.ok) {
      status.textContent = res.json && res.json.error === "no-such-match" ? "This match no longer exists."
        : res.json && res.json.error === "no-open-seat" ? "This match is already full."
        : "Could not join this match.";
      joinBtn.disabled = false;
      return;
    }
    try {
      await joinLive(joinMatchId, res.json.owner, res.json.token, status);
    } catch { joinBtn.disabled = false; }
  });
  card.appendChild(joinBtn);

  // T-037 (FR-7): "Any client may join a running match as a spectator" — the SAME shareable link
  // a player would use, offered as a second option on the SAME card, since a host shares one link
  // and whoever opens it decides whether to play or watch. No pre-check of the match's own
  // spectatorsEnabled here (there's no single-match lookup endpoint to check it against before
  // trying — GET /api/matches only ever lists still-OPEN matches, and a match worth watching is
  // usually already started): a disabled host just gets a clear rejection after clicking, same as
  // "Join match" already handles its own failure modes above.
  const watchBtn = document.createElement("button");
  watchBtn.className = "btn ghost";
  watchBtn.type = "button";
  watchBtn.textContent = "👁 Watch";
  watchBtn.addEventListener("click", async () => {
    watchBtn.disabled = true;
    status.textContent = "Connecting…";
    try {
      await spectateLive(joinMatchId, status);
    } catch {
      status.textContent = "Could not spectate this match — it may have ended, or the host has disabled spectating.";
      watchBtn.disabled = false;
    }
  });
  card.appendChild(watchBtn);

  lobbyScreenEl.appendChild(card);
}

/**
 * @param {{joinMatchId?: string}} [opts] - when given, renders straight into the "joining a
 *   shareable link" flow for that match id instead of the host/browse screen — main.js's own
 *   ?join=<matchId> URL check (T-034's exit criterion: a stranger opens a link, nothing else to
 *   configure first) uses this.
 */
export function renderLobbyScreen(opts = {}) {
  if (!lobbyScreenEl) return;   // import-safe under Node (CONTRIBUTING: follow the dom.js idiom)
  if (mapSelectEl) mapSelectEl.classList.add("hidden");
  lobbyScreenEl.classList.remove("hidden");
  lobbyScreenEl.innerHTML = "";

  const title = document.createElement("h2");
  title.textContent = "🌐 Multiplayer";
  lobbyScreenEl.appendChild(title);

  const back = document.createElement("button");
  back.className = "btn ghost lobby-back";
  back.type = "button";
  back.textContent = "← Back";
  back.addEventListener("click", () => { lobbyScreenEl.classList.add("hidden"); renderMapSelect(); });
  lobbyScreenEl.appendChild(back);

  if (opts.joinMatchId) { renderJoinByLink(opts.joinMatchId); return; }

  const row = document.createElement("div");
  row.className = "lobby-cards-row";
  renderHostCard(row);
  renderOpenMatchesCard(row);
  lobbyScreenEl.appendChild(row);
}
