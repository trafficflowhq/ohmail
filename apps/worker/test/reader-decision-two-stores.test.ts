import { accountOfMessage } from "@trafficflow/db";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import { mailboxes, messages, folderState, rules, organizerRequests } from "@trafficflow/db";
import { ScreenerService } from "@trafficflow/services/mail";
import {
  deriveRequestKey, formatRequest, formatAck, acksIn,
  type RequestReaderIo, type RequestOrganizerIo, type RawMetaMessage, type MetaRecordsList,
} from "@trafficflow/core/adapters/organizer-lease";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { applyMetaRequests, driveOutstandingRequests } from "../src/request-drain.js";
import { listedOf } from "./_meta-list.js";

/**
 * A reader's decision between TWO INSTALLS, each with its own store. Every install
 * mints its own row id for a mailbox, so the id the reader signs is one the organizer's store has
 * never seen. The folder the record was read from is the mailbox it is about; the address-salted
 * key keeps a record lifted from another mailbox's folder out, and a known other row stays refused.
 */

const ADDRESS = "shared@mailbox.example";
const PASSWORD = "the-mailbox-password";
const KEY = deriveRequestKey({ auth: { user: ADDRESS, pass: PASSWORD }, address: ADDRESS })!;
const SENDER = "person@example.com";
const t0 = new Date("2026-09-26T09:17:17.000Z");
const at = (s: number): Date => new Date(t0.getTime() + s * 1000);

type Db = Awaited<ReturnType<typeof makeTestDb>>;

/** One `ohmail/_meta`, two installs looking at it — the only medium the two stores share. */
function sharedMeta() {
  const store = new Map<number, string>();
  let nextUid = 1;
  const list = async (): Promise<MetaRecordsList> =>
    listedOf([...store.entries()].map(([ref, raw]) => ({ ref, raw })));
  const reader: RequestReaderIo = { listMetaRecords: list, async append(raw) { store.set(nextUid++, raw); } };
  const organizer: RequestOrganizerIo = {
    listMetaRecords: list,
    async ack(raw) { store.set(nextUid++, raw); },
    async remove(refs) { for (const r of refs) if (typeof r === "number") store.delete(r); },
  };
  const acks = () => acksIn([...store.entries()].map(([ref, raw]) => ({ ref, raw })), KEY);
  return { store, reader, organizer, acks };
}
const readerAdapter = (m: ReturnType<typeof sharedMeta>) =>
  ({ requestReaderIo: () => m.reader }) as unknown as MailboxAdapter;
const organizerAdapter = (m: ReturnType<typeof sharedMeta>) =>
  ({ requestOrganizerIo: () => m.organizer }) as unknown as MailboxAdapter;

/** One install's store: its own account, its own row for the mailbox, the sender held. */
async function install(role: "reader" | "organizer", address = ADDRESS) {
  const db: Db = await makeTestDb();
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address,
    organizerRole: role,
    ...(role === "reader"
      ? { organizerState: "held", organizedByCapabilities: "requests", organizedByKind: "local", organizedByName: "zorin-9950" }
      : {}),
  }).returning({ id: mailboxes.id });
  const [msg] = await db.insert(messages).values({
    accountId, mailboxId: mb!.id, bodyHash: randomUUID(), dedupKey: "mid:<held-1@example.com>",
    subject: "s", fromAddress: SENDER, unread: true,
  }).returning({ id: messages.id });
  await db.insert(folderState).values({
    messageId: msg!.id, accountId: accountOfMessage(msg!.id), desiredFolder: "ohmail/Screener", observedFolder: "ohmail/Screener",
    lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
  });
  return { db, accountId, mailboxId: mb!.id, messageId: msg!.id };
}

const organizerPass = (o: Awaited<ReturnType<typeof install>>, m: ReturnType<typeof sharedMeta>, s: number, key = KEY) =>
  applyMetaRequests(o.db, {
    mailboxId: o.mailboxId, accountId: o.accountId, installId: "the-desktop",
    adapter: organizerAdapter(m), requestKey: key,
  }, at(s), () => undefined);
