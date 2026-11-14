import { sql, type SQL } from "drizzle-orm";
import type { Executor } from "../baseline.js";
import { GROWING_LIST_SHAPE } from "../closed-set-shape.js";
import { COUNTER_KEY_FAMILIES } from "../counter-keys.js";
import {
  MAP_2_0, holds, leftThrottleSql, movedCountersSql, passMarksSql, tablesOf, type StoreKind,
} from "./expected-counts.js";
import type { EntryNames } from "./entry-names.js";
import type { CountLine } from "./report.js";

/**
 * THE RECORD OF BEFORE. Taken inside the transaction, ahead of the first entry; it changes nothing
 * in `public`. Everything a check compares "after" with is taken here, from the 1.0.11 store: the
 * count each table must hold (the map's formulas), what each account has, the rows the passes'
 * marks must become, the counters that must move. What is large stays in the store, in temporary
 * tables that go with the transaction; what is small comes back.
 */
export function rowsOf<T>(result: unknown): T[] {
  return Array.isArray(result) ? result as T[] : (((result as { rows?: T[] } | null)?.rows) ?? []);
}

export async function one<T>(tx: Executor, query: SQL): Promise<T> {
  const [row] = rowsOf<T>(await tx.execute(query));
  if (row === undefined) throw new Error("a transition read answered no row");
  return row;
}

const count = async (tx: Executor, query: string): Promise<number> => Number((await one<{ n: string }>(tx, sql.raw(query))).n);

/** The store's own tables in `public`, as it stands. */
export async function publicTables(tx: Executor): Promise<string[]> {
  return rowsOf<{ name: string }>(await tx.execute(sql`
    select c.relname::text as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p') order by 1`)).map((r) => r.name);
}

/** The names the window's entries make, need and drop, and the map, where the refusal's joins can read them. */
export async function writeLists(tx: Executor, kind: StoreKind, names: EntryNames): Promise<void> {
  await tx.execute(sql.raw(`create temporary table ohmail_transition_map
    (table_name text primary key, journal text not null, carries_account boolean not null) on commit drop`));
  await tx.execute(sql`insert into pg_temp.ohmail_transition_map values ${sql.join(
    Object.entries(MAP_2_0).map(([name, t]) => sql`(${name}, ${t.journal}, ${t.account})`), sql`, `)}`);
  await tx.execute(sql.raw(`create temporary table ohmail_transition_names
    (list text not null, journal text not null, entry text not null, kind text not null, table_name text not null, name text not null) on commit drop`));
  const rows = (["needed", "made", "dropped"] as const).flatMap((list) => names[list]
    .filter((n) => n.journal === "mail" || kind !== "desktop")
    .map((n) => sql`(${list}, ${n.journal}, ${n.entry}, ${n.kind}, ${n.table}, ${n.name})`));
  if (rows.length > 0) await tx.execute(sql`insert into pg_temp.ohmail_transition_names values ${sql.join(rows, sql`, `)}`);
}

/**
 * The count every table of the map must hold afterwards, by the map's formulas, evaluated now.
 * A table the window makes is not there yet and is expected empty; a desktop engine's own table
 * is expected only where it stands.
 */
export async function expectedCounts(tx: Executor, kind: StoreKind, standing: ReadonlySet<string>): Promise<Map<string, number>> {
  const expected = new Map<string, number>();
  for (const name of tablesOf(kind)) {
    const t = MAP_2_0[name]!;
    if (t.rows === "empty") expected.set(name, 0);
    else if (t.rows !== "same") expected.set(name, Number((await one<{ count: string }>(tx, sql.raw(t.rows.sql))).count));
    else if (standing.has(name)) expected.set(name, await count(tx, `select count(*) as n from "${name}"`));
    // A table of the map that the store lacks is a missing name, which the refusal says; a
    // desktop's own table that an older engine never made is simply not expected.
  }
  return expected;
}

