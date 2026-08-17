-- ============================================================================
-- supabase-lockdown.sql — close the Data API on a Supabase-hosted ohmail database.
--
-- WHY THIS EXISTS
--
-- ohmail does not use PostgREST, Supabase Auth, or any Supabase client SDK. It talks to
-- Postgres directly as the database's owning role, and its own auth system (sessions, TOTP,
-- KEK) predates the host. Supabase does not know that. A stock project ships:
--
--   * `ALTER DEFAULT PRIVILEGES ... IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated,
--     service_role` — registered for BOTH `postgres` and `supabase_admin`, so every table any
--     future migration creates is granted away at CREATE time; and
--   * PostgREST bound to `db_schema = public`, reachable at `https://<ref>.supabase.co/rest/v1/`
--     by anyone holding the anon key, which is a PUBLIC key that ships in client bundles.
--
-- What that pair of defaults exposes is not hypothetical. A stock project with this
-- repository's full migration chain applied and nothing else configured measures as:
--
--   public tables .................. 55        (relrowsecurity = true on 0 of them)
--   anon ........................... 443 privileges across 56 relations
--   authenticated .................. 443 privileges across 56 relations
--   service_role ................... 443 privileges across 56 relations
--   the ACL ........................ arwdDxtm — not merely SELECT. INSERT, UPDATE, DELETE,
--                                    TRUNCATE, REFERENCES, TRIGGER, MAINTAIN.
--
-- And confirmed from outside, with nothing but the anon key and curl:
--
--   GET /rest/v1/messages?select=*            -> 200
--   GET /rest/v1/message_bodies?select=*      -> 200
--   GET /rest/v1/mailbox_credentials?select=* -> 200
--   GET /rest/v1/users?select=*               -> 200
--
-- They return `[]` only while the database has no rows. A refused read returns 401, not an
-- empty array — the 200 IS the finding. Put production data behind those defaults and every
-- mailbox, every message body and every envelope-encrypted credential row in the product would
-- be world-readable, and world-DELETABLE, from a key that ships in client bundles on purpose.
--
-- This is the product's core privacy rule — an account's mail reachable by that account's own
-- users and by nobody else — broken by the host's defaults, and it is invisible to every
-- mechanism built for it: `harden-staff-role.sql`'s pre-flight tests `grantee = 0` (PUBLIC),
-- and `anon` is a NAMED role; the boot attestation in `staff-grants.ts` measures `ohmail_admin` and nothing else.
-- Both stay green while the whole schema is exposed. A clean pre-flight means "safe for
-- ohmail_admin", never "safe" — worth remembering the next time a green check feels like proof.
--
-- WHY REVOKE AND NOT RLS
--
-- RLS is the Supabase-native answer and it is the wrong tool here. It presumes the anon role is
-- a legitimate caller that needs narrowing. It is not a caller at all — nothing in this codebase
-- authenticates through it. Enabling RLS on 55 tables would create 55 policy surfaces to get
-- right, forever, to protect a path that should not exist. Removing the grant removes the
-- surface. Defense in depth argues for both; scope and honesty argue for doing the structural
-- one properly rather than two half-way.
--
-- BOTH HALVES ARE REQUIRED. Disabling the Data API in project settings without revoking the
-- grants is the "absent config selects the dangerous branch" failure shape: one dashboard
-- click, or one support-driven re-enable, and the schema is public again. Revoking without
-- closing PostgREST leaves an endpoint answering 401 that need not answer at all. The runner
-- (`packages/db/src/supabase-lockdown.ts`) applies the grant half, then does the PostgREST
-- config through the Management API and re-probes from outside afterwards.
--
-- THE EXECUTABLE COPY OF THIS BATCH LIVES IN `packages/db/src/supabase-lockdown-core.ts`
-- (`lockdownSqlFor`), embedded rather than read off disk because `setupProdDatabase` — which now
-- runs the grant half on EVERY provisioning pass and refuses success while the census is red —
-- is bundled into artifacts that do not carry this repository's `scripts/` directory. This file
-- remains the annotated operator reference for a hand psql run, and a sync test compares the two
-- statement-for-statement (comments and whitespace aside) on every run of the database package's
-- suite, so neither copy can rot alone.
--
-- IDEMPOTENT. Safe to re-run, and it must be re-run after anything that creates tables in
-- `public` until the default-privilege rules below are confirmed dropped.
-- ============================================================================

