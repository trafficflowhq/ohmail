-- INCIDENTS AND SIGNALS — the four places the reliability rules had nowhere to read from.
--
-- The alert engine already evaluates, dedupes, leases and delivers. What it could not do was
-- distinguish a REAL APPLICATION PROBLEM from an informational observation, and three of the
-- conditions an operator most wants named had no durable source at all. This migration adds the
-- storage for both halves and nothing else: no rule lives here, and every statement is additive.
--
-- ══ 1. THE SPLIT IS A COLUMN, NOT A CONVENTION ═════════════════════════════════════════════
--
-- `alert_state` held severity and nothing about CLASS. `storage_at_cap` and `session_reuse_revoked`
-- are warnings that page; so is `sync_lag`. An operator reading a pager at 3am cannot tell, from
-- severity alone, which of those is "a customer is being wronged" and which is "here is something
-- you should know on Monday" — and the answer is not a matter of degree, because the two want
-- different DELIVERY. `cls` states it: an incident goes to the sinks, a signal is recorded and
-- rendered and never wakes anybody.
--
-- DEFAULT 'incident' is the safe direction and is chosen deliberately. A row written by a driver
-- that predates this column, or a rule added later whose author forgot the field, reads as
-- something that pages. The alternative default silently converts a new incident into a signal —
-- a rule that fires, is recorded, renders on the board, and never reaches a human. That is the
-- exact silence this whole file exists to refuse.
--
-- ══ 2. WHO WATCHES THE WATCHER ═════════════════════════════════════════════════════════════
--
-- The alert pass has two drivers (the worker's in-process timer, the API host's cron route) and
-- until now neither left a record that it had run. Both could stop and the only evidence would be
-- an ABSENCE of pages — which is indistinguishable from a healthy deployment, and is the failure
-- the whole alerting subsystem was built to prevent, reproduced one level up.
--
-- `alert_pass_runs` is one row per DRIVER, overwritten every pass. The primary key is the driver
-- word, so there is at most one row per driver by construction and no history accumulates for a
-- table nobody queries historically — `worker_heartbeats` makes the same choice for the same
-- reason. What a reader needs is "when did each arm last complete a pass", and that is one row.
--
-- The rule built on it (`alert_driver_dark`) is evaluated by the OTHER driver, never by itself:
-- a dead driver cannot report its own death, which is precisely why there are two.
--
-- ══ 3. WHAT THE PLATFORM SERVED ════════════════════════════════════════════════════════════
--
-- `platform_signals` holds request/error counts per project per window, polled from the hosting
-- platform's request-log endpoint. It exists because the API host's 5xx rate is invisible from
-- inside the API host: a serverless invocation that returns a 502 and dies leaves nothing in this
-- database, and the one surface that knows is the platform's own log store.
--
-- `requests` AND `errors_5xx` as two counts rather than a rate, because the RULE needs both and a
-- stored rate cannot be re-summed across windows. Three five-minute rows add up to the fifteen
-- minutes the rule is written against; a stored percentage would have to be averaged, which is
-- wrong whenever the windows carry different traffic.
--
-- `truncated` is the honest half. Counting requests means walking a paged log endpoint, and the
-- walk is bounded — a busy window can exceed the budget. The walk goes BACKWARDS from the end of
-- the window, so a truncated row covers a contiguous, most-recent slice: both counts are then
-- lower bounds over a real sub-window, which is the SAFE direction for a rule that fires on
-- "≥ 10 errors AND ≥ 2%" (it can only ever under-report, never invent a page). The column exists
-- so the board can say the window was sampled instead of implying it was counted.
--
-- ══ 4. THE AI CIRCUIT'S AGE, WHICH ONLY THE WORKER KNOWS ═══════════════════════════════════
--
-- The classifier circuit breaker (`apps/worker/src/ai-circuit.ts`) is IN-PROCESS state: one
-- circuit per worker process, holding a fault count and a cooldown. Nothing about it reaches this
-- database, so "the model provider has been unavailable for ten minutes" — which means mail is
-- being filed rules-only for every customer — was unreportable.
--
-- A heartbeat column rather than a table, because it is exactly what the heartbeat already is: a
-- fact about one worker process, written by the process, keyed by its shard, overwritten every
-- beat. NULL means the circuit is closed, which is both the healthy state and the state of a
-- worker that predates this column.
--
-- ══ WHAT IS DELIBERATELY NOT HERE ══════════════════════════════════════════════════════════
--
--   · **No `account_id` on either new table**, and neither can have one: `platform_signals` is a
--     count of HTTP requests to a deployment, and `alert_pass_runs` is a fact about a process.
--     Both are granted whole to the blind staff role for that reason.
--   · **No table for IMAP admission refusals.** The refusals happen on the API host, which is
--     serverless and holds no heartbeat row and no surviving in-process counter. They are counted
--     in `auth_throttle` under their own key namespace — the generic namespaced rolling-window
--     counter this schema already has, and which `imap-admission.ts` already uses for the
--     admission count itself. A new table for a second counter over the same mechanism would be a
--     migration for something the schema already provides.
--   · **No history on `alert_pass_runs`.** See above: one row per driver, overwritten.
--
-- ADDITIVE in every statement. Two new tables, three new columns on `alert_state` and one on
-- `worker_heartbeats`, all defaulted or nullable; nothing is altered, nothing is backfilled, and
-- an API or worker at 0029 runs unchanged against this database.

