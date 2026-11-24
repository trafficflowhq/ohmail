import { describe, expect, it, vi } from "vitest";
import { messageBodies } from "@trafficflow/db";
import { reindexMessageSearch } from "@trafficflow/core/mail";
import { SearchService } from "../src/index.js";
import { makeCtx, seedMessage, seedSearchDocuments } from "./helpers.js";

/**
 * GAP `GET /search` HAS A CALLER NOW, SO ITS PER-HIT COST IS A HOT PATH.
 *
 * `SearchService.search` re-materialized its hits with `for (const h of hitRows) await
 * materializeMessage(...)`. Each of those issues FOUR statements — messages, folder_state,
 * message_states, message_tags — so a default page of 50 hits was 200 statements awaited one
 * after another, on a pool the API runs at `max: 1`.
 *
 * That was harmless for exactly as long as the endpoint had zero callers on any surface,
 * which it did for the whole of Stage 2. Wiring the client is what makes it a request a user
 * waits on, so the batch form (`materializeMessages`, already exported and already batched)
 * lands in the same change.
 *
 * The assertion is deliberately about the SHAPE and not about a number of milliseconds: the
 * statement count must not grow with the size of the result set. A timing assertion would
 * pass on a fast machine with the per-hit loop restored, which is the failure this exists to
 * catch.
 *
 * Not parallelised — batched. Firing the per-hit calls concurrently is the other way to make
 * the numbers look better and is the shape that deadlocked the admin console on the same
 * `max: 1` pool.
 */

describe("search materializes its page in one batch, not per hit", () => {
  it("the SELECT count is the same for one hit and for six", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const svc = new SearchService();

    // One message carries the term in its subject; five more carry it only in their BODY,
    // which is the half the client's local index cannot see and the reason /search exists.
    const only = await seedMessage(db, accountId, mailboxId, { subject: "kingfisher survey" });
    await db.insert(messageBodies).values({ messageId: only, accountId, text: "nothing else here" });
    await seedSearchDocuments(db, accountId);

    const countSelects = async (q: string): Promise<{ selects: number; hits: number }> => {
      const spy = vi.spyOn(db, "select");
      try {
        const res = await svc.search(ctx, { q });
        return { selects: spy.mock.calls.length, hits: res.items.length };
      } finally {
        spy.mockRestore();
      }
    };

    const one = await countSelects("kingfisher");
    expect(one.hits).toBe(1);

    for (let i = 0; i < 5; i++) {
      const id = await seedMessage(db, accountId, mailboxId, { subject: `note ${i}` });
      await db.insert(messageBodies).values({ messageId: id, accountId, text: `a kingfisher was seen, note ${i}` });
      await reindexMessageSearch(db as never, accountId, id);
    }

    const six = await countSelects("kingfisher");
    expect(six.hits).toBe(6);
    // THE GUARD. Red the moment the per-hit loop comes back: 4 statements become 24.
    expect(six.selects).toBe(one.selects);
  });

  it("fused order survives the batch — the page is not reordered by the id lookup", async () => {
    // `materializeMessages` answers a Map, so order has to be re-imposed from `hitRows`.
    // Without that step the page would come back in whatever order Postgres returned the
    // rows in, silently discarding the RRF ranking the whole service exists to compute.
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const svc = new SearchService();

    const exact = await seedMessage(db, accountId, mailboxId, { subject: "kingfisher kingfisher kingfisher" });
    await db.insert(messageBodies).values({ messageId: exact, accountId, text: "kingfisher" });
    const weak = await seedMessage(db, accountId, mailboxId, { subject: "a note" });
    await db.insert(messageBodies).values({ messageId: weak, accountId, text: "one passing mention of a kingfisher" });
    await seedSearchDocuments(db, accountId);

    const res = await svc.search(ctx, { q: "kingfisher" });
    expect(res.items.map((m) => m.id)).toEqual([exact, weak]);
    expect(res.total).toBe(2);
  });
});
