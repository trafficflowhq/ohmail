import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * THE HAND-ROLLED node:http ADAPTER — IncomingMessage/ServerResponse ⇄ fetch Request/Response,
 * and nothing else. No framework: the route table already IS the framework
 * (`createApp(selfHostRoutes)` speaks fetch types), so the only job here is the translation, and
 * a framework would re-introduce its own body parsing, its own cookie folding and its own
 * timeouts on top of the ones this file must own anyway.
 *
 * Four correctness points, ruled and each held by a test on a REAL socket
 * (`test/http-adapter.test.ts`):
 *
 *  1. **`Readable.toWeb(req)` + `duplex: "half"`.** A Request constructed with a stream body
 *     requires the half-duplex marker or undici throws at construction; and the body must be the
 *     socket's own stream, not a hand-buffered copy — the pipeline downstream decides what to
 *     buffer (`handler.ts` buffers JSON bodies for canonicalization, exactly as the managed host
 *     does). A body-less request must pass NO body: node gives every IncomingMessage a readable,
 *     and forwarding an empty stream makes `withRequestGuard` demand a Content-Type from a
 *     legitimately body-less `POST /auth/logout` — a 415 for a correct request.
 *  2. **Multi-value `Set-Cookie` via `getSetCookie()`.** A sign-in mints FIVE cookies; the
 *     Headers iterator folds them into one comma-joined value, which browsers read as one broken
 *     cookie. `getSetCookie()` is the one API that returns them separately, and node's
 *     `writeHead` takes the array form.
 *  3. **Streaming response bodies.** `/events` is an SSE stream that stays open for minutes;
 *     `Readable.fromWeb(...).pipe(res)` moves each frame as it is enqueued, with backpressure,
 *     and never buffers the response. (Buffering here is not slow — it is a stream that sends
 *     nothing until lifetime close, i.e. SSE that does not work.)
 *  4. **Body byte cap + `headersTimeout`/`requestTimeout`.** A declared Content-Length over the
 *     cap is 413 before a byte is read; a chunked body that lies is cut off by a counting
 *     transform at the cap (413 while the headers are still writable, connection destroyed
 *     either way). The two node timeouts bound slow-header and slow-body clients — a
 *     long-running process accumulates slowloris sockets that a serverless platform reaps for
 *     free.
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
 * shutdown ordering (`index.ts`: close the listener, then the wake hub, then the pool).
 */
export function makeHttpServer(
  handle: (req: Request) => Promise<Response>,
  opts: AdapterOptions,
): Server {
  const server = createServer(
    opts.connectionsCheckingIntervalMs !== undefined
      ? { connectionsCheckingInterval: opts.connectionsCheckingIntervalMs }
      : {},
    (req, res) => {
      void serve(req, res, handle, opts).catch(() => {
        // serve() answers its own failures; this catch only covers a socket that died while we
        // were answering, where there is nothing left to say and nobody left to say it to.
        res.destroy();
      });
    },
  );
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
    res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(BODY_NOT_ALLOWED);
    res.destroy();
    return;
  }

  // Point 4's first half: a DECLARED length over the cap is refused before a byte is read.
  const declared = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > opts.bodyMaxBytes) {
    res.writeHead(413, { "content-type": "application/json", "cache-control": "no-store" });
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
        res.writeHead(413, { "content-type": "application/json", "cache-control": "no-store" });
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
