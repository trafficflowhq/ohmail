import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzleSqliteProxy } from "drizzle-orm/sqlite-proxy";
import postgres from "postgres";
import { adoptBaseline } from "./baseline.js";
import { JOURNALS } from "./migrate.js";
import { schema } from "./schema.js";
import { assertDistinct, brandDialect } from "./dialect/index.js";
import { migrateSqlite } from "./sqlite-migrate.js";

/**
 * Create an in-process PGlite-backed Drizzle client with all migrations applied. Tests only — no
 * external DB, no network; each call yields a fresh, isolated in-memory database. It runs the
 * SAME sequence production does — adopt, mail, cloud, in {@link JOURNALS} order — so the whole
 * suite exercises the two-journal path rather than a test-only shortcut. Adoption is always a
 * no-op here (a brand-new PGlite database hits the `fresh` cell of the truth table) and is still
 * called rather than skipped: a code path only production takes is a code path nothing checks.
 */
export async function makeTestDb(): Promise<PgliteDatabase<typeof schema>> {
  if (process.env[TEST_DIALECT_ENV] === "sqlite") return makeSqliteTestDb();
  const client = new PGlite();
  const db = brandDialect(drizzle(client, { schema }), "pg");
  for (const spec of JOURNALS) {
    await adoptBaseline(db, spec);
    await migrate(db, { migrationsFolder: spec.dir, migrationsSchema: spec.migrationsSchema });
  }
  return db;
}

/**
 * WHICH STORE THE SUITE RUNS AGAINST — and the reason this is an environment variable read in
 * exactly one place.
 *
 * The matrix is two runs of the same files. Nothing else may branch on it: a test that asks which
 * dialect it is on is a test that has stopped checking the thing both stores must do.
 */
export const TEST_DIALECT_ENV = "OHMAIL_TEST_DIALECT";

/**
 * The same schema, on SQLite, through the binding a device uses. ONE connection, serialized — the
 * concurrency model, not a convenience: it is what makes the store's absent row locks safe, and a
 * harness that quietly allowed two overlapping statements would be testing a program the device
 * cannot run; a second connection to the same file does not contend, it fails outright. The one
 * cast lives here rather than in every caller: callers are typed against the server's handle,
 * because that is what the services are typed against and the whole point is that neither changes
 * for the other store. The substitution happens once, where the reason can be written down — not
 * at three thousand call sites.
 */
async function makeSqliteTestDb(): Promise<PgliteDatabase<typeof schema>> {
  // Reached through `createRequire` because the bundler this suite runs under does not yet know
  // this module is a builtin and resolves the bare name to a package that is not there.
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
    DatabaseSync: new (path: string) => {
      exec(sql: string): void;
      prepare(sql: string): {
        all(...p: unknown[]): unknown[];
        run(...p: unknown[]): unknown;
        columns?(): { column?: string | null; name?: string }[];
      };
    };
  };
  const raw = new DatabaseSync(":memory:");
  // The capability check and `PRAGMA foreign_keys` are the migrator's, not this factory's — see
  // `migrateSqlite`. A factory that does them itself is a factory the NEXT factory does not copy.
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(job: () => T): Promise<T> => {
    const next = tail.then(job, job);
    tail = next.catch(() => {});
    return next;
  };

  await migrateSqlite({
    run: (statement) => serial(() => { raw.exec(statement); }),
    all: <T,>(statement: string) => serial(() => raw.prepare(statement).all() as T[]),
  });

  const db = drizzleSqliteProxy(async (query, params, method) => {
    return serial(() => {
      if (method === "run") { raw.prepare(query).run(...(params as never[])); return { rows: [] }; }
      // ORDERED BY THE STATEMENT'S COLUMNS, never by the row object's keys — see the note on the
      // server arm's `exec`: integer-like aliases enumerate numerically and silently reorder.
      const statement = raw.prepare(query);
      const order = statement.columns?.().map((c) => c.name ?? c.column ?? "") ?? null;
      // THE SAME REFUSAL THE SERVER ARM MAKES, for the same reason and one step earlier. Rows come
      // back from this driver as objects too, so two columns of one name collapse to a single key
      // and BOTH positions would be filled from it — a row of the right length carrying the wrong
      // value, which is worse than a short one. The server arm refuses; without this the two arms
      // disagree about a statement neither can answer.
      if (order !== null) assertDistinct(order);
      const raws = statement.all(...(params as never[])) as Record<string, unknown>[];
      const rows = order === null
        ? raws.map((r) => Object.values(r))
        : raws.map((r) => order.map((name) => r[name]));
      return { rows: method === "get" ? (rows[0] ?? []) : rows };
    });
  });
  return brandDialect(db, "sqlite") as unknown as PgliteDatabase<typeof schema>;
}

