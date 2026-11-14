# Pull requests the selector is held to

`test/ci-select.test.ts` plans each of these for a base of `main` and of `next`.

- `<pr>.tsv` is the pull request's diff: `git diff --name-status --no-renames <base> <head>`.
- `<pr>.trees.json` is there where the selector reads what changed and not only which path: the apps and
  packages the base holds (`base.dirs`), and both sides' text of each changed tsconfig, manifest and
  `vitest.config.ts` (`base.files`, `head.files`). The root lockfile is in it either way, as a reduced pair:
  an entry under `node_modules/` that is no workspace link and reads the same on both sides is left out
  of both, which changes nothing the selector decides.
- `<pr>.main.json` is the plan for a base of `main` on that pull request as a planted repository, written
  by the selector before `next` deferred any harness path. A change that moves `main`'s plan on purpose
  writes them again and says so: `CI_SELECT_RECORD_MAIN=1 npx vitest run test/ci-select.test.ts -t "to the byte"`.
