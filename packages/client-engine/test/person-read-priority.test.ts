import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HttpAdapter,
  MAX_CONCURRENT_BODIES,
  MemoryMirrorStore,
  OhmailEngine,
  type EngineMessage,
  type SyncChange,
} from "../src/index.js";

/**
 * A READ THE PERSON IS WAITING FOR SAYS SO ON THE WIRE: `priority: "high"` on its request. The web
 * client's resume lane lets such a read past the cap it puts on background reads after a return;
 * the browser schedules it first too. An open (`urgent`), a thread or held preview on screen, an
 * attachment, a search: high. A background body, the sync delta: no hint.
 */

const t0 = new Date("2026-10-21T08:00:00.000Z").getTime();
let seq = 0;

function row(id: string): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: "someone@example.test" },
    to: [], cc: [], date: new Date(t0).toISOString(), folder: "INBOX",
    snippet: `snippet of ${id}`, unread: true, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: new Date(t0).toISOString(),
  };
}

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const BODY = { text: "t", html: null, loadedRemoteContent: false };

/** Every request's path and its priority hint; body reads hang until `answerAll`. */
async function world(ids: string[], opts: { batch?: boolean } = {}) {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(ids.map((id) => {
    const m = row(id);
    return { type: "message", op: "create", id, seq: ++seq, updatedAt: m.updatedAt, entity: m } as SyncChange;
  }));
  const asked: Array<{ path: string; priority: string | undefined }> = [];
  const hung: Array<() => void> = [];
  const fetch = (url: string, init?: RequestInit): Promise<Response> => {
    const path = url.replace("http://api.test", "");
    asked.push({ path, priority: init?.priority });
    if (path.startsWith("/messages/bodies")) {
      if (opts.batch !== true) return Promise.resolve(new Response("{}", { status: 404 }));
      const want = decodeURIComponent(path.split("ids=")[1] ?? "").split(",");
      return Promise.resolve(json({ items: want.map((messageId) => ({ messageId, ...BODY })) }));
    }
    if (/^\/messages\/[^/]+\/body$/.test(path)) {
      return new Promise((resolve) => hung.push(() => resolve(json(BODY))));
    }
    if (path.startsWith("/messages/") && path.endsWith("/attachments")) return Promise.resolve(json({ items: [] }));
    if (path.startsWith("/attachments/")) return Promise.resolve(new Response(new Blob(["x"]), { status: 200 }));
    if (path.startsWith("/search")) return Promise.resolve(json({ items: [], total: 0 }));
    return Promise.resolve(json({}));
  };
  const adapter = new HttpAdapter({ baseUrl: "http://api.test", fetch });
  if (opts.batch !== true) (adapter as unknown as Record<string, unknown>).fetchBodies = undefined;
  const engine = new OhmailEngine({ adapter, store, now: () => new Date(Date.now()) });
  const hintOf = (path: string): string | undefined => asked.find((a) => a.path === path)?.priority;
  const answerAll = (): void => { for (const go of hung.splice(0)) go(); };
  return { engine, adapter, asked, hintOf, answerAll };
}

const flush = async (turns = 30): Promise<void> => {
  for (let i = 0; i < turns; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(t0);
});
afterEach(() => { vi.useRealTimers(); });

describe("an open marks its body read", () => {
  it("an urgent open asks with priority high; a background hydration asks with no hint", async () => {
    const w = await world(["open1", "bg1"]);
    void w.engine.hydrateBody("open1", { urgent: true });
    void w.engine.hydrateBody("bg1");
    await flush();
    expect(w.hintOf("/messages/open1/body")).toBe("high");
    expect(w.hintOf("/messages/bg1/body")).toBeUndefined();
    w.answerAll();
  });

  it("an open of a message queued behind background work: promoted, and its read is marked", async () => {
    const ids = Array.from({ length: MAX_CONCURRENT_BODIES + 1 }, (_, i) => `q${i}`);
    const w = await world(ids);
    for (const id of ids) void w.engine.hydrateBody(id);
    await flush();
    const last = ids.at(-1)!;
    expect(w.hintOf(`/messages/${last}/body`), "the premise: the fifth waits in the engine's queue").toBeUndefined();
    expect(w.asked.some((a) => a.path === `/messages/${last}/body`)).toBe(false);
    void w.engine.hydrateBody(last, { urgent: true });
    await flush();
    expect(w.hintOf(`/messages/${last}/body`)).toBe("high");
    w.answerAll();
  });

  it("a thread open's batch read is marked; a body read off the mirror (an open) too", async () => {
    const w = await world(["t1", "t2", "off1"], { batch: true });
    await w.engine.hydrateThread(["t1", "t2"]);
    expect(w.hintOf("/messages/bodies?ids=t1,t2")).toBe("high");
    void w.engine.readBodyOffMirror("off1");
    await flush();
    expect(w.hintOf("/messages/off1/body")).toBe("high");
    w.answerAll();
  });
});

describe("the adapter's person reads", () => {
  it("attachments, a search, an address search: priority high; the sync delta: no hint", async () => {
    const w = await world([]);
    await w.adapter.listAttachments("m1");
    await w.adapter.fetchAttachment("a1");
    await w.adapter.searchServer("invoice").catch(() => undefined);
    await w.adapter.searchAddressServer("someone@example.test").catch(() => undefined);
    await w.adapter.sync({ since: "c0" }).catch(() => undefined);
    expect(w.hintOf("/messages/m1/attachments")).toBe("high");
    expect(w.hintOf("/attachments/a1")).toBe("high");
    expect(w.asked.filter((a) => a.path.startsWith("/search")).map((a) => a.priority)).toEqual(["high", "high"]);
    const sync = w.asked.find((a) => a.path.startsWith("/sync"));
    expect(sync, "the premise: the delta was asked").toBeDefined();
    expect(sync!.priority).toBeUndefined();
  });
});
