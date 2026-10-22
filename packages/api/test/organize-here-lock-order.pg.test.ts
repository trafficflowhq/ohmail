import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  accounts, accountSettings, accountSyncState, changeLog, idempotencyKeys, mailboxCredentials, mailboxes,
  messageStates, messages,
} from "@trafficflow/db";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { apiRoutes, type ApiDeps } from "@trafficflow/api";
import { makeMailboxService, TriageService, type ServiceContext } from "@trafficflow/services";

/**
 * THE AGREE PRESS KEEPS THE CHAIN, ON POSTGRES: the account row, the account's `account_settings`
 * row, the mailbox row FOR UPDATE (`rule-lock-order-census.test.ts`), and its `settings` change row
 * in a short transaction of its own once the press has committed. Each case parks one party at a
 * known statement, starts the other until Postgres shows it blocked by the first, then lets the
 * first go: both commit and neither is a deadlock victim (40P01).
 *
 * Three partners. The shipped settings write, `PATCH /consent/settings` naming the mailbox (its
 * handler takes the account row FOR SHARE, the settings row, that mailbox row and the counter),
 * queues at the account row, which the press holds FOR UPDATE from its first statement: those two
 * cases hold the press against the shipped writer, and they were green before the press took the
 * settings row first as well. The probe keeps the chain from the settings row on and takes no
 * account row, so it reaches the press's own order: while the press wrote the settings row after
 * the mailbox row, each side first was a 40P01; in the chain the second party queues on the
 * settings row. The settings row exists, as it does once any settings question was answered.
 *
 * The third is a writer that takes the change-log counter BEFORE it reads the account row: triage
 * with an Idempotency-Key, on another mailbox of the account (WRITERS-READ-THE-ACCOUNT-AFTER-THE-
 * COUNTER names the shape). While the press took the counter inside its own transaction, under the
 * account row it holds FOR UPDATE, each side first was a 40P01: the triage held the counter and
 * waited on the account row, the press held the account row and waited on the counter.
 */
const PG_UP = await realPgAvailable();
const NOW = new Date("2026-10-22T10:00:00.000Z");
const owned: OwnedDb | null = PG_UP ? makeOwnedDb(PG_TEST_URL) : null;
const db = (): OwnedDb["db"] => owned!.db;
const made: string[] = [];

type Settled<T> = { ok: true; v: T } | { ok: false; e: unknown };
const settle = <T>(p: Promise<T>): Promise<Settled<T>> =>
  p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const codeOf = (e: unknown): string => {
  const x = e as { code?: unknown; cause?: { code?: unknown }; message?: unknown };
  return String(x?.code ?? x?.cause?.code ?? x?.message ?? e);
};

/** A handle whose backends carry `app` as their application name, so each party can be watched. */
function named(app: string): OwnedDb {
  const u = new URL(PG_TEST_URL);
  u.searchParams.set("application_name", app);
  return makeOwnedDb(u.toString());
}

/** The statement a backend named `waiter` waits on while a backend named `holder` blocks it. */
async function blockedBy(waiter: string, holder: string, ms = 10_000): Promise<string | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const rows = await db().execute(sql`select w.query as q from pg_stat_activity w
      where w.datname = current_database() and w.application_name = ${waiter} and w.wait_event_type = 'Lock'
        and exists (select 1 from pg_stat_activity h
          where h.application_name = ${holder} and h.pid = any(pg_blocking_pids(w.pid)))`);
    const q = (rows as unknown as Array<{ q: string }>)[0]?.q;
    if (q !== undefined) return q;
    await sleep(20);
  }
  return null;
}

