import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fixturePassword } from "../../../test/support/fixture-credentials.js";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq } from "drizzle-orm";
import { accounts, mailboxes } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import type { AccessVerdict } from "@trafficflow/db";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { StaticKeyProvider, type KeyProvider } from "@trafficflow/core";
import { makeMailboxService, MailboxAllowanceError, type ServiceContext } from "@trafficflow/services";

/**
 * THE GATE — and the one assertion PGlite structurally cannot host.
 *
 * the second sentence is the whole test: *"Two concurrent `POST /mailboxes` also race."* At
 * limit−1 both requests read `count = limit − 1`, both conclude there is room, and both insert;
 * under READ COMMITTED neither can see the other's uncommitted row, so the check is correct and
 * the account still ends up over its plan. PGlite is single-connection by construction and
 * cannot express one transaction blocking on another's row lock, which is exactly the mechanism
 * under test — so this runs against the real docker Postgres on :5433, across TWO independent
 * `postgres()` pools so the concurrency is genuine and not one driver's queue.
 *
 * **The race is made DETERMINISTIC rather than left to scheduling luck.** The loser is started
 * ~60 ms after the winner, and the winner's `KeyProvider.encrypt` sleeps 400 ms *inside* its
 * transaction — so the winner is guaranteed to still be holding the ACCOUNT row lock when
 * the loser reaches it. With `FOR UPDATE` the loser blocks, then counts a world containing the
 * winner's mailbox and is refused; without it the loser sails past on a stale count and both
 * commit. A test that only fires under a lucky interleave is not a gate.
 *
 * `realPgAvailable` is the shared skip/throw gate: it skips on a laptop with no docker and
 * THROWS under `TF_REQUIRE_PG=1` (what `pnpm test:pg` and CI set), because the decisive test of
 * plan enforcement must not be able to vanish silently from a green run.
 */
/**
 * The seam, satisfied rather than exercised.
 *
 * `MailboxService.create` requires a probe now — a create that could omit one is a create that
 * can store a password nobody tried. This file is about something else, so it hands over the
 * verdict a working mailbox gives and asserts nothing about it. The verdicts themselves are
 * driven in `packages/api/test/mailbox-add-probe.wprobe.test.ts`.
 */
const PROBE_OK = { probe: async () => ({ verdict: "ok" as const }) };

const PG_UP = await realPgAvailable();

const sqlA = postgres(PG_TEST_URL, { max: 10, onnotice: () => {} });
const sqlB = postgres(PG_TEST_URL, { max: 10, onnotice: () => {} });
const dbA = brandDialect(drizzle(sqlA, { schema }), "pg");
const dbB = brandDialect(drizzle(sqlB, { schema }), "pg");

beforeAll(async () => { if (PG_UP) await runMigrations(PG_TEST_URL); }, 120_000);
afterAll(async () => { await sqlA.end({ timeout: 5 }); await sqlB.end({ timeout: 5 }); });

const NOW = new Date("2026-08-01T12:00:00.000Z");
const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });
const FAST_KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 7), 1);

/**
 * A KeyProvider that stalls INSIDE the create transaction, after the gate has taken the lock.
 * That is the whole trick for determinism: it widens the window in which the winner holds the
 * account row lock, without any test-only hook in the service itself.
 */
class SlowKeyProvider implements KeyProvider {
  constructor(private readonly inner: KeyProvider, private readonly ms: number) {}
  async encrypt(plaintext: string): Promise<{ ciphertext: string; keyVersion: number }> {
    await sleep(this.ms);
    return this.inner.encrypt(plaintext);
  }
  decrypt(ciphertext: string, keyVersion: number): Promise<string> {
    return this.inner.decrypt(ciphertext, keyVersion);
  }
  currentKeyVersion(): number { return this.inner.currentKeyVersion(); }
  deriveSubkey(info: string): Buffer { return this.inner.deriveSubkey(info); }
}

/**
 * THE LIMIT COMES FROM THE ENTITLEMENTS PORT, one read per write, outside the transaction — so
 * the fixture states a verdict per account instead of seeding a row. An account this map does
 * not name is REFUSED for payment: that is what the port answers for an account whoever operates
 * the service has no standing for, and it is not the same as no reader at all (which is a 500
 * this file never provokes — `mailbox-allowance.test.ts` owns that arm).
 */
