import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { changeLog, mailboxes, messageBodies, messages, threads, type Tx } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { makeDrizzleRepo, type WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { resolveThread } from "@trafficflow/core";
import {
  runThreadBackfill, THREAD_BACKFILL_BATCH, THREAD_BACKFILL_MAX_PAGES,
} from "../src/thread-backfill.js";

/**
 * THE THREAD BACKFILL — the rows of the seeded world and of a live mailbox get
 * their conversations from the headers already on disk.
 *
 * PGlite here, deliberately, and the same split the kickstart uses: everything in this file
 * is one pass doing one thing. What needs real Postgres is what TWO passes do to `threads` and
 * `change_log` at once, and that has its own file on :5433 — `thread-backfill.pg.test.ts` —
 * because the find-or-create race is exactly the class PGlite has hidden three times here.
 */

interface World { db: Tx; repo: WorkerRepo; accountId: string; mailboxId: string; }

async function world(): Promise<World> {
  const db = (await makeTestDb()) as unknown as Tx;
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: `owner-${randomUUID().slice(0, 8)}@lichtgrat.example` })
    .returning();
  return { db, repo: makeDrizzleRepo(db), accountId, mailboxId: mb!.id };
}

/**
 * A message exactly as the pre-C3 pipeline left it: persisted headers, `thread_id` NULL.
 * `mailboxId` defaults to this world's mailbox; ANOTHER account's message passes its own, because
 * mail 0118's `messages_mailbox_id_account_fk` keys the pair and refuses the borrowed one.
 */
async function seed(w: World, o: {
  id?: string; from?: string; subject?: string; inReplyTo?: string; references?: string[];
  date?: Date; accountId?: string; mailboxId?: string; threadId?: string;
}): Promise<string> {
  const headers: Record<string, string[]> = {};
  if (o.inReplyTo) headers["in-reply-to"] = [`<${o.inReplyTo}>`];
  if (o.references?.length) headers["references"] = [o.references.map((r) => `<${r}>`).join(" ")];
  const [m] = await w.db.insert(messages).values({
    accountId: o.accountId ?? w.accountId, mailboxId: o.mailboxId ?? w.mailboxId, bodyHash: "h",
    messageIdHeader: o.id ?? null,
    dedupKey: o.id ? `mid:${o.id}` : `body:${randomUUID()}`,
    subject: o.subject ?? "Roof detail",
    fromAddress: o.from ?? "anna@example.com",
    date: o.date ?? new Date("2026-07-06T09:00:00Z"),
    threadId: o.threadId ?? null,
    nativeLocator: { folder: "INBOX", ref: `1:${Math.floor(Math.random() * 1e6)}` },
  }).returning();
  await w.db.insert(messageBodies).values({ messageId: m!.id, accountId: m!.accountId, text: "", html: null, headers });
  return m!.id;
}

const threadOf = async (w: World, id: string): Promise<string | null> =>
  (await w.db.select().from(messages).where(eq(messages.id, id)))[0]!.threadId;

