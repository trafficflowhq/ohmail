/** @vitest-environment jsdom */
/**
 * A REQUEST WAITS FOR THE RENEWAL ALREADY IN FLIGHT.
 *
 * A rotation replaces the session's access token when the refresh REACHES the server, and the new
 * cookie arrives with its answer. A request that left beside it carrying the old token and arrived
 * after the rotation was refused 401, renewed a second time and retried. Measured locally on a cold
 * boot of a planted jar: 11 of 20 boots. The server is modelled that way here (a refresh arrives in
 * 10 ms and is answered in 10 more, any other request arrives in 20 and is answered in 20 more), with
 * the real api-client, refresh and transport; only `fetch` and the jar are faked. Two shapes: the
 * cold boot (a session of unknown age renews at once beside the first snapshot) and the scheduled
 * renewal at its share of the window with requests in flight. A request that left BEFORE a renewal began
 * is refused once and sent again, never renewed twice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.NEXT_PUBLIC_API_BASE = "/api";

const MIN = 60_000;
const REFRESH_ARRIVES_MS = 10;
const REQUEST_ARRIVES_MS = 20;

interface Sent { at: number; url: string; status: number | null; csrf: string | null; refreshPresented?: number }
let sent: Sent[] = [];
/** The access token the SERVER holds for this session, and the one this browser's jar holds. */
let serverAccess = 0;
let jarAccess = 0;
/** The refresh token generation the server will accept, and the one the jar presents. */
let serverRefresh = 0;
let jarRefresh = 0;
let reuse = 0;
let domainAttrs = 0;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function later<T>(ms: number, fn: () => T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(fn()), ms));
}

function serve(url: string, init?: RequestInit): Promise<Response> {
  const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)
    .map(([k, v]) => [k.toLowerCase(), v]));
  const row: Sent = { at: Date.now(), url, status: null, csrf: headers["x-csrf-token"] ?? null };
  sent.push(row);
  if (url === "/auth/refresh") {
    const presented = jarRefresh;
    row.refreshPresented = presented;
    return later(REFRESH_ARRIVES_MS, () => {
      // Arrival: the rotation commits here. A consumed token presented again is reuse.
      if (presented !== serverRefresh) reuse += 1;
      serverRefresh += 1;
      serverAccess += 1;
      return serverAccess;
    }).then((minted) => later(REFRESH_ARRIVES_MS, () => {
      jarAccess = minted;
      jarRefresh = serverRefresh;
      // The fake's Set-Cookie is host-only like the server's (`sessionCookies`): no Domain=.
      const cookie = `tf_csrf=fresh-${minted}; Path=/`;
      if (/domain=/i.test(cookie)) domainAttrs += 1;
      document.cookie = cookie;
      row.status = 204;
      return new Response(null, { status: 204 });
    }));
  }
  const carried = jarAccess;
  // Decided on ARRIVAL, answered as long again: a 401 lands after a renewal that began just after it left.
  return later(REQUEST_ARRIVES_MS, () => {
    const res = carried !== serverAccess
      ? json(401, { error: { code: "unauthorized", message: "authentication required" } })
      : url.startsWith("/api/sync/snapshot")
        ? json(200, { asOfSeq: 1, changes: [], nextCursor: null, window: { days: 0, minRows: 0 } })
        : json(200, {});
    row.status = res.status;
    return res;
  }).then((res) => later(REQUEST_ARRIVES_MS, () => res));
}

async function advance(ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 5) {
    await vi.advanceTimersByTimeAsync(Math.min(5, left));
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  }
}

async function load() {
  vi.resetModules();
  const truth = await import("../app/shell/session-truth");
  const client = await import("../app/api-client");
  await import("../app/session-refresh");
  client.bindApiOwner("acct_A");
  return { truth, client };
}

