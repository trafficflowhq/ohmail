import type { StayedWire } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { OhmailEngine } from "../src/engine.js";
import type { EngineAdapter } from "../src/adapters/adapter.js";

/**
 * WHY-STAYED ASKS EVERY ROW. `GET /screener/stayed` refuses more than 100 ids (400), so a sheet
 * with more rows left in Receipts than one page read a short "… stay" and moved too few when one ask named the first page
 * only, or nothing at all when it named all 150 in one. The engine pages the route's ceiling and
 * answers every row; one page refused answers nothing, never a partial count.
 */
const NOW = new Date("2026-10-02T01:00:00.000Z");
const ids = (n: number) => Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);

function door(o: { failPage?: number } = {}) {
  const asks: number[] = [];
  const adapter = {
    sync: async () => ({
      changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor: null, hasMore: false, serverTime: NOW.toISOString(),
    }),
    mutate: async () => ({ ok: true as const, changes: [] }),
    // The route's shape: more than 100 ids is a 400, the rest answered.
    whyStayed: async (asked: readonly string[]): Promise<StayedWire[]> => {
      asks.push(asked.length);
      if (asked.length > 100) throw new Error("400 at most 100 ids");
      if (o.failPage === asks.length) throw new Error("503");
      return asked.map((id) => ({ id, why: "filed-elsewhere" as const }));
    },
  } as unknown as EngineAdapter;
  return { adapter, asks };
}

async function engineOn(adapter: EngineAdapter): Promise<OhmailEngine> {
  const engine = new OhmailEngine({ adapter, now: () => NOW });
  await engine.start();
  return engine;
}

describe("the engine's why-stayed read", () => {
  it("rows past the route's ceiling: two asks, and every row answered", async () => {
    const d = door();
    const why = await (await engineOn(d.adapter)).whyStayed(ids(150));
    expect(d.asks).toEqual([100, 50]);
    expect(why.size).toBe(150);
  });

  it("one row past the ceiling: the last is asked too", async () => {
    const d = door();
    const why = await (await engineOn(d.adapter)).whyStayed(ids(101));
    expect(d.asks).toEqual([100, 1]);
    expect(why.has(ids(101)[100]!)).toBe(true);
  });

  it("a page refused answers nothing rather than the pages before it", async () => {
    const d = door({ failPage: 2 });
    expect((await (await engineOn(d.adapter)).whyStayed(ids(150))).size).toBe(0);
  });

  it("at or under the ceiling it is one ask (the positive control)", async () => {
    const d = door();
    expect((await (await engineOn(d.adapter)).whyStayed(ids(100))).size).toBe(100);
    expect(d.asks).toEqual([100]);
  });
});
