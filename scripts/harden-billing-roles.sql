-- ─────────────────────────────────────────────────────────────────────────────────────────
-- HARD PREREQUISITE BEFORE BILLING GOES LIVE.
--
-- Run against the production database, by hand, after `pnpm db:setup:prod` has applied 0018 and
-- BEFORE the first real subscription exists. It is not a migration on purpose: migrations are
-- environment-agnostic and must not carry role names or a specific deployment's identity.
--
-- ## The gap it closes
--
-- `credit_ledger` is protected by `credit_ledger_append_only`, and the ledger/balance agreement
-- by the deferred `*_coupled` constraint triggers. Both are ordinary user triggers, and a table
-- OWNER can switch them off:
--
--     ALTER TABLE credit_ledger DISABLE TRIGGER credit_ledger_append_only;   -- owner: allowed
--
-- Before this runs, the application connects as the role that OWNS every table it touches. So
-- until this script has run, "the money trail cannot be rewritten" means "cannot be rewritten
-- by ACCIDENT": a wrong admin tool fails loudly, a determined or buggy piece of application
-- code does not. That is a materially weaker claim than the schema comments imply, and it is
-- worth exactly one afternoon to fix properly.
--
-- ## What it does
--
-- Splits the single identity into two:
--
--   • `ohmail_migrator` — owns the schema, runs migrations, may DDL. Used ONLY by
--     `pnpm db:setup:prod` and by a human at a psql prompt. Its credential does not live in
--     any deployed environment.
--   • `ohmail_runtime`  — what the API and the worker connect as. No DDL anywhere, therefore
--     no `ALTER TABLE … DISABLE TRIGGER`, therefore no way to switch the guards off. Ordinary
--     DML on the application tables, and on the money tables only what the primitives need.
--
-- Trigger ownership is the load-bearing part: `ALTER TABLE … DISABLE TRIGGER` requires table
-- ownership, and `ohmail_runtime` owns nothing.
--
-- ## Afterwards
--
--   DATABASE_URL / DATABASE_URL_SESSION  → ohmail_runtime
--   db:setup:prod, db:backup:prod        → ohmail_migrator
--
-- and re-verify: connect as `ohmail_runtime` and confirm the DISABLE below is refused.
-- ─────────────────────────────────────────────────────────────────────────────────────────

BEGIN;

-- 1. The two roles. Set real passwords out of band; never commit them.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ohmail_migrator') THEN
    CREATE ROLE ohmail_migrator LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ohmail_runtime') THEN
    CREATE ROLE ohmail_runtime LOGIN;
  END IF;
END $$;

-- 2. The migrator owns the schema and everything in it.
ALTER SCHEMA public OWNER TO ohmail_migrator;
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO ohmail_migrator', t);
  END LOOP;
  FOR t IN SELECT sequencename FROM pg_sequences WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER SEQUENCE public.%I OWNER TO ohmail_migrator', t);
  END LOOP;
END $$;

-- 3. The runtime gets USAGE and DML — and no ownership, so no DDL and no DISABLE TRIGGER.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO ohmail_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ohmail_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ohmail_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE ohmail_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ohmail_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE ohmail_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO ohmail_runtime;

-- 4. The money tables, narrowed to exactly what the primitives do.
--    `credit_ledger` is append-only for the runtime at the PRIVILEGE level as well as the
--    trigger level — two independent mechanisms, and this one the runtime cannot touch.
REVOKE UPDATE, DELETE, TRUNCATE ON public.credit_ledger FROM ohmail_runtime;
GRANT SELECT, INSERT ON public.credit_ledger TO ohmail_runtime;
--    `credit_balances` is read/insert/update but never deleted: a balance row is only ever
--    created and moved, and its history lives in the ledger.
REVOKE DELETE, TRUNCATE ON public.credit_balances FROM ohmail_runtime;

COMMIT;

-- ── VERIFY (as ohmail_runtime; every one of these must be REFUSED) ────────────────────────
--   ALTER TABLE credit_ledger DISABLE TRIGGER credit_ledger_append_only;   -- must fail: not owner
--   ALTER TABLE credit_ledger DISABLE TRIGGER ALL;                         -- must fail: not owner
--   UPDATE credit_ledger SET delta = 0 WHERE true;                         -- must fail: no privilege
--   DELETE FROM credit_ledger;                                             -- must fail: no privilege
--   TRUNCATE credit_ledger;                                                -- must fail: not owner
-- and these must SUCCEED:
--   INSERT INTO credit_ledger (...) VALUES (...);   -- inside a transaction that also moves the balance
--   SELECT * FROM credit_balances;
