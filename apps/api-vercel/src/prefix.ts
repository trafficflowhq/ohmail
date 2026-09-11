
/**
 * Path normalization — the one place this host rewrites a request URL. The route table in
 * `packages/api` is unprefixed, and this host is reachable directly and through the webapp's
 * same-origin rewrite, which may present `/api/...`. The bug is not the 404:
 * `withIdempotency` hashes `method \n pathname \n rawBody`, so surfaces disagreeing about
 * the path hash the same mutation differently and a safe retry becomes 409
 * `idempotency_replay`. The URL is rebuilt once, before `app.handle`. Canonicalization is
 * total: collapse slash runs; drop one leading `/api` (never more); drop a trailing slash
 * except on the root; canonicalize percent-encoding ({@link normalizeEscapes}).
 */

/** The prefix the webapp's `/api/:path*` rewrite may leave on the path. */
export const API_PREFIX = "/api";

/**
 * The door's ceiling for the one route that carries attachment bytes inline
 * (`POST /drafts/:id/send`; see `LARGE_BODY_ROUTES`). 4.5 MB because that is the platform's
 * own request-body cap on this host: larger never fires, smaller refuses a send the platform
 * would deliver. The bytes are bounded more tightly one layer in by
 * `SEND_ATTACHMENT_MAX_TOTAL_BYTES` (3 MiB raw) inside `SendService.reserve`; every other
 * route is held to `JSON_BODY_MAX_BYTES`.
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
 * Canonicalize percent-escapes: decode the unreserved ones, uppercase the rest, reject
 * anything malformed. Two requests that `matchRoute` resolves to the identical route
 * parameter must produce the identical `request_hash`, or a retry from a
 * differently-encoding client is a spurious 409 — `matchRoute` decodes every `:param`, while
 * the hash sees the raw pathname. RFC 3986 §6.2.2 defines exactly this normalization: `%61`
 * → `a` for unreserved characters; `%2f` → `%2F` for the rest (decoding a reserved character
 * would split a segment and change the route); `%ZZ`, `%A`, a trailing `%` →
 * {@link MalformedPathError}, answered as 400 instead of a logged 500.
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
 * `normalizeRequest` used to live here and now lives in `normalize.ts`, moved for a deploy
 * break: it grew a body door needing `@trafficflow/api`, and the web app's tests import
 * `API_PREFIX` from HERE (so the browser rewrite and the stripped prefix cannot drift) — that
 * import made `@trafficflow/api` part of the web app's program, which does not declare it —
 * its production build failed with "Cannot find module". It passed locally: in a workspace
 * checkout the package resolves through the repository root whether or not the app declares
 * it; only a clean install scoped to one app — the build server — stops the accident.
 * Keeping this module free of workspace imports is what makes it safe to import
 * from another app's tests. Path normalization only.
 */
