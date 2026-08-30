# ADR-0004: Single-player runs through the multiplayer path

**Status:** Accepted
**Date:** 2026-08-30
**Serves:** PRD G3 (preserve single-player), G4, NFR-7, NFR-8

## Context

ADR-0003 puts the simulation on a server. That immediately raises the question the rest of this port
depends on: **what happens to the single-player game?**

The naive answer is that single-player keeps calling `engine/` directly, in the browser, exactly as
it does today, and multiplayer gets a separate networked path. It is the smallest change and it is
a trap.

Two code paths to the same simulation means the inherited suite — 2,519 tests, 41,013 lines,
the entire reason this port is affordable (ADR-0002) — exercises **only the single-player path**.
The multiplayer path, the one carrying all the new risk, would be covered by whatever new tests we
write, and nothing else. The existing suite would keep passing while multiplayer broke, which is the
precise failure mode a safety net exists to prevent.

There is a second cost. Every feature would need implementing twice, and the two would drift. The
upstream README already documents what that drift looks like: `main.js`'s side-effect imports are
"load-bearing", so "dropping one silently disables a feature rather than raising an error". Parallel
paths that are *supposed* to behave identically fail exactly this quietly.

## Options considered

### A. Two paths: direct `engine/` calls for single-player, network for multiplayer
**Pros.** Single-player is untouched; zero risk to it in the short term.
**Cons.** The inherited suite stops covering the risky path. Every feature is built twice and
drifts. Bugs reproduce in one mode and not the other. **Rejected.**

### B. Single-player becomes an online match against AI on the real server
**Pros.** Exactly one path, trivially.
**Cons.** Kills offline play, makes the game unplayable when the Space sleeps, and makes a solo
match depend on a network round-trip per order. Fails G3.

### C. One path, two transports: single-player uses an in-process loopback transport
The client always talks to a *session* through a transport interface. In multiplayer that transport
is a WebSocket to a remote server; in single-player it is a direct in-process link to a server
object running in the same tab. Same protocol, same command encoding, same server logic — no socket.
**Pros.** One code path, so the inherited suite covers the multiplayer machinery every time it runs
a single-player match. Offline play preserved (G3). The loopback path is synchronous and
deterministic, making it the ideal substrate for tests. Latency and packet loss can be *simulated*
in the loopback transport, so netcode edge cases become unit-testable with no network.
**Cons.** Single-player now pays command encode/decode and state-filtering costs it did not before.
The transport abstraction is indirection that a purely single-player game would not need. Some
inherited tests that construct state and call `issue*` directly may need a thin harness.

## Decision

**Option C.** The client never touches `engine/` mutation directly. It holds a *session* backed by a
transport:

```
browser client ──▶ Transport ──▶ Server session ──▶ engine/
                     │
      ┌──────────────┴───────────────┐
  LoopbackTransport            WebSocketTransport
  (same process,               (remote, async,
   sync, single-player)         multiplayer)
```

Both transports implement one interface. Single-player constructs a server session in the tab and
wires a loopback transport to it. Multiplayer opens a socket. **Nothing else differs**, including
command encoding, ownership validation and per-seat state filtering — single-player validates its
own commands and filters its own fog, and pays the small cost of doing so.

The loopback transport gains a test-only fault-injection mode (added latency, reordering, drops) so
that netcode behaviour is exercised by the deterministic suite rather than only by two laptops.

## Consequences

**Gains.** One implementation of everything. The inherited 2,519 tests exercise the multiplayer
machinery on every run, which converts them from a legacy asset into live coverage of the new
architecture — the highest-leverage consequence in this document. Offline single-player survives
(G3). Netcode edge cases become ordinary unit tests.

**Costs.** Single-player carries overhead it does not strictly need: command serialization and fog
filtering per tick. This must be measured — if it degrades the single-player experience on a
Gigantic map, the loopback transport gets a documented fast path that skips serialization while
keeping validation. Some inherited tests may need a harness to reach state they previously touched
directly, and that harness must not become a back door around validation.

**Follow-on work.** Define the transport interface and the session object before any network code
exists (Phase 1). Port single-player onto loopback *first*, with the full suite green, and only then
add the WebSocket transport — so the risky work lands on a path already proven by 2,519 tests.

**Revisit if.** Loopback overhead measurably harms single-player performance and a fast path cannot
recover it.
