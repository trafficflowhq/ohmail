-- 0170_outbound_sent_copies — a delivered send's Sent copy, owed until it is filed.
--
-- The local engine (desktop and phone) records the delivered bytes here right after the server's
-- accept and before the first APPEND, and deletes the row once the copy is in Sent. A quit, a crash
-- or a long IMAP outage then leaves the row for the next drain to file (`SendService.fileOwedCopies`),
-- which looks in Sent first. Cloud and self-host write no rows.
-- One row per piece of a send's bytes (`seq` from 0), each written once: an append rewrites the whole
-- value, and the desktop's store has no autovacuum. `raw_b64` is text so every store carries it the
-- same way. The composite key pins the account and cascades with the send; no key on `mailbox_id`
-- (a KEY SHARE lock on the mailbox row per insert, the 0118 fingerprints argument), no index beyond
-- the primary key (rows live only while a copy is owed).
-- Nothing granted to staff; MAIL content.
-- LOCK-WAIT: the key takes SHARE ROW EXCLUSIVE on outbound_sends until the pass commits, and locks no other
-- live table. It waits for every open transaction that wrote outbound_sends (an account erasure holds one to
-- its end) and meanwhile holds back new writes to it; reads pass. Live sends lock outbound_sends, drafts and
-- mailboxes in both orders, so this is the only mail entry of its release: beside a drafts or mailboxes
-- ALTER the pass deadlocks (40P01, measured). One key only: a second key to a live table deadlocks alone.
-- DEPLOY ORDER: migration, then API, then worker, then web.
-- ROLLBACK: revert the code, then DROP TABLE IF EXISTS "outbound_sent_copies" in its own transaction under a
-- lock_timeout: the drop takes ACCESS EXCLUSIVE on outbound_sends, so every send read and write waits for it.

CREATE TABLE IF NOT EXISTS "outbound_sent_copies" (
  "send_id" uuid NOT NULL,
  "seq" integer DEFAULT 0 NOT NULL,
  "account_id" uuid NOT NULL,
  "mailbox_id" uuid NOT NULL,
  "raw_b64" text NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "outbound_sent_copies_account_id_send_id_seq_pk" PRIMARY KEY ("account_id", "send_id", "seq"),
  CONSTRAINT "outbound_sent_copies_send_account_fk" FOREIGN KEY ("send_id", "account_id")
    REFERENCES "outbound_sends" ("id", "account_id") ON DELETE CASCADE
);
