import { apiRoutes, bodyCeilingFor, readBodyWithin } from "@trafficflow/api";
import { HOSTED_LARGE_BODY_MAX_BYTES, normalizePathname } from "./prefix.js";

/**
 * Rebuild `req` on its canonical path; method, headers, query and body are preserved. The
 * body is buffered, not streamed: a stream body needs `duplex: "half"`, and
 * `withIdempotency` reads the whole body to hash it anyway. An empty body is dropped, not
 * forwarded as a zero-length buffer — undici gives an empty-body Request a non-null `body`,
 * and `withRequestGuard` treats "body present" as "JSON `Content-Type` mandatory", so a
 * body-less `POST /auth/logout` would answer 415. `bodyCeilingFor` reads the canonical path
 * to decide the buffer ceiling: zero for a path the table does not serve,
 * {@link HOSTED_LARGE_BODY_MAX_BYTES} for the send route, `JSON_BODY_MAX_BYTES` otherwise.
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
