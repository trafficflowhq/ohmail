import type { EngineMessage } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  HISTORY_PAGE_ROWS,
  MemoryMirrorStore,
  OhmailEngine,
  StoreTimelineWalker,
  type EngineAdapter,
  type ListOlderFn,
  type StoreKeyset,
  type StoreTimeline,
  type SyncChange,
  type SyncResponse,
} from "../src/index.js";

/**
 * AN OPEN HISTORY SHOWS MAIL THAT REACHES THE STORE WHILE IT IS OPEN.
 * A real engine over a fake store whose `/sync` delivers the arrival: after ONE drain the new
 * message is in slot 0, every row the walk held sits one slot lower without being asked again,
 * and a reopen reads the same list — the control that the store holds what the open list shows.
 */

const NOW = new Date("2026-09-23T12:00:00.000Z");
/** Ids that sort like their slot, newest first; a negative slot is newer than slot 0. */
const id = (n: number) => `00000000-0000-4000-8000-${(0xffffffff - n).toString(16).padStart(12, "0")}`;
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

function msg(n: number, date: string): EngineMessage {
  return {
    id: id(n), accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null, subject: `s${n}`,
    from: { name: null, address: "x@example.test" }, to: [], cc: [], date, folder: "INBOX", snippet: "",
    unread: false, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: date,
  };
}

