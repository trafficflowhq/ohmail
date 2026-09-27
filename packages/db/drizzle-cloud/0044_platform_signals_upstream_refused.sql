-- A SIGNAL WALK REFUSED PART-WAY KEEPS WHAT IT COUNTED (cloud 0044). The five-minute platform
-- signals poll threw away the pages it had already counted when a later page answered non-OK,
-- failed in transport or could not be parsed, so a busy window wrote no row and the 5xx rule went
-- dark for it. It now writes that window as a sample under the cause `upstream_refused`, which the
-- `sample_cause` CHECK must admit. The other seven words are 0030's, unchanged.
--
-- NOT VALID, on 0041/0042's precedent: platform_signals is a growth table, and every existing row
-- already passed 0030's seven-word CHECK, a subset of this eight-word one, so nothing is re-read.
-- DEPLOY ORDER: migration, then API (a sample written ahead of it is refused by the old CHECK and
-- the poll answers 502, as it did before). ROLLBACK is 0030's definition, after the API.

ALTER TABLE "platform_signals" DROP CONSTRAINT IF EXISTS "platform_signals_sample_cause_check";
--> statement-breakpoint

ALTER TABLE "platform_signals" ADD CONSTRAINT "platform_signals_sample_cause_check"
  CHECK ("sample_cause" IS NULL OR "sample_cause" IN (
    'page_budget', 'settle_margin', 'missing_provenance', 'unreadable_request_id',
    'deadline', 'stalled_cursor', 'boundary_unread', 'upstream_refused')) NOT VALID;
