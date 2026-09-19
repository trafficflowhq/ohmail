-- The fixed-age auth_events prune deletes by `at`; without this index every maintenance tick is
-- a full scan of the login ledger. `(user_id, at)` serves the user's own history list and the
-- reuse partial serves the alert rule — neither serves a bare age range. Additive, IF NOT EXISTS.
-- ROLLBACK: DROP INDEX auth_events_at_idx.

CREATE INDEX IF NOT EXISTS "auth_events_at_idx" ON "auth_events" ("at");
