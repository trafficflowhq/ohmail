import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { folderState, mailboxes, messages } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { ScreenerService } from "../src/screener-service.js";
import type { ServiceContext } from "../src/context.js";

/**
 * UNDATED MAIL SORTS AT ITS ARRIVAL, AND THE CURSOR KEEPS THAT ORDER ACROSS PAGES.
 *
 * The queue sorted by `coalesce(date, epoch)`, so a sender the cutline admits on their arrival
 * sank to the bottom of the Screener and their representative was their newest DATED message.
 * The key is now the header else the arrival (`heldSortKey`), in the ORDER BY and in the cursor.
 * Runs on both stores (the default project and `pnpm test:sqlite`).
 */

const NOW = new Date("2026-09-27T12:00:00.000Z");
const at = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

async function world() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `sud-${accountId.slice(0, 8)}@ohmail.test`,
  }).returning();
  let n = 0;
  const held = async (from: string, date: Date | null, arrived: Date): Promise<string> => {
    const i = n++;
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: `h${i}`, dedupKey: `sud:${randomUUID()}`,
      subject: `Note ${i}`, snippet: "", fromAddress: from, date, createdAt: arrived, unread: true,
      nativeLocator: { folder: "ohmail/Screener", ref: `1:${i}` },
    }).returning();
    await db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: "ohmail/Screener", observedFolder: "ohmail/Screener",
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    return m!.id;
  };
  const ctx: ServiceContext = { db, accountId, userId: null, now: () => NOW, requestId: "sud" };
  return { db, ctx, held };
}

/** Every page to the end, the cursor carried exactly as a surface carries it. */
async function walk(ctx: ServiceContext, limit: number): Promise<Array<{ sender: string; id: string }>> {
  const svc = new ScreenerService({});
  const out: Array<{ sender: string; id: string }> = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 50; guard++) {
    const page = await svc.list(ctx, cursor ? { limit, cursor } : { limit });
    out.push(...page.items.map((i) => ({ sender: i.sender.address, id: i.messageId })));
    if (!page.nextCursor) return out;
    cursor = page.nextCursor;
  }
  throw new Error("cursor never terminated");
}

describe("the Screener orders undated mail by its arrival", () => {
  it("an undated sender sits where their mail arrived, on every page size", async () => {
    const w = await world();
    await w.held("d1@x.test", at(1), at(1));
    await w.held("u2@x.test", null, at(2));
    await w.held("d3@x.test", at(3), at(3));
    await w.held("u4@x.test", null, at(4));
    await w.held("u4b@x.test", null, at(4)); // an arrival tie, broken by id
    await w.held("d5@x.test", at(5), at(5));
    const expected = ["d1@x.test", "u2@x.test", "d3@x.test"];

    for (const limit of [1, 2, 3, 50]) {
      const seen = (await walk(w.ctx, limit)).map((r) => r.sender);
      expect(seen.slice(0, 3), `limit ${limit}`).toEqual(expected);
      expect(seen.at(-1), `limit ${limit}`).toBe("d5@x.test");
      // Exactly once each, across every page boundary — the tie included.
      expect([...seen].sort(), `limit ${limit}`).toEqual(
        ["d1@x.test", "d3@x.test", "d5@x.test", "u2@x.test", "u4@x.test", "u4b@x.test"]);
    }
  });

  it("a sender is represented by their newest ARRIVAL when it carries no date", async () => {
    const w = await world();
    await w.held("mixed@x.test", at(30), at(30));
    const newest = await w.held("mixed@x.test", null, at(1));
    await w.held("other@x.test", at(10), at(10));
    const rows = await walk(w.ctx, 50);
    expect(rows.map((r) => r.sender)).toEqual(["mixed@x.test", "other@x.test"]);
    expect(rows[0]!.id).toBe(newest);
  });
});
