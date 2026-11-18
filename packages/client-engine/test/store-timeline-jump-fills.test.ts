import type { EngineMessage } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  HISTORY_PAGE_CACHE_ROWS,
  HISTORY_PAGE_ROWS,
  MemoryMirrorStore,
  OhmailEngine,
  StoreTimelineWalker,
  type EngineAdapter,
  type ListOlderFn,
  type StoreKeyset,
  type StoreTimeline,
  type SyncResponse,
} from "../src/index.js";

/**
 * A RAIL PRESS FILLS AROUND ITS LANDING, AND A WALK DOES NOT STOP WHEN THE FINGER DOES. The press
 * asks the landing page and starts the walk toward the rows above it in the other lane; a want made
 * while its lane is busy is asked when the lane frees, so the walk's steps run without another
 * scroll. Measured red before: the press asked only its own page, and every busy want was dropped.
 */

const NOW = new Date("2026-10-09T12:00:00.000Z");
const id = (n: number) => `00000000-0000-4000-8000-${(0xffffff - n).toString(16).padStart(12, "0")}`;
function msg(n: number, date: string | null): EngineMessage {
  return {
    id: id(n), accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null, subject: `s${n}`,
    from: { name: null, address: "x@example.test" }, to: [], cc: [], date, folder: "INBOX", snippet: "",
    unread: false, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: date ?? NOW.toISOString(),
  };
}
const instant = (d: string | null) => (d ? Date.parse(d) : 0);

/** `counts` rows per `YYYY-MM`, newest month first, spread over the month; `undated` rows after. */
function mailbox(counts: [string, number][], undated = 0): EngineMessage[] {
  const rows: EngineMessage[] = [];
  let n = 0;
  for (const [month, count] of counts) {
    const from = Date.parse(`${month}-01T00:00:00Z`);
    for (let i = 0; i < count; i++) rows.push(msg(n++, new Date(from + 27 * 86_400_000 * (1 - (i + 0.5) / count)).toISOString()));
  }
  for (let i = 0; i < undated; i++) rows.push(msg(n++, null));
  return rows;
}

function timelineOf(rows: EngineMessage[]): StoreTimeline {
  const months: StoreTimeline["months"] = [];
  let undated = 0;
  for (const m of rows) {
    if (!m.date) { undated += 1; continue; }
    const k = m.date.slice(0, 7);
    const last = months[months.length - 1];
    if (last?.month === k) last.count += 1;
    else months.push({ month: k, count: 1, first: { date: m.date, id: m.id } });
  }
  return { total: rows.length, months, undated };
}

async function walkerOver(rows: EngineMessage[]) {
  const asked: (StoreKeyset | null)[] = [];
  let failing = false;
  const listMessages: ListOlderFn = async (_v, o) => {
    asked.push(o.startBelow ?? null);
    await new Promise((r) => setTimeout(r, 0));
    if (failing) throw new Error("offline");
    const b = o.startBelow;
    const below = (m: EngineMessage) => {
      const a = instant(m.date), x = b!.date ? Date.parse(b!.date) : 0;
      return a < x || (a === x && m.id < b!.id);
    };
    return { items: (b ? rows.filter(below) : rows).slice(0, o.limit ?? HISTORY_PAGE_ROWS), nextCursor: null };
  };
  const adapter = {
    sync: async (): Promise<SyncResponse> => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "0", hasMore: false, serverTime: NOW.toISOString() }),
    mutate: async () => ({ changes: [], seq: null }), fetchBody: async () => null,
    listMessages, timeline: async () => timelineOf(rows),
  } as unknown as EngineAdapter;
  const store = new MemoryMirrorStore();
  await store.load();
  const engine = new OhmailEngine({ adapter, store, now: () => NOW });
  let clock = 0;
  const walker = new StoreTimelineWalker(engine, () => clock);
  return { engine, walker, asked, fail: (on: boolean) => { failing = on; }, tick: (ms: number) => { clock += ms; } };
}

const settle = async (n = 60) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const held = (w: StoreTimelineWalker, a: number, b: number) => {
  const missing: number[] = [];
  for (let i = a; i < b; i++) if (w.rowAt(i, []) === null) missing.push(i);
  return missing;
};

/** The tester's shape: rows over ten months of 2026, one in January 2024, two undated. */
const TESTER: [string, number][] = [
  ["2026-10", 120], ["2026-09", 430], ["2026-08", 410], ["2026-07", 420], ["2026-06", 400],
  ["2026-05", 415], ["2026-04", 410], ["2026-03", 402], ["2026-02", 400], ["2026-01", 630], ["2024-01", 1],
];

