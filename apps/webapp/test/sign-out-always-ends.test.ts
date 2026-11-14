/** @vitest-environment jsdom */
/**
 * SIGN OUT ALWAYS ENDS. Two waits on the press had no end: the sign-out door queued behind a
 * renewal holding the refresh lock and then gave up without asking the server (measured on
 * ohmail.app: 15 s, then "another tab is finishing a sign-in or sign-out" over this tab's own
 * renewal, the session left live), and once granted it awaited a request with no deadline. Both
 * end now: the door is asked even behind a held lock, and an unanswered request is given up at
 * its deadline with the local half done and the server half named as unconfirmed.
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { apiRoutes, createApp, csrfTokenFor, sessionCookies } from "@trafficflow/api";
import { refreshTokens, sessions } from "@trafficflow/db";
import { pushSubscriptions } from "@trafficflow/db/cloud";
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
  document.cookie = "tf_family=; Path=/; Max-Age=0";
  localStorage.removeItem("ohmail.session.pendingSignOut");
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith("ohmail.session.scopeCleanup.")) localStorage.removeItem(key);
  }
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
    const { markSignedOutPending } = await import("@ohmail/app-logic/storage/owner-cookie");
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
 * `closable`: every request stays on its way, unseen by the server, until `close()` (a tab closed at that moment).
 */
const isLogoutClear = (init: RequestInit) => new Headers(init.headers).get("X-Ohmail-Clear-Logout") === "1";

