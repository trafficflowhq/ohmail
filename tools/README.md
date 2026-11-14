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
| `ohmail/owner-lookup`: only a host's file reads whose storage this is                                                                 | product code, tests aside                                | `owner-readers.json`                                |
| `ohmail/binder-callers`: only a listed file names a function that binds a database handle to an account or to none                    | product code, tests aside                                | `binders.json`                                      |
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

`owner-readers.json` lists the files that may import the storage owner's readers and setters (`storageOwner`,
`storageOwnerState`, `setStorageOwner`, `setDemoStorage`, `resetStorageOwnerForTest`), the session's marker's readers
and its cookie's name (`readOwner`, `readOwnerMarker`, `readOwnerCookie`, `OWNER_COOKIE`) or the web session client's
answers of the account it speaks for (`boundApiOwner`, `apiOwnerBinding`; on the desktop a stub answers nobody), each
group with an id and its reason: a host names the storage owner for its window and reads back what it named, and
everything a frame draws takes its scope from its mount. The rule reads the import, so a renamed one, a namespace, a
whole re-export, a dynamic import and a require are refused alike, by any specifier that reaches the three modules or
the storage door (a folder's path with a slash at its end, the door's index and the web app's `@/` among them). The
rule binds product code, the web app's root files and its `i18n` folder among it. A listed file reads them itself: an
export that hands one it imported straight on (the lookup under any name, as the default too, or a function whose
whole body returns one call of it) is refused, unless that export stands in the rule's own table of lookups. Helpers
are not followed: an unexported function that calls a lookup for an export is intent, which a review reads. The
marker's cookie name spelled in a string, a template or a regular expression is a lookup too, so the marker is not
read by hand out of the jar; it stands only in a listed file, or in a file of its own list (`markerNameSpellers`) that
spells it and imports none of the lookups. Shared code does not reach any of the shell's own globals by the global
object's name either (`no-restricted-properties`; a cast of the global object is not read). Without the host reader list every file is refused. A listed file that imports or spells none of the lookups is refused.

`new-tree.txt` lists the folders written for the next major version. Code that came over from 1.0 is not
reformatted or relinted here; its turn comes after the released line has ended.

## The old shell's side of the frame

Every host entry is checked against `retained-shell.txt`. Its runtime imports can reach the listed shell helpers. An import of an old view or an unlisted shell helper reports the entry and the file it reached. The retained list only shrinks. Run `node tools/check.mjs --host-shell --base origin/next` to check it on its own.

## The baseline

`baseline.tsv` holds the violations the tree had when a rule arrived: one row per file and rule, with the count
and the task that removes it. A border row also names the package the import reached
(`ohmail/package-borders:db`), so one crossing cannot stand in for another. The check keeps it an exact mirror of the tree:

- a violation beyond its row is refused;
- a row beyond the violations is refused as stale, so the change that fixes a file edits its row;
- a row without a task is refused;
- against the base branch, no rule's count may grow for any task. A file that moves takes its row along.
  Within one task, a crossing may pass between `ohmail/package-borders:<unit>` and `ohmail/declared-dependency`
  in the same file without being growth, as long as the file's sum over those rules does not grow. Where that
  sum grew, each rule is judged as above, and so is the sum against what other files' sums lost.
- a row whose task is `ruling:<id>` stands by a written ruling named in the change's message: it is
  not judged for growth, and what it lost or took over pays for no task's growth. Every run with a base prints one
  line per ruling id, its findings and rows now and at the base, so a waiver is seen to shrink.

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
test that takes its place (`home`), the task that retires it, and the proof once it has been retired (the column
keeps its name, `verdict`). A test that reads no file has no row until it leaves; then its row has the kind
`behaviour`. The last column takes one of four forms:

| Last column                                                    | When                                                                                                       | `home`                  |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------- |
| a file under `docs/tool-verdicts` or `docs/invariant-verdicts` | a lint rule took its place, or a migration removed its subject from a store and a named test goes red      | the rule or the test    |
| `held:<test>#<case title>`                                     | another test holds what it asserted: the old test's fault planted, that case seen red, then green restored | the layer and the plant |
| `gone:<path>`                                                  | the change deleted its subject, a source file, from the tree                                               | `none`                  |
| `gone:<path>#<text>`                                           | the change took a piece out of a file that stays                                                           | `none`                  |

Each is read in words: it begins with `held:` or `gone:`, the first `#` ends the path, and what follows it is
kept as written, upper and lower case, no pattern. The check refuses

- a test file that reads a file and has no row;
- a row that reads source as text and names no home;
- a row that does not say what the file reads;
- a last column of any other form, and `gone:`, `held:` or the kind `behaviour` on a test file that is still there;
- `gone:` with a home other than `none`, on a path that is a test or lies under a folder named `test`, or on a
  file that is still in the tree (with a piece: a file that still contains it), on every run;
- `held:` with the home `none`;
- a test file the change deletes without a row and a proof; with `gone:`, a path the base did not have or a
  piece the base's file did not contain; with `held:`, a test that is not in the tree or does not contain the
  case title as written.

A case removed from a test file that stays has no row: the table's grain is the file.

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

## The older tests

On `next`, the shell the app had before the new frame is not kept alive: each place is mounted on the new shell
and today's view of it leaves in the same pull request. The tests written against today's shell are sorted once,
by one checklist, `old-tests.tsv`: a test that states what a person meets is the specification, is pointed at the
new part and kept green; a test that only draws a view that leaves goes with it, its behaviour's new holder named
and seen green first. `never-red.tsv` lists the cases that are never left red: what files, trashes, sends or takes
back mail, the remote pictures' consent, a person's unsent words, sign-in and the account's scope.

`old-tests.tsv` has one row a test file, or, where a file's cases differ, one row a case and then every case:

| Column   | What it holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `file`   | the test file, or `<file>#<case>`: the describes' titles and the case's own, joined by `>` with a space each side, each as written between its quotes (a loop's or a table's case once, by its template: `` `${verb} files` ``, `moves %s`; a title that is no literal, as the expression)                                                                                                                                                                                                                                                                                                                                                                       |
| `class`  | `behaviour` (a person meets it), `markup` (an old view's markup alone), `census` (it reads source as text), `gap` (today's shell has it and the new part does not)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `holder` | `KEPT`: the test file, or `<file>#<case>`, that holds it; `RETIRED`: the `<file>#<case>` that holds it now; `WAITS`: the mount that will (`mount-lists`, …) or the switch's commit (`switch-ohbox`, `switch-write`, …), alone or followed by `: ` and what it is handed in one line (a ruled answer: kept, re-pointed, or the view it retires with and the case that holds what a person still meets); `GAP`: what is missing, in one line. A behaviour or a look that a named ruling dropped and nothing replaces is held by the ruling: `dropped: <ruling>` (a `RETIRED` row's whole holder, a `WAITS` holder's last part after `: `), never on a `census` row |
| `share`  | the census's share that sorted it, two digits                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `state`  | `KEPT`, `RETIRED`, `WAITS:<what it waits for>` (a place id, `pane:<id>`, `stage:<id>`, `reader`, `ground` or `calendar`), `GAP:<owner>` (a mount, the switch or its commit, `kit`, or `dispatcher` for a product decision)                                                                                                                                                                                                                                                                                                                                                                                                                                       |

The switch's commits, in their order: `switch-contract` (what a place's model takes, the mail's supplies, the
frame's changes), `switch-tests` (the keys' table and the hostile sequences, written red first), `switch-ohbox`
(the Ohbox's own seat), `switch-reader` (the reader's parts from the ground), `switch-write` (Write and the
reply), `switch-feeders` (the keys, the notices, the restart hold, the boot duties), `switch-way-out` (Settings'
Account pane), `switch-entries` (the hosts' entries hand the new shell), `switch-deletions` (today's composition
leaves), `switch-rows` (the rows of the test files whose subject left).

