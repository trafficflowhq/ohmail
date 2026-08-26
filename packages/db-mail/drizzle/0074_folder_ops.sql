-- USER-COMMANDED FOLDER OPERATIONS — the folders stage-2 verbs (create / rename / delete from
-- the rail; FOLDERS-SPEC.md stage 2, owner-ordered 2026-08-26).
--
-- ADDITIVE ONLY: one new table, two foreign keys, three CHECKs, one UNIQUE. No ALTER on an
-- existing table, no backfill, no data statement.
--
-- ══ WHAT THE TABLE IS ════════════════════════════════════════════════════════════════════════
--
-- A folder verb is a REAL IMAP write in the user's own mailbox — CREATE, RENAME (the subtree
-- moves with it), DELETE (messages filed to native \Trash first, never expunged). The API never
-- opens IMAP to organize, so it records the user's COMMAND here, appends the `folder` change row
-- that lets every client render the pending state honestly, and rings `sync_requested_at`; the
-- worker executes the command inside the mailbox's serial cycle (exactly one organizer), applies
-- the database consequences in one transaction, and DELETES the row. `folder_state`'s
-- desired/observed split, lifted one level to the folder tree.
--
-- ══ THE CONSTRAINTS ARE THE MODEL ════════════════════════════════════════════════════════════
--
--   UNIQUE (folder_id)
--       ONE command in flight per folder. Two pending commands on one subject have no defined
--       order — the API refuses the second with the honest sentence instead of inventing one.
--
--   CHECK folder_ops_op_closed / folder_ops_status_closed
--       Both sets are closed because both are OURS: no mail server and no client can mint a
--       member. `status` has no 'done' — a completed op is a DELETED row (change_log carries
--       the history); 'failed' rows persist only to carry the honest refusal to the entity.
--
--   CHECK folder_ops_rename_target
--       `to_folder` exists exactly when the op is a rename. A create with a target or a rename
--       without one is a caller bug, and the database is where caller bugs stop.
--
--   ON DELETE CASCADE (folder_id → mailbox_folders.id)
--       An op cannot outlive its subject: account deletion and inventory pruning take the
--       command record with the row.
--
-- ══ COMPATIBILITY AND DEPLOY ORDER ═══════════════════════════════════════════════════════════
--
-- Migration → API → worker. An API deployed ahead of this 42703s only the NEW /folders verbs
-- (nothing shipped calls them); the health marker ["folder_ops","id"] turns a half-deployed
-- state into 503 schema_incomplete naming this file. The worker half is additive: a worker
-- deployed ahead of the migration reads no such table until its folder-op pass ships beside it.
--
-- ROLLBACK is DROP TABLE: the verbs refuse, nothing else moves. Pending commands are lost —
-- which is honest, because nothing would ever execute them.

CREATE TABLE IF NOT EXISTS "folder_ops" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "mailbox_id" uuid NOT NULL,
  "folder_id" uuid NOT NULL,
  "op" text NOT NULL,
  "to_folder" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "error" text,
  "attempts" integer DEFAULT 0 NOT NULL,
  "requested_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "folder_ops_folder_id_unique" UNIQUE("folder_id"),
  CONSTRAINT "folder_ops_op_closed" CHECK ("op" IN ('create','rename','delete')),
  CONSTRAINT "folder_ops_status_closed" CHECK ("status" IN ('pending','failed')),
  CONSTRAINT "folder_ops_rename_target" CHECK (("op" = 'rename') = ("to_folder" IS NOT NULL))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "folder_ops" ADD CONSTRAINT "folder_ops_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "folder_ops" ADD CONSTRAINT "folder_ops_folder_id_mailbox_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."mailbox_folders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
