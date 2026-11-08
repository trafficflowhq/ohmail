import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accounts, accountStorage, evictOldestBodies, mailboxFolders, mailboxes, messageBodies, messageInstances, messages,
  recordChange, type Tx,
} from "@trafficflow/db";
import { DEFAULT_LETTER_TEXT_BYTES, mailboxStorageStats, storageReadingOf } from "@trafficflow/db/cloud";
import { dialect } from "@trafficflow/db/dialect";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import {
  resetStorageStatsAttempts, storageStatsPass, STORAGE_STATS_EVERY_MS, STORAGE_STATS_RETRY_MS, STORAGE_STATS_TIMEOUT_MS,
} from "../src/storage-stats.js";

/**
 * THE STORAGE ESTIMATE'S SNAPSHOT (cloud 0057, marks 0058), on PGlite: counted per mailbox when it has
 * no row, when a first import finished, and every 6 hours; a mailbox the change log names is read in
 * bounded pages, one nobody touched is confirmed unread; a failure keeps the rows that were there.
 */

type Db = Awaited<ReturnType<typeof makeTestDb>>;
const START = new Date("2026-11-07T12:00:00.000Z");
const later = (ms: number): Date => new Date(START.getTime() + ms);
const WEEK = 7 * 24 * 60 * 60 * 1000;

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
): Promise<string> {
  const key = randomUUID();
  return db.transaction(async (tx) => {
    const [m] = await tx.insert(messages).values({
      accountId, mailboxId, messageIdHeader: `<${key}@example.com>`, bodyHash: key, dedupKey: key,
      subject: "s", fromAddress: "a@example.com", snippet: "", ...(o.deleted ? { deletedAt: START } : {}),
    }).returning({ id: messages.id });
    await tx.insert(messageBodies).values({
      messageId: m!.id, text: o.text ?? "", html: o.html ?? null, withheldReason: o.withheld ?? null,
    });
    for (let i = 0; i < (o.places ?? 1); i++) {
      await tx.insert(messageInstances).values({
        accountId, mailboxId, messageId: m!.id, folder: i === 0 ? "INBOX" : `F${i}`, uidvalidity: 7n, uid: nextUid++, isPrimary: i === 0,
      });
    }
    await recordChange(tx as never, { accountId, entityType: "message", entityId: m!.id, op: "create" });
    return m!.id;
  });
}
let nextUid = 100;

const rowsOf = async (db: Db, accountId: string) =>
  (await db.select().from(mailboxStorageStats).where(eq(mailboxStorageStats.accountId, accountId)))
    .map(({ at: _at, accountId: _a, throughSeq: _s, huskedAt: _h, walkedAt: _w, ...r }) => r).sort((a, b) => a.mailboxId.localeCompare(b.mailboxId));

/** Today's figures in ONE grouped statement, the definition the pages must sum to. */
async function literalOf(db: Db, accountId: string): Promise<Map<string, Record<string, number>>> {
  const rows = await dialect(db).exec(db, sql`
    select m."mailbox_id", count(*)::int as l,
           (count(*) filter (where b."withheld_reason" is null and (octet_length(b."text") > 0 or b."html" is not null)))::int as t,
           (count(*) filter (where b."withheld_reason" = 'storage_cap'))::int as e,
           (coalesce(sum(octet_length(b."text") + coalesce(octet_length(b."html"), 0)) filter (where b."withheld_reason" is null), 0))::int as b,
           (coalesce(sum(i.n), 0))::int as i
      from messages m
      left join message_bodies b on b."message_id" = m."id"
      left join lateral (select count(*) as n from message_instances x where x."message_id" = m."id") i on true
     where m."account_id" = ${accountId} and m."deleted_at" is null
     group by m."mailbox_id"`);
  return new Map(rows.map((r) => [String(r[0]), {
    letters: Number(r[1]), textLetters: Number(r[2]), emptied: Number(r[3]), textBytes: Number(r[4]), instances: Number(r[5]),
  }]));
}

interface Seen { params: unknown[]; letters: number }
/**
 * A COUNTED-WORK TIMEOUT (PGlite ignores `statement_timeout`): every statement in a transaction whose
 * result has a `letters` column is recorded, and one whose letters sum past `budget` is cut off with
 * 57014, as the server cuts off a statement past its timeout. `cutOnce` cuts that statement (1-based) once.
 */
