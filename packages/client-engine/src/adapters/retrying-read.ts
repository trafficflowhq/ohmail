import { OUTBOX_BACKOFF_CAP_MS } from "../engine.js";

/**
 * HOW MANY TIMES ONE READ IS ASKED BEFORE THE CALLER IS TOLD.
 *
 * An ATTEMPT bound, not a wait clamp — the clamp on a server-named wait is
 * {@link OUTBOX_BACKOFF_CAP_MS}, imported so there is exactly one of it in the client. Three
 * because the only answer this retries is a pool that declined work it knows it cannot do yet:
 * two waits of the interval the server named cover a starved pooler, and a third would be a
 * poller holding a promise longer than its own cadence for no better odds.
 */
export const RETRYING_READ_ATTEMPTS = 3;

/**
 * WHAT A `Retry-After` HEADER SAYS, IN MILLISECONDS — the one parse in the client.
 *
 * Both spellings RFC 9110 allows: delay-seconds (what the API sends on its `503 db_busy`) and an
 * HTTP-date. An unparseable value is `null`, which every caller reads as "the server named no
 * interval" rather than as zero.
 */
export function retryAfterMsOf(res: Response): number | null {
  const raw = res.headers.get("retry-after");
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return null;
  return Math.max(0, when - Date.now());
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * WRAP A READ TRANSPORT SO A `503` THAT NAMES A `Retry-After` IS ASKED AGAIN.
 *
 * ── WHAT IT RETRIES, AND WHY THE BODY IS NEVER READ ─────────────────────────────────────────
 *
 * The decision is STATUS plus HEADER: a 503 carrying a parseable `Retry-After`, which is the API's
 * `db_busy` shape (`middleware.ts#dbBusyResponse`) and nothing else — a 503 from a misconfigured
 * host names no interval and is handed straight back. Reading `code: "db_busy"` out of the body
 * would consume the stream of the very response a give-up has to return intact.
 *
 * The wait is `min(header, cap)` on the mutation queue's own clamp, because a proxy is free to
 * name a week and a client that honours it has stopped asking.
 *
 * ── A WRITE IS REFUSED, NOT PASSED THROUGH ──────────────────────────────────────────────────
 *
 * An automatic second attempt is safe here only because the request is a GET. A wrapper that
 * quietly forwarded a POST would be an invisible duplicate-delivery machine the day somebody
 * routed a mutation through it, so anything but GET throws before it reaches the transport. An
 * ABSENT method is a GET — that is `fetch`'s own default and the shape the roster polls use.
 *
 * ── GIVING UP RETURNS THE LAST ANSWER ───────────────────────────────────────────────────────
 *
 * Not a throw and not a synthetic status: the caller's existing derivation of "the server is not
 * answering" already reads that 503, so the give-up arm needs no new state anywhere.
 */
export function retryingRead<I>(
  inner: (url: string, init?: I) => Promise<Response>,
  opts: { waitFor?: (ms: number) => Promise<void>; attempts?: number } = {},
): (url: string, init?: I) => Promise<Response> {
  const waitFor = opts.waitFor ?? sleep;
  const attempts = opts.attempts ?? RETRYING_READ_ATTEMPTS;
  return async (url, init) => {
    const method = (init as { method?: unknown } | undefined)?.method;
    if (method !== undefined && String(method).toUpperCase() !== "GET") {
      throw new Error(
        `the retrying read transport takes GET only, and was handed ${String(method).toUpperCase()}`,
      );
    }
    let res = await inner(url, init);
    for (let attempt = 1; attempt < attempts; attempt++) {
      if (res.status !== 503) return res;
      const named = retryAfterMsOf(res);
      if (named === null) return res;
      await waitFor(Math.min(named, OUTBOX_BACKOFF_CAP_MS));
      res = await inner(url, init);
    }
    return res;
  };
}
