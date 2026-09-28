-- THE SCREENER AUTO-APPLY CANDIDATE STATEMENT'S THREE PER-ROW PROBES, each keyed on the account.
--
-- The candidate statement asks, for every held row, whether the user ruled on its sender, has a
-- reply draft for it or decided an approval about it. None of the three had an index to ask: the
-- rules probe re-filtered the account's whole rule list per row (an OR of two keys), and the other
-- two were sequential scans nested under the page. Small tables, so a plain build; `IF NOT EXISTS`
-- makes a second application a no-op. The folder_state held index is a hot-path spec, not here.
-- ROLLBACK is the three `DROP INDEX IF EXISTS`.

CREATE INDEX IF NOT EXISTS "rules_account_match_key_idx" ON "rules" USING btree ("account_id", (trim(lower("match")))) WHERE "enabled";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approvals_account_message_idx" ON "approvals" USING btree ("account_id", "message_id") WHERE "message_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drafts_account_reply_idx" ON "drafts" USING btree ("account_id", "in_reply_to_message_id") WHERE "in_reply_to_message_id" IS NOT NULL;
