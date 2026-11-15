import { accountOfUser } from "@trafficflow/db";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq, inArray } from "drizzle-orm";
import { generateSync } from "otplib";
import { devices, refreshTokens, sessions, users, type Tx } from "@trafficflow/db";
import { authEvents, credentials, schema, pushSubscriptions, webauthnCredentials } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  AuthService, generateToken, hashToken, makeAuthService, makeTestAuthDeps, pushService, type ServiceContext,
} from "@trafficflow/services";
import { seedFullAccount, type SeededAccount } from "./helpers/erasure-fixture.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  SIGNING OUT TAKES THE WAKE REGISTRATION WITH IT — the server half of "forget this server"
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── THE DEFECT ────────────────────────────────────────────────────────────────────────────
 *
 * `push_subscriptions` rows are stamped with the registering session's `device_id`, and
 * `push-service.ts` says in its own words that the stamp is "what lets `DELETE /devices/:id`
 * take the wake registration down with the credential". Only `revokeDevice` ever used it, and
 * `revokeDevice` is reachable only from a server's Devices pane. `logout` revoked the session
 * family and nothing else.
 *
 * So a phone that pressed "Forget this server" — which logs out — kept a live row, and the
 * worker kept POSTing "something changed" to a device that could no longer open the account.
 * Nothing unregisters the distributor either, so the endpoint keeps answering 2xx and the
 * worker's prune-on-404/410 never fires: the row and the outbound traffic are permanent. Not a
 * breach (the payload is content-free), but a continuing mail-ARRIVAL-TIMING channel to a
 * device after an explicit take-back.
 *
 * ── WHY THIS IS A `pg` TEST ───────────────────────────────────────────────────────────────
 *
 * The assertion is an ABSENCE OF ROWS after a transaction, on the driver production runs. This
 * repository's own rule: PGlite green means nothing for transactional code.
 *
 * ── THE MUTATION THAT MAKES IT EVIDENCE ───────────────────────────────────────────────────
 *
 * Delete the `logout` override in `auth-service.ts` and the first two cases go red with the
 * row still present — which is the defect verbatim. The isolation case goes red if the prune
 * widens its predicate past the one device. A BROWSER's row carries no device; it names the session
 * family that registered it (cloud 0056), and every revoke door below takes the rows of the families
 * it ends, in their own account, and nothing else.
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

let ipCell = 0;
const ctxFor = (accountId: string, userId: string | null, sessionId: string | null): ServiceContext => ({
  db, accountId, userId, sessionId: sessionId ?? undefined,
  now: () => new Date(), requestId: "logout-push-pg", ip: `10.56.${(ipCell += 1) % 250}.7`,
} as unknown as ServiceContext);

/** One wake registration, stamped with the device the session belongs to. */
async function registerWakeRow(accountId: string, deviceId: string | null): Promise<string> {
  const [row] = await db.insert(pushSubscriptions).values({
    accountId, transport: "unifiedpush", endpoint: `https://ntfy.test/${randomUUID()}`, deviceId,
  }).returning({ id: pushSubscriptions.id });
  return row!.id;
}

/**
 * A BROWSER: a session the way a browser sign-in leaves one (no device), and the row it registers
 * through the real service. `seedFullAccount` hands its session a device id, which is right for the
 * phone and desktop cases in this file and wrong for every browser one: `auth/session-lifecycle.ts`
 * auto-mints a device row for the four desktop kinds only.
 */
