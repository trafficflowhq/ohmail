import { describe, expect, it } from "vitest";
import { HttpAdapter, MemoryMirrorStore, OhmailEngine, type EngineMessage } from "@ohmail/client-engine";
import { BearerManagerRN, type RefreshVault } from "../src/net/bearer";
import {
  createSessionReask, storeSearchWalkerFor, storeWalkerFor,
  type StoreSearchWalker, type StoreTimelineWalker,
} from "../src/state/live";

/**
 * THE PHONE'S HISTORY AND SEARCH OVER A RENEWAL. The paired door's transport rotates once on a
 * 401; when that rotation cannot answer (a busy server), the 401 reaches the read, and nothing
 * asked the store again when a later rotation minted a fresh pair — History stayed on "did not
 * answer" until a press. Both reads now bind the engine's one re-ask rule (the web binds the same
 * one) to the bearer: loading while the renewal is out, asked again once the pair is adopted.
 * Real walkers, the real HTTP adapter and the real bearer over a fake server.
 */

const ORIGIN = "https://phone.test";
const NOW = "2026-09-23T12:00:00.000Z";

function row(n: number): EngineMessage {
  const date = new Date(Date.parse(NOW) - n * 3_600_000).toISOString();
  return {
    id: `00000000-0000-4000-8000-${(0xffffffff - n).toString(16).padStart(12, "0")}`,
    accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null, subject: `subject ${n}`,
    from: { name: null, address: "x@example.invalid" }, to: [], cc: [], date, folder: "INBOX",
    snippet: "", unread: false, hasAttachments: false, attachmentCount: 0, sensitivity: {}, triage: null,
    labels: [], remoteContent: "none", updatedAt: date,
  } as unknown as EngineMessage;
}

const ROWS = Array.from({ length: 30 }, (_, i) => row(i));
const vault: RefreshVault = {
  save: async () => "landed", clear: async () => "landed", armAttempt: async () => "landed", oweSignOut: async () => false,
};
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The server: only the last minted access token is honoured; each refresh takes the next answer. */
function server(refreshAnswers: Array<"busy" | "mint" | (() => Promise<"mint">)>, pages?: number) {
  let honoured = pages === undefined ? "" : "acc-stale";
  let minted = 0;
  const calls = { refresh: 0, timeline: 0, search: 0 };
  const fetchImpl = async (url: string, init?: unknown): Promise<Response> => {
    const i = (init ?? {}) as { headers?: Record<string, string> };
    if (url.endsWith("/auth/refresh")) {
      calls.refresh += 1;
      let next = refreshAnswers.shift() ?? "busy";
      if (typeof next === "function") next = await next();
      if (next === "busy") return json({ error: { code: "host_busy" } }, 503);
      minted += 1;
      honoured = `acc-${minted}`;
      return json({ tokens: { accessToken: honoured, refreshToken: `ref-${minted}` } });
    }
    if (url.includes("/messages/timeline")) calls.timeline += 1;
    if (url.includes("/search?")) calls.search += 1;
    if (i.headers?.authorization !== `Bearer ${honoured}`) {
      return json({ error: { code: "unauthorized", message: "authentication required" } }, 401);
    }
    if (pages !== undefined) return json({ error: { code: "db_busy" } }, pages);
    if (url.includes("/messages/timeline")) {
      return json({ total: ROWS.length, months: [{ month: "2026-09", count: ROWS.length, first: { date: ROWS[0]!.date, id: ROWS[0]!.id } }], undated: 0 });
    }
    if (url.includes("/messages?")) return json({ items: ROWS, nextCursor: null });
    if (url.includes("/search?")) return json({ items: ROWS.slice(0, 5), total: 5 });
    return json({ error: { code: "not_found" } }, 404);
  };
  return { fetchImpl, calls };
}

