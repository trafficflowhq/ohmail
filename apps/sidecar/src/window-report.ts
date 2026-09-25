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

/** The bearer, the bound and the JSON every window report passes; the refusal names the shape only. */
async function readReport<T>(
  req: Request, deps: WindowReportDeps, refusal: (reason: string) => void, parse: (raw: unknown) => T | { refused: string },
): Promise<T | Response> {
  if (!(await deps.authorized(req))) {
    return json(401, { error: { code: "unauthorized", message: "authentication required" } });
  }
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) {
    refusal("body over the bound");
    return json(400, { error: { code: "invalid_request", message: "the report is too large" } });
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch {
    refusal("not JSON");
    return json(400, { error: { code: "invalid_request", message: "the report is not JSON" } });
  }
  const parsed = parse(raw);
  if (typeof parsed === "object" && parsed !== null && "refused" in parsed) {
    refusal(parsed.refused);
    return json(400, { error: { code: "invalid_request", message: `the report was refused: ${parsed.refused}` } });
  }
  return parsed as T;
}

/** Answer the report: 204 and one `window_sync_failed` line, or a refusal that logs no content. */
export async function handleWindowSyncFailure(req: Request, deps: WindowReportDeps): Promise<Response> {
  const parsed = await readReport(req, deps, (reason) => {
    deps.log("window_sync_report_refused", { route: WINDOW_SYNC_FAILED_ROUTE, status: 400, reason });
  }, parseWindowSyncFailure);
  if (parsed instanceof Response) return parsed;
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

/**
 * `POST /local/window/search-phases` — one Search's timings as the window measured them, so the
 * split sits in THIS log beside the relay's own line (`search_relayed`): the debounce, the send,
 * the round trip, the paint, the account's `ms`, and the two instants that join the lines across
 * the bridge. Numbers and one verdict word; any other field refuses the whole body.
 */
export const WINDOW_SEARCH_PHASES_ROUTE = "/local/window/search-phases";

const SEARCH_VERDICTS = new Set(["matched", "nothing", "mirror", "failed"]);
const SPAN_KEYS = ["debounceMs", "sendMs", "roundTripMs", "paintMs", "totalMs"] as const;
const INSTANT_KEYS = ["sentAtMs", "answeredAtMs"] as const;
const SEARCH_KEYS = new Set<string>([...SPAN_KEYS, ...INSTANT_KEYS, "verdict", "serverMs"]);
/** The longest span a report may state; the window's own ceiling on a search is far below it. */
const SPAN_MAX_MS = 600_000;

interface WindowSearchPhasesReport {
  verdict: string;
  debounceMs: number; sendMs: number; roundTripMs: number; paintMs: number; totalMs: number;
  serverMs: number | null;
  sentAtMs: number; answeredAtMs: number;
}

const span = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= SPAN_MAX_MS;
const instant = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 1e12 && v < 1e14;

/** Parse a report or say why it is refused; the refusal names the shape, never the content. */
export function parseWindowSearchPhases(raw: unknown): WindowSearchPhasesReport | { refused: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { refused: "not an object" };
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!SEARCH_KEYS.has(k)) return { refused: "a field this door does not take" };
  if (typeof r.verdict !== "string" || !SEARCH_VERDICTS.has(r.verdict)) return { refused: "verdict is not a search verdict" };
  for (const k of SPAN_KEYS) if (!span(r[k])) return { refused: `${k} is not a bounded span` };
  for (const k of INSTANT_KEYS) if (!instant(r[k])) return { refused: `${k} is not a clock reading` };
  if (r.serverMs !== null && !span(r.serverMs)) return { refused: "serverMs is not a bounded span" };
  return r as unknown as WindowSearchPhasesReport;
}

/** Answer the report: 204 and one `window_search_phases` line, or a refusal that logs no content. */
export async function handleWindowSearchPhases(req: Request, deps: WindowReportDeps): Promise<Response> {
  const p = await readReport(req, deps, (reason) => {
    deps.log("window_search_report_refused", { route: WINDOW_SEARCH_PHASES_ROUTE, status: 400, reason });
  }, parseWindowSearchPhases);
  if (p instanceof Response) return p;
  deps.log("window_search_phases", {
    verdict: p.verdict, debounceMs: p.debounceMs, sendMs: p.sendMs, roundTripMs: p.roundTripMs, paintMs: p.paintMs,
    totalMs: p.totalMs, serverMs: p.serverMs, sentAtMs: p.sentAtMs, answeredAtMs: p.answeredAtMs,
  });
  return new Response(null, { status: 204 });
}