describe("runThreadBackfill", () => {
  it("resolves a 4-deep chain that was seeded in REVERSE into one thread", async () => {
    const w = await world();
    // Inserted newest-first, so the backfill's `ORDER BY date ASC` is doing real work rather
    // than reading rows in the order they happen to sit in the heap.
    const d = await seed(w, { id: "d@x", inReplyTo: "c@x", references: ["a@x", "b@x", "c@x"], date: new Date("2026-07-09T09:00:00Z") });
    const c = await seed(w, { id: "c@x", inReplyTo: "b@x", references: ["a@x", "b@x"], date: new Date("2026-07-08T09:00:00Z") });
    const b = await seed(w, { id: "b@x", inReplyTo: "a@x", references: ["a@x"], date: new Date("2026-07-07T09:00:00Z") });
    const a = await seed(w, { id: "a@x", date: new Date("2026-07-06T09:00:00Z") });

    const r = await runThreadBackfill({ repo: w.repo, accountId: w.accountId });
    expect(r).toMatchObject({ resolved: 4, threadsCreated: 1, truncated: false });

    const ids = await Promise.all([a, b, c, d].map((id) => threadOf(w, id)));
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).not.toBeNull();

    const [t] = await w.db.select().from(threads).where(eq(threads.accountId, w.accountId));
    expect(t!.rootMessageIdHeader).toBe("a@x");
    expect(t!.subject).toBe("Roof detail");
    // The newest message in the conversation, not the first one the pass happened to touch.
    expect(t!.lastMessageAt?.toISOString()).toBe("2026-07-09T09:00:00.000Z");
  });

  it("emits a `message` update per resolved message and ONE `thread` create per conversation", async () => {
    // The `message` updates are not optional here and this is the difference from ingest: the
    // client's mirror already holds these messages from an earlier sync, so without an update
    // the conversation is invisible until a re-bootstrap — which is the thing the delta
    // contract exists to avoid (the "Delta-first client contract" invariant).
    const w = await world();
    const a = await seed(w, { id: "a@x" });
    const b = await seed(w, { id: "b@x", inReplyTo: "a@x", references: ["a@x"], date: new Date("2026-07-07T09:00:00Z") });

    await runThreadBackfill({ repo: w.repo, accountId: w.accountId });

    const rows = await w.db.select().from(changeLog).where(eq(changeLog.accountId, w.accountId));
    const kinds = rows.map((r) => `${r.entityType}:${r.op}`);
    expect(kinds.filter((k) => k === "thread:create")).toHaveLength(1);
    expect(kinds.filter((k) => k === "message:update")).toHaveLength(2);
    const updated = rows.filter((r) => r.entityType === "message").map((r) => r.entityId);
    expect(new Set(updated)).toEqual(new Set([a, b]));
  });

  it("does not disturb a message that already has a thread", async () => {
    const w = await world();
    const [existing] = await w.db.insert(threads)
      .values({ accountId: w.accountId, subject: "Chosen by the user", rootMessageIdHeader: "pinned@x" })
      .returning();
    // `a@x` is already filed — by an earlier backfill, or by `POST /threads/merge`, which is a
    // USER decision. A pass that re-derived it would silently undo that.
    const a = await seed(w, { id: "a@x", threadId: existing!.id });
    const b = await seed(w, { id: "b@x", date: new Date("2026-07-07T09:00:00Z") });

    const r = await runThreadBackfill({ repo: w.repo, accountId: w.accountId });
    expect(r.resolved).toBe(1);
    expect(await threadOf(w, a)).toBe(existing!.id);
    expect(await threadOf(w, b)).not.toBe(existing!.id);

    const [after] = await w.db.select().from(threads).where(eq(threads.id, existing!.id));
    expect(after!.subject).toBe("Chosen by the user");
    // No change row for the untouched message.
    const rows = await w.db.select().from(changeLog)
      .where(and(eq(changeLog.accountId, w.accountId), eq(changeLog.entityId, a)));
    expect(rows).toHaveLength(0);
  });

  /**
   * THE TRANSITION WINDOW, which is the case `resolveThread` deliberately does NOT write its way
   * out of.
   *
   * A reply is ingested while its parent is still unthreaded — the deploy window, before or
   * during the first backfill. Ingest finds the parent, sees a NULL thread, and does NOT reach
   * over and file it (that write is ingest's only lock on a pre-existing `messages` row, and it
   * inverts against the backfill's `FOR UPDATE` page). The claim is that it does not need to,
   * because the anchor is deterministic: the parent derives the same root its child derived, so
   * the backfill's `ON CONFLICT` drops it into the thread the child already made.
   *
   * Convergence asserted, not assumed — if this ever failed, the removed write would be the fix.
   */
  it("a reply ingested while its parent is unthreaded converges when the parent is backfilled", async () => {
    const w = await world();
    const parent = await seed(w, { id: "a@x", date: new Date("2026-07-06T09:00:00Z") });
    const child = await seed(w, {
      id: "b@x", inReplyTo: "a@x", references: ["a@x"], date: new Date("2026-07-07T09:00:00Z"),
    });

    // The child alone, exactly as `commitChange` would resolve it mid-deploy: the parent row
    // exists and has no thread.
    await w.repo.transaction(async (tx) => {
      const r = await resolveThread(tx, {
        accountId: w.accountId, messageId: child, messageIdHeader: "b@x",
        headers: { "in-reply-to": ["<a@x>"], references: ["<a@x>"] }, subject: "Re: Roof detail",
        participants: [{ name: null, address: "bob@example.com" }],
        date: new Date("2026-07-07T09:00:00Z"), emitMessageUpdate: false,
      });
      expect(r.parentFound, "the parent was not even found").toBe(true);
      expect(r.created).toBe(true);
    });
    const childThread = await threadOf(w, child);
    expect(childThread).not.toBeNull();
    expect(await threadOf(w, parent), "ingest reached over and filed the parent").toBeNull();

    // …and now the backfill catches up.
    const r = await runThreadBackfill({ repo: w.repo, accountId: w.accountId });
    expect(r.resolved).toBe(1);
    expect(r.threadsCreated, "the parent minted a SECOND thread for one conversation").toBe(0);
    expect(await threadOf(w, parent)).toBe(childThread);
    expect(await w.db.select().from(threads).where(eq(threads.accountId, w.accountId))).toHaveLength(1);
  });

  it("is re-runnable: the second pass is a no-op and writes nothing", async () => {
    const w = await world();
    await seed(w, { id: "a@x" });
    await seed(w, { id: "b@x", inReplyTo: "a@x", references: ["a@x"], date: new Date("2026-07-07T09:00:00Z") });

    const first = await runThreadBackfill({ repo: w.repo, accountId: w.accountId });
    const changesAfterFirst =
      (await w.db.select().from(changeLog).where(eq(changeLog.accountId, w.accountId))).length;

    const second = await runThreadBackfill({ repo: w.repo, accountId: w.accountId });

    expect(first.resolved).toBe(2);
    expect(second).toEqual({ resolved: 0, threadsCreated: 0, truncated: false });
    expect(await w.db.select().from(threads).where(eq(threads.accountId, w.accountId))).toHaveLength(1);
    expect((await w.db.select().from(changeLog).where(eq(changeLog.accountId, w.accountId))).length)
      .toBe(changesAfterFirst);
  });

  it("never crosses an account boundary, even for an identical Message-ID", async () => {
    // The "Account isolation is absolute, and it binds staff too" invariant through the threading key: a Message-ID is chosen by the sender, so an unscoped
    // pass would let one account's mail be filed into another account's conversation. The other
    // account holds its OWN mailbox, which is production's shape and the only one mail 0118's
    // `messages_mailbox_id_account_fk` admits — borrowing this world's mailbox was the fixture's
    // shortcut, and a double that cannot exist in production measures nothing.
    const w = await world();
    const other = randomUUID();
    const [theirMailbox] = await w.db.insert(mailboxes)
      .values({ accountId: other, provider: "imap", address: `other-${randomUUID().slice(0, 8)}@lichtgrat.example` })
      .returning();
    const mine = await seed(w, { id: "shared@x", subject: "Contract" });
    const theirs = await seed(w, {
      id: "reply@x", accountId: other, mailboxId: theirMailbox!.id, subject: "Re: Contract",
      inReplyTo: "shared@x", references: ["shared@x"], date: new Date("2026-07-07T09:00:00Z"),
    });

    await runThreadBackfill({ repo: w.repo, accountId: w.accountId });
    await runThreadBackfill({ repo: w.repo, accountId: other });

    expect(await threadOf(w, mine)).not.toBe(await threadOf(w, theirs));
    const mineThreads = await w.db.select().from(threads).where(eq(threads.accountId, w.accountId));
    const theirThreads = await w.db.select().from(threads).where(eq(threads.accountId, other));
    expect(mineThreads).toHaveLength(1);
    expect(theirThreads).toHaveLength(1);
    // Both anchored on `shared@x` — legal, because the unique index is PER ACCOUNT.
    expect(mineThreads[0]!.rootMessageIdHeader).toBe("shared@x");
    expect(theirThreads[0]!.rootMessageIdHeader).toBe("shared@x");
  });

  it("pages: a backlog larger than one batch is fully drained", async () => {
    const w = await world();
    const n = THREAD_BACKFILL_BATCH + 7;
    for (let i = 0; i < n; i++) {
      await seed(w, { id: `m${i}@x`, date: new Date(Date.UTC(2026, 6, 1, 0, i)) });
    }
    const r = await runThreadBackfill({ repo: w.repo, accountId: w.accountId });
    expect(r.resolved).toBe(n);
    expect(r.threadsCreated).toBe(n);
    expect(r.truncated).toBe(false);
    // `isNull`, not `eq(…, null)`: the latter renders `thread_id = NULL`, which is never true,
    // so the assertion would pass on an empty result no matter what the pass did.
    const unresolved = await w.db.select().from(messages)
      .where(and(eq(messages.accountId, w.accountId), isNull(messages.threadId)));
    expect(unresolved).toHaveLength(0);
    expect(await w.db.select().from(threads).where(eq(threads.accountId, w.accountId))).toHaveLength(n);
  });

  /* ────────────────────────────────────────────────────────────────────────────────────────
     THE PER-PASS BOUNDS.

     The first version ran to exhaustion, on the attach path, and took production down. The pass is unchanged;
     what is new is that the worker asks for a SLICE of it and the slice stops on time. Both
     bounds are asserted here and both are asserted to RESUME, because a bound that loses its
     place is worse than no bound: the backlog would never drain.
     ──────────────────────────────────────────────────────────────────────────────────────── */

  it("stops at `maxPages` and the next pass resumes exactly where it left off", async () => {
    const w = await world();
    const n = THREAD_BACKFILL_BATCH * 3;
    for (let i = 0; i < n; i++) {
      await seed(w, { id: `m${i}@x`, date: new Date(Date.UTC(2026, 6, 1, 0, i)) });
    }

    const first = await runThreadBackfill({ repo: w.repo, accountId: w.accountId, maxPages: 2 });
    expect(first.resolved).toBe(THREAD_BACKFILL_BATCH * 2);
    expect(first.truncated, "a bounded pass that left work must say so").toBe(true);

    // RESUMPTION IS THE POINT. Nothing was marked, so the second pass is not "page 3" — it is
    // the same query against a predicate that has shrunk by one batch.
    const second = await runThreadBackfill({ repo: w.repo, accountId: w.accountId, maxPages: 2 });
    expect(second.resolved).toBe(THREAD_BACKFILL_BATCH);
    expect(second.truncated, "the account is drained, so this pass ended on an empty page").toBe(false);

    const unresolved = await w.db.select().from(messages)
      .where(and(eq(messages.accountId, w.accountId), isNull(messages.threadId)));
    expect(unresolved).toHaveLength(0);
  });

  it("`maxPages` cannot be used to raise the absolute ceiling", async () => {
    // The ceiling exists because this loop's termination depends on every examined row LEAVING
    // the predicate; a caller that could raise it could pin a CPU on the hosted service.
    const w = await world();
    await seed(w, { id: "a@x" });
    const r = await runThreadBackfill({
      repo: w.repo, accountId: w.accountId, maxPages: THREAD_BACKFILL_MAX_PAGES * 10,
    });
    expect(r).toEqual({ resolved: 1, threadsCreated: 1, truncated: false });
  });

  it("spends its wall-clock budget between pages, always commits one, and resumes", async () => {
    const w = await world();
    const n = THREAD_BACKFILL_BATCH * 2;
    for (let i = 0; i < n; i++) {
      await seed(w, { id: `d${i}@x`, date: new Date(Date.UTC(2026, 6, 2, 0, i)) });
    }

    // A budget of ZERO, which is the strongest form of the claim: the deadline is checked
    // BETWEEN pages, so even an already-spent budget commits the first batch rather than
    // returning empty-handed and re-reading the same hundred rows on every future slice.
    const first = await runThreadBackfill({
      repo: w.repo, accountId: w.accountId, maxPages: 50, deadlineMs: 0,
    });
    expect(first.resolved).toBe(THREAD_BACKFILL_BATCH);
    expect(first.truncated).toBe(true);

    // …and a budget that has NOT expired lets the pass run to the end of the backlog.
    const rest = await runThreadBackfill({
      repo: w.repo, accountId: w.accountId, maxPages: 50, deadlineMs: 60_000,
    });
    expect(rest.resolved).toBe(THREAD_BACKFILL_BATCH);
    expect(rest.truncated).toBe(false);
  });

  it("warns only for the absolute ceiling; a spent slice budget is routine and logs at info", async () => {
    // `thread_backfill_truncated` is the "the predicate stopped extinguishing" signal. Every
    // one of a live mailbox's five slices fills its budget by design, and a warn per
    // slice would make the paced drain read as five faults.
    const w = await world();
    for (let i = 0; i < THREAD_BACKFILL_BATCH + 1; i++) {
      await seed(w, { id: `w${i}@x`, date: new Date(Date.UTC(2026, 6, 3, 0, i)) });
    }
    const lines: Array<{ level: string; event: string }> = [];
    const log = {
      debug: () => { /* unused */ },
      info: (event: string) => { lines.push({ level: "info", event }); },
      warn: (event: string) => { lines.push({ level: "warn", event }); },
      error: (event: string) => { lines.push({ level: "error", event }); },
      child() { return this; },
    };

    await runThreadBackfill({ repo: w.repo, accountId: w.accountId, maxPages: 1, log });

    expect(lines.map((l) => l.event)).toContain("thread_backfill_paused");
    expect(lines.filter((l) => l.level === "warn")).toHaveLength(0);
  });

  /**
   * The stamp itself, tested directly, because nothing else reaches it.
   *
   * `listThreadBacklog` already filters `thread_id IS NULL`, so removing the same predicate from
   * `setMessageThread` leaves every end-to-end test in this file and in the pg file GREEN — I
   * mutated it and watched twelve tests pass. That makes the guard defence in depth rather than
   * the first line, and defence in depth with no test is just an unverified comment. This is the
   * test: the second line of defence is asserted at the line itself.
   *
   * It matters because the one caller that could reach it is `resolveThread`'s parent attach,
   * whose `parent.threadId` was read earlier in the same transaction — and because
   * `POST /threads/merge` is a USER decision that no later pass may silently re-derive.
   */
  it("setMessageThread refuses to reassign a message that already has a thread", async () => {
    const w = await world();
    const [t1] = await w.db.insert(threads)
      .values({ accountId: w.accountId, subject: "One", rootMessageIdHeader: "one@x" }).returning();
    const [t2] = await w.db.insert(threads)
      .values({ accountId: w.accountId, subject: "Two", rootMessageIdHeader: "two@x" }).returning();
    const m = await seed(w, { id: "m@x", threadId: t1!.id });

    expect(await w.repo.setMessageThread(m, t2!.id)).toBe(false);
    expect(await threadOf(w, m)).toBe(t1!.id);

    // …and it DOES stamp one that has none, so the guard is not simply "never write".
    const fresh = await seed(w, { id: "fresh@x" });
    expect(await w.repo.setMessageThread(fresh, t2!.id)).toBe(true);
    expect(await threadOf(w, fresh)).toBe(t2!.id);
  });

  it("a message with no Message-ID and no chain gets its own anchorless thread", async () => {
    const w = await world();
    const one = await seed(w, { subject: "No id" });
    const two = await seed(w, { subject: "No id", date: new Date("2026-07-07T09:00:00Z") });
    await runThreadBackfill({ repo: w.repo, accountId: w.accountId });
    // NULLs are DISTINCT in the unique index, so two anchorless messages are two threads —
    // not one collapsed row, which is what a NULLS-NOT-DISTINCT index would have produced.
    expect(await threadOf(w, one)).not.toBe(await threadOf(w, two));
    const rows = await w.db.select().from(threads).where(eq(threads.accountId, w.accountId));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.rootMessageIdHeader === null)).toBe(true);
  });
});