/** What each account has, sixteen figures, into a temporary table under `phase`. */
export async function recordPerAccount(tx: Executor, phase: "before" | "after"): Promise<void> {
  // Before, a child's account is its parent's; after, it is the child's own column. Counted by the
  // new column afterwards, so the comparison also shows that the column sorts every row to the
  // account its parent sorted it to.
  const child = (table: string, parent: string, fk: string): string => phase === "before"
    ? `(select count(*) from "${table}" c join "${parent}" p on p.id = c."${fk}" where p.account_id = a.id)`
    : `(select count(*) from "${table}" c where c.account_id = a.id)`;
  const bytes = phase === "before"
    ? `(select coalesce(sum(octet_length(b.text)), 0) from message_bodies b join messages m on m.id = b.message_id where m.account_id = a.id)`
    : `(select coalesce(sum(octet_length(b.text)), 0) from message_bodies b where b.account_id = a.id)`;
  const own = (table: string, extra = ""): string => `(select count(*) from "${table}" x where x.account_id = a.id${extra})`;
  const figures = `select a.id as account_id,
       ${own("users")} as users, ${own("mailboxes")} as mailboxes, ${own("rules")} as rules, ${own("drafts")} as drafts,
       ${own("drafts", " and x.status = 'scheduled'")} as scheduled_sends, ${own("scheduled_send_files")} as scheduled_send_files,
       ${own("contacts")} as contacts, ${own("tags")} as tags, ${own("messages")} as messages,
       ${child("message_bodies", "messages", "message_id")} as message_bodies,
       ${child("folder_state", "messages", "message_id")} as folder_state,
       ${child("flag_state", "messages", "message_id")} as flag_state,
       ${child("mailbox_credentials", "mailboxes", "mailbox_id")} as mailbox_credentials,
       ${child("mailbox_folders", "mailboxes", "mailbox_id")} as mailbox_folders,
       ${child("pairing_tokens", "users", "created_by_user_id")} as pairing_tokens,
       ${bytes} as body_text_bytes
  from accounts a`;
  await tx.execute(sql.raw(`create temporary table ohmail_transition_accounts_${phase} on commit drop as ${figures}`));
}

/** The rows `pass_progress` must hold, and the counters `account_counters` must hold, value by value. */
export async function recordMoves(tx: Executor, kind: StoreKind): Promise<void> {
  await tx.execute(sql.raw(`create temporary table ohmail_transition_passes on commit drop as ${passMarksSql()}`));
  if (kind === "desktop") return;
  await tx.execute(sql.raw(`create temporary table ohmail_transition_counters on commit drop as
    ${movedCountersSql("$account as account_id, c.key, c.failures, c.locked_until, c.window_started_at")}`));
}

/** The living letters only the old search finds: no search document, in an account whose pass has no mark. */
export const OLD_SEARCH_OWED_BEFORE = `select count(*) as n from messages m where m.deleted_at is null
   and not exists (select 1 from message_search s where s.message_id = m.id)
   and not exists (select 1 from account_settings st where st.account_id = m.account_id and st.search_index_built_at is not null)`;

/** The same count after the entries: the passes' marks are rows of `pass_progress` by then. */
export const OLD_SEARCH_OWED_AFTER = `select count(*) as n from messages m where m.deleted_at is null
   and not exists (select 1 from message_search s where s.message_id = m.id)
   and not exists (select 1 from pass_progress p where p.account_id = m.account_id and p.job = 'search_index_backfill' and p.done_at is not null)`;

/** What is said and stops nothing. Fixed sentences and counts. */
export async function reported(tx: Executor, kind: StoreKind): Promise<CountLine[]> {
  const lines: CountLine[] = [
    { what: "accounts with living mail and no search mark", n: await count(tx, `select count(*) as n from accounts a where a.erased_at is null
        and exists (select 1 from messages m where m.account_id = a.id and m.deleted_at is null)
        and not exists (select 1 from account_settings s where s.account_id = a.id and s.search_index_built_at is not null)`) },
    { what: "living letters only the old search finds (not zero: mail 0200 keeps the old search standing)", n: await count(tx, OLD_SEARCH_OWED_BEFORE) },
  ];
  if (kind === "desktop") return lines;
  // The counters, one line per family of the registry: the family's own word, never a key.
  for (const f of COUNTER_KEY_FAMILIES) {
    const longer = COUNTER_KEY_FAMILIES.filter((o) => o.prefix !== f.prefix && o.prefix.startsWith(f.prefix));
    const n = await count(tx, `select count(*) as n from auth_throttle where key like '${f.prefix}%'${
      longer.map((o) => ` and key not like '${o.prefix}%'`).join("")} and key not like '%@%'`);
    if (n > 0) lines.push({ what: `counters of the family ${f.prefix} (${f.class})`, n });
  }
  lines.push(
    { what: "counters with an address in the key, deleted by cloud 0101", n: await count(tx, `select count(*) as n from auth_throttle where key like '%@%'`) },
    { what: "counters that name a row which is gone, or fit no shape of their family: deleted by cloud 0101",
      n: await count(tx, `select (select count(*) from auth_throttle c where ${leftThrottleSql("c")} and c.key not like '%@%' and c.key not like 'live-body:%')
        - (select count(*) from (${movedCountersSql("1")}) moved) as n`) },
    { what: "security notices owed on a hashed address, which 2.0 does not send", n: await count(tx, `select count(*) as n from auth_throttle where key like 'notice:ceiling:%' and failures = 1`) },
  );
  return lines;
}

