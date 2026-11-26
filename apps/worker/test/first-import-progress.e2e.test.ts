import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { mailboxes, mailboxCredentials, messages } from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { StaticKeyProvider } from "@trafficflow/core";
import { ImapBoundExceeded } from "@trafficflow/core/adapters/imap";
import { startWorker } from "../src/index.js";
import type { WorkerConfig } from "../src/config.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { FakeAdapterFleet } from "../../../packages/organizer/test/_fakeadapter.js";

/** A failed read does not move the first-import clock. Committed work does,
 * and the one-pass completion stamp remains separate. The fixture uses an isolated database.
 */

const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 43));
let DB = "";
type Db = ReturnType<typeof makeDb>;
const closers: Array<() => Promise<void>> = [];

async function seedMailbox(db: Db): Promise<string> {
  const [row] = await db.insert(mailboxes).values({
    accountId: randomUUID(), provider: "imap", address: `${randomUUID()}@trafficflow.test`,
  }).returning();
  const enc = await KP.encrypt("pw");
  await db.insert(mailboxCredentials).values({
    mailboxId: row!.id, accountId: row!.accountId, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
    meta: { host: "fake.invalid", port: 1143, secure: false, user: "u" },
  });
  return row!.id;
}

/** Every cycle throws `err`; returns the row once `cycles` failures have been logged. */
async function afterFailedCycles(err: unknown, cycles: number): Promise<typeof mailboxes.$inferSelect> {
  const db = makeDb(DB);
  const fleet = new FakeAdapterFleet();
  const id = await seedMailbox(db);
  fleet.behave(id, { syncError: err });
  let failed = 0;
  const logger = {
    debug: () => undefined, info: () => undefined, warn: () => undefined,
    error: (event: string) => { if (event === "sync_cycle_failed") failed++; },
    child() { return this; },
  };
  const worker = await startWorker({
    databaseUrl: DB, keyProvider: KP, pollIntervalMs: 100, sentDomain: "trafficflow.test",
    rosterIntervalMs: 200, mailboxRetryMs: 300,
    // High, so no quarantine is written: the stamp under test is the failure arm's own.
    maxSyncFailures: 50,
    lockHeartbeatMs: 150, instanceId: `wkr-progress-${randomUUID().slice(0, 8)}`,
    adapterFactory: fleet.factory, logger: logger as unknown as WorkerConfig["logger"],
  });
  closers.push(() => worker.stop());
  const start = Date.now();
  // `failed + 1`: the stamp is written after the log line, so one more failure proves it landed.
  while (failed < cycles + 1) {
    if (Date.now() - start > 20_000) throw new Error(`only ${failed} failed cycles in 20 s`);
    await new Promise((r) => setTimeout(r, 25));
  }
  return (await db.select().from(mailboxes).where(eq(mailboxes.id, id)))[0]!;
}

