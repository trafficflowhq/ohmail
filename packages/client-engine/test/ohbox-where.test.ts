import { describe, expect, it } from "vitest";
import {
  CHECKED_FACTS_MAX_AGE_MS,
  CursorExpiredError,
  FILED_PILES,
  FILED_SINCE_SCAN_MAX,
  MemoryMirrorStore,
  OHBOX_VISIT_ID,
  OUTBOX_TYPE,
  OhmailEngine,
  filedSinceVisit,
  lastCheckedAt,
  ohboxVisitMark,
  type EngineAdapter,
  type EngineMessage,
  type MutationOutcome,
  type OhboxVisitMeta,
  type SyncChange,
  type SyncResponse,
  type SyncSnapshotPage,
} from "../src/index.js";

/**
 * WHERE THE OHBOX'S MAIL WENT (row OHBOX-QUIET-READS-AS-STALLED): letters filed to News, Receipts,
 * Screened out and Spam since the person last left the Ohbox, counted over the mirror, and when
 * the mailboxes were last checked.
 */

const NOW = Date.parse("2026-10-19T12:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const MARK = NOW - 60 * 60_000;

let seq = 0;

function msg(id: string, at: number, folder: string, extra: Partial<EngineMessage> = {}): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: `${id}@example.test` }, to: [], cc: [],
    date: iso(at), folder: folder as EngineMessage["folder"], snippet: "", unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: iso(at),
    ...extra,
  };
}

function creates(messages: EngineMessage[]): SyncChange[] {
  return messages.map((m) => ({
    type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
  })) as SyncChange[];
}

async function storeOf(messages: EngineMessage[]): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(creates(messages));
  return store;
}

const visit = (at: number): OhboxVisitMeta => ({ at: iso(at) });
const countsOf = (r: ReturnType<typeof filedSinceVisit>) =>
  r === null ? null : Object.fromEntries(r.counts.map((c) => [c.pile, c.count]));

