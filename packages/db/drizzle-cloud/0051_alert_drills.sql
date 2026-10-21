-- ALERT DRILLS (cloud 0051). A drill sends every alert kind once through a driver's sinks, titled
-- `[DRILL]`, and records what each sink answered and whether a person acknowledged the message. One
-- row per (run, kind, driver, sink). `sink = '*'` is the worker driver's queued request (`fired_at`
-- NULL until the worker's next pass takes it) or a driver that had no usable sink; every other row
-- is one message's evidence. A message covers every kind of its run, so its one ack token's sha256
-- is stored on each row it covers and an ack stamps them all. The token itself is never stored.
-- Kinds, a driver word, a sink name, closed outcome codes and timestamps: no `account_id`.
--
-- No CHECK lists the kinds: a new alert kind needs no migration to be drilled.
--
-- DEPLOY ORDER: migration, then re-run scripts/harden-staff-role.sql, then the API and the worker.

CREATE TABLE IF NOT EXISTS "alert_drills" (
  "run_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "driver" text NOT NULL,
  "sink" text NOT NULL,
  "ack_base" text,
  "requested_at" timestamp with time zone NOT NULL,
  "fired_at" timestamp with time zone,
  "outcome" text,
  "ack_token_hash" text,
  "acked_at" timestamp with time zone,
  CONSTRAINT "alert_drills_pk" PRIMARY KEY ("run_id", "kind", "driver", "sink"),
  CONSTRAINT "alert_drills_driver_check" CHECK ("driver" IN ('worker', 'api')),
  CONSTRAINT "alert_drills_kind_shape" CHECK ("kind" ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT "alert_drills_sink_shape" CHECK ("sink" = '*' OR "sink" ~ '^[a-z][a-z0-9_-]{0,31}$'),
  CONSTRAINT "alert_drills_outcome_closed" CHECK ("outcome" IS NULL OR "outcome" IN
    ('ok', 'misconfigured', 'refused', 'unreachable', 'timeout', 'threw', 'dispatched', 'unarmed', 'expired')),
  CONSTRAINT "alert_drills_hash_shape" CHECK ("ack_token_hash" IS NULL OR "ack_token_hash" ~ '^[A-Za-z0-9_-]{43}$'),
  CONSTRAINT "alert_drills_ack_base_bound" CHECK ("ack_base" IS NULL OR length("ack_base") <= 200),
  CONSTRAINT "alert_drills_request_has_no_token" CHECK ("sink" <> '*' OR "ack_token_hash" IS NULL),
  CONSTRAINT "alert_drills_ack_after_fire" CHECK ("acked_at" IS NULL OR "fired_at" IS NOT NULL)
);
--> statement-breakpoint

-- The ack's one lookup.
CREATE INDEX IF NOT EXISTS "alert_drills_ack_idx" ON "alert_drills" ("ack_token_hash")
  WHERE "ack_token_hash" IS NOT NULL;
--> statement-breakpoint

-- THE STAFF ROLE'S GRANT, in the migration itself (0049's lesson): the API starts, delivers and
-- acknowledges drills as `ohmail_admin`, and a database migrated but not re-hardened must still
-- work. Exactly the stanza `scripts/harden-staff-role.sql` gives, after the same REVOKE ALL: SELECT
-- on all ten columns, INSERT on all but `acked_at`, UPDATE on `outcome` and `acked_at`, no DELETE.
-- Guarded on the role existing; the role name is unquoted for 0007's reason.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ohmail_admin') THEN
    REVOKE ALL ON TABLE "alert_drills" FROM ohmail_admin;
    GRANT SELECT (run_id, kind, driver, sink, ack_base, requested_at, fired_at, outcome, ack_token_hash, acked_at)
      ON TABLE "alert_drills" TO ohmail_admin;
    GRANT INSERT (run_id, kind, driver, sink, ack_base, requested_at, fired_at, outcome, ack_token_hash)
      ON TABLE "alert_drills" TO ohmail_admin;
    GRANT UPDATE (outcome, acked_at) ON TABLE "alert_drills" TO ohmail_admin;
  END IF;
END $$;
