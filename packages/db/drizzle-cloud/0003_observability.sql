-- OBSERVABILITY (migration 0019). Two tables, both purely additive, both
-- operational rather than customer data. Rollback is two DROP TABLEs and nothing of value
-- is lost: `worker_heartbeats` is regenerated on the next worker cycle and `alert_state` is
-- bookkeeping about notifications already delivered.
--
-- ── WHY A HEARTBEAT TABLE EXISTS AT ALL ──────────────────────────────────────────────────
--
-- The alert the arch doc asks for first is "no leader lock held for > 2 minutes (the worker
-- is down)". The lock itself cannot answer that. `pg_try_advisory_lock` is SESSION-scoped,
-- so when the worker dies the lock simply ceases to exist — an observer querying `pg_locks`
-- learns "not held RIGHT NOW" and nothing about FOR HOW LONG. Deriving the duration from
-- repeated observations makes the detection latency equal to the poll interval, which turns
-- a 2-minute rule into whatever the cron schedule happens to be.
--
-- A row the leader stamps every cycle answers it from ONE observation: `now() - beat_at`.
-- It also survives the thing it is reporting on, which `/health` on the worker cannot do —
-- a probe against a dead container gets a connection refusal that is indistinguishable from
-- a network fault, and the hosting platform will have taken the instance out of DNS anyway.
--
-- Keyed by SHARD, not by instance: exactly one process may hold shard N's lock, so the row
-- IS "the leader of shard N", and a takeover UPSERTs over its predecessor instead of leaving
-- a graveyard of dead instance rows that the alert would then have to reason about.
--
-- ── AND WHY alert_state ──────────────────────────────────────────────────────────────────
--
-- Without it, an alerter that runs every five minutes mails the operator every five minutes
-- for as long as the fault lasts, which is how a human learns to filter the alert address.
-- One row per alert KEY carries the fault's lifecycle: when it opened, when it was last
-- observed, when it was last notified. The pass notifies on the transition into firing and
-- then at most once per repeat interval, and clears the row when the fault resolves.
--
-- Core Postgres only (no CREATE EXTENSION, RC8) so this replays into PGlite unchanged.

CREATE TABLE IF NOT EXISTS "worker_heartbeats" (
	"shard_index" integer PRIMARY KEY NOT NULL,
	"instance_id" text NOT NULL,
	"leader" boolean DEFAULT true NOT NULL,
	"shards" integer DEFAULT 1 NOT NULL,
	"mailboxes" integer DEFAULT 0 NOT NULL,
	"expected" integer DEFAULT 0 NOT NULL,
	"accounts" integer DEFAULT 0 NOT NULL,
	"quarantined" integer DEFAULT 0 NOT NULL,
	"degraded" boolean DEFAULT false NOT NULL,
	-- The last cycle in which work actually happened, mirroring the worker's own freshness
	-- rule (`WorkerStats.lastCycleAt`): an all-failed cycle must not look fresh.
	"last_cycle_at" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"beat_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "worker_heartbeats_beat_idx" ON "worker_heartbeats" ("beat_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "alert_state" (
	-- The stable alert IDENTITY: `worker_down:0`, `billing_events_failed`, `sends_stuck`,
	-- `sync_lag`. One row per rule, not per occurrence — an alert is a CONDITION, and the
	-- count of affected rows belongs in `detail`.
	"alert_key" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"severity" text DEFAULT 'critical' NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notified_at" timestamp with time zone,
	"notify_count" integer DEFAULT 0 NOT NULL,
	-- Human-readable summary of the LAST observation, e.g. "3 events failed, oldest 4h ago".
	-- Never carries mail content: every producer is a COUNT or an AGE over operational rows.
	"detail" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "alert_state_last_seen_idx" ON "alert_state" ("last_seen_at");
