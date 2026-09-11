# Code review — SpaceCities

**Date:** 2026-09-11 · **Reviewer:** external, RTS architecture + TDD focus

## Baseline, measured

| Check | Result |
|---|---|
| `npm test` | **3310 pass, 0 fail** (75 s) |
| Source | ~36k lines (`engine/` 17.0k, root/UI 19.1k, `net/` 2.9k, `server/` 2.3k) |
| Tests | ~54k lines across 169 files |
| ADRs | 13, plus 6 analysis dossiers |

**This is a strong codebase and the review should say so plainly.** The determinism
story is the real thing, not an aspiration: one seeded PRNG, a static purity guard
that follows imports transitively *and* walks out from `index.html` to catch the
`tools/` files that ship to the browser, per-tick frozen count caches so Map
iteration order can't leak into outcomes, and a server-stamped `(applyTick,
ownerIndex, seq)` total order for wire commands. The ADR trail explains *why*
almost everywhere I wanted to know. Most projects claiming "deterministic RTS"
have a fraction of this.

So the findings below are not "you need tests." They are the places where the
discipline that protects `engine/` semantics does not yet protect `engine/`
*performance*, the places where a load-bearing invariant lives only in a comment,
and one TDD gap that matters specifically for a game.

---

## 1. The sim spends half its time in a broad-phase that scans ~13x too much area

**Severity: high (it is the headline performance finding, and it is cheap to fix)**

`engine/movement.js:170 senseLateralAvoidance` is **50.1% of sim CPU** under a CPU
profile at 1000 units. Not because the algorithm is wrong — because of two things
in the layer beneath it.

**Where.** `engine/grid.js queryNeighbors`, `engine/movement.js:177`.

`CELL = 96`, but avoidance queries with radius `selfR + MAX_UNIT_RADIUS +
AVOID_RANGE` = **60**. On top of a box already sized from that radius,
`queryNeighbors` adds a `-1`/`+1` padding ring per axis. Result: a query needing
π·60² ≈ 11k px² of candidates scans a 4×96 by 4×96 = 147k px² box. Every extra
candidate then costs a `Math.hypot` call, because the exact-distance filter runs
*after* the hypot rather than against squared distance.

The padding ring is redundant at this call site: the caller already added
`MAX_UNIT_RADIUS` to the radius, which is exactly what the ring exists to cover.
Dropping it narrows the candidate superset but cannot change results, because
every caller re-filters by exact distance — so determinism is preserved by
construction, not by luck.

**Measured, on this machine, Gigantic map, attack-moving armies:**

| Units | Today | With both changes | 50 ms budget @ 20 Hz |
|---|---|---|---|
| 500 | 12.78 ms/tick | **5.60 ms/tick** | |
| 1000 | 37.94 ms/tick | **13.50 ms/tick** | 76% → 27% consumed |

I prototyped it and ran the full suite: **3310 pass, 0 fail**, determinism
included. The working tree is clean — this is a proposal, not a commit.

The 1000-unit number is the point. At 37.9 ms/tick the server is at 76% of its
tick budget with no GC headroom, and `MAX_SUBSTEPS` degradation in
`engine/loop.js` starts eating sim time. At 13.5 ms it isn't close.

**Proposed:**
1. Drop the `±1` padding ring in `queryNeighbors` (the radius already bounds the box).
2. Filter on `d2 >= detectRange * detectRange`, take `Math.sqrt` only for survivors.
3. Separately, reconsider `CELL = 96`. It is ~1.6x the dominant query radius; the
   usual tuning is cell ≈ query radius. Worth a sweep once (1) and (2) land,
   since they change the shape of the cost.

---

## 2. The performance guards cannot fail

**Severity: high — this is the finding that lets #1 happen again**

`test/perf-guard.test.js` asserts 200 units × 120 ticks finishes in **under
8000 ms**. It actually takes ~680 ms wall clock. A **10x regression ships green.**
The bigger guard has the same shape: 20 s budget for ~4.1 s of work.

The file's header is honest about this — "NOT benchmarks… budgets generous enough
not to flake on a loaded CI runner" — and that reasoning is sound for what it
chose to be. But the result is that the project has *no* signal on sim
performance at all, which is how a 50%-of-CPU broad-phase sat unnoticed in a
codebase this carefully guarded everywhere else.

**Proposed.** Keep the catastrophe alarms, add a second, different instrument:

- Assert **ms/tick at the scale the game actually reaches** (1000 units on a
  Gigantic map), not total wall clock at a scale that was never the risk.
- Commit a baseline number and assert a *ratio* (e.g. fail above 2.5x baseline)
  rather than an absolute wall-clock constant. Ratio-to-committed-baseline is
  what survives a noisy shared runner without going blind.
- Better still, and in this project's own idiom: assert a **work counter**, not
  time. Count candidates visited per tick by `queryNeighbors` and assert a bound.
  That is deterministic, machine-independent, cannot flake, and would have caught
  #1 the day it was introduced. Timing is the weakest available proxy for the
  thing you actually care about, and this codebase has already shown (fog counts,
  logistics counts) that it prefers exact counters to proxies.

---

## 3. `_scratch` is a global invariant enforced only by a comment

**Severity: medium — not a bug today, one refactor from a silent one**

`engine/grid.js` returns a single module-level `_scratch` array from every
`queryNeighbors` call, to avoid per-tick garbage. The header documents the
contract carefully: read it immediately, never hold it, never make a second query
while iterating a prior result.

Six call sites across four modules depend on that. And `engine/combat.js:467`
already bends it: `acquireTarget` queries into `_scratch`, then **passes the
scratch array to `spreadEnemy`** to iterate. `spreadEnemy` doesn't query today, so
it's fine today. The day anyone adds a neighbour lookup inside `spreadEnemy`, or
inside any helper reachable from a `for (const e of cands)` loop, the array is
overwritten mid-iteration. The failure mode is *silent wrong targeting*, it would
be state-dependent and position-dependent, and **no determinism test can see it** —
both same-seed runs would corrupt identically.

This is the one place in the engine where a load-bearing invariant has no
mechanical enforcement, in a codebase whose whole character is mechanical
enforcement of invariants.

**Proposed.** A reentrancy guard that costs nothing in production:

```js
let _depth = 0;   // dev/test only
export function queryNeighbors(grid, x, y, radius) {
  if (ASSERTIONS && _depth > 0) throw new Error("nested queryNeighbors: _scratch would be clobbered");
  // …fill _scratch…
}
```

with callers bracketing their iteration, or — simpler and my preference — have
`queryNeighbors` take a **caller-supplied buffer**. Three or four long-lived
per-call-site arrays cost the same zero garbage and make the invariant
structural instead of conventional.

---

## 4. `tick()`'s phase ordering is load-bearing, documented, and unenforced

**Severity: medium**

`engine/sim.js tick()` is a hand-ordered sequence of ~20 subsystem calls, and
**nine** of them carry a comment explaining that they must run *before* something
else: `countMiners` frozen before any worker mines, `countLogistics` before any
job is assigned, `updateCombustors` before any consumer reads `powerCap`,
`countMenderTargets` before any Mender re-targets, `collectAnvils` before combat.

Every one of those comments is correct and well-written. None of them is a test.
Reordering two lines in that function is a legal-looking edit that produces a
subtly different game — and again, *the determinism suite stays green*, because
both runs reorder identically. The balance tests would catch only a gross change.

**Proposed.** Make the freeze structural rather than conventional: have the freeze phases write their
caches into a per-tick object (`state.frame = { miners, logistics, menders, anvils }`)
that is **sealed** after the freeze block and thrown away at tick end. A consumer
reading `state.frame.miners` before it's populated gets an immediate, loud
failure instead of a quiet `undefined`; a freeze that moves after its consumer
fails on write to a sealed object. The ordering constraint stops being prose.

Lower-effort interim: a test that asserts the *sequence* of phase names emitted by
an instrumented tick against a committed list, so a reorder is a deliberate,
reviewed diff rather than an invisible one.

---

## 5. TDD gap: every determinism assertion is self-comparison

**Severity: medium — the one genuinely missing net for a game**

`determinism.test.js`, `determinism-nseat.test.js`, `determinism-roster.test.js`
all do the same, correct thing: run the same seed twice **in the same process**
and compare fingerprints. That proves the sim is internally consistent. It proves
nothing about whether *today's* sim behaves like *last week's*.

For a strategy game that is the regression class that actually hurts. A tuning
change to avoidance weight, a reordered condition in `acquireTarget`, an off-by-a-tick
in production — none of these break a test. `balance.test.js` asserts directional
invariants (Bastion beats Skiff) which is exactly right as far as it goes, but it
is deliberately qualitative: the triangle can hold while every engagement's
margin has drifted 40%.

**Proposed — a golden match canary.** One test that runs a fixed seed for N
thousand ticks and compares `entitySnapshot` against a **committed** fixture.
The point is not that it must never change; it is that changing it must be a
visible line in a diff with a sentence explaining why. Make the update path a
one-liner (`UPDATE_GOLDEN=1 npm test`) and document in `CONTRIBUTING.md` that
updating it without an explanation in the commit message is the review smell.

This is cheap — the machinery (`entitySnapshot`, seeded runs, fixtures/) all
exists — and it is the single highest-value test this suite doesn't have.

One caveat to design around: it pins you to float reproducibility across Node
versions and CPUs. `mulberry32` is exact, but the sim's float accumulation is
not guaranteed identical across architectures. Either scope the golden to CI's
pinned runner, or fingerprint at reduced precision (positions to 2dp), which
still catches every behavioural drift worth catching.

---

## 6. The engine is beautifully factored; the presentation layer is not

**Severity: low-medium — a velocity finding, not a correctness one**

The asymmetry is stark. `engine/` is 45 modules averaging ~380 lines, each with a
clear seam. Meanwhile:

| File | Lines |
|---|---|
| `competitionScreens.js` | 2720 |
| `hudSelection.js` | 2007 |
| `competitionLedger.js` | 1290 |
| `competition.js` | 1118 |

`hudSelection.js` was itself a split out of `hud.js` "so neither file is a
1000-line god object" — and is now twice that. The 2026-08 review's finding 6 cut
two 780-line functions; the same pressure has re-accumulated one layer up.

The mitigating factor is real: `test/_dom.js` is an unusually good shared DOM
double, and these files *are* tested. So this is not a risk finding. It is that
the cost of changing the competition/HUD surface is now much higher than the cost
of changing the sim, which will quietly steer future work away from the UI.

**Proposed.** No big-bang refactor. Pick the seam that pays: split
`competitionScreens.js` by screen (bracket / ledger / results / setup) the way
`render*.js` is already split by subject. Apply the project's own rule — when a
presentation file passes ~800 lines it gets split by *subject*, not by
"whatever's left" — and write it into `CONTRIBUTING.md` so it is a standing rule
rather than a periodic cleanup.

---

## Suggested order

| # | Finding | Effort | Why now |
|---|---|---|---|
| 1 | Broad-phase over-scan | **S** | 2.8x sim headroom, verified, suite green |
| 2 | Perf guards that can fail | **S** | Without it, #1 recurs |
| 3 | `_scratch` reentrancy | **S** | Silent, undetectable-by-design failure mode |
| 5 | Golden match canary | **M** | The missing regression net |
| 4 | Tick phase ordering | **M** | Same class as #3, larger surface |
| 6 | UI file sizes | **L** | Ongoing, not urgent |

1–3 are each an afternoon and together are the highest return. I'd take them as
one branch, in that order, since #2 is what proves #1 and guards #3.

---

*Everything above was measured against the working tree at review time: full suite
run, CPU profile at 1000 units, and a prototyped fix for #1 validated against all
3310 tests and then reverted.*
