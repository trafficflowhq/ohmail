import type { UnjudgedWriteCode } from "@ohmail/wire";

/** The API's error envelope, as `HttpAdapter.rejectionOf` reads it off a non-2xx body. */
export interface RefusalEnvelope {
  code?: string;
  message?: string;
  retryable?: boolean;
  details?: unknown;
}

export type RefusalKind = "read" | "write";

/** The answers to a write that are not a server's verdict on it: offline, or no session to send it in. */
export type { UnjudgedWriteCode };

/**
 * THE CLOSED SET of codes nobody judged a write with. A write answered with one is kept and asked
 * again, whatever the envelope or the status says; only a server's own verdict retires a write.
 * One list: the refusal reader, the engine's belt and its wait codes all read it, and a root census
 * holds the desktop engine's two answers to it.
 */
export const UNJUDGED_WRITE_CODES: ReadonlySet<UnjudgedWriteCode> = new Set<UnjudgedWriteCode>([
  "offline_read_only",
  "not_signed_in",
]);

/** The answers that are about the app and its server, never about the write: too old, being updated. */
export type UpdateAnswerCode = "client_too_old" | "server_updating";

/**
 * THE CLOSED SET of codes a server answers when this app is too old for it, or while it is being
 * updated. A write answered with one waits and is asked again under its key; it spends none of the
 * give-up ceiling. A set of its own: nobody judged the write, but a server did answer. No server
 * of this release sends either; the readers are here so that a later one can.
 *
 * THE BOUND THE SENDING SERVER MUST KEEP, which nothing here can enforce: `retryingRead` waits what
 * a `503`'s `Retry-After` names (up to an hour) before each of its retries, so a `server_updating`
 * that names minutes holds every read that long before the one sentence can show. It names 30 s at
 * most (`test/retrying-read.test.ts` states the arithmetic). `client_too_old` names none.
 */
export const UPDATE_ANSWER_CODES: ReadonlySet<UpdateAnswerCode> = new Set<UpdateAnswerCode>([
  "client_too_old",
  "server_updating",
]);

/** Is this the code of an answer that never retires a write, whatever else the answer says? */
export function keepsWrite(code: string | null | undefined): boolean {
  return UNJUDGED_WRITE_CODES.has(code as UnjudgedWriteCode) || UPDATE_ANSWER_CODES.has(code as UpdateAnswerCode);
}

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
    // An unjudged write, or one that met an update answer, is retryable whatever the envelope
    // says: the envelope cannot override this.
    if (kind === "write" && keepsWrite(envelope.code)) {
      return { code: envelope.code, retryable: true };
    }
    return { code: envelope.code, retryable: envelope.retryable ?? serverDefault };
  }
  return {
    code: status === 401 ? "unauthorized" : null,
    retryable: envelope?.retryable ?? (kind === "read" || serverDefault),
  };
}

/**
 * The `code` on the refusal a withdrawn verb settles with — a Cancel here or in another window, or
 * the send route's 409 `send_withdrawn` for a key the server tombstoned. A surface reads it to say
 * NOTHING: a verb the person cancelled owes no sentence, and "it failed" would be the wrong one.
 */
export const OUTBOX_WITHDRAWN_CODE = "withdrawn";

/**
 * A staged upload that threw right after the API answered its mint, or that the desktop's hosted
 * door answered with this code (its own PUT to storage threw): the storage host is out of reach
 * while the API is not. The outbox counts it toward its ceiling (`serverAnswered`), so a send that
 * can never upload ends visibly instead of retrying for ever.
 */
export const STAGING_UNREACHABLE_CODE = "staging_unreachable";
