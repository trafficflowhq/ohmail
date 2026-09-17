-- 0118_account_isolation — account isolation is refused by the database, not remembered by callers.
--
-- Every child row that carries its own `account_id` could name a parent belonging to another
-- account: the single-column key proved the parent EXISTS, never that it was ours. One wrong
-- account id in one caller put another account's mail under this account's scope and nothing said
-- so. The composite key `(parent_id, account_id) -> parent (id, account_id)` makes that
-- unrepresentable. Each REPLACES the single-column key it subsumes, carrying that key's own
-- ON DELETE action, so a reference has one rule rather than two that can disagree. A nullable
-- reference still passes when it is NULL — MATCH SIMPLE — which is what keeps "no thread yet" and
-- "no rule matched" representable.
--
-- `folder_ops.folder_id` is keyed by MAILBOX instead, and that is the stronger of the two: the op
-- already reaches its account through `(mailbox_id, account_id)`, so pinning the folder to the
-- op's mailbox closes the account half transitively AND the same-account, wrong-mailbox case an
-- account key would still admit.
--
-- The one SET NULL names its column. On a composite key the bare form nulls EVERY referencing
-- column, `account_id` among them, and that column is NOT NULL — so deleting a draft failed
-- outright. `SET NULL ("draft_id")` drops the pointer and leaves the send its account.
--
-- THE AWAY LEDGER'S two `message_id` keys take `ON DELETE SET NULL ("message_id")`, because that
-- column is PROVENANCE: the ledger row must outlive the message it answered, or an expunge
-- un-answers a correspondent and a mailbox removal fails on the wipe. The row keeps `sender` and
-- `outcome`, which is what "this person was answered" is made of. `away_replies.message_id` drops
-- NOT NULL for it, and each key is preceded by the UPDATE that nulls rows already pointing at a
-- message this account no longer has — ADD CONSTRAINT fails on existing violations.
--
-- ONE pair of the thirty-nine takes NO key here: `outbound_send_fingerprints.mailbox_id`. A key
-- makes every insert take a KEY SHARE lock on the mailbox row, and five production paths hold
-- that row FOR UPDATE — so a send would wait behind a stand-down, a dedup or a resync. Its
-- account is already pinned through `send_id`, so no read can reach it under another account.

