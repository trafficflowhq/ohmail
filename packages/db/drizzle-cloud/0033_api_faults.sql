-- THE API'S OWN 5xx RECORD — the first-party half of a reliability board.
--
-- `platform_signals` (cloud 0030) counts what the HOSTING PLATFORM served, polled from its
-- request log. That is the only surface that sees a 502 or a killed invocation, and it is also
-- the only surface that sees anything at all: no rule could name WHICH route failed or WHY,
-- because an HTTP status never reached this database. `api_faults` is the other half — one row
-- per 5xx the API's own error envelope answered, written by the request that failed.
--
-- WHAT A ROW MAY HOLD, and the constraint is the point: the route PATTERN (`/messages/:id`,
-- never a URL), the method, the status, the throwing error's CLASS NAME, our own request id, and
-- which arm answered. No message, no body, no address, no subject, no parameter value — a
-- driver-written message can quote a connection string and an error's message can quote what a
-- person typed, so the class name is the whole diagnosis this table carries. Every column is a
-- literal this repository chose or an integer, which is why the taintable-column census is
-- unmoved by this file.
--
-- RETENTION is seven days, pruned by a worker pass — `platform_signals`' own horizon, for the
-- same reason: the rules read minutes and an operator reads days.
--
-- DEPLOY ORDER: migration, then worker + API. The reverse leaves the recorder inserting into a
-- table that does not exist; the write is best-effort and swallowed by design, so it would
-- present as a board that stays empty while everything reports healthy.
--
-- ROLLBACK is `DROP TABLE api_faults`, after reverting the readers. No other table is touched.

CREATE TABLE IF NOT EXISTS "api_faults" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "at" timestamp with time zone DEFAULT now() NOT NULL,
  -- The matched route's PATTERN, not the request target. A pattern is one of a closed set this
  -- repository declares in its route table; a target carries whatever the caller sent.
  "route" text NOT NULL,
  "method" text NOT NULL,
  "status" integer NOT NULL,
  -- The class name of the thrown value, or `String` for a thrown primitive. Never the message.
  "error_class" text NOT NULL,
  -- Our own `withRequestId` uuid, so a board row and a log line can be joined. NULL when the
  -- fault escaped before the id was bound.
  "request_id" text,
  -- Which arm answered: the closed set below.
  "arm" text NOT NULL
);
--> statement-breakpoint
-- 5xx ONLY. The table's whole claim is "these are the answers we owe an operator"; a 4xx is the
-- API working, and admitting one would put a caller's own mistakes into the denominator of every
-- rule built on this table.
ALTER TABLE "api_faults" DROP CONSTRAINT IF EXISTS "api_faults_status_check";
--> statement-breakpoint
ALTER TABLE "api_faults" ADD CONSTRAINT "api_faults_status_check"
  CHECK ("status" >= 500 AND "status" <= 599);
--> statement-breakpoint
-- Length ceilings on the three text columns a caller could otherwise influence in volume. The
-- values are ours, so these are not validation — they are the bound that keeps one hostile or
-- looping route from growing the table by row SIZE rather than row count.
ALTER TABLE "api_faults" DROP CONSTRAINT IF EXISTS "api_faults_len_check";
--> statement-breakpoint
ALTER TABLE "api_faults" ADD CONSTRAINT "api_faults_len_check"
  CHECK (char_length("route") <= 200 AND char_length("method") <= 20
    AND char_length("error_class") <= 200 AND char_length("request_id") <= 100);
--> statement-breakpoint
ALTER TABLE "api_faults" DROP CONSTRAINT IF EXISTS "api_faults_arm_check";
--> statement-breakpoint
-- The closed set of arms, `alert_pass_runs.driver`'s shape: a third arm is a deliberate change
-- here and in whatever rule reads per-arm, because an arm nobody reads is an arm whose faults
-- are invisible.
ALTER TABLE "api_faults" ADD CONSTRAINT "api_faults_arm_check"
  CHECK ("arm" IN ('api', 'worker'));
--> statement-breakpoint
-- The prune and the window read are both range scans on `at`; the PK is a uuid and serves
-- neither. The per-route rule groups inside that window, so `at` leads and `route` follows.
CREATE INDEX IF NOT EXISTS "api_faults_at_idx" ON "api_faults" ("at");
--> statement-breakpoint
-- THIS INDEX CARRIES NOTHING; THE COLUMN BELOW CARRIES THE SCHEMA MARKER. `arm` is the table's
-- last column and `health-cloud.ts`'s marker plus `alerts.ts`'s SCHEMA_BEHIND_MARKER both name
-- it, on 0030's rule: statements inside one migration apply in order, so a database holding the
-- last column holds every object above it. Appending a statement that adds a column after this
-- one means moving both constants in the same commit.
CREATE INDEX IF NOT EXISTS "api_faults_at_route_idx" ON "api_faults" ("at", "route");
