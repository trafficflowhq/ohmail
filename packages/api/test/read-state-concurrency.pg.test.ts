import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { accounts, users, sessions, mailboxes, messages, flagState, changeLog } from "@trafficflow/db";
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
 * READ-STATE UNDER REAL CONCURRENCY — the two assertions PGlite structurally cannot
 * host, and the class of bug this repository has been blindsided by three times.
 *
 * `flag_state` has TWO writers by design: the API owns `desired_seen` and the worker owns
 * `observed_seen`, and they meet on one row through `ON CONFLICT DO UPDATE`. That is a single
 * row written from two physical connections, which PGlite — one connection, no true
 * interleaving — cannot reproduce at all. Both tests here fail without their fix and pass with
 * it, and neither would even be expressible in the unit suite.
 *
 *  1. THE UPSERT RACE. The API computes `reconcile_status` from `desired` vs `observed`. If it
 *     computed it in JS from the `observed_seen` it read BEFORE the worker's write landed, the
 *     row would be stamped `reconciled` while desired ≠ observed — and a `reconciled` row is
 *     never picked up by `reconcileFlags`, so the `\Seen` flag would never reach the user's own
 *     IMAP server. Silent, permanent, and invisible to every single-connection test. The fix is
 *     the `case when` in `upsertDesiredSeen`, evaluated by Postgres against the STORED value.
 *
 *  2. SEQ INTEGRITY. The batch route allocates one `change_log` seq per message inside one
 *     transaction. Two overlapping batches on one account must still produce a gap-free,
 *     duplicate-free sequence — that is contract §3.3, and a client whose cursor skips a seq
 *     never sees the message at that seq again.
 */
const PG_UP = await realPgAvailable();

const FIXED_NOW = new Date("2026-07-28T12:00:00.000Z");
const app = createApp(apiRoutes);

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

