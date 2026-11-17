import { accountOfMessage } from "@trafficflow/db";
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  mailboxes, messages, folderState, rules, organizerRequests, readIdempotencyKey, listOutstandingForAccount,
  eraseIdempotentResponses,
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
 * A LOST ACK IS RETRIED FROM THE APPLIED RECORD (ORG-REQUEST-ACK-LOST-READS-EXPIRED). The reader
 * and the organizer are two installs with two stores and one `ohmail/_meta`, as in production.
 * The ack fails AFTER the apply committed; the record stays in the folder, the next pass finds
 * the `meta-request:<id>` key for the same content and acks `applied`, and nothing re-applies.
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

/** A signed decision record under a fixed id, for an id reused with other content. */
const recordFor = (w: { mailboxId: string }, id: string, address: string): string => formatRequest({
  requestId: id, kind: "screener.decide", mailboxId: w.mailboxId, installId: READER.installId,
  organizerKind: "local", decidedAt: t0, key: KEY,
  payload: { scope: "sender", address, appliedFolder: "INBOX", decision: "yes" },
});

/** Another mailbox of the account erased on the organizer's store: its erasure stamps the account's keys. */
async function eraseSibling(w: { organizer: TestDb }, now: Date): Promise<void> {
  const [sib] = await w.organizer.insert(mailboxes)
    .values({ accountId: ACCT, provider: "imap", address: "sibling@mailbox.example" }).returning({ id: mailboxes.id });
  await w.organizer.transaction((tx) => eraseIdempotentResponses(tx, ACCT, now, { mailboxId: sib!.id }));
}

