import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { accounts, users, sessions, workflows, workflowRuns, idempotencyKeys, changeLog, messages, folderState, mailboxes } from "@trafficflow/db";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import {
  hashToken, generateToken, makeTestAuthDeps, makeAuthService,
  syncService, pushService, makeMailboxService, rulesService, messageService, threadService,
  makeScreenerService, makeApprovalService, triageService, searchService, makePrivacyService,
  contactsService, snippetsService, notifyRulesService, awayResponderService, attachmentsService,
  kbService, tagsService, draftsService, draftingService, sendService, workflowsService, proposalsService,
  type Db,
} from "@trafficflow/services";

/**
 * CONCURRENT IDEMPOTENCY — the assertion PGlite cannot host, and the one that was missing.
 *
 * `withIdempotency` looks the key up in AUTOCOMMIT, before any transaction opens. Two
 * simultaneous requests carrying the same `Idempotency-Key` therefore both MISS, both apply
 * their effect, and — while the stored row was written with `ON CONFLICT DO NOTHING` and its
 * result ignored — the loser's insert silently vanished while its transaction committed anyway.
 * The observable damage: **two** `workflow_runs` from one `POST /workflows/:id/run`, and two
 * different `runId`s returned for one key. That is precisely the guarantee an Idempotency-Key
 * exists to give, and no PGlite test could ever see it: PGlite is a single connection, so the
 * "both miss the lookup" interleaving is unreachable there.
 *
 * This file drives the REAL app over TWO separate physical connections to a real Postgres, so
 * the two requests genuinely overlap. What it proves:
 *   • exactly ONE effect (one run row / one move + one change_log row),
 *   • IDENTICAL responses (same status, same body, same `X-Sync-Seq`),
 *   • exactly one `idempotency_keys` row,
 *   • and no spurious 409 — a retry of the SAME request must never be rejected as "reused".
 *
 * To see it bite, remove the `if (!claimed) throw new IdempotencyRaceLost(...)` from
 * `workflows-service.ts` and run this file: two rows, two ids.
 */
const PG_UP = await realPgAvailable();

const FIXED_NOW = new Date("2026-07-28T12:00:00.000Z");

/** A real-Postgres `ApiDeps` on its OWN connection — two of these is what makes the race real. */
function depsOn(db: Db): ApiDeps {
  const authDeps = makeTestAuthDeps({});
  return {
    db,
    now: () => FIXED_NOW,
    requestId: `pg-${randomUUID()}`,
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
        // the SSRF gate's DNS port is required at construction; a fixed public address.
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
    },
  };
}

const app = createApp(apiRoutes);

