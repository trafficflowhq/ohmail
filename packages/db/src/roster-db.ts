import { sql, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { schema } from "./schema.js";
import { bindDb } from "./bound.js";
import { makeOwnedDb, makePooledDb } from "./client.js";

/**
 * THE ROSTER HANDLE: the API process's third connection, signed in as the worker's role, for the
 * clock's passes that read across accounts. Its statements read only the
 * tables the worker's role reads wide; a pass reads its roster through it, then binds each
 * account and does the rest. Its own type, like the staff handle's: no request context carries
 * it, and `bindDb(roster, { account })` is the way from it to a `BoundDb`.
 *
 * The brand is a `declare const`, so it exists only in the type system and nothing outside its
 * factory can mint one.
 */
declare const roster: unique symbol;

/** @see roster */
export interface Roster {
  readonly [roster]: "ohmail_worker";
}

/** A handle that has proven it is signed in as the worker's role. Minted only by its factory. */
export type RosterDb = PostgresJsDatabase<typeof schema> & Roster;

/** The worker's runtime role: the one a roster handle must be signed in as. */
export const ROSTER_ROLE = "ohmail_worker";

/**
 * Refusal to mint a roster handle. Carries no connection string and no driver message; `cause` is
 * set only where a statement could not run, so an unreachable database is told from a verdict.
 */
export class NotRosterError extends Error {
  constructor(readonly reason: string, opts?: { cause?: unknown }) {
    super(`refusing to build the roster handle: ${reason}. Its address must sign in as a worker role ` +
      "that owns nothing, cannot bypass row security, and reads only the worker's wide tables unbound");
    this.name = "NotRosterError";
    if (opts?.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause;
  }
}

/** What the attestation compares against: the role's name, and the policies that name it (`schema.table.policy`). */
export interface RosterExpectation {
  readonly role: string;
  readonly policies: readonly string[];
}

/** `attested`, or `attested-empty`: no mailbox row answered the second bite, so it is asked again next time. */
export type RosterVerdict = "attested" | "attested-empty";

type Execute = Pick<PostgresJsDatabase<typeof schema>, "execute">;

/** One statement of the attestation, on a flight bound to nothing; a statement that cannot run refuses. */
async function ask(db: object, what: string, statement: SQL): Promise<Array<Record<string, unknown>>> {
  try {
    return await (bindDb(db, { account: null }) as unknown as Execute).execute(statement) as unknown as Array<Record<string, unknown>>;
  } catch (err) {
    throw new NotRosterError(`${what} could not be read`, { cause: err });
  }
}

/**
 * ATTEST THAT `db` IS THE WORKER'S ROLE AND THE LOCK HOLDS FOR IT, or throw {@link NotRosterError}.
 * Each statement runs in a flight bound to nothing, as the roster's own reads do.
 *
 * 1. The catalog: signed in as `expect.role`, the session's user being the current one; not a
 *    superuser; no bypass, create-role, create-database or replication right; a member of no role;
 *    owner of nothing.
 * 2. Row security is live for this role on `mailboxes` and `message_bodies`: both bites below say
 *    nothing on a table it does not cover.
 * 3. Bite one: an unbound read of `message_bodies` answers no row.
 * 4. Bite two: an unbound read of `mailboxes` answers a row. No row is accepted only beside an equal
 *    census, and is not remembered.
 * 5. The census: the policies naming this role are exactly `expect.policies`.
 *
 * Exported with the role's name as an input, so a test attests a role it made under a name of its
 * own (roles are cluster-wide).
 */
export async function assertRoster(db: object, expect: RosterExpectation): Promise<RosterVerdict> {
  const [who] = await ask(db, "the role's catalog row", sql`select r.rolname = ${expect.role} as named,
      session_user = current_user as same, r.rolsuper as super, r.rolbypassrls as bypass,
      r.rolcreaterole as createrole, r.rolcreatedb as createdb, r.rolreplication as replication,
      (select count(*) from pg_catalog.pg_auth_members m where m.member = r.oid)::int as memberships,
      (select count(*) from pg_catalog.pg_shdepend d where d.refobjid = r.oid and d.deptype = 'o')::int as owned
    from pg_catalog.pg_roles r where r.rolname = current_user`);
  if (who === undefined) throw new NotRosterError("the connected role has no catalog row");
  if (who.named !== true) throw new NotRosterError(`the connected role is not ${expect.role}`);
  if (who.same !== true) throw new NotRosterError("the session's user is not the current user");
  for (const right of ["super", "bypass", "createrole", "createdb", "replication"] as const) {
    if (who[right] !== false) throw new NotRosterError(`the connected role holds the ${right} attribute`);
  }
  if (who.memberships !== 0) throw new NotRosterError("the connected role is a member of another role");
  if (who.owned !== 0) throw new NotRosterError("the connected role owns objects");

  const [live] = await ask(db, "whether row security is live", sql`select
      pg_catalog.row_security_active('mailboxes') as mailboxes,
      pg_catalog.row_security_active('message_bodies') as bodies`);
  if (live?.mailboxes !== true || live.bodies !== true) {
    throw new NotRosterError("row security is not live for this role on mailboxes and message_bodies");
  }

  const bodies = await ask(db, "the first bite", sql`select 1 as one from message_bodies limit 1`);
  if (bodies.length !== 0) throw new NotRosterError("an unbound read of message_bodies answered a row");
  const boxes = await ask(db, "the second bite", sql`select 1 as one from mailboxes limit 1`);

  const census = await ask(db, "the policy census", sql`select p.schemaname || '.' || p.tablename || '.' || p.policyname as policy
    from pg_catalog.pg_policies p where ${expect.role}::name = any(p.roles) order by 1`);
  const held = census.map((r) => String(r.policy));
  const wanted = [...expect.policies].sort();
  if (held.length !== wanted.length || held.some((p, i) => p !== wanted[i])) {
    throw new NotRosterError(`the policies naming the role are not the worker's list (${held.length} held, ${wanted.length} expected)`);
  }
  return boxes.length === 1 ? "attested" : "attested-empty";
}

/** One pool per address and kind, kept for the process: an attestation that failed is asked again on it. */
const pools = new Map<string, object>();
/** A success, remembered; a failure or an empty second bite, never. */
const minted = new Map<string, Promise<RosterDb>>();

/**
 * The roster handle's factory for `url`, beside the staff handle's (`admin-db.ts`) and in its
 * shape: lazy, attested at first use, a success remembered and a failure never, and no fallback
 * anywhere on its path. `pool` and `policies` have no default: a composition without the address
 * builds no factory, and its passes refuse.
 */
export function rosterDbFor(
  url: string, opts: { readonly pool: "session" | "pooler"; readonly policies: readonly string[] },
): () => Promise<RosterDb> {
  if (opts?.pool !== "session" && opts?.pool !== "pooler") throw new TypeError("rosterDbFor: the pool kind is named, never defaulted");
  if (!Array.isArray(opts.policies)) throw new TypeError("rosterDbFor: the worker's policy list is named, never defaulted");
  const key = JSON.stringify([url, opts.pool]);
  const policies = [...opts.policies];
  return () => {
    const held = minted.get(key);
    if (held !== undefined) return held;
    let db = pools.get(key);
    if (db === undefined) {
      db = opts.pool === "pooler" ? makePooledDb(url, { role: "roster" }) : makeOwnedDb(url, { role: "roster" }).db;
      pools.set(key, db);
    }
    const handle = db;
    const verdict = assertRoster(handle, { role: ROSTER_ROLE, policies });
    const pending = verdict.then(() => handle as RosterDb);
    minted.set(key, pending);
    verdict.then(
      (v) => { if (v !== "attested" && minted.get(key) === pending) minted.delete(key); },
      () => { if (minted.get(key) === pending) minted.delete(key); },
    );
    return pending;
  };
}
