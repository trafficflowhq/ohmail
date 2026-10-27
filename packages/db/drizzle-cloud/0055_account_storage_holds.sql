-- A LOWER STORAGE LIMIT WAITS BEFORE IT EMPTIES LETTERS (cloud 0055). A plan downgrade or a removed
-- storage add-on used to lower the stored-mail limit at once, and the next trim emptied old letters'
-- text with no notice. One row per metered account: the plan's own limit as last seen, and while a
-- drop is held, the previous limit and the day it ends (14 days after the first reading of the lower
-- limit, at 00:00 UTC). Every cap reader applies it (`storage-hold.ts`); the person is told in the
-- storage notice, as for the trial's floor. No content, no address: limits in bytes and an instant.
--
-- CLOUD, not mail: only the hosted worker and API meter storage. Written through the erasure fence;
-- `deleteAccount` deletes the row (`accounts` survives erasure, so the CASCADE never fires). No staff grant.
--
-- LOCK-WAIT: none on a populated table. The foreign key takes SHARE ROW EXCLUSIVE on `accounts` until the
-- cloud pass commits: a sign-up or an erasure stamp waits that long; the fence's FOR SHARE does not.
-- DEPLOY ORDER: migration, then the worker, then the API. An API alone would tell a date the old worker
-- does not keep; an API ahead of the migration answers /health 503 schema_incomplete.
-- ROLLBACK: the API, then the worker, then `DROP TABLE account_storage_holds`.

CREATE TABLE IF NOT EXISTS "account_storage_holds" (
  "account_id" uuid PRIMARY KEY REFERENCES "accounts"("id") ON DELETE CASCADE,
  "seen_bytes" bigint NOT NULL,
  "held_bytes" bigint,
  "held_until" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "account_storage_holds_seen_nonneg" CHECK ("seen_bytes" >= 0),
  CONSTRAINT "account_storage_holds_held_pair" CHECK (("held_bytes" IS NULL) = ("held_until" IS NULL)),
  CONSTRAINT "account_storage_holds_held_above_seen" CHECK ("held_bytes" IS NULL OR "held_bytes" > "seen_bytes")
);
