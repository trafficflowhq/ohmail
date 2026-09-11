-- A PHONE IS AN ORGANIZER KIND — `mobile` joins both closed sets on `mailboxes`.
--
-- A standalone phone stamps `X-Ohmail-Organizer-Kind: mobile` into the claim it writes to
-- `ohmail/_meta`. Until now no reader could rank that value: it parsed as `unknown`, which the
-- lease gate reads as a live claim by a peer it cannot rank. The phone's own renew residue —
-- a renew APPENDS before it expunges, so the folder briefly holds two of its claims at different
-- nonces — was exactly such a claim, so the phone stood down from its own mailbox every cycle
-- and no press could end it. A phone is the one install whose own kind it cannot rank.
--
-- Two columns, because the kind reaches the row twice: `organized_by_kind` records WHO holds the
-- mailbox when we do not, and `disabled_reason` carries the same word as the suffix of the
-- stand-down reason a person is shown. Widening one alone makes the other refuse the write.
--
-- Idempotent (dropped-then-added, the shape `0102_sync_blocked_reason_read_limited` uses for the
-- same widening), because a desktop engine replays this journal at every launch. Neither statement
-- can fail on a live table: no rows are rewritten and no existing value is outside the wider set.

ALTER TABLE "mailboxes" DROP CONSTRAINT IF EXISTS "mailboxes_organized_by_kind_closed";--> statement-breakpoint

ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_organized_by_kind_closed"
  CHECK ("organized_by_kind" IS NULL OR "organized_by_kind" IN (
    'cloud', 'local', 'mobile', 'unknown'
  ));--> statement-breakpoint

ALTER TABLE "mailboxes" DROP CONSTRAINT IF EXISTS "mailboxes_disabled_reason_closed";--> statement-breakpoint

ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_disabled_reason_closed"
  CHECK ("disabled_reason" IS NULL OR "disabled_reason" IN (
    'organized_elsewhere:cloud', 'organized_elsewhere:local',
    'organized_elsewhere:mobile', 'organized_elsewhere:unknown'
  ));
