import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import {
  accounts, accountSettings, accountSyncState, changeLog, folderOps, folderState, idempotencyKeys,
  mailboxCredentials, mailboxFolders, mailboxes, messageStates, messages,
} from "@trafficflow/db";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { apiRoutes, type ApiDeps } from "@trafficflow/api";
import {
  FolderOpsService, makeMailboxService, makeTestAuthDeps, MessageService, TriageService, type ServiceContext,
} from "@trafficflow/services";

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
 * The third is triage with an Idempotency-Key, on another mailbox of the account. It used to take
 * the change-log counter before its key's claim read the account row; while the press also took the
 * counter under the account row it holds FOR UPDATE, each side first was a 40P01. The triage now
 * reads the account row FOR SHARE as its first statement.
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

afterAll(async () => {
  if (!owned) return;
  for (const id of made) await owned.db.delete(accounts).where(eq(accounts.id, id)).catch(() => {});
  await owned.close();
});

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
  afterAll(async () => { for (const h of open) await h.close().catch(() => {}); });

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

  it("the triage first: it holds the account row from its first statement, the press queues there, and both commit", async () => {
    const a = await triageFixture();
    const H = party("hold");
    const T = party("triage");
    const P = party("press");
    const hold = await holdNextSeq(H.h, a.accountId);
    // Stopped at its first change row, holding the account row FOR SHARE and the counter.
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
    expect(waited, "what the press waited on").toBe("the account row");
    await pressedAndTriaged(a);
  }, 60_000);
});

/**
 * A KEYED PRESS BESIDE A MAILBOX CHANGE. Triage, message delete and restore, and the folder verbs
 * take the change-log counter, and their key's claim reads the account row; the mailbox changes
 * (PATCH, the Agree press run again, an OAuth reconnect, a settings save naming two mailboxes) hold
 * the account row or a mailbox row the press needs. While the claim read the account row after the
 * counter, each pair below was a 40P01: one press failed with a server error. Every press now reads
 * the account row FOR SHARE first, PATCH holds it shared unless it may re-enable the mailbox, and the
 * settings save locks its mailbox rows before the counter.
 */
interface Doors { accountId: string; a: string; b: string; addressA: string; letterA: string; letterB: string; trashed: string; folderId: string }

async function doors(): Promise<Doors> {
  const accountId = randomUUID();
  const tag = accountId.slice(0, 8);
  await db().insert(accounts).values({ id: accountId, name: `frc-lo-${tag}` });
  made.push(accountId);
  await db().insert(accountSettings).values({ accountId, foldersEnabledAt: NOW, updatedAt: NOW });
  await db().insert(accountSyncState).values({ accountId });
  const box = async (n: string): Promise<{ id: string; address: string }> => {
    const [mb] = await db().insert(mailboxes).values({
      accountId, provider: "imap", address: `frc-lo-${n}-${tag}@example.test`,
      organizerRole: "organizer", organizeConsentedAt: NOW, trashFolder: "Trash",
    }).returning();
    await db().insert(mailboxCredentials).values({
      mailboxId: mb!.id, transport: "imap", secretEnc: "not-a-real-secret", keyVersion: 1,
    });
    return { id: mb!.id, address: mb!.address };
  };
  const a = await box("a");
  const b = await box("b");
  const letter = async (mailboxId: string, i: number): Promise<string> => {
    const [m] = await db().insert(messages).values({
      accountId, mailboxId, bodyHash: `frc-lo-${tag}-${i}`, dedupKey: `frc-lo:${tag}:${i}`,
      subject: "hello", fromAddress: `p-${tag}@example.test`, nativeLocator: { folder: "INBOX", ref: `1:${i}` },
    }).returning();
    await db().insert(folderState).values({ messageId: m!.id, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "external" });
    return m!.id;
  };
  const letterA = await letter(a.id, 1);
  const letterB = await letter(b.id, 2);
  const trashed = await letter(a.id, 3);
  await db().update(folderState).set({ desiredFolder: "Trash", trashedFrom: "INBOX", lastSetBy: "us" })
    .where(eq(folderState.messageId, trashed));
  await db().update(messages).set({ deletedAt: NOW }).where(eq(messages.id, trashed));
  const [f] = await db().insert(mailboxFolders).values({ mailboxId: a.id, folder: "Projects" }).returning();
  return { accountId, a: a.id, b: b.id, addressA: a.address, letterA, letterB, trashed, folderId: f!.id };
}

