import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accounts, accountSettings, contacts, folderState, mailboxes, messageBodies, messages, rules, type Tx,
} from "@trafficflow/db";
import { ScreenerService, cutlineCounts, type ServiceContext } from "@trafficflow/services";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { senderCheckBackfillPass } from "@trafficflow/worker/sender-check-backfill";
import { ruleRetroPass } from "@trafficflow/worker/rule-retro";
import { screenerCorrespondentRetroPass } from "@trafficflow/worker/screener-correspondent-retro";

/**
 * THE HELD-CLAIM TERM DATES A CLAIM BY WHO WROTE THE FACT (mail 0149), on whichever store the project
 * runs. Mail held before the update stays out of the Waiting list once the identity check marks it,
 * whoever decided its sender; a claim the store wrote as it took the message in is listed by its record
 * time, with no receive time and on a one-day window alike; a fresh store's first import is not listed;
 * a claim marked by a build before the column keeps its arrival. Nothing moves.
 */
const GATE = "ohmail/Screener";
const NOW = new Date("2026-10-09T00:00:00.000Z");
const H = 3_600_000;
const D = 24 * H;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const at = (iso: string) => new Date(iso);

async function world(o: { baselineAt: Date; dormancyDays?: number; importDoneAt: Date | null }) {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `cb-${accountId.slice(0, 8)}` });
  await db.insert(accountSettings).values({ accountId, screeningBaselineAt: o.baselineAt, dormancyDays: o.dormancyDays ?? null });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `me-${accountId.slice(0, 8)}@ohmail.test`, organizerRole: "organizer",
    initialImportCompletedAt: o.importDoneAt,
  }).returning();
  const ids = new Map<string, string>();
  let n = 0;
  /** A held row. `by` absent: unchecked (the backfill's question); `null`: marked by a build before 0149. */
  const row = async (r: {
    from: string; name: string; date: Date | null; arrivedAt: Date | null; recordedAt: Date;
    by?: "ingest" | null; unread?: boolean;
  }) => {
    const dedup = `cb:${randomUUID()}`;
    const marked = r.by !== undefined;
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: randomUUID(), dedupKey: dedup, messageIdHeader: dedup,
      subject: "Konto", snippet: "", fromAddress: r.from, fromName: r.name,
      senderCheck: marked ? "impersonation" : null, senderCheckBrand: marked ? r.name : null, senderCheckBy: r.by ?? null,
      date: r.date, arrivedAt: r.arrivedAt, unread: r.unread ?? false, createdAt: r.recordedAt,
      nativeLocator: { folder: GATE, ref: `1:${++n}` },
    }).returning();
    await db.insert(messageBodies).values({ messageId: m!.id, text: "", html: null, headers: {} });
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: GATE, observedFolder: GATE, lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    ids.set(r.from, m!.id);
  };
  const contact = (address: string, source: "inferred" | "person", createdAt: Date) =>
    db.insert(contacts).values({ accountId, address, source, createdAt });
  const domainRule = (match: string, createdAt: Date) => db.insert(rules).values({
    accountId, kind: "domain", match, destination: "INBOX", enabled: true, priority: 0, provenance: "manual", createdAt, updatedAt: createdAt,
  });
  const ctx: ServiceContext = { db: db as never, accountId, userId: null, now: () => NOW, requestId: `cb-${randomUUID().slice(0, 8)}` };
  const tx = db as unknown as Tx;
  const read = async () => {
    const page = await new ScreenerService({}).list(ctx, { limit: 50 });
    return {
      waiting: page.items.map((i) => i.sender.address.split("@")[0]).sort(),
      total: page.total,
      counts: await cutlineCounts(ctx, { baselineAt: o.baselineAt, ...(o.dormancyDays === undefined ? {} : { dormancyDays: o.dormancyDays }) }),
    };
  };
  const placement = async () => (await db.select({ id: folderState.messageId, d: folderState.desiredFolder })
    .from(folderState).innerJoin(messages, eq(messages.id, folderState.messageId))
    .where(eq(messages.accountId, accountId))).sort((a, b) => a.id.localeCompare(b.id));
  const byOf = async (from: string) =>
    (await db.select({ c: messages.senderCheck, by: messages.senderCheckBy }).from(messages).where(eq(messages.id, ids.get(from)!)))[0];
  const backfill = async () => {
    for (let i = 0; i < 10; i++) if ((await senderCheckBackfillPass(tx, { accountId })).done) return;
    throw new Error("the backfill did not finish");
  };
  const movers = async () => {
    await screenerCorrespondentRetroPass(tx, { accountId, now: () => NOW });
    await ruleRetroPass(tx, { accountId, trustedAuthservIdsFor: async () => new Set<string>() }, NOW);
  };
  return { db, accountId, mailboxId: mb!.id, row, contact, domainRule, read, placement, byOf, backfill, movers };
}

