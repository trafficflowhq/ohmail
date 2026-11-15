-- WHAT IS DEAD GOES, AND THREE CLOSED LISTS KEEP A SHAPE.
--
-- `away_responder_sent`: the away responder's first at-most-once record. `away_replies` and
-- `away_sender_state` replaced it (mail 0087); nothing has written it since and nothing reads it.
-- `account_settings.screener_auto_apply_at`: the switch of the Screener's auto-apply pass, which was
-- retired on 2026-11-02. Two indexes that a wider one of the same table repeats.
--
-- THREE LISTS THAT GROW lose their member list and keep a shape: one lower-case word. Until now a
-- new reason word meant dropping and re-adding a CHECK on `mailboxes`, a busy table, and a device
-- could not carry the CHECK at all. The staff role reads these three columns on the argument that
-- no value a mail server chose can reach them (`staff-grants.ts`); a shape that admits no blank,
-- no capital, no '@' and at most 48 characters keeps that argument in the database. The member
-- lists stay where they were enforced on every store: at the write door (`closed-sets.ts`).
--
-- And every constraint this journal added NOT VALID and never validated is validated, while
-- nothing else runs.
--
-- Part of the 2.0 transition's window: applied once, by one transaction, on a store nothing else
-- writes to (`packages/db/src/transition/`). A store made from empty takes it as an ordinary entry.
--
-- ROLLBACK: none in place. The transition rolls back whole; after it, a store is restored from
-- its copy.
-- @drop_away_responder_sent
DROP TABLE "away_responder_sent";
--> statement-breakpoint
-- @drop_screener_auto_apply_at
ALTER TABLE "account_settings" DROP COLUMN "screener_auto_apply_at";
--> statement-breakpoint
-- @closed_lists_become_shapes
ALTER TABLE "mailboxes" DROP CONSTRAINT "mailboxes_disabled_reason_closed", DROP CONSTRAINT "mailboxes_sync_blocked_reason_closed", DROP CONSTRAINT "mailboxes_organized_by_kind_closed";
--> statement-breakpoint
ALTER TABLE "mailboxes"
  ADD CONSTRAINT "mailboxes_disabled_reason_shape" CHECK ("disabled_reason" IS NULL OR "disabled_reason" ~ '^[a-z][a-z0-9_:]{0,47}$'),
  ADD CONSTRAINT "mailboxes_sync_blocked_reason_shape" CHECK ("sync_blocked_reason" IS NULL OR "sync_blocked_reason" ~ '^[a-z][a-z0-9_:]{0,47}$'),
  ADD CONSTRAINT "mailboxes_organized_by_kind_shape" CHECK ("organized_by_kind" IS NULL OR "organized_by_kind" ~ '^[a-z][a-z0-9_:]{0,47}$');
--> statement-breakpoint
-- @drop_repeated_indexes
DROP INDEX "learning_signals_account_idx";
--> statement-breakpoint
DROP INDEX "rules_account_match_key_idx";
--> statement-breakpoint
-- @validate_messages_sender_check
ALTER TABLE "messages" VALIDATE CONSTRAINT "messages_sender_check_closed";
--> statement-breakpoint
-- @validate_messages_sender_check_by
ALTER TABLE "messages" VALIDATE CONSTRAINT "messages_sender_check_by_closed";
--> statement-breakpoint
-- @validate_message_bodies_withheld_reason
ALTER TABLE "message_bodies" VALIDATE CONSTRAINT "message_bodies_withheld_reason";
--> statement-breakpoint
-- @validate_folder_state_last_error_class
ALTER TABLE "folder_state" VALIDATE CONSTRAINT "folder_state_last_error_class_check";
--> statement-breakpoint
-- @validate_small_ones
ALTER TABLE "junk_rescues" VALIDATE CONSTRAINT "junk_rescues_error_class_check";
--> statement-breakpoint
ALTER TABLE "message_failures" VALIDATE CONSTRAINT "message_failures_code_closed";
--> statement-breakpoint
-- @validate_routing_decisions
ALTER TABLE "routing_decisions" VALIDATE CONSTRAINT "routing_decisions_act_refusal_closed";
--> statement-breakpoint
ALTER TABLE "routing_decisions" VALIDATE CONSTRAINT "routing_decisions_matched_rule_id_account_fk";
