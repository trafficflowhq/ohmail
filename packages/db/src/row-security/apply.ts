import type postgres from "postgres";
import {
  LOCK_READERS, POLICY_COMMENT_TAG, POLICY_ROLES, READER_SCHEMA, RUNTIME_LOGINS, readerStatement,
} from "./names.js";
import { ROLE_DEADLINES, deadlineText } from "./deadlines.js";
import { lockedTables, type PolicyRow } from "./policies.js";
import {
  catalogDigest, codeLines, expectedPolicies, listDigest, lockDrift, lockedOf, markerOf, partitionLines, policyComment, readLockFacts,
  readerDifferences, readerOf, type Exec, type LockFacts,
} from "./census.js";
import { runRolesCheck, RUNTIME_ROLES_SCRIPT } from "./roles-check.js";

/**
 * THE SETUP'S LOCK STEP: on a server whose runtime logins exist, make the readers, put every locked
 * table under forced row security, make exactly the listed policies, and set the deadlines by role
 * name; then take the census, inside the same transaction, and roll everything back on any drift.
 *
 * WHEN IT ACTS. On a server without the logins (a self-hosted server, every test database) it asks
 * one question of the catalog and does nothing else: no report field, no log line; only a locked
 * store's own marks there (a forced listed table, a lock policy, the readers' schema: a copy
 * restored without its roles) are refused. Where the logins exist it acts only when asked
 * (`lock: "apply"`, `--lock`) or when the lock already stands in this database by its own work (a
 * policy it made, a listed table it forced; the readers' schema alone is none), so the first setup
 * after the roles are made never locks a database by itself, and a release that forgets the word
 * still locks the table it adds. It writes only what differs: a
 * second run writes nothing. It never turns row security off and never switches a lock that is off
 * back on (that is the switch's). A store that holds a partitioned table or a partition, or code
 * on a table that runs with its owner's rights, is refused with nothing written: the lock takes
 * no partitioned table, and cannot hold code that runs as a table's owner (`census.ts`,
 * `isPartitioned`, `CodeFacts`).
 */

/** How long the step waits for one table's lock before the whole step gives up, unchanged. */
export const LOCK_STEP_LOCK_TIMEOUT = "30s";

/** The differences of a reader that `create or replace function` sets back to the list's. */
const REMADE = new Set(["body", "volatility", "parallel", "security definer", "settings", "language", "strict"]);

export interface LockReport {
  /** `not-applied`: the logins exist and nothing asked for the lock. `locked`/`off`: the lock stands, as the census read it. */
  readonly state: "not-applied" | "locked" | "off";
  /** The policy roles this server has. */
  readonly roles: readonly string[];
  /** Locked tables, and how many are forced. */
  readonly tables: number;
  readonly forced: number;
  /** Policies standing on them. */
  readonly policies: number;
  /** Statements this run wrote: 0 on a run over a lock as listed. */
  readonly wrote: number;
  /** What this run undid: a policy outside the list, one altered by hand, a deadline that drifted. */
  readonly repaired: readonly string[];
  /** Each deadline of each role that exists, read back after the step. */
  readonly deadlines: Readonly<Record<string, Readonly<Record<string, boolean>>>>;
}

export interface LockStep { readonly report?: LockReport; readonly problems: readonly string[] }

/** The step's session: one connection that can run a transaction (the setup's migration session). */
export type LockSession = Pick<postgres.Sql, "unsafe" | "begin">;

const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;
const list = (roles: readonly string[]): string => roles.map(quote).join(", ");

/** The statement that makes `r`. */
export function createPolicyStatement(r: PolicyRow): string {
  const verb = r.verb === "ALL" ? "all" : r.verb.toLowerCase();
  return `create policy ${quote(r.name)} on public.${quote(r.table)} as permissive for ${verb} to ${list(r.roles)}`
    + `${r.using === null ? "" : ` using (${r.using})`}${r.check === null ? "" : ` with check (${r.check})`}`;
}

/**
 * What the step must find before it writes, in one catalog read: the policy roles; the listed tables
 * that are FORCED (forcing is the lock's alone: an owner who only enables row security, as a
 * database advisor asks, forces nothing); the policies the lock made (its comment on them, or a
 * `lock_` name naming a runtime login); any `lock_` policy at all; and whether the readers' schema
 * is there.
 */
interface Presence {
  readonly roles: string[];
  readonly forced: number;
  readonly made: number;
  readonly named: number;
  readonly schema: boolean;
}

