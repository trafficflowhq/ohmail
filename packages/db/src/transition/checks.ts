import { sql } from "drizzle-orm";
import type { Executor } from "../baseline.js";
import { accountTablesOf, tablesOf, type StoreKind } from "./expected-counts.js";
import { OLD_SEARCH_OWED_AFTER, publicTables, recordPerAccount, rowsOf } from "./before.js";
import type { ForeignTable } from "./refuse.js";
import type { WindowEntry } from "./window.js";
import type { Verdict } from "./report.js";

/**
 * THE CHECKS, after the last entry and inside the same transaction. Each answers with verdicts:
 * what was asked, of what, what was expected and what was found. One that is not `ok` ends the
 * transaction at the gate, and the store is 1.0.11's again. That decision is the checks', not a
 * person's, and nothing has to be restored for it.
 *
 * A verdict's `subject` is a name of the map or a fixed word. Counts, never rows.
 */
export interface CheckInput {
  readonly kind: StoreKind;
  readonly expected: ReadonlyMap<string, number>;
  readonly foreign: readonly ForeignTable[];
  /** The window's entries that ran, in order. */
  readonly entries: readonly WindowEntry[];
  /** Each ledger as it stood: how many rows, and its head. */
  readonly ledgerBefore: Readonly<Record<string, { rows: number; head: number }>>;
  /** The living letters only the old search found, counted before the first entry. */
  readonly oldSearchOwed: number;
  /** Tables the window drops. */
  readonly gone: readonly string[];
}

const n = async (tx: Executor, query: string): Promise<number> =>
  Number(rowsOf<{ n: string }>(await tx.execute(sql.raw(query)))[0]!.n);
const zero = (check: string, subject: string, found: number): Verdict =>
  ({ check, subject, expected: "0", found: String(found), ok: found === 0 });

/** 1. Every table of the map holds the count its formula gave, and `public` holds nothing else. */
export async function checkCounts(tx: Executor, i: CheckInput): Promise<Verdict[]> {
  const out: Verdict[] = [];
  const standing = new Set(await publicTables(tx));
  for (const [table, want] of [...i.expected].sort(([a], [b]) => a.localeCompare(b))) {
    if (!standing.has(table)) { out.push({ check: "count against the map's formula", subject: table, expected: String(want), found: "the table is missing", ok: false }); continue; }
    const found = await n(tx, `select count(*) as n from "${table}"`);
    out.push({ check: "count against the map's formula", subject: table, expected: String(want), found: String(found), ok: found === want });
  }
  // A table of the map with no expectation: the map names it for this store and the record of before never met it.
  for (const table of tablesOf(i.kind)) {
    if (standing.has(table) && !i.expected.has(table)) out.push({ check: "a table the record of before did not expect", subject: table, expected: "absent", found: "it exists", ok: false });
  }
  const owners = new Set(i.foreign.filter((f) => f.refuses === null).map((f) => f.name));
  const known = new Set(tablesOf(i.kind));
  const strangers = [...standing].filter((t) => !known.has(t) && !owners.has(t)).length;
  out.push(zero("tables the map does not name for this store", "public", strangers));
  const lost = [...owners].filter((t) => !standing.has(t)).length;
  out.push(zero("tables that are not the product's and are gone", "public", lost));
  for (const table of i.gone) out.push({ check: "a dropped table is gone", subject: table, expected: "gone", found: standing.has(table) ? "it exists" : "gone", ok: !standing.has(table) });
  return out;
}

