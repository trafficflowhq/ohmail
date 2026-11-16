import { perRequest } from "./helpers.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { accounts, users, sessions, rules, idempotencyKeys, changeLog } from "@trafficflow/db";
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
 * `POST /rules` under `Idempotency-Key` — the gap that made a retried rule
 * creation mint a SECOND rule.
 *
 * The route carried no `idempotent: true`, so `withIdempotency` never looked the key
 * up and never exposed `deps.idempotency`; `RulesService.create` never claimed the row.
 * The engine's retry queue drains everything (`flushPending`), and rule creation is a
 * default action on the sender sheet, so a network blip during one click produced two
 * rules. Both filed to the same place, which is why this was correctness and not data
 * loss — but the guarantee an `Idempotency-Key` exists to give was simply absent.
 *
 * What this file pins down: a REPLAY answers what its first press answered, status included.
 * A second create of the same four-field key under another key or none is not a second rule:
 * it answers the existing one at 200 (RULE-CREATE-WRITES-A-TWIN-UNDER-AN-EXISTING-KEY).
 *
 * The concurrent case is why this is a `*.pg.test.ts` and not a PGlite test: the
 * middleware's lookup runs in AUTOCOMMIT before any transaction opens, so two
 * simultaneous requests both miss it. PGlite is a single connection and can never
 * reach that interleaving. See `idempotency-concurrency.pg.test.ts`, whose barrier
 * apparatus this file reuses — and whose comment records the measured reason a bare
 * `Promise.all` is not enough.
 *
 * To see it bite, remove the `if (!claimed) throw new IdempotencyRaceLost(...)` from
 * `rules-service.ts` (concurrent cases) or the `options: { idempotent: true }` from
 * `routes/rules.ts` (every case).
 */
const PG_UP = await realPgAvailable();

const FIXED_NOW = new Date("2026-08-04T12:00:00.000Z");

/** A real-Postgres `ApiDeps` on its OWN connection — two of these is what makes the race real. */
function depsOn(db: Db): ApiDeps {
  const authDeps = makeTestAuthDeps({});
  return perRequest({
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
  });
}

const app = createApp(apiRoutes);

/** `POST /rules`. `key: null` sends NO `Idempotency-Key` at all — the unkeyed path. */
function postRule(o: { bearer: string; key: string | null; body: unknown }): Request {
  const headers: Record<string, string> = {
    authorization: `Bearer ${o.bearer}`,
    "content-type": "application/json",
  };
  if (o.key !== null) headers["idempotency-key"] = o.key;
  return new Request("http://localhost/rules", {
    method: "POST",
    headers,
    body: JSON.stringify(o.body),
  });
}

const RULE = { kind: "domain", match: "acme.example", destination: "ohmail/News" };

