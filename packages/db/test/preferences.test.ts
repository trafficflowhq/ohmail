import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  accountSettings, adoptPreferences, changeLog, readPreferences, statePreference,
  type HeldPreferences, type LedgerTx, type Tx,
} from "../src/index.js";
import { dialect } from "../src/dialect/index.js";
import { makeTestDb } from "../src/testing.js";

/**
 * WHAT A PERSON STATED FOR EVERY INSTALL IS HELD IN THE ACCOUNT'S OWN ROW (mail 0210), on whichever
 * store the run is (the sqlite project runs this file too). A press always outranks what it
 * replaces; a found copy's statement is taken only when it is the later one; taking the same
 * statements twice, or in another order, ends in the same row; and nothing clears a member.
 */

type Db = Awaited<ReturnType<typeof makeTestDb>>;
const START = new Date("2026-11-17T09:00:00.000Z");
const later = (ms: number): Date => new Date(START.getTime() + ms);

async function world(): Promise<{ db: Db; accountId: string }> {
  return { db: await makeTestDb(), accountId: randomUUID() };
}

const inTx = <T>(db: Db, fn: (tx: LedgerTx) => Promise<T>): Promise<T> =>
  (db as unknown as Tx).transaction((tx) => fn(tx as unknown as LedgerTx)) as Promise<T>;

/** The settings record's rings so far: one change row per ring. */
async function rings(w: { db: Db; accountId: string }): Promise<number> {
  const rows = await w.db.select({ seq: changeLog.seq }).from(changeLog)
    .where(and(eq(changeLog.accountId, w.accountId), eq(changeLog.entityType, "settings")));
  return rows.length;
}

const held = (w: { db: Db; accountId: string }) => readPreferences(w.db as unknown as Tx, w.accountId);
const press = (w: { db: Db; accountId: string }, value: "head" | "each", now: Date) =>
  inTx(w.db, (tx) => statePreference(tx, w.accountId, "subject", value, now));
const takeIn = (w: { db: Db; accountId: string }, stated: HeldPreferences, now: Date = later(60_000)) =>
  inTx(w.db, (tx) => adoptPreferences(tx, w.accountId, stated, now));

