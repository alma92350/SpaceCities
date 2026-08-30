# ADR-0010: Deploy to Hugging Face Spaces by direct git push, on free CPU Basic

**Status:** Accepted
**Date:** 2026-08-30
**Serves:** PRD G5, FR-21, FR-22, Q1, Q2
**Evidence:** [`docs/analysis/04-hf-deployment.md`](../analysis/04-hf-deployment.md)

## Context

The target is `huggingface.co/spaces/Almaatla/SpaceCities`, an existing **private Docker Space**
currently running a Python app. Research against live HF documentation turned up four findings that
change the plan, two of them hard blockers.

**The good news first:** raw WebSocket upgrades were **verified empirically** to traverse the HF
edge proxy and reach the container. A 20 Hz push is not a problem, and ADR-0005's transport is safe.
This is corroborated by the owner's own live Space `Almaatla/private-room`, which serves a WebSocket
chat and an MCP endpoint on one port.

**B1 — the Space must be made public.** A private Space returns `404` to everyone except the owner
and collaborators — *the running app*, not merely the source. Anonymous players cannot reach it at
all. PRD G1 is unreachable while it stays private.

**B2 — the account is not on a paid plan** (`is_pro: false`, verified via the Hub API), and HF now
documents that *"Gradio and Docker Spaces run on compute and require a paid plan to **create**"*.
Both doc sentences are worded against *creation*, and this Space already exists, so overwriting it
should be fine. But **whether a free account can still push to and rebuild an existing Docker Space
is UNVERIFIED**, and it is the single highest-value thing to test early.

**B3 — classic persistent storage no longer exists.** `suggested_storage` is documented as ignored;
`/data` is now an attached **Storage Bucket** volume. The current Dockerfile's `ln -s /data data` is
very likely symlinking to ephemeral disk today.

**B4 — free hardware sleeps after 48 h idle, and in-memory state dies** — on sleep, on **every git
push** (each push rebuilds and restarts the Space), on every settings change, and on any crash.

That last one is the finding with teeth: **deploying destroys every match in progress.**

## Options considered

### Deployment mechanism
**A. `huggingface/hub-sync` action.** Convenient, but it runs `hf repo create` — idempotent on an
existing repo, yet it is precisely the step that could hit the B2 paywall.
**B. Direct authenticated `git push` to the Space remote.** Touches no creation API at all.

### Hardware
**A. Free CPU Basic** (2 vCPU / 16 GB / 50 GB). Sleeps after 48 h idle; no custom sleep time.
**B. CPU Upgrade at $0.03/hour** (~$21.60/month if always on). Runs indefinitely.
**C. Free tier plus an external keep-alive pinger.** **Rejected outright** — a user who pinged a
Space every 2 minutes had it *paused for abuse*. The downside is losing the Space.

## Decision

**Deploy by direct authenticated `git push` (option B), onto free CPU Basic (option A), with the
Space made public.**

1. **Direct git push**, not `hub-sync` — it avoids the one API call that might be paywalled for a
   non-PRO account. The GitHub Action force-pushes the built tree to the Space remote, which cleanly
   overwrites the unrelated Python history already there. The token never appears in logs.
2. **Verify the push path before investing in the port.** A trivial commit is pushed to the Space
   and watched through a successful rebuild **as an early task (T-007a)**, resolving B2 empirically.
   If a free account cannot rebuild an existing Docker Space, everything downstream changes, and it
   is far better to learn that in week one.
3. **Never delete the Space.** It may not be recreatable on this account.
4. **Make the Space public** (B1). Requires owner action — PRD Q1.
5. **Free CPU Basic**, with no keep-alive pinger. 48 hours of idle tolerance is ample for a game
   people actually play, and $0.03/h removes the problem later if it gets traction. Q2 is thereby
   answered: **start free.**
6. **Treat `/data` as a Storage Bucket that may not be attached**, with a working fallback so the
   server boots either way.
7. **Serve everything on one port (7860):** static assets, the game WebSocket, and `/mcp`.

## Consequences

**Gains.** Deployment is automated from day one (G5) on the cheapest viable footing, avoiding the
paywall risk and the abuse risk. The transport choice is confirmed against the real platform rather
than assumed.

**Costs — and one is architectural.** Because **every deploy restarts the Space and destroys
in-memory state**, matches must be **crash-tolerant, not merely long-lived**. This is not a Phase 7
hardening nicety; it is a property the session design must have from the start, and it gets its own
record (ADR-0012). Free-tier sleep also means the first visitor after 48 h idle meets a `503`, so the
client needs a friendly loading state and WebSocket retry with backoff.

**Follow-on work.** T-007a (verify the free-account rebuild path — do this first). Attach a Storage
Bucket and confirm `/data` actually persists rather than trusting the symlink. Measure cold-start
time once deployed rather than designing around a guess. Make the Space public.

**Revisit if.** T-007a shows a free account cannot rebuild the Space — then PRO at $9/month becomes
a prerequisite, not an option. Or if the game gets enough traffic that sleep and single-core limits
bite, at which point CPU Upgrade is the documented answer.
