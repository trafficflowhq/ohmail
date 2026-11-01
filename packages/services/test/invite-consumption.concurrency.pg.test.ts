import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq } from "drizzle-orm";
import { users, type Tx } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { invites } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  consumeInvite, issueInvite, makeAuthService, makeTestAuthDeps, MailService, SpyMailer, throttleKeysFor,
  type ServiceContext,
} from "@trafficflow/services";

/**
 * Stage-2 THE CLAIM PGLITE CANNOT CHECK: an invite opens exactly ONE account.
 *
 * `makeTestDb()` is a single-connection PGlite, so two `await`ed registrations in one
 * process are sequential by construction and a sequential test of a concurrent property is
 * a test that cannot fail. That is the same blind spot the `mail-concurrency.pg.test.ts`
 * and the `mailbox-limit.concurrency.pg.test.ts` were written for, and it applies here
 * with higher stakes: an invite that admits two accounts is the beta gate failing open.
 *
 * The guarantee is one statement — `UPDATE invites SET consumed_at = … WHERE code_hash = $1
 * AND email = $2 AND consumed_at IS NULL AND expires_at > $3 RETURNING id` — inside the
 * transaction that creates the account. Replace it with SELECT-then-check-then-UPDATE and
 * the first case below goes red on real Postgres while every PGlite test stays green.
 *
 * The second case is the other half, and it is what the transaction wrapper buys: a
 * registration that FAILS after consuming must un-burn the invite. Take the `inTransaction`
 * wrapper off `AuthService.register` and it goes red too.
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

const NOW = () => new Date();
const PW = "pw-correct-horse-battery";

const ctx = (): ServiceContext => ({
  db: db as unknown as ServiceContext["db"],
  accountId: "",
  userId: null,
  sessionId: null,
  now: NOW,
  requestId: `s12-${randomUUID()}`,
  // A distinct IP per attempt: the register throttle is 20 per window per client, and
  // this file deliberately fires more than that in one burst.
  ip: `10.0.0.${Math.floor(Math.random() * 250) + 1}`,
});

describe.skipIf(!PG_UP)("on real Postgres — one invite, one account", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    // A POOL, deliberately: `max: 1` would serialise the statements and reintroduce the
    // exact blind spot this file exists to remove.
    client = postgres(PG_TEST_URL, { max: 10 });
    db = brandDialect(drizzle(client, { schema }), "pg");
  }, 60_000);
  afterAll(async () => { await client?.end({ timeout: 5 }); });

  it("ten simultaneous registrations with ONE code produce exactly one account", async () => {
    const svc = makeAuthService(makeTestAuthDeps());
    const email = `race-${randomUUID()}@example.com`;
    const { code } = await issueInvite(db as unknown as Tx, {
      email, expiresAt: new Date(Date.now() + 86_400_000), now: NOW(),
    });

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        svc.register(ctx(), { email, password: PW, displayName: "Racer", inviteCode: code })),
    );

    const won = results.filter((r) => r.status === "fulfilled");
    expect(won, "an invite admitted more than one account under concurrency").toHaveLength(1);

    // Every loser was refused for a reason a human could act on — never a 500, and never
    // a raw unique-constraint violation leaking out of the driver.
    for (const r of results.filter((x) => x.status === "rejected")) {
      const err = (r as PromiseRejectedResult).reason as { code?: string; httpStatus?: number };
      expect(["invite_used", "email_taken"]).toContain(err.code);
      expect(err.httpStatus).toBe(409);
    }

    const rows = await db.select().from(users).where(eq(users.email, email));
    expect(rows).toHaveLength(1);

    const [invite] = await db.select().from(invites).where(eq(invites.email, email));
    expect(invite!.consumedAt).not.toBeNull();
    expect(invite!.consumedByUserId).toBe(rows[0]!.id);
  }, 60_000);

  it("a REFUSED registration rolls the consumption back — the invite is still usable", async () => {
    const svc = makeAuthService(makeTestAuthDeps());
    const email = `rollback-${randomUUID()}@example.com`;

    // The address already has an account, opened with the operator bootstrap code.
    await svc.register(ctx(), { email, password: PW, displayName: "First", inviteCode: "INVITE-OK" });

    // …and then an invite arrives for it anyway (an operator who did not check).
    const { code } = await issueInvite(db as unknown as Tx, {
      email, expiresAt: new Date(Date.now() + 86_400_000), now: NOW(),
    });

    await expect(svc.register(ctx(), { email, password: PW, displayName: "Second", inviteCode: code }))
      .rejects.toMatchObject({ code: "email_taken", httpStatus: 409 });

    // WITHOUT the transaction wrapper the UPDATE above would have committed and this
    // person would hold a burned code for an account they cannot reach.
    const [invite] = await db.select().from(invites).where(eq(invites.email, email));
    expect(invite!.consumedAt, "a refused registration burned the invite").toBeNull();
  }, 60_000);

  /**
   * THE SECOND RACE, which the single-invite cases structurally cannot reach.
   *
   * Everything above contends on ONE invite row, so the invite's own `consumed_at` predicate
   * decides the winner and the users table is never asked to. Two DIFFERENT live invites for
   * the SAME address is a supported operator state (it is what `--force` used to leave
   * behind), and then nothing about the invite serialises anything: both registrations
   * consume their own row, both run the unlocked `select … from users where email = $1` and
   * both see nothing, and both insert.
   *
   * `UNIQUE (account_id, email)` cannot catch it — `register` inserts a fresh `accounts` row
   * first, so the pair is unique whatever the address. `users_email_unique_idx` (migration
   * 0021) is what catches it, and `isUniqueViolation` is what turns the violation back into
   * the ordinary `email_taken` sentence instead of a 500.
   *
   * The consequence if it fails is not cosmetic: `login` does `where email = $1 limit 1` with
   * no ORDER BY, so a password would open an arbitrary one of the two accounts.
   */
  it("two live invites for ONE address still yield exactly one account", async () => {
    const svc = makeAuthService(makeTestAuthDeps());
    const email = `twin-${randomUUID()}@example.com`;

    // Two codes, both live, both bound to the same address — the state `--force` produced.
    const a = await issueInvite(db as unknown as Tx, {
      email, expiresAt: new Date(Date.now() + 86_400_000), now: NOW(),
    });
    const b = await issueInvite(db as unknown as Tx, {
      email, expiresAt: new Date(Date.now() + 86_400_000), now: NOW(),
    });

    const results = await Promise.allSettled([
      svc.register(ctx(), { email, password: PW, displayName: "A", inviteCode: a.code }),
      svc.register(ctx(), { email, password: PW, displayName: "B", inviteCode: b.code }),
    ]);

    const won = results.filter((r) => r.status === "fulfilled");
    expect(won, "two accounts now share one login address").toHaveLength(1);
    for (const r of results.filter((x) => x.status === "rejected")) {
      // A clean, honest 409 — never a raw constraint 500.
      expect((r as PromiseRejectedResult).reason).toMatchObject({ code: "email_taken", httpStatus: 409 });
    }
    expect(await db.select().from(users).where(eq(users.email, email))).toHaveLength(1);

    // The loser's transaction rolled back, so ITS invite is un-burned and still works —
    // which is the whole reason `consumeInvite` runs inside the registering transaction.
    const rows = await db.select().from(invites).where(eq(invites.email, email));
    expect(rows.filter((r) => r.consumedAt === null)).toHaveLength(1);
  }, 60_000);

  it("twelve simultaneous consumptions of one code yield exactly one winner", async () => {
    // The primitive on its own, without the register path around it — so a regression in
    // `consumeInvite` is attributed to `consumeInvite`.
    const email = `direct-${randomUUID()}@example.com`;
    const { code } = await issueInvite(db as unknown as Tx, {
      email, expiresAt: new Date(Date.now() + 86_400_000), now: NOW(),
    });

    const outcomes = await Promise.all(
      Array.from({ length: 12 }, () =>
        consumeInvite(db as unknown as Tx, { code, email, now: NOW() })),
    );
    expect(outcomes.filter((o) => o.ok), "single-use is not single-use under concurrency").toHaveLength(1);
    // Every loser is told the truth, and the truth is `used` — not `unknown`, which would
    // send the rightful holder off to check a code that was perfectly correct.
    for (const o of outcomes.filter((x) => !x.ok)) {
      expect(o).toEqual({ ok: false, refusal: "used" });
    }
  }, 60_000);

  /**
   * THE RACE LOSER ON THE OPEN PATH MUST ANSWER LIKE EVERY OTHER TAKEN ADDRESS.
   *
   * This is the branch that keeps the enumeration oracle alive in the one place nothing looks.
   * `register` catches `users_email_unique_idx` and used to throw `emailTaken` unconditionally —
   * so with the gate open, two SIMULTANEOUS registrations for one address gave the loser a 409
   * while every sequential prober got the constant 202. An oracle that only fires under
   * concurrency is still an oracle, and it is trivially triggerable: fire two requests at once.
   *
   * PGlite structurally cannot see this. It is a single connection, so two `await`ed
   * registrations are sequential and the second one takes the SELECT branch rather than the
   * unique-violation branch. Only a real pool reaches the catch at all.
   *
   * Reverting that catch to `throw emailTaken(!openGate)` makes this red with a rejected
   * promise; the pre-S18 code makes it red with a 409.
   */
  it("concurrent OPEN-path registrations for one address: no loser learns anything", async () => {
    const mail = new MailService({
      mailer: new SpyMailer(),
      config: {
        appUrl: "https://ohmail.app", siteUrl: "https://ohmail.app",
        supportEmail: "support@ohmail.app",
      },
      throttleKeys: throttleKeysFor(makeTestAuthDeps().keyProvider),
    });
    const svc = makeAuthService(makeTestAuthDeps({ publicSignup: true }, mail));
    const email = `open-race-${randomUUID()}@example.com`;

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        svc.register(ctx(), { email, password: PW, displayName: "Racer" })),
    );

    // NOT ONE REJECTION. Every caller — the winner that created the account and the seven that
    // did not — gets the same fulfilled, constant acknowledgement.
    const rejected = results.filter((r) => r.status === "rejected");
    expect(
      rejected.map((r) => (r as PromiseRejectedResult).reason),
      "a concurrent loser was told the address was taken — the oracle is back",
    ).toEqual([]);

    // …and every answer carries the SAME discriminant, which is the whole of what the wire sees:
    // `routes/core.ts` serialises a fixed `{"status":"ok"}` literal for `verification_pending`
    // and never the service value.
    const values = results.map((r) => (r as PromiseFulfilledResult<{ status: string }>).value);
    expect(new Set(values.map((v) => v.status))).toEqual(new Set(["verification_pending"]));

    // `mailed` DOES vary here, legitimately, and this is the one place that is worth stating
    // rather than hiding: eight simultaneous attempts against a five-per-hour per-recipient
    // budget means some of them are rate-limited. That is the limiter working, it is a fact about
    // the recipient's budget rather than about the account, and it is EXACTLY why the route
    // serialises a literal instead of this object — asserted at the HTTP layer by
    // `public-signup-flow.test.ts`'s "the response never carries `mailed`". If a future edit ever
    // put it on the wire, that variance would be an oracle-adjacent readout of how much other
    // mail we recently sent this address.
    expect(values.every((v) => Object.keys(v).sort().join(",") === "mailed,status")).toBe(true);

    // Exactly one account exists, which is what `users_email_unique_idx` is for. The oracle
    // being closed must not have cost the uniqueness guarantee.
    expect(await db.select().from(users).where(eq(users.email, email))).toHaveLength(1);
  }, 60_000);
});
