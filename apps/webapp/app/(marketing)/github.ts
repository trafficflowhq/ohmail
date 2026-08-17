/**
 * The GitHub nav item's data.
 *
 * The star count is fetched ONCE, AT BUILD TIME, in `next.config.mjs` (`githubStars()` there)
 * and inlined as `NEXT_PUBLIC_GITHUB_STARS`. It cannot be fetched from the page: the landing
 * loads nothing off-origin — no badge script, no client fetch to api.github.com — and
 * a no-third-party guard enforces that. A build-time constant is the one shape that
 * renders natively under that policy, at the cost every badge has anyway: the number is as
 * fresh as the last deploy.
 */

/** The public repository. Allow-listed as an outbound LINK in the no-third-party guard. */
export const GITHUB_REPO_URL = "https://github.com/trafficflowhq/ohmail";

/**
 * The count as the nav shows it, or `null` for "no usable count".
 *
 * `null` makes the Nav render the mark and the name with no number — the honest fallback: a
 * hidden number, never an invented one. Exact below 1000 (a small true number beats a vague
 * one), one decimal of thousands to 10k, whole thousands beyond.
 */
export function starLabel(raw: string | undefined): string | null {
  const n = Number.parseInt((raw ?? "").trim(), 10);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n < 1000) return String(n);
  const thousands = n / 1000;
  const rounded = thousands >= 10 ? Math.round(thousands) : Math.round(thousands * 10) / 10;
  return `${rounded}k`;
}
