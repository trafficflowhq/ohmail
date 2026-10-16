import { afterEach, describe, expect, it, vi } from "vitest";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import {
  ALLOWED_LANDING_ZONES, ZONE_FORWARDED_HEADERS, armedZone, resolveLandingZone, zoneRequestHeaders, zoneTarget,
} from "../landing-zone.mjs";
import { STATIC_REWRITES, ZONE_ONLY_PATHS, ZONE_PATHS, isZonePath, rewritesFor, zonePathOf } from "../routes.mjs";
import { BASELINE_CSP } from "../app/security-headers.js";

/**
 * THE WEBSITE MOVES TO ITS OWN DEPLOYMENT AND NO COOKIE OF THIS ORIGIN GOES WITH IT. Armed (a
 * listed zone and a bypass), `middleware.ts` rewrites every zone path to the website deployment
 * with the request rebuilt from an allow-list, and the header rules put no policy of ours on those
 * paths. Driven through the real `middleware()` and Next's own path matcher; the real-socket
 * reading is `proxy-zone.e2e.test.ts`, the live one the zone's cookie marker.
 */

const KEYS = [
  "NEXT_PUBLIC_OHMAIL_FLAVOR", "OHMAIL_INTERNAL_API_ORIGIN", "TF_API_ORIGIN", "NEXT_PUBLIC_DEMO",
  "LANDING_ZONE_ORIGIN", "LANDING_ZONE_BYPASS", "NEXT_PUBLIC_GA_MEASUREMENT_ID", "VERCEL_ENV",
  "NEXT_PUBLIC_GITHUB_STARS",
] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  vi.unstubAllGlobals();
});

