import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { MessageDTO, SyncChange, SyncResponse } from "@trafficflow/services/mail";
import { HttpAdapter, MemoryMirrorStore, OhmailEngine, StoreSearchWalker } from "@ohmail/client-engine";
import { searchIndexBuilt, searchIndexProgress } from "@trafficflow/core/mail";
import type { Tx } from "@trafficflow/db";
import { createCloudSidecar, type CloudSidecar } from "../src/cloud-engine.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { freshDataDir } from "./_datadir.js";

/**
 * SEARCH ON A DESKTOP PAIRED WITH OHMAIL CLOUD IS THE ACCOUNT'S. The whole-mailbox verdict and its
 * count come from the account, as on the web; the mirror (a window of the account) answers only
 * while the account cannot be reached, and its answer says so. Driven through `createCloudSidecar`
 * over a fake hosted account and read back through the window's own adapter, engine and walker.
 * The arms run in order: reachable, answering 503, slow, then down (a failed forward marks the
 * install offline for the rest of the file).
 */

const ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MAILBOX = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MIRRORED = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const HOSTED_ONLY = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ACCOUNT_CURSOR = Buffer.from(JSON.stringify({ k: "r", t: "exact", s: 9, d: null, i: HOSTED_ONLY })).toString("base64url");
const iso = (): string => new Date().toISOString();

function dto(id: string, subject: string): MessageDTO {
  return {
    id, accountId: ACCOUNT, mailboxId: MAILBOX, threadId: null, messageIdHeader: `<${id}@x.test>`, subject,
    from: { name: null, address: "heron@birds.test" }, to: [{ name: null, address: "me@ohmail.test" }], cc: [],
    arrivedAt: iso(), date: iso(), folder: "INBOX", snippet: "", unread: true, lastReadAt: null,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: iso(),
  };
}

const firstPage = (): SyncResponse => ({
  changes: {
    creates: [{ type: "message", op: "create", id: MIRRORED, seq: 1, updatedAt: iso(), entity: dto(MIRRORED, "Heron at the pond") } as SyncChange],
    updates: [], moves: [], deletes: [],
  },
  cursor: Buffer.from("1").toString("base64url"), hasMore: false, serverTime: iso(),
});
const emptyPage = (since: string): SyncResponse => ({
  changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: since, hasMore: false, serverTime: iso(),
});

/** The account's answers: a page of one hosted row, an exact count, its own server ms. */
function accountSearch(url: URL): unknown {
  const parts = url.searchParams.get("parts");
  if (url.searchParams.has("address")) return { items: [dto(HOSTED_ONLY, "From the heron")], total: 812, direction: "from" };
  if (parts === "estimate") {
    return { items: [], total: 4321, totalExact: true, tier: "exact", ms: 11, nextCursor: null, bounded: false, facets: null, indexed: { done: 1, total: 4 } };
  }
  return {
    items: [dto(HOSTED_ONLY, "Heron census, all years")], total: 50, totalExact: false, tier: "exact", ms: 37,
    nextCursor: ACCOUNT_CURSOR, bounded: false, facets: null,
  };
}

type Mode = "up" | "503" | "slow" | "down";
const state: { mode: Mode; searches: string[] } = { mode: "up", searches: [] };

const hostedFetch = (async (input: string | URL | Request): Promise<Response> => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const send = (v: unknown, status = 200): Response =>
    new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  if (url.pathname === "/search") {
    state.searches.push(url.searchParams.has("address") ? "address" : url.searchParams.has("cursor") ? "cursor" : url.searchParams.get("parts") ?? "both");
    if (state.mode === "down") throw new TypeError("fetch failed");
    if (state.mode === "503") return send({ error: { code: "unavailable", message: "down for a moment" } }, 503);
    if (state.mode === "slow") return new Promise<Response>(() => undefined);
    return send(accountSearch(url));
  }
  if (state.mode === "down") throw new TypeError("fetch failed");
  if (url.pathname === "/mailboxes") return send(mailboxList([hostedMailbox(MAILBOX, "me@ohmail.test")]));
  if (url.pathname === "/sync") {
    const since = url.searchParams.get("since") ?? "0";
    return send(since === "0" ? firstPage() : emptyPage(since));
  }
  if (url.pathname === "/messages/bodies") return send({ items: [], nextCursor: null });
  return new Response("not found", { status: 404 });
}) as unknown as typeof fetch;

