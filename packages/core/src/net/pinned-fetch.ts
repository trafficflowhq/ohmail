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
 *
 * It settles once, on every path. A connection can end with neither an answer nor an error: a
 * change of protocol (101) hands the socket to an `upgrade` event, an accepted CONNECT to a
 * `connect` one, and with nobody listening Node ends the request with a `close` alone, after
 * which the caller's abort finds nothing to abort. Both are refused here as a reset
 * (`ECONNRESET`), the code every caller already reads as a request that failed.
 *
 * It dials its own pin every time, and its connection ends with it. The platform's shared agent
 * would keep the connection and hand it to the next request for the same name and port, whatever
 * that request's pin: a request whose own check passed one address would be answered at another.
 */
export function pinnedHttpRequest(url: string, opts: PinnedRequestOptions): Promise<PinnedResponse> {
  const request = new URL(url).protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise<PinnedResponse>((resolve, reject) => {
    let settled = false;
    const refuse = (why: string): void => {
      if (settled) return;
      settled = true;
      reject(Object.assign(new Error(why), { code: "ECONNRESET" }));
    };
    const req = request(
      url,
      {
        method: opts.method ?? "GET",
        lookup: pinnedLookup(opts.pin),
        // An agent of this request's own, which keeps no connection: nothing is shared with a later request.
        agent: false,
        headers: opts.headers,
        signal: opts.signal,
        // `servername` (SNI) and the `Host` header are left to default from the URL's hostname,
        // so pinning the address does not weaken certificate validation or name-based routing.
      },
      (res) => {
        settled = true;
        resolve({ status: res.statusCode ?? 0, headers: res.headers, stream: res });
      },
    );
    // Listened to for the request's whole life: an error after the answer (a reset mid-body) comes here too.
    req.on("error", (err) => {
      settled = true;
      reject(err);
    });
    // A change of protocol is no answer this request takes: the socket it hands over is ended at once.
    req.on("upgrade", (_res, socket) => {
      socket.destroy();
      refuse("the far side switched protocols");
    });
    // The request's last event. An answer or an error has settled it by now, or nothing ever will.
    req.on("close", () => refuse("the connection closed with no answer"));
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}
