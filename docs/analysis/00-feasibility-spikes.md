# Dossier 00 — Feasibility spikes

**Author:** architecture phase, 2026-08-30
**Purpose:** settle the two technical unknowns that could have invalidated the whole plan, with
executable evidence rather than argument.

Both spikes were run on the session container: **4 × Intel Xeon @ 2.10 GHz, 16.9 GB RAM, Node
v22.22.2** — deliberately modest hardware, in the same class as a Hugging Face free-tier Space
(2 vCPU). Numbers below should be read as *indicative of*, not measured on, the real target; the
Space-hardware re-run is task **T-013** in [`TASKS.md`](../../TASKS.md).

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
- **T-013:** re-run both spikes on the actual Space hardware.
- Cost of `serializeGame`/fog-filtering per client per tick — likely dominant; measure before
  choosing a replication strategy.
- Memory per match (drives the concurrent-match ceiling as much as CPU does).

---

## Reproducing
Both spikes live in the session scratchpad rather than the repo, because they are throwaway
evidence, not shipped code. The stress harness is worth re-creating as a committed benchmark under
`tools/` once the server exists — task **T-013**.