const ctxOn = (h: OwnedDb, d: Doors): ServiceContext => ({
  db: h.db as unknown as ServiceContext["db"], accountId: d.accountId, userId: null,
  now: () => NOW, requestId: `frc-lo-${randomUUID().slice(0, 8)}`,
});
const keyOf = (d: Doors, door: string) => ({ key: `frc-lo-${door}-${d.accountId.slice(0, 8)}`, requestHash: "frc-lo" });
const one = async <T>(rows: Promise<T[]>): Promise<T | undefined> => (await rows)[0];

interface Door {
  name: string;
  run: (h: OwnedDb, d: Doors) => Promise<unknown>;
  /** The press's effect, read after both parties settled; `undefined` for a partner with no key. */
  landed: (d: Doors) => Promise<unknown>;
  stored?: number;
}

const triageOn = (letter: (d: Doors) => string): Door => ({
  name: "triage",
  run: (h, d) => new TriageService().setState(ctxOn(h, d), letter(d), { state: "reply_later" }, { idempotency: keyOf(d, "triage") }),
  landed: async (d) => (await one(db().select({ s: messageStates.state }).from(messageStates)
    .where(eq(messageStates.messageId, letter(d)))))?.s,
  stored: 200,
});
const TRIAGE = triageOn((d) => d.letterA);
const DELETE: Door = {
  name: "message delete",
  run: (h, d) => new MessageService().delete(ctxOn(h, d), d.letterA, { idempotency: keyOf(d, "message delete") }),
  landed: async (d) => (await one(db().select({ at: messages.deletedAt }).from(messages).where(eq(messages.id, d.letterA))))?.at !== null,
  stored: 200,
};
const RESTORE: Door = {
  name: "message restore",
  run: (h, d) => new MessageService().restore(ctxOn(h, d), d.trashed, { idempotency: keyOf(d, "message restore") }),
  landed: async (d) => (await one(db().select({ f: folderState.desiredFolder }).from(folderState)
    .where(eq(folderState.messageId, d.trashed))))?.f,
  stored: 200,
};
const opOf = async (d: Doors): Promise<string | undefined> =>
  (await one(db().select({ op: folderOps.op }).from(folderOps).where(eq(folderOps.folderId, d.folderId))))?.op;
const FOLDER_CREATE: Door = {
  name: "folder create",
  run: (h, d) => new FolderOpsService().create(ctxOn(h, d), { mailboxId: d.a, name: "Fresh" }, { idempotency: keyOf(d, "folder create") }),
  landed: async (d) => (await one(db().select({ f: mailboxFolders.folder }).from(mailboxFolders)
    .where(and(eq(mailboxFolders.mailboxId, d.a), eq(mailboxFolders.folder, "Fresh")))))?.f,
  stored: 201,
};
const FOLDER_RENAME: Door = {
  name: "folder rename",
  run: (h, d) => new FolderOpsService().rename(ctxOn(h, d), d.folderId, { name: "Projects 2" }, { idempotency: keyOf(d, "folder rename") }),
  landed: opOf,
  stored: 200,
};
const FOLDER_REMOVE: Door = {
  name: "folder remove",
  run: (h, d) => new FolderOpsService().remove(ctxOn(h, d), d.folderId, { idempotency: keyOf(d, "folder remove") }),
  landed: opOf,
  stored: 200,
};

