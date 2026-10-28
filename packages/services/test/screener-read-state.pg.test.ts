import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, eq, inArray } from "drizzle-orm";
import { accounts, mailboxes, messages, folderState, flagState, changeLog } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { ScreenerService, type ServiceContext } from "@trafficflow/services";

/**
 * A SCREEN-OUT, A SPAM PRESS OR AN ADMISSION FILES THE HELD MAIL AND MARKS NONE OF IT READ, AGAINST
 * REAL POSTGRES. A letter is read when the person read it: the decision writes no `flag_state`
 * intent, leaves `messages.unread` as it was and appends no `update` delta beside its moves, so
 * the worker never adds `\Seen` for it. NO IMAP: the service runs with no adapter, as the API does.
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

const ctx = (accountId: string): ServiceContext => ({
  db: db as unknown as ServiceContext["db"],
  accountId,
  userId: null,
  now: () => new Date(),
  requestId: `f2-${randomUUID().slice(0, 8)}`,
});

interface World { accountId: string; held: string[]; address: string; }

/** One waiting first-contact sender with `each` UNREAD held messages (unread defaults true). */
async function newWorld(each = 3): Promise<World> {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `f2-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `f2-${accountId.slice(0, 8)}@example.test`,
  }).returning();
  const address = `post@ledgerandloom.test`;
  const held: string[] = [];
  for (let i = 0; i < each; i += 1) {
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: `h${i}`, dedupKey: `f2:${randomUUID()}`,
      subject: `Bulletin ${i}`, fromAddress: address,
      nativeLocator: { folder: "ohmail/Screener", ref: `1:${i}` },
    }).returning();
    // No flag_state row: held mail has none at ingest, so any row after the decision is its write.
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: "ohmail/Screener", observedFolder: "ohmail/Screener",
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    held.push(m!.id);
  }
  return { accountId, held, address };
}

const flagsOf = (ids: string[]) => db.select({
  id: flagState.messageId, desiredSeen: flagState.desiredSeen,
  observedSeen: flagState.observedSeen, status: flagState.reconcileStatus, lastSetBy: flagState.lastSetBy,
}).from(flagState).where(inArray(flagState.messageId, ids));

const unreadOf = (ids: string[]) => db.select({ id: messages.id, unread: messages.unread })
  .from(messages).where(inArray(messages.id, ids));

describe.skipIf(!PG_UP)("a Screener decision files the held mail and leaves its read state alone", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(client, { schema }), "pg");
  }, 120_000);
  afterAll(async () => { await client?.end({ timeout: 5 }); });

  const decisions = [
    { dest: "ohmail/Screened", decision: "no" }, { dest: "ohmail/Quarantine", decision: "no" },
    { dest: "INBOX", decision: "yes" }, { dest: "ohmail/News", decision: "yes" }, { dest: "ohmail/Receipts", decision: "yes" },
  ] as const;
  for (const { dest, decision } of decisions) {
    it(`a ${decision} to ${dest} files the mail and marks none of it read`, async () => {
      const w = await newWorld(3);
      await new ScreenerService({}).decide(ctx(w.accountId), w.held[0]!, { decision, dest });

      const filed = await db.select({ d: folderState.desiredFolder }).from(folderState)
        .where(inArray(folderState.messageId, w.held));
      expect(filed.map((r) => r.d)).toEqual([dest, dest, dest]);
      expect(await flagsOf(w.held), "the decision wrote a read intent").toHaveLength(0);
      expect((await unreadOf(w.held)).every((r) => r.unread === true), "the decision marked mail read").toBe(true);
      const updates = await db.select().from(changeLog).where(and(
        eq(changeLog.accountId, w.accountId), eq(changeLog.entityType, "message"), eq(changeLog.op, "update"),
      ));
      expect(updates).toHaveLength(0);
    });
  }
});
