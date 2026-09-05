import type { LookupFunction } from "node:net";

/**
 * THE PIN, ON ITS OWN, BECAUSE ONE OF ITS CALLERS CANNOT CARRY AN HTTP CLIENT.
 *
 * The pin and the outbound HTTP client that uses it lived in one module, which was right while
 * every caller wanted both. The mail adapter wants only the pin — it hands the lookup to a socket,
 * not to a request — and importing it from the same module dragged `node:http` and `node:https`
 * into a program that has neither: a phone's engine has no HTTP client at all, and the import was
 * enough to make the build reach for one. `node:net` is a TYPE-only import here, so this module
 * pulls nothing into a bundle.
 *
 * `pinned-fetch.ts` re-exports it, so every existing importer is unchanged and the pin and the
 * gate still travel together for the reason written there.
 */
/**
 * ── THE PIN, AND WHY IT IS THE OTHER HALF OF THE SSRF GATE ────────────────────────────────────
 *
 * MOVED HERE VERBATIM from `packages/services/src/pinned-fetch.ts`, which now re-exports it, for
 * the reason written out at the top of `ssrf-guard.ts` beside it: `apps/worker` may import
 * `@trafficflow/core` and `@trafficflow/db` and nothing else, and the worker's push-wake sender
 * needs the pin as much as the gate does. A pin without a gate clears nothing, and a gate without
 * a pin is a time-of-check/time-of-use window — so the two travel together or neither is worth
 * having.
 *
 * `assertPublicHttpUrl` / `assertPublicHost` resolve a caller-supplied name and clear its
 * addresses. That clearance is worthless if the fetch then resolves the name AGAIN — a
 * DNS-rebinding server answers the guard's lookup with a public IP and the fetch's independent
 * lookup with `169.254.169.254`. The whole point of returning the validated addresses is to
 * connect the socket to ONE OF THEM and to nothing the name resolves to later.
 *
 * {@link pinnedLookup} is how: a `net`-level lookup function that ignores the hostname entirely
 * and hands back the pre-validated addresses. Passed to `http(s).request` as `options.lookup`, it
 * is what `net.connect` calls in place of `dns.lookup`, so the kernel connects to the pinned
 * address. Everything ELSE about the request is left to derive from the original URL: the TLS
 * `servername` (SNI) defaults to the hostname, and the `Host` header defaults to the hostname —
 * so a name-based virtual host and certificate validation both still see the real name. Only the
 * IP the packets go to is pinned.
 *
 * `http(s).request` is used rather than `fetch` for exactly one reason: `fetch` (undici) offers no
 * supported way to override address resolution without pulling the `undici` package in as a
 * dependency and matching its version to Node's bundled copy. The stdlib client takes a `lookup`
 * and needs nothing installed. It also never follows redirects on its own, so the "a 3xx is a
 * refusal, not a hop" invariant the callers rely on holds by construction here — there is no
 * `redirect: "follow"` to forget.
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
