import { describe, expect, it } from "vitest";
import { reserveWithin } from "../src/client.js";

/**
 * Model a driver that keeps its queue over a redial. The PostgreSQL tests verify the actual
 * handoff. Here we count every request and release at the acquisition deadline.
 */
function fakePool() {
  const queue: Array<(conn: unknown) => void> = [];
  let asked = 0;
  let released = 0;
  const pool = {
    reserve: () => {
      asked++;
      return new Promise((give) => { queue.push(give); });
    },
    /** A connection becomes free and goes to the first reservation still waiting. */
    serve: () => {
      const next = queue.shift();
      if (!next) return false;
      next({ release: () => { released++; } });
      return true;
    },
    counts: () => ({ asked, released }),
  };
  return pool;
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("reservations after a connection closes", () => {
  it("submits each of 100 waiting reservations once and serves them in order", async () => {
    const pool = fakePool();
    const answers: string[] = [];
    const waiters = Array.from({ length: 100 }, (_, i) =>
      reserveWithin(pool as never, null, "statement").then(() => { answers.push(`w${i}`); }));
    expect(pool.counts().asked).toBe(100);
    while (pool.serve()) await settle();
    await Promise.all(waiters);
    expect(answers).toEqual(Array.from({ length: 100 }, (_, i) => `w${i}`));
    expect(pool.counts()).toEqual({ asked: 100, released: 0 });
  });

  it("hands back once the late answer of a waiter that stopped waiting", async () => {
    const pool = fakePool();
    const late = reserveWithin(pool as never, 10, "statement").then(() => "served", () => "timed out");
    const next = reserveWithin(pool as never, null, "statement").then(() => "served");
    expect(await late).toBe("timed out");
    pool.serve();
    await settle();
    expect(pool.counts()).toEqual({ asked: 2, released: 1 });
    pool.serve();
    expect(await next).toBe("served");
    expect(pool.counts()).toEqual({ asked: 2, released: 1 });
  });
});
