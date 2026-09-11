/* ============================================================
   TWO-BROWSER MULTIPLAYER SMOKE TEST — does a shared link actually put two people in one match?

   WHY THIS EXISTS, given 3252 passing tests and a browser smoke test already.

   tools/smoke.js boots one page and plays a skirmish. Everything multiplayer is tested one layer
   down, over real sockets but in Node: test/wsTransport.test.js, test/wsWorkerTransport.test.js,
   test/lobbyScreen-render.test.js. Between those two lies the path a real player actually takes —
   a browser opens the lobby, POSTs /api/matches, gets a link, a SECOND browser opens that link,
   and both end up in the same live match — and nothing exercised it end to end.

   That gap has already cost this project once. net/wsWorkerTransport.js's attachWsMatchWorker took
   the worker's FIRST message as its "ready" message; a Worker's port is flowing from construction,
   so an attach that landed after the worker had started pushing state read a state push instead
   and bound matchId to undefined. Every upgrade was then rejected in silence and every client hung
   until its own timeout. The unit tests passed, the smoke test passed, and the symptom a player
   saw — "the join link doesn't work" — was reproducible only with two real clients against one
   real server. This script is that reproduction, kept.

   It is deliberately shallow, like tools/smoke.js: it asserts two browsers reach ONE running match
   and neither logs an error. Whether the simulation is correct is the unit suite's job.

   RUNNING IT — same Playwright arrangement as tools/smoke.js, never a package.json dependency:

     npm install --no-save playwright@1.56.1
     npx playwright install --with-deps chromium
     npm run smoke:mp
     npm run smoke:mp -- --keep-open        # headed, left open, to watch it
   ============================================================ */

"use strict";

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createChecklist, exitCodeFor } from "./smoke.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.SMOKE_MP_PORT) || 8138;   // not smoke.js's 8137: the two must be able to run at once
const URL_ = `http://localhost:${PORT}/index.html`;
const HEADED = process.argv.includes("--keep-open");

const { steps, check } = createChecklist();

