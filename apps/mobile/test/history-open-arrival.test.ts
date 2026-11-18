import type { EngineMessage } from "@ohmail/wire";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  HISTORY_PAGE_ROWS,
  MemoryMirrorStore,
  OhmailEngine,
  type EngineAdapter,
  type ListOlderFn,
  type StoreTimeline,
  type SyncChange,
  type SyncResponse,
} from "@ohmail/client-engine";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { storeWalkerFor } from "../src/state/live";
import { SlotHeights } from "../src/ui/history-slot";

/**
 * THE PHONE'S OPEN HISTORY SHOWS MAIL THAT ARRIVES WHILE IT IS OPEN (THE phone half):
 * the phone's own walker over a real engine puts the arrival in slot 0 after one drain, the slot
 * ledger moves each laid-out height down with its row, and the screen moves its offset by the new
 * rows' height only while the reader is inside the rows.
 *
 * CAN MEASURE: the walker, the ledger's arithmetic, the screen's wiring. CANNOT: the native list's
 * frame under the offset move (no React Native renderer here); a device pass reads it.
 */

const NOW = new Date("2026-09-23T12:00:00.000Z");
const id = (n: number) => `00000000-0000-4000-8000-${(0xffffffff - n).toString(16).padStart(12, "0")}`;
function msg(n: number, date: string): EngineMessage {
  return {
    id: id(n), accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null, subject: `s${n}`,
    from: { name: null, address: "x@example.test" }, to: [], cc: [], date, folder: "INBOX", snippet: "",
    unread: false, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: date,
  };
}

function timelineOf(rows: readonly EngineMessage[]): StoreTimeline {
  const months: StoreTimeline["months"] = [];
  for (const m of rows) {
    const k = m.date!.slice(0, 7);
    const last = months[months.length - 1];
    if (last?.month === k) last.count += 1;
    else months.push({ month: k, count: 1, first: { date: m.date, id: m.id } });
  }
  return { total: rows.length, months, undated: 0 };
}

async function phoneEngine(n: number) {
  const rows = Array.from({ length: n }, (_, i) => msg(i, new Date(NOW.getTime() - (i + 1) * 3_600_000).toISOString()));
  let feed: SyncChange[] = [];
  let seq = 0;
  const listMessages: ListOlderFn = async (_v, o) => {
    const b = o.startBelow;
    const rest = b ? rows.filter((m) => m.date! < b.date! || (m.date === b.date && m.id < b.id)) : rows;
    return { items: rest.slice(0, o.limit ?? HISTORY_PAGE_ROWS), nextCursor: null };
  };
  const adapter = {
    sync: async (): Promise<SyncResponse> => {
      const creates = feed;
      feed = [];
      return { changes: { creates, updates: [], moves: [], deletes: [] }, cursor: String(seq), hasMore: false, serverTime: NOW.toISOString() };
    },
    mutate: async () => ({ changes: [], seq: null }), fetchBody: async () => null,
    listMessages, timeline: async () => timelineOf(rows),
  } as unknown as EngineAdapter;
  const store = new MemoryMirrorStore();
  await store.load();
  const engine = new OhmailEngine({ adapter, store, now: () => NOW });
  return {
    engine,
    arrive(m: EngineMessage): void {
      rows.unshift(m);
      feed.push({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m });
    },
  };
}

const settle = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

describe("the phone's open History and an arrival", () => {
  it("the phone's walker puts the arrival in slot 0 after one drain, the old top one slot lower", async () => {
    const p = await phoneEngine(80);
    const walker = storeWalkerFor(p.engine);
    walker.start();
    await settle();
    const at = (i: number) => { const r = walker.rowAt(i, []); return r === null || r === "gone" ? null : r.id; };
    expect(at(0)).toBe(id(0));
    p.arrive(msg(-1, NOW.toISOString()));
    await p.engine.syncOnce();
    await settle();
    expect(at(0), "the open list, after one drain").toBe(id(-1));
    expect(at(1)).toBe(id(0));
    expect(walker.shifted()).toBe(1);
    walker.stop();
  });
});

describe("the slot ledger moves with its rows", () => {
  const uneven = (i: number) => 84 + (i % 3) * 18;
  const ledger = (n = 40): SlotHeights => {
    const h = new SlotHeights();
    for (let i = 0; i < n; i++) h.record(i, uneven(i));
    return h;
  };

  it("each laid-out height moves down by the arrivals; the new rows are drawn at the common height", () => {
    const h = ledger();
    const before = Array.from({ length: 40 }, (_, i) => [h.heightOf(i), h.offsetOf(i)] as const);
    const common = h.heightOf(5_000);
    h.shift(3);
    for (let i = 0; i < 3; i++) expect(h.heightOf(i)).toBe(common);
    for (let i = 0; i < 40; i++) {
      expect(h.heightOf(i + 3), `row ${i} keeps its height`).toBe(before[i]![0]);
      expect(h.offsetOf(i + 3), `row ${i} starts the new rows' height lower`).toBe(before[i]![1] + 3 * common);
    }
  });

  it("the reader's row stands where it stood once the offset moves by the new rows' height", () => {
    const h = ledger(200);
    const top = 140;
    const y = top + h.offsetOf(120) + 7;
    const edge = (row: number, at: number) => top + h.offsetOf(row) - at;
    const was = edge(120, y);
    h.shift(2);
    expect(edge(122, y + h.offsetOf(2))).toBe(was);
  });

  it("stays exact past the ledger's first trees, and a zero shift moves nothing", () => {
    const h = ledger(10);
    h.record(300, 140);
    const at301 = h.offsetOf(301);
    h.shift(0);
    expect(h.offsetOf(301)).toBe(at301);
    h.shift(100);
    expect(h.heightOf(400)).toBe(140);
    expect(h.offsetOf(401)).toBe(at301 + 100 * h.heightOf(5_000));
  });
});

describe("the screen holds its reader by the walker's count", () => {
  const APP = fileURLToPath(new URL("..", import.meta.url));
  const read = (rel: string): string => withoutComments(readFileSync(`${APP}/${rel}`, "utf8"));
  const SCREEN = read("app/history.tsx");
  const VIEWS = read("src/state/store-views.ts");

  it("the binding hands the walker's count, and the screen moves the ledger by it", () => {
    expect(VIEWS).toMatch(/shifted: walker \? walker\.shifted\(\) : 0,/);
    expect(SCREEN).toMatch(/const d = h\.shifted - shiftSeen\.current;/);
    expect(SCREEN).toMatch(/heights\.shift\(d\);/);
  });

  it("the offset moves by the new rows' height only while the reader is inside the rows", () => {
    expect(SCREEN).toMatch(/if \(d > 0 && scrollY\.current > top\.current\) owedScroll\.current \+= heights\.offsetOf\(d\);/);
    expect(SCREEN).toMatch(/scrollTo\.current\?\.\(scrollY\.current\);/);
    expect(SCREEN).toMatch(/scrollY\.current = contentOffset\.y;/);
  });
});
