# Submitting ohmail to the official Umbrel app store

The package in [`ohmail/`](./ohmail/) is submission-ready: official-store shape
(app id `ohmail`, no store prefix), every image pinned `tag@sha256:…` with the
multi-arch index digest, and a clean run of the store repository's own linter.
Submission is a pull request to
[`getumbrel/umbrel-apps`](https://github.com/getumbrel/umbrel-apps). This file is the
exact ceremony.

## What is already verified — and what is not

Verified (2026-08-22):

- `ghcr.io/trafficflowhq/ohmail-{server,worker,web}:0.11.0` are public, multi-arch
  (linux/amd64 + linux/arm64) OCI indexes; the digests in `docker-compose.yml` are the
  index digests the registry reports for that tag.
- `npm run lint:apps -- ohmail --check-images` in a current `umbrel-apps` checkout:
  no issues. That check covers manifest shape, port conflicts across the whole store,
  image pinning, public pullability, multi-arch support, app_proxy wiring, and
  persistence paths.
- `docker compose config` resolves the stack end to end after `hooks/pre-start` runs
  (secrets generated, env files derived, Caddyfile rendered), in both the configured
  and the unconfigured state.

NOT verified: a run on a real umbrelOS device. The assumptions a first device run
must check are listed in [`README.md`](./README.md). If a device or an umbrelOS VM is
available, run the package through it before submitting — the store repository's
`umbrel-test-app` guidance (in its `.claude/skills/`) describes the expected test
pass: install, open, create state, restart, data survives. If not, say so in the PR
honestly; the reviewers test on hardware anyway.

## The ceremony

One block, from a machine with `gh` signed in. It forks the store repository, copies
the package, verifies it with the store's own linter, and opens the pull request:

```sh
set -euo pipefail
gh repo fork getumbrel/umbrel-apps --clone umbrel-apps-fork
cd umbrel-apps-fork
git checkout -b ohmail
cp -r ../ohmail/deploy/umbrel/ohmail ./ohmail
npm install && npm run lint:apps -- ohmail --check-images   # must be: no issues
git add ohmail
git commit -m "Add ohmail"
git push -u origin ohmail
gh pr create --repo getumbrel/umbrel-apps --title "Add ohmail" \
  --body-file ../ohmail/deploy/umbrel/pr-body.md
```

(Adjust the repository path if the checkout lives elsewhere. The PR body is the
committed [`pr-body.md`](./pr-body.md) beside this file — one source of truth, so the
text the reviewers read is the text this repository carries.)

Immediately after the PR exists, set its URL as `submission:` in
`ohmail/umbrel-app.yml`, commit, and push to the same branch — the manifest field is
supposed to point at the submission PR, which cannot be known a commit earlier.

Then attach to the PR: the app logo
(https://raw.githubusercontent.com/trafficflowhq/ohmail/main/docs/ohmail-icon.png —
larger renders exist and can be provided on request) and three to five product
screenshots. Do not commit any image into the package; the Umbrel team creates and
hosts the final store assets.

## Pull-request body

The body text lives in [`pr-body.md`](./pr-body.md). It states, honestly: what the
app is, the image provenance and pinning, the topology, the setup behavior including
the SSH settings-file edit and where it falls short of the store's browser-only
standard, every port the package claims and why, and exactly which testing has and
has not been performed. Keep it truthful over flattering — if the package changes,
the body changes with it.

## Rules that hold regardless

- Nothing in the package or the PR may claim the app is in a store until it is.
- The `version:` in the manifest and the image digests in the compose move together;
  a release wave that bumps the images re-pins both (see `docs/self-host/UMBREL.md`
  and the release workflow in the upstream repository).
- The package directory is copied VERBATIM into the fork — if a change is needed for
  the submission, it is made here first, so the store and this repository never
  disagree about what the app is.
