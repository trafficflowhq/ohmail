# CLAUDE.md

Notes for coding assistants working in this repository. People: read [CONTRIBUTING.md](CONTRIBUTING.md)
first — everything here is said there or in the README, in the form an assistant reads.

## What this repository is

ohmail, an email client, under AGPL-3.0 ([LICENSE](LICENSE), [COPYRIGHT](COPYRIGHT)). The desktop app is
`apps/desktop` (Tauri: the Rust shell in `src-tauri`, the window in `src`). The server, the worker, the web app,
the phone app and the shared packages live in `apps/` and `packages/`; self-hosting and packaging recipes in
`deploy/`.

## Setting it up

The root is an npm workspace with one committed lockfile:

```bash
npm ci
```

`apps/desktop` carries its own lockfile and is installed and checked on its own:

```bash
cd apps/desktop
npm ci
npm run ui:typecheck      # tsc over the shell, the views and the shim
npm run ui:build:engine   # the bundle the app embeds, into dist/
npm run smoke             # renders the built bundle and audits it offline
```

The toolchain is Node 22 and stable Rust; "Build the desktop app yourself" in the README has the platform
packages and the whole build.

## Tests and CI

The workflows are in `.github/workflows/`. `build.yml` runs on pull requests and on `main`: on macOS, Windows and
Linux it typechecks the window, builds the UI bundle and smokes it, runs the Rust tests in both configurations,
packages the app and opens what it built; its engine job bundles the engine on its own. `android.yml` builds the
phone app, `dco.yml` checks sign-offs and `guard.yml` refuses a fork's change to the workflows,
their tools or the push gate's baseline. Tests sit beside the code they cover: `apps/desktop/test`, and the
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
- Open an issue before a large change, and before any IMAP or sync change: that layer has a design that is not
  published yet.
- Security reports go the way [SECURITY.md](SECURITY.md) describes, never into an issue.
