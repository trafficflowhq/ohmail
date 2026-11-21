import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  APP_ROUTE, SESSION_COOKIE, SESSION_ENDPOINT, firstPageUnasked, looksLikeSessionToken, resolveFirstPage, resolveSurface,
} from "../app/session-gate.js";
import { EDGE_PATHS, OWN_ROUTES } from "../routes.mjs";

/**
 * ONE ORIGIN, TWO FRONT DOORS. The decision `https://ohmail.app/` makes.
 *
 * The whole feature is a single function with five ways to be wrong, and every one of
 * them is a user-visible failure rather than an error:
 *
 *   • a stranger shown an app shell they cannot use;
 *   • a signed-in user shown a marketing page;
 *   • an EXPIRED or REVOKED cookie treated as a session — the app shell over 401s, which
 *     is the failure that makes "check the cookie is present" the wrong design;
 *   • an ENROLLMENT-scoped session (the password factor alone) promoted to the
 *     full client, which is the escalation `sessions.scope` exists to prevent;
 *   • `?demo=1` making a network request, which breaks a promise the product prints on
 *     the page (the demo-content and testing-bar invariants).
 *
 * So `resolveSurface` takes its `fetch` as an argument and every case below counts the
 * calls. "Zero network" is asserted by a spy that THROWS if it is ever invoked, not by
 * reading the code and believing it.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const read = (p: string): string => readFileSync(`${HERE}${p}`, "utf8");

const API = "https://api.ohmail.app";
const TOKEN = "tf_access_token_value";

/** A `fetch` that must never be called. Any invocation fails the test by throwing. */
const noNetwork: typeof fetch = (() => {
  throw new Error("network request made where the design promises none");
}) as unknown as typeof fetch;

/** A `fetch` that records its calls and answers with a canned response. */
function stubFetch(reply: () => Promise<Response> | Response): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return reply();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * THE REAL RESPONSE SHAPE, and it is spelled out because guessing it was a live bug.
 *
 * `GET /auth/session` answers `{ user: SessionUser, scope }` and `SessionUser.userId` is
 * the id field — not `id`. The first cut of the gate checked `user.id`, every test here
 * passed (they fed the shape the code expected), and production answered the real one: a
 * valid full session rendered the marketing page, on the deployed origin, silently.
 * `derives the id field from types.ts` below is what makes this fixture accountable to
 * the source of truth instead of to itself.
 */
const fullSession = () =>
  json({ user: { userId: "u-1", accountId: "a-1", email: "gil@x.example" }, scope: "full" });

