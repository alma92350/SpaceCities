# SpaceCities — Task Tracking

**The single source of truth for where this port is and what remains.**
Update this file in the same commit as the work it describes.

**Related:** [`docs/PRD.md`](docs/PRD.md) (what and why) · [`docs/adr/`](docs/adr/) (decisions) ·
[`docs/analysis/`](docs/analysis/) (evidence)

---

## Status at a glance

| Phase | Milestone | Tasks | Done | Status |
|---|---|---:|---:|---|
| **0** | Single-player game live on HF, deploying automatically | 11 | 10 | 🟡 In progress |
| **1** | Single-player runs through the multiplayer code path | 7 | 0 | ⚪ Not started |
| **2** | Commands are data; a match replays bit-identically | 12 | 0 | ⚪ Not started |
| **3** | Two humans play a full match over the network | 10 | 0 | ⚪ Not started |
| **4** | Multiplayer is pleasant: lobby, seats, reconnect | 8 | 0 | ⚪ Not started |
| **5** | 4-seat free-for-all with AI fill | 8 | 0 | ⚪ Not started |
| **6** | An agent plays a human to a finish over MCP | 11 | 0 | ⚪ Not started |
| **7** | Hardened, measured, launched | 7 | 0 | ⚪ Not started |
| | | **73** | **10** | |

**Legend:** ✅ done · 🟡 in progress · ⚪ not started · 🔴 blocked · ⏸️ deferred

### What the evidence changed

The plan is not the one drafted before the codebase and platform were investigated. Six findings
moved it, and each is worth knowing before reading the phases:

1. **The engine is nearly N-player already.** Combat, movement, gather, supply and fog are
   owner-generic; victory is already last-side-standing with a *passing three-owner test*. The real
   owner-literal work is in the **client** (~80–110 sites), not the engine.
2. **Five engine defects block multiplayer, and three of them would ship a rigged game.** Seat B
   would silently lose squad formations, lose worker auto-repair, and be the only seat that kites.
   These are now Phase 2 tasks, before any netcode.
3. **A module-global entity-id counter** makes two concurrent matches in one process
   non-replayable — silently. Hence one match per worker (ADR-0011).
4. **Every deploy destroys in-flight matches.** An HF Space rebuilds and restarts on *every git
   push*. Match snapshotting is therefore architectural, not hardening, and moved from Phase 7 to
   Phase 3 (ADR-0012).
5. ~~**The account is not PRO**, and whether a free account can rebuild an existing Docker Space
   is unverified.~~ **Settled by T-007a: it can.** A free account pushed to the Space and it
   rebuilt in 41 s. PRO is not a prerequisite. The probe also found that HF does a **rolling
   swap** — the Space keeps serving the old build while the new one builds — so a deploy costs
   ~21 s of unavailability, not a whole build.
6. **The MCP spec moved.** Revision `2026-07-28` **removed** the `initialize` handshake,
   `Mcp-Session-Id`, the GET SSE endpoint and resumability. A server written from memory or from any
   pre-2026 tutorial would not conform.

---

## Working agreement

This project is **test-driven**, inheriting `CONTRIBUTING.md`'s rules unchanged. For every task:

1. **Write the test first**, from the requirement, and watch it fail for the right reason.
2. Implement the smallest change that passes.
3. Run the **whole** suite plus `npm run typecheck`. An inherited test whose assumption a change
   makes obsolete gets its assertion **updated to the new intended contract — never deleted, never
   skipped**.

**Invariants that must be green at every commit** (each has a guarding test):
- `engine/` stays pure, deterministic and DOM-free (`test/engine-purity.test.js`).
- Same seed ⇒ same game (`test/determinism*.test.js`) — except where an ADR **deliberately**
  re-baselines it, which is announced in the task.
- **Zero runtime dependencies. No build step.** (PRD NFR-5, NFR-6.)
- Every task lists its **exit criteria**; a task is not done until they are demonstrably met.

---

## Phase 0 — Baseline and deployment pipeline
**Milestone M0: the existing single-player game is live on the Space, CI green, deploying on push.**

