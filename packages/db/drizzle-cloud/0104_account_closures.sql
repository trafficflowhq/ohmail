-- AN ACCOUNT CLOSED BY STAFF (cloud 0104). A row stands while an account is closed: its sign-in
-- is refused and every session and device was signed out; nothing is deleted. Reopening removes
-- the row, and the history of both acts is the staff audit's. Nothing writes the table yet.
--
-- A Cloud table and not a column on `accounts`: `accounts` is in the mail journal, which every
-- desktop and phone runs, and closing an account is an act only a hosted service has staff for.
-- `closed_by_staff_id` is a pointer with no key, as the audit's staff columns are: the staff
-- tables belong to no account. `request_id` joins the row to the request that closed it.
--
-- The staff role reads all four columns: an account id, an instant, a staff id and a request id,
-- which is what the console shows of a closed account. It equals `scripts/harden-staff-role.sql`'s
-- `account_closures` stanza. Guarded on the role existing; the role name is unquoted for cloud
-- 0049's reason.
--
-- Servers only. Part of the 2.0 transition's window: applied once, by one transaction, on a store
-- nothing else writes to (`packages/db/src/transition/`). A store made from empty takes it as an
-- ordinary entry.
--
-- ROLLBACK: none in place. The transition rolls back whole; after it, a store is restored from
-- its copy.
-- @account_closures_create
CREATE TABLE "account_closures" (
  "account_id" uuid PRIMARY KEY NOT NULL,
  "closed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "closed_by_staff_id" uuid,
  "request_id" text NOT NULL,
  CONSTRAINT "account_closures_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "accounts"("id")
);
--> statement-breakpoint
-- @account_closures_staff_grant
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ohmail_admin') THEN
    REVOKE ALL ON TABLE "account_closures" FROM ohmail_admin;
    GRANT SELECT (account_id, closed_at, closed_by_staff_id, request_id)
      ON TABLE "account_closures" TO ohmail_admin;
  END IF;
END $$;
