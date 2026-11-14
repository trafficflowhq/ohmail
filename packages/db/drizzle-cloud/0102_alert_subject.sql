-- AN ALERT ROW POINTS AT THE ACCOUNT IT IS ABOUT (cloud 0102). Four alert kinds are raised per
-- subject and carry the subject's id inside `alert_key`: a session family revoked for reuse and a
-- replayed refresh name an account, a stale device names a device, a stale session names a
-- session. An erasure could not find such a row without parsing every key. `subject_account_id` is
-- that account, filled here for the rows that stand and written by the alert pass from now on.
--
-- A pointer, not ownership: no key onto `accounts` and the name does not say `account_id`, so the
-- table stays what it is, the operations' own, read by the pager and the console and never by an
-- account's request. Nothing is deleted here; a row whose subject is gone keeps an empty pointer.
--
-- The staff role writes this table (the API host's alert pass runs on it) and an insert names
-- every column, so the role is granted the new one in the three verbs it holds on the others. It
-- equals `scripts/harden-staff-role.sql`'s `alert_state` stanza. Guarded on the role existing; the
-- role name is unquoted for cloud 0049's reason.
--
-- Servers only. Part of the 2.0 transition's window: applied once, by one transaction, on a store
-- nothing else writes to (`packages/db/src/transition/`). A store made from empty takes it as an
-- ordinary entry.
--
-- ROLLBACK: none in place. The transition rolls back whole; after it, a store is restored from
-- its copy.
-- @alert_state_subject_column
ALTER TABLE "alert_state" ADD COLUMN "subject_account_id" uuid;
--> statement-breakpoint
-- @alert_state_fill_account_keys
UPDATE "alert_state" s SET "subject_account_id" = a."id" FROM "accounts" a
 WHERE (s."alert_key" LIKE 'session_reuse_revoked:%' OR s."alert_key" LIKE 'session_refresh_replayed:%')
   AND a."id"::text = split_part(s."alert_key", ':', 2);
--> statement-breakpoint
-- @alert_state_fill_device_keys
UPDATE "alert_state" s SET "subject_account_id" = d."account_id" FROM "devices" d
 WHERE s."alert_key" LIKE 'device_sync_stale:%' AND d."id"::text = split_part(s."alert_key", ':', 2);
--> statement-breakpoint
-- @alert_state_fill_session_keys
UPDATE "alert_state" s SET "subject_account_id" = x."account_id" FROM "sessions" x
 WHERE s."alert_key" LIKE 'session_sync_stale:%' AND x."id"::text = split_part(s."alert_key", ':', 2);
--> statement-breakpoint
CREATE INDEX "alert_state_subject_idx" ON "alert_state" USING btree ("subject_account_id") WHERE ("subject_account_id" IS NOT NULL);
--> statement-breakpoint
-- @alert_state_staff_grant
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ohmail_admin') THEN
    GRANT SELECT (subject_account_id), INSERT (subject_account_id), UPDATE (subject_account_id)
      ON TABLE "alert_state" TO ohmail_admin;
  END IF;
END $$;
