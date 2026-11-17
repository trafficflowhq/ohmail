-- 0210_account_settings_subject_heading — where a conversation's subject stands in the reader, as the person stated it.
--
-- `account_settings.subject_heading`: 'head' (once, at the conversation's head) or 'each' (on each letter). NULL means
-- nothing is stated, and every reader then shows 'head'. `account_settings.subject_heading_at`: the instant the word was
-- stated. Between two statements the later instant holds, on every install of the mailbox.
--
-- Written by the settings door (a person's press) and by an install taking in what the mailbox's settings copy states.
-- Read by the organizer's settings copy, the consent read and the export. The settings copy kept in the mailbox carries
-- the pair; an organizer that does not know it writes a copy without it, and this row is what states it again.
--
-- Two CHECKs: the word is one of the pair, and the word and its instant are NULL together.
--
-- Tables altered: account_settings (two nullable columns, two CHECKs). Rules, mailboxes and drafts are not touched. No DML.
-- LOCK: a brief ACCESS EXCLUSIVE on account_settings. Each CHECK reads one row per account; it is not a table that
-- grows with mail.
-- DEPLOY ORDER: migration, then API (the consent read and the export select the row whole), then worker.
-- Idempotent (IF NOT EXISTS; each CHECK dropped, then added): a desktop engine replays this journal at launch.
-- ROLLBACK: drop the two constraints and the two columns, once no process of this build runs; every account then
-- reads as nothing stated.

ALTER TABLE "account_settings" ADD COLUMN IF NOT EXISTS "subject_heading" text;--> statement-breakpoint
ALTER TABLE "account_settings" ADD COLUMN IF NOT EXISTS "subject_heading_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "account_settings" DROP CONSTRAINT IF EXISTS "account_settings_subject_heading_closed";--> statement-breakpoint
ALTER TABLE "account_settings" ADD CONSTRAINT "account_settings_subject_heading_closed" CHECK ("subject_heading" IS NULL OR "subject_heading" IN ('head', 'each'));--> statement-breakpoint
ALTER TABLE "account_settings" DROP CONSTRAINT IF EXISTS "account_settings_subject_heading_stated";--> statement-breakpoint
ALTER TABLE "account_settings" ADD CONSTRAINT "account_settings_subject_heading_stated" CHECK (("subject_heading" IS NULL) = ("subject_heading_at" IS NULL));
