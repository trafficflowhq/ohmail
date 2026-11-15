import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accounts, accountSettings, contacts, folderState, mailboxes, messageBodies, messages, rules, type Tx,
} from "@trafficflow/db";
import { ScreenerService, cutlineCounts, type ServiceContext } from "@trafficflow/services";
import { senderCheckBackfillPass } from "@trafficflow/worker/sender-check-backfill";
import { ruleRetroPass } from "@trafficflow/worker/rule-retro";
import { screenerCorrespondentRetroPass } from "@trafficflow/worker/screener-correspondent-retro";

/**
 * HELD MAIL OF BEFORE THE UPDATE DOES NOT COME BACK TO THE WAITING LIST WHEN THE IDENTITY CHECK STAMPS
 * IT, whoever decided its sender: a person's contact (the gate holds nothing from an address a person
 * consented to), an inferred contact, a person's domain rule. New claims the store wrote as it took
 * them in stay listed, an inferred contact's included, and mail from before the cutline stays out.
 * Runs on whichever store the project gives it.
 */
const GATE = "ohmail/Screener";
const NOW = new Date("2026-10-09T00:00:00.000Z");
const H = 3_600_000;
const D = 24 * H;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const BASELINE = ago(10 * D);

async function world() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `cs-${accountId.slice(0, 8)}` });
  await db.insert(accountSettings).values({ accountId, screeningBaselineAt: BASELINE });
  // The store took its first import nine days ago, which is when it recorded the older rows.
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `me-${accountId.slice(0, 8)}@ohmail.test`, organizerRole: "organizer",
    initialImportCompletedAt: ago(9 * D - H),
  }).returning();
  let n = 0;
  const row = async (r: {
    from: string; name: string; date: Date | null; arrivedAt: Date | null;
    check?: "impersonation"; brand?: string; unread?: boolean; createdAt?: Date;
  }) => {
    const dedup = `cs:${randomUUID()}`;
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: randomUUID(), dedupKey: dedup, messageIdHeader: dedup,
      subject: "Konto", snippet: "", fromAddress: r.from, fromName: r.name,
      // A claim given here is one the store wrote as it took the message in (mail 0149).
      senderCheck: r.check ?? null, senderCheckBrand: r.brand ?? null, senderCheckBy: r.check ? "ingest" : null,
      date: r.date, arrivedAt: r.arrivedAt, unread: r.unread ?? false, createdAt: r.createdAt ?? ago(9 * D),
      nativeLocator: { folder: GATE, ref: `1:${++n}` },
    }).returning();
    await db.insert(messageBodies).values({ messageId: m!.id, accountId: m!.accountId, text: "", html: null, headers: {} });
    await db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: GATE, observedFolder: GATE, lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
  };
  const contact = (address: string, source: "inferred" | "person") => db.insert(contacts).values({ accountId, address, source });
  const domainRule = (match: string) => db.insert(rules).values({
    accountId, kind: "domain", match, destination: "INBOX", enabled: true, priority: 0, provenance: "manual",
  });

  // From before the cutline (baseline less 60 days), unchecked and read.
  await row({ from: "a1@old-never.invalid", name: "PayPal", date: new Date("2024-02-01T08:00:00Z"), arrivedAt: new Date("2024-02-01T08:00:05Z") });
  await row({ from: "a2@old-inferred.invalid", name: "Commerzbank", date: new Date("2025-03-01T08:00:00Z"), arrivedAt: new Date("2025-03-01T08:00:03Z") });
  await contact("a2@old-inferred.invalid", "inferred");
  await row({ from: "a3@old-pre0119.invalid", name: "DocuSign", date: new Date("2023-01-01T08:00:00Z"), arrivedAt: null });
  await contact("a3@old-pre0119.invalid", "inferred");
  await row({ from: "a9@old-domainrule.invalid", name: "Hetzner", date: new Date("2025-11-01T08:00:00Z"), arrivedAt: new Date("2025-11-01T08:00:01Z") });
  await domainRule("old-domainrule.invalid");
  // Held inside the window before 0.25.18, unchecked and read; the person-contact row is FIX-026's.
  await row({ from: "a4@inside-inferred.invalid", name: "PayPal", date: ago(30 * D), arrivedAt: ago(30 * D) });
  await contact("a4@inside-inferred.invalid", "inferred");
  await row({ from: "a5@inside-person.invalid", name: "PayPal", date: ago(30 * D), arrivedAt: ago(30 * D) });
  await contact("a5@inside-person.invalid", "person");
  await row({ from: "a10@inside-domainrule.invalid", name: "PayPal", date: ago(30 * D), arrivedAt: ago(30 * D) });
  await domainRule("inside-domainrule.invalid");
  // New claims the ingest wrote.
  await row({ from: "a8@new-forged.invalid", name: "PayPal", date: new Date("2020-01-01T08:00:00Z"), arrivedAt: ago(2 * H), check: "impersonation", brand: "PayPal", createdAt: ago(2 * H) });
  await row({ from: "a11@new-inferred.invalid", name: "PayPal", date: ago(H), arrivedAt: ago(H), check: "impersonation", brand: "PayPal", createdAt: ago(H) });
  await contact("a11@new-inferred.invalid", "inferred");

  const ctx: ServiceContext = { db: db as never, accountId, userId: null, now: () => NOW, requestId: `cs-${randomUUID().slice(0, 8)}` };
  const tx = db as unknown as Tx;
  const read = async () => {
    const page = await new ScreenerService({}).list(ctx, { limit: 50 });
    return {
      waiting: page.items.map((i) => i.sender.address).sort(), total: page.total,
      counts: await cutlineCounts(ctx, { baselineAt: BASELINE }),
    };
  };
  const placement = async () => (await db.select({ id: folderState.messageId, d: folderState.desiredFolder })
    .from(folderState).innerJoin(messages, eq(messages.id, folderState.messageId))
    .where(eq(messages.accountId, accountId))).sort((a, b) => a.id.localeCompare(b.id));
  const backfill = async () => {
    for (let i = 0; i < 10; i++) if ((await senderCheckBackfillPass(tx, { accountId })).done) return;
    throw new Error("the backfill did not finish");
  };
  const movers = async () => {
    await screenerCorrespondentRetroPass(tx, { accountId, now: () => NOW });
    await ruleRetroPass(tx, { accountId, trustedAuthservIdsFor: async () => new Set<string>() }, NOW);
  };
  return { read, placement, backfill, movers };
}

