# ADR-0005: Hand-rolled RFC 6455 WebSocket, zero dependencies

**Status:** Accepted
**Date:** 2026-08-30
**Serves:** PRD NFR-5 (zero dependencies), NFR-6 (no build step), FR-11, G5
**Evidence:** [`docs/analysis/00-feasibility-spikes.md`](../analysis/00-feasibility-spikes.md) §Spike 1

## Context

ADR-0003 makes the server authoritative, so clients need a low-latency, bidirectional, server-push
channel: the server sends state ~10–20 times a second and clients send commands at will.

The obvious mechanism is a WebSocket. The obstacle is that **Node ships no WebSocket server**, while
PRD NFR-5 forbids npm packages in the shipped image — a constraint inherited deliberately from
upstream (ADR-0002), where "the files in the repo are exactly what the browser loads" is described
by `CONTRIBUTING.md` as a load-bearing feature rather than a preference.

So this is a genuine three-way choice: drop the dependency rule, drop WebSockets, or implement the
protocol.

Note that the *browser* side is free either way — `WebSocket` is a native browser API. The entire
question is the server.

## Options considered

### A. Take a dependency (`ws`)
**Pros.** Mature, battle-tested, handles fragmentation, compression, ping/pong and the security
edge cases correctly. Minutes of work.
**Cons.** Breaks NFR-5 outright and, with it, the "clone and run, nothing to install" property
that makes this codebase unusually easy to deploy and audit. Introduces `npm install` into the
Docker build and a supply-chain surface into a game that currently has none. The rule exists because
upstream's simplicity is *why* this port is affordable; spending it on the first hard problem sets
the precedent that spends it on all the others.

### B. Avoid WebSockets: Server-Sent Events downstream + HTTP POST upstream
**Pros.** Both are built into Node and the browser with no framing code at all. SSE reconnects
automatically and passes through restrictive proxies well.
**Cons.** Two half-duplex channels to correlate, with a session id threaded through both. Each
command is an HTTP request with full header overhead — bad for a game that sends bursts of orders.
Browsers historically limit concurrent connections per origin. Higher upstream latency than a frame
on an open socket.

### C. Implement RFC 6455 on `node:http` + `node:crypto`
**Pros.** Keeps NFR-5 intact. The protocol subset a JSON game needs is small and completely
specified. Being our own code, it is testable by the project's own suite rather than trusted.
**Cons.** We own the correctness and the security of a wire protocol: masking, fragmentation,
payload limits, ping/pong, close handshakes. Getting framing wrong produces confusing,
intermittent bugs.

## Decision

**Option C, with option B held in reserve behind the same interface.**

`net/ws.js` implements the RFC 6455 subset the game needs, on `node:http` + `node:crypto` only.
This was **built and verified before the decision was taken**, not assumed: ~90 lines produced a
successful round-trip with a real Chromium browser's native `WebSocket`, with no page errors
(dossier 00, Spike 1). Feasibility here is measured, not estimated.

Production scope beyond the spike, each with tests:
- **ping/pong** keep-alive, to survive idle-timeout proxies;
- **continuation frames** for fragmented messages;
- **decline `permessage-deflate`** — our payloads are small JSON and compression adds a whole
  failure surface for little gain;
- **payload-size and rate limits**, as a denial-of-service guard;
- a correct **close handshake**.

Critically, **both transports sit behind the transport interface ADR-0004 already requires** for
loopback. The interface exists for single-player regardless; making the network transport swappable
is therefore free. If Hugging Face's ingress turns out to proxy WebSockets badly — an open question
this spike could not answer (see dossier 04) — switching to SSE+POST is a new implementation of a
known interface, not a redesign.

## Consequences

**Gains.** NFR-5 survives its first real test. The shipped image stays `FROM node` + `COPY .`, with
no install step and no supply chain. The transport is ours, so its behaviour under latency, loss and
reordering is unit-testable by the inherited suite's own idiom.

**Costs.** We own a wire protocol's correctness and its security surface. Framing bugs are
notoriously subtle, so the frame codec needs adversarial tests — malformed lengths, oversized
payloads, split frames across TCP reads, unmasked client frames (a protocol violation that must be
rejected, not tolerated).

**Follow-on work.** `net/ws.js` plus a codec test suite; the transport interface from ADR-0004; a
decision on HF proxy behaviour before the WebSocket transport is relied on in production.

**Revisit if.** Hugging Face's proxy proves hostile to WebSockets (idle timeouts that cannot be
defeated by ping/pong, or no upgrade support at all) — fall back to option B behind the same
interface. Or if the frame codec accumulates enough security-relevant bugs that a dependency is
plainly the safer engineering choice; in that case ADR-0005 is superseded and NFR-5 is amended
explicitly rather than quietly.