function counted(db: Db, budget: number, cutOnce?: number): Seen[] {
  const seen: Seen[] = [];
  type Res = { rows: unknown[]; fields: Array<{ name: string }> };
  type Doors = Record<"query", (q: string, params?: unknown[], o?: unknown) => Promise<Res>>;
  const client = (db as unknown as { $client: { transaction: (cb: (tx: Doors) => Promise<unknown>) => Promise<unknown> } }).$client;
  const innerTx = client.transaction.bind(client);
  client.transaction = (cb) => innerTx((tx) => {
    const inner = tx.query.bind(tx);
    tx.query = async (q, params, o) => {
      const res = await inner(q, params, o);
      const at = res.fields?.findIndex((f) => f.name === "letters") ?? -1;
      if (at < 0) return res;
      const letters = res.rows.reduce<number>((t, r) => t + Number(Array.isArray(r) ? r[at] : (r as Record<string, unknown>).letters), 0);
      seen.push({ params: params ?? [], letters });
      if (letters > budget || seen.length === cutOnce) {
        throw Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
      }
      return res;
    };
    return cb(tx);
  });
  return seen;
}

/** Nine letters over two mailboxes, every kind the figures tell apart. */
async function nineLetters(db: Db, me: string): Promise<[string, string]> {
  const a = await mailbox(db, me, [["INBOX", 9]]);
  const b = await mailbox(db, me, [["INBOX", 4]]);
  await letter(db, me, a, { text: "hello", places: 2 });
  await letter(db, me, a, { text: "", html: "<p>héllo</p>" });
  await letter(db, me, a, { withheld: "storage_cap" });
  await letter(db, me, a, { withheld: "junk_filed", places: 3 });
  await letter(db, me, a, { text: "gone", deleted: true });
  await letter(db, me, a, { text: "x".repeat(70) });
  await letter(db, me, b, { text: "zürich" });
  await letter(db, me, b, { text: "", html: null });
  await letter(db, me, b, { text: "bye", html: "<b>b</b>", places: 2 });
  return [a, b];
}

