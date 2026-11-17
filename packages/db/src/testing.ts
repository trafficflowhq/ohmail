import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { drizzle as drizzleSqliteProxy } from "drizzle-orm/sqlite-proxy";
import postgres from "postgres";
import { JOURNALS, runMigrations } from "./migrate.js";
import { schema } from "./schema.js";
import { assertDistinct, brandDialect, deliverLocalNotifyAtCommit } from "./dialect/index.js";
import { migrateSqlite } from "./sqlite-migrate.js";
import { ACCOUNT_NAMED_BY_EVERY_INSERT } from "./account-scope.js";
import { probedService, serviceAddressOf, serviceUp } from "./test-services.js";
import { isProtocolOpener } from "./pg-socket.js";
import { BINDER_SQL } from "./bound.js";
import {
  declaredMigrations, journalMismatch, keyInputs, migrateFresh, templateDisabled, templatedPglite, templateKey,
  type AppliedRow,
} from "./testing-template.js";

export { declaredMigrations } from "./testing-template.js";
export {
  SERVICE_VERDICT_ENV, TEST_SERVICES, probedService, readServiceVerdict, serviceAddressOf, serviceUp,
  type ServiceName, type ServiceProbe, type ServiceVerdict,
} from "./test-services.js";

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
  // The template IS that sequence, run once per journal state and verified on load; see
  // `testing-template.ts`. `OHMAIL_PGLITE_TEMPLATE=0` is a person asking for the replay itself.
  if (templateDisabled()) {
    const client = new PGlite();
    await migrateFresh(client);
    return brandDialect(drizzle(client, { schema }), "pg");
  }
  return brandDialect(drizzle(await templatedPglite(), { schema }), "pg");
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

  // A WRITER THAT DOES NOT NAME THE ACCOUNT IS LOUD HERE TOO. On a server the column is NOT NULL
  // (mail 0201). On a device it is nullable, because a NOT NULL there is a rebuild of the table, so
  // a writer that forgot it would store a row no account-scoped read finds, and say nothing. This
  // TEST store refuses such an insert as a server does, which holds every writer a test drives on
  // it to the rule. A device's own store carries no such trigger.
  for (const table of ACCOUNT_NAMED_BY_EVERY_INSERT) {
    raw.exec(`CREATE TRIGGER "${table}_account_named" BEFORE INSERT ON "${table}" WHEN NEW."account_id" IS NULL
      BEGIN SELECT RAISE(ABORT, '${table}.account_id is not named by this insert'); END`);
  }

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
  // Wrapped as the device composition wraps it, so an announcement made in a transaction here
  // is delivered at commit and not at the call — see `deliverLocalNotifyAtCommit`.
  return brandDialect(deliverLocalNotifyAtCommit(db), "sqlite") as unknown as PgliteDatabase<typeof schema>;
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
  const root = workspaceRoot();
  if (root === null) return null;
  try {
    const line = readFileSync(join(root, ".lane-db.env"), "utf8")
      .split("\n").map((l) => l.trim()).find((l) => l.startsWith("PG_TEST_URL="));
    return line ? line.slice("PG_TEST_URL=".length).trim() || null : null;
  } catch { return null; }
}

/** The workspace this module was loaded from: the directory holding `pnpm-workspace.yaml`, or, in
 *  the published tree (npm workspaces, no pnpm file), the `package.json` that declares `workspaces`. */
function workspaceRoot(): string | null {
  return workspaceRootFrom(dirname(fileURLToPath(import.meta.url)));
}

