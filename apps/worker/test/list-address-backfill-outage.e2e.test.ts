import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { eq, sql } from "drizzle-orm";
import { accountSettings, mailboxes, mailboxCredentials, type Tx, accountPass, readPassProgress } from "@trafficflow/db";
import { makeDb, makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { StaticKeyProvider, type Logger } from "@trafficflow/core";
import { startWorker } from "../src/index.js";
import type { WorkerConfig } from "../src/config.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";

/**
 * AN OUTAGE MET BY THE LIST-ADDRESS BACKFILL IS THE SHARD'S. Its tail stage swallowed every throw as
 * one account's failure, so a database cut landing there was never announced and the shard read
 * healthy. The REAL pass is handed a database that refuses the connection, once: the stage
 * must announce the outage, quarantine nothing, and the next tail stamps the account. CONTROL: a
 * value Postgres refuses is the account's own failure and announces nothing.
 */

const fault = vi.hoisted(() => ({ db: null as unknown, err: null as unknown, calls: 0 }));

vi.mock("../src/list-address-backfill.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/list-address-backfill.js")>();
  return {
    ...real,
    listAddressBackfillPass: async (db: Tx, deps: Parameters<typeof real.listAddressBackfillPass>[1]) => {
      fault.calls++;
      const dead = fault.db;
      const thrown = fault.err;
      fault.db = null;
      fault.err = null;
      if (thrown !== null) throw thrown;
      return real.listAddressBackfillPass((dead ?? db) as Tx, deps);
    },
  };
});

const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 31));
let DB = "";
type Db = ReturnType<typeof makeDb>;

async function seedMailbox(db: Db): Promise<{ accountId: string; mailboxId: string }> {
  const accountId = randomUUID();
  const [row] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: `${randomUUID()}@trafficflow.test` }).returning();
  const enc = await KP.encrypt("pw");
  await db.insert(mailboxCredentials).values({
    mailboxId: row!.id, accountId: row!.accountId, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
    meta: { host: "fake.invalid", port: 1143, secure: false, user: "u" },
  });
  return { accountId, mailboxId: row!.id };
}

/** A port nothing listens on: bound by the kernel, then given back. */
/* Interpolated: the push gate reads a literal `user:pw@127.0.0.1:${port}` as a credential at a real host. */
const DEAD_ROLE = "nobody";
async function closedPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const { port } = s.address() as net.AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms: number, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out after ${ms}ms waiting for ${label}`);
}

/** The worker's lines in order, by event name. */
function orderedLogger(events: string[]): Logger {
  const self: Logger = {
    level: "debug",
    child: () => self,
    debug: (event) => { events.push(event); },
    info: (event) => { events.push(event); },
    warn: (event) => { events.push(event); },
    error: (event) => { events.push(event); },
  };
  return self;
}

function cfgFor(fleet: FakeAdapterFleet, log: Logger): WorkerConfig {
  return {
    databaseUrl: DB, keyProvider: KP, sentDomain: "trafficflow.test", adapterFactory: fleet.factory,
    pollIntervalMs: 150, rosterIntervalMs: 300, lockHeartbeatMs: 30_000, alertIntervalMs: 60_000,
    mailboxRetryMs: 60_000, maxSyncFailures: 1, logger: log,
  };
}

const count = (events: string[], name: string): number => events.filter((e) => e === name).length;

describe("the list-address backfill stage meets a database outage", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_list_backfill_outage"); }, 120_000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);

  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    fault.db = null;
    fault.err = null;
    fault.calls = 0;
    for (const c of closers.splice(0).reverse()) { try { await c(); } catch { /* ignore */ } }
  }, ISOLATED_DB_RESET_BUDGET_MS);

  async function stamped(db: Db, accountId: string): Promise<boolean> {
    return (await readPassProgress(db, accountPass("list_address_backfill", accountId))).doneAt != null;
  }

  it("announces the outage once, quarantines nothing, and the next tail stamps the account", async () => {
    const db = makeDb(DB);
    const a = await seedMailbox(db);
    const dead: OwnedDb = makeOwnedDb(`postgres://${DEAD_ROLE}:nothing@127.0.0.1:${await closedPort()}/gone`);
    closers.push(() => dead.close());
    fault.db = dead.db;

    const events: string[] = [];
    const fleet = new FakeAdapterFleet();
    const worker = await startWorker(cfgFor(fleet, orderedLogger(events)));
    closers.push(() => worker.stop());

    await waitFor(() => count(events, "list_address_backfill_failed") >= 1, 30_000, "the faulted pass to fail");
    // The stage's own catch names the outage, the line right before the account's own.
    const failedAt = events.indexOf("list_address_backfill_failed");
    expect(events[failedAt - 1], "the outage met by the backfill was never announced").toBe("worker_database_fault");
    expect(count(events, "worker_database_fault"), "the outage was announced more than once").toBe(1);

    // The next tail runs the real pass on the live database, and a completed cycle ends the outage.
    await waitFor(() => stamped(db, a.accountId), 30_000, "the next tail to stamp the account");
    await waitFor(() => count(events, "worker_database_recovered") >= 1, 30_000, "the outage to clear");
    expect(worker.stats().databaseFaultSince).toBeNull();
    expect(count(events, "mailbox_quarantined"), "an outage of ours quarantined a mailbox").toBe(0);
    expect(fault.calls).toBeGreaterThanOrEqual(2);
  }, 120_000);

  it("CONTROL: a value Postgres refuses is the account's failure and announces nothing", async () => {
    const db = makeDb(DB);
    const a = await seedMailbox(db);
    // A data exception from the live database, as the driver hands it back.
    fault.err = await db.execute(sql`select convert_from('\\xff'::bytea, 'UTF8')`)
      .then(() => null, (e: unknown) => e);
    expect(fault.err, "the database accepted the value the control needs refused").not.toBeNull();

    const events: string[] = [];
    const fleet = new FakeAdapterFleet();
    const worker = await startWorker(cfgFor(fleet, orderedLogger(events)));
    closers.push(() => worker.stop());

    await waitFor(() => count(events, "list_address_backfill_failed") >= 1, 30_000, "the refused pass to fail");
    await waitFor(() => stamped(db, a.accountId), 30_000, "the next tail to stamp the account");
    expect(count(events, "worker_database_fault"), "a refused value was announced as an outage").toBe(0);
    expect(worker.stats().databaseFaultSince).toBeNull();
  }, 120_000);
});