async function presence(db: Exec): Promise<Presence> {
  const [row] = await db.unsafe(`select
      (select coalesce(pg_catalog.array_agg(r.rolname::text order by r.rolname), '{}') from pg_catalog.pg_roles r where r.rolname = any($1::text[])) as roles,
      (select count(*)::int from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relforcerowsecurity and c.relname = any($3::text[])) as forced,
      (select count(*)::int from pg_catalog.pg_policy p join pg_catalog.pg_class c on c.oid = p.polrelid
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and (pg_catalog.obj_description(p.oid, 'pg_policy') like $4
               or (p.polname like 'lock\\_%' and exists (select 1 from pg_catalog.pg_roles r
                     where r.oid = any(p.polroles) and r.rolname = any($5::text[]))))) as made,
      (select count(*)::int from pg_catalog.pg_policy p join pg_catalog.pg_class c on c.oid = p.polrelid
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and p.polname like 'lock\\_%') as named,
      exists (select 1 from pg_catalog.pg_namespace where nspname = $2) as schema`,
  [[...POLICY_ROLES], READER_SCHEMA, lockedTables(), `${POLICY_COMMENT_TAG} %`, [...RUNTIME_LOGINS]]) as unknown as Presence[];
  return row!;
}

/** A refusal of the step: its lines are problems, and nothing was written. */
class LockRefused extends Error {
  constructor(readonly lines: string[]) { super(lines.join("; ")); }
}

/**
 * THE STEP. `url` is the setup's own address (the roles' check dials it on a connection of its own);
 * `session` runs the transaction. Never throws for a refusal: its lines come back as problems.
 */
export async function ensureLock(
  url: string, session: LockSession,
  opts: { readonly asked: boolean; readonly log?: (m: string) => void; readonly rolesScript?: string },
): Promise<LockStep> {
  const log = opts.log ?? (() => {});
  const found = await presence(session);
  const logins = RUNTIME_LOGINS.filter((r) => found.roles.includes(r));
  if (logins.length === 0) {
    // A server without the logins: nothing to lock. A locked store's own marks here are a copy of
    // one restored without its roles, whose forced tables its owner cannot read; nothing here
    // unlocks it. Row security an owner turned on by itself is that owner's own, and no concern here.
    if (found.forced === 0 && found.named === 0 && !found.schema) return { problems: [] };
    return {
      problems: [`lock: this database carries a locked store's marks (${found.forced} tables forced, ${found.named} lock policies, `
        + `the schema ${READER_SCHEMA} ${found.schema ? "present" : "absent"}) and this server has none of its runtime logins; nothing was changed. `
        + `Serve it where its runtime roles exist, or take the lock off by hand: its policies, the schema ${READER_SCHEMA} and row security on those tables`],
    };
  }
  const base = { roles: found.roles, tables: 0, forced: 0, policies: 0, wrote: 0, repaired: [], deadlines: {} } as const;
  // The lock stands only by its own work: a policy it made, or a listed table it forced. The
  // readers' schema alone is no lock.
  const standing = found.made > 0 || found.forced > 0;
  if (!opts.asked && !standing) {
    log(`lock: the runtime logins exist (${logins.join(", ")}) and no lock stands here; nothing written (the setup locks with --lock)`);
    return { report: { ...base, state: "not-applied" }, problems: [] };
  }
  if (logins.length !== RUNTIME_LOGINS.length) {
    return { report: { ...base, state: "not-applied" }, problems: [`lock: refused: of the two runtime logins only ${logins.join(", ")} exists`] };
  }
  const check = await runRolesCheck(url, opts.rolesScript ?? RUNTIME_ROLES_SCRIPT);
  if (!check.ok) {
    return { report: { ...base, state: "not-applied" }, problems: check.refusals.map((r) => `lock: the runtime roles' check refused: ${r}`) };
  }
  try {
    const report = await session.begin(async (tx) => {
      await tx.unsafe(`set local lock_timeout = '${LOCK_STEP_LOCK_TIMEOUT}'`);
      const before = await readLockFacts(tx);
      // A partitioned table or a partition the lock cannot hold, code on a table that runs with its
      // owner's rights, and a reader `create or replace` cannot mend (its kind, return type, owner
      // or rights), are the census's refusal before anything is written: a parent locked alone
      // leaves its partitions open, code run as a table's owner reads past any policy, and a policy
      // made over such a reader could fail obscurely.
      const unmendable = LOCK_READERS.flatMap((r) => {
        const f = readerOf(before, r);
        const differs = f === undefined ? [] : readerDifferences(f, r, before.schema!.owner);
        return differs.some((d) => !REMADE.has(d)) ? [`LOCK_DRIFT readers.differ ${READER_SCHEMA}.${r.name}: ${differs.join(", ")}`] : [];
      });
      const refused = [...partitionLines(before), ...codeLines(before), ...unmendable];
      if (refused.length > 0) throw new LockRefused(refused);
      const { wrote, repaired } = await write(tx, before, standing, log);
      const after = await readLockFacts(tx);
      const drift = lockDrift(after);
      if (drift.length > 0) throw new LockRefused(drift);
      return reportOf(after, wrote, repaired, await readDeadlines(tx, Object.keys(after.roles)));
    });
    log(`lock: ${report.state}, ${report.forced}/${report.tables} tables forced, ${report.policies} policies, ${report.wrote} statements written`
      + `${report.repaired.length > 0 ? `; repaired: ${report.repaired.join("; ")}` : ""}`);
    const problems = Object.entries(report.deadlines).flatMap(([role, cells]) =>
      Object.entries(cells).filter(([, ok]) => !ok).map(([guc]) => `lock: the server deadline ${guc} did not take on ${role}`));
    return { report, problems };
  } catch (err) {
    if (err instanceof LockRefused) return { report: { ...base, state: "not-applied" }, problems: err.lines.map((l) => `lock: ${l}; nothing was written`) };
    throw err;
  }
}

