-- THE STORAGE ESTIMATE, THE CARD'S DISMISSAL AND THE STORAGE MAILS (cloud 0057). Three new tables; no
-- existing table changes.
--
-- mailbox_storage_stats: one row per mailbox, the worker's snapshot of the numbers the storage estimate
-- needs and a request may not count (`apps/worker/src/storage-stats.ts`): the letters ohmail holds, those
-- holding text, those emptied for space, their text bytes, their server copies (`message_instances`), and
-- the folder counts and first import as they stood. Counts, booleans and an instant, never content: the
-- staff role reads it whole for the console's Expected figure (granted below, 0054's lesson).
-- account_storage_prefs: one row per account, the storage card the person dismissed (its level, the cap,
-- the emptied count and the drop's date it was dismissed at, and when) and when they turned the storage
-- mails off.
-- storage_mail_sent: one row per storage mail: (account, level, cap) is the key, so one level at one cap
-- is mailed once; the newest `sent_at` keeps two mails a week apart.
--
-- CLOUD, not mail: only the hosted worker and API keep them. `deleteAccount` deletes all three (`accounts`
-- survives erasure, so the CASCADE never fires); the mailbox erasure pass deletes the mailbox's stats row.
--
-- LOCK-WAIT: none on a populated table. Each foreign key takes SHARE ROW EXCLUSIVE on `accounts` until the
-- cloud pass commits: a sign-up or an erasure stamp waits that long.
-- DEPLOY ORDER: migration, then the API and the worker straight after. Until the API is deployed, an old
-- API's cold start reads the new grant as an excess and refuses the staff handle (closed: the console and
-- the API's alert arm answer 503). An API ahead of the migration answers /health 503 schema_incomplete.
-- ROLLBACK: the API and the worker first, then DROP TABLE the three.

CREATE TABLE IF NOT EXISTS "mailbox_storage_stats" (
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "mailbox_id" uuid NOT NULL,
  "letters" integer NOT NULL,
  "text_letters" integer NOT NULL,
  "emptied" integer NOT NULL,
  "text_bytes" bigint NOT NULL,
  "instances" integer NOT NULL,
  "server_letters" integer,
  "counted" boolean NOT NULL,
  "imported" boolean NOT NULL,
  "at" timestamp with time zone NOT NULL,
  CONSTRAINT "mailbox_storage_stats_pk" PRIMARY KEY ("account_id", "mailbox_id"),
  CONSTRAINT "mailbox_storage_stats_counts" CHECK ("letters" >= 0 AND "text_letters" >= 0 AND "emptied" >= 0
    AND "text_bytes" >= 0 AND "instances" >= 0 AND ("server_letters" IS NULL OR "server_letters" >= 0)),
  CONSTRAINT "mailbox_storage_stats_within" CHECK ("text_letters" + "emptied" <= "letters")
);
--> statement-breakpoint

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ohmail_admin') THEN
    REVOKE ALL ON TABLE "mailbox_storage_stats" FROM ohmail_admin;
    GRANT SELECT (account_id, mailbox_id, letters, text_letters, emptied, text_bytes, instances,
      server_letters, counted, imported, at)
      ON TABLE "mailbox_storage_stats" TO ohmail_admin;
  END IF;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "account_storage_prefs" (
  "account_id" uuid PRIMARY KEY REFERENCES "accounts"("id") ON DELETE CASCADE,
  "card_dismissed_level" text,
  "card_dismissed_cap" bigint,
  "card_dismissed_emptied" integer,
  "card_dismissed_drops_at" timestamp with time zone,
  "card_dismissed_at" timestamp with time zone,
  "mail_off_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "account_storage_prefs_level_closed" CHECK ("card_dismissed_level" IS NULL
    OR "card_dismissed_level" IN ('near', 'full', 'drop')),
  CONSTRAINT "account_storage_prefs_dismissal_whole" CHECK (("card_dismissed_level" IS NULL) = ("card_dismissed_at" IS NULL)
    AND ("card_dismissed_level" IS NULL) = ("card_dismissed_cap" IS NULL)
    AND ("card_dismissed_level" IS NULL) = ("card_dismissed_emptied" IS NULL))
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "storage_mail_sent" (
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "level" text NOT NULL,
  "cap_bytes" bigint NOT NULL,
  "sent_at" timestamp with time zone DEFAULT now() NOT NULL,
  "delivered_at" timestamp with time zone,
  CONSTRAINT "storage_mail_sent_pk" PRIMARY KEY ("account_id", "level", "cap_bytes"),
  CONSTRAINT "storage_mail_sent_level_closed" CHECK ("level" IN ('near', 'full')),
  CONSTRAINT "storage_mail_sent_cap_positive" CHECK ("cap_bytes" > 0)
);
