import type { LookupFunction } from "node:net";

/**
 * The pin, on its own, because one of its callers cannot carry an HTTP client. The pin and the
 * outbound client lived in one module; the mail adapter wants only the pin — it hands the lookup
 * to a socket — and the shared module dragged `node:http`/`node:https` into a program that has
 * neither: a phone's engine has no HTTP client at all. `node:net` is a TYPE-only import here, so
 * this module pulls nothing into a bundle. `pinned-fetch.ts` re-exports it, so every existing
 * importer is unchanged.
 */
/**
 * The pin — the other half of the SSRF gate. `assertPublicHttpUrl`/`assertPublicHost` resolve a
 * caller-supplied name and clear its addresses; that clearance is worthless if the fetch resolves
 * the name AGAIN — a DNS-rebinding server answers the guard with a public IP and the fetch's
 * independent lookup with `169.254.169.254`. {@link pinnedLookup} is a `net`-level lookup that
 * ignores the hostname and hands back the pre-validated addresses; passed as `options.lookup`,
 * the kernel connects to the pinned address while SNI and the `Host` header still carry the real
 * name. `http(s).request` rather than `fetch` because undici offers no supported lookup override
 * — and the stdlib client never follows redirects, so "a 3xx is a refusal" holds by construction.
 */
export function pinnedLookup(pin: readonly string[]): LookupFunction {
  const all = pin.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  // `net` calls this as `(hostname, options, callback)`; older shapes pass the callback as the
  // second argument. Both are handled so a change in Node's call convention cannot silently make
  // the pin return nothing (which would fail the connect — the safe direction — but obscurely).
  return function lookup(_hostname, options, callback): void {
    const cb = (typeof options === "function" ? options : callback) as (
      err: NodeJS.ErrnoException | null,
      address: string | { address: string; family: number }[],
      family?: number,
    ) => void;
    const opts = (typeof options === "function" ? {} : options) as { all?: boolean; family?: number };
    let list = all;
    if (opts.family === 4) list = all.filter((r) => r.family === 4);
    else if (opts.family === 6) list = all.filter((r) => r.family === 6);
    if (list.length === 0) list = all;   // never hand back an empty set for a family we lack
    if (opts.all) cb(null, list);
    else cb(null, list[0]!.address, list[0]!.family);
  } as LookupFunction;
}
