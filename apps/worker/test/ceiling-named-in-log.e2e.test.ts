import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mailboxes, mailboxCredentials } from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { StaticKeyProvider, createLogger } from "@trafficflow/core/mail";
import { ImapBoundExceeded } from "@trafficflow/core/adapters/imap";
import { startWorker } from "../src/index.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";

/**
 * A cycle that ends on one of our ceilings says WHICH one, through the real logger.
 *
 * `sync_cycle_failed` and `mailbox_quarantined` carried only the class and code, so a first
 * import that ran six minutes into `cycle_deadline` could not say which bound it met. A cycle that
 * hits a bound having committed nothing still reports it; a failure of another class names none.
 */

const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 47));
let DB = "";
const closers: Array<() => Promise<void>> = [];

async function linesAfterFailure(err: unknown): Promise<Array<Record<string, unknown>>> {
  const db = makeDb(DB);
  const [row] = await db.insert(mailboxes).values({
    accountId: randomUUID(), provider: "imap", address: `${randomUUID()}@trafficflow.test`,
  }).returning();
  const enc = await KP.encrypt("pw");
  await db.insert(mailboxCredentials).values({
    mailboxId: row!.id, accountId: row!.accountId, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
    meta: { host: "fake.invalid", port: 1143, secure: false, user: "u" },
  });
  const fleet = new FakeAdapterFleet();
  fleet.behave(row!.id, { syncError: err });
  const lines: Array<Record<string, unknown>> = [];
  const worker = await startWorker({
    databaseUrl: DB, keyProvider: KP, pollIntervalMs: 100, sentDomain: "trafficflow.test",
    rosterIntervalMs: 200, mailboxRetryMs: 300, maxSyncFailures: 1,
    lockHeartbeatMs: 150, instanceId: `wkr-ceiling-${randomUUID().slice(0, 8)}`,
    adapterFactory: fleet.factory,
    logger: createLogger({ service: "worker", level: "info", sink: (l) => lines.push(JSON.parse(l)) }),
  });
  closers.push(() => worker.stop());
  const start = Date.now();
  while (!lines.some((l) => l.event === "mailbox_quarantined")) {
    if (Date.now() - start > 20_000) throw new Error("no quarantine line in 20 s");
    await new Promise((r) => setTimeout(r, 25));
  }
  return lines;
}

describe("the ceiling that ended a cycle is named on its log lines", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_ceilinglog"); }, 120_000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);
  afterEach(async () => {
    for (const c of closers.splice(0)) { try { await c(); } catch { /* ignore */ } }
  }, ISOLATED_DB_RESET_BUDGET_MS);

  it("a cycle that met cycle_deadline having committed nothing reports the bound and its limit", async () => {
    const lines = await linesAfterFailure(new ImapBoundExceeded("cycle_deadline", 300_000, 347_382, "INBOX"));
    const failed = lines.find((l) => l.event === "sync_cycle_failed")!;
    expect(failed).toMatchObject({ errorClass: "ImapBoundExceeded", ceiling: "cycle_deadline", ceilingLimit: 300_000 });
    expect(failed.droppedFields, "the logger's census dropped a field").toBeUndefined();
    const held = lines.find((l) => l.event === "mailbox_quarantined")!;
    expect(held).toMatchObject({ syncBlockedReason: "read_limited", ceiling: "cycle_deadline", ceilingLimit: 300_000 });
    expect(held.droppedFields).toBeUndefined();
  }, 30_000);

  it("THE CONTROL: a failure of another class names no ceiling", async () => {
    const lines = await linesAfterFailure(new Error("socket said something odd"));
    const failed = lines.find((l) => l.event === "sync_cycle_failed")!;
    expect(failed).toBeDefined();
    expect("ceiling" in failed).toBe(false);
    expect("ceiling" in lines.find((l) => l.event === "mailbox_quarantined")!).toBe(false);
  }, 30_000);
});
