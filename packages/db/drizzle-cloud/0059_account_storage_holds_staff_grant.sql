-- THE STAFF ROLE'S GRANT ON HELD STORAGE LIMITS (cloud 0059), for a database migrated but not re-hardened.
--
-- 0055 created `account_storage_holds` and said "No staff grant", while the same change made the at-cap
-- reader read it: the API's alert pass runs as `ohmail_admin`, so its storage-cap rule was refused with
-- 42501 on every pass. This file is that correction (0055 is released and stays as it shipped).
--
-- It equals `scripts/harden-staff-role.sql`'s `account_storage_holds` stanza, after the same `REVOKE ALL`:
-- SELECT on the table's five columns (limits in bytes and instants), no table-level privilege, no write.
-- Guarded on the role existing, so local, PGlite, self-hosted and CI databases are untouched. The role
-- name is UNQUOTED for 0049's reason: `journal-split.test.ts` reads `FROM "x"` as a relation.
--
-- LOCK-WAIT: none for reads and writes; it changes catalog rows only.
-- DEPLOY ORDER: migration, then the API straight after (0057's window). Until the API is deployed, an old
-- API's cold start reads the new grant as an excess and refuses the staff handle (closed: the console and
-- the API's alert arm answer 503; running instances and the worker carry on). Keep the gap under the
-- 15-minute api_cron_stale floor. An API ahead of the migration is safe: a missing grant passes at boot.
-- ROLLBACK: where the role exists, `REVOKE ALL ON TABLE account_storage_holds FROM ohmail_admin` before an
-- older API is deployed.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ohmail_admin') THEN
    REVOKE ALL ON TABLE "account_storage_holds" FROM ohmail_admin;
    GRANT SELECT (account_id, seen_bytes, held_bytes, held_until, updated_at)
      ON TABLE "account_storage_holds" TO ohmail_admin;
  END IF;
END $$;
