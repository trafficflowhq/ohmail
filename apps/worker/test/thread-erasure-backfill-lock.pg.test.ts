import { accountOfMessage } from "@trafficflow/db";
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  accounts, mailboxes, messageBodies, messages, threads,
  ACCOUNT_THREAD_STRUCTURE_LOCK_CLASS, type Tx,
} from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { deleteAccount } from "@trafficflow/services";
import { runThreadBackfill } from "../src/thread-backfill.js";

/**
 * THE ERASURE / BACKFILL LOCK CYCLE, AGAINST REAL POSTGRES — round-8/9/10 review findings.
 *
 * ── THE SHAPE ───────────────────────────────────────────────────────────────────────────────
 *
 * Account erasure's DELETE order is forced child-before-parent by the schema's own FKs
 * (`messages` before `threads`), so its structural fence locks every `threads` row for the
 * account FIRST, then later touches `messages` rows. The thread backfill locks an UNTHREADED
 * `messages` row first (`listThreadBacklog`, `FOR UPDATE OF messages`) — there is no `threads`
 * row yet to lock ahead of it — and only then locks/creates the `threads` row it resolves to
 * (`resolveThread`). Interleaved on the SAME account, that is a genuine lock cycle: erasure
 * holds the thread and waits on the message; backfill holds the message and waits on the
 * thread. Postgres detects it and aborts one side with `40P01`.
 *
 * `ACCOUNT_THREAD_STRUCTURE_LOCK_CLASS` (`packages/db/src/schema-mail.ts`) is the fix: both
 * `deleteAccount` and `runThreadBackfill` take `pg_advisory_xact_lock(class, hashtext(account))`
 * BEFORE either path's first row lock, so the two structural sections can never interleave —
 * whichever arrives first runs to completion before the other's row-level locking begins.
 *
 * ── FOUR COMPLEMENTARY TESTS, AFTER THREE ROUNDS OF REVIEW ─────────────────────────────────
 *
 *  1. RAW-SQL FIXTURE: the two lock orders, reproduced faithfully, with a TWO-WAY handshake —
 *     the driver confirms erasure holds the thread lock, THEN confirms backfill holds the
 *     message lock and is genuinely blocked on the thread, and only THEN releases erasure to
 *     reach for the message. Nothing here depends on wall-clock timing: every step is gated on
 *     an actual, polled database lock state, so the cycle either forms because both sides
 *     provably hold what the real code paths would hold, or it does not form at all.
 *  2. SOURCE GUARD: a text scan asserting BOTH production call sites take the shared lock
 *     BEFORE their first row lock — mechanical, fails the instant either call is removed or
 *     reordered, matched against the actual call site (not the constant's name, which also
 *     appears in an import line and would false-pass a removed call).
 *  3. REAL-FUNCTION CONCURRENCY, ON A GENUINELY SHARED THREAD: `deleteAccount` and
 *     `runThreadBackfill` — the actual exported functions — race over an account whose backlog
 *     message's headers name the SAME thread erasure is about to delete (a real
 *     `message_bodies.headers` row with `in-reply-to` naming the seeded thread's root message,
 *     so `resolveThread`'s header-chain lookup finds and joins the existing thread rather than
 *     creating an unrelated new one — without this, the two paths touch disjoint rows and no
 *     guard, present or absent, could make them collide). `beforePageLock` nudges the backfill
 *     side to start its transaction just after erasure's, raising the odds of real overlap;
 *     repeated eight times. Best-effort concurrency, not the deterministic proof — that is
 *     test 1 — but on data the guard can actually be tested against.
 */

const AVAILABLE = await realPgAvailable();
const ROOT = fileURLToPath(new URL("..", import.meta.url));