function startServer() {
  const proc = spawn(process.execPath, [join(ROOT, "tools", "serve.js"), String(PORT)], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the dev server did not start within 10s on port ${PORT}`)), 10000);
    proc.stdout.on("data", d => { if (String(d).includes("open")) { clearTimeout(timer); resolve(proc); } });
    proc.on("error", e => { clearTimeout(timer); reject(e); });
    proc.on("exit", c => { clearTimeout(timer); reject(new Error(`the dev server exited early (code ${c})`)); });
  });
}

// Same fallback tools/smoke.js documents: a pre-provisioned image may point PLAYWRIGHT_BROWSERS_PATH
// at its own versioned directory, which Playwright only auto-resolves when its version matches.
async function launchChromium(chromium) {
  try {
    return await chromium.launch({ headless: !HEADED });
  } catch (err) {
    const { existsSync, readdirSync } = await import("node:fs");
    const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
    if (!base || !existsSync(base)) throw err;
    for (const entry of readdirSync(base).filter(d => d.startsWith("chromium")).sort().reverse()) {
      for (const rel of ["chrome-linux/chrome", "chrome-linux/headless_shell", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]) {
        const exe = join(base, entry, rel);
        if (existsSync(exe)) return await chromium.launch({ headless: !HEADED, executablePath: exe });
      }
    }
    throw err;
  }
}

// Every page gets the same no-allow-list error capture tools/smoke.js uses: a page that logs errors
// in normal operation trains everyone to ignore them.
function watchErrors(page, who) {
  const errors = [];
  page.on("pageerror", e => errors.push(`${who} uncaught: ${e.message}\n    ${(e.stack || "").split("\n").slice(1, 4).join("\n    ")}`));
  page.on("console", m => { if (m.type() === "error") errors.push(`${who} console: ${m.text()}`); });
  page.on("requestfailed", r => errors.push(`${who} request failed: ${r.url()} (${r.failure()?.errorText})`));
  page.on("response", r => { if (r.status() >= 400) errors.push(`${who} HTTP ${r.status()}: ${r.url()}`); });
  return errors;
}

const clockOf = page => page.evaluate(() => (document.body.innerText.match(/\d+:\d\d/) || ["0:00"])[0]);
const canvasLive = page => page.evaluate(() => { const c = document.querySelector("canvas"); return !!(c && c.offsetParent && c.width > 0); });

async function main() {
  let chromium;
  const req = createRequire(join(ROOT, "package.json"));
  for (const pkg of ["playwright", "playwright-core"]) {
    try { ({ chromium } = req(pkg)); break; } catch { /* try the next one */ }
  }
  if (!chromium) {
    console.error(
      "Playwright is not installed, which is deliberate — it is not a dependency of this game.\n" +
      "  npm install --no-save playwright@1.56.1\n" +
      "  npx playwright install --with-deps chromium\n" +
      "  npm run smoke:mp\n");
    process.exit(2);
  }

  const server = await startServer();
  const browser = await launchChromium(chromium);
  // Two independent contexts, not two tabs: separate storage, so the joiner cannot accidentally
  // inherit the host's saved live-match credentials (liveMatchStorage.js) and "rejoin" its way into
  // looking like a success this test never actually proved.
  const hostCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const joinCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const host = await hostCtx.newPage();
  const joiner = await joinCtx.newPage();
  const hostErrors = watchErrors(host, "host");
  const joinErrors = watchErrors(joiner, "joiner");

  try {
    /* ---------- the host opens the lobby and creates a match ---------- */
    await host.goto(URL_, { waitUntil: "networkidle" });
    await host.waitForTimeout(600);
    await host.click("text=🌐 Multiplayer");
    await host.waitForTimeout(500);
    check("the host reaches the multiplayer lobby", await host.isVisible("text=Host a match"));

    await host.click('button:text-is("Host match")');
    await host.waitForTimeout(1200);
    const link = await host.evaluate(() => document.querySelector(".lobby-link-input")?.value || "");
    check("hosting produces a shareable join link", /\?join=/.test(link), link || "(no link)");

    /* ---------- a SECOND browser opens that same link, BEFORE the host starts ----------
       Order matters, and getting it wrong is itself instructive: if the host clicks "Start match"
       first, FR-3's AI fill takes the open seat and a real player arriving afterwards is correctly
       refused with 409 no-open-seat. A two-human match is created, then JOINED, then started —
       which is also the order a real pair of players use, because the link has to be shared before
       anyone can open it. */
    await joiner.goto(link, { waitUntil: "networkidle" });
    await joiner.waitForTimeout(800);
    check("the shared link opens straight into the join screen", await joiner.isVisible("text=Join match"));

    // The step no unit test can stand in for, and the one the attachWsMatchWorker defect broke:
    // this attaches to a worker that has been running since the host created the match, so the
    // join is by definition the LATE attach that used to bind matchId to undefined and hang.
    await joiner.click('button:text-is("Join match")');
    await joiner.waitForTimeout(6000);
    const joinerIn = await canvasLive(joiner);
    check("THE JOINER REACHES THE MATCH (the regression this file exists for)", joinerIn,
      joinerIn ? "" : (await joiner.evaluate(() => document.querySelector(".setup-hint")?.textContent || "no status")));

    /* ---------- the host enters the match it created ---------- */
    // The joiner filling the last seat already auto-started it (FR-4), so this is the host taking
    // its own seat rather than starting anything — which is now what the button SAYS: the host card
    // polls its own match and relabels itself "▶ Enter match" once it is live. Either label is
    // accepted because which one is showing depends on whether a poll has landed yet, and the step
    // being tested (the host reaching its own match) is the same through both.
    await host.click('button:text-is("▶ Enter match"), button:text-is("▶ Start match")');
    await host.waitForTimeout(4000);
    check("the host lands in the same live match", await canvasLive(host));

    /* ---------- both are in the SAME, RUNNING match ---------- */
    const [h0, j0] = [await clockOf(host), await clockOf(joiner)];
    await host.waitForTimeout(3000);
    const [h1, j1] = [await clockOf(host), await clockOf(joiner)];
    check("the match clock advances for the host", h0 !== h1, `${h0} → ${h1}`);
    check("the match clock advances for the joiner", j0 !== j1, `${j0} → ${j1}`);

    // Two clients driven by ONE server-side worker read the same clock. Allowing a second of skew
    // covers ordinary push jitter without allowing two SEPARATE matches to pass as one, which
    // would drift apart without bound.
    const secs = t => { const [m, s] = t.split(":").map(Number); return m * 60 + s; };
    check("both clients are in the SAME match, not two separate ones",
      Math.abs(secs(h1) - secs(j1)) <= 2, `host ${h1} vs joiner ${j1}`);

    /* ---------- the joiner can actually play ---------- */
    const box = await (await joiner.$("canvas")).boundingBox();
    const errsBefore = joinErrors.length;
    await joiner.mouse.move(box.x + 200, box.y + 200);
    await joiner.mouse.down();
    await joiner.mouse.move(box.x + 900, box.y + 700, { steps: 12 });
    await joiner.mouse.up();
    await joiner.waitForTimeout(700);
    const panel = await joiner.evaluate(() => (document.querySelector("#selectionPanel")?.innerText || "").trim());
    check("the joiner can select its own units", /worker|hp/i.test(panel), panel.split("\n")[0]?.slice(0, 48));

    await joiner.mouse.click(box.x + 600, box.y + 420, { button: "right" });
    await joiner.waitForTimeout(800);
    check("the joiner can issue an order with no new console errors", joinErrors.length === errsBefore,
      joinErrors.slice(errsBefore).join(" | "));

    check("the host's console stayed clean", hostErrors.length === 0, hostErrors.slice(0, 4).join(" | "));
    check("the joiner's console stayed clean", joinErrors.length === 0, joinErrors.slice(0, 4).join(" | "));
  } catch (err) {
    check("the run completed without throwing", false, err.message);
  } finally {
    if (!HEADED) { await browser.close(); server.kill(); }
    else console.log("\n--keep-open: browsers and server left running; Ctrl+C to stop.");
  }

  const failed = steps.filter(s => !s.ok);
  console.log(`\n${steps.length - failed.length}/${steps.length} checks passed`);
  if (steps.length === 0) console.log("no checks ran at all — that is a FAILED smoke run, not a clean one");
  for (const e of [...hostErrors, ...joinErrors].slice(0, 20)) console.log("  !!", e);
  if (!HEADED) process.exit(exitCodeFor(steps));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(err => { console.error(err); process.exit(1); });
}
