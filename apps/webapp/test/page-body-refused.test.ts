import { readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { config, middleware } from "../middleware";

/**
 * NO PAGE ON THIS ORIGIN TAKES A REQUEST BODY. Next 14 decodes a POST to any App Router page
 * as a Server Action before it looks the action up, and the React Server Components
 * denial-of-service advisories live in that decoder. This app has no Server Action, so the
 * middleware refuses a body-carrying method or a `Next-Action` header on a page with a bare
 * 405, and its matcher reaches every page for such a request, the catch-all included.
 * Driven through the real middleware and Next's own matcher compiler; the tree walk is the
 * census, so a page or route handler added later is classified here without an edit.
 */

const APP_DIR = fileURLToPath(new URL("../app", import.meta.url));
const ROUTE_FILES = new Set(["page.tsx", "page.ts", "route.ts", "route.tsx"]);

/** Every URL `app/` answers, as a request path, with the kind of file that answers it. */
function tree(dir = APP_DIR, segments: string[] = []): Array<{ path: string; kind: "page" | "handler" }> {
  const out: Array<{ path: string; kind: "page" | "handler" }> = [];
  for (const name of readdirSync(dir).sort()) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const abs = `${dir}/${name}`;
    if (statSync(abs).isDirectory()) {
      out.push(...tree(abs, /^\(.*\)$/.test(name) ? segments : [...segments, name]));
    } else if (ROUTE_FILES.has(name)) {
      // A catch-all segment is asked with one concrete path it answers.
      const url = `/${segments.map((s) => (/^\[\.\.\..+\]$/.test(s) ? "no-such-page" : s)).join("/")}`;
      out.push({ path: url.replace(/\/+$/, "") || "/", kind: name.startsWith("page") ? "page" : "handler" });
    } else if (name === "manifest.ts" && segments.length === 0) {
      out.push({ path: "/manifest.webmanifest", kind: "handler" });
    }
  }
  return out;
}

const ORIGIN = "https://ohmail.app";
const request = (path: string, init: RequestInit = {}): NextRequest =>
  new NextRequest(new Request(`${ORIGIN}${path}`, init));
const actionPost = (path: string): NextRequest =>
  request(path, {
    method: "POST",
    headers: { "next-action": "0123456789abcdef", "content-type": "multipart/form-data; boundary=x" },
    body: "--x--",
  });

/** A response the middleware let through: `next()` or a rewrite, never its own answer. */
const admitted = (res: Response): boolean =>
  res.headers.get("x-middleware-next") === "1" || res.headers.has("x-middleware-rewrite");

describe("a request body never reaches a page", () => {
  const routes = tree();
  const pages = routes.filter((r) => r.kind === "page").map((r) => r.path);
  const handlers = routes.filter((r) => r.kind === "handler").map((r) => r.path);

  it("the census found the tree: pages, the catch-all and the route handlers", () => {
    expect(pages.length, "the walk found no pages").toBeGreaterThan(10);
    expect(pages).toContain("/no-such-page");
    expect(pages).toContain("/demo");
    // This repository carries the app alone: the waitlist and the Flathub verification route left with the website.
    expect(handlers.sort()).toEqual(["/account/manage", "/manifest.webmanifest", "/version"]);
  });

  it("a POST carrying Next-Action to any page is a bare 405, and its body is never read", async () => {
    for (const path of pages) {
      const res = await middleware(actionPost(path));
      expect(res.status, path).toBe(405);
      expect(res.headers.get("allow"), path).toBe("GET, HEAD");
      expect(admitted(res), path).toBe(false);
    }
    // Built as one NextRequest: wrapping a Request re-pipes its stream, which pulls by itself.
    let pulled = false;
    const body = new ReadableStream({ pull: () => { pulled = true; } }, { highWaterMark: 0 });
    const req = new NextRequest(`${ORIGIN}/login`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, duplex: "half",
    } as ConstructorParameters<typeof NextRequest>[1]);
    expect((await middleware(req)).status).toBe(405);
    await new Promise((r) => setTimeout(r, 20));
    expect(pulled, "the refusal read the request body").toBe(false);
    void req.arrayBuffer().catch(() => undefined); // CONTROL: the probe does see a read
    await new Promise((r) => setTimeout(r, 20));
    expect(pulled, "the probe cannot see a read").toBe(true);
  });

  it("every method but GET and HEAD is refused on a page, and Next-Action is refused on any method", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      expect((await middleware(request("/login", { method }))).status, method).toBe(405);
    }
    expect((await middleware(request("/login", { headers: { "next-action": "x" } }))).status).toBe(405);
  });

  it("a GET page render, a HEAD and an RSC navigation GET are admitted", async () => {
    for (const path of ["/", "/login", "/privacy"]) {
      expect(admitted(await middleware(request(path))), `GET ${path}`).toBe(true);
      expect(admitted(await middleware(request(path, { method: "HEAD" }))), `HEAD ${path}`).toBe(true);
      const rsc = await middleware(request(path, { headers: { rsc: "1", "next-router-state-tree": "%5B%5D" } }));
      expect(admitted(rsc), `RSC ${path}`).toBe(true);
    }
  });

  it("…and only those two paths below `/auth/refresh`: any other is a page request, and 405s", async () => {
    // The exemption is EXACT. A prefix would hand Next's action decoder a body on the catch-all.
    for (const path of ["/auth/refresh/logout/x", "/auth/refresh/x", "/auth/refresh/logoutx", "/auth/refreshx"]) {
      const res = await middleware(request(path, {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      }));
      expect(res.status, path).toBe(405);
      expect(admitted(res), path).toBe(false);
    }
  });

  it("a POST to a route handler, the API, the refresh door or the sign-out door below it is admitted", async () => {
    for (const path of [
      ...handlers, "/.well-known/org.flathub.VerifiedApps.txt", "/api/auth/login", "/auth/refresh", "/auth/refresh/logout",
    ]) {
      const res = await middleware(request(path, {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      }));
      expect(res.status, path).not.toBe(405);
      expect(admitted(res), path).toBe(true);
    }
  });
});

