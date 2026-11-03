import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fixturePassword } from "../../../test/support/fixture-credentials.js";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq } from "drizzle-orm";
import { accountSettings, accounts, mailboxes, mailboxCredentials, UNMETERED_ACCESS, type AccessVerdict } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { StaticKeyProvider } from "@trafficflow/core";
import { makeMailboxService, ServiceError, type ServiceContext } from "@trafficflow/services";

/**
 * ASKING TO ORGANIZE A MAILBOX — under real concurrency.
 *
 * ## What the write means, and why every one of these cases is a way to get it wrong
 *
 * Exactly one active organizer per mailbox, ever. `organizeHere` is the explicit human action that
 * asks for it — it writes CONSENT and a one-shot authorization and NOTHING else, and the worker's
 * gate decides afterwards, in the process that will actually do the organizing.
 *
 * ## MAIL 0083 REWROTE WHAT THIS METHOD IS FOR, and the tests moved with it
 *
 * It used to be `takeover`, and it served ONE case: a mailbox this side had stood down from
 * (`status='disabled'` plus a reason), where the ask was to wrest it back. Two things changed.
 *
 * The LOSER is now a READER — `organizer_role='reader'`, `status` untouched, still syncing — so
 * the old precondition (`disabled` WITH a reason) matches nothing the product writes any more.
 *
 * And there is a SECOND case, which is now the common one: the FIRST consent. `create` makes a
 * consent-less reader, so a freshly connected mailbox is one nobody has asked this install to
 * organize — and the case that used to answer `already_organizing` for a fresh mailbox now
 * answers `authorized`, because that is the truth. A mailbox is `already_organizing` only when it
 * is BOTH an organizer AND consented.
 *
 * The ROLE is deliberately not written by this method: the gate promotes. What it writes is
 * consent (COALESCEd, so re-running onboarding never moves the record of when somebody agreed)
 * and the stamp.
 *
 * ## Why real Postgres
 *
 * PGlite is single-connection and cannot express one transaction blocking on another's row lock,
 * which is the mechanism under test. Two independent pools make the concurrency genuine rather
 * than one driver's queue.
 */
const PG_UP = await realPgAvailable();

const sqlA = postgres(PG_TEST_URL, { max: 10, onnotice: () => {} });
const sqlB = postgres(PG_TEST_URL, { max: 10, onnotice: () => {} });
/** A third session, for the one case that needs a lock HELD while the other two race — see it. */
const sqlC = postgres(PG_TEST_URL, { max: 1, onnotice: () => {} });
const dbA = brandDialect(drizzle(sqlA, { schema }), "pg");
const dbB = brandDialect(drizzle(sqlB, { schema }), "pg");

const NOW = new Date("2026-08-05T12:00:00.000Z");
const sleep = (ms: number): Promise<void> => new Promise<void>((r) => { setTimeout(r, ms); });
const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 9), 1);
/**
 * THE HOST'S OWN ANSWER ABOUT AN ACCOUNT'S STANDING, per account.
 *
 * UNMETERED unless a case says otherwise — `assertMayAddMailbox` refuses a `null` verdict
 * deliberately ("nobody wired a reader" and "this host meters nothing" must not be the same
 * state), and most cases here are about the stand-down rather than the limit. The one that IS
 * about the limit registers a number through `account(n)`, so the gate reads a verdict a host
 * actually gave rather than a row this database no longer has.
 */
const LIMITS = new Map<string, number>();
const svc = makeMailboxService({
  keyProvider: KP,
  accessOf: async (accountId): Promise<AccessVerdict> => {
    const limit = LIMITS.get(accountId);
    return limit === undefined
      ? UNMETERED_ACCESS
      : {
          ok: true,
          limits: { mailboxes: limit, storageBytes: null, canAddMailbox: true, aiEnabled: true },
        };
  },
});

const ctxOn = (db: typeof dbA, accountId: string): ServiceContext =>
  ({ db: db as unknown as ServiceContext["db"], accountId, userId: null, now: () => NOW, requestId: "r" });

const IMAP = { host: "imap.example", port: 993, secure: true, user: "u", pass: fixturePassword("mailbox-takeover") };
/** Always "ok": every case here is about the row, and a probe that could refuse would decide it first. */
const PROBE_OK = { probe: async () => ({ verdict: "ok" as const }) };

