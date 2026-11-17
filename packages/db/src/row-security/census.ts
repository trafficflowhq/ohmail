import { createHash } from "node:crypto";
import type postgres from "postgres";
import { MAP_2_0, tablesOf } from "../transition/expected-counts.js";
import { STAFF_ROLE } from "../staff-grants.js";
import {
  LOCK_MARKER, LOCK_READERS, PLANE_ROLE, POLICY_COMMENT_TAG, POLICY_ROLES, READER_SCHEMA, RUNTIME_LOGINS,
  ACCOUNT_SETTING, KEY_SETTING, type LockReader,
} from "./names.js";
import { policiesFor, policiesOfTable, tableClass, byTableThenName, type PolicyRow, type PolicyVerb } from "./policies.js";
import { ACCOUNT_VIEWS, VIEW_CHECK_OPTION, viewName, viewStatement, type AccountView } from "./views.js";

/**
 * THE LOCK'S CENSUS: one catalog statement, compared with the list both ways. Every line it answers
 * is `LOCK_DRIFT <arm> <subject>`, catalog names only. Read inside a transaction whose search path
 * is empty and whose other spelling settings are pinned ({@link SPELLING_SETTINGS}), so a stored
 * expression prints the same way on every read.
 *
 * Each policy the step makes carries a comment `ohmail-lock <list> <catalog>`: the digest of its
 * row of the list, and the digest of what the catalog printed for it right after it was made. So a
 * policy made from another version of the list, and one altered by hand under its listed name, are
 * both seen, with no file of recorded SQL and on any server version.
 */

/** Anything that runs one statement and answers rows (a session, a transaction). */
export type Exec = Pick<postgres.Sql, "unsafe">;

/**
 * A table of `public`. `partitioned`: it is a partitioned table; `partitionOf`: it is a partition,
 * of that table. Neither is a table the lock can hold (see {@link partitionLines}).
 */
export interface TableFacts {
  readonly name: string; readonly rls: boolean; readonly forced: boolean; readonly account: boolean; readonly owner: string;
  readonly partitioned: boolean; readonly partitionOf: string | null;
}
export interface PolicyFacts {
  readonly table: string; readonly name: string; readonly permissive: boolean; readonly verb: string;
  readonly roles: readonly string[]; readonly using: string | null; readonly check: string | null; readonly comment: string | null;
}
export interface ReaderFacts {
  readonly name: string; readonly identity: string; readonly src: string; readonly volatile: string; readonly parallel: string;
  readonly secdef: boolean; readonly config: readonly string[] | null; readonly lang: string; readonly returns: string;
  readonly owner: string; readonly args: number; readonly acl: readonly string[] | null; readonly strict: boolean; readonly kind: string;
}

/**
 * Code on a table of `public` that runs with its owner's rights, whoever makes it fire: a rewrite
 * rule (its actions run as the table's owner), and a trigger, a default or generated column, a
 * constraint or an index that calls a SECURITY DEFINER routine (`routine`; what it depends on, by
 * `pg_depend`). A table's owner bypasses row security, so each reads and writes past the lock for the
 * login that fires it, whatever the routine's schema and grants: a trigger runs its routine with
 * no EXECUTE asked, and an expression calls its routine by its id, with no USAGE on its schema
 * asked. Like a view or a definer routine of `public`, the lock cannot hold it.
 */
export interface CodeFacts {
  readonly table: string;
  readonly kind: "rule" | "trigger" | "default" | "generated column" | "constraint" | "index";
  /** The rule's, trigger's, constraint's or index's name; the column's for a default or a generated column. */
  readonly name: string;
  /** The SECURITY DEFINER routine it calls, as `schema.name(argument types)`; none for a rule. */
  readonly routine: string | null;
}

/**
 * CODE ON A VIEW: a rule beside its `_RETURN` (on insert, update or delete, instead or also), a
 * trigger (INSTEAD OF, or for each statement), and a default on one of its columns. A rule or an
 * INSTEAD OF trigger takes the view's writes away from its check option, for every holder of a
 * verb; a SECURITY DEFINER routine a trigger or a default calls runs with its owner's rights.
 * `create or replace view` keeps each (seen on 16 and 17). The step never makes one.
 */
export interface ViewCode {
  readonly kind: "rule" | "trigger" | "default";
  /** The rule's or the trigger's name; the column's for a default. */
  readonly name: string;
  /** A rule's event: INSERT, UPDATE or DELETE; none for a trigger or a default. */
  readonly on: string | null;
}

/**
 * One right on a relation, as the catalog holds it: who (`null` is PUBLIC), the privilege, and
 * whether it carries the grant option; on a column, the column. Each field apart, never joined into
 * one string: a role's name may hold any character, a colon among them (joined, a role
 * named `ohmail_api:SELECT` would read as the login's own right).
 */
export interface Right {
  readonly grantee: string | null; readonly privilege: string; readonly grantable: boolean;
}
export interface ColumnRight extends Right { readonly column: string }

/**
 * A relation of the readers' schema that is a view, or that bears a listed view's name: its kind
 * (`v` for a view), owner, options as the catalog stores them, its text as the catalog prints it
 * (a view's alone), its columns as `name type` in order, its comment (the step's record), who
 * else holds what on it and on its columns ({@link Right}, by grantee and privilege; its owner's
 * own aside), the code on it ({@link ViewCode}), and how many security labels it and its columns
 * carry (a label is its provider's word, and no provider is the lock's: none is expected).
 */
