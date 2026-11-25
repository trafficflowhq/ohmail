import { PROBE_DEADLINE_MS } from "./server-base";

/** Settle even if the transport never answers or doesn't support interrupting a read. */
export async function withinApprovalDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal,
): Promise<T> {
  const request = new AbortController();
  const abort = () => request.abort();
  const ended = new Promise<never>((_, reject) => {
    request.signal.addEventListener("abort", () => reject(new Error("Sign-in request ended")), { once: true });
  });
  const timer = setTimeout(abort, PROBE_DEADLINE_MS);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) {
      abort();
      return await ended;
    }
    return await Promise.race([ended, run(request.signal)]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
