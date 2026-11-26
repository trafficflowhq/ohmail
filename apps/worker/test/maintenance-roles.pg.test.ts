import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { eq, inArray, sql, type SQL } from "drizzle-orm";
import postgres from "postgres";
import {
  accounts, accountSyncState, auditLog, bindDb, changeLog, devices, erasureRemaining, mailboxes, messageBodies, messages,
  outboundSendFingerprints, outboundSends, pairingTokens, PROFILE_FOUND_AUDIT_ACTION, pruneSendFingerprints, readDrainCursor, refreshTokens, sessions, stampMailboxErasure, users, type Tx,
} from "@trafficflow/db";
import { createPolicyStatement, ensureMaintenanceIndexes } from "@trafficflow/db/admin";
import {
  API_ROLE, authEvents, claimRefundObligations, invites, LOCK_READERS, loginTokens, makeOwnedDb, pendingRefundObligations, policyList, readerStatement, READER_SCHEMA, waitlist,
  pruneChangeLogForAccount, pruneSignInRecords, recordRefundObligation, serverTables, WORKER_ROLE, type OwnedDb,
} from "@trafficflow/db/cloud";
import { realPgAvailable, ruleVerbs, throwawayDb } from "@trafficflow/db/testing";
import { MAILBOX_ERASURE_PASS_BUDGET_MS, mailboxErasurePass } from "../src/mailbox-erasure-pass.js";
import { silentLogger } from "@trafficflow/core/mail";
import { accountErasurePass } from "../src/account-erasure-pass.js";
import { refundObligationDrainPass } from "../src/refund-obligation-drain.js";
import { retentionPrunePass } from "../src/retention-prune.js";
import {
  acceptAccountErasure, deleteAccount, EMAIL_VERIFY_PURPOSE, erasureOutcome, makeAuthService, makeTestAuthDeps, MailService,
  releaseAcceptedErasure, resumeAccountErasure, SpyMailer, throttleKeysFor, type ServiceContext,
} from "@trafficflow/services";
import { bindWorker, type WorkerBinding } from "../src/start/bind.js";

const pgUp = await realPgAvailable();
const ground = throwawayDb("maintenance_roles");
const role = "test_worker_" + randomBytes(8).toString("hex");
const apiRole = "test_api_" + randomBytes(8).toString("hex");

