# Dossier 00 — Feasibility spikes

**Author:** architecture phase, 2026-08-30
**Purpose:** settle the two technical unknowns that could have invalidated the whole plan, with
executable evidence rather than argument.

Both spikes were run on the session container: **4 × Intel Xeon @ 2.10 GHz, 16.9 GB RAM, Node
v22.22.2** — deliberately modest hardware, in the same class as a Hugging Face free-tier Space
(2 vCPU). Numbers below should be read as *indicative of*, not measured on, the real target; the
Space-hardware re-run is task **T-014** in [`TASKS.md`](../../TASKS.md).

---

## Spike 1 — A WebSocket server with zero dependencies

### The question
PRD **NFR-5** forbids npm packages in the shipped image. **Node ships no WebSocket server.** If a
zero-dependency WebSocket is impractical, either the dependency rule or the transport choice has to
give — and both are load-bearing (ADR-0002, ADR-0003).

### What was built
A complete server implementing the RFC 6455 pieces that matter, on `node:http` + `node:crypto`
alone:

- **Handshake** — `Sec-WebSocket-Accept` = base64(SHA-1(key + `258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)),
  answered on the HTTP server's `upgrade` event.
- **Server→client framing** — FIN + text opcode, with the three payload-length encodings
  (7-bit, 16-bit, 64-bit).
- **Client→server decoding** — a *streaming* decoder that buffers partial frames and applies the
  4-byte XOR mask that clients are required to use (RFC 6455 §5.3), plus close-frame handling.

**~90 lines.**

### Result

Driven by **real Chromium** (Playwright) using the browser's own native `WebSocket`, not a
hand-written client that might share the server's misconceptions:

```
BROWSER RECEIVED: {"type":"ack","forTick":42,"seat":"p2"}
PAGE ERRORS: none
PASS: zero-dep WebSocket round-trip works in real Chromium
```

### Verdict

**Settled: a zero-dependency WebSocket transport is practical.** NFR-5 and ADR-0003 are compatible;
no dependency is needed and no fallback transport is required *on this axis*.

Caveats carried forward, none of them blocking:

- The spike handles text frames and close. Production needs **ping/pong** (keep-alive through
  proxies), **continuation frames** for fragmented messages, `permessage-deflate` negotiation
  (decline it — simpler, and our payloads are small JSON), and payload-size limits as a
  denial-of-service guard.
- Whether Hugging Face's ingress proxies WebSockets cleanly, and with what idle timeout, is a
  *platform* question this spike cannot answer — see dossier 04 and PRD risk table.

---

## Spike 2 — Can one server carry several 20 Hz matches?

### The question
PRD **NFR-2** budgets < 25 ms per tick; **NFR-4** wants ≥ 4 concurrent matches on free-tier
hardware. ADR-0003 puts the simulation on the server, so if the sim is expensive the architecture is
wrong.

At 20 Hz the wall-clock budget is **50 ms per tick**. A match consuming *x* ms per tick occupies
`x / 50` of one core.

### Method
`tools/selfplay.js` drives full AI-vs-AI matches headlessly. Two measurements:

1. **Natural matches** — let the AI play out real games and measure.
2. **Stress** — seed large armies directly (`makeUnit`) on a Gigantic (4×) map and send them at each
   other with `issueAttackMove`, so combat, pathing, target acquisition and separation are all hot
   simultaneously. This is the honest worst case; a natural match only fields 20–40 units and would
   flatter the result badly.

### Results

**Natural matches** (whole games, warmed up, per-tick timings):

| Scenario | mean | p50 | p99 | max | units | faster than real time |
|---|---|---|---|---|---|---|
| Ferros, 10 sim-min | 0.19 ms | 0.15 | 0.84 | 4.10 | 37 | **517×** |
| Ferros, 40 sim-min (to victory) | 0.05 ms | 0.00 | 0.39 | 1.52 | 23 | **2185×** |
| Gigantic 4×, 40 sim-min | 0.21 ms | 0.16 | 0.77 | 20.32 | 41 | **488×** |

**Stress — large armies in contact on a Gigantic map** (1,200 ticks each):

| Army size | mean | p50 | **p99** | max | Concurrent matches per core (at p99) |
|---|---|---|---|---|---|
| 200 units | 1.63 ms | 1.98 | **4.61 ms** | 10.80 | **~10** |
| 400 units | 4.47 ms | 6.76 | **9.09 ms** | 10.61 | **~5** |
| 800 units | 10.04 ms | 7.76 | **22.03 ms** | 28.76 | **~2** |

### Verdict

**Settled: server-side simulation is affordable.**

- NFR-2 (< 25 ms/tick) **holds even at 800 units in contact** — p99 22 ms, which is the pathological
  case, not the normal one. A 4-seat match near the default supply cap sits in the 200–400 unit
  band: **p99 under 10 ms, comfortably inside a fifth of the budget.**
- NFR-4 (≥ 4 concurrent matches) is met **per core** for realistic matches. Node is single-threaded,
  so a 2-vCPU Space can host roughly double this using `worker_threads` — one worker per match, which
  also isolates a match that throws.
- The simulation runs **~500× faster than real time**, which makes a strong secondary point: the
  server spends almost all its wall-clock waiting. **Serialization and per-seat fog filtering, not
  the simulation, will be the real server cost** — so that is where optimization effort belongs
  (see ADR-0009), and where the next measurement should go.

### Follow-on measurements needed
- **T-014:** re-run both spikes on the actual Space hardware. *(Re-run on the session container that
  ran this dossier's own numbers — see T-014's TASKS.md entry for why the real Space couldn't be
  reached this round. Also added: memory per match, below.)*
- Cost of `serializeGame`/fog-filtering per client per tick — likely dominant; measure before
  choosing a replication strategy. *(Settled — see Spike 3.)*
- Memory per match (drives the concurrent-match ceiling as much as CPU does). *(Settled by T-014:
  **0.311 MB/match**, 20 matches sampled — memory is not the ceiling at any concurrency this
  project will plausibly reach; CPU and, per Spike 3, bandwidth are.)*

---

## Spike 3 — Cost of ADR-0009's `projectFor` per client per tick (T-015)

### The question
ADR-0009 decided the server sends each seat a **fog-filtered projection**, not the whole state
(§Decision). Spike 2 found the simulation running ~500× faster than real time — nearly all server
wall-clock is idle — which made serialization the *real* suspected cost, not simulation. PRD
**NFR-3** budgets **< 32 KB/s per client, steady-state at 4 seats**, and was explicitly left
**provisional**, naming this task as the one to settle it: "T-015 either meets it via snapshot rate
and delta-encoding or restates it deliberately."

### Method
`tools/bench.js`'s `benchProjection` (same harness as Spike 2's STRESS scenario — two armies of
`armySize` in contact on a Gigantic map, so fog filtering and the event stream are both genuinely
hot) calls `projectFor(state, seat)` for **both seats**, every tick, `JSON.stringify`s the result
(what an actual send would cost), and records wall-clock time and payload size for each call.
`state.events` is drained after every tick, warmup included — `boot.js:807` does the same after
every real render frame; without it a bench run's "this tick's events" grows to hold the *entire
match's* combat log, which a first pass of this measurement did in fact do (see the corrections
below).

**Two corrections this measurement needed before its numbers meant anything**, left in because
they're part of the evidence, not just process footnotes:
1. **The first pass didn't drain events.** `state.events` accumulated for the whole bench run
   instead of holding one tick's worth, inflating `events`' share of the payload from a real **1.8%
   to an artificial 18.1%** — a >10× overstatement of a cost that turned out to be nearly noise.
2. **The corrected fog-filtered payload (156 KB mean / 411 KB max at 800-a-side) doesn't match the
   55 KB fog-filtered figure NFR-3's table already carried** (itself measured against the same
   800v800 scale, and close to this run's own **404 KB** unfiltered figure — so the *unfiltered*
   side of that older measurement checks out; only the *fog-filtered* one looks low). The most
   likely explanation: an estimate for "fog-filtered" arrived at differently than an actual
   `JSON.stringify(projectFor(...))` call — e.g. not fully accounting for this codebase's verbose,
   readable field names repeated in full for every one of ~800-1000 entities in view (measured
   **~217 bytes/unit** on the wire). This dossier records what the *code* now measures; reconciling
   it against how the older figure was produced is not something this pass could do without that
   figure's own method.

### Results

**Cost per client per tick**, two seats, 300 ticks after a 50-tick warmup (session-container
hardware — see this dossier's header caveat):

| Army size (per side) | mean/seat | p99/seat | mean both seats/tick | p99 both seats/tick |
|---|---|---|---|---|
| 200 | 2.11 ms | 4.30 ms | 4.22 ms | 9.25 ms |
| 400 | 2.32 ms | 5.21 ms | 4.63 ms | 9.41 ms |
| 800 | 2.68 ms | 6.40 ms | 5.35 ms | 11.94 ms |

CPU cost is real but modest — at 800-a-side, both seats' projection together (p99 ~12 ms) is
comparable to Spike 2's own simulation cost at the same size (p99 ~22 ms per the table above),
confirming the "not free" half of Spike 2's prediction, but nowhere near blowing NFR-2's 25 ms
budget on its own.

**Payload size**, same runs:

| Army size (per side) | mean/snapshot | max/snapshot |
|---|---|---|
| 200 | 87 KB | 143 KB |
| 400 | 107 KB | 223 KB |
| 800 | 156 KB | 411 KB |

**Composition at 800-a-side, one tick, near-peak army** (981 of 1,600 units in view — the rest
outside either seat's fog): **units 75.2%**, **fog grid 22.6%**, events 1.8%, everything else
(buildings, nodes, players) under 1% combined. Units dominate because most of an in-contact army is
mutually visible; the fog grid is the clear second lever, exactly the one ADR-0009's own migration
path already names (**M2 — stop shipping fog; client recomputes**).

### Verdict

**NFR-3 is not met by "a full `projectFor` snapshot every simulation tick," and no realistic army
size fixes that on its own — the snapshot RATE is what breaks the budget, not the entity count.**
NFR-1 fixes the tick rate at 20 Hz. At 20 Hz, even the *smallest* measured scenario (200-a-side, 87
KB mean) costs **~1.7 MB/s** — roughly **50× over** the 32 KB/s target — before accounting for
however many seats are actually in the match. Bandwidth, not CPU, is the real ceiling Spike 2's
"simulation is nearly free" finding pointed toward, and it isn't a close call.

This settles NFR-3's own open question: **"restate it deliberately" is off the table as a fix by
itself** (no reasonable restatement absorbs a 50×+ gap), which leaves **"via snapshot rate and
delta-encoding."** Concretely, that means ADR-0009's **M3 (delta-encode against the last
acknowledged snapshot)** is not the optional, "until armies grow" step its own Consequences section
framed it as — this measurement is exactly the evidence its **Revisit if** clause named
("projection cost per client per tick turns out to dominate... ahead of schedule"), except it's
bandwidth rather than CPU that dominates, and it's already true at 200 units, not just at 4 seats.
Full snapshots remain the right tool for an infrequent baseline (a new seat joining, a reconnect);
every ordinary tick needs to ship *what changed*, not the whole roster. Deciding and building that
is follow-on work this measurement motivates but doesn't itself do.

---

## Reproducing
Spikes 1 and 2 live in the session scratchpad rather than the repo, because they were throwaway
evidence, not shipped code, before being committed as a re-runnable benchmark — task **T-014**.
Spike 3 (T-015) was written directly as that committed benchmark: `tools/bench.js`'s
`benchProjection`, covered by `test/bench.test.js`, callable via `runBenchSuite()` alongside the
other two.
