import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { brandDialect } from "@trafficflow/db/dialect";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { accounts, folderState, mailboxes, messages, type Tx } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { senderCheckReentered, senderCheckRetirement } from "../src/sender-check-backfill.js";

/**
 * THE RE-ARM READ ON REAL POSTGRES: the `updated_at` bound arrives through postgres-js's own
 * parameter serialization (PGlite's differs), and the statement is the one the worker sends. Every
 * read is scoped to this file's own accounts; no row is stamped in the future.
 */
const AVAILABLE = await realPgAvailable();

describe.skipIf(!AVAILABLE)("the identity backfill's re-arm read (Postgres)", () => {
  let db: Tx;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    sql = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg") as unknown as Tx;
  }, 120_000);

  afterAll(async () => { await sql.end({ timeout: 5 }); });

  async function account() {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `scrpg-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `scrpg-${accountId.slice(0, 8)}@example.test`,
    }).returning();
    return { accountId, mailboxId: mb!.id };
  }
  async function row(w: { accountId: string; mailboxId: string }, folder: string) {
    const dedup = `scrpg:${randomUUID()}`;
    const [m] = await db.insert(messages).values({
      accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: "h", dedupKey: dedup,
      subject: "Konto gesperrt", fromAddress: "x@gmail.invalid", fromName: "PostFinance",
      nativeLocator: { folder, ref: `1:${randomUUID()}` },
    }).returning();
    await db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: folder, observedFolder: folder, lastSetBy: "us", reconcileStatus: "reconciled",
    });
    return m!.id;
  }

  it("reads only the window, only the named accounts, only unchecked rows in the scope", async () => {
    const a = await account();
    const b = await account();
    const before = new Date(Date.now() - 60_000);
    await row(a, "INBOX");
    await row(b, "Archive");
    expect(await senderCheckReentered(db, [a.accountId, b.accountId], before)).toEqual(new Set([a.accountId]));
    expect(await senderCheckReentered(db, [b.accountId], before), "another account's row is not B's").toEqual(new Set());
    const later = new Date(Date.now() + 1_000);
    expect(await senderCheckReentered(db, [a.accountId], later), "a row written before the window is out").toEqual(new Set());
  });

  it("retires, then re-arms on an archived row moved into the Screener, and the walk checks it", async () => {
    const a = await account();
    const archived = await row(a, "Archive");
    const tail = senderCheckRetirement();
    const walk = async () => {
      const list = await tail.enter(db, [a.accountId]);
      for (const id of list) await tail.run(db, id);
      return list;
    };
    expect(await walk()).toEqual([a.accountId]);
    expect(await walk()).toEqual([]);
    await db.update(folderState).set({ desiredFolder: "ohmail/Screener", updatedAt: new Date() })
      .where(eq(folderState.messageId, archived));
    expect(await walk()).toEqual([a.accountId]);
    const [r] = await db.select({ c: messages.senderCheck }).from(messages).where(eq(messages.id, archived));
    expect(r!.c).toBe("impersonation");
    expect(await walk()).toEqual([]);
  });
});
