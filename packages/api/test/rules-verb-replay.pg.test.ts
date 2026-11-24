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
 * THE CONCURRENT HALF — `DELETE /rules/:id` and `PATCH /rules/:id` retried under one
 * `Idempotency-Key` by two SIMULTANEOUS requests on two connections.
 *
 * This cannot live in `rules-verb-replay.test.ts`: the idempotency lookup runs in
 * AUTOCOMMIT before any transaction opens, so two simultaneous requests both MISS it, and
 * PGlite is one connection that can never reach that interleaving. The claim inside the
 * mutation's own transaction is the only thing that serialises them, and only real
 * Postgres blocks the second `INSERT … ON CONFLICT` on the conflicting tuple.
 *
 * The barrier apparatus is `idempotency-concurrency.pg.test.ts`'s, reused verbatim by
 * `rules-idempotency.pg.test.ts` before this file: a third connection holds an
 * uncommitted row on the very `(account_id, key)`, so every request misses the lookup,
 * applies its effect, and BLOCKS at the claim. We assert all are still pending — that is
 * what proves they are genuinely concurrent rather than accidentally sequential — then
 * roll the barrier back and let them race.
 *
 * To see it bite: remove `if (!claimed) throw new IdempotencyRaceLost(...)` from
 * `RulesService.remove` / `.update`, or the `idempotency` threading from
 * `packages/api/src/routes/rules.ts`.
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

const RULE = { kind: "domain", match: "acme.example", destination: "ohmail/News" };

/** `match` names a DIFFERENT rule: one sender's twins are one rule, removed together. */
function postRule(bearer: string, match = RULE.match): Request {
  return new Request("http://localhost/rules", {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ ...RULE, match }),
  });
}

/** `key: null` sends NO `Idempotency-Key` at all — the unkeyed path. */
function delRule(o: { bearer: string; id: string; key: string | null }): Request {
  const headers: Record<string, string> = { authorization: `Bearer ${o.bearer}` };
  if (o.key !== null) headers["idempotency-key"] = o.key;
  return new Request(`http://localhost/rules/${o.id}`, { method: "DELETE", headers });
}

function patchRule(o: { bearer: string; id: string; key: string | null; body: unknown }): Request {
  const headers: Record<string, string> = {
    authorization: `Bearer ${o.bearer}`, "content-type": "application/json",
  };
  if (o.key !== null) headers["idempotency-key"] = o.key;
  return new Request(`http://localhost/rules/${o.id}`, {
    method: "PATCH", headers, body: JSON.stringify(o.body),
  });
}

