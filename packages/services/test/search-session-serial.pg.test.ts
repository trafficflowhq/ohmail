import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { accountSettings, folderState, mailboxes, messageBodies, messages } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { ensureSearchExtensions } from "@trafficflow/db/admin";
import { MIGRATED_DB_SETUP_BUDGET_MS, MIGRATED_DB_TEARDOWN_BUDGET_MS, throwawayDb } from "@trafficflow/db/testing";
import { upsertMessageSearch } from "@trafficflow/core/mail";
import { SearchService } from "@trafficflow/services";
import type { ServiceContext } from "@trafficflow/services";

/**
 * A SEARCH READ NEVER JIT-COMPILES AND NEVER STARTS PARALLEL WORKERS (SELFHOST-SEARCH-BROAD-OVER-BUDGET).
 * A stock Postgres arms both on plan cost: on the self-hosted large fixture a broad word's page priced
 * past JIT's threshold, compiled for ~60 ms and read 137 ms p95 against 41 without it. This connection
 * makes ANY plan JIT (`jit_above_cost = 0`) and every parallel path free (a Gather wherever one is
 * allowed), so the rule holds at any size: the service's own session statement and
 * reads, captured on the wire, are replayed under EXPLAIN. The control drops the two settings.
 *
 * It runs on a database of its own, without the word index. On a shared database the rows and
 * statistics earlier files left decided whether the estimate's arms gathered, and once a file had
 * built the index its text and part arms were keyed, which plan no Gather even with workers free.
 */
type Wire = { sql: string; params: unknown[] };
let wire: Wire[] = [];
/* Built and removed by the hooks below. */
const privateDb = throwawayDb("trafficflow_search_serial");
const client = postgres(privateDb.url, {
  max: 1, onnotice: () => {},
  // Strings: the driver drops a startup option whose value is falsy, and 0 is. Parallel paths are
  // free too, so an arm inside a statement no Gather can top is planned with workers wherever allowed.
  connection: {
    jit_above_cost: "0", jit_inline_above_cost: "0", jit_optimize_above_cost: "0", debug_parallel_query: "on",
    parallel_setup_cost: "0", parallel_tuple_cost: "0", min_parallel_table_scan_size: "0", min_parallel_index_scan_size: "0",
  },
  debug: (_c: number, q: string, params: unknown[]) => { wire.push({ sql: q, params: [...params] }); },
});
const db = brandDialect(drizzle(client, { schema }), "pg");
const svc = new SearchService();
const NOW = new Date("2026-09-26T12:00:00.000Z");
const A = randomUUID();
const ctx = (): ServiceContext => ({ db: db as never, accountId: A, userId: null, now: () => NOW, requestId: "search-session-serial" });

