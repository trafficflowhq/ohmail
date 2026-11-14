import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OhmailEngine } from "@ohmail/client-engine";

import { IDBFactory } from "fake-indexeddb";

import { BearerManager, PAIR_SCOPE_STORAGE_KEY, REFRESH_STORAGE_KEY } from "../src/host-client/bearer.js";
import { createHostClientEngine } from "../src/host-client/host-engine.js";
import { discardHostOutbox, HOST_OUTBOX_DB, HostOutboxStore } from "../src/host-client/outbox-store.js";

/**
 * A CHANGE MADE ON A PAIRED PAGE WHILE THE HOST IS OUT OF REACH OUTLIVES THE PAGE.
 * Here rather than beside the desktop's tests because `fake-indexeddb` is this package's.
 *
 * The engine is the one `HostGate` mounts (`createHostClientEngine`), over a bearer whose far
 * side is a stand-in host that drops every request while it is out of reach. "Dropping the page"
 * forgets the engine and the bearer; "opening it again" builds both over the same jar and the
 * same IndexedDB. Before the fix the outbox lived in the page's memory and nothing was sent.
 */

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

interface Host { online: boolean; delivered: string[]; sendRequests: number; deleted: string[]; other: string[] }

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function hostFetch(h: Host) {
  let drafts = 0;
  return async (url: string, init?: unknown): Promise<Response> => {
    const i = (init ?? {}) as { method?: string; headers?: Record<string, string> };
    if (!h.online) throw new TypeError("Failed to fetch");
    const method = i.method ?? "GET";
    const key = Object.entries(i.headers ?? {}).find(([n]) => n.toLowerCase() === "idempotency-key")?.[1] ?? "";
    if (method === "POST" && url === "/drafts") {
      drafts++;
      return json(201, { id: `draft-${drafts}`, bcc: [], contentRevision: `r-${drafts}` });
    }
    if (method === "POST" && /^\/drafts\/[^/]+\/send$/.test(url)) {
      h.sendRequests++;
      if (!h.delivered.includes(key)) h.delivered.push(key);
      return json(200, { status: "sent", providerMessageId: "<sent-1@example.test>" });
    }
    const del = /^\/messages\/([^/]+)$/.exec(url);
    if (method === "DELETE" && del) {
      h.deleted.push(del[1]!);
      return json(200, { id: del[1], updatedAt: "2026-09-26T08:00:00.000Z" });
    }
    if (method === "GET" && url.startsWith("/sync/snapshot")) {
      return json(200, { asOfSeq: 1, changes: [], nextCursor: null, window: { days: 90, minRows: 5000 } });
    }
    if (method === "GET" && url.startsWith("/sync?")) {
      return json(200, {
        changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "1", hasMore: false,
        serverTime: "2026-09-26T08:00:00.000Z",
      });
    }
    h.other.push(`${method} ${url}`);
    return json(404, { error: { code: "not_found", message: "not in the stand-in" } });
  };
}

/** A jar the pairing lives in across page loads. */
function jar(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (n) => [...m.keys()][n] ?? null,
    removeItem: (k) => { m.delete(k); },
    setItem: (k, v) => { m.set(k, String(v)); },
  };
}

const SEND = {
  kind: "mail_send" as const, inReplyTo: null, mailboxId: "mbx-1",
  to: [{ name: null, address: "b@example.test" }], subject: "ohmail-e2e paired outbox", body: "queued while the host was away",
};

let host: Host;
let storage: Storage;
let factory: IDBFactory;

beforeEach(() => {
  host = { online: false, delivered: [], sendRequests: 0, deleted: [], other: [] };
  storage = jar();
  storage.setItem(REFRESH_STORAGE_KEY, "rt-paired");
  factory = new IDBFactory();
});
afterEach(() => { vi.useRealTimers(); });

/** One page load: a bearer over the jar, the gate's engine, hydrated. */
async function openPage(opts: { factory?: IDBFactory | null; onUnkept?: () => void } = {}): Promise<OhmailEngine> {
  const bearer = new BearerManager({ storage, fetchImpl: hostFetch(host) });
  const scope = bearer.pairScope();
  expect(scope).not.toBeNull();
  const engine = createHostClientEngine(bearer, {
    scope: scope!, factory: opts.factory === undefined ? factory : opts.factory,
    ...(opts.onUnkept ? { onUnkept: opts.onUnkept } : {}),
  });
  await engine.hydrate();
  return engine;
}

