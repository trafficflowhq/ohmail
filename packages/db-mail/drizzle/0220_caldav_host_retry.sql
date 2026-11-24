-- Release connections held by the old CalDAV host backoff. Only the poll time is bookkeeping.
-- DEPLOY ORDER: stop the old worker, apply the migration, then start the new worker before resuming polls.
-- LOCK: row locks on the CalDAV connections whose poll times are reset by this update.
-- ROLLBACK: roll back the worker if needed. Leave poll times as they are and let the worker schedule them.
UPDATE "cal_connections"
SET "next_poll_at" = NULL
WHERE "provider" = 'caldav'
  AND "status" = 'failing'
  AND "error_code" = 'host_changed'
  AND "next_poll_at" > now();
