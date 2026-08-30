# ADR-0003: Server-authoritative simulation, not peer lockstep

**Status:** Accepted
**Date:** 2026-08-30
**Serves:** PRD G1, G2, FR-9, FR-10, FR-18

## Context

Real-time strategy games have used two network models for thirty years, and the choice between them
determines almost everything else in this port.

**Deterministic lockstep** is the classic RTS answer (Age of Empires, StarCraft). Every peer runs
the identical simulation; only *commands* cross the wire, scheduled a couple of hundred milliseconds
ahead so everyone applies them on the same tick. Bandwidth is tiny and constant regardless of army
size — the reason RTS games shipped over dial-up.

**Server authority** runs one simulation on a server; clients send input and receive state. It costs
far more bandwidth but the server is the sole source of truth.

Upstream is unusually well set up for lockstep. `engine/` is pure, deterministic and DOM-free, with
`same seed ⇒ same game` **enforced in CI** (`test/determinism.test.js`,
`test/determinism-roster.test.js`, `test/engine-purity.test.js`). All randomness flows through one
seeded PRNG (`engine/rng.js`). The hardest precondition for lockstep — a simulation that genuinely
cannot diverge — is already satisfied and test-guarded. Lockstep is *available* here in a way it is
not in most codebases.

Three project-specific facts push against taking it anyway:

1. **Lockstep requires every peer to hold the entire game state**, including the parts fog of war is
   meant to hide. Fog becomes a *rendering* choice, and any modified client sees the whole map. This
   is why lockstep RTS games have always been trivially map-hackable.
2. **Agents are first-class players (G2).** An agent needs a curated, queryable view of the world it
   can legitimately see. Producing that view requires something that holds authoritative state and
   filters it per seat — which is a server, whatever we call it.
3. **Peers here are browsers behind NAT.** Peer-to-peer means WebRTC and its signalling, TURN
   relays and connection-state machinery — a large dependency-bearing subsystem for a project whose
   defining constraint is zero dependencies (PRD NFR-5). Relaying lockstep commands *through* a
   server instead concedes the server anyway, while keeping every disadvantage of trusting clients.

## Options considered

### A. Peer-to-peer deterministic lockstep
**Pros.** Minimal bandwidth; near-zero server CPU; determinism already guaranteed.
**Cons.** Every client holds the full map (map-hack by construction) — fails FR-9/FR-10. WebRTC
brings dependencies — fails NFR-5. One slow peer stalls everyone. A single desync is unrecoverable
and, worse, silent. No natural home for agent seats or spectators.

### B. Server-relayed lockstep (server forwards commands; clients simulate)
**Pros.** Low bandwidth; no WebRTC; server can arbitrate turn scheduling.
**Cons.** Still ships full state to every client, so FR-9 and FR-10 still fail. Still cannot serve
a filtered agent view without simulating anyway — at which point option C is strictly better for the
same server cost.

### C. Server-authoritative simulation, deterministic internally
The server runs the one true `engine/` sim; clients and agents submit commands and receive state.
**Pros.** Fog is enforced, not merely drawn (FR-9). Ownership and affordability are validated
server-side, so a modified client cannot cheat (FR-10). Agents and spectators are just clients with
different views (G2, FR-7). A disconnected seat is trivially handed to `runAI(state, dt, owner)`
(§6.2 of the PRD) because the state never left the server. Reproducibility from `(seed, command
log)` is retained (FR-19).
**Cons.** Bandwidth scales with visible entities, not with commands. Server CPU scales with
concurrent matches — a real constraint on Hugging Face free-tier hardware. Client-side latency
compensation becomes our problem.

## Decision

**Option C: the server is authoritative.** One headless `engine/` simulation per match, on the
server, advanced by the existing fixed-timestep loop. Browsers and MCP agents are both *clients*:
they submit commands and receive a per-seat filtered view.

**We keep determinism anyway.** The server's simulation remains bit-deterministic and command
application remains ordered by a fixed rule, even though authority no longer strictly requires it.
This is deliberate: determinism is what makes `(seed, command log)` a complete replay (FR-19), what
makes agent evaluation reproducible (P2), what lets a client's state fingerprint detect divergence
(FR-20) — and, not least, it is what the inherited determinism guards test. Abandoning it would turn
2,519 green tests into a weaker suite for no gain.

Server authority is therefore layered *on top of* the deterministic core rather than replacing it.

## Consequences

**Gains.** Cheating by client modification is designed out rather than policed. Fog is a real
information boundary, which is the precondition for agents playing fairly (G2). Disconnects become
AI handovers instead of ruined matches. Spectating, replay recording and desync detection all fall
out of one server holding truth.

**Costs.** Bandwidth is now proportional to what each client can see, making per-seat filtering a
correctness *and* a performance requirement (see ADR-0009). Server CPU becomes the scaling limit
(PRD NFR-2, NFR-4) on constrained hardware. Client-side responsiveness under latency needs
deliberate work (FR-11), which lockstep would have given free.

**Follow-on work.** ADR-0004 (loopback transport, so single-player uses this path too),
ADR-0006 (serializable command protocol), ADR-0009 (fog-filtered replication), and a load
measurement against NFR-2/NFR-4 early enough to change course.

**Revisit if.** Free-tier CPU cannot sustain the concurrent-match target (NFR-4) even after
optimization, *and* the product accepts a trusted-client threat model. In that case server-relayed
lockstep (option B) becomes the fallback — note it would forfeit FR-9 and FR-10 explicitly.