-- ══ 1. THE INCIDENT/SIGNAL SPLIT, AND THE TWO THINGS A ROW OWES A READER ═══════════════════
--
-- `affected_accounts` is a COUNT and never a list. The console renders "3 accounts" beside a
-- lagging-sync incident so an operator can size it without opening another screen; the accounts
-- themselves are reachable from the surface the `fix_href` points at, under that surface's own
-- projection rules. NULL means the rule does not measure a population (a dead worker is one
-- deployment-wide fact, not N accounts) — which is a different statement from 0 and must stay
-- distinguishable from it.
--
-- `fix_href` is an INTERNAL CONSOLE PATH and nothing else — `/worker`, `/billing`,
-- `/accounts/<uuid>`. It is written by the rule that fires, rendered as a link by the console, and
-- never fetched by anything server-side. It carries no query string derived from mail and no
-- external origin.
ALTER TABLE "alert_state" ADD COLUMN IF NOT EXISTS "cls" text NOT NULL DEFAULT 'incident';
--> statement-breakpoint
ALTER TABLE "alert_state" DROP CONSTRAINT IF EXISTS "alert_state_cls_check";
--> statement-breakpoint
ALTER TABLE "alert_state" ADD CONSTRAINT "alert_state_cls_check"
  CHECK ("cls" IN ('incident', 'signal'));
--> statement-breakpoint
ALTER TABLE "alert_state" ADD COLUMN IF NOT EXISTS "affected_accounts" integer;
--> statement-breakpoint
ALTER TABLE "alert_state" ADD COLUMN IF NOT EXISTS "fix_href" text;
--> statement-breakpoint

