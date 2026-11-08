import { describe, expect, it } from "vitest";
import { and, count, eq, isNull, ne, or, sql } from "drizzle-orm";
import { accounts, flagState, folderState, mailboxes, messages, upsertDesiredSeen } from "../src/index.js";
import type { Tx } from "../src/change-log.js";
import { makeTestDb } from "../src/testing.js";
import { dialect } from "../src/dialect/index.js";

/**
 * MAIL 0181: EVERY PENDING ROW OF THE RECONCILE QUEUES CARRIES ITS ACCOUNT. A pending `folder_state`
 * row carries its message's account in `outstanding_account_id` (mail 0160 kept it on our outstanding
 * filings; 0181 adds every other pending row: one the user filed in another client, one whose two
 * sides already agree), a pending `flag_state` row in `pending_account_id`. The store writes them on
 * every write, whatever the writer, so each poll reads its own account's queue through an index keyed
 * by them. On whichever store this run is (the sqlite project runs this file too).
 */

type Db = Awaited<ReturnType<typeof makeTestDb>>;
const id = (tail: string): string => `00000000-0000-4000-8000-${tail.padStart(12, "0")}`;
const A = id("ac1"), B = id("ac2"), MA = id("bb1"), MB = id("bb2");

/** Pending folder rows whose account is not their message's. */
async function folderDrift(db: Db): Promise<number> {
  const [r] = await db.select({ n: count() }).from(folderState)
    .innerJoin(messages, eq(messages.id, folderState.messageId))
    .where(and(eq(folderState.reconcileStatus, "pending"), or(
      isNull(folderState.outstandingAccountId), ne(folderState.outstandingAccountId, messages.accountId))));
  return Number(r!.n);
}

/** Pending `\Seen` rows whose account is not their message's. */
async function flagDrift(db: Db): Promise<number> {
  const [r] = await db.select({ n: count() }).from(flagState)
    .innerJoin(messages, eq(messages.id, flagState.messageId))
    .where(and(eq(flagState.reconcileStatus, "pending"), or(
      isNull(flagState.pendingAccountId), ne(flagState.pendingAccountId, messages.accountId))));
  return Number(r!.n);
}

/** Two accounts with a mailbox each; returns a writer of one message in either. */
async function seeded(db: Db, tag: string): Promise<(account?: string, mailbox?: string) => Promise<string>> {
  await db.insert(accounts).values([{ id: A, name: `rqa-a-${tag}` }, { id: B, name: `rqa-b-${tag}` }]);
  await db.insert(mailboxes).values([
    { id: MA, accountId: A, provider: "imap", address: `a-${tag}@example.test` },
    { id: MB, accountId: B, provider: "imap", address: `b-${tag}@example.test` },
  ]);
  let n = 0;
  return async (account = A, mailbox = MA) => {
    n += 1;
    return (await db.insert(messages).values({
      accountId: account, mailboxId: mailbox, dedupKey: `mid:<rqa-${tag}-${n}@example.test>`, bodyHash: `rqa-${n}`,
    }).returning())[0]!.id;
  };
}

const folderAccount = async (db: Db, m: string): Promise<string | null> =>
  (await db.select({ a: folderState.outstandingAccountId }).from(folderState).where(eq(folderState.messageId, m)))[0]!.a ?? null;
const flagAccount = async (db: Db, m: string): Promise<string | null> =>
  (await db.select({ a: flagState.pendingAccountId }).from(flagState).where(eq(flagState.messageId, m)))[0]!.a ?? null;

/** Drop the named triggers, on whichever store this is. */
async function dropTriggers(db: Db, pg: string, lite: string[]): Promise<void> {
  const device = db as unknown as { run: (q: ReturnType<typeof sql.raw>) => Promise<unknown> };
  if (dialect(db).name === "sqlite") for (const t of lite) await device.run(sql.raw(`drop trigger ${t}`));
  else await db.execute(sql.raw(`drop trigger ${pg}`));
}

