/**
 * THE DEAD-MAN HEARTBEAT (`TF_ALERT_HEARTBEAT_URL`): after every alert pass that COMPLETED, one plain
 * GET to an outside check service, which alarms when the requests stop. It catches what no page from
 * inside can: a dead host, a dead database on a host whose pager cannot start, a pass that never ends.
 * Unset is off. The request carries nothing: no body, no added header, the answer discarded. The URL
 * is the operator's credential at the check service, so it is never logged, published or put in an
 * error string; hosts log only changes of state.
 */

export const ALERT_HEARTBEAT_TIMEOUT_MS = 5_000;
export const ALERT_HEARTBEAT_VAR = "TF_ALERT_HEARTBEAT_URL";

/** One GET; resolves with the status. The production one is {@link nodeHeartbeatGet}. */
export type HeartbeatGet = (url: string, signal: AbortSignal) => Promise<{ status: number }>;

export type HeartbeatOutcome =
  | { state: "ok" }
  | { state: "refused"; status: number }
  | { state: "timeout" }
  | { state: "unreachable" };

export type AlertHeartbeat =
  | { state: "off" }
  | { state: "unusable"; configVar: typeof ALERT_HEARTBEAT_VAR }
  | { state: "on"; ping(): Promise<HeartbeatOutcome> };

/** A GET with no body and no added header; the response body is cancelled unread. */
export const nodeHeartbeatGet: HeartbeatGet = async (url, signal) => {
  const res = await fetch(url, { method: "GET", signal });
  try { await res.body?.cancel(); } catch { /* the body is not the answer */ }
  return { status: res.status };
};

/**
 * Build the heartbeat from the raw variable. Unset or empty: off, never a request. Quotes,
 * whitespace, not a URL, or not http(s): unusable. Otherwise a `ping()` that never rejects, settles
 * within the timeout whatever the transport does, and runs one request at a time (a call while one
 * is in flight shares it).
 */
export function alertHeartbeatFor(
  raw: string | null | undefined,
  get: HeartbeatGet = nodeHeartbeatGet,
  timeoutMs: number = ALERT_HEARTBEAT_TIMEOUT_MS,
): AlertHeartbeat {
  const value = (raw ?? "").trim();
  if (value.length === 0) return { state: "off" };
  let url: URL | null = null;
  if (!/[\s"']/.test(value)) {
    try { url = new URL(value); } catch { url = null; /* not a URL: reported as unusable below */ }
  }
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
    return { state: "unusable", configVar: ALERT_HEARTBEAT_VAR };
  }
  let inFlight: Promise<HeartbeatOutcome> | null = null;
  const once = async (): Promise<HeartbeatOutcome> => {
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<HeartbeatOutcome>((resolve) => {
      timer = setTimeout(() => { ac.abort(); resolve({ state: "timeout" }); }, timeoutMs);
    });
    const call = (async (): Promise<HeartbeatOutcome> => {
      try {
        const res = await get(value, ac.signal);
        return res.status >= 200 && res.status < 300 ? { state: "ok" } : { state: "refused", status: res.status };
      } catch (err) {
        const name = (err as { name?: unknown } | null)?.name;
        return name === "AbortError" || name === "TimeoutError" ? { state: "timeout" } : { state: "unreachable" };
      }
    })();
    try {
      return await Promise.race([call, timedOut]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  return {
    state: "on",
    ping(): Promise<HeartbeatOutcome> {
      if (inFlight) return inFlight;
      const p = once().finally(() => { if (inFlight === p) inFlight = null; });
      inFlight = p;
      return p;
    },
  };
}

/** What a host last logged about its heartbeat; see {@link heartbeatLogLine}. */
export interface HeartbeatLogMemory { last: string | null }

/**
 * The line a host writes for one ping, or null: only changes of state are logged. A failure state
 * new since the last ping is `alert_heartbeat_failed`; the first ok after a failure is
 * `alert_heartbeat_restored`. Closed fields only, never the URL.
 */
export function heartbeatLogLine(
  memory: HeartbeatLogMemory, outcome: HeartbeatOutcome,
): { event: "alert_heartbeat_failed" | "alert_heartbeat_restored"; fields: { state: string; status?: number } } | null {
  const key = outcome.state === "refused" ? `refused:${outcome.status}` : outcome.state;
  const prev = memory.last;
  memory.last = key;
  if (prev === key) return null;
  if (outcome.state === "ok") return prev === null ? null : { event: "alert_heartbeat_restored", fields: { state: "ok" } };
  return {
    event: "alert_heartbeat_failed",
    fields: { state: outcome.state, ...(outcome.state === "refused" ? { status: outcome.status } : {}) },
  };
}