describe("filedSinceVisit", () => {
  it("counts each pile, the legacy News folder included, and nothing outside the four", async () => {
    const store = await storeOf([
      msg("n1", MARK + 1, "ohmail/News"),
      msg("n2", MARK + 2, "ohmail/Reads"),
      msg("r1", MARK + 3, "ohmail/Receipts"),
      msg("s1", MARK + 4, "ohmail/Screened"),
      msg("q1", MARK + 5, "ohmail/Quarantine"),
      msg("q2", MARK + 6, "ohmail/Quarantine"),
      msg("i1", MARK + 7, "INBOX"),
      msg("w1", MARK + 8, "ohmail/Screener"),
      msg("sent", MARK + 9, "Sent"),
      msg("own", MARK + 10, "Projects/2026"),
      msg("trash", MARK + 11, "Trash"),
    ]);
    const r = filedSinceVisit(store, visit(MARK), { nowMs: NOW });
    expect(r?.at).toBe(iso(MARK));
    expect(r?.counts).toEqual([
      { pile: "reads", count: 2 },
      { pile: "receipts", count: 1 },
      { pile: "screened", count: 1 },
      { pile: "spam", count: 2 },
    ]);
    expect(FILED_PILES).toEqual(["reads", "receipts", "screened", "spam"]);
  });

  it("a deleted letter is not counted", async () => {
    const store = await storeOf([msg("n1", MARK + 1, "ohmail/News"), msg("n2", MARK + 2, "ohmail/News")]);
    expect(countsOf(filedSinceVisit(store, visit(MARK), { nowMs: NOW }))).toEqual({ reads: 2 });
    await store.applyChanges([{ type: "message", op: "delete", id: "n2", seq: ++seq, updatedAt: iso(NOW), entity: null }] as SyncChange[]);
    expect(countsOf(filedSinceVisit(store, visit(MARK), { nowMs: NOW }))).toEqual({ reads: 1 });
  });

  it("a letter at the mark is not counted and one a millisecond later is", async () => {
    const at = await storeOf([msg("a", MARK, "ohmail/News"), msg("older", MARK - 1, "ohmail/News")]);
    expect(filedSinceVisit(at, visit(MARK), { nowMs: NOW })?.counts).toEqual([]);
    const after = await storeOf([msg("b", MARK + 1, "ohmail/News"), msg("older2", MARK - 1, "ohmail/News")]);
    expect(countsOf(filedSinceVisit(after, visit(MARK), { nowMs: NOW }))).toEqual({ reads: 1 });
  });

  it("reads the arrival key (sortAt) before the date", async () => {
    const store = await storeOf([msg("late", MARK - 10_000, "ohmail/News", { sortAt: iso(MARK + 5) })]);
    expect(countsOf(filedSinceVisit(store, visit(MARK), { nowMs: NOW }))).toEqual({ reads: 1 });
  });

  it("leaves out a person's own placement, held ids, far-future dates, own sent and away replies", async () => {
    const marked = await storeOf([
      msg("placed", MARK + 1, "ohmail/News", { placeDecided: true }),
      msg("held", MARK + 2, "ohmail/Receipts"),
      msg("future", NOW + 49 * 3_600_000, "ohmail/Screened"),
      msg("away", MARK + 3, "ohmail/Quarantine", { autoReplyByUs: true }),
    ]);
    const r = filedSinceVisit(marked, visit(MARK), { nowMs: NOW, exclude: new Set(["held"]) });
    expect(r?.counts).toEqual([]);
    // Positive control: the same letters without their markers count.
    const plain = await storeOf([
      msg("placed", MARK + 1, "ohmail/News"),
      msg("held", MARK + 2, "ohmail/Receipts"),
      msg("future", NOW + 47 * 3_600_000, "ohmail/Screened"),
      msg("away", MARK + 3, "ohmail/Quarantine"),
    ]);
    expect(countsOf(filedSinceVisit(plain, visit(MARK), { nowMs: NOW }))).toEqual({
      reads: 1, receipts: 1, screened: 1, spam: 1,
    });
  });

  it("answers an empty count when nothing was filed, and null without a mark", async () => {
    const store = await storeOf([msg("i1", MARK + 1, "INBOX"), msg("n0", MARK - 5, "ohmail/News")]);
    expect(filedSinceVisit(store, visit(MARK), { nowMs: NOW })).toEqual({ at: iso(MARK), counts: [] });
    expect(filedSinceVisit(store, undefined, { nowMs: NOW })).toBeNull();
    expect(filedSinceVisit(store, { at: "not a date" }, { nowMs: NOW })).toBeNull();
  });

  it("states no partial count past the scan bound", async () => {
    const rows = Array.from({ length: FILED_SINCE_SCAN_MAX }, (_, i) => msg(`m${i}`, MARK + 1 + i, "ohmail/News"));
    const full = await storeOf(rows);
    expect(countsOf(filedSinceVisit(full, visit(MARK), { nowMs: NOW }))).toEqual({ reads: FILED_SINCE_SCAN_MAX });
    await full.applyChanges(creates([msg("one-more", MARK + 1 + FILED_SINCE_SCAN_MAX, "INBOX")]));
    expect(filedSinceVisit(full, visit(MARK), { nowMs: NOW })).toBeNull();
  });
});

