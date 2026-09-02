-- THE ROWS THE OLD WORKER WROTE AFTER 0083'S BACKFILL HAD ALREADY RUN.
--
-- ══ WHY A SECOND BACKFILL FOR A MIGRATION THAT ALREADY BACKFILLED ═══════════════════════
--
-- 0083 promoted every stood-down row to a connected reader and its header explains why: without
-- it "the feature ships with its entire existing population invisible". That statement ran when
-- the migration was applied. **The OLD worker went on running afterwards**, and the old worker can
-- express a stand-down in exactly one way — `status = 'disabled'` with an
-- `organized_elsewhere:*` reason — because that is the only encoding it knows. Every stand-down
-- it recorded between the migration and its own replacement landed in the shape 0083 had just
-- finished removing.
--
-- The result is a row that cannot heal itself. `loadEnabledMailboxes` filters `disabled` out, so
-- the row is off the roster; the new worker never looks at it; and nothing else writes the role.
-- It sits there, permanently, describing a model the product no longer has.
--
-- Measured in production before this migration: 15 connected organizers, 2 disabled organizers,
-- 1 disabled READER — and **zero connected readers**. The reader path this wave was built for had
-- never run on real data, and could not, because the only row in that state was excluded from the
-- roster that would have exercised it.
--
-- The same row carries the second inconsistency this fixes: `organizer_role = 'reader'` with
-- `organized_by_kind` and `organized_by_name` both NULL. The DTO contract says a null holder means
-- "this install organizes it, or nobody ever has", which directly contradicts `role = 'reader'` —
-- so a client rendering the reader banner has nobody to name. Parsing the kind out of the reason
-- is what makes the row describable, and it is the same `split_part` 0083 used.
--
-- ══ IT IS 0083'S STATEMENT, RE-RUN, AND THAT IS DELIBERATE ══════════════════════════════
--
-- Same predicate, same `split_part`, same `NOT EXISTS` guard — not a new rule. The guard is the
-- one 0083 recorded as "not hypothetical": `mailboxes_active_address_uq` is UNIQUE on
-- `(account_id, lower(address)) WHERE status <> 'disabled'`, so a stood-down row can have a live
-- sibling on the same address, and promoting it would violate the index and take the migration
-- down mid-deploy. A row with a live sibling is genuinely superseded and stays disabled.
--
-- `IS NOT NULL` on the reason is sufficient to mean `organized_elsewhere:*`, and that is a
-- property of the schema rather than an assumption: `mailboxes_disabled_reason_closed`
-- (0027) admits only the three `organized_elsewhere:*` values. So the two disabled ORGANIZER rows
-- in that census — a user's own disconnect, which carries no reason — are untouched by this
-- statement, which is the distinction 0083's header draws between a stand-down and a tombstone.
--
-- ══ WHAT IS DELIBERATELY NOT REPEATED: THE CONSENT STAMP ═══════════════════════════════
--
-- 0083 ran a SECOND statement giving every connected row `organize_consented_at`, on the ground
-- that "connecting a mailbox WAS the consent under the old copy". **That ground has since
-- expired.** `POST /mailboxes` now creates a consent-less reader on purpose — the mirror starts,
-- nothing is moved, and the agreement is asked for separately — so a row created after that
-- change has a NULL consent because nobody has agreed yet, not because the record is missing.
--
-- Stamping it here would assert an agreement that may never have been given, and the cost is
-- specific rather than theoretical: `organize_consented_at` is what the first-run derivation reads
-- to decide whether to SHOW the consent screen, so a false stamp skips the one screen that asks.
-- That is 0027's rule ("do not record an observation nobody made") and the same trade 0084 makes
-- about the AI answer. A promoted row therefore arrives as a reader that has not been consented
-- to, which is a state the product has a screen for.
--
-- ══ AND WHY THE WORKER DOES NOT ALSO HEAL THIS AT ATTACH ═══════════════════════════════
--
-- It was considered and rejected, because the producer is gone rather than merely quiet.
-- `markMailboxStoodDown` (`apps/worker/src/mailboxes.ts`) is the only demotion left and its own
-- comment records the change: *"This used to write `status: 'disabled'` plus the reason, and the
-- mailbox left the roster. A loser is now a READER"* — it writes `organizer_role` and leaves
-- `status` untouched. The sidecar's inline write does the same. So no code path in this tree can
-- produce the shape again, and a heal at attach would be a second writer of the promotion,
-- unreachable, untested, and competing with the gate for the same column. If a row in this shape
-- ever appears again it is evidence that a pre-0083 binary is running, which is a deploy fault a
-- silent self-heal would hide.
--
-- ══ COMPATIBILITY ═════════════════════════════════════════════════════════════════════
--
-- Data only — no column, no constraint, nothing to probe, so no `MAIL_SCHEMA_MARKERS` entry and
-- the journal tag does not move (`CLOUD_SCHEMA_MARKER_JOURNAL_TAG`'s own precedent for a data
-- backfill: it "genuinely has nothing to probe"). Deploy order is 0085 → API/worker, on the
-- ordinary rule rather than a hard requirement: an old binary reading a promoted row sees a
-- connected mailbox with a role column it already understands.
--
-- Idempotent: the predicate excludes what it has already fixed, so a replay writes nothing —
-- which matters because a real-Postgres test rewinds and re-migrates, and `openLocalDb` re-runs
-- this journal on every desktop launch.
--
-- ROLLBACK is not offered and is not needed: the rows this promotes were already meant to be in
-- this state by 0083, and reverting them would restore a row that no running code can serve.

UPDATE "mailboxes" AS m SET
  "status" = 'connected',
  "organizer_role" = 'reader',
  "organized_by_kind" = split_part(m."disabled_reason", ':', 2),
  "disabled_reason" = NULL
WHERE m."status" = 'disabled'
  AND m."disabled_reason" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "mailboxes" AS o
    WHERE o."account_id" = m."account_id"
      AND lower(o."address") = lower(m."address")
      AND o."id" <> m."id"
      AND o."status" <> 'disabled'
  );
