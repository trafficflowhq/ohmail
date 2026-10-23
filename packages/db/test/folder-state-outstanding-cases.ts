import { expect } from "vitest";
import { and, count, eq, isNull, ne, or, sql } from "drizzle-orm";
import { accounts, folderState, mailboxes, messages, ourOutstandingFiling } from "../src/index.js";
import type { makeTestDb } from "../src/testing.js";

/**
 * MAIL 0160's COLUMN OVER EVERY WRITE SHAPE: `folder_state.outstanding_account_id` is the message's
 * account on every outstanding filing, whatever the writer. The cases run on the store the caller
 * hands in (PGlite and SQLite in `folder-state-outstanding-account.test.ts`, real Postgres in its
 * `.pg` twin); after each, no outstanding row carries another value.
 */

type Db = Awaited<ReturnType<typeof makeTestDb>>;

const id = (tail: string): string => `00000000-0000-4000-8000-${tail.padStart(12, "0")}`;
export const A = id("ac1"), B = id("ac2");
const MA = id("bb1"), MB = id("bb2");
const STAMP = new Date("2026-10-21T08:00:00.000Z");

/** Outstanding filings whose column is not their message's account. */
export async function drift(db: Db): Promise<number> {
  const [r] = await db.select({ n: count() }).from(folderState)
    .innerJoin(messages, eq(messages.id, folderState.messageId))
    .where(and(ourOutstandingFiling(), or(
      isNull(folderState.outstandingAccountId), ne(folderState.outstandingAccountId, messages.accountId))));
  return Number(r!.n);
}

async function stamp(db: Db, messageId: string): Promise<{ account: string | null; updatedAt: number }> {
  const [r] = await db.select({ a: folderState.outstandingAccountId, u: folderState.updatedAt })
    .from(folderState).where(eq(folderState.messageId, messageId));
  return { account: r!.a ?? null, updatedAt: r!.u.getTime() };
}

