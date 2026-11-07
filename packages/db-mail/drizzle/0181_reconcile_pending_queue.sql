-- 0181_reconcile_pending_queue — the reconcile polls read their pending rows, not the whole table.
-- Every sync cycle asks each mailbox for its due folder moves and `\Seen` writes, ordered by
-- `(updated_at, message_id)`, and almost always gets none; without an index each ask read every
-- `folder_state` or `flag_state` row of the store. A partial index on each, in the poll's order.
-- `db:setup:prod` builds both CONCURRENTLY ahead of the migrator
-- (FOLDER_STATE_PENDING_QUEUE_PREBUILD_SPEC, FLAG_STATE_PENDING_QUEUE_PREBUILD_SPEC), so on a live
-- server these statements find them and no-op.
-- DEPLOY ORDER: setup (prebuild), migration, then API and worker. Every statement repeats safely.
-- ROLLBACK: DROP INDEX IF EXISTS "folder_state_pending_queue_idx"; DROP INDEX IF EXISTS "flag_state_pending_queue_idx";

create index if not exists "folder_state_pending_queue_idx" on public.folder_state using btree ("updated_at","message_id") where "reconcile_status" = 'pending';
--> statement-breakpoint
create index if not exists "flag_state_pending_queue_idx" on public.flag_state using btree ("updated_at","message_id") where "reconcile_status" = 'pending';
