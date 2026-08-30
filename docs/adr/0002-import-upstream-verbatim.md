# ADR-0002: Port by importing upstream verbatim, with full history

**Status:** Accepted
**Date:** 2026-08-30
**Serves:** PRD G3 (preserve single-player), G4 (discipline), P3 (the maintainer)

## Context

`alma92350/SpaceCities` was created empty. The port has to start somewhere, and the choice of
starting point determines whether the inherited test suite protects the work or is merely admired
from a distance.

Measured facts about the upstream repo (`alma92350/SpaceExploration-RTS` at `50ceb88`):

- **2,519 tests across 115 files, all green, ~5.5 minutes.** Zero dependencies.
- ~85k lines: `engine/` 15,659 · client 17,903 · `test/` 41,013 · `tools/` 3,663 · `docs/` 7,116.
- Licensed **MIT**, copyright the same author who owns this port.
- Actively developed — HEAD is a merge of PR #95, dated two weeks before this decision.

The last two points matter. There is no licensing obstacle, and upstream is *still moving*, so any
starting point that severs the relationship with upstream forfeits future engine fixes permanently.

## Options considered

### A. Clean-room rewrite; consult upstream as a reference
**Pros.** A codebase shaped for multiplayer from line one, with no inherited single-player
assumptions.
**Cons.** Discards 41,013 lines of tests — the only thing that can tell us a 90k-LOC transformation
did not silently break the game. Re-deriving the balance, the AI archetypes, the terrain rules and
the counter triangle would take months and reproduce them worse. Upstream fixes become
un-mergeable. **Rejected decisively.**

### B. Copy the files in as a single "initial import" commit
**Pros.** Simple; the tests come along.
**Cons.** `git blame` on any inherited file terminates at the import commit, so the reasoning behind
15k lines of subtle engine code becomes unreachable exactly when someone is debugging it. Upstream
merges become manual patch application.

### C. Base the branch on upstream's own history, with `upstream` as a live remote
**Pros.** Everything in B, plus: `git blame` and `git log --follow` reach through to the original
authorship; a future upstream fix is `git cherry-pick`, not re-implementation; the diff
`upstream/main..HEAD` is *exactly* "what this port changed", permanently, which is the single most
useful review artefact this project can have.
**Cons.** Our history starts with 542 commits we did not write, so "commits in this repo" is a
misleading metric. Requires the upstream remote to stay reachable to be useful.

## Decision

**Option C.** The branch `claude/spacecities-multiplayer-rts-port-hp9195` is based directly on
upstream `50ceb88`, carrying all 542 commits of history, and `upstream` is configured as a git
remote pointing at `https://github.com/alma92350/SpaceExploration-RTS`.

The inherited test suite is the port's safety net and is expected to be **green at every commit**.
Where a multiplayer change makes an inherited test's assumption obsolete, that test's assertion is
updated to the new intended contract in the same commit — never deleted, never skipped
(`CONTRIBUTING.md` already requires this).

Upstream's `LICENSE`, `README.md` attribution and `CONTRIBUTING.md` invariants are retained.

## Consequences

**Gains.** The port begins green, with a 2,519-test regression net over every subsequent step.
Blame and history survive. `upstream/main..HEAD` is a permanent, precise record of the port.
Upstream engine fixes stay mergeable.

**Costs.** We inherit upstream's constraints as well as its tests — the zero-dependency and
no-build-step rules are now *our* rules (this is intentional; see PRD G4). The repo's history
misrepresents how much of it we wrote. Divergence from upstream raises the cost of future merges, so
engine changes must stay minimal and, where possible, upstreamable.

**Follow-on work.** Rebrand to SpaceCities (`package.json`, `README.md`, `version.js`) *without*
touching engine internals, so the upstream diff stays semantically clean. CI must run the inherited
suite from the first commit.

**Revisit if.** Upstream is archived or diverges so far that merges routinely conflict across the
engine; at that point drop the remote and accept the fork.