/** The row a waiting statement asks for, in words. */
function rowOf(q: string | null): string {
  if (q === null) return "never waited";
  if (/"account_settings"/i.test(q)) return "the settings row";
  if (/^\s*update "mailboxes"/i.test(q) || /from "mailboxes".*for update/is.test(q)) return "the mailbox row";
  if (/from "accounts".*for (update|share)/is.test(q)) return "the account row";
  // Before the change row: the counter's UPDATE names `change_log` in its seq subquery.
  if (/"account_sync_state"/i.test(q)) return "the change-log counter";
  if (/^\s*insert into "change_log"/i.test(q)) return "the next change row";
  return q.replace(/\s+/g, " ").slice(0, 80);
}

/** A point a party stops at until `go`; `reached` resolves when it got there. */
function stop(): { reached: Promise<void>; go: () => void; at: () => Promise<void> } {
  let reach!: () => void;
  let go!: () => void;
  const reached = new Promise<void>((r) => { reach = r; });
  const gone = new Promise<void>((r) => { go = r; });
  return { reached, go, at: async () => { reach(); await gone; } };
}

interface Fixture { accountId: string; mailboxId: string }

/** A reader mailbox with a stored password and a settings row: the first consent's shape. */
async function fixture(): Promise<Fixture> {
  const accountId = randomUUID();
  const tag = accountId.slice(0, 8);
  await db().insert(accounts).values({ id: accountId, name: `frc-lo-${tag}` });
  made.push(accountId);
  const [mb] = await db().insert(mailboxes).values({
    accountId, provider: "imap", address: `frc-lo-${tag}@example.test`, organizerRole: "reader",
  }).returning();
  await db().insert(mailboxCredentials).values({
    mailboxId: mb!.id, transport: "imap", secretEnc: "not-a-real-secret", keyVersion: 1,
  });
  await db().insert(accountSettings).values({ accountId, updatedAt: NOW });
  return { accountId, mailboxId: mb!.id };
}

/** The Agree press with a window, on `h`; the allowance gate is where it can be stopped. */
const press = (h: OwnedDb, a: Fixture, allowance: () => Promise<void>) =>
  makeMailboxService({ allowance: async () => { await allowance(); } }).organizeHere({
    db: h.db as unknown as ServiceContext["db"], accountId: a.accountId, userId: null,
    now: () => NOW, requestId: `frc-lo-${randomUUID().slice(0, 8)}`,
  }, a.mailboxId, { intent: "join", screening: { dormancyDays: 120, scope: "window" } });

/** The shipped settings write: the route's own handler, switching the mailbox's folders off. */
const SETTINGS_WRITE = apiRoutes.find((r) => r.method === "PATCH" && r.pattern === "/consent/settings");
const settingsWrite = (h: OwnedDb, a: Fixture): Promise<Response> => SETTINGS_WRITE!.handler(
  new Request("http://localhost/consent/settings", {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ folderMailboxes: { [a.mailboxId]: false } }),
  }),
  {
    db: h.db, session: { accountId: a.accountId, userId: null, sessionId: null },
    now: () => NOW, requestId: `frc-lo-${randomUUID().slice(0, 8)}`,
  } as unknown as ApiDeps,
  {},
);

/** The chain from the settings row on, with no account row: the settings row, then the mailbox row. */
const probe = (h: OwnedDb, a: Fixture, between: () => Promise<void>) => h.db.transaction(async (tx) => {
  await tx.insert(accountSettings).values({ accountId: a.accountId, updatedAt: NOW })
    .onConflictDoUpdate({ target: accountSettings.accountId, set: { updatedAt: NOW } });
  await between();
  await tx.update(mailboxes).set({ foldersDisabledAt: NOW }).where(eq(mailboxes.id, a.mailboxId));
});

/** A third party holding the mailbox row FOR SHARE: the settings write stops at its mailbox UPDATE. */
async function holdMailbox(h: OwnedDb, mailboxId: string): Promise<{ release: () => void; done: Promise<void> }> {
  const s = stop();
  const done = h.db.transaction(async (tx) => {
    await tx.execute(sql`select id from mailboxes where id = ${mailboxId} for share`);
    await s.at();
  });
  await s.reached;
  return { release: s.go, done };
}

