import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { accounts, mailboxCredentials, mailboxes, messages, type Tx } from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { StaticKeyProvider } from "@trafficflow/core";
import { createLogger } from "@trafficflow/core/mail";
import { makeMailboxService, type ServiceContext } from "@trafficflow/services";
import { startWorker } from "../src/index.js";
import { syncKickPass } from "../src/sync-kick.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";

/**
 * "ORGANIZE HERE" WAKES THE PASS (VERIFY-026 L6). The press stamped only `takeover_authorized_at`,
 * so a served reader's gate saw it at the next roster pass and the cycle after it — 47 of the 64 s
 * tester A measured. The press now rings the doorbell, and the kick scan asks for a roster pass
 * before its cycle so the gate reads the press. Real Postgres: the stamp is compared as text.
 * The last case is the counterweight: the kick only ASKS, so two installs pressed within one
 * second still end with exactly one organizer — the fenced lease decides, not the doorbell.
 */

type Db = ReturnType<typeof makeDb>;
const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 7));
const svc = makeMailboxService({ keyProvider: KP, allowance: async () => { /* unmetered here */ } });
const PRODUCTION = { pollIntervalMs: 60_000, rosterIntervalMs: 30_000 };
/** The bound the brief sets for press -> claim; the roster interval alone is three times it. */
const CLAIM_WITHIN_MS = 10_000;

let DB = "";
let DB2 = "";

/** A handed-back mailbox: consent recorded, the row a reader, the release marker standing. */
async function handedBack(db: Db, fresh = false): Promise<ServiceContext & { mailboxId: string }> {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: "organize-here" });
  const [row] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `${randomUUID()}@trafficflow.test`,
    // `fresh`: a new person's mailbox, read and never agreed to.
    organizerRole: "reader", organizeConsentedAt: fresh ? null : new Date(Date.now() - 3_600_000),
    organizerReleasedAt: fresh ? null : new Date(Date.now() - 60_000),
  }).returning();
  const enc = await KP.encrypt("pw");
  await db.insert(mailboxCredentials).values({
    mailboxId: row!.id, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
    meta: { host: "fake.invalid", port: 1143, secure: false, user: "u" },
  });
  return { db, accountId, userId: null, now: () => new Date(), requestId: randomUUID(), mailboxId: row!.id };
}

const rowOf = async (db: Db, id: string) =>
  (await db.select().from(mailboxes).where(eq(mailboxes.id, id)))[0]!;

async function waitFor(pred: () => Promise<boolean>, ms: number, step = 50): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return false;
}

