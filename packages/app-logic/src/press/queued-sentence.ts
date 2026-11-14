/**
 * WHAT A RULE PRESS THAT WAITS ON THIS BROWSER'S QUEUE MAY SAY — one decider for the Rules page, the
 * Screener and sender sheet, and the subject rule. "Queued until you're back online" only while the
 * browser IS offline (it was once said over a server's 500, online); a try the server answered with a
 * failure is said as one (`serverFailed`); an unanswered try while online has not arrived yet.
 */
export type QueuedWait = "failing" | "queued" | "unsent";

/** The browser's own answer; a host without `navigator` is never told it is offline. */
export const browserOffline = (): boolean => typeof navigator !== "undefined" && navigator.onLine === false;

/** One press's verdict: `organizer` is the server's record for another install, never this queue. */
export function queuedSentence(
  v: { wait: "retry" | "organizer"; failed?: true }, offline: boolean,
): QueuedWait | "organizer" {
  if (v.wait === "organizer") return "organizer";
  if (v.failed === true) return "failing";
  return offline ? "queued" : "unsent";
}

/** A set of results: one server failure among the queued makes the set's sentence a failure. */
export function queuedWaitOf(
  results: ReadonlyArray<{ status: string; serverFailed?: true }>, offline: boolean,
): QueuedWait {
  const failed = results.some((r) => r.status === "queued" && r.serverFailed === true);
  return queuedSentence(failed ? { wait: "retry", failed: true } : { wait: "retry" }, offline) as QueuedWait;
}
