import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, sql } from "drizzle-orm";
import { brandDialect } from "@trafficflow/db/dialect";
import { mailboxes, messages, messageBodies, folderState } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations, ensureSearchExtensions } from "@trafficflow/db/admin";
import { searchIndexBackfillPass } from "@trafficflow/core/mail";
import { pgTestUrl } from "@trafficflow/db/testing";
import { SearchService } from "@trafficflow/services";
import type { ServiceContext } from "@trafficflow/services";

/**
 * WHAT A SEARCH SAYS ABOUT ITS REACH, on real Postgres (pg_trgm lives only here). A cut arm says
 * "at least N" until the exact count lands, and no number it shows comes from planner statistics,
 * which cover every account's mail: a neighbour's mail moves none of them. And the import's clock
 * through the warm session's inline literals, which only real Postgres compares as timestamptz.
 */
const URL = pgTestUrl(import.meta.url);
/**
 * THE RUN'S OWN TABLES. A planner estimate reads table-wide statistics, so co-tenant documents on a
 * shared database diluted the word's frequency and the control read 49 to 140 for 300 matches. The
 * four tables the estimate plans over are shadowed by session TEMP copies (same columns, defaults,
 * indexes and triggers), so this run's rows are all the statistics see. ONE connection: temp tables
 * belong to the session that made them.
 */
const client = postgres(URL, { max: 1 });
const OWN_TABLES = ["messages", "message_search", "message_bodies", "folder_state"] as const;
const db = brandDialect(drizzle(client, { schema }), "pg");
const NOW = new Date("2026-08-20T12:00:00.000Z");
const A = randomUUID();
/** The neighbour: another account on the same tables, which gains the word in many letters. */
const N = randomUUID();
const NEIGHBOUR_MATCHES = 30_000;
const MATCHES = 300;
let mailboxId = "";
const ctx = (): ServiceContext => ({ db, accountId: A, userId: null, now: () => NOW, requestId: "search-reach" });

