/**
 * The refusal classes a client renders a sentence for, on every surface (the web strip and
 * Settings block, the desktop, the phone).
 *
 * The SERVER owns the closed set (`FILING_REFUSAL_CLASSES` in `@trafficflow/db`) and the clients
 * re-declare it here once: a client may not import the server's packages, and a new member during
 * a rolling deploy is a real possibility. An unrecognised value therefore becomes `unknown`, which
 * HAS a sentence — silence there would restore the invisibility this arm exists to end.
 */
export const FILING_REFUSAL_REASONS = [
  "refused", "no_such_folder", "read_only", "over_quota", "stale_locator", "unconfirmed", "unknown",
] as const;

export type FilingRefusalReason = (typeof FILING_REFUSAL_REASONS)[number];

/** A wire class narrowed to the set: `null` stays `null` (nothing refused), anything unknown is `unknown`. */
export function filingRefusalReason(v: string | null): FilingRefusalReason | null {
  if (v === null) return null;
  return (FILING_REFUSAL_REASONS as readonly string[]).includes(v) ? (v as FilingRefusalReason) : "unknown";
}
