import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, asc, eq } from "drizzle-orm";
import { mailboxes, messages, folderState, changeLog, recordChange } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { syncService } from "@trafficflow/services";
import type { ServiceContext } from "@trafficflow/services";
// The adapter's own ordering function, so this test asserts against the RULE the worker will
// actually apply rather than against a copy of it. Lives in `packages/services/test` only
// because `packages/core` does not depend on `postgres`.
import { orderCandidates } from "@trafficflow/core/adapters/imap";
import { pgTestUrl } from "@trafficflow/db/testing";

/**
 * THE LINK THE WHOLE SLICE RESTS ON, ON REAL POSTGRES.
 *
 * `fetchCapped` now orders the backfill by arrival date. That only reaches the user because of
 * a chain nothing tested end to end: the worker commits `batch.creates` IN ARRAY ORDER
 * (`apps/worker/src/sync.ts`), each commit allocates the next `change_log.seq`, and `/sync`
 * reads the log ascending by seq. If any link were order-free, the adapter's sort would be
 * decoration.
 *
 * ── WHY THIS CANNOT BE A PGlite TEST ────────────────────────────────────────────────────
 *
 * `allocateSeq` takes the account's `account_sync_state` ROW LOCK, and gap-free-ness under a
 * second concurrent writer is the property being asserted alongside the ordering. PGlite has
 * been blind to three production bugs in exactly this area. The "Delta-first client contract" invariant requires `change_log.seq`
 * to stay per-account and gap-free, and the brief forbids reordering or renumbering it —
 * so this test also pins that the fix did NOT do either: the ordering is chosen BEFORE the
 * seqs are allocated, and the seqs themselves are still a dense 1..N.
 */
const URL = pgTestUrl(import.meta.url);
const client = postgres(URL, { max: 5 });
const db = brandDialect(drizzle(client, { schema }), "pg");

const NOW = new Date("2026-08-04T12:00:00.000Z");
const A = randomUUID();
const B = randomUUID();          // a second account, allocating concurrently
let mailboxId = "";

/** uid → the day its Date: header carries. Deliberately uncorrelated with the uid. */
const DAY_OF = (uid: number): number => (uid * 7919) % 3000;
const UIDS = Array.from({ length: 40 }, (_, i) => i + 1);

function ctx(accountId: string): ServiceContext {
  return { db, accountId, userId: null, now: () => NOW, requestId: "o5-order" };
}

describe("the adapter's ingest order IS the order /sync delivers (real Postgres)", () => {
  beforeAll(async () => {
    await runMigrations(URL);
    const [mb] = await db.insert(mailboxes).values({
      accountId: A, provider: "imap", address: `o5-order-${A}@tf.example`,
    }).returning();
    mailboxId = mb!.id;
  }, 120_000);

  afterAll(async () => { await client.end({ timeout: 5 }); });

  it("commits in the adapter's order, and /sync page 1 is therefore the NEWEST mail", async () => {
    // The ordering decision the adapter makes, made here by the same function.
    const dates = new Map(UIDS.map((u) => [u, Date.UTC(2020, 0, 1) + DAY_OF(u) * 86_400_000]));
    const ordered = orderCandidates(UIDS, dates);

    // Sanity: the input really is pathological — uid order is NOT date order.
    const byUidDesc = [...UIDS].sort((a, b) => b - a);
    expect(ordered).not.toEqual(byUidDesc);

    // The worker's loop: one short transaction per create, in array order (sync.ts:278).
    // A SECOND account allocates seqs concurrently throughout, so the row lock is contended.
    const noise = (async () => {
      for (let i = 0; i < 40; i++) {
        await db.transaction((tx) => recordChange(tx, {
          accountId: B, entityType: "message", entityId: randomUUID(), op: "create", meta: null,
        }));
      }
    })();

    const uidOfMessage = new Map<string, number>();
    for (const uid of ordered) {
      await db.transaction(async (tx) => {
        const [m] = await tx.insert(messages).values({
          accountId: A, mailboxId, bodyHash: "h", dedupKey: `o5-order:${uid}`,
          subject: `uid ${uid}`, fromAddress: "anna@x.example",
          date: new Date(dates.get(uid)!),
          nativeLocator: { folder: "INBOX", ref: `1:${uid}` },
        }).returning();
        await tx.insert(folderState).values({
          messageId: m!.id, accountId: m!.accountId, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us",
        });
        uidOfMessage.set(m!.id, uid);
        await recordChange(tx, {
          accountId: A, entityType: "message", entityId: m!.id, op: "create", meta: null,
        });
      });
    }
    await noise;

    // ── 1. change_log ascending by seq == the order the adapter yielded ────────────────────
    const rows = await db.select().from(changeLog)
      .where(and(eq(changeLog.accountId, A), eq(changeLog.entityType, "message")))
      .orderBy(asc(changeLog.seq));
    expect(rows.map((r) => uidOfMessage.get(r.entityId)!)).toEqual(ordered);

    // ── 2. seq is still a dense 1..N for this account — the "Delta-first client contract" invariant, not renumbered ──────────
    const seqs = rows.map((r) => Number(r.seq)).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: UIDS.length }, (_, i) => i + 1));
    // …and the other account's concurrent allocations are its own dense 1..N, unaffected.
    const bRows = await db.select().from(changeLog)
      .where(eq(changeLog.accountId, B)).orderBy(asc(changeLog.seq));
    expect(bRows.map((r) => Number(r.seq))).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));

    // ── 3. THE USER-VISIBLE CLAIM: page 1 of the bootstrap is the newest mail ─────────────
    const page1 = await syncService.getChanges(ctx(A), { since: "0", limit: 10 });
    const delivered = page1.changes.creates.map((c) => (c.entity as { date: string }).date);
    const newestTen = [...UIDS]
      .sort((a, b) => dates.get(b)! - dates.get(a)!)
      .slice(0, 10)
      .map((u) => new Date(dates.get(u)!).toISOString());
    expect(new Set(delivered)).toEqual(new Set(newestTen));

    // And the control: under the OLD uid-descending order the same page would have carried a
    // different set — so the assertion above is about the ordering and not about arithmetic.
    const oldPage1 = byUidDesc.slice(0, 10).map((u) => new Date(dates.get(u)!).toISOString());
    expect(new Set(oldPage1)).not.toEqual(new Set(newestTen));
  }, 300_000);
});