export interface ViewFacts {
  readonly name: string; readonly kind: string; readonly owner: string; readonly options: readonly string[];
  readonly text: string | null; readonly columns: readonly string[]; readonly comment: string | null;
  readonly acl: readonly Right[]; readonly columnAcl: readonly ColumnRight[];
  readonly code: readonly ViewCode[]; readonly labels: number;
}
export interface LockFacts {
  readonly version: number;
  readonly user: string;
  readonly session: string;
  /** The policy roles this server has. */
  readonly roles: Readonly<Record<string, { readonly bypass: boolean; readonly super: boolean }>>;
  readonly tables: readonly TableFacts[];
  readonly policies: readonly PolicyFacts[];
  readonly schema: { readonly owner: string; readonly comment: string | null; readonly usage: readonly string[] } | null;
  readonly readers: readonly ReaderFacts[];
  /** The views of the readers' schema, and any relation there under a listed view's name. */
  readonly views: readonly ViewFacts[];
  /** The columns of each listed view's table, `name → type`: what each view's columns must be. */
  readonly viewTables: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** The readers' schema's other relations (no view, no listed name) and its types. */
  readonly others: readonly string[];
  /**
   * Values of the binding's two settings that reach this database's sessions: a role's everywhere,
   * or this database's. `<role>/<database>/<setting>`, `-` for none.
   */
  readonly bindingSettings: readonly string[];
  /** The tables of `public` the staff role and the plane may read, or insert into, by any grant. */
  readonly grants: Readonly<Record<string, { readonly select: readonly string[]; readonly insert: readonly string[] }>>;
  /** Code on a table of `public` that runs with its owner's rights, by table, kind, name and routine. */
  readonly code: readonly CodeFacts[];
  /**
   * The connected role: whether it may bypass, how much it owns, how many roles it is a member of,
   * how many views, materialized views and foreign tables of `public` it may reach, by a grant on
   * the relation or on one of its columns, to read, insert, update, delete or truncate (each
   * answers with another role's rights: its owner's, or its user mapping's), and how many SECURITY
   * DEFINER routines there it may run; and in the readers' schema, how many relations beside the
   * listed views it may reach the same way, and SECURITY DEFINER routines it may run (`ohmail`).
   */
  readonly connected: {
    readonly name: string; readonly bypass: boolean; readonly super: boolean; readonly owns: number; readonly member: number;
    readonly views: number; readonly definers: number; readonly ohmail: number;
  };
}

