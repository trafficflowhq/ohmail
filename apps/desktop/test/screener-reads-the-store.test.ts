import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  OhmailEngine,
  screenerSegments,
  type EngineMessage,
  type MutationOutcome,
  type ScreenerSegments,
  type ScreenerWaitingWire,
  type SyncChange,
  type SyncResponse,
} from "@ohmail/client-engine";
import { DESKTOP_WINDOW } from "../../webapp/app/shell/store-windows.js";

/**
 * THE SCREENER COUNTS THE STORE'S QUEUE, NOT THE WINDOW.
 *
 * The mirror keeps the newest mail up to its ceiling, and the queue is not bounded by it: held
 * mail older than the window is still waiting. So the waiting set and its count come from
 * `GET /screener`. Here the fixture's oldest `HELD` messages are held, one sender each, under
 * newer INBOX mail; the window keeps only some of them, and a second mailbox's newer mail pushes
 * those out too.
 */

const NOW = new Date("2026-09-26T09:00:00.000Z");
const HELD = 3000;
const PAGE = 200;

function msg(id: string, i: number, over: Partial<EngineMessage>): EngineMessage {
  const date = new Date(NOW.getTime() - 86_400_000 - i * 60_000).toISOString();
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: "inbox@example.test" },
    to: [], cc: [], date, folder: "INBOX", snippet: `snippet ${id}`, unread: false,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: date, ...over,
  };
}

/** Mailbox A: 12 000 rows, the oldest 3 000 held from one sender each; B: 6 000 newer INBOX rows. */
function mailboxA(): EngineMessage[] {
  return Array.from({ length: 12_000 }, (_, i) => (i >= 12_000 - HELD
    ? msg(`a${i}`, i, { folder: "ohmail/Screener", from: { name: null, address: `held${i}@example.test` } })
    : msg(`a${i}`, i, {})));
}
function mailboxB(): EngineMessage[] {
  return Array.from({ length: 6000 }, (_, i) => msg(`b${i}`, i - 20_000, { mailboxId: "mbB" }));
}

/** The store's queue over A's held set, newest first, a page at a time — the route's own shape. */
function storeQueue(page: { cursor?: string } = {}): ScreenerWaitingWire {
  const held = mailboxA().filter((m) => m.folder === "ohmail/Screener");
  const from = page.cursor ? Number(page.cursor) : 0;
  const items = held.slice(from, from + PAGE).map((m) => ({
    messageId: m.id, address: m.from.address, name: null, receivedAt: m.date ?? "",
    subject: m.subject, snippet: m.snippet, mailboxId: m.mailboxId,
  }));
  const next = from + PAGE < held.length ? String(from + PAGE) : null;
  return { items, nextCursor: next, total: from === 0 ? held.length : null, inFlight: [] };
}

async function engineOver(rows: EngineMessage[][], asks: { n: number }) {
  let seq = 0;
  let batch = 0;
  let served = 0;
  const adapter = {
    sync: async (): Promise<SyncResponse> => {
      const all = rows[batch] ?? [];
      const creates: SyncChange[] = all.slice(served, served + 2000).map((m) => (
        { type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m }));
      served += creates.length;
      return { changes: { creates, updates: [], moves: [], deletes: [] }, cursor: `c${seq}`, hasMore: false, serverTime: NOW.toISOString() };
    },
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    fetchBody: async () => null,
    screenerWaiting: async (page?: { cursor?: string }) => { asks.n++; return storeQueue(page); },
  } as never;
  const engine = new OhmailEngine({ adapter, store: new MemoryMirrorStore(), now: () => NOW, storePolicy: DESKTOP_WINDOW });
  await engine.start();
  const drainBatch = async () => {
    while (served < (rows[batch]?.length ?? 0)) await engine.syncOnce();
    await engine.syncOnce();
  };
  await drainBatch();
  return {
    engine,
    nextBatch: async () => { batch++; served = 0; await drainBatch(); },
  };
}

/** What the rail, the doorbell and the meta state; before the store's count existed, the rows held. */
const waitingCountOf = (s: ScreenerSegments): number =>
  (s as Partial<ScreenerSegments>).waitingTotal ?? s.waiting.length;

describe("the Screener's queue is the store's, whatever the window holds", () => {
  it("counts every held sender while the mirror holds only the window", async () => {
    const asks = { n: 0 };
    const { engine } = await engineOver([mailboxA()], asks);
    const refresh = (engine as unknown as { refreshScreenerWaiting?: () => Promise<void> }).refreshScreenerWaiting;
    await refresh?.call(engine);

    expect(engine.read().list<EngineMessage>("message").length).toBe(DESKTOP_WINDOW.maxRows);
    expect(waitingCountOf(screenerSegments(engine.read())), "the waiting count is the window's").toBe(HELD);
  });

  it("keeps the count when a second mailbox's newer mail takes the window", async () => {
    const asks = { n: 0 };
    const { engine, nextBatch } = await engineOver([mailboxA(), mailboxB()], asks);
    const refresh = (engine as unknown as { refreshScreenerWaiting?: () => Promise<void> }).refreshScreenerWaiting;
    await refresh?.call(engine);
    await nextBatch();

    expect(engine.read().list<EngineMessage>("message").length).toBe(DESKTOP_WINDOW.maxRows);
    expect(waitingCountOf(screenerSegments(engine.read())), "the second mailbox evicted the first's queue").toBe(HELD);
  });

  it("holds one page of the queue, and a walk of the pages reaches every sender", async () => {
    const { engine } = await engineOver([mailboxA()], { n: 0 });
    await engine.refreshScreenerWaiting();
    const first = screenerSegments(engine.read());
    expect(first.source).toBe("store");
    // The page's own rows, then the mirror's held senders the page cannot speak for: all of them.
    expect(first.waiting).toHaveLength(1000);
    expect(first.waiting.slice(0, PAGE).every((w) => w.from.address.startsWith("held"))).toBe(true);

    const seen = new Set(first.waiting.map((w) => w.from.address));
    let cursor = first.waitingCursor;
    while (cursor !== null) {
      const page = await engine.screenerWaitingPage(cursor);
      for (const s of page!.senders) seen.add(s.address);
      cursor = page!.nextCursor;
    }
    expect(seen.size).toBe(HELD);
    // The pages onward never became mirror state.
    expect(engine.read().list("screener_waiting")).toHaveLength(PAGE + 1);
  });
});
