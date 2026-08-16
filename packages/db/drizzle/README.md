# `packages/db/drizzle` — the PRE-SPLIT journal, retained as evidence

**Do not add migrations here.** This folder is the single journal as it stood before the
stage-3 journal split cut it into a mail-domain half — the one the desktop engine runs
(`packages/db-mail/drizzle`) — and a hosted-only Cloud half (`packages/db/drizzle-cloud`).

It is kept, permanently, for two reasons and no others:

1. **It is the oracle.** `journal-split.pg.test.ts` (this package's test suite) migrates this journal into
   one database and the two new journals into another, then diffs the entire catalog. That diff
   is the only proof the surgery was faithful — a `(table, column)` probe cannot see a lost
   index, trigger or constraint, and those are where this schema keeps its money invariants.
2. **It is the baseline-adoption evidence.** A production database that ran this journal carries
   24 rows in `drizzle.__drizzle_migrations`. Because drizzle applies all pending migrations in
   ONE transaction, 24 complete rows *prove* all 24 files ran. That is what lets adoption mark
   the two new journals as already applied instead of replaying DDL over a live database.

Deleting this folder removes both. It will look like dead weight; it is not.

## Migrations are HAND-WRITTEN in this repository

`drizzle-kit` and its `meta/*_snapshot.json` files were removed in stage 3. They had already
been abandoned five migrations earlier — `0015` and `0019`–`0023` never had a snapshot, so the
newest was `0018_snapshot.json` while the journal was at `0023`, and `drizzle-kit generate` would
have re-emitted DDL for five migrations. Those five are hand-written and carry CHECK constraints,
triggers, a partial unique index and a deferred constraint-trigger pair that the generator cannot
produce. The split's own README files record the rest.

To add a migration, see the README in the journal you are adding to.
