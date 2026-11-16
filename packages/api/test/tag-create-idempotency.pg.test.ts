import { perRequest } from "./helpers.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { accounts, users, sessions, tags, idempotencyKeys } from "@trafficflow/db";
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
 * `POST /tags` under one Idempotency-Key, two requests at once: the loser of the
 * race meets the name constraint the winner's row holds BEFORE it reaches the key claim, so it must
 * read the winner's committed key and replay it, not answer 409 over the tag its own key made. A
 * second request under ANOTHER key is still the name rule's 409. Barrier and seed are the rules
 * file's (`rules-idempotency.pg.test.ts`).
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
      // The tag routes reach no IMAP door; the rules file's own deps omit it the same way.
    } as unknown as ApiDeps["services"],
  });
}

const app = createApp(apiRoutes);

/** `POST /tags`. */
function postTag(o: { bearer: string; key: string | null; body: unknown }): Request {
  const headers: Record<string, string> = {
    authorization: `Bearer ${o.bearer}`,
    "content-type": "application/json",
  };
  if (o.key !== null) headers["idempotency-key"] = o.key;
  return new Request("http://localhost/tags", {
    method: "POST",
    headers,
    body: JSON.stringify(o.body),
  });
}


describe.skipIf(!PG_UP)("POST /tags is idempotent under a key", () => {
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

  /** account + user + bearer session. `emailVerifiedAt` because `/tags` is a `work` route. */
  async function seed(): Promise<{ token: string; accountId: string }> {
    const token = generateToken();
    const [acct] = await dbA.insert(accounts).values({ name: `tags-${randomUUID()}` }).returning();
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

  it("two simultaneous creates under ONE key: one tag, two 201s with its id", async () => {
    const { token, accountId } = await seed();
    const key = `tag-${randomUUID()}`;
    const send = (db: Db) => () => app.handle(postTag({ bearer: token, key, body: { name: "Invoices" } }), depsOn(db));
    const answers = await race(accountId, key, [send(dbA), send(dbB)]);
    const bodies = await Promise.all(answers.map((r) => r.json()));
    const rows = await dbA.select().from(tags).where(eq(tags.accountId, accountId));
    expect({ statuses: answers.map((r) => r.status), ids: new Set(bodies.map((b) => b.id)).size, rows: rows.length },
      "the race's loser answered the name rule over the tag its own key made").toEqual({ statuses: [201, 201], ids: 1, rows: 1 });
  });

  it("CONTROL: a second create under ANOTHER key is still refused by the name rule", async () => {
    const { token } = await seed();
    const one = await app.handle(postTag({ bearer: token, key: `a-${randomUUID()}`, body: { name: "Invoices" } }), depsOn(dbA));
    const two = await app.handle(postTag({ bearer: token, key: `b-${randomUUID()}`, body: { name: "Invoices" } }), depsOn(dbA));
    expect([one.status, two.status]).toEqual([201, 409]);
  });
});
