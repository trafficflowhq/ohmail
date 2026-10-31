import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { asc, eq } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { accounts, changeLog, drafts, mailboxes, messages, threadNotes, threads, type Tx } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { MAX_THREAD_PARTICIPANTS } from "@trafficflow/core/mail";
import { threadJoinHealPass, type ThreadJoinHealResult } from "../src/thread-join-heal.js";
import { makeThreadJoinHealWalk } from "../src/thread-join-heal-walk.js";

/**
 * THE THREAD-JOIN HEAL, AGAINST REAL POSTGRES.
 *
 * Real Postgres rather than PGlite because the merge is a transaction whose whole point is its
 * shape: message moves, the surviving thread's update, the absorbed thread's DELETE (an FK
 * target — the moves must precede it or the delete is refused) and the change-log appends
 * commit together or not at all, under the seq allocation's account row lock. PGlite green says
 * nothing about any of that.
 *
 * The first fixture is the SHAPE PRODUCTION HAD on 2026-08-26, addresses anonymized: the
 * user's outbound message threaded alone, because the correspondent's reply landed at the
 * user's old provider and re-entered as a FORWARD — a fresh Message-ID, no References — onto
 * which the user's next reply and the correspondent's "AW:" reply then chained correctly.
 * Four messages, one human conversation, two header chains, two threads.
 */

const AVAILABLE = await realPgAvailable();

const t0 = Date.UTC(2026, 7, 24, 14, 42, 49);
const DAY = 24 * 60 * 60 * 1000;
const OWNER = "owner@own.example";
const COUNTERPART = "counterpart@partner.example";