/** {@link workspaceRoot}'s walk from any directory, five levels up at most; `null` when none is found. */
export function workspaceRootFrom(start: string): string | null {
  let dir = start;
  for (let up = 0; up < 5; up++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml")) || declaresWorkspaces(join(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  return null;
}

function declaresWorkspaces(manifest: string): boolean {
  try { return Array.isArray((JSON.parse(readFileSync(manifest, "utf8")) as { workspaces?: unknown }).workspaces); } catch { return false; }
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

/** The shared box's database. The freeze runs on it; a checkout with its own lane database does not. */
const SHARED_BOX_DB = "trafficflow_test";
/** Set to `1` by the freeze and by any runner that deliberately drives the shared box under the lock. */
export const FREEZE_ENV = "OHMAIL_FREEZE";

/**
 * THE SHARED BOX IS FOR THE FREEZE ONLY — as a check rather than as a sentence in a document.
 *
 * On 2026-09-12, 67 of 101 worktrees carried no `.lane-db.env`, so their `*.pg.test.ts` files all
 * ran against `trafficflow_test` and, with it, against its ADVISORY KEYS: a leader-lock case in one
 * checkout read `worker-live` because another checkout's run held the key. That is not flakiness,
 * it is two runs sharing one namespace, and the green it produces is meaningless in both.
 *
 * So a run that resolves to the shared box refuses BY NAME unless it says it is the freeze. The
 * remedy is one line and it is in the message. Returns the refusal sentence, or null when this run
 * may proceed.
 */
export function sharedBoxRefusal(
  url: string, env: NodeJS.ProcessEnv, worktree = "\"$PWD\"", tokenPath: string = BOX_TOKEN_PATH,
): string | null {
  if (databaseOf(url) !== SHARED_BOX_DB) return null;
  if (env[FREEZE_ENV] === "1") { const why = boxDoorVerdict(env, tokenPath); return why === null ? null : boxDoorRefusal(why); }
  return (
    `this run resolved to the SHARED box database (${SHARED_BOX_DB}) and no ${FREEZE_ENV}=1 was set. ` +
    "Co-tenants on that database share its advisory keys, so a leader-lock or lease case here reads " +
    "another checkout's state and the green means nothing. Give this checkout its own database — " +
    `bash scripts/lane-db.sh ${worktree} — or set OHMAIL_FREEZE=1 if this really is the freeze run.`
  );
}

/** Exported by `box-lock.sh` to the command it runs while it holds the Postgres lock. */
export const BOX_TOKEN_ENV = "OHMAIL_BOX_TOKEN";
/** Where `box-lock.sh` writes that token for the REAL pg lock. A test hands a fixture path in as a
 *  parameter; nothing in the environment moves it, so a fixture lock directory cannot admit the box. */
export const BOX_TOKEN_PATH = "/tmp/ohmail-pg.token";

/**
 * OHMAIL_FREEZE=1 IS A CLAIM, AND THE DOOR VOUCHES FOR IT. A run once set it beside a bare
 * `flock` while another run held the box's priority claim, which only `box-lock.sh` honours, and
 * this harness admitted it on the flag alone. The door writes a random token to
 * {@link BOX_TOKEN_PATH} inside the real lock and exports it; the shared box is admitted only when
 * the two agree, so a run that did not come through the door — or came through a fixture door
 * under BOX_LOCK_DIR — is refused.
 */
export function boxDoorHeld(env: NodeJS.ProcessEnv, tokenPath: string = BOX_TOKEN_PATH): boolean {
  return boxDoorVerdict(env, tokenPath) === null;
}

/**
 * Why the door's token does not license this run, or `null` when it does. A matching token is not
 * enough: a SIGKILLed door never removes its file, and the 0600 file is readable by every lane on this
 * one user (BOX-TOKEN-OUTLIVES-A-KILLED-DOOR). So a process in THIS run's own
 * ancestor chain must hold the FLOCK on `ohmail-pg.lock` beside the token: /proc/locks names it and it
 * still holds a descriptor on that inode. The resource is read, never `kill -0`. The token file stays
 * one line, which is all a harness from before this rule compares.
 */
function boxDoorVerdict(env: NodeJS.ProcessEnv, tokenPath: string): string | null {
  const token = env[BOX_TOKEN_ENV];
  if (!token || !/^[0-9a-f]{32}$/.test(token)) return `no ${BOX_TOKEN_ENV} was handed to this run`;
  let text: string;
  try { text = readFileSync(tokenPath, "utf8"); } catch { return `there is no token file at ${tokenPath}`; }
  if (text.trim() !== token) return `${BOX_TOKEN_ENV} does not match the token at ${tokenPath}`;
  const lock = join(dirname(tokenPath), "ohmail-pg.lock");
  let dev: bigint, ino: bigint;
  try { ({ dev, ino } = statSync(lock, { bigint: true })); } catch { return `there is no lock file at ${lock}`; }
  let locks: string;
  try { locks = readFileSync("/proc/locks", "utf8"); } catch { return "/proc/locks cannot be read, so whether the lock is held cannot be said"; }
  const holders = flockHoldersIn(locks, dev, ino);
  if (holders.length === 0) return `${lock} is not flock-held — the door that wrote the token has released it`;
  const chain = ancestorsOf(process.pid);
  if (holders.some((pid) => chain.includes(pid) && processHoldsFile(pid, dev, ino))) return null;
  return `no process in this run's ancestry holds ${lock} (held by pid ${holders.join(",")}) — the token reached a run outside the door, or the door that wrote it is gone`;
}

/** This process and every parent up to init, from /proc/<pid>/stat (the ppid follows the comm's `)`). */
function ancestorsOf(pid: number): number[] {
  const out: number[] = [];
  for (let p = pid; p > 0 && !out.includes(p) && out.length < 256;) {
    out.push(p);
    let stat: string;
    try { stat = readFileSync(`/proc/${p}/stat`, "utf8"); } catch { break; /* the parent exited: the chain ends here */ }
    p = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  }
  return out;
}

/** Does `pid` hold a descriptor open on the file `dev`/`ino`? Read from /proc/<pid>/fd; an exited
 *  or zombie process has no descriptors left, so it answers false. */
function processHoldsFile(pid: number, dev: bigint, ino: bigint): boolean {
  let fds: string[];
  try { fds = readdirSync(`/proc/${pid}/fd`); } catch { return false; }
  return fds.some((fd) => {
    try { const s = statSync(`/proc/${pid}/fd/${fd}`, { bigint: true }); return s.dev === dev && s.ino === ino; } catch { return false; }
  });
}

/** The pids a /proc/locks text names as holding a FLOCK on the file `dev`/`ino`. `dev` is a stat
 *  `st_dev`; /proc/locks prints `<major hex>:<minor hex>:<inode>`, decoded here as glibc decodes
 *  st_dev. A waiter's ` -> ` line holds nothing and is not read. */
export function flockHoldersIn(locks: string, dev: bigint, ino: bigint): number[] {
  const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & ~0xfffn);
  const minor = (dev & 0xffn) | ((dev >> 12n) & ~0xffn);
  const out: number[] = [];
  for (const l of locks.split("\n")) {
    const m = /^\d+: FLOCK\s+\S+\s+\S+\s+(\d+)\s+([0-9a-f]+):([0-9a-f]+):(\d+)\s/.exec(l);
    if (m !== null && BigInt(`0x${m[2]}`) === major && BigInt(`0x${m[3]}`) === minor && BigInt(m[4]!) === ino) out.push(Number(m[1]));
  }
  return out;
}

/* "SHARED box database" is the phrase the landing's box-collection classifier reads as NOT RUN: a
 * refusal at collection ran no case, and is never the range's red. */
function boxDoorRefusal(why: string): string {
  return (
    `${FREEZE_ENV}=1 was set for the SHARED box database, but this run did not come through the box door (${why}): no ${BOX_TOKEN_ENV} matching ` +
    "the token box-lock.sh writes while it holds the Postgres lock. A bare flock jumps the landing's and the " +
    "freeze's priority claim, which only the door honours — use box-lock.sh " +
    "(box-lock.sh pg <LANE> -- <command>), or give this checkout its own database with scripts/lane-db.sh."
  );
}

/**
 * THE URL A PG TEST FILE DIALS, taken through the refusal: {@link PG_TEST_URL}, refused by
 * {@link sharedBoxRefusal} when it names the shared box and this is not the freeze. Called at the
 * file's top level with its own `import.meta.url`, so a checkout with no lane database fails the
 * file at collection — naming it and the remedy — before any client exists, instead of running it
 * on the box unlocked. A lane database and any other URL are returned as they are.
 */
export function pgTestUrl(
  file: string, url: string = PG_TEST_URL, env: NodeJS.ProcessEnv = process.env, tokenPath: string = BOX_TOKEN_PATH,
): string {
  /* Nothing listens there (the run's probe, read from the environment handed in): no box to protect. */
  if (probedService("pg", serviceAddressOf(url, 5432), env)?.up === false) return url;
  const root = workspaceRoot();
  const refusal = sharedBoxRefusal(url, env, root ?? undefined, tokenPath);
  if (refusal === null) return url;
  let name = file;
  try { name = file.startsWith("file:") ? fileURLToPath(file) : file; } catch { /* keep it as given */ }
  if (root !== null && name.startsWith(`${root}/`)) name = name.slice(root.length + 1);
  throw new Error(`[pg] ${name}: ${refusal}`);
}

/** Set this to `1` in CI so a missing Postgres FAILS the suite instead of skipping it. */
export const REQUIRE_PG_ENV = "TF_REQUIRE_PG";

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
 * Is a real Postgres reachable — and is it ALLOWED to be missing? `*.pg.test.ts` files host the
 * assertions PGlite structurally cannot: real concurrency, `pg_trgm`, `setupProdDatabase`. They
 * degrade to `describe.skipIf` when docker is down — usable on a laptop, and the decisive cases
 * vanish silently while the run exits 0; a gate that can disappear is not a gate. Under
 * `TF_REQUIRE_PG=1` an unreachable Postgres THROWS. "Available" means THIS TREE'S schema: a
 * shared database migrated from a different tree leaves its journal ahead or disagreeing ({@link
 * journalDrift}). Not ours to drop, so the policy is REFUSAL: the sentence goes to stderr and
 * this answers false. The repair is resetting the database to this tree's journals.
 */
export async function realPgAvailable(url: string = PG_TEST_URL, tokenPath: string = BOX_TOKEN_PATH): Promise<boolean> {
  /* The run's probe first: absent answers false without dialing (and throws under TF_REQUIRE_PG). */
  const at = serviceAddressOf(url, 5432);
  const probed = probedService("pg", at, process.env);
  if (!serviceUp("pg", at).up) return false;
  /* Asked BEFORE anything dials: a refusal that arrived after the connection would already have
   * taken the shared box's advisory namespace for the length of the probe. */
  const refusal = sharedBoxRefusal(url, process.env, workspaceRoot() ?? undefined, tokenPath);
  if (refusal !== null) throw new Error(`[pg] ${refusal}`);
  const c = postgres(url, { max: 1, connect_timeout: 3, onnotice: () => {} });
  let up = false;
  let error = "";
  try {
    await c`select 1`;
    up = true;
  } catch (e) {
    // The probe's answer — REQUIRE_PG_ENV below decides whether "down" is fatal.
    up = false;
    error = e instanceof Error ? e.message : String(e);
  } finally {
    await c.end({ timeout: 2 }).catch(() => {});
  }
  /* The run's probe found it listening, so it is there and broken: red, never a skip. */
  if (!up && probed?.up === true) {
    throw new Error(`[pg] something listens at ${at} but it does not answer as Postgres for ${databaseOf(url)} (${error}) — `
      + "is the database there? bash scripts/lane-db.sh \"$PWD\" makes this checkout's own");
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
    // Captured: the failure to read is itself the drift verdict, refused in the sentence below.
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

/**
 * THE MIGRATION SETUP BUDGET — why a hook that builds a database names its own timeout.
 *
 * A `create` replays both journals, and so does the FIRST clone of each sealed template key; that
 * grows with every migration added (3.1 s from empty at load 8 when mail had 104 entries — the
 * JOURNAL is the cost). vitest's default `hookTimeout` is 10 s, and a hook that crosses it fails
 * as `Hook timed out in 10000ms` with no test name attached, which reads as a defect in the code
 * under test and is not one. The margin must beat a BUSY machine. Hooks that build indexes over
 * the database's rows (`ensureSearchExtensions`, `ensureHotPathIndexes`) use it too.
 */
export const MIGRATED_DB_SETUP_BUDGET_MS = 180_000;

/**
 * The same for the teardown. `DROP DATABASE` waits for the connections the run is still letting
 * go of, and an interrupted drop is worse than a slow one: it leaves the database INVALID, and
 * every later run on that server fails with "cannot connect to invalid database".
 */
export const MIGRATED_DB_TEARDOWN_BUDGET_MS = 120_000;

/** A database this run built and this run removes. */
export interface ThrowawayDb {
  /** The database name — printable; the URL is not. */
  readonly name: string;
  /** Its URL on the same server {@link PG_TEST_URL} names. */
  readonly url: string;
  /**
   * CREATE it, then run `migrate` against it. A throw from either drops the database before it
   * rethrows, so a refused setup leaves nothing on the cluster. Whatever `migrate` resolves to is
   * the caller's business — `setupProdDatabase` answers with a report, `runMigrations` with
   * nothing — so the handle waits for it and reads none of it.
   */
  create(migrate: (url: string) => Promise<unknown>): Promise<void>;
  /**
   * CREATE it as a clone of this tree's sealed server template ({@link cloneFromTemplate}), for a
   * file whose subject is not the migrator. A refused clone drops the database, as `create` does.
   */
  createFromTemplate(): Promise<void>;
  /**
   * Remove it. Idempotent and unconditional, so a teardown may call it when {@link create} never
   * ran, threw, or was ABANDONED by a hook timeout — the case a `finally` inside `create` cannot
   * reach, because the hook's promise is rejected while the work behind it is still in flight.
   */
  drop(): Promise<void>;
}

/** A database name is an identifier, never caller text: the value is interpolated into DDL. */
const LOGICAL_NAME = /^[a-z][a-z0-9_]{0,40}$/;

/** An admin session on the maintenance database, with the role's own deadlines cleared. */
async function adminSession(serverUrl: string = PG_TEST_URL): Promise<ReturnType<typeof postgres>> {
  const u = new URL(serverUrl);
  u.pathname = "/postgres";
  const admin = postgres(u.toString(), { max: 1, onnotice: () => { /* quiet */ } });
  // `ROLE_DEFAULT_TIMEOUTS` reaches this session, and a `statement_timeout` that interrupts the
  // DROP below is what leaves `pg_database.datconnlimit = -2` for every later run on this server.
  await admin`set statement_timeout = 0`;
  await admin`set lock_timeout = 0`;
  return admin;
}

/** `datconnlimit = -2` marks a database whose `DROP` was cut short. */
async function stateOf(admin: ReturnType<typeof postgres>, name: string): Promise<"absent" | "present" | "invalid"> {
  const rows = await admin`SELECT datconnlimit FROM pg_database WHERE datname = ${name}`;
  if (rows.length === 0) return "absent";
  return Number((rows[0] as { datconnlimit: number }).datconnlimit) === -2 ? "invalid" : "present";
}

/**
 * A THROWAWAY DATABASE for one test file, allocated without touching the server.
 *
 * The handle is made at collection time and the I/O happens in the hooks, which is what lets the
 * teardown drop a database whose setup hook timed out: the name exists before the create does.
 * Pair it with {@link MIGRATED_DB_SETUP_BUDGET_MS} on the setup hook and
 * {@link MIGRATED_DB_TEARDOWN_BUDGET_MS} on the teardown.
 */
export function throwawayDb(logical: string): ThrowawayDb {
  if (!LOGICAL_NAME.test(logical)) {
    throw new Error(`[pg] "${logical}" is not usable as a database name — lower-case, digits and _`);
  }
  const name = `${logical}_${createHash("sha256")
    .update(`${process.pid}:${Date.now()}:${Math.random()}`).digest("hex").slice(0, 12)}`;
  const u = new URL(PG_TEST_URL);
  u.pathname = `/${name}`;
  const url = u.toString();

  const removeWith = async (admin: ReturnType<typeof postgres>): Promise<void> => {
    let last: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      // FORCE terminates whatever is still attached, so the drop cannot become a hung fixture.
      try { await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); } catch (e) { last = e; /* kept for the throw after three attempts */ }
      if (await stateOf(admin, name) === "absent") return;
    }
    throw new Error(`[pg] ${name} survived three DROP attempts${last instanceof Error ? `: ${last.message}` : ""}`);
  };

  return {
    name,
    url,
    async create(migrate) {
      const admin = await adminSession();
      try {
        if (await stateOf(admin, name) !== "absent") await removeWith(admin);
        await admin.unsafe(`CREATE DATABASE "${name}"`);
      } finally {
        await admin.end({ timeout: 5 });
      }
      try {
        await migrate(url);
      } catch (e) {
        // A refused setup leaves nothing behind: the next run is not looking at this one's half-
        // built schema, and a cluster does not accumulate one database per red.
        await this.drop().catch(() => { /* the original failure is the one worth reporting */ });
        throw e;
      }
    },
    async createFromTemplate() {
      const admin = await adminSession();
      try {
        if (await stateOf(admin, name) !== "absent") await removeWith(admin);
      } finally {
        await admin.end({ timeout: 5 });
      }
      try {
        await cloneFromTemplate(PG_TEST_URL, name);
      } catch (e) {
        await this.drop().catch(() => { /* the refusal is the one worth reporting */ });
        throw e;
      }
    },
    async drop() {
      const admin = await adminSession();
      try {
        await removeWith(admin);
      } finally {
        await admin.end({ timeout: 5 });
      }
    },
  };
}

/** The database at `name` on the server `url` names, keeping host, port and credentials. */
function onServer(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

/** Both journal tables of the database at `url`, row for row against this tree, or `null`. */
export async function pgJournalMismatch(url: string): Promise<string | null> {
  const sql = postgres(url, { max: 1, onnotice: () => { /* quiet */ } });
  try {
    for (const spec of JOURNALS) {
      const table = `"${spec.migrationsSchema.replace(/"/g, '""')}"."__drizzle_migrations"`;
      const present = await sql.unsafe(`SELECT to_regclass('${table}') IS NOT NULL AS ok`);
      if (!present[0]?.ok) return `${spec.name}: no ${spec.migrationsSchema}.__drizzle_migrations table`;
      const rows = await sql.unsafe(`SELECT hash, created_at FROM ${table} ORDER BY created_at`) as unknown as AppliedRow[];
      const why = journalMismatch(spec, rows, declaredMigrations(spec.dir));
      if (why !== null) return why;
    }
    return null;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** A sealed template's name, and the only shape {@link cloneFromTemplate} will unseal or drop. */
export const PG_TEMPLATE_NAME = /^trafficflow_tpl_[0-9a-f]{16}$/;
const PG_TEMPLATE_BUILD_NAME = /^trafficflow_tplbuild_[0-9a-f]{16}_[0-9a-f]{8}$/;
/** A clone target is an identifier interpolated into DDL, and never the shared box. */
const CLONE_TARGET = /^[a-z][a-z0-9_]{0,62}$/;

/** Unseal and drop a template or a template build — the only two names this may touch. */
async function dropSealed(admin: ReturnType<typeof postgres>, name: string): Promise<void> {
  if (!PG_TEMPLATE_NAME.test(name) && !PG_TEMPLATE_BUILD_NAME.test(name)) {
    throw new Error(`[pg-template] refusing to unseal or drop "${name}": not a template this tool made`);
  }
  if (await stateOf(admin, name) === "absent") return;
  // An INVALID database (a DROP cut short) refuses ALTER; it was unsealed before that drop began.
  await admin.unsafe(`ALTER DATABASE "${name}" WITH IS_TEMPLATE false`).catch(() => { /* the DROP names it */ });
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
}

/**
 * THIS TREE'S SEALED TEMPLATE on the admin session's server, built once per key: the PGlite key
 * plus `server_version_num`. Built under a private name, verified, sealed (no connections, so
 * nothing can write into it or poison a watermark), then renamed into place; a builder that loses
 * the rename race drops its own copy and takes the winner's.
 */
async function ensurePgTemplate(
  admin: ReturnType<typeof postgres>, serverUrl: string, say: (line: string) => void, salt: readonly string[],
): Promise<string> {
  const version = String((await admin`SHOW server_version_num`)[0]?.server_version_num ?? "");
  if (!/^[0-9]+$/.test(version)) throw new Error(`[pg-template] SHOW server_version_num read "${version}"`);
  const key = templateKey({ ...keyInputs(), extra: [`server_version_num:${version}`, ...salt] });
  const tpl = `trafficflow_tpl_${key}`;
  const state = await stateOf(admin, tpl);
  if (state === "present") return tpl;
  if (state === "invalid") await dropSealed(admin, tpl);
  const build = `trafficflow_tplbuild_${key}_${createHash("sha256")
    .update(`${process.pid}:${Date.now()}:${Math.random()}`).digest("hex").slice(0, 8)}`;
  say(`[pg-template] building ${tpl} from empty (once per journal state and server version)`);
  await admin.unsafe(`CREATE DATABASE "${build}"`);
  try {
    await runMigrations(onServer(serverUrl, build));
    const why = await pgJournalMismatch(onServer(serverUrl, build));
    if (why !== null) throw new Error(`[pg-template] the build of ${tpl} does not match this tree and was not published: ${why}`);
    await admin.unsafe(`ALTER DATABASE "${build}" WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`);
    try {
      await admin.unsafe(`ALTER DATABASE "${build}" RENAME TO "${tpl}"`);
    } catch (e) {
      if (await stateOf(admin, tpl) !== "present") throw e;
    }
  } finally {
    await dropSealed(admin, build).catch(() => { /* a leftover build name is swept by its shape */ });
  }
  return tpl;
}

/** How {@link cloneFromTemplate} reports and verifies; `salt` keys a private template for a test. */
export interface CloneOptions {
  say?: (line: string) => void;
  verify?: (url: string) => Promise<string | null>;
  salt?: readonly string[];
}

/**
 * CREATE `name` from this tree's sealed template and VERIFY THE CLONE row for row. On a mismatch
 * the clone and the template are dropped and the template rebuilt once; a second mismatch throws.
 * `name` must not exist: this creates, and never drops anything it did not create in this call.
 * Resolves to the template's name.
 */
export async function cloneFromTemplate(serverUrl: string, name: string, opts: CloneOptions = {}): Promise<string> {
  const say = opts.say ?? ((l: string) => { process.stderr.write(`${l}\n`); });
  const verify = opts.verify ?? pgJournalMismatch;
  if (!CLONE_TARGET.test(name) || name === SHARED_BOX_DB || PG_TEMPLATE_NAME.test(name) || name === "postgres") {
    throw new Error(`[pg-template] "${name}" is not a database this clones into`);
  }
  const admin = await adminSession(serverUrl);
  try {
    let first: string | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const tpl = await ensurePgTemplate(admin, serverUrl, say, opts.salt ?? []);
      await admin.unsafe(`CREATE DATABASE "${name}" TEMPLATE "${tpl}"`);
      const why = await verify(onServer(serverUrl, name))
        .catch((e: unknown) => `its journals could not be read (${e instanceof Error ? e.message : String(e)})`);
      if (why === null) return tpl;
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await dropSealed(admin, tpl);
      if (first !== null) {
        throw new Error(`[pg-template] ${name}: the clone of ${tpl} failed its verify twice — first: ${first}; after the rebuild: ${why}`);
      }
      first = why;
      say(`[pg-template] the clone of ${tpl} does not match this tree (${why}); the template was dropped, rebuilding once`);
    }
    throw new Error("[pg-template] unreachable: the loop returns or throws");
  } finally {
    await admin.end({ timeout: 5 });
  }
}

/** Unseal and drop one template by name — a test's cleanup of its salted template. */
export async function dropPgTemplate(serverUrl: string, name: string): Promise<void> {
  const admin = await adminSession(serverUrl);
  try {
    await dropSealed(admin, name);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

/**
 * WHAT A STATEMENT COSTS ON THE WIRE, read off the frontend protocol bytes the driver hands its
 * socket. A statement is a Parse or a simple Query; a round trip is every message after which the
 * client waits on the server — Sync, Flush and a simple Query — so a describe before its bind is
 * two. Installed once per process over `net.Socket#write`, before the first connection it is to
 * see; a socket whose first packet is no protocol opener is not Postgres, and a TLS session is not
 * read (a lane database dials in the clear). `binds` keeps each Bind message's bytes.
 *
 * A BURST is what the client wrote on one connection before it heard from the server: the writes
 * between two receipts. It is the measure of waits, which a count of Sync and Flush is not: a
 * flight that writes begin, its statements and commit before reading an answer is one burst and
 * several round trips by that count. `burstShapes` holds each burst's message kinds.
 *
 * `lines` holds, for each connection, every statement it was sent in the order written: what
 * {@link flightsOf} walks.
 */
export interface PgWireReading {
  statements: number; roundTrips: number; flushes: string[]; binds: Buffer[];
  bursts: number; burstShapes: string[];
  /** Each Parse and simple Query message's bytes: the statements' text as written. */
  texts: Buffer[];
  /** One list per connection that wrote since `start()`: its statements in write order. */
  lines: PgWireStatement[][];
}

/**
 * One statement as a connection was sent it: a simple Query, or a Bind (one execution of a parsed
 * statement, whose text is the Parse it names: a statement prepared once by name is sent again as
 * a Bind alone). `burst` is the index, in the reading's `burstShapes`, of the burst it was written in.
 */
export interface PgWireStatement {
  readonly text: string;
  /** A Bind's parameters as written (`null`: SQL NULL); a simple Query carries none. */
  readonly params: readonly (Buffer | null)[];
  readonly burst: number;
}
export interface PgWireRecorder { start(): void; read(): PgWireReading; connections(): number }

/** What one write held, per message that is a statement: a Query's text, or a Bind's text and parameters. */
interface WireSent { readonly text: string; readonly params: readonly (Buffer | null)[] }
interface WireSeen { wrote(sock: object, kinds: string, binds: Buffer[], texts: Buffer[], sent: WireSent[]): void; heard(sock: object): void }
let wireSeen: Set<WireSeen> | null = null;
let wireOpened = 0;

/** A C string of a frontend message, from `at`: its text and where the next field starts. */
function cString(buf: Buffer, at: number): { text: string; next: number } {
  const end = buf.indexOf(0, at);
  return end === -1 ? { text: buf.toString("utf8", at), next: buf.length } : { text: buf.toString("utf8", at, end), next: end + 1 };
}

/**
 * A Bind message's statement name and parameters: the portal's name, the statement's, the format
 * codes, then each parameter as a length and its bytes (-1 is NULL).
 */
function readBind(bind: Buffer): { statement: string; params: (Buffer | null)[] } {
  const portal = cString(bind, 5);
  const statement = cString(bind, portal.next);
  let at = statement.next;
  at += 2 + bind.readInt16BE(at) * 2;
  const count = bind.readInt16BE(at);
  at += 2;
  const params: (Buffer | null)[] = [];
  for (let i = 0; i < count; i++) {
    const len = bind.readInt32BE(at);
    at += 4;
    if (len < 0) { params.push(null); continue; }
    params.push(Buffer.from(bind.subarray(at, at + len)));
    at += len;
  }
  return { statement: statement.text, params };
}

export function recordPgWire(): PgWireRecorder {
  if (wireSeen === null) {
    const seen = new Set<WireSeen>();
    wireSeen = seen;
    const state = new WeakMap<object, { buf: Buffer; opened: boolean; parsed: Map<string, string> } | "skip">();
    const emit = net.Socket.prototype.emit;
    net.Socket.prototype.emit = function (this: net.Socket, event: string | symbol, ...args: unknown[]): boolean {
      if (event === "data") {
        const st = state.get(this);
        if (st !== undefined && st !== "skip" && st.opened) for (const s of seen) s.heard(this);
      }
      return (emit as (...a: unknown[]) => boolean).apply(this, [event, ...args]);
    } as typeof emit;
    const write = net.Socket.prototype.write;
    net.Socket.prototype.write = function (this: net.Socket, chunk: unknown, ...rest: unknown[]): boolean {
      if (chunk instanceof Uint8Array) {
        let st = state.get(this);
        if (st === undefined) {
          st = isProtocolOpener(chunk) ? { buf: Buffer.alloc(0), opened: false, parsed: new Map() } : "skip";
          state.set(this, st);
        }
        if (st !== "skip") readFrontend(this, st, Buffer.from(chunk));
      }
      return (write as (...a: unknown[]) => boolean).apply(this, [chunk, ...rest]);
    } as typeof write;
    const readFrontend = (sock: object, st: { buf: Buffer; opened: boolean; parsed: Map<string, string> }, chunk: Buffer): void => {
      st.buf = st.buf.length === 0 ? chunk : Buffer.concat([st.buf, chunk]);
      let kinds = "";
      const binds: Buffer[] = [];
      const texts: Buffer[] = [];
      const sent: WireSent[] = [];
      for (;;) {
        if (!st.opened) {
          if (st.buf.length < 8 || st.buf.length < st.buf.readInt32BE(0)) break;
          if (st.buf.readInt32BE(4) === 80_877_103) { state.set(sock, "skip"); return; }
          st.buf = st.buf.subarray(st.buf.readInt32BE(0));
          st.opened = true;
          wireOpened++;
          continue;
        }
        if (st.buf.length < 5 || st.buf.length < st.buf.readInt32BE(1) + 1) break;
        const len = st.buf.readInt32BE(1);
        const kind = String.fromCharCode(st.buf[0]!);
        const message = st.buf.subarray(0, len + 1);
        if (kind === "B") binds.push(Buffer.from(message));
        if (kind === "P" || kind === "Q") texts.push(Buffer.from(message));
        // A connection's parsed statements by name (the unnamed one is ""), kept for as long as the
        // connection lives: a statement prepared before `start()` is executed after it by name alone.
        if (kind === "P") {
          const name = cString(message, 5);
          st.parsed.set(name.text, cString(message, name.next).text);
        } else if (kind === "Q") {
          sent.push({ text: cString(message, 5).text, params: [] });
        } else if (kind === "B") {
          const bind = readBind(message);
          sent.push({ text: st.parsed.get(bind.statement) ?? "", params: bind.params });
        }
        kinds += kind;
        st.buf = st.buf.subarray(len + 1);
      }
      if (kinds !== "") for (const s of seen) s.wrote(sock, kinds, binds, texts, sent);
    };
  }
  let flushes: string[] = [];
  let binds: Buffer[] = [];
  let texts: Buffer[] = [];
  let bursts: string[] = [];
  /** Per connection since `start()`: the burst it is writing, or none once the server answered. */
  let open = new WeakMap<object, number>();
  /** Per connection since `start()`: its statements in write order; `lines` holds each list once. */
  let lineOf = new WeakMap<object, PgWireStatement[]>();
  let lines: PgWireStatement[][] = [];
  wireSeen.add({
    wrote(sock, k, b, t, sent) {
      flushes.push(k);
      binds.push(...b);
      texts.push(...t);
      let at = open.get(sock);
      if (at === undefined) { at = bursts.length; open.set(sock, at); bursts.push(k); } else bursts[at] += k;
      if (sent.length === 0) return;
      let line = lineOf.get(sock);
      if (line === undefined) { line = []; lineOf.set(sock, line); lines.push(line); }
      for (const m of sent) line.push({ text: m.text, params: m.params, burst: at });
    },
    heard(sock) { open.delete(sock); },
  });
  const count = (all: string, of: string): number => [...all].filter((c) => of.includes(c)).length;
  return {
    start() { flushes = []; binds = []; texts = []; bursts = []; open = new WeakMap(); lineOf = new WeakMap(); lines = []; },
    read() {
      const all = flushes.join("");
      return {
        statements: count(all, "PQ"), roundTrips: count(all, "SHQ"), flushes: [...flushes], binds: [...binds],
        bursts: bursts.length, burstShapes: [...bursts], texts: [...texts], lines: lines.map((l) => [...l]),
      };
    },
    connections: () => wireOpened,
  };
}

/**
 * ONE FLIGHT AS THE WIRE SHOWS IT: the statements one connection was sent under one binding.
 *
 * `door` is how they were sent: `read` (a bound transaction begun read only: door one), `write`
 * (any other bound transaction: door two), `lone` (begin, the binder, one statement and commit
 * written before any answer: a statement on a bound handle), `plain` (no binder rode: a statement
 * outside any transaction, or a transaction the binder was never written in).
 *
 * `account` is what the binder named: an id, or `null` for nothing, and for a plain flight, which
 * named nothing either (its `door` tells the two apart). `keyed` says a key rode; its value is
 * answered by {@link keyEquals} alone and is on no field. What its statements were sent as
 * parameters is answered by {@link carries} alone, for the same reason.
 *
 * A transaction named again inside itself (`rebindTx`) reads as one flight per binding, in order:
 * `continues` is true on each after the first, and `closed` is set on the last alone.
 */
export interface PgWireFlight {
  readonly door: "read" | "write" | "lone" | "plain";
  readonly account: string | null;
  readonly keyed: boolean;
  /** The body's statements in the order written, without begin, the binder, a savepoint's own statements and the close. */
  readonly statements: readonly string[];
  /** How many bursts the flight was written in: its waits. */
  readonly bursts: number;
  /** How many of `statements` were written before the server had answered the flight's begin. */
  readonly ahead: number;
  /** How the transaction ended, or `null`: a statement outside one, a transaction named again after this binding, or one still open when the reading was taken. */
  readonly closed: "commit" | "rollback" | null;
  /** This flight is a transaction's next binding, after the one before it on the same connection. */
  readonly continues: boolean;
}

/** The binder's statement, for a reading a test writes by hand: {@link flightsOf} knows a binding by this text. */
export { BINDER_SQL } from "./bound.js";

/** Each flight's key, beside it and never on it: a failed expectation prints a flight, and a key is a credential's digest. */
const flightKeys = new WeakMap<PgWireFlight, string>();
/** Each flight's parameters as text, one list per statement of `statements`: beside it too, a parameter may be a digest. */
const flightParams = new WeakMap<PgWireFlight, readonly (readonly string[])[]>();

/** Did `flight`'s binder name exactly `value` as its key? False for a flight no key rode in. */
export function keyEquals(flight: PgWireFlight, value: string): boolean {
  const key = flightKeys.get(flight);
  return key !== undefined && key === value;
}

/**
 * Did a statement of `flight` carry `value` in a parameter? Asked with an id (an account's, a
 * mailbox's, a letter's) to tell whose rows a flight's statements named. A parameter that holds
 * several values (an array, a document) carries each of them. False for an empty `value`.
 */
export function carries(flight: PgWireFlight, value: string): boolean {
  if (value === "") return false;
  return (flightParams.get(flight) ?? []).some((params) => params.some((p) => p.includes(value)));
}

/** A statement's text as the walk compares it: without the space around it, a closing semicolon, or case. */
function wordsOf(text: string): string {
  let t = text.trim();
  while (t.endsWith(";")) t = t.slice(0, -1).trimEnd();
  return t.toLowerCase();
}

const startsWord = (text: string, word: string): boolean =>
  text === word || text.startsWith(`${word} `) || text.startsWith(`${word}\n`) || text.startsWith(`${word}\t`);

/**
 * THE FLIGHTS OF A READING: every statement the recorder saw, grouped as its connection was sent
 * it. One walk over each connection's statements, in the order written: `begin` opens a
 * transaction, the binder's statement (`BINDER_SQL`, by its text) names it, `commit` or `rollback`
 * closes it, and a statement outside any transaction is a plain flight of its own. A binder
 * written anywhere but inside a transaction is a statement like any other, and shows as one.
 * Flights are answered connection by connection, each connection's in the order written.
 */
export function flightsOf(reading: Pick<PgWireReading, "lines">): PgWireFlight[] {
  const out: PgWireFlight[] = [];
  interface Open {
    readOnly: boolean; bound: { account: string | null; key: string | null } | null;
    statements: string[]; params: string[][]; bursts: Set<number>; begun: number; ahead: number; continues: boolean;
  }
  const textOf = (m: PgWireStatement): string[] => m.params.map((p) => (p === null ? "" : p.toString("utf8")));
  const push = (o: Open, closed: PgWireFlight["closed"], closedIn: number | null): void => {
    const door = o.bound === null ? "plain" : closedIn === o.begun ? "lone" : o.readOnly ? "read" : "write";
    const flight: PgWireFlight = {
      door, account: o.bound?.account ?? null, keyed: o.bound !== null && o.bound.key !== null,
      statements: o.statements, bursts: o.bursts.size, ahead: o.ahead, closed, continues: o.continues,
    };
    if (o.bound !== null && o.bound.key !== null) flightKeys.set(flight, o.bound.key);
    flightParams.set(flight, o.params);
    out.push(flight);
  };
  for (const line of reading.lines) {
    let open: Open | null = null;
    for (const m of line) {
      const words = wordsOf(m.text);
      if (open === null) {
        if (startsWord(words, "begin") || startsWord(words, "start transaction")) {
          open = {
            readOnly: words.includes("read only"), bound: null, statements: [], params: [], bursts: new Set([m.burst]),
            begun: m.burst, ahead: 0, continues: false,
          };
        } else {
          const alone: PgWireFlight = { door: "plain", account: null, keyed: false, statements: [m.text], bursts: 1, ahead: 0, closed: null, continues: false };
          flightParams.set(alone, [textOf(m)]);
          out.push(alone);
        }
        continue;
      }
      open.bursts.add(m.burst);
      if (words === "commit" || words === "rollback" || words === "end" || words === "abort") {
        push(open, words === "commit" || words === "end" ? "commit" : "rollback", m.burst);
        open = null;
      } else if (m.text === BINDER_SQL && m.params.length === 2) {
        const account = m.params[0]?.toString("utf8") ?? "";
        const key = m.params[1]?.toString("utf8") ?? "";
        const bound = { account: account === "" ? null : account, key: key === "" ? null : key };
        if (open.bound === null && open.statements.length === 0) {
          open.bound = bound;
        } else {
          // Named again inside the transaction: what was sent so far ran under the binding before.
          push(open, null, null);
          open = { ...open, bound, statements: [], params: [], bursts: new Set([m.burst]), ahead: 0, continues: true };
        }
      } else if (startsWord(words, "savepoint") || startsWord(words, "rollback to") || startsWord(words, "release")) {
        // A savepoint's own statements name no table and stay inside the flight.
      } else {
        open.statements.push(m.text);
        open.params.push(textOf(m));
        if (m.burst === open.begun && !open.continues) open.ahead++;
      }
    }
    if (open !== null) push(open, null, null);
  }
  return out;
}

/**
 * A Postgres the test owns whole (`testing-own-server.ts`), and the lock's ground on it: the store
 * with the Cloud's roles, made by the real scripts (`testing-lock-ground.ts`). For a test that makes
 * or uses roles, which belong to the whole server and never to the shared one.
 */
export {
  OWN_SERVER_IMAGES, OWN_SERVER_LIFETIME_S, PG_MAJORS, dockerAnswers, ownServersAvailable, startOwnServer,
  type OwnServer, type PgMajor,
} from "./testing-own-server.js";
export { MIGRATOR_ROLE, ruleVerbs, startLockGround, type LockGround } from "./testing-lock-ground.js";