/**
 * What must be zero before the first statement, each a count over the 1.0.11 store with the entry
 * it would stop. Not every precondition of every entry: a constraint an entry validates is asked
 * by the validation itself, and a failure there rolls the whole transaction back all the same.
 * These are the ones whose answer names what to repair.
 */
export async function mustBeZero(tx: Executor, kind: StoreKind): Promise<CountLine[]> {
  const asks: [string, string][] = [
    ["message_bodies without a letter (mail 0201)", `select count(*) as n from message_bodies b where not exists (select 1 from messages m where m.id = b.message_id)`],
    ["folder_state without a letter (mail 0201)", `select count(*) as n from folder_state f where not exists (select 1 from messages m where m.id = f.message_id)`],
    ["flag_state without a letter (mail 0201)", `select count(*) as n from flag_state f where not exists (select 1 from messages m where m.id = f.message_id)`],
    ["folder_state rows whose kept copy of the account disagrees with the letter's (mail 0201)",
      `select count(*) as n from folder_state f join messages m on m.id = f.message_id where f.outstanding_account_id is not null and f.outstanding_account_id <> m.account_id`],
    ["flag_state rows whose kept copy of the account disagrees with the letter's (mail 0201)",
      `select count(*) as n from flag_state f join messages m on m.id = f.message_id where f.pending_account_id is not null and f.pending_account_id <> m.account_id`],
    ["junk_rescues under another account's mailbox (mail 0201)", `select count(*) as n from junk_rescues j join mailboxes b on b.id = j.mailbox_id where b.account_id <> j.account_id`],
    ["unsubscribe_examined under another account's letter (mail 0201)", `select count(*) as n from unsubscribe_examined e join messages m on m.id = e.message_id where m.account_id <> e.account_id`],
    ["unsubscribe_examined under another account's record (mail 0201)", `select count(*) as n from unsubscribe_examined e join unsubscribe_records r on r.id = e.record_id where r.account_id <> e.account_id`],
    ["routing_decisions that name a rule which is gone or another account's (mail 0202)",
      `select count(*) as n from routing_decisions d where d.matched_rule_id is not null and not exists (select 1 from rules r where r.id = d.matched_rule_id and r.account_id = d.account_id)`],
    ["mailboxes with a reason word outside the shape (mail 0202)", `select count(*) as n from mailboxes
       where coalesce(disabled_reason, 'a') !~ '${GROWING_LIST_SHAPE}' or coalesce(sync_blocked_reason, 'a') !~ '${GROWING_LIST_SHAPE}' or coalesce(organized_by_kind, 'a') !~ '${GROWING_LIST_SHAPE}'`],
  ];
  if (kind !== "desktop") {
    asks.push(
      ["login_tokens that share a token hash (cloud 0103)", `select count(*) as n from (select token_hash from login_tokens group by 1 having count(*) > 1) d`],
      ["oauth_auth_codes that share a code hash (cloud 0103)", `select count(*) as n from (select code_hash from oauth_auth_codes group by 1 having count(*) > 1) d`],
      ["push_subscriptions of an account that is gone (cloud 0103)", `select count(*) as n from push_subscriptions p where not exists (select 1 from accounts a where a.id = p.account_id)`],
      ["platform_signals with a provider word outside the shape (cloud 0103)", `select count(*) as n from platform_signals where provider !~ '^[a-z][a-z0-9_-]{0,31}$'`],
      // What stays in auth_throttle carries no isolation, on the ground that no key left there
      // names a row. A key that carries an id and is of no family the split moves or deletes is a
      // family nobody classed: refused here, not found after the last entry.
      ["counters that carry an id and are of no family cloud 0101 moves", `select count(*) as n from auth_throttle c
         where c.key ~ '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' and c.key not like '%@%' and not ${leftThrottleSql("c")}`],
    );
  }
  const lines: CountLine[] = [];
  for (const [what, query] of asks) {
    const n = await count(tx, query);
    if (n !== 0) lines.push({ what, n });
  }
  return lines;
}

/** Does a store of `kind` hold the journal a name belongs to? Re-exported for the refusal. */
export { holds };
