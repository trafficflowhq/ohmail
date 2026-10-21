#!/usr/bin/env node
/**
 * A PRIVATE POSTGRES DATABASE PER WORKTREE — from the base URL, cloned from the sealed template. One shared
 * `trafficflow_test` serialises every box run behind `/tmp/ohmail-pg.lock`, and its watermark belongs to
 * whichever lane migrated last: drizzle applies only a `when` above the latest recorded, so a lower
 * migration is recorded as applied WITHOUT RUNNING. This answers about the WORKTREE IT IS GIVEN.
 *   lane-db.sh <worktree>              create or reuse, write <worktree>/.lane-db.env (dialling as tf_l_<key>)
 *   lane-db.sh --check <worktree>      does the database that file NAMES still exist? read only
 *   lane-db.sh --drop <worktree>       drop it, its worker databases, its tf_l_ role and the file
 *   lane-db.sh --drop --name <db>      drop one named lane database and its worker databases
 *   lane-db.sh --list-invalid | --list-legacy [--root <dir>]...   INVALID databases | env files dialling as tf; read only */
/* A DROP MIGRATES NOTHING, so it does not need the tree it is about — everything else here does,
 * and the premise check below says so. Refusing a drop whose worktree is already gone is how a
 * database is orphaned on the box for ever. */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { invalidDbReading } from "./lib/invalid-dbs.mjs";

export const LANE_DB_PREFIX = "trafficflow_l_";
export const LANE_DB_ENV_FILE = ".lane-db.env";
export const LANE_DB_NAME_RE = /^trafficflow_l_[0-9a-f]{12}$/;
/** What `isolatedDbName` makes of a `trafficflow_worker_*` logical name plus a checkout key. */
export const WORKER_DB_NAME_RE = /^trafficflow_worker_.+_([0-9a-f]{12})$/;

/**
 * The database name for one worktree: the first 12 hex of sha256 over its ABSOLUTE path.
 *
 * The path is what tells two checkouts of the same branch apart, and the prefix is what keeps the
 * name out of every other namespace on this server — `trafficflow_test`, the worker's
 * `trafficflow_worker_*`, and the pg twins' own `tf_*` / `ohmail_adopt_*` databases.
 */
export function laneDbName(worktreePath) {
  return LANE_DB_PREFIX + createHash("sha256").update(resolve(worktreePath)).digest("hex").slice(0, 12);
}

/** A name this tool may create or drop. Anything else — `trafficflow_test` above all — is refused. */
export function assertLaneDbName(name) {
  if (!LANE_DB_NAME_RE.test(name)) {
    throw new Error(
      `refusing to touch "${name}": this tool creates and drops ${LANE_DB_PREFIX}<12 hex> and ` +
        "nothing else. The shared trafficflow_test is not a lane database.",
    );
  }
  return name;
}

/* THE LANE ROLE. A lane dials its database as tf_l_<the database's 12
 * hex>, never as tf: setupProdDatabase ALTERs the role it connects as, role-wide, and run as tf that
 * reached every connection on the box. Only box maintenance (CREATE/DROP DATABASE, templates) dials as
 * tf. The role is a SUPERUSER (the pg+cluster files create databases and superuser roles), so it is
 * made on the local :5433 box only. */
export const LANE_ROLE_PREFIX = "tf_l_";
export const LANE_ROLE_RE = /^tf_l_[0-9a-f]{12}$/;
export const BOX_ROLE = "tf";
export const BOX_PORT = "5433";
export const THROWAWAY_PORT_ENV = "OHMAIL_LANE_DB_THROWAWAY_PORT";
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const TEMPLATE_DB_RE = /^trafficflow_tpl(?:build)?_[0-9a-f]{16}(?:_[0-9a-f]{8})?$/;
const LANE_PASSWORD_RE = /^[0-9a-f]{32}$/;

/** The role a lane database is dialled as: its own twelve hex, so a drop names exactly one role. */
export function laneRoleOf(dbName) {
  return LANE_ROLE_PREFIX + assertLaneDbName(dbName).slice(LANE_DB_PREFIX.length);
}

/** A role this tool may create, alter or drop. tf above all is refused. */
export function assertLaneRoleName(role) {
  if (!LANE_ROLE_RE.test(role)) {
    throw new Error(`refusing to touch role "${role}": this tool makes and drops ${LANE_ROLE_PREFIX}<12 hex> and nothing else`);
  }
  return role;
}

/** Superuser roles are made on the local :5433 box only; a throwaway port is admitted by name. */
export function laneRoleHostVerdict(url, env = {}) {
  const u = new URL(url);
  const port = u.port || "5432";
  if (!LOOPBACK.has(u.hostname)) return { ok: false, say: `REFUSED: ${u.hostname} is not this host — a superuser lane role is made on the local box only` };
  if (port === BOX_PORT) return { ok: true, say: `local box ${u.hostname}:${port}` };
  if (env[THROWAWAY_PORT_ENV] === port) return { ok: true, say: `throwaway ${u.hostname}:${port} (${THROWAWAY_PORT_ENV})` };
  return { ok: false, say: `REFUSED: port ${port} is not the box's ${BOX_PORT}; a throwaway server is named by ${THROWAWAY_PORT_ENV}=${port}` };
}

/** The lane URL: the box's host and database, the lane role's credentials. */
export function laneUrl(baseUrl, dbName, password) {
  if (!LANE_PASSWORD_RE.test(password)) throw new Error("a lane role password is 32 hex");
  const u = new URL(withDatabase(baseUrl, dbName));
  u.username = laneRoleOf(dbName);
  u.password = password;
  return u.toString();
}

/** The password an existing env file already carries for this role, so a reuse keeps it. */
export function keptPassword(envText, role) {
  const url = envText ? parseLaneEnv(envText) : null;
  if (!url) return null;
  const u = new URL(url);
  const pw = decodeURIComponent(u.password);
  return decodeURIComponent(u.username) === role && LANE_PASSWORD_RE.test(pw) ? pw : null;
}

/** The deadline keys a role carries, per scope — what `up` resets on the lane role. */
export function deadlineKeysOf(rows) {
  const out = [];
  for (const r of rows) for (const kv of r.setconfig ?? []) {
    const key = kv.split("=")[0];
    if (/_timeout$/.test(key)) out.push({ key, db: r.setdatabase === 0 ? null : r.datname });
  }
  return out;
}

/* THE DROP'S ROLE SELECTOR. After the lane database and its worker databases are gone, a template
 * the role built is handed to the box role (OWNER TO; nothing about tf itself changes) and anything
 * else it owns KEEPS the role, by name. A role whose name is not the dropped database's key is
 * refused before any of it. */
