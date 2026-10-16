/**
 * ═══ A LOOPBACK STACK WEARING THE SHIPPED SELF-HOST ROUTE SPLIT ════════════════════════════════
 *
 * A self-hosted ohmail is ONE origin with two containers behind it, and the split between them is
 * the whole reason the phone had to learn where a server's mail API is. `deploy/selfhost/proxy/Caddyfile`
 * routes a named set of paths to the API and EVERYTHING ELSE to the Next web app — and `/sync` is
 * not in that set, so `https://<origin>/sync` reaches Next and answers a 404 HTML error page while
 * `https://<origin>/hello`, `/pair/*` and `/auth/*` all answer from the API at the bare path.
 *
 * That asymmetry is what made the previous failure unreadable: pairing SUCCEEDED (every request the
 * ceremony makes is in the API's set) and the mirror then stayed empty for ever.
 *
 * ── WHY THIS EXISTS AT ALL, AND WHAT IT IS NOT ─────────────────────────────────────────────────
 *
 * It is NOT a claim to have run the real compose stack. There is no reachable `ohmail.test` in this
 * environment and no docker socket, so the alternative was to assert the derivation against the
 * only deployment that IS reachable — the hosted service, whose API is at its root and which
 * therefore cannot exercise the prefixed arm at all. A harness that only tests the case that
 * already worked is worth nothing.
 *
 * So this reproduces the ROUTING, in front of the app's own real pairing seam, real bearer manager
 * and real engine — and the route list is READ OFF THE CADDYFILE rather than copied into this
 * file, which is the difference between a reproduction and a guess. Change the `@api` matcher in
 * the shipped deployment and this helper's split changes with it; delete `/hello` from it and the
 * suite goes red for the right reason. The matcher lives in `routes.caddy` now, which both front
 * doors import, so the read follows the door's own `import` rather than naming a file.
 *
 * ── THE ONE THING IT PERFORMS THAT CADDY DOES NOT ──────────────────────────────────────────────
 *
 * Dropping the leading `/api`. Caddy deliberately does no `strip_prefix` — its own comment says
 * why: the API canonicalizes exactly one leading `/api` off itself
 * (`packages/api/src/canonical-path.ts#normalizePathname`, which both hosts call) so that `/api/sync` through a proxy and `/sync` direct hash identically for
 * idempotency. `pairServer` is a wire double that predates the prefix and matches raw paths, so
 * this helper performs the strip the real API performs on itself, in the same shape: exactly one,
 * never more, so `/api/api/x` still 404s.
 */
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The shipped deployment's own front door, read rather than remembered. */
export const SELFHOST_DIR = fileURLToPath(
  new URL("../../../../deploy/selfhost/proxy/", import.meta.url),
);

/**
 * THE FILES THE SHIPPED STACK ACTUALLY SERVES ITS ROUTES FROM.
 *
 * `Caddyfile` owns TLS and the site address; the route table lives in `routes.caddy`, which both
 * front doors `import`. The import names a CONTAINER path (`/etc/caddy/routes.caddy`) and compose
 * mounts this directory there, so the imported basename resolves beside the door. Following the
 * import is the point: naming the second file here would put the split one rename away from being
 * read off nothing, which is what happened when the routes moved out of the Caddyfile.
 *
 * An import this repository does not carry is not a candidate rather than an error — a door may
 * import something compose supplies — and the refusal below names every file that WAS read.
 */
export function caddyRouteFiles(dir: string = SELFHOST_DIR): { path: string; text: string }[] {
  const door = join(dir, "Caddyfile");
  const text = readFileSync(door, "utf8");
  const out = [{ path: door, text }];
  for (const m of text.matchAll(/^[ \t]*import[ \t]+(\S+)[ \t]*$/gm)) {
    const file = join(dir, basename(m[1]!));
    if (file === door) continue;
    try {
      out.push({ path: file, text: readFileSync(file, "utf8") });
    } catch {
      /* not carried here; the refusal names what was read */
    }
  }
  return out;
}

/**
 * THE PATHS THE SELF-HOST PROXY SENDS TO THE API — parsed out of the shipped route table.
 *
 * The matcher line is `@api path <pattern> <pattern> …`. Caddy's `path` matcher is exact unless the
 * pattern ends in `*`, in which case it is a prefix; that is the whole of the semantics used here,
 * and it is all the shipped matcher needs.
 *
 * A parse that found nothing THROWS. An empty list would make every path fall through to the web
 * container, which is a plausible-looking harness in which the pairing itself fails — and a failure
 * of the double reads exactly like a failure of the product, which is the trap this repo has been
 * bitten by before.
 */
