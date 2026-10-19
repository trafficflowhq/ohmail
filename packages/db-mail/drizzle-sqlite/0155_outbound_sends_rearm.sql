-- 0155_outbound_sends_rearm — the re-arm's three columns on the device store, the pg columns' twins;
-- `retry_until` in epoch milliseconds like every instant on this store. Appends, never a rebuild: a
-- rebuild of this table cascades into `outbound_send_fingerprints` and deletes the content claims.

ALTER TABLE "outbound_sends" ADD COLUMN "attempts" integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE "outbound_sends" ADD COLUMN "retry_until" integer;
--> statement-breakpoint
ALTER TABLE "outbound_sends" ADD COLUMN "retry_refusal" text;
