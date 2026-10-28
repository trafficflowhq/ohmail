-- 0170_outbound_sent_copies — the pg table's twin: a delivered send's Sent copy, owed until filed.
-- Integer epoch ms for the instants; the composite key references 0118's unique index.

CREATE TABLE IF NOT EXISTS "outbound_sent_copies" (
  "send_id" text NOT NULL,
  "seq" integer NOT NULL DEFAULT 0,
  "account_id" text NOT NULL,
  "mailbox_id" text NOT NULL,
  "raw_b64" text NOT NULL,
  "attempts" integer NOT NULL DEFAULT 0,
  "next_attempt_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  "created_at" integer NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  CONSTRAINT "outbound_sent_copies_account_id_send_id_seq_pk" PRIMARY KEY ("account_id", "send_id", "seq"),
  CONSTRAINT "outbound_sent_copies_send_account_fk" FOREIGN KEY ("send_id", "account_id")
    REFERENCES "outbound_sends" ("id", "account_id") ON DELETE CASCADE
);
