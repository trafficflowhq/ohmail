import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RESUME_COOKIE, RESUME_ROUTE, resolveSurface } from "../app/session-gate.js";
import { isRecoverable, mayRefreshFor, REFRESH_ENDPOINT, RENEWAL_DEADLINE_MS, resumeSession } from "../app/session-refresh.js";
import { OWN_PATHS, REFRESH_PATH } from "../next.config.mjs";

/**
 * THE LOCKOUT, AND THE THREE THINGS THAT CAUSED IT.
 *
 * Someone registered on ohmail.app and could not get back into their own account the next day.
 * Three defects, all live, all fixed by this slice:
 *
 *  1. `tf_session` has a FIFTEEN MINUTE `Max-Age`, and nothing in the browser ever called
 *     `POST /auth/refresh`. The route, the rotation, the path-scoped cookie and a dedicated
 *     Next rewrite for it all existed and worked — verified end to end on the hosted service —
 *     and no client code called it. Fifteen minutes after signing in, the gate saw a browser
 *     with no session and served the marketing page.
 *  2. `SameSite=Strict` withholds cookies on cross-site top-level navigation, so a signed-in
 *     user clicking an ohmail.app link from their mail got marketing even INSIDE the fifteen
 *     minutes, with a live session in the jar.
 *  3. There was no sign-in link on the landing page at all.
 *
 * The marker (`tf_resume`, `Lax`, credential-free) is what lets the edge tell "stranger" from
 * "signed-in customer whose access cookie lapsed" — a distinction it previously could not make
 * and therefore always resolved against the customer.
 */
const HERE = fileURLToPath(new URL(".", import.meta.url));
const read = (p: string): string => readFileSync(`${HERE}${p}`, "utf8");

/**
 * Run `resumeSession()` against a stubbed cookie jar and return what it actually sent: the headers and the whole init.
 *
 * `document` and `fetch` are stubbed on the global rather than mocked through a module boundary
 * because that is what the code under test reads: `csrfToken()` walks `document.cookie`, and
 * `resumeSession` calls the bare `fetch` identifier, which resolves to the global at call time.
 * Both are restored in a `finally` so a failing assertion cannot leak a stub into another test.
 */
async function captureRefresh(cookie: string): Promise<{ headers: Record<string, string> | null; init: RequestInit | null }> {
  const g = globalThis as unknown as {
    document?: { cookie: string };
    fetch?: typeof globalThis.fetch;
  };
  const priorDoc = Object.prototype.hasOwnProperty.call(g, "document") ? g.document : undefined;
  const hadDoc = Object.prototype.hasOwnProperty.call(g, "document");
  const priorFetch = g.fetch;
  const seen: { headers: Record<string, string> | null; init: RequestInit | null } = { headers: null, init: null };

  g.document = { cookie };
  g.fetch = (async (_input: unknown, init?: RequestInit & { headers?: Record<string, string> }) => {
    seen.headers = { ...(init?.headers ?? {}) };
    seen.init = init ?? null;
    return new Response(null, { status: 204 });
  }) as unknown as typeof globalThis.fetch;

  try {
    // 204 is the success contract; asserting it here proves the stub was reached at all rather
    // than the call failing somewhere and leaving `seen.headers` null for the wrong reason.
    expect(await resumeSession()).toBe("resumed");
  } finally {
    if (hadDoc) g.document = priorDoc;
    else delete g.document;
    g.fetch = priorFetch;
  }
  return seen;
}
const captureRefreshHeaders = async (cookie: string): Promise<Record<string, string> | null> => (await captureRefresh(cookie)).headers;

const ARMED = "https://api.ohmail.app";
const noNetwork = (): never => {
  throw new Error("the gate must not fetch on this branch");
};

