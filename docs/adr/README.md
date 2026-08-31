# Architecture Decision Records

An ADR captures **one architecturally significant decision**: the context that forced it, the
options weighed, what was chosen, and what it costs. They are the project's reasoning log.

## How this log works

- ADRs are **immutable once accepted**. A decision that changes is not edited — a *new* ADR is
  written that supersedes it, and the old one is marked `Superseded by ADR-XXXX`. The wrong turns
  stay readable, because knowing why an approach was abandoned is worth as much as the approach
  that replaced it.
- **Statuses:** `Proposed` → `Accepted` → (`Superseded by ADR-XXXX` | `Deprecated`).
  `Proposed` means written but not yet ratified; nothing depending on it should be built yet.
- Numbering is sequential and never reused.
- Every ADR links to the PRD requirements it serves and, where one exists, the analysis dossier in
  [`../analysis/`](../analysis/) that supplied its evidence.

Use [`_template.md`](_template.md) for new records.

## Index

| # | Title | Status | Supersedes / Superseded by |
|---|---|---|---|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions in this log | Accepted | — |
| [0002](0002-import-upstream-verbatim.md) | Port by importing upstream verbatim, with history | Accepted | — |
| [0003](0003-server-authoritative-simulation.md) | Server-authoritative simulation, not peer lockstep | Accepted | — |
| [0004](0004-loopback-transport.md) | Single-player runs through the multiplayer path | Accepted | — |
| [0005](0005-transport.md) | Hand-rolled RFC 6455 WebSocket, zero dependencies | Accepted | — |
| [0006](0006-command-wire-protocol.md) | Id-based, server-stamped, tick-scheduled commands | Accepted | — |
| [0007](0007-agent-pacing.md) | Agents play real time under an APM ceiling; gated mode for evaluation | Accepted | — |
| [0008](0008-n-player-generalization.md) | Two seats first, N seats second | Accepted | — |
| [0009](0009-fog-filtered-state.md) | Per-seat fog-filtered state projection | Accepted | — |
| [0010](0010-hf-deployment.md) | Deploy by direct git push, on free CPU Basic | Accepted | — |
| [0011](0011-one-match-per-process.md) | One match per worker process | Accepted | — |
| [0012](0012-crash-tolerant-matches.md) | Matches are crash-tolerant, snapshotted to disk | Accepted | — |
| [0013](0013-direct-transport-for-unported-boot-paths.md) | A minimal direct-apply Transport for boot paths T-012 doesn't port | Accepted | — |