async function phone(refreshAnswers: Parameters<typeof server>[0], pages?: number) {
  const srv = server(refreshAnswers, pages);
  const bearer = new BearerManagerRN({
    origin: ORIGIN, accessToken: "acc-stale", refreshToken: "ref-0", vault, fetchImpl: srv.fetchImpl,
  });
  const adapter = new HttpAdapter({
    baseUrl: ORIGIN, fetch: bearer.fetch, headers: () => bearer.headers(), getCookie: () => null,
  });
  const store = new MemoryMirrorStore();
  await store.load();
  const engine = new OhmailEngine({ adapter, store, now: () => new Date(NOW) });
  return { srv, bearer, engine };
}

/** The phone's History read, exactly as `store-views.ts` hands it to the rule. */
function historyRead(walker: StoreTimelineWalker) {
  return {
    subscribe: walker.subscribe,
    cause: () => walker.failureCause(),
    answered: () => walker.state() === "ready",
    reask: () => walker.start(),
  };
}

function searchRead(walker: StoreSearchWalker, ask: () => void) {
  return {
    subscribe: walker.subscribe,
    cause: () => walker.failureCause(),
    answered: () => walker.info() !== null,
    reask: ask,
  };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5));
};

function held(): { gate: () => Promise<"mint">; open: () => void } {
  let open: () => void = () => {};
  const p = new Promise<"mint">((r) => { open = () => r("mint"); });
  return { gate: () => p, open };
}

describe("the phone's store reads over a renewal", () => {
  it("CONTROL — the walker alone stays on 'did not answer' after the pair is renewed", async () => {
    const { srv, bearer, engine } = await phone(["busy", "mint"]);
    const walker = storeWalkerFor(engine);
    walker.start();
    await settle();
    expect(walker.state()).toBe("unanswered");
    expect(walker.failureCause()).toContain("401");
    // Another request renews the pair (the drain's next 401, here the manager's own door).
    await bearer.fetch(`${ORIGIN}/api/sync`);
    await settle();
    expect(srv.calls.refresh).toBe(2);
    expect(walker.state(), "nothing asked the store again").toBe("unanswered");
  });

  it("History: loading while the renewal is out, asked again once the pair is adopted", async () => {
    const hold = held();
    const { srv, bearer, engine } = await phone(["busy", hold.gate]);
    const walker = storeWalkerFor(engine);
    const rule = createSessionReask(bearer, historyRead(walker));
    rule.attach();
    walker.start();
    await settle();
    expect(walker.state()).toBe("unanswered");
    expect(rule.renewing(), "a refused session read as a silent server").toBe(true);
    expect(srv.calls.refresh, "the read asked no renewal of its own").toBe(2);
    hold.open();
    await settle();
    expect(srv.calls.timeline, "no second ask after the renewal").toBe(2);
    expect(walker.state()).toBe("ready");
    expect(walker.total()).toBe(ROWS.length);
    expect(rule.renewing()).toBe(false);
  });

  it("Search: still searching while the renewal is out, asked again once the pair is adopted", async () => {
    const hold = held();
    const { srv, bearer, engine } = await phone(["busy", hold.gate]);
    const walker = storeSearchWalkerFor(engine);
    const ask = (): void => walker.start({ query: "subject" }, () => [], 0);
    const rule = createSessionReask(bearer, searchRead(walker, ask));
    rule.attach();
    ask();
    await settle();
    expect(walker.failureCause()).toContain("401");
    expect(rule.renewing()).toBe(true);
    expect(srv.calls.search).toBe(1);
    hold.open();
    await settle();
    expect(srv.calls.search, "no second ask after the renewal").toBeGreaterThan(1);
    expect(walker.info()?.total).toBe(5);
    expect(rule.renewing()).toBe(false);
  });

  it("CONTROL — a busy server is said at once: no renewal asked by the read, no re-ask", async () => {
    const { srv, bearer, engine } = await phone(["mint"], 503);
    const walker = storeWalkerFor(engine);
    const rule = createSessionReask(bearer, historyRead(walker));
    rule.attach();
    walker.start();
    await settle();
    expect(walker.state()).toBe("unanswered");
    expect(rule.renewing()).toBe(false);
    expect(srv.calls.refresh).toBe(0);
    expect(srv.calls.timeline).toBe(1);
  });
});