describe("what a person stated for every install, in the account's row", () => {
  it("an account that stated nothing holds nothing, with or without its row", async () => {
    const w = await world();
    expect(await held(w)).toEqual({});
    await w.db.insert(accountSettings).values({ accountId: w.accountId });
    expect(await held(w)).toEqual({});
  });

  it("a press stores the word with its instant and rings the settings record once", async () => {
    const w = await world();
    expect(await press(w, "each", START)).toEqual({ value: "each", at: START });
    expect(await held(w)).toEqual({ subject: { value: "each", at: START } });
    expect(await rings(w)).toBe(1);
  });

  it("a press outranks what the row holds: one millisecond later when this clock is not ahead of it", async () => {
    const w = await world();
    await press(w, "each", START);
    // The same instant again, and a clock set back: both would tie or lose without the step.
    expect((await press(w, "head", START)).at).toEqual(later(1));
    expect((await press(w, "each", later(-5_000))).at).toEqual(later(2));
    // A statement taken in from a clock ahead of this one is outranked too.
    await takeIn(w, { subject: { value: "head", at: later(90_000) } });
    expect(await press(w, "each", later(10))).toEqual({ value: "each", at: later(90_001) });
    // A clock ahead of the held instant states its own.
    expect((await press(w, "head", later(120_000))).at).toEqual(later(120_000));
  });

  it("a found copy's later statement moves the row, keeps the stated instant and rings once", async () => {
    const w = await world();
    await press(w, "each", START);
    expect(await takeIn(w, { subject: { value: "head", at: later(5_000) } })).toEqual(["subject"]);
    expect(await held(w)).toEqual({ subject: { value: "head", at: later(5_000) } });
    expect(await rings(w)).toBe(2);
  });

  it("an account without its row takes a statement in, and gets the row", async () => {
    const w = await world();
    expect(await takeIn(w, { subject: { value: "each", at: START } })).toEqual(["subject"]);
    expect(await held(w)).toEqual({ subject: { value: "each", at: START } });
    expect(await rings(w)).toBe(1);
  });

  it("the same statement taken in again changes nothing and rings nothing", async () => {
    const w = await world();
    await takeIn(w, { subject: { value: "each", at: START } });
    const [before] = await w.db.select().from(accountSettings).where(eq(accountSettings.accountId, w.accountId));
    expect(await takeIn(w, { subject: { value: "each", at: START } }, later(999_000))).toEqual([]);
    expect(await takeIn(w, { subject: { value: "each", at: START } }, later(999_000))).toEqual([]);
    const [after] = await w.db.select().from(accountSettings).where(eq(accountSettings.accountId, w.accountId));
    expect(after).toEqual(before);
    expect(await rings(w)).toBe(1);
  });

  it("an earlier statement never replaces a later one", async () => {
    const w = await world();
    await press(w, "each", later(10_000));
    expect(await takeIn(w, { subject: { value: "head", at: START } })).toEqual([]);
    expect(await held(w)).toEqual({ subject: { value: "each", at: later(10_000) } });
    expect(await rings(w)).toBe(1);
  });

  it("the same statements in any order, with repeats, end in the same row", async () => {
    const a = { subject: { value: "each" as const, at: START } };
    const b = { subject: { value: "head" as const, at: later(1) } };
    const c = { subject: { value: "each" as const, at: later(2) } };
    // Two installs that stated different words in one millisecond: the tie has one winner everywhere.
    const tieHead = { subject: { value: "head" as const, at: later(2) } };
    const orders: HeldPreferences[][] = [
      [a, b, c, tieHead], [tieHead, c, b, a], [c, a, tieHead, b, a, c], [b, tieHead, b, c, a, tieHead],
    ];
    const ends: unknown[] = [];
    for (const order of orders) {
      const w = await world();
      for (const stated of order) await takeIn(w, stated);
      ends.push(await held(w));
    }
    expect(ends).toEqual(orders.map(() => ({ subject: { value: "head", at: later(2) } })));
  });

  it("a copy that states nothing clears nothing, rings nothing and makes no row", async () => {
    const w = await world();
    expect(await takeIn(w, {})).toEqual([]);
    expect(await w.db.select().from(accountSettings).where(eq(accountSettings.accountId, w.accountId))).toEqual([]);
    await press(w, "each", START);
    expect(await takeIn(w, {})).toEqual([]);
    expect(await takeIn(w, { subject: undefined })).toEqual([]);
    expect(await takeIn(w, { subject: { value: "head", at: new Date(Number.NaN) } })).toEqual([]);
    expect(await held(w)).toEqual({ subject: { value: "each", at: START } });
    expect(await rings(w)).toBe(1);
  });

  it("leaves every other column of the row as it stood", async () => {
    const w = await world();
    await w.db.insert(accountSettings).values({ accountId: w.accountId, dormancyDays: 45, locale: "de", themeFace: "paper" });
    await press(w, "each", START);
    await takeIn(w, { subject: { value: "head", at: later(7) } });
    const [row] = await w.db.select().from(accountSettings).where(eq(accountSettings.accountId, w.accountId));
    expect(row).toMatchObject({ dormancyDays: 45, locale: "de", themeFace: "paper", subjectHeading: "head", subjectHeadingAt: later(7) });
  });

  it("a server's store refuses a word outside the pair, and a word without its instant", async () => {
    const w = await world();
    // A device's store has no CHECK (its one writer holds both); the server's own database holds them.
    if (dialect(w.db as unknown as Tx).name !== "pg") return;
    await w.db.insert(accountSettings).values({ accountId: w.accountId });
    const set = (values: Partial<typeof accountSettings.$inferInsert>): Promise<unknown> =>
      w.db.update(accountSettings).set(values).where(eq(accountSettings.accountId, w.accountId));
    await expect(set({ subjectHeading: "every", subjectHeadingAt: START })).rejects.toThrow();
    await expect(set({ subjectHeading: "each" })).rejects.toThrow();
    await expect(set({ subjectHeadingAt: START })).rejects.toThrow();
    await set({ subjectHeading: "each", subjectHeadingAt: START });
    expect(await held(w)).toEqual({ subject: { value: "each", at: START } });
  });
});