interface TriageFixture extends Fixture { messageId: string; key: string }

/**
 * The first consent's shape, plus what the triage presses: a letter in a second mailbox of the
 * account that this install already organizes (a reader does not triage), and the account's
 * counter row, as any earlier change leaves it.
 */
async function triageFixture(): Promise<TriageFixture> {
  const a = await fixture();
  const tag = a.accountId.slice(0, 8);
  const [mb] = await db().insert(mailboxes).values({
    accountId: a.accountId, provider: "imap", address: `frc-lo2-${tag}@example.test`,
    organizerRole: "organizer", organizeConsentedAt: NOW,
  }).returning();
  const [m] = await db().insert(messages).values({
    accountId: a.accountId, mailboxId: mb!.id, bodyHash: `frc-lo-${tag}`, dedupKey: `frc-lo:${tag}`,
    subject: "hello", fromAddress: `p-${tag}@example.test`, nativeLocator: { folder: "INBOX", ref: "1:7" },
  }).returning();
  await db().insert(accountSyncState).values({ accountId: a.accountId });
  return { ...a, messageId: m!.id, key: `frc-lo-key-${tag}` };
}

/** Triage with an Idempotency-Key: the counter (its two change rows), then the account row FOR SHARE (the claim's fence). */
const triage = (h: OwnedDb, a: TriageFixture) => new TriageService().setState({
  db: h.db as unknown as ServiceContext["db"], accountId: a.accountId, userId: null,
  now: () => NOW, requestId: `frc-lo-${randomUUID().slice(0, 8)}`,
}, a.messageId, { state: "reply_later" }, { idempotency: { key: a.key, requestHash: "frc-lo" } });

/**
 * A third party holding an UNCOMMITTED change row at the seq the account's next writer takes. That
 * writer allocates the seq under the counter row's lock and then waits on this transaction at its
 * own change-row insert: it stops holding the counter, before anything after its change rows. Rolled
 * back on release; the row was only ever a place to stop.
 */
async function holdNextSeq(h: OwnedDb, accountId: string): Promise<{ release: () => void; done: Promise<unknown> }> {
  const s = stop();
  const done = h.db.transaction(async (tx) => {
    const rows = await tx.execute(sql`select greatest(s.next_seq, coalesce((select max(c.seq) from change_log c
      where c.account_id = ${accountId}), 0)) + 1 as next from account_sync_state s where s.account_id = ${accountId}`);
    const next = BigInt(String((rows as unknown as Array<{ next: unknown }>)[0]!.next));
    await tx.insert(changeLog).values({ accountId, seq: next, entityType: "settings", entityId: accountId, op: "update" });
    await s.at();
    tx.rollback();
  }).catch(() => undefined);
  await s.reached;
  return { release: s.go, done };
}

/** What the press and the triage leave: the consent and its window, the letter's state and its stored answer. */
async function pressedAndTriaged(a: TriageFixture): Promise<void> {
  const [mb] = await db().select({ consented: mailboxes.organizeConsentedAt, stamp: mailboxes.takeoverAuthorizedAt })
    .from(mailboxes).where(eq(mailboxes.id, a.mailboxId));
  expect(mb!.consented, "the press's consent").not.toBeNull();
  expect(mb!.stamp, "the press's stamp").not.toBeNull();
  const [s] = await db().select({ baseline: accountSettings.screeningBaselineAt, days: accountSettings.dormancyDays })
    .from(accountSettings).where(eq(accountSettings.accountId, a.accountId));
  expect(s!.baseline, "the press's baseline").not.toBeNull();
  expect(s!.days, "the press's window").toBe(120);
  const [st] = await db().select({ state: messageStates.state }).from(messageStates)
    .where(eq(messageStates.messageId, a.messageId));
  expect(st?.state, "the triage's state").toBe("reply_later");
  const keys = await db().select({ status: idempotencyKeys.responseStatus }).from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.accountId, a.accountId), eq(idempotencyKeys.key, a.key)));
  expect(keys, "the triage's stored answer").toEqual([{ status: 200 }]);
  const doorbells = await db().select({ seq: changeLog.seq }).from(changeLog).where(and(
    eq(changeLog.accountId, a.accountId), eq(changeLog.entityType, "settings"),
  ));
  expect(doorbells, "the press's settings change row").toHaveLength(1);
}