Deployment is de-risked *before* any multiplayer complexity, so that when the first networked build
ships, the pipeline is already boring.

**Finalized 2026-08-31.** M0 is achieved: [almaatla-spacecities.hf.space](https://almaatla-spacecities.hf.space/)
serves the game, CI has run green repeatedly on this branch, and two consecutive pushes have now
each triggered a fully automated, independently-verified deploy. 10 of 11 tasks are done — the one
exception, **T-008b** (attaching a Storage Bucket), is a deliberate deferral, not an oversight: it
needs `hf` CLI write access or the HF web UI, neither available to this session, and it blocks
nothing in Phase 0 itself — only Phase 3's match-persistence work depends on it.

| ID | Task | Serves | Depends | Status | Exit criteria |
|---|---|---|---|---|---|
| **T-001** | Import upstream verbatim with full history; `upstream` remote configured | ADR-0002 | — | ✅ | 542 commits present; `npm test` green (2,519 tests); `git blame` reaches upstream authorship |
| **T-002** | PRD, ADR log, feasibility spikes | G4 | — | ✅ | `docs/PRD.md`, `docs/adr/0001…0011`, `docs/analysis/00` committed |
| **T-003** | Analysis dossiers: feasibility spikes, engine seams, command protocol, client coupling, HF platform, MCP | G4 | — | ✅ | **All six** dossiers present in `docs/analysis/` (00–05); each is cited by at least one ADR it grounds — verified by direct grep across `docs/adr/*.md`, not assumed |
| **T-004** | Rebrand to SpaceCities — `package.json`, `README.md`, page title, and the in-game/dev-tooling name banners (`setup.js`, `update.js`, `tools/serve.js`) — **without touching engine internals**. `version.js`/`version.json` needed no change (already in sync at 1.1.0) | G5 | T-001 | ✅ | Suite green incl. `test/release-manifest.test.js` (22/22), `test/version.test.js`; full suite **2,519/2,519**; typecheck clean; browser smoke **20/20** (title assertion updated in lockstep in `tools/smoke.js`); `upstream/main..HEAD` diff stays semantically clean — no `engine/` file touched. In-universe lore references to "Stellar Frontier" (the sibling turn-based game) deliberately kept |
| **T-005** | CI on this repo: inherited suite (Node 20 + 22), typecheck, browser smoke | NFR-7 | T-001 | ✅ | Inherited `test.yml` has run **10×, all green** on this branch. Job names confirmed exactly matching `CONTRIBUTING.md`'s required-checks list (`tests (node 20)`, `tests (node 22)`, `browser smoke test`). Branch protection **documented, deliberately not yet applied**: this repo has no `main` yet — its only branch is also its default branch, and turning on force-push blocking now would lock out the direct-push workflow Phase 0 is using. `CONTRIBUTING.md`'s "Protecting the default branch" section updated with the reasoning and exact steps for when a real `main` exists |
| **T-006** | `Dockerfile` for Node 22 on HF: port 7860, `/data` mount point, **no npm install**. Uses the built-in `node` user (UID 1000) rather than HF's Python `useradd` recipe. **Phase 0's `CMD` runs `tools/serve.js`** — the multiplayer server doesn't exist yet; a later phase swaps only the `CMD` line. Also adds `.dockerignore` and the HF README front matter (`sdk: docker`, `app_port: 7860`, …) the Dockerfile's port depends on | G5, NFR-5 | T-004 | ✅ | **Built and run for real** (`dockerd` available this session). Verified: image builds clean; container runs as `uid=1000(node)`; `/data` owned by `node:node` and writable; listens on 7860; `.git`/`test/`/`.github` correctly excluded from the 333MB image; HTTP 200 on `/`, `/engine/state.js` (correct `Content-Type`), `/docs/player-handbook.html` (the in-game field-manual link). **Full page verified live in real Chromium**: title "SpaceCities", splash renders, version banner reads "SpaceCities v1.1.0", zero page/console errors |
| **T-007a** | Push a trivial commit to the Space and watch it rebuild — proving a **non-PRO account can still rebuild an existing Docker Space** | ADR-0010 B2 | — | ✅ | **PASS** ([run 33337999794](https://github.com/alma92350/SpaceCities/actions/runs/33337999794)). `RUNNING_BUILDING → RUNNING_APP_STARTING → RUNNING` in **41 s**; Space HEAD advanced to the pushed commit `894b2c6`; app returned 200 anonymously. **PRO is not a prerequisite.** |
| **T-007** | `.github/workflows/deploy-hf.yml` — **direct authenticated git push** (not `hub-sync`, which calls `hf repo create` and could hit the paywall), gated on `test.yml` passing (`workflow_run`) so a red build never reaches the Space. Force-pushes this repo's **own full history** onto the Space's default branch (discovered via `git ls-remote --symref`, not assumed) — inherits the mechanics T-007a already proved: credential-store auth, `runtime.stage` polling, HEAD-sha equality as the pass condition | FR-21, ADR-0010 | T-006, T-007a ✅ | ✅ | **First real automated deploy succeeded** ([run 33352161332](https://github.com/alma92350/SpaceCities/actions/runs/33352161332), commit `0d2ee80`): all 11 steps green, `git ls-remote --symref` correctly found `main`, force-push landed, rebuild watched through to `RUNNING`, Space HEAD verified equal to the pushed sha, app confirmed 200 anonymously — all from the CI job itself. **Two real failures preceded it** and are part of this task's evidence, not separate from it: `hub-sync`-style creation risk was never hit, but HF's own push-time YAML validator twice rejected the front matter (`short_description` over 60 chars) — a real bug this task found and fixed, not a hypothetical the ADR merely anticipated |
| **T-008** | Make the Space **public**; verify the single-player game plays end-to-end on HF | §6.4, Q1 | T-007 | ✅ | **Public ✅** (Q1 closed — verified unauthenticated). **Live verification, independent of CI's own checks**: `curl` against `https://almaatla-spacecities.hf.space/` — index 200 with `<title>SpaceCities</title>`, `main.js`/`engine/state.js` served with correct `Content-Type: application/javascript`, `/docs/player-handbook.html` (the in-game field-manual link) 200, `version.json` intact, an unknown path correctly 404s rather than falling back to the old app. **Full real-Chromium Playwright verification** (title, splash render, version banner, zero console errors) was already run against this **exact, byte-identical Docker image** in T-006; a second live-browser pass against the public URL itself was attempted but blocked by a proxy tunnel limitation in this session (`ws_closed_mid_exchange` to `almaatla-spacecities.hf.space:443` — infrastructure, not app behavior) — the curl-based checks plus the identical-image Chromium run together cover the same ground |
| **T-008a** | Persistence probe (`tools/dataProbe.js` + `/__data-probe`) built, tested, and **run against two real back-to-back production deploys** | ADR-0010 B3, FR-22 | T-006 | ✅ | **Verdict, measured, not inferred: `/data` is ephemeral without an attached Storage Bucket.** Deploy 1 (`0d2ee80`, 02:55:40 UTC) wrote a marker; deploy 2 (`9bf0f04`, 02:57:38 UTC, ~2 min later) found `previousMarker: null` — no trace survived. Full evidence in `docs/analysis/04-hf-deployment.md` §14. **Consequence for ADR-0012:** its snapshot/restore mechanism needs this bucket to do anything at all — a snapshot written today would vanish on the very restart it exists to survive. See **T-008b** |
| **T-008b** | 🆕 **Attach a Storage Bucket at `/data`** (`hf buckets create SpaceCities-state`, then attach read-write from Space settings — confirmed **free**, not PRO-gated, per `docs/analysis/04-hf-deployment.md` §4). **Outside this session's tool access** — needs the `hf` CLI with a write-scoped token or the HF web UI, neither available here | ADR-0012 | T-008a ✅ | 🔴 | Owner action, or a session with `hf` CLI write access. Once attached: the *very next* redeploy's `/__data-probe` reads `persisted:true` — the probe needs no further work to confirm the fix |

---

## Phase 1 — The session and transport seam
**Milestone M1: single-player runs entirely through the multiplayer code path, suite green.**

The largest architectural move, made *before* any network code exists — so it lands on a path
already proven by 2,519 tests (ADR-0004).

| ID | Task | Serves | Depends | Status | Exit criteria |
|---|---|---|---|---|---|
| **T-009** | Define the transport interface and session protocol shapes (tests first) | ADR-0004 | T-005 | ⚪ | Interface documented with JSDoc typedefs; tests exist and fail for the right reason |
| **T-010** | `server/session.js` — owns one match's state, applies commands, advances the loop | ADR-0003 | T-009 | ⚪ | A session plays a full AI-vs-AI match headlessly to a winner |
| **T-011** | `net/loopback.js` — in-process transport | ADR-0004 | T-009 | ⚪ | Round-trips commands and state synchronously; unit-tested |
| **T-012** | Port the single-player client onto session + loopback | G3 | T-010, T-011 | ⚪ | **Full inherited suite green**; browser smoke green; a human plays a full skirmish with no engine call from the client |
| **T-013** | Fault-injection loopback: latency, reordering, drops. Covers the five client sites that resist loopback — chiefly `input.js:521`, which passes synchronously over loopback and **breaks over a socket**, so a sync-only path would pass every test and fail in production | FR-11 | T-011 | ⚪ | Netcode behaviour under 150 ms RTT and 2% loss covered by deterministic unit tests; no client path depends on a synchronous reply |
| **T-014** | Commit `tools/bench.js`; re-run spikes 1–2 **on Space hardware**; measure memory per match | NFR-2, NFR-4 | T-006 | ⚪ | Measured p99 tick cost and memory per match recorded in `docs/analysis/00` |
| **T-015** | Measure serialization + fog-filtering cost per client per tick, and **settle NFR-3**. Already measured: full state at 800v800 on a 4× map is **404 KB / 4.45 ms**, which at 20 Hz × 4 seats is 32 MB/s and 18 ms of a 50 ms budget; the fog-filtered equivalent is **55 KB / 0.69 ms**. Filtering is what makes replication affordable. But 55 KB/snapshot still **exceeds NFR-3's 32 KB/s** at the pathological end | NFR-3, ADR-0009 | T-010 | ⚪ | Snapshot rate and delta-encoding (ADR-0009 M3) chosen on measured numbers; NFR-3 either met or **deliberately restated** |

---

## Phase 2 — Commands as data
**Milestone M2: every command round-trips as JSON; a match replays bit-identically from its log.**

| ID | Task | Serves | Depends | Status | Exit criteria |
|---|---|---|---|---|---|
| **T-016** | **Fix B1** — move the entity-id counter off the module global, or enforce one match per worker | ADR-0011 | T-010 | ⚪ | Test: two **interleaved** `createGameState` runs each replay identically |
| **T-017** | **Fix the three fairness asymmetries** — formation gate (`commands.js:155`), auto-repair gate (`sim.js:241`), kiting gate (`combat.js:94`) — via an `isHumanControlled` predicate | ADR-0008 | T-010 | ⚪ | Test: both seats get identical formation, auto-repair and kiting behaviour; existing 2-owner world byte-identical |
| **T-018** | **Fix the fog desync landmine** — `gather.js:64`, `scout.js:42` → `state.fogs[unit.owner]`; `sim.js:70-71` iterate `state.owners` | ADR-0008 | T-010 | ⚪ | Test: a 3-owner state updates all three fogs; no engine line reads `state.fog`/`state.fogAI` |
| **T-019** | Fix `issueRecycle`'s missing ownership check, its false comment (`recycle.js:87-89`), and friendly-fire on explicit attack (`combat.js:46`) | FR-10 | T-010 | ⚪ | Adversarial tests: cross-owner recycle and friendly-fire attack both rejected |
| **T-019a** | **Close the two trust-boundary holes.** `hudSelection.js:1045` (`e.homeCC = null`) and `hudSelection.js:1722` (`e.electrified = v`) write simulation fields **directly**, bypassing `engine/` — the only two client lines that do. `:1045` is free: `issueSetHomeBase` (`commands.js:281`) already accepts `null`, so the HUD is bypassing a command that would have done the job. `:1722` is a genuine gap — `electrified` has **two direct writers** (`hudSelection.js:1722`, `aiIndustry.js:172`) and **zero commands** — and today only a client-side `e.owner === "player"` filter stops it electrifying an opponent's Habitat | FR-10, ADR-0006 | T-010 | ⚪ | Grep guard: no client line assigns to a sim field; both actions round-trip as commands |
| **T-019b** | Fix the under-attack alarm defect: `boot.js:684/704/712` fires **your** alarm on any `ev.owner === "ai"` hit | FR-9 | T-010 | ⚪ | Test: an alarm fires only for events owned by the local seat |
| **T-020** | Wire command schema — versioned, id-based, server-stamped owner | ADR-0006 | T-009 | ⚪ | Schema documented; round-trip property test over all command types |
| **T-021** | `net/commandCodec.js` — encode/decode/validate/apply; the **sole** wire→engine path | ADR-0006 | T-020 | ⚪ | Guard test (purity-test idiom) asserts no server module calls `issue*` outside the codec |
| **T-022** | Extend the codec to the **economy** surface — the ~20 cost-bearing mutators `hudSelection.js` calls directly | FR-8, FR-10 | T-021 | ⚪ | Production, research, market, colony actions all validated server-side |
| **T-023** | Deterministic application order `(applyTick, ownerIndex, clientSeq)`, applied immediately before `tick` | ADR-0006 | T-021 | ⚪ | Test: shuffled arrival order yields an identical final-state fingerprint |
| **T-024** | Command-log recording and replay | FR-19 | T-023 | ⚪ | Test: `(seed, log)` replays to an identical `fingerprint(state)` |

---

## Phase 3 — Two humans over the network
**Milestone M3: two browsers play a full 20-minute match to a decided result.**

| ID | Task | Serves | Depends | Status | Exit criteria |
|---|---|---|---|---|---|
| **T-025** | `net/ws.js` — RFC 6455: handshake, framing, **~20–25 s ping** (an idle socket survived 10+ min through the HF edge, but only against a server already pinging every 20 s — so ship the ping rather than trust the timeout), continuation frames, size limits, `Origin` validation on upgrade, close handshake | ADR-0005 | T-009 | ⚪ | Adversarial codec tests: malformed lengths, split frames, oversized payloads, **unmasked client frames rejected** |
| **T-026** | WebSocket transport implementing the Phase 1 interface (client + server) | ADR-0005 | T-025, T-011 | ⚪ | Swapping loopback→WebSocket changes no client code above the transport |
| **T-027** | HTTP server: static assets + WebSocket + reserved `/mcp`, all on port 7860 | ADR-0005 | T-026 | ⚪ | One port serves all three; verified in the Docker image |
| **T-028** | Per-seat fog-filtered state replication | FR-9, ADR-0009 | T-015, T-021 | ⚪ | Test: a client's payload contains **no** entity its seat cannot see |
| **T-029** | Match worker process; parent relays sockets ↔ workers | ADR-0011 | T-016, T-027 | ⚪ | Two concurrent matches in one server replay independently and identically |
| **T-029a** | **Match snapshot to disk + restore on boot** — every deploy restarts the Space and destroys in-memory state, so this is architectural, not hardening. Measured in T-007a: HF does a **rolling swap** (`RUNNING_BUILDING` keeps serving the old build), so the real outage is the app-start window — **~21 s**, not the whole build. Snapshot cadence should be chosen against that, not against a multi-minute worst case | ADR-0012, FR-22 | T-029 | ⚪ | Test: a match snapshotted mid-play, restored and continued yields the same `fingerprint(state)` as one that ran uninterrupted |
| **T-029b** | Rejoin-by-match-id after a server restart, sharing the reconnect mechanism | ADR-0012, FR-5 | T-029a | ⚪ | Deploying mid-match costs seconds, not the match |
| **T-030** | Client `localOwner` seam — **119 owner-literal sites** (68 comparisons, 29 owner arguments, 22 property paths); **110 collapse to one seam**, 9 are the harder "the enemy is `ai`" assertion and must be redesigned or scoped out. ⚠️ **Never `sed` this**: `data.js:124` defines a commodity whose id is literally `"ai"` — the rename must be site-by-site | ADR-0008 | T-012 | ⚪ | Client renders correctly as **either** seat; golden HUD/render tests updated; the 9 hard sites individually resolved |
| **T-031** | Seat identity: display names, per-seat colours beyond the hardcoded two | FR-12 | T-030 | ⚪ | No `"player"`/`"ai"` string reaches the UI |
| **T-032** | Latency handling: local prediction of selection and camera, server-confirmed orders | FR-11 | T-013, T-026 | ⚪ | Playable at 150 ms simulated RTT; measured, not asserted |

---

## Phase 4 — Multiplayer that is pleasant to use
**Milestone M4: lobby, AI fill, disconnect survival, spectating.**

| ID | Task | Serves | Depends | Status | Exit criteria |
|---|---|---|---|---|---|
| **T-033** | Lobby model: create / list / join, seat kinds, seat tokens | FR-1, FR-2 | T-029 | ⚪ | Lobby survives a server restart via `/data` |
| **T-034** | Lobby UI, and a shareable join link | FR-1, FR-2 | T-033 | ⚪ | A stranger joins from a link in under 60 s |
| **T-035** | Match lifecycle: start conditions, **AI fill for open seats**, end and score screen | FR-3, FR-4, FR-6 | T-033 | ⚪ | A solo arrival gets an immediately playable match against AI |
| **T-036** | Disconnect → AI takeover → reclaim with the seat token | FR-5 | T-035 | ⚪ | Close the tab mid-match, rejoin, resume the same seat; the match never stops for others |
| **T-037** | Spectator seats (full-map vision, read-only) — **repurpose Observer Mode** (`observer.js`, `observerPanel.js`), which is already exactly this client | FR-7 | T-028 | ⚪ | A spectator cannot issue any command; host can disable spectators |
| **T-038** | In-match text chat | FR-12 | T-026 | ⚪ | Chat is rate-limited and length-capped |
| **T-039** | Rate limiting and abuse guards on every client-driven path | FR-10 | T-021 | ⚪ | A flooding client is throttled, then disconnected, without affecting the match |
| **T-040** | Desync detection via state fingerprint reporting | FR-20 | T-024 | ⚪ | An artificially divergent client is detected and logged |

---

## Phase 5 — N seats
**Milestone M5: a 4-seat free-for-all plays to a winner.**

Bumps `SAVE_VERSION` to 2 and re-baselines determinism fixtures for N ≥ 3 (ADR-0008) — **planned,
announced, and confined to this phase**.

| ID | Task | Serves | Depends | Status | Exit criteria |
|---|---|---|---|---|---|
| **T-041** | `ownerDefs` built from lobby config; N-seat `state.owners` | FR-1 | T-035 | ⚪ | 4-seat AI-only match plays headlessly to a winner |
| **T-042** | `state.controllers{}` replacing the 2-slot `state.ai`/`state.playerAi` | ADR-0008 | T-041 | ⚪ | N AI seats each act on their own budget; `test/ownerScaffold.test.js` extended |
| **T-043** | `opponentsOf()` replacing `otherOwner()`'s "exactly one enemy" axiom | ADR-0008 | T-042 | ⚪ | AI targets sensibly with 3+ opponents |
| **T-044** | Radial map generator for N ≥ 3 start positions; fairness checked | FR-1 | T-041 | ⚪ | Start positions equidistant and resource-fair; **2-seat path byte-identical** |
| **T-045** | N-fog / N-controller save shape; `SAVE_VERSION` → 2 | FR-19 | T-042 | ⚪ | Round-trip test at N=4; version gate rejects v1 saves cleanly |
| **T-046** | Elimination events, surrender, and last-seat-standing victory at N | FR-6 | T-041 | ⚪ | Eliminated player becomes a spectator; match continues |
| **T-047** | Re-baseline determinism fixtures for N ≥ 3; **2-seat replays preserved** | NFR-8 | T-044 | ⚪ | `test/determinism*.test.js` green; 2-seat fixtures unchanged |
| **T-048** | Sweep the remaining skirmish-critical owner literals (~18 engine sites) | ADR-0008 | T-043 | ⚪ | No skirmish-path engine line compares an owner to a literal |

---

## Phase 6 — Agents play
**Milestone M6: a Claude agent and a human play a full match to a decided result.**

| ID | Task | Serves | Depends | Status | Exit criteria |
|---|---|---|---|---|---|
| **T-049** | MCP transport: Streamable HTTP + JSON-RPC 2.0 core, zero dependencies, targeting revision **`2026-07-28`** — which **removed** `initialize`/`initialized`, `Mcp-Session-Id`, the GET SSE endpoint and `Last-Event-ID` resumability | FR-13, NFR-5 | T-027 | ⚪ | `tools/list`/`tools/call` verified against golden transcripts and a real MCP client. **Re-verify the spec revision before coding** — no pre-2026 tutorial or SDK example shows this shape |
| **T-049a** | Seat handle as an explicit tool argument (the spec's "Stateful Tools" pattern), since protocol-level sessions no longer exist | FR-13 | T-049 | ⚪ | A seat handle minted by `join_match` authorizes every later call |
| **T-050** | Seat auth: per-seat tokens; an agent can act **only** on its own seat | FR-18 | T-049 | ⚪ | Adversarial test: cross-seat command rejected |
| **T-051** | Lobby tools — `list_matches`, `join_match`, `leave_match` | FR-13 | T-049, T-033 | ⚪ | An agent joins a match unaided |
| **T-052** | Observation tools — `get_situation`, `list_entities`, `get_map_overview`, `get_tech_options`, **fog-respecting and summarized** | FR-14 | T-028, T-049 | ⚪ | Digest fits a reasonable context; test proves nothing outside the seat's fog leaks |
| **T-053** | Action tools — batched, group-oriented, mapped onto the Phase 2 codec | FR-15 | T-052, T-022 | ⚪ | An agent commands 20 units in one call; validation identical to a human's |
| **T-054** | `wait_for_event` — **bounded well under the client tool-call timeout**, returning "nothing yet" on expiry rather than erroring | FR-17 | T-052 | ⚪ | A repeated wait loop is cheap, bounded and safe |
| **T-055** | MCP resources — unit stats, counter triangle, build costs, tech tree | FR-16 | T-049 | ⚪ | An agent reads the rules once instead of re-deriving them |
| **T-056** | Agent APM budget, reusing the existing `aiApm` mechanism | §6.3, ADR-0007 | T-053 | ⚪ | Agent actions/minute are capped and the cap is visible to opponents |
| **T-057** | Turn-gated evaluation mode for benchmarking (never in a lobby with a human) | §6.3 | T-056 | ⚪ | A seeded match with a scripted agent replays to a known outcome |
| **T-058** | Reference scripted agent + agent developer guide | P2 | T-055 | ⚪ | A third party connects an agent using the docs alone |

---

## Phase 7 — Harden and launch
**Milestone M7: v1.**

| ID | Task | Serves | Depends | Status | Exit criteria |
|---|---|---|---|---|---|
| **T-059** | Lobby and match-result persistence to `/data` (live match state already covered by T-029a) | FR-22 | T-033, T-008a | ⚪ | A Space restart loses neither the lobby nor recorded results |
| **T-060** | Sleep/wake UX: friendly loading state and WebSocket retry with backoff for the `503` a sleeping Space returns. **No keep-alive pinger** — Spaces have been paused for abuse over exactly that | Risk, ADR-0010 | T-059 | ⚪ | First visitor after 48 h idle sees a loading state, not an error |
| **T-061** | Structured logging and operational metrics | Ops | T-029 | ⚪ | Desyncs, disconnects, match durations, tick overruns all observable |
| **T-062** | Load test: concurrent matches to the measured ceiling | NFR-4 | T-014 | ⚪ | Ceiling documented; graceful degradation verified, not assumed |
| **T-063** | Security review: transport, codec, auth, rate limits | FR-10 | T-039, T-050 | ⚪ | `/security-review` clean; adversarial suite green |
| **T-064** | Player-facing docs and the in-game help overlay updated for multiplayer | P1 | T-035 | ⚪ | A new player understands seats, AI fill and reconnect without asking |
| **T-065** | Launch checklist: PRD §9 success criteria all demonstrated | §9 | all | ⚪ | All six criteria met and evidenced |

---

## Unverified assumptions being carried

The platform dossier flags **13** items it could not verify, rather than guessing at them. The five
that would actually hurt, each owned by a task:

| # | Assumption | Owned by |
|---|---|---|
| ~~U3~~ | ~~Whether `/data` persists with no bucket attached~~ — **RESOLVED by T-008a: it does not.** Measured across two real deploys, ~2 minutes apart: the second found no trace of the first's marker. See `docs/analysis/04-hf-deployment.md` §14 | ✅ T-008a → **T-008b** |
| ~~U7/U11~~ | ~~The git push itself, and whether overwriting a Docker Space escapes the paid-plan rule~~ — **RESOLVED by T-007a.** Push works on a free account; the Space rebuilt in 41 s and served anonymously | ✅ T-007a |
| U5 | Storage-bucket write latency for frequent small writes — it is object storage, not POSIX. Benchmark before choosing a snapshot interval | T-029a |
| U12 | 2-vCPU headroom for N-player 20 Hz. The measured WebSocket result was one client against a trivial app | T-014, T-062 |
| U2 | Cold-start from a real 48 h sleep — still undocumented. (T-007a measured a *rebuild* at 41 s, which is a different path: no VM re-provisioning.) Time a cold visit after 48 h idle | T-060 |

---

## Blocked / needs a decision

| # | Question | Blocks | Owner |
|---|---|---|---|
| **Q1** | Make the Space **public**? **Confirmed hard blocker** — a private Space returns `404` to everyone but the owner and collaborators, for the running app as well as the source. G1 is unreachable while it stays private. | T-008, and all of Phases 3–7 in production | alma92350 |
| **Q2** | ~~Free tier or paid always-on?~~ **Answered by ADR-0010: start free.** 48 h idle tolerance is ample; `$0.03/h` CPU Upgrade removes sleep later if the game gets traction. Open only as a **risk**: whether a non-PRO account can rebuild an existing Docker Space — resolved by T-007a. | T-007a | — |
| **Q3** | Is multiplayer **Odyssey** a wanted v2? Shapes how much generality Phase 5 builds. | T-041 scope | alma92350 |
| **Q4** | Are agent seats visibly labelled to human opponents? (Recommendation: **yes**.) | T-031 | alma92350 |
| **T-008b** | Attach a Storage Bucket at `/data` — confirmed **free**, not gated behind PRO. `hf buckets create SpaceCities-state`, then attach read-write from Space settings. This session has no `hf` CLI or write-scoped HF token to do it directly | ADR-0012, all of Phase 3's match-persistence work | alma92350, or a future session with `hf` CLI write access |

---

## Deferred (explicitly not v1)

| Item | Why | Revisit |
|---|---|---|
| Multiplayer Odyssey / galaxy | Persistent multi-world sandbox; a product of its own | v2 |
| Ranked ladder / Elo | Single-player Elo exists; server-side identity is a separate product | v2 |
| Teams / alliances | `teamOf()` must thread through combat, auras, fog sharing, victory (ADR-0008 Phase 4) | v2 |
| User accounts | Login friction opposes G1 | v2 |
| Replay playback UX | Recording ships in T-024; playback UI does not | v2 |
| Multiplayer scenarios | `engine/scenarios.js` is single-player scripted content | — |
