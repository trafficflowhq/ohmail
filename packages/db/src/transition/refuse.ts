import { sql } from "drizzle-orm";
import type { Executor } from "../baseline.js";
import { MAP_2_0, holds, type StoreKind } from "./expected-counts.js";
import type { EntryNames } from "./entry-names.js";
import { rowsOf } from "./before.js";
import type { CountLine } from "./report.js";

/**
 * REFUSED BEFORE THE FIRST ENTRY. Everything that can be known before a statement of the entries
 * runs is asked here: the tables of `public` against the map, every name an entry needs to find,
 * every name an entry needs to be free, and anything outside the map that hangs off a name an
 * entry drops. One line ends the transaction with nothing changed.
 *
 * A NAME READ FROM THE STORE IS NEVER PUT INTO A STATEMENT OR A SENTENCE HERE. The catalog is
 * joined against the lists `before.ts` wrote (`ohmail_transition_map`, `ohmail_transition_names`)
 * inside the database; a store's own name comes back only as a value, in {@link ForeignTable.name}
 * or {@link Refusal.subjects}, for the runner to pass through `safeName`.
 */
export interface ForeignTable {
  /** As the store spells it. Print only through `safeName`. */
  readonly name: string;
  /** Why it refuses, or `null`: it is its owner's, and is left alone. */
  readonly refuses: null | "the Cloud's catalog holds the product's tables only" | "another kind of store's own table" | "it takes a name 2.0 makes";
}

export interface Refusal {
  /** Fixed sentences with counts: what must be zero and is not. */
  readonly lines: CountLine[];
  /** The store's own names behind those lines, by sentence. Print only through `safeName`. */
  readonly subjects: Record<string, string[]>;
  readonly foreign: ForeignTable[];
}

/**
 * The tables of `public` the map does not name for this kind of store. The Cloud's catalog is
 * ours: every such table refuses. On a self-hosted server and on a desktop a table refuses when
 * it is another kind of store's own (the store is not what its runner says) or takes a name an
 * entry makes; any other is its owner's, is reported, and no statement touches it.
 */
export async function foreignTables(tx: Executor, kind: StoreKind): Promise<ForeignTable[]> {
  const found = rowsOf<{ name: string; journal: string | null; made: boolean; dropped: boolean }>(await tx.execute(sql`
    select c.relname::text as name,
           (select m.journal from pg_temp.ohmail_transition_map m where m.table_name = c.relname) as journal,
           exists (select 1 from pg_temp.ohmail_transition_names n
                    where n.list = 'made' and n.kind in ('table', 'index') and n.name = c.relname) as made,
           exists (select 1 from pg_temp.ohmail_transition_names n
                    where n.list = 'dropped' and n.kind = 'table' and n.name = c.relname) as dropped
      from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'public' and c.relkind in ('r', 'p') order by 1`));
  const out: ForeignTable[] = [];
  for (const t of found) {
    const mapped = t.journal as "mail" | "cloud" | "desktop" | null;
    // A table the window makes is in the map and must not stand yet: it "takes a name 2.0 makes".
    if (t.made) { out.push({ name: t.name, refuses: "it takes a name 2.0 makes" }); continue; }
    if (t.dropped) continue;                                   // 1.0's own, about to go
    if (mapped !== null && holds(kind, mapped)) continue;      // the product's, on this kind of store
    out.push({
      name: t.name,
      refuses: mapped !== null ? "another kind of store's own table"
        : kind === "cloud" ? "the Cloud's catalog holds the product's tables only" : null,
    });
  }
  return out;
}

/** Is the name there? One catalog read per kind of name, each joined against the list in the store. */
const PRESENT = `case n.kind
  when 'table' then to_regclass('public.' || quote_ident(n.name)) is not null
  when 'index' then to_regclass('public.' || quote_ident(n.name)) is not null
  when 'constraint' then exists (select 1 from pg_constraint c where c.conrelid = to_regclass('public.' || quote_ident(n.table_name)) and c.conname = n.name)
  when 'column' then exists (select 1 from pg_attribute a where a.attrelid = to_regclass('public.' || quote_ident(n.table_name)) and a.attname = n.name and a.attnum > 0 and not a.attisdropped)
  when 'trigger' then exists (select 1 from pg_trigger g where g.tgrelid = to_regclass('public.' || quote_ident(n.table_name)) and g.tgname = n.name and not g.tgisinternal)
  when 'function' then exists (select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname = n.name)
  when 'statistics' then exists (select 1 from pg_statistic_ext x join pg_namespace s on s.oid = x.stxnamespace where s.nspname = 'public' and x.stxname = n.name)
end`;

/** `mail 0201 index folder_state_outstanding_idx`: an entry's own name for a thing, from the map. */
const NAMED = `n.journal || ' ' || left(n.entry, 4) || ': ' || n.kind || ' ' || case when n.table_name <> '' then n.table_name || '.' else '' end || n.name`;