/** The database name in a URL — what a diagnostic may print, where the URL itself may not. */
function databaseOf(url: string): string {
  try { return new URL(url).pathname.replace(/^\//, ""); } catch { return "?"; }
}

/**
 * THIS WORKTREE'S OWN DATABASE, when `scripts/lane-db.sh` has made one.
 *
 * `<repo root>/.lane-db.env` holds `PG_TEST_URL=` for a database only this checkout uses, and it
 * WINS over the environment: box files in a worktree that has one run without the Postgres lock, so
 * a stray `DATABASE_URL_*` redirecting them onto the shared `trafficflow_test` is exactly the
 * unlocked-shared-write this removes. A worktree without the file resolves as it always has. The
 * root is the directory holding `pnpm-workspace.yaml` — one walk up from `src` or `dist` alike.
 */
function laneDbUrl(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 5; up++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      try {
        const line = readFileSync(join(dir, ".lane-db.env"), "utf8")
          .split("\n").map((l) => l.trim()).find((l) => l.startsWith("PG_TEST_URL="));
        return line ? line.slice("PG_TEST_URL=".length).trim() || null : null;
      } catch { return null; }
    }
    dir = dirname(dir);
  }
  return null;
}

/** The lane database if there is one, else the environment, else the compose service on :5433. */
export function pgTestUrlFrom(env: NodeJS.ProcessEnv, lane: string | null): string {
  const envUrl = env.DATABASE_URL_PG_TEST ?? env.DATABASE_URL_SESSION ?? env.DATABASE_URL;
  if (lane === null) return envUrl ?? "postgres://tf:tf@localhost:5433/trafficflow_test";
  if (envUrl !== undefined && databaseOf(envUrl) !== databaseOf(lane)) {
    process.stderr.write(
      `[pg] this worktree has a lane database (${databaseOf(lane)}); ignoring the environment's ` +
        `${databaseOf(envUrl)}. Remove it with scripts/lane-db.sh --drop to use the shared box.\n`,
    );
  }
  return lane;
}

/** The real-Postgres URL every `*.pg.test.ts` uses: this worktree's lane database, or the box. */
export const PG_TEST_URL = pgTestUrlFrom(process.env, laneDbUrl());

/** Set this to `1` in CI so a missing Postgres FAILS the suite instead of skipping it. */
export const REQUIRE_PG_ENV = "TF_REQUIRE_PG";

/** One applied row of a journal table: the migration's stamp and the sha256 the migrator stored. */
interface AppliedRow { hash: string; created_at: string | number }

/**
 * `when` → sha256 of the migration file, for every migration this tree declares.
 *
 * The hash is exactly what the migrator writes into a journal table's `hash` column, so a
 * comparison against it needs nothing but the file on disk.
 */
function declaredMigrations(dir: string): Map<number, string> {
  const journal = JSON.parse(
    readFileSync(join(dir, "meta", "_journal.json"), "utf8"),
  ) as { entries: Array<{ when: number; tag: string }> };
  const out = new Map<number, string>();
  for (const e of journal.entries) {
    const sql = readFileSync(join(dir, `${e.tag}.sql`));
    out.set(Number(e.when), createHash("sha256").update(sql).digest("hex"));
  }
  return out;
}

/** The first twelve hex characters of a stored hash — enough to tell two apart in a sentence. */
function shortHash(h: string): string {
  return String(h).slice(0, 12);
}

/**
 * Is this database's schema the one THIS TREE declares? A sentence naming the drift, or `null`.
 * The migrator replays only migrations stamped strictly AFTER the latest recorded `when`, with
 * two silent consequences: a migration EDITED IN PLACE never runs its new statements (measured: a
 * shared test database sat on the pre-amendment version for weeks), and a database carrying a
 * HIGHER stamp records every new migration as applied WITHOUT RUNNING IT. So drift is DETECTED:
 * every applied row must match a declared migration, on `when` AND the file's sha256. Merely
 * BEHIND is not drift — the migrator fixes that itself. This answers the question, not the
 * policy: a per-file database is dropped and rebuilt; a shared one is REFUSED.
 */
