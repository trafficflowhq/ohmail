import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accounts, accountSettings, contacts, folderState, mailboxes, messageBodies, messages, rules, type Tx,
} from "@trafficflow/db";
import { ScreenerService, cutlineCounts, unscreenedSummary, type ServiceContext } from "@trafficflow/services";
import { senderCheckBackfillPass } from "@trafficflow/worker/sender-check-backfill";
import { ruleRetroPass } from "@trafficflow/worker/rule-retro";
import { screenerCorrespondentRetroPass } from "@trafficflow/worker/screener-correspondent-retro";

/**
 * THE IDENTITY BACKFILL NEVER RESURFACES MAIL FROM BEFORE THE CUTLINE (hotfix 0.25.19). An install
 * updated to 0.25.18 stamped its old held mail with the identity fact, and the queue's held-claim
 * term listed every such sender whatever its age: years-old phishing in the Waiting list. The
 * fixture is that mailbox on whichever store the project runs: a recent consent baseline, old held
 * and Ohbox mail naming companies, and the four kinds of mail the queue must still list. The queue,
 * its count and the "Screen N" offer read the same before the backfill and after it, and no pass
 * the desktop drain runs moves a row.
 */
const GATE = "ohmail/Screener";
const NOW = new Date("2026-10-08T21:00:00.000Z");
const BASELINE = new Date("2026-09-20T00:00:00.000Z");
const STORE_BUILT = new Date("2026-09-21T08:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

async function world() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `ocd-${accountId.slice(0, 8)}` });
  await db.insert(accountSettings).values({ accountId, screeningBaselineAt: BASELINE });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `me-${accountId.slice(0, 8)}@ohmail.test`, organizerRole: "organizer",
  }).returning();
  const ids: string[] = [];
  const row = async (o: {
    folder: string; from: string; name: string; date: Date; arrivedAt: Date | null;
    check?: "impersonation"; brand?: string; unread?: boolean; createdAt?: Date;
  }) => {
    const dedup = `ocd:${randomUUID()}`;
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: randomUUID(), dedupKey: dedup, messageIdHeader: dedup,
      subject: "Wichtige Mitteilung", snippet: "", fromAddress: o.from, fromName: o.name,
      senderCheck: o.check ?? null, senderCheckBrand: o.brand ?? null,
      date: o.date, arrivedAt: o.arrivedAt, unread: o.unread ?? false, createdAt: o.createdAt ?? STORE_BUILT,
      nativeLocator: { folder: o.folder, ref: `1:${ids.length + 1}` },
    }).returning();
    await db.insert(messageBodies).values({ messageId: m!.id, text: "", html: null, headers: {} });
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: o.folder, observedFolder: o.folder, lastSetBy: "us",
      reconcileStatus: "reconciled", conflict: false,
    });
    ids.push(m!.id);
  };

  // HISTORY, as the update found it: never checked (NULL), read, from senders nobody decided.
  const old = (iso: string) => new Date(iso);
  await row({ folder: GATE, from: "info@karten-hilfe.invalid", name: "PostFinance", date: old("2022-05-10T08:00:00Z"), arrivedAt: old("2022-05-10T08:00:05Z") });
  await row({ folder: GATE, from: "alert@sicher-konto.invalid", name: "UBS Sicherheit", date: old("2024-03-03T08:00:00Z"), arrivedAt: null });
  await row({ folder: GATE, from: "service@giro-check.invalid", name: "Sparkasse Service", date: old("2025-12-01T08:00:00Z"), arrivedAt: old("2025-12-01T08:01:00Z") });
  // A sender the account decided by inference (an inferred contact): 0.25.17 never listed them.
  await row({ folder: GATE, from: "kontakt@partner-firma.invalid", name: "PostFinance", date: old("2025-06-01T08:00:00Z"), arrivedAt: old("2025-06-01T08:00:09Z") });
  await db.insert(contacts).values({ accountId, address: "kontakt@partner-firma.invalid", source: "inferred" });
  // The Ohbox's history: a stranger naming a company, and a domain-admitted sender naming one.
  await row({ folder: "INBOX", from: "noreply@konto-update.invalid", name: "UBS", date: old("2023-07-07T08:00:00Z"), arrivedAt: old("2023-07-07T08:00:02Z") });
  await row({ folder: "INBOX", from: "info@lieferant.invalid", name: "Sparkasse", date: old("2024-09-09T08:00:00Z"), arrivedAt: null });
  await db.insert(rules).values({
    accountId, kind: "domain", match: "lieferant.invalid", destination: "INBOX", enabled: true, priority: 0, provenance: "manual",
  });

  // WHAT THE QUEUE MUST STILL LIST. New mail held at ingest (the ingest wrote the fact), the same
  // with a sender-written Date years old, mail 0.25.17 listed, a decided sender's new claim.
  await row({ folder: GATE, from: "konto@neu-zahlung.invalid", name: "PostFinance", date: hoursAgo(1), arrivedAt: hoursAgo(1), check: "impersonation", brand: "PostFinance", unread: true, createdAt: hoursAgo(1) });
  await row({ folder: GATE, from: "x@alt-datum.invalid", name: "UBS", date: old("2020-01-06T09:00:00Z"), arrivedAt: hoursAgo(2), check: "impersonation", brand: "UBS", createdAt: hoursAgo(2) });
  await row({ folder: GATE, from: "anna@bekannt-neu.invalid", name: "Anna Meier", date: old("2026-09-30T08:00:00Z"), arrivedAt: old("2026-09-30T08:00:01Z") });
  await row({ folder: GATE, from: "rechnung@partner-zwei.invalid", name: "PostFinance", date: hoursAgo(3), arrivedAt: hoursAgo(3), check: "impersonation", brand: "PostFinance", createdAt: hoursAgo(3) });
  await db.insert(contacts).values({ accountId, address: "rechnung@partner-zwei.invalid", source: "inferred" });

  const ctx: ServiceContext = { db: db as never, accountId, userId: null, now: () => NOW, requestId: `ocd-${randomUUID().slice(0, 8)}` };
  const tx = db as unknown as Tx;
  const read = async () => {
    const page = await new ScreenerService({}).list(ctx, { limit: 50 });
    return {
      waiting: page.items.map((i) => i.sender.address).sort(),
      total: page.total,
      counts: await cutlineCounts(ctx, { baselineAt: BASELINE }),
      screenOffer: (await unscreenedSummary(tx, accountId, NOW)).groups.map((g) => g.address).sort(),
    };
  };
  const placement = async () => (await db.select({ id: folderState.messageId, d: folderState.desiredFolder, o: folderState.observedFolder })
    .from(folderState).innerJoin(messages, eq(messages.id, folderState.messageId))
    .where(eq(messages.accountId, accountId))).sort((a, b) => a.id.localeCompare(b.id));
  const backfill = async () => {
    for (let i = 0; i < 10; i++) if ((await senderCheckBackfillPass(tx, { accountId })).done) return;
    throw new Error("the backfill did not finish");
  };
  return { db, tx, accountId, ctx, read, placement, backfill };
}

