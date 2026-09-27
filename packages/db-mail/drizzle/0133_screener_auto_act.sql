-- THE ACT ON SUGGESTIONS: ITS OWN CONSENT, AND WHAT IT COULD NOT DO (mail 0133).
--
-- `account_settings.screener_auto_act_at`: when the account let the Screener file a waiting sender
-- whose stored suggestion is confident; NULL is off, and nothing else arms the act. On a stored
-- suggestion (`routing_decisions`, provenance 'screener_suggestion'), `act_refused_at` and
-- `act_refusal` say the act tried to file that sender and was refused, so the Screener row can say
-- so; the next successful act clears both. Additive, `IF NOT EXISTS`, no default, no backfill. The
-- CHECK is NOT VALID (every existing row is NULL, and the table grows with every decision).
-- ROLLBACK: three DROP COLUMNs.

ALTER TABLE "account_settings" ADD COLUMN IF NOT EXISTS "screener_auto_act_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "routing_decisions" ADD COLUMN IF NOT EXISTS "act_refused_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "routing_decisions" ADD COLUMN IF NOT EXISTS "act_refusal" text;
--> statement-breakpoint
ALTER TABLE "routing_decisions" DROP CONSTRAINT IF EXISTS "routing_decisions_act_refusal_closed";
--> statement-breakpoint
ALTER TABLE "routing_decisions" ADD CONSTRAINT "routing_decisions_act_refusal_closed"
  CHECK ("act_refusal" in ('account_erased', 'not_organizer', 'mailbox_removed', 'store_fault')) NOT VALID;
