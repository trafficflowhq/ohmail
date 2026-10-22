-- 0158_mailboxes_gap_strangers — the gap offer's second count.
--
-- mailboxes.gap_strangers: how many letters in the gap window come from senders the arrival gate
-- does not know, which the person's "File" puts in the Screener. Written beside gap_letters by the
-- gap pass (0 when there are none while an offer stands), cleared with it. NULL = no offer, or an
-- offer an older build counted. Nullable, no default, no backfill, no index, no DML; nothing granted
-- to staff; the statement survives a second application.
-- DEPLOY ORDER: migration, then API, then worker.
-- ROLLBACK: revert the code, then ALTER TABLE "mailboxes" DROP COLUMN IF EXISTS "gap_strangers".

ALTER TABLE "mailboxes" ADD COLUMN IF NOT EXISTS "gap_strangers" integer;
