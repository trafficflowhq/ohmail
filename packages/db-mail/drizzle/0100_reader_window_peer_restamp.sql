-- Mail this install adopted from a folder ohmail organizes was recorded as if a person had filed
-- it by hand. Every pass that revisits a filing skips such a row on purpose — a hand placement is
-- not ours to undo — so those messages sit where they landed for ever, behind a rule their owner
-- had already written. The writer records those adoptions correctly now ('peer': another install
-- of the same account placed it, which a rule may still revisit). Rows written before that are
-- re-stamped here, once.
--
-- Three terms carry the safety argument, and each one excludes a shape that must not be touched:
--
--   · the pair AGREES and names a folder inside the ohmail namespace. Only an install of this
--     account ever writes there, so a folder the person made and their own inbox are both out —
--     and with them every placement held while the decision about existing mail is still open,
--     which arrives wherever the mail server delivered it.
--   · no `move` in the change log for this message. Moving mail in one's own mail client writes
--     one, and the change log is never pruned, so this is durable evidence rather than a
--     retention window.
--   · the row predates the corrected writer, which is what makes this a one-time repair and not
--     a standing rule.
--
-- The row count is raised as a notice so an operator can see what it touched.

DO $$
DECLARE touched bigint;
BEGIN
  UPDATE "folder_state" fs SET "last_set_by" = 'peer'
  FROM "messages" m
  WHERE fs."message_id" = m."id"
    AND fs."last_set_by" = 'external'
    AND fs."desired_folder" = fs."observed_folder"
    AND fs."desired_folder" IN (
      'ohmail/Screener', 'ohmail/Reads', 'ohmail/Receipts', 'ohmail/Screened', 'ohmail/Quarantine'
    )
    AND m."created_at" < timestamptz '2026-09-09 00:00:00+00'
    AND NOT EXISTS (
      SELECT 1 FROM "change_log" cl
      WHERE cl."entity_type" = 'message' AND cl."entity_id" = fs."message_id" AND cl."op" = 'move'
    );
  GET DIAGNOSTICS touched = ROW_COUNT;
  RAISE NOTICE 'folder_state rows re-stamped from external to peer: %', touched;
END $$;