export function laneRoleDropPlan({ dbName, role, owned }) {
  if (role !== laneRoleOf(dbName)) throw new Error(`refusing to drop role "${role}": ${dbName}'s role is ${laneRoleOf(dbName)}`);
  assertLaneRoleName(role);
  const handOver = owned.filter((d) => TEMPLATE_DB_RE.test(d));
  const blocking = owned.filter((d) => !TEMPLATE_DB_RE.test(d));
  return { handOver, blocking, dropRole: blocking.length === 0 };
}

/**
 * The worker's per-file databases belonging to a set of checkout keys.
 *
 * The PREFIX fences as much as the key does: `trafficflow_l_<key>` ends in the same twelve hex,
 * and so does any foreign database whose name happens to, so a bare suffix test selects the lane
 * database this tool is dropping and other people's twins besides. Nothing is matched that
 * `isolatedDbName` could not have produced.
 */
export function workerDbsOf(names, keys, logicals = []) {
  const wanted = new Set(keys);
  const named = new Set(logicals);
  return names.filter((n) => {
    const m = WORKER_DB_NAME_RE.exec(n);
    if (m !== null) return wanted.has(m[1]);
    const i = isolatedKeyOf(n, named);
    return i !== null && wanted.has(i);
  });
}

/* THE OTHER PER-FILE DATABASES (MATURITY-026): `prepareIsolatedDb("trafficflow_kek_rewrap")` names
 * `trafficflow_kek_rewrap_<key>`, which the worker prefix never matched, so a drop left four per clone
 * (a post-push run dropped them by name). Only a logical name the tree's own call sites pass is matched,
 * with the checkout's key after it — never a bare suffix, which the lane db and its templates share. */
export function isolatedKeyOf(name, named) {
  const m = /^(.+)_([0-9a-f]{12})$/.exec(name);
  return m !== null && named.has(m[1]) ? m[2] : null;
}
export function isolatedLogicalsIn(sources) {
  const out = new Set();
  for (const src of sources) {
    const consts = new Map([...src.matchAll(/\bconst\s+([A-Z_][A-Z0-9_]*)\s*=\s*"([a-z0-9_]+)"/g)].map((m) => [m[1], m[2]]));
    for (const m of src.matchAll(/\bprepareIsolatedDb\(\s*(?:"([a-z0-9_]+)"|([A-Z_][A-Z0-9_]*))\s*[,)]/g)) {
      const logical = m[1] ?? consts.get(m[2]);
      if (logical && logical.startsWith("trafficflow_") && !logical.startsWith("trafficflow_worker_")) out.add(logical);
    }
  }
  return [...out].sort();
}

/** A name this tool may drop beside a lane database. Anything else is refused before the DROP. */
export function assertWorkerDbName(name, logicals = []) {
  if (!WORKER_DB_NAME_RE.test(name) && isolatedKeyOf(name, new Set(logicals)) === null) {
    throw new Error(
      `refusing to touch "${name}": beside a lane database this tool drops ` +
        "trafficflow_worker_<case>_<12 hex> and nothing else.",
    );
  }
  return name;
}

