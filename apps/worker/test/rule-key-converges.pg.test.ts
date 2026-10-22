import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq } from "drizzle-orm";
import { brandDialect } from "@trafficflow/db/dialect";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  ACCOUNT_RULE_KEY_LOCK_CLASS, accounts, mailboxes, organizerRequests, rules, settleReaderRuleRows, type Tx,
} from "@trafficflow/db";
import { RulesService, type RuleCreation, type ServiceContext } from "@trafficflow/services";

/**
 * ONE RULE PER KEY UNDER CONCURRENCY, AND ONE PRESS'S LEGS ON A REAL SERVER (PGlite runs one
 * connection and cannot interleave two transactions, and it binds a `Date` its own way).
 * The held-lock arm holds the account's rule-key lock in a third connection: two creates under
 * different idempotency keys must both wait behind it and then make one row between them. Another
 * account is not serialised by it. The press arm reads two legs of one press by their `decidedAt`.
 */
const PG_UP = await realPgAvailable();
const t0 = new Date("2026-10-03T08:00:00.000Z");
const at = (m: number): Date => new Date(t0.getTime() + m * 60_000);
const ACME = { kind: "domain", match: "acme.example", destination: "ohmail/News" };
const svc = new RulesService();

let a: ReturnType<typeof postgres>;
let b: ReturnType<typeof postgres>;
let c: ReturnType<typeof postgres>;
let dbA: ReturnType<typeof drizzle<typeof schema>>;
let dbB: ReturnType<typeof drizzle<typeof schema>>;
let dbC: ReturnType<typeof drizzle<typeof schema>>;

async function account(): Promise<string> {
  const accountId = randomUUID();
  await dbA.insert(accounts).values({ id: accountId, name: `rulekey-${accountId.slice(0, 8)}` });
  await dbA.insert(mailboxes).values({ accountId, provider: "imap", address: `own-${accountId.slice(0, 8)}@mailbox.example` });
  return accountId;
}
const ctxOn = (db: typeof dbA, accountId: string): ServiceContext =>
  ({ db, accountId, userId: null, requestId: "r", now: () => new Date() }) as unknown as ServiceContext;
const rowsOf = async (accountId: string) => dbC.select().from(rules).where(eq(rules.accountId, accountId));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Hold the account's rule-key lock in connection C until `release()`. */
function holdLock(accountId: string) {
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  let locked!: () => void;
  const hasLock = new Promise<void>((r) => { locked = r; });
  const done = c.begin(async (sql) => {
    await sql`select pg_advisory_xact_lock(${ACCOUNT_RULE_KEY_LOCK_CLASS}, hashtext(${accountId}))`;
    locked();
    await held;
  });
  return { hasLock, release, done };
}

describe.skipIf(!PG_UP)("the rule key on a real server", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    a = postgres(PG_TEST_URL, { max: 2, onnotice: () => {} });
    b = postgres(PG_TEST_URL, { max: 2, onnotice: () => {} });
    c = postgres(PG_TEST_URL, { max: 2, onnotice: () => {} });
    dbA = brandDialect(drizzle(a, { schema }), "pg");
    dbB = brandDialect(drizzle(b, { schema }), "pg");
    dbC = brandDialect(drizzle(c, { schema }), "pg");
  }, 120_000);
  afterAll(async () => {
    await a?.end({ timeout: 5 }); await b?.end({ timeout: 5 }); await c?.end({ timeout: 5 });
  });

  it("two creates under two idempotency keys wait on the account's lock and make one rule", async () => {
    const accountId = await account();
    const lock = holdLock(accountId);
    await lock.hasLock;
    let finished = 0;
    const one = (db: typeof dbA, key: string) => (svc.create(ctxOn(db, accountId), ACME as never,
      { idempotency: { key, requestHash: `h-${key}` } }) as Promise<RuleCreation>).finally(() => { finished++; });
    const pair = Promise.all([one(dbA, `k1-${accountId}`), one(dbB, `k2-${accountId}`)]);
    try {
      await sleep(200);
      expect(finished, "a create ran past the account's rule-key lock").toBe(0);
      expect(await rowsOf(accountId)).toHaveLength(0);
    } finally {
      // Released on a red too, or the next case waits on a lock this one still holds.
      lock.release();
      await lock.done;
    }
    const [x, y] = await pair;
    expect([x.created, y.created].sort()).toEqual([false, true]);
    expect(y.rule.id).toBe(x.rule.id);
    expect(await rowsOf(accountId)).toHaveLength(1);
  }, 60_000);

  it("CONTROL: another account's create is not held by this account's lock", async () => {
    const held = await account();
    const other = await account();
    const lock = holdLock(held);
    await lock.hasLock;
    try {
      const out = await Promise.race([
        svc.create(ctxOn(dbA, other), ACME as never) as Promise<RuleCreation>,
        sleep(5_000).then(() => null),
      ]);
      expect(out?.created, "another account waited on this account's lock").toBe(true);
      expect(await rowsOf(other)).toHaveLength(1);
      expect(await rowsOf(held)).toHaveLength(0);
    } finally {
      lock.release();
      await lock.done;
    }
  }, 60_000);

  it("a two-leg press settles only when its second leg is applied", async () => {
    const accountId = await account();
    await dbA.insert(rules).values({
      accountId, kind: "sender", match: "ann@shop.example", destination: "ohmail/News", priority: 0,
      enabled: true, provenance: "manual", updatedAt: at(0),
    });
    const payload = { key: { kind: "sender", match: "ann@shop.example", subjectContains: null, bodyContains: null } };
    const [leg0, leg1] = [randomUUID(), randomUUID()];
    for (const [id, state] of [[leg0, "applied"], [leg1, "sent"]] as const) {
      const [mb] = await dbA.insert(mailboxes).values({ accountId, provider: "imap", address: `held-${id.slice(0, 8)}@mailbox.example` }).returning({ id: mailboxes.id });
      await dbA.insert(organizerRequests).values({ id, accountId, mailboxId: mb!.id, kind: "rule.delete", payload, decidedAt: at(1), state });
    }
    const settle = () => (dbA as unknown as Tx).transaction((tx) =>
      settleReaderRuleRows(tx, accountId, { kind: "rule.delete", payload, decidedAt: at(1) }));
    expect(await settle()).toEqual({ settled: false, skipped: "press_unfinished" });
    expect(await rowsOf(accountId)).toHaveLength(1);
    await dbA.update(organizerRequests).set({ state: "applied" })
      .where(and(eq(organizerRequests.id, leg1), eq(organizerRequests.accountId, accountId)));
    expect(await settle()).toEqual({ settled: true, lastSeq: expect.any(BigInt) });
    expect(await rowsOf(accountId)).toHaveLength(0);
  }, 60_000);
});
