# ADR-0013: A minimal direct-apply Transport for boot paths T-012 doesn't port

**Status:** Accepted
**Date:** 2026-08-31
**Serves:** PRD G3 (preserve single-player), ADR-0004 (extends it)

## Context

ADR-0004 decided the client never touches `engine/` mutation directly: it holds a session behind a
`Transport` (`net/transport.js`), and single-player's loopback transport is the same interface
multiplayer's `WebSocketTransport` will implement. `input.js`, `inputCommands.js`, and
`hudSelection.js` are where that decision meets the actual UI — every right-click, every production
button, every hotkey issues a command through whatever it's given.

T-012 (`TASKS.md`) is "port the single-player client onto session + loopback", and it does not port
*everything*. Its own scoping, carried over from dossier 03 and the PRD's explicit non-goal
(multiplayer Odyssey is out of scope), is that only the ordinary skirmish and a live competition
fixture move onto a real `server/session.js` session this pass. Odyssey, a scenario/raider/bounty,
and a spectated match keep ticking exactly as they did before (`stepGalaxy`, `tickSelfPlay`,
`engine/sim.js`'s own `tick`, called directly by `boot.js`'s loop) — porting them onto sessions is a
materially bigger change (a session assumes one `engine/sim.js` match; Odyssey is a galaxy of them,
ticked together) than "port the client's input handling" calls for.

The problem: `input.js`/`inputCommands.js`/`hudSelection.js` are **shared** across every one of those
boot paths. The same `commandAt` right-click handler, the same "Produce Worker" button, serves an
ordinary skirmish and an Odyssey colony alike. If command issuing only worked through a real
session's transport, the shared modules need to know, at every call site, whether *this* match has
one — which is exactly the two-paths-that-drift problem ADR-0004 was written to eliminate, just
reopened one layer down.

## Options considered

### A. Nullable `transport`, branch at every call site
`if (transport) transport.submitCommand(cmd); else issueX(...)` at each of the ~17 command-issuing
sites in `inputCommands.js`/`input.js`.
**Pros.** No new file; `attachInput`'s unported callers (Odyssey's `focusActivePlanet`) need no
change at all.
**Cons.** Every call site carries a branch a reader has to trust is symmetric with every other. It
is the per-path duplication ADR-0004 exists to prevent, reintroduced as an `if` instead of a second
file. Untestable as "one behaviour" — the null path and the transport path are two behaviours that
happen to share a line count.

### B. Force every boot path onto a real session now
Make `transport` never null by porting Odyssey/scenario/spectate onto per-match sessions in the same
pass.
**Pros.** Fully matches ADR-0004's diagram with no exceptions.
**Cons.** Scope creep into subsystems this phase does not otherwise touch, for a UI-input-handling
task. Odyssey's own tick shape (a galaxy of worlds, one `stepGalaxy` call, background colonies on a
coarser schedule) is not "one session, one `tick(dt)`" — reconciling that is real design work
belonging to whichever phase actually ports Odyssey, not a prerequisite sitting in front of it.

### C. A second, narrower `Transport`: `net/directTransport.js`
`createDirectTransport(state)` has no session, no `tick()`, no `aiSeats` — it does nothing but
`Promise.resolve(applyCommand(state, cmd))`, reusing `server/session.js`'s own `applyCommand`
dispatch table (already exported standalone for exactly this kind of reuse, per that file's own
header). Every boot path gets *some* `Transport`; only the ones actually behind a session get a real
one. `boot.js` decides which, once, at boot time — `input.js`/`inputCommands.js`/`hudSelection.js`
never branch on it.
**Pros.** The shared modules keep exactly one calling convention — `transport.submitCommand(cmd)`,
unconditionally — which is ADR-0004's actual payoff, preserved even though not every match is
server-authoritative yet. Ticking is untouched for every unported path: `boot.js`'s loop branches on
whether the *caller* built a real session (the `transport` option to `bootState`), never on whether
`game.transport` is merely non-null.
**Cons.** A second small transport implementation whose entire reason to exist is "the migration
isn't finished" — a permanent-looking file for a temporary reason. It must eventually be deleted, not
extended, if a later phase ports Odyssey/scenario/spectate onto real sessions too.

## Decision

**Option C.** `net/directTransport.js` exports `createDirectTransport(state)`. `boot.js`'s
`bootState` uses the real session-backed transport when its caller built one (`startGame`,
`startCompetitionMatch`, a loaded skirmish save — all now route through `createSession` +
`net/loopback.js`, per ADR-0004) and falls back to `createDirectTransport(newState)` otherwise.
`focusActivePlanet` (Odyssey's per-jump rewiring) does the same, per planet. Every boot path assigns
`game.transport`; `input.js`/`inputCommands.js`/`hudSelection.js` read it unconditionally and never
check whether it is the real one.

## Consequences

**Gains.** `input.js`/`inputCommands.js`/`hudSelection.js` have exactly one calling convention,
everywhere, forever — or at least until every boot path is session-backed, at which point
`net/directTransport.js` deletes cleanly with zero changes to those three files, because they only
ever knew about the generic `Transport` interface. T-012 stays scoped to porting the client's command
issuing, not to redesigning Odyssey's relationship to server authority.

**Costs.** The codebase now has a third `Transport` implementation ADR-0004's own diagram did not
anticipate (it names loopback and WebSocket). `game.transport` can be genuinely non-authoritative — a
direct-apply adapter with no ownership/fog validation, no determinism guarantee across ticks, no
replay value — for real playtime (any Odyssey session, any scenario), and nothing in the client's own
code distinguishes that from the real thing; by design, but it means ADR-0003's server-authority
guarantees are quietly false for those matches, same as before T-012, just now expressed through the
same interface instead of a visibly different one.

**Follow-on work.** If Odyssey, a scenario, or a spectated match is ever ported onto real per-match
sessions, delete `net/directTransport.js` and its `boot.js` call sites. Nothing else changes.

**Revisit if.** A third *kind* of "not quite a full session" requirement shows up (suggesting the
real/direct split should become a richer spectrum, not a binary), or Odyssey is ported onto sessions
(making `net/directTransport.js` dead code to remove, not a design to extend).
