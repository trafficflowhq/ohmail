import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq, inArray } from "drizzle-orm";
import { accounts, devices, refreshTokens, sessions, users, type Tx } from "@trafficflow/db";
import { authEvents, pushSubscriptions, schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  AuthService, SessionLifecycle, generateToken, hashToken, makeTestAuthDeps,
  type AuthAuditEvent, type ServiceContext,
} from "@trafficflow/services";

/**
 * SIGNING OUT BY THE REFRESH TOKEN LEAVES NOTHING THAT CAN SIGN BACK IN, on real Postgres. The
 * web's sign-out presents the jar's refresh token, often a SPENT one whose live tail the jar
 * never received. Every arm of the rotation that could mint from a spent token is driven against
 * the revoked family — the grace, the live tail, the attempt-id replay, the lost-answer recovery —
 * each beside a twin that DOES mint without the sign-out, so the refusal is the sign-out's. Then
 * idempotence, a jar naming two accounts, an unknown token, the push prune, and the fail-closed
 * revoke on both tiers. Mutation: delete the revoke in `logoutByRefresh` and the arms mint.
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

// An hour AGO, so every stamp below is in the past: a shared table must not carry future rows.
const t0 = new Date(Date.now() - 60 * 60_000);
const at = (ms: number): Date => new Date(t0.getTime() + ms);
const ctx = (now: Date, over: Partial<ServiceContext> = {}): ServiceContext => ({
  db, accountId: "", userId: null, now: () => now, requestId: "logout-by-refresh-pg", ...over,
} as unknown as ServiceContext);
const COOKIE = { concurrentGrace: true, surface: "cookie" } as const;

interface Family {
  accountId: string; userId: string; sessionId: string; familyId: string; access: string; r1: string;
}

/** A session and its first refresh token in ONE family, as `establish` leaves them. */
async function seedFamily(o: { deviceId?: string; accountId?: string; userId?: string } = {}): Promise<Family> {
  let accountId = o.accountId;
  let userId = o.userId;
  if (!accountId || !userId) {
    const [acct] = await db.insert(accounts).values({ name: "Logout by refresh" }).returning();
    const [user] = await db.insert(users).values({
      accountId: acct!.id, email: `lbr-${randomUUID()}@lichtgrat.example`, displayName: "L", emailVerifiedAt: t0,
    }).returning();
    accountId = acct!.id;
    userId = user!.id;
  }
  const access = generateToken();
  const r1 = generateToken();
  const familyId = randomUUID();
  const [sess] = await db.insert(sessions).values({
    accountId, userId, deviceId: o.deviceId ?? null, familyId, accessTokenHash: hashToken(access),
    accessExpiresAt: at(15 * 60_000), refreshExpiresAt: at(90 * 86_400_000), lastSeenAt: t0, createdAt: t0,
  }).returning();
  await db.insert(refreshTokens).values({
    accountId, userId, sessionId: sess!.id, familyId, tokenHash: hashToken(r1),
    expiresAt: at(90 * 86_400_000), createdAt: t0,
  });
  return { accountId, userId, sessionId: sess!.id, familyId, access, r1 };
}

const rowsOf = (familyId: string) => db.select().from(refreshTokens).where(eq(refreshTokens.familyId, familyId));
const sessionsOf = (familyId: string) => db.select().from(sessions).where(eq(sessions.familyId, familyId));
const eventsOf = async (accountId: string) =>
  (await db.select({ event: authEvents.event }).from(authEvents).where(eq(authEvents.accountId, accountId)))
    .map((e) => e.event);

/** Revoked end to end: every token row and every session of the family carries `revoked_at`. */
async function expectRevoked(familyId: string, what: string): Promise<void> {
  const tokens = await rowsOf(familyId);
  expect(tokens.length, `${what}: the family has rows`).toBeGreaterThan(0);
  expect(tokens.every((r) => r.revokedAt !== null), `${what}: a live token row`).toBe(true);
  expect((await sessionsOf(familyId)).every((s) => s.revokedAt !== null), `${what}: a live session`).toBe(true);
}

