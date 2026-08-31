/* ============================================================
   Auto-update check. The app is static files served from an origin; a long-lived
   tab can outlast a deployment. So we fetch the deployed version.json (cache-busted)
   and compare its release to this build's baked-in APP_VERSION — if the server is
   newer, a dismissible banner offers to reload into the new build.

   Crucially the banner tells the truth about SAVE DATA: using the manifest's minimum
   readable save-format versions and the versions of the player's stored saves
   (version.js saveImpact), it says whether their saves carry over or would be orphaned
   — and, when at risk, nudges them to export via the file Save first. Self-wired, like
   the other UI modules: import for side effects (main.js).
   ============================================================ */

"use strict";

import { APP_VERSION, isNewer, saveImpact } from "./version.js";
import { storedSaveVersions } from "./saveload.js";

const MANIFEST_URL = "version.json";
const CHECK_INTERVAL_MS = 30 * 60 * 1000;   // re-check every 30 min (a stale tab may span a deploy)
const DISMISS_KEY = "stellarfrontier.update.dismissed";

const readDismissed = () => { try { return localStorage.getItem(DISMISS_KEY); } catch (e) { return null; } };
const writeDismissed = v => { try { localStorage.setItem(DISMISS_KEY, v); } catch (e) { /* ignore */ } };

// Show the running version in the topbar chip.
function showVersionChip() {
  const el = document.getElementById("appVersion");
  if (el) { el.textContent = "v" + APP_VERSION; el.title = `SpaceCities v${APP_VERSION}`; }
}

// Fetch the deployed manifest and, if it's a newer release than this build, raise the banner.
// Network/parse failures are silent — an update check must never break the game or nag on error.
export async function checkForUpdate() {
  let manifest;
  try {
    const res = await fetch(`${MANIFEST_URL}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return;
    manifest = await res.json();
  } catch (e) { return; }
  if (!manifest || typeof manifest.version !== "string") return;
  if (!isNewer(manifest.version)) return;                 // same or older build live → nothing to do
  if (readDismissed() === manifest.version) return;       // player already said "Later" for this exact release
  showBanner(manifest);
}

export function showBanner(manifest) {
  document.getElementById("updateBanner")?.remove();      // replace any prior banner

  const impact = saveImpact(manifest, storedSaveVersions());

  const banner = document.createElement("div");
  banner.id = "updateBanner";
  banner.className = "update-banner";

  const text = document.createElement("div");
  text.className = "update-text";
  const head = document.createElement("strong");
  head.textContent = `⟳ Update available — v${APP_VERSION} → v${manifest.version}`;
  text.appendChild(head);
  if (manifest.notes) {
    const notes = document.createElement("span");
    notes.className = "update-notes";
    notes.textContent = " · " + manifest.notes;
    text.appendChild(notes);
  }
  // The save-compatibility line — the honest bit.
  const compat = document.createElement("div");
  compat.className = "update-compat";
  if (impact.risk.length) {
    compat.classList.add("bad");
    compat.textContent = `⚠ Your saved ${impact.risk.join(" & ")} won't load in the new version — click Save to export it to a file first.`;
  } else if (impact.safe.length) {
    compat.classList.add("ok");
    compat.textContent = `✓ Backward compatible — your saved ${impact.safe.join(" & ")} will carry over.`;
  } else {
    compat.textContent = "No saved games affected.";
  }
  text.appendChild(compat);
  banner.appendChild(text);

  const actions = document.createElement("div");
  actions.className = "update-actions";
  const reload = document.createElement("button");
  reload.className = "update-btn primary";
  reload.textContent = "Reload to update";
  reload.addEventListener("click", () => location.reload());
  const later = document.createElement("button");
  later.className = "update-btn";
  later.textContent = "Later";
  later.addEventListener("click", () => { writeDismissed(manifest.version); banner.remove(); });
  actions.append(reload, later);
  banner.appendChild(actions);

  (document.getElementById("app") || document.body).prepend(banner);
}

// Browser-only kickoff — guarded so importing this module under Node (to unit-test its pure
// logic, e.g. showBanner) doesn't touch a non-existent `document`/`window`, and doesn't arm a
// REAL, never-cleared 30-minute setInterval that would keep `node --test` from ever exiting (the
// same pattern saveload.js's own autosave-timer guard already uses). In the browser `window`
// always exists, so this still runs unconditionally, exactly as before.
if (typeof window !== "undefined") {
  showVersionChip();
  // A short delay so the first check doesn't contend with initial load; then periodic re-checks.
  setTimeout(checkForUpdate, 4000);
  setInterval(checkForUpdate, CHECK_INTERVAL_MS);
}
