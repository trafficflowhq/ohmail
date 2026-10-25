import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { brandDialect } from "@trafficflow/db/dialect";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  accounts, approvals, auditLog, contacts, drafts, folderState, mailboxes, messageBodies,
  messageStates, messages, rules, threads,
} from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import {
  screenUnscreened, unscreenedSummary, OHBOX_UNSCREENED_AUDIT_ACTION,
  type ServiceContext,
} from "@trafficflow/services/mail";

/**
 * ═══ THE OHBOX'S UNDECIDED SENDERS — THE COUNT, THE PRESS, AND THEIR PARITY ═══════════════
 *
 * Mail that arrived before the screening gate existed sits in the Ohbox from senders nobody ever
 * decided about. The offer is a press, and what it must be worth is one sentence: THE NUMBER
 * SHOWN IS THE NUMBER MOVED, and membership is the ARRIVAL GATE'S OWN answer rather than a second
 * predicate written beside it.
 *
 * `.pg.test.ts` and not PGlite: the press takes its page `FOR UPDATE OF folder_state` (a no-op
 * that always succeeds under a single-connection engine) and the candidate query is four
 * `NOT EXISTS` arms plus a correlated `exists` over `mailboxes` whose counts are the only thing
 * separating a correct predicate from an accidentally always-true one. Every arm is counted here.
 *
 * INSERT-only under a fresh `account_id`, so nothing here is visible to another test sharing the
 * database.
 */

const PG_UP = await realPgAvailable();
const OHBOX = "INBOX";
const GATE = "ohmail/Screener";
const NOW = new Date("2026-09-22T09:00:00.000Z");
// Inside the default window; OLD is outside it, the control the counts below carry.
const ARRIVED = new Date("2026-09-17T08:00:00.000Z");
const OLD = new Date("2024-03-01T08:00:00.000Z");

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

interface World { accountId: string; mailboxId: string; address: string }

const ctxOf = (w: World): ServiceContext => ({
  db: db as unknown as ServiceContext["db"], accountId: w.accountId, userId: null,
  now: () => NOW, requestId: `ous-${randomUUID().slice(0, 8)}`,
});

async function newWorld(role: "organizer" | "reader" = "organizer"): Promise<World> {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `ous-${accountId.slice(0, 8)}` });
  const address = `ous-${accountId.slice(0, 8)}@example.test`;
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address, organizerRole: role,
  }).returning();
  return { accountId, mailboxId: mb!.id, address };
}

let seq = 0;

/** One message where the blanket default put it — in the Ohbox, read, days ago. */
async function seedOhbox(w: World, o: {
  from: string; subject?: string; body?: string; headers?: Record<string, string[]>;
  folder?: string; unread?: boolean; lastSetBy?: string; threadId?: string; to?: string[]; arrivedAt?: Date;
}): Promise<string> {
  const i = seq++;
  const folder = o.folder ?? OHBOX;
  const [m] = await db.insert(messages).values({
    accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: `h${i}`,
    dedupKey: `ous:${randomUUID()}`, subject: o.subject ?? `Note ${i}`, fromAddress: o.from,
    date: o.arrivedAt ?? ARRIVED, createdAt: ARRIVED, arrivedAt: o.arrivedAt ?? ARRIVED, unread: o.unread ?? false,
    ...(o.threadId ? { threadId: o.threadId } : {}),
    ...(o.to ? { toAddresses: o.to.map((address) => ({ name: null, address })) } : {}),
    nativeLocator: { folder, ref: `1:${i}` },
  }).returning();
  await db.insert(messageBodies).values({
    messageId: m!.id, text: o.body ?? "", html: null, headers: o.headers ?? {},
  });
  await db.insert(folderState).values({
    messageId: m!.id, desiredFolder: folder, observedFolder: folder,
    lastSetBy: o.lastSetBy ?? "external", reconcileStatus: "reconciled", conflict: false,
  });
  return m!.id;
}

