import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiRoutes, createApp, type ApiDeps } from "@trafficflow/api";
import {
  accounts, accountStorage, bindDb, awayReplies, awayResponders, drafts, folderState, mailboxes, messageBodies, messages,
  outboundSends, outboundSentCopies, sessions, UNMETERED_ACCESS,
  type AccessLifecycle, type AccessVerdict, type EntitlementsPort, type StorageOffer,
} from "@trafficflow/db";
import { createPolicyStatement } from "@trafficflow/db/admin";
import {
  ACCOUNT_SETTING, API_ROLE, KEY_SETTING, LOCK_READERS, PASS_ROSTERS, READER_SCHEMA, WORKER_ROLE, accountLifecycleNotices, authThrottle, lockedTables, makeOwnedDb,
  policiesFor, policyList, readerStatement, storageMailSent, type OwnedDb, type PassRosterTable,
} from "@trafficflow/db/cloud";
import {
  MIGRATED_DB_SETUP_BUDGET_MS, MIGRATED_DB_TEARDOWN_BUDGET_MS, realPgAvailable, throwawayDb,
} from "@trafficflow/db/testing";
import { type OutboundMessage, type SendAdapter } from "@trafficflow/core";
import { makeAuthService, makeMailService, makeTestAuthDeps, makeUnsubscribeService, SpyMailer, throttleKeysFor, type Db } from "@trafficflow/services";
import { rosterOf } from "../src/pass-roster.js";
import { perRequest, req, seedSession } from "./helpers.js";

const pgUp = await realPgAvailable();
const ground = throwawayDb("internal_passes_row_security");
const app = createApp(apiRoutes);
const shared = randomUUID();
const day = 86_400_000;
const now = new Date();
const at = (ms: number) => new Date(now.getTime() + ms);
const address = (name: string) => `${name}-${randomUUID()}${String.fromCharCode(64)}example.test`;
const messageId = () => `<${address("message")}>`;