describe("counted by the recorded arrival, not the sender's Date", () => {
  const H = 3_600_000;
  /** A letter the server recorded at `arrived`, its header (and so its sort instant) `skew` off it. */
  const arrival = (id: string, arrived: number, folder: string, skew = 0): EngineMessage =>
    msg(id, arrived + skew, folder, { sortAt: iso(arrived + skew), arrivedAt: iso(arrived) });

  it("a header ten hours ahead is counted on the first visit after it came and on no later one", async () => {
    // Device clock at, ahead of and behind the server's.
    for (const clockSkew of [0, 10 * 60_000, -10 * 60_000]) {
      const store = await storeOf([arrival("old", MARK - H, "INBOX")]);
      let mark = ohboxVisitMark(store, MARK + clockSkew);
      await store.applyChanges(creates([arrival("fwd", MARK + 5 * 60_000, "ohmail/News", 10 * H)]));
      const nowMs = MARK + H + clockSkew;
      expect(countsOf(filedSinceVisit(store, { at: mark }, { nowMs })), `first visit, skew ${clockSkew}`).toEqual({ reads: 1 });
      mark = ohboxVisitMark(store, nowMs);
      for (const later of [2 * H, 3 * H, 9 * H]) {
        const r = filedSinceVisit(store, { at: mark }, { nowMs: MARK + later + clockSkew });
        expect(r?.counts, `visit at +${later / H} h, skew ${clockSkew}`).toEqual([]);
        mark = ohboxVisitMark(store, MARK + later + clockSkew);
      }
    }
  });

  it("a letter the server recorded just before a leave on a slow device clock is not counted again", async () => {
    const store = await storeOf([arrival("just", MARK, "ohmail/Quarantine")]);
    const mark = ohboxVisitMark(store, MARK - 10 * 60_000);
    expect(mark).toBe(iso(MARK));
    expect(filedSinceVisit(store, { at: mark }, { nowMs: MARK - 5 * 60_000 })?.counts).toEqual([]);
  });

  it("a letter delayed in transit, its header older than the mark, is counted when it arrives", async () => {
    const store = await storeOf([arrival("held", MARK, "INBOX")]);
    const mark = ohboxVisitMark(store, MARK + 60_000);
    await store.applyChanges(creates([arrival("late", MARK + 30 * 60_000, "ohmail/News", -6 * H)]));
    expect(countsOf(filedSinceVisit(store, { at: mark }, { nowMs: MARK + H }))).toEqual({ reads: 1 });
  });

  it("the arrival at the mark is not counted and one a millisecond later is", async () => {
    const at = await storeOf([arrival("a", MARK, "ohmail/News", 3 * H)]);
    expect(filedSinceVisit(at, visit(MARK), { nowMs: NOW })?.counts).toEqual([]);
    const after = await storeOf([arrival("b", MARK + 1, "ohmail/News", -3 * H)]);
    expect(countsOf(filedSinceVisit(after, visit(MARK), { nowMs: NOW }))).toEqual({ reads: 1 });
  });

  it("the mark is the newest recorded arrival, past the newest sort instant", async () => {
    const store = await storeOf([
      arrival("fwd", MARK - H, "INBOX", 10 * H),
      arrival("newest", MARK, "INBOX", -2 * H),
    ]);
    expect(ohboxVisitMark(store, NOW)).toBe(iso(MARK));
  });
});

describe("ohboxVisitMark", () => {
  it("is the newest held letter, the clock on an empty mirror, and never past the clock", async () => {
    const held = await storeOf([msg("a", MARK, "INBOX"), msg("b", MARK - 10, "ohmail/News")]);
    expect(ohboxVisitMark(held, NOW)).toBe(iso(MARK));
    expect(ohboxVisitMark(await storeOf([]), NOW)).toBe(iso(NOW));
    const future = await storeOf([msg("f", NOW + 3_600_000, "INBOX")]);
    expect(ohboxVisitMark(future, NOW)).toBe(iso(NOW));
  });
});

