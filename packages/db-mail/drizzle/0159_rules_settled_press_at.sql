-- 0159_rules_settled_press_at — the reader's press ordering, one nullable column on `rules`.
--
-- rules.settled_press_at: the decidedAt of the last reader press the belt settled on the row without
-- writing it (a create that found the rule already as it asks). updated_at cannot order an older
-- press settled later below such a create, and updated_at is read by the rules surface, the gap
-- pass and the settings document, so it is left alone. Written only by the belt and read only by
-- its ordering; on no DTO and no document. NULL = no such press. Nullable, no default, no backfill,
-- no index, no DML; nothing granted to staff; the statement survives a second application.
-- DEPLOY ORDER: migration, then API, then worker.
-- ROLLBACK: revert the code, then ALTER TABLE "rules" DROP COLUMN IF EXISTS "settled_press_at".

ALTER TABLE "rules" ADD COLUMN IF NOT EXISTS "settled_press_at" timestamp with time zone;
