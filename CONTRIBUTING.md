# Contributing

SpaceCities is a vanilla-JavaScript, ES-module game with **no build step** and **no
runtime dependencies**. The files in the repo are exactly what the browser loads. That simplicity
is a feature — please keep it. A few rules are load-bearing; the test suite enforces them, so a
change that breaks one fails `npm test` rather than shipping.

## Getting set up

```
node --version      # must be >= 22 (the global WebSocket the multiplayer client needs)
npm start           # serve the game at http://localhost:8080  (zero-dep static server)
npm test            # the suite you run on every change (node --test) — ~50s
npm run test:slow   # the long bench guards (test/slow/) — ~4 minutes
```

`npm test` is the inner loop and is meant to stay fast. `npm run test:slow` holds the 72
`tools/ailab.js` guards that drive real matches; they used to sit in `npm test` and made it take
five minutes, most of it an AI-tuning sweep that almost no commit can affect. They are **not
optional and never skipped** — CI runs both on every push and pull request, and
`test/suite-integrity.test.js` fails if the slow half loses its script, its CI job, or its files.
Run `npm run test:slow` before anything that touches `tools/ailab.js`, `tools/genome.js`, or AI
tuning, and before cutting a release.

There is nothing to install — no `npm install`, no bundler, no transpiler.

## The hard rules

These are invariants, not preferences. Each has a guarding test that will go red if you break it.

### 1. The engine is pure, deterministic, and DOM-free

Everything under `engine/` is the simulation: pure logic, no rendering, no browser. It must obey:

- **One source of randomness.** All randomness comes from the seeded PRNG in `engine/rng.js`
  (`mulberry32`, plus the `hashStr` tie-break helper). The engine may **never** call
  `Math.random`, `Date.now`, `new Date`, or `performance.now` — not even in a comment.
  (`test/engine-purity.test.js`.) A line that genuinely isn't the sim can opt out with a
  `deterministic-exempt` comment, but that should be vanishingly rare.
- **No DOM / browser globals.** No `document`, `window`, `localStorage`, `fetch`,
  `requestAnimationFrame`, etc. under `engine/`. The one sanctioned seam is the render loop in
  `engine/loop.js`, whose `requestAnimationFrame` lines carry a `browser-exempt` marker.
  (`test/engine-purity.test.js`.)
- **Same seed ⇒ same game.** Two runs from the same seed must produce byte-identical state, on
  every world. If you touch the engine, keep replays identical — watch iteration order and
  float-accumulation order especially. (`test/determinism.test.js`,
  `test/determinism-roster.test.js`.)

If you need a stable-but-varying value (a per-unit angle, a tie-break), hash an id through
`hashStr` — don't reach for a clock or `Math.random`.

### 2. No build step, ever

The browser loads the repo as-is. So:

- Ship plain ES modules the browser understands — no JSX, no TypeScript syntax, no bundler-only
  imports.
- Every `getElementById` target must exist in `index.html` (or be created in JS), every relative
  import must resolve, and every file must parse. (`test/static-integrity.test.js`.)
- UI modules should stay import-safe under Node (guard top-level `window`/`document` access), so
  their logic can be unit-tested. `dom.js` already resolves `document` defensively; follow that
  pattern.

### 3. Saves are versioned

Save data is untrusted input and is version-gated:

- `engine/persist.js` owns `SAVE_VERSION` (skirmish) and `GALAXY_SAVE_VERSION` (Odyssey). **Bump
  the relevant one whenever you change a save's shape in a way older saves can't survive.** The
  version check is exact-match (`if (save.v !== SAVE_VERSION) throw`) — there is no migration
  step, so bumping the version makes every save written under the old version unloadable; the load
  fails fast with a clear "unsupported save version" error instead of feeding stale-shaped data
  into the sim. If a change is purely additive (a new optional field with a sensible default), you
  usually don't need to bump the version — `sanitizeSave`/`cleanEntity` already default missing
  fields for saves at the *current* version.
- Loading always sanitizes and coerces (`sanitizeSave`, `cleanEntity`) — never trust a field's
  type or range straight off the wire. That coercion covers corrupt or missing fields within a
  supported version; it's not a substitute for bumping the version when the shape itself changes
  in an incompatible way.

## Types (JSDoc + `// @ts-check`)

