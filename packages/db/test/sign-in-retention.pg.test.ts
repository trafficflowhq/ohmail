import { accountOfUser } from "../src/parent-account.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, inArray } from "drizzle-orm";
import { brandDialect } from "../src/dialect/index.js";
import { schema } from "../src/schema.js";
import { runMigrations } from "../src/migrate.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";
import { accounts, devices, refreshTokens, sessions, users } from "../src/schema-mail.js";
import { loginTokens } from "../src/schema-cloud.js";
import type { Tx } from "../src/change-log.js";
import { pruneSignInRecords } from "../src/retention.js";

/**
 * THE PASS UNDER REAL ROW LOCKS. Every batch takes its rows FOR UPDATE SKIP LOCKED, so a row an
 * erasure or a rotation holds is passed over and the pass returns; the sessions' lock timeout is the
 * belt. Dated in 2001, so on a shared lane database the pass can only ever reach rows this file
 * planted: every other file's rows are younger than its horizon.
 */
const PG_UP = await realPgAvailable();
const DAY = 86_400_000;
const NOW = new Date("2001-01-01T00:00:00.000Z");
const ago = (days: number): Date => new Date(NOW.getTime() - days * DAY);

let client: ReturnType<typeof postgres>;
let holder: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;
const planted: string[] = [];

async function plantUser(): Promise<{ accountId: string; userId: string }> {
  const [acct] = await db.insert(accounts).values({ name: `sir-${randomUUID()}` }).returning();
  planted.push(acct!.id);
  const [user] = await db.insert(users).values({ accountId: acct!.id, email: `sir+${randomUUID()}@example.test` }).returning();
  return { accountId: acct!.id, userId: user!.id };
}

/** Runs `pass` while a second connection holds `lockSql`'s row; lets go after 3 s, so a wait shows. */
async function whileHeld<T>(lockSql: (sql: postgres.TransactionSql) => Promise<unknown>, pass: () => Promise<T>): Promise<{ r: T; elapsed: number }> {
  let release!: () => void;
  const released = new Promise<void>((r) => { release = r; });
  let locked!: () => void;
  const isLocked = new Promise<void>((r) => { locked = r; });
  const holding = holder.begin(async (sql) => { await lockSql(sql); locked(); await released; });
  await isLocked;
  const timer = setTimeout(release, 3_000);
  const t0 = Date.now();
  try {
    const r = await pass();
    return { r, elapsed: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
    release();
    await holding;
  }
}

async function plantRevoked(n: number): Promise<string[]> {
  const { accountId, userId } = await plantUser();
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const familyId = randomUUID();
    const [s] = await db.insert(sessions).values({
      accountId, userId, familyId, accessTokenHash: randomUUID(),
      accessExpiresAt: ago(40), refreshExpiresAt: ago(40), revokedAt: ago(40), createdAt: ago(50), lastSeenAt: ago(41),
    }).returning();
    // Revoked with its family's tokens, as every revocation path does: the erasure names none of them.
    await db.insert(refreshTokens).values({
      accountId, userId, sessionId: s!.id, familyId, tokenHash: randomUUID(), expiresAt: ago(40), revokedAt: ago(40),
    });
    ids.push(s!.id);
  }
  return ids;
}

