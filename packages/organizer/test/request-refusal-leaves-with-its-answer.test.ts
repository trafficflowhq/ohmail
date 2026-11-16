import { accountOfMessage } from "@trafficflow/db";
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  mailboxes, messages, folderState, rules, organizerRequests, readIdempotencyKey,
} from "@trafficflow/db";
import {
  formatRequest, formatAck, acksIn, parseRequestEnvelope, deriveRequestKey, RequestUnavailableError,
  type RequestReaderIo, type RequestOrganizerIo, type RawMetaMessage, type MetaRecordsList, type RequestEnvelope,
} from "@trafficflow/core/adapters/organizer-lease";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import {
  applyMetaRequests, driveOutstandingRequests, REQUEST_STALE_AFTER_MS,
} from "../src/request-drain.js";
import { repoWithFailingMethod } from "./_fault.js";
import { listedOf } from "./_meta-list.js";

/**
 * A REFUSED RECORD LEAVES ONLY WITH ITS ANSWER (ORG-REQUEST-REFUSED-ACK-LOST-READS-EXPIRED). Two
 * installs, two stores, one `ohmail/_meta`. A refusal is recorded under `meta-request:<id>` before
 * its ack; when the ack fails the record stays, and the next pass answers it from the key: the
 * reader reads `refused` with its reason, never `expired`. To watch it fail: take refusals out of
 * the ack-failure `held` term, or drop the refusal key write in `request-drain.ts`.
 */

const ACCT = "00000000-0000-0000-0000-0000000000a5";
const t0 = new Date("2026-09-24T08:00:00.000Z");
const at = (ms: number): Date => new Date(t0.getTime() + ms);
const MIN = 60_000;
const ADDRESS = "shared@mailbox.example";
const KEY = deriveRequestKey({ auth: { user: ADDRESS, pass: "the-shared-password" }, address: ADDRESS })!;
const SENDER = "person@example.com";
const READER = { installId: "reader-install", kind: "local" as const };

type TestDb = Awaited<ReturnType<typeof makeTestDb>>;
type Log = Array<{ event: string; detail: Record<string, unknown> }>;

/** One folder, both roles, and a count of every write the organizer asks of it. */
function sharedMeta() {
  const store = new Map<number, string>();
  let nextUid = 1;
  const list = async (): Promise<MetaRecordsList> =>
    listedOf([...store.entries()].map(([ref, raw]) => ({ ref, raw })));
  const self = {
    store,
    acks: 0,
    removes: 0,
    reader: {
      listMetaRecords: list,
      async append(raw: string): Promise<void> { store.set(nextUid++, raw); },
    } as RequestReaderIo,
    organizer: {
      listMetaRecords: list,
      uidValidity: (): number => 7_000,
      async ack(raw: string): Promise<void> { self.acks += 1; store.set(nextUid++, raw); },
      async remove(refs: readonly unknown[]): Promise<void> {
        self.removes += 1;
        for (const r of refs) if (typeof r === "number") store.delete(r);
      },
    } as RequestOrganizerIo,
  };
  return self;
}
type Meta = ReturnType<typeof sharedMeta>;

const requestsIn = (m: Meta): number =>
  [...m.store.values()].filter((raw) => /(^|\n)X-Ohmail-Request:/i.test(raw)).length;
const acksOf = (m: Meta) => acksIn([...m.store.entries()].map(([ref, raw]) => ({ ref, raw })), KEY);

/** Two stores keyed on one mailbox id: the reader's row, and the organizer's held message. */
async function twoWorlds(): Promise<{ reader: TestDb; organizer: TestDb; mailboxId: string; messageId: string }> {
  const mailboxId = randomUUID();
  const reader = await makeTestDb();
  const organizer = await makeTestDb();
  await reader.insert(mailboxes).values({ id: mailboxId, accountId: ACCT, provider: "imap", address: ADDRESS, organizerRole: "reader" });
  await organizer.insert(mailboxes).values({ id: mailboxId, accountId: ACCT, provider: "imap", address: ADDRESS });
  const [msg] = await organizer.insert(messages).values({
    accountId: ACCT, mailboxId, bodyHash: randomUUID(), dedupKey: `mid:${randomUUID()}`,
    subject: "s", fromAddress: SENDER, unread: true,
  }).returning({ id: messages.id });
  await organizer.insert(folderState).values({
    messageId: msg!.id, accountId: accountOfMessage(msg!.id), desiredFolder: "ohmail/Screener", observedFolder: "ohmail/Screener",
    lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
  });
  return { reader, organizer, mailboxId, messageId: msg!.id };
}

