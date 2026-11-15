import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { runMigrations } from "../src/admin.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";
import { accounts, mailboxes, messages, folderState, changeLog } from "../src/index.js";
import { schema } from "../src/cloud.js";
import { brandDialect } from "../src/dialect/index.js";

/**
 * MIGRATION 0100 — mail adopted from a folder ohmail organizes is re-stamped `'peer'`, and the
 * three exclusions are what make it safe (`READER-WINDOW-ROWS-FROZEN-EXTERNAL`).
 *
 * A PRIVATE database, created and dropped by this file: the migration is a one-time data pass, so
 * it must run against a database whose `folder_state` this file alone seeded, and the shared
 * `trafficflow_test` accumulator is neither (its journal watermark also belongs to the release
 * chain). Real Postgres and not PGlite because the statement is an UPDATE … FROM with an anti-join
 * and a `timestamptz` literal comparison — the two things this repository has measured PGlite
 * agreeing with while real Postgres did not.
 *
 * The migration is applied BY HAND after the fixture is seeded: replaying the whole journal on a
 * fresh database runs 0100 against an empty table, which measures nothing.
 */
const AVAILABLE = await realPgAvailable();
const SQL_0100 = join(
  import.meta.dirname, "..", "..", "db-mail", "drizzle", "0100_reader_window_peer_restamp.sql",
);
/** Before the corrected writer shipped — the shape the backfill exists for. */
const OLD = new Date("2026-08-01T00:00:00.000Z");
/** After it — a row the corrected writer could have produced. */
const NEW = new Date("2026-09-20T00:00:00.000Z");

