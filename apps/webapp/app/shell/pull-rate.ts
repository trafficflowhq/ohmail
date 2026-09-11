/**
 * How fast the first pull is going, and how long is left — the two numbers the flow's pull screen may say. Not
 * `MirrorGrowth`: that answers "is an import happening" — its `added` is per RUN (a run ends after {@link
 * GROWTH_WINDOW_MS} of quiet, and the worker's 60 s cycle makes an import a sequence of short runs) and it carries no
 * run start to divide by. This module needs samples over time and is fed the SAME number — the mirror's row count —
 * so the two cannot disagree.
 */

/**
 * Three rules, all one rule (refuse rather than guess): no rate before {@link RATE_MIN_SPAN_MS} of samples — a window
 * covering only the drain burst overstates the rate by cycle/burst, promising mail sooner than it can arrive; no ETA
 * without a remaining count, and none without the server's own total (`MailboxDTO.serverMessageCount`) — an invented
 * denominator is the literal this surface exists to remove; nothing at all once the import is finished (the stamp is
 * the authority, and a non-positive remainder refuses too). Pure — every rule is one test with a fabricated `now`.
 */

/**
 * How much wall time the samples must span before a rate may be claimed. Two minutes, from the
 * ruling — long enough to contain at least one whole worker cycle (60 s) plus its quiet half,
 * which is what makes the average an average of the import rather than of one burst.
 */
export const RATE_MIN_SPAN_MS = 120_000;

/**
 * How far back samples are kept. Longer than {@link RATE_MIN_SPAN_MS} so that the window is
 * genuinely rolling — at exactly the minimum span every new sample would evict the one it needs
 * to be measured against, and the rate would flicker in and out of existence at the boundary.
 */
export const RATE_WINDOW_MS = 300_000;

/** One observation of the mirror's size. */
export interface PullSample {
  at: number;
  count: number;
}

/**
 * Fold one observation in, dropping samples that fell out of the window. A count that FELL is kept
 * as an ordinary sample, never special-cased: `growthStep` treats a fall as "not a rise" because
 * it answers a yes/no question about arrival; here a fall is a real thing that happened to the
 * mirror (a Screener backfill moving mail out), and pretending otherwise would make the rate say
 * the import is faster than the mirror is filling — {@link pullRate} refuses a non-positive delta,
 * the honest consequence. Samples at the same instant collapse to the latest: two reads in one
 * millisecond are one observation, and keeping both puts a zero-length span in the window.
 */
export function pullSampleStep(prev: PullSample[], count: number, now: number): PullSample[] {
  const kept = prev.filter((s) => now - s.at <= RATE_WINDOW_MS && s.at !== now);
  kept.push({ at: now, count });
  return kept;
}

/**
 * Messages a minute, or `null` when nothing may be claimed.
 *
 * `null` for every one of: fewer than two samples; a span under {@link RATE_MIN_SPAN_MS}; a
 * delta that is zero or negative. The last is the case a caller is most likely to want papered
 * over — a mirror that has not grown in two minutes — and it is exactly the case where an ETA
 * would be infinite or negative, so it stays `null` and the screen keeps saying it is still
 * working out.
 */
export function pullRate(samples: PullSample[]): number | null {
  if (samples.length < 2) return null;
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const span = last.at - first.at;
  if (span < RATE_MIN_SPAN_MS) return null;
  const delta = last.count - first.count;
  if (delta <= 0) return null;
  return (delta / span) * 60_000;
}

/**
 * HOW MANY MESSAGES ARE STILL TO COME, or `null` when the server has not said.
 *
 * Clamped at zero and `null` AT zero, which are two different refusals wearing one guard:
 * `serverMessageCount` is a sum over the folders a cycle has opened, so it grows as the tree is
 * walked and may sit below the mirror's own count for a while. A negative "still to read" is
 * absurd; a "0 still to read" printed over a pull that is visibly still running is worse,
 * because it is a confident wrong answer rather than an obviously broken one.
 */
export function pullRemaining(
  serverMessageCount: number | undefined, mirrorCount: number,
): number | null {
  if (typeof serverMessageCount !== "number") return null;
  const remaining = serverMessageCount - mirrorCount;
  return remaining > 0 ? remaining : null;
}

/**
 * MILLISECONDS LEFT, or `null` — the two inputs above, and nothing else.
 *
 * Deliberately returns a duration rather than a formatted string: the copy says "about {eta}"
 * and the FORMATTER is the locale's (`next-intl`'s relative-time formatter), so this module
 * never decides what "4 minutes" is called in German.
 */
export function pullEtaMs(remaining: number | null, ratePerMinute: number | null): number | null {
  if (remaining === null || ratePerMinute === null || ratePerMinute <= 0) return null;
  return (remaining / ratePerMinute) * 60_000;
}
