import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { staffUsers, authThrottle } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { createApp, apiRoutes, type AdminConfig, type ApiDeps } from "@trafficflow/api";
import { scryptHasher, totpNow, newTotpSecret, makeTestAuthDeps, throttleKeysFor, type Db } from "@trafficflow/services";

/**
 * THE TWO ADMIN-STAFF GUARANTEES PGlite CANNOT HOST — and both were named as UNCOVERED in the
 * slice that shipped them, rather than claimed. This file is that debt.
 *
 * ── 1. THE TOTP COMPARE-AND-SWAP (the concurrent half) ────────────────────────────────
 *
 * `admin-staff.ts:signIn` advances `totp_last_consumed_step` with a CONDITIONAL update: the
 * `where` re-states the step the handler READ, so a second sign-in that read the same value
 * matches zero rows and is refused. The SEQUENTIAL replay is already covered — setting
 * `afterStep: null` turns the second submission of one code green — but the CAS itself was
 * provably not: removing the predicate and replacing it with `eq(staffUsers.id, user.id)` left
 * all 18 PGlite tests passing, because PGlite is ONE connection and the "both read the old
 * step" interleaving is unreachable there.
 *
 * That is the whole apparatus below: two physical connections, a barrier that holds both
 * requests until each has done its READ, then release. One sign-in must win and one must be
 * refused — with the SAME six digits, at the same instant, which is exactly what an attacker
 * who shoulder-surfed a code and raced the operator would send.
 *
 * ── 2. THE THROTTLE, WHICH IS THE COMPONENT THAT ACTUALLY FAILED IN PRODUCTION ────────────
 *
 * Every failed staff sign-in answered `503 admin_staff_failed` instead of `401 invalid` on the
 * day it shipped: the counter was a raw `sql` template holding `Date` parameters, which
 * postgres-js serialises against TEXT before handing the `Date` to `Buffer.byteLength`. All 18
 * tests were green through it, because PGlite does not have the behaviour. It was found by
 * walking the deployed sign-in.
 *
 * So this file runs the fixed statement against a REAL postgres-js connection, which is the
 * only place that defect was ever visible — and then races it, because a counter that loses
 * increments under concurrency is the other half of what a throttle is for.
 */
const PG_UP = await realPgAvailable();

const SECRET = "admin-console-internal-secret-fixture-token";
const ADMIN: AdminConfig = { secret: SECRET, environment: "test" };
const PASSWORD = "staff-console-sign-in-password";
const app = createApp(apiRoutes);

/**
 * A real-Postgres `ApiDeps` on its OWN connection — two of these is what makes the race real.
 *
 * The staff routes are `anonymous`, so `ANONYMOUS_PIPELINE` resolves no session and the service
 * bag is never reached. Only `db`, `now`, `keyProvider` and `admin` are read, which is why this
 * can be a narrow object rather than the twenty-service bag the idempotency race needs.
 */
function depsOn(db: Db, now: Date): ApiDeps {
  const authDeps = makeTestAuthDeps({});
  return {
    db,
    now: () => now,
    requestId: `pg-${randomUUID()}`,
    session: null,
    authConfig: authDeps.config,
    keyProvider: authDeps.keyProvider,
    admin: ADMIN,
  } as unknown as ApiDeps;
}

/**
 * A UNIQUE address per call.
 *
 * The throttle keys on `staff:ip:<sha256 prefix>`, and rows PERSIST in the shared test Postgres
 * between runs — so a literal like `203.0.113.12` carries its lock over from the previous run
 * and the second run of this file fails on attempt 1 with `expected 429 to be 401`. Measured,
 * not guessed: that is exactly how it failed while mutating the CAS. Tests that share a real
 * database have to generate their own key space.
 */
let ipCounter = 0;
const freshIp = (): string => `198.18.${Math.floor(ipCounter / 250) % 250}.${(ipCounter++ % 250) + 1}-${randomUUID()}`;

