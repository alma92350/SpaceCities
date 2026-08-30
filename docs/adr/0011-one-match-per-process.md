# ADR-0011: One match per worker process

**Status:** Accepted
**Date:** 2026-08-30
**Serves:** PRD FR-19 (reproducibility), NFR-4 (concurrent matches), NFR-8 (determinism)
**Evidence:** [`docs/analysis/02-command-wire-protocol.md`](../analysis/02-command-wire-protocol.md) §8 B1;
[`docs/analysis/00-feasibility-spikes.md`](../analysis/00-feasibility-spikes.md) §Spike 2

## Context

The command-protocol audit found a defect that invalidates the central promise of ADR-0003 — that a
server-hosted match stays deterministic and replayable.

`engine/state.js:23-24`:

```js
let nextEntityId = 1;
function newId(prefix) { return `${prefix}${nextEntityId++}`; }
```

**The entity-id counter is a module global**, reset by `createGameState`. A source comment
(`state.js:17-22`) reasons that ids are only ever compared within one state's own Maps, so two live
games sharing id strings is harmless. That is true for two games — and **false for two games in one
process**, which is exactly what a server does.

Two consequences, both fatal:

1. **Interleaved minting.** Match A's units are named `u57, u59, u62…` depending on what match B did
   in between. Entity ids feed deterministic tie-breaks throughout the sim — movement, separation,
   gather, and `rankSlotsByRange` sorting by `a.id < b.id` (`commands.js:105`). So **the same seed
   and the same command log produce a different match** depending on what else the server hosted at
   the time. Replays, spectating and any rating built on them are invalid.
2. **Id collision.** `createGameState` *resets* the counter to 1, so starting match B mid-match A
   makes A mint ids colliding with its own live entities.

This is a genuine landmine: it produces no error, only quiet divergence.

## Options considered

### A. Fix the counter first, then host many matches per process
Move the counter onto the state (`state.nextEntityId`) or pass a per-match id-minter into
`createGameState`. The existing `peekEntityId`/`restoreEntityId` pair (`state.js:29-31`) shows
persistence already treats it as per-game state.
**Pros.** The correct end state; cheapest use of memory; one process to operate.
**Cons.** Touches `makeUnit`/`makeBuilding` and their call sites across the engine and tests —
a broad diff through determinism-critical code, on the critical path to the *first* multiplayer
match. Divergence from upstream in exactly the files most likely to receive upstream fixes.

### B. One match per worker process; leave the counter alone for now
Each match runs in its own `worker_threads` worker with its own module registry, so the global is
per-match by construction.
**Pros.** Sidesteps the defect completely and immediately, with no engine change. Independently
desirable: it isolates a match that throws, and it uses more than one core — Node is
single-threaded, and the Space has 2 vCPUs. Spike 2 measured p99 of 4.6–9.1 ms per tick for
realistic 200–400-unit matches against a 50 ms budget, so several matches fit per core and workers
multiply that.
**Cons.** Memory per worker (a Node isolate plus one match's state). Cross-match concerns — the
lobby, matchmaking — need message passing to the parent. Does not *fix* the latent defect, so a
future single-process refactor would reintroduce it.

## Decision

**Option B now, option A as scheduled follow-up.**

Each match runs in its own worker process. The parent owns the lobby, the WebSocket connections and
the MCP endpoint, and relays commands and state between sockets and workers.

**This is a deliberate shipping posture, written down as a constraint rather than left as an
accident** — which is the failure mode the audit warns about. The dossier's phrasing is adopted
verbatim as policy: *until the counter is fixed, run one match per Node process.*

The counter fix (option A) is scheduled as its own task, with a guard test that two **interleaved**
`createGameState` runs each replay identically. It is a good upstream contribution, and offering it
upstream is preferred to carrying it as a local divergence.

## Consequences

**Gains.** Determinism and replayability hold from the first multiplayer match, with no engine
change on the critical path. Matches are isolated: one throwing match cannot take down the lobby or
other matches. Both vCPUs get used. The architecture that results — a stateless-ish parent and
independent match workers — is the shape this would want at scale anyway.

**Costs.** Memory per worker sets the concurrency ceiling alongside CPU, and has not yet been
measured (a follow-on measurement in dossier 00). Worker startup adds latency to match creation.
Everything crossing the parent/worker boundary must be structured-cloneable, which constrains the
state-replication design (ADR-0009).

**Follow-on work.** Measure memory per worker. Fix the id counter and offer it upstream. Guard the
constraint with a test asserting two interleaved matches replay identically — so that if anyone
later hosts two matches in one process, the suite says so.

**Revisit if.** Memory per worker turns out to bound concurrency well below the CPU limit — then
option A moves onto the critical path and matches share a process.
