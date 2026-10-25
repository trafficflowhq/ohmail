import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, folderState, mailboxes, messageBodies, messages } from "@trafficflow/db";
import { ScreenerService } from "../src/screener-service.js";
import { cutlineCounts } from "../src/consent-cutline.js";
import type { ServiceContext } from "../src/context.js";

/**
 * A CLAIM THE GATE HOLDS IS NEVER HIDDEN AS DORMANT (mail 0148). The cutline reads
 * a sender's newest mail by its Date header, which the sender writes: a read claim dated years ago
 * would retire its sender, and the claim would be listed nowhere. The queue lists it, the count
 * beside it counts it, both on one term; the same old mail without the fact is dormant, as before.
 * The claim is dated by its ARRIVAL (the server's INTERNALDATE, as ingest stores it), so a claim
 * that arrived years ago, as the identity backfill finds it, is dormant too (hotfix 0.25.19).
 */
const GATE = "ohmail/Screener";
const NOW = new Date("2026-10-07T12:00:00.000Z");
const SENDER = "kundendienst@karten-service.test";

async function world(claim: boolean, arrivedAt: Date | null = new Date("2026-10-07T11:00:00.000Z")) {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `dc-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `me-${accountId.slice(0, 8)}@ohmail.test`, organizerRole: "organizer",
    initialImportCompletedAt: new Date("2026-01-01T00:00:00.000Z"),
  }).returning();
  // Read, and dated by its sender years before it arrived an hour ago.
  const [m] = await db.insert(messages).values({
    accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `dc:${randomUUID()}`,
    subject: "Ihre Karte", snippet: "", fromAddress: SENDER, fromName: claim ? "PostFinance" : "Anna Meier",
    senderCheck: claim ? "impersonation" : "none", senderCheckBrand: claim ? "PostFinance" : null,
    date: new Date("2020-01-06T09:00:00.000Z"), arrivedAt, unread: false, createdAt: new Date("2026-10-07T11:00:00.000Z"),
    nativeLocator: { folder: GATE, ref: "1:1" },
  }).returning();
  await db.insert(messageBodies).values({ messageId: m!.id, text: "", html: null, headers: {} });
  await db.insert(folderState).values({
    messageId: m!.id, desiredFolder: GATE, observedFolder: GATE, lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
  });
  const ctx: ServiceContext = { db: db as never, accountId, userId: null, now: () => NOW, requestId: `dc-${randomUUID().slice(0, 8)}` };
  return { ctx };
}

describe("a held claim and the cutline", () => {
  it("an old-dated claim is listed and counted active", async () => {
    const w = await world(true);
    const page = await new ScreenerService({}).list(w.ctx, { limit: 50 });
    expect(page.items.map((i) => i.sender.address)).toEqual([SENDER]);
    expect(page.total).toBe(1);
    expect(await cutlineCounts(w.ctx, {})).toEqual({ decidedSenders: 0, activeUndecidedSenders: 1, dormantUndecidedSenders: 0 });
  });

  it("a claim that ARRIVED before the cutline is dormant, whatever stamped the fact", async () => {
    for (const arrivedAt of [new Date("2020-01-06T09:00:04.000Z"), null]) {
      const w = await world(true, arrivedAt);
      expect((await new ScreenerService({}).list(w.ctx, { limit: 50 })).items).toEqual([]);
      expect(await cutlineCounts(w.ctx, {})).toEqual({ decidedSenders: 0, activeUndecidedSenders: 0, dormantUndecidedSenders: 1 });
    }
  });

  it("CONTROL: the same old mail without the fact is dated by its arrival", async () => {
    // Received when its header says: dormant.
    const w = await world(false, new Date("2020-01-06T09:00:04.000Z"));
    const page = await new ScreenerService({}).list(w.ctx, { limit: 50 });
    expect(page.items).toEqual([]);
    expect(await cutlineCounts(w.ctx, {})).toEqual({ decidedSenders: 0, activeUndecidedSenders: 0, dormantUndecidedSenders: 1 });
    // Received an hour ago: it waits, as the gate dated it.
    const now = await world(false);
    expect((await new ScreenerService({}).list(now.ctx, { limit: 50 })).items.map((i) => i.sender.address)).toEqual([SENDER]);
    expect(await cutlineCounts(now.ctx, {})).toEqual({ decidedSenders: 0, activeUndecidedSenders: 1, dormantUndecidedSenders: 0 });
  });
});
