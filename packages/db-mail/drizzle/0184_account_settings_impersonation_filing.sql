-- 0184_account_settings_impersonation_filing — the switch for filing a held letter that impersonates a
-- company to Spam on its own (deterministic, no model).
--
-- `account_settings.impersonation_filing_off_at`: NULL means on, the default for every existing account;
-- a time means the person turned it off then. Written by the Screening settings door and by an organizer
-- applying a reader's change or a mailbox's settings copy; read by the organizer's screening pass. No
-- default, no backfill, no index, no check.
--
-- Tables altered: account_settings (one nullable column). Rules, mailboxes and drafts are not touched. No DML.
-- LOCK: a brief ACCESS EXCLUSIVE on account_settings, no scan, no rewrite.
-- DEPLOY ORDER: migration, then API (the export selects the row whole), then worker. The statement repeats safely.
-- ROLLBACK: ALTER TABLE "account_settings" DROP COLUMN IF EXISTS "impersonation_filing_off_at", once no process
-- of this build runs; every account then reads as on.

ALTER TABLE "account_settings" ADD COLUMN IF NOT EXISTS "impersonation_filing_off_at" timestamp with time zone;
