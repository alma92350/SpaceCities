/* ============================================================
   T-038 (FR-12): chat.js — the in-match text chat PANEL. Shown only for a live network match (a
   real seat, via lobbyScreen.js's joinLive, or a T-037 spectator, via spectateLive) — every other
   boot path (single-player, a watched LOCAL exhibition, Odyssey, a scenario) never calls
   initChatPanel() at all, so the panel stays hidden (its index.html default).

   A fake Transport (not a real WebSocket) stands in for net/wsClientTransport.js/
   net/wsSpectatorTransport.js here — the wire-level relay/cap/rate-limit behavior is already
   covered end-to-end in test/wsWorkerTransport.test.js and test/wsSpectatorTransport.test.js; this
   file is only about chat.js's own DOM wiring (show/hide, the send form, appending incoming
   messages), same division of labor observerPanel.js's own tests (if it had any) would want.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./_dom.js";

installFakeDom();

const { initChatPanel, hideChatPanel } = await import("../chat.js");
const { chatPanelEl } = await import("../dom.js");
const { game } = await import("../session.js");
const { MAX_CHAT_LEN } = await import("../net/chatLimiter.js");

function fakeTransport({ sendChat } = {}) {
  const handlers = new Set();
  const t = {
    onEvent(h) { handlers.add(h); },
    submitCommand() { return Promise.resolve({ ok: true }); },
    close() { handlers.clear(); },
    // Test-only: simulates the server pushing an event to every subscriber, the same role a real
    // WebSocket "message" event plays inside net/wsClientTransport.js/wsSpectatorTransport.js.
    emit(e) { for (const h of handlers) h(e); },
  };
  if (sendChat) t.sendChat = sendChat;
  return t;
}

function resetGame() {
  game.transport = null;
  game.networkSpectate = false;
  game.localOwner = "player";
  game.seatNames = {};
}

test("initChatPanel: stays hidden when the transport has no sendChat and this isn't a network spectator — single-player, a watched local exhibition, Odyssey, etc.", () => {
  resetGame();
  game.transport = fakeTransport();   // no sendChat — e.g. a directTransport/loopback
  initChatPanel();
  assert.ok(chatPanelEl.classList.contains("hidden"));
});

test("initChatPanel: shows the panel with a real send form for a live seat (transport.sendChat exists)", () => {
  resetGame();
  game.transport = fakeTransport({ sendChat: () => {} });
  initChatPanel();
  assert.equal(chatPanelEl.classList.contains("hidden"), false);
  assert.ok(chatPanelEl.querySelector(".chat-form"), "a seat that can send chat must get a real input form");
});

test("initChatPanel: shows the panel WITHOUT a send form for a live network spectator (no sendChat at all)", () => {
  resetGame();
  game.networkSpectate = true;
  game.localOwner = null;
  game.transport = fakeTransport();   // net/wsSpectatorTransport.js's own shape — no sendChat
  initChatPanel();
  assert.equal(chatPanelEl.classList.contains("hidden"), false);
  assert.equal(chatPanelEl.querySelector(".chat-form"), null,
    "a spectator must never get a way to send — true by construction, same as the transport itself (net/wsWorkerTransport.js never wires conn.onmessage for one)");
});

test("the chat input's maxlength matches net/chatLimiter.js's own MAX_CHAT_LEN — client-side optimistic cap, the server stays the authority", () => {
  resetGame();
  game.transport = fakeTransport({ sendChat: () => {} });
  initChatPanel();
  const input = chatPanelEl.querySelector(".chat-input");
  assert.equal(input.getAttribute("maxlength"), String(MAX_CHAT_LEN));
});

test("submitting the chat form sends the trimmed text and clears the input", () => {
  resetGame();
  const sent = [];
  game.transport = fakeTransport({ sendChat: text => sent.push(text) });
  initChatPanel();
  const input = chatPanelEl.querySelector(".chat-input");
  const form = chatPanelEl.querySelector(".chat-form");
  input.value = "  gl hf  ";
  form.dispatchEvent(new Event("submit", { cancelable: true }));
  assert.deepEqual(sent, ["gl hf"]);
  assert.equal(input.value, "");
});

test("submitting an empty or whitespace-only message never calls sendChat at all", () => {
  resetGame();
  const sent = [];
  game.transport = fakeTransport({ sendChat: text => sent.push(text) });
  initChatPanel();
  const input = chatPanelEl.querySelector(".chat-input");
  const form = chatPanelEl.querySelector(".chat-form");
  input.value = "   ";
  form.dispatchEvent(new Event("submit", { cancelable: true }));
  assert.deepEqual(sent, [], "nothing to send — must not round-trip an empty message to the server");
});

test("an incoming chat event from the transport is appended to the log, labeled with the sender's seat", () => {
  resetGame();
  game.transport = fakeTransport({ sendChat: () => {} });   // localOwner "player" — from() reads You/Opponent
  initChatPanel();
  game.transport.emit({ type: "chat", from: "ai", text: "gg" });
  const log = chatPanelEl.querySelector(".chat-log");
  assert.equal(log.children.length, 1);
  const line = log.children[0];
  assert.equal(line.children[0].textContent, "Opponent: ");
  assert.equal(line.children[1].textContent, "gg");
});

test("the local seat's own sent message, echoed back by the server, reads as 'You' — the single server-ordered stream, not a client-side optimistic echo", () => {
  resetGame();
  game.transport = fakeTransport({ sendChat: () => {} });   // localOwner defaults to "player"
  initChatPanel();
  game.transport.emit({ type: "chat", from: "player", text: "gl hf" });
  const log = chatPanelEl.querySelector(".chat-log");
  assert.equal(log.children[0].children[0].textContent, "You: ");
});

test("a spectator's own view labels each seat by its raw identity, never both sides as 'Opponent' — seatDisplayName's own You/Opponent framing has no 'you' side to anchor on for a spectator", () => {
  resetGame();
  game.networkSpectate = true;
  game.localOwner = null;
  game.transport = fakeTransport();
  initChatPanel();
  game.transport.emit({ type: "chat", from: "player", text: "hi" });
  game.transport.emit({ type: "chat", from: "ai", text: "yo" });
  const log = chatPanelEl.querySelector(".chat-log");
  assert.equal(log.children.length, 2);
  assert.equal(log.children[0].children[0].textContent, "Player: ");
  assert.equal(log.children[1].children[0].textContent, "AI: ");
});

test("hideChatPanel hides the panel and clears any accumulated log content", () => {
  resetGame();
  game.transport = fakeTransport({ sendChat: () => {} });
  initChatPanel();
  game.transport.emit({ type: "chat", from: "ai", text: "gg" });
  hideChatPanel();
  assert.ok(chatPanelEl.classList.contains("hidden"));
  assert.equal(chatPanelEl.children.length, 0);
});

test("hideChatPanel is safe to call even when no match was ever live (nothing to hide)", () => {
  resetGame();
  assert.doesNotThrow(() => hideChatPanel());
});