async function queueDecision(db: TestDb, mailboxId: string, decidedAt: Date): Promise<string> {
  const id = randomUUID();
  await db.insert(organizerRequests).values({
    id, accountId: ACCT, mailboxId, kind: "screener.decide",
    payload: { scope: "sender", address: SENDER, appliedFolder: "INBOX", decision: "yes", match: SENDER },
    decidedAt, state: "pending",
  });
  return id;
}

const readerAdapter = (m: Meta): MailboxAdapter => ({ requestReaderIo: () => m.reader }) as unknown as MailboxAdapter;
const organizerAdapter = (io: RequestOrganizerIo): MailboxAdapter =>
  ({ requestOrganizerIo: () => io }) as unknown as MailboxAdapter;

/**
 * THE INJECTOR, in `repoWithFailingMethod`'s shape: every io the adapter hands the drain fails
 * `ack` with production's class and wrapping. Each fire records whether the apply's transaction
 * had COMMITTED by then, read from the organizer's store — the positive control that the fault
 * lands after the apply and on the path the drain really takes.
 */
function ackFailing(m: Meta, organizer: TestDb, requestId: string) {
  const fires: Array<{ keyCommitted: boolean }> = [];
  const io = repoWithFailingMethod(m.organizer, "ack", async () => {
    const held = await organizer.transaction((tx) => readIdempotencyKey(tx, ACCT, `meta-request:${requestId}`, t0));
    fires.push({ keyCommitted: held !== null });
    throw new RequestUnavailableError("an acknowledgement could not be appended to ohmail/_meta", {
      op: "append_request", cause: new Error("NO [OVERQUOTA] the server refused the append"),
    });
  });
  return { adapter: organizerAdapter(io), fires };
}

const readerRun = (w: { reader: TestDb; mailboxId: string }, m: Meta, now: Date) =>
  driveOutstandingRequests(w.reader, { mailboxId: w.mailboxId, accountId: ACCT, installId: READER.installId, adapter: readerAdapter(m), requestKey: KEY }, READER, now, () => undefined);

const organizerRun = (w: { organizer: TestDb; mailboxId: string }, adapter: MailboxAdapter, now: Date, log: Log = []) =>
  applyMetaRequests(w.organizer, { mailboxId: w.mailboxId, accountId: ACCT, installId: "organizer-install", adapter, requestKey: KEY }, now,
    (event, detail) => { log.push({ event, detail }); });

async function rowState(db: TestDb, id: string): Promise<{ state: string; refusedReason: string | null }> {
  const [row] = await db.select().from(organizerRequests).where(eq(organizerRequests.id, id));
  return { state: row!.state, refusedReason: row!.refusedReason ?? null };
}
async function ruleCount(db: TestDb): Promise<number> {
  return (await db.select().from(rules).where(and(eq(rules.accountId, ACCT), eq(rules.match, SENDER)))).length;
}
async function desiredFolder(db: TestDb, messageId: string): Promise<string | null> {
  const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, messageId));
  return fs?.desiredFolder ?? null;
}

/** A decision whose payload no applier takes: refused `invalid_payload` before any apply. */
async function queueUnreadable(db: TestDb, mailboxId: string, decidedAt: Date): Promise<string> {
  const id = randomUUID();
  await db.insert(organizerRequests).values({
    id, accountId: ACCT, mailboxId, kind: "screener.decide",
    payload: { scope: "sender", address: SENDER, appliedFolder: "INBOX", decision: "maybe", match: SENDER },
    decidedAt, state: "pending",
  });
  return id;
}

const keyOf = async (db: TestDb, id: string, at: Date) =>
  (await db.transaction((tx) => readIdempotencyKey(tx, ACCT, `meta-request:${id}`, at)))?.responseJson ?? null;
const mine = (log: Log, event: string, id: string): number =>
  log.filter((l) => l.event === event && l.detail.requestId === id).length;

