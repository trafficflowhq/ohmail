-- 0162_outbound_sends_offer_state — the pg column's twin on the device store. Appends, never a
-- rebuild: a rebuild of this table cascades into `outbound_send_fingerprints` and deletes the claims.

ALTER TABLE "outbound_sends" ADD COLUMN "offer_state" text NOT NULL DEFAULT 'unknown';
