import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq, sql } from "drizzle-orm";
import { folderState, mailboxes, messages, recordChange, rules, tags, threads } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { syncService } from "@trafficflow/services";
import type { ServiceContext, SyncChange } from "@trafficflow/services";
import { ClientMirror, flatten } from "./_apply-harness.js";

/**
 * THE BOOTSTRAP READER'S FOURTH INVARIANT — **A SNAPSHOT THAT REPORTS `asOfSeq = N` MUST HAVE SEEN EVERY CHANGE ≤ N.**
 *
 * The client sets its delta cursor to `asOfSeq` and is therefore never told about anything at or
 * below it again. Report a seq the projection did not actually cover and that entity is missing
 * from the mirror **for ever** — silently, with a green suite, and only for an account that
 * happened to be written to during its bootstrap.
 *
 * ── WHY THIS CANNOT BE A PGlite TEST ─────────────────────────────────────────────────────────
 *
 * The property is about what a SECOND connection commits in the middle of a read, and
 * `makeTestDb()` is a single-connection PGlite: two awaited calls in one process are sequential
 * by construction there, so a PGlite version of this test could not fail. This repository has
 * been burned three times by exactly that gap.
 *
 * ── THE BARRIER, AND WHY IT IS A TABLE LOCK RATHER THAN A SLEEP ──────────────────────────────
 *
 * The race has to be driven, not waited for. `getSnapshot` reads, in order: the seq high water,
 * then the live state (rules first), then the message window. A writer that holds
 * `ACCESS EXCLUSIVE` on `messages` therefore parks the reader at a KNOWN point — after it has
 * read `rules`, before it has read a message — and the writer commits a NEW RULE exactly there.
 * No timing assumption: the reader's arrival at the barrier is observed in `pg_locks`.
 *
 * So the reader provably reads `rules` BEFORE the new rule commits. The only question left is
 * where its `asOfSeq` came from:
 *
 *   - Correct — the seq is read FIRST, so `asOfSeq` is the pre-commit high water. The new rule is
 *     above it and the delta from `asOfSeq` delivers it. The mirror converges.
 *   - Broken — move the seq read after the projection (which is the single most natural way to
 *     write this method) and `asOfSeq` becomes the POST-commit high water, while the rule set
 *     shipped beside it is the pre-commit one. The delta from `asOfSeq` has nothing to say and
 *     the rule is gone.
 *
 * MUTATION-WATCHED: moving the `highWaterSeq` call in `sync-service.ts#getSnapshot` from before
 * the live-state reads to after the message projection turns both assertions in the first case
 * red — the `asOfSeq` equality and the mirror convergence — and leaves every PGlite test in the
 * suite green.
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

const NOW = new Date("2026-08-07T12:00:00.000Z");
const DAY = 86_400_000;

const ctx = (accountId: string): ServiceContext => ({
  db: db as unknown as ServiceContext["db"], accountId, userId: null,
  now: () => NOW, requestId: "a1-seq",
});

async function seedAccount(): Promise<{ accountId: string; mailboxId: string }> {
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `a1-${accountId}@tf.example`,
  }).returning();
  return { accountId, mailboxId: mb!.id };
}

/** One committed message + its `change_log` create, the way the worker does it. */
async function commitMessage(
  accountId: string, mailboxId: string, date: Date, tag: string, threadId?: string,
): Promise<string> {
  return db.transaction(async (tx) => {
    const [m] = await tx.insert(messages).values({
      accountId, mailboxId, bodyHash: "h", dedupKey: `a1:${tag}`,
      subject: tag, fromAddress: "anna@x.example", date,
      nativeLocator: { folder: "INBOX", ref: `1:${tag}` },
      ...(threadId ? { threadId } : {}),
    }).returning();
    await tx.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us",
    });
    await recordChange(tx, {
      accountId, entityType: "message", entityId: m!.id, op: "create", meta: null,
    });
    return m!.id;
  });
}

