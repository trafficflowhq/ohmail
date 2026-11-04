/* @postpush: alone — the sign-in retention pass deletes across every account on the database: beside
 * co-tenants it can take their dated rows and theirs can take this file's. On a lane database made
 * from empty the pass sees only what this file wrote, and every account it made is erased again. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq } from "drizzle-orm";
import { generateSync } from "otplib";
import { refreshTokens, sessions, type Tx } from "@trafficflow/db";
import { pruneSignInRecords, schema, SIGN_IN_RECORD_RETENTION_MS } from "@trafficflow/db/cloud";
import { ERASED_REFRESH_KEEP_DAYS } from "../../db/src/erased-bearers.js";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { AuthService, deleteAccount, hashToken, makeTestAuthDeps, type ServiceContext } from "@trafficflow/services";

/**
 * THE HOURLY PASS AND THE ERASURE AGREE ABOUT AN APP THAT WENT QUIET. An app never signed out keeps
 * its refresh token past its window, and an account erasure copies that token's hash for
 * ERASED_REFRESH_KEEP_DAYS past its expiry, so the app is told its account is gone when it comes
 * back. The pass may not delete the session while that copy would still be made: end to end
 * through `deleteAccount` and `bearerOfErasedAccount` (the 410's lookup), at the edge and inside
 * it, beside a signed-out session that goes on the pass's own 30 days. Run in UTC at a 2010 clock,
 * later than the 2001 one the db package's lock test passes at, so that pass never reaches these rows.
 */
const PG_UP = await realPgAvailable();
type Sql = ReturnType<typeof postgres>;
type Db = ReturnType<typeof drizzle<typeof schema>>;
const T = new Date("2010-06-01T00:00:00.000Z");
const DAY = 86_400_000;

let client: Sql;
let db: Db;
let ipCell = 0;

interface Person { userId: string; accountId: string; refresh: string; sessionId: string }
async function person(svc: AuthService): Promise<Person> {
  let t = new Date(T.getTime() - 450 * DAY);
  const ip = `10.42.${(ipCell += 1)}.1`;
  const at = (over: Partial<ServiceContext> = {}): ServiceContext =>
    ({ db, accountId: "", userId: null, now: () => t, requestId: `sir-${randomUUID()}`, ip, ...over });
  const totp = (secret: string): string => generateSync({ secret, epoch: Math.floor(t.getTime() / 1000) });
  const email = `sir-${randomUUID()}@trafficflow.test`;
  const reg = await svc.register(at(), { email, password: "account-signin-password", displayName: "S", inviteCode: "INVITE-OK" });
  if (reg.status !== "enrollment") throw new Error(`expected enrolment, got ${reg.status}`);
  const [enrolling] = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, reg.user.userId)).limit(1);
  const enrollCtx = at({ userId: reg.user.userId, accountId: reg.user.accountId, sessionId: enrolling!.id });
  const { secret } = await svc.totpEnroll(enrollCtx);
  await svc.totpActivate(enrollCtx, { code: totp(secret) });
  t = new Date(t.getTime() + 60_000);
  const ch = await svc.login(at(), { email, password: "account-signin-password" });
  if (ch.status !== "twofa_required") throw new Error(`expected 2FA, got ${ch.status}`);
  const est = await svc.totpVerify(at(), { loginToken: ch.loginToken, code: totp(secret), kind: "desktop-linux" });
  const refresh = est.tokens!.refreshToken;
  const [row] = await db.select({ s: refreshTokens.sessionId }).from(refreshTokens).where(eq(refreshTokens.tokenHash, hashToken(refresh)));
  const p = { userId: reg.user.userId, accountId: reg.user.accountId, refresh, sessionId: row!.s };
  made.push(p);
  return p;
}