describe("a refused record leaves only with its answer", () => {
  it("the ack fails: the record stays, the key holds the refusal, the next pass answers it once", async () => {
    const w = await twoWorlds();
    const m = sharedMeta();
    const id = await queueUnreadable(w.reader, w.mailboxId, t0);
    expect((await readerRun(w, m, t0)).sent).toBe(1);

    const failing = ackFailing(m, w.organizer, id);
    const log: Log = [];
    const first = await organizerRun(w, failing.adapter, at(MIN), log);
    const standing = requestsIn(m);
    const recorded = await keyOf(w.organizer, id, at(MIN));
    await organizerRun(w, organizerAdapter(m.organizer), at(2 * MIN), log);
    await readerRun(w, m, at(3 * MIN));
    await readerRun(w, m, at(REQUEST_STALE_AFTER_MS + 5 * MIN));

    expect({
      first, standing, recorded,
      acks: acksOf(m).map((a) => [a.outcome, a.reason ?? null]),
      readerRow: await rowState(w.reader, id),
      refusedLogs: mine(log, "organizer_request_refused", id),
      resent: mine(log, "organizer_ack_resent", id),
      requests: requestsIn(m),
    }).toEqual({
      first: { applied: 0, refused: 0, deferred: 1, standing: 0 },
      standing: 1,
      recorded: { applied: false, requestId: id, reason: "invalid_payload" },
      acks: [["refused", "invalid_payload"]],
      readerRow: { state: "refused", refusedReason: "invalid_payload" },
      refusedLogs: 1,
      resent: 1,
      requests: 0,
    });
    expect(await ruleCount(w.organizer), "a refused decision applied nothing").toBe(0);
  });

  it("the refusal record fails: said once, the ack still goes, and the reader reads the refusal", async () => {
    const w = await twoWorlds();
    const m = sharedMeta();
    const id = await queueUnreadable(w.reader, w.mailboxId, t0);
    await readerRun(w, m, t0);
    const refusingStore = repoWithFailingMethod(w.organizer, "insert", () => {
      throw new Error("the key could not be written");
    }, { sync: true, times: 1 });
    const log: Log = [];
    await organizerRun({ organizer: refusingStore, mailboxId: w.mailboxId }, organizerAdapter(m.organizer), at(MIN), log);
    await readerRun(w, m, at(2 * MIN));
    expect({
      unrecorded: mine(log, "organizer_request_refusal_unrecorded", id),
      key: await keyOf(w.organizer, id, at(MIN)),
      acks: acksOf(m).map((a) => [a.outcome, a.reason ?? null]),
      readerRow: await rowState(w.reader, id),
    }).toEqual({
      unrecorded: 1, key: null,
      acks: [["refused", "invalid_payload"]],
      readerRow: { state: "refused", refusedReason: "invalid_payload" },
    });
  });

  it("a record with no readable id is expunged, answered by nobody, as before", async () => {
    const w = await twoWorlds();
    const m = sharedMeta();
    await m.reader.append("X-Ohmail-Request: 1\r\nSubject: ohmail request\r\n\r\nnot a record\r\n");
    const log: Log = [];
    const out = await organizerRun(w, organizerAdapter(m.organizer), at(MIN), log);
    expect({ out, requests: requestsIn(m), acks: acksOf(m).length, acked: m.acks })
      .toEqual({ out: { applied: 0, refused: 1, deferred: 0, standing: 0 }, requests: 0, acks: 0, acked: 0 });
  });

  it("CONTROL: an applied record whose ack fails is still kept and answered applied", async () => {
    const w = await twoWorlds();
    const m = sharedMeta();
    const id = await queueDecision(w.reader, w.mailboxId, t0);
    await readerRun(w, m, t0);
    const failing = ackFailing(m, w.organizer, id);
    expect(await organizerRun(w, failing.adapter, at(MIN)))
      .toEqual({ applied: 0, refused: 0, deferred: 1, standing: 0 });
    await organizerRun(w, organizerAdapter(m.organizer), at(2 * MIN));
    expect(acksOf(m).map((a) => [a.outcome, a.reason ?? null])).toEqual([["applied", null]]);
    expect(await ruleCount(w.organizer)).toBe(1);
  });
});
