import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { accounts, lockAccountMailboxes, mailboxes, type Tx } from "@trafficflow/db";
import { carryDialect } from "@trafficflow/db/dialect";
import { accountLifecycleNotices, makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import type { ServiceContext } from "@trafficflow/services";
import { reopenedCatchUp, resumeAfterReopen } from "../src/account-reopen.js";
import type { ApiDeps } from "../src/deps.js";

/**
 * THE REOPENING DOOR'S TRANSACTION ON REAL POSTGRES (mail 0135). The block clear and the `join`
 * commit together behind the account's erasure fence — a real `BEGIN` with a real row lock, which
 * PGlite answers by construction. Every row is scoped to this file's own accounts, and removed after.
 */

const AVAILABLE = await realPgAvailable();
const PARKED = new Date("2026-09-23T02:15:07.000Z");
const NOW = new Date("2026-09-28T05:49:41.000Z");

describe.skipIf(!AVAILABLE)("the reopening door on real Postgres", () => {
  let owned: OwnedDb;
  let db: OwnedDb["db"];
  const seeded: string[] = [];

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    owned = makeOwnedDb(PG_TEST_URL);
    db = owned.db;
  }, 180_000);

  afterAll(async () => {
    if (!AVAILABLE) return;
    if (seeded.length > 0) {
      await db.delete(accountLifecycleNotices).where(inArray(accountLifecycleNotices.accountId, seeded));
      await db.delete(mailboxes).where(inArray(mailboxes.accountId, seeded));
      await db.delete(accounts).where(inArray(accounts.id, seeded));
    }
    await owned?.close().catch(() => {});
  });

  async function world() {
    const [acct] = await db.insert(accounts).values({ name: `reopen-${randomUUID().slice(0, 8)}` }).returning();
    const accountId = acct!.id;
    seeded.push(accountId);
    const row = async (extra: Partial<typeof mailboxes.$inferInsert>) => (await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `reopen-${randomUUID().slice(0, 8)}@example.invalid`,
      organizerRole: "reader", organizeConsentedAt: new Date("2026-08-01T00:00:00.000Z"),
      syncBlockedReason: "account_closed", syncBlockedSince: PARKED, ...extra,
    }).returning({ id: mailboxes.id }))[0]!.id;
    const deps = { db, now: () => NOW } as unknown as ApiDeps;
    const ctx = { accountId, db, now: () => NOW } as unknown as ServiceContext;
    return {
      accountId, deps, ctx,
      walled: await row({ organizerParkedAt: PARKED, organizerReleasedAt: PARKED }),
      stopped: await row({ organizerReleasedAt: PARKED }),
    };
  }
  const rowOf = async (id: string) => (await db.select().from(mailboxes).where(eq(mailboxes.id, id)))[0]!;

  it("clears account_closed and stamps the wall's release as a join, in one transaction", async () => {
    const w = await world();
    await resumeAfterReopen(w.deps, w.ctx);
    const walled = await rowOf(w.walled);
    expect([walled.syncBlockedReason, walled.syncBlockedSince]).toEqual([null, null]);
    expect(walled.takeoverAuthorizedAt?.toISOString()).toBe(NOW.toISOString());
    expect(walled.takeoverIntent).toBe("join");
    expect(walled.syncRequestedAt?.toISOString()).toBe(NOW.toISOString());
    const stopped = await rowOf(w.stopped);
    expect(stopped.syncBlockedReason).toBeNull();
    expect(stopped.takeoverAuthorizedAt, "the person's stop is never asked back").toBeNull();
  });

  it("an ERASED account's fence refuses both writes, and the read still answers", async () => {
    const w = await world();
    await db.update(accounts).set({ erasedAt: NOW }).where(eq(accounts.id, w.accountId));
    await expect(resumeAfterReopen(w.deps, w.ctx)).resolves.toBeUndefined();
    const walled = await rowOf(w.walled);
    expect(walled.syncBlockedReason, "nothing is written behind the sweep").toBe("account_closed");
    expect(walled.takeoverAuthorizedAt).toBeNull();
  });

  it("the banner is anchored on the park and answered once, across the promotion", async () => {
    const w = await world();
    await db.insert(accountLifecycleNotices).values({
      accountId: w.accountId, kind: "closed", anchor: new Date("2026-08-25T18:55:08.000Z"),
    });
    expect(await reopenedCatchUp(w.deps, w.ctx)).toEqual({ since: PARKED.toISOString() });
    await db.update(mailboxes).set({ organizerParkedAt: null }).where(eq(mailboxes.accountId, w.accountId));
    expect(await reopenedCatchUp(w.deps, w.ctx), "the promotion starts no second banner").toBeNull();
  });

  /* THE ACCOUNT'S MAILBOX ROWS, IN ID ORDER, as a Screener decision takes them. A row held by a write
     group, the reopening writes waiting on it and a decision waiting under both: with the high id stored
     first, writes taking the rows in their scan's order took the high row at the group's commit and then
     asked the low one the decision held (40P01). The door's session plans no index scan here. */
  it("the reopening writes and a decision taking the account's rows, under a row a group holds: both commit", async () => {
    const [acct] = await db.insert(accounts).values({ name: `reopen-${randomUUID().slice(0, 8)}` }).returning();
    const accountId = acct!.id;
    seeded.push(accountId);
    const tag = accountId.slice(0, 8);
    let pair: { high: string; low: string } | null = null;
    // The high id stored first, in one insert; a pair a page break stored the other way round is replaced.
    for (let n = 0; pair === null && n < 5; n++) {
      const ids = [`ffffffff-ffff-4fff-bfff-${tag}000${n}`, `00000000-0000-4000-8000-${tag}000${n}`];
      await db.insert(mailboxes).values(ids.map((id) => ({
        id, accountId, provider: "imap", address: `reopen-${id}@example.invalid`, syncBlockedReason: "account_closed", syncBlockedSince: PARKED,
      })));
      const heap = await db.execute(sql`select id from mailboxes where id in (${ids[0]}, ${ids[1]}) order by ctid`) as unknown as Array<{ id: string }>;
      if (heap[0]?.id === ids[0]) pair = { high: ids[0]!, low: ids[1]! };
      else await db.delete(mailboxes).where(inArray(mailboxes.id, ids));
    }
    expect(pair, "the heap never stored the high id first").not.toBeNull();
    const pools: OwnedDb[] = [];
    const open = (name: string, settings: Record<string, string> = {}): OwnedDb["db"] => {
      const u = new URL(PG_TEST_URL);
      u.searchParams.set("application_name", name);
      for (const [k, v] of Object.entries(settings)) u.searchParams.set(k, v);
      const o = makeOwnedDb(u.toString());
      pools.push(o);
      return o.db;
    };
    const untilWaiting = async (name: string): Promise<void> => {
      for (const end = Date.now() + 15_000; ;) {
        const rows = await db.execute(sql`select count(*)::int as n from pg_stat_activity
          where application_name = ${name} and wait_event_type = 'Lock'`) as unknown as Array<{ n: number }>;
        if ((rows[0]?.n ?? 0) > 0) return;
        if (Date.now() > end) throw new Error(`${name} never waited on a lock`);
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    const codeOf = (e: unknown): string => String((e as { code?: string })?.code ?? (e as { cause?: { code?: string } })?.cause?.code ?? e);
    try {
      let held!: () => void;
      const holding = new Promise<void>((r) => { held = r; });
      let release!: () => void;
      const released = new Promise<void>((r) => { release = r; });
      const group = open(`reopen-group-${tag}`).transaction(async (tx) => {
        await tx.execute(sql`select 1 from mailboxes where id = ${pair!.high} for update`);
        held();
        await released;
      });
      await holding;
      const doorDb = open(`reopen-door-${tag}`, { enable_indexscan: "off", enable_bitmapscan: "off" });
      const reopened = resumeAfterReopen({ db: doorDb, now: () => NOW } as unknown as ApiDeps,
        { accountId, db: doorDb, now: () => NOW } as unknown as ServiceContext);
      await untilWaiting(`reopen-door-${tag}`);
      const decideDb = open(`reopen-decide-${tag}`);
      const decided = decideDb.transaction(async (raw) => lockAccountMailboxes(carryDialect(decideDb, raw as object) as unknown as Tx, accountId))
        .then(() => "ok", codeOf);
      await untilWaiting(`reopen-decide-${tag}`);
      release();
      await group;
      expect(await decided, "the decision failed").toBe("ok");
      await reopened;
      const rows = await db.select({ reason: mailboxes.syncBlockedReason }).from(mailboxes).where(eq(mailboxes.accountId, accountId));
      expect(rows.map((r) => r.reason), "the reopening writes did not land").toEqual([null, null]);
    } finally {
      for (const p of pools) await p.close().catch(() => {});
    }
  }, 60_000);
});
