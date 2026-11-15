import { accountOfMessage } from "@trafficflow/db";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq, sql } from "drizzle-orm";
import {
  accounts, accountSettings, accountSyncState, changeLog, contacts, mailboxes,
  messageBodies, messages, rules,
} from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { buildSeedReview, confirmSeed } from "../src/consent-seed.js";
import type { ServiceContext } from "../src/context.js";

/**
 * THE SENT-MAIL SEED AT THE SIZE REAL MAILBOXES ARE, AND THE FAILURE THAT WAS NOT ABOUT SIZE.
 *
 * A mailbox that has been used for years has hundreds of correspondents, not the two a fixture
 * has. Three separate things break at that size, and each one is a claim here:
 *
 *   · THE COUNTER. `change_log`'s primary key is `(account_id, seq)`, so an `account_sync_state`
 *     counter sitting BELOW the log's own maximum hands out a seq that is already taken and the
 *     insert raises a unique violation. It does not degrade — every mutation on the account
 *     fails, for ever, because the only thing that moves the counter is the statement that is
 *     failing. This is the state a live account was actually found in, and the first test below
 *     is that state reproduced exactly: the counter five behind its log, which is what a
 *     database copy taken table-by-table while the account was in use leaves behind.
 *
 *   · THE ROUND TRIPS. A confirmation used to spend five statements per correspondent. At a
 *     few thousand people that is five times as many round trips inside one transaction, which no request
 *     deadline survives — and it holds the account's counter row locked against every other
 *     writer for the whole of it.
 *
 *   · RUNNING IT TWICE. Connecting a second mailbox brings a second address book. The review
 *     has to be answerable again, and answering it again must not write a second rule for
 *     anybody who already has one.
 *
 * The sizes are literal on purpose: one is a realistic account, the other
 * the order of magnitude a large one reaches.
 */

const AVAILABLE = await realPgAvailable();
const client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
const db = brandDialect(drizzle(client, { schema }), "pg");

const NOW = new Date("2026-08-05T09:00:00.000Z");

interface World {
  accountId: string;
  own: string;
  ctx: ServiceContext;
}

/**
 * An account whose sent mail names `count` distinct correspondents, one message each.
 *
 * Written with batched inserts because the point of the test is what CONFIRMING costs; a setup
 * that took a round trip per row would make the whole file a latency measurement.
 */
