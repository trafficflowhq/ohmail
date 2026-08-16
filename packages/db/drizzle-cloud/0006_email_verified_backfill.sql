-- SPLIT FROM `0023_email_verification` (single-journal era, migration 0023) — the CLOUD half:
-- the BACKFILL only. The column it writes, `users.email_verified_at`, is created by the mail
-- journal's `0020_email_verified_column`, which runs first.
--
-- This statement is here and not there because it READS `invites` — a Cloud table. That is
-- the seam rule for the whole split: a statement that DEFINES a shared object belongs to the
-- mail journal; a statement that READS a private table belongs to the cloud journal.
--
-- ══ THE BACKFILL IS A JOIN, NOT A BLANKET, AND THAT DISTINCTION IS THE POINT ═══════════════
--
-- The tempting backfill is `email_verified_at = created_at` for every existing row, on the
-- argument that "an invite delivered to an address already proves that address receives
-- mail". That argument is sound and it is the reason the invite path stamps this column at
-- creation — but it stopped covering the whole table the day public signup opened.
--
-- Three populations exist and only one of them has been proven:
--
--   1. **Invite-path accounts.** An operator minted an email-BOUND invite row and the code
--      was mailed to that address; consumption then matched the row's `email` against the
--      registering address inside the account-creating transaction. The address demonstrably
--      received mail and the registrant demonstrably read it. `invites.consumed_by_user_id`
--      is the durable record of exactly that, which is why it is the join key.
--   2. **Open-gate accounts** created between public signup going live and this migration.
--      Nothing whatsoever proved those addresses — that is the hole this closes, and it is
--      also precisely the population an attacker pre-registering other people's addresses
--      would occupy. Grandfathering them would ship the vulnerability as data.
--   3. **Bootstrap-code accounts.** That path is reachable only when the invite TABLE does
--      not recognise a code at all, and the static set is unbound, reusable and
--      non-expiring — it is bound to no address, so it proves nothing about one.
--
-- So (1) is backfilled and (2) and (3) are left `NULL`. The cost to a real person in (2)/(3)
-- is ONE click: the wizard's verify step reads this column and offers a resend. The cost of
-- the blanket alternative is that the gate this exists to feed would be satisfied, forever,
-- by every account that predates it.
--
-- `WHERE email_verified_at IS NULL` makes the backfill idempotent, so a re-run is a no-op
-- rather than a rewrite of timestamps.


UPDATE "users" AS u
   SET "email_verified_at" = u."created_at"
 WHERE u."email_verified_at" IS NULL
   AND EXISTS (
     SELECT 1 FROM "invites" i
      WHERE i."consumed_by_user_id" = u."id"
   );
