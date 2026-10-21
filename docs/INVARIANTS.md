# Invariants

ohmail holds a short list of promises that a change must never break: sensitive
mail stays out of automatic AI and the knowledge base, nothing sends without the
person's action, the sync contract converges, staff never see mail, and so on.
[INVARIANTS.tsv](INVARIANTS.tsv) splits each promise into the sub-claims a test
can assert, and names for each one the tests that hold it and the file that
records whether those tests have been seen to fail when the code they guard is
broken.

A test that has never been seen red can pass for the wrong reason. A row counts
as **bitten** only once its verdict file shows the test failing with the
deciding line mutated and passing again with it restored.

`test/invariant-table.test.ts` reads the table on every run of the suite
(`test/support/invariant-table.mjs` holds the rules below). A row that names a
test the suite no longer runs, or a verdict whose deciding line has changed,
fails it.

## Why these files

- **A TSV**: GitHub renders it as a table, a row is one line in a diff, and it
  reads with a tab split. This page sits beside it so the table stays data.
- **One JSON verdict per row**, in `docs/invariant-verdicts/<id>.json`: two
  pull requests that record different rows never touch the same file, and JSON
  needs no parser of its own.

## The columns

The header is exactly `id	claim	status	tests	verdict	waits`, tab-separated,
every field filled.

| Column | What it holds |
|---|---|
| `id` | The promise's number and a letter per sub-claim (`1a` to `11`); `junk` for the Junk-folder rule, which has no number. |
| `claim` | The sub-claim in one line, at most 160 characters. It never says more than its tests and the shipped code hold. |
| `status` | `bitten`, `not yet run`, `no test` or `out of tree` (below). |
| `tests` | The test files that hold the claim, relative to the repository root and separated by spaces; `-` when there are none. Every file must be one the suite runs. |
| `verdict` | Always `docs/invariant-verdicts/<id>.json`. |
| `waits` | `-`; `restatement` when the promise's wording is being restated and the claim may change; `scope` when part of the promise is enforced by code outside this repository. |

**Status:**

- `bitten`: the verdict file exists and is whole (below).
- `not yet run`: tests are named, no verdict has been recorded.
- `no test`: nothing in this repository asserts the claim yet.
- `out of tree`: the claim is held by code outside this repository, so no public
  test can name it. Such a row always waits on `scope`.

A verdict file exists exactly when its row is `bitten`, and the directory holds
no other file.

## The verdict format

```json
{
  "id": "4e",
  "base": "<the 40-hex main commit the run was taken on>",
  "recorded": "YYYY-MM-DD",
  "command": "npx vitest run packages/api/test/sync-seq-echo.test.ts",
  "tests": ["packages/api/test/sync-seq-echo.test.ts"],
  "arms": [
    {
      "file": "packages/api/src/routes/tags.ts",
      "line": "\"X-Sync-Seq\": String(seq) }",
      "to": "\"X-Sync-Seq\": String(Number(seq) - 1) }",
      "failed": 1
    }
  ],
  "green": { "failed": 0, "passed": 7 }
}
```

- The keys are exactly these seven. `tests` is a subset of the row's tests.
- Each arm is one mutation: in `file`, replace `line` with `to`, run `command`,
  and `failed` tests (at least one) went red. `file` is never one of the row's
  own tests, and `line` must occur exactly once in it.
- `green` is the same command with every arm restored: nothing failed, at least
  one test passed.

To check a verdict by hand: replace `line` with `to` in `file`, run `command`
and see it fail; restore the line and run it again.

**Freshness.** A later change that edits a guarded line leaves `line` absent
from its file, and the table test fails until the verdict is recorded again on
the new code or the row is set back to `not yet run`. A verdict names a commit
on `main`, so it is recorded after the change it covers has landed.
