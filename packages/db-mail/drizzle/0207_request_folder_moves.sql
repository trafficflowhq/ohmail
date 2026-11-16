-- 0207_request_folder_moves — a reader's move into one of the person's own folders travels to the organizer.
--
-- `message.file` joins the request kinds (0094's constraint, replaced under its name) and `no_such_folder`
-- the refusals (0145's, replaced under its name). Against a 0205 database a reader's door that queues such
-- a move is refused by the old kind CHECK, and the reader cannot record an organizer's refusal of one, so
-- its row never settles. Each list is the constraint's members plus the one new word; no row changes.
-- Idempotent (dropped, then added), as 0094 and 0145 are: a desktop engine replays this journal at launch.
-- ROLLBACK is restating both constraints as 0094 and 0145 left them, once no row carries a new member.

ALTER TABLE "organizer_requests" DROP CONSTRAINT IF EXISTS "organizer_requests_kind_closed";--> statement-breakpoint
ALTER TABLE "organizer_requests" ADD CONSTRAINT "organizer_requests_kind_closed"
  CHECK ("kind" IN (
    'screener.decide', 'rule.create', 'rule.update', 'rule.delete',
    'message.move', 'profile.update', 'message.file'
  ));--> statement-breakpoint
ALTER TABLE "organizer_requests" DROP CONSTRAINT IF EXISTS "organizer_requests_refused_reason_closed";--> statement-breakpoint
ALTER TABLE "organizer_requests" ADD CONSTRAINT "organizer_requests_refused_reason_closed"
  CHECK ("refused_reason" IS NULL OR "refused_reason" IN (
    'unauthenticated', 'conflict', 'wrong_mailbox', 'invalid_payload',
    'malformed', 'unhandled_kind', 'stale', 'account_erased',
    'no_such_message', 'no_trash_folder', 'no_such_rule', 'superseded',
    'no_such_folder'
  ));
