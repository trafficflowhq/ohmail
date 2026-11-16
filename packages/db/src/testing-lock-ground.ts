import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type postgres from "postgres";
import { setupProdDatabase, type ProdSetupOptions, type ProdSetupReport } from "./setup-prod.js";
import { startOwnServer, type OwnServer, type PgMajor } from "./testing-own-server.js";
import { API_ROLE, PLANE_ROLE, WORKER_ROLE } from "./row-security/names.js";
import { STAFF_ROLE } from "./staff-grants.js";

/**
 * THE LOCK'S GROUND: a store of the product on a Postgres the test owns whole, with the roles the
 * Cloud has, made the way the Cloud makes them. In order: the setup as the server's superuser (the
 * journals; a server without the roles), the staff role's script, the runtime roles' script (which
 * makes the migrator and hands it everything), the logins' passwords (drawn here, never printed),
 * a stand-in billing plane with its five grants, and from then on the setup as the migrator. Each
 * group of cases takes a database of its own, cloned from a built one.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, "..", "..", "..", "scripts");

/** The role the runtime roles' script makes on a plain Postgres: it owns everything and bypasses. */
export const MIGRATOR_ROLE = "ohmail_migrator";

let ruleRows: string[][] | undefined;

/**
 * The verbs the copied roles' rule (`scripts/runtime-roles.tsv`, the kit's data, pinned by its
 * sha256) grants `role` on `table` of `public`: the table's own row, else the rule for every table.
 * What a login may not do there, the roles' census holds, not the lock.
 */
export function ruleVerbs(role: string, table: string): ReadonlySet<string> {
  ruleRows ??= readFileSync(join(SCRIPTS, "runtime-roles.tsv"), "utf8").split("\n")
    .filter((l) => l !== "" && !l.startsWith("#")).slice(1).map((l) => l.split("\t"));
  const rule = ruleRows.find((r) => r[0] === "verbs" && r[1] === role && r[2] === table)
    ?? ruleRows.find((r) => r[0] === "verbs" && r[1] === role && r[2] === "*");
  const value = rule?.[3] ?? "-";
  return new Set(value === "-" ? [] : value.split(" "));
}

/** The billing plane's five grants, as its own script writes them. */
const PLANE_GRANTS = [
  `grant select on public.accounts, public.account_storage, public.mailboxes to ${PLANE_ROLE}`,
  `grant select (id) on public.staff_users to ${PLANE_ROLE}`,
  `grant insert on public.audit_log to ${PLANE_ROLE}`,
];

export interface LockGround {
  readonly server: OwnServer;
  readonly major: PgMajor;
  /** A URL on `database` as `role` (the superuser when none). Never logged: it carries a password. */
  urlAs(database: string, role?: string): string;
  /** One connection on `database` as `role`; the caller ends it. */
  connectAs(database: string, role?: string, onnotice?: (text: string) => void): postgres.Sql;
  /** The setup on `database`, as `role` (the superuser when none). */
  setup(database: string, role?: string, opts?: ProdSetupOptions): Promise<ProdSetupReport>;
  /** The staff role's and the runtime roles' scripts as the superuser, the passwords and the plane: the runtime script's notices. */
  makeRoles(database: string): Promise<string[]>;
  /** The runtime roles' script run whole on `database` as `role` (the migrator when none), as a release runs it again: its notices. */
  runRolesScript(database: string, role?: string): Promise<string[]>;
  /** A database of its own, cloned from `template` (nobody may be connected to it). */
  clone(template: string, name: string): Promise<string>;
  /** Give `role`, one a case made or renamed, the password this ground draws for its name, so the case may sign in as it. */
  password(role: string): Promise<void>;
  stop(): void;
}

/** Start a server and make `database` on it, empty. */
export async function startLockGround(major: PgMajor, label: string, database: string): Promise<LockGround> {
  const server = await startOwnServer(major, label);
  const passwords = new Map<string, string>();
  const passwordOf = (role: string): string => {
    let pw = passwords.get(role);
    if (pw === undefined) { pw = randomBytes(18).toString("hex"); passwords.set(role, pw); }
    return pw;
  };
  const isSuper = (role?: string): boolean => role === undefined || role === server.superuser;
  const urlAs = (db: string, role?: string): string => (isSuper(role) ? server.url(db) : server.url(db, role, passwordOf(role!)));
  const connectAs = (db: string, role?: string, onnotice?: (text: string) => void): postgres.Sql =>
    (isSuper(role) ? server.connect(db, undefined, undefined, onnotice) : server.connect(db, role, passwordOf(role!), onnotice));
  const asSuper = async (db: string, statements: string[] | string, onnotice?: (text: string) => void): Promise<void> => {
    const sql = connectAs(db, undefined, onnotice);
    try {
      for (const s of typeof statements === "string" ? [statements] : statements) await sql.unsafe(s).simple();
    } finally {
      await sql.end({ timeout: 5 });
    }
  };
  try {
    await asSuper("postgres", `create database "${database}"`);
  } catch (e) {
    server.stop();
    throw e;
  }
  return {
    server, major, urlAs, connectAs,
    setup: (db, role, opts = {}) => setupProdDatabase(urlAs(db, role), { log: () => {}, ...opts }),
    async makeRoles(db) {
      await asSuper(db, readFileSync(join(SCRIPTS, "harden-staff-role.sql"), "utf8"));
      const said: string[] = [];
      await asSuper(db, readFileSync(join(SCRIPTS, "harden-runtime-roles.sql"), "utf8"), (t) => said.push(t));
      // The passwords the logins are given out of band; hex, so no quote can close the literal.
      await asSuper(db, [MIGRATOR_ROLE, API_ROLE, WORKER_ROLE, STAFF_ROLE].map((r) => `alter role ${r} password '${passwordOf(r)}'`));
      await asSuper(db, [`create role ${PLANE_ROLE} login password '${passwordOf(PLANE_ROLE)}'`, ...PLANE_GRANTS]);
      return said;
    },
    async runRolesScript(db, role = MIGRATOR_ROLE) {
      const said: string[] = [];
      const sql = connectAs(db, role, (t) => said.push(t));
      try {
        await sql.unsafe(readFileSync(join(SCRIPTS, "harden-runtime-roles.sql"), "utf8")).simple();
      } finally {
        await sql.end({ timeout: 5 });
      }
      return said;
    },
    async clone(template, name) {
      await asSuper("postgres", `create database "${name}" template "${template}" owner ${MIGRATOR_ROLE}`);
      return name;
    },
    async password(role) {
      if (!/^[a-z_][a-z0-9_]*$/.test(role)) throw new Error(`not a plain role name: ${role}`);
      await asSuper("postgres", `alter role ${role} password '${passwordOf(role)}'`);
    },
    stop: () => server.stop(),
  };
}
