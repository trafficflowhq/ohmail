import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq } from "drizzle-orm";
// `sessions` lives on the MAIL half (the root barrel); only the auth tables below are Cloud.
import { sessions } from "@trafficflow/db";
import { schema, authThrottle, recoveryCodes } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  AuthService, makeTestAuthDeps, ServiceError,
  type AuthDeps, type ServiceContext,
  throttleKeysFor,
} from "@trafficflow/services";
import { desc } from "drizzle-orm";
import { generateSync } from "otplib";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE TWO AUTH RACES THAT PGlite CANNOT SHOW YOU
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Both defects below are check-then-act pairs, and a sequential suite proves nothing about
 * either: run the same calls one after another and the counter/lock is always up to date by the
 * time the next one reads it. They need real connections against real Postgres, which is what
 * this file is.
 *
 *  1. **`login`'s lockout was a pure SELECT in front of the password verify.** The increment
 *     landed after the hash, so N simultaneous requests all read "not locked", all spent a
 *     scrypt, and the effective brute-force bound was the attacker's chosen concurrency instead
 *     of `maxFailures`. Measured here at 40 requests against a limit of 5.
 *
 *  2. **`generateRecoveryCodes` was a bare delete followed by a bare insert.** Two overlapping
 *     regenerations both delete, then both insert; neither delete can see the other's
 *     uncommitted rows, so BOTH ten-code sheets survived and the one the user was told was dead
 *     remained a valid second factor.
 *
 * `describe.skipIf(!PG_UP)` and `PG_TEST_URL` are the repo's `*.pg.test.ts` contract;
 * `TF_REQUIRE_PG=1` turns the skip into a hard failure in CI.
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

const ctx = (over: Partial<ServiceContext> = {}): ServiceContext => ({
  db, accountId: "", userId: null, now: () => new Date(),
  requestId: "throttle-race-pg", ip: "10.7.7.7", ...over,
});

