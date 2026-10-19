import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { SQLITE_JOURNAL } from "@ohmail/db-mail/sqlite-journal";
import { migrateSqlite } from "../src/sqlite-migrate.js";

/**
 * MAIL 0154 ON THE DEVICE STORE: `message_recipients` holds each message's To and Cc addresses,
 * lowercased, one row per (message, address), kept by three triggers on `messages` and backfilled
 * from the rows already there. The phone's address search by recipient reads only this table.
 */
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string, options?: { enableForeignKeyConstraints?: boolean }) => {
    exec(sql: string): void;
    prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown };
  };
};
type Db = InstanceType<typeof DatabaseSync>;

const ENTRY = "0154_messages_recipient_keys.sql";

async function open(journal = SQLITE_JOURNAL): Promise<Db> {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  await migrateSqlite({
    run: async (s: string) => { db.exec(s); },
    all: async <T,>(s: string) => db.prepare(s).all() as T[],
  }, journal);
  return db;
}

function mailbox(db: Db, account: string): string {
  const id = randomUUID();
  db.prepare("insert into mailboxes (id, account_id, provider, address) values (?, ?, 'imap', ?)").run(id, account, `${id}@tf.test`);
  return id;
}

function message(db: Db, account: string, mb: string, to: unknown, cc: unknown = []): string {
  const id = randomUUID();
  db.prepare(`insert into messages (id, account_id, mailbox_id, body_hash, dedup_key, from_address, to_addresses, cc_addresses)
    values (?, ?, ?, 'h', ?, 'sender@acme.test', ?, ?)`)
    .run(id, account, mb, `d:${id}`, typeof to === "string" ? to : JSON.stringify(to), JSON.stringify(cc));
  return id;
}

const rowsOf = (db: Db, id?: string) => (id === undefined
  ? db.prepare("select account_id, message_id, address from message_recipients order by message_id, address").all()
  : db.prepare("select account_id, address from message_recipients where message_id = ? order by address").all(id)) as Array<Record<string, string>>;

const long = (n: number) => `${"x".repeat(n - "@acme.test".length)}@acme.test`;

describe("mail 0154 on the device store", () => {
  it("an inserted message's To and Cc are rows, lowercased, once each, odd entries skipped", async () => {
    const db = await open();
    const a = randomUUID();
    const id = message(db, a, mailbox(db, a),
      [{ name: null, address: "Info@ACME.test" }, "bare@acme.test", { name: "none" }, { name: null, address: "" }, { name: null, address: long(300) }],
      [{ name: null, address: "info@acme.test" }, { name: null, address: long(254).toUpperCase() }]);
    expect(rowsOf(db, id)).toEqual([
      { account_id: a, address: "info@acme.test" },
      { account_id: a, address: long(254) },
    ]);
    // A To that is not JSON at all stores, and indexes nothing.
    expect(rowsOf(db, message(db, a, mailbox(db, a), "not json"))).toEqual([]);
  });

  it("an edit of the recipients or the account replaces the rows; a delete removes them", async () => {
    const db = await open();
    const a = randomUUID();
    const b = randomUUID();
    const id = message(db, a, mailbox(db, a), [{ name: null, address: "old@acme.test" }]);
    db.prepare("update messages set to_addresses = ?, cc_addresses = ? where id = ?")
      .run(JSON.stringify([{ name: null, address: "New@acme.test" }]), JSON.stringify([{ name: null, address: "cc@acme.test" }]), id);
    expect(rowsOf(db, id)).toEqual([{ account_id: a, address: "cc@acme.test" }, { account_id: a, address: "new@acme.test" }]);
    db.prepare("update messages set subject = 'x' where id = ?").run(id);
    expect(rowsOf(db, id)).toHaveLength(2);
    db.prepare("update messages set account_id = ? where id = ?").run(b, id);
    expect(rowsOf(db, id).map((r) => r.account_id)).toEqual([b, b]);
    db.prepare("delete from messages where id = ?").run(id);
    expect(rowsOf(db, id)).toEqual([]);
  });

  it("a store at 0153 gets its old messages' rows when 0154 applies (the backfill)", async () => {
    const before = SQLITE_JOURNAL.filter((e) => e.name < ENTRY);
    expect(before.length).toBe(SQLITE_JOURNAL.length - 1);
    const db = await open(before);
    expect(db.prepare("select name from sqlite_master where name = 'message_recipients'").all()).toEqual([]);
    const a = randomUUID();
    const mb = mailbox(db, a);
    const one = message(db, a, mb, [{ name: null, address: "Old@acme.test" }], [{ name: null, address: "old@acme.test" }]);
    const two = message(db, a, mb, [], [{ name: null, address: "cc@acme.test" }]);
    expect(await migrateSqlite({
      run: async (s: string) => { db.exec(s); },
      all: async <T,>(s: string) => db.prepare(s).all() as T[],
    })).toEqual([ENTRY]);
    expect(rowsOf(db, one)).toEqual([{ account_id: a, address: "old@acme.test" }]);
    expect(rowsOf(db, two)).toEqual([{ account_id: a, address: "cc@acme.test" }]);
  });

  it("0154's statements run twice without an error or a duplicate row", async () => {
    const db = await open();
    const a = randomUUID();
    message(db, a, mailbox(db, a), [{ name: null, address: "x@acme.test" }, { name: null, address: "y@acme.test" }]);
    const entry = SQLITE_JOURNAL.find((e) => e.name === ENTRY)!;
    expect(entry.statements.length).toBeGreaterThan(0);
    const once = rowsOf(db);
    for (const s of entry.statements) db.exec(s);
    expect(rowsOf(db)).toEqual(once);
    expect(once).toHaveLength(2);
  });
});