const patch = (token: string, body: unknown): Request =>
  new Request("http://localhost/messages", {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe.skipIf(!PG_UP)("read-state against real Postgres — two writers, one row", () => {
  let ownedA: OwnedDb;
  let ownedB: OwnedDb;
  let dbA: Db;
  let dbB: Db;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    ownedA = makeOwnedDb(PG_TEST_URL);
    ownedB = makeOwnedDb(PG_TEST_URL);
    dbA = ownedA.db as unknown as Db;
    dbB = ownedB.db as unknown as Db;
  }, 60_000);

  afterAll(async () => {
    await ownedA?.close();
    await ownedB?.close();
  });

  async function seed(): Promise<{ token: string; accountId: string; mailboxId: string }> {
    const token = generateToken();
    const [acct] = await dbA.insert(accounts).values({ name: `u1-${randomUUID()}` }).returning();
    const [user] = await dbA.insert(users)
      .values({
        accountId: acct!.id, email: `u1-${randomUUID()}@example.com`, displayName: "U",
        // `withSpendGate` refuses an unproven address on every `work` route, and
        // `PATCH /messages` is `work`. This fixture fabricates its rows, so it asserts nothing
        // about how the address was proven and must not accidentally assert something about
        // verification either: the subject here is the row lock between two real Postgres
        // connections. `spend-gate.test.ts` owns the gate.
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
    const [mb] = await dbA.insert(mailboxes)
      .values({ accountId: acct!.id, provider: "imap", address: `u1-${randomUUID().slice(0, 8)}@example.com` })
      .returning();
    return { token, accountId: acct!.id, mailboxId: mb!.id };
  }

  async function seedMessage(
    accountId: string, mailboxId: string, o: { unread: boolean } = { unread: true },
  ): Promise<string> {
    const [m] = await dbA.insert(messages).values({
      accountId, mailboxId, bodyHash: "h", dedupKey: `u1:${randomUUID()}`,
      subject: "s", fromAddress: "a@b.example", unread: o.unread,
      nativeLocator: { folder: "INBOX", ref: "1:1" },
    }).returning();
    return m!.id;
  }

  it("the worker's observed_seen landing MID-REQUEST cannot leave the row falsely 'reconciled'", async () => {
    const { token, accountId, mailboxId } = await seed();
    // The state after a first "mark read" that the worker has not pushed yet: the read model
    // has moved, the intent is on record, the server has not been told.
    const id = await seedMessage(accountId, mailboxId, { unread: false });
    await dbA.insert(flagState).values({
      messageId: id, accountId, desiredSeen: true, observedSeen: false, lastSetBy: "us", reconcileStatus: "pending",
    });

    // Connection B plays the WORKER: it has just pushed `\Seen` and is writing `observed_seen`.
    // It holds the row lock so the API request below provably blocks on it — without the
    // barrier the two would serialize by luck and the interleaving under test would not occur.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const ready = new Promise<void>((r) => { locked = r; });

    const worker = dbB.transaction(async (tx) => {
      await tx.update(flagState)
        .set({ observedSeen: true, reconcileStatus: "reconciled", updatedAt: FIXED_NOW })
        .where(eq(flagState.messageId, id));
      locked();
      await held;
    });
    await ready;

    // Connection A plays the API: the user marks the SAME message read again (a selection that
    // includes an already-read message — the ordinary case for "mark all read"). Its guess at
    // `observed_seen` is the pre-request read model, which is now stale.
    let settled = false;
    const request = app.handle(patch(token, { ids: [id], unread: false }), depsOn(dbA))
      .then((r) => { settled = true; return r; });

    await new Promise((r) => setTimeout(r, 300));
    expect(settled, "the API request must be BLOCKED on the worker's row lock — else this is not a race")
      .toBe(false);

    release();
    await worker;
    const res = await request;
    expect(res.status).toBe(200);

    const [row] = await dbA.select().from(flagState).where(eq(flagState.messageId, id));
    // ONE row — the unique constraint is what makes the two writers meet instead of fork.
    expect(await dbA.select().from(flagState).where(eq(flagState.messageId, id))).toHaveLength(1);
    // The worker's column SURVIVED the API's upsert (it is omitted from the conflict `set`).
    expect(row!.observedSeen, "observed_seen belongs to the worker").toBe(true);
    expect(row!.desiredSeen).toBe(true);
    // …and the status is derived from what is ACTUALLY stored, not from the stale guess. With a
    // JS-computed status this reads 'reconciled' here while the two columns agree by accident —
    // and if they had not, `reconcileFlags` would skip the row and `\Seen` would never ship.
    expect(row!.reconcileStatus).toBe("reconciled");
  });

  it("a STALE guess cannot mark an unpushed intent reconciled", async () => {
    // The same defect from the other side, and the one that bites hardest: the API's guess says
    // "converged", the stored `observed_seen` says otherwise, and only the stored value may
    // decide. Delete the `case when` from `upsertDesiredSeen` (use
    // `desiredSeen === observedSeen ? …` on the update path too) and this goes red: the row is
    // stamped `reconciled` with desired ≠ observed, `reconcileFlags` never selects it, and the
    // flag never reaches the user's server.
    const { token, accountId, mailboxId } = await seed();
    const id = await seedMessage(accountId, mailboxId, { unread: false });
    await dbA.insert(flagState).values({
      messageId: id, accountId, desiredSeen: true, observedSeen: false, lastSetBy: "us", reconcileStatus: "pending",
    });

    // `messages.unread` is false ⇒ the API guesses observed = true. The STORED observed is false.
    const res = await app.handle(patch(token, { ids: [id], unread: false }), depsOn(dbA));
    expect(res.status).toBe(200);

    const [row] = await dbA.select().from(flagState).where(eq(flagState.messageId, id));
    expect(row).toMatchObject({ desiredSeen: true, observedSeen: false });
    expect(row!.reconcileStatus, "still owed an IMAP write").toBe("pending");
  });

  it("two overlapping batches on one account produce a gap-free, duplicate-free seq run", async () => {
    // Contract §3.3. `allocateSeq` holds the `account_sync_state` row lock for the whole
    // transaction, so the second batch BLOCKS on the first's first allocation rather than
    // interleaving — which is what makes each batch's own seqs contiguous too. A `bigserial` or
    // an app-side read-modify-write would leak a gap or a duplicate right here, and a client
    // whose cursor skips a seq never sees that message again.
    const { token, accountId, mailboxId } = await seed();
    const N = 12;
    const idsA: string[] = [];
    const idsB: string[] = [];
    for (let i = 0; i < N; i++) idsA.push(await seedMessage(accountId, mailboxId));
    for (let i = 0; i < N; i++) idsB.push(await seedMessage(accountId, mailboxId));

    const [ra, rb] = await Promise.all([
      app.handle(patch(token, { ids: idsA, unread: false }), depsOn(dbA)),
      app.handle(patch(token, { ids: idsB, unread: false }), depsOn(dbB)),
    ]);
    expect([ra.status, rb.status]).toEqual([200, 200]);

    const rows = await dbA.select({ seq: changeLog.seq, entityId: changeLog.entityId })
      .from(changeLog).where(eq(changeLog.accountId, accountId));
    expect(rows, "one change per message, no more").toHaveLength(2 * N);

    const seqs = rows.map((r) => Number(r.seq)).sort((a, b) => a - b);
    expect(new Set(seqs).size, "no duplicate seq").toBe(2 * N);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i], "gap-free").toBe(seqs[i - 1]! + 1);
    }
    expect(new Set(rows.map((r) => r.entityId)).size).toBe(2 * N);

    // Every message actually moved, and every flag_state row exists exactly once.
    const unread = await dbA.select({ n: sql<number>`count(*)::int` }).from(messages)
      .where(and(eq(messages.accountId, accountId), eq(messages.unread, true)));
    expect(Number(unread[0]!.n)).toBe(0);
    const flags = await dbA.select().from(flagState)
      .where(sql`${flagState.messageId} in ${[...idsA, ...idsB]}`);
    expect(flags).toHaveLength(2 * N);
  }, 60_000);
});
