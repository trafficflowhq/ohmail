import { createRequire } from "node:module";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "@trafficflow/db/testing";
import { dialect } from "@trafficflow/db/dialect";
import { accounts, mailboxes, messageFailures } from "@trafficflow/db";
import { ACCOUNT_MAILBOXES_MAX_READ, type MailboxDTO } from "@trafficflow/services";
import {
  A, B, GOLDEN, MIN, at, cred, ctxFor, erasing, failure, filing, folder, gapReader, goldenAnswer, heldReader, id,
  inError, organizer, outstandingDrift, seed, seedPlain, settled, svc, theirFirst, theirSecond, theirThird, DAY, type Db,
} from "./helpers/mailbox-facts-seed.js";

/**
 * GET /mailboxes is polled every 30 s per open tab. Beside each row it reads four facts: the
 * set-aside count, the folders, the incoming credential's meta and the filing aggregate. Read per
 * mailbox, that was 1 + 4N statements; read for all of the account's mailboxes at once it is five,
 * whatever N is. The answer stays byte for byte what it was (the golden file was written by the
 * per-mailbox reads), and every statement that reads a fact binds the caller's account.
 * Counted at the store's own client, on both stores.
 */

interface Sent { text: string; params: readonly unknown[] }
interface Doors { query: (...a: unknown[]) => Promise<unknown>; exec: (...a: unknown[]) => Promise<unknown> }
type StatementDoor = "all" | "get" | "run";

/** Every statement the store is handed during `run`, with its parameters: PGlite's doors, or SQLite's prepare. */
async function measured<T>(db: Db, run: () => Promise<T>): Promise<{ value: T; sent: Sent[] }> {
  const sent: Sent[] = [];
  let restore: () => void;
  if (dialect(db).name === "sqlite") {
    const sqlite = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: { prototype: { prepare: (...a: unknown[]) => object } };
      StatementSync: { prototype: Record<StatementDoor, (...a: unknown[]) => unknown> };
    };
    const conn = sqlite.DatabaseSync.prototype;
    const stmt = sqlite.StatementSync.prototype;
    const prepare = conn.prepare;
    const doors = { all: stmt.all, get: stmt.get, run: stmt.run };
    const of = new WeakMap<object, Sent>();
    conn.prepare = function (this: unknown, ...a: unknown[]) {
      const statement = prepare.apply(this, a);
      const s: Sent = { text: String(a[0]), params: [] };
      sent.push(s);
      of.set(statement, s);
      return statement;
    };
    for (const door of ["all", "get", "run"] as const) {
      stmt[door] = function (this: object, ...p: unknown[]) {
        const s = of.get(this);
        if (s) s.params = p;
        return doors[door].apply(this, p);
      };
    }
    restore = () => { conn.prepare = prepare; Object.assign(stmt, doors); };
  } else {
    const client = (db as unknown as { $client: Doors }).$client;
    const doors = { query: client.query, exec: client.exec };
    client.query = (...a: unknown[]) => {
      sent.push({ text: String(a[0]), params: (a[1] as unknown[] | undefined) ?? [] });
      return doors.query.apply(client, a);
    };
    client.exec = (...a: unknown[]) => {
      sent.push({ text: String(a[0]), params: [] });
      return doors.exec.apply(client, a);
    };
    restore = () => { client.query = doors.query; client.exec = doors.exec; };
  }
  try {
    return { value: await run(), sent };
  } finally {
    restore();
  }
}

/** Each `"<table>"."account_id" = <placeholder>` in a statement, with the value bound to it. */
function accountBindings(s: Sent): Array<{ table: string; value: unknown }> {
  const out: Array<{ table: string; value: unknown }> = [];
  for (const m of s.text.matchAll(/"(\w+)"\."account_id" = (\$\d+|\?)/g)) {
    const ph = m[2]!;
    const index = ph === "?"
      ? (s.text.slice(0, m.index! + m[0].length - 1).match(/\?/g) ?? []).length
      : Number(ph.slice(1)) - 1;
    out.push({ table: m[1]!, value: s.params[index] });
  }
  return out;
}

const FACT_TABLES = /"(message_failures|mailbox_folders|mailbox_credentials|folder_state)"/;

