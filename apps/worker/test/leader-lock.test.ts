import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  MIGRATED_DB_SETUP_BUDGET_MS, MIGRATED_DB_TEARDOWN_BUDGET_MS, pgTestUrl, throwawayDb,
} from "@trafficflow/db/testing";
import { acquireLeaderLock, leaderLockKeyFor } from "../src/leader-lock.js";

pgTestUrl(import.meta.url);
const database = throwawayDb("worker_leader_lock");

describe("leader lock (session-mode advisory)", () => {
  beforeAll(async () => { await database.createFromTemplate(); }, MIGRATED_DB_SETUP_BUDGET_MS);
  afterAll(async () => { await database.drop(); }, MIGRATED_DB_TEARDOWN_BUDGET_MS);

  const held: Array<{ release: () => Promise<void> }> = [];
  afterEach(async () => { for (const h of held.splice(0)) await h.release(); });

  it("permits exactly one holder at a time", async () => {
    const a = await acquireLeaderLock(database.url);
    expect(a).not.toBeNull();
    held.push(a!);

    const b = await acquireLeaderLock(database.url); // second worker: must fail
    expect(b).toBeNull();

    await a!.release();
    held.pop();

    const c = await acquireLeaderLock(database.url); // released → now acquirable
    expect(c).not.toBeNull();
    held.push(c!);
  });

  it("does not admit a different shard width beside an existing leader", async () => {
    const single = await acquireLeaderLock(database.url, leaderLockKeyFor(0), { shards: 1 });
    expect(single).not.toBeNull();
    held.push(single!);
    const other = await acquireLeaderLock(database.url, leaderLockKeyFor(1), { shards: 2 });
    if (other) held.push(other);
    expect(other).toBeNull();
  });
});
