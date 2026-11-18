/**
 * A FAKE STORE BEHIND A REAL ENGINE — the mailbox a History or Search page reads (`view=all` by
 * the strict keyset, the month rail, Search by subject with the store's own cursor) and the
 * `/sync` log a verb's write lands in. The mirror holds only what the log's first page names.
 * `lag` keeps a write out of `/sync` until `catchUp()`, the Cloud-paired desktop's lagging copy.
 * Search answers `page`, `estimate` and `summary` by the store's contract: an arm is cut at four
 * pages' worth of candidates, and a cut estimate's `totalEstimate` is a planner's guess.
 */
import type { EngineMessage, EngineMutation } from "@ohmail/wire";
import {
  MemoryMirrorStore,
  MutationRejectedError,
  OhmailEngine,
  decodeSeqCursor,
  encodeSeqCursor,
  type EngineAdapter,
  type EngineOptions,
  type ListOlderFn,
  type MirrorStore,
  type ServerSearchFacets,
  type ServerSearchOpts,
  type StoreKeyset,
  type StoreTimeline,
  type SyncChange,
  type SyncResponse,
} from "../../src/index.js";

export const FAKE_NOW = new Date("2026-09-23T12:00:00.000Z");

/** Ids that sort like their slot, newest first: `idOf(0) > idOf(1)` in uuid order. */
export function idOf(n: number): string {
  return `00000000-0000-4000-8000-${(0xffffffff - n).toString(16).padStart(12, "0")}`;
}

export function storeMessage(n: number, over: Partial<EngineMessage> = {}): EngineMessage {
  const date = new Date(FAKE_NOW.getTime() - n * 3_600_000).toISOString();
  return {
    id: idOf(n), accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `${n % 20 === 0 ? "invoice" : "note"} ${n}`, from: { name: null, address: `s${n % 50}@example.invalid` },
    to: [], cc: [], date, folder: "INBOX", snippet: "", unread: false, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: date, ...over,
  };
}

/** An arm is cut at this many pages' worth of candidates — the store's own cut. */
export const FAKE_ARM_PAGES = 4;

/** The facets over a set of rows, keyed as the store keys them; senders by count, then address. */
export function fakeFacets(rows: readonly EngineMessage[]): ServerSearchFacets {
  const folder: Record<string, number> = {};
  const senders = new Map<string, number>();
  let attached = 0;
  let unread = 0;
  for (const m of rows) {
    folder[m.folder] = (folder[m.folder] ?? 0) + 1;
    senders.set(m.from.address, (senders.get(m.from.address) ?? 0) + 1);
    if (m.hasAttachments) attached += 1;
    if (m.unread) unread += 1;
  }
  const sender = [...senders].map(([address, count]) => ({ address, count }))
    .sort((a, b) => b.count - a.count || (a.address < b.address ? -1 : 1)).slice(0, 10);
  return {
    folder, sender, hasAttachments: { true: attached, false: rows.length - attached },
    unread: { true: unread, false: rows.length - unread },
  };
}

function strictlyBelow(rows: readonly EngineMessage[], before?: StoreKeyset): EngineMessage[] {
  if (!before) return [...rows];
  return rows.filter((m) => {
    if (before.date === null) return m.date === null && m.id < before.id;
    if (m.date === null) return true;
    return m.date < before.date || (m.date === before.date && m.id < before.id);
  });
}

export interface FakeStoreOpts {
  /** How many of the newest rows the first `/sync` page puts in the mirror. */
  mirror?: number;
  /** A write stays out of `/sync` until {@link FakeStore.catchUp}. */
  lag?: boolean;
  engine?: Partial<EngineOptions>;
  store?: MirrorStore;
}

export class FakeStore {
  rows: EngineMessage[];
  log: SyncChange[] = [];
  seq = 0;
  visible = 0;
  lag: boolean;
  /** Every verb that reached the server, by kind and the id it named. */
  verbs: { kind: string; id: string | null; key: string }[] = [];
  /** Every page request: the keyset (History) or `search:<cursor>` (Search). */
  asked: string[] = [];
  /** Every search request by the part it named, in order: `page`, `estimate`, `summary`. */
  searched: string[] = [];
  /** …and what each of them asked, in the same order. */
  searchedWith: ServerSearchOpts[] = [];
  private gate: Promise<void> | null = null;
  private held = new Map<string, Promise<void>>();

  /** The next search asking this part waits on the wire until the returned release is called. */
  holdSearch(part: string): () => void {
    let release!: () => void;
    this.held.set(part, new Promise<void>((r) => { release = r; }));
    return release;
  }

  /** The next verb waits on the wire until the returned release is called. */
  holdNext(): () => void {
    let release!: () => void;
    this.gate = new Promise<void>((r) => { release = r; });
    return release;
  }

  constructor(n: number, private readonly opts: FakeStoreOpts = {}) {
    this.rows = Array.from({ length: n }, (_, i) => storeMessage(i));
    this.lag = opts.lag === true;
    for (const m of this.rows.slice(0, opts.mirror ?? 0)) this.commit({ type: "message", op: "create", id: m.id, entity: m });
    this.visible = this.seq;
  }

  private commit(c: Omit<SyncChange, "seq" | "updatedAt">): void {
    this.seq += 1;
    this.log.push({ ...c, seq: this.seq, updatedAt: FAKE_NOW.toISOString() } as SyncChange);
    if (!this.lag) this.visible = this.seq;
  }

