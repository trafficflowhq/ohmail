import type { EngineMessage } from "@ohmail/wire";
import {
  HISTORY_PAGE_ROWS,
  MemoryMirrorStore,
  MutationRejectedError,
  OhmailEngine,
  type EngineAdapter,
  type ListOlderFn,
  type StoreKeyset,
  type StoreTimeline,
  type SyncResponse,
} from "@ohmail/client-engine";

/**
 * A FAKE STORE BEHIND A REAL ENGINE — `GET /messages?view=all` answering the strict keyset the
 * route answers, `GET /messages/timeline` grouped by UTC month, and a `/sync` that seeds the
 * mirror with whatever the test names. History and Search are driven through the engine's own
 * doors against it, never through a hand-written prop.
 */

export const FIXTURE_NOW = new Date("2026-09-23T12:00:00.000Z");

/** Ids that sort like their slot, newest first: `idOf(0) > idOf(1)` in uuid order. */
export function idOf(n: number): string {
  return `00000000-0000-4000-8000-${(0xffffffff - n).toString(16).padStart(12, "0")}`;
}

export function storeMessage(n: number, date: string | null, over: Partial<EngineMessage> = {}): EngineMessage {
  return {
    id: idOf(n), accountId: "acct_1", mailboxId: "mb_1", threadId: null, messageIdHeader: null,
    subject: `subject of ${n}`, from: { name: `Sender ${n}`, address: `s${n}@example.invalid` },
    to: [], cc: [], date, folder: "INBOX", snippet: `snippet of ${n}`, unread: false,
    hasAttachments: false, attachmentCount: 0, sensitivity: {}, triage: null, labels: [],
    remoteContent: "none", updatedAt: date ?? FIXTURE_NOW.toISOString(), ...over,
  } as unknown as EngineMessage;
}

/** `n` messages, `stepMs` apart going back from now, newest first. */
export function storeRows(n: number, stepMs = 3_600_000): EngineMessage[] {
  return Array.from({ length: n }, (_, i) => storeMessage(i, new Date(FIXTURE_NOW.getTime() - i * stepMs).toISOString()));
}

function strictlyBelow(rows: readonly EngineMessage[], before?: StoreKeyset): EngineMessage[] {
  if (!before) return [...rows];
  return rows.filter((m) => {
    if (before.date === null) return m.date === null && m.id < before.id;
    if (m.date === null) return true;
    return m.date < before.date || (m.date === before.date && m.id < before.id);
  });
}

/** The timeline the route would answer for these rows. */
export function timelineOf(rows: readonly EngineMessage[]): StoreTimeline {
  const months: StoreTimeline["months"] = [];
  let undated = 0;
  for (const m of rows) {
    if (m.date === null) {
      undated += 1;
      continue;
    }
    const key = m.date.slice(0, 7);
    const last = months[months.length - 1];
    if (last && last.month === key) last.count += 1;
    else months.push({ month: key, count: 1, first: { date: m.date, id: m.id } });
  }
  return { total: rows.length, months, undated };
}

export interface FixtureOpts {
  /** Rows `/sync` puts in the mirror — the first paint. */
  mirror?: EngineMessage[];
  /** Ids `/sync` then deletes — tombstones in the mirror. */
  mirrorDeletes?: string[];
  /** Hold every store answer until the returned `release()` is called. */
  held?: boolean;
  /** The timeline door throws. */
  timelineFails?: boolean;
  /** No store doors at all — the demo's shape. */
  noDoors?: boolean;
  /** While this answers a status, both store doors refuse with it, the way the HTTP adapter does. */
  refuse?: () => number | null;
}

export interface Fixture {
  engine: OhmailEngine;
  /** Every page request, as the keyset it asked below. */
  pages: (StoreKeyset | null)[];
  /** The first row id of every page served. */
  served: string[];
  /** How many times the timeline door was asked. */
  timelineCalls: () => number;
  release: () => void;
  /** A message reaches the store; the next `/sync` carries it, as a new message does. */
  arrive: (m: EngineMessage) => void;
}

/** The store's reading order: `date desc nulls last, id desc`. */
function storeOrder(a: EngineMessage, b: EngineMessage): number {
  if (a.date !== b.date) {
    if (a.date === null) return 1;
    if (b.date === null) return -1;
    return a.date < b.date ? 1 : -1;
  }
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export async function storeFixture(rows: EngineMessage[], opts: FixtureOpts = {}): Promise<Fixture> {
  const pages: (StoreKeyset | null)[] = [];
  const served: string[] = [];
  const waiting: (() => void)[] = [];
  let open = !opts.held;
  const gate = (): Promise<void> => (open ? Promise.resolve() : new Promise((r) => waiting.push(r)));
  let timelineCalls = 0;
  /* The adapter's own refusal: `rejectionOf` over a non-2xx, `unauthorized` for a bare 401. */
  const refused = (): void => {
    const status = opts.refuse?.() ?? null;
    if (status === null) return;
    throw new MutationRejectedError(`HTTP ${status}`, {
      status, code: status === 401 ? "unauthorized" : null, retryable: status >= 500,
    });
  };
  const listMessages: ListOlderFn = async (_view, o) => {
    pages.push(o.startBelow ?? null);
    await gate();
    refused();
    const items = strictlyBelow(rows, o.startBelow).slice(0, o.limit ?? HISTORY_PAGE_ROWS);
    if (items[0]) served.push(items[0].id);
    return { items, nextCursor: null };
  };
  const mirror = opts.mirror ?? [];
  let synced = false;
  let seq = mirror.length + (opts.mirrorDeletes ?? []).length;
  let arrivals: EngineMessage[] = [];
  const adapter = {
    sync: async (): Promise<SyncResponse> => {
      const creates = synced ? arrivals.splice(0).map((m) => ({
        type: "message", op: "create" as const, id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
      })) : mirror.map((m, i) => ({
        type: "message", op: "create" as const, id: m.id, seq: i + 1, updatedAt: m.updatedAt, entity: m,
      }));
      const deletes = synced ? [] : (opts.mirrorDeletes ?? []).map((id, i) => ({
        type: "message", op: "delete" as const, id, seq: mirror.length + i + 1, updatedAt: FIXTURE_NOW.toISOString(), entity: null,
      }));
      synced = true;
      return { changes: { creates, updates: [], moves: [], deletes }, cursor: String(seq), hasMore: false, serverTime: FIXTURE_NOW.toISOString() };
    },
    mutate: async () => ({ changes: [], seq: null }),
    fetchBody: async () => null,
    ...(opts.noDoors ? {} : {
      listMessages,
      timeline: async (): Promise<StoreTimeline> => {
        timelineCalls += 1;
        await gate();
        if (opts.timelineFails) throw new Error("timeline refused");
        refused();
        return timelineOf(rows);
      },
    }),
  } as unknown as EngineAdapter;
  const store = new MemoryMirrorStore();
  await store.load();
  const engine = new OhmailEngine({ adapter, store, now: () => FIXTURE_NOW });
  await engine.syncOnce();
  return {
    engine,
    pages,
    served,
    timelineCalls: () => timelineCalls,
    release: () => {
      open = true;
      for (const w of waiting.splice(0)) w();
    },
    arrive: (m) => {
      rows.push(m);
      rows.sort(storeOrder);
      arrivals = [...arrivals, m];
    },
  };
}
