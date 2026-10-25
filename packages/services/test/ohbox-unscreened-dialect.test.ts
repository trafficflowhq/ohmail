import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import {
  accounts, auditLog, changeLog, contacts, folderState, mailboxes, messageBodies, messages, rules, threads,
} from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  screenUnscreened, unscreenedSummary, type ServiceContext,
} from "../src/mail.js";

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
  });

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

  it("a reader install offers nothing on either store", async () => {
    const w = await world();
    await w.db.update(mailboxes).set({ organizerRole: "reader" })
      .where(eq(mailboxes.id, w.mailboxId));
    await seed(w, "stranger@x.test");
    expect(await unscreenedSummary(w.db as never, w.accountId, NOW)).toEqual({ groups: [], total: 0 });
  });
});