describe("GET /mailboxes reads every mailbox's facts in a fixed number of statements", () => {
  it("costs the same statements for 1, 3 and 10 mailboxes, at most five", async () => {
    const db = await makeTestDb();
    const cost: number[] = [];
    for (const [i, n] of [1, 3, 10].entries()) {
      const acct = id(`c${i}`);
      await seedPlain(db, acct, n);
      const { value, sent } = await measured(db, () => svc.list(ctxFor(db, acct)));
      expect(value).toHaveLength(n);
      cost.push(sent.length);
    }
    expect(cost[0]).toBeLessThanOrEqual(5);
    expect(cost, "statements for 1, 3 and 10 mailboxes").toEqual([cost[0], cost[0], cost[0]]);
    // An account with no mailbox reads its list and nothing else.
    const empty = await measured(db, () => svc.list(ctxFor(db, id("e0"))));
    expect(empty.value).toEqual([]);
    expect(empty.sent).toHaveLength(1);
  });

  it("an account past one slice of ids gets every mailbox's facts, four statements a slice", async () => {
    const db = await makeTestDb();
    const acct = id("f0");
    await db.insert(accounts).values({ id: acct, name: "mfb-slices" });
    const ids = Array.from({ length: ACCOUNT_MAILBOXES_MAX_READ + 1 }, (_x, i) => id((0xf0000 + i).toString(16)));
    for (let from = 0; from < ids.length; from += 200) {
      const part = ids.slice(from, from + 200);
      await db.insert(mailboxes).values(part.map((mb) => ({
        id: mb, accountId: acct, provider: "imap", address: `${mb.slice(-5)}@example.test`, createdAt: at(-DAY),
      })));
      await db.insert(messageFailures).values(part.map((mb) => ({
        accountId: acct, mailboxId: mb, folder: "INBOX", uidvalidity: 1n, uid: 1, code: "mime_unparseable",
      })));
    }
    // The last mailbox is the second slice's only one.
    await folder(db, ids.at(-1)!, { folder: "INBOX", highestmodseq: 1n, serverExists: 4, updatedAt: at(-MIN) });

    const { value, sent } = await measured(db, () => svc.list(ctxFor(db, acct)));
    expect(value.map((m) => m.id)).toEqual(ids);
    expect(value.every((m) => m.setAside === 1), "a mailbox lost its set-aside count").toBe(true);
    expect(value.at(-1)!.serverMessageCount).toBe(4);
    expect(value.at(-1)!.folders?.map((f) => f.folder)).toEqual(["INBOX"]);
    // The list read, then four statements for each of the two slices.
    expect(sent).toHaveLength(1 + 4 * 2);
  }, 60_000);

  it("one mailbox's read is still five statements: its row and its four facts", async () => {
    const db = await makeTestDb();
    await seed(db);
    const { sent } = await measured(db, () => svc.get(ctxFor(db, A), organizer));
    expect(sent).toHaveLength(5);
  });

  it("answers byte for byte what the per-mailbox reads answered", async () => {
    const db = await makeTestDb();
    await seed(db);
    const list = await svc.list(ctxFor(db, A));
    await expect(await goldenAnswer(db)).toMatchFileSnapshot(GOLDEN);
    // A single mailbox's read answers what the list says about it.
    for (const row of list) expect(await svc.get(ctxFor(db, A), row.id)).toEqual(row);
    // Every outstanding filing the seed wrote carries its message's account (mail 0159).
    expect(await outstandingDrift(db)).toBe(0);
  });

  it("counts the filings mail 0159's trigger keeps, and only those", async () => {
    const db = await makeTestDb();
    const acct = id("90");
    const mb = id("91");
    await db.insert(accounts).values({ id: acct, name: "mfb-trigger" });
    await db.insert(mailboxes).values({ id: mb, accountId: acct, provider: "imap", address: "t@example.test" });
    for (let i = 0; i < 4; i++) await filing(db, acct, mb, { updatedAt: at(-MIN) });
    expect((await svc.list(ctxFor(db, acct)))[0]!.pendingMoves).toBe(4);
    // Control: with the trigger withheld a new filing carries no account and the strip misses it.
    if (dialect(db).name === "sqlite") {
      await db.run(sql`drop trigger folder_state_outstanding_account_insert`);
      await db.run(sql`drop trigger folder_state_outstanding_account_update`);
    } else {
      await db.execute(sql`drop trigger folder_state_outstanding_account_tg on folder_state`);
    }
    await filing(db, acct, mb, { updatedAt: at(-MIN) });
    expect(await outstandingDrift(db)).toBe(1);
    expect((await svc.list(ctxFor(db, acct)))[0]!.pendingMoves).toBe(4);
  });

  it("projects the Sent folder the attach recorded: the column's value, null when NULL", async () => {
    const db = await makeTestDb();
    const acct = id("c0");
    await db.insert(accounts).values({ id: acct, name: "mfb-sent" });
    await db.insert(mailboxes).values([
      { id: id("c1"), accountId: acct, provider: "imap", address: "c1@example.test", sentFolder: "Envoyés" },
      { id: id("c2"), accountId: acct, provider: "imap", address: "c2@example.test" },
    ]);
    const rows = await svc.list(ctxFor(db, acct));
    expect(rows.map((r) => [r.id, r.sentFolder])).toEqual([[id("c1"), "Envoyés"], [id("c2"), null]]);
  });

  it("takes the counts and `asOf` at one reading of the clock", async () => {
    const db = await makeTestDb();
    const acct = id("d0");
    await db.insert(accounts).values({ id: acct, name: "mfb-clock" });
    for (const mb of [id("d1"), id("d2")]) {
      await db.insert(mailboxes).values({ id: mb, accountId: acct, provider: "imap", address: `${mb.slice(-2)}@example.test` });
      await filing(db, acct, mb, {
        updatedAt: at(-MIN), attempts: 1, nextAttemptAt: at(5_000), lastErrorClass: "refused",
      });
    }
    // Each reading of this clock is ten seconds after the last; the deferral is due five seconds in.
    let readings = 0;
    const rows = await svc.list(ctxFor(db, acct, () => at(10_000 * readings++)));
    const deferred = rows.filter((r) => r.filing!.deferred > 0);
    expect(deferred.length).toBeGreaterThan(0);
    for (const r of deferred) {
      expect(Date.parse(r.filing!.nextAttemptAt!), "a deferral already past at its own asOf")
        .toBeGreaterThan(Date.parse(r.filing!.asOf));
    }
  });

  it("another account's facts never reach this account's answer", async () => {
    const db = await makeTestDb();
    await seed(db);
    const before = await svc.list(ctxFor(db, A));
    expect(before.map((m) => m.id)).toEqual([organizer, inError, heldReader, erasing, gapReader, settled]);

    for (const mb of [theirFirst, theirSecond, theirThird]) {
      await failure(db, B, mb, 7, false);
      await folder(db, mb, { folder: "Aaa", highestmodseq: 1n, serverExists: 5, updatedAt: at(-MIN) });
      await filing(db, B, mb, { updatedAt: at(-DAY), attempts: 9, nextAttemptAt: at(DAY), lastErrorClass: "over_quota" });
      await cred(db, mb, "smtp", { host: "smtp.gmail.com", smtpUnsettled: "auth" });
    }
    expect(JSON.stringify(await svc.list(ctxFor(db, A)))).toBe(JSON.stringify(before));

    // A fact of A's own moves A's answer, by exactly that fact.
    await failure(db, A, organizer, 9, false);
    const after = await svc.list(ctxFor(db, A));
    expect(before[0]!.setAside).toBe(2);
    expect(after[0]!.setAside).toBe(3);
    const without = (rows: MailboxDTO[]) => rows.map((r, i) => (i === 0 ? { ...r, setAside: 0 } : r));
    expect(without(after)).toEqual(without(before));
  });

  it("every statement that reads a fact binds the caller's account and reads no secret", async () => {
    const db = await makeTestDb();
    await seed(db);
    const { sent } = await measured(db, () => svc.list(ctxFor(db, A)));
    const facts = sent.filter((s) => FACT_TABLES.test(s.text));
    expect(facts.length).toBeGreaterThan(0);
    for (const s of facts) {
      expect(s.text).not.toContain("secret_enc");
      const bound = accountBindings(s);
      expect(bound.some((b) => b.table === "mailboxes"), s.text).toBe(true);
      for (const b of bound) expect(b.value, s.text).toBe(A);
    }
  });
});
