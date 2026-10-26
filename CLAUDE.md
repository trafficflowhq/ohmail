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
beside it. From the repository root, in bash (Git Bash on Windows), CONTRIBUTING.md's install block, which
`.github/workflows/contributor.yml` runs weekly on a fresh clone (`test/contributor-route.test.ts` holds the marked
blocks and the workflow equal, and this block equal to that one):

```bash
npm ci --ignore-scripts                # no dependency's install script, as in every CI install
(cd apps/desktop && npm ci --ignore-scripts)
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
npm test                         # the root suite, apps/desktop/test included; without services it skips what needs them
docker compose --profile condstore up -d --wait   # Postgres, GreenMail, RustFS, and Dovecot (only under the profile)
bash scripts/lane-db.sh "$PWD"   # this checkout's own database (.lane-db.env)
TF_REQUIRE_PG=1 npx vitest run <files>   # the files you changed, on it
npm run test:sqlite              # the files that also run on SQLite
npx vitest run $(node test/support/ci-shards.mjs --desktop)   # the desktop job: needs apps/desktop installed (npm test leaves its config importers out without it)
(cd apps/desktop/src-tauri && cargo test --locked && cargo test --locked --features local-engine)
```

One database across the whole suite leaves residue that the `@postpush: alone` files (`ci-shards.mjs --alone`)
fail over, so `TF_REQUIRE_PG=1 npm test` is red; CI's whole run runs the rest in 16 shards (`node test/support/ci-shards.mjs
--shard N`), each on a fresh database (`lane-db.sh --drop "$PWD"`, then create), and each alone file on a database
made from empty. CONTRIBUTING.md's `suite-services` block is that route in one loop; contributor.yml's Linux suite
jobs run it in two parts (`PART`/`PARTS`, every second shard each), its macOS and Windows ones run `npm test --
--shard` in two and four. The serial suite outruns one job's timeout on Windows.

The root suite resolves one copy of every dependency, the root's, whether `apps/desktop` is installed or not
(`vitest.config.ts`, held by `apps/desktop/test/one-react.test.tsx`). A test that fails on "Invalid hook call" means
that broke; never mock a component to get around it.

`ci.yml` runs the whole suite nightly, by dispatch, on a batch branch (`pr/batch-*`), on a fork's or a bot's pull request
and on one that touches the harness (dependencies, tsconfigs, `vitest.config.ts`, `test/setup`, the shard maps, ci.yml,
migrations, a deleted module), in shards, each on the root install with its own Postgres, GreenMail and RustFS. Any other maintainer's
pull request runs only the test files its diff can reach (`.github/scripts/ci-select.mjs`: vitest's module graph, the
files that read a changed path or a module whose imports reach it, or scan its app or package or the whole tree, root `test/`), in as few jobs as their measured time needs; the plan job's summary says
which run it is and why, and `main` is proven whole by the batch and the nightly. Its desktop job runs
`ci-shards.mjs --desktop`'s files on both installs, on every run. `build.yml`'s platform jobs, on macOS, Windows
and Linux, typecheck the window, build the UI bundle and smoke it, run the Rust tests in both configurations,
package the app and open what they built; its engine jobs bundle the engine on their own, on every pull request and
every push to `main`. `android.yml` builds the phone app and `selfhost-smoke.yml` boots the self-host images built
from the tree. GitHub's hosted runners are one pool for the whole organisation, so a maintainer's pull request runs
`ci.yml` and the engine jobs on the maintainers' own runners (where `ci.yml`'s header says) and `dco.yml` and
`guard.yml` on GitHub's, and nothing else. The platform jobs, the phone build and the self-host smoke run on a batch
branch, the release bump (`pr/release-<NNNN>-bump`), a fork's or a bot's pull request (only when it changes what they
build, `.github/scripts/pr-build-scope.sh`), a tag, the nightly and a dispatch. `dco.yml` checks sign-offs and `guard.yml` refuses a fork's change to the workflows,
their tools or the push gate's baseline. `contributor.yml` (weekly, and by dispatch; no pull request) runs the marked
blocks of the READMEs and CONTRIBUTING.md on a fresh clone on Linux, macOS and Windows. A fork's pull request runs every job on GitHub's runners. Tests sit beside the code they cover: `apps/desktop/test`, and the
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