describe("mail 0181: the folder queue's pending rows carry their account", () => {
  it("on every pending shape, not only our outstanding filings", async () => {
    const db = await makeTestDb();
    const msg = await seeded(db, "f");
    // 1. The user's own move in another client, waiting to be adopted.
    const m1 = await msg();
    await db.insert(folderState).values({ messageId: m1, desiredFolder: "Archive", observedFolder: "INBOX", lastSetBy: "external" });
    expect(await folderAccount(db, m1)).toBe(A);
    // 2. A pending row whose two sides agree: a status repair the poll retires without IMAP.
    const m2 = await msg(B, MB);
    await db.insert(folderState).values({ messageId: m2, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us" });
    expect(await folderAccount(db, m2)).toBe(B);
    // 3. A settled row carries none; an observation that puts it back in the queue fills it.
    const m3 = await msg();
    await db.insert(folderState).values({ messageId: m3, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us", reconcileStatus: "reconciled" });
    expect(await folderAccount(db, m3)).toBe(null);
    await db.update(folderState).set({ observedFolder: "Archive", lastSetBy: "external", reconcileStatus: "pending" })
      .where(eq(folderState.messageId, m3));
    expect(await folderAccount(db, m3)).toBe(A);
    // 4. A writer naming another account is overwritten, on insert and on update.
    const m4 = await msg();
    await db.insert(folderState).values({ messageId: m4, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "external", outstandingAccountId: B });
    expect(await folderAccount(db, m4)).toBe(A);
    await db.update(folderState).set({ outstandingAccountId: B }).where(eq(folderState.messageId, m4));
    expect(await folderAccount(db, m4)).toBe(A);
    // 5. Our outstanding filing taken over by the user's own client keeps its account.
    const m5 = await msg(B, MB);
    await db.insert(folderState).values({ messageId: m5, desiredFolder: "ohmail/News", observedFolder: "INBOX", lastSetBy: "us" });
    await db.update(folderState).set({ lastSetBy: "external", outstandingAccountId: A }).where(eq(folderState.messageId, m5));
    expect(await folderAccount(db, m5)).toBe(B);
    // 6. A batch across both accounts, pending and settled.
    const batch = [await msg(), await msg(B, MB), await msg()];
    await db.insert(folderState).values(batch.map((m, i) => ({
      messageId: m, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: i === 1 ? "external" : "us",
      reconcileStatus: i === 2 ? "reconciled" : "pending",
    })));
    expect(await Promise.all(batch.map((m) => folderAccount(db, m)))).toEqual([A, B, null]);
    expect(await folderDrift(db)).toBe(0);
  });

  it("control: without the trigger a pending row of the user's own carries no account, and the check sees it", async () => {
    const db = await makeTestDb();
    const msg = await seeded(db, "fc");
    await dropTriggers(db, "folder_state_pending_account_tg on folder_state",
      ["folder_state_pending_account_insert", "folder_state_pending_account_update"]);
    await db.insert(folderState).values({ messageId: await msg(), desiredFolder: "Archive", observedFolder: "INBOX", lastSetBy: "external" });
    expect(await folderDrift(db)).toBe(1);
  });
});

describe("mail 0181: the read-state queue's pending rows carry their account", () => {
  it("on every pending shape, whatever the writer", async () => {
    const db = await makeTestDb();
    const msg = await seeded(db, "s");
    const tx = db as unknown as Tx;
    // 1. The intent writer: a read mark the server has not taken yet.
    const m1 = await msg();
    await upsertDesiredSeen(tx, m1, false, true, new Date());
    expect(await flagAccount(db, m1)).toBe(A);
    // 2. A mark the server already shows is settled and carries none; the next one that differs fills it.
    const m2 = await msg(B, MB);
    await upsertDesiredSeen(tx, m2, true, true, new Date());
    expect(await flagAccount(db, m2)).toBe(null);
    await upsertDesiredSeen(tx, m2, true, false, new Date());
    expect(await flagAccount(db, m2)).toBe(B);
    // 3. A read state the user changed in another client, waiting.
    const m3 = await msg();
    await db.insert(flagState).values({ messageId: m3, desiredSeen: false, observedSeen: true, lastSetBy: "external" });
    expect(await flagAccount(db, m3)).toBe(A);
    // 4. A STORE whose answer was lost puts a settled row back in the queue.
    const m4 = await msg(B, MB);
    await db.insert(flagState).values({ messageId: m4, desiredSeen: true, observedSeen: true, lastSetBy: "us", reconcileStatus: "reconciled" });
    await db.update(flagState).set({ conflict: true, reconcileStatus: "pending" }).where(eq(flagState.messageId, m4));
    expect(await flagAccount(db, m4)).toBe(B);
    // 5. A writer naming another account is overwritten, on insert and on update.
    const m5 = await msg();
    await db.insert(flagState).values({ messageId: m5, desiredSeen: true, observedSeen: false, lastSetBy: "us", pendingAccountId: B });
    expect(await flagAccount(db, m5)).toBe(A);
    await db.update(flagState).set({ pendingAccountId: B }).where(eq(flagState.messageId, m5));
    expect(await flagAccount(db, m5)).toBe(A);
    // 6. A batch across both accounts, pending and settled.
    const batch = [await msg(), await msg(B, MB), await msg()];
    await db.insert(flagState).values(batch.map((m, i) => ({
      messageId: m, desiredSeen: true, observedSeen: i === 2, lastSetBy: "us", reconcileStatus: i === 2 ? "reconciled" : "pending",
    })));
    expect(await Promise.all(batch.map((m) => flagAccount(db, m)))).toEqual([A, B, null]);
    expect(await flagDrift(db)).toBe(0);
  });

  it("control: without the trigger a pending read mark carries no account, and the check sees it", async () => {
    const db = await makeTestDb();
    const msg = await seeded(db, "sc");
    await dropTriggers(db, "flag_state_pending_account_tg on flag_state",
      ["flag_state_pending_account_insert", "flag_state_pending_account_update"]);
    await upsertDesiredSeen(db as unknown as Tx, await msg(), false, true, new Date());
    expect(await flagDrift(db)).toBe(1);
  });
});
