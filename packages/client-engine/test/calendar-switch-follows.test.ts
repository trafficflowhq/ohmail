import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore, NAMED_FEED_KINDS, OhmailEngine, encodeSeqCursor,
  type EngineAdapter, type MutationOutcome, type SyncChange, type SyncResponse, type SyncSnapshotPage,
} from "../src/index.js";
import type { CalendarWindow } from "@ohmail/wire";

/**
 * THE ENGINE FOLLOWS THE ACCOUNT'S CALENDAR SWITCH. The feed sends calendar records only while the
 * switch is on, so a switch going on (or on again at a new instant) is a calendar the engine must
 * read as it stands, and a switch going off is one it lets go. It names every kind it keeps on
 * every feed request, the settings record and the calendar's included, or it would hear of neither.
 * A span read on purpose is kept by the prune; the window a server states is the one the prune keeps.
 */

const NOW = new Date("2026-07-27T12:00:00.000Z");
const DAY = 86_400_000;
const day = (n: number): string => new Date(NOW.getTime() + n * DAY).toISOString();
const WINDOW: CalendarWindow = { daysBack: 366, daysAhead: 731, maxRows: 10_000 };

const settings = (seq: number, at: string | null | undefined): SyncChange => ({
  type: "settings", op: "update", id: "acct", seq, updatedAt: NOW.toISOString(),
  entity: { accountId: "acct", locale: null, ...(at === undefined ? {} : { calendarEnabledAt: at }), updatedAt: NOW.toISOString() },
});
const event = (id: string, startDay: number, seq: number): SyncChange => ({
  type: "calendar_event", op: "create", id, seq, updatedAt: NOW.toISOString(),
  entity: { id, calendarId: "k1", startsAt: day(startDay), endsAt: day(startDay + 0.1), occurrenceAt: null, thisAndFuture: false },
});
const connection = (seq: number): SyncChange =>
  ({ type: "calendar_connection", op: "create", id: "c1", seq, updatedAt: NOW.toISOString(), entity: { id: "c1" } });
const page = (changes: SyncChange[], cursor: string): SyncResponse =>
  ({ changes: { creates: changes, updates: [], moves: [], deletes: [] }, cursor, hasMore: false, serverTime: NOW.toISOString() });

/** A server: its feed pages in order, and its calendar's first load, as a test sets them. */
function server() {
  const seen = { sync: [] as Array<{ since: string; types?: readonly string[] }>, snapshot: [] as Array<Record<string, unknown>> };
  const feed: SyncResponse[] = [];
  let calendar: { asOfSeq: number; changes: SyncChange[] } | null = null;
  let calendarRefusals = 0;
  let cursor = 10;
  const adapter = {
    sync: async (p: { since: string; types?: readonly string[] }): Promise<SyncResponse> => {
      seen.sync.push(p);
      return feed.shift() ?? page([], encodeSeqCursor(cursor));
    },
    snapshot: async (p: Record<string, unknown> = {}): Promise<SyncSnapshotPage> => {
      seen.snapshot.push(p);
      if (p.phase === "calendar" && calendarRefusals > 0) {
        calendarRefusals -= 1;
        throw new Error("the connection dropped");
      }
      if (p.phase === "calendar" && calendar !== null) {
        return { asOfSeq: calendar.asOfSeq, changes: calendar.changes, nextCursor: null, window: { days: 90, minRows: 500 }, calendarWindow: WINDOW };
      }
      return { asOfSeq: cursor, changes: [], nextCursor: null, window: { days: 90, minRows: 500 } };
    },
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    fetchBody: async () => null,
  } as unknown as EngineAdapter;
  return {
    adapter, seen,
    next: (changes: SyncChange[]) => { cursor += 1; feed.push(page(changes, encodeSeqCursor(cursor))); },
    serveCalendar: (changes: SyncChange[]) => { calendar = { asOfSeq: cursor, changes }; },
    /** The calendar's next `n` reads fail, as a dropped connection does. */
    refuseCalendar: (n: number) => { calendarRefusals = n; },
    calendarReads: () => seen.snapshot.filter((p) => p.phase === "calendar").length,
    cursorNow: () => encodeSeqCursor(cursor),
  };
}

/**
 * A mirror that already drained once, holding the settings record `held` states: its first load
 * read the calendar with the rest wherever the switch was on.
 */