const figures = async (db: Db, me: string) =>
  new Map((await rowsOf(db, me)).map(({ mailboxId, letters, textLetters, emptied, textBytes, instances }) =>
    [mailboxId, { letters, textLetters, emptied, textBytes, instances }]));

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
    expect(r).toEqual({ taken: "no_row", mailboxes: 2, more: false });
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
    // Every letter is in and counted: the byte of text each holds, no longer the default's guess.
    expect(after.need).toEqual({ ...need, expectedBytes: 40 });
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
    // The unchanged mailbox is not read again.
    expect(r).toEqual({ taken: "stale", mailboxes: 0, more: false });
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
    const a = await mailbox(db, me, [["INBOX", 3]]);
    await storageStatsPass(db as unknown as Tx, { accountId: me, now: START });
    const before = await rowsOf(db, me);
    await letter(db, me, a, { text: "new" });
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

  it("a mailbox too large for one statement is read in pages that sum to the one-statement figures", async () => {
    for (const pageLetters of [1, 2, 3]) {
      resetStorageStatsAttempts();
      const db = await makeTestDb();
      const me = await account(db);
      await nineLetters(db, me);
      const seen = counted(db, 3);
      const pass = (ms: number) => storageStatsPass(db as unknown as Tx, { accountId: me, now: later(ms), pageLetters });
      // The one-statement count is cut off on every attempt; the pages never are.
      const r = await pass(0).catch(() => pass(STORAGE_STATS_RETRY_MS)).catch(() => pass(2 * STORAGE_STATS_RETRY_MS));
      expect(r).toEqual({ taken: "no_row", mailboxes: 2, more: false });
      expect(seen.every((x) => x.letters <= pageLetters)).toBe(true);
      expect(await figures(db, me)).toEqual(await literalOf(db, me));
    }
  });

  it("a page cut off writes nothing partial and resumes at its place after the wait", async () => {
    resetStorageStatsAttempts();
    const db = await makeTestDb();
    const me = await account(db);
    const a = await mailbox(db, me, [["INBOX", 9]]);
    for (let i = 0; i < 9; i++) await letter(db, me, a, { text: "x".repeat(i + 1) });
    const seen = counted(db, 100, 3);
    const pass = (ms: number) => storageStatsPass(db as unknown as Tx, { accountId: me, now: later(ms), pageLetters: 3 });
    await expect(pass(0)).rejects.toThrow(/statement timeout/);
    expect(await rowsOf(db, me)).toEqual([]);
    expect(await pass(STORAGE_STATS_RETRY_MS - 1)).toEqual({ taken: null, mailboxes: 0, more: true });
    expect(await pass(STORAGE_STATS_RETRY_MS)).toEqual({ taken: "no_row", mailboxes: 1, more: false });
    // Pages of 3, 3, 3 and an empty one, and the cut-off one sent again: nothing read twice.
    expect(seen).toHaveLength(5);
    expect(await figures(db, me)).toEqual(await literalOf(db, me));
  });

  it("a mailbox nobody touched is confirmed unread; a letter landing reads only its own mailbox", async () => {
    resetStorageStatsAttempts();
    const db = await makeTestDb();
    const me = await account(db);
    const [a, b] = await nineLetters(db, me);
    await storageStatsPass(db as unknown as Tx, { accountId: me, now: START });
    const first = await figures(db, me);
    const seen = counted(db, 100);
    expect(await storageStatsPass(db as unknown as Tx, { accountId: me, now: later(STORAGE_STATS_EVERY_MS) }))
      .toEqual({ taken: "stale", mailboxes: 2, more: false });
    expect(seen).toEqual([]);
    const ats = await db.select({ at: mailboxStorageStats.at }).from(mailboxStorageStats).where(eq(mailboxStorageStats.accountId, me));
    expect(ats.map((x) => x.at.getTime())).toEqual([later(STORAGE_STATS_EVERY_MS).getTime(), later(STORAGE_STATS_EVERY_MS).getTime()]);

    await letter(db, me, b, { text: "new", places: 2 });
    expect(await storageStatsPass(db as unknown as Tx, { accountId: me, now: later(2 * STORAGE_STATS_EVERY_MS) }))
      .toMatchObject({ taken: "stale", mailboxes: 2 });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((x) => x.params.includes(b) && !x.params.includes(a))).toBe(true);
    const now = await figures(db, me);
    expect(now.get(a)).toEqual(first.get(a));
    expect(now).toEqual(await literalOf(db, me));
    expect(now.get(b)!.letters).toBe(first.get(b)!.letters + 1);
  });

  it("stops after a statement when the tail's slice is spent, and writes no row for a mailbox half read", async () => {
    resetStorageStatsAttempts();
    const db = await makeTestDb();
    const me = await account(db);
    const a = await mailbox(db, me);
    for (let i = 0; i < 3; i++) await letter(db, me, a, { text: "x" });
    const seen = counted(db, 100);
    const r = await storageStatsPass(db as unknown as Tx, { accountId: me, now: START, pageLetters: 1, until: () => true });
    expect(r).toEqual({ taken: "no_row", mailboxes: 0, more: true });
    expect(seen).toHaveLength(1);
    expect(await rowsOf(db, me)).toEqual([]);
  });

  it("a trim since the count makes a mailbox holding text due again", async () => {
    resetStorageStatsAttempts();
    const db = await makeTestDb();
    const me = await account(db);
    await nineLetters(db, me);
    await storageStatsPass(db as unknown as Tx, { accountId: me, now: START });
    await db.insert(accountStorage).values({ accountId: me, bytes: 10_000 });
    const trimmed = await db.transaction((tx) => evictOldestBodies(tx as unknown as Tx, dialect(tx), me, { targetBytes: 0, maxBodies: 1 }));
    expect(trimmed.evicted).toBe(1);
    await storageStatsPass(db as unknown as Tx, { accountId: me, now: later(STORAGE_STATS_EVERY_MS) });
    const now = await figures(db, me);
    expect(now).toEqual(await literalOf(db, me));
    expect([...now.values()].reduce((t, x) => t + x.emptied, 0)).toBe(2);
  });

  it.each(["husk", "refill"] as const)("a %s that writes no change row stands at most a week, then the mailbox is read whole", async (arm) => {
    resetStorageStatsAttempts();
    const db = await makeTestDb();
    const me = await account(db);
    const a = await mailbox(db, me, [["INBOX", 2]]);
    await letter(db, me, a, { text: "x".repeat(100) });
    const id = await letter(db, me, a, arm === "husk" ? { text: "s".repeat(5_000) } : { withheld: "junk_filed" });
    const pass = (ms: number) => storageStatsPass(db as unknown as Tx, { accountId: me, now: later(ms) });
    await pass(0);
    // A junk filing's husk (`completeFiling`), or the pipeline's refill of one: no change row, no trim stamp.
    const repo = makeDrizzleRepo(db as unknown as Tx);
    expect(arm === "husk"
      ? await repo.huskBody(me, id, "junk_filed")
      : await repo.restoreWithheldBody(id, { text: "s".repeat(5_000), html: null, headers: {} }, { accountId: me, capBytes: null }))
      .toBe(true);
    // A period confirms the row unread; a week after the last full read, the mailbox is read whole.
    await pass(STORAGE_STATS_EVERY_MS);
    await pass(WEEK);
    expect(await figures(db, me)).toEqual(await literalOf(db, me));
  });
});
