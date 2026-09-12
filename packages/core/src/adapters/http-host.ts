import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * The hand-rolled node:http adapter — IncomingMessage/ServerResponse to fetch Request/Response;
 * the route table is the framework. A node-only subpath (`@trafficflow/core/adapters/http-host`)
 * with two consumers that must not diverge: the self-host server (via its `src/http.ts` shim) and
 * the sidecar's host door (`host-listener.ts`). Four points, held by real-socket tests in both:
 * `Readable.toWeb(req)` with `duplex: "half"`, no body forwarded for a body-less request;
 * multi-value `Set-Cookie` via `getSetCookie()`; streaming responses via
 * `Readable.fromWeb(...).pipe(res)` so `/events` SSE frames move as enqueued; a body byte cap
 * plus `headersTimeout`/`requestTimeout` against slow and lying clients.
 */

export interface AdapterOptions {
  bodyMaxBytes: number;
  headersTimeoutMs: number;
  requestTimeoutMs: number;
  /**
   * How often node sweeps connections for the two timeouts above. Node's default is 30 s, which
   * is also the FLOOR on how late a timeout can fire — production leaves it unset; the adapter
   * test sets it small so the slow-header proof runs in milliseconds instead of half a minute.
   */
  connectionsCheckingIntervalMs?: number;
  /**
   * Serve TLS with this key pair instead of plain HTTP — present only for the LAN door
   * (`apps/sidecar/src/host-lan.ts`), whose one client, a phone's native app, cannot open a
   * cleartext socket on a release build, and whose trust comes from the pairing ceremony's key
   * fingerprint (`apps/sidecar/src/host-lan-tls.ts`). Not a wider TLS feature: the loopback door
   * stays plain behind `tailscale serve`, the self-host server behind the operator's proxy.
   * `https.Server` extends `http.Server`, so every property and method this module touches is the
   * same one — a choice of constructor, not a second adapter.
   */
  tls?: { key: string; cert: string };
}

/** Thrown into the body stream when a chunked body crosses the cap mid-flight. */
export class BodyTooLargeError extends Error {
  constructor() {
    super("request body exceeds the configured cap");
    this.name = "BodyTooLargeError";
  }
}

/** The refusal body, in the API's own error envelope so clients parse one shape everywhere. */
const TOO_LARGE_BODY = JSON.stringify({
  error: { code: "payload_too_large", message: "request body too large" },
});

/** GET/HEAD with a body indicator — see {@link serve}. Same envelope, its own code. */
const BODY_NOT_ALLOWED = JSON.stringify({
  error: { code: "body_not_allowed", message: "GET and HEAD requests must not carry a body" },
});

/**
 * The headers of a refusal that ends the socket — `connection: close` is the load-bearing one.
 * Each refusal answers and then calls `res.destroy()` while the rest of the body is still coming;
 * node defaults to `Connection: keep-alive`, so without this the answer claimed the connection
 * was good and the socket died a moment later. A client reading keep-alive pipelines the next
 * request and keeps feeding the body; both die on a broken pipe, surfacing as a transport fault
 * instead of the 413 actually sent. `res.destroy()` stays: the header announces, destroying stops
 * an over-cap upload from costing bytes.
 */
const REFUSED_HEADERS = {
  "content-type": "application/json",
  "cache-control": "no-store",
  connection: "close",
} as const;

/**
 * Does this request CARRY a body at all? RFC 9112 §6: a request has a body iff it declares
 * Content-Length or Transfer-Encoding. Reading node's always-present stream instead would turn
 * every body-less POST into "a body is present" one layer up (point 1).
 */
function hasBody(req: IncomingMessage): boolean {
  if (req.headers["transfer-encoding"] !== undefined) return true;
  const len = req.headers["content-length"];
  return len !== undefined && Number(len) > 0;
}

