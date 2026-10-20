# CLAUDE.md

Notes for coding assistants working in this repository. People: read [CONTRIBUTING.md](CONTRIBUTING.md)
first — everything here is said there or in the README, in the form an assistant reads.

## What this repository is

ohmail, an email client, under AGPL-3.0 ([LICENSE](LICENSE), [COPYRIGHT](COPYRIGHT)). The desktop app is
`apps/desktop` (Tauri: the Rust shell in `src-tauri`, the window in `src`). The server, the worker, the web app,
the phone app and the shared packages live in `apps/` and `packages/`; self-hosting and packaging recipes in
`deploy/`.

## Setting it up

The root is an npm workspace with one committed lockfile; `apps/desktop` carries its own and is installed
beside it. From the repository root, the steps CI runs:

```bash
npm ci
(cd apps/desktop && npm ci)
node scripts/apply-patches.mjs apply   # after both installs: it patches every installed copy
npm run build                          # tsc -b; tests read the compiled packages
node scripts/engine-bundle.mjs
node apps/mobile/scripts/bundle-engine.mjs
node scripts/bundle-host.mjs server
node scripts/bundle-host.mjs worker
npx playwright install chromium        # the layout tests render in it
```

The desktop app is checked on its own install:

```bash
cd apps/desktop
npm run ui:typecheck      # tsc over the shell, the views and the shim
npm run ui:build:engine   # the bundle the app embeds, into dist/
npm run smoke             # renders the built bundle and audits it offline
```

The toolchain is Node 22 and stable Rust; "Build the desktop app yourself" in the README has the platform
packages and the whole build.

## Tests and CI

Run the suites from the repository root:

```bash
docker compose up -d             # Postgres, GreenMail, RustFS, Dovecot for the *.pg.test.ts and mail tests
bash scripts/lane-db.sh "$PWD"   # this checkout's own database (.lane-db.env)
TF_REQUIRE_PG=1 npm test         # the root suite, apps/desktop/test included; without services it skips what needs them
npm run test:sqlite              # the files that also run on SQLite
npx vitest run $(node test/support/ci-shards.mjs --desktop)   # the desktop job: needs apps/desktop installed (npm test leaves its config importers out without it)
(cd apps/desktop/src-tauri && cargo test --locked && cargo test --locked --features local-engine)
```

One database across the whole suite leaves residue that the `@postpush: alone` files (`ci-shards.mjs --alone`)
fail over; CI runs the rest in 16 shards (`node test/support/ci-shards.mjs --shard N`), each on a fresh
database (`lane-db.sh --drop "$PWD"`, then create), and each alone file on a database made from empty.

The root suite resolves one copy of every dependency, the root's, whether `apps/desktop` is installed or not
(`vitest.config.ts`, held by `apps/desktop/test/one-react.test.tsx`). A test that fails on "Invalid hook call" means
that broke; never mock a component to get around it.

`ci.yml` runs the suite on pull requests, in shards, each on the root install with its own Postgres, GreenMail and
RustFS; its desktop job runs `ci-shards.mjs --desktop`'s files on both installs. `build.yml` runs on pull requests
and on `main`: on macOS, Windows and Linux it typechecks the window, builds the UI bundle and smokes it, runs the Rust tests in both configurations,
packages the app and opens what it built; its engine job bundles the engine on its own. `android.yml` builds the
phone app. On a pull request the platform jobs and the phone build run only when it changes what they build
(`.github/scripts/pr-build-scope.sh`); the engine jobs always run. `dco.yml` checks sign-offs and `guard.yml` refuses a fork's change to the workflows,
their tools or the push gate's baseline. A fork's pull request runs every job on GitHub's runners. Tests sit beside the code they cover: `apps/desktop/test`, and the
`*_tests.rs` files in `apps/desktop/src-tauri/src`. Add or extend a test for behaviour you change.

The phone app (`apps/mobile`) has two root commands: `npm run typecheck:mobile` and `npm run test:mobile`
(CONTRIBUTING.md, "Running the tests").

## Rules the suite enforces

- Colours and shadows come from `packages/tokens`, never hand-written in a view.
- No message is ever replaced by a "N more" placeholder.

## How a change reaches `main`

- Every change is a pull request against `main`, the maintainers' included. Nothing is pushed to `main` directly,
  by anyone, and a pull request is merged only once its required checks pass.
- Work on a branch of your fork and open the pull request from it, one change per pull request.
- Sign every commit (Developer Certificate of Origin, no CLA): `git commit -s`. The dco check asks each commit
  for a sign-off whose address is its author's or its committer's; `git rebase --signoff main` fixes a branch.
- Leave `.github/`, `scripts/` and `.gate/` alone: the guard check fails a pull request from a fork that changes
  them. Describe the change you need in an issue or in the pull request instead.

## Contributing

- Match the surrounding style; there is no formatter config to fight with.
- A change people notice brings its release note as `changelog.d/<slug>.md` (format in `changelog.d/README.md`);
  never edit `CHANGELOG.md`, the release bump folds the files into it. `node scripts/changelog-fold.mjs --check`
  checks them.
- Open an issue before a large change, and before any IMAP or sync change: that layer has a design that is not
  published yet.
- Security reports go the way [SECURITY.md](SECURITY.md) describes, never into an issue.