describe("a lost acknowledgement is retried from the applied record, keyed on the request id", () => {
  /* The red-before. At the base the record was expunged beside the failed ack, so no pass could
     answer it: the reader's outstanding list kept the decision `sent` for a day, then the row read
     `expired` while the organizer's store held it applied. The readings are asserted together so
     a failure prints them all. */
  it("the next pass acks it: the reader reads applied, never expired", async () => {
    const w = await twoWorlds();
    const m = sharedMeta();
    const id = await queueDecision(w.reader, w.mailboxId, t0);
    expect((await readerRun(w, m, t0)).sent).toBe(1);

    const failing = ackFailing(m, w.organizer, id);
    const log: Log = [];
    await organizerRun(w, failing.adapter, at(MIN), log);
    await organizerRun(w, organizerAdapter(m.organizer), at(2 * MIN), log);
    await readerRun(w, m, at(3 * MIN));
    const waiting = await w.reader.transaction((tx) => listOutstandingForAccount(tx, ACCT, at(3 * MIN)));
    await readerRun(w, m, at(REQUEST_STALE_AFTER_MS + 5 * MIN));

    expect({
      waitingAfterRetry: waiting.map((o) => o.state),
      readerRow: (await rowState(w.reader, id)).state,
      organizerRules: await ruleCount(w.organizer),
      organizerDesired: await desiredFolder(w.organizer, w.messageId),
    }).toEqual({ waitingAfterRetry: [], readerRow: "applied", organizerRules: 1, organizerDesired: "INBOX" });
    expect(requestsIn(m), "the answered record is gone from the folder").toBe(0);
    expect(acksOf(m).map((a) => [a.requestId, a.outcome])).toEqual([[id, "applied"]]);
  });

  /* The positive control for the injector: it fired, and the key had committed when it did. */
  it("the injected failure lands after the apply committed, on the drain's own io", async () => {
    const w = await twoWorlds();
    const m = sharedMeta();
    const id = await queueDecision(w.reader, w.mailboxId, t0);
    await readerRun(w, m, t0);
    const failing = ackFailing(m, w.organizer, id);
    // Applied but unanswered is deferred: nothing has resolved for the reader, and the page holds.
    expect(await organizerRun(w, failing.adapter, at(MIN)))
      .toEqual({ applied: 0, refused: 0, deferred: 1, standing: 0 });
    expect(failing.fires.length).toBeGreaterThanOrEqual(1);
    expect(failing.fires.every((f) => f.keyCommitted)).toBe(true);
    expect(m.acks, "the real ack was never reached while the injector stood").toBe(0);
  });

  /* Idempotency: retries that keep failing never apply twice, a replayed record after the ack
     adds no ack and no rule, and a second ack at the reader changes nothing. The per-request log
     is one line for the loss and one for the resend, whatever the number of passes between. */
  it("a second ack and a replayed apply are no-ops, and the loss is logged once", async () => {
    const w = await twoWorlds();
    const m = sharedMeta();
    const id = await queueDecision(w.reader, w.mailboxId, t0);
    await readerRun(w, m, t0);
    const raw = [...m.store.values()][0]!;
    const failing = ackFailing(m, w.organizer, id);
    const log: Log = [];
    for (let i = 1; i <= 4; i++) await organizerRun(w, failing.adapter, at(i * MIN), log);
    expect(await ruleCount(w.organizer), "a retry re-applied the decision").toBe(1);
    expect(requestsIn(m), "the record left before its answer").toBe(1);

    await organizerRun(w, organizerAdapter(m.organizer), at(5 * MIN), log);
    expect({ acks: m.acks, rules: await ruleCount(w.organizer), requests: requestsIn(m) })
      .toEqual({ acks: 1, rules: 1, requests: 0 });

    // The same signed record appears again (a re-append): the key answers, the ack in the folder
    // is recognised, and nothing is appended or applied.
    await m.reader.append(raw);
    await organizerRun(w, organizerAdapter(m.organizer), at(6 * MIN), log);
    expect({ acks: m.acks, rules: await ruleCount(w.organizer), requests: requestsIn(m), inFolder: acksOf(m).length })
      .toEqual({ acks: 1, rules: 1, requests: 0, inFolder: 1 });

    await readerRun(w, m, at(7 * MIN));
    await m.organizer.ack(formatAck({ requestId: id, mailboxId: w.mailboxId, outcome: "applied", ackedAt: at(8 * MIN), key: KEY }));
    await readerRun(w, m, at(9 * MIN));
    expect(await rowState(w.reader, id)).toEqual({ state: "applied", refusedReason: null });
    expect((await w.reader.select().from(organizerRequests)).length).toBe(1);

    const mine = (event: string): number =>
      log.filter((l) => l.event === event && l.detail.requestId === id).length;
    expect({ lost: mine("organizer_ack_append_failed"), resent: mine("organizer_ack_resent") })
      .toEqual({ lost: 1, resent: 1 });
  });

  /* The path beside it: applied late in the window, the ack lost, and the next pass finds the
     record past its window. `stale` is a refusal of a decision nobody applied; this one was
     applied, so the answer is `applied` — not "refused: stale" for mail that moved. */
  it("a record past its window whose decision was applied here is acked applied, not stale", async () => {
    const w = await twoWorlds();
    const m = sharedMeta();
    const id = await queueDecision(w.reader, w.mailboxId, t0);
    await readerRun(w, m, at(REQUEST_STALE_AFTER_MS - 60 * MIN));
    const failing = ackFailing(m, w.organizer, id);
    await organizerRun(w, failing.adapter, at(REQUEST_STALE_AFTER_MS - 30 * MIN));
    await organizerRun(w, organizerAdapter(m.organizer), at(REQUEST_STALE_AFTER_MS + 5 * MIN));
    await readerRun(w, m, at(REQUEST_STALE_AFTER_MS + 10 * MIN));

    expect(acksOf(m).map((a) => [a.outcome, a.reason ?? null])).toEqual([["applied", null]]);
    expect(await rowState(w.reader, id)).toEqual({ state: "applied", refusedReason: null });
    expect(await ruleCount(w.organizer)).toBe(1);
  });

  /* The true expiry still reads expired: nobody applied the decision inside its window. The
     late organizer then refuses it `stale` with no key to find, and applies nothing. */
  it("a request nobody applied past its window still reads expired", async () => {
    const w = await twoWorlds();
    const m = sharedMeta();
    const id = await queueDecision(w.reader, w.mailboxId, t0);
    await readerRun(w, m, t0);
    await readerRun(w, m, at(REQUEST_STALE_AFTER_MS + MIN));
    expect(await rowState(w.reader, id)).toEqual({ state: "expired", refusedReason: null });

    await organizerRun(w, organizerAdapter(m.organizer), at(REQUEST_STALE_AFTER_MS + 2 * MIN));
    expect(acksOf(m).map((a) => [a.outcome, a.reason ?? null])).toEqual([["refused", "stale"]]);
    expect(await ruleCount(w.organizer)).toBe(0);
    await readerRun(w, m, at(REQUEST_STALE_AFTER_MS + 3 * MIN));
    expect((await rowState(w.reader, id)).state).toBe("expired");
  });

  /* A key for the same id but DIFFERENT content is not this decision applied: past the window it
     is refused `stale`, as a record with no key is. Read while that key still lives. */
  it("a stale record whose key names other content is refused stale", async () => {
    const w = await twoWorlds();
    const m = sharedMeta();
    const id = randomUUID();
    await m.reader.append(recordFor(w, id, SENDER));
    await organizerRun(w, organizerAdapter(m.organizer), at(MIN));
    m.store.clear();
    await m.reader.append(recordFor(w, id, "someone-else@example.com"));
    expect((parseRequestEnvelope([...m.store.values()][0]!) as RequestEnvelope).requestId).toBe(id);
    await organizerRun(w, organizerAdapter(m.organizer), at(REQUEST_STALE_AFTER_MS + 30_000));
    expect(acksOf(m).map((a) => [a.outcome, a.reason ?? null])).toEqual([["refused", "stale"]]);
  });
});

