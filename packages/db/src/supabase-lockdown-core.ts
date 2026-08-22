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
 * implementation both callers import: the GRANT half (the REVOKE batch and the census) and, at
 * the bottom of the file, the DATA API half (the Management-API endpoint close, and the external
 * anon-key probe that is the only real verdict). `setup-prod.ts` runs both on every provisioning
 * pass and refuses to report success while either is red; the CLI keeps what only an operator
 * ceremony can do — the before/after narration and `--prove`.
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
  /**
   * Table privileges a host role can EXERCISE on a `public` relation, however it comes by them
   * — directly, through a role it is a member of, or via a grant to PUBLIC. Must be 0.
   *
   * This is the arm the other three cannot cover: `grants` matches the ACL's GRANTEE, so a
   * `GRANT api_reader TO anon` plus a grant to `api_reader` never shows a host role in any ACL
   * while PostgREST running as `anon` reads the table through inheritance. Not a shape stock
   * Supabase produces — it takes an operator-made membership — but the census exists to be the
   * fail-closed verdict, and a verdict that is blind to what the role can DO is not one.
   * `has_table_privilege` answers capability, not bookkeeping. Probed only for roles that
   * exist, over ordinary/partitioned tables, views and matviews in `public`.
   */
  effective: number;
  /** Up to six object names still carrying a host-role grant — the exposure, named. */
  detail: string;
  /** Up to six relation names a host role can still EFFECTIVELY reach — the exposure, named. */
  effectiveDetail: string;
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
  // Capability, not bookkeeping — see {@link LockdownCensus.effective}. The role list comes
  // from pg_roles so an absent role is never probed (has_table_privilege throws on one), and
  // the privilege list is the table-privilege set PostgREST could exercise.
  const eff = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n
      FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
      CROSS JOIN (SELECT rolname FROM pg_roles WHERE rolname = ANY(${[...HOST_ROLES]})) r
      CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p(priv)
     WHERE ns.nspname = 'public'
       AND c.relkind IN ('r', 'p', 'v', 'm')
       AND has_table_privilege(r.rolname, c.oid, p.priv)`;
  const effD = await sql<Array<{ relname: string }>>`
    SELECT DISTINCT c.relname
      FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
      CROSS JOIN (SELECT rolname FROM pg_roles WHERE rolname = ANY(${[...HOST_ROLES]})) r
     WHERE ns.nspname = 'public'
       AND c.relkind IN ('r', 'p', 'v', 'm')
       AND has_table_privilege(r.rolname, c.oid, 'SELECT')
     ORDER BY 1 LIMIT 6`;
  return {
    grants: g[0]!.n,
    rules: r[0]!.n,
    residual: res[0]!.n,
    effective: eff[0]!.n,
    detail: d.map((x) => x.relname).join(", "),
    effectiveDetail: effD.map((x) => x.relname).join(", "),
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
  if (census.effective > 0) {
    problems.push(
      `supabase lockdown: ${census.effective} table privileges are EFFECTIVELY reachable by ` +
        "anon/authenticated/service_role — directly, through a role membership, or via PUBLIC" +
        `${census.effectiveDetail ? ` (e.g. ${census.effectiveDetail})` : ""}. The lockdown ` +
        "revokes only the host roles' own grants; a membership that hands them another role's " +
        "privileges is deliberate operator configuration and must be removed by hand",
    );
  }
  return problems;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE DATA API HALF — the endpoint, and the verdict from OUTSIDE
   ══════════════════════════════════════════════════════════════════════════════════════════

   Everything above is the DATABASE half: it proves the ACLs are gone. It does NOT prove the
   product is safe, and treating it as though it did is exactly the mistake that let the
   exposure ship in the first place — a stock project granted `anon` full `arwdDxtm` on all 55
   tables and served them over PostgREST while two internal checks read clean, because one
   tested `grantee = 0` and the other measured the admin role, and `anon` is neither.

   So the verdict is a live HTTP request to `<base>/rest/v1/<table>` carrying the PUBLIC anon
   key — the actual threat model: a public key, an internet-facing endpoint, no VPN, no
   session. **A 2xx with `[]` is a FAILURE, not a pass**: an empty array means the SELECT ran
   against a table that happens to be empty, and tables are only empty until they are not.

   This lived in the operator CLI alone, so the one idempotent provisioning path could report
   OK over an open endpoint. It is library code here for the same reason the census is: two
   callers, one implementation, no drift.

   ── WHY A REFUSAL IS NOT AUTOMATICALLY A PASS ────────────────────────────────────────────

   The nastier half, measured against a live project rather than reasoned about:

     · valid anon key, endpoint closed → 404 `{"code":"PGRST205", … 'graphql_public.messages'
       … }` — PostgREST itself answering about the table;
     · JUNK key                        → 401 `{"message":"Invalid API key", …}`;
     · NO key                          → 401 `{"message":"No API key found in request", …}`.

   The last two carry no `code`, because the gateway refused before any table was consulted —
   so they are returned by an EXPOSED table and a closed one alike. A probe that counts them as
   "refused" is a green check that cannot see the case it exists to detect, which is how a
   mistyped or rotated key becomes a security sign-off. {@link classifyDataApiResponse}
   therefore treats a refusal as evidence ONLY when the body carries PostgREST's own error
   `code`; everything else — a gateway 401, a 429, a 5xx, a DNS failure — is UNKNOWN, and the
   caller fails on UNKNOWN. That same rule doubles as the probe's positive control: a
   PostgREST error body proves the key was accepted and the request reached the database. */

/**
 * Probed by name whatever the schema currently holds. Deliberately the worst cases rather than
 * a sample: message content (the very thing the isolation rules protect), envelope-encrypted
 * credentials (a decryption target), identity, the money table, and the per-account byte counter
 * behind the storage cap. The provisioning path probes the UNION of this list and every relation
 * that actually exists in `public`, so a table a migration adds is covered the day it lands and
 * a table this list still names after a rename is covered too.
 */
export const SENSITIVE_PROBE_TABLES = [
  "messages",
  "message_bodies",
  "mailbox_credentials",
  "users",
  "accounts",
  "credit_ledger",
  "account_storage",
] as const;

/** Every relation in `public` a Data API could serve — ordinary/partitioned tables, views, matviews. */
export async function publicRelationNames(sql: Sql): Promise<string[]> {
  const rows = await sql<Array<{ relname: string }>>`
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p', 'v', 'm')
     ORDER BY 1`;
  return rows.map((r) => r.relname);
}

/** Where the host's Data API lives, and the public key an attacker would use against it. */
export interface DataApiTarget {
  /** Base URL, no trailing slash — `https://<ref>.supabase.co`, or a self-hosted gateway. */
  baseUrl: string;
  /** The PUBLIC anon key. Public by design; it is the credential the threat model assumes. */
  anonKey: string;
  /** Management-API credentials. Present ⇒ the endpoint half runs (idempotent) before probing. */
  close?: { projectRef: string; accessToken: string };
}

