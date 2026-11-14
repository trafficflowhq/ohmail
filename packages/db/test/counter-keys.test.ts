import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { eq, sql } from "drizzle-orm";
import {
  COUNTER_KEY_FAMILIES, COUNTER_PREFIXES_THAT_LEFT, carriesAnAddress, familyOf, parentIdOf,
} from "../src/counter-keys.js";
import { CounterKeyRefused, counterAccount, counterHome, namesARow } from "../src/account-counters.js";
import { recordImapRefusal, spendProbeBudget } from "../src/imap-admission.js";
import { COUNTER_SAMPLES as SAMPLES, HASH, type SampleIds as Ids } from "./_counter-samples.js";
import { CLOUD_JOURNAL } from "../src/journal-specs.js";
import { readJournalOf } from "../src/baseline.js";
import { accounts, mailboxes, users } from "../src/schema-mail.js";
import { accountCounters, authThrottle } from "../src/schema-cloud.js";
import { makeTestDb } from "../src/testing.js";
import type { Tx } from "../src/change-log.js";

/**
 * EVERY COUNTER KEY IS OF ONE REGISTERED FAMILY, AND THE FAMILY SAYS WHICH TABLE HOLDS IT (cloud
 * 0101). One sample per family, written the way its builder writes it; the registry, the entry
 * that split the table and the door are each asked about the same samples.
 */
async function world() {
  const db = await makeTestDb();
  const [acct] = await db.insert(accounts).values({ name: "counters" }).returning();
  const [user] = await db.insert(users).values({ accountId: acct!.id, email: `c-${acct!.id}@example.test` }).returning();
  const [mb] = await db.insert(mailboxes).values({ accountId: acct!.id, provider: "imap", address: `m-${acct!.id}@example.test` }).returning();
  return { db, ids: { userId: user!.id, mailboxId: mb!.id, accountId: acct!.id } satisfies Ids };
}

const GONE: Ids = { userId: randomUUID(), mailboxId: randomUUID(), accountId: randomUUID() };

describe("the registry of counter key families", () => {
  it("every family has its sample, and the sample is of that family and fits its shape", () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(COUNTER_KEY_FAMILIES.map((f) => f.prefix).sort());
    for (const f of COUNTER_KEY_FAMILIES) {
      const key = SAMPLES[f.prefix]!(GONE);
      expect(familyOf(key)?.prefix, key).toBe(f.prefix);
      expect(f.shape.test(key), `${f.prefix} does not admit its own sample`).toBe(true);
      // No other family's shape admits it: a key has one home.
      expect(COUNTER_KEY_FAMILIES.filter((o) => o.shape.test(key)).map((o) => o.prefix)).toEqual([f.prefix]);
    }
  });

  it("a moving family names its parent, and the parent's id is the key's end", () => {
    for (const f of COUNTER_KEY_FAMILIES) {
      const key = SAMPLES[f.prefix]!(GONE);
      if (f.class !== "moves") { expect(f.parent).toBeUndefined(); expect(parentIdOf(key)).toBeNull(); continue; }
      expect(parentIdOf(key)).toBe(f.parent === "user" ? GONE.userId : f.parent === "mailbox" ? GONE.mailboxId : GONE.accountId);
    }
  });

  it("a key nobody classed has no family, and neither has one that only resembles a prefix", () => {
    expect(familyOf("tidy:everything")).toBeNull();
    expect(familyOf("users:1")).toBeNull();
    expect(familyOf(`imap:${HASH}`)).toBeNull();
    // The longest prefix decides: a probe's slot is not a mailbox's.
    expect(familyOf(`imap:mailbox:probe:${HASH}:${GONE.accountId}`)?.parent).toBe("account");
    expect(carriesAnAddress("email:someone@example.test")).toBe(true);
    expect(COUNTER_KEY_FAMILIES.some((f) => carriesAnAddress(SAMPLES[f.prefix]!(GONE)))).toBe(false);
  });

  it("the keys this package's own counters write are each of a family", async () => {
    const { db, ids } = await world();
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(await spendProbeBudget(db as unknown as Tx, { accountId: ids.accountId, target: HASH, now })).toBeNull();
    await recordImapRefusal(db as unknown as Tx, now);
    const written = (await db.select({ key: authThrottle.key }).from(authThrottle)).map((r) => r.key);
    expect(written.length).toBeGreaterThanOrEqual(5);
    for (const key of written) expect(familyOf(key)?.shape.test(key), key).toBe(true);
  });
});

