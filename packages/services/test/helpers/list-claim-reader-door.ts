import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { expect } from "vitest";
import type { makeTestDb } from "@trafficflow/db/testing";
import {
  accounts, contacts, folderState, learningSignals, listAddresses, mailboxes, messageBodies, messages, organizerRequests, rules,
} from "@trafficflow/db";
import {
  deriveRequestKey, type RequestOrganizerIo, type RequestReaderIo,
} from "@trafficflow/core/adapters/organizer-lease";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { ScreenerService } from "../../src/screener-service.js";
import type { ServiceContext } from "../../src/context.js";
import { applyMetaRequests, driveOutstandingRequests } from "../../../../apps/worker/src/request-drain.js";
import { ruleRetroPass } from "../../../../apps/worker/src/rule-retro.js";

export type Db = Awaited<ReturnType<typeof makeTestDb>>;

const GATE = "ohmail/Screener";
const NEWS = "ohmail/News";
const LIST = "list@lists.invalid";
const NOW = new Date("2026-10-07T12:00:00.000Z");
const STAMP = new Date("2026-09-30T08:00:00.000Z");
const at = (s: number): Date => new Date(NOW.getTime() + s * 1000);

/** One mailbox's `ohmail/_meta`, as this install appends to it and the holder drains it. */
function meta(): { reader: RequestReaderIo; organizer: RequestOrganizerIo } {
  const store = new Map<number, string>();
  let uid = 1;
  const list = async () => {
    const records = [...store.entries()].map(([ref, raw]) => ({ ref, raw }));
    return { records, count: records.length, bytes: records.reduce((n, r) => n + Buffer.byteLength(r.raw, "utf8"), 0) };
  };
  return {
    reader: { listMetaRecords: list, async append(raw) { store.set(uid++, raw); } },
    organizer: {
      listMetaRecords: list,
      async ack(raw) { store.set(uid++, raw); },
      async remove(refs) { for (const r of refs) if (typeof r === "number") store.delete(r); },
    },
  };
}

/**
 * NOTHING IS ORGANIZED HERE: both mailboxes are held by one local install (`capabilities`, by
 * default requests and moves). The person let the list in (their own contact and a News rule they
 * wrote); a letter through the list's address waits in `work`, a forgery claiming a company unless
 * `claim` is false (`unchecked`: one the identity check never reached), and the list's own letter is
 * in News in `home`.
 */
export async function readerDoorWorld(db: Db, o: { capabilities?: string; claim?: boolean; unchecked?: boolean } = {}) {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `lrd-${accountId.slice(0, 8)}` });
  const box = async (name: string) => (await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `${name}-${accountId.slice(0, 8)}@own.invalid`,
    organizerRole: "reader", organizerState: "held", organizedByCapabilities: o.capabilities ?? "requests,moves",
    organizedByKind: "local", organizedByName: "Laptop",
  }).returning())[0]!;
  const work = await box("work");
  const home = await box("home");
  await db.insert(contacts).values({ accountId, address: LIST, source: "person" });
  await db.insert(listAddresses).values({ accountId, address: LIST, consentedBrands: [] });
  await db.insert(rules).values({
    accountId, kind: "sender", match: LIST, destination: NEWS, enabled: true, priority: 3,
    provenance: "manual", personDecidedAt: STAMP, retroRequestedAt: STAMP, retroDoneAt: STAMP,
  });
  const letter = async (mailboxId: string, folder: string, name: string, brand: string | null, date: Date) => {
    const [m] = await db.insert(messages).values({
      accountId, mailboxId, bodyHash: "h", dedupKey: `lrd:${randomUUID()}`, subject: name, snippet: "",
      fromAddress: LIST, fromName: name, senderCheckBrand: o.unchecked ? null : brand,
      senderCheck: o.unchecked ? null : brand === null ? "none" : "impersonation",
      date, unread: true, createdAt: date, nativeLocator: { folder, ref: `1:${randomUUID().slice(0, 6)}` },
    }).returning();
    await db.insert(messageBodies).values({ messageId: m!.id, text: "", html: null, headers: {} });
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: folder, observedFolder: folder, lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    return m!.id;
  };
  const post = await letter(home.id, NEWS, "The Lists", null, STAMP);
  const held = o.claim === false
    ? await letter(work.id, GATE, "The Lists", null, NOW)
    : await letter(work.id, GATE, "PostFinance", "PostFinance", NOW);
  const unsubscribed: string[][] = [];
  const svc = new ScreenerService({ unsubscribe: { onScreenOut: async (_ctx, ids) => { unsubscribed.push(ids); return { considered: ids.length }; } } });
  const ctx: ServiceContext = { db: db as never, accountId, userId: null, now: () => NOW, requestId: `lrd-${randomUUID().slice(0, 8)}` };
  return {
    accountId, work, home, post, held, svc, ctx, unsubscribed,
    listRule: () => db.select().from(rules).where(and(eq(rules.accountId, accountId), eq(rules.match, LIST))),
    desired: async (id: string) =>
      (await db.select({ d: folderState.desiredFolder }).from(folderState).where(eq(folderState.messageId, id)))[0]!.d,
    asked: () => db.select().from(organizerRequests).where(eq(organizerRequests.accountId, accountId)),
  };
}

