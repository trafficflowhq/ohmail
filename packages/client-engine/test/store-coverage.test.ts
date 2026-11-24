import type { EngineMessage, MutationOutcome } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  HttpAdapter,
  MemoryMirrorStore,
  OhmailEngine,
  mirrorCoverage,
  uuidSuccessor,
  type EngineAdapter,
  type StoreTimeline,
  type SyncChange,
  type SyncResponse,
} from "../src/index.js";

/**
 * WHETHER THE STORE HOLDS MAIL THIS MIRROR DOES NOT — the store's own timeline, counted against
 * the mirror per month. The window POLICY said "windowed" over a browser holding
 * every one of an account's few thousand messages, and the Ohbox offered older mail that did not exist.
 */

const NOW = new Date("2026-09-27T09:00:00.000Z");
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function msg(n: number, date: string | null): EngineMessage {
  return {
    id: id(n), accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${n}`, from: { name: null, address: "sender@example.test" }, to: [], cc: [],
    date: date as string, folder: "INBOX", snippet: "", unread: false, hasAttachments: false,
    attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: NOW.toISOString(),
  };
}

/** The store's timeline over a list of rows, the server's own shape (months newest first). */
function timelineOf(rows: EngineMessage[]): StoreTimeline {
  const sorted = [...rows].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "") || (a.id < b.id ? 1 : -1));
  const months: StoreTimeline["months"] = [];
  let undated = 0;
  for (const m of sorted) {
    if (!m.date) { undated += 1; continue; }
    const last = months[months.length - 1];
    if (last?.month === m.date.slice(0, 7)) last.count += 1;
    else months.push({ month: m.date.slice(0, 7), count: 1, first: { date: m.date, id: m.id } });
  }
  return { total: sorted.length, months, undated };
}

const SEPT = [msg(9, "2026-09-20T09:00:00.000Z"), msg(8, "2026-09-02T09:00:00.000Z")];
const AUG = [msg(7, "2026-08-30T09:00:00.000Z"), msg(6, "2026-08-01T09:00:00.000Z")];
const MARCH = [msg(5, "2026-03-15T09:00:00.000Z")];

describe("mirrorCoverage — the mirror counted against the store's months", () => {
  it("a mirror holding every row the store has is whole", () => {
    expect(mirrorCoverage(timelineOf([...SEPT, ...AUG]), [...SEPT, ...AUG])).toEqual({ whole: true });
  });

  it("an empty store is whole: there is nothing older to offer", () => {
    expect(mirrorCoverage({ total: 0, months: [], undated: 0 }, [])).toEqual({ whole: true });
  });

  it("the first short month is where a reach-past page starts, AT its newest row", () => {
    // The store holds March too; the mirror stops at August. MUTATION: `have < s.count` →
    // `have <= s.count` reads every held month as short and answers September's start.
    const got = mirrorCoverage(timelineOf([...SEPT, ...AUG, ...MARCH]), [...SEPT, ...AUG]);
    expect(got).toEqual({ whole: false, below: { date: MARCH[0]!.date, id: uuidSuccessor(MARCH[0]!.id) } });
  });

  it("a month the mirror holds only part of is short, even with later months whole", () => {
    const got = mirrorCoverage(timelineOf([...SEPT, ...AUG, ...MARCH]), [...SEPT, AUG[0]!, ...MARCH]);
    expect(got).toEqual({ whole: false, below: { date: AUG[0]!.date, id: uuidSuccessor(AUG[0]!.id) } });
  });

  it("mail that arrived after the store was asked does not make a month short", () => {
    const later = msg(10, "2026-09-26T09:00:00.000Z");
    expect(mirrorCoverage(timelineOf([...SEPT, ...AUG]), [later, ...SEPT, ...AUG])).toEqual({ whole: true });
  });

  it("the undated tail is counted apart, and a short one is the last place to look", () => {
    const undated = msg(1, null);
    expect(mirrorCoverage(timelineOf([...SEPT, undated]), [...SEPT])).toEqual({
      whole: false, below: { date: null, id: "ffffffff-ffff-ffff-ffff-ffffffffffff" },
    });
    expect(mirrorCoverage(timelineOf([...SEPT, undated]), [...SEPT, undated])).toEqual({ whole: true });
  });
});

/** An adapter with the two store doors, a `/sync` feed the test drives, and a timeline it names. */
function storeAdapter(): EngineAdapter & {
  feed: SyncChange[][];
  store: EngineMessage[];
  timelineAnswer: "store" | "refuse";
  asks: number;
} {
  const a = {
    feed: [] as SyncChange[][],
    store: [] as EngineMessage[],
    timelineAnswer: "store" as "store" | "refuse",
    asks: 0,
    sync: async (): Promise<SyncResponse> => {
      const creates = a.feed.shift() ?? [];
      return {
        changes: { creates: creates.filter((c) => c.op !== "delete"), updates: [], moves: [], deletes: creates.filter((c) => c.op === "delete") },
        cursor: `c${Date.now()}${Math.random()}`, hasMore: false, serverTime: NOW.toISOString(),
      };
    },
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: async () => null,
    listMessages: async () => ({ items: [], nextCursor: null }),
    timeline: async (): Promise<StoreTimeline | null> => {
      a.asks += 1;
      if (a.timelineAnswer === "refuse") throw new Error("503");
      return timelineOf(a.store);
    },
  };
  return a as unknown as ReturnType<typeof storeAdapter>;
}

let seq = 0;
const create = (m: EngineMessage): SyncChange =>
  ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: NOW.toISOString(), entity: m });
const remove = (m: EngineMessage): SyncChange =>
  ({ type: "message", op: "delete", id: m.id, seq: ++seq, updatedAt: NOW.toISOString(), entity: null });

const WINDOW = { mode: "windowed", days: 90, minRows: 5000, maxRows: 10000 } as const;

describe("the engine asks the store, and says so", () => {
  it("a client with no timeline door cannot say, and a surface keeps offering", () => {
    const engine = new OhmailEngine({
      adapter: {
        sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "c", hasMore: false, serverTime: NOW.toISOString() }),
        mutate: async () => ({ changes: [], seq: null }),
        withdrawSend: async () => ({ outcome: "unsupported" as const }),
        fetchBody: async () => null,
        listMessages: async () => ({ items: [], nextCursor: null }),
      } as EngineAdapter,
      store: new MemoryMirrorStore(), storePolicy: WINDOW, now: () => NOW,
    });
    expect(engine.storeCoverage()).toEqual({ state: "unknown" });
  });

  it("unread until asked; whole over a windowed mirror that holds the whole store", async () => {
    const adapter = storeAdapter();
    adapter.store = [...SEPT, ...AUG];
    adapter.feed.push(adapter.store.map(create));
    const engine = new OhmailEngine({ adapter, store: new MemoryMirrorStore(), storePolicy: WINDOW, now: () => NOW });
    await engine.syncOnce();

    expect(engine.storeCoverage()).toEqual({ state: "unread" });
    expect(await engine.readStoreCoverage()).toEqual({ state: "whole" });
  });

  it("partial where the store holds older mail, with the edge a page starts at", async () => {
    const adapter = storeAdapter();
    adapter.store = [...SEPT, ...AUG, ...MARCH];
    adapter.feed.push([...SEPT, ...AUG].map(create));
    const engine = new OhmailEngine({ adapter, store: new MemoryMirrorStore(), storePolicy: WINDOW, now: () => NOW });
    await engine.syncOnce();

    expect(await engine.readStoreCoverage()).toEqual({
      state: "partial", below: { date: MARCH[0]!.date, id: uuidSuccessor(MARCH[0]!.id) },
    });
  });

  it("a whole answer the mirror stops matching is owed a re-ask, and the re-ask settles it", async () => {
    const adapter = storeAdapter();
    adapter.store = [...SEPT, ...AUG];
    adapter.feed.push(adapter.store.map(create));
    const engine = new OhmailEngine({ adapter, store: new MemoryMirrorStore(), storePolicy: WINDOW, now: () => NOW });
    await engine.syncOnce();
    expect(await engine.readStoreCoverage()).toEqual({ state: "whole" });

    // A delete: the mirror now holds one row fewer than the answer counted. MUTATION: answer
    // `partial` here instead of `unread` and the list offers older mail over a whole store.
    adapter.store = [SEPT[0]!, ...AUG];
    adapter.feed.push([remove(SEPT[1]!)]);
    await engine.syncOnce();
    expect(engine.storeCoverage()).toEqual({ state: "unread" });

    expect(await engine.readStoreCoverage()).toEqual({ state: "whole" });
    expect(adapter.asks).toBe(2);
  });

  it("a refused timeline cannot say, and never reads as whole", async () => {
    const adapter = storeAdapter();
    adapter.store = [...SEPT];
    adapter.timelineAnswer = "refuse";
    adapter.feed.push(adapter.store.map(create));
    const engine = new OhmailEngine({ adapter, store: new MemoryMirrorStore(), storePolicy: WINDOW, now: () => NOW });
    await engine.syncOnce();

    expect(await engine.readStoreCoverage()).toEqual({ state: "unknown" });
  });
});

describe("the Ohbox's page one carries the store's edge on the wire", () => {
  const answer = (): Response => new Response(JSON.stringify({ items: [], nextCursor: null }), {
    status: 200, headers: { "content-type": "application/json" },
  });

  it("a view page with no cursor starts strictly below the edge", async () => {
    // MUTATION: drop the `startBelow` arm from the view branch and the params go missing.
    const calls: string[] = [];
    const adapter = new HttpAdapter({ baseUrl: "/api", fetch: async (url) => { calls.push(url); return answer(); } });
    await adapter.listMessages("ohbox", { startBelow: { date: "2026-03-15T09:00:00.000Z", id: id(5) } });
    expect(calls).toEqual([
      `/api/messages?view=imbox&beforeDate=${encodeURIComponent("2026-03-15T09:00:00.000Z")}&beforeId=${id(5)}`,
    ]);
  });

  it("a cursor supersedes the edge, as it does for a folder", async () => {
    const calls: string[] = [];
    const adapter = new HttpAdapter({ baseUrl: "/api", fetch: async (url) => { calls.push(url); return answer(); } });
    await adapter.listMessages("ohbox", { cursor: "c1", startBelow: { date: null, id: id(5) } });
    expect(calls).toEqual(["/api/messages?view=imbox&cursor=c1"]);
  });
});
