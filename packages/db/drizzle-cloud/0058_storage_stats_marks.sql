-- THE STORAGE SNAPSHOT'S MARKS (cloud 0058). The worker's snapshot (`apps/worker/src/storage-stats.ts`) was one
-- aggregate per account; on a large account it ran past its statement timeout and was retried every half
-- hour. It now reads one mailbox at a time in pages, and a mailbox whose letters did not change since its
-- row is confirmed without reading them. Three marks say what a row's figures include:
--
-- through_seq: the account's committed `account_sync_state.next_seq` when the count began; a letter change
-- the row does not include has a larger seq.
-- husked_at: `account_storage.last_husked_at` as read at that moment; a trim rewrites it and writes no change.
-- walked_at: when the last full read began; a confirm keeps it. A row read whole a week before its check is
-- read whole again, so a write that moves text with neither a change row nor a trim stamp (a junk filing's
-- husk, its refill) stands a week and a period at most.
--
-- All nullable, no backfill: a row without marks is counted again at its next check. Not content, and not
-- granted to the staff role.
--
-- LOCK-WAIT: each ALTER holds ACCESS EXCLUSIVE on `mailbox_storage_stats` until the cloud pass commits; a
-- small table (one row per mailbox), and the columns are metadata only.
-- DEPLOY ORDER: migration, then the API and the worker. A worker ahead of the migration faults its pass and
-- the old rows stand; the API does not read the columns.
-- ROLLBACK: the worker first, then `ALTER TABLE "mailbox_storage_stats" DROP COLUMN "walked_at"`,
-- `DROP COLUMN "husked_at"` and `DROP COLUMN "through_seq"`.

ALTER TABLE "mailbox_storage_stats" ADD COLUMN IF NOT EXISTS "through_seq" bigint;--> statement-breakpoint
ALTER TABLE "mailbox_storage_stats" ADD COLUMN IF NOT EXISTS "husked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mailbox_storage_stats" ADD COLUMN IF NOT EXISTS "walked_at" timestamp with time zone;
