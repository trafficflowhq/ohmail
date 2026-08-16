# `packages/db/drizzle-cloud` — the hosted-only Cloud migration journal

Migrations here are **hand-written**. `drizzle-kit` was removed in stage 3
when the journal was split: its snapshots were already five migrations stale, and
leaving them would have made the first post-split `generate` emit `DROP TABLE` for the other
half of the schema. A missing snapshot is loud; a wrong one is silent.

## Adding a migration

1. Write the `.sql` by hand, separating statements with `--> statement-breakpoint`.
2. Append an entry to `meta/_journal.json` with `when` = a fresh `Date.now()` that is
   **STRICTLY GREATER than this journal's current maximum**. drizzle applies an entry only if
   `max(created_at) < when`, so an entry at or below the maximum is skipped FOREVER, silently.
   `journal-split.test.ts` (this package's test suite) asserts the ordering; adoption's unique index on
   `created_at` turns a collision into a loud failure instead of a silent skip.
3. Keep the seam: no statement here may perform DDL on a shared table — that belongs in the mail journal, and leaving it here makes the mail schema incomplete on its own. READING a shared table is legal (every `REFERENCES public.accounts` is one). WRITING one is legal only when the statement also reads a private table, which today is `0006_email_verified_backfill` and nothing else.
   `journal-split.test.ts` enforces this over the folder's current contents on every run.
4. Prove it — `makeTestDb()` replays the journal, and one real-Postgres run
   through `journal-split.pg.test.ts` checks the catalog.
