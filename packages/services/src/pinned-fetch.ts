import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";

/**
 * ── THE PIN, AND WHY IT IS THE OTHER HALF OF THE SSRF GATE ────────────────────────────────────
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

export interface PinnedRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** The validated addresses from the SSRF gate. The socket connects ONLY to these. */
  pin: readonly string[];
  signal?: AbortSignal;
}

export interface PinnedResponse {
  status: number;
  headers: IncomingMessage["headers"];
  /** The response body as a Node readable — the caller streams, caps or discards it. */
  stream: IncomingMessage;
}

/**
 * One HTTP(S) request whose socket is PINNED to `opts.pin` (see {@link pinnedLookup}). Resolves
 * once the response HEADERS arrive; the body is handed back as a stream so the caller keeps its
 * own size cap and discard policy. Redirects are NOT followed — a 3xx comes back as itself.
 */
export function pinnedHttpRequest(url: string, opts: PinnedRequestOptions): Promise<PinnedResponse> {
  const request = new URL(url).protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise<PinnedResponse>((resolve, reject) => {
    const req = request(
      url,
      {
        method: opts.method ?? "GET",
        lookup: pinnedLookup(opts.pin),
        headers: opts.headers,
        signal: opts.signal,
        // `servername` (SNI) and the `Host` header are left to default from the URL's hostname,
        // so pinning the address does not weaken certificate validation or name-based routing.
      },
      (res) => resolve({ status: res.statusCode ?? 0, headers: res.headers, stream: res }),
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}