/** Run every write shape on `db` (with suffix `tag` on the seeded keys); returns how many filings are outstanding. */
export async function runWriteShapes(db: Db, tag: string): Promise<number> {
  await db.insert(accounts).values([{ id: A, name: `fso-a-${tag}` }, { id: B, name: `fso-b-${tag}` }]);
  await db.insert(mailboxes).values([
    { id: MA, accountId: A, provider: "imap", address: `a-${tag}@example.test` },
    { id: MB, accountId: B, provider: "imap", address: `b-${tag}@example.test` },
  ]);
  let n = 0;
  const msg = async (account = A, mailbox = MA): Promise<string> => {
    n += 1;
    return (await db.insert(messages).values({
      accountId: account, mailboxId: mailbox, dedupKey: `mid:<fso-${tag}-${n}@example.test>`, bodyHash: `fso-${n}`,
    }).returning())[0]!.id;
  };
  const filed = { desiredFolder: "ohmail/News", observedFolder: "INBOX", lastSetBy: "us", updatedAt: STAMP } as const;

  // 1. An outstanding insert.
  const m1 = await msg();
  await db.insert(folderState).values({ messageId: m1, ...filed });
  expect((await stamp(db, m1)).account).toBe(A);
  expect(await drift(db)).toBe(0);

  // 2. A reconciled insert stays empty; the ON CONFLICT DO UPDATE that files it fills it.
  const m2 = await msg();
  await db.insert(folderState).values({ messageId: m2, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us", reconcileStatus: "reconciled" });
  expect((await stamp(db, m2)).account).toBe(null);
  await db.insert(folderState).values({ messageId: m2, ...filed, desiredFolder: "Archive" })
    .onConflictDoUpdate({ target: folderState.messageId, set: { desiredFolder: "Archive", reconcileStatus: "pending", updatedAt: STAMP } });
  expect((await stamp(db, m2)).account).toBe(A);
  expect(await drift(db)).toBe(0);

  // 3. An observation that makes a settled row outstanding.
  const m3 = await msg();
  await db.insert(folderState).values({ messageId: m3, desiredFolder: "Archive", observedFolder: "Archive", lastSetBy: "us" });
  expect((await stamp(db, m3)).account).toBe(null);
  await db.update(folderState).set({ observedFolder: "INBOX" }).where(eq(folderState.messageId, m3));
  expect((await stamp(db, m3)).account).toBe(A);
  expect(await drift(db)).toBe(0);

  // 4. A deferral (a refusal recorded, `updated_at` deliberately untouched) keeps it, and the stamp.
  const before = await stamp(db, m1);
  await db.update(folderState).set({ attempts: 1, nextAttemptAt: new Date(STAMP.getTime() + 3_600_000), lastErrorClass: "refused" })
    .where(eq(folderState.messageId, m1));
  expect(await stamp(db, m1)).toEqual(before);
  expect(await drift(db)).toBe(0);

  // 5. A writer naming another account is overwritten, on insert and on update.
  const m5 = await msg();
  await db.insert(folderState).values({ messageId: m5, ...filed, outstandingAccountId: B });
  expect((await stamp(db, m5)).account).toBe(A);
  await db.update(folderState).set({ outstandingAccountId: B }).where(eq(folderState.messageId, m5));
  expect((await stamp(db, m5)).account).toBe(A);
  expect(await drift(db)).toBe(0);

  // 6. A row leaves outstanding (with a wrong value left on it) and comes back: re-derived.
  await db.update(folderState).set({ reconcileStatus: "reconciled", observedFolder: "ohmail/News" }).where(eq(folderState.messageId, m5));
  await db.update(folderState).set({ outstandingAccountId: B }).where(eq(folderState.messageId, m5));
  expect((await stamp(db, m5)).account).toBe(B);
  expect(await drift(db)).toBe(0);
  await db.update(folderState).set({ reconcileStatus: "pending", desiredFolder: "Receipts" }).where(eq(folderState.messageId, m5));
  expect((await stamp(db, m5)).account).toBe(A);
  expect(await drift(db)).toBe(0);

  // 7. A batch insert across both accounts, outstanding and not.
  const batch = [await msg(), await msg(B, MB), await msg(), await msg(B, MB)];
  await db.insert(folderState).values(batch.map((m, i) => ({
    messageId: m, ...filed, ...(i === 2 ? { observedFolder: "ohmail/News" } : {}), ...(i === 3 ? { lastSetBy: "external" } : {}),
  })));
  expect((await stamp(db, batch[0]!)).account).toBe(A);
  expect((await stamp(db, batch[1]!)).account).toBe(B);
  expect((await stamp(db, batch[2]!)).account).toBe(null);
  expect((await stamp(db, batch[3]!)).account).toBe(null);
  expect(await drift(db)).toBe(0);

  const [o] = await db.select({ n: count() }).from(folderState).where(ourOutstandingFiling());
  return Number(o!.n);
}

/** CONTROL: with the trigger withheld, an outstanding insert is counted by the check. */
export async function controlWithoutTrigger(db: Db, sqlite: boolean, tag: string): Promise<void> {
  if (sqlite) {
    await db.run(sql`drop trigger folder_state_outstanding_account_insert`);
    await db.run(sql`drop trigger folder_state_outstanding_account_update`);
  } else {
    await db.execute(sql`drop trigger folder_state_outstanding_account_tg on folder_state`);
  }
  const [m] = await db.insert(messages).values({
    accountId: A, mailboxId: MA, dedupKey: `mid:<fso-${tag}-control@example.test>`, bodyHash: "fso-control",
  }).returning();
  await db.insert(folderState).values({ messageId: m!.id, desiredFolder: "ohmail/News", observedFolder: "INBOX", lastSetBy: "us" });
  expect(await drift(db)).toBe(1);
}

/**
 * MAIL 0163: a NEW filing starts with a fresh schedule. A change of `desired_folder` resets
 * `attempts`, `next_attempt_at` and `last_error_class`, whichever writer makes it; filing into the
 * same folder again, and a deferral, keep them. Mail 0160's column stays right throughout.
 */
const FA = id("ac3"), FM = id("bb3");
const LATER = new Date("2026-10-23T22:00:00.000Z");
const refusedRow = { attempts: 3, nextAttemptAt: LATER, lastErrorClass: "refused" } as const;

async function schedule(db: Db, messageId: string) {
  const [r] = await db.select({
    attempts: folderState.attempts, next: folderState.nextAttemptAt, cls: folderState.lastErrorClass,
    desired: folderState.desiredFolder, account: folderState.outstandingAccountId,
  }).from(folderState).where(eq(folderState.messageId, messageId));
  return { ...r!, next: r!.next ? r!.next.toISOString() : null, cls: r!.cls ?? null, account: r!.account ?? null };
}

async function refusedFiling(db: Db, tag: string, n: number): Promise<string> {
  const [m] = await db.insert(messages).values({
    accountId: FA, mailboxId: FM, dedupKey: `mid:<fi-${tag}-${n}@example.test>`, bodyHash: `fi-${n}`,
  }).returning();
  await db.insert(folderState).values({
    messageId: m!.id, desiredFolder: "ohmail/Receipts", observedFolder: "INBOX", lastSetBy: "us", ...refusedRow,
  });
  return m!.id;
}

export async function runFreshIntentShapes(db: Db, tag: string): Promise<void> {
  await db.insert(accounts).values({ id: FA, name: `fi-${tag}` });
  await db.insert(mailboxes).values({ id: FM, accountId: FA, provider: "imap", address: `fi-${tag}@example.test` });
  const fresh = { attempts: 0, next: null, cls: null, account: FA };
  const kept = { attempts: 3, next: LATER.toISOString(), cls: "refused", account: FA };
  const upsert = (messageId: string, folder: string) => db.insert(folderState)
    .values({ messageId, desiredFolder: folder, observedFolder: "INBOX", lastSetBy: "us" })
    .onConflictDoUpdate({ target: folderState.messageId, set: { desiredFolder: folder, lastSetBy: "us", reconcileStatus: "pending", updatedAt: STAMP } });

  // 1. The rule pass's shape: an insert that conflicts and files the row somewhere else.
  const m1 = await refusedFiling(db, tag, 1);
  await upsert(m1, "ohmail/Screened");
  expect(await schedule(db, m1)).toEqual({ ...fresh, desired: "ohmail/Screened" });

  // 2. A plain update of the desired folder (the move door, screener apply).
  const m2 = await refusedFiling(db, tag, 2);
  await db.update(folderState).set({ desiredFolder: "Archive", updatedAt: STAMP }).where(eq(folderState.messageId, m2));
  expect(await schedule(db, m2)).toEqual({ ...fresh, desired: "Archive" });

  // 3. Filing into the same folder again is not a new filing: the schedule stands.
  const m3 = await refusedFiling(db, tag, 3);
  await upsert(m3, "ohmail/Receipts");
  expect(await schedule(db, m3)).toEqual({ ...kept, desired: "ohmail/Receipts" });

  // 4. A deferral on the new filing keeps what it writes.
  await db.update(folderState).set({ attempts: 1, nextAttemptAt: LATER, lastErrorClass: "read_only" })
    .where(eq(folderState.messageId, m1));
  expect(await schedule(db, m1)).toEqual({ ...fresh, attempts: 1, next: LATER.toISOString(), cls: "read_only", desired: "ohmail/Screened" });
  expect(await drift(db)).toBe(0);
}

/** CONTROL: with mail 0163's trigger dropped, a new filing keeps the old refusal. */
export async function controlFreshIntentWithoutTrigger(db: Db, sqlite: boolean, tag: string): Promise<void> {
  if (sqlite) await db.run(sql`drop trigger folder_state_fresh_intent`);
  else await db.execute(sql`drop trigger folder_state_fresh_intent_tg on folder_state`);
  const m = await refusedFiling(db, tag, 9);
  await db.update(folderState).set({ desiredFolder: "Archive", updatedAt: STAMP }).where(eq(folderState.messageId, m));
  expect((await schedule(db, m)).attempts).toBe(3);
}