describe.skipIf(!PG_UP)("POST /rules is idempotent under a key", () => {
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
   * Run `requests` so they are PROVABLY concurrent past the idempotency lookup, via the
   * barrier from `idempotency-concurrency.pg.test.ts`: a third connection holds an
   * uncommitted row on the very `(account_id, key)`, so every request MISSES the lookup
   * (the row is invisible), applies its effect, and BLOCKS on the conflicting tuple at
   * the claim. We assert all are still pending, then roll the barrier back.
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

    await new Promise((r) => setTimeout(r, 400));
    expect(settled, "every request must still be blocked on the claim, i.e. genuinely concurrent")
      .toEqual(requests.map(() => false));

    releaseBarrier();
    await barrier;
    return Promise.all(inFlight);
  }

  /** account + user + bearer session. `emailVerifiedAt` because `/rules` is a `work` route. */
  async function seed(): Promise<{ token: string; accountId: string }> {
    const token = generateToken();
    const [acct] = await dbA.insert(accounts).values({ name: `rules-${randomUUID()}` }).returning();
    const [user] = await dbA.insert(users)
      .values({
        accountId: acct!.id, email: `r-${randomUUID()}@example.com`, displayName: "R",
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

  const rulesOf = (accountId: string) =>
    dbA.select().from(rules).where(eq(rules.accountId, accountId));

  it("a SEQUENTIAL retry with the same key replays the first 201 — and mints no second rule", async () => {
    // This is the live defect: the retry queue drains a click whose response was lost.
    const { token, accountId } = await seed();
    const key = `seq-${randomUUID()}`;

    const first = await app.handle(postRule({ bearer: token, key, body: RULE }), depsOn(dbA));
    expect(first.status).toBe(201);
    const b1 = await first.json();

    const second = await app.handle(postRule({ bearer: token, key, body: RULE }), depsOn(dbA));
    expect(second.status).toBe(201);
    const b2 = await second.json();

    // Indistinguishable to the client: same status, same body, same seq.
    expect(b2).toEqual(b1);
    expect(b2.id).toBe(b1.id);
    expect(second.headers.get("x-sync-seq")).toBe(first.headers.get("x-sync-seq"));

    // ...except that no second row exists. THE assertion.
    expect(await rulesOf(accountId)).toHaveLength(1);

    // And exactly one `rule` change — a replay must not re-notify every synced client.
    const changes = await dbA.select().from(changeLog)
      .where(and(eq(changeLog.accountId, accountId), eq(changeLog.entityId, b1.id)));
    expect(changes).toHaveLength(1);
  }, 30_000);

  it("identical creates without a key or under different keys are ONE rule: 201, then 200 naming it", async () => {
    // One rule per four-field key (RULE-CREATE-WRITES-A-TWIN-UNDER-AN-EXISTING-KEY). This case
    // pinned two identical rules as legal; the create door now answers the rule the key has.
    const { token, accountId } = await seed();

    // (a) two requests carrying NO key at all.
    const r1 = await app.handle(postRule({ bearer: token, key: null, body: RULE }), depsOn(dbA));
    const r2 = await app.handle(postRule({ bearer: token, key: null, body: RULE }), depsOn(dbA));
    expect([r1.status, r2.status]).toEqual([201, 200]);
    const id = (await r1.json()).id;
    expect((await r2.json()).id).toBe(id);
    expect(r2.headers.get("x-sync-seq"), "nothing changed, so no seq").toBeNull();
    expect(await rulesOf(accountId)).toHaveLength(1);

    // (b) two requests carrying DIFFERENT keys — each answers the one rule.
    const r3 = await app.handle(postRule({ bearer: token, key: `d-${randomUUID()}`, body: RULE }), depsOn(dbA));
    const r4 = await app.handle(postRule({ bearer: token, key: `d-${randomUUID()}`, body: RULE }), depsOn(dbA));
    expect([r3.status, r4.status]).toEqual([200, 200]);
    expect([(await r3.json()).id, (await r4.json()).id]).toEqual([id, id]);
    expect(await rulesOf(accountId)).toHaveLength(1);
  }, 30_000);

  it("TWO SIMULTANEOUS POST /rules with ONE key → one rule, one id, no 409", async () => {
    const { token, accountId } = await seed();
    const key = `conc-${randomUUID()}`;

    const [ra, rb] = await race(accountId, key, [
      () => app.handle(postRule({ bearer: token, key, body: RULE }), depsOn(dbA)),
      () => app.handle(postRule({ bearer: token, key, body: RULE }), depsOn(dbB)),
    ]);

    const [ba, bb] = [await ra.json(), await rb.json()];
    expect([ra.status, rb.status]).toEqual([201, 201]);
    expect(ba.id).toBeTruthy();
    expect(bb.id).toBe(ba.id);                                 // ONE id, handed to both callers
    expect(rb.headers.get("x-sync-seq")).toBe(ra.headers.get("x-sync-seq"));

    const rows = await rulesOf(accountId);
    expect(rows).toHaveLength(1);                              // ONE effect — the whole point
    expect(rows[0]!.id).toBe(ba.id);

    // The loser's change_log row rolled back with its rule.
    const changes = await dbA.select().from(changeLog)
      .where(and(eq(changeLog.accountId, accountId), eq(changeLog.entityId, ba.id)));
    expect(changes).toHaveLength(1);
    expect(String(changes[0]!.seq)).toBe(ra.headers.get("x-sync-seq"));

    const keys = await dbA.select().from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.accountId, accountId), eq(idempotencyKeys.key, key)));
    expect(keys).toHaveLength(1);
    expect(keys[0]!.responseStatus).toBe(201);
  }, 30_000);

  it("SIX simultaneous requests with one key → still one rule and six identical answers", async () => {
    // A fan of six, because the two-request form was measured to pass even with the guard
    // removed (see `idempotency-concurrency.pg.test.ts`).
    const { token, accountId } = await seed();
    const key = `fan-${randomUUID()}`;

    const results = await race(accountId, key, Array.from({ length: 6 }, (_, i) =>
      () => app.handle(postRule({ bearer: token, key, body: RULE }), depsOn(i % 2 ? dbA : dbB))));

    const bodies = await Promise.all(results.map((r) => r.json()));
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201, 201]);
    expect(new Set(bodies.map((b) => b.id)).size).toBe(1);
    expect(await rulesOf(accountId)).toHaveLength(1);
  }, 30_000);

  it("a DIFFERENT rule under the same key is a 409 — the guard is not disarmed", async () => {
    const { token, accountId } = await seed();
    const key = `guard-${randomUUID()}`;

    const first = await app.handle(postRule({ bearer: token, key, body: RULE }), depsOn(dbA));
    expect(first.status).toBe(201);

    // Same key, DIFFERENT body ⇒ a different request_hash ⇒ 409, not a replay.
    const second = await app.handle(
      postRule({ bearer: token, key, body: { ...RULE, match: "other.example" } }), depsOn(dbB));
    expect(second.status).toBe(409);
    expect((await second.json()).error.code).toBe("idempotency_replay");

    expect(await rulesOf(accountId)).toHaveLength(1);
  }, 30_000);
});
