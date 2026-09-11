import { sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { readJournalOf, type JournalEntry, type JournalSpec } from "./baseline.js";
import { onNotice } from "./notices.js";
import { runMigrations, JOURNALS } from "./migrate.js";
import { ROLE_DEFAULT_TIMEOUTS } from "./client.js";
import { ensureSearchExtensions, ensureWithheldProvenanceIndex } from "./search-setup.js";
import { ensureHotPathIndexes, HOT_PATH_INDEXES } from "./hot-path-indexes.js";
import { transactionPoolerReason, sessionUrlRejection } from "./session-url.js";
import {
  applySupabaseLockdown, closeDataApiEndpoint, dataApiBindingProblems, dataApiBindingUnprovable,
  dataApiProblems, dataApiUnverifiedProblem, lockdownCensus, lockdownProblems, probeDataApi,
  publicRelationNames, SENSITIVE_PROBE_TABLES, supabaseHostRoles,
  type DataApiDeps, type DataApiPolicy,
} from "./supabase-lockdown-core.js";

/**
 * The ONE idempotent production database setup. `runMigrations` replays the two journals only;
 * `pg_trgm` and the trigram indexes come from {@link ensureSearchExtensions}, outside the
 * migrator (PGlite has no `pg_trgm`) — provision with the migrator alone and the FUZZY arm of
 * search is dead in production while every test stays green. So the two steps are welded together
 * and VERIFIED: every journal entry applied (per journal, by pinned migrations table), `pg_trgm`
 * installed, both trigram indexes present, a real fuzzy computation answers. The migrations
 * tables are PINNED, not discovered: a name-based resolver found the legacy table — a superset of
 * both new journals' whens — and reported OK whether or not either new pass had run.
 */

/** The trigram GIN indexes {@link ensureSearchExtensions} creates — verified by name. */
export const TRIGRAM_INDEXES = [
  "messages_subject_trgm_idx",
  "messages_from_address_trgm_idx",
] as const;

/**
 * The live fuzzy probe. `typo` is a transposition of `target` and must clear the SAME
 * floor the product uses — `FUZZY_THRESHOLD = 0.3` in `SearchService` (`packages/db`
 * may not import `packages/services`, so the number is restated here, deliberately, with
 * this pointer). `noise` must FAIL against the same target: without it the probe would
 * still pass against a `word_similarity` that returned a constant, which is precisely
 * the kind of "green but dead" result this file exists to prevent.
 */
const FUZZY_PROBE = { typo: "inovice", target: "invoice", noise: "zzqqxx", threshold: 0.3 } as const;

/** What one journal's bookkeeping says about itself, AFTER a run. */
export interface JournalStatus {
  /** `mail` | `cloud`. */
  name: string;
  /** The schema its `__drizzle_migrations` table is PINNED to. */
  migrationsSchema: string;
  /** Entries shipped in this journal's `meta/_journal.json`. */
  expected: number;
  /** Rows in this journal's own migrations table. `0` also means "the table is not there". */
  applied: number;
  /** Tags this invocation applied to this journal — empty on a re-run. */
  appliedThisRun: string[];
  /** Tags this journal expects that its OWN migrations table does not record. */
  missing: string[];
}

export interface ProdSetupReport {
  serverVersion: string;
  database: string;
  /** Per journal, keyed by name — the report the pinning correction made necessary. */
  journals: JournalStatus[];
  /** Entries across BOTH journals. Kept as a headline number; `journals` is the truth. */
  migrationsExpected: number;
  /** Rows across both pinned migrations tables after the run. */
  migrationsApplied: number;
  /**
   * Journal tags applied by THIS invocation, mail then cloud (empty on a re-run — the
   * idempotency proof). Tags are unique across the two journals, so a flat list is unambiguous.
   */
  appliedThisRun: string[];
  pgTrgm: boolean;
  pgTrgmVersion: string | null;
  trigramIndexes: string[];
  /** Which of {@link HOT_PATH_INDEXES} exist, sorted — verified fail-closed below. */
  hotPathIndexes: string[];
  /** Index whose leading columns are `(account_id, seq)` — the `change_log` PK backs it. */
  changeLogCompositeIndex: string | null;
  /** A real fuzzy computation on the live server: a typo must match, noise must not. */
  fuzzy: { typoSimilarity: number; noiseSimilarity: number; threshold: number } | null;
  /**
   * The Supabase Data API lockdown, when the target is Supabase-shaped; `null` when it is a
   * plain Postgres (the self-host default), where no `anon`/`authenticated`/`service_role` role
   * exists and therefore no grant to one CAN exist — see `supabaseHostRoles` for why that skip
   * is safe by construction rather than by assumption. On a Supabase-shaped target the lockdown
   * is APPLIED (idempotently) and then verified fail-closed: a non-zero `grants` or
   * `reachableRules` joins `problems` below and the whole setup refuses to report success.
   * `residualRules` (an unreachable grantor's — `supabase_admin`'s on real Supabase) is reported
   * and never failed on; the reasoning is measured in `scripts/supabase-lockdown.sql` §3.
   */
  supabaseLockdown: {
    rolesPresent: string[];
    grants: number;
    reachableRules: number;
    residualRules: number;
    /** Table privileges a host role can EXERCISE, however derived — see `LockdownCensus.effective`. */
    effective: number;
  } | null;
  /**
   * The verdict from OUTSIDE: what the host's Data API answered to the PUBLIC anon key, after the
   * grant half ran. `null` when the host is not Supabase-shaped, or when the caller supplied no
   * {@link ProdSetupOptions.dataApi} policy — the second case is announced in the log, because a
   * database-only pass is not a verdict about a hosted endpoint. On a Supabase-shaped host with a
   * policy this is fail-closed twice over: a relation that ANSWERS joins `problems`, and so does
   * an answer that proves nothing (an unreachable endpoint, a rate limit, a key the gateway
   * rejected before any table was consulted). See `classifyDataApiResponse`.
   */
  supabaseDataApi: {
    /** The base URL probed. */
    endpoint: string;
    /** `true` when this run PATCHed the endpoint's exposed schemas; `false` when it only probed. */
    endpointClosed: boolean;
    /** Relations probed — the union of what `public` holds and the standing sensitive list. */
    probed: number;
    /** Relations that answered 2xx. Any entry is a live exposure. */
    exposed: string[];
    /** Relations whose answer proves nothing. Never a pass. */
    unknown: string[];
  } | null;
  /**
   * `ROLE_DEFAULT_TIMEOUTS` (`client.ts`) applied via `ALTER ROLE … SET …` — ROLE-ONLY, not
   * `IN DATABASE …`, which measurement showed does not reach the production transaction-mode
   * pooler even though the catalog row is correct; see the long comment where this is applied
   * for the full story — and read back from `pg_db_role_setting` (`setdatabase = 0`). `null`
   * only when the connection's own identity could not be read back (never expected in
   * practice); `verified` is per-GUC so a partial write (one ALTER succeeding, another silently
   * rejected) is visible rather than averaged away, and any `false` here joins `problems` below.
   */
  roleDefaults: {
    role: string;
    verified: Record<keyof typeof ROLE_DEFAULT_TIMEOUTS, boolean>;
  } | null;
}

/** Options for {@link setupProdDatabase}. */
export interface ProdSetupOptions {
  log?: (msg: string) => void;
  /** Hostname {@link assertExpectedHost} pins the URL to. Omitted by tests and throwaway dbs. */
  expectedHost?: string;
  /**
   * How this run reaches a verdict about the host's Data API. `pnpm db:setup:prod` ALWAYS
   * supplies one (from the environment), so the provisioning ceremony cannot end successfully
   * with the endpoint half unchecked. Library callers that omit it get the database half only,
   * announced as such.
   */
  dataApi?: DataApiPolicy;
  /** Injection seams for the HTTP half — tests supply them, production does not. */
  dataApiDeps?: DataApiDeps;
}

/** How long the endpoint half's config change is given to propagate before the probe fires. */
export const DATA_API_SETTLE_MS = 15_000;

/**
 * Read BOTH shipped journals — the authoritative list of migrations, per half, in application
 * order (mail then cloud). Paths come from {@link JOURNALS}, composed with `node:path` rather
 * than `new URL(…, import.meta.url)`, for the bundler reason documented on those constants.
 *
 * `readJournal()` (singular) is GONE on purpose. A single-journal reader is now a lie: it would
 * have to pick a half, and the caller could not tell which.
 */
export function readJournals(): Array<{ spec: JournalSpec; entries: JournalEntry[] }> {
  return JOURNALS.map((spec) => ({ spec, entries: readJournalOf(spec) }));
}

/**
 * Refuse a transaction-mode pooler URL, LOUDLY.
 *
 * `apps/worker/src/config.ts` calls the same {@link transactionPoolerReason} rather than
 * repeating the patterns, so the two hosts cannot drift about what "session URL" means. They
 * previously held the same two regexes "verbatim", which is exactly how both went stale at
 * once — see the note on that function.
 */
export function assertSessionUrl(url: string | undefined): string {
  if (!url || url.trim() === "") {
    throw new Error(
      "DATABASE_URL_SESSION is required: the DIRECT (session-mode) connection string, not the transaction pooler",
    );
  }
  const reason = transactionPoolerReason(url);
  if (reason) throw new Error(sessionUrlRejection(reason));
  return url;
}

/** The env var that PINS which endpoint `pnpm db:setup:prod` is allowed to mutate. */
export const PROD_DB_HOST_ENV = "TF_PROD_DB_HOST";

/**
 * Refuse to touch a database that is not the one the operator MEANT. `assertSessionUrl` only
 * rules out the pooler: every other direct Postgres URL was accepted and then MIGRATED before the
 * report said which server had been reached — a stale `DATABASE_URL_SESSION`, a copied staging
 * string, or another project's `.env` were one command from silently provisioning the wrong
 * database. So the CLI requires {@link PROD_DB_HOST_ENV} and compares it to the URL's hostname —
 * case-folded, exact, not a substring, so `db.example.com` cannot satisfy `evil-db.example.com`.
 * A mismatch throws BEFORE any connection is opened. The programmatic entry point takes it as an
 * option, so tests are unaffected.
 */
export function assertExpectedHost(url: string, expectedHost: string | undefined): string {
  if (!expectedHost || expectedHost.trim() === "") return url;
  let actual: string;
  try {
    actual = new URL(url).hostname.toLowerCase();
  } catch {
    throw new Error("DATABASE_URL_SESSION is not a parseable connection URL");
  }
  const want = expectedHost.trim().toLowerCase();
  if (actual !== want) {
    // Name BOTH hosts: a hostname is not a secret, and "wrong host" without which host is
    // an error an operator cannot act on. The password never appears — we print `hostname`.
    throw new Error(
      `refusing to provision: DATABASE_URL_SESSION points at '${actual}' but ${PROD_DB_HOST_ENV} pins '${want}'`,
    );
  }
  return url;
}

/** Minimal structural SQL runner, mirroring `search-setup.ts` — no schema-type coupling. */
interface SqlExecutor {
  execute(query: SQL): Promise<unknown>;
}

/** `rows` out of drizzle's postgres-js `execute` (it returns the raw row array). */
async function rows<T>(db: SqlExecutor, query: SQL): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[];
}

