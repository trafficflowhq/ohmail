import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import {
  accounts, auditLog, changeLog, contacts, folderState, mailboxes, messageBodies, messages, rules, threads,
} from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { commitChange, planChange, UNMETERED_STORAGE_CAP, type Change } from "@trafficflow/core";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { makeProfileDoc, profileGateView } from "@trafficflow/core/adapters/organizer-profile";
import {
  screenUnscreened, unscreenedSummary, type ServiceContext,
} from "../src/mail.js";
import { OHBOX_UNSCREENED_GROUPS_MAX, OHBOX_UNSCREENED_MESSAGES_MAX } from "../src/ohbox-unscreened-service.js";

/**
 * THE UNDECIDED-SENDER WALK, ON BOTH STORES.
 *
 * This service is on the mail leaf, so the sidecar and the STANDALONE PHONE serve its two routes
 * out of `localRoutes` — the phone against SQLite through the drizzle proxy. Its first draft spelled
 * `::uuid`, `::jsonb` and `FOR UPDATE OF folder_state` inline; `dialect-census.test.ts` refused all
 * four by name, and this file is the behavioural half of that refusal: the same walk, the same
 * press, run in BOTH projects (the default PGlite one and `pnpm test:sqlite`), so a server-only
 * spelling is a red here rather than a phone that cannot draw its own Screener.
 */

const OHBOX = "INBOX";
const GATE = "ohmail/Screener";
const NOW = new Date("2026-09-22T09:00:00.000Z");
// Inside the default window; OLD is outside it, the control each count carries.
const ARRIVED = new Date("2026-09-17T08:00:00.000Z");
const OLD = new Date("2024-03-01T08:00:00.000Z");

