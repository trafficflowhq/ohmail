import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq } from "drizzle-orm";
import { folderState, mailboxes, messages, recordChange } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { syncService } from "@trafficflow/services";
import type { ServiceContext, SyncChange } from "@trafficflow/services";
import { ClientMirror, flatten } from "./_apply-harness.js";

/**
 * THE CURSOR CEILING ON REAL POSTGRES — the race posture, and the recovery it enables.
 *
 * `sync-service.test.ts` pins the SHAPE of the answer on PGlite: a cursor above the account's
 * highest committed seq is a 410 rather than a 200 with an empty delta. Two things it cannot
 * pin, both of them about a second connection:
 *
 *  1. **NO FALSE 410 UNDER CONCURRENT WRITES.** The ceiling is read in a statement of its own,
 *     not in a transaction with the page read that follows it. That is a deliberate choice —
 *     serializing every reader against every writer on the account would cost far more than it
 *     buys — and it is only correct because the race can only run in the SAFE direction: a
 *     commit between the two reads RAISES `max`, which can turn a would-be 410 into a plain
 *     empty 200 (self-healing on the next poll) and never the reverse. A false 410 would need
 *     `max(seq)` to move backwards, which nothing in the product does. PGlite is a single
 *     connection, so two awaited calls there are sequential by construction and this assertion
 *     would be vacuous.
 *
 *  2. **THE FULL RECOVERY: 410 → re-snapshot → fresh cursor → converged**, against a log a
 *     writer is still appending to. That is the whole reason 410 is the right answer rather
 *     than, say, clamping the cursor down to `max`: the client already knows how to act on it.
 *
 * MUTATION-WATCHED: remove the `maxSeq == null || sinceSeq > maxSeq` arm in
 * `sync-service.ts#getChanges` and the first case turns red with an OK answer carrying an empty delta,
 * followed by an empty page on every subsequent poll — the production symptom, reproduced.
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

const NOW = new Date("2026-08-11T12:00:00.000Z");
const DAY = 86_400_000;

const ctx = (accountId: string): ServiceContext => ({
  db: db as unknown as ServiceContext["db"], accountId, userId: null,
  now: () => NOW, requestId: "cursor-ceiling",
});

async function seedAccount(): Promise<{ accountId: string; mailboxId: string }> {
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `ceiling-${accountId}@tf.example`,
  }).returning();
  return { accountId, mailboxId: mb!.id };
}

/** One committed message + its `change_log` create, the way the worker does it. */
async function commitMessage(
  accountId: string, mailboxId: string, date: Date, tag: string,
): Promise<string> {
  return db.transaction(async (tx) => {
    const [m] = await tx.insert(messages).values({
      accountId, mailboxId, bodyHash: "h", dedupKey: `ceiling:${tag}`,
      subject: tag, fromAddress: "anna@x.example", date,
      nativeLocator: { folder: "INBOX", ref: `1:${tag}` },
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

describe.skipIf(!PG_UP)("the /sync cursor ceiling (real Postgres)", () => {
  beforeAll(async () => {
    client = postgres(PG_TEST_URL, { max: 6 });
    db = brandDialect(drizzle(client, { schema }), "pg");
    await runMigrations(PG_TEST_URL);
  }, 120_000);

  afterAll(async () => { await client?.end({ timeout: 5 }); });

  it("a cursor above max 410s, and the client's 410 recovery converges on a live account", async () => {
    const { accountId, mailboxId } = await seedAccount();
    const seeded: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      seeded.push(await commitMessage(accountId, mailboxId, new Date(NOW.getTime() - i * DAY), `seed-${accountId}-${i}`));
    }

    // ── The incident, reproduced: a mirror whose cursor sits far above the account's log.
    //    Before the ceiling check this answered 200 with an empty delta, on every poll, for ever.
    const ahead = syncService.encodeCursor(2173n);
    await expect(syncService.getChanges(ctx(accountId), { since: ahead })).rejects.toMatchObject({
      code: "cursor_expired", httpStatus: 410,
    });

    // ── What the client does with that answer (`OhmailEngine.drain`, and the sidecar mirror's
    //    `drainSync`): discard, re-snapshot, adopt `asOfSeq`, resume the delta. A writer keeps
    //    committing throughout, so the recovery is exercised against a MOVING log rather than a
    //    frozen one — a cursor that healed only on a quiet account would heal on no real one.
    let stop = false;
    const written: string[] = [];
    const writer = (async () => {
      for (let i = 0; i < 20 && !stop; i += 1) {
        written.push(await commitMessage(
          accountId, mailboxId, new Date(NOW.getTime() + i * 1000), `race-${accountId}-${i}`,
        ));
        await new Promise((r) => setTimeout(r, 3));
      }
    })();

    const mirror = new ClientMirror();
    let pageCursor: string | undefined;
    let asOfSeq = -1;
    for (let guard = 0; ; guard += 1) {
      const page = await syncService.getSnapshot(ctx(accountId), {
        limit: 5, ...(pageCursor ? { cursor: pageCursor } : {}),
      });
      if (asOfSeq === -1) asOfSeq = page.asOfSeq;
      mirror.applyChanges(page.changes as SyncChange[]);
      if (page.nextCursor === null) break;
      pageCursor = page.nextCursor;
      if (guard > 500) throw new Error("snapshot drain did not terminate");
    }
    stop = true;
    await writer;

    // The fresh cursor is a REAL position in this account's log, not the fiction it replaced.
    expect(asOfSeq).toBeGreaterThan(0);

    let since = syncService.encodeCursor(BigInt(asOfSeq));
    for (let guard = 0; ; guard += 1) {
      const page = await syncService.getChanges(ctx(accountId), { since, limit: 500 });
      mirror.applyChanges(flatten(page));
      since = page.cursor;
      if (!page.hasMore) break;
      if (guard > 500) throw new Error("delta drain did not terminate");
    }

    const rows = await db.select({ id: messages.id }).from(messages)
      .where(eq(messages.accountId, accountId));
    const live = mirror.snapshot();
    const missing = rows.map((r) => r.id).filter((id) => !live.has(`message:${id}`));
    expect(missing, `${missing.length} message(s) never reached the re-bootstrapped mirror`).toEqual([]);
    expect(rows.length).toBe(seeded.length + written.length);

    // …and the healed cursor keeps working: the steady-state poll is an empty 200, not a 410.
    const idle = await syncService.getChanges(ctx(accountId), { since });
    expect(flatten(idle)).toHaveLength(0);
    expect(idle.cursor).toBe(since);
  }, 180_000);

  it("a writer committing THROUGHOUT never turns a healthy cursor into a 410", async () => {
    const { accountId, mailboxId } = await seedAccount();
    await commitMessage(accountId, mailboxId, new Date(NOW.getTime() - DAY), `warm-${accountId}`);

    // A second connection appending without pause, exactly across the window between the
    // ceiling read and the page read. Any false 410 in that window is a client that throws its
    // whole mirror away and re-bootstraps for no reason — on the BUSIEST accounts by
    // construction, which is the population that can least afford it.
    let stop = false;
    let writing = true;
    const writer = (async () => {
      try {
        for (let i = 0; i < 150 && !stop; i += 1) {
          await commitMessage(accountId, mailboxId, new Date(NOW.getTime() + i * 1000), `churn-${accountId}-${i}`);
        }
      } finally {
        writing = false;
      }
    })();

    let cursor = syncService.encodeCursor(0n);
    let polls = 0;
    try {
      const deadline = Date.now() + 30_000;
      while (writing && Date.now() < deadline) {
        // Poll from the cursor of record — which after the first drain is exactly `max` at the
        // instant it was read, i.e. the value most likely to be caught out by a concurrent write.
        const page = await syncService.getChanges(ctx(accountId), { since: cursor, limit: 500 });
        cursor = page.cursor;
        polls += 1;
      }
    } finally {
      stop = true;
      await writer;
    }
    expect(polls, "the poll loop never ran — the race was not exercised").toBeGreaterThan(5);

    // Drain to the horizon and confirm the mirror is complete: not-410 is only worth something
    // if the pages were right.
    const mirror = new ClientMirror();
    let since = syncService.encodeCursor(0n);
    for (let guard = 0; ; guard += 1) {
      const page = await syncService.getChanges(ctx(accountId), { since, limit: 500 });
      mirror.applyChanges(flatten(page));
      since = page.cursor;
      if (!page.hasMore) break;
      if (guard > 500) throw new Error("delta drain did not terminate");
    }
    const rows = await db.select({ id: messages.id }).from(messages)
      .where(eq(messages.accountId, accountId));
    const live = mirror.snapshot();
    expect(rows.map((r) => r.id).filter((id) => !live.has(`message:${id}`))).toEqual([]);
  }, 180_000);
});
