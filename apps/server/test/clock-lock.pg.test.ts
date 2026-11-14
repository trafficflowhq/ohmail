import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { LEADER_LOCK_KEY, acquireLeaderLock as acquireWorkerLock } from "../../worker/src/leader-lock.js";
import { API_CLOCK_LOCK_KEY, acquireLeaderLock } from "../src/clock-lock.js";

/**
 * THE LOCK THAT LETS ONE COPY DRIVE THE CLOCKS, on a real Postgres: an advisory lock is the one
 * thing the in-process test database cannot show.
 */
const PG_UP = await realPgAvailable();

/** A key of this file's own, far from every key the product takes. */
const KEY = 4207278900n;
const held: { release(): Promise<void> }[] = [];
afterEach(async () => { for (const lock of held.splice(0)) await lock.release().catch(() => {}); });

describe.skipIf(!PG_UP)("the API clocks' lock", () => {
  it("one holder at a time; released, it can be taken again", async () => {
    const first = await acquireLeaderLock(PG_TEST_URL, KEY);
    expect(first).not.toBeNull();
    held.push(first!);
    expect(await acquireLeaderLock(PG_TEST_URL, KEY)).toBeNull();
    expect(await first!.verify()).toBe(true);
    await first!.release();
    expect(await first!.verify()).toBe(false);
    const again = await acquireLeaderLock(PG_TEST_URL, KEY);
    expect(again).not.toBeNull();
    held.push(again!);
  });

  it("a holder whose connection is ended has lost the lock, knows at its next heartbeat, and another copy takes it", async () => {
    const lock = await acquireLeaderLock(PG_TEST_URL, KEY + 1n);
    expect(lock).not.toBeNull();
    held.push(lock!);
    const admin = postgres(PG_TEST_URL, { max: 1, onnotice: () => {} });
    try {
      await admin`select pg_terminate_backend(${lock!.backendPid})`;
    } finally {
      await admin.end({ timeout: 5 });
    }
    // Postgres freed it with the session: a standby takes it without waiting for the old holder.
    const next = await acquireLeaderLock(PG_TEST_URL, KEY + 1n);
    expect(next).not.toBeNull();
    held.push(next!);
    expect(await lock!.verify()).toBe(false);
    const lost = await Promise.race([lock!.lost, new Promise<null>((r) => setTimeout(() => r(null), 2_000))]);
    expect(lost, "the lock was gone and nothing said so").toBeInstanceOf(Error);
    await lock!.release();
  });

  it("a deliberate release is not a loss", async () => {
    const lock = await acquireLeaderLock(PG_TEST_URL, KEY + 2n);
    await lock!.release();
    const outcome = await Promise.race([lock!.lost.then(() => "lost"), new Promise<string>((r) => setTimeout(() => r("quiet"), 200))]);
    expect(outcome).toBe("quiet");
  });

  it("a database that cannot be asked is neither held nor free: it throws", async () => {
    const nowhere = ["postgres://", "nobody", "@", "127.0.0.1:1", "/none"].join("");
    await expect(acquireLeaderLock(nowhere, KEY)).rejects.toBeDefined();
  });

  it("its key is its own: a worker leading its cycle does not hold the clocks, nor the clocks the cycle", async () => {
    expect(API_CLOCK_LOCK_KEY).not.toBe(LEADER_LOCK_KEY);
    const clocks = await acquireLeaderLock(PG_TEST_URL, API_CLOCK_LOCK_KEY);
    expect(clocks).not.toBeNull();
    held.push(clocks!);
    const cycle = await acquireWorkerLock(PG_TEST_URL, LEADER_LOCK_KEY);
    expect(cycle, "the worker's leader lock was blocked by the API clocks' lock").not.toBeNull();
    held.push(cycle!);
  });
});
