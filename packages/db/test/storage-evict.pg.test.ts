import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, inArray, asc } from "drizzle-orm";
import { runMigrations } from "../src/admin.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";
import { brandDialect, dialect } from "../src/dialect/index.js";
import { accounts, accountStorage, mailboxes, messages, messageBodies } from "../src/schema-mail.js";
import {
  bodyBytesOf, evictOldestBodies, reserveBodyBytes, reserveBodyBytesEvicting,
  storageUsageOf, EVICT_INLINE_MAX_BODIES,
} from "../src/storage.js";
import type { Tx } from "../src/change-log.js";

/**
 * THE ROLLING WINDOW, ON REAL POSTGRES — eviction is transactional code (a counter-row lock, a
 * multi-row husk, a clamped decrement, racing the reserve), so PGlite green would mean nothing
 * here (three production bugs were invisible to it).
 *
 * Mutations watched red while writing this file, each restored:
 *  · dropping the `order by coalesce(m.date, m.created_at)` → "oldest by DATE, not by insertion
 *    order" fails (the seed inserts newest-first on purpose);
 *  · dropping the `releaseBodyBytes` decrement → the counter assertions fail;
 *  · dropping BOTH victim predicates (`withheld_reason is null` and the content arm) → the
 *    husk-idempotence and bounded-batch cases fail. Each arm alone survived its mutation —
 *    they are individually redundant for today's husks (a husk has no content AND carries the
 *    marker) — so the PAIR is what this suite guards: either one must stand, and the marker
 *    arm is the one that keeps a future content-bearing withheld variant out of the victims.
 */
const PG_UP = await realPgAvailable();
const client = postgres(PG_TEST_URL, { max: 6, onnotice: () => {} });
// BRANDED, like every production factory: a handle with no dialect brand refuses at the first
// statement the seam composes, which for this file is the counter row's lock.
const db = brandDialect(drizzle(client), "pg");

const created: string[] = [];

beforeAll(async () => { if (PG_UP) await runMigrations(PG_TEST_URL); }, 120_000);
afterAll(async () => {
  if (PG_UP && created.length > 0) {
    const msgs = db.select({ id: messages.id }).from(messages).where(inArray(messages.accountId, created));
    await db.delete(messageBodies).where(inArray(messageBodies.messageId, msgs));
    await db.delete(messages).where(inArray(messages.accountId, created));
    await db.delete(mailboxes).where(inArray(mailboxes.accountId, created));
    await db.delete(accountStorage).where(inArray(accountStorage.accountId, created));
    await db.delete(accounts).where(inArray(accounts.id, created));
  }
  await client.end({ timeout: 5 });
});

/** An account with one mailbox and `n` stored bodies of `size` bytes each, dates DESCENDING in
 *  insertion order (newest row inserted first) so date-order and physical order disagree. */