describe("the matcher sends every page's body-carrying request to the middleware", () => {
  type Matcher = { regexp: string; has?: unknown[]; missing?: unknown[] };
  const compile = async () => {
    const info = (await import("next/dist/build/analysis/get-page-static-info.js")) as unknown as {
      getMiddlewareMatchers: (m: unknown, nextConfig: Record<string, unknown>) => Matcher[];
    };
    const route = (await import("next/dist/shared/lib/router/utils/middleware-route-matcher.js")) as unknown as {
      getMiddlewareRouteMatcher: (m: Matcher[]) => (path: string, req: unknown, query: unknown) => boolean;
    };
    const match = route.getMiddlewareRouteMatcher(info.getMiddlewareMatchers(config.matcher, {}));
    return (path: string, headers: Record<string, string> = {}) => match(path, { headers, cookies: {} }, {});
  };

  it("a Next-Action or a body type on any page path runs the middleware — the catch-all and /demo too", async () => {
    const runs = await compile();
    for (const path of [...tree().filter((r) => r.kind === "page").map((r) => r.path), "/wp-login.php"]) {
      expect(runs(path, { "next-action": "x" }), `${path} next-action`).toBe(true);
      expect(runs(path, { "content-type": "multipart/form-data; boundary=x" }), `${path} content-type`).toBe(true);
    }
  });

  it("a plain GET off the literal list costs no edge invocation, and the hot path is never matched", async () => {
    const runs = await compile();
    expect(runs("/no-such-page")).toBe(false);
    expect(runs("/demo")).toBe(false);
    for (const path of [
      "/api", "/api/sync/changes", "/auth/refresh", "/auth/refresh/logout", "/_next/static/chunk.js",
    ]) {
      expect(runs(path, { "content-type": "application/json", "next-action": "x" }), path).toBe(false);
    }
    // …and the exclusion is exact: a path merely BELOW the door is a page request like any other.
    expect(runs("/auth/refresh/logout/x", { "content-type": "application/json" })).toBe(true);
  });

  it("the landing zone's paths run it: the waitlist's POST, and plain GETs of the website's assets", async () => {
    // Armed, the middleware rewrites these to the website deployment with the cookie jar left behind.
    const runs = await compile();
    expect(runs("/api/waitlist", { "content-type": "application/json" })).toBe(true);
    for (const path of ["/site-assets/x", "/landing/x", "/.well-known/org.flathub.VerifiedApps.txt", "/flathub-verification"]) {
      expect(runs(path), path).toBe(true);
    }
    expect(runs("/api/waitlistx", { "content-type": "application/json" }), "the literal is exact").toBe(false);
  });

  it("the path literals come first, so the textual drift guards read every one of them", () => {
    const literals = config.matcher.filter((m): m is string => typeof m === "string");
    const firstObject = config.matcher.findIndex((m) => typeof m !== "string");
    expect(firstObject, "the matcher carries no conditional arm").toBeGreaterThan(0);
    expect(config.matcher.slice(0, firstObject)).toEqual(literals);
  });
});