`never-red.tsv` has one row a case: `test` (the older `<file>#<case>` that states it today, or `none`), `act`
(`FILE`, `TRASH`, `UNDO`, `SEND`, `UNSENT`, `PICTURES`, `SIGNIN`, `SCOPE`), `place` (what it is met at, as a
`WAITS` names it), `holder` (its case at the new part, or the mount that will hold it) and `states` (the promise,
in one line).

What is mounted is read from the tree as text, never run: the places of the record `SEATED` in
`packages/app/src/mail/places.ts`; the stages and the Settings panes the mail entry hands (a record typed
`FrameStages` or `SettingsPanes`, or handed to `settingsPlace`), each entry that is not `NONE`; and what
`packages/app/src/mail/supplies.ts` hands beside them (`reader`, `above` as `ground`, `calendar`). A file of these
that is not in the tree mounts nothing of its kind, and the check says so in one line. The hosts' entries (the
web's route files, the desktop's window, the paired page, the phone's routes and page) are followed through
every import by value, through the workspace's packages by their `exports`.

`node tools/check.mjs --old-tests [--base <rev>]` reads the checklist alone; the whole check (`--base <rev>`, as CI
runs it on every pull request) reads it too. It refuses

- against the base's two lists: a row that is gone (a row never leaves: a file or case that goes is `RETIRED` by its
  row; a whole file's row may only give way to its case rows), and a never-red row that is gone (it leaves only
  with an act a named ruling dropped, its case's row `RETIRED`);
- a test file in scope without a row: it names `app/shell/` or `app/views/` (or the two segments handed to a join),
  comments aside, or imports a helper under a test folder that does, at any depth, or its imports by value reach,
  through any module, a file that leaves with the switch (`--old-tests --scope` prints them);
- a row of a file that is not in the tree unless it is `RETIRED`, its holder a case that stands by name and its
  proof in `retirement.tsv`; a `RETIRED` row of a file or case that is still there; a holder written `it.todo`,
  `it.skip`, `it.fails` or `test.fixme`, or under a skipped describe (a case run on a condition, `skipIf` or
  `runIf`, stands where its condition holds);
- a `WAITS` row for anything a host's entry mounts;
- a `KEPT` row whose test runs anything that leaves with the switch (a view, today's composition and feeds, the
  first run's old files) or imports a part of the app that no host's entry reaches: it `WAITS`;
- a never-red case whose place is mounted while its row is `WAITS` or `GAP`, or its holder is still a mount; a
  never-red case without its own row (a file with one is sorted case by case); a never-red case classed `markup`;
- a file with a whole row and case rows; a file sorted case by case with a case that has no row, or a row naming a
  case the file does not hold; a class, state, share or holder out of its form, a `WAITS` whose holder does not
  mount what it waits for, `markup` that is `KEPT`, a `gap` that is not `GAP` (and the other way round); rows out
  of order or not five columns.

## Adding a rule

Switch it on in `eslint.config.mjs` or `stylelint.config.mjs`, add its planted violation and its clean file to
`plant/controls.json`, run `--controls`, and give each violation the tree already has a row with its task.
