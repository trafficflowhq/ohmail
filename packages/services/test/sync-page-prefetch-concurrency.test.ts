import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import { POOLED_MAX_CONNECTIONS } from "@trafficflow/db/cloud";
import { folderState, mailboxes, messages, recordChange, type EntityType } from "@trafficflow/db";
import { SyncService, type ServiceContext } from "../src/index.js";
import { PREFETCH_CONCURRENCY } from "../src/sync-service.js";

/**
 * A MIXED CHANGE PAGE ASKS ITS PREFETCHES TOGETHER, NEVER MORE AT ONCE THAN THE POOL HOLDS.
 *
 * `getChanges` awaited up to eight entity prefetches one after another — a page after a settings,
 * rule or tag edit paid eight serial round trips before the client saw its delta. They read only
 * the page's own ids, so they run together, at most {@link PREFETCH_CONCURRENCY} in flight, which
 * is the pooled handle's connection count. Counted at the store's client door, where every
 * statement arrives: the peak in flight, and the total, which the concurrency must not change.
 */

type Db = Awaited<ReturnType<typeof makeTestDb>>;
interface Doors { query: (...a: unknown[]) => Promise<unknown>; exec: (...a: unknown[]) => Promise<unknown> }

/** The peak number of statements in flight at the client door, and how many arrived. */
function inFlight(db: Db): { on: () => void; off: () => { peak: number; total: number } } {
  const client = (db as unknown as { $client: Doors }).$client;
  let counting = false;
  let now = 0;
  let peak = 0;
  let total = 0;
  for (const door of ["query", "exec"] as const) {
    const inner = client[door].bind(client);
    client[door] = async (...a: unknown[]): Promise<unknown> => {
      if (!counting) return inner(...(a as []));
      total += 1;
      now += 1;
      peak = Math.max(peak, now);
      try { return await inner(...(a as [])); } finally { now -= 1; }
    };
  }
  return {
    on: () => { counting = true; now = 0; peak = 0; total = 0; },
    off: () => { counting = false; return { peak, total }; },
  };
}

describe("the /sync page's prefetches", () => {
  it("run together on a mixed page, bounded by the pool, at the same statement count", async () => {
    expect(PREFETCH_CONCURRENCY, "the bound is wider than the pooled handle").toBeLessThanOrEqual(POOLED_MAX_CONNECTIONS);
    expect(PREFETCH_CONCURRENCY).toBeGreaterThan(1);

    const db = await makeTestDb();
    const accountId = randomUUID();
    const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: "a@x.example" }).returning();
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: randomUUID(), subject: "s", fromAddress: "f@x.example",
    }).returning();
    await db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us",
    });
    const rec = (entityType: EntityType, entityId: string) =>
      db.transaction((tx) => recordChange(tx as never, { accountId, entityType, entityId, op: "create" }));
    // One row of every prefetched type: a live message, and ids nothing owns for the rest.
    await rec("message", m!.id);
    const gone: EntityType[] = ["thread", "folder", "message_state", "routing_decision", "approval", "rule", "draft", "tag"];
    for (const type of gone) await rec(type, randomUUID());

    const ctx: ServiceContext = {
      db, accountId, userId: null, now: () => new Date("2026-09-26T00:00:00.000Z"), requestId: "prefetch",
    };
    const probe = inFlight(db);
    probe.on();
    const page = await new SyncService().getChanges(ctx, {});
    const { peak, total } = probe.off();

    // THE ANSWER: the live message, and a tombstone for each id nothing owns.
    expect(page.changes.creates.map((c) => c.id)).toEqual([m!.id]);
    expect(page.changes.deletes.map((c) => c.type).sort()).toEqual([...gone].sort());

    expect(peak, "the prefetches ran one after another").toBe(PREFETCH_CONCURRENCY);
    /* The page's statements, unchanged by running them together: the page read, the message
       prefetch's two, the folder flag, and one read per other type present. */
    expect(total, "the concurrency changed what the page asks").toBe(PAGE_STATEMENTS);
  });
});

/** Measured on the sequential shape before the change; the concurrent one asks the same. */
const PAGE_STATEMENTS = 11;