describe("first import advances its clock on durable progress", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_firstprogress"); }, 120_000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);
  afterEach(async () => {
    for (const c of closers.splice(0)) { try { await c(); } catch { /* ignore */ } }
  }, ISOLATED_DB_RESET_BUDGET_MS);

  it("a read ceiling alone leaves the import clock without a stamp", async () => {
    const row = await afterFailedCycles(new ImapBoundExceeded("enumerate_uids", 500_000, 500_001, "INBOX"), 1);
    expect(row.lastSyncAt, "no cycle completed, so this case is about the first import").toBeNull();
    expect(row.syncProgressAt, "an aborted read did not advance the import").toBeNull();
    expect(row.syncBlockedReason, "the block is the quarantine's, not one cycle's").toBeNull();
    expect(row.status).toBe("connected");
  }, 30_000);

  it("moves the import clock after committing mail before a body overrun", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const id = await seedMailbox(db);
    fleet.behave(id, { deliver: [{ from: "fixture@x.example", subject: "kept", messageId: "kept@x" }] });
    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 600_000, sentDomain: "trafficflow.test",
      rosterIntervalMs: 200, lockHeartbeatMs: 150, instanceId: `wkr-overrun-${randomUUID().slice(0, 8)}`,
      adapterFactory: (...args) => {
        const adapter = fleet.factory(...args);
        const read = adapter.changesSince.bind(adapter);
        adapter.changesSince = async (...readArgs) => ({
          ...await read(...readArgs), hasBacklog: true,
          overrun: { folder: "INBOX", breach: new ImapBoundExceeded("body_overrun", 10, 11, "INBOX") },
        });
        return adapter;
      },
    });
    closers.push(() => worker.stop());
    await expect.poll(async () =>
      (await db.select().from(messages).where(eq(messages.mailboxId, id))).length,
    { timeout: 10_000 }).toBe(1);
    await expect.poll(async () =>
      (await db.select().from(mailboxes).where(eq(mailboxes.id, id)))[0]?.syncProgressAt,
    { timeout: 2_000 }).toBeInstanceOf(Date);
    expect((await db.select().from(mailboxes).where(eq(mailboxes.id, id)))[0]?.initialImportCompletedAt).toBeNull();
  }, 20_000);

  it("finishes the first import only after a skipped folder answers on a later poll", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const id = await seedMailbox(db);
    fleet.behave(id, { deliver: [{ from: "fixture@x.example", subject: "available", messageId: "available@x" }] });
    let incomplete = true;
    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 100, sentDomain: "trafficflow.test",
      rosterIntervalMs: 200, lockHeartbeatMs: 150, instanceId: `wkr-retry-${randomUUID().slice(0, 8)}`,
      adapterFactory: (...args) => {
        const adapter = fleet.factory(...args);
        const read = adapter.changesSince.bind(adapter);
        adapter.changesSince = async (...readArgs) => ({
          ...await read(...readArgs), ...(incomplete ? { incompleteFolders: ["News"] } : {}),
        });
        return adapter;
      },
    });
    closers.push(() => worker.stop());
    const row = async () => (await db.select().from(mailboxes).where(eq(mailboxes.id, id)))[0]!;
    await expect.poll(async () => (await row()).syncProgressAt, { timeout: 10_000 }).toBeInstanceOf(Date);
    expect((await row()).initialImportCompletedAt).toBeNull();
    expect((await db.select().from(messages).where(eq(messages.mailboxId, id)))).toHaveLength(1);
    incomplete = false;
    await expect.poll(async () => (await row()).initialImportCompletedAt, { timeout: 10_000 }).toBeInstanceOf(Date);
  }, 25_000);

  it("a completed cycle WITH a backlog moves the clock; an import that drains at once owes none", async () => {
    // The import's clock search reads past the first day: the else arm of the worker's `!hasBacklog`.
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const owing = await seedMailbox(db);
    fleet.behave(owing, {
      batchSize: 2,
      deliver: Array.from({ length: 6 }, (_, i) => ({ from: "anna@x.example", subject: `clock ${i}`, messageId: `clock${i}@x` })),
    });
    const quick = await seedMailbox(db);
    fleet.behave(quick, { batchSize: 10, deliver: [{ from: "anna@x.example", subject: "one", messageId: "one@x" }] });
    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 600_000, sentDomain: "trafficflow.test",
      rosterIntervalMs: 200, lockHeartbeatMs: 150, instanceId: `wkr-clock-${randomUUID().slice(0, 8)}`,
      adapterFactory: fleet.factory,
    });
    closers.push(() => worker.stop());
    const rowOf = async (id: string) => (await db.select().from(mailboxes).where(eq(mailboxes.id, id)))[0]!;
    const start = Date.now();
    while ((await rowOf(owing)).initialImportCompletedAt === null || (await rowOf(quick)).initialImportCompletedAt === null) {
      if (Date.now() - start > 20_000) throw new Error("the two imports did not both finish in 20 s");
      await new Promise((r) => setTimeout(r, 40));
    }
    const a = await rowOf(owing);
    expect(a.syncProgressAt, "three cycles owed mail and the clock never moved").not.toBeNull();
    expect(a.syncProgressAt!.getTime()).toBeLessThanOrEqual(a.initialImportCompletedAt!.getTime());
    expect((await rowOf(quick)).syncProgressAt, "a first cycle that drained moved the clock").toBeNull();
  }, 30_000);

  it("THE CONTROL: a failure of another class stamps nothing", async () => {
    const row = await afterFailedCycles(new Error("socket said something odd"), 2);
    expect(row.syncProgressAt).toBeNull();
  }, 30_000);
});
