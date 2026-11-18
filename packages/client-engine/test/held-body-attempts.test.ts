import type { EngineMessage, MessageBodyRecord } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FAILED_BODY_HOLD_MS,
  HttpAdapter,
  MemoryMirrorStore,
  OhmailEngine,
  bodyOf,
  type SyncChange,
} from "../src/index.js";
import { BODY_FETCH_TIMEOUT_MS } from "../src/adapters/http-adapter.js";

/**
 * A HELD BODY THAT EXISTS MUST NOT READ "COULDN'T LOAD" FOR THE REST OF THE SESSION.
 *
 * The Screener's held preview drew `body.failed` on the desktop for a message whose body the
 * store held, and the next look, 100 minutes later in the same session, read the same. The
 * routes into a `failed` record are driven below through the real `HttpAdapter` with the body
 * available on the wire, and the rule after one is the product claim: a person looking at the
 * message asks again once the failure is older than the hold, and Retry asks at once.
 */

const t0 = new Date("2026-09-24T08:00:00.000Z").getTime();
let seq = 0;

function held(id: string): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: "stranger@example.test" },
    to: [], cc: [], date: new Date(t0).toISOString(), folder: "ohmail/Screener",
    snippet: `snippet of ${id}`, unread: true, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: new Date(t0).toISOString(),
  };
}

const BODY = { text: "the whole held message", html: "<p>the whole held message</p>", loadedRemoteContent: false };
const ok = () => new Response(JSON.stringify(BODY), { status: 200, headers: { "content-type": "application/json" } });
const notFound = () =>
  new Response(JSON.stringify({ error: { code: "not_found", message: "message not found" } }), {
    status: 404, headers: { "content-type": "application/json" },
  });

type Answer = { delayMs: number; res: () => Response };

/** An engine over the real HttpAdapter whose body route answers from `script`, one entry per ask. */
async function world(script: Answer[], opts: { eager?: boolean } = {}) {
  const store = new MemoryMirrorStore();
  await store.load();
  const m = held("h1");
  await store.applyChanges([{ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m } as SyncChange]);
  const asks: number[] = [];
  const batches: string[][] = [];
  const fetch = (url: string): Promise<Response> => {
    if (url.includes("/sync?")) {
      return Promise.resolve(new Response(JSON.stringify({
        changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: String(seq), hasMore: false, serverTime: new Date(Date.now()).toISOString(),
      }), { status: 200, headers: { "content-type": "application/json" } }));
    }
    if (url.includes("/messages/bodies?ids=")) {
      batches.push(decodeURIComponent(url.split("ids=")[1] ?? "").split(","));
      return Promise.resolve(new Response(JSON.stringify({ error: { code: "internal", message: "down" } }), { status: 500 }));
    }
    if (!url.includes("/messages/h1/body")) return Promise.resolve(new Response("{}", { status: 404 }));
    const answer = script[asks.length] ?? { delayMs: 0, res: ok };
    asks.push(Date.now() - t0);
    return new Promise((resolve) => setTimeout(() => resolve(answer.res()), answer.delayMs));
  };
  const engine = new OhmailEngine({
    adapter: new HttpAdapter({ baseUrl: "http://desktop.local", fetch }),
    store,
    now: () => new Date(Date.now()),
    eagerBodies: opts.eager === true,
  });
  return { engine, store, asks, batches, state: () => bodyOf(store, store.get<EngineMessage>("message", "h1")!).state };
}

const flush = async (turns = 20): Promise<void> => {
  for (let i = 0; i < turns; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(t0);
});
afterEach(() => { vi.useRealTimers(); });