export function apiPathsFromCaddyfile(dir: string = SELFHOST_DIR): string[] {
  const files = caddyRouteFiles(dir);
  for (const { path, text } of files) {
    const line = text.split("\n").find((l) => l.trim().startsWith("@api path "));
    if (line === undefined) continue;
    const patterns = line.trim().slice("@api path ".length).trim().split(/\s+/).filter(Boolean);
    if (patterns.length === 0) {
      throw new Error(`the "@api path" matcher in ${path} names no paths`);
    }
    return patterns;
  }
  throw new Error(
    `no "@api path" matcher in ${files.map((f) => f.path).join(" or ")} `
    + "— the split cannot be reproduced",
  );
}

/** Caddy's `path` matcher for one pattern: exact, or a prefix when the pattern ends in `*`. */
export function matchesCaddyPath(pattern: string, pathname: string): boolean {
  if (!pattern.endsWith("*")) return pathname === pattern;
  return pathname.startsWith(pattern.slice(0, -1));
}

/** `/api/sync` → `/sync`; `/sync` → `/sync`; `/api/api/x` → `/api/x`. See the header. */
export function dropOneApiPrefix(pathname: string): string {
  if (pathname === "/api") return "/";
  return pathname.startsWith("/api/") ? pathname.slice("/api".length) : pathname;
}

export interface SplitStack {
  server: Server;
  /**
   * Every path this proxy saw, which container answered it, and whether it carried a credential.
   *
   * `auth` is what lets a census tell the DERIVATION's own bare `/sync` probe — credential-free by
   * construction, because it runs before a token exists — from a DRAIN at the same path, which is
   * the request that used to fetch an HTML 404 for ever. Without it the two are one line in a log
   * and the assertion has to be vague about the exact thing being proved.
   */
  seen: { path: string; to: "api" | "web"; auth: boolean }[];
}

/**
 * Put the self-host split in front of an already-listening API double.
 *
 * `upstream` is the origin `listen(pairServer().server)` answered. Requests the Caddyfile routes to
 * the API are forwarded there with one `/api` dropped; everything else is answered `404 text/html`,
 * which is what a Next app does with a path it has no route for and is the exact response that made
 * the shipped failure unreadable.
 */
export function selfHostSplit(upstream: string): SplitStack {
  const apiPaths = apiPathsFromCaddyfile();
  const seen: SplitStack["seen"] = [];

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const toApi = apiPaths.some((p) => matchesCaddyPath(p, url.pathname));
        seen.push({
          path: url.pathname + url.search,
          to: toApi ? "api" : "web",
          auth: typeof req.headers.authorization === "string",
        });

        if (!toApi) {
          /* THE WEB CONTAINER. A Next app with no route for this path answers an HTML error page,
             and its being HTML is the whole discriminator the phone now reads — a JSON 404 here
             would make this harness kinder than the deployment it stands in for. */
          res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
          res.end("<!DOCTYPE html><html><body><h1>404</h1><p>This page could not be found.</p></body></html>");
          return;
        }

        const forwarded = `${upstream}${dropOneApiPrefix(url.pathname)}${url.search}`;
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) {
          /* Hop-by-hop and framing headers are the proxy's own to compose; forwarding a stale
             `content-length` or `host` upstream is how a proxy double starts failing for reasons
             that have nothing to do with what is being tested. */
          if (["host", "connection", "content-length", "transfer-encoding"].includes(k)) continue;
          if (typeof v === "string") headers[k] = v;
        }
        const body = Buffer.concat(chunks);
        let up: Response;
        try {
          up = await fetch(forwarded, {
            method: req.method,
            headers,
            ...(body.length > 0 ? { body } : {}),
          });
        } catch (err) {
          res.writeHead(502, { "content-type": "text/plain" });
          res.end(`proxy could not reach the api double: ${String(err)}`);
          return;
        }
        const payload = Buffer.from(await up.arrayBuffer());
        const out: Record<string, string> = {};
        up.headers.forEach((v, k) => {
          if (["content-length", "transfer-encoding", "connection"].includes(k)) return;
          out[k] = v;
        });
        res.writeHead(up.status, out);
        res.end(payload);
      })();
    });
  });

  return { server, seen };
}