/** Set the environment the module graph is evaluated in; every key not named is unset. */
function arm(vars: Partial<Record<(typeof KEYS)[number], string>>): void {
  for (const k of KEYS) {
    const v = vars[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
}

const ZONE = "http://127.0.0.1:9";
const LISTED = "https://site.ohmail.app";
/** Shaped like a token the API issues (43 base64url characters), so the gate takes it seriously. */
const TOKEN = "landing-zone-fixture-token-".padEnd(43, "x");
const JAR = `tf_session=${TOKEN}; tf_owner=acc; tf_resume=1`;

it("the fixture token has the shape of a token the API issues", () => {
  expect(TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/);
});

async function run(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  const { middleware } = await import("../middleware.js");
  const { NextRequest } = await import("next/server");
  const request = new NextRequest(new Request(`https://ohmail.app${path}`, {
    method: init.method ?? "GET", headers: init.headers, body: init.body,
  }));
  return (await middleware(request)) as unknown as Response;
}

/** The header names the zone's request is rebuilt from, as Next reads them off the response. */
const overridden = (res: Response): string[] =>
  (res.headers.get("x-middleware-override-headers") ?? "").split(",").filter(Boolean);

describe("the zone resolver: one compiled origin, loopback for the harness, null for the rest", () => {
  it("the listed zone and a loopback origin resolve to themselves", () => {
    expect(ALLOWED_LANDING_ZONES).toEqual(["https://site.ohmail.app"]);
    expect(Object.isFrozen(ALLOWED_LANDING_ZONES)).toBe(true);
    expect(resolveLandingZone(LISTED)).toBe(LISTED);
    expect(resolveLandingZone(`  ${LISTED}/  `)).toBe(LISTED);
    expect(resolveLandingZone(ZONE)).toBe(ZONE);
    expect(resolveLandingZone("http://localhost:3000")).toBe("http://localhost:3000");
    expect(resolveLandingZone("http://[::1]:9")).toBe("http://[::1]:9");
  });

  it("anything else is null and nothing throws — an unlisted host above all", () => {
    const USER = "u", PASS = "p";
    for (const raw of [
      "https://evil.example", `${LISTED}/x`, `${LISTED}?a=1`, `${LISTED}/#f`, `https://${USER}:${PASS}@site.ohmail.app`,
      "http://site.ohmail.app", "https://site.ohmail.app:8443", "https://site.ohmail.app.evil.example",
      "ftp://127.0.0.1", "javascript:alert(1)", "not a url", "", "   ", undefined, null,
    ]) {
      expect(resolveLandingZone(raw), String(raw)).toBeNull();
    }
  });

  it("armed only with a zone AND a bypass", () => {
    expect(armedZone(LISTED, "b")).toBe(LISTED);
    expect(armedZone(LISTED, "")).toBeNull();
    expect(armedZone(null, "b")).toBeNull();
  });
});

describe("the zone's request is an allow-list, never the browser's request minus something", () => {
  const browser = new Headers({
    cookie: JAR, authorization: "Bearer x", "x-csrf-token": "c", "x-nonce": "n", referer: "https://ohmail.app/x",
    origin: "https://ohmail.app", "x-forwarded-for": "203.0.113.9", "x-real-ip": "203.0.113.9",
    accept: "text/html", "accept-language": "de", rsc: "1", "content-type": "application/json",
  });

  it("only the listed headers present, plus the bypass", () => {
    const out = zoneRequestHeaders(browser, "b");
    expect([...out.keys()].sort()).toEqual(["accept", "accept-language", "content-type", "rsc", "x-vercel-protection-bypass"]);
    expect(out.get("x-vercel-protection-bypass")).toBe("b");
  });

  it("CONTROL: every listed header survives, so the list is not over-tight", () => {
    const all = new Headers(ZONE_FORWARDED_HEADERS.map((n) => [n, `v-${n}`] as [string, string]));
    const out = zoneRequestHeaders(all, "b");
    for (const n of ZONE_FORWARDED_HEADERS) expect(out.get(n), n).toBe(`v-${n}`);
  });

  it("an empty request still carries an override list: an empty one replaces nothing", () => {
    expect([...zoneRequestHeaders(new Headers(), "b").keys()]).toEqual(["x-vercel-protection-bypass"]);
  });

  it("a path is never a host: the target stays on the zone", () => {
    expect(zoneTarget(LISTED, "/privacy", "?a=1").href).toBe(`${LISTED}/privacy?a=1`);
    expect(zoneTarget(LISTED, "//evil.example/x", "").origin).toBe(LISTED);
  });

  it("the platform's reserved query parameters are dropped; every other pair keeps its bytes", () => {
    const reviewer = "?x-vercel-set-bypass-cookie=true&x-vercel-protection-bypass=clientvalue&_vercel_share=s&ref=x";
    expect(zoneTarget(LISTED, "/", reviewer).search).toBe("?ref=x");
    expect(zoneTarget(LISTED, "/", "?X-Vercel-Set-Bypass-Cookie=1&_VERCEL_x=1").search).toBe("");
    expect(zoneTarget(LISTED, "/", "?%78-vercel-set-bypass-cookie=true&q=a%20b+c").search).toBe("?q=a%20b+c");
    expect(zoneTarget(LISTED, "/", "?a=1;x-vercel-set-bypass-cookie=true&b=2").search).toBe("?b=2");
    expect(zoneTarget(LISTED, "/", "?x-vercelx=1&_rsc=abc").search).toBe("?x-vercelx=1&_rsc=abc");
  });

  it("a name is read past every leading `?` and blank, raw and decoded; a kept pair is never rewritten", () => {
    expect(zoneTarget(LISTED, "/", "??x-vercel-set-bypass-cookie=true&ref=x").search).toBe("?ref=x");
    expect(zoneTarget(LISTED, "/", "?%3F+%3F_vercel_jwt=1&?%20x-vercel-a=1&ref=x").search).toBe("?ref=x");
    expect(zoneTarget(LISTED, "/", "?+x-vercel-protection-bypass=1&a;??x-vercel-b").search).toBe("");
    expect(zoneTarget(LISTED, "/", "??ref=x").search).toBe("??ref=x");
  });
});

describe("the zone decision is taken on the path the router serves, not only the spelling sent", () => {
  it("decoded and dot-segment spellings of a zone page are zone paths, and say which", () => {
    for (const [spelling, path] of [
      ["/%70rivacy", "/privacy"], ["/%64e", "/de"], ["/./privacy", "/privacy"], ["/%2e/imprint", "/imprint"],
      ["/a/../subprocessors", "/subprocessors"], ["/landing%2Fa.webp", "/landing/a.webp"],
      ["/privacy/", "/privacy"], ["/privacy/.", "/privacy"], ["/privacy/%2e", "/privacy"], ["/privacy/x/..", "/privacy"],
      ["/de/.", "/de"], ["/%70rivacy/.", "/privacy"], ["/imprint/.", "/imprint"], ["/subprocessors/.", "/subprocessors"],
    ]) {
      expect(zonePathOf(spelling!), spelling).toBe(path);
    }
    expect(zonePathOf("/landing/a.webp")).toBe("/landing/a.webp");
  });

  it("product paths stay product paths however they are spelled, and a bad escape decides nothing", () => {
    for (const p of ["/%6cogin", "/login", "/mailbox", "/%2e%2e/mailbox", "/privacyx", "/%E0%A4%A", "/PRIVACY"]) {
      expect(isZonePath(p), p).toBe(false);
    }
  });

  it("armed, the middleware sends an encoded spelling to the zone at its plain path", async () => {
    arm({ LANDING_ZONE_ORIGIN: ZONE, LANDING_ZONE_BYPASS: "b" });
    const res = await run("/%70rivacy?x-vercel-set-bypass-cookie=true&ref=y", { headers: { cookie: JAR } });
    expect(res.headers.get("x-middleware-rewrite")).toBe(`${ZONE}/privacy?ref=y`);
    expect(overridden(res)).not.toContain("cookie");
  });

  it("armed, a trailing dot or parent segment sends the page to the zone, never to the in-app copy", async () => {
    arm({ LANDING_ZONE_ORIGIN: ZONE, LANDING_ZONE_BYPASS: "b" });
    for (const [spelling, path] of [
      ["/privacy/.", "/privacy"], ["/privacy/%2e", "/privacy"], ["/privacy/x/..", "/privacy"], ["/de/.", "/de"],
      ["/imprint/.", "/imprint"], ["/subprocessors/.", "/subprocessors"], ["/%70rivacy/.", "/privacy"],
    ]) {
      const res = await run(spelling!, { headers: { cookie: JAR } });
      expect(res.headers.get("x-middleware-rewrite"), spelling).toBe(`${ZONE}${path}`);
      expect(overridden(res), spelling).not.toContain("cookie");
    }
  });

  it("the matcher runs the middleware for a dot-segment spelling, which no literal matches", async () => {
    const { config } = await import("../middleware.js");
    const info = (await import("next/dist/build/analysis/get-page-static-info.js")) as unknown as {
      getMiddlewareMatchers: (m: unknown, nextConfig: Record<string, unknown>) => Array<{ regexp: string }>;
    };
    const route = (await import("next/dist/shared/lib/router/utils/middleware-route-matcher.js")) as unknown as {
      getMiddlewareRouteMatcher: (m: Array<{ regexp: string }>) => (path: string, req: unknown, query: unknown) => boolean;
    };
    const runs = route.getMiddlewareRouteMatcher(info.getMiddlewareMatchers(config.matcher, {}));
    const at = (path: string) => runs(path, { headers: {}, cookies: {} }, {});
    for (const p of ["/./privacy", "/a/../privacy", "/.", "/privacy", "/privacy/.", "/privacy/x/..", "/de/."]) {
      expect(at(p), p).toBe(true);
    }
    for (const p of ["/no-such-page", "/a.b", "/.well-known/other.txt", "/..x/y"]) expect(at(p), p).toBe(false);
  });
});

describe("armed: every zone path is rewritten to the zone and the jar stays here", () => {
  const exact = ZONE_PATHS.filter((p) => !p.endsWith("/:path*"));
  const samples = [...exact, "/site-assets/_next/static/x.js", "/landing/a.webp"];

  it("an anonymous-looking `/` carrying the whole jar: rewritten, stripped, never cached", async () => {
    arm({ LANDING_ZONE_ORIGIN: ZONE, LANDING_ZONE_BYPASS: "b" });
    const res = await run("/", { headers: { cookie: JAR, authorization: "Bearer x", accept: "text/html" } });
    expect(res.headers.get("x-middleware-rewrite")).toBe(`${ZONE}/`);
    expect(overridden(res)).not.toContain("cookie");
    expect(overridden(res)).not.toContain("authorization");
    expect(overridden(res)).toContain("accept");
    expect(res.headers.get("x-middleware-request-cookie")).toBeNull();
    expect(res.headers.get("x-middleware-request-x-vercel-protection-bypass")).toBe("b");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    for (const [name, value] of res.headers) expect(value, name).not.toContain(TOKEN);
  });

  it("every other zone path, the asset prefixes and the Flathub alias the same way", async () => {
    arm({ LANDING_ZONE_ORIGIN: ZONE, LANDING_ZONE_BYPASS: "b" });
    expect(samples.length).toBe(ZONE_PATHS.length);
    for (const path of samples.filter((p) => p !== "/api/waitlist")) {
      const res = await run(path, { headers: { cookie: JAR, rsc: "1" } });
      expect(res.headers.get("x-middleware-rewrite"), path).toBe(`${ZONE}${path}`);
      expect(overridden(res), path).not.toContain("cookie");
      expect(overridden(res), path).toContain("rsc");
      expect(res.headers.get("x-middleware-request-cookie"), path).toBeNull();
      expect(res.headers.get("x-middleware-request-x-vercel-protection-bypass"), path).toBe("b");
    }
    const query = await run("/privacy?ref=x", { headers: { cookie: JAR } });
    expect(query.headers.get("x-middleware-rewrite")).toBe(`${ZONE}/privacy?ref=x`);
  });

  it("the waitlist POST: method, body type and length forwarded, the jar not", async () => {
    arm({ LANDING_ZONE_ORIGIN: ZONE, LANDING_ZONE_BYPASS: "b" });
    const res = await run("/api/waitlist", {
      method: "POST", body: "{}",
      headers: { cookie: JAR, "content-type": "application/json", "content-length": "2", rsc: "1" },
    });
    expect(res.headers.get("x-middleware-rewrite")).toBe(`${ZONE}/api/waitlist`);
    expect(overridden(res)).toEqual(expect.arrayContaining(["content-type", "rsc", "x-vercel-protection-bypass"]));
    expect(overridden(res)).not.toContain("cookie");
    expect(res.headers.get("x-middleware-request-cookie")).toBeNull();
  });

  it("not a zone path: `/login` is the credential page, the internal route still 308s", async () => {
    arm({ LANDING_ZONE_ORIGIN: ZONE, LANDING_ZONE_BYPASS: "b" });
    const login = await run("/login", { headers: { cookie: JAR } });
    expect(login.headers.get("x-middleware-rewrite")).toBeNull();
    expect(login.headers.get("content-security-policy")).toMatch(/'nonce-/);
    expect((await run("/mailbox")).status).toBe(308);
    for (const path of ["/site-assets", "/landing", "/landingx", "/PRIVACY"]) {
      expect((await run(path)).headers.get("x-middleware-rewrite"), path).toBeNull();
    }
  });
});

describe("unarmed in every other state: the website is served from here, as before", () => {
  const unarmed = async (path: string) => (await run(path, { headers: { cookie: JAR } })).headers;

  it("an empty or blank bypass, no zone, or an unlisted zone: no rewrite anywhere", async () => {
    for (const vars of [
      { LANDING_ZONE_ORIGIN: ZONE },
      { LANDING_ZONE_ORIGIN: ZONE, LANDING_ZONE_BYPASS: "   " },
      { LANDING_ZONE_BYPASS: "b" },
      { LANDING_ZONE_ORIGIN: "https://evil.example", LANDING_ZONE_BYPASS: "b" },
    ]) {
      arm(vars);
      for (const path of ["/", "/privacy", "/landing/a.webp"]) {
        const headers = await unarmed(path);
        expect(headers.get("x-middleware-rewrite"), `${JSON.stringify(vars)} ${path}`).toBeNull();
        expect(headers.get("x-middleware-next"), `${JSON.stringify(vars)} ${path}`).toBe("1");
      }
    }
  });

  it("SELF-HOST + a zone: the sign-in door wins, and no path is rewritten", async () => {
    arm({
      NEXT_PUBLIC_OHMAIL_FLAVOR: "selfhost", OHMAIL_INTERNAL_API_ORIGIN: "http://api:8080",
      LANDING_ZONE_ORIGIN: ZONE, LANDING_ZONE_BYPASS: "b",
    });
    vi.stubGlobal("fetch", (async () => new Response(JSON.stringify({ product: "ohmail", needsSetup: false }), {
      status: 200, headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch);
    const root = await run("/");
    expect(root.status).toBe(307);
    expect(new URL(root.headers.get("location")!).pathname).toBe("/login");
    expect((await run("/privacy")).headers.get("x-middleware-rewrite")).toBeNull();
  });

  it("a signed-in `/` is still the app under a nonce, armed or not", async () => {
    arm({ TF_API_ORIGIN: "https://api.ohmail.app", LANDING_ZONE_ORIGIN: ZONE, LANDING_ZONE_BYPASS: "b" });
    const calls: string[] = [];
    vi.stubGlobal("fetch", (async (url: unknown) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ user: { userId: "u-1" }, scope: "full" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch);
    const res = await run("/", { headers: { cookie: `tf_session=${TOKEN}` } });
    expect(new URL(res.headers.get("x-middleware-rewrite")!).pathname).toBe("/mailbox");
    expect(new URL(res.headers.get("x-middleware-rewrite")!).origin).toBe("https://ohmail.app");
    expect(res.headers.get("content-security-policy")).toMatch(/'nonce-/);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(calls).toEqual(["https://api.ohmail.app/auth/session"]);
  });
});

describe("no rewrite in the config reaches the zone — a config rewrite forwards the jar", () => {
  const origin = "https://api.ohmail.app";

  it("every rewritesFor destination is under the API origin or one of the static local rewrites", () => {
    const local = new Set<string>(STATIC_REWRITES.map((r) => r.destination));
    const rewrites = rewritesFor(origin);
    expect(rewrites.length).toBeGreaterThan(2);
    for (const r of rewrites) {
      expect(r.destination.startsWith(`${origin}/`) || local.has(r.destination), r.source).toBe(true);
      for (const z of ALLOWED_LANDING_ZONES) expect(r.destination.startsWith(z), r.source).toBe(false);
    }
  });

  it("an ARMED config answers exactly rewritesFor(origin)", async () => {
    arm({ TF_API_ORIGIN: origin, LANDING_ZONE_ORIGIN: LISTED, LANDING_ZONE_BYPASS: "b", NEXT_PUBLIC_GITHUB_STARS: "1" });
    const mod = (await import("../next.config.mjs")).default as () => Promise<{ rewrites(): Promise<unknown> }>;
    expect(await (await mod()).rewrites()).toEqual(rewritesFor(origin));
  });
});

describe("assertLandingZone: the build's refusal matrix", () => {
  const load = async () => (await import("../next.config.mjs")).assertLandingZone;
  const managed = { selfhost: false, inAppMarketing: true, gaId: null };

  it("an unlisted or malformed zone refuses, naming the permitted set and never the value", async () => {
    arm({});
    const assertLandingZone = await load();
    for (const raw of ["https://evil.example", "not a url"]) {
      let message = "";
      try { assertLandingZone(raw, resolveLandingZone(raw), {}, managed); } catch (e) { message = (e as Error).message; }
      expect(message, raw).toContain("https://site.ohmail.app");
      expect(message, raw).not.toContain(raw);
    }
  });

  it("a self-host build refuses either zone variable", async () => {
    arm({});
    const assertLandingZone = await load();
    const selfhost = { ...managed, selfhost: true };
    expect(() => assertLandingZone(LISTED, null, {}, selfhost)).toThrow(/selfhost/);
    expect(() => assertLandingZone("", null, { LANDING_ZONE_BYPASS: "b" }, selfhost)).toThrow(/selfhost/);
    expect(() => assertLandingZone("", null, {}, selfhost)).not.toThrow();
  });

  it("a measurement id beside a zone refuses: the website owns its tag", async () => {
    arm({});
    const assertLandingZone = await load();
    expect(() => assertLandingZone(LISTED, LISTED, { LANDING_ZONE_BYPASS: "b" }, { ...managed, gaId: "G-9SPZX4FS1X" }))
      .toThrow(/belongs to the landing project/);
    expect(() => assertLandingZone("", null, {}, { ...managed, gaId: "G-9SPZX4FS1X" })).not.toThrow();
  });

  it("production without the in-app website refuses unless the zone is armed; with it, unarmed is today", async () => {
    arm({});
    const assertLandingZone = await load();
    const prod = { VERCEL_ENV: "production" };
    const tree = { ...managed, inAppMarketing: false };
    expect(() => assertLandingZone("", null, prod, tree)).toThrow(/required for a production build/);
    expect(() => assertLandingZone(LISTED, LISTED, prod, tree)).toThrow(/required for a production build/);
    expect(() => assertLandingZone(LISTED, LISTED, { ...prod, LANDING_ZONE_BYPASS: "b" }, tree)).not.toThrow();
    expect(() => assertLandingZone("", null, prod, managed)).not.toThrow();
    expect(() => assertLandingZone("", null, { VERCEL_ENV: "preview" }, tree)).not.toThrow();
    // A self-host build serves the app at `/` and has no zone to arm, production-shaped env or not.
    expect(() => assertLandingZone("", null, prod, { ...tree, selfhost: true })).not.toThrow();
  });

  it("a loopback zone is refused for production and admitted for tests and previews", async () => {
    arm({});
    const assertLandingZone = await load();
    const env = (vercel?: string) => ({ LANDING_ZONE_BYPASS: "b", ...(vercel ? { VERCEL_ENV: vercel } : {}) });
    expect(() => assertLandingZone(ZONE, ZONE, env("production"), managed)).toThrow(/loopback zone is for development/);
    expect(() => assertLandingZone(LISTED, LISTED, env("production"), managed)).not.toThrow();
    expect(() => assertLandingZone(ZONE, ZONE, env("preview"), managed)).not.toThrow();
    expect(() => assertLandingZone(ZONE, ZONE, env(), managed)).not.toThrow();
  });

  it("the refusals run when the config loads", async () => {
    arm({ LANDING_ZONE_ORIGIN: "https://evil.example", LANDING_ZONE_BYPASS: "b" });
    await expect(import("../next.config.mjs")).rejects.toThrow(/must be one of/);
    arm({ LANDING_ZONE_ORIGIN: LISTED, LANDING_ZONE_BYPASS: "b", NEXT_PUBLIC_GA_MEASUREMENT_ID: "G-9SPZX4FS1X" });
    await expect(import("../next.config.mjs")).rejects.toThrow(/belongs to the landing project/);
  });
});

/** Today's `headerRules(null)`, spelled out: the unarmed rules may not move by a byte. */
const SHARED = [
  "default-src 'self'", "base-uri 'self'", "object-src 'none'", "FRAME", "form-action 'self'",
  "connect-src 'self'", "img-src 'self' data: blob:", "font-src 'self' data:", "style-src 'self' 'unsafe-inline'",
  "frame-src 'self'", "worker-src 'self' blob:", "manifest-src 'self'", "media-src 'self'",
  "upgrade-insecure-requests", "script-src 'self' 'unsafe-inline'",
];
const policy = (frame: string): string => SHARED.join("; ").replace("FRAME", `frame-ancestors ${frame}`);
const UNARMED_RULES = [
  {
    source: "/demo",
    headers: [
      { key: "Content-Security-Policy", value: policy("'self'") },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "SAMEORIGIN" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    ],
  },
  {
    source: "/((?!demo).*)",
    headers: [
      { key: "Content-Security-Policy", value: policy("'none'") },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    ],
  },
];

type Rule = { source: string; headers: Array<{ key: string; value: string }> };
const headersAt = (rules: Rule[], path: string) =>
  rules.filter((r) => getPathMatch(r.source, { strict: true, removeUnnamedParams: true })(path) !== false)
    .flatMap((r) => r.headers);
const csps = (rules: Rule[], path: string) =>
  headersAt(rules, path).filter((h) => h.key === "Content-Security-Policy").map((h) => h.value);

describe("headerRules: unarmed byte for byte, armed with no policy of ours on the zone's paths", () => {
  const rulesOf = async (gaId: string | null, zone: string | null) =>
    (await import("../next.config.mjs")).headerRules(gaId, zone) as Rule[];
  const STATIC = ["X-Content-Type-Options: nosniff", "X-Frame-Options: DENY", "Referrer-Policy: strict-origin-when-cross-origin"];

  it("unarmed equals the fixture", async () => {
    expect(UNARMED_RULES[1]!.headers[0]!.value).toBe(BASELINE_CSP);
    expect(JSON.stringify(await rulesOf(null, null))).toBe(JSON.stringify(UNARMED_RULES));
  });

  it("armed: every zone path carries the three static headers and no policy", async () => {
    const rules = await rulesOf(null, LISTED);
    const paths = [...ZONE_PATHS.filter((p) => !ZONE_ONLY_PATHS.includes(p)), "/.well-known/org.flathub.VerifiedApps.txt",
      "/site-assets/_next/static/chunks/a.js", "/site-assets/x", "/landing/hero-paper.webp", "/landing/a/b.png"];
    for (const p of paths) {
      expect(csps(rules, p), p).toEqual([]);
      expect(headersAt(rules, p).map((h) => `${h.key}: ${h.value}`), p).toEqual(STATIC);
    }
  });

  it("armed: every other path keeps exactly what it has unarmed", async () => {
    const [armed, unarmed] = [await rulesOf(null, LISTED), await rulesOf(null, null)];
    for (const p of [
      "/login", "/mailbox", "/no-such-page", "/demo", "/demo/x", "/de/x", "/privacyx", "/privacy/x", "/landing",
      "/site-assets", "/landingx/a", "/api/waitlistx", "/api/session", "/auth/refresh", "/flathub-verificationx",
      "/.well-known/other.txt", "/_next/static/x.js", "/favicon.ico", "/version",
    ]) {
      expect(headersAt(armed, p), p).toEqual(headersAt(unarmed, p));
      expect(csps(armed, p).length, p).toBeLessThanOrEqual(1);
    }
    expect(csps(armed, "/login")).toEqual([BASELINE_CSP]);
  });

  it("armed: no Google source anywhere, whatever id is passed", async () => {
    expect(JSON.stringify(await rulesOf("G-9SPZX4FS1X", LISTED))).not.toMatch(/google/i);
  });
});
