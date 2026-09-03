/* ============================================================
   The landing-site picker: a blocking modal shown before a jump lands on a
   world with no player Spaceport standing on it (engine/galaxy.js's
   landingZone falls back to a player-chosen point in exactly that case — see
   its header comment). With no beacon to home in on, the player picks an
   approximate touchdown spot themselves: the canvas here draws the world's
   static terrain silhouette (rough and high ground, in the same faint shades
   minimap.js's own terrain layer uses) — geography is charted map knowledge
   from orbit, not battlefield intel, the same doctrine engine/fog.js's own
   header states — but otherwise still nothing: no fog, no enemy units or
   buildings, no resource nodes, because what's actually happening down there
   on a world you've never set foot on (the overwhelmingly common case this
   fires for) really is unknown until you land. The pick itself is necessarily
   coarse (a minimap click, not a coordinate field), and engine/galaxy.js's
   snapLandingPoint further resolves it to the nearest of a fixed set of
   landing sites — so the dashed ring drawn around the marker previews that
   same imprecision rather than promising a precision the landing won't
   actually have. (That snap is idempotent, so forwarding the RAW point below
   and forwarding an already-snapped one land in the same place; this file
   forwards the raw one because the engine owns the rule, not because the
   caller has to snap exactly once.)

   This picker isn't ONLY reached for total unknowns, though: `needsPick`
   (boot.js's initiateJump) fires whenever no COMPLETED player Spaceport
   stands here — which also covers a colony you already hold whose pad is
   still under construction, or was lost. On worlds like that the player's
   own buildings and units are already known intel (never fogged to their
   owner — same rule the main minimap.js follows), so the chart marks them:
   a bigger circle for a Spaceport (built or not — it's still the landmark
   you're aiming relative to), small squares for other buildings, and dots
   for units. A genuinely unvisited world owns none of these, so it stays as
   blind as before with no special-casing needed.

   A leaf UI module: no import of boot.js (or anything else that imports
   this file), so it stays free of the pause/resume and jump-execution
   decisions — those are the caller's job (boot.js's initiateJump), passed in
   as plain callbacks. Modelled on saveload.js's goHome confirm modal (same
   overlay/card/dialog/focus-trap/Esc-dismiss idiom).
   ============================================================ */

"use strict";

import { minimapToWorld } from "./minimap.js";
import { LANDING_PICK_GRID } from "./engine/galaxy.js";
import { game } from "./session.js";

const PICKER_MAX_W = 480;

