import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { StaticKeyProvider } from "@trafficflow/core";
import {
  UNMETERED_STORAGE_CAP, commitChange, planChange, type BlankRepairMode, type Change,
} from "@trafficflow/core/mail";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { mailboxes, mailboxCredentials, messageFailures, messageInstances } from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { startWorker } from "../src/index.js";
import type { WorkerConfig } from "../src/config.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { ORGANIZER_CONSENT } from "./_workerdb.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";

/**
 * THE HOSTED WORKER'S OWN LOOP RUNS THE BLANK REPAIR IN THE CONFIGURED MODE — the door the Cloud
 * worker and the self-hosted organizer share (`startWorker`, its cycle's `SyncDeps` built from
 * `config.blankRepair`, which `OHMAIL_BLANK_REPAIR` fills: `config.test.ts`). `off` reads and moves
 * nothing, `dry` reads the place once over every cycle and writes nothing, and only apply (unset)
 * returns the letter. The backstop's door is `reconcile-cron.e2e.test.ts`'s, the engines'
 * `apps/sidecar/test/blank-repair-mode.test.ts`.
 *
 * The damage, as an older build left it: a blank at a letter's place in ohmail/Screener, filed there by
 * ohmail, which the fake mailbox serves the letter for at the targeted re-read.
 */

const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 61));
const UID = 7;
let DB = "";
type Db = ReturnType<typeof makeDb>;

async function seed(db: Db): Promise<{ mailboxId: string; blankId: string }> {
  const accountId = randomUUID();
  const [row] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: `${randomUUID()}@trafficflow.test`, ...ORGANIZER_CONSENT }).returning();
  const mailboxId = row!.id;
  const enc = await KP.encrypt("pw");
  await db.insert(mailboxCredentials).values({
    mailboxId, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
    meta: { host: "fake.invalid", port: 1143, secure: false, user: "u" },
  });
  // The fleet's epoch is "1", the one its targeted re-read answers under.
  const blankId = await db.transaction(async (tx) => {
    const r = makeDrizzleRepo(tx as never);
    const change: Change = { type: "create", locator: { folder: "ohmail/Screener", ref: `1:${UID}` }, raw: Buffer.from("\r\n"), seen: false };
    const plan = await planChange(change, { repo: r, accountId, mailboxId, readerMode: false });
    return (await commitChange(plan, { storageCap: UNMETERED_STORAGE_CAP, repo: r, accountId, mailboxId })).messageId;
  });
  await makeDrizzleRepo(db as never).upsertFolderState(blankId, {
    desiredFolder: "ohmail/Screener", observedFolder: "ohmail/Screener", lastSetBy: "us",
  });
  return { mailboxId, blankId };
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms: number, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out after ${ms}ms waiting for ${label}`);
}

describe("the worker's loop runs the blank repair in the mode OHMAIL_BLANK_REPAIR names", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_blankmode"); }, 120_000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of closers.splice(0)) { try { await c(); } catch { /* ignore */ } } }, ISOLATED_DB_RESET_BUDGET_MS);

  /** Several cycles of a worker in `mode`, then stopped: what the repair read and moved, and what is left. */
  async function run(mode: BlankRepairMode | undefined) {
    const db = makeDb(DB);
    const { mailboxId, blankId } = await seed(db);
    const fleet = new FakeAdapterFleet();
    fleet.targetedRetry = true;
    fleet.behave(mailboxId, {
      behindWatermark: [{ folder: "ohmail/Screener", uid: UID, from: "anna@x.example", subject: "hidden by a blank", messageId: "hidden@x.example" }],
    });
    const cfg: WorkerConfig = {
      databaseUrl: DB, keyProvider: KP, sentDomain: "trafficflow.test", adapterFactory: fleet.factory,
      pollIntervalMs: 150, rosterIntervalMs: 250, lockHeartbeatMs: 60_000, alertIntervalMs: 600_000,
      maxSyncFailures: 3, mailboxRetryMs: 60_000, syncBlockGraceMs: 0,
      ...(mode !== undefined ? { blankRepair: mode } : {}),
    };
    const worker = await startWorker(cfg);
    closers.push(() => worker.stop());
    await waitFor(() => fleet.syncs >= 4, 20_000, "four cycles");
    await worker.stop();
    const reads = fleet.targetedFetches.filter((f) => f.mailboxId === mailboxId && f.folder === "ohmail/Screener").length;
    const places = (await db.select({ uid: messageInstances.uid }).from(messageInstances).where(eq(messageInstances.messageId, blankId))).length;
    const owed = (await db.select({ uid: messageFailures.uid }).from(messageFailures).where(eq(messageFailures.mailboxId, mailboxId))).length;
    return { moves: fleet.movesFor(mailboxId), reads, places, owed };
  }

  it("off: nothing read, nothing moved, nothing written", async () => {
    expect(await run("off")).toEqual({ moves: [], reads: 0, places: 1, owed: 0 });
  }, 60_000);

  it("dry: the place read once over every cycle, nothing moved, nothing written", async () => {
    expect(await run("dry")).toEqual({ moves: [], reads: 1, places: 1, owed: 0 });
  }, 60_000);

  it("CONTROL: unset is apply — the letter goes back to INBOX and the blank lets go of its place", async () => {
    const r = await run(undefined);
    expect(r.moves).toContain("INBOX");
    expect(r).toMatchObject({ reads: 1, places: 0 });
  }, 60_000);
});