const refreshes = () => sent.filter((s) => s.url === "/auth/refresh");
const refused = () => sent.filter((s) => s.status === 401);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-10-04T08:00:00.000Z"));
  vi.spyOn(Math, "random").mockReturnValue(0);
  sent = [];
  serverAccess = jarAccess = 0;
  serverRefresh = jarRefresh = 0;
  reuse = 0;
  domainAttrs = 0;
  document.cookie = "tf_owner=acct_A; Path=/";
  document.cookie = "tf_csrf=c0; Path=/";
  window.localStorage.clear();
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  let chain: Promise<unknown> = Promise.resolve();
  Object.defineProperty(globalThis.navigator, "locks", {
    configurable: true,
    value: {
      request: (_n: string, _o: unknown, cb: () => Promise<unknown>) => {
        const run = chain.then(() => cb());
        chain = run.then(() => undefined, () => undefined);
        return run;
      },
    },
  });
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => serve(String(input), init)) as unknown as typeof fetch;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  const { resetSessionTruthForTests } = await import("../app/shell/session-truth");
  resetSessionTruthForTests();
  Reflect.deleteProperty(globalThis.navigator as unknown as Record<string, unknown>, "locks");
  Reflect.deleteProperty(document as unknown as Record<string, unknown>, "visibilityState");
  document.cookie = "tf_owner=; Path=/; Max-Age=0";
  document.cookie = "tf_csrf=; Path=/; Max-Age=0";
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a request issued while this tab's renewal is in flight waits for it", () => {
  it("COLD BOOT — a session of unknown age: the first snapshot and a read leave after the renewal, refused 0 times", async () => {
    const { truth, client } = await load();
    // The shell's confirm: the revival arms the renewal, then the sync gate opens on the next line.
    truth.markSessionAlive();
    const snapshot = truth.sessionFetch("/api/sync/snapshot");
    const read = client.api("/consent");
    await advance(200);
    const [snap] = await Promise.all([snapshot, read.catch((e: unknown) => e)]);

    expect(snap.status, "the first snapshot was answered by the access token the renewal replaced").toBe(200);
    expect(refused().map((s) => s.url), "a request left beside the renewal and was refused").toEqual([]);
    expect(refreshes(), "a refused request renewed a second time").toHaveLength(1);
    const first = sent.find((s) => s.url === "/api/sync/snapshot")!;
    expect(first.at, "the snapshot left before the renewal settled").toBeGreaterThanOrEqual(2 * REFRESH_ARRIVES_MS);
    expect(reuse, "a refresh token was presented twice").toBe(0);
    expect(domainAttrs).toBe(0);
  });

  it("AT 80% — the scheduled renewal fires: a press and a sync page issued beside it wait, refused 0 times", async () => {
    window.localStorage.setItem("ohmail.session.mintedAt", String(Date.now()));
    const { truth, client } = await load();
    truth.markSessionAlive();
    await advance(12 * MIN - 5);
    expect(refreshes(), "the renewal fired before 12 of 15 minutes").toHaveLength(0);
    await vi.advanceTimersByTimeAsync(5);
    expect(refreshes(), "the scheduled renewal did not start").toHaveLength(1);
    const press = client.api("/messages/m1/triage", { method: "POST", body: { state: "set_aside" } });
    const page = truth.sessionFetch("/api/sync?cursor=c1", { method: "GET" });
    await advance(200);
    const [, res] = await Promise.all([press.catch((e: unknown) => e), page]);

    expect(res.status).toBe(200);
    expect(refused().map((s) => s.url), "a request in flight beside the renewal was refused").toEqual([]);
    expect(refreshes(), "a refused request renewed a second time").toHaveLength(1);
    const pressed = sent.filter((s) => s.url === "/api/messages/m1/triage");
    expect(pressed, "the press was sent twice").toHaveLength(1);
    expect(pressed[0]!.csrf, "the press carried the replaced jar's CSRF token").toBe("fresh-1");
    expect(reuse).toBe(0);
  });

  it("LEFT JUST BEFORE THE RENEWAL — refused once by the rotation, sent again on the new jar, never renewed twice", async () => {
    window.localStorage.setItem("ohmail.session.mintedAt", String(Date.now()));
    const { truth, client } = await load();
    truth.markSessionAlive();
    await advance(12 * MIN - 5);
    await vi.advanceTimersByTimeAsync(3);
    expect(refreshes()).toHaveLength(0);
    const read = client.api("/consent");
    const page = truth.sessionFetch("/api/sync?cursor=c1");
    await advance(300);
    await expect(read).resolves.toEqual({});
    expect((await page).status).toBe(200);
    expect(refreshes(), "a request the first rotation refused started a second").toHaveLength(1);
    expect(sent.filter((s) => s.url === "/api/consent").map((s) => s.status)).toEqual([401, 200]);
    expect(reuse).toBe(0);
  });

  it("a press through the engine's transport that waited carries the renewed CSRF token", async () => {
    window.localStorage.setItem("ohmail.session.mintedAt", String(Date.now()));
    const { truth } = await load();
    truth.markSessionAlive();
    await advance(12 * MIN);
    expect(refreshes()).toHaveLength(1);
    const press = truth.sessionFetch("/api/messages/m1/triage", {
      method: "POST", headers: { "content-type": "application/json", "x-csrf-token": "c0" }, body: "{}",
    });
    await advance(200);
    expect((await press).status).toBe(200);
    expect(sent.find((s) => s.url === "/api/messages/m1/triage")!.csrf).toBe("fresh-1");
  });

  it("CONTROL — nothing in flight: a request leaves at once, and no renewal is started for it", async () => {
    window.localStorage.setItem("ohmail.session.mintedAt", String(Date.now()));
    const { truth, client } = await load();
    // A warm API: a cold one lets its first read lead alone (`shell/resume-lane.ts`).
    (await import("../app/shell/resume-lane")).webLane.noteAnswer();
    truth.markSessionAlive();
    const read = client.api("/consent");
    const snap = truth.sessionFetch("/api/sync/snapshot");
    await advance(100);
    await Promise.all([read, snap]);
    expect(sent.filter((s) => s.url !== "/auth/refresh").every((s) => s.at === sent[0]!.at)).toBe(true);
    expect(refreshes()).toHaveLength(0);
    expect(refused()).toHaveLength(0);
  });

  it("a renewal that meets a fault lets the waiting request go, answered as before", async () => {
    const { truth, client } = await load();
    globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url === "/auth/refresh") {
        sent.push({ at: Date.now(), url, status: 503, csrf: null });
        return later(REFRESH_ARRIVES_MS, () => json(503, { error: { code: "db_busy", message: "busy" } }));
      }
      return serve(url, init);
    }) as unknown as typeof fetch;
    truth.markSessionAlive();
    const read = client.api("/consent");
    await advance(100);
    await expect(read).resolves.toEqual({});
    expect(sent.filter((s) => s.url === "/api/consent")).toHaveLength(1);
  });
});