export async function journalDrift(url: string): Promise<string | null> {
  const sql = postgres(url, { max: 1, onnotice: () => { /* quiet */ } });
  try {
    for (const spec of JOURNALS) {
      // The schema name comes from this repository's own spec table, never from caller input; the
      // identifier is quoted regardless so a spec rename can never become an injection.
      const table = `"${spec.migrationsSchema.replace(/"/g, '""')}"."__drizzle_migrations"`;
      const present = await sql.unsafe(`SELECT to_regclass('${table}') IS NOT NULL AS ok`);
      if (!present[0]?.ok) continue;                       // never migrated: not drift
      const rows = await sql.unsafe(
        `SELECT hash, created_at FROM ${table} ORDER BY created_at`,
      ) as unknown as AppliedRow[];
      const declared = declaredMigrations(spec.dir);
      if (declared.size === 0) {
        return `${spec.name}: this tree declares no migrations at all, so nothing this database `
          + "records can be matched against it";
      }
      const treeMax = Math.max(...declared.keys());
      for (const r of rows) {
        const want = declared.get(Number(r.created_at));
        if (want === undefined) {
          return `${spec.name}: this database records a migration applied at ${r.created_at} `
            + `(hash ${shortHash(r.hash)}) that this tree does not declare. This tree's own `
            + `latest ${spec.name} migration is ${treeMax}, which is BELOW it — so every `
            + "migration this tree adds would be recorded here as applied WITHOUT RUNNING, "
            + "because the migrator applies only a stamp strictly after the latest one recorded, "
            + "and raises nothing when it skips one.";
        }
        if (want !== r.hash) {
          return `${spec.name}: the migration applied at ${r.created_at} has been edited since it `
            + `ran here (this database recorded hash ${shortHash(r.hash)}, this tree's file `
            + `hashes to ${shortHash(want)}). Its stamp is already recorded, so the file's `
            + `current statements will never run on this database. This tree's latest `
            + `${spec.name} migration is ${treeMax}.`;
        }
      }
    }
    return null;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Is a real Postgres reachable — and is it ALLOWED to be missing?
 *
 * `*.pg.test.ts` files host the assertions PGlite structurally cannot: real concurrency across
 * separate connections, `pg_trgm`, and `setupProdDatabase` itself. They have always degraded to
 * `describe.skipIf` when docker was not running, which keeps the suite usable on a laptop — and
 * which also means the decisive cases can vanish silently and the run still exits 0. A gate that
 * can disappear is not a gate.
 *
 * So the skip is now a LOCAL convenience with an explicit opt-out: with
 * `TF_REQUIRE_PG=1` (what `pnpm test:pg` and CI set) an unreachable Postgres THROWS here, and the
 * file fails loudly instead of quietly not running. `pnpm test` on a laptop behaves exactly as
 * before.
 *
 * ── AND "AVAILABLE" MEANS THIS TREE'S SCHEMA, NOT MERELY A SERVER THAT ANSWERS ─────────────
 *
 * The database this reaches is long-lived and SHARED by every `*.pg.test.ts` in the workspace.
 * A run that migrated it from a different tree leaves its journal ahead of, or disagreeing with,
 * the migrations declared here — and from then on {@link journalDrift} explains exactly what
 * that costs: this tree's own migrations get recorded as applied without ever running, so the
 * files below assert against columns and constraints that are not there. The failures land on
 * whatever each test was about, name the wrong component, and survive every re-run.
 *
 * A shared database is not ours to drop, so the policy here is REFUSAL rather than repair: the
 * sentence goes to stderr and this answers false, which turns every dependent file into a
 * skip-with-a-reason instead of a suite full of reds that belong to nobody. Under
 * `TF_REQUIRE_PG=1` it throws for the same reason an unreachable server does — a gate that can
 * disappear in CI is not a gate.
 *
 * The repair is to reset that database to this tree's journals and run again.
 */
export async function realPgAvailable(url: string = PG_TEST_URL): Promise<boolean> {
  const c = postgres(url, { max: 1, connect_timeout: 3, onnotice: () => {} });
  let up = false;
  try {
    await c`select 1`;
    up = true;
  } catch {
    up = false;
  } finally {
    await c.end({ timeout: 2 }).catch(() => {});
  }
  if (!up && process.env[REQUIRE_PG_ENV] === "1") {
    throw new Error(
      `${REQUIRE_PG_ENV}=1 but no Postgres is reachable at ${new URL(url).host} — ` +
        "start it (docker compose up -d) or unset the variable. These tests are not optional in CI.",
    );
  }
  if (!up) return false;

  /* AN UNREADABLE PREMISE IS NOT A GREEN, so the catch does not answer `true`.
   *
   * {@link journalDrift} answers the question or fails; it never invents an answer. If the
   * journal tables cannot be read — a permission the test role has lost, a column renamed out
   * from under the query — then whether this database's schema is this tree's is UNKNOWN, which
   * is neither drift nor its absence. Admitting there would admit exactly the run this exists to
   * refuse, and the failures would land on whatever the tests were about. So an unreadable
   * journal is refused too, in a sentence that says which of the two it is. */
  let drift: string | null;
  try {
    drift = await journalDrift(url);
  } catch (e) {
    drift = `its migration journals could not be read at all (${e instanceof Error ? e.message : String(e)}), `
      + "so whether its schema is this tree's is unknown — neither drift nor its absence.";
  }
  if (drift === null) return true;
  const sentence =
    `the database at ${new URL(url).host}${new URL(url).pathname} is not this tree's schema — `
    + `${drift} Reset it to this tree's journals before running these tests; nothing was measured.`;
  process.stderr.write(`[pg] refusing this database: ${sentence}\n`);
  if (process.env[REQUIRE_PG_ENV] === "1") throw new Error(`${REQUIRE_PG_ENV}=1 and ${sentence}`);
  return false;
}
