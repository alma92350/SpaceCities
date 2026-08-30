# ADR-0001: Record architecture decisions in this log

**Status:** Accepted
**Date:** 2026-08-30
**Serves:** PRD G4 (keep the engineering discipline), P3 (the maintainer)

## Context

This port makes a series of decisions that are cheap now and extremely expensive later: whether the
server or the peers own the simulation, whether commands carry object references or ids, whether
single-player keeps its own code path. Each is the kind of decision whose *reasoning* evaporates
within weeks while its *consequences* persist for years — and the person who most needs that
reasoning is a maintainer merging an upstream engine fix in 2027.

The upstream codebase already demonstrates the value of writing reasoning down: its source comments
explain *why* (see the header of `engine/loop.js` on why speed scales the accumulator rather than
the fixed timestep — a paragraph that prevents a whole class of well-intentioned regression). ADRs
apply the same instinct at the level of the system rather than the function.

The user explicitly asked for "an ADR file to log architectural decisions and their evolution".
"Evolution" is the operative word: the log must show decisions *changing*, not just their end state.

## Options considered

### A. No formal log; rely on code comments and commit messages
**Pros.** Zero ceremony; matches the upstream style.
**Cons.** Commit messages describe changes, not choices, and are not discoverable by topic. Code
comments explain the code that exists, never the three designs rejected before it.

### B. One living `ARCHITECTURE.md`, edited as things change
**Pros.** Single file, always current.
**Cons.** Editing destroys history. It answers "what is the design" but never "why is it not the
other thing", which is exactly the question a later maintainer asks. Fails the "evolution"
requirement outright.

### C. Numbered, immutable ADRs with supersession (Nygard-style)
**Pros.** Records evolution natively — a changed decision produces a new record superseding the old,
so both the current design and the path to it stay readable. Each record is small and reviewable in
the PR that makes the change.
**Cons.** Requires discipline; an index must be maintained; a reader must follow supersession links
to be sure they have the current answer.

## Decision

We keep a numbered ADR log in `docs/adr/`, one record per architecturally significant decision,
using [`_template.md`](_template.md).

**ADRs are immutable once `Accepted`.** A decision that changes gets a new ADR that supersedes the
old; the old record is marked `Superseded by ADR-XXXX` and otherwise left exactly as written. The
index in [`README.md`](README.md) is the map.

A decision is "architecturally significant" if reversing it later would require changing code in
more than one subsystem, or if it constrains what the project can do at all. Choice of a variable
name is not; choice of a transport is.

## Consequences

**Gains.** The reasoning survives the conversation that produced it. Review happens on the decision,
in its own small file, rather than buried in a large PR. The wrong turns stay legible.

**Costs.** Roughly 20–40 minutes per significant decision. An index that can drift from reality if
not maintained in the same commit as a new record.

**Follow-on work.** ADRs are written *before* the work they authorize, not after — a `Proposed` ADR
is the artefact that gets reviewed, and nothing depending on it is built until it is `Accepted`.

**Revisit if.** The log grows beyond ~30 records and the index stops being a useful map; at that
point group by subsystem.