async function seed(
  n: number, size: number, dateOf: (i: number) => Date = (i) => new Date(Date.UTC(2026, 0, n - i)),
): Promise<{ accountId: string; ids: string[] }> {
  const accountId = randomUUID();
  created.push(accountId);
  await db.insert(accounts).values({ id: accountId, name: `ev-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `${accountId.slice(0, 8)}@x.test`,
  }).returning();
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    // i = 0 is the NEWEST message and is inserted FIRST.
    const date = dateOf(i);
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id,
      bodyHash: `h${i}`, dedupKey: `${accountId}:${i}`, subject: `m${i}`, date,
    }).returning();
    ids.push(m!.id);
    const body = { text: "x".repeat(size), html: null };
    await db.transaction(async (tx) => {
      await reserveBodyBytes(tx as unknown as Tx, dialect(db), accountId, bodyBytesOf(body), null);
      await tx.insert(messageBodies).values({
        messageId: m!.id, text: body.text, html: body.html, headers: { "x-seed": ["1"] },
      });
    });
  }
  return { accountId, ids };
}

describe.skipIf(!PG_UP)("evictOldestBodies — the rolling window's trim", () => {
  it("husks the OLDEST by message date (not insertion order), decrements exactly, keeps headers", async () => {
    const { accountId, ids } = await seed(6, 1_000);           // ids[0] newest … ids[5] oldest
    expect(await storageUsageOf(db as unknown as Tx, accountId)).toBe(6_000);

    const r = await db.transaction(async (tx) =>
      evictOldestBodies(tx as unknown as Tx, dialect(db), accountId, { targetBytes: 4_000, maxBodies: 100 }));
    expect(r.evicted).toBe(2);
    expect(r.freedBytes).toBe(2_000);
    expect(r.bytesAfter).toBe(4_000);
    expect(r.more).toBe(false);
    expect(await storageUsageOf(db as unknown as Tx, accountId)).toBe(4_000);

    const rows = await db
      .select({ messageId: messageBodies.messageId, text: messageBodies.text, withheldReason: messageBodies.withheldReason, headers: messageBodies.headers })
      .from(messageBodies).where(inArray(messageBodies.messageId, ids));
    const byMsg = new Map(rows.map((r2) => [r2.messageId, r2]));
    // The two OLDEST (ids[5], ids[4]) are husks; the newest four untouched.
    for (const oldId of [ids[5]!, ids[4]!]) {
      const husk = byMsg.get(oldId)!;
      expect(husk.withheldReason, "oldest by DATE, not by insertion order").toBe("storage_cap");
      expect(husk.text).toBe("");
      expect(husk.headers, "husks keep their headers — the organizing passes read them").toEqual({ "x-seed": ["1"] });
    }
    for (const newId of ids.slice(0, 4)) {
      expect(byMsg.get(newId)!.withheldReason).toBeNull();
      expect(byMsg.get(newId)!.text).toHaveLength(1_000);
    }
  });

  it("never re-processes a husk, and an under-target account is a no-op", async () => {
    const { accountId } = await seed(3, 1_000);
    await db.transaction(async (tx) =>
      evictOldestBodies(tx as unknown as Tx, dialect(db), accountId, { targetBytes: 2_000, maxBodies: 100 }));
    // Run again with the SAME target: already at it — zero work, zero counter movement.
    const again = await db.transaction(async (tx) =>
      evictOldestBodies(tx as unknown as Tx, dialect(db), accountId, { targetBytes: 2_000, maxBodies: 100 }));
    expect(again).toMatchObject({ evicted: 0, freedBytes: 0, more: false });
    // And with a LOWER target: only the remaining stored bodies are candidates — the husk from
    // round one is skipped by the `withheld_reason is null` predicate, not husked twice.
    const lower = await db.transaction(async (tx) =>
      evictOldestBodies(tx as unknown as Tx, dialect(db), accountId, { targetBytes: 0, maxBodies: 100 }));
    expect(lower.evicted).toBe(2);
    expect(await storageUsageOf(db as unknown as Tx, accountId)).toBe(0);
  });

  it("keeps the facts across successive trims: how many, first and latest, and the month text is kept from", async () => {
    // Six letters of 1,000 bytes, one a month from January to June, inserted newest first.
    const { accountId } = await seed(6, 1_000, (i) => new Date(Date.UTC(2026, 5 - i, 15)));
    const facts = async () => {
      const [r] = await db.select({
        n: accountStorage.huskedForSpace, first: accountStorage.firstHuskedAt,
        last: accountStorage.lastHuskedAt, keptFrom: accountStorage.keptFrom,
      }).from(accountStorage).where(eq(accountStorage.accountId, accountId));
      return r!;
    };
    const trim = (targetBytes: number, maxBodies = 100) => db.transaction(async (tx) =>
      evictOldestBodies(tx as unknown as Tx, dialect(db), accountId, { targetBytes, maxBodies }));
    expect(await facts()).toEqual({ n: 0, first: null, last: null, keptFrom: null });

    // A full page of two: the letter after it, read in the same statement, is where text is kept from.
    expect((await trim(0, 2)).evicted).toBe(2);
    const one = await facts();
    expect(one).toMatchObject({ n: 2, keptFrom: "2026-03-01" });
    expect(one.first).toBeInstanceOf(Date);
    expect(one.last!.getTime()).toBe(one.first!.getTime());

    // Already under the target: nothing emptied, nothing recorded.
    expect((await trim(4_000)).evicted).toBe(0);
    expect(await facts()).toEqual(one);

    // Both times set back a week, so "kept" and "moved" are comparisons, not the same instant twice.
    const WEEK_AGO = new Date(one.first!.getTime() - 7 * 86_400_000);
    await db.update(accountStorage).set({ firstHuskedAt: WEEK_AGO, lastHuskedAt: WEEK_AGO })
      .where(eq(accountStorage.accountId, accountId));
    expect((await trim(2_000)).evicted).toBe(2);
    const two = await facts();
    expect(two).toMatchObject({ n: 4, keptFrom: "2026-05-01" });
    expect(two.first!.getTime(), "the first trim's time was overwritten").toBe(WEEK_AGO.getTime());
    expect(two.last!.getTime()).toBeGreaterThan(WEEK_AGO.getTime());

    // Every letter emptied: text is kept only from the month after the newest.
    expect((await trim(0)).evicted).toBe(2);
    expect(await facts()).toMatchObject({ n: 6, keptFrom: "2026-07-01" });
    expect(await storageUsageOf(db as unknown as Tx, accountId)).toBe(0);
  });

  it("a count the release filled keeps the first time unrecorded; the next trim sets only the latest", async () => {
    const { accountId } = await seed(4, 1_000);
    // 0166 counts the letters emptied before it and leaves both times NULL.
    await db.update(accountStorage).set({ huskedForSpace: 3 }).where(eq(accountStorage.accountId, accountId));
    await db.transaction(async (tx) =>
      evictOldestBodies(tx as unknown as Tx, dialect(db), accountId, { targetBytes: 3_000, maxBodies: 100 }));
    const [r] = await db.select({ n: accountStorage.huskedForSpace, first: accountStorage.firstHuskedAt, last: accountStorage.lastHuskedAt })
      .from(accountStorage).where(eq(accountStorage.accountId, accountId));
    expect(r!.n).toBe(4);
    expect(r!.first, "the first time was made up from a later trim").toBeNull();
    expect(r!.last).toBeInstanceOf(Date);
  });

  it("kept_from is the month after the newest letter emptied, never the month of one", async () => {
    // Weekly letters in April 2025; the trim empties the 2nd and the 9th.
    const { accountId } = await seed(4, 1_000, (i) => new Date(Date.UTC(2025, 3, 23 - 7 * i)));
    expect((await db.transaction(async (tx) =>
      evictOldestBodies(tx as unknown as Tx, dialect(db), accountId, { targetBytes: 2_000, maxBodies: 100 }))).evicted).toBe(2);
    const [r] = await db.select({ keptFrom: accountStorage.keptFrom }).from(accountStorage)
      .where(eq(accountStorage.accountId, accountId));
    expect(r!.keptFrom, "April was named as kept with two of its letters emptied").toBe("2025-05-01");
  });

  it("a full victim page above target reports more:true — the bounded batch resumes", async () => {
    const { accountId } = await seed(5, 1_000);
    const r = await db.transaction(async (tx) =>
      evictOldestBodies(tx as unknown as Tx, dialect(db), accountId, { targetBytes: 1_000, maxBodies: 2 }));
    expect(r.evicted).toBe(2);
    expect(r.more).toBe(true);
    const r2 = await db.transaction(async (tx) =>
      evictOldestBodies(tx as unknown as Tx, dialect(db), accountId, { targetBytes: 1_000, maxBodies: 2 }));
    expect(r2.evicted).toBe(2);
    expect(await storageUsageOf(db as unknown as Tx, accountId)).toBe(1_000);
    expect(r2.more).toBe(false);
  });
});

describe.skipIf(!PG_UP)("reserveBodyBytesEvicting — new mail lands at cap", () => {
  it("at cap, the oldest husk and the new body stores — the ruling's whole content", async () => {
    const { accountId, ids } = await seed(4, 1_000);           // stored up to the cap
    const cap = 4_000;                                          // exactly at cap
    const ok = await db.transaction(async (tx) =>
      reserveBodyBytesEvicting(tx as unknown as Tx, dialect(db), accountId, 1_000, cap));
    expect(ok, "the new body must fit — old mail gives way, new mail never bounces").toBe(true);
    // The oldest body is now a husk; the counter holds the new body's reservation.
    const oldest = await db.select({ withheldReason: messageBodies.withheldReason })
      .from(messageBodies).where(eq(messageBodies.messageId, ids[3]!));
    expect(oldest[0]!.withheldReason).toBe("storage_cap");
    expect(await storageUsageOf(db as unknown as Tx, accountId)).toBe(4_000);
  });

  it("with nothing left to evict it declines — the pathological ceiling keeps the old shape", async () => {
    const { accountId } = await seed(2, 1_000);
    // Husk everything first, then push the counter to the cap with an unevictable reservation.
    await db.transaction(async (tx) =>
      evictOldestBodies(tx as unknown as Tx, dialect(db), accountId, { targetBytes: 0, maxBodies: 100 }));
    await db.transaction(async (tx) =>
      reserveBodyBytes(tx as unknown as Tx, dialect(db), accountId, 4_000, null));
    const ok = await db.transaction(async (tx) =>
      reserveBodyBytesEvicting(tx as unknown as Tx, dialect(db), accountId, 1_000, 4_000));
    expect(ok).toBe(false);
  });

  it("CONCURRENCY: a trim and a reserve race; the counter still equals the stored octets", async () => {
    const { accountId } = await seed(EVICT_INLINE_MAX_BODIES, 1_000);
    const cap = EVICT_INLINE_MAX_BODIES * 1_000;                // exactly at cap
    // One transaction trims toward a low target while another reserves a new body at cap.
    // Whatever the interleaving, the invariant is that the counter and the table agree after
    // both commit — the property every layer of this module promises.
    const [, reserved] = await Promise.all([
      db.transaction(async (tx) =>
        evictOldestBodies(tx as unknown as Tx, dialect(db), accountId, { targetBytes: cap - 5_000, maxBodies: 10 })),
      db.transaction(async (tx) =>
        reserveBodyBytesEvicting(tx as unknown as Tx, dialect(db), accountId, 1_000, cap)),
    ]);
    expect(reserved).toBe(true);
    const counted = await storageUsageOf(db as unknown as Tx, accountId);
    const stored = await db
      .select({ id: messageBodies.id, text: messageBodies.text, html: messageBodies.html })
      .from(messageBodies)
      .innerJoin(messages, eq(messages.id, messageBodies.messageId))
      .where(eq(messages.accountId, accountId))
      .orderBy(asc(messageBodies.id));
    const octets = stored.reduce((n, b) => n + bodyBytesOf({ text: b.text, html: b.html }), 0);
    // The reserve above accounted a body's worth for a body this test never inserts, so the counter is
    // the stored octets PLUS that one reservation — exact, not approximate.
    expect(counted).toBe(octets + 1_000);
  });
});
