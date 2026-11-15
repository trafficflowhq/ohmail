import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { accounts, flagState, mailboxCredentials, mailboxes, messageInstances, messages } from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { StaticKeyProvider, type LogFields } from "@trafficflow/core";
import type { NativeLocator } from "@trafficflow/core";
import type { MailboxAdapter, WriteDoor, WriteDoorAnswer } from "@trafficflow/core/adapters/imap";
import { formatClaim } from "@trafficflow/core/adapters/organizer-lease";
import { startWorker } from "../src/index.js";
import { hasLeaseIo } from "../src/lease.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";

/**
 * A READER CYCLE ON THE HOSTED WORKER RIDES A READER'S AUTHORITY — never an old permit, never none.
 *
 * `visitMailbox` handed `runSyncCycle` `rt.leasePermit` whatever its gate answered, and the gate
 * writes that field only when it organizes. A demoted runtime carried its pre-demotion permit, whose
 * page check re-ran the lease WRITE gate from a reader cycle: over a live rival it stood down and the
 * cycle failed with the read mark unpushed; over a released folder it appended a Cloud claim nobody
 * pressed for. A reader that never organized carried the attach seed, which the door admitted for a
 * move. Real worker, real Postgres (the lane db), the fake fleet's real in-memory `_meta`.
 */

type Db = ReturnType<typeof makeDb>;
const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 9));
let DB = "";

async function seedMailbox(db: Db, consented: boolean): Promise<{ accountId: string; mailboxId: string }> {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: "reader-authority" });
  const [row] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `${randomUUID()}@trafficflow.test`,
    organizerRole: consented ? "organizer" : "reader",
    organizeConsentedAt: consented ? new Date(Date.now() - 60 * 60 * 1000) : null,
  }).returning();
  const enc = await KP.encrypt("pw");
  await db.insert(mailboxCredentials).values({
    mailboxId: row!.id, accountId: row!.accountId, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
    meta: { host: "fake.invalid", port: 1143, secure: false, user: "u" },
  });
  return { accountId, mailboxId: row!.id };
}

/** One message and one pending read mark this install owes the server — the reader's one write. */
async function seedPendingReadMark(db: Db, mb: { accountId: string; mailboxId: string }): Promise<NativeLocator> {
  const tag = randomUUID().slice(0, 8);
  const locator: NativeLocator = { folder: "INBOX", ref: "1:10" };
  const [m] = await db.insert(messages).values({
    accountId: mb.accountId, mailboxId: mb.mailboxId, dedupKey: `mid:<ra-${tag}@example.test>`,
    messageIdHeader: `ra-${tag}@example.test`, fromAddress: "someone@example.test", subject: "s",
    bodyHash: `ra-hash-${tag}`, nativeLocator: locator, unread: false,
  }).returning();
  await db.insert(flagState).values({
    messageId: m!.id, accountId: m!.accountId, desiredSeen: true, observedSeen: false, lastSetBy: "us",
    reconcileStatus: "pending", conflict: false, attempts: 0, nextAttemptAt: null,
  });
  await db.insert(messageInstances).values({
    accountId: mb.accountId, messageId: m!.id, mailboxId: mb.mailboxId, folder: "INBOX", uid: 10,
    uidvalidity: 1n, isPrimary: true,
  });
  return locator;
}

async function waitFor(pred: () => Promise<boolean> | boolean, ms = 15_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

async function roleOf(db: Db, mailboxId: string): Promise<string> {
  const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId));
  return row!.organizerRole;
}

function recordingLogger() {
  const events: Array<{ event: string; fields: LogFields }> = [];
  function mk(bound: LogFields) {
    const push = (event: string, fields?: LogFields): void => { events.push({ event, fields: { ...bound, ...fields } }); };
    return { level: "debug" as const, child: (f: LogFields) => mk({ ...bound, ...f }), debug: push, info: push, warn: push, error: push };
  }
  return { events, logger: mk({}) };
}

/** What each `\Seen` push was handed, asked about a move and about itself; and every gate read. */
interface Seen { doors: Array<{ move: WriteDoorAnswer; seen: WriteDoorAnswer }>; gateReads: number }

/** The fleet's adapter, with the door of every `setFlags` asked two questions and the gate's reads counted. */
function recordingFactory(fleet: FakeAdapterFleet, seen: Seen): FakeAdapterFleet["factory"] {
  return (cfg, ctx) => {
    const adapter = fleet.factory(cfg, ctx);
    if (!hasLeaseIo(adapter)) throw new Error("the fake fleet's adapter hands out no leaseIo");
    const bind = <T extends object>(t: T, k: string | symbol): unknown => {
      const v = Reflect.get(t, k);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    };
    return new Proxy(adapter, {
      get(target, key) {
        if (key === "setFlags") {
          return async (loc: NativeLocator, flags: { seen: boolean }, door: WriteDoor): Promise<void> => {
            seen.doors.push({ move: door.ask("move"), seen: door.ask("seen") });
            await target.setFlags(loc, flags, door);
          };
        }
        if (key === "leaseIo") {
          return (identity: { installId: string; mailboxId: string }) => {
            const io = target.leaseIo(identity);
            return new Proxy(io, {
              get(t, k) {
                if (k === "listClaims") return async () => { seen.gateReads++; return t.listClaims(); };
                return bind(t, k);
              },
            });
          };
        }
        return bind(target, key);
      },
    }) as MailboxAdapter;
  };
}

const RIVAL = "a-desktop-install";
const pressedRival = (): string => formatClaim({
  authorizedAt: new Date(), capabilities: [], installId: RIVAL, kind: "local",
  displayName: "Desktop", heartbeat: new Date(), claimedAt: new Date(), nonce: "rival-1",
});

