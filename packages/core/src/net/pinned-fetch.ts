import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";

/**
 * The pin lives one module over, in a leaf that imports no HTTP client, and is re-exported here so
 * that every caller of the gate still reaches it in one place. See `pinned-lookup.ts` for which
 * caller could not carry this module and why.
 */
import { pinnedLookup } from "./pinned-lookup.js";
export { pinnedLookup } from "./pinned-lookup.js";

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