describe.skipIf(!AVAILABLE)("thread-join heal", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    sql = postgres(PG_TEST_URL, { max: 2, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg");
  }, 120_000);

  interface Seeded { accountId: string; mailboxId: string }

  async function seedAccount(): Promise<Seeded> {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `join-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: OWNER,
    }).returning({ id: mailboxes.id });
    return { accountId, mailboxId: mb!.id };
  }

  async function seedThread(s: Seeded, subject: string, lastMessageAt: Date): Promise<string> {
    const [t] = await db.insert(threads).values({
      accountId: s.accountId, subject, lastMessageAt,
      rootMessageIdHeader: `${randomUUID()}@seed.example`,
      participants: [],
    }).returning({ id: threads.id });
    return t!.id;
  }

  /**
   * The account's own outbound mail sits in the mailbox's SENT folder, and `native_locator` is
   * where the pass reads that: it decides whether a message's `To`/`Cc` is OUR record of who we
   * wrote to or a sender's claim about who else is involved. Seeding every row under INBOX would
   * make the account's own messages read as inbound and starve every join in this file.
   */
  function locatorFor(from: string): { folder: string; ref: string } {
    return {
      folder: from === OWNER ? "Sent" : "INBOX",
      ref: `1:${Math.floor(Math.random() * 1e6)}`,
    };
  }

  async function seedMessage(s: Seeded, threadId: string, over: {
    subject: string; date: Date; from: string; to?: string[]; cc?: string[];
    /** `messages.auth_verdict` as the ingest wrote it. Absent ⇒ NULL, "nobody asked". */
    authVerdict?: string;
  }): Promise<string> {
    const [m] = await db.insert(messages).values({
      accountId: s.accountId, mailboxId: s.mailboxId, threadId,
      messageIdHeader: `${randomUUID()}@seed.example`,
      bodyHash: randomUUID(), dedupKey: randomUUID(),
      subject: over.subject, fromAddress: over.from, date: over.date,
      nativeLocator: locatorFor(over.from),
      toAddresses: (over.to ?? []).map((address) => ({ name: null, address })),
      ccAddresses: (over.cc ?? []).map((address) => ({ name: null, address })),
      ...(over.authVerdict ? { authVerdict: over.authVerdict } : {}),
    }).returning({ id: messages.id });
    return m!.id;
  }

  /** The production shape. `reverseSeedOrder` seeds the forward chain FIRST — arrival order
   * must not decide the survivor, the messages' own dates must. */
  async function seedProductionSplit(reverseSeedOrder = false) {
    const s = await seedAccount();
    const seedOriginal = async () => {
      const thread = await seedThread(s, "Web Banner - vendor - Partner", new Date(t0));
      const message = await seedMessage(s, thread, {
        subject: "Web Banner - vendor - Partner", date: new Date(t0),
        from: OWNER, to: [COUNTERPART], cc: ["colleague@own.example"],
      });
      return { thread, message };
    };
    const seedForwardChain = async () => {
      const thread = await seedThread(s, "Web Banner - vendor - Partner", new Date(t0 + 1.93 * DAY));
      const fwd = await seedMessage(s, thread, {
        subject: "Fwd: AW: Web Banner - vendor - Partner", date: new Date(t0 + 1.76 * DAY),
        from: OWNER, to: [OWNER],
      });
      const reply = await seedMessage(s, thread, {
        subject: "Re: Fwd: AW: Web Banner - vendor - Partner", date: new Date(t0 + 1.78 * DAY),
        from: OWNER, to: [COUNTERPART],
      });
      const aw = await seedMessage(s, thread, {
        subject: "AW: Fwd: AW: Web Banner - vendor - Partner", date: new Date(t0 + 1.93 * DAY),
        from: COUNTERPART, to: [OWNER], cc: ["info@own.example"],
      });
      return { thread, messages: [fwd, reply, aw] };
    };
    const [a, b] = reverseSeedOrder
      ? await (async () => { const fc = await seedForwardChain(); return [await seedOriginal(), fc] as const; })()
      : await (async () => { const o = await seedOriginal(); return [o, await seedForwardChain()] as const; })();
    return { s, original: a, forwardChain: b };
  }

  it("unites the four-message production shape onto the older thread, and tells the mirrors", async () => {
    const { s, original, forwardChain } = await seedProductionSplit();

    const r = await threadJoinHealPass({ db: db as unknown as Tx, apply: true, accountId: s.accountId });
    expect(r.merged).toBe(1);
    expect(r.messagesMoved).toBe(3);
    expect(r.skipped).toBe(0);

    // Every message now sits on the ORIGINAL thread — the conversation's true start survives.
    const rows = await db.select({ id: messages.id, threadId: messages.threadId }).from(messages)
      .where(eq(messages.accountId, s.accountId));
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row.threadId).toBe(original.thread);

    // The forward chain's thread is gone; the survivor learned the union of what both knew.
    const remaining = await db.select({
      id: threads.id, lastMessageAt: threads.lastMessageAt, participants: threads.participants,
    }).from(threads).where(eq(threads.accountId, s.accountId));
    expect(remaining.map((t) => t.id)).toEqual([original.thread]);
    expect(remaining[0]!.lastMessageAt).toEqual(new Date(t0 + 1.93 * DAY));

    // The change log carries the full merge: one update per moved message, the survivor's
    // update, the absorbed thread's delete — the exact rows `POST /threads/merge` would append.
    const changes = await db.select({
      entityType: changeLog.entityType, entityId: changeLog.entityId, op: changeLog.op,
    }).from(changeLog).where(eq(changeLog.accountId, s.accountId)).orderBy(asc(changeLog.seq));
    const key = (c: { entityType: string; entityId: string; op: string }) => `${c.entityType}:${c.op}:${c.entityId}`;
    expect(new Set(changes.map(key))).toEqual(new Set([
      ...forwardChain.messages.map((id) => `message:update:${id}`),
      `thread:update:${original.thread}`,
      `thread:delete:${forwardChain.thread}`,
    ]));

    // Idempotent: the merged group holds one thread and the second run selects nothing.
    const again = await threadJoinHealPass({ db: db as unknown as Tx, apply: true, accountId: s.accountId });
    expect(again.merged).toBe(0);
    expect(again.messagesMoved).toBe(0);
  });

  it("arrival order does not pick the survivor — seeded in reverse, the OLDER-BY-DATE thread still wins", async () => {
    const { s, original } = await seedProductionSplit(true);

    const r = await threadJoinHealPass({ db: db as unknown as Tx, apply: true, accountId: s.accountId });
    expect(r.merged).toBe(1);

    const remaining = await db.select({ id: threads.id }).from(threads)
      .where(eq(threads.accountId, s.accountId));
    expect(remaining.map((t) => t.id)).toEqual([original.thread]);
  });

  it("unrelated mail sharing a subject is NOT merged — different counterparties", async () => {
    const s = await seedAccount();
    const a = await seedThread(s, "Invoice", new Date(t0));
    await seedMessage(s, a, { subject: "Re: Invoice", date: new Date(t0), from: "billing@acme.example", to: [OWNER] });
    const b = await seedThread(s, "Invoice", new Date(t0 + DAY));
    await seedMessage(s, b, { subject: "Re: Invoice", date: new Date(t0 + DAY), from: "accounts@other.example", to: [OWNER] });

    const r = await threadJoinHealPass({ db: db as unknown as Tx, apply: true, accountId: s.accountId });
    expect(r.merged).toBe(0);

    const remaining = await db.select({ id: threads.id }).from(threads).where(eq(threads.accountId, s.accountId));
    expect(new Set(remaining.map((t) => t.id))).toEqual(new Set([a, b]));
  });

  it("a dry run takes the same verdicts and writes NOTHING", async () => {
    const { s, original, forwardChain } = await seedProductionSplit();

    const r = await threadJoinHealPass({ db: db as unknown as Tx, apply: false, accountId: s.accountId });
    expect(r.merged).toBe(1);        // the verdict
    expect(r.messagesMoved).toBe(0); // but no write

    const remaining = await db.select({ id: threads.id }).from(threads).where(eq(threads.accountId, s.accountId));
    expect(new Set(remaining.map((t) => t.id))).toEqual(new Set([original.thread, forwardChain.thread]));
    const changes = await db.select({ seq: changeLog.seq }).from(changeLog).where(eq(changeLog.accountId, s.accountId));
    expect(changes).toHaveLength(0);
  });

  it("a capped run hands back a cursor, and resuming skips the refusals already judged", async () => {
    const s = await seedAccount();
    // Group "Invoice": unrelated senders — every run refuses it, so it never leaves the
    // candidate set. Group "Zebra budget": a real split. Subjects chosen so the refusal
    // group sorts FIRST in the (account_id, subject) keyset order.
    const a1 = await seedThread(s, "Invoice", new Date(t0));
    await seedMessage(s, a1, { subject: "Re: Invoice", date: new Date(t0), from: "billing@acme.example", to: [OWNER] });
    const a2 = await seedThread(s, "Invoice", new Date(t0 + DAY));
    await seedMessage(s, a2, { subject: "Re: Invoice", date: new Date(t0 + DAY), from: "accounts@other.example", to: [OWNER] });

    const b1 = await seedThread(s, "Zebra budget", new Date(t0));
    await seedMessage(s, b1, { subject: "Zebra budget", date: new Date(t0), from: OWNER, to: [COUNTERPART] });
    const b2 = await seedThread(s, "Zebra budget", new Date(t0 + DAY));
    await seedMessage(s, b2, { subject: "AW: Zebra budget", date: new Date(t0 + DAY), from: COUNTERPART, to: [OWNER] });

    const first = await threadJoinHealPass({ db: db as unknown as Tx, apply: true, accountId: s.accountId, maxGroups: 1 });
    expect(first.groupsScanned).toBe(1);
    expect(first.merged).toBe(0);        // it saw only the refusal group
    expect(first.capped).toBe(true);
    expect(first.cursor).toEqual({ accountId: s.accountId, subject: "Invoice" });

    const second = await threadJoinHealPass({
      db: db as unknown as Tx, apply: true, accountId: s.accountId, maxGroups: 1, cursor: first.cursor!,
    });
    expect(second.merged).toBe(1);       // resumed PAST the refusal group, straight to the split

    const remaining = await db.select({ id: threads.id }).from(threads).where(eq(threads.accountId, s.accountId));
    expect(new Set(remaining.map((t) => t.id))).toEqual(new Set([a1, a2, b1]));
  });

  it("a widespread set handed in is used instead of read; a call fills it for its own account only", async () => {
    const marked = await seedProductionSplit();
    const r1 = await threadJoinHealPass({
      db: db as unknown as Tx, apply: true, accountId: marked.s.accountId,
      widespread: new Map([[marked.s.accountId, new Set([COUNTERPART])]]),
    });
    expect(r1.merged).toBe(0);

    const empty = await seedProductionSplit();
    const memo = new Map<string, ReadonlySet<string>>();
    const r2 = await threadJoinHealPass({ db: db as unknown as Tx, apply: true, accountId: empty.s.accountId, widespread: memo });
    expect(r2.merged).toBe(1);
    expect([...memo.keys()]).toEqual([empty.s.accountId]);
    expect(memo.get(empty.s.accountId)!.size).toBe(0);

    const other = await seedProductionSplit();
    const r3 = await threadJoinHealPass({
      db: db as unknown as Tx, apply: true, accountId: other.s.accountId,
      widespread: new Map([[randomUUID(), new Set([COUNTERPART])]]),
    });
    expect(r3.merged).toBe(1);
  });

  it("an overlap consisting only of a PROMISCUOUS witness is no evidence — the mailbox owner's former identity cannot join threads", async () => {
    const s = await seedAccount();
    const oldSelf = "former-identity@own.example";

    // The former identity participates in many unrelated threads — the footprint that
    // disqualifies an address as a join witness. Bulk-seeded: one thread + one message each.
    const noiseThreads = Array.from({ length: 200 }, (_, i) => ({
      accountId: s.accountId, subject: `Noise ${i}`, lastMessageAt: new Date(t0 - (i + 1) * DAY),
      rootMessageIdHeader: `noise-${i}-${s.accountId}@seed.example`, participants: [],
    }));
    const seededNoise = await db.insert(threads).values(noiseThreads).returning({ id: threads.id });
    await db.insert(messages).values(seededNoise.map((t, i) => ({
      accountId: s.accountId, mailboxId: s.mailboxId, threadId: t.id,
      messageIdHeader: `noise-m-${i}-${s.accountId}@seed.example`,
      bodyHash: `noise-${i}`, dedupKey: `noise-${i}-${s.accountId}`,
      subject: `Noise ${i}`, fromAddress: oldSelf, date: new Date(t0 - (i + 1) * DAY),
      // Imported history: it arrived FROM the old provider, so it is inbound mail here.
      nativeLocator: locatorFor(oldSelf),
      toAddresses: [{ name: null, address: OWNER }], ccAddresses: [],
    })));

    // Two UNRELATED vendors, same base subject, inside the window, later one prefixed — the
    // only shared address is the former identity, as each vendor mails it separately.
    const a = await seedThread(s, "Rechnung", new Date(t0));
    await seedMessage(s, a, { subject: "Rechnung", date: new Date(t0), from: "billing@acme.example", to: [oldSelf] });
    const b = await seedThread(s, "Rechnung", new Date(t0 + DAY));
    await seedMessage(s, b, { subject: "AW: Rechnung", date: new Date(t0 + DAY), from: "accounts@other.example", to: [oldSelf] });

    const r = await threadJoinHealPass({ db: db as unknown as Tx, apply: true, accountId: s.accountId });
    expect(r.merged).toBe(0);

    const remaining = await db.select({ id: threads.id }).from(threads).where(eq(threads.accountId, s.accountId));
    expect(remaining).toHaveLength(202); // 200 noise + the two vendors, all untouched
  });

  /**
   * A stranger's own thread shares one address with a trusted conversation because the stranger
   * WROTE that address into their `Cc`. Every other guard passes — same base subject, the later
   * chain claims continuation, well inside the window — so the verdict turns on who put the
   * address there, and the refusal is counted apart so a rising count is readable.
   */
  it("a Cc the SENDER wrote cannot join two conversations, and the refusal is counted", async () => {
    const s = await seedAccount();
    const colleague = "colleague@own.example";

    const a = await seedThread(s, "Zahlung Projekt", new Date(t0));
    await seedMessage(s, a, {
      subject: "Zahlung Projekt", date: new Date(t0), from: OWNER, to: [colleague],
    });

    const b = await seedThread(s, "Zahlung Projekt", new Date(t0 + DAY));
    await seedMessage(s, b, {
      subject: "AW: Zahlung Projekt", date: new Date(t0 + DAY),
      from: "stranger@elsewhere.example", to: [OWNER], cc: [colleague],
    });

    const r = await threadJoinHealPass({ db: db as unknown as Tx, apply: true, accountId: s.accountId });
    expect(r.merged).toBe(0);
    expect(r.refusedUncorroborated).toBe(1);

    const rows = await db.select({ id: threads.id }).from(threads).where(eq(threads.accountId, s.accountId));
    expect(new Set(rows.map((t) => t.id))).toEqual(new Set([a, b]));
  });

  it("POSITIVE CONTROL: the same shape joins once the colleague has written to us on it", async () => {
    const s = await seedAccount();
    const colleague = "colleague@own.example";

    const a = await seedThread(s, "Zahlung Projekt", new Date(t0));
    await seedMessage(s, a, {
      subject: "Zahlung Projekt", date: new Date(t0), from: OWNER, to: [colleague],
    });

    const b = await seedThread(s, "Zahlung Projekt", new Date(t0 + DAY));
    await seedMessage(s, b, {
      subject: "AW: Zahlung Projekt", date: new Date(t0 + DAY), from: colleague, to: [OWNER],
    });

    const r = await threadJoinHealPass({ db: db as unknown as Tx, apply: true, accountId: s.accountId });
    expect(r.merged).toBe(1);
    expect(r.refusedUncorroborated).toBe(0);
  });

  /**
   * ═══ A FORGED `From` CANNOT JOIN TWO CONVERSATIONS ════════════════════════════════════════
   *
   * The merge above is corroborated by "the colleague wrote to us". That reading takes the
   * delivery as evidence about the claimed author — so where the sending side's own check says
   * the author is forged, it is evidence about nobody. Read through THIS pass's own select, not
   * a hand-built array: the column has to reach the rule, and a leaf test cannot say whether it
   * does.
   */
  it("an inbound message whose provider says the author is FORGED cannot corroborate a join", async () => {
    const s = await seedAccount();
    const colleague = "colleague@own.example";

    const a = await seedThread(s, "Zahlung Projekt", new Date(t0));
    await seedMessage(s, a, {
      subject: "Zahlung Projekt", date: new Date(t0), from: OWNER, to: [colleague],
    });

    const b = await seedThread(s, "Zahlung Projekt", new Date(t0 + DAY));
    await seedMessage(s, b, {
      subject: "AW: Zahlung Projekt", date: new Date(t0 + DAY), from: colleague, to: [OWNER],
      authVerdict: "fail",
    });

    const r = await threadJoinHealPass({ db: db as unknown as Tx, apply: true, accountId: s.accountId });
    expect(r.merged, "a forged claim joined two conversations").toBe(0);
    expect(r.refusedUncorroborated).toBe(1);
  });

  it("POSITIVE CONTROL — every other verdict still joins, `pass` is not required", async () => {
    for (const verdict of ["pass", "unavailable", "unauthenticated"] as const) {
      const s = await seedAccount();
      const colleague = "colleague@own.example";
      const a = await seedThread(s, "Zahlung Projekt", new Date(t0));
      await seedMessage(s, a, {
        subject: "Zahlung Projekt", date: new Date(t0), from: OWNER, to: [colleague],
      });
      const b = await seedThread(s, "Zahlung Projekt", new Date(t0 + DAY));
      await seedMessage(s, b, {
        subject: "AW: Zahlung Projekt", date: new Date(t0 + DAY), from: colleague, to: [OWNER],
        authVerdict: verdict,
      });
      const r = await threadJoinHealPass({ db: db as unknown as Tx, apply: true, accountId: s.accountId });
      expect(r.merged, `a ${verdict} verdict was treated as a refusal`).toBe(1);
    }
  });

  it("a note, a draft and a tombstoned message on the absorbed thread survive the merge — repointed, silent, still deleted", async () => {
    const { s, original, forwardChain } = await seedProductionSplit();

    // The production foreign-key violation: an absorbed thread carrying rows in the OTHER tables that FK it.
    const [note] = await db.insert(threadNotes).values({
      accountId: s.accountId, threadId: forwardChain.thread, body: "call them tuesday",
    }).returning({ id: threadNotes.id });
    const [draft] = await db.insert(drafts).values({
      accountId: s.accountId, mailboxId: s.mailboxId, threadId: forwardChain.thread, subject: "Re: …",
    }).returning({ id: drafts.id });
    // And a soft-deleted message: it must MOVE (the FK demands the thread empty) but its move
    // must never be announced — a message:update materializes without consulting deleted_at,
    // so announcing it would resurrect deleted mail on every mirror.
    const tombstoned = await seedMessage(s, forwardChain.thread, {
      subject: "Re: Fwd: AW: Web Banner - vendor - Partner", date: new Date(t0 + 1.8 * DAY),
      from: OWNER, to: [COUNTERPART],
    });
    await db.update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, tombstoned));

    const r = await threadJoinHealPass({ db: db as unknown as Tx, apply: true, accountId: s.accountId });
    expect(r.merged).toBe(1);
    expect(r.skipped).toBe(0);           // the group COMMITTED — no 23503
    expect(r.messagesMoved).toBe(4);     // all four rows moved, tombstone included

    const noteRow = await db.select({ threadId: threadNotes.threadId }).from(threadNotes)
      .where(eq(threadNotes.id, note!.id));
    expect(noteRow[0]!.threadId).toBe(original.thread);
    const draftRow = await db.select({ threadId: drafts.threadId }).from(drafts)
      .where(eq(drafts.id, draft!.id));
    expect(draftRow[0]!.threadId).toBe(original.thread);

    const tomb = await db.select({ threadId: messages.threadId, deletedAt: messages.deletedAt })
      .from(messages).where(eq(messages.id, tombstoned));
    expect(tomb[0]!.threadId).toBe(original.thread);
    expect(tomb[0]!.deletedAt).not.toBeNull();

    const changes = await db.select({
      entityType: changeLog.entityType, entityId: changeLog.entityId, op: changeLog.op,
    }).from(changeLog).where(eq(changeLog.accountId, s.accountId));
    const keys = new Set(changes.map((c) => `${c.entityType}:${c.op}:${c.entityId}`));
    expect(keys.has(`message:update:${tombstoned}`)).toBe(false);   // the silent move
    expect(keys.has(`draft:update:${draft!.id}`)).toBe(true);       // drafts are mirrored
    for (const id of forwardChain.messages) expect(keys.has(`message:update:${id}`)).toBe(true);
  });

  it("lastMessageAt is exact past the correspondent sample cap, and a survivor never moves backwards", async () => {
    const s = await seedAccount();
    const a = await seedThread(s, "Big one", new Date(t0));
    await seedMessage(s, a, { subject: "Big one", date: new Date(t0), from: OWNER, to: [COUNTERPART] });

    // The absorbed thread: more living messages than the ascending sample reads, the NEWEST beyond it.
    const b = await seedThread(s, "Big one", new Date(t0 + DAY));
    await db.insert(messages).values(Array.from({ length: 501 }, (_, i) => ({
      accountId: s.accountId, mailboxId: s.mailboxId, threadId: b,
      messageIdHeader: `big-${i}-${s.accountId}@seed.example`,
      bodyHash: `big-${i}`, dedupKey: `big-${i}-${s.accountId}`,
      subject: i === 0 ? "AW: Big one" : "AW: AW: Big one",
      fromAddress: i % 2 === 0 ? COUNTERPART : OWNER, date: new Date(t0 + DAY + i * 60_000),
      nativeLocator: locatorFor(i % 2 === 0 ? COUNTERPART : OWNER),
      toAddresses: [{ name: null, address: i % 2 === 0 ? OWNER : COUNTERPART }], ccAddresses: [],
    })));
    const trueMax = new Date(t0 + DAY + 500 * 60_000);

    const r = await threadJoinHealPass({ db: db as unknown as Tx, apply: true, accountId: s.accountId });
    expect(r.merged).toBe(1);

    const surv = await db.select({ lastMessageAt: threads.lastMessageAt }).from(threads)
      .where(eq(threads.id, a));
    expect(surv[0]!.lastMessageAt).toEqual(trueMax);
  });

  it("a failed merge transaction counts as FAILED, not skipped — nothing committed, cursor still handed back", async () => {
    const s = await seedAccount();
    const a = await seedThread(s, "Retry me", new Date(t0));
    await seedMessage(s, a, { subject: "Retry me", date: new Date(t0), from: OWNER, to: [COUNTERPART] });
    const b = await seedThread(s, "Retry me", new Date(t0 + DAY));
    await seedMessage(s, b, { subject: "AW: Retry me", date: new Date(t0 + DAY), from: COUNTERPART, to: [OWNER] });

    // The clock is only read inside the merge transaction, so a throwing clock is a
    // transaction failure. It throws on EVERY attempt, so the in-run retry fails too and the
    // group lands in `failed` — the persistent case.
    const r = await threadJoinHealPass({
      db: db as unknown as Tx, apply: true, accountId: s.accountId,
      now: () => { throw new Error("persistent"); },
    });
    expect(r.failed).toBe(1);
    expect(r.skipped).toBe(0);   // over-bound groups only — a failure is not a refusal
    expect(r.merged).toBe(0);
    expect(r.cursor).toEqual({ accountId: s.accountId, subject: "Retry me" });

    // Nothing committed: both threads still stand, and a healthy re-run heals the group.
    const remaining = await db.select({ id: threads.id }).from(threads).where(eq(threads.accountId, s.accountId));
    expect(remaining).toHaveLength(2);
    const again = await threadJoinHealPass({ db: db as unknown as Tx, apply: true, accountId: s.accountId });
    expect(again.merged).toBe(1);
    expect(again.failed).toBe(0);
  });

  it("a TRANSIENT failure heals in the same run — one immediate retry, nothing counted failed", async () => {
    const s = await seedAccount();
    const a = await seedThread(s, "Blip", new Date(t0));
    await seedMessage(s, a, { subject: "Blip", date: new Date(t0), from: OWNER, to: [COUNTERPART] });
    const b = await seedThread(s, "Blip", new Date(t0 + DAY));
    await seedMessage(s, b, { subject: "AW: Blip", date: new Date(t0 + DAY), from: COUNTERPART, to: [OWNER] });

    // Throws exactly once — the first attempt's first clock read — then behaves: the shape of
    // a competing writer whose transaction has committed by the time of the retry.
    let thrown = false;
    const r = await threadJoinHealPass({
      db: db as unknown as Tx, apply: true, accountId: s.accountId,
      now: () => {
        if (!thrown) { thrown = true; throw new Error("transient"); }
        return new Date();
      },
    });
    expect(r.merged).toBe(1);
    expect(r.failed).toBe(0);

    const remaining = await db.select({ id: threads.id }).from(threads).where(eq(threads.accountId, s.accountId));
    expect(remaining.map((t) => t.id)).toEqual([a]);
  });

  /**
   * THE PREMISE ITSELF, re-read under the lock. The group is formed by grouping threads on
   * `subject`, and `subject` is mutable — a person renames a thread, and `thread-subject-heal`
   * rewrites one. A rename committed between the facts read and the transaction left this merging
   * two conversations on a fact that no longer held, and DELETING one of them.
   */
  it("a rename committed while the merge is being taken stops it, and both threads survive", async () => {
    const s = await seedAccount();
    const a = await seedThread(s, "Rename race", new Date(t0));
    await seedMessage(s, a, { subject: "Rename race", date: new Date(t0), from: OWNER, to: [COUNTERPART] });
    const b = await seedThread(s, "Rename race", new Date(t0 + DAY));
    await seedMessage(s, b, { subject: "AW: Rename race", date: new Date(t0 + DAY), from: COUNTERPART, to: [OWNER] });

    const r = await threadJoinHealPass({
      db: db as unknown as Tx, apply: true, accountId: s.accountId,
      beforeMergeAttempt: async () => {
        await db.update(threads).set({ subject: "Not this conversation after all" })
          .where(eq(threads.id, b));
      },
    });

    expect(r.merged).toBe(0);
    expect(r.messagesMoved).toBe(0);
    // SKIPPED, not FAILED: a rename is not a fault, so it may not spend the retry or be logged
    // as one — and the walk comes back around to re-group them as they now are.
    expect(r.skipped).toBe(1);
    expect(r.failed).toBe(0);

    // BOTH THREADS ALIVE. This is the assertion the row is about: the absorbed one is DELETED by
    // a merge, and that delete is not recoverable.
    const alive = await db.select({ id: threads.id }).from(threads)
      .where(eq(threads.accountId, s.accountId)).orderBy(asc(threads.id));
    expect(alive.map((t) => t.id).sort()).toEqual([a, b].sort());
    // …and no message moved between them.
    const homes = await db.select({ threadId: messages.threadId }).from(messages)
      .where(eq(messages.accountId, s.accountId));
    expect(homes.filter((m) => m.threadId === a)).toHaveLength(1);
    expect(homes.filter((m) => m.threadId === b)).toHaveLength(1);
  });

  it("POSITIVE CONTROL — the same fixture with no rename in that window merges", async () => {
    const s = await seedAccount();
    const a = await seedThread(s, "Rename race", new Date(t0));
    await seedMessage(s, a, { subject: "Rename race", date: new Date(t0), from: OWNER, to: [COUNTERPART] });
    const b = await seedThread(s, "Rename race", new Date(t0 + DAY));
    await seedMessage(s, b, { subject: "AW: Rename race", date: new Date(t0 + DAY), from: COUNTERPART, to: [OWNER] });

    const r = await threadJoinHealPass({ db: db as unknown as Tx, apply: true, accountId: s.accountId });

    expect(r.merged).toBe(1);
    expect(r.skipped).toBe(0);
    const alive = await db.select({ id: threads.id }).from(threads)
      .where(eq(threads.accountId, s.accountId));
    expect(alive.map((t) => t.id)).toEqual([a]);
  });

  it("the survivor's participants come from the locked thread rows — what ingest folded in mid-flight survives the merge", async () => {
    const s = await seedAccount();
    const a = await seedThread(s, "Rows win", new Date(t0));
    await seedMessage(s, a, { subject: "Rows win", date: new Date(t0), from: OWNER, to: [COUNTERPART] });
    const b = await seedThread(s, "Rows win", new Date(t0 + DAY));
    await seedMessage(s, b, { subject: "AW: Rows win", date: new Date(t0 + DAY), from: COUNTERPART, to: [OWNER] });
    // The shape a racing ingest leaves: a participant folded into the THREAD ROW after the
    // facts read but before the merge transaction. The seam commits it in exactly that
    // window, so the union must come from the rows the transaction locks — stale facts would
    // drop the late joiner from the surviving conversation.
    const r = await threadJoinHealPass({
      db: db as unknown as Tx, apply: true, accountId: s.accountId,
      beforeMergeAttempt: async () => {
        await db.update(threads).set({
          participants: [{ name: null, address: "late-joiner@partner.example" }],
        }).where(eq(threads.id, b));
      },
    });
    expect(r.merged).toBe(1);

    const [surv] = await db.select({ participants: threads.participants }).from(threads).where(eq(threads.id, a));
    const addrs = (surv!.participants as Array<{ address: string }>).map((x) => x.address);
    expect(addrs).toContain("late-joiner@partner.example");
  });

  it("the survivor lists at most the bound of people: its own first, then the absorbed thread's", async () => {
    const s = await seedAccount();
    const a = await seedThread(s, "Wide rows", new Date(t0));
    await seedMessage(s, a, { subject: "Wide rows", date: new Date(t0), from: OWNER, to: [COUNTERPART] });
    const b = await seedThread(s, "Wide rows", new Date(t0 + DAY));
    await seedMessage(s, b, { subject: "AW: Wide rows", date: new Date(t0 + DAY), from: COUNTERPART, to: [OWNER] });
    const people = (n: number, p: string) => Array.from({ length: n }, (_, i) => ({ name: null, address: `${p}${i}@wide.example` }));
    await db.update(threads).set({ participants: people(60, "a") }).where(eq(threads.id, a));
    await db.update(threads).set({ participants: people(60, "b") }).where(eq(threads.id, b));
    const r = await threadJoinHealPass({ db: db as unknown as Tx, apply: true, accountId: s.accountId });
    expect(r.merged).toBe(1);
    const [surv] = await db.select({ participants: threads.participants }).from(threads).where(eq(threads.id, a));
    expect((surv!.participants as Array<{ address: string }>).map((x) => x.address))
      .toEqual([...people(60, "a"), ...people(MAX_THREAD_PARTICIPANTS - 60, "b")].map((p) => p.address));
  });

  /** Alpha and Charlie are splits that join, Bravo two unrelated senders that never do. */
  async function seedThreeGroups(s: Seeded): Promise<void> {
    for (const subject of ["Alpha", "Charlie"]) {
      const x = await seedThread(s, subject, new Date(t0));
      await seedMessage(s, x, { subject, date: new Date(t0), from: OWNER, to: [COUNTERPART] });
      const y = await seedThread(s, subject, new Date(t0 + DAY));
      await seedMessage(s, y, { subject: `AW: ${subject}`, date: new Date(t0 + DAY), from: COUNTERPART, to: [OWNER] });
    }
    const b1 = await seedThread(s, "Bravo", new Date(t0));
    await seedMessage(s, b1, { subject: "Re: Bravo", date: new Date(t0), from: "billing@acme.example", to: [OWNER] });
    const b2 = await seedThread(s, "Bravo", new Date(t0 + DAY));
    await seedMessage(s, b2, { subject: "Re: Bravo", date: new Date(t0 + DAY), from: "accounts@other.example", to: [OWNER] });
  }

  /** What an account ends as: each message's thread (by its subject and its oldest message), and the change-log op counts. */
  async function endState(s: Seeded): Promise<{ placement: string[]; ops: Record<string, number> }> {
    const rows = await db.select({ subject: messages.subject, threadId: messages.threadId }).from(messages)
      .where(eq(messages.accountId, s.accountId));
    const firstOf = new Map<string, string>();
    for (const t of await db.select({ id: threads.id }).from(threads).where(eq(threads.accountId, s.accountId))) {
      const [m] = await db.select({ subject: messages.subject }).from(messages)
        .where(eq(messages.threadId, t.id)).orderBy(asc(messages.date)).limit(1);
      firstOf.set(t.id, m!.subject);
    }
    const ops: Record<string, number> = {};
    for (const c of await db.select({ entityType: changeLog.entityType, op: changeLog.op }).from(changeLog)
      .where(eq(changeLog.accountId, s.accountId))) {
      const k = `${c.entityType}:${c.op}`;
      ops[k] = (ops[k] ?? 0) + 1;
    }
    return { placement: rows.map((r) => `${r.subject} -> ${firstOf.get(r.threadId!)}`).sort(), ops };
  }

  it("a clock that is out stops the walk after each group, and the walk finishes over later calls as one call would", async () => {
    const s = await seedAccount();
    await seedThreeGroups(s);
    const until = () => true;
    // One memo through all three slices, as the tail's walk hands it: read once, then kept.
    const widespread = new Map<string, ReadonlySet<string>>();
    const one = await threadJoinHealPass({ db: db as unknown as Tx, apply: true, accountId: s.accountId, until, widespread });
    expect(one).toMatchObject({ groupsScanned: 1, merged: 1, cut: true, capped: false, cursor: { accountId: s.accountId, subject: "Alpha" } });
    expect(widespread.size).toBe(1);
    const sentinel = new Set(["sentinel@nowhere.example"]);
    widespread.set(s.accountId, sentinel);
    const two = await threadJoinHealPass({ db: db as unknown as Tx, apply: true, accountId: s.accountId, until, cursor: one.cursor!, widespread });
    expect(two).toMatchObject({ groupsScanned: 1, merged: 0, cut: true, cursor: { accountId: s.accountId, subject: "Bravo" } });
    const three = await threadJoinHealPass({ db: db as unknown as Tx, apply: true, accountId: s.accountId, until, cursor: two.cursor!, widespread });
    expect(three).toMatchObject({ groupsScanned: 1, merged: 1, cut: false, capped: false });
    expect(widespread.get(s.accountId)).toBe(sentinel);
    expect([...sentinel]).toEqual(["sentinel@nowhere.example"]);

    const twin = await seedAccount();
    await seedThreeGroups(twin);
    const whole = await threadJoinHealPass({ db: db as unknown as Tx, apply: true, accountId: twin.accountId });
    expect(whole).toMatchObject({ groupsScanned: 3, merged: 2, cut: false });
    expect(await endState(s)).toEqual(await endState(twin));
  });

  it("a spent group budget is capped, not cut, even with the clock out", async () => {
    const s = await seedAccount();
    await seedThreeGroups(s);
    const r = await threadJoinHealPass({
      db: db as unknown as Tx, apply: true, accountId: s.accountId, maxGroups: 1, until: () => true,
    });
    expect(r).toMatchObject({ groupsScanned: 1, capped: true, cut: false });
  });

  it("a subject on more threads than the bound is skipped untouched, and a later split still joins", async () => {
    const s = await seedAccount();
    for (let i = 0; i < 13; i++) {
      const x = await seedThread(s, "Many", new Date(t0 + i * DAY));
      await seedMessage(s, x, { subject: i === 0 ? "Many" : "AW: Many", date: new Date(t0 + i * DAY), from: OWNER, to: [COUNTERPART] });
    }
    const a = await seedThread(s, "Zulu split", new Date(t0));
    await seedMessage(s, a, { subject: "Zulu split", date: new Date(t0), from: OWNER, to: [COUNTERPART] });
    const b = await seedThread(s, "Zulu split", new Date(t0 + DAY));
    await seedMessage(s, b, { subject: "AW: Zulu split", date: new Date(t0 + DAY), from: COUNTERPART, to: [OWNER] });

    const r = await threadJoinHealPass({ db: db as unknown as Tx, apply: true, accountId: s.accountId });
    expect(r).toMatchObject({ groupsScanned: 2, skipped: 1, merged: 1 });
    const left = await db.select({ subject: threads.subject }).from(threads).where(eq(threads.accountId, s.accountId));
    expect(left.filter((t) => t.subject === "Many")).toHaveLength(13);
    expect(left.filter((t) => t.subject === "Zulu split")).toHaveLength(1);
  });
});

describe("the thread-join heal walk", () => {
  const EVERY = 1_000;
  const WALK = 100;
  const result = (over: Partial<ThreadJoinHealResult>): ThreadJoinHealResult => ({
    groupsScanned: 0, merged: 0, messagesMoved: 0, skipped: 0, failed: 0, refusedUncorroborated: 0,
    capped: false, cut: false, cursor: null, ...over,
  });
  const at = (subject: string) => ({ accountId: "a", subject });

  it("starts due, and a finished walk keeps the gate shut until the period passes", () => {
    const w = makeThreadJoinHealWalk(EVERY, WALK);
    expect(w.due(0)).toBe(true);
    expect(w.slice("a", ["a"])).toMatchObject({ maxGroups: 200 });
    w.settle("a", result({ groupsScanned: 3 }), 1);
    expect(w.slice("a", ["a"])).toBeNull();
    expect(w.due(EVERY - 1)).toBe(false);
    expect(w.due(EVERY)).toBe(true);
    expect(w.slice("a", ["a"])).toMatchObject({ maxGroups: 200 });
  });

  it("a cut keeps the account owed with what is left of its group budget", () => {
    const w = makeThreadJoinHealWalk(EVERY, WALK);
    w.due(0);
    w.slice("a", ["a", "b"]);
    w.settle("a", result({ groupsScanned: 1, cut: true, cursor: at("Alpha") }), 1);
    w.slice("b", ["a", "b"]);
    w.settle("b", result({}), 1);
    expect(w.due(10)).toBe(true);
    expect(w.slice("a", ["a", "b"])).toMatchObject({ cursor: at("Alpha"), maxGroups: 199 });
    expect(w.slice("b", ["a", "b"])).toBeNull();
    w.settle("a", result({ groupsScanned: 2 }), 1);
    expect(w.due(20)).toBe(false);
  });

  it("a capped account resumes at its cursor in the next walk; an exhausted one starts over", () => {
    const w = makeThreadJoinHealWalk(EVERY, WALK);
    w.due(0);
    w.slice("a", ["a", "b"]);
    w.settle("a", result({ groupsScanned: 200, capped: true, cursor: at("Mike") }), 1);
    w.slice("b", ["a", "b"]);
    w.settle("b", result({ groupsScanned: 4, cursor: { accountId: "b", subject: "Zulu" } }), 1);
    expect(w.due(EVERY)).toBe(true);
    expect(w.slice("a", ["a", "b"])).toMatchObject({ cursor: at("Mike"), maxGroups: 200 });
    expect(w.slice("b", ["a", "b"])).toMatchObject({ maxGroups: 200 });
  });

  it("an abandoned slice closes the account and keeps its last settled cursor", () => {
    const w = makeThreadJoinHealWalk(EVERY, WALK);
    w.due(0);
    w.slice("a", ["a"]);
    w.settle("a", result({ groupsScanned: 1, cut: true, cursor: at("Alpha") }), 1);
    expect(w.due(10)).toBe(true);
    w.slice("a", ["a"]);
    w.abandon("a");
    expect(w.due(20)).toBe(false);
    expect(w.due(EVERY)).toBe(true);
    expect(w.slice("a", ["a"])).toMatchObject({ cursor: at("Alpha"), maxGroups: 200 });
  });

  it("an owed account that left the shard releases the gate", () => {
    const w = makeThreadJoinHealWalk(EVERY, WALK);
    w.due(0);
    w.slice("a", ["a", "b"]);
    w.settle("a", result({ groupsScanned: 1, cut: true, cursor: at("Alpha") }), 1);
    w.slice("b", ["a", "b"]);
    w.settle("b", result({}), 1);
    expect(w.due(10)).toBe(true);
    expect(w.slice("b", ["b"])).toBeNull();
    expect(w.due(20)).toBe(false);
    expect(w.due(EVERY)).toBe(true);
    expect(w.slice("a", ["a"])).toMatchObject({ cursor: at("Alpha"), maxGroups: 200 });
  });

  it("a walk never outlives its period", () => {
    const w = makeThreadJoinHealWalk(EVERY, WALK);
    w.due(0);
    w.slice("a", ["a"]);
    w.settle("a", result({ groupsScanned: 1, cut: true, cursor: at("Alpha") }), 1);
    expect(w.due(EVERY)).toBe(true);
    expect(w.slice("a", ["a"])).toMatchObject({ cursor: at("Alpha"), maxGroups: 200 });
  });

  it("a walk whose slices keep being cut closes once its time is spent, and the next walk resumes at its cursor", () => {
    const w = makeThreadJoinHealWalk(EVERY, WALK);
    w.due(0);
    w.slice("a", ["a"]);
    expect(w.settle("a", result({ groupsScanned: 1, cut: true, cursor: at("Alpha") }), 60)).toBeNull();
    expect(w.slice("a", ["a"])).toMatchObject({ cursor: at("Alpha"), maxGroups: 199 });
    expect(w.settle("a", result({ groupsScanned: 1, cut: true, cursor: at("Bravo") }), 50))
      .toEqual({ scanned: 2, slices: 2, ms: 110, more: true });
    expect(w.slice("a", ["a"])).toBeNull();
    expect(w.due(120)).toBe(false);
    expect(w.due(EVERY)).toBe(true);
    expect(w.slice("a", ["a"])).toMatchObject({ cursor: at("Bravo"), maxGroups: 200 });
    // A clock stepping back counts as no time; an exhausted walk closes with nothing left.
    expect(w.settle("a", result({ groupsScanned: 3 }), -5)).toEqual({ scanned: 3, slices: 1, ms: 0, more: false });
  });

  it("the widespread memo is one account's for one walk", () => {
    const w = makeThreadJoinHealWalk(EVERY, WALK);
    w.due(0);
    const memo = w.slice("a", ["a", "b"])!.widespread;
    memo.set("a", new Set(["x@example.test"]));
    w.settle("a", result({ groupsScanned: 1, cut: true, cursor: at("Alpha") }), 1);
    expect(w.slice("a", ["a", "b"])!.widespread).toBe(memo);
    expect(memo.has("a")).toBe(true);
    w.slice("b", ["a", "b"]);
    memo.set("b", new Set(["y@example.test"]));
    w.settle("a", result({ groupsScanned: 1 }), 1);
    expect([...memo.keys()]).toEqual(["b"]);
    w.abandon("b");
    expect(memo.size).toBe(0);
    memo.set("a", new Set(["x@example.test"]));
    w.due(EVERY);
    expect(w.slice("a", ["a"])!.widespread.size).toBe(0);
  });
});