const FACTS_SQL = `
select pg_catalog.json_build_object(
  'version', pg_catalog.current_setting('server_version_num')::int,
  'user', current_user::text,
  'session', session_user::text,
  'roles', coalesce((select pg_catalog.json_object_agg(r.rolname, pg_catalog.json_build_object('bypass', r.rolbypassrls, 'super', r.rolsuper))
              from pg_catalog.pg_roles r where r.rolname = any($1::text[])), '{}'::json),
  'tables', coalesce((select pg_catalog.json_agg(pg_catalog.json_build_object(
              'name', c.relname, 'rls', c.relrowsecurity, 'forced', c.relforcerowsecurity,
              'account', exists (select 1 from pg_catalog.pg_attribute a
                                  where a.attrelid = c.oid and a.attname = 'account_id' and a.attnum > 0 and not a.attisdropped),
              'owner', pg_catalog.pg_get_userbyid(c.relowner),
              'partitioned', c.relkind = 'p',
              'partitionOf', (select p.relname from pg_catalog.pg_inherits i join pg_catalog.pg_class p on p.oid = i.inhparent
                               where i.inhrelid = c.oid and c.relispartition)) order by c.relname)
            from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind in ('r', 'p')), '[]'::json),
  'policies', coalesce((select pg_catalog.json_agg(pg_catalog.json_build_object(
              'table', c.relname, 'name', p.polname, 'permissive', p.polpermissive, 'verb', p.polcmd,
              'roles', (select coalesce(pg_catalog.array_agg(case when x.r = 0 then 'public' else pg_catalog.pg_get_userbyid(x.r)::text end order by 1), '{}')
                          from pg_catalog.unnest(p.polroles) as x(r)),
              'using', pg_catalog.pg_get_expr(p.polqual, p.polrelid),
              'check', pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid),
              'comment', pg_catalog.obj_description(p.oid, 'pg_policy')) order by c.relname, p.polname)
            from pg_catalog.pg_policy p
            join pg_catalog.pg_class c on c.oid = p.polrelid
            join pg_catalog.pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public'), '[]'::json),
  'schema', (select pg_catalog.json_build_object(
              'owner', pg_catalog.pg_get_userbyid(n.nspowner),
              'comment', pg_catalog.obj_description(n.oid, 'pg_namespace'),
              'usage', (select coalesce(pg_catalog.array_agg(r.rolname::text order by r.rolname), '{}') from pg_catalog.pg_roles r
                         where r.rolname = any($1::text[]) and pg_catalog.has_schema_privilege(r.oid, n.oid, 'USAGE')))
              from pg_catalog.pg_namespace n where n.nspname = '${READER_SCHEMA}'),
  'readers', coalesce((select pg_catalog.json_agg(pg_catalog.json_build_object(
              'name', p.proname, 'identity', pg_catalog.pg_get_function_identity_arguments(p.oid),
              'src', p.prosrc, 'volatile', p.provolatile, 'parallel', p.proparallel, 'secdef', p.prosecdef,
              'config', p.proconfig, 'lang', l.lanname, 'returns', pg_catalog.format_type(p.prorettype, null),
              'owner', pg_catalog.pg_get_userbyid(p.proowner), 'args', p.pronargs, 'acl', p.proacl::text[],
              'strict', p.proisstrict, 'kind', p.prokind) order by p.proname, p.pronargs, p.oid)
            from pg_catalog.pg_proc p
            join pg_catalog.pg_namespace n on n.oid = p.pronamespace
            join pg_catalog.pg_language l on l.oid = p.prolang
           where n.nspname = '${READER_SCHEMA}'), '[]'::json),
  'views', coalesce((select pg_catalog.json_agg(pg_catalog.json_build_object(
              'name', c.relname, 'kind', c.relkind, 'owner', pg_catalog.pg_get_userbyid(c.relowner),
              'options', coalesce(c.reloptions, '{}'::text[]),
              'text', case when c.relkind = 'v' then pg_catalog.pg_get_viewdef(c.oid) end,
              'columns', (select coalesce(pg_catalog.array_agg(a.attname::text || ' ' || pg_catalog.format_type(a.atttypid, a.atttypmod) order by a.attnum), '{}')
                            from pg_catalog.pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped),
              'comment', pg_catalog.obj_description(c.oid, 'pg_class'),
              'acl', (select coalesce(pg_catalog.json_agg(pg_catalog.json_build_object(
                                'grantee', case when x.grantee = 0 then null else pg_catalog.pg_get_userbyid(x.grantee)::text end,
                                'privilege', x.privilege_type, 'grantable', x.is_grantable)
                              order by x.grantee <> 0, pg_catalog.pg_get_userbyid(x.grantee)::text collate "C", x.privilege_type collate "C"), '[]'::json)
                        from pg_catalog.aclexplode(c.relacl) x where x.grantee <> c.relowner),
              'columnAcl', (select coalesce(pg_catalog.json_agg(pg_catalog.json_build_object(
                                'grantee', case when x.grantee = 0 then null else pg_catalog.pg_get_userbyid(x.grantee)::text end,
                                'privilege', x.privilege_type, 'grantable', x.is_grantable, 'column', a.attname::text)
                              order by a.attnum, x.grantee <> 0, pg_catalog.pg_get_userbyid(x.grantee)::text collate "C", x.privilege_type collate "C"), '[]'::json)
                        from pg_catalog.pg_attribute a cross join lateral pg_catalog.aclexplode(a.attacl) x
                       where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped),
              'code', (select coalesce(pg_catalog.json_agg(pg_catalog.json_build_object('kind', k.kind, 'name', k.name, 'on', k.ev) order by k.kind, k.name), '[]'::json) from (
                        select 'rule'::text as kind, r.rulename::text as name,
                               case r.ev_type when '2' then 'UPDATE' when '3' then 'INSERT' when '4' then 'DELETE' else 'SELECT' end as ev
                          from pg_catalog.pg_rewrite r where r.ev_class = c.oid and not (r.ev_type = '1' and r.rulename = '_RETURN')
                        union all
                        select 'trigger', t.tgname::text, null from pg_catalog.pg_trigger t where t.tgrelid = c.oid
                        union all
                        select 'default', a.attname::text, null from pg_catalog.pg_attrdef d
                          join pg_catalog.pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum where d.adrelid = c.oid) k),
              'labels', (select count(*)::int from pg_catalog.pg_seclabel s
                          where s.classoid = 'pg_catalog.pg_class'::pg_catalog.regclass and s.objoid = c.oid)) order by c.relname)
            from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
           where n.nspname = '${READER_SCHEMA}' and (c.relkind = 'v' or c.relname = any($3::text[]))), '[]'::json),
  'viewTables', coalesce((select pg_catalog.json_object_agg(c.relname, (select coalesce(pg_catalog.json_object_agg(a.attname,
                  pg_catalog.format_type(a.atttypid, a.atttypmod)), '{}'::json) from pg_catalog.pg_attribute a
                 where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped))
            from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relname = any($4::text[])), '{}'::json),
  'others', coalesce((select pg_catalog.json_agg(x.what order by x.what) from (
              select 'relation ' || c.relname::text as what from pg_catalog.pg_class c
                join pg_catalog.pg_namespace n on n.oid = c.relnamespace
               where n.nspname = '${READER_SCHEMA}' and not (c.relkind = 'v' or c.relname = any($3::text[]))
              union all
              select 'type ' || t.typname::text from pg_catalog.pg_type t
                join pg_catalog.pg_namespace n on n.oid = t.typnamespace
               where n.nspname = '${READER_SCHEMA}' and t.typrelid = 0 and t.typelem = 0) x), '[]'::json),
  'bindingSettings', coalesce((select pg_catalog.json_agg(x.v order by x.v) from (
              select case when s.setrole = 0 then '-' else pg_catalog.pg_get_userbyid(s.setrole)::text end || '/'
                  || case when s.setdatabase = 0 then '-' else pg_catalog.current_database()::text end || '/'
                  || pg_catalog.split_part(kv, '=', 1) as v
                from pg_catalog.pg_db_role_setting s cross join lateral pg_catalog.unnest(s.setconfig) as kv
               where s.setdatabase in (0, (select d.oid from pg_catalog.pg_database d where d.datname = pg_catalog.current_database()))
                 and pg_catalog.split_part(kv, '=', 1) in ('${ACCOUNT_SETTING}', '${KEY_SETTING}')) x), '[]'::json),
  'grants', coalesce((select pg_catalog.json_object_agg(r.rolname, pg_catalog.json_build_object(
              'select', (select coalesce(pg_catalog.array_agg(c.relname::text order by c.relname), '{}') from pg_catalog.pg_class c
                          join pg_catalog.pg_namespace n on n.oid = c.relnamespace
                         where n.nspname = 'public' and c.relkind in ('r', 'p') and pg_catalog.has_any_column_privilege(r.oid, c.oid, 'SELECT')),
              'insert', (select coalesce(pg_catalog.array_agg(c.relname::text order by c.relname), '{}') from pg_catalog.pg_class c
                          join pg_catalog.pg_namespace n on n.oid = c.relnamespace
                         where n.nspname = 'public' and c.relkind in ('r', 'p') and pg_catalog.has_any_column_privilege(r.oid, c.oid, 'INSERT'))))
            from pg_catalog.pg_roles r where r.rolname = any($2::text[])), '{}'::json),
  'code', coalesce((select pg_catalog.json_agg(pg_catalog.json_build_object('table', x.tbl, 'kind', x.kind, 'name', x.name, 'routine', x.routine)
              order by x.tbl, x.kind, x.name, x.routine) from (
              select c.relname::text as tbl, 'rule'::text as kind, w.rulename::text as name, null::text as routine
                from pg_catalog.pg_rewrite w join pg_catalog.pg_class c on c.oid = w.ev_class
                join pg_catalog.pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'public' and c.relkind in ('r', 'p')
              union all
              select c.relname::text, o.kind, o.name, f.oid::pg_catalog.regprocedure::text
                from (select 'trigger'::text as kind, t.tgname::text as name, t.tgrelid as rel,
                             'pg_catalog.pg_trigger'::pg_catalog.regclass as cls, t.oid as obj
                        from pg_catalog.pg_trigger t where not t.tgisinternal
                      union all
                      select case when a.attgenerated = '' then 'default' else 'generated column' end, a.attname::text, ad.adrelid,
                             'pg_catalog.pg_attrdef'::pg_catalog.regclass, ad.oid
                        from pg_catalog.pg_attrdef ad join pg_catalog.pg_attribute a on a.attrelid = ad.adrelid and a.attnum = ad.adnum
                      union all
                      select 'constraint', k.conname::text, k.conrelid, 'pg_catalog.pg_constraint'::pg_catalog.regclass, k.oid
                        from pg_catalog.pg_constraint k
                      union all
                      select 'index', i.relname::text, ix.indrelid, 'pg_catalog.pg_class'::pg_catalog.regclass, ix.indexrelid
                        from pg_catalog.pg_index ix join pg_catalog.pg_class i on i.oid = ix.indexrelid) o
                join pg_catalog.pg_class c on c.oid = o.rel
                join pg_catalog.pg_namespace n on n.oid = c.relnamespace
                join pg_catalog.pg_depend d on d.classid = o.cls and d.objid = o.obj and d.refclassid = 'pg_catalog.pg_proc'::pg_catalog.regclass
                join pg_catalog.pg_proc f on f.oid = d.refobjid
               where n.nspname = 'public' and c.relkind in ('r', 'p') and f.prosecdef) x), '[]'::json),
  'connected', (select pg_catalog.json_build_object('name', r.rolname, 'bypass', r.rolbypassrls, 'super', r.rolsuper,
              'owns', (select count(*) from pg_catalog.pg_shdepend d where d.refobjid = r.oid and d.deptype = 'o'),
              'member', (select count(*) from pg_catalog.pg_auth_members m where m.member = r.oid),
              'views', (select count(*) from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
                         where n.nspname = 'public' and c.relkind in ('v', 'm', 'f')
                           and (pg_catalog.has_any_column_privilege(c.oid, 'SELECT, INSERT, UPDATE')
                                or pg_catalog.has_table_privilege(c.oid, 'DELETE, TRUNCATE'))),
              'definers', (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
                         where n.nspname = 'public' and p.prosecdef and pg_catalog.has_function_privilege(p.oid, 'EXECUTE')),
              'ohmail', (select count(*) from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
                         where n.nspname = '${READER_SCHEMA}' and c.relkind in ('r', 'p', 'v', 'm', 'f')
                           and not (c.relkind = 'v' and c.relname = any($3::text[]))
                           and (pg_catalog.has_any_column_privilege(c.oid, 'SELECT, INSERT, UPDATE')
                                or pg_catalog.has_table_privilege(c.oid, 'DELETE, TRUNCATE')))
                      + (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
                         where n.nspname = '${READER_SCHEMA}' and p.prosecdef and pg_catalog.has_function_privilege(p.oid, 'EXECUTE')
                           and not (p.pronargs = 0 and p.proname = any($5::text[]))))
              from pg_catalog.pg_roles r where r.rolname = current_user)
)::text as facts`;

