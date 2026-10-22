import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { brandDialect } from "@trafficflow/db/dialect";
import { mailboxes, messages } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { pgTestUrl } from "@trafficflow/db/testing";
import { MailboxService, MessageService } from "@trafficflow/services";
import type { ServiceContext } from "@trafficflow/services";

/**
 * HISTORY FROM THE STORE — `view=all` pages every living message newest first to the first one,
 * and the timeline's months add up to the total the list has. Real Postgres; one random account
 * with messages over 26 months, two undated, one tombstoned, spread over two mailboxes.
 */
const PG_URL = pgTestUrl(import.meta.url);
const client = postgres(PG_URL, { max: 3, onnotice: () => {} });
const db = brandDialect(drizzle(client, { schema }), "pg");
const svc = new MessageService();
const A = randomUUID();
const ctx: ServiceContext = { db, accountId: A, userId: null, now: () => new Date(), requestId: "history" } as never;
let oldestId = "";
let tombstoneId = "";

describe("History pages the whole store (real Postgres)", () => {
  beforeAll(async () => {
    await runMigrations(PG_URL);
    const [m1] = await db.insert(mailboxes).values({ accountId: A, provider: "imap", address: "h1@tf.example" }).returning();
    const [m2] = await db.insert(mailboxes).values({ accountId: A, provider: "imap", address: "h2@tf.example" }).returning();
    const start = Date.parse("2024-01-15T10:00:00Z");
    for (let i = 0; i < 130; i++) {
      const date = i >= 128 ? null : new Date(start + Math.floor(i / 5) * 30 * 86_400_000 + i * 3_600_000);
      const [row] = await db.insert(messages).values({
        accountId: A, mailboxId: (i % 2 ? m1 : m2)!.id, bodyHash: "h", dedupKey: `hist:${i}`, subject: `m${i}`,
        date, nativeLocator: { folder: "INBOX", ref: `1:${i}` },
        ...(i === 60 ? { deletedAt: new Date() } : {}),
      }).returning();
      if (i === 0) oldestId = row!.id;
      if (i === 60) tombstoneId = row!.id;
    }
  });

  afterAll(async () => {
    await db.execute(sql`delete from messages where account_id = ${A}`);
    await db.execute(sql`delete from mailboxes where account_id = ${A}`);
    await client.end({ timeout: 5 });
  });

  it("walks every living message once, newest first, the undated tail last", async () => {
    const seen: Array<{ id: string; date: string | null }> = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await svc.list(ctx, { view: "all", limit: 50, ...(cursor ? { cursor } : {}) });
      seen.push(...page.items.map((m) => ({ id: m.id, date: m.date ?? null })));
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen.length).toBe(129);
    expect(new Set(seen.map((s) => s.id)).size).toBe(129);
    expect(seen.map((s) => s.id)).not.toContain(tombstoneId);
    // The oldest DATED message is the last before the two undated ones.
    expect(seen[seen.length - 3]!.id).toBe(oldestId);
    expect(seen.slice(-2).every((s) => s.date === null)).toBe(true);
    const dated = seen.slice(0, -2).map((s) => Date.parse(s.date!));
    expect(dated).toEqual([...dated].sort((a, b) => b - a));
  });

  it("the timeline's months and undated tail sum to the total, and a jump lands on the month", async () => {
    const t = await svc.timeline(ctx);
    expect(t.total).toBe(129);
    expect(t.undated).toBe(2);
    expect(t.months.reduce((n, m) => n + m.count, 0) + t.undated).toBe(t.total);
    expect(t.months.map((m) => m.month)).toEqual([...t.months.map((m) => m.month)].sort().reverse());
    const target = t.months[Math.floor(t.months.length / 2)]!;
    const page = await svc.list(ctx, { view: "all", at: target.first, limit: 5 });
    expect(page.items[0]!.id).toBe(target.first.id);
    expect(page.items[0]!.date!.slice(0, 7)).toBe(target.month);
    // The instant alone lands on the same row: nothing newer shares the month's newest instant.
    const byDate = await svc.list(ctx, { view: "all", at: { date: target.first.date }, limit: 5 });
    expect(byDate.items[0]!.id).toBe(target.first.id);
    // `before` is exclusive: the same position starts one row later.
    const after = await svc.list(ctx, { view: "all", before: { date: target.first.date, id: page.items[0]!.id }, limit: 5 });
    expect(after.items[0]!.id).toBe(page.items[1]!.id);
  });

  /* Settings counted more than History said was every message owned — the
     mailbox count took the tombstones in. Both figures answer one question, so they must agree. */
  it("Settings' per-mailbox counts add up to History's total, the tombstone in neither", async () => {
    const t = await svc.timeline(ctx);
    const rows = await new MailboxService({ signatureChecks: false }).list(ctx, { counts: true });
    const counted = rows.reduce((n, m) => n + (m.messageCount ?? 0), 0);
    expect(rows.map((m) => typeof m.messageCount)).toEqual(["number", "number"]);
    expect(counted, "Settings counted a message History says the account does not own").toBe(t.total);
    expect(counted).toBe(129);
  });

  it("refuses a malformed position rather than answering the wrong page", async () => {
    await expect(svc.list(ctx, { view: "all", at: { date: null, id: "nope" } })).rejects.toThrow(/atId/);
    await expect(svc.list(ctx, { view: "all", before: { date: "2024-02-30", id: oldestId } })).rejects.toThrow(/beforeDate/);
  });

  it("a page never exceeds the History ceiling, whatever the caller asks", async () => {
    const page = await svc.list(ctx, { view: "all", limit: 500 });
    expect(page.items.length).toBe(50);
  });
});
