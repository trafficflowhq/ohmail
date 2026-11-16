import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { accounts, recordChange, type Tx } from "@trafficflow/db";
import { makeOwnedDb, pushSubscriptions, type OwnedDb } from "@trafficflow/db/cloud";
import { carries, flightsOf, recordPgWire, type PgWireFlight } from "@trafficflow/db/testing";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { namedBy } from "../../../test/support/wire-doors.js";
import type { VapidFromEnv } from "@trafficflow/core/net";
import { startPushWake, type PushWakePost, type WakeSource } from "../src/push-wake.js";
import { bindWorker } from "../src/start/bind.js";

/**
 * THE NEW-MAIL WAKE, READ OFF THE WIRE.
 *
 * A wake names an account (the change log's signal), and once the shard owns that account the
 * sender reads the account's push registrations and deletes one whose endpoint is gone. Two
 * accounts, A and B, a registration each; a wake for each. Every statement on the registrations
 * rides a transaction that names the account the wake is for, and carries no id of the other.
 * On the pool's own handle the read would find nothing where rows are locked by account, and no
 * phone would be woken.
 */
const wire = recordPgWire();
let DB = "";

const NO_VAPID: VapidFromEnv = { kind: "absent", why: "no VAPID keypair is configured" };
const PERMIT = { async check(): Promise<string[]> { return ["127.0.0.1"]; } };
const tick = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

describe("the new-mail wake reads and prunes each account's registrations on that account's handle (real Postgres)", () => {
  let owned: OwnedDb;
  let a = { accountId: "", subscriptionId: "", seq: 0n };
  let b = { accountId: "", subscriptionId: "", seq: 0n };

  beforeAll(async () => {
    DB = await prepareIsolatedDb("trafficflow_worker_push_wake");
    owned = makeOwnedDb(DB);
  }, 120_000);

  beforeEach(async () => {
    await truncateAll(DB);
    const made: Array<{ accountId: string; subscriptionId: string; seq: bigint }> = [];
    for (let i = 0; i < 2; i++) {
      const [acct] = await owned.db.insert(accounts).values({ name: `wake-${randomUUID().slice(0, 8)}` }).returning();
      const [sub] = await owned.db.insert(pushSubscriptions).values({
        accountId: acct!.id, transport: "unifiedpush", endpoint: `http://127.0.0.1:9/up/${randomUUID()}`,
      }).returning();
      // A letter's change in the log, so that the wake's window holds something that is not the calendar's.
      const seq = await owned.db.transaction((tx) => recordChange(tx as never, {
        accountId: acct!.id, entityType: "message", entityId: randomUUID(), op: "create",
      }));
      made.push({ accountId: acct!.id, subscriptionId: sub!.id, seq });
    }
    [a, b] = made as [typeof a, typeof b];
  }, ISOLATED_DB_RESET_BUDGET_MS);

  afterAll(async () => { await owned.close(); });

  it("each wake's read and its prune ride a transaction that names the wake's own account", async () => {
    const subs = new Set<(accountId: string, seq: bigint) => void>();
    const source: WakeSource = { subscribeAll(cb) { subs.add(cb); return () => subs.delete(cb); } };
    // Gone, every endpoint: each wake reads its account's registration and deletes it.
    const post: PushWakePost = async () => ({ status: 410 });
    const binding = bindWorker(owned.db);
    wire.start();
    const wake = startPushWake({
      dbOf: (accountId) => binding.forAccount(accountId).db as unknown as Tx,
      source, guard: PERMIT, post, ownsAccount: async () => true, vapid: NO_VAPID,
      debounceMs: 5, minIntervalMs: 0,
    });
    try {
      for (const cb of subs) cb(a.accountId, a.seq);
      await tick(300);
      for (const cb of subs) cb(b.accountId, b.seq);
      for (let i = 0; i < 60; i++) {
        const left = await owned.db.select({ id: pushSubscriptions.id }).from(pushSubscriptions);
        if (left.length === 0) break;
        await tick(50);
      }
    } finally {
      wake.stop();
    }
    const flights: PgWireFlight[] = flightsOf(wire.read());
    const onRegistrations = flights.filter((f) => f.statements.some((s) => namedBy(s).reads.includes("push_subscriptions")));
    const ofA = onRegistrations.filter((f) => carries(f, a.subscriptionId) || carries(f, a.accountId));
    const ofB = onRegistrations.filter((f) => carries(f, b.subscriptionId) || carries(f, b.accountId));

    // The test's own reads and seeds are on the pool's own handle; the wake's are in flights.
    const wakes = onRegistrations.filter((f) => f.door !== "plain");
    expect(wakes.length, "the wakes' read and prune, two of each").toBeGreaterThanOrEqual(4);
    for (const f of wakes) {
      expect(f.account === a.accountId || f.account === b.accountId, "a wake's flight names its account").toBe(true);
    }
    for (const f of ofA.filter((x) => x.door !== "plain")) {
      expect(f.account).toBe(a.accountId);
      expect(carries(f, b.accountId) || carries(f, b.subscriptionId)).toBe(false);
    }
    for (const f of ofB.filter((x) => x.door !== "plain")) {
      expect(f.account).toBe(b.accountId);
      expect(carries(f, a.accountId) || carries(f, a.subscriptionId)).toBe(false);
    }
    // Each wake's look at its window of the change log rides its own account's flight too.
    const onLog = flights.filter((f) => f.door !== "plain" && f.statements.some((s) => namedBy(s).reads.includes("change_log")));
    expect(onLog.some((f) => f.account === a.accountId), "A's wake asked its change log on A's handle").toBe(true);
    expect(onLog.some((f) => f.account === b.accountId), "B's wake asked its change log on B's handle").toBe(true);
    expect(flights.filter((f) => f.door === "plain" && f.statements.some((s) => namedBy(s).reads.includes("change_log"))),
      "no wake asked the change log on the pool's own handle").toEqual([]);
    // And both registrations were read and deleted, each by its own account's wake.
    expect(ofA.some((f) => f.door !== "plain" && f.statements.some((s) => namedBy(s).writes === "push_subscriptions"))).toBe(true);
    expect(ofB.some((f) => f.door !== "plain" && f.statements.some((s) => namedBy(s).writes === "push_subscriptions"))).toBe(true);
  }, 60_000);
});
