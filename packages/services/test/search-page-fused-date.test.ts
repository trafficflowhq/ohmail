import { describe, expect, it } from "vitest";
import { messageBodies } from "@trafficflow/db";
import { searchIndexBackfillPass } from "@trafficflow/core/mail";
import { SearchService } from "../src/index.js";
import { FOUND_WITHOUT_DOCUMENT, makeCtx, seedMessage } from "./helpers.js";

/**
 * THE PAGE ORDERS BY THE DATE ITS ARMS CARRY, on both stores (this file runs in the sqlite project
 * too). The fused candidates are no longer looked up again for their date, so the tie-break inside
 * one score — newest first, no date last, then id — is the arms' own `m.date`. A quoted word opens
 * only the head and body arms; a message in one of them at position p ties with the other's
 * message at p, so every pair is ordered by date alone. Paging by cursor walks the same order.
 */
const DAY = 86_400_000;
const t0 = Date.parse("2026-07-20T09:00:00Z");

async function corpus(built: boolean) {
  const { db, ctx, accountId, mailboxId } = await makeCtx();
  const put = async (inSubject: boolean, date: Date | null) => {
    const id = await seedMessage(db, accountId, mailboxId, {
      subject: inSubject ? "lantern notes" : "weekly memo", from: "desk@site.example",
      snippet: "", folder: "INBOX", date: date as Date,
    });
    await db.insert(messageBodies).values({ messageId: id, accountId, text: inSubject ? "nothing here" : "the lantern is lit" });
    return { id, date: date === null ? null : date.getTime() };
  };
  // Head and body dates interleave; one of each has no date, and one pair shares a date.
  const heads = [await put(true, new Date(t0 - 1 * DAY)), await put(true, new Date(t0 - 3 * DAY)), await put(true, new Date(t0 - 5 * DAY)),
    await put(true, new Date(t0 - 7 * DAY)), await put(true, null)];
  const bodies = [await put(false, new Date(t0 - 2 * DAY)), await put(false, new Date(t0 - 3 * DAY)), await put(false, new Date(t0 - 6 * DAY)),
    await put(false, null), await put(false, new Date(t0 - 9 * DAY))];
  if (built) expect((await searchIndexBackfillPass({ db: db as never, accountId })).marked).toBe(true);
  return { ctx, heads, bodies };
}

type Row = { id: string; date: number | null };
const newestFirst = (a: Row, b: Row): number =>
  a.date === b.date ? (a.id < b.id ? 1 : -1) : a.date === null ? 1 : b.date === null ? -1 : b.date - a.date;

/** Position p of each arm ties: the pair at p by date (nulls last), then id, in arm order. */
function oracle(heads: Row[], bodies: Row[]): string[] {
  const h = [...heads].sort(newestFirst);
  const b = [...bodies].sort(newestFirst);
  return h.flatMap((x, i) => [x, b[i]!].sort(newestFirst).map((r) => r.id));
}

describe.each(([["with the search documents built", true], ["before the documents are built", false]] as const)
  .filter(([, built]) => built || FOUND_WITHOUT_DOCUMENT))("%s", (_label, built) => {
  it("one page: equal scores are ordered by the arms' dates, no date last", async () => {
    const { ctx, heads, bodies } = await corpus(built);
    const r = await new SearchService().search(ctx, { q: '"lantern"', parts: "page" });
    expect(r.tier).toBe("exact");
    expect(r.items.map((m) => m.id)).toEqual(oracle(heads, bodies));
  });

  it("paging by cursor, two rows a page, walks the same order", async () => {
    const { ctx, heads, bodies } = await corpus(built);
    const svc = new SearchService();
    const got: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const r = await svc.search(ctx, { q: '"lantern"', parts: "page", limit: 2, ...(cursor ? { cursor } : {}) });
      got.push(...r.items.map((m) => m.id));
      if (!r.nextCursor) break;
      cursor = r.nextCursor;
    }
    expect(got).toEqual(oracle(heads, bodies));
  });
});
