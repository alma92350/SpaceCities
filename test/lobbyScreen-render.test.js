/* ============================================================
   lobbyScreen.js's SCREEN — the host / browse / join-by-link UI itself.

   test/lobbyScreen.test.js covers applyLiveState, which is one exported function out of the file;
   everything that draws the multiplayer entry screen and turns a click into an HTTP call was
   untested (25% of lines, and 11% of functions, on a `node --test --experimental-test-coverage`
   run). That is the wrong file to leave uncovered: it is the FRONT DOOR to multiplayer. A stranger
   opening a shared link reaches this code before any of the well-tested transport layer beneath
   it, and a defect here is not a subtle wrong answer — it is a screen that renders nothing, or a
   button that posts the wrong body, on the one path no engine test can see.

   The browser smoke test cannot cover it either: it drives a skirmish, and nothing in CI hosts a
   real match. So this is where the lobby's request shapes and error paths get pinned.

   WHAT IS ASSERTED: the DOM the screen builds, the exact bodies it POSTs, and the message a player
   is shown for each way a join can fail. WHAT IS NOT: anything past a successful join — that hands
   off to joinLive/bootState and a real WebSocket, which test/wsClientTransport.test.js and
   test/wsWorkerTransport.test.js own one layer down.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./_dom.js";

const doc = installFakeDom();

// dom.js resolves #lobbyScreen once at import time, so the handle the screen appends to is this
// same object for the whole process (see test/_dom.js's own note on per-id identity).
const lobbyEl = doc.getElementById("lobbyScreen");

globalThis.location = { protocol: "http:", host: "localhost:8080", href: "http://localhost:8080/index.html" };
// navigator is a real getter-only global under Node, so the clipboard stub is defined rather
// than assigned; only the "Copy link" button reads it.
Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: async () => {} } }, configurable: true });

const { renderLobbyScreen } = await import("../lobbyScreen.js");
const { MAP_CHOICES, SIZE_OPTIONS, RESOURCE_OPTIONS, MATCH_LENGTH_OPTIONS } = await import("../setup.js");
const { PLANETS } = await import("../data.js");

// Records every request the screen makes and answers from a script, so a test can assert on the
// wire shape as well as on what the player ends up seeing.
function fakeNet(routes) {
  const calls = [];
  globalThis.fetch = async (path, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ path, method: (init && init.method) || "GET", body });
    // Keyed by method AND path: the lobby GETs and POSTs the SAME /api/matches URL, so a
    // path-only route table answers the create call with the browse call's payload.
    const method = (init && init.method) || "GET";
    const route = routes[`${method} ${path}`] ?? routes[method] ?? { ok: true, json: {} };
    return { ok: route.ok !== false, status: route.status || (route.ok === false ? 400 : 200), json: async () => route.json };
  };
  return calls;
}

// The Watch button reaches net/wsSpectatorTransport.js, which opens a real WebSocket. A socket
// that refuses the connection is exactly what a host with spectators disabled produces, and it is
// the case worth pinning: the player must be told, not left on "Connecting…" forever.
class RefusingSocket {
  constructor(url) {
    this.url = url;
    setTimeout(() => { this.onerror?.({ type: "error" }); this.onclose?.({ code: 1006 }); }, 0);
  }
  addEventListener(type, fn) { this[`on${type}`] = fn; }
  close() {}
  send() {}
}
globalThis.WebSocket = RefusingSocket;

// A click handler is async; the DOM double dispatches synchronously, so yield the microtask queue
// (twice — most handlers await a fetch and then act on its result) before asserting.
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
// …and a turn of the macrotask queue too, for the paths that wait on a socket rather than a fetch.
const settleIo = async () => { await settle(); await new Promise(r => setTimeout(r, 5)); await settle(); };
const click = async el => { el.click(); await settle(); };

const find = (root, pred) => {
  const out = [];
  const walk = n => { for (const c of n.children || []) { if (pred(c)) out.push(c); walk(c); } };
  walk(root);
  return out;
};
const buttonsIn = root => find(root, n => n.tagName === "button");
const buttonNamed = (root, text) => buttonsIn(root).find(b => b.textContent === text);
const selectsIn = root => find(root, n => n.tagName === "select");

test("the lobby renders a host card and an open-matches card, plus a way back", () => {
  fakeNet({ "GET /api/matches": { json: { matches: [] } } });
  renderLobbyScreen();
  assert.ok(!lobbyEl.classList.contains("hidden"), "the lobby screen must be shown");
  const headings = find(lobbyEl, n => n.tagName === "h3").map(h => h.textContent);
  assert.deepEqual(headings, ["Host a match", "Open matches"]);
  assert.ok(buttonNamed(lobbyEl, "← Back"), "a player who opened multiplayer by mistake needs a way out");
});

test("Back hides the lobby again — the screen is not a one-way door", () => {
  fakeNet({ "GET /api/matches": { json: { matches: [] } } });
  renderLobbyScreen();
  buttonNamed(lobbyEl, "← Back").click();
  assert.ok(lobbyEl.classList.contains("hidden"));
});

test("the host form is built from the shared setup tables, not a second hard-coded copy", () => {
  // If these ever drift from setup.js's own lists, multiplayer quietly offers different worlds or
  // different dials than single-player does, which nothing else in the suite would notice.
  fakeNet({ "GET /api/matches": { json: { matches: [] } } });
  renderLobbyScreen();
  const [world, size, resources, length] = selectsIn(lobbyEl);
  assert.deepEqual(world.children.map(o => o.value), [...MAP_CHOICES]);
  assert.equal(size.children.length, SIZE_OPTIONS.length);
  assert.equal(resources.children.length, RESOURCE_OPTIONS.length);
  assert.equal(length.children.length, MATCH_LENGTH_OPTIONS.length);
});

test("hosting POSTs the chosen dials, with spectators allowed by default", async () => {
  const calls = fakeNet({
    "GET /api/matches": { json: { matches: [] } },
    POST: { json: { matchId: "m1", owner: "p0", token: "t0", started: false } },
  });
  renderLobbyScreen();
  await click(buttonNamed(lobbyEl, "Host match"));
  const post = calls.find(c => c.method === "POST");
  assert.ok(post, "the Host button must actually create a match");
  assert.equal(post.path, "/api/matches");
  assert.equal(post.body.planetId, MAP_CHOICES[0], "the select's default is its first option, as in a real browser");
  assert.equal(post.body.sizeMult, SIZE_OPTIONS[0].mult);
  assert.equal(post.body.resourceMult, RESOURCE_OPTIONS[0].mult);
  assert.equal(post.body.matchTimeLimit, MATCH_LENGTH_OPTIONS[0].mult);
  assert.equal(post.body.spectatorsEnabled, true,
    "T-037/FR-7: on by default, so hosting behaves as it did before spectating existed");
  for (const [k, v] of Object.entries(post.body)) assert.ok(!Number.isNaN(v), `${k} must not be sent as NaN`);
});

test("unchecking 'Allow spectators' reaches the request body", async () => {
  const calls = fakeNet({
    "GET /api/matches": { json: { matches: [] } },
    POST: { json: { matchId: "m1", owner: "p0", token: "t0" } },
  });
  renderLobbyScreen();
  find(lobbyEl, n => n.type === "checkbox")[0].checked = false;
  await click(buttonNamed(lobbyEl, "Host match"));
  assert.equal(calls.find(c => c.method === "POST").body.spectatorsEnabled, false);
});

test("a created match shows a shareable ?join= link on this same page", async () => {
  // The link IS the feature — T-034's exit criterion is a stranger opening it with nothing else to
  // configure. It has to carry the match id and point back at the page the host is already on.
  fakeNet({
    "GET /api/matches": { json: { matches: [] } },
    POST: { json: { matchId: "m-42", owner: "p0", token: "t0", started: false } },
  });
  renderLobbyScreen();
  await click(buttonNamed(lobbyEl, "Host match"));
  const linkInput = find(lobbyEl, n => n.classList.contains("lobby-link-input"))[0];
  assert.equal(linkInput.value, "http://localhost:8080/index.html?join=m-42");
  assert.ok(!find(lobbyEl, n => n.classList.contains("lobby-link-row"))[0].classList.contains("hidden"),
    "the link row must be revealed, or the host has a link they cannot see");
  assert.ok(buttonNamed(lobbyEl, "▶ Start match"), "and the host can start against the AI without waiting");
});

test("a match the server refuses to create says why, and lets the host try again", async () => {
  fakeNet({
    "GET /api/matches": { json: { matches: [] } },
    POST: { ok: false, status: 429, json: { error: "too-many-matches" } },
  });
  renderLobbyScreen();
  const hostBtn = buttonNamed(lobbyEl, "Host match");
  await click(hostBtn);
  const hint = find(lobbyEl, n => n.classList.contains("setup-hint"))[0];
  assert.match(hint.textContent, /too-many-matches/, "the server's own reason is more useful than 'failed'");
  assert.equal(hostBtn.disabled, false, "a failed attempt must not leave the button dead");
});

test("the open-matches list offers only matches with a free seat, named by world", async () => {
  fakeNet({
    "GET /api/matches": { json: { matches: [
      { id: "a", planetId: PLANETS[0].id, seats: [{ kind: "open", taken: false }, { kind: "open", taken: true }] },
      { id: "b", planetId: PLANETS[0].id, seats: [{ kind: "open", taken: true }, { kind: "open", taken: true }] },
      { id: "c", planetId: PLANETS[0].id, seats: [{ kind: "ai", taken: false }] },
    ] } },
  });
  renderLobbyScreen();
  await settle();
  const rows = find(lobbyEl, n => n.classList.contains("lobby-match-row"));
  assert.equal(rows.length, 1, "a full match and an AI-only seat are not joinable and must not be listed");
  assert.equal(rows[0].children[0].textContent, PLANETS[0].name, "a player picks a match by world, not by id");
});

test("an empty lobby says so instead of showing a blank panel", async () => {
  fakeNet({ "GET /api/matches": { json: { matches: [] } } });
  renderLobbyScreen();
  await settle();
  const hints = find(lobbyEl, n => n.classList.contains("setup-hint")).map(p => p.textContent);
  assert.ok(hints.some(t => /No open matches/.test(t)), `expected an empty-state message, got: ${hints.join(" | ")}`);
});

test("a seat taken between listing and clicking says 'Seat taken', not nothing", async () => {
  fakeNet({
    "GET /api/matches": { json: { matches: [{ id: "a", planetId: PLANETS[0].id, seats: [{ kind: "open", taken: false }] }] } },
    POST: { ok: false, status: 409, json: { error: "no-open-seat" } },
  });
  renderLobbyScreen();
  await settle();
  const joinBtn = buttonNamed(find(lobbyEl, n => n.classList.contains("lobby-match-row"))[0], "Join");
  await click(joinBtn);
  assert.equal(joinBtn.textContent, "Seat taken");
  assert.equal(joinBtn.disabled, false, "…and the row stays usable rather than stuck on 'Joining…'");
});

test("a shared link renders the join card alone — no host form to configure first", () => {
  fakeNet({});
  renderLobbyScreen({ joinMatchId: "m-42" });
  const headings = find(lobbyEl, n => n.tagName === "h3").map(h => h.textContent);
  assert.deepEqual(headings, ["Join match"], "T-034: a stranger opening a link has nothing to set up");
  assert.ok(buttonNamed(lobbyEl, "Join match"));
  assert.ok(buttonNamed(lobbyEl, "👁 Watch"), "T-037/FR-7: the same link also offers spectating");
});

test("each way a join can fail gets its own plain-language message", async () => {
  // These three are distinct player-facing situations — a dead link, a full match, and everything
  // else — and collapsing them into one generic error is what makes a lobby feel broken.
  const cases = [
    [{ error: "no-such-match" }, /no longer exists/],
    [{ error: "no-open-seat" }, /already full/],
    [{ error: "kaboom" }, /Could not join/],
  ];
  for (const [json, expected] of cases) {
    fakeNet({ POST: { ok: false, status: 400, json } });
    renderLobbyScreen({ joinMatchId: "m-42" });
    const joinBtn = buttonNamed(lobbyEl, "Join match");
    await click(joinBtn);
    const status = find(lobbyEl, n => n.classList.contains("setup-hint"))[0];
    assert.match(status.textContent, expected);
    assert.equal(joinBtn.disabled, false, "a failed join must leave the button clickable again");
  }
});

test("a match that cannot be spectated says so rather than hanging on 'Connecting…'", async () => {
  fakeNet({});
  renderLobbyScreen({ joinMatchId: "m-42" });
  const watchBtn = buttonNamed(lobbyEl, "👁 Watch");
  watchBtn.click();
  await settleIo();
  const status = find(lobbyEl, n => n.classList.contains("setup-hint"))[0];
  assert.match(status.textContent, /Could not spectate/);
  assert.equal(watchBtn.disabled, false);
});
