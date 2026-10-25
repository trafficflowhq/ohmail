import { describe, it, expect } from "vitest";
import { eq, sql as sqlTag } from "drizzle-orm";
import {
  accountStorage, applyBodyBytesDelta, recordRefilledForSpace, releaseBodyBytes, reserveBodyBytes, storageUsageOf,
} from "@trafficflow/db";
import { dialect, dialectOf } from "../src/dialect/index.js";
import { makeTestDb } from "../src/testing.js";

/**
 * THE STORED-BODY COUNTER, ON BOTH STORES — the one write that rides every message.
 *
 * `reserveBodyBytes` runs once per body the engine stores, so of everything in this module it is
 * the statement a phone executes most and the one whose failure takes ingest down rather than
 * degrading a feature. It carried two constructs the device store does not have: `now()`, which
 * is not a function there, and `greatest`, which is `max` — a name that store already gives to
 * the AGGREGATE, so the wrong spelling would not have failed, it would have collapsed the result
 * and answered a different question.
 *
 * Both now go through the seam, and this file is the control for each arm. It is deliberately
 * written against `account_storage` alone: that table has no foreign key, so the same file seeds
 * and runs identically under both projects, which is what makes "it passes on both" a fact rather
 * than two different tests agreeing.
 *
 * ── WATCHED FAIL ──────────────────────────────────────────────────────────────────────────
 *
 * With `d.now()` restored to `sql`now()``, the SQLite run answers `no such function: now` at the
 * first reserve and the Postgres run stays green. With `d.greatest(sql`0`, …)` restored to
 * `greatest(0, …)`, the SQLite run answers `no such function: greatest`. Neither mutation is
 * visible to the other store, which is the whole reason the second run exists.
 */
const ACCOUNT = "00000000-0000-4000-8000-0000000000aa";
const LONG_AGO = new Date("2020-01-01T00:00:00.000Z");

async function freshCounter(db: Awaited<ReturnType<typeof makeTestDb>>, bytes: number) {
  await db.delete(accountStorage).where(eq(accountStorage.accountId, ACCOUNT));
  await db.insert(accountStorage).values({ accountId: ACCOUNT, bytes });
  // Stamped into the past so "the bump moved it" is a comparison rather than a coincidence: a
  // row written and updated inside one test can otherwise carry the same instant twice.
  await db.update(accountStorage).set({ updatedAt: LONG_AGO })
    .where(eq(accountStorage.accountId, ACCOUNT));
}

const rowOf = async (db: Awaited<ReturnType<typeof makeTestDb>>) => {
  const [row] = await db.select().from(accountStorage)
    .where(eq(accountStorage.accountId, ACCOUNT)).limit(1);
  return row;
};

describe("a transaction knows which store it is on, without being told", () => {
  /**
   * The property almost every statement in this engine depends on, proved against BOTH real stores
   * rather than against a stub.
   *
   * A transaction is a fresh object the query builder makes, so a brand on the handle does not
   * travel to it — and a statement composed per dialect inside one therefore refused. Branding a
   * handle now wraps its `transaction`, so the callback receives a branded object, recursively.
   *
   * This is where it matters: the device store's handle is branded AFTER the one-transaction mutex
   * is put around it (`brandDialect(oneTransactionAtATime(db), "sqlite")`), so the wrapper this
   * relies on wraps the MUTEX's transaction and brands whatever that hands over. Getting that order
   * the other way round would brand the raw handle and leave the serialized one bare.
   */
  it("answers inside a transaction", async () => {
    const db = await makeTestDb();
    const outer = dialect(db).name;
    const inside = await db.transaction(async (tx) => dialectOf(tx));
    expect(inside).toBe(outer);
  });

  it("answers inside a SAVEPOINT, at the depth a nested writer opens one", async () => {
    const db = await makeTestDb();
    const inside = await db.transaction(async (tx) =>
      (tx as unknown as { transaction: (f: (s: object) => unknown) => Promise<unknown> })
        .transaction(async (sp) => dialectOf(sp)));
    expect(inside).toBe(dialect(db).name);
  });

  it("composes a real statement through the seam from inside one, which is the point", async () => {
    // Not merely "the brand is readable": the thing that used to fail is composing a statement,
    // so this composes one. `d.now()` is the member whose absence stopped the first drain.
    const db = await makeTestDb();
    await freshCounter(db, 7);
    await db.transaction(async (tx) => {
      const d = dialect(tx);
      await (tx as unknown as typeof db).update(accountStorage)
        .set({ bytes: 9, updatedAt: d.now() })
        .where(eq(accountStorage.accountId, ACCOUNT));
    });
    expect(await storageUsageOf(db as never, ACCOUNT)).toBe(9);
  });
});

