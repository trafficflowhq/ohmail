# Repository guide for coding assistants

ohmail is an email client licensed under [AGPL-3.0](LICENSE). The web, desktop, phone, server
and worker live under `apps/`, shared code under `packages/`, and self-hosting and packaging
under `deploy/`. Read [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution process,
package boundaries and test instructions.

## Using coding assistants

Contributions made with automated coding assistants are welcome and encouraged. If you submit a
pull request or issue, you must understand and personally test what you submit, take responsibility
for it, and review any generated material before submitting.

## Setting it up

Use Node 22 and, for the desktop app's native shell, stable Rust. Run this from the repository
root in bash (Git Bash on Windows). The npm workspace and the desktop app each have an install.

```bash
npm ci --ignore-scripts
(cd apps/desktop && npm ci --ignore-scripts)
node scripts/apply-patches.mjs apply
npm run build
node scripts/engine-bundle.mjs
node apps/mobile/scripts/bundle-engine.mjs
node scripts/bundle-host.mjs server
node scripts/bundle-host.mjs worker
npx playwright install chromium
```

Keep this block in sync with the install block in CONTRIBUTING.md and its workflow. The
contributor-route test checks that the commands agree.

## Testing changes

- Run focused tests from the root with `npx vitest run <test-files>`. Add or extend a test
  for changed behaviour and verify that a regression test fails before the fix. Test through
  public interfaces and accessible controls. Keep existing assertions and test coverage.
- Follow [Running the tests](CONTRIBUTING.md#running-the-tests) for the full suite, local
  services and isolated databases. Use real Postgres to verify Postgres transactions,
  constraints and concurrency. Use `npm run test:sqlite` to verify the device store.
- PGlite passing is no evidence for transactional code; a guard counts only once it has been
  seen failing.
- The root suite uses a single copy of each dependency, even with the separate desktop
  install. Diagnose an invalid hook call as a dependency resolution issue.
- For desktop changes, run `npm run ui:typecheck`, `npm run ui:build:engine` and
  `npm run smoke` from `apps/desktop`. For mobile changes, use
  `npm run typecheck:mobile` and `npm run test:mobile` from the root.

## Changing code

- Keep the implementation simple and reuse the existing owner of the behaviour. Preserve
  account isolation, error handling, stored data formats and operator-facing names.
- Follow the [package boundaries](CONTRIBUTING.md#the-next-major-version-next). Import from
  the narrowest intended entry point and keep app dependencies pointing toward shared packages.
- Use `packages/tokens` for visual values. Add whole user-facing strings in English and German
  together. The web catalogues live under `apps/webapp/messages/` and the mobile catalogues are
  `apps/mobile/src/copy.en.ts` and `copy.de.ts`. Keep each message visible as its own item.
- Keep one active organizer per mailbox and use the established sync paths. Open an issue
  before a large change or before changing IMAP or sync behaviour.
- Use local test services and fixture data. Keep credentials and private mail out of
  changes, logs and reports.

## Submitting work

Target `next` for the next major version and `main` for fixes to the released version. Use a
pull request from a branch and sign off each commit with `git commit -s`. Follow
[CONTRIBUTING.md](CONTRIBUTING.md#pull-requests) for maintainer-owned paths, font files and
release notes, and [SECURITY.md](SECURITY.md) for security reports.