describe("what a search says about its reach (real Postgres)", () => {
  beforeAll(async () => {
    await runMigrations(URL);
    await ensureSearchExtensions(db, { concurrently: false });
    for (const t of OWN_TABLES) {
      await client.unsafe(`create temp table ${t} (like public.${t} including all)`);
      const triggers = await client.unsafe(
        `select pg_get_triggerdef(oid) as d from pg_trigger where tgrelid = 'public.${t}'::regclass and not tgisinternal`);
      for (const { d } of triggers as unknown as Array<{ d: string }>) {
        const own = d.replace(` ON public.${t} `, ` ON pg_temp.${t} `);
        expect(own, `the trigger moved onto the run's own ${t}`).not.toBe(d);
        await client.unsafe(own);
      }
      const [where] = await client.unsafe(
        `select n.nspname as s from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.oid = '${t}'::regclass`);
      expect(String(where!.s), `${t} resolves to this run's own copy`).toMatch(/^pg_temp/);
    }
    const [mb] = await db.insert(mailboxes).values({ accountId: A, provider: "imap", address: "reach@tf.example" }).returning();
    mailboxId = mb!.id;
    for (let i = 0; i < MATCHES + 40; i++) {
      const hit = i < MATCHES;
      const [m] = await db.insert(messages).values({
        accountId: A, mailboxId, bodyHash: "h", dedupKey: `reach:${randomUUID()}`,
        subject: hit ? `Your invoice ${1000 + i}` : `Holiday plans ${i}`, fromAddress: `s${i % 7}@site.example`,
        date: new Date(NOW.getTime() - i * 3_600_000), unread: false, hasAttachments: false,
        nativeLocator: { folder: "INBOX", ref: `1:${i + 1}` },
      }).returning();
      await db.insert(messageBodies).values({ messageId: m!.id, text: hit ? "The amount is due." : "See you soon." });
      await db.insert(folderState).values({ messageId: m!.id, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us" });
    }
    let marked = false;
    for (let r = 0; r < 10 && !marked; r++) marked = (await searchIndexBackfillPass({ db: db as never, accountId: A })).marked;
    expect(marked, "the documents are built").toBe(true);
    await db.execute(sql`analyze messages`);
    await db.execute(sql`analyze message_search`);
    await db.update(mailboxes).set({ initialImportCompletedAt: NOW }).where(eq(mailboxes.id, mailboxId));
  }, 240_000);

  afterAll(async () => {
    await db.execute(sql`delete from message_search where account_id = ${N}`);
    await db.execute(sql`delete from messages where account_id = ${N}`);
    await db.execute(sql`delete from mailboxes where account_id = ${N}`);
    await db.execute(sql`delete from message_search where message_id in (select id from messages where account_id = ${A})`);
    await db.execute(sql`delete from folder_state where message_id in (select id from messages where account_id = ${A})`);
    await db.execute(sql`delete from message_bodies where message_id in (select id from messages where account_id = ${A})`);
    await db.execute(sql`delete from messages where account_id = ${A}`);
    await db.execute(sql`delete from account_settings where account_id = ${A}`);
    await db.execute(sql`delete from mailboxes where account_id = ${A}`);
    await client.end();
  });

  it("a cut typo arm gives no estimate: the page's count is a lower bound, and the summary is exact", async () => {
    const svc = new SearchService();
    const e = await svc.search(ctx(), { q: "invoce", parts: "estimate", limit: 5 });
    expect({ tier: e.tier, exact: e.totalExact, estimate: "totalEstimate" in e }).toEqual({ tier: "similar", exact: false, estimate: false });
    expect(e.total, "the cut, said as at least").toBe(20);
    const s = await svc.search(ctx(), { q: "invoce", parts: "summary", limit: 5 });
    expect({ tier: s.tier, total: s.total, exact: s.totalExact }).toEqual({ tier: "similar", total: MATCHES, exact: true });
  });

  it("past its first day, an import whose cycles still owe mail is open on the warm, inlined path", async () => {
    const svc = new SearchService();
    const page = async () => "importing" in (await svc.search(ctx(), { q: "invoice", parts: "page", limit: 5 }));
    expect(await page(), "stamped: the whole mailbox").toBe(false);
    const set = (v: Partial<typeof mailboxes.$inferInsert>) => db.update(mailboxes).set(v).where(eq(mailboxes.id, mailboxId));
    await set({ initialImportCompletedAt: null, createdAt: new Date(NOW.getTime() - 25 * 3_600_000), syncProgressAt: new Date(NOW.getTime() - 60_000) });
    expect(await page(), "progress a minute ago").toBe(true);
    await set({ syncProgressAt: new Date(NOW.getTime() - 25 * 3_600_000) });
    expect(await page(), "progress a day old").toBe(false);
    await set({ initialImportCompletedAt: NOW, syncProgressAt: null });
  });

  it("a neighbour gaining the word in 30,000 letters moves none of this account's numbers", async () => {
    const svc = new SearchService();
    const numbers = async () => Promise.all((["page", "estimate", "summary"] as const).map(async (parts) => {
      const r = await svc.search(ctx(), { q: "invoice", parts, limit: 5 });
      return { parts, tier: r.tier, total: r.total, exact: r.totalExact, estimate: (r as { totalEstimate?: number }).totalEstimate ?? null };
    }));
    const before = await numbers();
    expect(before.find((x) => x.parts === "summary")).toMatchObject({ total: MATCHES, exact: true });
    const [mb] = await db.insert(mailboxes).values({ accountId: N, provider: "imap", address: "neighbour@tf.example" }).returning();
    await db.execute(sql`insert into messages (id, account_id, mailbox_id, body_hash, dedup_key, subject, from_address, date, unread, has_attachments, native_locator)
      select gen_random_uuid(), ${N}::uuid, ${mb!.id}::uuid, 'h', 'reach-n:' || g, 'Your invoice ' || g, 'billing@shop.example',
        ${NOW.toISOString()}::timestamptz - make_interval(mins => g), false, false, jsonb_build_object('folder', 'INBOX', 'ref', '1:' || g)
      from generate_series(1, ${NEIGHBOUR_MATCHES}) g`);
    await db.execute(sql`insert into message_search (message_id, account_id, head_tsv, text_tsv, terms, source)
      select m.id, m.account_id, to_tsvector('english', m.subject), to_tsvector('english', 'The amount is due.'), lower(m.subject), 'text'
      from messages m where m.account_id = ${N}::uuid`);
    await db.execute(sql`analyze messages`);
    await db.execute(sql`analyze message_search`);
    expect(await numbers()).toEqual(before);
  }, 120_000);
});
