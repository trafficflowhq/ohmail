import { describe, expect, it } from "vitest";
import {
  CursorExpiredError,
  MemoryMirrorStore,
  OhmailEngine,
  screenerSegments,
  type EngineAdapter,
  type EngineMessage,
  type EngineMutation,
  type MutationOutcome,
  type ScreenerWaitingWire,
  type SyncChange,
  type SyncResponse,
} from "../src/index.js";

/**
 * THE ENGINE'S DOOR TO THE STORE'S SCREENER QUEUE. One page is kept, replaced wholesale; the count
 * is the store's; the settle asks again only when a page touched what the queue is derived from;
 * and a decision on a sender only the store holds is sent, with its row off the page at the press.
 */

const NOW = new Date("2026-09-26T09:00:00.000Z");
const item = (id: string) => ({
  messageId: id, address: `${id}@example.test`, name: null, receivedAt: NOW.toISOString(),
  subject: `s ${id}`, snippet: "s", mailboxId: "mb",
});
const page = (ids: string[], over: Partial<ScreenerWaitingWire> = {}): ScreenerWaitingWire => (
  { items: ids.map(item), nextCursor: null, total: ids.length, inFlight: [], ...over });

function msg(id: string, over: Partial<EngineMessage> = {}): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: `${id}@example.test` },
    to: [], cc: [], date: NOW.toISOString(), folder: "INBOX", snippet: "s", unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: NOW.toISOString(), ...over,
  };
}

