import { perRequest } from "./helpers.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  accounts, users, sessions, mailboxes, idempotencyKeys, drafts as draftsTable, eraseOwedMailbox,
} from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";
import {
  makeOwnedDb, acquireImapSlot, releaseImapSlot, type OwnedDb,
} from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";

import {
  hashToken, generateToken, makeTestAuthDeps, makeAuthService,
  syncService, pushService, makeMailboxService, rulesService, messageService, threadService,
  makeScreenerService, makeApprovalService, triageService, searchService, makePrivacyService,
  contactsService, snippetsService, notifyRulesService, awayResponderService, attachmentsService,
  kbService, tagsService, draftsService, draftingService, sendService, workflowsService,
  proposalsService, type Db,
} from "@trafficflow/services";

/**
 * A REPLAY NEVER SERVES CONTENT THE ERASURE TOOK.
 *
 * `idempotency_keys.response_json` is a verbatim copy of what a mutation answered with, held for
 * 24 hours so a retry after a lost response is idempotent. For `POST /drafts` that copy is the
 * whole draft — subject, body, recipients. The mailbox erasure deleted the draft and never
 * reached the copy, so a retry replayed it as a 201 describing a draft that no longer existed.
 *
 * TWO HALVES, AND EACH HAS ITS OWN RED. The erasure blanks the stored response and stamps the
 * row (`eraseIdempotentResponses`); the replay refuses a stamped row with 410
 * (`withIdempotency`). Blank the first away and the body comes back; blank the second away and
 * the retry answers 201 for a draft that is not there — the second half of the same defect.
 *
 * Real Postgres, because the sweep runs under an advisory lock and two row locks, and because
 * the stamp is written in the sweep's own transaction.
 *
 * NOTHING HERE PRINTS A BODY OR A RECIPIENT: the fixture's strings are constants of this file
 * and the assertions ask whether the serialized response CONTAINS them.
 */
const PG_UP = await realPgAvailable();
const FIXED_NOW = new Date("2026-09-14T12:00:00.000Z");

/** The draft's content, as needles. Distinctive so "the response does not contain it" is real. */
const SUBJECT = "Glaze order for the Tuesday kiln";
const BODY = "the celadon batch is ready whenever you are";
const RECIPIENT = "giulia@lichtgrat.example";

let owned: OwnedDb;
let db: Db;
const app = createApp(apiRoutes);

function depsFor(): ApiDeps {
  const authDeps = makeTestAuthDeps({});
  return perRequest({
    db,
    now: () => FIXED_NOW,
    requestId: `replay-${randomUUID()}`,
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
      // Required by `ApiServices`; nothing in this file dials IMAP. The real port is the one
      // `packages/api/test/helpers.ts` wires — this fixture's subject is the replay.
      imapAdmission: { acquire: acquireImapSlot, release: releaseImapSlot },
    },
  });
}

const createDraft = (o: { bearer: string; key: string; mailboxId: string }): Request =>
  new Request("http://localhost/drafts", {
    method: "POST",
    headers: {
      authorization: `Bearer ${o.bearer}`,
      "content-type": "application/json",
      "idempotency-key": o.key,
    },
    body: JSON.stringify({
      mailboxId: o.mailboxId, subject: SUBJECT, body: BODY, to: [{ address: RECIPIENT }],
    }),
  });

/** account + verified user + bearer session + one mailbox. */
async function seed(): Promise<{ token: string; accountId: string; mailboxId: string; address: string }> {
  const token = generateToken();
  const [acct] = await db.insert(accounts).values({ name: `replay-${randomUUID()}` }).returning();
  const [user] = await db.insert(users).values({
    accountId: acct!.id, email: `r-${randomUUID()}@example.com`, displayName: "R",
    emailVerifiedAt: FIXED_NOW,
  }).returning();
  await db.insert(sessions).values({
    accountId: acct!.id, userId: user!.id, familyId: randomUUID(),
    accessTokenHash: hashToken(token),
    accessExpiresAt: new Date(FIXED_NOW.getTime() + 3_600_000),
    refreshExpiresAt: new Date(FIXED_NOW.getTime() + 7_200_000),
    // The erase door is behind `withStepUp`; this fixture's subject is the replay, not the door.
    lastTwofaAt: FIXED_NOW,
  });
  const address = `m-${randomUUID().slice(0, 8)}@lichtgrat.example`;
  const [mb] = await db.insert(mailboxes).values({
    accountId: acct!.id, provider: "imap", address,
  }).returning();
  return { token, accountId: acct!.id, mailboxId: mb!.id, address };
}

/** Erase the mailbox the way the product does — through the route, with the confirmation. */
async function eraseMailbox(o: { token: string; mailboxId: string; address: string }): Promise<Response> {
  const q = `erase=1&confirm=${encodeURIComponent(o.address)}`;
  return app.handle(new Request(`http://localhost/mailboxes/${o.mailboxId}?${q}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${o.token}` },
  }), depsFor());
}

