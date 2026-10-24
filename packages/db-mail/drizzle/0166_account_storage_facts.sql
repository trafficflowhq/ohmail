-- 0166_account_storage_facts — what the storage counter knows, kept beside it and readable by staff.
-- `account_storage` held the byte count and when it last moved, so nobody could tell from it whether
-- ohmail had emptied any letter's text to stay under a plan's limit, since when, or whether the count
-- still matched the stored letters. Seven columns, written by the counter's own writers in the same
-- statement as the bytes (`packages/db/src/storage.ts`):
--   recounted_at, recount_drift   the last check against the stored letters, and counter minus real then
--   husked_for_space              letters whose text is not held for space now (`storage_cap`), CHECK >= 0
--   first_husked_at, last_husked_at   first and latest trim that emptied text; NULL is "not recorded"
--   kept_from                     the first day of the month after the newest letter the trim emptied
--   withheld_on_arrival           of those letters, the ones stored without their text because they
--                                 arrived while the storage was full, dated from kept_from on (all of
--                                 them while it is unset); a letter withheld on arrival never moves it
-- The count is filled from the letters already emptied; the two dates, the month and the arrivals
-- before this release are never made up.
-- The staff role reads the seven (counts, instants and a month, no content), guarded on the role
-- existing; `scripts/harden-staff-role.sql` §9 and `STAFF_SELECT_GRANTS` name the same columns.
-- LOCK-WAIT: a brief ACCESS EXCLUSIVE on account_storage (one row per account) for the columns and the
-- CHECK, then one grouped count of the `storage_cap` letters through message_bodies' withheld index;
-- ingest waits on the counter until the pass commits. In a pass with 0165, 0165 already holds the table
-- (SHARE ROW EXCLUSIVE) and writers queue without a lock on it, so this upgrade cannot deadlock with
-- them (migration-0165-0166-one-pass.pg.test.ts).
-- DEPLOY ORDER: migration, then API and worker, back to back: the new worker writes these columns, and
-- a cold API instance still on the old allowlist refuses staff reads once the role holds the new
-- columns, until the new API is up. A release that also carries 0165 migrates first too (0165 says so).
-- ROLLBACK: REVOKE SELECT (the seven) ON account_storage FROM ohmail_admin, then DROP the CHECK and the
-- seven columns.

ALTER TABLE "account_storage" ADD COLUMN IF NOT EXISTS "recounted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "account_storage" ADD COLUMN IF NOT EXISTS "recount_drift" bigint;
--> statement-breakpoint
ALTER TABLE "account_storage" ADD COLUMN IF NOT EXISTS "husked_for_space" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "account_storage" ADD COLUMN IF NOT EXISTS "first_husked_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "account_storage" ADD COLUMN IF NOT EXISTS "last_husked_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "account_storage" ADD COLUMN IF NOT EXISTS "kept_from" date;
--> statement-breakpoint
ALTER TABLE "account_storage" ADD COLUMN IF NOT EXISTS "withheld_on_arrival" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "account_storage" DROP CONSTRAINT IF EXISTS "account_storage_husked_nonneg";
--> statement-breakpoint
ALTER TABLE "account_storage" ADD CONSTRAINT "account_storage_husked_nonneg" CHECK ("husked_for_space" >= 0);
--> statement-breakpoint
UPDATE "account_storage" s
   SET "husked_for_space" = c."n"
  FROM (SELECT m."account_id", count(*)::integer AS "n"
          FROM "message_bodies" b JOIN "messages" m ON m."id" = b."message_id"
         WHERE b."withheld_reason" = 'storage_cap'
         GROUP BY m."account_id") c
 WHERE s."account_id" = c."account_id" AND s."husked_for_space" <> c."n";
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ohmail_admin') THEN
    GRANT SELECT (recounted_at, recount_drift, husked_for_space, first_husked_at, last_husked_at, kept_from,
      withheld_on_arrival) ON TABLE "account_storage" TO ohmail_admin;
  END IF;
END $$;
