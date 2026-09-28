-- A MESSAGE OVER THE DOWNLOAD CEILING IS A ROW (mail 0134). A message past MAX_RAW_MESSAGE_BYTES
-- is ingested from its header block alone and its body is the husk `too_large`, so it is listed
-- and says why it is empty instead of existing nowhere. The withheld_reason CHECK gains that one
-- member; drop-then-add, the shape 0065 used, because a desktop engine replays this journal.
--
-- NOT VALID and NO VALIDATE: the migrator runs the journal in one transaction, so a VALIDATE here
-- would scan message_bodies under the ACCESS EXCLUSIVE lock the DROP holds. Every existing row
-- already satisfies 0065's CHECK and this one strictly widens it, so there is nothing to validate.
--
-- DEPLOY ORDER: migration, then API and worker. ROLLBACK: re-add 0065's CHECK after
-- `UPDATE message_bodies SET withheld_reason = 'storage_cap' WHERE withheld_reason = 'too_large'`.

ALTER TABLE "message_bodies" DROP CONSTRAINT IF EXISTS "message_bodies_withheld_reason";
--> statement-breakpoint
ALTER TABLE "message_bodies" ADD CONSTRAINT "message_bodies_withheld_reason"
  CHECK ("withheld_reason" IS NULL OR "withheld_reason" IN ('storage_cap', 'junk_filed', 'expunged', 'too_large')) NOT VALID;
