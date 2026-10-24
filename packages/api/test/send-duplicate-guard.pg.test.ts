import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  accounts, users, sessions, mailboxes, drafts, outboundSends, outboundSendFingerprints,
  pruneSendFingerprints, SEND_FINGERPRINT_RETENTION_MS,
} from "@trafficflow/db";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import type { OpenSendAdapter, OutboundMessage } from "@trafficflow/core";
import {
  hashToken, generateToken, makeTestAuthDeps, makeAuthService,
  syncService, pushService, makeMailboxService, rulesService, messageService, threadService,
  makeScreenerService, makeApprovalService, triageService, searchService, makePrivacyService,
  contactsService, snippetsService, notifyRulesService, awayResponderService, attachmentsService,
  kbService, tagsService, draftsService, draftingService, sendService, workflowsService, proposalsService,
  sendContentFingerprint, SEND_DUPLICATE_WINDOW_MS,
  type Db,
} from "@trafficflow/services";

/**
 * THE DUPLICATE-SEND GUARD, AGAINST REAL POSTGRES — the assertions PGlite cannot host.
 *
 * The send path's older defences are keyed on things the CLIENT owns or on ONE draft row:
 * `UNIQUE (account_id, idempotency_key)` and the reserve transaction's refusal of any draft not in
 * `draft` status. A client that mints a fresh key AND composes a fresh draft holding the same
 * message collides with neither, and the recipient gets two copies of a message nobody can recall.
 * A reinstall, a second device, a cleared browser store or an older build all reach that state.
 *
 * The guard is the account's claim on the message's CONTENT. What has to be true of it, and why
 * each half needs a real database:
 *
 *   · THE REFUSAL IS A ROLLBACK. A refused second send must leave its draft in `draft` and no
 *     reservation row behind. PGlite is green either way — it never has to perform the rollback
 *     the hosted database performs, which is the same argument the disabled-mailbox check makes
 *     in `send-service.ts`.
 *   · THE LOSER LOSES AT THE INDEX. Two simultaneous sends of one message must produce ONE
 *     submission, and the arbitration is Postgres blocking the second `INSERT … ON CONFLICT DO
 *     NOTHING` on the unique index until the first commits. PGlite is one connection, so that
 *     interleaving is unreachable there.
 *
 * EVERY CASE DRIVES `app.handle`, never `sendService.send`. A refusal is only as real as the
 * pipeline the route runs, and the route is what a person's client talks to.
 *
 * The assertion throughout is `state.sendCalls` — the number of SMTP submissions. A row count is a
 * proxy; the submission is the harm.
 */
const PG_UP = await realPgAvailable();

const FIXED_NOW = new Date("2026-07-28T12:00:00.000Z");

/** Fake send adapter + spy: counts `send` calls. `messageInSent` false ⇒ ambiguous outcomes. */
function fakeAdapter(opts: { inSent?: boolean; failFirst?: boolean } = {}) {
  const state = { sendCalls: 0, refusedOnce: false };
  const factory: OpenSendAdapter = async () => {
    if (opts.failFirst && !state.refusedOnce) {
      // A DEFINITE NON-DELIVERY, and it has to be the FACTORY that refuses rather than `send`
      // throwing. A throw from `send` means the envelope may already have reached the server, so
      // the fate is UNKNOWN and the reservation ends `unverified` — the state that must NOT
      // reclaim, because something may be in the recipient's inbox. Only a refusal from BEFORE any
      // socket exists finalizes `failed` and returns the draft to `draft`, which is the state the
      // reclaim arm is for. A double that failed at the wrong point would have measured the
      // fixture: the first version of this threw from `send` and the case read 200 `unverified`.
      state.refusedOnce = true;
      throw new Error("no route to the submission server");
    }
    return {
      async send(msg: OutboundMessage) {
        state.sendCalls += 1;
        return { providerMessageId: msg.messageId! };
      },
      async messageInSent() { return opts.inSent ?? false; },
      async close() { /* no-op */ },
    };
  };
  return { factory, state };
}