describe.skipIf(!pgUp)("internal passes under forced row security", () => {
  let admin: OwnedDb;
  let runtime: OwnedDb;
  let db: Db;
  const authDeps = makeTestAuthDeps();
  const mailer = new SpyMailer();
  const customerMail = makeMailService({
    mailer, config: { appUrl: "http://localhost:3001", siteUrl: "http://localhost:3000", supportEmail: address("help") },
    throttleKeys: throttleKeysFor(authDeps.keyProvider),
  });
  const unsubscribe = makeUnsubscribeService({
    post: { async post() { throw new Error("unexpected network call"); } },
    resolver: { async resolve() { return []; } },
    trustedAuthservIdsFor: async () => new Set(),
  });
  const auth = makeAuthService({ ...authDeps, mail: customerMail });
  const verdicts = new Map<string, AccessVerdict>();
  const access = async (id: string) => verdicts.get(id) ?? UNMETERED_ACCESS;
  const entitlementsPort: EntitlementsPort = {
    access, accessOrFault: access, spend: async () => ({ verdict: "fault" }), release: async () => "settled",
    manageLink: async () => null, releaseAccount: async () => "none",
  };
  const sent: OutboundMessage[] = [];
  const copied: string[] = [];
  const sendAdapter = async (): Promise<SendAdapter> => ({
    async send(letter) { sent.push(letter); return { providerMessageId: messageId() }; },
    async messageInSent() { return true; },
    async fileSentCopy(_raw, id) { copied.push(id); return null; },
    async close() {},
  });

  beforeAll(async () => {
    await ground.createFromTemplate();
    admin = makeOwnedDb(ground.url);
    db = admin.db as unknown as Db;
    const ddl = (statement: string) => admin.db.execute(sql.raw(statement));
    for (const role of [API_ROLE, WORKER_ROLE]) {
      await ddl(`do $$ begin create role ${role} nologin; exception when duplicate_object then null; end $$`);
    }
    await ddl(`grant select, insert, update, delete on all tables in schema public to ${API_ROLE}`);
    await ddl(`create schema ${READER_SCHEMA}`);
    await ddl(`grant usage on schema ${READER_SCHEMA} to ${API_ROLE}`);
    for (const reader of LOCK_READERS) await ddl(readerStatement(reader));
    for (const policy of policiesFor(policyList(), new Set([API_ROLE, WORKER_ROLE]))) {
      await ddl(createPolicyStatement(policy));
    }
    for (const table of lockedTables()) {
      await ddl(`alter table public."${table}" enable row level security`);
      await ddl(`alter table public."${table}" force row level security`);
    }
    const url = new URL(ground.url);
    url.searchParams.set("options", `-c role=${API_ROLE}`);
    runtime = makeOwnedDb(url.toString(), { role: "api" });
    const [role] = await runtime.db.execute(sql`
      select current_user = ${API_ROLE} and not rolsuper and not rolbypassrls as restricted
      from pg_roles where rolname = current_user
    `);
    expect(role?.restricted).toBe(true);
  }, MIGRATED_DB_SETUP_BUDGET_MS);

  afterAll(async () => {
    await Promise.all([runtime?.close(), admin?.close()]);
    await ground.drop();
  }, MIGRATED_DB_TEARDOWN_BUDGET_MS);

  function requestDeps(adapter = sendAdapter) {
    return perRequest({
      ...({
        now: () => now, requestId: randomUUID(), session: null,
        authConfig: authDeps.config, keyProvider: authDeps.keyProvider, alerts: { secret: shared },
        services: { auth, customerMail, entitlementsPort, sendAdapter: adapter, unsubscribe },
      } as unknown as Omit<ApiDeps, "db">), db: runtime.db as unknown as Db,
    });
  }

  async function checkRoster(table: PassRosterTable, due: string, other: string, accountId: string) {
    const read = await rosterOf(requestDeps(), table);
    expect(read).toBeDefined();
    const ids = await read!(500);
    expect(ids.map((row) => row.id)).toContain(due);
    expect(ids.map((row) => row.id)).not.toContain(other);
    const projection = sql`select ${sql.identifier(PASS_ROSTERS[table].id)} as id from public.${sql.identifier(table)}`;
    expect(await bindDb(runtime.db, { account: null }).execute(projection)).toHaveLength(0);
    expect(await bindDb(runtime.db, { account: null, key: randomUUID() }).execute(projection)).toHaveLength(0);
    expect(() => bindDb(runtime.db, { account: null, key: "ohmail:passes" })).toThrow("reserved door key");
    await runtime.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config(${ACCOUNT_SETTING}, ${accountId}, true),
        set_config(${KEY_SETTING}, 'ohmail:passes', true)`);
      const rows = await tx.execute(projection);
      expect(rows.map((row) => row.id)).not.toContain(due);
    });
  }

  async function pass(path: string, adapter = sendAdapter) {
    const response = await app.handle(req("GET", path, { bearer: shared }), requestDeps(adapter));
    expect(response.status).toBe(200);
    return response.json();
  }

  async function mailbox(accountId: string, smtpMaxSizeBytes: number | null = 500_000) {
    const [row] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: address("mailbox"), status: "connected",
      organizerRole: "organizer", smtpMaxSizeBytes,
    }).returning({ id: mailboxes.id });
    return row!.id;
  }

  async function draft(accountId: string, mailboxId: string, status: string, sendAt: Date | null) {
    const [row] = await db.insert(drafts).values({
      accountId, mailboxId, status, sendAt, sendKey: sendAt ? randomUUID() : null,
      to: [{ address: address("recipient"), name: null }], subject: "A letter", body: "Some text",
    }).returning({ id: drafts.id });
    return row!.id;
  }

  it("sends a due appointment once and leaves a future appointment in another account", async () => {
    const a = await seedSession(db, { now });
    const b = await seedSession(db, { now });
    const due = await draft(a.accountId, await mailbox(a.accountId), "scheduled", at(-60_000));
    const future = await draft(b.accountId, await mailbox(b.accountId), "scheduled", at(day));
    await checkRoster("drafts", due, future, b.accountId);
    const before = sent.length;
    expect(await pass("/internal/sends/scheduled/run")).toMatchObject({ sent: 1 });
    expect(await pass("/internal/sends/scheduled/run")).toMatchObject({ sent: 0 });
    expect(sent.length - before).toBe(1);
    const [delivered] = await db.select({ status: drafts.status }).from(drafts).where(eq(drafts.id, due));
    const [waiting] = await db.select({ status: drafts.status }).from(drafts).where(eq(drafts.id, future));
    expect(delivered?.status).toBe("sent");
    expect(waiting?.status).toBe("scheduled");
  });

  it("counts an overdue appointment only once when recovery and scheduled work share a pass", async () => {
    const account = await seedSession(db, { now });
    const mailboxId = await mailbox(account.accountId);
    const stranded = await draft(account.accountId, mailboxId, "draft", at(-20 * 60_000));
    const overdue = await draft(account.accountId, mailboxId, "scheduled", at(-12 * 60_000));
    const before = sent.length;
    const result = await pass("/internal/sends/scheduled/run");
    const delivered = sent.length - before;
    expect(delivered).toBe(2);
    expect(result).toMatchObject({ claimed: delivered, sent: delivered });
    const rows = await db.select({ status: drafts.status }).from(drafts).where(inArray(drafts.id, [stranded, overdue]));
    expect(rows).toEqual([{ status: "sent" }, { status: "sent" }]);
  });

  it("recovers a stranded draft even when the scheduled batch is full", async () => {
    const queued = await seedSession(db, { now });
    const stranded = await seedSession(db, { now });
    const sending = await mailbox(queued.accountId);
    for (let i = 0; i < 4; i++) await draft(queued.accountId, sending, "scheduled", at(-60_000));
    const recovery = await draft(stranded.accountId, await mailbox(stranded.accountId), "draft", at(-20 * 60_000));
    expect(await pass("/internal/sends/scheduled/run")).toMatchObject({ sent: 3 });
    const [row] = await db.select({ status: drafts.status }).from(drafts).where(eq(drafts.id, recovery));
    expect(row?.status).toBe("sent");
  });

  it("answers one arrival once and leaves a disabled responder alone", async () => {
    const a = await seedSession(db, { now });
    const b = await seedSession(db, { now });
    const first = await mailbox(a.accountId);
    const second = await mailbox(b.accountId);
    const responders: string[] = [];
    for (const [accountId, mailboxId, enabled] of [[a.accountId, first, true], [b.accountId, second, false]] as const) {
      const [responder] = await db.insert(awayResponders).values({
        accountId, enabled, enabledAt: at(-day), body: "Back Monday.", audience: "everyone", throttle: "per_message",
      }).returning({ id: awayResponders.id });
      responders.push(responder!.id);
      const [row] = await db.insert(messages).values({
        accountId, mailboxId, messageIdHeader: messageId(), bodyHash: randomUUID(), dedupKey: randomUUID(),
        subject: "Hello", fromAddress: address("sender"), date: at(-60_000), createdAt: at(-60_000),
      }).returning({ id: messages.id });
      await db.insert(messageBodies).values({ messageId: row!.id, accountId, text: "Hello", headers: {} });
      await db.insert(folderState).values({
        messageId: row!.id, accountId, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us",
      });
    }
    await checkRoster("away_responders", responders[0]!, responders[1]!, b.accountId);
    const before = sent.length;
    expect(await pass("/internal/away/run")).toMatchObject({ sent: 1 });
    expect(await pass("/internal/away/run")).toMatchObject({ sent: 0 });
    expect(sent.length - before).toBe(1);
    expect(await db.select({ id: awayReplies.id }).from(awayReplies).where(eq(awayReplies.accountId, a.accountId))).toHaveLength(1);
    expect(await db.select({ id: awayReplies.id }).from(awayReplies).where(eq(awayReplies.accountId, b.accountId))).toHaveLength(0);
  });

  it("reaps a stale browser session and leaves a fresh session alone", async () => {
    const stale = await seedSession(db, { now });
    const fresh = await seedSession(db, { now });
    await db.update(sessions).set({ lastSeenAt: at(-91 * day), refreshExpiresAt: at(-day) })
      .where(eq(sessions.id, stale.sessionId));
    await checkRoster("sessions", stale.sessionId, fresh.sessionId, fresh.accountId);
    expect(await pass("/internal/sessions/reap")).toMatchObject({ reaped: 1 });
    expect(await pass("/internal/sessions/reap")).toMatchObject({ reaped: 0 });
    const [kept] = await db.select({ revokedAt: sessions.revokedAt }).from(sessions).where(eq(sessions.id, fresh.sessionId));
    expect(kept?.revokedAt).toBeNull();
  });

  it("probes an overdue unknown SMTP size and leaves a known size alone", async () => {
    const a = await seedSession(db, { now });
    const b = await seedSession(db, { now });
    const due = await mailbox(a.accountId, null);
    const known = await mailbox(b.accountId);
    await checkRoster("mailboxes", due, known, b.accountId);
    expect(await pass("/internal/mailboxes/smtp-size")).toMatchObject({ considered: 1, stamped: 1 });
    const [attempted] = await db.select({ at: mailboxes.smtpSizeProbedAt }).from(mailboxes).where(eq(mailboxes.id, due));
    const [kept] = await db.select({ at: mailboxes.smtpSizeProbedAt }).from(mailboxes).where(eq(mailboxes.id, known));
    expect(attempted?.at).toBeInstanceOf(Date);
    expect(kept?.at).toBeNull();
  });

  it.each([95, 96])("settles a pending send behind %i expired unverified sends from other accounts", async (count) => {
    const expiredAt = at(-3 * day);
    const accountsWithExpiredSends = await db.insert(accounts).values(
      Array.from({ length: count }, () => ({ name: "Expired verification" })),
    ).returning({ id: accounts.id });
    const expiredMailboxes = await db.insert(mailboxes).values(accountsWithExpiredSends.map(({ id }) => ({
      accountId: id, provider: "imap", address: address("mailbox"), status: "connected", smtpMaxSizeBytes: 500_000,
    }))).returning({ accountId: mailboxes.accountId, id: mailboxes.id });
    const expiredDrafts = await db.insert(drafts).values(expiredMailboxes.map(({ accountId, id }) => ({
      accountId, mailboxId: id, status: "unverified", createdAt: expiredAt, updatedAt: expiredAt,
    }))).returning({ accountId: drafts.accountId, id: drafts.id });
    const expiredSends = await db.insert(outboundSends).values(expiredDrafts.map(({ accountId, id }) => ({
      accountId, draftId: id, status: "unverified", idempotencyKey: randomUUID(), mintedMessageId: messageId(),
      createdAt: expiredAt,
    }))).returning({ id: outboundSends.id });

    const fresh = await seedSession(db, { now });
    const draftId = await draft(fresh.accountId, await mailbox(fresh.accountId), "sending", null);
    const [pending] = await db.insert(outboundSends).values({
      accountId: fresh.accountId, draftId, idempotencyKey: randomUUID(), mintedMessageId: messageId(),
      createdAt: at(-12 * 60_000),
    }).returning({ id: outboundSends.id });
    try {
      expect(await pass("/internal/sends/reconcile/run")).toMatchObject({ sent: 1 });
      const [settled] = await db.select({ status: outboundSends.status })
        .from(outboundSends).where(eq(outboundSends.id, pending!.id));
      expect(settled?.status).toBe("sent");
    } finally {
      await db.delete(outboundSends).where(inArray(outboundSends.id, [...expiredSends.map(({ id }) => id), pending!.id]));
    }
  });

  it("verifies an old queued send in Sent and leaves a fresh reservation alone", async () => {
    const a = await seedSession(db, { now });
    const b = await seedSession(db, { now });
    async function pending(accountId: string, createdAt: Date) {
      const draftId = await draft(accountId, await mailbox(accountId), "sending", null);
      const [row] = await db.insert(outboundSends).values({
        accountId, draftId, idempotencyKey: randomUUID(), mintedMessageId: messageId(), createdAt,
      }).returning({ id: outboundSends.id });
      return row!.id;
    }
    const due = await pending(a.accountId, at(-12 * 60_000));
    const fresh = await pending(b.accountId, now);
    await checkRoster("outbound_sends", due, fresh, b.accountId);
    expect(await pass("/internal/sends/reconcile/run")).toMatchObject({ claimed: 1, sent: 1 });
    const [verified] = await db.select({ status: outboundSends.status }).from(outboundSends).where(eq(outboundSends.id, due));
    const [kept] = await db.select({ status: outboundSends.status }).from(outboundSends).where(eq(outboundSends.id, fresh));
    expect(verified?.status).toBe("sent");
    expect(kept?.status).toBe("pending");
  });

  it("verifies a reachable mailbox behind a full roster of older reservations on an error mailbox", async () => {
    const account = await seedSession(db, { now });
    const broken = await mailbox(account.accountId);
    const working = await mailbox(account.accountId);
    await db.update(mailboxes).set({ status: "error" }).where(eq(mailboxes.id, broken));
    const inFlight = await db.insert(drafts).values(Array.from({ length: 96 }, () => ({
      accountId: account.accountId, mailboxId: broken, status: "sending",
    }))).returning({ id: drafts.id });
    await db.insert(outboundSends).values(inFlight.map(({ id }) => ({
      accountId: account.accountId, draftId: id, idempotencyKey: randomUUID(), mintedMessageId: messageId(),
      createdAt: at(-60 * 60_000),
    })));
    const ready = await draft(account.accountId, working, "sending", null);
    const [send] = await db.insert(outboundSends).values({
      accountId: account.accountId, draftId: ready, idempotencyKey: randomUUID(), mintedMessageId: messageId(),
      createdAt: at(-12 * 60_000),
    }).returning({ id: outboundSends.id });
    expect(await pass("/internal/sends/reconcile/run")).toMatchObject({ sent: 1 });
    const [row] = await db.select({ status: outboundSends.status }).from(outboundSends).where(eq(outboundSends.id, send!.id));
    expect(row?.status).toBe("sent");
  });

  it("files an owed Sent copy and leaves a later copy alone", async () => {
    const a = await seedSession(db, { now });
    const b = await seedSession(db, { now });
    async function owe(accountId: string, nextAttemptAt: Date) {
      const mailboxId = await mailbox(accountId);
      const minted = messageId();
      const [row] = await db.insert(outboundSends).values({
        accountId, idempotencyKey: randomUUID(), mintedMessageId: minted, providerMessageId: minted, status: "sent",
      }).returning({ id: outboundSends.id });
      await db.insert(outboundSentCopies).values({
        accountId, mailboxId, sendId: row!.id, rawB64: Buffer.from("raw").toString("base64"), nextAttemptAt,
      });
      return row!.id;
    }
    const due = await owe(a.accountId, at(-60_000));
    const later = await owe(b.accountId, at(day));
    await checkRoster("outbound_sent_copies", due, later, b.accountId);
    const before = copied.length;
    const filing = async () => ({ ...await sendAdapter(), async messageInSent() { return false; } });
    expect(await pass("/internal/sends/sent-copies/run", filing)).toMatchObject({ filed: 1 });
    expect(copied.length - before).toBe(1);
    expect(await db.select({ id: outboundSentCopies.sendId }).from(outboundSentCopies)
      .where(eq(outboundSentCopies.sendId, due))).toHaveLength(0);
    expect(await db.select({ id: outboundSentCopies.sendId }).from(outboundSentCopies)
      .where(eq(outboundSentCopies.sendId, later))).toHaveLength(1);
  });

  it("files another account's due copy after deferring a full page of unavailable mailboxes", async () => {
    const unavailable = await seedSession(db, { now });
    const healthy = await seedSession(db, { now });
    const broken = await mailbox(unavailable.accountId);
    const working = await mailbox(healthy.accountId);
    await db.update(mailboxes).set({ status: "error" }).where(eq(mailboxes.id, broken));
    const reservations = await db.insert(outboundSends).values(Array.from({ length: 64 }, () => ({
      accountId: unavailable.accountId, idempotencyKey: randomUUID(), mintedMessageId: messageId(), status: "sent",
    }))).returning({ id: outboundSends.id });
    const rawB64 = Buffer.from("raw").toString("base64");
    await db.insert(outboundSentCopies).values(reservations.map(({ id }) => ({
      accountId: unavailable.accountId, mailboxId: broken, sendId: id, rawB64,
      nextAttemptAt: at(-3 * day), createdAt: at(-4 * day),
    })));
    const minted = messageId();
    const [owed] = await db.insert(outboundSends).values({
      accountId: healthy.accountId, idempotencyKey: randomUUID(), mintedMessageId: minted, providerMessageId: minted, status: "sent",
    }).returning({ id: outboundSends.id });
    await db.insert(outboundSentCopies).values({
      accountId: healthy.accountId, mailboxId: working, sendId: owed!.id, rawB64, nextAttemptAt: at(-60_000),
    });
    const before = copied.length;
    const filing = async () => ({ ...await sendAdapter(), async messageInSent() { return false; } });
    await pass("/internal/sends/sent-copies/run", filing);
    expect(await pass("/internal/sends/sent-copies/run", filing)).toMatchObject({ filed: 1 });
    expect(copied.length - before).toBe(1);
    expect(await db.select({ id: outboundSentCopies.sendId }).from(outboundSentCopies)
      .where(eq(outboundSentCopies.sendId, owed!.id))).toHaveLength(0);
    const deferred = await db.select({ at: outboundSentCopies.nextAttemptAt }).from(outboundSentCopies)
      .where(eq(outboundSentCopies.accountId, unavailable.accountId));
    expect(deferred).toHaveLength(64);
    expect(deferred.every((row) => row.at > now)).toBe(true);
  });

  function closed(accountId: string, erasureAt: Date | null): AccessLifecycle {
    const lifecycle: AccessLifecycle = {
      state: "closed", closedReason: "trial_ended", trialEndsAt: at(-45 * day).toISOString(), graceUntil: null,
      closedAt: at(-40 * day).toISOString(), erasureAt: erasureAt?.toISOString() ?? null,
      erasedAt: null, formerlyPaid: false, lifecycleEpoch: at(-60 * day).toISOString(),
    };
    verdicts.set(accountId, { ...UNMETERED_ACCESS, lifecycle });
    return lifecycle;
  }

  it("records a closure notice after trial and leaves another account untouched", async () => {
    const a = await seedSession(db, { now });
    const b = await seedSession(db, { now });
    closed(a.accountId, null);
    const [erased] = await db.insert(accounts).values({ name: "Removed", erasedAt: now }).returning({ id: accounts.id });
    await checkRoster("accounts", a.accountId, erased!.id, b.accountId);
    expect(await pass("/internal/account-lifecycle/run")).toMatchObject({ sent: { closed: 1 } });
    expect(await pass("/internal/account-lifecycle/run")).toMatchObject({ sent: { closed: 0 } });
    expect(await db.select({ kind: accountLifecycleNotices.kind }).from(accountLifecycleNotices)
      .where(eq(accountLifecycleNotices.accountId, a.accountId))).toEqual([{ kind: "closed" }]);
    expect(await db.select({ kind: accountLifecycleNotices.kind }).from(accountLifecycleNotices)
      .where(eq(accountLifecycleNotices.accountId, b.accountId))).toHaveLength(0);
  });

  it("erases a warned account past retention and preserves an account that is not due", async () => {
    const a = await seedSession(db, { now });
    const b = await seedSession(db, { now });
    const erasureAt = at(-2 * day);
    closed(a.accountId, erasureAt);
    await db.insert(accountLifecycleNotices).values({
      accountId: a.accountId, kind: "erasure_week", anchor: erasureAt, sentAt: at(-9 * day), deliveredAt: at(-9 * day),
    });
    expect(await pass(`/internal/account-lifecycle/erase?account=${a.accountId}`)).toEqual({ outcome: "erased" });
    expect(await pass(`/internal/account-lifecycle/erase?account=${b.accountId}`)).toEqual({ skipped: "not_due" });
    const [kept] = await db.select({ erasedAt: accounts.erasedAt }).from(accounts).where(eq(accounts.id, b.accountId));
    expect(kept?.erasedAt).toBeNull();
  });

  it("delivers one pending security notice", async () => {
    const a = await seedSession(db, { now });
    const b = await seedSession(db, { now });
    await db.insert(authThrottle).values([
      { key: `notice:factor:${a.userId}`, failures: 1, windowStartedAt: now },
      { key: `notice:ceiling:${randomUUID()}`, failures: 1, windowStartedAt: now },
    ]);
    await checkRoster("users", a.userId, b.userId, b.accountId);
    const before = mailer.sent.length;
    expect(await pass("/internal/security-notices/run")).toMatchObject({ sent: 1, dropped: 1, failed: 0 });
    expect(await pass("/internal/security-notices/run")).toMatchObject({ sent: 0, dropped: 0, failed: 0 });
    expect(mailer.sent.slice(before).map((mail) => mail.template)).toEqual(["security_notice"]);
  });

  it("backs off a failed notice and delivers a newer notice while the first waits", async () => {
    const older = await seedSession(db, { now });
    const newer = await seedSession(db, { now });
    const olderKey = `notice:ceiling:${randomUUID()}`;
    const newerKey = `notice:ceiling:${randomUUID()}`;
    await db.insert(authThrottle).values({
      key: olderKey, failures: 1, windowStartedAt: at(-60_000), noticeAccountId: older.accountId, noticeUserId: older.userId,
    });
    mailer.failNext();
    expect(await pass("/internal/security-notices/run")).toMatchObject({ sent: 0, failed: 1 });
    await db.insert(authThrottle).values({
      key: newerKey, failures: 1, windowStartedAt: now, noticeAccountId: newer.accountId, noticeUserId: newer.userId,
    });
    expect(await pass("/internal/security-notices/run")).toMatchObject({ sent: 1, dropped: 0, failed: 0 });
    const [waiting] = await db.select({ retryAt: authThrottle.lockedUntil, owed: authThrottle.failures })
      .from(authThrottle).where(eq(authThrottle.key, olderKey));
    expect(waiting?.owed).toBe(1);
    expect(waiting?.retryAt?.getTime()).toBeGreaterThan(now.getTime());
    const [finished] = await db.select({ owed: authThrottle.failures }).from(authThrottle).where(eq(authThrottle.key, newerKey));
    expect(finished?.owed).toBe(0);
  });

  it("writes one storage notice and leaves an account below the warning threshold alone", async () => {
    const a = await seedSession(db, { now });
    const b = await seedSession(db, { now });
    const room = 4_000_000_000;
    const offer: StorageOffer = {
      currency: "usd", interval: "month", plans: [{ plan: "solo", mailboxes: 2, roomBytes: room, amount: 900 }],
      addon: { unitBytes: room, amount: 100, maxUnits: 10 },
      current: { plan: "solo", addonUnits: 0, roomBytes: room, roomFrom: "now" },
      fit: { plan: "solo", addonUnits: 1, roomBytes: room * 2, amount: 1_000, keepsAll: true },
      canChange: true, reason: null,
    };
    for (const [accountId, bytes] of [[a.accountId, room * 0.95], [b.accountId, 0]] as const) {
      await db.insert(accountStorage).values({ accountId, bytes });
      verdicts.set(accountId, {
        ok: true, limits: { mailboxes: 2, storageBytes: room, canAddMailbox: true, aiEnabled: true },
        lifecycle: { ...closed(accountId, null), state: "active", closedAt: null, closedReason: null },
        storageOffer: offer,
      });
    }
    await checkRoster("account_storage", a.accountId, b.accountId, b.accountId);
    await db.update(accountStorage).set({ bytes: room * 0.5 }).where(eq(accountStorage.accountId, b.accountId));
    expect(await pass("/internal/storage-mails/run")).toMatchObject({ sent: { near: 1, full: 0 } });
    expect(await pass("/internal/storage-mails/run")).toMatchObject({ sent: { near: 0, full: 0 } });
    expect(await db.select({ level: storageMailSent.level }).from(storageMailSent)
      .where(eq(storageMailSent.accountId, a.accountId))).toEqual([{ level: "near" }]);
    expect(await db.select({ level: storageMailSent.level }).from(storageMailSent)
      .where(eq(storageMailSent.accountId, b.accountId))).toHaveLength(0);
  });

  it("keeps the unsubscribe compatibility route callable", async () => {
    expect(await pass("/internal/unsubscribe/drain")).toMatchObject({ accounts: 0, claimed: 0, delivered: 0 });
  });
});
