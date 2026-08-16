-- ─────────────────────────────────────────────────────────────────────────────────────────
-- STRUCTURAL STAFF ISOLATION. Creates and provisions `ohmail_admin`, the content-blind staff role.
--
-- Run by hand:  psql "$DATABASE_URL_DIRECT" -v ON_ERROR_STOP=1 -f scripts/harden-staff-role.sql
-- then set the password out of band:  ALTER ROLE ohmail_admin PASSWORD '…';
-- then point `DATABASE_URL_ADMIN` (the -pooler host) at it.
--
-- ## RUN THE PRE-FLIGHT FIRST. This script CAN REFUSE. (read-only, seconds)
--
-- Three conditions abort the transaction rather than provision through them, because none of
-- them can be repaired without changing what OTHER roles can do. Every one of them is a
-- property of the database you are pointing at, not of this file, so find out before the
-- window rather than during it. Each query must return ZERO rows:
--
--   -- 1. §12 — relation or column privileges granted to PUBLIC in public/admin
--   SELECT n.nspname, c.relname, a.privilege_type
--     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
--          LATERAL aclexplode(c.relacl) a
--    WHERE n.nspname IN ('public','admin') AND a.grantee = 0;
--
--   -- 2. §12b — anything in schema `admin` other than this script's own two views
--   SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--    WHERE n.nspname = 'admin'
--      AND NOT (c.relkind = 'v' AND c.relname IN ('audit_log', 'credit_ledger'));
--
--   -- 3. §13 — a SECURITY DEFINER routine anybody can execute (EXECUTE to PUBLIC is the
--   --    Postgres DEFAULT, so "nobody granted it" is not an answer)
--   SELECT n.nspname, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE p.prosecdef AND n.nspname IN ('public','admin');
--
-- A non-empty answer is a decision for a human, and the script's error message says which one.
-- Expect harmless `WARNING: no privileges could be revoked for "<schema>"` lines from §2 for
-- schemas this session does not own; they are not failures.
--
-- ## What this is for
--
-- The product's core privacy rule: an account's mail is reachable by that account's own users
-- and by nobody else, "including operators and the admin console", and the enforcement "must
-- be structural […] never a projection someone remembers to keep narrow". An earlier pass on
-- the console side closed the RENDER path — the
-- console no longer displays content, and two real leaks were fixed — but the connection the
-- admin reads ran on could still answer `SELECT subject FROM messages`. A new endpoint, a
-- widened query or an ORM `select *` re-opened it and nothing failed.
--
-- **The boundary is staff-surface vs. user-serving runtime, NOT "the API must not read
-- content".** The API *must* read `subject`/`snippet`/`from_address` to serve the account's own
-- user — those columns exist for exactly that (`schema.ts`, "API display fields (materialized
-- into MessageDTO)"). So this role is a SECOND, content-blind connection inside the same API
-- process, not a role swap on the first. The runtime connection is untouched by this script.
--
-- ## Why a script and not a numbered migration
--
-- Two reasons, both fatal:
--
--  · The mail journal replays on DESKTOP installs and on PGlite, where `ohmail_admin` will
--    never exist. A `GRANT … TO ohmail_admin` inside a numbered migration wedges the runner
--    on every one of them.
--  · Grants must be RE-RUNNABLE to repair drift. This script revokes before it grants, so
--    re-running it UNDOES a hand-widened grant somebody added in production "for support" — which a
--    migration, applied once and recorded as applied, structurally cannot do.
--
-- The repo had already ruled this once (`harden-billing-roles.sql`); the two reasons above are
-- specific to this script.
--
-- ## THIS SCRIPT CANNOT BREAK THE RUNNING DEPLOYMENT, AND IS NOT COUPLED TO
-- ## `harden-billing-roles.sql`
--
-- That script has NEVER BEEN RUN — verified against the live deployment: `ohmail_migrator` and
-- `ohmail_runtime` do not exist, and production connects as the role that owns the schema. The
-- ownership flip stays a separate, riskier, owed step.
--
-- Every statement below either touches `ohmail_admin` alone or reads the catalog. Precisely
-- stated, because the pre-flight pass changed two of these and the old sentence ("purely
-- additive") is no longer true:
--
--  · It GRANTS and REVOKES only to and from `ohmail_admin`.
--  · It creates schema `admin` and TWO views in it (`audit_log` §3, `credit_ledger` §9b).
--    Nothing else reads any of them.
--  · It takes back OWNERSHIP of any relation `ohmail_admin` owns (§1d). A relation the API or
--    the worker created is owned by the migrator, never by this role, so the loop is empty on
--    a healthy database and cannot reach one of theirs.
--  · **It still revokes NOTHING from PUBLIC.** Where a PUBLIC grant would defeat the
--    isolation, §12 ABORTS and names it. Revoking it would change what every other role in
--    the database can do — which is the ownership flip's job, under its own review, not a
--    side effect of provisioning a staff account.
--
-- ## AND IT IS A POSTCONDITION, NOT AN ASSUMPTION
--
-- The first version of this script assumed that `REVOKE … FROM ohmail_admin` returned an
-- existing role to zero — an external security review showed it does
-- not. PostgreSQL has no negative grant, so `REVOKE` removes only ACL entries granted
-- DIRECTLY to the role, and a privilege reached through
--
--    · membership in another role — including predefined `pg_read_all_data`
--    · a grant to `PUBLIC`
--    · OWNERSHIP of the relation
--
-- survives the documented repair untouched, while the script commits with its own "START FROM
-- ZERO" comment written across the top of it. The pg guard could not see this: it builds a
-- fresh database and a fresh role every run, and its rerun mutation added a direct grant —
-- the one kind `REVOKE` does repair.
--
-- Two more routes were found in the same review, and both are the same shape — a capability
-- that no `REVOKE … ON <table>` can express:
--
--  · a `SECURITY DEFINER` routine runs as its OWNER. Postgres grants `EXECUTE` to `PUBLIC`
--    on every routine it creates, so one helper over a protected column hands the staff
--    role mail while every column grant here stays exactly as narrow as it reads.
--  · an ordinary VIEW reads its base tables with the VIEW OWNER's privileges. The first
--    version reset `admin` by re-creating one view and nothing else, so an
--    `admin.mail_preview` over `messages(subject, from_address)` survived a full rerun,
--    grant and all.
--
-- So §1b–§1d NORMALISE the role (attributes, memberships, ownership) before anything is
-- granted, §2 resets EVERY schema and every routine rather than `public`'s tables, §12
-- rejects dangerous `PUBLIC` grants, §12b requires schema `admin` to hold this file's two
-- views and nothing else, and §13 ends the transaction with an EFFECTIVE-privilege census that RAISES —
-- rolling the whole thing back — unless every privilege `ohmail_admin` actually holds came
-- from a direct grant written in this file, and no reachable `SECURITY DEFINER` routine
-- exists at all.
--
-- ## The shape of every stanza, and the two rules it encodes
--
--   REVOKE ALL ON <table> FROM ohmail_admin;      -- repair drift
--   GRANT  SELECT (<named columns>) ON <table> TO ohmail_admin;
--
-- **Every grant is COLUMN-LEVEL, including on the tables that have no sensitive column
-- today.** A table-level `GRANT SELECT ON accounts` would silently extend to whatever column
-- the next migration adds; a column list freezes the set, so a new column is invisible to
-- staff until somebody adds its name here and that line goes through review.
--
-- **There is deliberately no `ALTER DEFAULT PRIVILEGES`**, for the same reason one step up: a
-- new TABLE must stay invisible to staff until it is granted explicitly.
--
-- ## Verify (as ohmail_admin) — every one of these must be REFUSED with SQLSTATE 42501
--
--   SELECT subject      FROM messages WHERE false;
--   SELECT snippet      FROM messages WHERE false;
--   SELECT from_address FROM messages WHERE false;
--   SELECT subject_tsv  FROM messages WHERE false;
--   SELECT *            FROM messages WHERE false;
--   SELECT count(*)     FROM messages;              -- the ROW is the oracle: this
--   SELECT id           FROM messages WHERE false;  -- names no column and must still be 42501.
--   SELECT mailbox_id   FROM messages WHERE false;
--   SELECT * FROM change_log  WHERE false;          -- `entity_id` joins to messages.id
--   SELECT * FROM folder_state WHERE false;
--   SELECT * FROM flag_state   WHERE false;
--   SELECT * FROM message_bodies WHERE false;
--   SELECT * FROM threads WHERE false;
--   SELECT secret_enc FROM mailbox_credentials WHERE false;
--   SELECT payload FROM billing_events WHERE false;
--   SELECT meta    FROM public.credit_ledger WHERE false;
--   SELECT source  FROM public.credit_ledger WHERE false;   -- QUALIFY IT: unqualified,
--                                    -- `credit_ledger` is the VIEW, which HAS a `source`.
--   SELECT * FROM public.audit_log WHERE false;
--   UPDATE accounts SET name = name WHERE false;
--
-- and every one of these must ANSWER:
--
--   SELECT count(*) FROM accounts;
--   SELECT account_id, suspended_at FROM account_suspensions WHERE false;  -- (two columns)
--   SELECT * FROM admin.audit_log LIMIT 1;
--   SELECT * FROM audit_log LIMIT 1;   -- resolves to admin.audit_log through search_path
--   SELECT source FROM credit_ledger LIMIT 1;   -- the VIEW, and the value is redacted to a
--                                    -- NAMESPACE TOKEN: `classify:`, never `classify:<uuid>:`
--                                    -- and never `classify:<uuid>:<32 hex>`
--
-- ## …and the script PROVES the rest of it before it commits
--
-- The list above is what a human types. §13 is what the transaction requires, and it is
-- broader than any list of statements can be: `ohmail_admin` may hold NO privilege on any
-- relation, column, sequence or schema that this file did not grant it DIRECTLY, may be a
-- MEMBER of nothing, may OWN nothing, may hold none of the five dangerous role attributes,
-- and may not be able to EXECUTE a single SECURITY DEFINER routine. Anything else raises, and
-- the transaction rolls back with nothing provisioned.
--
-- The provisioning guard suite executes THIS FILE verbatim against a real Postgres and
-- asserts all of the above plus an exhaustive privilege census. It does not
-- provision grants of its own: a test that built its own grants would prove a configuration
-- production never received. It also runs each of the attacks §1b–§13 exist for — an
-- inherited role, `pg_read_all_data`, a `PUBLIC` grant, ownership, `SUPERUSER`, a
-- `SECURITY DEFINER` helper, a content view in `admin`, a grant in a third schema — and
-- requires this file to repair it or roll back loudly.
-- ─────────────────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. The role. LOGIN, no password here (set out of band), no memberships. ───────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ohmail_admin') THEN
    CREATE ROLE ohmail_admin LOGIN;
  END IF;
END $$;

-- ── 1b. ROLE ATTRIBUTES. Repair what this session can; ABORT on what it cannot. ───────────
--
-- A SUPERUSER or BYPASSRLS `ohmail_admin` reads every table in the cluster and no grant below
-- means anything. `CREATEROLE` is an escalation route (it can grant itself memberships);
-- `CREATEDB` and `REPLICATION` are not content leaks but have no business on a read-only
-- staff account, and a role that has drifted into one of them has drifted.
--
-- The ALTER is issued only when the attribute is actually SET, because `ALTER ROLE …
-- NOSUPERUSER` is refused for a non-superuser session **whether or not it would change
-- anything** — an unconditional one would make this script un-runnable on a managed host,
-- where the database's owning role is not a superuser. When the attribute IS set and the session cannot remove
-- it, the exception handler re-raises and the whole transaction rolls back: a staff role
-- nobody can de-escalate must not be provisioned.
--
-- INHERIT is set deliberately, and it is the counter-intuitive one. `NOINHERIT` would stop a
-- membership from conferring privileges automatically — but `SET ROLE` would still work, and
-- `has_column_privilege` would stop reporting the inherited privileges, which would HIDE an
-- escalation from the census in §13 and from the boot attestation. Visible beats narrow here;
-- §1c removes the memberships themselves.
DO $$
DECLARE
  hold  record;
  bad   text;
BEGIN
  SELECT * INTO hold FROM pg_roles WHERE rolname = 'ohmail_admin';

  FOR bad IN
    SELECT x.clause FROM (VALUES
      ('NOSUPERUSER',   hold.rolsuper),
      ('NOBYPASSRLS',   hold.rolbypassrls),
      ('NOREPLICATION', hold.rolreplication),
      ('NOCREATEDB',    hold.rolcreatedb),
      ('NOCREATEROLE',  hold.rolcreaterole)
    ) AS x(clause, held)
    WHERE x.held
  LOOP
    BEGIN
      EXECUTE format('ALTER ROLE ohmail_admin %s', bad);
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION
        'ohmail_admin holds a role attribute this session cannot remove — ALTER ROLE ohmail_admin % failed: %. Remove it as a superuser, then re-run this script.',
        bad, SQLERRM;
    END;
  END LOOP;

  IF NOT hold.rolcanlogin THEN EXECUTE 'ALTER ROLE ohmail_admin LOGIN';   END IF;
  IF NOT hold.rolinherit  THEN EXECUTE 'ALTER ROLE ohmail_admin INHERIT'; END IF;
END $$;

-- ── 1c. MEMBERSHIPS. There are none, and this is the statement that makes that true. ──────
--
-- `GRANT pg_read_all_data TO ohmail_admin` is one line, is exactly what an operator reaches
-- for during an incident, and gives the staff role every message body in the database. No
-- `REVOKE … ON <table>` anywhere below touches it. So every direct membership is revoked
-- here, and then the CLOSURE is re-checked with `pg_has_role`, which sees nested memberships
-- the `pg_auth_members` loop cannot name on its own.
DO $$
DECLARE
  grantor text;
  left_over text;
BEGIN
  FOR grantor IN
    SELECT roleid::regrole::text FROM pg_auth_members WHERE member = 'ohmail_admin'::regrole
  LOOP
    BEGIN
      EXECUTE format('REVOKE %s FROM ohmail_admin', grantor);
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION
        'ohmail_admin is a MEMBER of % and this session cannot revoke it: %. A membership confers every privilege the other role holds, so no grant below can bound this role until it is gone.',
        grantor, SQLERRM;
    END;
  END LOOP;

  SELECT string_agg(r.rolname, ', ' ORDER BY r.rolname) INTO left_over
    FROM pg_roles r
   WHERE r.rolname <> 'ohmail_admin'
     AND pg_has_role('ohmail_admin', r.oid, 'MEMBER');

  IF left_over IS NOT NULL THEN
    RAISE EXCEPTION
      'after revoking every direct membership, ohmail_admin is still a MEMBER of: %. Resolve this by hand before provisioning the staff surface.',
      left_over;
  END IF;
END $$;

-- ── 1d. OWNERSHIP. An owner holds every privilege on its object, and can re-grant them. ───
--
-- Ownership is the third source `REVOKE` cannot reach: `REVOKE ALL ON message_bodies FROM
-- ohmail_admin` against a table `ohmail_admin` OWNS removes an ACL entry and changes nothing,
-- because the default ACL of a relation gives its owner everything.
--
-- Repaired rather than rejected, because the correct owner is not a judgement call: every
-- other application relation is owned by whoever runs this script (the database's owning
-- role in production, the database owner in the pg guard), and that is the role we hand it
-- back to.
-- When the session cannot do it, the handler re-raises and the transaction rolls back.
--
-- Every non-system schema, not just the two this script grants: a relation in a schema
-- `ohmail_admin` cannot currently reach is one `GRANT USAGE` away from being readable, and it
-- would still be owned by the staff role.
DO $$
DECLARE
  rel record;
BEGIN
  FOR rel IN
    SELECT c.relkind, format('%I.%I', n.nspname, c.relname) AS ident
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relowner = 'ohmail_admin'::regrole
       AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
       AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
  LOOP
    BEGIN
      EXECUTE format(
        CASE rel.relkind
          WHEN 'S' THEN 'ALTER SEQUENCE %s OWNER TO %I'
          WHEN 'v' THEN 'ALTER VIEW %s OWNER TO %I'
          WHEN 'm' THEN 'ALTER MATERIALIZED VIEW %s OWNER TO %I'
          WHEN 'f' THEN 'ALTER FOREIGN TABLE %s OWNER TO %I'
          ELSE          'ALTER TABLE %s OWNER TO %I'
        END, rel.ident, current_user);
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION
        'ohmail_admin OWNS % and this session cannot take it back: %. An owner holds every privilege on its object and can re-grant them at will, so the census in §13 could never be true while this holds.',
        rel.ident, SQLERRM;
    END;
  END LOOP;

  FOR rel IN
    SELECT nspname AS ident FROM pg_namespace WHERE nspowner = 'ohmail_admin'::regrole
  LOOP
    BEGIN
      EXECUTE format('ALTER SCHEMA %I OWNER TO %I', rel.ident, current_user);
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION
        'ohmail_admin OWNS schema % and this session cannot take it back: %.',
        rel.ident, SQLERRM;
    END;
  END LOOP;
END $$;

-- ── 2. START FROM ZERO, every run. ────────────────────────────────────────────────────────
--
-- This is what makes the script a repair tool rather than a one-shot. Anything anybody granted
-- by hand — a table-level SELECT added during an incident, a column somebody needed once — is
-- removed here and only comes back if it is named below.
--
-- **EVERY non-system schema, not only `public`, and ROUTINES as well as tables.** The first
-- version revoked in `public` alone and named `ALL FUNCTIONS`, and the security review's two
-- findings on this stanza are the two bills for that:
--
--  · `admin` was reset by DROP-ing and re-creating `admin.audit_log` and nothing
--    else, so an `admin.mail_preview` view over `messages(subject, from_address)` and its
--    grant survived a full rerun. A view reads its base tables with its OWNER's privileges,
--    so it answers with mail while the role holds no base-column grant at all. The loop below
--    revokes it; §12b then ABORTS rather than leave the view sitting there loaded.
--  · `ALL FUNCTIONS` does not include PROCEDURES (that is `ALL ROUTINES`), and
--    neither negates the `EXECUTE` Postgres grants to `PUBLIC` by default on every routine it
--    creates. The direct half is revoked here; the PUBLIC half cannot be, and §13 aborts on
--    any SECURITY DEFINER routine the role can still reach.
--  · A direct `GRANT USAGE ON SCHEMA drizzle_mail` would otherwise be a privilege this script
--    never named and never removed, and §13 would accept it, because it WAS a direct grant.
--
-- Zero means zero everywhere; the two schemas this role needs are granted back explicitly,
-- immediately below and in §3.
--
-- `REVOKE` on an object this session cannot grant on emits a WARNING, not an error, so a
-- schema owned by somebody else does not abort the run.
--
-- ── THAT SENTENCE WAS TRUE ON ONE MANAGED HOST AND FALSE ON ANOTHER (measured) ─────────────
--
-- It holds for a SCHEMA. It does NOT hold for every object inside one. On one managed host
-- this loop aborted the whole script with a hard error:
--
--     SCRIPT ABORTED: permission denied for function get_auth
--
-- `get_auth` is that host's connection pooler's own function. `REVOKE ... ON ALL FUNCTIONS`
-- expands to each function individually, and for a function whose owner this session is not a
-- member of, Postgres raises `insufficient_privilege` (42501) rather than warning — unlike the
-- schema-level revoke on the line above it, which warns. One managed-host internal in one
-- schema we do not own was therefore enough to make the entire staff-role provisioning
-- unrunnable.
--
-- So each statement is now attempted independently and a privilege error is downgraded to a
-- WARNING naming the object. **This does not weaken the guarantee**, and that is the whole
-- reason it is safe: §13's postcondition measures the role's EFFECTIVE capability afterwards
-- with `has_*_privilege`/`pg_has_role` and ABORTS on anything in excess. A revoke that could
-- not run on a foreign object either did not need to run (the role never had that privilege) or
-- will be caught there. The abort condition is the end state, never the statement count.
--
-- Report every warning: an operator who cannot see them cannot tell a managed-host internal from a
-- privilege this script was supposed to remove and silently did not.
DO $$
DECLARE
  s    text;
  stmt text;
BEGIN
  FOR s IN
    SELECT nspname FROM pg_namespace
     WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
       AND nspname NOT LIKE 'pg\_temp\_%'
       AND nspname NOT LIKE 'pg\_toast\_temp\_%'
  LOOP
    FOREACH stmt IN ARRAY ARRAY[
      format('REVOKE ALL ON SCHEMA %I FROM ohmail_admin', s),
      format('REVOKE ALL ON ALL TABLES    IN SCHEMA %I FROM ohmail_admin', s),
      format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM ohmail_admin', s),
      format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA %I FROM ohmail_admin', s),
      format('REVOKE ALL ON ALL ROUTINES  IN SCHEMA %I FROM ohmail_admin', s)
    ] LOOP
      BEGIN
        EXECUTE stmt;
      EXCEPTION
        WHEN insufficient_privilege THEN
          RAISE WARNING 'skipped (not ours): % — %', stmt, SQLERRM;
      END;
    END LOOP;
  END LOOP;
END $$;

REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM ohmail_admin;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ohmail_admin;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM ohmail_admin;
GRANT USAGE ON SCHEMA public TO ohmail_admin;

-- ── 3. `audit_log` gets NO DIRECT GRANT. A security_barrier view instead. ─────────────────
--
-- `audit_log` is shared with the PRODUCT's own domain audit — `move`, `adopt_external`,
-- `hey_migrate`, `workflow_step` — and a `workflow_step` row's `payload.effect` is whatever
-- the tool returned, which for `draft_reply` quotes mail. Filtering to the `admin.` namespace
-- is the only projection that is safe by construction rather than by auditing every tool that
-- exists today.
--
-- **Named scalars only. No `payload`, no `inverse`.** Those are jsonb BAGS: nothing about the
-- column bounds what a producer may put in one, so the bag is never granted. If the console
-- ever needs a value out of one, the PRODUCER promotes it to a named column and that column is
-- added here.
--
-- `security_barrier` so the WHERE cannot be raced by a cheap leaky operator pushed under it —
-- belt and braces on a read-only surface, and free.
--
-- DROP + CREATE rather than CREATE OR REPLACE: the latter refuses to change a view's column
-- list, which would make this file un-re-runnable the first time the projection changes.
--
-- The view is owned by whoever runs this script (the table owner), and a view executes against
-- its underlying tables with its OWNER's privileges — which is exactly why `ohmail_admin` can
-- read through it while holding nothing on `public.audit_log` itself.
CREATE SCHEMA IF NOT EXISTS admin;
GRANT USAGE ON SCHEMA admin TO ohmail_admin;

DROP VIEW IF EXISTS admin.audit_log;
CREATE VIEW admin.audit_log WITH (security_barrier) AS
  SELECT id, account_id, action, created_at
    FROM public.audit_log
   WHERE action LIKE 'admin.%';
GRANT SELECT ON admin.audit_log TO ohmail_admin;

-- `admin` FIRST, so an unqualified `audit_log` — which is what drizzle emits for
-- `pgTable("audit_log", …)` — resolves to the view for this role and to the table for every
-- other one. That is what lets ONE query serve the staff surface and the test harness without
-- a second code path, and it means a widened projection fails HERE (42501 on a column the view
-- does not have) rather than quietly reading the bag.
--
-- The same sentence is true of `credit_ledger` (§9b), and §12b is what keeps the
-- shadowing list to exactly these two: the schema the role searches FIRST is the schema in
-- which an unreviewed `admin.messages` would silently outrank `public.messages`.
ALTER ROLE ohmail_admin SET search_path = admin, public;

-- ── 4. `messages` — NO GRANT AT ALL. NOT ONE COLUMN. ──────────────────────────────────────
--
-- This stanza used to grant `(id, mailbox_id)` and the comment above it called that "a
-- primary key and a foreign key, nothing else" — the narrowest grant in the file, and the
-- provisioning verification recorded it as a POSITIVE result. **Both readings were right about
-- the SQL and only one was right about the product.** The security review, rated High:
--
--   > The staff role first resolves the target account's mailbox address and UUID from
--   > `mailboxes`, then reads the current `messages.id` set (or just `count(*)`) for that
--   > `mailbox_id`. It sends the chosen probe carrying the candidate RFC822 Message-ID, polls
--   > the same query, and observes a new message row in that mailbox.
--
-- A two-column grant is minimal AS A PROJECTION and still sufficient AS A CHANNEL, because the
-- information is in the ROW'S EXISTENCE and not in any column of it. `count(*)` names no
-- column. So there is no narrower column list that fixes this, and the only grant that does is
-- none: `SELECT count(*) FROM messages` must raise 42501 as surely as `SELECT subject` does.
--
-- ## What that costs, and why nothing is built to replace it
--
-- The one consumer was `pendingMovesByMailbox` in `admin-service.ts`, which joined
-- `folder_state → messages` for `mailbox_id` so the console could show a per-mailbox count of
-- unapplied folder moves. That surface is GONE (`MailboxHealth.pendingMoves` is 0 and
-- `oldestPendingMoveSeconds` is null; the module documents it at length).
--
-- It is not replaced by a bucketed admin view, and the reason is worth stating because the
-- obvious fix looks like it works. **Aggregation is a statement about a population, and the
-- population of a per-mailbox number is one mailbox — which is one account.** Bucketing,
-- delaying and minimum-threshold suppression are all population arguments, so none of them
-- applies: a threshold of k on one mailbox's rows is defeated by k chosen deliveries. The
-- cluster-wide total is a real population, but serving it needs `count(DISTINCT mailbox_id)`
-- for the console's "mailboxes affected", and a view that carries `mailbox_id` hands the
-- attribution straight back the moment the suppression threshold is met. See
-- `admin-service.ts:adminWorker` for the full argument, the bucket sizes the producer-side
-- replacement must use, and where that replacement belongs (`worker_heartbeats`, written by
-- the worker, which is the only place the number can be keyless AND delayed AND thresholded).
--
-- Denied by omission, and still worth naming because a future reader will want to "just add"
-- one: `subject`, `snippet`, `from_address`, `to_addresses`, `cc_addresses`,
-- `message_id_header`, `body_hash`, `dedup_key`, `native_locator`, `sensitivity_category` —
-- and **`subject_tsv`**, generated from `subject || ' ' || from_address`, whose lexemes
-- reconstruct both. None of that is the finding any more. `id` is.
REVOKE ALL ON public.messages FROM ohmail_admin;

-- ── 5. Identity and plan — accounts, users. ───────────────────────────────────────────────
--
-- Legitimately staff-visible: the privacy rule's second clause is "Subscription, usage and billing data
-- IS legitimately visible to staff for user management". `users` holds no credential — password
-- hashes are in `credentials`, TOTP in `totp_secrets`, both un-granted below by omission.
REVOKE ALL ON public.accounts FROM ohmail_admin;
GRANT SELECT (id, name, ai_enabled, created_at) ON public.accounts TO ohmail_admin;

REVOKE ALL ON public.users FROM ohmail_admin;
GRANT SELECT (id, account_id, email, display_name, email_verified_at, created_at)
  ON public.users TO ohmail_admin;

-- ── 5b. `account_suspensions` — presence-is-state suspension (cloud journal 0008). ────────
--
-- The console shows WHO is suspended and SINCE WHEN, which is a legitimate user-management fact
-- (the privacy rule's second clause). TWO columns only: `account_id` and `suspended_at`.
--
-- NOT `suspended_by` (a `staff_users` id — no console screen renders it) and NOT `note` (free
-- text the operator typed). The WRITE that records both runs on the runtime connection, never
-- this blind role — a write grant here would make §13's `effective ⇒ direct` census abort. Add
-- either column in the diff that adds a projection for it, mirroring `STAFF_SELECT_GRANTS`.
REVOKE ALL ON public.account_suspensions FROM ohmail_admin;
GRANT SELECT (account_id, suspended_at) ON public.account_suspensions TO ohmail_admin;

-- ── 6. Mailboxes — including `error_detail`, which is staff-visible BY DESIGN. ────────────
--
-- `error_detail` is not a raw error string. It is a member of a CLOSED allowlist
-- (`MAILBOX_ERROR_DETAIL_TOKENS`) checked at the single write site (`markMailboxFailed`),
-- because a throw out of the sync cycle can embed RFC822 header bytes. The redaction is at the
-- WRITE, so the grant does not have to be the thing that remembers.
--
-- `sync_blocked_reason` / `sync_blocked_since` (mail 0029) are granted for the same reason and a
-- sharper one. Same reason: the column is a CLOSED set of three
-- (`MAILBOX_SYNC_BLOCK_REASONS`) behind a CHECK constraint, so unlike `error_detail` it does not
-- even depend on a write-site allowlist — no value a mail server chose can reach it at all.
--
-- The sharper one: this pair is the ONLY thing that can explain a `connected` mailbox with a
-- growing `sync_lag`, which is exactly what an operator once stared at for half an hour
-- during an incident. Ungranted, `loadMailboxes` raises `permission denied for table
-- mailboxes` under the blind role and takes the WHOLE console read down — not a missing
-- field, a 500 — because Postgres requires the privilege on every column a statement
-- references. The provisioning guard suite exercises the real six admin reads through this
-- role, which is what caught it.
--
-- `disabled_reason` and `takeover_authorized_at` (mail 0027) stay UNGRANTED, and by decision
-- rather than by oversight: `admin-service.ts` does not project them, so granting them would
-- widen what staff can read past what the console displays. Add them in the diff that adds the
-- projection, not before.
REVOKE ALL ON public.mailboxes FROM ohmail_admin;
GRANT SELECT (
  id, account_id, provider, address, created_at, display_name, status, last_sync_at,
  auth_kind, error_code, error_detail, failed_at, retry_count, kickstart_at,
  sync_blocked_reason, sync_blocked_since
) ON public.mailboxes TO ohmail_admin;

-- `mailbox_credentials` — PRESENCE ONLY. `(mailbox_id, transport)` IS the primary key, which is
-- all `hasImapCredential` reads; `transport` is in the grant because the query filters on it
-- and Postgres requires the privilege on every column a statement REFERENCES, not only on the
-- ones it returns.
--
-- DEPARTURE FROM THE BRIEF, stated: the brief said `(id, mailbox_id, created_at)`. This table
-- has neither an `id` nor a `created_at` — its PK is the composite `(mailbox_id, transport)`.
--
-- NEVER `secret_enc` (the envelope-encrypted credential), `key_version`, or `meta`.
REVOKE ALL ON public.mailbox_credentials FROM ohmail_admin;
GRANT SELECT (mailbox_id, transport) ON public.mailbox_credentials TO ohmail_admin;

-- ── 7. `folder_state` / `flag_state` — NO GRANT. ──────────────────────────────────────────
--
-- `folder_state` used to grant `(id, message_id, last_set_by, reconcile_status, conflict,
-- updated_at)` for the per-mailbox pending-move count. §4 explains why that count cannot exist,
-- and without it nothing here has a consumer. Two further reasons it must not stay:
--
--  · `message_id` IS `messages.id`. The review finding's whole mechanism is joinable keys, and a per-message
--    row with an `updated_at` is a per-message event time whether or not a `messages` grant
--    exists to join it to.
--  · A row-level grant carries no PREDICATE. The `updated_at < now() - 15 minutes` delay that
--    would make a backlog number unpollable is a property of a QUERY, and the role writes its
--    own queries. Only an owner-side view can hold a predicate, and §4 says why the view is
--    not buildable without handing attribution back.
--
-- `flag_state` never had a consumer at all. It was granted "because the ruling named it", on
-- the argument that every column is a boolean or an enum token — true, and beside the point:
-- one row per message with an `updated_at` is the same per-message timeline in the read-state
-- table. The joinable-keys review finding names it by name.
REVOKE ALL ON public.folder_state FROM ohmail_admin;
REVOKE ALL ON public.flag_state   FROM ohmail_admin;

-- ── 8. `change_log` — NO GRANT. NOT ONE COLUMN. ───────────────────────────────────────────
--
-- This was `(account_id, seq, entity_type, entity_id, op, created_at)` — "ids, an enum and a
-- timestamp", granted whole because the console read only `max(created_at)` per account.
-- The security review, rated Medium:
--
--   > For message entities, staff joins `change_log.entity_id = messages.id`, then joins
--   > `messages.mailbox_id = mailboxes.id`, recovering which account mailbox changed, which
--   > internal message row changed, the operation, and its precise event time — facts neither
--   > grant supplies alone.
--
-- The brief's question was whether staff need `entity_id` at all. They need no column of this
-- table: `max(created_at)` per account was the only read (`AccountSummary.lastActivityAt`), and
-- **that read is the sharpest oracle on the whole surface** — `packages/core/src/pipeline.ts`
-- calls `recordChange({entityType:'message', op:'create'})` for every ingested message, so a
-- chosen delivery moves one account's newest-change timestamp to the second. No bucket saves
-- it: truncating that stamp to the hour still advances inside the hour the probe delivered in,
-- and the population being bucketed is one account. So the whole grant goes, `lastActivityAt`
-- is null, and the join key does not exist to be joined.
--
-- Change VOLUME, if a console ever needs it, is a deployment-wide count and belongs in an
-- owner-side aggregate with no `account_id` — not in a grant on this table.
--
-- (`meta` was never granted: it carries move descriptors and, for other entity types, whatever
-- a producer put there. It stays un-granted for the same reason as every other jsonb bag.)
REVOKE ALL ON public.change_log FROM ohmail_admin;

-- ── 9. Money — the tables minus their two jsonb bags. ─────────────────────────────────────
--
-- `billing_events.payload` is the raw Stripe event: a customer's name, address and line-item
-- descriptions. The operator queue needs `stripe_event_id` (what you paste into the dashboard)
-- and `error` (why it failed).
--
-- `credit_ledger.meta` is the column a cleanup pass had to scrub after `pipeline.ts` wrote the
-- raw RFC822 Message-ID into it. The console's `staffMeta` gate projected it safely; this makes the
-- projection unnecessary, which is the whole point of the slice — a gate nobody can forget
-- beats a gate somebody has to remember.
--
-- **`credit_ledger.source` IS NOT GRANTED EITHER, and the sentence that used to stand here —
-- "`source` is safe BY CONSTRUCTION (every foreign input is sha256'd into it)" — WAS FALSE**
-- (a security-review finding). Hashing is not redaction when the input is guessable. `source` is
-- `classify:<mailbox>:<sha256(mid:<Message-ID>)[0:32]>` for a classification and
-- `draft:<message>:<sha256(<Idempotency-Key>)[0:32]>` for a draft, and both inputs are
-- attacker- or client-chosen: a sender picks a low-entropy `Message-ID` for mail it sends to
-- the account, and a natural client uses the SUBJECT as its `Idempotency-Key`. Hash the
-- candidate, compare, and staff has confirmed that this account received that exact mail.
-- Truncating to 128 bits stops collisions; it adds no entropy to a guessable input and does
-- not prevent an offline dictionary.
--
-- The fix is the grant, not a re-keying. `credit_ledger` is APPEND-ONLY and the cleanup pass deliberately
-- destroyed the plaintexts, so existing rows can never be re-hashed under a key — an HMAC
-- going forward would leave the entire historical oracle readable and be fix-SHAPED rather
-- than a fix. Removing the column from the grant closes history at once.
--
-- The money is still fully readable, and so is the ledger's dedup IDENTITY in the form staff
-- actually needs it: `admin.credit_ledger` below projects the six money columns verbatim and
-- `source` REDACTED. Same shadow-view mechanism as `admin.audit_log` in §3, same reason.
REVOKE ALL ON public.billing_customers FROM ohmail_admin;
GRANT SELECT (account_id, stripe_customer_id, email, created_at, updated_at)
  ON public.billing_customers TO ohmail_admin;

REVOKE ALL ON public.billing_subscriptions FROM ohmail_admin;
GRANT SELECT (
  id, account_id, stripe_subscription_id, stripe_price_id, plan, status,
  mailbox_limit, monthly_credits, current_period_start, current_period_end,
  cancel_at_period_end, grace_until, stripe_event_ts, created_at, updated_at
) ON public.billing_subscriptions TO ohmail_admin;

REVOKE ALL ON public.credit_balances FROM ohmail_admin;
GRANT SELECT (account_id, balance, updated_at) ON public.credit_balances TO ohmail_admin;

REVOKE ALL ON public.credit_ledger FROM ohmail_admin;
GRANT SELECT (id, account_id, delta, balance_after, reason, created_at)
  ON public.credit_ledger TO ohmail_admin;

-- ── 9b. `admin.credit_ledger` — the money, and a REDACTED `source`. ───────────────────────
--
-- Same construction as `admin.audit_log` in §3: a `security_barrier` view owned by whoever
-- runs this script, so it reads its base table with the OWNER's privileges while
-- `ohmail_admin` holds nothing on `public.credit_ledger.source`. `search_path = admin, public`
-- then makes drizzle's unqualified `from "credit_ledger"` in `loadLedger` resolve to THIS for
-- the staff role and to the table for PGlite — one query, no second code path, and the DTO
-- unchanged.
--
-- ## The redaction is DENY-BY-DEFAULT, and that is the whole design
--
-- `source` is a namespaced dedup identity (`packages/db/src/credits.ts`, `ledgerSources`).
-- FIVE namespaces are safe to show verbatim, and each is safe for a reason you can check by
-- reading it — not because anyone audited the values:
--
--   invoice:<stripe_invoice_id>          a Stripe id
--   expiry:<prior_stripe_invoice_id>     a Stripe id
--   propose:<account_uuid>:<yyyy-mm-ddThh>   our uuid and a clock
--   workflow_run:<run_uuid>:<step_index>     our uuid and an integer
--   admin:<adjustment_uuid>              our uuid
--
-- EVERYTHING ELSE keeps its NAMESPACE TOKEN and loses every segment after it. That is
-- `classify:` and `draft:` today, and it is also namespace nine, whenever somebody adds one,
-- without anybody having to remember this file exists.
--
-- ## "lose the final `:`-segment" WAS NOT ENOUGH, and the joinable-keys finding is the bill
--
-- The first version of this view truncated only the LAST `:`-segment, on the reasoning that the
-- digest is always last. It is — but the digest was not the only thing worth taking:
--
--   draft:<message UUID>:<digest>       became   draft:<message UUID>:
--   classify:<mailbox UUID>:<digest>    became   classify:<mailbox UUID>:
--
--   > The redaction also turns `draft:<message UUID>:<digest>` into `draft:<message UUID>:`;
--   > staff can extract that surviving UUID and join it directly to `messages.id`, exactly
--   > attributing the draft/charge event to an internal message and mailbox.
--
-- So the rule is now stated on what SURVIVES rather than on what is removed: **the only thing
-- that survives the truncating branch is a namespace token, and a namespace token is a literal
-- from `ledgerSources` — never a value, never an identifier.** A `refund:`-wrapped source keeps
-- one segment more, because its first segment IS the wrapper and dropping the inner namespace
-- would render every refund identically.
--
-- A source with NO `:` at all renders as the empty string. That branch is unreachable from
-- today's `ledgerSources` — every builder emits a namespace — which is exactly why it must be
-- written down: the fallback for "this does not look like anything we recognise" has to be
-- nothing, not the whole value.
--
-- The `~<n>` retry ordinal `resolveAttempt` glues onto the digest goes with the digest.
--
-- ## The one identifier that still survives verbatim, and why it is allowed to
--
-- `propose:<account uuid>:<yyyy-mm-ddThh>` is on the passthrough list and that uuid is
-- `accounts.id`. It survives because it is the SAME account the row's own granted `account_id`
-- column names — a no-op disclosure, not a new one — and because the hour is the operator-
-- useful half of a propose charge. The other four passthrough namespaces carry a Stripe id
-- (`invoice:`, `expiry:`), a `workflow_runs` uuid (un-granted, joins to nothing this role can
-- read) or an adjustment uuid (likewise).
--
-- ## THE REFUND WRAPPER IS WHY THIS IS NOT WRITTEN AS A DENY-LIST
--
-- `ledgerSources.refund(originalSource)` is `refund:<the whole original source>`, so a
-- refunded classification is `refund:classify:<mailbox>:<digest>` — the digest, intact, one
-- prefix deeper. A view written the obvious way ("redact `classify:%` and `draft:%`") passes
-- that row through verbatim and REOPENS THE ORACLE COMPLETELY while looking finished. The
-- security review missed it and so did the first draft of the fix. Stating the rule as "these five, plus
-- the same five under a `refund:` wrapper, are verbatim; everything else is truncated" makes
-- the refund forms fall to the ELSE by construction rather than by a line somebody added.
--
-- `refund:` is the ONLY wrapping namespace in `ledgerSources` — `expiry:` and `refund:` are
-- the only builders that take another identity as their argument, and `expiry:` takes a bare
-- Stripe invoice id rather than a source. `classify:screener:<message_uuid>` is a nested
-- SUB-namespace rather than a wrapper; it falls to the ELSE and renders `classify:`, losing the
-- `screener` token along with the uuid. That is the accepted cost of a rule stated on what
-- survives: a per-namespace list of "which leading tokens are safe to keep" is a second
-- allowlist to forget to extend, and the `reason` column already distinguishes the charge.
--
-- What the console loses: the digest, the `~<n>` retry ordinal, and every uuid
-- the source was scoped to. What it keeps: the reason, the amount, the running balance, the
-- timestamp, the namespace, and (for the five verbatim namespaces) the Stripe id or run id an
-- operator pastes into a dashboard. Every question a support conversation about MONEY can ask
-- is still answerable; "which message was this charge for" is not, and that is the point.
--
-- DROP + CREATE, not CREATE OR REPLACE: the latter refuses to change a view's column list.
DROP VIEW IF EXISTS admin.credit_ledger;
CREATE VIEW admin.credit_ledger WITH (security_barrier) AS
  SELECT id, account_id, delta, balance_after, reason,
         CASE
           WHEN source LIKE 'invoice:%'      OR source LIKE 'refund:invoice:%'
             OR source LIKE 'expiry:%'       OR source LIKE 'refund:expiry:%'
             OR source LIKE 'propose:%'      OR source LIKE 'refund:propose:%'
             OR source LIKE 'workflow_run:%' OR source LIKE 'refund:workflow_run:%'
             OR source LIKE 'admin:%'        OR source LIKE 'refund:admin:%'
           THEN source
           -- A `refund:` WRAPPER keeps its own token and the wrapped namespace's token:
           -- `refund:` is 7 characters, and `strpos` over the remainder finds the inner
           -- namespace's colon. `refund:draft:<uuid>:<digest>` → `refund:draft:`.
           WHEN source LIKE 'refund:%' AND strpos(substring(source FROM 8), ':') > 0
             THEN left(source, 7 + strpos(substring(source FROM 8), ':'))
           -- EVERYTHING ELSE keeps its namespace token and nothing after it:
           -- `draft:<uuid>:<digest>` → `draft:`, `classify:screener:<uuid>` → `classify:`.
           WHEN strpos(source, ':') > 0 THEN left(source, strpos(source, ':'))
           -- No namespace at all. Not reachable from `ledgerSources` today; written down
           -- because the default for an unrecognised shape must be nothing, not the value.
           ELSE ''
         END AS source,
         created_at
    FROM public.credit_ledger;
GRANT SELECT ON admin.credit_ledger TO ohmail_admin;

REVOKE ALL ON public.billing_events FROM ohmail_admin;
GRANT SELECT (stripe_event_id, type, account_id, event_ts, received_at, error, status)
  ON public.billing_events TO ohmail_admin;

-- ── 9d. Funnel top — invite/waitlist DATES ONLY, never an address. ────────────────────────
--
-- On an invite-only beta the TOP of the signup funnel — how many invites are outstanding, how
-- many people are waiting — is invisible to the console, because both tables were fully
-- un-granted (they were in §11's "not granted" list, as "addresses of people who are not
-- customers yet"). The admin funnel needs the COUNTS, and only the counts.
--
-- So exactly the date columns are granted, and no PII column is:
--   invites   — created_at (issued), consumed_at (accepted), revoked_at (taken back)
--   waitlist  — created_at (joined),  invited_at  (let in)
--
-- NEVER `invites.email` (the binding address of a non-customer) or `invites.code_hash` (a live
-- invite secret), NEVER `waitlist.email` (a prospect's address), and never `tier` / `source` /
-- `note` / `issued_by` / `revoked_by` / `revoked_reason` — free text or identity the funnel does
-- not project. This is COUNTS AND DATES, not "just the domain", not now and not later.
-- The provisioning guard suite proves `invites.email` and `waitlist.email` still raise 42501,
-- which is the guard that stops a later hand widening this to PII.
REVOKE ALL ON public.invites FROM ohmail_admin;
GRANT SELECT (created_at, consumed_at, revoked_at) ON public.invites TO ohmail_admin;

REVOKE ALL ON public.waitlist FROM ohmail_admin;
GRANT SELECT (created_at, invited_at) ON public.waitlist TO ohmail_admin;

-- ── 10. Operations. ───────────────────────────────────────────────────────────────────────
REVOKE ALL ON public.worker_heartbeats FROM ohmail_admin;
GRANT SELECT (
  shard_index, instance_id, leader, shards, mailboxes, expected, accounts,
  quarantined, degraded, last_cycle_at, started_at, beat_at
) ON public.worker_heartbeats TO ohmail_admin;

-- `outbound_sends` — the stuck-send queue, which is a staff surface on the Worker and Actions
-- pages and the subject of alert rule 3.
--
-- DEPARTURE FROM THE BRIEF, stated: the brief's grant list did not name this table and its
-- "no grant at all" list did not either, but `listStuckSends` and `evaluateAlerts` both read
-- it, so the console and the pager need it.
--
-- NOT `idempotency_key` — it is the CLIENT's `Idempotency-Key` header, verbatim and
-- unvalidated, so it is caller-chosen free text of unbounded length; a client that used a
-- draft's SUBJECT as its "one intent" token would have put subjects on a staff screen. The
-- console-side pass removed it from the DTO; this removes it from the role. NOT `minted_message_id` /
-- `provider_message_id` either: a Message-ID carries the sender's domain and ESPs routinely
-- encode the recipient's address in one. NOT `draft_id`, which is a handle onto draft content.
REVOKE ALL ON public.outbound_sends FROM ohmail_admin;
GRANT SELECT (id, account_id, status, created_at) ON public.outbound_sends TO ohmail_admin;

-- `alert_state` is the ONE table this role WRITES. `/internal/alerts` is a staff surface: the
-- pass opens a row when a rule starts firing, claims and settles the notification, and deletes
-- the row when the condition clears. DELETE is in the list because `runAlertPass` resolves by
-- deleting — without it every clearing alert would raise 42501 and the pass would 503.
--
-- Nothing here can carry mail content: every column is a count, an age, a rule name or a
-- detail string produced by `alerts.ts` itself.
-- ── THE WRITE VERBS ARE COLUMN-SCOPED TOO, AND THE ASYMMETRY WAS THE DEFECT ──────────────
--
-- `GRANT INSERT, UPDATE, DELETE ON public.alert_state` with no column list sat directly under
-- a carefully 8-column-scoped SELECT — the only such asymmetry in this file. It grants nothing
-- today that the pass does not use, because the SELECT list happens to name every column the
-- table currently has. What it grants is the FUTURE: the next migration to add a column to
-- `alert_state` makes that column writable by this role automatically, while leaving it
-- unreadable, so the blind role acquires a write capability nobody reviewed and the census
-- cannot see the difference. This role is deliberately BLIND, and blindness has to be the
-- default for a column that does not exist yet as much as for one that does.
--
-- So INSERT and UPDATE name the same eight columns the SELECT does. A new column then needs an
-- explicit decision in three places that already have to agree (`STAFF_SELECT_GRANTS`,
-- `STAFF_TABLE_GRANTS`, this file) instead of arriving switched on.
--
-- DELETE STAYS TABLE-LEVEL because Postgres has no column-scoped DELETE — the verb removes
-- whole rows, so there is nothing to scope. It is in the list at all because `runAlertPass`
-- resolves an alert by DELETING its row: without it every clearing alert raises 42501 and the
-- pass 503s exactly as the incident ends.
REVOKE ALL ON public.alert_state FROM ohmail_admin;
GRANT SELECT (alert_key, kind, severity, opened_at, last_seen_at, notified_at, notify_count, detail)
  ON public.alert_state TO ohmail_admin;
GRANT INSERT (alert_key, kind, severity, opened_at, last_seen_at, notified_at, notify_count, detail)
  ON public.alert_state TO ohmail_admin;
GRANT UPDATE (alert_key, kind, severity, opened_at, last_seen_at, notified_at, notify_count, detail)
  ON public.alert_state TO ohmail_admin;
GRANT DELETE ON public.alert_state TO ohmail_admin;

-- ── 11. WHAT IS DELIBERATELY NOT GRANTED, and is enforced by the step-2 blanket revoke ────
--
--   messages            the ROW is the oracle; §4 has the argument
--   change_log          `entity_id` joins to `messages.id`; §8 has the argument
--   folder_state,       one row per message, with an event time; §7
--   flag_state
--   message_bodies      the bodies themselves
--   threads             `root_message_id_header` carries sender domains
--   drafts              unsent mail the user wrote
--   kb_entries          the user's own knowledge base
--   attachments         filenames and content types
--   contacts            everyone the user has ever corresponded with
--   contact_notes, thread_notes, snippets
--   routing_decisions, approvals, message_states, graduations, learning_signals
--   rules               `match` is a sender address or a domain
--   tracker_events      who mailed the user and when
--   mailbox_folders     the user's folder names
--   waitlist, invites   the ADDRESSES are still un-granted (a prospect is not a customer); §9d
--                       grants only their DATE columns for the funnel counts, never `email` or
--                       `code_hash`
--   workflows, workflow_runs, workflow_proposals   `steps`/`trigger` quote mail
--   public.audit_log    reachable ONLY through admin.audit_log, above
--   sessions, credentials, webauthn_credentials, webauthn_challenges, totp_secrets,
--   recovery_codes, devices, refresh_tokens, login_tokens, oauth_auth_codes, auth_events,
--   auth_throttle, idempotency_keys, push_subscriptions, account_sync_state
--                       every one of these stores or gates a live credential
--
-- None of them appears above, so step 2 leaves `ohmail_admin` holding nothing on any of them,
-- and a future table is in the same position until somebody adds a stanza for it.

-- ── 12. NO DANGEROUS `PUBLIC` GRANT. Detected and REJECTED, deliberately not revoked. ─────
--
-- `GRANT SELECT ON message_bodies TO PUBLIC` gives `ohmail_admin` every body in the database
-- and leaves no ACL entry for `ohmail_admin` to revoke. §13 would catch it — effective would
-- exceed direct — but the message would say "ohmail_admin can read message_bodies.text"
-- without saying WHY, and the operator would go looking for a grant that is not there. This
-- names PUBLIC.
--
-- REJECTED and not revoked, and that is a decision rather than an omission: revoking a PUBLIC
-- grant changes what EVERY role in the database can do, including the API's and the worker's.
-- This script's standing promise is that it cannot alter the running deployment's
-- privileges, and the ownership flip — the change that is allowed to — is a separate step
-- under its own review. An abort here costs a provisioning run; a revoke here could cost the
-- product.
--
-- Relations only. Functions are excluded because `EXECUTE` to PUBLIC is the DEFAULT for every
-- function Postgres has ever created — `pg_trgm`'s included — so flagging it would abort on
-- every healthy database. Executable code that could leak is handled in §13 instead, where
-- the test is SECURITY DEFINER, which is the property that actually matters.
DO $$
DECLARE
  found text;
BEGIN
  SELECT string_agg(DISTINCT format('%I.%I:%s', n.nspname, c.relname, a.privilege_type), ', ')
    INTO found
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(c.relacl) AS a
   WHERE n.nspname IN ('public', 'admin')
     AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
     AND a.grantee = 0;                      -- 0 is PUBLIC
  IF found IS NOT NULL THEN
    RAISE EXCEPTION
      'relation privileges are granted to PUBLIC, which reaches ohmail_admin and cannot be revoked from it: %. Revoke them by hand — deliberately, and knowing which other roles lose them — then re-run this script.',
      found;
  END IF;

  SELECT string_agg(DISTINCT format('%I.%I.%I:%s', n.nspname, c.relname, at.attname,
                                    a.privilege_type), ', ')
    INTO found
    FROM pg_attribute at
    JOIN pg_class c  ON c.oid = at.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(at.attacl) AS a
   WHERE n.nspname IN ('public', 'admin')
     AND at.attnum > 0 AND NOT at.attisdropped
     AND a.grantee = 0;
  IF found IS NOT NULL THEN
    RAISE EXCEPTION
      'column privileges are granted to PUBLIC, which reaches ohmail_admin and cannot be revoked from it: %. Revoke them by hand, then re-run this script.',
      found;
  END IF;
END $$;

-- ── 12b. SCHEMA `admin` HOLDS THIS FILE'S TWO VIEWS AND NOTHING ELSE. ─────────────────────
--
-- `admin` is this script's own schema. It creates it, it puts exactly two views in it
-- (`audit_log` §3, `credit_ledger` §9b), and it points the role's `search_path` at it.
-- Anything else in there is an object nobody reviewed sitting in the one namespace the staff
-- role searches FIRST.
--
-- The list is stated a second time, independently, in `STAFF_ADMIN_VIEWS`
-- (`packages/db/src/staff-grants.ts`), which the pg guard and the provisioning runner's
-- pre-flight both consult. This file cannot import it; that is the same two-independent-
-- statements arrangement the GRANTs already live under, and a diff in either one is visible.
--
-- The review's demonstrated sequence: `CREATE VIEW admin.mail_preview AS SELECT subject, from_address FROM
-- public.messages`, granted to `ohmail_admin` "as a temporary production support aid". A view
-- reads its base tables with its OWNER's privileges, so it answers with mail while every
-- column grant in §4 stays exactly as narrow as it looks, the column census stays green, and
-- the boot probe still gets its 42501. §2 now revokes the grant — but leaving the view in
-- place would mean the next `GRANT SELECT ON admin.mail_preview` is one line away from
-- undoing this file, and `admin.messages` would SHADOW `public.messages` on this role's
-- search_path.
--
-- ABORTED, not dropped. Dropping somebody's object during a provisioning run is a surprise
-- with a CASCADE behind it; refusing to provision until a human removes it is not. Same
-- judgement as §12.
--
-- The exact COLUMN LISTS are not restated here. They are fixed by the two CREATE VIEWs, and
-- pinned independently by `STAFF_SELECT_GRANTS` in `packages/db/src/staff-grants.ts` — which
-- `staff-role.pg.test.ts` asserts by EQUALITY and the API's boot attestation refuses to start
-- without. What IS checked here is the property that file cannot see: that no jsonb bag is
-- projected at all, whatever the list says.
DO $$
DECLARE
  found text;
BEGIN
  SELECT string_agg(format('%I.%I (%s)', n.nspname, c.relname, c.relkind), ', ' ORDER BY 1)
    INTO found
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'admin'
     AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
     AND NOT (c.relkind = 'v' AND c.relname IN ('audit_log', 'credit_ledger'));
  IF found IS NOT NULL THEN
    RAISE EXCEPTION
      'schema admin holds relations this script did not create: %. It is the schema the staff role searches FIRST, and a view there reads its base tables with the VIEW OWNER''s privileges — which is a content path around every column grant in this file. Drop them or move them out of admin, then re-run.',
      found;
  END IF;

  SELECT string_agg(format('%I.%I', n.nspname, p.proname), ', ' ORDER BY 1) INTO found
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'admin';
  IF found IS NOT NULL THEN
    RAISE EXCEPTION
      'schema admin holds routines this script did not create: %. Drop them or move them out of admin, then re-run.',
      found;
  END IF;

  -- The bags, by TYPE rather than by name: `payload` and `inverse` are jsonb, nothing bounds
  -- what a producer puts in one, and a view that projected either would hand the console a
  -- `workflow_step` row whose `effect` quotes mail.
  SELECT string_agg(format('%I.%I.%I', n.nspname, c.relname, a.attname), ', ' ORDER BY 1)
    INTO found
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
   WHERE n.nspname = 'admin'
     AND format_type(a.atttypid, NULL) IN ('json', 'jsonb');
  IF found IS NOT NULL THEN
    RAISE EXCEPTION
      'schema admin projects a json/jsonb BAG: %. Nothing about the column bounds what a producer may put in one, so it is never granted. Promote the value the console needs to a named column on the producer side.',
      found;
  END IF;
END $$;

-- ── 13. THE POSTCONDITION. `ohmail_admin` holds NOTHING this file did not grant it. ───────
--
-- Everything above is an intention. This is the only part that is a fact, and it aborts the
-- transaction — rolling back every grant in this file — when it is not.
--
-- **The rule is `effective ⇒ direct`.** For every relation, column, sequence and schema in
-- the application's two schemas: if `has_*_privilege` says `ohmail_admin` holds a privilege,
-- there must be an ACL entry granting it DIRECTLY to `ohmail_admin`. That single comparison
-- is exactly the shape of the review's postcondition finding, because the three privilege
-- sources `REVOKE` cannot reach — role membership, a `PUBLIC` grant, and ownership — are precisely the ones that make
-- `effective` exceed `direct`.
--
-- **Why there is no allowlist spelled out here, and why that is not the oversight it looks
-- like.** The GRANT statements above ARE this file's statement of intent; a census that
-- re-listed them would be a third copy of a constant this repo has already been bitten by
-- twice and would agree with the grants by construction — it would prove nothing.
-- The INDEPENDENT statement lives in `packages/db/src/staff-grants.ts`, and it is checked
-- twice: the provisioning guard suite asserts the effective set EQUALS it, and the API's boot
-- attestation refuses to build the staff handle when the live role EXCEEDS it. Adding
-- `subject` to §4 passes this block and fails both of those, by name.
--
-- Functions are outside the rule: `EXECUTE` to PUBLIC is Postgres's default for every
-- function, so `effective ⇒ direct` would fail on a healthy database. The property that
-- matters for a function is SECURITY DEFINER — it runs as its OWNER, straight through every
-- grant above — and that is checked separately below.
DO $$
DECLARE
  me    oid  := 'ohmail_admin'::regrole::oid;
  drift text;
BEGIN
  SELECT string_agg(q.what, E'\n    ' ORDER BY q.what) INTO drift FROM (
    WITH rel AS (
      SELECT c.oid, n.nspname, c.relname, c.relkind
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname IN ('public', 'admin')
         AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
    ),
    -- A table-level ACL entry granted DIRECTLY to the role. Column privileges are implied by
    -- the table-level grant, which is why this is consulted for both halves below.
    tbl_direct AS (
      SELECT rel.oid, a.privilege_type
        FROM rel
        JOIN pg_class c ON c.oid = rel.oid
        CROSS JOIN LATERAL aclexplode(c.relacl) AS a
       WHERE a.grantee = me
    ),
    col_direct AS (
      SELECT at.attrelid, at.attnum, a.privilege_type
        FROM pg_attribute at
        CROSS JOIN LATERAL aclexplode(at.attacl) AS a
       WHERE a.grantee = me
         AND at.attrelid IN (SELECT oid FROM rel)
    )
    SELECT format('SELECT on column %s.%s.%s', rel.nspname, rel.relname, at.attname) AS what
      FROM rel
      JOIN pg_attribute at ON at.attrelid = rel.oid AND at.attnum > 0 AND NOT at.attisdropped
      CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) AS p(priv)
     WHERE rel.relkind <> 'S'
       AND has_column_privilege(me, rel.oid, at.attnum, p.priv)
       AND NOT EXISTS (SELECT 1 FROM tbl_direct t
                        WHERE t.oid = rel.oid AND t.privilege_type = p.priv)
       AND NOT EXISTS (SELECT 1 FROM col_direct d
                        WHERE d.attrelid = rel.oid AND d.attnum = at.attnum
                          AND d.privilege_type = p.priv)
    UNION ALL
    SELECT format('%s on relation %s.%s', p.priv, rel.nspname, rel.relname)
      FROM rel
      CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE',
                              'REFERENCES', 'TRIGGER']) AS p(priv)
     WHERE rel.relkind <> 'S'
       AND has_table_privilege(me, rel.oid, p.priv)
       AND NOT EXISTS (SELECT 1 FROM tbl_direct t
                        WHERE t.oid = rel.oid AND t.privilege_type = p.priv)
    UNION ALL
    SELECT format('%s on sequence %s.%s', p.priv, rel.nspname, rel.relname)
      FROM rel
      CROSS JOIN unnest(ARRAY['SELECT', 'UPDATE', 'USAGE']) AS p(priv)
     WHERE rel.relkind = 'S'
       AND has_sequence_privilege(me, rel.oid, p.priv)
       AND NOT EXISTS (SELECT 1 FROM tbl_direct t
                        WHERE t.oid = rel.oid AND t.privilege_type = p.priv)
    UNION ALL
    SELECT format('%s on schema %s', p.priv, n.nspname)
      FROM pg_namespace n
      CROSS JOIN unnest(ARRAY['USAGE', 'CREATE']) AS p(priv)
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
       AND n.nspname NOT LIKE 'pg\_temp\_%'
       AND n.nspname NOT LIKE 'pg\_toast\_temp\_%'
       AND has_schema_privilege(me, n.oid, p.priv)
       AND NOT EXISTS (SELECT 1 FROM aclexplode(n.nspacl) AS a
                        WHERE a.grantee = me AND a.privilege_type = p.priv)
  ) q;

  IF drift IS NOT NULL THEN
    RAISE EXCEPTION
      E'POSTCONDITION FAILED — ohmail_admin holds privileges this file never granted it, so they came from role membership, a grant to PUBLIC, or ownership, and no REVOKE in this file can remove them. The transaction is rolled back and NOTHING was provisioned.\n    %',
      drift;
  END IF;

  -- The three things the rule above cannot express, re-checked AFTER §1b–§1d repaired them.
  -- A repair that silently did not take must not reach COMMIT.
  SELECT string_agg(x.what, ', ' ORDER BY x.what) INTO drift FROM (
    SELECT 'MEMBER of ' || r.rolname AS what
      FROM pg_roles r
     WHERE r.oid <> me AND pg_has_role(me, r.oid, 'MEMBER')
    UNION ALL
    -- EVERY relkind, including indexes, which §1d's repair loop deliberately skips: Postgres
    -- refuses `ALTER INDEX … OWNER TO` because an index's owner FOLLOWS its table's, so
    -- handing the table back in §1d hands its indexes back with it. An index that turned up
    -- here anyway would be a state §1d cannot reach, and aborting is the right answer to that.
    SELECT 'OWNS ' || format('%I.%I', n.nspname, c.relname)
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relowner = me
       AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
    UNION ALL
    SELECT 'role attribute ' || a.attr
      FROM pg_roles r
      CROSS JOIN LATERAL (VALUES ('SUPERUSER',   r.rolsuper),
                                 ('BYPASSRLS',   r.rolbypassrls),
                                 ('CREATEROLE',  r.rolcreaterole),
                                 ('CREATEDB',    r.rolcreatedb),
                                 ('REPLICATION', r.rolreplication)) AS a(attr, held)
     WHERE r.oid = me AND a.held
    UNION ALL
    -- A SECURITY DEFINER routine runs with its OWNER's privileges, so one of them
    -- over a protected column is a content path that every other mechanism in this slice
    -- misses: no relation privilege changed, so the column census is green; the bite tests
    -- still get their 42501; and the routine answers with mail.
    --
    -- It cannot be revoked away here, and that is the whole reason it aborts. Postgres grants
    -- `EXECUTE` to PUBLIC on every routine it creates, `REVOKE … FROM ohmail_admin` does not
    -- negate a PUBLIC grant, and revoking from PUBLIC changes what every other role can do —
    -- §12's judgement, for the same reason. The remedy is one line, and it belongs to a human:
    -- `REVOKE EXECUTE ON FUNCTION <f> FROM PUBLIC`.
    --
    -- Scoped to `public` and `admin` because those are the only schemas the role holds USAGE
    -- on, and the first half of this block has already proved it holds no other.
    SELECT 'EXECUTE on SECURITY DEFINER '
             || format('%I.%I(%s)', n.nspname, p.proname,
                       pg_get_function_identity_arguments(p.oid))
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.prosecdef
       AND n.nspname IN ('public', 'admin')
       AND has_function_privilege(me, p.oid, 'EXECUTE')
  ) x;

  IF drift IS NOT NULL THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED — ohmail_admin still holds: %. If that names a SECURITY DEFINER routine, it reaches it through the EXECUTE Postgres grants to PUBLIC by default: REVOKE EXECUTE ON that routine FROM PUBLIC. The transaction is rolled back and NOTHING was provisioned.',
      drift;
  END IF;
END $$;

COMMIT;

-- ── AFTERWARDS, BY HAND ───────────────────────────────────────────────────────────────────
--   ALTER ROLE ohmail_admin PASSWORD '…';   -- out of band; never committed
--   DATABASE_URL_ADMIN = postgres://ohmail_admin:…@<your-pooler-host>/…
--
-- Then run the VERIFY block at the top of this file as `ohmail_admin`, BEFORE deploying the
-- API build that reads `DATABASE_URL_ADMIN`. The API's own boot probe repeats one of those
-- checks (`SELECT subject FROM messages WHERE false` must raise 42501) and refuses to build
-- the admin connection on any other answer, INCLUDING success — which is what catches the
-- realistic accident of runtime credentials pasted into the admin variable.