function rig(answer: (p: { cursor?: string }) => ScreenerWaitingWire | Promise<ScreenerWaitingWire>) {
  const pages: SyncChange[][] = [];
  const sent: EngineMutation[] = [];
  const asks: Array<{ cursor?: string }> = [];
  let seq = 0;
  let refuse = false;
  const adapter = {
    sync: async (): Promise<SyncResponse> => ({
      changes: { creates: pages.shift() ?? [], updates: [], moves: [], deletes: [] },
      cursor: `c${seq}`, hasMore: false, serverTime: NOW.toISOString(),
    }),
    mutate: async (m: EngineMutation): Promise<MutationOutcome> => {
      sent.push(m);
      if (refuse) throw Object.assign(new Error("refused"), { status: 409, code: "conflict" });
      return { changes: [], seq: null } as unknown as MutationOutcome;
    },
    fetchBody: async () => null,
    screenerWaiting: async (p?: { cursor?: string }) => { asks.push(p ?? {}); return answer(p ?? {}); },
  } as unknown as EngineAdapter;
  const engine = new OhmailEngine({ adapter, store: new MemoryMirrorStore(), now: () => NOW, storePolicy: { mode: "full" } });
  const push = (...ms: EngineMessage[]) => pages.push(ms.map((m) => (
    { type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: NOW.toISOString(), entity: m })));
  return { engine, sent, asks, push, pages, refuseNext: () => { refuse = true; } };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("the store's queue page in the mirror", () => {
  it("is one answer: the page's senders in its order, and the store's count", async () => {
    const { engine } = rig(() => page(["a", "b", "c"], { total: 40, nextCursor: "n" }));
    await engine.start();
    await engine.refreshScreenerWaiting();
    const s = screenerSegments(engine.read(), NOW);
    expect(s.source).toBe("store");
    expect(s.waiting.map((w) => w.from.address)).toEqual(["a@example.test", "b@example.test", "c@example.test"]);
    expect(s.waitingTotal).toBe(40);
    expect(s.waitingCursor).toBe("n");
    expect(s.waiting.every((w) => w.stored === true && w.gatePhysical === true)).toBe(true);
  });

  it("an older server that states no count over a partial page leaves the device's own count", async () => {
    let answer = page(["a"]);
    const { engine } = rig(() => answer);
    await engine.start();
    await engine.refreshScreenerWaiting();
    expect(screenerSegments(engine.read(), NOW).source).toBe("store");
    answer = page(["a"], { total: null, nextCursor: "n" });
    await engine.refreshScreenerWaiting();
    expect(screenerSegments(engine.read(), NOW).source, "a page with no count is no count").toBe("mirror");
    // …and a page that IS the whole queue states its own count even without the field.
    answer = page(["a", "b"], { total: null, nextCursor: null });
    await engine.refreshScreenerWaiting();
    expect(screenerSegments(engine.read(), NOW).waitingTotal).toBe(2);
  });

  it("an older answer landing after a newer one is dropped", async () => {
    let release!: () => void;
    const slow = new Promise<void>((r) => { release = r; });
    let n = 0;
    const { engine } = rig(async () => (++n === 1 ? (await slow, page(["old"])) : page(["new"])));
    await engine.start();
    const first = engine.refreshScreenerWaiting();
    await engine.refreshScreenerWaiting();
    release();
    await first;
    expect(screenerSegments(engine.read(), NOW).waiting.map((w) => w.from.address)).toEqual(["new@example.test"]);
  });

  it("is settled only once the newest ask answered or was refused, never by a superseded answer", async () => {
    const gates: Array<() => void> = [];
    const { engine } = rig(async () => {
      await new Promise<void>((r) => { gates.push(r); });
      return page([]);
    });
    await engine.start();
    let told = 0;
    engine.subscribe(() => { told += 1; });
    expect(engine.screenerWaitingSettled(), "settled before any answer").toBe(false);
    const first = engine.refreshScreenerWaiting();
    const second = engine.refreshScreenerWaiting();
    await flush();
    gates[0]!();
    await first;
    expect(engine.screenerWaitingSettled(), "a superseded answer settled the queue").toBe(false);
    gates[1]!();
    await second;
    expect(engine.screenerWaitingSettled()).toBe(true);
    expect(told, "the first answer was not published").toBeGreaterThan(0);
    // A refused newest ask settles too: the device's own derivation stands.
    const { engine: off } = rig(async () => { throw new Error("offline"); });
    await off.start();
    await off.refreshScreenerWaiting().catch(() => undefined);
    expect(off.screenerWaitingSettled()).toBe(true);
  });

  it("an older server's answer with no page settles the queue and is published", async () => {
    const { engine } = rig(() => page(["a"], { total: null, nextCursor: "n" }));
    await engine.start();
    let told = 0;
    engine.subscribe(() => { told += 1; });
    await engine.refreshScreenerWaiting();
    expect(screenerSegments(engine.read(), NOW).source).toBe("mirror");
    expect(engine.screenerWaitingSettled()).toBe(true);
    expect(told).toBeGreaterThan(0);
  });

  it("a 410 re-bootstrap withholds the queue it wiped until the store speaks again, never the device's guess", async () => {
    const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];
    let n = 0;
    const creates = (of: string[]): SyncChange[] => of.map((id) => (
      { type: "message", op: "create", id, seq: ++n, updatedAt: NOW.toISOString(), entity: msg(id, { folder: "ohmail/Screener" }) }));
    const res = (of: string[], hasMore: boolean): SyncResponse => (
      { changes: { creates: creates(of), updates: [], moves: [], deletes: [] }, cursor: `c${n}`, hasMore, serverTime: NOW.toISOString() });
    let engine!: OhmailEngine;
    let mid: { settled: boolean; source: string; total: number; asks: number } | null = null;
    const answers: Array<() => void> = [];
    let asks = 0;
    const script: Array<() => SyncResponse> = [
      () => res(ids, false),
      () => { throw new CursorExpiredError(); },
      () => res(ids.slice(0, 6), true),
      () => {
        const s = screenerSegments(engine.read(), NOW);
        mid = { settled: engine.screenerWaitingSettled(), source: s.source, total: s.waitingTotal, asks };
        return res(ids.slice(6), false);
      },
    ];
    const adapter = {
      sync: async () => (script.shift() ?? (() => res([], false)))(),
      mutate: async () => ({ changes: [], seq: null }),
      fetchBody: async () => null,
      screenerWaiting: async () => {
        if (++asks > 1) await new Promise<void>((r) => { answers.push(r); });
        return page(["a", "b"]);
      },
    } as unknown as EngineAdapter;
    engine = new OhmailEngine({ adapter, store: new MemoryMirrorStore(), now: () => NOW, storePolicy: { mode: "full" } });
    await engine.start(); // the first drain: eight senders at the gate
    await engine.refreshScreenerWaiting();
    expect(screenerSegments(engine.read(), NOW).waitingTotal).toBe(2);
    await engine.syncOnce();
    expect(mid, "the rebuild's second page was never asked").not.toBeNull();
    expect(mid!.settled, `the wiped queue still read as the store's word (${mid!.source}, ${mid!.total})`).toBe(false);
    expect(mid!.asks, "the wipe did not ask the store again at once").toBe(2);
    let told = 0;
    engine.subscribe(() => { told += 1; });
    for (const r of answers) r();
    await flush();
    expect(engine.screenerWaitingSettled()).toBe(true);
    expect(told, "the answer was not published").toBeGreaterThan(0);
    const s = screenerSegments(engine.read(), NOW);
    expect([s.source, s.waitingTotal]).toEqual(["store", 2]);
  });

  it("the settle asks again when a page touched the gate, and not for unrelated mail", async () => {
    const { engine, asks, push } = rig(() => page(["a"]));
    await engine.start();
    await engine.refreshScreenerWaiting();
    expect(asks).toHaveLength(1);
    push(msg("inbox1"));
    await engine.syncOnce();
    await flush();
    expect(asks, "an INBOX arrival re-asked").toHaveLength(1);
    push(msg("held1", { folder: "ohmail/Screener" }));
    await engine.syncOnce();
    await flush();
    expect(asks, "a gate arrival did not re-ask").toHaveLength(2);
  });

  it("a mailbox_profile change asks again: the organizer's window the queue reads may have moved (RULING-026)", async () => {
    const { engine, asks, pages } = rig(() => page(["a"]));
    await engine.start();
    await engine.refreshScreenerWaiting();
    expect(asks).toHaveLength(1);
    pages.push([{
      type: "mailbox_profile", op: "create", id: "mb", seq: 99, updatedAt: NOW.toISOString(),
      entity: { mailboxId: "mb", rules: [], asOf: NOW.toISOString(), from: { kind: "local", name: "Studio Mac", since: null }, updatedAt: NOW.toISOString() },
    } as SyncChange]);
    await engine.syncOnce();
    await flush();
    expect(asks, "a new organizer document did not re-ask the queue").toHaveLength(2);
  });
});

