import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { accounts, changeLog, devices, sessions, users } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { ringDeviceMade, ringDeviceRevoked } from "../src/auth/device-doorbell.js";
import { dbFor, type ServiceContext } from "../src/context.js";
import { deviceNumbers } from "../src/device-numbers.js";
import { materializeSettings } from "../src/dto/materialize.js";

/**
 * THE ACCOUNT'S NAMED DEVICES, COUNTED ON BOTH STORES. The settings record is made by one function
 * wherever a client's feed is served: a server's Postgres, a desktop's own store, and the store a
 * phone carries when it organizes its mailbox itself. This file runs under both projects, so the
 * count, the column a take-back stamps and the ring's own transaction are each run on the device
 * store's dialect too, where a statement that only one store can parse fails by name.
 */
const NOW = new Date("2026-11-17T11:00:00.000Z");

async function seeded() {
  const db = await makeTestDb();
  const person = async () => {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `devices-${accountId.slice(0, 8)}` });
    const [user] = await db.insert(users).values({
      accountId, email: `devices-${accountId.slice(0, 8)}@example.com`, displayName: "D",
    }).returning({ id: users.id });
    return { accountId, userId: user!.id };
  };
  /** A named device with one session: signed in, or ended at `endedAt`. */
  const device = async (who: { accountId: string; userId: string }, endedAt: Date | null = null): Promise<string> => {
    const [row] = await db.insert(devices).values({ ...who, kind: "mobile-android", label: "Pixel in the kitchen" }).returning({ id: devices.id });
    await db.insert(sessions).values({
      ...who, deviceId: row!.id, familyId: randomUUID(), scope: "full",
      accessExpiresAt: new Date(NOW.getTime() + 3_600_000), refreshExpiresAt: new Date(NOW.getTime() + 7_200_000),
      revokedAt: endedAt, lastSeenAt: NOW,
    });
    return row!.id;
  };
  /** A plain browser session: no device row. */
  const browser = async (who: { accountId: string; userId: string }): Promise<void> => {
    await db.insert(sessions).values({
      ...who, familyId: randomUUID(), scope: "full",
      accessExpiresAt: new Date(NOW.getTime() + 3_600_000), refreshExpiresAt: new Date(NOW.getTime() + 7_200_000), lastSeenAt: NOW,
    });
  };
  // A take-back is a call with a session: its handle is bound to that session's account.
  const ctx = (who: { accountId: string; userId: string }): ServiceContext =>
    ({ db: dbFor(db, who.accountId), accountId: who.accountId, userId: who.userId, now: () => NOW, requestId: "devices-twin" });
  const rings = async (accountId: string): Promise<number> => (await db.select({ seq: changeLog.seq }).from(changeLog)
    .where(and(eq(changeLog.accountId, accountId), eq(changeLog.entityType, "settings")))).length;
  return { db, person, device, browser, ctx, rings };
}

describe("the account's named devices on this store", () => {
  it("counts the devices ever made, those taken back and those signed in, for one account", async () => {
    const s = await seeded();
    const a = await s.person();
    const b = await s.person();
    expect(await deviceNumbers(s.db as never, a.accountId)).toEqual({ made: 0, revoked: 0, live: 0 });
    await s.device(a);
    await s.device(a);
    await s.device(a, NOW);            // one that signed itself out: made, not signed in, not taken back
    await s.browser(a);                // no named device
    await s.device(b);
    expect(await deviceNumbers(s.db as never, a.accountId)).toEqual({ made: 3, revoked: 0, live: 2 });
    expect(await deviceNumbers(s.db as never, b.accountId)).toEqual({ made: 1, revoked: 0, live: 1 });
    const record = await materializeSettings(s.db as never, a.accountId, a.accountId);
    expect(record).toMatchObject({ devices: 2, devicesMade: 3, devicesRevoked: 0 });
  });

  it("a take-back's ring stamps the device once and writes one settings change; a device made rings one", async () => {
    const s = await seeded();
    const a = await s.person();
    const taken = await s.device(a, NOW);
    await s.device(a);

    await ringDeviceRevoked(s.ctx(a), { accountId: a.accountId, userId: a.userId, deviceId: taken });
    expect(await deviceNumbers(s.db as never, a.accountId)).toEqual({ made: 2, revoked: 1, live: 1 });
    const [row] = await s.db.select({ at: devices.revokedAt }).from(devices).where(eq(devices.id, taken));
    expect(row!.at).toEqual(NOW);
    expect(await s.rings(a.accountId)).toBe(1);

    await ringDeviceRevoked(s.ctx(a), { accountId: a.accountId, userId: a.userId, deviceId: taken });
    expect(await s.rings(a.accountId), "a device already stamped rings nothing more").toBe(1);

    await ringDeviceMade(s.ctx(a), a.accountId);
    expect(await s.rings(a.accountId)).toBe(2);
    expect((await materializeSettings(s.db as never, a.accountId, a.accountId))!.devicesRevoked).toBe(1);
  });
});