describe("the gate tells a lapsed session from a stranger", () => {
  it("THE REGRESSION: no access cookie + marker ⇒ resume, not marketing", async () => {
    // Exactly the reported state the morning after signing up.
    expect(await resolveSurface({
      sessionToken: null, resumeMarker: true, search: "", apiOrigin: ARMED,
      fetchImpl: noNetwork as unknown as typeof fetch,
    })).toBe("resume");
  });

  it("a stranger is still a stranger — and still costs no fetch", async () => {
    // The control. If this ever answered "resume" the marketing page would be unreachable.
    expect(await resolveSurface({
      sessionToken: null, resumeMarker: false, search: "", apiOrigin: ARMED,
      fetchImpl: noNetwork as unknown as typeof fetch,
    })).toBe("marketing");
    expect(await resolveSurface({
      sessionToken: null, search: "", apiOrigin: ARMED,
      fetchImpl: noNetwork as unknown as typeof fetch,
    })).toBe("marketing");
  });

  it("a live session that the API REFUSES (a CODED 401) resumes when the marker is there", async () => {
    // The central case: the access token is genuinely dead, the refresh token genuinely alive.
    const four01 = async (): Promise<Response> => new Response(
      JSON.stringify({ error: { code: "unauthorized", message: "authentication required" } }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
    expect(await resolveSurface({
      sessionToken: "a".repeat(43), resumeMarker: true, search: "", apiOrigin: ARMED,
      fetchImpl: four01 as unknown as typeof fetch,
    })).toBe("resume");
    expect(await resolveSurface({
      sessionToken: "a".repeat(43), resumeMarker: false, search: "", apiOrigin: ARMED,
      fetchImpl: four01 as unknown as typeof fetch,
    })).toBe("marketing");
    // An UNCODED 401 is a platform in front of the API, not its verdict: the app checks again.
    const platform = async (): Promise<Response> => new Response("{}", { status: 401 });
    expect(await resolveSurface({
      sessionToken: "a".repeat(43), resumeMarker: true, search: "", apiOrigin: ARMED,
      fetchImpl: platform as unknown as typeof fetch,
    })).toBe("app");
  });

  it("a garbage token with a marker still resumes — the TOKEN is what is malformed", async () => {
    expect(await resolveSurface({
      sessionToken: "not a token", resumeMarker: true, search: "", apiOrigin: ARMED,
      fetchImpl: noNetwork as unknown as typeof fetch,
    })).toBe("resume");
  });

  it("the DEMO still wins over the marker", async () => {
    expect(await resolveSurface({
      sessionToken: null, resumeMarker: true, search: "?demo=1", apiOrigin: ARMED,
      fetchImpl: noNetwork as unknown as typeof fetch,
    })).toBe("demo");
  });

  it("an UNARMED deployment never resumes — there is nothing to refresh against", async () => {
    expect(await resolveSurface({
      sessionToken: null, resumeMarker: true, search: "", apiOrigin: null,
      fetchImpl: noNetwork as unknown as typeof fetch,
    })).toBe("marketing");
  });

  it("a TIMEOUT with the marker serves the APP — the cold start is outwaited by the shell's check", async () => {
    // THE OWNER'S MORNING. The gate proves a session with a 1,500ms budget (SESSION_TIMEOUT_MS),
    // and the first request after a deploy pays a serverless cold start that can exceed it. The
    // first contract answered "marketing" — the pitch for a signed-in customer, fixed by a reload.
    // The second answered the splash, which spent a rotation the jar did not need and, while the
    // API stayed busy, looped into the sign-in card over a live 90-day cookie (the 2026-09-22
    // report). The app's own owner check retries on the browser's clock and keeps the mirror.
    const slow = (async (_u: unknown, init?: RequestInit) => {
      await new Promise((_r, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      return new Response();
    }) as unknown as typeof fetch;
    expect(await resolveSurface({
      sessionToken: "a".repeat(43), resumeMarker: true, search: "", apiOrigin: ARMED,
      fetchImpl: slow, timeoutMs: 20,
    })).toBe("app");
  });

  it("a 5xx, a 429 or a network failure with the marker serves the APP — never the splash", async () => {
    // The gate never routes a fault to a write. The API did not answer the question, so the
    // shell asks it again (and says "could not be reached" if it never does); a refresh here
    // would rotate a token nobody doubted. Not marketing either: this browser is signed in.
    const boom = async (): Promise<Response> => new Response("{}", { status: 503 });
    const busy = async (): Promise<Response> => new Response("{}", { status: 429 });
    const dead = (): never => { throw new Error("network"); };
    for (const impl of [boom, busy, dead]) {
      expect(await resolveSurface({
        sessionToken: "a".repeat(43), resumeMarker: true, search: "", apiOrigin: ARMED,
        fetchImpl: impl as unknown as typeof fetch,
      })).toBe("app");
    }
  });

  it("without the marker, an unprovable session still lands on marketing — strangers first", async () => {
    // The marker is the ONLY thing that separates "signed-in customer the API cannot vouch
    // for right now" from "any request that happens to carry a cookie-shaped value". Without
    // it, timeout/5xx/network answers must stay the landing, or an attacker replaying a
    // stolen-shape cookie during an outage reaches the resume surface for free.
    const boom = async (): Promise<Response> => new Response("{}", { status: 500 });
    const dead = (): never => { throw new Error("network"); };
    for (const impl of [boom, dead]) {
      for (const resumeMarker of [false, undefined]) {
        expect(await resolveSurface({
          sessionToken: "a".repeat(43), resumeMarker, search: "", apiOrigin: ARMED,
          fetchImpl: impl as unknown as typeof fetch,
        })).toBe("marketing");
      }
    }
  });

  it("a clean 4xx refusal that is not a 401 does NOT resume — the API answered", async () => {
    // 403/404/400 are answers, not blinks: the token (or the topology) is wrong in a way a
    // refresh does not fix. Only the dead-access-token 401 and the cannot-answer cases
    // (timeout, network, 5xx) earn the splash.
    for (const status of [400, 403, 404]) {
      const refuse = async (): Promise<Response> => new Response("{}", { status });
      expect(await resolveSurface({
        sessionToken: "a".repeat(43), resumeMarker: true, search: "", apiOrigin: ARMED,
        fetchImpl: refuse as unknown as typeof fetch,
      }), String(status)).toBe("marketing");
    }
  });

  it("the splash's own refresh carries no clamp shorter than the server's — it must outwait a cold start", () => {
    // The whole fix rests on the splash having a longer budget than the gate. If someone
    // ever clamps this fetch with AbortSignal.timeout, the cold-start path becomes
    // gate-timeout → splash-timeout → /login, which is WORSE than the landing it replaced.
    // The one deadline it has, `RENEWAL_DEADLINE_MS`, is past the API's own 60 s limit, so a
    // renewal the server is working on always answers first; it ends a request on a dead
    // connection, as `unavailable`, and never a sign-in (`renewal-deadline.test.ts`).
    expect(RENEWAL_DEADLINE_MS, "the renewal's deadline is shorter than the server's own limit").toBeGreaterThan(60_000);
    const src = read("../app/session-refresh.ts");
    expect(src).toMatch(/fetch\(REFRESH_ENDPOINT/);
    expect(src).not.toMatch(/AbortSignal\.timeout/);
    /*
     * SCOPED TO THE FETCH, and it used to be a whole-file ban on `signal:`.
     *
     * That was the right assertion while the only thing in this module that could carry a signal
     * WAS the request. It is not any more: `withSessionCookieLock` aborts the WAIT FOR A LOCK
     * GRANT after a deadline, which is the opposite kind of budget — it bounds how long a
     * ceremony queues behind another tab, and touches the holder's own request not at all. A
     * file-wide ban would have read that as the clamp it forbids.
     *
     * So the ban is where the invariant lives: the `fetch` call's own options. A signal
     * introduced THERE turns a cold start into gate-timeout → splash-timeout → `/login`, which
     * is worse than the landing this replaced.
     */
    const call = src.slice(src.indexOf("fetch(REFRESH_ENDPOINT"));
    const options = call.slice(0, call.indexOf("});") + 3);
    // The request's ONE signal: a sign-in that minted past this refresh aborts it, and so does the
    // request's own deadline, on the same controller and past the server's limit. No other clock
    // may reach it, which the behavioural case below measures as well.
    expect(options.match(/signal[^,\n]*/g) ?? [], "the refresh request grew a clamp — a cold start becomes a sign-out")
      .toEqual(["signal: request.signal"]);
    expect([...src.matchAll(/inFlightRequest\??\.abort\(\)/g)].length, "something but a mint aborts the refresh")
      .toBe(1);
    expect([...src.matchAll(/\brequest\.abort\(\)/g)].length, "something but the deadline aborts the refresh")
      .toBe(1);
    expect(src, "the deadline's abort is not the renewal's own deadline")
      .toMatch(/setTimeout\(\(\) => \{ timedOut = true; request\.abort\(\); \}, RENEWAL_DEADLINE_MS\)/);
    // …and the sign-in lock's deadline is on the WAIT and nowhere else.
    const lock = src.slice(src.indexOf("export async function withSessionCookieLock"));
    expect(lock.slice(0, lock.indexOf("\n}")), "the lock stopped bounding how long a ceremony queues")
      .toMatch(/signal: ctl\.signal/);
    expect(lock.slice(0, lock.indexOf("\n}")), "the mint no longer drops the late refresh")
      .toMatch(/inFlightRequest\?\.abort\(\)/);
  });

  /**
   * ═══ AND THE SAME PROPERTY, BEHAVIOURALLY ════════════════════════════════════════════════
   *
   * The scan above reads the `fetch` call's own options, and review pointed out what that cannot
   * see: factor the options into a variable declared before `fetch(...)` and the ban passes while
   * a real request timeout is imposed. Every source guard in this lane has now been evaded at
   * least once, always by a spelling nobody had thought of, so the invariant gets a test that
   * does not read the code.
   *
   * A refresh that takes longer than any plausible clamp must still SETTLE — the whole reason the
   * request's deadline sits past the server's own limit is that a cold start must not become a
   * sign-out. Sixty seconds is far past anything a clamp would be set to and far short of what a
   * real cold start can be.
   */
  it("a refresh that takes a minute still lands — no clamp, however it is written", async () => {
    const g = globalThis as unknown as { document?: { cookie: string }; fetch?: typeof globalThis.fetch };
    const hadDoc = Object.prototype.hasOwnProperty.call(g, "document");
    const priorDoc = hadDoc ? g.document : undefined;
    const priorFetch = g.fetch;
    g.document = { cookie: "tf_csrf=abc" };
    vi.useFakeTimers();
    try {
      vi.resetModules();
      let settle: ((r: Response) => void) | null = null;
      g.fetch = vi.fn((_u: unknown, init?: { signal?: AbortSignal }) => new Promise<Response>((resolve, reject) => {
        settle = resolve;
        // An abort MUST NOT be what ends this. If a clamp exists, it rejects here and the
        // assertion below sees the refresh fail rather than land.
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      })) as unknown as typeof globalThis.fetch;

      const { resumeSession } = await import("../app/session-refresh.js");
      const pending = resumeSession();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(settle, "the refresh never issued a request").not.toBeNull();
      settle!(new Response(null, { status: 204 }));
      await expect(pending, "a minute-long refresh was clamped — a cold start becomes a sign-out")
        .resolves.toBe("resumed");
    } finally {
      vi.useRealTimers();
      if (hadDoc) g.document = priorDoc; else Reflect.deleteProperty(g, "document");
      g.fetch = priorFetch;
      vi.resetModules();
    }
  });

  it("the refresh serializes ACROSS tabs through the Web Locks manager when the browser has one", async () => {
    // One jar, many tabs: every tab's refresh presents the SAME `tf_refresh`, and rotation
    // consumes it — so a wake-time herd of tabs is a burst of "reuse" presentations the server
    // then has to talk itself out of (grace window, lost-response recovery — bounds, not
    // guarantees; a presentation was measured 114 ms past the old window and revoked a real
    // family, 2026-08-28). The lock is the client-side fix: one tab rotates, the rest queue,
    // and each queued fetch reads the jar CURRENT after the winner's Set-Cookie landed.
    const g = globalThis as unknown as {
      document?: { cookie: string };
      fetch?: typeof globalThis.fetch;
    };
    const hadDoc = Object.prototype.hasOwnProperty.call(g, "document");
    const priorDoc = hadDoc ? g.document : undefined;
    const priorFetch = g.fetch;
    const grants: Array<{ name: string; mode?: string; settled: boolean }> = [];
    const { vi } = await import("vitest");
    vi.stubGlobal("navigator", {
      locks: {
        request: async (
          name: string, opts: { mode?: string }, cb: () => Promise<boolean>,
        ): Promise<boolean> => {
          const grant = { name, mode: opts?.mode, settled: false };
          grants.push(grant);
          const out = await cb();
          grant.settled = true;   // the callback settled INSIDE the grant, not after it
          return out;
        },
      },
    });
    g.document = { cookie: "" };
    g.fetch = (async () => new Response(null, { status: 204 })) as unknown as typeof globalThis.fetch;
    try {
      expect(await resumeSession()).toBe("resumed");
    } finally {
      vi.unstubAllGlobals();
      if (hadDoc) g.document = priorDoc;
      else delete g.document;
      g.fetch = priorFetch;
    }
    expect(grants).toEqual([{ name: "ohmail:session-refresh", mode: "exclusive", settled: true }]);
  });

  it("a THROWING navigator.locks accessor falls back the same way (round-2 regression pin)", async () => {
    // A second review round: the async rewrite had drifted the property lookup
    // OUTSIDE the try, so a hardened embedder whose `navigator.locks` getter throws rejected
    // `withCrossTabLock` before `fn` ever ran — the exact poisoned-`inFlight` shape the
    // round-1 fix closed for rejected requests. Both lookup and request live inside the
    // guard now, and this pin keeps them there.
    const g = globalThis as unknown as {
      document?: { cookie: string };
      fetch?: typeof globalThis.fetch;
    };
    const hadDoc = Object.prototype.hasOwnProperty.call(g, "document");
    const priorDoc = hadDoc ? g.document : undefined;
    const priorFetch = g.fetch;
    let fetches = 0;
    const { vi } = await import("vitest");
    vi.stubGlobal("navigator", Object.defineProperty({}, "locks", {
      get() { throw new DOMException("no", "SecurityError"); },
    }));
    g.document = { cookie: "" };
    g.fetch = (async () => {
      fetches += 1;
      return new Response(null, { status: 204 });
    }) as unknown as typeof globalThis.fetch;
    try {
      await expect(resumeSession()).resolves.toBe("resumed");
      await expect(resumeSession()).resolves.toBe("resumed");
      expect(fetches, "both calls really fetched — nothing cached a rejection").toBe(2);
    } finally {
      vi.unstubAllGlobals();
      if (hadDoc) g.document = priorDoc;
      else delete g.document;
      g.fetch = priorFetch;
    }
  });

  it("a lock manager that REJECTS falls back to one lock-less refresh and poisons nothing", async () => {
    // A second review's finding: `locks.request()` can reject asynchronously (document
    // no longer fully active, opaque origin) — a shape a synchronous try/catch never sees.
    // The first cut cached that rejection in `inFlight` for the tab's whole life: every later
    // refresh failed instantly with no fetch, and `resumeSession` broke its never-rejects
    // contract. A rejection before the grant means the callback never ran, so the fallback is
    // the single run it was owed — and the next call must fetch again.
    const g = globalThis as unknown as {
      document?: { cookie: string };
      fetch?: typeof globalThis.fetch;
    };
    const hadDoc = Object.prototype.hasOwnProperty.call(g, "document");
    const priorDoc = hadDoc ? g.document : undefined;
    const priorFetch = g.fetch;
    let fetches = 0;
    const { vi } = await import("vitest");
    vi.stubGlobal("navigator", {
      locks: { request: () => Promise.reject(new DOMException("no", "InvalidStateError")) },
    });
    g.document = { cookie: "" };
    g.fetch = (async () => {
      fetches += 1;
      return new Response(null, { status: 204 });
    }) as unknown as typeof globalThis.fetch;
    try {
      await expect(resumeSession()).resolves.toBe("resumed");   // resolves — never rejects
      expect(fetches, "the owed lock-less run happened").toBe(1);
      await expect(resumeSession()).resolves.toBe("resumed");   // not poisoned: a real second fetch
      expect(fetches).toBe(2);
    } finally {
      vi.unstubAllGlobals();
      if (hadDoc) g.document = priorDoc;
      else delete g.document;
      g.fetch = priorFetch;
    }
  });

  it("an ENROLLMENT session is never routed to resume", async () => {
    // Refreshing it would not make it full; mid-onboarding belongs on /join.
    const enrol = async (): Promise<Response> =>
      new Response(JSON.stringify({ scope: "enrollment", user: { userId: "u" } }), { status: 200 });
    expect(await resolveSurface({
      sessionToken: "a".repeat(43), resumeMarker: true, search: "", apiOrigin: ARMED,
      fetchImpl: enrol as unknown as typeof fetch,
    })).toBe("marketing");
  });
});

describe("the refresh client", () => {
  it("posts the BARE path — `/api/auth/refresh` would not carry the cookie", () => {
    // `tf_refresh` is `Path=/auth/refresh`, and a browser sends a path-scoped cookie to that
    // exact path only. Prefixing it with `/api` silently drops the credential and the refresh
    // fails looking exactly like an expired session. Derived from the config constant so the
    // two cannot drift.
    expect(REFRESH_ENDPOINT).toBe(REFRESH_PATH);
    expect(REFRESH_ENDPOINT.startsWith("/api")).toBe(false);
    expect(read("../app/session-refresh.ts")).toMatch(/fetch\(REFRESH_ENDPOINT/);
  });

  /**
   * THE SPLASH'S OWN REFRESH IS COOKIE-AUTHENTICATED, so it must double-submit.
   *
   * `POST /auth/refresh` is `options: { public: true }`, and this module used to read that as
   * "CSRF-exempt". It is not: `withCsrf` keys off `deps.session?.via === "cookie"`, and `public`
   * only stops `withSession` from 401-ing — it still populates a session when a cookie is
   * present. So a refresh sent with a LIVE `tf_session` and no `X-CSRF-Token` is 403
   * `csrf_failed`.
   *
   * The case where that bites is precisely the one the splash exists for. A `SameSite=Strict`
   * cross-site top-level navigation withholds `tf_session` from that navigation while leaving it
   * alive in the jar, so the gate routes to the splash and the splash's SAME-ORIGIN fetch then
   * attaches the cookie the navigation withheld. Seen on the hosted service: it killed the first real
   * Microsoft mailbox connect, because Microsoft's return from consent is that navigation — the
   * refresh 403'd, the splash gave up to `/login`, and the `?oauth=pending&state=…&code=…` query
   * the ceremony was carried in went with it.
   */
  it("the resume refresh DOUBLE-SUBMITS `tf_csrf` — `public` is not CSRF-exempt", async () => {
    const sent = await captureRefreshHeaders("tf_owner=abc; tf_csrf=THE-TOKEN; tf_other=z");
    expect(sent?.["X-CSRF-Token"]).toBe("THE-TOKEN");
  });

  it("…and sends no such header when there is no cookie to echo", async () => {
    // The genuinely session-less case — an idle tab that lost both cookies. The guard does not
    // run, there is nothing to double-submit, and inventing a value would only ever be refused.
    const sent = await captureRefreshHeaders("tf_owner=abc");
    expect(sent).not.toBeNull();
    expect(sent && "X-CSRF-Token" in sent).toBe(false);
  });

  /**
   * THE ANSWER OUTLIVES THE PAGE. The server spends the presented token when it claims it, so an answer
   * that dies with its page — the tab closed, a link followed out — leaves the jar holding a spent token,
   * and its next presentation past the grace window is swept as reuse. `keepalive` lets the browser
   * finish the request and store the rotated cookies after the page is gone.
   */
  it("the refresh is sent keepalive, so the rotated cookies land after the page is gone", async () => {
    const { init } = await captureRefresh("tf_owner=abc; tf_csrf=THE-TOKEN");
    expect(init?.keepalive).toBe(true);
  });

  it("403 `csrf_failed` is recoverable, not just 401 — half the bug lived there", () => {
    // `tf_csrf` is issued with the access cookie's Max-Age, so an idle tab loses BOTH. Its
    // next MUTATION therefore arrives with no double-submit token and is refused 403, never
    // 401. A retry policy watching only 401 would fix reads and leave every write broken.
    expect(isRecoverable(401)).toBe(true);
    expect(isRecoverable(403, "csrf_failed")).toBe(true);
    // …and nothing else is. A 403 that is not a CSRF failure is a real refusal.
    expect(isRecoverable(403, "step_up_required")).toBe(false);
    expect(isRecoverable(403, "email_unverified")).toBe(false);
    expect(isRecoverable(409, "mailbox_exists")).toBe(false);
    expect(isRecoverable(500)).toBe(false);
  });

  it("the auth ceremony NEVER refreshes — its 401s are answers, not accidents", () => {
    // A wrong password must say so. Refreshing on it would also re-present a single-use login
    // token, and refreshing on `/auth/refresh` itself would recurse.
    for (const p of ["/auth/login", "/auth/register", "/auth/refresh", "/auth/verify-email",
                     "/auth/2fa/totp/verify", "/auth/2fa/webauthn/assert/verify"]) {
      expect(mayRefreshFor(p), p).toBe(false);
    }
    for (const p of ["/mailboxes", "/sync", "/billing/subscription", "/account"]) {
      expect(mayRefreshFor(p), p).toBe(true);
    }
  });

  it("concurrent callers share ONE refresh — a second rotation would revoke the family", () => {
    // Reuse detection is deliberately harsh: presenting a consumed refresh token revokes the
    // whole family. So four parallel 401s must produce one refresh, not four — four would
    // rotate once and then sign the user out with its own retries.
    const src = read("../app/session-refresh.ts");
    // One in-flight promise, whatever it answers (`ResumeAnswer`, three states since the renewal
    // fault answers offline — WEB-PRESS-REFUSED-ON-A-RENEWAL-FAULT-WHERE-THE-DESKTOP-KEEPS-IT).
    expect(src).toMatch(/let inFlight: Promise<ResumeAnswer> \| null = null;/);
    expect(src).toMatch(/if \(inFlight\) return inFlight;/);
  });

  it("api-client refreshes once and retries once, never in a loop", () => {
    const src = read("../app/api-client.ts");
    expect(src).toMatch(/if \(!isRecoverable\(err\.status, err\.code\) \|\| !mayRefreshFor\(path\)\) throw err;/);
    // One refresh, and anything but `resumed` ends it: a fault as `session_unchecked`, a refusal as itself,
    // or as the storage-owner refusal when another account signed in while the renewal waited for the lock (whose
    // question is asked inside it). A request a renewal overtook takes the new jar (`sessionMints`, or another
    // tab's past the jar it left on: `staleJar`), never a second one.
    expect(src).toMatch(
      /const resumed = sessionMints\(\) !== mintsAtSend\n\s*\? "resumed" : await resumeSession\(\{ mayProceed: \(\) => whose\(\) === "holds", staleJar: jarAtSend \}\);\n\s*if \(resumed === "unavailable"\) throw sessionUncheckedError\(\);\n\s*if \(resumed !== "resumed"\) throw whose\(\) === "mismatch" \? ownerRefusal\("mismatch"\) : err;/,
    );
    /* The retry calls `attempt`, which does NOT recurse into the refresh wrapper — and the
       property is "the catch never calls `api` again", not the exact spelling of the return.
       This pattern has now been broken twice by ordinary edits: once when the line stopped being
       `return attempt<T>(path, opts);` and was awaited into a variable so the storage-owner check could
       run on the answer, and once when `attempt` grew a third argument for the account header. A
       guard that fails on its subject gaining a parameter is pinning the spelling, so it is
       written open-ended — what must not exist is the RECURSIVE call, and that is asserted
       directly below. */
    expect(src).toMatch(/attempt<T>\(path, opts/);
    // The CATCH only — the declaration above it names `api<T>(path` by definition.
    const after = src.slice(src.indexOf("export async function api<T>"));
    const recovery = after.slice(after.indexOf("} catch (err) {"), after.indexOf("\nfunction ownerMismatch"));
    expect(recovery, "the catch never calls `api` again — that is the loop this pins out")
      .not.toMatch(/\bapi<T>\(/);
    expect(recovery, "the retry no longer goes through `attempt`").toMatch(/attempt<T>\(path, opts/);
  });
});

describe("the marker is a marker, not a credential", () => {
  const cookies = readFileSync(`${HERE}../../../packages/api/src/cookies.ts`, "utf8");

  it("it is Lax — which is the entire point — while the real cookies stay Strict", () => {
    // Lax is what makes a cross-site link work. Safe only because the marker authorises
    // nothing: forging it buys an attacker a refresh attempt that fails.
    expect(cookies).toMatch(/\$\{RESUME_COOKIE\}=1; HttpOnly; SameSite=Lax; Secure; Path=\/; Max-Age=\$\{refreshMax\}/);
    for (const name of ["tf_session", "tf_refresh", "tf_csrf"]) {
      const line = cookies.split("\n").find((l) => l.includes(`${name}=$`) || l.includes(`${name}=\${`));
      expect(line, name).toMatch(/SameSite=Strict/);
    }
  });

  it("it lives as long as the REFRESH token, not the access token", () => {
    // Present for exactly as long as a resume could succeed.
    expect(cookies).toMatch(/RESUME_COOKIE\}=1;[^`]*Max-Age=\$\{refreshMax\}/);
  });

  it("logout and erasure clear it — otherwise the next visit loops through the splash", () => {
    expect(cookies).toMatch(/\$\{RESUME_COOKIE\}=; HttpOnly; SameSite=Lax; Secure; Path=\/; Max-Age=0/);
  });

  it("the webapp's copy of the name matches the API's", () => {
    // Two files, one string; drift would mean the gate looks for a cookie nobody sets.
    expect(RESUME_COOKIE).toBe("tf_resume");
    expect(cookies).toContain('export const RESUME_COOKIE = "tf_resume"');
  });

  it("a REFUSED cookie refresh clears the jar, and a FAULT does not", () => {
    // The invariant is unchanged and now says which failures it means. A dead family must lose
    // `tf_resume` with the rest, or the browser loops through this splash for the marker's whole
    // ninety-day life — that is what the clearing is for. A FAULT is not a dead family: the door
    // used to answer one coded 401 for both, so a database blip destroyed the browser's only copy
    // of a refresh token the server still honours. The decision keys on
    // the thrown value's class, and this pins the line that takes it.
    // `/auth/refresh` lives in the carved lifecycle pair (`session-lifecycle.ts`), not `core.ts`.
    const lifecycle = readFileSync(
      `${HERE}../../../packages/api/src/routes/session-lifecycle.ts`,
      "utf8",
    );
    expect(lifecycle).toMatch(/const failure = classifyRefreshFailure\(err\);/);
    expect(lifecycle).toMatch(/if \(failure === "fault"\) throw err;/);
    expect(lifecycle).toMatch(/failure === "session_refused" \? clearSessionCookies\(\) : \[\],/);
  });
});

describe("the resume route is internal, exactly like /mailbox", () => {
  const mw = read("../middleware.ts");

  it("a direct request is 308'd back to `/`", () => {
    expect(mw).toMatch(/if \(pathname === APP_ROUTE \|\| pathname === RESUME_ROUTE\)/);
  });

  it("it is in the matcher, or middleware never sees it", () => {
    expect(mw).toMatch(/"\/", "\/mailbox", "\/resume"/);
  });

  it("the splash cannot bounce for ever", () => {
    // Guard 2 (guard 1 is the server clearing the jar). Without it, a refresh that neither
    // succeeds nor cleanly fails — a 5xx, an offline tab — loops `/` → resume → `/`.
    const src = read("../app/(product)/resume/ResumeScreen.tsx");
    expect(src).toMatch(/sessionStorage\.getItem\(resumeOnceKey\(\)\)/);
    // A TIMESTAMP, not a boolean. Cleared-on-success cannot see a loop at all (each pass
    // erases the evidence of the last); left-set breaks the honest case of a long-open tab
    // lapsing a second time. The window distinguishes the two.
    //
    // Written through the durable door rather than the jar directly, so a browser that refuses
    // the stamp says so instead of leaving guard 1 as the silent only defence. The value is
    // still what is pinned here: a timestamp beside the answer it follows, never a flag.
    expect(src).toMatch(/durableSessionSet\(resumeOnceKey\(\), JSON\.stringify\(\{ at: Date\.now\(\), answer, reloads \}\)/);
    expect(src).toMatch(/Date\.now\(\) - prev\.at < LOOP_WINDOW_MS/);
    // A loop after a MINT reloads a bounded number of times, then says the server is busy.
    expect(src).toMatch(/prev\.reloads >= GATE_RELOADS/);
    // …and it leaves by REPLACING history, so the splash is never a back-button destination.
    expect(src).toMatch(/window\.location\.replace\(/);
    expect(src).not.toMatch(/location\.href\s*=/);
    expect(src).not.toMatch(/router\.push\(/);
  });

  it("the VIEW survives the resume — the fragment is carried across", () => {
    // `app/shell/routing.ts` routes on the URL fragment (`/#/settings`). A fragment never
    // reaches the server, so this page is the only thing that can carry it. Replacing with a
    // bare `/` silently returns everyone to the Ohbox: reload on Settings, come back an hour
    // later, land somewhere else. That is the difference between "it logged me back in" and
    // "it logged me back in where I was".
    // THE BUG THIS REPLACED, because it shipped and looked correct:
    // `location.replace("/" + location.hash)` computes a URL byte-identical to the current
    // one, so the browser treats it as a fragment change and never re-requests the document.
    // Observed on the hosted service — the refresh succeeded, fresh cookies arrived, and the splash
    // sat there for ever with no second `GET /`. The browser is ALREADY at the right URL;
    // only the server's answer needs to change, which is exactly what `reload()` does, and it
    // preserves the fragment by definition.
    const src = read("../app/(product)/resume/ResumeScreen.tsx");
    expect(src).toMatch(/window\.location\.reload\(\)/);
    expect(src).not.toMatch(/location\.replace\(`\/\$\{window\.location\.hash\}`\)/);
    expect(src).not.toMatch(/window\.location\.replace\("\/"\)/);
  });

  it("a resume that CANNOT recover goes to /login, never to the marketing page", () => {
    // This browser was signed in a moment ago. Answering "let me back in" with the product
    // pitch is the same class of wrong as the original lockout.
    const src = read("../app/(product)/resume/ResumeScreen.tsx");
    expect(src).toMatch(/window\.location\.replace\("\/login"\)/);
    // …and no redirect parameter: single origin + fragment routing means there is nothing to
    // pass, and a `next` parameter would be an open-redirect surface for no gain. Matched
    // against CODE, not the prose above it, which names the thing it refuses to build.
    expect(src).not.toMatch(/replace\([^)]*next=/);
    expect(src).not.toMatch(/searchParams\.(get|set)\("next"/);
  });

  it("`/login` sends an ALREADY SIGNED-IN visitor to the app", () => {
    // /login is not gated by middleware, so a visitor with a live session was shown a form and
    // had to sign in again to reach a mailbox they were already signed in to. Because `api()`
    // refreshes on 401, this also silently recovers a lapsed-but-resumable browser.
    const src = read("../app/(product)/login/LoginScreen.tsx");
    // It asks through the SHARED classifier rather than calling `auth.session()` itself. The
    // two screens that answer "is there a session?" gave contradictory answers inside one
    // burst while each held its own `catch` — see `app/(product)/session-outcome.ts`.
    expect(src).toMatch(/await resolveOwnerOutcome\(\{ signal: abort\.signal \}\)/);
    // The signal is not optional here. A confirm still in flight when a password is submitted
    // can send a token refresh whose reply rewrites the whole cookie jar — landing after the
    // new session is minted, it restores the previous account or clears the new one. Ignoring
    // the answer cannot undo a `Set-Cookie`; only aborting the request can.
    expect(src, "the login ladder no longer aborts its in-flight confirm")
      .toMatch(/abort\.abort\(\)/);
    expect(src).not.toMatch(/auth\.session\(/);
    expect(src).toMatch(/outcome\.kind === "owner"/);
    // …or back to the desktop approval this tab kept (`approve/approval-return.ts`), an id and
    // never a URL, then the named continuation (`login/continuation.ts`), then the app as always.
    expect(src).toMatch(/proceed\(`\/\$\{window\.location\.hash\}`, "replace"\)/);
    expect(src).toMatch(/const back = takeApprovalReturn\(\);\s+if \(back !== null\) router\[how\]\(back\);\s+else if \(next !== null\) leaveFor\(next\);\s+else router\[how\]\(fallback\);/);
  });

  it("RESUME_ROUTE is `/resume` and is an OWN_PATH", () => {
    expect(RESUME_ROUTE).toBe("/resume");
    // The enumeration itself, not a text match on the file that used to hold it.
    expect(OWN_PATHS).toContain(RESUME_ROUTE);
  });
});
