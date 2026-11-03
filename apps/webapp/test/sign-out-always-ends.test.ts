/** @vitest-environment jsdom */
/**
 * SIGN OUT ALWAYS ENDS. Two waits on the press had no end: the sign-out door queued behind a
 * renewal holding the refresh lock and then gave up without asking the server (measured on
 * ohmail.app: 15 s, then "another tab is finishing a sign-in or sign-out" over this tab's own
 * renewal, the session left live), and once granted it awaited a request with no deadline. Both
 * end now: the door is asked even behind a held lock, and an unanswered request is given up at
 * its deadline with the local half done and the server half named as unconfirmed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { apiRoutes, createApp, csrfTokenFor } from "@trafficflow/api";
import { refreshTokens, sessions } from "@trafficflow/db";
import { generateToken, hashToken } from "@trafficflow/services";
import { FIXED_NOW, makeDeps, seedSession } from "../../../packages/api/test/helpers.js";
import { withNodeBlobs } from "./fixtures/node-blobs";

process.env.NEXT_PUBLIC_API_BASE = "/api";

/** A minimal Web Locks manager: exclusive, FIFO, and honours an abort of the WAIT. */
function installLocks(): void {
  const queues = new Map<string, Array<() => void>>();
  const busy = new Set<string>();
  const request = async (
    name: string, opts: { mode?: string; signal?: AbortSignal }, fn: () => Promise<unknown>,
  ): Promise<unknown> => {
    if (busy.has(name)) {
      await new Promise<void>((resolve, reject) => {
        const waiter = (): void => resolve();
        const queue = queues.get(name) ?? [];
        queue.push(waiter);
        queues.set(name, queue);
        opts.signal?.addEventListener("abort", () => {
          const q = queues.get(name) ?? [];
          const at = q.indexOf(waiter);
          if (at >= 0) q.splice(at, 1);
          reject(new DOMException("The request was aborted.", "AbortError"));
        });
      });
    }
    busy.add(name);
    try {
      return await fn();
    } finally {
      busy.delete(name);
      (queues.get(name) ?? []).shift()?.();
    }
  };
  Object.defineProperty(globalThis.navigator, "locks", { value: { request }, configurable: true });
}

/** A request the network never answers; only an abort of its own signal ends it. */
const never = (init?: RequestInit): Promise<Response> => new Promise((_resolve, reject) => {
  init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
});

let asked: string[] = [];
let priorFetch: typeof globalThis.fetch;

beforeEach(() => {
  vi.useFakeTimers();
  installLocks();
  asked = [];
  document.cookie = "tf_owner=acct_A; Path=/";
  document.cookie = "tf_csrf=csrf-a; Path=/";
  priorFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = priorFetch;
  vi.useRealTimers();
  Reflect.deleteProperty(globalThis.navigator as unknown as Record<string, unknown>, "locks");
  document.cookie = "tf_owner=; Path=/; Max-Age=0";
  document.cookie = "tf_csrf=; Path=/; Max-Age=0";
  vi.restoreAllMocks();
  vi.resetModules();
});

const settled = <T>(p: Promise<T>): { value: T | undefined; done: boolean } => {
  const box: { value: T | undefined; done: boolean } = { value: undefined, done: false };
  void p.then((v) => { box.value = v; box.done = true; });
  return box;
};