async function warm(held: string | null | undefined): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  const first = new OhmailEngine({
    adapter: {
      sync: async () => page([], encodeSeqCursor(10)),
      snapshot: async (): Promise<SyncSnapshotPage> => ({
        asOfSeq: 10, changes: [settings(10, held)], nextCursor: null, window: { days: 90, minRows: 500 },
        ...(typeof held === "string" ? { calendarWindow: WINDOW } : {}),
      }),
      mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
      fetchBody: async () => null,
    } as unknown as EngineAdapter,
    store, now: () => NOW,
  });
  await first.syncOnce();
  return store;
}

const live = (store: MemoryMirrorStore, type: string): string[] =>
  store.entries(type).filter((r) => r.entity !== null).map((r) => r.id).sort();

describe("every feed request names the engine's kinds", () => {
  it("the delta and the first load both name the declared list and the settings record", async () => {
    const s = server();
    const engine = new OhmailEngine({ adapter: s.adapter, store: new MemoryMirrorStore(), now: () => NOW });
    await engine.syncOnce();
    expect(s.seen.snapshot[0]?.types).toEqual([...NAMED_FEED_KINDS]);
    for (const call of s.seen.sync) expect(call.types).toEqual([...NAMED_FEED_KINDS]);
    for (const kind of ["settings", "calendar_connection", "calendar", "calendar_event", "calendar_suggestion", "message"]) {
      expect(NAMED_FEED_KINDS as readonly string[]).toContain(kind);
    }
  });
});

describe("the switch, followed", () => {
  it("going on reads the calendar as it stands, rows only: the delta's cursor is the feed's", async () => {
    const s = server();
    const store = await warm(null);
    const engine = new OhmailEngine({ adapter: s.adapter, store, now: () => NOW });
    s.serveCalendar([connection(11), event("e1", 1, 11)]);
    s.next([settings(11, day(0))]);
    await engine.syncOnce();
    expect(s.seen.snapshot.filter((p) => p.phase === "calendar")).toHaveLength(1);
    expect(s.seen.snapshot.find((p) => p.phase === "calendar")?.types).toEqual([...NAMED_FEED_KINDS]);
    expect(live(store, "calendar_event")).toEqual(["e1"]);
    expect(live(store, "calendar_connection")).toEqual(["c1"]);
    expect(store.getCursor()).toBe(encodeSeqCursor(11));
    // Read once: a poll with nothing new asks the calendar nothing.
    await engine.syncOnce();
    expect(s.seen.snapshot.filter((p) => p.phase === "calendar")).toHaveLength(1);
  });

  it("going off lets every calendar record go", async () => {
    const s = server();
    const store = await warm(day(0));
    await store.applyChanges([connection(6), event("e1", 1, 6)]);
    const engine = new OhmailEngine({ adapter: s.adapter, store, now: () => NOW });
    s.next([settings(11, null)]);
    await engine.syncOnce();
    expect(live(store, "calendar_event")).toEqual([]);
    expect(live(store, "calendar_connection")).toEqual([]);
    expect(s.seen.snapshot.filter((p) => p.phase === "calendar")).toEqual([]);
  });

  it("on again at a new instant: what it held goes, and the calendar is read again", async () => {
    const s = server();
    const store = await warm(day(-3));
    await store.applyChanges([connection(6), event("stale", 1, 6)]);
    const engine = new OhmailEngine({ adapter: s.adapter, store, now: () => NOW });
    s.serveCalendar([connection(11), event("e2", 2, 11)]);
    s.next([settings(11, day(0))]);
    await engine.syncOnce();
    expect(live(store, "calendar_event")).toEqual(["e2"]);
  });

  it("a read cut short is owed to the next engine over the same mirror: a reload, a crash, a phone gone offline", async () => {
    const s = server();
    const store = await warm(null);
    s.serveCalendar([connection(11), event("e1", 1, 11)]);
    s.refuseCalendar(1);
    s.next([settings(11, day(0))]);
    const first = new OhmailEngine({ adapter: s.adapter, store, now: () => NOW });
    await first.syncOnce();
    expect(s.calendarReads()).toBe(1);
    expect(live(store, "calendar_event")).toEqual([]);
    // The page that moved the switch is stored and the cursor is past it; nothing else will say it.
    const next = new OhmailEngine({ adapter: s.adapter, store, now: () => NOW });
    await next.syncOnce();
    expect(live(store, "calendar_event")).toEqual(["e1"]);
    expect(live(store, "calendar_connection")).toEqual(["c1"]);
    // Read whole now: an idle drain asks the calendar nothing more, nor does a later engine.
    const reads = s.calendarReads();
    await next.syncOnce();
    await new OhmailEngine({ adapter: s.adapter, store, now: () => NOW }).syncOnce();
    expect(s.calendarReads()).toBe(reads);
  });

  it("a mirror that holds the switch's instant and none of the calendar reads it (a build before this one drained the flip)", async () => {
    const s = server();
    const store = new MemoryMirrorStore();
    await store.load();
    await store.applyResponse(page([settings(10, day(0))], encodeSeqCursor(10)) as never);
    s.serveCalendar([event("e1", 1, 10)]);
    const engine = new OhmailEngine({ adapter: s.adapter, store, now: () => NOW });
    await engine.syncOnce();
    expect(live(store, "calendar_event")).toEqual(["e1"]);
  });

  it("a first load that read the calendar owes no second read", async () => {
    const s = server();
    const store = new MemoryMirrorStore();
    const engine = new OhmailEngine({
      adapter: {
        ...s.adapter,
        snapshot: async (p: Record<string, unknown> = {}): Promise<SyncSnapshotPage> => {
          s.seen.snapshot.push(p);
          return {
            asOfSeq: 10, changes: [settings(10, day(0)), connection(10), event("e1", 1, 10)], nextCursor: null,
            window: { days: 90, minRows: 500 }, calendarWindow: WINDOW,
          };
        },
      } as EngineAdapter,
      store, now: () => NOW,
    });
    await engine.syncOnce();
    await engine.syncOnce();
    expect(live(store, "calendar_event")).toEqual(["e1"]);
    expect(s.calendarReads()).toBe(0);
  });

  it("with no first load to read, the calendar the delta brings is kept", async () => {
    const s = server();
    const store = new MemoryMirrorStore();
    // A door without the snapshot's route: the replay from the start is the only road.
    const engine = new OhmailEngine({ adapter: { ...s.adapter, snapshot: undefined } as EngineAdapter, store, now: () => NOW });
    s.next([settings(11, day(0)), connection(11), event("e1", 1, 11)]);
    await engine.syncOnce();
    await engine.syncOnce();
    expect(live(store, "calendar_event")).toEqual(["e1"]);
  });

  it("a server that says nothing of the switch, and then says it, is a switch going on", async () => {
    const s = server();
    const store = await warm(undefined);
    const engine = new OhmailEngine({ adapter: s.adapter, store, now: () => NOW });
    s.serveCalendar([event("e1", 1, 11)]);
    s.next([settings(11, undefined)]);
    await engine.syncOnce();
    expect(live(store, "calendar_event")).toEqual([]);
    s.next([settings(12, day(0))]);
    await engine.syncOnce();
    expect(live(store, "calendar_event")).toEqual(["e1"]);
  });
});

