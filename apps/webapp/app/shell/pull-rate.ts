/**
 * HOW FAST THE FIRST PULL IS GOING, AND HOW LONG IS LEFT — the two numbers the flow's pull
 * screen is allowed to say, and the rules that keep them from being invented.
 *
 * ── WHY THIS IS NOT `MirrorGrowth` ────────────────────────────────────────────────────────
 *
 * The ruling behind this screen says "rate from the client's rolling `MirrorGrowth`", and that
 * is where the search started. It cannot answer the question, for two structural reasons rather
 * than one missing field:
 *
 *  · `MirrorGrowth.added` is PER RUN, and a run ends after {@link GROWTH_WINDOW_MS} of quiet
 *    (`mail-state.ts`, `growthStep`: `continues` false ⇒ `added` restarts at the new rise). The
 *    worker's cycle is 60 s, so the middle of an ordinary import is a sequence of SHORT runs —
 *    the episode latch exists precisely because runs keep ending. A rate taken over `added`
 *    would therefore be a rate over the last burst, which is not the rate of the import.
 *  · It carries `lastRiseAt` and no run START instant, so even within one run there is nothing
 *    to divide by.
 *
 * Neither is a defect there: that struct answers "is an import happening", and it answers it
 * well. This one answers "how fast, and how much longer", which needs samples over time. It is
 * fed the SAME number — the mirror's row count — so the two can never disagree about what is
 * being measured.
 *
 * ── THE THREE RULES, WHICH ARE ALL THE SAME RULE ──────────────────────────────────────────
 *
 * Every claim this module makes has to survive being read by somebody watching a progress bar,
 * so each one refuses rather than guesses:
 *
 *  1. **No rate before {@link RATE_MIN_SPAN_MS} of samples.** Two observations a few seconds
 *     apart across a 60 s worker cycle measure the BURST, not the import. A drain lands in a
 *     fraction of the cycle and the rest of the cycle is idle, so a window that covers only the
 *     drain overstates the rate by the ratio of the cycle to the burst — and the ETA is wrong by
 *     that same ratio, in the direction that promises somebody their mail sooner than it can
 *     arrive. The screen says "working out how long this takes" until the window is real. The
 *     ruling names two minutes; that is {@link RATE_MIN_SPAN_MS}.
 *  2. **No ETA without a remaining count**, and no remaining count without the server's own
 *     total (`MailboxDTO.serverMessageCount`). An ETA over an invented denominator is the
 *     literal this whole surface exists to remove.
 *  3. **Nothing at all once the import is finished.** The stamp
 *     (`initialImportCompletedAt`) is the authority, checked by the caller; this module
 *     additionally refuses at a non-positive remainder, because the sum it divides is a floor
 *     that moves (see `MailboxDTO.serverMessageCount`) and can sit BELOW the mirror's count.
 *
 * Pure, no clock of its own, no React: every rule above is one test with a fabricated `now`.
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
 * Fold one observation in, dropping samples that have fallen out of the window.
 *
 * A COUNT THAT FELL is kept as an ordinary sample and never special-cased. `growthStep` treats a
 * fall as "not a rise" because it is answering a yes/no question about arrival; here a fall is a
 * real thing that happened to the mirror — a Screener backfill moving mail out of it — and
 * pretending otherwise would make the rate say the import is faster than the mirror is actually
 * filling. {@link pullRate} refuses a non-positive delta, which is the honest consequence.
 *
 * Samples at the SAME instant collapse to the latest: two reads in one millisecond are one
 * observation, and keeping both would put a zero-length span in the window.
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
