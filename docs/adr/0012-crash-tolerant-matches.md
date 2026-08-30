# ADR-0012: Matches are crash-tolerant, snapshotted to disk

**Status:** Accepted
**Date:** 2026-08-30
**Serves:** PRD FR-5, FR-22, G5
**Evidence:** [`docs/analysis/04-hf-deployment.md`](../analysis/04-hf-deployment.md) §3.3

## Context

The natural design for a match server keeps each match in memory for its lifetime — 20 to 60
minutes here — and persists only results. The platform research shows that would be wrong on this
target, for a reason that is easy to miss.

A Hugging Face Space restarts and **loses all in-memory state**:

- after **48 hours** idle on free hardware (sleep);
- on **every git push** — *"Each time a new commit is pushed, the Space will automatically rebuild
  and restart"*;
- on **every settings change** (secrets, hardware);
- on any crash — a failing Space is automatically suspended.

The second item is the sharp one. **Deploying destroys every match in progress.** With
push-to-deploy (ADR-0010, FR-21), an ordinary Tuesday-afternoon commit ends everyone's game. Sleep
is a 48-hour event and tolerable; deploys are a daily event and are not.

This inverts the usual priority. Persistence here is not about surviving rare disasters; it is about
surviving **routine, self-inflicted, frequent restarts**.

## Options considered

### A. In-memory matches; a restart ends them
**Pros.** Simplest. Matches are short.
**Cons.** Every deploy kills live games, so shipping becomes something to be feared and batched —
which is exactly the dynamic continuous deployment exists to remove. Fails FR-22 in spirit.

### B. Snapshot each match to disk periodically; restore on boot
**Pros.** A restart costs seconds, not a match. Deploys become safe, so the team ships freely.
Reconnect (FR-5) and restart-resume become the *same* mechanism.
**Cons.** Snapshot cost on the tick loop. Storage must actually persist — non-trivial given that
`/data` is now an attached Storage Bucket that may not be mounted (ADR-0010 B3). Restoring
mid-match must reproduce state exactly, or players return to a subtly different game.

### C. Drain before deploy — refuse new matches, wait for existing ones to finish
**Pros.** No snapshot machinery.
**Cons.** Up to a 60-minute wait to ship anything, and it does nothing for sleep or crashes.

## Decision

**Option B.** Every match snapshots its authoritative state to disk on a cadence (roughly every
5–10 seconds, plus on significant transitions) and is restored on boot.

This is affordable because **the serialization already exists and is already tested**:
`engine/persist.js` provides `serializeGame`/`deserializeGame` with sanitization and version gating,
and the save is small by design — the map regenerates from the seed rather than being stored.
Snapshotting a match is the single-player save, reused.

Each match has a stable id, and clients rejoin by id after a reconnect. **Restart-resume and
player-reconnect are deliberately the same mechanism**, so the rarely-exercised path (restart) is
covered by the constantly-exercised one (reconnect).

Deliberate non-goal: **a restart may cost a few seconds of simulation.** Snapshots are periodic, not
per-tick. Players rejoin a match that has rewound slightly rather than one that vanished, and that
is the right trade.

## Consequences

**Gains.** Deploying stops being dangerous, which keeps FR-21 honest — push-to-deploy is only a
feature if pushing is safe. Sleep and crash recovery come free. FR-5's disconnect handling shares
the mechanism, so both paths get exercised constantly. And because the AI can take over any seat
(PRD §6.2), a restored match can resume even before its humans reconnect.

**Costs.** Snapshot serialization on the tick loop — bounded by the same measurement that ADR-0009
already requires (T-015), since both are serialization cost. Storage must be verified to actually
persist. Snapshot/restore must be exact, which needs a round-trip determinism test, not just a
smoke test.

**Follow-on work.** Confirm `/data` persistence with a real Storage Bucket before relying on it. A
test that a match snapshotted mid-play, restored, and continued produces the same
`fingerprint(state)` as one that ran uninterrupted. Move match persistence **out of Phase 7 and into
the phase that introduces match workers**, since the session design depends on it.

**Revisit if.** Snapshot cost proves material against the tick budget — then snapshot on a
background worker from a structured clone, rather than inline.