/** 2. The thirteen that borrowed their account: none empty where it may not be, none under another account's parent. */
export async function checkBorrowers(tx: Executor, i: CheckInput): Promise<Verdict[]> {
  const out: Verdict[] = [];
  const pairs: [string, string, string, "mail" | "cloud", boolean][] = [
    ["message_bodies", "messages", "message_id", "mail", false], ["folder_state", "messages", "message_id", "mail", false],
    ["flag_state", "messages", "message_id", "mail", false], ["mailbox_credentials", "mailboxes", "mailbox_id", "mail", false],
    ["mailbox_folders", "mailboxes", "mailbox_id", "mail", false], ["pairing_tokens", "users", "created_by_user_id", "mail", true],
    ["credentials", "users", "user_id", "cloud", false], ["totp_secrets", "users", "user_id", "cloud", false],
    ["recovery_codes", "users", "user_id", "cloud", false], ["webauthn_credentials", "users", "user_id", "cloud", false],
    ["oauth_auth_codes", "users", "user_id", "cloud", false], ["login_tokens", "users", "user_id", "cloud", true],
    ["webauthn_challenges", "users", "user_id", "cloud", true],
  ];
  for (const [child, parent, fk, journal, mayNameNobody] of pairs) {
    if (journal === "cloud" && i.kind === "desktop") continue;
    out.push(zero("rows with an empty account where a parent is named", child,
      await n(tx, `select count(*) as n from "${child}" where "${fk}" is not null and account_id is null`)));
    if (mayNameNobody) out.push(zero("rows with an account and no parent", child,
      await n(tx, `select count(*) as n from "${child}" where "${fk}" is null and account_id is not null`)));
    out.push(zero("rows under another account than their parent's", child,
      await n(tx, `select count(*) as n from "${child}" c join "${parent}" p on p.id = c."${fk}" where p.account_id <> c.account_id`)));
  }
  if (i.kind === "desktop") return out;
  out.push(zero("auth_events that name a user and no account", "auth_events",
    await n(tx, `select count(*) as n from auth_events where user_id is not null and account_id is null`)));
  out.push(zero("counters whose numbers changed in the move, were lost or were added", "account_counters", await n(tx, `select count(*) as n from (
      (select account_id, key, failures, locked_until, window_started_at from pg_temp.ohmail_transition_counters
       except select account_id, key, failures, locked_until, window_started_at from account_counters)
      union all
      (select account_id, key, failures, locked_until, window_started_at from account_counters
       except select account_id, key, failures, locked_until, window_started_at from pg_temp.ohmail_transition_counters)) d`)));
  out.push(zero("alerts about a subject that exists and have no pointer to its account", "alert_state", await n(tx, `select count(*) as n from alert_state s
     where s.subject_account_id is null and (
           ((s.alert_key like 'session_reuse_revoked:%' or s.alert_key like 'session_refresh_replayed:%') and exists (select 1 from accounts a where a.id::text = split_part(s.alert_key, ':', 2)))
        or (s.alert_key like 'device_sync_stale:%' and exists (select 1 from devices d where d.id::text = split_part(s.alert_key, ':', 2)))
        or (s.alert_key like 'session_sync_stale:%' and exists (select 1 from sessions x where x.id::text = split_part(s.alert_key, ':', 2))))`)));
  return out;
}

/** 3. Every account still has what it had: sixteen figures, account by account. */
export async function checkPerAccount(tx: Executor): Promise<Verdict[]> {
  await recordPerAccount(tx, "after");
  const before = await n(tx, `select count(*) as n from pg_temp.ohmail_transition_accounts_before`);
  const after = await n(tx, `select count(*) as n from pg_temp.ohmail_transition_accounts_after`);
  const differ = await n(tx, `select count(*) as n from (
      (select * from pg_temp.ohmail_transition_accounts_before except select * from pg_temp.ohmail_transition_accounts_after)
      union all
      (select * from pg_temp.ohmail_transition_accounts_after except select * from pg_temp.ohmail_transition_accounts_before)) d`);
  return [
    zero("accounts whose sixteen figures differ from before", "accounts", differ),
    { check: "accounts compared", subject: "accounts", expected: String(before), found: String(after), ok: before === after },
  ];
}

/** 4. Every row of `pass_progress` means exactly what its columns meant, value by value. */
export async function checkPassMarks(tx: Executor): Promise<Verdict[]> {
  const columns = "account_id, job, subject_id, requested_at, started_at, done_at, cursor";
  return [zero("rows that differ from the marks they were written from", "pass_progress", await n(tx, `select count(*) as n from (
      (select ${columns} from pg_temp.ohmail_transition_passes except select ${columns} from pass_progress)
      union all
      (select ${columns} from pass_progress except select ${columns} from pg_temp.ohmail_transition_passes)) d`))];
}

/**
 * The tables of `public` that carry `account_id`, as the store's own catalog has them, sorted.
 * Tables only: a view is not a place a row lives. What a test of the erasure, the export or the
 * isolation's policies compares its own list with; a runtime sweep takes its list from the
 * product's schema, never from here, or it would reach into a table that is not the product's.
 */
export async function accountTablesFromCatalog(db: Executor): Promise<string[]> {
  return rowsOf<{ name: string }>(await db.execute(sql`
    select c.relname::text as name from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace s on s.oid = c.relnamespace
     where s.nspname = 'public' and c.relkind in ('r', 'p') and a.attname = 'account_id' and a.attnum > 0 and not a.attisdropped
     order by 1`)).map((r) => r.name);
}