/** Every key this browser holds, read with the real factory — the device's own answer. */
async function keysOnDisk(f: IDBFactory): Promise<unknown[]> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = f.open(HOST_OUTBOX_DB, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore("rows"); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const keys = await new Promise<unknown[]>((resolve, reject) => {
    const req = db.transaction("rows", "readonly").objectStore("rows").getAllKeys();
    req.onsuccess = () => resolve(req.result as unknown[]);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return keys;
}

/** A browser whose database will not open at all — a private window, blocked site data. */
const refusingFactory = {
  open: () => { throw new DOMException("The user denied permission to access the database.", "SecurityError"); },
} as unknown as IDBFactory;

/** The real database, refusing the next `n` writes — a quota or a closing connection. */
function refusingWrites(real: IDBFactory, n: { left: number }): IDBFactory {
  const db = (inner: IDBDatabase): IDBDatabase => new Proxy(inner, {
    get(t, prop) {
      if (prop === "transaction") {
        return (names: string | string[], mode?: IDBTransactionMode) => {
          if (mode === "readwrite" && n.left > 0) { n.left--; throw new DOMException("refused", "QuotaExceededError"); }
          return t.transaction(names, mode);
        };
      }
      const v = Reflect.get(t, prop, t) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
    set(t, prop, v) { return Reflect.set(t, prop, v, t); },
  });
  return {
    open: (name: string, version?: number) => {
      const req = real.open(name, version);
      return new Proxy(req, {
        get(t, prop) {
          if (prop === "result") return db(t.result);
          const v = Reflect.get(t, prop, t) as unknown;
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
        },
        set(t, prop, v) { return Reflect.set(t, prop, v, t); },
      });
    },
  } as unknown as IDBFactory;
}

/** One drive, and a few ticks for the confirm's own retire to land. */
async function drive(engine: OhmailEngine): Promise<void> {
  await engine.syncOnce().catch(() => undefined);
  for (let i = 0; i < 5; i++) await new Promise((r) => { setTimeout(r, 0); });
}

describe("the paired page keeps a change made while the host is out of reach", () => {
  it("a send and a delete queued offline go out after the page is opened again, once, under their keys", async () => {
    const first = await openPage();
    const sent = await first.mutate(SEND);
    const gone = await first.mutate({ kind: "message_delete", messageId: "m-1" });
    expect(sent.status).toBe("queued");
    expect(gone.status).toBe("queued");
    const keys = first.pendingMutations().map((p) => p.key);
    expect(keys).toHaveLength(2);

    host.online = true;
    const second = await openPage();
    expect(second.pendingMutations()).toHaveLength(2);
    await drive(second);
    expect(host.deleted).toEqual(["m-1"]);
    expect(host.delivered).toHaveLength(1);
    expect(keys).toContain(host.delivered[0]);
    expect(second.pendingMutations()).toHaveLength(0);

    // A third open finds nothing to replay: the confirms retired their rows.
    const third = await openPage();
    expect(third.pendingMutations()).toHaveLength(0);
    await drive(third);
    expect(host.sendRequests).toBe(1);
    expect(host.deleted).toEqual(["m-1"]);
    expect(host.other).toEqual([]);
  });

  it("a change still waiting a day later moves to unsaved changes when the host is still away", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-26T08:00:00.000Z"));
    const first = await openPage();
    expect((await first.mutate({ kind: "message_delete", messageId: "m-2" })).status).toBe("queued");

    vi.setSystemTime(new Date(Date.parse("2026-09-26T08:00:00.000Z") + DAY + HOUR));
    const later = await openPage();
    await drive(later);
    expect(later.pendingMutations()).toHaveLength(0);
    expect(later.abandoned().map((a) => a.mutation.kind)).toEqual(["message_delete"]);

    // And it is still there on the next open, where Try again or Discard reaches it.
    const again = await openPage();
    expect(again.abandoned()).toHaveLength(1);
  });

  it("control: inside the day it stays queued and nothing is shown", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-26T08:00:00.000Z"));
    const first = await openPage();
    expect((await first.mutate({ kind: "message_delete", messageId: "m-3" })).status).toBe("queued");

    vi.setSystemTime(new Date(Date.parse("2026-09-26T08:00:00.000Z") + DAY - HOUR));
    const later = await openPage();
    await drive(later);
    expect(later.pendingMutations()).toHaveLength(1);
    expect(later.abandoned()).toHaveLength(0);
  });

  it("a discarded pairing replays nothing on the next open", async () => {
    const first = await openPage();
    expect((await first.mutate({ kind: "message_delete", messageId: "m-4" })).status).toBe("queued");
    expect(await discardHostOutbox({ except: null, factory })).toBe("discarded");

    host.online = true;
    const second = await openPage();
    await drive(second);
    expect(second.pendingMutations()).toHaveLength(0);
    expect(host.deleted).toEqual([]);
  });

  it("a fresh pairing's discard keeps its own and drops every earlier pairing's", async () => {
    const first = await openPage();
    expect((await first.mutate({ kind: "message_delete", messageId: "m-12" })).status).toBe("queued");
    const earlier = storage.getItem(PAIR_SCOPE_STORAGE_KEY)!;
    storage.setItem(PAIR_SCOPE_STORAGE_KEY, "the-new-pairing");
    const fresh = await openPage();
    expect((await fresh.mutate({ kind: "message_delete", messageId: "m-13" })).status).toBe("queued");
    expect(await discardHostOutbox({ except: "the-new-pairing", factory })).toBe("discarded");
    const kept = (await keysOnDisk(factory)) as string[][];
    expect(kept.map((k) => k[0])).toEqual(["the-new-pairing"]);
    expect(kept.some((k) => k[0] === earlier)).toBe(false);
  });

  it("another pairing's changes are not read, and a fresh pairing does not replay them", async () => {
    const first = await openPage();
    expect((await first.mutate({ kind: "message_delete", messageId: "m-5" })).status).toBe("queued");
    // This browser is paired again — to another computer, or the same one afresh.
    storage.setItem(PAIR_SCOPE_STORAGE_KEY, "another-pairing");
    host.online = true;
    const other = await openPage();
    expect(other.pendingMutations()).toHaveLength(0);
    await drive(other);
    expect(host.deleted).toEqual([]);
  });

  it("a pairing that ended keeps nothing it is still asked to write", async () => {
    const bearer = new BearerManager({ storage, fetchImpl: hostFetch(host) });
    const engine = createHostClientEngine(bearer, { scope: bearer.pairScope(), factory });
    await engine.hydrate();
    await bearer.logout();
    expect(bearer.pairScope()).toBeNull();
    expect((await engine.mutate({ kind: "message_delete", messageId: "m-6" })).status).toBe("queued");
    expect(await keysOnDisk(factory)).toEqual([]);
  });
});

describe("a browser that will not keep them says so once and keeps them in memory", () => {
  it("a database that will not open: the change still goes out while the page is open, and the sentence is said once", async () => {
    const said: number[] = [];
    const page = await openPage({ factory: refusingFactory, onUnkept: () => said.push(1) });
    expect((await page.mutate({ kind: "message_delete", messageId: "m-7" })).status).toBe("queued");
    expect((await page.mutate({ kind: "message_delete", messageId: "m-8" })).status).toBe("queued");
    expect(said).toHaveLength(1);
    host.online = true;
    await drive(page);
    expect(host.deleted.sort()).toEqual(["m-7", "m-8"]);
    expect(said).toHaveLength(1);
  });

  it("a write the database refuses falls back, and what this pairing had kept is cleared", async () => {
    const said: number[] = [];
    const n = { left: 0 };
    const page = await openPage({ factory: refusingWrites(factory, n), onUnkept: () => said.push(1) });
    expect((await page.mutate({ kind: "message_delete", messageId: "m-9" })).status).toBe("queued");
    expect(await keysOnDisk(factory)).toHaveLength(1);
    n.left = 1;
    expect((await page.mutate({ kind: "message_delete", messageId: "m-10" })).status).toBe("queued");
    for (let i = 0; i < 5; i++) await new Promise((r) => { setTimeout(r, 0); });
    expect(said).toHaveLength(1);
    expect(await keysOnDisk(factory)).toEqual([]);
    // Both still wait in this page, and go out when the host comes back.
    expect(page.pendingMutations()).toHaveLength(2);
    host.online = true;
    await drive(page);
    expect(host.deleted.sort()).toEqual(["m-10", "m-9"]);
  });

  it("a jar that refused to hold the pairing keeps nothing and says so once, however often it is loaded", async () => {
    const said: number[] = [];
    const store = new HostOutboxStore({ scope: null, live: () => true, factory, onUnkept: () => said.push(1) });
    await store.load();
    await store.load();
    await store.commitLocal([{ type: "outbox_entry", id: "e-1", entity: { id: "e-1" } }], []);
    expect(said).toHaveLength(1);
    expect(await keysOnDisk(factory)).toEqual([]);
  });

  it("control: the ordinary case says nothing", async () => {
    const said: number[] = [];
    const page = await openPage({ onUnkept: () => said.push(1) });
    expect((await page.mutate({ kind: "message_delete", messageId: "m-11" })).status).toBe("queued");
    host.online = true;
    await drive(page);
    expect(host.deleted).toEqual(["m-11"]);
    expect(said).toEqual([]);
  });
});
