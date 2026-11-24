import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { accounts, mailboxCredentials, mailboxes, recordChange } from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { StaticKeyProvider, createLogger } from "@trafficflow/core";
import { SYNC_KICK_EVERY_MS, startWorker } from "../src/index.js";
import { loadConfig } from "../src/config.js";
import { SYNC_KICK_SIGNAL_GAP_MS } from "../src/sync-kick.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { FakeAdapterFleet } from "../../../packages/organizer/test/_fakeadapter.js";

/**
 * THE DOORBELL ON A LIVE WORKER, real Postgres: the signal is a NOTIFY the worker hears on its own
 * LISTEN, which no stand-in sends. The poll and the roster stand at production's intervals, so
 * whatever serves a stamp here inside two seconds is the bell.
 */

type Db = ReturnType<typeof makeDb>;
const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 7));
const PRODUCTION = { pollIntervalMs: 60_000, rosterIntervalMs: 30_000 };
/** Longer than any case: with this floor only a signal can have served a stamp. */
const NO_FLOOR_MS = 10 * 60_000;

let DB = "";

async function mailbox(db: Db, status: "connected" | "disabled" = "connected"): Promise<{ accountId: string; mailboxId: string }> {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: "doorbell" });
  const [row] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `${randomUUID()}@trafficflow.test`, status, organizerRole: "reader",
  }).returning();
  const enc = await KP.encrypt("pw");
  await db.insert(mailboxCredentials).values({
    mailboxId: row!.id, accountId: row!.accountId, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
    meta: { host: "fake.invalid", port: 1143, secure: false, user: "u" },
  });
  return { accountId, mailboxId: row!.id };
}

const stampOf = async (db: Db, id: string): Promise<Date | null> =>
  (await db.select({ at: mailboxes.syncRequestedAt }).from(mailboxes).where(eq(mailboxes.id, id)))[0]!.at;

/** The stamp as its writers leave it; `signalled` appends to the change log in the same commit, as a send does. */
async function stamp(db: Db, m: { accountId: string; mailboxId: string }, signalled: boolean): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(mailboxes).set({ syncRequestedAt: sql`now()` }).where(eq(mailboxes.id, m.mailboxId));
    if (signalled) await recordChange(tx as never, { accountId: m.accountId, entityType: "folder", entityId: m.mailboxId, op: "update", meta: null });
  });
}

async function waitFor(pred: () => Promise<boolean>, ms: number, step = 25): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await pred()) return true;
    await new Promise((r) => { setTimeout(r, step); });
  }
  return false;
}