/** The session's window, and its tokens' expiry, closed at `T - keep + offset` — the erasure's arithmetic. */
async function lapse(p: Person, offset: string): Promise<void> {
  const at = T.toISOString();
  await client`update sessions set refresh_expires_at = ${at}::timestamptz - interval '1 day' * ${ERASED_REFRESH_KEEP_DAYS}::int + ${offset}::interval,
    access_expires_at = ${at}::timestamptz - interval '1 day' * ${ERASED_REFRESH_KEEP_DAYS}::int + ${offset}::interval where id = ${p.sessionId}`;
  await client`update refresh_tokens set expires_at = ${at}::timestamptz - interval '1 day' * ${ERASED_REFRESH_KEEP_DAYS}::int + ${offset}::interval
    where session_id = ${p.sessionId}`;
}

const pass = () => pruneSignInRecords(db as unknown as Tx, T, { retentionMs: SIGN_IN_RECORD_RETENTION_MS });
const erased = new Set<string>();
const erase = async (p: Person): Promise<void> => {
  await deleteAccount({ db: db as never, accountId: p.accountId, userId: p.userId, now: () => T, requestId: `erase-${randomUUID()}` });
  erased.add(p.accountId);
};
const made: Person[] = [];
const present = async (p: Person): Promise<boolean> =>
  (await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, p.sessionId))).length === 1;

describe.skipIf(!PG_UP)("the sign-in retention pass leaves the erasure what it names (real Postgres)", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {}, connection: { TimeZone: "UTC" } });
    db = brandDialect(drizzle(client, { schema }), "pg");
  }, 120_000);
  afterAll(async () => {
    for (const p of made) if (!erased.has(p.accountId)) await erase(p);
    await client?.end({ timeout: 5 });
  });

  it("an app silent a month past its window, the hourly pass, then the account deleted: the app is told", async () => {
    const svc = new AuthService(makeTestAuthDeps());
    const p = await person(svc);
    await lapse(p, `${ERASED_REFRESH_KEEP_DAYS - 31} days`);
    await pass();
    expect(await present(p), "the pass kept the session the erasure still names").toBe(true);
    await erase(p);
    expect(await svc.bearerOfErasedAccount(db as never, p.refresh, T)).toBe(p.accountId);
  }, 120_000);

  it("at the keep's edge the two agree: past it the pass deletes and an erasure would name nothing", async () => {
    const svc = new AuthService(makeTestAuthDeps());
    // The twin first, with no pass at all: one second past the keep, the erasure copies nothing.
    const twin = await person(svc);
    await lapse(twin, "-1 second");
    await erase(twin);
    expect(await svc.bearerOfErasedAccount(db as never, twin.refresh, T)).toBeNull();
    const inside = await person(svc);
    await lapse(inside, "1 minute");
    const past = await person(svc);
    await lapse(past, "-1 second");
    await pass();
    expect(await present(inside), "a minute inside the keep").toBe(true);
    expect(await present(past), "a second past the keep").toBe(false);
    await erase(inside);
    expect(await svc.bearerOfErasedAccount(db as never, inside.refresh, T)).toBe(inside.accountId);
  }, 180_000);

  it("a signed-out session goes 30 days after its sign-out, and the erasure would have named none of it", async () => {
    const svc = new AuthService(makeTestAuthDeps());
    const signOut = async (p: Person, daysAgo: number): Promise<void> => {
      const at = new Date(T.getTime() - daysAgo * DAY).toISOString();
      await client`update sessions set revoked_at = ${at}::timestamptz where id = ${p.sessionId}`;
      await client`update refresh_tokens set revoked_at = ${at}::timestamptz where session_id = ${p.sessionId}`;
    };
    const twin = await person(svc);
    await signOut(twin, 31);
    await erase(twin);
    expect(await svc.bearerOfErasedAccount(db as never, twin.refresh, T)).toBeNull();
    const gone = await person(svc);
    await signOut(gone, 31);
    const kept = await person(svc);
    await signOut(kept, 29);
    await pass();
    expect(await present(gone), "signed out 31 days ago").toBe(false);
    expect(await present(kept), "signed out 29 days ago").toBe(true);
  }, 180_000);
});
