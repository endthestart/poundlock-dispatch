# Contributing

Dispatch is the desktop app and terminal client over one shared runtime. Keep Pi
1.1.0 and the boundary between the manager, which plans, delegates and reviews and
has no shell, file writer or patch tool, and the workers, which implement. Changes
to the Poundlock contract start in the Poundlock repository; see
[ECOSYSTEM.md](ECOSYSTEM.md).

## Checks

Use Node.js 22.19.0 or newer. Install with `npm ci`, then:

```sh
npm run lint
npm run typecheck
npm test
```

Tests are offline and use synthetic data. `npm run dev` opens the desktop app;
`POUNDLOCK_DISPATCH_FAKE_MANAGER=1 npm run dev` uses a scripted manager. The
`tests/live-*.test.ts` files run only when `POUNDLOCK_URL` and `POUNDLOCK_TOKEN`
name a controller you control.

`npm run package` builds the macOS app on a Mac, and `npm run package:linux` the
Linux archive on Linux. Both bundle the full third-party license texts, and
`node scripts/check-package.cjs <app>` checks the Electron runtime, fuses and
notices inside the result. Quit the packaged app before rebuilding it. Do not
claim a platform works because it cross-compiles.

## Continuous integration

Every pull request, forks included, runs `.github/workflows/ci.yml` on
GitHub-hosted runners with a read-only token and no secrets: secret, lockfile and
static scans, the Linux build, tests, audit gate, package and smoke run, and the
macOS tests, package, app check, smoke run and a scratch terminal install. A
version tag reruns it and attaches the packages it built to a draft release only
after a maintainer approves.

## What a change needs

Read [SECURITY.md](SECURITY.md) before changing execution, permissions, network
or credential handling. New permission rules need negative cases as well as
scoped positive ones. Preserve session history and pending work across upgrades,
and add a reviewed migration when stored data changes. Do not add automatic
inference retries after a tool has had effects.

Never put real endpoints, private addresses, personal paths, credentials, private
source or raw model transcripts in a fixture, test or issue. Use synthetic values.

## Contribution terms

Contributions are accepted under the Apache License 2.0, as its section 5
describes; there is no separate agreement to sign. Patches written with an AI
assistant are welcome and reviewed like any other: the contributor is responsible
for them, and tests and provenance matter more than how a patch was written. Do
not submit code you do not have the right to contribute.