const KP = makeTestAuthDeps().keyProvider;
const PATCH_NAME: Door = {
  name: "PATCH {displayName}",
  run: (h, d) => makeMailboxService({ keyProvider: KP, signatureChecks: false }).update(ctxOn(h, d), d.a, { displayName: "Renamed" }),
  landed: async (d) => (await one(db().select({ n: mailboxes.displayName }).from(mailboxes).where(eq(mailboxes.id, d.a))))?.n,
};
const AGREE_AGAIN: Door = {
  name: "the Agree press, already organizing",
  run: async (h, d) => (await makeMailboxService({ allowance: async () => {}, signatureChecks: false }).organizeHere(ctxOn(h, d), d.a,
    { intent: "join", screening: { dormancyDays: 120, scope: "window" } })).outcome,
  landed: async (d) => (await one(db().select({ days: accountSettings.dormancyDays }).from(accountSettings)
    .where(eq(accountSettings.accountId, d.accountId))))?.days,
};
const OAUTH_RECONNECT: Door = {
  name: "an OAuth reconnect",
  run: async (h, d) => (await makeMailboxService({ keyProvider: KP, allowance: async () => {}, signatureChecks: false }).connectOAuth(ctxOn(h, d), {
    provider: "microsoft", address: d.addressA,
    oauth: {
      provider: "microsoft", tenant: "common", refreshToken: "refresh-fixture", accessToken: "access-fixture",
      imap: { host: "outlook.office365.example", port: 993, secure: true },
    },
  }, { probe: async () => ({ verdict: "ok" as const }) })).created,
  landed: async (d) => (await one(db().select({ k: mailboxes.authKind }).from(mailboxes).where(eq(mailboxes.id, d.a))))?.k,
};

/** The shipped settings save, switching the folders of `ids` off in that order. */
const SAVE_TWO: Door = {
  name: "the settings save naming two mailboxes",
  run: async (h, d) => (await SETTINGS_WRITE!.handler(
    new Request("http://localhost/consent/settings", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ folderMailboxes: { [d.a]: false, [d.b]: false } }),
    }),
    {
      db: h.db, session: { accountId: d.accountId, userId: null, sessionId: null },
      now: () => NOW, requestId: `frc-lo-${randomUUID().slice(0, 8)}`,
    } as unknown as ApiDeps,
    {},
  )).status,
  landed: async (d) => (await db().select({ off: mailboxes.foldersDisabledAt }).from(mailboxes)
    .where(eq(mailboxes.accountId, d.accountId))).filter((r) => r.off !== null).length,
};

const EFFECT: Record<string, unknown> = {
  "triage": "reply_later", "message delete": true, "message restore": "INBOX", "folder create": "Fresh",
  "folder rename": "rename", "folder remove": "delete", "PATCH {displayName}": "Renamed",
  "the Agree press, already organizing": 120, "an OAuth reconnect": "oauth", "the settings save naming two mailboxes": 2,
};

async function storedStatus(d: Doors, door: Door): Promise<number[]> {
  return (await db().select({ status: idempotencyKeys.responseStatus }).from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.accountId, d.accountId), eq(idempotencyKeys.key, keyOf(d, door.name).key))))
    .map((r) => r.status);
}

