import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "../src/testing.js";
import { AccountErasedError, accounts, type AccessVerdict, type TrialStorageCarry, type Tx } from "@trafficflow/db";
import {
  accountStorageHolds, heldStorageLimitOf, STORAGE_DROP_GRACE_MS, utcDayCeil,
} from "@trafficflow/db/cloud";

/**
 * A LOWER STORAGE LIMIT WAITS 14 DAYS (cloud 0055), on PGlite: the readings a cap reader makes, in
 * order, and what each one applies. The hold is the only thing between a downgrade and the trim.
 */

type Db = Awaited<ReturnType<typeof makeTestDb>>;
const GB = 1_000_000_000;
const DAY = 86_400_000;
const START = new Date("2026-10-27T15:30:00.000Z");
const at = (days: number): Date => new Date(START.getTime() + days * DAY);
const ENDS = new Date(utcDayCeil(START.getTime() + STORAGE_DROP_GRACE_MS)).toISOString();

const v = (storageBytes: number | null, trialStorage?: TrialStorageCarry): AccessVerdict => ({
  ok: true, limits: { mailboxes: null, storageBytes, canAddMailbox: true, aiEnabled: true },
  ...(trialStorage ? { trialStorage } : {}),
});

async function account(db: Db): Promise<string> {
  const id = randomUUID();
  await db.insert(accounts).values({ id, name: "Hold" });
  return id;
}

const read = (db: Db, id: string, verdict: AccessVerdict, now: Date) =>
  heldStorageLimitOf(db as unknown as Tx, id, verdict, now);

const rowOf = async (db: Db, id: string) =>
  (await db.select().from(accountStorageHolds).where(eq(accountStorageHolds.accountId, id)))[0];

describe("a lower storage limit waits before it empties letters", () => {
  it("the first reading records only the plan's limit, and applies it", async () => {
    const db = await makeTestDb();
    const id = await account(db);
    expect(await read(db, id, v(10 * GB), START)).toEqual({ capBytes: 10 * GB, planBytes: null, dropsAt: null });
    expect(await rowOf(db, id)).toMatchObject({ seenBytes: 10 * GB, heldBytes: null, heldUntil: null });
  });

  it("10 GB to 2 GB keeps 10 GB until the next 00:00 UTC 14 days on, and says so", async () => {
    const db = await makeTestDb();
    const id = await account(db);
    await read(db, id, v(10 * GB), START);
    expect(await read(db, id, v(2 * GB), START)).toEqual({ capBytes: 10 * GB, planBytes: 2 * GB, dropsAt: ENDS });
    expect(ENDS).toBe("2026-11-11T00:00:00.000Z");
    // A later reading the same day changes nothing, and a further drop or a partial rise keeps the date.
    expect(await read(db, id, v(2 * GB), at(1))).toEqual({ capBytes: 10 * GB, planBytes: 2 * GB, dropsAt: ENDS });
    expect(await read(db, id, v(1 * GB), at(2))).toEqual({ capBytes: 10 * GB, planBytes: 1 * GB, dropsAt: ENDS });
    expect(await read(db, id, v(5 * GB), at(3))).toEqual({ capBytes: 10 * GB, planBytes: 5 * GB, dropsAt: ENDS });
    // After the date, the plan's own limit, and the row forgets the hold.
    expect(await read(db, id, v(5 * GB), new Date(ENDS))).toEqual({ capBytes: 5 * GB, planBytes: null, dropsAt: null });
    expect(await rowOf(db, id)).toMatchObject({ seenBytes: 5 * GB, heldBytes: null, heldUntil: null });
  });

  it("a rise to the held limit cancels the hold, and a later drop gets a fresh 14 days", async () => {
    const db = await makeTestDb();
    const id = await account(db);
    await read(db, id, v(10 * GB), START);
    await read(db, id, v(2 * GB), START);
    expect(await read(db, id, v(10 * GB), at(5))).toEqual({ capBytes: 10 * GB, planBytes: null, dropsAt: null });
    expect(await rowOf(db, id)).toMatchObject({ heldBytes: null, heldUntil: null });
    const later = await read(db, id, v(2 * GB), at(9));
    expect(later).toEqual({
      capBytes: 10 * GB, planBytes: 2 * GB, dropsAt: new Date(utcDayCeil(at(9).getTime() + STORAGE_DROP_GRACE_MS)).toISOString(),
    });
  });

  it("the trial floor's own end opens no hold; a drop inside the floor holds the previous plan's limit", async () => {
    const db = await makeTestDb();
    const solo = await account(db);
    const until = "2026-11-03T09:00:00.000Z";
    // Solo under the 4 GB floor, then the floor ends: the date was told already, so 2 GB applies.
    expect(await read(db, solo, v(4 * GB, { planBytesLimit: 2 * GB, until }), START))
      .toEqual({ capBytes: 4 * GB, planBytes: 2 * GB, dropsAt: until });
    expect(await read(db, solo, v(2 * GB), at(7))).toEqual({ capBytes: 2 * GB, planBytes: null, dropsAt: null });

    // Pro during an unpaid trial, then Solo inside the floor: 10 GB held, the hold's date told.
    const pro = await account(db);
    await read(db, pro, v(10 * GB), START);
    expect(await read(db, pro, v(4 * GB, { planBytesLimit: 2 * GB, until: null }), START))
      .toEqual({ capBytes: 10 * GB, planBytes: 2 * GB, dropsAt: ENDS });
    // Past the hold, the floor again, with no date until the first payment.
    expect(await read(db, pro, v(4 * GB, { planBytesLimit: 2 * GB, until: null }), new Date(ENDS)))
      .toEqual({ capBytes: 4 * GB, planBytes: 2 * GB, dropsAt: null });
  });

  it("no limit, a zero limit and a refusal are applied as before and touch no database", async () => {
    const untouchable = new Proxy({}, { get: () => { throw new Error("the database was touched"); } }) as Tx;
    expect(await heldStorageLimitOf(untouchable, randomUUID(), v(null), START)).toBeNull();
    expect(await heldStorageLimitOf(untouchable, randomUUID(), { ok: false, reason: "payment_required" }, START)).toBeNull();
    expect(await heldStorageLimitOf(untouchable, randomUUID(), v(0), START)).toEqual({ capBytes: 0, planBytes: null, dropsAt: null });
  });

  it("an erased account writes no row and throws", async () => {
    const db = await makeTestDb();
    const id = await account(db);
    await db.update(accounts).set({ erasedAt: START }).where(eq(accounts.id, id));
    await expect(read(db, id, v(10 * GB), START)).rejects.toBeInstanceOf(AccountErasedError);
    expect(await rowOf(db, id)).toBeUndefined();
  });

  it("the cap is never below the program's limit, over any order of readings", async () => {
    const db = await makeTestDb();
    const limits = [2, 5, 10, 12, 4, 2, 10, 5, 2, 12].map((n) => n * GB);
    for (let start = 0; start < 3; start++) {
      const id = await account(db);
      for (let i = 0; i < limits.length; i++) {
        const limit = limits[(i + start) % limits.length]!;
        const now = at(i * (start + 3));
        const got = await read(db, id, v(limit), now);
        expect(got!.capBytes, `${start} ${i}`).toBeGreaterThanOrEqual(limit);
        // Held or not, the stated plan limit is the program's whenever the cap is above it.
        expect(got!.planBytes, `${start} ${i}`).toBe(got!.capBytes > limit ? limit : null);
      }
    }
  });
});
