/**
 * The Supabase Data API lockdown — the LIBRARY half, importable with no side effects.
 *
 * ── WHY THIS FILE EXISTS, SEPARATE FROM `supabase-lockdown.ts` ─────────────────────────────
 *
 * The lockdown used to live only in the CLI runner, which is a module that EXECUTES on import
 * (`void main()` at the bottom) — the exact hazard `setup-prod-cli.ts`'s header documents. That
 * left `setupProdDatabase` unable to reuse it, and so the lockdown was never wired into the one
 * idempotent provisioning path: a stock-Supabase rebuild, or a self-hoster pointing at Supabase,
 * would have shipped with the host's default `anon`/`authenticated`/`service_role` grants live
 * on every table (`messages`, `message_bodies`, `mailbox_credentials`, `users`, …), reachable
 * over PostgREST by the anon key — which is public by design. This module is the shared
 * implementation both callers import; the CLI keeps the operator ceremony (the Management-API
 * `--close-api` half, the external anon-key probe, `--prove`), and `setup-prod.ts` runs the
 * grant half on every provisioning pass and refuses to report success while the census is red.
 *
 * ── WHY THE SQL IS AN EMBEDDED CONSTANT AND NOT `readFileSync` ─────────────────────────────
 *
 * The CLI used to read `scripts/supabase-lockdown.sql` off disk, three directories up. That is
 * fine for a repo-checkout CLI and wrong for this module's other callers: `setup-prod.ts` is
 * re-exported through `@trafficflow/db/admin`, which the desktop engine BUNDLES (a bundle has no
 * `../../../scripts`) and which `apps/server` runs at every boot from whatever filesystem its
 * image carries. A lockdown that cannot find its own SQL would fail open or fail the boot for a
 * missing asset — so the statements live here, in the code that runs them.
 * `scripts/supabase-lockdown.sql` remains the annotated operator reference (it is published, and
 * other files cite its sections); `supabase-lockdown-sql-sync.test.ts` pins the two byte-for-byte
 * modulo comments, because this repository has twice paid for a copied predicate rotting alone.
 *
 * The full rationale for the statements — why REVOKE and not RLS, why both grantors' default
 * privileges, why the postconditions are scoped to reachable grantors — is in that file's
 * header and section comments and is deliberately not repeated here.
 */
import type postgresFn from "postgres";

type Sql = ReturnType<typeof postgresFn>;

/** The roles a stock Supabase project grants `public` away to. PostgREST authenticates as these. */
export const HOST_ROLES = ["anon", "authenticated", "service_role"] as const;

/**
 * Which of {@link HOST_ROLES} exist on the target — the Supabase-shape detection.
 *
 * The skip this answer licenses is safe BY CONSTRUCTION, not by assumption: the exposure this
 * lockdown closes is a privilege granted TO one of these roles, and Postgres refuses to record a
 * grant to a role that does not exist. No roles ⇒ no such grant can exist ⇒ nothing to close.
 * A plain `postgres:16` (the self-host default) has none of them; any host that HAS one of them
 * has the exposure class, whatever it calls itself, and gets the lockdown.
 */
export async function supabaseHostRoles(sql: Sql): Promise<string[]> {
  const rows = await sql<Array<{ rolname: string }>>`
    SELECT rolname FROM pg_roles WHERE rolname = ANY(${[...HOST_ROLES]}) ORDER BY rolname`;
  return rows.map((r) => r.rolname);
}

/**
 * The lockdown batch for the roles that are actually present.
 *
 * Parameterised because `REVOKE … FROM a, b, c` is an ERROR when any one of the names does not
 * exist: a host carrying only SOME of the roles (not a shape Supabase produces, but one a
 * self-hoster could) must have the present ones revoked rather than the whole batch dying on the
 * absent ones. The §3 postconditions stay pinned to the full triple — an absent role cannot hold
 * a grant, so it can never fail the check falsely, and a present-but-undetected one must.
 *
 * `roles` is validated against {@link HOST_ROLES} — this function interpolates into SQL, and the
 * closed allowlist is what makes that safe.
 */
export function lockdownSqlFor(roles: readonly string[]): string {
  if (roles.length === 0) {
    throw new Error("lockdownSqlFor: no roles — the caller must skip, not lock down nothing");
  }
  for (const r of roles) {
    if (!(HOST_ROLES as readonly string[]).includes(r)) {
      throw new Error(`lockdownSqlFor: '${r}' is not one of the known Supabase host roles`);
    }
  }
  const list = roles.join(", ");
  return `
BEGIN;

REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM ${list};
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${list};
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM ${list};
REVOKE ALL ON ALL ROUTINES  IN SCHEMA public FROM ${list};

REVOKE ALL ON SCHEMA public FROM ${list};

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
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON %s FROM ${list}',
        grantor, objtype);
      BEGIN
        EXECUTE stmt;
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'could not revoke default privileges (% / %): %', grantor, objtype, SQLERRM;
      END;
    END LOOP;
  END LOOP;
END $$;

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
`;
}