The core sim shapes — `State`, `Unit`, `Building`, `Player`, `Galaxy`, and friends — are defined
as JSDoc `@typedef`s in `engine/types.js`. That file has **no runtime code** and is never
imported; it exists purely so the type checker (and any editor with the bundled TypeScript
language service — e.g. VS Code out of the box) can verify field access against a real model
instead of an untyped bag. **No build step, no runtime dependency** — the shipped code stays plain
ES modules.

Type checking is **opt-in per file**: a file is checked only if it starts with a `// @ts-check`
pragma. Twenty engine files opt in today — the core data and hot-path modules (`state.js`, `movement.js`,
`gather.js`, `grid.js`, `fog.js`, `separation.js`, `formation.js`, `haul.js`, `recycle.js`,
`wreckage.js`) plus `supply.js`, `colliders.js`, `scout.js`, `victory.js`, `production.js`,
`persist.js`, `aiCommon.js`, `aiStrategy.js`, `aiDifficulty.js` and `aiArchetypes.js`. Expand
coverage file-by-file by adding the pragma **and annotating** the functions'
`state`/`unit`/`building` params with the shared typedefs.

The annotation half is not optional: `strict` and `noImplicitAny` are off, so an un-annotated
parameter is `any` and the pragma alone checks nothing. `test/types-contract.test.js` enforces both
halves — every `// @ts-check` file must annotate its exported functions, and every field a core
factory constructs must be declared on its `@typedef`.
This is what catches the silent-`undefined`-field class of bug — a mistyped or renamed field is a
check-time error, not a wrong result the same-seed determinism test can't see.

```
npm run typecheck        # runs `tsc -p jsconfig.json` — needs a TypeScript compiler available
                         # (global `tsc`, or `npx -y typescript` / a local install). Editors with
                         # the TS language service check the annotated files live, with no install.
```

When you add or rename a field on a core shape, update its `@typedef` in `engine/types.js` in the
same change.

## Style

Match the surrounding code: the same comment density (this codebase explains *why*, not *what*),
the same naming, the same idioms. Prefer a small pure helper in the right module over a clever
one-liner. Add or update a test for any behavioural change.

## Test-Driven Development

For a new feature or a behavioural change, write the test(s) first, from the requirement, before
writing the implementation:

1. Turn the requirement into one or more `node:test` cases in the file where that behavior
   belongs (see the existing suite for the idiom — direct state construction, no mocks). Do this
   from what the feature is supposed to do, not by reading ahead into a planned implementation.
2. Run them and confirm they fail for the right reason (a missing export, an assertion against
   current behavior) — red before green.
3. Implement the smallest change that makes them pass, following the rest of this guide (purity,
   determinism, save versioning).
4. Run the whole suite (`npm test`) and `npm run typecheck` — a new feature can surface a
   now-outdated assumption in an older test; update that test's assertion to the new, intended
   contract rather than deleting coverage. Add `npm run test:slow` when the change is anywhere
   near the AI bench.

A note on **where** a new test goes: `npm test` globs `test/*.test.js` and `npm run test:slow`
globs `test/slow/*.test.js`, so a file in any other directory under `test/` is run by neither.
That is the one way to add a test file that looks green because nothing executes it, so
`test/suite-integrity.test.js` asserts the two globs stay disjoint and exhaustive. A test belongs
in `test/slow/` only if it genuinely needs to drive real matches; the default is the fast half.

## Commits

- Keep commits focused and their messages descriptive — say what changed and why, and note that
  the suite stays green.
