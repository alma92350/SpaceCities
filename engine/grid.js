// @ts-check
/* ============================================================
   Uniform spatial hash over units, rebuilt once per tick by sim.js. It's a
   BROAD PHASE only: a query returns candidate units whose cell is near a point,
   and the caller still does the exact live-distance test it did before. That
   turns the three per-tick O(n^2) neighbour scans — separation, movement
   avoidance, and combat target acquisition — into local lookups, which is what
   lets a Gigantic (4x) map with hundreds of units stay inside the frame budget.

   The grid is built from pre-movement positions and reused through the whole
   tick (units move, then separate, after the build), so every query box is
   padded by an extra ring of cells. One tick's displacement is far under a
   cell, so the padded candidate set is always a superset of the true
   neighbours — no interaction is ever missed, only a few extra candidates get
   the cheap distance check and fall out.

   When state.unitGrid is absent (the many unit tests that call movement /
   combat / separation directly without a full tick) every consumer falls back
   to the original full scan, so their behaviour is byte-for-byte unchanged.
   ============================================================ */

"use strict";

const CELL = 96;
// Integer cell key instead of a "cx,cy" string: the old key allocated + hashed a string for
// every unit inserted AND every cell queried, every tick — pure per-tick garbage on the hot
// path. Packing (cx,cy) into one int is a plain arithmetic Map key. KEY_PAD offsets the few
// negative cells the query pad reaches; KEY_STRIDE exceeds the max cells-per-axis of any map
// (Gigantic ≈ 67), so the packing is collision-free. This changes NOTHING observable: cells
// bucket the same units in the same order, and queryNeighbors visits cells in the same fixed
// loop, so candidate lists are byte-for-byte identical — the determinism test stays green.
const KEY_PAD = 16;      // headroom for the most negative cell any query pad reaches (radius up to ~1400px)
const KEY_STRIDE = 4096;  // > max cells per axis (a huge map is ~67), so (cx+PAD) and (cy+PAD) never overlap
function cellKey(cx, cy) { return (cx + KEY_PAD) * KEY_STRIDE + (cy + KEY_PAD); }

/** @param {State} state */
export function buildUnitGrid(state) {
  const buckets = new Map();
  let i = 0;
  for (const u of state.units.values()) {
    u._gi = i++;   // stable Map-order index: lets separation process each pair once, deterministically
    const k = cellKey(Math.floor(u.x / CELL), Math.floor(u.y / CELL));
    let arr = buckets.get(k);
    if (!arr) buckets.set(k, (arr = []));
    arr.push(u);
  }
  return { cell: CELL, buckets };
}

// Results go into a caller-owned buffer, reused across calls instead of
// allocating a fresh array every query (this file's no-per-tick-garbage goal).
//
// It used to be ONE shared module-level array, safe only by a convention stated
// in this comment: every call site reads the result in an immediate for-of and
// discards it before querying again. Six call sites across four modules had to
// keep that promise, and combat.js's acquireTarget already bent it — it passes
// its candidate array on to spreadEnemy to iterate. spreadEnemy doesn't query
// today, so it was fine today; the day anything reachable from that loop gained
// a neighbour lookup, the array would be overwritten mid-iteration. The failure
// mode is silently wrong targeting, and no determinism test could see it (both
// runs of a seeded replay would corrupt identically).
//
// Per-call-site buffers cost exactly the same zero garbage and make the
// invariant structural: two sites can no longer alias, whatever the call order.
// This shared one remains only as the default for ad-hoc and test callers;
// test/grid-superset.test.js asserts that no engine call site relies on it.
const _scratch = [];