const readerPass = (r: Awaited<ReturnType<typeof install>>, m: ReturnType<typeof sharedMeta>, s: number) =>
  driveOutstandingRequests(r.db, {
    mailboxId: r.mailboxId, accountId: r.accountId, installId: "the-phone",
    adapter: readerAdapter(m), requestKey: KEY,
  }, { installId: "the-phone", kind: "mobile" }, at(s), () => undefined);
const ruleCount = async (o: Awaited<ReturnType<typeof install>>) =>
  (await o.db.select().from(rules).where(eq(rules.accountId, o.accountId))).length;
const rowState = async (r: Awaited<ReturnType<typeof install>>) =>
  (await r.db.select().from(organizerRequests).where(eq(organizerRequests.mailboxId, r.mailboxId)))[0];

/** A record some other writer signed, naming `mailboxId`, under `key`. */
const recordFrom = (o: { mailboxId: string; key: string; requestId?: string; installId?: string }) =>
  formatRequest({
    requestId: o.requestId ?? randomUUID(), kind: "screener.decide", mailboxId: o.mailboxId,
    installId: o.installId ?? "somebody-else", organizerKind: "mobile", decidedAt: t0,
    payload: { scope: "sender", address: SENDER, appliedFolder: "INBOX", decision: "yes" },
    key: o.key,
  });

describe("a reader's decision reaches an organizer with its own store", () => {
  it("the phone's Ohbox press is applied by the desktop and the phone reads the answer", async () => {
    const phone = await install("reader");
    const desktop = await install("organizer");
    expect(phone.mailboxId).not.toBe(desktop.mailboxId);

    const svc = new ScreenerService({});
    const decided = await svc.decide(
      { db: phone.db, accountId: phone.accountId, userId: null, now: () => t0, requestId: "r" },
      phone.messageId, { decision: "yes" },
    );
    expect("pending" in decided && decided.pending).toBe(true);

    const meta = sharedMeta();
    expect((await readerPass(phone, meta, 1)).sent).toBe(1);

    const drained = await organizerPass(desktop, meta, 60);
    expect(meta.acks().map((a) => [a.outcome, a.reason])).toEqual([["applied", null]]);
    expect(drained).toMatchObject({ applied: 1, refused: 0 });
    expect(await ruleCount(desktop)).toBe(1);
    const [held] = await desktop.db.select().from(folderState).where(eq(folderState.messageId, desktop.messageId));
    expect(held?.desiredFolder).toBe("INBOX");

    // The phone moves its row on the ANSWER, which names the desktop's own row for the mailbox.
    expect((await readerPass(phone, meta, 120)).applied).toBe(1);
    expect((await rowState(phone))?.state).toBe("applied");
    // Only the organizer moves: the phone wrote no rule of its own.
    expect(await ruleCount(phone)).toBe(0);
  });

  it("a refusal the organizer signs reaches the phone with its reason", async () => {
    const phone = await install("reader");
    const desktop = await install("organizer");
    const svc = new ScreenerService({});
    await svc.decide(
      { db: phone.db, accountId: phone.accountId, userId: null, now: () => t0, requestId: "r" },
      phone.messageId, { decision: "yes" },
    );
    const meta = sharedMeta();
    await readerPass(phone, meta, 1);
    // The desktop was offline past the window both sides give up at: a signed refusal, `stale`.
    const late = 25 * 60 * 60;
    expect(await organizerPass(desktop, meta, late)).toMatchObject({ applied: 0, refused: 1 });
    expect(meta.acks().map((a) => [a.outcome, a.reason])).toEqual([["refused", "stale"]]);
    expect(await readerPass(phone, meta, late + 60)).toMatchObject({ refused: 1 });
    expect(await rowState(phone)).toMatchObject({ state: "refused", refusedReason: "stale" });
  });
});