describe("what `/` serves", () => {
  it("ANONYMOUS: no cookie ⇒ the landing, and not one network request", async () => {
    // The common case by orders of magnitude — every stranger, every crawler, every
    // link unfurl. It has to stay free, or the marketing page acquires an API
    // dependency it has no business having.
    await expect(resolveSurface({
      sessionToken: null, search: "", apiOrigin: API, fetchImpl: noNetwork,
    })).resolves.toBe("marketing");

    // …and an empty/whitespace cookie is "no cookie", not "a cookie worth asking about".
    for (const empty of ["", "   "]) {
      await expect(resolveSurface({
        sessionToken: empty, search: "", apiOrigin: API, fetchImpl: noNetwork,
      })).resolves.toBe("marketing");
    }
  });

  it("VALID SESSION: a live full session ⇒ the app, validated as a BEARER", async () => {
    const { fetchImpl, calls } = stubFetch(fullSession);
    await expect(resolveSurface({
      sessionToken: TOKEN, search: "", apiOrigin: API, fetchImpl,
    })).resolves.toBe("app");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${API}${SESSION_ENDPOINT}`);
    // Bearer, not `Cookie:`. The value is the same string, but a bearer request does not
    // depend on the API host being on TF_COOKIE_HOSTS and carries no Origin — it is the
    // one auth shape that is true on every surface.
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.stringify(calls[0]!.init)).not.toContain("Cookie");
    // A cached answer to "is this token live RIGHT NOW" is not an answer.
    expect(calls[0]!.init!.cache).toBe("no-store");
  });

  it("EXPIRED or REVOKED: a 401 ⇒ the LANDING, never a broken app shell", async () => {
    // THE case that makes a presence check wrong. The cookie is present, well-formed and
    // dead — logged out elsewhere, past its TTL, or killed by refresh-reuse detection.
    for (const status of [401, 403, 404, 500, 502, 503]) {
      const { fetchImpl, calls } = stubFetch(() => json({ error: { code: "unauthorized" } }, status));
      await expect(resolveSurface({
        sessionToken: TOKEN, search: "", apiOrigin: API, fetchImpl,
      }), String(status)).resolves.toBe("marketing");
      expect(calls).toHaveLength(1);
    }
  });

  it("ENROLLMENT SCOPE: a half-onboarded session does NOT get the app", async () => {
    // `POST /auth/register` issues a real `tf_session` on the password factor alone. It
    // authenticates the enrollment surface and nothing else; handing it the mail client
    // would make a password the only thing standing between an attacker and the mailbox,
    // which is the entire point of the scope.
    const { fetchImpl, calls } = stubFetch(() =>
      json({ user: { userId: "u-1", email: "gil@x.example" }, scope: "enrollment" }));
    await expect(resolveSurface({
      sessionToken: TOKEN, search: "", apiOrigin: API, fetchImpl,
    })).resolves.toBe("marketing");
    expect(calls).toHaveLength(1);
  });

  it("an UNRECOGNISED or missing scope also fails toward the landing", async () => {
    // `=== "full"`, not `!== "enrollment"`. A future third scope must not be a silent
    // promotion, and neither must a truncated or reshaped response body.
    const bodies: unknown[] = [
      { user: { userId: "u-1" } },                   // no scope at all
      { user: { userId: "u-1" }, scope: "step_up" }, // a scope this build predates
      { user: { userId: "u-1" }, scope: null },
      { scope: "full" },                             // scope without a user
      { user: null, scope: "full" },
      { user: { userId: 7 }, scope: "full" },        // a user id that is not a string
      { user: { id: "u-1" }, scope: "full" },        // THE live bug, inverted: `id` is not
                                                     // the field, so this is not a session
      "full",                                        // not an object at all
    ];
    for (const body of bodies) {
      const { fetchImpl } = stubFetch(() => json(body));
      await expect(resolveSurface({
        sessionToken: TOKEN, search: "", apiOrigin: API, fetchImpl,
      }), JSON.stringify(body)).resolves.toBe("marketing");
    }
    // A 200 that is not JSON at all.
    const { fetchImpl } = stubFetch(() => new Response("<html>gateway</html>", { status: 200 }));
    await expect(resolveSurface({
      sessionToken: TOKEN, search: "", apiOrigin: API, fetchImpl,
    })).resolves.toBe("marketing");
  });

  it("API UNREACHABLE: a throw or a timeout ⇒ the landing, not an exception", async () => {
    // Timeout, DNS, TLS, an aborted edge invocation. The gate must never throw — a throw
    // in middleware is a 500 on the product's front door, which is worse than either
    // answer it could have given.
    const boom = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    await expect(resolveSurface({
      sessionToken: TOKEN, search: "", apiOrigin: API, fetchImpl: boom,
    })).resolves.toBe("marketing");

    const slow = (async (_u: unknown, init?: RequestInit) => {
      await new Promise((_r, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      return new Response();
    }) as unknown as typeof fetch;
    await expect(resolveSurface({
      sessionToken: TOKEN, search: "", apiOrigin: API, fetchImpl: slow, timeoutMs: 20,
    })).resolves.toBe("marketing");
  });

  it("UNARMED: no TF_API_ORIGIN ⇒ the landing, whatever cookie is presented", async () => {
    // A deployment with no API behind it cannot prove a session, so it must not act as
    // though it had. This is what keeps a pre-flip deployment honest rather than
    // optimistic — and it is the branch that would have to break for "the cookie is
    // present, that will do" to creep back in.
    for (const origin of [null, ""]) {
      await expect(resolveSurface({
        sessionToken: TOKEN, search: "", apiOrigin: origin, fetchImpl: noNetwork,
      })).resolves.toBe("marketing");
    }
  });
});

describe("`?demo=1` is zero-network for BOTH states", () => {
  // The demo's promise is "fixtures only, nothing leaves the tab". It is answered before
  // the cookie is read, so a signed-in visitor gets exactly what a stranger gets — and
  // `noNetwork` throws rather than returning, so a regression is a failure and not a
  // silently different answer.
  const asked = ["?demo=1", "demo=1", "?demo", "?demo=true", "?demo=1&demo=0", "?a=b&demo=yes"];

  it("ANONYMOUS + ?demo=1 ⇒ the demo, zero fetches", async () => {
    for (const search of asked) {
      await expect(resolveSurface({
        sessionToken: null, search, apiOrigin: "https://api.ohmail.app", fetchImpl: noNetwork,
      }), search).resolves.toBe("demo");
    }
  });

  it("SIGNED IN + ?demo=1 ⇒ the demo, zero fetches — the session is never even looked up", async () => {
    for (const search of asked) {
      await expect(resolveSurface({
        sessionToken: TOKEN, search, apiOrigin: "https://api.ohmail.app", fetchImpl: noNetwork,
      }), search).resolves.toBe("demo");
    }
  });

  it("NEXT_PUBLIC_DEMO builds are the demo for everyone, with or without a cookie", async () => {
    for (const sessionToken of [null, TOKEN]) {
      await expect(resolveSurface({
        sessionToken, search: "", apiOrigin: "https://api.ohmail.app",
        env: { NEXT_PUBLIC_DEMO: "1" }, fetchImpl: noNetwork,
      })).resolves.toBe("demo");
    }
  });

  it("a URL that does not ask for the demo does not get it", async () => {
    // The gate may only fail TOWARD the demo; it must not be trivially triggerable, or
    // the live client becomes unreachable by anyone who lands on a crafted link.
    for (const search of ["?demo=0", "?demo=false", "?demonstrate=1", "?nodemo=1", ""]) {
      await expect(resolveSurface({
        sessionToken: null, search, apiOrigin: API, fetchImpl: noNetwork,
      }), search).resolves.toBe("marketing");
    }
  });
});

/**
 * REPAIR (finding 6) — the merge turned the public front door into an amplifier.
 *
 * Before it, `/` was a static marketing page on a separate deployment that touched no
 * backend. After it, ANY request carrying a `tf_session` cookie forces an edge invocation,
 * a cross-host fetch held open for up to SESSION_TIMEOUT_MS, an API invocation and two
 * indexed reads — all spent before anything can reject the cookie, which the attacker
 * supplies. `packages/api/src/routes/index.ts` says plainly that there is no throttle
 * middleware and that a per-IP limit is out of scope for that slice.
 *
 * The shape check below is the free half: a value no `generateToken()` could ever have
 * produced is not worth a network call. It is NOT a rate limit — that is the burst cap in
 * `middleware.ts` — and this file says so rather than overselling it.
 */
describe("a cookie that cannot be a token costs nothing", () => {
  it("the alphabet and a real length come FROM crypto.ts, not from a comment here", () => {
    const crypto = readFileSync(`${HERE}../../../packages/services/src/auth/crypto.ts`, "utf8");
    // `generateToken` is what mints both the access token and the enrollment token that
    // ride in `tf_session` (auth-service.ts). base64url ⇒ [A-Za-z0-9_-], 32 bytes ⇒ 43 chars.
    expect(crypto).toMatch(/export function generateToken\(bytes = 32\): string \{\s*\n\s*return randomBytes\(bytes\)\.toString\("base64url"\);/);
    const live = Buffer.from(new Uint8Array(32)).toString("base64url");
    expect(live).toHaveLength(43);
    expect(looksLikeSessionToken(live)).toBe(true);
  });

  it("REJECTS, without a fetch, everything a token cannot be", async () => {
    for (const junk of [
      "a".repeat(19),                       // far too short
      "a".repeat(257),                      // far too long
      "abc.def.ghi",                        // a JWT-shaped thing — not what this app issues
      "token with spaces here padding!!",
      "%2F%2Fevil%2Ecom%2Fpath%2Fmore%2Fxx",
      "../../../../../../etc/passwd/aaaaaaa",
      "<script>alert(1)</script>aaaaaaaaaa",
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa+/=",
    ]) {
      expect(looksLikeSessionToken(junk), junk.slice(0, 24)).toBe(false);
      // …and the gate proves it never asked the API, by counting.
      await expect(resolveSurface({
        sessionToken: junk, search: "", apiOrigin: API, fetchImpl: noNetwork,
      }), junk.slice(0, 24)).resolves.toBe("marketing");
    }
  });

  it("does NOT reject a token of a different size — a false negative is a signed-in user shown the landing", async () => {
    // The bounds are loose around today's 43 on purpose. If `generateToken` is ever called
    // with 16 or 64 bytes for sessions, this check must not be what breaks sign-in.
    for (const bytes of [16, 24, 32, 48, 64, 96]) {
      const token = Buffer.from(new Uint8Array(bytes).fill(7)).toString("base64url");
      expect(looksLikeSessionToken(token), `${bytes} bytes`).toBe(true);
    }
    const { fetchImpl, calls } = stubFetch(fullSession);
    await expect(resolveSurface({
      sessionToken: Buffer.from(new Uint8Array(64)).toString("base64url"),
      search: "", apiOrigin: API, fetchImpl,
    })).resolves.toBe("app");
    expect(calls).toHaveLength(1);
  });

  it("the burst cap exists, only looks at cookie-bearing requests, and skips the PROBE, not the session", () => {
    const middleware = read("../middleware.ts");
    expect(middleware).toMatch(/const throttled = token !== null && overBurst\(clientKey\(request\), Date\.now\(\)\)/);
    // Tripping it must never be a 429 or a throw — and no longer nulls the token: a null token with
    // the marker is the splash, which spent a rotation for being fast. The gate gets the token and
    // the flag, and serves a token-holder the app without asking the API (`session-gate.ts` 3b).
    expect(middleware).toMatch(/sessionToken: token,\s*throttled,/);
    expect(middleware).not.toMatch(/sessionToken: throttled \? null/);
    expect(middleware).not.toMatch(/429|NextResponse\.json|new Response\(/);
  });
});

describe("the middleware wiring cannot drift from the gate", () => {
  const middleware = read("../middleware.ts");

  const matcherPaths = (): string[] => {
    const matcher = /matcher:\s*\[([^\]{]*)/.exec(middleware)?.[1] ?? "";
    return [...matcher.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  };

  it("the matcher LITERAL matches APP_ROUTE — the guard on the internal route", () => {
    // `next build` reads `config.matcher` out of the SOURCE and does not evaluate it, so
    // the path has to be spelled twice. If the literal ever stops matching APP_ROUTE the
    // rewrite target stops being guarded and becomes a second, session-free public URL
    // for the app — which is exactly the failure nothing else would notice.
    const paths = matcherPaths();
    expect(paths[0]).toBe("/");
    expect(paths).toContain(APP_ROUTE);
  });

  it("the matcher is EVERY html path this deployment answers, and nothing else", () => {
    // Widened in the repair so the canonical-host redirect and the strict script policy
    // cover the whole origin rather than only `/`. Derived from the route table in
    // `routes.mjs` — the enumerated split of the namespace — so a route added there and
    // forgotten here is a page a legacy host could still serve, and it fails HERE.
    // `routes.mjs` rather than the config that re-exports it: the table is pure, so importing
    // it runs none of the build-time validation `next.config.mjs` does at module scope.
    expect(OWN_ROUTES.length, "the route table did not load").toBeGreaterThan(5);

    // A path that leaves the matcher says why in the table (a route handler, a static asset,
    // `/demo`'s own CSP, the catch-all no statically-read matcher could carry). An entry that
    // opts out silently is refused here — which is what stops the exclusion list from being a
    // second enumeration that drifts.
    for (const route of OWN_ROUTES.filter((r) => !r.edge)) {
      expect(route.why, `${route.path} leaves the middleware matcher with no reason given`)
        .toBeTruthy();
    }
    expect(matcherPaths().sort()).toEqual([...EDGE_PATHS].sort());
  });

  it("the paths that must NOT be matched, are not — the proxy stays the hot path", () => {
    // A function in front of `/api/*` or `/auth/refresh` would add an edge invocation to
    // every request the mail client makes, and `next.config.mjs`'s `headers()` already
    // covers them for the policy the matcher was widened for.
    for (const never of ["/api", "/api/:path*", "/auth/refresh", "/_next", "/demo"]) {
      expect(matcherPaths(), never).not.toContain(never);
    }
  });

  it("only `/` runs the session gate — the other matched paths cost no fetch", () => {
    // The widened matcher must not widen the AMPLIFIER. `resolveSurface` is reached only
    // after an explicit `pathname !== "/"` early return.
    expect(middleware).toMatch(/if \(pathname !== "\/"\) \{/);
    expect(middleware.indexOf(`if (pathname !== "/")`)).toBeLessThan(middleware.indexOf("resolveFirstPage("));
  });

  it("a direct request for the internal route is answered with a 308 to `/`", () => {
    expect(middleware).toMatch(/pathname === APP_ROUTE/);
    expect(middleware).toMatch(/NextResponse\.redirect\(home, 308\)/);
  });

  it("it REWRITES rather than redirecting — a redirect is the flash the design forbids", () => {
    expect(middleware).toMatch(/NextResponse\.rewrite\(/);
    // …and the marketing branch is `next()`, i.e. `/` renders in place.
    expect(middleware).toMatch(/NextResponse\.next\(\)/);
  });

  it("a request carrying a session cookie is never stored in a shared cache", () => {
    // `/` is a prerendered marketing page for anonymous traffic and must stay cacheable;
    // the moment a request presents `tf_session` the answer is per-user, and a CDN that
    // reused it would hand one visitor's `/` to the next. Only identified requests are
    // marked, so the anonymous page keeps its prerendered cache headers.
    //
    // THE MARKER COUNTS TOO, and widening this was not optional. A browser holding
    // `tf_resume` and no session cookie is routed to the resume splash — a per-user answer
    // reached with NO `tf_session` present, which is the whole `SameSite=Strict` cross-site
    // case. Keyed on the cookie alone, that response was shared-cacheable.
    expect(middleware).toMatch(/if \(token !== null \|\| marker\) response\.headers\.set\(\s*"Cache-Control", "private, no-store"/);
    // …and `Vary` is deliberately absent: Next overwrites it for its RSC protocol, so
    // setting it would be a claim the runtime does not honour. See the file header.
    expect(middleware).not.toMatch(/headers\.set\(\s*"Vary"/);
    expect(middleware).toContain("SESSION_COOKIE");
  });

  it("the session body's ID FIELD is derived from SessionUser, not guessed", () => {
    // The regression net for the one defect that reached production in this slice. The
    // gate reads `user.userId`; `SessionUser` declares it. A rename on either side has to
    // fail here rather than in a browser.
    const types = readFileSync(`${HERE}../../../packages/services/src/auth/types.ts`, "utf8");
    const decl = /export interface SessionUser \{([^}]*)\}/.exec(types)?.[1] ?? "";
    const first = /^\s*(\w+)\s*:\s*string;/m.exec(decl)?.[1];
    expect(first, "SessionUser's first string field is the id the gate checks").toBe("userId");
    expect(read("../app/session-gate.ts")).toContain("body?.user?.userId");
    expect(read("../app/session-gate.ts")).not.toMatch(/body\?\.user\?\.id\b/);
  });

  it("the cookie name is the one the API actually sets", () => {
    // Derived from the source of truth rather than restated, the way `api-rewrite.test.ts`
    // derives REFRESH_PATH from the `Path=` attribute.
    const cookies = readFileSync(`${HERE}../../../packages/api/src/cookies.ts`, "utf8");
    expect(cookies).toContain(`${SESSION_COOKIE}=\${tokens.accessToken}`);
  });
});

/**
 * THE SIGNED-IN FIRST PAGE THE EDGE DOES NOT ASK ABOUT, behind one setting that is off. With it on, a shape-valid token
 * AND the resume marker are served the app's empty document without a probe; the browser's own check decides what is
 * drawn. Every other jar is answered exactly as without it.
 */
describe("the first page without the probe", () => {
  const on = { firstPageUnasked: true } as const;

  it("a token and the marker: the unasked app, and no request leaves", async () => {
    expect(await resolveSurface({
      sessionToken: TOKEN, resumeMarker: true, search: "", apiOrigin: API, fetchImpl: noNetwork, ...on,
    })).toBe("app-unasked");
  });

  it("a token without the marker is still probed, which keeps an enrollment session out", async () => {
    const { fetchImpl, calls } = stubFetch(() => json({ user: { userId: "u-1" }, scope: "enrollment" }));
    expect(await resolveSurface({ sessionToken: TOKEN, search: "", apiOrigin: API, fetchImpl, ...on })).toBe("marketing");
    expect(calls).toHaveLength(1);
  });

  it("the marker without a token resumes, as before", async () => {
    expect(await resolveSurface({
      sessionToken: null, resumeMarker: true, search: "", apiOrigin: API, fetchImpl: noNetwork, ...on,
    })).toBe("resume");
  });

  it("is never the answer for a token of impossible shape, no API, a pending sign-out or the demo", async () => {
    const base = { sessionToken: TOKEN, resumeMarker: true, search: "", apiOrigin: API, fetchImpl: noNetwork, ...on };
    for (const input of [
      { ...base, sessionToken: "not a token!" },
      { ...base, apiOrigin: null },
      { ...base, signOutPending: true },
      { ...base, search: "demo=1" },
    ]) {
      expect(await resolveSurface(input), JSON.stringify({ ...input, fetchImpl: undefined })).not.toBe("app-unasked");
    }
  });

  it("off, a token and the marker are probed as before", async () => {
    const { fetchImpl, calls } = stubFetch(fullSession);
    expect(await resolveSurface({ sessionToken: TOKEN, resumeMarker: true, search: "", apiOrigin: API, fetchImpl })).toBe("app");
    expect(calls).toHaveLength(1);
  });

  it("the setting is on only when it is exactly 1", () => {
    expect(firstPageUnasked("1")).toBe(true);
    for (const value of [undefined, "", "0", "true", " 1", "01", "1 ", "yes"]) {
      expect(firstPageUnasked(value), String(value)).toBe(false);
    }
  });
});

it("carries a confirmed account only when the full edge probe answers", async () => {
  const request = {
    sessionToken: "x".repeat(43), resumeMarker: true, search: "", apiOrigin: "https://api.example.test",
  };
  const full = async () => Response.json({ scope: "full", user: { userId: "user", accountId: "reader" } });
  expect(await resolveFirstPage({ ...request, fetchImpl: full })).toEqual({ account: "reader" });
  expect(await resolveFirstPage({ ...request, fetchImpl: full, throttled: true })).toBe("app");
  expect(await resolveFirstPage({ ...request, fetchImpl: full, firstPageUnasked: true })).toBe("app-unasked");
  expect(await resolveFirstPage({
    ...request, fetchImpl: async () => { throw new DOMException("Expired", "TimeoutError"); },
  })).toBe("app");
});