describe("each route to a failed record, with the body on the wire", () => {
  it("(a) an answer slower than the fetch deadline", async () => {
    const w = await world([{ delayMs: BODY_FETCH_TIMEOUT_MS + 1_000, res: ok }]);
    const done = w.engine.hydrateBody("h1");
    await vi.advanceTimersByTimeAsync(BODY_FETCH_TIMEOUT_MS + 1);
    await done;
    const rec = w.store.get<MessageBodyRecord>("message_body", "h1")!;
    expect(w.state()).toBe("failed");
    expect(rec.error).toContain(`within ${BODY_FETCH_TIMEOUT_MS} ms`);
  });

  it("(a) an answer that arrived in time but was read after the deadline", async () => {
    // A thread busy past the deadline: the answer lands at 200 ms and its continuation cannot run
    // before the deadline's timer. `advanceTimersByTime` fires both timers with no microtask
    // between them, which is that order.
    const w = await world([{ delayMs: 200, res: ok }]);
    const done = w.engine.hydrateBody("h1");
    await flush();
    vi.advanceTimersByTime(BODY_FETCH_TIMEOUT_MS + 1);
    await vi.advanceTimersByTimeAsync(0);
    await done;
    expect(w.state()).toBe("failed");
  });

  it("(b) a 404 from the local door", async () => {
    const w = await world([{ delayMs: 5, res: notFound }]);
    const done = w.engine.hydrateBody("h1");
    await vi.advanceTimersByTimeAsync(10);
    await done;
    expect(w.state()).toBe("failed");
    expect(w.store.get<MessageBodyRecord>("message_body", "h1")!.error).toBe("message not found");
  });
});

describe("after a failure, the person looking at it can have the body", () => {
  async function failedOnce() {
    const w = await world([{ delayMs: 5, res: notFound }, { delayMs: 5, res: ok }]);
    const first = w.engine.hydrateBody("h1");
    await vi.advanceTimersByTimeAsync(10);
    await first;
    expect(w.state()).toBe("failed");
    return w;
  }

  it("Retry asks again at once and draws the body", async () => {
    const w = await failedOnce();
    const again = w.engine.hydrateBody("h1", { retry: true });
    await vi.advanceTimersByTimeAsync(10);
    await again;
    expect(w.asks).toHaveLength(2);
    expect(w.state()).toBe("full");
  });

  it("the next selection past the hold asks again, where it used to read failed for the session", async () => {
    const w = await failedOnce();
    await vi.advanceTimersByTimeAsync(FAILED_BODY_HOLD_MS + 1_000);
    const next = w.engine.hydrateBody("h1");
    await vi.advanceTimersByTimeAsync(10);
    await next;
    expect(w.asks, "a later selection must re-ask a failure older than the hold").toHaveLength(2);
    expect(w.state()).toBe("full");
  });

  it("but a selection inside the hold does not — the hold is what stops a render loop polling", async () => {
    const w = await failedOnce();
    await vi.advanceTimersByTimeAsync(FAILED_BODY_HOLD_MS / 6);
    for (let i = 0; i < 4; i++) await w.engine.hydrateBody("h1");
    expect(w.asks).toHaveLength(1);
    expect(w.state()).toBe("failed");
  });
});

describe("the background pass keeps the session rule", () => {
  it("an eager failure is not re-asked by the next pass past the hold, and a selection then is", async () => {
    const w = await world([{ delayMs: 5, res: ok }], { eager: true });
    await w.engine.syncOnce();
    const pass = w.engine.prefetchRecentBodies();
    await vi.advanceTimersByTimeAsync(10);
    await pass;
    expect(w.batches, "premise: the eager pass asked").toHaveLength(1);
    expect(w.state()).toBe("failed");
    await vi.advanceTimersByTimeAsync(FAILED_BODY_HOLD_MS + 1_000);
    await w.store.applyChanges([{ type: "message", op: "create", id: "later", seq: ++seq, updatedAt: new Date(Date.now()).toISOString(), entity: { ...held("later"), folder: "ohmail/News" } } as SyncChange]);
    await w.engine.syncOnce();
    const again = w.engine.prefetchRecentBodies();
    await vi.advanceTimersByTimeAsync(10);
    await again;
    expect(w.batches.length, "a second pass ran").toBe(2);
    expect(w.batches[1], "nobody is looking: the pass does not re-ask a failure in the session").not.toContain("h1");
    expect(w.asks).toHaveLength(0);
    expect(w.state()).toBe("failed");
    const looked = w.engine.hydrateBody("h1");
    await vi.advanceTimersByTimeAsync(10);
    await looked;
    expect(w.asks).toHaveLength(1);
    expect(w.state()).toBe("full");
  });
});
