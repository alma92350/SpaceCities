# ADR-0007: Agents play in real time under an APM ceiling, with a gated mode for evaluation

**Status:** Accepted
**Date:** 2026-08-30
**Serves:** PRD G2, FR-13, FR-15, FR-17, §6.3
**Evidence:** [`docs/analysis/05-mcp-agent-play.md`](../analysis/05-mcp-agent-play.md) §2

## Context

An LLM agent takes seconds per decision. The simulation runs at 20 Hz. Something has to give, and
what gives determines whether agent-vs-human matches are watchable, fair, or even possible.

The game already has a relevant mechanism. Its scripted AI runs under an **actions-per-minute
ceiling** (`aiApm`: 20 / 65 / 140 by difficulty in `engine/aiDifficulty.js`, documented as a 1–150
range in `README.md:50`), with a burst allowance and a `(apm/60)*dt` accrual in
`engine/aiCommon.js:21,72-73`. Every command the AI issues spends from that budget.

The tempting conclusion is that an APM budget *is* the answer for agents too. The dossier makes a
sharp counter-argument that changes the decision:

> **An APM budget is a ceiling, not a floor.** It stops a harness spamming 10,000 commands/sec, but
> it does nothing whatever for an agent managing three actions a minute. It is *orthogonal* to the
> pacing problem rather than a solution to it.

The second decisive constraint is testability. **A real-time agent match depends on model latency,
so it cannot be a regression test** — the outcome varies with how fast the model responded that
afternoon. Under this project's strict TDD rules (PRD G4), that is disqualifying for the *evaluation*
path, though not for the *play* path.

## Options considered

### A. Pure real time — agents act whenever, and are simply slow
**Pros.** Simplest; identical rules for everyone; humans are unaffected.
**Cons.** An agent may be so slow it is not meaningfully playing. Match outcomes are not
reproducible, so nothing here can be a regression test.

### B. APM budget alone
**Pros.** Reuses a tested engine mechanism; caps abuse.
**Cons.** Per above, it constrains the wrong end. It answers "how fast may an agent act", when the
problem is "an agent is too slow".

### C. Server pauses or steps the world while an agent thinks
**Pros.** Fully reproducible; the agent's latency stops mattering.
**Cons.** **Ruins the game for any human in the match** — a human cannot be asked to wait while an
opponent's model streams tokens. Also multiplies CPU cost, since a match occupies its worker far
longer than its sim time.

### D. Hybrid: per-match clock policy, with an APM ceiling always on
**Pros.** Each mode is used where it is correct. Reproducibility where it is needed, watchability
where humans are present.
**Cons.** Three modes to implement, document and test. A policy matrix that must never be
mis-selected — a human must never be dropped into a gated match.

## Decision

**Option D.** Pacing is a **per-match clock policy**, and the APM ceiling is applied in **all**
modes as an anti-abuse control — orthogonal, exactly as the dossier argues.

| Policy | When | Behaviour |
|---|---|---|
| **`realtime`** | **Forced whenever any seat is human** | The world never waits. An agent is a slow player, and its APM ceiling is a published, symmetric handicap. |
| **`deliberation`** | **Default for agent-only matches** | The sim advances in fixed 20-tick steps, gated on every agent seat calling `end_turn`, with a watchdog so one stalled agent cannot hang the match. Fully reproducible — this is the mode benchmarks and regression tests use. |
| **`slowed`** | Spectated exhibitions | Real-time semantics at a reduced clock, so a human audience can follow an agent match. |

**`realtime` is forced, not defaulted, when a human is seated.** This is a safety property, not a
preference: it must be impossible to configure a lobby that makes a human wait on a model.

`deliberation` being the default for agent-only matches follows directly from the testability
argument: it is the only mode in which a seeded match plus a scripted agent yields a **known
outcome**, which is what makes T-057 a real regression test rather than a demo.

## Consequences

**Gains.** Humans are never made to wait. Agent-vs-agent matches are reproducible, so agent
behaviour can be regression-tested under the project's TDD rules. The APM ceiling reuses a
mechanism the engine already implements and tests, and gives a defensible answer to "was the agent
given an unfair advantage" — it has a published cap, like every scripted opponent.

**Costs.** Three clock policies to implement and document. The mode is visible in the product (a
lobby says which clock it runs) rather than an implementation detail. `deliberation`'s watchdog is a
real piece of engineering: it must distinguish a thinking agent from a dead one without punishing
either.

**Follow-on work.** The `end_turn` tool and the watchdog. A published statement of each seat's APM
cap, visible to opponents (PRD Q4 recommends agent seats be labelled). Wiring `deliberation` into
the deterministic test harness so a scripted agent plays a seeded match to a golden outcome.

**Revisit if.** Real-time agent play turns out to be so weak that agent-vs-human is not interesting
— then a `slowed` clock becomes the default for mixed matches, with the human's consent at lobby
time, rather than `realtime`.
