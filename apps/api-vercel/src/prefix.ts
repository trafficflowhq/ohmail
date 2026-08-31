import { apiRoutes, bodyCeilingFor, readBodyWithin } from "@trafficflow/api";

/**
 * PATH NORMALIZATION — the one and only place this host rewrites a request URL.
 *
 * The route table in `packages/api` is UNPREFIXED (`/sync`, `/messages/:id/move`), and
 * this host is reachable two ways:
 *
 *   • directly, as `https://api.ohmail.app/messages/x/move` (native/desktop, bearer), and
 *   • through the webapp's same-origin rewrite, which may present `/api/messages/x/move`.
 *
 * `matchRoute` would cope with either on its own — it splits on `/` and would simply not
 * match the `/api`-prefixed form, which is a 404, not a subtle bug. The subtle bug is one
 * layer down: `withIdempotency` hashes `method \n new URL(req.url).pathname \n rawBody`
 * (`packages/api/src/middleware.ts`). Two surfaces that disagree about the path therefore
 * produce two DIFFERENT `request_hash` values for the SAME mutation, and the second one
 * lands on a stored `idempotency_keys` row whose hash does not match — which is a
 * **409 `idempotency_replay`**, i.e. a user retrying a send or a move from a different
 * surface gets told their key was reused for a different request. The retry that was
 * supposed to be safe becomes the one that fails.
 *
 * So the URL is rebuilt ONCE, here, before `app.handle`, and every downstream consumer —
 * router, idempotency hash, service, audit log — sees the identical canonical path.
 *
 * Canonicalization is deliberately TOTAL rather than just prefix-stripping, because every
 * one of these variations reaches the same route through `matchRoute` while hashing
 * differently:
 *   1. collapse runs of slashes (`/api//sync` and `/sync` are the same route),
 *   2. drop ONE leading `/api` prefix (never more — stripping repeatedly would make
 *      `/api/api/x` reach `/x`, inventing a route the client never asked for),
 *   3. drop a trailing slash, except on the root (`/sync/` and `/sync`),
 *   4. canonicalize PERCENT-ENCODING (see {@link normalizeEscapes}).
 * Dot segments (`/api/../sync`) are already resolved by `new URL()` before we see them.
 */

/** The prefix the webapp's `/api/:path*` rewrite may leave on the path. */
export const API_PREFIX = "/api";

/**
 * The door's ceiling for the ONE route that carries attachment bytes inline
 * (`POST /drafts/:id/send`; see `LARGE_BODY_ROUTES`).
 *
 * 4.5 MB, because that is the platform's own request-body cap on this host — writing a larger
 * number here would be a ceiling that never fires, and writing a smaller one would refuse a send
 * the platform was willing to deliver. The bytes themselves are bounded far more tightly one
 * layer in, by `SEND_ATTACHMENT_MAX_TOTAL_BYTES` (3 MiB raw) inside `SendService.reserve`; this
 * is only the door's permission for that one request to be big at all, and every OTHER route on
 * this host is now held to `JSON_BODY_MAX_BYTES` instead.
 */
export const HOSTED_LARGE_BODY_MAX_BYTES = 4_500_000;

/**
 * Thrown for a pathname whose percent-encoding is not decodable. The host answers **400**;
 * it is a distinct type so the handler can tell "the client sent nonsense" apart from an
 * internal fault.
 */
export class MalformedPathError extends Error {
  constructor(readonly pathname: string) {
    super("pathname contains malformed percent-encoding");
    this.name = "MalformedPathError";
  }
}

/** RFC 3986 §2.3 unreserved: these NEVER need escaping, so an escaped one is not canonical. */
const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

/**
 * Canonicalize percent-escapes: DECODE the unreserved ones, UPPERCASE the rest, REJECT
 * anything malformed.
 *
 * Two requests that `matchRoute` resolves to the identical route parameter must produce the
 * identical `request_hash`, or a retry from a differently-encoding client is a spurious 409.
 * And they did not: `matchRoute` runs `decodeURIComponent` on every `:param`, so
 * `/messages/abc/move` and `/messages/%61bc/move` reach the SAME handler with `id="abc"` —
 * while hashing differently, because the hash sees the raw pathname. Any client, SDK or proxy
 * that escapes a little more eagerly than the one that sent the first attempt would find its
 * safe retry rejected as "key reused with a different request".
 *
 * RFC 3986 §6.2.2 defines exactly this normalization, so we apply the standard one:
 *  • `%61` → `a` for every unreserved character (decode);
 *  • `%2f` → `%2F` for everything else — hex case is not meaning, but a RESERVED character
 *    must stay escaped: decoding `%2F` would split a segment and change the route;
 *  • `%ZZ`, `%A`, a trailing `%` → {@link MalformedPathError}. Previously these reached
 *    `matchRoute`, whose `decodeURIComponent` threw `URIError` from ABOVE the error envelope,
 *    so a malformed URL became a logged 500 instead of a 400.
 */
