# `packages/db-mail/drizzle` — the SHARED mail-domain migration journal

Migrations here are **hand-written**. `drizzle-kit` was removed in stage 3
when this journal was split out: its snapshots were already five migrations stale, and
leaving them would have made the first post-split `generate` emit `DROP TABLE` for the other
half of the schema. A missing snapshot is loud; a wrong one is silent.

## Adding a migration

1. Write the `.sql` by hand, separating statements with `--> statement-breakpoint`.
2. Append an entry to `meta/_journal.json` with `when` = a fresh `Date.now()` that is
   **STRICTLY GREATER than this journal's current maximum**. drizzle applies an entry only if
   `max(created_at) < when`, so an entry at or below the maximum is skipped FOREVER, silently.
   This journal's own test suite asserts the ordering; adoption's unique index on
   `created_at` turns a collision into a loud failure instead of a silent skip.
3. Keep the seam: no statement here may name a private table (billing, credits, invites, waitlist, the identity ceremony, ops). This journal must build a complete, working mail database on its own, first, against an empty database — that is what a local engine does.
   `journal-split.test.ts` enforces this over the folder's current contents on every run.
4. Prove it — `makeMailTestDb()/makeTestDb()` replays the journal, and one real-Postgres run
   through `journal-split.pg.test.ts` checks the catalog.
5. Mind the lock cost — the section below. A validating FK/CHECK or an index build on a
   growth table blocks writes for the whole scan, in the middle of a deploy.

## Lock cost on populated tables (the pg journals only)

The migrator replays a journal's whole pending set in ONE transaction (`drizzle-orm`'s
postgres-js migrator wraps the loop; `packages/db/src/concurrent-index.ts` records the same
fact from the index side), so a lock a journal statement takes is held to the end of the
pass. Two rules follow for every table that grows with mail or traffic — the growth tables
named by this repository's migration-lock-cost test, which enforces both rules over
every entry past its watermark, in this journal and the cloud one:

- **A FK or CHECK on a growth table is added `NOT VALID`**, and its `VALIDATE CONSTRAINT`
  ships as a follow-up migration in a LATER release. A validating `ADD CONSTRAINT` scans
  every existing row while its lock blocks writes; `NOT VALID` enforces the constraint for
  new writes from the moment it commits and skips the scan; `VALIDATE` scans under
  `SHARE UPDATE EXCLUSIVE`, which lets reads and writes continue. The two entries must
  apply in different deploy runs for the split to buy anything — a breakpointed `VALIDATE`
  in the same migration runs inside the same transaction as its `ADD`, which is why the
  follow-up is a separate journal entry, one release later. A catch-up run that applies
  both entries in one pass degenerates to the validating cost: the floor, never worse.
- **No index is built on a growth table here, unique or not.** `CREATE INDEX CONCURRENTLY`
  cannot run in the migrator's transaction (25001), and a plain build blocks writes for
  the whole build. It goes through a `ConcurrentIndexSpec` in
  `packages/db/src/hot-path-indexes.ts` instead — built `CONCURRENTLY` on the setup
  command's autocommit session, under the migration's own advisory lock. A `UNIQUE` or
  `PRIMARY KEY` constraint added by `ALTER TABLE` is the same index build by another
  spelling and follows the same rule.

pg only: SQLite has no `NOT VALID`, and `drizzle-sqlite/` rebuilds small local databases
where this cost class does not exist. The sqlite twin is out of the rule's scope and the
test does not read it.

### Retrospective — 0116, 0117, 0118 (shipped; a shipped migration is never edited)

0118 added 36 validating composite FKs and 14 unique indexes in one transaction; 0116
built `folder_state_desired_updated_idx` non-concurrently on one of the largest tables;
0117's `junk_rescues_locator_uq` is the constraint spelling of the same build. All three
are applied wherever this journal has run and are exempt by the test's watermark. At the
row counts they met, each passed in seconds; the same shape at ten times the rows is
minutes of blocked writes on `messages` and `sessions` in the middle of a deploy. That
measured shape is why the rule above exists — the remedy is the rule binding the NEXT
migration, never a rewrite of these three.

## A migration in here is DESTRUCTIVE-BY-DEFAULT the moment it carries DML

`0021_mailbox_address_unique` opens with a dedup prelude, and the review of it produced two
rules that are general rather than specific to that file:

- **A corrective migration cannot correct an earlier one for a database that has not applied
  it yet.** drizzle applies entries in `when` order, so anything appended here runs *after*
  `0021`, including on the database that still has the data `0021`'s prelude would destroy. A
  data-loss rule shipped in the journal is therefore not fixable by a later journal entry —
  only by something that runs BEFORE the migrator. That is
  `assertNoActiveAddressDuplicates` in `packages/db/src/mailbox-dedup.ts`, called by
  `runMigrations` before the mail pass.
- **A migration that resolves ambiguous data must not guess.** `0021` keeps the OLDEST
  duplicate, which is not evidence of health: an old row with dead credentials outranks the
  working replacement whose credentials the same statement then deletes. Prefer refusing and
  making a human look. `pnpm db:mailboxes:dedup` is that human's tool.

`0021`'s `lower(address)` key is also worth reading correctly: it is collation-dependent and
is not RFC canonicalization. `packages/services/src/mailbox-service.ts:canonicalAddress`
states both limits in full.