async function world(count: number): Promise<World> {
  const accountId = randomUUID();
  const own = `own-${accountId.slice(0, 8)}@example.com`;
  await db.insert(accounts).values({ id: accountId, name: `scale-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: own,
  }).returning({ id: mailboxes.id });

  for (let from = 0; from < count; from += 500) {
    const part = Array.from({ length: Math.min(500, count - from) }, (_x, i) => from + i);
    const rows = await db.insert(messages).values(part.map((n) => ({
      accountId,
      mailboxId: mb!.id,
      bodyHash: randomUUID(),
      dedupKey: randomUUID(),
      fromAddress: own,
      subject: `note ${n}`,
      date: new Date(NOW.getTime() - n * 1000),
      nativeLocator: { folder: "Sent", uid: n },
      snippet: "",
    }))).returning({ id: messages.id });
    await db.insert(messageBodies).values(rows.map((r, i) => ({
      messageId: r.id, accountId: accountOfMessage(r.id),
      headers: { to: [`"Person ${part[i]}" <person${part[i]}@example.com>`] },
    })));
  }

  return {
    accountId, own,
    ctx: { db, accountId, userId: null, now: () => NOW, requestId: "seed-scale" },
  };
}

const seqsFor = async (accountId: string): Promise<bigint[]> => {
  const rows = await db.select({ seq: changeLog.seq }).from(changeLog)
    .where(eq(changeLog.accountId, accountId));
  return rows.map((r) => r.seq).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
};

describe.skipIf(!AVAILABLE)("the sent-mail seed confirms at the size real mailboxes are", () => {
  beforeAll(async () => { await runMigrations(PG_TEST_URL); });
  afterAll(async () => { await client.end(); });

  it("confirms 191 people even when the account's seq counter has fallen behind its own log", async () => {
    const w = await world(191);
    const review = await buildSeedReview(w.ctx);
    expect(review.candidates).toHaveLength(191);

    // THE PRODUCTION STATE, REPRODUCED. Five change-log rows exist beyond what the counter
    // knows about — precisely what a table-by-table copy of a live database produces — so a
    // naive allocator's very first hand-out collides with `change_log`'s primary key.
    await db.insert(accountSyncState).values({ accountId: w.accountId, nextSeq: 0n })
      .onConflictDoNothing();
    await db.insert(changeLog).values([1, 2, 3, 4, 5].map((n) => ({
      accountId: w.accountId, seq: BigInt(n), entityType: "rule" as const,
      entityId: randomUUID(), op: "create" as const, meta: null,
    })));
    const before = await db.select({ next: accountSyncState.nextSeq }).from(accountSyncState)
      .where(eq(accountSyncState.accountId, w.accountId));
    expect(before[0]!.next).toBe(0n);        // behind the log's max of 5 — the broken state

    const result = await confirmSeed(w.ctx, review.candidates.map((c) => c.address));

    expect(result.rulesCreated).toBe(191);
    expect(result.declined).toBe(0);
    expect(await db.select({ n: sql<number>`count(*)::int` }).from(rules)
      .where(eq(rules.accountId, w.accountId))).toEqual([{ n: 191 }]);

    // Every seq is distinct and every one of them is above the five that were already there:
    // the counter was reconciled forward rather than re-issuing.
    const seqs = await seqsFor(w.accountId);
    expect(new Set(seqs.map(String)).size).toBe(seqs.length);
    expect(seqs.filter((s) => s > 5n)).toHaveLength(191);
  }, 60_000);

  it("confirms 2 000 people in one transaction", async () => {
    const w = await world(2000);
    const review = await buildSeedReview(w.ctx);
    expect(review.candidates).toHaveLength(2000);

    const result = await confirmSeed(w.ctx, review.candidates.map((c) => c.address));

    expect(result.rulesCreated).toBe(2000);
    expect(await db.select({ n: sql<number>`count(*)::int` }).from(rules)
      .where(eq(rules.accountId, w.accountId))).toEqual([{ n: 2000 }]);
    // One contact per person, plus the account's own address.
    expect(result.contactsCreated).toBe(2001);
    // Gap-free and strictly monotonic across the whole block, exactly as one-at-a-time
    // allocation gave: the batched allocator reserves a contiguous range, it does not skip.
    const seqs = await seqsFor(w.accountId);
    expect(seqs).toHaveLength(2000);
    expect(seqs[seqs.length - 1]! - seqs[0]!).toBe(1999n);
  }, 120_000);

  it("can be run again after a confirmation, and writes only who is new", async () => {
    const w = await world(3);
    const first = await buildSeedReview(w.ctx);
    expect(await confirmSeed(w.ctx, first.candidates.map((c) => c.address))).toMatchObject({
      rulesCreated: 3, skipped: 0,
    });

    // A second mailbox brings a fourth correspondent. The stamp is set, and that must not be
    // a wall: `seed_confirmed_at` records WHEN the review was last answered, not that it may
    // never be answered again.
    const stamped = await db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, w.accountId));
    expect(stamped[0]!.seedConfirmedAt).not.toBeNull();

    const [mb] = await db.select({ id: mailboxes.id }).from(mailboxes)
      .where(eq(mailboxes.accountId, w.accountId));
    const [m] = await db.insert(messages).values({
      accountId: w.accountId, mailboxId: mb!.id,
      bodyHash: randomUUID(), dedupKey: randomUUID(),
      fromAddress: w.own, subject: "a later note", date: NOW,
      nativeLocator: { folder: "Sent", uid: 9999 }, snippet: "",
    }).returning({ id: messages.id });
    await db.insert(messageBodies).values({
      messageId: m!.id, accountId: accountOfMessage(m!.id), headers: { to: ["newcomer@example.com"] },
    });

    const second = await buildSeedReview(w.ctx);
    expect(second.candidates.filter((c) => c.alreadyDecided)).toHaveLength(3);
    const again = await confirmSeed(w.ctx, second.candidates.map((c) => c.address));

    expect(again.rulesCreated).toBe(1);
    expect(again.skipped).toBe(3);
    // FOUR rules, not seven. Re-running the review is not a way to acquire a second rule for
    // everybody who already had one.
    expect(await db.select({ n: sql<number>`count(*)::int` }).from(rules)
      .where(eq(rules.accountId, w.accountId))).toEqual([{ n: 4 }]);
    expect(await db.select({ n: sql<number>`count(*)::int` }).from(contacts)
      .where(eq(contacts.accountId, w.accountId))).toEqual([{ n: 5 }]);
  }, 60_000);

  it("two simultaneous confirmations write one rule per person, not two", async () => {
    const w = await world(40);
    const review = await buildSeedReview(w.ctx);
    const addresses = review.candidates.map((c) => c.address);

    // Both computed their review before either committed, which is what a double-click is.
    const [a, b] = await Promise.all([
      confirmSeed(w.ctx, addresses),
      confirmSeed(w.ctx, addresses),
    ]);

    expect(a.rulesCreated + b.rulesCreated).toBe(40);
    expect(a.skipped + b.skipped).toBe(40);
    expect(await db.select({ n: sql<number>`count(*)::int` }).from(rules)
      .where(eq(rules.accountId, w.accountId))).toEqual([{ n: 40 }]);
    const seqs = await seqsFor(w.accountId);
    expect(new Set(seqs.map(String)).size).toBe(seqs.length);
  }, 60_000);
});