async function world() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `oud-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `oud-${accountId.slice(0, 8)}@example.test`,
    organizerRole: "organizer",
  }).returning();
  return { db, accountId, mailboxId: mb!.id };
}

let n = 0;

async function seed(
  w: Awaited<ReturnType<typeof world>>, from: string, body = "",
  thread?: { threadId: string; to?: string[]; headers?: Record<string, string[]> }, arrivedAt = ARRIVED,
): Promise<string> {
  const i = n++;
  const [m] = await w.db.insert(messages).values({
    accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: `h${i}`,
    dedupKey: `oud:${randomUUID()}`, subject: `Note ${i}`, fromAddress: from,
    date: arrivedAt, createdAt: arrivedAt, arrivedAt, unread: false,
    nativeLocator: { folder: OHBOX, ref: `1:${i}` },
    ...(thread ? {
      threadId: thread.threadId, messageIdHeader: `m${i}@x.test`,
      toAddresses: (thread.to ?? []).map((address) => ({ name: null, address })),
    } : {}),
  }).returning();
  await w.db.insert(messageBodies).values({
    messageId: m!.id, text: body, html: null, headers: thread?.headers ?? {},
  });
  await w.db.insert(folderState).values({
    messageId: m!.id, desiredFolder: OHBOX, observedFolder: OHBOX,
    lastSetBy: "external", reconcileStatus: "reconciled", conflict: false,
  });
  return m!.id;
}

/** A thread row for the three thread cases — the column is a foreign key on both stores. */
async function threadOf(w: Awaited<ReturnType<typeof world>>): Promise<string> {
  const [t] = await w.db.insert(threads).values({ accountId: w.accountId, subject: "Plans" }).returning();
  return t!.id;
}

const ctxOf = (w: Awaited<ReturnType<typeof world>>): ServiceContext => ({
  db: w.db as unknown as ServiceContext["db"], accountId: w.accountId, userId: null,
  now: () => NOW, requestId: `oud-${randomUUID().slice(0, 8)}`,
});

const desiredOf = async (
  w: Awaited<ReturnType<typeof world>>, id: string,
): Promise<string> => {
  const [row] = await w.db.select({ d: folderState.desiredFolder })
    .from(folderState).where(eq(folderState.messageId, id));
  return row!.d;
};

describe("the undecided-sender walk speaks both dialects", () => {
  it("counts the stranger's mail and leaves the decided sender's alone", async () => {
    const w = await world();
    await w.db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: "ruled@x.test", destination: "INBOX",
      provenance: "manual", enabled: true, priority: 0, retroRequestedAt: null,
    });
    await w.db.insert(contacts).values({ accountId: w.accountId, address: "pal@x.test" });
    await seed(w, "ruled@x.test");
    await seed(w, "pal@x.test");
    await seed(w, "stranger@x.test");
    await seed(w, "stranger@x.test");
    await seed(w, "olden@x.test", "", undefined, OLD);

    const summary = await unscreenedSummary(w.db as never, w.accountId, NOW);
    expect(summary.groups).toEqual([
      { address: "stranger@x.test", count: 2, newestAt: ARRIVED.toISOString() },
    ]);
    expect(summary.total).toBe(2);
    expect(summary.complete, "a walk that read every candidate is the whole count").toBe(true);
  });

  async function seedMany(w: Awaited<ReturnType<typeof world>>, count: number, senders: number) {
    const rows = Array.from({ length: count }, (_, i) => ({
      accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: `cap${i}`, dedupKey: `cap:${randomUUID()}`,
      subject: `Cap ${i}`, fromAddress: `s${i % senders}@x.test`, date: ARRIVED, createdAt: ARRIVED, arrivedAt: ARRIVED,
      unread: false, nativeLocator: { folder: OHBOX, ref: `9:${i}` },
    }));
    const ids = (await w.db.insert(messages).values(rows).returning({ id: messages.id })).map((r) => r.id);
    await w.db.insert(messageBodies).values(ids.map((messageId) => ({ messageId, text: "", html: null, headers: {} })));
    await w.db.insert(folderState).values(ids.map((messageId) => ({
      messageId, desiredFolder: OHBOX, observedFolder: OHBOX, lastSetBy: "external" as const,
      reconcileStatus: "reconciled" as const, conflict: false,
    })));
  }

  it("a walk stopped at the bound says its total is a floor", async () => {
    const w = await world();
    await seedMany(w, OHBOX_UNSCREENED_MESSAGES_MAX + 5, 7);
    const summary = await unscreenedSummary(w.db as never, w.accountId, NOW);
    expect(summary.total).toBe(OHBOX_UNSCREENED_MESSAGES_MAX);
    expect(summary.complete).toBe(false);
  }, 120_000);

  it("a list cut at the sender bound says its total is a floor", async () => {
    const w = await world();
    const senders = OHBOX_UNSCREENED_GROUPS_MAX + 50;
    await seedMany(w, senders * 2, senders);
    const summary = await unscreenedSummary(w.db as never, w.accountId, NOW);
    expect(summary.groups).toHaveLength(OHBOX_UNSCREENED_GROUPS_MAX);
    expect(summary.total).toBe(OHBOX_UNSCREENED_GROUPS_MAX * 2);
    expect(summary.complete, "the shown groups leave senders out").toBe(false);
  }, 120_000);

  it("the press writes the intent, on either store, and a second press finds nothing", async () => {
    const w = await world();
    const id = await seed(w, "stranger@x.test");
    const old = await seed(w, "stranger@x.test", "", undefined, OLD);

    const pressed = await screenUnscreened(ctxOf(w));
    expect(pressed.total).toBe(1);
    expect(await desiredOf(w, id)).toBe(GATE);
    expect(await desiredOf(w, old)).toBe(OHBOX);

    expect((await unscreenedSummary(w.db as never, w.accountId, NOW)).total).toBe(0);
    expect(await screenUnscreened(ctxOf(w))).toEqual({ screened: [], total: 0 });
  });

  it("the press's rows: status by observed folder, one move per letter on contiguous seqs in walk order, one audit per group", async () => {
    const w = await world();
    const ids = [
      await seed(w, "b@x.test"), await seed(w, "a@x.test"), await seed(w, "b@x.test"),
      await seed(w, "c@x.test"), await seed(w, "b@x.test"),
    ];
    const already = ids[3]!;
    await w.db.update(folderState).set({ observedFolder: GATE, reconcileStatus: "pending" })
      .where(eq(folderState.messageId, already));

    expect((await screenUnscreened(ctxOf(w))).total).toBe(5);

    const states = await w.db.select({ id: folderState.messageId, s: folderState.reconcileStatus, by: folderState.lastSetBy })
      .from(folderState);
    expect(Object.fromEntries(states.map((r) => [r.id, [r.s, r.by]]))).toEqual(Object.fromEntries(
      ids.map((id) => [id, [id === already ? "reconciled" : "pending", "us"]]),
    ));
    const changes = await w.db.select({ seq: changeLog.seq, id: changeLog.entityId, op: changeLog.op, meta: changeLog.meta })
      .from(changeLog).where(eq(changeLog.accountId, w.accountId)).orderBy(asc(changeLog.seq));
    expect(changes.map((c) => c.id)).toEqual([...ids].sort());
    expect(changes.map((c) => [c.op, c.meta])).toEqual(ids.map(() => ["move", { from: OHBOX, to: GATE }]));
    const seqs = changes.map((c) => Number(c.seq));
    expect(seqs).toEqual(seqs.map((_, i) => seqs[0]! + i));
    const audits = await w.db.select({ payload: auditLog.payload, inverse: auditLog.inverse })
      .from(auditLog).where(eq(auditLog.accountId, w.accountId));
    expect(audits).toEqual(expect.arrayContaining([
      ["b@x.test", 3], ["a@x.test", 1], ["c@x.test", 1],
    ].map(([address, count]) => ({
      payload: { address, count, from: OHBOX, to: GATE, via: "offer" }, inverse: { address, from: GATE, to: OHBOX },
    }))));
    expect(audits).toHaveLength(3);
  });

  it("a rule's body term is read, so the wide column round-trips on either store", async () => {
    const w = await world();
    await w.db.insert(rules).values({
      accountId: w.accountId, kind: "header", match: "list-id", destination: "ohmail/News",
      provenance: "manual", enabled: true, priority: 0, retroRequestedAt: null,
      bodyContains: "invoice",
    });
    await seed(w, "list@x.test", "your invoice is ready");
    await seed(w, "list@x.test", "hello there");
    // No header on either row, so the rule fires on neither and both senders stay undecided —
    // what this arm measures is the JOIN and the cast, which the walk now takes for both columns.
    expect((await unscreenedSummary(w.db as never, w.accountId, NOW)).total).toBe(2);
  });

  /* AN UNRELATED REPLY IN A THREAD NEVER ADMITS A STRANGER. Thread membership was the question
     here while the three worker passes asked `weAnsweredThisSenderWhere`, so a reply of ours to
     somebody else on the thread kept a newcomer in the Ohbox for ever. The control is the reply
     that IS to them, by recipient and by naming their message. */
  it("our reply to somebody else on the thread does not keep a stranger out of the offer", async () => {
    const w = await world();
    const own = (await w.db.select({ a: mailboxes.address }).from(mailboxes)
      .where(eq(mailboxes.id, w.mailboxId)))[0]!.a;
    const threadId = await threadOf(w);
    await seed(w, "colleague@x.test", "", { threadId });
    await seed(w, own, "", { threadId, to: ["colleague@x.test"] });
    await seed(w, "newcomer@x.test", "", { threadId });
    const offered = (await unscreenedSummary(w.db as never, w.accountId, NOW)).groups.map((g) => g.address);
    expect(offered).toContain("newcomer@x.test");
  });

  it("CONTROL — our reply TO them, or naming their message, keeps them out", async () => {
    const w = await world();
    const own = (await w.db.select({ a: mailboxes.address }).from(mailboxes)
      .where(eq(mailboxes.id, w.mailboxId)))[0]!.a;
    const t1 = await threadOf(w);
    await seed(w, "addressed@x.test", "", { threadId: t1 });
    await seed(w, own, "", { threadId: t1, to: ["addressed@x.test"] });
    const t2 = await threadOf(w);
    const theirs = await seed(w, "named@x.test", "", { threadId: t2 });
    const [row] = await w.db.select({ h: messages.messageIdHeader }).from(messages).where(eq(messages.id, theirs));
    await seed(w, own, "", { threadId: t2, to: ["list@x.test"], headers: { "in-reply-to": [`<${row!.h}>`] } });
    await seed(w, "stranger@x.test");
    const offered = (await unscreenedSummary(w.db as never, w.accountId, NOW)).groups.map((g) => g.address);
    expect(offered).toEqual(["stranger@x.test"]);
  });

  /* A PADDED RULE IS A DECISION HERE AS IN THE QUEUE: the queue's SQL trims `rules.match`, and the
     gate this screen asks now does too (`ruleMatchKey`). The unpadded control is the first case. */
  it("a rule stored with surrounding spaces decides its sender, on either store", async () => {
    const w = await world();
    await w.db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: "  padded@x.test ", destination: "INBOX",
      provenance: "manual", enabled: true, priority: 0, retroRequestedAt: null,
    });
    await seed(w, "padded@x.test");
    await seed(w, "stranger@x.test");
    const offered = (await unscreenedSummary(w.db as never, w.accountId, NOW)).groups.map((g) => g.address);
    expect(offered).toEqual(["stranger@x.test"]);
  });

  it("a reader install offers nothing, from the Ohbox or a pile, on either store", async () => {
    const w = await world();
    await w.db.update(mailboxes).set({ organizerRole: "reader" })
      .where(eq(mailboxes.id, w.mailboxId));
    await seed(w, "stranger@x.test");
    await seedIn(w, "stranger@x.test", NEWS);
    expect(await unscreenedSummary(w.db as never, w.accountId, NOW)).toEqual({ groups: [], total: 0, complete: true });
    expect(await unscreenedSummary(w.db as never, w.accountId, NOW, "news")).toEqual({ groups: [], total: 0, complete: true });
  });
});

/* ── THE NOTE ON NEWS AND RECEIPTS ───────────────────────────────────────────────────────────────
 * Owner report 2026-11-02: letters in News from senders the person never chose. The same gate,
 * asked of a pile with no window: a letter there from a sender with no contact and no rule is
 * offered at any age, and the press holds the sender at the gate. Nothing moves without it. */
const NEWS = "ohmail/News";
const LEGACY_NEWS = "ohmail/Reads";
const RECEIPTS = "ohmail/Receipts";
/** The headers a mailing service writes, cold outreach's too. */
const BULK = { "list-unsubscribe": ["<https://x.test/u>"], "list-unsubscribe-post": ["List-Unsubscribe=One-Click"] };

/** A letter a pass, an old release or the person placed in `folder`; years old unless stated. */
async function seedIn(
  w: Awaited<ReturnType<typeof world>>, from: string, folder: string,
  o: { arrivedAt?: Date | null; decidedAt?: Date } = {},
): Promise<string> {
  const i = n++;
  const arrivedAt = o.arrivedAt === undefined ? OLD : o.arrivedAt;
  const [m] = await w.db.insert(messages).values({
    accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: `p${i}`,
    dedupKey: `oud:${randomUUID()}`, subject: `Letter ${i}`, fromAddress: from,
    date: arrivedAt ?? OLD, createdAt: arrivedAt ?? OLD, arrivedAt, unread: true,
    nativeLocator: { folder, ref: `2:${i}` },
  }).returning();
  await w.db.insert(messageBodies).values({ messageId: m!.id, text: "", html: null, headers: BULK });
  await w.db.insert(folderState).values({
    messageId: m!.id, desiredFolder: folder, observedFolder: folder,
    lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    ...(o.decidedAt ? { decidedAt: o.decidedAt } : {}),
  });
  return m!.id;
}

const offered = async (w: Awaited<ReturnType<typeof world>>, pile?: "news" | "receipts") =>
  (await unscreenedSummary(w.db as never, w.accountId, NOW, pile)).groups.map((g) => g.address);

describe("the note on News and Receipts asks who nobody let in, on both stores", () => {
  it("offers a pile's letters from senders nobody let in at any age, News in both spellings", async () => {
    const w = await world();
    await seedIn(w, "bulk@x.test", NEWS);
    await seedIn(w, "bulk@x.test", NEWS, { arrivedAt: null });
    await seedIn(w, "legacy@x.test", LEGACY_NEWS);
    await seedIn(w, "shop@x.test", RECEIPTS, { arrivedAt: ARRIVED });
    await seed(w, "door@x.test");

    expect(await unscreenedSummary(w.db as never, w.accountId, NOW, "news")).toEqual({
      groups: [
        { address: "bulk@x.test", count: 2, newestAt: OLD.toISOString() },
        { address: "legacy@x.test", count: 1, newestAt: OLD.toISOString() },
      ],
      total: 3, complete: true,
    });
    expect(await offered(w, "receipts")).toEqual(["shop@x.test"]);
    expect(await offered(w), "the Ohbox's offer took a pile's letters").toEqual(["door@x.test"]);
  });

  it("CONTROL — a contact's letters, a ruled sender's, a placed letter and the account's own are not offered", async () => {
    const w = await world();
    const own = (await w.db.select({ a: mailboxes.address }).from(mailboxes)
      .where(eq(mailboxes.id, w.mailboxId)))[0]!.a;
    await w.db.insert(contacts).values([
      { accountId: w.accountId, address: "pal@x.test", source: "person" },
      { accountId: w.accountId, address: "written@x.test", source: "inferred" },
    ]);
    await w.db.insert(rules).values([
      { accountId: w.accountId, kind: "sender", match: "ruled@x.test", destination: NEWS, provenance: "manual", enabled: true, priority: 0, retroRequestedAt: null },
      { accountId: w.accountId, kind: "domain", match: "brand.test", destination: NEWS, provenance: "manual", enabled: true, priority: 0, retroRequestedAt: null },
    ]);
    for (const from of ["pal@x.test", "written@x.test", "ruled@x.test", "deals@brand.test", own]) await seedIn(w, from, NEWS);
    await seedIn(w, "filed@x.test", NEWS, { decidedAt: OLD });
    await seedIn(w, "stranger@x.test", NEWS);
    expect(await offered(w, "news")).toEqual(["stranger@x.test"]);
  });

  it("the press holds the pile's strangers: intents out of the pile, one audit per sender, and a second press finds nothing", async () => {
    const w = await world();
    const a = await seedIn(w, "bulk@x.test", NEWS);
    const b = await seedIn(w, "bulk@x.test", LEGACY_NEWS);
    const receipt = await seedIn(w, "shop@x.test", RECEIPTS);
    const door = await seed(w, "door@x.test");

    expect(await screenUnscreened(ctxOf(w), { pile: "news" })).toEqual({
      screened: [{ address: "bulk@x.test", count: 2, newestAt: OLD.toISOString() }], total: 2,
    });
    expect([await desiredOf(w, a), await desiredOf(w, b)]).toEqual([GATE, GATE]);
    expect(await desiredOf(w, receipt), "a News press moved a receipt").toBe(RECEIPTS);
    expect(await desiredOf(w, door), "a News press moved the Ohbox").toBe(OHBOX);
    const changes = await w.db.select({ id: changeLog.entityId, op: changeLog.op, meta: changeLog.meta })
      .from(changeLog).where(eq(changeLog.accountId, w.accountId)).orderBy(asc(changeLog.seq));
    expect(changes).toEqual([a, b].sort().map((id) => ({ id, op: "move", meta: { from: NEWS, to: GATE } })));
    const audits = await w.db.select({ payload: auditLog.payload, inverse: auditLog.inverse })
      .from(auditLog).where(eq(auditLog.accountId, w.accountId));
    expect(audits).toEqual([{
      payload: { address: "bulk@x.test", count: 2, from: NEWS, to: GATE, via: "pile" },
      inverse: { address: "bulk@x.test", from: GATE, to: NEWS },
    }]);

    expect(await offered(w, "news")).toEqual([]);
    expect(await screenUnscreened(ctxOf(w), { pile: "news" })).toEqual({ screened: [], total: 0 });
    expect(await screenUnscreened(ctxOf(w), { pile: "receipts" })).toMatchObject({ total: 1 });
    expect(await desiredOf(w, receipt)).toBe(GATE);
  });

  /* A TAKEOVER'S OPEN IMPORT QUESTION keeps the News letters the travelling document lets in where
     they arrived ('external', nothing decided): the person let that sender in on the previous
     organizer, so the note neither counts nor presses them. The control is a letter ohmail placed. */
  it("a letter an open import question kept in News for the travelling document is neither offered nor pressed", async () => {
    const w = await world();
    const repo = makeDrizzleRepo(w.db);
    const chosen = "weekly@chosen.test";
    const doc = makeProfileDoc(
      { screener: [{ address: chosen }], rules: [], notifyRules: [], awayResponder: null, tagNames: [], signature: null },
      { updatedAt: OLD, producer: { kind: "local", version: "0.30.28" } },
    );
    const raw = Buffer.from([
      "Message-ID: <w1@chosen.test>", `From: ${chosen}`, "To: me@x.test", "Subject: This week",
      "List-Unsubscribe: <https://chosen.test/u>", "Content-Type: text/plain; charset=utf-8", "", "The week.",
    ].join("\r\n"));
    const change: Change = { type: "create", locator: { folder: NEWS, ref: "5:1" }, raw, seen: false, internalDate: ARRIVED };
    const plan = await planChange(change, {
      repo, accountId: w.accountId, mailboxId: w.mailboxId, routing: repo, readerMode: false,
      importHold: { kind: "document", ...profileGateView(doc) },
    });
    const { messageId: kept } = await repo.transaction((tx) => commitChange(plan, {
      repo: tx, routing: tx, accountId: w.accountId, mailboxId: w.mailboxId, storageCap: UNMETERED_STORAGE_CAP,
    }));
    const [row] = await w.db.select({ d: folderState.desiredFolder, by: folderState.lastSetBy, at: folderState.decidedAt })
      .from(folderState).where(eq(folderState.messageId, kept));
    expect(row, "the hold did not keep the letter where it arrived").toEqual({ d: NEWS, by: "external", at: null });
    const placed = await seedIn(w, "bulk@x.test", NEWS);

    expect(await offered(w, "news"), "the note named a sender the travelling document lets in").toEqual(["bulk@x.test"]);
    expect(await screenUnscreened(ctxOf(w), { pile: "news" })).toMatchObject({ total: 1 });
    expect([await desiredOf(w, kept), await desiredOf(w, placed)]).toEqual([NEWS, GATE]);
  });

  it("a pile that is neither News nor Receipts is refused, and nothing moves", async () => {
    const w = await world();
    const id = await seedIn(w, "bulk@x.test", NEWS);
    for (const pile of ["spam", "News", 1]) {
      await expect(screenUnscreened(ctxOf(w), { pile }), String(pile)).rejects.toMatchObject({ httpStatus: 400 });
    }
    expect(await desiredOf(w, id)).toBe(NEWS);
  });
});
