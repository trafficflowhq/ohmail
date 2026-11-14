import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq, inArray, sql } from "drizzle-orm";
import { schema } from "../src/schema.js";
import { runMigrations } from "../src/migrate.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";
import { accounts, mailboxes, users } from "../src/schema-mail.js";
import { accountCounters, authThrottle } from "../src/schema-cloud.js";
import { counterAccount, counterHome } from "../src/account-counters.js";
import type { Tx } from "../src/change-log.js";

/**
 * A COUNTER WRITTEN THROUGH THE DOOR, ON A REAL POSTGRES (cloud 0101): the composite primary key
 * as the upsert's target, the key onto `accounts`, and two connections counting one key at once.
 */
const PG_UP = await realPgAvailable();
const HASH = randomUUID().replaceAll("-", "");

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;
const plantedAccounts: string[] = [];
const plantedKeys: string[] = [];

async function plant(): Promise<{ accountId: string; userId: string; mailboxId: string }> {
  const [acct] = await db.insert(accounts).values({ name: `counters-${randomUUID()}` }).returning();
  plantedAccounts.push(acct!.id);
  const [user] = await db.insert(users).values({ accountId: acct!.id, email: `c+${randomUUID()}@example.test` }).returning();
  const [mb] = await db.insert(mailboxes).values({ accountId: acct!.id, provider: "imap", address: `m+${randomUUID()}@example.test` }).returning();
  return { accountId: acct!.id, userId: user!.id, mailboxId: mb!.id };
}

/** One attempt, counted in the statement that decides, as the product's counters are. */
async function count(key: string, accountId?: string | null): Promise<number> {
  const home = counterHome(key, accountId);
  const [row] = await db.insert(home.table).values({ ...home.values, failures: 1 })
    .onConflictDoUpdate({ target: home.target, set: { failures: sql`${home.table.failures} + 1`, updatedAt: new Date() } })
    .returning({ failures: home.table.failures });
  return row!.failures;
}

beforeAll(async () => {
  if (!PG_UP) return;
  await runMigrations(PG_TEST_URL);
  client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
  db = drizzle(client, { schema });
}, 180_000);

afterAll(async () => {
  if (!PG_UP) return;
  if (plantedKeys.length > 0) await db.delete(authThrottle).where(inArray(authThrottle.key, plantedKeys));
  if (plantedAccounts.length > 0) {
    await db.delete(accountCounters).where(inArray(accountCounters.accountId, plantedAccounts));
    await db.delete(mailboxes).where(inArray(mailboxes.accountId, plantedAccounts));
    await db.delete(users).where(inArray(users.accountId, plantedAccounts));
    await db.delete(accounts).where(inArray(accounts.id, plantedAccounts));
  }
  await client.end({ timeout: 5 });
});

describe.skipIf(!PG_UP)("a counter's home on a real Postgres", () => {
  it("a key that names a row is one row of account_counters under that row's account", async () => {
    const a = await plant();
    const tx = db as unknown as Tx;
    for (const key of [`user:${a.userId}`, `imap:mailbox:${a.mailboxId}`, `probe-rate:a:60:${a.accountId}`]) {
      const account = await counterAccount(tx, key);
      expect(account, key).toBe(a.accountId);
      expect([await count(key, account), await count(key, account)]).toEqual([1, 2]);
      expect(await db.select({ accountId: accountCounters.accountId, failures: accountCounters.failures })
        .from(accountCounters).where(eq(accountCounters.key, key))).toEqual([{ accountId: a.accountId, failures: 2 }]);
      expect((await db.select().from(authThrottle).where(eq(authThrottle.key, key))).length, `${key} in auth_throttle`).toBe(0);
    }
  });

  it("a key that names nobody is one row of auth_throttle, whatever account is offered", async () => {
    const a = await plant();
    const key = `pwa:${HASH}`;
    plantedKeys.push(key);
    expect([await count(key), await count(key, a.accountId)]).toEqual([1, 2]);
    expect((await db.select().from(accountCounters).where(eq(accountCounters.key, key))).length).toBe(0);
  });

  it("two connections counting one key at once lose no attempt", async () => {
    const a = await plant();
    const key = `factor-day:${a.userId}`;
    const counted = await Promise.all(Array.from({ length: 8 }, () => count(key, a.accountId)));
    expect([...counted].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("refuses a counter under an account that does not exist, and keeps two accounts' counters apart", async () => {
    const a = await plant();
    const b = await plant();
    const key = `user:${a.userId}`;
    await expect(count(key, randomUUID())).rejects.toMatchObject({ code: "23503" });
    await count(key, a.accountId);
    // The door keys on the pair: an erasure of one account deletes by account_id and takes its own.
    await db.delete(accountCounters).where(eq(accountCounters.accountId, b.accountId));
    expect((await db.select().from(accountCounters)
      .where(and(eq(accountCounters.accountId, a.accountId), eq(accountCounters.key, key)))).length).toBe(1);
  });
});
