import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { migrateToOldHeads } from "../src/admin.js";

/**
 * A STORE IN 1.0.11'S SHAPE: `url`'s database walked along the 1.0 road (both journals as they
 * stood at `OLD_HEADS`) and no further, by drizzle's own migrator with the real hashes. Pair it
 * with a `throwawayDb`; what a test plants into it afterwards is planted in 1.0's columns, in
 * plain SQL, because this tree's schema objects describe 2.0.
 */
export async function makeStoreAtOldHeads(url: string): Promise<void> {
  await migrateToOldHeads(url);
}

type Sql = ReturnType<typeof postgres>;

/** One account with one mailbox, in columns every release since 1.0 carries. */
export async function plantAccount(sql: Sql, accountId: string): Promise<{ accountId: string; mailboxId: string }> {
  await sql`insert into accounts (id, name) values (${accountId}, ${`planted-${accountId.slice(0, 8)}`})`;
  const [mb] = await sql<{ id: string }[]>`insert into mailboxes (account_id, provider, address)
    values (${accountId}, 'imap', ${`${accountId.slice(0, 8)}@planted.test`}) returning id`;
  return { accountId, mailboxId: mb!.id };
}

/**
 * One living letter with its body, and no search document: what only the old search finds.
 * `shape` is the store's: a body names its account since mail 0201, and has no such column before.
 */
export async function plantLetter(
  sql: Sql, at: { accountId: string; mailboxId: string }, o: { subject: string; text: string },
  shape: "1.0" | "2.0" = "1.0",
): Promise<string> {
  const [m] = await sql<{ id: string }[]>`insert into messages (account_id, mailbox_id, body_hash, dedup_key, subject, date)
    values (${at.accountId}, ${at.mailboxId}, 'h', ${`planted:${at.accountId}:${Math.random()}`}, ${o.subject}, now()) returning id`;
  if (shape === "1.0") await sql`insert into message_bodies (message_id, text) values (${m!.id}, ${o.text})`;
  else await sql`insert into message_bodies (message_id, account_id, text) values (${m!.id}, ${at.accountId}, ${o.text})`;
  return m!.id;
}

/** One row of `pass_progress`, as mail 0203 must write it from 1.0's columns. */
export interface MovedPassRow {
  account_id: string; job: string; subject_id: string;
  requested_at: Date | null; started_at: Date | null; done_at: Date | null; cursor: string | null;
}

/**
 * EVERY MARK 1.0 KEPT IN COLUMNS, planted on a store at the old heads: all fourteen on one account
 * and its mailbox, a walk that stopped part way on a second, and nothing on a third. Returns the
 * rows `pass_progress` holds once mail 0203 has run, ordered by account then pass.
 */
export async function plantPassMarks(sql: Sql): Promise<MovedPassRow[]> {
  const at = (n: number): Date => new Date(Date.UTC(2026, 2, 1, 10, 0, n));
  const [first, second, third] = [
    "00000000-0000-4000-8000-00000000000a", "00000000-0000-4000-8000-00000000000b", "00000000-0000-4000-8000-0000000000a0",
  ] as const;
  const whole = await plantAccount(sql, randomUUID());
  const midWalk = await plantAccount(sql, randomUUID());
  const never = await plantAccount(sql, randomUUID());
  for (const a of [whole, midWalk, never]) await sql`insert into account_settings (account_id) values (${a.accountId})`;
  await sql`update mailboxes set kickstart_at = ${at(1)}, sensitive_rescreen_at = ${at(2)}, sensitive_rescreen_cursor = ${first},
      sensitive_rescreen_started_at = ${at(3)}, sensitive_fp_backfill_at = ${at(4)}, legacy_news_clean_at = ${at(5)}
    where id = ${whole.mailboxId}`;
  await sql`update account_settings set ohbox_tidy_requested_at = ${at(11)}, ohbox_tidy_done_at = ${at(12)}, ohbox_tidy_cursor = ${second},
      gate_release_done_at = ${at(13)}, search_index_built_at = ${at(14)}, list_addresses_scanned_at = ${at(15)},
      html_words_backfill_at = ${at(16)}, html_words_backfill_cursor = ${third}
    where account_id = ${whole.accountId}`;
  await sql`update mailboxes set sensitive_rescreen_cursor = ${second}, sensitive_rescreen_started_at = ${at(21)} where id = ${midWalk.mailboxId}`;
  await sql`update account_settings set html_words_backfill_cursor = ${first}, ohbox_tidy_requested_at = ${at(22)} where account_id = ${midWalk.accountId}`;
  const row = (a: { accountId: string; mailboxId: string }, job: string, subject: "accountId" | "mailboxId", marks: Partial<MovedPassRow>): MovedPassRow =>
    ({ account_id: a.accountId, job, subject_id: a[subject], requested_at: null, started_at: null, done_at: null, cursor: null, ...marks });
  return [
    row(whole, "kickstart", "mailboxId", { done_at: at(1) }),
    row(whole, "sensitive_rescreen", "mailboxId", { done_at: at(2), started_at: at(3), cursor: first }),
    row(whole, "sensitive_fp_backfill", "mailboxId", { done_at: at(4) }),
    row(whole, "news_repair", "mailboxId", { done_at: at(5) }),
    row(whole, "ohbox_tidy", "accountId", { requested_at: at(11), done_at: at(12), cursor: second }),
    row(whole, "gate_release", "accountId", { done_at: at(13) }),
    row(whole, "search_index_backfill", "accountId", { done_at: at(14) }),
    row(whole, "list_address_backfill", "accountId", { done_at: at(15) }),
    row(whole, "html_words_backfill", "accountId", { done_at: at(16), cursor: third }),
    row(midWalk, "sensitive_rescreen", "mailboxId", { started_at: at(21), cursor: second }),
    row(midWalk, "html_words_backfill", "accountId", { cursor: first }),
    row(midWalk, "ohbox_tidy", "accountId", { requested_at: at(22) }),
  ].sort((a, b) => (a.account_id + a.job).localeCompare(b.account_id + b.job));
}
