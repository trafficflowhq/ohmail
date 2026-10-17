-- THE STAFF ROLE'S GRANT ON THE GAP HISTORY (cloud 0049), for a database migrated but not re-hardened.
--
-- 0048 created `alert_driver_gaps`, and the API's alert pass writes it as `ohmail_admin` in the same
-- statement that stamps `alert_pass_runs` (`recordAlertPass`). `scripts/harden-staff-role.sql` sets
-- no default privileges, so a new table reaches that role only when the script is re-run; until
-- then the whole stamp fails, `alert_pass_runs` included, and the worker reports the API arm dark.
--
-- `scripts/harden-staff-role.sql` remains the source of these grants: this is its belt, as 0007's and
-- 0036's REVOKEs are for theirs. It grants exactly what the script's `alert_driver_gaps` stanza
-- grants, after the same `REVOKE ALL`: SELECT, INSERT and UPDATE on the table's five columns, no
-- table-level privilege, and no DELETE (the worker prunes on its own connection). The script and
-- this migration therefore leave the same privileges in either order.
--
-- Guarded on the role existing: local, PGlite, self-hosted and CI databases have no `ohmail_admin`,
-- and there this does nothing. The role name is UNQUOTED for 0007's reason: `journal-split.test.ts`
-- reads `FROM "x"` as a relation, and here the FROM names a role.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ohmail_admin') THEN
    REVOKE ALL ON TABLE "alert_driver_gaps" FROM ohmail_admin;
    GRANT SELECT (driver, day, passes, max_gap_s, max_gap_at) ON TABLE "alert_driver_gaps" TO ohmail_admin;
    GRANT INSERT (driver, day, passes, max_gap_s, max_gap_at) ON TABLE "alert_driver_gaps" TO ohmail_admin;
    GRANT UPDATE (driver, day, passes, max_gap_s, max_gap_at) ON TABLE "alert_driver_gaps" TO ohmail_admin;
  END IF;
END $$;