describe("cloud 0101 splits the table by the registry", () => {
  /** The entry's statements after its CREATE TABLE: the moves and the two deletes, as the journal runs them. */
  function splitStatements(): string[] {
    const entry = readJournalOf(CLOUD_JOURNAL).find((e) => e.tag === "0101_account_counters")!;
    const file = readMigrationFiles({ migrationsFolder: CLOUD_JOURNAL.dir }).find((m) => m.folderMillis === entry.when)!;
    return file.sql.slice(1);
  }

  it("moves what names a living row under its account, keeps what names nobody, deletes the rest", async () => {
    const { db, ids } = await world();
    const until = new Date("2026-03-01T00:00:00.000Z");
    const began = new Date("2026-02-28T00:00:00.000Z");
    const plant = async (key: string): Promise<void> => {
      await db.insert(authThrottle).values({ key, failures: 3, lockedUntil: until, windowStartedAt: began, updatedAt: began });
    };
    for (const f of COUNTER_KEY_FAMILIES) await plant(SAMPLES[f.prefix]!(ids));
    // A counter whose row is gone, a key of a leaving prefix that fits no shape, the form with an
    // address in it, and the account-wide probe budget (the second shape of its family).
    const orphan = `user:${GONE.userId}`;
    const misshapen = "factor-day:not-an-id";
    const legacy = "email:someone@example.test";
    const budget = `probe-rate:a:3600:${ids.accountId}`;
    for (const key of [orphan, misshapen, legacy, budget]) await plant(key);

    for (const statement of splitStatements()) await db.execute(sql.raw(statement));

    const stayed = new Set((await db.select({ key: authThrottle.key }).from(authThrottle)).map((r) => r.key));
    const moved = new Map((await db.select().from(accountCounters)).map((r) => [r.key, r]));
    for (const f of COUNTER_KEY_FAMILIES) {
      const key = SAMPLES[f.prefix]!(ids);
      expect(stayed.has(key), `${f.prefix} in auth_throttle`).toBe(f.class === "stays");
      expect(moved.has(key), `${f.prefix} in account_counters`).toBe(f.class === "moves");
      if (f.class !== "moves") continue;
      // Under the account of the row it names, with its numbers as they stood.
      expect(moved.get(key)).toMatchObject({ accountId: ids.accountId, failures: 3, lockedUntil: until, windowStartedAt: began });
    }
    expect(moved.get(budget)?.accountId).toBe(ids.accountId);
    for (const key of [orphan, misshapen, legacy]) {
      expect(stayed.has(key), key).toBe(false);
      expect(moved.has(key), key).toBe(false);
    }
    // What is left names no row: no id and no address in any key.
    for (const key of stayed) expect(key).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-|@/);
    expect(COUNTER_PREFIXES_THAT_LEFT.filter((p) => [...stayed].some((k) => k.startsWith(p)))).toEqual([]);
  });
});

describe("the door to a counter's home", () => {
  it("sends a key to the table its family names, and asks a key that names a row for its account", () => {
    for (const f of COUNTER_KEY_FAMILIES) {
      const key = SAMPLES[f.prefix]!(GONE);
      expect(namesARow(key)).toBe(f.class === "moves");
      if (f.class === "moves") {
        expect(() => counterHome(key)).toThrow(CounterKeyRefused);
        const home = counterHome(key, GONE.accountId);
        expect(home.table).toBe(accountCounters);
        expect(home.values).toEqual({ accountId: GONE.accountId, key });
      } else {
        // An account offered for a key that names nobody changes nothing.
        expect(counterHome(key, GONE.accountId).table).toBe(authThrottle);
        expect(counterHome(key).values).toEqual({ key });
      }
    }
  });

  it("refuses a key of no family, one that does not fit its family, and one with an address, by reason", () => {
    const reason = (key: string, account?: string): string => {
      try { counterHome(key, account); return "admitted"; } catch (err) { return (err as CounterKeyRefused).reason; }
    };
    expect(reason("tidy:everything", GONE.accountId)).toBe("no_family");
    expect(reason("user:not-an-id", GONE.accountId)).toBe("shape");
    expect(reason(`pw:${HASH}`)).toBe("shape");
    expect(reason("email:someone@example.test")).toBe("address");
    expect(reason(`user:${GONE.userId}`)).toBe("no_account");
    // The refusal never repeats the key: it may be what a person typed.
    try { counterHome("email:someone@example.test"); } catch (err) { expect((err as Error).message).not.toContain("someone"); }
  });

  it("reads the account from the row a key names, and none when that row is gone", async () => {
    const { db, ids } = await world();
    const tx = db as unknown as Tx;
    for (const f of COUNTER_KEY_FAMILIES) {
      const key = SAMPLES[f.prefix]!(ids);
      expect(await counterAccount(tx, key), f.prefix).toBe(f.class === "moves" ? ids.accountId : null);
    }
    expect(await counterAccount(tx, `user:${GONE.userId}`)).toBeNull();
    expect(await counterAccount(tx, `imap:mailbox:${GONE.mailboxId}`)).toBeNull();
  });

  it("a counter written through its home is one row, counted again by the same statement", async () => {
    const { db, ids } = await world();
    const bump = async (key: string): Promise<number> => {
      const home = counterHome(key, await counterAccount(db as unknown as Tx, key));
      const [row] = await db.insert(home.table).values({ ...home.values, failures: 1 })
        .onConflictDoUpdate({ target: home.target, set: { failures: sql`${home.table.failures} + 1` } })
        .returning({ failures: home.table.failures });
      return row!.failures;
    };
    const named = `user:${ids.userId}`;
    const hashed = `pwa:${HASH}`;
    expect([await bump(named), await bump(named), await bump(hashed)]).toEqual([1, 2, 1]);
    expect(await db.select({ key: accountCounters.key, accountId: accountCounters.accountId }).from(accountCounters))
      .toEqual([{ key: named, accountId: ids.accountId }]);
    expect((await db.select({ key: authThrottle.key }).from(authThrottle).where(eq(authThrottle.key, hashed))).length).toBe(1);
    expect((await db.select().from(authThrottle).where(eq(authThrottle.key, named))).length).toBe(0);
  });
});
