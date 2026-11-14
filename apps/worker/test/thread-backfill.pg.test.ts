import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, asc, eq, isNull } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { accounts, changeLog, mailboxes, messageBodies, messages, threads, type Tx } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { resolveThread } from "@trafficflow/core";
import { runThreadBackfill } from "../src/thread-backfill.js";

/**
 * THE FIND-OR-CREATE RACE, AGAINST REAL POSTGRES — slice.
 *
 * ── WHY PGLITE DOES NOT COUNT HERE ─────────────────────────────────────────────────────────
 *
 * PGlite is single-connection: it cannot host two transactions at once, so `ON CONFLICT`
 * contention, `SELECT … FOR UPDATE` and `xmax = 0` are all trivially satisfied there and every
 * concurrency claim in this slice would be green by construction. Three production bugs in this
 * repository were invisible to PGlite and appeared only on :5433, all of this exact class.
 *
 * ── THE RACE IS REAL ───────────────────────────────────────────────────────────────────────
 *
 * Threading is ACCOUNT-scoped, and an account can have several mailboxes. Two of them attach at
 * the same time (a leader handover, or simply a two-mailbox account starting up), both run the
 * backfill for the same account, and both reach the same conversation. Before
 * `threads.root_message_id_header` there was nothing to write an `ON CONFLICT` against, so the
 * only possible find-or-create was SELECT-then-INSERT — and both would miss and both would
 * insert, splitting one conversation across two threads with nothing to say so.
 *
 * Four properties, in the order they would break:
 *
 *  1. ONE `threads` row per conversation, and exactly one of the two racers reports creating it
 *     (`xmax = 0` is the DATABASE's answer, not the process's guess).
 *  2. ONE `message` update per message — `FOR UPDATE OF messages` plus a re-evaluated
 *     `thread_id IS NULL` predicate, so the loser's rows drop out of its result set.
 *  3. The per-account seq stays gap-free and unique under two writers.
 *  4. The account boundary holds in SQL, not merely in the in-memory fake (the "Account isolation is absolute, and it binds staff too" invariant).
 */

const AVAILABLE = await realPgAvailable();

