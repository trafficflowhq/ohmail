-- THE DIGEST CHECK, VALIDATED (cloud 0045). Cloud 0041 added
-- `attachment_staging_content_sha256_hex` NOT VALID, so every write since has been checked and
-- the rows before it hold the NULL the column was born with. This scans the table once under
-- SHARE UPDATE EXCLUSIVE — reads and writes continue — and marks the constraint validated: the
-- follow-up 0041 said would ship one release later. VALIDATE-only; idempotent.
--
-- DEPLOY ORDER: any. ROLLBACK: none needed; the validated constraint refuses what 0041's did.

ALTER TABLE "attachment_staging" VALIDATE CONSTRAINT "attachment_staging_content_sha256_hex";