describe("the stored-body counter moves on whichever store the engine opened", () => {
  it("adds the body's bytes and advances the stamp, unmetered", async () => {
    const db = await makeTestDb();
    const d = dialect(db);
    await freshCounter(db, 1_000);

    expect(await reserveBodyBytes(db as never, d, ACCOUNT, 250, null)).toBe(true);

    expect(await storageUsageOf(db as never, ACCOUNT)).toBe(1_250);
    // The stamp is the `now()` arm's own effect: it is the only thing that write moves besides
    // the count, so an unported spelling cannot hide behind a correct number.
    const after = await rowOf(db);
    expect(after?.updatedAt).toBeInstanceOf(Date);
    expect((after?.updatedAt as Date).getTime()).toBeGreaterThan(LONG_AGO.getTime());
  });

  it("declines once the count has reached the cap, and stores the message that crosses it", async () => {
    const db = await makeTestDb();
    const d = dialect(db);
    await freshCounter(db, 900);

    // Below the cap: admitted IN FULL even though it crosses — the predicate is `bytes < cap`
    // before adding, which is the conservative direction and bounded by one message.
    expect(await reserveBodyBytes(db as never, d, ACCOUNT, 500, 1_000)).toBe(true);
    expect(await storageUsageOf(db as never, ACCOUNT)).toBe(1_400);
    // At or over the cap: the next one is the decline, and the counter does not move.
    expect(await reserveBodyBytes(db as never, d, ACCOUNT, 10, 1_000)).toBe(false);
    expect(await storageUsageOf(db as never, ACCOUNT)).toBe(1_400);
  });

  it("clamps a compensation at zero rather than writing a negative count", async () => {
    const db = await makeTestDb();
    const d = dialect(db);
    await freshCounter(db, 400);

    // The largest-of member's own arm. On the device store this is spelled `max`, where ONE
    // argument is the aggregate — the seam refuses that call, and this is the two-argument use
    // it exists for.
    await releaseBodyBytes(db as never, d, ACCOUNT, 1_000);
    expect(await storageUsageOf(db as never, ACCOUNT)).toBe(0);
    const after = await rowOf(db);
    expect((after?.updatedAt as Date).getTime()).toBeGreaterThan(LONG_AGO.getTime());
  });

  it("applies a repair's delta in both directions, and never below zero", async () => {
    const db = await makeTestDb();
    const d = dialect(db);
    await freshCounter(db, 100);

    await applyBodyBytesDelta(db as never, d, ACCOUNT, 60);
    expect(await storageUsageOf(db as never, ACCOUNT)).toBe(160);
    await applyBodyBytesDelta(db as never, d, ACCOUNT, -50);
    expect(await storageUsageOf(db as never, ACCOUNT)).toBe(110);
    await applyBodyBytesDelta(db as never, d, ACCOUNT, -10_000);
    expect(await storageUsageOf(db as never, ACCOUNT)).toBe(0);
  });

  it("a refilled letter adds its bytes and takes one letter off the emptied count, never the trim's facts", async () => {
    const db = await makeTestDb();
    const d = dialect(db);
    await freshCounter(db, 1_000);
    const TRIMMED = new Date("2026-08-10T00:00:00.000Z");
    await db.update(accountStorage).set({
      huskedForSpace: 3, withheldOnArrival: 1, keptFrom: "2026-09-01",
      firstHuskedAt: TRIMMED, lastHuskedAt: TRIMMED, recountedAt: TRIMMED,
    }).where(eq(accountStorage.accountId, ACCOUNT));
    const facts = async () => {
      const r = await rowOf(db);
      return { bytes: Number(r?.bytes), husked: r?.huskedForSpace, onArrival: r?.withheldOnArrival };
    };

    // A letter the trim emptied, dated before the month text is kept from.
    await recordRefilledForSpace(db as never, d, ACCOUNT, 400, new Date("2026-08-20T00:00:00.000Z"));
    expect(await facts()).toEqual({ bytes: 1_400, husked: 2, onArrival: 1 });
    // A letter withheld on arrival, dated on or after it.
    await recordRefilledForSpace(db as never, d, ACCOUNT, 300, new Date("2026-09-03T00:00:00.000Z"));
    expect(await facts()).toEqual({ bytes: 1_700, husked: 1, onArrival: 0 });

    const after = await rowOf(db);
    expect(after?.keptFrom).toBe("2026-09-01");
    for (const at of [after?.firstHuskedAt, after?.lastHuskedAt, after?.recountedAt]) {
      expect((at as Date).getTime()).toBe(TRIMMED.getTime());
    }
    expect((after?.updatedAt as Date).getTime()).toBeGreaterThan(LONG_AGO.getTime());

    // A body that shrank, past the last emptied letter: clamped, never negative.
    await recordRefilledForSpace(db as never, d, ACCOUNT, -5_000, new Date("2026-09-04T00:00:00.000Z"));
    await recordRefilledForSpace(db as never, d, ACCOUNT, 10, new Date("2026-09-05T00:00:00.000Z"));
    expect(await facts()).toEqual({ bytes: 10, husked: 0, onArrival: 0 });
    // The last emptied letter back: no first time is kept, so the next trim dates its own.
    expect((await rowOf(db))?.firstHuskedAt, "a count back at zero kept its first time").toBeNull();
  });

  it("a back-filled count with no first time stays undated as its letters come back", async () => {
    const db = await makeTestDb();
    const d = dialect(db);
    await freshCounter(db, 0);
    await db.update(accountStorage).set({ huskedForSpace: 2 }).where(eq(accountStorage.accountId, ACCOUNT));
    for (const left of [1, 0]) {
      await recordRefilledForSpace(db as never, d, ACCOUNT, 50, null);
      const r = await rowOf(db);
      expect({ husked: r?.huskedForSpace, first: r?.firstHuskedAt ?? null }).toEqual({ husked: left, first: null });
    }
  });

  it("with no month recorded, the letters withheld on arrival are clamped to the letters left", async () => {
    const db = await makeTestDb();
    const d = dialect(db);
    await freshCounter(db, 0);
    await db.update(accountStorage).set({ huskedForSpace: 2, withheldOnArrival: 2 })
      .where(eq(accountStorage.accountId, ACCOUNT));
    await recordRefilledForSpace(db as never, d, ACCOUNT, 50, new Date("2026-09-03T00:00:00.000Z"));
    const r = await rowOf(db);
    expect({ husked: r?.huskedForSpace, onArrival: r?.withheldOnArrival, keptFrom: r?.keptFrom })
      .toEqual({ husked: 1, onArrival: 1, keptFrom: null });
  });

  it("reads a raw statement back POSITIONALLY through the seam, on both stores", async () => {
    // The shape the recompute and the eviction page now depend on. The server's driver answers
    // named objects and the device's answers arrays; the seam's `exec` returns one shape, and a
    // caller reading `row[0]` has to be right on both or it is right on neither.
    const db = await makeTestDb();
    const d = dialect(db);
    await freshCounter(db, 4_242);

    const rows = await d.exec(db, sqlSelect(ACCOUNT));
    expect(rows).toHaveLength(1);
    expect(Array.isArray(rows[0])).toBe(true);
    expect(Number(rows[0]?.[0])).toBe(4_242);
    expect(String(rows[0]?.[1])).toBe(ACCOUNT);
  });
});

/** Kept out of the case above so the two columns' ORDER is visible beside the reads of them. */
function sqlSelect(accountId: string) {
  return sqlTag`select bytes, account_id from account_storage where account_id = ${accountId}`;
}
