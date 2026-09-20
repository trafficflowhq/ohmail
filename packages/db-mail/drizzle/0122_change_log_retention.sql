-- CHANGE-LOG RETENTION. `pruned_through_seq` is the account's explicit 410 floor: every seq at
-- or below it may have been compacted by the worker's retention pass (churn, tombstones and dead
-- entities go; each live entity's FIRST row and the ohbox-tidy user-wins moves stay), so a
-- resuming cursor at or below it cannot replay exactly and `GET /sync` answers 410
-- cursor_expired -> re-bootstrap. Raised BEFORE any delete, monotone; 0 means nothing pruned,
-- which is the pre-migration truth for every account. The audit prune's index is NOT here: an
-- index build on a growth table write-blocks it for the whole build and CONCURRENTLY cannot run
-- in this transaction, so it lives in `packages/db/src/hot-path-indexes.ts`.
-- ROLLBACK: ALTER TABLE account_sync_state DROP COLUMN pruned_through_seq;

ALTER TABLE "account_sync_state" ADD COLUMN IF NOT EXISTS "pruned_through_seq" bigint NOT NULL DEFAULT 0;