/**
 * Write what differs between `facts` and the list, in table order; answer what was written and
 * repaired. `stood`: the lock stood here before this run, so what of it is found missing or
 * unlocked was taken away, and each is named as a repair. On a first lock, and on a table a
 * release just made (no flag and no listed policy yet), what is written is no repair. `tx` is the
 * transaction `facts` were read in, so the settings `readLockFacts` pinned for it hold here: each
 * policy is made, and its spelling recorded, under them (`SPELLING_SETTINGS`), whatever the
 * migrator's session, role or database sets.
 */
async function write(tx: Exec, facts: LockFacts, stood: boolean, log: (m: string) => void): Promise<{ wrote: number; repaired: string[] }> {
  const ddl: string[] = [];
  const repaired: string[] = [];
  const want = new Map(expectedPolicies(facts).map((r) => [`${r.table}.${r.name}`, r]));
  /** Whether the lock held `table`: under row security or forced, or holding a listed policy. */
  const lockHeld = (table: string): boolean => facts.tables.some((t) => t.name === table && (t.rls || t.forced))
    || facts.policies.some((p) => p.table === table && want.has(`${p.table}.${p.name}`));
  if (facts.schema === null) {
    if (stood) repaired.push(`schema ${READER_SCHEMA} was missing: made`);
    ddl.push(`create schema ${READER_SCHEMA}`);
  }
  for (const r of LOCK_READERS) {
    const f = readerOf(facts, r);
    if (f === undefined) {
      if (stood) repaired.push(`reader ${READER_SCHEMA}.${r.name} was missing: made`);
      ddl.push(readerStatement(r));
      continue;
    }
    // What `create or replace` mends; a reader whose kind, return type, owner or rights differ is
    // left for the census to refuse, by hand.
    const differs = readerDifferences(f, r, facts.schema!.owner);
    if (differs.length > 0 && differs.every((d) => REMADE.has(d))) {
      repaired.push(`reader ${READER_SCHEMA}.${r.name} made again: ${differs.join(", ")}`);
      ddl.push(readerStatement(r));
    }
  }
  // Under forced row security, unless the switch has turned the lock off: then the flags are its.
  const off = markerOf(facts);
  if (off === null || off === "unreadable") {
    for (const t of lockedOf(facts)) {
      if (t.rls && t.forced) continue;
      if (stood && lockHeld(t.name)) repaired.push(`table ${t.name} was on=${t.rls} forced=${t.forced}: locked again`);
      if (!t.rls) ddl.push(`alter table public.${quote(t.name)} enable row level security`);
      if (!t.forced) ddl.push(`alter table public.${quote(t.name)} force row level security`);
    }
  }
  // Exactly the listed policies: a foreign one goes, one altered or made from another list is made again.
  const made: PolicyRow[] = [];
  for (const p of facts.policies) {
    const key = `${p.table}.${p.name}`;
    const r = want.get(key);
    const recorded = (p.comment ?? "").split(" ");
    const ours = recorded.length === 3 && recorded[0] === POLICY_COMMENT_TAG;
    if (r !== undefined && p.permissive && ours && recorded[1] === listDigest(r) && recorded[2] === catalogDigest(p)) continue;
    ddl.push(`drop policy ${quote(p.name)} on public.${quote(p.table)}`);
    if (r === undefined) { repaired.push(`policy ${key} is not the list's: dropped`); continue; }
    // A row of the list that changed is made again; anything else under a listed name is a repair.
    if (!(ours && recorded[1] !== listDigest(r) && p.permissive)) repaired.push(`policy ${key} is not as it was made: made again`);
    ddl.push(createPolicyStatement(r));
    made.push(r);
  }
  for (const [key, r] of want) {
    if (facts.policies.some((p) => `${p.table}.${p.name}` === key)) continue;
    // On a table the lock already held, a listed policy that is gone was taken away: a repair.
    if (stood && lockHeld(r.table)) repaired.push(`policy ${key} was missing: made`);
    ddl.push(createPolicyStatement(r));
    made.push(r);
  }
  // The deadlines by role name, on the role alone; the migrator's own are the setup's loop's.
  const deadlineSql: string[] = [];
  const held = await roleSettings(tx);
  for (const [role, cell] of Object.entries(ROLE_DEADLINES)) {
    if (!(role in facts.roles)) continue;
    for (const [guc, ms] of Object.entries(cell)) {
      if (held[role]?.[guc] === deadlineText(ms)) continue;
      if (held[role]?.[guc] !== undefined) repaired.push(`deadline ${guc} on ${role} was ${held[role]![guc]}`);
      deadlineSql.push(`alter role ${quote(role)} set ${guc} = '${deadlineText(ms)}'`);
    }
  }
  const statements = [...ddl, ...deadlineSql];
  if (statements.length > 0) await tx.unsafe(statements.join(";\n")).simple();
  if (made.length > 0) {
    const printed = await tx.unsafe(`select c.relname as table, p.polname as name, p.polcmd as verb,
        (select coalesce(pg_catalog.array_agg(pg_catalog.pg_get_userbyid(x.r)::text order by 1), '{}') from pg_catalog.unnest(p.polroles) as x(r)) as roles,
        pg_catalog.pg_get_expr(p.polqual, p.polrelid) as using, pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) as check
      from pg_catalog.pg_policy p join pg_catalog.pg_class c on c.oid = p.polrelid join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and (c.relname::text, p.polname::text) in (select * from rows from (pg_catalog.unnest($1::text[]), pg_catalog.unnest($2::text[])))`,
    [made.map((r) => r.table), made.map((r) => r.name)]) as unknown as Array<{ table: string; name: string; verb: string; roles: string[]; using: string | null; check: string | null }>;
    const comments = made.map((r) => {
      const p = printed.find((x) => x.table === r.table && x.name === r.name)!;
      return `comment on policy ${quote(r.name)} on public.${quote(r.table)} is '${policyComment(r, p)}'`;
    });
    await tx.unsafe(comments.join(";\n")).simple();
  }
  if (repaired.length > 0) for (const r of repaired) log(`lock: repair: ${r}`);
  return { wrote: statements.length + made.length, repaired };
}

