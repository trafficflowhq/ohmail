/** The API's error envelope, as `HttpAdapter.rejectionOf` reads it off a non-2xx body. */
export interface RefusalEnvelope {
  code?: string;
  message?: string;
  retryable?: boolean;
  details?: unknown;
}

export type RefusalKind = "read" | "write";

/**
 * Classify a non-2xx answer. With our envelope the server's own words rule. Without one — a
 * platform page in front of the API, an HTML 401, a text 413 — the STATUS decides: a 401 is an
 * authentication refusal whoever wrote it, so it carries the code the session heal keys on; and
 * an unreadable refusal of a READ is never a proven refusal of the content, so it stays
 * retryable. A write keeps the old default (5xx and 429 only): the outbox must not loop on a
 * platform 4xx. Measured 2026-09-21: one envelope-less 401 left "Couldn't load this message's
 * files" (no Retry) and "Couldn't load the full message" standing for the whole session.
 */
export function classifyRefusal(
  status: number,
  envelope: RefusalEnvelope | undefined,
  kind: RefusalKind,
): { code: string | null; retryable: boolean } {
  const serverDefault = status >= 500 || status === 429;
  if (envelope !== undefined && typeof envelope.code === "string") {
    return { code: envelope.code, retryable: envelope.retryable ?? serverDefault };
  }
  return {
    code: status === 401 ? "unauthorized" : null,
    retryable: envelope?.retryable ?? (kind === "read" || serverDefault),
  };
}
