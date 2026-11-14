import { describe, it, expect } from "vitest";
import { makeTestDb } from "../src/testing.js";
import { accounts, idempotencyKeys } from "@trafficflow/db";
import { pushSubscriptions } from "../src/cloud.js";
import { and, eq } from "drizzle-orm";

// Proves migration 0006's two new tables persist rows (mirror of schema.roundtrip).
describe("migration 0006 round-trip", () => {
  const acct = "00000000-0000-0000-0000-0000000000a6";

  it("persists an idempotency_keys row (composite PK + jsonb + bigint seq)", async () => {
    const db = await makeTestDb();
    await db.insert(idempotencyKeys).values({
      accountId: acct, key: "idem-1", requestHash: "abc123",
      responseStatus: 201, responseJson: { ok: true, id: "x" }, seq: 42,
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    const got = await db.select().from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.accountId, acct), eq(idempotencyKeys.key, "idem-1")));
    expect(got).toHaveLength(1);
    expect(got[0].responseStatus).toBe(201);
    expect(got[0].responseJson).toEqual({ ok: true, id: "x" });
    expect(got[0].seq).toBe(42);
  });

  it("persists a push_subscriptions row (webpush + apns shapes)", async () => {
    const db = await makeTestDb();
    await db.insert(accounts).values({ id: acct, name: "wake" });
    const [web] = await db.insert(pushSubscriptions).values({
      accountId: acct, transport: "webpush",
      endpoint: "https://push.example/abc", p256dh: "key", auth: "auth",
    }).returning();
    const [apns] = await db.insert(pushSubscriptions).values({
      accountId: acct, transport: "apns",
      deviceToken: "dt-123", bundleId: "ch.trafficflow", environment: "production",
    }).returning();

    const got = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.accountId, acct));
    expect(got).toHaveLength(2);
    expect(web.endpoint).toBe("https://push.example/abc");
    expect(apns.deviceToken).toBe("dt-123");
  });

  it("enforces the coalesced identity unique index (account_id, transport, COALESCE(endpoint, device_token))", async () => {
    const db = await makeTestDb();
    await db.insert(accounts).values({ id: acct, name: "wake" });
    await db.insert(pushSubscriptions).values({
      accountId: acct, transport: "webpush", endpoint: "https://push.example/dup",
    });
    await expect(
      db.insert(pushSubscriptions).values({
        accountId: acct, transport: "webpush", endpoint: "https://push.example/dup",
      }),
    ).rejects.toThrow();
  });
});