/** Each role's own settings (no database scope), as `guc → text`. */
async function roleSettings(tx: Exec): Promise<Record<string, Record<string, string>>> {
  const rows = await tx.unsafe(`select r.rolname as role, kv from pg_catalog.pg_db_role_setting s
      join pg_catalog.pg_roles r on r.oid = s.setrole cross join lateral pg_catalog.unnest(s.setconfig) as kv
     where s.setdatabase = 0 and r.rolname = any($1::text[])`, [Object.keys(ROLE_DEADLINES)]) as unknown as Array<{ role: string; kv: string }>;
  const out: Record<string, Record<string, string>> = {};
  for (const { role, kv } of rows) {
    const eq = kv.indexOf("=");
    if (eq > 0) (out[role] ??= {})[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
  return out;
}

function reportOf(facts: LockFacts, wrote: number, repaired: string[], deadlines: LockReport["deadlines"]): LockReport {
  const locked = lockedOf(facts);
  const marker = markerOf(facts);
  return {
    state: marker !== null && marker !== "unreadable" ? "off" : "locked",
    roles: Object.keys(facts.roles).sort(),
    tables: locked.length,
    forced: locked.filter((t) => t.rls && t.forced).length,
    policies: facts.policies.length,
    wrote,
    repaired,
    deadlines,
  };
}

/** The deadlines of each role that exists, read back. */
export async function readDeadlines(db: Exec, roles: readonly string[]): Promise<Record<string, Record<string, boolean>>> {
  const held = await roleSettings(db);
  return Object.fromEntries(Object.entries(ROLE_DEADLINES).filter(([role]) => roles.includes(role)).map(([role, cell]) =>
    [role, Object.fromEntries(Object.entries(cell).map(([guc, ms]) => [guc, held[role]?.[guc] === deadlineText(ms)]))]));
}
