import { readFile, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { Diagnostic } from "./log.js";

/**
 * THE STATIC HALF OF THE HOST DOOR — the built browser client, served to the phone (Phase 3).
 *
 * `tailscale serve` publishes one origin, and the QR sends a phone's BROWSER to it. An API alone
 * would be a tier with zero consumers, so the door serves a real client: the third desktop vite
 * arm (`apps/desktop`, `OHMAIL_HOST_CLIENT=1`) built over the shared webapp shell, handed to this
 * process at spawn as a directory path. This module is that directory on the wire, and nothing
 * more — the API routes are the app's (`engine.ts` gives them precedence by matching the route
 * table BEFORE this handler ever sees a request), and this covers the rest: the shell HTML, the
 * hashed assets, and the `/pair` fragment landing.
 *
 * ── WHAT IS DEFENDED, AND HOW ────────────────────────────────────────────────────────────────
 *
 *  · **Traversal: the resolve-and-prefix check.** The decoded path is resolved UNDER the assets
 *    root and the result must still be inside it — `resolve` collapses every `..` first, so an
 *    escape of any spelling (plain, percent-encoded, mixed) lands outside the prefix and is
 *    refused as `not_found`. Backslashes and control bytes are refused outright before the
 *    resolve: on Windows `\` IS a separator, so a path carrying one must not reach `resolve`
 *    with POSIX assumptions, and no shipped asset name contains either.
 *  · **The CSP on every HTML answer** ({@link HOST_CLIENT_CSP}). `/pair` reads a device-pair
 *    token out of `location.hash` — the flow-3 fragment idiom, chosen so the credential never
 *    reaches a request line or a log — which leaves injected inline script reading the hash as
 *    THE exposure. The flow-1/3 pages mitigate that with a per-request nonce because Next
 *    inlines its own bootstrap; the vite artifact carries NO inline script at all, so this door
 *    states `script-src 'self'` flat — strictly stronger than a nonce (a nonce authorises one
 *    inline block; this authorises none), and constant, so the handler needs no per-request
 *    minting and the header can be pinned byte-for-byte by test. The rest of the policy is the
 *    web client's own product set (`apps/webapp/app/security-headers.ts`), minus
 *    `upgrade-insecure-requests` — TLS is Tailscale's termination, and the door itself serves
 *    plain HTTP on the loopback, where an upgrade directive would break the only transport the
 *    door has.
 *  · **Caching follows the artifact's shape.** Vite emits content-hashed filenames under
 *    `assets/`, so those are immutable for a year; the shell HTML is `no-store`, because an
 *    index cached across a desktop update would reference assets the new dist no longer holds.
 *
 * ── ABSENT ASSETS ARE A DEGRADED DOOR, NEVER A CRASH ─────────────────────────────────────────
 *
 * The path arrives at spawn (`OHMAIL_HOST_ASSETS`, the `OHMAIL_DATA_DIR` idiom) and is probed
 * ONCE, at construction: the packaged dist is immutable for the life of the process, so a
 * per-request stat would buy re-checking a fact that cannot change. Unset, or set to a directory
 * with no readable `index.html`, the door serves its API exactly as before and answers app
 * routes with one plain sentence — a phone that scans a QR against such an install gets an
 * explanation, not a connection reset, and the engine logs `host_assets_missing` with a fixed
 * reason naming the variable and never the value (a path carries the OS account name).
 */

/**
 * The one policy every HTML answer on this door carries. See the header for the whole argument;
 * the two lines that are DECISIONS rather than inheritance:
 *
 *  · `script-src 'self'` — no nonce, no `unsafe-inline`, because the artifact has no inline
 *    script to authorise. The suite pins both the header and the served document's freedom from
 *    inline `<script>`.
 *  · `style-src` keeps `'unsafe-inline'` for the reason the web client's does: React writes
 *    element `style` attributes throughout the shared shell, and CSP counts those as inline
 *    styles. Inline STYLE is not a code-execution primitive the way inline script is.
 */
export const HOST_CLIENT_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "connect-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "frame-src 'self'",
  "worker-src 'none'",
  "manifest-src 'self'",
  "media-src 'self'",
].join("; ");

/** Vite's content-hashed emissions: `assets/<name>-<hash>.<ext>`. Only these are immutable. */
const HASHED_ASSET_RE = /^assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;

/** What the artifact can actually contain, by extension. Anything else is served as bytes. */
const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
  webp: "image/webp",
  woff2: "font/woff2",
  woff: "font/woff",
  txt: "text/plain; charset=utf-8",
  webmanifest: "application/manifest+json",
  map: "application/json",
};

/** The API's own envelope, so a client parses one error shape on both halves of the door. */
function refuse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

/**
 * The API-only landing — what an app route answers when this install packages no client. Plain
 * HTML with not a single script element, under the same policy, so the degraded page can never
 * become the exposure the real one is defended against.
 */
const API_ONLY_PAGE =
  "<!doctype html><html><head><meta charset=\"utf-8\"><title>ohmail</title></head><body>" +
  "<p>This ohmail desktop host is serving its API only — the browser client is not packaged " +
  "with this install. Update the desktop app on the computer that showed the QR code, then " +
  "scan it again.</p></body></html>";