async function heldBrowser(opts: {
  hold?: (url: string, init: RequestInit) => boolean; closable?: boolean; knownFamily?: boolean; holdPurge?: boolean;
} = {}): Promise<{
  account: string; family: string; refresh: string; revoked: () => Promise<boolean>; familyLive: () => Promise<boolean>;
  httpOnly: Map<string, { value: string; path: string }>; db: Awaited<ReturnType<typeof makeDeps>>["db"];
  sent: Array<{ url: string; init: RequestInit }>; held: Array<{ url: string; release: () => void }>; releaseAll: () => void;
  close: () => Promise<void>;
  replaceSession: () => Promise<{ account: string; family: string }>;
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
  if (opts.knownFamily !== false) document.cookie = `tf_family=${row!.familyId}; Path=/`;
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
  const replaceSession = async () => {
    const replacement = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const [next] = await db.select({ familyId: sessions.familyId }).from(sessions)
      .where(eq(sessions.id, replacement.sessionId));
    const nextRefresh = generateToken();
    await db.insert(refreshTokens).values({
      accountId: replacement.accountId, userId: replacement.userId, sessionId: replacement.sessionId,
      familyId: next!.familyId, tokenHash: hashToken(nextRefresh),
      expiresAt: new Date(FIXED_NOW.getTime() + 2 * 60 * 60 * 1000), createdAt: FIXED_NOW,
    });
    const { withSessionCookieLock } = await import("../app/session-refresh.js");
    await withSessionCookieLock(async () => {
      apply(sessionCookies({
        accessToken: replacement.token, refreshToken: nextRefresh, tokenType: "Bearer", expiresIn: 900,
      }, csrfTokenFor(replacement.token), deps.authConfig, replacement.accountId, next!.familyId));
    });
    return { account: replacement.accountId, family: next!.familyId };
  };
  const app = createApp(apiRoutes);
  const sent: Array<{ url: string; init: RequestInit }> = [];
  const held: Array<{ url: string; release: () => void }> = [];
  const onTheWay: Array<{ init: RequestInit; go: () => Promise<void>; drop: () => void }> = [];
  let gone = false;
  globalThis.fetch = vi.fn((input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    if (gone) return Promise.reject(new TypeError("Failed to fetch"));
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
      const go = (): Promise<void> => app.handle(request, { ...deps, session: null, idempotency: null }).then((res) => {
        const settle = (): void => {
          if (aborted) return;
          init.signal?.removeEventListener("abort", abort);
          apply(res.headers.getSetCookie());
          resolve(res);
        };
        if (!keep && (res.headers.get("clear-site-data") === null || opts.holdPurge === false)) settle();
        else held.push({ url, release: settle });
      }, reject);
      if (opts.closable === true) onTheWay.push({ init, go, drop: abort });
      else void go();
    });
  }) as unknown as typeof globalThis.fetch;
  /** `pagehide`, then the kept-alive requests on their way reach the server in order, the rest never; nothing after. */
  const close = async (): Promise<void> => {
    window.dispatchEvent(new Event("pagehide"));
    gone = true;
    for (const r of onTheWay.splice(0)) {
      if (r.init.keepalive === true) await r.go();
      else r.drop();
    }
  };
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
    account: s.accountId, family: row!.familyId, refresh, revoked, familyLive, httpOnly, db, sent, held, close, replaceSession,
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
    const world = await heldBrowser({ hold: (url, init) => RENEWAL(url, init) || (url === DOOR && !isLogoutClear(init)) });
    try {
      const { resumeSession } = await import("../app/session-refresh.js");
      const { signOut } = await import("../app/sign-out.js");
      const { readOwnerMarker } = await import("@ohmail/app-logic/storage/owner-cookie");
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
      const { readOwnerMarker } = await import("@ohmail/app-logic/storage/owner-cookie");
      const check = resolveOwnerOutcome();
      await until(isHeld(world, CHECK));
      const out = signOut(world.account);
      await until(isHeld(world, DOOR));
      release(world, CHECK);
      expect(await check).toEqual({ kind: "owner", accountId: world.account, familyId: world.family });
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
    const { readOwnerMarker } = await import("@ohmail/app-logic/storage/owner-cookie");
    expect(await resolveOwnerOutcome()).toEqual({ kind: "owner", accountId: world.account, familyId: world.family });
    expect(readOwnerMarker()).toEqual({ kind: "account", id: world.account });
  }, 30_000);

  it("a session check answered after the sign-out ended on the 204: no answer, and the emptied jar stays empty", async () => {
    vi.useRealTimers();
    const world = await heldBrowser({ hold: (url) => url === CHECK });
    try {
      await silentTab();
      const { resolveOwnerOutcome } = await import("../app/(product)/session-outcome.js");
      const { signOut } = await import("../app/sign-out.js");
      const { readOwnerMarker } = await import("@ohmail/app-logic/storage/owner-cookie");
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

  /** The access window lapsed too: no access cookie and no `tf_csrf` as the check leaves, so it renews. */
  async function lapsedTab(world: { httpOnly: Map<string, unknown> }): Promise<void> {
    await silentTab();
    world.httpOnly.delete("tf_session");
    document.cookie = "tf_csrf=; Path=/; Max-Age=0";
  }
  const renewals = (world: { sent: Array<{ url: string; init: RequestInit }> }): number =>
    world.sent.filter((s) => RENEWAL(s.url, s.init)).length;

  it("a check that renewed, answered after another tab's sign-out 204: no answer, and the emptied jar stays empty", async () => {
    vi.useRealTimers();
    let checks = 0;
    const world = await heldBrowser({ hold: (url) => url === CHECK && ++checks === 2 });
    try {
      await lapsedTab(world);
      const { setThisTabForTest } = await import("../app/signed-out-signal.js");
      const { resolveOwnerOutcome } = await import("../app/(product)/session-outcome.js");
      const { signOut } = await import("../app/sign-out.js");
      const { readOwnerMarker } = await import("@ohmail/app-logic/storage/owner-cookie");
      const check = resolveOwnerOutcome();
      await until(isHeld(world, CHECK));
      expect(renewals(world), "premise: the check renewed").toBe(1);
      // Another tab presses: this tab's own press count never moves.
      setThisTabForTest("another-tab");
      expect((await signOut(world.account)).serverRefused).toBeNull();
      release(world, CHECK);
      expect({ answer: await check, marker: readOwnerMarker().kind }, "a signed-out jar was given the account's name")
        .toEqual({ answer: { kind: "unknown", retryAfterMs: null }, marker: "absent" });
    } finally {
      world.releaseAll();
    }
  }, 30_000);

  it("CONTROL: a check that renewed with no press puts the account back in the silent jar", async () => {
    vi.useRealTimers();
    const world = await heldBrowser();
    await lapsedTab(world);
    const { resolveOwnerOutcome } = await import("../app/(product)/session-outcome.js");
    const { readOwnerMarker } = await import("@ohmail/app-logic/storage/owner-cookie");
    expect(await resolveOwnerOutcome()).toEqual({ kind: "owner", accountId: world.account, familyId: world.family });
    expect(renewals(world), "premise: the check renewed").toBe(1);
    expect(readOwnerMarker()).toEqual({ kind: "account", id: world.account });
  }, 30_000);
});

describe("an answer Chrome holds for its cache walk never holds the sign-out or the erase", () => {
  it("the sign-out press is confirmed at once, the jar cleared, and one purge sent that nothing awaits", async () => {
    vi.useRealTimers();
    const world = await heldBrowser();
    try {
      const { signOut } = await import("../app/sign-out.js");
      const { readOwnerMarker } = await import("@ohmail/app-logic/storage/owner-cookie");
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
      const { signOutTrouble } = await import("../app/sign-out-trouble.js");
      expect(signOutTrouble(out)?.key).toBe("signOutCleanupPending");
      expect(out.cleared).toBe(false);
      release(world, "/auth/refresh");
      await out.cacheCleanup?.settled;
      expect(signOutTrouble(out)).toBeNull();
      expect(out.cleared).toBe(true);
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

/**
 * A TAB CLOSED AT THE PRESS. No page load follows it to finish the sign-out, and the browser cancels the
 * requests of a page that goes away unless they were sent `keepalive`: the server session lived on.
 */
describe("a tab closed at the Sign out press still ends the session at the server", () => {
  const DOOR = "/auth/refresh/logout";

  it("the door's request on its way: the browser finishes it, and it was sent once", async () => {
    vi.useRealTimers();
    const world = await heldBrowser({ closable: true });
    const { signOut } = await import("../app/sign-out.js");
    const out = signOut(world.account);
    await until(() => world.sent.some((s) => s.url === DOOR));
    await world.close();
    expect({ familyLive: await world.familyLive(), doors: world.sent.filter((s) => s.url === DOOR).length },
      "the door's request died with the tab, or went twice").toEqual({ familyLive: false, doors: 1 });
    await out;
  }, 30_000);

  it("pagehide presents the confirmed family while the cookie lock is held", async () => {
    vi.useRealTimers();
    const world = await heldBrowser({ closable: true });
    const { signOut } = await import("../app/sign-out.js");
    const { withSessionCookieLock } = await import("../app/session-refresh.js");
    const gate = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    const lock = withSessionCookieLock(async () => {
      held.resolve();
      await gate.promise;
    });
    await held.promise;
    const out = signOut(world.account, { expectedFamily: world.family });
    try {
      await world.close();
      const requests = world.sent.filter((s) => s.url === DOOR);
      expect(requests).toHaveLength(1);
      expect(new Headers(requests[0]!.init.headers).get("X-Ohmail-Expected-Family") === world.family).toBe(true);
      expect(await world.familyLive()).toBe(false);
      expect(world.httpOnly.has("tf_refresh")).toBe(true);
    } finally {
      gate.resolve();
      await lock;
      await out;
    }
  }, 30_000);

  it("a legacy pagehide revokes the family and its wake row without clearing the browser", async () => {
    vi.useRealTimers();
    const world = await heldBrowser({ closable: true, knownFamily: false });
    await world.db.insert(pushSubscriptions).values({
      id: randomUUID(), accountId: world.account, transport: "webpush",
      endpoint: "https://push.example/ep/closed-tab", sessionFamilyId: world.family,
    });
    const { signOut } = await import("../app/sign-out.js");
    const { withSessionCookieLock } = await import("../app/session-refresh.js");
    const gate = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    const lock = withSessionCookieLock(async () => {
      held.resolve();
      await gate.promise;
    });
    await held.promise;
    const out = signOut(world.account);
    try {
      await world.close();
      expect(world.sent.filter((s) => s.url === DOOR)).toHaveLength(1);
      expect((await world.db.select().from(pushSubscriptions))).toHaveLength(0);
      expect(await world.familyLive()).toBe(false);
      expect(world.httpOnly.has("tf_refresh")).toBe(true);
    } finally {
      gate.resolve();
      await lock;
      await out;
    }
  }, 30_000);
});


describe("signing out without Web Locks", () => {
  it.each(["confirmed family", "older session"] as const)(
    "a delayed logout for a %s leaves the replacement sign-in and its browser data intact",
    async (kind) => {
      vi.useRealTimers();
      Reflect.deleteProperty(navigator, "locks");
      const world = await heldBrowser({
        hold: (url, init) => url === "/auth/refresh/logout" && !isLogoutClear(init),
        knownFamily: kind === "confirmed family",
      });
      const { signOut } = await import("../app/sign-out.js");
      const { readOwner } = await import("@ohmail/app-logic/storage/owner-cookie");
      const { readSessionFamily } = await import("../app/signed-out-signal");
      const out = kind === "confirmed family"
        ? signOut(world.account, { expectedFamily: world.family }) : signOut(world.account);
      const shared = "ohmail.face.account";
      const departed = `ohmail.screener.intents.${world.account}`;
      localStorage.setItem(departed, "departed");
      try {
        await until(isHeld(world, "/auth/refresh/logout"));
        expect(await world.familyLive()).toBe(false);
        const replacement = await world.replaceSession();
        localStorage.setItem(shared, "replacement");
        release(world, "/auth/refresh/logout");
        await out;

        expect(readOwner() === replacement.account).toBe(true);
        expect(readSessionFamily() === replacement.family).toBe(true);
        expect(world.httpOnly.has("tf_session") && world.httpOnly.has("tf_refresh")).toBe(true);
        expect(world.sent.some((s) => isLogoutClear(s.init))).toBe(false);
        expect(localStorage.getItem(shared)).toBe("replacement");
        expect(localStorage.getItem(departed)).toBeNull();
      } finally {
        world.releaseAll();
        localStorage.removeItem(shared);
        localStorage.removeItem(departed);
      }
    }, 30_000,
  );
});


it("a browser with Web Locks and no confirmed family keeps shared stores and cookies", async () => {
  vi.useRealTimers();
  const world = await heldBrowser({ knownFamily: false });
  const { signOut } = await import("../app/sign-out.js");
  const shared = "ohmail.face.account";
  localStorage.setItem(shared, "shared");
  try {
    expect((await signOut(world.account)).serverRefused).toBeNull();
    expect(await world.familyLive()).toBe(false);
    expect(world.httpOnly.has("tf_refresh")).toBe(true);
    expect(world.sent.some((s) => isLogoutClear(s.init))).toBe(false);
    expect(localStorage.getItem(shared)).toBe("shared");
  } finally {
    localStorage.removeItem(shared);
  }
}, 30_000);


it.each([
  { knownFamily: true, withLocks: false },
  { knownFamily: false, withLocks: true },
])("reports incomplete cleanup when shared data survives (known family $knownFamily, locks $withLocks)",
  async ({ knownFamily, withLocks }) => {
    vi.useRealTimers();
    if (!withLocks) Reflect.deleteProperty(navigator, "locks");
    const world = await heldBrowser({ knownFamily });
    const { signOut } = await import("../app/sign-out.js");
    const { signOutTrouble } = await import("../app/sign-out-trouble.js");
    const { readOwnerMarker } = await import("@ohmail/app-logic/storage/owner-cookie");
    const draft = "ohmail.ui.compose";
    const wake = "ohmail.notifications.subscriptionId";
    localStorage.setItem(draft, "fixture draft");
    localStorage.setItem(wake, "fixture registration");
    try {
      const out = await signOut(world.account);
      expect(await world.familyLive()).toBe(false);
      expect(world.httpOnly.has("tf_refresh")).toBe(true);
      expect(readOwnerMarker().kind).toBe("signed-out");
      expect(localStorage.getItem(draft)).toBe("fixture draft");
      expect(localStorage.getItem(wake)).toBe("fixture registration");
      expect(out.cleared).toBe(false);
      expect(signOutTrouble(out)).toEqual({ key: "signOutUnverified" });
    } finally {
      localStorage.removeItem(draft);
      localStorage.removeItem(wake);
    }
  }, 30_000,
);

it("stops a scoped sweep when the same account gains a new family", async () => {
  vi.useRealTimers();
  Reflect.deleteProperty(navigator, "locks");
  const world = await heldBrowser();
  const { signOut } = await import("../app/sign-out.js");
  const first = `ohmail.ui.compose.${world.account}.first`;
  const next = `ohmail.ui.compose.${world.account}.next`;
  localStorage.setItem(first, "departed draft");
  localStorage.setItem(next, "departed draft");
  const remove = Storage.prototype.removeItem;
  const spy = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (this: Storage, key) {
    remove.call(this, key);
    if (this === localStorage && key === first) {
      document.cookie = `tf_owner=${world.account}; Path=/`;
      document.cookie = "tf_family=replacement-family; Path=/";
      localStorage.setItem(next, "replacement draft");
    }
  });
  try {
    expect((await signOut(world.account)).cleared).toBe(false);
    expect(localStorage.getItem(first)).toBeNull();
    expect(localStorage.getItem(next)).toBe("replacement draft");
    expect(world.sent.some((entry) => isLogoutClear(entry.init))).toBe(false);
  } finally {
    spy.mockRestore();
    localStorage.removeItem(first);
    localStorage.removeItem(next);
  }
}, 30_000);

it("a pending finisher with no departed account reports the surviving private data", async () => {
  vi.useRealTimers();
  const world = await heldBrowser({ knownFamily: false });
  const { finishPendingSignOut } = await import("../app/(product)/login/finish-sign-out.js");
  const { markSignedOutPending } = await import("@ohmail/app-logic/storage/owner-cookie");
  const draft = "ohmail.ui.compose";
  const wake = "ohmail.notifications.subscriptionId";
  localStorage.setItem(draft, "fixture draft");
  localStorage.setItem(wake, "fixture registration");
  markSignedOutPending();
  try {
    const result = await finishPendingSignOut({ isCancelled: () => false, attempts: 1 });
    expect(await world.familyLive()).toBe(false);
    expect(world.httpOnly.has("tf_refresh")).toBe(true);
    expect(localStorage.getItem(draft)).toBe("fixture draft");
    expect(localStorage.getItem(wake)).toBe("fixture registration");
    expect(result).toEqual({ outcome: "stopped", said: { key: "signOutUnverified" } });
  } finally {
    localStorage.removeItem(draft);
    localStorage.removeItem(wake);
  }
}, 30_000);


it("the same pending sign-out can finish its cleanup after Web Locks are available", async () => {
  vi.useRealTimers();
  Reflect.deleteProperty(navigator, "locks");
  const world = await heldBrowser({ holdPurge: false });
  const { signOut } = await import("../app/sign-out.js");
  const { finishPendingSignOut } = await import("../app/(product)/login/finish-sign-out.js");
  const draft = "ohmail.ui.compose";
  const wake = "ohmail.notifications.subscriptionId";
  localStorage.setItem(draft, "fixture draft");
  localStorage.setItem(wake, "fixture registration");
  try {
    expect((await signOut(world.account)).cleared).toBe(false);
    expect(localStorage.getItem(draft)).toBe("fixture draft");
    expect(localStorage.getItem(wake)).toBe("fixture registration");
    installLocks();
    const done = await finishPendingSignOut({ isCancelled: () => false, attempts: 1 });
    if (done.cleanup) {
      expect(done.outcome).toBe("stopped");
      expect(done.said).toEqual({ key: "signOutCleanupPending" });
      expect(await done.cleanup).toBeNull();
    } else {
      expect(done).toEqual({ outcome: "confirmed", said: null });
    }
    expect(localStorage.getItem(draft)).toBeNull();
    expect(localStorage.getItem(wake)).toBeNull();
    expect(world.httpOnly.has("tf_session") || world.httpOnly.has("tf_refresh")).toBe(false);
  } finally {
    localStorage.removeItem(draft);
    localStorage.removeItem(wake);
  }
}, 30_000);


it("reports incomplete server sign-out for a live family after cleaning this device", async () => {
  vi.useRealTimers();
  Reflect.deleteProperty(navigator, "locks");
  const world = await heldBrowser();
  const { signOut } = await import("../app/sign-out.js");
  const { signOutTrouble } = await import("../app/sign-out-trouble.js");
  const draft = `ohmail.ui.compose.${world.account}.fixture`;
  localStorage.setItem(draft, "fixture draft");
  const send = globalThis.fetch;
  globalThis.fetch = (input, init) => String(input).endsWith("/auth/refresh/logout")
    ? Promise.resolve().then(() => { throw new TypeError("Network unavailable"); })
    : send(input, init);
  try {
    const out = await signOut(world.account);
    expect(await world.familyLive()).toBe(true);
    expect(signOutTrouble(out)?.key).toBe("signOutServerRefused");
    expect(localStorage.getItem(draft)).toBeNull();
    expect(world.httpOnly.has("tf_refresh")).toBe(true);
  } finally {
    localStorage.removeItem(draft);
  }
}, 30_000);

it("reports incomplete cleanup if the cache purge rejects after dispatch", async () => {
  vi.useRealTimers();
  const world = await heldBrowser();
  const { signOut } = await import("../app/sign-out.js");
  const { signOutTrouble } = await import("../app/sign-out-trouble.js");
  const send = globalThis.fetch;
  let purges = 0;
  globalThis.fetch = (input, init) => {
    if (new Headers(init?.headers).get("x-ohmail-clear") !== "cache") return send(input, init);
    purges += 1;
    return Promise.resolve().then(() => { throw new TypeError("Cache purge unavailable"); });
  };
  const out = await signOut(world.account);
  expect(await world.familyLive()).toBe(false);
  await out.cacheCleanup?.settled;
  expect(purges).toBe(2);
  expect(signOutTrouble(out)?.key).toBe("signOutUnverified");
}, 30_000);


it("clears an owed draft before reopening the same account and preserves subsequent drafts", async () => {
  vi.useRealTimers();
  Reflect.deleteProperty(navigator, "locks");
  const world = await heldBrowser();
  const { finishAccountCleanup, PENDING_SIGN_OUT_KEY, signOut } = await import("../app/sign-out.js");
  const { accountCleanupOwed } = await import("../app/pending-sign-out-storage.js");
  const draft = `ohmail.ui.compose.${world.account}.fixture`;
  localStorage.setItem(draft, "departed draft");
  const remove = Storage.prototype.removeItem;
  const refused = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (this: Storage, key) {
    if (this === localStorage && key === draft) return;
    remove.call(this, key);
  });
  try {
    const out = await signOut(world.account);
    expect(out.serverRefused).toBeNull();
    expect(out.cleared).toBe(false);
    expect(accountCleanupOwed(world.account)).toBe(true);
    expect(localStorage.getItem(draft)).toBe("departed draft");
    localStorage.removeItem(PENDING_SIGN_OUT_KEY);
    expect(accountCleanupOwed(world.account), "a later pending operation must not erase the cleanup fence").toBe(true);
    refused.mockRestore();
    document.cookie = `tf_owner=${world.account}; Path=/`;
    document.cookie = "tf_family=replacement-family; Path=/";
    expect(await finishAccountCleanup(world.account, "replacement-family")).toBe(true);
    expect(localStorage.getItem(draft)).toBeNull();
    localStorage.setItem(draft, "replacement draft");
    expect(await finishAccountCleanup(world.account, "replacement-family")).toBe(true);
    expect(localStorage.getItem(draft)).toBe("replacement draft");
  } finally {
    refused.mockRestore();
    localStorage.removeItem(draft);
  }
}, 30_000);

it("keeps a confirmed revocation usable for sign-in when a later logout request could not be sent", async () => {
  vi.useRealTimers();
  Reflect.deleteProperty(navigator, "locks");
  const world = await heldBrowser();
  const { signOut } = await import("../app/sign-out.js");
  const { finishPendingSignOut } = await import("../app/(product)/login/finish-sign-out.js");
  const first = await signOut(world.account);
  expect(first.serverRefused).toBeNull();
  expect(first.cleared).toBe(false);
  expect(await world.familyLive()).toBe(false);
  const requests = vi.fn(() => Promise.reject(new TypeError("Network unavailable")));
  globalThis.fetch = requests;
  expect(await finishPendingSignOut({ isCancelled: () => false, attempts: 1 }))
    .toEqual({ outcome: "stopped", said: { key: "signOutUnverified" } });
  expect(requests).not.toHaveBeenCalled();
}, 30_000);

it("an ownerless legacy sign-out cannot attribute a different account's private stores to itself", async () => {
  vi.useRealTimers();
  const world = await heldBrowser({ knownFamily: false });
  const { finishPendingSignOut } = await import("../app/(product)/login/finish-sign-out.js");
  const { markSignedOutPending } = await import("@ohmail/app-logic/storage/owner-cookie");
  const { finishAccountCleanup } = await import("../app/sign-out.js");
  const { IDBFactory } = await import("fake-indexeddb");
  const { mirrorDbName } = await import("@ohmail/client-engine");
  const disk = new IDBFactory();
  vi.stubGlobal("indexedDB", disk);
  const unattached = "ohmail.ui.compose";
  localStorage.setItem(unattached, "unattributed draft");
  markSignedOutPending();
  try {
    expect((await finishPendingSignOut({ isCancelled: () => false, attempts: 1 })).outcome).toBe("stopped");
    expect(await world.familyLive()).toBe(false);
    const replacement = await world.replaceSession();
    expect(replacement.account === world.account).toBe(false);
    const draft = `ohmail.ui.compose.${replacement.account}.fixture`;
    const queue = `ohmail.screener.intents.${replacement.account}`;
    localStorage.setItem(draft, "replacement draft");
    localStorage.setItem(queue, "replacement queue");
    const mirror = mirrorDbName(replacement.account);
    await new Promise<void>((resolve, reject) => {
      const request = disk.open(mirror);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => { request.result.close(); resolve(); };
    });
    try {
      expect(await finishAccountCleanup(replacement.account, replacement.family)).toBe(true);
      expect(localStorage.getItem(draft)).toBe("replacement draft");
      expect(localStorage.getItem(queue)).toBe("replacement queue");
      expect((await disk.databases()).some(({ name }) => name === mirror)).toBe(true);
      expect(localStorage.getItem(unattached)).toBe("unattributed draft");
    } finally {
      localStorage.removeItem(draft);
      localStorage.removeItem(queue);
    }
  } finally {
    vi.unstubAllGlobals();
    localStorage.removeItem(unattached);
  }
}, 30_000);

it("a failed legacy revocation removes the authenticated departed account's private draft", async () => {
  vi.useRealTimers();
  const world = await heldBrowser({ knownFamily: false });
  const { signOut } = await import("../app/sign-out.js");
  const draft = `ohmail.ui.compose.${world.account}.fixture`;
  localStorage.setItem(draft, "departed draft");
  const send = globalThis.fetch;
  globalThis.fetch = (input, init) => String(input).endsWith("/auth/refresh/logout")
    ? Promise.reject(new TypeError("Network unavailable"))
    : send(input, init);
  try {
    expect((await signOut(world.account)).serverRefused).not.toBeNull();
    expect(await world.familyLive()).toBe(true);
    expect(localStorage.getItem(draft)).toBeNull();
  } finally {
    localStorage.removeItem(draft);
  }
}, 30_000);

it("an unlocked sign-out carries the retired draft obligation through another account's sign-in", async () => {
  vi.useRealTimers();
  Reflect.deleteProperty(navigator, "locks");
  const world = await heldBrowser();
  const { finishAccountCleanup, signOut } = await import("../app/sign-out.js");
  const { composeDraftKey, readComposeDraft } = await import("@ohmail/app-logic/writing/compose");
  const { EMPTY_RICH } = await import("@ohmail/app-logic/writing/rich-text");
  const { readReplyDraft, replyDraftKey } = await import("@ohmail/app-logic/writing/mail-send");
  const reply = replyDraftKey("fixture-message", null);
  const legacy = "ohmail.ui.compose";
  const departed = composeDraftKey(world.account);
  localStorage.setItem(reply, "unattributed reply");
  localStorage.setItem(legacy, JSON.stringify({ subject: "unattributed old draft" }));
  localStorage.setItem(departed, JSON.stringify({ subject: "owned old draft" }));
  try {
    expect((await signOut(world.account)).cleared).toBe(false);
    expect(localStorage.getItem(departed)).toBeNull();
    expect(localStorage.getItem("ohmail.session.scopeCleanup.legacy")).not.toBeNull();
    const replacement = await world.replaceSession();
    expect(await finishAccountCleanup(replacement.account, replacement.family)).toBe(true);
    expect(readComposeDraft(replacement.account).subject).toBe("");
    expect(readReplyDraft("fixture-message", replacement.account)).toEqual(EMPTY_RICH);
    expect(localStorage.getItem(reply)).toBe("unattributed reply");
    expect(localStorage.getItem(legacy)).not.toBeNull();
    expect(localStorage.getItem("ohmail.session.scopeCleanup.legacy")).not.toBeNull();
  } finally {
    localStorage.removeItem(reply);
    localStorage.removeItem(legacy);
    localStorage.removeItem(departed);
  }
}, 30_000);

it.each([false, true])("a late unlocked logout clears only the retired compose draft (retry %s)", async (retry) => {
  vi.useRealTimers();
  Reflect.deleteProperty(navigator, "locks");
  const world = await heldBrowser({ hold: (url) => url === "/auth/refresh/logout", holdPurge: false });
  const { signOut } = await import("../app/sign-out.js");
  const { finishRetiredComposeCleanup } = await import("../app/pending-sign-out-storage");
  const { readOwner } = await import("@ohmail/app-logic/storage/owner-cookie");
  const retired = "ohmail.ui.compose";
  const preference = "ohmail.face.account";
  localStorage.setItem(retired, "retired draft");
  const out = signOut(world.account);
  try {
    await until(isHeld(world, "/auth/refresh/logout"));
    expect(await world.familyLive()).toBe(false);
    const replacement = await world.replaceSession();
    const replacementDraft = `ohmail.ui.compose.${replacement.account}.fixture`;
    localStorage.setItem(preference, "replacement");
    localStorage.setItem(replacementDraft, "replacement draft");
    const remove = Storage.prototype.removeItem;
    const removal = retry ? vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (this: Storage, key) {
      if (this !== localStorage || key !== retired) remove.call(this, key);
    }) : undefined;
    try {
      release(world, "/auth/refresh/logout");
      await out;
      expect(readOwner() === replacement.account).toBe(true);
      expect(world.httpOnly.has("tf_refresh")).toBe(true);
      expect(world.sent.some((entry) => isLogoutClear(entry.init))).toBe(false);
      expect(localStorage.getItem(preference)).toBe("replacement");
      expect(localStorage.getItem(replacementDraft)).toBe("replacement draft");
      if (retry) {
        expect(localStorage.getItem(retired)).toBe("retired draft");
        removal?.mockRestore();
        finishRetiredComposeCleanup();
      }
      expect(localStorage.getItem(retired)).toBeNull();
      expect(localStorage.getItem(replacementDraft)).toBe("replacement draft");
    } finally {
      removal?.mockRestore();
      localStorage.removeItem(replacementDraft);
    }
  } finally {
    world.releaseAll();
    localStorage.removeItem(retired);
    localStorage.removeItem(preference);
  }
}, 30_000);