describe("the identity check and held mail of before the update", () => {
  it("no decided sender's held mail returns; the count is unchanged; new claims stay listed", async () => {
    const w = await world();
    const before = await w.read();
    expect(before.waiting).toEqual(["a11@new-inferred.invalid", "a8@new-forged.invalid"]);
    const placed = await w.placement();

    await w.backfill();
    await w.movers();

    const after = await w.read();
    expect.soft(after.waiting, "a person's contact is not asked about").not.toContain("a5@inside-person.invalid");
    expect.soft(after.waiting, "an inferred contact's held mail of before").not.toContain("a4@inside-inferred.invalid");
    expect.soft(after.waiting, "a person's domain rule's held mail of before").not.toContain("a10@inside-domainrule.invalid");
    expect.soft(after.waiting, "the list is the new claims").toEqual(["a11@new-inferred.invalid", "a8@new-forged.invalid"]);
    for (const old of ["a1@old-never.invalid", "a2@old-inferred.invalid", "a3@old-pre0119.invalid", "a9@old-domainrule.invalid"]) {
      expect.soft(after.waiting, `${old} is from before the cutline`).not.toContain(old);
    }
    expect.soft(after.waiting, "a new claim with a forged Date").toContain("a8@new-forged.invalid");
    expect.soft(after.waiting, "an inferred contact's new claim").toContain("a11@new-inferred.invalid");
    expect.soft(after.total, "the queue's total is its list").toBe(after.waiting.length);
    expect.soft(after.counts, "the count beside it").toEqual(before.counts);
    expect(await w.placement(), "no row moved").toEqual(placed);
  });
});