/** Build the fetch Request for one inbound message. Exported for the adapter's own tests. */
export function toWebRequest(
  req: IncomingMessage,
  opts: { bodyMaxBytes: number; onTooLarge: () => void },
): Request {
  // The scheme is nominal — this process sits behind the operator's proxy and nothing downstream
  // reads it; the HOST half is real and feeds the cookie-auth decision (every asserted host must
  // be allow-listed, so a forged Host can only ever turn cookies off).
  const url = `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;

  // rawHeaders, not .headers: node's parsed object has already folded duplicates (joining some
  // with ", " and cookies with "; "), and Headers.append is the semantically correct fold.
  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]!;
    // undici refuses to construct a Request carrying forbidden/invalid header names rather than
    // ignoring them; connection-level headers are the socket's business, not the route table's.
    if (/^(connection|keep-alive|transfer-encoding|upgrade|proxy-connection)$/i.test(name)) continue;
    // PLATFORM-RESERVED IP HEADERS ARE DROPPED, because the reservation does not hold here.
    // `clientIp()` (packages/api/src/context.ts) trusts `x-vercel-forwarded-for` FIRST, on the
    // documented ground that Vercel's edge overwrites every inbound `x-vercel-*` header — so
    // its value cannot be caller-chosen THERE. This host sits behind the operator's own proxy
    // or none, nothing overwrites anything, and an inbound `x-vercel-*` is by definition typed
    // by the caller: keeping it would hand every anonymous client a fresh-rate-limit-bucket
    // switch (`curl -H 'x-vercel-forwarded-for: …'`) on the registration throttle and a forged
    // line in the auth audit. Dropped wholesale — no legitimate traffic to this host carries
    // the platform's namespace.
    if (/^x-vercel-/i.test(name)) continue;
    try {
      headers.append(name, req.rawHeaders[i + 1]!);
    } catch {
      /* an unrepresentable header name/value never reaches a handler */
    }
  }
  // …and this adapter APPENDS the socket's own peer address as the last `x-forwarded-for` hop,
  // because it IS the nearest trusted proxy in `clientIp()`'s model (that function reads the
  // LAST hop — the one entry a client cannot append after). Direct exposure: the last hop is
  // the real peer, and a hand-typed `x-forwarded-for` buys nothing. Behind the operator's
  // proxy: the last hop is the proxy's address, so per-IP limits key to the proxy — the
  // over-restrictive, visible direction, which is the safe one; a trusted-proxy knob is the
  // packaging layer's decision, not a default.
  const peer = req.socket?.remoteAddress ?? "";
  if (peer) headers.append("x-forwarded-for", peer);

  const method = req.method ?? "GET";
  // GET/HEAD are ALWAYS body-less here — undici refuses to construct them with one, and
  // `serve()` has already answered 400 + destroyed the connection for the body-carrying form,
  // so this branch only decides the Request shape for a caller that bypassed serve (a test).
  if (method === "GET" || method === "HEAD" || !hasBody(req)) {
    return new Request(url, { method, headers });
  }

  // Point 4's second half: the counting transform behind the declared-length check. It errors
  // the stream (so any in-flight read throws) AND tells the server loop, which answers 413 while
  // the response is still writable and destroys the connection.
  let received = 0;
  const cap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      received += chunk.length;
      if (received > opts.bodyMaxBytes) {
        opts.onTooLarge();
        cb(new BodyTooLargeError());
        return;
      }
      cb(null, chunk);
    },
  });
  req.on("error", (err) => cap.destroy(err));

  // Point 1: the socket's own stream, as a web stream, with the half-duplex marker.
  const body = Readable.toWeb(req.pipe(cap)) as unknown as ReadableStream;
  return new Request(url, { method, headers, body, duplex: "half" } as RequestInit);
}

/** Write one fetch Response onto the node response. Exported for the adapter's own tests. */
export async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
  if (res.writableEnded || res.headersSent) {
    // The 413 path already answered (a cap hit while the handler was mid-flight); the handler's
    // eventual response has nowhere to go and its stream must still be released.
    await response.body?.cancel().catch(() => { /* nothing to release */ });
    return;
  }
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => {
    // Point 2: never let the folded iterator view of Set-Cookie reach the wire.
    if (key.toLowerCase() === "set-cookie") return;
    headers[key] = value;
  });
  const setCookies = response.headers.getSetCookie();
  if (setCookies.length > 0) headers["set-cookie"] = setCookies;

  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  try {
    // Point 3: frame-by-frame with backpressure — this is what makes SSE stream.
    await pipeline(Readable.fromWeb(response.body as never), res);
  } catch {
    // The client went away mid-stream (an EventSource reconnect, a closed tab). The socket is
    // dead either way; destroying releases the response reader.
    res.destroy();
  }
}

/**
 * Stand the server up around one `handle(Request) → Response`. The caller owns `listen()` and
 * shutdown ordering (`apps/server/src/index.ts`: close the listener, then the wake hub, then the
 * pool; `apps/sidecar/src/host-listener.ts`: close the listener before the stdio host and the
 * store).
 */
export function makeHttpServer(
  handle: (req: Request) => Promise<Response>,
  opts: AdapterOptions,
): Server {
  const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
    void serve(req, res, handle, opts).catch(() => {
      // serve() answers its own failures; this catch only covers a socket that died while we
      // were answering, where there is nothing left to say and nobody left to say it to.
      res.destroy();
    });
  };
  const base = opts.connectionsCheckingIntervalMs !== undefined
    ? { connectionsCheckingInterval: opts.connectionsCheckingIntervalMs }
    : {};
  // `https.createServer` passes its options to BOTH `tls.createServer` and node's http server
  // option store, so `connectionsCheckingInterval` keeps working on the TLS door — the two
  // constructors take the same bag, which is why the branch is this narrow.
  const server: Server = opts.tls
    ? createTlsServer({ ...base, key: opts.tls.key, cert: opts.tls.cert }, onRequest)
    : createServer(base, onRequest);
  // Point 4: slow-header and slow-body ceilings. requestTimeout bounds RECEIVING the request,
  // so a long-lived SSE RESPONSE is unaffected.
  server.headersTimeout = opts.headersTimeoutMs;
  server.requestTimeout = opts.requestTimeoutMs;
  return server;
}

async function serve(
  req: IncomingMessage,
  res: ServerResponse,
  handle: (r: Request) => Promise<Response>,
  opts: AdapterOptions,
): Promise<void> {
  // A GET/HEAD that DECLARES a body is refused outright, connection destroyed. Nothing on this
  // API reads one, and the alternative was a measured bypass of the byte cap: the old adapter
  // built body-less Requests for GET/HEAD without consuming the wire body, and node's own
  // keep-alive dump then read-and-discarded a chunked body UNCOUNTED — an anonymous client
  // could stream to /hello until requestTimeout, past every limit this file owns. Refusing is
  // strictly better than counting here: a capped GET body would still be work nobody asked for.
  const method = (req.method ?? "GET").toUpperCase();
  if ((method === "GET" || method === "HEAD") && hasBody(req)) {
    res.writeHead(400, REFUSED_HEADERS);
    res.end(BODY_NOT_ALLOWED);
    res.destroy();
    return;
  }

  // Point 4's first half: a DECLARED length over the cap is refused before a byte is read.
  const declared = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > opts.bodyMaxBytes) {
    res.writeHead(413, REFUSED_HEADERS);
    res.end(TOO_LARGE_BODY);
    res.destroy();
    return;
  }

  let tooLarge = false;
  const webReq = toWebRequest(req, {
    bodyMaxBytes: opts.bodyMaxBytes,
    onTooLarge: () => {
      tooLarge = true;
      if (!res.headersSent) {
        res.writeHead(413, REFUSED_HEADERS);
        res.end(TOO_LARGE_BODY);
      }
      // A client mid-way through an over-cap upload must not keep feeding the socket.
      res.destroy();
    },
  });

  const response = await handle(webReq);
  if (tooLarge) {
    await response.body?.cancel().catch(() => { /* released */ });
    return;
  }
  await writeWebResponse(res, response);
}