describe("the held-claim term and who wrote the fact", () => {
  it("a long-lived store: the update lists no held mail of before, whoever decided its sender", async () => {
    const w = await world({ baselineAt: ago(10 * D), importDoneAt: ago(400 * D) });
    const ARRIVED = ago(30 * D);
    // Held before the update and unchecked, each recorded when it arrived; a1-a9 from before the cutline.
    await w.row({ from: "a1@old-never.invalid", name: "PayPal", date: at("2024-02-01T08:00:00Z"), arrivedAt: at("2024-02-01T08:00:05Z"), recordedAt: at("2024-02-01T08:00:06Z") });
    await w.row({ from: "a2@old-inferred.invalid", name: "Commerzbank", date: at("2025-03-01T08:00:00Z"), arrivedAt: at("2025-03-01T08:00:03Z"), recordedAt: at("2025-03-01T08:00:04Z") });
    await w.contact("a2@old-inferred.invalid", "inferred", at("2025-03-02T08:00:00Z"));
    await w.row({ from: "a3@old-pre0119.invalid", name: "DocuSign", date: at("2023-01-01T08:00:00Z"), arrivedAt: null, recordedAt: at("2023-01-01T08:01:00Z") });
    await w.contact("a3@old-pre0119.invalid", "inferred", at("2023-02-01T08:00:00Z"));
    await w.row({ from: "a9@old-domainrule.invalid", name: "Hetzner", date: at("2025-11-01T08:00:00Z"), arrivedAt: at("2025-11-01T08:00:01Z"), recordedAt: at("2025-11-01T08:00:02Z") });
    await w.domainRule("old-domainrule.invalid", at("2025-11-02T08:00:00Z"));
    // …and inside the window, the review's halves: inference, a person's domain rule, a forged Date.
    await w.row({ from: "a4@inside-inferred.invalid", name: "PayPal", date: ARRIVED, arrivedAt: ARRIVED, recordedAt: ARRIVED });
    await w.contact("a4@inside-inferred.invalid", "inferred", ago(20 * D));
    await w.row({ from: "a10@inside-domainrule.invalid", name: "PayPal", date: ARRIVED, arrivedAt: ARRIVED, recordedAt: ARRIVED });
    await w.domainRule("inside-domainrule.invalid", ago(20 * D));
    await w.row({ from: "a14@inside-forged.invalid", name: "PayPal", date: at("2021-05-05T08:00:00Z"), arrivedAt: ARRIVED, recordedAt: ARRIVED });
    // Marked by a build before the column: dated by the arrival, so the outside one has aged out.
    await w.row({ from: "n1@marked-inside.invalid", name: "PayPal", date: ago(5 * D), arrivedAt: ago(5 * D), recordedAt: ago(5 * D), by: null });
    await w.contact("n1@marked-inside.invalid", "inferred", ago(4 * D));
    await w.row({ from: "n2@marked-outside.invalid", name: "PayPal", date: ago(100 * D), arrivedAt: ago(100 * D), recordedAt: ago(100 * D), by: null });
    await w.domainRule("marked-outside.invalid", ago(90 * D));
    // Written at ingest after the update: listed by the record time, however the sender dated them.
    await w.row({ from: "a6@new-null.invalid", name: "PayPal", date: at("2020-01-01T08:00:00Z"), arrivedAt: null, recordedAt: ago(H), by: "ingest", unread: true });
    await w.row({ from: "a7@new-null-inferred.invalid", name: "PayPal", date: at("2020-01-01T08:00:00Z"), arrivedAt: null, recordedAt: ago(H), by: "ingest", unread: true });
    await w.contact("a7@new-null-inferred.invalid", "inferred", ago(2 * D));
    await w.row({ from: "a8@new-forged.invalid", name: "PayPal", date: at("2020-01-01T08:00:00Z"), arrivedAt: ago(2 * H), recordedAt: ago(2 * H), by: "ingest" });
    await w.row({ from: "a11@new-inferred.invalid", name: "PayPal", date: ago(H), arrivedAt: ago(H), recordedAt: ago(H), by: "ingest" });
    await w.contact("a11@new-inferred.invalid", "inferred", ago(2 * D));
    await w.row({ from: "a12@new-domainrule.invalid", name: "PayPal", date: ago(H), arrivedAt: ago(H), recordedAt: ago(H), by: "ingest" });
    await w.domainRule("new-domainrule.invalid", ago(2 * D));
    await w.row({ from: "a13@later-inferred.invalid", name: "PayPal", date: ago(30 * H), arrivedAt: ago(30 * H), recordedAt: ago(30 * H), by: "ingest" });
    await w.contact("a13@later-inferred.invalid", "inferred", ago(20 * H));
    await w.row({ from: "a15@ingest-outside.invalid", name: "PayPal", date: ago(100 * D), arrivedAt: ago(100 * D), recordedAt: ago(100 * D), by: "ingest" });
    await w.contact("a15@ingest-outside.invalid", "inferred", ago(90 * D));

    // a14 is undecided and arrived inside the window: it waits by its arrival, whatever its Date.
    const listed = ["a11", "a12", "a13", "a14", "a6", "a7", "a8", "n1"];
    const before = await w.read();
    expect.soft(before.waiting, "before the backfill").toEqual(listed);
    const placed = await w.placement();
    await w.backfill();
    await w.movers();
    const after = await w.read();
    expect.soft(after.waiting, "the backfill lists nothing of before").toEqual(listed);
    expect.soft(after.total, "the queue's total").toBe(listed.length);
    expect.soft(after.counts, "the count beside it").toEqual(before.counts);
    // A decided sender whose claim is held waits again, so the count asks the list's own term.
    expect.soft(after.counts.activeUndecidedSenders, "every listed sender").toBe(listed.length);
    for (const from of ["a4@inside-inferred.invalid", "a10@inside-domainrule.invalid", "a14@inside-forged.invalid"]) {
      expect.soft(await w.byOf(from), `${from} was marked by the backfill`).toEqual({ c: "impersonation", by: "backfill" });
    }
    expect(await w.placement(), "no row moved").toEqual(placed);
  });

  it("a one-day window and a fresh baseline: a 47 h Date lead and a missing receive time are listed", async () => {
    const w = await world({ baselineAt: ago(2 * H), dormancyDays: 1, importDoneAt: ago(30 * D) });
    await w.row({ from: "b1@lead.invalid", name: "PayPal", date: ago(48 * H), arrivedAt: ago(H), recordedAt: ago(H), by: "ingest", unread: true });
    await w.row({ from: "b2@even.invalid", name: "PayPal", date: ago(H), arrivedAt: ago(H), recordedAt: ago(H), by: "ingest", unread: true });
    await w.row({ from: "b3@no-arrival.invalid", name: "PayPal", date: at("2020-01-01T08:00:00Z"), arrivedAt: null, recordedAt: ago(H), by: "ingest", unread: true });
    // The same lead on a row marked before the column keeps the arrival rule, and is outside it.
    await w.row({ from: "b4@marked-lead.invalid", name: "PayPal", date: ago(48 * H), arrivedAt: ago(H), recordedAt: ago(H), by: null });
    expect((await w.read()).waiting).toEqual(["b1", "b2", "b3"]);
  });

  it("a fresh store: its first import is not listed, mail after it is", async () => {
    const w = await world({ baselineAt: ago(10 * D), importDoneAt: ago(2 * H) });
    const IMPORT = ago(2.5 * H);
    await w.row({ from: "f1@old.invalid", name: "PayPal", date: at("2024-02-01T08:00:00Z"), arrivedAt: at("2024-02-01T08:00:05Z"), recordedAt: IMPORT, by: "ingest" });
    await w.row({ from: "f2@old-no-arrival.invalid", name: "PayPal", date: at("2023-01-01T08:00:00Z"), arrivedAt: null, recordedAt: IMPORT, by: "ingest" });
    await w.row({ from: "f3@old-inferred.invalid", name: "PayPal", date: at("2025-03-01T08:00:00Z"), arrivedAt: at("2025-03-01T08:00:03Z"), recordedAt: IMPORT, by: "ingest" });
    await w.contact("f3@old-inferred.invalid", "inferred", ago(3 * H));
    await w.row({ from: "f4@old-domainrule.invalid", name: "PayPal", date: at("2024-06-01T08:00:00Z"), arrivedAt: null, recordedAt: IMPORT, by: "ingest" });
    await w.domainRule("old-domainrule.invalid", ago(3 * H));
    await w.row({ from: "f5@inside-inferred.invalid", name: "PayPal", date: ago(30 * D), arrivedAt: ago(30 * D), recordedAt: IMPORT, by: "ingest" });
    await w.contact("f5@inside-inferred.invalid", "inferred", ago(3 * H));
    await w.row({ from: "f6@new.invalid", name: "PayPal", date: ago(0.5 * H), arrivedAt: ago(0.5 * H), recordedAt: ago(0.5 * H), by: "ingest", unread: true });
    await w.row({ from: "f7@new-no-arrival.invalid", name: "PayPal", date: at("2020-01-01T08:00:00Z"), arrivedAt: null, recordedAt: ago(0.5 * H), by: "ingest", unread: true });
    await w.row({ from: "f8@new-inferred.invalid", name: "PayPal", date: at("2020-01-01T08:00:00Z"), arrivedAt: null, recordedAt: ago(0.5 * H), by: "ingest", unread: true });
    await w.contact("f8@new-inferred.invalid", "inferred", ago(3 * H));
    expect((await w.read()).waiting).toEqual(["f6", "f7", "f8"]);
  });

  it("a mailbox still importing lists none of what its import records", async () => {
    const w = await world({ baselineAt: ago(10 * D), importDoneAt: null });
    await w.row({ from: "i1@during.invalid", name: "PayPal", date: at("2020-01-01T08:00:00Z"), arrivedAt: ago(H), recordedAt: ago(H), by: "ingest" });
    expect((await w.read()).waiting).toEqual([]);
  });

  it("the writers: the store's own ingest stamps 'ingest', the backfill 'backfill'", async () => {
    const w = await world({ baselineAt: ago(10 * D), importDoneAt: ago(400 * D) });
    const repo = makeDrizzleRepo(w.db as unknown as Parameters<typeof makeDrizzleRepo>[0]);
    let uid = 0;
    const insert = (from: string, fact: { brand: string; via: "name" } | null) => repo.insertMessage({
      accountId: w.accountId, mailboxId: w.mailboxId, canonical: { messageIdHeader: `${from}-id`, bodyHash: randomUUID() },
      dedupKey: `cb:${randomUUID()}`, subject: "Konto", fromAddress: from, fromName: "PayPal", date: NOW,
      nativeLocator: { folder: GATE, ref: `9:${++uid}` },
      flags: { no_ai: false, no_forward: false, no_kb: false, priority: false }, senderCheck: fact,
    });
    const claim = await insert("w1@ingest.invalid", { brand: "PayPal", via: "name" });
    const clean = await insert("w2@ingest.invalid", null);
    const read = async (id: string) =>
      (await w.db.select({ c: messages.senderCheck, by: messages.senderCheckBy }).from(messages).where(eq(messages.id, id)))[0];
    expect(await read(claim.id)).toEqual({ c: "impersonation", by: "ingest" });
    expect(await read(clean.id)).toEqual({ c: "none", by: "ingest" });

    await w.row({ from: "w3@before.invalid", name: "PayPal", date: ago(3 * D), arrivedAt: ago(3 * D), recordedAt: ago(3 * D) });
    await w.row({ from: "w4@before.invalid", name: "Anna Meier", date: ago(3 * D), arrivedAt: ago(3 * D), recordedAt: ago(3 * D) });
    await w.backfill();
    expect(await w.byOf("w3@before.invalid")).toEqual({ c: "impersonation", by: "backfill" });
    expect(await w.byOf("w4@before.invalid")).toEqual({ c: "none", by: "backfill" });
  });
});
