# ADR-0006: Id-based, server-stamped, tick-scheduled command protocol

**Status:** Accepted
**Date:** 2026-08-30
**Serves:** PRD FR-8, FR-10, FR-19, NFR-8
**Evidence:** [`docs/analysis/02-command-wire-protocol.md`](../analysis/02-command-wire-protocol.md)

## Context

ADR-0003 makes the server authoritative, so player intent must cross a wire as **data**. Today it
does not: `engine/commands.js` takes **live object references** — `issueMove(units, x, y, …)` is
handed unit objects, not ids. Object references do not serialize.

The audit also corrected a scope assumption this port was carrying. `engine/commands.js` is the
whole *unit-order* surface, but **not** the whole intent surface: `hudSelection.js:20-35` imports and
calls roughly **20 further cost-bearing engine mutators** directly — production queueing, research,
market trades, diplomacy, colony and galaxy actions. Those are where resources are actually spent,
so the protocol must cover them too. A protocol built only around `issue*` would have shipped with
the economy wide open.

The anti-cheat surface is concrete. Without server-side ownership checks a modified client can
command another player's army, spend another player's resources, and recycle their buildings —
`issueRecycle` in particular performs no ownership check at all, despite a comment in
`engine/recycle.js:87-89` claiming it does.

## Options considered

### A. Change `engine/commands.js` to take ids
**Pros.** One representation everywhere; no adapter.
**Cons.** Touches ~22 exported functions and every call site across the client, the AI and the
inherited tests — a very large diff through the most heavily tested code in the repo, against
2,519 tests and a determinism guard, for no behavioural gain. It also maximizes divergence from
upstream, directly raising the cost of every future merge (ADR-0002).

### B. Keep object signatures; wrap with a codec that resolves ids server-side
**Pros.** The engine is untouched, so the inherited suite keeps testing exactly what it tested
before, and the upstream diff stays small. All the new, risky logic — resolution, ownership,
validation, rate limits — lands in one new module that can be tested adversarially in isolation.
**Cons.** Two representations coexist (wire ids, engine objects), and the boundary between them
must be the *only* way in, or validation can be bypassed.

## Decision

**Option B: wrap, do not rewrite.**

`net/commandCodec.js` owns encode/decode/validate/apply and is the **sole path** from wire to
engine. Its rules:

1. **Id-based envelope, versioned.** Entities travel as id strings, resolved server-side.
2. **The server stamps the owner. Always.** A client's claimed `ownerId` is advisory telemetry and
   is never trusted; the seat is determined by the authenticated connection. This single rule
   closes the command-another-player's-army and spend-another-player's-resources classes at once.
3. **Order of a selection is significant and must never be sorted.** `ids[0]` is the formation
   leader (`engine/commands.js:145`, `:195`) and `issueEscort` derives ring slots from array index
   (`:363`). Canonicalizing the array — the obvious thing to do when de-duplicating input — would
   silently change formations.
4. **Deterministic application order:** `(applyTick, ownerIndex, clientSeq)`, where
   `ownerIndex = state.owners.indexOf(owner)`. Commands apply **immediately before**
   `tick(state, dt)`, never inside it.
5. **`state.selection` is UI-only** and moves to the client session. The field remains on `State` as
   a permanently-empty array — `removeEntity` writes it (`engine/state.js:347`) — guarded by a test
   asserting no server module *reads* it.
6. **The economy surface is in scope**, not just `issue*`.

**Exactly one engine signature changes:** `issueSetRally(building, …)` → `issueSetRally(state,
buildingId, …)`, 3 call sites. It is the one command whose only handle on its target is an object
reference with no id-based route, so wrapping it would mean inventing a lookup the engine already
owns.

## Consequences

**Gains.** The engine keeps its shape, so the inherited suite keeps its meaning and upstream merges
stay cheap. Every new security-relevant decision lives in one file with one entry point. A match
becomes replayable from `{engineCommit, createGameStateOpts, dt, aiSeatConfigs, orderedCommandLog}`
(FR-19).

**Costs.** The codec is a chokepoint that must not be bypassed — any future code calling `issue*`
directly on the server re-opens everything the codec closes. This needs a guard test in the style of
`test/engine-purity.test.js`, which the repo already uses for exactly this kind of invariant.

**Follow-on work.** Fix the defects this audit surfaced before the codec ships — in particular
`issueRecycle`'s missing ownership check, the false comment documenting it, and friendly-fire on
explicit attack orders (`engine/combat.js:46`). Fix the formation gate (see ADR-0008). Write the
adversarial codec test suite: cross-seat commands, unaffordable commands, unknown ids, malformed
envelopes, flooding.

**Revisit if.** The two-representation boundary proves leaky in practice — at which point option A
becomes worth its cost, as a deliberate migration rather than a drift.
