import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { accounts, bindDb, users, devices, sessions, refreshTokens } from "@trafficflow/db";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  dbFor, makeAuthService, makeTestAuthDeps, generateToken, hashToken,
  resolveSession, REVOKE_WEB_SESSIONS_MAX_AGE_DAYS, type ServiceContext,
} from "../src/index.js";

/**
 * ═══ BULK REVOKE vs A CONCURRENT ROTATION — real Postgres, because PGlite cannot race ═══
 *
 * `revokeWebSessions` sweeps a family's `refresh_tokens` by UPDATE while `rotateRefresh` is
 * claim-first: a rotation that claims its token BEFORE the sweep runs can insert its freshly
 * minted successor AFTER the sweep's UPDATE has already scanned — an orphan the sweep never
 * saw, on a session the sweep just revoked. PGlite serializes everything on one thread, so
 * this interleaving is unrepresentable there; three production bugs taught this repo that
 * "green on PGlite" says nothing about exactly this class.
 *
 * The invariant under test is the ORPHAN GUARD in `rotateRefresh` (the re-read of the session
 * after the claim): whatever the interleaving, a revoked session has NO USABLE DESCENDANT —
 * the racer may walk away holding a token pair, but presenting either half afterwards is a
 * refusal, and the family dies with the attempt. Asserted behaviorally (present the loot,
 * expect 401/null), never by row-counting a window that is by nature unordered.
 */

const PG_UP = await realPgAvailable();

// The factory's handle (postgres-js): the binder takes a server handle only from the factory that
// registered its door.
let owned: OwnedDb | undefined;
let db: OwnedDb["db"];

// A door before sign-in holds a handle bound to nothing; a call that carries a session, its account's.
const ctx = (over: Partial<ServiceContext> = {}): ServiceContext => ({
  db: over.accountId === undefined ? bindDb(db, { account: null }) : dbFor(db, over.accountId),
  accountId: "", userId: null, now: () => new Date(),
  requestId: "revoke-race-pg", ip: "10.1.1.1", ...over,
});

describe.skipIf(!PG_UP)("revokeWebSessions racing rotateRefresh (postgres-js)", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    owned = makeOwnedDb(PG_TEST_URL);
    db = owned.db;
  });

  afterAll(async () => {
    await owned?.close();
  });

  it("a revoked web session has no usable descendant, under every interleaving", async () => {
    const svc = makeAuthService(makeTestAuthDeps());
    const now = new Date();
    const [acct] = await db.insert(accounts).values({ name: `race-${randomUUID()}` }).returning();
    const [user] = await db.insert(users).values({
      accountId: acct!.id, email: `race-${randomUUID()}@x.example`, displayName: "R",
      emailVerifiedAt: now,
    }).returning();
    const me = { accountId: acct!.id, userId: user!.id };

    const seedWebSession = async (o: { lastTwofaAt?: Date | null } = {}) => {
      const access = generateToken();
      const refresh = generateToken();
      const [s] = await db.insert(sessions).values({
        ...me, deviceId: null, familyId: randomUUID(),
        accessTokenHash: hashToken(access),
        accessExpiresAt: new Date(Date.now() + 60 * 60_000),
        refreshExpiresAt: new Date(Date.now() + 90 * 24 * 60 * 60_000),
        lastTwofaAt: o.lastTwofaAt ?? null, lastSeenAt: new Date(),
      }).returning();
      await db.insert(refreshTokens).values({
        ...me, sessionId: s!.id, familyId: s!.familyId,
        tokenHash: hashToken(refresh),
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60_000),
      });
      return { sessionId: s!.id, familyId: s!.familyId, access, refresh };
    };

    for (let round = 0; round < 10; round++) {
      const caller = await seedWebSession({ lastTwofaAt: new Date() });
      const victim = await seedWebSession();

      const [, rotation] = await Promise.all([
        svc.revokeWebSessions(ctx({ ...me, sessionId: caller.sessionId })),
        svc.refresh(ctx(), { refreshToken: victim.refresh }, { surface: "cookie" })
          .then((r) => ({ ok: true as const, tokens: r.tokens! }))
          .catch(() => ({ ok: false as const })),
      ]);

      // The session row itself is dead whichever side won.
      const [victimRow] = await db.select().from(sessions).where(eq(sessions.id, victim.sessionId));
      expect(victimRow!.revokedAt, `round ${round}: the victim session survived the sweep`).not.toBeNull();

      if (rotation.ok) {
        // The racer got a pair out — the interleaving under test. Neither half may work:
        // the access token resolves to nothing (revoked session), and presenting the refresh
        // token trips the orphan guard, which kills the family instead of rotating it.
        expect(await resolveSession(bindDb(db, { account: null }), rotation.tokens.accessToken, new Date()),
          `round ${round}: a rotated access token still resolves on a revoked session`).toBeNull();
        await expect(
          svc.refresh(ctx(), { refreshToken: rotation.tokens.refreshToken }, { surface: "cookie" }),
          `round ${round}: the orphan refresh token rotated on a revoked session`,
        ).rejects.toMatchObject({ httpStatus: 401 });
      }

      // Terminal state either way: nothing live is left in the victim's family.
      const liveTokens = await db.select().from(refreshTokens).where(and(
        eq(refreshTokens.familyId, victim.familyId),
        isNull(refreshTokens.revokedAt),
        isNull(refreshTokens.consumedAt),
      ));
      expect(liveTokens, `round ${round}: an unspent, unrevoked token remains in a dead family`).toEqual([]);

      // The caller's own session survived every round — the bulk verb never eats its wielder.
      const [callerRow] = await db.select().from(sessions).where(eq(sessions.id, caller.sessionId));
      expect(callerRow!.revokedAt).toBeNull();
    }
  }, 60_000);
});