describe("a span read on purpose, and the window a server states", () => {
  it("loadCalendar(span) reads its days and the prune keeps them; the window's far side still goes", async () => {
    const s = server();
    const store = await warm(day(0));
    const engine = new OhmailEngine({ adapter: s.adapter, store, now: () => NOW });
    s.serveCalendar([event("long-ago", -500, 10)]);
    expect(await engine.loadCalendar({ from: day(-600), to: day(-400) })).toBe(true);
    const asked = s.seen.snapshot.find((p) => p.phase === "calendar")!;
    expect([asked.from, asked.to]).toEqual([day(-600), day(-400)]);
    await store.applyChanges([event("unasked", -800, 12)]);
    await engine.syncOnce();
    expect(live(store, "calendar_event")).toEqual(["long-ago"]);
    expect(store.getCursor()).toBe(encodeSeqCursor(10));
  });

  it("a first load's stated window is the span the prune keeps", async () => {
    const s = server();
    const narrow: CalendarWindow = { daysBack: 10, daysAhead: 10, maxRows: 100 };
    const store = new MemoryMirrorStore();
    const engine = new OhmailEngine({
      adapter: {
        ...s.adapter,
        snapshot: async (): Promise<SyncSnapshotPage> => ({
          asOfSeq: 10, changes: [event("near", 2, 10), event("far", 40, 10)], nextCursor: null,
          window: { days: 90, minRows: 500 }, calendarWindow: narrow,
        }),
      } as EngineAdapter,
      store, now: () => NOW,
    });
    await engine.syncOnce();
    expect(live(store, "calendar_event")).toEqual(["near"]);
  });
});