/**
 * How a provisioning run reaches a verdict about the Data API.
 *
 * `unverifiable` is NOT a skip: it is carried into the provisioning path so the path — which is
 * the only thing that knows whether the host is Supabase-shaped — can turn it into a refusal on
 * a host that has the exposure class, and ignore it on a plain Postgres that cannot.
 */
export type DataApiPolicy =
  | { kind: "verify"; target: DataApiTarget }
  | { kind: "unverifiable"; missing: string[] };

/** Injection seams. Tests supply them; production supplies none. */
export interface DataApiDeps {
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait after an endpoint change before probing. Config changes propagate. */
  settleMs?: number;
  /** Per-request deadline, headers AND body. See {@link DATA_API_REQUEST_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Whole-probe deadline. See {@link DATA_API_PROBE_BUDGET_MS}. */
  budgetMs?: number;
}

/**
 * One request's deadline — and it is not a nicety.
 *
 * `fetch` has no application timeout, and neither does reading the body: an endpoint that
 * accepts the connection and then stalls, or dribbles an error body forever, blocks the
 * provisioning run indefinitely with a database client open. Sequential probing turns one such
 * relation into a hang of the whole command. An abort makes it what it actually is — an answer
 * that proves nothing — which the caller already fails on.
 */
export const DATA_API_REQUEST_TIMEOUT_MS = 15_000;

