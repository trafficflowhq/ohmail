-- ─────────────────────────────────────────────────────────────────────────────────────────
-- THE RUNTIME LOGINS OF THE CLOUD DATABASE. Makes and provisions `ohmail_api` and
-- `ohmail_worker`: two logins that own nothing, may not bypass row security and are members of
-- nothing. Names the MIGRATOR, the one role that owns the schema and bypasses row security.
--
-- Run it through its runner, never by hand:
--
--   bash deploy/sql/harden-runtime-roles.sh                                   -- the census alone, read-only
--   OHMAIL_DEPLOY_GO=GO-DB-ROLES bash deploy/sql/harden-runtime-roles.sh --apply
--
-- It holds no password and sets none. A login it made cannot sign in until its password is set
-- out of band (deploy/runbooks/DB-PASSWORD-ROTATION.md).
--
-- ## The same shape as harden-staff-role.sql, for the same reason
--
-- `REVOKE … FROM role` removes only what was granted DIRECTLY to the role. A right reached through
-- a membership, a grant to PUBLIC or ownership survives it. So this file first normalises the
-- logins (attributes, memberships both ways, ownership), then removes every direct grant the rule
-- below does not write, then writes the rule, and ends with a census of what each login can
-- EFFECTIVELY do. The census raises on any drift, in either direction, and the transaction rolls
-- back with nothing changed. Run again, it repairs what a hand widened: writing the rule onto a
-- new table prints a `write:` line, undoing a drift prints a `repair:` line, and a run on a
-- database that already matches prints neither.
--
-- ## One file, two shapes of host
--
--  · PLAIN: the session is a superuser (a Postgres of our own). The file makes `ohmail_migrator`
--    (may create roles, bypasses row security, no superuser) and hands it the database and every
--    relation, sequence and routine of the product's schemas. Where a role that is no superuser
--    already owns them, that role is the server's migrator and the superuser's run is refused:
--    the hand-over would take its tables from whatever signs in as it.
--  · MANAGED: the session is not a superuser (a host that gives none). The role that owns the
--    schema IS the migrator: the file asserts that it owns everything and bypasses row security,
--    never alters it and changes no object's owner. A missing right is refused by name.
--
-- From section 1 on the text is the same for both: a repair the session cannot make is refused,
-- naming the object and the one line to run by hand.
--
-- ## The rule
--
-- On every TABLE of schema `public`: SELECT, INSERT, UPDATE, DELETE for both logins. Narrower on
-- the tables the @rows block names (the staff's sign-in tables, invites, the waitlist). Derived
-- from the catalog at run time, so a table a later migration makes gets the rule when this file
-- runs again; until then it has no grant at all. There is deliberately no ALTER DEFAULT
-- PRIVILEGES: a table that was just made or rebuilt carries no row policy yet, and a default
-- grant would open it to the runtime logins in that state.
--
-- Never TRUNCATE, REFERENCES, TRIGGER or MAINTAIN; no column grant; no grant on a sequence or a
-- routine, nor on a view but the row lock's three (below); USAGE on `public` (and on the schema the
-- search extensions live in, where a login reaches no relation but an extension's own), on
-- `ohmail` while one of the lock's views stands there, and on no other schema; nothing in `admin`,
-- `plane` or the migration ledgers.
--
-- Grants to PUBLIC on the product's relations, and CREATE on its schemas, are revoked: PUBLIC
-- reaches every login. What other named roles hold (the staff role, the billing plane's) is read
-- and never touched.
--
-- ## The row lock's views
--
-- Under the row lock a search through `public` loses its indexes: a policy keeps a statement's
-- condition on an index only when every operator in it is leakproof, and the search's are not. So
-- the search reads three views in schema `ohmail` (ohmail.messages, ohmail.message_search,
-- ohmail.message_search_words), each answering the bound account's rows alone, through which the
-- planner keeps its indexes. The lock's setup step makes them, owned by the migrator; this file
-- grants them, and only where they stand: SELECT on each to both logins, and USAGE on `ohmail`
-- while one of them stands. Nothing else there is a login's: no write on a view, no grant option,
-- no fourth relation, no routine but the lock's two readers. Nobody else reaches anything there,
-- by any road: no entry (PUBLIC, the staff role, the billing plane, a host's role) and no
-- membership (pg_read_all_data, pg_write_all_data, or a role that holds one, inherited, one SET
-- ROLE away, or a grant of its own away by an ADMIN option), for a view there reads its tables
-- with the migrator's rights. The roles that read every row already, by SUPERUSER, BYPASSRLS or
-- REPLICATION, are the host's: the report names them. The views' names are the rule's rows (@rows,
-- and runtime-roles.tsv), never read from the catalog. A view's text is not judged here: one made
-- again under its name with another text is the lock's own check's to refuse. The lock's ruling
-- said the logins get no USAGE on `ohmail`, since a policy calls its readers by their stored id; the
-- search ruling changed that one line on purpose, for these views, and the USAGE goes with them.
--
-- ## Plain SQL, one transaction
--
-- No psql meta-command: a driver may send the file whole as one simple query. After a refusal the
-- session sits in the failed transaction; the sender rolls back or ends the connection.
--
-- ## The markers
--
-- `-- @shape`, `-- @provision`, `-- @census` and `-- @commit` cut the file into the sections the
-- runner sends: check mode is `BEGIN READ ONLY`, the shape section, the census section,
-- `ROLLBACK`. `-- @clause <name>` / `-- @end <name>` fence one defence each, so that the test can
-- run a copy without it and see the fault it guards pass in silence.
-- ─────────────────────────────────────────────────────────────────────────────────────────

BEGIN;

-- This transaction's own deadlines, whatever the migrator's role carries: a lock it cannot get in
-- 30 s ends the run with nothing changed, and no single statement is cut short.
SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = 0;
SET LOCAL idle_in_transaction_session_timeout = 0;

-- @shape
-- ── 0. THE RULE AS DATA, AND WHO THE MIGRATOR IS. Reads only: check mode sends this too. ──
DO $$
DECLARE
  is_super boolean;
  migrator text;
  shape    text;
  their_owner   text;
  their_objects text;
BEGIN
  -- @rows  (deploy/sql/runtime-roles.tsv states the same rows a second time, independently)
  PERFORM set_config('ohmail.roles_runtime', '{ohmail_api,ohmail_worker}', true);
  PERFORM set_config('ohmail.roles_rule', jsonb_build_object(
    'default', to_jsonb(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']),
    'narrowed', (
      SELECT jsonb_object_agg(per_role.role, per_role.tables)
        FROM (
          SELECT v.role, jsonb_object_agg(v.tbl, to_jsonb(string_to_array(v.verbs, ' '))) AS tables
            FROM (VALUES
              ('ohmail_api',    'staff_users',        'SELECT INSERT UPDATE'),
              ('ohmail_api',    'staff_sessions',     'SELECT INSERT UPDATE'),
              ('ohmail_api',    'staff_role_grants',  'SELECT INSERT UPDATE'),
              ('ohmail_api',    'staff_audit_log',    'INSERT'),
              ('ohmail_api',    'staff_audit_events', 'INSERT'),
              ('ohmail_api',    'invites',            'SELECT INSERT UPDATE'),
              ('ohmail_api',    'waitlist',           'SELECT INSERT UPDATE'),
              ('ohmail_worker', 'staff_users',        ''),
              ('ohmail_worker', 'staff_sessions',     'SELECT UPDATE DELETE'),
              ('ohmail_worker', 'staff_role_grants',  ''),
              ('ohmail_worker', 'staff_audit_log',    ''),
              ('ohmail_worker', 'staff_audit_events', ''),
              ('ohmail_worker', 'invites',            'SELECT UPDATE DELETE'),
              ('ohmail_worker', 'waitlist',           '')
            ) AS v(role, tbl, verbs)
           GROUP BY v.role
        ) per_role)
  )::text, true);
  -- Our own roles and the billing plane's: none of them may bypass row security. Only the migrator may.
  PERFORM set_config('ohmail.roles_no_bypass',
    '{ohmail_api,ohmail_worker,ohmail_admin,plane_runtime,plane_migrator,ohmail_stats,plane_stats}', true);
  -- The schemas the product's own objects live in. Never `plane`: the billing plane owns it.
  PERFORM set_config('ohmail.roles_schemas', '{public,admin,drizzle_mail,drizzle_cloud}', true);
  -- The schemas a login may USE. The search extensions' own schema joins them below, where a host
  -- keeps extensions apart; a schema added here is a decision. Beside `public` there is one: `ohmail`,
  -- the row lock's own, used only while one of the login's views below stands in it. (The lock's
  -- ruling had "the logins get no USAGE on it"; the search ruling changed that line, for the views.)
  PERFORM set_config('ohmail.roles_usage_schemas', '{public,ohmail}', true);
  -- THE ACCOUNT'S VIEWS OF THE ROW LOCK, by name, and what each login may do on them: read them.
  -- The lock's setup step makes them; this file grants them, only where they stand. Cut out, the
  -- views are relations the rule does not know: the census refuses them (the plant's case).
  PERFORM set_config('ohmail.roles_views', '{}', true);
  -- @clause rows.views
  PERFORM set_config('ohmail.roles_views', (
    SELECT jsonb_object_agg(per_role.role, per_role.views)
      FROM (
        SELECT v.role, jsonb_object_agg(v.rel, to_jsonb(string_to_array(v.verbs, ' '))) AS views
          FROM (VALUES
            ('ohmail_api',    'ohmail.messages',             'SELECT'),
            ('ohmail_api',    'ohmail.message_search',       'SELECT'),
            ('ohmail_api',    'ohmail.message_search_words', 'SELECT'),
            ('ohmail_worker', 'ohmail.messages',             'SELECT'),
            ('ohmail_worker', 'ohmail.message_search',       'SELECT'),
            ('ohmail_worker', 'ohmail.message_search_words', 'SELECT')
          ) AS v(role, rel, verbs)
         GROUP BY v.role
      ) per_role)::text, true);
  -- @end rows.views
  -- The routines a login may run in that schema: the lock's two readers, which every view and every
  -- policy calls. EXECUTE on them is PUBLIC's, as Postgres makes every routine; this file grants
  -- none, and a direct grant to a login is refused like any other.
  PERFORM set_config('ohmail.roles_view_routines', (
    SELECT jsonb_object_agg(per_role.role, per_role.fns)
      FROM (
        SELECT v.role, jsonb_agg(v.fn ORDER BY v.fn) AS fns
          FROM (VALUES
            ('ohmail_api',    'ohmail.current_account()'),
            ('ohmail_api',    'ohmail.current_key()'),
            ('ohmail_worker', 'ohmail.current_account()'),
            ('ohmail_worker', 'ohmail.current_key()')
          ) AS v(role, fn)
         GROUP BY v.role
      ) per_role)::text, true);
  -- The server-side deadlines, in milliseconds, and the roles that carry them: the two logins and
  -- the staff role. Never the migrator: a dump, a migration and a restore set or lift their own.
  -- @deadlines
  PERFORM set_config('ohmail.roles_deadlines', (
    SELECT jsonb_object_agg(v.setting, v.ms)::text
      FROM (VALUES
        ('lock_timeout',                        30000),
        ('statement_timeout',                   55000),
        ('idle_in_transaction_session_timeout', 60000)
      ) AS v(setting, ms)), true);
  PERFORM set_config('ohmail.roles_deadline_roles', '{ohmail_api,ohmail_worker,ohmail_admin}', true);
  -- @end rows

  IF current_setting('server_version_num')::int < 160000 THEN
    RAISE EXCEPTION 'ROLES_REFUSED server: this file needs Postgres 16 or later (membership options are in the catalog from 16 on); this server is %',
      current_setting('server_version');
  END IF;

  -- @clause shape.login
  IF session_user <> current_user THEN
    RAISE EXCEPTION 'ROLES_REFUSED login: the session signed in as % and runs as %. Sign in as the migrator itself, not through SET ROLE',
      session_user, current_user;
  END IF;
  IF current_user = ANY (current_setting('ohmail.roles_no_bypass')::text[]) THEN
    RAISE EXCEPTION 'ROLES_REFUSED login: % is a runtime or service login, not the migrator. Run this as the role that owns the schema',
      current_user;
  END IF;
  -- @end shape.login

  SELECT rolsuper INTO is_super FROM pg_roles WHERE rolname = current_user;
  IF is_super THEN
    shape := 'plain';
    migrator := 'ohmail_migrator';
    -- A superuser's run hands everything to ohmail_migrator. Where a role that is no superuser and
    -- none of ours owns the database or the product's relations, the migrations ran as that role
    -- and a service may sign in as it: it is this server's migrator, and the hand-over would take
    -- every right on its own tables from it. (A table strayed to a role of ours is a fault, and
    -- section 1d takes it back.)
    -- @clause shape.owner
    SELECT w.rolname, concat_ws(' and ', CASE WHEN bool_or(x.is_db) THEN 'the database' END,
                                CASE WHEN count(*) FILTER (WHERE NOT x.is_db) > 0
                                     THEN count(*) FILTER (WHERE NOT x.is_db) || ' relation(s) of the product' END)
      INTO their_owner, their_objects
      FROM (
        SELECT d.datdba AS owner, true AS is_db FROM pg_database d WHERE d.datname = current_database()
        UNION ALL
        SELECT c.relowner, false
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = ANY (current_setting('ohmail.roles_schemas')::text[])
           AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
           AND NOT EXISTS (SELECT 1 FROM pg_depend e
                            WHERE e.classid = 'pg_class'::regclass AND e.objid = c.oid AND e.deptype = 'e')
      ) x
      JOIN pg_roles w ON w.oid = x.owner
     WHERE NOT w.rolsuper AND w.rolname <> migrator
       AND NOT (w.rolname = ANY (current_setting('ohmail.roles_no_bypass')::text[]))
     GROUP BY w.rolname
     ORDER BY bool_or(x.is_db) DESC, count(*) DESC, w.rolname
     LIMIT 1;
    IF their_owner IS NOT NULL THEN
      RAISE EXCEPTION 'ROLES_REFUSED login: the session is a superuser, and role %, which is no superuser, owns %: on this server that role is the migrator. Sign in as % and run this file again. Sent by a superuser it hands everything to ohmail_migrator, and whatever signs in as % loses every right on its own tables. If the migrations do not run as %, take its objects from it by hand first: REASSIGN OWNED BY % TO %',
        their_owner, their_objects, their_owner, their_owner, their_owner, their_owner, current_user;
    END IF;
    -- @end shape.owner
  ELSE
    -- @clause shape.login-third
    IF current_user <> 'ohmail_migrator' AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ohmail_migrator') THEN
      RAISE EXCEPTION 'ROLES_REFUSED login: this server has a role ohmail_migrator and the session is %. Run this as ohmail_migrator',
        current_user;
    END IF;
    -- @end shape.login-third
    shape := 'managed';
    migrator := current_user;
  END IF;
  PERFORM set_config('ohmail.roles_shape', shape, true);
  PERFORM set_config('ohmail.roles_migrator', migrator, true);

  -- The search extensions' operators must resolve for a login that reads mail. Where a host keeps
  -- extensions in a schema of its own, that schema is used and searched beside `public`.
  PERFORM set_config('ohmail.roles_extension_schemas', (
    SELECT coalesce(array_agg(DISTINCT n.nspname::text ORDER BY n.nspname::text), '{}')::text
      FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
     WHERE e.extname IN ('pg_trgm', 'btree_gin') AND n.nspname NOT IN ('public', 'pg_catalog')), true);
END $$;

-- @provision
-- ── 1. THE ROLES. LOGIN, no password here (set out of band), no memberships. ───────────────
--
-- NOINHERIT: a membership somebody grants later then confers nothing by itself. That is the
-- narrower default between two runs, and it hides nothing from the census, which reads
-- memberships themselves (section 1c) and never infers them from what a role can do.
DO $$
DECLARE
  migrator text := current_setting('ohmail.roles_migrator');
  role     text;
BEGIN
  IF current_setting('ohmail.roles_shape') = 'plain'
     AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = migrator) THEN
    EXECUTE format('CREATE ROLE %I LOGIN NOINHERIT CREATEROLE BYPASSRLS', migrator);
    RAISE NOTICE 'repair: made the migrator role %', migrator;
  END IF;
  FOREACH role IN ARRAY current_setting('ohmail.roles_runtime')::text[] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role) THEN
      EXECUTE format('CREATE ROLE %I LOGIN NOINHERIT', role);
      RAISE NOTICE 'repair: made the login %', role;
    END IF;
  END LOOP;
END $$;

-- ── 1b. ROLE ATTRIBUTES. Repair what this session can; ABORT on what it cannot. ───────────
--
-- A login that is SUPERUSER or BYPASSRLS reads every row whatever is granted below. CREATEROLE
-- lets it give itself memberships. The ALTER is issued only when the attribute is SET: a session
-- that is no superuser is refused `NOSUPERUSER` whether or not it would change anything.
-- @clause repair.attributes
DO $$
DECLARE
  migrator text := current_setting('ohmail.roles_migrator');
  held     record;
  fix      text;
BEGIN
  FOR held IN SELECT * FROM pg_roles WHERE rolname = ANY (current_setting('ohmail.roles_runtime')::text[]) LOOP
    FOR fix IN
      SELECT x.clause FROM (VALUES
        ('NOSUPERUSER',   held.rolsuper),
        ('NOBYPASSRLS',   held.rolbypassrls),
        ('NOREPLICATION', held.rolreplication),
        ('NOCREATEDB',    held.rolcreatedb),
        ('NOCREATEROLE',  held.rolcreaterole),
        ('NOINHERIT',     held.rolinherit),
        ('LOGIN',         NOT held.rolcanlogin)
      ) AS x(clause, wrong)
      WHERE x.wrong
    LOOP
      BEGIN
        EXECUTE format('ALTER ROLE %I %s', held.rolname, fix);
        RAISE NOTICE 'repair: ALTER ROLE % %', held.rolname, fix;
      EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'ROLES_REFUSED attribute: role % holds an attribute this session cannot change (%). As a superuser: ALTER ROLE % %',
          held.rolname, SQLERRM, held.rolname, fix;
      END;
    END LOOP;
  END LOOP;

  -- The migrator this file made (plain shape). On a managed host the migrator is the session's
  -- own role: it is asserted in the census and never altered.
  IF current_setting('ohmail.roles_shape') = 'plain' THEN
    SELECT * INTO held FROM pg_roles WHERE rolname = migrator;
    FOR fix IN
      SELECT x.clause FROM (VALUES
        ('NOSUPERUSER', held.rolsuper),
        ('BYPASSRLS',   NOT held.rolbypassrls),
        ('CREATEROLE',  NOT held.rolcreaterole),
        ('NOINHERIT',   held.rolinherit),
        ('LOGIN',       NOT held.rolcanlogin)
      ) AS x(clause, wrong)
      WHERE x.wrong
    LOOP
      EXECUTE format('ALTER ROLE %I %s', migrator, fix);
      RAISE NOTICE 'repair: ALTER ROLE % %', migrator, fix;
    END LOOP;
  END IF;
END $$;
-- @end repair.attributes

-- ── 1c. MEMBERSHIPS, both ways. ───────────────────────────────────────────────────────────
--
-- FORWARD: a login that is a member of another role reaches what that role holds
-- (`pg_read_all_data` is one line and every message body). No `REVOKE … ON <table>` touches it.
-- REVERSE: a role that is a member of a login can become it. One row is expected there and kept:
-- the migrator's own, ADMIN only, which Postgres writes for the role that made the login and
-- which is what lets the migrator alter it. Anything more on that row (INHERIT, SET) is removed.
--
-- A membership is revoked only by its grantor or a superuser. One this session cannot revoke is
-- refused by name.
DO $$
DECLARE
  migrator text := current_setting('ohmail.roles_migrator');
  shape    text := current_setting('ohmail.roles_shape');
  runtime  text[] := current_setting('ohmail.roles_runtime')::text[];
  mig_oid  oid := (SELECT oid FROM pg_roles WHERE rolname = migrator);
  m        record;
BEGIN
  -- @clause repair.membership-forward
  FOR m IN
    SELECT g.rolname AS granted, r.rolname AS member, b.rolname AS grantor
      FROM pg_auth_members am
      JOIN pg_roles r ON r.oid = am.member
      JOIN pg_roles g ON g.oid = am.roleid
      JOIN pg_roles b ON b.oid = am.grantor
     WHERE r.rolname = ANY (runtime)
        -- The migrator this file made is a member of nothing but the logins it administers (below).
        OR (shape = 'plain' AND r.oid = mig_oid AND NOT (g.rolname = ANY (runtime) OR g.rolname = 'ohmail_admin'))
  LOOP
    BEGIN
      EXECUTE format('REVOKE %I FROM %I GRANTED BY %I CASCADE', m.granted, m.member, m.grantor);
      RAISE NOTICE 'repair: revoked the membership of % in % (granted by %)', m.member, m.granted, m.grantor;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'ROLES_REFUSED membership: role % is a member of % (granted by %) and this session cannot revoke it: %. A membership confers what the other role holds. As a superuser: REVOKE % FROM %',
        m.member, m.granted, m.grantor, SQLERRM, m.granted, m.member;
    END;
  END LOOP;
  -- @end repair.membership-forward

  -- @clause repair.membership-reverse
  FOR m IN
    SELECT g.rolname AS granted, r.rolname AS member, b.rolname AS grantor
      FROM pg_auth_members am
      JOIN pg_roles r ON r.oid = am.member
      JOIN pg_roles g ON g.oid = am.roleid
      JOIN pg_roles b ON b.oid = am.grantor
     WHERE g.rolname = ANY (runtime) AND am.member IS DISTINCT FROM mig_oid
  LOOP
    BEGIN
      EXECUTE format('REVOKE %I FROM %I GRANTED BY %I CASCADE', m.granted, m.member, m.grantor);
      RAISE NOTICE 'repair: revoked the membership of % in % (granted by %)', m.member, m.granted, m.grantor;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'ROLES_REFUSED membership: role % is a member of the login % (granted by %) and this session cannot revoke it: %. A member can become the login. As a superuser: REVOKE % FROM %',
        m.member, m.granted, m.grantor, SQLERRM, m.granted, m.member;
    END;
  END LOOP;
  -- @end repair.membership-reverse

  -- @clause repair.membership-options
  FOR m IN
    SELECT g.rolname AS granted, b.rolname AS grantor, am.inherit_option, am.set_option
      FROM pg_auth_members am
      JOIN pg_roles g ON g.oid = am.roleid
      JOIN pg_roles b ON b.oid = am.grantor
     WHERE g.rolname = ANY (runtime) AND am.member = mig_oid AND (am.inherit_option OR am.set_option)
  LOOP
    BEGIN
      IF m.inherit_option THEN
        EXECUTE format('REVOKE INHERIT OPTION FOR %I FROM %I GRANTED BY %I', m.granted, migrator, m.grantor);
      END IF;
      IF m.set_option THEN
        EXECUTE format('REVOKE SET OPTION FOR %I FROM %I GRANTED BY %I', m.granted, migrator, m.grantor);
      END IF;
      RAISE NOTICE 'repair: the migrator''s membership in % (granted by %) is ADMIN only again', m.granted, m.grantor;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'ROLES_REFUSED membership: the migrator''s membership in % (granted by %) carries more than ADMIN and this session cannot narrow it: %. As a superuser: GRANT % TO % WITH ADMIN TRUE, INHERIT FALSE, SET FALSE',
        m.granted, m.grantor, SQLERRM, m.granted, migrator;
    END;
  END LOOP;
  -- @end repair.membership-options

  -- A superuser's run leaves the migrator able to run this file itself next time: ADMIN on the
  -- logins it will alter, and nothing else of theirs. On a managed host that row exists from the
  -- moment the migrator made the login.
  -- @clause repair.admin-option
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    FOR m IN
      SELECT r.rolname AS granted FROM pg_roles r
       WHERE (r.rolname = ANY (runtime) OR r.rolname = 'ohmail_admin')
         AND NOT EXISTS (SELECT 1 FROM pg_auth_members am
                          WHERE am.roleid = r.oid AND am.member = mig_oid AND am.admin_option)
    LOOP
      EXECUTE format('GRANT %I TO %I WITH ADMIN TRUE, INHERIT FALSE, SET FALSE', m.granted, migrator);
      RAISE NOTICE 'repair: the migrator % holds ADMIN on % (and no more of it)', migrator, m.granted;
    END LOOP;
  END IF;
  -- @end repair.admin-option
END $$;

-- ── 1d. OWNERSHIP. An owner holds every right on its object and can grant them on. ────────
--
-- Two rules, one loop. A runtime login owns NOTHING, in any schema. And everything of the
-- product's schemas is the migrator's. What an extension brought with it is left alone (a host
-- may install an extension as its own superuser).
--
-- PLAIN: this is the hand-over, made by the superuser's session.
-- MANAGED: the journals ran as the migrator and the loop finds nothing. Whatever it does find is
-- refused by name and NO owner is changed, also where the server would allow it (the owning role
-- is a member of the host's roles). The migrator bypasses row security: a view or a SECURITY
-- DEFINER routine handed to it would answer its callers with every account's rows from then on,
-- and taking a table waits for an ACCESS EXCLUSIVE lock behind whoever reads it.
-- In the schema of the row lock's views no owner is changed on EITHER shape: whoever owns a view
-- there may have given it another text, and handed to the migrator it would read every account for
-- the logins this file grants it to. Anything there that is not the migrator's is refused instead
-- (census.ownership, census.views-schema).
-- @clause repair.ownership
DO $$
DECLARE
  migrator text := current_setting('ohmail.roles_migrator');
  shape    text := current_setting('ohmail.roles_shape');
  runtime  text[] := current_setting('ohmail.roles_runtime')::text[];
  ours     text[] := current_setting('ohmail.roles_schemas')::text[];
  view_ns  text[] := ARRAY(SELECT s FROM unnest(current_setting('ohmail.roles_usage_schemas')::text[]) AS s WHERE s <> 'public');
  mig_oid  oid := (SELECT oid FROM pg_roles WHERE rolname = migrator);
  o        record;
BEGIN
  FOR o IN
    -- The database first (a plain host only): its owner is who `public` belongs to.
    SELECT 0 AS ord, 'database' AS kind, format('DATABASE %I', d.datname) AS target, w.rolname AS owner
      FROM pg_database d JOIN pg_roles w ON w.oid = d.datdba
     WHERE d.datname = current_database()
       AND d.datdba IS DISTINCT FROM mig_oid
       AND (shape = 'plain' OR w.rolname = ANY (runtime))
    UNION ALL
    SELECT 1, 'schema', format('SCHEMA %I', n.nspname), w.rolname
      FROM pg_namespace n JOIN pg_roles w ON w.oid = n.nspowner
     WHERE n.nspowner IS DISTINCT FROM mig_oid
       AND (w.rolname = ANY (runtime) OR (n.nspname = ANY (ours) AND n.nspname <> 'public'))
       AND NOT n.nspname = ANY (view_ns)
    UNION ALL
    SELECT CASE WHEN c.relkind = 'S' THEN 3 ELSE 2 END,
           CASE c.relkind WHEN 'S' THEN 'sequence' WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view'
                          WHEN 'f' THEN 'foreign table' ELSE 'table' END,
           format(CASE c.relkind WHEN 'S' THEN 'SEQUENCE %I.%I' WHEN 'v' THEN 'VIEW %I.%I'
                                 WHEN 'm' THEN 'MATERIALIZED VIEW %I.%I' WHEN 'f' THEN 'FOREIGN TABLE %I.%I'
                                 ELSE 'TABLE %I.%I' END, n.nspname, c.relname),
           w.rolname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_roles w ON w.oid = c.relowner
     WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
       AND c.relowner IS DISTINCT FROM mig_oid
       AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
       AND NOT n.nspname = ANY (view_ns)
       AND (w.rolname = ANY (runtime)
            OR (n.nspname = ANY (ours)
                AND NOT EXISTS (SELECT 1 FROM pg_depend e
                                 WHERE e.classid = 'pg_class'::regclass AND e.objid = c.oid AND e.deptype = 'e')))
       -- A sequence that belongs to a column follows its table; Postgres refuses to move it alone.
       AND NOT (c.relkind = 'S' AND EXISTS (SELECT 1 FROM pg_depend s
                                             WHERE s.classid = 'pg_class'::regclass AND s.objid = c.oid
                                               AND s.refclassid = 'pg_class'::regclass AND s.deptype IN ('a', 'i')))
    UNION ALL
    SELECT 4, 'routine', format('ROUTINE %s', p.oid::regprocedure), w.rolname
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_roles w ON w.oid = p.proowner
     WHERE p.proowner IS DISTINCT FROM mig_oid
       AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
       AND NOT n.nspname = ANY (view_ns)
       AND (w.rolname = ANY (runtime)
            OR (n.nspname = ANY (ours)
                AND NOT EXISTS (SELECT 1 FROM pg_depend e
                                 WHERE e.classid = 'pg_proc'::regclass AND e.objid = p.oid AND e.deptype = 'e')))
     ORDER BY 1, 3
  LOOP
    -- @clause guard.managed-owner
    IF shape <> 'plain' THEN
      RAISE EXCEPTION 'ROLES_REFUSED ownership: the % % is owned by %, not by the migrator %. A session that is no superuser changes no owner: what the migrator owns answers with its rights, past row security. Read what it is, then by hand, as a role that may: ALTER % OWNER TO %, or drop it',
        o.kind, substr(o.target, strpos(o.target, ' ') + 1), o.owner, migrator, o.target, migrator;
    END IF;
    -- @end guard.managed-owner
    BEGIN
      EXECUTE format('ALTER %s OWNER TO %I', o.target, migrator);
      RAISE NOTICE 'repair: % is the migrator''s now (was owned by %)', lower(o.target), o.owner;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'ROLES_REFUSED ownership: the % % is owned by % and this session cannot hand it to the migrator %: %. An owner holds every right on its object. As a superuser: ALTER % OWNER TO %',
        o.kind, substr(o.target, strpos(o.target, ' ') + 1), o.owner, migrator, SQLERRM, o.target, migrator;
    END;
  END LOOP;
END $$;
-- @end repair.ownership

-- ── 2. EVERY DIRECT GRANT THE RULE DOES NOT WRITE, REMOVED; THEN THE RULE. ────────────────
--
-- Driven by the catalog, in EVERY schema outside the system's: each ACL entry that names a
-- runtime login is held against the rule, and only a difference is acted on (revoke everything
-- on that object, then grant what the rule writes). A database that already matches is not
-- written to at all, so a run after every migration costs a read.
--
-- An entry on an object this session does not own cannot be revoked by it. It is skipped with a
-- warning here and refused by name in the census: the verdict is the end state, never the
-- statement count.
DO $$
DECLARE
  the_rule jsonb := current_setting('ohmail.roles_rule')::jsonb;
  the_views jsonb := current_setting('ohmail.roles_views')::jsonb;
  runtime  text[] := current_setting('ohmail.roles_runtime')::text[];
  usable   text[] := current_setting('ohmail.roles_usage_schemas')::text[]
                     || current_setting('ohmail.roles_extension_schemas')::text[];
  view_ns  text[] := ARRAY(SELECT s FROM unnest(current_setting('ohmail.roles_usage_schemas')::text[]) AS s WHERE s <> 'public');
  ours     text[] := current_setting('ohmail.roles_schemas')::text[];
  mig_oid  oid := (SELECT oid FROM pg_roles WHERE rolname = current_setting('ohmail.roles_migrator'));
  g        record;
BEGIN
  -- @clause repair.grants-relations
  FOR g IN
    WITH logins AS (SELECT oid, rolname FROM pg_roles WHERE rolname = ANY (runtime))
    SELECT c.relkind, c.relowner, l.rolname AS role, format('%I.%I', n.nspname, c.relname) AS ident,
           held.verbs AS have, held.grantable, cols.n AS column_entries,
           CASE WHEN n.nspname = 'public' AND c.relkind IN ('r', 'p') THEN
             ARRAY(SELECT jsonb_array_elements_text(
               CASE WHEN the_rule->'narrowed'->l.rolname::text ? c.relname::text
                      THEN the_rule->'narrowed'->l.rolname::text->c.relname::text
                    -- A staff table nobody named gets nothing: the census refuses it until it is named.
                    WHEN c.relname LIKE 'staff\_%' THEN '[]'::jsonb
                    ELSE the_rule->'default' END) ORDER BY 1)
                -- A view of the row lock the rule names for this login, standing as the lock makes it: a plain
                -- view, the migrator's, in its schema of the migrator's. Anything else there gets nothing.
                WHEN c.relkind = 'v' AND c.relowner = mig_oid AND n.nspowner = mig_oid AND n.nspname = ANY (view_ns)
                     AND the_views->l.rolname::text ? format('%I.%I', n.nspname, c.relname) THEN
                  ARRAY(SELECT jsonb_array_elements_text(the_views->l.rolname::text->format('%I.%I', n.nspname, c.relname)) ORDER BY 1)
           ELSE '{}'::text[] END AS want
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN logins l
      CROSS JOIN LATERAL (
        SELECT coalesce(array_agg(DISTINCT x.privilege_type ORDER BY x.privilege_type), '{}') AS verbs,
               coalesce(bool_or(x.is_grantable), false) AS grantable
          FROM aclexplode(c.relacl) x WHERE x.grantee = l.oid) held
      CROSS JOIN LATERAL (
        SELECT count(*) AS n FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x
         WHERE a.attrelid = c.oid AND a.attnum > 0 AND x.grantee = l.oid) cols
     WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
       AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
     ORDER BY 4, 3
  LOOP
    CONTINUE WHEN g.have = g.want AND NOT g.grantable AND g.column_entries = 0;
    IF NOT pg_has_role(current_user, g.relowner, 'USAGE') THEN
      RAISE WARNING 'skipped: role % holds [%] on %, which is owned by % and not by this session', g.role,
        array_to_string(g.have, ' ') || CASE WHEN g.column_entries > 0 THEN ' + column grants' ELSE '' END,
        g.ident, g.relowner::regrole;
      CONTINUE;
    END IF;
    IF cardinality(g.have) > 0 OR g.column_entries > 0 THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON %s %s FROM %I CASCADE',
                     CASE WHEN g.relkind = 'S' THEN 'SEQUENCE' ELSE 'TABLE' END, g.ident, g.role);
    END IF;
    IF cardinality(g.want) > 0 THEN
      EXECUTE format('GRANT %s ON TABLE %s TO %I', array_to_string(g.want, ', '), g.ident, g.role);
    END IF;
    IF cardinality(g.have) = 0 AND g.column_entries = 0 THEN
      RAISE NOTICE 'write: role % on %: [%]', g.role, g.ident, array_to_string(g.want, ' ');
    ELSE
      RAISE NOTICE 'repair: role % on %: held [%], the rule writes [%]', g.role, g.ident,
        array_to_string(g.have, ' ') || CASE WHEN g.grantable THEN ' WITH GRANT OPTION' ELSE '' END
          || CASE WHEN g.column_entries > 0 THEN ' + column grants' ELSE '' END,
        array_to_string(g.want, ' ');
    END IF;
  END LOOP;
  -- @end repair.grants-relations

  -- @clause repair.grants-schemas
  FOR g IN
    WITH logins AS (SELECT oid, rolname FROM pg_roles WHERE rolname = ANY (runtime))
    SELECT n.nspname, n.nspowner, l.rolname AS role, l.oid AS role_oid, held.verbs AS have, held.grantable,
           -- The schema of the row lock's views only while one of this login's views stands in it.
           CASE WHEN n.nspname = ANY (usable)
                     AND (NOT n.nspname = ANY (view_ns)
                          OR (n.nspowner = mig_oid AND EXISTS (
                                SELECT 1 FROM pg_class v
                                 WHERE v.relnamespace = n.oid AND v.relkind = 'v' AND v.relowner = mig_oid
                                   AND the_views->l.rolname::text ? format('%I.%I', n.nspname, v.relname))))
                THEN ARRAY['USAGE'] ELSE '{}'::text[] END AS want
      FROM pg_namespace n
      CROSS JOIN logins l
      CROSS JOIN LATERAL (
        SELECT coalesce(array_agg(DISTINCT x.privilege_type ORDER BY x.privilege_type), '{}') AS verbs,
               coalesce(bool_or(x.is_grantable), false) AS grantable
          FROM aclexplode(n.nspacl) x WHERE x.grantee = l.oid) held
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
       AND n.nspname !~ '^pg_(toast_)?temp_'
     ORDER BY 1, 3
  LOOP
    CONTINUE WHEN g.have = g.want AND NOT g.grantable;
    IF NOT (pg_has_role(current_user, g.nspowner, 'USAGE')
            OR has_schema_privilege(current_user, g.nspname, 'USAGE WITH GRANT OPTION')) THEN
      -- A host's own schema that already lets everybody in needs no entry of ours.
      CONTINUE WHEN cardinality(g.have) = 0 AND has_schema_privilege(g.role_oid, g.nspname, 'USAGE');
      RAISE WARNING 'skipped: role % on schema %: holds [%], the rule writes [%], and the schema is owned by %, not by this session',
        g.role, g.nspname, array_to_string(g.have, ' '), array_to_string(g.want, ' '), g.nspowner::regrole;
      CONTINUE;
    END IF;
    BEGIN
      IF cardinality(g.have) > 0 THEN
        EXECUTE format('REVOKE ALL PRIVILEGES ON SCHEMA %I FROM %I CASCADE', g.nspname, g.role);
      END IF;
      IF cardinality(g.want) > 0 THEN
        EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', g.nspname, g.role);
      END IF;
      IF cardinality(g.have) = 0 THEN
        RAISE NOTICE 'write: role % on schema %: [USAGE]', g.role, g.nspname;
      ELSE
        RAISE NOTICE 'repair: role % on schema %: held [%], the rule writes [%]', g.role, g.nspname,
          array_to_string(g.have, ' ') || CASE WHEN g.grantable THEN ' WITH GRANT OPTION' ELSE '' END,
          array_to_string(g.want, ' ');
      END IF;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE WARNING 'skipped: role % on schema % (owned by %): %', g.role, g.nspname, g.nspowner::regrole, SQLERRM;
    END;
  END LOOP;
  -- @end repair.grants-schemas

  -- @clause repair.grants-routines
  FOR g IN
    SELECT p.oid::regprocedure::text AS ident, p.proowner, l.rolname AS role
      FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(p.proacl) x
      JOIN pg_roles l ON l.oid = x.grantee
     WHERE l.rolname = ANY (runtime)
     GROUP BY 1, 2, 3 ORDER BY 1, 3
  LOOP
    IF NOT pg_has_role(current_user, g.proowner, 'USAGE') THEN
      RAISE WARNING 'skipped: role % holds EXECUTE on routine %, which is owned by % and not by this session',
        g.role, g.ident, g.proowner::regrole;
      CONTINUE;
    END IF;
    EXECUTE format('REVOKE ALL PRIVILEGES ON ROUTINE %s FROM %I CASCADE', g.ident, g.role);
    RAISE NOTICE 'repair: role % on routine %: held a direct EXECUTE, the rule writes none', g.role, g.ident;
  END LOOP;
  -- @end repair.grants-routines

  -- Default privileges: what a table made LATER is born with. One that names a login, or that
  -- gives PUBLIC a relation right in the product's schemas or in the schema of the row lock's views
  -- (a view the lock's setup step makes again would be born readable by every role), would open
  -- every later one before this file runs again. In the schema of the row lock's views the
  -- migrator's own for any other role goes too: a view made again there would be born granted to
  -- that role, and the census would then refuse the run with the view closed to the logins. Nothing
  -- but the migrator makes anything there, so this takes nothing from anyone.
  -- @clause repair.default-acl
  FOR g IN
    SELECT w.rolname AS of_role, n.nspname,
           CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(l.rolname) END AS grantee,
           CASE d.defaclobjtype WHEN 'r' THEN 'TABLES' WHEN 'S' THEN 'SEQUENCES' WHEN 'f' THEN 'ROUTINES'
                                WHEN 'T' THEN 'TYPES' WHEN 'n' THEN 'SCHEMAS' END AS kind
      FROM pg_default_acl d
      JOIN pg_roles w ON w.oid = d.defaclrole
      LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
      CROSS JOIN LATERAL aclexplode(d.defaclacl) x
      LEFT JOIN pg_roles l ON l.oid = x.grantee
     WHERE l.rolname = ANY (runtime)
        OR (x.grantee = 0 AND d.defaclobjtype IN ('r', 'S')
            AND (n.nspname = ANY (ours || view_ns) OR (d.defaclnamespace = 0 AND d.defaclrole = mig_oid)))
        OR (x.grantee <> 0 AND x.grantee <> d.defaclrole AND d.defaclrole = mig_oid AND d.defaclobjtype IN ('r', 'S')
            AND n.nspname = ANY (view_ns))
     GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4
  LOOP
    BEGIN
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I %s REVOKE ALL PRIVILEGES ON %s FROM %s', g.of_role,
                     CASE WHEN g.nspname IS NULL THEN '' ELSE format('IN SCHEMA %I', g.nspname) END, g.kind, g.grantee);
      RAISE NOTICE 'repair: the default privileges of % no longer grant on % to %',
        g.of_role || CASE WHEN g.nspname IS NULL THEN '' ELSE ' in schema ' || g.nspname END, lower(g.kind), g.grantee;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE WARNING 'skipped: the default privileges of % grant on % to %: %',
        g.of_role || CASE WHEN g.nspname IS NULL THEN '' ELSE ' in schema ' || g.nspname END, lower(g.kind), g.grantee, SQLERRM;
    END;
  END LOOP;
  -- @end repair.default-acl

  -- @clause repair.database
  FOR g IN
    SELECT l.rolname AS role, d.datdba, array_to_string(array_agg(DISTINCT x.privilege_type ORDER BY x.privilege_type), ' ') AS have
      FROM pg_database d
      CROSS JOIN LATERAL aclexplode(d.datacl) x
      JOIN pg_roles l ON l.oid = x.grantee
     WHERE d.datname = current_database() AND l.rolname = ANY (runtime)
     GROUP BY 1, 2 ORDER BY 1
  LOOP
    IF NOT pg_has_role(current_user, g.datdba, 'USAGE') THEN
      RAISE WARNING 'skipped: role % holds [%] on the database, which is owned by % and not by this session', g.role, g.have, g.datdba::regrole;
      CONTINUE;
    END IF;
    EXECUTE format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM %I CASCADE', current_database(), g.role);
    RAISE NOTICE 'repair: role % on the database: held [%], the rule writes none (CONNECT comes through PUBLIC)', g.role, g.have;
  END LOOP;
  -- @end repair.database
END $$;

-- ── 3. PUBLIC. What everybody holds, every login holds. ───────────────────────────────────
--
-- `GRANT SELECT ON message_bodies TO PUBLIC` hands both logins every body and leaves no entry of
-- theirs to revoke. This file owns the product's schemas, so it revokes: every relation, column
-- and sequence privilege PUBLIC holds in them, and CREATE on them. It stops there. EXECUTE on
-- routines and USAGE on `public` are Postgres's own defaults, CONNECT and TEMPORARY on the
-- database are the host's, and `plane` is the billing plane's.
-- @clause repair.public
DO $$
DECLARE
  ours text[] := current_setting('ohmail.roles_schemas')::text[];
  g    record;
BEGIN
  FOR g IN
    SELECT CASE WHEN c.relkind = 'S' THEN 'SEQUENCE' ELSE 'TABLE' END AS kind, c.relowner,
           format('%I.%I', n.nspname, c.relname) AS ident,
           (SELECT string_agg(DISTINCT x.privilege_type, ' ' ORDER BY x.privilege_type)
              FROM aclexplode(c.relacl) x WHERE x.grantee = 0) AS on_table,
           (SELECT count(*) FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x
             WHERE a.attrelid = c.oid AND a.attnum > 0 AND x.grantee = 0) AS on_columns
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ANY (ours) AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
     ORDER BY 3
  LOOP
    CONTINUE WHEN g.on_table IS NULL AND g.on_columns = 0;
    IF NOT pg_has_role(current_user, g.relowner, 'USAGE') THEN
      RAISE WARNING 'skipped: PUBLIC holds [%] on %, which is owned by % and not by this session',
        coalesce(g.on_table, 'column grants'), g.ident, g.relowner::regrole;
      CONTINUE;
    END IF;
    EXECUTE format('REVOKE ALL PRIVILEGES ON %s %s FROM PUBLIC CASCADE', g.kind, g.ident);
    RAISE NOTICE 'repair: PUBLIC on %: held [%], revoked', g.ident,
      concat_ws(' + ', g.on_table, CASE WHEN g.on_columns > 0 THEN 'column grants' END);
  END LOOP;

  FOR g IN
    SELECT n.nspname, n.nspowner FROM pg_namespace n
     WHERE n.nspname = ANY (ours)
       AND EXISTS (SELECT 1 FROM aclexplode(n.nspacl) x WHERE x.grantee = 0 AND x.privilege_type = 'CREATE')
     ORDER BY 1
  LOOP
    IF NOT pg_has_role(current_user, g.nspowner, 'USAGE') THEN
      RAISE WARNING 'skipped: PUBLIC holds CREATE on schema %, which is owned by % and not by this session', g.nspname, g.nspowner::regrole;
      CONTINUE;
    END IF;
    EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM PUBLIC', g.nspname);
    RAISE NOTICE 'repair: PUBLIC on schema %: held [CREATE], revoked', g.nspname;
  END LOOP;
END $$;
-- @end repair.public

-- The schema of the row lock's views is the logins' alone. A view there reads its tables with the
-- migrator's rights, and PUBLIC is every role: the staff role, the billing plane, a host's own. So
-- whatever PUBLIC holds there is revoked: USAGE or CREATE on the schema, any right on a relation or
-- a column in it. EXECUTE on its routines stays PUBLIC's: every view and policy calls the readers.
-- @clause repair.views-public
DO $$
DECLARE
  view_ns text[] := ARRAY(SELECT s FROM unnest(current_setting('ohmail.roles_usage_schemas')::text[]) AS s WHERE s <> 'public');
  g       record;
BEGIN
  FOR g IN
    SELECT CASE WHEN c.relkind = 'S' THEN 'SEQUENCE' ELSE 'TABLE' END AS kind, c.relowner,
           format('%I.%I', n.nspname, c.relname) AS ident,
           (SELECT string_agg(DISTINCT x.privilege_type, ' ' ORDER BY x.privilege_type)
              FROM aclexplode(c.relacl) x WHERE x.grantee = 0) AS on_table,
           (SELECT count(*) FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x
             WHERE a.attrelid = c.oid AND a.attnum > 0 AND x.grantee = 0) AS on_columns
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ANY (view_ns) AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
     ORDER BY 3
  LOOP
    CONTINUE WHEN g.on_table IS NULL AND g.on_columns = 0;
    IF NOT pg_has_role(current_user, g.relowner, 'USAGE') THEN
      RAISE WARNING 'skipped: PUBLIC holds [%] on %, which is owned by % and not by this session',
        coalesce(g.on_table, 'column grants'), g.ident, g.relowner::regrole;
      CONTINUE;
    END IF;
    EXECUTE format('REVOKE ALL PRIVILEGES ON %s %s FROM PUBLIC CASCADE', g.kind, g.ident);
    RAISE NOTICE 'repair: PUBLIC on %: held [%], revoked', g.ident,
      concat_ws(' + ', g.on_table, CASE WHEN g.on_columns > 0 THEN 'column grants' END);
  END LOOP;

  FOR g IN
    SELECT n.nspname, n.nspowner,
           (SELECT string_agg(DISTINCT x.privilege_type, ' ' ORDER BY x.privilege_type)
              FROM aclexplode(n.nspacl) x WHERE x.grantee = 0) AS held
      FROM pg_namespace n
     WHERE n.nspname = ANY (view_ns)
       AND EXISTS (SELECT 1 FROM aclexplode(n.nspacl) x WHERE x.grantee = 0)
     ORDER BY 1
  LOOP
    IF NOT pg_has_role(current_user, g.nspowner, 'USAGE') THEN
      RAISE WARNING 'skipped: PUBLIC holds [%] on schema %, which is owned by % and not by this session',
        g.held, g.nspname, g.nspowner::regrole;
      CONTINUE;
    END IF;
    EXECUTE format('REVOKE ALL PRIVILEGES ON SCHEMA %I FROM PUBLIC CASCADE', g.nspname);
    RAISE NOTICE 'repair: PUBLIC on schema %: held [%], revoked', g.nspname, g.held;
  END LOOP;
END $$;
-- @end repair.views-public

-- ── 4. THE DEADLINES, AND ONE SEARCH PATH. Role settings, by role NAME. ───────────────────
--
-- Lock wait 30 s, statement 55 s, idle in a transaction 60 s, on the two logins and on the staff
-- role. Without them a login has NO ceiling at all: Postgres has none of its own, and what a
-- client asks for at connect was measured inert through the transaction pooler. A role setting is
-- read by Postgres itself when a backend starts. Role-only (never IN DATABASE: that form was
-- measured inert through the pooler too), written as milliseconds the way the product's own setup
-- writes them, and compared as a duration, so two writers of one number never flip the stored text.
--
-- A login carries exactly these and its search path, and nothing else: `ALTER ROLE … SET role`,
-- `row_security` or a search path that leads with another schema are settings a hand can leave
-- behind, and each changes what every later session of the login is. They are reset. The staff
-- role keeps the search path its own script gives it; only its three deadlines are written here.
--
-- The migrator's own settings are never written and never judged in this file. On a managed host
-- the product still signs in as that role until the row lock is switched on, and its deadlines
-- are the only ceiling those sessions have.
--
-- Altering another role's settings needs the ADMIN option on it (Postgres 16 on, for a session
-- that is no superuser). The migrator holds it on every login it made; where it does not, the
-- run is refused by name before the server refuses it without one.
DO $$
DECLARE
  migrator  text := current_setting('ohmail.roles_migrator');
  runtime   text[] := current_setting('ohmail.roles_runtime')::text[];
  deadlines jsonb := current_setting('ohmail.roles_deadlines')::jsonb;
  mig_oid   oid := (SELECT oid FROM pg_roles WHERE rolname = migrator);
  is_super  boolean := (SELECT rolsuper FROM pg_roles WHERE rolname = current_user);
  ext_ns    text[] := current_setting('ohmail.roles_extension_schemas')::text[];
  path_want text;
  r         record;
  s         record;
  wrong     text[];
  fresh     boolean;
BEGIN
  path_want := (SELECT string_agg(quote_ident(x), ', ') FROM unnest(ARRAY['public'] || ext_ns) AS x);

  -- @clause repair.settings
  FOR r IN
    SELECT l.oid, l.rolname, l.rolname = ANY (runtime) AS is_login
      FROM pg_roles l WHERE l.rolname = ANY (current_setting('ohmail.roles_deadline_roles')::text[])
     ORDER BY 2
  LOOP
    WITH held AS (
      SELECT st.setdatabase, d.datname, split_part(kv, '=', 1) AS key, substr(kv, strpos(kv, '=') + 1) AS val
        FROM pg_db_role_setting st
        LEFT JOIN pg_database d ON d.oid = st.setdatabase
        CROSS JOIN LATERAL unnest(st.setconfig) AS kv
       WHERE st.setrole = r.oid
    )
    SELECT coalesce(array_agg(x.what ORDER BY x.what), '{}'),
           NOT EXISTS (SELECT 1 FROM held h WHERE r.is_login OR deadlines ? h.key)
      INTO wrong, fresh
      FROM (
        SELECT format('%s is set in database %s', h.key, h.datname) AS what
          FROM held h WHERE h.setdatabase <> 0 AND (r.is_login OR deadlines ? h.key)
        UNION ALL
        SELECT format('%s is set and the rule writes no such setting', h.key)
          FROM held h WHERE h.setdatabase = 0 AND r.is_login AND h.key <> 'search_path' AND NOT deadlines ? h.key
        UNION ALL
        SELECT format('search_path is not %s', path_want)
         WHERE r.is_login
           AND coalesce((SELECT replace(replace(h.val, ' ', ''), '"', '') FROM held h
                          WHERE h.setdatabase = 0 AND h.key = 'search_path'), '') <> replace(replace(path_want, ' ', ''), '"', '')
        UNION ALL
        SELECT format('%s is %s, not %sms', w.key, coalesce(h.val, 'unset'), w.value)
          FROM jsonb_each_text(deadlines) w
          LEFT JOIN held h ON h.setdatabase = 0 AND h.key = w.key
         WHERE (CASE WHEN h.val ~ '^[0-9]+(ms)?$' THEN regexp_replace(h.val, 'ms$', '')::bigint
                     WHEN h.val ~ '^[0-9]+s$'    THEN left(h.val, -1)::bigint * 1000
                     WHEN h.val ~ '^[0-9]+min$'  THEN left(h.val, -3)::bigint * 60000
                     WHEN h.val ~ '^[0-9]+h$'    THEN left(h.val, -1)::bigint * 3600000 END) IS DISTINCT FROM w.value::bigint
      ) x;
    CONTINUE WHEN cardinality(wrong) = 0;

    -- @clause guard.admin-option
    IF NOT is_super AND NOT EXISTS (SELECT 1 FROM pg_auth_members am
                                     WHERE am.roleid = r.oid AND am.member = mig_oid AND am.admin_option) THEN
      RAISE EXCEPTION 'ROLES_REFUSED settings: this session holds no ADMIN option on role %, so it cannot set its deadlines (%). As a superuser: GRANT % TO % WITH ADMIN TRUE, INHERIT FALSE, SET FALSE',
        r.rolname, array_to_string(wrong, '; '), r.rolname, migrator;
    END IF;
    -- @end guard.admin-option

    IF r.is_login THEN
      FOR s IN
        SELECT DISTINCT d.datname FROM pg_db_role_setting st JOIN pg_database d ON d.oid = st.setdatabase
         WHERE st.setrole = r.oid
      LOOP
        EXECUTE format('ALTER ROLE %I IN DATABASE %I RESET ALL', r.rolname, s.datname);
      END LOOP;
      EXECUTE format('ALTER ROLE %I RESET ALL', r.rolname);
      EXECUTE format('ALTER ROLE %I SET search_path = %s', r.rolname, path_want);
    ELSE
      FOR s IN
        SELECT d.datname, split_part(kv, '=', 1) AS key
          FROM pg_db_role_setting st JOIN pg_database d ON d.oid = st.setdatabase
          CROSS JOIN LATERAL unnest(st.setconfig) AS kv
         WHERE st.setrole = r.oid AND deadlines ? split_part(kv, '=', 1)
      LOOP
        EXECUTE format('ALTER ROLE %I IN DATABASE %I RESET %I', r.rolname, s.datname, s.key);
      END LOOP;
    END IF;
    FOR s IN SELECT w.key, w.value FROM jsonb_each_text(deadlines) w ORDER BY 1 LOOP
      EXECUTE format('ALTER ROLE %I SET %I = %L', r.rolname, s.key, s.value || 'ms');
    END LOOP;
    IF fresh THEN
      RAISE NOTICE 'write: role % settings: [%]', r.rolname,
        concat_ws(', ', CASE WHEN r.is_login THEN 'search_path=' || path_want END,
                  (SELECT string_agg(w.key || '=' || w.value || 'ms', ', ' ORDER BY w.key) FROM jsonb_each_text(deadlines) w));
    ELSE
      RAISE NOTICE 'repair: role % settings: %', r.rolname, array_to_string(wrong, '; ');
    END IF;
  END LOOP;
  -- @end repair.settings
END $$;

-- @census
-- ── 13. THE CENSUS. What each login can EFFECTIVELY do is what the rule writes, no more, no
--        less. Reads only: check mode is this section alone. ──────────────────────────────
--
-- Everything above is an intention. This is the part that is a fact, and it ends the transaction
-- when it is not: every line of drift is printed, then one exception rolls all of it back.
--
-- Effective, not direct: `has_*_privilege` answers for what a login reaches by any road (a
-- direct grant, PUBLIC, ownership, an inherited membership), so a road section 2 cannot revoke
-- still shows. Both directions: a right the rule writes and the login lacks is drift too, so a
-- table a migration made and nobody granted is found here and not by a failing request.
DO $$
DECLARE
  migrator text := current_setting('ohmail.roles_migrator');
  shape    text := current_setting('ohmail.roles_shape');
  runtime  text[] := current_setting('ohmail.roles_runtime')::text[];
  the_rule jsonb := current_setting('ohmail.roles_rule')::jsonb;
  no_bypass text[] := current_setting('ohmail.roles_no_bypass')::text[];
  ours     text[] := current_setting('ohmail.roles_schemas')::text[];
  mig_oid  oid := (SELECT oid FROM pg_roles WHERE rolname = migrator);
  deadlines jsonb := current_setting('ohmail.roles_deadlines')::jsonb;
  deadline_roles text[] := current_setting('ohmail.roles_deadline_roles')::text[];
  verbs    text[] := ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
  ext_ns   text[] := current_setting('ohmail.roles_extension_schemas')::text[];
  usable   text[] := current_setting('ohmail.roles_usage_schemas')::text[]
                     || current_setting('ohmail.roles_extension_schemas')::text[];
  the_views jsonb := current_setting('ohmail.roles_views')::jsonb;
  the_routines jsonb := current_setting('ohmail.roles_view_routines')::jsonb;
  view_ns  text[] := ARRAY(SELECT s FROM unnest(current_setting('ohmail.roles_usage_schemas')::text[]) AS s WHERE s <> 'public');
  login_oids oid[] := ARRAY(SELECT oid FROM pg_roles WHERE rolname = ANY (current_setting('ohmail.roles_runtime')::text[]));
  standing_views text[];
  path_want text;
  drift    text[] := '{}';
  line     text;
BEGIN
  -- MAINTAIN exists from Postgres 17 on (VACUUM, ANALYZE, REINDEX, REFRESH, CLUSTER, LOCK TABLE).
  IF current_setting('server_version_num')::int >= 170000 THEN
    verbs := array_append(verbs, 'MAINTAIN');
  END IF;
  path_want := (SELECT string_agg(quote_ident(x), ', ') FROM unnest(ARRAY['public'] || ext_ns) AS x);

  -- @clause census.roles
  drift := drift || ARRAY(
    SELECT format('role %s does not exist', want.rolname)
      FROM unnest(runtime || migrator) AS want(rolname)
     WHERE NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = want.rolname));
  -- @end census.roles

  -- @clause census.attributes
  drift := drift || ARRAY(
    SELECT format('role %s: attribute %s', r.rolname, a.attr)
      FROM pg_roles r
      CROSS JOIN LATERAL (VALUES ('SUPERUSER', r.rolsuper), ('BYPASSRLS', r.rolbypassrls),
                                 ('CREATEROLE', r.rolcreaterole), ('CREATEDB', r.rolcreatedb),
                                 ('REPLICATION', r.rolreplication), ('INHERIT', r.rolinherit),
                                 ('NOLOGIN', NOT r.rolcanlogin)) AS a(attr, held)
     WHERE r.rolname = ANY (runtime) AND a.held
     ORDER BY 1);
  -- @end census.attributes

  -- The right to bypass row security: on the migrator ONLY, of every role that is ours, by any
  -- road. The attribute is one. SUPERUSER is another: it bypasses everything. A membership in a
  -- role that has either is the third, whatever its options say: one SET ROLE, or one GRANT by a
  -- role that administers it, away. (A member of the migrator reaches all the migrator does; that
  -- fault has its own clause below and is named there, once.)
  -- These roles are read and never altered here, so each is refused by name.
  -- @clause census.bypass
  drift := drift || ARRAY(
    SELECT format('role %s may bypass row security (%s): of our roles only the migrator %s may', r.rolname, how.road, migrator)
      FROM pg_roles r
      CROSS JOIN LATERAL (
        SELECT 'BYPASSRLS' AS road WHERE r.rolbypassrls
        UNION ALL
        SELECT 'SUPERUSER' WHERE r.rolsuper
        UNION ALL
        SELECT format('a member of %s', b.rolname)
          FROM pg_roles b
         WHERE NOT r.rolsuper AND b.oid <> r.oid AND b.oid IS DISTINCT FROM mig_oid
           AND (b.rolbypassrls OR b.rolsuper) AND pg_has_role(r.oid, b.oid, 'MEMBER')
           AND NOT coalesce(pg_has_role(r.oid, mig_oid, 'MEMBER'), false)
      ) how
     WHERE r.rolname = ANY (no_bypass) AND r.oid IS DISTINCT FROM mig_oid
     ORDER BY 1);
  -- @end census.bypass
  -- @clause census.migrator
  drift := drift || ARRAY(
    SELECT format('the migrator %s %s', migrator, a.what)
      FROM pg_roles r
      CROSS JOIN LATERAL (VALUES
        ('does not bypass row security: a forced row lock would bind it too (the dump, the migrations, a restore). Without that right the lock is switched on unforced or not at all',
           NOT r.rolbypassrls),
        ('is a superuser: the migrator bypasses row security and is nothing more', r.rolsuper),
        ('may not create roles: it cannot make or alter the logins', NOT r.rolcreaterole AND NOT r.rolsuper)
      ) AS a(what, wrong)
     WHERE r.oid = mig_oid AND a.wrong);
  -- @end census.migrator

  -- @clause census.membership-forward
  drift := drift || ARRAY(
    SELECT format('role %s is a member of %s (granted by %s)', r.rolname, g.rolname, am.grantor::regrole)
      FROM pg_auth_members am JOIN pg_roles r ON r.oid = am.member JOIN pg_roles g ON g.oid = am.roleid
     WHERE r.rolname = ANY (runtime)
        OR (shape = 'plain' AND r.oid = mig_oid AND NOT (g.rolname = ANY (runtime) OR g.rolname = 'ohmail_admin'))
     ORDER BY 1);
  drift := drift || ARRAY(
    SELECT format('role %s reaches the rights of %s through a nested membership', r.rolname, o.rolname)
      FROM pg_roles r
      JOIN pg_roles o ON o.oid <> r.oid AND pg_has_role(r.oid, o.oid, 'MEMBER')
     WHERE r.rolname = ANY (runtime) AND NOT r.rolsuper
       AND NOT EXISTS (SELECT 1 FROM pg_auth_members am WHERE am.member = r.oid AND am.roleid = o.oid)
     ORDER BY 1);
  -- @end census.membership-forward

  -- @clause census.membership-reverse
  drift := drift || ARRAY(
    SELECT format('role %s is a member of the login %s (granted by %s): it can become that login',
                  am.member::regrole, g.rolname, am.grantor::regrole)
      FROM pg_auth_members am JOIN pg_roles g ON g.oid = am.roleid
     WHERE g.rolname = ANY (runtime) AND am.member IS DISTINCT FROM mig_oid
     ORDER BY 1);
  -- @end census.membership-reverse

  -- @clause census.membership-options
  drift := drift || ARRAY(
    SELECT format('the migrator''s membership in %s (granted by %s) carries %s: that row is ADMIN only', g.rolname,
                  am.grantor::regrole,
                  concat_ws(' and ', CASE WHEN am.inherit_option THEN 'INHERIT' END, CASE WHEN am.set_option THEN 'SET' END))
      FROM pg_auth_members am JOIN pg_roles g ON g.oid = am.roleid
     WHERE g.rolname = ANY (runtime) AND am.member = mig_oid AND (am.inherit_option OR am.set_option)
     ORDER BY 1);
  -- @end census.membership-options

  -- A role of ours that is a member of the migrator is the migrator, one SET ROLE away.
  -- @clause census.membership-migrator
  drift := drift || ARRAY(
    SELECT format('role %s is a member of the migrator %s', r.rolname, migrator)
      FROM pg_roles r
     WHERE r.rolname = ANY (no_bypass) AND r.oid IS DISTINCT FROM mig_oid AND NOT r.rolsuper
       AND pg_has_role(r.oid, mig_oid, 'MEMBER')
     ORDER BY 1);
  -- @end census.membership-migrator

  -- @clause census.ownership
  drift := drift || ARRAY(
    SELECT format('role %s owns the %s %s', w.rolname, x.kind, x.ident)
      FROM (
        SELECT c.relowner AS owner,
               CASE c.relkind WHEN 'S' THEN 'sequence' WHEN 'v' THEN 'view' WHEN 'i' THEN 'index'
                              WHEN 'm' THEN 'materialized view' ELSE 'relation' END AS kind,
               format('%I.%I', n.nspname, c.relname) AS ident
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        UNION ALL
        SELECT n.nspowner, 'schema', quote_ident(n.nspname) FROM pg_namespace n
        UNION ALL
        SELECT p.proowner, 'routine', p.oid::regprocedure::text FROM pg_proc p
        UNION ALL
        SELECT d.datdba, 'database', quote_ident(d.datname) FROM pg_database d
      ) x
      JOIN pg_roles w ON w.oid = x.owner
     WHERE w.rolname = ANY (runtime)
     ORDER BY 1);
  -- Every other kind of object, and every other database of this server, by the catalog that
  -- records an owner for anything at all.
  drift := drift || ARRAY(
    SELECT format('role %s owns %s object(s) recorded in %s%s', w.rolname, count(*), d.classid::regclass,
                  CASE WHEN d.dbid = 0 THEN ' (shared)' ELSE ' of database ' || coalesce(b.datname, d.dbid::text) END)
      FROM pg_shdepend d
      JOIN pg_roles w ON w.oid = d.refobjid
      LEFT JOIN pg_database b ON b.oid = d.dbid
     WHERE d.refclassid = 'pg_authid'::regclass AND d.deptype = 'o' AND w.rolname = ANY (runtime)
       AND NOT (coalesce(b.datname = current_database(), false)
                AND d.classid IN ('pg_class'::regclass, 'pg_namespace'::regclass, 'pg_proc'::regclass))
       AND d.classid <> 'pg_database'::regclass
     GROUP BY w.rolname, d.classid, d.dbid, b.datname
     ORDER BY 1);
  -- @end census.ownership

  -- @clause census.migrator-owns
  drift := drift || ARRAY(
    SELECT format('the %s %s is owned by %s, not by the migrator %s', x.kind, x.ident, x.owner::regrole, migrator)
      FROM (
        SELECT 'pg_class'::regclass AS classid, c.oid AS objid, c.relowner AS owner, 'relation' AS kind,
               format('%I.%I', n.nspname, c.relname) AS ident
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = ANY (ours) AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
        UNION ALL
        SELECT 'pg_proc'::regclass, p.oid, p.proowner, 'routine', p.oid::regprocedure::text
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = ANY (ours)
        UNION ALL
        SELECT 'pg_namespace'::regclass, n.oid, n.nspowner, 'schema', quote_ident(n.nspname)
          FROM pg_namespace n
         WHERE n.nspname = ANY (ours) AND n.nspname <> 'public'
      ) x
     WHERE mig_oid IS NOT NULL AND x.owner <> mig_oid
       AND NOT EXISTS (SELECT 1 FROM pg_depend e
                        WHERE e.classid = x.classid AND e.objid = x.objid AND e.deptype = 'e')
     ORDER BY 1);
  -- @end census.migrator-owns

  -- THE RULE, on every table of `public`: each verb is held exactly when the rule writes it.
  -- @clause census.relations
  drift := drift || ARRAY(
    WITH want AS (
      SELECT l.oid AS role_oid, l.rolname AS role, c.oid AS rel_oid, c.relname,
             ARRAY(SELECT jsonb_array_elements_text(
               CASE WHEN the_rule->'narrowed'->l.rolname::text ? c.relname::text
                      THEN the_rule->'narrowed'->l.rolname::text->c.relname::text
                    WHEN c.relname LIKE 'staff\_%' THEN '[]'::jsonb
                    ELSE the_rule->'default' END)) AS written
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
        JOIN pg_roles l ON l.rolname = ANY (runtime)
       WHERE c.relkind IN ('r', 'p')
    )
    SELECT format('%s on table public.%s: role %s %s', v.verb, w.relname, w.role,
                  CASE WHEN h.held THEN 'holds it and the rule does not write it'
                       ELSE 'lacks it and the rule writes it' END)
      FROM want w
      CROSS JOIN unnest(verbs) AS v(verb)
      CROSS JOIN LATERAL (SELECT has_table_privilege(w.role_oid, w.rel_oid, v.verb) AS held) h
     WHERE h.held <> (v.verb = ANY (w.written))
    UNION ALL
    SELECT format('%s WITH GRANT OPTION on table public.%s: role %s can hand it on', v.verb, w.relname, w.role)
      FROM want w
      CROSS JOIN unnest(verbs) AS v(verb)
     WHERE has_table_privilege(w.role_oid, w.rel_oid, v.verb || ' WITH GRANT OPTION')
     ORDER BY 1);
  -- @end census.relations

  -- @clause census.staff-rows
  drift := drift || ARRAY(
    SELECT format('table public.%s is a staff table with no row for role %s in the rule: a staff table is named before it is granted',
                  c.relname, l.role)
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      CROSS JOIN unnest(runtime) AS l(role)
     WHERE c.relkind IN ('r', 'p') AND c.relname LIKE 'staff\_%'
       AND NOT (coalesce(the_rule->'narrowed'->l.role, '{}'::jsonb) ? c.relname::text)
     ORDER BY 1);
  drift := drift || ARRAY(
    SELECT format('the rule names table public.%s for role %s and there is no such table', t.key, r.key)
      FROM jsonb_each(the_rule->'narrowed') r
      CROSS JOIN LATERAL jsonb_each(r.value) t
     WHERE to_regclass(format('public.%I', t.key)) IS NULL
     ORDER BY 1);
  -- @end census.staff-rows

  -- A view reads its base tables with its OWNER's rights. Owned by the migrator, which bypasses
  -- row security, it would answer with every account's rows. So no login reaches a view of `public`
  -- at all. The row lock's views carry the account's condition themselves: they are the rule's three
  -- in `ohmail`, judged by the arms below.
  -- @clause census.views
  drift := drift || ARRAY(
    SELECT format('%s on the %s public.%s: role %s reaches it, and it reads its tables with the rights of its owner %s, past any row lock',
                  v.verb, CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' ELSE 'foreign table' END,
                  c.relname, l.rolname, c.relowner::regrole)
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      JOIN pg_roles l ON l.rolname = ANY (runtime)
      CROSS JOIN unnest(verbs) AS v(verb)
     WHERE c.relkind IN ('v', 'm', 'f') AND has_table_privilege(l.oid, c.oid, v.verb)
     ORDER BY 1);
  -- @end census.views

  -- THE ACCOUNT'S VIEWS OF THE ROW LOCK, as the logins hold them: USAGE on their schema exactly while
  -- one of the login's views stands there, on each view that stands the verbs the rule writes and no
  -- other, and nothing to hand on. A view stands as the lock's setup step makes it: a plain view, the
  -- migrator's, in its schema of the migrator's; a view the rule names that does not stand is the
  -- lock's to make, and judged here once it stands.
  -- @clause census.views-grants
  drift := drift || ARRAY(
    WITH standing AS (
      SELECT l.oid AS role_oid, l.rolname AS role, c.oid AS rel_oid, format('%I.%I', n.nspname, c.relname) AS ident,
             ARRAY(SELECT jsonb_array_elements_text(the_views->l.rolname::text->format('%I.%I', n.nspname, c.relname))) AS written
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_roles l ON l.rolname = ANY (runtime)
       WHERE c.relkind = 'v' AND c.relowner = mig_oid AND n.nspowner = mig_oid AND n.nspname = ANY (view_ns)
         AND the_views->l.rolname::text ? format('%I.%I', n.nspname, c.relname)
    )
    SELECT format('%s on the view %s: role %s %s', v.verb, s.ident, s.role,
                  CASE WHEN h.held THEN 'holds it and the rule does not write it'
                       ELSE 'lacks it and the rule writes it' END)
      FROM standing s
      CROSS JOIN unnest(verbs) AS v(verb)
      CROSS JOIN LATERAL (SELECT has_table_privilege(s.role_oid, s.rel_oid, v.verb) AS held) h
     WHERE h.held <> (v.verb = ANY (s.written))
    UNION ALL
    SELECT format('%s WITH GRANT OPTION on the view %s: role %s can hand it on', v.verb, s.ident, s.role)
      FROM standing s
      CROSS JOIN unnest(verbs) AS v(verb)
     WHERE has_table_privilege(s.role_oid, s.rel_oid, v.verb || ' WITH GRANT OPTION')
    UNION ALL
    SELECT format('USAGE on schema %I: role %s %s', n.nspname, l.rolname,
                  CASE WHEN h.held THEN 'holds it, and no view the rule lists for it stands there'
                       ELSE 'lacks it, and the rule writes it while one of its views stands there' END)
      FROM pg_namespace n
      JOIN pg_roles l ON l.rolname = ANY (runtime)
      CROSS JOIN LATERAL (
        SELECT has_schema_privilege(l.oid, n.oid, 'USAGE') AS held,
               coalesce(n.nspowner = mig_oid AND EXISTS (
                 SELECT 1 FROM pg_class c
                  WHERE c.relnamespace = n.oid AND c.relkind = 'v' AND c.relowner = mig_oid
                    AND the_views->l.rolname::text ? format('%I.%I', n.nspname, c.relname)), false) AS written) h
     WHERE n.nspname = ANY (view_ns) AND h.held <> h.written
    UNION ALL
    SELECT format('USAGE WITH GRANT OPTION on schema %I: role %s can hand it on', n.nspname, l.rolname)
      FROM pg_namespace n
      JOIN pg_roles l ON l.rolname = ANY (runtime)
     WHERE n.nspname = ANY (view_ns) AND has_schema_privilege(l.oid, n.oid, 'USAGE WITH GRANT OPTION')
     ORDER BY 1);
  -- @end census.views-grants

  -- WHAT STANDS in the schema of the row lock's views: the views the rule names, plain views of the
  -- migrator's, and no other relation. The names come from the rule, never from the catalog: a
  -- relation the rule does not name is refused by its existence, read by a login or not. A view
  -- under one of the rule's names is held to its kind and its owner only. Its text is NOT judged
  -- here: a view made again under its name with another text (a WHERE gone, a barrier set) is the
  -- lock's own check's to refuse, by the text, owner, options and columns it recorded.
  -- @clause census.views-schema
  drift := drift || ARRAY(
    SELECT format('the schema %I is owned by %s, not by the migrator %s: the rule grants nothing in it', n.nspname,
                  n.nspowner::regrole, migrator)
      FROM pg_namespace n
     WHERE n.nspname = ANY (view_ns) AND n.nspowner IS DISTINCT FROM mig_oid
    UNION ALL
    SELECT format('the %s %I.%I stands in schema %I, %s',
                  CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' WHEN 'f' THEN 'foreign table'
                                 WHEN 'S' THEN 'sequence' ELSE 'table' END,
                  n.nspname, c.relname, n.nspname,
                  CASE WHEN NOT k.listed
                         THEN 'and the rule names no such relation: what a login may read there is a decision to make in the rule'
                       WHEN c.relkind <> 'v'
                         THEN 'and the rule names a view by that name, the one the lock''s setup step makes'
                       ELSE format('owned by %s, and the rule names the view the migrator %s makes', c.relowner::regrole, migrator) END)
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM jsonb_each(the_views) r
                                          WHERE r.value ? format('%I.%I', n.nspname, c.relname)) AS listed) k
     WHERE n.nspname = ANY (view_ns) AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
       AND NOT (k.listed AND c.relkind = 'v' AND c.relowner IS NOT DISTINCT FROM mig_oid)
     ORDER BY 1);
  -- @end census.views-schema

  -- The routines of that schema a login may run: the lock's readers the rule names, whose EXECUTE is
  -- PUBLIC's (every view and every policy calls them). Any other routine there a login may run is
  -- refused by name, whoever owns it and whatever rights it runs with: none is the rule's to admit.
  -- @clause census.views-routines
  drift := drift || ARRAY(
    SELECT format('EXECUTE on the routine %s: role %s may run it in schema %I, where the rule admits %s alone. By hand: drop it, or revoke EXECUTE on it from PUBLIC',
                  r.ident, l.rolname, n.nspname,
                  coalesce((SELECT string_agg(a, ', ' ORDER BY a) FROM jsonb_array_elements_text(the_routines->l.rolname::text) AS a), 'no routine'))
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      CROSS JOIN LATERAL (SELECT format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) AS ident) r
      JOIN pg_roles l ON l.rolname = ANY (runtime)
     WHERE n.nspname = ANY (view_ns)
       AND has_function_privilege(l.oid, p.oid, 'EXECUTE')
       AND NOT coalesce(the_routines->l.rolname::text ? r.ident, false)
     ORDER BY 1);
  -- @end census.views-routines

  -- Nobody but the two logins and the schema's owner holds an entry in that schema: not PUBLIC (which is
  -- every role, a host's own among them), not the staff role, not the billing plane. A view there
  -- reads its tables with the migrator's rights, so whoever may read one reads every account it is
  -- told to. Such a grant is read and never touched here (PUBLIC's is revoked above): refused by name.
  -- A road there that is no entry, a membership, is census.views-reach's, below.
  -- @clause census.views-others
  drift := drift || ARRAY(
    SELECT format('%s on schema %I: granted to %s, and in the schema of the row lock''s views only the logins may hold a right',
                  x.privilege_type, n.nspname, CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END)
      FROM pg_namespace n
      CROSS JOIN LATERAL aclexplode(n.nspacl) x
     WHERE n.nspname = ANY (view_ns) AND x.grantee <> n.nspowner AND NOT x.grantee = ANY (login_oids)
    UNION ALL
    SELECT format('%s on the %s %I.%I: granted to %s, and in the schema of the row lock''s views only the logins may hold a right',
                  x.privilege_type,
                  CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' WHEN 'f' THEN 'foreign table'
                                 WHEN 'S' THEN 'sequence' ELSE 'table' END,
                  n.nspname, c.relname, CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END)
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) x
     WHERE n.nspname = ANY (view_ns) AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
       AND x.grantee <> c.relowner AND NOT x.grantee = ANY (login_oids)
    UNION ALL
    SELECT format('%s on column %I.%I.%I: granted to %s, and in the schema of the row lock''s views only the logins may hold a right',
                  x.privilege_type, n.nspname, c.relname, a.attname, CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END)
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(a.attacl) x
     WHERE n.nspname = ANY (view_ns) AND a.attnum > 0 AND NOT a.attisdropped
       AND x.grantee <> c.relowner AND NOT x.grantee = ANY (login_oids)
     ORDER BY 1);
  -- @end census.views-others

  -- WHO ELSE REACHES THAT SCHEMA, BY ANY ROAD. A right there needs no entry there: a member of
  -- pg_read_all_data holds SELECT on every relation and USAGE on every schema, a member of
  -- pg_write_all_data INSERT, UPDATE and DELETE and USAGE, and neither may bypass row security. On the
  -- tables the lock holds such a role (no policy names it); through a view it reads or rewrites, with
  -- the migrator's rights, whatever account it binds. So every other role is read for what it may
  -- EFFECTIVELY do there, as each role it may act as (may_act, below): itself, with all it inherits
  -- (has_*_privilege answers that, as for the logins); each role it may SET ROLE to (a membership WITH
  -- INHERIT FALSE confers nothing by itself and has_*_privilege does not show it, but one SET ROLE away
  -- the member reads); and each role an ADMIN option lets it grant itself. That option confers nothing
  -- by itself either, yet whoever may act as its holder, or as a role that inherits the holder, may
  -- GRANT itself the membership, then SET ROLE to it, and on from there, ADMIN options included: the
  -- option held, inherited from a group, held by a group it may SET ROLE to or by one that a role it
  -- may SET ROLE to inherits, and an option on a role that holds one (two grants of its own) are each a
  -- road. USAGE and the verb are read together, of the role the statement would run as. Refused by
  -- name, never repaired: a membership is its grantor's to revoke, and this file revokes none but the
  -- logins'.
  -- Left to the arms that name it once: the logins (census.views-grants); a role that may act as the
  -- migrator, by INHERIT or SET (it is the migrator; the report names the migrator's members); a role
  -- that may act as a login (census.membership-reverse); a role's own entry on a relation there
  -- (census.views-others); the ADMIN option on the migrator or on a login, which is a membership in it
  -- (the report names the migrator's members, census.membership-reverse a login's). Left to the host,
  -- and named in the report with the attribute: a role with SUPERUSER, BYPASSRLS or REPLICATION, which
  -- reads every row already. Not a road: CREATEROLE alone, for since Postgres 16 it grants no
  -- membership in a role it holds no ADMIN option on; a membership with no option at all in a role
  -- that holds one, for the member may not act as that role. Counted though it is no road, which
  -- refuses more: the ADMIN option on a SUPERUSER role, whose membership only a superuser may grant.
  -- pg_maintain (17) gives MAINTAIN on every relation and no USAGE: alone it reaches nothing there.
  -- @clause census.views-reach
  drift := drift || ARRAY(
    -- may_act(role_oid, acts_as, holder): the roles each role may act as. By SET ROLE, itself included (no
    -- holder); and by an ADMIN option: acting as a role x that holds the option on a role y, or inherits a
    -- role that does, it grants itself y, and may then SET ROLE to y and to whatever y may SET ROLE to
    -- (holder: the role whose option it used). Never y the migrator or a login (above). Nothing is
    -- followed from a superuser: as x it reaches everything there already, and as y (counted, above) it
    -- would be every role. UNION adds each row once, so it ends.
    WITH RECURSIVE may_act(role_oid, acts_as, holder) AS (
      SELECT a.oid, b.oid, NULL::oid FROM pg_roles a JOIN pg_roles b ON pg_has_role(a.oid, b.oid, 'SET')
      -- @clause census.views-reach-admin
      UNION
      SELECT m.role_oid, t.oid, am.member
        FROM may_act m
        JOIN pg_roles x ON x.oid = m.acts_as AND NOT x.rolsuper
        JOIN pg_auth_members am ON am.admin_option AND pg_has_role(x.oid, am.member, 'USAGE')
        JOIN pg_roles y ON y.oid = am.roleid
        JOIN pg_roles t ON t.oid = y.oid OR (NOT y.rolsuper AND pg_has_role(y.oid, t.oid, 'SET'))
       WHERE y.oid IS DISTINCT FROM mig_oid AND NOT y.oid = ANY (login_oids)
      -- @end census.views-reach-admin
    )
    SELECT format('%s on the %s %I.%I: role %s reaches it through %s, a membership and no entry of its own there, and through the view acts with the migrator''s rights on whatever account it names. By hand: revoke that membership',
                  h.held,
                  CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' WHEN 'f' THEN 'foreign table'
                                 WHEN 'S' THEN 'sequence' ELSE 'table' END,
                  n.nspname, c.relname, r.rolname, coalesce(h.through, 'what it holds itself (PUBLIC, or what it owns)'))
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_roles r ON r.oid IS DISTINCT FROM mig_oid AND NOT r.oid = ANY (login_oids) AND r.rolname !~ '^pg_'
                     AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolreplication
      CROSS JOIN LATERAL (
        SELECT (SELECT string_agg(v.verb, ' ' ORDER BY v.ord)
                  FROM unnest(verbs) WITH ORDINALITY AS v(verb, ord)
                 WHERE EXISTS (SELECT 1 FROM may_act m
                                WHERE m.role_oid = r.oid
                                  AND has_schema_privilege(m.acts_as, n.oid, 'USAGE')
                                  AND has_table_privilege(m.acts_as, c.oid, v.verb))) AS held,
               (SELECT string_agg(s.rolname || CASE WHEN pg_has_role(r.oid, s.oid, 'USAGE') THEN ''
                                                    WHEN pg_has_role(r.oid, s.oid, 'SET') THEN ' (by SET ROLE)'
                                                    ELSE ' (by the ADMIN option of '
                                                         || (SELECT string_agg(DISTINCT o.rolname::text, ', ' ORDER BY o.rolname::text)
                                                               FROM may_act m JOIN pg_roles o ON o.oid = m.holder
                                                              WHERE m.role_oid = r.oid AND m.acts_as = s.oid)
                                                         || ': it may grant itself the membership)' END,
                                  ', ' ORDER BY s.rolname)
                  FROM pg_roles s
                 WHERE s.oid <> r.oid
                   AND (pg_has_role(r.oid, s.oid, 'USAGE')
                        OR EXISTS (SELECT 1 FROM may_act m WHERE m.role_oid = r.oid AND m.acts_as = s.oid))
                   AND EXISTS (SELECT 1 FROM unnest(verbs) AS v(verb) WHERE has_table_privilege(s.oid, c.oid, v.verb))) AS through
      ) h
     WHERE n.nspname = ANY (view_ns) AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
       AND h.held IS NOT NULL
       AND NOT coalesce(pg_has_role(r.oid, mig_oid, 'USAGE') OR pg_has_role(r.oid, mig_oid, 'SET'), false)
       AND NOT EXISTS (SELECT 1 FROM unnest(login_oids) AS l(oid)
                        WHERE pg_has_role(r.oid, l.oid, 'USAGE') OR pg_has_role(r.oid, l.oid, 'SET'))
       AND NOT EXISTS (SELECT 1 FROM aclexplode(c.relacl) x WHERE x.grantee = r.oid)
     ORDER BY 1);
  -- @end census.views-reach

  -- A schema the logins may use beside `public` where a host keeps the search extensions is on
  -- their search path, and the rule writes nothing in it. A relation a login reaches there came by
  -- a road no section above owns, a grant to PUBLIC, and a view there reads with its owner's
  -- rights. What an extension brought is the extension's; anything else is refused by name. (The
  -- schema of the row lock's views is on no search path, and its own arms above judge it.)
  -- @clause census.usable-schemas
  drift := drift || ARRAY(
    SELECT format('%s on the %s %I.%I: role %s reaches it in a schema it may use, where the rule writes nothing (owner %s). By hand: revoke it from PUBLIC, or drop the relation',
                  coalesce(h.held, 'a column right'),
                  CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' WHEN 'f' THEN 'foreign table' ELSE 'table' END,
                  n.nspname, c.relname, l.rolname, c.relowner::regrole)
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_roles l ON l.rolname = ANY (runtime)
      CROSS JOIN LATERAL (SELECT string_agg(v.verb, ' ') AS held FROM unnest(verbs) AS v(verb)
                           WHERE has_table_privilege(l.oid, c.oid, v.verb)) h
     WHERE n.nspname = ANY (usable) AND n.nspname <> 'public' AND NOT n.nspname = ANY (view_ns)
       AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND (h.held IS NOT NULL OR has_any_column_privilege(l.oid, c.oid, 'SELECT, INSERT, UPDATE, REFERENCES'))
       AND NOT EXISTS (SELECT 1 FROM pg_depend e
                        WHERE e.classid = 'pg_class'::regclass AND e.objid = c.oid AND e.deptype = 'e')
     ORDER BY 1);
  -- @end census.usable-schemas

  -- The journals make no sequence in `public` (no serial, no identity). One that appears is a
  -- decision about who may advance it, so it is refused until the rule has a row for it.
  -- @clause census.sequences
  drift := drift || ARRAY(
    SELECT format('sequence public.%s exists and the rule writes no sequence: its grant is a decision to make in the rule', c.relname)
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
     WHERE c.relkind = 'S'
     ORDER BY 1);
  drift := drift || ARRAY(
    SELECT format('%s on sequence %I.%I: role %s', p.priv, n.nspname, c.relname, l.rolname)
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_roles l ON l.rolname = ANY (runtime)
      CROSS JOIN unnest(ARRAY['USAGE', 'SELECT', 'UPDATE']) AS p(priv)
     WHERE c.relkind = 'S' AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
       AND has_sequence_privilege(l.oid, c.oid, p.priv)
     ORDER BY 1);
  -- @end census.sequences

  -- No column grant: the rule filters rows, never columns. A column right the table-level verb
  -- does not already carry came from a column grant, to the login or to PUBLIC.
  -- @clause census.columns
  drift := drift || ARRAY(
    SELECT format('%s on column public.%s.%s: role %s holds it and holds no %s on the table', p.priv, c.relname,
                  a.attname, l.rolname, p.priv)
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      JOIN pg_roles l ON l.rolname = ANY (runtime)
      CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) AS p(priv)
     WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND has_column_privilege(l.oid, c.oid, a.attnum, p.priv)
       AND NOT has_table_privilege(l.oid, c.oid, p.priv)
     ORDER BY 1);
  drift := drift || ARRAY(
    SELECT format('a column grant names role %s: %s on %I.%I.%I', l.rolname, x.privilege_type, n.nspname, c.relname, a.attname)
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(a.attacl) x
      JOIN pg_roles l ON l.oid = x.grantee
     WHERE l.rolname = ANY (runtime) AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY 1);
  -- @end census.columns

  -- Outside `public` the rule writes nothing but the verbs of the row lock's views (held exactly by
  -- census.views-grants): any other entry that names a login is one too many.
  -- @clause census.other-schemas
  drift := drift || ARRAY(
    SELECT format('%s on %I.%I: a direct grant to role %s outside the rule (granted by %s)', x.privilege_type,
                  n.nspname, c.relname, l.rolname, x.grantor::regrole)
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) x
      JOIN pg_roles l ON l.oid = x.grantee
     WHERE l.rolname = ANY (runtime) AND n.nspname <> 'public'
       AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
       AND NOT coalesce(c.relkind = 'v' AND c.relowner = mig_oid AND n.nspowner = mig_oid AND n.nspname = ANY (view_ns)
                        AND NOT x.is_grantable
                        AND coalesce(the_views->l.rolname::text->format('%I.%I', n.nspname, c.relname), '[]'::jsonb) ? x.privilege_type,
                        false)
     ORDER BY 1);
  -- @end census.other-schemas

  -- USAGE on the schemas the rule names (`public`, and where the search extensions live; `ohmail`
  -- follows its views, in census.views-grants); on no other schema, `admin`, `plane` and the
  -- migration ledgers among them. CREATE nowhere, `ohmail` included.
  -- @clause census.schemas
  drift := drift || ARRAY(
    SELECT format('%s on schema %I: role %s %s', p.priv, n.nspname, l.rolname,
                  CASE WHEN h.held THEN 'holds it and the rule does not write it'
                       ELSE 'lacks it and the rule writes it (GRANT USAGE ON SCHEMA ' || quote_ident(n.nspname)
                            || ' TO ' || l.rolname || ', as the schema''s owner ' || n.nspowner::regrole::text || ')' END)
      FROM pg_namespace n
      JOIN pg_roles l ON l.rolname = ANY (runtime)
      CROSS JOIN (VALUES ('USAGE'), ('CREATE')) AS p(priv)
      CROSS JOIN LATERAL (SELECT has_schema_privilege(l.oid, n.oid, p.priv) AS held,
                                 (p.priv = 'USAGE' AND n.nspname = ANY (usable)) AS written) h
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
       AND n.nspname !~ '^pg_(toast_)?temp_'
       AND h.held <> h.written
       -- USAGE on the schema of the row lock's views follows the views: census.views-grants holds it.
       AND NOT (p.priv = 'USAGE' AND n.nspname = ANY (view_ns))
     ORDER BY 1);
  -- @end census.schemas

  -- A schema named like a login sits FIRST on that login's default search path ("$user").
  -- @clause census.shadow-schema
  drift := drift || ARRAY(
    SELECT format('a schema is named %I, like a login: its objects would shadow those of public for that login', n.nspname)
      FROM pg_namespace n WHERE n.nspname = ANY (runtime)
     ORDER BY 1);
  -- @end census.shadow-schema

  -- @clause census.routines
  drift := drift || ARRAY(
    SELECT format('EXECUTE on routine %s: a direct grant to role %s outside the rule', p.oid::regprocedure, l.rolname)
      FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(p.proacl) x
      JOIN pg_roles l ON l.oid = x.grantee
     WHERE l.rolname = ANY (runtime)
     ORDER BY 1);
  -- @end census.routines

  -- A SECURITY DEFINER routine runs as its OWNER. Postgres grants EXECUTE on every routine to
  -- PUBLIC, so one such helper in a schema a login can use is a road past every grant above and
  -- past the row lock. It cannot be revoked from the login, and revoking it from PUBLIC is a
  -- decision about every other role: refused by name, and the remedy is a person's.
  -- @clause census.secdef
  drift := drift || ARRAY(
    SELECT format('EXECUTE on the SECURITY DEFINER routine %s: role %s can run it with the rights of its owner %s. By hand: REVOKE EXECUTE ON ROUTINE %s FROM PUBLIC, or drop it',
                  p.oid::regprocedure, l.rolname, p.proowner::regrole, p.oid::regprocedure)
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_roles l ON l.rolname = ANY (runtime)
     WHERE p.prosecdef
       AND n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND has_schema_privilege(l.oid, n.oid, 'USAGE')
       AND has_function_privilege(l.oid, p.oid, 'EXECUTE')
     ORDER BY 1);
  -- @end census.secdef

  -- @clause census.default-acl
  drift := drift || ARRAY(
    SELECT format('the default privileges of %s%s grant %s on new %s to role %s: a table made later would arrive open',
                  d.defaclrole::regrole,
                  CASE WHEN d.defaclnamespace = 0 THEN '' ELSE ' in schema ' || d.defaclnamespace::regnamespace END,
                  string_agg(DISTINCT x.privilege_type, ' ' ORDER BY x.privilege_type),
                  CASE d.defaclobjtype WHEN 'r' THEN 'tables' WHEN 'S' THEN 'sequences' WHEN 'f' THEN 'routines'
                                       WHEN 'T' THEN 'types' ELSE 'schemas' END,
                  l.rolname)
      FROM pg_default_acl d
      CROSS JOIN LATERAL aclexplode(d.defaclacl) x
      JOIN pg_roles l ON l.oid = x.grantee
     WHERE l.rolname = ANY (runtime)
     GROUP BY d.defaclrole, d.defaclnamespace, d.defaclobjtype, l.rolname
    UNION ALL
    SELECT format('the default privileges of %s%s grant %s on new %s to PUBLIC: every later one would arrive open to every login',
                  d.defaclrole::regrole,
                  CASE WHEN d.defaclnamespace = 0 THEN '' ELSE ' in schema ' || d.defaclnamespace::regnamespace END,
                  string_agg(DISTINCT x.privilege_type, ' ' ORDER BY x.privilege_type),
                  CASE d.defaclobjtype WHEN 'r' THEN 'tables' ELSE 'sequences' END)
      FROM pg_default_acl d
      LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
      CROSS JOIN LATERAL aclexplode(d.defaclacl) x
     WHERE x.grantee = 0 AND d.defaclobjtype IN ('r', 'S')
       AND (n.nspname = ANY (ours || view_ns) OR (d.defaclnamespace = 0 AND d.defaclrole = mig_oid))
     GROUP BY d.defaclrole, d.defaclnamespace, d.defaclobjtype
    UNION ALL
    -- The migrator's own for any other role: in the schema of the row lock's views (the repair above takes it),
    -- or with no schema named, which reaches every schema and is refused by name (revoking it is a decision about
    -- all of them). Judged only once that schema stands: before the lock's setup step made it, nothing is born there.
    -- Another role's default privilege there is not judged: nothing that role makes there can stand. The line says
    -- what takes it away by hand: a read-only check names it before the lock's setup step, which it stops, and the
    -- apply that would repair the schema's form runs only after that step has passed.
    SELECT format('the default privileges of the migrator %s%s grant %s on new %s to %s: a view the lock''s setup step makes again would arrive granted to it, and in the schema of the row lock''s views only the logins may hold a right%s',
                  d.defaclrole::regrole,
                  CASE WHEN d.defaclnamespace = 0 THEN ' (in every schema)' ELSE ' in schema ' || d.defaclnamespace::regnamespace END,
                  string_agg(DISTINCT x.privilege_type, ' ' ORDER BY x.privilege_type),
                  CASE d.defaclobjtype WHEN 'r' THEN 'tables' ELSE 'sequences' END, x.grantee::regrole,
                  CASE WHEN d.defaclnamespace = 0
                       THEN '. By hand: name the schemas it is meant for (ALTER DEFAULT PRIVILEGES ... IN SCHEMA ...), or revoke it'
                       ELSE format('. By hand: ALTER DEFAULT PRIVILEGES FOR ROLE %s IN SCHEMA %s REVOKE ALL ON %s FROM %s',
                                   d.defaclrole::regrole, d.defaclnamespace::regnamespace,
                                   CASE d.defaclobjtype WHEN 'r' THEN 'TABLES' ELSE 'SEQUENCES' END, x.grantee::regrole) END)
      FROM pg_default_acl d
      LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
      CROSS JOIN LATERAL aclexplode(d.defaclacl) x
     WHERE d.defaclrole = mig_oid AND d.defaclobjtype IN ('r', 'S')
       AND (n.nspname = ANY (view_ns)
            OR (d.defaclnamespace = 0 AND EXISTS (SELECT 1 FROM pg_namespace v WHERE v.nspname = ANY (view_ns))))
       AND x.grantee <> 0 AND x.grantee <> d.defaclrole AND NOT x.grantee = ANY (login_oids)
     GROUP BY d.defaclrole, d.defaclnamespace, d.defaclobjtype, x.grantee
     ORDER BY 1);
  -- @end census.default-acl

  -- @clause census.database
  drift := drift || ARRAY(
    SELECT format('CREATE on the database: role %s can make schemas in it', l.rolname)
      FROM pg_roles l
     WHERE l.rolname = ANY (runtime) AND has_database_privilege(l.oid, current_database(), 'CREATE')
     ORDER BY 1);
  drift := drift || ARRAY(
    SELECT format('%s on the database: a direct grant to role %s outside the rule', x.privilege_type, l.rolname)
      FROM pg_database d
      CROSS JOIN LATERAL aclexplode(d.datacl) x
      JOIN pg_roles l ON l.oid = x.grantee
     WHERE d.datname = current_database() AND l.rolname = ANY (runtime)
     ORDER BY 1);
  -- @end census.database

  -- The object kinds the rule never mentions. `parameter` is the one that matters most: a grant
  -- there lets a login change a server setting.
  -- @clause census.other-kinds
  drift := drift || ARRAY(
    SELECT format('%s on the %s %s: a direct grant to role %s outside the rule', x.privilege_type, k.kind, k.ident, l.rolname)
      FROM (
        SELECT 'type' AS kind, t.oid::regtype::text AS ident, t.typacl AS acl FROM pg_type t WHERE t.typacl IS NOT NULL
        UNION ALL SELECT 'language', a.lanname::text, a.lanacl FROM pg_language a WHERE a.lanacl IS NOT NULL
        UNION ALL SELECT 'foreign-data wrapper', w.fdwname::text, w.fdwacl FROM pg_foreign_data_wrapper w WHERE w.fdwacl IS NOT NULL
        UNION ALL SELECT 'foreign server', s.srvname::text, s.srvacl FROM pg_foreign_server s WHERE s.srvacl IS NOT NULL
        UNION ALL SELECT 'server parameter', p.parname, p.paracl FROM pg_parameter_acl p WHERE p.paracl IS NOT NULL
        UNION ALL SELECT 'tablespace', s.spcname::text, s.spcacl FROM pg_tablespace s WHERE s.spcacl IS NOT NULL
        UNION ALL SELECT 'large object', m.oid::text, m.lomacl FROM pg_largeobject_metadata m WHERE m.lomacl IS NOT NULL
      ) k
      CROSS JOIN LATERAL aclexplode(k.acl) x
      JOIN pg_roles l ON l.oid = x.grantee
     WHERE l.rolname = ANY (runtime)
     ORDER BY 1);
  -- @end census.other-kinds

  -- What section 3 could not revoke (an object this session does not own): named as PUBLIC's,
  -- so that nobody goes looking for a grant to a login that is not there.
  -- @clause census.public
  drift := drift || ARRAY(
    SELECT format('%s on %I.%I is granted to PUBLIC: it reaches every login, and no REVOKE from a login removes it',
                  x.privilege_type, n.nspname, c.relname)
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) x
     WHERE n.nspname = ANY (ours) AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S') AND x.grantee = 0
    UNION ALL
    SELECT format('%s on column %I.%I.%I is granted to PUBLIC: it reaches every login', x.privilege_type, n.nspname,
                  c.relname, a.attname)
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(a.attacl) x
     WHERE n.nspname = ANY (ours) AND a.attnum > 0 AND NOT a.attisdropped AND x.grantee = 0
    UNION ALL
    SELECT format('CREATE on schema %I is granted to PUBLIC: every login can make objects in it', n.nspname)
      FROM pg_namespace n
      CROSS JOIN LATERAL aclexplode(n.nspacl) x
     WHERE n.nspname = ANY (ours) AND x.grantee = 0 AND x.privilege_type = 'CREATE'
     ORDER BY 1);
  -- @end census.public

  -- The settings of section 4, read back from the catalog: the two logins carry the search path
  -- and the three deadlines and nothing else, role-only; the staff role carries the three.
  -- @clause census.settings
  drift := drift || ARRAY(
    WITH held AS (
      SELECT l.oid, l.rolname, l.rolname = ANY (runtime) AS is_login, st.setdatabase, d.datname,
             split_part(kv, '=', 1) AS key, substr(kv, strpos(kv, '=') + 1) AS val
        FROM pg_roles l
        JOIN pg_db_role_setting st ON st.setrole = l.oid
        LEFT JOIN pg_database d ON d.oid = st.setdatabase
        CROSS JOIN LATERAL unnest(st.setconfig) AS kv
       WHERE l.rolname = ANY (deadline_roles)
    )
    SELECT format('role %s: the setting %s is set in database %s, and a login''s settings are role-only', h.rolname, h.key, h.datname)
      FROM held h WHERE h.setdatabase <> 0 AND (h.is_login OR deadlines ? h.key)
    UNION ALL
    SELECT format('role %s: the setting %s is set and the rule writes no such setting', h.rolname, h.key)
      FROM held h WHERE h.setdatabase = 0 AND h.is_login AND h.key <> 'search_path' AND NOT deadlines ? h.key
    UNION ALL
    SELECT format('role %s: search_path is not %s', l.rolname, path_want)
      FROM pg_roles l
     WHERE l.rolname = ANY (runtime)
       AND coalesce((SELECT replace(replace(h.val, ' ', ''), '"', '') FROM held h
                      WHERE h.oid = l.oid AND h.setdatabase = 0 AND h.key = 'search_path'), '')
           <> replace(replace(path_want, ' ', ''), '"', '')
    UNION ALL
    SELECT format('role %s: %s is %s, not %sms: no login runs without its ceiling', l.rolname, w.key, coalesce(h.val, 'unset'), w.value)
      FROM pg_roles l
      CROSS JOIN jsonb_each_text(deadlines) w
      LEFT JOIN held h ON h.oid = l.oid AND h.setdatabase = 0 AND h.key = w.key
     WHERE l.rolname = ANY (deadline_roles)
       AND (CASE WHEN h.val ~ '^[0-9]+(ms)?$' THEN regexp_replace(h.val, 'ms$', '')::bigint
                 WHEN h.val ~ '^[0-9]+s$'    THEN left(h.val, -1)::bigint * 1000
                 WHEN h.val ~ '^[0-9]+min$'  THEN left(h.val, -3)::bigint * 60000
                 WHEN h.val ~ '^[0-9]+h$'    THEN left(h.val, -1)::bigint * 3600000 END) IS DISTINCT FROM w.value::bigint
     ORDER BY 1);
  -- @end census.settings

  -- Without the ADMIN option on a role the migrator cannot keep that role's settings.
  -- @clause census.admin-option
  drift := drift || ARRAY(
    SELECT format('the migrator %s holds no ADMIN option on role %s, so it cannot keep its deadlines. As a superuser: GRANT %s TO %s WITH ADMIN TRUE, INHERIT FALSE, SET FALSE',
                  migrator, l.rolname, l.rolname, migrator)
      FROM pg_roles l
     WHERE l.rolname = ANY (deadline_roles) AND mig_oid IS NOT NULL
       AND NOT (SELECT m.rolsuper FROM pg_roles m WHERE m.oid = mig_oid)
       AND NOT EXISTS (SELECT 1 FROM pg_auth_members am
                        WHERE am.roleid = l.oid AND am.member = mig_oid AND am.admin_option)
     ORDER BY 1);
  -- @end census.admin-option

  -- ── What is read and not judged: the host's own, and what a later step decides. ──────────
  RAISE NOTICE 'ROLES_REPORT shape=% migrator=% server=%', shape, migrator, current_setting('server_version_num');
  RAISE NOTICE 'ROLES_REPORT database_owner=% public_schema_owner=%',
    (SELECT d.datdba::regrole FROM pg_database d WHERE d.datname = current_database()),
    (SELECT n.nspowner::regrole FROM pg_namespace n WHERE n.nspname = 'public');
  RAISE NOTICE 'ROLES_REPORT public_tables=% row_security_on=% row_security_forced=% views_in_public=%',
    (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')),
    (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relrowsecurity),
    (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relforcerowsecurity),
    (SELECT coalesce(string_agg(c.relname, ',' ORDER BY c.relname), 'none') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm'));
  -- The account's views of the row lock: how many of those the rule names stand as the lock's setup
  -- step makes them (none before it ran), which, and the logins the rule names them for.
  standing_views := ARRAY(
    SELECT DISTINCT format('%I.%I', n.nspname, c.relname) COLLATE "C"
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind = 'v' AND c.relowner = mig_oid AND n.nspowner = mig_oid AND n.nspname = ANY (view_ns)
       AND EXISTS (SELECT 1 FROM jsonb_each(the_views) r WHERE r.value ? format('%I.%I', n.nspname, c.relname))
     ORDER BY 1);
  RAISE NOTICE 'ROLES_REPORT account_views=%/% standing=% for=%',
    cardinality(standing_views),
    (SELECT count(DISTINCT k) FROM jsonb_each(the_views) r CROSS JOIN LATERAL jsonb_object_keys(r.value) AS k),
    CASE WHEN cardinality(standing_views) = 0 THEN 'none' ELSE array_to_string(standing_views, ',') END,
    coalesce((SELECT string_agg(r.key, ',' ORDER BY r.key COLLATE "C") FROM jsonb_each(the_views) r), 'none');
  -- The row lock's off marker, where its switch writes it: the comment on the lock's schema, one line with no free
  -- text (`ohmail.lock off since=<UTC> by=<role> why=<incident|rehearsal|test>`), none while the lock stands. Read
  -- here, never judged; a comment of any other shape is said to be one, and never printed.
  RAISE NOTICE 'ROLES_REPORT lock_marker=%',
    (SELECT CASE WHEN m.comment IS NULL OR m.comment = '' THEN 'none'
                 WHEN m.comment ~ '^ohmail\.lock off since=\S+ by=[a-z_][a-z0-9_]* why=(incident|rehearsal|test)$' THEN m.comment
                 ELSE 'unreadable' END
       FROM (SELECT obj_description(to_regnamespace('ohmail'), 'pg_namespace') AS comment) m);
  -- The roles that read every row already, each by an attribute of its own, and by which: census.views-reach
  -- leaves them to the host.
  RAISE NOTICE 'ROLES_REPORT other_roles_that_read_every_row=%',
    (SELECT coalesce(string_agg(r.rolname || ':' || concat_ws('/', CASE WHEN r.rolsuper THEN 'SUPERUSER' END,
                                                             CASE WHEN r.rolbypassrls THEN 'BYPASSRLS' END,
                                                             CASE WHEN r.rolreplication THEN 'REPLICATION' END),
                                ',' ORDER BY r.rolname), 'none')
       FROM pg_roles r
      WHERE (r.rolsuper OR r.rolbypassrls OR r.rolreplication) AND r.oid IS DISTINCT FROM mig_oid);
  RAISE NOTICE 'ROLES_REPORT migrator_member_of=% members_of_migrator=%',
    (SELECT coalesce(string_agg(DISTINCT am.roleid::regrole::text, ','), 'none') FROM pg_auth_members am WHERE am.member = mig_oid),
    (SELECT coalesce(string_agg(DISTINCT am.member::regrole::text, ','), 'none') FROM pg_auth_members am WHERE am.roleid = mig_oid);
  RAISE NOTICE 'ROLES_REPORT migrator_settings=%',
    (SELECT coalesce((SELECT string_agg(CASE WHEN deadlines ? split_part(kv, '=', 1) THEN kv ELSE split_part(kv, '=', 1) END, ',' ORDER BY 1)
                        FROM pg_db_role_setting st CROSS JOIN LATERAL unnest(st.setconfig) AS kv
                       WHERE st.setrole = mig_oid AND st.setdatabase = 0), 'none'));
  RAISE NOTICE 'ROLES_REPORT search_extensions_in=% default_privilege_rules_of_other_roles=% public_may_connect=% public_may_make_temp_tables=%',
    CASE WHEN cardinality(ext_ns) = 0 THEN 'public-or-absent' ELSE array_to_string(ext_ns, ',') END,
    (SELECT count(*) FROM pg_default_acl),
    EXISTS (SELECT 1 FROM pg_database d WHERE d.datname = current_database() AND (d.datacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(d.datacl) x WHERE x.grantee = 0 AND x.privilege_type = 'CONNECT'))),
    EXISTS (SELECT 1 FROM pg_database d WHERE d.datname = current_database() AND (d.datacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(d.datacl) x WHERE x.grantee = 0 AND x.privilege_type = 'TEMPORARY')));

  IF cardinality(drift) > 0 THEN
    FOREACH line IN ARRAY drift LOOP
      RAISE WARNING 'ROLES_DRIFT %', line;
    END LOOP;
    RAISE EXCEPTION 'ROLES_DRIFT % line(s): what the logins can do is not what the rule writes. Nothing was changed', cardinality(drift);
  END IF;
  RAISE NOTICE 'ROLES_OK migrator=% bypass=migrator-only deadlines=%', migrator, (
    SELECT string_agg(replace(want.rolname, 'ohmail_', '') || ' ' ||
             CASE WHEN l.oid IS NULL THEN 'absent'
                  ELSE (SELECT count(*) FROM jsonb_each_text(deadlines) w
                         WHERE EXISTS (SELECT 1 FROM pg_db_role_setting st CROSS JOIN LATERAL unnest(st.setconfig) AS kv
                                        WHERE st.setrole = l.oid AND st.setdatabase = 0 AND kv = w.key || '=' || w.value || 'ms'))
                       || '/' || (SELECT count(*) FROM jsonb_object_keys(deadlines)) END, ' ' ORDER BY want.ord)
      FROM unnest(deadline_roles) WITH ORDINALITY AS want(rolname, ord)
      LEFT JOIN pg_roles l ON l.rolname = want.rolname);
END $$;

-- @commit
COMMIT;