  catchUp(): void {
    this.visible = this.seq;
  }

  row(id: string): EngineMessage | undefined {
    return this.rows.find((m) => m.id === id);
  }

  private write(id: string, change: (m: EngineMessage) => EngineMessage): void {
    const i = this.rows.findIndex((m) => m.id === id);
    if (i < 0) throw new MutationRejectedError("message not found", { status: 404, code: "not_found", retryable: false });
    this.rows[i] = change(this.rows[i]!);
    this.commit({ type: "message", op: "update", id, entity: this.rows[i] });
  }

  readonly adapter: EngineAdapter & { listMessages: ListOlderFn } = {
    sync: async (p: { since: string }): Promise<SyncResponse> => {
      const since = decodeSeqCursor(p.since) ?? 0;
      const rows = this.log.filter((c) => c.seq > since && c.seq <= this.visible);
      const top = rows.length ? rows[rows.length - 1]!.seq : since;
      return {
        changes: {
          creates: rows.filter((c) => c.op === "create"), updates: rows.filter((c) => c.op === "update"),
          moves: rows.filter((c) => c.op === "move"), deletes: rows.filter((c) => c.op === "delete"),
        },
        cursor: encodeSeqCursor(top), hasMore: false, serverTime: FAKE_NOW.toISOString(),
      };
    },
    mutate: async (m: EngineMutation, o: { idempotencyKey: string }) => {
      const id = "messageId" in m ? m.messageId : null;
      this.verbs.push({ kind: m.kind, id, key: o.idempotencyKey });
      if (this.gate) {
        const g = this.gate;
        this.gate = null;
        await g;
      }
      if (m.kind === "message_delete") {
        const i = this.rows.findIndex((x) => x.id === m.messageId);
        if (i < 0) throw new MutationRejectedError("message not found", { status: 404, code: "not_found", retryable: false });
        this.rows.splice(i, 1);
        this.commit({ type: "message", op: "delete", id: m.messageId, entity: null });
      } else if (m.kind === "move") {
        this.write(m.messageId, (x) => ({ ...x, folder: m.folder }));
      } else if (m.kind === "tag_assign") {
        this.write(m.messageId, (x) => ({
          ...x, labels: m.assigned ? [...new Set([...x.labels, m.tagId])] : x.labels.filter((l) => l !== m.tagId),
        }));
      }
      // The hosted routes' shape: no echo body, no seq — the engine drains for the answer.
      return { changes: [], seq: null };
    },
    fetchBody: async () => null,
    listMessages: async (_view: unknown, o: Parameters<ListOlderFn>[1]) => {
      this.asked.push(JSON.stringify(o.startBelow ?? null));
      return { items: strictlyBelow(this.rows, o.startBelow).slice(0, o.limit ?? 50), nextCursor: null };
    },
    timeline: async (): Promise<StoreTimeline> => {
      const months: StoreTimeline["months"] = [];
      for (const m of this.rows) {
        const key = m.date!.slice(0, 7);
        const last = months[months.length - 1];
        if (last && last.month === key) last.count += 1;
        else months.push({ month: key, count: 1, first: { date: m.date, id: m.id } });
      }
      return { total: this.rows.length, months, undated: 0 };
    },
    searchServer: async (q: string, o: ServerSearchOpts) => {
      const part = o.parts ?? "both";
      this.searched.push(part);
      this.searchedWith.push(o);
      const gate = this.held.get(part);
      if (gate) {
        this.held.delete(part);
        await gate;
      }
      const hits = this.rows.filter((m) => m.subject.includes(q));
      const limit = o.limit ?? 50;
      const candidates = hits.slice(0, FAKE_ARM_PAGES * limit);
      const cut = hits.length > candidates.length;
      if (part === "summary") {
        return { items: [], total: hits.length, totalExact: true, tier: "exact" as const, facets: fakeFacets(hits), ms: 40 };
      }
      if (part === "estimate") {
        // A planner's guess: under the exact count, never under the candidates it already has.
        const guess = Math.max(candidates.length, Math.round(hits.length * 0.9));
        return {
          items: [], facets: fakeFacets(candidates), total: candidates.length, totalExact: !cut,
          ...(cut ? { totalEstimate: guess } : {}), tier: "exact" as const, nextCursor: null, bounded: false, ms: 2,
        };
      }
      this.asked.push(`search:${o.cursor ?? "-"}`);
      const from = o.cursor ? Number(o.cursor) : 0;
      const items = hits.slice(from, from + limit);
      const next = from + limit < hits.length ? String(from + limit) : null;
      return { items, total: candidates.length, totalExact: !cut, tier: "exact" as const, ms: 3, nextCursor: next, bounded: false };
    },
  } as unknown as EngineAdapter & { listMessages: ListOlderFn };

  async engine(): Promise<OhmailEngine> {
    const store = this.opts.store ?? new MemoryMirrorStore();
    if (!this.opts.store) await store.load();
    const engine = new OhmailEngine({ adapter: this.adapter, store, now: () => FAKE_NOW, ...this.opts.engine });
    await engine.start();
    return engine;
  }
}

/** Let every settled microtask and every zero-delay timer run. */
export async function settle(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}
