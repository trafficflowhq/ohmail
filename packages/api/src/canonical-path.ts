/**
 * THE CANONICAL PATHNAME — the one routine that decides which spelling of a path is which route.
 *
 * RFC 3986 §6.2.2 escape normalization, slash runs collapsed, exactly one leading `/api` dropped,
 * one trailing slash dropped except at the root. No case folding: static route segments are
 * compared byte-for-byte, so folding here would match routes the server would 404.
 *
 * `apps/server` and `apps/api-vercel` each hold a code-identical copy; the relay allowlist reads
 * THIS one, and `relay-allowlist-census.test.ts` pins all three to the same source.
 */

/** The prefix the webapp's same-origin split may leave on the path. */
export const API_PREFIX = "/api";

/** A pathname whose percent-encoding is not decodable — answered as 400. */
export class MalformedPathError extends Error {
  constructor(readonly pathname: string) {
    super("pathname contains malformed percent-encoding");
    this.name = "MalformedPathError";
  }
}

/** RFC 3986 §2.3 unreserved: these never need escaping, so an escaped one is not canonical. */
const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

/**
 * Decode the unreserved escapes, uppercase the rest, reject anything malformed. A reserved
 * character must STAY escaped: decoding `%2F` would split a segment and change the route.
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