function post(path: string, body: unknown, ip: string): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${SECRET}`,
      "content-type": "application/json",
      "x-forwarded-for": ip,
    },
    body: JSON.stringify(body),
  });
}

describe.skipIf(!PG_UP)("admin staff sign-in against real Postgres", () => {
  let ownedA: OwnedDb;
  let ownedB: OwnedDb;
  let ownedC: OwnedDb;
  let dbA: Db;
  let dbB: Db;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    ownedA = makeOwnedDb(PG_TEST_URL);
    ownedB = makeOwnedDb(PG_TEST_URL);
    ownedC = makeOwnedDb(PG_TEST_URL);
    dbA = ownedA.db as unknown as Db;
    dbB = ownedB.db as unknown as Db;
  }, 60_000);

  afterAll(async () => {
    await ownedA?.close();
    await ownedB?.close();
    await ownedC?.close();
  });

  /** A fresh operator per test — the email is unique so tests never collide on the throttle key. */
  async function seedStaff(activated: boolean): Promise<{ email: string; secret: string }> {
    const email = `ops+${randomUUID()}@ohmail.app`;
    const secret = newTotpSecret();
    const authDeps = makeTestAuthDeps({});
    const sealed = await authDeps.keyProvider.encrypt(secret);
    await dbA.insert(staffUsers).values({
      email,
      passwordHash: await scryptHasher.hash(PASSWORD),
      ...(activated
        ? { totpSecretEnc: sealed.ciphertext, totpKeyVersion: sealed.keyVersion, totpActivated: true }
        : {}),
    });
    return { email, secret };
  }

  /**
   * Run two requests so they genuinely overlap ACROSS THE READ.
   *
   * The barrier holds a `FOR UPDATE` row lock on the operator. A plain `SELECT` does not block
   * on it, so both handlers complete their read and observe the SAME `totp_last_consumed_step`;
   * both then reach their `UPDATE` and block there. Releasing the barrier lets both proceed into
   * the compare-and-swap, which is the exact interleaving under test.
   */
  async function raceOnStaffRow(
    email: string, requests: Array<() => Promise<Response>>,
  ): Promise<Response[]> {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const ready = new Promise<void>((r) => { locked = r; });

    const barrier = (ownedC.db as unknown as Db).transaction(async (tx) => {
      await tx.execute(sql`select id from staff_users where email = ${email} for update`);
      locked();
      await held;
    });

    await ready;
    const inFlight = requests.map((send) => send());
    // Long enough for both handlers to have read the row and blocked on their UPDATE.
    await new Promise((r) => setTimeout(r, 400));
    release();
    await barrier;
    return Promise.all(inFlight);
  }

  it("refuses the SECOND of two simultaneous sign-ins with the same code (the CAS)", async () => {
    const now = new Date("2026-08-05T12:00:00.000Z");
    const { email, secret } = await seedStaff(true);
    const code = totpNow(secret, now);
    const body = { email, password: PASSWORD, code };

    const [a, b] = await raceOnStaffRow(email, [
      () => app.handle(post("/admin/staff/session", body, freshIp()), { ...depsOn(dbA, now), session: null, idempotency: null }),
      () => app.handle(post("/admin/staff/session", body, freshIp()), { ...depsOn(dbB, now), session: null, idempotency: null }),
    ]);

    const statuses = [a!.status, b!.status].sort();
    // EXACTLY ONE session. Remove the CAS predicate in `signIn` and this becomes [200, 200].
    expect(statuses, "one sign-in must win and one must be refused").toEqual([200, 401]);

    const winner = a!.status === 200 ? a! : b!;
    const loser = a!.status === 200 ? b! : a!;
    expect((await winner.json() as { ok: boolean }).ok).toBe(true);
    // …and the refusal is the ordinary one. A replay must not be distinguishable from a wrong
    // code, or the response tells an attacker their timing was nearly right.
    expect(await loser.json()).toEqual({ ok: false, status: "invalid" });

    // The consumed step advanced exactly once.
    const [row] = await dbA.select().from(staffUsers).where(eq(staffUsers.email, email));
    expect(row!.totpLastConsumedStep).not.toBeNull();
  }, 30_000);

  it("the same code is still refused SEQUENTIALLY, against real Postgres", async () => {
    const now = new Date("2026-08-05T12:00:00.000Z");
    const { email, secret } = await seedStaff(true);
    const body = { email, password: PASSWORD, code: totpNow(secret, now) };
    const deps = { ...depsOn(dbA, now), session: null, idempotency: null };

    const first = await app.handle(post("/admin/staff/session", body, freshIp()), deps);
    const second = await app.handle(post("/admin/staff/session", body, freshIp()), deps);
    expect(first.status).toBe(200);
    expect(second.status).toBe(401);
  }, 30_000);
  /* ══════════════════════════════════════════════════════════════════════════════════════
     THE ENROLMENT PROMOTION — row-state ordering, which PGlite cannot host either
     ══════════════════════════════════════════════════════════════════════════════════════ */

  /**
   * `totpConfirm` READS the pending pair, verifies a code against it, and THEN promotes it into
   * the live pair. Between those two moments another tab's `begin` can land and replace the
   * pending pair — and if the promotion did not pin the ciphertext it verified, it would activate
   * a secret this operator has never seen. That is the lockout the pending columns exist to stop,
   * arriving through the other door.
   *
   * One connection blocks on a `FOR UPDATE` row lock and supersedes the pending pair while the
   * confirm is held at its UPDATE, which is the interleaving exactly. PGlite is one connection, so
   * there it is unreachable: with the CAS predicate replaced by `eq(staffUsers.id, staffId)` every
   * PGlite test stays green and this one goes red.
   */
  it("a confirm whose pending secret was superseded mid-flight promotes NOTHING", async () => {
    const now = new Date("2026-08-05T12:00:00.000Z");
    const { email, secret: unusedSecret } = await seedStaff(false);
    void unusedSecret;

    // Tab A begins an enrolment and holds the secret it was shown.
    const started = await app.handle(
      post("/admin/staff/session", { email, password: PASSWORD }, freshIp()),
      { ...depsOn(dbA, now), session: null, idempotency: null },
    );
    const { enrollToken } = await started.json() as { enrollToken: string };
    const begun = await app.handle(
      post("/admin/staff/totp/begin", { enrollToken }, freshIp()),
      { ...depsOn(dbA, now), session: null, idempotency: null },
    );
    const { secret: secretA } = await begun.json() as { secret: string };
    const [beforeRow] = await dbA.select().from(staffUsers).where(eq(staffUsers.email, email));
    const pendingA = beforeRow!.totpPendingSecretEnc;
    expect(pendingA, "begin must have written a PENDING pair").not.toBeNull();
    expect(beforeRow!.totpSecretEnc, "and never the live one").toBeNull();

    // The barrier holds the row; the confirm reads through it and blocks on its UPDATE. While it
    // is blocked, the second tab's begin lands — modelled as the write that begin performs.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const ready = new Promise<void>((r) => { locked = r; });
    const barrier = (ownedC.db as unknown as Db).transaction(async (tx) => {
      await tx.execute(sql`select id from staff_users where email = ${email} for update`);
      locked();
      await held;
      await tx.execute(sql`update staff_users
        set totp_pending_secret_enc = 'superseded-by-the-other-tab',
            totp_pending_key_version = 1,
            totp_pending_started_at = now()
        where email = ${email}`);
    });
    await ready;
    const confirming = app.handle(
      post("/admin/staff/totp/confirm", { enrollToken, code: totpNow(secretA, now) }, freshIp()),
      { ...depsOn(dbB, now), session: null, idempotency: null },
    );
    await new Promise((r) => setTimeout(r, 400));
    release();
    await barrier;
    const confirmed = await confirming;

    // 409, not a session: the pending pair this call verified is no longer the pending pair.
    expect(confirmed.status, "a superseded enrolment must not complete").toBe(409);
    expect(await confirmed.json()).toEqual({ error: { code: "enrollment_superseded" } });

    // And nothing was activated against a secret nobody holds — the whole point.
    const [afterRow] = await dbA.select().from(staffUsers).where(eq(staffUsers.email, email));
    expect(afterRow!.totpActivated, "activation must not have moved").toBe(false);
    expect(afterRow!.totpSecretEnc, "the live secret must still be absent").toBeNull();
    expect(afterRow!.totpPendingSecretEnc).toBe("superseded-by-the-other-tab");
  }, 30_000);
});

describe.skipIf(!PG_UP)("the staff throttle against real Postgres", () => {
  let owned: OwnedDb;
  let ownedB: OwnedDb;
  let db: Db;
  let dbB: Db;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    owned = makeOwnedDb(PG_TEST_URL);
    ownedB = makeOwnedDb(PG_TEST_URL);
    db = owned.db as unknown as Db;
    dbB = ownedB.db as unknown as Db;
  }, 60_000);

  afterAll(async () => {
    await owned?.close();
    await ownedB?.close();
  });

  async function seed(): Promise<string> {
    const email = `ops+${randomUUID()}@ohmail.app`;
    await db.insert(staffUsers).values({ email, passwordHash: await scryptHasher.hash(PASSWORD) });
    return email;
  }

  /**
   * THE REGRESSION, in the only environment that could ever show it.
   *
   * Before the fix this was a 503: the counter handed postgres-js a `Date` inside a raw template
   * and threw before the 401 could be written, so a mistyped password was reported as a server
   * error. On PGlite it was — and still is — green either way.
   */
  it("answers 401 for a wrong password, not 503 — the counter must not throw on real Postgres", async () => {
    const now = new Date("2026-08-05T12:00:00.000Z");
    const email = await seed();
    const res = await app.handle(
      post("/admin/staff/session", { email, password: "wrong" }, freshIp()),
      { ...depsOn(db, now), session: null, idempotency: null },
    );
    expect(res.status, "a wrong password is a refusal, not an outage").toBe(401);
    expect(await res.json()).toEqual({ ok: false, status: "invalid" });

    const rows = await db.select().from(authThrottle).where(eq(authThrottle.key, `staff:email:${throttleKeysFor(makeTestAuthDeps({}).keyProvider).address(email)}`));
    expect(rows, "the failure was actually counted").toHaveLength(1);
    expect(rows[0]!.failures).toBe(1);
  }, 30_000);

  it("locks after five failures and then refuses the RIGHT password too", async () => {
    const now = new Date("2026-08-05T12:00:00.000Z");
    const email = await seed();
    const deps = { ...depsOn(db, now), session: null, idempotency: null };
    // ONE address across all six attempts — that is what is under test — but fresh per RUN, or
    // the previous run's lock is still in the shared database. See `freshIp`.
    const ip = freshIp();

    for (let i = 0; i < 5; i += 1) {
      const r = await app.handle(post("/admin/staff/session", { email, password: "wrong" }, ip), deps);
      expect(r.status, `attempt ${i + 1}`).toBe(401);
    }
    const locked = await app.handle(post("/admin/staff/session", { email, password: PASSWORD }, ip), deps);
    expect(locked.status, "the lock must hold against the correct password").toBe(429);
    const body = await locked.json() as { status: string; retryAfterSeconds: number };
    expect(body.status).toBe("throttled");
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
  }, 30_000);

  /**
   * A counter that loses increments under concurrency is not a limiter. The statement is ONE
   * `INSERT … ON CONFLICT DO UPDATE`, so the row lock decides the race; a read-modify-write here
   * would collapse simultaneous attempts into a single increment — which is precisely the
   * traffic a throttle exists to catch.
   */
  it("counts every one of five SIMULTANEOUS failures across two connections", async () => {
    const now = new Date("2026-08-05T12:00:00.000Z");
    const email = await seed();
    const depsA = { ...depsOn(db, now), session: null, idempotency: null };
    const depsB = { ...depsOn(dbB, now), session: null, idempotency: null };

    await Promise.all([
      app.handle(post("/admin/staff/session", { email, password: "w" }, freshIp()), depsA),
      app.handle(post("/admin/staff/session", { email, password: "w" }, freshIp()), depsB),
      app.handle(post("/admin/staff/session", { email, password: "w" }, freshIp()), depsA),
      app.handle(post("/admin/staff/session", { email, password: "w" }, freshIp()), depsB),
      app.handle(post("/admin/staff/session", { email, password: "w" }, freshIp()), depsA),
    ]);

    const [row] = await db.select().from(authThrottle).where(eq(authThrottle.key, `staff:email:${throttleKeysFor(makeTestAuthDeps({}).keyProvider).address(email)}`));
    expect(row, "the email key must exist").toBeDefined();
    expect(row!.failures, "no increment may be lost").toBe(5);
    expect(row!.lockedUntil, "five failures is the lock threshold").not.toBeNull();
  }, 30_000);

  /**
   * THE BOUND IS FIVE GUESSES, NOT FIVE ROUND TRIPS' WORTH OF LATENCY.
   *
   * The test above proves no increment is LOST. It says nothing about the gate, which was a
   * separate plain SELECT run before the scrypt with the increment landing after it — a
   * check-then-act pair. Forty simultaneous requests all read "unlocked", all spent a scrypt, and
   * the five-attempt window became a forty-attempt one plus a scrypt storm on the runtime
   * connection the console shares with mail operations. Making one half of a check-then-act pair
   * atomic does not repair it; the count and the decision have to be the same statement.
   *
   * So the assertion is on the RESPONSES, which is where the guesses are: exactly five reached
   * their merits (401) and the rest were refused by the lock (429) before costing a hash. Revert
   * `throttleReserve` to the old `throttleCheck` read and this goes red with forty 401s.
   */
  it("forty simultaneous wrong passwords are answered on their merits FIVE times", async () => {
    const now = new Date("2026-08-05T12:00:00.000Z");
    const email = await seed();
    const depsA = { ...depsOn(db, now), session: null, idempotency: null };
    const depsB = { ...depsOn(dbB, now), session: null, idempotency: null };

    const results = await Promise.all(
      Array.from({ length: 40 }, (_unused, i) => app.handle(
        post("/admin/staff/session", { email, password: `guess-${i}-password` }, freshIp()),
        i % 2 === 0 ? depsA : depsB,
      )),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 401), "the policy admits five").toHaveLength(5);
    expect(statuses.filter((s) => s === 429), "every other attempt is refused").toHaveLength(35);
    // Nothing became a 503: the refusal path is a refusal, not an outage.
    expect(statuses.every((s) => s === 401 || s === 429)).toBe(true);
  }, 60_000);
});