/**
 * ═══ THE AGE CUTOFF, ON REAL POSTGRES ══════════════════════════════════════════════════════
 *
 * `olderThanDays` narrows the sweep by `last_seen_at`. The reason this is a pg twin and not a
 * PGlite one is the bound value: the predicate compares a `timestamptz` column against a
 * JavaScript `Date`, and the two drivers do not agree on serializing one — PGlite green says
 * nothing about what postgres-js sends. The arms are chosen so a broken comparison cannot pass:
 * a bound that arrived as the wrong instant would either revoke the fresh session (a red on the
 * survivor arm) or revoke nothing (a red on the count), never both correctly.
 *
 * Scoped to its own account per run and cleaned up afterwards — the lane database is shared with
 * this file's race test and with whatever else is in the run.
 */
describe.skipIf(!PG_UP)("revokeWebSessions with an age cutoff (postgres-js)", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    owned = makeOwnedDb(PG_TEST_URL);
    db = owned.db;
  });

  afterAll(async () => {
    await owned?.close();
  });

  /** A fresh account, and the plain web sessions it holds, each stamped with when it was seen. */
  const seedAccount = async (): Promise<{
    me: { accountId: string; userId: string };
    seed: (o: { daysAgo: number; deviceId?: string; lastTwofaAt?: Date }) => Promise<{ id: string; access: string }>;
  }> => {
    const now = new Date();
    const [acct] = await db.insert(accounts).values({ name: `cutoff-${randomUUID()}` }).returning();
    const [user] = await db.insert(users).values({
      accountId: acct!.id, email: `cutoff-${randomUUID()}@x.example`, displayName: "C",
      emailVerifiedAt: now,
    }).returning();
    const me = { accountId: acct!.id, userId: user!.id };
    const seed = async (o: { daysAgo: number; deviceId?: string; lastTwofaAt?: Date }) => {
      const access = generateToken();
      const [row] = await db.insert(sessions).values({
        ...me, deviceId: o.deviceId ?? null, familyId: randomUUID(),
        accessTokenHash: hashToken(access),
        accessExpiresAt: new Date(Date.now() + 60 * 60_000),
        refreshExpiresAt: new Date(Date.now() + 90 * 24 * 60 * 60_000),
        lastTwofaAt: o.lastTwofaAt ?? null,
        // PAST ONLY — a pg twin that stamped the future would poison every co-tenant reading
        // this table in the same run.
        lastSeenAt: new Date(Date.now() - o.daysAgo * 24 * 60 * 60_000),
      }).returning();
      return { id: row!.id, access };
    };
    return { me, seed };
  };

  const liveIds = async (userId: string): Promise<Set<string>> => {
    const rows = await db.select({ id: sessions.id }).from(sessions)
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
    return new Set(rows.map((r) => r.id));
  };

  it("revokes only what is past the cutoff — fresh sessions, the caller and a named device all survive", async () => {
    const svc = makeAuthService(makeTestAuthDeps());
    const { me, seed } = await seedAccount();
    const caller = await seed({ daysAgo: 0, lastTwofaAt: new Date() });
    const old30 = await seed({ daysAgo: 30 });
    const old8 = await seed({ daysAgo: 8 });
    const fresh6 = await seed({ daysAgo: 6 });
    const fresh0 = await seed({ daysAgo: 0 });
    // A named device 400 days idle: past every cutoff and still outside the predicate, because
    // `device_id IS NULL` is what the age parameter narrows, never what it replaces.
    const [dev] = await db.insert(devices).values({ ...me, kind: "web", label: "phone" }).returning();
    const paired = await seed({ daysAgo: 400, deviceId: dev!.id });

    const { revoked } = await svc.revokeWebSessions(
      ctx({ ...me, sessionId: caller.id }), { olderThanDays: 7 },
    );
    expect(revoked).toBe(2);

    const live = await liveIds(me.userId);
    expect(live.has(old30.id), "a 30-day-old session survived a 7-day cutoff").toBe(false);
    expect(live.has(old8.id), "an 8-day-old session survived a 7-day cutoff").toBe(false);
    expect(live.has(fresh6.id), "a 6-day-old session was revoked by a 7-day cutoff").toBe(true);
    expect(live.has(fresh0.id), "today's session was revoked by a 7-day cutoff").toBe(true);
    expect(live.has(caller.id), "the verb ate its wielder").toBe(true);
    expect(live.has(paired.id), "a NAMED device was swept by the age cutoff").toBe(true);

    await db.delete(sessions).where(eq(sessions.userId, me.userId));
  }, 60_000);

  /**
   * HOUSEKEEPING NEVER EVICTS THE LIVE SESSION (SESSIONS-023). A browser idle for a month that
   * renewed a moment ago is in use: the rotation stamps `last_seen_at`, and the cutoff reads that
   * column, so the smallest cutoff the pane accepts still leaves it. The un-rotated twin is the
   * control that the cutoff is armed at all.
   */
  it("a session that ROTATED within the access window survives the smallest cutoff", async () => {
    const svc = makeAuthService(makeTestAuthDeps());
    const { me, seed } = await seedAccount();
    const caller = await seed({ daysAgo: 0, lastTwofaAt: new Date() });
    const idle = await seed({ daysAgo: 30 });
    const renewed = await seed({ daysAgo: 30 });
    const [row] = await db.select({ familyId: sessions.familyId }).from(sessions).where(eq(sessions.id, renewed.id));
    const token = generateToken();
    await db.insert(refreshTokens).values({
      ...me, sessionId: renewed.id, familyId: row!.familyId, tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60_000),
    });
    await svc.refresh(ctx(), { refreshToken: token }, { concurrentGrace: true, surface: "cookie" });

    const { revoked } = await svc.revokeWebSessions(ctx({ ...me, sessionId: caller.id }), { olderThanDays: 1 });
    expect(revoked, "the cutoff swept something other than the idle twin").toBe(1);
    const live = await liveIds(me.userId);
    expect(live.has(renewed.id), "a session that renewed a moment ago was evicted as idle").toBe(true);
    expect(live.has(idle.id), "THE CONTROL — the un-rotated twin survived, so the cutoff never ran").toBe(false);

    await db.delete(refreshTokens).where(eq(refreshTokens.userId, me.userId));
    await db.delete(sessions).where(eq(sessions.userId, me.userId));
  }, 60_000);

  it("omitted takes the whole remainder — the same fixture, the unchanged meaning", async () => {
    const svc = makeAuthService(makeTestAuthDeps());
    const { me, seed } = await seedAccount();
    const caller = await seed({ daysAgo: 0, lastTwofaAt: new Date() });
    const old30 = await seed({ daysAgo: 30 });
    const fresh0 = await seed({ daysAgo: 0 });

    const { revoked } = await svc.revokeWebSessions(ctx({ ...me, sessionId: caller.id }));
    expect(revoked).toBe(2);
    const live = await liveIds(me.userId);
    expect(live.has(old30.id)).toBe(false);
    expect(live.has(fresh0.id), "the no-cutoff sweep left a fresh session behind").toBe(false);
    expect(live.has(caller.id)).toBe(true);

    await db.delete(sessions).where(eq(sessions.userId, me.userId));
  }, 60_000);

  /**
   * The bound is enforced by the VERB and not only by the route, so a caller reaching the
   * service directly — the desktop's stdio door is one — cannot pass a value the route would
   * have refused. Driven here rather than asserted, and the refusal revokes nothing.
   */
  it.each([
    ["zero", 0],
    ["past the ceiling", REVOKE_WEB_SESSIONS_MAX_AGE_DAYS + 1],
    ["fractional", 7.5],
  ])("refuses %s at the service seam, revoking nothing", async (_label, days) => {
    const svc = makeAuthService(makeTestAuthDeps());
    const { me, seed } = await seedAccount();
    const caller = await seed({ daysAgo: 0, lastTwofaAt: new Date() });
    const victim = await seed({ daysAgo: 30 });

    await expect(
      svc.revokeWebSessions(ctx({ ...me, sessionId: caller.id }), { olderThanDays: days }),
    ).rejects.toMatchObject({ httpStatus: 400 });

    const live = await liveIds(me.userId);
    expect(live.has(victim.id), "a refused cutoff revoked a session anyway").toBe(true);

    await db.delete(sessions).where(eq(sessions.userId, me.userId));
  }, 60_000);
});
