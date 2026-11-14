import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { mailboxes, mailboxCredentials, messages } from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { StaticKeyProvider } from "@trafficflow/core";
import {
  DEFAULT_NET_TIMEOUTS, WORKER_NET_TIMEOUTS, type ImapConfig,
} from "@trafficflow/core/adapters/imap";
import { randomUUID } from "node:crypto";
import { startWorker } from "../src/index.js";
import type { WorkerConfig } from "../src/config.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";
import { byMessageId } from "./_workerdb.js";

/**
 * THE KILL MECHANISM OF 2026-08-02, CONTAINED.
 *
 * the misplaced backfill was the trigger; this is what turned a slow query into an eight-minute
 * outage. `ImapFlow` reports an asynchronous connection failure — a dead socket, a server `BYE`,
 * an `ETIMEOUT` — by EMITTING `error`, and there was no listener anywhere in this repository.
 * Node turns that into an uncaught exception and `entry.ts` answers uncaught exceptions with
 * `exit(1)` **by design**, so ONE mailbox's socket ended the process, every account stopped
 * syncing, and Railway restarted the container every ~26 s.
 *
 * No `try/catch` could have caught it: the throw does not come out of the call it wraps. The fix
 * is a listener (`ImapAdapter.guardAsyncErrors`, attached unconditionally) plus an owner for the
 * event (`handleConnectionError` in `index.ts`). The assertion that matters is the third one
 * below — **the other mailbox keeps syncing** — because "the process survived" is worth nothing
 * if the shard is dead anyway.
 */

const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 7));
let DB = "";

type Db = ReturnType<typeof makeDb>;

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

function cfgFor(fleet: FakeAdapterFleet, over: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    databaseUrl: DB, keyProvider: KP, pollIntervalMs: 200, sentDomain: "trafficflow.test",
    adapterFactory: fleet.factory, maxSyncFailures: 3,
    // Long enough that the quarantined mailbox does not silently re-attach and make the
    // "it stayed detached" half of the assertion vacuous.
    mailboxRetryMs: 60_000,
    rosterIntervalMs: 300, lockHeartbeatMs: 30_000, alertIntervalMs: 60_000,
    ...over,
  };
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms: number, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out after ${ms}ms waiting for ${label}`);
}

describe("asynchronous IMAP connection failure", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_connerr"); }, 120_000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);

  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of closers.splice(0)) { try { await c(); } catch { /* ignore */ } } }, ISOLATED_DB_RESET_BUDGET_MS);

  it("kills ONE mailbox: the process survives, and the other account keeps syncing", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const a = await seedMailbox(db);                       // the one whose socket dies
    const b = await seedMailbox(db);                       // the innocent bystander
    fleet.behave(b.mailboxId, {
      deliver: [{ from: "anna@x.example", subject: "still flowing", messageId: "conn-b1@x" }],
    });

    const escapes: unknown[] = [];
    const onEscape = (e: unknown): void => { escapes.push(e); };
    process.on("uncaughtException", onEscape);
    process.on("unhandledRejection", onEscape);
    closers.push(async () => {
      process.removeListener("uncaughtException", onEscape);
      process.removeListener("unhandledRejection", onEscape);
    });

    const worker = await startWorker(cfgFor(fleet));
    closers.push(() => worker.stop());
    await waitFor(() => worker.stats().mailboxes === 2, 15_000, "both mailboxes attached");

    // THE EVENT, fired out of band exactly as imapflow's emitter would fire it — from a timer,
    // not from any call the worker is awaiting.
    fleet.killConnection(a.mailboxId);

    // 1. Contained: that mailbox leaves the rotation and takes its normal backoff.
    await waitFor(() => worker.stats().quarantined === 1, 15_000, "the dead mailbox to be quarantined");
    expect(worker.stats().mailboxes, "the surviving mailbox left the rotation too").toBe(1);
    // …and its login was CLOSED rather than leaked (risk 12).
    expect(fleet.openFor(a.mailboxId)).toBe(0);
    expect(fleet.openFor(b.mailboxId)).toBe(1);

    // 2. The bystander keeps syncing — the assertion the outage was missing. A process that
    //    survives with a dead shard is the same outage wearing a different exit code.
    await waitFor(async () => (await db.select().from(messages)
      .where(byMessageId(b.mailboxId, "conn-b1@x"))).length === 1,
      15_000, "the other account's mail to keep flowing");
    const syncsAfter = fleet.syncs;
    await waitFor(() => fleet.syncs > syncsAfter, 10_000, "the cycle to keep running");

    // 3. Nothing reached the process. This is the line that would have been red on 2026-08-02.
    expect(escapes, "an IMAP error escaped to the process — this is how the worker exited").toEqual([]);
  }, 90_000);

  it("an error for an ALREADY-DETACHED mailbox is a no-op, not a second quarantine", async () => {
    // Two `error` events for one dead socket is normal, and so is an error arriving just after
    // a roster pass detached the mailbox. Either one counting again would double the mailbox's
    // exponential backoff on its first failure.
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const a = await seedMailbox(db);
    const quarantines: number[] = [];
    const logger = {
      debug: () => { /* unused */ },
      info: () => { /* unused */ },
      warn: () => { /* unused */ },
      error: (event: string, fields?: Record<string, unknown>) => {
        if (event === "mailbox_quarantined") quarantines.push(Number(fields?.attempts ?? -1));
      },
      child() { return this; },
    };

    const worker = await startWorker(cfgFor(fleet, { logger }));
    closers.push(() => worker.stop());
    await waitFor(() => worker.stats().mailboxes === 1, 15_000, "attached");

    fleet.killConnection(a.mailboxId);
    await waitFor(() => worker.stats().quarantined === 1, 15_000, "quarantined");
    fleet.killConnection(a.mailboxId);
    fleet.killConnection(a.mailboxId);
    await new Promise((r) => setTimeout(r, 400));

    expect(worker.stats().quarantined).toBe(1);
    expect(worker.stats().mailboxes).toBe(0);
    // One close, not three: the extra events found nothing in the rotation to tear down.
    expect(fleet.closes).toBe(1);
    // …and ONE quarantine, at attempt 1. The counters cannot see the difference — the map is
    // keyed by mailbox — but the ATTEMPT COUNT is what drives the exponential backoff, so three
    // events for one dead socket would put a recoverable mailbox at a 4× delay on its first
    // failure. The log line is where that is observable, so it is where it is asserted.
    expect(quarantines).toEqual([1]);
  }, 60_000);

  it("hands the adapter the WORKER's socket deadline, not the serverless one", async () => {
    // `DEFAULT_NET_TIMEOUTS.socketMs` is 25 s, chosen against Vercel's `maxDuration`, and the
    // worker inherited it silently. imapflow only auto-idles 15 s after the last command and
    // only when a mailbox is SELECTED, so any longer stretch with neither — which is precisely
    // where the backfill sat — hit that deadline and emitted `ETIMEOUT`.
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    await seedMailbox(db);
    const configs: ImapConfig[] = [];
    const factory: WorkerConfig["adapterFactory"] = (cfg, ctx) => {
      configs.push(cfg);
      return fleet.factory(cfg, ctx);
    };

    const worker = await startWorker(cfgFor(fleet, { adapterFactory: factory }));
    closers.push(() => worker.stop());
    await waitFor(() => configs.length === 1, 15_000, "the adapter to be built");

    expect(configs[0]!.timeouts).toEqual(WORKER_NET_TIMEOUTS);
    expect(WORKER_NET_TIMEOUTS.socketMs).toBeGreaterThan(DEFAULT_NET_TIMEOUTS.socketMs);
  }, 60_000);
});