const ACCESS = new Map<string, AccessVerdict>();
const accessOf = async (accountId: string): Promise<AccessVerdict> =>
  ACCESS.get(accountId) ?? { ok: false, reason: "payment_required" };

const fastSvc = makeMailboxService({ keyProvider: FAST_KP, accessOf });
const slowSvc = makeMailboxService({ keyProvider: new SlowKeyProvider(FAST_KP, 400), accessOf });

const IMAP = { host: "imap.example", port: 993, secure: true, user: "u", pass: fixturePassword("mailbox-limit") };

describe.skipIf(!PG_UP)("plan limits under real-Postgres concurrency (the limit race)", () => {
  async function seedAccount(): Promise<string> {
    const [a] = await dbA.insert(accounts).values({ name: `s9-${randomUUID().slice(0, 8)}` }).returning();
    return a!.id;
  }

  /** The port admits this account up to `mailboxLimit`. */
  function grant(accountId: string, mailboxLimit: number): void {
    ACCESS.set(accountId, {
      ok: true,
      limits: { mailboxes: mailboxLimit, storageBytes: null, canAddMailbox: true, aiEnabled: true },
    });
  }

  /** `n` already-connected mailboxes, inserted directly (a fixture, not a create). */
  async function seedMailboxes(accountId: string, n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const [mb] = await dbA.insert(mailboxes)
        .values({ accountId, provider: "imap", address: `seed${i}-${randomUUID().slice(0, 6)}@x.test` })
        .returning();
      ids.push(mb!.id);
    }
    return ids;
  }

  const ctxOn = (db: typeof dbA, accountId: string): ServiceContext =>
    ({ db: db as unknown as ServiceContext["db"], accountId, userId: null, now: () => NOW, requestId: "r" });

  const enabledCount = async (accountId: string): Promise<number> =>
    (await dbA.select().from(mailboxes).where(eq(mailboxes.accountId, accountId)))
      .filter((m) => m.status !== "disabled").length;

  it("TWO concurrent creates at limit−1, from independent connections → exactly ONE succeeds", async () => {
    const acct = await seedAccount();
    grant(acct, 3);
    await seedMailboxes(acct, 2);           // limit − 1

    // A takes the lock and stalls 400 ms inside its transaction; B arrives 60 ms in and must
    // block on that lock. Two pools, so this is two real backends, not one queue.
    const a = slowSvc.create(ctxOn(dbA, acct), { provider: "imap", address: "racer-a@x.test", imap: IMAP }, PROBE_OK);
    await sleep(60);
    const b = fastSvc.create(ctxOn(dbB, acct), { provider: "imap", address: "racer-b@x.test", imap: IMAP }, PROBE_OK);

    const settled = await Promise.allSettled([a, b]);
    const ok = settled.filter((s) => s.status === "fulfilled");
    const failed = settled.filter((s) => s.status === "rejected") as PromiseRejectedResult[];

    // 1. Exactly one allocation. This is the assertion `FOR UPDATE` exists for: remove it and
    //    both land, because both counted the same pre-insert world.
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(await enabledCount(acct)).toBe(3);

    // 2. The loser gets the CONTRACT's answer, not the database's. A unique-violation or a
    //    check-constraint escaping from three frames down would satisfy "one succeeded" and
    //    still be a 500 in the user's face.
    const err = failed[0]!.reason as MailboxAllowanceError;
    expect(err).toBeInstanceOf(MailboxAllowanceError);
    expect(err.refusal).toBe("at_limit");
    expect(err.httpStatus).toBe(409);
    expect(err.code).toBe("mailbox_limit_reached");
    expect(err.details).toMatchObject({ mailboxLimit: 3, mailboxCount: 3 });

    // 3. The loser wrote NOTHING — its transaction rolled back whole (address never appears).
    const rows = await dbA.select().from(mailboxes).where(eq(mailboxes.accountId, acct));
    expect(rows.filter((r) => r.address.startsWith("racer-"))).toHaveLength(1);
  });

  it("a STORM of 20 concurrent creates on an empty pro plan of 5 → exactly 5, and nobody THROWS", async () => {
    const acct = await seedAccount();
    grant(acct, 5);

    const attempts = Array.from({ length: 20 }, (_, i) => {
      const db = i % 2 === 0 ? dbA : dbB;
      return fastSvc.create(ctxOn(db, acct), { provider: "imap", address: `storm-${i}@x.test`, imap: IMAP }, PROBE_OK);
    });
    const settled = await Promise.allSettled(attempts);

    const ok = settled.filter((s) => s.status === "fulfilled");
    const failed = settled.filter((s) => s.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(5);
    expect(failed).toHaveLength(15);

    // Every refusal is the typed one. An unexpected reason here — a serialization failure, a
    // raw pg error, a 500 — is the difference between a gate and a crash.
    const unexpected = failed
      .map((f) => f.reason)
      .filter((r) => !(r instanceof MailboxAllowanceError) || r.refusal !== "at_limit")
      .map((r) => String(r));
    expect(unexpected).toEqual([]);
    expect(await enabledCount(acct)).toBe(5);
  });

  it("a CREATE and a RE-ENABLE racing for the same last slot → exactly one of them wins", async () => {
    // The two gated paths share one mutex, so the bypass (disconnect → create → reconnect)
    // cannot be won by racing the two halves against each other either.
    const acct = await seedAccount();
    grant(acct, 3);
    const [, , third] = await seedMailboxes(acct, 3);
    await dbA.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, third!));

    const a = slowSvc.create(ctxOn(dbA, acct), { provider: "imap", address: "last-slot@x.test", imap: IMAP }, PROBE_OK);
    await sleep(60);
    const b = fastSvc.update(ctxOn(dbB, acct), third!, { status: "connected" });

    const settled = await Promise.allSettled([a, b]);
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    expect(await enabledCount(acct)).toBe(3);

    const failed = settled.filter((s) => s.status === "rejected") as PromiseRejectedResult[];
    expect((failed[0]!.reason as MailboxAllowanceError).refusal).toBe("at_limit");
  });

  it("an account the port refuses: 10 concurrent creates all refused 402, and zero mailboxes exist", async () => {
    // The degenerate case, and it is no longer degenerate in the DATABASE. The lock used to be
    // the account's subscription row, and `FOR UPDATE` matching zero rows takes no lock at all —
    // so an account with no row serialized nothing, harmless only because it was refused anyway.
    // The lock is now the `accounts` row, which is always present; this case therefore proves the
    // refusal, not the absence of a mutex.
    const acct = await seedAccount();

    const settled = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        fastSvc.create(ctxOn(i % 2 === 0 ? dbA : dbB, acct), { provider: "imap", address: `nosub-${i}@x.test`, imap: IMAP }, PROBE_OK)),
    );
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(0);
    for (const s of settled) {
      const err = (s as PromiseRejectedResult).reason as MailboxAllowanceError;
      expect(err).toBeInstanceOf(MailboxAllowanceError);
      expect(err.refusal).toBe("payment_required");
      expect(err.httpStatus).toBe(402);
    }
    expect(await enabledCount(acct)).toBe(0);
  });

  it("an account ADMITTED but forbidden another mailbox refuses every create and keeps what it has", async () => {
    // `canAddMailbox: false` under a live limit of 5 — retention and creation are different
    // rights, and this is the one refusal the count cannot produce.
    const acct = await seedAccount();
    ACCESS.set(acct, {
      ok: true,
      limits: { mailboxes: 5, storageBytes: null, canAddMailbox: false, aiEnabled: true },
    });
    await seedMailboxes(acct, 2);

    const settled = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        fastSvc.create(ctxOn(i % 2 === 0 ? dbA : dbB, acct), { provider: "imap", address: `unpaid-${i}@x.test`, imap: IMAP }, PROBE_OK)),
    );
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(0);
    expect((settled[0] as PromiseRejectedResult).reason.refusal).toBe("not_permitted");
    // Retention is untouched: a refusal never deletes mail.
    expect(await enabledCount(acct)).toBe(2);
  });
});
