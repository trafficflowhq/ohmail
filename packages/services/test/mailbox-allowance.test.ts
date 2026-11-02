import { describe, it, expect } from "vitest";
import { fixturePassword } from "../../../test/support/fixture-credentials.js";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accounts, mailboxes, mailboxCredentials, NotInTransactionError, UNMETERED_ACCESS,
  type AccessRefusal, type AccessVerdict,
} from "@trafficflow/db";
import { and, eq } from "drizzle-orm";
import { StaticKeyProvider } from "@trafficflow/core";
import {
  makeMailboxService, MailboxAllowanceError, decideMailboxAllowance, readMailboxAllowance,
  ServiceError,
  type MailboxAllowance, type ServiceContext,
} from "@trafficflow/services";

/**
 * Stage-2 plan-limit enforcement, everything PGlite can host.
 *
 * The RACE lives in `mailbox-limit.concurrency.pg.test.ts` (PGlite is single-connection and
 * structurally cannot express one transaction blocking on another's row lock). What is here is
 * the other half of the gate: the entitlement states that decide WHETHER a create is allowed at
 * all, and the write path actually refusing — atomically, with a typed error, and without
 * leaving a half-written mailbox behind.
 */

const NOW = new Date("2026-08-01T12:00:00.000Z");
const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 7), 1);
/**
 * THE METERED SERVICE, and the `accessOf` is not decoration.
 *
 * The allowance gate takes its LIMIT from the entitlements port, read before the transaction. A
 * bag with no `accessOf` is UNMETERED — unbounded — so the `at_limit` cases below would pass for
 * the wrong reason. The verdict comes from `verdict` below, which each case sets: the numbers
 * are whoever operates the service's, and there are no local tables to seed them into.
 */
let verdict: AccessVerdict = UNMETERED_ACCESS;
const metered = (o: { mailboxes?: number | null; canAddMailbox?: boolean } = {}): void => {
  verdict = {
    ok: true,
    limits: {
      mailboxes: o.mailboxes === undefined ? 2 : o.mailboxes,
      storageBytes: 5_000_000_000,
      canAddMailbox: o.canAddMailbox ?? true,
      aiEnabled: true,
    },
  };
};
const refuse = (reason: AccessRefusal): void => { verdict = { ok: false, reason }; };
const meteredSvc = (_db: Db) => makeMailboxService({
  keyProvider: KP,
  accessOf: async () => verdict,
});
const svc = makeMailboxService({ keyProvider: KP });
const IMAP = { host: "imap.example", port: 993, secure: true, user: "u", pass: fixturePassword("mailbox-allowance") };

type Db = Awaited<ReturnType<typeof makeTestDb>>;

async function seedAccount(db: Db): Promise<string> {
  const [a] = await db.insert(accounts).values({ name: "allowance" }).returning();
  return a!.id;
}

/**
 * WHAT THE ENTITLEMENTS PROGRAM WOULD ANSWER, in place of a subscription row.
 *
 * It kept the old seeder's NAME and shape so the write-path cases below read unchanged: they were
 * never about which subscription states refuse — that table is the program's — but about the
 * gate's own mechanism: the lock, the count, the re-enable path and the atomicity of a refusal.
 */
function seedSub(
  _db: Db,
  _accountId: string,
  over: Partial<{ mailboxLimit: number; status: "active" | "trialing" | "unpaid" | "canceled" }> = {},
): void {
  if (over.status === "unpaid" || over.status === "canceled") refuse("payment_required");
  else metered({ mailboxes: over.mailboxLimit ?? 2 });
}

const ctxFor = (db: Db, accountId: string): ServiceContext =>
  ({ db, accountId, userId: null, now: () => NOW, requestId: "r" });

/**
 * The seam, satisfied rather than exercised.
 *
 * `MailboxService.create` requires a probe now — a create that could omit one is a create that
 * can store a password nobody tried. These tests are about something else (the allowance gate,
 * the unique index, the credential race), so they hand it the verdict a working mailbox gives
 * and assert nothing about it. `packages/api/test/mailbox-add-probe.wprobe.test.ts` is where the
 * verdicts themselves are driven.
 */
