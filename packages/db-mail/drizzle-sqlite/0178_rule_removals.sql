-- 0178_rule_removals — the pg table's twin: the rules a person removed, one row per rule key.
-- Integer epoch ms for the instant; no foreign key, as on the server.

CREATE TABLE IF NOT EXISTS "rule_removals" (
  "account_id" text NOT NULL,
  "rule_key" text NOT NULL,
  "kind" text NOT NULL,
  "match" text NOT NULL,
  "subject_contains" text,
  "body_contains" text,
  "removed_at" integer NOT NULL,
  "removed_by" text,
  CONSTRAINT "rule_removals_account_id_rule_key_pk" PRIMARY KEY ("account_id", "rule_key")
);
