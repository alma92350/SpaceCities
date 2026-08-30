# ADR-0008: Two seats first, N seats second

**Status:** Accepted
**Date:** 2026-08-30
**Serves:** PRD G1, FR-1, FR-6, NFR-7, NFR-8
**Evidence:** [`docs/analysis/01-engine-nplayer-seams.md`](../analysis/01-engine-nplayer-seams.md) §9

## Context

The PRD wants 2–4 seats. The obvious plan is to generalize the engine to N owners once, then build
multiplayer on top. The audit says that plan is backwards, and the evidence is specific.

**The engine is far more owner-generic than a literal count suggests.** Combat, movement, gather,
haul, repair, supply, industry, production, separation and fog all compare `entity.owner` against a
*bound variable*, never a string literal. Free-for-all combat already works for N sides with **zero
changes**. `engine/victory.js` is already last-side-standing, and `test/ownerScaffold.test.js:55-78`
splices in a third owner (`"rebels"`) and proves it — a passing test for three-way victory exists
today.

Of the 53 owner-literal comparisons in `engine/`, **35 (66%) live in the Odyssey open-world and
scripted-mission layers** (`galaxy.js` 19, `scenarios.js` 4, `colonyPolicy.js` 3, …) that a
multiplayer skirmish never loads. The skirmish-critical residue is ~18 sites.

**The larger surface is outside the engine**: ~80 owner-literal comparisons in the client
(`inputCommands.js` 16, `hudSelection.js` 7, `hud.js` 6, `boot.js` 6, `renderBuildings.js` 6, …),
all encoding *"`player` means me, the local viewer"*. That — not the engine — is the real work.

Two facts then decide the ordering. Keeping `state.owners = ["player","ai"]` **verbatim**, with seat
A driving `"player"` and seat B driving `"ai"`, needs **no `SAVE_VERSION` bump and no map-generator
change** — the two most destructive and least reversible items in the audit. And every engine change
it *does* need is a change N seats needs anyway, so **nothing is thrown away**.

## Options considered

### A. Generalize to N owners first, then build multiplayer
**Pros.** One pass through the engine; no interim state.
**Cons.** Moves the map generator (N start positions on mirror-symmetric maps) and bumps
`SAVE_VERSION` **before the first multiplayer match exists** — re-baselining the determinism
fixtures and invalidating saves while netcode is still unproven. Desync, command ordering and
fairness bugs would then be debugged at N=5 instead of N=2, without a trustworthy replay baseline.

### B. Two seats first, reusing the existing owner ids, then generalize
**Pros.** Determinism baseline **preserved** — all 115 test files and 2,519 tests keep passing,
because owner ids, save shape, map layout and entity-id minting are unchanged. Netcode problems
become observable at N=2 with byte-identical replays available. The engine work is a strict subset
of the N-seat work.
**Cons.** An interim state where seat B is called `"ai"`, which is confusing to read and must not
leak into the UI. The client `localOwner` seam gets built twice if done carelessly.

## Decision

**Option B.** Multiplayer ships first as **two humans on the existing `["player", "ai"]` owner
list**, then generalizes to N seats.

Phase boundaries, adopted from the audit:

| Phase | Content | `SAVE_VERSION` | Map gen | Determinism |
|---|---|---|---|---|
| **1 — 2P human-vs-human** | fog-by-owner in the engine; controller-registry AI dispatch; an `isHumanControlled` predicate; client `localOwner` seam; view-layer fog and selection | 1 (no bump) | unchanged | **preserved** |
| **2 — N seats, FFA** | `ownerDefs` from lobby config; `state.controllers{}`; `opponentsOf()` replacing `otherOwner`; N-fog/N-controller save shape; elimination and surrender | **2** | new radial generator for N ≥ 3 | re-baselined for N ≥ 3; **2-seat replays preserved** |
| **3 — agent/MCP command API** | frozen-snapshot command emission; deterministic apply order | 2 | unchanged | re-baselined deliberately |
| **4 — teams / alliances** | `teamOf()` threaded through combat, auras, separation, fog sharing, victory | 3 | unchanged | re-baselined |

**Phase 1 must fix three fairness asymmetries, or it ships a rigged game.** Each is a hardcoded
owner literal that silently gives one seat an advantage over the other:

1. **`engine/commands.js:155`** — `if (leader.owner !== "player")` means **seat B loses the entire
   leader/follow squad formation mechanic**. Seat A gets formation slots and speed-capped squad
   movement; seat B gets a plain per-unit spread.
2. **`engine/sim.js:241`** — `assignRepair` is gated on `unit.owner === "player"`, and
   `engine/repair.js:104` is *not* Odyssey-gated, so **seat B's idle workers never auto-repair
   damaged buildings** — a material economic edge in a skirmish where base damage is routine.
3. **`engine/combat.js:94`** — kiting is gated on `unit.owner === "ai"`, so only seat B kites.

All three want the same replacement: a predicate (`isHumanControlled(state, owner)`, or
`controllerFor(state, owner) === null`) rather than a literal — **and that predicate is exactly what
Phase 2 needs anyway.**

One further engine fix is **mandatory and desync-critical** before the client rebinds anything:
`engine/gather.js:64` and `engine/scout.js:42` read
`unit.owner === "player" ? state.fog : state.fogAI`. Since `state.fog` is an *alias* into
`state.fogs`, the natural client change — rebinding `state.fog` to "my fog" so render and HUD keep
working — makes these two **engine** lines resolve the wrong fog on every client but the host,
changing gather retargeting and scout waypoints, and diverging the simulation. Silently.

## Consequences

**Gains.** The first multiplayer match arrives without touching the map generator or the save
version. The inherited determinism fixtures stay valid as a regression baseline through the riskiest
phase. Netcode is debugged at N=2 against byte-identical replays. No Phase 1 work is discarded.

**Costs.** An interim period where the second human's owner id is `"ai"` — genuinely confusing, and
it must never surface in the UI (the `localOwner` seam and seat display names must be in place from
the start). Phase 2 re-baselines determinism fixtures for N ≥ 3 and bumps `SAVE_VERSION`, breaking
saved games — planned, but a real cost to schedule and announce.

**Follow-on work.** The `localOwner` client seam replacing ~80 literals is the single largest work
item in Phase 1. `test/ownerScaffold.test.js` is the right place to extend the N-owner guarantees,
and it already exists.

**Revisit if.** The 4-seat requirement becomes urgent enough to overtake shipping a working 2-player
game — in which case Phases 1 and 2 merge, and the cost is a determinism re-baseline before netcode
is proven.
