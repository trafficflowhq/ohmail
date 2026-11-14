import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import type { Tx } from "@trafficflow/db";
import { searchInputsFromStore, upsertMessageSearchRows } from "@trafficflow/core/mail";
import { SEARCH_STATISTICS_TABLES, openLocalDb, type OpenLocalDb } from "../src/db.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS * 2 });

/**
 * THE SEARCH'S STATISTICS ARE THE STORE'S TO KEEP — PGlite has no autovacuum, and unanalyzed the
 * search arms plan on defaults (on the large corpus: "invoice" page p95 242 ms, 62 ms analyzed). The server's
 * threshold, per table the arms read, from a count: never analyzed while it holds rows, or changed past
 * the server's own threshold since, or no column statistics at all (an index build sets the count and reads no
 * column). Watched red: drop the ANALYZE (the second call runs again), widen the threshold (the last
 * one does not run), the search table alone in the list or the statistics check dropped (case 2).
 */
const dirs: string[] = [];
const opened: OpenLocalDb[] = [];
afterEach(async () => {
  for (const o of opened.splice(0)) await o.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const rows = (r: unknown): any[] => (Array.isArray(r) ? r : ((r as { rows?: any[] }).rows ?? []));

/** Messages and their search documents, written the way ingest writes them. */
async function documents(o: OpenLocalDb, accountId: string, mailboxId: string, n: number): Promise<void> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = randomUUID();
    ids.push(id);
    await o.db.execute(sql`insert into messages (id, account_id, mailbox_id, body_hash, dedup_key, subject, from_address, date, to_addresses, cc_addresses, native_locator)
      values (${id}, ${accountId}, ${mailboxId}, 'h', ${`st:${id}`}, ${`subject ${i}`}, 'a@mail.example', now(), '[]'::jsonb, '[]'::jsonb, '{"folder":"INBOX","ref":"1:1"}'::jsonb)`);
  }
  const db = o.db as unknown as Tx;
  await upsertMessageSearchRows(db, await searchInputsFromStore(db, accountId, ids));
}
const reltuples = async (o: OpenLocalDb, table = "message_search"): Promise<number> =>
  Number(rows(await o.db.execute(sql`select reltuples::float8 as rt from pg_class where relname = ${table}`))[0]?.rt);

describe("the search table's planner statistics", () => {
  it("analyzes a table never analyzed, not again within 50 + 10 %, and again past it", async () => {
    const dir = await freshDataDir("ohmail-search-stats-");
    dirs.push(dir);
    const o = await openLocalDb(dir);
    opened.push(o);
    const accountId = rows(await o.db.execute(sql`insert into accounts (name) values ('stats') returning id`))[0].id;
    const mailboxId = rows(await o.db.execute(sql`insert into mailboxes (account_id, provider, address) values (${accountId}, 'imap', 'stats@mail.example') returning id`))[0].id;
    expect(await o.analyzeSearchIfStale(), "an empty table has nothing to analyze").toBe(false);
    await documents(o, accountId, mailboxId, 120);
    expect(await o.analyzeSearchIfStale(), "never analyzed, holding rows").toBe(true);
    expect(await reltuples(o)).toBe(120);
    expect(await o.analyzeSearchIfStale(), "nothing changed since").toBe(false);
    await documents(o, accountId, mailboxId, 30);
    expect(await o.analyzeSearchIfStale(), "30 of 120 is inside 50 + 10 %").toBe(false);
    await documents(o, accountId, mailboxId, 60);
    expect(await o.analyzeSearchIfStale(), "90 of 120 is past it").toBe(true);
    expect(await reltuples(o)).toBe(210);
  });

  it("keeps every table the arms read: mail taken in before its documents is analyzed on its own", async () => {
    expect([...SEARCH_STATISTICS_TABLES].sort()).toEqual(["folder_state", "message_bodies", "message_search", "messages"]);
    const dir = await freshDataDir("ohmail-search-stats-tables-");
    dirs.push(dir);
    const o = await openLocalDb(dir);
    opened.push(o);
    const accountId = rows(await o.db.execute(sql`insert into accounts (name) values ('stats') returning id`))[0].id;
    const mailboxId = rows(await o.db.execute(sql`insert into mailboxes (account_id, provider, address) values (${accountId}, 'imap', 'stats@mail.example') returning id`))[0].id;
    await documents(o, accountId, mailboxId, 120);
    expect(await o.analyzeSearchIfStale()).toBe(true);
    // Messages, bodies and folders the way a drain lands them, with no search document yet.
    await o.db.execute(sql`insert into messages (account_id, mailbox_id, body_hash, dedup_key, subject, from_address, date, to_addresses, cc_addresses, native_locator)
      select ${accountId}, ${mailboxId}, 'h', 'st:bare:' || g, 'bare ' || g, 'a@mail.example', now(), '[]'::jsonb, '[]'::jsonb, '{"folder":"INBOX","ref":"1:1"}'::jsonb
      from generate_series(1, 200) g`);
    await o.db.execute(sql`insert into message_bodies (message_id, account_id, text) select id, account_id, 'body' from messages where dedup_key like 'st:bare:%'`);
    await o.db.execute(sql`insert into folder_state (message_id, account_id, desired_folder, observed_folder, last_set_by) select id, account_id, 'INBOX', 'INBOX', 'us' from messages where dedup_key like 'st:bare:%'`);
    expect(await o.analyzeSearchIfStale(), "the search table did not move, the others did").toBe(true);
    expect(await reltuples(o, "messages")).toBe(320);
    expect(await reltuples(o, "message_bodies")).toBe(200);
    expect(await reltuples(o, "folder_state")).toBe(200);
    expect(await reltuples(o)).toBe(120);
    expect(await o.analyzeSearchIfStale(), "nothing changed since").toBe(false);
    // An index build sets the row count and reads no column: the count agrees, the planner is blind.
    await o.db.execute(sql`delete from pg_statistic where starelid = 'public.messages'::regclass`);
    expect(await reltuples(o, "messages")).toBe(320);
    expect(await o.analyzeSearchIfStale(), "a table with no column statistics").toBe(true);
    expect(Number(rows(await o.db.execute(sql`select count(*)::int as n from pg_stats where tablename = 'messages'`))[0]?.n)).toBeGreaterThan(0);
  });
});
