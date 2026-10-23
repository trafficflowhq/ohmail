-- 0162_outbound_sends_offer_state — whether an attempt may have offered its message to SMTP.
--
-- outbound_sends.offer_state: 'unoffered' from the reservation (and each re-arm) until the attempt
-- commits 'offered' right before its first SMTP traffic. A stale reservation still 'unoffered' sent
-- nothing, so it is forgotten and the person's own press, replayed under its key, sends it; a row
-- that may have been offered keeps verify-by-Sent. 'unknown' is every row from before this, and any
-- an older API or worker writes during the deploy: read as possibly offered. Written by SendService
-- alone; no CHECK, no index, not granted to staff. Metadata-only (a constant default rewrites
-- nothing) and safe to apply twice. DEPLOY ORDER: migration, then API, then worker.
-- ROLLBACK: roll the code back first, then drop the column.

ALTER TABLE "outbound_sends" ADD COLUMN IF NOT EXISTS "offer_state" text NOT NULL DEFAULT 'unknown';
