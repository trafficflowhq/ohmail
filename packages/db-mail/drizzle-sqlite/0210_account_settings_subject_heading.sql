-- 0210_account_settings_subject_heading — the pg columns' twins: the word as text, its instant as epoch ms.
-- This store declares neither CHECK of the shared entry (its twin declares no CHECK on `account_settings`, as for
-- 0082's face): the word is held to the pair, and the pair to one statement, by the one writer both doors go through.

ALTER TABLE "account_settings" ADD COLUMN "subject_heading" text;--> statement-breakpoint
ALTER TABLE "account_settings" ADD COLUMN "subject_heading_at" integer;
