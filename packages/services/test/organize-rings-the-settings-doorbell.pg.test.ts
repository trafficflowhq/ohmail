import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq } from "drizzle-orm";
import { brandDialect } from "@trafficflow/db/dialect";
import { accountSettings, accounts, changeLog, mailboxCredentials, mailboxes } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { makeMailboxService } from "../src/mailbox-service.js";
import type { ServiceContext } from "../src/context.js";

/**
 * THE AGREE PRESS RINGS THE SETTINGS DOORBELL, ON POSTGRES (R20-02). The `settings` change row is
 * written once the press has committed, in a short transaction of its own; this twin runs it on the
 * server's store, where the sequence row and the row locks are real.
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

const NOW = new Date("2026-09-11T08:00:00.000Z");

async function account(opts: { organizing: boolean }) {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `ord-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `ord-${accountId.slice(0, 8)}@example.test`,
    organizerRole: opts.organizing ? "organizer" : "reader",
    organizeConsentedAt: opts.organizing ? NOW : null,
  }).returning();
  await db.insert(mailboxCredentials).values({
    mailboxId: mb!.id, transport: "imap", secretEnc: "not-a-real-secret", keyVersion: 1,
  });
  if (opts.organizing) {
    await db.insert(accountSettings).values({
      accountId, dormancyDays: 90, screeningScope: "window", screeningBaselineAt: NOW, updatedAt: NOW,
    });
  }
  const ctx: ServiceContext = {
    db: db as unknown as ServiceContext["db"], accountId, userId: null,
    now: () => NOW, requestId: `ord-pg-${randomUUID().slice(0, 8)}`,
  };
  const rings = async () => (await db.select().from(changeLog).where(and(
    eq(changeLog.accountId, accountId), eq(changeLog.entityType, "settings"),
  ))).length;
  return { ctx, mailboxId: mb!.id, rings };
}

describe.skipIf(!PG_UP)("organizeHere's settings change row on Postgres", () => {
  const svc = makeMailboxService({ allowance: async () => { /* permitted */ } });
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(client, { schema }), "pg");
  }, 120_000);
  afterAll(async () => { await client?.end({ timeout: 5 }); });

  it("a first consent appends one", async () => {
    const a = await account({ organizing: false });
    const out = await svc.organizeHere(a.ctx, a.mailboxId, { intent: "join", screening: { dormancyDays: 90, scope: "window" } });
    expect(out.outcome).toBe("authorized");
    expect(await a.rings()).toBe(1);
  });

  it("a re-run that widens the window appends one", async () => {
    const a = await account({ organizing: true });
    const out = await svc.organizeHere(a.ctx, a.mailboxId, { intent: "join", screening: { dormancyDays: 365, scope: "window" } });
    expect(out.outcome).toBe("already_organizing");
    expect(await a.rings()).toBe(1);
  });

  it("CONTROL: a re-run that writes nothing appends none", async () => {
    const a = await account({ organizing: true });
    await svc.organizeHere(a.ctx, a.mailboxId, { intent: "takeover" });
    expect(await a.rings()).toBe(0);
  });
});