/**
 * The whole probe's deadline. Per-request timeouts bound each answer; this bounds their SUM,
 * because a schema with a hundred relations behind a uniformly slow endpoint is a long hang made
 * of short ones. Relations left unprobed when it expires are reported as UNKNOWN — never
 * silently dropped, which would make the verdict cover fewer tables than it claims.
 */
export const DATA_API_PROBE_BUDGET_MS = 120_000;

/** The env names the provisioning CLI reads for {@link dataApiPolicyFromEnv}. */
export const DATA_API_ENV = {
  projectRef: "SUPABASE_PROJECT_REF",
  baseUrl: "SUPABASE_DATA_API_URL",
  anonKey: "SUPABASE_ANON_KEY",
  accessToken: "SUPABASE_ACCESS_TOKEN",
} as const;

export interface DataApiProbeResult {
  /** The base URL probed — named in the report so a verdict states which endpoint it is about. */
  endpoint: string;
  /** Relations probed, in request order. An EMPTY list is a vacuous verdict, not a pass. */
  probed: string[];
  /** Relations that ANSWERED — `name (HTTP 200)`. Any entry is a live exposure. */
  exposed: string[];
  /** Relations whose answer proves nothing — gateway refusal, rate limit, 5xx, network error. */
  unknown: string[];
}

export type DataApiVerdict = "exposed" | "refused" | "unknown";

/**
 * The error codes that prove a RELATION-level refusal — an ALLOWLIST, because the fail-closed
 * direction of a mistake here is a false failure and the other direction is a false sign-off.
 *
 * The distinction the list encodes: PostgREST answers some errors BEFORE it ever resolves the
 * relation. Its `PGRST3xx` family is exactly that — JWT/authentication failures — so an expired
 * or malformed key gets the same 401 from an EXPOSED table as from a closed one, which is the
 * gateway hazard one layer in. Only these codes mean "the request reached the relation and was
 * turned away":
 *
 *   · `42501`    — Postgres: permission denied for the relation (the lockdown working);
 *   · `42P01`    — Postgres: the relation does not exist;
 *   · `3F000`    — Postgres: the schema does not exist;
 *   · `PGRST205` — the table is not in the exposed schema cache (the endpoint half working);
 *   · `PGRST106` — the requested schema is not exposed at all.
 *
 * Anything else with a code — including a PostgREST code this list has not met — is UNKNOWN, and
 * the caller fails on UNKNOWN. A new refusal code costs one failed provisioning run and a line
 * here; a new code silently read as a refusal costs a world-readable database.
 */
export const RELATION_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "42501", "42P01", "3F000", "PGRST205", "PGRST106",
]);

/** PostgREST's own error `code`, or `null` when the body is not one of its error payloads. */
function postgrestErrorCode(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const code = (parsed as { code?: unknown }).code;
      if (typeof code === "string" && code.length > 0) return code;
    }
  } catch {
    /* not JSON — the gateway's HTML error pages land here, and they prove nothing */
  }
  return null;
}

/**
 * The classification, and the whole safety property of this probe. See the block comment above
 * for the measurements: only a PostgREST error body counts as a refusal, because only it proves
 * the request was refused BY THE DATABASE rather than by the key check in front of it.
 */
