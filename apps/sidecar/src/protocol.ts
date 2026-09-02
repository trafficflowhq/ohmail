import { FrameError, MAX_BODY_BYTES, PROTOCOL_VERSION } from "./frame.js";
// TYPE-ONLY, and that is the whole reason this is not a second copy of the union. `client.ts`
// imports this file, and a runtime import of the engine would drag PGlite and the whole API into
// the UI side of the bridge; `import type` is erased entirely, so the wire and the engine share one
// definition at compile time and nothing at run time. Two hand-written copies would drift, and the
// drift would be a shell that renders the wrong sentence about somebody's password.
import type { CredentialState } from "./engine.js";

/**
 * `Request`/`Response` ⇄ frame marshalling.
 *
 * `createApp(...).handle` is a plain `Request → Response` function with no server binding, which
 * is what lets the stdio bridge be a shim rather than a port: nothing has to be listening for the
 * app to answer a request. This file is that shim, and it is deliberately the ONLY place that
 * knows how a request becomes bytes: the host and the client both go through these four
 * functions, so there is one encoding to get right and one place a mismatch shows up.
 *
 * ── SET-COOKIE IS SPECIAL AND SILENTLY LOSSY IF YOU FORGET ────────────────────────────────
 *
 * Iterating a `Headers` combines repeated names with `", "`, and for `Set-Cookie` that is
 * destructive: two cookies become one malformed string, because a cookie value may itself contain
 * a comma (`Expires=Wed, 09 Jun 2027 …`). `Response.headers.getSetCookie()` is the only correct
 * reader, so set-cookie travels in its own array field and is re-`append`ed on the far side. The
 * LOCAL sidecar is bearer-only (`allowCookieAuth: false`) and mints no cookies — this exists so
 * that stays true by evidence rather than by nobody having looked.
 *
 * ── THE RESPONSE BODY IS READ WITH A CEILING ──────────────────────────────────────────────
 *
 * A whole `Response` has to be buffered before it can be framed, so a route that streams
 * indefinitely would buffer indefinitely. `GET /events` (SSE) is exactly that route, and
 * `DEFAULT_SSE.enabled` is `true`, so the sidecar's deps turn it OFF — the structural fix, since a
 * disabled `/events` answers a finite `503 sse_disabled` and `HttpAdapter` already treats SSE as
 * an optional wake signal it can live without.
 *
 * {@link readBodyBounded} is the second lock: it drains the body through a reader and aborts the
 * moment the total passes the cap, so a merely-enormous response fails loudly with a 502 instead
 * of growing until the process dies. It does NOT rescue an infinite stream that never reaches the
 * cap — nothing at this layer can, which is why the `sse` switch is the primary defence and this
 * is the backstop.
 */

/** A request travelling to the sidecar. */
export interface RequestHeader extends Record<string, unknown> {
  v: number;
  t: "req";
  id: number;
  method: string;
  url: string;
  h: Array<[string, string]>;
}

/** A response travelling back. */
export interface ResponseHeader extends Record<string, unknown> {
  v: number;
  t: "res";
  id: number;
  status: number;
  statusText: string;
  h: Array<[string, string]>;
  /** `Set-Cookie`, one entry per cookie — see the header note. */
  sc: string[];
}

/**
 * A transport-level failure for one request: the sidecar could not produce a `Response` at all.
 *
 * Distinct from a 5xx, which IS a response and means the app ran. This is "the frame was
 * malformed" or "the host threw outside the app", and the client surfaces it as a rejected fetch —
 * the shape a browser gives a dead socket, which `HttpAdapter` already turns into a retryable
 * `MutationRejectedError`.
 */
export interface ErrorHeader extends Record<string, unknown> {
  v: number;
  t: "err";
  id: number;
  code: string;
  message: string;
}

/**
 * The unsolicited hello the sidecar sends once it is serving.
 *
 * It carries the per-launch session token — minted at launch, never persisted — which is how the
 * shell authenticates without a login ceremony the desktop tier does not have. It travels in-band
 * on a pipe only the parent process holds, so there is nobody else it could reach: the host
 * door's listener (when host mode is armed) is a different transport, and this hello and its
 * token never travel there.
 */
export interface ReadyInfo {
  baseUrl: string;
  sessionToken: string;
  accountId: string;
  userId: string;
  mailboxId: string;
  /**
   * Whether this launch has a mailbox password it can actually use.
   *
   * `ready` already means "serving", and serving is deliberately not the same as connected: the
   * engine comes up and serves the mirror with no password at all, because a missing credential is
   * a prompt rather than a broken app (`engine.ts`'s `start()`). The shell is the thing that has to
   * SAY which of the two happened, and without this field its only evidence is that the mailbox
   * never syncs — a symptom that looks identical to a slow first sync, an unreachable server and a
   * stand-down.
   *
   * `absent` — nothing stored and nothing supplied. `unreadable` — a credential is stored and this
   * install's key does not open it. `ready` — there is a password to log in with.
   *
   * It is the value AT LAUNCH and is never updated in place, and the shell re-reads it rather
   * than trusting this field to age well.
   *
   * It used to say a password entered afterwards "takes effect on the next launch". That is still
   * true of THIS FRAME — it is a launch-time snapshot and nothing rewrites it — but it is no
   * longer true of the install: a mailbox added from Settings is re-pointed by its own door,
   * which detaches its runtime and attaches a fresh one, so its new password is in force within
   * the request rather than after a restart. The frame describes the SEED's state at boot, which
   * is the one the shell renders before any mailbox list exists.
   */
  credentialState: CredentialState;
  /**
   * Cloud mode only: whether the hosted account was reachable AT LAUNCH.
   *
   * Additive and optional — the local organizer omits it (there is no "offline mirror" to be in;
   * it opens the user's own IMAP). In Cloud mode the mirror serves whatever it already holds
   * whether or not the first pull has landed, so this is the launch snapshot and `/health.online`
   * is the live value the shell polls thereafter. Like `credentialState`, it is not updated in
   * place: the frame says what was true when the bridge began serving.
   */
  online?: boolean;
}


