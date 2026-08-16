import { sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { readJournalOf, type JournalEntry, type JournalSpec } from "./baseline.js";
import { onNotice } from "./notices.js";
import { runMigrations, JOURNALS } from "./migrate.js";
import { ensureSearchExtensions } from "./search-setup.js";
import { transactionPoolerReason, sessionUrlRejection } from "./session-url.js";

/**
 * The ONE idempotent production database setup.
 *
 * `runMigrations` replays the two journals only. `pg_trgm` and the two trigram
 * GIN indexes come from {@link ensureSearchExtensions}, which is DELIBERATELY outside
 * the migrator because `makeTestDb()` replays the journal into PGlite and PGlite has no
 * `pg_trgm` (see `search-setup.ts`). The consequence: provision a real
 * database with the migrator alone and the FUZZY arm of hybrid search is dead in
 * production while every single test stays green. Nothing in the migrator can catch
 * that, so the two steps are welded together here and the result is VERIFIED rather
 * than assumed:
 *
 *   1. every journal entry of BOTH journals applied (entry-by-entry, per journal, addressed
 *      by pinned migrations table — never by count and never by name; see the pinning note below),
 *   2. `pg_trgm` installed,
 *   3. both trigram GIN indexes present,
 *   4. a real fuzzy computation answers (typo → high similarity), so the operator the
 *      search service uses is provably live and not merely "the extension row exists",
 *   5. the `change_log (account_id, seq)` composite index exists — `events.ts` runs
 *      `max(seq) WHERE account_id` every `pollMs` on every open client.
 *
 * Both halves are idempotent (`migrate` skips applied entries, `ensureSearchExtensions`
 * is `IF NOT EXISTS` throughout), so re-running is a no-op that re-verifies.
 *
 * ── WHY THE MIGRATIONS TABLES ARE PINNED AND NOT DISCOVERED ──
 *
 * This file used to resolve `__drizzle_migrations` by NAME —
 * `order by (table_schema = 'drizzle') desc limit 1` — because the table has lived in `public`
 * in older versions. After the stage-3 journal split that resolver made the whole verification
 * VACUOUSLY TRUE, in both directions:
 *
 *  · Every split entry keeps its ORIGINAL `when`, so the legacy table's 24 rows are a
 *    **superset of both new journals' whens**. The name resolver preferred schema `drizzle`,
 *    found the legacy table, and `missing = journal.filter(e => !applied.has(e.when))` came
 *    back empty **whether or not either new pass had run**. `pnpm db:setup:prod` would report
 *    `OK` against a database where NEITHER new migrations table existed.
 *  · On a FRESH database the same helper picked one of the two new schemas arbitrarily and
 *    reported a false failure for the other.
 *
 * "Green but dead" is the exact shape this file exists to prevent, so the verification path now
 * addresses `drizzle_mail.__drizzle_migrations` and `drizzle_cloud.__drizzle_migrations` by
 * PINNED identifier ({@link JournalSpec.migrationsSchema}) and reports **per journal**.
 * Name-based discovery survives in exactly one place — `findLegacyMigrationsTable` in
 * `baseline.ts` — where finding the legacy table in an unexpected schema is the entire point.
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
  /** Index whose leading columns are `(account_id, seq)` — the `change_log` PK backs it. */
  changeLogCompositeIndex: string | null;
  /** A real fuzzy computation on the live server: a typo must match, noise must not. */
  fuzzy: { typoSimilarity: number; noiseSimilarity: number; threshold: number } | null;
}

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
 * Refuse to touch a database that is not the one the operator MEANT.
 *
 * `assertSessionUrl` only rules out the pooler: every other direct Postgres URL was
 * accepted and then MIGRATED — schema DDL and `CREATE EXTENSION` — before the report ever
 * said which server had been reached. A stale `DATABASE_URL_SESSION` in a shell, a copied
 * staging string, or a `.env` from another project were all one command away from silently
 * provisioning the wrong database, and the identity was only visible AFTER the writes.
 *
 * So the CLI requires {@link PROD_DB_HOST_ENV} and compares it to the URL's hostname
 * (case-folded, exact — not a substring, so `db.example.com` cannot satisfy
 * `evil-db.example.com`). A mismatch throws BEFORE any connection is opened. The
 * programmatic entry point takes it as an option so tests and throwaway databases are
 * unaffected.
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
  opts: { log?: (msg: string) => void; expectedHost?: string } = {},
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
  try {
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
    log("ensuring search extensions (pg_trgm + trigram GIN indexes)");
    await ensureSearchExtensions(db);

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
      changeLogCompositeIndex: composite[0]?.indexname ?? null,
      fuzzy,
    };

    const problems: string[] = [...journalProblems(statuses)];
    if (!report.pgTrgm) problems.push("pg_trgm extension is NOT installed (the fuzzy search arm would be dead)");
    for (const want of TRIGRAM_INDEXES) {
      if (!report.trigramIndexes.includes(want)) problems.push(`trigram GIN index missing: ${want}`);
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
    if (problems.length > 0) {
      throw new Error(`production database setup verification FAILED:\n  - ${problems.join("\n  - ")}`);
    }
    return report;
  } finally {
    await client.end({ timeout: 5 });
  }
}