describe("the signature's protections stay", () => {
  it("another mailbox's record (its own key) is refused and never answered", async () => {
    const desktop = await install("organizer");
    const meta = sharedMeta();
    const otherKey = deriveRequestKey({ auth: { user: "other@mailbox.example", pass: PASSWORD }, address: "other@mailbox.example" })!;
    await meta.reader.append(recordFrom({ mailboxId: randomUUID(), key: otherKey }));
    expect(await organizerPass(desktop, meta, 60)).toMatchObject({ applied: 0, refused: 1 });
    expect(meta.acks()).toEqual([]);
    expect(await ruleCount(desktop)).toBe(0);
  });

  it("a record naming ANOTHER mailbox row this organizer holds is refused wrong_mailbox", async () => {
    const desktop = await install("organizer");
    const [other] = await desktop.db.insert(mailboxes).values({
      accountId: randomUUID(), provider: "imap", address: ADDRESS,
    }).returning({ id: mailboxes.id });
    const meta = sharedMeta();
    await meta.reader.append(recordFrom({ mailboxId: other!.id, key: KEY }));
    expect(await organizerPass(desktop, meta, 60)).toMatchObject({ applied: 0, refused: 1 });
    expect(meta.acks().map((a) => a.reason)).toEqual(["wrong_mailbox"]);
    expect(await ruleCount(desktop)).toBe(0);
  });

  it("a replayed record is applied once", async () => {
    const desktop = await install("organizer");
    const meta = sharedMeta();
    const requestId = randomUUID();
    const raw = recordFrom({ mailboxId: randomUUID(), key: KEY, requestId });
    await meta.reader.append(raw);
    expect(await organizerPass(desktop, meta, 60)).toMatchObject({ applied: 1 });
    await meta.reader.append(raw);
    await organizerPass(desktop, meta, 120);
    expect(await ruleCount(desktop)).toBe(1);
    expect(meta.acks().every((a) => a.outcome === "applied")).toBe(true);
  });

  it("an install that does not hold the password is refused and never answered", async () => {
    const desktop = await install("organizer");
    const meta = sharedMeta();
    const strangerKey = deriveRequestKey({ auth: { user: ADDRESS, pass: "not-the-password" }, address: ADDRESS })!;
    await meta.reader.append(recordFrom({ mailboxId: randomUUID(), key: strangerKey }));
    expect(await organizerPass(desktop, meta, 60)).toMatchObject({ applied: 0, refused: 1 });
    expect(meta.acks()).toEqual([]);
    expect(await ruleCount(desktop)).toBe(0);
  });
});

