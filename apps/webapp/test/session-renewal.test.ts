/** @vitest-environment jsdom */
/**
 * RENEWAL AHEAD OF EXPIRY (SESSIONS-023).
 *
 * Every minted or confirmed session arms ONE renewal at a fixed share of the fifteen-minute access window,
 * through `resumeSession` and its cross-tab lock, so the boundary is met in the background rather
 * than by a person's request. Two tabs share one jar: the first renews, the second finds a new
 * `tf_csrf` inside the lock and spends nothing. Tabs are two module instances here, sharing the
 * jsdom cookie jar, one fetch and one real FIFO lock.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Tab = {
  truth: typeof import("../app/shell/session-truth");
  refresh: typeof import("../app/session-refresh");
};

const MIN = 60_000;
let answers: Array<() => Response> = [];
let refreshes = 0;
let csrf = 0;
let visibility: DocumentVisibilityState = "visible";

const minted = (): Response => {
  // A mint re-issues every session cookie; `tf_csrf` is the readable one.
  csrf += 1;
  document.cookie = `tf_csrf=c${csrf}; Path=/`;
  return new Response(null, { status: 204 });
};
const db503 = (): Response => new Response(
  JSON.stringify({ error: { code: "db_busy", message: "busy" } }),
  { status: 503, headers: { "content-type": "application/json", "retry-after": "5" } },
);
const revoked = (): Response => new Response(
  JSON.stringify({ error: { code: "refresh_revoked", message: "invalid refresh token" } }),
  { status: 401, headers: { "content-type": "application/json" } },
);

async function openTab(): Promise<Tab> {
  vi.resetModules();
  const truth = await import("../app/shell/session-truth");
  const refresh = await import("../app/session-refresh");
  return { truth, refresh };
}

async function advance(ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 1_000) {
    await vi.advanceTimersByTimeAsync(Math.min(1_000, left));
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-09-23T08:00:00.000Z"));
  // Jitter at zero: the renewal is due at exactly 12:00, so 11:59 is a clean control.
  vi.spyOn(Math, "random").mockReturnValue(0);
  answers = [minted];
  refreshes = 0;
  csrf = 0;
  visibility = "visible";
  document.cookie = "tf_owner=acct_A; Path=/";
  document.cookie = "tf_csrf=c0; Path=/";
  // The session in the jar was minted as the tabs open — (g) below drives the other ages.
  window.localStorage.setItem("ohmail.session.mintedAt", String(Date.now()));
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
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
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    // The cache purge after a refusal presents nothing, and is not counted as a renewal.
    if (new Headers(init?.headers).has("x-ohmail-clear")) return new Response(null, { status: 202 });
    if (String(input).includes("/auth/refresh")) {
      refreshes += 1;
      return answers[Math.min(refreshes, answers.length) - 1]!();
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  Reflect.deleteProperty(globalThis.navigator as unknown as Record<string, unknown>, "locks");
  Reflect.deleteProperty(document as unknown as Record<string, unknown>, "visibilityState");
  document.cookie = "tf_owner=; Path=/; Max-Age=0";
  document.cookie = "tf_csrf=; Path=/; Max-Age=0";
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("(f) one renewal at 12 of 15 minutes, across two tabs", () => {
  it("two tabs armed together: nothing at 11:59, ONE refresh at 12:00, one again at 24:00", async () => {
    const a = await openTab();
    const b = await openTab();
    a.truth.markSessionAlive();
    b.truth.markSessionAlive();
    await advance(12 * MIN - 1_000);
    expect(refreshes, "a renewal fired before 80% of the window").toBe(0);
    await advance(1_000);
    expect(refreshes, "two tabs renewed one jar twice — or neither renewed").toBe(1);
    await advance(12 * MIN);
    expect(refreshes, "the second window was not renewed exactly once").toBe(2);
  });

  it("a hidden tab does not renew; it pays the renewal when it is shown again", async () => {
    const a = await openTab();
    a.truth.markSessionAlive();
    visibility = "hidden";
    await advance(14 * MIN);
    expect(refreshes, "a hidden tab renewed").toBe(0);
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await advance(1_000);
    expect(refreshes).toBe(1);
  });

  it("a busy refresh retries on the backoff, starting at the server's Retry-After", async () => {
    answers = [db503, minted];
    const a = await openTab();
    a.truth.markSessionAlive();
    await advance(12 * MIN);
    expect(refreshes).toBe(1);
    await advance(2_000);
    expect(refreshes, "the retry did not wait for Retry-After").toBe(1);
    await advance(4_000);
    expect(refreshes, "a busy renewal was not retried").toBe(2);
  });

  it("a revoked session stops renewing — the death latch owns what happens next", async () => {
    answers = [revoked];
    const a = await openTab();
    a.truth.markSessionAlive();
    await advance(12 * MIN);
    expect(refreshes).toBe(1);
    expect(a.truth.sessionIsDead()).toBe(true);
    expect(a.refresh.renewalArmedForTests()).toBe(false);
  });

  it("a signed-out or changed jar is not renewed", async () => {
    const a = await openTab();
    a.truth.markSessionAlive();
    document.cookie = "tf_owner=acct_B; Path=/";
    await advance(13 * MIN);
    expect(refreshes, "the renewal rotated a session that became somebody else's").toBe(0);
  });

  it("the window it renews in is the server's: 15 minutes, read from the services config", () => {
    const src = readFileSync(resolve("packages/services/src/auth/config.ts"), "utf8");
    const m = /accessTtlMs:\s*(\d+)\s*\*\s*MIN\b/.exec(src);
    expect(m, "the access TTL is no longer spelled `<n> * MIN`").not.toBeNull();
    return openTab().then(({ refresh }) => {
      expect(refresh.ACCESS_WINDOW_MS).toBe(Number(m![1]) * MIN);
      expect(refresh.RENEW_AT_FRACTION).toBe(0.8);
    });
  });
});

/**
 * (g) TIMED FROM THE MINT, NOT FROM THE PAGE. Measured on the tester's own network logs (rounds
 * 2-4, 2026-09-25): every refresh that followed a 401 came 15.0 min after the previous mint with
 * a page load inside that window, and every window without one renewed at 11-12 min. The shell's
 * session confirm arms the renewal on every load, so a load counted twelve minutes from ITSELF
 * and the cookie minted before it lapsed first. The fake server here refuses `/api/*` once the
 * access cookie is fifteen minutes old; a page is a fresh module pair with the old one's timers
 * gone, confirmed the way the shell confirms it, polling like the sync loop with `api()`'s belt.
 */