describe.skipIf(!pgUp)("worker maintenance under the runtime account policies", () => {
  let admin: postgres.Sql;
  let worker: OwnedDb;
  let api: OwnedDb;
  let migrator: OwnedDb;
  let binding: WorkerBinding;

  beforeAll(async () => {
    await ground.createFromTemplate();
    const url = ground.url;
    admin = postgres(url, { max: 1, onnotice: () => {} });
    const password = randomBytes(20).toString("hex");
    await admin.begin(async (tx) => {
      await tx.unsafe("create schema if not exists " + READER_SCHEMA);
      for (const reader of LOCK_READERS) await tx.unsafe(readerStatement(reader));
      for (const [runtime, fixture] of [[WORKER_ROLE, role], [API_ROLE, apiRole]] as const) {
        await tx.unsafe("create role " + fixture + " login password '" + password + "'");
        await tx.unsafe("grant usage on schema " + READER_SCHEMA + ", public to " + fixture);
        for (const table of serverTables()) {
          const verbs = [...ruleVerbs(runtime, table)];
          if (verbs.length > 0) await tx.unsafe("grant " + verbs.join(", ") + ' on public."' + table + '" to ' + fixture);
        }
        for (const policy of policyList().filter((p) => p.roles.includes(runtime))) {
          await tx.unsafe('alter table public."' + policy.table + '" enable row level security');
          await tx.unsafe('alter table public."' + policy.table + '" force row level security');
          await tx.unsafe(createPolicyStatement({ ...policy, name: fixture + "_" + policy.name })
            .replace(policy.roles.map((r) => '"' + r + '"').join(", "), fixture));
        }
      }
    });
    const login = new URL(url);
    login.username = role;
    login.password = password;
    worker = makeOwnedDb(login.toString(), { role: "worker" });
    login.username = apiRole;
    api = makeOwnedDb(login.toString(), { role: "api" });
    migrator = makeOwnedDb(url);
    binding = bindWorker(worker.db);
  }, 180_000);

  afterAll(async () => {
    await worker?.close();
    await api?.close();
    await migrator?.close();
    if (admin) {
      await admin.unsafe("drop owned by " + role).catch(() => {});
      await admin.unsafe("drop role if exists " + role);
      await admin.unsafe("drop owned by " + apiRole).catch(() => {});
      await admin.unsafe("drop role if exists " + apiRole);
      await admin.end();
    }
    await ground.drop();
  });

  async function mailbox(name: "A" | "B", withMail: boolean) {
    const [{ id: accountId }] = await migrator.db.insert(accounts).values({ name }).returning({ id: accounts.id });
    const [{ id: mailboxId }] = await migrator.db.insert(mailboxes).values({
      accountId, provider: "imap", address: [randomUUID(), "example.invalid"].join("@"),
    }).returning({ id: mailboxes.id });
    if (withMail) {
      await migrator.db.insert(messages).values({
        accountId, mailboxId, dedupKey: randomUUID(), bodyHash: randomUUID(),
      });
    }
    return { accountId, mailboxId };
  }

  const forAccount = (accountId: string): Tx => binding.forAccount(accountId).db as unknown as Tx;

  function recordStatements(db: Tx, record: (query: SQL) => void): Tx {
    return new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "transaction") return Reflect.get(target, prop, receiver);
        return (fn: (tx: Tx) => Promise<unknown>) => target.transaction((raw) => {
          const tx = raw as unknown as Tx;
          return fn(new Proxy(tx, {
            get(inner, name, innerReceiver) {
              if (name !== "execute") return Reflect.get(inner, name, innerReceiver);
              return (query: SQL) => { record(query); return inner.execute(query); };
            },
          }));
        });
      },
    });
  }

  async function planNodes(db: Tx, statement: SQL): Promise<Record<string, unknown>[]> {
    const [row] = await db.execute(sql`explain (analyze, buffers, format json) ${statement}`) as unknown as [{
      "QUERY PLAN": Array<{ Plan: Record<string, unknown> }>;
    }];
    const nodes = (node: Record<string, unknown>): Record<string, unknown>[] =>
      [node, ...((node.Plans as Record<string, unknown>[] | undefined) ?? []).flatMap(nodes)];
    return nodes(row["QUERY PLAN"][0]!.Plan);
  }

  function erasureCtx(accountId: string, db: object, now = new Date()): ServiceContext {
    return { accountId, db: db as ServiceContext["db"], userId: null, now: () => now, requestId: "" };
  }

  async function erasureUser(accountId: string) {
    const [user] = await migrator.db.insert(users).values({
      accountId, email: [randomUUID(), "example.invalid"].join("@"),
    }).returning();
    return user!;
  }

  it.each(["inline", "accepted"])("redacts only the account's signup addresses during %s erasure", async (path) => {
    const a = await mailbox("A", false);
    const b = await mailbox("B", false);
    const mine = await erasureUser(a.accountId);
    const theirs = await erasureUser(b.accountId);
    const db = migrator.db;
    const [matching, consumed, other] = await db.insert(invites).values([
      { email: mine.email, codeHash: randomUUID(), expiresAt: new Date() },
      { email: [randomUUID(), "example.invalid"].join("@"), consumedByUserId: mine.id, codeHash: randomUUID(), expiresAt: new Date() },
      { email: theirs.email, codeHash: randomUUID(), expiresAt: new Date() },
    ]).returning();
    const [ownWait, otherWait] = await db.insert(waitlist).values([
      { email: mine.email }, { email: theirs.email },
    ]).returning();
    const ctx = erasureCtx(a.accountId, bindDb(api.db, { account: a.accountId }));
    let receipt;
    if (path === "inline") receipt = await deleteAccount(ctx);
    else {
      await expect(acceptAccountErasure(ctx, {})).resolves.toBe("accepted");
      receipt = await resumeAccountErasure(erasureCtx(a.accountId, forAccount(a.accountId)));
    }
    expect(receipt?.redacted).toEqual({ invites: 2, waitlist: 1 });
    const addresses = (rows: { id: string; email: string }[]) => new Map(rows.map((row) => [row.id, row.email]));
    const actualInvites = addresses(await db.select().from(invites)
      .where(inArray(invites.id, [matching!.id, consumed!.id, other!.id])));
    expect(actualInvites.get(matching!.id) === matching!.email).toBe(false);
    expect(actualInvites.get(consumed!.id) === consumed!.email).toBe(false);
    expect(actualInvites.get(other!.id) === theirs.email).toBe(true);
    const actualWaitlist = addresses(await db.select().from(waitlist)
      .where(inArray(waitlist.id, [ownWait!.id, otherWait!.id])));
    expect(actualWaitlist.get(ownWait!.id) === mine.email).toBe(false);
    expect(actualWaitlist.get(otherWait!.id) === theirs.email).toBe(true);
  });

  it("holds the account fence through a standalone sign-in audit insert", async () => {
    const a = await mailbox("A", false);
    const user = await erasureUser(a.accountId);
    const db = bindDb(api.db, { account: a.accountId });
    const auth = makeAuthService(makeTestAuthDeps());
    await admin`create function pause_audit_insert() returns trigger language plpgsql as $$
      begin perform pg_sleep(1); return new; end $$`;
    await admin`create trigger pause_audit_insert before insert on auth_events
      for each row execute function pause_audit_insert()`;
    const write = Reflect.apply(Reflect.get(auth, "audit"), auth,
      [db, user, "login_failed", "password", erasureCtx(a.accountId, db)]) as Promise<void>;
    try {
      const end = Date.now() + 4_000;
      let inserting = false;
      while (!inserting && Date.now() < end) {
        const [row] = await admin`select exists (select from pg_stat_activity
          where usename = ${apiRole} and wait_event = 'PgSleep') as inserting`;
        inserting = row?.inserting === true;
        if (!inserting) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(inserting).toBe(true);
      await expect(admin`select id from accounts where id = ${a.accountId} for update nowait`)
        .rejects.toMatchObject({ code: "55P03" });
    } finally {
      await write;
      await admin`drop trigger pause_audit_insert on auth_events`;
      await admin`drop function pause_audit_insert()`;
    }
  });

  it("reopens a completed audit step before deleting a user named by a late row", async () => {
    const a = await mailbox("A", false);
    const user = await erasureUser(a.accountId);
    const db = migrator.db;
    const ctx = erasureCtx(a.accountId, bindDb(api.db, { account: a.accountId }));
    await acceptAccountErasure(ctx, {});
    await db.update(accounts).set({ erasureProgress: sql`jsonb_set(${accounts.erasureProgress},
      '{finished}', (${accounts.erasureProgress}->'finished') || '["auth_events"]'::jsonb)` })
      .where(eq(accounts.id, a.accountId));
    await db.insert(authEvents).values({ accountId: a.accountId, userId: user.id, event: "login_failed" });
    const receipt = await resumeAccountErasure(erasureCtx(a.accountId, forAccount(a.accountId)));
    expect(receipt?.deleted).toMatchObject({ auth_events: 1, users: 1 });
  });

  it("refuses a verification resend after erasure is accepted while the user row still exists", async () => {
    const a = await mailbox("A", false);
    const b = await mailbox("B", false);
    const mine = await erasureUser(a.accountId);
    const theirs = await erasureUser(b.accountId);
    const db = migrator.db;
    const spy = new SpyMailer();
    const mail = new MailService({
      mailer: spy, config: {
        appUrl: "http://localhost:3000", siteUrl: "http://localhost:3000",
        supportEmail: ["support", "example.invalid"].join("@"),
      }, throttleKeys: throttleKeysFor(makeTestAuthDeps().keyProvider),
    });
    const auth = makeAuthService(makeTestAuthDeps({}, mail));
    const caller = (accountId: string, userId: string) => ({
      ...erasureCtx(accountId, bindDb(api.db, { account: accountId })), userId,
    });
    const ctx = caller(a.accountId, mine.id);
    await expect(acceptAccountErasure(ctx, {})).resolves.toBe("accepted");
    expect(await db.select({ id: users.id }).from(users).where(eq(users.id, mine.id))).toHaveLength(1);
    await expect(auth.resendVerification(ctx)).resolves.toEqual({ ok: true });
    await expect(auth.resendVerification(caller(b.accountId, theirs.id))).resolves.toEqual({ ok: true });
    const rows = await db.select({ userId: loginTokens.userId, purpose: loginTokens.purpose }).from(loginTokens)
      .where(inArray(loginTokens.userId, [mine.id, theirs.id]));
    expect(rows).toEqual([{ userId: theirs.id, purpose: EMAIL_VERIFY_PURPOSE }]);
    expect(spy.sent).toHaveLength(1);
  });

  it("reopens a completed token step before deleting a user named by a late verification token", async () => {
    const a = await mailbox("A", false);
    const b = await mailbox("B", false);
    const mine = await erasureUser(a.accountId);
    const theirs = await erasureUser(b.accountId);
    const db = migrator.db;
    await acceptAccountErasure(erasureCtx(a.accountId, bindDb(api.db, { account: a.accountId })), {});
    await db.update(accounts).set({ erasureProgress: sql`jsonb_set(${accounts.erasureProgress},
      '{finished}', (${accounts.erasureProgress}->'finished') || '["login_tokens"]'::jsonb)` })
      .where(eq(accounts.id, a.accountId));
    await db.insert(loginTokens).values([mine, theirs].map((user) => ({
      accountId: user.accountId, userId: user.id, tokenHash: randomUUID(), methods: [],
      purpose: EMAIL_VERIFY_PURPOSE, expiresAt: new Date(Date.now() + 60_000),
    })));
    const receipt = await resumeAccountErasure(erasureCtx(a.accountId, forAccount(a.accountId)));
    expect(receipt?.deleted).toMatchObject({ login_tokens: 1, users: 1 });
    expect(await db.select({ userId: loginTokens.userId }).from(loginTokens)
      .where(inArray(loginTokens.userId, [mine.id, theirs.id]))).toEqual([{ userId: theirs.id }]);
  });

  it("reopens a completed credential step before deleting a user named by a late pairing token", async () => {
    const a = await mailbox("A", false);
    const b = await mailbox("B", false);
    const mine = await erasureUser(a.accountId);
    const theirs = await erasureUser(b.accountId);
    const db = migrator.db;
    await acceptAccountErasure(erasureCtx(a.accountId, bindDb(api.db, { account: a.accountId })), {});
    await db.update(accounts).set({ erasureProgress: sql`jsonb_set(${accounts.erasureProgress},
      '{finished}', (${accounts.erasureProgress}->'finished') || '["pairing_tokens"]'::jsonb)` })
      .where(eq(accounts.id, a.accountId));
    await db.insert(pairingTokens).values([mine, theirs].map((user) => ({
      createdByUserId: user.id, accountId: user.accountId, grant: "device-pair", tokenHash: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    })));
    const ctx = erasureCtx(a.accountId, forAccount(a.accountId));
    let receipt = await resumeAccountErasure(ctx);
    for (let i = 0; receipt === null && i < 3; i++) receipt = await resumeAccountErasure(ctx);
    expect(receipt?.deleted).toMatchObject({ pairing_tokens: 1, users: 1 });
    expect(await db.select({ by: pairingTokens.createdByUserId }).from(pairingTokens)
      .where(inArray(pairingTokens.createdByUserId, [mine.id, theirs.id]))).toEqual([{ by: theirs.id }]);
  });

  it("cleans up a late refresh token before deleting the session it names", async () => {
    const a = await mailbox("A", false);
    const b = await mailbox("B", false);
    const mine = await erasureUser(a.accountId);
    const theirs = await erasureUser(b.accountId);
    const db = migrator.db;
    await acceptAccountErasure(erasureCtx(a.accountId, bindDb(api.db, { account: a.accountId })), {});
    await db.update(accounts).set({ erasureProgress: sql`jsonb_set(${accounts.erasureProgress},
      '{finished}', (${accounts.erasureProgress}->'finished') || '["refresh_tokens"]'::jsonb)` })
      .where(eq(accounts.id, a.accountId));
    const expires = new Date(Date.now() + 60_000);
    const lateSessions = await db.insert(sessions).values([mine, theirs].map((user) => ({
      accountId: user.accountId, userId: user.id, familyId: randomUUID(), accessTokenHash: randomUUID(),
      refreshExpiresAt: expires, accessExpiresAt: expires,
    }))).returning();
    await db.insert(refreshTokens).values(lateSessions.map((session) => ({
      accountId: session.accountId, userId: session.userId, sessionId: session.id, familyId: session.familyId,
      tokenHash: randomUUID(), expiresAt: expires,
    })));

    const receipt = await resumeAccountErasure(erasureCtx(a.accountId, forAccount(a.accountId)));
    expect(receipt?.deleted).toMatchObject({ refresh_tokens: 1, sessions: 1, users: 1 });
    const ids = lateSessions.map((session) => session.id);
    expect(await db.select({ id: sessions.id }).from(sessions).where(inArray(sessions.id, ids)))
      .toEqual([{ id: lateSessions[1]!.id }]);
    expect(await db.select({ id: refreshTokens.sessionId }).from(refreshTokens).where(inArray(refreshTokens.sessionId, ids)))
      .toEqual([{ id: lateSessions[1]!.id }]);
  });

  it("finishes data cleanup while billing is unavailable and retries the recorded failure", async () => {
    const a = await mailbox("A", false);
    const now = new Date();
    const apiCtx = erasureCtx(a.accountId, bindDb(api.db, { account: a.accountId }), now);
    const ctx = erasureCtx(a.accountId, forAccount(a.accountId), now);
    await acceptAccountErasure(apiCtx, { drainsRefunds: true });
    let attempts = 0;
    const release = async () => ++attempts === 1 ? "cancel_failed" as const : "cancelled" as const;
    await expect(releaseAcceptedErasure(ctx, release)).resolves.toBe("cancel_failed");
    await expect(resumeAccountErasure(ctx)).resolves.toMatchObject({ accountId: a.accountId });
    await expect(releaseAcceptedErasure(ctx, release)).resolves.toBe("cancel_failed");
    expect(attempts).toBe(1);
    now.setTime(now.getTime() + 60_000);
    await expect(releaseAcceptedErasure(ctx, release)).resolves.toBe("cancelled");
    await expect(releaseAcceptedErasure(ctx, release)).resolves.toBe("cancelled");
    expect(attempts).toBe(2);
  });

  it("sets a lock deadline before reading the account for erasure", async () => {
    const a = await mailbox("A", false);
    const ctx = erasureCtx(a.accountId, forAccount(a.accountId));
    await acceptAccountErasure(erasureCtx(a.accountId, bindDb(api.db, { account: a.accountId })), { drainsRefunds: true });
    let releasePromise: Promise<unknown>;
    let slicePromise: Promise<unknown>;
    await admin.begin(async (tx) => {
      await tx`select id from accounts where id = ${a.accountId} for update`;
      releasePromise = releaseAcceptedErasure(ctx, async () => "cancelled").catch((e: unknown) => e);
      slicePromise = resumeAccountErasure(ctx).catch((e: unknown) => e);
      const outcome = await Promise.race([
        Promise.all([releasePromise, slicePromise]),
        new Promise((resolve) => setTimeout(() => resolve("still waiting"), 2_500)),
      ]);
      expect(outcome).toMatchObject([{ code: "55P03" }, { code: "55P03" }]);
    }).finally(async () => { await Promise.all([releasePromise, slicePromise]); });
  });

  it("rotates past failing erasures and retries billing after data cleanup across worker restarts", async () => {
    const db = migrator.db;
    const first = new Date();
    const now = new Date(first.getTime() + 11_000);
    const ids = [];
    for (let i = 0; i < 11; i++) {
      const [{ id }] = await db.insert(accounts).values({ name: "A" }).returning({ id: accounts.id });
      const at = new Date(first.getTime() + i * 1_000);
      await acceptAccountErasure(erasureCtx(id, bindDb(api.db, { account: id }), at), { drainsRefunds: true });
      await expect(resumeAccountErasure(erasureCtx(id, forAccount(id), at))).resolves.toMatchObject({ accountId: id });
      ids.push(id);
    }
    const shardKey = "fixture-" + randomUUID();
    let available = false;
    const attempted: string[] = [];
    const releases = new Set<string>();
    const pass = () => accountErasurePass(bindWorker(worker.db).roster as unknown as Tx, silentLogger, {
      now: () => now, forAccount, shard: inArray(accounts.id, ids), shardKey,
      release: async (id) => {
        attempted.push(id);
        if (!available && id !== ids[10]) return "cancel_failed";
        releases.add(id);
        return "cancelled";
      },
    });
    await pass();
    expect(attempted).toEqual(ids.slice(0, 10));
    expect((await readDrainCursor(binding.roster as unknown as Tx, "account_erasure:" + shardKey))?.messageId).toBe(ids[9]);
    await pass();
    expect(attempted).toEqual(ids);
    await pass();
    expect(attempted).toHaveLength(11);
    available = true;
    now.setTime(now.getTime() + 60_000);
    await pass();
    await pass();
    expect(attempted).toEqual([...ids, ...ids.slice(0, 10)]);
    expect(releases).toEqual(new Set(ids));
  });

  it("resumes a stamped mailbox under the worker policies and repairs earlier erasures in its shard", async () => {
    const a = await mailbox("A", false);
    const old = await mailbox("A", false);
    const b = await mailbox("B", true);
    const db = migrator.db;
    const now = new Date();
    const [gone] = await db.insert(mailboxes).values({
      accountId: a.accountId, provider: "imap", address: [randomUUID(), "example.invalid"].join("@"),
    }).returning({ id: mailboxes.id });
    const ids = await db.insert(messages).values(Array.from({ length: 2_001 }, (_, i) => ({
      accountId: a.accountId, mailboxId: gone!.id, bodyHash: String(i), dedupKey: String(i),
    }))).returning({ id: messages.id });
    await db.insert(messageBodies).values(ids.map(({ id }) => ({ messageId: id, accountId: a.accountId, text: "body" })));
    await db.transaction(async (tx) => {
      await stampMailboxErasure(tx as unknown as Tx, { accountId: a.accountId, mailboxId: gone!.id, now });
    });
    await db.update(mailboxes).set({ erasedAt: now, erasureDoneAt: now, signature: "old" })
      .where(eq(mailboxes.id, old.mailboxId));
    const [marker] = await db.insert(auditLog).values({
      accountId: old.accountId, action: PROFILE_FOUND_AUDIT_ACTION,
      payload: { mailboxId: old.mailboxId, fingerprint: "old", heldForImport: true },
    }).returning({ id: auditLog.id });

    const opts = { now: () => now, forAccount, shard: inArray(mailboxes.accountId, [a.accountId, old.accountId]) };
    let calls = 0;
    const partial = await mailboxErasurePass(binding.roster as unknown as Tx, {
      ...opts, clock: () => calls++ < 3 ? 0 : MAILBOX_ERASURE_PASS_BUDGET_MS,
    });
    expect(partial).toMatchObject({ steps: 1, finished: 0 });
    expect(await erasureRemaining(db as unknown as Tx, a.accountId, gone!.id)).toBe(1);

    expect((await mailboxErasurePass(binding.roster as unknown as Tx, opts)).finished).toBe(1);
    const [finished] = await db.select({ at: mailboxes.erasureDoneAt }).from(mailboxes).where(eq(mailboxes.id, gone!.id));
    expect(finished?.at).not.toBeNull();
    expect(await db.select({ id: messageBodies.id }).from(messageBodies).where(eq(messageBodies.accountId, a.accountId))).toEqual([]);
    const [legacy] = await db.select({ signature: mailboxes.signature }).from(mailboxes).where(eq(mailboxes.id, old.mailboxId));
    expect(legacy?.signature).toBeNull();
    const [audit] = await db.select({ payload: auditLog.payload }).from(auditLog).where(eq(auditLog.id, marker!.id));
    expect(audit?.payload).toEqual({ mailboxId: old.mailboxId, heldForImport: true });
    expect(await erasureRemaining(db as unknown as Tx, b.accountId, b.mailboxId)).toBe(1);
  });

  it("claims and settles due refunds for multiple accounts under the worker policies", async () => {
    const a = await mailbox("A", false);
    const b = await mailbox("B", false);
    const now = new Date();
    const db = migrator.db as unknown as Tx;
    for (const { accountId } of [a, b]) {
      await recordRefundObligation(db, {
        accountId, action: "debit_draft", attempt: randomUUID(), attemptKey: randomUUID(), reason: "drafter_failed",
      }, now);
    }
    const releases: string[] = [];
    const opts = {
      now: () => now, forAccount,
      credits: {
        spend: async (): Promise<never> => { throw new Error("unexpected spend"); },
        release: async (accountId: string) => { releases.push(accountId); return "settled" as const; },
      },
    };
    const run = () => refundObligationDrainPass(binding.roster as unknown as Tx, opts);
    const drained = await Promise.all([run(), run()]);
    expect(drained.reduce((sum, r) => sum + r.settled, 0)).toBe(2);
    expect(releases.sort()).toEqual([a.accountId, b.accountId].sort());
    for (const { accountId } of [a, b]) expect(await pendingRefundObligations(db, accountId)).toEqual([]);
  });

  it("replays an expired refund claim after the external credit was already returned", async () => {
    const { accountId } = await mailbox("A", false);
    const now = new Date();
    const db = migrator.db as unknown as Tx;
    const attempt = randomUUID();
    await recordRefundObligation(db, { accountId, action: "debit_draft", attempt, attemptKey: randomUUID(),
      reason: "drafter_failed" }, now);
    await db.update(accounts).set({ erasedAt: now }).where(eq(accounts.id, accountId));
    const [claimed] = await claimRefundObligations(forAccount(accountId), now, { limit: 1, leaseMs: 50 });
    expect(claimed?.attempt).toBe(attempt);
    // The first process settled with billing and stopped before recording that receipt.
    const paid = new Set([attempt]);
    let replays = 0;
    const drained = await refundObligationDrainPass(binding.roster as unknown as Tx, {
      forAccount, now: () => new Date(now.getTime() + 100),
      credits: {
        spend: async (): Promise<never> => { throw new Error("unexpected spend"); },
        release: async (id, release) => {
          expect(id).toBe(accountId);
          expect(release.attempt).toBe(attempt);
          paid.add(release.attempt!);
          replays += 1;
          return "settled";
        },
      },
    });
    expect(drained.settled).toBe(1);
    expect(replays).toBe(1);
    expect(paid.size).toBe(1);
    expect(await pendingRefundObligations(db, accountId)).toEqual([]);
  });

  it("rotates through more than one page of accounts, including a disabled mailbox", async () => {
    const accountsOnShard = await migrator.db.insert(accounts).values(Array.from({ length: 27 }, () => ({ name: "retention" })))
      .returning({ id: accounts.id });
    const ids = accountsOnShard.map((a) => a.id).sort();
    const other = await mailbox("B", false);
    await migrator.db.insert(mailboxes).values({
      accountId: ids.at(-1)!, provider: "imap", status: "disabled", address: [randomUUID(), "example.invalid"].join("@"),
    });
    await migrator.db.insert(accountSyncState).values([...ids, other.accountId].map((accountId) => ({ accountId, nextSeq: 1n })));
    const now = new Date();
    const old = new Date(now.getTime() - 60 * 86_400_000);
    await migrator.db.insert(changeLog).values([...ids, other.accountId].map((accountId) => ({
      accountId, seq: 1n, entityType: "message", entityId: randomUUID(), op: "create", createdAt: old,
    })));
    const opts = { forAccount, shard: inArray(accounts.id, ids), shardKey: "fixture" };
    const log = { warn() {}, info() {} } as Parameters<typeof retentionPrunePass>[2];
    const floors = async () => migrator.db.select({ id: accountSyncState.accountId, floor: accountSyncState.prunedThroughSeq })
      .from(accountSyncState).where(inArray(accountSyncState.accountId, [...ids, other.accountId]));
    await Reflect.apply(retentionPrunePass, null, [binding.roster, now, log, opts]);
    expect((await floors()).filter(({ floor }) => floor === 1n)).toHaveLength(25);
    binding = bindWorker(worker.db);
    await Reflect.apply(retentionPrunePass, null, [binding.roster, now, log, opts]);
    const after = await floors();
    expect(after.filter(({ floor }) => floor === 1n)).toHaveLength(27);
    expect(after.find(({ id }) => id === other.accountId)?.floor).toBe(0n);
  });

  it("walks compaction candidates a page at a time even when the first page has no victims", async () => {
    const { accountId } = await mailbox("A", false);
    const edge = 9_007_199_254_740_993n;
    const now = new Date();
    const old = new Date(now.getTime() - 60 * 86_400_000);
    const a = randomUUID(), b = randomUUID();
    await migrator.db.insert(accountSyncState).values({ accountId, nextSeq: edge + 4n });
    await migrator.db.insert(changeLog).values([
      { seq: edge, entityId: a, op: "create" },
      { seq: edge + 1n, entityId: b, op: "create" },
      { seq: edge + 2n, entityId: a, op: "update" },
      { seq: edge + 3n, entityId: b, op: "update" },
      { seq: edge + 4n, entityId: a, op: "move", meta: { from: null, to: "INBOX" } },
    ].map((r) => ({ ...r, accountId, entityType: "message", createdAt: old })));
    const opts = { hosted: true, batch: 2, maxBatches: 1 };
    const prune = () => pruneChangeLogForAccount(forAccount(accountId), accountId, now, opts);
    expect(await prune()).toEqual({ prunedThroughSeq: edge + 4n, deleted: 0 });
    expect((await prune()).deleted).toBe(2);
    expect((await prune()).deleted).toBe(0);
    const left = await migrator.db.select({ seq: changeLog.seq }).from(changeLog)
      .where(eq(changeLog.accountId, accountId)).orderBy(changeLog.seq);
    expect(left.map(({ seq }) => seq)).toEqual([edge, edge + 1n, edge + 4n]);
  });

  it("visits only the requested candidate page in a large history with no victims on that page", async () => {
    const { accountId } = await mailbox("A", false);
    const now = new Date();
    const old = new Date(now.getTime() - 60 * 86_400_000);
    const db = migrator.db;
    await ensureMaintenanceIndexes(db, { concurrently: false });
    await db.insert(accountSyncState).values({ accountId, nextSeq: 300_000n, prunedThroughSeq: 300_000n });
    await db.execute(sql`
      insert into change_log (account_id, seq, entity_type, entity_id, op, created_at)
      select ${accountId}::uuid, n, 'message', gen_random_uuid(), 'create', ${old.toISOString()}::timestamptz
      from generate_series(1, 300000) n
    `);
    await db.execute(sql`analyze change_log`);
    const bound = forAccount(accountId);
    let statement: SQL | undefined;
    const recorded = recordStatements(bound, (query) => { statement = query; });
    const result = await pruneChangeLogForAccount(recorded, accountId, now, { hosted: true, batch: 100, maxBatches: 1 });
    expect(result).toEqual({ prunedThroughSeq: 300_000n, deleted: 0 });
    expect(statement).toBeDefined();
    const plan = await planNodes(bound, statement!);
    expect(plan.some((node) => node["Node Type"] === "WindowAgg")).toBe(false);
    expect(plan.find((node) => node["Subplan Name"] === "CTE candidates")?.["Actual Rows"]).toBe(100);
  }, 90_000);

  it("bounds hosted floor discovery and revisits rows as the horizon ages", async () => {
    const a = await mailbox("A", false);
    const b = await mailbox("B", false);
    const now = new Date();
    const old = new Date(now.getTime() - 60 * 86_400_000);
    const aged = new Date(now.getTime() + 60 * 86_400_000);
    const db = migrator.db;
    for (const { accountId } of [a, b]) {
      await db.insert(accountSyncState).values({ accountId, nextSeq: 150_000n });
      await db.execute(sql`insert into change_log (account_id, seq, entity_type, entity_id, op, created_at)
        select ${accountId}::uuid, n, 'message', gen_random_uuid(), 'create',
          case when n <= ${accountId === a.accountId ? 25_000 : 0}
            then ${old.toISOString()}::timestamptz else ${now.toISOString()}::timestamptz end
        from generate_series(1, 150000) n`);
    }
    const prune = (id: string, at = now, handle = forAccount(id)) =>
      pruneChangeLogForAccount(handle, id, at, { hosted: true, batch: 100, maxBatches: 1 });
    let discovery: SQL | undefined;
    const bound = forAccount(b.accountId);
    const recorded = recordStatements(bound, (query) => { discovery = query; });
    expect(await prune(b.accountId, now, recorded)).toEqual({ prunedThroughSeq: 0n, deleted: 0 });
    expect(discovery).toBeDefined();
    const plan = await planNodes(bound, discovery!);
    expect(plan.find((node) => node["Subplan Name"] === "CTE floor_page")?.["Actual Rows"]).toBe(20_000);
    expect(plan.some((node) => node["Index Name"] === "change_log_account_id_seq_pk")).toBe(true);
    expect(await prune(a.accountId)).toEqual({ prunedThroughSeq: 20_000n, deleted: 0 });
    expect(await prune(a.accountId)).toEqual({ prunedThroughSeq: 25_000n, deleted: 0 });
    for (let i = 0; i < 7; i++) expect(await prune(b.accountId)).toEqual({ prunedThroughSeq: 0n, deleted: 0 });
    expect(await prune(b.accountId, aged)).toEqual({ prunedThroughSeq: 20_000n, deleted: 0 });
    const [other] = await db.select({ floor: accountSyncState.prunedThroughSeq }).from(accountSyncState)
      .where(eq(accountSyncState.accountId, a.accountId));
    expect(other?.floor).toBe(25_000n);
  }, 90_000);

  it("prunes an expired family and device under worker policies while keeping a protected sibling family", async () => {
    const a = await mailbox("A", false);
    const b = await mailbox("B", false);
    const db = migrator.db;
    const now = new Date();
    const old = new Date(now.getTime() - 180 * 86_400_000);
    const future = new Date(now.getTime() + 86_400_000);
    const [ua, ub] = await db.insert(users).values([a, b].map(({ accountId }) => ({
      accountId, email: [randomUUID(), "example.invalid"].join("@"),
    }))).returning({ id: users.id });
    const [da, dbb] = await db.insert(devices).values([
      { accountId: a.accountId, userId: ua!.id, kind: "web", ip: "fixture", lastSeenAt: old },
      { accountId: b.accountId, userId: ub!.id, kind: "web", ip: "fixture", lastSeenAt: old },
    ]).returning({ id: devices.id });
    const family = randomUUID();
    const [gone, protectedOne, live] = await db.insert(sessions).values([
      { accountId: a.accountId, userId: ua!.id, familyId: randomUUID(), deviceId: da!.id, refreshExpiresAt: old, revokedAt: old },
      { accountId: b.accountId, userId: ub!.id, familyId: family, deviceId: dbb!.id, refreshExpiresAt: old, revokedAt: old },
      { accountId: b.accountId, userId: ub!.id, familyId: family, deviceId: dbb!.id, refreshExpiresAt: future },
    ].map((r) => ({ ...r, accessExpiresAt: r.refreshExpiresAt, accessTokenHash: randomUUID() }))).returning();
    await db.insert(refreshTokens).values({
      accountId: a.accountId, userId: ua!.id, sessionId: gone!.id, familyId: gone!.familyId,
      tokenHash: randomUUID(), expiresAt: old, revokedAt: old,
    });
    const opts = { retentionMs: 30 * 86_400_000, forAccount };
    const out = await pruneSignInRecords(binding.roster as unknown as Tx, now, opts);
    expect(out).toMatchObject({ sessions: 1, refreshTokens: 1, deviceAddresses: 1 });
    expect(await db.select().from(refreshTokens).where(eq(refreshTokens.sessionId, gone!.id))).toEqual([]);
    const left = await db.select({ id: sessions.id }).from(sessions).where(inArray(sessions.id, [gone!.id, protectedOne!.id, live!.id]));
    expect(new Set(left.map((r) => r.id))).toEqual(new Set([protectedOne!.id, live!.id]));
    expect((await db.select({ ip: devices.ip }).from(devices).where(eq(devices.id, da!.id)))[0]?.ip).toBe("");
    expect((await db.select({ ip: devices.ip }).from(devices).where(eq(devices.id, dbb!.id)))[0]?.ip).toBe("fixture");
  });

  it("prunes a bounded page of expired fingerprints while keeping unresolved sends", async () => {
    const a = await mailbox("A", false);
    const b = await mailbox("B", false);
    const db = migrator.db;
    const now = new Date();
    const old = new Date(now.getTime() - 2 * 86_400_000);
    const [send, settled, other] = await db.insert(outboundSends).values([
      { accountId: a.accountId, status: "unverified" },
      { accountId: a.accountId, status: "sent" },
      { accountId: b.accountId, status: "sent" },
    ].map((row) => ({ ...row, idempotencyKey: randomUUID(), mintedMessageId: randomUUID() })))
      .returning({ id: outboundSends.id });
    const seed = (account: typeof a, createdAt: Date, sendId = settled!.id) => ({
      accountId: account.accountId, mailboxId: account.mailboxId, createdAt, sendId,
      fingerprint: randomBytes(32).toString("hex"),
    });
    await db.insert(outboundSendFingerprints).values([
      seed(a, old), seed(a, old), seed(a, old), seed(a, old, send!.id), seed(a, now), seed(b, old, other!.id),
    ]);
    const opts = { accountId: a.accountId, batch: 2 };
    const prune = () => Reflect.apply(pruneSendFingerprints, null, [forAccount(a.accountId), now, opts]);
    expect(await prune()).toBe(2);
    expect(await prune()).toBe(1);
    expect(await prune()).toBe(0);
    const kept = await db.select({ id: outboundSendFingerprints.accountId, sendId: outboundSendFingerprints.sendId })
      .from(outboundSendFingerprints).where(inArray(outboundSendFingerprints.accountId, [a.accountId, b.accountId]));
    expect(kept.filter((r) => r.id === a.accountId)).toHaveLength(2);
    expect(kept.some((r) => r.sendId === send!.id)).toBe(true);
    expect(kept.filter((r) => r.id === b.accountId)).toHaveLength(1);
  });

  it("commits large erasure progress, resumes after a failed slice, and serializes two worker handles", async () => {
    const a = await mailbox("A", false);
    const b = await mailbox("B", true);
    const now = new Date();
    const db = migrator.db;
    const applicant: ServiceContext = {
      accountId: a.accountId, db: db as unknown as ServiceContext["db"],
      now: () => now, requestId: "erasure-fixture", userId: null,
    };
    const runWorker = (): ServiceContext => ({
      ...applicant, db: bindWorker(worker.db).forAccount(a.accountId).db as unknown as ServiceContext["db"],
    });
    await db.execute(sql`insert into messages (account_id, mailbox_id, body_hash, dedup_key)
      select ${a.accountId}::uuid, ${a.mailboxId}::uuid, 'fixture', 'fixture-' || i
      from generate_series(1, 2_100) i`);
    await db.execute(sql`insert into message_bodies (account_id, message_id, text)
      select account_id, id, 'fixture' from messages where account_id = ${a.accountId}::uuid`);
    const bodyCount = async () => {
      const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(messageBodies)
        .where(eq(messageBodies.accountId, a.accountId));
      return r!.n;
    };
    await expect(acceptAccountErasure(applicant, { drainsRefunds: true })).resolves.toBe("accepted");
    await expect(erasureOutcome(applicant)).resolves.toBe("accepted");
    let releases = 0;
    const release = async () => { releases += 1; return "cancelled" as const; };
    await Promise.all([releaseAcceptedErasure(runWorker(), release), releaseAcceptedErasure(runWorker(), release)]);
    await expect(releaseAcceptedErasure(runWorker(), release)).resolves.toBe("cancelled");
    expect(releases).toBe(1);

    await expect(resumeAccountErasure(runWorker())).resolves.toBeNull();
    expect(await bodyCount()).toBe(1_100);
    await expect(resumeAccountErasure(runWorker())).resolves.toBeNull();
    expect(await bodyCount()).toBe(100);
    await admin.unsafe(`create function reject_erasure_slice() returns trigger language plpgsql as $$
      begin raise exception 'fixture lock timeout' using errcode = '55P03'; end $$`);
    await admin.unsafe(`create trigger reject_erasure_slice before delete on messages for each row execute function reject_erasure_slice()`);
    try {
      await expect(resumeAccountErasure(runWorker())).rejects.toMatchObject({ code: "55P03" });
      expect(await bodyCount()).toBe(100);
      expect(await erasureRemaining(db as unknown as Tx, a.accountId, a.mailboxId)).toBe(2_100);
    } finally {
      await admin.unsafe("drop trigger reject_erasure_slice on messages");
      await admin.unsafe("drop function reject_erasure_slice()");
    }
    await Promise.all([resumeAccountErasure(runWorker()), resumeAccountErasure(runWorker())]);
    const receipt = await resumeAccountErasure(runWorker());
    expect(receipt?.deleted).toMatchObject({ messages: 2_100, message_bodies: 2_100 });
    expect(await bodyCount()).toBe(0);
    expect(await erasureRemaining(db as unknown as Tx, b.accountId, b.mailboxId)).toBe(1);
    expect(await resumeAccountErasure(runWorker())).toEqual(receipt);
    await expect(erasureOutcome(applicant)).resolves.toBe("erased");
    await expect(acceptAccountErasure(applicant, { drainsRefunds: true })).resolves.toBe("erased");
    expect(releases).toBe(1);
  }, 45_000);

});