const SETTINGS = /set_config\('enable_seqscan'/;
const isTx = (s: string) => /^\s*(begin|commit)\b/i.test(s);

/** What one answer sent: its session statement and every read after it, in order. */
async function sent(run: () => Promise<unknown>): Promise<{ session: Wire[]; reads: Wire[] }> {
  wire = [];
  await run();
  const own = wire.filter((w) => !isTx(w.sql));
  return { session: own.filter((w) => SETTINGS.test(w.sql)), reads: own.filter((w) => !SETTINGS.test(w.sql)) };
}

/** Each read's plan under `session` (or the control's settings): does it JIT, does it gather? */
async function planned(session: Wire[], reads: Wire[]): Promise<Array<{ jit: boolean; gather: boolean }>> {
  const out: Array<{ jit: boolean; gather: boolean }> = [];
  await client.begin(async (tx) => {
    for (const s of session) await tx.unsafe(s.sql, s.params as never[]);
    for (const r of reads) {
      const [row] = await tx.unsafe(`explain (analyze, format json) ${r.sql}`, r.params as never[]);
      const plan = JSON.stringify(Object.values(row as object)[0]);
      out.push({ jit: /"JIT"/.test(plan), gather: /"Node Type":\s*"Gather/.test(plan) });
    }
  });
  return out;
}

describe("a search read is planned serial and uncompiled on a stock Postgres", () => {
  beforeAll(async () => {
    await privateDb.createFromTemplate();
    await ensureSearchExtensions(db, { concurrently: false });
    // The index state this file reads, whatever the template carries (see above).
    await client`drop index if exists message_search_words_idx`;
    const [jit] = await client`select pg_jit_available() as ok`;
    expect(jit!.ok, "this server can JIT (the self-hosted image can): without it the JIT half measures nothing").toBe(true);
    const [mb] = await db.insert(mailboxes).values({ accountId: A, provider: "imap", address: `${A.slice(0, 8)}@serial.example` }).returning();
    for (let i = 0; i < 12; i++) {
      const [m] = await db.insert(messages).values({
        accountId: A, mailboxId: mb!.id, bodyHash: "h", dedupKey: `serial:${randomUUID()}`,
        subject: `heron sighting ${i}`, fromAddress: `watcher${i % 3}@serial.example`,
        date: new Date(NOW.getTime() - i * 3_600_000), unread: i % 2 === 0, hasAttachments: false,
        nativeLocator: { folder: "INBOX", ref: `1:${i}` },
      }).returning();
      await db.insert(messageBodies).values({ messageId: m!.id, text: `a heron by the lake, note ${i}` });
      await db.insert(folderState).values({ messageId: m!.id, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us" });
      await upsertMessageSearch(db as never, m!.id, {
        accountId: A, subject: `heron sighting ${i}`, from: { name: null, address: `watcher${i % 3}@serial.example` }, to: [], cc: [],
        attachmentNames: [], bodyText: `a heron by the lake, note ${i}`, source: "text",
      });
    }
    await db.insert(accountSettings).values({ accountId: A, searchIndexBuiltAt: NOW })
      .onConflictDoUpdate({ target: accountSettings.accountId, set: { searchIndexBuiltAt: NOW } });
    await svc.search(ctx(), { q: "heron", parts: "page", limit: 4 });
  }, MIGRATED_DB_SETUP_BUDGET_MS);
  afterAll(async () => {
    await client.end();
    await privateDb.drop();
  }, MIGRATED_DB_TEARDOWN_BUDGET_MS);

  const answers: Array<[string, () => Promise<unknown>]> = [
    ["page", () => svc.search(ctx(), { q: "heron", parts: "page", limit: 4 })],
    ["closest words", () => svc.search(ctx(), { q: "herom", parts: "page", limit: 4 })],
    ["estimate", () => svc.search(ctx(), { q: "heron", parts: "estimate", limit: 4 })],
    ["summary", () => svc.search(ctx(), { q: "heron", parts: "summary" })],
    ["address", () => svc.searchByAddress(ctx(), { address: "watcher1@serial.example", direction: "from" })],
  ];

  it("every read of every answer: no JIT, no Gather, under the service's own session statement", async () => {
    for (const [name, run] of answers) {
      const { session, reads } = await sent(run);
      expect(session, `${name}: one session statement`).toHaveLength(1);
      expect(reads.length, `${name}: reads`).toBeGreaterThan(0);
      expect(await planned(session, reads), name).toEqual(reads.map(() => ({ jit: false, gather: false })));
    }
  }, 60_000);

  it("the control: the same reads under the index preference alone JIT and gather on this connection", async () => {
    const control: Wire[] = [{ sql: "select set_config('enable_seqscan', 'off', true)", params: [] }];
    for (const [name, run] of answers) {
      const { reads } = await sent(run);
      const plans = await planned(control, reads);
      expect(plans.some((p) => p.jit), `${name}: some read JITs`).toBe(true);
      // The summary reads at most 2,001 documents a branch: too few to gather even unshaped.
      if (name !== "summary") expect(plans.some((p) => p.gather), `${name}: some read gathers`).toBe(true);
    }
  }, 60_000);
});
