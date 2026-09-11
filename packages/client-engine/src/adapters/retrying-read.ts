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
 * Wrap a read transport so a 503 naming a `Retry-After` is asked again. The
 * decision is status plus header — the API's `db_busy` shape
 * (`middleware.ts#dbBusyResponse`); a 503 naming no interval is handed back.
 * The body is never read — that would consume the stream of the response a
 * give-up must return intact. The wait is `min(header, cap)`. Only GET
 * passes: an automatic second attempt is safe only for reads, so anything
 * else throws before the transport (an absent method is a GET, fetch's own
 * default). Giving up returns the last answer — callers already read that 503.
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