/**
 * A RACING CASE'S SIZE, AND WHAT ONE PAIR OF IT MAY COST.
 *
 * Vitest's flat 5 s is a constant over a case whose work is not: each pair is two service calls
 * that serialize on the one account row, so a case costs PAIRS × one pair and its ceiling has to
 * be read the same way. The per-pair figure is the one the deadlock case already chose when it
 * took 30 s for its twelve, kept here as ONE number every racing case reads. Measured on this box
 * at load 2.7: the twelve pairs run in 431 ms, about 8 ms of real work each; the flat 5 s went red
 * at load 13.8 and 12.8 and green at 11.9 — a reading about the box, not about the lock order
 * these cases exist to watch. A BUDGET, never a retry, and it is ASSERTED inside the case as well
 * as handed to vitest, so shrinking it reddens instead of quietly tightening a timeout nothing
 * reads.
 */
const RACING_PAIRS = 12;
const PAIR_BUDGET_MS = 2_500;
const RACING_BUDGET_MS = RACING_PAIRS * PAIR_BUDGET_MS;

beforeAll(async () => { if (PG_UP) await runMigrations(PG_TEST_URL); }, 120_000);
afterAll(async () => {
  await sqlA.end({ timeout: 5 }); await sqlB.end({ timeout: 5 }); await sqlC.end({ timeout: 5 });
});

/**
 * The SQLSTATE a driver error carries, or null. `40P01` is `deadlock_detected`, and it is the whole
 * point of reading it: the racing case below catches every error and asserts about the ROWS, so a
 * transaction Postgres killed to break a lock cycle left no trace in it at all — the pair simply
 * took a second longer and the invariant still held. A control has to see the code.
 */
const pgCode = (e: unknown): string | null => {
  const c = (e as { code?: unknown })?.code ?? (e as { cause?: { code?: unknown } })?.cause?.code;
  return typeof c === "string" ? c : null;
};

