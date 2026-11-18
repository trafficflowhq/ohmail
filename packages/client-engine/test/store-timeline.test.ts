import type { EngineMessage } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  HISTORY_PAGE_CACHE_ROWS,
  HISTORY_PAGE_ROWS,
  MemoryMirrorStore,
  MutationRejectedError,
  OhmailEngine,
  StoreTimelineWalker,
  type EngineAdapter,
  type ListOlderFn,
  type StoreKeyset,
  type StoreTimeline,
  type SyncResponse,
} from "../src/index.js";

/**
 * THE ONE TIMELINE WALKER the browser and the phone render: page one replaces the mirror's first
 * paint, the window's slots are fetched from the nearest anchor, a far slot is reached by walk
 * steps the cache never keeps, and a jump lands at the month's own anchor.
 */

const NOW = new Date("2026-09-23T12:00:00.000Z");
const id = (n: number) => `00000000-0000-4000-8000-${(0xffffff - n).toString(16).padStart(12, "0")}`;
function msg(n: number, date: string): EngineMessage {
  return {
    id: id(n), accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null, subject: `s${n}`,
    from: { name: null, address: "x@example.test" }, to: [], cc: [], date, folder: "INBOX", snippet: "",
    unread: false, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: date,
  };
}

function timelineOf(rows: EngineMessage[]): StoreTimeline {
  const months: StoreTimeline["months"] = [];
  for (const m of rows) {
    const k = m.date!.slice(0, 7);
    const last = months[months.length - 1];
    if (last?.month === k) last.count += 1;
    else months.push({ month: k, count: 1, first: { date: m.date, id: m.id } });
  }
  return { total: rows.length, months, undated: 0 };
}

async function walkerOver(rows: EngineMessage[], held = false) {
  const asked: (StoreKeyset | null)[] = [];
  const waiting: (() => void)[] = [];
  let open = !held;
  const gate = () => (open ? Promise.resolve() : new Promise<void>((r) => waiting.push(r)));
  const listMessages: ListOlderFn = async (_v, o) => {
    asked.push(o.startBelow ?? null);
    await gate();
    const b = o.startBelow;
    const rest = b ? rows.filter((m) => m.date! < b.date! || (m.date === b.date && m.id < b.id)) : rows;
    return { items: rest.slice(0, o.limit ?? HISTORY_PAGE_ROWS), nextCursor: null };
  };
  const adapter = {
    sync: async (): Promise<SyncResponse> => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "0", hasMore: false, serverTime: NOW.toISOString() }),
    mutate: async () => ({ changes: [], seq: null }), fetchBody: async () => null,
    listMessages, timeline: async () => { await gate(); return timelineOf(rows); },
  } as unknown as EngineAdapter;
  const store = new MemoryMirrorStore();
  await store.load();
  const engine = new OhmailEngine({ adapter, store, now: () => NOW });
  const walker = new StoreTimelineWalker(engine);
  return { engine, walker, asked, release: () => { open = true; for (const w of waiting.splice(0)) w(); } };
}

const settle = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const hourly = (n: number, from = 0) => Array.from({ length: n }, (_, i) => msg(from + i, new Date(NOW.getTime() - (from + i) * 3_600_000).toISOString()));

