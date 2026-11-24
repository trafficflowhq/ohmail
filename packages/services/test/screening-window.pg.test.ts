import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { accounts, accountSettings, folderState, mailboxProfileMirror, mailboxes, messages } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { brandDialect } from "@trafficflow/db/dialect";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { ScreenerService, cutlineCounts, effectiveScreeningWindows, type ServiceContext } from "../src/index.js";

/**
 * THE PER-MAILBOX CUTLINE ON REAL POSTGRES (RULING-026): the queue's page, its total and the
 * count, with one window per mailbox — the CASE arm under a `having`, composed into the page's
 * `DISTINCT ON` beside its keyset. PGlite and the device store run the same cases in
 * `screener-reader-queue-is-the-gate.test.ts`. INSERT-only under a fresh account, so nothing here
 * is visible to another file on this database.
 */
const PG_UP = await realPgAvailable();
let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

const NOW = new Date("2026-10-12T01:00:00.000Z");
const daysAgo = (d: number): Date => new Date(NOW.getTime() - d * 86_400_000);
const GATE = "ohmail/Screener";
const WINDOW_30 = { baselineAt: daysAgo(1).toISOString(), dormancyDays: 30, scope: "window" };

async function world(published: Array<"own" | object | "no-key">) {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `swp-${accountId.slice(0, 8)}` });
  await db.insert(accountSettings).values({ accountId, screeningBaselineAt: daysAgo(1), dormancyDays: 365 });
  const ids: string[] = [];
  for (const [i, p] of published.entries()) {
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `swp${i}-${accountId.slice(0, 8)}@example.test`,
      organizerRole: p === "own" ? "organizer" : "reader",
    }).returning();
    ids.push(mb!.id);
    if (p !== "own") {
      await db.insert(mailboxProfileMirror).values({
        mailboxId: mb!.id, accountId, uidvalidity: 7n, uid: 1, readAt: NOW,
        doc: { v: 2, updatedAt: NOW.toISOString(), producer: { kind: "local", version: "t" }, ...(p === "no-key" ? {} : { screening: p }) },
      });
    }
  }
  let n = 0;
  const hold = async (mailbox: number, from: string, at: Date, unread: boolean): Promise<void> => {
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: ids[mailbox]!, bodyHash: `h${n}`, dedupKey: `swp:${randomUUID()}`,
      subject: `Note ${n++}`, snippet: "", fromAddress: from, date: at, arrivedAt: at, createdAt: at, unread,
      nativeLocator: { folder: GATE, ref: `1:${n}` },
    }).returning();
    await db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: GATE, observedFolder: GATE, lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
  };
  const ctx: ServiceContext = { db: db as never, accountId, userId: null, now: () => NOW, requestId: `swp-${accountId.slice(0, 8)}` };
  return { ctx, hold };
}

async function read(ctx: ServiceContext) {
  const page = await new ScreenerService({}).list(ctx, { limit: 50 });
  const counts = await cutlineCounts(ctx, { windows: await effectiveScreeningWindows(ctx) });
  return { senders: page.items.map((i) => i.sender.address).sort(), total: page.total, counted: counts.activeUndecidedSenders };
}

describe.skipIf(!PG_UP)("one window per mailbox, on Postgres", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(client, { schema }), "pg");
  }, 120_000);
  afterAll(async () => { await client?.end({ timeout: 5 }); });

  it("the organizer's 30 days retire what this install's own 365 would keep", async () => {
    const w = await world([WINDOW_30]);
    await w.hold(0, "fresh@s.test", daysAgo(2), true);
    await w.hold(0, "old@s.test", daysAgo(150), false);
    expect(await read(w.ctx)).toEqual({ senders: ["fresh@s.test"], total: 1, counted: 1 });
  });

  it("unstated lists the folder whole", async () => {
    const w = await world(["no-key"]);
    await w.hold(0, "fresh@s.test", daysAgo(2), true);
    await w.hold(0, "old@s.test", daysAgo(500), false);
    expect(await read(w.ctx)).toEqual({ senders: ["fresh@s.test", "old@s.test"], total: 2, counted: 2 });
  });

  it("mixed role: active in either mailbox lists the sender once; old in both lists nobody", async () => {
    const w = await world(["own", WINDOW_30]);
    await w.hold(0, "both@s.test", daysAgo(400), false);
    await w.hold(1, "both@s.test", daysAgo(3), false);
    await w.hold(0, "gone@s.test", daysAgo(400), false);
    await w.hold(1, "gone@s.test", daysAgo(150), false);
    expect(await read(w.ctx)).toEqual({ senders: ["both@s.test"], total: 1, counted: 1 });
  });
});
