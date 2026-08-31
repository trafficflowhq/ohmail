import { apiRoutes, bodyCeilingFor, readBodyWithin } from "@trafficflow/api";
import { HOSTED_LARGE_BODY_MAX_BYTES, normalizePathname } from "./prefix.js";

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
