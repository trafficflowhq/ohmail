import { describe, expect, it } from "vitest";
import { messageBodies } from "@trafficflow/db";
import { SearchService, isSearchParts } from "../src/index.js";
import { makeCtx, seedMessage } from "./helpers.js";

/**
 * THE SUMMARY'S FIRST ANSWER — `parts=estimate` counts the tier's fused candidates: when no arm was
 * cut they ARE the match set, so the count and facets equal the exact summary's; when one was, the
 * count is a lower bound said as "at least" (never a planner's estimate: its statistics cover every
 * account's mail), and the facets are the candidates'.
 * Both stores: this file runs in the sqlite project too. Watched red: the estimate never cut and its
 * facets over the union (case 2), eight pages a cut (case 3), the sender order reversed (case 1).
 */
const TERM = "kingfisher";
const MATCHES = 30;

async function corpus() {
  const { db, ctx, accountId, mailboxId } = await makeCtx();
  for (let i = 0; i < MATCHES; i++) {
    const id = await seedMessage(db, accountId, mailboxId, {
      subject: `${TERM} report ${i}`,
      from: `ranger${i % 4}@reserve.example`,
      folder: i % 3 === 0 ? "INBOX" : "ohmail/News",
      unread: i % 2 === 0,
      date: new Date(Date.parse("2026-07-01T09:00:00Z") + i * 3_600_000),
    });
    await db.insert(messageBodies).values({ messageId: id, text: `a ${TERM} at the weir, number ${i}` });
  }
  await seedMessage(db, accountId, mailboxId, { subject: "minutes of the board", from: "clerk@board.example" });
  return ctx;
}

const sum = (o: Record<string, number>): number => Object.values(o).reduce((a, b) => a + b, 0);

describe("parts=estimate — the count and facets over the fused candidates", () => {
  it("is a member of the closed parts set the doors validate against", () => {
    expect(isSearchParts("estimate")).toBe(true);
    expect(isSearchParts("estimates")).toBe(false);
  });

  it("(1) no arm cut: the estimate IS the summary — the same total, exact, and the same facets", async () => {
    const ctx = await corpus();
    const svc = new SearchService();
    const e = await svc.search(ctx, { q: TERM, parts: "estimate" });
    const s = await svc.search(ctx, { q: TERM, parts: "summary" });
    expect(s.total).toBe(MATCHES);
    expect(e.items).toEqual([]);
    expect(e.nextCursor).toBeNull();
    expect(e.totalExact).toBe(true);
    expect("totalEstimate" in e).toBe(false);
    expect(e.total).toBe(s.total);
    expect(e.tier).toBe(s.tier);
    expect(e.facets).toEqual(s.facets);
    // One statement, the SQL's own order: count descending, then address.
    expect(s.facets!.sender).toEqual([0, 1, 2, 3].map((i) => ({ address: `ranger${i}@reserve.example`, count: i < 2 ? 8 : 7 })));
  });

  it("(2) a cut arm: a lower bound with no estimate beside it, and the candidates' facets", async () => {
    const ctx = await corpus();
    const svc = new SearchService();
    // Two a page puts every arm's cut at eight, under the thirty that match.
    const e = await svc.search(ctx, { q: TERM, parts: "estimate", limit: 2 });
    const page = await svc.search(ctx, { q: TERM, parts: "page", limit: 2 });
    const s = await svc.search(ctx, { q: TERM, parts: "summary" });
    expect(e.totalExact).toBe(false);
    expect(e.total).toBe(page.total);
    expect(e.total).toBeLessThan(s.total);
    expect("totalEstimate" in e, "no count read from planner statistics").toBe(false);
    expect(sum(e.facets!.folder)).toBe(e.total);
    expect(e.facets!.unread.true + e.facets!.unread.false).toBe(e.total);
    expect(e.facets!.sender.reduce((a, x) => a + x.count, 0)).toBe(e.total);
  });

  it("(3) each arm reads four pages' worth — the one arm a body-only word reaches is cut at 4 × limit", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    for (let i = 0; i < 20; i++) {
      const id = await seedMessage(db, accountId, mailboxId, { subject: `note ${i}`, from: "clerk@board.example" });
      await db.insert(messageBodies).values({ messageId: id, text: `the ${TERM} came back, entry ${i}` });
    }
    const page = await new SearchService().search(ctx, { q: TERM, parts: "page", limit: 3 });
    expect(page.totalExact).toBe(false);
    expect(page.total).toBe(4 * 3);
  });

  it("(4) nothing typed and nothing found both answer an exact zero", async () => {
    const ctx = await corpus();
    const svc = new SearchService();
    for (const q of ["", "   ", "zzznothingmatches"]) {
      const e = await svc.search(ctx, { q, parts: "estimate" });
      expect(e.total, q).toBe(0);
      expect(e.totalExact, q).toBe(true);
      expect(sum(e.facets!.folder), q).toBe(0);
    }
  });
});