describe.skipIf(!PG_UP)("auth races on real Postgres", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    // Enough connections that forty callers genuinely overlap rather than queueing behind one.
    client = postgres(PG_TEST_URL, { max: 20 });
    db = brandDialect(drizzle(client, { schema }), "pg");
  }, 60_000);
  afterAll(async () => { await client?.end({ timeout: 5 }); });

  /**
   * THE BOUND IS THE POLICY, NOT THE CONNECTION COUNT.
   *
   * The password hasher counts its own calls, because the number of hashes performed IS the
   * number of guesses the attacker got — the response codes alone would not distinguish "refused
   * after a verify" from "refused before one". The 50 ms sleep inside `verify` is what keeps all
   * admitted requests in flight simultaneously; without it scrypt's thread pool staggers them.
   *
   * Restore `throttleCheck` in place of `throttleReserve` at the top of `login` and this goes
   * red with `verifies` at 40 (watched, 2026-08-05).
   */
  it("forty simultaneous wrong passwords buy FIVE hashes, not forty", async () => {
    const MAX = 5;
    const N = 40;
    const base = makeTestAuthDeps({ maxFailures: MAX });
    let verifies = 0;
    const deps: AuthDeps = {
      ...base,
      passwordHasher: {
        hash: (p) => base.passwordHasher.hash(p),
        verify: async (p, s) => {
          verifies += 1;
          await new Promise((r) => setTimeout(r, 50));
          return base.passwordHasher.verify(p, s);
        },
      },
    };
    const svc = new AuthService(deps);
    const email = `race-${randomUUID()}@lichtgrat.example`;
    await svc.register(ctx(), {
      email, password: "account-signin-password", displayName: "Gil", inviteCode: "INVITE-OK",
    });
    verifies = 0;   // registration hashes, it does not verify — but be explicit.

    const results = await Promise.all(
      Array.from({ length: N }, () =>
        svc.login(ctx(), { email, password: "mismatched-entry-password" }).catch((e: ServiceError) => e)),
    );

    const statuses = results.map((r) => (r as ServiceError).httpStatus);
    const refused = statuses.filter((s) => s === 423).length;
    const reached = statuses.filter((s) => s === 401).length;

    // No successes, whatever the interleaving.
    expect(statuses.every((s) => s === 401 || s === 423)).toBe(true);
    // The policy, enforced: five attempts were answered on their merits and the rest were
    // refused by the lockout without ever touching the hasher.
    expect(verifies).toBe(MAX);
    expect(reached).toBe(MAX);
    expect(refused).toBe(N - MAX);

    // The password's counter is the (address, client) bucket — `throttle-keys.ts`.
    const k = throttleKeysFor(deps.keyProvider);
    const row = (await db.select().from(authThrottle)
      .where(eq(authThrottle.key, `pw:${k.address(email)}:${k.client("10.7.7.7")}`)).limit(1))[0]!;
    expect(row.lockedUntil).toBeInstanceOf(Date);
    expect(row.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
  }, 60_000);

  /**
   * THE ADDRESS CEILING HOLDS AGAINST FORTY CLIENTS AT ONCE: forty never-seen clients, one wrong
   * password each, simultaneously. The per-client buckets bound nothing here (one attempt each), so
   * the ceiling's single-statement reservation is the whole bound — at most twenty reach the hasher
   * and the rest are slowed, 429, without one.
   */
  it("forty simultaneous never-seen clients at one address buy TWENTY hashes, not forty", async () => {
    const MAX = 20;
    const N = 40;
    const base = makeTestAuthDeps({ maxAddressFailures: MAX });
    let verifies = 0;
    const deps: AuthDeps = {
      ...base,
      passwordHasher: {
        hash: (p) => base.passwordHasher.hash(p),
        verify: async (p, s) => {
          verifies += 1;
          await new Promise((r) => setTimeout(r, 50));
          return base.passwordHasher.verify(p, s);
        },
      },
    };
    const svc = new AuthService(deps);
    const email = `spray-${randomUUID()}@lichtgrat.example`;
    await svc.register(ctx(), { email, password: "account-signin-password", displayName: "Gil", inviteCode: "INVITE-OK" });
    verifies = 0;
    const results = await Promise.all(Array.from({ length: N }, (_, i) =>
      svc.login(ctx({ ip: `10.77.${Math.floor(i / 200)}.${(i % 200) + 1}` }), { email, password: "mismatched-entry-password" })
        .catch((e: ServiceError) => e)));
    const statuses = results.map((r) => (r as ServiceError).httpStatus);
    expect(statuses.every((s) => s === 401 || s === 429), statuses.join(",")).toBe(true);
    expect(verifies).toBeLessThanOrEqual(MAX);
    expect(statuses.filter((s) => s === 401).length).toBe(verifies);
    expect(statuses.filter((s) => s === 429).length).toBe(N - verifies);
  }, 60_000);

  /**
   * EXACTLY ONE SHEET SURVIVES TWO OVERLAPPING REGENERATIONS.
   *
   * Remove the `.for("update")` on the user row in `generateRecoveryCodes` and this goes red
   * with two distinct `batch_id`s and twenty rows (watched, 2026-08-05).
   */
  it("two concurrent recovery-code regenerations leave ONE live batch", async () => {
    const svc = new AuthService(makeTestAuthDeps());
    const email = `batch-${randomUUID()}@lichtgrat.example`;
    // A movable clock, because TOTP is single-use PER TIMESTEP: `totpActivate` consumes the
    // current step, so a verify in the same 30-second window is refused by design.
    let t = new Date();
    const at = (over: Partial<ServiceContext> = {}): ServiceContext => ctx({ now: () => t, ...over });
    const totp = (secret: string): string =>
      generateSync({ secret, epoch: Math.floor(t.getTime() / 1000) });
    const { user } = await svc.register(at(), {
      email, password: "account-signin-password", displayName: "Gil", inviteCode: "INVITE-OK",
    });

    const latestSession = async (): Promise<string> =>
      (await db.select({ id: sessions.id }).from(sessions)
        .where(eq(sessions.userId, user.userId)).orderBy(desc(sessions.createdAt)).limit(1))[0]!.id;

    // `register` mints the enrollment-scoped session; the factor-enrollment methods want EITHER
    // that or a stepped-up full session, so the fabricated `sessionId: null` ctx the older
    // fixtures used is no longer an authorized caller.
    const enrollCtx = at({
      userId: user.userId, accountId: user.accountId, sessionId: await latestSession(),
    });
    const { secret } = await svc.totpEnroll(enrollCtx);
    await svc.totpActivate(enrollCtx, { code: totp(secret) });
    t = new Date(t.getTime() + 30_000);
    const ch = await svc.login(at(), { email, password: "account-signin-password" });
    if (ch.status !== "twofa_required") throw new Error(`expected a 2FA challenge, got ${ch.status}`);
    await svc.totpVerify(at(), { loginToken: ch.loginToken, code: totp(secret) });
    const sctx = at({
      userId: user.userId, accountId: user.accountId, sessionId: await latestSession(),
    });

    const [a, b] = await Promise.all([
      svc.generateRecoveryCodes(sctx),
      svc.generateRecoveryCodes(sctx),
    ]);

    const rows = await db.select().from(recoveryCodes).where(eq(recoveryCodes.userId, user.userId));
    expect(rows).toHaveLength(10);
    expect(new Set(rows.map((r) => r.batchId)).size).toBe(1);

    // One of the two sheets is dead, and the OTHER still works — the property is "exactly one",
    // not merely "at most one", so both halves are asserted.
    const tryCode = async (code: string): Promise<"accepted" | "refused"> => {
      const l = await svc.login(at(), { email, password: "account-signin-password" });
      if (l.status !== "twofa_required") throw new Error(`expected a 2FA challenge, got ${l.status}`);
      return svc.recoveryVerify(at(), { loginToken: l.loginToken, code })
        .then(() => "accepted" as const)
        .catch(() => "refused" as const);
    };
    const outcomes = [await tryCode(a.codes[0]!), await tryCode(b.codes[0]!)];
    expect(outcomes.filter((o) => o === "accepted")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "refused")).toHaveLength(1);
  }, 60_000);
});