describe("a rail press fills around its landing", () => {
  it("the rows above the landing fill with no scroll — the press walks toward them itself", async () => {
    const { walker, engine } = await walkerOver(mailbox(TESTER, 2));
    walker.start();
    await settle();
    const seg = walker.segments().find((s) => s.month === "2024-01")!;
    expect(seg.start).toBe(4037);
    walker.jump(seg.start);
    await settle(200);
    expect(held(walker, seg.start, walker.length(0)), "the landing and below").toEqual([]);
    expect(held(walker, seg.start - 12, seg.start), "the rows above the landing").toEqual([]);
    expect((walker.rowAt(seg.start - 1, []) as EngineMessage).date!.startsWith("2026-01")).toBe(true);
    expect(engine.storePageCacheRows()).toBeLessThanOrEqual(HISTORY_PAGE_CACHE_ROWS);
    walker.stop();
  });

  it("where the month above holds a page or less, its rows come in one page fetch beside the landing's", async () => {
    const { walker, asked } = await walkerOver(mailbox([["2026-10", 60], ["2026-09", 30], ["2025-05", 70], ["2024-03", 20]]));
    walker.start();
    await settle();
    const seg = walker.segments().find((s) => s.month === "2025-05")!;
    const before = asked.length;
    walker.jump(seg.start);
    await settle();
    expect(asked.length - before, "the landing's page and the page above it").toBe(2);
    expect(held(walker, seg.start - 30, seg.start + 50)).toEqual([]);
    walker.stop();
  });

  it("a press on a slot already held asks nothing it holds", async () => {
    const { walker, asked } = await walkerOver(mailbox([["2026-10", 30], ["2026-09", 15], ["2026-08", 30]]));
    walker.start();
    await settle();
    const before = asked.length;
    walker.jump(walker.segments()[1]!.start);
    await settle();
    expect(asked.length, "page one already holds both").toBe(before);
    walker.stop();
  });
});

describe("a walk does not stop when the finger does", () => {
  it("one want toward a far slot is walked to the end, step by step, with no further call", async () => {
    const { walker, asked, engine } = await walkerOver(mailbox([["2026-10", 700]]));
    walker.start();
    await settle();
    walker.want(420, 430);
    await settle(200);
    expect(held(walker, 420, 430)).toEqual([]);
    // One request per 50 rows walked, none repeated, and the cache never past its ceiling.
    expect(new Set(asked.map((a) => JSON.stringify(a))).size).toBe(asked.length);
    expect(engine.storePageCacheRows()).toBeLessThanOrEqual(HISTORY_PAGE_CACHE_ROWS);
    walker.stop();
  });

  it("a want made while its lane is busy is the one asked when the lane frees", async () => {
    const { walker } = await walkerOver(mailbox([["2026-10", 700]]));
    walker.start();
    await settle();
    walker.want(160, 170);
    walker.want(260, 270);
    await settle(200);
    expect(held(walker, 260, 270)).toEqual([]);
    walker.stop();
  });

  it("control: an ordinary scroll from the top fills each screen it reaches, and no page is asked twice", async () => {
    const { walker, asked } = await walkerOver(mailbox([["2026-10", 300]]));
    walker.start();
    await settle();
    for (let top = 0; top < 280; top += 7) {
      walker.want(Math.max(0, top - 8), top + 17);
      await settle(4);
    }
    await settle();
    expect(held(walker, 260, 300)).toEqual([]);
    expect(new Set(asked.map((a) => JSON.stringify(a))).size).toBe(asked.length);
    walker.stop();
  });
});

describe("rows that cannot load say so", () => {
  it("a failed page is reported until a later page answers", async () => {
    const { walker, fail, tick } = await walkerOver(mailbox([["2026-10", 300]]));
    walker.start();
    await settle();
    expect(walker.pagesFailing()).toBe(false);
    fail(true);
    walker.want(200, 210);
    await settle();
    expect(walker.pagesFailing()).toBe(true);
    expect(held(walker, 200, 210).length).toBe(10);
    fail(false);
    tick(10_000);
    walker.want(200, 210);
    await settle(200);
    expect(walker.pagesFailing()).toBe(false);
    expect(held(walker, 200, 210)).toEqual([]);
    walker.stop();
  });
});