describe("the timeline walker", () => {
  it("the mirror paints first; page one replaces it with the store's length", async () => {
    const rows = hourly(120);
    const { walker, release } = await walkerOver(rows, true);
    walker.start();
    const mirror = rows.slice(0, 10);
    expect(walker.state()).toBe("loading");
    expect(walker.length(mirror.length)).toBe(10);
    expect(walker.rowAt(0, mirror)).toBe(mirror[0]);
    release();
    await settle();
    expect(walker.state()).toBe("ready");
    expect(walker.length(mirror.length)).toBe(120);
    expect((walker.rowAt(0, mirror) as EngineMessage).id).toBe(mirror[0]!.id);
    walker.stop();
  });

  it("walks to a far slot in uncached steps, and holds no more than the ceiling", async () => {
    const rows = hourly(600);
    const { engine, walker, asked } = await walkerOver(rows);
    walker.start();
    await settle();
    for (let i = 0; i < 20 && walker.rowAt(420, []) === null; i++) {
      walker.want(410, 430);
      await settle();
    }
    expect((walker.rowAt(420, []) as EngineMessage).id).toBe(id(420));
    expect(engine.storePageCacheRows()).toBeLessThanOrEqual(HISTORY_PAGE_CACHE_ROWS);
    // One request per 50 rows walked, and none repeated.
    expect(new Set(asked.map((a) => JSON.stringify(a))).size).toBe(asked.length);
    walker.stop();
  });

  it("a jump asks the month at its own anchor, one request", async () => {
    const rows = [...hourly(200), ...Array.from({ length: 30 }, (_, i) => msg(200 + i, `2019-04-${String(28 - i % 27).padStart(2, "0")}${"T"}00:00:00.000Z`))]
      .sort((a, b) => (a.date! < b.date! ? 1 : a.date! > b.date! ? -1 : a.id < b.id ? 1 : -1));
    const { walker, asked } = await walkerOver(rows);
    walker.start();
    await settle();
    const seg = walker.segments().find((s) => s.month === "2019-04")!;
    const before = asked.length;
    walker.jump(seg.start);
    await settle();
    // The landing is ONE request at the month's own anchor; the others walk toward the rows above
    // it (store-timeline-jump-fills.test.ts), each anchored above the landing.
    const press = asked.slice(before);
    expect(press.filter((a) => a?.id === seg.before.id && a?.date === seg.before.date).length).toBe(1);
    for (const a of press) if (a?.id !== seg.before.id) expect(a === null || a.date! > seg.before.date!).toBe(true);
    expect((walker.rowAt(seg.start, []) as EngineMessage).date!.startsWith("2019-04")).toBe(true);
    walker.stop();
  });

  it("a visit that stopped reads nothing that answers after it", async () => {
    const { walker, release } = await walkerOver(hourly(10), true);
    walker.start();
    walker.stop();
    release();
    await settle();
    expect(walker.state()).toBe("loading");
  });
});

/** A store whose doors refuse with these statuses while they are set — the HTTP adapter's refusal. */
async function refusingWalker(refuse: { timeline: number | null; page: number | null }) {
  const no = (status: number) => new MutationRejectedError(`HTTP ${status}`, {
    status, code: status === 401 ? "unauthorized" : null, retryable: status >= 500,
  });
  const rows = hourly(30);
  const adapter = {
    sync: async (): Promise<SyncResponse> => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "0", hasMore: false, serverTime: NOW.toISOString() }),
    mutate: async () => ({ changes: [], seq: null }), fetchBody: async () => null,
    listMessages: (async (_v, o) => {
      if (refuse.page !== null) throw no(refuse.page);
      return { items: rows.slice(0, o.limit ?? HISTORY_PAGE_ROWS), nextCursor: null };
    }) as ListOlderFn,
    timeline: async () => {
      if (refuse.timeline !== null) throw no(refuse.timeline);
      return timelineOf(rows);
    },
  } as unknown as EngineAdapter;
  const store = new MemoryMirrorStore();
  await store.load();
  return new StoreTimelineWalker(new OhmailEngine({ adapter, store, now: () => NOW }));
}

describe("why the store did not answer", () => {
  it("the timeline's refusal is carried as its class, and a new visit starts without it", async () => {
    const refuse = { timeline: 401 as number | null, page: null as number | null };
    const walker = await refusingWalker(refuse);
    walker.start();
    await settle();
    expect(walker.state()).toBe("unanswered");
    expect(walker.failureCause()?.split(" ")).toContain("401");

    refuse.timeline = null;
    walker.start();
    expect(walker.failureCause()).toBeNull();
    await settle();
    expect(walker.state()).toBe("ready");
    expect(walker.failureCause()).toBeNull();
  });

  it("page one's refusal is carried too, when the timeline answered", async () => {
    const walker = await refusingWalker({ timeline: null, page: 503 });
    walker.start();
    await settle();
    expect(walker.state()).toBe("unanswered");
    expect(walker.failureCause()?.split(" ")).toContain("503");
  });
});