/** Headers for an HTML answer — the credential-page set, identical for `/` and `/pair`. */
function htmlHeaders(): Record<string, string> {
  return {
    "content-type": CONTENT_TYPES.html!,
    "content-security-policy": HOST_CLIENT_CSP,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
}

export interface HostStatic {
  /** Serve one non-API request. Never throws; every refusal is a Response. */
  serve(req: Request, url: URL): Promise<Response>;
}

/**
 * Build the static handler for one resolved assets directory — `null` when the spawn named none.
 *
 * `ready()` (the construction-time probe) is awaited by the composition root so the
 * `host_assets_missing` line lands during boot, where somebody debugging a QR that answers the
 * API-only page will actually look.
 */
export function createHostStatic(opts: { assetsDir: string | null; log?: Diagnostic }): HostStatic & {
  ready(): Promise<void>;
} {
  const log = opts.log ?? (() => undefined);
  /** The prefix every served file must resolve under. `null` until the probe accepts the dir. */
  let root: string | null = null;
  let probed: Promise<void> | null = null;

  const probe = async (): Promise<void> => {
    if (opts.assetsDir === null || opts.assetsDir.trim() === "") {
      // Unset is the ordinary pre-D5 install and every test that drives the door directly —
      // nothing was asked for, so nothing is said.
      return;
    }
    const dir = resolve(opts.assetsDir);
    try {
      const index = await stat(resolve(dir, "index.html"));
      if (!index.isFile()) throw new Error("index.html is not a file");
      root = dir;
    } catch {
      log("host_assets_missing", {
        reason: "OHMAIL_HOST_ASSETS names no readable host-client build (no index.html); the " +
          "host door serves its API only and app routes answer a plain explanation",
      });
    }
  };

  const ready = (): Promise<void> => (probed ??= probe());

  const serve = async (req: Request, url: URL): Promise<Response> => {
    await ready();
    const method = req.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      // A write to a path the route table does not know. 404 (the app's own answer for an
      // unknown path) rather than 405: naming allowed methods for a file would be advertising.
      return refuse(404, "not_found", "no route matches this path");
    }
    const head = method === "HEAD";

    // ── Decode, then refuse what no shipped asset name can contain ─────────────────────────
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return refuse(400, "validation_failed", "the path is not valid percent-encoding");
    }
    // Backslash IS a separator on Windows (where this engine also ships), and NUL/controls are
    // never a filename. Refused before `resolve` sees them, so the prefix check below only ever
    // judges paths whose separator semantics it shares.
    // eslint-disable-next-line no-control-regex
    if (/[\\\u0000-\u001f]/.test(pathname)) {
      return refuse(404, "not_found", "no route matches this path");
    }

    /** An app route is a path with no file extension — `/`, `/pair`, a deep link. */
    const lastSegment = pathname.slice(pathname.lastIndexOf("/") + 1);
    const isAppRoute = !lastSegment.includes(".");

    if (root === null) {
      // Degraded: API-only. App routes get the sentence; asset paths are honestly absent.
      if (isAppRoute) {
        return new Response(head ? null : API_ONLY_PAGE, { status: 200, headers: htmlHeaders() });
      }
      return refuse(404, "not_found", "this install serves no browser client assets");
    }

    /**
     * THE TRAVERSAL DEFENSE. `resolve` collapses `.` and `..` against the root, and the prefix
     * check is what makes the collapse a boundary: a resolved path outside the root — however
     * the request spelled its way there — is refused as if it did not exist, because as far as
     * this door is concerned it does not. Mutation-watched: with this check removed, the
     * suite's `..%2F` vector serves a file from the directory ABOVE the assets root.
     */
    const resolved = resolve(root, "." + (pathname.startsWith("/") ? pathname : `/${pathname}`));
    if (resolved !== root && !resolved.startsWith(root + sep)) {
      return refuse(404, "not_found", "no route matches this path");
    }

    const answer = async (file: string, headers: Record<string, string>): Promise<Response | null> => {
      let bytes: Buffer;
      try {
        bytes = await readFile(file);
      } catch {
        return null;
      }
      return new Response(head ? null : (bytes as unknown as BodyInit), {
        status: 200,
        headers: { ...headers, ...(head ? { "content-length": String(bytes.byteLength) } : {}) },
      });
    };

    // The file itself, when the path names one inside the root.
    if (resolved !== root && !isAppRoute) {
      const relative = resolved.slice(root.length + 1).split(sep).join("/");
      const ext = lastSegment.slice(lastSegment.lastIndexOf(".") + 1).toLowerCase();
      const served = await answer(resolved, {
        "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream",
        "x-content-type-options": "nosniff",
        // Immutable ONLY for vite's content-hashed emissions: their name IS their version.
        // Everything else (the icons, a manifest) revalidates, same rule as the shell HTML.
        "cache-control": HASHED_ASSET_RE.test(relative)
          ? "public, max-age=31536000, immutable"
          : "no-store",
      });
      if (served !== null) return served;
      return refuse(404, "not_found", "no such asset in this build");
    }

    // The index fallback — the SPA's document for `/`, `/pair` and every deep app route.
    const index = await answer(resolve(root, "index.html"), htmlHeaders());
    if (index !== null) return index;
    // The probe accepted the directory and the file has since gone unreadable — degrade, still.
    return new Response(head ? null : API_ONLY_PAGE, { status: 200, headers: htmlHeaders() });
  };

  return { serve, ready };
}
