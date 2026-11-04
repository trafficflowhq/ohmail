-- 0178_rule_removals — the rules a person removed, so a settings Import elsewhere can tell a rule the
-- other install never had from one the person removed there.
--
-- One row per rule key per account: the key as the import spells it (`ruleRemovalKey`), the key's
-- parts as the settings copy publishes them, when it was removed and by which install (NULL: this
-- store). Written in the remover's transaction after the rule-key lock, at the remover's clock; an
-- Import that adopts another install's removal keeps that install's instant and id. Rows older than
-- a year are pruned on write. No foreign key (the record outlives the rule it names), no index
-- beyond the primary key (read per account), nothing granted to staff; erased with the account.
--
-- LOCK-WAIT: none. A new table with no foreign key locks no live table.
-- DEPLOY ORDER: migration, then API, then worker, then web.
-- ROLLBACK: revert the code, then DROP TABLE IF EXISTS "rule_removals" in its own transaction.

CREATE TABLE IF NOT EXISTS "rule_removals" (
  "account_id" uuid NOT NULL,
  "rule_key" text NOT NULL,
  "kind" text NOT NULL,
  "match" text NOT NULL,
  "subject_contains" text,
  "body_contains" text,
  "removed_at" timestamp with time zone NOT NULL,
  "removed_by" text,
  CONSTRAINT "rule_removals_account_id_rule_key_pk" PRIMARY KEY ("account_id", "rule_key")
);