/** Poll `pg_locks` until somebody is WAITING on `messages`, or give up. */
async function waitUntilBlockedOnMessages(timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await client<{ n: number }[]>`
      select count(*)::int as n from pg_locks
      where not granted and relation = 'messages'::regclass`;
    if ((row?.n ?? 0) > 0) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

describe.skipIf(!PG_UP)("asOfSeq under a concurrent commit (real Postgres)", () => {
  beforeAll(async () => {
    client = postgres(PG_TEST_URL, { max: 6 });
    db = brandDialect(drizzle(client, { schema }), "pg");
    await runMigrations(PG_TEST_URL);
  }, 120_000);

  afterAll(async () => { await client?.end({ timeout: 5 }); });

  it("a change that commits DURING the read is above asOfSeq, so the delta still delivers it", async () => {
    const { accountId, mailboxId } = await seedAccount();
    await commitMessage(accountId, mailboxId, new Date(NOW.getTime() - DAY), `early-${accountId}`);

    // The account's high water before anything races it. The snapshot must report exactly this.
    const [{ max: before }] = await client<{ max: string }[]>`
      select coalesce(max(seq), 0)::text as max from change_log where account_id = ${accountId}`;
    expect(before).toBe("1");

    let lateRuleId = "";
    let release = (): void => {};
    const mayCommit = new Promise<void>((r) => { release = r; });

    // ── The writer: parks the reader on `messages`, commits a rule the reader has already
    //    read past, and only then lets go.
    const writer = db.transaction(async (tx) => {
      await tx.execute(sql`lock table messages in access exclusive mode`);
      const [r] = await tx.insert(rules).values({
        accountId, kind: "sender", match: `late-${accountId}@x.example`, destination: "INBOX",
      }).returning();
      lateRuleId = r!.id;
      await recordChange(tx, {
        accountId, entityType: "rule", entityId: r!.id, op: "create", meta: null,
      });
      await mayCommit;
    });

    // ── The reader, which will block at the barrier after its `rules` read.
    const reading = syncService.getSnapshot(ctx(accountId), { limit: 100 });

    let blocked = false;
    try {
      blocked = await waitUntilBlockedOnMessages();
    } finally {
      // ALWAYS release, or a failure here wedges the whole file behind an open ACCESS EXCLUSIVE.
      release();
    }
    await writer;
    const snap = await reading;
    expect(blocked, "the reader never reached the barrier — the test proved nothing").toBe(true);

    // ── 1. The mechanism: the reported point is the PRE-commit high water.
    expect(snap.asOfSeq).toBe(1);

    // ── 2. The projection shipped beside it is the pre-commit one — which is fine, and is the
    //       whole reason 1 has to hold.
    expect(snap.changes.map((c) => c.id)).not.toContain(lateRuleId);

    // ── 3. THE USER-VISIBLE CLAIM: snapshot ∪ delta(asOfSeq) is complete. This is the assertion
    //       that fails if `asOfSeq` ever runs ahead of what the projection saw.
    const mirror = new ClientMirror();
    mirror.applyChanges(snap.changes as SyncChange[]);
    const delta = await syncService.getChanges(ctx(accountId), {
      since: syncService.encodeCursor(BigInt(snap.asOfSeq)), limit: 2000,
    });
    mirror.applyChanges(flatten(delta));
    expect(
      mirror.snapshot().has(`rule:${lateRuleId}`),
      "a rule committed during the snapshot is unreachable: asOfSeq ran ahead of the projection",
    ).toBe(true);
  }, 120_000);

  it("a snapshot DRAINED while the account is being written to still converges", async () => {
    // The barrier case pins one instant. This is the same invariant across a whole multi-page
    // drain with an unsynchronised writer running throughout — the shape a real bootstrap has.
    // New mail carries the NEWEST dates, so it lands at the FRONT of the newest-first keyset
    // window, past the cursor, and is therefore invisible to pages 2..n by construction. The
    // delta from `asOfSeq` is what makes that correct rather than lossy.
    const { accountId, mailboxId } = await seedAccount();
    // Threads and tags are part of a page's composition now, so they are part of what has to
    // survive the race: threads ride with the message page that names them (so a thread whose
    // messages straddle a page boundary is emitted more than once, at one seq), and every tag
    // is on page 1.
    const threadIds: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const [t] = await db.insert(threads).values({ accountId, subject: `thread ${i}` }).returning();
      threadIds.push(t!.id);
    }
    const [tagRow] = await db.insert(tags).values({ accountId, name: "Invoices", hue: "moss" }).returning();

    for (let i = 0; i < 40; i += 1) {
      await commitMessage(
        accountId, mailboxId, new Date(NOW.getTime() - (100 + i) * DAY), `seed-${accountId}-${i}`,
        threadIds[i % threadIds.length]!,
      );
    }

    let stop = false;
    const written: string[] = [];
    const writer = (async () => {
      for (let i = 0; i < 40 && !stop; i += 1) {
        written.push(await commitMessage(
          accountId, mailboxId, new Date(NOW.getTime() - i * 1000), `race-${accountId}-${i}`,
          threadIds[i % threadIds.length]!,
        ));
        await new Promise((r) => setTimeout(r, 3));
      }
    })();

    const mirror = new ClientMirror();
    let cursor: string | undefined;
    let asOfSeq = -1;
    for (let guard = 0; ; guard += 1) {
      const page = await syncService.getSnapshot(ctx(accountId), {
        limit: 5, ...(cursor ? { cursor } : {}),
      });
      // Every page of ONE snapshot reads at the same point, whatever committed between them.
      if (asOfSeq === -1) asOfSeq = page.asOfSeq; else expect(page.asOfSeq).toBe(asOfSeq);
      mirror.applyChanges(page.changes as SyncChange[]);
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
      if (guard > 500) throw new Error("snapshot drain did not terminate");
    }
    stop = true;
    await writer;

    // Drain the delta from the snapshot's point, exactly as a client does after bootstrapping.
    let since = syncService.encodeCursor(BigInt(asOfSeq));
    for (let guard = 0; ; guard += 1) {
      const page = await syncService.getChanges(ctx(accountId), { since, limit: 500 });
      mirror.applyChanges(flatten(page));
      since = page.cursor;
      if (!page.hasMore) break;
      if (guard > 500) throw new Error("delta drain did not terminate");
    }

    // EVERY message the database holds for this account is in the mirror. Not "most" — the whole
    // point of the invariant is that there is no window in which one goes missing.
    const rows = await db.select({ id: messages.id }).from(messages)
      .where(eq(messages.accountId, accountId));
    const live = mirror.snapshot();
    const missing = rows.map((r) => r.id).filter((id) => !live.has(`message:${id}`));
    expect(missing, `${missing.length} message(s) reachable by neither the snapshot nor the delta`)
      .toEqual([]);
    expect(rows.length).toBe(40 + written.length);

    // …and so is every THREAD and every TAG. Threads arrive only alongside the messages that
    // name them, so a lost page is a thread with no header; tags arrive once, on page 1, so a
    // dropped one is a rail that boots empty beside mail carrying its id.
    const missingThreads = threadIds.filter((id) => !live.has(`thread:${id}`));
    expect(missingThreads, "a thread the mirror's own messages point at is not in the mirror")
      .toEqual([]);
    expect(live.has(`tag:${tagRow!.id}`), "the tag rail would boot empty").toBe(true);

    // Each thread DTO is built from THE THREAD's messages, never from the page's — so it is
    // never a one-message stub just because the page that carried it held one of its messages.
    //
    // It is NOT asserted to be up to the minute, and that is a real distinction rather than a
    // weakened assertion: `commitMessage` records a `message` change and no `thread` change, so
    // nothing tells the delta a thread moved and a DTO captured on page 1 legitimately predates
    // messages committed after it. Freshness there is the ingest path's job (it must record the
    // thread change), not the snapshot's. What the snapshot owns is that every id it publishes
    // is a real message of this account, which is what is checked.
    const realIds = new Set(rows.map((r) => r.id));
    for (const id of threadIds) {
      const dto = live.get(`thread:${id}`) as { messageIds: string[] };
      expect(dto.messageIds.length, `thread ${id} came back as a stub`).toBeGreaterThan(1);
      expect(dto.messageIds.every((m) => realIds.has(m)), "a thread names a message that is not this account's").toBe(true);
    }
  }, 180_000);
});