/** 6. The catalog: nothing left half done, and exactly the map's tables carry the account. */
export async function checkCatalog(tx: Executor, i: CheckInput): Promise<Verdict[]> {
  const out: Verdict[] = [
    zero("constraints not validated", "public", await n(tx, `select count(*) as n from pg_constraint c join pg_namespace s on s.oid = c.connamespace where s.nspname = 'public' and not c.convalidated`)),
    zero("indexes not valid", "public", await n(tx, `select count(*) as n from pg_index x join pg_class c on c.oid = x.indexrelid join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'public' and not x.indisvalid`)),
  ];
  // Tables only, and none of those that are not the product's and were left alone: such a table may
  // carry a column of that name and is not a fault.
  const carrying = await accountTablesFromCatalog(tx);
  const owners = new Set(i.foreign.filter((f) => f.refuses === null).map((f) => f.name));
  const found = new Set(carrying.filter((t) => !owners.has(t)));
  const want = new Set(accountTablesOf(i.kind));
  out.push({ check: "tables that carry the account", subject: "public", expected: String(want.size), found: String(found.size), ok: want.size === found.size });
  // Of the map's own names only: a table outside it is counted by check 1.
  for (const t of [...want].filter((x) => !found.has(x)).sort()) out.push({ check: "a table of the map does not carry the account", subject: t, expected: "account_id", found: "no such column", ok: false });
  out.push(zero("tables that carry the account and are not in the map's list", "public", [...found].filter((x) => !want.has(x)).length));
  return out;
}

/** 7. The old search is whole or gone, and which of the two agrees with the count of what it alone finds. */
export async function checkOldSearch(tx: Executor, i: CheckInput): Promise<Verdict[]> {
  const owed = await n(tx, OLD_SEARCH_OWED_AFTER);
  const out: Verdict[] = [{ check: "living letters only the old search finds: the same before and after", subject: "messages", expected: String(i.oldSearchOwed), found: String(owed), ok: owed === i.oldSearchOwed }];
  const parts: [string, string][] = [
    ["column message_bodies.body_tsv", `exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'message_bodies' and column_name = 'body_tsv')`],
    ["column messages.subject_tsv", `exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'messages' and column_name = 'subject_tsv')`],
    ["trigger message_bodies_body_tsv_tg", `exists (select 1 from pg_trigger where tgrelid = 'public.message_bodies'::regclass and tgname = 'message_bodies_body_tsv_tg')`],
  ];
  const want = i.oldSearchOwed > 0 ? "there" : "gone";
  for (const [what, probe] of parts) {
    const there = rowsOf<{ there: boolean }>(await tx.execute(sql.raw(`select ${probe} as there`)))[0]!.there ? "there" : "gone";
    out.push({ check: `the old search is ${i.oldSearchOwed > 0 ? "standing: letters are found by it alone" : "gone: nothing is found by it alone"}`, subject: what, expected: want, found: there, ok: there === want });
  }
  return out;
}

/** 8. What is left in `auth_throttle` names no row: no key carries an address, none carries an id. */
export async function checkThrottleKeys(tx: Executor, i: CheckInput): Promise<Verdict[]> {
  if (i.kind === "desktop") return [];
  return [
    zero("counter keys that carry an address", "auth_throttle", await n(tx, `select count(*) as n from auth_throttle where key like '%@%'`)),
    zero("counter keys that carry an id", "auth_throttle", await n(tx, `select count(*) as n from auth_throttle where key ~ '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'`)),
  ];
}

/** 9. Each ledger gained exactly its journal's entries, each with its file's hash and its stamp, and reads the new head. */
export async function checkLedger(tx: Executor, i: CheckInput): Promise<Verdict[]> {
  const out: Verdict[] = [];
  for (const journal of ["mail", "cloud"] as const) {
    const entries = i.entries.filter((e) => e.journal === journal);
    if (entries.length === 0) continue;
    const ledger = `"drizzle_${journal}"."__drizzle_migrations"`;
    const [now] = rowsOf<{ rows: string; head: string }>(await tx.execute(sql.raw(`select count(*)::text as rows, max(created_at)::text as head from ${ledger}`)));
    const before = i.ledgerBefore[journal]!;
    const head = entries.at(-1)!.when;
    out.push({ check: "the ledger's head is the window's last entry", subject: journal, expected: String(head), found: now!.head, ok: Number(now!.head) === head });
    out.push({ check: "the ledger gained the window's entries and no other", subject: journal, expected: String(entries.length), found: String(Number(now!.rows) - before.rows), ok: Number(now!.rows) - before.rows === entries.length });
    let missing = 0;
    for (const e of entries) {
      const [r] = rowsOf<{ n: string }>(await tx.execute(sql`select count(*)::text as n from ${sql.raw(ledger)} where hash = ${e.hash} and created_at = ${e.when}`));
      if (r!.n !== "1") missing += 1;
    }
    out.push(zero("entries not recorded once with their hash and stamp", journal, missing));
  }
  return out;
}