export function classifyDataApiResponse(
  status: number,
  body: string,
): { verdict: DataApiVerdict; note: string } {
  if (status >= 200 && status < 300) {
    // No softening for an empty array: the SELECT ran.
    return { verdict: "exposed", note: `HTTP ${status}` };
  }
  const code = postgrestErrorCode(body);
  if (code && RELATION_REFUSAL_CODES.has(code) && (status === 401 || status === 403 || status === 404)) {
    return { verdict: "refused", note: `HTTP ${status} ${code}` };
  }
  if (code) {
    // Notably a `PGRST3xx` — an authentication failure raised before the relation was resolved,
    // which an exposed table answers identically. See {@link RELATION_REFUSAL_CODES}.
    return {
      verdict: "unknown",
      note: `HTTP ${status} ${code} — not a relation-level refusal`,
    };
  }
  return {
    verdict: "unknown",
    note: `HTTP ${status} with no PostgREST error code — refused before any table was consulted`,
  };
}

/**
 * Probe each relation with the public key. SEQUENTIAL on purpose: a 429 is UNKNOWN and
 * therefore a failure, so firing sixty requests at once buys a rate limit and no information.
 */
export async function probeDataApi(
  target: DataApiTarget,
  tables: readonly string[],
  deps: DataApiDeps = {},
): Promise<DataApiProbeResult> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? DATA_API_REQUEST_TIMEOUT_MS;
  const budgetMs = deps.budgetMs ?? DATA_API_PROBE_BUDGET_MS;
  const deadline = Date.now() + budgetMs;
  const exposed: string[] = [];
  const unknown: string[] = [];
  for (const table of tables) {
    if (Date.now() >= deadline) {
      // Reported, not dropped: a verdict that quietly covers fewer relations than it names is
      // the vacuous-pass shape this whole module is built against.
      unknown.push(`${table} (not probed: the ${budgetMs}ms probe budget was exhausted)`);
      continue;
    }
    let status: number;
    let body: string;
    try {
      // One signal for the whole exchange — it aborts a stalled body read as well as a stalled
      // response, which is the half a headers-only timeout would miss.
      const res = await doFetch(
        `${target.baseUrl}/rest/v1/${encodeURIComponent(table)}?select=*&limit=1`,
        {
          headers: { apikey: target.anonKey, Authorization: `Bearer ${target.anonKey}` },
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
      status = res.status;
      // A 2xx body is rows; we do not read or log them. Everything else is an error payload,
      // and its shape is the evidence.
      body = status >= 200 && status < 300 ? "" : await res.text();
    } catch (e) {
      // "The request failed so we must be safe" is how a DNS hiccup becomes a sign-off.
      const err = e as Error;
      const why = err.name === "TimeoutError" || err.name === "AbortError"
        ? `no complete answer within ${timeoutMs}ms`
        : err.message;
      unknown.push(`${table} (probe failed: ${why})`);
      continue;
    }
    const { verdict, note } = classifyDataApiResponse(status, body);
    if (verdict === "exposed") exposed.push(`${table} (${note})`);
    else if (verdict === "unknown") unknown.push(`${table} (${note})`);
  }
  return { endpoint: target.baseUrl, probed: [...tables], exposed, unknown };
}

/**
 * Drop `public` from PostgREST's exposed schemas, through the Management API. Idempotent.
 *
 * `graphql_public` is left because it exposes only the GraphQL entrypoint, not our tables — and
 * removing every schema makes the service error rather than serve nothing, which reads as an
 * outage.
 */
export async function closeDataApiEndpoint(
  close: { projectRef: string; accessToken: string },
  deps: DataApiDeps = {},
): Promise<{ ok: boolean; status: number; detail: string }> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const res = await doFetch(
    `https://api.supabase.com/v1/projects/${encodeURIComponent(close.projectRef)}/postgrest`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${close.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ db_schema: "graphql_public", db_extra_search_path: "public" }),
      // A management API that accepts the connection and stalls would otherwise hang the
      // provisioning run before it ever reached the probe.
      signal: AbortSignal.timeout(deps.timeoutMs ?? DATA_API_REQUEST_TIMEOUT_MS),
    },
  );
  // Truncated: this string reaches an operator's log, and a management API error body is
  // somebody else's prose.
  const detail = res.ok ? "" : (await res.text().catch(() => "")).slice(0, 200);
  return { ok: res.ok, status: res.status, detail };
}

