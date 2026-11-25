import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq, inArray } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import type { HeartbeatInput } from "@trafficflow/db/cloud";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { accounts, mailboxes } from "@trafficflow/db";
import { pushSubscriptions, schema, workerHeartbeats, writeHeartbeat } from "@trafficflow/db/cloud";
import {
  clearOrganizerStandDown, deleteParkedPushRows, markMailboxReleased, markMailboxStoodDown,
  markMailboxSyncBlocked, resumeParkedMailbox, type LeaderFence,
} from "../src/mailboxes.js";

/**
 * THE WALL'S MARKER AND ITS RESUME ON REAL POSTGRES (mail 0135). The writers here are FENCED, which
 * is a `SELECT … FOR UPDATE` then the write in one transaction — a shape PGlite answers by
 * construction. Each case seeds its own account and reads only its own rows.
 */

const AVAILABLE = await realPgAvailable();
const SHARD = 95;
const A: LeaderFence = { shardIndex: SHARD, instanceId: "wkr-park-A" };
const B: LeaderFence = { shardIndex: SHARD, instanceId: "wkr-park-B" };
const PARKED = new Date("2026-09-23T02:15:07.000Z");
const PAID = new Date("2026-09-28T05:49:40.000Z");

const beatOf = (instanceId: string): HeartbeatInput => ({
  shardIndex: SHARD, instanceId, shards: 1, mailboxes: 1, expected: 1, accounts: 1, quarantined: 0,
  aiCircuitOpenSince: null, degraded: false, lastCycleAt: null, startedAt: new Date(),
});

