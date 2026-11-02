import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { API_PREFIX } from "../../api-vercel/src/prefix.js";
import { rewritesFor } from "../routes.mjs";

/**
 * THE SAME-ORIGIN TOPOLOGY, asserted instead of reviewed.
 *
 * The third-party-cookie argument behind the cookie change is gone: `ohmail.app` and
 * `api.ohmail.app` share a registrable domain and are same-SITE. What keeps the topology
 * load-bearing is that the cookie is HOST-ONLY — no `Domain=` — so a browser calling
 * `api.ohmail.app` directly carries no credential at all, and this rewrite is the only
 * path a session has to the API. Keeping the cookie that narrow is the whole reason
 * collapsed the product onto one origin instead of widening it to `.ohmail.app`.
 *
 * The answer still lives in three places that cannot be checked by a compiler:
 *
 *   1. `next.config.mjs` — the rewrite, and the `NEXT_PUBLIC_API_BASE` derived from it;
 *   2. `packages/api/src/cookies.ts` — `SameSite=Strict`, `Secure`, `HttpOnly`, and no
 *      `Domain=`. The ruling says ZERO changes there, and it is exactly the file someone
 *      debugging a cross-origin 401 would "fix" first;
 *   3. `packages/client-engine/src/adapters/http-adapter.ts` — no `credentials:"include"`.
 *      Needing it would mean the requests are cross-origin, i.e. the topology is wrong.
 *
 * (2) and (3) are asserted here rather than in their own packages because neither package
 * knows why it must not change — the reason is this app's deployment shape.
 */
const HERE = fileURLToPath(new URL(".", import.meta.url));
const read = (p: string): string => readFileSync(`${HERE}${p}`, "utf8");

/** A rewrite's destination by SOURCE — never by position, which is what went stale. */
const destinationOf = (rewrites: Array<{ source: string; destination: string }>, source: string):
  string | undefined => rewrites.find((r) => r.source === source)?.destination;

interface Rewrite { source: string; destination: string }
interface WebappConfig {
  env?: Record<string, string>;
  rewrites?: () => Promise<Rewrite[]>;
}

/**
 * Load `next.config.mjs` with a given `TF_API_ORIGIN`.
 *
 * The module reads the variable at import time (Next evaluates the config once per build),
 * so the module registry has to be dropped between cases — `vi.resetModules()` is what makes
 * "the config is dormant when unset" a real observation instead of a cached one.
 */