/**
 * THE SETTINGS A CATALOG'S SPELLING FOLLOWS, pinned for the transaction that reads it, each to
 * Postgres's own default (TimeZone to UTC): an empty search path (every name prints qualified);
 * IntervalStyle (an interval constant, the horizons' `interval '30 days'`, prints as it says);
 * quote_all_identifiers (every identifier and type name); DateStyle and TimeZone (a date or a
 * timestamp constant, for the day a policy carries one). The step records each policy's spelling
 * inside a transaction that read its facts first, so under the same pins: the spelling compared is
 * the catalog's alone, whatever a session, a database or a role sets. Nothing is loosened: a policy
 * that differs still differs.
 */
export const SPELLING_SETTINGS: Readonly<Record<string, string>> = {
  search_path: "", IntervalStyle: "postgres", quote_all_identifiers: "off", DateStyle: "ISO, MDY", TimeZone: "UTC",
};

/** Pin {@link SPELLING_SETTINGS} for the rest of the transaction `tx` (`set_config`, local). */
export async function pinSpelling(tx: Exec): Promise<void> {
  await tx.unsafe(`select ${Object.keys(SPELLING_SETTINGS).map((_, i) => `pg_catalog.set_config($${2 * i + 1}, $${2 * i + 2}, true)`).join(", ")}`,
    Object.entries(SPELLING_SETTINGS).flat());
}

/**
 * Read the facts. Inside a transaction: the settings a stored expression's spelling follows are
 * pinned for the rest of it ({@link SPELLING_SETTINGS}), so it prints the same on every read.
 */
