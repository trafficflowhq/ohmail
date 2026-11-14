import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { accounts, mailboxes, messages, folderState, organizerRequests, rules } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { ScreenerService, type ServiceContext } from "@trafficflow/services";

/**
 * THE QUEUE'S SIZE ON THE SERVER'S OWN STORE. `row_number() over (partition …)` with a `count(*)`
 * over it is the shape PGlite has hidden defects behind, so the count `GET /screener` states on
 * its first page is measured here on Postgres. Every write is an INSERT under a fresh account.
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

const ctx = (accountId: string): ServiceContext => ({
  db: db as unknown as ServiceContext["db"], accountId, userId: null,
  now: () => new Date(), requestId: `stt-pg-${randomUUID().slice(0, 8)}`,
});

async function account(label: string) {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `stt-${label}-${accountId.slice(0, 8)}` });
  const own = `own-${accountId.slice(0, 8)}@example.test`;
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: own }).returning();
  let i = 0;
  const hold = async (from: string) => {
    const k = i++;
    const at = new Date(Date.now() - 86_400_000 - k * 60_000);
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: `h${k}`, dedupKey: `stt:${randomUUID()}`,
      subject: `Note ${k}`, fromAddress: from, date: at, createdAt: at,
      nativeLocator: { folder: "ohmail/Screener", ref: `1:${k}` },
    }).returning();
    await db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: "ohmail/Screener", observedFolder: "ohmail/Screener",
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
  };
  return { accountId, own, hold, mailboxId: mb!.id };
}

describe.skipIf(!PG_UP)("GET /screener's total on Postgres", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(client, { schema }), "pg");
  }, 120_000);
  afterAll(async () => { await client?.end({ timeout: 5 }); });

  it("held 3, decided 1, own 1 -> 1, and the other account's held senders read 0 here", async () => {
    const a = await account("a");
    await db.insert(rules).values({
      accountId: a.accountId, kind: "sender", match: "ruled@x.test", destination: "INBOX",
      provenance: "manual", enabled: true, priority: 0, retroRequestedAt: null,
    });
    await a.hold("stranger@x.test");
    await a.hold("stranger@x.test");
    await a.hold("ruled@x.test");
    await a.hold(a.own);
    const b = await account("b");
    await b.hold("one@y.test");
    await b.hold("two@y.test");
    const quiet = await account("quiet");

    const pageA = await new ScreenerService({}).list(ctx(a.accountId));
    expect(pageA.items.map((x) => x.sender.address)).toEqual(["stranger@x.test"]);
    expect(pageA.total).toBe(1);
    expect((await new ScreenerService({}).list(ctx(b.accountId))).total).toBe(2);
    expect((await new ScreenerService({}).list(ctx(quiet.accountId))).total).toBe(0);
  });

  it("leaves out the senders an in-flight decision took off every page, by sender and by domain", async () => {
    const w = await account("inflight");
    await w.hold("decided@q.test");
    await w.hold("a@dom.test");
    await w.hold("b@dom.test");
    await w.hold("left@q.test");
    await db.insert(organizerRequests).values([
      { accountId: w.accountId, mailboxId: w.mailboxId, kind: "screener.decide",
        payload: { scope: "sender", match: "Decided@q.test" }, decidedAt: new Date(), state: "pending" },
      { accountId: w.accountId, mailboxId: w.mailboxId, kind: "screener.decide",
        payload: { scope: "domain", match: "dom.test" }, decidedAt: new Date(), state: "sent" },
      { accountId: w.accountId, mailboxId: w.mailboxId, kind: "screener.decide",
        payload: { scope: "sender", match: "left@q.test" }, decidedAt: new Date(), state: "refused", resolvedAt: new Date() },
    ]);
    const page = await new ScreenerService({}).list(ctx(w.accountId));
    expect(page.items.map((x) => x.sender.address)).toEqual(["left@q.test"]);
    expect(page.total).toBe(1);
  });

  it("equals a walk of every page, and an onward page states none", async () => {
    const w = await account("walk");
    for (let s = 0; s < 9; s++) await w.hold(`s${s}@z.test`);
    const svc = new ScreenerService({});
    const first = await svc.list(ctx(w.accountId), { limit: 4 });
    const seen = first.items.map((x) => x.sender.address);
    let cursor = first.nextCursor;
    while (cursor !== null) {
      const next = await svc.list(ctx(w.accountId), { limit: 4, cursor });
      expect(next.total).toBeUndefined();
      seen.push(...next.items.map((x) => x.sender.address));
      cursor = next.nextCursor;
    }
    expect(first.total).toBe(9);
    expect(new Set(seen).size).toBe(9);
  });
});
