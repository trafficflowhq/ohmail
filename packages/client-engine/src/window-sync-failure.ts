/**
 * WHAT A WINDOW SAYS ABOUT ITS OWN FAILED PULL — a content-free record, so the engine that keeps
 * the log can write it under the logger's allowlist without ever seeing a subject, an address or
 * a body. The shipped desktop had no such record: the window's drain rejected on every attempt for
 * a whole session, the failure reached the window console alone, and the engine log stayed clean
 * while the strip read "Sync failed. Retrying." (2026-09-21). `reason` is a CLOSED set decided
 * here, at the write door; the receiving door bounds the shape and takes nothing else.
 */

/** Why a pull failed, from the error the drain rejected with. */
export const WINDOW_SYNC_FAILURE_REASONS = [
  /** The door answered a status the adapter refused — `status` and `code` say which. */
  "http_refusal",
  /** The transport never answered: a socket error, or the desktop shell refusing to send. */
  "transport",
  /** The desktop bridge's own deadline elapsed with no answer from the engine. */
  "bridge_deadline",
  /** The drain was cancelled between pages. */
  "aborted",
  /** The door's cursor was expired twice within one drain. */
  "cursor_expired",
  /** A page arrived that the engine could not read. */
  "protocol",
  /** The engine's own code threw while applying or pruning — a defect in the window, not a door. */
  "window_fault",
  "unknown",
] as const;

export type WindowSyncFailureReason = (typeof WINDOW_SYNC_FAILURE_REASONS)[number];

export interface WindowSyncFailure {
  /** The scheduler's consecutive-failure count at the moment of this report. */
  attempt: number;
  reason: WindowSyncFailureReason;
  /** The error's class name — `RangeError`, `MutationRejectedError` — never its message. */
  errorClass: string;
  /** The refused status, when the door answered one. */
  status?: number;
  /** The door's own error code, when it named one. */
  code?: string;
}

const NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Classify a drain's rejection. Reads only class names, numeric statuses and closed codes: the
 * message is never copied, because a door's message can name a mailbox and the window's own
 * `TypeError` can quote a value.
 */
export function classifyWindowSyncFailure(err: unknown, attempt: number): WindowSyncFailure {
  const e = (typeof err === "object" && err !== null ? err : {}) as {
    name?: unknown; status?: unknown; code?: unknown;
  };
  const errorClass = typeof e.name === "string" && NAME.test(e.name)
    ? e.name
    : err instanceof Error ? "Error" : typeof err;
  const status = typeof e.status === "number" && Number.isInteger(e.status) && e.status >= 100 && e.status <= 599
    ? e.status : undefined;
  const code = typeof e.code === "string" && CODE.test(e.code) ? e.code : undefined;
  const out: WindowSyncFailure = { attempt, reason: "unknown", errorClass };
  if (status !== undefined) out.status = status;
  if (code !== undefined) out.code = code;
  if (errorClass === "SyncAbortedError" || errorClass === "AbortError") out.reason = "aborted";
  else if (errorClass === "CursorExpiredError") out.reason = "cursor_expired";
  else if (errorClass === "BridgeDeadlineError") out.reason = "bridge_deadline";
  else if (code === "network") out.reason = "transport";
  else if (code === "protocol") out.reason = "protocol";
  else if (status !== undefined) out.reason = "http_refusal";
  else if (
    errorClass === "RangeError" || errorClass === "TypeError" || errorClass === "ReferenceError"
    || errorClass === "MirrorGenerationChanged"
  ) out.reason = "window_fault";
  return out;
}