BEGIN;

-- ── 1. Existing objects ────────────────────────────────────────────────────────────────────
--
-- `ALL TABLES` covers views and materialized views too, which matters: `admin.credit_ledger`
-- lives in schema `admin` and is out of scope here, but any future redacting view placed in
-- `public` would otherwise be granted away exactly like a table.

REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated, service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated, service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated, service_role;
REVOKE ALL ON ALL ROUTINES  IN SCHEMA public FROM anon, authenticated, service_role;

-- USAGE on the schema is what makes a name resolvable at all. Revoking it is belt-and-braces
-- over the per-object revokes above, and it is what makes a MISSED object fail closed instead
-- of open — the failure mode that matters, because the whole point is future tables.
REVOKE ALL ON SCHEMA public FROM anon, authenticated, service_role;

-- ── 2. Future objects ──────────────────────────────────────────────────────────────────────
--
-- The census on the stock project showed default-privilege rules registered under TWO grantors,
-- `postgres` and `supabase_admin`. `ALTER DEFAULT PRIVILEGES` is per-(grantor, schema, objtype):
-- a rule only fires for objects created BY that role, and revoking one leaves the other armed.
--
-- The grantor list is MEASURED, not hardcoded: every grantor whose rules currently grant to the
-- host roles, plus the two Supabase names when they exist. A hardcoded pair was the original
-- form, and it made the script permanently unrunnable anywhere the migration role has a
-- different name — an offending rule under grantor `tf` (the pg test cluster) or under any
-- self-hoster's own role was invisible to §2 and then fatal to §3, a postcondition that could
-- never hold. Measuring the grantors keeps §3 satisfiable exactly where the session can act.
--
-- `FOR ROLE <grantor>` requires membership in it. On a stock project `postgres` has membership
-- in what matters, but it is not guaranteed, and a hosting-side change could remove it. Rather
-- than let the script die half-applied, each is attempted and a failure is reported as a
-- WARNING — then §3's postcondition decides whether the result is acceptable. A warning that
-- leaves a REACHABLE live rule WILL abort the transaction below; a warning on an unreachable
-- grantor's rule lands in the residual report. The check is on the end state, never on whether
-- a statement was skipped.

DO $$
DECLARE
  grantor  text;
  objtype  text;
  stmt     text;
BEGIN
  FOR grantor IN
    SELECT DISTINCT d.defaclrole::regrole::text
      FROM pg_default_acl d,
           LATERAL aclexplode(d.defaclacl) a
     WHERE d.defaclnamespace = 'public'::regnamespace
       AND a.grantee::regrole::text IN ('anon', 'authenticated', 'service_role')
    UNION
    SELECT rolname FROM pg_roles WHERE rolname IN ('postgres', 'supabase_admin')
  LOOP
    FOREACH objtype IN ARRAY ARRAY['TABLES', 'SEQUENCES', 'FUNCTIONS', 'ROUTINES', 'TYPES'] LOOP
      stmt := format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON %s FROM anon, authenticated, service_role',
        grantor, objtype);
      BEGIN
        EXECUTE stmt;
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'could not revoke default privileges (% / %): %', grantor, objtype, SQLERRM;
      END;
    END LOOP;
  END LOOP;
END $$;

-- ── 3. Postconditions — this script proves its own outcome or aborts ───────────────────────
--
-- Two separate facts. Either one alone is a false negative: no live grants but a surviving
-- default rule means the NEXT migration silently re-opens everything, which is precisely how
-- this project arrived in the state it was found in.
--
-- ── WHY THE RULE CHECK IS SCOPED TO REACHABLE GRANTORS ─────────────────────────────────────
--
-- Measured on this project after the first run of this script ABORTED on exactly
-- this condition (it rolled back cleanly and wrote nothing — the guard doing its job):
--
--   rules by grantor ....... postgres 36, supabase_admin 36
--   membership ............. pg_has_role(postgres, supabase_admin, MEMBER) = FALSE
--   owners of public ....... postgres, all 55 objects
--
-- `ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin` therefore cannot be executed by us at all,
-- and demanding zero would make this script permanently unrunnable — a postcondition that can
-- never hold is not a guard, it is a wall.
--
-- It is also not the right question. A default-privilege rule fires only for objects created BY
-- ITS OWN GRANTOR. Migrations run as `postgres` (`setup-prod.ts`), every object in `public` is
-- owned by `postgres`, and so the `postgres` rules are the ones that decide what our tables
-- inherit. The `supabase_admin` rules would bite only if `supabase_admin` itself created a table
-- in `public`, which on this project it never has.
--
-- So the check aborts on any rule whose grantor THIS SESSION COULD CREATE OBJECTS AS, and
-- reports the rest as a residual rather than pretending it is clean. Two things keep that
-- residual honest, because "we reasoned it cannot matter" is precisely the kind of claim this
-- codebase treats as the thing under test rather than evidence for it:
--
--   1. `supabase-lockdown.ts --prove` creates a table as the migration role AFTER this runs and
--      requires it to inherit NOTHING. Before the lockdown that same probe inherited all 24
--      privileges, so the check has been watched both red and green on the real database.
--   2. PostgREST is taken off schema `public` in the same operation, so even a table that did
--      slip through is not reachable from the internet by the anon key.