describe("(g) the renewal is timed from the session's mint, across page loads", () => {
  let serverMint = 0;
  let refused401 = 0;
  let refreshAt: number[] = [];
  const t0 = new Date("2026-09-23T08:00:00.000Z").getTime();
  const since = (): number => Math.round((Date.now() - t0) / 1_000);

  beforeEach(() => {
    window.localStorage.clear();
    serverMint = Date.now();
    refused401 = 0;
    refreshAt = [];
    const mint = (): Response => {
      serverMint = Date.now();
      return minted();
    };
    answers = [mint];
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/auth/refresh")) {
        refreshes += 1;
        refreshAt.push(since());
        return answers[Math.min(refreshes, answers.length) - 1]!();
      }
      if (url.includes("/auth/2fa/totp/verify")) return mint();
      if (Date.now() - serverMint >= 15 * MIN) {
        refused401 += 1;
        return new Response("{}", { status: 401 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => window.localStorage.clear());

  /**
   * A page load: the previous document's timers are gone, the shell confirms, the sync loop polls.
   * `confirmed: false` is the sign-in page, which holds no session to confirm or renew: a confirm
   * there renews a session of unknown age at once, before the sign-in it precedes.
   */
  async function loadPage(confirmed = true): Promise<Tab> {
    // `clearAllTimers` also resets the fake clock to its install time; the page's moment is kept.
    const now = Date.now();
    vi.clearAllTimers();
    vi.setSystemTime(now);
    const tab = await openTab();
    if (confirmed) tab.truth.markSessionAlive();
    const poll = async (): Promise<void> => {
      const res = await fetch("/api/sync");
      if (res.status === 401) await tab.refresh.resumeSession();
      setTimeout(() => { void poll(); }, 8_000);
    };
    setTimeout(() => { void poll(); }, 8_000);
    return tab;
  }

  async function signIn(): Promise<Tab> {
    const tab = await loadPage(false);
    await tab.refresh.withSessionCookieLock(() => fetch("/auth/2fa/totp/verify"));
    tab.truth.markSessionAlive();
    return tab;
  }

  it("pages loaded mid-window renew at the mint's 12 minutes, and no request meets a 401", async () => {
    await signIn();
    let at = 0;
    for (const reloadAt of [5, 9, 20, 26, 33]) {
      await advance((reloadAt - at) * MIN);
      at = reloadAt;
      await loadPage();
    }
    await advance((40 - at) * MIN);
    expect(refused401, "a request met the expired cookie before any renewal").toBe(0);
    expect(refreshAt, "the renewals are the mint's, 12 minutes apart").toEqual([720, 1440, 2160]);
  });

  it("a page whose session's mint is unknown renews at once, then every 12 minutes", async () => {
    await loadPage();
    await advance(2_000);
    expect(refreshAt, "a session of unknown age waited twelve minutes from the page").toEqual([0]);
    await advance(12 * MIN);
    expect(refreshAt).toEqual([0, 720]);
    expect(refused401).toBe(0);
  });

  it("a mint stamped ahead of this clock (a clock stepped back) waits one lead, never longer", async () => {
    window.localStorage.setItem("ohmail.session.mintedAt", String(Date.now() + 60 * MIN));
    await loadPage();
    await advance(12 * MIN);
    expect(refreshAt, "a future stamp pushed the renewal past the cookie").toEqual([720]);
    expect(refused401).toBe(0);
  });

  it("CONTROL — with storage refused, the page's own mint still times it: no renewal storm", async () => {
    const jar = Object.getOwnPropertyDescriptor(window, "localStorage");
    const refuse = (): never => { throw new DOMException("denied", "SecurityError"); };
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get: () => ({ getItem: refuse, setItem: refuse, removeItem: refuse, clear: () => {}, key: refuse, length: 0 }),
    });
    try {
      await signIn();
      await advance(30 * MIN);
      expect(refreshAt, "a refused jar renewed on every tick").toHaveLength(2);
      expect(refused401).toBe(0);
    } finally {
      if (jar !== undefined) Object.defineProperty(window, "localStorage", jar);
    }
  });
});
