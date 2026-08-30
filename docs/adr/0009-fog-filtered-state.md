# ADR-0009: Per-seat fog-filtered state projection

**Status:** Accepted
**Date:** 2026-08-30
**Serves:** PRD FR-9, FR-10, G2, NFR-3
**Evidence:** [`docs/analysis/03-client-coupling.md`](../analysis/03-client-coupling.md) §4;
[`docs/analysis/00-feasibility-spikes.md`](../analysis/00-feasibility-spikes.md) §Spike 2

## Context

ADR-0003 makes the server authoritative, which raises the question of *what the server actually
sends*. Two options: broadcast the whole state and let each client draw its own fog (what the
single-player game does today), or send each seat only what that seat can see.

The measurements make the cost side clear. Spike 2 found the simulation runs **~500× faster than
real time** — the server spends nearly all its wall clock idle, so **serialization and filtering,
not simulation, are the real server cost**. Whatever we choose here is the performance story.

The client audit makes the difficulty side clear, and it is the opposite of what one would expect:

- `engine/fog.js` is **144 LOC, pure, and already per-owner** — `isVisibleAt`, `isExploredAt`,
  `isNodeDiscovered`, `updateFog(state, fog, owner)`, with `state.fogs[owner]` already existing.
- There is **no remembered snapshot of enemy positions** (`engine/fog.js:14-15` says so
  explicitly): an out-of-vision enemy simply stops rendering. **That is exactly the semantics a
  filtered projection provides.**
- Every per-entity fog gate in the client is already factored into named predicates
  (`renderShared.js:254`, `minimap.js:94,99`, `renderNodes.js:26`, `inputCommands.js:58,62`).
  Under a filtered state those checks become *tautologically true* rather than wrong — **the
  renderer needs no changes to consume a projection.**

So the client was written as if it were already receiving filtered state. It just isn't.

There is also a G2 argument that outweighs the engineering one. **An agent handed the full state
is not playing the same game as a human.** Fog is the central information mechanic of this game;
if the MCP surface projects from unfiltered state, agent play is not a fair contest and the
project's differentiator is gone.

## Options considered

### A. Full-state broadcast; clients draw fog locally
**Pros.** ~2 days of work; every existing client module runs untouched.
**Cons.** Trivially cheatable by anyone who opens devtools — fails FR-9 and FR-10. Payload scales
with *map size* rather than army size. Fails G2 for the reason above.

### B. Per-seat projection: send only what the seat can see
**Pros.** Fog becomes a real information boundary, enforced once, server-side. Payload scales with
army size. Agents and humans provably see the same class of information.
**Cons.** ~a week rather than ~2 days. Needs care about what public information must *still* be
sent (opponent scores, faction roster) and about a grace window so entities leaving vision do not
pop out mid-frame.

## Decision

**Option B.** A single pure function `projectFor(state, seat)` — roughly 60 lines — is the only
thing that produces client-bound state:

```
units      → own ∪ visible enemies, with order/orderQueue/homeCC/target stripped (intel leak)
buildings  → same rule
nodes      → charted nodes always; hidden nodes only where isNodeDiscovered(fogs[seat], n)
players    → full record for this seat; public facts only for others
              (id, name, colour, faction, score, supply, isAI)
fogs       → this seat's fog only
owners     → unchanged (public)
events     → own events, plus any event at a currently-visible point
map        → NOT sent — the client regenerates it deterministically from
              (planetId, seed, sizeMult, resourceMult, swapAsym)
```

Two consequences worth stating separately:

**The map is never transmitted.** `generateMap` is deterministic, so the client rebuilds it from
the five generation inputs. This is the same property that makes saves small upstream.

**The fog grid is never transmitted.** The client already holds everything needed to recompute it —
its own units and buildings, plus the regenerated map — and `updateFog` is pure and
allocation-free. `explored` accumulates client-side because it is monotonic. This removes
**3.9–62.5 KB from every snapshot** and makes payload scale with army size rather than map size.
Only hidden-node discovery stays server-authoritative, as a small id set.

**Full-state broadcast survives as a named, flagged mode** — `spectator` and `replay` — never as the
default. `observer.js` is already precisely that client.

**Migration path** (additive, independently shippable):

- **M0** — write and test `projectFor`, but keep broadcasting full state. Test:
  `projectFor(s, "player")` renders pixel-identically to `s` under the existing render tests. This
  proves the renderer tolerates a projection *before* anything depends on it.
- **M1** — server switches to `projectFor`; fog grid still shipped. Add per-seat public scores and
  the faction roster.
- **M2** — stop shipping fog; client recomputes. Add the discovered-node channel and a grace window
  for entities leaving vision.
- **M3** — delta-encode against the last acknowledged snapshot. Optional until armies grow.

## Consequences

**Gains.** The map-hack class is designed out. Bandwidth scales with army size, and the two largest
payload components (map, fog grid) are eliminated entirely. Agents and humans are provably on equal
information footing, which is the precondition for G2 meaning anything.

**Costs.** ~a week rather than ~2 days. `projectFor` becomes security-critical: a field added to an
entity without considering the projection is an intel leak. It needs a **no-leak crawler test** that
walks a projected state and asserts nothing outside the seat's fog appears — not just spot checks.
Client-side fog recomputation must agree with the server's, or players see ghosts.

**Follow-on work.** Measure projection + serialization cost per client per tick (T-015) — this is
now known to be the dominant server cost, so it deserves a real number before M2. The MCP
observation layer (ADR-0007) must project through this same function, never from raw state.

**Revisit if.** Projection cost per client per tick turns out to dominate the tick budget at 4 seats
— then M3 delta-encoding moves from optional to required, ahead of schedule.