describe("the identity backfill and the Screener's Waiting list", () => {
  it("the queue, its count and the Screen offer read as 0.25.17's after the backfill; nothing moves", async () => {
    const w = await world();
    const listed = [
      "anna@bekannt-neu.invalid", "konto@neu-zahlung.invalid", "rechnung@partner-zwei.invalid", "x@alt-datum.invalid",
    ];
    // The stranger's Ohbox mail is history (2023, before the window): the offer leaves it, and the
    // domain-admitted sender's, in the Inbox.
    const offered: string[] = [];
    const before = await w.read();
    expect.soft(before.waiting, "what 0.25.17 listed, plus new mail held at ingest").toEqual(listed);
    expect.soft(before.screenOffer, "the Screen offer before the backfill").toEqual(offered);
    const placed = await w.placement();

    await w.backfill();
    // The desktop drain's movers after the backfill: the correspondent retro and the rule retro.
    await screenerCorrespondentRetroPass(w.tx, { accountId: w.accountId, now: () => NOW });
    await ruleRetroPass(w.tx, { accountId: w.accountId, trustedAuthservIdsFor: async () => new Set<string>() }, NOW);

    const after = await w.read();
    expect.soft(after.waiting, "no historical sender resurfaces").toEqual(listed);
    expect.soft(after.total, "the queue's total").toBe(listed.length);
    expect.soft(after.counts, "the count beside it").toEqual(before.counts);
    expect.soft(after.screenOffer, "the Screen offer is not widened by the fact").toEqual(offered);
    expect(await w.placement(), "no row moved").toEqual(placed);
  });
});