describe("a reader cycle on the hosted worker rides a reader's authority", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_reader_authority"); }, 120_000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c().catch(() => undefined); }, ISOLATED_DB_RESET_BUDGET_MS);

  /** Organize, then be taken over by a pressed local install; returns once demoted and our claim is gone. */
  async function organizedThenDemoted(db: Db, fleet: FakeAdapterFleet, seen: Seen) {
    const mb = await seedMailbox(db, true);
    const { events, logger } = recordingLogger();
    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 200, rosterIntervalMs: 60_000,
      sentDomain: "trafficflow.test", adapterFactory: recordingFactory(fleet, seen), logger,
      organizer: { installId: "cloud-test", displayName: "Cloud", staleAfterMs: 60_000 },
    });
    closers.push(() => worker.stop());
    const ours = (): number => fleet.metaFor(mb.mailboxId).messages.filter((m) => m.raw.includes("cloud-test")).length;
    expect(await waitFor(() => ours() === 1 && fleet.syncs > 1), "Cloud never organized the mailbox").toBe(true);
    fleet.seedClaim(mb.mailboxId, pressedRival());
    expect(await waitFor(async () => (await roleOf(db, mb.mailboxId)) === "reader"), "the takeover did not demote").toBe(true);
    expect(await waitFor(() => ours() === 0), "the demoted worker kept its claim").toBe(true);
    return { mb, worker, events, ours };
  }

  function expectReaderDoor(seen: Seen): void {
    expect.soft(seen.doors.length, "no read mark was pushed, so the door was never handed").toBeGreaterThan(0);
    for (const d of seen.doors) {
      expect.soft(d.seen, "a reader's own write was refused").toEqual({ admit: true });
      expect.soft(d.move, "the door a reader cycle hands the adapter admits a MOVE").toEqual({ admit: false, reason: "no_lease" });
    }
  }

  it("demoted in place, the rival still holding: the read mark is pushed and the cycle does not fail", async () => {
    const fleet = new FakeAdapterFleet();
    const seen: Seen = { doors: [], gateReads: 0 };
    const db = makeDb(DB);
    const { mb, worker, events } = await organizedThenDemoted(db, fleet, seen);
    const gateReadsDemoted = seen.gateReads;
    const loc = await seedPendingReadMark(db, mb);
    expect.soft(await waitFor(() => fleet.flagWrites.some((w) => w.mailboxId === mb.mailboxId && w.locator.ref === loc.ref)),
      "the reader's read mark never reached the server").toBe(true);
    expectReaderDoor(seen);
    expect.soft(seen.gateReads, "a reader cycle ran the lease's write gate").toBe(gateReadsDemoted);
    const failed = events.filter((e) => e.event === "sync_cycle_failed" && e.fields.mailboxId === mb.mailboxId);
    expect.soft(failed.map((e) => String(e.fields.err ?? "")), "a reader cycle was counted as a failing mailbox").toEqual([]);
    expect.soft(worker.stats().quarantined).toBe(0);
    expect(await roleOf(db, mb.mailboxId)).toBe("reader");
  }, 60_000);

  it("demoted in place, the rival released: the read mark is pushed and no claim is appended", async () => {
    const fleet = new FakeAdapterFleet();
    const seen: Seen = { doors: [], gateReads: 0 };
    const db = makeDb(DB);
    const { mb, ours } = await organizedThenDemoted(db, fleet, seen);
    const meta = fleet.metaFor(mb.mailboxId);
    await meta.removeClaims(meta.messages.map((m) => m.ref));
    const appendsReleased = meta.appends;
    const gateReadsReleased = seen.gateReads;
    const loc = await seedPendingReadMark(db, mb);
    expect.soft(await waitFor(() => fleet.flagWrites.some((w) => w.mailboxId === mb.mailboxId && w.locator.ref === loc.ref)),
      "the reader's read mark never reached the server").toBe(true);
    await new Promise((r) => setTimeout(r, 800));
    expectReaderDoor(seen);
    expect.soft(ours(), "a reader appended a Cloud claim nobody pressed for").toBe(0);
    expect.soft(meta.appends, "a reader appended to ohmail/_meta").toBe(appendsReleased);
    expect.soft(seen.gateReads, "a reader cycle ran the lease's write gate").toBe(gateReadsReleased);
    expect(await roleOf(db, mb.mailboxId)).toBe("reader");
  }, 60_000);

  it("attached as a reader and never promoted: the read mark rides a reader's door, not the attach seed", async () => {
    const fleet = new FakeAdapterFleet();
    const seen: Seen = { doors: [], gateReads: 0 };
    const db = makeDb(DB);
    const mb = await seedMailbox(db, false);
    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 200, rosterIntervalMs: 60_000,
      sentDomain: "trafficflow.test", adapterFactory: recordingFactory(fleet, seen),
      organizer: { installId: "cloud-test", displayName: "Cloud", staleAfterMs: 60_000 },
    });
    closers.push(() => worker.stop());
    expect(await waitFor(() => fleet.syncs > 0), "the reader never cycled").toBe(true);
    const loc = await seedPendingReadMark(db, mb);
    expect.soft(await waitFor(() => fleet.flagWrites.some((w) => w.mailboxId === mb.mailboxId && w.locator.ref === loc.ref)),
      "the reader's read mark never reached the server").toBe(true);
    expectReaderDoor(seen);
    expect.soft(seen.gateReads, "a consent-less reader ran the lease's write gate").toBe(0);
    expect.soft(fleet.metaFor(mb.mailboxId).appends).toBe(0);
  }, 60_000);
});