DO $$
DECLARE
  live_grants  int;
  live_rules   int;
  residual     int;
  detail       text;
BEGIN
  SELECT count(*) INTO live_grants
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace,
         LATERAL aclexplode(c.relacl) a
   WHERE n.nspname = 'public'
     AND a.grantee::regrole::text IN ('anon', 'authenticated', 'service_role');

  IF live_grants > 0 THEN
    SELECT string_agg(DISTINCT c.relname, ', ') INTO detail
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace,
           LATERAL aclexplode(c.relacl) a
     WHERE n.nspname = 'public'
       AND a.grantee::regrole::text IN ('anon', 'authenticated', 'service_role');
    RAISE EXCEPTION
      'ABORT: % privileges for anon/authenticated/service_role survive in schema public (%)',
      live_grants, detail;
  END IF;

  -- Reachable: a grantor this session can create objects as, so its rules govern OUR tables.
  SELECT count(*) INTO live_rules
    FROM pg_default_acl d,
         LATERAL aclexplode(d.defaclacl) a
   WHERE d.defaclnamespace = 'public'::regnamespace
     AND a.grantee::regrole::text IN ('anon', 'authenticated', 'service_role')
     AND pg_has_role(current_user, d.defaclrole, 'USAGE');

  IF live_rules > 0 THEN
    SELECT string_agg(DISTINCT d.defaclrole::regrole::text, ', ') INTO detail
      FROM pg_default_acl d,
           LATERAL aclexplode(d.defaclacl) a
     WHERE d.defaclnamespace = 'public'::regnamespace
       AND a.grantee::regrole::text IN ('anon', 'authenticated', 'service_role')
       AND pg_has_role(current_user, d.defaclrole, 'USAGE');
    RAISE EXCEPTION
      'ABORT: % reachable default-privilege rules still grant to anon/authenticated/service_role '
      '(grantors: %) — every future table created by that role would be re-exposed at CREATE '
      'time. These ARE revocable by this session, so this is a real failure, not a residual.',
      live_rules, detail;
  END IF;

  -- Unreachable: reported every run, never silently tolerated.
  SELECT count(*) INTO residual
    FROM pg_default_acl d,
         LATERAL aclexplode(d.defaclacl) a
   WHERE d.defaclnamespace = 'public'::regnamespace
     AND a.grantee::regrole::text IN ('anon', 'authenticated', 'service_role')
     AND NOT pg_has_role(current_user, d.defaclrole, 'USAGE');

  IF residual > 0 THEN
    SELECT string_agg(DISTINCT d.defaclrole::regrole::text, ', ') INTO detail
      FROM pg_default_acl d,
           LATERAL aclexplode(d.defaclacl) a
     WHERE d.defaclnamespace = 'public'::regnamespace
       AND a.grantee::regrole::text IN ('anon', 'authenticated', 'service_role')
       AND NOT pg_has_role(current_user, d.defaclrole, 'USAGE');
    RAISE NOTICE
      'RESIDUAL: % default-privilege rules remain under grantor(s) % — not revocable by %, and '
      'inert unless that role creates a table in public. Covered by --prove and by PostgREST no '
      'longer serving this schema.', residual, detail, current_user;
  END IF;

  RAISE NOTICE 'lockdown postconditions hold: 0 live grants, 0 reachable default-privilege rules';
END $$;

COMMIT;
