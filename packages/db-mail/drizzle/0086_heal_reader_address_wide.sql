-- THE HEAL, RESTATED WITH THE GUARD IT SHOULD HAVE HAD — and a no-op on today's data.
--
-- ══ WHAT 0085 GOT RIGHT, AND THE ONE THING IT DID NOT ═══════════════════════════════════
--
-- 0085 promotes a stranded `disabled` + `organized_elsewhere:*` row to a connected READER with the
-- holder kind parsed out of the reason. That target shape is correct and is restated here
-- unchanged: a demoted install is a reader, it keeps reading, and the role is the record.
--
-- Its guard was not. `NOT EXISTS` was scoped `o.account_id = m.account_id`, written about
-- `mailboxes_active_address_uq` — `UNIQUE (account_id, lower(address)) WHERE status <> 'disabled'`
-- — rather than about the mailbox. A mailbox is an ADDRESS on somebody's mail server; two ohmail
-- accounts can hold rows for one address, the unique index permits it, and a per-account guard
-- cannot see it. Production had exactly that pair, with one of them stranded and therefore off the
-- roster, which is why nothing had noticed.
--
-- Promoting the stranded row put it back on the roster beside its twin. What followed is not a
-- fault in the statement — the hosted worker has ONE `organizerInstallId` for every account
-- (`apps/worker/src/index.ts`), so `decideLease` read `ohmail/_meta`, found its own claim, and
-- `clearOrganizerStandDown` flipped the row to `organizer`. The lease then arbitrated the pair
-- within about fourteen minutes and both rows are consistent again. **Nothing here undoes that**:
-- this migration does not touch a `connected` row at all, and which account organizes that mailbox
-- is the lease's to say and the product's to change.
--
-- ══ THE GUARD, WIDENED ═════════════════════════════════════════════════════════════════
--
-- `o.account_id <> m.account_id` is gone from nowhere and `o.account_id = m.account_id` with it:
-- the sibling test is now purely on the ADDRESS. A stranded row whose address is already served by
-- ANY connected row — same account or another — stays disabled, because promoting it is what
-- creates a second organizer for one mailbox.
--
-- That is strictly narrower than 0085: every row 0085 would skip, this skips too.
--
-- ══ IT IS A NO-OP ON TODAY'S DATA, AND THAT IS ASSERTED RATHER THAN HOPED ═══════════════
--
-- 0085 already healed what it could reach, so no `disabled` row with a reason and no live sibling
-- remains. The three rows this database actually holds for the affected address are two connected
-- ones — untouched, because the predicate requires `disabled` — and one disabled row carrying NO
-- reason, which is a user's own disconnect and is untouched because the predicate requires one.
-- `heal-reader-address-wide.pg.test.ts` seeds exactly those three and asserts none of them moves.
--
-- What this is FOR is every other database: a desktop self-migrating at launch, a restored backup,
-- a fresh clone. There the stranded shape may still exist, and there it now heals without the hole.
--
-- ══ COMPATIBILITY ══════════════════════════════════════════════════════════════════════
--
-- Data only: no column, no constraint, nothing to probe, so no schema marker and the journal tag
-- does not move — `health.test.ts` skips data-only entries by reading their statements. Idempotent:
-- the predicate excludes what it has already fixed, so a replay writes nothing, which every
-- desktop launch depends on.
--
-- ROLLBACK is not offered, for 0085's reason: the rows this promotes were meant to be in this
-- state, and reverting them restores a row no running code can serve.

UPDATE "mailboxes" AS m SET
  "status" = 'connected',
  "organizer_role" = 'reader',
  "organized_by_kind" = split_part(m."disabled_reason", ':', 2),
  "disabled_reason" = NULL
WHERE m."status" = 'disabled'
  AND m."disabled_reason" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "mailboxes" AS o
    WHERE lower(o."address") = lower(m."address")
      AND o."id" <> m."id"
      AND o."status" <> 'disabled'
  );
