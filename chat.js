/* ============================================================
   chat.js — T-038 (FR-12)'s client-side UI: the in-match text chat panel. Shown ONLY for a live
   network match — a real seat (lobbyScreen.js's joinLive) or a T-037 read-only spectator
   (spectateLive) — by checking the SAME capability net/wsWorkerTransport.js's own header already
   documents as the load-bearing distinction: a seat's transport (net/wsClientTransport.js) has a
   real sendChat method, a spectator's (net/wsSpectatorTransport.js) never does. Every other boot
   path (single-player, a watched LOCAL exhibition, Odyssey, a scenario) never calls initChatPanel()
   at all, so the panel stays hidden — its index.html default, the same "never shown" treatment
   overlays.js's showFactionChip gives those paths.

   initChatPanel() is called once, right after a live network boot completes (lobbyScreen.js,
   alongside its own other post-boot setup like enterObserverMode) — not on a polling cadence like
   observerPanel.js's renderObserverPanel: a chat log's own history and scroll position are real DOM
   state that must persist across the life of the connection, not something to rebuild from scratch
   every HUD tick the way a stats readout is. New messages arrive one at a time, event-driven, via
   the transport's own onEvent (net/wsClientTransport.js/net/wsSpectatorTransport.js's own
   {type:"chat"} events), and are simply appended.

   hideChatPanel() is boot.js's restartToMapSelect() own choke point — hides the panel and drops its
   log content so the NEXT match (or none at all) never shows a previous one's messages.
   ============================================================ */

"use strict";

import { chatPanelEl } from "./dom.js";
import { game, seatDisplayName } from "./session.js";
import { MAX_CHAT_LEN } from "./net/chatLimiter.js";

function mk(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

// session.js's seatDisplayName assumes a real seat's own first-person view ("You" for
// game.localOwner, "Opponent" otherwise) — exactly wrong for a spectator (game.localOwner === null,
// T-030's own seam has no seat to point at): `owner === game.localOwner` can never match a real
// seat id against null, so EVERY seat would read as "Opponent", making the two sides
// indistinguishable. overlays.js's showFactionChip sidesteps that same ambiguity by hiding itself
// outright for a spectator; chat can't do that (a spectator DOES need to tell the two sides'
// messages apart), so it falls back to the bare seat identity instead, only for that one case.
function chatFromLabel(from) {
  if (game.localOwner === null) return from === "player" ? "Player" : from === "ai" ? "AI" : from;
  return seatDisplayName(from);
}

let logEl = null;

function appendLine(from, text) {
  if (!logEl) return;
  const line = mk("div", "chat-line");
  line.append(mk("span", "chat-from", chatFromLabel(from) + ": "), mk("span", "chat-text", text));
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

export function initChatPanel() {
  if (!chatPanelEl) return;   // import-safe under Node (dom.js idiom)
  const canSend = typeof game.transport?.sendChat === "function";
  if (!canSend && !game.networkSpectate) { chatPanelEl.classList.add("hidden"); return; }

  chatPanelEl.innerHTML = "";
  chatPanelEl.classList.remove("hidden");
  chatPanelEl.appendChild(mk("div", "chat-head", "💬 Chat"));
  logEl = mk("div", "chat-log");
  chatPanelEl.appendChild(logEl);

  if (canSend) {
    const form = mk("form", "chat-form");
    const input = mk("input", "chat-input");
    input.type = "text";
    input.placeholder = "Say something…";
    input.autocomplete = "off";
    // Optimistic UX cap only — net/chatLimiter.js's own validChatLength is what the server actually
    // enforces (net/wsWorkerTransport.js), the same MAX_CHAT_LEN so the two never drift apart.
    input.setAttribute("maxlength", String(MAX_CHAT_LEN));
    const send = mk("button", "chat-send", "Send");
    send.type = "submit";
    form.append(input, send);
    form.addEventListener("submit", e => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;   // nothing to send — never round-trip an empty message to the server
      game.transport.sendChat(text);
      input.value = "";
    });
    chatPanelEl.appendChild(form);
  }

  // No unsubscribe: net/transport.js's Transport interface has no offEvent, and none is needed —
  // this handler lives exactly as long as the transport itself (close() clears every handler at
  // once), and a fresh initChatPanel() call always follows a fresh transport, never re-subscribing
  // onto the same live one twice.
  game.transport.onEvent(e => { if (e.type === "chat") appendLine(e.from, e.text); });
}

export function hideChatPanel() {
  if (!chatPanelEl) return;
  chatPanelEl.classList.add("hidden");
  chatPanelEl.innerHTML = "";
  logEl = null;
}