describe("Organize here wakes the pass", () => {
  beforeAll(async () => {
    DB = await prepareIsolatedDb("trafficflow_worker_orgwake");
    DB2 = await prepareIsolatedDb("trafficflow_worker_orgwake_b");
  }, 120_000);
  afterEach(async () => {
    for (const c of closers.splice(0)) await c().catch(() => undefined);
    await truncateAll(DB);
    await truncateAll(DB2);
  }, ISOLATED_DB_RESET_BUDGET_MS);
  afterAll(async () => { for (const c of closers.splice(0)) await c().catch(() => undefined); });
  const closers: Array<() => Promise<void>> = [];

  it("the press rings the doorbell, and the kick asks for a roster before the cycle", async () => {
    const db = makeDb(DB);
    const ctx = await handedBack(db);
    expect((await svc.organizeHere(ctx, ctx.mailboxId, { intent: "takeover" })).outcome).toBe("authorized");
    expect((await rowOf(db, ctx.mailboxId)).syncRequestedAt, "the press rang no doorbell").not.toBeNull();

    const order: string[] = [];
    const res = await syncKickPass({
      db: db as unknown as Tx, served: () => [ctx.mailboxId],
      kick: (id) => { order.push(`kick:${id}`); },
      leasePressed: (id) => { order.push(`roster:${id}`); },
    });
    expect(order, "the cycle would gate on the lease read before the press")
      .toEqual([`roster:${ctx.mailboxId}`, `kick:${ctx.mailboxId}`]);
    expect(res.cleared).toBe(1);

    // CONTROL: a doorbell with no press pending kicks and asks no roster.
    const other = await handedBack(db);
    await db.update(mailboxes).set({ syncRequestedAt: new Date() }).where(eq(mailboxes.id, other.mailboxId));
    const plain: string[] = [];
    await syncKickPass({
      db: db as unknown as Tx, served: () => [other.mailboxId],
      kick: (id) => { plain.push(`kick:${id}`); }, leasePressed: (id) => { plain.push(`roster:${id}`); },
    });
    expect(plain).toEqual([`kick:${other.mailboxId}`]);
  }, 60_000);

  it(`a served reader claims within ${CLAIM_WITHIN_MS / 1000} s of the press, at production intervals`, async () => {
    const db = makeDb(DB);
    const ctx = await handedBack(db);
    const fleet = new FakeAdapterFleet();
    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, ...PRODUCTION, sentDomain: "trafficflow.test",
      adapterFactory: fleet.factory,
      organizer: { installId: "cloud-orgwake", displayName: "Cloud", staleAfterMs: 60_000 },
    });
    closers.push(() => worker.stop());
    expect(await waitFor(async () => fleet.syncs > 0, 20_000), "the reader never synced").toBe(true);
    expect((await rowOf(db, ctx.mailboxId)).organizerRole).toBe("reader");

    const pressedAt = Date.now();
    expect((await svc.organizeHere(ctx, ctx.mailboxId, { intent: "takeover" })).outcome).toBe("authorized");
    const claimed = await waitFor(async () => (await rowOf(db, ctx.mailboxId)).organizerRole === "organizer", 40_000);
    const ms = Date.now() - pressedAt;
    process.stdout.write(`[orgwake] press -> claim ${ms} ms\n`);
    expect(claimed, "the press was never honoured").toBe(true);
    expect(ms, "the claim waited for the roster interval, not the kick").toBeLessThan(CLAIM_WITHIN_MS);
    expect(fleet.metaFor(ctx.mailboxId).appends).toBe(1);
  }, 90_000);

  it("the window step's agree gives every in-window letter to the Screener, the sweep carried across visits", async () => {
    const db = makeDb(DB);
    const ctx = await handedBack(db, true);
    const fleet = new FakeAdapterFleet();
    const old = new Date(Date.now() - 800 * 86_400_000);
    fleet.behave(ctx.mailboxId, {
      deliver: Array.from({ length: 14 }, (_, i) => ({
        from: "stranger@elsewhere.test", subject: `first mail ${i}`, messageId: `w${i}-${randomUUID()}@elsewhere.test`,
        internalDate: i >= 12 ? old : new Date(),
      })),
    });
    const lines: string[] = [];
    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 300, rosterIntervalMs: 200, sentDomain: "trafficflow.test",
      adapterFactory: fleet.factory, agreeSweepSlice: 1,
      logger: createLogger({ service: "worker", level: "info", sink: (line) => { lines.push(line); } }),
      organizer: { installId: "cloud-orgwake", displayName: "Cloud", staleAfterMs: 60_000 },
    });
    closers.push(() => worker.stop());
    const stored = async () => (await db.select({ id: messages.id }).from(messages)
      .where(eq(messages.mailboxId, ctx.mailboxId))).length;
    expect(await waitFor(async () => (await stored()) === 14, 20_000), "the reader did not import").toBe(true);

    expect((await svc.organizeHere(ctx, ctx.mailboxId, {
      intent: "takeover", screening: { dormancyDays: 365 }, screenBacklog: true,
    })).outcome).toBe("authorized");
    // Ten one-letter slices a visit: twelve letters need the cursor carried to a second visit.
    const screened = () => fleet.movesFor(ctx.mailboxId).filter((f) => f === "ohmail/Screener").length;
    expect(await waitFor(async () => screened() === 12, 40_000), `moved ${screened()} of 12`).toBe(true);
    await new Promise((r) => setTimeout(r, 1_000));
    expect(screened(), "an older letter left the Inbox").toBe(12);
    const sweeps = lines.filter((l) => l.includes('"organizer_agree_sweep"')).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(sweeps.map((l) => [l.moved, l.done])).toEqual([[10, false], [2, true]]);
  }, 90_000);

  /* THE COUNTERWEIGHT. Two installs (two hosted databases, two install ids) over ONE `_meta`, both
     pressed within the same second: each kick asks for a pass, and the lease alone decides. */
  for (const intent of ["join", "takeover"] as const) {
    it(`two installs pressed within one second (${intent}): exactly one organizes`, async () => {
      const dbA = makeDb(DB);
      const dbB = makeDb(DB2);
      const a = await handedBack(dbA);
      const b = await handedBack(dbB);
      const fleetA = new FakeAdapterFleet();
      const fleetB = new FakeAdapterFleet();
      fleetB.meta.set(b.mailboxId, fleetA.metaFor(a.mailboxId));
      const boot = (url: string, fleet: FakeAdapterFleet, installId: string) => startWorker({
        databaseUrl: url, keyProvider: KP, pollIntervalMs: 3_000, rosterIntervalMs: 30_000,
        sentDomain: "trafficflow.test", adapterFactory: fleet.factory,
        organizer: { installId, displayName: installId, staleAfterMs: 60_000 },
      });
      const wA = await boot(DB, fleetA, "cloud-orgwake-a");
      closers.push(() => wA.stop());
      const wB = await boot(DB2, fleetB, "cloud-orgwake-b");
      closers.push(() => wB.stop());
      expect(await waitFor(async () => fleetA.syncs > 0 && fleetB.syncs > 0, 20_000)).toBe(true);

      await svc.organizeHere(a, a.mailboxId, { intent });
      await new Promise((r) => setTimeout(r, 300));
      await svc.organizeHere(b, b.mailboxId, { intent });

      const roles = async () => [
        (await rowOf(dbA, a.mailboxId)).organizerRole, (await rowOf(dbB, b.mailboxId)).organizerRole,
      ];
      expect(await waitFor(async () => (await roles()).includes("organizer"), 15_000), "nobody claimed").toBe(true);
      // Several polls of both workers, so a loser that claimed first has re-gated and stood down.
      await new Promise((r) => setTimeout(r, 12_000));
      for (let i = 0; i < 3; i++) {
        const now = await roles();
        expect(now.filter((r) => r === "organizer"), `two organizers: ${now.join(", ")}`).toHaveLength(1);
        await new Promise((r) => setTimeout(r, 3_500));
      }
      process.stdout.write(`[orgwake] ${intent}: organizer is ${(await roles())[0] === "organizer" ? "A (first press)" : "B (second press)"}\n`);
    }, 120_000);
  }
});
