import { matchRoute, type Route } from "./router.js";

/**
 * What may this request's body weigh — decided from the route, before a byte is read. Both hosts
 * used to buffer the whole body before route matching against the largest ceiling any route could
 * need, so an anonymous client naming no served path could cost 50 MiB of heap per connection.
 * The path decides: no route ⇒ 0 bytes (the 404/405 is unchanged); GET/HEAD ⇒ 0; a route in
 * LARGE_BODY_ROUTES ⇒ the host's large ceiling; else JSON_BODY_MAX_BYTES. A list, not a route
 * flag: an undeclared route gets the small ceiling and fails loudly with a 413, and
 * `input-bounds-census.test.ts` derives the byte-carrying set from handler source both ways.
 */

/**
 * The ceiling for every JSON-body route — every route but one (`POST /drafts/:id/send` carries
 * attachment bytes; see LARGE_BODY_ROUTES). Derived from the largest body the table declares
 * legal so the door never refuses a request the service would serve: `POST /drafts` is the
 * largest (`DRAFT_HTML_CAP_BYTES`, the bounded recipient total, `DRAFT_SUBJECT_MAX_CHARS`);
 * `input-bounds-census.test.ts` recomputes the product. Every character counts at six bytes —
 * `JSON.stringify` escapes a control character as six wire bytes. 4 MiB clears the largest legal
 * body and stays under the platform's 4.5 MB; the census asserts the ordering. A backstop: every
 * size-proportional field has its own named ceiling.
 */
export const JSON_BODY_MAX_BYTES = 4 * 1024 * 1024;

/**
 * The routes whose body may legitimately carry attachment BYTES inline (base64), and so may not
 * be held to {@link JSON_BODY_MAX_BYTES}.
 *
 * Exactly one, and it is derived-checked rather than asserted: `POST /drafts/:id/send` decodes
 * `contentBase64` entries in `routes/drafts.ts#decodeSendAttachments`. The per-request TOTAL of
 * those bytes is bounded separately and more tightly by `SEND_ATTACHMENT_MAX_TOTAL_BYTES` (or a
 * self-host deployment's own `SELF_HOST_SEND_MAX_TOTAL_BYTES`) inside `SendService.reserve`;
 * this is only the door's permission for the request to be big at all.
 */
export const LARGE_BODY_ROUTES: ReadonlySet<string> = new Set<string>([
  "POST /drafts/:id/send",
]);

/** A body that crossed its route's ceiling. Both hosts answer it as 413. */
export class BodyOverCeilingError extends Error {
  constructor(readonly maxBytes: number, readonly sawBytes: number | null) {
    super("request body exceeds this route's ceiling");
    this.name = "BodyOverCeilingError";
  }
}

/**
 * The ceiling in bytes for one request, from its method and CANONICAL pathname. `0` means
 * "read nothing" — a body-less method, or a path this table does not serve.
 *
 * `largeBodyMaxBytes` is the host's own number for the send surface, because the two hosts
 * differ: a self-host process sets `BODY_MAX_BYTES` (50 MiB) and the managed host is capped by
 * the platform at 4.5 MB whatever we write here.
 */
export function bodyCeilingFor(
  routes: Route[], method: string, pathname: string, largeBodyMaxBytes: number,
): number {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD") return 0;
  const match = matchRoute(routes, m, pathname);
  if (!match.matched) return 0;
  return LARGE_BODY_ROUTES.has(`${match.route.method.toUpperCase()} ${match.route.pattern}`)
    ? largeBodyMaxBytes
    : JSON_BODY_MAX_BYTES;
}

/**
 * Read at most `maxBytes` of `req`'s body, or throw {@link BodyOverCeilingError}. Not
 * `req.arrayBuffer()` with a check afterwards — that checks bytes already in the heap, which
 * is the cost being refused. The declared `Content-Length` is consulted first, then the stream
 * is counted as it arrives (a chunked body may declare no length, or lie); the total is
 * compared before the chunk is retained, so the peak is one chunk over the ceiling. A `null`
 * body is `undefined`, never a zero-length buffer: undici gives an empty-body Request a
 * non-null `body`, and `withRequestGuard` would then demand a `Content-Type` from a
 * legitimately body-less `POST /auth/logout`.
 */
export async function readBodyWithin(
  req: Request, maxBytes: number,
): Promise<ArrayBuffer | undefined> {
  if (maxBytes <= 0) {
    // Nothing may be read. Release the socket rather than leaving it half-consumed: an
    // unmatched POST's body is drained by the platform either way, and cancelling says so.
    await req.body?.cancel().catch(() => { /* already gone */ });
    return undefined;
  }

  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await req.body?.cancel().catch(() => { /* already gone */ });
    throw new BodyOverCeilingError(maxBytes, declared);
  }

  const body = req.body;
  if (!body) return undefined;

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      // BEFORE the chunk is retained — see the docstring. Retaining it first would make the
      // peak the whole body for a client that sends it in one chunk, which is the normal case.
      if (total > maxBytes) throw new BodyOverCeilingError(maxBytes, total);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => { /* already closed, or already errored */ });
  }

  if (total === 0) return undefined;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out.buffer as ArrayBuffer;
}