/**
 * ANOTHER MAILBOX'S ERASURE STAMPS THE KEY AND BLANKS ITS HASH. The drain reads the stamp first: a
 * stamped key was answered here, so the lost ack is still owed `applied`, and nothing re-applies.
 */
describe("a lost acknowledgement after another mailbox of the account was erased", () => {
  it("the next pass acks it applied, and the decision applied once", async () => {
    const w = await twoWorlds();
    const m = sharedMeta();
    const id = await queueDecision(w.reader, w.mailboxId, t0);
    await readerRun(w, m, t0);
    await organizerRun(w, ackFailing(m, w.organizer, id).adapter, at(MIN));
    await eraseSibling(w, at(MIN + 1_000));
    const held = await w.organizer.transaction((tx) => readIdempotencyKey(tx, ACCT, `meta-request:${id}`, at(2 * MIN)));
    expect(held?.erasedAt, "the erasure did not reach the key").toBeInstanceOf(Date);

    await organizerRun(w, organizerAdapter(m.organizer), at(2 * MIN));
    expect(acksOf(m).map((a) => [a.requestId, a.outcome])).toEqual([[id, "applied"]]);
    expect(await ruleCount(w.organizer)).toBe(1);
  });

  it("an id reused with other content after it applies nothing", async () => {
    const w = await twoWorlds();
    const m = sharedMeta();
    const id = randomUUID();
    await m.reader.append(recordFor(w, id, SENDER));
    await organizerRun(w, organizerAdapter(m.organizer), at(MIN));
    m.store.clear();
    await eraseSibling(w, at(MIN + 1_000));
    await m.reader.append(recordFor(w, id, "someone-else@example.com"));
    await organizerRun(w, organizerAdapter(m.organizer), at(2 * MIN));
    expect((await w.organizer.select().from(rules).where(eq(rules.accountId, ACCT))).map((r) => r.match)).toEqual([SENDER]);
    expect(requestsIn(m), "the record was left unanswered").toBe(0);
  });
});