const PROBE_OK = { probe: async () => ({ verdict: "ok" as const }) };

const create = (db: Db, accountId: string, address: string) =>
  meteredSvc(db).create(ctxFor(db, accountId), { provider: "imap", address, imap: IMAP }, PROBE_OK);

/** The thrown error, or `null` when the call succeeded — never a silent pass. */
async function refusalOf(p: Promise<unknown>): Promise<MailboxAllowanceError | null> {
  try { await p; return null; } catch (e) { return e as MailboxAllowanceError; }
}

const countEnabled = async (db: Db, accountId: string): Promise<number> =>
  (await db.select().from(mailboxes).where(eq(mailboxes.accountId, accountId)))
    .filter((m) => m.status !== "disabled").length;

// ─────────────────────────────────────────────────────────────────────────────
// 1. The DECISION, as a truth table. Pure — no database, and the states are the
//    PORT's four, not a subscription table's sixteen: the state machine that had
//    sixteen belongs to whoever operates metering, and this server sees a verdict.
// ─────────────────────────────────────────────────────────────────────────────

const ok = (mailboxes: number | null, canAddMailbox = true): MailboxAllowance =>
  ({ mailboxLimit: mailboxes, canAddMailbox, accessRefusal: null, enabledCount: 0 });
const at = (a: MailboxAllowance, enabledCount: number): MailboxAllowance => ({ ...a, enabledCount });