describe("the pending marker lives until the next visit finishes the sign-out", () => {
  it("it is written with the refresh family's lifetime, not as a session cookie", async () => {
    // A session cookie was forgotten at a browser restart while the refresh token lived on, and
    // the next person to open ohmail.app was resumed into the session somebody had signed out of.
    const { markSignedOutPending } = await import("../app/shell/owner-cookie.js");
    let written = "";
    markSignedOutPending((c) => { written = c; });
    expect(written).toMatch(/^tf_owner=signed_out_pending; /);
    expect(written, "the marker dies with the browser session").toMatch(/; Max-Age=7776000;/);
    expect(written).toMatch(/; Path=\//);
  });
});

describe("sign out ends, and asks the server even behind a renewal", () => {
  it("a renewal holding the refresh lock: the sign-out door is still asked and confirms", async () => {
    globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input);
      asked.push(url);
      if (url.endsWith("/auth/refresh")) return never(init);
      if (url.endsWith("/auth/refresh/logout")) return Promise.resolve(new Response(null, { status: 204 }));
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof globalThis.fetch;
    const { resumeSession } = await import("../app/session-refresh.js");
    void resumeSession();
    await vi.advanceTimersByTimeAsync(0);
    expect(asked.filter((u) => u.endsWith("/auth/refresh")), "the renewal never took the lock").toHaveLength(1);

    const { signOut } = await import("../app/sign-out.js");
    const out = settled(signOut("acct_A"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(asked, "the sign-out gave up behind the renewal without asking the server")
      .toContain("/auth/refresh/logout");
    expect(out.done, "the press never ended").toBe(true);
    expect(out.value?.serverRefused, "a confirmed sign-out was reported as refused").toBeNull();
  });

  it("a sign-out door that never answers: the press ends at its deadline, the local half done", async () => {
    globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input);
      asked.push(url);
      if (url.endsWith("/auth/refresh/logout")) return never(init);
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof globalThis.fetch;
    const { signOut } = await import("../app/sign-out.js");
    const out = settled(signOut("acct_A"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(asked).toContain("/auth/refresh/logout");
    expect(out.done, "Signing out… for ever: the request had no deadline").toBe(true);
    expect(out.value?.serverRefused, "an unanswered sign-out was reported as confirmed").not.toBeNull();
    expect(document.cookie, "the local half did not run").toContain("tf_owner=signed_out_pending");
  });
});

/**
 * THE BROWSER OVER THE REAL ROUTES, holding what Chrome holds. `fetch` reaches `createApp(apiRoutes)`
 * on PGlite through the web's rewrites (`/api/*`, the bare refresh path) with a jar: the HttpOnly
 * cookies here, the others in `document.cookie`, each sent where its path reaches. An answer carrying
 * `Clear-Site-Data` is held as Chrome 151 was measured holding one while it walks its disk cache: it
 * settles at `release()` and its cookie clears apply then; an abort before that rejects with
 * AbortError and drops them. `hold` picks other answers to keep the same way: the server has
 * answered, the browser has not taken the answer in yet. Real timers: PGlite may stall under fake ones.
 */
async function heldBrowser(opts: { hold?: (url: string, init: RequestInit) => boolean } = {}): Promise<{
  account: string; refresh: string; revoked: () => Promise<boolean>; familyLive: () => Promise<boolean>;
  httpOnly: Map<string, { value: string; path: string }>;
  sent: Array<{ url: string; init: RequestInit }>; held: Array<{ url: string; release: () => void }>; releaseAll: () => void;
}> {
  const { db, deps } = await withNodeBlobs(() => makeDeps());
  const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
  const [row] = await db.select({ familyId: sessions.familyId }).from(sessions).where(eq(sessions.id, s.sessionId));
  const refresh = generateToken();
  await db.insert(refreshTokens).values({
    accountId: s.accountId, userId: s.userId, sessionId: s.sessionId, familyId: row!.familyId,
    tokenHash: hashToken(refresh), expiresAt: new Date(FIXED_NOW.getTime() + 2 * 60 * 60 * 1000), createdAt: FIXED_NOW,
  });
  const httpOnly = new Map([
    ["tf_session", { value: s.token, path: "/" }], ["tf_refresh", { value: refresh, path: "/auth/refresh" }],
    ["tf_resume", { value: "1", path: "/" }],
  ]);
  document.cookie = `tf_csrf=${csrfTokenFor(s.token)}; Path=/`;
  document.cookie = `tf_owner=${s.accountId}; Path=/`;
  const apply = (lines: string[]): void => {
    for (const line of lines) {
      const [pair = "", ...attrs] = line.split(";").map((a) => a.trim());
      const name = pair.slice(0, pair.indexOf("="));
      const value = pair.slice(pair.indexOf("=") + 1);
      const gone = attrs.some((a) => /^max-age=0$/i.test(a));
      if (attrs.some((a) => /^httponly$/i.test(a))) {
        if (gone) httpOnly.delete(name);
        else httpOnly.set(name, { value, path: attrs.find((a) => /^path=/i.test(a))?.slice(5) ?? "/" });
      } else document.cookie = gone ? `${name}=; Path=/; Max-Age=0` : `${name}=${value}; Path=/`;
    }
  };
  const app = createApp(apiRoutes);
  const sent: Array<{ url: string; init: RequestInit }> = [];
  const held: Array<{ url: string; release: () => void }> = [];
  globalThis.fetch = vi.fn((input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    sent.push({ url, init });
    const headers = new Headers(init.headers);
    const jar = [...httpOnly].filter(([, c]) => c.path === "/" || url === c.path || url.startsWith(`${c.path}/`))
      .map(([n, c]) => `${n}=${c.value}`).concat(document.cookie ? document.cookie.split("; ") : []);
    if (jar.length > 0) headers.set("cookie", jar.join("; "));
    const request = new Request(`http://localhost${url.replace(/^\/api\//, "/")}`, {
      method: init.method ?? "GET", headers, body: init.body as BodyInit | undefined,
    });
    const keep = opts.hold?.(url, init) === true;
    return new Promise<Response>((resolve, reject) => {
      let aborted = false;
      const abort = (): void => { aborted = true; reject(new DOMException("The operation was aborted.", "AbortError")); };
      if (init.signal?.aborted) return abort();
      init.signal?.addEventListener("abort", abort, { once: true });
      void app.handle(request, { ...deps, session: null, idempotency: null }).then((res) => {
        const settle = (): void => {
          if (aborted) return;
          init.signal?.removeEventListener("abort", abort);
          apply(res.headers.getSetCookie());
          resolve(res);
        };
        if (res.headers.get("clear-site-data") === null && !keep) settle();
        else held.push({ url, release: settle });
      }, reject);
    });
  }) as unknown as typeof globalThis.fetch;
  (await import("../app/api-client.js")).bindApiOwner(s.accountId);
  const revoked = async (): Promise<boolean> => {
    const [r] = await db.select({ revokedAt: refreshTokens.revokedAt }).from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hashToken(refresh)));
    return r?.revokedAt instanceof Date;
  };
  /** A token of the family can still mint: the press's door did not end it. */
  const familyLive = async (): Promise<boolean> => (await db.select({ revokedAt: refreshTokens.revokedAt })
    .from(refreshTokens).where(eq(refreshTokens.familyId, row!.familyId))).some((r) => r.revokedAt === null);
  return {
    account: s.accountId, refresh, revoked, familyLive, httpOnly, sent, held,
    releaseAll: () => { for (const h of held.splice(0)) h.release(); },
  };
}

/** Wait, on real timers, until `ok` holds. */
async function until(ok: () => boolean, ms = 10_000): Promise<void> {
  for (const end = Date.now() + ms; !ok() && Date.now() < end;) await new Promise((r) => setTimeout(r, 10));
  expect(ok(), "the awaited request never reached the server").toBe(true);
}

/** The browser takes in the held answer to `url` now, its Set-Cookie included. */
function release(world: { held: Array<{ url: string; release: () => void }> }, url: string): void {
  const at = world.held.findIndex((h) => h.url === url);
  expect(at, `no answer to ${url} is held`).toBeGreaterThanOrEqual(0);
  world.held.splice(at, 1)[0]!.release();
}

const isHeld = (world: { held: Array<{ url: string }> }, url: string) => (): boolean => world.held.some((h) => h.url === url);

/**
 * AN ANSWER THAT CROSSES THE PRESS NEVER RENAMES THE JAR. A renewal and a session check decided their
 * Set-Cookie from the jar as the request left; Sign out pressed meanwhile wrote the reserved word, the
 * answer landed after it and named the account again, and a booting tab's checks then read an account.
 * The server writes the marker only on a sign-in now; the client heals a silent jar and re-stamps its own.
 */
describe("an answer that crosses the Sign out press never names the account again", () => {
  const RENEWAL = (url: string, init: RequestInit): boolean =>
    url === "/auth/refresh" && new Headers(init.headers).get("x-ohmail-clear") === null;
  const DOOR = "/auth/refresh/logout";
  const CHECK = "/api/auth/session";

  it("a renewal out at the press: its 204 leaves the reserved word, and the door's 204 ends the family", async () => {
    vi.useRealTimers();
    const world = await heldBrowser({ hold: (url, init) => RENEWAL(url, init) || url === DOOR });
    try {
      const { resumeSession } = await import("../app/session-refresh.js");
      const { signOut } = await import("../app/sign-out.js");
      const { readOwnerMarker } = await import("../app/shell/owner-cookie.js");
      const renewed = resumeSession();
      await until(isHeld(world, "/auth/refresh"));
      // The press waits 3 s for the lock the renewal holds, then asks the door without it.
      const out = signOut(world.account);
      await until(isHeld(world, DOOR));
      release(world, "/auth/refresh");
      expect(await renewed).toBe("resumed");
      expect(readOwnerMarker().kind, "the renewal's answer named the account under the pending sign-out").toBe("signed-out");
      release(world, DOOR);
      const ended = await out;
      expect({ serverRefused: ended.serverRefused, marker: readOwnerMarker().kind, familyLive: await world.familyLive() })
        .toEqual({ serverRefused: null, marker: "absent", familyLive: false });
    } finally {
      world.releaseAll();
    }
  }, 30_000);

  /** Tab 2's jar says nothing (a browser restart took the marker); its client is public. */
  async function silentTab(): Promise<void> {
    document.cookie = "tf_owner=; Path=/; Max-Age=0";
    (await import("../app/api-client.js")).bindApiOwner(null);
  }

  it("a session check out at the press over a silent jar: the account answers, the reserved word stays, nothing may bind", async () => {
    vi.useRealTimers();
    const world = await heldBrowser({ hold: (url) => url === CHECK || url === DOOR });
    try {
      await silentTab();
      const { resolveOwnerOutcome } = await import("../app/(product)/session-outcome.js");
      const { bindRefusal } = await import("../app/(product)/approve/settle-owner.js");
      const { signOut } = await import("../app/sign-out.js");
      const { readOwnerMarker } = await import("../app/shell/owner-cookie.js");
      const check = resolveOwnerOutcome();
      await until(isHeld(world, CHECK));
      const out = signOut(world.account);
      await until(isHeld(world, DOOR));
      release(world, CHECK);
      expect(await check).toEqual({ kind: "owner", accountId: world.account });
      expect(readOwnerMarker().kind, "the check's answer named the account under the pending sign-out").toBe("signed-out");
      expect(bindRefusal(world.account)).toBe("owner_signed_out");
      release(world, DOOR);
      expect((await out).serverRefused).toBeNull();
    } finally {
      world.releaseAll();
    }
  }, 30_000);

  it("CONTROL: with no press, the check puts the account back in the silent jar", async () => {
    vi.useRealTimers();
    const world = await heldBrowser();
    await silentTab();
    const { resolveOwnerOutcome } = await import("../app/(product)/session-outcome.js");
    const { readOwnerMarker } = await import("../app/shell/owner-cookie.js");
    expect(await resolveOwnerOutcome()).toEqual({ kind: "owner", accountId: world.account });
    expect(readOwnerMarker()).toEqual({ kind: "account", id: world.account });
  }, 30_000);

  it("a session check answered after the sign-out ended on the 204: no answer, and the emptied jar stays empty", async () => {
    vi.useRealTimers();
    const world = await heldBrowser({ hold: (url) => url === CHECK });
    try {
      await silentTab();
      const { resolveOwnerOutcome } = await import("../app/(product)/session-outcome.js");
      const { signOut } = await import("../app/sign-out.js");
      const { readOwnerMarker } = await import("../app/shell/owner-cookie.js");
      const check = resolveOwnerOutcome();
      await until(isHeld(world, CHECK));
      expect((await signOut(world.account)).serverRefused).toBeNull();
      release(world, CHECK);
      expect(await check).toEqual({ kind: "unknown", retryAfterMs: null });
      expect(readOwnerMarker().kind, "a signed-out jar was given the account's name").toBe("absent");
    } finally {
      world.releaseAll();
    }
  }, 30_000);
});

describe("an answer Chrome holds for its cache walk never holds the sign-out or the erase", () => {
  it("the sign-out press is confirmed at once, the jar cleared, and one purge sent that nothing awaits", async () => {
    vi.useRealTimers();
    const world = await heldBrowser();
    try {
      const { signOut } = await import("../app/sign-out.js");
      const { readOwnerMarker } = await import("../app/shell/owner-cookie.js");
      const started = Date.now();
      const out = await signOut(world.account);
      const took = Date.now() - started;
      const purges = world.sent.filter((s) => s.url === "/auth/refresh"
        && new Headers(s.init.headers).get("x-ohmail-clear") === "cache");
      expect({
        withinTwoSeconds: took < 2_000, serverRefused: out.serverRefused, marker: readOwnerMarker().kind,
        refreshKept: world.httpOnly.has("tf_refresh"), familyRevoked: await world.revoked(), purges: purges.length,
      }, `a confirmed sign-out read as unconfirmed (${took} ms)`).toEqual({
        withinTwoSeconds: true, serverRefused: null, marker: "absent", refreshKept: false, familyRevoked: true, purges: 1,
      });
      expect(purges[0]!.init).toMatchObject({ method: "POST", keepalive: true, cache: "no-store", credentials: "same-origin" });
      expect(purges[0]!.init.body).toBeUndefined();
      // The purge's own answer carries the clear and is still held: the press never waited on it.
      expect(world.held.map((h) => h.url)).toEqual(["/auth/refresh"]);
    } finally {
      world.releaseAll();
    }
  }, 30_000);

  it("account.erase() resolves at once with its receipt and the jar cleared", async () => {
    vi.useRealTimers();
    const world = await heldBrowser();
    const { account } = await import("../app/api-client.js");
    const erase = account.erase();
    try {
      const answer = await Promise.race([erase, new Promise<"held">((r) => setTimeout(() => r("held"), 2_000))]);
      expect(answer, "the receipt was held for a cache walk").not.toBe("held");
      expect(answer).toMatchObject({ erased: true });
      expect([...world.httpOnly.keys()], "the erase's cookie clears").toEqual([]);
      expect(document.cookie).not.toContain("tf_owner=");
    } finally {
      world.releaseAll();
      await erase.catch(() => undefined);
    }
  }, 30_000);
});