describe("which ids this store knows", () => {
  it("a removed row of the same address, named, is refused wrong_mailbox", async () => {
    const desktop = await install("organizer");
    const [gone] = await desktop.db.insert(mailboxes).values({
      accountId: desktop.accountId, provider: "imap", address: ADDRESS, status: "disabled",
    }).returning({ id: mailboxes.id });
    const meta = sharedMeta();
    await meta.reader.append(recordFrom({ mailboxId: gone!.id, key: KEY }));
    expect(await organizerPass(desktop, meta, 60)).toMatchObject({ applied: 0, refused: 1 });
    expect(meta.acks().map((a) => a.reason)).toEqual(["wrong_mailbox"]);
  });

  it("a batch naming only this row, and one naming no row at all, is judged here", async () => {
    const desktop = await install("organizer");
    const meta = sharedMeta();
    await meta.reader.append(recordFrom({ mailboxId: desktop.mailboxId, key: KEY }));
    await meta.reader.append(recordFrom({ mailboxId: desktop.mailboxId, key: KEY }));
    expect(await organizerPass(desktop, meta, 60)).toMatchObject({ applied: 2, refused: 0 });
    // Not a uuid: no row can carry it, and Postgres would refuse it as a bind.
    await meta.reader.append(recordFrom({ mailboxId: "phone-row-7", key: KEY }));
    expect(await organizerPass(desktop, meta, 120)).toMatchObject({ applied: 1, refused: 0 });
  });

  it("a read that cannot say which rows are held judges nothing this cycle", async () => {
    const desktop = await install("organizer");
    const meta = sharedMeta();
    await meta.reader.append(recordFrom({ mailboxId: randomUUID(), key: KEY }));
    let calls = 0;
    const failingFirst = new Proxy(desktop.db, {
      get(target, prop, receiver) {
        if (prop !== "transaction") return Reflect.get(target, prop, receiver);
        return (...args: unknown[]) => {
          calls += 1;
          if (calls === 1) return Promise.reject(new Error("the store is closing"));
          return (target.transaction as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    const r = await applyMetaRequests(failingFirst, {
      mailboxId: desktop.mailboxId, accountId: desktop.accountId, installId: "the-desktop",
      adapter: organizerAdapter(meta), requestKey: KEY,
    }, at(60), () => undefined);
    expect(r).toMatchObject({ applied: 0, refused: 0, deferred: 1 });
    expect(meta.acks()).toEqual([]);
    expect(await organizerPass(desktop, meta, 120)).toMatchObject({ applied: 1 });
  });

  it("one store, two rows on one address: B applies an unminted id, and A takes B's answer for nothing", async () => {
    const store = await install("organizer");
    const b = store;
    const aAccount = randomUUID();
    const [aRow] = await store.db.insert(mailboxes).values({
      accountId: aAccount, provider: "imap", address: ADDRESS,
      organizerRole: "reader", organizerState: "held", organizedByCapabilities: "requests",
    }).returning({ id: mailboxes.id });
    const meta = sharedMeta();
    const requestId = randomUUID();
    await meta.reader.append(recordFrom({ mailboxId: randomUUID(), key: KEY, requestId }));
    expect(await organizerPass(b, meta, 60)).toMatchObject({ applied: 1 });
    expect(await ruleCount(b)).toBe(1);
    expect((await store.db.select().from(rules).where(eq(rules.accountId, aAccount))).length).toBe(0);
    expect(meta.acks().map((x) => x.mailboxId)).toEqual([b.mailboxId]);
    // A holds a `sent` row under the same id: B's ack names B, another row of A's store.
    await store.db.insert(organizerRequests).values({
      id: requestId, accountId: aAccount, mailboxId: aRow!.id, kind: "screener.decide",
      payload: { scope: "sender", match: SENDER }, state: "sent", decidedAt: t0, sentAt: at(1),
    });
    const aPass = await driveOutstandingRequests(store.db, {
      mailboxId: aRow!.id, accountId: aAccount, installId: "install-a",
      adapter: readerAdapter(meta), requestKey: KEY,
    }, { installId: "install-a", kind: "cloud" }, at(120), () => undefined);
    expect(aPass).toMatchObject({ applied: 0, refused: 0 });
  });
});

describe("the reader reads the answer from its organizer and only from it", () => {
  /** A phone with one decision `sent`, and an ack for it in the folder naming `named`. */
  async function phoneAwaiting(named: (phone: Awaited<ReturnType<typeof install>>) => Promise<string>) {
    const phone = await install("reader");
    await new ScreenerService({}).decide(
      { db: phone.db, accountId: phone.accountId, userId: null, now: () => t0, requestId: "r" },
      phone.messageId, { decision: "yes" },
    );
    const meta = sharedMeta();
    await readerPass(phone, meta, 1);
    const row = await rowState(phone);
    await meta.organizer.ack(formatAck({
      requestId: row!.id, mailboxId: await named(phone), outcome: "refused", reason: "conflict",
      ackedAt: at(60), key: KEY,
    }));
    return { phone, meta };
  }

  it("an ack naming an id this store never minted is the organizer answering", async () => {
    const { phone, meta } = await phoneAwaiting(async () => randomUUID());
    expect(await readerPass(phone, meta, 120)).toMatchObject({ refused: 1 });
    expect(await rowState(phone)).toMatchObject({ state: "refused", refusedReason: "conflict" });
  });

  it("an ack naming another row of the reader's own store is dropped", async () => {
    const { phone, meta } = await phoneAwaiting(async (p) => {
      const [other] = await p.db.insert(mailboxes).values({
        accountId: p.accountId, provider: "imap", address: ADDRESS, status: "disabled",
      }).returning({ id: mailboxes.id });
      return other!.id;
    });
    expect(await readerPass(phone, meta, 120)).toMatchObject({ applied: 0, refused: 0 });
    expect((await rowState(phone))?.state).toBe("sent");
  });
});