async function loadConfig(
  origin: string | undefined,
  extra: Record<string, string | undefined> = {},
): Promise<WebappConfig> {
  // GITHUB star count pinned so evaluating the config never reaches the network — the
  // default export fetches it at build time otherwise (an env-provided value wins, by
  // design; see the export's note). The fetch itself is covered by landing-story.test.ts.
  const vars = { TF_API_ORIGIN: origin, NEXT_PUBLIC_GITHUB_STARS: "1", ...extra };
  const previous = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  try {
    // Next accepts a config OBJECT or an async FUNCTION returning one; this config became
    // the function form when the star count landed, so evaluate it the way Next does.
    const mod = (await import("../next.config.mjs")).default as
      | WebappConfig
      | (() => Promise<WebappConfig>);
    return typeof mod === "function" ? await mod() : mod;
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

afterEach(() => { vi.resetModules(); });

describe("apiOrigin — a typo fails the BUILD, never the deployed app", () => {
  it("unset / blank is 'not armed yet', not an error", async () => {
    const { apiOrigin } = await import("../next.config.mjs");
    expect(apiOrigin(undefined)).toBeNull();
    expect(apiOrigin("")).toBeNull();
    expect(apiOrigin("   ")).toBeNull();
  });

  it("normalizes to a bare origin", async () => {
    const { apiOrigin } = await import("../next.config.mjs");
    expect(apiOrigin("https://api.ohmail.app")).toBe("https://api.ohmail.app");
    expect(apiOrigin("https://api.ohmail.app/")).toBe("https://api.ohmail.app");
    expect(apiOrigin(" http://localhost:3002 ")).toBe("http://localhost:3002");
  });

  it("refuses anything that would concatenate into a path no route matches", async () => {
    const { apiOrigin } = await import("../next.config.mjs");
    // `https://api.ohmail.app/v1` + `/:path*` = `/v1/sync`, which 404s AND hashes differently
    // from the direct host — the prefix contract, broken by a config value.
    expect(() => apiOrigin("https://api.ohmail.app/v1")).toThrow(/ORIGIN only/);
    expect(() => apiOrigin("https://api.ohmail.app/?x=1")).toThrow(/ORIGIN only/);
    expect(() => apiOrigin("https://api.ohmail.app/#f")).toThrow(/ORIGIN only/);
    expect(() => apiOrigin("api.ohmail.app")).toThrow(/absolute origin/);
    expect(() => apiOrigin("ftp://api.ohmail.app")).toThrow(/http/);
  });

  /**
   * A rewrite is INVISIBLE to the browser, so the destination receives real `ohmail.app`
   * session cookies, the `X-CSRF-Token` and every mutation body — and whatever it answers
   * with, including `Set-Cookie: …; Domain=ohmail.app`, lands as though `ohmail.app` had
   * written it. "Any http(s) origin without a path" validates nothing that matters: one
   * wrong environment variable is a full session compromise, with no code change and no
   * review. So the target is a COMPILED allow-list that `TF_API_ORIGIN` selects from.
   */
  it("accepts ONLY the compiled API origin — an arbitrary target fails the build", async () => {
    const { apiOrigin, ALLOWED_API_ORIGINS } = await import("../next.config.mjs");
    expect(ALLOWED_API_ORIGINS).toEqual(["https://api.ohmail.app"]);
    expect(apiOrigin("https://api.ohmail.app")).toBe("https://api.ohmail.app");

    const bad = [
      "https://evil.example",
      "https://api.ohmail.app.evil.example",     // suffix games
      "https://ohmail-api.vercel" + ".app",           // the bearer-only host is not a rewrite target
      "https://ohmail.app",                      // proxying to ourselves is an infinite loop
      "https://api.ohmail.app:8443",             // an unexpected port is a different endpoint
    ];
    // The fixture checks itself first — a rename sweep cannot tell a must-refuse host from
    // a must-accept one, and during the `mailoh → ohmail` rename an intermediate tree had
    // the allowed origin in this list. See the same guard in
    // the waitlist's own origin test.
    for (const b of bad) expect(ALLOWED_API_ORIGINS, b).not.toContain(b);
    for (const b of bad) expect(() => apiOrigin(b), b).toThrow(/must be one of/);
  });

  it("refuses plaintext off loopback, and refuses embedded credentials anywhere", async () => {
    const { apiOrigin } = await import("../next.config.mjs");
    // http to a public host would put `tf_session` on the wire in clear between Vercel's
    // edge and the API.
    expect(() => apiOrigin("http://api.ohmail.app")).toThrow(/https/);
    const USER = "u", PASS = "p";
    // A credentialed URL's `new URL(…).origin` is `https://api.ohmail.app`, so the
    // allow-list alone would pass this while the credentials rode along on every request.
    expect(() => apiOrigin(`https://${USER}:${PASS}@api.ohmail.app`)).toThrow(/credentials/);
    expect(() => apiOrigin("http://u:p@localhost:3002")).toThrow(/credentials/);
  });

  it("loopback stays open, because dev and the verification builds run on it", async () => {
    const { apiOrigin } = await import("../next.config.mjs");
    expect(apiOrigin("http://localhost:3002")).toBe("http://localhost:3002");
    expect(apiOrigin("http://127.0.0.1:3012")).toBe("http://127.0.0.1:3012");
    expect(apiOrigin("https://localhost:3002")).toBe("https://localhost:3002");
  });
});

/**
 * `NEXT_PUBLIC_API_BASE` is the SECOND network target, and omitting the `env` key does not
 * remove it: Next inlines any `NEXT_PUBLIC_*` present in the build environment (including
 * from the `.env*` files it loads before this config). "One variable cannot disagree with
 * itself" is therefore only true if a supplied second value is a BUILD FAILURE.
 */
describe("NEXT_PUBLIC_API_BASE cannot be supplied from outside", () => {
  it("set with no TF_API_ORIGIN → build fails (a client fetching /api with no rewrite)", async () => {
    await expect(loadConfig(undefined, { NEXT_PUBLIC_API_BASE: "/api" }))
      .rejects.toThrow(/NEXT_PUBLIC_API_BASE/);
  });

  it("set to an ABSOLUTE origin → build fails (bodies and tf_csrf to a host of their choosing)", async () => {
    await expect(loadConfig("https://api.ohmail.app", { NEXT_PUBLIC_API_BASE: "https://evil.example" }))
      .rejects.toThrow(/NEXT_PUBLIC_API_BASE/);
    await expect(loadConfig(undefined, { NEXT_PUBLIC_API_BASE: "https://evil.example" }))
      .rejects.toThrow(/NEXT_PUBLIC_API_BASE/);
  });

  it("the value this config would have derived anyway is accepted (Next may re-evaluate)", async () => {
    const cfg = await loadConfig("https://api.ohmail.app", { NEXT_PUBLIC_API_BASE: "/api" });
    expect(cfg.env?.NEXT_PUBLIC_API_BASE).toBe("/api");
  });
});

describe("the rewrite is DORMANT until TF_API_ORIGIN is set", () => {
  it("no rewrite and no NEXT_PUBLIC_API_BASE when unset", async () => {
    // This is production TODAY: `api.ohmail.app` has no DNS record yet, and pointing the
    // deployed webapp at a hostname that does not resolve is worse than having no API — the
    // demo gate stays honest only while the API base is absent.
    const cfg = await loadConfig(undefined);
    expect(await cfg.rewrites?.()).toEqual([]);
    expect(cfg.env?.NEXT_PUBLIC_API_BASE).toBeUndefined();
  });

  it("ONE variable arms both halves — they cannot disagree", async () => {
    // Two independent variables could: an app fetching `/api` with no rewrite behind it is a
    // silently dead client, and it would look like an API outage.
    const cfg = await loadConfig("https://api.ohmail.app");
    const rewrites = (await cfg.rewrites?.()) ?? [];
    // The config emits the route table's answer and adds nothing of its own — the assertion
    // that stops a rewrite added to `routes.mjs` from leaving this expectation stale.
    expect(rewrites).toEqual(rewritesFor("https://api.ohmail.app"));
    // …and the pair THIS file is about, by source rather than by position.
    expect(destinationOf(rewrites, "/api/:path*")).toBe("https://api.ohmail.app/:path*");
    expect(destinationOf(rewrites, "/auth/refresh")).toBe("https://api.ohmail.app/auth/refresh");
    expect(cfg.env?.NEXT_PUBLIC_API_BASE).toBe("/api");
  });

  it("the flip is a VARIABLE, not a code change — a loopback target just works", async () => {
    const cfg = await loadConfig("http://localhost:3002");
    const rewrites = (await cfg.rewrites?.()) ?? [];
    expect(rewrites).toEqual(rewritesFor("http://localhost:3002"));
    expect(destinationOf(rewrites, "/api/:path*")).toBe("http://localhost:3002/:path*");
    expect(destinationOf(rewrites, "/auth/refresh")).toBe("http://localhost:3002/auth/refresh");
  });

  /**
   * THE REFRESH COOKIE HAS TO BE REACHABLE, or web sessions die at the access TTL.
   *
   * A jar an earlier release wrote holds the BARE `tf_refresh` at `Path=/auth/refresh` — the
   * API's own path — until its next renewal writes the `__Host-` spelling (`Path=/`, which the
   * prefix requires). Set-Cookie attributes pass through a rewrite unmodified, so the browser
   * stores the bare one on `ohmail.app` at `/auth/refresh` and sends it to exactly one URL.
   * `/api/auth/refresh` is not that URL: routing refresh only through the `/api` prefix leaves
   * that token in the jar forever, unreachable, and the renewal that would replace it never runs.
   */
  it("the refresh rewrite covers the PATH the refresh cookie is scoped to", async () => {
    const { REFRESH_PATH } = await import("../next.config.mjs");
    const src = read("../../../packages/api/src/cookies.ts");
    // Derived FROM cookies.ts — so the two cannot drift apart silently. The bare spelling is
    // written only as its clear now, at the path it was written on.
    const paths = [...src.matchAll(/["`]tf_refresh=[^`"]*?Path=([^;`"]+)/g)].map((m) => m[1]!.trim());
    expect(paths.length).toBeGreaterThanOrEqual(1);
    expect(new Set(paths)).toEqual(new Set([REFRESH_PATH]));
    // …and the `__Host-` spelling is `Path=/`, everywhere it is written.
    const prefixed = [...src.matchAll(/\$\{HOST_PREFIX\}tf_refresh=[^`"]*?Path=([^;`"]+)/g)].map((m) => m[1]!.trim());
    expect(prefixed.length).toBeGreaterThanOrEqual(2);         // sessionCookies + the clears
    expect(new Set(prefixed)).toEqual(new Set(["/"]));

    const cfg = await loadConfig("https://api.ohmail.app");
    const rewrites = (await cfg.rewrites?.()) ?? [];
    const covering = rewrites.find((r) => r.source === REFRESH_PATH);
    expect(covering, `no rewrite serves ${REFRESH_PATH}`).toBeDefined();
    expect(covering!.destination).toBe(`https://api.ohmail.app${REFRESH_PATH}`);

    // …and the `/api` prefix demonstrably does NOT cover it: `Path=/auth/refresh` is not a
    // prefix of `/api/auth/refresh`, which is the whole bug.
    expect(`${API_PREFIX}${REFRESH_PATH}`.startsWith(REFRESH_PATH)).toBe(false);
  });

  /**
   * THE SIGN-OUT DOOR RIDES THE SAME PATH-MATCH, or it signs out nothing: it revokes by the family
   * `tf_refresh` names, and a browser sends that cookie only to paths at or below `REFRESH_PATH`
   * (RFC 6265 §5.1.4). So every bare rewrite to the API sits there, and the door has its own.
   */
  it("every bare rewrite to the API is at or below the refresh cookie's path, the sign-out door included", async () => {
    const { REFRESH_PATH } = await import("../next.config.mjs");
    const { SIGN_OUT_PATH } = await import("../routes.mjs");
    const cfg = await loadConfig("https://api.ohmail.app");
    const rewrites = (await cfg.rewrites?.()) ?? [];
    expect(destinationOf(rewrites, SIGN_OUT_PATH)).toBe(`https://api.ohmail.app${SIGN_OUT_PATH}`);
    const bare = rewrites.filter((r) => r.destination.startsWith("https://api.ohmail.app")
      && !r.source.endsWith("/:path*"));
    expect(bare.map((r) => r.source).sort()).toEqual([REFRESH_PATH, SIGN_OUT_PATH].sort());
    for (const r of bare) {
      expect(r.source === REFRESH_PATH || r.source.startsWith(`${REFRESH_PATH}/`), r.source).toBe(true);
    }
    // …and the `/api` spelling of the door does not path-match the cookie, which is the whole bug.
    expect(`${API_PREFIX}${SIGN_OUT_PATH}`.startsWith(`${REFRESH_PATH}/`)).toBe(false);
  });

  it("the rewrite's prefix is the one apps/api-vercel strips", async () => {
    // If these two ever disagree, every proxied request 404s: the API's `normalizePathname`
    // strips exactly `/api`, and the browser would be asking for something else.
    const { API_BASE } = await import("../next.config.mjs");
    expect(API_BASE).toBe(API_PREFIX);
    const cfg = await loadConfig("https://api.ohmail.app");
    // By shape, not by index: `[0]` was a fourth spelling of the order and read the Flathub
    // rewrite the moment one was added in front of the proxy.
    const wildcards = ((await cfg.rewrites?.()) ?? []).filter((r) => r.source.endsWith("/:path*"));
    expect(wildcards.map((r) => r.source)).toEqual([`${API_PREFIX}/:path*`]);
  });
});

describe("the two cookie files the one-origin rewrite must not loosen", () => {
  it("cookies.ts still sets SameSite=Strict, Secure, HttpOnly — and NO Domain=", () => {
    // `Domain=ohmail.app` would widen the cookie to `admin.` and to every future subdomain
    // — and under one origin that is the ONE change that would look like a simplification
    // (it would make the `/api` rewrite unnecessary) while being the exact thing the merge
    // was done to avoid. `SameSite=None` is the rejected third-party-cookie design. Both
    // are the "obvious fix" for a cross-origin 401, and both are wrong here.
    const src = read("../../../packages/api/src/cookies.ts");
    const setCookies = src.match(/[`"](?:\$\{HOST_PREFIX\})?tf_(?:session|refresh|csrf)=[^`"]*[`"]/g) ?? [];
    expect(setCookies.length).toBeGreaterThanOrEqual(3);
    for (const c of setCookies) {
      expect(c, c).toContain("SameSite=Strict");
      expect(c, c).toContain("Secure");
      expect(c, c).not.toContain("Domain=");
      expect(c, c).not.toContain("SameSite=None");
    }
    // …and the two HttpOnly ones stay HttpOnly (tf_csrf must NOT be — the SPA reads it).
    expect(src).toContain("tf_session=${tokens.accessToken}; HttpOnly");
    expect(src).toContain("tf_refresh=${tokens.refreshToken}; HttpOnly");
  });

  /**
   * THE OWNER MARKER IS THE ONE COOKIE THE CLIENT READS, AND IT MUST STAY THE NARROWEST KIND.
   *
   * It is written through the `OWNER_COOKIE` constant rather than as a literal name, so the
   * regex above — which matches `tf_session` / `tf_refresh` / `tf_csrf` by name — does not see
   * it. A cookie outside the frozen guard is a cookie whose posture drifts, and this one is the
   * likeliest to be widened by somebody with a good reason: it is not HttpOnly, so "why not make
   * it Lax as well, so the marketing page can read it?" is one plausible ticket away, and `Lax`
   * on a value the client trusts to name a local mail mirror is a cross-site request that can
   * plant one.
   *
   * The clear is asserted alongside the set because Max-Age=0 only deletes a cookie whose OTHER
   * attributes match: a `SameSite` that disagrees leaves the original in the jar and the deletion
   * silently does nothing, which is the failure mode the resume marker's comment already records.
   */
  it("the storage-owner marker is host-only, Secure, Strict — and readable, which is why it is scoped", () => {
    const src = read("../../../packages/api/src/cookies.ts");
    const lines = [
      ...[...src.matchAll(/`\$\{HOST_PREFIX\}\$\{OWNER_COOKIE\}=[^`]*`/g)].map((m) => m[0]),
      ...[...src.matchAll(/"tf_owner=[^"]*"/g)].map((m) => m[0]),
    ];
    // Three: the `__Host-` one `ownerCookie` sets, its clear in `clearSessionCookies`, and the
    // bare spelling's clear beside both.
    expect(lines.length, "the account marker is no longer set through OWNER_COOKIE").toBe(3);
    for (const c of lines) {
      expect(c, c).toContain("SameSite=Strict");
      expect(c, c).toContain("Secure");
      expect(c, c).not.toContain("Domain=");
      expect(c, c).not.toContain("SameSite=None");
      expect(c, c).not.toContain("SameSite=Lax");
      // NOT HttpOnly, deliberately and uniquely among the markers: the shell reads this one
      // synchronously on its first render. If it ever becomes HttpOnly the warm open silently
      // stops working and the app falls back to blocking on the session round trip.
      expect(c, c).not.toContain("HttpOnly");
    }
    // It carries an ACCOUNT ID, and every value that reaches the header — including the one the
    // browser hands back on refresh — goes through the id-shaped character check. Without it a
    // value could carry a `;` and become an attribute.
    expect(src).toContain("${OWNER_COOKIE}=${ownerId}");
    expect(src).toMatch(/const ownerId = ownerCookieValue\(owner\)/);
  });

  it("HttpAdapter sends NO credentials:'include' — needing it would mean the topology failed", () => {
    // Same-origin requests carry cookies by default. `credentials:"include"` is the flag you
    // reach for when the request IS cross-origin, so its appearance here would be the signal
    // that the rewrite is gone — and it would also require CORS + `SameSite=None`, i.e. the
    // whole rejected design, arriving one line at a time.
    const src = read("../../../packages/client-engine/src/adapters/http-adapter.ts");
    expect(src).not.toMatch(/credentials\s*:/);
    expect(src).not.toMatch(/mode\s*:\s*["']cors["']/);
  });
});

/**
 * The demo gate's BEHAVIOUR lives in `demo-gate.test.ts` (the decision),
 * `demo-zero-network.test.ts` (the engine is BUILT and no egress primitive is
 * touched) and `proxy.e2e.test.ts` (zero network from the built artifact). What is left
 * here is the one thing none of them can see: that the factory still branches on the mode
 * at all, and that the mode is still re-derived from the real URL on the client.
 *
 * An earlier change moved the factory out of `engine.tsx` into `engine-config.ts` — a plain module with
 * no React in it — precisely so the demo promise could be asserted as behaviour instead of
 * as source text. This grep followed it; `window.location.search` stays in `engine.tsx`,
 * where the URL is.
 */
describe("?demo=1 keeps zero network", () => {
  it("the engine factory still branches on the mode before touching NEXT_PUBLIC_API_BASE", () => {
    const src = read("../app/shell/engine-config.ts");
    // The shape this pins changed, and the property got STRONGER. It used to read
    // `if (!demo && apiBase)` — one condition, with the fixtures adapter as the `else`, and that
    // `else` was the bug: a missing `NEXT_PUBLIC_API_BASE` silently served the demo world to a
    // signed-in account. The factory now checks `demo` FIRST and RETURNS, so the mode is settled
    // before the base is read at all, and the unarmed live path throws (`EngineUnarmedError`).
    //
    // The needle is the BRANCH AND THE RETURN, not the whole call text: a guard pinned to the exact
    // argument list would redden for any option added to a call it does not care about. What it
    // defends is the ordering: `demo` decides and returns, above the line that reads the base.
    expect(src).toMatch(/if \(demo\) return new OhmailEngine\(\{ adapter: new FixturesAdapter\(\)[^\n]*\);/);
    expect(
      src.indexOf("if (demo) return new OhmailEngine("),
      "the demo branch returns ABOVE the line that reads the base",
    ).toBeLessThan(src.indexOf("const apiBase = env.NEXT_PUBLIC_API_BASE;"));
    // `demo` is decided before `apiBase` is even looked at.
    expect(src.indexOf("if (demo) return")).toBeLessThan(src.indexOf("const apiBase = env.NEXT_PUBLIC_API_BASE;"));
    expect(src).toMatch(/return new OhmailEngine\(\{ adapter: new FixturesAdapter\(\)[^\n]*\)/);
    // …and the mode is resolved from the REAL URL on the client, not only from the server's
    // render. A prerendered `/` sees `searchParams = {}`, so a server-only gate silently
    // yields the network engine for every visitor who asked for the demo.
    expect(read("../app/shell/engine.tsx")).toMatch(/window\.location\.search/);
  });
});