async function browser(
  seeded: { accountId: string; userId: string }, o: { twofaAt?: Date; access?: string; refresh?: string } = {},
): Promise<{ sessionId: string; familyId: string; row: string }> {
  const familyId = randomUUID();
  const [s] = await db.insert(sessions).values({
    accountId: seeded.accountId, userId: seeded.userId, familyId, lastTwofaAt: o.twofaAt ?? null,
    accessTokenHash: o.access ? hashToken(o.access) : null,
    accessExpiresAt: new Date(Date.now() + 3_600_000),
    refreshExpiresAt: new Date(Date.now() + 3_600_000),
  }).returning({ id: sessions.id });
  if (o.refresh) {
    await db.insert(refreshTokens).values({
      accountId: seeded.accountId, userId: seeded.userId, sessionId: s!.id, familyId,
      tokenHash: hashToken(o.refresh), expiresAt: new Date(Date.now() + 3_600_000),
    });
  }
  const { id } = await pushService.subscribe(ctxFor(seeded.accountId, seeded.userId, s!.id), {
    transport: "webpush", endpoint: `https://push.test/${randomUUID()}`, p256dh: "p", auth: "a",
  });
  return { sessionId: s!.id, familyId, row: id };
}

const rowsFor = async (accountId: string) =>
  db.select({ id: pushSubscriptions.id, deviceId: pushSubscriptions.deviceId })
    .from(pushSubscriptions).where(eq(pushSubscriptions.accountId, accountId));

/** Which of these rows are still there, sorted. */
const live = async (ids: readonly string[]): Promise<string[]> =>
  (await db.select({ id: pushSubscriptions.id }).from(pushSubscriptions)
    .where(inArray(pushSubscriptions.id, [...ids]))).map((r) => r.id).sort();

