-- 0146_rule_person_decided_followup — two kinds of the person's decision 0144 left unstamped.
--
-- Arm I: a settings copy from an older ohmail, imported after this store ran 0144, brought the
-- person's allow as a promoted, unstamped, bare sender rule into INBOX, News or Receipts. Where this
-- store has the sender as a contact, no Screener signal for the address and no graduated route for
-- its key, the rule is stamped at its creation and stays `promoted` (`people_only` reads it). Arm D:
-- 0144's second arm on the sender's whole domain: the allow's own INBOX row created after the
-- person's newest spam or screen-out decision on the domain, with ohmail's INBOX admit and
-- graduation for the address older than it, becomes `manual`, stamped at its creation. Screen-outs
-- are not stamped. Data only, idempotent: each WHERE empties in one run.

UPDATE "rules" SET "person_decided_at" = "created_at"
 WHERE "kind" = 'sender' AND "provenance" = 'promoted' AND "person_decided_at" IS NULL
   AND "subject_contains" IS NULL AND "body_contains" IS NULL
   AND "destination" IN ('INBOX', 'ohmail/News', 'ohmail/Reads', 'ohmail/Receipts')
   AND EXISTS (SELECT 1 FROM "contacts" c
                WHERE c."account_id" = "rules"."account_id" AND lower(c."address") = trim(lower("rules"."match")))
   AND NOT EXISTS (SELECT 1 FROM "learning_signals" s
                    WHERE s."account_id" = "rules"."account_id" AND s."kind" = 'screener'
                      AND lower(s."sender_address") = trim(lower("rules"."match")))
   AND NOT EXISTS (SELECT 1 FROM "graduations" g
                    WHERE g."account_id" = "rules"."account_id" AND g."action" = 'route'
                      AND g."graduated_at" IS NOT NULL
                      AND substr(g."pattern_key", 1, length('sender:' || trim(lower("rules"."match")) || '→'))
                        = 'sender:' || trim(lower("rules"."match")) || '→');--> statement-breakpoint
UPDATE "rules" SET "provenance" = 'manual', "person_decided_at" = "rules"."created_at"
  FROM (SELECT s."account_id", lower(s."sender_domain") AS "domain",
               max(CASE WHEN s."destination" IN ('ohmail/Quarantine', 'ohmail/Screened')
                         AND s."triggering_action_id" NOT LIKE 'screener:auto:%' THEN s."created_at" END) AS "last_out"
          FROM "learning_signals" s
         WHERE s."kind" = 'screener' AND s."sender_address" IS NULL AND s."sender_domain" IS NOT NULL
         GROUP BY s."account_id", lower(s."sender_domain")) AS "o"
 WHERE "o"."account_id" = "rules"."account_id"
   AND "o"."domain" = substr(trim(lower("rules"."match")), position('@' in trim(lower("rules"."match"))) + 1)
   AND "rules"."kind" = 'sender' AND "rules"."provenance" = 'promoted' AND "rules"."person_decided_at" IS NULL
   AND "rules"."subject_contains" IS NULL AND "rules"."body_contains" IS NULL AND "rules"."destination" = 'INBOX'
   AND "rules"."created_at" > "o"."last_out"
   AND NOT EXISTS (SELECT 1 FROM "learning_signals" a
                    WHERE a."account_id" = "rules"."account_id" AND a."kind" = 'screener'
                      AND a."destination" = 'INBOX' AND a."triggering_action_id" LIKE 'screener:auto:%'
                      AND lower(a."sender_address") = trim(lower("rules"."match"))
                      AND a."created_at" >= "o"."last_out")
   AND NOT EXISTS (SELECT 1 FROM "graduations" g
                    WHERE g."account_id" = "rules"."account_id" AND g."action" = 'route'
                      AND g."pattern_key" = 'sender:' || trim(lower("rules"."match")) || '→INBOX'
                      AND g."graduated_at" >= "o"."last_out");
