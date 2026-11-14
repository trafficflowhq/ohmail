import { accountOfUser } from "../src/parent-account.js";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, devices, pairingTokens, refreshTokens, sessions, users, type Tx } from "@trafficflow/db";
import { invites, loginTokens, oauthAuthCodes, staffSessions, staffUsers } from "@trafficflow/db/cloud";
import { pruneSignInRecords, SIGN_IN_RECORD_RETENTION_MS } from "../src/retention.js";

/**
 * THE SIGN-IN RETENTION PASS, ROW BY ROW (PGlite): what goes 30 days past its end and what never
 * goes early. The lock behaviour (SKIP LOCKED, the lock timeout) is the pg file's subject; this one
 * holds the predicates, the batches and the clock. A session's family with a live member keeps its
 * dead sessions and their tokens: the consumed ones are the reuse detector's evidence. A session
 * the account erasure would still name a token of stays too, however its own dates read.
 */
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-05T12:00:00.000Z");
const ago = (days: number): Date => new Date(NOW.getTime() - days * DAY);
const ahead = (days: number): Date => new Date(NOW.getTime() + days * DAY);
const H = (): string => randomUUID().replace(/-/g, "");

async function seeded() {
  const db = await makeTestDb();
  const tx = db as unknown as Tx;
  const [acct] = await db.insert(accounts).values({ name: "T" }).returning();
  const accountId = acct!.id;
  const [user] = await db.insert(users).values({ accountId, email: `u+${accountId}@example.test` }).returning();
  const userId = user!.id;
  // A revocation revokes the family's tokens with the session (every path does); `tokensRevoked`
  // and `tokenExpiresAt` build the rows no path writes today, for the predicate that guards them.
  const session = async (o: {
    revokedAt?: Date | null; refreshExpiresAt: Date; familyId?: string; deviceId?: string;
    tokensRevoked?: boolean; tokenExpiresAt?: Date;
  }) => {
    const familyId = o.familyId ?? randomUUID();
    const [s] = await db.insert(sessions).values({
      accountId, userId, familyId, deviceId: o.deviceId ?? null, accessTokenHash: H(),
      accessExpiresAt: o.refreshExpiresAt, refreshExpiresAt: o.refreshExpiresAt, revokedAt: o.revokedAt ?? null,
      createdAt: ago(900), lastSeenAt: ago(60),
    }).returning();
    const revokedAt = (o.tokensRevoked ?? o.revokedAt != null) ? (o.revokedAt ?? ago(1)) : null;
    const expiresAt = o.tokenExpiresAt ?? o.refreshExpiresAt;
    await db.insert(refreshTokens).values([
      { accountId, userId, sessionId: s!.id, familyId, tokenHash: H(), expiresAt, consumedAt: ago(61), revokedAt },
      { accountId, userId, sessionId: s!.id, familyId, tokenHash: H(), expiresAt, revokedAt },
    ]);
    return s!.id;
  };
  const device = async (createdAt: Date) => (await db.insert(devices).values({
    accountId, userId, kind: "macos", label: "Desk", ip: "192.0.2.10", createdAt, lastSeenAt: createdAt,
  }).returning())[0]!.id;
  return { db, tx, accountId, userId, session, device };
}

const prune = (tx: Tx, o: Partial<Parameters<typeof pruneSignInRecords>[2]> = {}) =>
  pruneSignInRecords(tx, NOW, { retentionMs: SIGN_IN_RECORD_RETENTION_MS, ...o });

