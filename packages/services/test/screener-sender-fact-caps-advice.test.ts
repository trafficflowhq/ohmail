import { describe, expect, it } from "vitest";
import { personalAt } from "../../../test/support/fixture-credentials.js";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accounts, folderState, mailboxes, messageBodies, messages, routingDecisions,
  SCREENER_SUGGESTION_PROVENANCE, SCREENER_SUGGESTION_STATUS,
} from "@trafficflow/db";
import type { ClassifierResult } from "@trafficflow/core";
import { ScreenerService } from "../src/screener-service.js";
import type { ServiceContext } from "../src/context.js";

/**
 * THE SENDER'S FACT CAPS THE ADVICE WHATEVER MESSAGE IT WAS BOUGHT ON (mail 0148): the queue
 * row is the sender's newest held message, which claims nothing, and an OLDER one claims
 * PostFinance from a gmail address. The row carries the fact aggregated over both, and the stored
 * an "Ohbox" suggestion bought on the benign message is shown capped with the reason beside it. On
 * whichever store the project runs: the aggregate is a window both stores spell alike.
 */
const GATE = "ohmail/Screener";
const NOW = new Date("2026-10-07T12:00:00.000Z");
const SENDER = personalAt("fixture.mila", "gmail.com");

async function world(opts: { olderMarked: boolean }) {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `cap-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `me-${accountId.slice(0, 8)}@ohmail.test`, organizerRole: "organizer",
  }).returning();
  const held = async (at: Date, fromName: string, senderCheck: "none" | "impersonation") => {
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: randomUUID(), dedupKey: `cap:${randomUUID()}`,
      subject: "Ihre Karte", snippet: "", fromAddress: SENDER, fromName,
      senderCheck, senderCheckBrand: senderCheck === "impersonation" ? "PostFinance" : null,
      date: at, unread: true, createdAt: at, nativeLocator: { folder: GATE, ref: `1:${randomUUID().slice(0, 6)}` },
    }).returning();
    await db.insert(messageBodies).values({ messageId: m!.id, text: "", html: null, headers: {} });
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: GATE, observedFolder: GATE, lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    return m!.id;
  };
  await held(new Date("2026-10-06T08:00:00.000Z"), opts.olderMarked ? "PostFinance" : "Kundendienst",
    opts.olderMarked ? "impersonation" : "none");
  const newest = await held(new Date("2026-10-06T09:00:00.000Z"), "Kundendienst", "none");
  await db.insert(routingDecisions).values({
    accountId, messageId: newest, inputProvenance: SCREENER_SUGGESTION_PROVENANCE,
    destination: "INBOX", confidence: 0.95, rationale: "a customer service desk", spam: false, status: SCREENER_SUGGESTION_STATUS,
  } as never);
  const ctx: ServiceContext = {
    db: db as never, accountId, userId: null, now: () => NOW, requestId: `cap-${randomUUID().slice(0, 8)}`,
  };
  return { ctx, newest };
}

describe("the sender's identity fact caps the advice bought on another of their messages", () => {
  it("the row is the benign newest message, and its advice is capped by the older marked one", async () => {
    const w = await world({ olderMarked: true });
    const { items } = await new ScreenerService({}).list(w.ctx, { limit: 50 });
    expect(items.map((i) => i.messageId)).toEqual([w.newest]);
    expect(items[0]!.checked).toEqual({ reason: "impersonation", brand: "PostFinance", domainShared: true });
    expect(items[0]!.aiSuggestion).toMatchObject({ reasonCode: "impersonation", reasonBrand: "PostFinance" });
    expect(items[0]!.aiSuggestion!.decision).not.toBe("yes");
  });

  it("CONTROL: with neither message marked the row says no fact and the advice stands as bought", async () => {
    const w = await world({ olderMarked: false });
    const { items } = await new ScreenerService({}).list(w.ctx, { limit: 50 });
    expect(items[0]!.checked).toBeUndefined();
    expect(items[0]!.aiSuggestion).toMatchObject({ destination: "INBOX", decision: "yes", confidence: 0.95 });
    expect(items[0]!.aiSuggestion!.reasonCode).toBeUndefined();
  });
});

/* A PRESSED PURCHASE STORES THE FACT THAT CAPPED IT (mail 0156), on this store too: the local engine's
   act reads it before it writes a rule. One purchase per press, so one lane: the other shop's advice is
   on record, answered from the store and still in the set the check reads. */
describe("a pressed purchase stores the fact that capped its suggestion", () => {
  const RECEIPTS: ClassifierResult = { destination: "ohmail/Receipts", confidence: 0.95, rationale: "an order receipt", spam: false };

  async function shops() {
    const db = await makeTestDb();
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `why-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `me-${accountId.slice(0, 8)}@ohmail.test`, organizerRole: "organizer",
    }).returning();
    const held = async (from: string, subject: string) => {
      const [m] = await db.insert(messages).values({
        accountId, mailboxId: mb!.id, bodyHash: randomUUID(), dedupKey: `why:${randomUUID()}`,
        subject, snippet: "Thanks for shopping with us.", fromAddress: from, authVerdict: "pass", senderCheck: "none",
        date: NOW, unread: true, createdAt: NOW, nativeLocator: { folder: GATE, ref: `1:${randomUUID().slice(0, 6)}` },
      }).returning();
      await db.insert(messageBodies).values({ messageId: m!.id, text: "", html: null, headers: {} });
      await db.insert(folderState).values({
        messageId: m!.id, desiredFolder: GATE, observedFolder: GATE, lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
      });
      return m!.id;
    };
    const ctx: ServiceContext = {
      db: db as never, accountId, userId: null, now: () => NOW, requestId: `why-${randomUUID().slice(0, 8)}`,
    };
    const svc = new ScreenerService({ classifier: { classify: async () => RECEIPTS, screen: async () => RECEIPTS } });
    const stored = async (messageId: string) =>
      (await db.select().from(routingDecisions).where(eq(routingDecisions.messageId, messageId)))[0];
    return { db, accountId, held, ctx, svc, stored };
  }

  it("one subject from two first-time shops: stored as the crowd's; a shop alone: stored as none", async () => {
    const w = await shops();
    const a = await w.held("orders@shop-a.example", "Your order has shipped");
    const b = await w.held("orders@shop-b.example", "Your order has shipped");
    await w.db.insert(routingDecisions).values({
      accountId: w.accountId, messageId: b, inputProvenance: SCREENER_SUGGESTION_PROVENANCE,
      destination: "ohmail/Quarantine", confidence: 0.95, rationale: "", spam: true, status: SCREENER_SUGGESTION_STATUS,
      senderReason: "campaign",
    });
    const res = await w.svc.suggest(w.ctx, { senders: ["orders@shop-a.example", "orders@shop-b.example"] });
    expect(res.suggestions.find((s) => s.messageId === a)).toMatchObject({ destination: "ohmail/Quarantine", reasonCode: "campaign" });
    expect(await w.stored(a)).toMatchObject({ destination: "ohmail/Quarantine", spam: true, senderReason: "campaign" });

    const c = await w.held("orders@shop-c.example", "Your invoice for March");
    await w.svc.suggest(w.ctx, { senders: ["orders@shop-c.example"] });
    expect(await w.stored(c)).toMatchObject({ destination: "ohmail/Receipts", senderReason: "none" });
  });
});