describe.skipIf(!AVAILABLE)("thread find-or-create under concurrency", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    // At least two connections, or the "concurrent" transactions would queue in the POOL and
    // the test would prove nothing about the database.
    sql = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg");
  }, 120_000);

  async function seedAccount(): Promise<{ accountId: string; mailboxId: string }> {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `c3-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `c3-${accountId.slice(0, 8)}@example.test`,
    }).returning();
    return { accountId, mailboxId: mb!.id };
  }

  async function seedMessage(
    w: { accountId: string; mailboxId: string },
    o: { id?: string | null; inReplyTo?: string; references?: string[]; date: Date; accountId?: string },
  ): Promise<string> {
    const headers: Record<string, string[]> = {};
    if (o.inReplyTo) headers["in-reply-to"] = [`<${o.inReplyTo}>`];
    if (o.references?.length) headers["references"] = [o.references.map((r) => `<${r}>`).join(" ")];
    const [m] = await db.insert(messages).values({
      accountId: o.accountId ?? w.accountId, mailboxId: w.mailboxId, bodyHash: "h",
      messageIdHeader: o.id ?? null,
      dedupKey: o.id ? `mid:${o.id}` : `body:${randomUUID()}`,
      subject: "Roof detail", fromAddress: "anna@example.com", date: o.date,
      nativeLocator: { folder: "INBOX", ref: `1:${Math.floor(Math.random() * 1e6)}` },
    }).returning();
    await db.insert(messageBodies).values({ messageId: m!.id, accountId: m!.accountId, text: "", html: null, headers });
    return m!.id;
  }

  /**
   * TWO TRANSACTIONS, OVERLAPPING BY CONSTRUCTION.
   *
   * A bare `Promise.all` of two upserts does NOT prove anything here and I watched it not prove
   * it: with `upsertThread` mutated to the naive SELECT-then-INSERT this whole file stayed
   * green, because the first transaction commits before the second one even issues its SELECT.
   * A race guard that only races sometimes is a guard nobody has watched fail.
   *
   * So the overlap is forced. Transaction A performs its upsert and then WAITS on a promise the
   * test controls, holding its row lock / speculative insert open; B starts and must contend
   * with an uncommitted row; only then is A released. The sleeps widen the window, they are not
   * the assertion — whichever transaction gets there first, exactly one may report `created`.
   */
  it("two OVERLAPPING upserts of one anchor produce ONE thread and exactly one `created`", async () => {
    const w = await seedAccount();
    const repo = makeDrizzleRepo(db as unknown as Tx);
    const anchor = `race-${randomUUID()}@x`;
    const seed = (address: string, at: string) => ({
      accountId: w.accountId, rootMessageIdHeader: anchor,
      subject: "Roof detail", participants: [{ name: null, address }],
      lastMessageAt: new Date(at),
    });

    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });

    const a = repo.transaction(async (tx) => {
      const r = await tx.upsertThread(seed("anna@example.com", "2026-07-06T09:00:00Z"));
      await held;               // the transaction stays OPEN across this await
      return r;
    });
    await new Promise((r) => setTimeout(r, 150));   // A has inserted and not committed
    const b = repo.transaction((tx) => tx.upsertThread(seed("bob@example.com", "2026-07-07T09:00:00Z")));
    await new Promise((r) => setTimeout(r, 150));   // B is now blocked on A's row
    release();

    const [ra, rb] = await Promise.all([a, b]);

    expect(ra.id).toBe(rb.id);
    expect([ra.created, rb.created].filter(Boolean), "both racers claimed to have created the row")
      .toHaveLength(1);
    const rows = await db.select().from(threads).where(eq(threads.accountId, w.accountId));
    expect(rows, "one conversation, two threads").toHaveLength(1);
    expect(rows[0]!.rootMessageIdHeader).toBe(anchor);
  }, 60_000);

  /**
   * The same contention, reached the way production reaches it: TWO MAILBOXES of one account
   * ingesting DIFFERENT messages of one conversation at the same time. Neither finds a parent
   * (both messages are new), so both derive the anchor and both run find-or-create.
   *
   * Deliberately NOT through `listThreadBacklog`. That statement takes `FOR UPDATE` over every
   * unthreaded row of the account, so two passes through it serialize on each OTHER'S rows and
   * the anchor is never contended — I watched the naive SELECT-then-INSERT stay green through
   * this path. `commitChange` holds no such lock: it resolves the one message it just inserted.
   * So this drives `resolveThread` the way ingest does, which is the only way the race is real.
   */
  it("two mailboxes ingesting one conversation concurrently converge on ONE thread", async () => {
    const w = await seedAccount();
    const [second] = await db.insert(mailboxes).values({
      accountId: w.accountId, provider: "imap", address: `c3b-${randomUUID().slice(0, 8)}@example.test`,
    }).returning();
    const repo = makeDrizzleRepo(db as unknown as Tx);
    const root = `conv-${randomUUID()}@x`;

    const m1 = await seedMessage(w, { id: `${root}-1`, references: [root], date: new Date("2026-07-06T09:00:00Z") });
    const m2 = await seedMessage({ accountId: w.accountId, mailboxId: second!.id },
      { id: `${root}-2`, references: [root], date: new Date("2026-07-07T09:00:00Z") });

    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const resolveOne = (messageId: string, header: string, hold: boolean) =>
      repo.transaction(async (tx) => {
        const out = await resolveThread(tx, {
          accountId: w.accountId, messageId, messageIdHeader: header,
          headers: { references: [`<${root}>`] }, subject: "Roof detail",
          participants: [{ name: null, address: "anna@example.com" }],
          date: new Date("2026-07-06T09:00:00Z"), emitMessageUpdate: true,
        });
        if (hold) await held;
        return out;
      });

    const first = resolveOne(m1, `${root}-1`, true);
    await new Promise((r) => setTimeout(r, 150));
    const secondRun = resolveOne(m2, `${root}-2`, false);
    await new Promise((r) => setTimeout(r, 150));
    release();
    await Promise.all([first, secondRun]);

    const rows = await db.select().from(threads).where(eq(threads.accountId, w.accountId));
    expect(rows, "one conversation split across two threads").toHaveLength(1);
    expect(rows[0]!.rootMessageIdHeader).toBe(root);
    const filed = await db.select({ threadId: messages.threadId }).from(messages)
      .where(eq(messages.accountId, w.accountId));
    expect(new Set(filed.map((f) => f.threadId)).size).toBe(1);
    expect(filed.every((f) => f.threadId !== null)).toBe(true);
  }, 60_000);

  it("two backfills over one account produce ONE thread per conversation and no seq hole", async () => {
    const w = await seedAccount();
    const repo = makeDrizzleRepo(db as unknown as Tx);

    // 60 conversations of 4, inserted so that no chain is contiguous in date order — the passes
    // interleave across transactions instead of racing once and finishing.
    const CONVERSATIONS = 60;
    const base = Date.UTC(2026, 6, 1);
    for (let depth = 0; depth < 4; depth++) {
      for (let c = 0; c < CONVERSATIONS; c++) {
        const chain = Array.from({ length: depth }, (_, i) => `c${c}-${i}@x`);
        await seedMessage(w, {
          id: `c${c}-${depth}@x`,
          inReplyTo: depth > 0 ? `c${c}-${depth - 1}@x` : undefined,
          references: chain,
          date: new Date(base + (depth * CONVERSATIONS + c) * 60_000),
        });
      }
    }

    const [x, y] = await Promise.all([
      runThreadBackfill({ repo, accountId: w.accountId }),
      runThreadBackfill({ repo, accountId: w.accountId }),
    ]);

    // ── 1. Between them they resolved every message, and neither invented one ──────────────
    expect(x.resolved + y.resolved).toBe(CONVERSATIONS * 4);
    expect(x.threadsCreated + y.threadsCreated).toBe(CONVERSATIONS);

    // ── 2. ONE thread per conversation, each anchored on its ROOT ─────────────────────────
    const threadRows = await db.select().from(threads).where(eq(threads.accountId, w.accountId));
    expect(threadRows).toHaveLength(CONVERSATIONS);
    expect(new Set(threadRows.map((t) => t.rootMessageIdHeader)).size).toBe(CONVERSATIONS);
    for (const t of threadRows) expect(t.rootMessageIdHeader).toMatch(/^c\d+-0@x$/);

    // ── 3. Every message is filed, and each conversation holds exactly its four ───────────
    const msgRows = await db.select({ id: messages.id, header: messages.messageIdHeader, threadId: messages.threadId })
      .from(messages).where(eq(messages.accountId, w.accountId));
    expect(msgRows.filter((m) => m.threadId === null)).toHaveLength(0);
    const byThread = new Map<string, string[]>();
    for (const m of msgRows) {
      const list = byThread.get(m.threadId!) ?? [];
      list.push(m.header!);
      byThread.set(m.threadId!, list);
    }
    expect(byThread.size).toBe(CONVERSATIONS);
    for (const headers of byThread.values()) {
      expect(headers).toHaveLength(4);
      // …and all four belong to the SAME conversation, not four strays that happened to land.
      expect(new Set(headers.map((h) => h.split("-")[0])).size).toBe(1);
    }

    // ── 4. ONE `message` update per message, and a gap-free per-account seq ───────────────
    const changes = await db.select().from(changeLog)
      .where(eq(changeLog.accountId, w.accountId)).orderBy(asc(changeLog.seq));
    const msgUpdates = changes.filter((c) => c.entityType === "message" && c.op === "update");
    expect(msgUpdates).toHaveLength(CONVERSATIONS * 4);
    expect(new Set(msgUpdates.map((c) => c.entityId)).size).toBe(CONVERSATIONS * 4);
    expect(changes.filter((c) => c.entityType === "thread" && c.op === "create"))
      .toHaveLength(CONVERSATIONS);

    const seqs = changes.map((c) => Number(c.seq));
    expect(new Set(seqs).size).toBe(seqs.length);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]! - seqs[i - 1]!).toBe(1);
  }, 240_000);

  it("the account boundary holds in SQL: an identical Message-ID never crosses it", async () => {
    // The in-memory fake asserts the same thing in `packages/core/test/threading.test.ts`; this
    // is the claim against the real planner and the real index, which is where the "Account isolation is absolute, and it binds staff too" invariant has to
    // be true. Two accounts, one shared header, one attacker-chosen reply.
    const mine = await seedAccount();
    const theirs = await seedAccount();
    const repo = makeDrizzleRepo(db as unknown as Tx);
    const shared = `shared-${randomUUID()}@x`;

    const root = await seedMessage(mine, { id: shared, date: new Date("2026-07-06T09:00:00Z") });
    const intruder = await seedMessage(theirs, {
      id: `intruder-${randomUUID()}@x`, inReplyTo: shared, references: [shared],
      date: new Date("2026-07-07T09:00:00Z"),
    });

    await runThreadBackfill({ repo, accountId: mine.accountId });
    await runThreadBackfill({ repo, accountId: theirs.accountId });

    const rowOf = async (id: string): Promise<string | null> =>
      (await db.select().from(messages).where(eq(messages.id, id)))[0]!.threadId;
    const mineThread = await rowOf(root);
    const theirThread = await rowOf(intruder);
    expect(mineThread).not.toBeNull();
    expect(theirThread, "another account's message joined this thread").not.toBe(mineThread);

    // Both threads are anchored on the SAME header — legal, and the reason the unique index is
    // `(account_id, root_message_id_header)` and not `(root_message_id_header)`.
    const mineRows = await db.select().from(threads).where(eq(threads.accountId, mine.accountId));
    const theirRows = await db.select().from(threads).where(eq(threads.accountId, theirs.accountId));
    expect(mineRows).toHaveLength(1);
    expect(theirRows).toHaveLength(1);
    expect(mineRows[0]!.rootMessageIdHeader).toBe(shared);
    expect(theirRows[0]!.rootMessageIdHeader).toBe(shared);
  }, 120_000);

  it("anchorless messages do NOT collide on one NULL row", async () => {
    // Postgres treats NULLs as DISTINCT in a unique index, which is the behaviour this design
    // depends on: a message with no Message-ID anchors nothing and must be its own singleton.
    // Asserted here rather than only against PGlite because it is an index semantic, and the
    // alternative (`NULLS NOT DISTINCT`, a newer Postgres) would collapse every one of them into one
    // thread — a real mailbox's spam would arrive as a single, enormous conversation.
    const w = await seedAccount();
    const repo = makeDrizzleRepo(db as unknown as Tx);
    await seedMessage(w, { id: null, date: new Date("2026-07-06T09:00:00Z") });
    await seedMessage(w, { id: null, date: new Date("2026-07-07T09:00:00Z") });
    await seedMessage(w, { id: null, date: new Date("2026-07-08T09:00:00Z") });

    await runThreadBackfill({ repo, accountId: w.accountId });

    const rows = await db.select().from(threads).where(eq(threads.accountId, w.accountId));
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.rootMessageIdHeader === null)).toBe(true);
    const unfiled = await db.select().from(messages)
      .where(and(eq(messages.accountId, w.accountId), isNull(messages.threadId)));
    expect(unfiled).toHaveLength(0);
  }, 120_000);

  /**
   * THE SLICE COMMITS, AND THE NEXT SLICE PICKS UP FROM THE COMMITTED STATE.
   *
   * The bounds themselves are arithmetic and PGlite proves them (`thread-backfill.test.ts`).
   * What needs REAL Postgres is the transactional half of "resumable": a slice that stops on a
   * bound must leave its pages DURABLY committed and the per-account seq intact, because
   * `recordChange` allocates that seq under the account's `account_sync_state` row lock and a
   * pass that stopped between transactions is the only way this loop ever ends in production.
   * If a bound rolled anything back, the drain would loop on the same batch of rows for ever
   * against a live mailbox and nothing in the PGlite file could see it.
   */
  it("a slice that spends its budget commits its pages, and five slices drain the backlog gap-free", async () => {
    const w = await seedAccount();
    const repo = makeDrizzleRepo(db as unknown as Tx);
    const TOTAL = 350;                                        // several pages at the batch size
    const base = Date.UTC(2026, 7, 1);
    for (let i = 0; i < TOTAL; i++) {
      await seedMessage(w, { id: `slice${i}@x`, date: new Date(base + i * 60_000) });
    }

    const slices: Array<{ resolved: number; truncated: boolean }> = [];
    for (let i = 0; i < 5; i++) {
      slices.push(await runThreadBackfill({ repo, accountId: w.accountId, maxPages: 1 }));
    }

    // Three full pages, one partial, then one that finds nothing left. Each ran in its own call
    // with no state carried between them but the database itself.
    expect(slices.map((s) => s.resolved)).toEqual([100, 100, 100, 50, 0]);
    // The FOURTH slice drained the account and still reports `truncated: true`, and that is the
    // honest answer rather than an off-by-one: it spent its page budget, and a pass that never
    // read an empty page cannot know whether the predicate is empty. Only the fifth can say so.
    // Nothing depends on the difference — the worker kicks a slice per cycle regardless, and a
    // slice against a drained account is one indexed probe.
    expect(slices.map((s) => s.truncated)).toEqual([true, true, true, true, false]);

    const unresolved = await db.select().from(messages)
      .where(and(eq(messages.accountId, w.accountId), isNull(messages.threadId)));
    expect(unresolved).toHaveLength(0);

    // ONE change row per message and a gap-free seq ACROSS the slice boundaries — the property
    // that would break first if a bounded pass ever left a transaction open or re-ran a page.
    const changes = await db.select().from(changeLog)
      .where(eq(changeLog.accountId, w.accountId)).orderBy(asc(changeLog.seq));
    const msgUpdates = changes.filter((c) => c.entityType === "message" && c.op === "update");
    expect(msgUpdates).toHaveLength(TOTAL);
    expect(new Set(msgUpdates.map((c) => c.entityId)).size).toBe(TOTAL);
    const seqs = changes.map((c) => Number(c.seq));
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]! - seqs[i - 1]!).toBe(1);
  }, 240_000);
});
