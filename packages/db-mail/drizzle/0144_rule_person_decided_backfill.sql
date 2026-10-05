-- 0144_rule_person_decided_backfill — the person's decisions made before their stamp existed.
--
-- The index keys a sender's bare key over EVERY row, paused included: the one read of a graduation
-- asks whether a person decided under the key, and 0136's index holds enabled rows only. Class C:
-- an "always allow" pressed before it wrote the person's own rule (promoted, unstamped, bare, INBOX,
-- no Screener signal for the sender, no graduated route for the key) becomes `manual`, stamped at
-- its creation. Class A: a person's Screener press before mail 0128 (a non-act signal into the row's
-- admitting place, News spellings folded) is stamped and stays `promoted`. Screen-outs are not
-- stamped: the stamp licenses the automatic unsubscribe. Idempotent: each WHERE empties in one run.

CREATE INDEX IF NOT EXISTS "rules_account_key_idx" ON "rules" USING btree ("account_id", (trim(lower("match"))));--> statement-breakpoint
UPDATE "rules" SET "provenance" = 'manual', "person_decided_at" = "created_at"
 WHERE "kind" = 'sender' AND "provenance" = 'promoted' AND "person_decided_at" IS NULL
   AND "subject_contains" IS NULL AND "body_contains" IS NULL AND "destination" = 'INBOX'
   AND NOT EXISTS (SELECT 1 FROM "learning_signals" s
                    WHERE s."account_id" = "rules"."account_id" AND s."kind" = 'screener'
                      AND lower(s."sender_address") = trim(lower("rules"."match")))
   AND NOT EXISTS (SELECT 1 FROM "graduations" g
                    WHERE g."account_id" = "rules"."account_id" AND g."action" = 'route'
                      AND g."graduated_at" IS NOT NULL
                      AND g."pattern_key" = 'sender:' || trim(lower("rules"."match")) || '→INBOX');--> statement-breakpoint
UPDATE "rules" SET "person_decided_at" = "created_at"
 WHERE "kind" = 'sender' AND "provenance" = 'promoted' AND "person_decided_at" IS NULL
   AND "subject_contains" IS NULL AND "body_contains" IS NULL
   AND "destination" IN ('INBOX', 'ohmail/News', 'ohmail/Reads', 'ohmail/Receipts')
   AND EXISTS (SELECT 1 FROM "learning_signals" s
                WHERE s."account_id" = "rules"."account_id" AND s."kind" = 'screener'
                  AND lower(s."sender_address") = trim(lower("rules"."match"))
                  AND s."triggering_action_id" NOT LIKE 'screener:auto:%'
                  AND (CASE WHEN s."destination" = 'ohmail/Reads' THEN 'ohmail/News' ELSE s."destination" END)
                    = (CASE WHEN "rules"."destination" = 'ohmail/Reads' THEN 'ohmail/News' ELSE "rules"."destination" END));