describe.skipIf(!AVAILABLE)("the erasure/backfill lock cycle", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    // Several independent connections, or "concurrent" work queues in the pool and the test
    // proves nothing about the database (the reason thread-backfill.pg.test.ts also needs it).
    sql = postgres(PG_TEST_URL, { max: 8, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg");
  }, 120_000);

  async function seed(): Promise<{ accountId: string; threadId: string; messageId: string }> {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `lock-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: "owner@own.example",
    }).returning({ id: mailboxes.id });
    const [t] = await db.insert(threads).values({
      accountId, subject: "Race", rootMessageIdHeader: `${randomUUID()}@seed.example`,
    }).returning({ id: threads.id });
    // The message erasure will eventually touch: threaded, on the target thread.
    await db.insert(messages).values({
      accountId, mailboxId: mb!.id, threadId: t!.id,
      messageIdHeader: `${randomUUID()}@seed.example`, bodyHash: "h", dedupKey: randomUUID(),
      subject: "Race", fromAddress: "owner@own.example",
    });
    // The message the backfill locks FIRST: UNTHREADED, standing in for a backlog row.
    const [backlog] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, threadId: null,
      messageIdHeader: `${randomUUID()}@seed.example`, bodyHash: "h2", dedupKey: randomUUID(),
      subject: "Race", fromAddress: "someone@partner.example",
    }).returning({ id: messages.id });
    return { accountId, threadId: t!.id, messageId: backlog!.id };
  }

  // ── DB-OBSERVABLE BARRIERS, NOT SLEEP GUESSES ─────────────────────────────────────────────
  //
  // Two independent advisory-lock keys, each taken (xact-scoped, by a participant) right after
  // the real lock it stands in for, and each polled (`pg_try_advisory_lock`, non-blocking, from
  // an unrelated connection) by the driver until the poll FAILS — which happens exactly when,
  // and only when, that participant's session is holding it. A THIRD key is the driver's own
  // gate: held by the driver from the start, released only once BOTH participants are proven to
  // be holding their real lock and waiting on the other's — at which point releasing it lets
  // erasure proceed into the genuine, two-way, database-detected cycle.
  const THREAD_HELD = 909_090_001;
  const MESSAGE_HELD = 909_090_002;
  const GATE = 909_090_003;

  // ONE reserved connection for the whole poll: a session-level `pg_try_advisory_lock` and
  // its matching `pg_advisory_unlock` must run on the SAME physical backend, or the unlock
  // targets a session that never took the lock, the lock LEAKS onto whatever connection did
  // acquire it, and that connection silently carries a phantom lock back into the pool.
  async function waitUntilHeld(key: number, accountId: string): Promise<void> {
    const poller = await sql.reserve();
    try {
      for (;;) {
        const [row] = await poller`select pg_try_advisory_lock(${key}, hashtext(${accountId})) as got`;
        if (!row!.got) return; // held elsewhere ⇒ the participant has reached that point
        await poller`select pg_advisory_unlock(${key}, hashtext(${accountId}))`;
        await new Promise((r) => setTimeout(r, 5));
      }
    } finally {
      poller.release();
    }
  }

  it("UNGUARDED: the two real lock orders genuinely deadlock — proven with a two-way handshake, not a timer", async () => {
    const { accountId, threadId, messageId } = await seed();
    const gate = await sql.reserve();
    await gate`select pg_advisory_lock(${GATE}, hashtext(${accountId}))`;

    const erasure = sql.begin(async (t) => {
      await t`select id from threads where account_id = ${accountId}::uuid for update`;
      await t`select pg_advisory_xact_lock(${THREAD_HELD}, hashtext(${accountId}))`;
      // Blocks until the driver releases GATE below — which it does only once backfill is
      // PROVEN to hold the message row and be waiting on this very thread lock.
      await t`select pg_advisory_xact_lock(${GATE}, hashtext(${accountId}))`;
      await t`delete from messages where account_id = ${accountId}::uuid`;
      await t`delete from threads where id = ${threadId}::uuid`;
    });
    await waitUntilHeld(THREAD_HELD, accountId); // erasure provably holds the thread lock

    const backfill = sql.begin(async (t) => {
      await t`select id from messages where id = ${messageId}::uuid for update`;
      await t`select pg_advisory_xact_lock(${MESSAGE_HELD}, hashtext(${accountId}))`;
      // Blocks on the thread erasure is holding — the other half of the cycle.
      await t`select id from threads where id = ${threadId}::uuid for update`;
      await t`update messages set thread_id = ${threadId}::uuid where id = ${messageId}::uuid`;
    });
    await waitUntilHeld(MESSAGE_HELD, accountId); // backfill provably holds the message AND is
                                                    // now blocked on the thread (its next
                                                    // statement cannot return until it is)

    // Both sides are now genuinely waiting on each other. Releasing the gate lets erasure
    // reach for the message backfill holds — the cycle closes here, in the database.
    await gate`select pg_advisory_unlock(${GATE}, hashtext(${accountId}))`;
    await gate.release();

    const results = await Promise.allSettled([erasure, backfill]);
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0]!.reason)).toMatch(/deadlock detected|40P01/);
  }, 20_000);

  it("GUARDED: both taking the shared advisory lock first removes the cycle — no deadlock, ever", async () => {
    // Five seeds, run back to back: a cycle that is possible does not always fire on the first
    // try, and this protocol claims it is IMPOSSIBLE, not merely unlikely. The guarded case
    // does not need the two-way handshake above: with the shared lock held first, the loser
    // queues at that single statement and never reaches its row-level lock at all, so a
    // same-order start is sufficient to exercise it.
    for (let i = 0; i < 5; i++) {
      const { accountId, threadId, messageId } = await seed();
      const erasure = sql.begin(async (t) => {
        await t`select pg_advisory_xact_lock(${ACCOUNT_THREAD_STRUCTURE_LOCK_CLASS}, hashtext(${accountId}))`;
        await t`select id from threads where account_id = ${accountId}::uuid for update`;
        await t`select pg_advisory_xact_lock(${THREAD_HELD}, hashtext(${accountId}))`;
        await t`select pg_sleep(0.1)`;
        await t`delete from messages where account_id = ${accountId}::uuid`;
        await t`delete from threads where id = ${threadId}::uuid`;
      });
      await waitUntilHeld(THREAD_HELD, accountId);
      const backfill = sql.begin(async (t) => {
        await t`select pg_advisory_xact_lock(${ACCOUNT_THREAD_STRUCTURE_LOCK_CLASS}, hashtext(${accountId}))`;
        await t`select id from messages where id = ${messageId}::uuid for update`;
        await t`select id from threads where id = ${threadId}::uuid for update`;
        await t`update messages set thread_id = ${threadId}::uuid where id = ${messageId}::uuid`;
      });
      const results = await Promise.allSettled([erasure, backfill]);
      const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      expect(rejected).toHaveLength(0);
    }
  }, 20_000);

  it("SOURCE GUARD: both production call sites take the shared lock before their first row lock", () => {
    // Mechanical, not behavioral — the same reason `every-pass-has-a-producer.test.ts` scans
    // source rather than running it: this property is about the SHAPE of the program, and it
    // must fail the instant either call is deleted or reordered, independent of any runtime
    // race actually firing on this particular run.
    const erasureSrc = readFileSync(`${ROOT}/../../packages/services/src/account-deletion-service.ts`, "utf8");
    const fnStart = erasureSrc.indexOf("export async function deleteAccount");
    // The ACTUAL CALL, not a mention — the constant's name also appears in this file's import
    // statement, which sits before `fnStart` but proves nothing about what the function does.
    const lockCall = "pg_advisory_xact_lock(${ACCOUNT_THREAD_STRUCTURE_LOCK_CLASS}";
    const firstThreadLock = "threads.id }).from(threads)";
    const lockAt = erasureSrc.indexOf(lockCall, fnStart);
    const threadLockAt = erasureSrc.indexOf(firstThreadLock, fnStart);
    expect(lockAt, "deleteAccount must call the shared advisory lock").toBeGreaterThan(-1);
    expect(threadLockAt, "deleteAccount must still take its thread-first fence").toBeGreaterThan(-1);
    expect(lockAt, "the advisory lock must be taken BEFORE the thread-first fence").toBeLessThan(threadLockAt);

    const backfillSrc = readFileSync(`${ROOT}/src/thread-backfill.ts`, "utf8");
    const backfillLockAt = backfillSrc.indexOf("tx.lockAccountThreadStructure(accountId)");
    const backlogAt = backfillSrc.indexOf("tx.listThreadBacklog(accountId");
    expect(backfillLockAt, "runThreadBackfill must call lockAccountThreadStructure").toBeGreaterThan(-1);
    expect(backlogAt, "runThreadBackfill must still list the backlog").toBeGreaterThan(-1);
    expect(backfillLockAt, "the lock must be taken BEFORE the backlog is read").toBeLessThan(backlogAt);
  });

  it("REAL FUNCTIONS: deleteAccount and runThreadBackfill race over a SHARED thread and never throw", async () => {
    for (let i = 0; i < 8; i++) {
      const accountId = randomUUID();
      await db.insert(accounts).values({ id: accountId, name: `real-${accountId.slice(0, 8)}` });
      const [mb] = await db.insert(mailboxes).values({
        accountId, provider: "imap", address: "owner@own.example",
      }).returning({ id: mailboxes.id });
      const rootMid = `${randomUUID()}@seed.example`;
      const [t] = await db.insert(threads).values({
        accountId, subject: "Real race", rootMessageIdHeader: rootMid,
      }).returning({ id: threads.id });
      const [rootMsg] = await db.insert(messages).values({
        accountId, mailboxId: mb!.id, threadId: t!.id,
        messageIdHeader: rootMid, bodyHash: "h", dedupKey: randomUUID(),
        subject: "Real race", fromAddress: "owner@own.example",
      }).returning({ id: messages.id });
      // The backlog message's REAL headers name the seeded thread's root Message-ID, so the
      // real `resolveThread` finds and JOINS that existing thread — the one property the
      // previous round's seed was missing, and the reason removing the guard could not have
      // failed this test even in principle: two paths touching disjoint rows never collide.
      const [backlog] = await db.insert(messages).values({
        accountId, mailboxId: mb!.id, threadId: null,
        messageIdHeader: `${randomUUID()}@seed.example`, bodyHash: "h2", dedupKey: randomUUID(),
        subject: "Real race", fromAddress: "someone@partner.example",
      }).returning({ id: messages.id });
      await db.insert(messageBodies).values({
        messageId: backlog!.id, accountId: accountOfMessage(backlog!.id), headers: { "in-reply-to": [`<${rootMid}>`] },
      });

      const repo = makeDrizzleRepo(db as unknown as Tx);
      // Nudges the two starts closer together — best-effort, not the deterministic proof (test
      // 1 owns that): production `deleteAccount` has no pause seam to hold it open precisely,
      // so this raises the odds of real overlap rather than guaranteeing it.
      const backfillCall = runThreadBackfill({
        repo, accountId,
        beforePageLock: () => new Promise((r) => setTimeout(r, 5)),
      });
      const erasureCall = deleteAccount({
        db: db as unknown as Tx, accountId, userId: null, now: () => new Date(),
        requestId: `test-${i}`,
      } as Parameters<typeof deleteAccount>[0]);

      await expect(Promise.all([backfillCall, erasureCall])).resolves.toBeDefined();
      void rootMsg;
    }
  }, 30_000);
});