-- ══ 2. THE ALERTING'S OWN PULSE ════════════════════════════════════════════════════════════
--
-- `driver` IS the primary key — see the header. `firing`/`delivered` are this pass's counts, and
-- `failed_sinks` is a count rather than the names: the names are in the log line, where a drain
-- gates them, and a sink name on a staff-readable table is a vendor endpoint's identity.
--
-- `sink_failure_streak` is the pass's own view of consecutive all-sink failures, carried here so
-- the console can render "the worker's pager has been refused 4 times running" without asking the
-- worker. It is the same number `AlertPassResult.sinkFailureStreak` reports.
CREATE TABLE IF NOT EXISTS "alert_pass_runs" (
  "driver" text PRIMARY KEY,
  "ran_at" timestamp with time zone DEFAULT now() NOT NULL,
  "firing" integer DEFAULT 0 NOT NULL,
  "delivered" integer DEFAULT 0 NOT NULL,
  "failed_sinks" integer DEFAULT 0 NOT NULL,
  "sink_failure_streak" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alert_pass_runs" DROP CONSTRAINT IF EXISTS "alert_pass_runs_driver_check";
--> statement-breakpoint
-- The closed set of drivers. A third arm would be a deliberate change here AND in the rule that
-- pairs them — `alert_driver_dark` watches the other driver by name, and a driver nobody watches
-- is a driver whose death is invisible, which is this table's whole subject.
ALTER TABLE "alert_pass_runs" ADD CONSTRAINT "alert_pass_runs_driver_check"
  CHECK ("driver" IN ('worker', 'api'));
--> statement-breakpoint

-- ══ 3. WHAT THE PLATFORM SERVED, PER PROJECT, PER WINDOW ═══════════════════════════════════
--
-- `PRIMARY KEY (provider, project, window_start)` makes a re-poll of the same window an UPSERT
-- rather than a duplicate: the cron's jitter and a leader takeover can both put two polls on one
-- window, and two rows would double the traffic the rule divides by. `window_start` is the
-- window's own start instant, never the fetch time — `fetched_at` is that, and the two differ by
-- however long the poll took, which is exactly the freshness the board reports.
--
-- `provider` is CHECK-constrained to the platforms this deployment can actually poll. `project` is
-- the platform's own project name (`ohmail-api`, `ohmail-landing`) — an identifier this repository
-- chooses, carrying nothing about any account.
CREATE TABLE IF NOT EXISTS "platform_signals" (
  "provider" text NOT NULL,
  "project" text NOT NULL,
  "window_start" timestamp with time zone NOT NULL,
  "requests" integer DEFAULT 0 NOT NULL,
  "errors_5xx" integer DEFAULT 0 NOT NULL,
  -- The counts are a LOWER BOUND over the window's most-recent slice — see the header. Defaulted
  -- false so an existing reader treats an unmarked row as counted, which every row this pass
  -- writes without hitting its budget is.
  "truncated" boolean DEFAULT false NOT NULL,
  "fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "platform_signals_pk" PRIMARY KEY ("provider", "project", "window_start")
);
--> statement-breakpoint
ALTER TABLE "platform_signals" DROP CONSTRAINT IF EXISTS "platform_signals_provider_check";
--> statement-breakpoint
ALTER TABLE "platform_signals" ADD CONSTRAINT "platform_signals_provider_check"
  CHECK ("provider" IN ('vercel'));
--> statement-breakpoint
-- The rule reads the last fifteen minutes and the prune deletes past seven days; both are a range
-- scan on `window_start`, and the PK's leading column is `provider`, so neither can use it.
CREATE INDEX IF NOT EXISTS "platform_signals_window_idx"
  ON "platform_signals" ("window_start");
--> statement-breakpoint

-- ══ 4. THE CIRCUIT'S AGE ═══════════════════════════════════════════════════════════════════
--
-- When the classifier circuit FIRST opened in the current unbroken run of trips, or NULL while it
-- is closed. Not "when it last opened": the cooldown doubles per trip and the breaker half-opens
-- between them, so a provider that is down for an hour produces a series of opens, and the last
-- one is minutes old however long the outage has run. The rule's question is how long mail has
-- been filed rules-only, and that is measured from the FIRST open, cleared by the first success.
ALTER TABLE "worker_heartbeats" ADD COLUMN IF NOT EXISTS "ai_circuit_open_since"
  timestamp with time zone;
--> statement-breakpoint

-- ══ 5. HOW LONG THE LEADER HAS BEEN DEGRADED ═══════════════════════════════════════════════
--
-- When this worker FIRST reported itself degraded in the current unbroken run, or NULL while it is
-- healthy. `ai_circuit_open_since`'s shape one statement up, and for the same reason: the rule's
-- question is a DURATION, and a boolean can only answer "right now".
--
-- Without it the alert had no durable clock for the condition and measured UPTIME instead — "the
-- process has been up ten minutes AND is degraded at this instant". That suppresses a boot, which
-- is what it was written for, and suppresses nothing afterwards: a leader up for a day that flips
-- degraded for a single beat (one roster churn, one mailbox re-attaching) satisfied both halves
-- and paged as a critical. A pager that fires on routine churn is one an operator learns to skim,
-- which is the failure the incident/signal split in this same migration exists to prevent.
--
-- STAMPED ON THE ROW, not held in the worker's memory, and that is the load-bearing part: a
-- leader change must not reset the clock. The incoming leader writes the heartbeat for the same
-- shard, reads the stamp that is already there, and leaves it alone while the condition holds —
-- so a fault that outlives the process that first saw it keeps its true age.
--
-- NULL is both "healthy" and "predates this column", exactly as the circuit's stamp is, and the
-- two must read identically: a worker that has not yet written a beat under this build is not
-- degraded, it is unobserved, and neither state may page.
ALTER TABLE "worker_heartbeats" ADD COLUMN IF NOT EXISTS "degraded_since"
  timestamp with time zone;
--> statement-breakpoint

-- ══ 6. HOW MANY SINKS THAT ARM ACTUALLY HAD ════════════════════════════════════════════════
--
-- `sink_failure_streak` counts consecutive FAILED deliveries, and a driver with NO sinks at all
-- never attempts one — so its streak sits at zero for ever and every reader that judges health by
-- the streak calls it healthy. An arm that cannot page anybody is the single worst state this
-- subsystem can be in, and it was the state that read greenest.
--
-- Counted rather than inferred. It can ALMOST be derived — an arm that had something firing and
-- neither delivered nor failed attempted nothing — but only while something is firing, and the
-- question "can this arm page a human" has to be answerable on a quiet deployment too. That is
-- the whole distinction between a live alarm and a configuration nobody has checked.
--
-- DEFAULT 0 is the safe direction on the file's standing rule: a row written by a driver that
-- predates the column reads as "no sinks", which a reader renders as unhealthy. The other default
-- would make an unknown arm look armed.
ALTER TABLE "alert_pass_runs" ADD COLUMN IF NOT EXISTS "sinks_configured"
  integer NOT NULL DEFAULT 0;