/** A real-Postgres `ApiDeps` on its OWN connection — two of these is what makes the race real. */
function depsOn(db: Db, sendAdapter: OpenSendAdapter, now: () => Date = () => FIXED_NOW): ApiDeps {
  const authDeps = makeTestAuthDeps({});
  return {
    db,
    now,
    requestId: `dup-${randomUUID()}`,
    session: null,
    authConfig: authDeps.config,
    keyProvider: authDeps.keyProvider,
    services: {
      auth: makeAuthService(authDeps),
      sync: syncService,
      push: pushService,
      mailbox: makeMailboxService({ keyProvider: authDeps.keyProvider }),
      rules: rulesService,
      message: messageService,
      thread: threadService,
      screener: makeScreenerService({}),
      approval: makeApprovalService({}),
      triage: triageService,
      search: searchService,
      privacy: makePrivacyService({
        remote: { async fetch() { return { status: 200, contentType: "image/gif", body: new Uint8Array() }; } },
        resolver: { async resolve() { return ["93.184.216.34"]; } },
      }),
      contacts: contactsService,
      snippets: snippetsService,
      notify: notifyRulesService,
      away: awayResponderService,
      attachments: attachmentsService,
      kb: kbService,
      tags: tagsService,
      drafts: draftsService,
      drafting: draftingService,
      sends: sendService,
      workflows: workflowsService,
      proposals: proposalsService,
      sendAdapter,
    },
  } as unknown as ApiDeps;
}

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> =>
  app.handle(r, { ...d, session: null, idempotency: null } as ApiDeps);

function sendReq(draftId: string, o: { bearer: string; key: string }): Request {
  return new Request(`http://localhost/drafts/${draftId}/send`, {
    method: "POST",
    headers: { authorization: `Bearer ${o.bearer}`, "idempotency-key": o.key },
  });
}

const TO = [{ name: null, address: "you@example.com" }];