// Split from {@link ReadyInfo} rather than written inline, because `Omit<ReadyHeader, "v"|"t">`
// over a type carrying an index signature erases every named key and leaves `{[k: string]:
// unknown}` — which then type-checks a `ready()` call that supplies nothing at all.
export interface ReadyHeader extends ReadyInfo, Record<string, unknown> {
  v: number;
  t: "ready";
}

/**
 * What the engine is doing while it is still starting — sent BEFORE `ready`, zero or more times.
 *
 * The one unsolicited frame besides `ready`, and strictly earlier than it: once the engine is
 * serving there is nothing left for this to say, and the app's own sync surface narrates from
 * there. `phase` is a closed identifier the window maps to a sentence; a shell built before this
 * frame existed skips it unread (an unknown `t` has always been "skip the body and carry on"),
 * which is what lets an engine say more without a lockstep upgrade.
 */
export interface PhaseHeader extends Record<string, unknown> {
  v: number;
  t: "phase";
  phase: string;
}

export type AnyHeader = RequestHeader | ResponseHeader | ErrorHeader | ReadyHeader | PhaseHeader;

const EMPTY = new Uint8Array(0);

/**
 * Read a body with a hard ceiling, cancelling the source the moment it is passed.
 *
 * `arrayBuffer()` would be one line and would also happily buffer a gigabyte. The reader loop is
 * the difference between "this response is too large" and "the sidecar died".
 */
export async function readBodyBounded(m: Request | Response, maxBytes: number): Promise<Uint8Array> {
  if (!m.body) {
    const buf = await m.arrayBuffer();
    if (buf.byteLength > maxBytes) {
      throw new FrameError(`body is ${buf.byteLength} bytes, over the ${maxBytes}-byte frame cap`);
    }
    return buf.byteLength === 0 ? EMPTY : new Uint8Array(buf);
  }
  const reader = m.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new FrameError(`body exceeded the ${maxBytes}-byte frame cap`);
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) return EMPTY;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/** A `Request` → the frame that carries it. Consumes the request's body. */
export async function encodeRequest(
  id: number,
  req: Request,
  maxBodyBytes: number = MAX_BODY_BYTES,
): Promise<{ header: RequestHeader; body: Uint8Array }> {
  const body = await readBodyBounded(req, maxBodyBytes);
  return {
    header: {
      v: PROTOCOL_VERSION,
      t: "req",
      id,
      method: req.method,
      url: req.url,
      h: [...req.headers].map(([k, v]) => [k, v] as [string, string]),
    },
    body,
  };
}

/** The frame → the `Request` the app will see. */
export function decodeRequest(header: RequestHeader, body: Buffer): Request {
  const headers = new Headers();
  for (const [k, v] of header.h) headers.append(k, v);
  const method = header.method.toUpperCase();
  // GET/HEAD may not carry a body; the `Request` constructor throws rather than ignoring one, and
  // that throw would read as a malformed frame instead of what it is — a client bug.
  const hasBody = body.byteLength > 0 && method !== "GET" && method !== "HEAD";
  return new Request(header.url, {
    method,
    headers,
    ...(hasBody ? { body: new Uint8Array(body) } : {}),
  });
}

/** A `Response` → the frame that carries it. Consumes the response's body. */
export async function encodeResponse(
  id: number,
  res: Response,
  maxBodyBytes: number = MAX_BODY_BYTES,
): Promise<{ header: ResponseHeader; body: Uint8Array }> {
  const sc = res.headers.getSetCookie();
  const h: Array<[string, string]> = [];
  for (const [k, v] of res.headers) {
    if (k.toLowerCase() === "set-cookie") continue; // carried separately, see the header note
    h.push([k, v]);
  }
  const body = await readBodyBounded(res, maxBodyBytes);
  return {
    header: { v: PROTOCOL_VERSION, t: "res", id, status: res.status, statusText: res.statusText, h, sc },
    body,
  };
}

/** Statuses the `Response` constructor refuses to give a body to. */
const BODYLESS = new Set([101, 103, 204, 205, 304]);

/** The frame → the `Response` the client's `fetch` resolves with. */
export function decodeResponse(header: ResponseHeader, body: Buffer): Response {
  const headers = new Headers();
  for (const [k, v] of header.h) headers.append(k, v);
  for (const cookie of header.sc ?? []) headers.append("set-cookie", cookie);
  const payload = body.byteLength > 0 && !BODYLESS.has(header.status) ? new Uint8Array(body) : null;
  return new Response(payload, { status: header.status, statusText: header.statusText, headers });
}