const desiredOf = async (id: string): Promise<{ desired: string; status: string }> => {
  const [row] = await db.select({
    desired: folderState.desiredFolder, status: folderState.reconcileStatus,
  }).from(folderState).where(eq(folderState.messageId, id));
  return row!;
};

const addressesOf = (groups: readonly { address: string }[]): string[] =>
  groups.map((g) => g.address).sort();

describe.skipIf(!PG_UP)("the Ohbox's undecided senders", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(client, { schema }), "pg");
  }, 120_000);
  afterAll(async () => { await client?.end({ timeout: 5 }); });

  it("a stranger's read Ohbox mail is offered, and the press sends it to the Screener", async () => {
    const w = await newWorld();
    const id = await seedOhbox(w, { from: "stranger@x.test" });
    const old = await seedOhbox(w, { from: "stranger@x.test", arrivedAt: OLD });

    const before = await unscreenedSummary(db as never, w.accountId, NOW);
    expect(addressesOf(before.groups)).toEqual(["stranger@x.test"]);
    expect(before.total).toBe(1);
    expect(before.groups[0]!.count).toBe(1);
    expect(before.groups[0]!.newestAt).toBe(ARRIVED.toISOString());

    const pressed = await screenUnscreened(ctxOf(w));
    expect(pressed.total).toBe(1);
    expect(addressesOf(pressed.screened)).toEqual(["stranger@x.test"]);

    // THE INTENT, not a move: desired is the gate, observed is untouched, so `reconcile_status`
    // derives `pending` and the organizer's reconciler is what carries it to IMAP.
    expect(await desiredOf(id)).toEqual({ desired: GATE, status: "pending" });
    // Older than the window: neither counted nor moved.
    expect(await desiredOf(old)).toEqual({ desired: OHBOX, status: "reconciled" });
  });

  it("the offer is idempotent by the predicate — a second press finds nothing", async () => {
    const w = await newWorld();
    await seedOhbox(w, { from: "stranger@x.test" });
    expect((await screenUnscreened(ctxOf(w))).total).toBe(1);

    expect((await unscreenedSummary(db as never, w.accountId, NOW)).total).toBe(0);
    const again = await screenUnscreened(ctxOf(w));
    expect(again).toEqual({ screened: [], total: 0 });
  });

  it("a sender the person decided about is never in a group — rule, contact, own address", async () => {
    const w = await newWorld();
    await db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: "ruled@x.test", destination: "INBOX",
      provenance: "manual", enabled: true, priority: 0, retroRequestedAt: null,
    });
    await db.insert(rules).values({
      accountId: w.accountId, kind: "domain", match: "corp.test", destination: "ohmail/News",
      provenance: "manual", enabled: true, priority: 0, retroRequestedAt: null,
    });
    await db.insert(contacts).values({ accountId: w.accountId, address: "pal@x.test" });

    const ruled = await seedOhbox(w, { from: "ruled@x.test" });
    const domained = await seedOhbox(w, { from: "someone@corp.test" });
    const contact = await seedOhbox(w, { from: "pal@x.test" });
    const mine = await seedOhbox(w, { from: w.address });
    await seedOhbox(w, { from: "stranger@x.test" });

    const summary = await unscreenedSummary(db as never, w.accountId, NOW);
    expect(addressesOf(summary.groups)).toEqual(["stranger@x.test"]);

    await screenUnscreened(ctxOf(w));
    for (const id of [ruled, domained, contact, mine]) {
      expect((await desiredOf(id)).desired).toBe(OHBOX);
    }
  });

  it("a DISABLED rule has decided nothing — its sender is offered", async () => {
    const w = await newWorld();
    await db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: "lapsed@x.test", destination: "INBOX",
      provenance: "manual", enabled: false, priority: 0, retroRequestedAt: null,
    });
    await seedOhbox(w, { from: "lapsed@x.test" });
    expect(addressesOf((await unscreenedSummary(db as never, w.accountId, NOW)).groups))
      .toEqual(["lapsed@x.test"]);
  });

  it("a reader install offers nothing — it arranges nobody's mailbox", async () => {
    const w = await newWorld("reader");
    await seedOhbox(w, { from: "stranger@x.test" });
    expect(await unscreenedSummary(db as never, w.accountId, NOW)).toEqual({ groups: [], total: 0 });
    expect(await screenUnscreened(ctxOf(w))).toEqual({ screened: [], total: 0 });
  });

  it("mail the person already dealt with is not ours to offer", async () => {
    const w = await newWorld();
    const triaged = await seedOhbox(w, { from: "a@x.test" });
    await db.insert(messageStates).values({
      accountId: w.accountId, messageId: triaged, state: "set_aside",
    });
    const replied = await seedOhbox(w, { from: "b@x.test" });
    await db.insert(drafts).values({
      accountId: w.accountId, mailboxId: w.mailboxId, inReplyToMessageId: replied,
      subject: "re", body: "",
    });
    const decided = await seedOhbox(w, { from: "c@x.test" });
    await db.insert(approvals).values({
      accountId: w.accountId, kind: "routing", messageId: decided, action: "move",
      status: "approved",
    });
    const filed = await seedOhbox(w, { from: "d@x.test", folder: "ohmail/News" });
    await seedOhbox(w, { from: "e@x.test" });

    const summary = await unscreenedSummary(db as never, w.accountId, NOW);
    expect(addressesOf(summary.groups)).toEqual(["e@x.test"]);

    await screenUnscreened(ctxOf(w));
    for (const id of [triaged, replied, decided]) {
      expect((await desiredOf(id)).desired).toBe(OHBOX);
    }
    expect((await desiredOf(filed)).desired).toBe("ohmail/News");
  });

  it("a PENDING approval is our proposal, not their decision — the mail is still offered", async () => {
    const w = await newWorld();
    const id = await seedOhbox(w, { from: "pending@x.test" });
    await db.insert(approvals).values({
      accountId: w.accountId, kind: "routing", messageId: id, action: "move", status: "pending",
    });
    expect(addressesOf((await unscreenedSummary(db as never, w.accountId, NOW)).groups))
      .toEqual(["pending@x.test"]);
  });

  it("a NARROWED rule still decided about the sender — terms narrow placement, not admission", async () => {
    /* The gate's own ruling (`rules.ts#standingRule`, mail 0050/0052): a subject- or body-narrowed
       rule is a decision about the WHOLE person, so neither of that sender's messages is offered —
       including the one the term does not claim. Asserted here because a screen that re-derived
       "decided" for itself would offer exactly that message and move somebody's ruled-on mail. */
    const w = await newWorld();
    await db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: "mixed@x.test", destination: "ohmail/News",
      provenance: "manual", enabled: true, priority: 0, retroRequestedAt: null,
      subjectContains: "receipt",
    });
    const claimed = await seedOhbox(w, { from: "mixed@x.test", subject: "your receipt" });
    const other = await seedOhbox(w, { from: "mixed@x.test", subject: "hello there" });

    expect(await unscreenedSummary(db as never, w.accountId, NOW)).toEqual({ groups: [], total: 0 });
    await screenUnscreened(ctxOf(w));
    for (const id of [claimed, other]) expect((await desiredOf(id)).desired).toBe(OHBOX);
  });

  it("a HEADER rule reads its header, so the mail it claims is not offered", async () => {
    const w = await newWorld();
    await db.insert(rules).values({
      accountId: w.accountId, kind: "header", match: "list-id", destination: "ohmail/News",
      provenance: "manual", enabled: true, priority: 0, retroRequestedAt: null,
    });
    // A header rule names a HEADER and nobody's address, so it never decides a sender — it is the
    // one arm of the gate that can precede a `screener` answer and that reads `message_bodies`.
    const claimed = await seedOhbox(w, { from: "list@x.test", headers: { "list-id": ["<a.x.test>"] } });
    const bare = await seedOhbox(w, { from: "list@x.test" });

    const summary = await unscreenedSummary(db as never, w.accountId, NOW);
    expect(summary.total).toBe(1);

    await screenUnscreened(ctxOf(w));
    expect((await desiredOf(claimed)).desired).toBe(OHBOX);
    expect((await desiredOf(bare)).desired).toBe(GATE);
  });

  it("a rule's BODY term is read too — the message it claims stays, the rest is offered", async () => {
    const w = await newWorld();
    await db.insert(rules).values({
      accountId: w.accountId, kind: "header", match: "list-id", destination: "ohmail/News",
      provenance: "manual", enabled: true, priority: 0, retroRequestedAt: null,
      bodyContains: "invoice",
    });
    const hdr = { "list-id": ["<a.x.test>"] };
    const claimed = await seedOhbox(w, { from: "list@x.test", headers: hdr, body: "your invoice is ready" });
    const unclaimed = await seedOhbox(w, { from: "list@x.test", headers: hdr, body: "hello there" });

    const summary = await unscreenedSummary(db as never, w.accountId, NOW);
    // The term narrows the rule to ONE message; the rest of that header's mail is undecided.
    expect(summary.total).toBe(1);
    expect(summary.groups[0]).toMatchObject({ address: "list@x.test", count: 1 });

    await screenUnscreened(ctxOf(w));
    expect((await desiredOf(claimed)).desired).toBe(OHBOX);
    expect((await desiredOf(unclaimed)).desired).toBe(GATE);
  });

  it("with no header and no body rule the stored header and body decide nothing", async () => {
    // The other arm of both conditions: the reads are a cost decision, not a membership one.
    const w = await newWorld();
    await seedOhbox(w, { from: "list@x.test", headers: { "list-id": ["<a.x.test>"] }, body: "your invoice is ready" });
    await seedOhbox(w, { from: "list@x.test", body: "hello there" });
    const summary = await unscreenedSummary(db as never, w.accountId, NOW);
    expect(summary.groups).toEqual([
      { address: "list@x.test", count: 2, newestAt: ARRIVED.toISOString() },
    ]);
  });

  it("THE PARITY: the count shown is the count moved, group by group", async () => {
    const w = await newWorld();
    for (let i = 0; i < 3; i++) await seedOhbox(w, { from: "many@x.test" });
    for (let i = 0; i < 2; i++) await seedOhbox(w, { from: "few@x.test" });
    await db.insert(contacts).values({ accountId: w.accountId, address: "pal@x.test" });
    await seedOhbox(w, { from: "pal@x.test" });

    const shown = await unscreenedSummary(db as never, w.accountId, NOW);
    expect(shown.groups).toEqual([
      { address: "many@x.test", count: 3, newestAt: ARRIVED.toISOString() },
      { address: "few@x.test", count: 2, newestAt: ARRIVED.toISOString() },
    ]);
    expect(shown.total).toBe(5);

    const pressed = await screenUnscreened(ctxOf(w));
    expect(pressed.screened).toEqual(shown.groups);
    expect(pressed.total).toBe(shown.total);

    // AND THE DATABASE AGREES WITH BOTH — the set the screen counted is the set that moved.
    const moved = await db.select({ id: folderState.messageId })
      .from(folderState)
      .innerJoin(messages, eq(messages.id, folderState.messageId))
      .where(and(eq(messages.accountId, w.accountId), eq(folderState.desiredFolder, GATE)));
    expect(moved).toHaveLength(shown.total);
  });

  it("a press names its groups, and moves only those", async () => {
    const w = await newWorld();
    const a = await seedOhbox(w, { from: "a@x.test" });
    const b = await seedOhbox(w, { from: "b@x.test" });

    const pressed = await screenUnscreened(ctxOf(w), { addresses: ["A@X.test"] });
    expect(pressed.total).toBe(1);
    expect(addressesOf(pressed.screened)).toEqual(["a@x.test"]);
    expect((await desiredOf(a)).desired).toBe(GATE);
    expect((await desiredOf(b)).desired).toBe(OHBOX);
  });

  it("the audit row names the group and the count the press measured", async () => {
    const w = await newWorld();
    for (let i = 0; i < 4; i++) await seedOhbox(w, { from: "loud@x.test" });
    await screenUnscreened(ctxOf(w));

    const rows = await db.select({ action: auditLog.action, payload: auditLog.payload, inverse: auditLog.inverse })
      .from(auditLog).where(eq(auditLog.accountId, w.accountId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe(OHBOX_UNSCREENED_AUDIT_ACTION);
    expect(rows[0]!.payload).toEqual({
      address: "loud@x.test", count: 4, from: OHBOX, to: GATE, via: "offer",
    });
    expect(rows[0]!.inverse).toEqual({ address: "loud@x.test", from: GATE, to: OHBOX });
  });

  it("a press refuses a caller's list that is not sender addresses", async () => {
    const w = await newWorld();
    await expect(screenUnscreened(ctxOf(w), { addresses: "all" as never }))
      .rejects.toThrow(/array/);
    await expect(screenUnscreened(ctxOf(w), { addresses: [""] }))
      .rejects.toThrow(/sender addresses/);
    await expect(screenUnscreened(ctxOf(w), { addresses: Array.from({ length: 201 }, () => "a@x.test") }))
      .rejects.toThrow(/too many/);
  });

  /* AN UNRELATED REPLY IN A THREAD NEVER ADMITS A STRANGER — `weAnsweredThisSenderWhere`, the
     worker passes' predicate, on real Postgres. B then A: account B's reply goes to somebody else,
     account A's to the newcomer, and each answer is its own account's. */
  it("our reply to somebody else on the thread leaves a newcomer offered — B then A", async () => {
    const threadIn = async (w: World): Promise<string> =>
      (await db.insert(threads).values({ accountId: w.accountId, subject: "Plans" }).returning())[0]!.id;
    const b = await newWorld();
    const tb = await threadIn(b);
    await seedOhbox(b, { from: "colleague@x.test", threadId: tb });
    await seedOhbox(b, { from: b.address, threadId: tb, to: ["colleague@x.test"] });
    await seedOhbox(b, { from: "newcomer@x.test", threadId: tb });
    const a = await newWorld();
    const ta = await threadIn(a);
    await seedOhbox(a, { from: "newcomer@x.test", threadId: ta });
    await seedOhbox(a, { from: a.address, threadId: ta, to: ["newcomer@x.test"] });

    expect(addressesOf((await unscreenedSummary(db as never, b.accountId, NOW)).groups))
      .toEqual(["newcomer@x.test"]);
    expect(addressesOf((await unscreenedSummary(db as never, a.accountId, NOW)).groups)).toEqual([]);
  });

  it("another account's Ohbox is not in this account's answer", async () => {
    const mine = await newWorld();
    const theirs = await newWorld();
    await seedOhbox(mine, { from: "stranger@x.test" });
    const hers = await seedOhbox(theirs, { from: "stranger@x.test" });

    expect((await unscreenedSummary(db as never, mine.accountId, NOW)).total).toBe(1);
    await screenUnscreened(ctxOf(mine));
    expect((await desiredOf(hers)).desired).toBe(OHBOX);
  });

  it("the moved mail is on the delta log as a move the client mirror converges on", async () => {
    const w = await newWorld();
    const id = await seedOhbox(w, { from: "stranger@x.test" });
    await screenUnscreened(ctxOf(w));
    const [row] = await client`
      select op, meta from change_log
       where account_id = ${w.accountId} and entity_id = ${id}`;
    expect(row).toMatchObject({ op: "move", meta: { from: OHBOX, to: GATE } });
  });
});
