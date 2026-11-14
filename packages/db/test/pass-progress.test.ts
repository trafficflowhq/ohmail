import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { and, eq, sql } from "drizzle-orm";
import { SQLITE_JOURNAL } from "@ohmail/db-mail/sqlite-journal";
import {
  NO_MARKS, PASS_NAMES, UnknownPassName, accountPass, accounts, cursorBehind, mailboxPass, mailboxes, markPassDone,
  onPass, passDone, passMark, passProgress, readPassProgress, requestPass, updatePassProgress, writePassProgress,
  type PassKey,
} from "../src/index.js";
import { OLD_HEADS } from "../src/journal-heads.js";
import { migrateSqlite } from "../src/sqlite-migrate.js";
import { makeTestDb } from "../src/testing.js";

/**
 * WHERE A ONE-TIME PASS STANDS IS READ AND WRITTEN THROUGH ONE DOOR (mail 0203), on whichever store
 * the run is (the sqlite project runs this file too). No store holds the list of pass names in a
 * CHECK, so the door is where a foreign name stops; and the entry that made the table moves the
 * fourteen old columns into rows under names the door knows.
 */
async function world() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: "passes" });
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: `p-${accountId}@example.test` }).returning();
  const [other] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: `q-${accountId}@example.test` }).returning();
  return { db, accountId, mailboxId: mb!.id, otherMailboxId: other!.id };
}

const rowsOf = (w: { db: Awaited<ReturnType<typeof makeTestDb>>; accountId: string }) =>
  w.db.select().from(passProgress).where(eq(passProgress.accountId, w.accountId));

/** Ids in the order a walk meets them. */
const FIRST = "00000000-0000-4000-8000-00000000000a";
const SECOND = "00000000-0000-4000-8000-00000000000b";
const THIRD = "00000000-0000-4000-8000-0000000000a0";