describe("lastCheckedAt", () => {
  const row = (o: Partial<{ status: string; syncBlockedSince: string | null; lastSyncAt: string | null; hostedLastSyncAt: string | null }>) => ({
    status: "connected", syncBlockedSince: null, lastSyncAt: iso(NOW - 120_000), ...o,
  });

  it("answers the oldest stamp over every live mailbox", () => {
    const rows = [row({ lastSyncAt: iso(NOW - 60_000) }), row({ lastSyncAt: iso(NOW - 300_000) }), row({ status: "disabled", lastSyncAt: null })];
    expect(lastCheckedAt(rows, NOW - 1_000, NOW)).toBe(iso(NOW - 300_000));
  });

  it("answers null when a mailbox is unchecked, not connected or blocked", () => {
    expect(lastCheckedAt([row({}), row({ lastSyncAt: null })], NOW, NOW)).toBeNull();
    expect(lastCheckedAt([row({}), row({ status: "error" })], NOW, NOW)).toBeNull();
    expect(lastCheckedAt([row({}), row({ syncBlockedSince: iso(NOW - 600_000) })], NOW, NOW)).toBeNull();
    expect(lastCheckedAt([], NOW, NOW)).toBeNull();
    expect(lastCheckedAt([row({ lastSyncAt: "garbage" })], NOW, NOW)).toBeNull();
  });

  it("answers null for facts never read or older than the bound, and takes them at the bound", () => {
    expect(lastCheckedAt([row({})], null, NOW)).toBeNull();
    expect(lastCheckedAt([row({})], NOW - CHECKED_FACTS_MAX_AGE_MS - 1, NOW)).toBeNull();
    expect(lastCheckedAt([row({})], NOW - CHECKED_FACTS_MAX_AGE_MS, NOW)).toBe(iso(NOW - 120_000));
    expect(CHECKED_FACTS_MAX_AGE_MS).toBe(90_000);
  });

  it("reads the hosted stamp wherever the row carries the key, null included", () => {
    expect(lastCheckedAt([row({ hostedLastSyncAt: iso(NOW - 7_000) })], NOW, NOW)).toBe(iso(NOW - 7_000));
    expect(lastCheckedAt([row({ hostedLastSyncAt: null })], NOW, NOW)).toBeNull();
  });
});

describe("OhmailEngine.markOhboxVisit", () => {
  interface Door { adapter: EngineAdapter; calls: string[]; expireNext: boolean }

  function door(messages: EngineMessage[]): Door {
    const d: Door = { calls: [], expireNext: false, adapter: undefined as unknown as EngineAdapter };
    d.adapter = {
      sync: async (p: { since: string }): Promise<SyncResponse> => {
        d.calls.push("sync");
        if (p.since !== "0" && d.expireNext) { d.expireNext = false; throw new CursorExpiredError(); }
        return { changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: p.since, hasMore: false, serverTime: iso(NOW) };
      },
      snapshot: async (): Promise<SyncSnapshotPage> => {
        d.calls.push("snapshot");
        return { asOfSeq: 500, changes: creates(messages), nextCursor: null, window: { days: 30, minRows: 500 } };
      },
      mutate: async (): Promise<MutationOutcome> => { d.calls.push("mutate"); return { changes: [], seq: null }; },
      fetchBody: async () => { d.calls.push("fetchBody"); return null; },
    } as unknown as EngineAdapter;
    return d;
  }

  async function engineOver(d: Door): Promise<{ engine: OhmailEngine; store: MemoryMirrorStore }> {
    const store = new MemoryMirrorStore();
    await store.load();
    const engine = new OhmailEngine({ adapter: d.adapter, store, now: () => new Date(NOW), storePolicy: { mode: "full" } });
    await engine.syncOnce();
    return { engine, store };
  }

  it("writes the mark once, then nothing while no new mail came, with no adapter call and no outbox row", async () => {
    const d = door([msg("a", MARK, "INBOX"), msg("b", MARK - 5, "ohmail/News")]);
    const { engine, store } = await engineOver(d);
    const before = d.calls.length;
    expect(await engine.markOhboxVisit()).toBe(true);
    expect(engine.read().get<OhboxVisitMeta>("view_meta", OHBOX_VISIT_ID)).toEqual({ at: iso(MARK) });
    const v = engine.read().version();
    expect(await engine.markOhboxVisit()).toBe(false);
    expect(engine.read().version(), "an unchanged mark moved the mirror").toBe(v);
    expect(d.calls.length, "the mark called the adapter").toBe(before);
    expect(store.entries(OUTBOX_TYPE)).toEqual([]);
  });

  it("is wiped by a 410 re-sync", async () => {
    const d = door([msg("a", MARK, "INBOX")]);
    const { engine } = await engineOver(d);
    await engine.markOhboxVisit();
    expect(engine.read().get("view_meta", OHBOX_VISIT_ID)).toBeDefined();
    d.expireNext = true;
    try { await engine.syncOnce(); } catch { /* the re-sync is what is under test */ }
    expect(d.calls.filter((c) => c === "snapshot").length).toBe(2);
    expect(engine.read().get("view_meta", OHBOX_VISIT_ID)).toBeUndefined();
  });
});