/**
 * A LIST'S CLAIM SCREENED OUT AT A READER'S DOOR (mail 0150): it travels as one move of the claim to
 * its holder, never as a decision about the address, which the holder's store would apply to the
 * whole list. The road is production's: this install's cycle, the holder's drain and its retro pass,
 * on `db` standing in for both stores (each sees its own role).
 */
export async function readerDoorListClaim(db: Db): Promise<void> {
  const w = await readerDoorWorld(db);
  const claim = w.held;
  const before = await w.listRule();
  const answer = await w.svc.decide(w.ctx, claim, { decision: "no", scope: "sender" });
  const asked = await w.asked();
  expect(await w.desired(claim), "this install wrote a placement it does not organize").toBe(GATE);

  // This install's cycle signs and appends; the holder, on its own store, drains each mailbox's folder.
  const folders = new Map([w.work, w.home].map((mb) => [mb.id, {
    io: meta(), key: deriveRequestKey({ auth: { user: mb.address, pass: "the-mailbox-password" }, address: mb.address })!,
  }]));
  for (const [mailboxId, f] of folders) {
    await driveOutstandingRequests(db, {
      mailboxId, accountId: w.accountId, installId: "the-server", requestKey: f.key,
      adapter: { requestReaderIo: () => f.io.reader } as unknown as MailboxAdapter,
    }, { installId: "the-server", kind: "cloud" }, at(1), () => undefined);
  }
  await db.update(mailboxes).set({ organizerRole: "organizer" }).where(inArray(mailboxes.id, [w.work.id, w.home.id]));
  for (const [mailboxId, f] of folders) {
    await applyMetaRequests(db, {
      mailboxId, accountId: w.accountId, installId: "the-laptop", requestKey: f.key,
      adapter: { requestOrganizerIo: () => f.io.organizer } as unknown as MailboxAdapter,
    }, at(60), () => undefined);
  }
  await ruleRetroPass(db as never, { accountId: w.accountId, trustedAuthservIdsFor: async () => new Set<string>() }, at(60));

  expect(await w.desired(claim), "the claim").toBe("ohmail/Screened");
  expect(await w.desired(w.post), "the list's own letter left News").toBe(NEWS);
  expect(await w.listRule(), "the list's News rule moved").toEqual(before);
  expect(await db.select().from(learningSignals).where(eq(learningSignals.accountId, w.accountId)), "a forgery taught the list's address").toEqual([]);
  expect(w.unsubscribed, "a forged letter unsubscribed the person from the list").toEqual([]);

  // What travelled: one move of the claim, to the mailbox holding it, and no decision about the address.
  const [{ dedupKey }] = await db.select({ dedupKey: messages.dedupKey }).from(messages).where(eq(messages.id, claim));
  expect(asked.map((q) => [q.mailboxId, q.kind, q.payload])).toEqual([[w.work.id, "message.move", { dedupKey, destination: "screened" }]]);
  expect(answer).toMatchObject({
    pending: true, requestId: asked[0]!.id, holder: { name: "Laptop" },
    mailboxes: { filed: [], requested: [{ mailboxId: w.work.id, requestId: asked[0]!.id }] },
  });
}
