import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accounts, attachments, mailboxes, messages, sessions, users } from "@trafficflow/db";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { reindexMessageSearch } from "@trafficflow/core/mail";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { apiRoutes, createApp, type ApiDeps } from "@trafficflow/api";
import {
  attachmentsService, awayResponderService, contactsService, draftingService, draftsService,
  generateToken, hashToken, kbService, makeApprovalService, makeAuthService, makeMailboxService,
  makePrivacyService, makeScreenerService, makeTestAuthDeps, messageService, notifyRulesService,
  proposalsService, pushService, rulesService, searchService, sendService, snippetsService,
  syncService, tagsService, threadService, triageService, workflowsService,
  type Db,
} from "@trafficflow/services";
import { DOWNLOAD_ALL_MAX_PARTS, SEARCH_QUERY_MAX_CHARS } from "@trafficflow/services/mail";

/**
 * the two bounds whose reason is a REAL-POSTGRES fact.
 *
 * PGlite is green for both of these whether or not the bound exists, which is exactly the trap
 * this repository has written down: *"PGlite green means nothing for transactional code… Three
 * production bugs were invisible to PGlite and only appeared against real Postgres."* The same
 * applies one layer along, to the protocol:
 *
 *  · **The bind-parameter ceiling is a WIRE-PROTOCOL limit.** The extended-query protocol carries
 *    the parameter count as an `int16`, so a statement's bindings are capped by it — the
 *    server refuses the statement. `POST /files/download-all` put the caller's `fileIds` straight
 *    into a SQL `IN`, so the caller chose that count. **Measured here, with the bound removed:
 *    the request answers 502 `upstream_unavailable`** — the raw route's blanket catch turns the
 *    driver's protocol error into "the mail server is having trouble", which is false,
 *    unactionable, and free to repeat. This file proves the refusal happens BEFORE the wire.
 *  · **The fuzzy search arm only exists where `pg_trgm` does.** `SearchService` degrades to an
 *    `ILIKE` when `word_similarity` is absent, which is what runs under PGlite — so a PGlite
 *    test of the `q` ceiling never touches the predicate the ceiling is FOR. Here the real
 *    trigram arm runs, and a term at the ceiling still returns its answer.
 */

const PG_UP = await realPgAvailable();
const FIXED_NOW = new Date("2026-07-28T12:00:00.000Z");

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

describe.skipIf(!PG_UP)("input bounds against real Postgres", () => {
  let owned: OwnedDb;
  let db: Db;
  let deps: ApiDeps;
  let token: string;
  let accountId: string;
  let messageId: string;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    owned = makeOwnedDb(PG_TEST_URL);
    db = owned.db as unknown as Db;
    deps = depsOn(db);

    const [acct] = await db.insert(accounts).values({ name: "bounds" }).returning();
    accountId = acct!.id;
    const [user] = await db.insert(users).values({
      accountId, email: `bounds+${accountId}@lichtgrat.example`, displayName: "B",
      emailVerifiedAt: FIXED_NOW,
    }).returning();
    token = generateToken();
    await db.insert(sessions).values({
      accountId, userId: user!.id, familyId: randomUUID(),
      accessTokenHash: hashToken(token),
      accessExpiresAt: new Date(FIXED_NOW.getTime() + 3_600_000),
      refreshExpiresAt: new Date(FIXED_NOW.getTime() + 7_200_000),
    });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `bounds+${accountId}@example.com`,
    }).returning();
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `d:${randomUUID()}`,
      subject: "quarterly report", fromAddress: "a@example.com", snippet: "the quarterly report",
      date: FIXED_NOW, unread: true,
      nativeLocator: { folder: "INBOX", ref: "1:1" },
    }).returning();
    messageId = m!.id;
    // As ingest does: the letter's search document with the letter.
    await reindexMessageSearch(db as never, accountId, messageId);
    await db.insert(attachments).values({
      accountId, messageId, filename: "one.bin", contentType: "application/octet-stream",
      sizeBytes: 10, inline: false, partId: "2",
    });
  }, 120_000);

  afterAll(async () => { await owned?.close(); });

  const call = (path: string, init: RequestInit = {}): Promise<Response> =>
    app.handle(
      new Request(`http://localhost${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
      }),
      { ...deps, session: null, idempotency: null },
    );

  it("refuses a fileIds list before it can reach the wire's 65 535-parameter ceiling", async () => {
    // Well past the protocol limit. Unbounded, this became one `IN` past that ceiling and
    // the driver's own refusal, which this raw route's blanket catch reports as 502
    // `upstream_unavailable` — measured, not assumed. That is the reason the 200-part ceiling had
    // to move ahead of the predicate rather than behind it: the failure blames the user's mail
    // server for a request our own driver rejected.
    const fileIds = Array.from({ length: 70_000 }, () => randomUUID());

    const res = await call("/files/download-all", {
      method: "POST", body: JSON.stringify({ fileIds }),
    });

    expect(res.status).toBe(413);
    const body = await res.json() as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe("payload_too_large");
    expect(body.error?.message).toContain(String(DOWNLOAD_ALL_MAX_PARTS));
  });

  it("a fileIds list AT the ceiling is a statement real Postgres accepts", async () => {
    // 200 parameters plus the account predicate — comfortably legal, and the point is that the
    // bound is set below the protocol limit rather than at it.
    const fileIds = Array.from({ length: DOWNLOAD_ALL_MAX_PARTS }, () => randomUUID());

    const res = await call("/files/download-all", {
      method: "POST", body: JSON.stringify({ fileIds }),
    });

    // 404 (none of these ids is in this account) — the query RAN and matched nothing, which is
    // the outcome that proves the statement was legal. Never a 500.
    expect(res.status).toBe(404);
  });

  it("bounds `q` on the arm that only exists here — the real pg_trgm predicate", async () => {
    const over = await call(`/search?q=${"a".repeat(SEARCH_QUERY_MAX_CHARS + 1)}`);
    expect(over.status).toBe(400);
    const body = await over.json() as { error?: { message?: string } };
    expect(body.error?.message).toContain(String(SEARCH_QUERY_MAX_CHARS));

    // …and the ceiling refuses nothing real: a term AT it still runs both arms and answers.
    const at = await call(`/search?q=${"report".padEnd(SEARCH_QUERY_MAX_CHARS, "x")}`);
    expect(at.status).toBe(200);

    // The control that makes the above mean something: an ordinary term finds the seeded row
    // through the same query, so this account and this index are genuinely searchable.
    const hit = await call("/search?q=quarterly");
    expect(hit.status).toBe(200);
    const found = await hit.json() as { items: Array<{ id: string }> };
    expect(found.items.map((i) => i.id)).toContain(messageId);
  });
});