CREATE UNIQUE INDEX IF NOT EXISTS "mailboxes_id_account_uq" ON "mailboxes" ("id", "account_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "messages_id_account_uq" ON "messages" ("id", "account_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "threads_id_account_uq" ON "threads" ("id", "account_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "contacts_id_account_uq" ON "contacts" ("id", "account_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tags_id_account_uq" ON "tags" ("id", "account_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "drafts_id_account_uq" ON "drafts" ("id", "account_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "outbound_sends_id_account_uq" ON "outbound_sends" ("id", "account_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "routing_decisions_id_account_uq" ON "routing_decisions" ("id", "account_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rules_id_account_uq" ON "rules" ("id", "account_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workflows_id_account_uq" ON "workflows" ("id", "account_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_id_account_uq" ON "users" ("id", "account_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "devices_id_account_uq" ON "devices" ("id", "account_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sessions_id_account_uq" ON "sessions" ("id", "account_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mailbox_folders_id_mailbox_uq" ON "mailbox_folders" ("id", "mailbox_id");--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "messages_mailbox_id_mailboxes_id_fk";--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "messages_mailbox_id_account_fk";--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_mailbox_id_account_fk" FOREIGN KEY ("mailbox_id", "account_id") REFERENCES "mailboxes" ("id", "account_id");--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "messages_thread_id_threads_id_fk";--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "messages_thread_id_account_fk";--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_id_account_fk" FOREIGN KEY ("thread_id", "account_id") REFERENCES "threads" ("id", "account_id");--> statement-breakpoint
ALTER TABLE "message_instances" DROP CONSTRAINT IF EXISTS "message_instances_mailbox_id_mailboxes_id_fk";--> statement-breakpoint
ALTER TABLE "message_instances" DROP CONSTRAINT IF EXISTS "message_instances_mailbox_id_account_fk";--> statement-breakpoint
ALTER TABLE "message_instances" ADD CONSTRAINT "message_instances_mailbox_id_account_fk" FOREIGN KEY ("mailbox_id", "account_id") REFERENCES "mailboxes" ("id", "account_id");--> statement-breakpoint
ALTER TABLE "message_instances" DROP CONSTRAINT IF EXISTS "message_instances_message_id_messages_id_fk";--> statement-breakpoint
ALTER TABLE "message_instances" DROP CONSTRAINT IF EXISTS "message_instances_message_id_account_fk";--> statement-breakpoint
ALTER TABLE "message_instances" ADD CONSTRAINT "message_instances_message_id_account_fk" FOREIGN KEY ("message_id", "account_id") REFERENCES "messages" ("id", "account_id");--> statement-breakpoint
ALTER TABLE "message_failures" DROP CONSTRAINT IF EXISTS "message_failures_mailbox_id_mailboxes_id_fk";--> statement-breakpoint
ALTER TABLE "message_failures" DROP CONSTRAINT IF EXISTS "message_failures_mailbox_id_account_fk";--> statement-breakpoint
ALTER TABLE "message_failures" ADD CONSTRAINT "message_failures_mailbox_id_account_fk" FOREIGN KEY ("mailbox_id", "account_id") REFERENCES "mailboxes" ("id", "account_id");--> statement-breakpoint
ALTER TABLE "folder_ops" DROP CONSTRAINT IF EXISTS "folder_ops_mailbox_id_mailboxes_id_fk";--> statement-breakpoint
ALTER TABLE "folder_ops" DROP CONSTRAINT IF EXISTS "folder_ops_mailbox_id_account_fk";--> statement-breakpoint
ALTER TABLE "folder_ops" ADD CONSTRAINT "folder_ops_mailbox_id_account_fk" FOREIGN KEY ("mailbox_id", "account_id") REFERENCES "mailboxes" ("id", "account_id");--> statement-breakpoint
ALTER TABLE "folder_ops" DROP CONSTRAINT IF EXISTS "folder_ops_folder_id_mailbox_folders_id_fk";--> statement-breakpoint
ALTER TABLE "folder_ops" DROP CONSTRAINT IF EXISTS "folder_ops_folder_id_mailbox_fk";--> statement-breakpoint
ALTER TABLE "folder_ops" ADD CONSTRAINT "folder_ops_folder_id_mailbox_fk" FOREIGN KEY ("folder_id", "mailbox_id") REFERENCES "mailbox_folders" ("id", "mailbox_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "routing_decisions" DROP CONSTRAINT IF EXISTS "routing_decisions_message_id_messages_id_fk";--> statement-breakpoint
ALTER TABLE "routing_decisions" DROP CONSTRAINT IF EXISTS "routing_decisions_message_id_account_fk";--> statement-breakpoint
ALTER TABLE "routing_decisions" ADD CONSTRAINT "routing_decisions_message_id_account_fk" FOREIGN KEY ("message_id", "account_id") REFERENCES "messages" ("id", "account_id");--> statement-breakpoint
ALTER TABLE "routing_decisions" DROP CONSTRAINT IF EXISTS "routing_decisions_matched_rule_id_account_fk";--> statement-breakpoint
ALTER TABLE "routing_decisions" ADD CONSTRAINT "routing_decisions_matched_rule_id_account_fk" FOREIGN KEY ("matched_rule_id", "account_id") REFERENCES "rules" ("id", "account_id");--> statement-breakpoint
ALTER TABLE "approvals" DROP CONSTRAINT IF EXISTS "approvals_message_id_account_fk";--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_message_id_account_fk" FOREIGN KEY ("message_id", "account_id") REFERENCES "messages" ("id", "account_id");--> statement-breakpoint
ALTER TABLE "approvals" DROP CONSTRAINT IF EXISTS "approvals_routing_decision_id_account_fk";--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_routing_decision_id_account_fk" FOREIGN KEY ("routing_decision_id", "account_id") REFERENCES "routing_decisions" ("id", "account_id");--> statement-breakpoint
ALTER TABLE "message_states" DROP CONSTRAINT IF EXISTS "message_states_message_id_messages_id_fk";--> statement-breakpoint
ALTER TABLE "message_states" DROP CONSTRAINT IF EXISTS "message_states_message_id_account_fk";--> statement-breakpoint
ALTER TABLE "message_states" ADD CONSTRAINT "message_states_message_id_account_fk" FOREIGN KEY ("message_id", "account_id") REFERENCES "messages" ("id", "account_id");--> statement-breakpoint
ALTER TABLE "tracker_events" DROP CONSTRAINT IF EXISTS "tracker_events_message_id_messages_id_fk";--> statement-breakpoint
ALTER TABLE "tracker_events" DROP CONSTRAINT IF EXISTS "tracker_events_message_id_account_fk";--> statement-breakpoint
ALTER TABLE "tracker_events" ADD CONSTRAINT "tracker_events_message_id_account_fk" FOREIGN KEY ("message_id", "account_id") REFERENCES "messages" ("id", "account_id");--> statement-breakpoint
ALTER TABLE "attachments" DROP CONSTRAINT IF EXISTS "attachments_message_id_messages_id_fk";--> statement-breakpoint
ALTER TABLE "attachments" DROP CONSTRAINT IF EXISTS "attachments_message_id_account_fk";--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_message_id_account_fk" FOREIGN KEY ("message_id", "account_id") REFERENCES "messages" ("id", "account_id");--> statement-breakpoint
ALTER TABLE "message_tags" DROP CONSTRAINT IF EXISTS "message_tags_message_id_messages_id_fk";--> statement-breakpoint
ALTER TABLE "message_tags" DROP CONSTRAINT IF EXISTS "message_tags_message_id_account_fk";--> statement-breakpoint
ALTER TABLE "message_tags" ADD CONSTRAINT "message_tags_message_id_account_fk" FOREIGN KEY ("message_id", "account_id") REFERENCES "messages" ("id", "account_id");--> statement-breakpoint
ALTER TABLE "message_tags" DROP CONSTRAINT IF EXISTS "message_tags_tag_id_tags_id_fk";--> statement-breakpoint
ALTER TABLE "message_tags" DROP CONSTRAINT IF EXISTS "message_tags_tag_id_account_fk";--> statement-breakpoint
ALTER TABLE "message_tags" ADD CONSTRAINT "message_tags_tag_id_account_fk" FOREIGN KEY ("tag_id", "account_id") REFERENCES "tags" ("id", "account_id");--> statement-breakpoint
ALTER TABLE "unsubscribe_records" DROP CONSTRAINT IF EXISTS "unsubscribe_records_mailbox_id_mailboxes_id_fk";--> statement-breakpoint
ALTER TABLE "unsubscribe_records" DROP CONSTRAINT IF EXISTS "unsubscribe_records_mailbox_id_account_fk";--> statement-breakpoint
ALTER TABLE "unsubscribe_records" ADD CONSTRAINT "unsubscribe_records_mailbox_id_account_fk" FOREIGN KEY ("mailbox_id", "account_id") REFERENCES "mailboxes" ("id", "account_id");--> statement-breakpoint
ALTER TABLE "unsubscribe_records" DROP CONSTRAINT IF EXISTS "unsubscribe_records_message_id_messages_id_fk";--> statement-breakpoint
ALTER TABLE "unsubscribe_records" DROP CONSTRAINT IF EXISTS "unsubscribe_records_message_id_account_fk";--> statement-breakpoint
ALTER TABLE "unsubscribe_records" ADD CONSTRAINT "unsubscribe_records_message_id_account_fk" FOREIGN KEY ("message_id", "account_id") REFERENCES "messages" ("id", "account_id");--> statement-breakpoint
ALTER TABLE "contact_notes" DROP CONSTRAINT IF EXISTS "contact_notes_contact_id_contacts_id_fk";--> statement-breakpoint
ALTER TABLE "contact_notes" DROP CONSTRAINT IF EXISTS "contact_notes_contact_id_account_fk";--> statement-breakpoint
ALTER TABLE "contact_notes" ADD CONSTRAINT "contact_notes_contact_id_account_fk" FOREIGN KEY ("contact_id", "account_id") REFERENCES "contacts" ("id", "account_id");--> statement-breakpoint
ALTER TABLE "thread_notes" DROP CONSTRAINT IF EXISTS "thread_notes_thread_id_threads_id_fk";--> statement-breakpoint
ALTER TABLE "thread_notes" DROP CONSTRAINT IF EXISTS "thread_notes_thread_id_account_fk";--> statement-breakpoint
ALTER TABLE "thread_notes" ADD CONSTRAINT "thread_notes_thread_id_account_fk" FOREIGN KEY ("thread_id", "account_id") REFERENCES "threads" ("id", "account_id");--> statement-breakpoint
ALTER TABLE "drafts" DROP CONSTRAINT IF EXISTS "drafts_mailbox_id_mailboxes_id_fk";--> statement-breakpoint
ALTER TABLE "drafts" DROP CONSTRAINT IF EXISTS "drafts_mailbox_id_account_fk";--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_mailbox_id_account_fk" FOREIGN KEY ("mailbox_id", "account_id") REFERENCES "mailboxes" ("id", "account_id");--> statement-breakpoint
ALTER TABLE "drafts" DROP CONSTRAINT IF EXISTS "drafts_thread_id_threads_id_fk";--> statement-breakpoint
ALTER TABLE "drafts" DROP CONSTRAINT IF EXISTS "drafts_thread_id_account_fk";--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_thread_id_account_fk" FOREIGN KEY ("thread_id", "account_id") REFERENCES "threads" ("id", "account_id");--> statement-breakpoint
ALTER TABLE "drafts" DROP CONSTRAINT IF EXISTS "drafts_in_reply_to_message_id_messages_id_fk";--> statement-breakpoint
ALTER TABLE "drafts" DROP CONSTRAINT IF EXISTS "drafts_in_reply_to_message_id_account_fk";--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_in_reply_to_message_id_account_fk" FOREIGN KEY ("in_reply_to_message_id", "account_id") REFERENCES "messages" ("id", "account_id");--> statement-breakpoint
ALTER TABLE "outbound_sends" DROP CONSTRAINT IF EXISTS "outbound_sends_draft_id_drafts_id_fk";--> statement-breakpoint
ALTER TABLE "outbound_sends" DROP CONSTRAINT IF EXISTS "outbound_sends_draft_id_account_fk";--> statement-breakpoint
ALTER TABLE "outbound_sends" ADD CONSTRAINT "outbound_sends_draft_id_account_fk" FOREIGN KEY ("draft_id", "account_id") REFERENCES "drafts" ("id", "account_id") ON DELETE SET NULL ("draft_id");--> statement-breakpoint
ALTER TABLE "outbound_send_fingerprints" DROP CONSTRAINT IF EXISTS "outbound_send_fingerprints_send_id_fkey";--> statement-breakpoint
ALTER TABLE "outbound_send_fingerprints" DROP CONSTRAINT IF EXISTS "outbound_send_fingerprints_send_id_account_fk";--> statement-breakpoint
ALTER TABLE "outbound_send_fingerprints" ADD CONSTRAINT "outbound_send_fingerprints_send_id_account_fk" FOREIGN KEY ("send_id", "account_id") REFERENCES "outbound_sends" ("id", "account_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workflow_runs" DROP CONSTRAINT IF EXISTS "workflow_runs_workflow_id_workflows_id_fk";--> statement-breakpoint
ALTER TABLE "workflow_runs" DROP CONSTRAINT IF EXISTS "workflow_runs_workflow_id_account_fk";--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workflow_id_account_fk" FOREIGN KEY ("workflow_id", "account_id") REFERENCES "workflows" ("id", "account_id");--> statement-breakpoint
ALTER TABLE "away_replies" DROP CONSTRAINT IF EXISTS "away_replies_mailbox_id_account_fk";--> statement-breakpoint
ALTER TABLE "away_replies" ADD CONSTRAINT "away_replies_mailbox_id_account_fk" FOREIGN KEY ("mailbox_id", "account_id") REFERENCES "mailboxes" ("id", "account_id");--> statement-breakpoint
ALTER TABLE "away_replies" ALTER COLUMN "message_id" DROP NOT NULL;--> statement-breakpoint
UPDATE "away_replies" SET "message_id" = NULL WHERE NOT EXISTS (SELECT 1 FROM "messages" m WHERE m."id" = "away_replies"."message_id" AND m."account_id" = "away_replies"."account_id");--> statement-breakpoint
ALTER TABLE "away_replies" DROP CONSTRAINT IF EXISTS "away_replies_message_id_account_fk";--> statement-breakpoint
ALTER TABLE "away_replies" ADD CONSTRAINT "away_replies_message_id_account_fk" FOREIGN KEY ("message_id", "account_id") REFERENCES "messages" ("id", "account_id") ON DELETE SET NULL ("message_id");--> statement-breakpoint
UPDATE "away_responder_sent" SET "message_id" = NULL WHERE "message_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "messages" m WHERE m."id" = "away_responder_sent"."message_id" AND m."account_id" = "away_responder_sent"."account_id");--> statement-breakpoint
ALTER TABLE "away_responder_sent" DROP CONSTRAINT IF EXISTS "away_responder_sent_message_id_account_fk";--> statement-breakpoint
ALTER TABLE "away_responder_sent" ADD CONSTRAINT "away_responder_sent_message_id_account_fk" FOREIGN KEY ("message_id", "account_id") REFERENCES "messages" ("id", "account_id") ON DELETE SET NULL ("message_id");--> statement-breakpoint
ALTER TABLE "organizer_requests" DROP CONSTRAINT IF EXISTS "organizer_requests_mailbox_id_account_fk";--> statement-breakpoint
ALTER TABLE "organizer_requests" ADD CONSTRAINT "organizer_requests_mailbox_id_account_fk" FOREIGN KEY ("mailbox_id", "account_id") REFERENCES "mailboxes" ("id", "account_id");--> statement-breakpoint
ALTER TABLE "mailbox_profile_mirror" DROP CONSTRAINT IF EXISTS "mailbox_profile_mirror_mailbox_id_account_fk";--> statement-breakpoint
ALTER TABLE "mailbox_profile_mirror" ADD CONSTRAINT "mailbox_profile_mirror_mailbox_id_account_fk" FOREIGN KEY ("mailbox_id", "account_id") REFERENCES "mailboxes" ("id", "account_id");--> statement-breakpoint
ALTER TABLE "devices" DROP CONSTRAINT IF EXISTS "devices_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "devices" DROP CONSTRAINT IF EXISTS "devices_user_id_account_fk";--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_account_fk" FOREIGN KEY ("user_id", "account_id") REFERENCES "users" ("id", "account_id");--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_user_id_account_fk";--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_account_fk" FOREIGN KEY ("user_id", "account_id") REFERENCES "users" ("id", "account_id");--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_device_id_devices_id_fk";--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_device_id_account_fk";--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_device_id_account_fk" FOREIGN KEY ("device_id", "account_id") REFERENCES "devices" ("id", "account_id");--> statement-breakpoint
ALTER TABLE "refresh_tokens" DROP CONSTRAINT IF EXISTS "refresh_tokens_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "refresh_tokens" DROP CONSTRAINT IF EXISTS "refresh_tokens_user_id_account_fk";--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_account_fk" FOREIGN KEY ("user_id", "account_id") REFERENCES "users" ("id", "account_id");--> statement-breakpoint
ALTER TABLE "refresh_tokens" DROP CONSTRAINT IF EXISTS "refresh_tokens_session_id_sessions_id_fk";--> statement-breakpoint
ALTER TABLE "refresh_tokens" DROP CONSTRAINT IF EXISTS "refresh_tokens_session_id_account_fk";--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_session_id_account_fk" FOREIGN KEY ("session_id", "account_id") REFERENCES "sessions" ("id", "account_id");