/**
 * A Postgres identifier, quoted the standard way: wrapped in double quotes, any embedded double
 * quote doubled. `ALTER ROLE`/`ALTER DATABASE` take an identifier where a bind parameter cannot
 * go — Postgres identifiers are never literals — so this is the guard against a role or database
 * name containing a character that would otherwise close the quoted identifier early. The names
 * passed through it here are READ BACK from `current_user`/`current_database()` a moment before
 * use, never caller input, so there is no injection surface; the quoting is a correctness
 * requirement (a role legitimately containing a `"` would otherwise break the statement), not a
 * defence against an adversarial name.
 */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * The `when` values recorded in ONE journal's own migrations table, addressed by its PINNED
 * schema. An absent table is an empty set, not a fallback to somebody else's table — see the
 * pinning note at the top of this file for what the fallback cost.
 */
async function appliedWhensOf(db: SqlExecutor, spec: JournalSpec): Promise<Set<number>> {
  const present = await rows<{ n: number | string }>(
    db,
    sql`select count(*)::int as n from information_schema.tables
         where table_schema = ${spec.migrationsSchema} and table_name = '__drizzle_migrations'`,
  );
  if (Number(present[0]?.n ?? 0) === 0) return new Set();
  const ident = sql.raw(`"${spec.migrationsSchema}"."__drizzle_migrations"`);
  const found = await rows<{ created_at: string | number }>(db, sql`select created_at from ${ident}`);
  return new Set(found.map((r) => Number(r.created_at)));
}

