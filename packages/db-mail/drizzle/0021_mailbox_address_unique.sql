-- ONE ACTIVE MAILBOX PER ADDRESS, PER ACCOUNT.
--
-- ══ THE DEFECT, REPRODUCED AGAINST A RUNNING DEPLOYMENT ═══════════════════════════════════
--
-- `POST /mailboxes` with an identical `address` twice answered 201 twice and left TWO rows.
-- Not a theory: it was driven against a running deployment and both rows were observed.
--
-- The obvious cost is billing — each row consumes a mailbox allowance slot, so a customer on
-- Solo can burn all five on one mailbox. The real cost is worse. `loadEnabledMailboxes`
-- rosters by ROW, so two rows for one physical mailbox attach
-- TWO IMAP runtimes to it: the same mail is ingested twice, and two `reconcileMailbox` passes
-- issue competing Screener moves against the same real folders. That brushes the invariant the
-- whole product rests on — exactly one active organizer per mailbox — and it does so in the
-- one place the user can see, their real folder tree.
--
-- The allowance gate takes `SELECT … FOR UPDATE` on the subscription row, so two CONCURRENT
-- creates at the limit admit exactly one. It says nothing about two SEQUENTIAL identical
-- creates, which is what was proved. Only a unique index can express "this row must not exist
-- twice", because the contended thing is the absence of a row and there is nothing to lock —
-- the same argument `0018_login_email_identity` makes for `users`.
--
-- ══ WHY PARTIAL: `WHERE status <> 'disabled'` ═════════════════════════════════════════════
--
-- `MailboxService.delete` is a SOFT delete: it sets `status='disabled'` and keeps the row,
-- because `messages.mailbox_id` references it and a hard delete would orphan real history. A
-- plain `UNIQUE (account_id, address)` would therefore make "disconnect a mailbox, then
-- reconnect the same address" fail forever against the tombstone — turning leave-anytime into
-- leave-once. The predicate scopes the constraint to rows that are actually claiming the
-- mailbox, and lets any number of disabled tombstones accumulate behind them.
--
-- ══ WHY `lower(address)` AND NOT `address` AS STORED ══════════════════════════════════════
--
-- `0018` deliberately indexed `users.email` as stored, reasoning that every write path already
-- lowercases so a functional index would add moving parts and disagree with login's
-- exact-match lookup. NEITHER HALF OF THAT TRANSFERS HERE, which is why this migration differs:
--
--   · No write path normalizes `mailboxes.address`. Both callers only `.trim()`. So without
--     `lower()`, `Foo@example.com` and `foo@example.com` are two rows and the constraint is
--     trivially sidestepped by the shift key.
--   · Normalizing on write is NOT the alternative, because this column is not merely a label:
--     it is the default IMAP username (`user: mbUser.trim() || address` in both connect
--     forms). Lowercasing a stored credential to satisfy an index could break a login against
--     a case-sensitive server.
--   · There is no exact-match lookup to disagree with. Nothing in the codebase queries
--     `where address = $1`; every read is by `id`, or a select/order for display.
--
-- ══ THE DEDUP PRELUDE ═════════════════════════════════════════════════════════════════════
--
-- `CREATE UNIQUE INDEX` fails outright if the data already violates it, so any existing
-- duplicate has to be resolved first or this migration bricks the deploy. Production was
-- checked before writing this and holds ZERO active duplicates, so the prelude is expected to
-- no-op there; it exists for any database that is not production, and because a migration that
-- only works on one database is not a migration.
--
-- KEEP THE OLDEST (`created_at, id`), disable the rest. Oldest because that is the row the
-- worker's roster already ordered first and therefore the one whose folder cursors are real;
-- the `id` tiebreak makes the choice deterministic when timestamps collide. Their credentials
-- are deleted alongside, exactly as `delete` does, so a disabled row cannot keep syncing.
--
-- ROLLBACK is `DROP INDEX` and is trivially safe. The prelude's UPDATE is not reversible, but
-- it only ever disables rows that violate the invariant being installed.

-- 1. Resolve any pre-existing violation, deterministically.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY account_id, lower(address)
           ORDER BY created_at, id
         ) AS rn
  FROM mailboxes
  WHERE status <> 'disabled'
),
losers AS (
  SELECT id FROM ranked WHERE rn > 1
),
_creds AS (
  DELETE FROM mailbox_credentials WHERE mailbox_id IN (SELECT id FROM losers)
)
UPDATE mailboxes SET status = 'disabled' WHERE id IN (SELECT id FROM losers);
--> statement-breakpoint

-- 2. And make it impossible from here on.
--
-- NO `IF NOT EXISTS`, deliberately, and it is a safety property rather than a style choice.
-- Migration bookkeeping already supplies idempotence: drizzle records this tag and never
-- replays it. What `IF NOT EXISTS` adds is a way to FAIL OPEN — if a relation of this name
-- already exists from a manual hotfix, and it is non-unique, or invalid, or built on a
-- different expression or predicate, Postgres emits a notice, the migration is recorded as
-- applied, and duplicate inserts keep succeeding with no 23505 and therefore no 409. Every
-- fresh-database test passes while the one database that matters is unprotected. A name
-- collision here is a fact somebody must look at, so it stops the deploy.
CREATE UNIQUE INDEX "mailboxes_active_address_uq"
  ON "mailboxes" ("account_id", lower("address"))
  WHERE "status" <> 'disabled';
