-- PROOF THAT AN ADDRESS IS REAL AND BELONGS TO ITS ACCOUNT (migration 0023).
--
-- The mail service built the whole verification mechanism (`issueEmailVerification`,
-- `consumeEmailVerification`, the hashed `purpose='email_verify'` token) and deliberately
-- stored NO user state, on the stated grounds that "there is no `users.email_verified_at`
-- column and adding one belongs to the slice that actually opens registration". Registration
-- is open. This is that column.
--
-- ══ WHY IT IS ON `users` AND NULLABLE ═════════════════════════════════════════════════════
--
-- The address IS the login identity (`users_email_unique_idx`, migration 0021), so the proof
-- belongs on the row the identity lives on — not on `accounts`, which can outlive a user row
-- and has no address of its own.
--
-- NULLABLE rather than `NOT NULL DEFAULT false`, because the column stores WHEN the proof
-- arrived and not merely whether it did. A boolean would have answered the gate and nothing
-- else; a timestamp also answers "how long has this account been able to spend money", which
-- is the question any later abuse investigation actually asks. `NULL` means unproven, and
-- nothing ever writes it back to `NULL` — verification is monotonic (`COALESCE` on write).
--
-- ══ THE BACKFILL IS A JOIN, NOT A BLANKET, AND THAT DISTINCTION IS THE POINT ═══════════════
--
-- The tempting backfill is `email_verified_at = created_at` for every existing row, on the
-- recorded argument that "an invite delivered to an address already proves that address
-- receives mail". That argument is sound and it is the reason the invite path stamps this
-- column at creation (see `AuthService.register`) — but it stopped covering the whole table
-- the day public signup opened the gate.
--
-- Three populations exist in production right now and only one of them has been proven:
--
--   1. **Invite-path accounts.** An operator minted an email-BOUND invite row and the mailer sent
--      the code to that address; `consumeInvite` then matched the row's `email` against the
--      registering address inside the account-creating transaction. The address demonstrably
--      received mail and the registrant demonstrably read it. `invites.consumed_by_user_id`
--      is the durable record of exactly that, which is why it is the join key.
--   2. **Open-gate accounts** created in the window between public signup going live and
--      this slice. Nothing whatsoever proved those addresses — that is the hole this slice
--      exists to close, and it is also precisely the population an attacker pre-registering
--      other people's addresses would occupy. Grandfathering them would ship the vulnerability
--      as data.
--   3. **Bootstrap-code accounts** (`cfg.inviteCodes` / `TF_INVITE_CODES`). That path is
--      reachable only when the invite TABLE does not recognise a code at all, and the static
--      set is unbound, reusable and non-expiring — it is bound to no address, so it proves
--      nothing about one. The very first accounts created are in this population.
--
-- So (1) is backfilled and (2) and (3) are left `NULL`. The cost to a real person in (2)/(3)
-- is ONE click: the wizard's verify step reads this column through `GET /auth/session` and
-- offers a resend. The cost of the blanket alternative is that the gate this migration exists
-- to feed would be satisfied, forever, by every account that predates it.
--
-- `WHERE email_verified_at IS NULL` makes the backfill idempotent, so a re-run (or a
-- `db:setup:prod` against a database that already took this migration) is a no-op rather than
-- a rewrite of timestamps.
--
-- ROLLBACK is `DROP COLUMN`: no code that predates this migration reads the column, and the
-- gate that does fails closed (an absent column makes the marker probe answer
-- `503 schema_incomplete` — see `SCHEMA_MARKERS` in packages/api/src/routes/health.ts — rather
-- than silently treating every account as verified).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email_verified_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "users" AS u
   SET "email_verified_at" = u."created_at"
 WHERE u."email_verified_at" IS NULL
   AND EXISTS (
     SELECT 1 FROM "invites" i
      WHERE i."consumed_by_user_id" = u."id"
   );