describe.skipIf(!PG_UP)("a keyed press beside a mailbox change: neither fails", () => {
  const open: OwnedDb[] = [];
  const party = (role: string): { name: string; h: OwnedDb } => {
    const name = `frc-lo-${role}-${randomUUID().slice(0, 8)}`;
    const h = named(name);
    open.push(h);
    return { name, h };
  };
  beforeAll(async () => { await runMigrations(PG_TEST_URL); }, 180_000);
  afterAll(async () => { for (const h of open) await h.close().catch(() => {}); });

  /** Both parties settled, both effects landed, the press's key stored with its status. */
  async function bothLanded(d: Doors, press: Door, partner: Door, w: Settled<unknown>, p: Settled<unknown>): Promise<void> {
    const READINGS = process.env.FRC_LO_READINGS;
    if (READINGS) appendFileSync(READINGS, `${JSON.stringify({ press: press.name, partner: partner.name,
      pressAnswer: w.ok ? "committed" : codeOf(w.e), partnerAnswer: p.ok ? "committed" : codeOf(p.e) })}\n`);
    expect(w.ok ? "committed" : codeOf(w.e), press.name).toBe("committed");
    expect(p.ok ? "committed" : codeOf(p.e), partner.name).toBe("committed");
    expect(await press.landed(d), `${press.name}'s effect`).toEqual(EFFECT[press.name]);
    expect(await partner.landed(d), `${partner.name}'s effect`).toEqual(EFFECT[partner.name]);
    expect(await storedStatus(d, press), `${press.name}'s stored answer`).toEqual([press.stored]);
  }

  const PAIRS: Array<[Door, Door]> = [
    [TRIAGE, PATCH_NAME], [DELETE, PATCH_NAME], [RESTORE, PATCH_NAME],
    [FOLDER_CREATE, PATCH_NAME], [FOLDER_RENAME, PATCH_NAME], [FOLDER_REMOVE, PATCH_NAME],
    [TRIAGE, AGREE_AGAIN], [TRIAGE, OAUTH_RECONNECT], [FOLDER_CREATE, AGREE_AGAIN],
  ];
  for (const [press, partner] of PAIRS) {
    it(`${press.name} parked holding the counter, then ${partner.name} on its mailbox: both commit`, async () => {
      const d = await doors();
      const H = party("hold");
      const W = party("press");
      const P = party("partner");
      const hold = await holdNextSeq(H.h, d.accountId);
      const pressing = settle(press.run(W.h, d));
      const parked = rowOf(await blockedBy(W.name, H.name));
      const partnering = settle(partner.run(P.h, d));
      const waited = rowOf(await blockedBy(P.name, W.name));
      hold.release();
      await hold.done;
      const [w, p] = await Promise.all([pressing, partnering]);
      await bothLanded(d, press, partner, w, p);
      expect(parked, "where the press stopped").toBe("the next change row");
      expect(waited, "the partner waited on the press").not.toBe("never waited");
    }, 60_000);
  }

  it("PATCH {displayName} parked at its mailbox row: a keyed triage on the same mailbox, and both commit", async () => {
    const d = await doors();
    const H = party("hold");
    const P = party("patch");
    const T = party("triage");
    const hold = await holdMailbox(H.h, d.a);
    const patching = settle(PATCH_NAME.run(P.h, d));
    const stopped = rowOf(await blockedBy(P.name, H.name));
    const triaging = settle(TRIAGE.run(T.h, d));
    const first = await Promise.race([triaging.then(() => "settled"), blockedBy(T.name, P.name).then(rowOf)]);
    hold.release();
    await hold.done;
    const [t, p] = await Promise.all([triaging, patching]);
    await bothLanded(d, TRIAGE, PATCH_NAME, t, p);
    expect(stopped, "where PATCH stopped").toBe("the mailbox row");
    expect(first, "the triage beside the parked PATCH").toBe("settled");
  }, 60_000);

  it("PATCH {displayName} parked at its mailbox row: a keyed triage on another mailbox commits while it waits", async () => {
    const d = await doors();
    const H = party("hold");
    const P = party("patch");
    const T = party("triage");
    const other = triageOn((x) => x.letterB);
    const hold = await holdMailbox(H.h, d.a);
    const patching = settle(PATCH_NAME.run(P.h, d));
    const stopped = rowOf(await blockedBy(P.name, H.name));
    const triaging = settle(other.run(T.h, d));
    const first = await Promise.race([triaging.then(() => "settled"), blockedBy(T.name, P.name).then(rowOf)]);
    hold.release();
    await hold.done;
    const [t, p] = await Promise.all([triaging, patching]);
    await bothLanded(d, other, PATCH_NAME, t, p);
    expect(stopped, "where PATCH stopped").toBe("the mailbox row");
    expect(first, "the triage beside the parked PATCH").toBe("settled");
  }, 60_000);

  it("the settings save naming two mailboxes, parked at the second: a keyed triage there, and both commit", async () => {
    const d = await doors();
    const H = party("hold");
    const S = party("save");
    const T = party("triage");
    const other = triageOn((x) => x.letterB);
    const hold = await holdMailbox(H.h, d.b);
    const saving = settle(SAVE_TWO.run(S.h, d));
    const stopped = rowOf(await blockedBy(S.name, H.name));
    const triaging = settle(other.run(T.h, d));
    const first = await Promise.race([triaging.then(() => "settled"), blockedBy(T.name, S.name).then(rowOf)]);
    hold.release();
    await hold.done;
    const [t, s] = await Promise.all([triaging, saving]);
    expect(s.ok ? s.v : codeOf(s.e), "the save's status").toBe(200);
    await bothLanded(d, other, SAVE_TWO, t, s);
    expect(stopped, "where the save stopped").toBe("the mailbox row");
    expect(first, "the triage beside the parked save").toBe("settled");
  }, 60_000);
});
