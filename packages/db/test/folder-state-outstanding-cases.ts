import { expect } from "vitest";
import { eq, sql } from "drizzle-orm";
import { accounts, folderState, mailboxes, messages } from "../src/index.js";
import type { makeTestDb } from "../src/testing.js";

type Db = Awaited<ReturnType<typeof makeTestDb>>;

const id = (tail: string): string => `00000000-0000-4000-8000-${tail.padStart(12, "0")}`;
const STAMP = new Date("2026-10-21T08:00:00.000Z");

/**
 * MAIL 0163: a NEW filing starts with a fresh schedule. A change of `desired_folder` resets
 * `attempts`, `next_attempt_at` and `last_error_class`, whichever writer makes it; filing into the
 * same folder again, and a deferral, keep them. The row's account stays its letter's throughout.
 */
const FA = id("ac3"), FM = id("bb3");
const LATER = new Date("2026-10-23T22:00:00.000Z");
const refusedRow = { attempts: 3, nextAttemptAt: LATER, lastErrorClass: "refused" } as const;

async function schedule(db: Db, messageId: string) {
  const [r] = await db.select({
    attempts: folderState.attempts, next: folderState.nextAttemptAt, cls: folderState.lastErrorClass,
    desired: folderState.desiredFolder, account: folderState.accountId,
  }).from(folderState).where(eq(folderState.messageId, messageId));
  return { ...r!, next: r!.next ? r!.next.toISOString() : null, cls: r!.cls ?? null, account: r!.account ?? null };
}

async function refusedFiling(db: Db, tag: string, n: number): Promise<string> {
  const [m] = await db.insert(messages).values({
    accountId: FA, mailboxId: FM, dedupKey: `mid:<fi-${tag}-${n}@example.test>`, bodyHash: `fi-${n}`,
  }).returning();
  await db.insert(folderState).values({
    messageId: m!.id, accountId: FA, desiredFolder: "ohmail/Receipts", observedFolder: "INBOX", lastSetBy: "us", ...refusedRow,
  });
  return m!.id;
}

export async function runFreshIntentShapes(db: Db, tag: string): Promise<void> {
  await db.insert(accounts).values({ id: FA, name: `fi-${tag}` });
  await db.insert(mailboxes).values({ id: FM, accountId: FA, provider: "imap", address: `fi-${tag}@example.test` });
  const fresh = { attempts: 0, next: null, cls: null, account: FA };
  const kept = { attempts: 3, next: LATER.toISOString(), cls: "refused", account: FA };
  const upsert = (messageId: string, folder: string) => db.insert(folderState)
    .values({ messageId, accountId: FA, desiredFolder: folder, observedFolder: "INBOX", lastSetBy: "us" })
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

  // 5. A schedule written in the same statement as a new folder does not stand: the filing starts
  //    fresh, and its own schedule is a later write, as in 4.
  const m5 = await refusedFiling(db, tag, 5);
  await db.update(folderState)
    .set({ desiredFolder: "Archive", attempts: 5, nextAttemptAt: STAMP, lastErrorClass: "read_only", updatedAt: STAMP })
    .where(eq(folderState.messageId, m5));
  expect(await schedule(db, m5)).toEqual({ ...fresh, desired: "Archive" });
}

/** CONTROL: with mail 0163's trigger dropped, a new filing keeps the old refusal. */
export async function controlFreshIntentWithoutTrigger(db: Db, sqlite: boolean, tag: string): Promise<void> {
  if (sqlite) await db.run(sql`drop trigger folder_state_fresh_intent`);
  else await db.execute(sql`drop trigger folder_state_fresh_intent_tg on folder_state`);
  const m = await refusedFiling(db, tag, 9);
  await db.update(folderState).set({ desiredFolder: "Archive", updatedAt: STAMP }).where(eq(folderState.messageId, m));
  expect((await schedule(db, m)).attempts).toBe(3);
}
