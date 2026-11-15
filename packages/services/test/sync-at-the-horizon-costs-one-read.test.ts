import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import { folderState, mailboxes, messages, recordChange } from "@trafficflow/db";
import { SyncService, type ServiceContext } from "../src/index.js";

/**
 * ═══ A WINDOW THAT IS UP TO DATE ASKS ONCE ══════════════════════════════════════════════════
 *
 * `A-POLLED-LIST-HAS-NO-CHEAP-UNCHANGED-ANSWER` measured nearly every one of a window's polls coming
 * back byte-identical to the poll before it. For the delta reader that answer is not merely
 * predictable, it is DERIVABLE from a read the handler already takes: `getChanges` reads
 * `seqBounds` for its 410 window before anything else, and a cursor equal to `max` selects the
 * rows above itself — of which there are none. So the page query is asked for an answer the
 * bounds already gave.
 *
 * ── WHY THIS IS AN IDENTITY AND NOT A 304 ───────────────────────────────────────────────────
 *
 * A 304 rests on a validator, and a validator some writer forgets to bump is a stale list shown
 * as current. Nothing is being trusted here: the empty answer is a function of the change rows
 * above the cursor, and the bounds read says there are none. What the identity DOES need is that
 * no row at or below that max can appear afterwards — held by the counter row lock inside the
 * writing transaction, and driven at
 * `packages/db/test/change-log-seq-is-commit-order.pg.test.ts` with two overlapping writers.
 *
 * ── WATCHED FAILING ─────────────────────────────────────────────────────────────────────────
 *
 * Delete the `sinceSeq === maxSeq` early return in `sync-service.ts#getChanges` and the count
 * below goes to three: the page query runs to find the nothing the bounds already reported.
 */

type Db = Awaited<ReturnType<typeof makeTestDb>>;
interface Doors { query: (...a: unknown[]) => Promise<unknown>; exec: (...a: unknown[]) => Promise<unknown> }

async function setup() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: "a@x.example" }).returning();
  const ctx: ServiceContext = {
    db, accountId, userId: null,
    now: () => new Date("2026-09-16T00:00:00.000Z"), requestId: "r",
  };
  return { db, accountId, mailboxId: mb!.id, ctx };
}

/** Count what the store is asked, on the client the service actually drives. */
function counter(db: Db): { count: () => number; on: () => void; off: () => void } {
  const client = (db as unknown as { $client: Doors }).$client;
  let counting = false;
  let n = 0;
  for (const door of ["query", "exec"] as const) {
    const inner = client[door].bind(client);
    client[door] = (...a: unknown[]): Promise<unknown> => {
      if (counting) n += 1;
      return inner(...(a as []));
    };
  }
  return { count: () => n, on: () => { counting = true; n = 0; }, off: () => { counting = false; } };
}

describe("the delta reader at its own horizon", () => {
  it("answers out of the bounds read alone, and the answer is the one the long way computes", async () => {
    const { db, accountId, mailboxId, ctx } = await setup();
    const sync = new SyncService();

    const [m] = await db.insert(messages).values({
      accountId, mailboxId, bodyHash: "h", dedupKey: randomUUID(),
      subject: "s", fromAddress: "f@x.example",
    }).returning();
    await db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us",
    });
    await db.transaction((tx) => recordChange(tx as never, {
      accountId, entityType: "message", entityId: m!.id, op: "create",
    }));

    // Walk to the horizon the way a window does: read, then present what it was given.
    const first = await sync.getChanges(ctx, {});
    expect(first.changes.creates).toHaveLength(1);
    const atHorizon = first.cursor;

    const probe = counter(db);
    probe.on();
    const answer = await sync.getChanges(ctx, { since: atHorizon });
    probe.off();

    // THE ANSWER, unchanged: the same cursor back, nothing in any bucket, and no more to come.
    expect(answer.changes).toEqual({ creates: [], updates: [], moves: [], deletes: [] });
    expect(answer.cursor).toBe(atHorizon);
    expect(answer.hasMore).toBe(false);

    /* THE COST. One read — the bounds — and nothing else. A number rather than a shape, because
       the defect this guards against is a second query creeping back in, not a wrong answer. */
    expect(probe.count(), "the horizon poll asked the store more than the bounds read").toBe(1);
  });

  it("A CURSOR ONE BEHIND THE HORIZON STILL TAKES THE LONG WAY — the early return is not a blanket", async () => {
    const { db, accountId, mailboxId, ctx } = await setup();
    const sync = new SyncService();
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const [m] = await db.insert(messages).values({
        accountId, mailboxId, bodyHash: `h${i}`, dedupKey: randomUUID(),
        subject: `s${i}`, fromAddress: "f@x.example",
      }).returning();
      await db.insert(folderState).values({
        messageId: m!.id, accountId: m!.accountId, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us",
      });
      await db.transaction((tx) => recordChange(tx as never, {
        accountId, entityType: "message", entityId: m!.id, op: "create",
      }));
      ids.push(m!.id);
    }
    // One row at a time, so the cursor sits BELOW the horizon with a row still above it.
    const page = await sync.getChanges(ctx, { limit: 1 });
    expect(page.changes.creates).toHaveLength(1);
    const behind = await sync.getChanges(ctx, { since: page.cursor });
    expect(behind.changes.creates, "the row above the cursor was not served — the early return is too eager")
      .toHaveLength(1);
    expect(behind.changes.creates[0]!.id).toBe(ids[1]);
  });
});
