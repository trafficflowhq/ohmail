-- PER-DRIVER GAP HISTORY (cloud 0048). One row per alert driver per UTC day: how many passes it
-- recorded and the longest silence a pass of that day ended. `alert_pass_runs` keeps one row per
-- driver and no history, so "how long was each arm dark this month" had no answer. The pass
-- writes this row in the same statement that stamps `alert_pass_runs`, so an outage of both arms
-- is recorded by the first pass after it. A driver word, a day, counts and one timestamp: no
-- `account_id`, and there cannot be one. Retention is 100 days, pruned by the worker.
--
-- DEPLOY ORDER: migration, then re-run scripts/harden-staff-role.sql, then the API and worker.

CREATE TABLE IF NOT EXISTS "alert_driver_gaps" (
  "driver" text NOT NULL,
  "day" date NOT NULL,
  "passes" integer DEFAULT 0 NOT NULL,
  "max_gap_s" integer DEFAULT 0 NOT NULL,
  "max_gap_at" timestamp with time zone,
  CONSTRAINT "alert_driver_gaps_pk" PRIMARY KEY ("driver", "day"),
  CONSTRAINT "alert_driver_gaps_driver_check" CHECK ("driver" IN ('worker', 'api'))
);
