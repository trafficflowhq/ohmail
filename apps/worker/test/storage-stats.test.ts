import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accounts, mailboxFolders, mailboxes, messageBodies, messageInstances, messages, type Tx,
} from "@trafficflow/db";
import { DEFAULT_LETTER_TEXT_BYTES, mailboxStorageStats, storageReadingOf } from "@trafficflow/db/cloud";
import {
  resetStorageStatsAttempts, storageStatsPass, STORAGE_STATS_EVERY_MS, STORAGE_STATS_RETRY_MS, STORAGE_STATS_TIMEOUT_MS,
} from "../src/storage-stats.js";

/**
 * THE STORAGE ESTIMATE'S SNAPSHOT (cloud 0057), on PGlite: one grouped count per account over the
 * letters it owns, taken when a mailbox has no row, when a first import finished, and every 6 hours;
 * a failure keeps the rows that were there.
 */

type Db = Awaited<ReturnType<typeof makeTestDb>>;
const START = new Date("2026-11-07T12:00:00.000Z");
const later = (ms: number): Date => new Date(START.getTime() + ms);

async function account(db: Db): Promise<string> {
  const id = randomUUID();
  await db.insert(accounts).values({ id, name: "Stats" });
  return id;
}

async function mailbox(db: Db, accountId: string, folders: Array<[string, number | null]> = []): Promise<string> {
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `mb-${randomUUID().slice(0, 8)}@example.com`,
  }).returning({ id: mailboxes.id });
  for (const [folder, n] of folders) await db.insert(mailboxFolders).values({ mailboxId: mb!.id, folder, serverExists: n });
  return mb!.id;
}

/** One letter: its body as stored, its places on the server, and whether the account deleted it. */
async function letter(
  db: Db, accountId: string, mailboxId: string,
  o: { text?: string; html?: string | null; withheld?: string | null; places?: number; deleted?: boolean },
): Promise<void> {
  const key = randomUUID();
  const [m] = await db.insert(messages).values({
    accountId, mailboxId, messageIdHeader: `<${key}@example.com>`, bodyHash: key, dedupKey: key,
    subject: "s", fromAddress: "a@example.com", snippet: "", ...(o.deleted ? { deletedAt: START } : {}),
  }).returning({ id: messages.id });
  await db.insert(messageBodies).values({
    messageId: m!.id, text: o.text ?? "", html: o.html ?? null, withheldReason: o.withheld ?? null,
  });
  for (let i = 0; i < (o.places ?? 1); i++) {
    await db.insert(messageInstances).values({
      accountId, mailboxId, messageId: m!.id, folder: i === 0 ? "INBOX" : `F${i}`, uidvalidity: 7n, uid: nextUid++, isPrimary: i === 0,
    });
  }
}
let nextUid = 100;

const rowsOf = async (db: Db, accountId: string) =>
  (await db.select().from(mailboxStorageStats).where(eq(mailboxStorageStats.accountId, accountId)))
    .map(({ at: _at, accountId: _a, ...r }) => r).sort((a, b) => a.mailboxId.localeCompare(b.mailboxId));