/**
 * The probe as a verdict: problem lines for the provisioning path's fail-closed list, empty only
 * when relations were actually probed and every one of them was refused BY POSTGREST.
 */
export function dataApiProblems(result: DataApiProbeResult): string[] {
  const problems: string[] = [];
  if (result.probed.length === 0) {
    problems.push(
      `supabase data API: the probe of ${result.endpoint} covered NO relations, so its clean ` +
        "result is vacuous — a verdict about nothing is not a verdict",
    );
  }
  if (result.exposed.length > 0) {
    problems.push(
      `supabase data API: ${result.exposed.length} relation(s) ANSWERED the public anon key at ` +
        `${result.endpoint} — ${result.exposed.join("; ")}. A 200 with an empty array is a ` +
        "FAILURE, not a pass: the SELECT ran, and the tables are empty only until they are not",
    );
  }
  if (result.unknown.length > 0) {
    problems.push(
      `supabase data API: ${result.unknown.length} relation(s) gave no usable answer at ` +
        `${result.endpoint} — ${result.unknown.join("; ")}. An unreachable endpoint, a rate ` +
        "limit, or a key the gateway rejected before any table was consulted cannot tell an " +
        "exposed table from a closed one, so it is not a pass",
    );
  }
  return problems;
}

/**
 * Does a project ref name the database that was just provisioned?
 *
 * This is the hole a clean probe would otherwise leave wide open: point `SUPABASE_PROJECT_REF`
 * at a DIFFERENT project — a stale value in a shell, a copied line from another deployment — and
 * every relation comes back refused, because that project's endpoint really is closed. The run
 * then prints a verdict about a database nobody provisioned, and with a management token in the
 * environment it also rewrites that project's configuration. It is the same class of mistake
 * {@link assertExpectedHost} exists for on the SQL side, one connection over.
 *
 * A hosted project's ref appears in the connection string in both shapes the platform issues:
 * `db.<ref>.supabase.co` puts it in the host, and the session pooler puts it in the USER
 * (`postgres.<ref>@…pooler…`), which is the shape production uses — so the check reads both.
 *
 * COMPONENT-EXACT, never a substring: a role named `migrator_<other-ref>` or a host like
 * `<other-ref>-backup.example.com` would satisfy a substring test for a project this database
 * has nothing to do with, which is the check certifying the mistake it exists to catch. The ref
 * has to BE one of the dot-separated components.
 */
export function dataApiTargetProblem(
  dbUrl: string,
  ref: string,
  what = "the endpoint",
): string | null {
  const r = ref.trim().toLowerCase();
  if (!r) return null;
  let u: URL;
  try {
    u = new URL(dbUrl);
  } catch {
    return `supabase data API: the database URL is not parseable, so nothing can confirm that ` +
      `${what} for project '${ref}' belongs to it`;
  }
  let user = u.username;
  try {
    user = decodeURIComponent(u.username);
  } catch {
    /* a stray % in a role name — compare the raw form rather than give up */
  }
  const components = [
    ...u.hostname.toLowerCase().split("."),
    ...user.toLowerCase().split("."),
  ];
  if (components.includes(r)) return null;
  return (
    `supabase data API: the database at '${u.hostname}' does not name project '${ref}' in its ` +
    `host or its user, so ${what} would be a verdict about — or a change to — a DIFFERENT ` +
    `project. Set ${DATA_API_ENV.baseUrl} to the endpoint that fronts THIS database if the two ` +
    "really are related"
  );
}