describe("the door to where a pass stands", () => {
  it("refuses a name it does not know, for a write and for a read alike, and stores nothing", async () => {
    const w = await world();
    const foreign = "tidy_everything" as never;
    expect(() => accountPass(foreign, w.accountId)).toThrow(UnknownPassName);
    expect(() => mailboxPass(foreign, w.accountId, w.mailboxId)).toThrow(UnknownPassName);
    expect(() => onPass(foreign, w.accountId)).toThrow(UnknownPassName);
    expect(() => passMark(foreign, "doneAt", w.accountId)).toThrow(UnknownPassName);
    expect(() => passDone(foreign, w.accountId)).toThrow(UnknownPassName);
    // A key that was not made by the door's own two makers.
    const forged = { accountId: w.accountId, job: foreign, subjectId: w.accountId } as PassKey;
    const at = new Date();
    await expect(writePassProgress(w.db, forged, { doneAt: at })).rejects.toBeInstanceOf(UnknownPassName);
    await expect(updatePassProgress(w.db, forged, { doneAt: at })).rejects.toBeInstanceOf(UnknownPassName);
    await expect(requestPass(w.db, forged, at)).rejects.toBeInstanceOf(UnknownPassName);
    await expect(markPassDone(w.db, forged, at)).rejects.toBeInstanceOf(UnknownPassName);
    await expect(readPassProgress(w.db, forged)).rejects.toBeInstanceOf(UnknownPassName);
    expect(await rowsOf(w)).toEqual([]);
  });

  it("reads no row as every mark empty", async () => {
    const w = await world();
    expect(await readPassProgress(w.db, accountPass("gate_release", w.accountId))).toEqual(NO_MARKS);
    const done = await w.db.select({ id: accounts.id }).from(accounts)
      .where(and(eq(accounts.id, w.accountId), passDone("gate_release", accounts.id)));
    expect(done).toEqual([]);
  });

  it("marks a pass done once: the first instant stands, and only the first caller is told so", async () => {
    const w = await world();
    const key = accountPass("gate_release", w.accountId);
    const first = new Date("2026-03-01T10:00:00.000Z");
    expect(await markPassDone(w.db, key, first)).toBe(true);
    expect(await markPassDone(w.db, key, new Date("2026-03-02T10:00:00.000Z"))).toBe(false);
    expect((await readPassProgress(w.db, key)).doneAt).toEqual(first);
    const done = await w.db.select({ id: accounts.id }).from(accounts)
      .where(and(eq(accounts.id, w.accountId), passDone("gate_release", accounts.id)));
    expect(done).toEqual([{ id: w.accountId }]);
  });

  it("keeps one subject's marks apart from another's, and one pass's from another's", async () => {
    const w = await world();
    const at = new Date("2026-03-01T10:00:00.000Z");
    await markPassDone(w.db, mailboxPass("kickstart", w.accountId, w.mailboxId), at);
    expect(await readPassProgress(w.db, mailboxPass("kickstart", w.accountId, w.otherMailboxId))).toEqual(NO_MARKS);
    expect(await readPassProgress(w.db, mailboxPass("news_repair", w.accountId, w.mailboxId))).toEqual(NO_MARKS);
    // One mark inside a larger statement, decoded as the column decodes on this store.
    const read = await w.db.select({
      id: mailboxes.id, kickstartAt: passMark("kickstart", "doneAt", mailboxes.accountId, mailboxes.id),
    }).from(mailboxes).where(eq(mailboxes.accountId, w.accountId));
    expect(new Map(read.map((r) => [r.id, r.kickstartAt]))).toEqual(new Map([[w.mailboxId, at], [w.otherMailboxId, null]]));
  });

  it("arms a pass from the top: the request is stamped, an earlier run's cursor goes, its done mark stays", async () => {
    const w = await world();
    const key = accountPass("ohbox_tidy", w.accountId);
    const ran = new Date("2026-03-01T10:00:00.000Z");
    await writePassProgress(w.db, key, { requestedAt: ran, cursor: SECOND, doneAt: ran });
    const again = new Date("2026-04-01T10:00:00.000Z");
    await requestPass(w.db, key, again);
    expect(await readPassProgress(w.db, key)).toEqual({ requestedAt: again, startedAt: null, doneAt: ran, cursor: null });
    expect(await rowsOf(w)).toHaveLength(1);
  });

  it("moves a cursor forward only, when the write says so", async () => {
    const w = await world();
    const key = accountPass("html_words_backfill", w.accountId);
    const forward = (cursor: string) => writePassProgress(w.db, key, { cursor }, { when: cursorBehind(w.db) });
    expect(await forward(SECOND), "no row yet").toBe(true);
    expect(await forward(FIRST), "a page behind the stored one").toBe(false);
    expect((await readPassProgress(w.db, key)).cursor).toBe(SECOND);
    expect(await forward(THIRD)).toBe(true);
    expect((await readPassProgress(w.db, key)).cursor).toBe(THIRD);
  });

  it("makes no row when the write's own condition is false", async () => {
    const w = await world();
    const key = accountPass("search_index_backfill", w.accountId);
    const hasMailbox = (id: string) => sql`exists (select 1 from ${mailboxes} where ${mailboxes.id} = ${id})`;
    const at = new Date("2026-03-01T10:00:00.000Z");
    expect(await writePassProgress(w.db, key, { doneAt: at }, { onlyIf: hasMailbox(randomUUID()) })).toBe(false);
    expect(await rowsOf(w)).toEqual([]);
    expect(await writePassProgress(w.db, key, { doneAt: at }, { onlyIf: hasMailbox(w.mailboxId) })).toBe(true);
    expect(await readPassProgress(w.db, key)).toEqual({ ...NO_MARKS, doneAt: at });
  });

  it("writes a mailbox's mark only for a mailbox the account holds and has not erased", async () => {
    const w = await world();
    const theirs = await world();
    const at = new Date("2026-03-01T10:00:00.000Z");
    // Another account's mailbox, under this account's id.
    expect(await markPassDone(w.db, mailboxPass("news_repair", w.accountId, theirs.mailboxId), at)).toBe(false);
    // A mailbox that is not there at all.
    expect(await writePassProgress(w.db, mailboxPass("sensitive_rescreen", w.accountId, randomUUID()), { cursor: FIRST })).toBe(false);
    // The account's own mailbox, erased.
    await w.db.update(mailboxes).set({ erasedAt: at }).where(eq(mailboxes.id, w.otherMailboxId));
    expect(await markPassDone(w.db, mailboxPass("kickstart", w.accountId, w.otherMailboxId), at)).toBe(false);
    expect(await rowsOf(w)).toEqual([]);
    expect(await w.db.select().from(passProgress).where(eq(passProgress.subjectId, theirs.mailboxId))).toEqual([]);
    // The control: its own living mailbox is marked.
    expect(await markPassDone(w.db, mailboxPass("kickstart", w.accountId, w.mailboxId), at)).toBe(true);
  });

  it("writes no mark for an erased account", async () => {
    const w = await world();
    const at = new Date("2026-03-01T10:00:00.000Z");
    await w.db.update(accounts).set({ erasedAt: at }).where(eq(accounts.id, w.accountId));
    expect(await markPassDone(w.db, accountPass("gate_release", w.accountId), at)).toBe(false);
    await requestPass(w.db, accountPass("ohbox_tidy", w.accountId), at);
    expect(await rowsOf(w)).toEqual([]);
  });

  it("changes a row that stands and makes none where none stands", async () => {
    const w = await world();
    const key = mailboxPass("sensitive_rescreen", w.accountId, w.mailboxId);
    expect(await updatePassProgress(w.db, key, { cursor: null, startedAt: null })).toBe(false);
    expect(await rowsOf(w)).toEqual([]);
    const began = new Date("2026-03-01T10:00:00.000Z");
    await writePassProgress(w.db, key, { cursor: FIRST, startedAt: began });
    expect(await updatePassProgress(w.db, key, { cursor: null, startedAt: null })).toBe(true);
    expect(await readPassProgress(w.db, key)).toEqual(NO_MARKS);
  });
});