/**
 * Run the lockdown batch. Idempotent — REVOKE of a privilege nobody holds is a no-op, and the
 * batch's own §3 postconditions abort the transaction (which surfaces here as a throw) when the
 * end state is not clean, so a caller that returns from this has a database whose OWN check
 * passed. The independent {@link lockdownCensus} afterwards is belt and braces on that, not
 * redundancy: it is the check that survives if the batch text is ever edited hollow.
 *
 * `.simple()` is LOAD-BEARING: postgres.js defaults to the extended protocol, which permits
 * exactly one statement per query, and this is a batch carrying its own BEGIN/COMMIT.
 */
export async function applySupabaseLockdown(sql: Sql, roles: readonly string[]): Promise<void> {
  await sql.unsafe(lockdownSqlFor(roles)).simple();
}

export interface LockdownCensus {
  /** Privileges granted to any host role on objects in `public`. Must be 0 after a lockdown. */
  grants: number;
  /** Default-privilege rules whose grantor this session can create objects as. Must be 0. */
  rules: number;
  /**
   * Rules under a grantor this session has no membership in (on Supabase: `supabase_admin`'s).
   * Reported, never failed on — unrevokable by us and inert unless that role itself creates a
   * table in `public`. The measurement backing that reasoning is `scripts/supabase-lockdown.sql`
   * §3 and the CLI's `--prove`.
   */
  residual: number;
  /** Up to six object names still carrying a host-role grant — the exposure, named. */
  detail: string;
}

/**
 * Count what is still granted away. The same census the CLI prints before/after, shared so the
 * two callers cannot drift about what "closed" means. `rules` counts only REACHABLE
 * default-privilege rules — the ones that govern tables OUR migrations create; the rest are
 * `residual` (see {@link LockdownCensus.residual}).
 */
export async function lockdownCensus(sql: Sql): Promise<LockdownCensus> {
  const g = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace,
           LATERAL aclexplode(c.relacl) a
     WHERE n.nspname = 'public'
       AND a.grantee::regrole::text = ANY(${[...HOST_ROLES]})`;
  const r = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n
      FROM pg_default_acl d,
           LATERAL aclexplode(d.defaclacl) a
     WHERE d.defaclnamespace = 'public'::regnamespace
       AND a.grantee::regrole::text = ANY(${[...HOST_ROLES]})
       AND pg_has_role(current_user, d.defaclrole, 'USAGE')`;
  const res = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n
      FROM pg_default_acl d,
           LATERAL aclexplode(d.defaclacl) a
     WHERE d.defaclnamespace = 'public'::regnamespace
       AND a.grantee::regrole::text = ANY(${[...HOST_ROLES]})
       AND NOT pg_has_role(current_user, d.defaclrole, 'USAGE')`;
  const d = await sql<Array<{ relname: string }>>`
    SELECT DISTINCT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace,
           LATERAL aclexplode(c.relacl) a
     WHERE n.nspname = 'public'
       AND a.grantee::regrole::text = ANY(${[...HOST_ROLES]})
     ORDER BY 1 LIMIT 6`;
  return {
    grants: g[0]!.n,
    rules: r[0]!.n,
    residual: res[0]!.n,
    detail: d.map((x) => x.relname).join(", "),
  };
}

/**
 * The census as a verdict: problem lines for `setupProdDatabase`'s fail-closed list, empty when
 * the Data API surface is closed. `residual` is deliberately not a problem — a postcondition an
 * operator can never satisfy is a wall, not a guard (the SQL header's own words).
 */
export function lockdownProblems(census: LockdownCensus): string[] {
  const problems: string[] = [];
  if (census.grants > 0) {
    problems.push(
      `supabase lockdown: ${census.grants} privileges for anon/authenticated/service_role remain ` +
        `on objects in schema public${census.detail ? ` (e.g. ${census.detail})` : ""} — ` +
        "these tables are readable through the host's Data API by the anon key, which is public",
    );
  }
  if (census.rules > 0) {
    problems.push(
      `supabase lockdown: ${census.rules} reachable default-privilege rules still grant to ` +
        "anon/authenticated/service_role — every future table this role creates would be " +
        "re-exposed at CREATE time",
    );
  }
  return problems;
}
