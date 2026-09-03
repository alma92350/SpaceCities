import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hashStr, seededRng, shade, hexA, polygonPoints, toWorld, inView,
  facing, snapshotPositions, lerpXY, updateFacing, pruneFacing, resetFacing,
  centeredText, drawLabelChip, hiddenByFog,
} from "../renderShared.js";
// Pure engine modules — no DOM anywhere in their import graph, safe to import statically here.
import { createGameState } from "../engine/state.js";
import { updateFog } from "../engine/fog.js";
import { game } from "../session.js";

const closeTo = (actual, expected, eps = 1e-9) =>
  assert.ok(Math.abs(actual - expected) < eps, `expected ${actual} to be within ${eps} of ${expected}`);

/* ---------- hashStr ---------- */

test("hashStr is deterministic — same string, same hash", () => {
  assert.equal(hashStr("relic-node-7"), hashStr("relic-node-7"));
});

test("hashStr returns an unsigned 32-bit integer", () => {
  const h = hashStr("some-entity-id");
  assert.ok(Number.isInteger(h));
  assert.ok(h >= 0 && h <= 0xffffffff);
});

test("hashStr gives different strings different hashes (no trivial collision)", () => {
  const values = ["a", "b", "u1", "u2", "relic-node-7", "relic-node-8"].map(hashStr);
  assert.equal(new Set(values).size, values.length, "no two distinct inputs hashed the same");
});

/* ---------- seededRng ---------- */

test("seededRng is deterministic — same seed replays the same sequence", () => {
  const seed = hashStr("unit-1");
  const draw = () => { const r = seededRng(seed); return Array.from({ length: 10 }, () => r()); };
  assert.deepEqual(draw(), draw());
});

test("seededRng values land in the documented [0, 1) range", () => {
  const r = seededRng(hashStr("irregular-rock-silhouette"));
  for (let i = 0; i < 500; i++) {
    const v = r();
    assert.ok(v >= 0 && v < 1, `sample ${i} = ${v} out of [0,1) range`);
  }
});

test("seededRng gives different seeds different sequences", () => {
  const ra = seededRng(hashStr("a"));
  const rb = seededRng(hashStr("b"));
  assert.notEqual(ra(), rb());
});

/* ---------- shade ---------- */