type Sqlite = { exec(sql: string): void; prepare(sql: string): { all(...p: unknown[]): unknown[]; run(...p: unknown[]): unknown } };
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (path: string) => Sqlite };

describe("mail 0203 on a device's store", () => {
  const target = (db: Sqlite) => ({
    run: async (s: string) => { db.exec(s); },
    all: async <T,>(s: string) => db.prepare(s).all() as T[],
  });
  const at0203 = SQLITE_JOURNAL.findIndex((e) => e.name.startsWith("0203_"));

  it("moves every mark the columns held into a row under a name the door knows, value by value", async () => {
    expect(at0203, "the device journal carries 0203 above the old head").toBeGreaterThan(SQLITE_JOURNAL.findIndex((e) => e.name === OLD_HEADS.device.name));
    const db = new DatabaseSync(":memory:");
    await migrateSqlite(target(db), SQLITE_JOURNAL.slice(0, at0203));
    const whole = { account: randomUUID(), mailbox: randomUUID() };
    const midWalk = { account: randomUUID(), mailbox: randomUUID() };
    const never = { account: randomUUID(), mailbox: randomUUID() };
    for (const a of [whole, midWalk, never]) {
      db.prepare("insert into accounts (id, name) values (?, ?)").run(a.account, "moved");
      db.prepare("insert into mailboxes (id, account_id, provider, address) values (?, ?, 'imap', ?)").run(a.mailbox, a.account, `${a.account}@example.test`);
      db.prepare("insert into account_settings (account_id) values (?)").run(a.account);
    }
    db.prepare(`update mailboxes set kickstart_at = 1001, sensitive_rescreen_at = 1002, sensitive_rescreen_cursor = ?,
      sensitive_rescreen_started_at = 1003, sensitive_fp_backfill_at = 1004, legacy_news_clean_at = 1005 where id = ?`).run(FIRST, whole.mailbox);
    db.prepare(`update account_settings set ohbox_tidy_requested_at = 2001, ohbox_tidy_done_at = 2002, ohbox_tidy_cursor = ?,
      gate_release_done_at = 2003, search_index_built_at = 2004, list_addresses_scanned_at = 2005, html_words_backfill_at = 2006,
      html_words_backfill_cursor = ? where account_id = ?`).run(SECOND, THIRD, whole.account);
    // A walk that stopped part way: a cursor and its start, and no done mark.
    db.prepare("update mailboxes set sensitive_rescreen_cursor = ?, sensitive_rescreen_started_at = 3001 where id = ?").run(SECOND, midWalk.mailbox);
    db.prepare("update account_settings set html_words_backfill_cursor = ?, ohbox_tidy_requested_at = 3002 where account_id = ?").run(FIRST, midWalk.account);

    expect(await migrateSqlite(target(db), SQLITE_JOURNAL.slice(0, at0203 + 1))).toEqual([SQLITE_JOURNAL[at0203]!.name]);

    const moved = db.prepare(`select account_id, job, subject_id, requested_at, started_at, done_at, cursor
      from pass_progress order by account_id, job`).all() as Array<Record<string, unknown>>;
    const row = (a: { account: string; mailbox: string }, job: string, subject: "account" | "mailbox", marks: Partial<Record<"requested_at" | "started_at" | "done_at" | "cursor", unknown>>) =>
      ({ account_id: a.account, job, subject_id: a[subject], requested_at: null, started_at: null, done_at: null, cursor: null, ...marks });
    const expected = [
      row(whole, "kickstart", "mailbox", { done_at: 1001 }),
      row(whole, "sensitive_rescreen", "mailbox", { done_at: 1002, started_at: 1003, cursor: FIRST }),
      row(whole, "sensitive_fp_backfill", "mailbox", { done_at: 1004 }),
      row(whole, "news_repair", "mailbox", { done_at: 1005 }),
      row(whole, "ohbox_tidy", "account", { requested_at: 2001, done_at: 2002, cursor: SECOND }),
      row(whole, "gate_release", "account", { done_at: 2003 }),
      row(whole, "search_index_backfill", "account", { done_at: 2004 }),
      row(whole, "list_address_backfill", "account", { done_at: 2005 }),
      row(whole, "html_words_backfill", "account", { done_at: 2006, cursor: THIRD }),
      row(midWalk, "sensitive_rescreen", "mailbox", { started_at: 3001, cursor: SECOND }),
      row(midWalk, "html_words_backfill", "account", { cursor: FIRST }),
      row(midWalk, "ohbox_tidy", "account", { requested_at: 3002 }),
    ].sort((a, b) => (a.account_id + a.job).localeCompare(b.account_id + b.job));
    expect(moved.map((r) => ({ ...r })).sort((a, b) => (String(a.account_id) + String(a.job)).localeCompare(String(b.account_id) + String(b.job))))
      .toEqual(expected);

    // The names the entry writes are the door's, all of them: a tenth here is a pass the door refuses.
    const written = [...new Set(moved.map((r) => String(r.job)))].sort();
    expect(written).toHaveLength(9);
    expect([...PASS_NAMES].sort()).toEqual(expect.arrayContaining(written));

    // And the columns are gone.
    const columns = (table: string) => (db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
    const marks = /^(kickstart_at|sensitive_rescreen_|sensitive_fp_backfill_at|legacy_news_clean_at|ohbox_tidy_|gate_release_done_at|search_index_built_at|list_addresses_scanned_at|html_words_backfill_)/;
    expect([...columns("mailboxes"), ...columns("account_settings")].filter((c) => marks.test(c))).toEqual([]);
  });
});
