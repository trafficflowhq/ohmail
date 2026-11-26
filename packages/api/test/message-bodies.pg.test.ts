import { perRequest } from "./helpers.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { accounts, users, sessions, mailboxes, messages, messageBodies } from "@trafficflow/db";
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
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { planChange, commitChange, UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import type { Change } from "@trafficflow/core/mail";

/**
 * `GET /messages/bodies`, THE VERBATIM-BODY INVARIANT ON THE WIRE, ON REAL POSTGRES.
 *
 * The batch text pull is the foundation of the Cloud-local mirror, and its one load-bearing
 * property is that it serves the STORED body row VERBATIM: it never re-derives anything and never
 * rehydrates. This file pins the sharpest edge of that — a POSITIVELY-SENSITIVE message (an OTP) —
 * end to end:
 *
 *   1. it is INGESTED through the real pipeline (`planChange` → `commitChange`), which is the
 *      only writer of `message_bodies`, so the row the assertions below read is the pipeline's own
 *      write and not a fixture's guess (`pipeline.ts` stores the full `text` and full sanitized
 *      `html` for ALL mail, sensitive included);
 *   2. the wire `text` and `html` are BYTE-EQUAL to the stored row.
 *
 * ── BODY REDACTION IS GONE — AND THIS FILE WAS REALIGNED TO THE SHIPPED INTENT ─────────────
 *
 * This test used to assert `html === null` and `text` containing `[REDACTED]` for the OTP: the
 * pipeline once dropped html and blanked the code before storage. That was removed by owner
 * direction — the mailbox on the IMAP server already holds the mail unredacted, so redacting the
 * cloud/display copy hid content only from the mailbox's own OWNER, and the detector over-fired (a
 * calendar invite surfaced as "Verification code ······"). So the account holder's stored, served and
 * displayed body is now the FULL original, always, for every message including a genuine
 * verification code. The label survives (`sensitivity_category` is still written, so the surfaces
 * mark it and automatic AI still skips it) — only the withholding of the body from its owner is
 * gone. That is what the assertions below now prove: the full body reaches the user.
 *
 * ── THE PRIVACY BOUNDARY THAT REMAINS, AND IS STILL ASSERTED ───────────────────────────────
 *
 * Redaction for a MODEL is a different question asked at a different moment over the same bytes,
 * and it is untouched. `redactForModel` / `screenOutboundText` strip the credential from any
 * payload a user-pressed AI action would send — never from what the user sees. Each sensitive
 * case below therefore keeps a model-disclosure assertion: the served body carries the code, and
 * the same code is stripped the instant it is routed to the model gate. Realigning the storage
 * assertion is honouring an owner-authorised change; the model boundary is NOT weakened, and this
 * file fails if it ever stops stripping the code.
 *
 * ── WHY THIS CANNOT BE A PGlite TEST ──────────────────────────────────────────────────────
 *
 * Two reasons. The pipeline persist path is transactional (`allocateSeq` under a row lock, the
 * `message_bodies` upsert, threading) and AGENTS.md's rule is not a style preference — three
 * production bugs here were invisible to PGlite. And the endpoint is exercised over the REAL
 * router + middleware stack (`createApp`), so the route-resolution claim below — that
 * `/messages/bodies` is not swallowed by `/messages/:id` — is proven against the shipped
 * matcher rather than reasoned about.
 */

const AVAILABLE = await realPgAvailable();
const FIXED_NOW = new Date("2026-08-05T12:00:00.000Z");
const app = createApp(apiRoutes);

/** A full real-Postgres `ApiDeps`; `session: null` — the bearer resolves it through the stack. */
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

/** An OTP email — sensitive in BOTH text and html; the html part is what lets the mutation-watch bite. */
function otpEml(o: { messageId: string; code: string } = { messageId: "otp-1@bank.example", code: "482913" }): Buffer {
  return Buffer.from([
    `Message-ID: <${o.messageId}>`,
    "From: security@bank.example",
    "To: mila@lichtgrat.example",
    "Subject: Your verification code",
    "Date: Tue, 14 Jul 2026 09:41:07 +0000",
    'Content-Type: multipart/alternative; boundary="b"',
    "", "--b",
    "Content-Type: text/plain; charset=utf-8", "",
    `Your verification code is ${o.code}. It expires in 10 minutes.`,
    "", "--b",
    "Content-Type: text/html; charset=utf-8", "",
    `<html><body><p>Your verification code is <b>${o.code}</b>. It expires in 10 minutes.</p></body></html>`,
    "", "--b--", "",
  ].join("\r\n"));
}

/** An ordinary (non-sensitive) email — its html DOES survive to the wire, the contrast to the OTP. */
function plainEml(o: { messageId: string } = { messageId: "plain-1@friend.example" }): Buffer {
  return Buffer.from([
    `Message-ID: <${o.messageId}>`,
    "From: anna@friend.example",
    "To: mila@lichtgrat.example",
    "Subject: lunch?",
    "Date: Tue, 14 Jul 2026 10:00:00 +0000",
    'Content-Type: multipart/alternative; boundary="b"',
    "", "--b",
    "Content-Type: text/plain; charset=utf-8", "",
    "Are you free for lunch on Thursday?",
    "", "--b",
    "Content-Type: text/html; charset=utf-8", "",
    "<html><body><p>Are you free for lunch on Thursday?</p></body></html>",
    "", "--b--", "",
  ].join("\r\n"));
}

/** A newsletter publishing an https unsubscribe page but NO `List-Unsubscribe-Post`. */
function newsletterEml(o: { messageId: string } = { messageId: "news-1@news.example" }): Buffer {
  return Buffer.from([
    `Message-ID: <${o.messageId}>`,
    "From: hello@news.example",
    "To: mila@lichtgrat.example",
    "Subject: This week in charter boats",
    "Date: Tue, 14 Jul 2026 11:00:00 +0000",
    "List-Unsubscribe: <https://news.example/u/abc>",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Six new listings in the Balearics this week.",
    "",
  ].join("\r\n"));
}

describe.skipIf(!AVAILABLE)("GET /messages/bodies serves the stored body verbatim (real Postgres)", () => {
  let owned: OwnedDb;
  let db: Db;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    owned = makeOwnedDb(PG_TEST_URL);
    db = owned.db as unknown as Db;
  }, 180_000);

  afterAll(async () => { await owned?.close().catch(() => {}); });

  /** A fresh account + verified session + mailbox per case (the pg DB is shared). */
  async function world(): Promise<{ token: string; accountId: string; mailboxId: string }> {
    const token = generateToken();
    const [acct] = await db.insert(accounts).values({ name: `s1-${randomUUID().slice(0, 8)}` }).returning();
    const [user] = await db.insert(users).values({
      accountId: acct!.id, email: `s1-${randomUUID()}@example.com`, displayName: "Sam",
      emailVerifiedAt: FIXED_NOW,
    }).returning();
    await db.insert(sessions).values({
      accountId: acct!.id, userId: user!.id, familyId: randomUUID(),
      accessTokenHash: hashToken(token),
      accessExpiresAt: new Date(FIXED_NOW.getTime() + 3_600_000),
      refreshExpiresAt: new Date(FIXED_NOW.getTime() + 7_200_000),
    });
    const [mb] = await db.insert(mailboxes).values({
      accountId: acct!.id, provider: "imap", address: `s1-${randomUUID().slice(0, 8)}@tf.example`,
    }).returning();
    return { token, accountId: acct!.id, mailboxId: mb!.id };
  }

  /** Ingest one message through the REAL pipeline — the only writer of `message_bodies`. */
  async function ingest(
    accountId: string, mailboxId: string, raw: Buffer, ref: string,
    storageCap: number | typeof UNMETERED_STORAGE_CAP = UNMETERED_STORAGE_CAP,
  ): Promise<string> {
    const change: Change = { type: "create", locator: { folder: "INBOX", ref }, raw };
    const repo = makeDrizzleRepo(db);
    const plan = await planChange(change, { repo, accountId, mailboxId, routing: repo });
    const res = await db.transaction(async (tx) => {
      const txRepo = makeDrizzleRepo(tx as never);
      return commitChange(plan, { repo: txRepo, routing: txRepo, accountId, mailboxId, storageCap });
    });
    return res.messageId;
  }

  function get(path: string, token: string): Request {
    return new Request(`http://localhost${path}`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
    });
  }

  it("a positively-sensitive body is served in FULL to the account holder — and the code is still stripped for the model", async () => {
    const { token, accountId, mailboxId } = await world();
    const messageId = await ingest(accountId, mailboxId, otpEml(), "1:10");

    // Still CLASSIFIED sensitive — the label survives redaction's removal (the surfaces mark it and
    // automatic AI skips it). `sensitivity_category` is written only for a positive match, so this
    // is the proof the OTP hit the sensitive path rather than passing as ordinary mail.
    const [msgRow] = await db.select({ cat: messages.sensitivityCategory })
      .from(messages).where(eq(messages.id, messageId)).limit(1);
    expect(msgRow!.cat, "the OTP must classify sensitive").not.toBeNull();

    // The stored row, read straight from the table — the source of truth the wire must echo. Body
    // redaction is GONE: the FULL text and FULL sanitized html are stored, code and all.
    const [stored] = await db.select().from(messageBodies)
      .where(eq(messageBodies.messageId, messageId)).limit(1);
    expect(stored!.html, "sensitive mail now keeps its sanitized html at write time").not.toBeNull();
    expect(stored!.text).toContain("482913");                // the account's own body is the full original
    expect(stored!.text).not.toContain("[REDACTED]");        // nothing blanked on the way to storage

    const res = await app.handle(get("/messages/bodies", token), depsOn(db));
    expect(res.status).toBe(200);                            // NOT 404/500 — `/messages/bodies` ≠ `/messages/:id`
    const body = await res.json();

    const item = body.items.find((i: { messageId: string }) => i.messageId === messageId);
    expect(item, "the ingested body must be on the wire").toBeTruthy();

    // THE INVARIANT. The wire is the STORED bytes verbatim — full html, full text, code intact.
    expect(item.html).toBe(stored!.html);
    expect(item.html).not.toBeNull();
    expect(item.text).toBe(stored!.text);
    expect(item.text).toContain("482913");
    expect(Buffer.from(item.text, "utf8").equals(Buffer.from(stored!.text, "utf8"))).toBe(true);

    // The no-rehydrate guarantee, structurally: the batch item carries the body and NOTHING that
    // could reconstruct one — no `headers` bag, no attachment field.
    expect(Object.keys(item).sort()).toEqual(["html", "loadedRemoteContent", "messageId", "text"]);
  });

  it("an ordinary body keeps its html too — the contrast is now the CODE it carries, not a null", async () => {
    const { token, accountId, mailboxId } = await world();
    const messageId = await ingest(accountId, mailboxId, plainEml(), "1:11");

    const [stored] = await db.select().from(messageBodies)
      .where(eq(messageBodies.messageId, messageId)).limit(1);
    expect(stored!.html, "non-sensitive mail keeps sanitized html").not.toBeNull();

    const res = await app.handle(get("/messages/bodies", token), depsOn(db));
    const body = await res.json();
    const item = body.items.find((i: { messageId: string }) => i.messageId === messageId);
    expect(item.html).toBe(stored!.html);
  });

  it("a CAP-WITHHELD body says so on every wire — and only then does the extra key exist", async () => {
    const { token, accountId, mailboxId } = await world();
    // Cap 0: the account is at cap before the first byte, so this ingest writes the husk.
    const withheldId = await ingest(accountId, mailboxId, plainEml({ messageId: "wh-a@x.example" }), "1:30", 0);
    const storedId = await ingest(accountId, mailboxId, plainEml({ messageId: "wh-b@x.example" }), "1:31");

    // The single-message read: `withheld` present on the husk, ABSENT on the ordinary body —
    // an ordinary empty body and a withheld one must never share a wire shape.
    const single = await (await app.handle(get(`/messages/${withheldId}/body`, token), depsOn(db))).json();
    expect(single.withheld).toBe("storage_cap");
    expect(single.text).toBe("");
    // Headers still ride the single read (they always did) — the husk kept the real ones.
    expect(Object.keys(single.headers).length).toBeGreaterThan(0);
    const ordinary = await (await app.handle(get(`/messages/${storedId}/body`, token), depsOn(db))).json();
    expect("withheld" in ordinary).toBe(false);

    // The MIRROR mode carries the marker too — without it a withheld body mirrors as an empty
    // COMPLETE one and the gap query never re-asks — while the ordinary row keeps the exact
    // pinned key set (the no-rehydrate census above holds unchanged).
    const page = await (await app.handle(get("/messages/bodies", token), depsOn(db))).json();
    const wh = page.items.find((i: { messageId: string }) => i.messageId === withheldId);
    const ok = page.items.find((i: { messageId: string }) => i.messageId === storedId);
    expect(wh.withheld).toBe("storage_cap");
    expect(Object.keys(wh).sort()).toEqual(["html", "loadedRemoteContent", "messageId", "text", "withheld"]);
    expect(Object.keys(ok).sort()).toEqual(["html", "loadedRemoteContent", "messageId", "text"]);

    // The thread-open mode (?ids=) carries it with the reader fields.
    const ids = await (await app.handle(get(`/messages/bodies?ids=${withheldId}`, token), depsOn(db))).json();
    expect(ids.items[0].withheld).toBe("storage_cap");
  });

  it("keyset-pages by messages.id, scoped to the account, with an opaque cursor", async () => {
    const { token, accountId, mailboxId } = await world();
    const idA = await ingest(accountId, mailboxId, otpEml({ messageId: "pg-a@x.example", code: "111111" }), "1:20");
    const idB = await ingest(accountId, mailboxId, plainEml({ messageId: "pg-b@x.example" }), "1:21");

    // Page 1, limit 1 → exactly one item and a cursor pointing past it.
    const r1 = await app.handle(get("/messages/bodies?limit=1", token), depsOn(db));
    const p1 = await r1.json();
    expect(p1.items).toHaveLength(1);
    expect(p1.nextCursor).toBeTruthy();

    // Page 2 resumes after the cursor → the other message, and the run ends.
    const r2 = await app.handle(get(`/messages/bodies?limit=1&after=${encodeURIComponent(p1.nextCursor)}`, token), depsOn(db));
    const p2 = await r2.json();
    expect(p2.items).toHaveLength(1);

    // The two pages together are exactly this account's two messages — no repeat, no leakage.
    const seen = [p1.items[0].messageId, p2.items[0].messageId].sort();
    expect(seen).toEqual([idA, idB].sort());
    expect(p2.nextCursor).toBeNull();
  });

  it("limit is capped at 100 and a malformed cursor is a 400, not a 500", async () => {
    const { token } = await world();
    // A wild limit is clamped rather than honoured — the response is well-formed, never an error.
    const ok = await app.handle(get("/messages/bodies?limit=100000", token), depsOn(db));
    expect(ok.status).toBe(200);
    // A cursor that is not a message id must not reach Postgres as a malformed uuid (22P02 → 500).
    const bad = await app.handle(get("/messages/bodies?after=not-a-uuid", token), depsOn(db));
    expect(bad.status).toBe(400);
  });

  /* ══════════════════════════════════════════════════════════════════════════════════════════
     `?ids=` — THE THREAD OPEN, THE SECOND MODE OF THE SAME ROUTE
     ══════════════════════════════════════════════════════════════════════════════════════════

     Opening a conversation needs every sibling's body at once. The keyset mode above cannot
     express that — it pages the whole account by id — so the route gained a named-ids mode, and
     the two properties that decide whether it is safe are both asserted here against real
     Postgres, for the reasons this file's header gives.

     ── THE MUTATION-WATCH ────────────────────────────────────────────────────────────────────

     · Remove `eq(messages.accountId, ctx.accountId)` from `getBodiesByIds`'s `where` and
       "another account's id is silently ABSENT" goes red — the foreign body appears on the wire.
       Restore it and it is green.
     · Make `screenOutboundText`/`redactForModel` stop stripping code-shaped runs and "a sensitive
       message through ids-mode" goes red on the model-boundary assertion — the served body reaches
       a model payload with the code intact. That boundary is the privacy property that survived
       redaction's removal, and it is asserted in both modes. */

  it("a foreign-account id in the list is silently ABSENT — never a 404, never a body", async () => {
    /**
     * A READ, so the answer to "you do not own this" differs from the batch read-state route's,
     * and the difference is deliberate on both sides. `PATCH /messages` REJECTS the whole request
     * on a foreign id because a partial WRITE is unrepresentable. Answering 404 here would make
     * the route an existence oracle: a probe could walk ids and learn which exist in someone
     * else's account from the status code alone. Absent is the only answer that distinguishes
     * nothing — unknown, foreign and deleted are one outcome.
     */
    const mine = await world();
    const theirs = await world();
    // Different bodies on purpose, so "their text is not on the wire" is a real assertion
    // rather than one satisfied by my own copy of the same sentence.
    const myId = await ingest(mine.accountId, mine.mailboxId, newsletterEml({ messageId: "ids-mine@x.example" }), "1:30");
    const theirId = await ingest(theirs.accountId, theirs.mailboxId, plainEml({ messageId: "ids-theirs@x.example" }), "1:31");

    // Their body really is in the table — otherwise "absent" would prove nothing.
    const [stored] = await db.select().from(messageBodies)
      .where(eq(messageBodies.messageId, theirId)).limit(1);
    expect(stored, "the other account's body must exist for this test to mean anything").toBeTruthy();

    const res = await app.handle(get(`/messages/bodies?ids=${myId},${theirId}`, mine.token), depsOn(db));
    // 200, not 404: the status must not depend on whether the foreign id exists.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.map((i: { messageId: string }) => i.messageId)).toEqual([myId]);
    expect(JSON.stringify(body)).not.toContain("Are you free for lunch");
  });

  it("an id that does not exist AT ALL is absent in exactly the same way", async () => {
    // The other half of the oracle argument: a foreign id and a made-up id must be one outcome.
    const { token, accountId, mailboxId } = await world();
    const myId = await ingest(accountId, mailboxId, plainEml({ messageId: "ids-solo@x.example" }), "1:32");
    const res = await app.handle(get(`/messages/bodies?ids=${myId},${randomUUID()}`, token), depsOn(db));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.map((i: { messageId: string }) => i.messageId)).toEqual([myId]);
  });

  it("a sensitive message through ids-mode is served in FULL too — verbatim body, code still stripped for the model", async () => {
    // The invariant does not belong to one mode. This mode joins the HEADERS, which the keyset
    // mode deliberately does not, so it is a different query and owes its own proof that the
    // stored row is served verbatim and never rehydrated — and its own proof of the model boundary.
    const { token, accountId, mailboxId } = await world();
    const messageId = await ingest(accountId, mailboxId, otpEml({ messageId: "ids-otp@bank.example", code: "913482" }), "1:33");

    const [msgRow] = await db.select({ cat: messages.sensitivityCategory })
      .from(messages).where(eq(messages.id, messageId)).limit(1);
    expect(msgRow!.cat, "the OTP must classify sensitive").not.toBeNull();
    const [stored] = await db.select().from(messageBodies)
      .where(eq(messageBodies.messageId, messageId)).limit(1);
    expect(stored!.html, "sensitive mail keeps its sanitized html").not.toBeNull();

    const res = await app.handle(get(`/messages/bodies?ids=${messageId}`, token), depsOn(db));
    const item = (await res.json()).items[0];
    // Served in full to the account holder — verbatim stored bytes, code intact.
    expect(item.html).toBe(stored!.html);
    expect(item.html).not.toBeNull();
    expect(item.text).toBe(stored!.text);
    expect(item.text).toContain("913482");
    expect(item.text).not.toContain("[REDACTED]");
    // AND STILL NO HEADER BAG ON THE WIRE. The mode reads the headers to derive the posture; the
    // raw values do not cross. Anything else would be the no-rehydrate guarantee undone by the
    // mode that was allowed to join them.
    expect(Object.keys(item).sort()).toEqual(
      ["html", "loadedRemoteContent", "messageId", "text", "unsubscribe", "unsubscribeUrl"],
    );
  });

  it("ids-mode carries the unsubscribe posture the single-message route carries", async () => {
    // The reason this mode joins the headers at all: it feeds a READER opening a thread, so its
    // rows owe the same posture `GET /messages/:id/body` gives the message above them. Without
    // it a conversation's siblings would silently offer no way out where the opened one does.
    const { token, accountId, mailboxId } = await world();
    const messageId = await ingest(accountId, mailboxId, newsletterEml(), "1:34");

    const res = await app.handle(get(`/messages/bodies?ids=${messageId}`, token), depsOn(db));
    const item = (await res.json()).items[0];
    // No `List-Unsubscribe-Post`, so this is not a one-click route — the reader gets the
    // sender's own page to open in their browser instead.
    expect(item.unsubscribe).toBe("not_one_click");
    expect(item.unsubscribeUrl).toBe("https://news.example/u/abc");

    // …and the KEYSET mode still carries neither. That mode feeds the macOS local text mirror,
    // whose no-rehydrate guarantee is that it joins the body row and nothing else.
    const page = await app.handle(get("/messages/bodies", token), depsOn(db));
    const row = (await page.json()).items.find((i: { messageId: string }) => i.messageId === messageId);
    expect(Object.keys(row).sort()).toEqual(["html", "loadedRemoteContent", "messageId", "text"]);
  });

  it("more than 20 ids is a 400 — a refusal, never a silent truncation", async () => {
    // Asymmetric with `limit`, which clamps, and deliberately: a clamped page is honest because
    // it carries a cursor for the rest, while a truncated id list is indistinguishable from
    // "those messages have no body" and the caller cannot tell which of the two it got.
    const { token } = await world();
    const tooMany = Array.from({ length: 21 }, () => randomUUID()).join(",");
    const res = await app.handle(get(`/messages/bodies?ids=${tooMany}`, token), depsOn(db));
    expect(res.status).toBe(400);
    // …and exactly 20 is accepted, so the cap is the boundary rather than an approximation.
    const atCap = Array.from({ length: 20 }, () => randomUUID()).join(",");
    expect((await app.handle(get(`/messages/bodies?ids=${atCap}`, token), depsOn(db))).status).toBe(200);

    const preload = (length: number) => {
      const ids = Array.from({ length }, () => randomUUID()).join(",");
      const request = get(`/messages/bodies?ids=${ids}`, token);
      request.headers.set("x-ohmail-body-preload-limit", "40");
      return app.handle(request, depsOn(db));
    };
    expect((await preload(40)).status).toBe(200);
    expect((await preload(41)).status).toBe(400);
  });

  it("a malformed id is a 400, not a 22P02 turned into a 500", async () => {
    const { token } = await world();
    const res = await app.handle(get("/messages/bodies?ids=not-a-uuid", token), depsOn(db));
    expect(res.status).toBe(400);
  });

  it("`ids=` present but empty answers nothing — it never falls through to the keyset page", async () => {
    // A client that asks for no bodies must not be handed the account's first fifty.
    const { token, accountId, mailboxId } = await world();
    await ingest(accountId, mailboxId, plainEml({ messageId: "ids-empty@x.example" }), "1:35");
    const res = await app.handle(get("/messages/bodies?ids=", token), depsOn(db));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([]);
    expect(body.nextCursor).toBeNull();
  });
});