describe("the mailbox-create decision, by the port's verdict", () => {
  const cases: Array<[string, MailboxAllowance, ReturnType<typeof decideMailboxAllowance>]> = [
    ["permitted, empty account", ok(2), null],
    ["permitted, one slot left", at(ok(2), 1), null],
    ["permitted, full", at(ok(2), 2), "at_limit"],
    ["permitted, OVER the limit (the limit shrank) → still refused", at(ok(2), 5), "at_limit"],
    ["UNBOUNDED (null) never reaches the count", at(ok(null), 500), null],
    ["a limit of ZERO refuses the first one, as `at_limit`", ok(0), "at_limit"],
    ["permitted to KEEP but not to ADD → not_permitted, whatever the count",
      ok(2, false), "not_permitted"],
    ["refused for payment → the port's own word", { ...ok(0, false), accessRefusal: "payment_required" }, "payment_required"],
    ["refused as suspended → the port's own word", { ...ok(0, false), accessRefusal: "suspended" }, "suspended"],
  ];
  for (const [name, a, expected] of cases) {
    it(name, () => { expect(decideMailboxAllowance(a)).toBe(expected); });
  }

  it("RETENTION and CREATION are different rights, and the port carries both", () => {
    // `canAddMailbox` is not derivable from the numbers: an account may hold the two it has and
    // be forbidden a third. If these ever collapsed into one number, a refused account could add
    // mailboxes again.
    const a = at(ok(2, false), 1);
    expect(a.mailboxLimit).toBe(2);                     // what it has is NOT taken away
    expect(decideMailboxAllowance(a)).toBe("not_permitted");
  });

  it("every refusal says what happens to the mailboxes already connected", () => {
    // Each of these is read by someone who has already connected mailboxes and whose first
    // question is "what happens to my mail". Asserted as a property, not as strings.
    for (const refusal of ["payment_required", "suspended", "not_permitted"] as const) {
      const a = at({ ...ok(2, false), accessRefusal: refusal === "not_permitted" ? null : refusal }, 1);
      expect(new MailboxAllowanceError(refusal, a).message, refusal).toMatch(/already connected/);
    }
  });

  it("the REFUSAL is reported before the count — a refused full account is not told it is full", () => {
    // Order matters for truthfulness: "you are at your limit" invites a change that would not
    // help, because the real blocker is elsewhere.
    expect(decideMailboxAllowance(at({ ...ok(2, false), accessRefusal: "payment_required" }, 2)))
      .toBe("payment_required");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The write path, against a real (PGlite) database.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE TIER SEAM — one gate, two tiers, and the default is the one that charges.
 *
 * The desktop engine migrates the mail journal alone, so `billing_subscriptions` does not exist
 * on that machine and the hosted gate's `SELECT … FOR UPDATE` cannot run at all. Before the seam
 * every local mailbox write failed with `relation "billing_subscriptions" does not exist`, and
 * the only reason it had ever appeared to work was that the engine also migrated the Cloud
 * journal — the green was produced by the defect.
 *
 * Both halves are asserted in ONE test on purpose. Split in two, the Cloud half passes on a build
 * whose default went permissive as long as the local half is also green, and the pair reads as
 * proof while proving nothing.
 */
describe("the allowance gate is a POLICY, and the default is the paid one", () => {
  it("an injected policy permits where the DEFAULT refuses — same account, same call", async () => {
    const db = await makeTestDb();
    const acct = await seedAccount(db);
    // A REFUSED verdict — the hardest refusal a metered deployment has.
    refuse("payment_required");
    const refused = await refusalOf(create(db, acct, "cloud@x.test"));
    expect(refused, "the default gate let a refused account through").toBeInstanceOf(MailboxAllowanceError);
    expect(refused!.refusal).toBe("payment_required");

    // The same service with the tier stated. `UNMETERED_MAILBOX_ALLOWANCE`'s shape, written out
    // here rather than imported: `apps/sidecar` is a leaf this package must not depend on, and
    // that direction is exactly what keeps the bypass unreachable from the hosted API.
    const local = makeMailboxService({ keyProvider: KP, allowance: async () => {} });
    const made = await local.create(
      ctxFor(db, acct), { provider: "imap", address: "local@x.test", imap: IMAP }, PROBE_OK);
    expect(made.address).toBe("local@x.test");
    expect(await countEnabled(db, acct)).toBe(1);
  });

  /**
   * **NO PERMISSIVE POLICY IS EXPORTED FROM THIS PACKAGE.**
   *
   * The bypass is defined in `apps/sidecar`, which nothing serverless imports or could import, so
   * the hosted API has no name for it: there is no config value, environment variable or flag
   * that reaches the free tier. This asserts the property rather than trusting the convention —
   * the moment somebody exports a convenience `ALLOW_ALL` from here, it is one autocomplete away
   * from a Cloud deps bag.
   */
  it("exports the gate's TYPE and no permissive VALUE", async () => {
    const mod = await import("../src/mail.js") as Record<string, unknown>;
    const permissive = Object.entries(mod).filter(([name, v]) =>
      typeof v === "function"
      && /allowance|unmetered|permissive|unlimited|bypass|allowall/i.test(name));
    expect(permissive.map(([n]) => n), "a permissive allowance policy is exported from @trafficflow/services")
      .toEqual([]);
  });
});

describe("MailboxService.create enforces the plan", () => {
  it("a REFUSED account → 402, and NOTHING is written", async () => {
    const db = await makeTestDb();
    const acct = await seedAccount(db);
    refuse("payment_required");

    const err = await refusalOf(create(db, acct, "a@x.test"));
    expect(err).toBeInstanceOf(MailboxAllowanceError);
    expect(err!.refusal).toBe("payment_required");
    expect(err!.httpStatus).toBe(402);
    expect(err!.code).toBe("payment_required");
    expect(err!.details).toMatchObject({
      reason: "payment_required", accessReason: "payment_required",
      mailboxLimit: 0, mailboxCount: 0,
    });

    // The gate runs INSIDE the transaction and before the insert: no orphan row, and no
    // orphan credential either (which is what the pre-S9 two-autocommit shape risked).
    expect(await db.select().from(mailboxes).where(eq(mailboxes.accountId, acct))).toHaveLength(0);
    expect(await db.select().from(mailboxCredentials)).toHaveLength(0);
  });

  it("an UNMETERED host admits — the self-host and standalone answer", async () => {
    const db = await makeTestDb();
    const acct = await seedAccount(db);
    verdict = UNMETERED_ACCESS;
    expect((await create(db, acct, "free@x.test")).address).toBe("free@x.test");
    expect(await countEnabled(db, acct)).toBe(1);
  });

  it("creates succeed up to the limit the port stated, the next one is 409", async () => {
    // A LITERAL, not a plan card: the limit is whoever operates the service's number, and what
    // this case is about is that the gate counts up to whatever it was handed and refuses next.
    const limit = 5;
    const db = await makeTestDb();
    const acct = await seedAccount(db);
    seedSub(db, acct, { mailboxLimit: limit });

    for (let i = 0; i < limit; i++) {
      expect((await create(db, acct, `box${i}@x.test`)).address).toBe(`box${i}@x.test`);
    }

    const err = await refusalOf(create(db, acct, "over@x.test"));
    expect(err!.refusal).toBe("at_limit");
    expect(err!.httpStatus).toBe(409);
    expect(err!.code).toBe("mailbox_limit_reached");
    expect(err!.details).toMatchObject({ mailboxLimit: limit, mailboxCount: limit });
    expect(err!.message).toContain(`${limit} are connected`);
    expect(await countEnabled(db, acct)).toBe(limit);
  });

  it("a permitted account creates; a REFUSED one cannot — keeping every mailbox it has", async () => {
    const db = await makeTestDb();
    const acct = await seedAccount(db);
    metered({ mailboxes: 2 });
    await create(db, acct, "trial@x.test");

    // The verdict turns. The mailbox stays; the next create does not.
    refuse("payment_required");

    const err = await refusalOf(create(db, acct, "second@x.test"));
    expect(err!.refusal).toBe("payment_required");
    expect(err!.httpStatus).toBe(402);
    expect(err!.code).toBe("payment_required");
    expect(err!.message).toContain("already connected are kept");

    // Invariant: a money event never destroys mail. The mailbox is still there and enabled.
    const rows = await db.select().from(mailboxes).where(eq(mailboxes.accountId, acct));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("connected");
  });

  it("SUSPENDED is reported as suspended, never as a payment demand", async () => {
    // The port's two refusal words are two remedies — pay, or ask us — and collapsing them puts
    // a payment demand in front of somebody whose account we stopped.
    const db = await makeTestDb();
    const acct = await seedAccount(db);
    refuse("suspended");

    const err = await refusalOf(create(db, acct, "gone@x.test"));
    expect(err!.refusal).toBe("suspended");
    expect(err!.code).toBe("account_suspended");
    expect(err!.details).toMatchObject({ accessReason: "suspended" });
  });

  it("the allowance carries the port's verdict verbatim, and reads the count under the lock", async () => {
    const db = await makeTestDb();
    const acct = await seedAccount(db);
    const a = await db.transaction((tx) => readMailboxAllowance(
      tx as never, acct, NOW, { access: UNMETERED_ACCESS },
    ));
    // UNBOUNDED, permitted, no refusal — the shape a host that meters nothing hands down.
    expect(a.mailboxLimit).toBeNull();
    expect(a.canAddMailbox).toBe(true);
    expect(a.accessRefusal).toBeNull();
    expect(a.enabledCount).toBe(0);
  });

  it("a DISABLED mailbox frees its slot; a mailbox in 'error' does NOT", async () => {
    const db = await makeTestDb();
    const acct = await seedAccount(db);
    seedSub(db, acct, { mailboxLimit: 2 });
    const first = await create(db, acct, "one@x.test");
    await create(db, acct, "two@x.test");

    // 'error' is still a connected mailbox — it occupies its slot.
    await db.update(mailboxes).set({ status: "error" }).where(eq(mailboxes.id, first.id));
    expect((await refusalOf(create(db, acct, "three@x.test")))!.refusal).toBe("at_limit");

    // Disconnecting genuinely frees one.
    await svc.delete(ctxFor(db, acct), first.id);
    expect((await create(db, acct, "three@x.test")).address).toBe("three@x.test");
    expect(await countEnabled(db, acct)).toBe(2);
  });

  it("RE-ENABLING a disabled mailbox is gated too — otherwise the limit is a revolving door", async () => {
    const db = await makeTestDb();
    const acct = await seedAccount(db);
    seedSub(db, acct, { mailboxLimit: 2 });
    const a = await create(db, acct, "one@x.test");
    await create(db, acct, "two@x.test");

    // The bypass, step by step: disconnect one, use the freed slot, then try to bring the old
    // one back. Without the gate on `update` the account would end up with 3 enabled mailboxes.
    await svc.delete(ctxFor(db, acct), a.id);
    await create(db, acct, "three@x.test");

    const err = await refusalOf(meteredSvc(db).update(ctxFor(db, acct), a.id, { status: "connected" }));
    expect(err).toBeInstanceOf(MailboxAllowanceError);
    expect(err!.refusal).toBe("at_limit");
    expect(await countEnabled(db, acct)).toBe(2);
    const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, a.id));
    expect(row!.status).toBe("disabled");   // the refusal rolled the UPDATE back

    // …and with a slot free it goes through, counting itself out of its own check.
    await svc.delete(ctxFor(db, acct), (await db.select().from(mailboxes)
      .where(and(eq(mailboxes.accountId, acct), eq(mailboxes.address, "three@x.test"))))[0]!.id);
    const back = await meteredSvc(db).update(ctxFor(db, acct), a.id, { status: "connected" });
    expect(back.status).toBe("connected");
  });

  it("patching an ALREADY-connected mailbox at the limit consumes no allowance", async () => {
    const db = await makeTestDb();
    const acct = await seedAccount(db);
    seedSub(db, acct, { mailboxLimit: 2 });
    const a = await create(db, acct, "one@x.test");
    await create(db, acct, "two@x.test");

    // Full account. A rename, a credential rotation and a disconnect must all still work — the
    // gate is on the disabled→enabled TRANSITION, not on `update`.
    //
    // This line used to read `{ status: "error" }` and assert it landed. That transition is now
    // REFUSED outright (see `mailbox-failure-state.test.ts`): `error` is the worker's assertion
    // about reachability, not a value a client may post. The allowance property under test here
    // is untouched — a non-enabling transition consumes no allowance — and `disabled` is the
    // one a client can actually reach.
    expect((await svc.update(ctxFor(db, acct), a.id, { displayName: "Renamed" })).displayName).toBe("Renamed");
    // a rotation carries a secret, so it now needs a probe to try it with. The allowance
    // property under test is unchanged; this is the injected seam, not a new assertion.
    expect((await svc.update(ctxFor(db, acct), a.id, { imap: { pass: "rotated" } }, PROBE_OK)).id).toBe(a.id);
    expect((await svc.update(ctxFor(db, acct), a.id, { status: "disabled" })).status).toBe("disabled");
  });

  it("the count is ACCOUNT-SCOPED: another account's mailboxes never consume this plan", async () => {
    const db = await makeTestDb();
    const mine = await seedAccount(db);
    const theirs = await seedAccount(db);
    // One verdict, one LIMIT, two accounts: the count is what has to be per-account, and a
    // shared limit is the sharpest way to say so — their six mailboxes must not spend mine.
    metered({ mailboxes: 10 });
    for (let i = 0; i < 6; i++) await create(db, theirs, `t${i}@x.test`);
    metered({ mailboxes: 2 });

    expect((await create(db, mine, "m1@x.test")).address).toBe("m1@x.test");
    expect((await create(db, mine, "m2@x.test")).address).toBe("m2@x.test");
    expect((await refusalOf(create(db, mine, "m3@x.test")))!.refusal).toBe("at_limit");
  });

  it("the limit is whatever the PORT said, never a number this server holds", async () => {
    const db = await makeTestDb();
    const acct = await seedAccount(db);
    seedSub(db, acct, { mailboxLimit: 4 });   // a figure no table here could have produced
    for (let i = 0; i < 4; i++) await create(db, acct, `g${i}@x.test`);
    const err = await refusalOf(create(db, acct, "g4@x.test"));
    expect(err!.details).toMatchObject({ mailboxLimit: 4, mailboxCount: 4 });
  });

  it("the credential write joins the mailbox in ONE transaction — a create is all or nothing", async () => {
    const db = await makeTestDb();
    const acct = await seedAccount(db);
    seedSub(db, acct, { mailboxLimit: 2 });
    const mb = await create(db, acct, "atomic@x.test");
    const creds = await db.select().from(mailboxCredentials).where(eq(mailboxCredentials.mailboxId, mb.id));
    expect(creds).toHaveLength(1);

    // …and a refusal leaves neither half behind.
    await create(db, acct, "second@x.test");
    const before = (await db.select().from(mailboxCredentials)).length;
    await refusalOf(create(db, acct, "third@x.test"));
    expect((await db.select().from(mailboxCredentials)).length).toBe(before);
  });
});

describe("the paid gate refuses a host that wired no entitlements reader", () => {
  /**
   * The state this refusal makes unrepresentable: a host running the PAID gate whose limit comes
   * from nowhere. An absent reader used to default to "unmetered", which silently removed the plan
   * limit from any host that forgot it — and a paid gate that quietly stopped applying is not a
   * failure anyone notices from the outside. It is the failure `mailbox-allowance-registry.ts`
   * refuses by name one seam over, and it was reachable one seam up.
   */
  it("refuses loudly rather than admitting an unbounded create", async () => {
    const db = await makeTestDb();
    const acct = await seedAccount(db);
    seedSub(db, acct, { mailboxLimit: 1 });
    // The paid gate (the barrel default) with NO `accessOf` — the misconfiguration.
    const unwired = makeMailboxService({ keyProvider: KP });
    const err = await unwired.create(
      ctxFor(db, acct), { provider: "imap", address: "a@x.test", imap: IMAP }, PROBE_OK,
    ).catch((e: unknown) => e as ServiceError);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).httpStatus).toBe(500);
    expect((err as ServiceError).code).toBe("server_error");
    expect((err as ServiceError).message).toMatch(/no entitlements reader is configured/);
    // Nothing was written: the refusal is before the insert, as every allowance refusal is.
    expect(await countEnabled(db, acct)).toBe(0);
  });

  it("…and the ordinary wired host still creates — the positive control", async () => {
    // Without this the case above passes for a gate that refuses every host, wired or not.
    const db = await makeTestDb();
    const acct = await seedAccount(db);
    seedSub(db, acct, { mailboxLimit: 1 });
    const made = await create(db, acct, "ok@x.test");
    expect(made.address).toBe("ok@x.test");
    expect(await countEnabled(db, acct)).toBe(1);
  });

  it("an UNMETERED host is unaffected — its policy never asks", async () => {
    // The distinction the null exists for: a host that MEANS unmetered says so with its policy,
    // and the reader is never consulted, so an absent one cannot refuse it.
    const db = await makeTestDb();
    const acct = await seedAccount(db);
    const free = makeMailboxService({ keyProvider: KP, allowance: async () => {} });
    const made = await free.create(
      ctxFor(db, acct), { provider: "imap", address: "free@x.test", imap: IMAP }, PROBE_OK,
    );
    expect(made.address).toBe("free@x.test");
  });
});

describe("the gate cannot be taken on a top-level handle", () => {
  it("readMailboxAllowance(db, …) throws NotInTransactionError", async () => {
    // Layer 2 of the three-layer contract, applied here: the TYPE refuses a `PgDatabase`,
    // and this catches the `as any` and the JS caller. A `FOR UPDATE` on an autocommit handle
    // releases its lock at the end of its own statement and serializes exactly nothing.
    const db = await makeTestDb();
    const acct = await seedAccount(db);
    await expect(readMailboxAllowance(
      db as never, acct, NOW, { access: UNMETERED_ACCESS },
    )).rejects.toBeInstanceOf(NotInTransactionError);
  });
});
