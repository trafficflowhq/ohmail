import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { mailboxes, mailboxCredentials } from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { StaticKeyProvider } from "@trafficflow/core";
import { startWorker } from "../src/index.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";

/**
 * A mailbox created while the worker runs is attached within a kick scan, not a roster interval.
 *
 * The create door rings `sync_requested_at`; the worker's ~3 s kick scan sees a stamped mailbox it
 * does not serve and asks for a roster pass. Driven through the real worker with the roster
 * interval set far past the test: the stamped mailbox is dialled in seconds, and the unstamped
 * control is not.
 */

const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 53));
let DB = "";
const closers: Array<() => Promise<void>> = [];

async function seedMailbox(stamped: boolean): Promise<string> {
  const db = makeDb(DB);
  const [row] = await db.insert(mailboxes).values({
    accountId: randomUUID(), provider: "imap", address: `${randomUUID()}@trafficflow.test`,
    ...(stamped ? { syncRequestedAt: sql`now()` } : {}),
  }).returning();
  const enc = await KP.encrypt("pw");
  await db.insert(mailboxCredentials).values({
    mailboxId: row!.id, accountId: row!.accountId, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
    meta: { host: "fake.invalid", port: 1143, secure: false, user: "u" },
  });
  return row!.id;
}

async function bootIdle(fleet: FakeAdapterFleet): Promise<void> {
  const worker = await startWorker({
    databaseUrl: DB, keyProvider: KP, pollIntervalMs: 60_000, sentDomain: "trafficflow.test",
    // Far past the test: only the kick scan's roster request can attach a mailbox made after boot.
    rosterIntervalMs: 600_000, mailboxRetryMs: 300,
    lockHeartbeatMs: 150, instanceId: `wkr-rosterwake-${randomUUID().slice(0, 8)}`,
    adapterFactory: fleet.factory,
  });
  closers.push(() => worker.stop());
}

const dialled = (fleet: FakeAdapterFleet, id: string): boolean => fleet.indicesOf(id, "connect").length > 0;

describe("a mailbox created while the worker runs", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_rosterwake"); }, 120_000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);
  afterEach(async () => {
    for (const c of closers.splice(0)) { try { await c(); } catch { /* ignore */ } }
  }, ISOLATED_DB_RESET_BUDGET_MS);

  it("is dialled within a kick scan when its create rang the doorbell", async () => {
    const fleet = new FakeAdapterFleet();
    await bootIdle(fleet);
    const id = await seedMailbox(true);
    const start = Date.now();
    while (!dialled(fleet, id)) {
      if (Date.now() - start > 12_000) throw new Error("the stamped mailbox was not dialled in 12 s");
      await new Promise((r) => setTimeout(r, 50));
    }
  }, 30_000);

  it("THE CONTROL: an unstamped one waits for the roster interval", async () => {
    const fleet = new FakeAdapterFleet();
    await bootIdle(fleet);
    const id = await seedMailbox(false);
    await new Promise((r) => setTimeout(r, 8_000));
    expect(dialled(fleet, id), "an unstamped mailbox was attached without a roster pass").toBe(false);
  }, 30_000);
});