/** Per journal: the whens its own pinned table records. Read before AND after the run. */
export type AppliedWhens = Map<string, Set<number>>;

export async function readAppliedWhens(db: SqlExecutor): Promise<AppliedWhens> {
  const out: AppliedWhens = new Map();
  for (const spec of JOURNALS) out.set(spec.name, await appliedWhensOf(db, spec));
  return out;
}

/**
 * What each journal's OWN bookkeeping says, compared entry-by-entry against its OWN shipped
 * journal. `before` is the same map read before the run, so `appliedThisRun` states what this
 * invocation actually did.
 *
 * Exported because it is the assertion `journal-verification.pg.test.ts` bites on directly: the
 * inverse case — a database where the cloud pass did NOT run must produce a problem naming the
 * cloud journal — cannot be reached through `setupProdDatabase`, which always runs both passes.
 */
export async function journalStatuses(db: SqlExecutor, before: AppliedWhens): Promise<JournalStatus[]> {
  const out: JournalStatus[] = [];
  for (const { spec, entries } of readJournals()) {
    const applied = await appliedWhensOf(db, spec);
    const was = before.get(spec.name) ?? new Set<number>();
    out.push({
      name: spec.name,
      migrationsSchema: spec.migrationsSchema,
      expected: entries.length,
      applied: applied.size,
      appliedThisRun: entries.filter((e) => applied.has(e.when) && !was.has(e.when)).map((e) => e.tag),
      missing: entries.filter((e) => !applied.has(e.when)).map((e) => e.tag),
    });
  }
  return out;
}

