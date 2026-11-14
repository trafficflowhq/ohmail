import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { mailboxes, mailboxCredentials, messages } from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { workerHeartbeats } from "@trafficflow/db/cloud";
import { StaticKeyProvider, type LogFields } from "@trafficflow/core";
import { randomUUID } from "node:crypto";
import { startWorker, type RunningWorker } from "../src/index.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";

/**
 * THE FIRST SYNC OF A BIG MAILBOX (the 2026-08-01 outage).
 *
 * `changesSince` returned the entire mailbox — bodies included — in one array, so the first
 * sync of a real mailbox drove its container past its memory and was SIGKILLed. Two properties
 * had to change, and both are pinned here:
 *
 *  • the worker must DRAIN a truncated backlog under its own steam, not one batch per
 *    `pollIntervalMs` (at one batch a cycle a large mailbox would otherwise take days);
 *  • the boot must be OBSERVABLE — a heartbeat and a log line before the roster attaches
 *    anything, because the old ordering wrote neither until the whole initial sync finished,
 *    which is why a worker that was busily ingesting looked exactly like a dead one.
 */
type Db = ReturnType<typeof makeDb>;

const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 7));
let DB = "";

async function seedMailbox(db: Db, accountId = randomUUID()): Promise<{ accountId: string; mailboxId: string }> {
  const [row] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: `${randomUUID()}@trafficflow.test` }).returning();
  const enc = await KP.encrypt("pw");
  await db.insert(mailboxCredentials).values({
    mailboxId: row!.id, accountId: row!.accountId, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
    meta: { host: "fake.invalid", port: 1143, secure: false, user: "u" },
  });
  return { accountId, mailboxId: row!.id };
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms: number, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`timed out after ${ms}ms waiting for ${label}`);
}

/** Collects structured log events so boot ordering can be asserted. */
function recordingLogger() {
  const events: Array<{ event: string; fields: LogFields }> = [];
  const mk = (bound: LogFields = {}): ReturnType<typeof makeLogger> => makeLogger(bound);
  function makeLogger(bound: LogFields) {
    const push = (event: string, fields?: LogFields) => { events.push({ event, fields: { ...bound, ...fields } }); };
    return {
      level: "debug" as const,
      child: (f: LogFields) => mk({ ...bound, ...f }),
      debug: push, info: push, warn: push, error: push,
    };
  }
  return { events, logger: mk() };
}

describe("bounded backfill (the first sync of a large mailbox)", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_backfill"); }, 60000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c(); }, ISOLATED_DB_RESET_BUDGET_MS);

  it("drains a multi-batch backlog to completion without waiting for the poll interval", async () => {
    const db = makeDb(DB);
    const { accountId, mailboxId } = await seedMailbox(db);

    // 25 messages, handed over 5 at a time. A poll interval far longer than the test means
    // any progress beyond the first batch can only come from the backlog re-kick.
    const fleet = new FakeAdapterFleet();
    fleet.behave(mailboxId, {
      batchSize: 5,
      deliver: Array.from({ length: 25 }, (_, i) => ({
        from: "anna@x.example", subject: `backfill ${i}`, messageId: `bf${i}@x`,
      })),
    });

    const worker: RunningWorker = await startWorker({
      databaseUrl: DB, accountId, keyProvider: KP,
      pollIntervalMs: 600_000,          // one tick would land long after this test is over
      rosterIntervalMs: 600_000,
      sentDomain: "trafficflow.test",
      adapterFactory: fleet.factory,
    });
    closers.push(() => worker.stop());

    await waitFor(async () => {
      const rows = await db.select().from(messages).where(eq(messages.mailboxId, mailboxId));
      return rows.length === 25;
    }, 20_000, "all 25 messages ingested across bounded batches");

    const rows = await db.select().from(messages).where(eq(messages.mailboxId, mailboxId));
    expect(rows).toHaveLength(25);
    // Every message exactly once — the drain must not re-ingest what it already committed.
    expect(new Set(rows.map((r) => r.dedupKey)).size).toBe(25);
    // And `last_sync_at` is stamped, so the UI can stop saying "Not synced yet".
    const [mb] = await db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId));
    expect(mb!.lastSyncAt).not.toBeNull();
  }, 60_000);

  it("writes a heartbeat and logs before the roster attaches anything", async () => {
    const db = makeDb(DB);
    const { accountId, mailboxId } = await seedMailbox(db);

    // Park the attach inside connect(): the roster pass cannot complete while this gate is
    // closed, which is exactly the window that used to produce no heartbeat and no log.
    let openGate = (): void => { /* replaced */ };
    const gate = new Promise<void>((resolve) => { openGate = resolve; });
    const fleet = new FakeAdapterFleet();
    fleet.behave(mailboxId, { gate });

    const { events, logger } = recordingLogger();
    const starting = startWorker({
      databaseUrl: DB, accountId, keyProvider: KP,
      pollIntervalMs: 600_000, rosterIntervalMs: 600_000,
      sentDomain: "trafficflow.test",
      adapterFactory: fleet.factory,
      logger,
    });

    // While the attach is still parked: the heartbeat row must already exist and the boot
    // must already have said so. Both were absent for the entire initial sync before the fix.
    await waitFor(async () => (await db.select().from(workerHeartbeats)).length === 1,
      10_000, "a heartbeat written BEFORE the roster completes");
    expect(events.some((e) => e.event === "leader_boot_started")).toBe(true);
    // The beat is written before the attach reads its credential and clears its dial host, and
    // `mailbox_attach_started` is logged after both, so the line is waited for rather than read at
    // the beat's instant. The gate is still closed, so it still has to come before the attach ends.
    await waitFor(() => events.some((e) => e.event === "mailbox_attach_started"),
      10_000, "mailbox_attach_started while the attach is parked");
    expect(events.some((e) => e.event === "mailbox_attach_started")).toBe(true);
    // ...and the attach genuinely has not finished yet.
    expect(events.some((e) => e.event === "mailbox_attached")).toBe(false);

    openGate();
    const worker = await starting;
    closers.push(() => worker.stop());
    await waitFor(() => events.some((e) => e.event === "mailbox_attached"), 10_000, "attach completes");
  }, 60_000);
});