describe.skipIf(!AVAILABLE)("the wall's marker and its resume, fenced", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let sql: ReturnType<typeof postgres>;
  const seeded: string[] = [];

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    sql = postgres(PG_TEST_URL, { max: 2, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg");
  }, 60_000);

  beforeEach(async () => {
    await db.delete(workerHeartbeats).where(eq(workerHeartbeats.shardIndex, SHARD));
    await writeHeartbeat(db, beatOf(A.instanceId));
  });

  afterAll(async () => {
    if (!AVAILABLE) return;
    await db.delete(workerHeartbeats).where(eq(workerHeartbeats.shardIndex, SHARD));
    if (seeded.length > 0) {
      await db.delete(pushSubscriptions).where(inArray(pushSubscriptions.accountId, seeded));
      await db.delete(mailboxes).where(inArray(mailboxes.accountId, seeded));
      await db.delete(accounts).where(inArray(accounts.id, seeded));
    }
    await sql.end();
  });

  const seed = async (values: Partial<typeof mailboxes.$inferInsert>): Promise<string> => {
    const accountId = randomUUID();
    seeded.push(accountId);
    await db.insert(accounts).values({ id: accountId, name: `park-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `park-${accountId.slice(0, 8)}@example.test`,
      organizeConsentedAt: new Date("2026-08-01T00:00:00.000Z"), ...values,
    }).returning();
    return mb!.id;
  };
  const rowOf = async (id: string) => (await db.select().from(mailboxes).where(eq(mailboxes.id, id)))[0]!;

  it("the park writes the marker at the release's own instant; the person's release writes none", async () => {
    const walled = await seed({ organizerRole: "organizer" });
    expect(await markMailboxReleased(db, walled, { fence: A, now: PARKED, cause: "account_parked" })).toBe(true);
    const w = await rowOf(walled);
    expect(w.organizerRole).toBe("reader");
    expect(w.organizerParkedAt?.toISOString()).toBe(PARKED.toISOString());
    expect(w.organizerReleasedAt?.toISOString()).toBe(PARKED.toISOString());

    const stopped = await seed({ organizerRole: "organizer", releaseRequestedAt: PARKED, organizerParkedAt: PARKED });
    expect(await markMailboxReleased(db, stopped, { fence: A, now: PAID })).toBe(true);
    expect((await rowOf(stopped)).organizerParkedAt, "a person's stop clears any marker").toBeNull();
  });

  it("reopening keeps a mailbox waiting for a new sign-in", async () => {
    const failedAt = new Date(PARKED.getTime() - 48 * 60 * 60_000);
    const id = await seed({
      organizerRole: "organizer", status: "error", errorCode: "auth", failedAt, retryCount: 12,
    });

    expect(await markMailboxReleased(db, id, { fence: A, now: PARKED, cause: "account_parked" })).toBe(true);
    expect(await resumeParkedMailbox(db, id, { fence: A, now: PAID })).toBe(true);
    expect(await rowOf(id)).toMatchObject({ status: "error", errorCode: "auth", failedAt, retryCount: 12 });
  });

  it("the resume writes one JOIN under the fence, and none over a stamp, a stop, no consent or another leader", async () => {
    const id = await seed({ organizerRole: "reader", organizerParkedAt: PARKED });
    expect(await resumeParkedMailbox(db, id, { fence: A, now: PAID })).toBe(true);
    const r = await rowOf(id);
    expect(r.takeoverAuthorizedAt?.toISOString()).toBe(PAID.toISOString());
    expect(r.takeoverIntent).toBe("join");
    expect(r.syncRequestedAt?.toISOString()).toBe(PAID.toISOString());
    expect(r.organizerRole, "a request, never the role").toBe("reader");
    expect(r.organizerParkedAt, "the marker waits for the stamp to be spent").not.toBeNull();
    expect(await resumeParkedMailbox(db, id, { fence: A, now: new Date(PAID.getTime() + 30_000) }),
      "an unspent stamp is not stamped again").toBe(false);
    expect((await rowOf(id)).takeoverAuthorizedAt?.toISOString()).toBe(PAID.toISOString());

    const asked = await seed({ organizerRole: "reader", organizerParkedAt: PARKED, releaseRequestedAt: PAID });
    const unconsented = await seed({ organizerRole: "reader", organizerParkedAt: PARKED, organizeConsentedAt: null });
    const unmarked = await seed({ organizerRole: "reader", organizerReleasedAt: PARKED });
    const organizing = await seed({ organizerRole: "organizer", organizerParkedAt: PARKED });
    for (const other of [asked, unconsented, unmarked, organizing]) {
      expect(await resumeParkedMailbox(db, other, { fence: A, now: PAID })).toBe(false);
      expect((await rowOf(other)).takeoverAuthorizedAt).toBeNull();
    }
    const fenced = await seed({ organizerRole: "reader", organizerParkedAt: PARKED });
    expect(await resumeParkedMailbox(db, fenced, { fence: B, now: PAID }), "B does not lead the shard").toBe(false);
    expect((await rowOf(fenced)).takeoverAuthorizedAt).toBeNull();
  });

  it("the promotion and the stand-down that answer the join each spend the marker", async () => {
    const won = await seed({ organizerRole: "reader", organizerParkedAt: PARKED });
    await resumeParkedMailbox(db, won, { fence: A, now: PAID });
    expect(await clearOrganizerStandDown(db, won, { fence: A, now: PAID, asRead: await rowOf(won) })).toBe(true);
    const w = await rowOf(won);
    expect([w.organizerRole, w.organizerParkedAt, w.takeoverAuthorizedAt]).toEqual(["organizer", null, null]);

    const lost = await seed({ organizerRole: "reader", organizerParkedAt: PARKED });
    await resumeParkedMailbox(db, lost, { fence: A, now: PAID });
    expect(await markMailboxStoodDown(db, lost, "organized_elsewhere:local", {
      fence: A, now: PAID, asRead: await rowOf(lost), by: { kind: "local", installId: "a-desktop" },
    })).toBe(true);
    const l = await rowOf(lost);
    expect([l.organizerRole, l.organizerParkedAt, l.takeoverAuthorizedAt]).toEqual(["reader", null, null]);
    expect(await resumeParkedMailbox(db, lost, { fence: A, now: new Date(PAID.getTime() + 30_000) }),
      "a lost join is never asked again").toBe(false);
  });

  /* THE WALL'S BLOCK LANDS ONLY ON A ROW NOT KICKED SINCE THE ROSTER READ IT. The door clears the
     block and kicks in one statement, so a clear that commits between a roster pass's read and its
     write moves the stamp, and the write must not put the block back over it. */
  const kickOf = async (id: string): Promise<string | null> =>
    ((await sql`select sync_requested_at::text as k from mailboxes where id = ${id}`)[0] as { k: string | null }).k;

  it("the account_closed write refuses a row the door cleared after the roster read it", async () => {
    const id = await seed({ organizerRole: "reader", organizerParkedAt: PARKED });
    const asRead = await kickOf(id);                                       // the roster's read: no kick
    await db.update(mailboxes)                                             // the door, mid-pass
      .set({ syncBlockedReason: null, syncBlockedSince: null, syncRequestedAt: PAID })
      .where(eq(mailboxes.id, id));
    expect(await markMailboxSyncBlocked(db, id, "account_closed", { fence: A, kickAsRead: asRead })).toBe(false);
    expect((await rowOf(id)).syncBlockedReason, "the door's clear stands").toBeNull();
  });

  it("…and lands while the stamp is the one it read, a microsecond stamp included (the control)", async () => {
    const quiet = await seed({ organizerRole: "reader", organizerParkedAt: PARKED });
    expect(await markMailboxSyncBlocked(db, quiet, "account_closed", { fence: A, kickAsRead: await kickOf(quiet) }))
      .toBe(true);
    expect((await rowOf(quiet)).syncBlockedReason).toBe("account_closed");
    const kicked = await seed({ organizerRole: "reader", organizerParkedAt: PARKED });
    await sql`update mailboxes set sync_requested_at = now() where id = ${kicked}`;   // µs, the DB's own clock
    expect(await markMailboxSyncBlocked(db, kicked, "account_closed", { fence: A, kickAsRead: await kickOf(kicked) }))
      .toBe(true);
    expect((await rowOf(kicked)).syncBlockedReason).toBe("account_closed");
  });

  /* THE PUSH ROWS GO WITH THE BLOCK, read by the delete itself: a pass that decided on a refusal
     from before the door's clear cannot take a subscription the lift made after it. */
  it("push rows go only while every live mailbox of the account says account_closed", async () => {
    const pushOf = async (accountId: string) =>
      (await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.accountId, accountId))).length;
    const closedRow = { organizerRole: "reader" as const, syncBlockedReason: "account_closed", syncBlockedSince: PARKED };
    const blocked = await seed(closedRow);
    const [bAcct] = await db.select({ a: mailboxes.accountId }).from(mailboxes).where(eq(mailboxes.id, blocked));
    // A tombstone of the same account does not hold the delete back.
    await db.insert(mailboxes).values({
      accountId: bAcct!.a, provider: "imap", address: `gone-${randomUUID().slice(0, 8)}@example.test`, status: "disabled",
    });
    await db.insert(pushSubscriptions).values({ accountId: bAcct!.a, transport: "webpush", endpoint: "https://p/1" });
    expect(await deleteParkedPushRows(db, [bAcct!.a])).toBe(1);
    expect(await pushOf(bAcct!.a)).toBe(0);

    const reopened = await seed(closedRow);
    const [rAcct] = await db.select({ a: mailboxes.accountId }).from(mailboxes).where(eq(mailboxes.id, reopened));
    await db.update(mailboxes).set({ syncBlockedReason: null, syncBlockedSince: null, syncRequestedAt: PAID })
      .where(eq(mailboxes.id, reopened));                                   // the door's clear
    await db.insert(pushSubscriptions).values({ accountId: rAcct!.a, transport: "webpush", endpoint: "https://p/2" });
    expect(await deleteParkedPushRows(db, [rAcct!.a]), "the lift's subscription stands").toBe(0);
    expect(await pushOf(rAcct!.a)).toBe(1);
  });
});
