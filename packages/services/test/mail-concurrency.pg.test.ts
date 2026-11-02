import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq } from "drizzle-orm";
import { accounts, users } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { loginTokens } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  MailService, SpyMailer, EMAIL_VERIFY_PURPOSE, makeTestAuthDeps, throttleKeysFor, type MailContext,
} from "@trafficflow/services";

const KEYS = throttleKeysFor(makeTestAuthDeps().keyProvider);

/**
 * THE TWO CLAIMS THAT PGLITE CANNOT TEST.
 *
 * Both are concurrency claims, and `makeTestDb()` is a single-connection PGlite: two
 * `await`ed calls in one process are sequential by construction there, so a sequential
 * test of a concurrent property is a test that cannot fail. An independent review said
 * so about both of these, and it was right.
 *
 *  1. **Single-use verification.** `consumeEmailVerification` was SELECT → check
 *     `consumed_at` → unconditional UPDATE. Two requests carrying the same mailed link
 *     both read `consumed_at IS NULL`, both pass, both succeed — and the caller marks the
 *     address verified twice from one credential. It is now a single
 *     `UPDATE … WHERE consumed_at IS NULL … RETURNING`, so the row lock decides.
 *
 *  2. **The rate limit.** `reserveRecipientSlot` claims a slot with one
 *     `INSERT … ON CONFLICT DO UPDATE … RETURNING failures`. That idiom is chosen
 *     precisely so N concurrent attempts cannot collapse into one increment — which is
 *     the scenario the limiter exists for and the scenario a sequential test skips.
 *
 * Restore either implementation to a read-modify-write and the corresponding case below
 * goes red on real Postgres while every PGlite test in the suite stays green. That is
 * what makes this file a regression net rather than a smoke test.
 *
 * Same `*.pg.test.ts` contract as the rest of the repo: `PG_TEST_URL`, `realPgAvailable()`
 * probe, `describe.skipIf`, and `TF_REQUIRE_PG=1` turning a skip into a failure in CI.
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

const CONFIG = {
  appUrl: "https://app.ohmail.app",
  siteUrl: "https://ohmail.app",
  supportEmail: "support@ohmail.app",
};

const ctx = (): MailContext => ({ db: db as unknown as MailContext["db"], now: () => new Date() });

/** A real user row, so the `login_tokens.user_id` FK is satisfied. */
async function seedUser(): Promise<{ userId: string; email: string }> {
  const email = `s11-${randomUUID()}@example.com`;
  const [acct] = await db.insert(accounts).values({ name: "mail concurrency" }).returning();
  const [user] = await db.insert(users).values({
    accountId: acct!.id, email, displayName: "Mail",
  }).returning();
  return { userId: user!.id, email };
}

describe.skipIf(!PG_UP)("on real Postgres — the claims PGlite cannot check", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    // A POOL, deliberately: `max: 1` would serialise the statements and reintroduce
    // exactly the blind spot this file exists to remove.
    client = postgres(PG_TEST_URL, { max: 10 });
    db = brandDialect(drizzle(client, { schema }), "pg");
  }, 60_000);
  afterAll(async () => { await client?.end({ timeout: 5 }); });

  it("a verification link presented 12 times AT ONCE is consumed exactly once", async () => {
    const spy = new SpyMailer();
    const svc = new MailService({ mailer: spy, config: CONFIG, throttleKeys: KEYS });
    const { userId, email } = await seedUser();

    expect((await svc.issueEmailVerification(ctx(), { userId, to: email })).status).toBe("sent");
    const raw = new URL(spy.only("email_verification").data.verifyUrl).searchParams.get("token")!;

    const results = await Promise.all(
      Array.from({ length: 12 }, () => svc.consumeEmailVerification(ctx(), raw)),
    );
    const winners = results.filter((r) => r !== null);
    expect(winners, "single-use is not single-use under concurrency").toHaveLength(1);
    expect(winners[0]).toEqual({ userId });

    const rows = await db.select().from(loginTokens).where(eq(loginTokens.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.consumedAt).not.toBeNull();
  });

  it("an expired or wrong-purpose token loses the race too, not just the second caller", async () => {
    const spy = new SpyMailer();
    const svc = new MailService({ mailer: spy, config: CONFIG, throttleKeys: KEYS });
    const { userId, email } = await seedUser();
    await svc.issueEmailVerification(ctx(), { userId, to: email });
    const raw = new URL(spy.only("email_verification").data.verifyUrl).searchParams.get("token")!;

    // Flip the purpose: the very same hash is now a `login` token, and the mail path
    // must not consume it under any concurrency.
    await db.update(loginTokens).set({ purpose: "login" }).where(eq(loginTokens.userId, userId));
    const results = await Promise.all(
      Array.from({ length: 8 }, () => svc.consumeEmailVerification(ctx(), raw)),
    );
    expect(results.every((r) => r === null)).toBe(true);
    const rows = await db.select().from(loginTokens).where(eq(loginTokens.userId, userId));
    expect(rows[0]!.consumedAt, "a login token was consumed by the mail path").toBeNull();
  });

  it("20 simultaneous sends to one recipient yield EXACTLY the configured budget", async () => {
    // The mail-bomb scenario, run the way it actually happens: in parallel. A
    // read-modify-write limiter lets most of these through because they all read the
    // same `failures` value before any of them writes.
    const spy = new SpyMailer();
    const svc = new MailService({
      mailer: spy, config: { ...CONFIG, ratePerWindow: 3, rateWindowMs: 60_000 }, throttleKeys: KEYS,
    });
    const to = `flood-${randomUUID()}@example.com`;

    const results = await Promise.all(
      Array.from({ length: 20 }, () => svc.sendWaitlistConfirmation(ctx(), { to, tier: "solo" })),
    );
    expect(results.filter((r) => r.status === "sent")).toHaveLength(3);
    expect(results.filter((r) => r.status === "skipped")).toHaveLength(17);
    // The transport is the ground truth: the limiter must have stopped them BEFORE the send.
    expect(spy.sent, "more mails reached the transport than the budget allows").toHaveLength(3);
  });

  it("the limiter's window roll survives the postgres-js parameter rule", async () => {
    // `reserveRecipientSlot` puts ISO STRINGS in its raw `sql` templates, for the reason
    // `auth-throttle.pg.test.ts` documents at length: postgres-js serialises a raw
    // template parameter against the type Postgres describes for `$n::timestamptz`, which
    // is TEXT, and throws `ERR_INVALID_ARG_TYPE` on a `Date`. PGlite binds a Date happily,
    // so only this driver can catch a regression. Two windows, one recipient.
    const spy = new SpyMailer();
    const to = `roll-${randomUUID()}@example.com`;
    let t = new Date("2026-08-01T09:00:00.000Z");
    const svc = new MailService({
      mailer: spy, config: { ...CONFIG, ratePerWindow: 1, rateWindowMs: 60_000 }, throttleKeys: KEYS,
    });
    const at = (): MailContext => ({ db: db as unknown as MailContext["db"], now: () => t });

    expect((await svc.sendWaitlistConfirmation(at(), { to, tier: "solo" })).status).toBe("sent");
    expect((await svc.sendWaitlistConfirmation(at(), { to, tier: "solo" })).status).toBe("skipped");
    t = new Date(t.getTime() + 60_001);
    expect((await svc.sendWaitlistConfirmation(at(), { to, tier: "solo" })).status).toBe("sent");
    expect(spy.sent).toHaveLength(2);
  });
});