function post(path: string, o: { bearer: string; key: string; body: unknown }): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${o.bearer}`,
      "content-type": "application/json",
      "idempotency-key": o.key,
    },
    body: JSON.stringify(o.body),
  });
}

describe.skipIf(!PG_UP)("concurrent Idempotency-Key against real Postgres", () => {
  // TWO independent pools = two independent physical connections. That is the whole apparatus:
  // one pool would serialize the requests and the race would never occur.
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

  /**
   * Run `requests` so that they are PROVABLY concurrent past the idempotency lookup.
   *
   * Firing two requests with `Promise.all` is not enough on localhost Postgres: the first can
   * finish before the second reaches its lookup, and then the second simply replays — the happy
   * path, not the race. A test that only sometimes exercises the bug is not a gate (measured: the
   * two-request form passed even with the guard removed; only a fan of six caught it).
   *
   * The barrier makes the interleaving deterministic. A THIRD connection inserts the very
   * `(account_id, key)` row inside an open transaction and holds it. That row is invisible to the
   * requests (uncommitted), so both lookups MISS — exactly the real precondition — and both then
   * apply their effect and BLOCK on the conflicting tuple when they try to claim. We assert both
   * are still pending, then ROLL THE BARRIER BACK: both unblock, one claim wins, the loser must
   * roll its effect back and replay the winner's response.
   */
  async function race(
    accountId: string, key: string, requests: Array<() => Promise<Response>>,
  ): Promise<Response[]> {
    let releaseBarrier!: () => void;
    const held = new Promise<void>((r) => { releaseBarrier = r; });
    let inserted!: () => void;
    const barrierReady = new Promise<void>((r) => { inserted = r; });

    const barrier = (ownedC.db as unknown as Db).transaction(async (tx) => {
      await tx.insert(idempotencyKeys).values({
        accountId, key, requestHash: "barrier", responseStatus: 0, responseJson: {}, seq: null,
        expiresAt: new Date(FIXED_NOW.getTime() + 60_000),
      });
      inserted();
      await held;
      throw new Error("BARRIER_ROLLBACK");        // rollback: the row never existed
    }).catch(() => { /* the rollback IS the mechanism */ });

    await barrierReady;

    const settled = requests.map(() => false);
    const inFlight = requests.map((send, i) => send().then((res) => { settled[i] = true; return res; }));

    // Long enough for every request to have reached — and blocked on — the claim.
    await new Promise((r) => setTimeout(r, 400));
    expect(settled, "every request must still be blocked on the claim, i.e. genuinely concurrent")
      .toEqual(requests.map(() => false));

    releaseBarrier();
    await barrier;
    return Promise.all(inFlight);
  }

  /** account + user + bearer session, on connection A (both connections see it once committed). */
  async function seed(): Promise<{ token: string; accountId: string }> {
    const token = generateToken();
    const [acct] = await dbA.insert(accounts).values({ name: `conc-${randomUUID()}` }).returning();
    const [user] = await dbA.insert(users)
      .values({
        accountId: acct!.id, email: `c-${randomUUID()}@example.com`, displayName: "C",
        // `withSpendGate` refuses an unproven address on every `work` route, and both
        // `POST /workflows/:id/run` and `POST /messages/:id/move` are `work`. This fixture
        // fabricates its rows, so it asserts nothing about how the address was proven and must
        // not accidentally assert something about verification either: the subject here is the
        // idempotency claim under real concurrency. `spend-gate.test.ts` owns the gate.
        emailVerifiedAt: FIXED_NOW,
      }).returning();
    await dbA.insert(sessions).values({
      accountId: acct!.id,
      userId: user!.id,
      familyId: randomUUID(),
      accessTokenHash: hashToken(token),
      accessExpiresAt: new Date(FIXED_NOW.getTime() + 3_600_000),
      refreshExpiresAt: new Date(FIXED_NOW.getTime() + 7_200_000),
    });
    return { token, accountId: acct!.id };
  }

  it("two simultaneous POST /workflows/:id/run with ONE key → one run, one runId, no 409", async () => {
    const { token, accountId } = await seed();
    const [wf] = await dbA.insert(workflows).values({
      accountId, name: "Concurrent", trigger: { type: "manual" }, steps: [], enabled: true,
    }).returning();

    const key = `run-${randomUUID()}`;
    const [ra, rb] = await race(accountId, key, [
      () => app.handle(post(`/workflows/${wf!.id}/run`, { bearer: token, key, body: {} }), depsOn(dbA)),
      () => app.handle(post(`/workflows/${wf!.id}/run`, { bearer: token, key, body: {} }), depsOn(dbB)),
    ]);

    const [ba, bb] = [await ra.json(), await rb.json()];
    // Neither request may be told its own key was "reused with a different request".
    expect([ra.status, rb.status]).toEqual([202, 202]);
    expect(ba.runId).toBeTruthy();
    expect(bb.runId).toBe(ba.runId);                       // ONE id, handed to both callers

    const runs = await dbA.select().from(workflowRuns).where(eq(workflowRuns.accountId, accountId));
    expect(runs).toHaveLength(1);                          // ONE effect — this is the whole point
    expect(runs[0]!.id).toBe(ba.runId);

    const keys = await dbA.select().from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.accountId, accountId), eq(idempotencyKeys.key, key)));
    expect(keys).toHaveLength(1);
    expect(keys[0]!.responseStatus).toBe(202);
    expect(keys[0]!.responseJson).toEqual({ runId: ba.runId });
  }, 30_000);

  it("two simultaneous moves with ONE key → one move, ONE change_log row, identical X-Sync-Seq", async () => {
    // The seq path matters separately: `allocateSeq` takes a row lock, so the loser blocks and
    // then commits AFTER the winner. Its rollback must take the change_log row with it, or
    // clients would see two `move` changes for one mutation (and a seq the response never named).
    const { token, accountId } = await seed();
    const [mb] = await dbA.insert(mailboxes).values({
      accountId, provider: "imap", address: "conc@example.com",
    }).returning();
    const [msg] = await dbA.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `d:${randomUUID()}`,
      subject: "s", fromAddress: "a@b.c", snippet: "s",
      nativeLocator: { folder: "INBOX", ref: "1:1" },
    }).returning();
    await dbA.insert(folderState).values({
      messageId: msg!.id, accountId: msg!.accountId, desiredFolder: "INBOX", observedFolder: "INBOX",
      lastSetBy: "us", reconcileStatus: "reconciled",
    });

    const key = `move-${randomUUID()}`;
    const body = { folder: "ohmail/News" };
    const [ra, rb] = await race(accountId, key, [
      () => app.handle(post(`/messages/${msg!.id}/move`, { bearer: token, key, body }), depsOn(dbA)),
      () => app.handle(post(`/messages/${msg!.id}/move`, { bearer: token, key, body }), depsOn(dbB)),
    ]);

    expect([ra.status, rb.status]).toEqual([200, 200]);
    expect(await rb.json()).toEqual(await ra.json());                       // verbatim same response
    expect(rb.headers.get("x-sync-seq")).toBe(ra.headers.get("x-sync-seq")); // and the same seq

    const changes = await dbA.select().from(changeLog)
      .where(and(eq(changeLog.accountId, accountId), eq(changeLog.entityId, msg!.id)));
    expect(changes).toHaveLength(1);                                        // the loser's row rolled back
    expect(String(changes[0]!.seq)).toBe(ra.headers.get("x-sync-seq"));

    const keys = await dbA.select().from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.accountId, accountId), eq(idempotencyKeys.key, key)));
    expect(keys).toHaveLength(1);
  }, 30_000);

  it("SIX simultaneous requests with one key → still one effect and six identical answers", async () => {
    // Two connections is enough to prove the race exists; a fan of six proves the mechanism does
    // not merely reorder it (e.g. a fix that only handles the first loser).
    const { token, accountId } = await seed();
    const [wf] = await dbA.insert(workflows).values({
      accountId, name: "Fan", trigger: { type: "manual" }, steps: [], enabled: true,
    }).returning();

    const key = `fan-${randomUUID()}`;
    const results = await race(accountId, key, Array.from({ length: 6 }, (_, i) =>
      () => app.handle(post(`/workflows/${wf!.id}/run`, { bearer: token, key, body: {} }), depsOn(i % 2 ? dbA : dbB))));
    const bodies = await Promise.all(results.map((r) => r.json()));
    expect(results.map((r) => r.status)).toEqual([202, 202, 202, 202, 202, 202]);
    expect(new Set(bodies.map((b) => b.runId)).size).toBe(1);

    const runs = await dbA.select().from(workflowRuns).where(eq(workflowRuns.accountId, accountId));
    expect(runs).toHaveLength(1);
  }, 30_000);

  it("a DIFFERENT request under the same key is still a 409 — the guard is not disarmed", async () => {
    const { token, accountId } = await seed();
    const [wf] = await dbA.insert(workflows).values({
      accountId, name: "Guard", trigger: { type: "manual" }, steps: [], enabled: true,
    }).returning();
    const [other] = await dbA.insert(workflows).values({
      accountId, name: "Other", trigger: { type: "manual" }, steps: [], enabled: true,
    }).returning();

    const key = `guard-${randomUUID()}`;
    const first = await app.handle(post(`/workflows/${wf!.id}/run`, { bearer: token, key, body: {} }), depsOn(dbA));
    expect(first.status).toBe(202);

    // Same key, DIFFERENT path ⇒ a different request_hash ⇒ 409, not a replay.
    const second = await app.handle(post(`/workflows/${other!.id}/run`, { bearer: token, key, body: {} }), depsOn(dbB));
    expect(second.status).toBe(409);
    expect((await second.json()).error.code).toBe("idempotency_replay");

    const runs = await dbA.select().from(workflowRuns).where(eq(workflowRuns.accountId, accountId));
    expect(runs).toHaveLength(1);
  }, 30_000);
});
