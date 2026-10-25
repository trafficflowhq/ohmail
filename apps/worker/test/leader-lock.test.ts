import { describe, it, expect, afterAll } from "vitest";
import { runMigrations } from "@trafficflow/db/admin";
import { acquireLeaderLock } from "../src/leader-lock.js";
import { pgTestUrl } from "@trafficflow/db/testing";

const URL = pgTestUrl(import.meta.url);

describe("leader lock (session-mode advisory)", () => {
  const held: Array<{ release: () => Promise<void> }> = [];
  afterAll(async () => { for (const h of held) await h.release(); });

  it("permits exactly one holder at a time", async () => {
    await runMigrations(URL);
    const a = await acquireLeaderLock(URL);
    expect(a).not.toBeNull();
    held.push(a!);

    const b = await acquireLeaderLock(URL); // second worker: must fail
    expect(b).toBeNull();

    await a!.release();
    held.pop();

    const c = await acquireLeaderLock(URL); // released → now acquirable
    expect(c).not.toBeNull();
    held.push(c!);
  });
});
