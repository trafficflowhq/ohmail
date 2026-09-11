/**
 * The drain policy — the decisions a resuming mirror makes about its own staleness, in one module
 * for every surface with a mirror. Two drain implementations exist: `packages/client-engine` and
 * the sidecar's `cloud-mirror.ts`, and the policy forked twice in one week — a stale-resume
 * threshold and a page limit, each written out in both; a disagreeing threshold means one device
 * calls current what another labels catching-up. Everything here is pure — no store, no clock, no
 * network. In core because the sidecar must not link the engine's barrel. Deliberately not here:
 * the APPLY (two sound implementations over two substrates) and the cold-mirror gate ({@link
 * mirrorStale} is the stamp comparison alone).
 */

/**
 * The freshness contract's three states — what a surface may say about the age of the mirror it
 * renders. Exactly three, never conflated: `unknown` — no drain has EVER completed; a zero-row
 * list is not "empty", it is unanswered, and the surface owes a skeleton, never content and never
 * an empty state. `stale` — a drain has completed, longer ago than {@link STALE_RESUME_MS}; the
 * mirror is renderable truth and MUST be rendered (frame one is local, always), labeled quietly
 * ("as of 14:32 · catching up") until a drain settles — staleness labeled is honest, staleness
 * silent is the bug this type makes unrepresentable. `current` — the last completed drain is
 * recent; plain content, no label.
 */
export type FreshnessState = "unknown" | "stale" | "current";

/** What a surface renders about its mirror's age — see {@link mirrorFreshness}. */
export interface MirrorFreshness {
  state: FreshnessState;
  /** The ISO stamp the state was derived from; `null` whenever the state is `unknown`. */
  asOf: string | null;
}

/**
 * When a resuming mirror stops being "current" and starts being "stale" — the age beyond which
 * the next drain fetches the newest page before replaying its backlog, and a surface labels what
 * it shows. Five minutes, sized from both directions: below it, a visible tab settles a drain
 * every eight seconds, so a healthy surface never pays the freshness path (pinned by
 * `stale-resume-freshness.test.ts`); above it, the surface was not draining at all and the price
 * of guessing wrong is asymmetric — a false positive is one extra snapshot page (~0.5 s), a false
 * negative is the newest mail arriving at the END of an oldest-first replay measured in minutes.
 * One number for every surface: two copies of a threshold is two opinions waiting to diverge.
 */
export const STALE_RESUME_MS = 5 * 60_000;

/**
 * The stale drain asks for dense pages — the backlog diet's client half. A backlog's dominant
 * cost is PAGE COUNT, not page size: each `/sync` page is a serverless invocation with ~10 fixed
 * sequential round trips — measured p50 1,084 ms per 500-row page, of which ~0.4 s no row could
 * ever pay for — so a 1,500-row backlog was four invocations (~5.1 s) where one dense page
 * carries it whole. 2,000 is the server's own MAX_LIMIT; asking more would be clamped anyway.
 * Used ONLY on a backlog catch-up — the same condition that fires the freshen, so the ask and the
 * label are one verdict observed twice. Payload stays modest: a stale span is served coalesced,
 * so the dense page is ~1–2 MB against the platform's 4.5 MB cap.
 */
export const BACKLOG_PAGE_LIMIT = 2000;

/**
 * Is the mirror behind its own threshold — the stamp comparison, alone. `lastDrainAt` is the last
 * COMPLETED drain's instant, written on the driver's OWN clock (never `serverTime`); the engine
 * keeps it in mirror meta, the sidecar in its cursor file, and both spellings of absent are
 * accepted. Absent is STALE here and `unknown` in {@link mirrorFreshness}, and that is why both
 * functions exist: for the RESUME a stampless mirror must read stale — the cost of wrong is one
 * snapshot page versus a whole oldest-first replay; for the LABEL it must read unknown — there is
 * no time to put in "as of …". An unparseable stamp reads stale: it is the driver's own write,
 * answered by freshening and re-stamping. The caller supplies the cold/bootstrap gate.
 */
export function mirrorStale(
  lastDrainAt: string | null | undefined,
  now: Date,
  staleMs: number = STALE_RESUME_MS,
): boolean {
  if (lastDrainAt === undefined || lastDrainAt === null) return true;
  const t = Date.parse(lastDrainAt);
  return Number.isNaN(t) || now.getTime() - t > staleMs;
}

/**
 * What a surface may say about this mirror's age — the one derivation of the freshness contract's
 * three states from the drain's own completion stamp on the driver's own clock. Every surface
 * reads THIS: the webapp and phone through `OhmailEngine.freshness()`, the desktop window through
 * the sidecar's `GET /mirror/freshness`. Three renderers, one derivation, so "the label is
 * showing" and "the resume freshens newest-first" are a single fact observed twice rather than
 * two opinions that can drift. The threshold comparison is {@link mirrorStale}'s, minus its
 * absent-is-stale arm — see that function for why the two answers about a missing stamp
 * deliberately differ.
 */
export function mirrorFreshness(
  lastDrainAt: string | null | undefined,
  now: Date,
  staleMs: number = STALE_RESUME_MS,
): MirrorFreshness {
  if (lastDrainAt === undefined || lastDrainAt === null) return { state: "unknown", asOf: null };
  const t = Date.parse(lastDrainAt);
  // An unparseable stamp is the driver's own corrupted write: report unknown rather than a label
  // with no time in it. The next completed drain re-stamps it, and {@link mirrorStale} has
  // already made sure that drain freshens first.
  if (Number.isNaN(t)) return { state: "unknown", asOf: null };
  return { state: now.getTime() - t > staleMs ? "stale" : "current", asOf: lastDrainAt };
}

/**
 * How many rows the next `/sync` page may carry — {@link BACKLOG_PAGE_LIMIT} on a backlog
 * catch-up, the driver's own default otherwise. One line, here rather than inline at two call
 * sites, because the ask and the freshen must fire on ONE verdict: a freshen without the dense
 * drain leaves the convergence tail, a dense drain without the freshen labels nothing.
 * `defaultLimit` may be `undefined` — the engine's steady-state ask sends no `limit=` at all; the
 * sidecar passes its configured page size, and neither shape is normalised into the other.
 * Generic in the fallback rather than `number | undefined` so a caller passing a number gets a
 * `number` back: the sidecar stringifies this straight into a query parameter.
 */
export function drainPageLimit<T extends number | undefined>(
  staleResume: boolean,
  defaultLimit: T,
): number | T {
  return staleResume ? BACKLOG_PAGE_LIMIT : defaultLimit;
}
