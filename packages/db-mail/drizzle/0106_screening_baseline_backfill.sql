-- A CONSENTED MAILBOX WITH NO SCREENING BASELINE — the rows the old door left behind.
--
-- `screening_baseline_at` was stamped only when a consent carried a window, so every door that
-- asked no window wrote `organize_consented_at` and left the baseline NULL. NULL is "no cutoff":
-- the cutline is `(screening_baseline_at ?? now()) - dormancy_days`, so the window is measured
-- from the READ rather than from the agreement and slides forward for ever. On a mailbox with any
-- history that holds the sender's whole backlog at the gate, whatever window was chosen.
--
-- The doors now stamp at consent, unconditionally. This is the half that cannot be fixed forward:
-- accounts that consented under the old code carry the NULL today. Each gets the instant it FIRST
-- agreed — `MIN(organize_consented_at)` over its consented mailboxes, which is when that account's
-- screening history began. An earlier baseline holds strictly LESS mail than NULL does, so the
-- correction can only release mail from the gate, never send more to it.
--
-- INSERT … ON CONFLICT rather than UPDATE, because an account that never opened a settings pane
-- has no `account_settings` row at all, and an absent row reads exactly like a NULL baseline. The
-- `WHERE` on the conflict arm is what makes it idempotent and what keeps it off a live account: a
-- baseline already in force is never moved, here or anywhere else.
--
-- ROLLBACK is `UPDATE account_settings SET screening_baseline_at = NULL` for the accounts this
-- touched, which is not recoverable from the row itself — so the reverse of this step is "leave it
-- alone". Nothing downstream requires the column to be NULL.

INSERT INTO "account_settings" ("account_id", "screening_baseline_at", "updated_at")
SELECT m."account_id", MIN(m."organize_consented_at"), now()
  FROM "mailboxes" m
 WHERE m."organize_consented_at" IS NOT NULL
 GROUP BY m."account_id"
ON CONFLICT ("account_id") DO UPDATE
   SET "screening_baseline_at" = EXCLUDED."screening_baseline_at",
       "updated_at" = now()
 WHERE "account_settings"."screening_baseline_at" IS NULL;
