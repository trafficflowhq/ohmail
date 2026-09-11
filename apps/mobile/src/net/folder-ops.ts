import type { ConnectedSession } from "./pairing.js";

/**
 * The delete confirm's server-truth counts — `GET /folders/:id/summary`. The folder-delete ceremony asks before the
 * act, stating what moves (FOLDERS-SPEC.md §18): only the server can count honestly, since the phone's mirror is a
 * window and a local count would understate. Transport: `session.fetch` only, bound to one origin — structural, in
 * the privacy census' seam. `null` means "could not count", and the confirm still asks: the caller renders the
 * uncounted sentence rather than blocking or inventing a number. The read runs under {@link SUMMARY_TIMEOUT_MS}, and
 * a timeout IS the uncounted answer; the deadline races the whole bearer promise, not merely the request's abort
 * signal — a 401's token rotation does not carry this signal, and a stalled `/auth/refresh` would otherwise hold the
 * confirm open. The abort still fires, so paths that honor the signal release their sockets.
 */

/** How long the count may take before the uncounted sentence stands in for it. */
export const SUMMARY_TIMEOUT_MS = 10_000;

export async function readFolderSummary(
  session: ConnectedSession,
  folderId: string,
  /** Test seam only — the shipped callers never pass it, so the one number above is the number. */
  timeoutMs: number = SUMMARY_TIMEOUT_MS,
): Promise<{ folders: number; messages: number } | null> {
  const abort = new AbortController();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<null>((resolve) => {
    deadline = setTimeout(() => {
      abort.abort();
      resolve(null);
    }, timeoutMs);
  });
  // `catch` INSIDE the racer: when the deadline wins, this promise is still in flight, and
  // its eventual rejection (the abort, a torn socket) must be an answered `null`, never an
  // unhandled rejection after the caller has moved on.
  const answered = (async (): Promise<{ folders: number; messages: number } | null> => {
    const res = await session.fetch(
      `${session.profile.origin}/folders/${encodeURIComponent(folderId)}/summary`,
      { method: "GET", signal: abort.signal },
    );
    if (res.status !== 200) return null;
    const body = (await res.json()) as { folders?: unknown; messages?: unknown };
    if (typeof body.folders !== "number" || typeof body.messages !== "number") return null;
    return { folders: body.folders, messages: body.messages };
  })().catch(() => null);
  try {
    return await Promise.race([answered, expired]);
  } finally {
    clearTimeout(deadline);
  }
}
