import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq } from "drizzle-orm";
import { schema } from "@trafficflow/db/cloud";
import { authThrottle } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { makeAuthService, makeTestAuthDeps, throttleKeysFor, type ServiceContext } from "@trafficflow/services";

/**
 * THE THROTTLE, ON REAL POSTGRES — because PGlite hid a server error in production.
 *
 * `throttleFailure` writes its window roll and lockout in ONE `insert … on conflict do
 * update` whose `set` clauses are raw `sql` templates. Drizzle passes a raw template
 * parameter through untouched, and **postgres-js** then serializes it against the type
 * Postgres describes for `$n` in `$n::timestamptz` — TEXT. Handed a `Date`, it calls
 * `Buffer.byteLength(date)` and throws `ERR_INVALID_ARG_TYPE`, which `withErrorEnvelope`
 * turns into a bare 500.
 *
 * That is not a corner: `throttleFailure` runs on EVERY `POST /auth/register` and on every
 * failed `POST /auth/login`, so on the deployed API (postgres-js against Neon) registration
 * and the password-only re-entry path were both dead — while the entire auth suite passed,
 * because it runs on PGlite and PGlite binds a `Date` happily.
 *
 * So this file exists to run the throttle against the driver PRODUCTION uses. Revert the
 * `.toISOString()` calls in `auth-service.ts` and every test below fails with
 * `ERR_INVALID_ARG_TYPE`; that is what makes it a regression net rather than a smoke test.
 */
/**
 * The repo's `*.pg.test.ts` contract, honoured exactly: `PG_TEST_URL` is the one URL every
 * pg test agrees on, `realPgAvailable()` probes it, and `describe.skipIf` turns "no local
 * Postgres" into a SKIP. `TF_REQUIRE_PG=1` is what makes it an enforced gate in CI — see
 * `packages/db/src/testing.ts`. Connecting at module scope instead would have made a plain
 * `pnpm test` on a machine without Docker fail with a connection error, which hides real
 * failures behind an infrastructure one.
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

const ctx = (): ServiceContext => ({
  db, accountId: "", userId: null, now: () => new Date(),
  requestId: "throttle-pg", ip: `10.0.0.${Math.floor(Math.random() * 250) + 1}`,
});

describe.skipIf(!PG_UP)("auth throttle against the postgres-js driver", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    // postgres-js DELIBERATELY, not the shared `makePooledDb`: the bug this file exists for
    // is a postgres-js parameter-serialization fault, so the driver is the subject.
    client = postgres(PG_TEST_URL, { max: 5 });
    db = brandDialect(drizzle(client, { schema }), "pg");
  }, 60_000);
  afterAll(async () => { await client?.end({ timeout: 5 }); });

  it("POST /auth/register's throttle write succeeds (it used to be ERR_INVALID_ARG_TYPE)", async () => {
    const svc = makeAuthService(makeTestAuthDeps({ inviteCodes: new Set(["INVITE-OK"]) }));
    const email = `throttle-${randomUUID()}@lichtgrat.example`;
    const out = await svc.register(ctx(), {
      email, password: "account-signin-password", displayName: "Gil", inviteCode: "INVITE-OK",
    });
    // A real enrollment session came back — the whole register path ran, not just the insert.
    expect(out.enrollmentToken).toEqual(expect.any(String));
    expect(out.user.accountId).toEqual(expect.any(String));
  });

  it("counts a failed login, and the SECOND attempt takes the ON CONFLICT branch", async () => {
    // The conflict branch is where all three raw-`sql` parameters live, so one attempt
    // alone would not have exercised the bug.
    const deps = makeTestAuthDeps();
    const svc = makeAuthService(deps);
    const email = `nobody-${randomUUID()}@lichtgrat.example`;
    for (let i = 0; i < 2; i++) {
      await expect(svc.login(ctx(), { email, password: "wrong" })).rejects.toMatchObject({ httpStatus: 401 });
    }
    // Two clients (`ctx()` draws an IP each call), one address: the address ceiling's row took
    // the conflict branch — the same raw `sql` statement, parameterised by its policy.
    const rows = await db.select().from(authThrottle).where(eq(authThrottle.key, `pwa:${throttleKeysFor(deps.keyProvider).address(email)}`));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.failures).toBe(2);
    expect(rows[0]!.windowStartedAt).toBeInstanceOf(Date);
  });

  it("locks out at maxFailures, and the lockedUntil the conflict branch wrote is a real timestamp", async () => {
    const deps = makeTestAuthDeps({ maxFailures: 3, lockoutMs: 60_000 });
    const svc = makeAuthService(deps);
    const email = `locked-${randomUUID()}@lichtgrat.example`;
    const fixedIp = { ...ctx(), ip: "10.9.9.9" };
    for (let i = 0; i < 3; i++) {
      await expect(svc.login(fixedIp, { email, password: "wrong" })).rejects.toMatchObject({ httpStatus: 401 });
    }
    // The 4th is refused by the lockout the ON CONFLICT branch installed.
    await expect(svc.login(fixedIp, { email, password: "wrong" })).rejects.toMatchObject({ httpStatus: 423 });

    const k = throttleKeysFor(deps.keyProvider);
    const row = (await db.select().from(authThrottle).where(eq(authThrottle.key, `pw:${k.address(email)}:${k.client("10.9.9.9")}`)))[0]!;
    expect(row.lockedUntil).toBeInstanceOf(Date);
    expect(row.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
  });
});
