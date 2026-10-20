import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { SQLITE_JOURNAL } from "@ohmail/db-mail/sqlite-journal";
import { sqliteDialect } from "../src/dialect/index.js";
import { migrateSqlite } from "../src/sqlite-migrate.js";
import { senderIsActiveSql, type CutlineSet } from "../src/screener-cutline.js";

/**
 * MAIL 0157 ON THE DEVICE STORE: the cutline probe reads a range of the sender-date index. This store
 * keeps no planner statistics (no ANALYZE runs on the phone), so only a window stated as its own
 * conjunct gives the planner a range; without a baseline there is none.
 */
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string, options?: { enableForeignKeyConstraints?: boolean }) => {
    exec(sql: string): void;
    prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown };
  };
};
type Db = InstanceType<typeof DatabaseSync>;

async function open(): Promise<Db> {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  await migrateSqlite({
    run: async (s: string) => { db.exec(s); },
    all: async <T,>(s: string) => db.prepare(s).all() as T[],
  }, SQLITE_JOURNAL);
  return db;
}

const DAY = 86_400_000;
const NOW = Date.now();

function seed(db: Db, account: string): void {
  const mb = randomUUID();
  db.prepare("insert into mailboxes (id, account_id, provider, address) values (?, ?, 'imap', ?)").run(mb, account, `${mb}@tf.test`);
  const msg = db.prepare(`insert into messages (id, account_id, mailbox_id, body_hash, dedup_key, from_address, date, created_at, unread)
    values (?, ?, ?, 'h', ?, ?, ?, ?, ?)`);
  const fs = db.prepare("insert into folder_state (message_id, desired_folder, observed_folder, last_set_by) values (?, ?, ?, 'us')");
  for (let s = 0; s < 50; s++) {
    for (let k = 0; k < 8; k++) {
      const id = randomUUID();
      const at = NOW - (k === 0 ? 400 : 420 + k) * DAY;
      msg.run(id, account, mb, `d:${id}`, `Quiet${s}@x.test`, at, at, 0);
      fs.run(id, k === 0 ? "ohmail/Screener" : "INBOX", k === 0 ? "ohmail/Screener" : "INBOX");
    }
  }
}

/** The plan of the probe asked of each of the account's messages, as SQLite states it. */
function probePlan(db: Db, account: string, set: CutlineSet): string[] {
  const probe = senderIsActiveSql(sqliteDialect(), account, sql`lower(m.from_address)`, set);
  const q = new SQLiteSyncDialect().sqlToQuery(sql`select m.id from messages m where m.account_id = ${account} and ${probe}`);
  return (db.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...q.params) as Array<{ detail: string }>).map((r) => r.detail);
}

const cutoff = new Date(NOW - 70 * DAY);
const RANGE = "SEARCH mc USING INDEX messages_account_sender_date_idx (account_id=? AND <expr>=? AND <expr>>?)";

describe("mail 0157 on the device store", () => {
  it("the store carries the index on the cutline's own key", async () => {
    const db = await open();
    const row = db.prepare("select sql from sqlite_master where type = 'index' and name = 'messages_account_sender_date_idx'").all() as Array<{ sql: string }>;
    expect(row).toHaveLength(1);
    expect(row[0]!.sql).toContain(`("account_id", lower("from_address"), coalesce("date", "created_at"))`);
  });

  it("with a baseline the probe searches a range of the index, with no statistics", async () => {
    const db = await open();
    const a = randomUUID();
    seed(db, a);
    expect(db.prepare("select name from sqlite_master where name = 'sqlite_stat1'").all()).toEqual([]);
    expect(probePlan(db, a, { cutoff, baselined: true, allTime: false })).toContain(RANGE);
  });

  it("CONTROL: without a baseline there is no range", async () => {
    const db = await open();
    const a = randomUUID();
    seed(db, a);
    const plan = probePlan(db, a, { cutoff, baselined: false, allTime: false });
    expect(plan.some((d) => /SEARCH mc /.test(d)), plan.join(" | ")).toBe(true);
    expect(plan.some((d) => d.includes("<expr>>?")), plan.join(" | ")).toBe(false);
  });
});
