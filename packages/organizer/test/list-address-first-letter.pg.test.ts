import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq } from "drizzle-orm";
import { brandDialect } from "@trafficflow/db/dialect";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  accounts, accountSettings, contacts, folderState, listAddresses, listBrandsOf, mailboxes, messages, type Tx,
} from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { runSyncCycle } from "../src/sync.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * THE LETTER THAT REVEALS A LIST ADDRESS, ON REAL POSTGRES (R32-01), the worker's own store, through a
 * sync cycle. `list@` is the person's contact (their post made it) and nothing has named it a list:
 * the first company claim through it names the address in its own `List-Post`, waits and records the
 * row, and the second as before; a list address the person never wrote to waits. This file's own
 * accounts only, removed afterwards.
 */
const PG_UP = await realPgAvailable();
const LIST = "list@lists.invalid";
const OTHER = "other@lists.invalid";

const revealing = (id: string, brand: string, from: string): Buffer => Buffer.from([
  `Message-ID: <${id}>`, `From: "${brand}" <${from}>`, "To: me@own.invalid", "Subject: Ihre Karte",
  `List-Post: <mailto:${from}>`, "List-Id: The Lists <lists.lists.invalid>",
  "Content-Type: text/plain; charset=utf-8", "", "See you there.",
].join("\r\n"));

describe.skipIf(!PG_UP)("the first claim through a list address the person wrote to (Postgres)", () => {
  let sql: ReturnType<typeof postgres>;
  let db: Tx;
  const made: string[] = [];

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    sql = postgres(PG_TEST_URL, { max: 3, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg") as unknown as Tx;
  }, 180_000);

  // Every row this file wrote, by its accounts: tables are retried until the foreign keys allow it.
  afterAll(async () => {
    if (sql && made.length > 0) {
      const tables = await sql<{ t: string }[]>`select table_name as t from information_schema.columns
        where table_schema = 'public' and column_name = 'account_id' group by table_name`;
      let left = tables.map((r) => r.t);
      for (let pass = 0; pass < 8 && left.length > 0; pass++) {
        const next: string[] = [];
        for (const t of left) {
          try { await sql.unsafe(`delete from "${t}" where account_id = any($1::uuid[])`, [made]); }
          catch { next.push(t); }
        }
        left = next;
      }
      await sql`delete from accounts where id = any(${made}::uuid[])`.catch(() => {});
    }
    await sql?.end({ timeout: 5 });
  });

  async function world() {
    const accountId = randomUUID();
    made.push(accountId);
    await db.insert(accounts).values({ id: accountId, name: `lfl-${accountId.slice(0, 8)}` });
    await db.insert(accountSettings).values({ accountId, screeningScope: "all_time" });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `me-${accountId.slice(0, 8)}@own.invalid`, status: "connected",
    }).returning();
    await db.insert(contacts).values({ accountId, address: LIST, source: "person" });
    const fleet = new FakeAdapterFleet();
    const adapter = fleet.factory(
      { host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
      { accountId, mailboxId: mb!.id, onConnectionError: () => { /* nothing dials here */ } },
    );
    const queue: Array<{ from: string; subject: string; messageId: string; raw: Buffer }> = [];
    const deliver = async (messageId: string, raw: Buffer) => {
      queue.push({ from: "-", subject: "-", messageId, raw });
      fleet.behave(mb!.id, { deliver: [...queue] });
      await runSyncCycle({
        writeAuthority: FIXTURE_LEASE, repo: makeDrizzleRepo(db as never), adapter, accountId, mailboxId: mb!.id,
        storageCap: UNMETERED_STORAGE_CAP, role: "organizer", trustedAuthservIds: new Set<string>(),
      });
      const [row] = await db.select({ desired: folderState.desiredFolder, check: messages.senderCheck })
        .from(messages).innerJoin(folderState, eq(folderState.messageId, messages.id))
        .where(and(eq(messages.accountId, accountId), eq(messages.messageIdHeader, messageId)));
      return row!;
    };
    const listRow = async (address: string) => {
      const [r] = await db.select({ brands: listAddresses.consentedBrands }).from(listAddresses)
        .where(and(eq(listAddresses.accountId, accountId), eq(listAddresses.address, address)));
      return r === undefined ? null : listBrandsOf(r.brands);
    };
    return { deliver, listRow };
  }

  it("R32-01: the first is held and marked, its address recorded; the second as before", async () => {
    const w = await world();
    const first = await w.deliver("pg-rev-1@lists.invalid", revealing("pg-rev-1@lists.invalid", "PostFinance", LIST));
    expect(first.desired, "the letter naming its own list address was judged as a person's").toBe("ohmail/Screener");
    expect(first.check).toBe("impersonation");
    expect(await w.listRow(LIST)).toEqual([]);
    const second = await w.deliver("pg-rev-2@lists.invalid", revealing("pg-rev-2@lists.invalid", "PostFinance", LIST));
    expect(second.desired).toBe("ohmail/Screener");
  }, 60_000);

  it("CONTROL: a list address the person never wrote to is held", async () => {
    const w = await world();
    const other = await w.deliver("pg-rev-3@lists.invalid", revealing("pg-rev-3@lists.invalid", "PostFinance", OTHER));
    expect(other.desired).toBe("ohmail/Screener");
    expect(await w.listRow(OTHER)).toEqual([]);
  }, 60_000);
});