test("shade returns a well-formed #rrggbb string for any legal percent", () => {
  for (const [hex, pct] of [["#808080", 50], ["#808080", -50], ["#000000", 10], ["#ffffff", -10], ["#4fd1ff", 0]]) {
    const out = shade(hex, pct);
    assert.match(out, /^#[0-9a-f]{6}$/, `shade(${hex}, ${pct}) => ${out}`);
  }
});

test("shade lightens/darkens against known values (clamped at the 0/255 rails)", () => {
  // 50% lighten of mid-gray overshoots white and clamps rather than wrapping.
  assert.equal(shade("#808080", 50), "#ffffff");
  // 50% darken of the same mid-gray clamps near (but not at) black — 128 + round(-127.5) = 1.
  assert.equal(shade("#808080", -50), "#010101");
  // Lightening pure black by 10% is a plain, unclamped shift.
  assert.equal(shade("#000000", 10), "#1a1a1a");
  // Darkening pure white by 10% is the mirror image.
  assert.equal(shade("#ffffff", -10), "#e6e6e6");
  // percent 0 is a no-op.
  assert.equal(shade("#4fd1ff", 0), "#4fd1ff");
});

/* ---------- hexA ---------- */

test("hexA produces an rgba(r, g, b, a) string from a #rrggbb color", () => {
  assert.equal(hexA("#ffffff", 0.5), "rgba(255, 255, 255, 0.5)");
  assert.equal(hexA("#ff8000", 1), "rgba(255, 128, 0, 1)");
  assert.equal(hexA("#000000", 0), "rgba(0, 0, 0, 0)");
});

/* ---------- polygonPoints / toWorld ---------- */

test("polygonPoints(0,0,r,4,0) places a 4-gon's vertices on the axes", () => {
  const pts = polygonPoints(0, 0, 10, 4, 0);
  assert.equal(pts.length, 4);
  const [p0, p1, p2, p3] = pts;
  closeTo(p0[0], 10); closeTo(p0[1], 0);     // 0deg  -> (r, 0)
  closeTo(p1[0], 0);  closeTo(p1[1], 10);    // 90deg -> (0, r)
  closeTo(p2[0], -10); closeTo(p2[1], 0);    // 180deg -> (-r, 0)
  closeTo(p3[0], 0);  closeTo(p3[1], -10);   // 270deg -> (0, -r)
});

test("toWorld at angle 0 leaves a local point untouched, just translated", () => {
  const [x, y] = toWorld(100, 200, 0, 5, 3);
  closeTo(x, 105); closeTo(y, 203);
});

test("toWorld at 90deg rotates the local +x axis onto world +y", () => {
  const [x, y] = toWorld(0, 0, Math.PI / 2, 5, 0);
  closeTo(x, 0); closeTo(y, 5);
});

test("toWorld at 180deg flips the local +x axis onto world -x", () => {
  const [x, y] = toWorld(0, 0, Math.PI, 5, 0);
  closeTo(x, -5); closeTo(y, 0);
});

/* ---------- inView ---------- */

test("inView: a point inside the rect is in view", () => {
  const view = { minX: 0, maxX: 100, minY: 0, maxY: 100 };
  assert.equal(inView(view, 50, 50), true);
});

test("inView: a point outside the rect, no radius, is not in view", () => {
  const view = { minX: 0, maxX: 100, minY: 0, maxY: 100 };
  assert.equal(inView(view, 150, 50), false);
});

test("inView: radius padding pulls an otherwise-outside point back into view", () => {
  const view = { minX: 0, maxX: 100, minY: 0, maxY: 100 };
  assert.equal(inView(view, 110, 50, 20), true, "radius 20 reaches back to x=90 <= maxX 100");
  assert.equal(inView(view, 110, 50, 5), false, "radius 5 only reaches x=105, still outside");
});

test("inView: a point exactly on the boundary counts as in view", () => {
  const view = { minX: 0, maxX: 100, minY: 0, maxY: 100 };
  assert.equal(inView(view, 100, 100), true);
});

test("inView: radius padding on the low side works the same way", () => {
  const view = { minX: 0, maxX: 100, minY: 0, maxY: 100 };
  assert.equal(inView(view, -5, 50, 10), true, "x+r = 5 >= minX 0");
  assert.equal(inView(view, -15, 50, 10), false, "x+r = -5 < minX 0");
});

/* ---------- facing / position interpolation bookkeeping ---------- */
// A small hand-built fake `state`: just the Maps these helpers actually read
// (`state.units`, `state.buildings`) — no engine, no canvas.

function fakeState(units = []) {
  return {
    units: new Map(units.map(u => [u.id, u])),
    buildings: new Map(),
  };
}

test("snapshotPositions + lerpXY: interpolates between the pre-tick snapshot and the live position", () => {
  resetFacing();
  const u = { id: "u1", x: 0, y: 0 };
  const state = fakeState([u]);

  snapshotPositions(state);   // baseline: {x:0, y:0}
  u.x = 10; u.y = 0;          // the tick moved it

  const start = lerpXY(u, 0);
  closeTo(start.x, 0); closeTo(start.y, 0);

  const mid = lerpXY(u, 0.5);
  closeTo(mid.x, 5); closeTo(mid.y, 0);

  const end = lerpXY(u, 1);   // alpha >= 1 -> the live position, no interpolation
  assert.equal(end, u);
});

test("lerpXY returns the live unit directly when there's no baseline yet (just-spawned)", () => {
  resetFacing();
  const state = fakeState([]);   // u2 was never snapshotted
  const u = { id: "u2", x: 42, y: 7 };
  const pos = lerpXY(u, 0.3);
  assert.equal(pos, u, "no prevPos entry -> the live unit is returned as-is");
});

test("lerpXY snaps (doesn't interpolate) across a teleport-sized jump", () => {
  resetFacing();
  const u = { id: "u3", x: 0, y: 0 };
  const state = fakeState([u]);
  snapshotPositions(state);
  u.x = 1000; u.y = 0;   // far past the 60-unit teleport threshold in one tick
  const pos = lerpXY(u, 0.5);
  assert.equal(pos, u, "a teleport-sized move is snapped to the live position, not lerped");
});

test("updateFacing: a fresh unit defaults to facing up, then turns toward real movement", () => {
  resetFacing();
  const u = { id: "u4", x: 0, y: 0 };

  const firstAngle = updateFacing(u);
  closeTo(firstAngle, -Math.PI / 2, 1e-12);

  u.x = 10; u.y = 0;   // moved right
  const secondAngle = updateFacing(u);
  closeTo(secondAngle, 0, 1e-12);   // atan2(0, 10) === 0 -> facing +x
});

test("updateFacing: a near-stationary unit keeps its previous angle (no jitter)", () => {
  resetFacing();
  const u = { id: "u5", x: 0, y: 0 };
  updateFacing(u);
  u.x = 10; u.y = 0;
  const moved = updateFacing(u);
  u.x += 0.1;   // well under the 0.5 movement threshold
  const stillFacing = updateFacing(u);
  closeTo(stillFacing, moved, 1e-12);
});

test("pruneFacing drops entries for entities no longer in state.units/buildings", () => {
  resetFacing();
  const u = { id: "u6", x: 0, y: 0 };
  const state = fakeState([u]);
  snapshotPositions(state);
  updateFacing(u);
  assert.ok(facing.has("u6"));

  state.units.delete("u6");   // u6 "died"
  pruneFacing(state);

  assert.equal(facing.has("u6"), false, "facing entry for a dead unit is pruned");
  // Its interpolation baseline is pruned too, observable via lerpXY falling back to the live unit.
  assert.equal(lerpXY(u, 0.5), u);
});

test("pruneFacing keeps entries for entities that are still alive", () => {
  resetFacing();
  const u = { id: "u7", x: 0, y: 0 };
  const state = fakeState([u]);
  updateFacing(u);
  pruneFacing(state);
  assert.ok(facing.has("u7"), "a still-live unit's facing entry survives pruning");
});

test("resetFacing clears both the facing map and the interpolation baselines", () => {
  const u = { id: "u8", x: 0, y: 0 };
  const state = fakeState([u]);
  snapshotPositions(state);
  updateFacing(u);
  assert.ok(facing.has("u8"));

  resetFacing();

  assert.equal(facing.size, 0);
  assert.equal(lerpXY(u, 0.5), u, "no interpolation baseline survives resetFacing");
});

// --- explicitly out of scope for this fix (see scopeNotes in the task report) -----------------
// pathPoints / pathOriented / drawHealthBar all draw directly onto a CanvasRenderingContext2D
// (beginPath/moveTo/lineTo/fillRect/fillStyle) with no return value to assert on — testing them
// meaningfully needs a ctx stub recording calls, which is more "mock a canvas" than "open a
// crack" in this pure-helpers file. Skipped by design; the geometry they're built on
// (toWorld/polygonPoints) is covered above.

test("shade and hexA return identical strings for repeated (hex, arg) pairs (T2)", async () => {
  // Behavioural invariance for the memo below. Both are called from inside the per-frame draw loop
  // and each builds three or four short-lived strings per call (slice, toString(16), padStart, a
  // template) — measured at ~0.9 MB/s of garbage across a full frame at 306 units. Only two owner
  // colours and about a dozen fixed percentages ever occur, so the hit rate is effectively 100%.
  const { shade, hexA } = await import("../renderShared.js");
  for (const [hex, pct] of [["#5ec8ff", -25], ["#5ec8ff", 20], ["#ff5e3d", -25], ["#000000", 0], ["#ffffff", 99]]) {
    assert.equal(shade(hex, pct), shade(hex, pct), `shade(${hex}, ${pct}) must be stable`);
    assert.match(shade(hex, pct), /^#[0-9a-f]{6}$/, "and still a six-digit hex");
  }
  assert.equal(shade("#000000", -50), "#000000", "clamps at black");
  assert.equal(shade("#ffffff", 50), "#ffffff", "and at white");
  for (const a of [0, 0.5, 1]) assert.equal(hexA("#5ec8ff", a), hexA("#5ec8ff", a));
  assert.equal(hexA("#5ec8ff", 0.5), "rgba(94, 200, 255, 0.5)");
});

/* ---------- centeredText: the restore is the point ---------- */

// A recording ctx: textAlign/textBaseline/font/fillStyle round-trip as real properties, every
// method is captured. Not the shared no-op double (test/_dom.js) — this suite has to read the
// canvas STATE back after the call, which a no-op proxy cannot report.
function recCtx() {
  const calls = [];
  const state = { textAlign: "left", textBaseline: "alphabetic", font: "10px sans-serif", fillStyle: "#000" };
  return {
    calls, state,
    get textAlign() { return state.textAlign; }, set textAlign(v) { state.textAlign = v; },
    get textBaseline() { return state.textBaseline; }, set textBaseline(v) { state.textBaseline = v; },
    get font() { return state.font; }, set font(v) { state.font = v; },
    get fillStyle() { return state.fillStyle; }, set fillStyle(v) { state.fillStyle = v; },
    fillText(...a) { calls.push(["fillText", a, { ...state }]); },
    fillRect(...a) { calls.push(["fillRect", a, { ...state }]); },
    measureText(t) { return { width: t.length * 6 }; },
  };
}

test("centeredText draws centered and then puts the canvas text state back", () => {
  // textAlign/textBaseline are canvas-WIDE state, not per-call arguments, so a helper that
  // centers text and walks away shifts every later draw in the frame — in a different file,
  // where nobody would look. Two sites shipped exactly that bug, invisible only because
  // drawFrame's outer save/restore swallowed it once per frame.
  const ctx = recCtx();
  centeredText(ctx, "⚙", 40, 25, "bold 9px sans-serif");

  const [name, args, at] = ctx.calls[0];
  assert.equal(name, "fillText");
  assert.deepEqual(args, ["⚙", 40, 25]);
  assert.equal(at.textAlign, "center", "centered AT THE MOMENT OF THE DRAW, not merely at some point");
  assert.equal(at.textBaseline, "middle");
  assert.equal(at.font, "bold 9px sans-serif");

  assert.equal(ctx.textAlign, "left", "and the canvas default is restored afterwards");
  assert.equal(ctx.textBaseline, "alphabetic");
});

test("centeredText honours a caller-chosen baseline and still restores the default", () => {
  // renderNodes' commodity glyph sits on a hand-tuned +3 offset rather than being vertically
  // centered, so it passes "alphabetic" — the restore must not be confused by that.
  const ctx = recCtx();
  centeredText(ctx, "◆", 10, 13, "10px sans-serif", "alphabetic");
  assert.equal(ctx.calls[0][2].textBaseline, "alphabetic");
  assert.equal(ctx.textBaseline, "alphabetic");
  assert.equal(ctx.textAlign, "left");
});

/* ---------- drawLabelChip ---------- */

test("drawLabelChip sizes its plate from the measured text, and paints it BEFORE the label", () => {
  // The plate has to be measured, not constant: the two call sites feed it labels that range
  // from "⛏ blind spot — no surface to read (a gamble)" to "Tier 2 · draw ×1.4", and a plate
  // sized by a stale constant is a legible label on an illegible background.
  const ctx = recCtx();
  const label = "Tier 2 · draw ×1.4";
  drawLabelChip(ctx, label, 100, 60, "#5ec8ff");

  const [rect, text] = ctx.calls;
  assert.equal(rect[0], "fillRect", "the plate is painted first, or it would cover the label");
  assert.equal(text[0], "fillText");

  const w = ctx.measureText(label).width;
  assert.deepEqual(rect[1], [100 - w / 2 - 5, 60 - 15, w + 10, 17], "plate wraps the measured width");
  assert.equal(rect[2].fillStyle, "rgba(5, 7, 15, 0.78)", "default plate colour");
  assert.equal(text[2].fillStyle, "#5ec8ff", "the label takes the caller's colour, not the plate's");
  assert.deepEqual(text[1], [label, 100, 60]);
});

test("drawLabelChip's plate grows with a longer label", () => {
  const short = recCtx(), long = recCtx();
  drawLabelChip(short, "abc", 0, 0, "#fff");
  drawLabelChip(long, "abcdefghijkl", 0, 0, "#fff");
  assert.ok(long.calls[0][1][2] > short.calls[0][1][2], "a longer label gets a wider plate");
});

/* ---------- hiddenByFog ---------- */

// Four draw passes carried their own copy of this rule. Every clause is easy to get backwards
// and the failure is silent in the direction that matters: an inverted or dropped test doesn't
// crash or look wrong, it quietly paints the enemy's army through the fog.
test("hiddenByFog never hides the player's own entities, fog or no fog", () => {
  // The player always sees their own units — including ones standing in unexplored territory,
  // which is the normal case for a scout the instant it moves.
  const dark = { fog: { w: 1, h: 1, vis: new Uint8Array(1) } };
  assert.equal(hiddenByFog(dark, { owner: "player" }, 0, 0), false);
});

test("hiddenByFog hides an enemy standing outside vision, and reveals one inside it", () => {
  const state = createGameState({ planetId: "ferros", seed: 77 });
  updateFog(state, state.fog, "player");
  const cc = [...state.buildings.values()].find(b => b.owner === "player" && b.type === "command");
  const far = { x: state.map.width - 1, y: state.map.height - 1 };

  assert.equal(hiddenByFog(state, { owner: "ai" }, cc.x, cc.y), false,
    "an enemy standing on the player's own Command Center is plainly in vision");
  assert.equal(hiddenByFog(state, { owner: "ai" }, far.x, far.y), true,
    "and one in the far corner, outside every sight radius, is not drawn");
});

test("hiddenByFog's observer mode reveals everything without touching the fog it bypasses", () => {
  // observerMode is the self-play/replay camera. It must bypass the gate rather than mutate
  // state.fog — a camera that reveals by writing to the fog would corrupt the very state the
  // player's own rendering reads (see observer.js's header).
  const state = createGameState({ planetId: "ferros", seed: 78 });
  updateFog(state, state.fog, "player");
  const far = { x: state.map.width - 1, y: state.map.height - 1 };
  const before = JSON.stringify(state.fog);

  assert.equal(hiddenByFog(state, { owner: "ai" }, far.x, far.y, true), false, "observer sees it");
  assert.equal(JSON.stringify(state.fog), before, "and the fog itself is untouched by the look");
});

// T-030: hiddenByFog's "is this mine" half reads game.localOwner, not a hardcoded "player" — a
// seat B viewer (localOwner "ai") must never hide their OWN entities the way a seat A viewer's
// hardcoded check would have.
test("T-030: hiddenByFog respects game.localOwner, not a hardcoded \"player\"", () => {
  const original = game.localOwner;
  try {
    game.localOwner = "ai";
    const dark = { fog: { w: 1, h: 1, vis: new Uint8Array(1) } };
    assert.equal(hiddenByFog(dark, { owner: "ai" }, 0, 0), false, "seat B's own entity is never hidden from seat B");
    assert.equal(hiddenByFog(dark, { owner: "player" }, 0, 0), true, "an unexplored enemy entity is hidden, same rule as before, just the other way round");
  } finally { game.localOwner = original; }
});
