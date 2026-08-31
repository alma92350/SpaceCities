# Contributing

SpaceCities is a vanilla-JavaScript, ES-module game with **no build step** and **no
runtime dependencies**. The files in the repo are exactly what the browser loads. That simplicity
is a feature — please keep it. A few rules are load-bearing; the test suite enforces them, so a
change that breaks one fails `npm test` rather than shipping.

## Getting set up

```
node --version      # must be >= 20
npm start           # serve the game at http://localhost:8080  (zero-dep static server)
npm test            # run the full suite (node --test)
```

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
   contract rather than deleting coverage.

## Commits

- Keep commits focused and their messages descriptive — say what changed and why, and note that
  the suite stays green.
- Every commit is signed off with:

  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  ```

## Protecting `main` (one-time repo setup — not yet done)

Everything above is enforced by tests, and the tests run in CI on every push and pull request. But
nothing stops a red build being merged anyway, and that is not hypothetical: `npm run typecheck`
failed on every commit from 2026-08-05 to 2026-08-08, and PRs #90 and #91 both merged to `main`
straight through it. A gate nobody is required to pass is a gate that eventually gets walked past.

This is a repository setting, so it cannot live in a file here. It takes about two minutes:

**Settings → Branches → Add branch ruleset** (or *Add rule* on the classic UI)

- Target branch: `main`
- ☑ **Require status checks to pass before merging**, and add all three by name:
  - `tests (node 20)`
  - `tests (node 22)`
  - `browser smoke test`

  All three must be listed. The matrix produces one check per Node version, and requiring only one
  lets a version-specific regression through — which is the whole reason the matrix exists. The
  smoke job is the only check that can see a page which parses cleanly and then throws on load.
- ☑ **Require branches to be up to date before merging** — so a check that passed against a stale
  base cannot count for a merge onto a newer one.
- ☑ **Block force pushes**

Leave "Require a pull request before merging" to taste; it is orthogonal to the failure above,
which was about a red check rather than an unreviewed one.

The check names come from `.github/workflows/test.yml`'s job name
(`name: tests (node ${{ matrix.node-version }})`). If that line is ever edited, the required
checks silently stop matching and the gate goes quiet — so change the two together.

## Release checklist

When cutting a release:

1. `npm test` is green (determinism + purity + static-integrity included), and `npm run typecheck`
   reports no errors on the `// @ts-check`ed files.
2. `npm run smoke` is green — boots the real page in real Chromium, starts a match and clicks
   things, failing on any uncaught error (`tools/smoke.js`; CI runs it as the *browser smoke test*
   job). It is shallow on purpose. Still worth ten minutes by hand for anything the script does not
   cover — an Odyssey run, and a save/reload of both modes.
3. Bump `APP_VERSION` in `version.js` **and** `version` in `package.json` to the new semver, and
   keep `version.json` in sync (the auto-update check compares them). (`test/release-manifest.test.js`,
   `test/version.test.js`.)
4. If any save shape changed, confirm `SAVE_VERSION` / `GALAXY_SAVE_VERSION` were bumped and old
   saves still load.
5. Add a dated section to `CHANGELOG.md`.
6. Tag the release: `git tag vX.Y.Z && git push --tags`.