describe("the doorbell on a live worker", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_kickbell"); }, 120_000);
  afterEach(async () => {
    for (const c of closers.splice(0)) await c().catch(() => undefined);
    await truncateAll(DB);
  }, ISOLATED_DB_RESET_BUDGET_MS);
  afterAll(async () => { for (const c of closers.splice(0)) await c().catch(() => undefined); });
  const closers: Array<() => Promise<void>> = [];

  /** The worker's own log lines, through the real logger. */
  let lines: Array<Record<string, unknown>> = [];
  const said = (event: string): Array<Record<string, unknown>> => lines.filter((l) => l.event === event);

  async function worker(syncKickFloorMs: number): Promise<FakeAdapterFleet> {
    const fleet = new FakeAdapterFleet();
    lines = [];
    const w = await startWorker({
      databaseUrl: DB, keyProvider: KP, ...PRODUCTION, syncKickFloorMs, sentDomain: "trafficflow.test",
      adapterFactory: fleet.factory,
      logger: createLogger({ service: "worker", level: "info", sink: (l) => lines.push(JSON.parse(l) as Record<string, unknown>) }),
      organizer: { installId: "cloud-kickbell", displayName: "Cloud", staleAfterMs: 60_000 },
    });
    closers.push(() => w.stop());
    return fleet;
  }

  it("ships a three-second floor under a one-second gap, and no setting moves the floor", () => {
    expect([SYNC_KICK_EVERY_MS, SYNC_KICK_SIGNAL_GAP_MS]).toEqual([3_000, 1_000]);
    expect(loadConfig({ DATABASE_URL_SESSION: "postgres://u:p@127.0.0.1:1/none" }).syncKickFloorMs).toBeUndefined();
  });

  it("a stamp whose writer signalled in its commit is served on the signal, with no floor to wait for", async () => {
    const db = makeDb(DB);
    const m = await mailbox(db);
    const fleet = await worker(NO_FLOOR_MS);
    expect(await waitFor(async () => fleet.syncs > 0, 20_000), "the mailbox never synced").toBe(true);
    // The LISTEN is dialled when the worker starts; a signal sent before it stands is the floor's.
    await new Promise((r) => { setTimeout(r, 1_500); });
    const before = fleet.syncs;

    const at = Date.now();
    await stamp(db, m, true);
    const served = await waitFor(async () => (await stampOf(db, m.mailboxId)) === null, 2_000);
    process.stdout.write(`[doorbell] stamp -> served ${Date.now() - at} ms\n`);
    expect(served, "the signal rang nothing: the stamp waits for a floor ten minutes away").toBe(true);
    expect(await waitFor(async () => fleet.syncs > before, 5_000), "the kick asked for no cycle").toBe(true);
    // What an operator reads: the bell said it started, and the scan said what rang it (written once
    // the stamp's clearing returns, so it is waited for as the stamp was).
    await waitFor(async () => said("sync_kick").length > 0, 5_000);
    expect(said("sync_doorbell_started").map((l) => [l.everyMs, l.ms, l.droppedFields])).toEqual([[NO_FLOOR_MS, SYNC_KICK_SIGNAL_GAP_MS, undefined]]);
    expect(said("sync_kick").map((l) => [l.kind, l.count, l.cleared, l.droppedFields])).toEqual([["signal", 1, 1, undefined]]);
  }, 60_000);

  it("a stamp written with no signal is served by the floor", async () => {
    const db = makeDb(DB);
    const m = await mailbox(db);
    const fleet = await worker(400);
    expect(await waitFor(async () => fleet.syncs > 0, 20_000), "the mailbox never synced").toBe(true);
    const before = fleet.syncs;
    await stamp(db, m, false);
    expect(await waitFor(async () => (await stampOf(db, m.mailboxId)) === null, 4_000), "the floor never scanned").toBe(true);
    expect(await waitFor(async () => fleet.syncs > before, 5_000), "the kick asked for no cycle").toBe(true);
    await waitFor(async () => said("sync_kick").length > 0, 5_000);
    expect(said("sync_kick").map((l) => [l.kind, l.count])).toEqual([["floor", 1]]);
  }, 60_000);

  it("a signal for a mailbox this worker does not serve kicks nothing and clears nothing", async () => {
    const db = makeDb(DB);
    const served = await mailbox(db);
    const away = await mailbox(db, "disabled");
    const fleet = await worker(NO_FLOOR_MS);
    expect(await waitFor(async () => fleet.syncs > 0, 20_000), "the served mailbox never synced").toBe(true);
    await new Promise((r) => { setTimeout(r, 1_500); });

    const dialled = fleet.connects;
    const synced = fleet.syncs;
    await stamp(db, away, true);
    await new Promise((r) => { setTimeout(r, 1_500); });
    expect(await stampOf(db, away.mailboxId), "a stamp on a mailbox nobody here serves was cleared").not.toBeNull();
    expect([fleet.connects, fleet.syncs], "a signal for another mailbox dialled or cycled something").toEqual([dialled, synced]);
    expect(said("sync_kick"), "a signal for an account with no mailbox here started a scan").toEqual([]);

    // CONTROL: the bell was live all along. Its scan reads the served set, so the other stamp still stands.
    await stamp(db, served, true);
    expect(await waitFor(async () => (await stampOf(db, served.mailboxId)) === null, 2_000), "the bell was not live").toBe(true);
    expect(await stampOf(db, away.mailboxId)).not.toBeNull();
  }, 60_000);
});