describe.skipIf(!AVAILABLE)("migration 0100 — the reader-window re-stamp", () => {
  const dbName = `trafficflow_rw_${randomUUID().slice(0, 8)}`;
  let url: string;
  let sql: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let accountId: string;
  let mailboxId: string;
  let seq = 0n;

  beforeAll(async () => {
    // The admin connection is the test URL with its database name swapped — one source for the
    // host, so a private database can never be created on a server this suite does not own.
    const adminUrl = new URL(PG_TEST_URL);
    adminUrl.pathname = "/postgres";
    const a = postgres(adminUrl.toString(), { connection: { statement_timeout: 0, lock_timeout: 0 }, max: 1, onnotice: () => {} });
    try {
      await a.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await a.unsafe(`CREATE DATABASE "${dbName}"`);
    } finally {
      await a.end({ timeout: 5 });
    }
    const own = new URL(PG_TEST_URL);
    own.pathname = `/${dbName}`;
    url = own.toString();
    await runMigrations(url);
    sql = postgres(url, { max: 2, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg");

    accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: "reader-window" });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `rw-${accountId.slice(0, 8)}@example.test`,
      status: "connected",
    }).returning();
    mailboxId = mb!.id;
  }, 180_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    const adminUrl = new URL(PG_TEST_URL);
    adminUrl.pathname = "/postgres";
    const a = postgres(adminUrl.toString(), { connection: { statement_timeout: 0, lock_timeout: 0 }, max: 1, onnotice: () => {} });
    // No statement timeout is set on this connection: a DROP interrupted by one leaves the
    // database INVALID (`pg_database.datconnlimit = -2`) and every later run fails on it.
    try { await a.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`); }
    finally { await a.end({ timeout: 5 }); }
  }, 60_000);

  /** One message plus its `folder_state` row, in the shape the case under test needs. */
  async function seedRow(opts: {
    tag: string; desired: string; observed: string; lastSetBy: string;
    createdAt: Date; userMoved?: boolean;
  }): Promise<string> {
    const [m] = await db.insert(messages).values({
      accountId, mailboxId,
      dedupKey: `mid:<${opts.tag}@example.test>`,
      messageIdHeader: `${opts.tag}@example.test`,
      fromAddress: "sender@example.test", subject: "s",
      bodyHash: `hash-${opts.tag}`,
      nativeLocator: { folder: opts.observed, ref: "1:10" },
      createdAt: opts.createdAt,
    }).returning();
    await db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: opts.desired, observedFolder: opts.observed,
      lastSetBy: opts.lastSetBy, reconcileStatus: "reconciled", conflict: false,
    });
    if (opts.userMoved) {
      await db.insert(changeLog).values({
        accountId, seq: ++seq, entityType: "message", entityId: m!.id, op: "move",
        meta: { from: "INBOX", to: opts.observed },
      });
    }
    return m!.id;
  }

  const stampOf = async (messageId: string): Promise<string> => {
    const [row] = await db.select().from(folderState).where(eq(folderState.messageId, messageId));
    return row!.lastSetBy;
  };

  it("re-stamps the frozen rows and touches none of the five shapes that must stand", async () => {
    // THE ARM: adopted from a folder ohmail organizes, pair agreed, no move of its own, old.
    const frozen = await seedRow({
      tag: "frozen", desired: "ohmail/Screener", observed: "ohmail/Screener",
      lastSetBy: "external", createdAt: OLD,
    });
    // THE PRE-0.22 SPELLING, AND IT STAYS. This drives the shipped 0100 against the data 0100
    // actually met: its folder set names `ohmail/Reads`, frozen like every applied migration's
    // text, so a fixture swept to the new name is a row the pass cannot see and an arm that
    // measures nothing. The rename's own censuses do not reach test files for this reason.
    const frozenReads = await seedRow({
      tag: "frozen-reads", desired: "ohmail/Reads", observed: "ohmail/Reads",
      lastSetBy: "external", createdAt: OLD,
    });
    // THE HARD STOP: this person moved this message themselves. The change log says so, and it
    // is never pruned.
    const handFiled = await seedRow({
      tag: "hand", desired: "ohmail/Screener", observed: "ohmail/Screener",
      lastSetBy: "external", createdAt: OLD, userMoved: true,
    });
    // Held while the decision about existing mail is open: it arrives where the server delivered
    // it, which is never inside the ohmail namespace.
    const importHold = await seedRow({
      tag: "hold", desired: "INBOX", observed: "INBOX",
      lastSetBy: "external", createdAt: OLD,
    });
    // A folder the person made — outside the namespace by construction.
    const customerFolder = await seedRow({
      tag: "custom", desired: "Family", observed: "Family",
      lastSetBy: "external", createdAt: OLD,
    });
    // A pending intent: the pair disagrees, so this is not a settled adoption at all.
    const pending = await seedRow({
      tag: "pending", desired: "ohmail/News", observed: "ohmail/Screener",
      lastSetBy: "external", createdAt: OLD,
    });
    // After the corrected writer: not this repair's business.
    const afterFix = await seedRow({
      tag: "after", desired: "ohmail/Screener", observed: "ohmail/Screener",
      lastSetBy: "external", createdAt: NEW,
    });
    // Our own placement — the passes already revisit it; the stamp must not change either way.
    const ours = await seedRow({
      tag: "ours", desired: "ohmail/Screener", observed: "ohmail/Screener",
      lastSetBy: "us", createdAt: OLD,
    });

    const notices: string[] = [];
    const run = postgres(url, { max: 1, onnotice: (n) => { notices.push(String(n.message ?? "")); } });
    try { await run.unsafe(readFileSync(SQL_0100, "utf8")); }
    finally { await run.end({ timeout: 5 }); }

    expect(await stampOf(frozen)).toBe("peer");
    expect(await stampOf(frozenReads)).toBe("peer");
    expect(await stampOf(handFiled)).toBe("external");
    expect(await stampOf(importHold)).toBe("external");
    expect(await stampOf(customerFolder)).toBe("external");
    expect(await stampOf(pending)).toBe("external");
    expect(await stampOf(afterFix)).toBe("external");
    expect(await stampOf(ours)).toBe("us");
    // COUNTED: the notice names how many rows it touched, which is the only report an operator
    // gets from a data pass.
    expect(notices.join(" ")).toContain("re-stamped from external to peer: 2");
  }, 120_000);

  it("is idempotent — a second pass touches nothing", async () => {
    const notices: string[] = [];
    const run = postgres(url, { max: 1, onnotice: (n) => { notices.push(String(n.message ?? "")); } });
    try { await run.unsafe(readFileSync(SQL_0100, "utf8")); }
    finally { await run.end({ timeout: 5 }); }
    expect(notices.join(" ")).toContain("re-stamped from external to peer: 0");
  }, 120_000);
});