/**
 * One problem line per journal that is not fully applied, NAMING the journal and its pinned
 * table. Naming the journal is the point: "migrations NOT applied: 0002_billing" leaves an
 * operator guessing which half and therefore which table to look in, and after the split the two
 * halves fail independently — mail can commit while cloud does not.
 */
export function journalProblems(statuses: readonly JournalStatus[]): string[] {
  return statuses
    .filter((s) => s.missing.length > 0)
    .map(
      (s) =>
        `${s.name} journal INCOMPLETE (${s.migrationsSchema}.__drizzle_migrations has ` +
        `${s.applied}/${s.expected}): ${s.missing.join(", ")}`,
    );
}

/**
 * Run migrations + search extensions against `url` and verify the result.
 * Throws with EVERY problem listed when verification fails — a half-provisioned
 * production database must not be reported as a success one item at a time.
 */
export async function setupProdDatabase(
  url: string,
  opts: ProdSetupOptions = {},
): Promise<ProdSetupReport> {
  const log = opts.log ?? (() => {});
  assertSessionUrl(url);
  assertExpectedHost(url, opts.expectedHost);
  const journals = readJournals();
  const expectedTotal = journals.reduce((n, j) => n + j.entries.length, 0);

  // Which migrations were already applied BEFORE this run — PER JOURNAL, out of each journal's
  // own pinned table — so the report can state what this invocation actually did, which is what
  // makes "idempotent" checkable (a second run must apply nothing to either half).
  const pre = postgres(url, { max: 1, onnotice: onNotice });
  const preDb = drizzle(pre);
  let before: AppliedWhens;
  let hostRoles: string[];
  try {
    // Neutralize the role's server-side defaults before any work on this session. Once
    // `ROLE_DEFAULT_TIMEOUTS` is applied below, EVERY future connection under this role starts
    // with a 55 s statement ceiling, a 30 s lock-wait ceiling and a 60 s idle-in-transaction
    // ceiling. `ensureWithheldProvenanceIndex` a few lines down runs a `CREATE INDEX
    // CONCURRENTLY` over the schema's largest table — exactly the multi-minute statement a
    // request-scoped default is sized to kill, and under real contention the wait to even START
    // could exceed 30 s (the first version reset only two of the three and left `lock_timeout`
    // inherited). This session and the provisioning session below must run under NO ceiling on
    // any of the three, forever, not only on the run that first sets the default.
    await pre.unsafe(`set statement_timeout = 0`);
    await pre.unsafe(`set lock_timeout = 0`);
    await pre.unsafe(`set idle_in_transaction_session_timeout = 0`);
    // IDENTITY FIRST, then mutate. The report used to name the server it had reached only
    // AFTER migrating it, which is the wrong order for a command that runs DDL: an operator
    // pointed at the wrong database found out by reading the success message. This logs
    // host / database / role / version / table count before a single statement changes
    // anything, so the wrong target is visible while it is still harmless.
    const ident = await rows<{ db: string; usr: string; version: string; tables: string | number }>(
      preDb,
      sql`select current_database() as db, current_user as usr, version() as version,
                 (select count(*) from information_schema.tables
                   where table_schema = 'public' and table_type = 'BASE TABLE') as tables`,
    );
    const id = ident[0];
    log(
      `target host=${new URL(url).hostname} database=${id?.db ?? "?"} role=${id?.usr ?? "?"} ` +
        `tables=${id?.tables ?? "?"} server=${(id?.version ?? "?").split(" ").slice(0, 2).join(" ")}`,
    );
    before = await readAppliedWhens(preDb);

    // The first lockdown pass runs BEFORE the first migration statement. Migrations commit PER
    // JOURNAL: the mail journal can land and the cloud pass throw, and a lockdown that only ran
    // after both would then never run — this invocation would exit with committed public tables
    // granted to anon behind the host's independently-running PostgREST, exposed until the
    // operator's retry. So on a Supabase-shaped host the batch is applied HERE first (it revokes
    // what exists and drops the default-privilege rules, so nothing this run creates is granted
    // away at CREATE time), and applied again after the migrations, where the census is taken.
    // The skip on plain Postgres is safe BY CONSTRUCTION: the exposure is a privilege granted TO
    // a host role, and Postgres cannot record a grant to a role that does not exist.
    hostRoles = await supabaseHostRoles(pre);
    if (hostRoles.length === 0) {
      log("supabase lockdown skipped: no anon/authenticated/service_role roles on this host (plain Postgres — no Data API to close)");
    } else {
      log(
        `supabase-shaped host (roles present: ${hostRoles.join(", ")}) — applying the Data API ` +
          "lockdown (pre-migration: existing objects and default-privilege rules, so nothing " +
          "this run creates is granted away)",
      );
      await applySupabaseLockdown(pre, hostRoles);
    }

    // Mail 0071's index, built CONCURRENTLY before the migrator can build it blocking. The
    // standing rule: a plain CREATE INDEX over the schema's largest table never runs as a journal
    // statement — it blocks writes for the length of the build, and CONCURRENTLY cannot run
    // inside the migrator's transaction. Mail 0071 carries the statement with IF NOT EXISTS, so
    // building it HERE first — on this autocommit session, without a write lock — turns the
    // journal statement into a no-op for exactly the population at risk: an existing install with
    // a large mailbox upgrading past 0071. See `ensureWithheldProvenanceIndex` for the three
    // populations and the invalid-leftover cleanup.
    log("ensuring the withheld-provenance index (concurrently, ahead of the migrator)");
    await ensureWithheldProvenanceIndex(preDb, { log: (m) => log(m) });
  } finally {
    await pre.end({ timeout: 5 });
  }

  log(
    `migrating ${expectedTotal} journal entries across ${journals.length} journals (` +
      journals.map((j) => `${j.spec.name} ${before.get(j.spec.name)?.size ?? 0}/${j.entries.length}`).join(", ") +
      " already applied)",
  );
  await runMigrations(url, { log: (m) => log(m) });

  const client = postgres(url, { max: 1, onnotice: onNotice });
  const db = drizzle(client);
  try {
    // Same reasoning as the `pre` session above: `ensureSearchExtensions` builds trigram GIN
    // indexes, and the role default this function itself installs (below) must not be able to
    // kill its own provisioning pass.
    await client.unsafe(`set statement_timeout = 0`);
    await client.unsafe(`set lock_timeout = 0`);
    await client.unsafe(`set idle_in_transaction_session_timeout = 0`);
    log("ensuring search extensions (pg_trgm + trigram GIN indexes)");
    await ensureSearchExtensions(db);

    // AFTER the migrator, not before it: these index tables the journal creates, and unlike the
    // provenance prebuild there is no journal statement to beat to the punch. Same session, so
    // the concurrent build is still outside a transaction.
    log("ensuring hot-path indexes (audit_log lookup, message eviction order)");
    await ensureHotPathIndexes(db, { log: (m) => log(m) });

    // The role-level server deadlines, applied and verified FAIL-CLOSED. Client-side startup
    // parameters are measured inert through a transaction-mode pooler, so what reaches a pooled
    // backend is a Postgres ROLE default. `current_user`/`current_database()`, never a
    // caller-supplied name: this step must configure exactly the identity this connection is
    // authenticated as. READBACK, NOT TRUST: `ALTER ROLE` reports success even when nothing
    // changed, so `pg_db_role_setting` is read back and a mismatch joins `problems`. ROLE-ONLY
    // (`setdatabase = 0`), measured: the database-scoped ALTER was correct in the catalog and
    // STILL inert through the pooler; the host's own hardened role defaults are all role-only,
    // and matching that shape reached the backend. The cost is blast radius, so the migrator and
    // the provisioning connections neutralize it on connect.
    const roleIdent = await rows<{ role: string }>(db, sql`select current_user as role`);
    const roleName = roleIdent[0]?.role ?? "";
    let roleDefaults: ProdSetupReport["roleDefaults"] = null;
    if (roleName === "") {
      log("role-level server deadlines SKIPPED: could not read back current_user");
    } else {
      log(`applying role-level server deadlines to ${roleName} (role-wide, every database)`);
      for (const [guc, ms] of Object.entries(ROLE_DEFAULT_TIMEOUTS)) {
        await client.unsafe(`alter role ${quoteIdent(roleName)} set ${guc} = '${ms}ms'`);
      }
      const settings = await rows<{ setconfig: string[] | null }>(
        db,
        sql`select rs.setconfig from pg_db_role_setting rs
              join pg_roles r on r.oid = rs.setrole
              where r.rolname = ${roleName} and rs.setdatabase = 0`,
      );
      const flat = (settings[0]?.setconfig ?? []).reduce<Record<string, string>>((acc, kv) => {
        const eq = kv.indexOf("=");
        if (eq > 0) acc[kv.slice(0, eq)] = kv.slice(eq + 1);
        return acc;
      }, {});
      roleDefaults = {
        role: roleName,
        verified: Object.fromEntries(
          Object.entries(ROLE_DEFAULT_TIMEOUTS).map(([guc, ms]) => [guc, flat[guc] === `${ms}ms`]),
        ) as Record<keyof typeof ROLE_DEFAULT_TIMEOUTS, boolean>,
      };
    }

    // The Supabase Data API lockdown's second pass, and the census that is the verdict. A stock
    // project grants every table in `public` to the host roles at CREATE time and serves them
    // over PostgREST to the anon key — a PUBLIC key. The lockdown lived only in a hand-run CLI,
    // so this function could provision a database every test called green while the whole schema
    // was world-readable. Same shape as the fuzzy arm: nothing inside the migrator can see it, so
    // it is welded in and VERIFIED — the first pass ran BEFORE the migrations; this one runs
    // after, so the census covers every table this invocation created. Both passes are
    // idempotent, and the census joins `problems`, so an open grant refuses the whole setup
    // instead of riding out under an OK report.
    let supabaseLockdown: ProdSetupReport["supabaseLockdown"] = null;
    let lockdownVerdict: Awaited<ReturnType<typeof lockdownCensus>> | null = null;
    if (hostRoles.length > 0) {
      log("re-applying the Data API lockdown (post-migration) and taking the census");
      await applySupabaseLockdown(client, hostRoles);
      lockdownVerdict = await lockdownCensus(client);
      supabaseLockdown = {
        rolesPresent: hostRoles,
        grants: lockdownVerdict.grants,
        reachableRules: lockdownVerdict.rules,
        residualRules: lockdownVerdict.residual,
        effective: lockdownVerdict.effective,
      };
      log(
        `supabase lockdown verified: ${lockdownVerdict.grants} host-role privileges, ` +
          `${lockdownVerdict.rules} reachable default-privilege rules, ` +
          `${lockdownVerdict.residual} residual, ${lockdownVerdict.effective} effectively reachable`,
      );
    }

    // And the half the census cannot see: the endpoint, probed from OUTSIDE. The census proves
    // the ACLs are gone; it does not prove the product is safe — this exposure shipped once while
    // two internal checks read clean and a public key was reading every table over the Data API.
    // So on a Supabase-shaped host the provisioning path closes the endpoint (when it holds
    // Management-API credentials) and then asks the endpoint itself, with the same public key an
    // attacker would use. A 2xx is a failure; so is an answer that proves nothing. Both join
    // `problems`. The probe runs LAST, after the census: every table this invocation created
    // exists by now and its grants are already revoked, so a 2xx is a live exposure, not a race
    // with our own migration.
    const dataApiProblemLines: string[] = [];
    let supabaseDataApi: ProdSetupReport["supabaseDataApi"] = null;
    if (hostRoles.length > 0) {
      const policy = opts.dataApi;
      if (!policy) {
        // Not a problem — this caller may be a boot path with no credentials — but never
        // silent: an operator reading a green report must be able to tell which halves ran.
        log(
          "supabase data API NOT verified from outside: this caller supplied no probe policy. " +
            "The in-database census is not a verdict about a hosted endpoint",
        );
      } else if (policy.kind === "unverifiable") {
        dataApiProblemLines.push(dataApiUnverifiedProblem(policy.missing));
      } else {
        const deps = opts.dataApiDeps ?? {};
        // Before anything is asked of the endpoint — or written to anyone's project — does
        // every project this run would touch belong to the database in front of us? A stale
        // ref probes a project nobody provisioned, comes back clean, and means nothing; with a
        // management token it also rewrites that project's Data API configuration. So a
        // mismatch stops here, before the first request leaves.
        const binding = dataApiBindingProblems(url, policy.target);
        if (binding.length > 0) {
          dataApiProblemLines.push(...binding);
          for (const b of binding) log(b);
        } else {
          if (dataApiBindingUnprovable(policy.target)) {
            // Not a problem: a self-hosted gateway or a custom domain cannot be tied to a
            // database from here. Said out loud, because the verdict below rests on it.
            log(
              `supabase data API: ${policy.target.baseUrl} names no hosted project, so that it ` +
                "fronts THIS database is the operator's statement and not something this run " +
                "verified",
            );
          }
          try {
            let endpointClosed = false;
            if (policy.target.close) {
              const closed = await closeDataApiEndpoint(policy.target.close, deps);
              log(
                `supabase data API: PATCH postgrest db_schema -> graphql_public (HTTP ${closed.status})`,
              );
              if (!closed.ok) {
                dataApiProblemLines.push(
                  `supabase data API: closing the endpoint FAILED (HTTP ${closed.status}` +
                    `${closed.detail ? `: ${closed.detail}` : ""}) — the exposed schemas are ` +
                    "whatever they were, so this run cannot claim to have closed them",
                );
              } else {
                endpointClosed = true;
                // A config change propagates; a probe fired the same instant reads the old state
                // and calls an unfixed endpoint safe. Only after a change — an unmodified
                // endpoint has nothing to settle.
                const settleMs = deps.settleMs ?? DATA_API_SETTLE_MS;
                const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
                log(`supabase data API: waiting ${settleMs}ms for the endpoint change to propagate`);
                await sleep(settleMs);
              }
            }
            // The union: every relation `public` actually holds (so a table a migration adds is
            // probed the day it lands) and the standing sensitive list (so a rename cannot
            // quietly drop `mailbox_credentials` out of the probe).
            const live = await publicRelationNames(client);
            const tables = [...new Set([...live, ...SENSITIVE_PROBE_TABLES])].sort();
            const probe = await probeDataApi(policy.target, tables, deps);
            supabaseDataApi = {
              endpoint: probe.endpoint,
              endpointClosed,
              probed: probe.probed.length,
              exposed: probe.exposed,
              unknown: probe.unknown,
            };
            log(
              `supabase data API probed ${probe.probed.length} relations at ${probe.endpoint}: ` +
                `${probe.exposed.length} answered, ${probe.unknown.length} inconclusive`,
            );
            dataApiProblemLines.push(...dataApiProblems(probe));
          } catch (e) {
            // A verification that threw is not a verification that passed.
            dataApiProblemLines.push(
              `supabase data API: the verification itself failed (${(e as Error).message}) — ` +
                "the endpoint's state is unknown, which is not a pass",
            );
          }
        }
      }
    }

    const statuses = await journalStatuses(db, before);
    const appliedThisRun = statuses.flatMap((s) => s.appliedThisRun);

    const ext = await rows<{ extversion: string }>(
      db,
      sql`select extversion from pg_extension where extname = 'pg_trgm'`,
    );
    const idx = await rows<{ indexname: string }>(
      db,
      sql`select indexname from pg_indexes where schemaname = 'public' and tablename = 'messages'
          and indexname in ('messages_subject_trgm_idx', 'messages_from_address_trgm_idx')`,
    );
    // The two `ensureHotPathIndexes` builds, read back by name. `indisvalid` as well as
    // existence: a failed CONCURRENTLY build leaves an index `pg_indexes` lists quite happily
    // and the planner refuses to use, which is the one state that would otherwise report OK.
    const hotIdx = await rows<{ indexname: string }>(
      db,
      sql`select c.relname as indexname
            from pg_index x
            join pg_class c on c.oid = x.indexrelid
            join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and x.indisvalid
             and c.relname in ('audit_log_account_action_idx', 'messages_account_date_order_idx')`,
    );
    // The composite the sync path depends on: an index on change_log whose FIRST TWO
    // key columns are (account_id, seq), in that order. Today it is the primary key's
    // backing index (`change_log_account_id_seq_pk`, migration 0002) — this asserts the
    // property rather than trusting the name, so a future schema change that drops the
    // composite PK cannot silently take the index with it.
    const composite = await rows<{ indexname: string }>(
      db,
      sql`select i.relname as indexname
          from pg_index x
          join pg_class i on i.oid = x.indexrelid
          join pg_class t on t.oid = x.indrelid
          where t.relname = 'change_log'
            and (select attname from pg_attribute where attrelid = t.oid and attnum = x.indkey[0]) = 'account_id'
            and (select attname from pg_attribute where attrelid = t.oid and attnum = x.indkey[1]) = 'seq'
          limit 1`,
    );

    let fuzzy: ProdSetupReport["fuzzy"] = null;
    if (ext.length > 0) {
      const probe = await rows<{ typo: string | number; noise: string | number }>(
        db,
        sql`select word_similarity(${FUZZY_PROBE.typo}, ${FUZZY_PROBE.target}) as typo,
                   word_similarity(${FUZZY_PROBE.noise}, ${FUZZY_PROBE.target}) as noise`,
      );
      const p = probe[0];
      if (p) {
        fuzzy = {
          typoSimilarity: Number(p.typo),
          noiseSimilarity: Number(p.noise),
          threshold: FUZZY_PROBE.threshold,
        };
      }
    }

    const meta = await rows<{ version: string; db: string }>(
      db,
      sql`select version() as version, current_database() as db`,
    );

    const report: ProdSetupReport = {
      serverVersion: meta[0]?.version ?? "unknown",
      database: meta[0]?.db ?? "unknown",
      journals: statuses,
      migrationsExpected: expectedTotal,
      migrationsApplied: statuses.reduce((n, s) => n + s.applied, 0),
      appliedThisRun,
      pgTrgm: ext.length > 0,
      pgTrgmVersion: ext[0]?.extversion ?? null,
      trigramIndexes: idx.map((r) => r.indexname).sort(),
      hotPathIndexes: hotIdx.map((r) => r.indexname).sort(),
      changeLogCompositeIndex: composite[0]?.indexname ?? null,
      fuzzy,
      supabaseLockdown,
      supabaseDataApi,
      roleDefaults,
    };

    const problems: string[] = [...journalProblems(statuses)];
    if (lockdownVerdict) {
      // Fail closed on a Supabase-shaped target: an open grant after the lockdown ran is a
      // world-readable schema, and this function must not say OK over one. The verdict carries
      // the census's `detail`, so a failure NAMES the exposed tables.
      problems.push(...lockdownProblems(lockdownVerdict));
    }
    // The endpoint half's verdict, on the same fail-closed list as the grant half's.
    problems.push(...dataApiProblemLines);
    if (!report.pgTrgm) problems.push("pg_trgm extension is NOT installed (the fuzzy search arm would be dead)");
    for (const want of TRIGRAM_INDEXES) {
      if (!report.trigramIndexes.includes(want)) problems.push(`trigram GIN index missing: ${want}`);
    }
    for (const want of HOT_PATH_INDEXES) {
      if (!report.hotPathIndexes.includes(want)) {
        problems.push(`hot-path index missing or INVALID: ${want}`);
      }
    }
    if (report.pgTrgm) {
      const f = report.fuzzy;
      if (!f) {
        problems.push("pg_trgm is installed but word_similarity() returned no row");
      } else if (f.typoSimilarity < f.threshold) {
        problems.push(
          `fuzzy probe failed: word_similarity('${FUZZY_PROBE.typo}','${FUZZY_PROBE.target}') = ` +
            `${f.typoSimilarity} < ${f.threshold} (the typo arm would miss)`,
        );
      } else if (f.noiseSimilarity >= f.threshold) {
        problems.push(
          `fuzzy probe is not discriminating: word_similarity('${FUZZY_PROBE.noise}',` +
            `'${FUZZY_PROBE.target}') = ${f.noiseSimilarity} >= ${f.threshold}`,
        );
      }
    }
    if (!report.changeLogCompositeIndex) {
      problems.push("no change_log index leading with (account_id, seq) — the /events poll would seq-scan");
    }
    // FAIL-CLOSED, not a warning: a role default that did not actually land is a 504 family with
    // no evidence, since nothing else reads or reports it. See ROLE_DEFAULT_TIMEOUTS' docblock.
    if (!roleDefaults) {
      problems.push("role-level server deadlines were not applied — current_user/current_database() unreadable");
    } else {
      for (const [guc, ok] of Object.entries(roleDefaults.verified)) {
        if (!ok) problems.push(`role-level server deadline did not take: ${guc} on ${roleDefaults.role}`);
      }
    }
    if (problems.length > 0) {
      throw new Error(`production database setup verification FAILED:\n  - ${problems.join("\n  - ")}`);
    }
    return report;
  } finally {
    await client.end({ timeout: 5 });
  }
}
