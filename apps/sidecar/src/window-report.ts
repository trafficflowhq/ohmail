/**
 * `POST /local/window/sync-failed` — the window telling the engine that its own pull loop failed,
 * so the failure reaches THIS log. Before this door the desktop's drain could reject on every
 * attempt for a whole session while the engine log stayed clean: the failure lived in a window
 * console nobody reads on a guest, and the strip's "Sync failed. Retrying." had nothing to
 * correlate with (2026-09-21). The body is bounded to a closed, content-free shape — class names,
 * a status, a code, a count — and a body carrying anything else is refused whole, so a subject or
 * an address can never ride a diagnostic into the log.
 */
import type { Diagnostic } from "./log.js";

export const WINDOW_SYNC_FAILED_ROUTE = "/local/window/sync-failed";

/** The widest body this door reads; a report is a few dozen bytes. */
const MAX_BODY_BYTES = 1024;
const NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const REASON = /^[a-z][a-z_]{0,31}$/;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const KNOWN_KEYS = new Set(["attempt", "reason", "errorClass", "status", "code"]);

interface WindowSyncFailureReport {
  attempt: number;
  reason: string;
  errorClass: string;
  status?: number;
  code?: string;
}

/** Parse a report or say why it is refused; the refusal names the shape, never the content. */
export function parseWindowSyncFailure(raw: unknown): WindowSyncFailureReport | { refused: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { refused: "not an object" };
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!KNOWN_KEYS.has(k)) return { refused: "a field this door does not take" };
  if (typeof r.attempt !== "number" || !Number.isInteger(r.attempt) || r.attempt < 1 || r.attempt > 1_000_000) {
    return { refused: "attempt is not a bounded count" };
  }
  if (typeof r.reason !== "string" || !REASON.test(r.reason)) return { refused: "reason is not a token" };
  if (typeof r.errorClass !== "string" || !NAME.test(r.errorClass)) return { refused: "errorClass is not a class name" };
  const out: WindowSyncFailureReport = { attempt: r.attempt, reason: r.reason, errorClass: r.errorClass };
  if (r.status !== undefined) {
    if (typeof r.status !== "number" || !Number.isInteger(r.status) || r.status < 100 || r.status > 599) {
      return { refused: "status is not an HTTP status" };
    }
    out.status = r.status;
  }
  if (r.code !== undefined) {
    if (typeof r.code !== "string" || !CODE.test(r.code)) return { refused: "code is not a token" };
    out.code = r.code;
  }
  return out;
}

interface WindowReportDeps {
  /** Does this request carry the install's live launch bearer? The same answer every local door gives. */
  authorized: (req: Request) => Promise<boolean>;
  log: Diagnostic;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Answer the report: 204 and one `window_sync_failed` line, or a refusal that logs no content. */
export async function handleWindowSyncFailure(req: Request, deps: WindowReportDeps): Promise<Response> {
  if (!(await deps.authorized(req))) {
    return json(401, { error: { code: "unauthorized", message: "authentication required" } });
  }
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) {
    deps.log("window_sync_report_refused", { route: WINDOW_SYNC_FAILED_ROUTE, status: 400, reason: "body over the bound" });
    return json(400, { error: { code: "invalid_request", message: "the report is too large" } });
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch {
    deps.log("window_sync_report_refused", { route: WINDOW_SYNC_FAILED_ROUTE, status: 400, reason: "not JSON" });
    return json(400, { error: { code: "invalid_request", message: "the report is not JSON" } });
  }
  const parsed = parseWindowSyncFailure(raw);
  if ("refused" in parsed) {
    deps.log("window_sync_report_refused", { route: WINDOW_SYNC_FAILED_ROUTE, status: 400, reason: parsed.refused });
    return json(400, { error: { code: "invalid_request", message: `the report was refused: ${parsed.refused}` } });
  }
  // `count` for the attempt and `errorClass` as the class: both on the logger's census. The
  // level says what a reader should think: the window is retrying, so this is a warning.
  // A LITERAL field set, so the log census can read every key: an absent status or code is
  // `null` on the line (the logger writes an undefined value as null), never a spread.
  deps.log("window_sync_failed", {
    route: WINDOW_SYNC_FAILED_ROUTE,
    count: parsed.attempt,
    reason: parsed.reason,
    errorClass: parsed.errorClass,
    status: parsed.status ?? null,
    code: parsed.code ?? null,
  });
  return new Response(null, { status: 204 });
}