describe.skipIf(!PG_UP)("MailboxService.takeover — the explicit action that ends a stand-down", () => {
  /** An account, and the mailbox limit the host answers for it (absent ⇒ unmetered). */
  async function account(mailboxLimit?: number): Promise<string> {
    const [a] = await dbA.insert(accounts).values({ name: `to-${randomUUID().slice(0, 8)}` }).returning();
    if (mailboxLimit !== undefined) LIMITS.set(a!.id, mailboxLimit);
    return a!.id;
  }

  async function mailbox(accountId: string, address?: string): Promise<string> {
    const dto = await svc.create(ctxOn(dbA, accountId), {
      provider: "imap", address: address ?? `to-${randomUUID().slice(0, 8)}@x.test`, imap: IMAP,
    }, PROBE_OK);
    return dto.id;
  }

  /**
   * Exactly what the worker's demotion write does (mail 0083): the ROLE and the four holder
   * columns, `status` untouched. It used to write `disabled` + a reason; a fixture that still did
   * would set up a state nothing produces, and every assertion below would be about a mailbox
   * shape that cannot occur.
   */
  async function standDown(id: string, reason = "organized_elsewhere:local"): Promise<void> {
    await dbA.update(mailboxes)
      .set({
        organizerRole: "reader",
        organizedByKind: reason.split(":")[1] ?? "unknown",
        organizedByName: "somebody's laptop",
        organizedSince: new Date("2026-08-01T00:00:00.000Z"),
        organizerState: "held",
        takeoverAuthorizedAt: null,
      })
      .where(eq(mailboxes.id, id));
  }

  /** A mailbox this install already organizes WITH consent — the state a live account is in. */
  async function organizing(id: string): Promise<void> {
    await dbA.update(mailboxes)
      .set({ organizerRole: "organizer", organizeConsentedAt: NOW, takeoverAuthorizedAt: null })
      .where(eq(mailboxes.id, id));
  }

  const row = async (id: string): Promise<{
    status: string; disabledReason: string | null; stamped: boolean; creds: number;
    role: string; consented: boolean; heldBy: string | null;
  }> => {
    const [m] = await dbA.select().from(mailboxes).where(eq(mailboxes.id, id));
    const creds = await dbA.select().from(mailboxCredentials).where(eq(mailboxCredentials.mailboxId, id));
    return {
      status: m!.status,
      disabledReason: m!.disabledReason,
      stamped: m!.takeoverAuthorizedAt !== null,
      creds: creds.length,
      role: m!.organizerRole,
      consented: m!.organizeConsentedAt !== null,
      heldBy: m!.organizedByName,
    };
  };

  it("a READER is authorized: consent and the stamp are written, and the ROLE is not", async () => {
    const acc = await account();
    const id = await mailbox(acc);
    await standDown(id);

    const result = await svc.organizeHere(ctxOn(dbA, acc), id, { intent: "takeover" });
    expect(result.outcome).toBe("authorized");

    // THE ROLE IS STILL `reader`, and that is the assertion this case exists for. The gate
    // promotes, in the process that will actually organize, after reading the claim in the
    // mailbox. A method that flipped the role here would make a button in a browser the thing
    // that decides who organizes a mailbox, with no reference to what the mailbox says.
    expect(await row(id)).toMatchObject({
      status: "connected", role: "reader", stamped: true, consented: true,
    });
  });

  it("A CONSENT-LESS ORGANIZER is the FIRST-consent case, and it is authorized too", async () => {
    // The case that did not exist before mail 0083. `create` makes a consent-less reader, and a
    // row that is nominally an organizer with no consent recorded is the same question: nobody
    // has asked this install to organize it. Refusing here would leave the ordinary onboarding
    // path — connect, then agree — with no door at all.
    const acc = await account();
    const id = await mailbox(acc);
    await dbA.update(mailboxes)
      .set({ organizerRole: "organizer", organizeConsentedAt: null })
      .where(eq(mailboxes.id, id));

    expect((await svc.organizeHere(ctxOn(dbA, acc), id, { intent: "takeover" })).outcome).toBe("authorized");
    expect(await row(id)).toMatchObject({ stamped: true, consented: true });
  });

  it("CONSENT IS WRITTEN ONCE — a second ask does not move the record of when somebody agreed", async () => {
    // `COALESCE`, and the reason is that this method is reached from onboarding AND from a
    // claim-back months later. A consent instant that slid forward would be a false record of
    // when the person agreed, and it is read as an onboarding truth-condition.
    const acc = await account();
    const id = await mailbox(acc);
    const first = new Date("2026-01-01T00:00:00.000Z");
    await dbA.update(mailboxes)
      .set({ organizerRole: "reader", organizeConsentedAt: first })
      .where(eq(mailboxes.id, id));

    expect((await svc.organizeHere(ctxOn(dbA, acc), id, { intent: "takeover" })).outcome).toBe("authorized");
    const [m] = await dbA.select().from(mailboxes).where(eq(mailboxes.id, id));
    expect(m!.organizeConsentedAt?.toISOString()).toBe(first.toISOString());
  });

  it("THE WINDOW RIDES THE SAME TRANSACTION, and it writes the BASELINE", async () => {
    // The defect this closes is not the window: `screening_baseline_at` is written by the first
    // screener decide and by nothing else, so between consenting and deciding there is NO cutoff
    // and the router holds every unruled sender's mail whatever its date. A person who chose 365
    // days got their whole backlog moved to the Screener anyway.
    const acc = await account();
    const id = await mailbox(acc);
    await standDown(id);

    await svc.organizeHere(ctxOn(dbA, acc), id, { intent: "takeover", screening: { dormancyDays: 365 } });
    const [st] = await dbA.select().from(accountSettings).where(eq(accountSettings.accountId, acc));
    expect(st!.screeningBaselineAt, "consent without a baseline is a window with nothing to measure from")
      .not.toBeNull();
    expect(st!.dormancyDays).toBe(365);
    expect(st!.screeningScope).toBe("window");
  });

  it("`all_time` is stored as a MODE — the dial cannot express it", async () => {
    const acc = await account();
    const id = await mailbox(acc);
    await standDown(id);
    await svc.organizeHere(ctxOn(dbA, acc), id, { intent: "takeover", screening: { scope: "all_time" } });
    const [st] = await dbA.select().from(accountSettings).where(eq(accountSettings.accountId, acc));
    expect(st!.screeningScope).toBe("all_time");
    // `dormancy_days` stays NULL: the product default is never stored, and under `all_time` it
    // decides nothing anyway. Both cutline implementations read the MODE first.
    expect(st!.dormancyDays).toBeNull();
  });

  it("A TOMBSTONE IS REFUSED, NOT REVIVED — and nothing is written", async () => {
    // `disabled` with NO reason is a mailbox the user disconnected, and `delete` also removed its
    // credentials. Converting that into a takeover would bring back a mailbox somebody
    // deliberately removed, without the credential it needs and without the allowance it costs.
    const acc = await account();
    const id = await mailbox(acc);
    await svc.delete(ctxOn(dbA, acc), id);
    const before = await row(id);
    expect(before).toMatchObject({ status: "disabled", disabledReason: null, creds: 0 });

    expect((await svc.organizeHere(ctxOn(dbA, acc), id, { intent: "takeover" })).outcome).toBe("disconnected");
    expect(await row(id)).toEqual(before);
  });

  it("a mailbox this side already organizes WITH CONSENT is a no-op, not a fresh stamp", async () => {
    const acc = await account();
    const id = await mailbox(acc);
    // BOTH terms. A fresh `create` is a consent-less reader, so without this line the case would
    // be the first-consent one above — which is exactly the semantic change mail 0083 made.
    await organizing(id);
    expect((await svc.organizeHere(ctxOn(dbA, acc), id, { intent: "takeover" })).outcome).toBe("already_organizing");
    // A standing authorization is exactly what the one-shot rule forbids: it would be spent months
    // later by whatever re-enabled the row, seizing back a mailbox a human had moved elsewhere.
    expect(await row(id)).toMatchObject({ status: "connected", stamped: false });
  });

  it("a cross-account id is a 404, not a refusal that admits the mailbox exists", async () => {
    const owner = await account();
    const stranger = await account();
    const id = await mailbox(owner);
    await standDown(id);
    const err = await svc.organizeHere(ctxOn(dbB, stranger), id, { intent: "takeover" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).httpStatus).toBe(404);
    expect(await row(id)).toMatchObject({ role: "reader", stamped: false });
  });

  it("TWO CONCURRENT CONFIRMS: exactly one authorizes, and there is exactly one stamp", async () => {
    // The second confirm blocks on the row lock, re-reads a row that is now `connected`, and
    // reports the no-op. Without the lock both would read `disabled` + reason and both would
    // "succeed", which is harmless for the stamp itself and is the shape that becomes a bypass
    // the moment anything is counted on this path — the allowance already is.
    const acc = await account();
    const id = await mailbox(acc);
    await standDown(id);

    const [a, b] = await Promise.all([
      svc.organizeHere(ctxOn(dbA, acc), id, { intent: "takeover" }),
      svc.organizeHere(ctxOn(dbB, acc), id, { intent: "takeover" }),
    ]);
    // BOTH authorize now, and that is CORRECT rather than a weakening. The old assertion rested
    // on the loser re-reading a row that had become `connected`; the role is not written here any
    // more, so the loser re-reads a row that is still a reader with a stamp — and re-stamping an
    // already-stamped reader is idempotent by construction: `COALESCE` fixes the consent, and one
    // stamp is one authorization however many times it is written. What must NOT happen is two
    // becomings, and the gate is what bounds that: it spends the stamp once.
    expect([a.outcome, b.outcome].every((o) => o === "authorized" || o === "already_organizing")).toBe(true);
    expect(await row(id)).toMatchObject({ role: "reader", stamped: true, consented: true });
  });

  it("CONFIRM RACING DELETE, either order, twelve times: never `connected` with no credential", async () => {
    // The forbidden conjunction. A takeover that slipped past a concurrent disconnect would leave
    // a row the worker rosters, authorized to become the organizer of a mailbox it has no password
    // for — and a mailbox the user believes they removed.
    const acc = await account();
    const cases: string[] = [];
    for (let i = 0; i < RACING_PAIRS; i++) {
      const id = await mailbox(acc);
      await standDown(id);
      cases.push(id);
    }

    const started = Date.now();
    await Promise.all(cases.map(async (id, i) => {
      // HALF EACH WAY. Starting the same side first every time only ever exercises the one
      // interleaving the lock already resolves.
      const takeoverFirst = i % 2 === 0;
      const runTakeover = (): Promise<unknown> => svc.organizeHere(ctxOn(dbA, acc), id, { intent: "takeover" }).catch((e: unknown) => e);
      const runDelete = (): Promise<unknown> => svc.delete(ctxOn(dbB, acc), id).catch((e: unknown) => e);
      const first = takeoverFirst ? runTakeover() : runDelete();
      await sleep(15);
      const second = takeoverFirst ? runDelete() : runTakeover();
      await Promise.all([first, second]);
    }));
    const elapsed = Date.now() - started;
    // THE BUDGET, READ RATHER THAN ONLY DECLARED — see {@link RACING_BUDGET_MS}. The case used to
    // carry no ceiling of its own and inherited a flat 5 s, which is what went red on a busy box
    // while the rows it asks about were correct every time.
    expect(elapsed, `${RACING_PAIRS} pairs took ${elapsed} ms`).toBeLessThan(RACING_BUDGET_MS);

    for (const id of cases) {
      const s = await row(id);
      const live = s.status !== "disabled";
      expect(live && s.creds === 0, `mailbox ${id} is ${s.status} with ${s.creds} credentials`).toBe(false);
      // And the stamp never outlives the disconnect: `delete` clears it for the same reason.
      expect(s.status === "disabled" && s.stamped, `${id} is a tombstone carrying an authorization`)
        .toBe(false);
    }
  }, RACING_BUDGET_MS);

  /**
   * THE LOCK ORDER, and the case above cannot see it. Both doors end at the same rows, so both
   * orders satisfy the forbidden conjunction — but `delete` takes `accounts` FIRST (the erasure
   * fence, `FOR SHARE`) and the mailbox second, while `organizeHere` used to take the mailbox
   * first and reach `accounts` at the allowance gate. Opposite orders on one account: the confirm
   * holds the mailbox row and waits for the account row, the disconnect holds the account row and
   * waits for the mailbox row, and Postgres breaks the cycle by killing one of them —
   * `40P01 deadlock detected`, a 500 on a button press. Measured on the case above's own shape:
   * 7 of 12 pairs killed, 5.0 s instead of 35 ms, and GREEN — that case catches every error and
   * asks only about the rows, so a transaction Postgres killed leaves no trace in it.
   *
   * The injected delay is the product's own. A third session holds exactly what the fence holds —
   * `accounts` FOR SHARE — for 300 ms, which is what a disconnect waiting on anything looks like
   * from the other door; without it the two sides are 3 ms apart and the interleaving is rare
   * enough to pass twenty runs out of twenty. With it, 6 of the 12 pairs were killed.
   */
  it("A CONFIRM AND A DISCONNECT NEVER DEADLOCK: the account row is taken first on both", async () => {
    const acc = await account();
    const cases: string[] = [];
    for (let i = 0; i < RACING_PAIRS; i++) {
      const id = await mailbox(acc);
      await standDown(id);
      cases.push(id);
    }

    const faults: string[] = [];
    const note = (e: unknown): unknown => { const c = pgCode(e); if (c) faults.push(c); return e; };

    // Held for a fixed span and then COMMITTED: a hold released only when the race finishes would
    // be a deadlock of the test's own making, and would prove nothing about the product's order.
    const holding = sqlC.begin(async (tx) => {
      await tx`select erased_at from accounts where id = ${acc} for share`;
      await sleep(300);
    });
    await sleep(40); // the hold is established before the pairs start

    const started = Date.now();
    await Promise.all(cases.map(async (id, i) => {
      const takeoverFirst = i % 2 === 0;
      const runTakeover = (): Promise<unknown> =>
        svc.organizeHere(ctxOn(dbA, acc), id, { intent: "takeover" }).catch(note);
      const runDelete = (): Promise<unknown> => svc.delete(ctxOn(dbB, acc), id).catch(note);
      const first = takeoverFirst ? runTakeover() : runDelete();
      await sleep(15);
      const second = takeoverFirst ? runDelete() : runTakeover();
      await Promise.all([first, second]);
    }));
    const elapsed = Date.now() - started;
    await holding;

    expect(faults, "a lock cycle between two doors of one account").toEqual([]);
    // THE BOUND, and its origin: the hold is a fraction of a second and the twelve pairs then serialize on the
    // account row, measured over twenty runs under load. Four seconds is
    // twelve times that — loose, because the assertion above is the one that decides and this one
    // only has to catch the other way of satisfying it: an order that no longer cycles because
    // every pair now waits a whole `deadlock_timeout` (1 s by default) for its turn.
    expect(elapsed, `twelve pairs took ${elapsed} ms`).toBeLessThan(4000);

    // And the conjunction the case above exists for still holds, under the same interleavings.
    for (const id of cases) {
      const st = await row(id);
      expect(st.status !== "disabled" && st.creds === 0, `mailbox ${id} is ${st.status} with ${st.creds} credentials`)
        .toBe(false);
    }
  }, RACING_BUDGET_MS);

  it("THE ALLOWANCE GATE APPLIES — a takeover past the limit is refused", async () => {
    // `reader → organizer` IS a connection whichever door it comes through. This door is cheaper
    // to reach than the PATCH: a user can cause a stand-down at will by pointing a second install
    // at their own mailbox, so an ungated takeover would let them mint the free slot.
    //
    // THE LIMIT TIGHTENS AFTER BOTH MAILBOXES EXIST, which is the state this door has to refuse
    // and the only way to reach it: the two creates go through the same gate, so an account whose
    // host answered `1` from the start could never have got the second mailbox. A limit that
    // moved down under a live account is an ordinary thing for a host to answer.
    const acc = await account();
    const held = await mailbox(acc);
    const target = await mailbox(acc);
    await standDown(target);
    LIMITS.set(acc, 1);

    const err = await svc.organizeHere(ctxOn(dbA, acc), target, { intent: "takeover" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe("mailbox_limit_reached");
    expect((err as ServiceError).httpStatus).toBe(409);
    // Refused BEFORE the write, so the row is untouched and the stamp was never spent.
    expect(await row(target)).toMatchObject({ status: "connected", role: "reader", stamped: false });
    expect(await row(held)).toMatchObject({ status: "connected" });
  });

  /**
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *  THE RELEASE (mail 0088) — "stop organizing this mailbox, keep my mail"
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *
   * The mirror of `organizeHere`, and it belongs in THIS file rather than beside the gate for the
   * reason the header gives: PGlite is single-connection and cannot express one transaction
   * blocking on another's row lock, which is the only mechanism that orders these two opposite
   * instructions about one mailbox.
   *
   * What it writes is one timestamp. What the WORKER does with it — release the claim, demote the
   * row, close the appointments — is asserted on both hosts' own rigs; the concurrency is here.
   */
  it("a RELEASE writes the request and NOTHING else — the gate does the ceasing", async () => {
    const acc = await account();
    const id = await mailbox(acc);
    await organizing(id);

    const result = await svc.release(ctxOn(dbA, acc), id);
    expect(result.outcome).toBe("requested");

    const [m] = await dbA.select().from(mailboxes).where(eq(mailboxes.id, id));
    expect(m!.releaseRequestedAt).not.toBeNull();
    // THE ROLE IS UNTOUCHED, and that is the assertion this case exists for. The claim is in the
    // customer's IMAP folder; expunging it is the organizer's own next pass. A row demoted here
    // would deny a claim that is still standing, and every other install reading that folder would
    // go on standing down behind it.
    expect(m!.organizerRole).toBe("organizer");
    expect(m!.status).toBe("connected");
    // Nothing about the mailbox's identity moves: this is not a disconnect.
    const creds = await dbA.select().from(mailboxCredentials).where(eq(mailboxCredentials.mailboxId, id));
    expect(creds).toHaveLength(1);
    expect(m!.organizeConsentedAt).not.toBeNull();
  });

  it("a mailbox this install does not organize is a NO-OP, not a refusal", async () => {
    const acc = await account();
    const id = await mailbox(acc);
    await standDown(id);

    // The person's intent — "do not organize this here" — is already true, and there is nothing a
    // 409 could tell them to do differently. It is also where a SECOND press lands, since the
    // first one's gate demotes the row within a cycle.
    expect(await svc.release(ctxOn(dbA, acc), id)).toEqual({ outcome: "not_organizing" });
    const [m] = await dbA.select().from(mailboxes).where(eq(mailboxes.id, id));
    expect(m!.releaseRequestedAt, "a no-op wrote a request anyway").toBeNull();
  });

  it("a REMOVED mailbox is refused rather than revived", async () => {
    const acc = await account();
    const id = await mailbox(acc);
    await organizing(id);
    await svc.delete(ctxOn(dbA, acc), id);

    // `organizeHere`'s argument in the other direction: a removed mailbox has no organizing to
    // stop, and answering anything else would be a lie in the reassuring direction.
    expect(await svc.release(ctxOn(dbA, acc), id)).toEqual({ outcome: "disconnected" });
  });

  /**
   * ── CHANGING YOUR MIND CANCELS THE RELEASE (review finding, mail 0088) ────────────────────
   *
   * `release` deliberately leaves the row an `organizer` with its consent intact — the GATE
   * demotes, because the claim is in the customer's IMAP folder. That is byte-for-byte the shape
   * `organizeHere`'s precondition reads as "already organizing", so before this was fixed the
   * sequence below answered 200 `already_organizing`, wrote no stamp, and released the mailbox a
   * minute later anyway: the person is told the opposite of what happens, and no number of presses
   * helps, because every one of them lands on the same row.
   *
   * The row lock is not the answer to this one. It orders WRITES against each other; the failure
   * here is a press that writes nothing at all.
   */
  it("a claim-back CANCELS a pending release rather than answering already_organizing", async () => {
    const acc = await account();
    const id = await mailbox(acc);
    await organizing(id);

    expect((await svc.release(ctxOn(dbA, acc), id)).outcome).toBe("requested");
    // Two seconds later, they change their mind.
    const back = await svc.organizeHere(ctxOn(dbA, acc), id, { intent: "takeover" });
    expect(back.outcome,
      "the second press was answered as a no-op, and the gate releases the mailbox anyway")
      .toBe("authorized");

    const [m] = await dbA.select().from(mailboxes).where(eq(mailboxes.id, id));
    expect(m!.releaseRequestedAt,
      "the request stands, and the gate honours it FIRST — so the press is discarded").toBeNull();
    expect(m!.takeoverAuthorizedAt).not.toBeNull();
    expect(m!.organizerReleasedAt).toBeNull();
  });

  /**
   * ── THE RELEASE RACING THE CLAIM-BACK, ON TWO CONNECTIONS ─────────────────────────────────
   *
   * Two opposite instructions about one mailbox, issued at the same instant from two doors — the
   * browser tab that says "stop organizing here" and the desktop that says "organize here
   * instead". Both take `FOR UPDATE` on the same row in the same order, so they serialize; what
   * this case pins is that the row they leave behind carries AT MOST ONE live instruction.
   *
   * Both stamps standing at once is the state that matters, and it is not merely untidy: the
   * gate honours the release FIRST, so a row carrying both would silently discard a press the
   * person had just been told succeeded. `markMailboxReleased` clears the takeover stamp for the
   * same pair — belt to this brace — and the assertion below is written against the ROW so that a
   * regression in either mechanism is red.
   */
  it("a release racing a claim-back leaves at most one live instruction", async () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const acc = await account();
      const id = await mailbox(acc);
      await organizing(id);

      const [release, organize] = await Promise.allSettled([
        svc.release(ctxOn(dbA, acc), id),
        (async () => { await sleep(1); return svc.organizeHere(ctxOn(dbB, acc), id, { intent: "takeover" }); })(),
      ]);
      expect(release.status, "the release threw under contention").toBe("fulfilled");
      expect(organize.status, "the claim-back threw under contention").toBe("fulfilled");

      const [m] = await dbA.select().from(mailboxes).where(eq(mailboxes.id, id));
      const both = m!.releaseRequestedAt !== null && m!.takeoverAuthorizedAt !== null;
      expect(both,
        "the row carries a release request AND a takeover authorization — the gate honours the "
        + "release first, so the press the person was told succeeded is silently discarded")
        .toBe(false);
      // Whichever order won, the row is still a live mailbox with its credentials. Neither door
      // may turn into a disconnect under contention.
      expect(m!.status).toBe("connected");
      const creds = await dbA.select().from(mailboxCredentials).where(eq(mailboxCredentials.mailboxId, id));
      expect(creds).toHaveLength(1);
    }
  }, 60_000);

  /**
   * ── THE RELEASE RACING THE DISCONNECT ─────────────────────────────────────────────────────
   *
   * `organizeHere` takes the same lock against `delete` for a stated reason: without it both can
   * read the row and commit in either order, and the losing order leaves a mailbox that is
   * authorized to organize and has had its credentials deleted. The release has the mirror hazard
   * and it is worse in one respect — the request is honoured by a BACKGROUND pass rather than by
   * the request that wrote it, so a tombstone carrying one would be acted on by the worker minutes
   * later against a row the person removed.
   */
  it("a release racing a disconnect never leaves a tombstone carrying a request", async () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const acc = await account();
      const id = await mailbox(acc);
      await organizing(id);

      const [release, removed] = await Promise.allSettled([
        svc.release(ctxOn(dbA, acc), id),
        (async () => { await sleep(1); return svc.delete(ctxOn(dbB, acc), id); })(),
      ]);
      expect(release.status, "the release threw against a concurrent disconnect").toBe("fulfilled");
      expect(removed.status, "the disconnect threw against a concurrent release").toBe("fulfilled");

      const [m] = await dbA.select().from(mailboxes).where(eq(mailboxes.id, id));
      expect(m!.status === "disabled" && m!.releaseRequestedAt !== null,
        `${id} is a tombstone carrying a release request — a background pass will act on a mailbox `
        + "the person removed").toBe(false);
      // The disconnect's own invariant, restated here because this race is a new way to break it:
      // a LIVE mailbox always has its credentials.
      const creds = await dbA.select().from(mailboxCredentials).where(eq(mailboxCredentials.mailboxId, id));
      expect(m!.status !== "disabled" && creds.length === 0,
        `${id} is live with no credentials`).toBe(false);
    }
  }, 60_000);

  it("A DEMOTED MAILBOX KEEPS ITS ADDRESS SLOT — the duplicate this used to race is unreachable", async () => {
    // THE HAZARD THIS CASE USED TO COVER IS GONE, and the reason is worth pinning rather than
    // deleting. `mailboxes_active_address_uq` is UNIQUE on `(account_id, lower(address))` WHERE
    // `status <> 'disabled'`. A stood-down mailbox WAS `disabled`, so nothing stopped the same
    // address being connected again beside it — and taking the old row over then moved it back to
    // `connected` and raised 23505 against the index.
    //
    // A reader is `connected`, so it holds its slot: the SECOND add is refused at `create`, which
    // is both earlier and a better sentence. The migration's own backfill carries a `NOT EXISTS`
    // guard for the rows that reached 0083 in the old shape.
    const acc = await account();
    const address = `dup-${randomUUID().slice(0, 8)}@x.test`;
    const old = await mailbox(acc, address);
    await standDown(old);

    const err = await mailbox(acc, address).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe("mailbox_exists");
    // …and the reader is untouched by the refusal.
    expect(await row(old)).toMatchObject({ status: "connected", role: "reader" });
  });

  /* ── A MAILBOX THE WALL PAUSED (mail 0135) ─────────────────────────────────────────────────
   * The reopening resumes a marked reader on its own. Every press the person makes on it is a
   * newer word than the wall's, so each one ends the marker: Organize here is the stamp itself,
   * Stop keeps it from resuming, and a removed mailbox resumes nothing. */
  async function pausedByTheWall(id: string): Promise<void> {
    await dbA.update(mailboxes)
      .set({
        organizerRole: "reader", organizeConsentedAt: NOW, organizerReleasedAt: NOW,
        organizerParkedAt: NOW, organizedByKind: null, organizerState: null, takeoverAuthorizedAt: null,
      })
      .where(eq(mailboxes.id, id));
  }
  const parkedAt = async (id: string): Promise<Date | null> =>
    (await dbA.select({ at: mailboxes.organizerParkedAt }).from(mailboxes).where(eq(mailboxes.id, id)))[0]!.at;

  it("the wall's marker goes with every press: Organize here, Stop, and removing the mailbox", async () => {
    const acc = await account();
    const pressed = await mailbox(acc);
    await pausedByTheWall(pressed);
    expect((await svc.organizeHere(ctxOn(dbA, acc), pressed, { intent: "takeover" })).outcome).toBe("authorized");
    expect(await parkedAt(pressed), "the press is the stamp now").toBeNull();

    const stopped = await mailbox(acc);
    await pausedByTheWall(stopped);
    expect(await svc.release(ctxOn(dbA, acc), stopped)).toEqual({ outcome: "not_organizing" });
    expect(await parkedAt(stopped), "a Stop on a paused mailbox keeps it from resuming").toBeNull();

    const removed = await mailbox(acc);
    await pausedByTheWall(removed);
    await svc.delete(ctxOn(dbA, acc), removed);
    expect(await parkedAt(removed), "nothing resumes a removed mailbox").toBeNull();
  });
});