/** Poll, bounded, until a backend named `app` waits on a lock: a reading, not a sleep. */
async function waitsOnALock(app: string, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const [row] = await client`select count(*)::int as n from pg_stat_activity
      where datname = current_database() and application_name = ${app} and wait_event_type = 'Lock'`;
    if ((row as { n: number }).n > 0) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

const PASSWORD = "long-login-password";

describe.skipIf(!PG_UP)("logout takes this device's wake registration down", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 5 });
    db = brandDialect(drizzle(client, { schema }), "pg");
  }, 60_000);
  afterAll(async () => { await client?.end({ timeout: 5 }); });

  it("a phone's own sign-out leaves ZERO rows for its device", async () => {
    const seeded = await seedFullAccount(db);
    // The fixture's own row is deviceless; this is the phone's, stamped as `push-service.ts`
    // stamps it. Both are in the account, so a prune that deleted everything would show here.
    const phoneRow = await registerWakeRow(seeded.accountId, seeded.deviceId);

    const svc = makeAuthService(makeTestAuthDeps());
    await svc.logout(ctxFor(seeded.accountId, seeded.userId, seeded.sessionId), {});

    const after = await rowsFor(seeded.accountId);
    expect(after.map((r) => r.id)).not.toContain(phoneRow);
    expect(after.filter((r) => r.deviceId === seeded.deviceId)).toEqual([]);
    // The session really was revoked too — the take-back is the whole act, not just the prune.
    const s = (await db.select({ revokedAt: sessions.revokedAt }).from(sessions)
      .where(eq(sessions.id, seeded.sessionId)))[0];
    expect(s?.revokedAt).toBeInstanceOf(Date);
  });

  it("ONLY that device: a second phone on the same account keeps its registration", async () => {
    const seeded = await seedFullAccount(db);
    const [other] = await db.insert(devices)
      .values({ accountId: seeded.accountId, userId: seeded.userId, kind: "mobile-android" })
      .returning({ id: devices.id });
    const otherDeviceId = other!.id;
    const mine = await registerWakeRow(seeded.accountId, seeded.deviceId);
    const theirs = await registerWakeRow(seeded.accountId, otherDeviceId);

    const svc = makeAuthService(makeTestAuthDeps());
    await svc.logout(ctxFor(seeded.accountId, seeded.userId, seeded.sessionId), {});

    const ids = (await rowsFor(seeded.accountId)).map((r) => r.id);
    expect(ids).not.toContain(mine);
    // The load-bearing half. Signing one phone out must not silently end another's wakes —
    // which is exactly what a prune keyed on the ACCOUNT rather than the device would do.
    expect(ids).toContain(theirs);
  });

  it("`allDevices` takes every row of THIS USER's devices — and not another user's", async () => {
    // It is device revocation in effect, so it takes every device row this user has. What it
    // may NOT take is somebody else's: an account can hold several users, `super.logout`'s mass
    // arm revokes sessions for `ctx.userId` alone, and pruning by ACCOUNT reached past the thing
    // being taken back — silently ending a second user's wakes while they stayed signed in.
    const seeded = await seedFullAccount(db);
    const [second] = await db.insert(users).values({
      accountId: seeded.accountId,
      email: `second-${randomUUID()}@lichtgrat.example`,
      displayName: "Second",
    }).returning({ id: users.id });
    const [mineB] = await db.insert(devices)
      .values({ accountId: seeded.accountId, userId: seeded.userId, kind: "mobile-ios" })
      .returning({ id: devices.id });
    const [theirs] = await db.insert(devices)
      .values({ accountId: seeded.accountId, userId: second!.id, kind: "mobile-android" })
      .returning({ id: devices.id });

    const mine1 = await registerWakeRow(seeded.accountId, seeded.deviceId);
    const mine2 = await registerWakeRow(seeded.accountId, mineB!.id);
    const notMine = await registerWakeRow(seeded.accountId, theirs!.id);
    const deviceless = await registerWakeRow(seeded.accountId, null);
    const myBrowser = await browser(seeded);
    const theirBrowser = await browser({ accountId: seeded.accountId, userId: second!.id });

    // `allDevices` needs the step-up the base class gates it with; the fixture's session
    // carries no `last_twofa_at`, so stamp it — the gate itself is `logout`'s own test, and
    // what is under test here is what a PERMITTED mass logout removes.
    await db.update(sessions).set({ lastTwofaAt: new Date() }).where(eq(sessions.id, seeded.sessionId));
    const svc = makeAuthService(makeTestAuthDeps());
    await svc.logout(ctxFor(seeded.accountId, seeded.userId, seeded.sessionId), { allDevices: true });

    const ids = (await rowsFor(seeded.accountId)).map((r) => r.id);
    expect(ids).not.toContain(mine1);
    expect(ids).not.toContain(mine2);
    // The load-bearing half.
    expect(ids, "another user's wakes must not end because this one signed out").toContain(notMine);
    // This user's browser goes by its family; the other user's browser and a row that names no
    // session stay.
    expect(ids, "this user's browser kept its registration").not.toContain(myBrowser.row);
    expect(ids, "another user's browser lost its registration").toContain(theirBrowser.row);
    expect(ids).toContain(deviceless);
  });

  /**
   * A BROWSER REGISTRATION NAMES NO DEVICE, so the device-scoped prunes never reached it: a browser
   * signed out from anywhere but itself kept receiving wakes. It names the session family that
   * registered it, stamped from that session through the REAL service (a row inserted with the
   * stamp already on it would say nothing about who put it there), and its sign-out takes it.
   */
  it("a BROWSER registration carries its session's family, and that session's sign-out takes it", async () => {
    const seeded = await seedFullAccount(db);
    const w1 = await browser(seeded);
    const [stored] = await db.select({ deviceId: pushSubscriptions.deviceId, familyId: pushSubscriptions.sessionFamilyId })
      .from(pushSubscriptions).where(eq(pushSubscriptions.id, w1.row));
    expect(stored).toEqual({ deviceId: null, familyId: w1.familyId });

    await makeAuthService(makeTestAuthDeps()).logout(ctxFor(seeded.accountId, seeded.userId, w1.sessionId), {});
    expect(await live([w1.row]), "the signed-out browser kept its registration").toEqual([]);
  });

  it("…and the CLIENT's own delete still closes it first, account-scoped, by the id it kept", async () => {
    /*
     * The browser's sign-out issues `DELETE /push/subscriptions/:id` BEFORE `auth.logout()` revokes
     * the session that authorizes it; the order is asserted on the client in
     * `apps/webapp/test/sign-out-clears-durable-stores.test.ts`, and what is asserted here is that the
     * route it calls removes the row. Not vacuous: a second account's session tries first, and
     * account scoping is what stops this being a delete-by-id anyone could aim anywhere.
     */
    const seeded = await seedFullAccount(db);
    const other = await seedFullAccount(db);
    const { sessionId: web, row: id } = await browser(seeded);
    const push = pushService;

    // The account that does NOT own it cannot delete it — 404, and the row stands.
    await expect(
      push.unsubscribe(ctxFor(other.accountId, other.userId, other.sessionId), id),
    ).rejects.toThrow();
    expect((await rowsFor(seeded.accountId)).map((r) => r.id)).toContain(id);

    // The browser's own session can.
    await push.unsubscribe(ctxFor(seeded.accountId, seeded.userId, web), id);
    expect(
      (await rowsFor(seeded.accountId)).map((r) => r.id),
      "the client's delete left the row live — nothing else can reach it",
    ).not.toContain(id);
  });

  it("the revoke and the prune are ONE transaction, so a failed prune cannot strand the row", async () => {
    // `super.logout` revokes the session family, and that family is the only credential that
    // could ever ask for this again: the middleware refuses a revoked session before this method
    // is reached. So two autocommitted statements meant a crash between them left the push row
    // live AND the caller unable to retry, while the endpoint kept answering 2xx so the worker's
    // prune-on-404/410 never fired either. Proven by making the transaction body fail after the
    // base logout has run inside it: the revoke must roll back with it.
    const seeded = await seedFullAccount(db);
    const phoneRow = await registerWakeRow(seeded.accountId, seeded.deviceId);

    const svc = makeAuthService(makeTestAuthDeps());
    const ctx = ctxFor(seeded.accountId, seeded.userId, seeded.sessionId);
    const exploding = {
      ...ctx,
      db: new Proxy(db as object, {
        get(target, prop, recv) {
          if (prop !== "transaction") return Reflect.get(target, prop, recv);
          const real = (target as { transaction: (f: (tx: unknown) => Promise<unknown>) => Promise<unknown> }).transaction;
          return (fn: (tx: unknown) => Promise<unknown>) =>
            real.call(target, async (tx: unknown) => {
              await fn(tx);
              throw new Error("the connection died between the revoke and the prune");
            });
        },
      }),
    } as unknown as ServiceContext;

    await expect(svc.logout(exploding, {})).rejects.toThrow(/died between/);

    // NOTHING happened: the row is still there AND the session is still live, so the client's
    // own retry has a credential to retry with. That pairing is the property.
    expect((await rowsFor(seeded.accountId)).map((r) => r.id)).toContain(phoneRow);
    const still = (await db.select({ revokedAt: sessions.revokedAt }).from(sessions)
      .where(eq(sessions.id, seeded.sessionId)))[0];
    expect(still?.revokedAt ?? null, "the revoke must roll back with the prune").toBeNull();

    // And the retry lands both halves.
    await svc.logout(ctx, {});
    expect((await rowsFor(seeded.accountId)).map((r) => r.id)).not.toContain(phoneRow);
  });

  it("a browser's sign-out takes ONLY its own row: another browser's, the phone's and an unbound one stay", async () => {
    // A PHONE ROW and a SECOND BROWSER have to exist for the isolation half to mean anything: a
    // prune that took every deviceless row of the account would end another browser's wakes. The
    // unbound row names no session at all (a row the migration's backfill would have deleted).
    const seeded = await seedFullAccount(db);
    const w1 = await browser(seeded);
    const w2 = await browser(seeded);
    const phoneRow = await registerWakeRow(seeded.accountId, seeded.deviceId);
    const unbound = await registerWakeRow(seeded.accountId, null);

    await makeAuthService(makeTestAuthDeps()).logout(ctxFor(seeded.accountId, seeded.userId, w1.sessionId), {});
    expect(await live([w1.row, w2.row, phoneRow, unbound])).toEqual([w2.row, phoneRow, unbound].sort());
  });

  /** Every door that ends another session of the caller's, from the caller's fresh session. */
  const DOORS: Array<[string, (s: AuthService, c: ServiceContext, w1: string, seeded: SeededAccount) => Promise<unknown>]> = [
    ["Devices revoke, by the browser session's own id", (s, c, w1) => s.revokeDevice(c, w1)],
    ["sign out all other web sessions", (s, c) => s.revokeWebSessions(c)],
    ["a password change", async (s, c, _w1, seeded) => {
      await db.update(credentials).set({ passwordHash: await makeTestAuthDeps().passwordHasher.hash(PASSWORD) })
        .where(eq(credentials.userId, seeded.userId));
      return s.changePassword(c, { currentPassword: PASSWORD, newPassword: `${PASSWORD}-next` });
    }],
    ["an authenticator removal", async (s, c, _w1, seeded) => {
      await db.insert(webauthnCredentials).values({ userId: seeded.userId, accountId: accountOfUser(seeded.userId), credentialId: `c0056-${randomUUID()}`, publicKey: "AAAA" });
      return s.totpRemove(c);
    }],
  ];
  for (const [door, run] of DOORS) {
    it(`${door} takes the revoked browser's row and keeps the caller's`, async () => {
      const seeded = await seedFullAccount(db);
      const caller = await browser(seeded, { twofaAt: new Date() });
      const w1 = await browser(seeded);
      await run(makeAuthService(makeTestAuthDeps()), ctxFor(seeded.accountId, seeded.userId, caller.sessionId), w1.sessionId, seeded);
      expect(await live([caller.row, w1.row])).toEqual([caller.row]);
    });
  }

  it("the reuse sweep takes the swept browser's row; with the prune down its answer and record stand", async () => {
    class PruneDown extends AuthService {
      protected override async pruneWakeRegistrations(): Promise<void> { throw new Error("push table unreachable"); }
    }
    for (const svc of [makeAuthService(makeTestAuthDeps()), new PruneDown(makeTestAuthDeps())]) {
      const seeded = await seedFullAccount(db);
      const caller = await browser(seeded);
      const r1 = generateToken();
      const w1 = await browser(seeded, { refresh: r1 });
      const anon = ctxFor("", null, null);
      await svc.refresh(anon, { refreshToken: r1 }, { surface: "native" });
      await expect(svc.refresh(anon, { refreshToken: r1 }, { surface: "native" }))
        .rejects.toMatchObject({ code: "refresh_revoked", httpStatus: 401, details: { cause: "reuse" } });
      const events = await db.select({ event: authEvents.event }).from(authEvents).where(eq(authEvents.accountId, seeded.accountId));
      expect(events.map((e) => e.event)).toContain("refresh_reuse_revoked");
      const down = svc instanceof PruneDown;
      expect(await live([caller.row, w1.row]), down ? "the sweep failed with its prune" : "the swept browser kept its row")
        .toEqual(down ? [caller.row, w1.row].sort() : [caller.row]);
    }
  });

  it("a sign-in by ANOTHER account over a browser's jar takes that browser's row; the account's other browser keeps its own", async () => {
    const svc = makeAuthService(makeTestAuthDeps());
    const seeded = await seedFullAccount(db);
    const access = generateToken();
    const w1 = await browser(seeded, { access });
    const other = await browser(seeded);
    // Another person signs up and finishes an authenticator in the jar that still holds that browser's access cookie.
    const reg = await svc.register(ctxFor("", null, null), {
      email: `b-${randomUUID()}@lichtgrat.example`, password: PASSWORD, displayName: "B", inviteCode: "INVITE-OK",
    });
    if (reg.status !== "enrollment") throw new Error(`expected an enrolment session, got ${reg.status}`);
    const [enrol] = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, reg.user.userId));
    const b = ctxFor(reg.user.accountId, reg.user.userId, enrol!.id);
    const { secret } = await svc.totpEnroll(b);
    await svc.totpActivate({ ...b, supersedes: access }, { code: generateSync({ secret, epoch: Math.floor(Date.now() / 1000) }) });
    expect(await live([w1.row, other.row])).toEqual([other.row]);
  });

  it("a row of ANOTHER account carrying the revoked family's id survives the revoke", async () => {
    const a = await seedFullAccount(db);
    const b = await seedFullAccount(db);
    const w1 = await browser(a);
    const [foreign] = await db.insert(pushSubscriptions).values({
      accountId: b.accountId, transport: "webpush", endpoint: `https://push.test/${randomUUID()}`, sessionFamilyId: w1.familyId,
    }).returning({ id: pushSubscriptions.id });
    await makeAuthService(makeTestAuthDeps()).logout(ctxFor(a.accountId, a.userId, w1.sessionId), {});
    expect(await live([w1.row, foreign!.id])).toEqual([foreign!.id]);
  });

  it("a registration from a revoked session is refused 401 and writes no row", async () => {
    const seeded = await seedFullAccount(db);
    const w1 = await browser(seeded);
    await makeAuthService(makeTestAuthDeps()).logout(ctxFor(seeded.accountId, seeded.userId, w1.sessionId), {});
    const endpoint = `https://push.test/${randomUUID()}`;
    await expect(pushService.subscribe(ctxFor(seeded.accountId, seeded.userId, w1.sessionId), {
      transport: "webpush", endpoint, p256dh: "p", auth: "a",
    })).rejects.toMatchObject({ httpStatus: 401 });
    expect(await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint))).toEqual([]);
  });

  /**
   * Both shapes of revoke: Devices revoke claims the session row FOR UPDATE first, a sign-out's family
   * revoke only UPDATEs it, which a KEY SHARE read would not wait for.
   */
  const RACED: Array<[string, (s: AuthService, seeded: SeededAccount, caller: string, w1: string) => Promise<unknown>]> = [
    ["Devices revoke", (s, seeded, caller, w1) => s.revokeDevice(ctxFor(seeded.accountId, seeded.userId, caller), w1)],
    ["its own sign-out", (s, seeded, _caller, w1) => s.logout(ctxFor(seeded.accountId, seeded.userId, w1), {})],
  ];
  for (const [door, revokeW1] of RACED) it(`RACE: a registration that waits on ${door} is refused, and leaves no row`, async () => {
    // The revoke is held at its prune, after it wrote the session row; the registration runs on a
    // second connection and is seen WAITING on that row, then the revoke commits.
    let reached!: () => void;
    const atPrune = new Promise<void>((r) => { reached = r; });
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    class Held extends AuthService {
      protected override async pruneWakeRegistrations(tx: Tx, familyIds: readonly string[]): Promise<void> {
        reached();
        await gate;
        return super.pruneWakeRegistrations(tx, familyIds);
      }
    }
    const seeded = await seedFullAccount(db);
    const caller = await browser(seeded, { twofaAt: new Date() });
    const w1 = await browser(seeded);
    const app = `c0056-race-${randomUUID().slice(0, 8)}`;
    const second = postgres(PG_TEST_URL, { max: 1, onnotice: () => {}, connection: { application_name: app } });
    try {
      const revoke = revokeW1(new Held(makeTestAuthDeps()), seeded, caller.sessionId, w1.sessionId);
      await atPrune;
      const endpoint = `https://push.test/${randomUUID()}`;
      const register = pushService.subscribe(
        { ...ctxFor(seeded.accountId, seeded.userId, w1.sessionId), db: brandDialect(drizzle(second, { schema }), "pg") } as ServiceContext,
        { transport: "webpush", endpoint, p256dh: "p", auth: "a" },
      ).then(() => "registered", (e: { httpStatus?: number }) => e.httpStatus);
      expect(await waitsOnALock(app, 5_000), "the registration never waited on the revoke").toBe(true);
      open();
      await revoke;
      expect(await register).toBe(401);
      expect(await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint))).toEqual([]);
      expect(await live([caller.row, w1.row])).toEqual([caller.row]);
    } finally {
      open();
      await second.end({ timeout: 5 });
    }
  }, 30_000);
});