/** The `<ref>` of a hosted Data API URL, or `null` for a self-hosted gateway or custom domain. */
export function hostedProjectRef(baseUrl: string): string | null {
  try {
    const m = /^([a-z0-9-]{1,63})\.supabase\.co$/i.exec(new URL(baseUrl).hostname);
    return m ? m[1]!.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Every project this run would touch, checked against the database it is provisioning.
 *
 * Two of them, and the second is the one a narrower check missed: the endpoint about to be
 * PROBED (identifiable whenever the base URL is a hosted one, however it was configured — a
 * ref-derived URL and an explicitly stated hosted URL are the same fact), and the project whose
 * configuration the endpoint half would REWRITE, which is always identified by a ref and must
 * therefore always be checkable. An explicit URL made the first check defer; it never licensed
 * a PATCH of a project the database does not name.
 *
 * A base URL that is not hosted — a self-hosted gateway, a custom domain — cannot be tied to a
 * database from here without knowing the operator's topology. That case yields no problem and
 * no evidence either: see {@link dataApiBindingUnprovable}, whose caller says so out loud.
 */
export function dataApiBindingProblems(dbUrl: string, target: DataApiTarget): string[] {
  const urlRef = hostedProjectRef(target.baseUrl);
  const closeRef = target.close?.projectRef.trim().toLowerCase() ?? null;
  const roles = new Map<string, string>();
  if (urlRef) roles.set(urlRef, "the endpoint about to be probed");
  if (closeRef) {
    roles.set(
      closeRef,
      roles.has(closeRef)
        ? "the endpoint about to be probed, whose configuration would also be rewritten"
        : "the project whose Data API configuration would be rewritten",
    );
  }
  const problems: string[] = [];
  for (const [ref, what] of roles) {
    const p = dataApiTargetProblem(dbUrl, ref, what);
    if (p) problems.push(p);
  }
  return problems;
}

/** True when nothing about this target can be tied to a database — the operator's word alone. */
export function dataApiBindingUnprovable(target: DataApiTarget): boolean {
  return hostedProjectRef(target.baseUrl) === null && !target.close;
}

/** The refusal when a Supabase-shaped host was provisioned with no way to check its endpoint. */
export function dataApiUnverifiedProblem(missing: readonly string[]): string {
  return (
    "supabase data API: this host has anon/authenticated/service_role roles, so it has the Data " +
    `API exposure class, and nothing here could check it from outside — ${missing.join(", ")} ` +
    `not set. Set ${DATA_API_ENV.projectRef} (or ${DATA_API_ENV.baseUrl} for a self-hosted ` +
    `gateway) and ${DATA_API_ENV.anonKey}; the anon key is public by design. The in-database ` +
    "census is not a verdict about a hosted endpoint"
  );
}

/**
 * Build the policy from the environment. The Management-API token is OPTIONAL: without it the
 * run verifies but cannot close, which is the right shape for an operator who has the public key
 * and not the admin one.
 */
export function dataApiPolicyFromEnv(
  env: Record<string, string | undefined>,
): DataApiPolicy {
  const ref = (env[DATA_API_ENV.projectRef] ?? "").trim();
  const explicit = (env[DATA_API_ENV.baseUrl] ?? "").trim();
  const anonKey = (env[DATA_API_ENV.anonKey] ?? "").trim();
  const accessToken = (env[DATA_API_ENV.accessToken] ?? "").trim();

  const missing: string[] = [];
  let baseUrl = "";
  if (explicit) {
    let parsed: URL | null = null;
    try {
      parsed = new URL(explicit);
    } catch {
      parsed = null;
    }
    if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
      missing.push(`${DATA_API_ENV.baseUrl} (not a parseable http(s) URL)`);
    } else {
      baseUrl = explicit.replace(/\/+$/, "");
    }
  } else if (ref) {
    baseUrl = `https://${ref}.supabase.co`;
  } else {
    missing.push(`${DATA_API_ENV.projectRef}/${DATA_API_ENV.baseUrl}`);
  }
  if (!anonKey) missing.push(DATA_API_ENV.anonKey);

  if (missing.length > 0 || !baseUrl) return { kind: "unverifiable", missing };
  return {
    kind: "verify",
    target: {
      baseUrl,
      anonKey,
      // The endpoint half needs the project ref specifically — the Management API addresses
      // projects by ref, so a self-hosted base URL alone cannot drive it.
      close: ref && accessToken ? { projectRef: ref, accessToken } : undefined,
    },
  };
}
