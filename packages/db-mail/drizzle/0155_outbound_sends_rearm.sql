-- 0155_outbound_sends_rearm — a send that failed for a passing reason before any SMTP may be
-- offered again under its own key, a bounded number of times inside a short window.
--
-- outbound_sends.attempts: how many attempts this key has had, 1 at the reservation and one more per
-- re-arm. outbound_sends.retry_until: set only on a `failed` row a same-key replay may re-arm (the end
-- of its window); NULL is a final row. outbound_sends.retry_refusal: the code of the passing refusal
-- that row was offered again after, set and cleared with retry_until; a replay after the window is
-- told it. All three are written by SendService alone. The default makes every existing row one
-- attempt and final, which is what it is, so there is no backfill. Not granted to staff; each
-- statement survives a second application. Metadata-only on Postgres 11 and later (a constant default
-- rewrites nothing). DEPLOY ORDER: migration, then API, then worker.
-- ROLLBACK: drop the three columns.

ALTER TABLE "outbound_sends" ADD COLUMN IF NOT EXISTS "attempts" integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE "outbound_sends" ADD COLUMN IF NOT EXISTS "retry_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "outbound_sends" ADD COLUMN IF NOT EXISTS "retry_refusal" text;
