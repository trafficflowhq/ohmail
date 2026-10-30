-- 0173_device_header_words — the device finds a letter by its header words: names, recipients, file names.
-- device-only: the server's document already holds them as words (its head vector, and its text vector
-- for file names' parts); this store's word index stopped at the subject and the sender's address.
--
-- Two FTS5 tables keyed by the letter's own rowid, so a search reads each as a set of letters with no
-- lookup of the document: `message_people_fts`, the sender's and the recipients' names and addresses,
-- read with the subject; `message_files_fts`, the file names, read with the body, so a part of a name
-- ranks as a body word does. Contentless: written from the letter and its attachments whenever its
-- search document is, and deleted with the document or the letter. Each write deletes first: a
-- contentless table takes a second row under one rowid. Then filled for the documents already
-- written. Each part keeps the server's ceiling of 16,384 characters. The tokenizer splits at
-- `- _ . @`, so `harbour-ledger-7731.pdf` is four words; it stems the file names, as the server's
-- text vector does, and not the people, as its head does not. Replay-safe: every drop is `IF EXISTS`.

DROP TRIGGER IF EXISTS message_header_words_after_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS message_header_words_after_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS message_header_words_after_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS messages_header_words_after_delete;
--> statement-breakpoint
DROP TABLE IF EXISTS message_people_fts;
--> statement-breakpoint
DROP TABLE IF EXISTS message_files_fts;
--> statement-breakpoint
CREATE VIRTUAL TABLE message_people_fts USING fts5(
  people,
  content='',
  contentless_delete=1,
  tokenize='unicode61 remove_diacritics 2'
);
--> statement-breakpoint
CREATE VIRTUAL TABLE message_files_fts USING fts5(
  files,
  content='',
  contentless_delete=1,
  tokenize='porter unicode61 remove_diacritics 2'
);
--> statement-breakpoint
CREATE TRIGGER message_header_words_after_insert AFTER INSERT ON message_search BEGIN
  DELETE FROM message_people_fts WHERE rowid = (SELECT rowid FROM messages WHERE id = new.message_id);
  DELETE FROM message_files_fts WHERE rowid = (SELECT rowid FROM messages WHERE id = new.message_id);
  INSERT INTO message_people_fts(rowid, people) SELECT rowid, people FROM (SELECT m.rowid AS rowid, substr(trim(
      coalesce(m.from_name, '') || ' ' || m.from_address || ' ' ||
      coalesce((SELECT group_concat(coalesce(json_extract(e.value, '$.name'), '') || ' ' || coalesce(json_extract(e.value, '$.address'), ''), ' ')
        FROM json_each(CASE WHEN json_valid(m.to_addresses) THEN m.to_addresses ELSE '[]' END) e WHERE e.type = 'object'), '') || ' ' ||
      coalesce((SELECT group_concat(coalesce(json_extract(e.value, '$.name'), '') || ' ' || coalesce(json_extract(e.value, '$.address'), ''), ' ')
        FROM json_each(CASE WHEN json_valid(m.cc_addresses) THEN m.cc_addresses ELSE '[]' END) e WHERE e.type = 'object'), '')), 1, 16384) AS people
    FROM messages m WHERE m.id = new.message_id) WHERE people <> '';
  INSERT INTO message_files_fts(rowid, files) SELECT m.rowid, f.files FROM messages m,
    (SELECT substr(group_concat(a.filename, ' '), 1, 16384) AS files FROM attachments a
      WHERE a.account_id = new.account_id AND a.message_id = new.message_id AND a.filename IS NOT NULL) f
    WHERE m.id = new.message_id AND f.files IS NOT NULL;
END;
--> statement-breakpoint
CREATE TRIGGER message_header_words_after_update AFTER UPDATE ON message_search BEGIN
  DELETE FROM message_people_fts WHERE rowid IN (SELECT rowid FROM messages WHERE id IN (old.message_id, new.message_id));
  DELETE FROM message_files_fts WHERE rowid IN (SELECT rowid FROM messages WHERE id IN (old.message_id, new.message_id));
  INSERT INTO message_people_fts(rowid, people) SELECT rowid, people FROM (SELECT m.rowid AS rowid, substr(trim(
      coalesce(m.from_name, '') || ' ' || m.from_address || ' ' ||
      coalesce((SELECT group_concat(coalesce(json_extract(e.value, '$.name'), '') || ' ' || coalesce(json_extract(e.value, '$.address'), ''), ' ')
        FROM json_each(CASE WHEN json_valid(m.to_addresses) THEN m.to_addresses ELSE '[]' END) e WHERE e.type = 'object'), '') || ' ' ||
      coalesce((SELECT group_concat(coalesce(json_extract(e.value, '$.name'), '') || ' ' || coalesce(json_extract(e.value, '$.address'), ''), ' ')
        FROM json_each(CASE WHEN json_valid(m.cc_addresses) THEN m.cc_addresses ELSE '[]' END) e WHERE e.type = 'object'), '')), 1, 16384) AS people
    FROM messages m WHERE m.id = new.message_id) WHERE people <> '';
  INSERT INTO message_files_fts(rowid, files) SELECT m.rowid, f.files FROM messages m,
    (SELECT substr(group_concat(a.filename, ' '), 1, 16384) AS files FROM attachments a
      WHERE a.account_id = new.account_id AND a.message_id = new.message_id AND a.filename IS NOT NULL) f
    WHERE m.id = new.message_id AND f.files IS NOT NULL;
END;
--> statement-breakpoint
CREATE TRIGGER message_header_words_after_delete AFTER DELETE ON message_search BEGIN
  DELETE FROM message_people_fts WHERE rowid = (SELECT rowid FROM messages WHERE id = old.message_id);
  DELETE FROM message_files_fts WHERE rowid = (SELECT rowid FROM messages WHERE id = old.message_id);
END;
--> statement-breakpoint
CREATE TRIGGER messages_header_words_after_delete AFTER DELETE ON messages BEGIN
  DELETE FROM message_people_fts WHERE rowid = old.rowid;
  DELETE FROM message_files_fts WHERE rowid = old.rowid;
END;
--> statement-breakpoint
INSERT INTO message_people_fts(rowid, people) SELECT rowid, people FROM (SELECT m.rowid AS rowid, substr(trim(
    coalesce(m.from_name, '') || ' ' || m.from_address || ' ' ||
    coalesce((SELECT group_concat(coalesce(json_extract(e.value, '$.name'), '') || ' ' || coalesce(json_extract(e.value, '$.address'), ''), ' ')
      FROM json_each(CASE WHEN json_valid(m.to_addresses) THEN m.to_addresses ELSE '[]' END) e WHERE e.type = 'object'), '') || ' ' ||
    coalesce((SELECT group_concat(coalesce(json_extract(e.value, '$.name'), '') || ' ' || coalesce(json_extract(e.value, '$.address'), ''), ' ')
      FROM json_each(CASE WHEN json_valid(m.cc_addresses) THEN m.cc_addresses ELSE '[]' END) e WHERE e.type = 'object'), '')), 1, 16384) AS people
  FROM message_search s JOIN messages m ON m.id = s.message_id) WHERE people <> '';
--> statement-breakpoint
INSERT INTO message_files_fts(rowid, files) SELECT m.rowid, substr(group_concat(a.filename, ' '), 1, 16384)
  FROM message_search s JOIN messages m ON m.id = s.message_id
  JOIN attachments a ON a.account_id = s.account_id AND a.message_id = s.message_id
  WHERE a.filename IS NOT NULL GROUP BY m.rowid;