describe.skipIf(!PG_UP)("an idempotency replay after an erasure", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    owned = makeOwnedDb(PG_TEST_URL);
    db = owned.db as unknown as Db;
  }, 180_000);
  afterAll(async () => { await owned?.close(); });

  it("answers 410 and serves none of the erased draft", async () => {
    const s = await seed();
    const key = `draft-${randomUUID()}`;

    const first = await app.handle(createDraft({ bearer: s.token, key, mailboxId: s.mailboxId }), depsFor());
    expect(first.status, await first.clone().text()).toBe(201);
    // The FIRST response carries the content — which is what makes the retry's answer a reading.
    const firstText = await first.text();
    expect(firstText).toContain(SUBJECT);

    // The request STAMPS and answers 202; the worker's pass sweeps. The retry is asked in the
    // window between the two, where the draft row itself still exists — and must answer 410.
    const erased = await eraseMailbox(s);
    expect(erased.status, await erased.clone().text()).toBe(202);

    const retry = await app.handle(createDraft({ bearer: s.token, key, mailboxId: s.mailboxId }), depsFor());
    const retryText = await retry.text();

    expect(retry.status, retryText.slice(0, 200)).toBe(410);
    expect(retryText).not.toContain(SUBJECT);
    expect(retryText).not.toContain(BODY);
    expect(retryText).not.toContain(RECIPIENT);
    // And no second draft: the refusal is not a fall-through to the handler.
    expect(await db.select().from(draftsTable)
      .where(eq(draftsTable.accountId, s.accountId))).toHaveLength(1);
    const run = await eraseOwedMailbox(db as never, dialect(db as never), {
      accountId: s.accountId, mailboxId: s.mailboxId, now: () => FIXED_NOW, maxSteps: 10,
    });
    expect(run.done, "the pass did not finish the erasure").toBe(true);
    expect(await db.select().from(draftsTable)
      .where(eq(draftsTable.accountId, s.accountId))).toHaveLength(0);

    // The row is still there — stamped and blank. Deleting it would let the retry re-apply.
    const rows = await db.select().from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.accountId, s.accountId), eq(idempotencyKeys.key, key)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.erasedAt).not.toBeNull();
    expect(JSON.stringify(rows[0]!.responseJson)).not.toContain(SUBJECT);
  }, 60_000);

  it("a SIBLING mailbox's retry still replays its own answer, through the stamp and the sweep", async () => {
    // IDEMPOTENCY-ERASURE-IS-ACCOUNT-WIDE-ON-A-MAILBOX-ERASURE: the erasure blanked every stored
    // response of the account, so a lost answer in a mailbox nobody erased came back 410.
    const s = await seed();
    const [sibling] = await db.insert(mailboxes).values({
      accountId: s.accountId, provider: "imap", address: `k-${randomUUID().slice(0, 8)}@lichtgrat.example`,
    }).returning();
    const kept = `draft-${randomUUID()}`;
    const gone = `draft-${randomUUID()}`;
    const first = await app.handle(createDraft({ bearer: s.token, key: kept, mailboxId: sibling!.id }), depsFor());
    const firstBody = await first.json() as { id: string };
    expect(first.status).toBe(201);
    await app.handle(createDraft({ bearer: s.token, key: gone, mailboxId: s.mailboxId }), depsFor());

    expect((await eraseMailbox(s)).status).toBe(202);
    const retry = async (key: string, mailboxId: string) =>
      app.handle(createDraft({ bearer: s.token, key, mailboxId }), depsFor());
    const atStamp = await retry(kept, sibling!.id);
    expect(atStamp.status, "the sibling's retry was refused at the stamp").toBe(201);
    expect((await atStamp.json() as { id: string }).id).toBe(firstBody.id);
    expect((await retry(gone, s.mailboxId)).status, "the erased mailbox's retry replayed").toBe(410);

    const run = await eraseOwedMailbox(db as never, dialect(db as never), {
      accountId: s.accountId, mailboxId: s.mailboxId, now: () => FIXED_NOW, maxSteps: 10,
    });
    expect(run.done).toBe(true);
    const atFinish = await retry(kept, sibling!.id);
    expect(atFinish.status, "the sibling's retry was refused at the sweep's finish").toBe(201);
    expect((await atFinish.json() as { id: string }).id).toBe(firstBody.id);
    expect((await retry(gone, s.mailboxId)).status).toBe(410);
    // Still ONE draft in the sibling: the replay did not run the mutation again.
    expect(await db.select().from(draftsTable).where(and(
      eq(draftsTable.accountId, s.accountId), eq(draftsTable.mailboxId, sibling!.id)))).toHaveLength(1);
  }, 60_000);

  it("POSITIVE CONTROL: an ordinary replay before any erasure still returns the same draft",
    async () => {
      const s = await seed();
      const key = `draft-${randomUUID()}`;

      const first = await app.handle(createDraft({ bearer: s.token, key, mailboxId: s.mailboxId }), depsFor());
      const firstBody = await first.json() as { id: string; subject: string };
      const again = await app.handle(createDraft({ bearer: s.token, key, mailboxId: s.mailboxId }), depsFor());
      const againBody = await again.json() as { id: string; subject: string };

      expect([first.status, again.status]).toEqual([201, 201]);
      expect(againBody.id).toBe(firstBody.id);
      expect(againBody.subject).toBe(firstBody.subject);
      // ONE draft, which is what the key is for.
      expect(await db.select().from(draftsTable)
        .where(eq(draftsTable.accountId, s.accountId))).toHaveLength(1);
    }, 60_000);
});