describe("the storage estimate's snapshot", () => {
  it("counts each mailbox's letters the account owns: with text, emptied, their bytes and their places", async () => {
    resetStorageStatsAttempts();
    const db = await makeTestDb();
    const me = await account(db);
    const a = await mailbox(db, me, [["INBOX", 10], ["Archive", 5]]);
    const b = await mailbox(db, me, [["INBOX", null]]);
    await letter(db, me, a, { text: "hello", places: 2 });
    await letter(db, me, a, { text: "", html: "<p>héllo</p>" });
    await letter(db, me, a, { withheld: "storage_cap" });
    await letter(db, me, a, { withheld: "junk_filed" });
    await letter(db, me, a, { text: "gone", deleted: true });
    // Another account's letter in a mailbox of its own counts for nobody here.
    const them = await account(db);
    await letter(db, them, await mailbox(db, them), { text: "theirs" });

    const r = await storageStatsPass(db as unknown as Tx, { accountId: me, now: START });
    expect(r).toEqual({ taken: "no_row", mailboxes: 2 });
    expect(await rowsOf(db, me)).toEqual([
      {
        mailboxId: a, letters: 4, textLetters: 2, emptied: 1, textBytes: 5 + Buffer.byteLength("<p>héllo</p>"), instances: 5,
        serverLetters: 15, counted: true, imported: false,
      },
      { mailboxId: b, letters: 0, textLetters: 0, emptied: 0, textBytes: 0, instances: 0, serverLetters: null, counted: false, imported: false },
    ].sort((x, y) => x.mailboxId.localeCompare(y.mailboxId)));
    expect(await rowsOf(db, them)).toEqual([]);
  });

  it("is due again when a first import finishes, and every six hours; between, nothing is counted", async () => {
    resetStorageStatsAttempts();
    const db = await makeTestDb();
    const me = await account(db);
    const a = await mailbox(db, me, [["INBOX", 1]]);
    const b = await mailbox(db, me, [["INBOX", 1]]);
    const pass = (ms: number) => storageStatsPass(db as unknown as Tx, { accountId: me, now: later(ms) });
    expect((await pass(0)).taken).toBe("no_row");
    expect((await pass(60_000)).taken).toBeNull();
    // A first import that finished is counted at the next tail, though an attempt was made a minute ago.
    await db.update(mailboxes).set({ initialImportCompletedAt: later(90_000) }).where(eq(mailboxes.id, a));
    expect((await pass(120_000)).taken).toBe("imported");
    expect((await rowsOf(db, me)).find((r) => r.mailboxId === a)).toMatchObject({ imported: true });
    // Any attempt after that waits its half hour, a second import's too.
    await db.update(mailboxes).set({ initialImportCompletedAt: later(150_000) }).where(eq(mailboxes.id, b));
    expect((await pass(180_000)).taken).toBeNull();
    expect((await pass(120_000 + STORAGE_STATS_RETRY_MS)).taken).toBe("imported");
    expect((await pass(120_000 + STORAGE_STATS_RETRY_MS + STORAGE_STATS_EVERY_MS)).taken).toBe("stale");
  });

  it("an estimate read between a first import and its snapshot takes the server's count, not the snapshot's", async () => {
    resetStorageStatsAttempts();
    const db = await makeTestDb();
    const me = await account(db);
    const a = await mailbox(db, me, [["INBOX", 40]]);
    expect((await storageStatsPass(db as unknown as Tx, { accountId: me, now: START })).taken).toBe("no_row");
    for (let i = 0; i < 40; i++) await letter(db, me, a, { text: "x" });
    await db.update(mailboxes).set({ initialImportCompletedAt: later(10 * 60_000) }).where(eq(mailboxes.id, a));
    const need = { expectedLetters: 40, expectedBytes: 40 * DEFAULT_LETTER_TEXT_BYTES, importing: false };
    const between = await storageReadingOf(db as unknown as Tx, me);
    expect(between.estimate).toMatchObject({ expectedLetters: 40, storedLetters: 0, complete: true });
    expect(between.need).toEqual(need);
    expect((await storageStatsPass(db as unknown as Tx, { accountId: me, now: later(11 * 60_000) })).taken).toBe("imported");
    const after = await storageReadingOf(db as unknown as Tx, me);
    expect(after.estimate).toMatchObject({ expectedLetters: 40, storedLetters: 40, complete: true });
    expect(after.need).toEqual(need);
  });

  it("a mailbox erased since drops its row; an erased account writes none", async () => {
    resetStorageStatsAttempts();
    const db = await makeTestDb();
    const me = await account(db);
    const a = await mailbox(db, me);
    const b = await mailbox(db, me);
    await storageStatsPass(db as unknown as Tx, { accountId: me, now: START });
    await db.update(mailboxes).set({ erasedAt: START }).where(eq(mailboxes.id, b));
    const r = await storageStatsPass(db as unknown as Tx, { accountId: me, now: later(STORAGE_STATS_RETRY_MS) });
    expect(r).toEqual({ taken: "stale", mailboxes: 1 });
    expect((await rowsOf(db, me)).map((x) => x.mailboxId)).toEqual([a]);

    const gone = await account(db);
    await mailbox(db, gone);
    await db.update(accounts).set({ erasedAt: START }).where(eq(accounts.id, gone));
    await expect(storageStatsPass(db as unknown as Tx, { accountId: gone, now: START })).rejects.toThrow();
    expect(await rowsOf(db, gone)).toEqual([]);
  });

  it("counts under its own statement timeout, and a count that fails keeps the rows that were there", async () => {
    resetStorageStatsAttempts();
    const db = await makeTestDb();
    const me = await account(db);
    await mailbox(db, me, [["INBOX", 3]]);
    await storageStatsPass(db as unknown as Tx, { accountId: me, now: START });
    const before = await rowsOf(db, me);
    // Every statement the next snapshot sends, in order; the count is cut off in the database.
    const seen: string[] = [];
    type Doors = Record<"query" | "exec", (...a: unknown[]) => Promise<unknown>>;
    const client = (db as unknown as { $client: Doors & { transaction: (cb: (tx: Doors) => Promise<unknown>) => Promise<unknown> } }).$client;
    const innerTx = client.transaction.bind(client);
    client.transaction = (cb) => innerTx((tx) => {
      for (const door of ["query", "exec"] as const) {
        const inner = tx[door].bind(tx);
        tx[door] = (...a: unknown[]) => {
          const q = String(a[0]);
          seen.push(q);
          if (/count\(\*\)/.test(q) && /message_instances/.test(q)) return Promise.reject(new Error("canceling statement due to statement timeout"));
          return inner(...(a as []));
        };
      }
      return cb(tx);
    });
    await db.update(mailboxFolders).set({ serverExists: 300 });
    await expect(storageStatsPass(db as unknown as Tx, {
      accountId: me, now: later(STORAGE_STATS_EVERY_MS + STORAGE_STATS_RETRY_MS),
    })).rejects.toThrow(/statement timeout/);
    expect(seen.findIndex((q) => q.includes(`'${STORAGE_STATS_TIMEOUT_MS}'`) && q.includes("statement_timeout")))
      .toBeLessThan(seen.findIndex((q) => /message_instances/.test(q)));
    expect(await rowsOf(db, me), "the old rows stand").toEqual(before);
  });
});
