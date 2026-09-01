export interface JsonResponseInit {
  status?: number;
  /** When present, echoed as `X-Sync-Seq` — the change_log seq this mutation emitted (contract §3.4). */
  seq?: number | bigint | null;
  headers?: Record<string, string>;
}

/** JSON body + `Content-Type: application/json`; attaches `X-Sync-Seq` when a seq is given. */
export function jsonResponse(body: unknown, init: JsonResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  // `nosniff` on EVERY response, set here rather than per route so a new route cannot miss
  // it. Defence in depth and nothing more: these bodies are `application/json` and a modern
  // browser honours that, so the header matters for legacy sniffing rather than for any live
  // vector. The one place sniffing WOULD matter is the attachment routes, whose bytes and declared
  // content type are sender-chosen — and those build their own `Response`, so they set it
  // themselves (`routes/attachments.ts`). CSP, `X-Frame-Options` and `Referrer-Policy` are
  // deliberately NOT set here: with every response `application/json` there is nothing to frame
  // or navigate, and the webapp already carries the full set on the surface where they bite.
  headers.set("X-Content-Type-Options", "nosniff");
  if (init.seq !== undefined && init.seq !== null) headers.set("X-Sync-Seq", String(init.seq));
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

/**
 * The `ApiError` envelope (contract §1.4): `{ error: { code, message, details?, retryable? } }`
 * at `status`.
 *
 * `retryable` is emitted ONLY when a service stated it, and that omission-by-default is the
 * point: the client already reads `wire.error.retryable ?? (status >= 500 || status === 429)`
 * (`packages/client-engine/src/adapters/http-adapter.ts`), so saying nothing preserves the
 * status heuristic for every response that has always relied on it, while a service that KNOWS
 * can now override it. The field has been declared on `ServiceError` and typed on the client's
 * `WireError` since both were written; this serializer was the missing half, so no existing
 * response changes shape (no construction site sets it except the ones added with it).
 *
 * It matters most where the heuristic is backwards: a 503 that an operator must fix would
 * otherwise tell a mutation queue to retry it forever.
 */
export function errorResponse(
  code: string, status: number, message: string, details?: unknown, retryable?: boolean,
  /**
   * Extra response headers. Added for `Retry-After` on the 503 a starved connection pool
   * raises: `retryable: true` tells a client it MAY retry, and only a header tells it WHEN —
   * without one a mutation queue's own backoff is the only thing between a congested instance
   * and every refused caller returning at once.
   */
  headers?: Record<string, string>,
): Response {
  const error: { code: string; message: string; details?: unknown; retryable?: boolean } =
    { code, message };
  if (details !== undefined) error.details = details;
  if (retryable !== undefined) error.retryable = retryable;
  return jsonResponse({ error }, { status, headers });
}
