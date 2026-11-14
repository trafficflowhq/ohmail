-- 0202_retired — the shared entry's twin. The dead table and the retired setting go here as on
-- the server; so do the two repeated indexes. This store has none of the CHECKs the entry turns
-- into shapes or validates.

DROP TABLE "away_responder_sent";
--> statement-breakpoint
ALTER TABLE "account_settings" DROP COLUMN "screener_auto_apply_at";
--> statement-breakpoint
DROP INDEX "learning_signals_account_idx";
--> statement-breakpoint
DROP INDEX "rules_account_match_key_idx";