describe.skipIf(!PG_UP)("the sign-in retention pass under row locks (real Postgres)", () => {
  beforeAll(async () => {
    client = postgres(PG_TEST_URL, { max: 4 });
    holder = postgres(PG_TEST_URL, { max: 1 });
    db = brandDialect(drizzle(client, { schema }), "pg");
    await runMigrations(PG_TEST_URL);
  }, 120_000);

  afterAll(async () => {
    if (db && planted.length > 0) {
      const own = await db.select({ id: sessions.id }).from(sessions).where(inArray(sessions.accountId, planted));
      if (own.length > 0) {
        await db.delete(refreshTokens).where(inArray(refreshTokens.sessionId, own.map((r) => r.id)));
        await db.delete(sessions).where(inArray(sessions.id, own.map((r) => r.id)));
      }
      const ownUsers = (await db.select({ id: users.id }).from(users).where(inArray(users.accountId, planted))).map((u) => u.id);
      if (ownUsers.length > 0) {
        await db.delete(loginTokens).where(inArray(loginTokens.userId, ownUsers));
        await db.delete(devices).where(inArray(devices.userId, ownUsers));
      }
      await db.delete(users).where(inArray(users.accountId, planted));
      await db.delete(accounts).where(inArray(accounts.id, planted));
    }
    await holder?.end({ timeout: 5 });
    await client?.end({ timeout: 5 });
  });

  it("passes over a session another transaction holds, deletes the rest, and returns well inside the timeout", async () => {
    const ids = await plantRevoked(3);
    const held = ids[1]!;
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => { locked = r; });
    const holding = holder.begin(async (sql) => {
      await sql`select id from sessions where id = ${held} for update`;
      locked();
      await released;
    });
    await isLocked;
    const t0 = Date.now();
    try {
      const r = await pruneSignInRecords(db as unknown as Tx, NOW, { retentionMs: 30 * DAY });
      const elapsed = Date.now() - t0;
      expect(r.sessions).toBeGreaterThanOrEqual(2); // the pass is global: this file reads its own rows below
      expect(elapsed).toBeLessThan(2_000);
      const left = (await db.select({ id: sessions.id }).from(sessions).where(inArray(sessions.id, ids))).map((x) => x.id);
      expect(left).toEqual([held]);
      expect((await db.select().from(refreshTokens).where(eq(refreshTokens.sessionId, held))).length).toBe(1);
    } finally {
      release();
      await holding;
    }
    // Released, the held session goes on the next pass.
    await pruneSignInRecords(db as unknown as Tx, NOW, { retentionMs: 30 * DAY });
    expect(await db.select({ id: sessions.id }).from(sessions).where(inArray(sessions.id, ids))).toEqual([]);
  }, 30_000);

  it("deletes a session's refresh tokens in bounded statements, keeps the session until the last, and goes on", async () => {
    const { accountId, userId } = await plantUser();
    const familyId = randomUUID();
    const [s] = await db.insert(sessions).values({
      accountId, userId, familyId, accessTokenHash: randomUUID(),
      accessExpiresAt: ago(40), refreshExpiresAt: ago(40), revokedAt: ago(40), createdAt: ago(50), lastSeenAt: ago(41),
    }).returning();
    for (let i = 0; i < 5; i++) {
      await db.insert(refreshTokens).values({
        accountId, userId, sessionId: s!.id, familyId, tokenHash: randomUUID(), expiresAt: ago(40), revokedAt: ago(40),
      });
    }
    const [d] = await db.insert(devices).values({
      accountId, userId, kind: "macos", ip: "192.0.2.8", createdAt: ago(60), lastSeenAt: ago(45),
    }).returning();
    const left = async () => [
      (await db.select().from(refreshTokens).where(eq(refreshTokens.sessionId, s!.id))).length,
      (await db.select().from(sessions).where(eq(sessions.id, s!.id))).length,
    ];

    const capped = await pruneSignInRecords(db as unknown as Tx, NOW, { retentionMs: 30 * DAY, tokenBatch: 2, maxBatches: 1 });
    expect(capped).toMatchObject({ sessions: 0, refreshTokens: 2, stoppedBy: "batches" });
    expect(await left()).toEqual([3, 1]);
    expect((await db.select({ ip: devices.ip }).from(devices).where(eq(devices.id, d!.id)))[0]!.ip, "the device step never ran").toBe("");

    // The pass is global: this file reads its own rows.
    const rest = await pruneSignInRecords(db as unknown as Tx, NOW, { retentionMs: 30 * DAY, tokenBatch: 2 });
    expect(rest.stoppedBy).toBe("dry");
    expect(await left()).toEqual([0, 0]);
  }, 30_000);

  it("passes over a sign-in record another transaction holds instead of waiting for it", async () => {
    const { userId } = await plantUser();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const [t] = await db.insert(loginTokens).values({ userId, accountId: accountOfUser(userId), tokenHash: randomUUID(), expiresAt: ago(40 + i) }).returning();
      ids.push(t!.id);
    }
    const held = ids[1]!;
    const { r, elapsed } = await whileHeld(
      (sql) => sql`select id from login_tokens where id = ${held} for update`,
      () => pruneSignInRecords(db as unknown as Tx, NOW, { retentionMs: 30 * DAY }),
    );
    // A delete that waited would take all three once the holder let go, three seconds in.
    expect(r.loginTokens).toBeGreaterThanOrEqual(2);
    expect(elapsed).toBeLessThan(2_000);
    expect((await db.select({ id: loginTokens.id }).from(loginTokens).where(inArray(loginTokens.id, ids))).map((x) => x.id))
      .toEqual([held]);
    await pruneSignInRecords(db as unknown as Tx, NOW, { retentionMs: 30 * DAY });
    expect(await db.select({ id: loginTokens.id }).from(loginTokens).where(inArray(loginTokens.id, ids))).toEqual([]);
  }, 30_000);

  it("passes over a device another transaction holds when it clears added-from addresses", async () => {
    const { accountId, userId } = await plantUser();
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const [d] = await db.insert(devices).values({
        accountId, userId, kind: "macos", ip: "192.0.2.7", createdAt: ago(60), lastSeenAt: ago(45),
      }).returning();
      ids.push(d!.id);
    }
    const held = ids[0]!;
    const { r, elapsed } = await whileHeld(
      (sql) => sql`select id from devices where id = ${held} for update`,
      () => pruneSignInRecords(db as unknown as Tx, NOW, { retentionMs: 30 * DAY }),
    );
    expect(r.deviceAddresses).toBeGreaterThanOrEqual(1);
    expect(elapsed).toBeLessThan(2_000);
    const ip = async (id: string): Promise<string> => (await db.select({ ip: devices.ip }).from(devices).where(eq(devices.id, id)))[0]!.ip;
    expect([await ip(held), await ip(ids[1]!)]).toEqual(["192.0.2.7", ""]);
    await pruneSignInRecords(db as unknown as Tx, NOW, { retentionMs: 30 * DAY });
    expect(await ip(held)).toBe("");
  }, 30_000);
});
