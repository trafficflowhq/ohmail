import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { accounts, mailboxes } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import type { Tx } from "@trafficflow/db";
import { syncKickPass } from "../src/sync-kick.js";

/**
 * ENFORCED SYNC — the kick scan, against REAL Postgres (mail 0049).
 *
 * Two properties, and they are the ones PGlite cannot vouch for. The compare-and-clear is a
 * `WHERE sync_requested_at = <a timestamptz value>` — exactly the shape of fragment
 * `sync-stamp.pg.test.ts` records as binding differently under postgres-js than under PGlite — so
 * "the clear only clears the value it observed" is proven on :5433 or not at all. And convergence
 * (a stamp is never silently erased, so it is either served now or on the next pass) is a claim
 * about that same WHERE, which is why both live here rather than in a unit suite.
 */
const AVAILABLE = await realPgAvailable();

describe.skipIf(!AVAILABLE)("sync-kick — stamp + kick converges", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    sql = postgres(PG_TEST_URL, { max: 2, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg");
  }, 60_000);

  /** One account + one mailbox; returns the mailbox id. */
  const seedMailbox = async (): Promise<string> => {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `kick-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `kick-${accountId.slice(0, 8)}@example.test`,
      status: "connected",
    }).returning();
    return mb!.id;
  };

  const stampNow = async (mailboxId: string, at: Date): Promise<void> => {
    await db.update(mailboxes).set({ syncRequestedAt: at }).where(eq(mailboxes.id, mailboxId));
  };

  const stampOf = async (mailboxId: string): Promise<Date | null> => {
    const [row] = await db.select({ at: mailboxes.syncRequestedAt })
      .from(mailboxes).where(eq(mailboxes.id, mailboxId)).limit(1);
    return row?.at ?? null;
  };

  it("pages past unchanged stamps without admitting foreign or disabled rows", async () => {
    const own = randomUUID();
    const foreign = randomUUID();
    const accountsForTest = [own, foreign];
    const ownership = await sql<{ id: string; shard: number }[]>`
      select id::text, ((hashtext(id::text) % 2) + 2) % 2 as shard
      from unnest(${accountsForTest}::uuid[]) id`;
    const index = ownership.find((r) => r.id === own)!.shard;
    // Ensure the foreign account lands on the other shard.
    let other = foreign;
    for (let attempt = 0; attempt < 100; attempt++) {
      const [hash] = await sql<{ shard: number }[]>`select ((hashtext(${other}::text) % 2) + 2) % 2 as shard`;
      if (hash?.shard !== index) break;
      other = randomUUID();
    }
    await db.insert(accounts).values([{ id: own, name: "current" }, { id: other, name: "other" }]);
    const [target] = await db.insert(mailboxes).values({
      accountId: own, provider: "imap", address: "older@example.test", status: "connected",
      syncRequestedAt: new Date("2020-01-01T00:00:00Z"),
    }).returning({ id: mailboxes.id });
    const noisy = await db.insert(mailboxes).values(Array.from({ length: 195 }, (_, i) => ({
      accountId: i < 65 ? other : own,
      provider: "imap" as const, address: `pending-${i}@example.test`,
      status: i >= 65 && i < 130 ? "disabled" as const : "connected" as const,
      syncRequestedAt: new Date("2020-01-02T00:00:00Z"),
    }))).returning({ id: mailboxes.id });
    const deps = {
      db: db as unknown as Tx, served: () => [], kick: () => undefined,
      requestRoster: () => undefined, askedFor: new Map<string, string>(),
      selection: { shards: 2, shardIndex: index }, unservedCursor: {},
    };
    const asked: string[] = [];
    for (let i = 0; i < 3; i++) asked.push(...(await syncKickPass(deps)).rosterFor);
    expect(asked.filter((id) => noisy.slice(0, 130).some((r) => r.id === id))).toEqual([]);
    expect(asked.filter((id) => id === target!.id)).toHaveLength(1);
  }, 30_000);

  it("kicks and clears a stamped mailbox this process serves", async () => {
    const id = await seedMailbox();
    await stampNow(id, new Date());
    const kicked: string[] = [];
    const res = await syncKickPass({
      db: db as unknown as Tx,
      served: () => [id],
      kick: (m) => kicked.push(m),
    });
    expect(kicked).toEqual([id]);
    expect(res.cleared).toBe(1);
    // The doorbell is answered: the stamp is gone so the next scan does not re-kick it.
    expect(await stampOf(id)).toBeNull();
  }, 30_000);

  it("leaves an unstamped served mailbox alone", async () => {
    const id = await seedMailbox();
    const kicked: string[] = [];
    const res = await syncKickPass({ db: db as unknown as Tx, served: () => [id], kick: (m) => kicked.push(m) });
    expect(kicked).toEqual([]);
    expect(res.cleared).toBe(0);
  }, 30_000);

  it("does NOT touch a stamped mailbox it does not serve — the served scope is the boundary", async () => {
    // If the scope were dropped, this stamped mailbox would be kicked and cleared by a worker that
    // is not its organizer. Mutating the `inArray(served)` filter out of the pass turns this red.
    const mine = await seedMailbox();
    const theirs = await seedMailbox();
    await stampNow(mine, new Date());
    await stampNow(theirs, new Date());
    const kicked: string[] = [];
    await syncKickPass({ db: db as unknown as Tx, served: () => [mine], kick: (m) => kicked.push(m) });
    expect(kicked).toEqual([mine]);
    // The mailbox we do not serve keeps its stamp — untouched, for its own organizer to answer.
    expect(await stampOf(theirs)).not.toBeNull();
  }, 30_000);

  it("compare-and-clear refuses a stale clear, so a stamp that changed mid-kick is never lost", async () => {
    // The convergence guarantee, exercised THROUGH the pass. The kick is awaited, so a second send
    // that stamps a newer instant DURING the kick lands before the pass's clear runs — and the
    // clear names the instant the pass observed, so it must miss and leave the mailbox stamped for
    // the next scan. Drop the `eq(sync_requested_at, observed)` from the pass's clear and it erases
    // the newer stamp: `cleared` becomes 1 and the surviving-stamp assertion goes red.
    const id = await seedMailbox();
    await stampNow(id, new Date(Date.now() - 60_000));
    const kicked: string[] = [];
    const res = await syncKickPass({
      db: db as unknown as Tx,
      served: () => [id],
      kick: async (m) => {
        kicked.push(m);
        // A concurrent second send, arriving while this mailbox is being kicked.
        await stampNow(m, new Date());
      },
    });
    expect(kicked).toEqual([id]);
    expect(res.cleared).toBe(0);          // the observed instant no longer matches → nothing cleared
    expect(await stampOf(id)).not.toBeNull(); // the newer request survived for the next scan

    // …and the next scan, observing the newer instant with no further writes, answers it cleanly.
    const again: string[] = [];
    const res2 = await syncKickPass({ db: db as unknown as Tx, served: () => [id], kick: (m) => { again.push(m); } });
    expect(again).toEqual([id]);
    expect(res2.cleared).toBe(1);
    expect(await stampOf(id)).toBeNull();
  }, 30_000);

  it("re-rings for a fresh stamp after a completed kick (a second send is not swallowed)", async () => {
    const id = await seedMailbox();
    await stampNow(id, new Date(Date.now() - 5_000));
    const first: string[] = [];
    await syncKickPass({ db: db as unknown as Tx, served: () => [id], kick: (m) => first.push(m) });
    expect(first).toEqual([id]);
    expect(await stampOf(id)).toBeNull();

    // A new send stamps again; the next scan must kick again rather than treat the mailbox as done.
    await stampNow(id, new Date());
    const second: string[] = [];
    const res = await syncKickPass({ db: db as unknown as Tx, served: () => [id], kick: (m) => second.push(m) });
    expect(second).toEqual([id]);
    expect(res.cleared).toBe(1);
  }, 30_000);

  it("clears a stamp written by SQL with MICROSECOND precision — the production doorbell shape", async () => {
    // Every stamp above is seeded through a JavaScript `Date`, whose milliseconds round-trip
    // through drizzle exactly. A producer that writes `sync_requested_at = now()` in SQL stores
    // MICROSECONDS, and a pass that reads the column into a `Date` and clears
    // `WHERE sync_requested_at = <that Date>` can never match it — so the same mailbox is
    // re-kicked on every pass for ever (measured live on prod: a `now()` stamp
    // survived many minutes of passes). `clock_timestamp()` guarantees a fresh six-digit
    // fractional value here rather than hoping `now()` lands off a millisecond boundary.
    //
    // Mutation evidence: restoring the pass's clear to `eq(mailboxes.syncRequestedAt, <Date>)`
    // (the pre-fix read through a JS Date) turns the `cleared: 1` and the null-stamp assertions
    // red while every JS-seeded test above stays green — this is the one test that can see it.
    const id = await seedMailbox();
    // `date_trunc` + a fixed sub-millisecond offset makes the microsecond remainder
    // DETERMINISTICALLY non-zero — a bare `clock_timestamp()` lands on an exact millisecond now
    // and then, and a test that goes vacuous that often reads as a flake.
    await sql`
      update mailboxes
      set sync_requested_at = date_trunc('milliseconds', clock_timestamp()) + interval '0.000456 second'
      where id = ${id}`;
    // Prove the seed actually carries a non-zero microsecond remainder, or the test would pass
    // vacuously on a value a Date can represent.
    const [seeded] = await sql`
      select (extract(microseconds from sync_requested_at)::int % 1000) as us
      from mailboxes where id = ${id}`;
    expect(Number(seeded!.us)).toBe(456);

    const kicked: string[] = [];
    const res = await syncKickPass({ db: db as unknown as Tx, served: () => [id], kick: (m) => kicked.push(m) });
    expect(kicked).toEqual([id]);
    expect(res.cleared).toBe(1);
    expect(await stampOf(id)).toBeNull();
  }, 30_000);

  /**
   * THE UNSERVED ARM: a stamped mailbox no runtime here serves — a mailbox created a moment ago —
   * asks for one roster pass per stamp value and is never cleared by this process. Assertions name
   * this case's own mailbox: the scan reads the newest stamps of the whole database.
   */
  describe("a stamped mailbox this process does not serve", () => {
    const unserved = () => {
      const askedFor = new Map<string, string>();
      let rosters = 0;
      const pass = (served: string[]) => syncKickPass({
        db: db as unknown as Tx, served: () => served, kick: () => undefined,
        requestRoster: () => { rosters += 1; }, askedFor,
      });
      return { askedFor, pass, rosters: () => rosters };
    };

    it("requests one roster pass and leaves the stamp for the process that will serve it", async () => {
      const id = await seedMailbox();
      await stampNow(id, new Date());
      const u = unserved();
      const res = await u.pass([]);
      expect(res.rosterFor).toContain(id);
      expect(u.rosters()).toBe(res.rosterFor.length);
      expect(await stampOf(id), "a process that does not serve the mailbox cleared its doorbell").not.toBeNull();
    }, 30_000);

    it("a second scan of the same stamp requests none; a new stamp requests one", async () => {
      const id = await seedMailbox();
      await stampNow(id, new Date(Date.now() - 1_000));
      const u = unserved();
      await u.pass([]);
      expect((await u.pass([])).rosterFor, "the same stamp asked for a roster every tick").not.toContain(id);
      await stampNow(id, new Date());
      expect((await u.pass([])).rosterFor).toContain(id);
    }, 30_000);

    it("a served mailbox is answered by the served arm and never asks for a roster", async () => {
      const id = await seedMailbox();
      await stampNow(id, new Date());
      const u = unserved();
      const kicked: string[] = [];
      const res = await syncKickPass({
        db: db as unknown as Tx, served: () => [id], kick: (m) => { kicked.push(m); },
        requestRoster: () => undefined, askedFor: u.askedFor,
      });
      expect(res.rosterFor).not.toContain(id);
      expect(kicked).toEqual([id]);
      expect(res.cleared).toBe(1);
    }, 30_000);

    it("forgets a mailbox once its stamp is answered, so the memory is bounded by the stamps", async () => {
      const id = await seedMailbox();
      await stampNow(id, new Date());
      const u = unserved();
      await u.pass([]);
      expect(u.askedFor.has(id)).toBe(true);
      await syncKickPass({ db: db as unknown as Tx, served: () => [id], kick: () => undefined });
      await u.pass([]);
      expect(u.askedFor.has(id), "a cleared stamp stayed in the memory").toBe(false);
    }, 30_000);
  });
});
