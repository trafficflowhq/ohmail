import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq } from "drizzle-orm";
import { brandDialect } from "@trafficflow/db/dialect";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { accounts, mailboxes, organizerRequests, rules, settleReaderRuleRows, type Tx } from "@trafficflow/db";

/**
 * THE BELT'S READ-THEN-WRITE AGAINST A CONCURRENT LOCAL WRITE (real Postgres, two connections; PGlite
 * runs one connection and cannot see it). The person's PATCH holds Ann's row and commits a newer
 * write while the belt is settling an older ack: the belt must read the committed row and skip it,
 * never overwrite it from a stale read. Control: with no concurrent write the ack settles.
 */
const PG_UP = await realPgAvailable();
const t0 = new Date("2026-10-03T08:00:00.000Z");
const at = (m: number): Date => new Date(t0.getTime() + m * 60_000);
const KEYED = { kind: "sender", match: "ann@shop.example", subjectContains: null, bodyContains: null };

let a: ReturnType<typeof postgres>;
let b: ReturnType<typeof postgres>;
let dbA: ReturnType<typeof drizzle<typeof schema>>;
let dbB: ReturnType<typeof drizzle<typeof schema>>;

async function seed(): Promise<{ accountId: string; ruleId: string }> {
  const accountId = randomUUID();
  await dbA.insert(accounts).values({ id: accountId, name: `belt-${accountId.slice(0, 8)}` });
  const [r] = await dbA.insert(rules).values({
    accountId, kind: "sender", match: "ann@shop.example", destination: "ohmail/News", priority: 0,
    enabled: true, provenance: "manual", updatedAt: at(0),
  }).returning({ id: rules.id });
  // The press the belt settles: its one leg, applied, as the reader's drain records it first.
  const [mb] = await dbA.insert(mailboxes).values({ accountId, provider: "imap", address: `held-${accountId.slice(0, 8)}@mailbox.example` }).returning({ id: mailboxes.id });
  await dbA.insert(organizerRequests).values({
    accountId, mailboxId: mb!.id, kind: "rule.update", decidedAt: at(1), state: "applied",
    payload: { key: KEYED, set: { destination: "receipts" } },
  });
  return { accountId, ruleId: r!.id };
}
const destinationOf = async (accountId: string) =>
  (await dbA.select({ d: rules.destination }).from(rules).where(eq(rules.accountId, accountId))).map((x) => x.d);

describe.skipIf(!PG_UP)("the belt against a concurrent local write (real Postgres)", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    a = postgres(PG_TEST_URL, { max: 2, onnotice: () => {} });
    b = postgres(PG_TEST_URL, { max: 2, onnotice: () => {} });
    dbA = brandDialect(drizzle(a, { schema }), "pg");
    dbB = brandDialect(drizzle(b, { schema }), "pg");
  }, 120_000);
  afterAll(async () => { await a?.end({ timeout: 5 }); await b?.end({ timeout: 5 }); });

  it("a local write committed while the belt settles an older ack stands", async () => {
    const { accountId, ruleId } = await seed();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const hasLock = new Promise<void>((r) => { locked = r; });
    // The person's PATCH: holds the row, then commits Inbox at at(5) — newer than the ack's at(1).
    const patch = dbB.transaction(async (tx) => {
      await tx.update(rules).set({ destination: "INBOX", updatedAt: at(5) })
        .where(and(eq(rules.id, ruleId), eq(rules.accountId, accountId)));
      locked();
      await held;
    });
    await hasLock;
    const settle = (dbA as unknown as Tx).transaction((tx) => settleReaderRuleRows(tx, accountId, {
      kind: "rule.update", payload: { key: KEYED, set: { destination: "receipts" } }, decidedAt: at(1),
    }));
    await new Promise((r) => setTimeout(r, 300));
    release();
    await patch;
    const out = await settle;
    expect(await destinationOf(accountId), "the belt overwrote a newer local write").toEqual(["INBOX"]);
    expect(out).toEqual({ settled: false, skipped: "newer_local_write" });
  }, 60_000);

  it("an older edit settled after a later create that found the row as it asks stands down", async () => {
    const { accountId } = await seed();
    const [mb] = await dbA.select({ id: mailboxes.id }).from(mailboxes).where(eq(mailboxes.accountId, accountId));
    const create = { kind: "rule.create", payload: { key: KEYED, destination: "reads" }, decidedAt: at(5) };
    await dbA.insert(organizerRequests).values({ accountId, mailboxId: mb!.id, ...create, state: "applied" });
    const belt = (r: typeof create | { kind: string; payload: unknown; decidedAt: Date }) =>
      (dbA as unknown as Tx).transaction((tx) => settleReaderRuleRows(tx, accountId, r));
    expect(await belt(create)).toEqual({ settled: true, lastSeq: null });
    const out = await belt({ kind: "rule.update", payload: { key: KEYED, set: { destination: "receipts" } }, decidedAt: at(1) });
    expect(out).toEqual({ settled: false, skipped: "newer_settled_press" });
    expect(await destinationOf(accountId), "the older edit was applied over the later create").toEqual(["ohmail/News"]);
  }, 60_000);

  it("CONTROL: with no concurrent write, the ack settles", async () => {
    const { accountId } = await seed();
    const out = await (dbA as unknown as Tx).transaction((tx) => settleReaderRuleRows(tx, accountId, {
      kind: "rule.update", payload: { key: KEYED, set: { destination: "receipts" } }, decidedAt: at(1),
    }));
    expect(out).toEqual({ settled: true, lastSeq: expect.any(BigInt) });
    expect(await destinationOf(accountId)).toEqual(["ohmail/Receipts"]);
  }, 60_000);
});