- Every commit is signed off with:

  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  ```

## Protecting the default branch

Everything above is enforced by tests, and the tests run in CI on every push and pull request. But
nothing stops a red build being merged anyway, and that is not hypothetical: `npm run typecheck`
failed on every commit from 2026-08-05 to 2026-08-08 in the upstream repo this one is ported from,
and two PRs there both merged straight through it. A gate nobody is required to pass is a gate that
eventually gets walked past.

It went quiet in a way worth recording, because it was not the way this section predicted. On
2026-09-02 the repository's Actions allowance ran out (2,000/2,000 on a private repo's free tier)
and every run from then on failed in 2-5 seconds having never started a runner. No workflow was
broken and no test was failing; the gate simply stopped existing, and the red X it left on each
commit looked enough like an ordinary failure that four commits merged behind it. A gate nobody is
required to pass is one thing. A gate that silently stops running is worse, because it still
reports something.

**This is now applied.** The repository is public (Actions minutes are unlimited and free for
public repositories, which also removes the failure above permanently) and the ruleset below is
active. It is a repository setting, so it cannot live in a file here — this section is the record
of what was configured, and the place to update if it ever changes.

**Settings → Rules → Rulesets → New branch ruleset**

- Name: `main protection`, Enforcement status: **Active**
- Target branches: **Include default branch** (`main`)
- ☑ **Require a pull request before merging.** Development is PR-based from 2026-09-06; it was
  direct-push to `main` for the whole port before that (`TASKS.md` T-005). This is not only about
  review — required status checks cannot be satisfied by a direct push at all, since the checks
  run *after* the push and a fresh commit has none yet. So the two rules come as a pair: choosing
  to require checks is choosing to work on branches.
- ☑ **Require status checks to pass**, and add all three by name — **confirmed present and
  correctly named in `.github/workflows/test.yml`**:
  - `tests (node 22)`
  - `browser smoke test`
  - `slow tests (ailab sweeps)`

  All three must be listed, and each earns its place differently. The Node 22 job is the suite.
  The smoke job is the only check that can see a page which parses cleanly and then throws on
  load. The slow job holds the 72 long-running bench guards since they were split out of
  `npm test` — they are not optional, only off the inner loop, so leaving them out of this list is
  the one way that split could quietly become a deletion of 72 tests.

  There used to be a fourth, `tests (node 20)`, and its removal is worth understanding rather than
  repeating: `package.json` claimed `">=20"` while the multiplayer client uses the global
  `WebSocket`, which Node only exposes from 22. That leg could never pass — and it did not fail
  cleanly either, it hung awaiting connections that could not open, 36 minutes against 72 seconds
  on the Node 22 leg, so the whole gate read as broken rather than as one false version claim. The
  matrix now names only the versions actually supported, and `test/runtime-floor.test.js` keeps
  `package.json`, the Dockerfile and that matrix agreeing so they cannot drift apart again.
- ☑ **Require branches to be up to date before merging** — so a check that passed against a stale
  base cannot count for a merge onto a newer one.
- ☑ **Block force pushes**

A check only appears in that picker once it has reported recently, so if one is missing, push
something first and come back.

## Day-to-day workflow

Since 2026-09-06, `main` is protected and takes no direct pushes. The loop is:

```
git checkout -b some-change     # branch off an up-to-date main
npm test                        # ~60s; the inner loop, run it constantly
npm run typecheck               # and before you push
git push -u origin some-change
```

then open a pull request and merge it once the three checks are green. `npm run test:slow` is not
part of the inner loop but CI runs it on the PR, so run it locally too for anything touching the
AI bench, rather than discovering it at merge time.

The point of the branch is not ceremony: it is that CI can only vouch for a commit *after* it
exists somewhere, and a branch is the somewhere that is not yet `main`.

The check names come from `.github/workflows/test.yml`'s job name
(`name: tests (node ${{ matrix.node-version }})`), so adding a Node version to the matrix adds a
check that must be added here too. If that line is ever edited, the required
checks silently stop matching and the gate goes quiet — so change the two together.

## Release checklist

When cutting a release:

1. `npm test` is green (determinism + purity + static-integrity included), `npm run test:slow` is
   green (the bench guards — a release is exactly when the slow half is worth the four minutes),
   and `npm run typecheck` reports no errors on the `// @ts-check`ed files.
2. `npm run smoke` is green — boots the real page in real Chromium, starts a match and clicks
   things, failing on any uncaught error (`tools/smoke.js`; CI runs it as the *browser smoke test*
   job). It is shallow on purpose. Still worth ten minutes by hand for anything the script does not
   cover — an Odyssey run, and a save/reload of both modes.
2b. `npm run smoke:mp` is green — two browsers, one server, a real shared link: host, join, both in
   one live match (`tools/smokeMultiplayer.js`, run as a second step of the same CI job). This is
   the only automated thing that sees the path a real player takes; everything multiplayer is
   otherwise tested one layer down in Node, and the gap between those two is where a live-match
   autosave crash sat unnoticed in every match anyone played.
3. Bump `APP_VERSION` in `version.js` **and** `version` in `package.json` to the new semver, and
   keep `version.json` in sync (the auto-update check compares them). (`test/release-manifest.test.js`,
   `test/version.test.js`.)
4. If any save shape changed, confirm `SAVE_VERSION` / `GALAXY_SAVE_VERSION` were bumped and old
   saves still load.
5. Add a dated section to `CHANGELOG.md`.
6. Tag the release: `git tag vX.Y.Z && git push --tags`.