describe.skipIf(!PG_UP)("the duplicate-send guard against real Postgres", () => {
  let ownedA: OwnedDb;
  let ownedB: OwnedDb;
  let ownedC: OwnedDb;      // the BARRIER connection — see `race()`
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

  async function seed(): Promise<{ token: string; accountId: string; mailboxId: string }> {
    const token = generateToken();
    const [acct] = await dbA.insert(accounts).values({ name: `dup-${randomUUID()}` }).returning();
    const [user] = await dbA.insert(users).values({
      accountId: acct!.id, email: `d-${randomUUID()}@example.com`, displayName: "D",
      emailVerifiedAt: FIXED_NOW,
    }).returning();
    await dbA.insert(sessions).values({
      accountId: acct!.id, userId: user!.id, familyId: randomUUID(),
      accessTokenHash: hashToken(token),
      // THIRTY DAYS, and the reason is the window case below: it advances the REQUEST CLOCK past
      // `SEND_DUPLICATE_WINDOW_MS` to prove the claim expires, and an hour-long session would
      // expire with it — answering 401 to a case about duplicate sends, which reads as the guard
      // refusing when it is the fixture logging the caller out.
      accessExpiresAt: new Date(FIXED_NOW.getTime() + 30 * 24 * 3_600_000),
      refreshExpiresAt: new Date(FIXED_NOW.getTime() + 31 * 24 * 3_600_000),
    });
    const [mb] = await dbA.insert(mailboxes).values({
      accountId: acct!.id, address: `dup-${randomUUID()}@example.com`, provider: "imap",
      status: "active",
    } as never).returning();
    return { token, accountId: acct!.id, mailboxId: mb!.id };
  }

  async function seedDraft(
    accountId: string, mailboxId: string, over: Record<string, unknown> = {},
  ): Promise<string> {
    const [d] = await dbA.insert(drafts).values({
      accountId, mailboxId, subject: "Re: hi", body: "Thanks!", to: TO, status: "draft", ...over,
    } as never).returning();
    return d!.id;
  }

  it("a SECOND DRAFT with the same content and a FRESH key → 409, ONE submission, and a full rollback", async () => {
    const { factory, state } = fakeAdapter({ inSent: true });
    const deps = depsOn(dbA, factory);
    const { token, accountId, mailboxId } = await seed();

    const first = await seedDraft(accountId, mailboxId);
    const one = await H(sendReq(first, { bearer: token, key: `k1-${randomUUID()}` }), deps);
    // The body rides the assertion: a bare "expected 500 to be 200" from a route test says nothing
    // about whether the fixture or the product is wrong, and that is the one thing worth knowing.
    expect(one.status, await one.clone().text()).toBe(200);
    expect(state.sendCalls).toBe(1);

    const second = await seedDraft(accountId, mailboxId);
    const two = await H(sendReq(second, { bearer: token, key: `k2-${randomUUID()}` }), deps);

    expect(two.status).toBe(409);
    const body = await two.json();
    expect(body.error.code).toBe("duplicate_send");
    expect(body.error.retryable).toBe(false);
    expect(body.error.details.firstSend.status).toBe("sent");
    expect(state.sendCalls).toBe(1);

    // THE ROLLBACK, which is the half PGlite cannot see.
    const [d2] = await dbA.select().from(drafts).where(eq(drafts.id, second));
    expect(d2!.status).toBe("draft");
    const reservations = await dbA.select().from(outboundSends)
      .where(eq(outboundSends.draftId, second));
    expect(reservations.length).toBe(0);
    // ONE claim, re-pointed rather than duplicated.
    const claims = await dbA.select().from(outboundSendFingerprints)
      .where(eq(outboundSendFingerprints.accountId, accountId));
    expect(claims.length).toBe(1);
  });

  it("POSITIVE CONTROL — an edited message is ADMITTED, proved by the second submission", async () => {
    const { factory, state } = fakeAdapter({ inSent: true });
    const deps = depsOn(dbA, factory);
    const { token, accountId, mailboxId } = await seed();

    expect((await H(sendReq(await seedDraft(accountId, mailboxId), {
      bearer: token, key: `e1-${randomUUID()}`,
    }), deps)).status).toBe(200);

    const edited = await seedDraft(accountId, mailboxId, { body: "Thanks!!" });
    expect((await H(sendReq(edited, { bearer: token, key: `e2-${randomUUID()}` }), deps)).status).toBe(200);
    expect(state.sendCalls).toBe(2);
  });

  it("PAST THE WINDOW the identical message sends again — and NO prune runs", async () => {
    // The window is compared against the REQUEST CLOCK inside the reserve transaction. This case
    // advances only that clock and deliberately runs no sweep: a guard that needed the worker's
    // prune to expire would be unbounded on a standalone install, which has no maintenance pass at
    // all, and this is the case that would stay green while that was true.
    const { factory, state } = fakeAdapter({ inSent: true });
    const { token, accountId, mailboxId } = await seed();

    expect((await H(sendReq(await seedDraft(accountId, mailboxId), {
      bearer: token, key: `w1-${randomUUID()}`,
    }), depsOn(dbA, factory))).status).toBe(200);

    const later = new Date(FIXED_NOW.getTime() + SEND_DUPLICATE_WINDOW_MS + 1_000);
    const second = await seedDraft(accountId, mailboxId);
    const res = await H(sendReq(second, { bearer: token, key: `w2-${randomUUID()}` }),
      depsOn(dbA, factory, () => later));

    expect(res.status).toBe(200);
    expect(state.sendCalls).toBe(2);
    // RE-POINTED, not a second row: one claim per piece of content.
    const claims = await dbA.select().from(outboundSendFingerprints)
      .where(eq(outboundSendFingerprints.accountId, accountId));
    expect(claims.length).toBe(1);
    expect(claims[0]!.createdAt.getTime()).toBe(later.getTime());
  });

  it("THE SAME DRAFT, UNEDITED, AFTER A DEFINITE FAILURE still sends — the ordinary retry", async () => {
    // The case a content guard breaks by construction if nobody thinks of it: the mail server was
    // down, the reservation was finalized `failed`, the draft went back to `draft`, and the person
    // presses Send again on exactly the same words. Its own claim must not refuse it.
    const { factory, state } = fakeAdapter({ inSent: true, failFirst: true });
    const deps = depsOn(dbA, factory);
    const { token, accountId, mailboxId } = await seed();
    const draftId = await seedDraft(accountId, mailboxId);

    const one = await H(sendReq(draftId, { bearer: token, key: `f1-${randomUUID()}` }), deps);
    expect(one.status, await one.clone().text()).toBeGreaterThanOrEqual(400);
    expect(state.sendCalls).toBe(0);
    const [afterFail] = await dbA.select().from(drafts).where(eq(drafts.id, draftId));
    expect(afterFail!.status, "the pre-SMTP window returns the draft to `draft`").toBe("draft");
    // The RESERVATION's own word, and it is what the reclaim branches on. Asserting the draft
    // status alone would pass for `unverified` too, which must never reclaim.
    const [res1] = await dbA.select().from(outboundSends).where(eq(outboundSends.draftId, draftId));
    expect(res1!.status, "a definite non-delivery is `failed`, never `unverified`").toBe("failed");

    const two = await H(sendReq(draftId, { bearer: token, key: `f2-${randomUUID()}` }), deps);
    expect(two.status).toBe(200);
    expect(state.sendCalls, "the retry after a definite non-delivery REACHES SMTP").toBe(1);
  });

  it("THE PRUNE deletes spent claims and leaves live ones — hygiene, and only hygiene", async () => {
    // Asserted separately from the window because they are different mechanisms with different
    // jobs, and conflating them is how a guard ends up depending on a sweep that never runs on a
    // standalone install. The window case above proves expiry works with NO prune; this proves the
    // prune removes what the window has already stopped caring about.
    const { factory } = fakeAdapter({ inSent: true });
    const { token, accountId, mailboxId } = await seed();
    expect((await H(sendReq(await seedDraft(accountId, mailboxId), {
      bearer: token, key: `p1-${randomUUID()}`,
    }), depsOn(dbA, factory))).status).toBe(200);

    const mine = () => dbA.select().from(outboundSendFingerprints)
      .where(eq(outboundSendFingerprints.accountId, accountId));
    expect(await mine()).toHaveLength(1);

    // Just inside the retention horizon: kept.
    await pruneSendFingerprints(
      dbA as never,
      new Date(FIXED_NOW.getTime() + SEND_FINGERPRINT_RETENTION_MS - 1_000),
    );
    expect(await mine(), "a claim inside the retention horizon is kept").toHaveLength(1);

    // Past it: gone.
    const gone = await pruneSendFingerprints(
      dbA as never,
      new Date(FIXED_NOW.getTime() + SEND_FINGERPRINT_RETENTION_MS + 1_000),
    );
    expect(gone).toBeGreaterThanOrEqual(1);
    expect(await mine()).toHaveLength(0);
  });

  it("A HELD SEND'S CLAIM SURVIVES THE PRUNE, so Send again a day later still proves its message", async () => {
    const state = { sendCalls: 0 };
    const factory: OpenSendAdapter = async () => ({
      async send(msg: OutboundMessage) {
        state.sendCalls += 1;
        // The first is taken and its answer lost; the press again is answered.
        if (state.sendCalls === 1) throw Object.assign(new Error("Timeout"), { code: "ETIMEDOUT" });
        return { providerMessageId: msg.messageId! };
      },
      async messageInSent() { return false; },
      async close() { /* no-op */ },
    });
    const { token, accountId, mailboxId } = await seed();
    const draftId = await seedDraft(accountId, mailboxId);
    const held = await H(sendReq(draftId, { bearer: token, key: `h1-${randomUUID()}` }), depsOn(dbA, factory));
    expect((await held.json()).status).toBe("unverified");

    const dayLater = new Date(FIXED_NOW.getTime() + SEND_FINGERPRINT_RETENTION_MS + 3_600_000);
    await pruneSendFingerprints(dbA as never, dayLater);
    const claims = await dbA.select().from(outboundSendFingerprints).where(eq(outboundSendFingerprints.accountId, accountId));
    expect(claims, "the held send's claim is kept").toHaveLength(1);

    const again = await H(new Request(`http://localhost/drafts/${draftId}/send`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": `h2-${randomUUID()}`, "content-type": "application/json" },
      body: JSON.stringify({ again: true }),
    }), depsOn(dbA, factory, () => dayLater));
    expect(again.status, await again.clone().text()).toBe(200);
    expect(state.sendCalls).toBe(2);
    const rows = await dbA.select().from(outboundSends).where(eq(outboundSends.draftId, draftId));
    expect(new Set(rows.map((r) => r.mintedMessageId)).size, "one message, two attempts").toBe(1);
  });

  it("TWO REQUESTS IN FLIGHT on two physical connections → one 200, one 409, ONE submission", async () => {
    const { factory, state } = fakeAdapter({ inSent: true });
    const depsA = depsOn(dbA, factory);
    const depsB = depsOn(dbB, factory);
    const { token, accountId, mailboxId } = await seed();

    // Two DIFFERENT drafts holding the SAME message — the measured shape, and the one where
    // neither older defence applies.
    const draftA = await seedDraft(accountId, mailboxId);
    const draftB = await seedDraft(accountId, mailboxId);

    /**
     * The barrier makes the interleaving deterministic. `Promise.all` alone is not enough on
     * localhost Postgres: the first request can finish before the second reaches the claim, and
     * then the second is an ordinary sequential refusal — the happy path, not the race.
     *
     * A third connection inserts the very claim row inside an open transaction and holds it. The
     * row is invisible to both requests, so both reach their own `INSERT … ON CONFLICT DO NOTHING`
     * and BLOCK on the unique index. We assert both are still unsettled — which is also what makes
     * the digest computed here load-bearing rather than decorative: a wrong fingerprint would not
     * collide, both requests would sail through, and this assertion fails loudly.
     *
     * Then the barrier ROLLS BACK. Both unblock, one insert wins, and the loser must block again on
     * the winner's uncommitted tuple, re-read after it commits, and refuse.
     */
    // The digest's members moved after a review round (html and body are separate; attachments
    // carry a content digest), and this barrier must be computed with the CURRENT shape or it
    // collides with nothing. It fails closed if it drifts again: a barrier that does not collide
    // means neither request blocks, and the `settled` assertion below refuses the case rather than
    // letting it pass as a race that never happened.
    const fingerprint = sendContentFingerprint({
      to: TO, cc: [], bcc: [],
      subject: "Re: hi", html: null, body: "Thanks!",
      inReplyToMessageId: null, forwardOf: null, sendAt: null, attachments: [],
    });
    const [ballast] = await (ownedC.db as unknown as Db).insert(outboundSends).values({
      accountId, idempotencyKey: `barrier-${randomUUID()}`, draftId: draftA,
      mintedMessageId: "<barrier@example.com>", status: "failed", createdAt: FIXED_NOW,
    }).returning();

    let releaseBarrier!: () => void;
    const held = new Promise<void>((r) => { releaseBarrier = r; });
    let inserted!: () => void;
    const barrierReady = new Promise<void>((r) => { inserted = r; });

    const barrier = (ownedC.db as unknown as Db).transaction(async (tx) => {
      await tx.insert(outboundSendFingerprints).values({
        accountId, mailboxId, fingerprint, sendId: ballast!.id, createdAt: FIXED_NOW,
      });
      inserted();
      await held;
      throw new Error("BARRIER_ROLLBACK");        // rollback: the row never existed
    }).catch(() => { /* the rollback IS the mechanism */ });

    await barrierReady;

    const settled = [false, false];
    const inFlight = [
      H(sendReq(draftA, { bearer: token, key: `r1-${randomUUID()}` }), depsA)
        .then((r) => { settled[0] = true; return r; }),
      H(sendReq(draftB, { bearer: token, key: `r2-${randomUUID()}` }), depsB)
        .then((r) => { settled[1] = true; return r; }),
    ];

    await new Promise((r) => setTimeout(r, 400));
    expect(settled, "both requests must be blocked on the content claim, i.e. genuinely concurrent")
      .toEqual([false, false]);

    releaseBarrier();
    await barrier;
    const [resA, resB] = await Promise.all(inFlight);

    const codes = [resA!.status, resB!.status].sort();
    expect(codes).toEqual([200, 409]);
    expect(state.sendCalls, "exactly one submission reached the mail server").toBe(1);

    const loserDraft = resA!.status === 409 ? draftA : draftB;
    const [loser] = await dbA.select().from(drafts).where(eq(drafts.id, loserDraft));
    expect(loser!.status, "the loser rolled back and its draft is still sendable").toBe("draft");
    const loserReservations = await dbA.select().from(outboundSends).where(and(
      eq(outboundSends.draftId, loserDraft), eq(outboundSends.status, "pending"),
    ));
    expect(loserReservations.length).toBe(0);

    const claims = await dbA.select().from(outboundSendFingerprints)
      .where(eq(outboundSendFingerprints.accountId, accountId));
    expect(claims.length, "one claim, held by the winner").toBe(1);
  });
});