describe.skipIf(!PG_UP)("retried DELETE/PATCH /rules/:id replay one outcome", () => {
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

  /** Run `requests` so they are PROVABLY concurrent past the idempotency lookup. */
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
    const [acct] = await dbA.insert(accounts).values({ name: `rulesverb-${randomUUID()}` }).returning();
    const [user] = await dbA.insert(users)
      .values({
        accountId: acct!.id, email: `rv-${randomUUID()}@example.com`, displayName: "RV",
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

  /** Seed an account holding one rule, ready to be deleted or patched. */
  async function seedWithRule(): Promise<{ token: string; accountId: string; ruleId: string }> {
    const s = await seed();
    const res = await app.handle(postRule(s.token), depsOn(dbA));
    expect(res.status).toBe(201);
    return { ...s, ruleId: (await res.json()).id as string };
  }

  const rulesOf = (accountId: string) =>
    dbA.select().from(rules).where(eq(rules.accountId, accountId));

  const changesFor = (accountId: string, entityId: string, op: string) =>
    dbA.select().from(changeLog).where(and(
      eq(changeLog.accountId, accountId), eq(changeLog.entityId, entityId), eq(changeLog.op, op),
    ));

  it("TWO SIMULTANEOUS DELETEs with ONE key → two 204s, one seq, one delete change", async () => {
    const { token, accountId, ruleId } = await seedWithRule();
    const key = `del-conc-${randomUUID()}`;

    const [ra, rb] = await race(accountId, key, [
      () => app.handle(delRule({ bearer: token, id: ruleId, key }), depsOn(dbA)),
      () => app.handle(delRule({ bearer: token, id: ruleId, key }), depsOn(dbB)),
    ]);

    // Neither caller is told their revoke failed. That is the whole gap.
    expect([ra!.status, rb!.status]).toEqual([204, 204]);
    expect(await ra!.text()).toBe("");
    expect(await rb!.text()).toBe("");
    expect(rb!.headers.get("x-sync-seq")).toBe(ra!.headers.get("x-sync-seq"));

    expect(await rulesOf(accountId)).toHaveLength(0);

    // ONE delete change — the loser's rolled back with its (already-lost) delete.
    const changes = await changesFor(accountId, ruleId, "delete");
    expect(changes).toHaveLength(1);
    expect(String(changes[0]!.seq)).toBe(ra!.headers.get("x-sync-seq"));

    const keys = await dbA.select().from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.accountId, accountId), eq(idempotencyKeys.key, key)));
    expect(keys).toHaveLength(1);
    expect(keys[0]!.responseStatus).toBe(204);
  }, 30_000);

  it("SIX simultaneous DELETEs with one key → six 204s and one seq", async () => {
    // A fan of six, because the two-request form was measured to pass even with the guard
    // removed (see `idempotency-concurrency.pg.test.ts`).
    const { token, accountId, ruleId } = await seedWithRule();
    const key = `del-fan-${randomUUID()}`;

    const results = await race(accountId, key, Array.from({ length: 6 }, (_, i) =>
      () => app.handle(delRule({ bearer: token, id: ruleId, key }), depsOn(i % 2 ? dbA : dbB))));

    expect(results.map((r) => r.status)).toEqual([204, 204, 204, 204, 204, 204]);
    expect(new Set(results.map((r) => r.headers.get("x-sync-seq"))).size).toBe(1);
    expect(await changesFor(accountId, ruleId, "delete")).toHaveLength(1);
    expect(await rulesOf(accountId)).toHaveLength(0);
  }, 30_000);

  it("a SEQUENTIAL DELETE retry on real Postgres replays 204 and the first seq", async () => {
    const { token, accountId, ruleId } = await seedWithRule();
    const key = `del-seq-${randomUUID()}`;

    const first = await app.handle(delRule({ bearer: token, id: ruleId, key }), depsOn(dbA));
    expect(first.status).toBe(204);
    const seq = first.headers.get("x-sync-seq");

    // A DIFFERENT connection, as a retried request on a serverless host would be.
    const retry = await app.handle(delRule({ bearer: token, id: ruleId, key }), depsOn(dbB));
    expect(retry.status).toBe(204);
    expect(retry.headers.get("x-sync-seq")).toBe(seq);
    expect(await changesFor(accountId, ruleId, "delete")).toHaveLength(1);
  }, 30_000);

  it("ONE key aimed at TWO DIFFERENT rules, simultaneously → one 204, one 409, one survivor", async () => {
    // THE ONLY PATH THAT REACHES `IdempotencyRaceLost` FROM `remove`. Two deletes of the
    // SAME rule contend on the rules ROW, so the loser throws 404 from `tx.delete` and never
    // attempts the claim; only DISJOINT rows let both reach it and collide there. Without
    // this case the `if (!claimed) throw` in `RulesService.remove` is unexercised, and a
    // mutation of it stays green.
    const { token, accountId, ruleId } = await seedWithRule();
    const other = await app.handle(postRule(token, "other.example"), depsOn(dbA));
    const otherId = (await other.json()).id as string;
    const key = `del-cross-${randomUUID()}`;

    const [ra, rb] = await race(accountId, key, [
      () => app.handle(delRule({ bearer: token, id: ruleId, key }), depsOn(dbA)),
      () => app.handle(delRule({ bearer: token, id: otherId, key }), depsOn(dbB)),
    ]);

    // The key names ONE request; the second is a different request wearing it.
    expect([ra!.status, rb!.status].sort()).toEqual([204, 409]);
    const refused = ra!.status === 409 ? ra! : rb!;
    expect((await refused.json()).error.code).toBe("idempotency_replay");

    // The refused delete ROLLED BACK: its rule is still there, and emitted no change.
    const survivors = await rulesOf(accountId);
    expect(survivors).toHaveLength(1);
    const survivorId = survivors[0]!.id;
    expect(await changesFor(accountId, survivorId, "delete")).toHaveLength(0);
  }, 30_000);

  it("TWO SIMULTANEOUS PATCHes with ONE key → one update change and identical answers", async () => {
    const { token, accountId, ruleId } = await seedWithRule();
    const key = `patch-conc-${randomUUID()}`;
    const body = { priority: 4 };

    const [ra, rb] = await race(accountId, key, [
      () => app.handle(patchRule({ bearer: token, id: ruleId, key, body }), depsOn(dbA)),
      () => app.handle(patchRule({ bearer: token, id: ruleId, key, body }), depsOn(dbB)),
    ]);

    const [ba, bb] = [await ra!.json(), await rb!.json()];
    expect([ra!.status, rb!.status]).toEqual([200, 200]);
    expect(bb).toEqual(ba);
    expect(ba.priority).toBe(4);
    expect(rb!.headers.get("x-sync-seq")).toBe(ra!.headers.get("x-sync-seq"));

    // ONE `rule`/`update` row: the churn half of that change, under concurrency.
    const changes = await changesFor(accountId, ruleId, "update");
    expect(changes).toHaveLength(1);
    expect(String(changes[0]!.seq)).toBe(ra!.headers.get("x-sync-seq"));
  }, 30_000);

  it("a genuine second DELETE of a DIFFERENT rule under its own key is unaffected", async () => {
    // The negative that stops the fix from degrading into "DELETE always says 204".
    const { token, accountId, ruleId } = await seedWithRule();
    const second = await app.handle(postRule(token, "other.example"), depsOn(dbA));
    const otherId = (await second.json()).id as string;

    const r1 = await app.handle(delRule({ bearer: token, id: ruleId, key: `k1-${randomUUID()}` }), depsOn(dbA));
    const r2 = await app.handle(delRule({ bearer: token, id: otherId, key: `k2-${randomUUID()}` }), depsOn(dbB));
    expect([r1.status, r2.status]).toEqual([204, 204]);
    expect(r2.headers.get("x-sync-seq")).not.toBe(r1.headers.get("x-sync-seq"));
    expect(await rulesOf(accountId)).toHaveLength(0);

    // And an id that never existed is still 404, key or no key.
    const ghost = randomUUID();
    expect((await app.handle(delRule({ bearer: token, id: ghost, key: null }), depsOn(dbA))).status).toBe(404);
    expect((await app.handle(delRule({ bearer: token, id: ghost, key: `g-${randomUUID()}` }), depsOn(dbA))).status).toBe(404);
  }, 30_000);
});