describe("what the page cannot speak for", () => {
  it("a held sender older than the page's last row stays on screen; a newer unlisted one does not", async () => {
    const hour = 3_600_000;
    const at = (h: number) => new Date(NOW.getTime() - h * hour).toISOString();
    const { engine, push } = rig(() => page(["a"], { total: 9, nextCursor: "n", items: [{ ...item("a"), receivedAt: at(2) }] }));
    push(msg("x", { folder: "ohmail/Screener", date: at(1) }), msg("y", { folder: "ohmail/Screener", date: at(240) }));
    await engine.start();
    await engine.syncOnce();
    await engine.refreshScreenerWaiting();
    const s = screenerSegments(engine.read(), NOW);
    expect(s.waiting.map((w) => w.from.address)).toEqual(["a@example.test", "y@example.test"]);
    expect(s.waitingTotal).toBe(9);
  });
});

describe("a decision on a sender only the store holds", () => {
  it("is sent, takes the row off the page at the press, and re-reads the page", async () => {
    let answer = page(["a", "b", "c"]);
    const { engine, sent, asks } = rig(() => answer);
    await engine.start();
    await engine.refreshScreenerWaiting();
    answer = page(["a", "c"]);
    const out = await engine.mutate({ kind: "screener_decide", senderId: "b", decision: "yes", dest: "ohbox", scope: "sender" });
    expect(out.status).not.toBe("rolled_back");
    expect(sent.map((m) => m.kind)).toEqual(["screener_decide"]);
    const s = screenerSegments(engine.read(), NOW);
    expect(s.waiting.map((w) => w.id)).toEqual(["a", "c"]);
    expect(s.waitingTotal).toBe(2);
    await flush();
    expect(asks, "the page was not re-read after the decision").toHaveLength(2);
  });

  it("a refused decision puts the row back", async () => {
    const { engine, refuseNext } = rig(() => page(["a", "b"]));
    await engine.start();
    await engine.refreshScreenerWaiting();
    refuseNext();
    const out = await engine.mutate({ kind: "screener_decide", senderId: "b", decision: "no", dest: "screened", scope: "sender" });
    expect(out.status).toBe("rolled_back");
    const s = screenerSegments(engine.read(), NOW);
    expect(s.waiting.map((w) => w.id)).toEqual(["a", "b"]);
    expect(s.waitingTotal).toBe(2);
  });

  it("a page past the first is sent too; an id no page served is refused here", async () => {
    const { engine, sent } = rig((p) => (p.cursor ? page(["z"], { total: null }) : page(["a"], { total: 2, nextCursor: "n" })));
    await engine.start();
    await engine.refreshScreenerWaiting();
    const onwardPage = await engine.screenerWaitingPage("n");
    expect(onwardPage?.senders.map((s) => s.messageId)).toEqual(["z"]);
    const onward = await engine.mutate({ kind: "screener_decide", senderId: "z", decision: "yes", dest: "ohbox", scope: "sender" });
    expect(onward.status).not.toBe("rolled_back");
    const stranger = await engine.mutate({ kind: "screener_decide", senderId: "nobody", decision: "yes", dest: "ohbox", scope: "sender" });
    expect(stranger.status).toBe("rolled_back");
    expect(sent.map((m) => (m as { senderId: string }).senderId)).toEqual(["z"]);
  });

  it("a walk from the first page serves it too: no cursor asked, and its senders are sent", async () => {
    /* The phone walks the whole queue through this door, so a sender its first page names is
       decidable even when the engine's own copy of that page never named them (an older copy, a
       server that states no count). The copy here says nobody; the walk says "w". */
    const { engine, sent, asks } = rig((p) => (p.cursor ? page([]) : page(["w"], { total: null, nextCursor: "n" })));
    await engine.start();
    const first = await engine.screenerWaitingPage(null);
    expect(asks.at(-1), "the first page is asked without a cursor").toEqual({ limit: 200 });
    expect(first?.senders.map((s) => s.messageId)).toEqual(["w"]);
    expect(first?.nextCursor).toBe("n");
    const out = await engine.mutate({ kind: "screener_decide", senderId: "w", decision: "no", dest: "screened", scope: "sender" });
    expect(out.status).not.toBe("rolled_back");
    expect(sent.map((m) => (m as { senderId: string }).senderId)).toEqual(["w"]);
  });
});
