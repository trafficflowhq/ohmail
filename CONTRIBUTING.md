# Contributing

ohmail is built by a small team at [TrafficFlow GmbH](https://trafficflow.ch) in
Zürich. This repository is the free desktop client — one application on macOS,
Windows and Linux. Contributions are welcome, and so is a plain "this is wrong" —
the client is early enough that direction still moves.

## What is most useful right now

Every build now connects to a real mailbox
([status](README.md#status--read-this-first)), so the most valuable input is
about how it behaves against real mail:

- **Design and interaction** — the Blanc surfaces, keyboard flow, compact
  (≤ 390 px) layout, reduced-motion behaviour, screen-reader gaps.
- **The shell's security posture** — the CSP, the main window's empty capability
  list and the updater window's single listen-only grant, the
  offline guard, the aliases in `apps/desktop/vite.config.ts`. A way for the app
  to reach the network that we have missed is the most valuable bug in the
  repository.
- **The engine seam** — the window talks to the engine over a private pipe and
  nothing else. If you find a path around it, that is worth reporting even if
  nothing breaks yet.
- **Correctness of the honest claims** — if the README or
  `apps/desktop/README.md` overstates something, that is a bug too, and a
  serious one.

Please do not send IMAP or sync implementations unprompted. That layer has a
design (rules-first pipeline, desired-state folder moves, redacted handling of
sensitive mail) that is not published yet, and a large PR against it would be
wasted work. Open an issue first and we will tell you what is planned.

## Issues

Issues are welcome and read. Useful bug reports carry: your OS version, the
toolchain version (`rustc --version` and `node --version`), what you ran, what
happened, what you expected. If it is visual, a screenshot beats a description.

## Pull requests

- Fork, branch, open a PR against `main`, one change per pull request. PRs are
  reviewed by a human.
- Every change reaches `main` as a pull request, ours included.
- CI runs four jobs — macOS, Windows, Linux and the engine. Each platform job
  runs `tsc`, builds the UI bundle, smokes it, runs `cargo test` in both
  configurations, builds the engine and its runtime, packages the app, and then
  opens the artifact it just built to check the engine is inside and starts. The
  engine job typechecks and bundles the engine source on its own. All must pass;
  the smoke is what catches a view that lays out but draws nothing, and the
  artifact inspection is what catches a build that grew a network call. A pull
  request from a fork runs every job on GitHub's runners.
- On a pull request the platform jobs (macOS, Windows, both Linux
  architectures, the rpm install and the flatpak) and the Android APK build run
  only when the pull request changes something they build: the desktop app or
  the phone app, the engine and the packages it bundles, the web app's views the
  desktop window renders, `patches/`, `scripts/`, the root manifests and
  lockfile, `.gitattributes`, Cargo files, the workflow itself, or the version
  files a release bump writes. A pull request that changes only tests, docs or other workflows
  skips them, and they show as skipped. `.github/scripts/pr-build-scope.sh`
  decides, and its `changes` job prints why. The engine job and the
  engine-bearing UI smoke run on every pull request and every push to `main`,
  and a release tag, the nightly and a manual run build every platform.
- GitHub's hosted runners are one pool for the whole organisation, so the
  maintainers' own pull requests build no platform, no APK and no self-host
  smoke: they run the test suite and the engine jobs on the maintainers' own
  runners and the dco and guard checks on GitHub's. Their changes are built on
  every platform by the batch branch that lands them (`pr/batch-*`), by the
  release bump (`pr/release-<NNNN>-bump`) and by the nightly.
- The workflows under `.github/`, the tools under `scripts/` they run and the
  push gate's baseline under `.gate/` are changed by the maintainers. The
  **guard** check fails a pull request from a fork that changes them. If you
  need a change there, describe it in an issue or in your pull request and we
  will carry it.
- Keep the existing invariants: colours and shadows come from `packages/tokens`,
  never hand-written in a view; no message is ever replaced by a "N more"
  placeholder. The test suite enforces both, and it is meant to.
  [docs/INVARIANTS.md](docs/INVARIANTS.md) lists every invariant with the
  tests that hold it.
- Add or extend a test for behaviour you change.
- Put the release note for a change people will notice in
  `changelog.d/<slug>.md`, one file per pull request, and leave `CHANGELOG.md`
  alone: the release gathers those files into it, so two pull requests never
  conflict over the changelog. [changelog.d/README.md](changelog.d/README.md)
  has the format.
- Match the surrounding style. There is no formatter config to fight with.

## Running the tests

Node 22 (CI runs 22.23.4), and stable Rust for the desktop app's native half.
Every command runs from the repository root unless it says otherwise, in bash
(Git Bash on Windows).

Every week `.github/workflows/contributor.yml` clones the repository on a clean
Linux, macOS and Windows runner and runs the blocks marked for it, here and in
the READMEs, word for word. `test/contributor-route.test.ts` holds the
workflow and the blocks equal, so a pull request that changes a marked block
fails until the workflow changes with it. That half is the maintainers' to
carry (the guard check fails a fork's change under `.github/`); say so in the
pull request.

The root is an npm workspace with one lockfile; `apps/desktop` has its own and
is installed beside it. `--ignore-scripts` runs no dependency's install script,
as every CI install does. Then apply the patches this repository carries to its
dependencies (it is idempotent, and patches every installed copy, so it comes
after both installs), and build what the tests read:

<!-- run by .github/workflows/contributor.yml: install -->
```bash
npm ci --ignore-scripts
(cd apps/desktop && npm ci --ignore-scripts)
node scripts/apply-patches.mjs apply
npm run build                          # the workspace's TypeScript projects (tsc -b)
node scripts/engine-bundle.mjs         # the bundles the tests that read a bundle read
node apps/mobile/scripts/bundle-engine.mjs
node scripts/bundle-host.mjs server
node scripts/bundle-host.mjs worker
npx playwright install chromium        # the layout tests render in it
```

- `npm test` runs the whole suite (vitest over `apps/*/test`, `packages/*/test`
  and `test/`). The `*.pg.test.ts` files and the mail tests need the test
  services in `docker-compose.yml` (Postgres, GreenMail, RustFS, Dovecot, all on
  loopback) and a database of this checkout's own. The run checks once, before
  any test, whether each service answers on its port, and prints one line for
  each that does not. A file that needs a missing service is skipped, and the
  skip names the service, its address and the reason; everything else runs. A
  service that answers but is broken still fails. `TF_REQUIRE_PG=1`,
  `TF_REQUIRE_GREENMAIL=1`, `TF_REQUIRE_DOVECOT=1` and `TF_REQUIRE_RUSTFS=1`
  turn a missing service into a failure, as CI sets them. A test that checks
  for a service itself takes `serviceUp("greenmail")` (or `"pg"`, `"dovecot"`,
  `"rustfs"`) from `@trafficflow/db/testing` and skips only its own cases. The
  run without services is the run on macOS and Windows:

  <!-- run by .github/workflows/contributor.yml: suite -->
  ```bash
  : "${PART:=1}" "${PARTS:=1}"   # the whole suite, unless PART=k PARTS=n asks for part k of n
  npm test -- --shard="$PART/$PARTS"
  ```

  The suite runs one file at a time, so on one machine it takes hours (about
  two and a half on a GitHub macOS runner, five on Windows). Parts split it: `PART=2
  PARTS=4` runs the second quarter of the files, and the parts 1 to n together
  are the whole suite. The weekly job runs each part on its own fresh clone.

- With the services, the whole suite on one database leaves rows behind, and
  the files marked `@postpush: alone` (`node test/support/ci-shards.mjs
  --alone` lists them) fail over state they did not write. So it runs as CI's
  whole run runs it (nightly, on a batch branch and on a fork's pull request;
  a maintainer's other pull requests run only the files their change can
  reach, `.github/scripts/ci-select.mjs`), in sixteen shards, each on a
  database of its own, and each of those files on a database made from empty. That is the run on Linux, in parts as
  above: part k of n runs every n-th shard from shard k-1, and the last part
  also runs the files that run alone:

  <!-- run by .github/workflows/contributor.yml: suite-services -->
  ```bash
  : "${PART:=1}" "${PARTS:=1}"   # the whole suite, unless PART=k PARTS=n asks for part k of n
  docker compose --profile condstore up -d --wait
  failed=
  for n in $(seq $((PART - 1)) "$PARTS" 15); do
    bash scripts/lane-db.sh --drop "$PWD" && bash scripts/lane-db.sh "$PWD"
    TF_REQUIRE_PG=1 TF_REQUIRE_GREENMAIL=1 TF_REQUIRE_DOVECOT=1 TF_REQUIRE_RUSTFS=1 npx vitest run $(node test/support/ci-shards.mjs --shard "$n") || failed=1
  done
  if [ "$PART" = "$PARTS" ]; then
    for f in $(git grep -l '@postpush: alone' -- ':(glob)apps/*/test/**' ':(glob)packages/*/test/**'); do
      bash scripts/lane-db.sh --drop "$PWD" && bash scripts/lane-db.sh "$PWD"
      TF_REQUIRE_PG=1 TF_REQUIRE_GREENMAIL=1 TF_REQUIRE_DOVECOT=1 TF_REQUIRE_RUSTFS=1 npx vitest run "$f" || failed=1
    done
  fi
  test -z "$failed"
  ```

  `--profile condstore` starts Dovecot as well, and `--wait` holds until the
  services are up. `bash scripts/lane-db.sh "$PWD"` creates this checkout's
  database and writes `.lane-db.env`; on it, `TF_REQUIRE_PG=1 npx vitest run
  <files>` runs the files you changed (`TF_REQUIRE_PG=1`, as in CI: a database
  that cannot be reached fails, it does not skip; the loop above requires all
  four services the same way).
- `npm run test:sqlite` runs the files that also run on SQLite, the phone's and
  the desktop's store.
- `node scripts/changelog-fold.mjs --check` checks the entries in
  `changelog.d/` (`npm test` runs the same check); `--preview` prints the
  section the next release would write.
- **The desktop app's** tests live in `apps/desktop/test` and run in `npm test`.
  The few that load the desktop's own vite config need `apps/desktop` installed
  (without it, `npm test` leaves them out and says so); CI runs them in a job of
  their own. The app itself is checked on its own install:

  <!-- run by .github/workflows/contributor.yml: desktop -->
  ```bash
  npx vitest run $(node test/support/ci-shards.mjs --desktop)
  cd apps/desktop
  npm run ui:typecheck      # tsc over the shell, the views and the shim
  npm run ui:build:engine   # the bundle the app embeds, into dist/
  npm run smoke             # renders the built bundle and audits it offline
  cd src-tauri
  cargo test --locked
  cargo test --locked --features local-engine
  ```

  With `apps/desktop` installed or not, the suite loads one copy of each
  dependency (the root's; `vitest.config.ts` says why), so both give the same
  result. If a test you did not touch fails on "Invalid hook call", say so in
  an issue rather than mocking around it: that is the suite's bug, not yours.
- **The phone app** (`apps/mobile`, Android and iOS from one tree) has its own
  two commands:
  - `npm run typecheck:mobile` typechecks the app as the phone runs it
    (`apps/mobile/tsconfig.json`) and its tests as Node runs them
    (`apps/mobile/tsconfig.test.json`).
  - `npm run test:mobile` applies the patches, then runs the phone app's tests
    and the engine package they drive (`apps/mobile/test`,
    `packages/client-engine/test`), and the phone's file on the device
    store's own project. The tests that read the phone's mail engine bundle it
    themselves; to bundle it by hand, `node apps/mobile/scripts/bundle-engine.mjs`.
    The bundle is the same whether or not you ran `npm run build` first.
- The whole desktop build, with the engine in it, is "Build the desktop app
  yourself" in the README.

## Sign your commits (DCO) — and no CLA

**There is no contributor licence agreement and no copyright assignment.** You
keep your copyright. We will never ask you to sign your rights over to a Swiss
company in exchange for having a patch merged.

What we do ask for is the [Developer Certificate of Origin][dco] 1.1 — the same
lightweight sign-off the Linux kernel uses. It is one line per commit, and it
says you wrote the patch or otherwise have the right to send it:

```bash
git commit -s -m "fix: the Screener's compact drawer keeps focus"
```

`-s` appends the trailer, using your `user.name` and `user.email` from git:

```
Signed-off-by: Jane Hacker <jane@example.com>
```

Use a real name and a real address you read. Forgot on a commit you already
made? `git commit -s --amend` for the last one, or
`git rebase --signoff main` for a whole branch, then force-push.

### The DCO, in full

```
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.

Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same license (unless I am permitted to submit
    under a different license), as indicated in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

Sign-off is checked by CI, on pull requests only — the **dco** check. It walks
the commits your branch adds and asks each one for a trailer whose address is the
commit's author or its committer, so `git rebase --signoff` works and so does a
maintainer signing off a patch they are landing for you. Merge commits are
skipped.

It runs on pull requests and merge groups and never on pushes, because nothing
reaches `main` by a push: every change is a pull request, the maintainers'
included, and their commits carry their authors' sign-off like anyone else's.
The check is `.github/scripts/assert-dco.sh` and it is meant to be read.

If you forget, the check tells you which commits and what to run. Nobody will
ask you to sign anything else.

### What your contribution is licensed as, and what that means for us

Your contribution is licensed under **AGPL-3.0**, the same as the rest of this
repository. Nothing more is asked, and nothing more is taken.

The honest consequence, which most projects leave you to work out yourself:
because you keep your copyright and grant only the AGPL, **TrafficFlow cannot
ship your code in any part of ohmail Cloud that is not itself published**. For
almost everything here that is a non-issue — `apps/desktop` is the desktop
client and exists nowhere else.

There is one real exception, and you should know about it before you spend a
weekend on a patch. These trees are **shared with the Cloud web client**:

- `packages/tokens`, `packages/ui`, `packages/fixtures`
- `packages/client-engine`
- `apps/webapp/app/{shell,views}`

They are published here under AGPL-3.0 and used in the hosted Cloud client,
which TrafficFlow can do because it holds the copyright on all of it
([COPYRIGHT](COPYRIGHT)). A contribution from you into one of those files would
break that arrangement — we could only ship it on the Cloud side by publishing
that client's source, or with your separate permission.

So, for a PR touching those paths, one of three things happens, and we will tell
you which at review time rather than sitting on it:

1. **It is a bug fix or a small change** — we merge it and live with it. This is
   the usual outcome.
2. **We ask** whether you are willing to also license that specific patch to
   TrafficFlow for the Cloud client. You may say no, and "no" is a complete
   answer that costs you nothing.
3. **We reimplement it** if neither of the above works. You get the credit for
   the report and the design; we write the code.

If you want to avoid the question entirely, contribute to `apps/desktop`.
And if a large change is forming in your head, open an issue
first — that is true for the whole repository, and doubly so here.

[dco]: https://developercertificate.org/

## Conduct

Be direct, be technical, be decent. Harassment or discrimination gets you
removed from the repository, and there is no appeal process.

## Contact

Anything that does not belong in a public issue: **support@ohmail.app**.
Security reports go the way [SECURITY.md](SECURITY.md) describes — not into an
issue.