export async function readLockFacts(tx: Exec): Promise<LockFacts> {
  await pinSpelling(tx);
  const [row] = await tx.unsafe(FACTS_SQL, [[...POLICY_ROLES], [STAFF_ROLE, PLANE_ROLE], ACCOUNT_VIEWS.map((v) => v.name),
    [...new Set(ACCOUNT_VIEWS.map((v) => v.table))], LOCK_READERS.map((r) => r.name)]) as unknown as Array<{ facts: string }>;
  return JSON.parse(row!.facts) as LockFacts;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The digest of a row of the list: what a policy is made from. */
export function listDigest(r: PolicyRow): string {
  return sha256(JSON.stringify([r.table, r.name, r.verb, [...r.roles].sort(), r.using, r.check]));
}

const VERB_OF: Record<string, PolicyVerb> = { "*": "ALL", r: "SELECT", a: "INSERT", w: "UPDATE", d: "DELETE" };

/** The digest of a policy as the catalog prints it. */
export function catalogDigest(p: Pick<PolicyFacts, "verb" | "roles" | "using" | "check">): string {
  return sha256(JSON.stringify([VERB_OF[p.verb] ?? p.verb, [...p.roles].sort(), p.using, p.check]));
}

/** The comment the step writes on a policy it made. */
export function policyComment(row: PolicyRow, printed: Pick<PolicyFacts, "verb" | "roles" | "using" | "check">): string {
  return `${POLICY_COMMENT_TAG} ${listDigest(row)} ${catalogDigest(printed)}`;
}

/** One way a policy is not its row of the list: the census's arm, and what it prints. */
export interface PolicyDifference {
  readonly arm: "policies.shape" | "policies.roles" | "policies.unrecorded" | "policies.listed" | "policies.altered";
  readonly detail: string;
}

/**
 * THE ONE COMPARISON OF A POLICY WITH ITS ROW OF THE LIST, shared by the census and the check: its
 * shape (permissive, verb), its roles, and the step's record on it: no record of the lock's, a
 * record of another row of the list, or a catalog spelling that no longer has the digest recorded
 * when the step made it. The second digest is of the catalog's own spelling, read back right after
 * the policy was made, so a policy nobody touched compares equal by construction, on any server.
 */
export function policyDifferences(p: PolicyFacts, r: PolicyRow): PolicyDifference[] {
  const out: PolicyDifference[] = [];
  if (!p.permissive) out.push({ arm: "policies.shape", detail: "restrictive" });
  if (VERB_OF[p.verb] !== r.verb) out.push({ arm: "policies.shape", detail: `for ${VERB_OF[p.verb] ?? p.verb}, the list says ${r.verb}` });
  if ([...p.roles].sort().join(",") !== [...r.roles].sort().join(",")) out.push({ arm: "policies.roles", detail: `to ${[...p.roles].sort().join(",")}` });
  const recorded = (p.comment ?? "").split(" ");
  if (recorded.length !== 3 || recorded[0] !== POLICY_COMMENT_TAG) out.push({ arm: "policies.unrecorded", detail: "no record of how it was made" });
  else {
    if (recorded[1] !== listDigest(r)) out.push({ arm: "policies.listed", detail: "made from another version of the list" });
    if (recorded[2] !== catalogDigest(p)) out.push({ arm: "policies.altered", detail: "its expression is not what was made" });
  }
  return out;
}

/** The digest of a listed view: what it is made from (its name, table, columns, conditions and option, the logins among them). */
export function viewListDigest(v: AccountView): string {
  return sha256(JSON.stringify(["view", viewStatement(v)]));
}

/** The digest of a view's text as the catalog prints it, under the pinned spelling settings. */
export function viewCatalogDigest(text: string): string {
  return sha256(JSON.stringify(["view", text]));
}

/** The comment the step writes on a view it made: the tag and the two digests, as on a policy. */
export function viewComment(v: AccountView, printed: string): string {
  return `${POLICY_COMMENT_TAG} ${viewListDigest(v)} ${viewCatalogDigest(printed)}`;
}

/** The columns `v` must answer, `name type` in order, by its table's own columns' types; `null` when the table lacks one. */
export function viewColumnsWanted(facts: Pick<LockFacts, "viewTables">, v: AccountView): string[] | null {
  const types = facts.viewTables[v.table];
  if (types === undefined || v.columns.some((c) => types[c] === undefined)) return null;
  return v.columns.map((c) => `${c} ${types[c]}`);
}

/**
 * The census's lines for a listed view its table cannot answer: the table gone, or a column the
 * list names that the table does not hold. The step cannot make such a view, and refuses before it
 * writes: a release that drops or renames such a column changes the list in the same release.
 */
export function viewTableLines(facts: Pick<LockFacts, "viewTables">): string[] {
  return viewTableGaps(facts).map((g) => `LOCK_DRIFT views.columns ${g.view}: ${g.detail}`);
}

/** Each listed view its table cannot answer, and why. */
export function viewTableGaps(facts: Pick<LockFacts, "viewTables">): Array<{ view: string; detail: string }> {
  return ACCOUNT_VIEWS.flatMap((v) => {
    const types = facts.viewTables[v.table];
    if (types === undefined) return [{ view: viewName(v), detail: `public.${v.table} is not in the catalog` }];
    return v.columns.filter((c) => types[c] === undefined).map((c) => ({ view: viewName(v), detail: `public.${v.table} holds no column ${c}` }));
  });
}

/** One piece of code on a view, as one phrase. */
export function viewCodePhrase(c: ViewCode): string {
  return c.kind === "rule" ? `the rule ${c.name} on ${c.on ?? "?"}` : c.kind === "trigger" ? `the trigger ${c.name}` : `the default of ${c.name}`;
}

/**
 * The words of what differs between the catalog's relation `f` and the listed view `v`, shared by
 * the census, the check and the step: `kind` (no view: nothing else is asked), `owner` (not the
 * readers' schema's owner), `options` (not exactly the check option: a barrier, an invoker's
 * rights, or the option missing), `fewer columns` (the list's first columns alone, in order and
 * type: a list that grew at its end, which the step makes again), `columns` (any other columns
 * than the listed ones of the table, with its types), `code (…)` (code on it, each named:
 * {@link ViewCode}), `label` (a security label on it
 * or on a column), and the step's record: `unrecorded` (no record of the lock's), `listed` (made
 * from another version of the list), `text` (its text is not what the step made: a condition
 * gone, another login named, `session_user` in place of `current_user`).
 */
export function viewDifferences(f: ViewFacts, v: AccountView, schemaOwner: string, facts: Pick<LockFacts, "viewTables">): string[] {
  if (f.kind !== "v") return ["kind"];
  const out: string[] = [];
  if (f.owner !== schemaOwner) out.push("owner");
  if ([...f.options].sort().join(",") !== VIEW_CHECK_OPTION) out.push("options");
  const wanted = viewColumnsWanted(facts, v);
  if (wanted === null || wanted.length !== f.columns.length || wanted.some((c, i) => c !== f.columns[i])) {
    // A list that grew at its end: the view's columns are the list's first ones, in order and type, and
    // `create or replace view` adds the rest, keeping what the view holds. Any other change it cannot make.
    const grown = wanted !== null && f.columns.length < wanted.length && f.columns.every((c, i) => c === wanted[i]);
    out.push(grown ? "fewer columns" : "columns");
  }
  if (f.code.length > 0) out.push(`code (${f.code.map(viewCodePhrase).join(", ")})`);
  if (f.labels > 0) out.push("label");
  const recorded = (f.comment ?? "").split(" ");
  if (recorded.length !== 3 || recorded[0] !== POLICY_COMMENT_TAG) out.push("unrecorded");
  else {
    if (recorded[1] !== viewListDigest(v)) out.push("listed");
    if (f.text === null || recorded[2] !== viewCatalogDigest(f.text)) out.push("text");
  }
  return out;
}

/**
 * What of a view's differences `create or replace view` mends, the list's new last columns among
 * them (`fewer columns`); the rest (`kind`, `owner`, `columns`, code on it, a label) is refused, by
 * hand: `create or replace` keeps a rule, a trigger, a default and a label, and cannot make a view
 * of another kind or owner, or over columns other than the ones it holds followed by new ones.
 */
export const VIEW_REMADE: ReadonlySet<string> = new Set(["options", "fewer columns", "unrecorded", "listed", "text"]);

/**
 * What a person does about a view the step refuses, said in its refusal: Postgres cannot make a view
 * again over other columns, so the release that changes them drops it first (`DROP VIEW IF EXISTS`
 * in its journal entry, or by hand), in a closed window: until the step makes it again a read of it
 * fails (42P01), and until the roles' apply grants it (42501). Code on a view and a label are
 * dropped by hand. Nothing for the rest (a relation of another kind or owner is the roles' check's
 * first, and named there).
 */
export function viewRemedy(v: AccountView, differs: readonly string[]): string {
  if (differs.includes("columns")) {
    return `Postgres cannot make it again over other columns: drop it first (DROP VIEW IF EXISTS ${viewName(v)}, in the release's journal or by hand), `
      + "in a closed window; the step then makes it again and the roles' apply grants it";
  }
  if (differs.some((d) => d.startsWith("code ("))) return "create or replace view keeps code on a view: by hand, drop it";
  if (differs.includes("label")) return "by hand, take the label away";
  return "";
}

/** The listed view `v`'s relation in the catalog, by name, if any. */
export function viewOf(facts: Pick<LockFacts, "views">, v: Pick<AccountView, "name">): ViewFacts | undefined {
  return facts.views.find((f) => f.name === v.name);
}

/** Whether a listed view stands in the readers' schema (a view of its name, whatever else differs). */
export function viewsStand(facts: Pick<LockFacts, "views">): boolean {
  return ACCOUNT_VIEWS.some((v) => viewOf(facts, v)?.kind === "v");
}

/**
 * The rights on a listed view the rule does not write, as `<grantee> holds <privilege>`: the two
 * logins hold SELECT and nothing else, without the grant option, and nobody else holds anything,
 * on the view or on one of its columns. Each is broken whoever reads: another role's opens the
 * limit a view's text cannot close to it; through a view an insert … on conflict do update by a
 * login that holds both verbs takes another account's row (the view's condition is not asked of
 * the row the conflict finds); and a holder of the grant option hands the view to anybody.
 */
export function viewGrants(f: Pick<ViewFacts, "acl" | "columnAcl">): string[] {
  const logins = new Set<string>(RUNTIME_LOGINS);
  const lines: string[] = [];
  const held = (r: Right): string => `${granteeName(r.grantee)} holds ${r.privilege}${r.grantable ? " with the grant option" : ""}`;
  for (const r of f.acl) {
    if (r.grantee !== null && logins.has(r.grantee) && r.privilege === "SELECT" && !r.grantable) continue;
    lines.push(held(r));
  }
  for (const r of f.columnAcl) lines.push(`${held(r)} on its column ${r.column}`);
  return lines;
}

/**
 * A grantee as a census line names it: `public` for PUBLIC, a plain lower-case name as it is, any
 * other name quoted, so that no name can read as another role's or as a privilege.
 */
export function granteeName(grantee: string | null): string {
  if (grantee === null) return "public";
  return /^[a-z_][a-z0-9_]*$/.test(grantee) ? grantee : `"${grantee.replace(/"/g, '""')}"`;
}

/** Whether `login` holds SELECT on the view `f`, with the grant option or without (the option itself is {@link viewGrants}'s). */
export function holdsSelect(f: Pick<ViewFacts, "acl">, login: string): boolean {
  return f.acl.some((r) => r.grantee === login && r.privilege === "SELECT");
}

/** The lock's off marker, as the switch writes it on the readers' schema. */
export interface LockMarker { readonly since: string; readonly by: string; readonly why: string }
export const MARKER_WHY = ["incident", "rehearsal", "test"] as const;
export type MarkerWhy = (typeof MARKER_WHY)[number];

/** The marker's one line: no free text. */
export function markerText(m: LockMarker): string {
  return `${LOCK_MARKER} off since=${m.since} by=${m.by} why=${m.why}`;
}

/** The marker a schema comment carries: none, one, or a comment that is not one. */
export function parseMarker(comment: string | null | undefined): LockMarker | null | "unreadable" {
  if (comment === null || comment === undefined || comment === "") return null;
  const m = /^ohmail\.lock off since=(\S+) by=([a-z_][a-z0-9_]*) why=(incident|rehearsal|test)$/.exec(comment);
  if (m === null || Number.isNaN(Date.parse(m[1]!))) return "unreadable";
  return { since: m[1]!, by: m[2]!, why: m[3]! };
}

/**
 * Whether `t` is partitioned or a partition. Postgres applies row security to the relation a
 * statement names: through a partitioned table its partitions' rows answer the parent's flags and
 * policies, but a partition named by itself answers its own and its parent's are not consulted. So
 * locking the parent leaves each partition open to a login granted on it, and the list cannot give
 * a partition its parent's meaning (a policy may name its own table, the classes and the staff
 * role's grants go by table name). The lock takes no partitioned table: the census names each, the
 * check reads broken, and the step refuses before it writes. A release that partitions a table
 * brings the list's rule for it first.
 */
export function isPartitioned(t: Pick<TableFacts, "partitioned" | "partitionOf">): boolean {
  return t.partitioned || t.partitionOf !== null;
}

/** Why `t`, partitioned or a partition, is outside the lock, as one phrase. */
export function partitionPhrase(t: TableFacts): string {
  const what = t.partitionOf === null ? "partitioned" : t.partitioned ? `partitioned, and a partition of ${t.partitionOf}` : `a partition of ${t.partitionOf}`;
  return `${what}; the lock takes no partitioned table`;
}

/** The census's lines for every partitioned table and partition of `public`: the lock refuses each. */
export function partitionLines(facts: Pick<LockFacts, "tables">): string[] {
  return facts.tables.filter(isPartitioned).map((t) => `LOCK_DRIFT tables.partitioned ${t.name}: ${partitionPhrase(t)}`);
}

const CODE_NAMED: Record<CodeFacts["kind"], string> = {
  rule: "the rule", trigger: "the trigger", default: "the default of", "generated column": "the generated column",
  constraint: "the constraint", index: "the index",
};

/** What one piece of code on a table does past the lock, as one phrase. */
export function codePhrase(c: CodeFacts): string {
  const what = `${CODE_NAMED[c.kind]} ${c.name}`;
  return c.routine === null
    ? `${what} runs with its owner's rights, past the lock`
    : `${what} calls the SECURITY DEFINER routine ${c.routine}, which runs with its owner's rights, past the lock`;
}

/** The census's lines for code on a table of `public` that runs with its owner's rights: the lock refuses each. */
export function codeLines(facts: Pick<LockFacts, "code">): string[] {
  return facts.code.map((c) => `LOCK_DRIFT tables.code ${c.table}: ${codePhrase(c)}`);
}

/** The policies the list wants on this catalog: every classed table's, for the roles the server has. */
export function expectedPolicies(facts: LockFacts): PolicyRow[] {
  const present = new Set(Object.keys(facts.roles));
  const rows = facts.tables.filter((t) => !isPartitioned(t)).flatMap((t) => policiesOfTable(t.name, t.account));
  return policiesFor(rows, present).sort(byTableThenName);
}

/** The locked tables of this catalog: every classed table that is not an operations one, and not partitioned. */
export function lockedOf(facts: LockFacts): TableFacts[] {
  return facts.tables.filter((t) => { const c = tableClass(t.name, t.account); return c !== null && c !== "operations" && !isPartitioned(t); });
}

/** Whether the readers' schema says the lock is off. */
export function markerOf(facts: LockFacts): LockMarker | null | "unreadable" {
  return parseMarker(facts.schema?.comment ?? null);
}

/**
 * The catalog's routine that is the listed reader `r`: the one of its name that takes no argument.
 * A routine of the same name with arguments is never taken for it: it is another object of the
 * readers' schema, which is why no comparison below asks about arguments.
 */
export function readerOf(facts: Pick<LockFacts, "readers">, r: LockReader): ReaderFacts | undefined {
  return facts.readers.find((f) => f.name === r.name && f.args === 0);
}

/** What differs between the catalog's reader `f` and the list's `r`, one word each; `schemaOwner` must own it. */
export function readerDifferences(f: ReaderFacts, r: LockReader, schemaOwner: string): string[] {
  return [
    f.src !== r.body && "body", f.volatile !== "s" && "volatility", f.parallel !== "s" && "parallel",
    f.secdef && "security definer", f.config !== null && "settings", f.lang !== "sql" && "language",
    f.returns !== r.returns && "return type", f.owner !== schemaOwner && "owner",
    f.acl !== null && "privileges", f.strict && "strict", f.kind !== "f" && "kind",
  ].filter((x): x is string => typeof x === "string");
}

/**
 * The census's arm for a right the runtime roles' rule writes on the account's views and their
 * schema and a login does not yet hold: the views are born with no grant, and the roles' apply
 * grants them after the lock step. The step's own census inside its transaction takes no refusal
 * from it (or the first step that makes the views would roll back); every other reading names it.
 */
export const VIEWS_UNGRANTED = "views.ungranted";

/** EVERY WAY THE CATALOG IS NOT THE LIST, one line each. An empty list is a lock as listed. */
export function lockDrift(facts: LockFacts): string[] {
  const out: string[] = [];
  const line = (arm: string, subject: string, detail = ""): void => { out.push(`LOCK_DRIFT ${arm} ${subject}${detail === "" ? "" : `: ${detail}`}`); };
  const marker = markerOf(facts);
  const off = marker !== null && marker !== "unreadable";
  const catalog = new Map(facts.tables.map((t) => [t.name, t]));

  for (const t of facts.tables) {
    if (isPartitioned(t)) { line("tables.partitioned", t.name, partitionPhrase(t)); continue; }
    const cls = tableClass(t.name, t.account);
    if (cls === null) { line("tables.unclassed", t.name, "a table of public in no class"); continue; }
    const mapped = MAP_2_0[t.name];
    if (mapped !== undefined && mapped.account !== t.account) line("tables.column", t.name, `account_id ${t.account ? "present" : "missing"} where the map says otherwise`);
    if ((cls === "operations" || cls === "staff") && t.account) line("tables.column", t.name, `${cls === "operations" ? "an" : "a"} ${cls} table carries account_id`);
    if (cls === "operations") {
      if (t.rls || t.forced) line("tables.flags", t.name, "an operations table under row security");
    } else if (off ? t.rls || t.forced : !t.rls || !t.forced) {
      line("tables.flags", t.name, `on=${t.rls} forced=${t.forced} while the lock is ${off ? "off" : "on"}`);
    }
  }
  for (const name of tablesOf("cloud")) if (!catalog.has(name)) line("tables.gone", name, "a listed table is not in the catalog");
  for (const c of facts.code) line("tables.code", c.table, codePhrase(c));

  const want = new Map(expectedPolicies(facts).map((r) => [`${r.table}.${r.name}`, r]));
  const have = new Map(facts.policies.map((p) => [`${p.table}.${p.name}`, p]));
  for (const [key, p] of have) {
    const r = want.get(key);
    if (r === undefined) { line("policies.foreign", key, "a policy the list does not name"); continue; }
    for (const d of policyDifferences(p, r)) line(d.arm, key, d.detail);
  }
  for (const key of want.keys()) if (!have.has(key)) line("policies.missing", key);

  for (const g of viewTableGaps(facts)) line("views.columns", g.view, g.detail);
  const s = facts.schema;
  if (s === null) {
    line("schema.missing", READER_SCHEMA);
    for (const v of ACCOUNT_VIEWS) line("views.missing", viewName(v));
  } else {
    // A login's USAGE is the rule's while one of the account's views stands there: what it uses it for.
    // The census expects it, and SELECT on each view that stands, for both logins: the runtime roles'
    // rule writes them after the step (`views.ungranted` until then), and nothing else there.
    const standing = viewsStand(facts);
    for (const role of s.usage) if (!(standing && isLogin(role))) line("schema.usage", READER_SCHEMA, `${role} holds USAGE`);
    if (standing) for (const l of loginsOf(facts)) if (!s.usage.includes(l)) line("views.ungranted", READER_SCHEMA, `${l} holds no USAGE while a view stands`);
    for (const v of ACCOUNT_VIEWS) {
      const f = viewOf(facts, v);
      if (f === undefined) { line("views.missing", viewName(v)); continue; }
      const differs = viewDifferences(f, v, s.owner, facts);
      if (differs.length > 0) line("views.differ", viewName(v), differs.join(", "));
      for (const g of viewGrants(f)) line("views.grants", viewName(v), g);
      if (f.kind === "v") for (const l of loginsOf(facts)) if (!holdsSelect(f, l)) line("views.ungranted", viewName(v), `${l} holds no SELECT`);
    }
    const listed = new Set<string>(ACCOUNT_VIEWS.map((v) => v.name));
    for (const f of facts.views) if (!listed.has(f.name)) line("views.foreign", `${READER_SCHEMA}.${f.name}`, "a view the list does not name");
    if (marker === "unreadable") line("marker.unreadable", READER_SCHEMA, "its comment is no marker");
    if (off && lockedOf(facts).every((t) => t.rls && t.forced)) line("marker.stale", READER_SCHEMA, "the marker says off and every table is locked");
    const readers = new Set<ReaderFacts>();
    for (const r of LOCK_READERS) {
      const f = readerOf(facts, r);
      if (f === undefined) { line("readers.missing", `${READER_SCHEMA}.${r.name}`); continue; }
      readers.add(f);
      const differs = readerDifferences(f, r, s.owner);
      if (differs.length > 0) line("readers.differ", `${READER_SCHEMA}.${r.name}`, differs.join(", "));
    }
    for (const f of facts.readers) if (!readers.has(f)) line("schema.objects", READER_SCHEMA, `routine ${f.name}(${f.identity})`);
    for (const o of facts.others) line("schema.objects", READER_SCHEMA, o);
  }
  for (const b of facts.bindingSettings) line("settings.binding", b, "the binding's setting stands on a role or a database");

  for (const role of [STAFF_ROLE, PLANE_ROLE]) {
    const g = facts.grants[role];
    if (g === undefined) continue;
    const locked = new Set(lockedOf(facts).map((t) => t.name));
    for (const [verb, granted] of [["SELECT", g.select], ["INSERT", g.insert]] as const) {
      const byPolicy = new Set([...want.values()].filter((r) => r.roles.includes(role as never) && (r.verb === verb || r.verb === "ALL")).map((r) => r.table));
      for (const t of granted) if (locked.has(t) && !byPolicy.has(t)) line(`grants.${role}`, t, `${verb} granted and no policy names the role`);
      for (const t of byPolicy) if (!granted.includes(t)) line(`grants.${role}`, t, `${verb === "INSERT" ? "an" : "a"} ${verb} policy names the role and nothing is granted`);
    }
  }
  return out;
}

/** The runtime logins this server has. */
export function loginsOf(facts: Pick<LockFacts, "roles">): string[] {
  return RUNTIME_LOGINS.filter((r) => r in facts.roles);
}

/** Whether `role` is one of the two runtime logins, by name. */
export function isLogin(role: string): boolean {
  return (RUNTIME_LOGINS as readonly string[]).includes(role);
}

/** The census alone, in a read-only transaction of its own: what the catalog holds that the list does not say. */
export async function lockCensus(sql: Pick<postgres.Sql, "begin">): Promise<string[]> {
  return await sql.begin("read only", async (tx) => lockDrift(await readLockFacts(tx))) as string[];
}