async function expectLive(familyId: string, what: string): Promise<void> {
  expect((await rowsOf(familyId)).every((r) => r.revokedAt === null), `${what}: revoked`).toBe(true);
  expect((await sessionsOf(familyId)).every((s) => s.revokedAt === null), `${what}: revoked`).toBe(true);
}

const REFUSED = { code: "refresh_revoked", httpStatus: 401, message: "invalid refresh token" };

describe.skipIf(!PG_UP)("logout by refresh token on real Postgres", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 5 });
    db = brandDialect(drizzle(client, { schema }), "pg");
  }, 60_000);
  afterAll(async () => { await client?.end({ timeout: 5 }); });

  const svc = (): AuthService => new AuthService(makeTestAuthDeps());

  /** A lost renewal: r1 is rotated to r2 at time zero and the jar keeps r1. */
  async function lostRenewal(s: AuthService, f: Family, native = false): Promise<string> {
    const out = native
      ? await s.refresh(ctx(t0), { refreshToken: f.r1, attemptId: "attempt-1" }, { surface: "native" })
      : await s.refresh(ctx(t0), { refreshToken: f.r1 }, COOKIE);
    return out.tokens!.refreshToken;
  }

  it("THE GRACE: the spent token 5 s later is refused — and its twin without the sign-out mints", async () => {
    const s = svc();
    const twin = await seedFamily();
    await lostRenewal(s, twin);
    await expect(s.refresh(ctx(at(5_000)), { refreshToken: twin.r1 }, COOKIE), "CONTROL: the grace mints")
      .resolves.toMatchObject({ tokens: { tokenType: "Bearer" } });

    const f = await seedFamily();
    await lostRenewal(s, f);
    await expect(s.logout(ctx(at(1_000)), { refreshToken: f.r1 })).resolves.toEqual({ familyIds: [f.familyId] });
    await expect(s.refresh(ctx(at(5_000)), { refreshToken: f.r1 }, COOKIE)).rejects.toMatchObject(REFUSED);
    expect(await rowsOf(f.familyId), "the sign-out minted nothing").toHaveLength(2);
    await expectRevoked(f.familyId, "after the grace arm");
    expect(await eventsOf(f.accountId)).toEqual(["logout"]);
  });

  it("THE LIVE TAIL the jar never received is refused too", async () => {
    const s = svc();
    const f = await seedFamily();
    const r2 = await lostRenewal(s, f);
    await s.logout(ctx(at(1_000)), { refreshToken: f.r1 });
    await expect(s.refresh(ctx(at(5_000)), { refreshToken: r2 }, COOKIE)).rejects.toMatchObject(REFUSED);
    expect(await rowsOf(f.familyId)).toHaveLength(2);
  });

  it("THE ATTEMPT-ID REPLAY (bearer) is refused — and its twin without the sign-out re-answers", async () => {
    const s = svc();
    const twin = await seedFamily();
    await lostRenewal(s, twin, true);
    await expect(s.refresh(ctx(at(5_000)), { refreshToken: twin.r1, attemptId: "attempt-1" }, { surface: "native" }),
      "CONTROL: the replay re-answers").resolves.toMatchObject({ tokens: { tokenType: "Bearer" } });

    const f = await seedFamily();
    await lostRenewal(s, f, true);
    await s.logout(ctx(at(1_000)), { refreshToken: f.r1 });
    await expect(s.refresh(ctx(at(5_000)), { refreshToken: f.r1, attemptId: "attempt-1" }, { surface: "native" }))
      .rejects.toMatchObject(REFUSED);
    expect(await rowsOf(f.familyId)).toHaveLength(2);
    expect(await eventsOf(f.accountId)).toEqual(["logout"]);
  });

  it("THE LOST-ANSWER RECOVERY at +16 min is refused — and its twin without the sign-out recovers", async () => {
    const s = svc();
    const twin = await seedFamily();
    await lostRenewal(s, twin);
    await expect(s.refresh(ctx(at(16 * 60_000)), { refreshToken: twin.r1 }, COOKIE), "CONTROL: recovery re-admits")
      .resolves.toMatchObject({ tokens: { tokenType: "Bearer" } });
    expect(await eventsOf(twin.accountId)).toContain("refresh_recovered");

    const f = await seedFamily();
    await lostRenewal(s, f);
    await s.logout(ctx(at(1_000)), { refreshToken: f.r1 });
    await expect(s.refresh(ctx(at(16 * 60_000)), { refreshToken: f.r1 }, COOKIE)).rejects.toMatchObject(REFUSED);
    expect(await rowsOf(f.familyId)).toHaveLength(2);
    // A late re-presentation of a revoked token is a plain refusal: no sweep, no recovery row.
    expect(await eventsOf(f.accountId)).toEqual(["logout"]);
  });

  it("a second sign-out with the same token withdraws nothing and does not throw", async () => {
    const s = svc();
    const f = await seedFamily();
    await s.logout(ctx(at(1_000)), { refreshToken: f.r1 });
    const stamps = async () => [
      ...(await rowsOf(f.familyId)).map((r) => r.revokedAt?.getTime()),
      ...(await sessionsOf(f.familyId)).map((r) => r.revokedAt?.getTime()),
    ];
    const first = await stamps();
    await expect(s.logout(ctx(at(9_000)), { refreshToken: f.r1 })).resolves.toEqual({ familyIds: [f.familyId] });
    expect(await stamps(), "a revoked row was stamped again").toEqual(first);
  });

  it("a jar naming A's live session and B's refresh token ends BOTH — no conflict refusal", async () => {
    const s = svc();
    const a = await seedFamily();
    const b = await seedFamily();
    const out = await s.logout(ctx(at(1_000), {
      accountId: a.accountId, userId: a.userId, sessionId: a.sessionId,
    }), { refreshToken: b.r1 });
    expect([...out.familyIds].sort()).toEqual([a.familyId, b.familyId].sort());
    await expectRevoked(a.familyId, "A");
    await expectRevoked(b.familyId, "B");
    // Each account's own trail records its own sign-out, and nothing else.
    expect(await eventsOf(a.accountId)).toEqual(["logout"]);
    expect(await eventsOf(b.accountId)).toEqual(["logout"]);
  });

  it("an unknown token revokes nothing — and a real one beside it does", async () => {
    const s = svc();
    const bystander = await seedFamily();
    await expect(s.logout(ctx(at(1_000)), { refreshToken: generateToken() }))
      .rejects.toMatchObject({ code: "unauthorized", httpStatus: 401, message: "nothing to sign out" });
    await expectLive(bystander.familyId, "a bystander after an unknown token");

    // With a live session resolved, the unknown token names nothing and the session is what ends.
    const own = await seedFamily();
    const out = await s.logout(ctx(at(1_000), {
      accountId: own.accountId, userId: own.userId, sessionId: own.sessionId,
    }), { refreshToken: generateToken() });
    expect(out.familyIds).toEqual([own.familyId]);
    await expectRevoked(own.familyId, "the resolved session");

    // POSITIVE CONTROL: the bystander's own token does end it.
    await s.logout(ctx(at(2_000)), { refreshToken: bystander.r1 });
    await expectRevoked(bystander.familyId, "the bystander by its own token");
  });

  it("the hosted override prunes the wake registration of the family's DEVICE, and only that one", async () => {
    const s = svc();
    const seed = await seedFamily();
    const [phone] = await db.insert(devices)
      .values({ accountId: seed.accountId, userId: seed.userId, kind: "mobile-android" }).returning();
    const [other] = await db.insert(devices)
      .values({ accountId: seed.accountId, userId: seed.userId, kind: "mobile-ios" }).returning();
    const f = await seedFamily({ deviceId: phone!.id, accountId: seed.accountId, userId: seed.userId });
    const wake = async (deviceId: string | null) => (await db.insert(pushSubscriptions).values({
      accountId: seed.accountId, transport: "unifiedpush", endpoint: `https://ntfy.test/${randomUUID()}`, deviceId,
    }).returning({ id: pushSubscriptions.id }))[0]!.id;
    const mine = await wake(phone!.id);
    const theirs = await wake(other!.id);
    const deviceless = await wake(null);

    await s.logout(ctx(at(1_000)), { refreshToken: f.r1 });
    const left = (await db.select({ id: pushSubscriptions.id }).from(pushSubscriptions)
      .where(inArray(pushSubscriptions.id, [mine, theirs, deviceless]))).map((r) => r.id).sort();
    expect(left, "the signed-out device's row is gone; the other device and the browser row stay")
      .toEqual([theirs, deviceless].sort());
  });

  it("FAIL-CLOSED, hosted: an audit that cannot be written does not keep the family alive", async () => {
    class AuditDown extends AuthService {
      protected override async audit(
        tx: Tx, user: typeof users.$inferSelect | null, event: AuthAuditEvent["event"],
        method: AuthAuditEvent["method"] | undefined, c: ServiceContext, detail?: string,
      ): Promise<void> {
        if (event === "logout") throw new Error("audit down");
        return super.audit(tx, user, event, method, c, detail);
      }
    }
    const s = new AuditDown(makeTestAuthDeps());
    const f = await seedFamily();
    await expect(s.logout(ctx(at(1_000)), { refreshToken: f.r1 })).resolves.toEqual({ familyIds: [f.familyId] });
    await expectRevoked(f.familyId, "with the audit down");
    expect(await eventsOf(f.accountId), "the record rolled back with its transaction").toEqual([]);
  });

  it("THE PRUNE FAILS, the sign-out stands: revoked and audited before it, the failure logged once", async () => {
    class PruneDown extends AuthService {
      protected override async pruneWakeRegistrations(): Promise<void> {
        throw new Error("push table unreachable");
      }
    }
    const s = new PruneDown(makeTestAuthDeps());
    const seed = await seedFamily();
    const [phone] = await db.insert(devices)
      .values({ accountId: seed.accountId, userId: seed.userId, kind: "mobile-android" }).returning();
    const f = await seedFamily({ deviceId: phone!.id, accountId: seed.accountId, userId: seed.userId });
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await expect(s.logout(ctx(at(1_000)), { refreshToken: f.r1 })).resolves.toEqual({ familyIds: [f.familyId] });
      expect(logged.mock.calls.filter((c) => String(c[0]).includes("\"event\":\"auth_logout_wake_prune_failed\"")))
        .toHaveLength(1);
    } finally {
      logged.mockRestore();
    }
    await expectRevoked(f.familyId, "with the prune down");
    expect(await eventsOf(f.accountId), "the audit committed with the revoke").toContain("logout");
  });

  it("FAIL-CLOSED, the lifecycle tier alone (no outer transaction): the same", async () => {
    class AuditDown extends SessionLifecycle {
      protected override async audit(): Promise<void> {
        throw new Error("audit down");
      }
    }
    const s = new AuditDown({ config: makeTestAuthDeps().config });
    const f = await seedFamily();
    await expect(s.logout(ctx(at(1_000)), { refreshToken: f.r1 })).resolves.toEqual({ familyIds: [f.familyId] });
    await expectRevoked(f.familyId, "on the lifecycle tier with the audit down");
  });

  it("the user refusal stays on the arms that need a user", async () => {
    const s = svc();
    await expect(s.logout(ctx(t0), {})).rejects.toMatchObject({ httpStatus: 401, message: "no active session" });
    await expect(s.logout(ctx(t0), { allDevices: true })).rejects.toMatchObject({ httpStatus: 401 });
  });
});