export function normalizeEscapes(pathname: string): string {
  let out = "";
  for (let i = 0; i < pathname.length; i++) {
    const ch = pathname[i]!;
    if (ch !== "%") { out += ch; continue; }
    const hex = pathname.slice(i + 1, i + 3);
    if (!/^[0-9A-Fa-f]{2}$/.test(hex)) throw new MalformedPathError(pathname);
    const byte = Number.parseInt(hex, 16);
    const decoded = String.fromCharCode(byte);
    // Only ASCII unreserved bytes are decoded. A multi-byte UTF-8 sequence stays escaped
    // (uppercased): decoding it here would be lossy across the string/byte boundary, and
    // `matchRoute`'s own `decodeURIComponent` handles it correctly on the param.
    out += byte < 0x80 && UNRESERVED.test(decoded) ? decoded : `%${hex.toUpperCase()}`;
    i += 2;
  }
  // The whole path must be decodable as a unit too — a lone surrogate escape sequence passes
  // the per-byte check above and still fails here. Cheap, and it is the same call `matchRoute`
  // will make on the params.
  try {
    decodeURIComponent(out);
  } catch {
    throw new MalformedPathError(pathname);
  }
  return out;
}

/**
 * The canonical pathname for a request that reached this host. Pure, total on well-formed
 * input, and the single source of truth for what the idempotency hash sees.
 *
 * @throws {MalformedPathError} when the percent-encoding cannot be decoded (→ 400).
 */
export function normalizePathname(pathname: string): string {
  // 0. Percent-escapes first: `%2Fapi/x` must not be mistaken for a prefix, and the prefix
  //    test below compares literal text.
  let p = normalizeEscapes(pathname);

  // 1. Runs of slashes → one. Guarantees the prefix test below sees `/api/...` and not
  //    `//api/...`, and that `/sync` and `//sync` cannot hash differently.
  p = p.replace(/\/{2,}/g, "/");
  if (p === "") p = "/";

  // 2. Exactly ONE leading `/api`. `=== API_PREFIX` covers the bare `/api` (→ root);
  //    the `startsWith(API_PREFIX + "/")` form is what keeps `/apiary` intact.
  if (p === API_PREFIX) {
    p = "/";
  } else if (p.startsWith(`${API_PREFIX}/`)) {
    p = p.slice(API_PREFIX.length);
  }

  // 3. One trailing slash, except the root itself.
  if (p.length > 1 && p.endsWith("/")) p = p.replace(/\/+$/, "");
  return p === "" ? "/" : p;
}

/**
 * Rebuild `req` on its canonical path. The method, headers, query string and body are
 * preserved exactly; only the pathname changes.
 *
 * The body is BUFFERED rather than streamed through. Two reasons, both load-bearing:
 *  • `new Request(url, req)` would hand undici a `ReadableStream` body, which requires
 *    `duplex: "half"` and is easy to get wrong; an `ArrayBuffer` body has no such
 *    contract. Every mutation on this API is JSON (`withRequestGuard` refuses any other
 *    media type), so buffering costs nothing — there is no upload route.
 *  • `withIdempotency` already reads the whole body (`req.clone().text()`) to hash it,
 *    so the bytes are materialised in one place either way.
 *
 * An EMPTY body is dropped rather than forwarded as a zero-length buffer. That is not a
 * micro-optimisation: undici gives a `Request` constructed with an empty body a non-null
 * `body`, and `withRequestGuard` treats "a body is present" as "a JSON `Content-Type` is
 * mandatory". Forwarding `new ArrayBuffer(0)` would therefore make a legitimately
 * body-less `POST /auth/logout` answer **415** on this host while passing every test.
 *
 * ── HOW MUCH IS BUFFERED IS THE ROUTE'S DECISION ─────────────────────────────────────────
 *
 * The buffer used to be unconditional — `await req.arrayBuffer()` for every non-GET, before
 * route matching and before any credential is looked at. The platform's own 4.5 MB request cap
 * is what bounded it, so an anonymous request naming a path this API does not serve still cost
 * a multi-megabyte allocation in a warm instance shared with real traffic. `bodyCeilingFor`
 * decides from the CANONICAL path (already computed above, and free) which route this is and
 * therefore what it may weigh: zero for a path the table does not serve, {@link
 * HOSTED_LARGE_BODY_MAX_BYTES} for the one send route that carries inline attachment bytes,
 * and `JSON_BODY_MAX_BYTES` for everything else. A path with no route reads nothing and reaches
 * `app.handle` body-less, which answers the identical 404/405 — its handler never ran.
 */
export async function normalizeRequest(req: Request): Promise<Request> {
  const url = new URL(req.url);
  url.pathname = normalizePathname(url.pathname);

  const ceiling = bodyCeilingFor(apiRoutes, req.method, url.pathname, HOSTED_LARGE_BODY_MAX_BYTES);
  const body = await readBodyWithin(req, ceiling);

  return new Request(url, {
    method: req.method,
    headers: req.headers,
    ...(body === undefined ? {} : { body }),
  });
}
