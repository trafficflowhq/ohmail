import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { mailboxes, mailboxCredentials } from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { StaticKeyProvider } from "@trafficflow/core";
import { startWorker, type RunningWorker } from "../src/index.js";
import type { WorkerConfig } from "../src/config.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  ONE BAD CREDENTIAL ROW MUST NOT DENY THE SHARD — a high review finding
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `loadMailboxCreds` and the adapter construction used to run ABOVE `attach()`'s `try`, so an
 * envelope that cannot be decrypted threw from outside every catch in `index.ts`. On a cold start
 * that rejected `startWorkerWithLock`, closed every mailbox already attached and released the shard
 * lock — the supervisor read a won-lock startup as fatal. On a live roster pass the pass-level
 * catch logged and stopped, so every later unattached mailbox was never visited. The roster is
 * stable oldest-first, so the same row led every pass for ever.
 *
 * The composition the old suite lacked: TWO mailboxes, the broken one FIRST. A test with one
 * mailbox cannot see the difference between "the first failed" and "the first failed and took the second with it".
 */

const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 23));
let DB = "";
type Db = ReturnType<typeof makeDb>;

async function seedHealthy(db: Db): Promise<{ accountId: string; mailboxId: string }> {
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

/**
 * A mailbox whose credential envelope cannot be decrypted — the deterministic per-row fault
 * a review named. Not a missing row (that path is `awaitingCredentials` and already accounted for):
 * a PRESENT row whose ciphertext this deployment cannot open, which is what a corrupt value or a
 * retired key version looks like.
 */
async function seedUndecryptable(db: Db): Promise<{ accountId: string; mailboxId: string }> {
  const accountId = randomUUID();
  const [row] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: `${randomUUID()}@trafficflow.test` }).returning();
  const enc = await KP.encrypt("pw");
  await db.insert(mailboxCredentials).values({
    mailboxId: row!.id, accountId: row!.accountId, transport: "imap",
    secretEnc: `${enc.ciphertext.slice(0, 8)}corrupted-envelope`, keyVersion: enc.keyVersion,
    meta: { host: "fake.invalid", port: 1143, secure: false, user: "u" },
  });
  return { accountId, mailboxId: row!.id };
}

function cfgFor(fleet: FakeAdapterFleet, extra: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    databaseUrl: DB, keyProvider: KP, pollIntervalMs: 200, sentDomain: "trafficflow.test",
    rosterIntervalMs: 300, mailboxRetryMs: 300, maxSyncFailures: 2,
    lockHeartbeatMs: 60_000, servingNothingMaxMs: 500,
    adapterFactory: fleet.factory,
    ...extra,
  };
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms: number, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`timed out after ${ms}ms waiting for ${label}`);
}

const rowOf = async (db: Db, id: string) => {
  const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, id));
  return row!;
};

describe("roster isolation: one undecryptable credential row", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_roster_isolation"); }, 60_000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);

  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of closers.splice(0)) { try { await c(); } catch { /* ignore */ } }
  }, ISOLATED_DB_RESET_BUDGET_MS);

  it("a COLD START still serves the mailbox behind it, and accounts for it alone", async () => {
    const db = makeDb(DB);
    // Seeded first, so the stable oldest-first roster reaches it first on every pass.
    const bad = await seedUndecryptable(db);
    const good = await seedHealthy(db);
    const fleet = new FakeAdapterFleet();

    // Before that change this REJECTED: the throw escaped `attach`, escaped `reconcileRoster`, and the
    // won-lock startup was read as fatal — the whole shard dark because of one row.
    const worker: RunningWorker = await startWorker(cfgFor(fleet));
    closers.push(() => worker.stop());

    await waitFor(async () =>
      worker.stats().mailboxes === 1 && (await rowOf(db, bad.mailboxId)).status === "error",
      8000, "the healthy mailbox served and the bad one persisted as error");

    // The healthy mailbox is SERVING — the assertion the wedge failed.
    expect(worker.stats()).toMatchObject({ mailboxes: 1, expected: 2, quarantined: 1, degraded: true });
    expect((await rowOf(db, good.mailboxId)).status).toBe("connected");

    // The failing mailbox is in an ACCOUNTED retry bucket with a named cause, not merely absent.
    // `roster_invariant_violated` is the gate that would otherwise page every 30 s about a
    // mailbox nothing explains; being quarantined is what explains it.
    const badRow = await rowOf(db, bad.mailboxId);
    expect(badRow.status).toBe("error");
    expect(badRow.errorCode).toBeTruthy();
    expect(worker.stats().lockLost).toBe(false);

    // No adapter was ever built for it, so nothing leaked: the failure is upstream of the dial.
    expect(fleet.openFor(bad.mailboxId)).toBe(0);
    expect(fleet.openFor(good.mailboxId)).toBe(1);
  }, 30_000);

  it("a LIVE roster pass keeps visiting the mailboxes behind it", async () => {
    const db = makeDb(DB);
    const bad = await seedUndecryptable(db);
    const fleet = new FakeAdapterFleet();

    const worker: RunningWorker = await startWorker(cfgFor(fleet));
    closers.push(() => worker.stop());
    await waitFor(async () => (await rowOf(db, bad.mailboxId)).status === "error", 8000, "the bad row quarantined");

    // A mailbox that appears AFTER boot, behind the bad row in the oldest-first order. Before
    // that fix the roster pass died on the bad row every 300 ms and this mailbox was never visited —
    // healthy, paid for, and permanently unsynced.
    const later = await seedHealthy(db);
    await waitFor(async () =>
      worker.stats().mailboxes === 1 && (await rowOf(db, later.mailboxId)).status === "connected",
      8000, "the later mailbox attached despite the bad row leading every pass");
    expect(fleet.openFor(later.mailboxId)).toBe(1);
  }, 30_000);

  /**
   * THE OTHER DIRECTION, and it is why the credential read could not simply be moved inside the
   * boundary. That read is a DATABASE read: unexempted, one shared-storage blip would quarantine
   * every mailbox of the shard in turn and write `status='error'` on each — the 2026-08-01
   * incident's shape, "the database was unreachable" rendered as "your mailbox is broken".
   */
  it("a shared DATABASE fault at the same line marks NO mailbox at fault", async () => {
    const db = makeDb(DB);
    const a = await seedHealthy(db);
    const b = await seedHealthy(db);
    const fleet = new FakeAdapterFleet();

    // The factory is the only per-mailbox seam this config owns, and a 53100 out of it is
    // indistinguishable to `attach` from one out of the credential read: both are throws from
    // inside the boundary that are not about the mailbox.
    let faults = 0;
    const failing: WorkerConfig["adapterFactory"] = () => {
      faults++;
      throw Object.assign(new Error("could not extend file: No space left on device"), { code: "53100" });
    };

    await expect(startWorker(cfgFor(fleet, { adapterFactory: failing }))).rejects.toThrow("No space left");
    expect(faults).toBeGreaterThan(0);

    // NEITHER mailbox is blamed. The pass failed; the rows are untouched.
    expect((await rowOf(db, a.mailboxId)).status).toBe("connected");
    expect((await rowOf(db, a.mailboxId)).errorCode).toBeNull();
    expect((await rowOf(db, b.mailboxId)).status).toBe("connected");
    expect((await rowOf(db, b.mailboxId)).errorCode).toBeNull();
  }, 30_000);
});
