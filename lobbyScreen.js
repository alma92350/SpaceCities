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
import { bootState } from "./boot.js";
import { game } from "./session.js";
import * as sound from "./sound.js";

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
async function joinLive(matchId, owner, token, statusEl) {
  if (statusEl) statusEl.textContent = "Connecting…";
  const transport = await createWsClientTransport(wsUrlFor(matchId, owner, token));
  const firstState = await new Promise(resolve => { transport.onEvent(e => { if (e.type === "state") resolve(e.state); }); });
  sound.unlockAudio();   // a real user gesture (the Host/Join click) led here — safe to start audio now
  game.localOwner = owner;
  lobbyScreenEl.classList.add("hidden");
  bootState(firstState, { intro: true, transport });
  transport.onEvent(e => { if (e.type === "state") applyLiveState(game.state, e.state); });
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
    });
    if (!res.ok) {
      status.textContent = `Could not create a match (${(res.json && res.json.error) || res.status}).`;
      hostBtn.disabled = false;
      return;
    }
    const created = res.json;
    linkInput.value = shareLink(created.matchId);
    linkRow.classList.remove("hidden");
    status.textContent = "Match created — share the link, then start whenever you're ready.";
    hostBtn.textContent = "▶ Start playing";
    hostBtn.disabled = false;
    hostBtn.onclick = () => joinLive(created.matchId, created.owner, created.token, status);
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
  await joinLive(matchId, res.json.owner, res.json.token, null);
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
    await joinLive(joinMatchId, res.json.owner, res.json.token, status);
  });
  card.appendChild(joinBtn);
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
