# tools

The repository's four tools on `next`, and the data they read: the linter with the import borders (ESLint), the
style linter (stylelint), the formatter (Prettier), and the checks around the type build. One runner starts them
all:

```bash
node tools/check.mjs --base origin/next   # everything; npm run check:tools adds the controls
node tools/check.mjs --controls           # every rule refuses its planted violation
npm run lint                              # every finding, raw: file, rule, message
npm run format                            # formats the new tree
```

CI runs the first two in the `typecheck` job, the baseline read against the run's base.

## What binds which files

| Rule                                                                                                                                  | Binds                                                    | Data                                                |
| ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------- |
| `ohmail/package-borders`: a file imports only what its folder's row names; an app is never imported                                   | every file                                               | `borders.json`                                      |
| `ohmail/declared-dependency`: a file imports only what its `package.json` declares                                                    | every file                                               | the manifests                                       |
| `ohmail/platform-name`: a hosting platform's package or environment name stands only in a door file                                   | every file                                               | `doors.json`                                        |
| `ohmail/no-config-comment`: no comment sets a lint rule (`/* eslint rule: off */`)                                                    | every file                                               |                                                     |
| `ohmail/wire-exports-no-value`                                                                                                        | `packages/wire`                                          |                                                     |
| size (400 lines a file, 120 a function), hook dependencies, browser globals, no web framework, no empty `catch`, no switched-off rule | the new tree, per folder (`eslint.config.mjs`)           | `new-tree.txt`                                      |
| token values only, the kit's class prefix, no bare element selector, no width in a feature                                            | the stylesheets of the new tree (`stylelint.config.mjs`) | `new-tree.txt`                                      |
| formatting                                                                                                                            | the new tree                                             | `new-tree.txt`, `.prettierignore` (written from it) |

`borders.json` is keyed by folder. A package's row lists the packages it may import; `typesOnly` are taken with
`import type` alone. An app may import any package its manifest declares except its `never` list. A test file
obeys its folder's row, plus `tests.alsoImport`. A folder under `apps/` or `packages/` without a row is refused:
a new package brings its row in the pull request that creates it.

`doors.json` names the platforms the rule looks for (each with its packages and the prefixes of its environment
names) and the short list of files that may name one, each with its platform and its reason. Without either list
every file is refused. A listed file that names no platform is refused, so the list only shrinks. A new door is
a row with a reason, in a pull request that says what replaces the platform's feature on a plain server.

`new-tree.txt` lists the folders written for the next major version. Code that came over from 1.0 is not
reformatted or relinted here; its turn comes after the released line has ended.

## The baseline

`baseline.tsv` holds the violations the tree had when a rule arrived: one row per file and rule, with the count
and the task that removes it. A border row also names the package the import reached
(`ohmail/package-borders:db`), so one crossing cannot stand in for another. The check keeps it an exact mirror of the tree:

- a violation beyond its row is refused;
- a row beyond the violations is refused as stale, so the change that fixes a file edits its row;
- a row without a task is refused;
- against the base branch, no rule's count may grow for any task. A file that moves takes its row along.

So a new violation cannot be added to the baseline. Nor is a rule switched off in a file: a finding under an
`eslint-disable` comment counts like any other, a comment that sets a rule is refused in every file, and the
linter reads `eslint.config.mjs` alone (another `eslint.config.*` beside it is refused).
`node tools/check.mjs --write-baseline` rewrites the counts after a fix (it never names a task for a new row),
`--by-task` prints the counts per task, `--list <rule>` every finding of one rule. A row that no planned task
removes yet carries `unassigned`, until someone names its task.

`--retirement`, `--references` and `--coverage` run one part of the check alone: the retirement table, the
type build's reach, and the border rule's reach over every source file.

## The controls

`plant/controls.json` holds one planted violation per rule, and a clean file per rule. `--controls` writes them
into a copy of `HEAD`, never into the tree, runs the tools on the planted paths and refuses unless every rule
refused its violation and passed its clean file. A rule that is switched on without a control is refused, and
`docs/tool-verdicts/` keeps each rule's record (`--controls --write-verdicts <base>` rewrites it).

## The retirement table

`retirement.tsv` has a row for every test file that reads a file, by a call of its own or through a helper (a
module under a test folder that is no test, reached by its local imports): what it reads, its kind, the rule or
test that takes its place (`home`), the task that retires it, and the verdict once it has been retired. The check
refuses

- a test file that reads a file and has no row;
- a row that reads source as text and names no home;
- a row that does not say what the file reads;
- a deleted test file whose row carries no verdict.

What a `home` says:

| Home                                                | What takes the file's place                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `ohmail/package-borders`                            | the import borders: a package imports what its row names, and an app is never imported                       |
| `bundle contents`                                   | the check of what the phone engine's bundle contains, read from the bundle's own list of modules             |
| `stylelint:declaration-property-value-allowed-list` | the style linter's rule that a value is a token                                                              |
| `type: …`                                           | a type: the API's mail adapter has no verb that moves mail; a metered act cannot be written without its cost |
| `test on real Postgres: …`                          | a test that tries to read across accounts on a real Postgres                                                 |
| `lint rule: …`                                      | a lint rule that is not written yet, named by what it refuses                                                |
| `layer 1`                                           | a behaviour test at the unit's own door                                                                      |
| `layer 2`                                           | a journey: a path a person walks, found by role and name                                                     |
| `layer 5`                                           | a check of a built thing or a data file                                                                      |
| `none`                                              | nothing: the file reads data or what was built, and stays                                                    |

`artifact` and `data` rows are checks of what is built or shipped as data; they stay. A `source-text` row waits
until its home has refused a planted violation. No test file is retired by having a row.

## Adding a rule

Switch it on in `eslint.config.mjs` or `stylelint.config.mjs`, add its planted violation and its clean file to
`plant/controls.json`, run `--controls`, and give each violation the tree already has a row with its task.
