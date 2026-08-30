# SpaceCities — Product Requirements Document

**Status:** Draft v0.2 — pending review
**Owner:** alma92350
**Last updated:** 2026-08-30
**Related:** [`docs/adr/`](adr/) (architecture decisions) · [`TASKS.md`](../TASKS.md) (delivery tracking)

---

## 1. Summary

SpaceCities turns [Stellar Frontier: RTS](https://github.com/alma92350/SpaceExploration-RTS) — a
mature, single-player, browser-based real-time strategy game — into a **multiplayer** RTS hosted at
[huggingface.co/spaces/Almaatla/SpaceCities](https://huggingface.co/spaces/Almaatla/SpaceCities),
in which **humans and LLM agents play against each other in the same match**.

Two products ship from one codebase:

1. **The game.** A no-install, no-login browser RTS. Open a URL, join a match, play.
2. **The agent interface.** An **MCP server** that exposes a seat in a live match as a set of
   tools, so any MCP-capable agent can scout, expand, tech and attack under the same rules and the
   same fog of war a human plays under.

The second is the differentiator. There is no shortage of browser RTS games and no shortage of LLM
benchmarks; there are very few environments where an agent and a human contest the *same* real-time
game state through a documented, symmetric protocol.

## 2. Why this port is tractable

The decision to port rather than rewrite rests on measured properties of the upstream codebase, not
on optimism. Verified on upstream `50ceb88`:

| Property | Measured | Why it matters here |
|---|---|---|
| Test suite | **2,519 tests / 115 files, all green in ~5.5 min** | The safety net for a 90k-LOC transformation. Every step of this port is refactoring-under-test, not new construction. |
| Dependencies | **Zero.** No npm packages, no build step | Deploys as a plain Node image; nothing to audit, pin, or break. |
| `engine/` purity | Pure, deterministic, DOM-free — **enforced by `test/engine-purity.test.js`** | The simulation already runs headless. A server can execute it unmodified. |
| Determinism | `same seed ⇒ same game`, enforced by `test/determinism*.test.js` | Replays, spectating, desync detection and reproducible agent evaluation all fall out of a property the repo already guards. |
| Headless matches | `tools/selfplay.js` already plays full matches under `node` | Server-side simulation is *proven*, not speculative. |
| Owner model | `state.owners` is already the canonical side list; fog, seeding, persistence and victory iterate it (`engine/state.js:168`) | The N-player scaffold exists. It is currently *populated* with exactly two seats, not *hardcoded* to two throughout. |
| Multi-seat AI | `runAI(state, dt, owner)` already drives either seat (`engine/ai.js`) | AI-filled seats and agent seats reuse an existing, tested mechanism. |

The upstream author wrote the engine as if a network port was coming. This document plans to
collect on that.

## 3. Goals

**G1 — Play a real multiplayer RTS in a browser with no install and no account.**
2–4 seats, free-for-all, on the existing charted worlds, with the existing units, tech, fog and
victory rules.

**G2 — Let an LLM agent occupy any seat, on equal terms.**
Same fog of war, same command surface, same clock. An agent must not be able to see or do anything
a human in that seat could not.

**G3 — Preserve the single-player game, intact.**
The skirmish and Odyssey modes keep working, offline, with no server. This is both a product
requirement (the single-player game is good) and an engineering one (it keeps 2,519 tests
meaningful throughout the port).

**G4 — Keep the engineering discipline that made the port possible.**
Zero runtime dependencies, no build step, determinism guards, TDD. A port that trades these away
for convenience destroys the property that made the codebase portable in the first place.

**G5 — Deploy continuously to Hugging Face.**
Push to `main` → the Space runs the new build. Deployment is a solved, automated, boring step from
the first week, not a scramble at the end.

## 4. Non-goals (v1)

Explicitly out of scope, with reasons — each is a candidate for a later version, not an oversight.

| Not doing | Why |
|---|---|
| **Multiplayer Odyssey / galaxy mode** | The open-world meta-layer is a persistent, multi-world, background-simulated sandbox (`engine/galaxy.js`, ~88 KB). Multiplayer *skirmish* is the coherent v1. Odyssey stays single-player. |
| **Ranked ladder / Elo matchmaking** | An Elo system already exists single-player (`competitionLedger.js`, `elo.js`). Wiring it to a server-side identity system is a whole product of its own; v1 has unranked lobbies. |
| **User accounts, profiles, persistence of player identity** | Login friction directly opposes G1. v1 uses ephemeral per-session seat tokens. |
| **Mobile-first multiplayer UX** | The client supports touch, but competitive RTS on a phone is not a problem this port will solve. |
| **Anti-cheat beyond server authority + fog filtering** | Server authority plus per-seat fog filtering removes the whole map-hack and resource-cheat class. Behavioural cheat detection is out of scope. |
| **Voice, replays-as-a-feature, tournaments, teams >2** | Deferred. Note that *replay capability* falls out of the architecture (§7.4) even though replay UX does not ship in v1. |

## 5. Users

**P1 — The drop-in player.** Arrives from a link. Wants to be in a match in under 60 seconds
against *someone*, and does not want to read anything first. Will leave if the lobby is empty and
nothing happens.
→ Implication: **empty seats must fill with AI immediately**, and matches must be joinable in
progress or start fast. A lobby that requires two humans to coincide is a dead lobby.

**P2 — The agent developer.** Has an MCP-capable agent and wants to see how it does. Needs a
documented tool surface, a stable observation format, and a way to run a match reproducibly.
→ Implication: the MCP surface is a **product**, with reference docs, a static rules resource, and
deterministic seeded matches for evaluation.

**P3 — The maintainer.** Wants to merge upstream engine fixes for years, and wants CI to tell the
truth.
→ Implication: **upstream history is preserved** and `upstream` is a live git remote (already set
up), so upstream fixes remain cherry-pickable. The port must not fork the engine's shape gratuitously.

**P4 — The spectator.** Wants to watch a human play an agent. This is the shareable artefact of the
whole project.
→ Implication: spectating is a first-class read-only seat, not an afterthought.

## 6. Product decisions that shape the architecture

### 6.1 Match length
Upstream offers Quick (20 min) / Standard (40 min) / Marathon (60 min), defaulting to 40
(`engine/victory.js:19`). Forty minutes is a long commitment for a stranger on the internet, and
every minute of match length multiplies the cost of a mid-match disconnect.

**Decision:** public multiplayer defaults to **Quick (20 min)**; the lobby host may raise it.
Marathon is available but flagged in the UI as unsuitable for public lobbies.

### 6.2 Seats, and what fills them
A match has N seats (v1: 2–4). Every seat is one of:

- **Human** — a browser client.
- **Agent** — an MCP client holding a seat token.
- **AI** — the existing scripted opponent (`engine/ai.js`), with its archetype and difficulty.
- **Open** — awaiting a joiner; **converts to AI** if unfilled at match start, and **reverts to AI
  control** if its occupant disconnects beyond a grace period.

The last point is the single most important product decision in this document. Because the engine
can already drive any seat with `runAI(state, dt, owner)`, **a disconnect never ends a match** — the
AI takes over, the match continues for everyone else, and the player can reclaim the seat on
reconnect. This turns the defining fragility of casual online RTS into a solved case, cheaply,
using a mechanism that already exists and is already tested.

### 6.3 Agents play under an action budget, not in a paused world
An LLM takes seconds per decision; the sim runs at 20 Hz. Rather than pause the world for a
thinking agent (which ruins the game for humans in the match), agent seats spend from the **same
actions-per-minute budget the scripted AI already uses** (`aiApm`, 1–150 APM — `engine/state.js`
`createAiController`). An agent is simply a slow, smart player, and its APM cap is a published,
symmetric handicap rather than a hidden advantage.

A separate **turn-gated evaluation mode** (the server advances only when every agent has acted)
exists for benchmarking, where reproducibility matters more than watchability. It is never used in
a lobby containing a human.

*(This is the recommendation to be confirmed by the MCP design dossier; see
[ADR-0007](adr/0007-agent-pacing.md).)*

### 6.4 The Space must be public
The target Space is currently **private**. A private Space cannot serve anonymous players, which
defeats G1.
**Decision:** the Space is made **public** at first deploy. Requires owner action.

## 7. Functional requirements

Requirements are `FR-n`, and every delivery task in [`TASKS.md`](../TASKS.md) traces to at least one.

### 7.1 Lobby and match lifecycle
- **FR-1** A player may create a match, choosing world, size, resources, match length, seat count
  and each seat's kind (open / AI / agent-reserved).
- **FR-2** A player may list open matches and join one by id, or via a shareable link.
- **FR-3** Unfilled open seats become AI seats at match start. A match with one human and three AI
  seats is a valid, immediately-playable match.
- **FR-4** A match starts when the host starts it, or automatically when all seats are filled.
- **FR-5** Disconnected seats fall to AI control after a grace period and may be reclaimed by
  reconnecting with the seat token, for the life of the match.
- **FR-6** A match ends by the existing victory rules (last Command Center standing, or score at the
  time limit — `engine/victory.js`), generalized to N seats as last-seat-standing.
- **FR-7** Any client may join a running match as a **spectator** with full-map vision, unless the
  host has disabled spectators.

### 7.2 In-match play
- **FR-8** Every action a single-player player can take, a multiplayer player can take: the full
  `engine/commands.js` surface (move, attack, attack-move, gather, build, assist, repair, patrol,
  scout, escort, hold, stop, recycle, rally, formations, logistics).
- **FR-9** A client sees only what its seat's fog reveals. The server never sends a client
  information that seat has not earned.
- **FR-10** The server is authoritative: it validates seat ownership and affordability of every
  command and rejects anything else. A modified client cannot cheat.
- **FR-11** The client remains responsive under latency (target: playable at 150 ms RTT) via local
  prediction of selection and camera, and server-confirmed unit orders.
- **FR-12** Basic in-match text chat, and an all-seats end-of-match score screen.

### 7.3 Agent interface (MCP)
- **FR-13** An MCP server exposes lobby tools (`list_matches`, `join_match`, `leave_match`) and
  in-match tools for observation and action.
- **FR-14** Observations are **summarized and queryable**, not raw state dumps: an economy/army/
  threat digest, filtered entity queries, and a coarse map overview — all fog-respecting.
- **FR-15** Actions are **batchable** and group-oriented (command a set of units in one call), so an
  agent is not forced to spend its APM budget one unit at a time.
- **FR-16** Static game reference (unit stats, counter triangle, build costs, tech tree) is exposed
  as MCP **resources**, readable once rather than re-sent every turn.
- **FR-17** An agent may block on `wait_for_event` to react to being attacked rather than polling.
- **FR-18** An agent seat is authenticated by a seat token and can only act on its own seat.

### 7.4 Reproducibility and operations
- **FR-19** A match is fully reproducible from `(seed, ordered command log)`. The server records
  both. *(Replay playback UX is out of v1 scope; the recording is not.)*
- **FR-20** The server detects and logs simulation divergence between its own state and any client
  that reports a state fingerprint (`tools/selfplay.js` already exports `fingerprint(state)`).
- **FR-21** Deployment to the Space is automatic on push to `main`.
- **FR-22** The server survives Space restarts without corrupting in-flight data: match state is
  in-memory and lost on restart by design, but the lobby and any recorded results persist to `/data`.

## 8. Non-functional requirements

| # | Requirement | Target |
|---|---|---|
| NFR-1 | Simulation rate | 20 Hz fixed timestep, unchanged from upstream (`engine/loop.js`) |
| NFR-2 | Server tick budget | < 25 ms per tick for a 4-seat Gigantic-map late game on HF free-tier CPU |
| NFR-3 | Bandwidth per client | < 32 KB/s steady-state at 4 seats |
| NFR-4 | Concurrent matches | ≥ 4 on free-tier hardware, degrading gracefully |
| NFR-5 | Runtime dependencies | **Zero.** No npm packages in the shipped image |
| NFR-6 | Build step | **None.** The browser loads the repo as-is |
| NFR-7 | Test suite | Stays green throughout; total runtime < 10 min |
| NFR-8 | Determinism | `test/determinism*.test.js` stay green at every commit |
| NFR-9 | Cold start | Space serves the lobby < 30 s after wake |

NFR-5 has a sharp consequence: **Node ships no WebSocket server**, so the port implements the
RFC 6455 handshake and frame codec by hand (~300 LOC, fully testable) rather than taking a
dependency. See [ADR-0005](adr/0005-transport.md).

## 9. Success criteria

**Must be true to call v1 done:**
1. Two humans in different browsers play a full 20-minute match to a decided result, with no desync
   and no server error.
2. One human and one Claude agent (via MCP) play a full match to a decided result.
3. A player closes their tab mid-match, the AI takes over, they rejoin and resume their seat.
4. `npm test` is green — the inherited 2,519 tests plus the new multiplayer suite.
5. A push to `main` deploys to the Space with no manual step.
6. Determinism guards are still green, and a recorded `(seed, command log)` replays to an identical
   final-state fingerprint.

**Health indicators after launch:** matches completed vs. abandoned; median time-to-first-match;
agent-seat match completion rate; desync events per 100 matches (target: 0).

## 10. Key risks

| Risk | Impact | Mitigation |
|---|---|---|
| **Every deploy destroys in-flight matches** — a Space rebuilds and restarts on *every git push* | High | **Confirmed.** Matches snapshot to disk and restore on boot ([ADR-0012](adr/0012-crash-tolerant-matches.md)), sharing the reconnect mechanism. Raised from a Phase 7 nicety to a Phase 3 architectural requirement. |
| **The Space is private, so nobody can play** | High | **Confirmed blocker** — a private Space returns `404` for the running app, not just the source. Needs owner action (Q1). |
| **A non-PRO account may not be able to rebuild an existing Docker Space** | High | **Unverified, and cheap to test.** T-007a pushes a trivial commit and watches it build, before any porting effort is spent. Escalation: PRO at $9/month. |
| ~~WebSockets constrained on Spaces~~ | ~~High~~ | **Resolved.** Upgrades verified to traverse the HF edge proxy, and the owner's own live Space already serves a WebSocket plus `/mcp` on one port. A ~90-line zero-dependency server round-tripped against real Chromium ([ADR-0005](adr/0005-transport.md)). |
| **HF free hardware sleeps after 48 h idle** | Low | Tolerable for a game people play; snapshot/restore covers it. **No keep-alive pinger** — Spaces have been paused for abuse over exactly that. |
| **Server-authority refactor breaks determinism** | High | Determinism guards run in CI on every commit; the loopback transport (Phase 1) forces single-player through the identical code path, so the existing suite tests the multiplayer path too. |
| **N-player generalization is broader than the `state.owners` scaffold suggests** | Medium | ~53 hardcoded owner comparisons are known to exist. Audited before work starts (engine dossier); 2-seat multiplayer ships first and needs almost none of it. |
| ~~Free-tier CPU cannot run 4 concurrent 20 Hz sims~~ | ~~Medium~~ | **Resolved.** Measured: p99 4.6–9.1 ms/tick for realistic 200–400-unit matches against a 50 ms budget, and 22 ms even at 800 units in contact. Free tier is 2 vCPU / 16 GB. The real cost is serialization and fog filtering, not simulation — measured next (T-015). |
| **Empty lobbies make the game feel dead** | Medium | AI fills every open seat (FR-3): a solo arrival always gets a match. |
| **Port drifts from upstream, losing future fixes** | Low | Upstream history preserved; `upstream` remote configured; engine changes kept minimal and upstreamable. |

## 11. Open questions

- **Q1 — still open, and blocking.** Should the Space be made public (§6.4)? Now confirmed to be a
  hard blocker rather than a preference: a private Space returns `404` for the running application,
  so no anonymous player can reach the game at all. Requires an explicit owner decision, since it
  makes the game world-readable. *(Blocks G1 and all of Phases 3–7 in production.)*
- **Q2 — answered.** Start on **free CPU Basic** ([ADR-0010](adr/0010-hf-deployment.md)). 48 hours of
  idle tolerance is ample, and `$0.03/hour` CPU Upgrade removes sleep later if the game gets
  traction. What remains is a *risk*, not a question: whether a non-PRO account can rebuild an
  existing Docker Space — resolved empirically by T-007a.
- **Q3 — still open.** Is multiplayer **Odyssey** a wanted v2, or is skirmish the whole product?
  Shapes how much generality Phase 5 builds for.
- **Q4 — still open.** Should agent seats be visibly labelled to human opponents?
  Recommendation: **yes, labelled**, and their APM cap published alongside
  ([ADR-0007](adr/0007-agent-pacing.md)).
- **Q5 — still open.** Does the single-player Elo/competition system get a multiplayer counterpart
  in v2?

## 12. Evidence base

Every claim in this document that could have been guessed was instead measured or verified. The
supporting dossiers live in [`docs/analysis/`](analysis/):

| Dossier | What it settles |
|---|---|
| [00 — Feasibility spikes](analysis/00-feasibility-spikes.md) | A ~90-line zero-dependency WebSocket server round-tripping against real Chromium; per-tick simulation cost under load; the platform precedent from the owner's own live Space |
| [01 — Engine N-player seams](analysis/01-engine-nplayer-seams.md) | Every owner literal in the engine, classified; the six real chokepoints; why two seats first is the cheap path |
| [02 — Command & wire protocol](analysis/02-command-wire-protocol.md) | The full command signature audit, the anti-cheat surface, the wire schema, and five engine defects that block multiplayer |
| [03 — Client coupling](analysis/03-client-coupling.md) | What the client must change, what is reusable verbatim, and why fog-filtered projection needs no renderer changes |
| [04 — HF Spaces](analysis/04-hf-deployment.md) | Platform limits, lifecycle, storage, secrets, and a ready-to-use Dockerfile and deploy workflow |
| [05 — MCP agent play](analysis/05-mcp-agent-play.md) | The current protocol revision verified against live docs, the tool surface, and the pacing analysis |

---

*Requirements in this document are traced to delivery tasks in [`TASKS.md`](../TASKS.md) and to the
decisions that implement them in [`docs/adr/`](adr/).*