/** What both parties' commits leave: the consent and its window, the folders switched off. */
async function landed(a: Fixture, rings: number): Promise<void> {
  const [mb] = await db().select({
    consented: mailboxes.organizeConsentedAt, stamp: mailboxes.takeoverAuthorizedAt, off: mailboxes.foldersDisabledAt,
  }).from(mailboxes).where(eq(mailboxes.id, a.mailboxId));
  expect(mb!.consented, "the press's consent").not.toBeNull();
  expect(mb!.stamp, "the press's stamp").not.toBeNull();
  expect(mb!.off, "the other party's mailbox write").not.toBeNull();
  const [s] = await db().select({ baseline: accountSettings.screeningBaselineAt, days: accountSettings.dormancyDays })
    .from(accountSettings).where(eq(accountSettings.accountId, a.accountId));
  expect(s!.baseline, "the press's baseline").not.toBeNull();
  expect(s!.days, "the press's window").toBe(120);
  const doorbells = await db().select({ seq: changeLog.seq }).from(changeLog).where(and(
    eq(changeLog.accountId, a.accountId), eq(changeLog.entityType, "settings"),
  ));
  expect(doorbells, "the settings change rows").toHaveLength(rings);
}

describe.skipIf(!PG_UP)("the Agree press takes the settings row before the mailbox row", () => {
  const open: OwnedDb[] = [];
  const party = (role: string): { name: string; h: OwnedDb } => {
    const name = `frc-lo-${role}-${randomUUID().slice(0, 8)}`;
    const h = named(name);
    open.push(h);
    return { name, h };
  };

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    expect(SETTINGS_WRITE, "PATCH /consent/settings is gone").toBeDefined();
  }, 180_000);
  afterAll(async () => {
    for (const h of open) await h.close().catch(() => {});
    if (!owned) return;
    for (const id of made) await owned.db.delete(accounts).where(eq(accounts.id, id)).catch(() => {});
    await owned.close();
  });

  // Every party is let go and settled before a reading is judged, so a red case leaves nothing open.
  it("the press first: the settings write queues at the account row, and both commit", async () => {
    const a = await fixture();
    const P = party("press");
    const W = party("write");
    const s = stop();
    const pressing = settle(press(P.h, a, s.at));
    await s.reached;
    const writing = settle(settingsWrite(W.h, a));
    const waited = rowOf(await blockedBy(W.name, P.name));
    s.go();
    const [p, w] = await Promise.all([pressing, writing]);
    expect(p.ok ? p.v.outcome : codeOf(p.e), "the press").toBe("authorized");
    expect(w.ok ? w.v.status : codeOf(w.e), "the settings write").toBe(200);
    expect(waited, "what the settings write waited on").toBe("the account row");
    await landed(a, 2);
  }, 60_000);

  it("the settings write first: the press queues at the account row, and both commit", async () => {
    const a = await fixture();
    const H = party("hold");
    const P = party("press");
    const W = party("write");
    const hold = await holdMailbox(H.h, a.mailboxId);
    const writing = settle(settingsWrite(W.h, a));
    // Stopped at its mailbox UPDATE, holding the account row FOR SHARE and the settings row.
    const stopped = rowOf(await blockedBy(W.name, H.name));
    const pressing = settle(press(P.h, a, async () => {}));
    const waited = rowOf(await blockedBy(P.name, W.name));
    hold.release();
    await hold.done;
    const [p, w] = await Promise.all([pressing, writing]);
    expect(w.ok ? w.v.status : codeOf(w.e), "the settings write").toBe(200);
    expect(p.ok ? p.v.outcome : codeOf(p.e), "the press").toBe("authorized");
    expect(stopped, "where the settings write stopped").toBe("the mailbox row");
    expect(waited, "what the press waited on").toBe("the account row");
    await landed(a, 2);
  }, 60_000);

  it("the press first, against the chain: the probe queues on the settings row, and both commit", async () => {
    const a = await fixture();
    const P = party("press");
    const Q = party("probe");
    const s = stop();
    const pressing = settle(press(P.h, a, s.at));
    await s.reached;
    const probing = settle(probe(Q.h, a, async () => {}));
    const waited = rowOf(await blockedBy(Q.name, P.name));
    s.go();
    const [p, q] = await Promise.all([pressing, probing]);
    expect(p.ok ? p.v.outcome : codeOf(p.e), "the press").toBe("authorized");
    expect(q.ok ? "committed" : codeOf(q.e), "the probe").toBe("committed");
    expect(waited, "what the probe waited on").toBe("the settings row");
    await landed(a, 1);
  }, 60_000);

  it("the probe first, against the chain: the press queues on the settings row, and both commit", async () => {
    const a = await fixture();
    const P = party("press");
    const Q = party("probe");
    const s = stop();
    const probing = settle(probe(Q.h, a, s.at));
    await s.reached;
    const pressing = settle(press(P.h, a, async () => {}));
    const waited = rowOf(await blockedBy(P.name, Q.name));
    s.go();
    const [p, q] = await Promise.all([pressing, probing]);
    expect(q.ok ? "committed" : codeOf(q.e), "the probe").toBe("committed");
    expect(p.ok ? p.v.outcome : codeOf(p.e), "the press").toBe("authorized");
    expect(waited, "what the press waited on").toBe("the settings row");
    await landed(a, 1);
  }, 60_000);

  it("the press first, against a counter-first writer: the triage queues at the account row, and both commit", async () => {
    const a = await triageFixture();
    const P = party("press");
    const T = party("triage");
    const s = stop();
    const pressing = settle(press(P.h, a, s.at));
    await s.reached;
    // Holding the counter, it reads the account row the press holds FOR UPDATE.
    const triaging = settle(triage(T.h, a));
    const waited = rowOf(await blockedBy(T.name, P.name));
    s.go();
    const [p, t] = await Promise.all([pressing, triaging]);
    expect(p.ok ? p.v.outcome : codeOf(p.e), "the press").toBe("authorized");
    expect(t.ok ? "committed" : codeOf(t.e), "the triage").toBe("committed");
    expect(waited, "what the triage waited on").toBe("the account row");
    await pressedAndTriaged(a);
  }, 60_000);

  it("the triage first, against a counter-first writer: the press commits, its doorbell queues at the counter, and both commit", async () => {
    const a = await triageFixture();
    const H = party("hold");
    const T = party("triage");
    const P = party("press");
    const hold = await holdNextSeq(H.h, a.accountId);
    // Stopped at its first change row, holding the counter; its account read is still to come.
    const triaging = settle(triage(T.h, a));
    const parked = rowOf(await blockedBy(T.name, H.name));
    const pressing = settle(press(P.h, a, async () => {}));
    const waited = rowOf(await blockedBy(P.name, T.name));
    hold.release();
    await hold.done;
    const [p, t] = await Promise.all([pressing, triaging]);
    expect(t.ok ? "committed" : codeOf(t.e), "the triage").toBe("committed");
    expect(p.ok ? p.v.outcome : codeOf(p.e), "the press").toBe("authorized");
    expect(parked, "where the triage stopped").toBe("the next change row");
    expect(waited, "what the press waited on").toBe("the change-log counter");
    await pressedAndTriaged(a);
  }, 60_000);
});