/** The store's order: its arrival key, `sortAt ?? date`, newest first, id breaking a tie. */
const keyOf = (m: EngineMessage): string => m.sortAt ?? m.date!;
const later = (a: EngineMessage, b: EngineMessage): number =>
  (keyOf(a) < keyOf(b) ? 1 : keyOf(a) > keyOf(b) ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

function timelineOf(rows: readonly EngineMessage[]): StoreTimeline {
  const months: StoreTimeline["months"] = [];
  for (const m of rows) {
    const k = keyOf(m).slice(0, 7);
    const last = months[months.length - 1];
    if (last?.month === k) last.count += 1;
    else months.push({ month: k, count: 1, first: { date: keyOf(m), id: m.id } });
  }
  return { total: rows.length, months, undated: 0 };
}

/** The store, its `/sync` feed and every page request, as the keyset it asked below. */
async function liveStore(n: number, mirrored = 20, shape?: (rows: EngineMessage[]) => void) {
  const rows = Array.from({ length: n }, (_, i) => msg(i, hoursAgo(i + 1)));
  shape?.(rows);
  const asked: (StoreKeyset | null)[] = [];
  let seq = 0;
  let feed: SyncChange[] = rows.slice(0, mirrored).map((m) => ({
    type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
  }));
  /** Set: the next page is read at once and answered only when this is called. */
  let held: Promise<void> | null = null;
  let release: () => void = () => {};
  const listMessages: ListOlderFn = async (_v, o) => {
    asked.push(o.startBelow ?? null);
    const b = o.startBelow;
    // The server's rule: a named living row's own key is the position; the date only for a gone row.
    const named = b ? rows.find((m) => m.id === b.id) : undefined;
    const at = b ? (named ? keyOf(named) : b.date!) : "";
    const rest = b ? rows.filter((m) => keyOf(m) < at || (keyOf(m) === at && m.id < b.id)) : rows;
    const items = rest.slice(0, o.limit ?? HISTORY_PAGE_ROWS);
    const wait = held;
    held = null;
    if (wait) await wait;
    return { items, nextCursor: null };
  };
  const adapter = {
    sync: async (): Promise<SyncResponse> => {
      const creates = feed.filter((c) => c.op === "create");
      const updates = feed.filter((c) => c.op === "update");
      const deletes = feed.filter((c) => c.op === "delete");
      feed = [];
      return { changes: { creates, updates, moves: [], deletes }, cursor: String(seq), hasMore: false, serverTime: NOW.toISOString() };
    },
    mutate: async () => ({ changes: [], seq: null }), fetchBody: async () => null,
    listMessages, timeline: async () => timelineOf(rows),
  } as unknown as EngineAdapter;
  const store = new MemoryMirrorStore();
  await store.load();
  const engine = new OhmailEngine({ adapter, store, now: () => NOW });
  await engine.syncOnce();
  return {
    engine, rows, asked,
    /** A message reaches the store, and the next `/sync` carries it under `op`. */
    arrive(m: EngineMessage, op: "create" | "update" = "create"): void {
      rows.push(m);
      rows.sort(later);
      feed.push({ type: "message", op, id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m });
    },
    /** The next page request reads the store now and answers on the returned call. */
    holdNext(): () => void {
      held = new Promise<void>((r) => { release = r; });
      return () => release();
    },
    /** A message leaves the store, and the next `/sync` says so. */
    remove(m: EngineMessage): void {
      rows.splice(rows.indexOf(m), 1);
      feed.push({ type: "message", op: "delete", id: m.id, seq: ++seq, updatedAt: NOW.toISOString() });
    },
    /** A message leaves the store and the feed says nothing a walk could read — another device's delete. */
    drop(m: EngineMessage): void {
      rows.splice(rows.indexOf(m), 1);
    },
    /** A later word on a row the mirror holds — not an arrival. */
    touch(m: EngineMessage): void {
      feed.push({ type: "message", op: "update", id: m.id, seq: ++seq, updatedAt: NOW.toISOString(), entity: { ...m, unread: true } });
    },
  };
}

const settle = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const idAt = (w: StoreTimelineWalker, i: number): string | null => {
  const r = w.rowAt(i, []);
  return r === null || r === "gone" ? null : r.id;
};

describe("an open History shows mail that reaches the store while it is open", () => {
  it("after one drain the new message is in slot 0 and the old top one slot lower; a reopen reads the same", async () => {
    const s = await liveStore(120);
    const walker = new StoreTimelineWalker(s.engine);
    walker.start();
    await settle();
    expect(walker.state()).toBe("ready");
    expect(idAt(walker, 0)).toBe(id(0));
    expect(walker.total()).toBe(120);

    s.arrive(msg(-1, NOW.toISOString()));
    await s.engine.syncOnce();
    await settle();
    expect(idAt(walker, 0), "the open list, after one drain").toBe(id(-1));
    expect(idAt(walker, 1)).toBe(id(0));
    expect(walker.total()).toBe(121);
    expect(walker.length(0)).toBe(121);
    expect(walker.shifted()).toBe(1);

    // THE REOPEN CONTROL: a new visit reads the store's present — the list the open one now shows.
    walker.stop();
    walker.start();
    await settle();
    expect(idAt(walker, 0)).toBe(id(-1));
    expect(idAt(walker, 1)).toBe(id(0));
    walker.stop();
  });

  /* THE ARRIVAL KEY, not the header: mail whose `Date:` is a
     year old arrives now and the store places it first by arrival. With page one out of the cache,
     the shift is counted as the rows newer than the old top (`newerThan`) — by the store's key, or
     the reader's deep pages would not move for it. */
  /* THE ANCHOR IS THE HEADER AND THE ID (the new-client-on-an-older-server half): a
     server from before the arrival key pages by header date, so a next page is asked below the last
     row's HEADER date — a server with the key reads the named row's own key and ignores it. */
  it("a next page is asked below the last row's header date and id, whatever its arrival", async () => {
    const stale = "2025-01-01T00:00:00.000Z";
    const s = await liveStore(200, 20, (rows) => {
      for (const i of [49, 99]) rows[i] = { ...rows[i]!, sortAt: rows[i]!.date!, date: stale };
    });
    const walker = new StoreTimelineWalker(s.engine);
    walker.start();
    await settle();
    for (let i = 0; i < 20 && idAt(walker, 120) === null; i++) {
      walker.want(100, 130);
      await settle();
    }
    const anchors = s.asked.filter((a): a is StoreKeyset => a !== null && (a.id === id(49) || a.id === id(99)));
    expect(anchors.length, "no page was asked below a stale-dated row").toBeGreaterThan(0);
    for (const a of anchors) expect(a.date, "the anchor carried the arrival key, not the header").toBe(stale);
    walker.stop();
  });

  it("deep enough that page one left the cache, a stale-dated arrival still moves the reader's pages", async () => {
    const s = await liveStore(500);
    const walker = new StoreTimelineWalker(s.engine);
    walker.start();
    await settle();
    for (const [lo, hi, slot] of [[300, 320, 310], [340, 360, 350], [260, 280, 270]] as const) {
      for (let i = 0; i < 20 && idAt(walker, slot) === null; i++) {
        walker.want(lo, hi);
        await settle();
      }
    }
    expect(s.engine.peekStorePage("all"), "page one was evicted by the deep pages").toBeUndefined();
    s.arrive({ ...msg(-1, "2025-01-01T00:00:00.000Z"), sortAt: NOW.toISOString() });
    await s.engine.syncOnce();
    await settle();
    expect(walker.shifted(), "the arrival was read as older than the old top").toBe(1);
    expect(idAt(walker, 311)).toBe(id(310));
    walker.want(0, 20);
    await settle();
    expect([0, 1].map((i) => idAt(walker, i))).toEqual([id(-1), id(0)]);
    walker.stop();
  });

  it("a page held deep in the list keeps its rows one slot lower, and is not asked again", async () => {
    const s = await liveStore(400);
    const walker = new StoreTimelineWalker(s.engine);
    walker.start();
    await settle();
    for (let i = 0; i < 20 && idAt(walker, 220) === null; i++) {
      walker.want(210, 230);
      await settle();
    }
    expect(idAt(walker, 220)).toBe(id(220));
    const before = s.asked.length;

    s.arrive(msg(-1, NOW.toISOString()));
    await s.engine.syncOnce();
    await settle();
    expect(idAt(walker, 221), "the row that was under the reader, one slot lower").toBe(id(220));
    expect(idAt(walker, 220)).toBe(id(219));
    expect(idAt(walker, 0)).toBe(id(-1));
    // One request: page one, uncached. The deep page stays where the cache holds it.
    expect(s.asked.slice(before)).toEqual([null]);
    walker.stop();
  });

  it("several arrivals in one drain move every slot by their count, and the rows between pages are asked", async () => {
    const s = await liveStore(200);
    const walker = new StoreTimelineWalker(s.engine);
    walker.start();
    await settle();
    s.arrive(msg(-1, NOW.toISOString()));
    s.arrive(msg(-2, new Date(NOW.getTime() + 60_000).toISOString()));
    s.arrive(msg(-3, new Date(NOW.getTime() + 120_000).toISOString()));
    await s.engine.syncOnce();
    await settle();
    expect(walker.shifted()).toBe(3);
    expect([0, 1, 2, 3].map((i) => idAt(walker, i))).toEqual([id(-3), id(-2), id(-1), id(0)]);
    // The old page one's last rows now sit past the new page one: the walk reads them on its way.
    for (let i = 0; i < 10 && idAt(walker, 52) === null; i++) {
      walker.want(40, 60);
      await settle();
    }
    expect(idAt(walker, 52)).toBe(id(49));
    walker.stop();
  });

  it("deep enough that page one left the cache, the reader's pages move down and stay held", async () => {
    const s = await liveStore(500);
    const walker = new StoreTimelineWalker(s.engine);
    walker.start();
    await settle();
    for (const [lo, hi, slot] of [[300, 320, 310], [340, 360, 350], [260, 280, 270]] as const) {
      for (let i = 0; i < 20 && idAt(walker, slot) === null; i++) {
        walker.want(lo, hi);
        await settle();
      }
    }
    expect(s.engine.peekStorePage("all"), "page one was evicted by the deep pages").toBeUndefined();
    const before = s.asked.length;

    s.arrive(msg(-1, NOW.toISOString()));
    await s.engine.syncOnce();
    await settle();
    expect(idAt(walker, 311)).toBe(id(310));
    expect(idAt(walker, 351)).toBe(id(350));
    expect(s.asked.slice(before), "the fresh top only — no page the reader holds is asked again").toEqual([null]);
    expect(idAt(walker, 0), "page one is asked when the window nears it").toBeNull();
    walker.want(0, 20);
    await settle();
    expect([0, 1].map((i) => idAt(walker, i))).toEqual([id(-1), id(0)]);
    walker.stop();
  });

  it("the top asked as the reader heads up, answering after an arrival, lands one slot lower", async () => {
    const s = await liveStore(500);
    const walker = new StoreTimelineWalker(s.engine);
    walker.start();
    await settle();
    for (const [lo, hi, slot] of [[300, 320, 310], [340, 360, 350], [260, 280, 270]] as const) {
      for (let i = 0; i < 20 && idAt(walker, slot) === null; i++) {
        walker.want(lo, hi);
        await settle();
      }
    }
    expect(s.engine.peekStorePage("all")).toBeUndefined();
    // The reader heads for the top: the month's first page is read BEFORE the arrival, answers after it.
    const answer = s.holdNext();
    walker.want(0, 20);
    await settle();
    s.arrive(msg(-1, NOW.toISOString()));
    await s.engine.syncOnce();
    await settle();
    answer();
    await settle();
    walker.want(0, 20);
    await settle();
    expect([0, 1, 2].map((i) => idAt(walker, i))).toEqual([id(-1), id(0), id(1)]);
    walker.stop();
  });

  it("an older message arriving inside page one takes its own place; the rows below it move one slot", async () => {
    const s = await liveStore(60);
    const walker = new StoreTimelineWalker(s.engine);
    walker.start();
    await settle();
    // Row i is (i + 1) hours old: 30.5 hours sorts between rows 29 and 30.
    s.arrive(msg(1_000, new Date(NOW.getTime() - 30.5 * 3_600_000).toISOString()));
    await s.engine.syncOnce();
    await settle();
    expect([29, 30, 31].map((i) => idAt(walker, i))).toEqual([id(29), id(1_000), id(30)]);
    expect(walker.length(0)).toBe(61);
    expect(walker.shifted(), "every row below page one moved one slot").toBe(1);
    for (let i = 0; i < 10 && idAt(walker, 60) === null; i++) {
      walker.want(52, 61);
      await settle();
    }
    expect(idAt(walker, 60), "the oldest message is the list's last row").toBe(id(59));
    walker.stop();
  });

  it("a message deleted in page one, then an arrival: no row is lost and the oldest is the last", async () => {
    const s = await liveStore(60);
    const walker = new StoreTimelineWalker(s.engine);
    walker.start();
    await settle();
    s.remove(s.rows[5]!);
    await s.engine.syncOnce();
    await settle();
    // A delete is a change of the store's list: page one is read again and the rows below move up.
    expect(idAt(walker, 5)).toBe(id(6));
    expect(walker.length(0)).toBe(59);
    s.arrive(msg(-1, NOW.toISOString()));
    await s.engine.syncOnce();
    await settle();
    expect([0, 1, 5, 6].map((i) => idAt(walker, i))).toEqual([id(-1), id(0), id(4), id(6)]);
    expect(walker.length(0)).toBe(60);
    expect(walker.shifted(), "the new row took the deleted one's place: nothing below moved").toBe(0);
    for (let i = 0; i < 10 && idAt(walker, 59) === null; i++) {
      walker.want(52, 60);
      await settle();
    }
    expect(idAt(walker, 59)).toBe(id(59));
    walker.stop();
  });

  it("a change below page one the walk has not read takes the store's frame, the drawn rows standing", async () => {
    const s = await liveStore(120);
    const walker = new StoreTimelineWalker(s.engine);
    walker.start();
    await settle();
    s.drop(s.rows[90]!);
    s.arrive(msg(-1, NOW.toISOString()));
    await s.engine.syncOnce();
    await settle();
    expect(idAt(walker, 0)).toBe(id(-1));
    // the store's months and total, in this visit.
    expect(walker.length(0), "the visit kept its own frame").toBe(120);
    expect(walker.total()).toBe(120);
    expect(idAt(walker, 1), "a drawn row went while its page was asked again").toBe(id(0));
    walker.stop();
    walker.start();
    await settle();
    expect(walker.total(), "the next visit reads the same").toBe(120);
    walker.stop();
  });

  it("more than a page of new mail in one drain: every held row moves down by all of it", async () => {
    const s = await liveStore(200);
    const walker = new StoreTimelineWalker(s.engine);
    walker.start();
    await settle();
    for (let n = 1; n <= 70; n++) s.arrive(msg(-n, new Date(NOW.getTime() + n * 60_000).toISOString()));
    await s.engine.syncOnce();
    await settle();
    expect(walker.shifted()).toBe(70);
    expect(walker.length(0)).toBe(270);
    expect(idAt(walker, 0)).toBe(id(-70));
    for (let i = 0; i < 10 && idAt(walker, 70) === null; i++) {
      walker.want(60, 80);
      await settle();
    }
    expect(idAt(walker, 70), "the old top, 70 slots lower").toBe(id(0));
    walker.stop();
  });

  it("a coalesced page carrying the new message as an update is an arrival too", async () => {
    const s = await liveStore(60);
    const walker = new StoreTimelineWalker(s.engine);
    walker.start();
    await settle();
    s.arrive(msg(-1, NOW.toISOString()), "update");
    await s.engine.syncOnce();
    await settle();
    expect(idAt(walker, 0)).toBe(id(-1));
    walker.stop();
  });

  it("a drain that brings only a later word on a held row asks the store nothing", async () => {
    const s = await liveStore(60);
    const walker = new StoreTimelineWalker(s.engine);
    walker.start();
    await settle();
    const before = s.asked.length;
    s.touch(s.rows[0]!);
    await s.engine.syncOnce();
    await settle();
    expect(s.asked.length).toBe(before);
    expect(walker.shifted()).toBe(0);
    walker.stop();
  });

  it("a closed History asks nothing when mail arrives", async () => {
    const s = await liveStore(60);
    const walker = new StoreTimelineWalker(s.engine);
    walker.start();
    await settle();
    walker.stop();
    const before = s.asked.length;
    s.arrive(msg(-1, NOW.toISOString()));
    await s.engine.syncOnce();
    await settle();
    expect(s.asked.length).toBe(before);
  });
});
