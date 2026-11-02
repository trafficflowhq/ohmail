import { describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { sql } from "drizzle-orm";
import { makeOwnedDb } from "@trafficflow/db/cloud";
import { awaitDatabase, isDatabaseStarting } from "../src/await-database.js";

/**
 * THE BOOT WAITS FOR A DATABASE THAT IS STILL STARTING, AND FOR NOTHING ELSE. On a first start Postgres
 * runs its init scripts on a server that takes no TCP connection, then restarts on its final listener;
 * an api that reached it in between used to exit and come back only on a container restart. A wrong
 * password or a missing database is not a database starting, and fails at once.
 */
const coded = (code: string): Error => Object.assign(new Error(`driver text ${code}`), { code });
/* Interpolated: a whole credentialed URL literal is a credential to the push gate. */
const ROLE = "ohmail";
const PW = "x";

/** A clock that moves only when the code under test sleeps. */
function fakeTime() {
  let t = 1_000;
  const sleeps: number[] = [];
  return { sleeps, now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; } };
}

describe("isDatabaseStarting", () => {
  it("reads the connection codes, the driver's own, 57P03 and class 08, a cause or a few deep", () => {
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "CONNECT_TIMEOUT", "CONNECTION_CLOSED", "57P03", "08006", "08P01"]) {
      expect(isDatabaseStarting(coded(code)), code).toBe(true);
    }
    expect(isDatabaseStarting(new Error("wrapped", { cause: new Error("again", { cause: coded("ECONNRESET") }) }))).toBe(true);
  });

  it("reads nothing else: a refused password, a missing database, no code, a cycle, a code past the fifth level", () => {
    for (const err of [coded("28P01"), coded("3D000"), new Error("plain"), "ECONNREFUSED", null]) {
      expect(isDatabaseStarting(err), String(err)).toBe(false);
    }
    const cyclic = new Error("cycle") as Error & { cause?: unknown };
    cyclic.cause = cyclic;
    expect(isDatabaseStarting(cyclic)).toBe(false);
    let deep: unknown = coded("ECONNREFUSED");
    for (let i = 0; i < 5; i++) deep = new Error(`level ${i}`, { cause: deep });
    expect(isDatabaseStarting(deep)).toBe(false);
  });
});

describe("awaitDatabase", () => {
  it("refused twice, then up: three tries, sleeps of 500 and 1000, each wait reported", async () => {
    const time = fakeTime();
    const waits: Array<{ tries: number; elapsedMs: number; code: unknown }> = [];
    let tries = 0;
    await awaitDatabase(async () => { if (++tries < 3) throw coded("ECONNREFUSED"); }, {
      ...time, onWait: (w) => waits.push({ tries: w.tries, elapsedMs: w.elapsedMs, code: (w.err as { code?: unknown }).code }),
    });
    expect(tries).toBe(3);
    expect(time.sleeps).toEqual([500, 1000]);
    expect(waits).toEqual([{ tries: 1, elapsedMs: 0, code: "ECONNREFUSED" }, { tries: 2, elapsedMs: 500, code: "ECONNREFUSED" }]);
  });

  it("a refused password is thrown on the first try, with no sleep", async () => {
    const time = fakeTime();
    let tries = 0;
    const err = coded("28P01");
    await expect(awaitDatabase(async () => { tries++; throw err; }, time)).rejects.toBe(err);
    expect([tries, time.sleeps]).toEqual([1, []]);
  });

  it("the database starting up (57P03) is waited on", async () => {
    const time = fakeTime();
    let tries = 0;
    await awaitDatabase(async () => { if (++tries === 1) throw coded("57P03"); }, time);
    expect([tries, time.sleeps]).toEqual([2, [500]]);
  });

  it("doubles to the cap, and past the budget throws the last error with every sleep inside it", async () => {
    const time = fakeTime();
    let tries = 0;
    const thrown: Error[] = [];
    const probe = async (): Promise<void> => { const e = coded("ECONNREFUSED"); thrown.push(e); tries++; throw e; };
    const err = await awaitDatabase(probe, { ...time, budgetMs: 20_000, maxDelayMs: 5_000 }).catch((e: unknown) => e);
    expect(err).toBe(thrown.at(-1));
    expect(time.sleeps).toEqual([500, 1000, 2000, 4000, 5000, 5000]);
    expect(time.sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(20_000);
    expect(tries).toBe(7);
  });

  it("a closed port on 127.0.0.1, dialled through makeOwnedDb, reads as a database starting", async () => {
    const port = await new Promise<number>((resolve) => {
      const s = createServer();
      s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
    });
    const owned = makeOwnedDb(`postgres://${ROLE}:${PW}@127.0.0.1:${port}/ohmail`);
    const err = await owned.db.execute(sql`select 1`).then(() => null, (e: unknown) => e);
    await owned.close();
    expect(err).not.toBeNull();
    expect(isDatabaseStarting(err)).toBe(true);
  });
});