/* ---- Query padding: how stale a bucket position can be ------------------
   The buckets hold positions from the top of the tick, but every caller
   filters against LIVE positions, so the box has to be widened by however far
   the two units involved can have moved since the build. Get this wrong and
   the broad phase silently stops being a superset: an interaction is missed,
   no determinism test can see it (both runs miss it identically), and the
   symptom is a unit that occasionally fails to dodge or to acquire.

   How far that is depends on WHEN in the tick you ask, so there are two pads
   rather than one number covering the worst case everywhere:

   PAD_MOVE_PHASE — for queries made inside sim.js's `updateUnit` loop. The
     only position writes that have happened by then are movement steps, and
     `stepToward` caps one at `speed * speedMult * terrainMult * dt`: the
     fastest hull (Ranger, 115 px/s) with the largest multipliers in the game
     (1.08 faction x 1.12 map asym) at the 1/20 s fixed timestep is 7.0 px, and
     terrainMult only ever slows a unit. Both units in a pair can have taken one
     step, so the relative staleness is 2 x 7.0 = 14.0 px. 32 leaves a 2.3x
     margin, and test/grid-superset.test.js re-derives that bound from the
     game's own unit and modifier tables so a faster hull trips it.

     Only movement avoidance uses it today. Combat acquisition and splash look
     like they qualify — they run in that same loop for units — but they are
     ALSO reached from `updateBuildingCombat` in the building loop, which runs
     after separation, so they have to take the conservative pad.

   PAD_FULL_TICK — for queries made after `applySeparation` (Mender repair),
     and by the separation pass itself, which additionally see separation
     pushes. Those are NOT analytically bounded: a push is capped at
     PUSH_SPEED * dt / 2 = 1.5 px per pair, but a unit in a dense pile takes
     many pushes in one pass. Measured worst case over adversarial fixtures
     (400 units crammed onto one point on a Gigantic map) is 38.7 px, so ~77 px
     of relative staleness — which is why this pad stays at the 96 px the
     old `-1`/`+1` ring of cells happened to give. That margin is thinner than
     it looks and is the subject of a known-issue note in TASKS.md.

   Both are enforced by test/grid-superset.test.js, which measures real
   displacement against these constants and brute-force-checks the box
   arithmetic. Before this, the padding was a `-1`/`+1` ring whose only stated
   rationale was a comment — and at CELL = 96 that ring applied the full
   worst-case 96 px pad to every query in the game, including the movement
   avoidance query that is half the simulation's CPU. */
export const PAD_MOVE_PHASE = 32;
export const PAD_FULL_TICK = 96;

/* Widening factor for the squared-distance pre-reject every consumer of this
   broad phase uses before paying for a Math.hypot.

   The pattern: the candidate set is a superset, so most candidates are about to
   be thrown away by an exact-distance test, and calling Math.hypot on each one
   first was the single largest cost in the simulation. Rejecting on
   `dx*dx + dy*dy >= reach*reach * REJECT_SLACK` skips almost all of them
   without a square root, and whatever survives still takes the ORIGINAL exact
   test, unchanged, so the values that feed the sim are bit-identical.

   The slack is what makes that "bit-identical" provable rather than merely
   observed. Math.hypot and a squared comparison can disagree in the last ulp —
   a relative difference around 1e-16 — so a cheap test widened by 1e-4 cannot
   discard a pair the exact test would have kept. It costs a few extra hypot
   calls on candidates sitting exactly on the boundary. */
export const REJECT_SLACK = 1.0001;

// Work counters for the perf guard. Candidate visits are a deterministic,
// machine-independent measure of broad-phase cost: unlike wall clock they
// cannot flake on a loaded runner, and they move the instant the query box
// grows. Two integer adds per query — nothing per candidate. Reporting only:
// nothing in the sim reads them, so they cannot influence a replay.
let _queries = 0, _candidates = 0;
/** @returns {{ queries: number, candidates: number }} */
export function neighborQueryStats() { return { queries: _queries, candidates: _candidates }; }
/** @returns {void} */
export function resetNeighborQueryStats() { _queries = 0; _candidates = 0; }

// Candidate units in every cell overlapping the (radius + pad) box around
// (x, y). A superset of the units within `radius` — callers filter by exact
// distance. Cells are visited in a fixed numeric order and bucket contents keep
// Map insertion order, so iteration is fully deterministic.
// `pad` defaults to the worst case (PAD_FULL_TICK), so a call site that hasn't
// thought about when in the tick it runs gets the safe answer; a caller that
// runs inside the movement pass passes PAD_MOVE_PHASE to say so.
// `out` is the caller's own reusable buffer (see _scratch above) — it is
// cleared and refilled, so read it before querying again on the same buffer.
/** @param {*} grid @param {number} x @param {number} y @param {number} radius @param {number} [pad] @param {(Unit)[]} [out] @returns {(Unit)[]} */
export function queryNeighbors(grid, x, y, radius, pad = PAD_FULL_TICK, out = _scratch) {
  const cell = grid.cell;
  const reach = radius + pad;
  const mincx = Math.floor((x - reach) / cell);
  const maxcx = Math.floor((x + reach) / cell);
  const mincy = Math.floor((y - reach) / cell);
  const maxcy = Math.floor((y + reach) / cell);
  out.length = 0;
  for (let cy = mincy; cy <= maxcy; cy++) {
    for (let cx = mincx; cx <= maxcx; cx++) {
      const arr = grid.buckets.get(cellKey(cx, cy));
      if (arr) for (const u of arr) out.push(u);
    }
  }
  _queries++; _candidates += out.length;
  return out;
}