let sidecar: CloudSidecar;
let dataDir: string;
// A Cloud door stands up in 6 to 9 s here; the 5 s default never fired while its pull held the loop.
beforeAll(async () => {
  dataDir = await freshDataDir("ohmail-paired-search-");
  sidecar = await createCloudSidecar({
    dataDir, cloudUrl: "https://cloud.test", address: "me@ohmail.test",
    tokens: { accessToken: "a", refreshToken: "r" }, fetchImpl: hostedFetch, pollIntervalMs: 3_600_000,
    accountFirstBoundMs: 200,
  });
  await sidecar.start();
}, 30_000);
afterAll(async () => {
  await sidecar?.stop().catch(() => undefined);
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

const get = (path: string): Promise<Response> =>
  sidecar.handle(new Request(`http://sidecar${path}`, { headers: { authorization: `Bearer ${sidecar.sessionToken}` } }));

/** The window's own engine over this door, as `bridge-fetch.ts` builds it. */
async function windowEngine(): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  const adapter = new HttpAdapter({
    baseUrl: "http://sidecar",
    fetch: (url: string, init?: RequestInit) => sidecar.handle(new Request(url, {
      ...init, headers: { ...(init?.headers as Record<string, string> | undefined), authorization: `Bearer ${sidecar.sessionToken}` },
    })),
  });
  return new OhmailEngine({ adapter, store });
}

/** One question through the walker the Search view reads, to its settled verdict. */
async function verdictOf(query: string): Promise<ReturnType<StoreSearchWalker["info"]>> {
  const engine = await windowEngine();
  const walker = new StoreSearchWalker(engine);
  walker.start({ query }, () => [], 0);
  for (let i = 0; i < 200 && (walker.state() === "searching" || walker.info()?.totalExact === false); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const info = walker.info();
  walker.clear();
  return info;
}

describe("reachable: the whole-mailbox verdict and count are the account's", () => {
  it("the page, the count and the server ms are the account's, never the mirror's", async () => {
    state.mode = "up";
    state.searches = [];
    const engine = await windowEngine();
    const page = await engine.searchServer("heron", { parts: "page" });
    expect(page.state).toBe("ready");
    if (page.state !== "ready") return;
    expect(page.items.map((m) => m.id)).toEqual([HOSTED_ONLY]);
    expect(page.ms).toBe(37);
    expect(page.fromMirror).toBeUndefined();
    expect(state.searches).toEqual(["page"]);
  });

  it("the settled verdict the view renders is the account's exact count, in two relayed requests", async () => {
    state.searches = [];
    const info = await verdictOf("heron");
    expect(info).toMatchObject({ total: 4321, totalExact: true, ms: 37, fromMirror: false });
    // The round trips a search costs on this door: the page, then the count off its path.
    expect(state.searches).toEqual(["page", "estimate"]);
  });

  it("the account's own index progress is relayed: the account's store fills its index", async () => {
    const info = await verdictOf("heron");
    expect(info).toMatchObject({ fromMirror: false, indexed: { done: 1, total: 4 } });
  });

  it("the address arm is the account's too", async () => {
    state.searches = [];
    const res = await get("/search?address=heron%40birds.test&direction=from");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { total: number }).total).toBe(812);
    expect(state.searches).toEqual(["address"]);
  });
});

describe("unreachable: the mirror answers, and says it is the mirror", () => {
  it("the account answering 503: the mirror's page, stamped, its cursor tagged as the mirror's", async () => {
    state.mode = "503";
    const res = await get("/search?q=heron&parts=page&limit=50");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }>; answeredFrom?: string };
    expect(body.items.map((m) => m.id)).toEqual([MIRRORED]);
    expect(body.answeredFrom).toBe("mirror");
    const info = await verdictOf("heron");
    expect(info).toMatchObject({ total: 1, totalExact: true, fromMirror: true });
  });

  // "Older mail is still being indexed" over a settled mirror. The mirror writes each letter's
  // search document with the letter and no marker: this composition runs no backfill to write one.
  it("the mirror's answer carries no index progress: no pass here fills that index", async () => {
    state.mode = "503";
    const db = sidecar.db as unknown as Tx;
    expect(await searchIndexBuilt(db, sidecar.world.accountId)).toBe(false);
    expect(await searchIndexProgress(db, sidecar.world.accountId)).toEqual({ done: 1, total: 1 });
    const res = await get("/search?q=heron&parts=estimate&limit=50");
    const body = (await res.json()) as { answeredFrom?: string; total?: number; indexed?: unknown };
    expect(body).toMatchObject({ answeredFrom: "mirror", total: 1 });
    expect(body.indexed).toBeUndefined();
    expect(await verdictOf("heron")).toMatchObject({ fromMirror: true, indexed: null });
  });

  it("a mirror walk's cursor stays on the mirror, even once the account answers again", async () => {
    state.mode = "up";
    state.searches = [];
    const res = await get(`/search?q=heron&parts=page&cursor=${encodeURIComponent(`m.${ACCOUNT_CURSOR}`)}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { answeredFrom?: string }).answeredFrom).toBe("mirror");
    expect(state.searches).toEqual([]);
  });

  it("an account walk's cursor never continues on the mirror: offline, it is refused", async () => {
    state.mode = "503";
    const res = await get(`/search?q=heron&parts=page&cursor=${ACCOUNT_CURSOR}`);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("offline_read_only");
  });

  it("the address arm is refused rather than answered with the mirror's count as the whole mailbox's", async () => {
    const res = await get("/search?address=heron%40birds.test&direction=from");
    expect(res.status).toBe(503);
  });

  it("an account that does not answer within the bound: the mirror answers, stamped", async () => {
    state.mode = "slow";
    // The bound on a FAKE clock, the mirror on real turns: the hosted search is asked in the run
    // that arms the bound, so from there only the clock moves the answer to the mirror.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const t0 = Date.now();
      const before = state.searches.length;
      let answered = false;
      const pending = get("/search?q=heron&parts=page").finally(() => { answered = true; });
      while (state.searches.length === before) await new Promise((r) => setImmediate(r));
      await vi.advanceTimersByTimeAsync(199);
      expect(answered, "the mirror answered before the account's bound").toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const res = await pending;
      expect(res.status).toBe(200);
      expect(((await res.json()) as { answeredFrom?: string }).answeredFrom).toBe("mirror");
      expect(Date.now() - t0).toBeLessThan(3_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the network down: the mirror answers, stamped", async () => {
    state.mode = "down";
    const info = await verdictOf("heron");
    expect(info).toMatchObject({ total: 1, fromMirror: true });
  });
});

describe("CONTROL: a question the mirror can refuse is refused the same way", () => {
  it("an unknown sort is the mirror's 400 while offline, unstamped", async () => {
    const res = await get(`/search?q=heron&sort=${randomUUID()}`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { answeredFrom?: string }).answeredFrom).toBeUndefined();
  });
});
