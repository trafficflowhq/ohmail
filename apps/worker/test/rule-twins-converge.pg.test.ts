import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq } from "drizzle-orm";
import { carryDialect } from "@trafficflow/db/dialect";
import { schema, makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  ACCOUNT_RULE_KEY_LOCK_CLASS, accounts, applyScreenerDecision, mailboxes, rules, type Tx,
} from "@trafficflow/db";
import { RulesService, type RuleCreation, type RuleMutation, type ServiceContext, dbFor } from "@trafficflow/services";

/**
 * EVERY DOOR THAT CONVERGES A KEY WAITS ON ONE LOCK, ON A REAL SERVER (PGlite runs one connection
 * and cannot interleave two transactions). Connection C holds the account's rule-key lock; a PATCH
 * and a create under one key, then a Screener decision and a create, must both wait behind it and
 * end as ONE row with neither failing — an update that deleted the twin a create was reconciling
 * answered that create "rule vanished". Another account is not serialised by it.
 */
const PG_UP = await realPgAvailable();
const ADDR = "lena@atelier.example";
const svc = new RulesService();

let ownedA: OwnedDb;
let ownedB: OwnedDb;
let c: ReturnType<typeof postgres>;
let dbA: OwnedDb["db"];
let dbB: OwnedDb["db"];
let dbC: ReturnType<typeof drizzle<typeof schema>>;

async function account(): Promise<string> {
  const accountId = randomUUID();
  await dbA.insert(accounts).values({ id: accountId, name: `twins-${accountId.slice(0, 8)}` });
  await dbA.insert(mailboxes).values({ accountId, provider: "imap", address: `own-${accountId.slice(0, 8)}@mailbox.example` });
  return accountId;
}
/** The twins: a manual Ohbox row and a promoted Screened row (the acting one). */
async function twins(accountId: string): Promise<{ allow: string; deny: string }> {
  const row = { accountId, kind: "sender", match: ADDR, priority: 0, enabled: true };
  const [allow, deny] = await dbA.insert(rules).values([
    { ...row, destination: "INBOX", provenance: "manual" },
    { ...row, destination: "ohmail/Screened", provenance: "promoted" },
  ]).returning({ id: rules.id });
  return { allow: allow!.id, deny: deny!.id };
}
const ctxOn = (db: typeof dbA, accountId: string): ServiceContext =>
  ({ db: dbFor(db, accountId), accountId, userId: null, requestId: "r", now: () => new Date() }) as unknown as ServiceContext;
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

/** Run two writers behind the held lock: neither may finish while it is held, both must after. */
async function behindTheLock<A, B>(accountId: string, first: () => Promise<A>, second: () => Promise<B>) {
  const lock = holdLock(accountId);
  await lock.hasLock;
  let finished = 0;
  const pair = Promise.allSettled([first().finally(() => { finished++; }), second().finally(() => { finished++; })]);
  try {
    await sleep(200);
    expect(finished, "a writer ran past the account's rule-key lock").toBe(0);
    expect(await rowsOf(accountId)).toHaveLength(2);
  } finally {
    lock.release();
    await lock.done;
  }
  return pair;
}

describe.skipIf(!PG_UP)("every converging door on a real server", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    ownedA = makeOwnedDb(PG_TEST_URL);
    ownedB = makeOwnedDb(PG_TEST_URL);
    c = postgres(PG_TEST_URL, { max: 2, onnotice: () => {} });
    dbA = ownedA.db;
    dbB = ownedB.db;
    dbC = brandDialect(drizzle(c, { schema }), "pg");
  }, 120_000);
  afterAll(async () => {
    await ownedA?.close(); await ownedB?.close(); await c?.end({ timeout: 5 });
  });

  it("a PATCH and a create under one key wait on the lock and leave one rule, neither failing", async () => {
    const accountId = await account();
    const { deny } = await twins(accountId);
    const [patched, created] = await behindTheLock(accountId,
      () => svc.update(ctxOn(dbA, accountId), deny, { destination: "ohmail/News" }) as Promise<RuleMutation>,
      () => svc.create(ctxOn(dbB, accountId), { kind: "sender", match: ADDR, destination: "INBOX" }) as Promise<RuleCreation>,
    );
    expect([patched.status, created.status], JSON.stringify([patched, created].map((p) => p.status === "rejected" ? String(p.reason) : "ok")))
      .toEqual(["fulfilled", "fulfilled"]);
    expect(await rowsOf(accountId)).toHaveLength(1);
  }, 60_000);

  it("a Screener decision and a create under one key wait on the lock and leave one rule", async () => {
    const accountId = await account();
    await twins(accountId);
    const decide = () => (dbA as unknown as Tx).transaction((tx) => applyScreenerDecision(carryDialect(dbA, tx), {
      accountId, scope: "sender", address: ADDR, appliedFolder: "ohmail/News", decision: "yes",
      triggeringActionId: `screener:${randomUUID()}`, now: new Date(), decidedBy: "person", overExisting: "converge",
    }));
    const [decided, created] = await behindTheLock(accountId, decide,
      () => svc.create(ctxOn(dbB, accountId), { kind: "sender", match: ADDR, destination: "INBOX" }) as Promise<RuleCreation>);
    expect([decided.status, created.status]).toEqual(["fulfilled", "fulfilled"]);
    expect(await rowsOf(accountId)).toHaveLength(1);
  }, 60_000);

  it("CONTROL: another account's PATCH is not held by this account's lock", async () => {
    const held = await account();
    const other = await account();
    const { deny } = await twins(other);
    const lock = holdLock(held);
    await lock.hasLock;
    try {
      const out = await Promise.race([
        svc.update(ctxOn(dbA, other), deny, { destination: "ohmail/News" }) as Promise<RuleMutation>,
        sleep(5_000).then(() => null),
      ]);
      expect(out?.rule.destination, "another account waited on this account's lock").toBe("ohmail/News");
      expect(await rowsOf(other)).toHaveLength(1);
    } finally {
      lock.release();
      await lock.done;
    }
  }, 60_000);
});
