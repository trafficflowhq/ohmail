import { MAX_BODY_BYTES, PROTOCOL_VERSION, readBodyBounded } from "./frame.js";

/* Lives in `frame.ts`, which imports nothing of the engine, so the Cloud door can read a body
   the same way without its graph reaching the organizer (`cloud-engine-census.test.ts`). */
export { readBodyBounded };
// TYPE-ONLY, and that is the whole reason this is not a second copy of the union. `client.ts`
// imports this file, and a runtime import of the engine would drag PGlite and the whole API into
// the UI side of the bridge; `import type` is erased entirely, so the wire and the engine share one
// definition at compile time and nothing at run time. Two hand-written copies would drift, and the
// drift would be a shell that renders the wrong sentence about somebody's password.
import type { CredentialState } from "./engine.js";

/**
 * `Request`/`Response` ⇄ frame marshalling. `createApp(...).handle` is a plain `Request → Response`
 * function with no server binding, which lets the stdio bridge be a shim rather than a port; this is
 * that shim, and the ONLY place that knows how a request becomes bytes (host and client both go
 * through these four functions). SET-COOKIE is special and silently lossy: iterating a `Headers`
 * joins repeated names with `", "`, destructive for a cookie value with a comma, so it travels in its
 * own array via `getSetCookie()` — the local sidecar mints no cookies, and this keeps that true by
 * evidence. The response body is read with a CEILING: `/events` (SSE) would buffer indefinitely, so
 * the deps turn it OFF (the structural fix), and {@link readBodyBounded} is the backstop that aborts a merely-enormous response with a 502.
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
   * Whether this launch has a mailbox password it can actually use. `ready` already means "serving",
   * and serving is deliberately not "connected": the engine comes up and serves the mirror with no
   * password, because a missing credential is a prompt rather than a broken app. The shell has to SAY
   * which happened, and without this field its only evidence is that the mailbox never syncs — a
   * symptom identical to a slow first sync, an unreachable server and a stand-down. `absent` (nothing
   * stored or supplied), `unreadable` (stored but this install's key does not open it), `ready`. It
   * is the value AT LAUNCH and describes the SEED's state at boot; a mailbox added from Settings is
   * re-pointed by its own door within the request, so this frame is a launch-time snapshot the shell re-reads.
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
 * Unsolicited and strictly earlier than `ready`: once the engine is serving there is nothing
 * left for this to say, and the app's own sync surface narrates from there. `phase` is a closed identifier the window maps to a sentence; a shell built before this
 * frame existed skips it unread (an unknown `t` has always been "skip the body and carry on"),
 * which is what lets an engine say more without a lockstep upgrade.
 */
export interface PhaseHeader extends Record<string, unknown> {
  v: number;
  t: "phase";
  phase: string;
  /**
   * How far a countable phase has got — `migrating` and only it, absent everywhere else and on
   * every engine built before this existed. Two numbers rather than a word, because the window
   * renders "(3 of 12)" and a shell that does not know them renders the same sentence it always
   * did; `applied` may equal `pending`, which is the pass finishing.
   */
  applied?: number;
  pending?: number;
}

/**
 * THE MAILBOX A SERVING ENGINE NAMES AFTER `ready` — unsolicited, at most once per launch, and only
 * where `ready.mailboxId` was empty: a paired install has no address, so its world names no mailbox
 * until the first mailbox list lands. The shell fills the empty id it recorded from `ready` and
 * ignores any other; a shell built before this frame skips it unread (an unknown `t`).
 */
export interface MailboxHeader extends Record<string, unknown> {
  v: number;
  t: "mailbox";
  mailboxId: string;
}

export type AnyHeader = RequestHeader | ResponseHeader | ErrorHeader | ReadyHeader | PhaseHeader | MailboxHeader;

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