/** Swap the database name in a URL, keeping host, port and credentials. */
export function withDatabase(url, database) {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

/** The database a URL names — what a message may say, where the URL itself may not. */
export function databaseOf(url) {
  return new URL(url).pathname.replace(/^\//, "");
}

/** `PG_TEST_URL=` out of a `.lane-db.env` body. */
export function parseLaneEnv(text) {
  for (const line of text.split("\n")) {
    const m = /^PG_TEST_URL=(.+)$/.exec(line.trim());
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * The BASE url — host, port, credentials — read from the same environment the tests read.
 *
 * Deliberately NOT from `.lane-db.env`: the base is the server, not whatever database this
 * worktree was last pointed at.
 */
export function baseUrlFrom(env) {
  return (
    env.DATABASE_URL_PG_TEST ??
    env.DATABASE_URL_SESSION ??
    env.DATABASE_URL ??
    "postgres://tf:tf@localhost:5433/trafficflow_test"
  );
}

/**
 * WHAT TO DO WITH A DATABASE THAT ALREADY EXISTS — the BOX-DRIFT discriminator, as a pure function.
 *
 * A database AHEAD of this tree cannot be repaired by running anything: every migration this tree
 * adds sits below the recorded maximum and is therefore recorded as applied without running. So it
 * is REFUSED with both maxima named, never dropped behind the caller's back. Everything else is
 * ours to rebuild — drift (a migration edited in place) and a tree that has moved on.
 */
export function decide({ exists, drift, maxima }) {
  if (!exists) return { action: "create", reason: "no such database yet" };
  const ahead = maxima.filter((m) => m.db > m.tree);
  if (ahead.length > 0) {
    return {
      action: "refuse",
      reason:
        `the database is AHEAD of this tree (${ahead
          .map((m) => `${m.name}: db ${m.db} > tree ${m.tree}`)
          .join("; ")}). Every migration this tree adds would be recorded as applied without ` +
        "running. Rebase this worktree, or --drop it and run again.",
    };
  }
  if (drift) return { action: "recreate", reason: `drift — ${drift}` };
  const behind = maxima.filter((m) => m.db < m.tree);
  if (behind.length > 0) {
    return {
      action: "recreate",
      reason: `this tree is AHEAD (${behind
        .map((m) => `${m.name}: tree ${m.tree} > db ${m.db}`)
        .join("; ")}) — rebuilding from this tree's template`,
    };
  }
  return { action: "reuse", reason: "the journal maxima match this tree" };
}

/* ── below here a connection is opened, against the worktree's own code ─────────────────────── */

const IS_CLI = process.argv[1] !== undefined && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

/** The driver, resolved through the package that declares it — nothing hoists it to a root. */
function driver(root) {
  return createRequire(join(root, "packages/db/package.json"))("postgres");
}

/**
 * The worktree's own migrator, journal reader and drift detector, from source.
 *
 * The source reaches one workspace sibling through its `exports` map, which points at `dist` — so
 * an unbuilt worktree fails here with a bare `Cannot find module …/dist/index.js` naming a file
 * nobody asked for. Say what to run instead.
 */
async function treeModules(root) {
  try {
    const admin = await import(pathToFileURL(join(root, "packages/db/src/admin.ts")).href);
    const cloud = await import(pathToFileURL(join(root, "packages/db/src/cloud.ts")).href);
    const testing = await import(pathToFileURL(join(root, "packages/db/src/testing.ts")).href);
    return {
      ...admin, makeOwnedDb: cloud.makeOwnedDb, journalDrift: testing.journalDrift,
      cloneFromTemplate: testing.cloneFromTemplate,
    };
  } catch (e) {
    if (e?.code === "ERR_MODULE_NOT_FOUND" && /[/\\]dist[/\\]/.test(String(e.message))) {
      throw new Error(`this worktree is not built — build the workspace's packages in ${root} ` +
        `first (a workspace sibling resolves through dist). Cause: ${e.message}`);
    }
    throw e;
  }
}

/** The highest `when` each journal declares in this tree. */
function treeMaxima(mod) {
  return mod.readJournals().map(({ spec, entries }) => ({
    name: spec.name,
    tree: entries.length === 0 ? 0 : Math.max(...entries.map((e) => Number(e.when))),
  }));
}

/** The highest `when` each journal's own pinned table records in this database. */
async function dbMaxima(mod, url) {
  const owned = mod.makeOwnedDb(url);
  try {
    const applied = await mod.readAppliedWhens(owned.db);
    return new Map([...applied].map(([n, w]) => [n, w.size === 0 ? 0 : Math.max(...w)]));
  } finally {
    await owned.close();
  }
}

/**
 * `CREATE`/`DROP DATABASE` on a session with no statement timeout.
 *
 * A statement timeout that interrupts `DROP DATABASE` leaves the database INVALID
 * (`pg_database.datconnlimit = -2`), after which every connection to it fails in a way that reads
 * as the server being down. The role's server-side defaults reach this session, so they are
 * cleared here the way `runMigrations` clears them.
 */
async function maintenance(root, baseUrl, fn) {
  const postgres = driver(root);
  const sql = postgres(withDatabase(baseUrl, "postgres"), { max: 1, onnotice: () => {} });
  try {
    await sql`set statement_timeout = 0`;
    await sql`set lock_timeout = 0`;
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function databaseExists(sql, name) {
  return (await sql`select 1 from pg_database where datname = ${name}`).length > 0;
}

/** Is the file this tool writes ignored by git? A tracked copy would be one `git add` from history. */
function ignoredByGit(worktree, file) {
  try {
    const out = execFileSync("git", ["check-ignore", "-v", file], {
      cwd: worktree, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim().split("\t")[0];
  } catch {
    return null;
  }
}

/* A CLONE OF THIS TREE'S SEALED TEMPLATE, which is built from empty by `runMigrations` the first
 * time its key is asked for (`cloneFromTemplate` in packages/db/src/testing.ts) and verified row for
 * row on the clone. The post-condition in `up` still reads both maxima afterwards. */
async function createFresh(root, name, baseUrl, mod, say) {
  await maintenance(root, baseUrl, async (sql) => {
    if (await databaseExists(sql, name)) await sql.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
  });
  say(`creating ${name} from this tree's sealed template`);
  await mod.cloneFromTemplate(baseUrl, name, { say: (line) => say(line) });
}

async function up(root, worktree, say) {
  const name = assertLaneDbName(laneDbName(worktree));
  const baseUrl = baseUrlFrom(process.env);
  const url = withDatabase(baseUrl, name);
  const host = laneRoleHostVerdict(baseUrl, process.env);
  if (!host.ok) { say(host.say); return 1; }
  const file = join(worktree, LANE_DB_ENV_FILE);
  if (!ignoredByGit(worktree, LANE_DB_ENV_FILE)) {
    say(`REFUSED: ${LANE_DB_ENV_FILE} is not git-ignored in this worktree — nothing was written`);
    return 1;
  }
  const mod = await treeModules(root);

  say(`worktree ${worktree}`);
  say(`database ${name} on the ${host.say}`);

  const exists = await maintenance(root, baseUrl, (sql) => databaseExists(sql, name));
  const tmax = treeMaxima(mod);
  const dmax = exists ? await dbMaxima(mod, url) : new Map();
  const maxima = tmax.map((m) => ({ ...m, db: dmax.get(m.name) ?? 0 }));
  for (const m of maxima) say(`journal ${m.name}: tree ${m.tree}  db ${exists ? m.db : "—"}`);

  const verdict = decide({ exists, drift: exists ? await mod.journalDrift(url) : null, maxima });
  say(`${verdict.action.toUpperCase()} — ${verdict.reason}`);
  if (verdict.action === "refuse") return 1;

  if (verdict.action !== "reuse") {
    await createFresh(root, name, baseUrl, mod, say);
    // The post-condition, because a watermark that silently refuses a migration is the whole
    // reason this tool exists: after a fresh clone the two maxima must agree.
    const after = await dbMaxima(mod, url);
    const short = tmax.filter((m) => (after.get(m.name) ?? 0) !== m.tree);
    if (short.length > 0) {
      say(`FAILED: migrated but ${short.map((m) => `${m.name} db ${after.get(m.name) ?? 0} != tree ${m.tree}`).join("; ")}`);
      return 1;
    }
  }

  const role = laneRoleOf(name);
  const password = keptPassword(existsSync(file) ? readFileSync(file, "utf8") : null, role) ?? randomBytes(16).toString("hex");
  await maintenance(root, baseUrl, (sql) => ensureLaneRole(sql, role, password, name, say));
  /* The race control's hook: lane-role.control.sh widens the gap between the ALTER and the rename
   * that the per-worktree lock in lane-db.sh closes. */
  const pause = Number(process.env.OHMAIL_LANE_DB_MINT_PAUSE_MS ?? 0);
  if (pause > 0) await new Promise((r) => setTimeout(r, Math.min(pause, 30_000)));
  /* tmp + rename: a reader never sees half a file, and a running suite keeps the URL it resolved. */
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `PG_TEST_URL=${laneUrl(baseUrl, name, password)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  say(`wrote ${LANE_DB_ENV_FILE} dialling as ${role} (git-ignored by ${ignoredByGit(worktree, LANE_DB_ENV_FILE)})`);
  return 0;
}

/* The settings rows `role` carries, every scope, from pg_db_role_setting: the one spelling of the query. */
async function roleSettingRows(sql, role) {
  return [...await sql`select r.rolname, rs.setdatabase::int as setdatabase, d.datname, rs.setconfig
                         from pg_db_role_setting rs join pg_roles r on r.oid = rs.setrole
                         left join pg_database d on d.oid = rs.setdatabase where r.rolname = ${role}`];
}

/* The deadline keys `role` carries, every scope. */
async function roleDeadlineKeys(sql, role) {
  return deadlineKeysOf(await roleSettingRows(sql, role));
}

/* RESET every deadline key a LANE role carries; the keys it carried are returned. tf is refused. */
async function resetDeadlineKeys(sql, role) {
  assertLaneRoleName(role);
  const keys = await roleDeadlineKeys(sql, role);
  for (const k of keys) {
    if (!/^[a-z_]+$/.test(k.key)) throw new Error(`refusing to reset "${k.key}": not a setting name`);
    await sql.unsafe(k.db === null
      ? `ALTER ROLE "${role}" RESET ${k.key}`
      : `ALTER ROLE "${role}" IN DATABASE "${k.db.replace(/"/g, '""')}" RESET ${k.key}`);
  }
  return keys;
}

/**
 * A RIG'S TEARDOWN (RIG-BOOT-WRITES-ROLE-DEADLINES-ON-THE-LANE-ROLE): a self-host server booted on
 * this worktree's lane env runs setupProdDatabase as the lane role, which writes three deadlines on it
 * role-wide. `--reset-role` reads the role's keys, RESETs them and reads them back: rc 0 when the read
 * after is empty, 1 when a key survived, 2 unreadable, 3 an env that names no lane role of its own.
 */
async function resetRole(root, worktree, say) {
  const file = join(worktree, LANE_DB_ENV_FILE);
  const envText = existsSync(file) ? readFileSync(file, "utf8") : null;
  const url = envText === null ? null : parseLaneEnv(envText);
  const name = url ? databaseOf(url) : null;
  const who = envText === null ? null : envRoleOf(envText);
  if (!url || !name || !who) { say(`REFUSED: ${file} names no lane database and role — nothing to reset`); return 3; }
  try { assertLaneDbName(name); assertLaneRoleName(who.role); } catch (e) { say(`REFUSED: ${e.message}`); return 3; }
  if (who.role !== laneRoleOf(name)) { say(`REFUSED: the env dials as ${who.role}, which is not ${name}'s role ${laneRoleOf(name)}`); return 3; }
  /* The env must be THIS worktree's own: a copied env names another lane's role (LOW 4). */
  const own = laneDbName(worktree);
  if (name !== own) { say(`REFUSED: ${file} names ${name}, but this worktree's own database is ${own} — another lane's env, nothing reset`); return 3; }
  const maint = maintenanceUrlFor(url, baseUrlFrom(process.env));
  const fence = laneRoleHostVerdict(maint, process.env);
  if (!fence.ok) { say(`${fence.say} — nothing was dialled`); return 3; }
  let postgres;
  try { postgres = driver(root); } catch (e) { say(`UNREADABLE: no postgres driver from ${root} (${e?.code ?? e})`); return 2; }
  const sql = postgres(maint, { max: 1, onnotice: () => {}, connect_timeout: 10 });
  const said = (keys) => (keys.length === 0 ? "none" : keys.map((k) => `${k.key}@${k.db ?? "role-wide"}`).join(" "));
  try {
    await sql`set statement_timeout = 0`;
    const before = await roleDeadlineKeys(sql, who.role);
    say(`ROLE_DEADLINES_BEFORE ${who.role} ${said(before)}`);
    await resetDeadlineKeys(sql, who.role);
    const after = await roleDeadlineKeys(sql, who.role);
    say(`ROLE_DEADLINES_AFTER ${who.role} ${said(after)}`);
    return after.length === 0 ? 0 : 1;
  } catch (e) {
    say(`UNREADABLE: the role could not be read or reset — ${e?.code ?? e?.message ?? e}`);
    return 2;
  } finally {
    try { await sql.end({ timeout: 5 }); } catch { /* the verdict is above */ }
  }
}

/* Make or refresh the lane role and RESET its own deadline keys (a rig that booted setup-prod from
 * this lane's env set them; they are this lane's, named, and only this lane's). Never tf: the name is
 * fenced before the first statement. The database is not touched. */
async function ensureLaneRole(sql, role, password, dbName, say) {
  assertLaneRoleName(role);
  if (!LANE_PASSWORD_RE.test(password)) throw new Error("a lane role password is 32 hex");
  const exists = (await sql`select 1 from pg_roles where rolname = ${role}`).length > 0;
  await sql.unsafe(`${exists ? "ALTER" : "CREATE"} ROLE "${role}" WITH LOGIN SUPERUSER PASSWORD '${password}'`);
  await sql.unsafe(`COMMENT ON ROLE "${role}" IS 'ohmail-lane-role db=${dbName}'`);
  say(`role ${role} ${exists ? "kept" : "created"} (LOGIN SUPERUSER)`);
  const keys = await resetDeadlineKeys(sql, role);
  say(keys.length === 0
    ? `role ${role} carries no deadline keys`
    : `role ${role} carried ${keys.map((k) => `${k.key}@${k.db ?? "role-wide"}`).join(" ")} — RESET (this lane's own role; tf is not touched)`);
}

/**
 * THE CHECKOUT KEYS A DROP IS ABOUT, from the derivation that owns them.
 *
 * `checkoutKeyOf` is imported from `apps/worker/test/_isolateddb-name.ts`, never re-implemented:
 * two spellings of one rule is how the namespaces drift apart again. A checkout has TWO keys over
 * its life — its lane database's own hex, and the path hash it used for any worker run made before
 * `lane-db.sh` gave it one — and a drop is about both. Without a worktree only the first exists.
 * A tree too old to carry the module gets a NAMED refusal to look, never a silent skip.
 */
async function checkoutKeysFor(root, name, worktree, say) {
  const from = join(root, "apps/worker/test/_isolateddb-name.ts");
  let checkoutKeyOf;
  try {
    ({ checkoutKeyOf } = await import(pathToFileURL(from).href));
  } catch (e) {
    say(`NOT READ: ${from} — no worker database is named or dropped here (${e?.code ?? e})`);
    return null;
  }
  const keys = [checkoutKeyOf(name, worktree ?? root)];
  if (worktree) {
    const path = checkoutKeyOf("trafficflow_test", worktree);
    if (!keys.includes(path)) keys.push(path);
  }
  return keys;
}

/* The tree's test sources that open a per-file database, read once per drop. */
function isolatedLogicalsOfTree(root) {
  let files = [];
  try {
    files = execFileSync("git", ["-C", root, "ls-files", "--", "apps/*/test/*", "packages/*/test/*"], { encoding: "utf8" })
      .split("\n").filter((f) => /\.test\.tsx?$/.test(f));
  } catch { return []; }
  const srcs = [];
  for (const f of files) { try { const t = readFileSync(join(root, f), "utf8"); if (t.includes("prepareIsolatedDb")) srcs.push(t); } catch { /* unreadable: no name from it */ } }
  return isolatedLogicalsIn(srcs);
}

async function drop(root, worktree, say, given = null) {
  const file = worktree ? join(worktree, LANE_DB_ENV_FILE) : null;
  // The FILE's name first: a worktree that has moved, or a hand-edited file, names the database
  // this worktree has actually been using, which the hash no longer produces. A worktree that is
  // GONE has no file either, and then the path key is all there is — which is why `--name` exists
  // for the census case, where the caller already read the name off the server.
  const fromFile = file && existsSync(file) ? parseLaneEnv(readFileSync(file, "utf8")) : null;
  const name = given ?? (fromFile ? databaseOf(fromFile) : laneDbName(worktree));
  say(`worktree ${worktree ?? "(none — dropping by name)"}`);
  say(`database ${name} (from ${given ? "--name" : fromFile ? LANE_DB_ENV_FILE : "the worktree path"})`);
  assertLaneDbName(name);

  const keys = await checkoutKeysFor(root, name, worktree, say);
  if (keys) {
    say(`checkout keys ${keys.join(" ")}` +
      `${worktree ? "" : " (no worktree, so only the lane database's own key is derivable)"}`);
  }

  const role = laneRoleOf(name);
  const { dropped, workers, roleRc } = await maintenance(root, baseUrlFrom(process.env), async (sql) => {
    let d = false;
    if (await databaseExists(sql, name)) {
      await sql.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
      d = true;
    }
    const taken = [];
    if (keys) {
      const all = (await sql`select datname from pg_database`).map((r) => r.datname);
      const logicals = isolatedLogicalsOfTree(root);
      for (const w of workerDbsOf(all, keys, logicals)) {
        assertWorkerDbName(w, logicals);
        await sql.unsafe(`DROP DATABASE "${w}" WITH (FORCE)`);
        taken.push(w);
      }
    }
    return { dropped: d, workers: taken, roleRc: await dropLaneRole(sql, name, role) };
  });
  say(dropped ? `DROPPED ${name}` : `${name} did not exist`);
  for (const w of workers) say(`DROPPED worker database ${w}`);
  if (keys) say(`${workers.length} worker database(s) went with it`);
  for (const line of roleRc.lines) say(line);
  if (file && existsSync(file)) { unlinkSync(file); say(`removed ${LANE_DB_ENV_FILE}`); }
  /* The DATABASE is what a drop answers for: the tier chains `--drop && create`, so a role kept
   * over something else it owns is named on its KEPT_ROLE line and never fails the drop. */
  return 0;
}

/* The role goes LAST, after every database it could own: templates it built are handed to the
 * maintenance role, anything else keeps it (KEPT_ROLE, named; the orphan-role sweep is a filed
 * row). The maintenance session must not BE the lane role. */
async function dropLaneRole(sql, dbName, role) {
  const lines = [];
  if ((await sql`select 1 from pg_roles where rolname = ${role}`).length === 0) {
    return { kept: false, lines: [`role ${role} did not exist (a database made before lane roles)`] };
  }
  const me = (await sql`select current_user as u`)[0].u;
  if (me === role) return { kept: true, lines: [`KEPT_ROLE ${role}: the maintenance session dials AS it — drop from the box role`] };
  const owned = (await sql`select d.datname from pg_database d join pg_roles r on r.oid = d.datdba where r.rolname = ${role} order by 1`)
    .map((r) => r.datname);
  const plan = laneRoleDropPlan({ dbName, role, owned });
  for (const t of plan.handOver) {
    await sql.unsafe(`ALTER DATABASE "${t}" OWNER TO "${me.replace(/"/g, '""')}"`);
    lines.push(`template ${t} handed from ${role} to ${me}`);
  }
  if (!plan.dropRole) return { kept: true, lines: [...lines, `KEPT_ROLE ${role}: it still owns ${plan.blocking.join(", ")} — not this drop's to take`] };
  try {
    await sql.unsafe(`DROP ROLE "${assertLaneRoleName(role)}"`);
  } catch (e) {
    return { kept: true, lines: [...lines, `KEPT_ROLE ${role}: ${e?.message ?? e}${e?.detail ? ` (${String(e.detail).replace(/\s+/g, " ")})` : ""}`] };
  }
  return { kept: false, lines: [...lines, `DROPPED role ${role}`] };
}

/**
 * IS THE DATABASE THIS WORKTREE IS POINTED AT STILL THERE — the pure half, so every arm can be driven.
 *
 * The `db` service declares no `volumes:`, so every lane database dies with the container; an env
 * file written before one goes names nothing, and nothing reads as broken.
 *
 * THE ANCHOR IS THE WHOLE POINT. A zero is a reading only beside a POSITIVE CONTROL that reads a
 * known non-zero through the SAME path — `datname = 'postgres'`, the same parameter binding. If
 * the anchor is zero the query is broken and the answer is UNREADABLE, never "it is gone".
 */
export function laneDbCheckVerdict({ envText, name, exists, anchor, total }) {
  if (envText === null || envText === undefined)
    return { rc: 3, verdict: "NO_ENV_FILE",
      say: `no ${LANE_DB_ENV_FILE} in this worktree — every pg file here would resolve to the SHARED box` };
  if (!name)
    return { rc: 3, verdict: "NO_URL",
      say: `${LANE_DB_ENV_FILE} carries no PG_TEST_URL= line — it names no database at all` };
  if (anchor === undefined || total === undefined)
    return { rc: 2, verdict: "UNREADABLE", say: "the server could not be read at all" };
  if (anchor < 1 || total < 1)
    return { rc: 2, verdict: "UNREADABLE",
      say: `the positive control read ${anchor} for datname='postgres' and ${total} databases in all — ` +
        "a count that is zero for its ANCHOR is zero for the reading, not for the fact" };
  if (!exists)
    return { rc: 3, verdict: "ABSENT",
      say: `${name} is NOT on this server, and the anchor read ${anchor}, so that is the fact and not the reading` };
  return { rc: 0, verdict: "OK", say: `${name} is on this server (anchor ${anchor}, ${total} databases)` };
}

/**
 * THE ROLE'S DEADLINES, from its pg_roles anchor and its pg_db_role_setting rows: rc 0 CLEAN, rc 3
 * REFUSED naming each `*_timeout` key with its scope, rc 2 UNREADABLE when the anchor is not one
 * row (a server without the role says nothing about it). The lines are the retired kit reader's.
 */
export function roleDeadlinesVerdict({ role, anchor, rows }) {
  if (anchor !== 1) return { rc: 2, line: `BOX_ROLE_DEADLINES UNREADABLE role=${role} — pg_roles reads ${anchor} row(s) for it; a server without the role is not the box, and its zero says nothing` };
  const own = rows.filter((r) => r.rolname === role);
  const d = [];
  for (const r of own) for (const kv of r.setconfig ?? []) {
    const eq = kv.indexOf("=");
    const key = eq < 0 ? kv : kv.slice(0, eq);
    if (/_timeout$/.test(key)) d.push(`${key}=${kv.slice(eq + 1)}@${r.setdatabase === 0 ? "role-wide" : `db:${r.datname ?? r.setdatabase}`}`);
  }
  if (d.length === 0) return { rc: 0, line: `BOX_ROLE_DEADLINES CLEAN role=${role} setting-rows=${own.length} deadline-keys=0 (anchor pg_roles ${role}=1)` };
  return { rc: 3, line: `BOX_ROLE_DEADLINES REFUSED role=${role} ${d.join(" ")} — every later connection as ${role} inherits these; a rig booted setup-prod or the self-host server as the box role. Ask the dispatcher, who resets them (ALTER ROLE ${role} RESET <key>) and reads them back` };
}

/** Read `role`'s deadlines in one read-only transaction; a read that throws is UNREADABLE, rc 2. */
export async function readRoleDeadlines(sql, role) {
  try {
    const { anchor, rows } = await sql.begin("read only", async (tx) => {
      await tx`set local statement_timeout = 0`;
      const n = Number((await tx`select count(*)::int as n from pg_roles where rolname = ${role}`)[0]?.n ?? 0);
      return { anchor: n, rows: await roleSettingRows(tx, role) };
    });
    return roleDeadlinesVerdict({ role, anchor, rows });
  } catch (e) {
    return { rc: 2, line: `BOX_ROLE_DEADLINES UNREADABLE role=${role} — the catalog could not be read (${e?.code ?? e?.name ?? "error"}); that is no statement about the role` };
  }
}

/* THE BOX ROLE'S DEADLINES, as `roleDeadlinesVerdict` reads them. rc 4 is its OWN answer: rc 3
 * means ABSENT and a driver rebuilds on it, and a poisoned tf is not a missing database. Anything
 * the reader did not classify is UNREADABLE. */
export const BOX_ROLE_DEADLINES_RC = 4;
export function boxRoleCheckVerdict(childRc, line, word = "BOX_ROLE_DEADLINES") {
  const said = (line ?? "").trim() || "(the reader printed nothing)";
  const whose = word === "BOX_ROLE_DEADLINES" ? "the box role" : "this lane's own role (bash scripts/lane-db.sh <worktree> resets it)";
  if (childRc === 0 && /^BOX_ROLE_DEADLINES CLEAN /.test(said)) return { rc: 0, verdict: "OK", say: said };
  /* The reader's own remedy is tf's (the dispatcher resets it); a lane role's line keeps the fact and
   * names the lane's remedy only. */
  const fact = word === "BOX_ROLE_DEADLINES" ? said : said.split(" — ")[0];
  if (childRc === 3 && /^BOX_ROLE_DEADLINES REFUSED /.test(said))
    return { rc: BOX_ROLE_DEADLINES_RC, verdict: word, say: `${fact} — the database is there; ${whose} is not clean` };
  return { rc: 2, verdict: "UNREADABLE", say: `${whose} could not be read (reader rc ${childRc}): ${said}` };
}

/* --check READS AS THE MAINTENANCE ROLE: the server the env names, the base URL's credentials. A
 * lane role dies with the cluster, so dialling as it after a box loss read 28P01 — UNREADABLE, a
 * box half owed for ever — where the fact is ABSENT and the remedy is the rebuild. */
export function maintenanceUrlFor(envUrl, baseUrl) {
  const u = new URL(envUrl);
  const b = new URL(baseUrl);
  u.username = b.username;
  u.password = b.password;
  u.pathname = "/postgres";
  return u.toString();
}

/** The lane role's half of --check, once the database is known to be there. rc 3 = the rebuild. */
export function laneRoleVerdict({ role, roleExists, login }) {
  if (role === BOX_ROLE) return { rc: 0, verdict: "LEGACY_ROLE", say: `this env still dials as ${BOX_ROLE}` };
  if (!LANE_ROLE_RE.test(role ?? "")) return { rc: 3, verdict: "REFUSED", say: `the env dials as "${role}", which is neither ${BOX_ROLE} nor a lane role` };
  if (!roleExists) return { rc: 3, verdict: "ROLE_ABSENT", say: `${role} is not on this server while its database is` };
  if (login === "ok") return { rc: 0, verdict: "ROLE", say: `${role} logs in` };
  if (login === "refused") return { rc: 3, verdict: "LOGIN_REFUSED", say: `${role} refused the env's password — the env and the role disagree` };
  return { rc: 2, verdict: "UNREADABLE", say: `${role}'s login could not be tried (${login})` };
}

/** Who a lane env dials as: a LEGACY tf env still works, and `lane-db.sh <wt>` re-keys it. */
export function envRoleOf(envText) {
  const url = envText ? parseLaneEnv(envText) : null;
  if (!url) return null;
  try {
    const u = new URL(url);
    return { role: decodeURIComponent(u.username), where: `${u.hostname}:${u.port || 5432}`, db: databaseOf(url) };
  } catch { return null; }
}

/** Which door makes a database name: `--list-invalid` counts the INVALID ones per door. */
export function doorOfDb(name) {
  return LANE_DB_NAME_RE.test(name) ? "lane-db" : WORKER_DB_NAME_RE.test(name) ? "worker" : "other";
}

async function listInvalid(root, say) {
  let postgres;
  try { postgres = driver(root); }
  catch (e) { say(`UNREADABLE: the postgres driver could not be resolved from ${root} (${e?.code ?? e})`); return 2; }
  const base = baseUrlFrom(process.env);
  const u = new URL(base);
  say(`reading pg_database on ${u.hostname}:${u.port || 5432} — read only`);
  const sql = postgres(withDatabase(base, "postgres"), { max: 1, onnotice: () => {}, connect_timeout: 10 });
  let rows;
  try { rows = await sql`select datname, datconnlimit from pg_database`; }
  catch (e) { say(`UNREADABLE: ${e?.code ?? e?.message ?? e} — not an answer about any database`); return 2; }
  finally { try { await sql.end({ timeout: 5 }); } catch { /* the reading is above */ } }
  const r = invalidDbReading({ rows: [...rows], doorOf: doorOfDb });
  for (const l of r.lines) process.stdout.write(`${l}\n`);
  return r.rc;
}

/* THE LEGACY CENSUS: every `.lane-db.env` that still dials as tf, READ ONLY. Its zero counts only
 * beside a planted tf env read LEGACY through the same function. Roots: every worktree of this
 * repository, the home directory and /tmp, or the --root dirs given; vendored and build trees are
 * skipped and named. Nothing but the role, the host and the database is printed. */
const LEGACY_SKIP = new Set(["node_modules", ".git", "dist", "build", "target", "pgdata", ".cache", ".pnpm-store", "squashfs-root"]);
export function classifyEnv(envText) {
  const who = envRoleOf(envText);
  if (!who) return { kind: "unreadable" };
  return { kind: who.role === BOX_ROLE ? "legacy" : LANE_ROLE_RE.test(who.role) ? "lane-role" : "other", ...who };
}
function envFilesUnder(dir, depth, acc) {
  let names;
  try { names = readdirSync(dir); } catch { return acc; }
  for (const n of names) {
    const p = join(dir, n);
    if (n === LANE_DB_ENV_FILE) { acc.add(p); continue; }
    if (depth === 0 || LEGACY_SKIP.has(n)) continue;
    let st; try { st = lstatSync(p, { throwIfNoEntry: false }); } catch { continue; }
    if (st?.isDirectory()) envFilesUnder(p, depth - 1, acc);
  }
  return acc;
}
async function listLegacy(root, roots, say) {
  const ctl = mkdtempSync(join(tmpdir(), "lane-db-legacy-ctl-"));
  try {
    writeFileSync(join(ctl, LANE_DB_ENV_FILE), "PG_TEST_URL=postgres://tf:tf@localhost:5433/trafficflow_l_000000000000\n", { mode: 0o600 });
    const control = [...envFilesUnder(ctl, 1, new Set())].map((f) => classifyEnv(readFileSync(f, "utf8")).kind);
    if (control.join() !== "legacy") { say(`UNREADABLE: the planted tf env read [${control.join()}], not legacy — a zero below would say nothing`); return 2; }
  } finally { rmSync(ctl, { recursive: true, force: true }); }
  const dirs = roots.length > 0 ? roots.map((r) => ({ dir: resolve(r), depth: 6 })) : [
    ...execFileSync("git", ["-C", root, "worktree", "list", "--porcelain"], { encoding: "utf8" })
      .split("\n").filter((l) => l.startsWith("worktree ")).map((l) => ({ dir: l.slice(9), depth: 0 })),
    { dir: homedir(), depth: 6 }, { dir: "/tmp", depth: 6 },
  ];
  say(`roots: ${dirs.map((d) => d.dir).join(" ")}; skipped by name: ${[...LEGACY_SKIP].join(" ")}`);
  const files = new Set();
  for (const d of dirs) envFilesUnder(d.dir, d.depth, files);
  const count = { legacy: 0, "lane-role": 0, other: 0, unreadable: 0 };
  for (const f of [...files].sort()) {
    let c; try { c = classifyEnv(readFileSync(f, "utf8")); } catch { c = { kind: "unreadable" }; }
    count[c.kind] += 1;
    if (c.kind === "legacy") process.stdout.write(`LEGACY ${f} role=${c.role} ${c.where}/${c.db}\n`);
  }
  process.stdout.write(`LANE_DB_LEGACY legacy=${count.legacy} lane-role=${count["lane-role"]} other=${count.other} ` +
    `unreadable=${count.unreadable} scanned=${files.size} control=legacy\n`);
  return 0;
}

/**
 * The same question against a live server. READ ONLY: it creates nothing, drops nothing and
 * rewrites no env file — a driver's prerequisite, not a repair.
 *
 * The driver is required BEFORE anything is opened or any output file exists, because rc 127
 * arriving AFTER the shell has made the redirect target is how an empty file read as "zero
 * databases owed".
 */
async function check(root, worktree, say) {
  let postgres;
  try { postgres = driver(root); }
  catch (e) {
    say(`UNREADABLE: the postgres driver could not be resolved from ${root} — install the workspace's dependencies there. ` +
      `Nothing was read, so this is not an answer about any database (${e?.code ?? e})`);
    return 2;
  }

  const file = join(worktree, LANE_DB_ENV_FILE);
  const envText = existsSync(file) ? readFileSync(file, "utf8") : null;
  const url = envText === null ? null : parseLaneEnv(envText);
  const name = url ? databaseOf(url) : null;
  if (envText === null || !name) {
    const v = laneDbCheckVerdict({ envText, name });
    say(`${v.verdict}: ${v.say}`);
    say(`REMEDY: bash scripts/lane-db.sh ${worktree}`);
    return v.rc;
  }
  /* The name is fenced before it is ever put in a query: this tool asks about lane databases and
   * says so for anything else, rather than reporting on `trafficflow_test`. */
  try { assertLaneDbName(name); }
  catch (e) { say(`REFUSED: ${e.message}`); return 3; }

  const where = (() => { const u = new URL(url); return `${u.hostname}:${u.port || 5432}`; })();
  say(`worktree ${worktree}`);
  say(`database ${name} on ${where} (from ${LANE_DB_ENV_FILE})`);

  let exists, anchor, total, roleExists;
  const who = envRoleOf(envText);
  const maint = maintenanceUrlFor(url, baseUrlFrom(process.env));
  /* The maintenance credentials go only where a lane role may be made: the host comes from the env
   * file, which can name any server, so the create's own host verdict is asked before any dial. */
  const fence = laneRoleHostVerdict(maint, process.env);
  if (!fence.ok) {
    say(`${fence.say} — the env names ${where}; nothing was dialled`);
    say(`REMEDY: bash scripts/lane-db.sh ${worktree} writes an env for the local box`);
    return 3;
  }
  const sql = postgres(maint, { max: 1, onnotice: () => {}, connect_timeout: 10 });
  try {
    await sql`set statement_timeout = 0`;
    /* THE ANCHOR FIRST, through the same binding as the subject — a known-present name. */
    anchor = (await sql`select 1 from pg_database where datname = ${"postgres"}`).length;
    total = Number((await sql`select count(*)::int as n from pg_database`)[0]?.n ?? 0);
    exists = (await sql`select 1 from pg_database where datname = ${name}`).length > 0;
    roleExists = (await sql`select 1 from pg_roles where rolname = ${who?.role ?? ""}`).length > 0;
  } catch (e) {
    say(`UNREADABLE: ${where} could not be reached or read — ${e?.code ?? e?.message ?? e}. ` +
      "That is not an answer about whether the database exists.");
    say(`REMEDY: start the box (sg docker -c "docker compose up -d db"), then bash scripts/lane-db.sh ${worktree}`);
    return 2;
  } finally {
    try { await sql.end({ timeout: 5 }); } catch { /* the verdict is above, not in the teardown */ }
  }

  const v = laneDbCheckVerdict({ envText, name, exists, anchor, total });
  say(`${v.verdict}: ${v.say}`);
  if (v.rc !== 0) {
    say(`REMEDY: bash scripts/lane-db.sh ${worktree} recreates it from this tree's template`);
    return v.rc;
  }
  /* The env's own login, tried only for a lane role that exists: a password the role does not
   * carry is the env and the role disagreeing, and the rebuild re-keys both. */
  let login = "not tried";
  if (who && LANE_ROLE_RE.test(who.role) && roleExists) {
    const asLane = postgres(withDatabase(url, name), { max: 1, onnotice: () => {}, connect_timeout: 10 });
    try { await asLane`select 1`; login = "ok"; }
    catch (e) { login = e?.code === "28P01" || e?.code === "28000" ? "refused" : String(e?.code ?? e?.message ?? e); }
    finally { try { await asLane.end({ timeout: 5 }); } catch { /* the verdict is above */ } }
  }
  const lr = laneRoleVerdict({ role: who?.role, roleExists, login });
  say(lr.verdict === "LEGACY_ROLE"
    ? `LEGACY_ROLE ${BOX_ROLE}: this env still dials as the box role — bash scripts/lane-db.sh ${worktree} re-keys it to ${laneRoleOf(name)} (the database is reused)`
    : `${lr.verdict}: ${lr.say}`);
  if (lr.rc !== 0) {
    if (lr.rc === 3) say(`REMEDY: bash scripts/lane-db.sh ${worktree} reuses the database and re-keys the role`);
    return lr.rc;
  }
  /* tf, then the lane's own role: a rig that booted setup-prod from this env set them on it. Read
   * here, read only, on a fresh maintenance session. */
  const roles = [[BOX_ROLE, "BOX_ROLE_DEADLINES"], ...(lr.verdict === "ROLE" ? [[who.role, "LANE_ROLE_DEADLINES"]] : [])];
  const roleSql = postgres(maint, { max: 1, onnotice: () => {}, connect_timeout: 10 });
  let rc = 0;
  try {
    for (const [role, word] of roles) {
      const v = await readRoleDeadlines(roleSql, role);
      const b = boxRoleCheckVerdict(v.rc, v.line, word);
      say(`${b.verdict}: ${b.say}`);
      if (b.rc === 2) return 2;
      if (b.rc !== 0) rc = b.rc;
    }
  } finally {
    try { await roleSql.end({ timeout: 5 }); } catch { /* the verdict is above */ }
  }
  return rc;
}

if (IS_CLI) {
  const say = (m) => process.stderr.write(`lane-db: ${m}\n`);
  const argv = process.argv.slice(2);
  const flags = argv.filter((a) => a.startsWith("--"));
  const paths = argv.filter((a) => !a.startsWith("--"));
  const nameAt = argv.indexOf("--name");
  const byName = nameAt >= 0 ? argv[nameAt + 1] : null;
  const positional = byName ? paths.filter((p) => p !== byName) : paths;
  const unknown = flags.filter((f) => f !== "--drop" && f !== "--name" && f !== "--check" && f !== "--reset-role" && f !== "--list-invalid" && f !== "--list-legacy" && f !== "--root");
  /* THE LEGACY CENSUS reads files and opens no connection; it takes only --root <dir>. */
  if (flags.includes("--list-legacy")) {
    const roots = argv.flatMap((a, i) => (argv[i - 1] === "--root" ? [a] : []));
    if (flags.some((f) => f !== "--list-legacy" && f !== "--root") || paths.length !== roots.length || roots.some((r) => !existsSync(r))) {
      say("accepted: --list-legacy [--root <existing dir>]... — it takes no worktree and no other flag");
      process.exit(2);
    }
    process.exit(await listLegacy(resolve(dirname(fileURLToPath(import.meta.url)), ".."), roots, say));
  }
  const dropping = flags.includes("--drop");
  const checking = flags.includes("--check");
  const resetting = flags.includes("--reset-role");
  /* A READ OF THE WHOLE SERVER takes no worktree and no other flag: it drops nothing. */
  if (flags.includes("--list-invalid")) {
    if (flags.length !== 1 || paths.length !== 0) {
      say("accepted: --list-invalid alone — it takes no worktree and no other flag");
      process.exit(2);
    }
    process.exit(await listInvalid(resolve(dirname(fileURLToPath(import.meta.url)), ".."), say));
  }
  if (unknown.length > 0 || flags.includes("--root") || (byName !== null && !dropping) || (byName !== null && byName === undefined)
      || (checking && dropping) || (resetting && (checking || dropping))) {
    say(`accepted: <worktree> | --check <worktree> | --reset-role <worktree> | --drop <worktree> | --drop --name <db> | --list-invalid` +
      `${unknown.length > 0 ? ` (unknown ${unknown.join(" ")})` : ""}` +
      `${byName !== null && !dropping ? " (--name is for --drop only)" : ""}` +
      `${checking && dropping ? " (--check reads; --drop destroys; never both in one call)" : ""}`);
    process.exit(2);
  }
  /* THE SELF ROOT, for a drop whose worktree is gone: the driver and the base URL come from this
   * checkout then, because there is no other tree to ask. */
  const selfRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

  if (byName) {
    if (positional.length > 0) {
      say(`accepted: --drop --name <db> takes no worktree (got ${positional.join(" ")})`);
      process.exit(2);
    }
    try {
      process.exit(await drop(selfRoot, null, say, byName));
    } catch (e) {
      say(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  }

  if (positional.length !== 1) {
    say(`accepted: <worktree> | --check <worktree> | --reset-role <worktree> | --drop <worktree> | --drop --name <db>`);
    process.exit(2);
  }
  const worktree = resolve(positional[0]);

  /* A CHECK MIGRATES NOTHING, so it asks nothing of the tree beyond the one file it reads, and the
   * driver comes from THIS checkout the way a drop's does. A driver's prerequisite must be
   * answerable in a tree whose `pnpm install` has not run yet — otherwise the prerequisite is the
   * thing that needs a prerequisite. */
  if (resetting) {
    if (!existsSync(worktree)) { say(`refusing ${worktree}: no such directory`); process.exit(2); }
    process.exit(await resetRole(selfRoot, worktree, say));
  }
  if (checking) {
    if (!existsSync(worktree)) {
      say(`refusing ${worktree}: no such directory — it names no ${LANE_DB_ENV_FILE} to read`);
      process.exit(2);
    }
    try {
      process.exit(await check(selfRoot, worktree, say));
    } catch (e) {
      say(`UNREADABLE: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(2);
    }
  }
  /* THE PREMISE CHECK IS ABOUT MIGRATING, so a DROP of a tree that is gone passes it by. The
   * cleanup recipe removes worktrees, and refusing here left the database on :5433 with nothing
   * that could ever name it again — a large share of the 567 leftovers measured on 2026-09-13. A
   * drop still refuses a directory that EXISTS and is not this workspace: that one is a typo, not
   * a cleanup. */
  const gone = !existsSync(worktree);
  if (!(dropping && gone) && !existsSync(join(worktree, "packages/db/src/admin.ts"))) {
    say(`refusing ${worktree}: no packages/db/src/admin.ts — this tool migrates the tree it is given`);
    process.exit(2);
  }
  try {
    process.exit(dropping
      ? await drop(gone ? selfRoot : worktree, worktree, say)
      : await up(worktree, worktree, say));
  } catch (e) {
    say(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
