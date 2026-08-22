-- THE JUNK+DELETE PLAN'S THREE COLUMNS (owner-ratified 2026-08-22).
--
-- ══ WHAT THIS ENABLES ══════════════════════════════════════════════════════════════════════
--
-- The product rule at packages/core/src/adapters/imap-types.ts was amended: the organizer still
-- never WATCHES the provider's \Junk/\Trash and never acts there on its own initiative, but
-- three USER-COMMANDED writes are now allowed — a spam verdict files to native \Junk, a not-junk
-- rescue moves back to INBOX, a delete moves to native \Trash (never an expunge). These columns
-- are the persistence those writes need:
--
--   mailboxes.junk_folder   text NULL   canonical path of the provider's \Junk, or NULL
--   mailboxes.trash_folder  text NULL   canonical path of the provider's \Trash, or NULL
--       Discovered at connect (ImapAdapter.findSpecialFolders: SPECIAL-USE first, then the
--       JUNK_BY_NAME/TRASH_BY_NAME belts) and re-written on every attach, so a renamed or
--       newly-created folder heals on the next connect. NULL = the mailbox genuinely has
--       neither flag nor recognisable name; the spam verdict then keeps the prior behaviour
--       byte-for-byte (files to ohmail/Quarantine, closed code no_junk_folder) and a delete is
--       refused up front (no_trash_folder) — the API may never open IMAP, which is why the
--       answer has to be a column and not a LIST.
--
--   messages.deleted_at     timestamptz NULL
--       When the message left the mirror's living views: a user delete (the message rides to
--       \Trash on the server) or the worker observing every watched instance expunged. The row
--       is kept — it is the message's identity (dedup_key, change_log, instances, threads all
--       hang off it) — and a re-appearance in a watched folder clears the stamp through the
--       adopt path. NULL for every existing row, honestly: nothing was deleted.
--
-- ══ ADDITIVE, IDEMPOTENT, NO INDEX ═════════════════════════════════════════════════════════
--
-- Three nullable ADD COLUMN IF NOT EXISTS, no defaults, no DML, no backfill. The reads are a
-- per-mailbox point lookup and predicates that ride existing scans; no index earns its keep.
--
-- ══ COMPATIBILITY AND DEPLOY ORDER ═════════════════════════════════════════════════════════
--
-- Migration → worker → API. The worker writes the discovery columns and the reconciler reads
-- them; the API reads trash_folder (delete refusal) and stamps deleted_at. Code deployed ahead
-- of this migration fails on 42703 at those sites; nothing else selects the columns.
--
-- ROLLBACK: drop the three columns. Junk filing falls back to Quarantine, delete disappears,
-- tombstones are forgotten — no user data is destroyed (the mailbox is the master throughout).

ALTER TABLE "mailboxes" ADD COLUMN IF NOT EXISTS "junk_folder" text;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN IF NOT EXISTS "trash_folder" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;--> statement-breakpoint

-- The withheld_reason CHECK widens by exactly two members (0062 closed it at 'storage_cap' so a
-- second reason would be "a deliberate migration rather than a typo" — this is that migration):
--   'junk_filed'  the spam verdict filed the message to the provider's native \Junk; the
--                 durable artifact is the sender rule and the bytes live on in Junk (master).
--   'expunged'    every watched copy is gone from the server; the row is tombstoned and the
--                 husk stops the account paying for bytes of mail the mailbox no longer holds.
-- Widening a CHECK re-validates nothing that already passed; existing rows are untouched.
ALTER TABLE "message_bodies" DROP CONSTRAINT IF EXISTS "message_bodies_withheld_reason";
--> statement-breakpoint
ALTER TABLE "message_bodies" ADD CONSTRAINT "message_bodies_withheld_reason"
  CHECK ("withheld_reason" IS NULL OR "withheld_reason" IN ('storage_cap', 'junk_filed', 'expunged'));