/**
 * Everything outside the map that hangs off a name an entry drops, which would stop the drop half
 * way through its journal: a view over a dropped column or table, a key from a table that is not
 * the product's onto a dropped column or unique, a trigger that calls a dropped function.
 */
const DEPENDENTS = `
  select 'a view reads something an entry drops' as what, v.relname::text as subject
    from pg_temp.ohmail_transition_names n
    join pg_class t on t.oid = to_regclass('public.' || quote_ident(case when n.kind = 'table' then n.name else n.table_name end))
    join pg_depend d on d.refclassid = 'pg_class'::regclass and d.refobjid = t.oid and d.classid = 'pg_rewrite'::regclass
    join pg_rewrite r on r.oid = d.objid
    join pg_class v on v.oid = r.ev_class and v.oid <> t.oid
   where n.list = 'dropped' and (n.kind = 'table' or (n.kind = 'column' and d.refobjsubid =
           (select a.attnum from pg_attribute a where a.attrelid = t.oid and a.attname = n.name and not a.attisdropped)))
  union
  select 'a key from a table that is not the product''s points at something an entry drops', c.conname::text
    from pg_temp.ohmail_transition_names n
    join pg_class t on t.oid = to_regclass('public.' || quote_ident(case when n.kind = 'table' then n.name else n.table_name end))
    join pg_constraint c on c.contype = 'f' and c.confrelid = t.oid
    join pg_class o on o.oid = c.conrelid
   where n.list = 'dropped' and n.kind in ('table', 'column', 'constraint')
     and not exists (select 1 from pg_temp.ohmail_transition_map m where m.table_name = o.relname)
     and (n.kind = 'table'
          or (n.kind = 'column' and (select a.attnum from pg_attribute a where a.attrelid = t.oid and a.attname = n.name and not a.attisdropped) = any (c.confkey))
          or (n.kind = 'constraint' and c.conindid = (select k.conindid from pg_constraint k where k.conrelid = t.oid and k.conname = n.name)))
  union
  select 'a trigger no entry drops calls a function an entry drops', g.tgname::text
    from pg_temp.ohmail_transition_names n
    join pg_proc p on p.proname = n.name join pg_namespace s on s.oid = p.pronamespace and s.nspname = 'public'
    join pg_trigger g on g.tgfoid = p.oid and not g.tgisinternal
   where n.list = 'dropped' and n.kind = 'function'
     and not exists (select 1 from pg_temp.ohmail_transition_names x where x.list = 'dropped' and x.kind = 'trigger' and x.name = g.tgname)`;

export async function refusal(tx: Executor, kind: StoreKind, names: EntryNames, zero: readonly CountLine[]): Promise<Refusal> {
  const lines: CountLine[] = [...zero];
  const subjects: Record<string, string[]> = {};
  const add = (what: string, subject?: string): void => {
    const line = lines.find((l) => l.what === what);
    if (line) (line as { n: number }).n += 1; else lines.push({ what, n: 1 });
    if (subject !== undefined) (subjects[what] ??= []).push(subject);
  };

  const foreign = await foreignTables(tx, kind);
  for (const f of foreign) if (f.refuses !== null) add(`a table the map does not name for this store: ${f.refuses}`, f.name);

  // A table of the map that this kind of store must already hold, and does not.
  const made = new Set(names.made.filter((n) => n.kind === "table").map((n) => n.name));
  const there = new Set(rowsOf<{ name: string }>(await tx.execute(sql`
    select m.table_name as name from pg_temp.ohmail_transition_map m where to_regclass('public.' || quote_ident(m.table_name)) is not null`)).map((r) => r.name));
  for (const [name, t] of Object.entries(MAP_2_0)) {
    if (t.journal !== "desktop" && holds(kind, t.journal) && !made.has(name) && !there.has(name)) add(`a table of 1.0.11 is missing: ${name}`);
  }

  // The names are the entries' own, from the map: they are said as they are.
  for (const r of rowsOf<{ named: string }>(await tx.execute(sql.raw(
    `select ${NAMED} as named from pg_temp.ohmail_transition_names n where n.list = 'needed' and not (${PRESENT}) order by 1`)))) {
    add(`a name an entry needs is missing: ${r.named}`);
  }
  for (const r of rowsOf<{ named: string }>(await tx.execute(sql.raw(
    `select ${NAMED} as named from pg_temp.ohmail_transition_names n where n.list = 'made' and n.kind <> 'table' and (${PRESENT}) order by 1`)))) {
    add(`a name an entry makes is taken: ${r.named}`);
  }
  for (const r of rowsOf<{ what: string; subject: string }>(await tx.execute(sql.raw(`${DEPENDENTS} order by 1, 2`)))) add(r.what, r.subject);
  return { lines, subjects, foreign };
}
