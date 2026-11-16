import { sql } from "drizzle-orm";
import { ACCOUNT_TABLES, accountViewRelations, type AccountRelations } from "../account-rows.js";
import { poolKeyOf } from "../bound.js";
import { READER_SCHEMA, RUNTIME_LOGINS } from "./logins.js";
import { ACCOUNT_VIEWS } from "./views.js";

/**
 * WHICH OF THE TWO ANSWERS (`account-rows.ts`) A POOL HANDLE READS: the hosted database's one catalog
 * read, and the views' answer.
 *
 * One catalog read per pool handle (`poolKeyOf`): a request's own bound view asks nothing again.
 * Never an environment variable. A release whose journal drops a view needs a closed window: until
 * the setup's lock step makes it again, a view the answer named reads 42P01, then 42501 until the
 * roles' apply grants it.
 *
 * THE HOSTED DATABASE'S ALONE, exported from `@trafficflow/db/cloud` and never from the package's root:
 * its statement is one only Postgres accepts, and the lock's list it reads the views' names from
 * (`views.ts`) holds every locked table's index reads. A device's engine loads neither. A store
 * without the lock asks nothing: it reads `ACCOUNT_TABLES`.
 */

/** The account's views: a runtime login's handle where the three stand and it may read them. */
export const ACCOUNT_VIEW_RELATIONS: AccountRelations = accountViewRelations(READER_SCHEMA);

const LOGINS = sql.join(RUNTIME_LOGINS.map((l) => sql`${l}`), sql`, `);

/**
 * The one catalog read: is the connected role a runtime login that may read every view (`views`),
 * and which runtime login it is, if one (`login`: a name of `RUNTIME_LOGINS`, or null).
 */
export const ACCOUNT_ROWS_SQL = sql`select (current_user::text in (${LOGINS})
    and (select pg_catalog.count(*) from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
          where n.nspname = ${READER_SCHEMA} and c.relkind = 'v' and c.relname::text in (${sql.join(ACCOUNT_VIEWS.map((v) => sql`${v.name}`), sql`, `)})
            and pg_catalog.has_schema_privilege(n.oid, 'USAGE') and pg_catalog.has_table_privilege(c.oid, 'SELECT')) = ${ACCOUNT_VIEWS.length})
  as views,
  case when current_user::text in (${LOGINS}) then current_user::text end as login`;

/** Anything that runs one statement: a drizzle handle, bound or not. */
export interface AccountRowsExecutor { execute(query: ReturnType<typeof sql>): Promise<unknown> }

export interface AccountRowsOptions {
  /** Where the one line a pool handle says when it is first answered goes; `console.info` when none. */
  readonly log?: (line: string) => void;
}

const memo = new WeakMap<object, Promise<AccountRelations>>();
/** The road each pool handle was answered, once it was: what the health line reads, asking nothing. */
const answered = new WeakMap<object, AccountRelations["through"]>();

/**
 * The relations `db`'s index-driven reads name; asked of the catalog once per pool handle. When a pool
 * handle is first answered it says its road in one line (the views or the tables, and the kind of role:
 * which runtime login, or none), never an account or an address: a pool a runtime login made while the
 * views stood unreadable to it (between the lock step and the roles' apply) reads the tables for its
 * life, slower, and the line and the health line ({@link accountRowsAnswered}) are how an instance shows
 * it. It is not asked again: a restart after the roles' apply mends it.
 */
export function accountRows(db: AccountRowsExecutor & object, opts: AccountRowsOptions = {}): Promise<AccountRelations> {
  const key = poolKeyOf(db);
  let answer = memo.get(key);
  if (answer === undefined) {
    const log = opts.log ?? ((line: string): void => { console.info(line); });
    answer = db.execute(ACCOUNT_ROWS_SQL).then((r) => {
      const rows = Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? []);
      const row = rows[0] as { views?: unknown; login?: unknown } | undefined;
      const relations = row?.views === true ? ACCOUNT_VIEW_RELATIONS : ACCOUNT_TABLES;
      const login = (RUNTIME_LOGINS as readonly unknown[]).includes(row?.login) ? String(row!.login) : null;
      answered.set(key, relations.through);
      log(accountRowsLine(relations.through, login));
      return relations;
    });
    // A read that failed is asked again next time, never kept.
    answer.catch(() => { if (memo.get(key) === answer) memo.delete(key); });
    memo.set(key, answer);
  }
  return answer;
}

/** The road `db`'s pool handle was answered, asking nothing: `null` until it has been. */
export function accountRowsAnswered(db: object): AccountRelations["through"] | null {
  return answered.get(poolKeyOf(db)) ?? null;
}

/** The one line a pool handle says when it is first answered: its road, and what kind of role it is. */
export function accountRowsLine(through: AccountRelations["through"], login: string | null): string {
  if (through === "views") return `account rows: this pool reads the account's views (the runtime login ${login ?? "?"})`;
  return login === null
    ? "account rows: this pool reads the tables (a role that is no runtime login)"
    : `account rows: this pool reads the tables (the runtime login ${login}, to which the account's views are not all readable: `
      + "a pool made after the roles' apply reads them)";
}
