-- 0175_device_part_words — the device reads the start of a word as typed, never by its stem.
-- device-only: the server's part-word arm reads a typed start against its own lexemes; this store's three
-- FTS5 `porter` tables stem a prefix term before they match it, so `ines`* read `in`* and every invoice.
--
-- Three FTS5 tables with the `unicode61` rules and no stemmer, read for the start of a word: the subject
-- and sender (`messages_part_fts`) and the body (`message_bodies_part_fts`) over the rows they index, the
-- file names (`message_files_part_fts`) contentless as 0173's, written whenever its document is. They keep
-- no positions (`detail=none`): a start is asked of one word, never of a phrase. Their own triggers keep
-- them, and 0138's and 0173's are not touched; then they are filled from the rows already there.
-- Replay-safe: every drop is `IF EXISTS`, and a second run builds the same tables again.

DROP TRIGGER IF EXISTS messages_part_fts_after_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS messages_part_fts_after_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS messages_part_fts_after_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS message_bodies_part_fts_after_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS message_bodies_part_fts_after_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS message_bodies_part_fts_after_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS message_part_words_after_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS message_part_words_after_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS message_part_words_after_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS messages_part_words_after_delete;
--> statement-breakpoint
DROP TABLE IF EXISTS messages_part_fts;
--> statement-breakpoint
DROP TABLE IF EXISTS message_bodies_part_fts;
--> statement-breakpoint
DROP TABLE IF EXISTS message_files_part_fts;
--> statement-breakpoint
CREATE VIRTUAL TABLE messages_part_fts USING fts5(
  subject, from_address,
  content='messages',
  content_rowid='rowid',
  detail=none,
  columnsize=0,
  tokenize='unicode61 remove_diacritics 2'
);
--> statement-breakpoint
CREATE VIRTUAL TABLE message_bodies_part_fts USING fts5(
  text,
  content='message_bodies',
  content_rowid='rowid',
  detail=none,
  columnsize=0,
  tokenize='unicode61 remove_diacritics 2'
);
--> statement-breakpoint
CREATE VIRTUAL TABLE message_files_part_fts USING fts5(
  files,
  content='',
  contentless_delete=1,
  detail=none,
  tokenize='unicode61 remove_diacritics 2'
);
--> statement-breakpoint
CREATE TRIGGER messages_part_fts_after_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_part_fts(rowid, subject, from_address) VALUES (new.rowid, new.subject, new.from_address);
END;
--> statement-breakpoint
CREATE TRIGGER messages_part_fts_after_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_part_fts(messages_part_fts, rowid, subject, from_address) VALUES ('delete', old.rowid, old.subject, old.from_address);
END;
--> statement-breakpoint
CREATE TRIGGER messages_part_fts_after_update AFTER UPDATE OF subject, from_address ON messages BEGIN
  INSERT INTO messages_part_fts(messages_part_fts, rowid, subject, from_address) VALUES ('delete', old.rowid, old.subject, old.from_address);
  INSERT INTO messages_part_fts(rowid, subject, from_address) VALUES (new.rowid, new.subject, new.from_address);
END;
--> statement-breakpoint
CREATE TRIGGER message_bodies_part_fts_after_insert AFTER INSERT ON message_bodies BEGIN
  INSERT INTO message_bodies_part_fts(rowid, text) VALUES (new.rowid, new.text);
END;
--> statement-breakpoint
CREATE TRIGGER message_bodies_part_fts_after_delete AFTER DELETE ON message_bodies BEGIN
  INSERT INTO message_bodies_part_fts(message_bodies_part_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
--> statement-breakpoint
CREATE TRIGGER message_bodies_part_fts_after_update AFTER UPDATE OF text ON message_bodies BEGIN
  INSERT INTO message_bodies_part_fts(message_bodies_part_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO message_bodies_part_fts(rowid, text) VALUES (new.rowid, new.text);
END;
--> statement-breakpoint
CREATE TRIGGER message_part_words_after_insert AFTER INSERT ON message_search BEGIN
  DELETE FROM message_files_part_fts WHERE rowid = (SELECT rowid FROM messages WHERE id = new.message_id);
  INSERT INTO message_files_part_fts(rowid, files) SELECT m.rowid, f.files FROM messages m,
    (SELECT substr(group_concat(a.filename, ' '), 1, 16384) AS files FROM attachments a
      WHERE a.account_id = new.account_id AND a.message_id = new.message_id AND a.filename IS NOT NULL) f
    WHERE m.id = new.message_id AND f.files IS NOT NULL;
END;
--> statement-breakpoint
CREATE TRIGGER message_part_words_after_update AFTER UPDATE ON message_search BEGIN
  DELETE FROM message_files_part_fts WHERE rowid IN (SELECT rowid FROM messages WHERE id IN (old.message_id, new.message_id));
  INSERT INTO message_files_part_fts(rowid, files) SELECT m.rowid, f.files FROM messages m,
    (SELECT substr(group_concat(a.filename, ' '), 1, 16384) AS files FROM attachments a
      WHERE a.account_id = new.account_id AND a.message_id = new.message_id AND a.filename IS NOT NULL) f
    WHERE m.id = new.message_id AND f.files IS NOT NULL;
END;
--> statement-breakpoint
CREATE TRIGGER message_part_words_after_delete AFTER DELETE ON message_search BEGIN
  DELETE FROM message_files_part_fts WHERE rowid = (SELECT rowid FROM messages WHERE id = old.message_id);
END;
--> statement-breakpoint
CREATE TRIGGER messages_part_words_after_delete AFTER DELETE ON messages BEGIN
  DELETE FROM message_files_part_fts WHERE rowid = old.rowid;
END;
--> statement-breakpoint
INSERT INTO messages_part_fts(messages_part_fts) VALUES('rebuild');
--> statement-breakpoint
INSERT INTO message_bodies_part_fts(message_bodies_part_fts) VALUES('rebuild');
--> statement-breakpoint
INSERT INTO message_files_part_fts(rowid, files) SELECT m.rowid, substr(group_concat(a.filename, ' '), 1, 16384)
  FROM message_search s JOIN messages m ON m.id = s.message_id
  JOIN attachments a ON a.account_id = s.account_id AND a.message_id = s.message_id
  WHERE a.filename IS NOT NULL GROUP BY m.rowid;