describe("the sign-in retention pass", () => {
  it("the horizon is 30 days", () => {
    expect(SIGN_IN_RECORD_RETENTION_MS).toBe(30 * DAY);
  });

  it("deletes sign-in records 30 days past expiry, an unconfirmed desktop request included, and keeps the rest", async () => {
    const { db, tx, userId } = await seeded();
    const lt = async (purpose: string, expiresAt: Date, user: string | null = userId) =>
      (await db.insert(loginTokens).values({ userId: user, accountId: user === null ? null : accountOfUser(user), tokenHash: H(), purpose, expiresAt }).returning())[0]!.id;
    const gone = [await lt("login", ago(31)), await lt("desktop_approval", ago(31), null), await lt("email_verify", ago(40))];
    const kept = [await lt("login", ago(29)), await lt("desktop_link", ahead(1)), await lt("desktop_approval", ago(29), null)];
    const code = async (expiresAt: Date, consumedAt: Date | null) => (await db.insert(oauthAuthCodes).values({
      userId, accountId: accountOfUser(userId), clientId: "tf-macos", codeHash: H(), codeChallenge: H(), redirectUri: "trafficflow://auth", expiresAt, consumedAt,
    }).returning())[0]!.id;
    const oldCode = await code(ago(31), ago(31));
    const freshCode = await code(ago(29), ago(29));
    const pair = async (expiresAt: Date) => (await db.insert(pairingTokens).values({
      createdByUserId: userId, accountId: accountOfUser(userId), grant: "device-pair", tokenHash: H(), expiresAt,
    }).returning())[0]!.id;
    const oldPair = await pair(ago(31));
    const freshPair = await pair(ago(29));

    const r = await prune(tx);
    expect(r).toMatchObject({ loginTokens: 3, oauthCodes: 1, pairingTokens: 1, stoppedBy: "dry" });
    const left = (await db.select({ id: loginTokens.id }).from(loginTokens)).map((x) => x.id).sort();
    expect(left).toEqual([...kept].sort());
    expect(gone.some((id) => left.includes(id))).toBe(false);
    expect((await db.select({ id: oauthAuthCodes.id }).from(oauthAuthCodes)).map((x) => x.id)).toEqual([freshCode]);
    expect((await db.select({ id: pairingTokens.id }).from(pairingTokens)).map((x) => x.id)).toEqual([freshPair]);
    expect([oldCode, oldPair]).toHaveLength(2);
  });

  it("deletes a session 30 days after it was signed out, and one never signed out only when the erasure's keep has run out", async () => {
    const { db, tx, session } = await seeded();
    const revoked = await session({ revokedAt: ago(31), refreshExpiresAt: ago(20) });
    const recent = await session({ revokedAt: ago(29), refreshExpiresAt: ago(20) });
    // Never revoked: nothing revokes a paired device's session, and its app may come back after
    // the account is gone. The erasure names its token 400 days past the window; so long it stays.
    const lapsed = await session({ revokedAt: null, refreshExpiresAt: ago(31) });
    const lapsedLong = await session({ revokedAt: null, refreshExpiresAt: ago(399) });
    const lapsedOut = await session({ revokedAt: null, refreshExpiresAt: ago(401) });
    const live = await session({ revokedAt: null, refreshExpiresAt: ahead(60) });
    const family = randomUUID();
    const deadSibling = await session({ revokedAt: ago(45), refreshExpiresAt: ago(40), familyId: family });
    const liveSibling = await session({ revokedAt: null, refreshExpiresAt: ahead(60), familyId: family });

    const r = await prune(tx);
    expect(r).toMatchObject({ sessions: 2, refreshTokens: 4, stoppedBy: "dry" });
    const left = (await db.select({ id: sessions.id }).from(sessions)).map((x) => x.id);
    expect(left.sort()).toEqual([recent, lapsed, lapsedLong, live, deadSibling, liveSibling].sort());
    expect(left).not.toContain(revoked);
    expect(left).not.toContain(lapsedOut);
    const tokensOf = async (id: string) => (await db.select().from(refreshTokens).where(eq(refreshTokens.sessionId, id))).length;
    expect(await tokensOf(deadSibling)).toBe(2);
    expect(await tokensOf(lapsed)).toBe(2);
  });

  it("keeps a session the erasure would still name a token of, whatever its own dates say", async () => {
    const { db, tx, session } = await seeded();
    // A row written before `refresh_expires_at` rolled with each rotation: the session's date is
    // long past, its newest token expired a month ago and is still inside the erasure's keep.
    const staleDate = await session({ revokedAt: null, refreshExpiresAt: ago(401), tokenExpiresAt: ago(31) });
    // Revoked without its tokens, which no revocation path does: the erasure would copy them.
    const revokedLiveTokens = await session({ revokedAt: ago(31), refreshExpiresAt: ago(20), tokensRevoked: false });
    // The control beside them, with the same session dates and nothing the erasure names: it goes.
    const control = await session({ revokedAt: null, refreshExpiresAt: ago(401) });

    const r = await prune(tx);
    expect(r).toMatchObject({ sessions: 1, refreshTokens: 2 });
    const left = (await db.select({ id: sessions.id }).from(sessions)).map((x) => x.id);
    expect(left.sort()).toEqual([staleDate, revokedLiveTokens].sort());
    expect(left).not.toContain(control);
  });

  it("blanks a device's address once its last session's record is gone, and keeps its name and row", async () => {
    const { db, tx, session, device } = await seeded();
    const orphaned = await device(ago(60));
    await session({ revokedAt: ago(31), refreshExpiresAt: ago(20), deviceId: orphaned });
    const inUse = await device(ago(60));
    await session({ revokedAt: null, refreshExpiresAt: ahead(60), deviceId: inUse });
    const young = await device(ago(5));
    // Its session ran out a month ago and stays for the erasure's keep, so its address does too.
    const lapsedApp = await device(ago(60));
    await session({ revokedAt: null, refreshExpiresAt: ago(31), deviceId: lapsedApp });

    const r = await prune(tx);
    expect(r.deviceAddresses).toBe(1);
    const rows = await db.select({ id: devices.id, ip: devices.ip, label: devices.label }).from(devices)
      .where(inArray(devices.id, [orphaned, inUse, young, lapsedApp]));
    const byId = new Map(rows.map((d) => [d.id, d]));
    expect(byId.get(orphaned)).toMatchObject({ ip: "", label: "Desk" });
    expect(byId.get(inUse)!.ip).toBe("192.0.2.10");
    expect(byId.get(young)!.ip).toBe("192.0.2.10");
    expect(byId.get(lapsedApp)!.ip).toBe("192.0.2.10");
  });

  it("clears device addresses in batches, under the batch count and the clock", async () => {
    const { db, tx, device } = await seeded();
    for (let i = 0; i < 3; i++) await device(ago(60));
    const r = await prune(tx, { sessionBatch: 1, maxBatches: 2 });
    expect(r).toMatchObject({ deviceAddresses: 2, stoppedBy: "batches" });
    let t = 0;
    // The clock runs out before the device step: nothing more is cleared, and the pass says why.
    const late = await prune(tx, { clock: () => (t += 1_000), deadlineMs: 6_000 });
    expect(late).toMatchObject({ deviceAddresses: 0, stoppedBy: "deadline" });
    expect((await prune(tx)).deviceAddresses).toBe(1);
    const left = await db.select({ ip: devices.ip }).from(devices);
    expect(left.every((d) => d.ip === "")).toBe(true);
  });

  it("a session's refresh tokens go in bounded statements: a capped batch keeps the session and the pass goes on", async () => {
    const { db, tx, accountId, userId, device } = await seeded();
    const familyId = randomUUID();
    const [s] = await db.insert(sessions).values({
      accountId, userId, familyId, accessTokenHash: H(), accessExpiresAt: ago(40), refreshExpiresAt: ago(40),
      revokedAt: ago(40), createdAt: ago(900), lastSeenAt: ago(41),
    }).returning();
    for (let i = 0; i < 5; i++) {
      await db.insert(refreshTokens).values({
        accountId, userId, sessionId: s!.id, familyId, tokenHash: H(), expiresAt: ago(40), revokedAt: ago(40),
      });
    }
    const orphan = await device(ago(60));
    const tokensLeft = async () => (await db.select().from(refreshTokens).where(eq(refreshTokens.sessionId, s!.id))).length;
    const sessionLeft = async () => (await db.select().from(sessions).where(eq(sessions.id, s!.id))).length;

    const capped = await prune(tx, { tokenBatch: 2, maxBatches: 1 });
    expect(capped).toMatchObject({ sessions: 0, refreshTokens: 2, deviceAddresses: 1, stoppedBy: "batches" });
    expect([await tokensLeft(), await sessionLeft()]).toEqual([3, 1]);
    expect((await db.select({ ip: devices.ip }).from(devices).where(eq(devices.id, orphan)))[0]!.ip).toBe("");

    const rest = await prune(tx, { tokenBatch: 2 });
    expect(rest).toMatchObject({ sessions: 1, refreshTokens: 3, stoppedBy: "dry" });
    expect([await tokensLeft(), await sessionLeft()]).toEqual([0, 0]);
  });

  it("an unused invitation goes 30 days past expiry; a used one stays", async () => {
    const { db, tx } = await seeded();
    const invite = async (expiresAt: Date, consumedAt: Date | null) => (await db.insert(invites).values({
      codeHash: H(), email: `i+${H()}@example.test`, expiresAt, consumedAt,
    }).returning())[0]!.id;
    const unusedOld = await invite(ago(31), null);
    const usedOld = await invite(ago(31), ago(40));
    const unusedRecent = await invite(ago(29), null);
    const r = await prune(tx);
    expect(r.invites).toBe(1);
    const left = (await db.select({ id: invites.id }).from(invites)).map((x) => x.id).sort();
    expect(left).toEqual([usedOld, unusedRecent].sort());
    expect(left).not.toContain(unusedOld);
  });

  it("a staff session goes 30 days past expiry", async () => {
    const { db, tx } = await seeded();
    const [staff] = await db.insert(staffUsers).values({ email: `s+${H()}@example.test`, passwordHash: "x" }).returning();
    const s = async (expiresAt: Date) => (await db.insert(staffSessions).values({
      staffUserId: staff!.id, tokenHash: H(), expiresAt, lastTwofaAt: ago(60),
    }).returning())[0]!.id;
    await s(ago(31));
    const fresh = await s(ago(29));
    expect((await prune(tx)).staffSessions).toBe(1);
    expect((await db.select({ id: staffSessions.id }).from(staffSessions)).map((x) => x.id)).toEqual([fresh]);
  });

  it("a table with more than its batches left says so, and the clock stops the pass", async () => {
    const { db, tx, userId } = await seeded();
    for (let i = 0; i < 3; i++) await db.insert(loginTokens).values({ userId, accountId: accountOfUser(userId), tokenHash: H(), expiresAt: ago(40) });
    const r = await prune(tx, { batch: 1, maxBatches: 2 });
    expect(r).toMatchObject({ loginTokens: 2, stoppedBy: "batches" });
    let t = 0;
    const late = await prune(tx, { clock: () => (t += 20_000), deadlineMs: 10_000 });
    expect(late).toMatchObject({ loginTokens: 0, stoppedBy: "deadline" });
    expect((await prune(tx)).loginTokens).toBe(1);
  });
});