// Open the picker for `dest` (the destination's engine state — its live one when the galaxy is
// already simulating that world, else the throwaway previewPlanet build boot.js's initiateJump
// passes in for a world still dormant; either way it's the world the jump will land on).
// `worldLabel` is the display name shown in the heading. `onPick(point)` fires once, with the
// RAW world-space point the player clicked (engine/galaxy.js does the snapping/clamping) — the
// caller is expected to launch the jump with it. `onCancel()` fires instead if the player backs out.
// Exactly one of the two ever fires, and the modal is always removed either way.
export function openLandingPicker(dest, worldLabel, { onPick, onCancel }) {
  const map = dest.map;
  const mmW = PICKER_MAX_W, mmH = Math.round(map.height * (PICKER_MAX_W / map.width));
  // Whether the player already has a footprint here (see the header comment) — drives both the
  // marked-up chart below and this copy, which otherwise oversells the pick as totally blind.
  const hasFootprint = [...dest.buildings.values()].some(b => b.owner === game.localOwner)
    || [...dest.units.values()].some(u => u.owner === game.localOwner);

  const overlay = document.createElement("div");
  overlay.className = "landing-pick-confirm";
  const card = document.createElement("div");
  card.className = "landing-pick-card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.tabIndex = -1;

  const h = document.createElement("h2");
  h.id = "landing-pick-title";
  h.textContent = `Choose a landing site — ${worldLabel}`;
  card.setAttribute("aria-labelledby", h.id);

  const p = document.createElement("p");
  p.textContent = hasFootprint
    ? "No completed Spaceport here to guide the fleet in. Terrain is charted from orbit, and your own buildings and units are marked on the chart below — pick an approximate site; a minimap pick is never exact."
    : "No Spaceport beacon here to guide the fleet in. Terrain is charted from orbit — pick an approximate site on the chart below; a minimap pick is never exact.";

  const canvasWrap = document.createElement("div");
  canvasWrap.className = "landing-pick-canvas-wrap";
  const canvas = document.createElement("canvas");
  canvas.className = "landing-pick-canvas";
  canvas.width = mmW; canvas.height = mmH;
  canvas.tabIndex = 0;
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", hasFootprint
    ? "Starmap chart charted from orbit and marked with your own buildings and units — click to mark an approximate landing site"
    : "Terrain charted from orbit — click to mark an approximate landing site");
  canvasWrap.appendChild(canvas);

  const hint = document.createElement("p");
  hint.className = "landing-pick-hint";
  hint.textContent = "Click the chart to mark a landing site.";

  const actions = document.createElement("div");
  actions.className = "landing-pick-actions home-actions";
  const confirmBtn = document.createElement("button");
  confirmBtn.className = "btn primary";
  confirmBtn.textContent = "Confirm Landing";
  confirmBtn.disabled = true;
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn ghost";
  cancelBtn.textContent = "Cancel";
  actions.append(confirmBtn, cancelBtn);

  card.append(h, p, canvasWrap, hint, actions);
  overlay.appendChild(card);

  const ctx = canvas.getContext("2d");
  let picked = null;   // {x,y} in canvas pixel space, or null before the first click
  const draw = () => {
    ctx.fillStyle = "#05070f";
    ctx.fillRect(0, 0, mmW, mmH);
    const sx = mmW / map.width, sy = mmH / map.height;

    // The destination's static terrain silhouette — rough and high ground, in the same
    // faint shades minimap.js's own terrain layer uses (minimap.js renderUnderlay). Geography
    // is charted map knowledge from orbit, not battlefield intel (see the header comment) —
    // but deposits, fog and any enemy/unit intel besides the player's own footprint below stay
    // exactly as hidden as before; only the terrain TYPE grid is read here. Feature cells only
    // (OPEN draws nothing), same as minimap.js.
    const terr = map.terrain;
    if (terr) {
      for (let gy = 0; gy < terr.rows; gy++) {
        const row = gy * terr.cols;
        for (let gx = 0; gx < terr.cols; gx++) {
          const code = terr.type[row + gx];
          if (!code) continue;
          ctx.fillStyle = code === 2 ? "rgba(255, 209, 102, 0.20)" : "rgba(120, 140, 180, 0.18)";
          ctx.fillRect(gx * terr.cell * sx, gy * terr.cell * sy, terr.cell * sx + 1, terr.cell * sy + 1);
        }
      }
    }

    // A faint reference grid on top of the terrain — spatial context (roughly where on the
    // chart you're clicking) without revealing anything else about the world.
    ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
    ctx.lineWidth = 1;
    for (let gx = 1; gx < 4; gx++) { const x = (mmW / 4) * gx; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, mmH); ctx.stroke(); }
    for (let gy = 1; gy < 4; gy++) { const y = (mmH / 4) * gy; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(mmW, y); ctx.stroke(); }
    ctx.strokeStyle = "rgba(255, 255, 255, 0.16)";
    ctx.strokeRect(0.5, 0.5, mmW - 1, mmH - 1);

    // The player's own footprint on this world, if any — see the header comment. Never
    // fog-gated (it's the player's own owned intel), and drawn every time regardless of
    // `picked` so it's visible before the first click, not just after.
    ctx.fillStyle = dest.players?.[game.localOwner]?.color || "#4fd1ff";
    for (const b of dest.buildings.values()) {
      if (b.owner !== game.localOwner) continue;
      const bx = b.x * sx, by = b.y * sy;
      if (b.type === "spaceport") {
        ctx.beginPath(); ctx.arc(bx, by, 7, 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.fillRect(bx - 3, by - 3, 6, 6);
      }
    }
    for (const u of dest.units.values()) {
      if (u.owner !== game.localOwner) continue;
      ctx.beginPath(); ctx.arc(u.x * sx, u.y * sy, 2, 0, Math.PI * 2); ctx.fill();
    }

    if (!picked) return;
    // The dashed ring previews the picker's built-in imprecision (LANDING_PICK_GRID, the spacing
    // of the landing sites engine/galaxy.js's snapLandingPoint resolves a click to) — "you'll land
    // roughly here", not a promise of the exact pixel clicked. Half the grid bounds the error:
    // every click is resolved to its NEAREST site, and the extra sites on the margin ring only
    // ever sit closer than a grid step.
    const ringR = (LANDING_PICK_GRID / 2) * (mmW / map.width);
    ctx.strokeStyle = "rgba(255, 209, 102, 0.55)";
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.arc(picked.x, picked.y, ringR, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#ffd166";
    ctx.beginPath(); ctx.arc(picked.x, picked.y, 4, 0, Math.PI * 2); ctx.fill();
  };
  draw();

  const pickAt = (clientX, clientY) => {
    const rect = canvas.getBoundingClientRect();
    const mx = Math.min(mmW, Math.max(0, ((clientX - rect.left) / rect.width) * mmW));
    const my = Math.min(mmH, Math.max(0, ((clientY - rect.top) / rect.height) * mmH));
    picked = { x: mx, y: my };
    hint.textContent = "Landing site marked — Confirm to launch, or click again to move it.";
    confirmBtn.disabled = false;
    draw();
  };
  canvas.addEventListener("click", e => pickAt(e.clientX, e.clientY));

  const previouslyFocused = document.activeElement;
  const close = () => {
    overlay.remove();
    window.removeEventListener("keydown", onKey);
    if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
  };
  const onKey = e => { if (e.key === "Escape") { e.preventDefault(); close(); onCancel(); } };

  confirmBtn.addEventListener("click", () => {
    if (!picked) return;
    const world = minimapToWorld(map, mmW, mmH, picked.x, picked.y);
    close();
    onPick(world);
  });
  cancelBtn.addEventListener("click", () => { close(); onCancel(); });
  overlay.addEventListener("click", e => { if (e.target === overlay) { close(); onCancel(); } });
  window.addEventListener("keydown", onKey);

  document.body.appendChild(overlay);
  canvas.focus();
}
