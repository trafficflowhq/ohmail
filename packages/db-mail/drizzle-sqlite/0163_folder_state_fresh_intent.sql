-- 0163_folder_state_fresh_intent — the pg entry's twin: a change of desired_folder resets the
-- schedule and the refusal class. An AFTER trigger (0160's pattern); its own guard stops it
-- rewriting a row that is already fresh. Replay-safe.

CREATE TRIGGER IF NOT EXISTS folder_state_fresh_intent AFTER UPDATE OF desired_folder ON folder_state
  WHEN NEW."desired_folder" IS NOT OLD."desired_folder"
BEGIN
  UPDATE folder_state SET attempts = 0, next_attempt_at = NULL, last_error_class = NULL
   WHERE id = NEW.id AND (attempts <> 0 OR next_attempt_at IS NOT NULL OR last_error_class IS NOT NULL);
END;
